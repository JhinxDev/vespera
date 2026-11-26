import { Check, ExternalLink, Eye, FolderPlus, Globe, Link2, Pencil, Plus, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeUrlInput, statusColorClasses } from "../api";
import type { BootstrapPayload, ChannelConfig, ChannelConnection, LiveBrowserSession, PlatformDefinition } from "../types";
import { NewChannelModal } from "./NewChannelModal";
import { PlatformIcon } from "./PlatformIcon";
import type { NotifyFn } from "./ToastStack";

interface Props {
  data: BootstrapPayload;
  activeChannelId?: string;
  onOpenLiveBrowser: (session: LiveBrowserSession) => void;
  onNotify: NotifyFn;
  onRefresh: () => Promise<void>;
}

const PRIORITY_IDS = new Set(["facebook", "tiktok", "reddit", "instagram", "youtube", "x", "threads"]);

export function ChannelsView({ data, activeChannelId = "all", onOpenLiveBrowser, onNotify, onRefresh }: Props) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const pollTimersRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      for (const id of pollTimersRef.current) window.clearTimeout(id);
    };
  }, []);
  const [showCustomPlatformModal, setShowCustomPlatformModal] = useState(false);
  const [showNewChannelModal, setShowNewChannelModal] = useState(false);
  const [addConnChannel, setAddConnChannel] = useState<ChannelConfig | null>(null);
  const [showCatalogAll, setShowCatalogAll] = useState(false);
  const [lightboxShot, setLightboxShot] = useState<string | null>(null);
  const [customLaunchUrls, setCustomLaunchUrls] = useState<Record<string, string>>({});
  const [editingConnId, setEditingConnId] = useState<string | null>(null);
  const [handleDraft, setHandleDraft] = useState("");
  const [confirmDeleteChannelId, setConfirmDeleteChannelId] = useState<string | null>(null);

  // Custom platform modal state
  const [cpName, setCpName] = useState("");
  const [cpLoginUrl, setCpLoginUrl] = useState("https://");
  const [cpComposeUrl, setCpComposeUrl] = useState("");
  const [cpAccent, setCpAccent] = useState("#3B82F6");
  const [cpWebhookMode, setCpWebhookMode] = useState(false);

  // Add connection modal state
  const [connPlatform, setConnPlatform] = useState("instagram");
  const [connHandle, setConnHandle] = useState("@handle");
  const [connAdapter, setConnAdapter] = useState<"edge_studio" | "webhook" | "youtube_api">("edge_studio");
  const [connWebhookUrl, setConnWebhookUrl] = useState("");

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data.platforms) map.set(p.id, p);
    return map;
  }, [data.platforms]);

  const priorityPlatforms = useMemo(
    () => data.platforms.filter(p => PRIORITY_IDS.has(p.id)),
    [data.platforms],
  );
  const secondaryPlatforms = useMemo(
    () => data.platforms.filter(p => !PRIORITY_IDS.has(p.id)),
    [data.platforms],
  );

  const quickConnectChannel = useMemo(() => {
    if (activeChannelId !== "all") {
      return data.channels.find(c => c.id === activeChannelId) ?? data.channels[0];
    }
    return data.channels[0];
  }, [data.channels, activeChannelId]);

  async function handleConnectSingle(channelId: string, platform?: string, customUrl?: string) {
    const key = `connect:${channelId}:${platform ?? "custom"}`;
    setBusyKey(key);
    try {
      const res = await api.post<{
        ok: boolean;
        mode?: string;
        oauthUrl?: string;
        command?: string;
        url: string;
        session?: LiveBrowserSession;
      }>(`/api/channels/${channelId}/connect`, {
        platform,
        customUrl,
      });
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
          ? `Server container mode: run "${res.command}" on your PC to sign in with fast native Edge and push the session automatically.`
          : `Opened Edge Connect for ${channelId} at ${res.url}. Sign in, close that Edge window (auto-verify runs automatically), or click Verify after closing.`,
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
      setBusyKey(null);
    }
  }

  async function handleCheck(channelId: string, platform?: string) {
    const key = `check:${channelId}:${platform ?? "all"}`;
    setBusyKey(key);
    try {
      const res = await api.post<{
        ok: boolean;
        results: Array<{ platform: string; status: string; observedHandle?: string; note?: string }>;
      }>(`/api/channels/${channelId}/check`, { platform });
      await onRefresh();
      const list = res.results ?? [];
      if (list.length === 1) {
        const item = list[0];
        const ok = item.status === "signed_in";
        const label = platformById.get(item.platform)?.name ?? item.platform;
        onNotify(
          ok ? "success" : "warning",
          ok
            ? `${label} (${channelId}) verified: SIGNED IN${item.observedHandle ? ` as ${item.observedHandle}` : ""}.`
            : `${label} (${channelId}) verified: ${item.status.replace(/_/g, " ").toUpperCase()}${item.note ? ` (${item.note})` : ""}.`,
        );
      } else {
        const signedIn = list.filter(x => x.status === "signed_in").length;
        const issue = list.find(x => x.status !== "signed_in");
        onNotify(
          signedIn === list.length && list.length > 0 ? "success" : "warning",
          `Checked ${list.length} account(s) on ${channelId}: ${signedIn}/${list.length} signed in${issue ? ` (${issue.platform}: ${issue.status.replace(/_/g, " ")})` : ""}.`,
        );
      }
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleToggleConnection(conn: ChannelConnection) {
    try {
      await api.patch(`/api/channels/${conn.channelId}/connections/${encodeURIComponent(conn.id)}`, {
        enabled: !conn.enabled,
      });
      await onRefresh();
      onNotify("info", `${conn.platform} on ${conn.channelId} ${conn.enabled ? "paused" : "enabled"}.`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteConnection(conn: ChannelConnection) {
    try {
      await api.del(`/api/channels/${conn.channelId}/connections/${encodeURIComponent(conn.id)}`);
      await onRefresh();
      onNotify("success", `Removed ${conn.platform} from ${conn.channelId}.`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveHandle(conn: ChannelConnection) {
    const trimmed = handleDraft.trim();
    if (!trimmed) return;
    try {
      await api.patch(`/api/channels/${conn.channelId}/connections/${encodeURIComponent(conn.id)}`, {
        handle: trimmed,
      });
      setEditingConnId(null);
      await onRefresh();
      onNotify("success", `Updated ${conn.platform} handle to ${trimmed}.`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteChannel(channelId: string) {
    try {
      await api.del(`/api/channels/${channelId}`);
      setConfirmDeleteChannelId(null);
      await onRefresh();
      onNotify("success", `Deleted channel '${channelId}'.`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateCustomPlatform(e: React.FormEvent) {
    e.preventDefault();
    if (!cpName.trim() || !cpLoginUrl.trim()) return;
    try {
      await api.post("/api/platforms", {
        id: cpName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name: cpName.trim(),
        accentHex: cpAccent,
        loginUrl: normalizeUrlInput(cpLoginUrl),
        composeUrl: normalizeUrlInput(cpComposeUrl) || normalizeUrlInput(cpLoginUrl),
        authModes: cpWebhookMode ? ["webhook", "edge_studio"] : ["edge_studio", "custom_web"],
      });
      setCpName("");
      setCpLoginUrl("https://");
      setCpComposeUrl("");
      setShowCustomPlatformModal(false);
      await onRefresh();
      onNotify("success", "Custom platform saved.");
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddConnectionSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!addConnChannel) return;
    try {
      await api.post(`/api/channels/${addConnChannel.id}/connections`, {
        platform: connPlatform,
        handle: connHandle.trim() || "@account",
        adapter: connAdapter,
        webhookUrl: connWebhookUrl.trim() || undefined,
        enabled: true,
      });
      setAddConnChannel(null);
      setConnWebhookUrl("");
      await onRefresh();
      onNotify("success", `Added ${connPlatform} to ${addConnChannel.name}.`);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      {/* Core Social Channels Bar + Quick Icon Grid */}
      <div className="vsp-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Core Social Channels &amp; Extensible Connectors
            </h3>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Priority social networks featured first for{" "}
              <strong className="text-[var(--text-secondary)]">{quickConnectChannel?.name ?? "default workspace"}</strong>.
              Add custom studios or webhooks without code changes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCatalogAll(v => !v)}
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)]"
            >
              {showCatalogAll ? "Hide Extended Catalog" : `All Platforms (${data.platforms.length})`}
            </button>
            <button
              type="button"
              onClick={() => setShowCustomPlatformModal(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)]"
            >
              <Globe className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
              Add Custom Platform
            </button>
            <button
              type="button"
              onClick={() => setShowNewChannelModal(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)]"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New Channel
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7">
          {priorityPlatforms.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                if (quickConnectChannel) {
                  void handleConnectSingle(quickConnectChannel.id, p.id);
                }
              }}
              className="vsp-subcard vsp-transition flex items-center gap-2.5 px-3 py-2.5 text-left hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
              title={`Launch ${p.name} connect for ${quickConnectChannel?.name ?? "default workspace"}`}
            >
              <PlatformIcon platformId={p.id} platform={p} size="sm" />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[var(--text-primary)]">{p.name}</div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {p.supportsScheduling ? "Schedulable" : "Instant Post"}
                </div>
              </div>
            </button>
          ))}
        </div>

        {showCatalogAll && (
          <div className="grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-3 sm:grid-cols-4 lg:grid-cols-6">
            {secondaryPlatforms.map(p => (
              <div key={p.id} className="vsp-subcard flex items-center justify-between gap-2 px-2.5 py-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <PlatformIcon platformId={p.id} platform={p} size="xs" />
                  <span className="truncate font-medium">{p.name}</span>
                </div>
                {!p.builtIn && (
                  <button
                    type="button"
                    aria-label={`Delete custom platform ${p.name}`}
                    onClick={() => api.del(`/api/platforms/${p.id}`).then(onRefresh)}
                    className="shrink-0 text-rose-400 hover:text-rose-300"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Workspace Cards: Stack clean rows with wrapped action bars so nothing clips at 1024/1280/1440px */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {data.channels.map(channel => {
          const customUrl = customLaunchUrls[channel.id] ?? "";
          return (
            <div key={channel.id} className="vsp-card flex flex-col p-5">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--border-subtle)] pb-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-[var(--text-primary)]">{channel.name}</h3>
                    {channel.groupId && (
                      <span className="rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-primary)]">
                        {channel.groupId}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono-num text-[11px] text-[var(--text-muted)]">
                    id: {channel.id} · slot {channel.defaultPostTime} ({channel.timezone})
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCheck(channel.id)}
                    disabled={busyKey === `check:${channel.id}:all`}
                    className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${busyKey === `check:${channel.id}:all` ? "animate-spin" : ""}`} />
                    Check All
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddConnChannel(channel);
                      setConnPlatform("instagram");
                      setConnHandle("@handle");
                    }}
                    className="inline-flex items-center gap-1 rounded-xl bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Platform
                  </button>
                  {confirmDeleteChannelId === channel.id ? (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleDeleteChannel(channel.id)}
                        className="rounded-xl bg-rose-500 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-400"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteChannelId(null)}
                        className="rounded-xl border border-[var(--border-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteChannelId(channel.id)}
                      aria-label={`Delete workspace ${channel.name}`}
                      className="rounded-xl border border-[var(--border-subtle)] p-1.5 text-[var(--text-muted)] hover:border-rose-500/40 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-3.5 flex-1 space-y-2.5">
                {channel.connections.map(conn => {
                  const pDef = platformById.get(conn.platform);
                  const isEditingHandle = editingConnId === conn.id;
                  return (
                    <div
                      key={conn.id}
                      className={`vsp-subcard scroll-mt-24 flex flex-col gap-2.5 px-3.5 py-3 text-xs ${
                        isEditingHandle ? "" : "sm:flex-row sm:items-center sm:justify-between"
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <PlatformIcon platformId={conn.platform} platform={pDef} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-[var(--text-primary)]">
                              {pDef?.name ?? conn.platform}
                            </span>
                            {isEditingHandle ? (
                              <span className="inline-flex flex-wrap items-center gap-1">
                                <input
                                  aria-label="Edit handle"
                                  value={handleDraft}
                                  onChange={e => setHandleDraft(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void handleSaveHandle(conn);
                                    } else if (e.key === "Escape") {
                                      setEditingConnId(null);
                                    }
                                  }}
                                  className="vsp-input w-36 rounded-lg px-2 py-0.5 font-mono-num text-[11px]"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleSaveHandle(conn)}
                                  aria-label="Save handle"
                                  className="rounded bg-[var(--accent-primary)] p-1 text-white"
                                >
                                  <Check className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingConnId(null)}
                                  aria-label="Cancel edit"
                                  className="rounded bg-[var(--bg-surface)] p-1 text-[var(--text-muted)]"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ) : (
                              <>
                                <span className="truncate font-mono-num text-[11px] text-[var(--text-secondary)]">
                                  {conn.handle}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingConnId(conn.id);
                                    setHandleDraft(conn.handle);
                                  }}
                                  aria-label={`Edit ${pDef?.name ?? conn.platform} handle`}
                                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              </>
                            )}
                          </div>
                          {conn.sessionNote && (
                            <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]" title={conn.sessionNote}>
                              {conn.sessionNote}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap shrink-0 items-center gap-1.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusColorClasses(conn.enabled ? conn.sessionStatus : "disabled")}`}
                        >
                          {conn.enabled ? conn.sessionStatus.replace(/_/g, " ") : "off"}
                        </span>

                        <button
                          type="button"
                          onClick={() => handleConnectSingle(channel.id, conn.platform)}
                          disabled={busyKey === `connect:${channel.id}:${conn.platform}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium hover:bg-[var(--bg-hover)]"
                          title={`Open isolated Edge window solely for ${pDef?.name ?? conn.platform}`}
                        >
                          <Link2 className="h-3 w-3 text-[var(--accent-primary)]" />
                          Connect
                        </button>

                        <button
                          type="button"
                          onClick={() => handleCheck(channel.id, conn.platform)}
                          disabled={busyKey === `check:${channel.id}:${conn.platform}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                        >
                          {busyKey === `check:${channel.id}:${conn.platform}` ? (
                            <>
                              <RefreshCw className="h-3 w-3 animate-spin" />
                              Checking...
                            </>
                          ) : (
                            "Verify"
                          )}
                        </button>

                        {conn.evidenceFile && (
                          <button
                            type="button"
                            onClick={() => setLightboxShot(`/api/evidence/${conn.evidenceFile}`)}
                            aria-label="Preview check evidence screenshot"
                            className="rounded-lg border border-[var(--border-subtle)] p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleToggleConnection(conn)}
                          className="rounded-lg border border-[var(--border-subtle)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                        >
                          {conn.enabled ? "Off" : "On"}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDeleteConnection(conn)}
                          aria-label={`Remove ${conn.platform}`}
                          className="rounded-lg p-1 text-rose-400 hover:bg-rose-500/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                <input
                  type="text"
                  value={customUrl}
                  onChange={e => setCustomLaunchUrls(prev => ({ ...prev, [channel.id]: e.target.value }))}
                  placeholder="https://... open any URL inside this isolated profile"
                  className="vsp-input min-w-[180px] flex-1 rounded-xl px-3 py-1.5 text-xs"
                />
                <button
                  type="button"
                  disabled={!customUrl.trim()}
                  onClick={() => {
                    const url = normalizeUrlInput(customUrl);
                    if (url) void handleConnectSingle(channel.id, undefined, url);
                  }}
                  className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  <ExternalLink className="h-3 w-3" />
                  Launch Tab
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="vsp-card flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
        <div className="flex items-center gap-2.5">
          <Terminal className="h-4 w-4 text-[var(--accent-primary)]" />
          <span>
            <strong>Fast Session Sync:</strong>{" "}
            Sign in with your native Edge browser on Windows and stream cookies straight to Vespera via CLI or open the focused{" "}
            <code>/connect</code>{" "}
            web view.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/connect"
            className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium hover:bg-[var(--bg-hover)]"
          >
            Open /connect View
          </a>
          <code className="rounded-lg bg-[var(--bg-elevated)] px-2.5 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
            npm run sync-sessions -- &lt;channel&gt; &lt;platform&gt;
          </code>
        </div>
      </div>

      {showCustomPlatformModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form onSubmit={handleCreateCustomPlatform} className="vsp-card w-full max-w-md space-y-3 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Register Custom Social Platform</h3>
              <button type="button" onClick={() => setShowCustomPlatformModal(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Platform Name</label>
              <input required value={cpName} onChange={e => setCpName(e.target.value)} placeholder="Substack, Kick, Vimeo..." className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Login / Studio URL</label>
              <input required value={cpLoginUrl} onChange={e => setCpLoginUrl(e.target.value)} className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-[var(--text-secondary)]">Compose URL (optional)</label>
                <input value={cpComposeUrl} onChange={e => setCpComposeUrl(e.target.value)} placeholder="Defaults to login URL" className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-[var(--text-secondary)]">Color</label>
                <input type="color" value={cpAccent} onChange={e => setCpAccent(e.target.value)} className="h-8 w-full rounded cursor-pointer bg-transparent" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input type="checkbox" checked={cpWebhookMode} onChange={e => setCpWebhookMode(e.target.checked)} />
              Support Webhook Delivery Adapter
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCustomPlatformModal(false)} className="rounded-xl border border-[var(--border-subtle)] px-3 py-1.5 text-xs">Cancel</button>
              <button type="submit" className="rounded-xl bg-[var(--accent-primary)] px-3.5 py-1.5 text-xs font-semibold text-white">Save Platform</button>
            </div>
          </form>
        </div>
      )}

      <NewChannelModal
        open={showNewChannelModal}
        platforms={data.platforms}
        onClose={() => setShowNewChannelModal(false)}
        onCreated={async newId => {
          await onRefresh();
          onNotify("success", `Created workspace '${newId}' with starter platforms.`);
        }}
      />

      {addConnChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form onSubmit={handleAddConnectionSubmit} className="vsp-card w-full max-w-md space-y-3 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Add Platform to {addConnChannel.name}</h3>
              <button type="button" onClick={() => setAddConnChannel(null)} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Platform</label>
              <select value={connPlatform} onChange={e => setConnPlatform(e.target.value)} className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs">
                {data.platforms.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Account Handle / Page Name</label>
              <input required value={connHandle} onChange={e => setConnHandle(e.target.value)} className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">Delivery Mode</label>
              <select value={connAdapter} onChange={e => setConnAdapter(e.target.value as "edge_studio" | "webhook" | "youtube_api")} className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs">
                <option value="edge_studio">Isolated Edge Browser Session ($0/mo)</option>
                <option value="webhook">Custom Webhook URL</option>
                <option value="youtube_api">YouTube Official API Helper</option>
              </select>
            </div>
            {connAdapter === "webhook" && (
              <div>
                <label className="mb-1 block text-xs text-[var(--text-secondary)]">Target Webhook URL</label>
                <input required value={connWebhookUrl} onChange={e => setConnWebhookUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." className="vsp-input w-full rounded-xl px-3 py-1.5 text-xs" />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setAddConnChannel(null)} className="rounded-xl border border-[var(--border-subtle)] px-3 py-1.5 text-xs">Cancel</button>
              <button type="submit" className="rounded-xl bg-[var(--accent-primary)] px-3.5 py-1.5 text-xs font-semibold text-white">Add Connection</button>
            </div>
          </form>
        </div>
      )}

      {lightboxShot && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/85 p-6" onClick={() => setLightboxShot(null)}>
          <img src={lightboxShot} alt="Verification screenshot" className="max-h-[90vh] max-w-[90vw] rounded-2xl border border-[var(--border-subtle)]" />
        </div>
      )}
    </div>
  );
}
