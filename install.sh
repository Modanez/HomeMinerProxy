#!/bin/bash
# Instala (ou atualiza) a fazenda de mineração: proxy Stratum, painel web e, opcionalmente, o placar do cubo.
# Uso, como root, na pasta do repositório:
#   sudo bash install.sh                          # pergunta o endereço na primeira vez
#   sudo BTC_ADDRESS=bc1q... bash install.sh      # sem perguntas
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/mineracao}
ENV_FILE=${ENV_FILE:-/etc/mineracao.env}
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "Rode como root (sudo bash install.sh)"; exit 1; }
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || { echo "Node.js não encontrado. Instale o Node 16 ou mais novo (ex.: apt install nodejs)."; exit 1; }
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 16 ] || { echo "Node $NODE_MAJOR é antigo demais; precisa do 16 ou mais novo."; exit 1; }

echo "==> Copiando os arquivos para $APP_DIR"
mkdir -p "$APP_DIR"
cp "$HERE"/src/painel.js "$HERE"/src/proxy.js "$HERE"/src/stratum.js "$HERE"/src/cubo.py "$APP_DIR/"

echo "==> Configuração em $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cp "$HERE/config/mineracao.env.example" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "   criada a partir de config/mineracao.env.example"
fi
current=$(grep -E '^BTC_ADDRESS=' "$ENV_FILE" | cut -d= -f2- || true)
if [ -z "$current" ]; then
  addr=${BTC_ADDRESS:-}
  if [ -z "$addr" ] && [ -t 0 ]; then read -r -p "   Endereço de bitcoin dos mineradores (bc1...): " addr; fi
  [ -n "$addr" ] || { echo "   Defina BTC_ADDRESS em $ENV_FILE e rode de novo."; exit 1; }
  case "$addr" in *[!A-Za-z0-9]*) echo "   Endereço com caracteres inválidos: $addr"; exit 1;; esac
  sed -i "s|^BTC_ADDRESS=.*|BTC_ADDRESS=$addr|" "$ENV_FILE"
fi

unit() {   # unit <nome> <descrição> <comando> [After=...]
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

echo "==> Serviços"
unit mineracao-proxy  "Proxy Stratum da fazenda de mineração" "$NODE_BIN $APP_DIR/proxy.js"
unit mineracao-painel "Painel da fazenda de mineração"       "$NODE_BIN $APP_DIR/painel.js" mineracao-proxy.service
services="mineracao-proxy mineracao-painel"

if grep -qE '^CUBE_IP=.+' "$ENV_FILE"; then
  echo "==> Cubo GeekMagic configurado: instalando dependências do placar"
  python3 -c "import PIL" 2>/dev/null || apt-get install -y python3-pil
  [ -f /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf ] || apt-get install -y fonts-dejavu-core
  unit mineracao-cubo "Placar da fazenda no cubo GeekMagic" "/usr/bin/python3 $APP_DIR/cubo.py" mineracao-painel.service
  services="$services mineracao-cubo"
fi

systemctl daemon-reload
systemctl enable $services >/dev/null
systemctl restart $services
sleep 3
systemctl --no-pager --lines=0 status $services || true

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Pronto."
echo "  Painel:  http://${ip:-IP-DO-SERVIDOR}:$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || echo 3000)"
echo "  Aponte os mineradores para ${ip:-IP-DO-SERVIDOR}: 3333 public-pool · 3334 ckpool solo · 3335 nerdminers · 3337 OCEAN"
