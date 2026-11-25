export function VesperaMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className="shrink-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="vsp-mark-bg" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1B202C" />
          <stop offset="100%" stopColor="#10131B" />
        </linearGradient>
        <linearGradient id="vsp-mark-cobalt" x1="14" y1="16" x2="32" y2="50" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="55%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
        <linearGradient id="vsp-mark-slate" x1="22" y1="18" x2="34" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7B9ACC" />
          <stop offset="100%" stopColor="#4A6593" />
        </linearGradient>
        <linearGradient id="vsp-mark-white" x1="42" y1="16" x2="29" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E2E8F0" />
        </linearGradient>
        <linearGradient id="vsp-mark-silver" x1="50" y1="20" x2="38" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#A8C1E8" />
          <stop offset="100%" stopColor="#647EB0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#vsp-mark-bg)" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
      <polygon points="22.5,17.5 27.8,17.5 34.4,37.8 30.8,44.2" fill="url(#vsp-mark-slate)" opacity="0.92" />
      <polygon points="45.2,21.5 50.4,21.5 40.4,45.5 36.2,45.5" fill="url(#vsp-mark-silver)" opacity="0.95" />
      <polygon points="13.6,17.5 20.0,17.5 31.6,49.5 26.2,49.5" fill="url(#vsp-mark-cobalt)" />
      <polygon points="39.2,17.5 45.6,17.5 32.0,49.5 26.2,49.5" fill="url(#vsp-mark-white)" />
    </svg>
  );
}

export function VesperaLogo({
  size = 32,
  subtitle,
  compact = false,
}: {
  size?: number;
  subtitle?: string;
  compact?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-2.5 min-w-0">
      <VesperaMark size={size} />
      {!compact && (
        <div className="min-w-0">
          <div className="font-wordmark text-[18px] font-medium leading-none tracking-[-0.025em] text-[var(--text-primary)]">
            Vespera
          </div>
          {subtitle && (
            <div className="mt-1 truncate text-[10px] font-medium text-[var(--text-muted)]">
              {subtitle}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
