// Tomadas Sonoff pela rede de casa (modo DIY / LAN do eWeLink), sem nuvem e sem dependências.
// API: POST http://IP:8081/zeroconf/switch  {"deviceid":"","data":{"switch":"on"}}
//      POST http://IP:8081/zeroconf/info    {"deviceid":"","data":{}}   → data.switch = "on" | "off"
// Mesma interface do cliente Tuya (getStatus, setSwitch, powerCycle por deviceId), para o painel,
// o Telegram e o watchdog tratarem as duas marcas do mesmo jeito.

const http = require('http');

// IPv4 ou nome na rede (ex.: sonoff-quarto.local), com porta opcional
const IPV4 = '(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const NAME = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*';
const HOST_RE = new RegExp(`^(?:${IPV4}|${NAME})(?::\\d{2,5})?$`);
const IP_LIKE = /^[\d.]+(?::\d+)?$/;   // só números e pontos: tem que ser um IPv4 de verdade
const validHost = (h) => { h = String(h || ''); return h.length <= 260 && HOST_RE.test(h) && (!IP_LIKE.test(h) || new RegExp(`^${IPV4}(?::\\d{2,5})?$`).test(h)); };
const SYNTH_PREFIX = 'sonoff_';
const syntheticId = (host) => SYNTH_PREFIX + String(host).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 56);

// Códigos de erro da API DIY
const ERRORS = { 400: 'sonoffformat', 401: 'sonofflan', 404: 'sonoffid', 422: 'sonoffformat' };

function post(host, path, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const [h, p] = String(host).split(':');
    const data = JSON.stringify(body);
    const req = http.request({ host: h, port: Number(p) || 8081, path, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (_) { return resolve({ ok: false, error: 'sonoffformat' }); }
        if (!j || j.error !== 0) return resolve({ ok: false, error: ERRORS[j && j.error] || 'sonoffformat' });
        let d = j.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }   // a v1 manda data como texto
        resolve({ ok: true, data: d || {} });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'sonoffoffline' }));
    req.end(data);
  });
}

// O deviceid real do Sonoff só vai na requisição se a pessoa informou; o id sintético (sonoff_IP) não.
const realId = (plug) => (plug.deviceId && !plug.deviceId.startsWith(SYNTH_PREFIX) ? plug.deviceId : '');

function createClient(opts = {}) {
  const plugs = opts.plugs || [];
  const timeoutMs = opts.timeoutMs || 5000;
  const find = (id) => plugs.find((p) => p.type === 'sonoff' && p.deviceId === id);

  async function getStatus(id) {
    const plug = find(id);
    if (!plug) return { ok: false, error: 'tuyaid' };
    const r = await post(plug.host, '/zeroconf/info', { deviceid: realId(plug), data: {} }, timeoutMs);
    if (!r.ok) return r;
    const sw = r.data.switch != null ? r.data.switch : (Array.isArray(r.data.switches) && r.data.switches[0] ? r.data.switches[0].switch : null);
    return { ok: true, status: { on: sw === 'on' ? true : sw === 'off' ? false : null, watts: null, volts: null, currentMa: null, kwhTotal: null, updatedAt: new Date().toISOString() } };
  }

  async function setSwitch(on, id) {
    const plug = find(id);
    if (!plug) return { ok: false, error: 'tuyaid' };
    const r = await post(plug.host, '/zeroconf/switch', { deviceid: realId(plug), data: { switch: on ? 'on' : 'off' } }, timeoutMs);
    return r.ok ? { ok: true, on: !!on } : r;
  }

  async function powerCycle(offMs = 8000, id) {
    const off = await setSwitch(false, id);
    if (!off.ok) return off;
    await new Promise((res) => setTimeout(res, offMs));
    const on = await setSwitch(true, id);
    return on.ok ? { ok: true, rebootedAt: new Date().toISOString() } : on;
  }

  return { getStatus, setSwitch, powerCycle };
}

// Teste da tela de configurações: só lê o estado
function testSonoff(host, deviceId = '', timeoutMs = 5000) {
  if (!validHost(host)) return Promise.resolve({ ok: false, error: 'host' });
  const plug = { type: 'sonoff', host, deviceId: deviceId || syntheticId(host) };
  return createClient({ plugs: [plug], timeoutMs }).getStatus(plug.deviceId);
}

module.exports = { HOST_RE, validHost, SYNTH_PREFIX, syntheticId, createClient, testSonoff };
