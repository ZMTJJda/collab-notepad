# Context — CoMark-Notepad

## What This Project Is

A self-hosted, LAN-first collaborative notepad. Think Google Docs meets a sticky note — no accounts, no cloud, just open a browser and start typing. Files can be shared alongside notes, and documents can be auto-converted to Markdown.

## Why It Exists

For small teams / families on a local network who want zero-friction collaboration without signing up for SaaS. Scan a QR code, get editing.

## Current State (as of latest review)

- **Mature**: 11 rounds of code review completed, 45+ issues fixed
- **Stable**: 66 integration/unit tests all passing
- **Security-hardened**: CSRF protection, rate limiting, timing-safe auth, CSP headers, path traversal prevention, XSS sanitization in HTML→Markdown
- **Feature-complete**: Multi-pad, WebSocket sync, file upload/convert, password protection, invitation system, dark/light theme, mobile-optimized

## Key Files & Their Roles

| File | Lines | Role |
|------|-------|------|
| `server.js` | ~1725 | Single-file backend: Express + WebSocket + all API routes |
| `convert-worker.js` | ~606 | Isolated worker for file→Markdown conversion |
| `public/app.js` | ~1516 | Single-file frontend: all UI logic, WebSocket client |
| `public/index.html` | ~200 | SPA markup with all modals |
| `public/style.css` | — | Apple-style design, responsive, dark/light themes |
| `tests/smoke.test.js` | ~850 | Core integration tests |
| `tests/identity.test.js` | ~1140 | Auth & access control tests |
| `tests/convert.test.js` | ~360 | Worker conversion tests |

## Architecture Highlights

- **No database** — JSON file store with atomic writes (crash-safe via tmp+rename)
- **No frontend framework** — vanilla JS with `$()` helper, direct DOM manipulation
- **Worker isolation** — each conversion runs in a fresh Worker thread with 512MB heap cap
- **Cookie auth** — HMAC-SHA256 signed tokens in httpOnly cookies, 30-day TTL
- **WebSocket rooms** — clients grouped by padId, broadcast scoped per-pad
- **3-tier access** — public pads (anyone), private pads (owner + invited), legacy pads (admin only)

## Deployment

```bash
# Direct
npm start

# Docker
docker compose up -d
```

Data persists in `./data/` (or `DATA_DIR` env var).
