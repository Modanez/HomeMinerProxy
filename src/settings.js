// Tela de configurações: edita, pelo navegador, parte do que fica em /etc/mineracao.env.
// O que é salvo aqui vai para DATA_DIR/settings.json e vale por cima do .env (o .env continua
// valendo para o que não foi mudado na tela). Salvar exige o SETTINGS_PIN, e o painel reinicia
// sozinho para aplicar (systemd e Docker sobem ele de novo). O cubo percebe a mudança e reinicia também.

const fs = require('fs');
// portas de fábrica do proxy (src/proxy.js), para o guia quando o proxy não responde
const DEFAULT_ROUTES = [
  { listen: 3333, label: 'public-pool', host: 'public-pool.io', backups: ['ckpool solo'] },
  { listen: 3334, label: 'ckpool solo', host: 'solo.ckpool.org', backups: ['ckpool solo EU'] },
  { listen: 3335, label: 'nerdminers', host: 'pool.nerdminers.org', backups: ['bitronics'] },
  { listen: 3340, label: 'bitronics', host: 'pool.bitronics.store', backups: ['nerdminers'] },
  { listen: 3337, label: 'OCEAN', host: 'mine.ocean.xyz', backups: [] },
  { listen: 3338, label: 'atlaspool', host: 'solo.atlaspool.io', backups: ['ckpool solo'] },
  { listen: 3339, label: 'ckpool solo EU', host: 'eusolo.ckpool.org', backups: ['ckpool solo'] },
];
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { parseBroker, cleanTopic, testBroker } = require('./mqtt');
const { ID_RE: TUYA_ID_RE, SECRET_RE: TUYA_SECRET_RE, normalizePlugs, testPlug } = require('./tuya');
const { testSonoff } = require('./sonoff');

const THEMES = ['obsidian', 'ocean', 'neon', 'latte'];
function normTheme(v) {
  const s = String(v || '').trim().toLowerCase();
  return THEMES.includes(s) ? s : 'obsidian';
}

const FIELDS = [
  { key: 'BTC_ADDRESS', group: 'farm', type: 'address', required: true },
  { key: 'THEME', group: 'farm', type: 'theme', options: ['', 'obsidian', 'ocean', 'neon', 'latte'] },
  { key: 'LANGUAGE', group: 'farm', type: 'select', options: ['', 'pt-BR', 'en'] },
  { key: 'CURRENCY', group: 'farm', type: 'select', options: ['', 'BRL', 'USD'] },
  { key: 'TEMP_UNIT', group: 'farm', type: 'select', options: ['', 'C', 'F'], hideEmpty: true, labels: { C: '°C (Celsius)', F: '°F (Fahrenheit)' } },   // vazio = °C
  { key: 'POWER_PRICE_KWH', group: 'farm', type: 'price', alias: 'TARIFA_KWH' },
  { key: 'SHOW_WALLET', group: 'farm', type: 'bool', unset: '1' },
  { key: 'SHOW_DONATE', group: 'farm', type: 'bool', unset: '1' },
  { key: 'LOCAL_WORKER', group: 'miners', type: 'worker' },
  { key: 'LOCAL_MINER', group: 'miners', type: 'bool' },
  { key: 'MINER_THREADS', group: 'miners', type: 'threads' },
  { key: 'ALARM_IGNORE', group: 'miners', type: 'workers' },
  { key: 'WATTS', group: 'miners', type: 'watts' },
  { key: 'EXPECTED', group: 'miners', type: 'expected' },
  { key: 'BITAXES', group: 'miners', type: 'bitaxes' },
  { key: 'BITAXE_TEMP_MAX', group: 'miners', type: 'range', min: 40, max: 90, temp: true },
  { key: 'BITAXE_VR_MAX', group: 'miners', type: 'range', min: 50, max: 110, temp: true },
  { key: 'BITAXE_HASH_MIN', group: 'miners', type: 'range', min: 10, max: 100 },
  { key: 'CUBE_IP', group: 'cube', type: 'host' },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', type: 'secret' },
  { key: 'TELEGRAM_CHAT_ID', group: 'telegram', type: 'chatids' },
  { key: 'TELEGRAM_DAILY', group: 'telegram', type: 'hour', unset: '21' },
  { key: 'TELEGRAM_PERSONAL', group: 'telegram', type: 'bool' },
  { key: 'TELEGRAM_BACKUP', group: 'telegram', type: 'bool' },
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

// PIN criado pelo assistente de primeira configuração (fica fora do settings.json e do backup)
const pinFileOf = (dataDir) => path.join(dataDir, 'pin.json');
function savePin(dataDir, pin) {
  const p = pinFileOf(dataDir), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ pin: String(pin) }), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function loadPin(dataDir) {
  try { const j = JSON.parse(fs.readFileSync(pinFileOf(dataDir), 'utf8')); return j && /^\d{6,12}$/.test(String(j.pin)) ? String(j.pin) : ''; } catch (_) { return ''; }
}

// Chamado antes de o painel ler as variáveis: aplica os valores salvos na tela por cima do .env.
function applyOverlay(dataDir, env = process.env) {
  if (!String(env.SETTINGS_PIN || '').trim()) { const p = loadPin(dataDir); if (p) env.SETTINGS_PIN = p; }   // o do .env tem prioridade
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
function clean(field, raw, opts = {}) {
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
    case 'bitaxes': {
      const list = require('./bitaxe').parseList(v);
      return list ? { value: list.map((b) => `${b.name}=${b.host}`).join(', ') } : { error: 'bitaxes' };
    }
    case 'range': {
      if (v === '') return { value: '' };
      const n = Number(String(v).replace(',', '.'));
      // limites de temperatura valem na unidade escolhida (TEMP_UNIT): a faixa em °C vira °F
      const f = field.temp && String(opts.tempUnit || '').toUpperCase() === 'F';
      const lo = f ? field.min * 9 / 5 + 32 : field.min, hi = f ? field.max * 9 / 5 + 32 : field.max;
      return Number.isFinite(n) && n >= lo && n <= hi ? { value: String(n) } : { error: 'range' };
    }
    case 'threads': {
      if (v === '') return { value: '' };
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 256 ? { value: String(n) } : { error: 'threads' };
    }
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
    const r = clean(f, form[f.key], { tempUnit: 'TEMP_UNIT' in form ? form.TEMP_UNIT : (ov.TEMP_UNIT ?? env.TEMP_UNIT) });
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
      const r = clean(f, v, { tempUnit: d.settings.TEMP_UNIT });
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
    groups: { discover: 'Descobrir mineradores na rede', farm: 'Fazenda', miners: 'Mineradores', cube: 'Cubo GeekMagic', telegram: 'Bot do Telegram', mqtt: 'Home Assistant / MQTT', tuya: 'Tomadas inteligentes (SmartLife / Tuya e Sonoff)', net: 'Rede', backup: 'Backup e restauração' },
    navGroups: { general: 'Geral', integrations: 'Integrações', system: 'Sistema' },
    tabDesc: { discover: 'Procura mineradores na rede de casa e diz quais já mineram pelo proxy.', farm: 'Endereço de bitcoin, idioma, moeda, preço da energia e aparência do painel.', miners: 'Portas do proxy, minerador local, Bitaxe, consumo e hashrate esperado de cada worker.',
      telegram: 'Bot com alertas, resumo diário, backup semanal e comandos.', tuya: 'Tomadas SmartLife/Tuya e Sonoff: consumo real e religar mineradores.',
      mqtt: 'Sensores da fazenda no Home Assistant pelo MQTT.', cube: 'Placar da fazenda no cubo GeekMagic.', net: 'Wi-Fi, acesso de fora de casa (Tailscale) e SSH deste servidor.',
      backup: 'Versão instalada, atualização e cópia de segurança da configuração.' },
    tabs: { discover: '🔍 Descobrir', farm: '🏠 Fazenda', miners: '⛏️ Mineradores', telegram: '✈️ Telegram', tuya: '🔌 Tomada', mqtt: '🏠 MQTT / HA', cube: '🧊 Cubo', net: '🌐 Rede', backup: '💾 Backup' },
    dsc: { help: 'Varre a rede de casa atrás de Bitaxe e NerdQaxe (AxeOS), ASICs com a API do cgminer (porta 4028, como Avalon Nano e Antminer) e placas ESP32 (NerdMiner). Leva até meio minuto.',
      run: 'Procurar na rede', running: 'Procurando na rede (até meio minuto)…', none: 'Nenhum minerador encontrado. Confira se estão na mesma rede (Wi-Fi ou cabo) que este servidor.',
      docker: 'Rodando em Docker: sem network_mode: host, a busca só enxerga a rede interna do Docker.', count: '%s aparelho(s) encontrado(s).',
      kinds: { axeos: 'AxeOS', cgminer: 'API cgminer', esp32: 'ESP32', proxy: 'aparelho conectado ao proxy' },
      via: { proxy: 'minerando pelo proxy', direct: 'minerando direto em %s', unknown: 'não aparece no proxy' }, worker: 'worker',
      esp: 'Provavelmente um NerdMiner, ou outro aparelho com ESP32 (uma tomada Sonoff, por exemplo).', espHint: 'Se for um NerdMiner, aponte para a porta do NerdMiner do proxy (veja Pools e portas na aba Mineradores).',
      cgHint: 'Para minerar pelo proxy, troque a pool na página deste ASIC (veja Pools e portas na aba Mineradores).', axeHint: 'Adicione ao painel, salve e use "Apontar para o proxy" em Ações nos Bitaxe.',
      registered: 'no painel como %s', add: 'Adicionar ao painel', added: 'Adicionado ao campo Bitaxe da aba Mineradores. Salve para começar a monitorar.', open: 'abrir ↗' },
    bx: { title: 'Ações nos Bitaxe', help: 'Reiniciar, identificar (a tela pisca), pausar e retomar, fan e apontar para o proxy. Overclock, firmware e Wi-Fi ficam no AxeOS.',
      none: 'Cadastre os Bitaxe no campo acima e salve para aparecerem aqui.', restart: 'Reiniciar', identify: 'Identificar', pause: 'Pausar', resume: 'Retomar', point: 'Apontar para o proxy',
      fanAuto: 'Fan automático, alvo', fanFixed: 'Fan fixo em', apply: 'Aplicar', confirm: 'Confirmar e reiniciar', cancel: 'Cancelar', offline: 'sem resposta', paused: 'pausado',
      from: 'Hoje', to: 'Vai ficar', backupLbl: 'reserva', same: 'Já aponta para o proxy.', done: 'Feito.', pointDone: 'Pool gravada e conferida; o Bitaxe está reiniciando.', last: 'Última ação' },
    pools: { title: 'Pools e portas', help: 'Cada porta do proxy leva a uma pool. Aponte cada minerador para a porta que combina com ele; se a pool cair, o proxy passa para a reserva sozinho.',
      factory: 'O proxy não respondeu: estas são as portas de fábrica.', backup: 'reserva', down: 'fora do ar · usando', ms: 'ms',
      use: { nerd: 'NerdMiner e ESP32: aceita os shares minúsculos deles', pub: 'cpuminer (PC, celular, Raspberry): sem taxa, dificuldade mínima 1', atlas: 'Bitaxe e ASICs: servidor em São Paulo, menor ping no Brasil (taxa 1,5%; não serve para ESP32)',
        ck: 'Bitaxe e ASICs: a pool solo mais conhecida (taxa 2%)', ckeu: 'Bitaxe e ASICs na Europa (taxa 2%)', ocean: 'Não é solo: a recompensa é dividida entre todos (pagamentos pequenos e regulares)', other: 'Pool configurada no PROXY_ROUTES' },
      howTitle: 'Como apontar os mineradores', server: 'Servidor', user: 'Usuário', userHint: 'seu endereço + ponto + um nome para o minerador', pass: 'Senha',
      bitaxe: 'Bitaxe (AxeOS → Pool)', bitaxeHow: 'Stratum URL: %h · Porta: %p · Usuário: %u · Senha: x. Em "Fallback", coloque solo.ckpool.org porta 3333 com o mesmo usuário.',
      nerd: 'NerdMiner / ESP32', nerdHow: 'Pool: %h · Porta: %p · Endereço: o seu endereço de bitcoin',
      cpu: 'cpuminer', cpuHow: 'minerd -a sha256d -o stratum+tcp://%h:%p -u %u -p x',
      noAddr: 'SEU_ENDERECO' },
    net: { pinFirst: 'Toque em "Ver estado" (pede o PIN).', refresh: '↻ Ver estado', none: 'Nada para configurar aqui neste aparelho (sem Wi-Fi gerenciável e sem Tailscale).',
      wifi: 'Wi-Fi', wifiNone: 'Sem adaptador Wi-Fi neste aparelho.', wifiOn: (s, ip) => `Conectado em ${s}${ip ? ' · IP ' + ip : ''}`, wifiOff: 'Wi-Fi desconectado.', wired: 'O cabo de rede está conectado.',
      scan: 'Procurar redes', pass: 'Senha do Wi-Fi', connect: 'Conectar', forget: 'Esquecer esta rede', scanning: 'Procurando redes…', connecting: 'Conectando… (até 45 s)', wifiAp: 'O HomeMiner está saindo da rede de configuração (HomeMiner-Setup) para entrar em "%s". Volte o celular para o Wi-Fi de casa e abra http://homeminer.local:3000. Se não conectar, a HomeMiner-Setup volta em um minuto.', wifiOk: 'Conectado ao Wi-Fi! Pode tirar o cabo; o painel continua em http://homeminer.local:3000.',
      wifiHint: 'Ao trocar de rede com o painel aberto pelo próprio Wi-Fi, a página pode perder a conexão por alguns segundos.',
      ts: 'Acesso de fora de casa (Tailscale)', tsHint: 'Abre o painel de qualquer lugar pela sua conta do Tailscale, sem abrir portas no roteador. Grátis para uso pessoal.',
      tsOff: 'Desligado.', tsLogin: 'Falta autorizar: abra o link, entre na sua conta do Tailscale e aprove este aparelho. Depois toque em "Ver estado".', tsOn: 'Conectado como %n · %i. No celular com o app do Tailscale ligado: http://%h:3000',
      tsConnect: 'Conectar ao Tailscale', tsOpen: 'Abrir o link de autorização', tsDisconnect: 'Desconectar', tsWait: 'Iniciando o Tailscale…', tsDone: 'Tailscale conectado!',
      ssh: 'Acesso SSH (só com chave)', sshHint: 'Cole a sua chave pública (o conteúdo de ~/.ssh/id_ed25519.pub; para criar uma: ssh-keygen -t ed25519). O login por senha fica desligado. Depois: ssh root@homeminer.local',
      sshKey: 'ssh-ed25519 AAAA… voce@computador', sshOn: 'Ligado.', sshOff: 'Desligado.', sshOutside: 'Ligado por fora do painel: a configuração dele não é alterada aqui, só dá para acrescentar chaves.', sshKeys: 'Chaves: ',
      sshEnable: 'Ligar o SSH', sshAdd: 'Adicionar a chave', sshDisable: 'Desligar o SSH', sshDone: 'Pronto: SSH com a sua chave.', sshNoBoot: '⚠️ Não liga sozinho depois de reiniciar.', sshPersist: 'Manter ligado ao reiniciar', sshPersisted: 'Pronto: o SSH liga sozinho depois de reiniciar.',
      dockerTitle: 'Rodando em Docker',
      dockerHelp: ['O painel está num container, então rede, Wi-Fi e SSH são do computador onde o Docker roda (o host): configure por lá.',
        '<b>Acesso de fora de casa:</b> instale o Tailscale no host (tailscale.com/download, no Windows é o app normal) e abra <code>http://NOME-DO-HOST:3000</code> pelo celular com o Tailscale ligado.',
        '<b>Minerar também com este computador:</b> <code>docker compose --profile minerador up -d</code> (nome no painel: LOCAL_WORKER, padrão "docker"; núcleos: MINER_THREADS).',
        '<b>Windows:</b> libere as portas 3000 e 3333–3339 no Firewall para a rede privada e desligue a suspensão do PC, senão os mineradores caem juntos.'] },
    BTC_ADDRESS: ['Endereço de bitcoin', 'O endereço público que os mineradores usam como usuário. O painel consulta pools e carteira por ele. Mudar aqui não muda para onde os mineradores mandam o prêmio: isso vem do usuário configurado em cada um.'],
    THEME: ['Tema visual (Material Design)', 'Escolha um dos 4 temas Material Design para o painel, modo kiosk e tela de administração. Clique em um cartão para pré-visualizar na hora.'],
    themes: [
      { id: 'obsidian', name: '🌑 Obsidian', sub: 'Material Dark · Grafite e Ouro Bitcoin (padrão)', colors: ['#0e1117', '#171c26', '#f2a900', '#3ecf8e'] },
      { id: 'ocean', name: '🌊 Material Ocean', sub: 'Material You Escuro · Azul Profundo e Ciano Elétrico', colors: ['#0b111e', '#131c31', '#38bdf8', '#34d399'] },
      { id: 'neon', name: '⚡ Material Neon', sub: 'Material Dark · Grafite e Verde Neon', colors: ['#0a111b', '#20272e', '#36cf8c', '#52eeaf'] },
      { id: 'latte', name: '☀️ Material Solar', sub: 'Material 3 Claro · Alabastro e Âmbar', colors: ['#f5f3ee', '#ffffff', '#d97706', '#16a34a'] },
    ],
    LANGUAGE: ['Idioma padrão', 'Do painel, do cubo e do bot. O botão PT | EN continua valendo em cada navegador.'],
    CURRENCY: ['Moeda', 'Cotação, prêmio e conta de luz.'],
    TEMP_UNIT: ['Unidade de temperatura', 'Celsius ou Fahrenheit no painel, no Telegram e nos limites de alerta dos Bitaxe. O Home Assistant converte sozinho.'],
    POWER_PRICE_KWH: ['Preço do kWh', 'Na moeda escolhida, para a estimativa da conta de luz.'],
    SHOW_DONATE: ['Mostrar "Apoiar o projeto"', 'O item ❤️ no fim do menu do painel, com o endereço para doar ao HomeMinerProxy. Nunca aparece no modo quiosque.'],
    SHOW_WALLET: ['Mostrar a carteira', 'Saldo, valor e movimentação na tela da fazenda. Desligue se a tela fica à vista de visitas ou se o painel é aberto de fora de casa. A cotação continua aparecendo, e o aviso de dinheiro entrando continua chegando no Telegram.'],
    BITAXES: ['Bitaxe (API do AxeOS)', 'nome=IP de cada Bitaxe, separados por vírgula (ex.: bitaxe1=192.168.0.140, bitaxe2=192.168.0.141). O painel lê hashrate, temperatura, consumo e fan direto do aparelho. Use o mesmo nome do worker (o que vem depois do ponto no usuário da pool) e reserve um IP fixo no roteador.'],
    BITAXE_TEMP_MAX: ['Bitaxe: limite do chip', 'Alerta no Telegram e no MQTT quando o chip passa disso em 2 leituras seguidas, na unidade escolhida na aba Fazenda. Vazio = {def}.'],
    BITAXE_VR_MAX: ['Bitaxe: limite do regulador', 'O regulador de tensão é o que mais esquenta no Gamma. Na unidade escolhida. Vazio = {def}.'],
    BITAXE_HASH_MIN: ['Bitaxe: hashrate mínimo (% do esperado)', 'Alerta quando a média de 10 min fica abaixo disso por 10 minutos (não conta os primeiros 15 min depois de ligar). Vazio = 70%.'],
    LOCAL_WORKER: ['Minerador nesta máquina', 'Worker do cpuminer que roda neste servidor (serviço minerd). O painel lê o hashrate do log e mostra a temperatura da CPU.'],
    LOCAL_MINER: ['Minerar também com este servidor', 'Liga o cpuminer deste aparelho, apontado para o próprio proxy, com o nome do campo acima (ou o nome do aparelho). Esquenta a placa: use dissipador.'],
    MINER_THREADS: ['Núcleos para minerar', 'Vazio deixa um núcleo livre para o proxy e o painel.'],
    ALARM_IGNORE: ['Não acender a luz vermelha', 'Workers que podem parar sem alarme (ex.: um notebook que você desliga à noite). Também não geram aviso no Telegram.'],
    WATTS: ['Consumo por worker (W)', 'Em watts, para a estimativa da conta de luz. Vazio usa o padrão (5 W).'],
    EXPECTED: ['Hashrate esperado por worker', 'Aparece no painel mesmo quando a pool esconde o worker. Use 0 para ocultar um worker esperado no .env; vazio deixa só pelo que a pool ou o proxy informarem.'],
    CUBE_IP: ['IP do cubo', 'Vazio desliga o placar no cubo.'],
    TELEGRAM_BOT_TOKEN: ['Token do bot', 'Crie o bot no @BotFather (/newbot) e cole o token aqui.'],
    TELEGRAM_CHAT_ID: ['Id do chat', 'Mande /start para o bot depois de salvar o token: ele responde com o id. Vários: separe por vírgula.'],
    TELEGRAM_DAILY: ['Resumo diário', 'Hora do resumo (0 a 23). Vazio desliga.'],
    TELEGRAM_PERSONAL: ['Avisar recordes pessoais', 'Além do recorde da fazenda, avisa o recorde de cada worker (pode falar bastante no começo).'],
    TELEGRAM_BACKUP: ['Backup semanal no Telegram', 'Todo domingo, na hora do resumo, o bot manda o arquivo de backup (o mesmo do 💾 Backup) sem som. A qualquer hora: /backup. O arquivo tem as chaves e senhas salvas (Tuya, MQTT, o token do bot): fica no seu chat com o bot.'],
    TELEGRAM_PANEL_URL: ['Link do painel', 'Aparece no /status. Ex.: http://odroid:3000 (Tailscale).'],
    MQTT_URL: ['Broker MQTT', 'URL do broker (ex.: mqtt://homeassistant.local:1883 ou mqtts://host:8883). Vazio desliga.'],
    MQTT_USER: ['Usuário MQTT', 'Usuário configurado no broker (Mosquitto / Home Assistant). Opcional se o broker aceitar conexão anônima.'],
    MQTT_PASS: ['Senha MQTT', 'Senha do usuário MQTT.'],
    MQTT_TOPIC: ['Prefixo do tópico', 'Padrão: homeminerproxy. Publica homeassistant/sensor/homeminerproxy/... (Auto-Discovery) e <prefixo>/state + <prefixo>/event.'],
    TUYA_REGION: ['Região Tuya Cloud', 'Américas (us) atende o Brasil. Só mude se sua conta no iot.tuya.com foi criada em outro datacenter (eu, cn, in).'],
    TUYA_CLIENT_ID: ['Access ID (Client ID)', 'Do seu projeto Cloud em iot.tuya.com (vinculado ao app SmartLife por QR Code). Vazio desliga.'],
    TUYA_SECRET: ['Access Secret (Client Secret)', 'Chave secreta do projeto em iot.tuya.com.'],
    TUYA_PLUGS: ['Tomadas', 'Cadastre quantas tomadas quiser. SmartLife/Tuya: pelo Device ID (ID Virtual no app), usando as credenciais da Tuya Cloud acima. Sonoff: pelo IP, com o modo LAN/DIY ligado (sem nuvem e sem credenciais). Em cada uma: qual minerador está ligado nela (ou "Só monitorar") e o watchdog opcional em minutos (mín. 5). A tomada do minerador local (o próprio servidor) não pode ser desligada por aqui.'],
    TUYA_DEVICE_ID: ['Device ID da tomada', 'No app SmartLife: toque na tomada → ícone ✏️ no canto superior → Informações do Dispositivo → ID Virtual.'],
    TUYA_WORKER: ['Aparelho ligado na tomada', 'Se escolher um worker (ex.: bitaxe), os Watts reais da tomada entram no consumo dele. Em "Só monitorar", mostra a leitura no painel sem somar na conta dos mineradores.'],
    TUYA_WATCHDOG_MIN: ['Reiniciar tomada se parar (min)', 'Se o worker da tomada ficar parado por esses minutos (mín. 5), desliga a tomada por 8s e religa sozinho. Vazio desliga.'],
    auto: 'Automático', none: 'Nenhum', yes: 'Sim', tuyaNone: 'Só monitorar (não somar nos mineradores)', tuyaAll: 'Fazenda inteira (*)',
    addWorkerPlaceholder: 'Nome do worker (ex.: bitaxe)', addWattsPlaceholder: 'W (ex.: 20)', addHrPlaceholder: 'Hashrate (ex.: 1.2)', addWorkerBtn: '+ Adicionar worker',
    addPlugNamePlaceholder: 'Apelido (ex.: Bitaxe, Ventilador)', addPlugIdPlaceholder: 'Device ID (ID Virtual no app)', addPlugHostPlaceholder: 'IP do Sonoff (ex.: 192.168.0.50)', addPlugWdPlaceholder: 'Watchdog min', addPlugBtn: '+ Adicionar tomada',
    plugTypes: { tuya: 'SmartLife / Tuya (nuvem)', sonoff: 'Sonoff (rede local)' },
    tokenSet: (t) => `configurado (termina em ${t}). Deixe vazio para manter.`, tokenClear: 'Remover o valor salvo',
    backupHelp: 'Baixe ou restaure recordes, histórico, workers e configurações num único arquivo JSON (pede o PIN abaixo).',
    verTitle: 'Versão e atualização', verInstalled: 'Instalada', verLatest: 'Mais recente no GitHub', verNew: 'nova versão disponível!', verOk: 'você está na versão mais recente',
    updSame: 'já estava na versão mais recente: reinstalado sem mudanças.', updFail: 'A atualização falhou:', updBtn: '⬆ Atualizar agora', updRunning: 'Atualizando: baixando a versão nova e reinstalando. O painel reinicia sozinho em 1 ou 2 minutos…', updDone: 'Atualizado!', updSlow: 'A atualização está demorando. Recarregue a página em alguns minutos.',
    updWhy: { docker: 'No Docker, atualize com: docker compose pull && docker compose up -d', norepo: 'A atualização pelo botão precisa da pasta do repositório (instalação pelo install.sh).', nosystemd: 'A atualização pelo botão precisa do serviço do systemd (instalação pelo install.sh).' },
    backupDown: '⬇ Baixar backup', backupUp: '⬆ Restaurar backup…',
    backupOk: 'Backup baixado.', restored: 'Backup restaurado! Reiniciando o painel…',
    pin: 'PIN', pinHelp: 'O SETTINGS_PIN que está em /etc/mineracao.env (o instalador cria e mostra no final).', pinAsk: 'Digite o PIN para continuar', pinOk: 'Confirmar', pinCancel: 'Cancelar', pinCanceled: 'Ação cancelada (sem PIN).',
    noPin: 'Para salvar por aqui, defina SETTINGS_PIN em /etc/mineracao.env e reinicie o painel. Rode o install.sh de novo que ele cria um PIN para você.',
    save: 'Salvar e reiniciar', testBitaxe: 'Testar', scanBitaxe: 'Procurar na rede', bitaxeScanning: 'Procurando Bitaxe na rede (uns 15 s)…', bitaxeNone: 'Nenhum Bitaxe respondeu na rede.', bitaxeFail: 'sem resposta', bitaxeAdd: 'Usar estes', testCube: 'Testar cubo', testTg: 'Mandar mensagem de teste', testMqtt: 'Testar MQTT', testTuya: 'Testar tomada',
    saved: 'Salvo! Reiniciando o painel…', back2: 'Pronto. Voltando ao painel…', nothing: 'Nada mudou.',
    cubeOk: 'O cubo respondeu.', cubeFail: 'O cubo não respondeu nesse IP.',
    tgOk: 'Mensagem enviada. Confira o Telegram.', tgFail: (e) => `Não enviou: ${e}`, tgTest: '✅ Teste do painel da fazenda: o bot está funcionando!',
    mqttOk: 'Conectado ao broker MQTT!', mqttFail: (e) => `Falha no MQTT: ${e}`,
    tuyaOk: (s) => `Tomada respondeu: ${s}`, tuyaFail: (e) => `Falha na tomada: ${e}`,
    err: { address: 'Endereço inválido', option: 'Opção inválida', price: 'Use um número entre 0 e 100', watts: 'Use watts entre 0 e 100000', threads: 'Use de 1 a 256 núcleos', nobitaxe: 'Bitaxe não cadastrado', unsupported: 'Este firmware não tem essa ação', notapplied: 'O Bitaxe aceitou, mas a releitura não confirmou: ajuste no AxeOS', fan: 'Fan: velocidade de 20 a 100%', fanT: 'Fan: alvo de {lo} a {hi} ou velocidade de 20 a 100%', rangeT: 'Use de {lo} a {hi}', noaddress: 'Falta o endereço de bitcoin', nohost: 'Não achei o IP deste servidor na rede', offline: 'O Bitaxe não respondeu', timeout: 'O Bitaxe não respondeu a tempo', action: 'Ação inválida', bitaxes: 'Use nome=IP da rede de casa, separados por vírgula (ex.: bitaxe1=192.168.0.140)', range: 'Número fora da faixa permitida', ssid: 'Escolha uma rede', wifipass: 'A senha do Wi-Fi tem de 8 a 63 caracteres', wifiauth: 'Senha do Wi-Fi errada', wifinotfound: 'Rede não encontrada', wificonnect: 'Não conectou ao Wi-Fi', wifiscan: 'Não consegui procurar redes', notailscale: 'Tailscale não instalado', sshkey: 'Cole uma chave pública SSH (ssh-ed25519 AAAA…), não a chave privada', nossh: 'SSH não disponível neste aparelho', sshstart: 'O SSH não subiu', expected: 'Hashrate inválido (ex.: 1.2 TH/s ou 350 kH/s)', backup: 'Arquivo de backup inválido', name: 'Nome inválido', host: 'IP inválido', token: 'Não parece um token do Telegram. Toque em 👁 para conferir: o certo tem só o token, assim: 1234567890:AAH… (números, dois-pontos e uns 35 caracteres). O navegador pode ter preenchido uma senha salva no lugar.', chatid: 'O id do chat é um número (ex.: 8983008026), não o nome do bot. Mande /start para o bot: ele responde com o número.', nochat: 'o Telegram não achou esse chat. Abra o bot no Telegram e toque em Iniciar (/start): bots só escrevem para quem já falou com eles. Confira também se o id é o número que o bot respondeu.', hour: 'Hora de 0 a 23', url: 'Comece com http:// ou https://', mqtturl: 'Use mqtt://host:1883 ou mqtts://host:8883', mqtttopic: 'Prefixo inválido (use letras, números, _, - ou /)', mqttauth: 'Usuário ou senha recusados pelo broker', tuyaid: 'ID inválido (use letras e números de 8 a 64 caracteres)', tuyasecret: 'Access Secret inválido', tuyaplugs: 'Lista de tomadas inválida', tuyamissing: 'Preencha Access ID, Access Secret e Device ID', tuyaauth: 'Credenciais recusadas pela Tuya Cloud', sonoffoffline: 'O Sonoff não respondeu nesse IP (confira o IP e se o modo LAN/DIY está ligado)', sonofflan: 'O Sonoff recusou: o modo LAN/DIY está desligado', sonoffid: 'O Sonoff não reconheceu esse Device ID', sonoffformat: 'Resposta inesperada do Sonoff', selfplug: 'Essa tomada alimenta o próprio servidor', watchdog: 'Use de 5 a 1440 minutos (ou vazio para desligar)', wrong: 'PIN errado', locked: 'Muitas tentativas erradas. Espere 15 minutos.', nopin: 'SETTINGS_PIN não definido', missing: 'Preencha o token e o id do chat', fix: 'Corrija os campos marcados.' },
  },
  en: {
    title: 'Settings', back: '← Back to the dashboard',
    groups: { discover: 'Discover miners on the network', farm: 'Farm', miners: 'Miners', cube: 'GeekMagic cube', telegram: 'Telegram bot', mqtt: 'Home Assistant / MQTT', tuya: 'Smart plugs (SmartLife / Tuya and Sonoff)', net: 'Network', backup: 'Backup and restore' },
    navGroups: { general: 'General', integrations: 'Integrations', system: 'System' },
    tabDesc: { discover: 'Looks for miners on the home network and tells which already mine through the proxy.', farm: 'Bitcoin address, language, currency, power price and dashboard look.', miners: 'Proxy ports, local miner, Bitaxe, power and expected hashrate of each worker.',
      telegram: 'Bot with alerts, daily summary, weekly backup and commands.', tuya: 'SmartLife/Tuya and Sonoff plugs: real power and restarting miners.',
      mqtt: 'Farm sensors in Home Assistant over MQTT.', cube: 'Farm scoreboard on the GeekMagic cube.', net: 'Wi-Fi, access from outside home (Tailscale) and SSH for this server.',
      backup: 'Installed version, updates and settings backup.' },
    tabs: { discover: '🔍 Discover', farm: '🏠 Farm', miners: '⛏️ Miners', telegram: '✈️ Telegram', tuya: '🔌 Smart Plug', mqtt: '🏠 MQTT / HA', cube: '🧊 Cube', net: '🌐 Network', backup: '💾 Backup' },
    dsc: { help: 'Scans the home network for Bitaxe and NerdQaxe (AxeOS), ASICs with the cgminer API (port 4028, such as Avalon Nano and Antminer) and ESP32 boards (NerdMiner). Takes up to half a minute.',
      run: 'Scan the network', running: 'Scanning the network (up to half a minute)…', none: 'No miner found. Check that they are on the same network (Wi-Fi or cable) as this server.',
      docker: 'Running in Docker: without network_mode: host, the scan only sees the Docker internal network.', count: '%s device(s) found.',
      kinds: { axeos: 'AxeOS', cgminer: 'cgminer API', esp32: 'ESP32', proxy: 'device connected to the proxy' },
      via: { proxy: 'mining through the proxy', direct: 'mining directly on %s', unknown: 'not seen on the proxy' }, worker: 'worker',
      esp: 'Probably a NerdMiner, or another ESP32 device (a Sonoff plug, for example).', espHint: 'If it is a NerdMiner, point it at the proxy NerdMiner port (see Pools and ports in the Miners tab).',
      cgHint: 'To mine through the proxy, change the pool on this ASIC page (see Pools and ports in the Miners tab).', axeHint: 'Add it to the dashboard, save and use "Point at the proxy" in Bitaxe actions.',
      registered: 'on the dashboard as %s', add: 'Add to dashboard', added: 'Added to the Bitaxe field in the Miners tab. Save to start monitoring.', open: 'open ↗' },
    bx: { title: 'Bitaxe actions', help: 'Restart, identify (the screen blinks), pause and resume, fan and point at the proxy. Overclock, firmware and Wi-Fi stay in AxeOS.',
      none: 'Register the Bitaxe in the field above and save to see them here.', restart: 'Restart', identify: 'Identify', pause: 'Pause', resume: 'Resume', point: 'Point at the proxy',
      fanAuto: 'Auto fan, target', fanFixed: 'Fixed fan at', apply: 'Apply', confirm: 'Confirm and restart', cancel: 'Cancel', offline: 'no answer', paused: 'paused',
      from: 'Now', to: 'Will be', backupLbl: 'backup', same: 'Already points at the proxy.', done: 'Done.', pointDone: 'Pool saved and checked; the Bitaxe is restarting.', last: 'Last action' },
    pools: { title: 'Pools and ports', help: 'Each proxy port leads to a pool. Point each miner at the port that suits it; if the pool goes down, the proxy switches to the backup on its own.',
      factory: 'The proxy did not answer: these are the factory ports.', backup: 'backup', down: 'down · using', ms: 'ms',
      use: { nerd: 'NerdMiner and ESP32: accepts their tiny shares', pub: 'cpuminer (PC, phone, Raspberry): no fee, minimum difficulty 1', atlas: 'Bitaxe and ASICs: server in São Paulo, lowest ping in Brazil (1.5% fee; not for ESP32)',
        ck: 'Bitaxe and ASICs: the best-known solo pool (2% fee)', ckeu: 'Bitaxe and ASICs in Europe (2% fee)', ocean: 'Not solo: the reward is split among everyone (small, regular payouts)', other: 'Pool set in PROXY_ROUTES' },
      howTitle: 'How to point your miners', server: 'Server', user: 'User', userHint: 'your address + dot + a name for the miner', pass: 'Password',
      bitaxe: 'Bitaxe (AxeOS → Pool)', bitaxeHow: 'Stratum URL: %h · Port: %p · User: %u · Password: x. Under "Fallback", set solo.ckpool.org port 3333 with the same user.',
      nerd: 'NerdMiner / ESP32', nerdHow: 'Pool: %h · Port: %p · Address: your bitcoin address',
      cpu: 'cpuminer', cpuHow: 'minerd -a sha256d -o stratum+tcp://%h:%p -u %u -p x',
      noAddr: 'YOUR_ADDRESS' },
    net: { pinFirst: 'Tap "Show status" (asks for the PIN).', refresh: '↻ Show status', none: 'Nothing to set up here on this device (no managed Wi-Fi and no Tailscale).',
      wifi: 'Wi-Fi', wifiNone: 'No Wi-Fi adapter on this device.', wifiOn: (s, ip) => `Connected to ${s}${ip ? ' · IP ' + ip : ''}`, wifiOff: 'Wi-Fi not connected.', wired: 'The network cable is connected.',
      scan: 'Find networks', pass: 'Wi-Fi password', connect: 'Connect', forget: 'Forget this network', scanning: 'Searching for networks…', connecting: 'Connecting… (up to 45 s)', wifiAp: 'HomeMiner is leaving the setup network (HomeMiner-Setup) to join "%s". Switch your phone back to your home Wi-Fi and open http://homeminer.local:3000. If it does not connect, HomeMiner-Setup comes back in a minute.', wifiOk: 'Connected to Wi-Fi! You can unplug the cable; the dashboard stays at http://homeminer.local:3000.',
      wifiHint: 'If you change networks while the dashboard is open over that same Wi-Fi, the page may lose the connection for a few seconds.',
      ts: 'Access from outside home (Tailscale)', tsHint: 'Opens the dashboard from anywhere through your Tailscale account, without opening router ports. Free for personal use.',
      tsOff: 'Off.', tsLogin: 'Not authorized yet: open the link, sign in to Tailscale and approve this device. Then tap "Show status".', tsOn: 'Connected as %n · %i. On a phone with the Tailscale app on: http://%h:3000',
      tsConnect: 'Connect to Tailscale', tsOpen: 'Open the authorization link', tsDisconnect: 'Disconnect', tsWait: 'Starting Tailscale…', tsDone: 'Tailscale connected!',
      ssh: 'SSH access (key only)', sshHint: 'Paste your public key (the content of ~/.ssh/id_ed25519.pub; to create one: ssh-keygen -t ed25519). Password login stays off. Then: ssh root@homeminer.local',
      sshKey: 'ssh-ed25519 AAAA… you@computer', sshOn: 'On.', sshOff: 'Off.', sshOutside: 'Turned on outside the dashboard: its configuration is not changed here, you can only add keys.', sshKeys: 'Keys: ',
      sshEnable: 'Turn SSH on', sshAdd: 'Add the key', sshDisable: 'Turn SSH off', sshDone: 'Done: SSH with your key.', sshNoBoot: '⚠️ Does not start by itself after a restart.', sshPersist: 'Keep it on after restarts', sshPersisted: 'Done: SSH starts by itself after a restart.',
      dockerTitle: 'Running in Docker',
      dockerHelp: ['The dashboard runs in a container, so network, Wi-Fi and SSH belong to the computer running Docker (the host): set them up there.',
        '<b>Access from outside home:</b> install Tailscale on the host (tailscale.com/download, on Windows it is the regular app) and open <code>http://HOST-NAME:3000</code> on a phone with Tailscale on.',
        '<b>Also mine with this computer:</b> <code>docker compose --profile minerador up -d</code> (name on the dashboard: LOCAL_WORKER, default "docker"; cores: MINER_THREADS).',
        '<b>Windows:</b> allow ports 3000 and 3333–3339 in the Firewall for the private network and turn off sleep, or all miners drop together.'] },
    BTC_ADDRESS: ['Bitcoin address', 'The public address your miners use as username. The dashboard looks up pools and the wallet with it. Changing it here does not change where the miners send the reward: that comes from the username set on each miner.'],
    THEME: ['Visual theme (Material Design)', 'Choose one of the 4 Material Design themes for the dashboard, kiosk mode and admin screen. Click a card to preview it live.'],
    themes: [
      { id: 'obsidian', name: '🌑 Obsidian', sub: 'Material Dark · Graphite & Bitcoin Gold (default)', colors: ['#0e1117', '#171c26', '#f2a900', '#3ecf8e'] },
      { id: 'ocean', name: '🌊 Material Ocean', sub: 'Material You Dark · Deep Blue & Electric Cyan', colors: ['#0b111e', '#131c31', '#38bdf8', '#34d399'] },
      { id: 'neon', name: '⚡ Material Neon', sub: 'Material Dark · Graphite & Neon Green', colors: ['#0a111b', '#20272e', '#36cf8c', '#52eeaf'] },
      { id: 'latte', name: '☀️ Material Solar', sub: 'Material 3 Light · Alabaster & Amber', colors: ['#f5f3ee', '#ffffff', '#d97706', '#16a34a'] },
    ],
    LANGUAGE: ['Default language', 'For the dashboard, cube and bot. The PT | EN button still works per browser.'],
    CURRENCY: ['Currency', 'BTC price, prize and power bill.'],
    TEMP_UNIT: ['Temperature unit', 'Celsius or Fahrenheit on the dashboard, on Telegram and in the Bitaxe alert limits. Home Assistant converts on its own.'],
    POWER_PRICE_KWH: ['Price per kWh', 'In the chosen currency, for the power bill estimate.'],
    SHOW_DONATE: ['Show "Support the project"', 'The ❤️ item at the end of the dashboard menu, with the address to donate to HomeMinerProxy. Never shown in kiosk mode.'],
    SHOW_WALLET: ['Show the wallet', 'Balance, value and activity on the farm screen. Turn it off if the screen is in view of visitors or the dashboard is opened from outside your home. The BTC price still shows, and Telegram still alerts when money arrives.'],
    BITAXES: ['Bitaxe (AxeOS API)', 'name=IP of each Bitaxe, comma separated (e.g. bitaxe1=192.168.0.140, bitaxe2=192.168.0.141). The dashboard reads hashrate, temperature, power and fan straight from the device. Use the worker name (what comes after the dot in the pool user) and reserve a fixed IP in your router.'],
    BITAXE_TEMP_MAX: ['Bitaxe: chip limit', 'Alert on Telegram and MQTT when the chip goes over this in 2 reads in a row, in the unit chosen in the Farm tab. Empty = {def}.'],
    BITAXE_VR_MAX: ['Bitaxe: regulator limit', 'The voltage regulator is what runs hottest on the Gamma. In the chosen unit. Empty = {def}.'],
    BITAXE_HASH_MIN: ['Bitaxe: minimum hashrate (% of expected)', 'Alert when the 10-min average stays below this for 10 minutes (not in the first 15 min after power-on). Empty = 70%.'],
    LOCAL_WORKER: ['Miner on this machine', 'The cpuminer worker running on this server (minerd service). The dashboard reads its hashrate from the log and shows the CPU temperature.'],
    LOCAL_MINER: ['Also mine with this server', 'Turns on this device\'s cpuminer, pointed at its own proxy, with the name above (or the device name). It heats the board: use a heatsink.'],
    MINER_THREADS: ['Cores for mining', 'Empty leaves one core free for the proxy and the dashboard.'],
    ALARM_IGNORE: ['Don\'t turn the red light on', 'Workers that may stop without an alarm (e.g. a laptop you shut down at night). They also skip Telegram alerts.'],
    WATTS: ['Power per worker (W)', 'In watts, for the power bill estimate. Empty uses the default (5 W).'],
    EXPECTED: ['Expected hashrate per worker', 'Shows up on the dashboard even when the pool hides the worker. Use 0 to hide a worker set in .env; empty relies on the pool or proxy.'],
    CUBE_IP: ['Cube IP', 'Empty turns the cube scoreboard off.'],
    TELEGRAM_BOT_TOKEN: ['Bot token', 'Create the bot with @BotFather (/newbot) and paste the token here.'],
    TELEGRAM_CHAT_ID: ['Chat id', 'Send /start to the bot after saving the token: it replies with the id. Several: comma separated.'],
    TELEGRAM_DAILY: ['Daily summary', 'Hour of the summary (0 to 23). Empty turns it off.'],
    TELEGRAM_PERSONAL: ['Alert personal records', 'Besides the farm record, alert each worker\'s record (chatty at first).'],
    TELEGRAM_BACKUP: ['Weekly backup on Telegram', 'Every Sunday, at the summary hour, the bot sends the backup file (the same as 💾 Backup) silently. Any time: /backup. The file has your saved keys and passwords (Tuya, MQTT, the bot token): it stays in your chat with the bot.'],
    TELEGRAM_PANEL_URL: ['Dashboard link', 'Shown in /status. E.g. http://odroid:3000 (Tailscale).'],
    MQTT_URL: ['MQTT broker', 'Broker URL (e.g. mqtt://homeassistant.local:1883 or mqtts://host:8883). Empty turns it off.'],
    MQTT_USER: ['MQTT username', 'Username configured on the broker (Mosquitto / Home Assistant). Optional if anonymous access is allowed.'],
    MQTT_PASS: ['MQTT password', 'Password for the MQTT user.'],
    MQTT_TOPIC: ['Topic prefix', 'Default: homeminerproxy. Publishes homeassistant/sensor/homeminerproxy/... (Auto-Discovery) and <prefix>/state + <prefix>/event.'],
    TUYA_REGION: ['Tuya Cloud region', 'Americas (us) covers the US and Brazil. Change only if your iot.tuya.com project is in another region (eu, cn, in).'],
    TUYA_CLIENT_ID: ['Access ID (Client ID)', 'From your Cloud project at iot.tuya.com (linked to the SmartLife app via QR code). Empty turns it off.'],
    TUYA_SECRET: ['Access Secret (Client Secret)', 'Secret key from your iot.tuya.com project.'],
    TUYA_PLUGS: ['Plugs', 'Add as many plugs as you want. SmartLife/Tuya: by Device ID (Virtual ID in the app), using the Tuya Cloud credentials above. Sonoff: by IP, with LAN/DIY mode on (no cloud, no credentials). For each one: linked miner (or "Monitor only") and optional watchdog minutes (min 5). The plug of the local miner (the server itself) cannot be turned off from here.'],
    TUYA_DEVICE_ID: ['Plug Device ID', 'In the SmartLife app: tap the plug → ✏️ icon at top right → Device Information → Virtual ID.'],
    TUYA_WORKER: ['Device plugged in', 'If set to a worker (e.g. bitaxe), the plug\'s live Watts are used for that worker. "Monitor only" shows the reading on the dashboard without adding it to the miners\' power bill.'],
    TUYA_WATCHDOG_MIN: ['Auto-reboot plug when stopped (min)', 'If the linked worker is stopped for this many minutes (min 5), turns the plug off for 8s and back on. Empty disables.'],
    auto: 'Automatic', none: 'None', yes: 'Yes', tuyaNone: 'Monitor only (do not add to miners)', tuyaAll: 'Whole farm (*)',
    addWorkerPlaceholder: 'Worker name (e.g. bitaxe)', addWattsPlaceholder: 'W (e.g. 20)', addHrPlaceholder: 'Hashrate (e.g. 1.2)', addWorkerBtn: '+ Add worker',
    addPlugNamePlaceholder: 'Label (e.g. Bitaxe, Fan)', addPlugIdPlaceholder: 'Device ID (Virtual ID in app)', addPlugHostPlaceholder: 'Sonoff IP (e.g. 192.168.0.50)', addPlugWdPlaceholder: 'Watchdog min', addPlugBtn: '+ Add plug',
    plugTypes: { tuya: 'SmartLife / Tuya (cloud)', sonoff: 'Sonoff (local network)' },
    tokenSet: (t) => `set (ends in ${t}). Leave empty to keep it.`, tokenClear: 'Remove saved value',
    backupHelp: 'Download or restore records, history, workers and settings in a single JSON file (requires the PIN below).',
    verTitle: 'Version and update', verInstalled: 'Installed', verLatest: 'Latest on GitHub', verNew: 'a new version is available!', verOk: 'you are on the latest version',
    updSame: 'it was already the latest version: reinstalled with no changes.', updFail: 'The update failed:', updBtn: '⬆ Update now', updRunning: 'Updating: downloading the new version and reinstalling. The dashboard restarts by itself in 1 or 2 minutes…', updDone: 'Updated!', updSlow: 'The update is taking a while. Reload the page in a few minutes.',
    updWhy: { docker: 'With Docker, update with: docker compose pull && docker compose up -d', norepo: 'Updating from here needs the repository folder (install.sh install).', nosystemd: 'Updating from here needs the systemd service (install.sh install).' },
    backupDown: '⬇ Download backup', backupUp: '⬆ Restore backup…',
    backupOk: 'Backup downloaded.', restored: 'Backup restored! Restarting the dashboard…',
    pin: 'PIN', pinHelp: 'The SETTINGS_PIN in /etc/mineracao.env (the installer creates it and shows it at the end).', pinAsk: 'Type the PIN to continue', pinOk: 'Confirm', pinCancel: 'Cancel', pinCanceled: 'Action canceled (no PIN).',
    noPin: 'To save from here, set SETTINGS_PIN in /etc/mineracao.env and restart the dashboard. Running install.sh again creates a PIN for you.',
    save: 'Save and restart', testBitaxe: 'Test', scanBitaxe: 'Find on the network', bitaxeScanning: 'Looking for Bitaxe on the network (about 15 s)…', bitaxeNone: 'No Bitaxe answered on the network.', bitaxeFail: 'no answer', bitaxeAdd: 'Use these', testCube: 'Test cube', testTg: 'Send test message', testMqtt: 'Test MQTT', testTuya: 'Test plug',
    saved: 'Saved! Restarting the dashboard…', back2: 'Done. Going back to the dashboard…', nothing: 'Nothing changed.',
    cubeOk: 'The cube answered.', cubeFail: 'The cube did not answer at that IP.',
    tgOk: 'Message sent. Check Telegram.', tgFail: (e) => `Not sent: ${e}`, tgTest: '✅ Mining farm dashboard test: the bot is working!',
    mqttOk: 'Connected to the MQTT broker!', mqttFail: (e) => `MQTT failed: ${e}`,
    tuyaOk: (s) => `Plug answered: ${s}`, tuyaFail: (e) => `Plug failed: ${e}`,
    err: { address: 'Invalid address', option: 'Invalid option', price: 'Use a number from 0 to 100', watts: 'Use watts from 0 to 100000', threads: 'Use 1 to 256 cores', nobitaxe: 'Bitaxe not registered', unsupported: 'This firmware does not have that action', notapplied: 'The Bitaxe accepted it, but reading it back did not confirm: set it in AxeOS', fan: 'Fan: speed 20 to 100%', fanT: 'Fan: target {lo} to {hi} or speed 20 to 100%', rangeT: 'Use {lo} to {hi}', noaddress: 'The bitcoin address is missing', nohost: 'Could not find this server\'s IP on the network', offline: 'The Bitaxe did not answer', timeout: 'The Bitaxe did not answer in time', action: 'Invalid action', bitaxes: 'Use name=IP on your home network, comma separated (e.g. bitaxe1=192.168.0.140)', range: 'Number out of the allowed range', ssid: 'Pick a network', wifipass: 'The Wi-Fi password has 8 to 63 characters', wifiauth: 'Wrong Wi-Fi password', wifinotfound: 'Network not found', wificonnect: 'Could not connect to Wi-Fi', wifiscan: 'Could not search for networks', notailscale: 'Tailscale is not installed', sshkey: 'Paste an SSH public key (ssh-ed25519 AAAA…), not the private key', nossh: 'SSH is not available on this device', sshstart: 'SSH did not start', expected: 'Invalid hashrate (e.g. 1.2 TH/s or 350 kH/s)', backup: 'Invalid backup file', name: 'Invalid name', host: 'Invalid IP', token: 'This does not look like a Telegram token. Tap 👁 to check it: it should be just the token, like 1234567890:AAH… (digits, a colon and about 35 characters). The browser may have filled in a saved password instead.', chatid: 'The chat id is a number (e.g. 8983008026), not the bot name. Send /start to the bot: it replies with the number.', nochat: 'Telegram could not find that chat. Open the bot in Telegram and tap Start (/start): bots can only write to people who talked to them first. Also check that the id is the number the bot replied with.', hour: 'Hour from 0 to 23', url: 'Start with http:// or https://', mqtturl: 'Use mqtt://host:1883 or mqtts://host:8883', mqtttopic: 'Invalid prefix (use letters, digits, _, - or /)', mqttauth: 'Username or password rejected by broker', tuyaid: 'Invalid ID (8 to 64 alphanumeric chars)', tuyasecret: 'Invalid Access Secret', tuyaplugs: 'Invalid smart plug list', tuyamissing: 'Fill in Access ID, Access Secret and Device ID', tuyaauth: 'Credentials rejected by Tuya Cloud', sonoffoffline: 'The Sonoff did not answer at that IP (check the IP and that LAN/DIY mode is on)', sonofflan: 'The Sonoff refused: LAN/DIY mode is off', sonoffid: 'The Sonoff did not recognize that Device ID', sonoffformat: 'Unexpected answer from the Sonoff', selfplug: 'This plug powers the server itself', watchdog: 'Use 5 to 1440 minutes (or empty to disable)', wrong: 'Wrong PIN', locked: 'Too many wrong tries. Wait 15 minutes.', nopin: 'SETTINGS_PIN is not set', missing: 'Fill in the token and the chat id', fix: 'Fix the highlighted fields.' },
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
      input = `<select name="${f.key}"${f.hideEmpty ? ` data-empty="${f.options.find((o) => o !== '')}"` : ''}>` + f.options.filter((o) => !(f.hideEmpty && o === '')).map((o) => `<option value="${o}">${o === '' ? S.auto : (f.labels && f.labels[o]) || o}</option>`).join('') + '</select>';
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
        `<div class="addw addp"><select id="new_plug_type"><option value="tuya">${htmlEsc(S.plugTypes.tuya)}</option><option value="sonoff">${htmlEsc(S.plugTypes.sonoff)}</option></select>` +
        `<input type="text" id="new_plug_name" placeholder="${htmlEsc(S.addPlugNamePlaceholder)}" autocomplete="off" spellcheck="false">` +
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
      const extra = f.type === 'price' ? ' inputmode="decimal"' : f.type === 'hour' ? ' inputmode="numeric" maxlength="2"' : f.type === 'watchdog' ? ' inputmode="numeric" maxlength="4" placeholder="10"' : f.type === 'threads' ? ' inputmode="numeric" maxlength="3"' : f.type === 'bitaxes' ? ' placeholder="bitaxe1=192.168.0.140, bitaxe2=192.168.0.141"' : f.type === 'range' ? ` inputmode="decimal" maxlength="5" placeholder="${{ BITAXE_TEMP_MAX: 68, BITAXE_VR_MAX: 80, BITAXE_HASH_MIN: 70 }[f.key] || ''}"${f.temp ? ' data-temp="1"' : ''}` : f.type === 'mqtturl' ? ' placeholder="mqtt://homeassistant.local:1883"' : f.type === 'mqtttopic' ? ' placeholder="homeminerproxy"' : '';
      input = `<input name="${f.key}"${extra} autocomplete="off" spellcheck="false">`;
    }
    const test = f.key === 'CUBE_IP' ? ` <button type="button" class="ghost" data-test="cube">${S.testCube}</button>`
      : f.key === 'TELEGRAM_CHAT_ID' ? ` <button type="button" class="ghost" data-test="telegram">${S.testTg}</button>`
      : f.key === 'MQTT_URL' ? ` <button type="button" class="ghost" data-test="mqtt">${S.testMqtt}</button>`
      : f.key === 'TUYA_DEVICE_ID' ? ` <button type="button" class="ghost" data-test="tuya">${S.testTuya}</button>`
      : f.key === 'BITAXES' ? `<div class="bbar"><button type="button" class="ghost" data-test="bitaxe">${S.testBitaxe}</button><button type="button" class="ghost" id="bitaxe_scan">${S.scanBitaxe}</button></div><div id="bitaxe_res" class="pools"></div>` : '';
    const half = ['BITAXE_TEMP_MAX', 'BITAXE_VR_MAX', 'BITAXE_HASH_MIN', 'LOCAL_MINER', 'MINER_THREADS', 'LANGUAGE', 'CURRENCY', 'POWER_PRICE_KWH', 'SHOW_WALLET', 'SHOW_DONATE', 'TELEGRAM_DAILY', 'TELEGRAM_PERSONAL', 'TELEGRAM_BACKUP', 'TUYA_REGION', 'TUYA_CLIENT_ID', 'MQTT_USER', 'MQTT_PASS'].includes(f.key) ? ' half' : '';
    const hideLegacy = ['TUYA_DEVICE_ID', 'TUYA_WORKER', 'TUYA_WATCHDOG_MIN'].includes(f.key) ? ' hidden' : '';
    // .fl = rótulo + ajuda (à esquerda no computador), .fc = o campo (à direita)
    const tdef = f.temp ? ({ BITAXE_TEMP_MAX: 68, BITAXE_VR_MAX: 80 }[f.key]) : null;
    const isF = String(process.env.TEMP_UNIT || '').toUpperCase() === 'F';
    const helpTxt = tdef != null ? help.replace('{def}', isF ? Math.round(tdef * 9 / 5 + 32) + ' °F' : tdef + ' °C') : help;
    return `<div class="f${half}" data-key="${f.key}"${hideLegacy}><div class="fl"><label>${htmlEsc(label)}</label><div class="hint help"${tdef != null ? ` data-tpl="${htmlEsc(help)}" data-def="${tdef}"` : ''}>${htmlEsc(helpTxt)}</div></div><div class="fc">${input}${test}<div class="ferr"></div></div></div>`;
  };
  // menu lateral no estilo de console de nuvem: grupos, ícone discreto, rótulo; no celular vira uma faixa rolável
  const navGroups = [['general', ['farm', 'miners', 'discover']], ['integrations', ['telegram', 'tuya', 'mqtt', 'cube']], ['system', ['net', 'backup']]];
  const splitTab = (t) => { const i = t.indexOf(' '); return i > 0 ? [t.slice(0, i), t.slice(i + 1)] : ['', t]; };
  const tabBar = `<nav class="tabs" id="tabs">` + navGroups.map(([grp, ids]) => `<div class="navsec">${htmlEsc(S.navGroups[grp])}</div>` + ids.map((g) => {
    const [ic, lb] = splitTab(S.tabs[g]);
    return `<button type="button" class="tab${g === 'farm' ? ' active' : ''}" data-tab="${g}" data-title="${htmlEsc(lb)}" data-desc="${htmlEsc(S.tabDesc[g])}"><span class="ic">${ic}</span><span class="lb">${htmlEsc(lb)}</span><i class="tdot"></i></button>`;
  }).join('')).join('') + `</nav>`;
  const pageHead = `<div class="phead"><h2 id="ptitle">${htmlEsc(splitTab(S.tabs.farm)[1])}</h2><p id="pdesc">${htmlEsc(S.tabDesc.farm)}</p></div>`;
  const B = S.bx;
  const bxGroup = `<fieldset class="tab-pane" data-pane="miners"><legend>${htmlEsc(B.title)}</legend><div class="f"><div class="hint">${htmlEsc(B.help)}</div><div id="bx_actions" class="pools"></div></div></fieldset>`;
  const P = S.pools;
  const poolsGroup = `<fieldset class="tab-pane" data-pane="miners"><legend>${htmlEsc(P.title)}</legend>` +
    `<div class="f"><div class="hint">${htmlEsc(P.help)}</div><div class="hint" id="pools_factory" hidden>${htmlEsc(P.factory)}</div><div id="pools_list" class="pools"></div></div>` +
    `<div class="f"><label>${htmlEsc(P.howTitle)}</label><div class="hint">${htmlEsc(P.server)}: <code id="pools_hosts">–</code></div>` +
    `<div class="hint">${htmlEsc(P.user)}: <code id="pools_user">–</code> <span class="muted">(${htmlEsc(P.userHint)})</span> · ${htmlEsc(P.pass)}: <code>x</code></div>` +
    `<div class="how"><b>${htmlEsc(P.bitaxe)}</b><div class="hint" id="how_bitaxe"></div><b>${htmlEsc(P.nerd)}</b><div class="hint" id="how_nerd"></div><b>${htmlEsc(P.cpu)}</b><div class="hint"><code id="how_cpu"></code></div></div></div></fieldset>`;
  const fieldGroups = ['farm', 'miners', 'cube', 'telegram', 'mqtt', 'tuya'].map((g) => (g === 'miners' ? poolsGroup : '') + `<fieldset class="tab-pane${g === 'farm' ? ' active' : ''}" data-pane="${g}"><legend>${S.groups[g]}</legend>${FIELDS.filter((f) => f.group === g).map(field).join('')}</fieldset>`).join('');
  const D = S.dsc;
  const discoverGroup = `<fieldset class="tab-pane" data-pane="discover"><legend>${htmlEsc(S.groups.discover)}</legend><div class="f"><div class="hint">${htmlEsc(D.help)}</div>` +
    `<div class="bbar"><button type="button" class="ghost" id="dsc_run">${htmlEsc(D.run)}</button></div><div class="hint" id="dsc_msg"></div><div id="dsc_list" class="pools"></div></div></fieldset>`;
  const N = S.net;
  const netGroup = `<fieldset class="tab-pane" data-pane="net"><legend>${S.groups.net}</legend>` +
    `<div class="f"><div class="hint" id="net_msg">${htmlEsc(N.pinFirst)}</div><div class="bbar"><button type="button" class="ghost" id="net_refresh">${htmlEsc(N.refresh)}</button></div></div>` +
    `<div class="f" id="net_docker" hidden><label>${htmlEsc(N.dockerTitle)}</label>${N.dockerHelp.map((l) => `<div class="hint">${l}</div>`).join('')}</div>` +
    `<div class="f" id="net_wifi" hidden><label>${htmlEsc(N.wifi)}</label><div class="hint" id="wifi_state">–</div>` +
    `<div class="bbar"><button type="button" class="ghost" id="wifi_scan">${htmlEsc(N.scan)}</button><button type="button" class="ghost" id="wifi_forget" hidden>${htmlEsc(N.forget)}</button></div>` +
    `<div id="wifi_form" hidden style="margin-top:10px"><select id="wifi_ssid"></select><div class="pw" style="margin-top:8px"><input type="password" id="wifi_pass" autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="${htmlEsc(N.pass)}"><button type="button" class="ghost eye" data-eye="wifi_pass">👁</button></div>` +
    `<div class="bbar"><button type="button" class="ghost" id="wifi_connect">${htmlEsc(N.connect)}</button></div></div><div class="hint">${htmlEsc(N.wifiHint)}</div></div>` +
    `<div class="f" id="net_ts" hidden><label>${htmlEsc(N.ts)}</label><div class="hint">${htmlEsc(N.tsHint)}</div><div class="hint" id="ts_state">–</div>` +
    `<div class="bbar"><button type="button" class="ghost" id="ts_connect" hidden>${htmlEsc(N.tsConnect)}</button><a class="ghost tslink" id="ts_link" target="_blank" rel="noopener noreferrer" hidden>${htmlEsc(N.tsOpen)}</a>` +
    `<button type="button" class="ghost" id="ts_disconnect" hidden>${htmlEsc(N.tsDisconnect)}</button></div></div>` +
    `<div class="f" id="net_ssh" hidden><label>${htmlEsc(N.ssh)}</label><div class="hint">${htmlEsc(N.sshHint)}</div><div class="hint" id="ssh_state">–</div>` +
    `<textarea id="ssh_key" rows="3" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="${htmlEsc(N.sshKey)}" style="margin-top:8px;font-family:ui-monospace, Menlo, monospace;font-size:12px;resize:vertical"></textarea>` +
    `<div class="bbar"><button type="button" class="ghost" id="ssh_enable">${htmlEsc(N.sshEnable)}</button><button type="button" class="ghost" id="ssh_disable" hidden>${htmlEsc(N.sshDisable)}</button></div></div></fieldset>`;
  const backupGroup = `<fieldset class="tab-pane" data-pane="backup"><legend>${S.groups.backup}</legend><div class="f"><div class="hint">${htmlEsc(S.backupHelp)}</div>` +
    `<div class="bbar"><button type="button" class="ghost" data-backup="export">${htmlEsc(S.backupDown)}</button>` +
    `<button type="button" class="ghost" data-backup="restore">${htmlEsc(S.backupUp)}</button>` +
    `<input type="file" id="backup_file" accept=".json,application/json" hidden></div></div>` +
    `<div class="f"><label>${htmlEsc(S.verTitle)}</label><div class="hint" id="ver_info">…</div>` +
    `<div class="bbar"><button type="button" class="ghost" id="update_btn" hidden>${htmlEsc(S.updBtn)}</button></div><div class="hint" id="ver_why"></div></div></fieldset>`;
  const msgs = {
    saved: S.saved, back2: S.back2, nothing: S.nothing, cubeOk: S.cubeOk, cubeFail: S.cubeFail,
    tgOk: S.tgOk, tgFail: S.tgFail('%s'), mqttOk: S.mqttOk, mqttFail: S.mqttFail('%s'),
    tuyaOk: S.tuyaOk('%s'), tuyaFail: S.tuyaFail('%s'), tokenSet: S.tokenSet('%s'),
    tuyaNone: S.tuyaNone, tuyaAll: S.tuyaAll, testTuya: S.testTuya,
    dsc: S.dsc, bitaxeScanning: S.bitaxeScanning, bitaxeNone: S.bitaxeNone, bitaxeFail: S.bitaxeFail, bitaxeAdd: S.bitaxeAdd,
    plugTypes: S.plugTypes, phId: S.addPlugIdPlaceholder, phHost: S.addPlugHostPlaceholder,
    backupOk: S.backupOk, restored: S.restored, err: { ...S.err, cancel: S.pinCanceled },
    net: { ...N, wifiOn: N.wifiOn('%s', '%i') },
    pools: P,
    bx: B,
    verInstalled: S.verInstalled, verLatest: S.verLatest, verNew: S.verNew, verOk: S.verOk, updRunning: S.updRunning, updDone: S.updDone, updSame: S.updSame, updFail: S.updFail, updSlow: S.updSlow, updWhy: S.updWhy,
  };
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-br' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${S.title}</title>
<style>
  :root, body[data-theme="obsidian"] { --bg:#0e1117; --card:#171c26; --line:#252c3a; --txt:#e6e9ef; --dim:#8a93a6; --gold:#f2a900; --on-gold:#14161c; --gold-soft:rgba(242,169,0,.09); --ok:#3ecf8e; --warn:#e5534b; --shadow:none; --radius:12px; }
  body[data-theme="ocean"] { --bg:#0b111e; --card:#131c31; --line:#223254; --txt:#e2e8f0; --dim:#8ea0c2; --gold:#38bdf8; --on-gold:#081221; --gold-soft:rgba(56,189,248,.11); --ok:#34d399; --warn:#fb7185; --shadow:0 4px 18px rgba(0,0,0,.28); --radius:16px; }
  body[data-theme="neon"] { --bg:#0a111b; --card:#20272e; --line:#343d46; --txt:#eef2f5; --dim:#97a3ad; --gold:#36cf8c; --on-gold:#04140d; --gold-soft:rgba(54,207,140,.11); --ok:#52eeaf; --warn:#f87171; --shadow:0 4px 18px rgba(0,0,0,.3); --radius:14px; }
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
  .tcards { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-top:4px; }   /* 4 temas: 2 por linha */
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
  input:not([type=checkbox]), select, textarea { width:100%; max-width:100%; background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:9px 10px; font-size:15px; font-family:inherit; }
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
  .prow { display:grid; grid-template-columns:58px minmax(90px,0.9fr) minmax(200px,1.8fr) minmax(130px,1.1fr) 74px auto auto; gap:6px; align-items:center; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:7px 9px; }
  .prow input, .prow select { padding:6px 8px; font-size:13px; }
  .prow .p-id { font-family:ui-monospace, Menlo, monospace; font-size:12px; }
  .prow .p-wd { text-align:right; }
  .prow button { margin:0; padding:6px 9px; font-size:12px; }
  .prow .p-type { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:6px; padding:3px 5px; text-align:center; }
  /* nova tomada em duas linhas: tipo · apelido · Device ID ou IP / worker · watchdog · adicionar */
  .addw.addp { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr); gap:6px; }
  .addp > * { min-width:0; width:100%; padding:7px 9px; font-size:13px; }
  .addp #new_plug_name { font-size:14px; }
  .addp #new_plug_id { font-family:ui-monospace, Menlo, monospace; }
  .addp .addw-w { width:100%; text-align:left; }
  .addp button { white-space:nowrap; margin:0; }
  @media (max-width:640px) {
    .addw.addp { grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-areas:"type name" "id id" "worker wd" "add add"; }
    #new_plug_type { grid-area:type; } #new_plug_name { grid-area:name; } #new_plug_id { grid-area:id; }
    #new_plug_worker { grid-area:worker; } #new_plug_wd { grid-area:wd; } #add_plug_btn { grid-area:add; }
  }
  @media (max-width:640px) {
    /* celular: tipo + apelido / Device ID ou IP inteiro / worker + watchdog / testar + remover */
    .prow { grid-template-columns:64px 1fr 1fr 48px; grid-template-areas:"type name name name" "id id id id" "worker worker wd wd" "test test test del"; }
    .prow > :nth-child(1) { grid-area:type; } .prow > :nth-child(2) { grid-area:name; } .prow > :nth-child(3) { grid-area:id; }
    .prow > :nth-child(4) { grid-area:worker; } .prow > :nth-child(5) { grid-area:wd; } .prow > :nth-child(6) { grid-area:test; } .prow > :nth-child(7) { grid-area:del; }
    .prow .p-type { align-self:stretch; display:flex; align-items:center; justify-content:center; }
  }
  .bbar { display:flex; gap:10px; flex-wrap:wrap; margin-top:8px; }
  button { background:var(--gold); color:var(--on-gold); border:0; border-radius:8px; padding:10px 16px; font-size:15px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--gold); border:1px solid var(--gold); padding:6px 10px; font-size:13px; font-weight:500; margin-top:8px; }
  button:disabled { opacity:.5; cursor:default; }
  .pin-card { position:sticky; bottom:10px; z-index:10; box-shadow:0 8px 28px rgba(0,0,0,.35); padding-bottom:14px; }
  .bar { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; } .bar .f { flex:1; min-width:160px; margin:0; }
  #msg { margin-top:10px; font-size:14px; min-height:20px; } #msg.ok { color:var(--ok); } #msg.bad { color:var(--warn); }
  [hidden] { display:none !important; }
  a.tslink { display:inline-block; color:var(--gold); border:1px solid var(--gold); border-radius:8px; padding:6px 10px; font-size:13px; font-weight:600; margin-top:8px; text-decoration:none; }
  #wifi_ssid { width:100%; }
  .pools { margin-top:10px; display:grid; gap:6px; }
  .pool { border:1px solid var(--line); border-radius:10px; padding:8px 10px; }
  .pool .ph { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .pool .port { font-family:ui-monospace, Menlo, monospace; font-weight:700; color:var(--gold); font-size:15px; }
  .pool .pname { font-weight:600; }
  .pool .pst { margin-left:auto; font-size:12px; }
  .pool .pst.bad { color:var(--warn); }
  .pools .muted, .f .muted { color:var(--dim); font-size:12px; }
  .how { display:grid; gap:4px; margin-top:8px; }
  .how b { font-size:13px; margin-top:6px; }
  .how code, #pools_hosts, #pools_user { word-break:break-all; }
  .pw { display:flex; gap:6px; } .pw input { flex:1; } .pw .eye { margin:0; padding:6px 10px; }
  .nopin { color:var(--warn); font-size:13px; line-height:1.5; }
  .pinmodal { position:fixed; inset:0; z-index:100; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:16px; }
  .pinmodal[hidden] { display:none; }
  .pm-box { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; width:100%; max-width:360px; box-shadow:0 20px 50px rgba(0,0,0,.45); display:flex; flex-direction:column; gap:10px; }
  .pm-box b { font-size:16px; } .pm-box .hint { margin:0; }
  .pm-box input { font-size:20px; letter-spacing:.3em; text-align:center; }
  .pm-err { color:var(--warn); font-size:13px; min-height:16px; }
  .pm-box .bbar { justify-content:flex-end; margin:0; }
  .pin-card #msg { margin:0; }
  /* ---------- layout de console (nuvem / enterprise) ---------- */
  :root, body[data-theme] { --radius:8px; --shadow:none; --side:236px; --topbar:52px; }
  body { padding:0; max-width:none; margin:0; font-size:14px; font-family:Inter, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  .topbar { position:sticky; top:0; z-index:30; height:var(--topbar); display:flex; align-items:center; gap:10px; padding:0 20px; background:var(--card); border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:9px; color:var(--txt); text-decoration:none; font-size:15px; }
  .brand b { font-weight:650; letter-spacing:-.01em; }
  .logo { width:26px; height:26px; border-radius:6px; background:var(--gold); color:var(--on-gold); display:grid; place-items:center; font-size:14px; }
  .sep { color:var(--line); font-size:18px; } .crumb { color:var(--dim); } .grow { flex:1; }
  .badge { font:11px/1 ui-monospace, Menlo, monospace; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:4px 6px; }
  .back { border-radius:6px; padding:6px 12px; background:transparent; }
  .shell { display:grid; grid-template-columns:var(--side) minmax(0, 1fr); min-height:calc(100vh - var(--topbar)); }
  .side { position:sticky; top:var(--topbar); align-self:start; height:calc(100vh - var(--topbar)); overflow-y:auto; background:var(--card); border-right:1px solid var(--line); padding:10px 10px 24px; }
  .tabs { flex-direction:column; gap:1px; margin:0; padding:0; overflow:visible; }
  .navsec { font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--dim); padding:16px 10px 6px; }
  .tab { width:100%; justify-content:flex-start; text-align:left; background:transparent; border:0; border-radius:6px; padding:8px 10px; font-size:14px; font-weight:500; color:var(--txt); gap:10px; }
  .tab .ic { width:20px; text-align:center; filter:grayscale(1); opacity:.65; font-size:14px; }
  .tab .lb { flex:1; }
  .tab:hover { background:var(--gold-soft); color:var(--txt); }
  .tab.active { background:var(--gold-soft); color:var(--gold); font-weight:600; box-shadow:inset 3px 0 0 var(--gold); }
  .tab.active .ic { filter:none; opacity:1; }
  .tab.err { color:var(--warn); }
  .main { padding:28px 36px 130px; max-width:1080px; width:100%; }
  .phead { margin-bottom:22px; padding-bottom:18px; border-bottom:1px solid var(--line); }
  .phead h2 { font-size:22px; font-weight:600; letter-spacing:-.01em; }
  .phead p { color:var(--dim); margin-top:6px; font-size:14px; }
  fieldset { padding:0; margin-bottom:20px; border-radius:var(--radius); box-shadow:none; overflow:hidden; }
  fieldset.tab-pane { grid-template-columns:minmax(0, 1fr); gap:0; }
  fieldset.tab-pane.active { display:grid; }
  legend { float:left; width:100%; grid-column:1 / -1; padding:14px 20px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--bg) 35%, var(--card)); color:var(--txt); font-size:14px; font-weight:600; letter-spacing:0; text-transform:none; }
  .f, .f.half { grid-column:1 / -1; padding:18px 20px; margin:0; border-bottom:1px solid var(--line); }
  .f:last-child { border-bottom:0; }
  .f > label, .fl > label { display:block; font-size:14px; font-weight:600; margin-bottom:4px; }
  .fl .help { margin:0 0 10px; }
  .hint { font-size:12.5px; line-height:1.45; }
  input:not([type=checkbox]), select, textarea { border-radius:6px; padding:8px 10px; font-size:14px; }
  input:not([type=checkbox]):focus, select:focus, textarea:focus { outline:none; border-color:var(--gold); box-shadow:0 0 0 3px var(--gold-soft); }
  button { border-radius:6px; font-size:14px; padding:9px 16px; }
  button.ghost { background:var(--card); color:var(--txt); border:1px solid var(--line); padding:6px 12px; font-size:13px; font-weight:500; }
  button.ghost:hover:not(:disabled) { border-color:var(--gold); color:var(--gold); }
  a.tslink { border-radius:6px; }
  .tcard, .wrow, .prow, .pool { border-radius:6px; }
  @media (min-width:900px) {
    /* rótulo e ajuda à esquerda, campo à direita */
    .f[data-key] { display:grid; grid-template-columns:minmax(200px, 34%) minmax(0, 1fr); column-gap:32px; align-items:start; }
    .f[data-key] .fl .help { margin:0; }
  }
  /* barra de ações fixa no rodapé: PIN + salvar */
  fieldset.pin-card { position:fixed; left:var(--side); right:0; bottom:0; z-index:25; margin:0; border-radius:0; border-width:1px 0 0; padding:12px 36px; box-shadow:0 -6px 20px rgba(0,0,0,.18); overflow:visible; }
  .pin-card legend { display:none; }
  .pin-card .bar { align-items:center; max-width:1008px; }
  .pin-card .bar .f { padding:0; border:0; display:flex; align-items:center; gap:12px; flex:1; }
  .pin-card .bar .f input { max-width:200px; }
  .pin-card .bar .f .hint { margin:0; }
  .pin-card #msg { margin-top:6px; min-height:0; }
  @media (max-width:899px) {
    .shell { grid-template-columns:minmax(0, 1fr); }
    .side { position:sticky; top:var(--topbar); z-index:20; height:auto; border-right:0; border-bottom:1px solid var(--line); padding:6px 10px; }
    .tabs { flex-direction:row; overflow-x:auto; gap:4px; scrollbar-width:none; }
    .navsec { display:none; }
    .tab { width:auto; white-space:nowrap; padding:7px 10px; }
    .tab.active { box-shadow:inset 0 -2px 0 var(--gold); }
    .main { padding:18px 16px 120px; }
    .crumb, .sep, .badge { display:none; }
    .topbar { padding:0 12px; }
    .back { white-space:nowrap; font-size:13px; padding:6px 10px; }
    .pin-card .bar { flex-wrap:nowrap; gap:10px; }
    .pin-card .bar .hint { display:none; }
    .pin-card .bar button { white-space:nowrap; padding:9px 14px; }
    fieldset.pin-card { left:0; padding:10px 16px; }
    .pin-card .bar .f { flex-wrap:wrap; }
    .pin-card .bar .f input { max-width:none; flex:1; min-width:120px; }
  }
</style></head><body data-theme="${activeTheme}">
<header class="topbar"><a class="brand" href="/"><span class="logo">⛏</span><b>HomeMinerProxy</b></a><span class="sep">/</span><span class="crumb">${S.title}</span><span class="grow"></span><span class="badge" id="tb_ver" hidden></span><a class="back" href="/">${S.back}</a></header>
<form id="form" autocomplete="off">
<div class="shell"><aside class="side">${tabBar}</aside><main class="main">
${pageHead}
${fieldGroups}
${bxGroup}
${discoverGroup}
${netGroup}
${backupGroup}
<fieldset class="pin-card"><legend>${S.pin}</legend>
${hasPin ? `<div class="bar"><div class="f"><div id="msg"></div></div><button type="submit" id="save">${S.save}</button></div>` : `<p class="nopin">${S.noPin}</p>`}
${hasPin ? '' : '<div id="msg"></div>'}
</fieldset>
</main></div>
</form>
<div class="pinmodal" id="pinModal" hidden role="dialog" aria-modal="true" aria-labelledby="pm_title"><form class="pm-box" id="pm_form" autocomplete="off">
<b id="pm_title">${htmlEsc(S.pinAsk)}</b><p class="hint">${htmlEsc(S.pinHelp)}</p>
<input type="password" id="pm_pin" inputmode="numeric" autocomplete="one-time-code" placeholder="${htmlEsc(S.pin)}" aria-label="${htmlEsc(S.pin)}">
<div class="pm-err" id="pm_err"></div>
<div class="bbar"><button type="button" class="ghost" id="pm_cancel">${htmlEsc(S.pinCancel)}</button><button type="submit" id="pm_ok">${htmlEsc(S.pinOk)}</button></div>
</form></div>
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
  const tb = form.querySelector('.tab[data-tab="' + id + '"]');
  if (tb) { document.getElementById('ptitle').textContent = tb.dataset.title; document.getElementById('pdesc').textContent = tb.dataset.desc; }
  if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
  if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', '#' + id);
}
for (const b of form.querySelectorAll('.tab[data-tab]')) {
  b.addEventListener('click', () => selectTab(b.dataset.tab));
}
if (typeof location !== 'undefined' && location.hash) selectTab(location.hash.slice(1));
fetch('/api/config/version').then((r) => r.json()).then((v) => { if (v && v.version) { const b = document.getElementById('tb_ver'); b.textContent = 'v' + v.version; b.hidden = false; } }).catch(() => {});

// °C ou °F: os limites de temperatura dos Bitaxe seguem a unidade; ao trocar, os números são convertidos
let tempUnitNow = 'C';
const TRANGE = { BITAXE_TEMP_MAX: [40, 90], BITAXE_VR_MAX: [50, 110] };   // em °C, como o servidor valida
const tUnit = (c) => (tempUnitNow === 'F' ? Math.round(c * 9 / 5 + 32) + ' °F' : c + ' °C');
function tempUnitUI(from, to) {
  const u = String(to || '').toUpperCase() === 'F' ? 'F' : 'C';
  for (const inp of form.querySelectorAll('input[data-temp]')) {
    const base = { BITAXE_TEMP_MAX: 68, BITAXE_VR_MAX: 80 }[inp.name];
    inp.placeholder = u === 'F' ? String(Math.round(base * 9 / 5 + 32)) : String(base);
    if (from && from !== u && inp.value.trim() !== '' && Number.isFinite(Number(inp.value.replace(',', '.')))) {
      const n = Number(inp.value.replace(',', '.'));
      inp.value = String(Math.round(u === 'F' ? n * 9 / 5 + 32 : (n - 32) * 5 / 9));
    }
  }
  tempUnitNow = u;
  for (const h of form.querySelectorAll('.help[data-tpl]')) h.textContent = h.dataset.tpl.replace('{def}', tUnit(Number(h.dataset.def)));
  if (typeof window !== 'undefined' && typeof window.__bxReload === 'function') window.__bxReload();
}
if (el('TEMP_UNIT')) el('TEMP_UNIT').addEventListener('change', () => tempUnitUI(tempUnitNow, el('TEMP_UNIT').value));
function setThemeUI(val) {
  const th = ${JSON.stringify(THEMES)}.includes(val) ? val : 'obsidian';   // a lista vem do servidor (THEMES não existe no navegador)
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
    tuya: hasPlugs && (hasVal('TUYA_CLIENT_ID') || (stateValues.TUYA_PLUGS || []).every((p) => p.type === 'sonoff')),
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

async function testPlugById(devId, btn, plug) {
  if (btn) btn.disabled = true;
  try {
    const v = values();
    v.TUYA_DEVICE_ID = devId;
    const sonoff = plug && plug.type === 'sonoff';
    const r = await postPin('/api/config/test', sonoff
      ? { what: 'sonoff', values: { host: plug.host, deviceId: plug.deviceId } }
      : { what: 'tuya', values: v });
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
    const typeTag = document.createElement('span');
    typeTag.className = 'p-type';
    typeTag.textContent = p.type === 'sonoff' ? 'Sonoff' : 'Tuya';
    const idInp = document.createElement('input');
    idInp.type = 'text';
    idInp.className = 'p-id';
    if (p.type === 'sonoff') {
      idInp.value = p.host || '';
      idInp.placeholder = M.phHost;
      idInp.addEventListener('input', () => { p.host = idInp.value.trim(); });
    } else {
      idInp.value = p.deviceId || '';
      idInp.addEventListener('input', () => { p.deviceId = idInp.value.trim(); });
    }
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
    tBtn.addEventListener('click', () => testPlugById(p.type === 'sonoff' ? p.deviceId : idInp.value.trim(), tBtn, p));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ghost';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      stateValues.TUYA_PLUGS.splice(idx, 1);
      renderPlugs();
      updateTabDots();
    });
    row.append(typeTag, nInp, idInp, wSel, wdInp, tBtn, delBtn);
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
    else if (e.tagName === 'SELECT' && v === '' && e.dataset.empty) e.value = e.dataset.empty;   // vazio = o padrão (°C), que é a primeira opção
    else e.value = v;
  }
  setThemeUI(c.values && c.values.THEME);
  if (el('TEMP_UNIT') && !el('TEMP_UNIT').value) el('TEMP_UNIT').value = 'C';   // vazio = °C
  tempUnitUI(null, (c.values && c.values.TEMP_UNIT) || '');
  // minerador local: só aparece onde existe (imagens prontas com cpuminer)
  const lm = c.localMiner || {};
  for (const k of ['LOCAL_MINER', 'MINER_THREADS']) { const f = form.querySelector('.f[data-key="' + k + '"]'); if (f) f.hidden = !lm.available; }
  const th = el('MINER_THREADS'); if (th && lm.cores) th.placeholder = lm.defaultThreads + ' / ' + lm.cores;
  updateTabDots();
});

const addPlugBtn = document.getElementById('add_plug_btn'), newPlugName = document.getElementById('new_plug_name');
const newPlugType = document.getElementById('new_plug_type');
const newPlugId = document.getElementById('new_plug_id'), newPlugWorker = document.getElementById('new_plug_worker'), newPlugWd = document.getElementById('new_plug_wd');
if (addPlugBtn && newPlugId) {
  const syncType = () => { newPlugId.placeholder = newPlugType && newPlugType.value === 'sonoff' ? M.phHost : M.phId; };
  if (newPlugType) { newPlugType.addEventListener('change', syncType); syncType(); }
  const addP = () => {
    const devId = newPlugId.value.trim();
    if (!devId) return;
    const sonoff = newPlugType && newPlugType.value === 'sonoff';
    if (sonoff ? !/^[a-zA-Z0-9.\\-]{1,253}(:\\d{2,5})?$/.test(devId) : !/^[a-zA-Z0-9_-]{8,64}$/.test(devId)) { say(sonoff ? M.err.host : M.err.tuyaid, false); return; }
    const w = newPlugWorker ? newPlugWorker.value : '';
    const n = (newPlugName ? newPlugName.value.trim() : '') || (w && w !== '*' ? w : 'Tomada ' + ((stateValues.TUYA_PLUGS || []).length + 1));
    const wdRaw = newPlugWd ? newPlugWd.value.trim() : '';
    const wd = wdRaw ? Number(wdRaw) : 0;
    if (wdRaw && (!Number.isInteger(wd) || wd < 5 || wd > 1440)) { say(M.err.watchdog, false); return; }
    if (sonoff) {
      stateValues.TUYA_PLUGS = (stateValues.TUYA_PLUGS || []).filter((x) => x.host !== devId);
      stateValues.TUYA_PLUGS.push({ name: n, type: 'sonoff', host: devId, worker: w, watchdogMin: wd });
    } else {
      stateValues.TUYA_PLUGS = (stateValues.TUYA_PLUGS || []).filter((x) => x.deviceId !== devId);
      stateValues.TUYA_PLUGS.push({ name: n, deviceId: devId, worker: w, watchdogMin: wd });
    }
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
      const plugs = (stateValues.TUYA_PLUGS || []).map((p) => Object.assign({}, p)).filter((p) => p.deviceId || p.host);
      const pendingId = newPlugId && newPlugId.value.trim();
      if (pendingId && !plugs.some((p) => p.deviceId === pendingId || p.host === pendingId)) {
        const w = newPlugWorker ? newPlugWorker.value : '';
        const n = (newPlugName ? newPlugName.value.trim() : '') || (w && w !== '*' ? w : 'Tomada ' + (plugs.length + 1));
        const wd = newPlugWd && newPlugWd.value.trim() ? Number(newPlugWd.value.trim()) : 0;
        plugs.push(newPlugType && newPlugType.value === 'sonoff' ? { name: n, type: 'sonoff', host: pendingId, worker: w, watchdogMin: wd } : { name: n, deviceId: pendingId, worker: w, watchdogMin: wd });
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
// PIN: pedido num modal na primeira ação que precisa dele e guardado só enquanto a página está aberta
let pinCache = '';
function askPin(errText) {
  const m = document.getElementById('pinModal'), inp = document.getElementById('pm_pin');
  if (!m) return Promise.resolve(null);
  document.getElementById('pm_err').textContent = errText || '';
  inp.value = ''; m.hidden = false; setTimeout(() => inp.focus(), 0);
  return new Promise((resolve) => {
    const done = (v) => { m.hidden = true; f.removeEventListener('submit', ok); c.removeEventListener('click', no); document.removeEventListener('keydown', esc); resolve(v); };
    const f = document.getElementById('pm_form'), c = document.getElementById('pm_cancel');
    const ok = (ev) => { ev.preventDefault(); const v = inp.value.trim(); if (!v) { inp.focus(); return; } done(v); };
    const no = () => done(null);
    const esc = (ev) => { if (ev.key === 'Escape') done(null); };
    f.addEventListener('submit', ok); c.addEventListener('click', no); document.addEventListener('keydown', esc);
  });
}
async function postPin(url, body) {
  let errText = '';
  for (;;) {
    if (!pinCache) { const p = await askPin(errText); if (p == null) return { error: 'cancel' }; pinCache = p; }
    const r = await post(url, { ...body, pin: pinCache });
    if (r && r.error === 'wrong') { pinCache = ''; errText = M.err.wrong; continue; }
    if (r && (r.error === 'locked' || r.error === 'nopin')) pinCache = '';
    return r;
  }
}
function showErrors(errs) {
  let firstErrPane = null;
  for (const f of form.querySelectorAll('.f[data-key]')) {
    const e = errs[f.dataset.key];
    f.classList.toggle('bad', !!e);
    const ti = e === 'range' && f.querySelector('input[data-temp]');
    f.querySelector('.ferr').textContent = !e ? '' : ti ? M.err.rangeT.replace('{lo}', tUnit(TRANGE[ti.name][0])).replace('{hi}', tUnit(TRANGE[ti.name][1])) : M.err[e] || e;
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
// Versão instalada e botão de atualizar
const updBtn = document.getElementById('update_btn');
let verNow = null;
fetch('/api/config/version').then((r) => r.json()).then((v) => {
  verNow = v;
  const box = document.getElementById('ver_info');
  if (!v || !v.version) { box.textContent = '–'; return; }
  let t = M.verInstalled + ': v' + v.version + (v.commit ? ' (' + v.commit + ')' : '');
  if (v.latest) t += ' · ' + M.verLatest + ': v' + v.latest + ' · ' + (v.updateAvailable ? M.verNew : M.verOk);
  box.textContent = t;
  if (v.canUpdate) updBtn.hidden = false;
  else if (v.reason) document.getElementById('ver_why').textContent = M.updWhy[v.reason] || '';
}).catch(() => {});
if (updBtn) updBtn.addEventListener('click', async () => {
  updBtn.disabled = true;
  try {
    const started = Date.now();
    const r = await postPin('/api/config/update', {});
    if (r.error) { say(M.err[r.error] || M.updWhy[r.error] || r.error, false); return; }
    say(M.updRunning, true);
    // espera o painel voltar reinstalado: muda o installedAt (e o commit/versão, se havia coisa nova), até ~5 minutos
    const key = (v) => (v.commit || '') + '|' + v.version + '|' + (v.installedAt || '');
    const before = verNow ? key(verNow) : '';
    for (let i = 0; i < 100; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      try {
        const v = await fetch('/api/config/version', { cache: 'no-store' }).then((x) => x.json());
        const lu = v && v.lastUpdate;
        if (lu && lu.at && Date.parse(lu.at) >= started - 5000 && !lu.ok) {   // a atualização falhou: mostra o porquê
          say(M.updFail + ' ' + (lu.tail || []).slice(-6).join(' · '), false);
          return;
        }
        if (v && v.version && (key(v) !== before || (lu && lu.ok && Date.parse(lu.at) >= started - 5000))) {
          const same = verNow && (v.commit || '') + v.version === (verNow.commit || '') + verNow.version;
          say(M.updDone + ' v' + v.version + (same ? ' · ' + M.updSame : ''), true);
          setTimeout(() => { location.reload(); }, same ? 3500 : 1500);
          return;
        }
      } catch (_) { /* reiniciando */ }
    }
    say(M.updSlow, false);
  } finally { updBtn.disabled = false; }
});
// Ações nos Bitaxe (aba Mineradores): cada botão chama /api/config/bitaxe-action com o PIN
(() => {
  const B = M.bx, box = document.getElementById('bx_actions');
  if (!box) return;
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const btn = (txt, fn) => { const b = mk('button', 'ghost', txt); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); return b; };
  const act = async (name, action, params) => {
    const r = await postPin('/api/config/bitaxe-action', { name, action, params });
    if (r.error || r.ok === false) { say(r.error === 'fan' ? M.err.fanT.replace('{lo}', tUnit(50)).replace('{hi}', tUnit(70)) : M.err[r.error] || r.error || '?', false); return null; }
    return r;
  };
  function render(list) {
    box.textContent = '';
    if (!list.length) { box.appendChild(mk('div', 'hint', B.none)); return; }
    for (const b of list) {
      const row = mk('div', 'pool');
      const h = mk('div', 'ph');
      h.append(mk('span', 'pname', b.name), mk('span', 'muted', b.host));
      h.append(mk('span', 'pst' + (b.fresh ? ' muted' : ' bad'), b.fresh ? (b.paused ? B.paused : '✓') : '⚠️ ' + B.offline));
      row.appendChild(h);
      const bar = mk('div', 'bbar');
      bar.append(
        btn(B.restart, async () => { if (await act(b.name, 'restart')) say(B.done, true); }),
        btn(B.identify, async () => { if (await act(b.name, 'identify')) say(B.done, true); }),
        btn(b.paused ? B.resume : B.pause, async () => { if (await act(b.name, b.paused ? 'resume' : 'pause')) { say(B.done, true); setTimeout(load, 1500); } }),
        btn(B.point, async () => {
          const r = await act(b.name, 'point-preview');
          if (!r) return;
          if (r.same) { say(B.same, true); return; }
          const pv = mk('div', 'hint');
          pv.textContent = B.from + ': ' + (r.current.url || '–') + ':' + (r.current.port || '–') + (r.current.fallback ? ' (' + B.backupLbl + ')' : '') + '  →  ' + B.to + ': ' + r.next.url + ':' + r.next.port + ' · ' + r.next.user + ' · ' + B.backupLbl + ' ' + r.backup.url + ':' + r.backup.port;
          const yes = btn(B.confirm, async () => { if (await act(b.name, 'point')) { say(B.pointDone, true); pv.remove(); yes.remove(); no.remove(); } });
          const no = btn(B.cancel, async () => { pv.remove(); yes.remove(); no.remove(); });
          row.append(pv, yes, no);
        }));
      row.appendChild(bar);
      // fan: automático com alvo ou fixo
      const fan = mk('div', 'bbar');
      const mode = mk('select'); mode.style.maxWidth = '210px';
      for (const [v, t] of [['auto', B.fanAuto], ['fixed', B.fanFixed]]) { const o = mk('option', null, t); o.value = v; mode.appendChild(o); }
      mode.value = b.autoFan === false ? 'fixed' : 'auto';
      const val = mk('input'); val.inputMode = 'numeric'; val.maxLength = 3; val.style.maxWidth = '90px';
      const unit = mk('span', 'muted');
      // o AxeOS guarda o alvo em °C; a tela mostra na unidade escolhida e converte ao gravar
      const F = () => tempUnitNow === 'F', toU = (c) => (F() ? Math.round(c * 9 / 5 + 32) : c), toC = (v) => (F() ? Math.round((v - 32) * 5 / 9) : v);
      const sync = () => { const auto = mode.value === 'auto'; unit.textContent = auto ? (F() ? '°F' : '°C') : '%'; val.placeholder = auto ? String(toU(60)) : '70'; };
      val.value = b.autoFan === false ? (b.fanPct ?? '') : (b.tempTarget != null ? toU(b.tempTarget) : ''); sync();
      mode.addEventListener('change', () => { val.value = ''; sync(); });
      fan.append(mode, val, unit, btn(B.apply, async () => {
        const n = Number(val.value || val.placeholder);
        if (await act(b.name, 'fan', mode.value === 'auto' ? { auto: true, temptarget: toC(n) } : { auto: false, fanspeed: n })) say(B.done, true);
      }));
      row.appendChild(fan);
      if (b.lastAction) row.appendChild(mk('div', 'hint', B.last + ': ' + b.lastAction.action + ' · ' + new Date(b.lastAction.at).toLocaleTimeString() + (b.lastAction.ok ? '' : ' · ' + (M.err[b.lastAction.error] || b.lastAction.error))));
      box.appendChild(row);
    }
  }
  if (typeof window !== 'undefined') window.__bxReload = () => load();
  function load() { fetch('/api/config/bitaxes').then((r) => r.json()).then((d) => render(d.list || [])).catch((e) => console.error('bitaxe actions', e)); }
  load();
})();
// Guia "Pools e portas" (aba Mineradores)
(() => {
  const P = M.pools, $ = (id) => document.getElementById(id);
  const useOf = (host) => /nerdminers|bitronics/.test(host) ? P.use.nerd : /public-pool/.test(host) ? P.use.pub : /atlaspool/.test(host) ? P.use.atlas
    : /eusolo\\.ckpool/.test(host) ? P.use.ckeu : /ckpool/.test(host) ? P.use.ck : /ocean/.test(host) ? P.use.ocean : P.use.other;
  const txt = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = t; return e; };
  fetch('/api/config/pools').then((r) => r.json()).then((d) => {
    $('pools_factory').hidden = d.live;
    const list = $('pools_list');
    for (const r of d.routes) {
      const row = document.createElement('div'); row.className = 'pool';
      const h = document.createElement('div'); h.className = 'ph';
      h.append(txt('span', 'port', String(r.listen)), txt('span', 'pname', r.label));
      if (r.backups && r.backups.length) h.append(txt('span', 'muted', P.backup + ': ' + r.backups.join(', ')));
      if (d.live) h.append(r.down ? txt('span', 'pst bad', '⚠️ ' + P.down + ' ' + (r.active || '–')) : txt('span', 'pst muted', '✓' + (r.pingMs != null ? ' ' + Math.round(r.pingMs) + ' ' + P.ms : '')));
      row.append(h, txt('div', 'hint', useOf(r.host || '')));
      list.appendChild(row);
    }
    const host = (d.hosts || []).find((x) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(x)) || (d.hosts || [])[0] || location.hostname;
    $('pools_hosts').textContent = (d.hosts && d.hosts.length ? d.hosts : [location.hostname]).join('  ·  ');
    const user = (d.address || P.noAddr) + '.bitaxe1';
    $('pools_user').textContent = user;
    const portOf = (re, dflt) => (d.routes.find((r) => re.test(r.host || '')) || {}).listen || dflt;
    const asic = portOf(/atlaspool/, portOf(/ckpool/, 3334)), nerd = portOf(/nerdminers/, 3335), cpu = portOf(/public-pool/, 3333);
    const fill = (t, p, u) => t.replace('%h', host).replace('%p', p).replace('%u', u);
    $('how_bitaxe').textContent = fill(P.bitaxeHow, asic, user);
    $('how_nerd').textContent = fill(P.nerdHow, nerd, '');
    $('how_cpu').textContent = fill(P.cpuHow, cpu, (d.address || P.noAddr) + '.pc');
  }).catch(() => {});
})();
// Aba Rede: Wi-Fi e Tailscale (estado e ações só com o PIN)
(() => {
  const $ = (id) => document.getElementById(id);
  const N = M.net, msg = $('net_msg');
  const err = (r) => M.err[r && r.error] || (r && r.error) || '?';
  const netPost = (action, extra) => postPin('/api/config/net', { action, ...(extra || {}) });
  let wifiSsid = null;
  fetch('/api/config/net').then((r) => r.json()).then((c) => {
    $('net_wifi').hidden = !(c.wifi || c.wifiReason === 'noadapter');
    $('net_ts').hidden = !c.tailscale;
    if (c.tailscale) showTs({ available: true, state: c.tsState });   // só o estado; nome, IP e link vêm com o PIN
    $('net_ssh').hidden = !c.ssh;
    if (c.wifiReason === 'noadapter') { $('wifi_state').textContent = N.wifiNone; $('wifi_scan').hidden = true; }
    if (c.docker) { $('net_docker').hidden = false; }
    if (!c.wifi && c.wifiReason !== 'noadapter' && !c.tailscale && !c.ssh) { msg.textContent = c.docker ? '' : N.none; $('net_refresh').hidden = true; if (c.docker) msg.parentElement.hidden = true; }
    // esconde a aba se não há nada para mexer (no Docker ela fica, com as instruções para o host)
    if (!c.wifi && !c.tailscale && !c.ssh && !c.docker) { const t = document.querySelector('[data-tab="net"]'); if (t && c.wifiReason !== 'noadapter') t.hidden = true; }
  }).catch(() => {});
  function showTs(t) {
    if (!t || !t.available) return;
    const link = $('ts_link');
    link.hidden = !t.authUrl; if (t.authUrl) link.href = t.authUrl;
    $('ts_connect').hidden = t.state === 'connected';
    $('ts_disconnect').hidden = t.state === 'off';
    const short = (t.name || '').split('.')[0];
    $('ts_state').textContent = t.state === 'connected' ? N.tsOn.replace('%n', t.name || '?').replace('%i', (t.ips || [])[0] || '').replace('%h', short || 'homeminer')
      : t.state === 'login' ? N.tsLogin : t.state === 'starting' ? N.tsWait : N.tsOff;
  }
  function showWifi(w) {
    if (!w || !w.available) return;
    wifiSsid = w.ssid;
    $('wifi_state').textContent = (w.connected ? N.wifiOn.replace('%s', w.ssid).replace(' · IP %i', w.ip ? ' · IP ' + w.ip : '') : N.wifiOff) + (w.wired ? ' ' + N.wired : '');
    $('wifi_forget').hidden = !w.connected;
  }
  function showSsh(h) {
    if (!h || !h.available) return;
    const noBoot = h.active && h.enabled === false;   // ligado só até o próximo reinício (systemctl start)
    $('ssh_state').textContent = (h.active ? (h.managed ? N.sshOn : N.sshOutside) : N.sshOff) + (noBoot ? ' ' + N.sshNoBoot : '') + (h.keys.length ? ' ' + N.sshKeys + h.keys.join(' · ') : '');
    $('ssh_enable').textContent = noBoot ? N.sshPersist : h.active ? N.sshAdd : N.sshEnable;
    $('ssh_enable').dataset.persist = noBoot ? '1' : '';
    $('ssh_disable').hidden = !(h.active && h.managed);
  }
  async function refresh() {
    const r = await netPost('status');
    if (r.error) { say(err(r), false); return false; }
    msg.textContent = ''; showWifi(r.wifi); showTs(r.tailscale); showSsh(r.ssh);
    if (r.tailscale && r.tailscale.state === 'login') waitTsLogin();
    return true;
  }
  $('net_refresh').addEventListener('click', refresh);
  $('wifi_scan').addEventListener('click', async () => {
    const b = $('wifi_scan'); b.disabled = true; $('wifi_state').textContent = N.scanning;
    try {
      const r = await netPost('wifi-scan');
      if (r.error) { say(err(r), false); return; }
      const sel = $('wifi_ssid'); sel.textContent = '';
      for (const n of r.networks) { const o = document.createElement('option'); o.value = n.ssid; o.textContent = n.ssid + ' · ' + n.signal + '%' + (n.secure ? ' 🔒' : '') + (n.inUse ? ' ✓' : ''); sel.appendChild(o); }
      $('wifi_form').hidden = !r.networks.length;
      await refresh();
    } finally { b.disabled = false; }
  });
  $('wifi_connect').addEventListener('click', async () => {
    const b = $('wifi_connect'); b.disabled = true; say(N.connecting, true);
    try {
      const r = await netPost('wifi-connect', { ssid: $('wifi_ssid').value, password: $('wifi_pass').value });
      if (!r.ok) { say(err(r), false); return; }
      if (r.pending) { $('wifi_form').hidden = true; say(N.wifiAp.replace('%s', $('wifi_ssid').value), true); return; }   // estava no hotspot: a conexão cai agora
      $('wifi_pass').value = ''; $('wifi_form').hidden = true; say(N.wifiOk, true); await refresh();
    } catch (_) { say(N.wifiHint, false); } finally { b.disabled = false; }
  });
  $('wifi_forget').addEventListener('click', async () => {
    if (!wifiSsid) return;
    const r = await netPost('wifi-forget');
    if (!r.ok) say(err(r), false); else await refresh();
  });
  $('ts_connect').addEventListener('click', async () => {
    const b = $('ts_connect'); b.disabled = true; $('ts_state').textContent = N.tsWait;
    try {
      const r = await netPost('ts-connect');
      if (!r.ok) { say(err(r), false); return; }
      msg.textContent = ''; showTs(r.status);
      if (r.status && r.status.state === 'login') waitTsLogin();
    } finally { b.disabled = false; }
  });
  // depois de abrir o link e aprovar no site, a tela percebe sozinha (até 5 min)
  let tsWaiting = false;
  async function waitTsLogin() {
    if (tsWaiting) return; tsWaiting = true;
    try {
      for (let i = 0; i < 75; i++) {
        await new Promise((res) => setTimeout(res, 4000));
        const r = await netPost('status').catch(() => null);
        if (!r || r.error) return;
        showTs(r.tailscale);
        if (r.tailscale && r.tailscale.state === 'connected') { say(N.tsDone, true); return; }
      }
    } finally { tsWaiting = false; }
  }
  $('ssh_enable').addEventListener('click', async () => {
    const b = $('ssh_enable'); b.disabled = true;
    try {
      const r = await netPost('ssh-enable', { key: $('ssh_key').value });
      if (!r.ok) { say(err(r), false); return; }
      const persisted = b.dataset.persist === '1';
      $('ssh_key').value = ''; msg.textContent = ''; showSsh(r.status); say(persisted ? N.sshPersisted : N.sshDone, true);
    } finally { b.disabled = false; }
  });
  $('ssh_disable').addEventListener('click', async () => {
    const r = await netPost('ssh-disable');
    if (!r.ok) say(err(r), false); else showSsh(r.status);
  });
  $('ts_disconnect').addEventListener('click', async () => {
    const r = await netPost('ts-disconnect');
    if (!r.ok) say(err(r), false); else await refresh();
  });
})();
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
    const r = await postPin('/api/config', { values: values() });
    showErrors(r.errors || {});
    if (r.error) return say(M.err[r.error] || r.error, false);
    if (!r.restart) return say(M.nothing, true);
    await waitRestartAndGo(M.saved);
  } catch (_) { say('?', false); } finally { b.disabled = false; }
});
for (const b of form.querySelectorAll('[data-eye]')) b.addEventListener('click', () => { const e = el(b.dataset.eye); e.type = e.type === 'password' ? 'text' : 'password'; });
// Bitaxe: resultado do teste ou da procura na rede (texto montado sem innerHTML)
function fmtHs(h) { if (!(h > 0)) return '–'; const u = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s']; let i = 0; while (h >= 1000 && i < u.length - 1) { h /= 1000; i++; } return h.toFixed(h >= 100 ? 0 : h >= 10 ? 1 : 2) + ' ' + u[i]; }
function showBitaxes(list, found) {
  const box = document.getElementById('bitaxe_res'); box.textContent = '';
  if (!list.length) { say(M.bitaxeNone, false); return; }
  for (const b of list) {
    const row = document.createElement('div'); row.className = 'pool';
    const h = document.createElement('div'); h.className = 'ph';
    const n = document.createElement('span'); n.className = 'pname'; n.textContent = (b.name || b.worker || b.hostname || '?') + ' · ' + b.host; h.appendChild(n);
    const st = document.createElement('span'); st.className = 'pst' + (b.ok === false ? ' bad' : ' muted');
    st.textContent = b.ok === false ? '⚠️ ' + M.bitaxeFail : '✓ ' + [b.model, b.version, fmtHs(b.hashRate), b.tempC != null ? tUnit(b.tempC) : null, b.watts != null ? b.watts.toFixed(1) + ' W' : null].filter(Boolean).join(' · ');
    h.appendChild(st); row.appendChild(h); box.appendChild(row);
  }
  if (found) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ghost'; btn.textContent = M.bitaxeAdd;
    btn.addEventListener('click', () => {
      const used = new Set();
      el('BITAXES').value = list.map((b, i) => { let nm = String(b.worker || b.hostname || 'bitaxe' + (i + 1)).replace(/[^\\w.\\-]/g, '').slice(0, 32) || 'bitaxe' + (i + 1); while (used.has(nm)) nm += 'x'; used.add(nm); return nm + '=' + b.host; }).join(', ');
    });
    box.appendChild(btn);
  }
}
// ---------- descobrir mineradores na rede
const dscBtn = document.getElementById('dsc_run');
function dscRender(list, docker) {
  const D = M.dsc, box = document.getElementById('dsc_list'), m = document.getElementById('dsc_msg');
  box.textContent = '';
  m.textContent = list.length ? D.count.replace('%s', list.length) : D.none + (docker ? ' ' + D.docker : '');
  for (const d of list) {
    const row = document.createElement('div'); row.className = 'pool';
    const h = document.createElement('div'); h.className = 'ph';
    const n = document.createElement('span'); n.className = 'pname';
    n.textContent = [d.name || d.worker || d.proxyWorker, d.model || D.kinds[d.kind]].filter(Boolean).join(' · ') + ' · ' + d.ip;
    h.appendChild(n);
    if (d.kind === 'axeos') { const a = document.createElement('a'); a.href = 'http://' + d.ip + '/'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = D.open; a.className = 'muted'; h.appendChild(a); }
    const st = document.createElement('span'); st.className = 'pst' + (d.via === 'proxy' ? ' muted' : ' bad');
    st.textContent = (d.via === 'proxy' ? '✓ ' : '⚠️ ') + D.via[d.via].replace('%s', d.pool ? d.pool.url + (d.pool.port ? ':' + d.pool.port : '') : '') + (d.proxyWorker ? ' (' + D.worker + ' ' + d.proxyWorker + ')' : '');
    h.appendChild(st); row.appendChild(h);
    const info = [];
    if (d.hashRate > 0) info.push(fmtHs(d.hashRate));
    if (d.registered) info.push(D.registered.replace('%s', d.registered));
    if (d.mac) info.push(d.mac);
    const hints = [];
    if (d.kind === 'esp32') hints.push(D.esp);
    if (d.via !== 'proxy') hints.push(d.kind === 'esp32' ? D.espHint : d.kind === 'cgminer' ? D.cgHint : d.kind === 'axeos' && !d.registered ? D.axeHint : '');
    let axeTip = null;
    for (const t of [info.join(' · '), ...hints].filter(Boolean)) { const x = document.createElement('div'); x.className = 'hint'; x.textContent = t; row.appendChild(x); if (t === D.axeHint) axeTip = x; }
    if (d.kind === 'axeos' && !d.registered) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = D.add; b.style.marginTop = '6px';
      b.addEventListener('click', () => {
        const cur = String(el('BITAXES').value || '').trim();
        const used = new Set(cur.split(',').map((x) => x.split('=')[0].trim()));
        let nm = String(d.worker || d.name || 'bitaxe').replace(/[^\\w.\\-]/g, '').slice(0, 32) || 'bitaxe';
        while (used.has(nm)) nm += 'x';
        el('BITAXES').value = (cur ? cur + ', ' : '') + nm + '=' + d.ip;
        el('BITAXES').dispatchEvent(new Event('input', { bubbles: true }));
        d.registered = nm; b.remove(); if (axeTip) axeTip.textContent = D.added; say(D.added, true);
      });
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}
if (dscBtn) dscBtn.addEventListener('click', async () => {
  dscBtn.disabled = true; document.getElementById('dsc_msg').textContent = M.dsc.running;
  try {
    const r = await postPin('/api/config/test', { what: 'discover', values: values() });
    if (r.error) { document.getElementById('dsc_msg').textContent = ''; say(M.err[r.error] || r.error, false); } else dscRender(r.found || [], r.docker);
  } catch (_) { document.getElementById('dsc_msg').textContent = ''; }
  finally { dscBtn.disabled = false; }
});
const scanBtn = document.getElementById('bitaxe_scan');
if (scanBtn) scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true; say(M.bitaxeScanning, true);
  try {
    const r = await postPin('/api/config/test', { what: 'bitaxe-scan', values: values() });
    if (r.error) say(M.err[r.error] || r.error, false); else { say('', true); showBitaxes(r.found || [], true); }
  } finally { scanBtn.disabled = false; }
});
for (const t of form.querySelectorAll('[data-test]')) t.addEventListener('click', async () => {
  t.disabled = true;
  try {
    const v = values();
    const r = await postPin('/api/config/test', { what: t.dataset.test, values: v });
    showErrors(r.errors || {});
    if (r.error) say(M.err[r.error] || r.error, false);
    else if (t.dataset.test === 'bitaxe') showBitaxes(r.bitaxes || [], false);
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
    const r = await postPin('/api/config/backup', {});
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
      const r = await postPin('/api/config/restore', { backup: parsed });
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
    const lm = require('./localminer');
    json(200, { values: current(), workers: ctx.workers(), pin: !!pinEnv, localMiner: { available: lm.available(), cores: lm.cores(), defaultThreads: lm.defaultThreads() } });
    return true;
  }
  if (url === '/api/config/bitaxes' && req.method === 'GET') {
    json(200, { list: ctx.bitaxeList ? ctx.bitaxeList() : [] });
    return true;
  }
  if (url === '/api/config/pools' && req.method === 'GET') {
    // guia "Pools e portas": as portas do proxy (ao vivo) ou as de fábrica, e onde apontar os mineradores
    const p = (ctx.pools && ctx.pools()) || {};
    json(200, { live: !!p.routes, routes: p.routes || DEFAULT_ROUTES, hosts: p.hosts || [], address: p.address || null });
    return true;
  }
  if (url === '/api/config/net' && req.method === 'GET') {
    // só diz o que existe; estado, redes e o link do Tailscale ficam atrás do PIN (POST)
    const net = require('./netctl');
    Promise.all([net.wifiStatus(), net.tailscaleStatus(), net.sshStatus()]).then(([w, t, h]) => json(200, { wifi: !!w.available, wifiReason: w.reason || null, tailscale: !!t.available, tsState: t.state || null, ssh: !!h.available, docker: fs.existsSync('/.dockerenv') || !!process.env.container }))
      .catch(() => json(200, { wifi: false, tailscale: false }));
    return true;
  }
  if (url === '/api/config/version' && req.method === 'GET') {
    require('./update').status(ctx.appDir || __dirname).then((st) => {
      const { repo, ...pub } = st;   // a pasta do repositório não precisa sair do servidor
      json(200, pub);
    }).catch(() => json(200, { version: null }));
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
    if (url === '/api/config/bitaxe-action') {
      if (!ctx.bitaxeAction) return json(400, { error: 'nobitaxe' });
      const allowed = ['restart', 'identify', 'pause', 'resume', 'fan', 'point-preview', 'point'];
      if (!allowed.includes(j.action) || typeof j.name !== 'string') return json(400, { error: 'action' });
      return json(200, await ctx.bitaxeAction(j.name, j.action, j.params && typeof j.params === 'object' ? j.params : {}));
    }
    if (url === '/api/config/net') {
      const net = require('./netctl');
      const a = String(j.action || '');
      if (a === 'status') { const [wifi, tailscale, ssh] = await Promise.all([net.wifiStatus(), net.tailscaleStatus({ withUrl: true }), net.sshStatus()]); return json(200, { wifi, tailscale, ssh }); }
      if (a === 'ssh-enable') return json(200, await net.sshEnable(j.key));
      if (a === 'ssh-disable') return json(200, await net.sshDisable());
      // no hotspot o rádio está no modo AP: a busca usa a lista guardada e a troca de rede vem depois da resposta
      const hs = require('./hotspot'), hst = a === 'wifi-scan' || a === 'wifi-connect' ? await hs.status().catch(() => null) : null;
      if (a === 'wifi-scan') return json(200, hst && hst.active ? { ok: true, networks: hst.networks, hotspot: true } : await net.wifiScan());
      if (a === 'wifi-connect' && hst && hst.active) {
        const bad = hs.checkWifiForm(j.ssid, j.password);
        if (bad) return json(200, { ok: false, error: bad });
        json(200, { ok: true, pending: true });
        setTimeout(() => hs.connectFromAp(j.ssid, j.password).catch(() => {}), 1500);
        return undefined;
      }
      if (a === 'wifi-connect') return json(200, await net.wifiConnect(j.ssid, j.password));
      if (a === 'wifi-forget') return json(200, await net.wifiForget());
      if (a === 'ts-connect') return json(200, await net.tailscaleConnect());
      if (a === 'ts-disconnect') return json(200, await net.tailscaleDisconnect());
      return json(400, { error: 'option' });
    }
    if (url === '/api/config/update') {
      const r = require('./update').runUpdate(ctx.appDir || __dirname);
      return json(r.ok ? 200 : 409, r.ok ? { ok: true, restart: true } : { error: r.error });
    }
    const S = T[ctx.lang] || T.en;
    if (url === '/api/config/test') {
      if (j.what === 'bitaxe') {
        const bx = require('./bitaxe');
        const list = bx.parseList(form.BITAXES);
        if (!list || !list.length) return json(400, { error: 'fix', errors: { BITAXES: 'bitaxes' } });
        const out = await Promise.all(list.map(async (b) => {
          const r = await bx.info(b.host);
          return r.ok ? { name: b.name, host: b.host, ok: true, model: r.data.model, version: r.data.version, worker: r.data.worker, hashRate: r.data.hashRate, tempC: r.data.tempC, watts: r.data.watts }
            : { name: b.name, host: b.host, ok: false, error: r.error };
        }));
        return json(200, { ok: out.every((x) => x.ok), bitaxes: out });
      }
      if (j.what === 'discover') {
        const p = (ctx.pools && ctx.pools()) || {};
        const k = (ctx.discoverKnown && ctx.discoverKnown()) || {};
        const hn = require('os').hostname().split('.')[0];
        const found = await require('./discover').scan(require('./setup').lanAddresses(), {
          known: { ourHosts: [...(p.hosts || []), hn], workers: k.workers || {}, bitaxes: require('./bitaxe').parseList(form.BITAXES) || [] } });
        return json(200, { ok: true, found, docker: fs.existsSync('/.dockerenv') || !!process.env.container });
      }
      if (j.what === 'bitaxe-scan') {
        const found = await require('./bitaxe').discover(require('./setup').lanAddresses());
        return json(200, { ok: true, found });
      }
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
      if (j.what === 'sonoff') {
        const r = await testSonoff(String(form.host || '').trim(), String(form.deviceId || '').trim());
        return json(200, { ok: r.ok, status: r.status, detail: r.error });
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

module.exports = { savePin, loadPin, THEMES, normTheme, FIELDS, BACKUP_FILES, applyOverlay, readOverlay, parseHr, clean, current, merge, save, exportBackup, restoreBackup, checkPin, resetPinFails, testCube, testTelegram, page, handle };
