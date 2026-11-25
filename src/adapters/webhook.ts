import { createHmac } from "node:crypto";
import type { AdapterExecutionOptions, PublishAdapter } from "./types.js";
import type { ChannelConfig, ChannelConnection, ExecutionResult, PublishJob } from "../types.js";

export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class WebhookAdapter implements PublishAdapter {
  readonly kind = "webhook" as const;

  async execute(
    job: PublishJob,
    channel: ChannelConfig,
    connection: ChannelConnection,
    options: AdapterExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const url = connection.webhookUrl?.trim();
    if (!url) {
      return {
        status: "needs_human_action",
        message: `Webhook URL missing for ${channel.id}/${job.platform}. Set webhookUrl on the connection.`,
      };
    }

    if (options.dryRun) {
      return {
        status: "queued",
        dryRun: true,
        message: `Dry-run passed: Webhook adapter ready for ${channel.id}/${job.platform} -> ${url}`,
      };
    }

    const body = JSON.stringify({
      event: "vespera.publish",
      channelId: channel.id,
      channelName: channel.name,
      platform: job.platform,
      handle: connection.handle,
      jobId: job.id,
      title: job.payload.title ?? job.title,
      caption: job.payload.caption ?? job.payload.postText ?? job.payload.description ?? job.title,
      hashtags: job.payload.hashtags ?? [],
      subreddit: job.payload.subreddit,
      targetDate: job.targetDate,
      publishAt: job.publishAt,
      videoPath: job.videoPath,
      videoSha256: job.videoSha256,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Vespera-Event": "vespera.publish",
    };
    const secret = typeof connection.metadata?.webhookSecret === "string" ? connection.metadata.webhookSecret : "";
    if (secret) {
      headers["X-Vespera-Signature"] = signWebhookPayload(secret, body);
    }

    const res = await fetch(url, { method: "POST", headers, body });
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (!res.ok) {
      return {
        status: "failed",
        message: `Webhook endpoint returned HTTP ${res.status}: ${text || res.statusText}`,
      };
    }

    return {
      status: "published",
      message: `Dispatched to webhook for ${job.platform} (HTTP ${res.status}).`,
    };
  }
}
