import type { Page } from "playwright";
import { detectAuthOrChallengeSnapshot, launchChannelEdge, normalizeHandle } from "../adapters/edge-studio.js";
import type { VesperaStore } from "../db.js";
import type { ChannelAnalyticsSnapshot, ChannelConfig, ChannelConnection } from "../types.js";

export function parseCompactMetric(raw?: string | null): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/,/g, "");
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/i.exec(cleaned);
  if (!match) {
    const digitsOnly = cleaned.replace(/[^0-9]/g, "");
    if (!digitsOnly) return undefined;
    const n = Number(digitsOnly);
    return Number.isFinite(n) ? n : undefined;
  }
  const value = Number(match[1]);
  const suffix = (match[2] ?? "").toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Math.round(value * multiplier);
}

async function scrapeYouTubeAnalytics(
  page: Page,
  channel: ChannelConfig,
  conn: ChannelConnection,
  store: VesperaStore,
): Promise<{ snapshot: ChannelAnalyticsSnapshot; videosUpserted: number }> {
  const capturedAt = new Date().toISOString();
  await page.goto("https://studio.youtube.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator("ytcp-entity-page, #create-icon, ytcp-home-page").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1800);

  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 10_000);
  const auth = detectAuthOrChallengeSnapshot(page.url(), bodyText, "youtube");
  if (auth.status !== "signed_in") {
    return {
      snapshot: store.recordChannelSnapshot({
        channelId: channel.id,
        platform: "youtube",
        capturedAt,
        note: auth.reason ?? "YouTube Studio not signed in",
        rawJson: { url: page.url(), status: auth.status },
      }),
      videosUpserted: 0,
    };
  }

  const subMatch = /current subscribers[\s\S]{0,60}?([0-9][0-9,.KMB]*)/i.exec(bodyText)
    ?? /([0-9][0-9,.KMB]*)\s+subscribers/i.exec(bodyText);
  const viewSummaryMatch = /summary[\s\S]{0,60}?views\s+([0-9][0-9,.KMB]*)/i.exec(bodyText);

  // Navigate to Content -> Shorts / Videos table inside Studio to capture real per-video rows
  const currentUrl = page.url();
  const chanMatch = /studio\.youtube\.com\/channel\/([^/]+)/i.exec(currentUrl);
  if (chanMatch) {
    await page.goto(`https://studio.youtube.com/channel/${chanMatch[1]}/videos/short`, {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    }).catch(() => {});
    await page.locator("ytcp-video-row, #video-title").first().waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const rows = await page.evaluate(() => {
    const items: Array<{ id: string; title: string; url?: string; views: string; comments: string; likes: string }> = [];
    const tableRows = Array.from(document.querySelectorAll("ytcp-video-row"));
    for (const row of tableRows.slice(0, 20)) {
      const titleEl = row.querySelector("#video-title");
      const linkEl = row.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
      const href = linkEl?.getAttribute("href") ?? "";
      const idMatch = /\/video\/([^/]+)/.exec(href);
      const id = idMatch ? idMatch[1] : (titleEl?.textContent?.trim() ?? "");
      const title = titleEl?.textContent?.trim() ?? "";
      if (!title) continue;
      const viewsCell = row.querySelector('[class*="tablecell-views"], #views-column');
      const commentsCell = row.querySelector('[class*="tablecell-comments"], #comments-column');
      const likesCell = row.querySelector('[class*="tablecell-likes"]');
      const numericCellText = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim().split(" ")[0] || "0";
      const allBodies = Array.from(row.querySelectorAll(".cell-body, .tablecell-views, .tablecell-comments")).map(e => e.textContent?.trim() ?? "");
      const fallbackViews = allBodies.find(t => /^[0-9][0-9,.]*[KMB]?$/.test(t)) ?? "0";
      items.push({
        id,
        title,
        url: href ? `https://youtube.com/shorts/${id}` : undefined,
        views: viewsCell ? numericCellText(viewsCell) : fallbackViews,
        comments: commentsCell ? numericCellText(commentsCell) : "0",
        likes: likesCell ? numericCellText(likesCell) : "0",
      });
    }
    return items;
  }).catch(() => []);

  let videosUpserted = 0;
  let sumVideoViews = 0;
  for (const row of rows) {
    const views = parseCompactMetric(row.views) ?? 0;
    sumVideoViews += views;
    store.upsertVideoMetric({
      channelId: channel.id,
      platform: "youtube",
      remoteId: row.id,
      title: row.title,
      url: row.url,
      views,
      likes: parseCompactMetric(row.likes) ?? 0,
      comments: parseCompactMetric(row.comments) ?? 0,
      shares: 0,
      saves: 0,
      capturedAt,
    });
    videosUpserted += 1;
  }

  const followers = parseCompactMetric(subMatch?.[1]);
  const totalViews = parseCompactMetric(viewSummaryMatch?.[1]) ?? (sumVideoViews > 0 ? sumVideoViews : undefined);
  const snapshot = store.recordChannelSnapshot({
    channelId: channel.id,
    platform: "youtube",
    capturedAt,
    followers,
    totalViews,
    totalVideos: videosUpserted > 0 ? videosUpserted : undefined,
    note: `Synced via YouTube Studio (${conn.handle})`,
    rawJson: { url: page.url(), rowsFound: rows.length },
  });

  return { snapshot, videosUpserted };
}

async function scrapeTikTokAnalytics(
  page: Page,
  channel: ChannelConfig,
  conn: ChannelConnection,
  store: VesperaStore,
): Promise<{ snapshot: ChannelAnalyticsSnapshot; videosUpserted: number }> {
  const capturedAt = new Date().toISOString();
  await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);

  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 10_000);
  const auth = detectAuthOrChallengeSnapshot(page.url(), bodyText, "tiktok");
  if (auth.status !== "signed_in") {
    return {
      snapshot: store.recordChannelSnapshot({
        channelId: channel.id,
        platform: "tiktok",
        capturedAt,
        note: auth.reason ?? "TikTok Studio not signed in",
        rawJson: { url: page.url(), status: auth.status },
      }),
      videosUpserted: 0,
    };
  }

  const scrapedRows = await page.evaluate(() => {
    const out: Array<{ id: string; title: string; views: string; likes: string; comments: string; url?: string }> = [];
    const rows = Array.from(document.querySelectorAll("tr, [role='row']"));
    const seen = new Set<string>();
    for (const row of rows) {
      const link = row.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
      if (!link) continue;
      const m = /\/video\/(\d+)/.exec(link.href);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const title = (link.textContent?.trim() || `TikTok ${m[1]}`).slice(0, 120);
      const cells = Array.from(row.querySelectorAll("td, [role='cell'], [role='gridcell']"))
        .map(c => (c.textContent ?? "").replace(/\s+/g, " ").trim());
      // Extract pure count tokens from trailing metric cells only (ignoring title currency values and date strings).
      const pureCounts = cells
        .slice(1)
        .filter(c => /^[0-9][0-9,.]*[KMB]?$/.test(c));
      out.push({
        id: m[1],
        title,
        url: link.href,
        views: pureCounts[0] ?? "0",
        likes: pureCounts[1] ?? "0",
        comments: pureCounts[2] ?? "0",
      });
    }
    return out.slice(0, 20);
  }).catch(() => []);

  let videosUpserted = 0;
  let totalViews = 0;
  let totalLikes = 0;
  for (const row of scrapedRows) {
    const views = parseCompactMetric(row.views) ?? 0;
    const likes = parseCompactMetric(row.likes) ?? 0;
    const comments = parseCompactMetric(row.comments) ?? 0;
    totalViews += views;
    totalLikes += likes;
    store.upsertVideoMetric({
      channelId: channel.id,
      platform: "tiktok",
      remoteId: row.id,
      title: row.title,
      url: row.url,
      views,
      likes,
      comments,
      shares: 0,
      saves: 0,
      capturedAt,
    });
    videosUpserted += 1;
  }

  const handleSlug = normalizeHandle(conn.handle);
  let followers: number | undefined;
  if (handleSlug) {
    await page.goto(`https://www.tiktok.com/@${handleSlug}`, { waitUntil: "domcontentloaded", timeout: 35_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const profText = await page.locator("body").innerText().catch(() => "");
    const fMatch = /([0-9][0-9,.KMB]*)\s+Followers/i.exec(profText);
    followers = parseCompactMetric(fMatch?.[1]);
  }

  const snapshot = store.recordChannelSnapshot({
    channelId: channel.id,
    platform: "tiktok",
    capturedAt,
    followers,
    totalViews: videosUpserted > 0 ? totalViews : undefined,
    totalLikes: videosUpserted > 0 ? totalLikes : undefined,
    totalVideos: videosUpserted > 0 ? videosUpserted : undefined,
    note: `Synced via TikTok Studio (${conn.handle})`,
    rawJson: { rowsFound: scrapedRows.length },
  });

  return { snapshot, videosUpserted };
}

async function scrapeProfileSummary(
  page: Page,
  channel: ChannelConfig,
  conn: ChannelConnection,
  store: VesperaStore,
): Promise<{ snapshot: ChannelAnalyticsSnapshot; videosUpserted: number }> {
  const capturedAt = new Date().toISOString();
  const handleSlug = normalizeHandle(conn.handle);
  const urlMap: Record<string, string> = {
    x: handleSlug ? `https://x.com/${handleSlug}` : "https://x.com/home",
    instagram: handleSlug ? `https://www.instagram.com/${handleSlug}/` : "https://www.instagram.com/",
    threads: handleSlug ? `https://www.threads.net/@${handleSlug}` : "https://www.threads.net/",
    facebook: conn.customAnalyticsUrl ?? "https://business.facebook.com/",
    reddit: handleSlug ? `https://www.reddit.com/user/${handleSlug.replace(/^u\//, "")}` : "https://www.reddit.com/",
  };

  const targetUrl = conn.customAnalyticsUrl ?? urlMap[conn.platform];
  if (!targetUrl) {
    return {
      snapshot: store.recordChannelSnapshot({
        channelId: channel.id,
        platform: conn.platform,
        capturedAt,
        note: `No analytics URL configured for '${conn.platform}'.`,
        rawJson: {},
      }),
      videosUpserted: 0,
    };
  }

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForTimeout(2200);

  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 8000);
  const auth = detectAuthOrChallengeSnapshot(page.url(), bodyText, conn.platform);
  if (auth.status !== "signed_in") {
    return {
      snapshot: store.recordChannelSnapshot({
        channelId: channel.id,
        platform: conn.platform,
        capturedAt,
        note: auth.reason ?? `${conn.platform} not signed in`,
        rawJson: { url: page.url(), status: auth.status },
      }),
      videosUpserted: 0,
    };
  }

  const followersMatch = /([0-9][0-9,.KMB]*)\s+followers?/i.exec(bodyText);
  const postsMatch = /([0-9][0-9,.KMB]*)\s+posts?/i.exec(bodyText);
  const snapshot = store.recordChannelSnapshot({
    channelId: channel.id,
    platform: conn.platform,
    capturedAt,
    followers: parseCompactMetric(followersMatch?.[1]),
    totalVideos: parseCompactMetric(postsMatch?.[1]),
    note: `Synced profile summary (${conn.handle})`,
    rawJson: { url: page.url() },
  });

  return { snapshot, videosUpserted: 0 };
}

export async function collectChannelAnalytics(
  store: VesperaStore,
  options: { channelId?: string; platform?: string; headless?: boolean } = {},
): Promise<{ snapshots: ChannelAnalyticsSnapshot[]; videosUpserted: number }> {
  const channels = options.channelId
    ? store.listChannels().filter(c => c.id === options.channelId)
    : store.listChannels();

  const snapshots: ChannelAnalyticsSnapshot[] = [];
  let totalVideos = 0;

  for (const channel of channels) {
    const enabledConns = channel.connections.filter(
      c => c.enabled && (!options.platform || c.platform === options.platform),
    );
    if (enabledConns.length === 0) continue;

    // Use visible Edge when YouTube Studio is included so SPA metrics hydrate reliably.
    const needsVisible = options.headless === false || enabledConns.some(c => c.platform === "youtube");
    const ctx = await launchChannelEdge(channel.profileDir, !needsVisible);

    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      for (const conn of enabledConns) {
        if (conn.platform === "youtube") {
          const res = await scrapeYouTubeAnalytics(page, channel, conn, store);
          snapshots.push(res.snapshot);
          totalVideos += res.videosUpserted;
        } else if (conn.platform === "tiktok") {
          const res = await scrapeTikTokAnalytics(page, channel, conn, store);
          snapshots.push(res.snapshot);
          totalVideos += res.videosUpserted;
        } else {
          const res = await scrapeProfileSummary(page, channel, conn, store);
          snapshots.push(res.snapshot);
          totalVideos += res.videosUpserted;
        }
      }
    } finally {
      await ctx.close();
    }
  }

  return { snapshots, videosUpserted: totalVideos };
}
