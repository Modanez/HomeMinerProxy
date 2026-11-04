// Integração direta com tomadas inteligentes SmartLife / Tuya (OpenAPI v1.0) — zero dependências.
// Lê o consumo real em tempo real (Watts, Volts, mA e estado Liga/Desliga) e permite ligar,
// desligar ou reiniciar (power-cycle) o minerador pelo painel, Telegram ou watchdog automático.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ENDPOINTS = {
  us: 'https://openapi.tuyaus.com',        // Western America (padrão Brasil / Américas)
  'us-east': 'https://openapi-ueaz.tuyaus.com', // Eastern America
  eu: 'https://openapi.tuyaeu.com',        // Central Europe
  'eu-west': 'https://openapi-weaz.tuyaeu.com', // Western Europe
  cn: 'https://openapi.tuyacn.com',        // China
  in: 'https://openapi.tuyain.com',        // Índia
};
const ALL_ENDPOINTS = Object.values(ENDPOINTS);

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const SECRET_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const PLUG_NAME_RE = /^[\w.\-À-ÿ ]{1,48}$/;
const WORKER_NAME_RE = /^[\w.\-]{1,64}$/;

// Normaliza e valida uma lista de tomadas [{ name, deviceId, worker, watchdogMin }],
// migrando automaticamente a configuração antiga de tomada única (legacy) quando TUYA_PLUGS estiver vazio.
function normalizePlugs(rawPlugs, legacy = {}) {
  let arr = rawPlugs;
  if (typeof rawPlugs === 'string') {
    const t = rawPlugs.trim();
    if (!t) arr = null;
    else {
      try { arr = JSON.parse(t); } catch (_) { return { error: 'tuyaplugs', list: [] }; }
    }
  }
  if ((arr == null || (Array.isArray(arr) && !arr.length)) && legacy && legacy.deviceId) {
    const legId = String(legacy.deviceId).replace(/[\s"']/g, '');
    if (ID_RE.test(legId)) {
      const legW = String(legacy.worker || '').trim();
      const legWd = Number(legacy.watchdogMin || 0);
      arr = [{
        name: legW && legW !== '*' ? legW : 'Tomada 1',
        deviceId: legId,
        worker: legW,
        watchdogMin: Number.isInteger(legWd) && legWd >= 5 && legWd <= 1440 ? legWd : 0,
      }];
    }
  }
  if (arr == null || arr === '') return { list: [] };
  if (!Array.isArray(arr) || arr.length > 32) return { error: 'tuyaplugs', list: [] };
  const list = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'tuyaplugs', list: [] };
    const deviceId = String(item.deviceId || '').replace(/[\s"']/g, '');
    if (!deviceId) continue;
    if (!ID_RE.test(deviceId)) return { error: 'tuyaid', list: [] };
    if (seen.has(deviceId)) continue;
    seen.add(deviceId);
    const worker = String(item.worker || '').trim();
    if (worker !== '' && worker !== '*' && !WORKER_NAME_RE.test(worker)) return { error: 'name', list: [] };
    const rawName = String(item.name || '').trim() || (worker && worker !== '*' ? worker : `Tomada ${list.length + 1}`);
    if (!PLUG_NAME_RE.test(rawName)) return { error: 'name', list: [] };
    const wdRaw = item.watchdogMin === '' || item.watchdogMin == null ? 0 : Number(item.watchdogMin);
    if (!Number.isInteger(wdRaw) || (wdRaw !== 0 && (wdRaw < 5 || wdRaw > 1440))) return { error: 'watchdog', list: [] };
    list.push({ name: rawName, deviceId, worker, watchdogMin: wdRaw });
  }
  return { list };
}

function validConfig(cfg = {}) {
  const clientId = String(cfg.clientId || '').replace(/[\s"']/g, '');
  const secret = String(cfg.secret || '').replace(/[\s"']/g, '');
  const deviceId = String(cfg.deviceId || '').replace(/[\s"']/g, '');
  const region = String(cfg.region || 'us').trim() || 'us';
  if (!ID_RE.test(clientId) || !SECRET_RE.test(secret)) return null;
  if (!cfg.allowNoDevice && !ID_RE.test(deviceId)) return null;
  if (deviceId && !ID_RE.test(deviceId)) return null;
  if (!ENDPOINTS[region] && !cfg.apiBase) return null;
  return { clientId, secret, deviceId, region, baseUrl: cfg.apiBase || ENDPOINTS[region], customBase: !!cfg.apiBase };
}

// Assinatura HMAC-SHA256 oficial da Tuya OpenAPI v1.0.
function signRequest({ clientId, secret, accessToken = '', method = 'GET', pathWithQuery = '/', body = '', timestamp, nonce = '' }) {
  const contentHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const stringToSign = [method.toUpperCase(), contentHash, '', pathWithQuery].join('\n');
  const payload = String(clientId) + String(accessToken) + String(timestamp) + String(nonce) + stringToSign;
  return crypto.createHmac('sha256', String(secret)).update(payload, 'utf8').digest('hex').toUpperCase();
}

// Converte a lista de DPs da Tuya (ex.: switch_1, cur_power, cur_voltage, cur_current) em objeto padronizado.
function parseStatus(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.status) ? raw.status : (raw && Array.isArray(raw.properties) ? raw.properties : null));
  const map = {};
  if (list) {
    for (const item of list) {
      if (item && typeof item.code === 'string') map[item.code] = item.value;
    }
  } else if (raw && typeof raw === 'object') {
    Object.assign(map, raw);
  }
  const switchCode = 'switch_1' in map ? 'switch_1'
    : ('switch' in map ? 'switch'
    : ('switch_led' in map ? 'switch_led'
    : ('1' in map ? '1' : 'switch_1')));
  const onRaw = map[switchCode];
  const on = typeof onRaw === 'boolean' ? onRaw : null;

  // Na especificação padrão Tuya (categorias cz/pc), cur_power vem em 0,1 W (dW) e cur_voltage em 0,1 V (dV).
  const pRaw = map.cur_power ?? map['19'];
  const vRaw = map.cur_voltage ?? map['20'];
  const cRaw = map.cur_current ?? map['18'];
  const eRaw = map.add_ele ?? map['17'];

  const watts = pRaw != null && Number.isFinite(Number(pRaw)) ? Number((Number(pRaw) / 10).toFixed(1)) : null;
  const volts = vRaw != null && Number.isFinite(Number(vRaw)) ? Number((Number(vRaw) / 10).toFixed(1)) : null;
  const currentMa = cRaw != null && Number.isFinite(Number(cRaw)) ? Math.round(Number(cRaw)) : null;
  const kwhTotal = eRaw != null && Number.isFinite(Number(eRaw)) ? Number((Number(eRaw) / 1000).toFixed(3)) : null;

  return { on, watts, volts, currentMa, kwhTotal, switchCode };
}

function rawRequest(baseUrl, method, pathWithQuery, headers, body = '', timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(pathWithQuery, baseUrl); } catch (_) { return resolve({ ok: false, error: 'url' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const reqHeaders = { ...headers };
    if (body) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request(u, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < 100000) buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.success) return resolve({ ok: true, result: j.result, t: j.t });
          return resolve({ ok: false, code: j && j.code, error: (j && (j.msg || j.description)) || ('HTTP ' + res.statusCode) });
        } catch (_) {
          return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (body) req.end(body); else req.end();
  });
}

function createClient(opts = {}) {
  const cfg = validConfig(opts);
  if (!cfg) return null;
  let token = null, expireAt = 0, lastSwitchCode = 'switch_1';
  const switchCodes = new Map();

  async function fetchTokenOn(base) {
    const pathWithQuery = '/v1.0/token?grant_type=1';
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(8).toString('hex');
    const sign = signRequest({ clientId: cfg.clientId, secret: cfg.secret, method: 'GET', pathWithQuery, timestamp, nonce });
    const r = await rawRequest(base, 'GET', pathWithQuery, {
      client_id: cfg.clientId, sign, t: timestamp, sign_method: 'HMAC-SHA256', nonce,
    });
    if (r.ok && r.result && r.result.access_token) {
      cfg.baseUrl = base;
      token = r.result.access_token;
      const expSec = Number(r.result.expire_time) || 7200;
      expireAt = Date.now() + Math.max(60, expSec - 120) * 1000;
      return { ok: true, token };
    }
    return { ok: false, code: r.code, error: r.error };
  }

  async function ensureToken(force = false) {
    if (!force && token && Date.now() < expireAt) return { ok: true, token };
    const candidates = cfg.customBase ? [cfg.baseUrl] : [cfg.baseUrl, ...ALL_ENDPOINTS.filter((u) => u !== cfg.baseUrl)];
    let lastErr = null;
    for (const base of candidates) {
      const r = await fetchTokenOn(base);
      if (r.ok) return r;
      lastErr = r;
      if (r.code !== 1004 && !/suspended/i.test(String(r.error))) break;
    }
    return { ok: false, error: lastErr.error };
  }

  async function callOnCurrentBase(method, pathWithQuery, bodyObj = null, retried = false) {
    const tk = await ensureToken(retried);
    if (!tk.ok) return tk;
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(8).toString('hex');
    const sign = signRequest({
      clientId: cfg.clientId, secret: cfg.secret, accessToken: tk.token,
      method, pathWithQuery, body, timestamp, nonce,
    });
    const r = await rawRequest(cfg.baseUrl, method, pathWithQuery, {
      client_id: cfg.clientId, access_token: tk.token, sign, t: timestamp, sign_method: 'HMAC-SHA256', nonce,
    }, body);
    if (!r.ok && r.code === 1010 && !retried) {
      token = null;
      return callOnCurrentBase(method, pathWithQuery, bodyObj, true);
    }
    return r;
  }

  async function signedCall(method, pathWithQuery, bodyObj = null) {
    const first = await callOnCurrentBase(method, pathWithQuery, bodyObj, false);
    if (first.ok || cfg.customBase) return first;
    // Se o datacenter atual estiver suspenso ou não tiver o dispositivo/projeto, tenta os outros datacenters da Tuya
    if (/suspended|permission|sign invalid/i.test(String(first.error)) || first.code === 1004 || first.code === 1106 || first.code === 28841105) {
      const others = ALL_ENDPOINTS.filter((u) => u !== cfg.baseUrl);
      for (const base of others) {
        const tk = await fetchTokenOn(base);
        if (!tk.ok) continue;
        const r = await callOnCurrentBase(method, pathWithQuery, bodyObj, false);
        if (r.ok) return r;
      }
    }
    return first;
  }

  async function getStatus(devId = cfg.deviceId) {
    const targetId = String(devId || cfg.deviceId).replace(/[\s"']/g, '');
    if (!ID_RE.test(targetId)) return { ok: false, error: 'tuyaid' };
    const id = encodeURIComponent(targetId);
    const paths = [
      `/v1.0/iot-03/devices/${id}/status`,
      `/v1.0/devices/${id}/status`,
      `/v1.0/devices/${id}`,
      `/v2.0/cloud/thing/${id}/shadow/properties`,
    ];
    let r = null;
    for (const p of paths) {
      const attempt = await signedCall('GET', p);
      if (attempt.ok) { r = attempt; break; }
      if (!r) r = attempt;
    }
    if (!r || !r.ok) return r;
    const status = parseStatus(r.result);
    if (status.switchCode && status.switchCode !== '1') {
      lastSwitchCode = status.switchCode;
      switchCodes.set(targetId, status.switchCode);
    }
    return { ok: true, status: { on: status.on, watts: status.watts, volts: status.volts, currentMa: status.currentMa, kwhTotal: status.kwhTotal, updatedAt: new Date().toISOString() } };
  }

  async function setSwitch(on, devId = cfg.deviceId) {
    const targetId = String(devId || cfg.deviceId).replace(/[\s"']/g, '');
    if (!ID_RE.test(targetId)) return { ok: false, error: 'tuyaid' };
    const code = switchCodes.get(targetId) || lastSwitchCode;
    const id = encodeURIComponent(targetId);
    let r = await signedCall('POST', `/v1.0/iot-03/devices/${id}/commands`, {
      commands: [{ code, value: !!on }],
    });
    if (!r.ok) {
      const r2 = await signedCall('POST', `/v1.0/devices/${id}/commands`, {
        commands: [{ code, value: !!on }],
      });
      if (r2.ok) r = r2;
    }
    return r.ok ? { ok: true, on: !!on } : r;
  }

  async function powerCycle(offMs = 8000, devId = cfg.deviceId) {
    const off = await setSwitch(false, devId);
    if (!off.ok) return off;
    await new Promise((res) => setTimeout(res, offMs));
    const on = await setSwitch(true, devId);
    return on.ok ? { ok: true, rebootedAt: new Date().toISOString() } : on;
  }

  return { cfg, getStatus, setSwitch, powerCycle };
}

async function testPlug(opts = {}) {
  const client = createClient(opts);
  if (!client) return { ok: false, error: 'tuyamissing' };
  return client.getStatus();
}

module.exports = { ENDPOINTS, ID_RE, SECRET_RE, PLUG_NAME_RE, normalizePlugs, validConfig, signRequest, parseStatus, createClient, testPlug, _test: { rawRequest } };

