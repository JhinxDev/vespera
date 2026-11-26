#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const CHANGELOG_HEADING_RE = /^##\s+([^\r\n]+)$/gm;
const GHCR_IMAGE = "ghcr.io/jhinxdev/vespera";
const REPO_URL = "https://github.com/JhinxDev/vespera";

export function parseReleaseTag(tag) {
  const match = SEMVER_TAG_RE.exec(String(tag).trim());
  if (!match) {
    throw new Error(`Release tag must follow vMAJOR.MINOR.PATCH (got '${tag}')`);
  }
  return match[1];
}

export function readRepoVersions(repoRoot) {
  const pkgPath = resolve(repoRoot, "package.json");
  const lockPath = resolve(repoRoot, "package-lock.json");

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));

  const pkgVersion = typeof pkg.version === "string" ? pkg.version : "";
  const lockVersion = typeof lock.version === "string" ? lock.version : "";
  const lockRootVersion =
    typeof lock.packages?.[""]?.version === "string" ? lock.packages[""].version : "";

  return {
    "package.json": pkgVersion,
    "package-lock.json": lockVersion,
    'package-lock.json (packages[""])': lockRootVersion,
  };
}

export function verifyTagMatchesRepo(tag, repoRoot) {
  const version = parseReleaseTag(tag);
  const versions = readRepoVersions(repoRoot);
  const mismatches = Object.entries(versions)
    .filter(([, found]) => found !== version)
    .map(([name, found]) => `${name}=${found}`);
  if (mismatches.length > 0) {
    throw new Error(`Tag ${tag} does not match repository versions: ${mismatches.join(", ")}`);
  }
  return version;
}

export function extractChangelogSection(changelogText, version) {
  const matches = [...changelogText.matchAll(CHANGELOG_HEADING_RE)];
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = new RegExp(`^${escaped}(?:\\s|$)`);

  let sectionStart = null;
  let sectionEnd = changelogText.length;
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    if (sectionStart === null && prefix.test(heading)) {
      sectionStart = (matches[i].index ?? 0) + matches[i][0].length;
      if (i + 1 < matches.length) {
        sectionEnd = matches[i + 1].index ?? changelogText.length;
      }
      break;
    }
  }

  if (sectionStart === null) {
    throw new Error(`CHANGELOG.md has no section for version ${version}`);
  }
  const body = changelogText.slice(sectionStart, sectionEnd).trim();
  if (!body) {
    throw new Error(`CHANGELOG.md section for version ${version} is empty`);
  }
  return body;
}

export function buildReleaseNotes(tag, repoRoot) {
  const normalizedTag = String(tag).trim();
  const version = verifyTagMatchesRepo(normalizedTag, repoRoot);
  const changelogText = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  const changelogBody = extractChangelogSection(changelogText, version);

  const imageLines = [
    "## Container image",
    "",
    `Pull the prebuilt container image from GHCR (\`${GHCR_IMAGE}:${version}\`):`,
    "",
    "```sh",
    `docker pull ${GHCR_IMAGE}:${version}`,
  ];
  if (!version.includes("-")) {
    imageLines.push(`docker pull ${GHCR_IMAGE}:latest`);
  }
  imageLines.push("```");

  return [
    changelogBody,
    "",
    imageLines.join("\n"),
    "",
    `[Quickstart](${REPO_URL}/blob/${normalizedTag}/README.md#quick-start-docker) · [Changelog](${REPO_URL}/blob/${normalizedTag}/CHANGELOG.md)`,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  let tag = "";
  let repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let output;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tag" && i + 1 < argv.length) {
      tag = argv[++i];
    } else if (arg === "--repo-root" && i + 1 < argv.length) {
      repoRoot = resolve(argv[++i]);
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!tag) {
    throw new Error("Missing required --tag <vX.Y.Z> argument");
  }
  return { tag, repoRoot, output };
}

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const { tag, repoRoot, output } = parseArgs(process.argv.slice(2));
  const notes = buildReleaseNotes(tag, repoRoot);
  if (output) {
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, notes, "utf8");
    console.log(`Wrote release notes for ${tag} to ${target}`);
  } else {
    process.stdout.write(notes);
  }
}
