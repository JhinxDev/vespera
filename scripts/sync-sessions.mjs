import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

function defaultLocalDataDir() {
  if (process.env.VESPERA_DATA_DIR?.trim()) return resolve(process.env.VESPERA_DATA_DIR.trim());
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Vespera");
  }
  return join(homedir(), ".local", "share", "vespera");
}

function resolveRemoteUrl(flagRemote) {
  if (flagRemote) return flagRemote.replace(/\/+$/, "");
  if (process.env.VESPERA_REMOTE_URL?.trim()) return process.env.VESPERA_REMOTE_URL.trim().replace(/\/+$/, "");
  const deployCfgPath = join(repoRoot, ".deploy.local.json");
  if (existsSync(deployCfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(deployCfgPath, "utf8"));
      if (cfg.remoteUrl) return String(cfg.remoteUrl).replace(/\/+$/, "");
      if (cfg.publicHealthUrl) {
        return new URL(String(cfg.publicHealthUrl)).origin;
      }
      if (cfg.bindIp) {
        return `http://${cfg.bindIp}:${cfg.port || 4660}`;
      }
    } catch {
      // Ignore malformed local deploy config.
    }
  }
  return "http://127.0.0.1:4660";
}

function resolveApiToken(dataDir) {
  if (process.env.VESPERA_API_TOKEN?.trim()) return process.env.VESPERA_API_TOKEN.trim();
  const tokenPath = join(dataDir, "api-token.txt");
  if (existsSync(tokenPath)) {
    const t = readFileSync(tokenPath, "utf8").trim();
    if (t) return t;
  }
  throw new Error(`Missing API token. Set VESPERA_API_TOKEN or ensure ${tokenPath} exists.`);
}

function findEdgeExe() {
  const candidates = [
    process.env.VESPERA_EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
      : undefined,
  ].filter(Boolean);
  const hit = candidates.find(p => existsSync(p));
  if (!hit) throw new Error("Microsoft Edge executable not found on this machine.");
  return hit;
}

function cleanSessionRestore(profileDir) {
  const def = join(profileDir, "Default");
  if (!existsSync(def)) return;
  const sessDir = join(def, "Sessions");
  if (existsSync(sessDir)) {
    for (const f of readdirSync(sessDir)) {
      if (f.startsWith("Session_") || f.startsWith("Tabs_")) {
        try {
          rmSync(join(sessDir, f), { force: true });
        } catch {
          // Ignore locked files.
        }
      }
    }
  }
  const prefsPath = join(def, "Preferences");
  if (existsSync(prefsPath)) {
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
      prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };
      prefs.profile = { ...(prefs.profile || {}), exit_type: "Normal", exited_cleanly: true };
      prefs.signin = { ...(prefs.signin || {}), allowed: false, allowed_on_next_startup: false };
      prefs.sync = { ...(prefs.sync || {}), requested: false };
      writeFileSync(prefsPath, JSON.stringify(prefs), "utf8");
    } catch {
      // Ignore unreadable Preferences.
    }
  }
}

async function isEdgeUsingProfile(profileDir) {
  if (process.platform !== "win32") return false;
  const needle = profileDir.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const script =
    "$n=$env:VSP_P; $h=Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -replace '/','\\').ToLowerInvariant().Contains($n) }; if($h){'LOCKED'}else{'FREE'}";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, env: { ...process.env, VSP_P: needle } },
  );
  return stdout.includes("LOCKED");
}

async function openEdgeAndWait(profileDir, url) {
  mkdirSync(profileDir, { recursive: true });
  if (await isEdgeUsingProfile(profileDir)) {
    throw new Error(`Close the already-open Edge window using ${profileDir} before running interactive sync.`);
  }
  cleanSessionRestore(profileDir);
  const exe = findEdgeExe();
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=msImplicitSignIn,msAutoSignIn",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--no-restore-last-session",
    "--new-window",
    url,
  ];
  await new Promise((resolveExit, rejectExit) => {
    const child = spawn(exe, args, { stdio: "ignore" });
    child.once("error", rejectExit);
    child.once("exit", () => resolveExit());
  });
  cleanSessionRestore(profileDir);
}

async function exportAndPushChannel(channelId, profilesDir, remoteUrl, token) {
  const profileDir = join(profilesDir, channelId);
  if (!existsSync(profileDir)) {
    return { channelId, skipped: true, reason: "Local profile directory does not exist" };
  }
  if (await isEdgeUsingProfile(profileDir)) {
    throw new Error(`Edge is currently open on ${profileDir}; close that Edge window first.`);
  }

  cleanSessionRestore(profileDir);
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "msedge",
    headless: true,
    args: ["--disable-extensions", "--disable-sync", "--disable-features=msImplicitSignIn,msAutoSignIn", "--mute-audio"],
  });
  let state;
  try {
    state = await ctx.storageState();
  } finally {
    await ctx.close();
    cleanSessionRestore(profileDir);
  }

  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const res = await fetch(`${remoteUrl}/api/channels/${encodeURIComponent(channelId)}/session-state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ cookies }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Remote sync failed for ${channelId} (${res.status}): ${json.error || res.statusText}`);
  }
  return {
    channelId,
    appliedCookies: json.appliedCookies,
    domainCount: Array.isArray(json.domains) ? json.domains.length : 0,
  };
}

function parseCliArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[k] = true;
      } else {
        flags[k] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseCliArgs(process.argv.slice(2));
  const dataDir = defaultLocalDataDir();
  const profilesDir = join(dataDir, "profiles");
  const remoteUrl = resolveRemoteUrl(typeof flags.remote === "string" ? flags.remote : undefined);
  const token = resolveApiToken(dataDir);

  const bootRes = await fetch(`${remoteUrl}/api/bootstrap`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!bootRes.ok) {
    throw new Error(`Failed to fetch bootstrap from ${remoteUrl} (${bootRes.status})`);
  }
  const boot = await bootRes.json();
  const remoteChannels = boot.channels || [];
  const platforms = boot.platforms || [];

  if (flags["export-only"]) {
    const targetId = positional[0];
    const ids = flags.all || !targetId
      ? remoteChannels.map(c => c.id)
      : [targetId];
    const summaries = [];
    for (const id of ids) {
      summaries.push(await exportAndPushChannel(id, profilesDir, remoteUrl, token));
    }
    console.log(JSON.stringify({ ok: true, remoteUrl, exported: summaries }, null, 2));
    return;
  }

  const channelId = positional[0];
  const platformId = positional[1]?.toLowerCase();
  if (!channelId || !platformId) {
    console.log("Usage:");
    console.log("  npm run sync-sessions -- <channel-id> <platform> [--remote <url>]");
    console.log("  npm run sync-sessions -- --export-only [--all | <channel-id>] [--remote <url>]");
    process.exit(1);
  }

  const ch = remoteChannels.find(c => c.id === channelId);
  if (!ch) {
    throw new Error(`Unknown remote channel '${channelId}'. Available: ${remoteChannels.map(c => c.id).join(", ")}`);
  }
  const conn = (ch.connections || []).find(c => c.platform === platformId);
  const def = platforms.find(p => p.id === platformId);
  const loginUrl = (typeof flags.url === "string" ? flags.url : undefined) || conn?.customLoginUrl || def?.loginUrl;
  if (!loginUrl) {
    throw new Error(`Could not determine login URL for platform '${platformId}'. Pass --url <url>.`);
  }

  console.log(`Opening native Edge for '${channelId}' (${platformId}) -> ${loginUrl}`);
  console.log("Sign in normally, then close that Edge window to sync cookies to Vespera...");
  await openEdgeAndWait(join(profilesDir, channelId), loginUrl);

  console.log("Exporting portable session cookies to server...");
  const synced = await exportAndPushChannel(channelId, profilesDir, remoteUrl, token);

  const checkRes = await fetch(`${remoteUrl}/api/channels/${encodeURIComponent(channelId)}/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ platform: platformId }),
  });
  const checkJson = await checkRes.json().catch(() => ({}));
  console.log(JSON.stringify({ ok: true, synced, verify: checkJson.results?.[0] ?? checkJson }, null, 2));
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
