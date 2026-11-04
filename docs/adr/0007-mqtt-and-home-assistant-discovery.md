# ADR-0007: Native MQTT 3.1.1 Client and Home Assistant Auto-Discovery

**English** · [Português](0007-mqtt-and-home-assistant-discovery.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-04
- **Related:** [ADR-0001](0001-zero-dependency-nodejs.md), [ADR-0003](0003-flat-json-persistence-and-settings-overlay.md)

## Context
Home solo miners often run **Home Assistant** (or Mosquitto MQTT) on the same LAN to control smart plugs (Sonoff, Shelly, Tuya), RGB lights (WLED, Hue, Nanoleaf), desk matrices (Ulanzi TC001 / AWTRIX 3), smart speakers, and solar inverters.

Exposing farm telemetry, energy consumption, weekly championship leaders, and real-time events (new farm record, worker offline, pool failover, achievement unlocked) to Home Assistant enables physical home automations without polling HTTP endpoints or writing custom YAML sensors.

At the same time, [ADR-0001](0001-zero-dependency-nodejs.md) requires zero third-party `npm` dependencies (`node_modules`) so the project installs cleanly with only the system's `node` binary.

## Decision
We implemented a pure Node.js (`net` and `tls`) **MQTT 3.1.1 publish-only client** and **Home Assistant MQTT Auto-Discovery** generator in [`src/mqtt.js`](../../src/mqtt.js):

1. **Zero-Dependency MQTT 3.1.1 Wire Protocol (`src/mqtt.js`):**
   - Implements variable-length integer encoding (`encodeVarInt`), UTF-8 length-prefixed strings (`encodeStr`), `CONNECT` (with username/password and Last Will & Testament `offline` on `<prefix>/availability`), `CONNACK` validation, `PUBLISH` (QoS 0, with or without `retain`), `PINGREQ` keep-alive, and `DISCONNECT`.
   - Supports both plain TCP (`mqtt://host:1883`) and TLS (`mqtts://host:8883`), with automatic reconnection when the broker restarts.
2. **Home Assistant Auto-Discovery (`homeassistant/.../config`):**
   - On connection, publishes retained discovery payloads for 11 sensors (`hashrate`, `best_difficulty`, `best_worker`, `workers_active`, `workers_stopped`, `shares_today`, `power_watts`, `energy_kwh_month`, `cost_month`, `weekly_leader`, `achievements_unlocked`) and 1 binary sensor (`pool_failover`) grouped under a single Home Assistant device (`HomeMinerProxy`).
   - Includes `device_class: power`, `energy`, and `monetary` so the farm plugs directly into the **Home Assistant Energy Dashboard**.
3. **State, Per-Worker Topics, and Instant Events:**
   - Publishes `<prefix>/state` (retained JSON) and `<prefix>/worker/<name>` (retained JSON per active worker) on each tick.
   - Reuses `digest()` and `diffEvents()` from [`src/telegram.js`](../../src/telegram.js) to publish non-retained instant events on `<prefix>/event` (`farm_record`, `personal_record`, `worker_offline`, `worker_online`, `pool_failover`, `pool_recovered`, `wallet_received`, `block_found`, `achievement_unlocked`).
4. **UI Configuration & Secret Masking (`src/settings.js`):**
   - `MQTT_URL`, `MQTT_USER`, `MQTT_PASS` (masked with `type: 'secret'`), and `MQTT_TOPIC` are editable in `/config`, including a **"Test MQTT"** (`POST /api/config/test` with `what: "mqtt"`) button.

## Consequences
- **Positive:**
  - Zero `npm` dependencies preserved.
  - Zero-YAML setup in Home Assistant: the `Mining Farm` device and all 12 entities appear automatically as soon as `MQTT_URL` is configured.
  - Physical home automations (smart plugs, RGB lights, voice announcements, solar surplus mining) can trigger immediately on `<prefix>/event` or react to `<prefix>/state`.
- **Negative / Trade-offs:**
  - Publishes at QoS 0 (fire-and-forget over TCP/TLS), which is ideal for local LAN telemetry and keeps the protocol state machine under 350 lines of code.

