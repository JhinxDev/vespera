import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.VESPERA_QA_URL || "http://127.0.0.1:4660";
const SHOT_DIR = process.env.QA_SCREENSHOT_DIR || "";

async function cleanupQaTempChannels() {
  const boot = await fetch(`${BASE_URL}/api/bootstrap`).then(r => r.json());
  for (const ch of boot.channels.filter(c => c.name === "QA Temp Studio")) {
    await fetch(`${BASE_URL}/api/channels/${encodeURIComponent(ch.id)}`, { method: "DELETE" });
  }
}

async function run() {
  const health = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
  assert.equal(health.ok, true, "Health check must return ok:true");
  assert.equal(health.name, "Vespera", "Server name must be Vespera");

  await cleanupQaTempChannels();
  const initialBoot = await fetch(`${BASE_URL}/api/bootstrap`).then(r => r.json());
  const initialChannelCount = initialBoot.channels.length;
  assert.ok(initialChannelCount >= 1, "At least one workspace required");
  const targetChannel = initialBoot.channels[0];

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const errors = [];
  const apiErrors = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.on("console", msg => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    page.on("pageerror", err => {
      errors.push(`pageerror: ${err.message}`);
    });
    page.on("response", res => {
      if (res.status() >= 400 && !res.url().includes("/check")) {
        apiErrors.push(`HTTP ${res.status()} ${res.url()}`);
      }
    });

    // 1. Navigate all 7 sidebar routes and verify real URL path updates
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 25_000 });
    const routeChecks = [
      ["Calendar", "/calendar"],
      ["Queue", "/queue"],
      ["Analytics", "/analytics"],
      ["Channels & Connect", "/channels"],
      ["Automations", "/automations"],
      ["API & MCP", "/api-mcp"],
      ["Overview", "/"],
    ];
    for (const [label, expectedPath] of routeChecks) {
      await page.locator(`aside nav button:has-text("${label}")`).click();
      await page.waitForTimeout(150);
      assert.equal(new URL(page.url()).pathname, expectedPath, `Sidebar '${label}' must route to '${expectedPath}'`);
    }

    // 2. Test reload persistence on /channels + workspace filter persistence
    await page.locator(`aside nav button:has-text("Channels & Connect")`).click();
    await page.locator('select[aria-label="Active workspace scope"]').selectOption(targetChannel.id);
    await page.waitForTimeout(150);
    assert.ok(page.url().includes(`/channels?workspace=${targetChannel.id}`), "URL should preserve view and workspace");

    await page.reload({ waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/channels", "Browser reload must stay on /channels");
    assert.equal(
      new URL(page.url()).searchParams.get("workspace"),
      targetChannel.id,
      "Browser reload must preserve ?workspace query",
    );
    assert.equal(
      await page.locator('select[aria-label="Active workspace scope"]').inputValue(),
      targetChannel.id,
    );

    // 3. Scroll down on /channels, verify sticky header + Refresh hits /api/bootstrap?_ts= + toast is viewport-visible
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(150);
    const refreshBtn = page.locator('header button[aria-label="Refresh workspace"]');
    const refreshBox = await refreshBtn.boundingBox();
    assert.ok(refreshBox && refreshBox.y >= 0 && refreshBox.y < 100, "Sticky header Refresh button must stay visible on scroll");

    const [freshReq] = await Promise.all([
      page.waitForResponse(res => res.url().includes("/api/bootstrap?_ts=") && res.status() === 200),
      refreshBtn.click(),
    ]);
    assert.equal(freshReq.status(), 200, "Refresh button must execute live /api/bootstrap?_ts= request");
    await page.locator('header button:has-text("Synced")').waitFor({ state: "visible", timeout: 4000 });
    assert.equal(new URL(page.url()).pathname, "/channels", "Clicking Refresh must not redirect away from /channels");

    // 4. Test Self-Service Channel Lifecycle while scrolled down (toasts visible in viewport + no residue left in DB)
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.locator('button:has-text("New Channel")').first().click();
    await page.locator('input[placeholder="Acme Studio"]').fill("QA Temp Studio");
    await page.locator('button:has-text("Create Channel & Setup Profile")').click();

    const toast = page.locator('[data-testid="toast-item"]').first();
    await toast.waitFor({ state: "visible", timeout: 5000 });
    const toastBox = await toast.boundingBox();
    assert.ok(
      toastBox && toastBox.y >= 0 && toastBox.y < 220,
      `Toast must stay pinned inside viewport even while scrolled (y=${toastBox?.y})`,
    );
    if (SHOT_DIR) {
      await page.screenshot({ path: path.join(SHOT_DIR, "vespera-qa-scrolled-toast-1440.png"), fullPage: false });
    }

    await page.locator('h3:has-text("QA Temp Studio")').waitFor({ state: "visible", timeout: 5000 });

    // Edit handle inline inside QA Temp Studio card
    const qaCard = page.locator("div.vsp-card", { has: page.locator('h3:has-text("QA Temp Studio")') }).first();
    await qaCard.locator('button[aria-label="Edit YouTube handle"]').click();
    const editInput = qaCard.locator('input[aria-label="Edit handle"]');
    await editInput.fill("@qatempupdated");
    await qaCard.locator('button[aria-label="Save handle"]').click();
    await qaCard.locator('text=@qatempupdated').waitFor({ state: "visible", timeout: 4000 });

    // Toggle Off -> On cleanly
    const firstToggle = qaCard.locator('button:has-text("Off")').first();
    await firstToggle.click();
    await qaCard.locator('button:has-text("On")').first().waitFor({ state: "visible", timeout: 4000 });

    // Guarded delete cleanup so zero test residue remains
    await qaCard.locator('button[aria-label="Delete workspace QA Temp Studio"]').click();
    await qaCard.locator('button:has-text("Delete")').click();
    await page.locator('h3:has-text("QA Temp Studio")').waitFor({ state: "detached", timeout: 5000 });

    // Reset workspace filter to All Workspaces and test Ctrl+K Command Palette -> Calendar
    await page.locator('select[aria-label="Active workspace scope"]').selectOption("all");
    await page.keyboard.press("Control+k");
    await page.locator('input[placeholder*="Jump to page"]').waitFor({ state: "visible", timeout: 3000 });
    await page.locator('div.fixed button:has-text("Calendar")').first().click();
    await page.waitForTimeout(150);
    assert.equal(new URL(page.url()).pathname, "/calendar", "Command Palette should navigate to Calendar");

    // Verify Calendar + Add button pre-fills clicked date
    await page.locator('section button:has-text("Add")').first().click();
    const dateVal = await page.locator('form input[type="date"]').inputValue();
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(dateVal), "NewPostModal date should prefill cleanly");
    await page.keyboard.press("Escape");

    // Verify Queue & Analytics stay synced with top workspace selector
    await page.locator('aside nav button:has-text("Queue")').click();
    await page.locator('select[aria-label="Active workspace scope"]').selectOption(targetChannel.id);
    assert.equal(await page.locator('select[aria-label="Workspace filter"]').inputValue(), targetChannel.id);

    await page.locator('aside nav button:has-text("Analytics")').click();
    assert.equal(await page.locator('select[aria-label="Filter analytics by workspace"]').inputValue(), targetChannel.id);

    // Verify Automations tabs + API & MCP Copy JSON fallback
    await page.locator('aside nav button:has-text("Automations")').click();
    for (const tab of ["Signatures", "Plugs", "RSS Auto-Post", "Webhooks", "Posting Sets"]) {
      await page.locator(`button:has-text("${tab}")`).click();
    }
    await page.locator('aside nav button:has-text("API & MCP")').click();
    await page.locator('button:has-text("Copy JSON")').click();
    await page.locator('button:has-text("Copied")').waitFor({ state: "visible", timeout: 3000 });

    // Check overflow at 1440 & 1024 desktop & 390 mobile
    for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, `Horizontal overflow detected on desktop/mobile at ${w}x${h}`);
    }
    await context.close();

    // 5. Dedicated /connect desktop companion view QA (980x720)
    const ctxConnect = await browser.newContext({ viewport: { width: 980, height: 720 } });
    const pConn = await ctxConnect.newPage();
    pConn.on("console", msg => {
      if (msg.type() === "error") errors.push(`/connect console.error: ${msg.text()}`);
    });
    pConn.on("pageerror", err => {
      errors.push(`/connect pageerror: ${err.message}`);
    });
    pConn.on("response", res => {
      if (res.status() >= 400) apiErrors.push(`/connect HTTP ${res.status()} ${res.url()}`);
    });

    await pConn.goto(`${BASE_URL}/connect`, { waitUntil: "networkidle", timeout: 25_000 });
    await pConn.locator(`button:has-text("${targetChannel.name}")`).first().click();
    assert.equal(new URL(pConn.url()).searchParams.get("workspace"), targetChannel.id);
    await pConn.reload({ waitUntil: "networkidle" });
    assert.equal(new URL(pConn.url()).searchParams.get("workspace"), targetChannel.id);

    const [connRefresh] = await Promise.all([
      pConn.waitForResponse(res => res.url().includes("/api/bootstrap?_ts=") && res.status() === 200),
      pConn.locator('header button[aria-label="Refresh workspace"]').click(),
    ]);
    assert.equal(connRefresh.status(), 200);
    await pConn.locator('header button:has-text("Synced")').waitFor({ state: "visible", timeout: 4000 });
    const connOverflow = await pConn.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(connOverflow, false, "Horizontal overflow on /connect");
    if (SHOT_DIR) {
      await pConn.screenshot({ path: path.join(SHOT_DIR, "vespera-qa-connect-sticky-980.png"), fullPage: false });
    }
    await ctxConnect.close();

    // Verify DB channel count is completely clean after QA cleanup
    const endBoot = await fetch(`${BASE_URL}/api/bootstrap`).then(r => r.json());
    assert.equal(endBoot.channels.length, initialChannelCount, "No temp QA channel should remain in SQLite");
  } finally {
    await cleanupQaTempChannels().catch(() => {});
    await browser.close();
  }

  assert.deepEqual(errors, [], `Unexpected console/page errors: ${errors.join("; ")}`);
  assert.deepEqual(apiErrors, [], `Unexpected HTTP errors: ${apiErrors.join("; ")}`);
  console.log("E2E_INTERACTIVE_QA_PASSED=true");
}

run().catch(err => {
  console.error("E2E_INTERACTIVE_QA_FAILED:", err);
  process.exit(1);
});
