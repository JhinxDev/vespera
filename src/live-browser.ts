import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  buildLinuxBrowserConnectArgs,
  clearProfileSessionRestore,
  findSystemEdgeExecutable,
} from "./adapters/edge-studio.js";
import type { ChannelConfig, LiveBrowserSession } from "./types.js";

const DISPLAY_NUM = 99;
const DISPLAY_ENV = `:${DISPLAY_NUM}`;
const VNC_PORT = 5999;
const WEBSOCKIFY_PORT = 6080;
const SESSION_TTL_MS = 15 * 60 * 1000;
const NOVNC_VIEWER_PATH =
  "/live-browser/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=live-browser/websockify";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await sleep(100);
  }
  return existsSync(filePath);
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock = createConnection({ host, port });
      const done = (result: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(result);
      };
      sock.setTimeout(500);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

async function terminateProcess(child: ChildProcess | undefined, waitMs = 3500): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // Ignore already-exited child.
      }
      setTimeout(finish, 250);
    }, waitMs);
  });
}

function cleanupX11Locks(): void {
  for (const p of [`/tmp/.X${DISPLAY_NUM}-lock`, `/tmp/.X11-unix/X${DISPLAY_NUM}`]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best-effort cleanup of stale X11 socket/lock files.
    }
  }
}

export class LiveBrowserManager {
  private session: LiveBrowserSession | null = null;
  private profileDir: string | undefined;
  private expireTimer: NodeJS.Timeout | undefined;
  private stopPromise: Promise<{ stopped: boolean; channelId?: string; platform?: string }> | null = null;
  private procs: {
    xvfb?: ChildProcess;
    openbox?: ChildProcess;
    browser?: ChildProcess;
    x11vnc?: ChildProcess;
    websockify?: ChildProcess;
  } = {};

  isAvailable(): boolean {
    if (process.platform !== "linux") return false;
    return (
      existsSync("/usr/bin/Xvfb") &&
      existsSync("/usr/bin/x11vnc") &&
      existsSync("/usr/bin/websockify") &&
      existsSync("/usr/share/novnc/vnc.html")
    );
  }

  getProxyPort(): number {
    return WEBSOCKIFY_PORT;
  }

  getSession(): LiveBrowserSession | null {
    return this.session;
  }

  async start(opts: { channel: ChannelConfig; platform?: string; url: string }): Promise<LiveBrowserSession> {
    if (!this.isAvailable()) {
      const err = new Error("Live Browser (noVNC) is only available in the Linux container runtime.") as Error & {
        statusCode?: number;
      };
      err.statusCode = 501;
      throw err;
    }

    await this.stop();

    const { channel, platform, url } = opts;
    mkdirSync(channel.profileDir, { recursive: true });
    for (const lockFile of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        rmSync(join(channel.profileDir, lockFile), { force: true });
      } catch {
        // Ignore missing or already-removed profile locks.
      }
    }
    clearProfileSessionRestore(channel.profileDir);
    cleanupX11Locks();

    const xEnv = { ...process.env, DISPLAY: DISPLAY_ENV };

    try {
      const xvfb = spawn(
        "/usr/bin/Xvfb",
        [DISPLAY_ENV, "-screen", "0", "1360x900x24", "-ac", "-nolisten", "tcp"],
        { stdio: "ignore" },
      );
      this.procs.xvfb = xvfb;

      const xReady = await waitForFile(`/tmp/.X11-unix/X${DISPLAY_NUM}`, 4000);
      if (!xReady) {
        throw new Error("Xvfb failed to start display :99 within timeout.");
      }

      const openbox = spawn("/usr/bin/openbox", [], { env: xEnv, stdio: "ignore" });
      this.procs.openbox = openbox;
      await sleep(250);

      const browserExe = findSystemEdgeExecutable();
      const browserArgs = buildLinuxBrowserConnectArgs(channel.profileDir, [url]);
      const browser = spawn(browserExe, browserArgs, { env: xEnv, stdio: "ignore" });
      this.procs.browser = browser;
      this.profileDir = channel.profileDir;

      browser.once("exit", () => {
        if (this.procs.browser === browser) {
          void this.stop();
        }
      });

      const x11vnc = spawn(
        "/usr/bin/x11vnc",
        [
          "-display",
          DISPLAY_ENV,
          "-rfbport",
          String(VNC_PORT),
          "-localhost",
          "-nopw",
          "-forever",
          "-shared",
          "-noxdamage",
          "-wait",
          "10",
          "-defer",
          "10",
        ],
        { env: xEnv, stdio: "ignore" },
      );
      this.procs.x11vnc = x11vnc;

      const websockify = spawn(
        "/usr/bin/websockify",
        ["--web", "/usr/share/novnc", `127.0.0.1:${WEBSOCKIFY_PORT}`, `127.0.0.1:${VNC_PORT}`],
        { stdio: "ignore" },
      );
      this.procs.websockify = websockify;

      const proxyReady = await waitForTcpPort("127.0.0.1", WEBSOCKIFY_PORT, 6000);
      if (!proxyReady) {
        throw new Error("noVNC websockify proxy failed to bind on port 6080.");
      }

      const now = Date.now();
      const session: LiveBrowserSession = {
        active: true,
        channelId: channel.id,
        platform,
        url,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
        viewerPath: NOVNC_VIEWER_PATH,
      };
      this.session = session;
      this.expireTimer = setTimeout(() => {
        void this.stop();
      }, SESSION_TTL_MS);
      this.expireTimer.unref?.();

      return session;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<{ stopped: boolean; channelId?: string; platform?: string }> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }

    const hadAnything =
      Boolean(this.session) ||
      Boolean(this.procs.browser || this.procs.websockify || this.procs.x11vnc || this.procs.openbox || this.procs.xvfb);

    const prevSession = this.session;
    const prevProfileDir = this.profileDir;

    this.stopPromise = (async () => {
      if (this.expireTimer) {
        clearTimeout(this.expireTimer);
        this.expireTimer = undefined;
      }

      const { browser, websockify, x11vnc, openbox, xvfb } = this.procs;
      this.procs = {};
      this.session = null;
      this.profileDir = undefined;

      // Flush Chromium SQLite cookies cleanly before tearing down X11.
      await terminateProcess(browser, 3500);
      await Promise.all([
        terminateProcess(websockify, 1500),
        terminateProcess(x11vnc, 1500),
        terminateProcess(openbox, 1500),
      ]);
      await terminateProcess(xvfb, 1500);

      if (prevProfileDir) {
        clearProfileSessionRestore(prevProfileDir);
      }
      cleanupX11Locks();

      return {
        stopped: hadAnything,
        channelId: prevSession?.channelId,
        platform: prevSession?.platform,
      };
    })();

    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }
}
