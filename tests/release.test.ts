import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildReleaseNotes,
  extractChangelogSection,
  parseReleaseTag,
  verifyTagMatchesRepo,
} from "../scripts/release-notes.mjs";

test("release-notes tooling validates current version and extracts changelog", () => {
  const root = resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const tag = `v${pkg.version}`;

  assert.equal(parseReleaseTag(tag), pkg.version);
  assert.equal(verifyTagMatchesRepo(tag, root), pkg.version);

  const notes = buildReleaseNotes(tag, root);
  assert.match(notes, /## Container image/);
  assert.match(notes, new RegExp(`docker pull ghcr\\.io/jhinxdev/vespera:${pkg.version.replaceAll(".", "\\.")}`));
  assert.match(notes, /docker pull ghcr\.io\/jhinxdev\/vespera:latest/);

  assert.throws(() => parseReleaseTag("1.0.0"), /vMAJOR\.MINOR\.PATCH/);
  assert.throws(() => extractChangelogSection("## 1.0.0\n\n- Initial\n", "9.9.9"), /no section/);
  assert.throws(() => extractChangelogSection("## 9.9.9\n\n## 1.0.0\n- x\n", "9.9.9"), /empty/);

  const tmp = mkdtempSync(join(tmpdir(), "vsp-rel-"));
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(
      join(tmp, "package-lock.json"),
      JSON.stringify({ version: "1.2.0", packages: { "": { version: "1.2.3" } } }),
    );
    writeFileSync(join(tmp, "CHANGELOG.md"), "## 1.2.3\n\n- Added feature\n");
    assert.throws(() => verifyTagMatchesRepo("v1.2.3", tmp), /does not match repository versions/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
