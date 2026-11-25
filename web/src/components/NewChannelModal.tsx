import { FolderPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { PlatformDefinition } from "../types";
import { PlatformIcon } from "./PlatformIcon";

interface Props {
  open: boolean;
  platforms: PlatformDefinition[];
  onClose: () => void;
  onCreated: (newChannelId: string) => Promise<void>;
}

const STARTER_PLATFORM_IDS = ["youtube", "tiktok", "instagram", "x", "facebook", "reddit", "threads"];

function toSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultHandleForPlatform(platformId: string, baseSlug: string, customHandle: string, channelName: string): string {
  const cleanCustom = customHandle.trim();
  const bare = cleanCustom ? cleanCustom.replace(/^@+|^u\//i, "") : baseSlug || "channel";
  if (platformId === "reddit") return `u/${bare}`;
  if (platformId === "facebook") return channelName.trim() || bare;
  return cleanCustom.startsWith("@") ? cleanCustom : `@${bare}`;
}

export function NewChannelModal({ open, platforms, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [defaultHandle, setDefaultHandle] = useState("");
  const [groupId, setGroupId] = useState("flagship");
  const [timezone, setTimezone] = useState("America/Toronto");
  const [defaultTime, setDefaultTime] = useState("12:00");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["youtube", "tiktok", "instagram"]);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const starterDefs = useMemo(() => {
    const byId = new Map(platforms.map(p => [p.id, p]));
    return STARTER_PLATFORM_IDS.map(id => ({ id, def: byId.get(id) }));
  }, [platforms]);

  if (!open) return null;

  const slugPreview = toSlug(name) || "new-channel";

  function togglePlatform(id: string) {
    setSelectedPlatforms(prev => (prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const id = toSlug(trimmedName);
    if (!trimmedName || !id) {
      setErrMsg("Enter a valid channel or workspace name.");
      return;
    }

    setSaving(true);
    setErrMsg(null);
    try {
      await api.post("/api/channels", {
        id,
        name: trimmedName,
        groupId: groupId.trim() || "flagship",
        timezone: timezone.trim() || "America/Toronto",
        defaultPostTime: defaultTime || "12:00",
      });

      for (const pid of selectedPlatforms) {
        await api.post(`/api/channels/${id}/connections`, {
          platform: pid,
          handle: defaultHandleForPlatform(pid, id, defaultHandle, trimmedName),
          adapter: "edge_studio",
          enabled: true,
        });
      }

      setName("");
      setDefaultHandle("");
      setSelectedPlatforms(["youtube", "tiktok", "instagram"]);
      await onCreated(id);
      onClose();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={e => e.stopPropagation()}
        className="vsp-card max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <div className="flex items-center gap-2">
            <FolderPlus className="h-4 w-4 text-[var(--accent-primary)]" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Create New Channel Workspace</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close new channel modal" className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {errMsg && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {errMsg}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Channel / Brand Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Acme Studio"
              className="vsp-input w-full rounded-xl px-3 py-2 text-xs"
            />
            <div className="mt-1 font-mono-num text-[10px] text-[var(--text-muted)]">
              Workspace ID &amp; Edge profile: {slugPreview}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Default Social Handle</label>
            <input
              value={defaultHandle}
              onChange={e => setDefaultHandle(e.target.value)}
              placeholder={`@${slugPreview}`}
              className="vsp-input w-full rounded-xl px-3 py-2 text-xs font-mono-num"
            />
            <div className="mt-1 text-[10px] text-[var(--text-muted)]">
              You can customize handles per platform anytime.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Group</label>
            <input
              value={groupId}
              onChange={e => setGroupId(e.target.value)}
              placeholder="flagship"
              className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Default Time</label>
            <input
              type="time"
              value={defaultTime}
              onChange={e => setDefaultTime(e.target.value)}
              className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs font-mono-num"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Timezone</label>
            <input
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
            Starter Platforms ({selectedPlatforms.length} selected)
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {starterDefs.map(({ id, def }) => {
              const checked = selectedPlatforms.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => togglePlatform(id)}
                  className={`vsp-transition flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs ${
                    checked
                      ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-primary)] font-semibold"
                      : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  <PlatformIcon platformId={id} platform={def} size="xs" />
                  <span className="truncate">{def?.name ?? id}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-[var(--border-subtle)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {saving ? "Creating..." : "Create Channel & Setup Profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
