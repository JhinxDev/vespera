import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildLinuxBrowserConnectArgs,
  buildNativeEdgeLoginArgs,
  clearProfileSessionRestore,
  detectAuthOrChallengeSnapshot,
  formatMonthDayYear,
  formatTime12h,
  isVerticalCropPreserved,
  truncateAtWordBoundary,
  verifyExpectedHandle,
} from "../src/adapters/edge-studio.js";
import { parseCompactMetric } from "../src/analytics/collector.js";
import { PRIORITY_PLATFORM_IDS } from "../src/platforms/registry.js";

test("Edge args omit automation flags and handle/auth/time utilities behave safely", () => {
  const args = buildNativeEdgeLoginArgs("/tmp/profile-a", ["https://studio.youtube.com/"]);
  assert.ok(args.includes("--user-data-dir=/tmp/profile-a"));
  assert.ok(args.includes("--disable-extensions"));
  assert.ok(args.includes("--disable-sync"));
  assert.ok(args.includes("--disable-features=msImplicitSignIn,msAutoSignIn"));
  assert.ok(args.includes("--disable-session-crashed-bubble"));
  assert.ok(args.includes("--hide-crash-restore-bubble"));
  assert.ok(args.includes("--no-restore-last-session"));
  assert.equal(args.some(a => a.includes("enable-automation")), false);

  const linuxArgs = buildLinuxBrowserConnectArgs("/data/profiles/demo", ["https://example.com/"]);
  assert.ok(linuxArgs.includes("--user-data-dir=/data/profiles/demo"));
  assert.ok(linuxArgs.includes("--no-sandbox"));
  assert.ok(linuxArgs.includes("--disable-dev-shm-usage"));
  assert.ok(linuxArgs.includes("--disable-blink-features=AutomationControlled"));
  assert.ok(linuxArgs.some(a => a.startsWith("--user-agent=")));
  assert.ok(linuxArgs.includes("https://example.com/"));
  assert.equal(linuxArgs.some(a => a.includes("enable-automation")), false);

  assert.equal(
    detectAuthOrChallengeSnapshot(
      "https://studio.youtube.com/channel/UC123",
      "Verify it's you. To continue, we need to confirm it's really you",
      "youtube",
    ).status,
    "challenge",
  );

  assert.equal(detectAuthOrChallengeSnapshot("https://accounts.google.com/v3/signin", "", "youtube").status, "logged_out");
  assert.equal(detectAuthOrChallengeSnapshot("https://www.tiktok.com/", "Verify you are human", "tiktok").status, "challenge");
  assert.equal(detectAuthOrChallengeSnapshot("https://www.reddit.com/submit", "Create post", "reddit").status, "signed_in");
  assert.equal(
    detectAuthOrChallengeSnapshot(
      "https://www.reddit.com/submit?js_challenge=1&jsc_token=abc",
      "",
      "reddit",
    ).status,
    "logged_out",
  );
  assert.equal(
    detectAuthOrChallengeSnapshot(
      "https://studio.youtube.com/",
      "Improve your experience. You are using an unsupported browser or an old browser version.",
      "youtube",
    ).status,
    "challenge",
  );
  assert.equal(
    detectAuthOrChallengeSnapshot(
      "https://www.reddit.com/",
      "You've been blocked by network security.",
      "reddit",
    ).status,
    "challenge",
  );
  assert.equal(
    detectAuthOrChallengeSnapshot(
      "https://www.reddit.com/login/",
      "Welcome back! You are already logged in and will be redirected back to Reddit shortly.",
      "reddit",
    ).status,
    "signed_in",
  );

  assert.equal(verifyExpectedHandle("@AcmeStudio", "acmestudio").ok, true);
  assert.equal(verifyExpectedHandle("@WrongAccount", "acmestudio").ok, false);

  assert.deepEqual(formatMonthDayYear("2026-11-24"), { monthName: "Nov", day: 24, year: 2026 });
  assert.equal(formatTime12h("10:00"), "10:00 AM");
  assert.equal(formatTime12h("14:30"), "2:30 PM");

  assert.equal(parseCompactMetric("1.5K"), 1500);
  assert.equal(parseCompactMetric("2.4M"), 2400000);
  assert.deepEqual([...PRIORITY_PLATFORM_IDS], ["facebook", "tiktok", "reddit", "instagram", "youtube", "x", "threads"]);

  assert.equal(truncateAtWordBoundary("alpha beta gamma delta", 14), "alpha beta");
  assert.equal(
    isVerticalCropPreserved({ videoWidth: 1080, videoHeight: 1920, frameWidth: 520, frameHeight: 520 }),
    false,
  );
  assert.equal(
    isVerticalCropPreserved({ videoWidth: 1080, videoHeight: 1920, frameWidth: 380, frameHeight: 675 }),
    true,
  );
});

test("clearProfileSessionRestore removes stale Edge tab-restore files while preserving auth storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "vespera-edge-session-"));
  try {
    const defaultDir = join(dir, "Default");
    const sessionsDir = join(defaultDir, "Sessions");
    const networkDir = join(defaultDir, "Network");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(networkDir, { recursive: true });

    writeFileSync(join(sessionsDir, "Session_1"), "stale-session", "utf8");
    writeFileSync(join(sessionsDir, "Tabs_1"), "stale-tabs", "utf8");
    writeFileSync(join(defaultDir, "Last Session"), "legacy-session", "utf8");
    writeFileSync(
      join(defaultDir, "Preferences"),
      JSON.stringify({
        session: { restore_on_startup: 1 },
        profile: { exit_type: "Crashed" },
        signin: { allowed: true },
        sync: { requested: true },
      }),
      "utf8",
    );
    writeFileSync(join(networkDir, "Cookies"), "keep-me", "utf8");

    clearProfileSessionRestore(dir);

    assert.equal(existsSync(join(sessionsDir, "Session_1")), false);
    assert.equal(existsSync(join(sessionsDir, "Tabs_1")), false);
    assert.equal(existsSync(join(defaultDir, "Last Session")), false);

    const updatedPrefs = JSON.parse(readFileSync(join(defaultDir, "Preferences"), "utf8")) as {
      session?: { restore_on_startup?: number };
      profile?: { exit_type?: string; exited_cleanly?: boolean };
      signin?: { allowed?: boolean; allowed_on_next_startup?: boolean };
      sync?: { requested?: boolean };
    };
    assert.equal(updatedPrefs.session?.restore_on_startup, 5);
    assert.equal(updatedPrefs.profile?.exit_type, "Normal");
    assert.equal(updatedPrefs.profile?.exited_cleanly, true);
    assert.equal(updatedPrefs.signin?.allowed, false);
    assert.equal(updatedPrefs.signin?.allowed_on_next_startup, false);
    assert.equal(updatedPrefs.sync?.requested, false);

    assert.equal(existsSync(join(networkDir, "Cookies")), true);
    assert.equal(readFileSync(join(networkDir, "Cookies"), "utf8"), "keep-me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
