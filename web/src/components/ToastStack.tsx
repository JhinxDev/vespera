import { AlertTriangle, CheckCircle2, Info, ShieldAlert, X } from "lucide-react";

export type ToastTone = "success" | "warning" | "error" | "info";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  text: string;
}

export type NotifyFn = (tone: ToastTone, text: string) => void;

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed top-[68px] right-4 z-[70] flex w-[calc(100vw-2rem)] max-w-md flex-col gap-2"
    >
      {toasts.map(toast => {
        const toneClasses =
          toast.tone === "success"
            ? "border-emerald-500/40 bg-[#121C19]/95 text-emerald-200"
            : toast.tone === "warning"
              ? "border-amber-500/45 bg-[#1F1A12]/95 text-amber-200"
              : toast.tone === "error"
                ? "border-rose-500/45 bg-[#211318]/95 text-rose-200"
                : "border-blue-500/40 bg-[#141A26]/95 text-slate-100";

        const Icon =
          toast.tone === "success"
            ? CheckCircle2
            : toast.tone === "warning"
              ? AlertTriangle
              : toast.tone === "error"
                ? ShieldAlert
                : Info;

        return (
          <div
            key={toast.id}
            data-testid="toast-item"
            role="status"
            className={`pointer-events-auto flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-xs shadow-2xl backdrop-blur-md ${toneClasses}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1 leading-relaxed">{toast.text}</span>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded-md p-0.5 opacity-75 hover:bg-white/10 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
