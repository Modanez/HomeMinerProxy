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

1. **HMAC-SHA256 Request Signing (`signRequest`)**:
   - Implements the official Tuya OpenAPI v1.0 signature (`client_id + access_token + t + nonce + stringToSign`) with automatic token caching and transparent renewal on token expiration (`code: 1010`).
2. **Standard DP Normalization (`parseStatus`)**:
   - Parses both standard Tuya Socket/Plug data points (`switch_1`, `cur_power` in `0.1 W`, `cur_voltage` in `0.1 V`, `cur_current` in `mA`, `add_ele` in `0.001 kWh`) and legacy numeric DPs (`1`, `19`, `20`, `18`, `17`).
3. **Secret Masking in `/config`**:
   - `TUYA_SECRET` is treated as a secret field in [`src/settings.js`](../../src/settings.js) (masked to its last 4 characters on `GET /api/config`, stored with `0600` file permissions in `settings.json`).
4. **Watchdog Cooldown**:
   - When `TUYA_WATCHDOG_MIN >= 5` and a specific `TUYA_WORKER` is linked, [`src/painel.js`](../../src/painel.js) power-cycles the plug (off for 8s, then back on) if the worker is `stale` for longer than the threshold, enforcing a 60-minute cooldown between automatic reboots and notifying Telegram/MQTT (`plug_reboot`).

## Consequences

- **Positive:** Works out-of-the-box with any SmartLife / Tuya energy-monitoring plug using a free Tuya IoT Platform account, with zero npm dependencies, full `/config` test button support, and seamless transition from monitoring a fan today to measuring/rebooting a Bitaxe tomorrow.
- **Negative / Trade-offs:** Relies on Tuya Cloud OpenAPI (requires internet connectivity to `openapi.tuyaus.com` / `tuyaeu.com`, which the dashboard already uses for Bitcoin network/price APIs).
