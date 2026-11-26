import { existsSync, readFileSync } from "node:fs";

function loadPackageVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    const candidate = new URL(rel, import.meta.url);
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  }
  return "1.1.0";
}

export const VESPERA_VERSION = loadPackageVersion();
