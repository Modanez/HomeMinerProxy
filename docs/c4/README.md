# 🏗️ Architecture — C4 Model (HomeMinerProxy)

**English** · [Português](README.pt-BR.md)

This document describes the architecture of **HomeMinerProxy** using the **C4 Model** (Context, Containers, Components, and Dynamic Flows).

---

## Level 1 — System Context (C1)

At the highest level, **HomeMinerProxy** sits on a small home server (Odroid, Raspberry Pi, Docker host, or any Linux box) between the home mining hardware and external Bitcoin pools/APIs, turning solo mining into an observable, interactive experience.

```mermaid
flowchart TB
    User["👤 Home Miner\n(Browser, Phone, Kiosk TV)"]
    Miners["⛏️ Mining Hardware\n(Bitaxe, NerdMiner, ESP32, cpuminer)"]

    subgraph HomeLAN["Home Network (LAN)"]
        HMP["🏠 HomeMinerProxy\n(Stratum V1 Proxy, Web Dashboard,\nTelegram Bot & Cube Scoreboard)"]
        Cube["🟦 GeekMagic SmallTV Cube\n(240×240 HTTP Display)"]
        Siren["🚨 Arduino USB Siren\n(Serial /dev/ttyACM0)"]
        KWGT["📱 Android KWGT Widget\n(HTTP JSON Poller)"]
    end

    subgraph External["External Internet Services"]
        Pools["🌐 Stratum V1 Mining Pools\n(public-pool, ckpool US/EU,\nnerdminers, AtlasPool, OCEAN)"]
        PoolAPIs["📊 Pool REST APIs\n(public-pool, ckpool, nerdminers, OCEAN)"]
        BitcoinAPIs["₿ Bitcoin & Market APIs\n(mempool.space, CoinGecko, Binance)"]
        TelegramAPI["✈️ Telegram Bot API\n(api.telegram.org)"]
    end

    Miners <-->|"Stratum V1 over TCP\n(ports 3333–3335, 3337–3339)"| HMP
    HMP <-->|"Stratum V1 over TCP\n(1:1 pass-through + failover)"| Pools
    HMP -->|"HTTPS GET (JSON)"| PoolAPIs
    HMP -->|"HTTPS GET (blocks, diff, wallet, price)"| BitcoinAPIs
    HMP <-->|"HTTPS Long Polling & Alerts\n(sendMessage / sendPhoto)"| TelegramAPI
    HMP -->|"HTTP POST JPEG (/doUpload)"| Cube
    HMP -->|"Serial 9600 baud (R/P/S/T/0/1/2)"| Siren
    User <-->|"HTTP (port 3000)\nDashboard & /config"| HMP
    KWGT -->|"HTTP GET /api/widget"| HMP
```

### External Actors & Systems
| Actor / System | Protocol | Role |
|---|---|---|
| **Home Miner (User)** | HTTP (`:3000`), Telegram | Watches the dashboard (desktop, mobile, or `?kiosk`), edits settings at `/config`, and interacts with the Telegram bot. |
| **Mining Hardware** | Stratum V1 TCP (`:3333–3339`) | Bitaxe, NerdMiner, ESP32, or `cpuminer` (`minerd`) connecting to the local server instead of directly to a pool. |
| **Stratum V1 Pools** | Stratum V1 TCP | Upstream solo/shared pools (`public-pool.io`, `solo.ckpool.org`, `eusolo.ckpool.org`, `pool.nerdminers.org`, `solo.atlaspool.io`, `mine.ocean.xyz`). |
| **Pool REST APIs** | HTTPS JSON | Optional fallback/complement for workers not going through the proxy or for pool-level balances. |
| **Bitcoin & Market APIs** | HTTPS JSON | `mempool.space` (latest blocks, difficulty retarget, fee estimates, historical difficulty, wallet balance) and `CoinGecko` / `Binance` (BTC/USD and BTC/BRL prices). |
| **Telegram Bot API** | HTTPS JSON / Multipart | Receives commands via long polling (`getUpdates`) and delivers alerts and daily lottery-ticket PNGs (`sendMessage`, `sendPhoto`). |
| **GeekMagic SmallTV Cube** | HTTP (`:80`) | 240×240 desk display updated every 5 minutes (or immediately on a new farm record) via JPEG upload. |
| **Arduino USB Siren** | USB Serial (`9600 8N1`) | Plays melodies and drives status LEDs (green/yellow/red) based on single-byte commands. |
| **Android KWGT Widget** | HTTP JSON (`:3000/api/widget`) | Polls pre-formatted farm metrics on the home Wi-Fi or VPN. |

---

## Level 2 — Containers (C2)

**HomeMinerProxy** runs as three lightweight services (managed by `systemd` or `docker compose`) plus an on-demand helper script and flat JSON storage.

```mermaid
flowchart TB
    Miners["⛏️ Miners"]
    User["👤 Browser / Kiosk / KWGT"]
    Pools["🌐 Upstream Stratum Pools"]
    ExtAPIs["🌍 mempool.space / Pool APIs / CoinGecko"]
    TgAPI["✈️ Telegram API"]
    CubeHW["🟦 GeekMagic Cube"]
    Arduino["🚨 Arduino Siren"]

    subgraph Server["HomeMinerProxy Host (Linux / systemd or Docker)"]
        Proxy["⚙️ Stratum Proxy\n(Node.js · src/proxy.js)\nPorts 3333–3339, 127.0.0.1:3336"]
        Painel["🖥️ Web Dashboard & Bot\n(Node.js · src/painel.js)\nPort 3000"]
        Ticket["🎟️ Ticket Renderer\n(Python 3 + Pillow · src/ticket.py)\nOn-demand CLI subprocess"]
        Cubo["🧊 Cube Scoreboard Service\n(Python 3 + Pillow · src/cubo.py)\nBackground daemon"]
        EnvFile[("📄 /etc/mineracao.env\nBase Configuration")]
        DataDir[("💾 DATA_DIR (JSON Files)\nsettings.json · workers.json\nrecords.json · history.json\ndiffhist.json · proxy-stats.json\ntelegram.json · cubo-state.json")]
    end

    Miners <-->|"Stratum V1 TCP"| Proxy
    Proxy <-->|"Stratum V1 TCP"| Pools
    Proxy <-->|"Reads/Writes proxy-stats.json"| DataDir
    Painel -->|"HTTP GET 127.0.0.1:3336/stats\n(every 15s)"| Proxy
    Painel -->|"HTTPS GET"| ExtAPIs
    Painel <-->|"HTTPS Long Polling"| TgAPI
    Painel -->|"Spawns stdin JSON -> stdout PNG"| Ticket
    Painel -->|"Writes R/P/S/T/0/1/2"| Arduino
    Painel <-->|"Reads/Writes JSON state & settings.json"| DataDir
    EnvFile -.->|"Environment variables"| Proxy
    EnvFile -.->|"Environment variables"| Painel
    EnvFile -.->|"Environment variables"| Cubo
    Cubo -->|"HTTP GET 127.0.0.1:3000/api/mining\n(every 60s)"| Painel
    Cubo -->|"HTTP POST JPEG"| CubeHW
    Cubo <-->|"Reads settings.json & cubo-state.json"| DataDir
    User <-->|"HTTP :3000"| Painel
```

### Container Inventory
| Container | Runtime | Entrypoint | Responsibility |
|---|---|---|---|
| **`mineracao-proxy`** | Node.js (>=16, zero deps) | [`src/proxy.js`](../../src/proxy.js) | Listens on ports `3333–3339`, forwards Stratum V1 traffic 1:1, reconstructs 80-byte block headers to compute share difficulty/hash, manages pool failover/failback, persists `proxy-stats.json`, and serves `http://127.0.0.1:3336/stats`. |
| **`mineracao-painel`** | Node.js (>=16, zero deps) | [`src/painel.js`](../../src/painel.js) | Serves the bilingual web UI (`/`, `/config`) and JSON APIs (`/api/mining`, `/api/widget`, `/api/alarm`, `/api/config`), polls local proxy and external APIs, drives the Arduino siren, and runs the Telegram bot. |
| **`mineracao-cubo`** | Python 3 + Pillow | [`src/cubo.py`](../../src/cubo.py) | Polls `/api/mining` every minute, renders a 240×240 scoreboard JPEG every 5 minutes (or a 10-minute celebration screen immediately upon a new farm record), and uploads it to the GeekMagic cube. |
| **`ticket.py`** | Python 3 + Pillow | [`src/ticket.py`](../../src/ticket.py) | Spawned on-demand by the Telegram bot (`src/telegram.js`) to render the 1080×1350 daily lottery ticket PNG from the `/api/mining` snapshot. |
| **JSON Data Store (`DATA_DIR`)** | Filesystem | `/var/lib/mineracao` or `/data` | Stores `settings.json` (UI config overlay), `proxy-stats.json`, `workers.json`, `records.json`, `history.json`, `achievements.json`, `diffhist.json`, `telegram.json`, and `cubo-state.json`. |

---

## Level 3 — Components (C3)

### 3.1 Stratum Proxy Components (`src/proxy.js` & `src/stratum.js`)

```mermaid
flowchart LR
    subgraph ProxyProcess["src/proxy.js"]
        Listeners["TCP Route Listeners\n(ports 3333–3339)"]
        Session["Session State Machine\n(session / lineReader)"]
        StratumMath["Stratum Header & Diff Math\n(src/stratum.js)"]
        Health["Upstream Health & Failover\n(probe / healthCheck)"]
        StatsStore["Worker Stats & Histogram\n(workers, hist, saveStats)"]
        StatsHTTP["Local Stats HTTP Server\n(127.0.0.1:3336/stats)"]
    end

    Listeners --> Session
    Session -->|"mining.submit + job + en1"| StratumMath
    Session <-->|"Select upstream / markDown"| Health
    Session -->|"Accepted / Rejected share"| StatsStore
    StatsStore --> StatsHTTP
```

- **[`src/stratum.js`](../../src/stratum.js)**: Pure cryptographic math (`sha256d`, `swap32`, `shareDifficulty`, `hashDifficulty`) that rebuilds the coinbase transaction, Merkle root, version mask (`BIP310`), and 80-byte block header to compute exact share difficulty and explorer-format block hash.
- **Session State Machine (`session` in [`src/proxy.js`](../../src/proxy.js))**: Buffers initial miner messages until the upstream socket connects, tracks `mining.subscribe` (`extranonce1`), `mining.configure` (`version-rolling.mask`), `mining.notify` (up to 32 active jobs), `mining.set_difficulty`, and correlates `mining.submit` requests with upstream responses.
- **Health & Failover Manager (`healthCheck`, `probe`)**: Marks unresponsive pools as down, routes miners to backup pools without altering their payout address, probes down pools every 60s, and closes backup sessions on recovery so miners reconnect to the primary pool.

### 3.2 Dashboard & Bot Components (`src/painel.js` & modules)

```mermaid
flowchart TB
    subgraph PainelProcess["src/painel.js"]
        HTTPServer["HTTP Router & Server\n(:, /, /api/mining, /api/widget, /api/alarm)"]
        Collectors["Background Collectors\n(tickProxy, tickPool, tickCkpools,\ntickOcean, tickWallet, tickNetwork,\ntickDiffHist, tickLocal)"]
        StateEngine["Farm State & Snapshot\n(workersView, snapshot, timeMachine, energy)"]
        LuckMod["Luck Calculator\n(src/luck.js)"]
        I18nMod["Localization Engine\n(src/i18n.js)"]
        SettingsMod["Settings UI & Overlay\n(src/settings.js)"]
        TelegramMod["Telegram Bot & Alert Diff\n(src/telegram.js)"]
        AlarmMod["USB Siren Controller\n(alarm / alarmStatus)"]
    end

    Collectors --> StateEngine
    StateEngine --> LuckMod
    StateEngine --> AlarmMod
    HTTPServer --> StateEngine
    HTTPServer --> I18nMod
    HTTPServer --> SettingsMod
    TelegramMod --> StateEngine
```

- **[`src/painel.js`](../../src/painel.js)**: Core orchestrator, background polling loops (`every`), state aggregation (`workersView`, `snapshot`), Arduino serial controller (`alarm`), and embedded SPA HTML/CSS/JS.
- **[`src/luck.js`](../../src/luck.js)**: Statistical model (`luckOf`, `theoreticalShare`), weekly championship engine (`weekKey`, `weeklyStandings`), and farm achievements engine (`ACHIEVEMENTS`, `evaluateAchievements`).
- **[`src/i18n.js`](../../src/i18n.js)**: Language negotiation (`?lang` > `lang` cookie > `LANGUAGE` env > `Accept-Language` > `'en'`) and deterministic PT -> EN page translation (`localizePage`).
- **[`src/settings.js`](../../src/settings.js)**: Renders `/config`, validates fields (`clean`, including per-worker `WATTS` and `EXPECTED` hashrate maps), enforces SHA-256 timing-safe `SETTINGS_PIN` verification with brute-force lockout (`checkPin`), persists `settings.json`, exports/restores full farm JSON backups (`exportBackup`, `restoreBackup`), and tests Cube/Telegram connectivity.
- **[`src/telegram.js`](../../src/telegram.js)**: Long-polling client (`getUpdates`), state diffing engine (`digest`, `diffEvents`), command handlers (`/status`, `/workers`, `/luck`, `/records`, `/championship`, `/achievements`, `/ticket`, `/help`), and child-process bridge to `src/ticket.py`.

---

## Level 4 — Dynamic Flows (C4)

### 4.1 Share Submission & New Farm Record Celebration

```mermaid
sequenceDiagram
    autonumber
    participant M as ⛏️ Miner
    participant P as ⚙️ Proxy (src/proxy.js)
    participant Pool as 🌐 Upstream Pool
    participant D as 🖥️ Dashboard (src/painel.js)
    participant S as 🚨 Arduino Siren
    participant T as ✈️ Telegram Bot (src/telegram.js)
    participant C as 🧊 Cube Daemon (src/cubo.py)

    M->>P: mining.submit(worker, jobId, en2, ntime, nonce, vbits)
    P->>P: shareDifficulty() rebuilds 80B header & computes diff/hash
    P->>Pool: Forward mining.submit unchanged
    Pool-->>P: {"id": ..., "result": true, "error": null}
    P->>P: Update worker bestEver, dayBestHash, luck work & histogram
    P-->>M: Forward {"result": true}
    D->>P: GET http://127.0.0.1:3336/stats (every 15s)
    P-->>D: JSON stats (workers, bestHash, dayBestHash, hist)
    D->>D: rememberWorkers() detects best > topRecord() -> addRecord()
    D->>S: Write 'R' (or 'r' during QUIET_HOURS) to /dev/ttyACM0
    T->>D: tick() compares digest(snapshot()) with previous state
    T->>T: diffEvents() emits 'record' alert
    T->>T: POST /bot<token>/sendMessage ("🏆 New farm record!")
    C->>D: GET http://127.0.0.1:3000/api/mining (every 60s)
    C->>C: Detects newest_farm_record() -> draw_party()
    C->>C: Upload 240×240 celebration JPEG to Cube for 10 min
```

### 4.2 Pool Failover and Automatic Failback

```mermaid
sequenceDiagram
    autonumber
    participant M as ⛏️ Miner
    participant P as ⚙️ Proxy (src/proxy.js)
    participant Main as 🌐 Primary Pool
    participant Bkp as 🛡️ Backup Pool

    M->>P: TCP connect + mining.subscribe / mining.authorize (queued)
    P->>Main: TCP connect (timeout 8s)
    Main--xP: Connection timeout / ECONNREFUSED
    P->>P: markDown(Main)
    P->>Bkp: TCP connect to first available backup
    Bkp-->>P: Connected!
    P->>Bkp: Flush queued mining.subscribe & mining.authorize
    Bkp-->>M: Mining continues seamlessly on Backup Pool
    loop Every 60s (HEALTH_MS)
        P->>Main: probe(Main)
        Main-->>P: TCP connect succeeds!
        P->>P: markUp(Main)
        P->>M: Close backup session ("pool principal voltou")
    end
    M->>P: Reconnects automatically -> routed to Main Pool
```

