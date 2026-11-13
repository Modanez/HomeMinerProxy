#!/bin/sh
# Tela ligada na placa (opção KIOSK, serviço mineracao-kiosk): o painel em tela cheia, sem área de trabalho.
# KIOSK_FLAGS (no .env) acrescenta opções ao Chromium, ex.: KIOSK_FLAGS=--disable-gpu se a tela piscar ou ficar preta.
# Espera o painel responder, depois abre o Chromium dentro do cage (quiosque Wayland mínimo).
PORT=${PORT:-3000}
URL="http://127.0.0.1:${PORT}/?kiosk"
i=0
while [ $i -lt 90 ]; do
  if command -v node >/dev/null && node -e "require('http').get('http://127.0.0.1:${PORT}/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then break; fi
  i=$((i + 1)); sleep 2
done
CHROME=$(command -v chromium || command -v chromium-browser)
PROFILE=${KIOSK_PROFILE:-/var/lib/mineracao-kiosk}
mkdir -p "$PROFILE"
# perfil limpo a cada boot evita o aviso "o Chromium não foi fechado corretamente"
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PROFILE/Default/Preferences" 2>/dev/null || true
exec cage -s -- "$CHROME" --no-sandbox --kiosk --noerrdialogs --disable-infobars --no-first-run \
  --password-store=basic --disable-features=Translate,MediaRouter --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required --disable-pinch --overscroll-history-navigation=0 \
  --ozone-platform=wayland --user-data-dir="$PROFILE" ${KIOSK_FLAGS:-} "$URL"
