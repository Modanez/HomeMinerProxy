# ⛏️ HomeMinerProxy — Mining Farm

**English** · [Português](README.pt-BR.md)

A Stratum proxy and dashboard for **home solo mining**: Bitaxe, NerdMiner, ESP32 boards, cpuminer on a laptop or phone. Everything runs on a small computer at home (Odroid, Raspberry Pi, Orange Pi or any Linux box), with **no dependencies** besides Node.js.

The goal is to turn the "block lottery" into something fun to watch: every share shows up instantly, records trigger confetti and a siren, and one screen shows the gap between your best hash and the hash of the latest block on the network.

![A new farm record: confetti on the dashboard (the Arduino siren plays at the same time)](docs/img/record.gif)

![Farm screen: record, hashrate, odds and every worker with its latest share](docs/img/dashboard.png)

<details>
<summary>More screenshots</summary>

| Almost a block | History |
|---|---|
| ![Our best hash vs. the latest block hash](docs/img/almost-a-block.png) | ![Hashrate, record over time, hall of fame and power cost](docs/img/history.png) |

| Phone | GeekMagic cube |
|---|---|
| ![Dashboard on a phone](docs/img/mobile.png) | ![Cube scoreboard and new record screen](docs/img/cube.png) |

The screenshots use demo data.
</details>

## How it works

```
Bitaxe / NerdMiner / cpuminer ──► proxy (port 3333, 3334, 3335…) ──► pool
                                    │
                                    └─► computes each share's difficulty ──► web dashboard, siren, cube
```

- **Stratum proxy** (`src/proxy.js`): each miner connects to your home server instead of the pool. The proxy forwards everything **unchanged** and, on the way, rebuilds each share's block header to compute the difficulty it reached. It works with any pool and any miner, without relying on pool APIs or on the device firmware. The port picks the pool:

  | Port | Pool | Fee |
  |---|---|---|
  | 3333 | public-pool.io | 0% |
  | 3334 | solo.ckpool.org (US) | 2% |
  | 3335 | pool.nerdminers.org | 0% |
  | 3337 | OCEAN (shared payouts, not solo) | see ocean.xyz |
  | 3338 | solo.atlaspool.io (anycast, servers on every continent) | 1.5% of the subsidy |
  | 3339 | eusolo.ckpool.org (Europe) | 2% |

  Any other Stratum V1 pool can be added with `PROXY_ROUTES` (see the configuration).

- **Dashboard** (`src/painel.js`), at `http://SERVER-IP:3000`, with four screens:
  - **Farm:** records, hashrate, and the worker list with each worker's latest share.
  - **Bitcoin network:** latest block, difficulty adjustment, halving, and the prize at stake.
  - **History:** charts, hall of fame, and power cost.
  - **Almost a block:** your best hash vs. the latest block hash, leading zeros side by side.

  For a screen attached to the server, use `?kiosk`: screens rotate on their own and the cursor is hidden.
- **Optional extras:**
  - **Siren:** an Arduino with LEDs and a speaker, see `extras/sirene`.
  - **GeekMagic SmallTV cube:** a 240×240 desk scoreboard (`src/cubo.py`).
  - **KWGT widget for Android:** see `extras/kwgt`.

## Languages

The dashboard, cube, widget and installer work in **English** and **Brazilian Portuguese (pt-BR)**.

- **`LANGUAGE=en`** or **`LANGUAGE=pt-BR`** in `/etc/mineracao.env` sets the language. When empty, the dashboard follows the browser, and the cube and widget use English.
- The **PT | EN** button at the top of the dashboard switches the language and remembers the choice in that browser.
- **`?lang=en`** or **`?lang=pt`** on the dashboard or widget URL overrides the language for that page only.
- **`CURRENCY=USD`** or **`CURRENCY=BRL`** sets the currency for money values (BTC price, prize, power bill). The default is BRL for pt-BR and USD otherwise.
- **`POWER_PRICE_KWH=0.15`** sets your electricity price per kWh, in that currency (default 0.15 USD or 0.90 BRL). Together with `WATTS` per worker, it drives the power bill estimate.

## Install

Requires Linux with systemd and Node.js 16 or newer.

```bash
git clone https://github.com/Modanez/HomeMinerProxy.git
cd HomeMinerProxy
sudo bash install.sh
```

On first run the installer asks for your miners' bitcoin address and creates `/etc/mineracao.env`. Every option is documented in `config/mineracao.env.example`. After editing:

```bash
sudo systemctl restart mineracao-proxy mineracao-painel
```

To update, run `git pull && sudo bash install.sh` again. Your configuration and data (records, history) are kept.

## Which pool for which miner?

| Miner | Hashrate | Recommended port | Why |
|---|---|---|---|
| NerdMiner, ESP32 boards | ~50–400 kH/s | **3335** nerdminers | Accepts their tiny share difficulty. Most other pools reject them ("difficulty too low") |
| cpuminer on a PC, phone or SBC | ~1–20 MH/s | **3333** public-pool | No fee and a minimum difficulty of 1 |
| Bitaxe and other small ASICs | ~0.4–10 TH/s | **3334** ckpool or **3338** atlaspool | Proven solo pools. Pick the one with lower latency where you live. The proxy counts accepted and rejected shares per worker (`curl localhost:3336/stats` on the server), so you can compare |
| Any miner, in Europe | | **3339** ckpool EU | Same pool as 3334, closer servers |
| You want small, regular payouts instead of the lottery | | **3337** OCEAN | Not solo: rewards are shared among all miners |

AtlasPool requires a minimum difficulty of 2,000 (around 400 GH/s), so ESP32 miners do not work there.

## Pointing your miners

Username: `YOUR_ADDRESS.worker-name`, any password (e.g. `x`). The name after the dot is what shows on the dashboard.

| Miner | Pool | Port |
|---|---|---|
| cpuminer (`minerd`) | `stratum+tcp://SERVER-IP` | 3333 |
| NerdMiner / ESP32 | `SERVER-IP` | 3335 |
| Bitaxe | `SERVER-IP` | 3334 (set `solo.ckpool.org:3333` as the fallback pool in AxeOS) |

Give the server a fixed IP in your router (DHCP reservation): if its IP changes, every miner loses its pool.

```bash
minerd -a sha256d -o stratum+tcp://192.168.0.10:3333 -u YOUR_ADDRESS.laptop -p x
```

## GeekMagic cube (optional)

Set `CUBE_IP` in `/etc/mineracao.env` and run `install.sh` again. The scoreboard refreshes every 5 minutes, and a new record shows up right away on a "NEW RECORD!" screen. The cube must run the original GeekMagic firmware, which has the photo album mode.

## Development

```bash
npm run check   # syntax of everything
npm test        # tests (Node 18+ and Python 3; cube tests need Pillow)
```

What the tests cover:
- **Share math:** checked against the real **genesis block** and **block 1**. If the byte order were wrong, the hash would not match.
- **Proxy:** runs between a fake pool and a test miner.
- **Dashboard:** starts with no internet access.
- **Translation:** covers the whole page.

The page text lives in Portuguese in the source code. The English version is generated from the table in `src/i18n.js`. If you change a Portuguese string, update the table: `tests/i18n.test.js` fails when an entry no longer matches.

## Security

- Use your **public** bitcoin address only. Nothing in this project asks for a seed or private key.
- The proxy ports (3333–3339) and the dashboard (3000) are meant for your home network. Do not expose them to the internet. For remote access, prefer a VPN such as Tailscale. Raw stats (`3336`) listen on `127.0.0.1` only.

## Support the project

If this project made your block lottery more fun, donations are welcome. ⚡

**Bitcoin (on-chain):** `bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w`

Issues, ideas and pull requests are also very welcome.

## License

MIT
