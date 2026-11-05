#!/bin/bash
# Monta a imagem pronta para gravar no cartão SD: pega a imagem oficial mínima da placa,
# instala o HomeMinerProxy dentro dela (chroot com qemu) e deixa tudo pronto para o primeiro boot.
# Builds the ready-to-flash SD card image: takes the board's official minimal image, installs
# HomeMinerProxy inside it (chroot through qemu) and leaves everything ready for the first boot.
#
# Uso / usage (como root, num Linux x86 com qemu-user-static, parted, cloud-guest-utils, xz):
#   sudo image/build.sh rpi            homeminer-rpi.img.xz
#   sudo image/build.sh orangepizero3  homeminer-orangepizero3.img.xz
#   sudo image/build.sh odroidc2       homeminer-odroidc2.img.xz
#
# No primeiro boot a placa se chama "homeminer": abra http://homeminer.local:3000 e o assistente
# de primeira configuração pergunta idioma, endereço de bitcoin, PIN e preço da energia.
set -euo pipefail

BOARD=${1:?board: rpi | orangepizero3 | odroidc2}
OUT=$(realpath -m "${2:?output .img.xz}")
HERE=$(cd "$(dirname "$0")/.." && pwd)
GROW_MB=${GROW_MB:-1536}
REPO_URL=${REPO_URL:-https://github.com/Modanez/HomeMinerProxy.git}

case "$BOARD" in
  rpi)                    URL=https://downloads.raspberrypi.com/raspios_lite_arm64_latest ;;
  orangepizero3|odroidc2) URL=https://dl.armbian.com/$BOARD/Trixie_current_minimal ;;
  *) echo "placa desconhecida / unknown board: $BOARD" >&2; exit 1 ;;
esac
[ -n "${BASE_URL:-}" ] && URL=$BASE_URL

WORK=$(mktemp -d /tmp/homeminer-img.XXXXXX)
ROOT=$WORK/root
LOOP=""
cleanup() {
  set +e
  for m in boot/firmware dev/pts dev proc sys run; do mountpoint -q "$ROOT/$m" && umount -l "$ROOT/$m"; done
  mountpoint -q "$ROOT" && umount -l "$ROOT"
  [ -n "$LOOP" ] && losetup -d "$LOOP"
  rm -rf "$WORK"
}
trap cleanup EXIT
step() { echo; echo "==> $*"; }

step "Baixando a imagem base / downloading base image ($BOARD)"
EFFECTIVE=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$URL")
echo "    $EFFECTIVE"
curl -fL --retry 3 --retry-delay 5 -o "$WORK/base.img.xz" "$EFFECTIVE"

step "Conferindo o SHA-256 / verifying SHA-256"
if [ "$BOARD" = rpi ]; then SHA_URL="$EFFECTIVE.sha256"; else SHA_URL="$URL.sha"; fi
if curl -fsSL -o "$WORK/base.sha" "$SHA_URL"; then
  want=$(grep -oE '\b[0-9a-f]{64}\b' "$WORK/base.sha" | head -1)
  got=$(sha256sum "$WORK/base.img.xz" | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "SHA-256 não confere / mismatch: $got != $want" >&2; exit 1; }
  echo "    ok $got"
else
  echo "    sem arquivo de SHA / no SHA file: $SHA_URL" >&2
  [ -n "${ALLOW_NO_SHA:-}" ] || exit 1
fi

step "Descompactando e abrindo espaço / decompressing and growing by ${GROW_MB} MB"
xz -dc "$WORK/base.img.xz" > "$WORK/base.img"
rm -f "$WORK/base.img.xz"
# Odroid-C2 (Amlogic) e outras placas guardam o começo do carregador de boot nos primeiros 442 bytes
# do cartão, no mesmo setor da tabela de partições. O growpart reescreve esse setor: guarda e devolve.
dd if="$WORK/base.img" of="$WORK/bootcode.bin" bs=1 count=442 status=none
truncate -s "+${GROW_MB}M" "$WORK/base.img"
LOOP=$(losetup -fP --show "$WORK/base.img")
PARTN=$(parted -sm "$LOOP" print | tail -1 | cut -d: -f1)
growpart "$LOOP" "$PARTN" || true
if ! cmp -s "$WORK/bootcode.bin" <(dd if="$LOOP" bs=1 count=442 status=none); then
  echo "    o growpart mexeu no código de boot do setor 0; restaurando / growpart touched the boot code; restoring"
  dd if="$WORK/bootcode.bin" of="$LOOP" bs=1 count=442 conv=notrunc status=none
fi
partprobe "$LOOP" 2>/dev/null || true
sleep 1
e2fsck -fy "${LOOP}p${PARTN}" || [ $? -le 2 ]
resize2fs "${LOOP}p${PARTN}"

step "Montando / mounting"
mkdir -p "$ROOT"
mount "${LOOP}p${PARTN}" "$ROOT"
if [ "$BOARD" = rpi ]; then mkdir -p "$ROOT/boot/firmware"; mount "${LOOP}p1" "$ROOT/boot/firmware"; fi
for m in dev dev/pts proc sys run; do mkdir -p "$ROOT/$m"; mount --bind "/$m" "$ROOT/$m"; done
# DNS para o apt dentro do chroot (o original volta no fim)
if [ -e "$ROOT/etc/resolv.conf" ] || [ -L "$ROOT/etc/resolv.conf" ]; then mv "$ROOT/etc/resolv.conf" "$WORK/resolv.conf.orig"; fi
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
# nenhum serviço sobe dentro do chroot
printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"; chmod +x "$ROOT/usr/sbin/policy-rc.d"

step "Copiando o HomeMinerProxy / copying HomeMinerProxy"
rm -rf "$ROOT/opt/HomeMinerProxy"
cp -a "$HERE" "$ROOT/opt/HomeMinerProxy"
rm -rf "$ROOT/opt/HomeMinerProxy/node_modules" "$ROOT/opt/HomeMinerProxy/tests/__pycache__" "$ROOT/opt/HomeMinerProxy/src/__pycache__"
chown -R 0:0 "$ROOT/opt/HomeMinerProxy"   # o checkout do CI é de outro usuário; na placa tudo roda como root
git config --global --add safe.directory "$ROOT/opt/HomeMinerProxy"
# nenhuma credencial do CI pode ir para a imagem (o actions/checkout grava um token no .git/config)
git -C "$ROOT/opt/HomeMinerProxy" config --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git -C "$ROOT/opt/HomeMinerProxy" config --remove-section credential 2>/dev/null || true
# repositório pronto para o botão "Atualizar" (git pull na main)
git -C "$ROOT/opt/HomeMinerProxy" remote set-url origin "$REPO_URL" 2>/dev/null || git -C "$ROOT/opt/HomeMinerProxy" remote add origin "$REPO_URL"
git -C "$ROOT/opt/HomeMinerProxy" checkout -q -B main
git -C "$ROOT/opt/HomeMinerProxy" branch -q --set-upstream-to=origin/main main 2>/dev/null || true

step "Instalando dentro da imagem (qemu, demora) / installing inside the image (qemu, slow)"
chroot "$ROOT" /usr/bin/env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 /bin/bash -euo pipefail -c '
  apt-get update
  apt-get install -y --no-install-recommends nodejs python3 python3-pil fonts-dejavu-core git avahi-daemon ca-certificates curl
  git config --system --add safe.directory /opt/HomeMinerProxy
  cd /opt/HomeMinerProxy
  HOMEMINER_UNATTENDED=1 HOMEMINER_IMAGE=1 bash install.sh </dev/null
  apt-get clean
  rm -rf /var/lib/apt/lists/*
'

step "Ajustes do aparelho / appliance tweaks"
echo homeminer > "$ROOT/etc/hostname"
if grep -q '^127\.0\.1\.1' "$ROOT/etc/hosts"; then sed -i 's/^127\.0\.1\.1.*/127.0.1.1\thomeminer/' "$ROOT/etc/hosts"; else printf '127.0.1.1\thomeminer\n' >> "$ROOT/etc/hosts"; fi
chroot "$ROOT" systemctl enable avahi-daemon >/dev/null 2>&1 || true
if [ "$BOARD" = odroidc2 ] && [ -f "$ROOT/boot/armbianEnv.txt" ]; then
  # Odroid-C2 com kernel novo: sem fw_devlink=permissive o vídeo (DRM) não inicializa e a tela fica preta
  if grep -q '^extraargs=' "$ROOT/boot/armbianEnv.txt"; then
    grep -q 'fw_devlink=permissive' "$ROOT/boot/armbianEnv.txt" || sed -i 's/^extraargs=\(.*\)/extraargs=\1 fw_devlink=permissive/' "$ROOT/boot/armbianEnv.txt"
  else
    echo 'extraargs=fw_devlink=permissive' >> "$ROOT/boot/armbianEnv.txt"
  fi
  grep '^extraargs=' "$ROOT/boot/armbianEnv.txt" | sed 's/^/    /'
fi
if [ "$BOARD" != rpi ]; then
  # Armbian vem com SSH ligado e root/1234 até o primeiro login: num aparelho na rede de casa, desliga.
  # Para ligar: monitor e teclado, login root (senha 1234, ele pede para trocar) e "systemctl enable --now ssh".
  chroot "$ROOT" systemctl disable ssh >/dev/null 2>&1 || true
fi
echo "HomeMinerProxy image for $BOARD, built $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo '?')" > "$ROOT/etc/homeminer-image"

step "Conferindo a imagem / checking the image"
fail() { echo "FALHOU / FAILED: $*" >&2; exit 1; }
for f in painel.js proxy.js setup.js update.js settings.js version.json; do [ -f "$ROOT/opt/mineracao/$f" ] || fail "/opt/mineracao/$f"; done
for u in mineracao-proxy mineracao-painel mineracao-cubo; do
  [ -f "$ROOT/etc/systemd/system/$u.service" ] || fail "$u.service"
  [ -L "$ROOT/etc/systemd/system/multi-user.target.wants/$u.service" ] || fail "$u não ativado / not enabled"
done
[ -L "$ROOT/etc/systemd/system/multi-user.target.wants/avahi-daemon.service" ] || ls "$ROOT"/etc/systemd/system/*/avahi-daemon.service >/dev/null 2>&1 || fail "avahi-daemon"
grep -q '^BTC_ADDRESS=$' "$ROOT/etc/mineracao.env" || fail "BTC_ADDRESS deveria estar vazio / should be empty"
! grep -q '^SETTINGS_PIN=.' "$ROOT/etc/mineracao.env" || fail "a imagem não pode ter PIN / image must not ship a PIN"
[ ! -e "$ROOT/opt/mineracao/pin.json" ] && [ ! -e "$ROOT/opt/mineracao/settings.json" ] || fail "sobra de configuração / leftover config"
chroot "$ROOT" node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 16 ? 0 : 1)" || fail "node >= 16"
chroot "$ROOT" python3 -c "import PIL" || fail "python3-pil"
[ "$(cat "$ROOT/etc/hostname")" = homeminer ] || fail hostname
! grep -qiE 'extraheader|authorization|token|password' "$ROOT/opt/HomeMinerProxy/.git/config" || fail "credencial no .git/config / credential in .git/config"
git -C "$ROOT/opt/HomeMinerProxy" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || echo "    aviso: sem upstream (o botão Atualizar usa a origin/main depois do primeiro fetch)"
echo "    tudo certo / all good"

step "Fechando / closing"
rm -f "$ROOT/usr/sbin/policy-rc.d"
rm -f "$ROOT/etc/resolv.conf"
[ -e "$WORK/resolv.conf.orig" ] || [ -L "$WORK/resolv.conf.orig" ] && mv "$WORK/resolv.conf.orig" "$ROOT/etc/resolv.conf"
rm -rf "$ROOT/root/.bash_history" "$ROOT/tmp/"*
sync
for m in run sys proc dev/pts dev; do umount "$ROOT/$m"; done
[ "$BOARD" = rpi ] && umount "$ROOT/boot/firmware"
umount "$ROOT"
e2fsck -fy "${LOOP}p${PARTN}" >/dev/null || [ $? -le 2 ]
cmp -s "$WORK/bootcode.bin" <(dd if="$LOOP" bs=1 count=442 status=none) || fail "código de boot do setor 0 mudou / sector 0 boot code changed"
echo "    código de boot do setor 0 intacto / sector 0 boot code intact"
losetup -d "$LOOP"; LOOP=""

step "Compactando / compressing → $OUT"
xz -T0 -6 -c "$WORK/base.img" > "$OUT"
(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
ls -lh "$OUT"
