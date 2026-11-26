# Changelog

All notable changes to Vespera are documented in this file.

## Unreleased

## 1.1.0 - 2026-11-26

- **On-demand Live Browser (noVNC)**: launch an isolated `Xvfb` + `openbox` + `x11vnc` + `websockify` session inside the container with 15-minute auto-stop and clean Chromium cookie flush on exit.
- **Full-Chrome YouTube uploader**: populate YouTube tags, video language, category, and `.srt` captions in ephemeral Xvfb with native UA, enforce chapter-before-links ordering, and harden altered-content selection.
- **Scheduler & session persistence**: harden just-in-time dispatch, profile locking, one-time YouTube session stability, automatic re-queueing of `needs_login` jobs after verified sign-in, and Upcoming Releases UX clarity.
- **Automated GHCR & GitHub Releases**: add CI Docker build validation, automatic multi-tag GHCR publishing (`ghcr.io/jhinxdev/vespera`), version-verified release notes (`scripts/release-notes.mjs`), and tag-triggered GitHub Releases.

## 1.0.0 - 2026-11-25

- Initial open-source release of Vespera: self-hosted social media publishing workbench (Node.js 24, SQLite, React 19, Tailwind CSS v4), direct browser media upload, native Edge session sync, YouTube/Reddit OAuth2, HMAC-SHA256 webhooks, and stdio MCP server.
