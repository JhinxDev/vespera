import type { PlatformDefinition } from "../types";

export function PlatformIcon({
  platformId,
  platform,
  size = "sm",
}: {
  platformId: string;
  platform?: PlatformDefinition;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const id = platformId.toLowerCase();
  const boxClass =
    size === "xs"
      ? "h-5 w-5 rounded-[6px]"
      : size === "sm"
        ? "h-7 w-7 rounded-[9px]"
        : size === "lg"
          ? "h-10 w-10 rounded-[12px]"
          : "h-8 w-8 rounded-[10px]";

  const svgSize = size === "xs" ? 12 : size === "sm" ? 16 : size === "lg" ? 22 : 18;
  const title = platform?.name ?? platformId;

  if (id === "youtube") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#FF0000] shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9.5 7.5L17 12L9.5 16.5V7.5Z" fill="#FFFFFF" />
        </svg>
      </span>
    );
  }

  if (id === "instagram") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center shadow-sm ${boxClass}`}
        style={{
          background: "linear-gradient(135deg, #F58529 0%, #DD2A7B 52%, #8134AF 82%, #515BD4 100%)",
        }}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4.5" y="4.5" width="15" height="15" rx="4.5" stroke="#FFFFFF" strokeWidth="2" />
          <circle cx="12" cy="12" r="3.4" stroke="#FFFFFF" strokeWidth="2" />
          <circle cx="16.4" cy="7.6" r="1.1" fill="#FFFFFF" />
        </svg>
      </span>
    );
  }

  if (id === "tiktok") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#090B10] border border-white/15 shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M14.2 4.5C14.7 6.5 16.1 7.9 18 8.2V11C16.5 11 15.2 10.5 14.2 9.7V14.8C14.2 17.6 11.9 19.8 9.1 19.5C6.8 19.3 5 17.4 5 15C5 12.4 7.3 10.4 9.9 10.7V13.4C8.8 13.2 7.8 14 7.8 15C7.8 16 8.6 16.8 9.6 16.8C10.8 16.8 11.5 16 11.5 14.6V4.5H14.2Z"
            fill="#25F4EE"
            transform="translate(-0.6,-0.4)"
          />
          <path
            d="M14.2 4.5C14.7 6.5 16.1 7.9 18 8.2V11C16.5 11 15.2 10.5 14.2 9.7V14.8C14.2 17.6 11.9 19.8 9.1 19.5C6.8 19.3 5 17.4 5 15C5 12.4 7.3 10.4 9.9 10.7V13.4C8.8 13.2 7.8 14 7.8 15C7.8 16 8.6 16.8 9.6 16.8C10.8 16.8 11.5 16 11.5 14.6V4.5H14.2Z"
            fill="#FE2C55"
            transform="translate(0.5,0.4)"
          />
          <path
            d="M14.2 4.5C14.7 6.5 16.1 7.9 18 8.2V11C16.5 11 15.2 10.5 14.2 9.7V14.8C14.2 17.6 11.9 19.8 9.1 19.5C6.8 19.3 5 17.4 5 15C5 12.4 7.3 10.4 9.9 10.7V13.4C8.8 13.2 7.8 14 7.8 15C7.8 16 8.6 16.8 9.6 16.8C10.8 16.8 11.5 16 11.5 14.6V4.5H14.2Z"
            fill="#FFFFFF"
          />
        </svg>
      </span>
    );
  }

  if (id === "x") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#12141A] border border-white/15 shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M17.5 4.5H20L14.5 10.8L21 19.5H15.9L11.9 14.2L7.3 19.5H4.8L10.7 12.8L4.5 4.5H9.7L13.3 9.3L17.5 4.5ZM16.6 18H18L8.9 5.9H7.4L16.6 18Z"
            fill="#FFFFFF"
          />
        </svg>
      </span>
    );
  }

  if (id === "facebook") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#1877F2] shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M14.2 20V12.8H16.6L17 9.9H14.2V8.1C14.2 7.2 14.5 6.6 15.7 6.6H17.1V4.1C16.8 4 15.9 4 14.9 4C12.7 4 11.2 5.3 11.2 7.8V9.9H8.8V12.8H11.2V20H14.2Z"
            fill="#FFFFFF"
          />
        </svg>
      </span>
    );
  }

  if (id === "reddit") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#FF4500] shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="13.5" r="5.5" fill="#FFFFFF" />
          <circle cx="7.2" cy="11.2" r="1.4" fill="#FFFFFF" />
          <circle cx="16.8" cy="11.2" r="1.4" fill="#FFFFFF" />
          <path d="M12 8L13.5 5L16.5 5.6" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16.8" cy="5.6" r="1.1" fill="#FFFFFF" />
          <circle cx="9.9" cy="13" r="0.9" fill="#FF4500" />
          <circle cx="14.1" cy="13" r="0.9" fill="#FF4500" />
          <path d="M9.6 15.5C10.5 16.3 13.5 16.3 14.4 15.5" stroke="#FF4500" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  if (id === "threads") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#181B22] border border-white/15 shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M15.4 11.4C15.1 9.5 13.9 8.5 12 8.5C10.5 8.5 9.4 9.2 9 10.3L10.7 10.9C10.9 10.3 11.4 10 12 10C12.9 10 13.5 10.5 13.6 11.3C12.7 11.1 11.7 11.1 10.8 11.4C9.2 11.9 8.4 13 8.6 14.4C8.8 15.9 10 16.8 11.7 16.8C13.3 16.8 14.4 16 14.8 14.5C15.5 14.9 16 15.5 16 16.4C16 18 14.5 19.2 12.1 19.2C8.9 19.2 6.8 17 6.8 12.2C6.8 7.6 9.1 5 12.2 5C14.8 5 16.8 6.4 17.5 9.1L15.7 9.6C15.2 7.7 13.9 6.6 12.2 6.6C10.1 6.6 8.6 8.5 8.6 12.2C8.6 15.8 10 17.6 12.1 17.6C13.5 17.6 14.3 17 14.3 16.3C14.3 15.8 14 15.4 13.4 15.2C13 15.4 12.4 15.5 11.8 15.5C10.9 15.5 10.3 15.1 10.2 14.3C10.1 13.6 10.6 13.1 11.5 12.8C12.3 12.6 13.1 12.6 13.8 12.8V12.2"
            stroke="#FFFFFF"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  if (id === "linkedin") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#0A66C2] text-white font-bold shadow-sm ${boxClass}`}
        style={{ fontSize: Math.round(svgSize * 0.65) }}
        title={title}
      >
        in
      </span>
    );
  }

  if (id === "bluesky") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#0085FF] shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 11.8C10.4 8.7 6.9 5.5 5 4.4C4.2 3.9 4 4.4 4 5.2C4 6.5 4.3 11.4 5.5 13C6.8 14.7 9.1 14.6 10.5 14.3C8.4 14.9 6.6 16.5 8.1 19C9.5 21.3 11.3 18.6 12 16.5C12.7 18.6 14.5 21.3 15.9 19C17.4 16.5 15.6 14.9 13.5 14.3C14.9 14.6 17.2 14.7 18.5 13C19.7 11.4 20 6.5 20 5.2C20 4.4 19.8 3.9 19 4.4C17.1 5.5 13.6 8.7 12 11.8Z"
            fill="#FFFFFF"
          />
        </svg>
      </span>
    );
  }

  if (id === "discord") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#5865F2] shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M17.5 6.8C16.4 6.3 15.2 5.9 14 5.7L13.5 6.7C12.5 6.5 11.5 6.5 10.5 6.7L10 5.7C8.8 5.9 7.6 6.3 6.5 6.8C4.4 10 3.8 13.1 4.1 16.1C5.5 17.1 6.9 17.8 8.3 18.2L9.2 16.9C8.6 16.7 8 16.4 7.5 16L8 15.6C10.5 16.8 13.5 16.8 16 15.6L16.5 16C16 16.4 15.4 16.7 14.8 16.9L15.7 18.2C17.1 17.8 18.5 17.1 19.9 16.1C20.2 12.6 19.3 9.5 17.5 6.8ZM9.6 14.2C8.8 14.2 8.2 13.5 8.2 12.6C8.2 11.7 8.8 11 9.6 11C10.4 11 11 11.7 11 12.6C11 13.5 10.4 14.2 9.6 14.2ZM14.4 14.2C13.6 14.2 13 13.5 13 12.6C13 11.7 13.6 11 14.4 11C15.2 11 15.8 11.7 15.8 12.6C15.8 13.5 15.2 14.2 14.4 14.2Z"
            fill="#FFFFFF"
          />
        </svg>
      </span>
    );
  }

  if (id === "telegram") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#26A5E4] shadow-sm ${boxClass}`}
        title={title}
      >
        <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18.8 5.5L4.5 11.2L9.5 13.1L16.2 8.4L11.2 13.9L16.8 18.2L18.8 5.5Z" fill="#FFFFFF" />
        </svg>
      </span>
    );
  }

  if (id === "pinterest") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center bg-[#E60023] text-white font-bold shadow-sm ${boxClass}`}
        style={{ fontSize: Math.round(svgSize * 0.72) }}
        title={title}
      >
        P
      </span>
    );
  }

  const accent = platform?.accentHex && platform.accentHex !== "#E4E4E7" && platform.accentHex !== "#D4D4D8"
    ? platform.accentHex
    : "#3B82F6";
  const label = platform?.shortCode ?? platformId.slice(0, 2).toUpperCase();

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center font-mono font-bold text-white shadow-sm ${boxClass}`}
      style={{
        backgroundColor: accent,
        fontSize: Math.max(9, Math.round(svgSize * 0.56)),
      }}
      title={title}
    >
      {label}
    </span>
  );
}
