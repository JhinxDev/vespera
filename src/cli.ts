import { existsSync, readFileSync } from "node:fs";
import { EdgeStudioAdapter } from "./adapters/edge-studio.js";
import { WebhookAdapter } from "./adapters/webhook.js";
import { YouTubeApiAdapter } from "./adapters/youtube-api.js";
import { collectChannelAnalytics } from "./analytics/collector.js";
import { resolveRuntimeConfig } from "./config.js";
import { VesperaStore } from "./db.js";
import { startMcpStdioServer } from "./mcp.js";
import { createSchedulerManager, createVesperaServer } from "./server.js";
import type { ExistingReceipt, PublishingManifest } from "./types.js";
import { PublishWorker } from "./worker.js";

function parseArgs(argv: string[]) {
  const [command = "status", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const config = resolveRuntimeConfig();
  const store = new VesperaStore(config.dbPath, config.profilesDir);

  if (store.listChannels().length === 0 && existsSync(config.channelsFile)) {
    store.importChannelsFile(config.channelsFile);
  }

  const edgeAdapter = new EdgeStudioAdapter(config.evidenceDir, id => store.getPlatformDefinition(id));
  const youtubeApiAdapter = new YouTubeApiAdapter(config.youtubePythonPath, config.youtubeDirectScriptPath);
  const webhookAdapter = new WebhookAdapter();
  const worker = new PublishWorker(store, edgeAdapter, youtubeApiAdapter, webhookAdapter);

  if (command === "serve") {
    const recovered = store.recoverStaleRunningJobs();
    if (recovered.length > 0) {
      console.warn(`[startup] Recovered ${recovered.length} stale 'running' job(s) to needs_human_action.`);
    }
    const scheduler = createSchedulerManager(store, worker);
    scheduler.start(60_000);
    const server = createVesperaServer({ config, store, edgeAdapter, worker, scheduler });
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] Received ${signal}; draining scheduler, Live Browser, HTTP server, and SQLite.`);
      scheduler.stop();
      server.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => {
        try {
          store.close();
        } catch {
          // Ignore already closed SQLite store on forced exit.
        }
        process.exit(0);
      }, 6000).unref?.();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    server.listen(config.port, config.host, () => {
      console.log(`Vespera running at http://${config.host}:${config.port}`);
      console.log(`Data directory: ${config.dataDir}`);
      console.log(
        `Scheduler: ${scheduler.status().enabled ? "ENABLED" : "PAUSED"} (${scheduler.status().dueCount} due, ${scheduler.status().overdueCount} overdue)`,
      );
    });
    return;
  }

  if (command === "mcp") {
    startMcpStdioServer(store, worker);
    return;
  }

  if (command === "connect") {
    const channelId = positional[0];
    if (!channelId) {
      console.error("Usage: vespera connect <channel-id> [platform] [--url <custom-url>]");
      process.exitCode = 1;
      store.close();
      return;
    }
    const channel = store.getChannel(channelId);
    if (!channel) {
      throw new Error(`Unknown channel '${channelId}'. Configured channels: ${store.listChannels().map(c => c.id).join(", ")}`);
    }
    const platformId = positional[1]?.toLowerCase();
    let targetUrl = typeof flags.url === "string" ? flags.url : undefined;
    if (!targetUrl && platformId) {
      const conn = channel.connections.find(c => c.platform === platformId);
      targetUrl = conn
        ? edgeAdapter.resolveConnectionUrls(conn).loginUrl
        : store.getPlatformDefinition(platformId)?.loginUrl;
    }
    if (!targetUrl) {
      const firstConn = channel.connections.find(c => c.enabled) ?? channel.connections[0];
      if (!firstConn) {
        throw new Error(`Channel '${channelId}' has no connections configured; pass a platform name or --url.`);
      }
      targetUrl = edgeAdapter.resolveConnectionUrls(firstConn).loginUrl;
    }
    console.log(`Opening persistent profile for '${channel.id}' at ${targetUrl}. Close the Edge window when finished.`);
    const res = await edgeAdapter.openPlatformConnect(channel, targetUrl, { waitForClose: true });
    console.log(JSON.stringify({ ok: true, channelId: channel.id, ...res }, null, 2));
    store.close();
    return;
  }

  if (command === "check") {
    const channelId = positional[0];
    const platform = positional[1]?.toLowerCase();
    const visible = Boolean(flags.visible);
    const targets = channelId
      ? store.listChannels().filter(c => c.id === channelId)
      : store.listChannels();
    const allResults = [];
    for (const ch of targets) {
      const res = await edgeAdapter.checkSessions(ch, { platform, headless: !visible });
      for (const item of res) {
        store.saveSessionCheck(item);
      }
      allResults.push(...res);
    }
    console.log(JSON.stringify(allResults, null, 2));
    store.close();
    return;
  }

  if (command === "sync-analytics") {
    const channelId = positional[0] ?? (typeof flags.channel === "string" ? flags.channel : undefined);
    const platform = positional[1] ?? (typeof flags.platform === "string" ? flags.platform : undefined);
    const outcome = await collectChannelAnalytics(store, {
      channelId,
      platform,
      headless: flags.visible ? false : undefined,
    });
    console.log(JSON.stringify(outcome, null, 2));
    store.close();
    return;
  }

  if (command === "import-channels") {
    const file = positional[0] ?? config.channelsFile;
    const summary = store.importChannelsFile(file);
    console.log(JSON.stringify({ ok: true, file, ...summary }, null, 2));
    store.close();
    return;
  }

  if (command === "import-manifest") {
    const manifestPath = positional[0];
    const receiptsPath = positional[1];
    if (!manifestPath || !existsSync(manifestPath)) {
      throw new Error(`Manifest file not found: ${manifestPath ?? "(missing path)"}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishingManifest;
    let receipts: ExistingReceipt[] = [];
    if (receiptsPath && existsSync(receiptsPath)) {
      const parsed = JSON.parse(readFileSync(receiptsPath, "utf8")) as { receipts?: ExistingReceipt[] } | ExistingReceipt[];
      receipts = Array.isArray(parsed) ? parsed : parsed.receipts ?? [];
    }
    const summary = store.importManifest(manifest, receipts);
    console.log(JSON.stringify(summary, null, 2));
    store.close();
    return;
  }

  if (command === "worker") {
    const results = await worker.runDueJobs({
      channelId: typeof flags.channel === "string" ? flags.channel : undefined,
      platform: typeof flags.platform === "string" ? flags.platform : undefined,
      jobId: typeof flags["job-id"] === "string" ? flags["job-id"] : undefined,
      dryRun: Boolean(flags["dry-run"]),
      headless: flags.visible ? false : undefined,
      limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
    });
    console.log(JSON.stringify(results, null, 2));
    store.close();
    return;
  }

  console.log(JSON.stringify({
    summary: store.statusSummary(),
    channels: store.listChannels().map(c => ({
      id: c.id,
      name: c.name,
      connections: c.connections.map(x => `${x.platform}:${x.handle}:${x.sessionStatus}`),
    })),
  }, null, 2));
  store.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
