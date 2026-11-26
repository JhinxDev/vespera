# Working on Vespera

Vespera is a self-hosted social media publishing workbench (Node.js 24, SQLite, Playwright, React 19, Tailwind CSS v4). Read `README.md`, `CONTRIBUTING.md`, and `DESIGN.md` before making substantial changes.

## Local Verification

```bash
npm run typecheck
npm test
npm run build:server
npm run build:web
```

- `npm test` runs unit, HTTP/MCP integration, release metadata, and repository hygiene checks (`tests/hygiene.test.ts`). Never track `.env`, `*.local.json`, `*.sqlite*`, API tokens, private LAN IPs, or local Windows user paths.
- Keep `VESPERA_VERSION` synchronized via `package.json`, `package-lock.json`, and `src/version.ts`.

## Releases, Packages, and Deployment

- Every user-facing feature, bug fix, or packaging change on `main` must bump SemVer in `package.json` and `package-lock.json`, move notes under `## <version>` in `CHANGELOG.md`, pass PR CI (`Typecheck, Tests & Build` + `Docker build`), and push an annotated `vX.Y.Z` tag on the merged `main` commit.
- `.github/workflows/docker-publish.yml` publishes `ghcr.io/jhinxdev/vespera` on `main` pushes and `v*` tags. `.github/workflows/release.yml` validates version/changelog metadata via `scripts/release-notes.mjs` and publishes the GitHub Release automatically.
- Live homelab deployment to CT 113 uses `scripts/Deploy-Vespera.ps1` (configured via untracked `.deploy.local.json`).
