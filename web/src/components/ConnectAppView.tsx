import {
  Check,
  ExternalLink,
  FolderPlus,
  Link2,
  Pencil,
  Power,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeUrlInput, statusColorClasses } from "../api";
import type { BootstrapPayload, ChannelConnection, PlatformDefinition } from "../types";
import { NewChannelModal } from "./NewChannelModal";
import { PlatformIcon } from "./PlatformIcon";
import { ToastStack, type ToastItem, type ToastTone } from "./ToastStack";
import { VesperaLogo } from "./VesperaLogo";

interface Props {
  data: BootstrapPayload;
  refreshing?: boolean;
  justSynced?: boolean;
  lastSyncedAt?: string | null;
  onRefresh: () => Promise<void>;
}

const ORDERED_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
  "facebook",
  "reddit",
  "threads",
];

function readWorkspaceParam(channels: BootstrapPayload["channels"]): string {
  try {
    const ws = new URLSearchParams(window.location.search).get("workspace");
    if (ws && channels.some(c => c.id === ws)) return ws;
  } catch {
    // Ignore search read errors.
  }
  return channels[0]?.id ?? "";
}

export function ConnectAppView({
  data,
  refreshing = false,
  justSynced = false,
  lastSyncedAt,
  onRefresh,
}: Props) {
  const [selectedChannelId, setSelectedChannelId] = useState(() => readWorkspaceParam(data.channels));
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [editingConnId, setEditingConnId] = useState<string | null>(null);
  const [handleDraft, setHandleDraft] = useState("");

  const pollTimersRef = useRef<number[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const pushToast = useCallback((tone: ToastTone, text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts(prev => [...prev.slice(-3), { id, tone, text }]);
    const duration = tone === "error" || tone === "warning" ? 10_000 : 6_000;
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
    toastTimersRef.current.set(id, timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const id of pollTimersRef.current) window.clearTimeout(id);
      for (const id of toastTimersRef.current.values()) window.clearTimeout(id);
    };
  }, []);

  function selectChannel(id: string) {
    setSelectedChannelId(id);
    try {
      const nextUrl = `/connect?workspace=${encodeURIComponent(id)}`;
      window.history.replaceState(null, "", nextUrl);
    } catch {
      // Ignore history update errors.
    }
  }

  const selectedChannel = useMemo(
    () => data.channels.find(c => c.id === selectedChannelId) ?? data.channels[0],
    [data.channels, selectedChannelId],
  );

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data.platforms) map.set(p.id, p);
    return map;
  }, [data.platforms]);

  const cards = useMemo(() => {
    const connByPlat = new Map<string, ChannelConnection>();
    for (const c of selectedChannel?.connections ?? []) {
      connByPlat.set(c.platform, c);
    }

    const extraConns = (selectedChannel?.connections ?? [])
      .map(c => c.platform)
      .filter(pid => !ORDERED_PLATFORMS.includes(pid));

    return [...ORDERED_PLATFORMS, ...extraConns].map(pid => ({
      platformId: pid,
      def: platformById.get(pid),
      conn: connByPlat.get(pid),
    }));
  }, [selectedChannel, platformById]);

  async function launchConnect(platform?: string, explicitUrl?: string, missingConn?: boolean) {
    if (!selectedChannel) return;
    const key = `connect:${selectedChannel.id}:${platform ?? "custom"}`;
    setBusyKey(key);
    try {
      if (missingConn && platform) {
        await api.post(`/api/channels/${selectedChannel.id}/connections`, {
          platform,
          handle: platform === "reddit" ? `u/${selectedChannel.id}` : `@${selectedChannel.id}`,
          adapter: "edge_studio",
          enabled: true,
        });
      }
      const res = await api.post<{
        ok: boolean;
        mode?: string;
        oauthUrl?: string;
        command?: string;
        url: string;
      }>(`/api/channels/${selectedChannel.id}/connect`, { platform, customUrl: explicitUrl });
      if (res.oauthUrl) {
        window.location.href = res.oauthUrl;
        return;
      }
      await onRefresh();
      pushToast(
        "info",
        res.mode === "local_sync" && res.command
          ? `Server container mode: run "${res.command}" on your PC to sign in with fast native Edge and push the session automatically.`
          : `Opened Edge Connect for ${selectedChannel.name} at ${res.url}. Sign in, close Edge (auto-verify runs automatically), or click Verify after closing.`,
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
      pushToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function verifyPlatform(platform?: string) {
    if (!selectedChannel) return;
    const key = `verify:${selectedChannel.id}:${platform ?? "all"}`;
    setBusyKey(key);
    try {
      const res = await api.post<{
        ok: boolean;
        results: Array<{ platform: string; status: string; observedHandle?: string; note?: string }>;
      }>(`/api/channels/${selectedChannel.id}/check`, { platform });
      await onRefresh();
      const list = res.results ?? [];
      if (list.length === 1) {
        const item = list[0];
        const ok = item.status === "signed_in";
        const label = platformById.get(item.platform)?.name ?? item.platform;
        pushToast(
          ok ? "success" : "warning",
          ok
            ? `${label} (${selectedChannel.name}) verified: SIGNED IN${item.observedHandle ? ` as ${item.observedHandle}` : ""}.`
            : `${label} (${selectedChannel.name}) verified: ${item.status.replace(/_/g, " ").toUpperCase()}${item.note ? ` (${item.note})` : ""}.`,
        );
      } else {
        const signedIn = list.filter(x => x.status === "signed_in").length;
        const issue = list.find(x => x.status !== "signed_in");
        pushToast(
          signedIn === list.length && list.length > 0 ? "success" : "warning",
          `Checked ${list.length} account(s) on ${selectedChannel.name}: ${signedIn}/${list.length} signed in${issue ? ` (${issue.platform}: ${issue.status.replace(/_/g, " ")})` : ""}.`,
        );
      }
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
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
      pushToast("success", `Updated handle to ${trimmed}.`);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleEnabled(conn: ChannelConnection) {
    try {
      await api.patch(`/api/channels/${conn.channelId}/connections/${encodeURIComponent(conn.id)}`, {
        enabled: !conn.enabled,
      });
      await onRefresh();
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] pb-6">
      {/* Sticky Carbon Bento Top Bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]/95 backdrop-blur-md px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <VesperaLogo size={32} />
            <span className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-primary)]">
              Connect
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-400"
              title={lastSyncedAt ? `Last synced ${lastSyncedAt}` : undefined}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Online · {data.summary.signedInConnections}/{data.summary.connections} Ready
            </span>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void onRefresh()}
              aria-label="Refresh workspace"
              className={`vsp-transition inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium disabled:opacity-70 ${
                justSynced
                  ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-400"
                  : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              {justSynced && !refreshing ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin text-[var(--accent-primary)]" : ""}`} />
              )}
              <span>{refreshing ? "Refreshing..." : justSynced ? "Synced" : "Refresh"}</span>
            </button>
            <a
              href={selectedChannel ? `/?workspace=${encodeURIComponent(selectedChannel.id)}` : "/"}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)]"
            >
              Open Full Dashboard
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </header>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="mx-auto mt-4 max-w-4xl space-y-4 px-4 sm:px-6">
        {/* Workspace Picker + Self-Service + New Channel Button */}
        <div className="vsp-card flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {data.channels.map(ch => {
              const active = selectedChannel?.id === ch.id;
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => selectChannel(ch.id)}
                  className={`vsp-transition rounded-xl px-3.5 py-2 text-xs font-semibold ${
                    active
                      ? "bg-[var(--accent-primary)] text-white shadow-sm"
                      : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {ch.name}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setNewChannelOpen(true)}
              className="vsp-transition inline-flex items-center gap-1.5 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-semibold text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New Channel
            </button>
          </div>

          <button
            type="button"
            disabled={!selectedChannel || busyKey !== null}
            onClick={() => void verifyPlatform()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busyKey?.startsWith("verify:") ? "animate-spin" : ""}`} />
            {busyKey === `verify:${selectedChannel?.id}:all` ? "Checking All..." : "Check All Sessions"}
          </button>
        </div>

        {/* Authentic Social Platform Bento Cards with Inline Edit Handle + Add & Connect */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ platformId, def, conn }) => {
            const status = conn?.enabled === false ? "disabled" : conn?.sessionStatus ?? "unconnected";
            const connectKey = `connect:${selectedChannel?.id}:${platformId}`;
            const verifyKey = `verify:${selectedChannel?.id}:${platformId}`;
            const isEditing = conn && editingConnId === conn.id;

            return (
              <div key={platformId} className="vsp-card p-4 flex flex-col justify-between gap-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <PlatformIcon platformId={platformId} platform={def} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {def?.name ?? platformId}
                      </div>
                      {isEditing ? (
                        <div className="mt-1 flex items-center gap-1">
                          <input
                            value={handleDraft}
                            onChange={e => setHandleDraft(e.target.value)}
                            className="vsp-input w-full rounded-lg px-2 py-0.5 text-[11px] font-mono-num"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveHandle(conn)}
                            aria-label="Save handle"
                            className="rounded-md bg-[var(--accent-primary)] p-1 text-white"
                          >
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingConnId(null)}
                            aria-label="Cancel handle edit"
                            className="rounded-md bg-[var(--bg-elevated)] p-1 text-[var(--text-muted)]"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono-num text-[11px] text-[var(--text-muted)]">
                            {conn?.handle ?? "Not added"}
                          </span>
                          {conn && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingConnId(conn.id);
                                setHandleDraft(conn.handle);
                              }}
                              aria-label={`Edit ${def?.name ?? platformId} handle`}
                              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusColorClasses(status)}`}
                  >
                    {status.replace(/_/g, " ")}
                  </span>
                </div>

                {conn?.sessionNote && (
                  <p className="truncate text-[11px] text-[var(--text-muted)]" title={conn.sessionNote}>
                    {conn.sessionNote}
                  </p>
                )}

                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    type="button"
                    disabled={busyKey === connectKey}
                    onClick={() => void launchConnect(platformId, undefined, !conn)}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {busyKey === connectKey ? "Launching..." : conn ? "Connect" : "Add & Connect"}
                  </button>
                  <button
                    type="button"
                    disabled={busyKey === verifyKey || !conn}
                    onClick={() => void verifyPlatform(platformId)}
                    className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                  >
                    {busyKey === verifyKey ? (
                      <>
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      "Verify"
                    )}
                  </button>
                  {conn && (
                    <button
                      type="button"
                      onClick={() => void handleToggleEnabled(conn)}
                      aria-label={conn.enabled ? `Pause ${def?.name ?? platformId}` : `Enable ${def?.name ?? platformId}`}
                      title={conn.enabled ? "Pause platform" : "Enable platform"}
                      className={`rounded-xl border px-2 py-2 text-xs ${
                        conn.enabled
                          ? "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-emerald-400 hover:bg-[var(--bg-hover)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                      }`}
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Custom URL Launcher inside Isolated Profile */}
        <div className="vsp-card p-4 flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={customUrl}
            onChange={e => setCustomUrl(e.target.value)}
            placeholder="https://... launch any URL inside this isolated channel browser profile"
            className="vsp-input min-w-[220px] flex-1 rounded-xl px-3.5 py-2 text-xs"
          />
          <button
            type="button"
            disabled={!customUrl.trim() || !selectedChannel}
            onClick={() => {
              const url = normalizeUrlInput(customUrl);
              if (url) void launchConnect(undefined, url);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-semibold hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <ExternalLink className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
            Launch Custom Tab
          </button>
        </div>
      </div>

      <NewChannelModal
        open={newChannelOpen}
        platforms={data.platforms}
        onClose={() => setNewChannelOpen(false)}
        onCreated={async newId => {
          await onRefresh();
          selectChannel(newId);
          pushToast("success", `Created workspace '${newId}' with isolated Edge profile.`);
        }}
      />
    </div>
  );
}
