import type { VesperaStore } from "../db.js";
import type { VideoIntelligenceReport } from "../types.js";

function normalizeTitleKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function classifyTitleStyle(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  if (title.includes("?")) return "Question Hook";
  if (/\b\d+\b/.test(title)) return "Number / Specific Date Hook";
  if (words <= 7) return "Ultra-Short Punch (<=7 words)";
  if (words <= 11) return "Tight Narrative (8-11 words)";
  return "Long Descriptive (12+ words)";
}

export function buildVideoIntelligence(
  store: VesperaStore,
  filters?: { channelId?: string; platform?: string },
): VideoIntelligenceReport {
  const now = new Date().toISOString();
  const snapshots = store.listLatestChannelSnapshots(filters?.channelId);
  const filteredSnaps = filters?.platform ? snapshots.filter(s => s.platform === filters.platform) : snapshots;
  const metrics = store.listVideoMetrics(filters);
  const jobs = store.listJobs({ channelId: filters?.channelId });
  const channels = filters?.channelId
    ? store.listChannels().filter(c => c.id === filters.channelId)
    : store.listChannels();

  const platformMap = new Map<
    string,
    { followers: number; views: number; videos: number; engSum: number; engCount: number; lastCapturedAt?: string }
  >();

  for (const snap of filteredSnaps) {
    const entry = platformMap.get(snap.platform) ?? { followers: 0, views: 0, videos: 0, engSum: 0, engCount: 0 };
    entry.followers += snap.followers ?? 0;
    entry.views += snap.totalViews ?? 0;
    entry.videos += snap.totalVideos ?? 0;
    if (!entry.lastCapturedAt || snap.capturedAt > entry.lastCapturedAt) {
      entry.lastCapturedAt = snap.capturedAt;
    }
    platformMap.set(snap.platform, entry);
  }

  for (const video of metrics) {
    const entry = platformMap.get(video.platform) ?? { followers: 0, views: 0, videos: 0, engSum: 0, engCount: 0 };
    if (!filteredSnaps.some(s => s.platform === video.platform && (s.totalViews ?? 0) > 0)) {
      entry.views += video.views;
    }
    if (!filteredSnaps.some(s => s.platform === video.platform && (s.totalVideos ?? 0) > 0)) {
      entry.videos += 1;
    }
    entry.engSum += video.engagementRate;
    entry.engCount += 1;
    platformMap.set(video.platform, entry);
  }

  const platformBreakdown = Array.from(platformMap.entries())
    .map(([platform, data]) => ({
      platform,
      followers: data.followers,
      views: data.views,
      videos: data.videos,
      avgEngagementRate: data.engCount > 0 ? Number((data.engSum / data.engCount).toFixed(2)) : 0,
      lastCapturedAt: data.lastCapturedAt,
    }))
    .sort((a, b) => b.views - a.views);

  const totalViewsFromSnaps = platformBreakdown.reduce((sum, p) => sum + p.views, 0);
  const totalFollowers = platformBreakdown.reduce((sum, p) => sum + p.followers, 0);
  const avgEngagementRate = metrics.length > 0
    ? Number((metrics.reduce((sum, m) => sum + m.engagementRate, 0) / metrics.length).toFixed(2))
    : 0;

  const jobByTitle = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) {
    if (j.coverPath) {
      jobByTitle.set(`${j.channelId}:${normalizeTitleKey(j.title)}`, j);
    }
  }

  const topVideos = metrics.slice(0, 15).map(m => {
    const matched = jobByTitle.get(`${m.channelId}:${normalizeTitleKey(m.title)}`);
    return {
      ...m,
      coverAvailable: Boolean(matched?.coverPath),
      matchedJobId: matched?.id,
    };
  });

  const bucketMap = new Map<string, { count: number; views: number; engSum: number }>();
  for (const m of metrics) {
    const bucket = classifyTitleStyle(m.title);
    const cur = bucketMap.get(bucket) ?? { count: 0, views: 0, engSum: 0 };
    cur.count += 1;
    cur.views += m.views;
    cur.engSum += m.engagementRate;
    bucketMap.set(bucket, cur);
  }

  const titleInsights = Array.from(bucketMap.entries())
    .map(([bucket, cur]) => ({
      bucket,
      count: cur.count,
      avgViews: Math.round(cur.views / Math.max(cur.count, 1)),
      avgEngagementRate: Number((cur.engSum / Math.max(cur.count, 1)).toFixed(2)),
    }))
    .sort((a, b) => b.avgViews - a.avgViews);

  // Detect videos scheduled/published on some enabled platforms for a channel but missing others.
  const enabledPlatformsByChannel = new Map<string, string[]>();
  for (const ch of channels) {
    enabledPlatformsByChannel.set(
      ch.id,
      ch.connections.filter(c => c.enabled).map(c => c.platform),
    );
  }

  const videoGroup = new Map<string, { channelId: string; videoId: string; title: string; presentOn: Set<string> }>();
  for (const j of jobs) {
    const key = `${j.channelId}:${j.videoId}`;
    const entry = videoGroup.get(key) ?? {
      channelId: j.channelId,
      videoId: j.videoId,
      title: j.title,
      presentOn: new Set<string>(),
    };
    if (j.status === "published" || j.status === "scheduled" || j.status === "queued") {
      entry.presentOn.add(j.platform);
    }
    videoGroup.set(key, entry);
  }

  const crossPlatformGaps = Array.from(videoGroup.values())
    .map(g => {
      const targetPlatforms = enabledPlatformsByChannel.get(g.channelId) ?? [];
      const missing = targetPlatforms.filter(p => !g.presentOn.has(p));
      return {
        videoId: g.videoId,
        title: g.title,
        channelId: g.channelId,
        presentOn: Array.from(g.presentOn),
        missingOn: missing,
      };
    })
    .filter(g => g.missingOn.length > 0)
    .slice(0, 12);

  const takeaways: string[] = [];
  const hasLiveData = filteredSnaps.length > 0 || metrics.length > 0;
  if (!hasLiveData) {
    takeaways.push("No live analytics synced yet. Click 'Sync Live Analytics' or run `npm run sync-analytics` to collect real channel and video stats.");
  } else {
    if (platformBreakdown.length > 0) {
      const lead = platformBreakdown[0];
      takeaways.push(`${lead.platform.toUpperCase()} leads total reach with ${lead.views.toLocaleString()} views across ${lead.followers.toLocaleString()} followers.`);
    }
    if (topVideos.length > 0) {
      const best = topVideos[0];
      takeaways.push(`Top video: "${best.title}" (${best.platform}) at ${best.views.toLocaleString()} views and ${best.engagementRate}% engagement.`);
    }
    if (titleInsights.length > 1) {
      const winner = titleInsights[0];
      takeaways.push(`Strongest title pattern so far: ${winner.bucket} (${winner.avgViews.toLocaleString()} avg views across ${winner.count} videos).`);
    }
  }
  if (crossPlatformGaps.length > 0) {
    takeaways.push(`${crossPlatformGaps.length} queued/published video items are missing at least one enabled platform for their workspace.`);
  }

  const briefLines = [
    "# Vespera Video Intelligence Brief",
    `Generated: ${now}`,
    "",
    "## Performance Snapshot",
    `- Tracked Videos: ${metrics.length}`,
    `- Total Views (Synced): ${totalViewsFromSnaps.toLocaleString()}`,
    `- Total Followers (Synced): ${totalFollowers.toLocaleString()}`,
    `- Avg Engagement Rate: ${avgEngagementRate}%`,
    "",
    "## Platform Breakdown",
    ...(platformBreakdown.length > 0
      ? platformBreakdown.map(p => `- ${p.platform}: ${p.followers.toLocaleString()} followers, ${p.views.toLocaleString()} views, ${p.videos} videos, ${p.avgEngagementRate}% avg engagement`)
      : ["- No live analytics captured yet."]),
    "",
    "## Key Takeaways for Next Videos",
    ...takeaways.map(t => `- ${t}`),
    "",
    ...(topVideos.length > 0
      ? [
          "## Top Performing Videos",
          ...topVideos.slice(0, 5).map(v => `- [${v.platform}] ${v.title}: ${v.views.toLocaleString()} views, ${v.likes.toLocaleString()} likes, ${v.comments.toLocaleString()} comments (${v.engagementRate}% engagement)`),
        ]
      : []),
  ];

  return {
    generatedAt: now,
    hasLiveData,
    summary: {
      trackedVideos: metrics.length,
      totalViews: totalViewsFromSnaps,
      totalFollowers,
      avgEngagementRate,
      topPlatform: platformBreakdown[0]?.platform,
    },
    platformBreakdown,
    topVideos,
    titleInsights,
    crossPlatformGaps,
    takeaways,
    markdownBrief: briefLines.join("\n"),
  };
}
