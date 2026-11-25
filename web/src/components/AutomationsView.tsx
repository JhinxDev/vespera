import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BootstrapPayload } from "../types";
import type { NotifyFn } from "./ToastStack";

interface Props {
  data: BootstrapPayload;
  onNotify: NotifyFn;
  onRefresh: () => Promise<void>;
}

export function AutomationsView({ data, onNotify, onRefresh }: Props) {
  const [tab, setTab] = useState<"sets" | "signatures" | "plugs" | "rss" | "webhooks">("sets");

  // Forms
  const [setName, setSetName] = useState("");
  const [setTime, setSetTime] = useState("10:00");
  const [sigName, setSigName] = useState("");
  const [sigBody, setSigBody] = useState("");
  const [plugName, setPlugName] = useState("");
  const [plugScope, setPlugScope] = useState<"internal" | "global">("internal");
  const [rssName, setRssName] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [rssChannel, setRssChannel] = useState(data.channels[0]?.id ?? "");
  const [hookName, setHookName] = useState("");
  const [hookUrl, setHookUrl] = useState("");

  useEffect(() => {
    if (!rssChannel && data.channels[0]?.id) {
      setRssChannel(data.channels[0].id);
    }
  }, [data.channels, rssChannel]);

  async function runAction(label: string, fn: () => Promise<void>) {
    try {
      await fn();
      onNotify("success", label);
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--border-subtle)] pb-3">
        {[
          { id: "sets", label: `Posting Sets (${data.postingSets.length})` },
          { id: "signatures", label: `Signatures (${data.signatures.length})` },
          { id: "plugs", label: `Plugs (${data.plugs.length})` },
          { id: "rss", label: `RSS Auto-Post (${data.rssFeeds.length})` },
          { id: "webhooks", label: `Webhooks (${data.webhooks.length})` },
        ].map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as typeof tab)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              tab === t.id ? "bg-[var(--accent-primary)] text-white" : "bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sets" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!setName.trim()) return;
              await runAction("Posting set added.", async () => {
                await api.post("/api/posting-sets", {
                  name: setName.trim(),
                  timezone: "America/Toronto",
                  slots: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, time: setTime })),
                  platforms: ["youtube", "tiktok", "instagram", "x"],
                });
                setSetName("");
                await onRefresh();
              });
            }}
            className="vsp-card space-y-3 rounded-xl p-4"
          >
            <h3 className="text-sm font-semibold">New Posting Set</h3>
            <input required placeholder="Daily 10 AM Creator Window" value={setName} onChange={e => setSetName(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <input type="time" value={setTime} onChange={e => setSetTime(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <button type="submit" className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent-primary)] py-2 text-xs font-semibold text-white">
              <Plus className="h-3.5 w-3.5" /> Add Posting Set
            </button>
          </form>
          <div className="space-y-2 lg:col-span-2">
            {data.postingSets.map(ps => (
              <div key={ps.id} className="vsp-card flex items-center justify-between rounded-xl px-4 py-3 text-xs">
                <div>
                  <div className="font-semibold">{ps.name}</div>
                  <div className="text-[11px] text-[var(--text-muted)] font-mono-num">
                    {ps.timezone} · {ps.slots.length} weekly slots · {ps.platforms.join(", ")}
                  </div>
                </div>
                <button type="button" onClick={() => api.del(`/api/posting-sets/${ps.id}`).then(onRefresh)} className="text-rose-400 hover:text-rose-300" aria-label="Delete posting set">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {data.postingSets.length === 0 && <div className="vsp-card rounded-xl p-6 text-center text-xs text-[var(--text-muted)]">No posting sets created yet.</div>}
          </div>
        </div>
      )}

      {tab === "signatures" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!sigName.trim() || !sigBody.trim()) return;
              await runAction("Signature saved.", async () => {
                await api.post("/api/signatures", { name: sigName.trim(), body: sigBody.trim(), autoAppend: true });
                setSigName("");
                setSigBody("");
                await onRefresh();
              });
            }}
            className="vsp-card space-y-3 rounded-xl p-4"
          >
            <h3 className="text-sm font-semibold">New Signature CTA</h3>
            <input required placeholder="Subscribe CTA Footer" value={sigName} onChange={e => setSigName(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <textarea required rows={3} placeholder="Follow for daily archive drops." value={sigBody} onChange={e => setSigBody(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <button type="submit" className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent-primary)] py-2 text-xs font-semibold text-white">
              <Plus className="h-3.5 w-3.5" /> Save Signature
            </button>
          </form>
          <div className="space-y-2 lg:col-span-2">
            {data.signatures.map(sig => (
              <div key={sig.id} className="vsp-card flex items-start justify-between rounded-xl px-4 py-3 text-xs">
                <div>
                  <div className="font-semibold">{sig.name} {sig.autoAppend && <span className="ml-1 text-[10px] text-emerald-400">(auto-append)</span>}</div>
                  <p className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{sig.body}</p>
                </div>
                <button type="button" onClick={() => api.del(`/api/signatures/${sig.id}`).then(onRefresh)} className="text-rose-400" aria-label="Delete signature">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {data.signatures.length === 0 && <div className="vsp-card rounded-xl p-6 text-center text-xs text-[var(--text-muted)]">No signatures yet.</div>}
          </div>
        </div>
      )}

      {tab === "plugs" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!plugName.trim()) return;
              await runAction("Automation plug added.", async () => {
                await api.post("/api/plugs", {
                  name: plugName.trim(),
                  scope: plugScope,
                  triggerType: "on_publish",
                  actionType: "follow_up_comment",
                });
                setPlugName("");
                await onRefresh();
              });
            }}
            className="vsp-card space-y-3 rounded-xl p-4"
          >
            <h3 className="text-sm font-semibold">New Automation Plug</h3>
            <input required placeholder="Delayed First Comment Plug" value={plugName} onChange={e => setPlugName(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <select value={plugScope} onChange={e => setPlugScope(e.target.value as "internal" | "global")} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs">
              <option value="internal">Internal Workspace Plug</option>
              <option value="global">Global All-Channel Plug</option>
            </select>
            <button type="submit" className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent-primary)] py-2 text-xs font-semibold text-white">
              <Plus className="h-3.5 w-3.5" /> Add Plug
            </button>
          </form>
          <div className="space-y-2 lg:col-span-2">
            {data.plugs.map(plug => (
              <div key={plug.id} className="vsp-card flex items-center justify-between rounded-xl px-4 py-3 text-xs">
                <div>
                  <div className="font-semibold">{plug.name} <span className="ml-1.5 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-primary)]">{plug.scope}</span></div>
                  <div className="text-[11px] text-[var(--text-muted)]">{plug.triggerType} -&gt; {plug.actionType}</div>
                </div>
                <button type="button" onClick={() => api.del(`/api/plugs/${plug.id}`).then(onRefresh)} className="text-rose-400" aria-label="Delete plug">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {data.plugs.length === 0 && <div className="vsp-card rounded-xl p-6 text-center text-xs text-[var(--text-muted)]">No automation plugs registered yet.</div>}
          </div>
        </div>
      )}

      {tab === "rss" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!rssName.trim() || !rssUrl.trim()) return;
              await runAction("RSS feed added.", async () => {
                await api.post("/api/rss", {
                  name: rssName.trim(),
                  feedUrl: rssUrl.trim(),
                  channelId: rssChannel || data.channels[0]?.id,
                  platforms: ["x"],
                  autoPublish: false,
                });
                setRssName("");
                setRssUrl("");
                await onRefresh();
              });
            }}
            className="vsp-card space-y-3 rounded-xl p-4"
          >
            <h3 className="text-sm font-semibold">Add RSS / Atom Feed</h3>
            <input required placeholder="Engineering Blog Feed" value={rssName} onChange={e => setRssName(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <input required placeholder="https://example.com/rss.xml" value={rssUrl} onChange={e => setRssUrl(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <select value={rssChannel} onChange={e => setRssChannel(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs">
              {data.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button type="submit" className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent-primary)] py-2 text-xs font-semibold text-white">
              <Plus className="h-3.5 w-3.5" /> Add Feed
            </button>
          </form>
          <div className="space-y-2 lg:col-span-2">
            {data.rssFeeds.map(feed => (
              <div key={feed.id} className="vsp-card flex items-center justify-between rounded-xl px-4 py-3 text-xs">
                <div className="min-w-0">
                  <div className="font-semibold">{feed.name}</div>
                  <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">{feed.feedUrl}</div>
                  {feed.lastError && <div className="text-[11px] text-rose-400">{feed.lastError}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => api.post(`/api/rss/${feed.id}/sync`).then(onRefresh)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2.5 py-1 text-[11px] hover:bg-[var(--bg-hover)]">
                    <RefreshCw className="h-3 w-3" /> Sync
                  </button>
                  <button type="button" onClick={() => api.del(`/api/rss/${feed.id}`).then(onRefresh)} className="text-rose-400" aria-label="Delete feed">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
            {data.rssFeeds.length === 0 && <div className="vsp-card rounded-xl p-6 text-center text-xs text-[var(--text-muted)]">No RSS feeds configured.</div>}
          </div>
        </div>
      )}

      {tab === "webhooks" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!hookName.trim() || !hookUrl.trim()) return;
              await runAction("Webhook added.", async () => {
                await api.post("/api/webhooks", { name: hookName.trim(), targetUrl: hookUrl.trim(), events: ["*"] });
                setHookName("");
                setHookUrl("");
                await onRefresh();
              });
            }}
            className="vsp-card space-y-3 rounded-xl p-4"
          >
            <h3 className="text-sm font-semibold">Add Outbound Webhook</h3>
            <input required placeholder="Notifications Receiver" value={hookName} onChange={e => setHookName(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <input required placeholder="https://example.com/webhook" value={hookUrl} onChange={e => setHookUrl(e.target.value)} className="vsp-input w-full rounded-lg px-3 py-1.5 text-xs" />
            <button type="submit" className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent-primary)] py-2 text-xs font-semibold text-white">
              <Plus className="h-3.5 w-3.5" /> Add Webhook
            </button>
          </form>
          <div className="space-y-2 lg:col-span-2">
            {data.webhooks.map(w => (
              <div key={w.id} className="vsp-card flex items-center justify-between rounded-xl px-4 py-3 text-xs">
                <div className="min-w-0">
                  <div className="font-semibold">{w.name}</div>
                  <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">{w.targetUrl}</div>
                  <div className="font-mono text-[10px] text-[var(--text-secondary)]">HMAC prefix: {w.secret}</div>
                </div>
                <button type="button" onClick={() => api.del(`/api/webhooks/${w.id}`).then(onRefresh)} className="text-rose-400" aria-label="Delete webhook">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {data.webhooks.length === 0 && <div className="vsp-card rounded-xl p-6 text-center text-xs text-[var(--text-muted)]">No outbound webhooks registered.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
