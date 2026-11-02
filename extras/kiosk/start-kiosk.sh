#!/bin/bash
# Abre o painel em tela cheia numa tela ligada ao servidor (modo kiosk, telas alternando).
# Exemplo de uso no /etc/rc.local (antes do "exit 0"):
#   su - SEU_USUARIO -c "startx /usr/local/bin/start-kiosk.sh -- -nocursor" &
URL=${URL:-http://localhost:3000/?kiosk}
xset s off; xset s noblank; xset -dpms          # a tela não apaga sozinha
rm -rf ~/.config/chromium/Singleton*             # trava deixada por um desligamento brusco
until curl -s -o /dev/null "$URL"; do sleep 2; done
while true; do                                  # se o Chromium fechar, abre de novo
  chromium --kiosk --noerrdialogs --disable-infobars --incognito --check-for-update-interval=31536000 "$URL"
  sleep 3
done
