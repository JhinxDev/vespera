import { CheckCircle2, ExternalLink, Play, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatBytesCompact, statusColorClasses } from "../api";
import type { PlatformDefinition, PublishAttempt, PublishJob } from "../types";
import { PlatformBadge } from "./PlatformPill";

interface Props {
  job: PublishJob | null;
  platformDef?: PlatformDefinition;
  onClose: () => void;
  onUpdated: () => Promise<void>;
}

export function JobInspectorDrawer({ job, platformDef, onClose, onUpdated }: Props) {
  const [attempts, setAttempts] = useState<PublishAttempt[]>([]);
  const [title, setTitle] = useState("");
  const [copy, setCopy] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [subreddit, setSubreddit] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [aiDisclosure, setAiDisclosure] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [lightboxShot, setLightboxShot] = useState<string | null>(null);

  useEffect(() => {
    if (!job) return;
    setTitle(job.payload.title ?? job.title);
    setCopy(job.payload.caption ?? job.payload.description ?? job.payload.postText ?? "");
    setHashtags((job.payload.hashtags ?? []).join(" "));
    setSubreddit(job.payload.subreddit ?? "");
    setTargetDate(job.targetDate);
    setPublishAt(job.publishAt);
    setAiDisclosure(job.payload.aiDisclosure ?? true);
    setFeedback(null);

    api
      .get<{ ok: boolean; attempts: PublishAttempt[] }>(`/api/jobs/${job.id}`)
      .then(res => setAttempts(res.attempts ?? []))
      .catch(() => setAttempts([]));
  }, [job]);

  useEffect(() => {
    if (!job) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [job, onClose]);

  if (!job) return null;

  async function handleSave() {
    if (!job) return;
    setBusy("save");
    setFeedback(null);
    try {
      const parsedTags = hashtags
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean);
      await api.patch(`/api/jobs/${job.id}`, {
        title,
        targetDate,
        publishAt,
        payload: {
          title,
          caption: copy,
          description: copy,
          postText: copy.slice(0, 280),
          hashtags: parsedTags,
          subreddit: subreddit.trim() || undefined,
          aiDisclosure,
        },
      });
      await onUpdated();
      setFeedback({ ok: true, text: "Saved changes to job." });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function handleRun(dryRun: boolean) {
    if (!job) return;
    setBusy(dryRun ? "dryRun" : "run");
    setFeedback(null);
    try {
      const res = await api.post<{
        ok: boolean;
        result: { status: string; message: string };
        attempts?: PublishAttempt[];
      }>(`/api/jobs/${job.id}/run`, { dryRun });
      if (res.attempts) setAttempts(res.attempts);
      await onUpdated();
      setFeedback({
        ok: res.result.status !== "failed",
        text: res.result.message,
      });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!job) return;
    setBusy("delete");
    try {
      await api.del(`/api/jobs/${job.id}`);
      await onUpdated();
      onClose();
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-label={`Inspect ${job.title}`}
        className="flex h-full w-full max-w-[460px] flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <PlatformBadge platformId={job.platform} platform={platformDef} size="md" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{job.handle}</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusColorClasses(job.status)}`}>
                  {job.status.replace(/_/g, " ")}
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] font-mono-num">
                {job.channelId} · {job.episode} · {formatBytesCompact(job.videoBytes)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {job.videoPath ? (
            <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-black">
              <video
                key={job.id}
                controls
                preload="metadata"
                poster={job.coverPath ? `/api/media/thumb/${job.id}` : undefined}
                src={`/api/media/video/${job.id}`}
                className="mx-auto max-h-[300px] w-full object-contain"
              />
            </div>
          ) : job.coverPath ? (
            <img
              src={`/api/media/thumb/${job.id}`}
              alt={job.title}
              className="mx-auto max-h-[240px] rounded-xl border border-[var(--border-subtle)] object-cover"
            />
          ) : null}

          {job.remoteUrl && (
            <a
              href={job.remoteUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400 hover:bg-emerald-500/15"
            >
              <span className="truncate font-mono">{job.remoteUrl}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 ml-2" />
            </a>
          )}

          {job.lastError && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{job.lastError}</span>
            </div>
          )}

          {feedback && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                feedback.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-300"
              }`}
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{feedback.text}</span>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Title / Hook</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="vsp-input w-full rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Caption / Description</label>
              <textarea
                rows={4}
                value={copy}
                onChange={e => setCopy(e.target.value)}
                className="vsp-input w-full rounded-lg px-3 py-2 text-sm leading-relaxed"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Target Date</label>
                <input
                  type="date"
                  value={targetDate}
                  onChange={e => setTargetDate(e.target.value)}
                  className="vsp-input w-full rounded-lg px-3 py-2 text-xs font-mono-num"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Publish Slot ISO</label>
                <input
                  type="text"
                  value={publishAt}
                  onChange={e => setPublishAt(e.target.value)}
                  className="vsp-input w-full rounded-lg px-3 py-2 text-xs font-mono-num"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Hashtags</label>
              <input
                type="text"
                placeholder="#shorts #history"
                value={hashtags}
                onChange={e => setHashtags(e.target.value)}
                className="vsp-input w-full rounded-lg px-3 py-2 text-xs"
              />
            </div>

            {(job.platform === "reddit" || platformDef?.supportsSubreddit) && (
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Subreddit</label>
                <input
                  type="text"
                  placeholder="r/videos"
                  value={subreddit}
                  onChange={e => setSubreddit(e.target.value)}
                  className="vsp-input w-full rounded-lg px-3 py-2 text-xs"
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={aiDisclosure}
                onChange={e => setAiDisclosure(e.target.checked)}
                className="h-3.5 w-3.5 rounded accent-[var(--accent-primary)]"
              />
              Mark Altered / AI-Generated Content disclosure where supported
            </label>
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-3">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Execution History ({attempts.length})
            </h4>
            {attempts.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No execution attempts recorded yet.</p>
            ) : (
              <div className="space-y-2">
                {attempts.map(att => (
                  <div key={att.id} className="vsp-subcard rounded-lg p-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono-num font-semibold text-[var(--text-primary)]">{att.outcome}</span>
                      <span className="text-[11px] text-[var(--text-muted)] font-mono-num">
                        {att.finishedAt.slice(0, 19).replace("T", " ")}
                      </span>
                    </div>
                    <p className="mt-1 text-[var(--text-secondary)]">{att.message}</p>
                    {att.screenshotFile && (
                      <button
                        type="button"
                        onClick={() => setLightboxShot(`/api/evidence/${att.screenshotFile}`)}
                        className="mt-1.5 text-[11px] font-medium text-[var(--accent-primary)] hover:underline"
                      >
                        View screenshot evidence ({att.screenshotFile})
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={handleSave}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {busy === "save" ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => handleRun(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${busy === "dryRun" ? "animate-spin" : ""}`} />
              Dry-Run
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={handleDelete}
              aria-label="Delete job"
              className="rounded-lg border border-rose-500/30 px-2.5 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => handleRun(false)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {busy === "run" ? "Running..." : "Publish / Schedule"}
          </button>
        </div>
      </div>

      {lightboxShot && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setLightboxShot(null)}
        >
          <img
            src={lightboxShot}
            alt="Execution evidence screenshot"
            className="max-h-[90vh] max-w-[90vw] rounded-xl border border-[var(--border-subtle)] shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
