// Tela ligada na própria placa (opção KIOSK): abre o painel em tela cheia no boot, sem área de trabalho.
// Usa o cage (um "quiosque" Wayland mínimo) com o Chromium apontado para http://127.0.0.1:PORTA/?kiosk.
// O install.sh cria o serviço mineracao-kiosk desligado (onde há systemd). Ao ligar a opção, o painel
// instala o cage e o Chromium pelo apt na primeira vez (alguns minutos, em segundo plano) e liga o serviço;
// ao desligar, desliga o serviço e a placa volta a ser só servidor. Nada disso existe no Docker.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const UNIT = 'mineracao-kiosk';
const UNIT_FILE = () => process.env.KIOSK_UNIT_FILE || `/etc/systemd/system/${UNIT}.service`;
const PACKAGES = ['cage', 'chromium', 'fonts-noto-color-emoji'];
const CAGE = ['/usr/bin/cage', '/usr/local/bin/cage'];
const CHROMIUM = ['/usr/bin/chromium', '/usr/bin/chromium-browser'];
const which = (list) => list.find((b) => fs.existsSync(b)) || null;

// Dá para ligar por aqui? Precisa do serviço criado pelo install.sh (ou seja, systemd) e do apt para instalar.
function available() {
  return fs.existsSync(UNIT_FILE()) && (installed() || fs.existsSync(process.env.KIOSK_APT || '/usr/bin/apt-get'));
}
const installed = () => !!which(CAGE) && !!which(CHROMIUM);

// Tela ligada? O kernel diz em /sys/class/drm/card*-*/status ("connected"). Sem a pasta, não dá para saber.
function screen(dir = process.env.KIOSK_DRM_DIR || '/sys/class/drm') {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const outs = names.filter((n) => /^card\d+-/.test(n));
  if (!outs.length) return null;
  return outs.some((n) => { try { return fs.readFileSync(path.join(dir, n, 'status'), 'utf8').trim() === 'connected'; } catch (_) { return false; } });
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, out, errOut) => resolve({ ok: !err, out: String(out || '') + String(errOut || '') }));
  });
}
const systemctl = (args) => run(process.env.KIOSK_SYSTEMCTL || 'systemctl', args);

// Estado da instalação em segundo plano (para a tela de configurações mostrar)
const stateFile = (dataDir) => path.join(dataDir, 'kiosk.json');
function readState(dataDir) { try { return JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8')); } catch (_) { return {}; } }
function writeState(dataDir, s) { try { fs.writeFileSync(stateFile(dataDir), JSON.stringify(s)); } catch (_) { /* segue */ } }

// Instala os pacotes sem travar o painel; quando terminar, liga o serviço. Um log fica em DATA_DIR/kiosk-install.log.
function installThenStart(dataDir) {
  const st = readState(dataDir);
  if (st.installing && Date.now() - st.installing < 30 * 60e3) return Promise.resolve({ installing: true });
  writeState(dataDir, { installing: Date.now(), error: null });
  const log = fs.openSync(path.join(dataDir, 'kiosk-install.log'), 'w');
  const apt = process.env.KIOSK_APT || 'apt-get';
  const sh = `${apt} update -q && DEBIAN_FRONTEND=noninteractive ${apt} install -y -q --no-install-recommends ${PACKAGES.join(' ')}`;
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', sh], { stdio: ['ignore', log, log] });
    child.on('error', (e) => { writeState(dataDir, { installing: null, error: e.message }); resolve({ ok: false }); });
    child.on('close', async (code) => {
      fs.closeSync(log);
      if (code !== 0 || !installed()) { writeState(dataDir, { installing: null, error: 'apt ' + code }); return resolve({ ok: false }); }
      writeState(dataDir, { installing: null, error: null, installedAt: Date.now() });
      await systemctl(['enable', '--now', UNIT]);
      resolve({ ok: true });
    });
  });
}

// Aplica a opção ao subir o painel
async function sync({ enabled, dataDir }) {
  if (!fs.existsSync(UNIT_FILE())) return { ok: false, reason: 'nounit' };
  if (enabled) {
    if (!installed()) { installThenStart(dataDir); return { ok: true, installing: true }; }
    await systemctl(['enable', UNIT]);
    const active = await systemctl(['is-active', '--quiet', UNIT]);
    if (!active.ok) await systemctl(['start', UNIT]);
    return { ok: true };
  }
  const active = await systemctl(['is-active', '--quiet', UNIT]);
  const en = await systemctl(['is-enabled', '--quiet', UNIT]);
  if (active.ok || en.ok) await systemctl(['disable', '--now', UNIT]);
  return { ok: true, off: true };
}

function status(dataDir) {
  const st = readState(dataDir);
  return { available: available(), installed: installed(), screen: screen(), installing: !!(st.installing && Date.now() - st.installing < 30 * 60e3), error: st.error || null };
}

module.exports = { UNIT, PACKAGES, available, installed, screen, sync, status };
