# Vespera — Agent & Contributor Instructions

Vespera is a self-hosted social media publishing workbench (Node.js 24, SQLite, Playwright, React 19, Tailwind CSS v4). Read `README.md`, `CONTRIBUTING.md`, and `DESIGN.md` before making substantial changes.

## Stack & Layout

- **Backend:** Node.js 24, TypeScript, SQLite, Playwright browser adapters, scheduler, MCP server.
- **Frontend:** React 19, Vite, Tailwind CSS v4 (`DESIGN.md`).
- **Tests:** Unit, HTTP/MCP integration, release metadata, and repository hygiene checks (`tests/hygiene.test.ts`).

## Verify & Run Commands

```bash
npm run typecheck
npm test
npm run build:server
npm run build:web
```

## Active Skills & Tools

- **Frontend & UI:** `modern-web-guidance`, `react-best-practices`, `composition-patterns`, `hallmark`.
- **Automation, Security & CI:** `playwright`, `ffmpeg-skill`, `security-audit`, `gh-fix-ci`, `gh-address-comments`.

## Guardrails & Security

- `tests/hygiene.test.ts` enforces zero secrets, zero private LAN IPv4 addresses, zero local Windows user paths, and zero `.env` / `*.local.json` / `*.sqlite*` files in tracked or untracked source.
- Keep `VESPERA_VERSION` synchronized across `package.json`, `package-lock.json`, and `src/version.ts`.
- Verify UI changes in a real browser at desktop and mobile viewports with reduced-motion and accessibility checks.

## Release & Deploy

- Every user-facing feature, bug fix, or packaging change on `main` must bump SemVer in `package.json` and `package-lock.json`, move notes under `## <version>` in `CHANGELOG.md`, pass PR CI (`Typecheck, Tests & Build` + `Docker build`), and push an annotated `vX.Y.Z` tag on the merged `main` commit.
- `.github/workflows/docker-publish.yml` publishes `ghcr.io/jhinxdev/vespera` on `main` pushes and `v*` tags; `.github/workflows/release.yml` validates release metadata via `scripts/release-notes.mjs` and publishes GitHub Releases automatically.
- Live homelab deployment uses `scripts/Deploy-Vespera.ps1` (configured via untracked `.deploy.local.json`).
