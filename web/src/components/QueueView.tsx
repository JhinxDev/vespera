import { Pause, Play, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { api, formatBytesCompact, formatTimeDisplay, statusColorClasses } from "../api";
import type { BootstrapPayload, PlatformDefinition, PublishJob } from "../types";
import { PlatformBadge } from "./PlatformPill";

interface Props {
  data: BootstrapPayload;
  activeChannelId: string;
  onSelectChannel: (channelId: string) => void;
  onSelectJob: (job: PublishJob) => void;
  onNotify: (tone: "info" | "success" | "warning" | "error", text: string) => void;
  onRefresh: () => Promise<void>;
}

export function QueueView({ data, activeChannelId, onSelectChannel, onSelectJob, onNotify, onRefresh }: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [schedulerBusy, setSchedulerBusy] = useState(false);

  const scheduler = data.scheduler;

  async function handleToggleScheduler() {
    if (!scheduler) return;
    setSchedulerBusy(true);
    try {
      const nextEnabled = !scheduler.enabled;
      await api.post("/api/scheduler", { enabled: nextEnabled });
      await onRefresh();
      onNotify(
        nextEnabled ? "success" : "info",
        nextEnabled
          ? "Auto-Post enabled: Vespera will check due jobs every 60 seconds."
          : "Auto-Post paused: queued jobs will wait until triggered manually.",
      );
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerBusy(false);
    }
  }

  async function handleDryRunDue() {
    setSchedulerBusy(true);
    try {
      const res = await api.post<{ ok: boolean; ran?: number }>(
        "/api/scheduler",
        { runNow: true, dryRun: true },
      );
      await onRefresh();
      onNotify("info", `Dry-run completed across ${res.ran ?? 0} due job(s).`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerBusy(false);
    }
  }

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data.platforms) map.set(p.id, p);
    return map;
  }, [data.platforms]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.jobs.filter(j => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (activeChannelId !== "all" && j.channelId !== activeChannelId) return false;
      if (q && !`${j.title} ${j.episode} ${j.platform} ${j.handle}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.jobs, query, statusFilter, activeChannelId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by title, episode, handle..."
            className="vsp-input w-full rounded-xl pl-8 pr-3 py-1.5 text-xs"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Workspace filter"
            value={activeChannelId}
            onChange={e => onSelectChannel(e.target.value)}
            className="vsp-input rounded-xl px-2.5 py-1.5 text-xs"
          >
            <option value="all">All Workspaces</option>
            {data.channels.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            aria-label="Status filter"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="vsp-input rounded-xl px-2.5 py-1.5 text-xs"
          >
            <option value="all">All Statuses ({data.jobs.length})</option>
            {["queued", "scheduled", "published", "draft", "needs_login", "needs_human_action", "failed"].map(s => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")} ({data.summary.jobsByStatus[s] ?? 0})
              </option>
            ))}
          </select>
          {scheduler && (
            <>
              <button
                type="button"
                disabled={schedulerBusy}
                onClick={() => void handleToggleScheduler()}
                className={`vsp-transition inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${
                  scheduler.enabled
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {scheduler.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                <span>{scheduler.enabled ? "Auto-Post: ON" : "Auto-Post: Paused"}</span>
              </button>
              <button
                type="button"
                disabled={schedulerBusy}
                onClick={() => void handleDryRunDue()}
                className="vsp-transition inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Dry-Run Due</span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="vsp-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                <th className="px-4 py-2.5 font-medium">Media / Title</th>
                <th className="px-3 py-2.5 font-medium">Workspace</th>
                <th className="px-3 py-2.5 font-medium">Platform</th>
                <th className="px-3 py-2.5 font-medium">Target Slot</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium text-right">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {rows.map(job => (
                <tr
                  key={job.id}
                  onClick={() => onSelectJob(job)}
                  className="vsp-transition cursor-pointer hover:bg-[var(--bg-hover)]"
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-7 shrink-0 overflow-hidden rounded border border-[var(--border-subtle)] bg-black/30">
                        {job.coverPath && (
                          <img src={`/api/media/thumb/${job.id}`} alt="" className="h-full w-full object-cover" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium max-w-[320px]">{job.title}</div>
                        <div className="text-[11px] text-[var(--text-muted)] font-mono-num">{job.episode}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[var(--text-secondary)]">{job.channelId}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <PlatformBadge platformId={job.platform} platform={platformById.get(job.platform)} size="xs" />
                      <span className="text-[var(--text-secondary)]">{job.handle}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono-num text-[var(--text-secondary)]">
                    {job.targetDate} {formatTimeDisplay(job.publishAt)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusColorClasses(job.status)}`}>
                      {job.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono-num text-[var(--text-muted)]">
                    {formatBytesCompact(job.videoBytes)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No matching queue items.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
