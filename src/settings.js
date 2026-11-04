// Tela de configurações: edita, pelo navegador, parte do que fica em /etc/mineracao.env.
// O que é salvo aqui vai para DATA_DIR/settings.json e vale por cima do .env (o .env continua
// valendo para o que não foi mudado na tela). Salvar exige o SETTINGS_PIN, e o painel reinicia
// sozinho para aplicar (systemd e Docker sobem ele de novo). O cubo percebe a mudança e reinicia também.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { parseBroker, cleanTopic, testBroker } = require('./mqtt');
const { ID_RE: TUYA_ID_RE, SECRET_RE: TUYA_SECRET_RE, normalizePlugs, testPlug } = require('./tuya');

const THEMES = ['obsidian', 'ocean', 'latte'];
function normTheme(v) {
  const s = String(v || '').trim().toLowerCase();
  return THEMES.includes(s) ? s : 'obsidian';
}

const FIELDS = [
  { key: 'BTC_ADDRESS', group: 'farm', type: 'address', required: true },
  { key: 'THEME', group: 'farm', type: 'theme', options: ['', 'obsidian', 'ocean', 'latte'] },
  { key: 'LANGUAGE', group: 'farm', type: 'select', options: ['', 'pt-BR', 'en'] },
  { key: 'CURRENCY', group: 'farm', type: 'select', options: ['', 'BRL', 'USD'] },
  { key: 'POWER_PRICE_KWH', group: 'farm', type: 'price', alias: 'TARIFA_KWH' },
  { key: 'SHOW_WALLET', group: 'farm', type: 'bool', unset: '1' },
  { key: 'LOCAL_WORKER', group: 'miners', type: 'worker' },
  { key: 'ALARM_IGNORE', group: 'miners', type: 'workers' },
  { key: 'WATTS', group: 'miners', type: 'watts' },
  { key: 'EXPECTED', group: 'miners', type: 'expected' },
  { key: 'CUBE_IP', group: 'cube', type: 'host' },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', type: 'secret' },
  { key: 'TELEGRAM_CHAT_ID', group: 'telegram', type: 'chatids' },
  { key: 'TELEGRAM_DAILY', group: 'telegram', type: 'hour', unset: '21' },
  { key: 'TELEGRAM_PERSONAL', group: 'telegram', type: 'bool' },
  { key: 'TELEGRAM_PANEL_URL', group: 'telegram', type: 'url' },
  { key: 'MQTT_URL', group: 'mqtt', type: 'mqtturl' },
  { key: 'MQTT_USER', group: 'mqtt', type: 'mqttuser' },
  { key: 'MQTT_PASS', group: 'mqtt', type: 'secret' },
  { key: 'MQTT_TOPIC', group: 'mqtt', type: 'mqtttopic' },
  { key: 'TUYA_REGION', group: 'tuya', type: 'select', options: ['', 'us', 'us-east', 'eu', 'eu-west', 'cn', 'in'] },
  { key: 'TUYA_CLIENT_ID', group: 'tuya', type: 'tuyaid' },
  { key: 'TUYA_SECRET', group: 'tuya', type: 'secret' },
  { key: 'TUYA_PLUGS', group: 'tuya', type: 'tuyaplugs' },
  { key: 'TUYA_DEVICE_ID', group: 'tuya', type: 'tuyaid' },
  { key: 'TUYA_WORKER', group: 'tuya', type: 'tuyaworker' },
  { key: 'TUYA_WATCHDOG_MIN', group: 'tuya', type: 'watchdog' },
];
const KEYS = FIELDS.map((f) => f.key);

const fileOf = (dataDir) => path.join(dataDir, 'settings.json');
let ORIGINAL = null;   // o ambiente antes da tela (vem do .env), para saber o que mudou

function readOverlay(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    return j && typeof j === 'object' ? Object.fromEntries(Object.entries(j).filter(([k, v]) => KEYS.includes(k) && typeof v === 'string')) : {};
  } catch (_) { return {}; }
}

// Valor como o painel o interpreta (undefined = não definido).
function effective(f, raw) {
  if (f.type === 'hour') return raw === undefined ? f.unset : (raw === '' || raw === 'off' ? 'off' : String(raw));
  if (f.type === 'bool') {
    if (raw === undefined || raw === '') return f.unset || '0';
    return f.unset === '1' ? (raw === '0' ? '0' : '1') : (raw === '1' ? '1' : '0');
  }
  if (f.type === 'watts' || f.type === 'expected') {
    if (!raw) return '';
    const r = cleanMap(raw, f.type);
    return r.error ? String(raw) : r.value;
  }
  if (f.type === 'tuyaplugs') {
    if (!raw) return '';
    const r = normalizePlugs(raw);
    return r.error ? String(raw) : (r.list.length ? JSON.stringify(r.list) : '');
  }
  return raw == null ? '' : String(raw);
}
const rawOf = (f, env) => env[f.key] ?? (f.alias ? env[f.alias] : undefined);

// Chamado antes de o painel ler as variáveis: aplica os valores salvos na tela por cima do .env.
function applyOverlay(dataDir, env = process.env) {
  ORIGINAL = Object.fromEntries(FIELDS.map((f) => [f.key, rawOf(f, env)]));
  const ov = readOverlay(dataDir);
  for (const [k, v] of Object.entries(ov)) env[k] = v;
  return ov;
}

// ---------------------------------------------------------------- validação
const ADDRESS_RE = /^(bc1[02-9ac-hj-np-z]{11,87}|tb1[02-9ac-hj-np-z]{11,87}|[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const NAME_RE = /^[\w.\-]{1,64}$/;
const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,80}$/;
// Aceita o token como ele costuma vir colado: com espaços ou quebras de linha, entre aspas,
// com "bot" na frente ou dentro do link da API (https://api.telegram.org/bot<token>/...).
function normToken(v) {
  v = String(v || '').replace(/\s+/g, '').replace(/^["'`]+|["'`]+$/g, '');
  const m = /(\d{5,15}:[A-Za-z0-9_-]{30,80})/.exec(v);
  return m ? m[1] : v.replace(/^bot/i, '');
}

// Converte hashrate (número em H/s ou texto como "1.2 TH/s", "350 kH/s", "9M", "1,2T") para H/s.
function parseHr(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1e24 ? v : NaN;
  const s = String(v == null ? '' : v).trim().replace(',', '.');
  const m = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*([kmgtpe])?(?:h(?:\/s)?|\/s)?$/i.exec(s);
  if (!m) return NaN;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15, e: 1e18 }[(m[2] || '').toLowerCase()];
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) && n >= 0 && n <= 1e24 ? n : NaN;
}

// Normaliza e valida um mapa { worker: valor } para WATTS (W) ou EXPECTED (H/s).
function cleanMap(raw, kind) {
  if (raw == null || raw === '') return { value: '' };
  let obj = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return { value: '' };
    try { obj = JSON.parse(t); } catch (_) { return { error: kind }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: kind };
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    const name = k.trim();
    if (!name) continue;
    if (!NAME_RE.test(name)) return { error: 'name' };
    const val = obj[k];
    if (val === '' || val === null || val === undefined) continue;
    if (kind === 'watts') {
      const n = typeof val === 'number' ? val : Number(String(val).trim().replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: 'watts' };
      out[name] = n;
    } else {
      const n = parseHr(val);
      if (!Number.isFinite(n)) return { error: 'expected' };
      out[name] = n;
    }
  }
  return { value: Object.keys(out).length ? JSON.stringify(out) : '' };
}

// Normaliza e valida um valor vindo do formulário. Devolve { value } ou { error: códigoDoErro }.
function clean(field, raw) {
  if (field.type === 'watts' || field.type === 'expected') return cleanMap(raw, field.type);
  if (field.type === 'tuyaplugs') {
    const r = normalizePlugs(raw);
    return r.error ? { error: r.error } : { value: r.list.length ? JSON.stringify(r.list) : '' };
  }
  let v = raw;
  if (field.type === 'workers') v = Array.isArray(raw) ? raw.map(String) : String(raw || '').split(',');
  else if (field.type === 'bool') v = raw === true || raw === '1' || raw === 'true' ? '1' : '0';
  else v = String(raw == null ? '' : raw).trim();
  switch (field.type) {
    case 'address':
      if (/^bc1/i.test(v) || /^tb1/i.test(v)) v = v.toLowerCase();
      return ADDRESS_RE.test(v) ? { value: v } : { error: 'address' };
    case 'select':
    case 'theme':
      return field.options.includes(v) ? { value: v } : { error: 'option' };
    case 'price': {
      if (v === '') return { value: '' };
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { value: String(n) } : { error: 'price' };
    }
    case 'worker':
      return v === '' || NAME_RE.test(v) ? { value: v } : { error: 'name' };
    case 'workers': {
      const list = [...new Set(v.map((s) => s.trim()).filter(Boolean))];
      return list.every((s) => NAME_RE.test(s)) ? { value: list.join(',') } : { error: 'name' };
    }
    case 'host': {
      const numeric = /^[\d.]+$/.test(v);   // só números e pontos tem que ser um IPv4 de verdade
      return v === '' || (HOST_RE.test(v) && (!numeric || IPV4_RE.test(v))) ? { value: v } : { error: 'host' };
    }
    case 'secret':
      if (field.key === 'MQTT_PASS') {
        return v.length <= 256 && !/[\r\n\0]/.test(v) ? { value: v } : { error: 'option' };
      }
      if (field.key === 'TUYA_SECRET') {
        return v === '' || TUYA_SECRET_RE.test(v) ? { value: v } : { error: 'tuyasecret' };
      }
      v = normToken(v);
      return v === '' || TOKEN_RE.test(v) ? { value: v } : { error: 'token' };
    case 'chatids': {
      const list = v.split(',').map((s) => s.trim()).filter(Boolean);
      return list.every((s) => /^-?\d{1,20}$/.test(s)) ? { value: list.join(',') } : { error: 'chatid' };
    }
    case 'hour':
      return v === '' || (/^\d{1,2}$/.test(v) && Number(v) < 24) ? { value: v === '' ? 'off' : String(Number(v)) } : { error: 'hour' };
    case 'bool':
      return { value: v };
    case 'url':
      return v === '' || (/^https?:\/\/[^\s<>"']{1,300}$/.test(v)) ? { value: v } : { error: 'url' };
    case 'mqtturl':
      return v === '' || parseBroker(v) ? { value: v } : { error: 'mqtturl' };
    case 'mqttuser':
      return v.length <= 128 && !/[\r\n\0]/.test(v) ? { value: v } : { error: 'name' };
    case 'mqtttopic': {
      if (v === '') return { value: '' };
      const t = cleanTopic(v);
      return t ? { value: t } : { error: 'mqtttopic' };
    }
    case 'tuyaid':
      return v === '' || TUYA_ID_RE.test(v) ? { value: v } : { error: 'tuyaid' };
    case 'tuyaworker':
      return v === '' || v === '*' || NAME_RE.test(v) ? { value: v } : { error: 'name' };
    case 'watchdog': {
      if (v === '' || v === '0') return { value: '' };
      const n = Number(v);
      return Number.isInteger(n) && n >= 5 && n <= 1440 ? { value: String(n) } : { error: 'watchdog' };
    }
    default:
      return { error: 'option' };
  }
}

// Valores atuais, como a tela mostra (o token nunca sai do servidor: só "configurado" e o final).
function current(env = process.env) {
  const out = {};
  for (const f of FIELDS) {
    let v = effective(f, rawOf(f, env));
    if (f.type === 'hour') v = v === 'off' ? '' : v;
    if (f.type === 'bool') v = v === '1';
    if (f.type === 'workers') v = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    if (f.type === 'watts' || f.type === 'expected') {
      try { v = v ? JSON.parse(v) : {}; } catch (_) { v = {}; }
    }
    if (f.type === 'tuyaplugs') {
      const r = normalizePlugs(v, {
        deviceId: rawOf(FIELDS.find((x) => x.key === 'TUYA_DEVICE_ID'), env),
        worker: rawOf(FIELDS.find((x) => x.key === 'TUYA_WORKER'), env),
        watchdogMin: rawOf(FIELDS.find((x) => x.key === 'TUYA_WATCHDOG_MIN'), env),
      });
      v = r.list || [];
    }
    if (f.type === 'secret') v = v ? { set: true, tail: String(v).slice(-4) } : { set: false };
    out[f.key] = v;
  }
  return out;
}

// Junta o formulário com o que já existe e devolve o novo settings.json (ou os erros por campo).
function merge(dataDir, form, env = process.env) {
  const errors = {}, ov = readOverlay(dataDir), orig = ORIGINAL || {};
  for (const f of FIELDS) {
    if (!(f.key in form)) continue;
    if (f.type === 'secret') {
      if (form[f.key + '_clear']) { set(f, ''); continue; }
      if (typeof form[f.key] !== 'string' || form[f.key].trim() === '') continue;   // vazio = manter o valor atual
    }
    const r = clean(f, form[f.key]);
    if (r.error) { errors[f.key] = r.error; continue; }
    set(f, r.value);
  }
  function set(f, value) {
    const base = effective(f, orig[f.key]);
    const same = value === base || (f.type === 'price' && value !== '' && base !== '' && Number(value) === Number(base));
    if (same) delete ov[f.key]; else ov[f.key] = value;
    env[f.key] = value;
  }
  return { errors, overlay: ov };
}

function save(dataDir, overlay) {
  const p = fileOf(dataDir), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(overlay, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------- backup e restauração
// Lista fechada de arquivos permitidos no backup (nunca usa nomes vindos do usuário).
const BACKUP_FILES = {
  settings: 'settings.json',
  workers: 'workers.json',
  records: 'records.json',
  history: 'history.json',
  achievements: 'achievements.json',
  proxyStats: 'proxy-stats.json',
  telegram: 'telegram.json',
  cubo: 'cubo-state.json',
};

function exportBackup(dataDir) {
  const data = {};
  for (const [key, fname] of Object.entries(BACKUP_FILES)) {
    if (key === 'settings') {
      const ov = readOverlay(dataDir);
      if (Object.keys(ov).length) data.settings = ov;
      continue;
    }
    try {
      data[key] = JSON.parse(fs.readFileSync(path.join(dataDir, fname), 'utf8'));
    } catch (_) { /* arquivo ainda não existe */ }
  }
  return { app: 'home-miner-proxy', version: 1, exportedAt: new Date().toISOString(), data };
}

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function validateBackupData(raw) {
  if (!isPlainObj(raw) || raw.version !== 1 || !isPlainObj(raw.data)) return { error: 'backup' };
  const d = raw.data, out = {};
  if ('settings' in d && d.settings != null) {
    if (!isPlainObj(d.settings)) return { error: 'backup' };
    const cleanSettings = {};
    for (const [k, v] of Object.entries(d.settings)) {
      const f = FIELDS.find((x) => x.key === k);
      if (!f) continue;
      if (f.type === 'hour' && v === 'off') { cleanSettings[k] = 'off'; continue; }
      const r = clean(f, v);
      if (r.error) return { error: 'backup' };
      cleanSettings[k] = r.value;
    }
    out.settings = cleanSettings;
  }
  if ('workers' in d && d.workers != null) {
    if (!isPlainObj(d.workers)) return { error: 'backup' };
    const ws = {};
    for (const [k, w] of Object.entries(d.workers)) {
      if (!NAME_RE.test(k) || !isPlainObj(w)) return { error: 'backup' };
      const hr = Number(w.hashRate || 0), best = Number(w.bestDifficulty || 0);
      if (!Number.isFinite(hr) || hr < 0 || !Number.isFinite(best) || best < 0) return { error: 'backup' };
      ws[k] = {
        name: k,
        hashRate: hr,
        hrBy: typeof w.hrBy === 'string' && ['pool', 'proxy', 'nominal'].includes(w.hrBy) ? w.hrBy : 'pool',
        bestDifficulty: best,
        lastSeen: typeof w.lastSeen === 'string' ? w.lastSeen.slice(0, 40) : null,
        pool: typeof w.pool === 'string' ? w.pool.slice(0, 64) : null,
      };
    }
    out.workers = ws;
  }
  if ('records' in d && d.records != null) {
    if (!Array.isArray(d.records) || d.records.length > 500) return { error: 'backup' };
    const recs = [];
    for (const r of d.records) {
      if (!isPlainObj(r) || typeof r.worker !== 'string' || !r.worker || r.worker.length > 64) return { error: 'backup' };
      const val = Number(r.value);
      if (!Number.isFinite(val) || val < 0) return { error: 'backup' };
      recs.push({ worker: r.worker, value: val, at: typeof r.at === 'string' ? r.at.slice(0, 40) : new Date().toISOString() });
    }
    out.records = recs.slice(0, 200);
  }
  if ('history' in d && d.history != null) {
    if (!Array.isArray(d.history) || d.history.length > 2000) return { error: 'backup' };
    const hist = [];
    for (const h of d.history) {
      if (!isPlainObj(h)) return { error: 'backup' };
      const t = Number(h.t), hr = Number(h.hr);
      if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(hr) || hr < 0) return { error: 'backup' };
      const pt = { t: Math.round(t), hr: Math.round(hr) };
      if (h.w != null && Number.isFinite(Number(h.w)) && Number(h.w) >= 0) pt.w = Number(Number(h.w).toFixed(1));
      hist.push(pt);
    }
    out.history = hist;
  }
  if ('achievements' in d && d.achievements != null) {
    if (!isPlainObj(d.achievements)) return { error: 'backup' };
    const ach = {};
    for (const [k, v] of Object.entries(d.achievements)) {
      if (!/^[a-z0-9_]{1,40}$/.test(k) || !isPlainObj(v)) return { error: 'backup' };
      ach[k] = {
        unlockedAt: typeof v.unlockedAt === 'string' ? v.unlockedAt.slice(0, 40) : new Date().toISOString(),
        worker: typeof v.worker === 'string' && NAME_RE.test(v.worker) ? v.worker : null,
      };
    }
    out.achievements = ach;
  }
  if ('proxyStats' in d && d.proxyStats != null) {
    const ps = d.proxyStats;
    if (!isPlainObj(ps)) return { error: 'backup' };
    if (ps.workers != null && !isPlainObj(ps.workers)) return { error: 'backup' };
    if (ps.recent != null && !Array.isArray(ps.recent)) return { error: 'backup' };
    if (ps.hist != null && (!Array.isArray(ps.hist) || ps.hist.length !== 40 || !ps.hist.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))) return { error: 'backup' };
    out.proxyStats = ps;
  }
  if ('telegram' in d && d.telegram != null) {
    if (!isPlainObj(d.telegram)) return { error: 'backup' };
    out.telegram = { offset: Number(d.telegram.offset) || 0, lastDaily: typeof d.telegram.lastDaily === 'string' ? d.telegram.lastDaily.slice(0, 20) : null };
  }
  if ('cubo' in d && d.cubo != null) {
    if (!isPlainObj(d.cubo)) return { error: 'backup' };
    out.cubo = { recordT: Number(d.cubo.recordT) || null, partyUntil: Number(d.cubo.partyUntil) || 0, lastAt: Number(d.cubo.lastAt) || 0 };
  }
  if (!Object.keys(out).length) return { error: 'backup' };
  return { data: out };
}

function restoreBackup(dataDir, payload, env = process.env) {
  const v = validateBackupData(payload);
  if (v.error) return v;
  for (const [key, content] of Object.entries(v.data)) {
    const p = path.join(dataDir, BACKUP_FILES[key]), tmp = p + '.tmp';
    const mode = key === 'settings' || key === 'telegram' ? 0o600 : 0o644;
    fs.writeFileSync(tmp, JSON.stringify(content, null, 2), { mode });
    fs.renameSync(tmp, p);
  }
  if (v.data.settings) {
    for (const [k, val] of Object.entries(v.data.settings)) env[k] = val;
  }
  return { ok: true, restored: Object.keys(v.data) };
}

// ---------------------------------------------------------------- PIN
let fails = [];   // horários das tentativas erradas (bloqueia por 15 min depois de 5)
function checkPin(pin, expected, now = Date.now()) {
  fails = fails.filter((t) => now - t < 15 * 60e3);
  if (!expected) return 'nopin';
  if (fails.length >= 5) return 'locked';
  const a = crypto.createHash('sha256').update(String(pin || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  if (crypto.timingSafeEqual(a, b)) { fails = []; return 'ok'; }
  fails.push(now);
  return 'wrong';
}
const resetPinFails = () => { fails = []; };

// ---------------------------------------------------------------- testes (cubo e Telegram)
function testCube(host, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!host || !HOST_RE.test(host)) return resolve(false);
    const req = http.get({ host, port: 80, path: '/', timeout: timeoutMs }, (r) => { r.resume(); resolve(r.statusCode > 0); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function testTelegram(token, chatIds, text, api = 'https://api.telegram.org') {
  const ids = String(chatIds || '').split(',').map((s) => s.trim()).filter(Boolean);
  token = normToken(token);
  if (!TOKEN_RE.test(token) || !ids.length) return Promise.resolve({ ok: false, error: 'missing' });
  const send = (chat_id) => new Promise((resolve) => {
    const u = new URL(`${api.replace(/\/$/, '')}/bot${token}/sendMessage`);
    const body = JSON.stringify({ chat_id, text });
    const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => { try { const j = JSON.parse(b); resolve(j.ok ? { ok: true } : { ok: false, error: j.description || 'erro' }); } catch (_) { resolve({ ok: false, error: 'HTTP ' + r.statusCode }); } });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
  return Promise.all(ids.map(send)).then((rs) => rs.find((r) => !r.ok) || { ok: true });
}

// ---------------------------------------------------------------- página
const T = {
  pt: {
    title: 'Configurações', back: '← Voltar ao painel',
    groups: { farm: 'Fazenda', miners: 'Mineradores', cube: 'Cubo GeekMagic', telegram: 'Bot do Telegram', mqtt: 'Home Assistant / MQTT', tuya: 'Tomada Inteligente SmartLife / Tuya', backup: 'Backup e restauração' },
    tabs: { farm: '🏠 Fazenda', miners: '⛏️ Mineradores', telegram: '✈️ Telegram', tuya: '🔌 Tomada', mqtt: '🏠 MQTT / HA', cube: '🧊 Cubo', backup: '💾 Backup' },
    BTC_ADDRESS: ['Endereço de bitcoin', 'O endereço público que os mineradores usam como usuário. O painel consulta pools e carteira por ele. Mudar aqui não muda para onde os mineradores mandam o prêmio: isso vem do usuário configurado em cada um.'],
    THEME: ['Tema visual (Material Design)', 'Escolha um dos 3 temas Material Design para o painel, modo kiosk e tela de administração. Clique em um cartão para pré-visualizar na hora.'],
    themes: [
      { id: 'obsidian', name: '🌑 Obsidian', sub: 'Material Dark · Grafite e Ouro Bitcoin (padrão)', colors: ['#0e1117', '#171c26', '#f2a900', '#3ecf8e'] },
      { id: 'ocean', name: '🌊 Material Ocean', sub: 'Material You Escuro · Azul Profundo e Ciano Elétrico', colors: ['#0b111e', '#131c31', '#38bdf8', '#34d399'] },
      { id: 'latte', name: '☀️ Material Solar', sub: 'Material 3 Claro · Alabastro e Âmbar', colors: ['#f5f3ee', '#ffffff', '#d97706', '#16a34a'] },
    ],
    LANGUAGE: ['Idioma padrão', 'Do painel, do cubo e do bot. O botão PT | EN continua valendo em cada navegador.'],
    CURRENCY: ['Moeda', 'Cotação, prêmio e conta de luz.'],
    POWER_PRICE_KWH: ['Preço do kWh', 'Na moeda escolhida, para a estimativa da conta de luz.'],
    SHOW_WALLET: ['Mostrar a carteira', 'Saldo, valor e movimentação na tela da fazenda. Desligue se a tela fica à vista de visitas ou se o painel é aberto de fora de casa. A cotação continua aparecendo, e o aviso de dinheiro entrando continua chegando no Telegram.'],
    LOCAL_WORKER: ['Minerador nesta máquina', 'Worker do cpuminer que roda neste servidor (serviço minerd). O painel lê o hashrate do log e mostra a temperatura da CPU.'],
    ALARM_IGNORE: ['Não acender a luz vermelha', 'Workers que podem parar sem alarme (ex.: um notebook que você desliga à noite). Também não geram aviso no Telegram.'],
    WATTS: ['Consumo por worker (W)', 'Em watts, para a estimativa da conta de luz. Vazio usa o padrão (5 W).'],
    EXPECTED: ['Hashrate esperado por worker', 'Aparece no painel mesmo quando a pool esconde o worker. Use 0 para ocultar um worker esperado no .env; vazio deixa só pelo que a pool ou o proxy informarem.'],
    CUBE_IP: ['IP do cubo', 'Vazio desliga o placar no cubo.'],
    TELEGRAM_BOT_TOKEN: ['Token do bot', 'Crie o bot no @BotFather (/newbot) e cole o token aqui.'],
    TELEGRAM_CHAT_ID: ['Id do chat', 'Mande /start para o bot depois de salvar o token: ele responde com o id. Vários: separe por vírgula.'],
    TELEGRAM_DAILY: ['Resumo diário', 'Hora do resumo (0 a 23). Vazio desliga.'],
    TELEGRAM_PERSONAL: ['Avisar recordes pessoais', 'Além do recorde da fazenda, avisa o recorde de cada worker (pode falar bastante no começo).'],
    TELEGRAM_PANEL_URL: ['Link do painel', 'Aparece no /status. Ex.: http://odroid:3000 (Tailscale).'],
    MQTT_URL: ['Broker MQTT', 'URL do broker (ex.: mqtt://homeassistant.local:1883 ou mqtts://host:8883). Vazio desliga.'],
    MQTT_USER: ['Usuário MQTT', 'Usuário configurado no broker (Mosquitto / Home Assistant). Opcional se o broker aceitar conexão anônima.'],
    MQTT_PASS: ['Senha MQTT', 'Senha do usuário MQTT.'],
    MQTT_TOPIC: ['Prefixo do tópico', 'Padrão: homeminerproxy. Publica homeassistant/sensor/homeminerproxy/... (Auto-Discovery) e <prefixo>/state + <prefixo>/event.'],
    TUYA_REGION: ['Região Tuya Cloud', 'Américas (us) atende o Brasil. Só mude se sua conta no iot.tuya.com foi criada em outro datacenter (eu, cn, in).'],
    TUYA_CLIENT_ID: ['Access ID (Client ID)', 'Do seu projeto Cloud em iot.tuya.com (vinculado ao app SmartLife por QR Code). Vazio desliga.'],
    TUYA_SECRET: ['Access Secret (Client Secret)', 'Chave secreta do projeto em iot.tuya.com.'],
    TUYA_PLUGS: ['Tomadas e dispositivos SmartLife', 'Cadastre quantas tomadas ou dispositivos quiser da sua conta SmartLife. Em cada um: Nome, Device ID (ID Virtual no app SmartLife), qual minerador está ligado nele (ou "Só monitorar") e o watchdog opcional em minutos (mín. 5).'],
    TUYA_DEVICE_ID: ['Device ID da tomada', 'No app SmartLife: toque na tomada → ícone ✏️ no canto superior → Informações do Dispositivo → ID Virtual.'],
    TUYA_WORKER: ['Aparelho ligado na tomada', 'Se escolher um worker (ex.: bitaxe), os Watts reais da tomada entram no consumo dele. Em "Só monitorar", mostra a leitura no painel sem somar na conta dos mineradores.'],
    TUYA_WATCHDOG_MIN: ['Reiniciar tomada se parar (min)', 'Se o worker da tomada ficar parado por esses minutos (mín. 5), desliga a tomada por 8s e religa sozinho. Vazio desliga.'],
    auto: 'Automático', none: 'Nenhum', yes: 'Sim', tuyaNone: 'Só monitorar (não somar nos mineradores)', tuyaAll: 'Fazenda inteira (*)',
    addWorkerPlaceholder: 'Nome do worker (ex.: bitaxe)', addWattsPlaceholder: 'W (ex.: 20)', addHrPlaceholder: 'Hashrate (ex.: 1.2)', addWorkerBtn: '+ Adicionar worker',
    addPlugNamePlaceholder: 'Apelido (ex.: Bitaxe, Ventilador)', addPlugIdPlaceholder: 'Device ID (ID Virtual no app)', addPlugWdPlaceholder: 'Watchdog min', addPlugBtn: '+ Adicionar tomada',
    tokenSet: (t) => `configurado (termina em ${t}). Deixe vazio para manter.`, tokenClear: 'Remover o valor salvo',
    backupHelp: 'Baixe ou restaure recordes, histórico, workers e configurações num único arquivo JSON (pede o PIN abaixo).',
    backupDown: '⬇ Baixar backup', backupUp: '⬆ Restaurar backup…',
    backupOk: 'Backup baixado.', restored: 'Backup restaurado! Reiniciando o painel…',
    pin: 'PIN', pinHelp: 'O SETTINGS_PIN que está em /etc/mineracao.env (o instalador cria e mostra no final).',
    noPin: 'Para salvar por aqui, defina SETTINGS_PIN em /etc/mineracao.env e reinicie o painel. Rode o install.sh de novo que ele cria um PIN para você.',
    save: 'Salvar e reiniciar', testCube: 'Testar cubo', testTg: 'Mandar mensagem de teste', testMqtt: 'Testar MQTT', testTuya: 'Testar tomada',
    saved: 'Salvo! Reiniciando o painel…', back2: 'Pronto. Voltando ao painel…', nothing: 'Nada mudou.',
    cubeOk: 'O cubo respondeu.', cubeFail: 'O cubo não respondeu nesse IP.',
    tgOk: 'Mensagem enviada. Confira o Telegram.', tgFail: (e) => `Não enviou: ${e}`, tgTest: '✅ Teste do painel da fazenda: o bot está funcionando!',
    mqttOk: 'Conectado ao broker MQTT!', mqttFail: (e) => `Falha no MQTT: ${e}`,
    tuyaOk: (s) => `Tomada respondeu: ${s}`, tuyaFail: (e) => `Falha na tomada: ${e}`,
    err: { address: 'Endereço inválido', option: 'Opção inválida', price: 'Use um número entre 0 e 100', watts: 'Use watts entre 0 e 100000', expected: 'Hashrate inválido (ex.: 1.2 TH/s ou 350 kH/s)', backup: 'Arquivo de backup inválido', name: 'Nome inválido', host: 'IP inválido', token: 'Não parece um token do Telegram. Toque em 👁 para conferir: o certo tem só o token, assim: 1234567890:AAH… (números, dois-pontos e uns 35 caracteres). O navegador pode ter preenchido uma senha salva no lugar.', chatid: 'O id do chat é um número (ex.: 8983008026), não o nome do bot. Mande /start para o bot: ele responde com o número.', nochat: 'o Telegram não achou esse chat. Abra o bot no Telegram e toque em Iniciar (/start): bots só escrevem para quem já falou com eles. Confira também se o id é o número que o bot respondeu.', hour: 'Hora de 0 a 23', url: 'Comece com http:// ou https://', mqtturl: 'Use mqtt://host:1883 ou mqtts://host:8883', mqtttopic: 'Prefixo inválido (use letras, números, _, - ou /)', mqttauth: 'Usuário ou senha recusados pelo broker', tuyaid: 'ID inválido (use letras e números de 8 a 64 caracteres)', tuyasecret: 'Access Secret inválido', tuyaplugs: 'Lista de tomadas inválida', tuyamissing: 'Preencha Access ID, Access Secret e Device ID', tuyaauth: 'Credenciais recusadas pela Tuya Cloud', watchdog: 'Use de 5 a 1440 minutos (ou vazio para desligar)', wrong: 'PIN errado', locked: 'Muitas tentativas erradas. Espere 15 minutos.', nopin: 'SETTINGS_PIN não definido', missing: 'Preencha o token e o id do chat', fix: 'Corrija os campos marcados.' },
  },
  en: {
    title: 'Settings', back: '← Back to the dashboard',
    groups: { farm: 'Farm', miners: 'Miners', cube: 'GeekMagic cube', telegram: 'Telegram bot', mqtt: 'Home Assistant / MQTT', tuya: 'SmartLife / Tuya Smart Plug', backup: 'Backup and restore' },
    tabs: { farm: '🏠 Farm', miners: '⛏️ Miners', telegram: '✈️ Telegram', tuya: '🔌 Smart Plug', mqtt: '🏠 MQTT / HA', cube: '🧊 Cube', backup: '💾 Backup' },
    BTC_ADDRESS: ['Bitcoin address', 'The public address your miners use as username. The dashboard looks up pools and the wallet with it. Changing it here does not change where the miners send the reward: that comes from the username set on each miner.'],
    THEME: ['Visual theme (Material Design)', 'Choose one of the 3 Material Design themes for the dashboard, kiosk mode and admin screen. Click a card to preview it live.'],
    themes: [
      { id: 'obsidian', name: '🌑 Obsidian', sub: 'Material Dark · Graphite & Bitcoin Gold (default)', colors: ['#0e1117', '#171c26', '#f2a900', '#3ecf8e'] },
      { id: 'ocean', name: '🌊 Material Ocean', sub: 'Material You Dark · Deep Blue & Electric Cyan', colors: ['#0b111e', '#131c31', '#38bdf8', '#34d399'] },
      { id: 'latte', name: '☀️ Material Solar', sub: 'Material 3 Light · Alabaster & Amber', colors: ['#f5f3ee', '#ffffff', '#d97706', '#16a34a'] },
    ],
    LANGUAGE: ['Default language', 'For the dashboard, cube and bot. The PT | EN button still works per browser.'],
    CURRENCY: ['Currency', 'BTC price, prize and power bill.'],
    POWER_PRICE_KWH: ['Price per kWh', 'In the chosen currency, for the power bill estimate.'],
    SHOW_WALLET: ['Show the wallet', 'Balance, value and activity on the farm screen. Turn it off if the screen is in view of visitors or the dashboard is opened from outside your home. The BTC price still shows, and Telegram still alerts when money arrives.'],
    LOCAL_WORKER: ['Miner on this machine', 'The cpuminer worker running on this server (minerd service). The dashboard reads its hashrate from the log and shows the CPU temperature.'],
    ALARM_IGNORE: ['Don\'t turn the red light on', 'Workers that may stop without an alarm (e.g. a laptop you shut down at night). They also skip Telegram alerts.'],
    WATTS: ['Power per worker (W)', 'In watts, for the power bill estimate. Empty uses the default (5 W).'],
    EXPECTED: ['Expected hashrate per worker', 'Shows up on the dashboard even when the pool hides the worker. Use 0 to hide a worker set in .env; empty relies on the pool or proxy.'],
    CUBE_IP: ['Cube IP', 'Empty turns the cube scoreboard off.'],
    TELEGRAM_BOT_TOKEN: ['Bot token', 'Create the bot with @BotFather (/newbot) and paste the token here.'],
    TELEGRAM_CHAT_ID: ['Chat id', 'Send /start to the bot after saving the token: it replies with the id. Several: comma separated.'],
    TELEGRAM_DAILY: ['Daily summary', 'Hour of the summary (0 to 23). Empty turns it off.'],
    TELEGRAM_PERSONAL: ['Alert personal records', 'Besides the farm record, alert each worker\'s record (chatty at first).'],
    TELEGRAM_PANEL_URL: ['Dashboard link', 'Shown in /status. E.g. http://odroid:3000 (Tailscale).'],
    MQTT_URL: ['MQTT broker', 'Broker URL (e.g. mqtt://homeassistant.local:1883 or mqtts://host:8883). Empty turns it off.'],
    MQTT_USER: ['MQTT username', 'Username configured on the broker (Mosquitto / Home Assistant). Optional if anonymous access is allowed.'],
    MQTT_PASS: ['MQTT password', 'Password for the MQTT user.'],
    MQTT_TOPIC: ['Topic prefix', 'Default: homeminerproxy. Publishes homeassistant/sensor/homeminerproxy/... (Auto-Discovery) and <prefix>/state + <prefix>/event.'],
    TUYA_REGION: ['Tuya Cloud region', 'Americas (us) covers the US and Brazil. Change only if your iot.tuya.com project is in another region (eu, cn, in).'],
    TUYA_CLIENT_ID: ['Access ID (Client ID)', 'From your Cloud project at iot.tuya.com (linked to the SmartLife app via QR code). Empty turns it off.'],
    TUYA_SECRET: ['Access Secret (Client Secret)', 'Secret key from your iot.tuya.com project.'],
    TUYA_PLUGS: ['SmartLife plugs & devices', 'Add as many smart plugs or devices from your SmartLife account as you want. For each one: Name, Device ID (Virtual ID in the SmartLife app), linked miner (or "Monitor only") and optional watchdog minutes (min 5).'],
    TUYA_DEVICE_ID: ['Plug Device ID', 'In the SmartLife app: tap the plug → ✏️ icon at top right → Device Information → Virtual ID.'],
    TUYA_WORKER: ['Device plugged in', 'If set to a worker (e.g. bitaxe), the plug\'s live Watts are used for that worker. "Monitor only" shows the reading on the dashboard without adding it to the miners\' power bill.'],
    TUYA_WATCHDOG_MIN: ['Auto-reboot plug when stopped (min)', 'If the linked worker is stopped for this many minutes (min 5), turns the plug off for 8s and back on. Empty disables.'],
    auto: 'Automatic', none: 'None', yes: 'Yes', tuyaNone: 'Monitor only (do not add to miners)', tuyaAll: 'Whole farm (*)',
    addWorkerPlaceholder: 'Worker name (e.g. bitaxe)', addWattsPlaceholder: 'W (e.g. 20)', addHrPlaceholder: 'Hashrate (e.g. 1.2)', addWorkerBtn: '+ Add worker',
    addPlugNamePlaceholder: 'Label (e.g. Bitaxe, Fan)', addPlugIdPlaceholder: 'Device ID (Virtual ID in app)', addPlugWdPlaceholder: 'Watchdog min', addPlugBtn: '+ Add plug',
    tokenSet: (t) => `set (ends in ${t}). Leave empty to keep it.`, tokenClear: 'Remove saved value',
    backupHelp: 'Download or restore records, history, workers and settings in a single JSON file (requires the PIN below).',
    backupDown: '⬇ Download backup', backupUp: '⬆ Restore backup…',
    backupOk: 'Backup downloaded.', restored: 'Backup restored! Restarting the dashboard…',
    pin: 'PIN', pinHelp: 'The SETTINGS_PIN in /etc/mineracao.env (the installer creates it and shows it at the end).',
    noPin: 'To save from here, set SETTINGS_PIN in /etc/mineracao.env and restart the dashboard. Running install.sh again creates a PIN for you.',
    save: 'Save and restart', testCube: 'Test cube', testTg: 'Send test message', testMqtt: 'Test MQTT', testTuya: 'Test plug',
    saved: 'Saved! Restarting the dashboard…', back2: 'Done. Going back to the dashboard…', nothing: 'Nothing changed.',
    cubeOk: 'The cube answered.', cubeFail: 'The cube did not answer at that IP.',
    tgOk: 'Message sent. Check Telegram.', tgFail: (e) => `Not sent: ${e}`, tgTest: '✅ Mining farm dashboard test: the bot is working!',
    mqttOk: 'Connected to the MQTT broker!', mqttFail: (e) => `MQTT failed: ${e}`,
    tuyaOk: (s) => `Plug answered: ${s}`, tuyaFail: (e) => `Plug failed: ${e}`,
    err: { address: 'Invalid address', option: 'Invalid option', price: 'Use a number from 0 to 100', watts: 'Use watts from 0 to 100000', expected: 'Invalid hashrate (e.g. 1.2 TH/s or 350 kH/s)', backup: 'Invalid backup file', name: 'Invalid name', host: 'Invalid IP', token: 'This does not look like a Telegram token. Tap 👁 to check it: it should be just the token, like 1234567890:AAH… (digits, a colon and about 35 characters). The browser may have filled in a saved password instead.', chatid: 'The chat id is a number (e.g. 8983008026), not the bot name. Send /start to the bot: it replies with the number.', nochat: 'Telegram could not find that chat. Open the bot in Telegram and tap Start (/start): bots can only write to people who talked to them first. Also check that the id is the number the bot replied with.', hour: 'Hour from 0 to 23', url: 'Start with http:// or https://', mqtturl: 'Use mqtt://host:1883 or mqtts://host:8883', mqtttopic: 'Invalid prefix (use letters, digits, _, - or /)', mqttauth: 'Username or password rejected by broker', tuyaid: 'Invalid ID (8 to 64 alphanumeric chars)', tuyasecret: 'Invalid Access Secret', tuyaplugs: 'Invalid smart plug list', tuyamissing: 'Fill in Access ID, Access Secret and Device ID', tuyaauth: 'Credentials rejected by Tuya Cloud', watchdog: 'Use 5 to 1440 minutes (or empty to disable)', wrong: 'Wrong PIN', locked: 'Too many wrong tries. Wait 15 minutes.', nopin: 'SETTINGS_PIN is not set', missing: 'Fill in the token and the chat id', fix: 'Fix the highlighted fields.' },
  },
};

const htmlEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(lang, hasPin, theme) {
  const S = T[lang] || T.en;
  const activeTheme = normTheme(theme || process.env.THEME);
  const field = (f) => {
    const [label, help] = S[f.key];
    let input;
    if (f.type === 'theme') {
      input = `<select name="${f.key}" hidden>` + f.options.map((o) => `<option value="${o}">${o || 'obsidian'}</option>`).join('') + '</select>' +
        `<div class="tcards" id="theme_cards">` + S.themes.map((t) => {
          const dots = t.colors.map((c) => `<i style="background:${c}"></i>`).join('');
          return `<button type="button" class="tcard${t.id === activeTheme ? ' active' : ''}" data-theme-opt="${t.id}">` +
            `<span class="tswatch">${dots}</span><span class="tname">${htmlEsc(t.name)}</span><span class="tsub">${htmlEsc(t.sub)}</span></button>`;
        }).join('') + `</div>`;
    } else if (f.type === 'select') {
      input = `<select name="${f.key}">` + f.options.map((o) => `<option value="${o}">${o === '' ? S.auto : o}</option>`).join('') + '</select>';
    } else if (f.type === 'worker') {
      input = `<select name="${f.key}" data-workers="1"><option value="">${S.none}</option></select>`;
    } else if (f.type === 'tuyaworker') {
      input = `<select name="${f.key}" data-workers="2"><option value="">${S.tuyaNone}</option><option value="*">${S.tuyaAll}</option></select>`;
    } else if (f.type === 'workers') {
      input = `<div class="checks" data-name="${f.key}"></div>`;
    } else if (f.type === 'watts') {
      input = `<div class="wmap" data-map="WATTS"></div>`;
    } else if (f.type === 'expected') {
      input = `<div class="wmap wmap-exp" data-map="EXPECTED"></div>` +
        `<div class="addw"><input type="text" id="new_worker" placeholder="${htmlEsc(S.addWorkerPlaceholder)}" autocomplete="off" spellcheck="false">` +
        `<input type="text" id="new_worker_watts" class="addw-w" inputmode="decimal" placeholder="${htmlEsc(S.addWattsPlaceholder)}" autocomplete="off">` +
        `<input type="text" id="new_worker_hr" class="addw-hr" inputmode="decimal" placeholder="${htmlEsc(S.addHrPlaceholder)}" autocomplete="off">` +
        `<select id="new_worker_unit" class="addw-u"><option value="">H/s</option><option value="k">kH/s</option><option value="M">MH/s</option><option value="G">GH/s</option><option value="T" selected>TH/s</option><option value="P">PH/s</option></select>` +
        `<button type="button" class="ghost" id="add_worker_btn">${htmlEsc(S.addWorkerBtn)}</button></div>`;
    } else if (f.type === 'tuyaplugs') {
      input = `<div class="plist" id="plug_list"></div>` +
        `<div class="addw addp"><input type="text" id="new_plug_name" placeholder="${htmlEsc(S.addPlugNamePlaceholder)}" autocomplete="off" spellcheck="false">` +
        `<input type="text" id="new_plug_id" placeholder="${htmlEsc(S.addPlugIdPlaceholder)}" autocomplete="off" spellcheck="false">` +
        `<select id="new_plug_worker" data-workers="2"><option value="">${htmlEsc(S.tuyaNone)}</option><option value="*">${htmlEsc(S.tuyaAll)}</option></select>` +
        `<input type="text" id="new_plug_wd" class="addw-w" inputmode="numeric" maxlength="4" placeholder="${htmlEsc(S.addPlugWdPlaceholder)}" autocomplete="off">` +
        `<button type="button" class="ghost" id="add_plug_btn">${htmlEsc(S.addPlugBtn)}</button></div>`;
    } else if (f.type === 'bool') {
      input = `<label class="inline"><input type="checkbox" name="${f.key}"> ${S.yes}</label>`;
    } else if (f.type === 'secret') {
      input = `<div class="pw"><input type="password" name="${f.key}" autocomplete="new-password" spellcheck="false" autocapitalize="off"><button type="button" class="ghost eye" data-eye="${f.key}">👁</button></div><div class="hint" id="${f.key}_state"></div>` +
        `<label class="inline" id="${f.key}_clearbox" hidden><input type="checkbox" name="${f.key}_clear"> ${S.tokenClear}</label>`;
    } else {
      const extra = f.type === 'price' ? ' inputmode="decimal"' : f.type === 'hour' ? ' inputmode="numeric" maxlength="2"' : f.type === 'watchdog' ? ' inputmode="numeric" maxlength="4" placeholder="10"' : f.type === 'mqtturl' ? ' placeholder="mqtt://homeassistant.local:1883"' : f.type === 'mqtttopic' ? ' placeholder="homeminerproxy"' : '';
      input = `<input name="${f.key}"${extra} autocomplete="off" spellcheck="false">`;
    }
    const test = f.key === 'CUBE_IP' ? ` <button type="button" class="ghost" data-test="cube">${S.testCube}</button>`
      : f.key === 'TELEGRAM_CHAT_ID' ? ` <button type="button" class="ghost" data-test="telegram">${S.testTg}</button>`
      : f.key === 'MQTT_URL' ? ` <button type="button" class="ghost" data-test="mqtt">${S.testMqtt}</button>`
      : f.key === 'TUYA_DEVICE_ID' ? ` <button type="button" class="ghost" data-test="tuya">${S.testTuya}</button>` : '';
    const half = ['LANGUAGE', 'CURRENCY', 'POWER_PRICE_KWH', 'SHOW_WALLET', 'TELEGRAM_DAILY', 'TELEGRAM_PERSONAL', 'TUYA_REGION', 'TUYA_CLIENT_ID', 'MQTT_USER', 'MQTT_PASS'].includes(f.key) ? ' half' : '';
    const hideLegacy = ['TUYA_DEVICE_ID', 'TUYA_WORKER', 'TUYA_WATCHDOG_MIN'].includes(f.key) ? ' hidden' : '';
    return `<div class="f${half}" data-key="${f.key}"${hideLegacy}><label>${htmlEsc(label)}</label>${input}${test}<div class="hint">${htmlEsc(help)}</div><div class="ferr"></div></div>`;
  };
  const tabOrder = ['farm', 'miners', 'telegram', 'tuya', 'mqtt', 'cube', 'backup'];
  const tabBar = `<nav class="tabs" id="tabs">` + tabOrder.map((g, i) =>
    `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-tab="${g}"><span>${S.tabs[g]}</span><i class="tdot"></i></button>`).join('') + `</nav>`;
  const fieldGroups = ['farm', 'miners', 'cube', 'telegram', 'mqtt', 'tuya'].map((g) => `<fieldset class="tab-pane${g === 'farm' ? ' active' : ''}" data-pane="${g}"><legend>${S.groups[g]}</legend>${FIELDS.filter((f) => f.group === g).map(field).join('')}</fieldset>`).join('');
  const backupGroup = `<fieldset class="tab-pane" data-pane="backup"><legend>${S.groups.backup}</legend><div class="f"><div class="hint">${htmlEsc(S.backupHelp)}</div>` +
    `<div class="bbar"><button type="button" class="ghost" data-backup="export">${htmlEsc(S.backupDown)}</button>` +
    `<button type="button" class="ghost" data-backup="restore">${htmlEsc(S.backupUp)}</button>` +
    `<input type="file" id="backup_file" accept=".json,application/json" hidden></div></div></fieldset>`;
  const msgs = {
    saved: S.saved, back2: S.back2, nothing: S.nothing, cubeOk: S.cubeOk, cubeFail: S.cubeFail,
    tgOk: S.tgOk, tgFail: S.tgFail('%s'), mqttOk: S.mqttOk, mqttFail: S.mqttFail('%s'),
    tuyaOk: S.tuyaOk('%s'), tuyaFail: S.tuyaFail('%s'), tokenSet: S.tokenSet('%s'),
    tuyaNone: S.tuyaNone, tuyaAll: S.tuyaAll, testTuya: S.testTuya,
    backupOk: S.backupOk, restored: S.restored, err: S.err,
  };
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-br' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${S.title}</title>
<style>
  :root, body[data-theme="obsidian"] { --bg:#0e1117; --card:#171c26; --line:#252c3a; --txt:#e6e9ef; --dim:#8a93a6; --gold:#f2a900; --on-gold:#14161c; --gold-soft:rgba(242,169,0,.09); --ok:#3ecf8e; --warn:#e5534b; --shadow:none; --radius:12px; }
  body[data-theme="ocean"] { --bg:#0b111e; --card:#131c31; --line:#223254; --txt:#e2e8f0; --dim:#8ea0c2; --gold:#38bdf8; --on-gold:#081221; --gold-soft:rgba(56,189,248,.11); --ok:#34d399; --warn:#fb7185; --shadow:0 4px 18px rgba(0,0,0,.28); --radius:16px; }
  body[data-theme="latte"] { --bg:#f5f3ee; --card:#ffffff; --line:#e2ded5; --txt:#1c1b18; --dim:#666159; --gold:#d97706; --on-gold:#ffffff; --gold-soft:rgba(217,119,6,.10); --ok:#16a34a; --warn:#dc2626; --shadow:0 2px 10px rgba(28,27,24,.06); --radius:16px; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt); font-family:-apple-system, "Segoe UI", Roboto, sans-serif; padding:18px 16px 32px; max-width:840px; margin:0 auto; transition:background .2s, color .2s; }
  .top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:2px 0 14px; flex-wrap:wrap; }
  h1 { font-size:22px; font-weight:700; display:flex; align-items:center; gap:8px; }
  .back { color:var(--dim); font-size:13px; font-weight:500; text-decoration:none; padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); transition:border-color .15s, color .15s; }
  .back:hover { color:var(--gold); border-color:var(--gold); }
  .tabs { display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; margin-bottom:14px; scrollbar-width:thin; }
  .tab { background:var(--card); color:var(--dim); border:1px solid var(--line); border-radius:10px; padding:9px 13px; font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:7px; white-space:nowrap; transition:all .15s; }
  .tab:hover { color:var(--txt); border-color:var(--gold); }
  .tab.active { color:var(--gold); border-color:var(--gold); background:var(--gold-soft); }
  .tdot { width:7px; height:7px; border-radius:50%; display:none; }
  .tab.on .tdot { display:inline-block; background:var(--ok); box-shadow:0 0 6px rgba(62,207,142,.6); }
  .tab.err { border-color:var(--warn); color:var(--warn); }
  .tab.err .tdot { display:inline-block; background:var(--warn); box-shadow:0 0 6px rgba(229,83,75,.8); }
  fieldset { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:18px 18px 10px; margin-bottom:14px; transition:background .2s, border-color .2s; }
  .tcards { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin-top:4px; }
  @media (max-width:640px) { .tcards { grid-template-columns:1fr; } }
  .tcard { background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:12px; padding:12px; text-align:left; display:flex; flex-direction:column; gap:5px; cursor:pointer; transition:all .15s; font-weight:500; }
  .tcard:hover { border-color:var(--gold); }
  .tcard.active { border-color:var(--gold); background:var(--gold-soft); box-shadow:0 0 0 1px var(--gold); }
  .tswatch { display:inline-flex; gap:6px; margin-bottom:2px; }
  .tswatch i { width:16px; height:16px; border-radius:50%; border:1px solid rgba(128,128,128,.35); display:inline-block; }
  .tname { font-size:14px; font-weight:700; color:var(--txt); }
  .tcard.active .tname { color:var(--gold); }
  .tsub { font-size:11px; color:var(--dim); line-height:1.35; }
  fieldset.tab-pane { display:none; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px 16px; }
  fieldset.tab-pane.active { display:grid; }
  legend { color:var(--gold); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; padding:0 6px; }
  .f { grid-column:1 / -1; margin-bottom:2px; }
  .f.half { grid-column:span 1; }
  @media (max-width:580px) { .f.half { grid-column:1 / -1; } }
  .f > label { display:block; font-size:14px; margin-bottom:5px; font-weight:600; }
  input:not([type=checkbox]), select { width:100%; max-width:100%; background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:9px 10px; font-size:15px; font-family:inherit; }
  input:not([type=checkbox]):focus, select:focus { outline:none; border-color:var(--gold); }
  input[name=BTC_ADDRESS], input[type=password] { font-family:ui-monospace, Menlo, monospace; font-size:13px; }
  .f.bad input, .f.bad select { border-color:var(--warn); }
  .hint { color:var(--dim); font-size:12px; margin-top:5px; line-height:1.4; } .ferr { color:var(--warn); font-size:12px; margin-top:3px; }
  .checks { display:flex; flex-wrap:wrap; gap:6px 14px; } .inline { display:inline-flex; align-items:center; gap:6px; font-size:14px; margin-top:6px; cursor:pointer; }
  .wmap { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:8px; margin-top:4px; }
  .wmap-exp { grid-template-columns:repeat(auto-fill, minmax(310px, 1fr)); }
  .wrow { display:flex; align-items:center; gap:6px; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
  .wrow span { font-size:13px; font-family:ui-monospace, Menlo, monospace; flex:1; min-width:85px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .wrow input { width:84px; padding:5px 7px; font-size:14px; text-align:right; }
  .wrow select { width:78px; padding:5px 4px; font-size:13px; }
  .wrow em { font-style:normal; color:var(--dim); font-size:12px; }
  .addw { display:flex; gap:6px; margin-top:10px; align-items:center; flex-wrap:wrap; }
  .addw #new_worker { flex:2; min-width:160px; padding:7px 9px; font-size:14px; }
  .addw .addw-w { width:92px; padding:7px 8px; font-size:14px; text-align:right; }
  .addw .addw-hr { width:125px; padding:7px 8px; font-size:14px; text-align:right; }
  .addw .addw-u { width:78px; padding:7px 4px; font-size:13px; }
  .addw button { margin:0; white-space:nowrap; }
  .plist { display:flex; flex-direction:column; gap:8px; margin-top:4px; }
  .prow { display:grid; grid-template-columns:minmax(110px,1fr) minmax(150px,1.4fr) minmax(150px,1.2fr) 74px auto auto; gap:6px; align-items:center; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:7px 9px; }
  .prow input, .prow select { padding:6px 8px; font-size:13px; }
  .prow .p-id { font-family:ui-monospace, Menlo, monospace; font-size:12px; }
  .prow .p-wd { text-align:right; }
  .prow button { margin:0; padding:6px 9px; font-size:12px; }
  .addp #new_plug_name { flex:1; min-width:130px; padding:7px 9px; font-size:14px; }
  .addp #new_plug_id { flex:1.4; min-width:170px; padding:7px 9px; font-size:13px; font-family:ui-monospace, Menlo, monospace; }
  .addp #new_plug_worker { flex:1.1; min-width:150px; padding:7px 8px; font-size:13px; }
  @media (max-width:640px) { .prow { grid-template-columns:1fr 1fr; } }
  .bbar { display:flex; gap:10px; flex-wrap:wrap; margin-top:8px; }
  button { background:var(--gold); color:var(--on-gold); border:0; border-radius:8px; padding:10px 16px; font-size:15px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--gold); border:1px solid var(--gold); padding:6px 10px; font-size:13px; font-weight:500; margin-top:8px; }
  button:disabled { opacity:.5; cursor:default; }
  .pin-card { position:sticky; bottom:10px; z-index:10; box-shadow:0 8px 28px rgba(0,0,0,.35); padding-bottom:14px; }
  .bar { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; } .bar .f { flex:1; min-width:160px; margin:0; }
  #msg { margin-top:10px; font-size:14px; min-height:20px; } #msg.ok { color:var(--ok); } #msg.bad { color:var(--warn); }
  [hidden] { display:none !important; }
  .pw { display:flex; gap:6px; } .pw input { flex:1; } .pw .eye { margin:0; padding:6px 10px; }
  .nopin { color:var(--warn); font-size:13px; line-height:1.5; }
</style></head><body data-theme="${activeTheme}">
<div class="top"><h1>⚙️ ${S.title}</h1><a class="back" href="/">${S.back}</a></div>
<form id="form" autocomplete="off">
${tabBar}
${fieldGroups}
${backupGroup}
<fieldset class="pin-card"><legend>${S.pin}</legend>
${hasPin ? `<div class="bar"><div class="f"><input type="password" name="pin" inputmode="numeric" autocomplete="one-time-code"><div class="hint">${S.pinHelp}</div></div><button type="submit" id="save">${S.save}</button></div>` : `<p class="nopin">${S.noPin}</p>`}
<div id="msg"></div>
</fieldset>
</form>
<script>
const M = ${JSON.stringify(msgs)};
const UNITS = [['', 'H/s', 1], ['k', 'kH/s', 1e3], ['M', 'MH/s', 1e6], ['G', 'GH/s', 1e9], ['T', 'TH/s', 1e12], ['P', 'PH/s', 1e15]];
const form = document.getElementById('form'), msg = document.getElementById('msg');
const say = (t, ok) => { msg.textContent = t; msg.className = ok ? 'ok' : 'bad'; };
const el = (n) => form.elements[n];
let workers = [], stateValues = { ALARM_IGNORE: [], WATTS: {}, EXPECTED: {}, TUYA_PLUGS: [] }, secretSet = {};

function selectTab(id) {
  if (!form.querySelector('.tab-pane[data-pane="' + id + '"]')) return;
  for (const b of form.querySelectorAll('.tab[data-tab]')) b.classList.toggle('active', b.dataset.tab === id);
  for (const p of form.querySelectorAll('.tab-pane[data-pane]')) p.classList.toggle('active', p.dataset.pane === id);
  if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', '#' + id);
}
for (const b of form.querySelectorAll('.tab[data-tab]')) {
  b.addEventListener('click', () => selectTab(b.dataset.tab));
}
if (typeof location !== 'undefined' && location.hash) selectTab(location.hash.slice(1));

function setThemeUI(val) {
  const th = ['obsidian', 'ocean', 'latte'].includes(val) ? val : 'obsidian';
  const sel = el('THEME');
  if (sel) sel.value = val || '';
  if (typeof document !== 'undefined' && document.body) document.body.dataset.theme = th;
  for (const c of form.querySelectorAll('.tcard[data-theme-opt]')) {
    c.classList.toggle('active', c.dataset.themeOpt === th);
  }
}
for (const c of form.querySelectorAll('.tcard[data-theme-opt]')) {
  c.addEventListener('click', () => setThemeUI(c.dataset.themeOpt));
}

function updateTabDots() {
  const hasVal = (k) => Boolean((el(k) && el(k).value && el(k).value.trim()) || secretSet[k]);
  const hasPlugs = (stateValues.TUYA_PLUGS && stateValues.TUYA_PLUGS.length > 0) || hasVal('TUYA_DEVICE_ID');
  const activeMap = {
    farm: hasVal('BTC_ADDRESS'),
    miners: workers.length > 0,
    cube: hasVal('CUBE_IP'),
    telegram: hasVal('TELEGRAM_CHAT_ID') || hasVal('TELEGRAM_BOT_TOKEN'),
    mqtt: hasVal('MQTT_URL'),
    tuya: hasPlugs && hasVal('TUYA_CLIENT_ID'),
  };
  for (const b of form.querySelectorAll('.tab[data-tab]')) {
    b.classList.toggle('on', !!activeMap[b.dataset.tab]);
  }
}
form.addEventListener('input', updateTabDots);

function splitHr(n) {
  if (n === undefined || n === null || n === '') return ['', 'M'];
  const num = Number(n);
  if (!Number.isFinite(num) || num === 0) return [num === 0 ? '0' : '', 'H/s' ? '' : ''];
  let idx = 0;
  for (let i = UNITS.length - 1; i >= 0; i--) { if (num >= UNITS[i][2]) { idx = i; break; } }
  const val = Number((num / UNITS[idx][2]).toPrecision(6));
  return [String(val), UNITS[idx][0]];
}

function renderWorkerControls() {
  for (const s of form.querySelectorAll('select[data-workers]')) {
    const cur = s.value;
    const keep = Number(s.dataset.workers) || 1;
    while (s.options.length > keep) s.remove(keep);
    for (const w of workers) s.add(new Option(w, w));
    if (cur && ![...s.options].some((o) => o.value === cur)) s.add(new Option(cur, cur));
    s.value = cur;
  }
  for (const box of form.querySelectorAll('.checks')) {
    const checked = new Set(stateValues[box.dataset.name] || []);
    box.replaceChildren();
    for (const w of workers) {
      const lbl = document.createElement('label');
      lbl.className = 'inline';
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.value = w;
      inp.checked = checked.has(w);
      inp.addEventListener('change', () => {
        stateValues[box.dataset.name] = [...box.querySelectorAll('input:checked')].map((i) => i.value);
      });
      lbl.appendChild(inp);
      lbl.appendChild(document.createTextNode(' ' + w));
      box.appendChild(lbl);
    }
  }
  const wBox = form.querySelector('.wmap[data-map="WATTS"]');
  if (wBox) {
    wBox.replaceChildren();
    for (const w of workers) {
      const row = document.createElement('div');
      row.className = 'wrow';
      row.dataset.worker = w;
      const name = document.createElement('span');
      name.textContent = w;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.inputMode = 'decimal';
      inp.placeholder = '5';
      inp.value = stateValues.WATTS && stateValues.WATTS[w] !== undefined ? String(stateValues.WATTS[w]) : '';
      inp.addEventListener('input', () => { stateValues.WATTS[w] = inp.value; });
      const unit = document.createElement('em');
      unit.textContent = 'W';
      row.append(name, inp, unit);
      wBox.appendChild(row);
    }
  }
  const eBox = form.querySelector('.wmap[data-map="EXPECTED"]');
  if (eBox) {
    eBox.replaceChildren();
    for (const w of workers) {
      const row = document.createElement('div');
      row.className = 'wrow';
      row.dataset.worker = w;
      const name = document.createElement('span');
      name.textContent = w;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.inputMode = 'decimal';
      const sel = document.createElement('select');
      for (const [u, label] of UNITS) sel.add(new Option(label, u));
      const raw = stateValues.EXPECTED ? stateValues.EXPECTED[w] : undefined;
      if (typeof raw === 'number') {
        const [numStr, u] = splitHr(raw);
        inp.value = numStr;
        sel.value = u;
      } else if (typeof raw === 'string' && raw) {
        const m = /^([\\d.,]+)\\s*([kmgtpe]?)/i.exec(raw.trim());
        inp.value = m ? m[1] : raw;
        sel.value = m && m[2] ? UNITS.find((x) => x[0].toLowerCase() === m[2].toLowerCase())[0] : 'M';
      } else {
        sel.value = 'M';
      }
      const sync = () => {
        const t = inp.value.trim();
        stateValues.EXPECTED[w] = t === '' ? '' : (t === '0' ? '0' : t + sel.value);
      };
      inp.addEventListener('input', sync);
      sel.addEventListener('change', sync);
      row.append(name, inp, sel);
      eBox.appendChild(row);
    }
  }
  renderPlugs();
}

async function testPlugById(devId, btn) {
  if (btn) btn.disabled = true;
  try {
    const v = values();
    v.TUYA_DEVICE_ID = devId;
    const r = await post('/api/config/test', { pin: pin(), what: 'tuya', values: v });
    showErrors(r.errors || {});
    if (r.error) say(M.err[r.error] || r.error, false);
    else if (r.ok && r.status) {
      const parts = [r.status.on === false ? 'OFF' : 'ON'];
      if (r.status.watts != null) parts.push(r.status.watts + ' W');
      if (r.status.volts != null) parts.push(r.status.volts + ' V');
      if (r.status.currentMa != null) parts.push(r.status.currentMa + ' mA');
      say(M.tuyaOk.replace('%s', parts.join(' · ')), true);
    } else {
      say(M.tuyaFail.replace('%s', M.err[r.detail] || r.detail || ''), false);
    }
  } finally { if (btn) btn.disabled = false; }
}

function renderPlugs() {
  const box = document.getElementById('plug_list');
  if (!box) return;
  box.replaceChildren();
  const list = stateValues.TUYA_PLUGS || [];
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'prow';
    const nInp = document.createElement('input');
    nInp.type = 'text';
    nInp.value = p.name || '';
    nInp.placeholder = 'Tomada ' + (idx + 1);
    nInp.addEventListener('input', () => { p.name = nInp.value; });
    const idInp = document.createElement('input');
    idInp.type = 'text';
    idInp.className = 'p-id';
    idInp.value = p.deviceId || '';
    idInp.addEventListener('input', () => { p.deviceId = idInp.value.trim(); });
    const wSel = document.createElement('select');
    wSel.add(new Option(M.tuyaNone, ''));
    wSel.add(new Option(M.tuyaAll, '*'));
    for (const w of workers) wSel.add(new Option(w, w));
    if (p.worker && ![...wSel.options].some((o) => o.value === p.worker)) wSel.add(new Option(p.worker, p.worker));
    wSel.value = p.worker || '';
    wSel.addEventListener('change', () => { p.worker = wSel.value; });
    const wdInp = document.createElement('input');
    wdInp.type = 'text';
    wdInp.className = 'p-wd';
    wdInp.inputMode = 'numeric';
    wdInp.maxLength = 4;
    wdInp.placeholder = 'min';
    wdInp.value = p.watchdogMin ? String(p.watchdogMin) : '';
    wdInp.addEventListener('input', () => { p.watchdogMin = wdInp.value.trim() ? Number(wdInp.value.trim()) : 0; });
    const tBtn = document.createElement('button');
    tBtn.type = 'button';
    tBtn.className = 'ghost';
    tBtn.textContent = M.testTuya;
    tBtn.addEventListener('click', () => testPlugById(idInp.value.trim(), tBtn));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ghost';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      stateValues.TUYA_PLUGS.splice(idx, 1);
      renderPlugs();
      updateTabDots();
    });
    row.append(nInp, idInp, wSel, wdInp, tBtn, delBtn);
    box.appendChild(row);
  });
}

fetch('/api/config').then((r) => r.json()).then((c) => {
  const exp = (c.values && c.values.EXPECTED) || {};
  const extra = new Set([...(c.workers || []), ...Object.keys(exp).filter((k) => exp[k] > 0)]);
  workers = [...extra].sort((a, b) => a.localeCompare(b));
  stateValues.ALARM_IGNORE = (c.values && c.values.ALARM_IGNORE) || [];
  stateValues.WATTS = Object.assign({}, (c.values && c.values.WATTS) || {});
  stateValues.EXPECTED = Object.assign({}, (c.values && c.values.EXPECTED) || {});
  stateValues.TUYA_PLUGS = Array.isArray(c.values && c.values.TUYA_PLUGS) ? c.values.TUYA_PLUGS.map((p) => Object.assign({}, p)) : [];
  renderWorkerControls();
  for (const [k, v] of Object.entries(c.values)) {
    if (k === 'ALARM_IGNORE' || k === 'WATTS' || k === 'EXPECTED' || k === 'TUYA_PLUGS') continue;
    const e = el(k); if (!e) continue;
    if (e.type === 'checkbox') e.checked = !!v;
    else if (e.type === 'password') { secretSet[k] = !!(v && v.set); document.getElementById(k + '_state').textContent = v.set ? M.tokenSet.replace('%s', v.tail) : ''; document.getElementById(k + '_clearbox').hidden = !v.set; }
    else if (e.tagName === 'SELECT' && v && ![...e.options].some((o) => o.value === v)) { e.add(new Option(v, v)); e.value = v; }
    else e.value = v;
  }
  setThemeUI(c.values && c.values.THEME);
  updateTabDots();
});

const addPlugBtn = document.getElementById('add_plug_btn'), newPlugName = document.getElementById('new_plug_name');
const newPlugId = document.getElementById('new_plug_id'), newPlugWorker = document.getElementById('new_plug_worker'), newPlugWd = document.getElementById('new_plug_wd');
if (addPlugBtn && newPlugId) {
  const addP = () => {
    const devId = newPlugId.value.trim();
    if (!devId) return;
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(devId)) { say(M.err.tuyaid, false); return; }
    const w = newPlugWorker ? newPlugWorker.value : '';
    const n = (newPlugName ? newPlugName.value.trim() : '') || (w && w !== '*' ? w : 'Tomada ' + ((stateValues.TUYA_PLUGS || []).length + 1));
    const wdRaw = newPlugWd ? newPlugWd.value.trim() : '';
    const wd = wdRaw ? Number(wdRaw) : 0;
    if (wdRaw && (!Number.isInteger(wd) || wd < 5 || wd > 1440)) { say(M.err.watchdog, false); return; }
    stateValues.TUYA_PLUGS = (stateValues.TUYA_PLUGS || []).filter((x) => x.deviceId !== devId);
    stateValues.TUYA_PLUGS.push({ name: n, deviceId: devId, worker: w, watchdogMin: wd });
    if (newPlugName) newPlugName.value = '';
    newPlugId.value = '';
    if (newPlugWorker) newPlugWorker.value = '';
    if (newPlugWd) newPlugWd.value = '';
    renderPlugs();
    updateTabDots();
  };
  addPlugBtn.addEventListener('click', addP);
  for (const x of [newPlugName, newPlugId, newPlugWd].filter(Boolean)) {
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addP(); } });
  }
}

const addBtn = document.getElementById('add_worker_btn'), addInp = document.getElementById('new_worker');
const addWInp = document.getElementById('new_worker_watts'), addHrInp = document.getElementById('new_worker_hr'), addUInp = document.getElementById('new_worker_unit');
if (addBtn && addInp) {
  const addW = () => {
    const n = addInp.value.trim();
    if (!n) return;
    if (!/^[\\w.\\-]{1,64}$/.test(n)) { say(M.err.name, false); return; }
    const wVal = addWInp ? addWInp.value.trim() : '';
    const hrVal = addHrInp ? addHrInp.value.trim() : '';
    const uVal = addUInp ? addUInp.value : 'T';
    if (wVal !== '') stateValues.WATTS[n] = wVal;
    if (hrVal !== '') stateValues.EXPECTED[n] = hrVal === '0' ? '0' : hrVal + uVal;
    if (!workers.includes(n)) { workers.push(n); workers.sort((a, b) => a.localeCompare(b)); }
    renderWorkerControls();
    updateTabDots();
    addInp.value = '';
    if (addWInp) addWInp.value = '';
    if (addHrInp) addHrInp.value = '';
  };
  addBtn.addEventListener('click', addW);
  for (const x of [addInp, addWInp, addHrInp].filter(Boolean)) {
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addW(); } });
  }
}

function values() {
  const out = {};
  for (const f of form.querySelectorAll('.f[data-key]')) {
    const k = f.dataset.key;
    if (k === 'ALARM_IGNORE') {
      const box = f.querySelector('.checks');
      out[k] = box ? [...box.querySelectorAll('input:checked')].map((i) => i.value) : [];
      continue;
    }
    if (k === 'WATTS') {
      const map = {};
      for (const row of f.querySelectorAll('.wrow')) {
        const v = row.querySelector('input').value.trim();
        if (v !== '') map[row.dataset.worker] = v;
      }
      out[k] = map;
      continue;
    }
    if (k === 'EXPECTED') {
      const map = {};
      for (const row of f.querySelectorAll('.wrow')) {
        const v = row.querySelector('input').value.trim();
        const u = row.querySelector('select').value;
        if (v !== '') map[row.dataset.worker] = v === '0' ? 0 : v + u;
      }
      out[k] = map;
      continue;
    }
    if (k === 'TUYA_PLUGS') {
      const plugs = (stateValues.TUYA_PLUGS || []).map((p) => Object.assign({}, p)).filter((p) => p.deviceId);
      const pendingId = newPlugId && newPlugId.value.trim();
      if (pendingId && !plugs.some((p) => p.deviceId === pendingId)) {
        const w = newPlugWorker ? newPlugWorker.value : '';
        const n = (newPlugName ? newPlugName.value.trim() : '') || (w && w !== '*' ? w : 'Tomada ' + (plugs.length + 1));
        const wd = newPlugWd && newPlugWd.value.trim() ? Number(newPlugWd.value.trim()) : 0;
        plugs.push({ name: n, deviceId: pendingId, worker: w, watchdogMin: wd });
      }
      out.TUYA_PLUGS = plugs;
      const first = plugs[0] || {};
      out.TUYA_DEVICE_ID = first.deviceId || '';
      out.TUYA_WORKER = first.worker || '';
      out.TUYA_WATCHDOG_MIN = first.watchdogMin ? String(first.watchdogMin) : '';
      continue;
    }
    if (k === 'TUYA_DEVICE_ID' || k === 'TUYA_WORKER' || k === 'TUYA_WATCHDOG_MIN') continue;
    const e = el(k);
    out[k] = e.type === 'checkbox' ? e.checked : e.value;
    if (el(k + '_clear')) out[k + '_clear'] = el(k + '_clear').checked;
  }
  return out;
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const pin = () => (el('pin') || {}).value || '';
function showErrors(errs) {
  let firstErrPane = null;
  for (const f of form.querySelectorAll('.f[data-key]')) {
    const e = errs[f.dataset.key];
    f.classList.toggle('bad', !!e);
    f.querySelector('.ferr').textContent = e ? M.err[e] || e : '';
    if (e && !firstErrPane) {
      const pane = f.closest('.tab-pane[data-pane]');
      if (pane) firstErrPane = pane.dataset.pane;
    }
  }
  for (const b of form.querySelectorAll('.tab[data-tab]')) {
    const pane = form.querySelector('.tab-pane[data-pane="' + b.dataset.tab + '"]');
    b.classList.toggle('err', !!(pane && pane.querySelector('.f.bad')));
  }
  if (firstErrPane) selectTab(firstErrPane);
}
async function waitRestartAndGo(message) {
  say(message, true);
  await new Promise((res) => setTimeout(res, 2500));
  for (let i = 0; i < 40; i++) { try { const x = await fetch('/api/widget', { cache: 'no-store' }); if (x.ok) break; } catch (_) {} await new Promise((res) => setTimeout(res, 1000)); }
  say(M.back2, true); setTimeout(() => { location.href = '/'; }, 800);
}
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const b = document.getElementById('save'); b.disabled = true; say('', true);
  try {
    const r = await post('/api/config', { pin: pin(), values: values() });
    showErrors(r.errors || {});
    if (r.error) return say(M.err[r.error] || r.error, false);
    if (!r.restart) return say(M.nothing, true);
    await waitRestartAndGo(M.saved);
  } catch (_) { say('?', false); } finally { b.disabled = false; }
});
for (const b of form.querySelectorAll('[data-eye]')) b.addEventListener('click', () => { const e = el(b.dataset.eye); e.type = e.type === 'password' ? 'text' : 'password'; });
for (const t of form.querySelectorAll('[data-test]')) t.addEventListener('click', async () => {
  t.disabled = true;
  try {
    const v = values();
    const r = await post('/api/config/test', { pin: pin(), what: t.dataset.test, values: v });
    showErrors(r.errors || {});
    if (r.error) say(M.err[r.error] || r.error, false);
    else if (t.dataset.test === 'cube') say(r.ok ? M.cubeOk : M.cubeFail, r.ok);
    else if (t.dataset.test === 'mqtt') say(r.ok ? M.mqttOk : M.mqttFail.replace('%s', M.err[r.detail] || r.detail || ''), r.ok);
    else if (t.dataset.test === 'tuya') {
      if (r.ok && r.status) {
        const parts = [r.status.on === false ? 'OFF' : 'ON'];
        if (r.status.watts != null) parts.push(r.status.watts + ' W');
        if (r.status.volts != null) parts.push(r.status.volts + ' V');
        if (r.status.currentMa != null) parts.push(r.status.currentMa + ' mA');
        say(M.tuyaOk.replace('%s', parts.join(' · ')), true);
      } else {
        say(M.tuyaFail.replace('%s', M.err[r.detail] || r.detail || ''), false);
      }
    }
    else say(r.ok ? M.tgOk : M.tgFail.replace('%s', M.err[r.detail] || r.detail || ''), r.ok);
  } finally { t.disabled = false; }
});
const expBtn = form.querySelector('[data-backup="export"]'), resBtn = form.querySelector('[data-backup="restore"]'), fileInp = document.getElementById('backup_file');
if (expBtn) expBtn.addEventListener('click', async () => {
  expBtn.disabled = true;
  try {
    const r = await post('/api/config/backup', { pin: pin() });
    if (r.error) return say(M.err[r.error] || r.error, false);
    const blob = new Blob([JSON.stringify(r.backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'homeminerproxy-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    say(M.backupOk, true);
  } catch (_) { say('?', false); } finally { expBtn.disabled = false; }
});
if (resBtn && fileInp) {
  resBtn.addEventListener('click', () => { fileInp.value = ''; fileInp.click(); });
  fileInp.addEventListener('change', async () => {
    const f = fileInp.files && fileInp.files[0];
    if (!f) return;
    resBtn.disabled = true;
    try {
      let parsed;
      try { parsed = JSON.parse(await f.text()); } catch (_) { return say(M.err.backup, false); }
      const r = await post('/api/config/restore', { pin: pin(), backup: parsed });
      if (r.error) return say(M.err[r.error] || r.error, false);
      await waitRestartAndGo(M.restored);
    } catch (_) { say('?', false); } finally { resBtn.disabled = false; }
  });
}
</script></body></html>`;
}

// ---------------------------------------------------------------- rotas HTTP
// Devolve true se tratou a requisição. ctx: { dataDir, lang, workers(), onSaved(), telegramApi }
function handle(req, res, ctx) {
  const url = req.url.split('?')[0];
  if (url !== '/config' && !url.startsWith('/api/config')) return false;
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(obj));
  };
  const pinEnv = (process.env.SETTINGS_PIN || '').trim();
  if (url === '/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    res.end(page(ctx.lang, !!pinEnv));
    return true;
  }
  if (url === '/api/config' && req.method === 'GET') {
    json(200, { values: current(), workers: ctx.workers(), pin: !!pinEnv });
    return true;
  }
  if (req.method !== 'POST' || !/^application\/json/.test(req.headers['content-type'] || '')) { json(405, { error: 'option' }); return true; }
  const maxBody = url === '/api/config/restore' ? 512000 : 50000;
  let body = '', tooLarge = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > maxBody) { tooLarge = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (tooLarge) return;
    let j;
    try { j = JSON.parse(body); } catch (_) { return json(400, { error: 'option' }); }
    const pin = checkPin(j.pin, pinEnv);
    if (pin !== 'ok') return json(pin === 'wrong' ? 403 : pin === 'locked' ? 429 : 409, { error: pin });
    const form = j.values && typeof j.values === 'object' ? j.values : {};
    const S = T[ctx.lang] || T.en;
    if (url === '/api/config/test') {
      if (j.what === 'cube') return json(200, { ok: await testCube(String(form.CUBE_IP || '').trim()) });
      if (j.what === 'telegram') {
        const ids = clean(FIELDS.find((f) => f.key === 'TELEGRAM_CHAT_ID'), form.TELEGRAM_CHAT_ID);
        if (ids.error || !ids.value) return json(400, { error: 'fix', errors: { TELEGRAM_CHAT_ID: 'chatid' } });
        const token = String(form.TELEGRAM_BOT_TOKEN || '').trim() || process.env.TELEGRAM_BOT_TOKEN || '';
        const r = await testTelegram(token, ids.value, S.tgTest, ctx.telegramApi);
        return json(200, { ok: r.ok, detail: /chat not found|bot can't initiate|blocked by the user/i.test(r.error || '') ? 'nochat' : r.error });
      }
      if (j.what === 'mqtt') {
        const u = clean(FIELDS.find((f) => f.key === 'MQTT_URL'), form.MQTT_URL);
        if (u.error || !u.value) return json(400, { error: 'fix', errors: { MQTT_URL: 'mqtturl' } });
        const tp = clean(FIELDS.find((f) => f.key === 'MQTT_TOPIC'), form.MQTT_TOPIC);
        if (tp.error) return json(400, { error: 'fix', errors: { MQTT_TOPIC: 'mqtttopic' } });
        const user = String(form.MQTT_USER == null ? (process.env.MQTT_USER || '') : form.MQTT_USER).trim();
        const pass = form.MQTT_PASS_clear ? '' : (String(form.MQTT_PASS || '').trim() || process.env.MQTT_PASS || '');
        const r = await testBroker(u.value, user, pass, tp.value || process.env.MQTT_TOPIC || 'homeminerproxy');
        return json(200, { ok: r.ok, detail: r.error === 'auth' ? 'mqttauth' : r.error });
      }
      if (j.what === 'tuya') {
        const clientId = String(form.TUYA_CLIENT_ID == null ? (process.env.TUYA_CLIENT_ID || '') : form.TUYA_CLIENT_ID).trim();
        const secret = form.TUYA_SECRET_clear ? '' : (String(form.TUYA_SECRET || '').trim() || process.env.TUYA_SECRET || '');
        const deviceId = String(form.TUYA_DEVICE_ID == null ? (process.env.TUYA_DEVICE_ID || '') : form.TUYA_DEVICE_ID).trim();
        const region = String(form.TUYA_REGION == null ? (process.env.TUYA_REGION || 'us') : form.TUYA_REGION).trim() || 'us';
        const r = await testPlug({ clientId, secret, deviceId, region, apiBase: ctx.tuyaApi });
        return json(200, { ok: r.ok, status: r.status, detail: r.error });
      }
      return json(400, { error: 'option' });
    }
    if (url === '/api/config/backup') {
      return json(200, { ok: true, backup: exportBackup(ctx.dataDir) });
    }
    if (url === '/api/config/restore') {
      const r = restoreBackup(ctx.dataDir, j.backup);
      if (r.error) return json(400, { error: r.error });
      json(200, { ok: true, restart: true, restored: r.restored });
      if (ctx.onSaved) setTimeout(ctx.onSaved, 400);
      return undefined;
    }
    if (url === '/api/config') {
      const before = JSON.stringify(readOverlay(ctx.dataDir));
      const { errors, overlay } = merge(ctx.dataDir, form);
      if (Object.keys(errors).length) return json(400, { error: 'fix', errors });
      if (JSON.stringify(overlay) === before) return json(200, { ok: true, restart: false });
      try { save(ctx.dataDir, overlay); } catch (e) { return json(500, { error: e.message }); }
      json(200, { ok: true, restart: true });
      if (ctx.onSaved) setTimeout(ctx.onSaved, 400);
      return undefined;
    }
    return json(404, { error: 'option' });
  });
  return true;
}

module.exports = { THEMES, normTheme, FIELDS, BACKUP_FILES, applyOverlay, readOverlay, parseHr, clean, current, merge, save, exportBackup, restoreBackup, checkPin, resetPinFails, testCube, testTelegram, page, handle };
