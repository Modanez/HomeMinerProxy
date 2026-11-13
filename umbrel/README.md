# HomeMinerProxy on Umbrel (community app store)

These files are an [Umbrel community app store](https://github.com/getumbrel/umbrel-community-app-store).
Umbrel reads a store from the **root** of a git repository, so they live in their own repository:
**https://github.com/Modanez/homeminerproxy-umbrel** (a copy of this folder).

## Install on your Umbrel

1. umbrelOS → **App Store** → ⋯ (top right) → **Community App Stores**.
2. Paste `https://github.com/Modanez/homeminerproxy-umbrel` and click **Add**.
3. Open the store, install **HomeMinerProxy** and open it: the setup wizard asks for your Bitcoin address,
   language and a PIN for the settings.
4. Point your miners at your Umbrel's IP, on the proxy ports (3333 public-pool · 3334 ckpool solo ·
   3335 nerdminers · 3340 Bitronics NerdMiner · 3341 Bitronics Bitaxe · 3337 OCEAN · 3338 atlaspool ·
   3339 ckpool solo EU).

## Notes

- The image is `ghcr.io/modanez/homeminerproxy` (multi-arch: amd64 and arm64), built by CI on every push.
- Data lives in the app's data folder on the Umbrel (`${APP_DATA_DIR}/data`, shipped as `data/.gitkeep` so Umbrel creates it owned by 1000:1000, the user the containers run as), so it survives updates.
- Updating from the dashboard (git/systemd) doesn't apply here: Umbrel updates the app.
- Smart plugs, MQTT, Telegram and miner discovery work. Wi-Fi, Tailscale, SSH and the setup hotspot are
  managed by umbrelOS itself, not by the app.
