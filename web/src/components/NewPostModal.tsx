import { Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatBytesCompact } from "../api";
import type { BootstrapPayload } from "../types";

interface Props {
  open: boolean;
  defaultDate?: string;
  activeChannelId?: string;
  data: BootstrapPayload;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function NewPostModal({ open, defaultDate, activeChannelId, data, onClose, onCreated }: Props) {
  const [channelId, setChannelId] = useState(
    activeChannelId && activeChannelId !== "all" ? activeChannelId : data.channels[0]?.id ?? "",
  );
  const selectedChannel = data.channels.find(c => c.id === channelId) ?? data.channels[0];
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["youtube", "tiktok", "x"]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [youtubeTags, setYoutubeTags] = useState("");
  const [subreddit, setSubreddit] = useState("");
  const [targetDate, setTargetDate] = useState(defaultDate ?? new Date().toISOString().slice(0, 10));
  const [postTime, setPostTime] = useState(selectedChannel?.defaultPostTime ?? "10:00");
  const [publishNowIfPastSlot, setPublishNowIfPastSlot] = useState(true);
  const [videoPath, setVideoPath] = useState("");
  const [videoSha256, setVideoSha256] = useState<string | undefined>(undefined);
  const [videoBytes, setVideoBytes] = useState<number | undefined>(undefined);
  const [coverPath, setCoverPath] = useState("");
  const [coverSha256, setCoverSha256] = useState<string | undefined>(undefined);
  const [captionsPath, setCaptionsPath] = useState("");
  const [uploadingKind, setUploadingKind] = useState<"video" | "cover" | "captions" | null>(null);
  const [delayMinutes, setDelayMinutes] = useState(0);
  const [followUpComment, setFollowUpComment] = useState("");
  const [repeatDays, setRepeatDays] = useState(0);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (defaultDate) {
      setTargetDate(defaultDate);
    }
    if (activeChannelId && activeChannelId !== "all") {
      setChannelId(activeChannelId);
    }
    setErrMsg(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, defaultDate, activeChannelId, onClose]);

  useEffect(() => {
    if (!selectedChannel) return;
    setPostTime(selectedChannel.defaultPostTime || "10:00");
    const enabledPlats = selectedChannel.connections.filter(c => c.enabled).map(c => c.platform);
    if (enabledPlats.length > 0) {
      setSelectedPlatforms(enabledPlats);
    }
  }, [selectedChannel]);

  if (!open) return null;

  function togglePlatform(id: string) {
    setSelectedPlatforms(prev => (prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]));
  }

  async function handleFileUpload(kind: "video" | "cover" | "captions", file: File | undefined) {
    if (!file) return;
    setUploadingKind(kind);
    setErrMsg(null);
    try {
      const url = `/api/media/upload?kind=${encodeURIComponent(kind)}&filename=${encodeURIComponent(file.name)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        path?: string;
        sha256?: string;
        bytes?: number;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.path) {
        throw new Error(json.error || `Upload failed (${res.status})`);
      }
      if (kind === "video") {
        setVideoPath(json.path);
        setVideoSha256(json.sha256);
        setVideoBytes(json.bytes);
      } else if (kind === "captions") {
        setCaptionsPath(json.path);
      } else {
        setCoverPath(json.path);
        setCoverSha256(json.sha256);
      }
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingKind(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedChannel || selectedPlatforms.length === 0) {
      setErrMsg("Select a workspace and at least one platform.");
      return;
    }
    setSaving(true);
    setErrMsg(null);
    try {
      const parsedHashtags = hashtags.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
      const parsedYtTags = youtubeTags.split(",").map(t => t.trim()).filter(Boolean);
      await api.post("/api/jobs", {
        channelId: selectedChannel.id,
        platforms: selectedPlatforms,
        title: title.trim(),
        caption: caption.trim(),
        description: caption.trim(),
        postText: caption.trim().slice(0, 280),
        hashtags: parsedHashtags,
        tags: parsedYtTags.length > 0 ? parsedYtTags : undefined,
        captionsPath: captionsPath.trim() || undefined,
        subreddit: subreddit.trim() || undefined,
        targetDate,
        publishAt: `${targetDate}T${postTime || "10:00"}:00`,
        publishNowIfPastSlot,
        videoPath: videoPath.trim() || undefined,
        videoSha256,
        videoBytes,
        coverPath: coverPath.trim() || undefined,
        coverSha256,
        delayCommentMinutes: delayMinutes > 0 ? delayMinutes : undefined,
        followUpComment: followUpComment.trim() || undefined,
        repeatIntervalDays: repeatDays > 0 ? repeatDays : undefined,
      });
      setTitle("");
      setCaption("");
      setYoutubeTags("");
      setVideoPath("");
      setVideoSha256(undefined);
      setVideoBytes(undefined);
      setCoverPath("");
      setCoverSha256(undefined);
      setCaptionsPath("");
      await onCreated();
      onClose();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const availableConns = selectedChannel?.connections.filter(c => c.enabled) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()} className="vsp-card max-h-[90vh] w-full max-w-lg space-y-3.5 overflow-y-auto rounded-xl p-5">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2.5">
          <h3 className="text-sm font-semibold">Schedule Cross-Platform Post</h3>
          <button type="button" onClick={onClose} aria-label="Close modal">
            <X className="h-4 w-4" />
          </button>
        </div>

        {errMsg && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{errMsg}</div>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Workspace</label>
            <select value={selectedChannel?.id ?? ""} onChange={e => setChannelId(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs">
              {data.channels.map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Date</label>
              <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} className="vsp-input w-full rounded-lg px-2 py-1.5 text-xs font-mono-num" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Time</label>
              <input type="time" value={postTime} onChange={e => setPostTime(e.target.value)} className="vsp-input w-full rounded-lg px-2 py-1.5 text-xs font-mono-num" />
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs text-[var(--text-secondary)]">Target Platforms</label>
          <div className="flex flex-wrap gap-1.5">
            {availableConns.map(c => {
              const active = selectedPlatforms.includes(c.platform);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => togglePlatform(c.platform)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                    active ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-primary)]" : "border-[var(--border-subtle)] text-[var(--text-muted)]"
                  }`}
                >
                  {c.platform}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-[var(--text-secondary)]">Title / Hook</label>
          <input required value={title} onChange={e => setTitle(e.target.value)} placeholder="Short descriptive hook..." className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
        </div>

        <div>
          <label className="mb-1 block text-xs text-[var(--text-secondary)]">Caption / Post Body</label>
          <textarea rows={3} value={caption} onChange={e => setCaption(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Hashtags</label>
            <input value={hashtags} onChange={e => setHashtags(e.target.value)} placeholder="#shorts #story" className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Subreddit (optional)</label>
            <input value={subreddit} onChange={e => setSubreddit(e.target.value)} placeholder="r/videos" className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="text-xs text-[var(--text-secondary)]">Video File</label>
              <label className="cursor-pointer inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]">
                <Upload className="h-3 w-3" />
                <span>{uploadingKind === "video" ? "Uploading..." : "Upload Video"}</span>
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v"
                  disabled={uploadingKind !== null}
                  onChange={e => void handleFileUpload("video", e.target.files?.[0])}
                  className="hidden"
                />
              </label>
            </div>
            <input
              value={videoPath}
              onChange={e => {
                setVideoPath(e.target.value);
                setVideoSha256(undefined);
                setVideoBytes(undefined);
              }}
              placeholder="/data/media/video.mp4"
              className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs font-mono"
            />
            {videoBytes !== undefined && (
              <div className="mt-1 text-[10px] text-emerald-400">Uploaded ({formatBytesCompact(videoBytes)})</div>
            )}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="text-xs text-[var(--text-secondary)]">Cover Image</label>
              <label className="cursor-pointer inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]">
                <Upload className="h-3 w-3" />
                <span>{uploadingKind === "cover" ? "Uploading..." : "Upload Cover"}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  disabled={uploadingKind !== null}
                  onChange={e => void handleFileUpload("cover", e.target.files?.[0])}
                  className="hidden"
                />
              </label>
            </div>
            <input
              value={coverPath}
              onChange={e => {
                setCoverPath(e.target.value);
                setCoverSha256(undefined);
              }}
              placeholder="/data/media/thumb.jpg"
              className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs font-mono"
            />
          </div>
        </div>

        {selectedPlatforms.includes("youtube") && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3">
            <div>
              <label className="mb-1 block text-[11px] text-[var(--text-secondary)]">YouTube Tags (comma-separated)</label>
              <input
                value={youtubeTags}
                onChange={e => setYoutubeTags(e.target.value)}
                placeholder="ai, coding, shorts"
                className="vsp-input w-full rounded-lg px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="text-[11px] text-[var(--text-secondary)]">Captions (.srt / .vtt)</label>
                <label className="cursor-pointer inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]">
                  <Upload className="h-3 w-3" />
                  <span>{uploadingKind === "captions" ? "Uploading..." : "Upload SRT"}</span>
                  <input
                    type="file"
                    accept=".srt,.vtt,.sbv"
                    disabled={uploadingKind !== null}
                    onChange={e => void handleFileUpload("captions", e.target.files?.[0])}
                    className="hidden"
                  />
                </label>
              </div>
              <input
                value={captionsPath}
                onChange={e => setCaptionsPath(e.target.value)}
                placeholder="/data/media/captions.srt"
                className="vsp-input w-full rounded-lg px-2.5 py-1.5 text-xs font-mono"
              />
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={publishNowIfPastSlot}
            onChange={e => setPublishNowIfPastSlot(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-[var(--accent-primary)]"
          />
          Publish immediately if scheduled time has already passed
        </label>

        <div className="vsp-subcard grid grid-cols-3 gap-2 rounded-lg p-3">
          <div>
            <label className="mb-1 block text-[11px] text-[var(--text-muted)]">Delay Comment (min)</label>
            <input type="number" min={0} value={delayMinutes} onChange={e => setDelayMinutes(Number(e.target.value))} className="vsp-input w-full rounded px-2 py-1 text-xs font-mono-num" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[var(--text-muted)]">Repeat Every (days)</label>
            <input type="number" min={0} value={repeatDays} onChange={e => setRepeatDays(Number(e.target.value))} className="vsp-input w-full rounded px-2 py-1 text-xs font-mono-num" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[var(--text-muted)]">Follow-Up Text</label>
            <input value={followUpComment} onChange={e => setFollowUpComment(e.target.value)} placeholder="Source link..." className="vsp-input w-full rounded px-2 py-1 text-xs" />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs">Cancel</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-[var(--accent-primary)] px-4 py-1.5 text-xs font-semibold text-white">
            {saving ? "Scheduling..." : "Add to Queue"}
          </button>
        </div>
      </form>
    </div>
  );
}
