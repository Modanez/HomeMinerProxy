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
cp "$HERE"/src/painel.js "$HERE"/src/proxy.js "$HERE"/src/stratum.js "$HERE"/src/i18n.js "$HERE"/src/luck.js "$HERE"/src/telegram.js "$HERE"/src/mqtt.js "$HERE"/src/tuya.js "$HERE"/src/sonoff.js "$HERE"/src/settings.js "$HERE"/src/setup.js "$HERE"/src/update.js "$HERE"/src/localminer.js "$HERE"/src/netctl.js "$HERE"/src/clock.js "$HERE"/src/bitaxe.js "$HERE"/src/store.js "$HERE"/src/discover.js "$HERE"/src/hotspot.js "$HERE"/src/kiosk.js "$HERE"/src/kiosk.sh "$HERE"/src/cubo.py "$HERE"/src/ticket.py "$APP_DIR/"

m "==> Configuração em $ENV_FILE" "==> Configuration in $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cp "$HERE/config/mineracao.env.example" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  [ "$L" = pt ] && sed -i 's/^LANGUAGE=.*/LANGUAGE=pt-BR/' "$ENV_FILE"
  m "   criada a partir de config/mineracao.env.example" "   created from config/mineracao.env.example"
fi
current=$(grep -E '^BTC_ADDRESS=' "$ENV_FILE" | cut -d= -f2- || true)
# Endereço já salvo pela tela (assistente de primeira configuração ou /config)?
saved_addr=$(grep -o '"BTC_ADDRESS": *"[A-Za-z0-9]*"' "$APP_DIR/settings.json" 2>/dev/null || true)
wizard=0
if [ -z "$current" ] && [ -z "$saved_addr" ]; then
  addr=${BTC_ADDRESS:-}
  if [ -z "$addr" ] && [ -t 0 ] && [ -z "${HOMEMINER_UNATTENDED:-}" ]; then read -r -p "$(m '   Endereço de bitcoin dos mineradores (bc1..., Enter para configurar pelo navegador): ' '   Bitcoin address used by the miners (bc1..., Enter to set it up in the browser): ')" addr; fi
  if [ -n "$addr" ]; then
    case "$addr" in *[!A-Za-z0-9]*) m "   Endereço com caracteres inválidos: $addr" "   Address has invalid characters: $addr"; exit 1;; esac
    sed -i "s|^BTC_ADDRESS=.*|BTC_ADDRESS=$addr|" "$ENV_FILE"
  else
    wizard=1   # o painel abre o assistente no navegador e pergunta lá
    m "   Sem endereço por enquanto: o painel vai abrir o assistente de primeira configuração no navegador." "   No address yet: the dashboard will open the first-setup wizard in the browser."
  fi
fi

# PIN da tela de configurações do painel (criado uma vez; fica no .env).
# Não cria quando o assistente vai pedir um PIN (imagem pronta) ou quando ele já criou (pin.json).
if [ "$wizard" = 0 ] && [ -z "${HOMEMINER_IMAGE:-}" ] && [ ! -f "$APP_DIR/pin.json" ] && ! grep -qE '^SETTINGS_PIN=.+' "$ENV_FILE"; then
  pin=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 )))
  sed -i '/^#\?SETTINGS_PIN=/d' "$ENV_FILE"
  printf '\n# PIN to save the dashboard Settings screen (http://SERVER-IP:3000/config)\nSETTINGS_PIN=%s\n' "$pin" >> "$ENV_FILE"
  m "   PIN da tela de configurações criado" "   Settings screen PIN created"
fi
settings_pin=$(grep -E '^SETTINGS_PIN=' "$ENV_FILE" | cut -d= -f2- || true)

# Versão instalada (para a tela de configurações e o botão "Atualizar")
ver=$("$NODE_BIN" -p "require('$HERE/package.json').version" 2>/dev/null || true)
commit=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || true)
printf '{"version":"%s","commit":"%s","repo":"%s","installedAt":"%s"}\n' "$ver" "$commit" "$HERE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP_DIR/version.json"

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

# Rede de configuração sem cabo (hotspot): com o NetworkManager, se a placa ligar sem rede e houver um Wi-Fi
# que aceite o modo ponto de acesso, ela cria a rede "HomeMiner-Setup" para configurar o Wi-Fi pelo celular.
if command -v nmcli >/dev/null; then
  if command -v apt-get >/dev/null && ! command -v dnsmasq >/dev/null && [ ! -x /usr/sbin/dnsmasq ]; then
    apt-get install -y -q dnsmasq-base >/dev/null || m "   aviso: não consegui instalar o dnsmasq-base (hotspot)" "   warning: could not install dnsmasq-base (hotspot)"
  fi
  # na rede do hotspot, todo nome aponta para a placa: o celular mostra o aviso "entrar na rede" e abre o painel
  mkdir -p /etc/NetworkManager/dnsmasq-shared.d
  printf '%s\n' "# HomeMinerProxy: na rede de configuração (HomeMiner-Setup) todo nome aponta para a placa" "address=/#/10.42.0.1" > /etc/NetworkManager/dnsmasq-shared.d/homeminer-captive.conf
  unit mineracao-hotspot "HomeMinerProxy setup Wi-Fi (hotspot when there is no network)" "$NODE_BIN $APP_DIR/hotspot.js"
  services="$services mineracao-hotspot"
fi

# Tela ligada na placa (opção KIOSK): serviço criado desligado. Quem liga é o painel, que instala o cage e o
# Chromium pelo apt na primeira vez. Abre o painel em tela cheia na tela 1 (tty1) no lugar do login de texto.
chmod 755 "$APP_DIR/kiosk.sh"
cat > /etc/systemd/system/mineracao-kiosk.service <<UNIT
[Unit]
Description=HomeMinerProxy dashboard on the board's screen (kiosk, managed by the dashboard)
After=mineracao-painel.service systemd-user-sessions.service plymouth-quit-wait.service
Wants=mineracao-painel.service
Conflicts=getty@tty1.service
After=getty@tty1.service

[Service]
EnvironmentFile=$ENV_FILE
Environment=XDG_RUNTIME_DIR=/run/user/0
Environment=WLR_LIBINPUT_NO_DEVICES=1
ExecStart=/bin/sh $APP_DIR/kiosk.sh
User=root
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
UtmpIdentifier=tty1
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target multi-user.target
UNIT

# Minerador local opcional: com o cpuminer instalado (imagens prontas), cria o serviço desligado.
# Quem liga e desliga é o painel, pela opção "Minerar também com este servidor".
MINERD_BIN=$(command -v minerd || true)
[ -n "$MINERD_BIN" ] || { [ -x /usr/local/bin/minerd ] && MINERD_BIN=/usr/local/bin/minerd; } || true
if [ -n "$MINERD_BIN" ]; then
  cat > /etc/systemd/system/mineracao-minerador.service <<UNIT
[Unit]
Description=Mining farm local cpuminer (optional, managed by the dashboard)
After=network-online.target mineracao-proxy.service
Wants=network-online.target

[Service]
EnvironmentFile=$APP_DIR/minerador.env
ExecStart=$MINERD_BIN -a sha256d -o stratum+tcp://127.0.0.1:\${MINER_PORT} -u \${MINER_USER} -p x -t \${MINER_THREADS}
Nice=19
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT
fi

if [ -n "${HOMEMINER_IMAGE:-}" ]; then
  # montando a imagem do cartão (chroot, sem systemd rodando): só deixa os serviços ativados para o primeiro boot
  systemctl enable $services >/dev/null
else
  systemctl daemon-reload
  systemctl enable $services >/dev/null
  systemctl restart $services
  sleep 3
  systemctl --no-pager --lines=0 status $services || true
fi

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
port=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)
echo
m "Pronto." "Done."
m "  Painel:  http://${ip:-IP-DO-SERVIDOR}:${port:-3000}" "  Dashboard:  http://${ip:-SERVER-IP}:${port:-3000}"
if [ "$wizard" = 1 ]; then
  m "  Primeira configuração: abra http://$(hostname).local:${port:-3000} ou http://${ip:-IP-DO-SERVIDOR}:${port:-3000} no navegador" "  First setup: open http://$(hostname).local:${port:-3000} or http://${ip:-SERVER-IP}:${port:-3000} in your browser"
elif [ -n "$settings_pin" ]; then
  m "  Configurações: http://${ip:-IP-DO-SERVIDOR}:${port:-3000}/config  ·  PIN: $settings_pin" "  Settings: http://${ip:-SERVER-IP}:${port:-3000}/config  ·  PIN: $settings_pin"
else
  m "  Configurações: http://${ip:-IP-DO-SERVIDOR}:${port:-3000}/config (PIN criado no assistente)" "  Settings: http://${ip:-SERVER-IP}:${port:-3000}/config (PIN set in the wizard)"
fi
m "  Aponte os mineradores para ${ip:-IP-DO-SERVIDOR}: 3333 public-pool · 3334 ckpool solo · 3335 nerdminers · 3340 bitronics · 3341 bitronics ASIC · 3337 OCEAN · 3338 atlaspool · 3339 ckpool EU" \
  "  Point your miners to ${ip:-SERVER-IP}: 3333 public-pool · 3334 ckpool solo · 3335 nerdminers · 3340 bitronics · 3341 bitronics ASIC · 3337 OCEAN · 3338 atlaspool · 3339 ckpool EU"
