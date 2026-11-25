# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vespera (such as an authentication bypass, path traversal, token exposure, or XSS), please report it privately through **GitHub Security Advisories** on `JhinxDev/vespera` rather than opening a public issue.

## Deployment Best Practices

- Keep `.env`, `channels.local.json`, `.deploy.local.json`, `api-token.txt`, `media-signing-secret.txt`, and `vespera.sqlite` outside version control.
- Always protect remote `/api/channels/:id/session-state` sync calls behind TLS (`HTTPS`) and strong Bearer tokens (`api-token.txt` or `vsp_live_*` API keys).
- Do not expose the Vespera port (`4660`) directly to the public internet without a reverse proxy, TLS, and access controls if multi-user untrusted access is possible.
