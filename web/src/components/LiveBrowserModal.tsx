import { CheckCircle2, ExternalLink, Monitor, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import type { LiveBrowserSession } from "../types";

export interface LiveVerifyResult {
  platform: string;
  status: string;
  observedHandle?: string;
  note?: string;
}

interface Props {
  session: LiveBrowserSession | null;
  onClosed: (outcome?: { verified: boolean; results?: LiveVerifyResult[] }) => void | Promise<void>;
  onError: (message: string) => void;
}

export function LiveBrowserModal({ session, onClosed, onError }: Props) {
  const [stoppingMode, setStoppingMode] = useState<"verify" | "close" | null>(null);

  if (!session) return null;

  async function handleStop(verify: boolean) {
    setStoppingMode(verify ? "verify" : "close");
    try {
      const res = await api.post<{ ok: boolean; results?: LiveVerifyResult[] }>("/api/live-browser/stop", {
        verify,
      });
      await onClosed({ verified: verify, results: res.results });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingMode(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 p-3 sm:p-5 backdrop-blur-sm">
      <div className="vsp-card flex h-full w-full flex-col overflow-hidden border border-[var(--border-strong)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <Monitor className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Container Live Browser</h3>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {session.channelId}
                  {session.platform ? ` · ${session.platform}` : ""}
                </span>
              </div>
              <p className="truncate text-[11px] text-[var(--text-muted)]">
                Sign in or complete Google / platform 2FA inside this container browser, then click Done &amp; Verify so
                Vespera flushes cookies and trusts this profile.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={session.viewerPath}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in New Tab
            </a>
            <button
              type="button"
              disabled={stoppingMode !== null}
              onClick={() => void handleStop(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
            >
              {stoppingMode === "verify" ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Saving &amp; Verifying...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Done &amp; Verify
                </>
              )}
            </button>
            <button
              type="button"
              disabled={stoppingMode !== null}
              onClick={() => void handleStop(false)}
              className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
            >
              <X className="h-3.5 w-3.5" />
              Close
            </button>
          </div>
        </div>

        <iframe
          src={session.viewerPath}
          title="Vespera Live Browser"
          className="h-full w-full flex-1 border-0 bg-black"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
