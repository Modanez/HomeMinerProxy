// Tela de configurações: edita, pelo navegador, parte do que fica em /etc/mineracao.env.
// O que é salvo aqui vai para DATA_DIR/settings.json e vale por cima do .env (o .env continua
// valendo para o que não foi mudado na tela). Salvar exige o SETTINGS_PIN, e o painel reinicia
// sozinho para aplicar (systemd e Docker sobem ele de novo). O cubo percebe a mudança e reinicia também.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const FIELDS = [
  { key: 'BTC_ADDRESS', group: 'farm', type: 'address', required: true },
  { key: 'LANGUAGE', group: 'farm', type: 'select', options: ['', 'pt-BR', 'en'] },
  { key: 'CURRENCY', group: 'farm', type: 'select', options: ['', 'BRL', 'USD'] },
  { key: 'POWER_PRICE_KWH', group: 'farm', type: 'price', alias: 'TARIFA_KWH' },
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
  if (f.type === 'bool') return raw === '1' ? '1' : '0';
  if (f.type === 'watts' || f.type === 'expected') {
    if (!raw) return '';
    const r = cleanMap(raw, f.type);
    return r.error ? String(raw) : r.value;
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
  let v = raw;
  if (field.type === 'workers') v = Array.isArray(raw) ? raw.map(String) : String(raw || '').split(',');
  else if (field.type === 'bool') v = raw === true || raw === '1' || raw === 'true' ? '1' : '0';
  else v = String(raw == null ? '' : raw).trim();
  switch (field.type) {
    case 'address':
      if (/^bc1/i.test(v) || /^tb1/i.test(v)) v = v.toLowerCase();
      return ADDRESS_RE.test(v) ? { value: v } : { error: 'address' };
    case 'select':
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
      if (String(form[f.key] || '').trim() === '') continue;   // vazio = manter o token atual
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
      hist.push({ t: Math.round(t), hr: Math.round(hr) });
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
    groups: { farm: 'Fazenda', miners: 'Mineradores', cube: 'Cubo GeekMagic', telegram: 'Bot do Telegram', backup: 'Backup e restauração' },
    BTC_ADDRESS: ['Endereço de bitcoin', 'O endereço público que os mineradores usam como usuário. O painel consulta pools e carteira por ele. Mudar aqui não muda para onde os mineradores mandam o prêmio: isso vem do usuário configurado em cada um.'],
    LANGUAGE: ['Idioma padrão', 'Do painel, do cubo e do bot. O botão PT | EN continua valendo em cada navegador.'],
    CURRENCY: ['Moeda', 'Cotação, prêmio e conta de luz.'],
    POWER_PRICE_KWH: ['Preço do kWh', 'Na moeda escolhida, para a estimativa da conta de luz.'],
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
    auto: 'Automático', none: 'Nenhum', yes: 'Sim',
    addWorkerPlaceholder: 'Nome do worker (ex.: bitaxe)', addWattsPlaceholder: 'W (ex.: 20)', addHrPlaceholder: 'Hashrate (ex.: 1.2)', addWorkerBtn: '+ Adicionar worker',
    tokenSet: (t) => `configurado (termina em ${t}). Deixe vazio para manter.`, tokenClear: 'Remover o token',
    backupHelp: 'Baixe ou restaure recordes, histórico, workers e configurações num único arquivo JSON (pede o PIN abaixo).',
    backupDown: '⬇ Baixar backup', backupUp: '⬆ Restaurar backup…',
    backupOk: 'Backup baixado.', restored: 'Backup restaurado! Reiniciando o painel…',
    pin: 'PIN', pinHelp: 'O SETTINGS_PIN que está em /etc/mineracao.env (o instalador cria e mostra no final).',
    noPin: 'Para salvar por aqui, defina SETTINGS_PIN em /etc/mineracao.env e reinicie o painel. Rode o install.sh de novo que ele cria um PIN para você.',
    save: 'Salvar e reiniciar', testCube: 'Testar cubo', testTg: 'Mandar mensagem de teste',
    saved: 'Salvo! Reiniciando o painel…', back2: 'Pronto. Voltando ao painel…', nothing: 'Nada mudou.',
    cubeOk: 'O cubo respondeu.', cubeFail: 'O cubo não respondeu nesse IP.',
    tgOk: 'Mensagem enviada. Confira o Telegram.', tgFail: (e) => `Não enviou: ${e}`, tgTest: '✅ Teste do painel da fazenda: o bot está funcionando!',
    err: { address: 'Endereço inválido', option: 'Opção inválida', price: 'Use um número entre 0 e 100', watts: 'Use watts entre 0 e 100000', expected: 'Hashrate inválido (ex.: 1.2 TH/s ou 350 kH/s)', backup: 'Arquivo de backup inválido', name: 'Nome inválido', host: 'IP inválido', token: 'Não parece um token do Telegram. Toque em 👁 para conferir: o certo tem só o token, assim: 1234567890:AAH… (números, dois-pontos e uns 35 caracteres). O navegador pode ter preenchido uma senha salva no lugar.', chatid: 'O id do chat é um número (ex.: 8983008026), não o nome do bot. Mande /start para o bot: ele responde com o número.', nochat: 'o Telegram não achou esse chat. Abra o bot no Telegram e toque em Iniciar (/start): bots só escrevem para quem já falou com eles. Confira também se o id é o número que o bot respondeu.', hour: 'Hora de 0 a 23', url: 'Comece com http:// ou https://', wrong: 'PIN errado', locked: 'Muitas tentativas erradas. Espere 15 minutos.', nopin: 'SETTINGS_PIN não definido', missing: 'Preencha o token e o id do chat', fix: 'Corrija os campos marcados.' },
  },
  en: {
    title: 'Settings', back: '← Back to the dashboard',
    groups: { farm: 'Farm', miners: 'Miners', cube: 'GeekMagic cube', telegram: 'Telegram bot', backup: 'Backup and restore' },
    BTC_ADDRESS: ['Bitcoin address', 'The public address your miners use as username. The dashboard looks up pools and the wallet with it. Changing it here does not change where the miners send the reward: that comes from the username set on each miner.'],
    LANGUAGE: ['Default language', 'For the dashboard, cube and bot. The PT | EN button still works per browser.'],
    CURRENCY: ['Currency', 'BTC price, prize and power bill.'],
    POWER_PRICE_KWH: ['Price per kWh', 'In the chosen currency, for the power bill estimate.'],
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
    auto: 'Automatic', none: 'None', yes: 'Yes',
    addWorkerPlaceholder: 'Worker name (e.g. bitaxe)', addWattsPlaceholder: 'W (e.g. 20)', addHrPlaceholder: 'Hashrate (e.g. 1.2)', addWorkerBtn: '+ Add worker',
    tokenSet: (t) => `set (ends in ${t}). Leave empty to keep it.`, tokenClear: 'Remove the token',
    backupHelp: 'Download or restore records, history, workers and settings in a single JSON file (requires the PIN below).',
    backupDown: '⬇ Download backup', backupUp: '⬆ Restore backup…',
    backupOk: 'Backup downloaded.', restored: 'Backup restored! Restarting the dashboard…',
    pin: 'PIN', pinHelp: 'The SETTINGS_PIN in /etc/mineracao.env (the installer creates it and shows it at the end).',
    noPin: 'To save from here, set SETTINGS_PIN in /etc/mineracao.env and restart the dashboard. Running install.sh again creates a PIN for you.',
    save: 'Save and restart', testCube: 'Test cube', testTg: 'Send test message',
    saved: 'Saved! Restarting the dashboard…', back2: 'Done. Going back to the dashboard…', nothing: 'Nothing changed.',
    cubeOk: 'The cube answered.', cubeFail: 'The cube did not answer at that IP.',
    tgOk: 'Message sent. Check Telegram.', tgFail: (e) => `Not sent: ${e}`, tgTest: '✅ Mining farm dashboard test: the bot is working!',
    err: { address: 'Invalid address', option: 'Invalid option', price: 'Use a number from 0 to 100', watts: 'Use watts from 0 to 100000', expected: 'Invalid hashrate (e.g. 1.2 TH/s or 350 kH/s)', backup: 'Invalid backup file', name: 'Invalid name', host: 'Invalid IP', token: 'This does not look like a Telegram token. Tap 👁 to check it: it should be just the token, like 1234567890:AAH… (digits, a colon and about 35 characters). The browser may have filled in a saved password instead.', chatid: 'The chat id is a number (e.g. 8983008026), not the bot name. Send /start to the bot: it replies with the number.', nochat: 'Telegram could not find that chat. Open the bot in Telegram and tap Start (/start): bots can only write to people who talked to them first. Also check that the id is the number the bot replied with.', hour: 'Hour from 0 to 23', url: 'Start with http:// or https://', wrong: 'Wrong PIN', locked: 'Too many wrong tries. Wait 15 minutes.', nopin: 'SETTINGS_PIN is not set', missing: 'Fill in the token and the chat id', fix: 'Fix the highlighted fields.' },
  },
};

const htmlEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(lang, hasPin) {
  const S = T[lang] || T.en;
  const field = (f) => {
    const [label, help] = S[f.key];
    let input;
    if (f.type === 'select') {
      input = `<select name="${f.key}">` + f.options.map((o) => `<option value="${o}">${o === '' ? S.auto : o}</option>`).join('') + '</select>';
    } else if (f.type === 'worker') {
      input = `<select name="${f.key}" data-workers="1"><option value="">${S.none}</option></select>`;
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
    } else if (f.type === 'bool') {
      input = `<label class="inline"><input type="checkbox" name="${f.key}"> ${S.yes}</label>`;
    } else if (f.type === 'secret') {
      input = `<div class="pw"><input type="password" name="${f.key}" autocomplete="new-password" spellcheck="false" autocapitalize="off"><button type="button" class="ghost eye" data-eye="${f.key}">👁</button></div><div class="hint" id="${f.key}_state"></div>` +
        `<label class="inline" id="${f.key}_clearbox" hidden><input type="checkbox" name="${f.key}_clear"> ${S.tokenClear}</label>`;
    } else {
      const extra = f.type === 'price' ? ' inputmode="decimal"' : f.type === 'hour' ? ' inputmode="numeric" maxlength="2"' : '';
      input = `<input name="${f.key}"${extra} autocomplete="off" spellcheck="false">`;
    }
    const test = f.key === 'CUBE_IP' ? ` <button type="button" class="ghost" data-test="cube">${S.testCube}</button>`
      : f.key === 'TELEGRAM_CHAT_ID' ? ` <button type="button" class="ghost" data-test="telegram">${S.testTg}</button>` : '';
    return `<div class="f" data-key="${f.key}"><label>${htmlEsc(label)}</label>${input}${test}<div class="hint">${htmlEsc(help)}</div><div class="ferr"></div></div>`;
  };
  const fieldGroups = ['farm', 'miners', 'cube', 'telegram'].map((g) => `<fieldset><legend>${S.groups[g]}</legend>${FIELDS.filter((f) => f.group === g).map(field).join('')}</fieldset>`).join('');
  const backupGroup = `<fieldset><legend>${S.groups.backup}</legend><div class="f"><div class="hint">${htmlEsc(S.backupHelp)}</div>` +
    `<div class="bbar"><button type="button" class="ghost" data-backup="export">${htmlEsc(S.backupDown)}</button>` +
    `<button type="button" class="ghost" data-backup="restore">${htmlEsc(S.backupUp)}</button>` +
    `<input type="file" id="backup_file" accept=".json,application/json" hidden></div></div></fieldset>`;
  const msgs = {
    saved: S.saved, back2: S.back2, nothing: S.nothing, cubeOk: S.cubeOk, cubeFail: S.cubeFail,
    tgOk: S.tgOk, tgFail: S.tgFail('%s'), tokenSet: S.tokenSet('%s'),
    backupOk: S.backupOk, restored: S.restored, err: S.err,
  };
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-br' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${S.title}</title>
<style>
  :root { --bg:#0e1117; --card:#171c26; --line:#252c3a; --txt:#e6e9ef; --dim:#8a93a6; --gold:#f2a900; --ok:#3ecf8e; --warn:#e5534b; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt); font-family:-apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; max-width:760px; margin:0 auto; }
  h1 { font-size:22px; margin:6px 0 14px; } h1 a { color:var(--dim); font-size:13px; font-weight:400; text-decoration:none; display:block; margin-bottom:8px; }
  fieldset { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px 6px; margin-bottom:14px; }
  legend { color:var(--gold); font-size:12px; letter-spacing:.08em; text-transform:uppercase; padding:0 6px; }
  .f { margin-bottom:14px; } .f > label { display:block; font-size:14px; margin-bottom:5px; font-weight:600; }
  input:not([type=checkbox]), select { width:100%; max-width:100%; background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:9px 10px; font-size:15px; font-family:inherit; }
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
  .bbar { display:flex; gap:10px; flex-wrap:wrap; margin-top:6px; }
  button { background:var(--gold); color:#111; border:0; border-radius:8px; padding:10px 16px; font-size:15px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--gold); border:1px solid var(--gold); padding:6px 10px; font-size:13px; font-weight:500; margin-top:8px; }
  button:disabled { opacity:.5; cursor:default; }
  .bar { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; } .bar .f { flex:1; min-width:160px; margin:0; }
  #msg { margin-top:12px; font-size:14px; min-height:20px; } #msg.ok { color:var(--ok); } #msg.bad { color:var(--warn); }
  [hidden] { display:none !important; }
  .pw { display:flex; gap:6px; } .pw input { flex:1; } .pw .eye { margin:0; padding:6px 10px; }
  .nopin { color:var(--warn); font-size:13px; line-height:1.5; }
</style></head><body>
<h1><a href="/">${S.back}</a>⚙️ ${S.title}</h1>
<form id="form" autocomplete="off">
${fieldGroups}
${backupGroup}
<fieldset><legend>${S.pin}</legend>
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
let workers = [], stateValues = { ALARM_IGNORE: [], WATTS: {}, EXPECTED: {} };

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
    while (s.options.length > 1) s.remove(1);
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
}

fetch('/api/config').then((r) => r.json()).then((c) => {
  const exp = (c.values && c.values.EXPECTED) || {};
  const extra = new Set([...(c.workers || []), ...Object.keys(exp).filter((k) => exp[k] > 0)]);
  workers = [...extra].sort((a, b) => a.localeCompare(b));
  stateValues.ALARM_IGNORE = (c.values && c.values.ALARM_IGNORE) || [];
  stateValues.WATTS = Object.assign({}, (c.values && c.values.WATTS) || {});
  stateValues.EXPECTED = Object.assign({}, (c.values && c.values.EXPECTED) || {});
  renderWorkerControls();
  for (const [k, v] of Object.entries(c.values)) {
    if (k === 'ALARM_IGNORE' || k === 'WATTS' || k === 'EXPECTED') continue;
    const e = el(k); if (!e) continue;
    if (e.type === 'checkbox') e.checked = !!v;
    else if (e.type === 'password') { document.getElementById(k + '_state').textContent = v.set ? M.tokenSet.replace('%s', v.tail) : ''; document.getElementById(k + '_clearbox').hidden = !v.set; }
    else if (e.tagName === 'SELECT' && v && ![...e.options].some((o) => o.value === v)) { e.add(new Option(v, v)); e.value = v; }
    else e.value = v;
  }
});

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
    const e = el(k);
    out[k] = e.type === 'checkbox' ? e.checked : e.value;
    if (el(k + '_clear')) out[k + '_clear'] = el(k + '_clear').checked;
  }
  return out;
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const pin = () => (el('pin') || {}).value || '';
function showErrors(errs) {
  for (const f of form.querySelectorAll('.f[data-key]')) { const e = errs[f.dataset.key]; f.classList.toggle('bad', !!e); f.querySelector('.ferr').textContent = e ? M.err[e] || e : ''; }
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

module.exports = { FIELDS, BACKUP_FILES, applyOverlay, readOverlay, parseHr, clean, current, merge, save, exportBackup, restoreBackup, checkPin, resetPinFails, testCube, testTelegram, page, handle };
