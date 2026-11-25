import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AdapterExecutionOptions, PublishAdapter } from "./types.js";
import type { ChannelConfig, ChannelConnection, ExecutionResult, PublishJob } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Optional YouTube Data API bridge when a local OAuth helper script is configured.
 * Reads configured profile name from connection.metadata.oauthProfile or defaults to channel.id.
 */
export class YouTubeApiAdapter implements PublishAdapter {
  readonly kind = "youtube_api" as const;

  constructor(
    private readonly pythonPath?: string,
    private readonly scriptPath?: string,
  ) {}

  async probeChannel(
    channel: ChannelConfig,
    connection?: ChannelConnection,
  ): Promise<{ ok: boolean; status: string; channelTitle?: string; uploadCount?: number; message: string }> {
    if (!this.pythonPath || !this.scriptPath || !existsSync(this.pythonPath) || !existsSync(this.scriptPath)) {
      return {
        ok: false,
        status: "missing_runtime",
        message: "YouTube API helper runtime not configured; using Edge Studio browser adapter.",
      };
    }

    const profile =
      typeof connection?.metadata?.oauthProfile === "string" && connection.metadata.oauthProfile.trim()
        ? connection.metadata.oauthProfile.trim()
        : channel.id;

    const tempDir = mkdtempSync(join(tmpdir(), "rd-yt-probe-"));
    const receiptPath = join(tempDir, "probe-receipt.json");
    try {
      await execFileAsync(this.pythonPath, ["-B", this.scriptPath, "probe", profile, "--receipt", receiptPath], {
        windowsHide: true,
        timeout: 30_000,
      });
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        channel_id?: string;
        recent_uploads?: unknown[];
      };
      return {
        ok: true,
        status: "verified",
        channelTitle: receipt.channel_id,
        uploadCount: receipt.recent_uploads?.length ?? 0,
        message: `YouTube API OAuth probe succeeded (${receipt.recent_uploads?.length ?? 0} recent uploads read).`,
      };
    } catch {
      return {
        ok: false,
        status: "needs_login",
        message: `YouTube OAuth grant missing or expired for '${profile}'.`,
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async execute(
    _job: PublishJob,
    channel: ChannelConfig,
    connection: ChannelConnection,
    options: AdapterExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const probe = await this.probeChannel(channel, connection);
    if (!probe.ok) {
      return { status: "needs_login", message: probe.message };
    }
    if (options.dryRun) {
      return { status: "queued", dryRun: true, message: probe.message };
    }
    return {
      status: "needs_human_action",
      message: "YouTube API probe passed; public scheduling uses edge_studio unless Google Cloud audit approval is enabled.",
    };
  }
}
