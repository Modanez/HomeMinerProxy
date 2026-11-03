# ADR-0003: Flat JSON Persistence and `settings.json` Overlay Protected by PIN

**English** · [Português](0003-flat-json-persistence-and-settings-overlay.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

**HomeMinerProxy** needs to persist:
1. Runtime telemetry: known workers (`workers.json`), hall of fame (`records.json`), 48h hashrate history (`history.json`), Bitcoin difficulty history (`diffhist.json`), proxy stats (`proxy-stats.json`), Telegram polling offset (`telegram.json`), and Cube state (`cubo-state.json`).
2. User configuration: base configuration lives in `/etc/mineracao.env` (owned by `root`, read by `systemd` or Docker Compose), while the dashboard runs as an unprivileged user (`mineracao` or `node`) and offers a web settings screen (`/config`).

## Decision

1. **Flat JSON Persistence in `DATA_DIR`**: Instead of an embedded database (SQLite, LevelDB), state is stored as small, human-readable JSON files in `DATA_DIR` (`/var/lib/mineracao` on systemd, `/data` volume on Docker).
2. **Configuration Overlay (`DATA_DIR/settings.json`)**:
   - Base configuration remains in `/etc/mineracao.env`.
   - When the user saves changes on `/config`, `src/settings.js` writes only the modified keys to `DATA_DIR/settings.json` (atomically via `.tmp` + `fs.renameSync` with mode `0600`).
   - On startup, both `src/painel.js` (`settings.applyOverlay`) and `src/cubo.py` overlay `settings.json` on top of `process.env` / `os.environ`.
3. **PIN Protection & Brute-Force Lockout**:
   - Saving or testing on `/config` requires `SETTINGS_PIN`, compared using `crypto.timingSafeEqual` over SHA-256 digests (`checkPin`).
   - After 5 failed attempts within 15 minutes, the endpoint locks out further attempts (`HTTP 429`).
   - Secrets (`TELEGRAM_BOT_TOKEN`) are never returned in plaintext by `GET /api/config` (only `{ set: true, tail: "last4" }`).

## Consequences

- **Positive:**
  - The dashboard service never needs `root` privileges or write access to `/etc/mineracao.env`.
  - Backups and migrations are trivial (copying `DATA_DIR` preserves all records, history, and UI settings).
  - Safe against SD card corruption on `settings.json` writes thanks to atomic rename.
- **Negative / Trade-offs:**
  - Changing proxy-only settings (`PROXY_ROUTES`) still requires editing `/etc/mineracao.env` and restarting `mineracao-proxy`.

