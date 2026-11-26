import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildVideoIntelligence } from "../src/analytics/intelligence.js";
import { applyChannelSignature, applyPostPublishAutomations, parseRssOrAtomXml } from "../src/automations/engine.js";
import { VesperaStore } from "../src/db.js";

test("VesperaStore manages extensible platforms, channels, jobs, automations, and analytics", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsp-store-"));
  const store = new VesperaStore(join(dir, "test.sqlite"), join(dir, "profiles"));

  try {
    const custom = store.upsertCustomPlatform({
      id: "substack",
      name: "Substack Notes",
      loginUrl: "https://substack.com/sign-in",
      composeUrl: "https://substack.com/notes",
      accentHex: "#FF6719",
    });
    assert.equal(custom.id, "substack");
    assert.ok(store.listAllPlatforms().some(p => p.id === "facebook" && p.featuredOrder));
    assert.ok(store.listAllPlatforms().some(p => p.id === "substack" && !p.builtIn));

    const ch = store.upsertChannel({
      id: "acme-studio",
      name: "Acme Studio",
      groupId: "flagship",
      timezone: "America/New_York",
      defaultPostTime: "10:00",
    });
    assert.equal(ch.id, "acme-studio");

    store.upsertConnection({
      channelId: "acme-studio",
      platform: "youtube",
      handle: "@AcmeStudio",
      enabled: true,
    });
    store.upsertConnection({
      channelId: "acme-studio",
      platform: "reddit",
      handle: "u/acmestudio",
      enabled: false,
    });
    store.saveSessionCheck({
      channelId: "acme-studio",
      platform: "reddit",
      status: "signed_in",
      expectedHandle: "u/acmestudio",
      checkedAt: new Date().toISOString(),
      url: "https://www.reddit.com/submit",
    });
    assert.equal(store.getChannel("acme-studio")?.connections.find(c => c.platform === "reddit")?.sessionStatus, "signed_in");
    store.upsertConnection({
      channelId: "acme-studio",
      platform: "reddit",
      handle: "u/acmestudio",
      enabled: true,
    });

    const sig = store.upsertSignature({
      name: "Footer CTA",
      channelId: "acme-studio",
      body: "Subscribe for weekly breakdowns.",
      autoAppend: true,
    });
    assert.equal(sig.autoAppend, true);

    const jobRes = store.enqueueJob({
      channelId: "acme-studio",
      videoId: "vid-1",
      title: "Why Systems Break Under Load",
      platform: "youtube",
      targetDate: "2026-11-24",
      publishAt: "2026-11-24T10:00:00-05:00",
      payload: {
        description: "Full case study.",
      },
    });
    assert.equal(jobRes.created, true);

    const signedJob = applyChannelSignature(store, jobRes.job);
    assert.ok(signedJob.payload.description?.includes("Subscribe for weekly breakdowns."));

    store.recordChannelSnapshot({
      channelId: "acme-studio",
      platform: "youtube",
      capturedAt: new Date().toISOString(),
      followers: 1200,
      totalViews: 45000,
      totalVideos: 14,
    });
    store.upsertVideoMetric({
      channelId: "acme-studio",
      platform: "youtube",
      remoteId: "yt-101",
      title: "Why 3 Bridges Collapsed in 1907",
      views: 18500,
      likes: 910,
      comments: 64,
      shares: 45,
      saves: 120,
      capturedAt: new Date().toISOString(),
    });

    const intel = buildVideoIntelligence(store, { channelId: "acme-studio" });
    assert.equal(intel.hasLiveData, true);
    assert.equal(intel.summary.totalViews, 45000);
    assert.equal(intel.crossPlatformGaps.length, 1);
    assert.deepEqual(intel.crossPlatformGaps[0].missingOn, ["reddit"]);

    const rss = parseRssOrAtomXml(`<?xml version="1.0"?><rss><channel><item><guid>g1</guid><title>Release Notes</title><link>https://example.com/1</link></item></channel></rss>`);
    assert.equal(rss.length, 1);
    assert.equal(rss[0].guid, "g1");

    const chFile = join(dir, "channels.json");
    writeFileSync(
      chFile,
      JSON.stringify({
        groups: [{ id: "demo", name: "Demo", color: "#10B981" }],
        channels: [{ id: "demo-ch", name: "Demo Brand", groupId: "demo", connections: [{ platform: "threads", handle: "@demobrand" }] }],
      }),
    );
    const imp = store.importChannelsFile(chFile);
    assert.equal(imp.channels, 1);
    assert.equal(store.getChannel("demo-ch")?.connections[0].platform, "threads");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRunnableJobs dispatches just-in-time across all platforms, recovers running jobs, and fires plugs", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsp-store-jit-"));
  const store = new VesperaStore(join(dir, "test.sqlite"), join(dir, "profiles"));

  try {
    store.upsertChannel({ id: "creator-a", name: "Creator A" });
    for (const plat of ["youtube", "tiktok", "x", "instagram", "facebook"]) {
      store.upsertConnection({
        channelId: "creator-a",
        platform: plat,
        handle: `@creator_${plat}`,
        enabled: plat !== "facebook",
      });
    }

    const dueAt = "2026-11-26T10:00:00-05:00";
    const futureAt = "2026-11-27T10:00:00-05:00";
    for (const plat of ["youtube", "tiktok", "x", "instagram", "facebook"]) {
      store.enqueueJob({
        channelId: "creator-a",
        videoId: "due-vid",
        title: "Due Episode",
        platform: plat,
        targetDate: "2026-11-26",
        publishAt: dueAt,
      });
      store.enqueueJob({
        channelId: "creator-a",
        videoId: "future-vid",
        title: "Future Episode",
        platform: plat,
        targetDate: "2026-11-27",
        publishAt: futureAt,
      });
    }

    // 5 minutes before slot: nothing runnable yet
    assert.equal(store.listRunnableJobs("2026-11-26T09:55:00-05:00").length, 0);

    // At slot: only the 4 enabled due jobs run (facebook disabled; future jobs wait)
    const dueNow = store.listRunnableJobs("2026-11-26T10:00:00-05:00");
    assert.equal(dueNow.length, 4);
    assert.ok(dueNow.every(j => j.videoId === "due-vid" && j.platform !== "facebook"));

    // Recover stale running job
    const runningTarget = dueNow[0];
    store.saveJob({ ...runningTarget, status: "running" });
    const recovered = store.recoverStaleRunningJobs();
    assert.equal(recovered.length, 1);
    assert.equal(store.getJob(runningTarget.id)?.status, "needs_human_action");
    assert.equal(store.listAttempts(runningTarget.id)[0]?.outcome, "needs_human_action");

    // Automation plug triggers on published job
    const plug = store.upsertPlug({
      name: "TikTok Plug",
      scope: "internal",
      channelId: "creator-a",
      triggerType: "on_publish",
      actionType: "follow_up_comment",
      config: { platforms: ["tiktok"], comment: "Full breakdown on YouTube!", delayMinutes: 5 },
      enabled: true,
    });
    const ttJob = dueNow.find(j => j.platform === "tiktok")!;
    applyPostPublishAutomations(store, { ...ttJob, status: "published" });
    assert.equal(store.listFollowUpComments().length, 1);
    assert.equal(store.listPlugs().find(p => p.id === plug.id)?.runsCount, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
