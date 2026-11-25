import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { basename, extname, join } from "node:path";
import {
  applyStorageStateToProfile,
  isProfileInUseByEdge,
  type EdgeStudioAdapter,
} from "./adapters/edge-studio.js";
import { collectChannelAnalytics } from "./analytics/collector.js";
import { buildVideoIntelligence } from "./analytics/intelligence.js";
import { dispatchWebhookEvent, syncRssFeed } from "./automations/engine.js";
import type { RuntimeConfig } from "./config.js";
import type { VesperaStore } from "./db.js";
import {
  buildOAuthStartUrl,
  getOAuthProviderStatus,
  handleOAuthCallback,
  isSupportedOAuthPlatform,
  verifyOAuthSession,
} from "./oauth.js";
import { LiveBrowserManager } from "./live-browser.js";
import type { AdapterKind, ExistingReceipt, JobStatus, PublishingManifest, SessionCheckResult } from "./types.js";
import type { PublishWorker } from "./worker.js";

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBodyJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function streamVideoFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  if (!filePath || !existsSync(filePath)) {
    res.writeHead(404).end("Video file not found");
    return;
  }
  const stat = statSync(filePath);
  const total = stat.size;
  const contentType = MIME_MAP[extname(filePath).toLowerCase()] ?? "video/mp4";
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Accept-Ranges": "bytes",
    "Content-Length": String(total),
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=3600",
  });
  createReadStream(filePath).pipe(res);
}

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  lastTickAt?: string;
  lastRunCount: number;
  lastError?: string;
}

export interface SchedulerManager {
  status: () => SchedulerStatus;
  setEnabled: (enabled: boolean) => SchedulerStatus;
  tick: (opts?: { forceRun?: boolean; dryRun?: boolean }) => Promise<{ ran: number; results: unknown[] }>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

export function createSchedulerManager(store: VesperaStore, worker: PublishWorker): SchedulerManager {
  let running = false;
  let lastTickAt: string | undefined;
  let lastRunCount = 0;
  let lastError: string | undefined;
  let intervalSeconds = 60;
  let timer: NodeJS.Timeout | undefined;

  const isEnabled = () => store.getSetting("auto_scheduler_enabled") === "true";

  async function tick(opts: { forceRun?: boolean; dryRun?: boolean } = {}): Promise<{ ran: number; results: unknown[] }> {
    if (running) return { ran: 0, results: [] };
    if (!opts.forceRun && !isEnabled()) return { ran: 0, results: [] };

    running = true;
    lastTickAt = new Date().toISOString();
    try {
      const results = await worker.runDueJobs({
        limit: 2,
        dryRun: Boolean(opts.dryRun),
      });
      lastRunCount = results.length;
      lastError = undefined;
      return { ran: results.length, results };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return { ran: 0, results: [] };
    } finally {
      running = false;
    }
  }

  return {
    status: () => ({
      enabled: isEnabled(),
      running,
      intervalSeconds,
      lastTickAt,
      lastRunCount,
      lastError,
    }),
    setEnabled: (enabled: boolean) => {
      store.setSetting("auto_scheduler_enabled", enabled ? "true" : "false");
      return {
        enabled: isEnabled(),
        running,
        intervalSeconds,
        lastTickAt,
        lastRunCount,
        lastError,
      };
    },
    tick,
    start: (intervalMs = 60_000) => {
      intervalSeconds = Math.max(10, Math.round(intervalMs / 1000));
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export interface ServerDependencies {
  config: RuntimeConfig;
  store: VesperaStore;
  edgeAdapter: EdgeStudioAdapter;
  worker: PublishWorker;
  scheduler?: SchedulerManager;
}

export function createVesperaServer(deps: ServerDependencies): Server {
  const { config, store, edgeAdapter, worker } = deps;
  const scheduler = deps.scheduler ?? createSchedulerManager(store, worker);
  const liveBrowser = new LiveBrowserManager();
  const webDistDir = join(config.rootDir, "dist", "web");
  const activeConnectWatchers = new Map<string, NodeJS.Timeout>();
  const runtimeMode = process.env.VESPERA_DOCKER ? "docker" : "local";

  function resolveCallbackBaseUrl(req: IncomingMessage): string {
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
    const xfProto = req.headers["x-forwarded-proto"];
    const xfHost = req.headers["x-forwarded-host"];
    const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto)?.split(",")[0]?.trim() || "http";
    const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost)?.split(",")[0]?.trim() || req.headers.host || `127.0.0.1:${config.port}`;
    return `${proto}://${host}`;
  }

  function scheduleAutoVerifyAfterClose(channelId: string, platformId?: string): void {
    const prev = activeConnectWatchers.get(channelId);
    if (prev) clearInterval(prev);

    let sawRunning = false;
    let ticks = 0;
    let runningCheck = false;

    const timer = setInterval(() => {
      if (runningCheck) return;
      ticks += 1;
      if (ticks > 240) {
        clearInterval(timer);
        if (activeConnectWatchers.get(channelId) === timer) activeConnectWatchers.delete(channelId);
        return;
      }

      const freshChannel = store.getChannel(channelId);
      if (!freshChannel) {
        clearInterval(timer);
        activeConnectWatchers.delete(channelId);
        return;
      }

      void (async () => {
        const locked = await isProfileInUseByEdge(freshChannel.profileDir);
        if (locked) {
          sawRunning = true;
          return;
        }
        if (!sawRunning && ticks < 4) {
          return;
        }
        runningCheck = true;
        clearInterval(timer);
        if (activeConnectWatchers.get(channelId) === timer) activeConnectWatchers.delete(channelId);
        try {
          const results = await edgeAdapter.checkSessions(freshChannel, {
            platform: platformId,
            headless: true,
          });
          for (const r of results) {
            store.saveSessionCheck(r);
            if (r.status === "signed_in") {
              const conn = freshChannel.connections.find(c => c.platform === r.platform);
              if (conn && !conn.enabled) {
                store.updateConnectionFields(freshChannel.id, conn.id, { enabled: true });
              }
            }
          }
        } catch {
          // Non-fatal: user can re-verify explicitly from the dashboard.
        }
      })();
    }, 2500);
    timer.unref?.();
    activeConnectWatchers.set(channelId, timer);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = (req.method ?? "GET").toUpperCase();

      // If an explicit Authorization: Bearer token is provided by an API client, verify it cleanly.
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
        const valid = bearer && (bearer === config.apiToken || store.verifyApiKey(bearer));
        if (!valid) {
          sendJson(res, 401, { ok: false, error: "Invalid Bearer API key." });
          return;
        }
      }

      // ---------------- Health & Bootstrap ----------------

      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          name: "Vespera",
          version: "1.0.0",
          mode: runtimeMode,
          oauth: getOAuthProviderStatus(),
          liveBrowser: {
            available: liveBrowser.isAvailable(),
            session: liveBrowser.getSession(),
          },
          scheduler: scheduler.status(),
          summary: store.statusSummary(),
        });
        return;
      }

      if (pathname === "/api/bootstrap" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          name: "Vespera",
          version: "1.0.0",
          mode: runtimeMode,
          oauth: getOAuthProviderStatus(),
          liveBrowser: {
            available: liveBrowser.isAvailable(),
            session: liveBrowser.getSession(),
          },
          oauthConnections: store.listOAuthConnections(),
          scheduler: scheduler.status(),
          summary: store.statusSummary(),
          platforms: store.listAllPlatforms(),
          groups: store.listGroups(),
          channels: store.listChannels(),
          jobs: store.listJobs(),
          postingSets: store.listPostingSets(),
          signatures: store.listSignatures(),
          plugs: store.listPlugs(),
          rssFeeds: store.listRssFeeds(),
          webhooks: store.listWebhooks().map(w => ({ ...w, secret: `${w.secret.slice(0, 10)}...` })),
          apiKeys: store.listApiKeys().map(({ keyHash: _ignored, ...rest }) => rest),
          analytics: {
            snapshots: store.listLatestChannelSnapshots(),
            intelligence: buildVideoIntelligence(store),
          },
        });
        return;
      }

      // ---------------- Platforms ----------------

      if (pathname === "/api/platforms" && method === "GET") {
        sendJson(res, 200, { ok: true, platforms: store.listAllPlatforms() });
        return;
      }

      if (pathname === "/api/platforms" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const created = store.upsertCustomPlatform({
          id: String(body.id ?? body.name ?? ""),
          name: String(body.name ?? ""),
          shortCode: body.shortCode ? String(body.shortCode) : undefined,
          accentHex: body.accentHex ? String(body.accentHex) : undefined,
          loginUrl: String(body.loginUrl ?? ""),
          composeUrl: body.composeUrl ? String(body.composeUrl) : undefined,
          analyticsUrl: body.analyticsUrl ? String(body.analyticsUrl) : undefined,
          supportsVideo: body.supportsVideo !== false,
          supportsScheduling: Boolean(body.supportsScheduling),
          supportsSubreddit: Boolean(body.supportsSubreddit),
          supportsCustomThumbnail: Boolean(body.supportsCustomThumbnail),
          supportsFirstComment: Boolean(body.supportsFirstComment),
          authModes: Array.isArray(body.authModes) ? (body.authModes as AdapterKind[]) : undefined,
          notes: body.notes ? String(body.notes) : undefined,
        });
        sendJson(res, 201, { ok: true, platform: created });
        return;
      }

      const platformMatch = /^\/api\/platforms\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (platformMatch && method === "DELETE") {
        const deleted = store.deleteCustomPlatform(platformMatch[1]);
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return;
      }

      // ---------------- Groups ----------------

      if (pathname === "/api/groups" && method === "POST") {
        const body = await readBodyJson<{ id?: string; name: string; color?: string }>(req);
        const group = store.upsertGroup({
          id: body.id || body.name,
          name: body.name,
          color: body.color,
        });
        sendJson(res, 201, { ok: true, group });
        return;
      }

      const groupMatch = /^\/api\/groups\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (groupMatch && method === "DELETE") {
        const deleted = store.deleteGroup(groupMatch[1]);
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return;
      }

      // ---------------- Channels & Connections ----------------

      if (pathname === "/api/channels" && method === "GET") {
        sendJson(res, 200, { ok: true, channels: store.listChannels() });
        return;
      }

      if (pathname === "/api/channels" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const ch = store.upsertChannel({
          id: String(body.id ?? body.name ?? ""),
          name: String(body.name ?? ""),
          groupId: body.groupId ? String(body.groupId) : undefined,
          timezone: body.timezone ? String(body.timezone) : undefined,
          defaultPostTime: body.defaultPostTime ? String(body.defaultPostTime) : undefined,
        });
        sendJson(res, 201, { ok: true, channel: ch });
        return;
      }

      const channelItemMatch = /^\/api\/channels\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (channelItemMatch && method === "DELETE") {
        const deleted = store.deleteChannel(channelItemMatch[1]);
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return;
      }

      const channelConnMatch = /^\/api\/channels\/([a-zA-Z0-9_-]+)\/connections$/.exec(pathname);
      if (channelConnMatch && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const conn = store.upsertConnection({
          channelId: channelConnMatch[1],
          platform: String(body.platform ?? ""),
          handle: String(body.handle ?? "@account"),
          enabled: body.enabled !== false,
          adapter: body.adapter ? (String(body.adapter) as AdapterKind) : undefined,
          customLoginUrl: body.customLoginUrl ? String(body.customLoginUrl) : undefined,
          customComposeUrl: body.customComposeUrl ? String(body.customComposeUrl) : undefined,
          customAnalyticsUrl: body.customAnalyticsUrl ? String(body.customAnalyticsUrl) : undefined,
          webhookUrl: body.webhookUrl ? String(body.webhookUrl) : undefined,
        });
        sendJson(res, 201, { ok: true, connection: conn });
        return;
      }

      const connItemMatch = /^\/api\/channels\/([a-zA-Z0-9_-]+)\/connections\/([^/]+)$/.exec(pathname);
      if (connItemMatch && method === "PATCH") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const updated = store.updateConnectionFields(connItemMatch[1], decodeURIComponent(connItemMatch[2]), {
          handle: body.handle !== undefined ? String(body.handle) : undefined,
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
          adapter: body.adapter !== undefined ? (String(body.adapter) as AdapterKind) : undefined,
          customLoginUrl: body.customLoginUrl === null ? null : body.customLoginUrl ? String(body.customLoginUrl) : undefined,
          customComposeUrl: body.customComposeUrl === null ? null : body.customComposeUrl ? String(body.customComposeUrl) : undefined,
          customAnalyticsUrl: body.customAnalyticsUrl === null ? null : body.customAnalyticsUrl ? String(body.customAnalyticsUrl) : undefined,
          webhookUrl: body.webhookUrl === null ? null : body.webhookUrl ? String(body.webhookUrl) : undefined,
        });
        sendJson(res, updated ? 200 : 404, { ok: Boolean(updated), connection: updated });
        return;
      }

      if (connItemMatch && method === "DELETE") {
        const deleted = store.deleteConnection(connItemMatch[1], decodeURIComponent(connItemMatch[2]));
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return;
      }

      // ---------------- OAuth2 & Portable Session Sync ----------------

      if (pathname === "/api/oauth/config" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          ...getOAuthProviderStatus(),
          connections: store.listOAuthConnections(),
        });
        return;
      }

      const oauthStartMatch = /^\/api\/oauth\/([a-zA-Z0-9_-]+)\/start$/.exec(pathname);
      if (oauthStartMatch && method === "GET") {
        const plat = oauthStartMatch[1].toLowerCase();
        const channelId = url.searchParams.get("channelId")?.trim() ?? "";
        if (!isSupportedOAuthPlatform(plat)) {
          sendJson(res, 400, { ok: false, error: `Unsupported OAuth platform '${plat}'.` });
          return;
        }
        if (!channelId || !store.getChannel(channelId)) {
          sendJson(res, 404, { ok: false, error: `Unknown channel '${channelId}'.` });
          return;
        }
        const built = buildOAuthStartUrl(plat, channelId, resolveCallbackBaseUrl(req));
        if (!built.ok) {
          sendJson(res, 400, { ok: false, error: built.error });
          return;
        }
        res.writeHead(302, { Location: built.authUrl });
        res.end();
        return;
      }

      const oauthCbMatch = /^\/api\/oauth\/([a-zA-Z0-9_-]+)\/callback$/.exec(pathname);
      if (oauthCbMatch && method === "GET") {
        const plat = oauthCbMatch[1].toLowerCase();
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const oauthErr = url.searchParams.get("error");
        if (!isSupportedOAuthPlatform(plat)) {
          sendJson(res, 400, { ok: false, error: `Unsupported OAuth platform '${plat}'.` });
          return;
        }
        if (oauthErr || !code || !state) {
          res.writeHead(302, { Location: `/channels?oauth=error&reason=${encodeURIComponent(oauthErr ?? "missing_code")}` });
          res.end();
          return;
        }
        const result = await handleOAuthCallback(store, plat, code, state);
        res.writeHead(302, { Location: `/channels?workspace=${encodeURIComponent(result.channelId)}&oauth=ok` });
        res.end();
        return;
      }

      // Single-platform Connect (OAuth redirect / local native Edge sync in Docker, or desktop launcher locally)
      const connectMatch = /^\/api\/channels\/([a-zA-Z0-9_-]+)\/connect$/.exec(pathname);
      if (connectMatch && method === "POST") {
        const channel = store.getChannel(connectMatch[1]);
        if (!channel) {
          sendJson(res, 404, { ok: false, error: `Unknown channel '${connectMatch[1]}'` });
          return;
        }
        const body = await readBodyJson<{ platform?: string; customUrl?: string }>(req);
        const platformId = body.platform?.trim().toLowerCase();
        let targetUrl = body.customUrl?.trim();

        if (platformId) {
          let conn = channel.connections.find(c => c.platform === platformId);
          if (!conn) {
            conn = store.upsertConnection({
              channelId: channel.id,
              platform: platformId,
              handle: platformId === "reddit" ? `u/${channel.id}` : `@${channel.id}`,
              adapter: "edge_studio",
              enabled: true,
            });
          } else if (!conn.enabled) {
            store.updateConnectionFields(channel.id, conn.id, { enabled: true });
          }
          if (!targetUrl) {
            targetUrl = edgeAdapter.resolveConnectionUrls(conn).loginUrl;
          }
        }
        if (!targetUrl) {
          sendJson(res, 400, { ok: false, error: "Provide 'platform' or 'customUrl' to launch single-platform Connect." });
          return;
        }

        if (runtimeMode === "docker" && !body.customUrl) {
          if (platformId && isSupportedOAuthPlatform(platformId)) {
            const oauthStatus = getOAuthProviderStatus();
            const isReady = platformId === "youtube" ? oauthStatus.youtubeConfigured : oauthStatus.redditConfigured;
            if (isReady) {
              sendJson(res, 200, {
                ok: true,
                mode: "oauth",
                channelId: channel.id,
                platform: platformId,
                oauthUrl: `/api/oauth/${platformId}/start?channelId=${encodeURIComponent(channel.id)}`,
                url: targetUrl,
              });
              return;
            }
          }
          if (liveBrowser.isAvailable()) {
            const session = await liveBrowser.start({ channel, platform: platformId, url: targetUrl });
            sendJson(res, 200, {
              ok: true,
              mode: "live_browser",
              channelId: channel.id,
              platform: platformId,
              url: targetUrl,
              session,
            });
            return;
          }
          const cmd = platformId
            ? `npm run sync-sessions -- ${channel.id} ${platformId}`
            : `npm run sync-sessions -- --export-only ${channel.id}`;
          sendJson(res, 200, {
            ok: true,
            mode: "local_sync",
            channelId: channel.id,
            platform: platformId,
            command: cmd,
            url: targetUrl,
          });
          return;
        }

        if (runtimeMode === "docker" && liveBrowser.isAvailable()) {
          const session = await liveBrowser.start({ channel, platform: platformId, url: targetUrl });
          sendJson(res, 200, {
            ok: true,
            mode: "live_browser",
            channelId: channel.id,
            platform: platformId,
            url: targetUrl,
            session,
          });
          return;
        }

        const launched = await edgeAdapter.openPlatformConnect(channel, targetUrl, { waitForClose: false });
        scheduleAutoVerifyAfterClose(channel.id, platformId);
        sendJson(res, 200, { ok: true, mode: "local_browser", channelId: channel.id, platform: platformId, autoVerifyArmed: true, ...launched });
        return;
      }

      // ---------------- On-Demand Container Live Browser ----------------

      if (pathname === "/api/live-browser" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          available: liveBrowser.isAvailable(),
          session: liveBrowser.getSession(),
        });
        return;
      }

      if (pathname === "/api/live-browser/start" && method === "POST") {
        const body = await readBodyJson<{ channelId?: string; platform?: string; url?: string }>(req);
        const channelId = body.channelId?.trim() ?? "";
        const channel = store.getChannel(channelId);
        if (!channel) {
          sendJson(res, 404, { ok: false, error: `Unknown channel '${channelId}'.` });
          return;
        }
        const platformId = body.platform?.trim().toLowerCase() || undefined;
        let targetUrl = body.url?.trim();
        if (!targetUrl && platformId) {
          const conn = channel.connections.find(c => c.platform === platformId);
          targetUrl = conn
            ? edgeAdapter.resolveConnectionUrls(conn).loginUrl
            : store.getPlatformDefinition(platformId)?.loginUrl;
        }
        if (!targetUrl) {
          targetUrl = "https://studio.youtube.com/";
        }
        const session = await liveBrowser.start({ channel, platform: platformId, url: targetUrl });
        sendJson(res, 200, { ok: true, session });
        return;
      }

      if (pathname === "/api/live-browser/stop" && method === "POST") {
        const body = await readBodyJson<{ verify?: boolean }>(req);
        const stopped = await liveBrowser.stop();
        let results: SessionCheckResult[] | undefined;
        if (body.verify && stopped.channelId) {
          const ch = store.getChannel(stopped.channelId);
          if (ch) {
            results = await edgeAdapter.checkSessions(ch, {
              platform: stopped.platform,
              headless: true,
            });
            for (const r of results) {
              store.saveSessionCheck(r);
              if (r.status === "signed_in") {
                const conn = ch.connections.find(c => c.platform === r.platform);
                if (conn && !conn.enabled) {
                  store.updateConnectionFields(ch.id, conn.id, { enabled: true });
                }
              }
            }
          }
        }
        sendJson(res, 200, { ok: true, stopped, ...(results ? { results } : {}) });
        return;
      }

      const sessionStateMatch = /^\/api\/channels\/([a-zA-Z0-9_-]+)\/session-state$/.exec(pathname);
      if (sessionStateMatch && method === "POST") {
        if (!authHeader) {
          sendJson(res, 401, { ok: false, error: "Authorization: Bearer token is required for session state import." });
          return;
        }
        const channel = store.getChannel(sessionStateMatch[1]);
        if (!channel) {
          sendJson(res, 404, { ok: false, error: `Unknown channel '${sessionStateMatch[1]}'` });
          return;
        }
        const body = await readBodyJson<{ cookies?: Array<Record<string, unknown>> }>(req);
        if (!Array.isArray(body.cookies)) {
          sendJson(res, 400, { ok: false, error: "Expected 'cookies' array in request body." });
          return;
        }
        const applied = await applyStorageStateToProfile(channel.profileDir, body);
        sendJson(res, 200, { ok: true, channelId: channel.id, ...applied });
        return;
      }

      const checkMatch = /^\/api\/channels\/([a-zA-Z0-9_-]+)\/check$/.exec(pathname);
      if (checkMatch && method === "POST") {
        const channel = store.getChannel(checkMatch[1]);
        if (!channel) {
          sendJson(res, 404, { ok: false, error: `Unknown channel '${checkMatch[1]}'` });
          return;
        }
        const body = await readBodyJson<{ platform?: string; headless?: boolean }>(req);
        const targetPlatform = body.platform?.trim().toLowerCase();
        const selectedConns = channel.connections.filter(c =>
          targetPlatform ? c.platform === targetPlatform : c.enabled,
        );
        if (selectedConns.length === 0) {
          sendJson(res, 400, {
            ok: false,
            error: targetPlatform
              ? `Platform '${targetPlatform}' is not configured on '${channel.id}'. Add it first before verifying.`
              : `No enabled connections configured on '${channel.id}' to verify.`,
          });
          return;
        }

        const results: SessionCheckResult[] = [];
        const browserConns = [];
        for (const conn of selectedConns) {
          if (isSupportedOAuthPlatform(conn.platform) && store.getOAuthToken(channel.id, conn.platform)) {
            results.push(await verifyOAuthSession(store, channel.id, conn.platform, conn.handle));
          } else {
            browserConns.push(conn);
          }
        }
        if (browserConns.length > 0) {
          const filteredChannel = { ...channel, connections: browserConns };
          const browserResults = await edgeAdapter.checkSessions(filteredChannel, {
            platform: targetPlatform,
            headless: body.headless ?? true,
          });
          results.push(...browserResults);
        }

        for (const r of results) {
          store.saveSessionCheck(r);
          if (r.status === "signed_in") {
            const conn = channel.connections.find(c => c.platform === r.platform);
            if (conn && !conn.enabled) {
              store.updateConnectionFields(channel.id, conn.id, { enabled: true });
            }
          }
        }
        sendJson(res, 200, { ok: true, results });
        return;
      }

      // ---------------- Jobs & Attempts ----------------

      if (pathname === "/api/jobs" && method === "GET") {
        const channelId = url.searchParams.get("channelId") ?? undefined;
        const platform = url.searchParams.get("platform") ?? undefined;
        const status = (url.searchParams.get("status") ?? undefined) as JobStatus | undefined;
        sendJson(res, 200, { ok: true, jobs: store.listJobs({ channelId, platform, status }) });
        return;
      }

      if (pathname === "/api/jobs" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const channelId = String(body.channelId ?? "");
        const platforms = Array.isArray(body.platforms)
          ? body.platforms.map(String)
          : [String(body.platform ?? "")].filter(Boolean);

        if (!channelId || platforms.length === 0) {
          sendJson(res, 400, { ok: false, error: "channelId and platform(s) are required." });
          return;
        }

        const videoId = body.videoId ? String(body.videoId) : `post-${Date.now()}`;
        const targetDate = String(body.targetDate ?? new Date().toISOString().slice(0, 10));
        const publishAt = String(body.publishAt ?? `${targetDate}T10:00:00`);
        const createdJobs = [];

        for (const platform of platforms) {
          const resJob = store.enqueueJob({
            idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:${platform}` : undefined,
            channelId,
            videoId,
            episode: body.episode ? String(body.episode) : targetDate,
            title: String(body.title ?? "Untitled Post"),
            platform,
            targetDate,
            publishAt,
            publishNowIfPastSlot: body.publishNowIfPastSlot !== false,
            videoPath: body.videoPath ? String(body.videoPath) : undefined,
            videoSha256: body.videoSha256 ? String(body.videoSha256) : undefined,
            videoBytes: typeof body.videoBytes === "number" ? body.videoBytes : undefined,
            coverPath: body.coverPath ? String(body.coverPath) : undefined,
            coverSha256: body.coverSha256 ? String(body.coverSha256) : undefined,
            status: body.status ? (String(body.status) as JobStatus) : "queued",
            payload: {
              title: String(body.title ?? "Untitled Post"),
              description: body.description ? String(body.description) : undefined,
              caption: body.caption ? String(body.caption) : undefined,
              postText: body.postText ? String(body.postText) : undefined,
              hashtags: Array.isArray(body.hashtags) ? body.hashtags.map(String) : undefined,
              tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
              category: body.category ? String(body.category) : undefined,
              videoLanguage: body.videoLanguage ? String(body.videoLanguage) : undefined,
              subreddit: body.subreddit ? String(body.subreddit) : undefined,
              captionsPath: body.captionsPath ? String(body.captionsPath) : undefined,
              aiDisclosure: body.aiDisclosure !== false,
              signatureId: body.signatureId ? String(body.signatureId) : undefined,
              repeatIntervalDays: typeof body.repeatIntervalDays === "number" ? body.repeatIntervalDays : undefined,
              repeatMax: typeof body.repeatMax === "number" ? body.repeatMax : undefined,
              delayCommentMinutes: typeof body.delayCommentMinutes === "number" ? body.delayCommentMinutes : undefined,
              followUpComment: body.followUpComment ? String(body.followUpComment) : undefined,
            },
          });
          createdJobs.push(resJob.job);
        }

        await dispatchWebhookEvent(store, "job.created", { count: createdJobs.length, channelId, platforms }).catch(() => {});
        sendJson(res, 201, { ok: true, jobs: createdJobs });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (jobMatch && method === "GET") {
        const job = store.getJob(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { ok: false, error: "Job not found" });
          return;
        }
        sendJson(res, 200, { ok: true, job, attempts: store.listAttempts(job.id) });
        return;
      }

      if (jobMatch && method === "PATCH") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const updated = store.updateJob(jobMatch[1], {
          title: body.title !== undefined ? String(body.title) : undefined,
          status: body.status !== undefined ? (String(body.status) as JobStatus) : undefined,
          targetDate: body.targetDate !== undefined ? String(body.targetDate) : undefined,
          publishAt: body.publishAt !== undefined ? String(body.publishAt) : undefined,
          publishNowIfPastSlot: body.publishNowIfPastSlot !== undefined ? Boolean(body.publishNowIfPastSlot) : undefined,
          payload: typeof body.payload === "object" && body.payload !== null ? (body.payload as Record<string, unknown>) : undefined,
        });
        sendJson(res, updated ? 200 : 404, { ok: Boolean(updated), job: updated });
        return;
      }

      if (jobMatch && method === "DELETE") {
        const deleted = store.deleteJob(jobMatch[1]);
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return;
      }

      const jobRunMatch = /^\/api\/jobs\/([a-zA-Z0-9_-]+)\/run$/.exec(pathname);
      if (jobRunMatch && method === "POST") {
        const job = store.getJob(jobRunMatch[1]);
        if (!job) {
          sendJson(res, 404, { ok: false, error: "Job not found" });
          return;
        }
        const body = await readBodyJson<{ dryRun?: boolean; headless?: boolean }>(req);
        const result = await worker.runSingleJob(job, {
          dryRun: Boolean(body.dryRun),
          headless: body.headless,
        });
        sendJson(res, 200, { ok: true, result, job: store.getJob(job.id), attempts: store.listAttempts(job.id) });
        return;
      }

      if (pathname === "/api/import-manifest" && method === "POST") {
        const body = await readBodyJson<{ manifestPath: string; receiptsPath?: string }>(req);
        if (!body.manifestPath || !existsSync(body.manifestPath)) {
          sendJson(res, 400, { ok: false, error: "Valid manifestPath is required." });
          return;
        }
        const manifest = JSON.parse(readFileSync(body.manifestPath, "utf8")) as PublishingManifest;
        const receipts = body.receiptsPath && existsSync(body.receiptsPath)
          ? (JSON.parse(readFileSync(body.receiptsPath, "utf8")) as { receipts?: ExistingReceipt[] } | ExistingReceipt[])
          : [];
        const receiptList = Array.isArray(receipts) ? receipts : receipts.receipts ?? [];
        const summary = store.importManifest(manifest, receiptList);
        sendJson(res, 200, { ok: true, summary });
        return;
      }

      // ---------------- Analytics ----------------

      if (pathname === "/api/analytics/overview" && method === "GET") {
        const channelId = url.searchParams.get("channelId") ?? undefined;
        const platform = url.searchParams.get("platform") ?? undefined;
        sendJson(res, 200, {
          ok: true,
          snapshots: store.listLatestChannelSnapshots(channelId),
          history: store.listChannelSnapshotHistory(channelId),
          videos: store.listVideoMetrics({ channelId, platform }),
        });
        return;
      }

      if (pathname === "/api/analytics/intelligence" && method === "GET") {
        const channelId = url.searchParams.get("channelId") ?? undefined;
        const platform = url.searchParams.get("platform") ?? undefined;
        sendJson(res, 200, { ok: true, report: buildVideoIntelligence(store, { channelId, platform }) });
        return;
      }

      if (pathname === "/api/analytics/sync" && method === "POST") {
        const body = await readBodyJson<{ channelId?: string; platform?: string; headless?: boolean }>(req);
        const resSync = await collectChannelAnalytics(store, {
          channelId: body.channelId,
          platform: body.platform,
          headless: body.headless,
        });
        sendJson(res, 200, {
          ok: true,
          ...resSync,
          intelligence: buildVideoIntelligence(store, { channelId: body.channelId, platform: body.platform }),
        });
        return;
      }

      // ---------------- Automations ----------------

      if (pathname === "/api/posting-sets" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const set = store.upsertPostingSet({
          id: body.id ? String(body.id) : undefined,
          name: String(body.name ?? "Daily Slot"),
          timezone: String(body.timezone ?? "America/New_York"),
          slots: Array.isArray(body.slots) ? (body.slots as Array<{ dayOfWeek: number; time: string }>) : [],
          platforms: Array.isArray(body.platforms) ? body.platforms.map(String) : [],
          active: body.active !== false,
        });
        sendJson(res, 201, { ok: true, postingSet: set });
        return;
      }

      const psDelMatch = /^\/api\/posting-sets\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (psDelMatch && method === "DELETE") {
        sendJson(res, 200, { ok: store.deletePostingSet(psDelMatch[1]) });
        return;
      }

      if (pathname === "/api/signatures" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const sig = store.upsertSignature({
          id: body.id ? String(body.id) : undefined,
          name: String(body.name ?? "Default Signature"),
          channelId: body.channelId ? String(body.channelId) : undefined,
          platform: body.platform ? String(body.platform) : undefined,
          body: String(body.body ?? ""),
          autoAppend: Boolean(body.autoAppend),
        });
        sendJson(res, 201, { ok: true, signature: sig });
        return;
      }

      const sigDelMatch = /^\/api\/signatures\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (sigDelMatch && method === "DELETE") {
        sendJson(res, 200, { ok: store.deleteSignature(sigDelMatch[1]) });
        return;
      }

      if (pathname === "/api/plugs" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const plug = store.upsertPlug({
          id: body.id ? String(body.id) : undefined,
          name: String(body.name ?? "Automation Plug"),
          scope: body.scope === "global" ? "global" : "internal",
          channelId: body.channelId ? String(body.channelId) : undefined,
          triggerType: (body.triggerType as "on_publish") ?? "on_publish",
          actionType: (body.actionType as "follow_up_comment") ?? "follow_up_comment",
          config: typeof body.config === "object" && body.config ? (body.config as Record<string, unknown>) : {},
          enabled: body.enabled !== false,
        });
        sendJson(res, 201, { ok: true, plug });
        return;
      }

      const plugDelMatch = /^\/api\/plugs\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (plugDelMatch && method === "DELETE") {
        sendJson(res, 200, { ok: store.deletePlug(plugDelMatch[1]) });
        return;
      }

      if (pathname === "/api/rss" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const feed = store.upsertRssFeed({
          id: body.id ? String(body.id) : undefined,
          name: String(body.name ?? "Feed"),
          feedUrl: String(body.feedUrl ?? ""),
          channelId: String(body.channelId ?? ""),
          platforms: Array.isArray(body.platforms) ? body.platforms.map(String) : ["x"],
          autoPublish: Boolean(body.autoPublish),
          defaultTime: String(body.defaultTime ?? "10:00"),
          enabled: body.enabled !== false,
        });
        sendJson(res, 201, { ok: true, feed });
        return;
      }

      const rssSyncMatch = /^\/api\/rss\/([a-zA-Z0-9_-]+)\/sync$/.exec(pathname);
      if (rssSyncMatch && method === "POST") {
        const feed = store.listRssFeeds().find(f => f.id === rssSyncMatch[1]);
        if (!feed) {
          sendJson(res, 404, { ok: false, error: "Feed not found" });
          return;
        }
        const outcome = await syncRssFeed(store, feed);
        sendJson(res, 200, { ok: true, outcome });
        return;
      }

      const rssDelMatch = /^\/api\/rss\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (rssDelMatch && method === "DELETE") {
        sendJson(res, 200, { ok: store.deleteRssFeed(rssDelMatch[1]) });
        return;
      }

      if (pathname === "/api/webhooks" && method === "POST") {
        const body = await readBodyJson<Record<string, unknown>>(req);
        const hook = store.upsertWebhook({
          id: body.id ? String(body.id) : undefined,
          name: String(body.name ?? "Webhook"),
          targetUrl: String(body.targetUrl ?? ""),
          secret: body.secret ? String(body.secret) : undefined,
          events: Array.isArray(body.events) ? body.events.map(String) : ["*"],
          enabled: body.enabled !== false,
        });
        sendJson(res, 201, { ok: true, webhook: hook });
        return;
      }

      const hookDelMatch = /^\/api\/webhooks\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (hookDelMatch && method === "DELETE") {
        sendJson(res, 200, { ok: store.deleteWebhook(hookDelMatch[1]) });
        return;
      }

      if (pathname === "/api/api-keys" && method === "POST") {
        const body = await readBodyJson<{ name?: string }>(req);
        const created = store.createApiKey(String(body.name ?? "CLI / Agent Key"));
        sendJson(res, 201, {
          ok: true,
          rawKey: created.rawKey,
          record: {
            id: created.record.id,
            name: created.record.name,
            keyPrefix: created.record.keyPrefix,
            createdAt: created.record.createdAt,
          },
        });
        return;
      }

      const keyDelMatch = /^\/api\/api-keys\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (keyDelMatch && method === "DELETE") {
        sendJson(res, 200, { ok: store.deleteApiKey(keyDelMatch[1]) });
        return;
      }

      // ---------------- Scheduler Controls ----------------

      if (pathname === "/api/scheduler" && method === "GET") {
        sendJson(res, 200, { ok: true, scheduler: scheduler.status() });
        return;
      }

      if (pathname === "/api/scheduler" && method === "POST") {
        const body = await readBodyJson<{ enabled?: boolean; runNow?: boolean; dryRun?: boolean }>(req);
        if (typeof body.enabled === "boolean") {
          scheduler.setEnabled(body.enabled);
        }
        let outcome: { ran: number; results: unknown[] } | undefined;
        if (body.runNow) {
          outcome = await scheduler.tick({ forceRun: true, dryRun: Boolean(body.dryRun) });
        }
        sendJson(res, 200, {
          ok: true,
          scheduler: scheduler.status(),
          ...(outcome ?? {}),
        });
        return;
      }

      // ---------------- Media & Evidence Streaming ----------------

      if (pathname === "/api/media/upload" && method === "POST") {
        const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
        const rawKind = url.searchParams.get("kind");
        const kind = rawKind === "cover" ? "cover" : rawKind === "captions" ? "captions" : "video";
        const defaultName = kind === "cover" ? "cover.jpg" : kind === "captions" ? "captions.srt" : "video.mp4";
        const rawFilename = url.searchParams.get("filename") || defaultName;
        const safeName = basename(rawFilename).replace(/[^a-zA-Z0-9._-]/g, "_") || defaultName;
        const ext = extname(safeName).toLowerCase();
        const allowed =
          kind === "cover"
            ? new Set([".jpg", ".jpeg", ".png", ".webp"])
            : kind === "captions"
              ? new Set([".srt", ".vtt", ".sbv"])
              : new Set([".mp4", ".mov", ".webm", ".m4v"]);

        if (!allowed.has(ext)) {
          sendJson(res, 400, { ok: false, error: `Unsupported ${kind} file extension '${ext || "(none)"}'.` });
          return;
        }
        const declaredLen = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES) {
          sendJson(res, 413, { ok: false, error: "File exceeds 512 MB upload limit." });
          return;
        }

        const uploadDir = join(config.dataDir, "media", "uploads");
        mkdirSync(uploadDir, { recursive: true });
        const finalName = `${Date.now()}-${safeName}`;
        const destPath = join(uploadDir, finalName);
        const hash = createHash("sha256");
        const outStream = createWriteStream(destPath);
        let bytes = 0;

        try {
          for await (const rawChunk of req) {
            const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            bytes += buf.length;
            if (bytes > MAX_UPLOAD_BYTES) {
              outStream.destroy();
              rmSync(destPath, { force: true });
              sendJson(res, 413, { ok: false, error: "File exceeds 512 MB upload limit." });
              return;
            }
            hash.update(buf);
            if (!outStream.write(buf)) {
              await new Promise<void>((resolveDrain, rejectDrain) => {
                outStream.once("drain", resolveDrain);
                outStream.once("error", rejectDrain);
              });
            }
          }
          await new Promise<void>((resolveFinish, rejectFinish) => {
            outStream.once("finish", resolveFinish);
            outStream.once("error", rejectFinish);
            outStream.end();
          });
        } catch (err) {
          outStream.destroy();
          rmSync(destPath, { force: true });
          throw err;
        }

        if (bytes === 0) {
          rmSync(destPath, { force: true });
          sendJson(res, 400, { ok: false, error: "Uploaded file body was empty." });
          return;
        }

        sendJson(res, 201, {
          ok: true,
          path: destPath,
          sha256: hash.digest("hex"),
          bytes,
          filename: finalName,
        });
        return;
      }

      const videoMatch = /^\/api\/media\/video\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (videoMatch && method === "GET") {
        const job = store.getJob(videoMatch[1]);
        if (!job?.videoPath) {
          res.writeHead(404).end("No video associated with job");
          return;
        }
        streamVideoFile(req, res, job.videoPath);
        return;
      }

      const thumbMatch = /^\/api\/media\/thumb\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (thumbMatch && method === "GET") {
        const job = store.getJob(thumbMatch[1]);
        const thumbPath = job?.payload.thumbnailPath ?? job?.coverPath;
        if (!thumbPath || !existsSync(thumbPath)) {
          res.writeHead(404).end("Thumbnail not found");
          return;
        }
        const ct = MIME_MAP[extname(thumbPath).toLowerCase()] ?? "image/jpeg";
        res.writeHead(200, { "Content-Type": ct, "Cache-Control": "private, max-age=3600" });
        createReadStream(thumbPath).pipe(res);
        return;
      }

      const evMatch = /^\/api\/evidence\/([a-zA-Z0-9._-]+)$/.exec(pathname);
      if (evMatch && method === "GET") {
        const safeName = basename(evMatch[1]);
        const target = join(config.evidenceDir, safeName);
        if (!existsSync(target)) {
          res.writeHead(404).end("Evidence screenshot not found");
          return;
        }
        const ct = MIME_MAP[extname(safeName).toLowerCase()] ?? "image/png";
        res.writeHead(200, { "Content-Type": ct });
        createReadStream(target).pipe(res);
        return;
      }

      // ---------------- Live Browser noVNC HTTP Proxy ----------------

      if (pathname === "/live-browser" || pathname === "/live-browser/") {
        const active = liveBrowser.getSession();
        if (!active) {
          sendJson(res, 404, { ok: false, error: "No active Live Browser session." });
          return;
        }
        res.writeHead(302, { Location: active.viewerPath });
        res.end();
        return;
      }

      if (pathname.startsWith("/live-browser/")) {
        const active = liveBrowser.getSession();
        if (!active) {
          sendJson(res, 404, { ok: false, error: "No active Live Browser session." });
          return;
        }
        const strippedPath = (req.url ?? "/").replace(/^\/live-browser/, "") || "/";
        await new Promise<void>(resolveProxy => {
          const proxyReq = httpRequest(
            {
              hostname: "127.0.0.1",
              port: liveBrowser.getProxyPort(),
              path: strippedPath,
              method,
              headers: {
                ...req.headers,
                host: `127.0.0.1:${liveBrowser.getProxyPort()}`,
              },
            },
            proxyRes => {
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
              proxyRes.pipe(res);
              proxyRes.once("end", resolveProxy);
              proxyRes.once("error", resolveProxy);
            },
          );
          proxyReq.once("error", err => {
            if (!res.headersSent) {
              sendJson(res, 502, { ok: false, error: `Live Browser proxy error: ${err.message}` });
            } else {
              res.end();
            }
            resolveProxy();
          });
          req.pipe(proxyReq);
        });
        return;
      }

      // ---------------- Static SPA Serving ----------------

      if (existsSync(webDistDir)) {
        const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const candidate = join(webDistDir, rel);
        if (candidate.startsWith(webDistDir) && existsSync(candidate) && statSync(candidate).isFile()) {
          const ct = MIME_MAP[extname(candidate).toLowerCase()] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": ct });
          createReadStream(candidate).pipe(res);
          return;
        }
        const fallbackHtml = join(webDistDir, "index.html");
        if (existsSync(fallbackHtml) && !pathname.startsWith("/api/")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          createReadStream(fallbackHtml).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
    } catch (error) {
      const statusCode =
        typeof (error as { statusCode?: unknown })?.statusCode === "number"
          ? ((error as { statusCode: number }).statusCode)
          : 500;
      sendJson(res, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith("/live-browser/websockify") || !liveBrowser.getSession()) {
      socket.destroy();
      return;
    }

    const targetPath = rawUrl.replace(/^\/live-browser/, "") || "/websockify";
    const upstream = netConnect(liveBrowser.getProxyPort(), "127.0.0.1");

    const closeBoth = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };

    upstream.once("error", closeBoth);
    socket.once("error", closeBoth);
    upstream.once("close", () => {
      if (!socket.destroyed) socket.end();
    });
    socket.once("close", () => {
      if (!upstream.destroyed) upstream.end();
    });

    upstream.once("connect", () => {
      const headerLines: string[] = [`GET ${targetPath} HTTP/${req.httpVersion || "1.1"}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1] ?? "";
        if (name.toLowerCase() === "host") {
          headerLines.push(`${name}: 127.0.0.1:${liveBrowser.getProxyPort()}`);
        } else {
          headerLines.push(`${name}: ${value}`);
        }
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head && head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });

  server.on("close", () => {
    void liveBrowser.stop();
  });

  return server;
}
