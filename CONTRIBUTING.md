# Contributing to Vespera

Thank you for contributing to Vespera!

## Local Setup

```bash
git clone https://github.com/JhinxDev/vespera.git
cd vespera
npm ci
cp .env.example .env
cp channels.example.json channels.local.json
npm run typecheck
npm test
npm run build:server
npm run build:web
```

## Development Scripts

- `npm run dev` starts the Node.js API & built frontend server (use `npm run dev:web` alongside it for Vite hot reload).
- `npm run typecheck` checks TypeScript types across both server (`src/`) and frontend (`web/src/`).
- `npm test` runs the unit, HTTP/MCP integration, and repository hygiene test suite.
- `npm run build` compiles the server and React frontend into `dist/`.

## Pull Request Guidelines

1. Keep `channels.local.json`, `.env`, `.deploy.local.json`, and SQLite databases untracked (`npm test` enforces zero leaked tokens, private IPs, or local user paths).
2. Add focused unit tests in `tests/` for new API endpoints, adapters, or store logic.
3. Run `npm run typecheck`, `npm test`, `npm run build:server`, and `npm run build:web` before opening a pull request.
