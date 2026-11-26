import {
  AlertTriangle,
  BarChart3,
  Calendar,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Key,
  Layers,
  LayoutGrid,
  Link2,
  Menu,
  Monitor,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { AnalyticsView } from "./components/AnalyticsView";
import { ApiMcpView } from "./components/ApiMcpView";
import { AutomationsView } from "./components/AutomationsView";
import { CalendarView } from "./components/CalendarView";
import { ChannelsView } from "./components/ChannelsView";
import { ConnectAppView } from "./components/ConnectAppView";
import { JobInspectorDrawer } from "./components/JobInspectorDrawer";
import { LiveBrowserModal, type LiveVerifyResult } from "./components/LiveBrowserModal";
import { NewChannelModal } from "./components/NewChannelModal";
import { NewPostModal } from "./components/NewPostModal";
import { OverviewView } from "./components/OverviewView";
import { PlatformIcon } from "./components/PlatformIcon";
import { QueueView } from "./components/QueueView";
import { ToastStack, type ToastItem, type ToastTone } from "./components/ToastStack";
import { VesperaLogo } from "./components/VesperaLogo";
import type { BootstrapPayload, LiveBrowserSession, PlatformDefinition, PublishJob } from "./types";

export type NavView = "overview" | "calendar" | "queue" | "analytics" | "channels" | "automations" | "api";

interface NavItem {
  id: NavView;
  path: string;
  label: string;
  section: "MAIN MENU" | "CHANNELS" | "SYSTEM";
  icon: typeof Calendar;
}

const NAV_ITEMS: NavItem[] = [
  { id: "overview", path: "/", label: "Overview", section: "MAIN MENU", icon: LayoutGrid },
  { id: "calendar", path: "/calendar", label: "Calendar", section: "MAIN MENU", icon: Calendar },
  { id: "queue", path: "/queue", label: "Queue", section: "MAIN MENU", icon: Layers },
  { id: "analytics", path: "/analytics", label: "Analytics", section: "MAIN MENU", icon: BarChart3 },
  { id: "channels", path: "/channels", label: "Channels & Connect", section: "CHANNELS", icon: Link2 },
  { id: "automations", path: "/automations", label: "Automations", section: "SYSTEM", icon: Workflow },
  { id: "api", path: "/api-mcp", label: "API & MCP", section: "SYSTEM", icon: Key },
];

const NAV_SECTIONS: Array<"MAIN MENU" | "CHANNELS" | "SYSTEM"> = ["MAIN MENU", "CHANNELS", "SYSTEM"];

function parseViewFromPath(pathname: string): NavView {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/overview") return "overview";
  const found = NAV_ITEMS.find(item => item.path === clean);
  return found?.id ?? "overview";
}

function parseWorkspaceFromSearch(search: string): string {
  try {
    const params = new URLSearchParams(search);
    return params.get("workspace") || "all";
  } catch {
    return "all";
  }
}

function buildRouteUrl(view: NavView, workspaceId: string): string {
  const path = NAV_ITEMS.find(i => i.id === view)?.path ?? "/";
  if (workspaceId && workspaceId !== "all") {
    return `${path}?workspace=${encodeURIComponent(workspaceId)}`;
  }
  return path;
}

export function App() {
  const isConnectRoute =
    typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/connect";

  const [view, setView] = useState<NavView>(() =>
    typeof window === "undefined" ? "overview" : parseViewFromPath(window.location.pathname),
  );
  const [activeChannelId, setActiveChannelId] = useState<string>(() =>
    typeof window === "undefined" ? "all" : parseWorkspaceFromSearch(window.location.search),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("vespera-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<PublishJob | null>(null);
  const [newPostOpen, setNewPostOpen] = useState(false);
  const [newPostDate, setNewPostDate] = useState<string | undefined>(undefined);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [liveSession, setLiveSession] = useState<LiveBrowserSession | null>(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const syncedTimerRef = useRef<number | null>(null);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    return attr === "light" ? "light" : "dark";
  });

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

  const navigateView = useCallback(
    (nextView: NavView, nextWorkspace?: string) => {
      const targetWs = nextWorkspace ?? activeChannelId;
      setView(nextView);
      if (nextWorkspace !== undefined) {
        setActiveChannelId(nextWorkspace);
      }
      if (typeof window !== "undefined" && !isConnectRoute) {
        const nextUrl = buildRouteUrl(nextView, targetWs);
        const curUrl = `${window.location.pathname}${window.location.search}`;
        if (nextUrl !== curUrl) {
          window.history.pushState(null, "", nextUrl);
        }
      }
    },
    [activeChannelId, isConnectRoute],
  );

  const selectWorkspace = useCallback(
    (nextWs: string) => {
      setActiveChannelId(nextWs);
      if (typeof window !== "undefined" && !isConnectRoute) {
        const nextUrl = buildRouteUrl(view, nextWs);
        window.history.replaceState(null, "", nextUrl);
      }
    },
    [view, isConnectRoute],
  );

  useEffect(() => {
    if (isConnectRoute) return;
    const onPopState = () => {
      setView(parseViewFromPath(window.location.pathname));
      setActiveChannelId(parseWorkspaceFromSearch(window.location.search));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isConnectRoute]);

  const loadData = useCallback(async (manual = false) => {
    setRefreshing(true);
    const startMs = Date.now();
    try {
      const payload = await api.getFresh<BootstrapPayload>("/api/bootstrap");
      if (manual) {
        const elapsed = Date.now() - startMs;
        if (elapsed < 280) {
          await new Promise(resolve => setTimeout(resolve, 280 - elapsed));
        }
      }
      setData(payload);
      setError(null);
      setLastSyncedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      );
      setSelectedJob(cur => (cur ? payload.jobs.find(j => j.id === cur.id) ?? cur : null));
      if (manual) {
        setJustSynced(true);
        if (syncedTimerRef.current) window.clearTimeout(syncedTimerRef.current);
        syncedTimerRef.current = window.setTimeout(() => setJustSynced(false), 1800);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      if (manual) pushToast("error", `Refresh failed: ${msg}`);
    } finally {
      setRefreshing(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void loadData(false);
    return () => {
      if (syncedTimerRef.current) window.clearTimeout(syncedTimerRef.current);
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, [loadData]);

  const anyJobRunning = Boolean(data?.scheduler?.running || data?.jobs.some(j => j.status === "running"));

  useEffect(() => {
    if (isConnectRoute) return;
    const intervalMs = anyJobRunning ? 5_000 : 30_000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadData(false);
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [isConnectRoute, anyJobRunning, loadData]);

  useEffect(() => {
    if (isConnectRoute) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(v => !v);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isConnectRoute]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("vespera-theme", next);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }

  function toggleSidebarCollapse() {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem("vespera-sidebar-collapsed", String(next));
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
  }

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformDefinition>();
    for (const p of data?.platforms ?? []) map.set(p.id, p);
    return map;
  }, [data?.platforms]);

  const overdueQueuedCount = useMemo(() => {
    if (!data) return 0;
    if (typeof data.scheduler?.overdueCount === "number") {
      return data.scheduler.overdueCount;
    }
    const cutoff = Date.now() - 60_000;
    return data.jobs.filter(j => {
      if (j.status !== "queued") return false;
      const ms = Date.parse(j.publishAt);
      return Number.isFinite(ms) && ms < cutoff;
    }).length;
  }, [data]);

  async function handleToggleAutoPost() {
    if (!data?.scheduler) return;
    setSchedulerBusy(true);
    try {
      const nextEnabled = !data.scheduler.enabled;
      await api.post("/api/scheduler", { enabled: nextEnabled });
      await loadData(false);
      pushToast(
        nextEnabled ? "success" : "info",
        nextEnabled
          ? "Auto-Post enabled: Vespera will dispatch due jobs every 60 seconds."
          : "Auto-Post paused: queued jobs will wait until triggered manually.",
      );
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerBusy(false);
    }
  }

  async function handleLiveBrowserClosed(outcome?: { verified: boolean; results?: LiveVerifyResult[] }) {
    setLiveSession(null);
    await loadData(false);
    if (!outcome?.verified) {
      pushToast("info", "Closed container Live Browser.");
      return;
    }
    const list = outcome.results ?? [];
    if (list.length === 1) {
      const item = list[0];
      const ok = item.status === "signed_in";
      const label = platformById.get(item.platform)?.name ?? item.platform;
      pushToast(
        ok ? "success" : "warning",
        ok
          ? `${label} verified: SIGNED IN${item.observedHandle ? ` as ${item.observedHandle}` : ""}.`
          : `${label} status: ${item.status.replace(/_/g, " ").toUpperCase()}${item.note ? ` (${item.note})` : ""}.`,
      );
    } else if (list.length > 1) {
      const signedIn = list.filter(x => x.status === "signed_in").length;
      pushToast(signedIn === list.length ? "success" : "warning", `Verified ${signedIn}/${list.length} sessions.`);
    } else {
      pushToast("success", "Saved container Live Browser profile.");
    }
  }

  const activePlatformDef = useMemo(() => {
    if (!data || !selectedJob) return undefined;
    return data.platforms.find(p => p.id === selectedJob.platform);
  }, [data, selectedJob]);

  const cmdViews = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    return NAV_ITEMS.filter(item => !q || item.label.toLowerCase().includes(q) || item.section.toLowerCase().includes(q));
  }, [cmdQuery]);

  const cmdChannels = useMemo(() => {
    if (!data) return [];
    const q = cmdQuery.trim().toLowerCase();
    return data.channels.filter(c => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }, [data, cmdQuery]);

  const cmdMatches = useMemo(() => {
    if (!data) return [];
    const q = cmdQuery.trim().toLowerCase();
    const list = q
      ? data.jobs.filter(j => `${j.title} ${j.episode} ${j.platform} ${j.channelId}`.toLowerCase().includes(q))
      : data.jobs;
    return list.slice(0, 6);
  }, [data, cmdQuery]);

  const navMeta = NAV_ITEMS.find(i => i.id === view) ?? NAV_ITEMS[0];

  if (isConnectRoute) {
    if (!data) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--bg-canvas)] text-[var(--text-secondary)] text-xs">
          {error ? error : "Loading Vespera Connect..."}
        </div>
      );
    }
    return (
      <ConnectAppView
        data={data}
        refreshing={refreshing}
        justSynced={justSynced}
        lastSyncedAt={lastSyncedAt}
        onRefresh={() => loadData(true)}
      />
    );
  }

  return (
    <div className="flex min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Desktop Sidebar */}
      <aside
        className={`vsp-transition hidden shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] md:flex ${
          sidebarCollapsed ? "w-[74px]" : "w-[228px]"
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-4">
          <button
            type="button"
            onClick={() => navigateView("overview")}
            className="text-left focus:outline-none"
            aria-label="Go to Overview"
          >
            <VesperaLogo size={30} compact={sidebarCollapsed} subtitle="Creator Publishing" />
          </button>
          <button
            type="button"
            onClick={toggleSidebarCollapse}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {sidebarCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={() => {
              setNewPostDate(undefined);
              setNewPostOpen(true);
            }}
            className="vsp-transition inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-3 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-[var(--accent-hover)]"
            title="Schedule Post"
          >
            <Plus className="h-4 w-4 shrink-0" />
            {!sidebarCollapsed && <span>New Post</span>}
          </button>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-1">
          {NAV_SECTIONS.map(section => {
            const sectionItems = NAV_ITEMS.filter(i => i.section === section);
            return (
              <div key={section} className="space-y-1">
                {!sidebarCollapsed && (
                  <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {section}
                  </div>
                )}
                {sectionItems.map(item => {
                  const Icon = item.icon;
                  const active = view === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigateView(item.id)}
                      title={item.label}
                      className={`vsp-transition relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium ${
                        sidebarCollapsed ? "justify-center px-0" : ""
                      } ${
                        active
                          ? "bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {active && !sidebarCollapsed && (
                        <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-[var(--accent-primary)]" />
                      )}
                      <Icon className="h-4 w-4 shrink-0" />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-[var(--border-subtle)] p-3 space-y-2 text-xs">
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            aria-label="Toggle theme"
          >
            {!sidebarCollapsed && <span>{theme === "dark" ? "Carbon Dark" : "Light Surface"}</span>}
            {theme === "dark" ? <Moon className="h-3.5 w-3.5 shrink-0" /> : <Sun className="h-3.5 w-3.5 shrink-0" />}
          </button>
          {!sidebarCollapsed && (
            <div className="flex items-center justify-between px-1 text-[11px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {data?.mode === "docker" ? "Docker Node" : "Local Node"}
              </span>
              <span className="font-mono-num">v{data?.version ?? "1.1.0"}</span>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden bg-black/65" onClick={() => setMobileNavOpen(false)}>
          <div className="flex w-68 flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-4 border-b border-[var(--border-subtle)]">
              <VesperaLogo size={28} />
              <button type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-1 flex-1">
              {NAV_ITEMS.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      navigateView(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium ${
                      view === item.id
                        ? "bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold"
                        : "text-[var(--text-secondary)]"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className="flex items-center justify-between rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-xs"
            >
              <span>{theme === "dark" ? "Carbon Dark" : "Light Surface"}</span>
              {theme === "dark" ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]/95 backdrop-blur-md px-4 py-3 md:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              className="rounded-xl p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] md:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-tight text-[var(--text-primary)]">{navMeta.label}</h1>
              <p className="text-[11px] text-[var(--text-muted)]">
                {data
                  ? `${data.summary.channels} workspaces · ${data.summary.totalJobs} queue items${lastSyncedAt ? ` · Synced ${lastSyncedAt}` : ""}`
                  : "Loading workspace..."}
              </p>
            </div>
          </div>

          {/* Center Search Pill */}
          <button
            type="button"
            onClick={() => setCmdOpen(true)}
            className="hidden lg:flex w-full max-w-sm items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
          >
            <span className="inline-flex items-center gap-2">
              <Search className="h-3.5 w-3.5" />
              Search pages, channels, jobs...
            </span>
            <kbd className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-[10px] border border-[var(--border-subtle)]">
              ⌘K
            </kbd>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              aria-label="Search workspace"
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] lg:hidden"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
            {data && (
              <select
                aria-label="Active workspace scope"
                value={activeChannelId}
                onChange={e => selectWorkspace(e.target.value)}
                className="vsp-input hidden sm:block rounded-xl px-3 py-1.5 text-xs font-medium"
              >
                <option value="all">All Workspaces</option>
                {data.channels.map(ch => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name}
                  </option>
                ))}
              </select>
            )}
            {data?.scheduler && (
              <button
                type="button"
                disabled={schedulerBusy}
                onClick={() => void handleToggleAutoPost()}
                title={data.scheduler.enabled ? "Auto-Post is active (click to pause)" : "Auto-Post is paused (click to enable)"}
                className={`vsp-transition hidden md:inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${
                  data.scheduler.enabled
                    ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-400 hover:bg-emerald-500/20"
                    : "border-amber-500/35 bg-amber-500/12 text-amber-300 hover:bg-amber-500/20"
                }`}
              >
                {data.scheduler.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                <span>{data.scheduler.enabled ? "Auto-Post: ON" : "Auto-Post: Paused"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] md:hidden"
            >
              {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => void loadData(true)}
              disabled={refreshing}
              aria-label="Refresh workspace"
              className={`vsp-transition inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium disabled:opacity-70 ${
                justSynced
                  ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-400"
                  : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {justSynced && !refreshing ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin text-[var(--accent-primary)]" : ""}`} />
              )}
              <span className="hidden sm:inline">
                {refreshing ? "Refreshing..." : justSynced ? "Synced" : "Refresh"}
              </span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 md:p-6">
          {error && (
            <div className="mb-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
              {error}
            </div>
          )}

          {data && !data.scheduler?.enabled && overdueQueuedCount > 0 && (
            <div className="mb-4 vsp-card flex flex-wrap items-center justify-between gap-3 border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-xs">
              <div className="flex items-center gap-2.5 text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                <span>
                  <strong>Auto-Post is paused</strong> with{" "}
                  <strong className="font-mono-num">{overdueQueuedCount}</strong> overdue queued post(s) past their scheduled slot.
                </span>
              </div>
              <button
                type="button"
                disabled={schedulerBusy}
                onClick={() => void handleToggleAutoPost()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60"
              >
                <Play className="h-3.5 w-3.5" />
                Enable Auto-Post
              </button>
            </div>
          )}

          {data?.liveBrowser?.session?.active && !liveSession && (
            <div className="mb-4 vsp-card flex flex-wrap items-center justify-between gap-3 border border-emerald-500/35 bg-emerald-500/8 px-4 py-3 text-xs">
              <div className="flex items-center gap-2.5">
                <Monitor className="h-4 w-4 text-emerald-400" />
                <span>
                  <strong>Active Live Browser:</strong>{" "}
                  {data.liveBrowser.session.channelId}
                  {data.liveBrowser.session.platform ? ` (${data.liveBrowser.session.platform})` : ""} is running on the server.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLiveSession(data.liveBrowser?.session ?? null)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                <Monitor className="h-3.5 w-3.5" />
                Resume Live Browser
              </button>
            </div>
          )}

          {!data ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="vsp-card h-40 animate-pulse" />
              ))}
            </div>
          ) : view === "overview" ? (
            <OverviewView
              data={data}
              activeChannelId={activeChannelId}
              onSelectChannel={selectWorkspace}
              onSelectJob={job => setSelectedJob(job)}
              onOpenNewPost={date => {
                setNewPostDate(date);
                setNewPostOpen(true);
              }}
              onOpenNewChannel={() => setNewChannelOpen(true)}
              onNavigateChannels={() => navigateView("channels")}
              onNavigateCalendar={() => navigateView("calendar")}
              onOpenLiveBrowser={setLiveSession}
              onNotify={pushToast}
              onRefresh={() => loadData(false)}
            />
          ) : view === "calendar" ? (
            <CalendarView
              data={data}
              activeChannelId={activeChannelId}
              onSelectChannel={selectWorkspace}
              onSelectJob={job => setSelectedJob(job)}
              onOpenNewPost={date => {
                setNewPostDate(date);
                setNewPostOpen(true);
              }}
            />
          ) : view === "queue" ? (
            <QueueView
              data={data}
              activeChannelId={activeChannelId}
              onSelectChannel={selectWorkspace}
              onSelectJob={job => setSelectedJob(job)}
              onNotify={pushToast}
              onRefresh={() => loadData(false)}
            />
          ) : view === "analytics" ? (
            <AnalyticsView
              data={data}
              activeChannelId={activeChannelId}
              onSelectChannel={selectWorkspace}
              onNotify={pushToast}
              onRefresh={() => loadData(false)}
            />
          ) : view === "channels" ? (
            <ChannelsView
              data={data}
              activeChannelId={activeChannelId}
              onOpenLiveBrowser={setLiveSession}
              onNotify={pushToast}
              onRefresh={() => loadData(false)}
            />
          ) : view === "automations" ? (
            <AutomationsView data={data} onNotify={pushToast} onRefresh={() => loadData(false)} />
          ) : (
            <ApiMcpView data={data} onNotify={pushToast} onRefresh={() => loadData(false)} />
          )}
        </main>
      </div>

      {/* Command Search Palette Modal */}
      {cmdOpen && data && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-20" onClick={() => setCmdOpen(false)}>
          <div className="vsp-card w-full max-w-lg overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3">
              <Search className="h-4 w-4 text-[var(--text-muted)]" />
              <input
                autoFocus
                value={cmdQuery}
                onChange={e => setCmdQuery(e.target.value)}
                placeholder="Jump to page, workspace, or queue item..."
                className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
              <button type="button" onClick={() => setCmdOpen(false)} aria-label="Close search" className="text-[var(--text-muted)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto p-2 space-y-3">
              {cmdViews.length > 0 && (
                <div>
                  <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Pages
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {cmdViews.map(item => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            navigateView(item.id);
                            setCmdOpen(false);
                          }}
                          className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                        >
                          <Icon className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {cmdChannels.length > 0 && (
                <div>
                  <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Channels &amp; Workspaces
                  </div>
                  <div className="space-y-1">
                    {cmdChannels.map(ch => (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => {
                          navigateView("channels", ch.id);
                          setCmdOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
                      >
                        <span className="font-medium text-[var(--text-primary)]">{ch.name}</span>
                        <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
                          {ch.connections.filter(c => c.enabled).length} enabled
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Queue Jobs
                </div>
                <div className="space-y-1">
                  {cmdMatches.map(job => (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => {
                        setSelectedJob(job);
                        setCmdOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <PlatformIcon platformId={job.platform} platform={platformById.get(job.platform)} size="xs" />
                        <span className="truncate font-medium text-[var(--text-primary)]">{job.title}</span>
                      </div>
                      <span className="shrink-0 font-mono-num text-[11px] text-[var(--text-muted)]">
                        {job.channelId} · {job.targetDate}
                      </span>
                    </button>
                  ))}
                  {cmdMatches.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">No matching queue items.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <JobInspectorDrawer
        job={selectedJob}
        platformDef={activePlatformDef}
        onClose={() => setSelectedJob(null)}
        onOpenLiveBrowser={setLiveSession}
        onNotify={pushToast}
        onUpdated={() => loadData(false)}
      />

      {data && (
        <NewPostModal
          open={newPostOpen}
          defaultDate={newPostDate}
          activeChannelId={activeChannelId}
          data={data}
          onClose={() => setNewPostOpen(false)}
          onCreated={() => loadData(false)}
        />
      )}

      {data && (
        <NewChannelModal
          open={newChannelOpen}
          platforms={data.platforms}
          onClose={() => setNewChannelOpen(false)}
          onCreated={async newId => {
            await loadData(false);
            selectWorkspace(newId);
          }}
        />
      )}

      <LiveBrowserModal
        session={liveSession}
        onClosed={handleLiveBrowserClosed}
        onError={msg => pushToast("error", msg)}
      />
    </div>
  );
}
