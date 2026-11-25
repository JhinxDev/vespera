import type { PlatformDefinition } from "../types";
import { PlatformIcon } from "./PlatformIcon";

export function PlatformBadge({
  platformId,
  platform,
  size = "sm",
}: {
  platformId: string;
  platform?: PlatformDefinition;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return <PlatformIcon platformId={platformId} platform={platform} size={size} />;
}
