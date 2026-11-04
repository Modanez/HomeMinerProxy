// Integração direta com tomadas inteligentes SmartLife / Tuya (OpenAPI v1.0) — zero dependências.
// Lê o consumo real em tempo real (Watts, Volts, mA e estado Liga/Desliga) e permite ligar,
// desligar ou reiniciar (power-cycle) o minerador pelo painel, Telegram ou watchdog automático.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ENDPOINTS = {
  us: 'https://openapi.tuyaus.com',   // Américas (inclui Brasil)
  eu: 'https://openapi.tuyaeu.com',   // Europa
  cn: 'https://openapi.tuyacn.com',   // China
  in: 'https://openapi.tuyain.com',   // Índia
};

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const SECRET_RE = /^[a-zA-Z0-9_-]{8,128}$/;

function validConfig(cfg = {}) {
  const clientId = String(cfg.clientId || '').trim();
  const secret = String(cfg.secret || '').trim();
  const deviceId = String(cfg.deviceId || '').trim();
  const region = String(cfg.region || 'us').trim() || 'us';
  if (!ID_RE.test(clientId) || !SECRET_RE.test(secret) || !ID_RE.test(deviceId)) return null;
  if (!ENDPOINTS[region] && !cfg.apiBase) return null;
  return { clientId, secret, deviceId, region, baseUrl: cfg.apiBase || ENDPOINTS[region] };
}

// Assinatura HMAC-SHA256 oficial da Tuya OpenAPI v1.0.
function signRequest({ clientId, secret, accessToken = '', method = 'GET', pathWithQuery = '/', body = '', timestamp, nonce = '' }) {
  const contentHash = crypto.createHash('sha256').update(body || '', 'utf8').digest('hex');
  const stringToSign = [method.toUpperCase(), contentHash, '', pathWithQuery].join('\n');
  const payload = String(clientId) + String(accessToken || '') + String(timestamp) + String(nonce || '') + stringToSign;
  return crypto.createHmac('sha256', String(secret)).update(payload, 'utf8').digest('hex').toUpperCase();
}

// Converte a lista de DPs da Tuya (ex.: switch_1, cur_power, cur_voltage, cur_current) em objeto padronizado.
function parseStatus(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.status) ? raw.status : null);
  const map = {};
  if (list) {
    for (const item of list) {
      if (item && typeof item.code === 'string') map[item.code] = item.value;
    }
  } else if (raw && typeof raw === 'object') {
    Object.assign(map, raw);
  }
  const switchCode = 'switch_1' in map ? 'switch_1' : ('switch' in map ? 'switch' : ('1' in map ? '1' : 'switch_1'));
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

  async function ensureToken(force = false) {
    if (!force && token && Date.now() < expireAt) return { ok: true, token };
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(8).toString('hex');
    const pathWithQuery = '/v1.0/token?grant_type=1';
    const sign = signRequest({ clientId: cfg.clientId, secret: cfg.secret, method: 'GET', pathWithQuery, timestamp, nonce });
    const r = await rawRequest(cfg.baseUrl, 'GET', pathWithQuery, {
      client_id: cfg.clientId, sign, t: timestamp, sign_method: 'HMAC-SHA256', nonce,
    });
    if (!r.ok || !r.result || !r.result.access_token) {
      return { ok: false, error: r.error || 'tuyaauth' };
    }
    token = r.result.access_token;
    const expSec = Number(r.result.expire_time) || 7200;
    expireAt = Date.now() + Math.max(60, expSec - 120) * 1000;
    return { ok: true, token };
  }

  async function signedCall(method, pathWithQuery, bodyObj = null, retried = false) {
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
      return signedCall(method, pathWithQuery, bodyObj, true);
    }
    return r;
  }

  async function getStatus() {
    const r = await signedCall('GET', `/v1.0/iot-03/devices/${encodeURIComponent(cfg.deviceId)}/status`);
    if (!r.ok) return r;
    const status = parseStatus(r.result);
    if (status.switchCode && status.switchCode !== '1') lastSwitchCode = status.switchCode;
    return { ok: true, status: { on: status.on, watts: status.watts, volts: status.volts, currentMa: status.currentMa, kwhTotal: status.kwhTotal, updatedAt: new Date().toISOString() } };
  }

  async function setSwitch(on) {
    const r = await signedCall('POST', `/v1.0/iot-03/devices/${encodeURIComponent(cfg.deviceId)}/commands`, {
      commands: [{ code: lastSwitchCode || 'switch_1', value: !!on }],
    });
    return r.ok ? { ok: true, on: !!on } : r;
  }

  async function powerCycle(offMs = 8000) {
    const off = await setSwitch(false);
    if (!off.ok) return off;
    await new Promise((res) => setTimeout(res, offMs));
    const on = await setSwitch(true);
    return on.ok ? { ok: true, rebootedAt: new Date().toISOString() } : on;
  }

  return { cfg, getStatus, setSwitch, powerCycle };
}

async function testPlug(opts = {}) {
  const client = createClient(opts);
  if (!client) return { ok: false, error: 'tuyamissing' };
  return client.getStatus();
}

module.exports = { ENDPOINTS, ID_RE, SECRET_RE, validConfig, signRequest, parseStatus, createClient, testPlug };
