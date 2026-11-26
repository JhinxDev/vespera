import type { EdgeStudioAdapter } from "./adapters/edge-studio.js";
import type { AdapterExecutionOptions } from "./adapters/types.js";
import type { WebhookAdapter } from "./adapters/webhook.js";
import type { YouTubeApiAdapter } from "./adapters/youtube-api.js";
import { applyChannelSignature, applyPostPublishAutomations, dispatchWebhookEvent } from "./automations/engine.js";
import type { VesperaStore } from "./db.js";
import { submitRedditPostViaOAuth } from "./oauth.js";
import type { ExecutionResult, PublishJob } from "./types.js";

export interface WorkerRunOptions extends AdapterExecutionOptions {
  channelId?: string;
  platform?: string;
  jobId?: string;
  limit?: number;
  nowIso?: string;
  isChannelBusy?: (channelId: string) => boolean;
}

export class PublishWorker {
  private channelBusyCheck?: (channelId: string) => boolean;

  constructor(
    private readonly store: VesperaStore,
    private readonly edgeAdapter: EdgeStudioAdapter,
    private readonly youtubeApiAdapter: YouTubeApiAdapter,
    private readonly webhookAdapter: WebhookAdapter,
  ) {}

  setChannelBusyGuard(check: (channelId: string) => boolean): void {
    this.channelBusyCheck = check;
  }

  async runSingleJob(job: PublishJob, options: WorkerRunOptions = {}): Promise<ExecutionResult> {
    const channel = this.store.getChannel(job.channelId);
    if (!channel) {
      return { status: "failed", message: `Unknown channel '${job.channelId}'.` };
    }
    const busyFn = options.isChannelBusy ?? this.channelBusyCheck;
    if (busyFn?.(channel.id)) {
      return {
        status: "queued",
        message: `Skipped because Live Browser is currently active on '${channel.id}'.`,
      };
    }
    const connection = channel.connections.find(c => c.platform === job.platform && c.enabled);
    if (!connection) {
      return { status: "failed", message: `Connection '${job.platform}' missing or disabled on '${channel.id}'.` };
    }

    console.log(
      `[worker] ${options.dryRun ? "dry-run" : "start"} channel=${channel.id} platform=${job.platform} episode=${job.episode} job=${job.id}`,
    );

    const integrity = await this.store.verifyMediaIntegrity(job);
    if (!integrity.ok) {
      const finishedAt = new Date().toISOString();
      const updated: PublishJob = {
        ...job,
        status: "failed",
        lastError: integrity.reason,
        attemptsCount: job.attemptsCount + 1,
        updatedAt: finishedAt,
      };
      this.store.saveJob(updated);
      this.store.recordAttempt({
        jobId: job.id,
        adapter: job.adapter,
        startedAt: finishedAt,
        finishedAt,
        outcome: "failed",
        message: integrity.reason ?? "Integrity failure",
      });
      return { status: "failed", message: integrity.reason ?? "Integrity check failed" };
    }

    const preparedJob = applyChannelSignature(this.store, job);
    const startedAt = new Date().toISOString();
    if (!options.dryRun) {
      this.store.saveJob({
        ...preparedJob,
        status: "running",
        updatedAt: startedAt,
      });
    }

    let result: ExecutionResult;
    if (connection.adapter === "webhook") {
      result = await this.webhookAdapter.execute(preparedJob, channel, connection, options);
    } else if (connection.adapter === "youtube_api") {
      result = await this.youtubeApiAdapter.execute(preparedJob, channel, connection, options);
    } else if (connection.platform === "reddit" && this.store.getOAuthToken(channel.id, "reddit")) {
      result = await submitRedditPostViaOAuth(this.store, preparedJob, channel, Boolean(options.dryRun));
    } else {
      result = await this.edgeAdapter.execute(preparedJob, channel, connection, options);
    }

    const finishedAt = new Date().toISOString();
    const evidencePaths = result.screenshotFile
      ? Array.from(new Set([...job.evidencePaths, result.screenshotFile]))
      : job.evidencePaths;

    if (options.dryRun) {
      this.store.recordAttempt({
        jobId: job.id,
        adapter: connection.adapter,
        startedAt,
        finishedAt,
        outcome: "dry_run_ok",
        screenshotFile: result.screenshotFile,
        message: result.message,
      });
      return result;
    }

    const nextJob: PublishJob = {
      ...preparedJob,
      status: result.status,
      remoteId: result.remoteId ?? job.remoteId,
      remoteUrl: result.remoteUrl ?? job.remoteUrl,
      lastError: result.status === "scheduled" || result.status === "published" ? undefined : result.message,
      evidencePaths,
      attemptsCount: job.attemptsCount + 1,
      executedAt: finishedAt,
      updatedAt: finishedAt,
    };
    this.store.saveJob(nextJob);
    this.store.recordAttempt({
      jobId: job.id,
      adapter: connection.adapter,
      startedAt,
      finishedAt,
      outcome: result.status,
      remoteId: nextJob.remoteId,
      remoteUrl: nextJob.remoteUrl,
      screenshotFile: result.screenshotFile,
      message: result.message,
    });

    applyPostPublishAutomations(this.store, nextJob);
    await dispatchWebhookEvent(this.store, `job.${nextJob.status}`, {
      jobId: nextJob.id,
      channelId: nextJob.channelId,
      platform: nextJob.platform,
      title: nextJob.title,
      remoteUrl: nextJob.remoteUrl,
      message: result.message,
    }).catch(() => {});

    console.log(
      `[worker] done channel=${nextJob.channelId} platform=${nextJob.platform} job=${nextJob.id} status=${nextJob.status} msg=${JSON.stringify(result.message)}`,
    );

    return result;
  }

  async runDueJobs(options: WorkerRunOptions = {}): Promise<Array<{ jobId: string; platform: string; result: ExecutionResult }>> {
    const busyFn = options.isChannelBusy ?? this.channelBusyCheck;
    const runnable = this.store
      .listRunnableJobs(options.nowIso, {
        channelId: options.channelId,
        platform: options.platform,
        jobId: options.jobId,
      })
      .filter(job => !busyFn?.(job.channelId));
    const limited = options.limit && options.limit > 0 ? runnable.slice(0, options.limit) : runnable;
    const results: Array<{ jobId: string; platform: string; result: ExecutionResult }> = [];
    for (const job of limited) {
      const result = await this.runSingleJob(job, options);
      results.push({ jobId: job.id, platform: job.platform, result });
    }
    return results;
  }
}
