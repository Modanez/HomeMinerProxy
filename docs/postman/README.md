# 📮 Postman Collections — HomeMinerProxy HTTP APIs

**English** · [Português](README.pt-BR.md)

This directory contains the **Postman v2.1 collections** and environment file covering all HTTP endpoints exposed by the **Dashboard (`src/painel.js`)** and the **Stratum Proxy (`src/proxy.js`)**.

## Files

| File | Description |
|---|---|
| [`HomeMinerProxy.postman_collection.json`](HomeMinerProxy.postman_collection.json) | Postman Collection v2.1 in **English** |
| [`HomeMinerProxy.pt-BR.postman_collection.json`](HomeMinerProxy.pt-BR.postman_collection.json) | Postman Collection v2.1 in **Brazilian Portuguese (pt-BR)** |
| [`HomeMinerProxy.postman_environment.json`](HomeMinerProxy.postman_environment.json) | Postman Environment with default local variables |

## Importing into Postman

1. Open **Postman** -> **Import**.
2. Select [`HomeMinerProxy.postman_collection.json`](HomeMinerProxy.postman_collection.json) (or [`HomeMinerProxy.pt-BR.postman_collection.json`](HomeMinerProxy.pt-BR.postman_collection.json)) and [`HomeMinerProxy.postman_environment.json`](HomeMinerProxy.postman_environment.json).
3. Select the **HomeMinerProxy Local** environment in the top-right selector and adjust `baseUrl` or `settingsPin` if needed.

## Covered Endpoints

### 1. Dashboard Pages (`:3000`)
- `GET /` — Main dashboard HTML (follows `LANGUAGE` or browser `Accept-Language`).
- `GET /?lang=en` & `GET /?lang=pt` — Forces English or Brazilian Portuguese.
- `GET /?kiosk` — Kiosk mode (auto-rotates the 5 screens and hides cursor).
- `GET /config` — Web settings screen HTML.

### 2. Dashboard Data & Hardware APIs (`:3000`)
- `GET /api/mining` — Full farm snapshot (`farm`, `hall`, `recentRecords`, `history`, `energy`, `wallet`, `net`, `nearBlock`, `luck`, `proxy`, `ocean`, `ckpools`, `health`).
- `GET /api/widget?lang=en` & `GET /api/widget?lang=pt` — Pre-formatted compact JSON for mobile widgets (KWGT).
- `GET /api/alarm?e=T` — Sends a command to the Arduino USB siren (`T` test, `R` farm record, `P` personal record, `S` share, `0` green, `1` yellow, `2` red).

### 3. Settings & Backup APIs (`:3000`)
- `GET /api/config` — Returns current effective settings (including `WATTS` and `EXPECTED` maps, and masking `TELEGRAM_BOT_TOKEN` to its last 4 chars), known worker names, and whether `SETTINGS_PIN` is set.
- `POST /api/config` — Validates and saves settings to `DATA_DIR/settings.json` (requires `pin`) and restarts the dashboard when values change.
- `POST /api/config/test` (`what: "cube"`) — Tests HTTP reachability of the GeekMagic SmallTV cube (`CUBE_IP`).
- `POST /api/config/test` (`what: "telegram"`) — Sends a test message through the Telegram Bot API using the provided or stored token and `TELEGRAM_CHAT_ID`.
- `POST /api/config/backup` — Exports a full JSON backup (`version: 1`) containing `settings`, `workers`, `records`, `history`, `proxyStats`, `telegram`, and `cubo` (requires `pin`).
- `POST /api/config/restore` — Validates and restores a JSON backup to `DATA_DIR` (requires `pin`) and restarts the dashboard.

### 4. Stratum Proxy Internal API (`127.0.0.1:3336`)
- `GET /stats` — Raw real-time proxy statistics per worker, route/upstream failover health, last-hour share count, `bestHash`, `dayBestHash`, and the 40-bucket difficulty histogram (`hist`).

