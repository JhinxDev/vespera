import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EdgeStudioAdapter } from "../src/adapters/edge-studio.js";
import { WebhookAdapter } from "../src/adapters/webhook.js";
import { YouTubeApiAdapter } from "../src/adapters/youtube-api.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { VesperaStore } from "../src/db.js";
import { handleMcpRequest } from "../src/mcp.js";
import { createVesperaServer } from "../src/server.js";
import { PublishWorker } from "../src/worker.js";

test("HTTP server and MCP tools manage platforms, jobs, range media streaming, and API keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsp-srv-"));
  const config = resolveRuntimeConfig({ rootDir: dir, dataDir: dir, port: 0 });
  const store = new VesperaStore(config.dbPath, config.profilesDir);
  const edge = new EdgeStudioAdapter(config.evidenceDir, id => store.getPlatformDefinition(id));
  const worker = new PublishWorker(store, edge, new YouTubeApiAdapter(), new WebhookAdapter());
  const server = createVesperaServer({ config, store, edgeAdapter: edge, worker });

  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const ch = store.upsertChannel({ id: "studio-one", name: "Studio One" });
    store.upsertConnection({ channelId: ch.id, platform: "youtube", handle: "@StudioOne" });
    const fakeMp4 = join(dir, "clip.mp4");
    writeFileSync(fakeMp4, Buffer.from("0123456789abcdef"));

    const jobRes = store.enqueueJob({
      channelId: ch.id,
      title: "Sample Short",
      platform: "youtube",
      targetDate: "2026-11-24",
      publishAt: "2026-11-24T10:00:00",
      videoPath: fakeMp4,
      videoBytes: 16,
    });

    const health = await fetch(`${base}/api/health`).then(r => r.json() as Promise<{ ok: boolean; name: string }>);
    assert.equal(health.ok, true);
    assert.equal(health.name, "Vespera");

    const rangeRes = await fetch(`${base}/api/media/video/${jobRes.job.id}`, {
      headers: { Range: "bytes=0-3" },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(await rangeRes.text(), "0123");

    const customPlatRes = await fetch(`${base}/api/platforms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kick", loginUrl: "https://kick.com/" }),
    });
    assert.equal(customPlatRes.status, 201);

    const apiKeyRes = await fetch(`${base}/api/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CI Bot" }),
    }).then(r => r.json() as Promise<{ rawKey: string }>);
    assert.ok(apiKeyRes.rawKey.startsWith("vsp_live_"));

    const unauth = await fetch(`${base}/api/health`, {
      headers: { Authorization: "Bearer invalid_key" },
    });
    assert.equal(unauth.status, 401);

    const authed = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${apiKeyRes.rawKey}` },
    });
    assert.equal(authed.status, 200);

    const oauthCfg = await fetch(`${base}/api/oauth/config`).then(
      r => r.json() as Promise<{ ok: boolean; youtubeConfigured: boolean; redditConfigured: boolean }>,
    );
    assert.equal(oauthCfg.ok, true);
    assert.equal(typeof oauthCfg.youtubeConfigured, "boolean");
    assert.equal(typeof oauthCfg.redditConfigured, "boolean");

    const unauthSessionSync = await fetch(`${base}/api/channels/${ch.id}/session-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: [] }),
    });
    assert.equal(unauthSessionSync.status, 401);

    const upRes = await fetch(`${base}/api/media/upload?kind=cover&filename=test-thumb.jpg`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("fake-jpeg-bytes"),
    });
    assert.equal(upRes.status, 201);
    const upJson = (await upRes.json()) as { ok: boolean; bytes: number; sha256: string; path: string };
    assert.equal(upJson.ok, true);
    assert.equal(upJson.bytes, 15);
    assert.ok(upJson.sha256.length === 64);

    const srtRes = await fetch(`${base}/api/media/upload?kind=captions&filename=subs.srt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nHello\n"),
    });
    assert.equal(srtRes.status, 201);
    const srtJson = (await srtRes.json()) as { ok: boolean; bytes: number; sha256: string; filename: string };
    assert.equal(srtJson.ok, true);
    assert.ok(srtJson.bytes > 0);
    assert.ok(srtJson.filename.endsWith("subs.srt"));

    const lbStatus = await fetch(`${base}/api/live-browser`).then(
      r => r.json() as Promise<{ ok: boolean; available: boolean; session: unknown }>,
    );
    assert.equal(lbStatus.ok, true);
    assert.equal(typeof lbStatus.available, "boolean");

    const schedBefore = await fetch(`${base}/api/scheduler`).then(
      r => r.json() as Promise<{ ok: boolean; scheduler: { enabled: boolean } }>,
    );
    assert.equal(schedBefore.scheduler.enabled, false);
    const schedAfter = await fetch(`${base}/api/scheduler`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, runNow: true, dryRun: true }),
    }).then(r => r.json() as Promise<{ ok: boolean; scheduler: { enabled: boolean }; ran: number }>);
    assert.equal(schedAfter.scheduler.enabled, true);
    assert.equal(typeof schedAfter.ran, "number");

    const missingCheck = await fetch(`${base}/api/channels/${ch.id}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "nonexistent" }),
    });
    assert.equal(missingCheck.status, 400);

    const mcpTools = (await handleMcpRequest(store, { jsonrpc: "2.0", id: 1, method: "tools/list" }, worker)) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.ok(mcpTools.result.tools.some(t => t.name === "vespera_video_intelligence"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
