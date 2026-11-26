import { signWebhookPayload } from "../adapters/webhook.js";
import type { VesperaStore } from "../db.js";
import type { PublishJob, RssFeedRecord } from "../types.js";

export interface ParsedFeedItem {
  guid: string;
  title: string;
  link?: string;
  summary?: string;
  publishedAt?: string;
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = regex.exec(block);
  return m ? decodeXmlEntities(m[1]) : undefined;
}

export function parseRssOrAtomXml(xml: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = [];
  const rssMatches = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi));
  for (const m of rssMatches) {
    const block = m[0];
    const title = extractTag(block, "title") ?? "Untitled RSS Item";
    const link = extractTag(block, "link");
    const guid = extractTag(block, "guid") ?? link ?? title;
    const summary = extractTag(block, "description") ?? extractTag(block, "content:encoded");
    const publishedAt = extractTag(block, "pubDate");
    items.push({ guid, title, link, summary, publishedAt });
  }
  if (items.length > 0) return items;

  const atomMatches = Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi));
  for (const m of atomMatches) {
    const block = m[0];
    const title = extractTag(block, "title") ?? "Untitled Entry";
    const linkAttr = /<link[^>]+href=["']([^"']+)["']/i.exec(block)?.[1];
    const link = linkAttr ?? extractTag(block, "link");
    const guid = extractTag(block, "id") ?? link ?? title;
    const summary = extractTag(block, "summary") ?? extractTag(block, "content");
    const publishedAt = extractTag(block, "updated") ?? extractTag(block, "published");
    items.push({ guid, title, link, summary, publishedAt });
  }
  return items;
}

export async function syncRssFeed(
  store: VesperaStore,
  feed: RssFeedRecord,
): Promise<{ feedId: string; queued: number; itemsSeen: number; error?: string }> {
  const now = new Date().toISOString();
  try {
    const res = await fetch(feed.feedUrl, { headers: { "User-Agent": "Vespera/1.0" } });
    if (!res.ok) {
      const err = `RSS fetch failed: HTTP ${res.status}`;
      store.updateRssFeedSync(feed.id, { lastCheckedAt: now, lastError: err });
      return { feedId: feed.id, queued: 0, itemsSeen: 0, error: err };
    }
    const xml = await res.text();
    const items = parseRssOrAtomXml(xml);
    let queued = 0;
    const targetDate = now.slice(0, 10);

    for (const item of items.slice(0, 3)) {
      if (item.guid === feed.lastGuid) break;
      for (const platform of feed.platforms) {
        const key = `rss:${feed.id}:${item.guid}:${platform}`;
        const copy = [item.title, item.summary?.slice(0, 180), item.link].filter(Boolean).join("\n\n");
        const created = store.enqueueJob({
          idempotencyKey: key,
          channelId: feed.channelId,
          videoId: `rss-${Buffer.from(item.guid).toString("hex").slice(0, 12)}`,
          title: item.title.slice(0, 100),
          platform,
          targetDate,
          publishAt: `${targetDate}T${feed.defaultTime}:00`,
          publishNowIfPastSlot: false,
          status: feed.autoPublish ? "queued" : "draft",
          payload: {
            title: item.title.slice(0, 100),
            description: copy,
            caption: copy,
            postText: copy.slice(0, 280),
          },
        });
        if (created.created) queued += 1;
      }
    }

    store.updateRssFeedSync(feed.id, {
      lastCheckedAt: now,
      lastGuid: items[0]?.guid ?? feed.lastGuid,
      lastError: null,
    });
    return { feedId: feed.id, queued, itemsSeen: items.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.updateRssFeedSync(feed.id, { lastCheckedAt: now, lastError: msg });
    return { feedId: feed.id, queued: 0, itemsSeen: 0, error: msg };
  }
}

export async function dispatchWebhookEvent(
  store: VesperaStore,
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const hooks = store
    .listWebhooks()
    .filter(w => w.enabled && (w.events.includes(event) || w.events.includes("*")));
  let sent = 0;

  for (const hook of hooks) {
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
    const sig = signWebhookPayload(hook.secret, body);
    const deliveredAt = new Date().toISOString();
    try {
      const res = await fetch(hook.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vespera-Event": event,
          "X-Vespera-Signature": sig,
        },
        body,
      });
      const text = (await res.text().catch(() => "")).slice(0, 240);
      store.recordWebhookDelivery({
        webhookId: hook.id,
        event,
        payloadJson: body,
        responseStatus: res.status,
        responseBody: text,
        deliveredAt,
      });
      sent += 1;
    } catch (err) {
      store.recordWebhookDelivery({
        webhookId: hook.id,
        event,
        payloadJson: body,
        responseStatus: 0,
        responseBody: err instanceof Error ? err.message : String(err),
        deliveredAt,
      });
    }
  }
  return sent;
}

export function applyChannelSignature(store: VesperaStore, job: PublishJob): PublishJob {
  const signatures = store.listSignatures();
  const explicitSig = job.payload.signatureId
    ? signatures.find(s => s.id === job.payload.signatureId)
    : undefined;
  const autoSig =
    explicitSig
    ?? signatures.find(
      s =>
        s.autoAppend
        && (!s.channelId || s.channelId === job.channelId)
        && (!s.platform || s.platform === job.platform),
    );
  if (!autoSig) return job;

  const marker = autoSig.body.trim();
  if (!marker) return job;
  const baseDesc = job.payload.description ?? job.payload.caption ?? job.title;
  if (baseDesc.includes(marker)) return job;

  return {
    ...job,
    payload: {
      ...job.payload,
      description: job.payload.description ? `${job.payload.description}\n\n${marker}` : `${baseDesc}\n\n${marker}`,
      caption: job.payload.caption ? `${job.payload.caption}\n\n${marker}` : undefined,
      postText: job.payload.postText
        ? `${job.payload.postText}\n\n${marker}`.slice(0, 280)
        : undefined,
    },
  };
}

export function applyPostPublishAutomations(store: VesperaStore, job: PublishJob): void {
  if (job.status !== "published" && job.status !== "scheduled") return;

  // Schedule delayed first comment if requested directly on the job payload.
  if (job.payload.followUpComment && (job.payload.delayCommentMinutes ?? 0) > 0) {
    const dueMs = Date.now() + (job.payload.delayCommentMinutes ?? 5) * 60_000;
    store.enqueueFollowUpComment({
      jobId: job.id,
      channelId: job.channelId,
      platform: job.platform,
      commentText: job.payload.followUpComment,
      dueAt: new Date(dueMs).toISOString(),
    });
  }

  // Evaluate enabled on_publish automation plugs matching this channel (or global scope).
  const matchingPlugs = store
    .listPlugs()
    .filter(
      p =>
        p.enabled &&
        p.triggerType === "on_publish" &&
        (p.scope === "global" || !p.channelId || p.channelId === job.channelId),
    );
  for (const plug of matchingPlugs) {
    const allowedPlatforms = Array.isArray(plug.config?.platforms)
      ? plug.config.platforms.map(String)
      : undefined;
    if (allowedPlatforms && allowedPlatforms.length > 0 && !allowedPlatforms.includes(job.platform)) {
      continue;
    }

    if (plug.actionType === "follow_up_comment") {
      const comment = typeof plug.config?.comment === "string" ? plug.config.comment.trim() : "";
      if (comment) {
        const delayMinutes =
          typeof plug.config?.delayMinutes === "number" && Number.isFinite(plug.config.delayMinutes)
            ? Math.max(0, plug.config.delayMinutes)
            : 5;
        store.enqueueFollowUpComment({
          jobId: job.id,
          channelId: job.channelId,
          platform: job.platform,
          commentText: comment,
          dueAt: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        });
        store.incrementPlugRun(plug.id);
      }
    } else if (plug.actionType === "webhook_notify") {
      store.incrementPlugRun(plug.id);
      void dispatchWebhookEvent(store, "plug.triggered", {
        plugId: plug.id,
        plugName: plug.name,
        jobId: job.id,
        channelId: job.channelId,
        platform: job.platform,
        title: job.title,
        remoteUrl: job.remoteUrl,
      }).catch(() => {});
    }
  }

  // Clone next evergreen repeat slot if configured.
  const repeatDays = job.payload.repeatIntervalDays ?? 0;
  const count = job.payload.repeatCount ?? 0;
  const maxRepeats = job.payload.repeatMax ?? 0;
  if (repeatDays > 0 && (maxRepeats === 0 || count < maxRepeats)) {
    const nextDate = new Date(Date.parse(job.publishAt) + repeatDays * 86_400_000);
    if (Number.isFinite(nextDate.getTime())) {
      const targetDate = nextDate.toISOString().slice(0, 10);
      store.enqueueJob({
        idempotencyKey: `${job.idempotencyKey}:repeat:${count + 1}`,
        channelId: job.channelId,
        videoId: job.videoId,
        currentVersionId: job.currentVersionId,
        episode: job.episode,
        title: job.title,
        platform: job.platform,
        handle: job.handle,
        adapter: job.adapter,
        targetDate,
        publishAt: nextDate.toISOString(),
        publishNowIfPastSlot: false,
        videoPath: job.videoPath,
        videoSha256: job.videoSha256,
        videoBytes: job.videoBytes,
        coverPath: job.coverPath,
        coverSha256: job.coverSha256,
        payload: {
          ...job.payload,
          repeatCount: count + 1,
        },
      });
    }
  }
}
