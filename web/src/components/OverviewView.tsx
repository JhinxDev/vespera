import { ArrowUpRight, Film, Link2, Plus, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatTimeDisplay, statusColorClasses } from "../api";
import type { BootstrapPayload, ChannelConnection, LiveBrowserSession, PlatformDefinition, PublishJob } from "../types";
import { PlatformIcon } from "./PlatformIcon";
import type { NotifyFn } from "./ToastStack";

interface Props {
  data: BootstrapPayload;
  activeChannelId: string;
  onSelectChannel: (channelId: string) => void;
  onSelectJob: (job: PublishJob) => void;
  onOpenNewPost: (defaultDate?: string) => void;
  onOpenNewChannel: () => void;
  onNavigateChannels: () => void;
  onNavigateCalendar: () => void;
  onOpenLiveBrowser: (session: LiveBrowserSession) => void;
  onNotify: NotifyFn;
  onRefresh: () => Promise<void>;
}

const FEATURED_PLATFORMS = ["youtube", "tiktok", "instagram", "x", "facebook", "reddit"];

function jobUrgencyRank(status: PublishJob["status"]): number {
  switch (status) {
    case "needs_login":
    case "needs_human_action":
    case "failed":
      return 0;
    case "running":
      return 1;
    case "queued":
      return 2;
    case "scheduled":
      return 3;
    case "draft":
      return 4;
    case "published":
      return 5;
    case "cancelled":
      return 6;
    default:
      return 7;
  }
}

function statusDotClass(status: PublishJob["status"]): string {
  switch (status) {
    case "published":
      return "bg-emerald-400";
    case "scheduled":
      return "bg-sky-400";
    case "queued":
      return "bg-amber-400";
    case "running":
      return "bg-indigo-400";
    case "needs_login":
    case "needs_human_action":
    case "failed":
      return "bg-rose-500";
    default:
      return "bg-zinc-500";
  }
}

export function OverviewView({
  data,
  activeChannelId,
  onSelectChannel,
  onSelectJob,
  onOpenNewPost,
  onOpenNewChannel,
  onNavigateChannels,
  onNavigateCalendar,
  onOpenLiveBrowser,
  onNotify,
  onRefresh,
}: Props) {
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const pollTimersRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      for (const id of pollTimersRef.current) window.clearTimeout(id);
    };
  }, []);

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data.platforms) map.set(p.id, p);
    return map;
  }, [data.platforms]);

  const focusedChannel = useMemo(() => {
    if (activeChannelId !== "all") {
      return data.channels.find(c => c.id === activeChannelId) ?? data.channels[0];
    }
    return data.channels[0];
  }, [data.channels, activeChannelId]);

  const scopedJobs = useMemo(() => {
    return activeChannelId === "all"
      ? data.jobs
      : data.jobs.filter(j => j.channelId === activeChannelId);
  }, [data.jobs, activeChannelId]);

  // Build 7-day Publishing Overview cadence bars anchored on earliest or current target date
  const weekSeries = useMemo(() => {
    const dates = scopedJobs.map(j => j.targetDate).filter(Boolean).sort();
    const anchor = dates[0] ?? new Date().toISOString().slice(0, 10);
    const [y, m, d] = anchor.split("-").map(Number);

    return Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + i));
      const iso = dt.toISOString().slice(0, 10);
      const dayJobs = scopedJobs.filter(j => j.targetDate === iso);
      const published = dayJobs.filter(j => j.status === "published").length;
      const scheduled = dayJobs.filter(j => j.status === "scheduled" || j.status === "queued").length;
      return {
        iso,
        dow: dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
        label: dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        total: dayJobs.length,
        published,
        scheduled,
      };
    });
  }, [scopedJobs]);

  const maxBar = Math.max(1, ...weekSeries.map(d => d.total));
  const todayIso = new Date().toLocaleDateString("en-CA");
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(() => {
    const idx = weekSeries.findIndex(d => d.iso === todayIso);
    return idx >= 0 ? idx : 0;
  });
  const activeBar = weekSeries[selectedDayIdx] ?? weekSeries[0];

  // Connected Platforms sub-cards (My Wallet aesthetic) from focused workspace
  const walletCards = useMemo(() => {
    const conns = focusedChannel?.connections ?? [];
    const byPlat = new Map<string, ChannelConnection>();
    for (const c of conns) byPlat.set(c.platform, c);

    return FEATURED_PLATFORMS.map(pid => {
      const conn = byPlat.get(pid);
      const def = platformById.get(pid);
      return { pid, def, conn };
    });
  }, [focusedChannel, platformById]);

  // Group Upcoming Releases cleanly into unique episodes, prioritizing actionable episodes over already-published ones
  const upcomingEpisodes = useMemo(() => {
    const ordered = [...scopedJobs].sort((a, b) => a.publishAt.localeCompare(b.publishAt));
    const groups = new Map<
      string,
      {
        key: string;
        primaryJob: PublishJob;
        jobs: PublishJob[];
      }
    >();
    for (const j of ordered) {
      const key = `${j.channelId}:${j.targetDate}:${j.episode || j.videoId || j.title}`;
      const existing = groups.get(key);
      if (existing) {
        existing.jobs.push(j);
      } else {
        groups.set(key, { key, primaryJob: j, jobs: [j] });
      }
    }
    const actionableRank = (jobs: PublishJob[]) => {
      const allDone = jobs.every(j => j.status === "published" || j.status === "cancelled");
      return allDone ? 1 : 0;
    };
    return Array.from(groups.values())
      .map(group => {
        const sortedJobs = [...group.jobs].sort((a, b) => jobUrgencyRank(a.status) - jobUrgencyRank(b.status));
        return {
          ...group,
          primaryJob: sortedJobs[0] ?? group.primaryJob,
        };
      })
      .sort((a, b) => {
        const ra = actionableRank(a.jobs);
        const rb = actionableRank(b.jobs);
        if (ra !== rb) return ra - rb;
        return a.primaryJob.publishAt.localeCompare(b.primaryJob.publishAt);
      })
      .slice(0, 5);
  }, [scopedJobs]);

  const intel = data.analytics.intelligence;
  const hasViews = intel.summary.totalViews > 0;
  const publishedCount = data.summary.jobsByStatus.published ?? 0;
  const scheduledCount = (data.summary.jobsByStatus.scheduled ?? 0) + (data.summary.jobsByStatus.queued ?? 0);

  async function handleQuickConnect(channelId: string, platform: string) {
    setConnectBusy(`${channelId}:${platform}`);
    try {
      const res = await api.post<{
        ok: boolean;
        mode?: string;
        oauthUrl?: string;
        command?: string;
        url: string;
        session?: LiveBrowserSession;
      }>(`/api/channels/${channelId}/connect`, { platform });
      if (res.oauthUrl) {
        window.location.href = res.oauthUrl;
        return;
      }
      if (res.mode === "live_browser" && res.session) {
        onOpenLiveBrowser(res.session);
        await onRefresh();
        return;
      }
      await onRefresh();
      onNotify(
        "info",
        res.mode === "local_sync" && res.command
          ? `Server container mode: run "${res.command}" on your PC to sign in with fast native Edge and sync the session.`
          : `Opened Edge Connect for ${platform} (${channelId}). Close that Edge window when signed in and Vespera will auto-verify.`,
      );
      for (const id of pollTimersRef.current) window.clearTimeout(id);
      pollTimersRef.current = [];
      for (let tick = 1; tick <= 12; tick += 1) {
        const t = window.setTimeout(() => {
          void onRefresh();
        }, tick * 4000);
        pollTimersRef.current.push(t);
      }
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setConnectBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Row: Hero Bento (Reach + Connected Platforms) & Publishing Overview Bar Chart */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section className="vsp-card p-5 xl:col-span-7 flex flex-col justify-between gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                <Sparkles className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                <span>{hasViews ? "Synced Channel Reach & Output" : "Scheduled Output & Active Reach"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-3">
                <span className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
                  {hasViews ? intel.summary.totalViews.toLocaleString() : `${data.summary.totalJobs} Posts`}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/12 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400 tabular-nums">
                  {publishedCount} published · {scheduledCount} queued
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {data.summary.signedInConnections} of {data.summary.connections} accounts signed in across {data.summary.channels} channels
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenNewPost()}
                className="vsp-transition inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[var(--accent-hover)]"
              >
                <Plus className="h-3.5 w-3.5" />
                Schedule Post
              </button>
              <button
                type="button"
                onClick={onNavigateChannels}
                className="vsp-transition inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                <Link2 className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                Open Connect
              </button>
            </div>
          </div>

          {/* Connected Platforms "My Wallet" sub-grid */}
          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xs font-semibold text-[var(--text-primary)]">
                  Connected Platforms
                </h2>
                <div className="flex flex-wrap items-center gap-1">
                  {data.channels.map(ch => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => onSelectChannel(ch.id)}
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                        focusedChannel?.id === ch.id
                          ? "bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold"
                          : "bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {ch.name}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={onNavigateChannels}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <Plus className="h-3 w-3" />
                Add New
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {walletCards.map(({ pid, def, conn }) => {
                const state = conn?.enabled === false ? "off" : conn?.sessionStatus ?? "unconnected";
                const stateLabel =
                  state === "signed_in"
                    ? "Active"
                    : state === "logged_out" || state === "challenge"
                      ? "Needs Sign-in"
                      : state === "off"
                        ? "Paused"
                        : "Ready";
                const badgeClass =
                  state === "signed_in"
                    ? "text-emerald-400"
                    : state === "logged_out" || state === "challenge"
                      ? "text-amber-400"
                      : "text-[var(--text-muted)]";
                const busy = focusedChannel && connectBusy === `${focusedChannel.id}:${pid}`;

                return (
                  <button
                    key={pid}
                    type="button"
                    disabled={!focusedChannel || Boolean(busy)}
                    onClick={() => focusedChannel && void handleQuickConnect(focusedChannel.id, pid)}
                    className="vsp-subcard vsp-transition group flex items-start justify-between gap-2 p-3 text-left hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
                    title={`Launch Edge Connect for ${def?.name ?? pid}`}
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <PlatformIcon platformId={pid} platform={def} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-[var(--text-primary)]">
                          {def?.name ?? pid}
                        </div>
                        <div className="mt-0.5 truncate font-mono-num text-[11px] text-[var(--text-muted)]">
                          {conn?.handle ?? "Not linked"}
                        </div>
                        <div className={`mt-1 text-[10px] font-semibold ${badgeClass}`}>
                          {busy ? "Launching..." : stateLabel}
                        </div>
                      </div>
                    </div>
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-60 transition group-hover:opacity-100 group-hover:text-[var(--accent-primary)]" />
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Right Hero Bento: Publishing Overview Glowing Bar Chart */}
        <section className="vsp-card p-5 xl:col-span-5 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Publishing Overview</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {weekSeries[0]?.label} to {weekSeries[6]?.label}
              </p>
            </div>
            <button
              type="button"
              onClick={onNavigateCalendar}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 font-mono-num text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              View Calendar →
            </button>
          </div>

          {activeBar && (
            <div className="my-4 flex items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[var(--accent-primary)] shadow-[0_0_8px_var(--accent-glow)]" />
                <span className="font-semibold text-[var(--text-primary)]">{activeBar.label}</span>
              </div>
              <div className="font-mono-num text-[var(--text-secondary)]">
                <strong className="text-[var(--text-primary)]">{activeBar.total}</strong> slots ·{" "}
                <span className="text-emerald-400">{activeBar.published} live</span> ·{" "}
                <span className="text-sky-400">{activeBar.scheduled} queued</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-7 items-end gap-2.5 pt-4 h-[196px]">
            {weekSeries.map((day, idx) => {
              const selected = idx === selectedDayIdx;
              const pct = Math.max(16, Math.round((day.total / maxBar) * 100));
              return (
                <button
                  key={day.iso}
                  type="button"
                  onClick={() => setSelectedDayIdx(idx)}
                  className="group flex h-full flex-col items-center justify-end gap-2 focus:outline-none"
                  aria-label={`${day.label}: ${day.total} posts`}
                >
                  <div className="font-mono-num text-[10px] font-medium text-[var(--text-muted)] group-hover:text-[var(--text-primary)]">
                    {day.total}
                  </div>
                  <div className="relative flex w-full flex-1 items-end justify-center">
                    <div
                      className={`vsp-transition w-full max-w-[34px] rounded-t-xl ${
                        selected
                          ? "vsp-glow-bar"
                          : "bg-[var(--bg-elevated)] border border-[var(--border-subtle)] group-hover:bg-[var(--bg-hover)]"
                      }`}
                      style={{ height: `${pct}%` }}
                    />
                  </div>
                  <span
                    className={`text-[11px] font-medium ${
                      selected ? "text-[var(--accent-primary)] font-semibold" : "text-[var(--text-muted)]"
                    }`}
                  >
                    {day.dow}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* Bottom Row: Today's Release Pipeline & Upcoming Releases */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section className="vsp-card p-5 xl:col-span-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Channel Release Readiness</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Signed-in platforms and queue coverage per workspace
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpenNewChannel}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <Plus className="h-3 w-3" />
                New Channel
              </button>
              <button
                type="button"
                onClick={onNavigateChannels}
                className="text-xs font-medium text-[var(--accent-primary)] hover:underline"
              >
                Manage
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {data.channels.map(ch => {
              const enabled = ch.connections.filter(c => c.enabled);
              const active = enabled.filter(c => c.sessionStatus === "signed_in").length;
              const pct = enabled.length > 0 ? Math.round((active / enabled.length) * 100) : 0;
              const chJobs = data.jobs.filter(j => j.channelId === ch.id);
              const chLive = chJobs.filter(j => j.status === "published" || j.status === "scheduled").length;

              return (
                <div key={ch.id} className="vsp-subcard p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-[var(--text-primary)]">{ch.name}</div>
                      <div className="font-mono-num text-[11px] text-[var(--text-muted)]">
                        Daily slot {ch.defaultPostTime} · {chLive}/{chJobs.length} scheduled or live
                      </div>
                    </div>
                    <span className="shrink-0 font-mono-num text-xs font-semibold text-[var(--text-primary)]">
                      {active}/{enabled.length} active
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-black/30">
                    <div
                      className="h-full rounded-full bg-[var(--accent-primary)]"
                      style={{ width: `${Math.max(8, pct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="vsp-card p-5 xl:col-span-7 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Upcoming Releases</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {activeChannelId === "all"
                  ? "Clean episode queue across active workspaces"
                  : `Filtered to ${focusedChannel?.name ?? activeChannelId}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {activeChannelId !== "all" && (
                <button
                  type="button"
                  onClick={() => onSelectChannel("all")}
                  className="rounded-lg border border-[var(--accent-primary)]/40 bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-primary)] hover:bg-[var(--accent-primary)] hover:text-white"
                >
                  Show All Workspaces
                </button>
              )}
              <button
                type="button"
                onClick={() => upcomingEpisodes[0] && onSelectJob(upcomingEpisodes[0].primaryJob)}
                disabled={upcomingEpisodes.length === 0}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                Inspect Next
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {upcomingEpisodes.map(({ key, primaryJob, jobs }) => {
              const sortedByUrgency = [...jobs].sort((a, b) => jobUrgencyRank(a.status) - jobUrgencyRank(b.status));
              const nonCancelled = sortedByUrgency.filter(j => j.status !== "cancelled");
              const badgeStatus = nonCancelled[0]?.status ?? sortedByUrgency[0]?.status ?? primaryJob.status;
              const issueJobs = nonCancelled.filter(
                j => j.status === "needs_login" || j.status === "needs_human_action" || j.status === "failed",
              );
              const badgePrefix =
                issueJobs.length > 0
                  ? `${issueJobs.map(j => platformById.get(j.platform)?.shortCode ?? j.platform.toUpperCase()).join("/")} · `
                  : "";

              return (
                <div
                  key={key}
                  className="vsp-subcard vsp-transition flex w-full items-center justify-between gap-3 px-3.5 py-2.5 hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => onSelectJob(primaryJob)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="flex h-12 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-black/50">
                      {primaryJob.coverPath ? (
                        <img
                          src={`/api/media/thumb/${primaryJob.id}`}
                          alt={primaryJob.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Film className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-[var(--text-primary)]">
                        {primaryJob.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono-num text-[11px] text-[var(--text-muted)]">
                        <span>{primaryJob.channelId}</span>
                        <span>·</span>
                        <span>
                          {primaryJob.targetDate} {formatTimeDisplay(primaryJob.publishAt)}
                        </span>
                      </div>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-2.5">
                    <div className="hidden sm:flex items-center gap-1.5">
                      {jobs.slice(0, 4).map(j => {
                        const pDef = platformById.get(j.platform);
                        return (
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => onSelectJob(j)}
                            title={`${pDef?.name ?? j.platform}: ${j.status.replace(/_/g, " ")}`}
                            className="relative rounded-md p-0.5 hover:bg-[var(--bg-surface)]"
                          >
                            <PlatformIcon platformId={j.platform} platform={pDef} size="xs" />
                            <span
                              className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-1 ring-[var(--bg-elevated)] ${statusDotClass(j.status)}`}
                            />
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelectJob(primaryJob)}
                      className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase ${statusColorClasses(badgeStatus)}`}
                    >
                      {badgePrefix}
                      {badgeStatus.replace(/_/g, " ")}
                    </button>
                  </div>
                </div>
              );
            })}
            {upcomingEpisodes.length === 0 && (
              <div className="vsp-subcard p-6 text-center text-xs text-[var(--text-muted)]">
                No scheduled releases found for this filter.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
