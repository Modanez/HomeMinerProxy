// Bitaxe pela API local do AxeOS (ESP-Miner): leitura da telemetria de cada aparelho.
// A API é HTTP sem senha na porta 80 e só responde a IPs privados, então só o servidor da fazenda fala
// com ela; quem está fora de casa usa o painel (Tailscale). Esta fase só LÊ: GET /api/system/info.
// Unidades do AxeOS: hashrate em GH/s, tensões em mV, corrente em mA, temperaturas em °C, potência em W.
// O firmware 2.15 trocou os campos de pool (stratumURL…) por uma lista "pools": aceitamos os dois.

const http = require('http');
const net = require('net');

const NAME_RE = /^[\w.\-]{1,32}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.local$/i;

// Só endereços da rede de casa: 10/8, 172.16/12, 192.168/16 ou um nome .local
// (nos testes, BITAXE_ALLOW_LOOPBACK=1 libera 127.0.0.1:PORTA para o Bitaxe falso)
function splitHost(h) {
  const m = String(h || '').trim().match(/^(127\.0\.0\.1):(\d{2,5})$/);
  return m && process.env.BITAXE_ALLOW_LOOPBACK === '1' ? { host: m[1], port: Number(m[2]), test: true } : { host: String(h || '').trim(), port: 80 };
}
function isPrivateHost(h) {
  if (splitHost(h).test) return true;
  const s = String(h || '').trim();
  if (HOST_RE.test(s)) return true;
  if (!net.isIPv4(s)) return false;
  const [a, b] = s.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// "bitaxe1=192.168.0.140, bitaxe2=192.168.0.141" → [{ name, host }]; null se algo não vale
function parseList(v) {
  const s = String(v || '').trim();
  if (!s) return [];
  const out = [];
  for (const part of s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([^=\s]+)\s*=\s*(\S+)$/);
    if (!m || !NAME_RE.test(m[1]) || !isPrivateHost(m[2])) return null;
    if (out.some((x) => x.name === m[1] || x.host === m[2])) return null;
    out.push({ name: m[1], host: m[2] });
  }
  return out.length <= 16 ? out : null;
}

function getJson(host, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!isPrivateHost(host)) return resolve({ ok: false, error: 'host' });
    const t = splitHost(host);
    const req = http.get({ host: t.host, port: t.port, path, timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 256e3) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: 'http' + res.statusCode });
        try { resolve({ ok: true, json: JSON.parse(b) }); } catch (_) { resolve({ ok: false, error: 'json' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: /timeout/.test(e.message) ? 'timeout' : 'offline' }));
  });
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// bestDiff vem como número ou como texto com sufixo ("4.29G") conforme a versão
function parseDiff(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v || '').trim().match(/^([\d.]+)\s*([kMGTPE]?)$/i);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15, e: 1e18 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
const ghs = (v) => { const n = num(v); return n != null ? n * 1e9 : null; };

// Pool em uso: campos da 2.14 (stratumURL/stratumUser/isUsingFallbackStratum) ou lista "pools" da 2.15
function poolOf(j) {
  const fallback = !!Number(j.isUsingFallbackStratum);
  if (Array.isArray(j.pools) && j.pools.length) {
    const idx = fallback ? num(j.secondaryPoolIndex) : num(j.primaryPoolIndex);
    const p = j.pools[idx != null && j.pools[idx] ? idx : 0] || {};
    return { url: p.url || p.stratumURL || null, port: num(p.port ?? p.stratumPort), user: p.user || p.stratumUser || null, fallback };
  }
  return fallback
    ? { url: j.fallbackStratumURL || null, port: num(j.fallbackStratumPort), user: j.fallbackStratumUser || null, fallback }
    : { url: j.stratumURL || null, port: num(j.stratumPort), user: j.stratumUser || null, fallback };
}

// /api/system/info → unidades fixas (H/s, °C, W, V, A, MHz, %) e nomes nossos
function normalize(j) {
  if (!j || typeof j !== 'object') return null;
  const pool = poolOf(j);
  const user = String(pool.user || '');
  const hashRate = ghs(j.hashRate);
  const power = num(j.power);
  return {
    model: j.ASICModel || null,
    board: j.boardVersion || null,
    version: j.version || null,
    hostname: j.hostname || null,
    hashRate,
    hashRate1m: ghs(j.hashRate_1m),
    hashRate10m: ghs(j.hashRate_10m),
    hashRate1h: ghs(j.hashRate_1h),
    expected: ghs(j.expectedHashrate),
    tempC: num(j.temp),
    vrTempC: num(j.vrTemp) || null,   // 0 = placa sem sensor no regulador
    watts: power,
    volts: num(j.voltage) != null ? num(j.voltage) / 1000 : null,
    amps: num(j.current) != null ? num(j.current) / 1000 : null,
    jth: power && hashRate ? power / (hashRate / 1e12) : null,
    freqMhz: num(j.frequency),
    coreMv: num(j.coreVoltageActual) ?? num(j.coreVoltage),
    fanPct: num(j.fanspeed),
    fanRpm: num(j.fanrpm),
    autoFan: j.autofanspeed != null ? !!Number(j.autofanspeed) : null,
    tempTarget: num(j.temptarget),
    sharesAccepted: num(j.sharesAccepted),
    sharesRejected: num(j.sharesRejected),
    bestDiff: parseDiff(j.bestDiff),
    bestSessionDiff: parseDiff(j.bestSessionDiff),
    uptimeS: num(j.uptimeSeconds),
    resetReason: j.resetReason || null,
    rssi: num(j.wifiRSSI),
    pool: { url: pool.url, port: pool.port, fallback: pool.fallback },
    // o nome do worker é o que vem depois do ponto no usuário (endereço.bitaxe1)
    // "endereço.worker#grupo" (SOLO Group): o grupo não faz parte do nome do worker
    worker: (() => { const u = user.split('#')[0]; return u.includes('.') ? u.slice(u.lastIndexOf('.') + 1) || null : null; })(),
    responseMs: num(j.responseTime),
    paused: !!j.miningPaused,
    overheat: !!Number(j.overheat_mode),
    powerFault: !!j.power_fault,
    hardwareFault: !!j.hardware_fault,
    blockFound: !!Number(j.blockFound),
  };
}

async function info(host, timeoutMs) {
  const r = await getJson(host, '/api/system/info', timeoutMs);
  if (!r.ok) return r;
  const d = normalize(r.json);
  return d && (d.model || d.hashRate != null) ? { ok: true, data: d, raw: r.json } : { ok: false, error: 'notbitaxe' };
}

// ---------------------------------------------------------------- ações (fase 3)
// Só uma lista fechada de ações e de campos: overclock (frequência, tensão), firmware e Wi-Fi do Bitaxe ficam de fora.
function request(host, method, path, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!isPrivateHost(host)) return resolve({ ok: false, error: 'host' });
    const t = splitHost(host);
    const data = body != null ? JSON.stringify(body) : '';
    const req = http.request({ host: t.host, port: t.port, path, method, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? { ok: true }
        : { ok: false, error: res.statusCode === 404 || res.statusCode === 405 ? 'unsupported' : 'http' + res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // reiniciar derruba a conexão antes da resposta: para "restart" isso também é sucesso
    req.on('error', (e) => resolve(path.endsWith('/restart') && /socket hang up|ECONNRESET/.test(e.message) ? { ok: true } : { ok: false, error: /timeout/.test(e.message) ? 'timeout' : 'offline' }));
    req.end(data);
  });
}
const SIMPLE = { restart: '/api/system/restart', identify: '/api/system/identify', pause: '/api/system/pause', resume: '/api/system/resume' };
const simpleAction = (host, action) => (SIMPLE[action] ? request(host, 'POST', SIMPLE[action]) : Promise.resolve({ ok: false, error: 'action' }));

// Fan: automático com temperatura-alvo (50–70 °C) ou velocidade fixa (20–100%)
function fanPatch(p) {
  if (p && p.auto) {
    const t = Number(p.temptarget);
    return Number.isInteger(t) && t >= 50 && t <= 70 ? { autofanspeed: 1, temptarget: t } : null;
  }
  const f = Number(p && p.fanspeed);
  return Number.isInteger(f) && f >= 20 && f <= 100 ? { autofanspeed: 0, fanspeed: f } : null;
}

// Pool principal e reserva, no formato da versão: campos stratum* (2.14) ou a lista "pools" (2.15)
function poolPatch(raw, main, backup) {
  if (Array.isArray(raw && raw.pools) && raw.pools.length) {
    const pools = raw.pools.map((p) => ({ ...p }));
    const pi = num(raw.primaryPoolIndex) ?? 0, si = num(raw.secondaryPoolIndex) ?? (pi === 0 ? 1 : 0);
    const set = (i, v) => { while (pools.length <= i) pools.push({}); pools[i] = { ...pools[i], url: v.url, port: v.port, user: v.user, password: 'x' }; };
    set(pi, main); if (backup) set(si, backup);
    return { pools };
  }
  const out = { stratumURL: main.url, stratumPort: main.port, stratumUser: main.user, stratumPassword: 'x' };
  if (backup) Object.assign(out, { fallbackStratumURL: backup.url, fallbackStratumPort: backup.port, fallbackStratumUser: backup.user, fallbackStratumPassword: 'x' });
  return out;
}
// Confere na releitura se a pool principal ficou como pedimos (o AxeOS ignora chave errada em silêncio)
function poolMatches(raw, main) {
  if (!raw) return false;
  if (Array.isArray(raw.pools) && raw.pools.length) {
    const p = raw.pools[num(raw.primaryPoolIndex) ?? 0] || {};
    return (p.url || p.stratumURL) === main.url && Number(p.port ?? p.stratumPort) === main.port && (p.user || p.stratumUser) === main.user;
  }
  return raw.stratumURL === main.url && Number(raw.stratumPort) === main.port && raw.stratumUser === main.user;
}
const patch = (host, body) => request(host, 'PATCH', '/api/system', body);

// Procura Bitaxe na sub-rede /24 de cada endereço do servidor (até 32 conexões de cada vez)
async function discover(addresses, { timeoutMs = 1200, concurrency = 32, probe = info } = {}) {
  const hosts = [];
  for (const a of addresses || []) {
    if (!net.isIPv4(a) || !isPrivateHost(a)) continue;
    const base = a.split('.').slice(0, 3).join('.');
    for (let i = 1; i < 255; i++) { const h = `${base}.${i}`; if (h !== a && !hosts.includes(h)) hosts.push(h); }
  }
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      const r = await probe(host, timeoutMs);
      if (r.ok) found.push({ host, model: r.data.model, hostname: r.data.hostname, worker: r.data.worker, hashRate: r.data.hashRate });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((x, y) => net.isIPv4(x.host) && net.isIPv4(y.host) ? Number(x.host.split('.')[3]) - Number(y.host.split('.')[3]) : 0);
}

// ---------------------------------------------------------------- alertas (fase 2)
// Avaliados a cada leitura, com folga para não alarmar por um pico: temperatura acima do limite em 2 leituras
// seguidas, hashrate baixo por 10 min (e não nos primeiros 15 min depois de ligar), sem resposta em 3 leituras.
// Também conta reinícios (o uptime voltou) e blocos achados pelo próprio Bitaxe.
const LIMITS = { tempMax: 68, vrMax: 80, hashMin: 0.7, lowMs: 10 * 60e3, offlineFails: 3, warmupS: 900 };
const ALERT_KINDS = ['offline', 'hot', 'vrhot', 'lowhash', 'fallback', 'fault'];

function evaluate(prev, reading, limits = {}, now = Date.now()) {
  const L = { ...LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v != null && Number.isFinite(v))) };
  const s = { hotN: 0, vrN: 0, lowSince: null, fails: 0, uptime: null, reboots: 0, lastReset: null, blocks: 0, blockSeen: false, ...(prev || {}) };
  const active = {};
  if (!reading || !reading.ok) {
    s.fails++;
    if (s.fails >= L.offlineFails) active.offline = { error: (reading && reading.error) || null };
    return { ...s, active };   // sem leitura, os outros alertas ficam sem como saber
  }
  const d = reading.data;
  s.fails = 0;
  s.hotN = d.tempC != null && d.tempC > L.tempMax ? s.hotN + 1 : 0;
  if (s.hotN >= 2) active.hot = { tempC: d.tempC, max: L.tempMax };
  s.vrN = d.vrTempC != null && d.vrTempC > L.vrMax ? s.vrN + 1 : 0;
  if (s.vrN >= 2) active.vrhot = { tempC: d.vrTempC, max: L.vrMax };
  const hr = d.hashRate10m ?? d.hashRate;
  const warming = d.uptimeS != null && d.uptimeS < L.warmupS;
  const low = !d.paused && !warming && d.expected > 0 && hr != null && hr < L.hashMin * d.expected;
  s.lowSince = low ? (s.lowSince != null ? s.lowSince : now) : null;
  if (low && now - s.lowSince >= L.lowMs) active.lowhash = { hashRate: hr, expected: d.expected, pct: Math.round(hr / d.expected * 100) };
  if (d.pool && d.pool.fallback) active.fallback = { url: d.pool.url, port: d.pool.port };
  if (d.powerFault || d.hardwareFault || d.overheat) active.fault = { power: !!d.powerFault, hardware: !!d.hardwareFault, overheat: !!d.overheat };
  if (s.uptime != null && d.uptimeS != null && d.uptimeS < s.uptime) {
    // reinício pedido pelo painel (expectRebootUntil) não conta como "reiniciou sozinho"
    if (s.expectRebootUntil && now <= s.expectRebootUntil) s.expectRebootUntil = null;
    else { s.reboots++; s.lastReset = d.resetReason || null; }
  }
  if (d.uptimeS != null) s.uptime = d.uptimeS;
  if (d.blockFound && !s.blockSeen) s.blocks++;
  s.blockSeen = !!d.blockFound;
  return { ...s, active };
}

module.exports = { simpleAction, fanPatch, poolPatch, poolMatches, patch, request, LIMITS, ALERT_KINDS, evaluate, isPrivateHost, parseList, parseDiff, normalize, info, discover, getJson };
