async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; ok?: boolean };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: <T>(url: string) => requestJson<T>(url, { method: "GET" }),
  getFresh: <T>(url: string) => {
    const sep = url.includes("?") ? "&" : "?";
    return requestJson<T>(`${url}${sep}_ts=${Date.now()}`, { method: "GET" });
  },
  post: <T>(url: string, body?: unknown) =>
    requestJson<T>(url, { method: "POST", body: body !== undefined ? JSON.stringify(body) : "{}" }),
  patch: <T>(url: string, body?: unknown) =>
    requestJson<T>(url, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : "{}" }),
  del: <T>(url: string) => requestJson<T>(url, { method: "DELETE" }),
};

export async function copyTextSafely(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback on insecure HTTP origins or headless contexts.
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-9999px";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function statusColorClasses(status: string): string {
  switch (status) {
    case "published":
    case "signed_in":
      return "bg-emerald-500/12 text-emerald-400 border-emerald-500/30";
    case "scheduled":
      return "bg-sky-500/12 text-sky-400 border-sky-500/30";
    case "queued":
    case "draft":
    case "unconnected":
      return "bg-amber-500/12 text-amber-400 border-amber-500/30";
    case "running":
      return "bg-indigo-500/15 text-indigo-400 border-indigo-500/35";
    case "needs_login":
    case "needs_human_action":
    case "logged_out":
    case "challenge":
    case "failed":
      return "bg-rose-500/12 text-rose-400 border-rose-500/30";
    default:
      return "bg-zinc-500/12 text-zinc-400 border-zinc-500/30";
  }
}

export function formatTimeDisplay(isoOrDatetime: string): string {
  const m = /T(\d{2}:\d{2})/.exec(isoOrDatetime);
  return m ? m[1] : isoOrDatetime.slice(0, 10);
}

export function formatBytesCompact(bytes?: number): string {
  if (!bytes || bytes <= 0) return "No file";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}
