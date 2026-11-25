import { Check, Copy, ExternalLink, RefreshCw, Sparkles, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import { api, copyTextSafely } from "../api";
import type { BootstrapPayload, PlatformDefinition } from "../types";
import { PlatformBadge } from "./PlatformPill";
import type { NotifyFn } from "./ToastStack";

interface Props {
  data: BootstrapPayload;
  activeChannelId: string;
  onSelectChannel: (channelId: string) => void;
  onNotify: NotifyFn;
  onRefresh: () => Promise<void>;
}

export function AnalyticsView({ data, activeChannelId, onSelectChannel, onNotify, onRefresh }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);

  const report = data.analytics.intelligence;
  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data.platforms) map.set(p.id, p);
    return map;
  }, [data.platforms]);

  const visibleSnapshots = useMemo(() => {
    return data.analytics.snapshots.filter(s => activeChannelId === "all" || s.channelId === activeChannelId);
  }, [data.analytics.snapshots, activeChannelId]);

  const visibleVideos = useMemo(() => {
    return report.topVideos.filter(v => activeChannelId === "all" || v.channelId === activeChannelId);
  }, [report.topVideos, activeChannelId]);

  const maxViews = Math.max(1, ...report.platformBreakdown.map(p => p.views));

  async function handleSyncAnalytics() {
    setSyncing(true);
    try {
      const res = await api.post<{ ok: boolean; snapshots: unknown[]; videosUpserted: number }>("/api/analytics/sync", {
        channelId: activeChannelId === "all" ? undefined : activeChannelId,
      });
      await onRefresh();
      onNotify("success", `Synced ${res.snapshots.length} channel snapshots and ${res.videosUpserted} video rows.`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleCopyBrief() {
    const ok = await copyTextSafely(report.markdownBrief);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      onNotify("success", "Copied Video Intelligence brief to clipboard.");
    } else {
      onNotify("error", "Clipboard write failed in this browser context.");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            aria-label="Filter analytics by workspace"
            value={activeChannelId}
            onChange={e => onSelectChannel(e.target.value)}
            className="vsp-input rounded-lg px-3 py-1.5 text-xs"
          >
            <option value="all">All Workspaces</option>
            {data.channels.map(ch => (
              <option key={ch.id} value={ch.id}>{ch.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopyBrief}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)]"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied Agent Brief" : "Copy Agent Brief"}
          </button>
          <button
            type="button"
            disabled={syncing}
            onClick={handleSyncAnalytics}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync Live Analytics"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="vsp-card rounded-xl px-4 py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Total Views</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{report.summary.totalViews.toLocaleString()}</div>
        </div>
        <div className="vsp-card rounded-xl px-4 py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Total Followers</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{report.summary.totalFollowers.toLocaleString()}</div>
        </div>
        <div className="vsp-card rounded-xl px-4 py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Avg Engagement</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-400">{report.summary.avgEngagementRate}%</div>
        </div>
        <div className="vsp-card rounded-xl px-4 py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Tracked Videos</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-sky-400">{report.summary.trackedVideos}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="vsp-card rounded-xl p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="h-4 w-4 text-[var(--accent-primary)]" />
              Platform Reach Comparison
            </h3>
            <span className="text-[11px] text-[var(--text-muted)]">Real synced SQLite snapshots</span>
          </div>

          {report.platformBreakdown.length === 0 ? (
            <div className="flex h-44 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] px-6 text-center">
              <p className="text-xs font-medium text-[var(--text-secondary)]">No platform metrics synced yet.</p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Click Sync Live Analytics to collect follower counts, views, and video engagement directly from your connected accounts.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {report.platformBreakdown.map(p => {
                const pDef = platformById.get(p.platform);
                const pct = Math.max(4, Math.round((p.views / maxViews) * 100));
                return (
                  <div key={p.platform} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <PlatformBadge platformId={p.platform} platform={pDef} size="xs" />
                        <span className="font-medium">{pDef?.name ?? p.platform}</span>
                        <span className="text-[11px] text-[var(--text-muted)] font-mono-num">
                          {p.followers.toLocaleString()} followers · {p.videos} videos
                        </span>
                      </div>
                      <span className="font-mono-num font-semibold">{p.views.toLocaleString()} views ({p.avgEngagementRate}%)</span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: pDef?.accentHex ?? "#6366F1",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="vsp-card rounded-xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-[var(--accent-primary)]" />
            Video Intelligence Brief
          </h3>
          <ul className="space-y-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {report.takeaways.map((t, idx) => (
              <li key={idx} className="vsp-subcard rounded-lg px-3 py-2">
                {t}
              </li>
            ))}
          </ul>

          {report.titleInsights.length > 0 && (
            <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Title & Hook Performance
              </div>
              <div className="space-y-1.5 text-xs">
                {report.titleInsights.map(ti => (
                  <div key={ti.bucket} className="flex items-center justify-between">
                    <span className="text-[var(--text-secondary)]">{ti.bucket} ({ti.count})</span>
                    <span className="font-mono-num font-semibold">{ti.avgViews.toLocaleString()} avg</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {visibleSnapshots.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {visibleSnapshots.map(snap => {
            const pDef = platformById.get(snap.platform);
            return (
              <div key={snap.id} className="vsp-card rounded-xl p-3.5 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PlatformBadge platformId={snap.platform} platform={pDef} size="sm" />
                    <span className="font-semibold">{snap.channelId}</span>
                  </div>
                  <span className="font-mono-num text-[10px] text-[var(--text-muted)]">{snap.capturedAt.slice(0, 10)}</span>
                </div>
                <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono-num">
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">Followers</div>
                    <div className="font-semibold">{snap.followers !== undefined ? snap.followers.toLocaleString() : "n/a"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">Views</div>
                    <div className="font-semibold">{snap.totalViews !== undefined ? snap.totalViews.toLocaleString() : "n/a"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">Videos</div>
                    <div className="font-semibold">{snap.totalVideos !== undefined ? snap.totalVideos.toLocaleString() : "n/a"}</div>
                  </div>
                </div>
                {snap.note && <p className="mt-2 truncate text-[11px] text-[var(--text-muted)]" title={snap.note}>{snap.note}</p>}
              </div>
            );
          })}
        </div>
      )}

      <div className="vsp-card overflow-hidden rounded-xl">
        <div className="border-b border-[var(--border-subtle)] px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Top Performing Videos</h3>
          <span className="text-[11px] text-[var(--text-muted)]">{visibleVideos.length} tracked rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                <th className="px-4 py-2.5">Video</th>
                <th className="px-3 py-2.5">Platform</th>
                <th className="px-3 py-2.5 text-right">Views</th>
                <th className="px-3 py-2.5 text-right">Likes</th>
                <th className="px-3 py-2.5 text-right">Comments</th>
                <th className="px-3 py-2.5 text-right">Engagement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {visibleVideos.map(v => (
                <tr key={v.id} className="hover:bg-[var(--bg-hover)]">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      {v.coverAvailable && v.matchedJobId && (
                        <img
                          src={`/api/media/thumb/${v.matchedJobId}`}
                          alt=""
                          className="h-9 w-6 rounded object-cover border border-[var(--border-subtle)]"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium max-w-[360px]">{v.title}</div>
                        <div className="text-[11px] text-[var(--text-muted)]">{v.channelId}</div>
                      </div>
                      {v.url && (
                        <a href={v.url} target="_blank" rel="noreferrer" className="text-[var(--accent-primary)]" aria-label="Open remote video">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <PlatformBadge platformId={v.platform} platform={platformById.get(v.platform)} size="xs" />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono-num font-semibold">{v.views.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{v.likes.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{v.comments.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num text-emerald-400">{v.engagementRate}%</td>
                </tr>
              ))}
              {visibleVideos.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No synced video metrics yet. Run Sync Live Analytics above once accounts are signed in.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {report.crossPlatformGaps.length > 0 && (
        <div className="vsp-card rounded-xl p-4">
          <h3 className="mb-2 text-sm font-semibold">Cross-Platform Coverage Gaps ({report.crossPlatformGaps.length})</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {report.crossPlatformGaps.slice(0, 6).map(gap => (
              <div key={`${gap.channelId}:${gap.videoId}`} className="vsp-subcard rounded-lg p-3 text-xs">
                <div className="truncate font-medium">{gap.title}</div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Missing on: <span className="font-semibold text-amber-400">{gap.missingOn.join(", ")}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
