// Rede pela tela de configurações (aba 🌐 Rede): Wi-Fi pelo NetworkManager (nmcli) e acesso de fora
// de casa pelo Tailscale. Tudo atrás do PIN; os comandos recebem os argumentos em lista (sem shell).
// Só aparece onde existe: o nmcli com um adaptador Wi-Fi, o tailscale instalado (imagens prontas).

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const find = (env, list) => (env ? [env] : list).find((p) => fs.existsSync(p)) || null;
const BIN = {
  nmcli: () => find(process.env.NMCLI_PATH, ['/usr/bin/nmcli', '/bin/nmcli']),
  tailscale: () => find(process.env.TAILSCALE_PATH, ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale']),
  systemctl: () => process.env.NET_SYSTEMCTL || 'systemctl',
};

function run(bin, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, code: 127, out: '' });
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '') }));
  });
}

// "nmcli -t" separa os campos com ":" e escapa ":" e "\" dentro deles
function splitTerse(line) {
  const out = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- Wi-Fi
async function wifiStatus() {
  const nm = BIN.nmcli();
  if (!nm) return { available: false };
  const r = await run(nm, ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
  if (!r.ok) return { available: false };
  const devs = r.out.trim().split('\n').filter(Boolean).map(splitTerse).map(([device, type, state, connection]) => ({ device, type, state, connection }));
  const wifi = devs.filter((d) => d.type === 'wifi');
  if (!wifi.length) return { available: false, reason: 'noadapter' };
  const d = wifi[0];
  const connected = /^connected/.test(d.state) && d.connection && d.connection !== '--';
  const ip = connected ? ((os.networkInterfaces()[d.device] || []).find((a) => a.family === 'IPv4') || {}).address || null : null;
  const wired = devs.some((x) => x.type === 'ethernet' && /^connected/.test(x.state));
  return { available: true, device: d.device, connected: !!connected, ssid: connected ? d.connection : null, ip, wired };
}

async function wifiScan() {
  const r = await run(BIN.nmcli(), ['-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', '--rescan', 'yes'], 30000);
  if (!r.ok) return { ok: false, error: 'wifiscan' };
  const seen = new Map();
  for (const line of r.out.trim().split('\n').filter(Boolean)) {
    const [ssid, signal, security, inUse] = splitTerse(line);
    if (!ssid) continue;   // redes ocultas
    const n = { ssid, signal: Number(signal) || 0, secure: !!security && security !== '--', inUse: inUse === '*' };
    const prev = seen.get(ssid);
    if (!prev || n.signal > prev.signal) seen.set(ssid, n);
  }
  return { ok: true, networks: [...seen.values()].sort((a, b) => b.inUse - a.inUse || b.signal - a.signal).slice(0, 30) };
}

const SSID_OK = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 32 && !/[\x00-\x1f]/.test(s);
async function wifiConnect(ssid, password) {
  if (!SSID_OK(ssid)) return { ok: false, error: 'ssid' };
  const pass = String(password || '');
  if (pass && (pass.length < 8 || pass.length > 63)) return { ok: false, error: 'wifipass' };
  const args = ['device', 'wifi', 'connect', ssid];
  if (pass) args.push('password', pass);
  const r = await run(BIN.nmcli(), args, 45000);
  if (r.ok) return { ok: true };
  const msg = (r.err + r.out).toLowerCase();
  return { ok: false, error: /secrets|password|802-1x|psk/.test(msg) ? 'wifiauth' : /no network|not found/.test(msg) ? 'wifinotfound' : 'wificonnect' };
}

async function wifiForget() {
  const st = await wifiStatus();
  if (!st.available || !st.ssid) return { ok: true };
  const r = await run(BIN.nmcli(), ['connection', 'delete', 'id', st.ssid]);
  return r.ok ? { ok: true } : { ok: false, error: 'wificonnect' };
}

// ---------------------------------------------------------------- Tailscale
async function tailscaleStatus({ withUrl = false } = {}) {
  const ts = BIN.tailscale();
  if (!ts) return { available: false };
  const active = await run(BIN.systemctl(), ['is-active', '--quiet', 'tailscaled']);
  if (!active.ok) return { available: true, state: 'off' };
  const r = await run(ts, ['status', '--json'], 10000);
  let j = null;
  try { j = JSON.parse(r.out); } catch (_) { /* sem status */ }
  if (!j) return { available: true, state: 'off' };
  const self = j.Self || {};
  const state = j.BackendState === 'Running' ? 'connected' : j.BackendState === 'NeedsLogin' || j.BackendState === 'NeedsMachineAuth' ? 'login' : j.BackendState === 'Starting' ? 'starting' : 'off';
  const out = { available: true, state, name: (self.DNSName || '').replace(/\.$/, '') || null, ips: self.TailscaleIPs || [] };
  // o link de login só sai com o PIN: quem abrir primeiro põe a placa na própria rede Tailscale
  if (withUrl && state === 'login' && /^https:\/\/login\.tailscale\.com\//.test(j.AuthURL || '')) out.authUrl = j.AuthURL;
  return out;
}

async function tailscaleConnect(hostname = os.hostname()) {
  const ts = BIN.tailscale();
  if (!ts) return { ok: false, error: 'notailscale' };
  await run(BIN.systemctl(), ['enable', '--now', 'tailscaled'], 30000);
  // o "up" espera o login terminar; com --timeout ele volta e o link fica no status
  const host = String(hostname).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 63) || 'homeminer';
  await run(ts, ['up', '--hostname=' + host, '--timeout=15s'], 30000);
  return { ok: true, status: await tailscaleStatus({ withUrl: true }) };
}

async function tailscaleDisconnect() {
  const ts = BIN.tailscale();
  if (!ts) return { ok: false, error: 'notailscale' };
  await run(ts, ['logout'], 20000);
  await run(BIN.systemctl(), ['disable', '--now', 'tailscaled'], 30000);
  return { ok: true };
}

module.exports = { splitTerse, wifiStatus, wifiScan, wifiConnect, wifiForget, tailscaleStatus, tailscaleConnect, tailscaleDisconnect };
