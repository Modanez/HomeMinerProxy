// Rede de configuração sem cabo (hotspot). Quando a placa liga sem rede (sem rota padrão por HOTSPOT_WAIT_S,
// padrão 90 s) e existe um Wi-Fi que aceita o modo ponto de acesso (AP), ela cria a rede aberta "HomeMiner-Setup".
// O celular conecta, o aviso de "entrar na rede" abre o painel (a porta 80 e o DNS apontam para cá) e o
// assistente pergunta o Wi-Fi de casa. Ao escolher, o hotspot sai do ar e a placa entra na rede de casa; se não
// conseguir, o hotspot volta com o motivo. Com um só rádio não dá para ficar nas duas redes ao mesmo tempo.
//
// Roda como serviço próprio (mineracao-hotspot); o painel usa status() e connectFromAp(). HOTSPOT=0 desliga.

const fs = require('fs');
const path = require('path');
const http = require('http');
const netctl = require('./netctl');
const store = require('./store');

const CON = 'homeminer-setup';
const AP_IP = '10.42.0.1';
const SSID = () => (process.env.HOTSPOT_SSID || 'HomeMiner-Setup').slice(0, 32);
const nmcli = () => netctl.bin.nmcli();
const stateFile = () => path.join(process.env.DATA_DIR || __dirname, 'hotspot.json');
const readState = () => store.readJson(stateFile(), {});
const writeState = (patch) => { const s = { ...readState(), ...patch }; try { store.writeJson(stateFile(), s, { backup: false }); } catch (_) { /* segue */ } return s; };

// Rota padrão = há caminho para a internet (cabo com DHCP ou Wi-Fi conectado). O hotspot não cria rota padrão.
function hasDefaultRoute(file = process.env.HOTSPOT_ROUTE_FILE || '/proc/net/route') {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(1).some((l) => { const c = l.trim().split(/\s+/); return c.length > 2 && c[1] === '00000000' && c[2] !== '00000000'; });
  } catch (_) { return false; }
}

// Primeiro adaptador Wi-Fi que aceita o modo AP (nmcli: WIFI-PROPERTIES.AP = yes)
async function apDevice() {
  const r = await netctl.run(nmcli(), ['-t', '-f', 'DEVICE,TYPE', 'device']);
  if (!r.ok) return null;
  for (const [dev, type] of r.out.trim().split('\n').filter(Boolean).map(netctl.splitTerse)) {
    if (type !== 'wifi') continue;
    const p = await netctl.run(nmcli(), ['-t', '-f', 'WIFI-PROPERTIES.AP', 'device', 'show', dev]);
    if (p.ok && /:yes\s*$/m.test(p.out)) return dev;
  }
  return null;
}

async function active() {
  const r = await netctl.run(nmcli(), ['-t', '-f', 'NAME', 'connection', 'show', '--active']);
  return r.ok && r.out.split('\n').map((l) => netctl.splitTerse(l)[0]).includes(CON);
}

// Liga o hotspot. Antes procura as redes por perto: com o rádio no modo AP a busca quase sempre falha,
// então a lista fica guardada para o assistente mostrar.
async function start(dev) {
  const scan = await netctl.wifiScan();
  if (scan.ok) writeState({ networks: scan.networks.filter((n) => n.ssid !== SSID()).map(({ ssid, signal, secure }) => ({ ssid, signal, secure })), scannedAt: Date.now() });
  const nm = nmcli();
  await netctl.run(nm, ['connection', 'delete', 'id', CON]);
  const add = await netctl.run(nm, ['connection', 'add', 'type', 'wifi', 'ifname', dev, 'con-name', CON, 'autoconnect', 'no', 'ssid', SSID(),
    '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg', 'ipv4.method', 'shared', 'ipv4.addresses', AP_IP + '/24', 'ipv6.method', 'disabled']);
  if (!add.ok) return { ok: false, error: 'hotspotadd', detail: (add.err || add.out).trim().slice(0, 200) };
  const up = await netctl.run(nm, ['connection', 'up', 'id', CON], 45000);
  if (!up.ok) return { ok: false, error: 'hotspotup', detail: (up.err || up.out).trim().slice(0, 200) };
  writeState({ startedAt: Date.now(), device: dev });
  return { ok: true };
}

async function stop() {
  const r = await netctl.run(nmcli(), ['connection', 'down', 'id', CON], 20000);
  return { ok: r.ok };
}

// Estado para o assistente e para a aba Rede
async function status() {
  if (!nmcli()) return { available: false, active: false };
  const s = readState();
  const on = await active();
  return { available: true, active: on, ssid: SSID(), ip: AP_IP, networks: on ? s.networks || [] : [], lastError: s.lastError || null, lastSsid: s.lastSsid || null };
}

// Sai do hotspot e entra no Wi-Fi escolhido. Chamar DEPOIS de responder o celular (ele vai perder a conexão).
// Se falhar, o hotspot volta com o motivo (lastError) para o assistente mostrar.
async function connectFromAp(ssid, password, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  writeState({ connecting: Date.now(), lastError: null, lastSsid: ssid });
  const dev = readState().device || (await apDevice());
  await stop();
  await wait(2000);
  const r = await netctl.wifiConnect(ssid, password);
  if (r.ok) { writeState({ connecting: null, lastError: null }); return r; }
  writeState({ lastError: r.error || 'wificonnect' });
  if (dev) await start(dev);
  writeState({ connecting: null });
  return r;
}

const SSID_OK = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 32 && !/[\x00-\x1f]/.test(s);
function checkWifiForm(ssid, password) {
  if (!SSID_OK(ssid)) return 'ssid';
  const p = String(password || '');
  if (p && (p.length < 8 || p.length > 63)) return 'wifipass';
  return null;
}

// Quantos aparelhos estão conectados no hotspot (iw opcional; sem ele, assume que tem alguém)
async function stations(dev) {
  const iw = ['/usr/sbin/iw', '/sbin/iw', '/usr/bin/iw'].find((p) => fs.existsSync(p));
  if (!iw || !dev) return 1;
  const r = await netctl.run(iw, ['dev', dev, 'station', 'dump']);
  return r.ok ? (r.out.match(/^Station /gm) || []).length : 1;
}

// ---------------------------------------------------------------- serviço
// A cada 15 s: sem rota padrão por HOTSPOT_WAIT_S → liga o hotspot. Com o hotspot no ar há mais de
// HOTSPOT_RETRY_MIN minutos e ninguém conectado, tenta de novo a rede salva (o roteador pode ter voltado).
function daemon({ log = console.log } = {}) {
  if (process.env.HOTSPOT === '0') { log('hotspot desligado (HOTSPOT=0)'); return setInterval(() => {}, 3600e3); }
  const waitMs = Number(process.env.HOTSPOT_WAIT_S ?? 90) * 1000;
  const retryMs = Number(process.env.HOTSPOT_RETRY_MIN ?? 10) * 60e3;
  const port = Number(process.env.PORT || 3000);
  let offlineSince = null, noApLogged = false, redirect = null, busy = false;
  // porta 80 do hotspot: o teste de "internet" do celular cai aqui e abre o painel
  const openRedirect = () => {
    if (redirect) return;
    redirect = http.createServer((req, res) => { res.writeHead(302, { Location: `http://${AP_IP}:${port}/`, 'Cache-Control': 'no-store' }); res.end(); });
    redirect.on('error', () => { redirect = null; });
    redirect.listen(80, AP_IP);
  };
  const closeRedirect = () => { if (redirect) { redirect.close(); redirect = null; } };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const st = readState();
      if (st.connecting && Date.now() - st.connecting < 120e3) return;   // o painel está trocando de rede
      if (await active()) {
        openRedirect();
        if (hasDefaultRoute()) { log('rede voltou (cabo?): desligando o hotspot'); await stop(); closeRedirect(); return; }
        if (Date.now() - (st.startedAt || 0) > retryMs && (await stations(st.device)) === 0) {
          log('tentando de novo a rede salva');
          writeState({ connecting: Date.now() });
          await stop(); closeRedirect();
          await new Promise((r) => setTimeout(r, 45e3));   // o NetworkManager reconecta sozinho na rede salva
          if (!hasDefaultRoute()) { const r = await start(st.device || (await apDevice())); log(r.ok ? 'sem rede: hotspot de volta' : 'hotspot falhou: ' + r.error); }
          writeState({ connecting: null });
        }
        return;
      }
      closeRedirect();
      if (hasDefaultRoute()) { offlineSince = null; return; }
      if (offlineSince == null) offlineSince = Date.now();
      if (Date.now() - offlineSince < waitMs) return;
      const dev = await apDevice();
      if (!dev) { if (!noApLogged) log('sem rede, mas nenhum Wi-Fi aceita o modo ponto de acesso (AP): use o cabo'); noApLogged = true; return; }
      const r = await start(dev);
      log(r.ok ? `sem rede: hotspot "${SSID()}" no ar em ${dev} (abra http://${AP_IP}:${port})` : 'hotspot falhou: ' + r.error + ' ' + (r.detail || ''));
    } catch (e) { log('hotspot: ' + e.message); } finally { busy = false; }
  };
  tick();
  return setInterval(tick, 15e3);
}

module.exports = { CON, AP_IP, SSID, hasDefaultRoute, apDevice, active, start, stop, status, connectFromAp, checkWifiForm, stations, daemon, readState, writeState };

if (require.main === module) {
  if (!nmcli()) { console.log('hotspot: sem NetworkManager (nmcli); nada a fazer'); setInterval(() => {}, 3600e3); } else daemon();
}
