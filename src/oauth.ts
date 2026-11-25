import { randomBytes } from "node:crypto";
import type { VesperaStore } from "./db.js";
import type { ChannelConfig, ExecutionResult, PublishJob, SessionCheckResult } from "./types.js";

export type SupportedOAuthPlatform = "youtube" | "reddit";

interface PendingState {
  channelId: string;
  platform: SupportedOAuthPlatform;
  redirectUri: string;
  createdAt: number;
}

const pendingStates = new Map<string, PendingState>();
const STATE_TTL_MS = 15 * 60 * 1000;

function cleanupExpiredStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, item] of pendingStates) {
    if (item.createdAt < cutoff) pendingStates.delete(key);
  }
}

function getYouTubeCredentials() {
  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim() || "";
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

function getRedditCredentials() {
  const clientId = process.env.REDDIT_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim() || "";
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

export function getOAuthProviderStatus(): { youtubeConfigured: boolean; redditConfigured: boolean } {
  return {
    youtubeConfigured: getYouTubeCredentials().configured,
    redditConfigured: getRedditCredentials().configured,
  };
}

export function isSupportedOAuthPlatform(value: string): value is SupportedOAuthPlatform {
  return value === "youtube" || value === "reddit";
}

export function buildOAuthStartUrl(
  platform: SupportedOAuthPlatform,
  channelId: string,
  callbackBaseUrl: string,
): { ok: true; authUrl: string } | { ok: false; error: string } {
  cleanupExpiredStates();
  const base = callbackBaseUrl.replace(/\/+$/, "");
  const redirectUri = `${base}/api/oauth/${platform}/callback`;
  const state = randomBytes(24).toString("hex");

  if (platform === "youtube") {
    const creds = getYouTubeCredentials();
    if (!creds.configured) {
      return {
        ok: false,
        error: "YouTube OAuth is not configured on the server yet (set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET).",
      };
    }
    pendingStates.set(state, { channelId, platform, redirectUri, createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return { ok: true, authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  }

  const creds = getRedditCredentials();
  if (!creds.configured) {
    return {
      ok: false,
      error: "Reddit OAuth is not configured on the server yet (set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET).",
    };
  }
  pendingStates.set(state, { channelId, platform, redirectUri, createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: "code",
    state,
    redirect_uri: redirectUri,
    duration: "permanent",
    scope: "identity submit read",
  });
  return { ok: true, authUrl: `https://www.reddit.com/api/v1/authorize?${params.toString()}` };
}

async function fetchYouTubeAccountLabel(accessToken: string): Promise<string | undefined> {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    items?: Array<{ snippet?: { title?: string; customUrl?: string } }>;
  };
  const item = data.items?.[0]?.snippet;
  return item?.customUrl || item?.title || undefined;
}

async function fetchRedditAccountLabel(accessToken: string): Promise<string | undefined> {
  const res = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Vespera/1.0",
    },
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { name?: string };
  return data.name ? `u/${data.name}` : undefined;
}

export async function handleOAuthCallback(
  store: VesperaStore,
  platform: SupportedOAuthPlatform,
  code: string,
  state: string,
): Promise<{ channelId: string; accountLabel?: string }> {
  cleanupExpiredStates();
  const pending = pendingStates.get(state);
  if (!pending || pending.platform !== platform) {
    throw new Error("Invalid or expired OAuth state. Restart Connect from the dashboard.");
  }
  pendingStates.delete(state);

  const channel = store.getChannel(pending.channelId);
  if (!channel) {
    throw new Error(`Channel '${pending.channelId}' not found.`);
  }

  let accessToken = "";
  let refreshToken: string | undefined;
  let expiresIn = 3600;
  let scope: string | undefined;
  let accountLabel: string | undefined;

  if (platform === "youtube") {
    const creds = getYouTubeCredentials();
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: pending.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed (${res.status}).`);
    }
    const tokenJson = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    accessToken = tokenJson.access_token ?? "";
    refreshToken = tokenJson.refresh_token;
    expiresIn = Number(tokenJson.expires_in ?? 3600);
    scope = tokenJson.scope;
    accountLabel = accessToken ? await fetchYouTubeAccountLabel(accessToken) : undefined;
  } else {
    const creds = getRedditCredentials();
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Vespera/1.0",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`Reddit token exchange failed (${res.status}).`);
    }
    const tokenJson = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    accessToken = tokenJson.access_token ?? "";
    refreshToken = tokenJson.refresh_token;
    expiresIn = Number(tokenJson.expires_in ?? 3600);
    scope = tokenJson.scope;
    accountLabel = accessToken ? await fetchRedditAccountLabel(accessToken) : undefined;
  }

  if (!accessToken) {
    throw new Error(`OAuth token missing from ${platform} response.`);
  }

  const expiresAt = new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString();
  store.saveOAuthToken({
    channelId: channel.id,
    platform,
    accountLabel,
    accessToken,
    refreshToken,
    scope,
    expiresAt,
  });

  const conn = channel.connections.find(c => c.platform === platform);
  const expectedHandle = conn?.handle ?? accountLabel ?? (platform === "reddit" ? `u/${channel.id}` : `@${channel.id}`);
  if (!conn) {
    store.upsertConnection({
      channelId: channel.id,
      platform,
      handle: accountLabel ?? expectedHandle,
      enabled: true,
      adapter: platform === "youtube" ? "youtube_api" : "edge_studio",
    });
  } else if (!conn.enabled) {
    store.updateConnectionFields(channel.id, conn.id, { enabled: true });
  }

  store.saveSessionCheck({
    channelId: channel.id,
    platform,
    status: "signed_in",
    expectedHandle,
    observedHandle: accountLabel ?? expectedHandle,
    checkedAt: new Date().toISOString(),
    url: `oauth://${platform}`,
    note: `Verified via official ${platform} OAuth2 token.`,
  });

  return { channelId: channel.id, accountLabel };
}

export async function verifyOAuthSession(
  store: VesperaStore,
  channelId: string,
  platform: SupportedOAuthPlatform,
  expectedHandle: string,
): Promise<SessionCheckResult> {
  const checkedAt = new Date().toISOString();
  const record = store.getOAuthToken(channelId, platform);
  if (!record) {
    return {
      channelId,
      platform,
      status: "logged_out",
      expectedHandle,
      checkedAt,
      url: `oauth://${platform}`,
      note: `No ${platform} OAuth token stored.`,
    };
  }

  let accessToken = record.accessToken;
  const expired = record.expiresAt ? Date.parse(record.expiresAt) <= Date.now() + 60_000 : false;
  if (expired && record.refreshToken) {
    try {
      if (platform === "youtube") {
        const creds = getYouTubeCredentials();
        if (creds.configured) {
          const r = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: creds.clientId,
              client_secret: creds.clientSecret,
              refresh_token: record.refreshToken,
              grant_type: "refresh_token",
            }),
          });
          if (r.ok) {
            const j = (await r.json()) as { access_token?: string; expires_in?: number };
            if (j.access_token) {
              accessToken = j.access_token;
              store.saveOAuthToken({
                channelId,
                platform,
                accessToken,
                expiresAt: new Date(Date.now() + Math.max(60, Number(j.expires_in ?? 3600) - 60) * 1000).toISOString(),
              });
            }
          }
        }
      } else {
        const creds = getRedditCredentials();
        if (creds.configured) {
          const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
          const r = await fetch("https://www.reddit.com/api/v1/access_token", {
            method: "POST",
            headers: {
              Authorization: `Basic ${basic}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Vespera/1.0",
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: record.refreshToken,
            }),
          });
          if (r.ok) {
            const j = (await r.json()) as { access_token?: string; expires_in?: number };
            if (j.access_token) {
              accessToken = j.access_token;
              store.saveOAuthToken({
                channelId,
                platform,
                accessToken,
                expiresAt: new Date(Date.now() + Math.max(60, Number(j.expires_in ?? 3600) - 60) * 1000).toISOString(),
              });
            }
          }
        }
      }
    } catch {
      // Fall through to live probe which reports logged_out cleanly if token is invalid.
    }
  }

  const label =
    platform === "youtube"
      ? await fetchYouTubeAccountLabel(accessToken).catch(() => undefined)
      : await fetchRedditAccountLabel(accessToken).catch(() => undefined);

  if (!label) {
    return {
      channelId,
      platform,
      status: "logged_out",
      expectedHandle,
      checkedAt,
      url: `oauth://${platform}`,
      note: `${platform} OAuth token expired or revoked; click Connect to re-authorize.`,
    };
  }

  return {
    channelId,
    platform,
    status: "signed_in",
    expectedHandle,
    observedHandle: label,
    checkedAt,
    url: `oauth://${platform}`,
    note: `Verified via official ${platform} OAuth2 token.`,
  };
}

export async function submitRedditPostViaOAuth(
  store: VesperaStore,
  job: PublishJob,
  channel: ChannelConfig,
  dryRun = false,
): Promise<ExecutionResult> {
  const conn = channel.connections.find(c => c.platform === "reddit");
  const check = await verifyOAuthSession(store, channel.id, "reddit", conn?.handle ?? job.handle);
  if (check.status !== "signed_in") {
    return { status: "needs_login", message: check.note ?? "Reddit OAuth sign-in required." };
  }
  if (dryRun) {
    return {
      status: "queued",
      dryRun: true,
      message: `Dry-run passed: Reddit OAuth ready (${check.observedHandle ?? job.handle}).`,
    };
  }
  const subreddit = (job.payload.subreddit ?? "").trim().replace(/^r\//i, "");
  if (!subreddit) {
    return {
      status: "needs_human_action",
      message: "Reddit post requires a target subreddit (e.g. r/opensource) before auto-submitting.",
    };
  }
  const token = store.getOAuthToken(channel.id, "reddit")?.accessToken;
  if (!token) {
    return { status: "needs_login", message: "Reddit OAuth token missing." };
  }

  const bodyCopy = [
    job.payload.postText ?? job.payload.caption ?? job.payload.description ?? "",
    job.payload.hashtags?.length ? job.payload.hashtags.join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const res = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Vespera/1.0",
    },
    body: new URLSearchParams({
      api_type: "json",
      sr: subreddit,
      kind: "self",
      title: (job.payload.title ?? job.title).slice(0, 300),
      text: bodyCopy || job.title,
      resubmit: "true",
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    json?: { errors?: unknown[]; data?: { id?: string; url?: string } };
  };
  const errors = payload.json?.errors ?? [];
  if (!res.ok || errors.length > 0) {
    return {
      status: "failed",
      message: `Reddit API submit failed (${res.status}): ${JSON.stringify(errors)}`,
    };
  }
  return {
    status: "published",
    remoteId: payload.json?.data?.id,
    remoteUrl: payload.json?.data?.url,
    message: `Posted to r/${subreddit} via Reddit OAuth2.`,
  };
}
