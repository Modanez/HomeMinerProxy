# ADR-0008: Direct SmartLife / Tuya OpenAPI v1.0 Smart Plug Integration

**English** · [Português](0008-smartlife-tuya-smart-plug.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

Home solo miners frequently plug their ASIC miners (such as Bitaxe) or cooling fans into **SmartLife / Tuya Wi-Fi smart plugs** with energy monitoring. Users want:
1. **Real-time power telemetry** (Watts, Volts, mA, on/off state) directly on the dashboard, Telegram, and MQTT without requiring a separate Home Assistant server.
2. **Flexible linking (`TUYA_WORKER`)**:
   - **Monitor-only mode (`""`)**: shows the plug's live Watts and Volts on the dashboard (e.g., when a fan or other appliance is plugged in before the ASIC arrives) without adding its consumption to the miners' electricity bill estimate.
   - **Specific worker (`bitaxe`) or whole farm (`*`)**: replaces static `WATTS` estimates with the real live measurement from the smart plug.
3. **Remote power control and watchdog auto-reboot**: ability to switch on/off or power-cycle the plug via Telegram (`/plug on|off|reboot`) and optionally auto-reboot a frozen miner if it goes `TUYA_WATCHDOG_MIN` minutes without submitting shares.

## Decision

We implemented a native, zero-dependency **Tuya OpenAPI v1.0** client in [`src/tuya.js`](../../src/tuya.js) using Node's built-in `https` and `crypto` modules:

1. **HMAC-SHA256 Request Signing (`signRequest`) & Automatic Multi-Datacenter Discovery**:
   - Implements the official Tuya OpenAPI v1.0 signature (`client_id + access_token + t + nonce + stringToSign`) with automatic token caching and transparent renewal on token expiration (`code: 1010`).
   - Supports all 6 Tuya regional Data Centers (`us`, `us-east`, `eu`, `eu-west`, `cn`, `in`) and automatically probes remaining regional endpoints if the configured region returns `sign invalid` (`1004`), `permission deny` (`1106`), or `"data center is suspended"` (common on Tuya Free Trial accounts limited to `1 / 1` active Data Center).
2. **Standard DP Normalization (`parseStatus`) & Multi-Path Status Fallback**:
   - Queries `/v1.0/iot-03/devices/{id}/status` with automatic fallback to `/v1.0/devices/{id}/status`, `/v1.0/devices/{id}`, and `/v2.0/cloud/thing/{id}/shadow/properties`.
   - Parses both standard Tuya Socket/Plug data points (`switch_1`, `cur_power` in `0.1 W`, `cur_voltage` in `0.1 V`, `cur_current` in `mA`, `add_ele` in `0.001 kWh`) and legacy numeric DPs (`1`, `19`, `20`, `18`, `17`).
3. **Dynamic Multi-Plug List (`TUYA_PLUGS`) & Backward-Compatible Migration**:
   - Users can register any number of SmartLife / Tuya plugs or devices (`TUYA_PLUGS` JSON array of `{ name, deviceId, worker, watchdogMin }`) under a single Tuya Cloud project, sharing the cached OAuth token.
   - `normalizePlugs()` automatically migrates legacy single-plug configurations (`TUYA_DEVICE_ID`, `TUYA_WORKER`, `TUYA_WATCHDOG_MIN`) into `TUYA_PLUGS` without user intervention.
4. **Secret Masking in `/config` & Direct Dashboard Control (`POST /api/plug`)**:
   - `TUYA_SECRET` is treated as a secret field in [`src/settings.js`](../../src/settings.js) (masked to its last 4 characters on `GET /api/config`, stored with `0600` file permissions in `settings.json`).
   - `POST /api/plug` allows turning on, turning off, or power-cycling any registered plug directly from the main dashboard Energy card, protected by timing-safe `SETTINGS_PIN` verification and brute-force lockout.
5. **Watchdog Cooldown & 24h Power History**:
   - When `watchdogMin >= 5` and a specific `worker` is linked on a plug, [`src/painel.js`](../../src/painel.js) power-cycles that plug (off for 8s, then back on) if the worker is `stale` for longer than the threshold, enforcing a 60-minute cooldown between automatic reboots and notifying Telegram/MQTT (`plug_reboot`).
   - `sampleHistory()` records live Watts (`w`) alongside farm hashrate (`hr`) in `history.json`.

## Consequences

- **Positive:** Works out-of-the-box with any SmartLife / Tuya energy-monitoring plug using a free Tuya IoT Platform account, with zero npm dependencies, full `/config` test button support, and seamless transition from monitoring a fan today to measuring/rebooting a Bitaxe tomorrow.
- **Negative / Trade-offs:** Relies on Tuya Cloud OpenAPI (requires internet connectivity to `openapi.tuyaus.com` / `tuyaeu.com`, which the dashboard already uses for Bitcoin network/price APIs).

