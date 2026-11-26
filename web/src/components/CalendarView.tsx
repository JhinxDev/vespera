import { CalendarDays, ChevronLeft, ChevronRight, Film, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { formatTimeDisplay, statusColorClasses } from "../api";
import type { BootstrapPayload, PlatformDefinition, PublishJob } from "../types";
import { PlatformIcon } from "./PlatformIcon";

interface Props {
  data: BootstrapPayload;
  activeChannelId: string;
  onSelectChannel: (channelId: string) => void;
  onSelectJob: (job: PublishJob) => void;
  onOpenNewPost: (defaultDate?: string) => void;
}

interface EpisodeGroup {
  key: string;
  channelId: string;
  episode: string;
  title: string;
  publishAt: string;
  targetDate: string;
  primaryJob: PublishJob;
  jobs: PublishJob[];
}

function addDaysIso(startIso: string, days: number): string {
  const [y, m, d] = startIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function formatDayHeading(isoDate: string): { dow: string; label: string } {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return {
    dow: dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
    label: dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  };
}

export function CalendarView({ data, activeChannelId, onSelectChannel, onSelectJob, onOpenNewPost }: Props) {
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"agenda" | "month">("agenda");

  const earliestDate = useMemo(() => {
    const dates = data.jobs.map(j => j.targetDate).filter(Boolean).sort();
    return dates[0] ?? new Date().toISOString().slice(0, 10);
  }, [data.jobs]);

  const todayIso = new Date().toLocaleDateString("en-CA");
  const todayWeekOffset = useMemo(() => {
    const diffDays = Math.floor((Date.parse(todayIso) - Date.parse(earliestDate)) / 86_400_000);
    return Number.isFinite(diffDays) ? Math.max(0, Math.floor(diffDays / 7)) : 0;
  }, [todayIso, earliestDate]);

  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = addDaysIso(earliestDate, weekOffset * 7);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i)), [weekStart]);

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data.platforms) map.set(p.id, p);
    return map;
  }, [data.platforms]);

  const channelNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of data.channels) map.set(c.id, c.name);
    return map;
  }, [data.channels]);

  const filteredJobs = useMemo(() => {
    return data.jobs.filter(job => {
      if (activeChannelId !== "all" && job.channelId !== activeChannelId) return false;
      if (platformFilter !== "all" && job.platform !== platformFilter) return false;
      return true;
    });
  }, [data.jobs, activeChannelId, platformFilter]);

  const episodesByDate = useMemo(() => {
    const dateMap = new Map<string, EpisodeGroup[]>();
    const groupLookup = new Map<string, EpisodeGroup>();

    for (const job of filteredJobs) {
      const date = job.targetDate;
      const gKey = `${date}:${job.channelId}:${job.episode || job.videoId || job.title}`;
      let group = groupLookup.get(gKey);
      if (!group) {
        group = {
          key: gKey,
          channelId: job.channelId,
          episode: job.episode,
          title: job.title,
          publishAt: job.publishAt,
          targetDate: date,
          primaryJob: job,
          jobs: [],
        };
        groupLookup.set(gKey, group);
        const list = dateMap.get(date) ?? [];
        list.push(group);
        dateMap.set(date, list);
      }
      group.jobs.push(job);
    }

    return dateMap;
  }, [filteredJobs]);

  const jobsByDate = useMemo(() => {
    const map = new Map<string, PublishJob[]>();
    for (const j of filteredJobs) {
      const list = map.get(j.targetDate) ?? [];
      list.push(j);
      map.set(j.targetDate, list);
    }
    return map;
  }, [filteredJobs]);

  const monthDates = useMemo(() => {
    const anchor = weekStart.slice(0, 7);
    const [y, m] = anchor.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Array.from({ length: daysInMonth }, (_, i) => `${anchor}-${String(i + 1).padStart(2, "0")}`);
  }, [weekStart]);

  return (
    <div className="space-y-4">
      {/* Compact filter + view toolbar */}
      <div className="vsp-card flex flex-wrap items-center justify-between gap-3 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => onSelectChannel("all")}
              className={`rounded-lg px-2.5 py-1.5 font-medium ${
                activeChannelId === "all"
                  ? "bg-[var(--accent-primary)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              All Channels
            </button>
            {data.channels.map(ch => (
              <button
                key={ch.id}
                type="button"
                onClick={() => onSelectChannel(ch.id)}
                className={`rounded-lg px-2.5 py-1.5 font-medium ${
                  activeChannelId === ch.id
                    ? "bg-[var(--accent-primary)] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {ch.name}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by platform"
            value={platformFilter}
            onChange={e => setPlatformFilter(e.target.value)}
            className="vsp-input rounded-xl px-3 py-1.5 text-xs"
          >
            <option value="all">All Platforms</option>
            {data.platforms
              .filter(p => p.featuredOrder || p.category === "custom")
              .map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setWeekOffset(w => w - 1)}
              aria-label="Previous week"
              className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="whitespace-nowrap px-2.5 font-mono-num text-[11px] text-[var(--text-secondary)]">
              {weekStart}
            </span>
            <button
              type="button"
              onClick={() => setWeekOffset(w => w + 1)}
              aria-label="Next week"
              className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {weekOffset !== todayWeekOffset && (
            <button
              type="button"
              onClick={() => setWeekOffset(todayWeekOffset)}
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
            >
              Today
            </button>
          )}

          <div className="flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewMode("agenda")}
              className={`rounded-lg px-2.5 py-1.5 font-medium ${
                viewMode === "agenda" ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-muted)]"
              }`}
            >
              Week Agenda
            </button>
            <button
              type="button"
              onClick={() => setViewMode("month")}
              className={`rounded-lg px-2.5 py-1.5 font-medium ${
                viewMode === "month" ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-muted)]"
              }`}
            >
              Month
            </button>
          </div>
        </div>
      </div>

      {/* Week overview pills */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {weekDates.map(date => {
          const { dow, label } = formatDayHeading(date);
          const count = (episodesByDate.get(date) ?? []).length;
          const isToday = date === todayIso;
          return (
            <div
              key={date}
              className={`vsp-card flex items-center justify-between px-3.5 py-2.5 text-xs ${
                isToday ? "border-[var(--accent-primary)] bg-[var(--accent-soft)]" : ""
              }`}
            >
              <div>
                <div className={`text-[10px] font-semibold uppercase tracking-wider ${isToday ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"}`}>
                  {dow}{isToday ? " · TODAY" : ""}
                </div>
                <div className="font-semibold text-[var(--text-primary)] tabular-nums">{label}</div>
              </div>
              <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 font-mono-num text-[11px] font-semibold text-[var(--text-secondary)]">
                {count} ep
              </span>
            </div>
          );
        })}
      </div>

      {viewMode === "agenda" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {weekDates.map(date => {
            const { dow, label } = formatDayHeading(date);
            const dayEpisodes = episodesByDate.get(date) ?? [];
            const isToday = date === todayIso;
            return (
              <section key={date} className={`vsp-card flex flex-col p-4 ${isToday ? "border-[var(--accent-primary)]/50" : ""}`}>
                <div className="mb-3 flex items-center justify-between border-b border-[var(--border-subtle)] pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-lg px-2 py-1 font-mono-num text-[11px] font-semibold uppercase ${
                      isToday ? "bg-[var(--accent-primary)] text-white" : "bg-[var(--accent-soft)] text-[var(--accent-primary)]"
                    }`}>
                      {dow}
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--text-primary)] tabular-nums">
                        {label}{isToday ? " · Today" : ""}
                      </h3>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenNewPost(date)}
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                </div>

                <div className="flex-1 space-y-2.5">
                  {dayEpisodes.length === 0 ? (
                    <div className="flex h-28 items-center justify-center rounded-xl border border-dashed border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
                      No episodes scheduled
                    </div>
                  ) : (
                    dayEpisodes.map(ep => (
                      <div key={ep.key} className="vsp-subcard p-3 space-y-2.5">
                        <button
                          type="button"
                          onClick={() => onSelectJob(ep.primaryJob)}
                          className="flex w-full items-start gap-3 text-left group"
                        >
                          <div className="flex h-16 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-black/50">
                            {ep.primaryJob.coverPath ? (
                              <img
                                src={`/api/media/thumb/${ep.primaryJob.id}`}
                                alt={ep.title}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <Film className="h-4 w-4 text-[var(--text-muted)]" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="truncate font-semibold text-[var(--accent-primary)]">
                                {channelNameById.get(ep.channelId) ?? ep.channelId}
                              </span>
                              <span className="shrink-0 font-mono-num text-[var(--text-muted)]">
                                {ep.episode} · {formatTimeDisplay(ep.publishAt)}
                              </span>
                            </div>
                            <div className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-[var(--text-primary)] group-hover:text-[var(--accent-hover)]">
                              {ep.title}
                            </div>
                          </div>
                        </button>

                        {/* Clickable colorful platform pills inside the episode bento */}
                        <div className="flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] pt-2">
                          {ep.jobs.map(job => {
                            const pDef = platformById.get(job.platform);
                            const publishMs = Date.parse(job.publishAt);
                            const isOverdue = job.status === "queued" && Number.isFinite(publishMs) && publishMs < Date.now() - 60_000;
                            return (
                              <button
                                key={job.id}
                                type="button"
                                onClick={() => onSelectJob(job)}
                                className={`vsp-transition inline-flex items-center gap-1.5 rounded-lg border bg-[var(--bg-surface)] px-2 py-1 text-[11px] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] ${
                                  isOverdue ? "border-amber-500/45" : "border-[var(--border-subtle)]"
                                }`}
                                title={
                                  isOverdue
                                    ? `Overdue queued ${pDef?.name ?? job.platform} job (slot ${job.publishAt})`
                                    : `Inspect ${pDef?.name ?? job.platform} job`
                                }
                              >
                                <PlatformIcon platformId={job.platform} platform={pDef} size="xs" />
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase border ${statusColorClasses(job.status)}`}>
                                  {isOverdue ? "OVERDUE" : job.status.replace(/_/g, " ")}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="vsp-card p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
            <CalendarDays className="h-4 w-4 text-[var(--accent-primary)]" />
            <span>{weekStart.slice(0, 7)} Monthly Schedule</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
            {monthDates.map(date => {
              const items = jobsByDate.get(date) ?? [];
              return (
                <div key={date} className="vsp-subcard min-h-[104px] p-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-mono-num text-xs font-semibold">{date.slice(8)}</span>
                    <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                      {items.length > 0 ? `${items.length}` : ""}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {items.slice(0, 3).map(j => (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() => onSelectJob(j)}
                        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[10px] hover:bg-[var(--bg-hover)]"
                      >
                        <PlatformIcon platformId={j.platform} platform={platformById.get(j.platform)} size="xs" />
                        <span className="truncate">{j.episode}</span>
                      </button>
                    ))}
                    {items.length > 3 && (
                      <div className="px-1 text-[10px] text-[var(--text-muted)]">+{items.length - 3} more</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
