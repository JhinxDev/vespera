import { createInterface } from "node:readline";
import { collectChannelAnalytics } from "./analytics/collector.js";
import { buildVideoIntelligence } from "./analytics/intelligence.js";
import type { VesperaStore } from "./db.js";
import type { JobStatus } from "./types.js";
import type { PublishWorker } from "./worker.js";
import { VESPERA_VERSION } from "./version.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "vespera_status",
    description: "Summarize channels, active platform connections, and queue status counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vespera_list_channels",
    description: "List workspaces and their connected platforms, handles, and verified session states.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vespera_list_jobs",
    description: "List publishing jobs with optional channelId, platform, and status filters.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        platform: { type: "string" },
        status: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vespera_schedule_post",
    description: "Enqueue or schedule a cross-platform social post across one or more target platforms.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        platforms: { type: "array", items: { type: "string" } },
        title: { type: "string" },
        caption: { type: "string" },
        description: { type: "string" },
        targetDate: { type: "string" },
        publishAt: { type: "string" },
        videoPath: { type: "string" },
        coverPath: { type: "string" },
      },
      required: ["channelId", "platforms", "title", "targetDate", "publishAt"],
      additionalProperties: false,
    },
  },
  {
    name: "vespera_get_analytics",
    description: "Retrieve stored channel snapshots and per-video analytics metrics from SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        platform: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vespera_video_intelligence",
    description: "Generate data-backed Video Intelligence takeaways and Markdown brief from real synced metrics.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        platform: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vespera_sync_analytics",
    description: "Collect live channel and per-video analytics across signed-in browser sessions.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        platform: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vespera_run_due_jobs",
    description: "Run due publishing jobs cleanly with optional dryRun mode and limit.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        platform: { type: "string" },
        dryRun: { type: "boolean" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
];

export async function handleMcpRequest(
  store: VesperaStore,
  req: JsonRpcRequest,
  worker?: PublishWorker,
): Promise<unknown | null> {
  if (req.id === undefined) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });

  if (req.method === "initialize") {
    return reply({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "vespera", version: VESPERA_VERSION },
    });
  }
  if (req.method === "tools/list") {
    return reply({ tools: TOOLS });
  }
  if (req.method === "tools/call") {
    const name = String(req.params?.name ?? "");
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      let data: unknown;
      if (name === "vespera_status") {
        data = { summary: store.statusSummary(), platforms: store.listAllPlatforms().length };
      } else if (name === "vespera_list_channels") {
        data = store.listChannels();
      } else if (name === "vespera_list_jobs") {
        data = store.listJobs({
          channelId: args.channelId ? String(args.channelId) : undefined,
          platform: args.platform ? String(args.platform) : undefined,
          status: args.status ? (String(args.status) as JobStatus) : undefined,
        });
      } else if (name === "vespera_schedule_post") {
        const platforms = Array.isArray(args.platforms) ? args.platforms.map(String) : [];
        const created = platforms.map(platform =>
          store.enqueueJob({
            channelId: String(args.channelId),
            platform,
            title: String(args.title),
            targetDate: String(args.targetDate),
            publishAt: String(args.publishAt),
            videoPath: args.videoPath ? String(args.videoPath) : undefined,
            coverPath: args.coverPath ? String(args.coverPath) : undefined,
            payload: {
              title: String(args.title),
              caption: args.caption ? String(args.caption) : undefined,
              description: args.description ? String(args.description) : undefined,
            },
          }).job,
        );
        data = { created };
      } else if (name === "vespera_get_analytics") {
        data = {
          snapshots: store.listLatestChannelSnapshots(args.channelId ? String(args.channelId) : undefined),
          videos: store.listVideoMetrics({
            channelId: args.channelId ? String(args.channelId) : undefined,
            platform: args.platform ? String(args.platform) : undefined,
          }),
        };
      } else if (name === "vespera_video_intelligence") {
        data = buildVideoIntelligence(store, {
          channelId: args.channelId ? String(args.channelId) : undefined,
          platform: args.platform ? String(args.platform) : undefined,
        });
      } else if (name === "vespera_sync_analytics") {
        data = await collectChannelAnalytics(store, {
          channelId: args.channelId ? String(args.channelId) : undefined,
          platform: args.platform ? String(args.platform) : undefined,
        });
      } else if (name === "vespera_run_due_jobs") {
        if (!worker) throw new Error("PublishWorker unavailable in this MCP host.");
        data = await worker.runDueJobs({
          channelId: args.channelId ? String(args.channelId) : undefined,
          platform: args.platform ? String(args.platform) : undefined,
          dryRun: Boolean(args.dryRun),
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
      } else {
        return fail(-32601, `Unknown MCP tool: ${name}`);
      }

      return reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
    } catch (error) {
      return reply({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      });
    }
  }

  return fail(-32601, `Unsupported MCP method: ${req.method}`);
}

export function startMcpStdioServer(store: VesperaStore, worker?: PublishWorker): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const response = await handleMcpRequest(store, req, worker);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } })}\n`,
        );
      }
    })();
  });
}
