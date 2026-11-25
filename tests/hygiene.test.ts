import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "GitHub PAT (classic)", regex: /\bghp_[A-Za-z0-9]{20,}/ },
  { label: "GitHub PAT (fine-grained)", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: "Google API key", regex: /\bAIzaSy[A-Za-z0-9_-]{20,}/ },
  { label: "OpenAI API key", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { label: "PEM Private Key", regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { label: "Private LAN IPv4", regex: /\b(?:192\.168|10\.\d+)\.\d{1,3}\.\d{1,3}\b/ },
  { label: "Local Windows user path", regex: /C:\\Users\\[A-Za-z0-9._-]+/i },
];

const FORBIDDEN_TRACKED_NAMES = [
  /(^|\/)\.env$/i,
  /\.local\.json$/i,
  /\.sqlite(?:-wal|-shm)?$/i,
];

function collectTrackedOrSourceFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    });
    return out
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  } catch {
    const files: string[] = [];
    const walk = (dir: string, prefix = "") => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "qa-screenshots") continue;
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(full).isDirectory()) walk(full, rel);
        else files.push(rel);
      }
    };
    walk(root);
    return files;
  }
}

function loadOptionalCustomTokens(root: string): string[] {
  const customFile = join(root, ".hygiene.local.json");
  if (!existsSync(customFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(customFile, "utf8")) as { forbiddenTokens?: unknown };
    return Array.isArray(parsed.forbiddenTokens)
      ? parsed.forbiddenTokens.map(String).filter(Boolean).map(s => s.toLowerCase())
      : [];
  } catch {
    return [];
  }
}

test("Repository contains zero leaked secrets, local paths, private IPs, or personal data", () => {
  const root = resolve(import.meta.dirname, "..");
  const relFiles = collectTrackedOrSourceFiles(root);
  const customTokens = loadOptionalCustomTokens(root);
  const violations: string[] = [];

  for (const rel of relFiles) {
    if (FORBIDDEN_TRACKED_NAMES.some(rx => rx.test(rel))) {
      violations.push(`${rel} must not be tracked in git`);
      continue;
    }

    const abs = join(root, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    if (/\.(?:exe|ico|png|jpg|jpeg|webp|mp4|sqlite)$/i.test(rel)) continue;

    const text = readFileSync(abs, "utf8");
    const lower = text.toLowerCase();

    for (const rule of SECRET_PATTERNS) {
      if (rule.regex.test(text)) {
        violations.push(`${rel} matched sensitive pattern: ${rule.label}`);
      }
    }

    for (const token of customTokens) {
      if (lower.includes(token)) {
        violations.push(`${rel} matched custom forbidden token`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
