import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface RuntimeConfig {
  rootDir: string;
  dataDir: string;
  profilesDir: string;
  evidenceDir: string;
  dbPath: string;
  host: string;
  port: number;
  apiToken: string;
  mediaSigningSecret: string;
  channelsFile: string;
  allowedMediaDirs: string[];
  publicBaseUrl?: string;
  youtubePythonPath?: string;
  youtubeDirectScriptPath?: string;
}

export interface RuntimeConfigOverrides {
  rootDir?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  apiToken?: string;
  mediaSigningSecret?: string;
  channelsFile?: string;
  allowedMediaDirs?: string[];
  publicBaseUrl?: string;
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function defaultDataDir(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Vespera");
  }
  return join(homedir(), ".local", "share", "vespera");
}

function loadOrCreateSecret(filePath: string, bytes = 32): string {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length >= 32) {
      return existing;
    }
  }
  const secret = randomBytes(bytes).toString("hex");
  writeFileSync(filePath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort POSIX permission lock.
    }
  }
  return secret;
}

export function resolveRuntimeConfig(overrides?: RuntimeConfigOverrides): RuntimeConfig {
  const rootDir = resolve(overrides?.rootDir ?? process.cwd());
  loadEnvFile(join(rootDir, ".env"));

  const dataDir = resolve(
    overrides?.dataDir
      ?? (process.env.VESPERA_DATA_DIR || undefined)
      ?? defaultDataDir(),
  );
  const profilesDir = join(dataDir, "profiles");
  const evidenceDir = join(dataDir, "evidence");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const envChannelsFile = process.env.VESPERA_CHANNELS_FILE?.trim();
  const rawChannelsFile = overrides?.channelsFile ?? (envChannelsFile || "./channels.local.json");
  const channelsFile = isAbsolute(rawChannelsFile) ? rawChannelsFile : resolve(rootDir, rawChannelsFile);

  const envMediaDirs = (process.env.VESPERA_ALLOWED_MEDIA_DIRS ?? "")
    .split(/[;,]/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => resolve(v));
  const allowedMediaDirs = overrides?.allowedMediaDirs?.map(v => resolve(v)) ?? envMediaDirs;

  const apiToken =
    overrides?.apiToken
    ?? (process.env.VESPERA_API_TOKEN || undefined)
    ?? loadOrCreateSecret(join(dataDir, "api-token.txt"));
  const mediaSigningSecret =
    overrides?.mediaSigningSecret
    ?? (process.env.VESPERA_MEDIA_SECRET || undefined)
    ?? loadOrCreateSecret(join(dataDir, "media-signing-secret.txt"));

  const envPort = Number(process.env.VESPERA_PORT ?? "4660");
  const port = overrides?.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 4660);

  return {
    rootDir,
    dataDir,
    profilesDir,
    evidenceDir,
    dbPath: join(dataDir, "vespera.sqlite"),
    host: overrides?.host ?? (process.env.VESPERA_HOST || undefined) ?? "127.0.0.1",
    port,
    apiToken,
    mediaSigningSecret,
    channelsFile,
    allowedMediaDirs,
    publicBaseUrl: overrides?.publicBaseUrl ?? (process.env.VESPERA_PUBLIC_BASE_URL || undefined),
    youtubePythonPath: process.env.YOUTUBE_DIRECT_PYTHON || undefined,
    youtubeDirectScriptPath: process.env.YOUTUBE_DIRECT_SCRIPT || undefined,
  };
}
