# ADR-0001: Zero Third-Party npm Dependencies for Node.js Services

**English** · [Português](0001-zero-dependency-nodejs.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

**HomeMinerProxy** is designed to run 24/7 on low-power single-board computers at home (Odroid-C2, Raspberry Pi, Orange Pi, old laptops) with minimal RAM, slow SD/eMMC storage, and varying Linux distributions or architectures (`armv7`, `aarch64`, `x86_64`).

Relying on external `npm` packages introduces:
1. Supply-chain security risks — critical in a Bitcoin-related tool, even when only handling public addresses.
2. Installation friction (`npm install`, native addon compilation, version lock rot) on older ARM boards.
3. Unnecessary memory and disk overhead.

## Decision

All Node.js components (`src/proxy.js`, `src/painel.js`, `src/stratum.js`, `src/luck.js`, `src/i18n.js`, `src/settings.js`, `src/telegram.js`) and their tests (`tests/*.test.js`) use **exclusively Node.js built-in modules** (`net`, `http`, `https`, `crypto`, `fs`, `path`, `os`, `child_process`, `node:test`, `node:assert`).

`package.json` contains zero `"dependencies"` and zero `"devDependencies"`.

## Consequences

- **Positive:**
  - Instant installation (`install.sh` simply copies `src/*.js` and `src/*.py` to `/opt/mineracao` without running `npm install`).
  - Zero supply-chain exposure from third-party npm packages.
  - Tiny memory footprint (~30–45 MB RSS per process) and fast startup.
- **Negative / Trade-offs:**
  - Multipart form uploads (for Telegram `sendPhoto`), HTTP retries, and Stratum JSON-RPC line framing are implemented directly in standard JavaScript.

