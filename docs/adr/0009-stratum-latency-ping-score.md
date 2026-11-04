# ADR-0009: Stratum Latency (Ping) Measurement and Quality Score Classification

**English** · [Português](0009-stratum-latency-ping-score.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

In Bitcoin solo mining, network latency (RTT / ping) between the miner and the pool's Stratum server is a critical factor for farm efficiency.
- When a new block is mined on the Bitcoin network, the pool dispatches a fresh work template (`mining.notify` with `clean_jobs` flag).
- Shares calculated and sent based on outdated work are discarded as invalid ("stale shares" or "job not found").
- High latency to the pool substantially increases the stale share rejection rate and risks losing block opportunities, while also signaling home connection instability with overseas pools.
- Home farm operators require direct and intuitive visibility into pool response times in milliseconds and an easy-to-interpret health score.

## Decision

1. **Continuous Real-Time Measurement (`src/proxy.js`)**:
   - **Initial TCP Handshake & Health Probes**: The proxy calculates the TCP connect time (`pingMs = Date.now() - connectStart`) during the initial handshake and during periodic health checks (`probe(u)`).
   - **Share Submission (`mining.submit`)**: When relaying a share submission (`mining.submit`), the proxy logs `at: Date.now()`. When the pool replies with `result: true` or error, the Round-Trip Time (`rtt = Date.now() - p.at`) is measured with millisecond precision and recorded for the active upstream and corresponding worker.
2. **Quality Score Classification (`src/stratum.js: pingScore(ms)`)**:
   - 🟢 **Great (`great`, <= 100 ms)**: Ideal latency for solo mining. Near-instantaneous block template propagation, minimal stale share risk (< 0.1%).
   - 🟡 **Good (`good`, 101 ms to 250 ms)**: Acceptable latency for residential connections targeting Stratum servers located overseas (e.g., US or Europe).
   - 🔴 **Poor (`poor`, > 250 ms)**: Critical or unstable latency. Significantly elevates stale share rejection risk.
3. **Multi-layer Exposure**:
   - **Proxy API (`/stats`)**: Every upstream and route reports `pingMs` and `pingScore`, alongside aggregated farm totals.
   - **Dashboard API (`/api/mining` & `/api/widget`)**: The `proxy` object includes `pingMs` and `pingScore`. The KWGT widget endpoint provides formatted `ping` and `pingScore`.
   - **Web Interface**: Network status line displays live pool latency and the corresponding colored score badge.
   - **Telegram Bot**: The `/status` command outputs current pool ping and score when mining through the proxy.

## Consequences

- **Positive:**
  - Proactive diagnosis of network degradation before it causes significant accepted share loss.
  - Instant evaluation when comparing routes/pools (e.g. US vs EU server latencies).
  - Standardized, intuitive visual score (great, good, poor) across all interfaces (Web, Telegram, Widget, JSON).
- **Negative / Trade-offs:**
  - Stores one extra timestamp per pending submit in session memory table (negligible memory and CPU overhead).

