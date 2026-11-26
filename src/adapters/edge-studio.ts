import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page } from "playwright";

const execFileAsync = promisify(execFile);
import type { AdapterExecutionOptions, PublishAdapter } from "./types.js";
import type {
  ChannelConfig,
  ChannelConnection,
  ExecutionResult,
  PlatformDefinition,
  PublishJob,
  SessionCheckResult,
  SessionState,
} from "../types.js";

export const LINUX_CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export function normalizeHandle(value?: string): string {
  return (value ?? "").trim().replace(/^@+/, "").toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseYouTubeTimestampSeconds(ts: string): number | null {
  const parts = ts.split(":").map(Number);
  if (parts.some(n => !Number.isInteger(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, s] = parts;
    return s < 60 ? m * 60 + s : null;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
  }
  return null;
}

export function normalizeYouTubeDescriptionForChapters(description: string): {
  text: string;
  chapterCount: number;
  reordered: boolean;
  warnings: string[];
} {
  const cleanText = description.replace(/\r\n?/g, "\n").replace(/[\u00a0\u200b\ufeff]/g, " ");
  const paragraphs = cleanText.trim().split(/\n{2,}/);
  const tsLineRx = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/;
  const headingRx = /^(?:chapters|timestamps):?$/i;

  let blockStart = -1;
  let blockEnd = -1;
  let timestamps: Array<{ seconds: number; cleanLine: string }> = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const rawLines = paragraphs[i].split("\n").map(l => l.trim()).filter(Boolean);
    if (rawLines.length === 0) continue;
    const hasHeading = rawLines.length > 1 && headingRx.test(rawLines[0]);
    const bodyLines = hasHeading ? rawLines.slice(1) : rawLines;
    const parsed: Array<{ seconds: number; cleanLine: string }> = [];
    let allMatch = bodyLines.length > 0;
    for (const line of bodyLines) {
      const m = tsLineRx.exec(line);
      const sec = m ? parseYouTubeTimestampSeconds(m[1]) : null;
      if (!m || sec === null) {
        allMatch = false;
        break;
      }
      parsed.push({ seconds: sec, cleanLine: `${m[1]} ${m[2].trim()}` });
    }
    if (allMatch) {
      blockStart = !hasHeading && i > 0 && headingRx.test(paragraphs[i - 1].trim()) ? i - 1 : i;
      blockEnd = i;
      timestamps = parsed;
      paragraphs[i] = hasHeading
        ? [rawLines[0], ...parsed.map(p => p.cleanLine)].join("\n")
        : parsed.map(p => p.cleanLine).join("\n");
      break;
    }
  }

  if (timestamps.length === 0) {
    return { text: cleanText.trim(), chapterCount: 0, reordered: false, warnings: [] };
  }

  const warnings: string[] = [];
  if (timestamps.length < 3) {
    warnings.push(`YouTube chapters require at least 3 timestamps (found ${timestamps.length}).`);
  }
  if (timestamps[0].seconds !== 0) {
    warnings.push("YouTube chapters must start at 0:00.");
  }
  for (let k = 1; k < timestamps.length; k++) {
    if (timestamps[k].seconds <= timestamps[k - 1].seconds) {
      warnings.push("YouTube chapter timestamps must be strictly ascending.");
      break;
    }
    if (timestamps[k].seconds - timestamps[k - 1].seconds < 10) {
      warnings.push("Each YouTube chapter must be at least 10 seconds long.");
      break;
    }
  }

  let reordered = false;
  if (warnings.length === 0) {
    const firstUrlIdx = paragraphs.findIndex((p, idx) => idx < blockStart && /https?:\/\//i.test(p));
    if (firstUrlIdx !== -1) {
      const chapterSlice = paragraphs.slice(blockStart, blockEnd + 1);
      const remaining = [...paragraphs.slice(0, blockStart), ...paragraphs.slice(blockEnd + 1)];
      remaining.splice(firstUrlIdx, 0, ...chapterSlice);
      paragraphs.splice(0, paragraphs.length, ...remaining);
      reordered = true;
    }
  }

  return {
    text: paragraphs.join("\n\n"),
    chapterCount: timestamps.length,
    reordered,
    warnings,
  };
}

export function verifyExpectedHandle(
  observed: string | undefined,
  expected: string,
): { ok: boolean; reason?: string } {
  if (!observed || !observed.trim()) {
    return {
      ok: false,
      reason: `Could not verify active handle against expected '${expected}'.`,
    };
  }
  if (normalizeHandle(observed) !== normalizeHandle(expected)) {
    return {
      ok: false,
      reason: `Active account '${observed}' does not match expected '${expected}'.`,
    };
  }
  return { ok: true };
}

export function detectAuthOrChallengeSnapshot(
  url: string,
  bodyText: string,
  platform: string,
): { status: SessionState; reason?: string } {
  const lowerUrl = url.toLowerCase();
  const lowerText = bodyText.toLowerCase();

  const challengeSignals = [
    "verify you are human",
    "complete the captcha",
    "security check",
    "drag the slider",
    "two-factor authentication",
    "enter verification code",
    "unusual login activity",
    "account has been suspended",
    "we suspended your account",
    "confirm it's you",
    "verify it's you",
    "confirm it's really you",
    "we need to confirm it's really you",
    "verify your identity",
    "you are using an unsupported browser",
    "blocked by network security",
    "you've been blocked by network security",
    "prove your humanity",
  ];
  for (const sig of challengeSignals) {
    if (lowerText.includes(sig)) {
      return { status: "challenge", reason: `Platform challenge or suspension detected on ${platform}: '${sig}'` };
    }
  }

  const signedInSignals = [
    "you are already logged in",
    "already logged in and will be redirected",
  ];
  if (signedInSignals.some(s => lowerText.includes(s))) {
    return { status: "signed_in" };
  }

  const loginUrls = [
    "accounts.google.com",
    "tiktok.com/login",
    "x.com/i/flow/login",
    "twitter.com/i/flow/login",
    "instagram.com/accounts/login",
    "instagram.com/accounts/suspended",
    "facebook.com/login",
    "facebook.com/checkpoint",
    "reddit.com/login",
    "reddit.com/register",
    "js_challenge=",
    "jsc_token=",
    "threads.net/login",
    "linkedin.com/login",
    "bsky.app/login",
  ];
  if (loginUrls.some(u => lowerUrl.includes(u))) {
    return { status: "logged_out", reason: `Redirected to ${platform} sign-in URL (${url})` };
  }

  const loginTexts = [
    "log in to tiktok",
    "log into instagram",
    "sign in to x",
    "happening now",
    "log into facebook",
    "log in to reddit",
    "continue with instagram",
    "create new account",
  ];
  if (
    loginTexts.some(t => lowerText.includes(t))
    && !lowerUrl.includes("studio.youtube.com/channel/")
  ) {
    return { status: "logged_out", reason: `Sign-in wall visible on ${platform}` };
  }

  return { status: "signed_in" };
}

export function formatMonthDayYear(isoDate: string): { monthName: string; day: number; year: number } {
  const [y, m, d] = isoDate.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { monthName: months[(m ?? 1) - 1] ?? "Nov", day: d ?? 24, year: y ?? 2026 };
}

export function formatTime12h(hhmm: string): string {
  const [rawH, rawM] = hhmm.split(":").map(Number);
  const h = Number.isFinite(rawH) ? rawH : 10;
  const m = Number.isFinite(rawM) ? rawM : 0;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function truncateAtWordBoundary(text: string, maxLen: number): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen);
  const lastSpace = sliced.search(/\s+\S*$/);
  if (lastSpace > Math.floor(maxLen * 0.45)) {
    return sliced.slice(0, lastSpace).trimEnd();
  }
  return sliced.trimEnd();
}

export function isVerticalCropPreserved(metrics: {
  videoWidth: number;
  videoHeight: number;
  frameWidth: number;
  frameHeight: number;
}): boolean {
  if (metrics.videoHeight <= metrics.videoWidth) return true;
  if (metrics.frameWidth <= 0 || metrics.frameHeight <= 0) return false;
  return metrics.frameHeight / metrics.frameWidth >= 1.25;
}

export class ProfileLockedError extends Error {
  readonly statusCode = 409;
}

export async function isProfileInUseByEdge(profileDir: string): Promise<boolean> {
  if (!profileDir) return false;
  if (process.platform === "win32") {
    const normalized = profileDir.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (!normalized) return false;
    try {
      const psScript = [
        "$needle = $env:VESPERA_CHECK_PROFILE",
        "$hits = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -replace '/', '\\').ToLowerInvariant().Contains($needle) }",
        "if ($hits) { 'LOCKED' } else { 'FREE' }",
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        {
          windowsHide: true,
          timeout: 8_000,
          env: { ...process.env, VESPERA_CHECK_PROFILE: normalized },
        },
      );
      return stdout.includes("LOCKED");
    } catch {
      return false;
    }
  }

  try {
    await execFileAsync("pgrep", ["-f", profileDir], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function closeProfileBrowser(profileDir: string): Promise<boolean> {
  if (!profileDir || process.platform === "win32") return false;
  try {
    await execFileAsync("pkill", ["-TERM", "-f", profileDir], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function findSystemEdgeExecutable(): string {
  const candidates = process.platform === "linux"
    ? [
        process.env.VESPERA_BROWSER_PATH,
        process.env.VESPERA_EDGE_PATH,
        "/usr/bin/microsoft-edge",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        (() => {
          try {
            return chromium.executablePath();
          } catch {
            return undefined;
          }
        })(),
      ].filter((p): p is string => Boolean(p))
    : [
        process.env.VESPERA_BROWSER_PATH,
        process.env.VESPERA_EDGE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
          : undefined,
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ].filter((p): p is string => Boolean(p));

  const hit = candidates.find(candidate => existsSync(candidate));
  if (!hit) {
    throw new Error(
      process.platform === "linux"
        ? "Browser executable not found. Install Playwright Chromium or set VESPERA_BROWSER_PATH."
        : "Microsoft Edge executable not found. Set VESPERA_EDGE_PATH to msedge.exe.",
    );
  }
  return hit;
}

/**
 * Strip Edge's previous-window tab-restore snapshots so interactive Connect launches
 * open only the requested URL instead of restoring stale Playwright or prior Connect tabs.
 * Auth cookies, Local Storage, IndexedDB, and saved credentials are never touched.
 */
export function clearProfileSessionRestore(profileDir: string): void {
  const defaultDir = join(profileDir, "Default");
  if (!existsSync(defaultDir)) return;

  const sessionsDir = join(defaultDir, "Sessions");
  if (existsSync(sessionsDir)) {
    try {
      for (const entry of readdirSync(sessionsDir)) {
        if (entry.startsWith("Session_") || entry.startsWith("Tabs_")) {
          try {
            rmSync(join(sessionsDir, entry), { force: true });
          } catch {
            // Best-effort cleanup for unlocked tab-restore snapshot files.
          }
        }
      }
    } catch {
      // Ignore transient directory-read failures.
    }
  }

  for (const legacyFile of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    try {
      rmSync(join(defaultDir, legacyFile), { force: true });
    } catch {
      // Best-effort legacy file cleanup.
    }
  }

  const prefsPath = join(defaultDir, "Preferences");
  if (existsSync(prefsPath)) {
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
      const prevSession = typeof prefs.session === "object" && prefs.session ? (prefs.session as Record<string, unknown>) : {};
      const prevProfile = typeof prefs.profile === "object" && prefs.profile ? (prefs.profile as Record<string, unknown>) : {};
      const prevSignin = typeof prefs.signin === "object" && prefs.signin ? (prefs.signin as Record<string, unknown>) : {};
      const prevSync = typeof prefs.sync === "object" && prefs.sync ? (prefs.sync as Record<string, unknown>) : {};
      prefs.session = { ...prevSession, restore_on_startup: 5 };
      prefs.profile = { ...prevProfile, exit_type: "Normal", exited_cleanly: true };
      prefs.signin = { ...prevSignin, allowed: false, allowed_on_next_startup: false };
      prefs.sync = { ...prevSync, requested: false };
      writeFileSync(prefsPath, JSON.stringify(prefs), "utf8");
    } catch {
      // Preserve Preferences untouched if unreadable or invalid JSON.
    }
  }
}

export function buildNativeEdgeLoginArgs(profileDir: string, urls: string[]): string[] {
  return [
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
    ...urls,
  ];
}

export function buildLinuxBrowserConnectArgs(profileDir: string, urls: string[]): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US",
    "--window-size=1360,900",
    "--window-position=0,0",
    "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--no-restore-last-session",
    "--new-window",
    ...urls,
  ];
}

function cleanupEphemeralXvfb(xvfb: ChildProcess | undefined): void {
  if (xvfb && xvfb.exitCode === null && xvfb.signalCode === null) {
    try {
      xvfb.kill("SIGTERM");
    } catch {
      // Ignore already-exited Xvfb child.
    }
    setTimeout(() => {
      try {
        if (xvfb.exitCode === null && xvfb.signalCode === null) {
          xvfb.kill("SIGKILL");
        }
      } catch {
        // Ignore already-exited Xvfb child.
      }
    }, 1000).unref?.();
  }
  for (const p of ["/tmp/.X98-lock", "/tmp/.X11-unix/X98"]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best-effort X98 socket/lock cleanup.
    }
  }
}

export async function launchChannelEdge(
  profileDir: string,
  headless: boolean,
): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  if (process.platform === "win32") {
    return chromium.launchPersistentContext(profileDir, {
      channel: "msedge",
      headless,
      viewport: { width: 1360, height: 900 },
      args: [
        "--disable-extensions",
        "--disable-sync",
        "--disable-features=msImplicitSignIn,msAutoSignIn",
        "--mute-audio",
      ],
    });
  }

  for (const lockFile of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(join(profileDir, lockFile), { force: true });
    } catch {
      // Clear stale POSIX Chromium locks left by recreated containers or crashed processes.
    }
  }

  let ephemeralXvfb: ChildProcess | undefined;
  let ephemeralDisplay: string | undefined;
  if (process.platform === "linux" && !headless && !process.env.DISPLAY && existsSync("/usr/bin/Xvfb")) {
    cleanupEphemeralXvfb(undefined);
    const proc = spawn("/usr/bin/Xvfb", [":98", "-screen", "0", "1360x900x24", "-ac", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (existsSync("/tmp/.X11-unix/X98")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (existsSync("/tmp/.X11-unix/X98")) {
      ephemeralXvfb = proc;
      ephemeralDisplay = ":98";
    } else {
      cleanupEphemeralXvfb(proc);
    }
  }

  const effectiveHeadless = process.platform === "linux" && !process.env.DISPLAY && !ephemeralDisplay ? true : headless;
  const customBrowser = process.env.VESPERA_BROWSER_PATH?.trim() || undefined;
  try {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      ...(customBrowser ? { executablePath: customBrowser } : {}),
      ...(ephemeralDisplay ? { env: { ...process.env, DISPLAY: ephemeralDisplay } } : {}),
      headless: effectiveHeadless,
      viewport: { width: 1360, height: 900 },
      ...(effectiveHeadless ? { userAgent: LINUX_CHROME_USER_AGENT } : {}),
      locale: "en-US",
      timezoneId: process.env.TZ?.trim() || "UTC",
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--disable-sync",
        "--mute-audio",
      ],
    });
    if (ephemeralXvfb) {
      ctx.once("close", () => cleanupEphemeralXvfb(ephemeralXvfb));
    }
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    return ctx;
  } catch (err) {
    cleanupEphemeralXvfb(ephemeralXvfb);
    throw err;
  }
}

async function waitForPlatformHydration(page: Page, platform: string): Promise<void> {
  const selectorMap: Record<string, string> = {
    youtube: "ytcp-entity-page, #create-icon, ytcp-home-page, input[type='email'], form",
    tiktok: "input[type='file'], [data-e2e], main, form",
    instagram: "svg[aria-label='New post'], main, form, input[name='username']",
    x: "[data-testid='primaryColumn'], [data-testid='SideNav_NewTweet_Button'], input[autocomplete='username'], main",
    facebook: "[role='main'], [aria-label='Facebook'], input[name='email']",
    reddit: "shreddit-app, main, input[name='username'], [name='title']",
    threads: "main, [role='main'], input, form",
  };
  const sel = selectorMap[platform] ?? "main, form, body";
  await page.locator(sel).first().waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 25, { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function inspectPlatformPage(
  page: Page,
  platform: string,
  expectedHandle: string,
  targetUrl: string,
  evidenceDir: string,
  channelId: string,
): Promise<SessionCheckResult> {
  const checkedAt = new Date().toISOString();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitForPlatformHydration(page, platform);

  if (platform === "youtube") {
    const skipBtn = page.getByText(/skip to youtube studio/i).first();
    if (await skipBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await skipBtn.click().catch(() => {});
      await waitForPlatformHydration(page, platform);
    }
  }

  const url = page.url();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 8000);
  const detection = detectAuthOrChallengeSnapshot(url, bodyText, platform);

  let observedHandle: string | undefined;
  if (detection.status === "signed_in") {
    const regex = new RegExp(`(?:@|u/)?${normalizeHandle(expectedHandle).replace(/^u\//, "")}`, "i");
    const match = regex.exec(bodyText) ?? regex.exec(url);
    if (match) {
      observedHandle = expectedHandle;
    } else {
      const redditHandle = /\bu\/([A-Za-z0-9_-]{2,30})\b/.exec(bodyText);
      const anyHandle = /@[A-Za-z0-9._-]{2,40}/.exec(bodyText);
      if (platform === "reddit" && redditHandle) observedHandle = `u/${redditHandle[1]}`;
      else if (anyHandle) observedHandle = anyHandle[0];
    }
  }

  mkdirSync(evidenceDir, { recursive: true });
  const shotName = `${channelId}-${platform}-check-${Date.now()}.png`;
  const shotPath = join(evidenceDir, shotName);
  await page.screenshot({ path: shotPath }).catch(() => {});

  return {
    channelId,
    platform,
    status: detection.status,
    expectedHandle,
    observedHandle,
    checkedAt,
    url,
    screenshotFile: shotName,
    note: detection.reason,
  };
}

export async function applyStorageStateToProfile(
  profileDir: string,
  state: { cookies?: Array<Record<string, unknown>> },
): Promise<{ appliedCookies: number; domains: string[] }> {
  const rawCookies = Array.isArray(state.cookies) ? state.cookies : [];
  type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];
  const normalized: PlaywrightCookie[] = [];

  for (const item of rawCookies) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name : "";
    const value = typeof item.value === "string" ? item.value : "";
    const domain = typeof item.domain === "string" ? item.domain : "";
    if (!name || !domain) continue;
    const path = typeof item.path === "string" && item.path ? item.path : "/";
    const rawExpires = typeof item.expires === "number" && Number.isFinite(item.expires) ? item.expires : undefined;
    const sameSiteRaw = item.sameSite;
    const sameSite =
      sameSiteRaw === "Strict" || sameSiteRaw === "Lax" || sameSiteRaw === "None" ? sameSiteRaw : undefined;

    normalized.push({
      name,
      value,
      domain,
      path,
      ...(rawExpires !== undefined && rawExpires > 0 ? { expires: rawExpires } : {}),
      ...(typeof item.httpOnly === "boolean" ? { httpOnly: item.httpOnly } : {}),
      ...(typeof item.secure === "boolean" ? { secure: item.secure } : {}),
      ...(sameSite ? { sameSite } : {}),
    });
  }

  mkdirSync(profileDir, { recursive: true });
  const ctx = await launchChannelEdge(profileDir, true);
  try {
    if (normalized.length > 0) {
      await ctx.addCookies(normalized);
    }
  } finally {
    await ctx.close();
    clearProfileSessionRestore(profileDir);
  }

  const domains = Array.from(new Set(normalized.map(c => (c.domain ?? "").replace(/^\./, "")).filter(Boolean))).sort();
  return { appliedCookies: normalized.length, domains };
}

export class EdgeStudioAdapter implements PublishAdapter {
  readonly kind = "edge_studio" as const;

  constructor(
    private readonly evidenceDir: string,
    private readonly resolvePlatformDef: (id: string) => PlatformDefinition | undefined,
  ) {
    mkdirSync(evidenceDir, { recursive: true });
  }

  resolveConnectionUrls(connection: ChannelConnection): { loginUrl: string; composeUrl: string; analyticsUrl?: string } {
    const def = this.resolvePlatformDef(connection.platform);
    const loginUrl = connection.customLoginUrl ?? def?.loginUrl ?? "https://www.google.com/";
    const composeUrl = connection.customComposeUrl ?? def?.composeUrl ?? loginUrl;
    const analyticsUrl = connection.customAnalyticsUrl ?? def?.analyticsUrl ?? loginUrl;
    return { loginUrl, composeUrl, analyticsUrl };
  }

  async openPlatformConnect(
    channel: ChannelConfig,
    url: string,
    options: { waitForClose?: boolean } = {},
  ): Promise<{ launchedAt: string; url: string; pid?: number }> {
    mkdirSync(channel.profileDir, { recursive: true });
    if (!(await isProfileInUseByEdge(channel.profileDir))) {
      clearProfileSessionRestore(channel.profileDir);
    }
    const exe = findSystemEdgeExecutable();
    const args = process.platform === "win32"
      ? buildNativeEdgeLoginArgs(channel.profileDir, [url])
      : buildLinuxBrowserConnectArgs(channel.profileDir, [url]);
    const launchedAt = new Date().toISOString();

    if (options.waitForClose) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(exe, args, { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      return { launchedAt, url };
    }

    if (process.platform === "win32") {
      // Delegate interactive launches through Explorer's Windows Shell COM object so Edge always opens
      // on the user's real WinSta0\Default desktop even when Vespera runs inside a background daemon.
      const argLine = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        "$shell = New-Object -ComObject Shell.Application",
        "$windows = $shell.Windows()",
        "$loc = 0; $root = 0; $hwnd = 0",
        "$desktop = $windows.FindWindowSW([ref]$loc, [ref]$root, 8, [ref]$hwnd, 1)",
        "if ($null -eq $desktop -or $hwnd -eq 0) { throw 'Interactive Explorer desktop unavailable.' }",
        "$desktop.Document.Application.ShellExecute($env:VESPERA_LAUNCH_EXE, $env:VESPERA_LAUNCH_ARG_LINE, $env:VESPERA_LAUNCH_CWD, 'open', 1)",
        "Write-Output 'DelegatedToWindowsShell'",
      ].join("; ");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        {
          windowsHide: true,
          timeout: 15_000,
          env: {
            ...process.env,
            VESPERA_LAUNCH_EXE: exe,
            VESPERA_LAUNCH_ARG_LINE: argLine,
            VESPERA_LAUNCH_CWD: channel.profileDir,
          },
        },
      );
      return { launchedAt, url };
    }

    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
    return { launchedAt, url, pid: child.pid };
  }

  async checkSessions(
    channel: ChannelConfig,
    options: { platform?: string; headless?: boolean } = {},
  ): Promise<SessionCheckResult[]> {
    const targets = channel.connections.filter(c =>
      options.platform ? c.platform === options.platform : c.enabled,
    );
    if (targets.length === 0) return [];

    if (await isProfileInUseByEdge(channel.profileDir)) {
      throw new ProfileLockedError(
        `Close the open Edge window for '${channel.name}' first so Vespera can inspect the saved session.`,
      );
    }

    const results: SessionCheckResult[] = [];
    const requestedHeadless = options.headless ?? true;
    let ctx = await launchChannelEdge(channel.profileDir, requestedHeadless);
    const emptyShellPlatforms: ChannelConnection[] = [];

    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      for (const conn of targets) {
        const { loginUrl } = this.resolveConnectionUrls(conn);
        const res = await inspectPlatformPage(page, conn.platform, conn.handle, loginUrl, this.evidenceDir, channel.id);
        // YouTube Studio frequently renders an empty SPA shell in headless mode; recheck visibly when a display exists.
        const canLaunchVisible = process.platform !== "linux" || Boolean(process.env.DISPLAY);
        if (requestedHeadless && canLaunchVisible && conn.platform === "youtube" && !res.note && !res.observedHandle) {
          emptyShellPlatforms.push(conn);
        } else {
          results.push(res);
        }
      }
    } finally {
      await ctx.close();
      clearProfileSessionRestore(channel.profileDir);
    }

    if (emptyShellPlatforms.length > 0) {
      ctx = await launchChannelEdge(channel.profileDir, false);
      try {
        const page = ctx.pages()[0] ?? await ctx.newPage();
        for (const conn of emptyShellPlatforms) {
          const { loginUrl } = this.resolveConnectionUrls(conn);
          const res = await inspectPlatformPage(page, conn.platform, conn.handle, loginUrl, this.evidenceDir, channel.id);
          results.push(res);
        }
      } finally {
        await ctx.close();
        clearProfileSessionRestore(channel.profileDir);
      }
    }

    return results;
  }

  async execute(
    job: PublishJob,
    channel: ChannelConfig,
    connection: ChannelConnection,
    options: AdapterExecutionOptions = {},
  ): Promise<ExecutionResult> {
    if (!connection.enabled) {
      return { status: "failed", message: `Connection '${job.platform}' is disabled on '${channel.id}'.` };
    }

    const { loginUrl, composeUrl } = this.resolveConnectionUrls(connection);
    const headless = options.headless ?? (job.platform === "youtube" ? false : true);
    const ctx = await launchChannelEdge(channel.profileDir, headless);

    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const check = await inspectPlatformPage(
        page,
        job.platform,
        connection.handle,
        options.dryRun ? loginUrl : composeUrl,
        this.evidenceDir,
        channel.id,
      );

      if (check.status === "logged_out") {
        return {
          status: "needs_login",
          screenshotFile: check.screenshotFile,
          message: check.note ?? `${job.platform} is logged out in profile '${channel.id}'. Use Connect to sign in.`,
        };
      }
      if (check.status === "challenge") {
        return {
          status: "needs_human_action",
          screenshotFile: check.screenshotFile,
          message: check.note ?? `${job.platform} presented a verification challenge.`,
        };
      }

      if (options.dryRun) {
        return {
          status: "queued",
          dryRun: true,
          screenshotFile: check.screenshotFile,
          message: `Dry-run passed: ${job.platform} ready for ${channel.id} (${connection.handle}).`,
        };
      }

      if (job.platform === "youtube") {
        const skipBtn = page.getByText(/skip to youtube studio/i).first();
        if (await skipBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await skipBtn.click().catch(() => {});
          await waitForPlatformHydration(page, "youtube");
        }
      }

      if (job.platform === "tiktok") return await this.runTikTokUpload(page, job, channel);
      if (job.platform === "youtube") return await this.runYouTubeUpload(page, job, channel);
      if (job.platform === "x") return await this.runXPost(page, job, channel);
      if (job.platform === "instagram") return await this.runInstagramReel(page, job, channel);
      if (job.platform === "facebook") return await this.runFacebookPost(page, job, channel);
      if (job.platform === "reddit") return await this.runRedditPost(page, job, channel);
      if (job.platform === "threads") return await this.runThreadsPost(page, job, channel);

      const shot = await this.saveShot(page, `${channel.id}-${job.platform}-manual`);
      return {
        status: "needs_human_action",
        screenshotFile: shot,
        message: `Opened custom web studio (${composeUrl}); complete automated selector mapping or configure a webhook adapter for '${job.platform}'.`,
      };
    } catch (error) {
      const shotName = `${channel.id}-${job.platform}-err-${Date.now()}.png`;
      await (ctx.pages()[0]?.screenshot({ path: join(this.evidenceDir, shotName) }).catch(() => {}));
      return {
        status: "failed",
        screenshotFile: shotName,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await ctx.close();
      clearProfileSessionRestore(channel.profileDir);
    }
  }

  private async saveShot(page: Page, prefix: string): Promise<string> {
    const name = `${prefix}-${Date.now()}.png`;
    await page.screenshot({ path: join(this.evidenceDir, name) });
    return name;
  }

  private buildPostCopy(job: PublishJob): string {
    const base = job.payload.caption ?? job.payload.postText ?? job.payload.description ?? job.title;
    const tags = job.payload.hashtags?.length ? `\n\n${job.payload.hashtags.join(" ")}` : "";
    return `${base}${tags}`.trim();
  }

  private async runTikTokUpload(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const check = detectAuthOrChallengeSnapshot(page.url(), bodyText, "tiktok");
    if (check.status !== "signed_in") {
      return {
        status: check.status === "challenge" ? "needs_human_action" : "needs_login",
        screenshotFile: await this.saveShot(page, `${channel.id}-tiktok-gate`),
        message: check.reason ?? "TikTok session gate",
      };
    }

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 25_000 });
    await fileInput.setInputFiles(job.videoPath);

    // Dismiss TikTok Studio first-run Joyride onboarding tooltips if present
    await page.waitForTimeout(1500);
    for (const label of [/got it/i, /skip/i, /close/i]) {
      const dismissBtn = page.getByRole("button", { name: label }).first();
      if (await dismissBtn.isVisible().catch(() => false)) {
        await dismissBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    await page.evaluate(() => {
      document.getElementById("react-joyride-portal")?.remove();
    }).catch(() => {});

    const captionBox = page.locator('[contenteditable="true"]').first();
    await captionBox.waitFor({ state: "visible", timeout: 35_000 });
    await captionBox.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(this.buildPostCopy(job));
    await page.keyboard.press("Escape");

    if (job.payload.aiDisclosure) {
      const showMore = page.getByText(/show more/i).first();
      if (await showMore.isVisible().catch(() => false)) {
        await showMore.click().catch(() => {});
      }
      const aiSection = page.locator("div").filter({ hasText: /ai-generated content/i }).last();
      const switchBtn = aiSection.locator('input[type="checkbox"], [role="switch"]').first();
      if (await switchBtn.isVisible().catch(() => false)) {
        const checked = await switchBtn.getAttribute("aria-checked").catch(() => null);
        if (checked !== "true") {
          await switchBtn.click().catch(() => {});
        }
      }
    }

    const nowMs = Date.now();
    const targetMs = Date.parse(job.publishAt);
    const shouldPostNow = job.publishNowIfPastSlot && nowMs >= targetMs;
    const actionLabel = shouldPostNow ? /^post$/i : /^schedule$/i;

    if (!shouldPostNow) {
      const scheduleRadio = page.getByText(/^schedule$/i).first();
      if (await scheduleRadio.isVisible().catch(() => false)) {
        await scheduleRadio.click().catch(() => {});
      }
    }

    await page.waitForTimeout(4500);
    const submitBtn = page.getByRole("button", { name: actionLabel }).last();
    await submitBtn.waitFor({ state: "visible", timeout: 45_000 });
    if (await submitBtn.isDisabled().catch(() => false)) {
      return {
        status: "needs_human_action",
        screenshotFile: await this.saveShot(page, `${channel.id}-tiktok-blocked`),
        message: `TikTok ${shouldPostNow ? "Post" : "Schedule"} button remained disabled (processing or date slot pending).`,
      };
    }

    await submitBtn.click();
    await page.waitForTimeout(3500);
    const postText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const gateAfter = detectAuthOrChallengeSnapshot(page.url(), postText, "tiktok");
    const shot = await this.saveShot(page, `${channel.id}-tiktok-done`);
    if (gateAfter.status === "challenge") {
      return { status: "needs_human_action", screenshotFile: shot, message: gateAfter.reason ?? "TikTok challenge" };
    }

    return {
      status: shouldPostNow ? "published" : "scheduled",
      screenshotFile: shot,
      message: `TikTok Studio submitted (${shouldPostNow ? "posted now" : `scheduled ${job.targetDate} ${channel.defaultPostTime}`}).`,
    };
  }

  private async checkYouTubeChallenge(page: Page, channel: ChannelConfig): Promise<ExecutionResult | null> {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 8000);
    const detection = detectAuthOrChallengeSnapshot(page.url(), bodyText, "youtube");
    if (detection.status === "challenge") {
      const shot = await this.saveShot(page, `${channel.id}-youtube-challenge`);
      return {
        status: "needs_human_action",
        screenshotFile: shot,
        message:
          "Google requested 'Verify it's you' in YouTube Studio. Open Live Browser for this channel to verify once, then retry the job.",
      };
    }
    return null;
  }

  private async runYouTubeUpload(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    const createBtn = page.getByRole("button", { name: /create/i }).first();
    await createBtn.waitFor({ state: "visible", timeout: 25_000 });
    await createBtn.click();
    await page.getByText(/upload videos/i).first().click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 25_000 });
    await fileInput.setInputFiles(job.videoPath);

    const titleBox = page.locator("#textbox").first();
    const challengePrompt = page.getByText(/verify it's you|confirm it's really you/i).first();
    const raceOutcome = await Promise.race([
      titleBox.waitFor({ state: "visible", timeout: 35_000 }).then(() => "ready" as const),
      challengePrompt.waitFor({ state: "visible", timeout: 35_000 }).then(() => "challenge" as const),
    ]).catch(() => "timeout" as const);

    const earlyChallenge = await this.checkYouTubeChallenge(page, channel);
    if (earlyChallenge || raceOutcome === "challenge") {
      return (
        earlyChallenge ?? {
          status: "needs_human_action",
          screenshotFile: await this.saveShot(page, `${channel.id}-youtube-challenge`),
          message:
            "Google requested 'Verify it's you' in YouTube Studio. Open Live Browser for this channel to verify once, then retry the job.",
        }
      );
    }

    await titleBox.waitFor({ state: "visible", timeout: 10_000 });
    await titleBox.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText((job.payload.title ?? job.title).slice(0, 100));

    const appliedExtras: string[] = [];
    const descBox = page.locator("#textbox").nth(1);
    const rawDescCopy = job.payload.description ?? this.buildPostCopy(job);
    const chapterMeta = rawDescCopy
      ? normalizeYouTubeDescriptionForChapters(rawDescCopy)
      : { text: "", chapterCount: 0, reordered: false, warnings: [] };
    if (chapterMeta.chapterCount >= 3 && chapterMeta.warnings.length === 0) {
      appliedExtras.push(`chapters(${chapterMeta.chapterCount})`);
    }
    if (chapterMeta.text && await descBox.isVisible().catch(() => false)) {
      await descBox.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText(chapterMeta.text.slice(0, 5000));
    }

    const thumbPath = job.payload.thumbnailPath ?? job.coverPath;
    if (thumbPath && existsSync(thumbPath)) {
      const thumbInput = page.locator('ytcp-thumbnail-uploader input[type="file"]').first();
      if ((await thumbInput.count()) > 0) {
        await thumbInput.setInputFiles(thumbPath).catch(() => {});
      }
    }

    const kidsSelector =
      job.payload.madeForKids === true
        ? 'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_MFK"]'
        : 'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]';
    const kidsRadio = page.locator(kidsSelector);
    if (await kidsRadio.isVisible().catch(() => false)) {
      await kidsRadio.click();
    }

    const needsShowMore = Boolean(
      job.payload.aiDisclosure ||
      job.payload.tags?.length ||
      job.payload.videoLanguage ||
      job.payload.category,
    );
    if (needsShowMore) {
      const showMore = page.locator("#toggle-button").or(page.getByRole("button", { name: /show more/i })).first();
      if (await showMore.isVisible().catch(() => false)) {
        await showMore.scrollIntoViewIfNeeded().catch(() => {});
        await showMore.click();
        await page.waitForTimeout(500);
      }

      if (job.payload.aiDisclosure) {
        const alteredYes = page
          .locator('tp-yt-paper-radio-button[name="VIDEO_HAS_ALTERED_CONTENT_YES"], tp-yt-paper-radio-button[name="HAS_ALTERED_CONTENT_YES"]')
          .first();
        if (await alteredYes.isVisible().catch(() => false)) {
          await alteredYes.scrollIntoViewIfNeeded().catch(() => {});
          await alteredYes.click();
          appliedExtras.push("altered-content");
        }
      }

      if (job.payload.tags?.length) {
        try {
          const tagsInput = page
            .locator('#tags-container input#text-input, ytcp-form-input-container#tags-container input, input[aria-label="Tags"]')
            .first();
          await tagsInput.scrollIntoViewIfNeeded().catch(() => {});
          await tagsInput.waitFor({ state: "visible", timeout: 4000 });
          await tagsInput.click();
          await tagsInput.fill(job.payload.tags.join(", ").slice(0, 490));
          await page.keyboard.press("Enter");
          await page.waitForTimeout(300);
          appliedExtras.push(`tags(${job.payload.tags.length})`);
        } catch {
          // Optional field; continue publish without aborting.
        }
      }

      if (job.payload.videoLanguage) {
        try {
          const langTrigger = page
            .locator("#language-input ytcp-dropdown-trigger, ytcp-form-language-input ytcp-dropdown-trigger")
            .first();
          await langTrigger.scrollIntoViewIfNeeded().catch(() => {});
          await langTrigger.waitFor({ state: "visible", timeout: 4000 });
          await langTrigger.click();
          await page.waitForTimeout(350);
          const langPattern = new RegExp(`^\\s*${escapeRegExp(job.payload.videoLanguage.trim())}\\s*$`, "i");
          const langOption = page.locator("tp-yt-paper-item").filter({ hasText: langPattern }).first();
          if (await langOption.isVisible({ timeout: 3000 }).catch(() => false)) {
            await langOption.click();
            await page.waitForTimeout(300);
            appliedExtras.push(`language=${job.payload.videoLanguage}`);
          } else {
            await page.keyboard.press("Escape").catch(() => {});
          }
        } catch {
          await page.keyboard.press("Escape").catch(() => {});
        }
      }

      if (job.payload.category) {
        try {
          const catTrigger = page
            .locator("#category ytcp-dropdown-trigger, ytcp-form-select#category ytcp-dropdown-trigger")
            .first();
          await catTrigger.scrollIntoViewIfNeeded().catch(() => {});
          await catTrigger.waitFor({ state: "visible", timeout: 4000 });
          await catTrigger.click();
          await page.waitForTimeout(350);
          const catPattern = new RegExp(`^\\s*${escapeRegExp(job.payload.category.trim())}\\s*$`, "i");
          const catOption = page.locator("tp-yt-paper-item").filter({ hasText: catPattern }).first();
          if (await catOption.isVisible({ timeout: 3000 }).catch(() => false)) {
            await catOption.click();
            await page.waitForTimeout(300);
            appliedExtras.push(`category=${job.payload.category}`);
          } else {
            await page.keyboard.press("Escape").catch(() => {});
          }
        } catch {
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
    }

    let captionsNote = "";
    for (let step = 0; step < 3; step++) {
      const nextBtn = page.locator("#next-button");
      await nextBtn.waitFor({ state: "visible", timeout: 20_000 });
      await nextBtn.click();
      await page.waitForTimeout(900);

      if (step === 0 && job.payload.captionsPath && existsSync(job.payload.captionsPath)) {
        try {
          const subRow = page.locator("ytcp-video-metadata-subtitles, #subtitles-row, ytcp-uploads-video-elements").first();
          const addSubBtn = subRow
            .locator('#subtitles-button, button:has-text("Add"), ytcp-button:has-text("Add")')
            .first();
          await addSubBtn.waitFor({ state: "visible", timeout: 4000 });
          const isDisabled = await addSubBtn.isDisabled().catch(() => false);
          const ariaDisabled = await addSubBtn.getAttribute("aria-disabled").catch(() => null);
          if (!isDisabled && ariaDisabled !== "true") {
            await addSubBtn.click();
            const uploadFileBtn = page.getByText(/upload file/i).first();
            await uploadFileBtn.waitFor({ state: "visible", timeout: 5000 });
            await uploadFileBtn.click();
            const withTiming = page.getByText(/with timing/i).first();
            if (await withTiming.isVisible({ timeout: 2000 }).catch(() => false)) {
              await withTiming.click();
            }
            const continueBtn = page.getByRole("button", { name: /continue/i }).first();
            if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await continueBtn.click();
            }
            const capInput = page
              .locator('ytcp-captions-upload-dialog input[type="file"], ytcp-dialog input[type="file"], input[type="file"]')
              .last();
            await capInput.waitFor({ state: "attached", timeout: 6000 });
            await capInput.setInputFiles(job.payload.captionsPath);
            await page.waitForTimeout(1500);
            const doneSubBtn = page
              .locator('ytcp-captions-editor #done-button, ytcp-dialog #save-button, ytcp-button:has-text("Done")')
              .last();
            if (await doneSubBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
              await doneSubBtn.click();
              await page.waitForTimeout(800);
            }
            captionsNote = "captions attached";
          } else {
            captionsNote = "captions skipped";
          }
        } catch {
          captionsNote = "captions skipped";
        }
      }
    }

    const nowMs = Date.now();
    const targetMs = Date.parse(job.publishAt);
    const shouldPublishNow = job.publishNowIfPastSlot && nowMs >= targetMs;

    if (shouldPublishNow) {
      const publicRadio = page.locator('tp-yt-paper-radio-button[name="PUBLIC"]').first();
      await publicRadio.waitFor({ state: "visible", timeout: 20_000 });
      await publicRadio.click();
    } else {
      const { monthName, day, year } = formatMonthDayYear(job.targetDate);
      const scheduleRadio = page.locator('#schedule-radio-button, tp-yt-paper-radio-button[name="SCHEDULE"]').first();
      await scheduleRadio.click();
      const dateInput = page.locator('input[aria-label*="date" i], #datepicker-trigger input').first();
      if (await dateInput.isVisible().catch(() => false)) {
        await dateInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.insertText(`${monthName} ${day}, ${year}`);
        await page.keyboard.press("Enter");
      }
      const timeInput = page.locator('input[aria-label*="time" i], #time-of-day-container input').first();
      if (await timeInput.isVisible().catch(() => false)) {
        await timeInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.insertText(formatTime12h(channel.defaultPostTime));
        await page.keyboard.press("Enter");
      }
    }

    const doneBtn = page.locator("#done-button");
    await doneBtn.waitFor({ state: "visible", timeout: 25_000 });
    await page.waitForTimeout(1500);
    await doneBtn.click();
    await page.waitForTimeout(2500);

    const postChallenge = await this.checkYouTubeChallenge(page, channel);
    if (postChallenge) {
      return postChallenge;
    }

    const publishAnywayBtn = page.getByRole("button", { name: /publish anyway/i }).first();
    if (await publishAnywayBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
      await publishAnywayBtn.click();
      await page.waitForTimeout(2500);
    }

    await page.waitForTimeout(2000);
    const uploadDialog = page.locator("ytcp-uploads-dialog, ytcp-video-share-dialog").first();
    const shareLink = await uploadDialog
      .locator('a[href*="youtu.be/"], a[href*="youtube.com/shorts/"], a[href*="youtube.com/watch"]')
      .first()
      .getAttribute("href")
      .catch(() => undefined);
    let remoteId: string | undefined;
    if (shareLink) {
      try {
        const parsed = new URL(shareLink, "https://www.youtube.com");
        remoteId = parsed.searchParams.get("v") ?? parsed.pathname.split("/").filter(Boolean).pop();
      } catch {
        remoteId = shareLink.split("/").pop()?.split("?")[0];
      }
    }
    if (remoteId && shouldPublishNow && chapterMeta.chapterCount >= 3 && chapterMeta.warnings.length === 0) {
      try {
        const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(remoteId)}`, {
          headers: { "Accept-Language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const watchHtml = await res.text();
          if (watchHtml.includes("macroMarkersListItemRenderer") || watchHtml.includes("chapterRenderer")) {
            appliedExtras.push("chapters-verified");
          }
        }
      } catch {
        // Non-fatal; chapter indexing can lag a few seconds right after publish.
      }
    }

    const summaryParts = [...appliedExtras, ...(captionsNote ? [captionsNote] : [])];
    const summarySuffix = summaryParts.length > 0 ? ` [${summaryParts.join(", ")}]` : "";
    const shot = await this.saveShot(page, `${channel.id}-youtube-done`);
    return {
      status: shouldPublishNow ? "published" : "scheduled",
      remoteUrl: shareLink ?? undefined,
      remoteId,
      screenshotFile: shot,
      message: `${
        shouldPublishNow
          ? `Published YouTube video (${shareLink ?? job.handle}).`
          : `Scheduled YouTube video for ${job.targetDate} ${channel.defaultPostTime}.`
      }${summarySuffix}`,
    };
  }

  private async runXPost(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    if (Date.now() < Date.parse(job.publishAt)) {
      return {
        status: "queued",
        message: `Skipped X post because scheduled slot (${job.publishAt}) is still in the future.`,
      };
    }

    if (job.videoPath) {
      const fileInput = page.locator('input[type="file"][data-testid="fileInput"], input[type="file"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 20_000 });
      await fileInput.setInputFiles(job.videoPath);
      await page.waitForTimeout(4500);
    }

    const editor = page.locator('[data-testid="tweetTextarea_0"]').first();
    await editor.waitFor({ state: "visible", timeout: 20_000 });
    await editor.click();
    await page.keyboard.insertText(truncateAtWordBoundary(this.buildPostCopy(job), 280));
    // Dismiss hashtag/mention autocomplete listbox only if open; never press Escape twice or a Discard modal opens.
    const acListbox = page.locator('[role="listbox"]').first();
    if (await acListbox.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    const postBtn = page.locator('div[role="dialog"] [data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
    await postBtn.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('div[role="dialog"] [data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
        return Boolean(el && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
      },
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(800);
    await postBtn.click();
    await page.waitForTimeout(4500);

    const shot = await this.saveShot(page, `${channel.id}-x-done`);
    return {
      status: "published",
      screenshotFile: shot,
      message: `Posted update on X (${job.handle}).`,
    };
  }

  private async runInstagramReel(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    if (Date.now() < Date.parse(job.publishAt)) {
      return {
        status: "queued",
        message: `Skipped Instagram Reel because slot (${job.publishAt}) is still in the future.`,
      };
    }

    const createLink = page.getByRole("link", { name: /create|new post/i }).or(page.getByText(/^create$/i)).first();
    await createLink.waitFor({ state: "visible", timeout: 20_000 });
    await createLink.click();
    await page.waitForTimeout(800);

    const postMenuOption = page.getByRole("link", { name: /^post$/i }).or(page.getByText(/^post$/i)).first();
    if (await postMenuOption.isVisible({ timeout: 2000 }).catch(() => false)) {
      await postMenuOption.click();
      await page.waitForTimeout(600);
    }

    const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').last();
    await fileInput.waitFor({ state: "attached", timeout: 20_000 });
    await fileInput.setInputFiles(job.videoPath);
    await page.waitForTimeout(2200);

    // Dismiss Instagram's one-time "Video posts are now shared as reels" announcement modal
    const okBtn = page.getByRole("button", { name: /^ok$/i }).first();
    if (await okBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
      await okBtn.click();
      await page.waitForTimeout(600);
    }

    // Instagram Web defaults uploaded videos to 1:1 square crop. Switch to 9:16 portrait or Original before Next, and fail closed if still square.
    const dialogRoot = page.locator('[role="dialog"]').last();
    const cropBtn = dialogRoot
      .locator('button:has(svg[aria-label*="Select crop" i]), [role="button"]:has(svg[aria-label*="Select crop" i])')
      .first();
    if (await cropBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await cropBtn.click();
      await page.waitForTimeout(700);
      const portraitOpt = dialogRoot
        .locator(
          '[role="button"]:has(svg[aria-label*="Crop portrait" i]), button:has(svg[aria-label*="Crop portrait" i]), [role="button"]:has-text("9:16"), [role="button"]:has-text("Original")',
        )
        .first();
      await portraitOpt.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      if (await portraitOpt.isVisible().catch(() => false)) {
        await portraitOpt.click();
        await page.waitForTimeout(900);
      }
      // Close the crop submenu cleanly before inspecting framing & proceeding
      await cropBtn.click().catch(() => {});
      await page.waitForTimeout(400);
    }

    const cropMetrics = await page.evaluate(() => {
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).pop();
      const video = dialog?.querySelector("video") as HTMLVideoElement | null;
      if (!dialog || !video) return null;
      let minArea = Infinity;
      let frameW = 0;
      let frameH = 0;
      let el: HTMLElement | null = video.parentElement;
      while (el && dialog.contains(el)) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (
          rect.width > 100
          && rect.height > 100
          && (style.overflow === "hidden" || style.overflowX === "hidden" || style.overflowY === "hidden")
        ) {
          const area = rect.width * rect.height;
          if (area < minArea) {
            minArea = area;
            frameW = rect.width;
            frameH = rect.height;
          }
        }
        el = el.parentElement;
      }
      if (frameW === 0) {
        const vr = video.getBoundingClientRect();
        frameW = vr.width;
        frameH = vr.height;
      }
      return {
        videoWidth: video.videoWidth || 1080,
        videoHeight: video.videoHeight || 1920,
        frameWidth: Math.round(frameW),
        frameHeight: Math.round(frameH),
      };
    });

    const cropShot = await this.saveShot(page, `${channel.id}-instagram-crop`);
    if (cropMetrics && !isVerticalCropPreserved(cropMetrics)) {
      return {
        status: "needs_human_action",
        screenshotFile: cropShot,
        message: `Refused to publish Instagram Reel: crop viewport stayed square (${cropMetrics.frameWidth}x${cropMetrics.frameHeight}) instead of 9:16.`,
      };
    }

    const nextSelector = dialogRoot.locator('div[role="button"]:text-is("Next"), button:text-is("Next")');
    await nextSelector.first().waitFor({ state: "visible", timeout: 30_000 });
    await nextSelector.first().click();
    await page.waitForTimeout(1200);
    if (await nextSelector.first().isVisible().catch(() => false)) {
      await nextSelector.first().click();
    }

    const captionBox = page
      .locator('div[aria-label*="Add a caption" i], div[aria-label*="Write a caption" i], div[role="textbox"][contenteditable="true"]')
      .first();
    await captionBox.waitFor({ state: "visible", timeout: 20_000 });
    await captionBox.click();
    await page.keyboard.insertText(this.buildPostCopy(job));

    if (job.payload.aiDisclosure) {
      const aiSwitch = page.locator('input[role="switch"], [role="switch"]').first();
      if (await aiSwitch.isVisible().catch(() => false)) {
        const checked = await aiSwitch.getAttribute("aria-checked").catch(() => null);
        if (checked !== "true") {
          await aiSwitch.click().catch(() => {});
        }
      }
    }

    const dialogScope = page.locator('[role="dialog"]').last();
    const shareBtn = dialogScope
      .locator('div[role="button"]:text-is("Share"), button:text-is("Share")')
      .last();
    await shareBtn.waitFor({ state: "visible", timeout: 20_000 });
    await shareBtn.click();
    await page.getByText(/your reel has been shared|reel shared|post shared/i).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const shot = await this.saveShot(page, `${channel.id}-instagram-done`);
    return {
      status: "published",
      screenshotFile: shot,
      message: `Shared Instagram Reel for ${job.handle}.`,
    };
  }

  private async runFacebookPost(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    const fileInput = page.locator('input[type="file"]').first();
    if (job.videoPath && (await fileInput.count()) > 0) {
      await fileInput.setInputFiles(job.videoPath);
      await page.waitForTimeout(3000);
    }
    const editor = page.locator('[contenteditable="true"], textarea').first();
    if (await editor.isVisible().catch(() => false)) {
      await editor.click();
      await page.keyboard.insertText(this.buildPostCopy(job));
      const publishBtn = page.getByRole("button", { name: /publish|share|post/i }).last();
      if (await publishBtn.isVisible().catch(() => false) && !(await publishBtn.isDisabled().catch(() => true))) {
        await publishBtn.click();
        await page.waitForTimeout(3500);
        return {
          status: "published",
          screenshotFile: await this.saveShot(page, `${channel.id}-facebook-done`),
          message: `Submitted Facebook post for ${job.handle}.`,
        };
      }
    }
    return {
      status: "needs_human_action",
      screenshotFile: await this.saveShot(page, `${channel.id}-facebook-review`),
      message: "Facebook composer opened; confirm page selection and Publish button in Meta Business Suite.",
    };
  }

  private async runRedditPost(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    const titleInput = page.locator('textarea[name="title"], input[name="title"]').first();
    await titleInput.waitFor({ state: "visible", timeout: 20_000 });
    await titleInput.click();
    await page.keyboard.insertText((job.payload.title ?? job.title).slice(0, 300));
    if (job.videoPath) {
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(job.videoPath).catch(() => {});
      }
    }
    const postBtn = page.getByRole("button", { name: /^post$/i }).first();
    if (await postBtn.isVisible().catch(() => false) && !(await postBtn.isDisabled().catch(() => true))) {
      await postBtn.click();
      await page.waitForTimeout(3500);
      return {
        status: "published",
        screenshotFile: await this.saveShot(page, `${channel.id}-reddit-done`),
        message: `Submitted Reddit post (${job.payload.subreddit ?? job.handle}).`,
      };
    }
    return {
      status: "needs_human_action",
      screenshotFile: await this.saveShot(page, `${channel.id}-reddit-review`),
      message: "Reddit composer populated; verify target community/flair before submitting.",
    };
  }

  private async runThreadsPost(page: Page, job: PublishJob, channel: ChannelConfig): Promise<ExecutionResult> {
    const composeBtn = page.getByRole("button", { name: /create|new thread/i }).or(page.getByText(/^create$/i)).first();
    if (await composeBtn.isVisible().catch(() => false)) {
      await composeBtn.click().catch(() => {});
    }
    if (job.videoPath) {
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(job.videoPath).catch(() => {});
        await page.waitForTimeout(2500);
      }
    }
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 20_000 });
    await editor.click();
    await page.keyboard.insertText(this.buildPostCopy(job).slice(0, 500));
    const postBtn = page.getByRole("button", { name: /^post$/i }).last();
    if (await postBtn.isVisible().catch(() => false) && !(await postBtn.isDisabled().catch(() => true))) {
      await postBtn.click();
      await page.waitForTimeout(3000);
      return {
        status: "published",
        screenshotFile: await this.saveShot(page, `${channel.id}-threads-done`),
        message: `Posted Thread for ${job.handle}.`,
      };
    }
    return {
      status: "needs_human_action",
      screenshotFile: await this.saveShot(page, `${channel.id}-threads-review`),
      message: "Threads composer populated; confirm upload completion before posting.",
    };
  }
}
