#!/bin/bash
# Installs (or updates) the mining farm: Stratum proxy, web dashboard and, optionally, the cube scoreboard.
# Instala (ou atualiza) a fazenda de mineração: proxy Stratum, painel web e, opcionalmente, o placar do cubo.
# Usage / uso, as root, from the repository folder:
#   sudo bash install.sh
#   sudo BTC_ADDRESS=bc1q... LANGUAGE=pt-BR bash install.sh
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/mineracao}
ENV_FILE=${ENV_FILE:-/etc/mineracao.env}
HERE=$(cd "$(dirname "$0")" && pwd)

cfg_lang=$(grep -E '^LANGUAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)   # idioma da configuração existente
case "${LANGUAGE:-${cfg_lang:-${LANG:-}}}" in pt*|PT*) L=pt ;; *) L=en ;; esac
m() { if [ "$L" = pt ]; then echo "$1"; else echo "$2"; fi; }   # m "português" "english"

[ "$(id -u)" -eq 0 ] || { m "Rode como root (sudo bash install.sh)" "Run as root (sudo bash install.sh)"; exit 1; }
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || { m "Node.js não encontrado. Instale o Node 16 ou mais novo (ex.: apt install nodejs)." "Node.js not found. Install Node 16 or newer (e.g. apt install nodejs)."; exit 1; }
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 16 ] || { m "Node $NODE_MAJOR é antigo demais; precisa do 16 ou mais novo." "Node $NODE_MAJOR is too old; version 16 or newer is required."; exit 1; }

m "==> Copiando os arquivos para $APP_DIR" "==> Copying files to $APP_DIR"
mkdir -p "$APP_DIR"
cp "$HERE"/src/painel.js "$HERE"/src/proxy.js "$HERE"/src/stratum.js "$HERE"/src/i18n.js "$HERE"/src/luck.js "$HERE"/src/telegram.js "$HERE"/src/settings.js "$HERE"/src/cubo.py "$APP_DIR/"

m "==> Configuração em $ENV_FILE" "==> Configuration in $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cp "$HERE/config/mineracao.env.example" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  [ "$L" = pt ] && sed -i 's/^LANGUAGE=.*/LANGUAGE=pt-BR/' "$ENV_FILE"
  m "   criada a partir de config/mineracao.env.example" "   created from config/mineracao.env.example"
fi
current=$(grep -E '^BTC_ADDRESS=' "$ENV_FILE" | cut -d= -f2- || true)
if [ -z "$current" ]; then
  addr=${BTC_ADDRESS:-}
  if [ -z "$addr" ] && [ -t 0 ]; then read -r -p "$(m '   Endereço de bitcoin dos mineradores (bc1...): ' '   Bitcoin address used by the miners (bc1...): ')" addr; fi
  [ -n "$addr" ] || { m "   Defina BTC_ADDRESS em $ENV_FILE e rode de novo." "   Set BTC_ADDRESS in $ENV_FILE and run again."; exit 1; }
  case "$addr" in *[!A-Za-z0-9]*) m "   Endereço com caracteres inválidos: $addr" "   Address has invalid characters: $addr"; exit 1;; esac
  sed -i "s|^BTC_ADDRESS=.*|BTC_ADDRESS=$addr|" "$ENV_FILE"
fi

# PIN da tela de configurações do painel (criado uma vez; fica no .env)
if ! grep -qE '^SETTINGS_PIN=.+' "$ENV_FILE"; then
  pin=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 )))
  sed -i '/^#\?SETTINGS_PIN=/d' "$ENV_FILE"
  printf '\n# PIN to save the dashboard Settings screen (http://SERVER-IP:3000/config)\nSETTINGS_PIN=%s\n' "$pin" >> "$ENV_FILE"
  m "   PIN da tela de configurações criado" "   Settings screen PIN created"
fi
settings_pin=$(grep -E '^SETTINGS_PIN=' "$ENV_FILE" | cut -d= -f2-)

unit() {   # unit <name> <description> <command> [After=...]
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=$2
After=network-online.target ${4:-}
Wants=network-online.target

[Service]
ExecStart=$3
EnvironmentFile=$ENV_FILE
Environment=DATA_DIR=$APP_DIR
WorkingDirectory=$APP_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
}

m "==> Serviços" "==> Services"
unit mineracao-proxy  "Mining farm Stratum proxy" "$NODE_BIN $APP_DIR/proxy.js"
unit mineracao-painel "Mining farm dashboard"     "$NODE_BIN $APP_DIR/painel.js" mineracao-proxy.service
services="mineracao-proxy mineracao-painel"

# Placar do cubo: o serviço fica sempre instalado e espera até haver um CUBE_IP (no .env ou na tela)
if command -v python3 >/dev/null; then
  if command -v apt-get >/dev/null; then
    python3 -c "import PIL" 2>/dev/null || apt-get install -y -q python3-pil >/dev/null || m "   aviso: não consegui instalar o python3-pil (placar do cubo)" "   warning: could not install python3-pil (cube scoreboard)"
    [ -f /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf ] || apt-get install -y -q fonts-dejavu-core >/dev/null || true
  fi
  unit mineracao-cubo "Mining farm scoreboard on the GeekMagic cube" "$(command -v python3) $APP_DIR/cubo.py" mineracao-painel.service
  services="$services mineracao-cubo"
fi

systemctl daemon-reload
systemctl enable $services >/dev/null
systemctl restart $services
sleep 3
systemctl --no-pager --lines=0 status $services || true

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
port=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)
echo
m "Pronto." "Done."
m "  Painel:  http://${ip:-IP-DO-SERVIDOR}:${port:-3000}" "  Dashboard:  http://${ip:-SERVER-IP}:${port:-3000}"
m "  Configurações: http://${ip:-IP-DO-SERVIDOR}:${port:-3000}/config  ·  PIN: $settings_pin" "  Settings: http://${ip:-SERVER-IP}:${port:-3000}/config  ·  PIN: $settings_pin"
m "  Aponte os mineradores para ${ip:-IP-DO-SERVIDOR}: 3333 public-pool · 3334 ckpool solo · 3335 nerdminers · 3337 OCEAN · 3338 atlaspool · 3339 ckpool EU" \
  "  Point your miners to ${ip:-SERVER-IP}: 3333 public-pool · 3334 ckpool solo · 3335 nerdminers · 3337 OCEAN · 3338 atlaspool · 3339 ckpool EU"
