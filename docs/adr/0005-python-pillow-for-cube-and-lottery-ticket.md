# ADR-0005: Python + Pillow for GeekMagic Cube Scoreboard and Telegram Lottery Ticket Images

**English** · [Português](0005-python-pillow-for-cube-and-lottery-ticket.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Two optional features require server-side raster image generation (JPEG / PNG):
1. **GeekMagic SmallTV Cube (`src/cubo.py`)**: Needs a 240×240 JPEG image uploaded over HTTP (`/doUpload`) every 5 minutes and on new farm records.
2. **Telegram Daily Lottery Ticket (`src/ticket.py`)**: Needs a 1080×1350 PNG image attached to the 21:00 daily summary and `/ticket` command (matching the client-side `<canvas>` ticket on the web dashboard).

In Node.js, server-side image rendering (`canvas`, `sharp`, `@napi-rs/canvas`) requires heavy native C++ binaries or prebuilt platform wheels that violate [ADR-0001](0001-zero-dependency-nodejs.md) and often fail on older ARM SBCs. Meanwhile, Python 3 and `python3-pil` (`Pillow`) + `fonts-dejavu-core` are standard, pre-packaged OS packages in Debian/Ubuntu/Armbian/Alpine.

## Decision

1. Use **Python 3 with Pillow (`PIL`)** for server-side image generation in two standalone scripts:
   - [`src/cubo.py`](../../src/cubo.py): Daemon that polls `http://127.0.0.1:3000/api/mining` and uploads 240×240 JPEGs to the cube.
   - [`src/ticket.py`](../../src/ticket.py): CLI filter that reads the `/api/mining` JSON from `stdin` and writes a 1080×1350 PNG to `stdout`, spawned on demand by `ticketImage()` in [`src/telegram.js`](../../src/telegram.js).
2. **Graceful Degradation**:
   - If Python 3 or Pillow is not installed, `src/proxy.js` and `src/painel.js` still run 100% normally; the Telegram bot simply falls back to sending the daily summary as text only, and `src/cubo.py` waits idly without crashing `systemd`.

## Consequences

- **Positive:**
  - Keeps the Node.js services 100% dependency-free while delivering crisp, anti-aliased DejaVu typography and rotated stamps (`PREMIADO!` / `NÃO PREMIADO`) on any Linux SBC or Docker container.
  - Both scripts can be tested and invoked standalone from the CLI (`--json` / `--out`).
- **Negative / Trade-offs:**
  - Introduces a second language (Python 3) in the repository for optional image-rendering tasks.

