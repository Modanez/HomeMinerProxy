# ADR-0002: Transparent 1:1 Stratum V1 Pass-Through Proxy with Port Routing and Failover

**English** · [Português](0002-transparent-stratum-proxy-and-failover.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Home solo miners use heterogeneous hardware (NerdMiner/ESP32 at ~100 kH/s, `cpuminer` at ~5 MH/s, Bitaxe ASICs at ~1 TH/s) across different solo pools (`public-pool`, `solo.ckpool`, `nerdminers`, `AtlasPool`, `OCEAN`).
- Pool REST APIs are often slow, rate-limited, hide inactive workers, or do not expose individual share hashes and difficulties in real time.
- Standard Stratum aggregating proxies rewrite `extranonce` or pool credentials, which breaks low-diff miners (ESP32) when mixed with ASICs or forces all devices onto a single pool.

## Decision

1. **1:1 Pass-Through Architecture (`src/proxy.js`)**: Each incoming miner TCP connection opens a dedicated 1:1 upstream TCP connection to the target pool. Every JSON-RPC line (`mining.subscribe`, `mining.configure`, `mining.authorize`, `mining.notify`, `mining.submit`) is forwarded **unchanged**.
2. **Port-Based Pool Routing**: The local listening port selects the target pool (`3333` -> `public-pool`, `3334` -> `ckpool US`, `3335` -> `nerdminers`, `3337` -> `OCEAN`, `3338` -> `atlaspool`, `3339` -> `ckpool EU`), configurable via `PROXY_ROUTES`.
3. **Passive Share Header Reconstruction (`src/stratum.js`)**: While passing messages through, the proxy records `extranonce1`, `version-rolling.mask`, and `mining.notify` job parameters, rebuilding the 80-byte Bitcoin block header on every `mining.submit` to compute the exact share hash and difficulty (`DIFF1 / hash`).
4. **Automatic Failover & Failback**: Each route can define `backup` pools. If the primary pool fails to connect within `PROXY_CONNECT_TIMEOUT_MS`, the proxy connects to the first healthy backup and replays the queued handshake messages. A background health probe (`PROXY_HEALTH_MS`, 60s) retests down pools and closes backup sessions when the primary recovers so miners reconnect to the primary pool.

## Consequences

- **Positive:**
  - Works with any Stratum V1 miner and pool without modifying device firmware or pool payouts (since the miner's `address.worker` username passes through untouched).
  - Real-time visibility into every single share, its 64-char hex hash, leading zeros, and statistical luck histogram.
  - Seamless pool failover even for cheap miners (like ESP32/NerdMiner) that lack robust multi-pool failover in firmware.
- **Negative / Trade-offs:**
  - Opens one upstream TCP socket per miner rather than multiplexing all miners over a single upstream connection (negligible for home farms with 1–20 devices).

