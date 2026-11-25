import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, copyTextSafely } from "../api";
import type { BootstrapPayload } from "../types";
import type { NotifyFn } from "./ToastStack";

interface Props {
  data: BootstrapPayload;
  onNotify: NotifyFn;
  onRefresh: () => Promise<void>;
}

export function ApiMcpView({ data, onNotify, onRefresh }: Props) {
  const [keyName, setKeyName] = useState("");
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [copiedMcp, setCopiedMcp] = useState(false);

  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        vespera: {
          command: "npm",
          args: ["--prefix", "/path/to/vespera", "run", "mcp", "--silent"],
        },
      },
    },
    null,
    2,
  );

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<{ ok: boolean; rawKey: string }>("/api/api-keys", {
        name: keyName.trim() || "Automation Key",
      });
      setNewRawKey(res.rawKey);
      setKeyName("");
      await onRefresh();
      onNotify("success", "API key created. Copy it now before leaving this view.");
    } catch (err) {
      onNotify("error", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="vsp-card space-y-4 rounded-xl p-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4 text-[var(--accent-primary)]" />
            Bearer API Keys
          </h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Authenticate external scripts, CI pipelines, and n8n/Make HTTP requests with <code>Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>

        <form onSubmit={handleCreateKey} className="flex gap-2">
          <input
            value={keyName}
            onChange={e => setKeyName(e.target.value)}
            placeholder="Key label (e.g. Render Agent)"
            className="vsp-input flex-1 rounded-lg px-3 py-1.5 text-xs"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" /> Create Key
          </button>
        </form>

        {newRawKey && (
          <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-3 text-xs">
            <div className="font-semibold text-emerald-400">Copy your key now (shown once):</div>
            <code className="mt-1 block break-all font-mono text-[11px] text-[var(--text-primary)]">{newRawKey}</code>
          </div>
        )}

        <div className="space-y-2">
          {data.apiKeys.map(k => (
            <div key={k.id} className="vsp-subcard flex items-center justify-between rounded-lg px-3 py-2 text-xs">
              <div>
                <div className="font-semibold">{k.name}</div>
                <div className="font-mono text-[11px] text-[var(--text-muted)]">{k.keyPrefix}... · {k.createdAt.slice(0, 10)}</div>
              </div>
              <button
                type="button"
                aria-label={`Revoke key ${k.name}`}
                onClick={() => api.del(`/api/api-keys/${k.id}`).then(onRefresh)}
                className="text-rose-400 hover:text-rose-300"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {data.apiKeys.length === 0 && <div className="text-xs text-[var(--text-muted)]">No custom API keys created yet.</div>}
        </div>
      </div>

      <div className="space-y-4">
        <div className="vsp-card space-y-3 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">MCP Server Configuration</h3>
            <button
              type="button"
              onClick={async () => {
                const ok = await copyTextSafely(mcpSnippet);
                if (ok) {
                  setCopiedMcp(true);
                  setTimeout(() => setCopiedMcp(false), 1800);
                  onNotify("success", "Copied MCP JSON configuration.");
                } else {
                  onNotify("error", "Clipboard unavailable; select and copy manually.");
                }
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs"
            >
              {copiedMcp ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedMcp ? "Copied" : "Copy JSON"}
            </button>
          </div>
          <pre className="vsp-subcard overflow-x-auto rounded-lg p-3 font-mono text-[11px] text-[var(--text-secondary)]">
            {mcpSnippet}
          </pre>
        </div>

        <div className="vsp-card space-y-2 rounded-xl p-4 text-xs">
          <h3 className="text-sm font-semibold">REST API Reference</h3>
          <div className="space-y-1.5 font-mono text-[11px] text-[var(--text-secondary)]">
            <div><span className="text-emerald-400">GET</span> /api/bootstrap</div>
            <div><span className="text-emerald-400">GET</span> /api/analytics/intelligence</div>
            <div><span className="text-sky-400">POST</span> /api/jobs (cross-post array)</div>
            <div><span className="text-sky-400">POST</span> /api/channels/:id/connect (single-platform Edge launch)</div>
            <div><span className="text-sky-400">POST</span> /api/platforms (register custom platform)</div>
            <div><span className="text-sky-400">POST</span> /api/analytics/sync (refresh live metrics)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
