// Painel da fazenda de mineração — servidor único, sem dependências.
// Uso: BTC_ADDRESS=bc1... node painel.js
// Toda a configuração vem de variáveis de ambiente (veja config/mineracao.env.example).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pickLang, localizePage, LOCALES, WIDGET } = require('./i18n');
const { luckOf, theoreticalShare, weeklyStandings, evaluateAchievements } = require('./luck');
const settings = require('./settings');
// Valores salvos na tela de configurações (DATA_DIR/settings.json) valem por cima do .env
settings.applyOverlay(process.env.DATA_DIR || __dirname);
const BOOT = Date.now().toString(36);   // muda a cada reinício: a página recarrega sozinha (idioma etc.)

// ---------------------------------------------------------------- configuração
const PORT = Number(process.env.PORT || 3000);
// Idioma padrão do painel e do widget: pt-BR ou en. Vazio = idioma do navegador. ?lang=pt|en força na URL.
const LANGUAGE = normLang(process.env.LANGUAGE);
const THEME = settings.normTheme(process.env.THEME);
// Moeda dos valores em dinheiro (cotação, prêmio, conta de luz): BRL ou USD. O preço do kWh é nessa moeda.
const CURRENCY = /^(BRL|USD)$/i.test(process.env.CURRENCY || '') ? process.env.CURRENCY.toUpperCase() : (LANGUAGE === 'pt' ? 'BRL' : 'USD');
function normLang(v) { v = String(v || '').toLowerCase(); return v.startsWith('pt') ? 'pt' : v.startsWith('en') ? 'en' : ''; }
const ADDRESS = (process.env.BTC_ADDRESS || '').trim();
if (!ADDRESS && require.main === module) {
  // Sem endereço: assistente de primeira configuração no navegador (SETUP_WIZARD=0 volta ao erro antigo)
  if (process.env.SETUP_WIZARD === '0') {
    console.error('Set BTC_ADDRESS (the address your miners use as username) / Defina BTC_ADDRESS. See config/mineracao.env.example.');
    process.exit(1);
  }
  require('./setup').serve({ port: PORT, dataDir: process.env.DATA_DIR || __dirname, lang: LANGUAGE || 'en', onDone: () => process.exit(0) });
  return;   // o resto do painel só sobe depois da configuração (o systemd ou o Docker reiniciam)
}
let LOCAL_WORKER = process.env.LOCAL_WORKER || '';   // nome do worker do cpuminer local (serviço minerd), se houver
const ROTATE_S = Number(process.env.ROTATE_S || 20);
// Mostrar saldo e movimentação da carteira no painel (0 esconde; os avisos do Telegram continuam)
const SHOW_WALLET = process.env.SHOW_WALLET !== '0';
// Preço do kWh na moeda CURRENCY. POWER_PRICE_KWH (ou o nome antigo TARIFA_KWH); padrão: R$ 0,90 ou US$ 0,15.
const TARIFA_KWH = Number(process.env.POWER_PRICE_KWH || process.env.TARIFA_KWH || (CURRENCY === 'BRL' ? 0.9 : 0.15));
const WATTS = Object.assign({}, safeJson(process.env.WATTS));   // consumo por worker, ex.: '{"bitaxe":20,"nerdminer":1}'
// Workers que fazem parte da fazenda, com o hashrate nominal (H/s). A API da pool não lista todos,
// então o painel mostra estes mesmo quando a pool esconde. Para acrescentar ou tirar (valor 0):
//   EXPECTED='{"bitaxe":1.2e12,"devkit":0}'
const EXPECTED = Object.assign({}, safeJson(process.env.EXPECTED));
const WATTS_DEFAULT = Number(process.env.WATTS_DEFAULT || 5);
const TUYA_WORKER = (process.env.TUYA_WORKER || '').trim();
const TUYA_WATCHDOG_MIN = Number(process.env.TUYA_WATCHDOG_MIN || 0);
let TUYA_PLUGS = [];
let tuyaCloud = null;
let sonoffLan = null;
let tuyaClient = null;
// Bitaxe pela API local do AxeOS (BITAXES = "bitaxe1=192.168.0.140, bitaxe2=192.168.0.141")
const bitaxe = require('./bitaxe');
const BITAXES = bitaxe.parseList(process.env.BITAXES) || [];
const BITAXE_MS = Number(process.env.BITAXE_MS || 30e3);
const BITAXE_HIST_MS = Number(process.env.BITAXE_HIST_MS || 5 * 60e3);   // um ponto do gráfico de 24 h a cada 5 min
const bitaxeState = new Map();   // nome → { ok, at, okAt, error, fails, data, hist, alerts }
const numEnv = (k) => (process.env[k] != null && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : null);
// °C ou °F na tela e no Telegram (TEMP_UNIT); internamente tudo é °C, e os limites digitados em °F são convertidos
const TEMP_UNIT = String(process.env.TEMP_UNIT || '').toUpperCase() === 'F' ? 'F' : 'C';
const toC = (v) => (v != null && TEMP_UNIT === 'F' ? (v - 32) * 5 / 9 : v);
const BITAXE_LIMITS = { tempMax: toC(numEnv('BITAXE_TEMP_MAX')), vrMax: toC(numEnv('BITAXE_VR_MAX')), hashMin: numEnv('BITAXE_HASH_MIN') != null ? numEnv('BITAXE_HASH_MIN') / 100 : null,
  lowMs: numEnv('BITAXE_LOW_MS') };
const BITAXE_STALE_MS = Number(process.env.BITAXE_STALE_MS || Math.max(3 * BITAXE_MS, 120e3));   // sem leitura há mais que isso = sem resposta
const bitaxeFresh = (st) => st && st.data && st.okAt && Date.now() - st.okAt < BITAXE_STALE_MS;
// o worker de cada Bitaxe: o nome depois do ponto no usuário da pool, ou o nome cadastrado
const bitaxeWorker = (b) => { const st = bitaxeState.get(b.name); return (st && st.data && st.data.worker) || b.name; };
function bitaxeOfWorker(name) {
  const b = BITAXES.find((x) => bitaxeWorker(x) === name);
  const st = b && bitaxeState.get(b.name);
  return b && bitaxeFresh(st) ? { name: b.name, host: b.host, d: st.data } : null;
}
async function tickBitaxe() {
  for (const b of BITAXES) {
    const st = bitaxeState.get(b.name) || { ok: false, at: 0, okAt: 0, error: null, fails: 0, data: null, hist: [] };
    bitaxeState.set(b.name, st);
    const r = await bitaxe.info(b.host);
    st.at = Date.now();
    st.alerts = bitaxe.evaluate(st.alerts, r, BITAXE_LIMITS, st.at);
    if (!r.ok) { st.ok = false; st.error = r.error; st.fails++; continue; }
    Object.assign(st, { ok: true, okAt: st.at, error: null, fails: 0, data: r.data });
    // histórico curto para o gráfico: um ponto a cada 5 min, 24 h
    const last = st.hist.at(-1);
    if (!last || st.at - last.t >= BITAXE_HIST_MS) {
      st.hist.push({ t: st.at, hr: r.data.hashRate10m ?? r.data.hashRate, temp: r.data.tempC, w: r.data.watts });
      if (st.hist.length > 288) st.hist.shift();
    }
  }
}
// ---------------------------------------------------------------- ações no Bitaxe (fase 3), sempre atrás do PIN ou do chat autorizado
// Para onde apontar um Bitaxe: este servidor, a porta ASIC do proxy (atlaspool, senão ckpool), endereço.nome, reserva no ckpool
function bitaxePointTarget(b) {
  if (!ADDRESS) return { ok: false, error: 'noaddress' };
  // só IP da rede de casa (nunca o do Tailscale, 100.x, que o Bitaxe não alcança); BITAXE_SERVER_IP força um
  const forced = (process.env.BITAXE_SERVER_IP || '').trim();
  const ip = forced && bitaxe.isPrivateHost(forced) ? forced : require('./setup').lanAddresses().find((a) => bitaxe.isPrivateHost(a) && /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) return { ok: false, error: 'nohost' };
  const routes = proxy.routes || [];
  const port = (routes.find((r) => /atlaspool/.test(r.host || '')) || routes.find((r) => /ckpool/.test(r.host || '') && !/eusolo/.test(r.host || '')) || {}).listen || 3338;
  const user = `${ADDRESS}.${b.name}`;
  return { ok: true, main: { url: ip, port, user }, backup: { url: 'solo.ckpool.org', port: 3333, user } };
}
async function bitaxeAction(name, action, params = {}, via = 'painel') {
  const b = BITAXES.find((x) => x.name === name || bitaxeWorker(x) === name);
  if (!b) return { ok: false, error: 'nobitaxe' };
  if (!bitaxeState.has(b.name)) bitaxeState.set(b.name, { ok: false, at: 0, okAt: 0, error: null, fails: 0, data: null, hist: [] });
  const st = bitaxeState.get(b.name);
  let r;
  if (['restart', 'identify', 'pause', 'resume'].includes(action)) {
    if (action === 'restart') st.alerts = { ...(st.alerts || {}), expectRebootUntil: Date.now() + 5 * 60e3 };
    r = await bitaxe.simpleAction(b.host, action);
  } else if (action === 'fan') {
    const body = bitaxe.fanPatch(params);
    if (!body) return { ok: false, error: 'fan' };
    r = await bitaxe.patch(b.host, body);
    if (r.ok) {
      const chk = await bitaxe.info(b.host);
      const raw = chk.ok ? chk.raw : null;
      const applied = raw && Number(raw.autofanspeed) === body.autofanspeed && (body.autofanspeed ? Number(raw.temptarget) === body.temptarget : true);
      if (!applied) r = { ok: false, error: 'notapplied' };
    }
  } else if (action === 'point-preview' || action === 'point') {
    const target = bitaxePointTarget(b);
    if (!target.ok) return target;
    const cur = await bitaxe.info(b.host);
    if (!cur.ok) return cur;
    const current = { url: cur.data.pool.url, port: cur.data.pool.port, worker: cur.data.worker, fallback: cur.data.pool.fallback };
    if (action === 'point-preview') return { ok: true, current, next: target.main, backup: target.backup, same: bitaxe.poolMatches(cur.raw, target.main) };
    r = await bitaxe.patch(b.host, bitaxe.poolPatch(cur.raw, target.main, target.backup));
    if (r.ok) {
      const chk = await bitaxe.info(b.host);
      if (!chk.ok || !bitaxe.poolMatches(chk.raw, target.main)) r = { ok: false, error: 'notapplied' };
      else {
        // a pool nova só vale depois de reiniciar
        st.alerts = { ...(st.alerts || {}), expectRebootUntil: Date.now() + 5 * 60e3 };
        await bitaxe.simpleAction(b.host, 'restart');
        r = { ok: true, next: target.main };
      }
    }
  } else return { ok: false, error: 'action' };
  st.lastAction = { action, via, at: Date.now(), ok: !!r.ok, error: r.error || null };
  console.log(`bitaxe ${b.name}: ${action} via ${via} → ${r.ok ? 'ok' : r.error}`);
  return r;
}
function bitaxesView() {
  return BITAXES.map((b) => {
    const st = bitaxeState.get(b.name) || {};
    const al = st.alerts || {};
    return { name: b.name, host: b.host, worker: bitaxeWorker(b), ok: !!st.ok, fresh: !!bitaxeFresh(st), okAt: st.okAt || null, error: st.error || null, fails: st.fails || 0, data: st.data || null, hist: st.hist || [],
      alerts: al.active || {}, reboots: al.reboots || 0, lastReset: al.lastReset || null, blocks: al.blocks || 0, lastAction: st.lastAction || null };
  });
}
let tuyaPlugsState = new Map();
function initTuya() {
  TUYA_PLUGS = require('./tuya').normalizePlugs(process.env.TUYA_PLUGS, {
    deviceId: process.env.TUYA_DEVICE_ID,
    worker: TUYA_WORKER,
    watchdogMin: TUYA_WATCHDOG_MIN,
  }).list;
  const cloudPlugs = TUYA_PLUGS.filter((p) => p.type !== 'sonoff');
  tuyaCloud = cloudPlugs.length ? require('./tuya').createClient({
    clientId: process.env.TUYA_CLIENT_ID,
    secret: process.env.TUYA_SECRET,
    deviceId: cloudPlugs[0].deviceId,
    region: process.env.TUYA_REGION || 'us',
    apiBase: process.env.TUYA_API,
    allowNoDevice: true,
  }) : null;
  sonoffLan = TUYA_PLUGS.some((p) => p.type === 'sonoff') ? require('./sonoff').createClient({ plugs: TUYA_PLUGS }) : null;
  // Cliente único das tomadas: cada deviceId vai para a Tuya Cloud ou para o Sonoff na rede de casa
  tuyaClient = tuyaCloud || sonoffLan ? {
    getStatus: (id) => backendOf(id).getStatus(id),
    setSwitch: (on, id) => (plugGuard(id, on ? 'on' : 'off') || backendOf(id).setSwitch(on, id)),
    powerCycle: (ms, id) => (plugGuard(id, 'reboot') || backendOf(id).powerCycle(ms, id)),
    inspect: (id) => { const b = backendOf(id); return b.inspect ? b.inspect(id) : Promise.resolve({ ok: false, error: 'noinspect' }); },
  } : null;
  tuyaPlugsState = new Map(TUYA_PLUGS.map((p) => [p.deviceId, { okAt: null, error: null, status: null, lastRebootAt: 0, lastRebootIso: null, rebootCount: 0 }]));
  return { plugs: TUYA_PLUGS, client: tuyaClient, state: tuyaPlugsState };
}
const plugOf = (id) => TUYA_PLUGS.find((p) => p.deviceId === id) || TUYA_PLUGS[0];
const backendOf = (id) => {
  const p = plugOf(id);
  const b = p && p.type === 'sonoff' ? sonoffLan : tuyaCloud;
  return b || { getStatus: async () => ({ ok: false, error: 'tuyamissing' }), setSwitch: async () => ({ ok: false, error: 'tuyamissing' }), powerCycle: async () => ({ ok: false, error: 'tuyamissing' }) };
};
// A tomada que alimenta o próprio servidor (LOCAL_WORKER) não pode ser desligada daqui:
// o painel apagaria junto e ninguém ligaria de volta.
function plugGuard(id, action) {
  const p = plugOf(id), self = (process.env.LOCAL_WORKER || '').trim();
  if (action !== 'on' && p && self && p.worker === self) return Promise.resolve({ ok: false, error: 'selfplug' });
  return null;
}
initTuya();

const POOL_API = () => process.env.POOL_API || 'https://public-pool.io:40557/api';
// Pools no formato ckpool, consultadas junto com a public-pool:
//   pool.nerdminers.org: NerdMiners e ESP32 (dificuldade ultrabaixa, sem taxa)
//   solo.ckpool.org:     ASICs como o Bitaxe (taxa de 2% só se achar bloco)
// Workers que aparecerem em qualquer uma entram sozinhos no painel. CKPOOL_URLS= vazio desliga.
const CKPOOL_URLS = () => (process.env.CKPOOL_URLS ?? [
  `https://pool.nerdminers.org/users/${ADDRESS}`,
  `https://solo.ckpool.org/users/${ADDRESS}`,
].join(',')).split(',').map((u) => u.trim()).filter(Boolean);
const MEMPOOL = () => process.env.MEMPOOL_API || 'https://mempool.space/api';
const DIFF1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
// dificuldade que um hash "atingiu" (a mesma conta que a pool faz com os shares)
function hashDiff(hex) {
  try {
    const v = BigInt('0x' + hex);
    return v > 0n ? Number((DIFF1 * 1000000n) / v) / 1e6 : null;
  } catch (_) { return null; }
}

const FALLBACK_DIFFICULTY = 148.4e12;
const SUBSIDY_SATS = 312500000;   // 3,125 BTC até o bloco 1.050.000
const NEXT_HALVING = 1050000;
const GENESIS = { t: 1231006505, h: 0, d: 1 };

const POOL_MS = Number(process.env.CACHE_MS || 120e3);   // a API da pool é instável: consultar sem exagero
const NETDIFF_MS = 15 * 60e3;                             // dificuldade da rede muda a cada ~2 semanas
const STALE_WARN_MS = 10 * 60e3;                          // só avisa na tela se os dados passarem disso

// Sirene (Arduino na USB do servidor). Opcional: sem Arduino plugado, nada acontece.
const ALARM_PORT = process.env.ALARM_PORT || '/dev/ttyACM0';
const QUIET_HOURS = (process.env.QUIET_HOURS || '22-8').split('-').map(Number);   // sem som nesse horário
const ALARM_IGNORE = (process.env.ALARM_IGNORE || '').split(',').filter(Boolean);         // não deixam a luz vermelha
const WALLET_MS = 5 * 60e3;
const NET_MS = 2 * 60e3;
const DIFFHIST_MS = 24 * 3600e3;
const SAMPLE_MS = 5 * 60e3;
const HISTORY_KEEP_MS = 48 * 3600e3;
const QUIET_MIN = 120;            // mínimo de 2 h antes de considerar um worker parado
const SHARE_HASHES = 4294967296;  // hashes esperados por share de dificuldade 1
const QUIET_SHARES = 4;           // parado = sem share há mais de 4 intervalos esperados
const HIDE_STALE_MS = Number(process.env.HIDE_STALE_H || 24) * 3600e3;   // parados há mais que isso viram "inativos" (filtro de tela)

function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch (_) { return {}; } }
const file = (n) => path.join(process.env.DATA_DIR || __dirname, n);   // workers.json, records.json, history.json…
// gravação atômica com .bak (store.js): queda de energia no meio não corrompe recordes nem histórico
const store = require('./store');
function loadJson(n, fallback) { return store.readJson(file(n), fallback, { onRecover: (why) => console.log(`${n}: arquivo ${why === 'missing' ? 'ausente' : 'corrompido'}; usando o ${n}.bak`) }); }
function saveJson(n, v) { try { store.writeJson(file(n), v); } catch (_) { /* segue em memória */ } }

// ---------------------------------------------------------------- HTTP com nova tentativa
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('http:') ? http : https).get(url, {
      timeout: 15000,
      family: 4,   // IPv4: a API da pool derruba conexões IPv6 em algumas redes

      headers: { 'User-Agent': 'fazenda-mineracao/1.0', 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function getJsonRetry(url, tries = 3) {
  const baseDelay = Number(process.env.RETRY_BASE_MS ?? 2000);
  for (let i = 1; ; i++) {
    try { return await getJson(url); }
    catch (e) { if (i >= tries) throw e; await sleep(baseDelay * i); }
  }
}

// ---------------------------------------------------------------- pool, workers e recordes
let pool = { at: 0, okAt: 0, error: null, client: null, difficulty: FALLBACK_DIFFICULTY };
let poolActive = [];
let ckpools = {};   // url -> { okAt, error, active: [nomes] }
// OCEAN (pool que divide recompensas, pagamento direto na coinbase). OCEAN_API= vazio desliga.
const OCEAN_API = () => process.env.OCEAN_API ?? 'https://api.ocean.xyz/v1';
let ocean = { okAt: 0, error: null, active: [], unpaidSats: null, nextBlockSats: null, lastShareAt: null };

// Proxy Stratum local (proxy.js): vê cada share de quem minera através dele, em tempo real
// O hashrate do proxy vem dos shares aceitos; com poucos shares na última hora ele oscila demais,
// então só é usado a partir de PROXY_MIN_SHARES (com alvo 1, o macbook manda ~8 por hora).
const PROXY_MIN_SHARES = Number(process.env.PROXY_MIN_SHARES || 20);
const proxyHashrate = (w) => (w && w.shares1h >= PROXY_MIN_SHARES && w.hashrate > 0 ? w.hashrate : 0);
const PROXY_URL = () => process.env.PROXY_URL ?? 'http://127.0.0.1:3336/stats';
const PROXY_MS = 15e3;
let proxy = { okAt: 0, error: null, workers: {}, recent: [], totals: null, accepted: null };
const proxyUp = () => !!PROXY_URL() && Date.now() - proxy.okAt < 2 * 60e3;

// A API da pool só lista sessões ativas; o painel guarda todo worker que já apareceu.
// Para esquecer um worker, apague-o de workers.json e reinicie o serviço.
let known = loadJson('workers.json', {});

let records = loadJson('records.json', null);
if (!Array.isArray(records)) {
  records = Object.values(known)
    .filter((w) => Number(w.bestDifficulty) > 0)
    .map((w) => ({ worker: w.name, value: Number(w.bestDifficulty), at: w.lastSeen }));
  saveJson('records.json', records);
}

let history = loadJson('history.json', []);
if (!Array.isArray(history)) history = [];
let achievements = loadJson('achievements.json', {});
if (!achievements || typeof achievements !== 'object' || Array.isArray(achievements)) achievements = {};

function addRecord(worker, value) {
  alarm(value > topRecord() ? 'R' : 'P');
  records.push({ worker, value, at: new Date().toISOString() });
  records.sort((a, b) => b.value - a.value);
  records = records.slice(0, 200);
  saveJson('records.json', records);
}

function rememberWorkers(workers, poolName) {
  const now = Date.now();
  for (const w of workers || []) {
    const prev = known[w.name] || {};
    const prevBest = Number(prev.bestDifficulty || 0);
    const best = Number(w.bestDifficulty || 0);
    if (best > prevBest && best >= 1) addRecord(w.name, best);
    known[w.name] = {
      name: w.name,
      hashRate: Number(w.hashRate || 0),
      hrBy: w.hrBy || 'pool',   // quem mediu: 'pool', 'proxy' ou 'nominal'
      bestDifficulty: Math.max(best, prevBest),
      lastSeen: w.lastSeen || prev.lastSeen || null,   // sem data = nunca visto minerando
      pool: poolName || prev.pool || null,
    };
  }
  saveJson('workers.json', known);
}

// Estados: ok = listado pela pool agora (ou minerador local rodando) · quiet = sumiu da lista,
// mas dentro do intervalo esperado de shares · unknown = esperado, nunca listado · stale = parado
function workersView() {
  const viaProxy = proxyUp() ? Object.values(proxy.workers).filter((w) => w.online > 0) : [];
  const listed = new Set([...poolActive.map((w) => w.name), ...Object.values(ckpools).flatMap((p) => p.active), ...ocean.active, ...viaProxy.map((w) => w.name)]);
  const proxied = new Map(viaProxy.map((w) => [w.name, w]));
  const now = Date.now();
  const names = new Set([...Object.keys(known), ...Object.keys(EXPECTED).filter((n) => EXPECTED[n] > 0),
    ...BITAXES.filter((b) => bitaxeFresh(bitaxeState.get(b.name))).map(bitaxeWorker)]);
  return [...names].map((name) => {
    const k = known[name] || { name, hashRate: 0, bestDifficulty: 0, lastSeen: null };
    const nominal = EXPECTED[name] || 0;
    let hashRate = Number(k.hashRate) || nominal;
    let lastSeen = k.lastSeen;
    let source = 'pool';
    let approx = false;
    let state;
    if (name === LOCAL_WORKER && local.running && now - local.at < 5 * 60e3) {
      hashRate = local.hashrate;
      source = 'local';
      if (local.lastShare && (!lastSeen || local.lastShare > new Date(lastSeen).getTime())) lastSeen = new Date(local.lastShare).toISOString();
      state = 'ok';
    } else if (proxied.has(name)) {
      const p = proxied.get(name);
      if (proxyHashrate(p)) hashRate = proxyHashrate(p);
      else if (!(Number(k.hashRate) > 0)) {
        // CPU com alvo 1 manda poucos shares por hora (o macbook, ~8): em vez de 0, uma estimativa marcada com "~",
        // pela média de 24 h do proxy ou, sem ela, pela última hora com ao menos 3 shares
        const est = p.hashrate24h > 0 ? p.hashrate24h : p.shares1h >= 3 && p.hashrate > 0 ? p.hashrate : 0;
        if (est > 0) { hashRate = est; approx = true; }
      }
      if (p.lastShareAt && (!lastSeen || p.lastShareAt > new Date(lastSeen).getTime())) lastSeen = new Date(p.lastShareAt).toISOString();
      source = 'proxy';
      state = 'ok';
    } else if (listed.has(name)) {
      state = 'ok';
    } else if (bitaxeOfWorker(name) && !bitaxeOfWorker(name).d.paused && bitaxeOfWorker(name).d.hashRate > 0) {
      state = 'ok';   // o próprio Bitaxe diz que está minerando, mesmo que a pool ainda não liste
    } else if (!lastSeen) {
      state = 'unknown';
    } else {
      const mins = (now - new Date(lastSeen).getTime()) / 60000;
      const limit = Math.max(QUIET_MIN, QUIET_SHARES * SHARE_HASHES / Math.max(hashRate, 1) / 60);
      state = mins < limit ? 'quiet' : 'stale';
    }
    // inativo = parado há mais de HIDE_STALE_H horas; a tela esconde por padrão (o arquivo guarda tudo)
    const inactive = state === 'stale' && !!lastSeen && now - new Date(lastSeen).getTime() > HIDE_STALE_MS;
    const viaProxy = proxied.has(name);   // ⚡ na tela, mesmo quando o hashrate vem do log local
    const pw = proxy.workers[name];       // último share visto pelo proxy (fica mesmo depois de desconectar)
    const lastDiff = pw && pw.lastShareAt ? { diff: pw.lastShareDiff, at: pw.lastShareAt } : null;
    const pxw = proxied.get(name);
    const netx = pxw ? { ip: pxw.ip || null, shareDiff: pxw.shareDiff || null, extranonce1: pxw.extranonce1 || null, listen: pxw.listen || null, rejected: pxw.rejected || 0, stale: pxw.stale || 0, duplicate: pxw.duplicate || 0, hr15m: pxw.hashrate15m || 0, hr24h: pxw.hashrate24h || 0 } : {};
    // Bitaxe com API: o hashrate medido pelo próprio aparelho (média de 10 min) vale mais que a estimativa por shares
    const bx = bitaxeOfWorker(name);
    let device = null;
    if (bx) {
      const d = bx.d;
      approx = false;
      const hr = d.hashRate10m || d.hashRate;
      if (hr > 0 || d.paused) { hashRate = d.paused ? 0 : hr; source = 'bitaxe'; }
      device = { name: bx.name, host: bx.host, tempC: d.tempC, vrTempC: d.vrTempC, watts: d.watts, jth: d.jth, fanPct: d.fanPct, fanRpm: d.fanRpm,
        expected: d.expected, fallback: d.pool.fallback, paused: d.paused, model: d.model };
    }
    return { ...k, name, hashRate, approx, nominal, lastSeen, state, source, inactive, viaProxy, lastDiff, ...netx, bitaxe: device };
  }).sort((a, b) => b.hashRate - a.hashRate);
}

// Soma de quem está (ou deve estar) minerando: ativos, quietos e esperados ainda não listados
// Soma só quem a pool (ou o log local) confirma: ativos e quietos. Não listados não entram.
const farmHashrate = (view) => view.filter((w) => w.state === 'ok' || w.state === 'quiet').reduce((s, w) => s + w.hashRate, 0);
const topRecord = () => records.reduce((m, r) => Math.max(m, r.value), 0);

async function tickPool() {
  pool.at = Date.now();
  try {
    const client = await getJsonRetry(`${POOL_API()}/client/${ADDRESS}`);
    if (Date.now() - (pool.netAt || 0) > NETDIFF_MS) {
      try {
        const net = await getJsonRetry(`${POOL_API()}/network`, 2);
        const d = Number(net.difficulty);
        if (d > 0) { pool.difficulty = d; pool.netAt = Date.now(); }
      } catch (_) { /* mantém a última dificuldade */ }
    }
    rememberWorkers(client.workers, 'public-pool');
    poolActive = client.workers || [];
    const totalShares = Number((client.accounting || {}).totalAcceptedShares) || 0;
    if (lastTotalShares !== null && totalShares > lastTotalShares && !proxyUp()) alarm('S');
    lastTotalShares = totalShares;
    alarmStatus();
    // Recorde do endereço maior que todos os registrados (worker sumiu antes de o painel ver)
    const addrBest = Number(client.bestDifficulty || 0);
    if (addrBest > topRecord() + 1e-9) {
      const match = Object.values(known).find((w) => Math.abs(Number(w.bestDifficulty) - addrBest) < 0.01);
      addRecord(match ? match.name : '—', addrBest);
    }
    pool.client = client;
    pool.okAt = Date.now();
    pool.error = null;
    sampleHistory();
  } catch (e) {
    pool.error = e.message;
  }
}

function sampleHistory() {
  const now = Date.now();
  const last = history[history.length - 1];
  if (last && now - last.t < SAMPLE_MS - 5000) return;
  const view = workersView();
  const en = energy(view);
  const w = Number((en.plugsWatts > 0 ? en.plugsWatts : en.watts).toFixed(1));
  history.push({ t: now, hr: Math.round(farmHashrate(view)), w });
  history = history.filter((s) => now - s.t <= HISTORY_KEEP_MS);
  saveJson('history.json', history);
}

// ---------------------------------------------------------------- carteira e cotação
let wallet = { at: 0, okAt: 0, sats: null, pendingSats: 0, txCount: 0, brl: null, usd: null, change24h: null, changeUsd24h: null, error: null };

async function tickWallet() {
  wallet.at = Date.now();
  try {
    const a = await getJsonRetry(`${MEMPOOL()}/address/${ADDRESS}`);
    const cs = a.chain_stats || {}, ms = a.mempool_stats || {};
    wallet.sats = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
    wallet.pendingSats = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);
    wallet.txCount = (cs.tx_count || 0) + (ms.tx_count || 0);
    wallet.okAt = Date.now();
    wallet.error = null;
  } catch (e) {
    wallet.error = e.message;
  }
  // Cotação: CoinGecko e, se falhar, Binance (BTC/BRL e BTC/USDT). Mantém a última se ambas falharem.
  const geckoUrl = process.env.COINGECKO_API || 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd&include_24hr_change=true';
  try {
    const p = await getJsonRetry(geckoUrl, 2);
    if (!(p.bitcoin && p.bitcoin.brl)) throw new Error('sem cotação');
    wallet.brl = p.bitcoin.brl;
    wallet.usd = p.bitcoin.usd;
    wallet.change24h = Number.isFinite(p.bitcoin.brl_24h_change) ? p.bitcoin.brl_24h_change : null;
    wallet.changeUsd24h = Number.isFinite(p.bitcoin.usd_24h_change) ? p.bitcoin.usd_24h_change : null;
  } catch (_) {
    for (const [sym, key, chg] of [['BTCBRL', 'brl', 'change24h'], ['BTCUSDT', 'usd', 'changeUsd24h']]) {
      try {
        const binanceUrl = process.env.BINANCE_API ? `${process.env.BINANCE_API}?symbol=${sym}` : `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`;
        const b = await getJsonRetry(binanceUrl, 2);
        const v = Number(b.lastPrice);
        if (v > 0) { wallet[key] = v; wallet[chg] = Number(b.priceChangePercent); }
      } catch (_) { /* mantém a última cotação */ }
    }
  }
}

// ---------------------------------------------------------------- rede Bitcoin (mempool.space)
let net = { at: 0, okAt: 0, error: null, tip: null, prize: null, adj: null, fees: null };

async function tickNetwork() {
  net.at = Date.now();
  const errs = [];
  try {
    const blocks = await getJsonRetry(`${MEMPOOL()}/v1/blocks`, 2);
    if (Array.isArray(blocks) && blocks.length) {
      const b = blocks[0];
      const ex = b.extras || {};
      net.tip = { height: Number(b.height), time: Number(b.timestamp), pool: (ex.pool && ex.pool.name) || null,
        hash: b.id || null, hashDiff: b.id ? hashDiff(b.id) : null, target: Number(b.difficulty) || null };
      // o mais "sortudo" (hash mais além do alvo) entre os últimos blocos
      net.recentHashes = blocks.slice(0, 15).filter((x) => x.id).map((x) => ({
        height: Number(x.height), pool: (x.extras && x.extras.pool && x.extras.pool.name) || null,
        hash: x.id, hashDiff: hashDiff(x.id), target: Number(x.difficulty) || null, time: Number(x.timestamp),
      }));
      const rewards = blocks.slice(0, 10).map((x) => x.extras && Number(x.extras.reward)).filter((v) => v > 0);
      const avg = rewards.length ? rewards.reduce((s, v) => s + v, 0) / rewards.length : SUBSIDY_SATS;
      net.prize = { sats: Math.round(avg), feesSats: Math.max(0, Math.round(avg - SUBSIDY_SATS)), blocks: rewards.length };
    }
  } catch (e) { errs.push('blocos: ' + e.message); }
  try {
    const a = await getJsonRetry(`${MEMPOOL()}/v1/difficulty-adjustment`, 2);
    net.adj = {
      change: Number(a.difficultyChange),
      progress: Number(a.progressPercent),
      remainingBlocks: Number(a.remainingBlocks),
      retargetAt: Number(a.estimatedRetargetDate),
      timeAvg: Number(a.timeAvg) || 600000,
    };
  } catch (e) { errs.push('ajuste: ' + e.message); }
  try {
    const f = await getJsonRetry(`${MEMPOOL()}/v1/fees/recommended`, 2);
    net.fees = { fast: f.fastestFee, halfHour: f.halfHourFee, hour: f.hourFee, economy: f.economyFee ?? f.economy_fee, min: f.minimumFee };
  } catch (e) { errs.push('taxas: ' + e.message); }
  net.error = errs.length ? errs.join(' · ') : null;
  if (errs.length < 3) net.okAt = Date.now();
}

// Histórico de dificuldade para a "máquina do tempo" (baixado uma vez por dia)
let diffHist = loadJson('diffhist.json', { okAt: 0, list: [] });
if (!diffHist || !Array.isArray(diffHist.list)) diffHist = { okAt: 0, list: [] };

function normDiff(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.difficulty) ? raw.difficulty : null);
  if (!arr) return null;
  const out = arr
    .map((e) => Array.isArray(e)
      ? { t: Number(e[0]), h: Number(e[1]), d: Number(e[2]) }
      : { t: Number(e.time ?? e.timestamp), h: Number(e.height), d: Number(e.difficulty) })
    .filter((e) => e.t > 0 && e.d > 0 && Number.isFinite(e.h));
  for (const e of out) if (e.t > 1e12) e.t = Math.round(e.t / 1000);
  out.sort((a, b) => a.h - b.h);
  if (!out.length) return null;
  if (out[0].h > 0 && out[0].h <= 2016) out.unshift({ ...GENESIS });
  return out;
}

async function tickDiffHist() {
  if (diffHist.list.length && Date.now() - diffHist.okAt < DIFFHIST_MS) return;
  for (const u of ['/v1/mining/difficulty-adjustments', '/v1/mining/difficulty-adjustments/all', '/v1/mining/hashrate/all']) {
    try {
      const list = normDiff(await getJsonRetry(MEMPOOL() + u, 2));
      if (list && list.length > 10) {
        diffHist = { okAt: Date.now(), list };
        saveJson('diffhist.json', diffHist);
        return;
      }
    } catch (_) { /* tenta o próximo endereço */ }
  }
}

function timeMachine(best) {
  if (!(best > 0)) return null;
  if (best >= pool.difficulty) return { now: true };
  const l = diffHist.list;
  let i = -1;
  for (let k = 0; k < l.length; k++) if (l[k].d <= best) i = k;
  if (i < 0) return null;
  return { from: l[i].t, until: l[i + 1] ? l[i + 1].t : null, height: l[i].h, diff: l[i].d };
}

// ---------------------------------------------------------------- saúde da máquina local
const TEMP_FILE = '/sys/class/thermal/thermal_zone0/temp';
let cpuPrev = null;

// ---------------------------------------------------------------- segunda pool (ckpool)
function parseHashrate(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').trim().match(/^([\d.]+)\s*([KMGTPE]?)/i);
  if (!m) return 0;
  const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }[m[2].toUpperCase()];
  return Number(m[1]) * mult;
}

async function tickCkpools() {
  for (const url of CKPOOL_URLS()) await tickCkpool(url);
}

async function tickCkpool(url) {
  const st = ckpools[url] || (ckpools[url] = { okAt: 0, error: null, active: [] });
  try {
    let u;
    try { u = await getJsonRetry(url, 2); }
    catch (e) {
      // 404 = esse endereço ainda não minerou nessa pool (ex.: solo.ckpool antes do Bitaxe chegar)
      if (/HTTP 404/.test(e.message)) { st.active = []; st.okAt = Date.now(); st.error = null; return; }
      throw e;
    }
    const now = Date.now();
    const ws = (u.worker || []).map((w) => {
      const full = String(w.workername || '');
      const name = full.includes('.') ? full.slice(full.indexOf('.') + 1) : '(sem nome)';
      return {
        name,
        hashRate: Math.max(parseHashrate(w.hashrate1hr), parseHashrate(w.hashrate5m)),   // médias do ckpool aquecem devagar
        bestDifficulty: Number(w.bestever) || 0,
        lastSeen: w.lastshare ? new Date(Number(w.lastshare) * 1000).toISOString() : null,
      };
    });
    const host = new URL(url).hostname;
    rememberWorkers(ws, host.includes('nerdminers') ? 'nerdminers' : host.includes('ckpool') ? 'ckpool solo' : host);
    // ativo = mandou share nos últimos 15 min (com vardiff, os shares saem a cada poucos segundos ou minutos)
    st.active = ws.filter((w) => w.lastSeen && now - new Date(w.lastSeen).getTime() < 15 * 60e3).map((w) => w.name);
    st.okAt = now;
    st.error = null;
  } catch (e) {
    st.error = e.message;
  }
}

// ---------------------------------------------------------------- OCEAN
// Formato observado em clientes abertos da API: { result: { workers: { "<nome>": {hashrate_60s, ...} } } },
// às vezes com o valor de cada worker numa lista de um item. Hashrates em H/s. Não informa melhor share.
const OCEAN_HR_KEYS = ['hashrate_10800', 'hashrate_10800s', 'hashrate_7200', 'hashrate_7200s', 'hashrate_3600', 'hashrate_3600s', 'hashrate_300', 'hashrate_300s'];

async function oceanGet(path) {
  try { const r = await getJsonRetry(`${OCEAN_API()}/${path}/${ADDRESS}`, 2); return (r && r.result) || r || {}; }
  catch (e) { if (/HTTP 404/.test(e.message)) return {}; throw e; }   // endereço nunca minerou lá
}

async function tickOcean() {
  if (!OCEAN_API()) return;
  try {
    const now = Date.now();
    const d = await oceanGet('user_hashrate_full');
    const wobj = d.workers || (d.user_hashrate && d.user_hashrate.workers) || {};
    const entries = Array.isArray(wobj) ? wobj.map((w) => [w.workername || w.name, w]) : Object.entries(wobj);
    const skip = new Set(['online', 'offline', 'status', 'worker', 'total']);
    const ws = [];
    for (let [full, info] of entries) {
      if (!full || skip.has(String(full).toLowerCase())) continue;
      if (Array.isArray(info)) info = info[0] || {};
      if (!info || typeof info !== 'object') continue;
      full = String(full);
      const name = full.includes('.') ? full.slice(full.indexOf('.') + 1) : full;
      const hr60 = Number(info.hashrate_60s) || 0;
      const key = OCEAN_HR_KEYS.find((k) => Number(info[k]) > 0);
      ws.push({ name, hashRate: key ? Number(info[key]) : hr60, bestDifficulty: 0,
        lastSeen: hr60 > 0 ? new Date(now).toISOString() : null, online: hr60 > 0 });
    }
    rememberWorkers(ws, 'OCEAN');
    ocean.active = ws.filter((w) => w.online).map((w) => w.name);
    try {
      const snap = await oceanGet('statsnap');
      const btc = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v) * 1e8));
      ocean.unpaidSats = btc(snap.unpaid);
      ocean.nextBlockSats = btc(snap.estimated_earn_next_block);
      const ts = Number(snap.lastest_share_ts || snap.latest_share_ts);
      ocean.lastShareAt = ts > 0 ? new Date(ts * 1000).toISOString() : null;
    } catch (_) { /* saldo é opcional */ }
    ocean.okAt = now;
    ocean.error = null;
  } catch (e) {
    ocean.error = e.message;
  }
}

// ---------------------------------------------------------------- sirene (Arduino)
let alarmFd = null, alarmTry = 0, lastTotalShares = null;

function alarmOpen(port = ALARM_PORT, sttyRunner = null) {
  if (alarmFd !== null || Date.now() - alarmTry < 60e3) return;
  alarmTry = Date.now();
  if (!fs.existsSync(port)) return;
  const runStty = sttyRunner || ((cb) => execFile('stty', ['-F', port, '9600', 'raw', '-echo', '-hupcl'], cb));
  runStty((err) => {
    if (err) return;
    try { alarmFd = fs.openSync(port, 'r+'); } catch (_) { alarmFd = null; }
  });
}

function quietNow() {
  const h = new Date().getHours(), [a, b] = QUIET_HOURS;
  return a > b ? (h >= a || h < b) : (h >= a && h < b);
}

function alarm(code) {
  alarmOpen();
  if (alarmFd === null) return false;
  const c = quietNow() && 'RPST'.includes(code) ? code.toLowerCase() : code;
  try { fs.writeSync(alarmFd, c); return true; }
  catch (_) { try { fs.closeSync(alarmFd); } catch (_) { /* já fechada */ } alarmFd = null; return false; }
}

function alarmStatus() {
  const view = workersView().filter((w) => w.state !== 'unknown' && !w.inactive && !ALARM_IGNORE.includes(w.name));
  alarm(view.some((w) => w.state === 'stale') ? '2' : view.some((w) => w.state === 'quiet') ? '1' : '0');
}

// Minerador local: lê o hashrate e o último share aceito direto do log do serviço minerd
const { execFile } = require('child_process');
let local = { at: 0, hashrate: 0, lastShare: null, running: false };
let localTick = { at: 0, error: null, bytes: 0 };   // diagnóstico da última leitura do log (aparece em health.localMiner)

// Cada linha pode vir com a hora do journal em segundos Unix ("-o short-unix": "1762364828.123 host minerd[12]: [..] thread 0: ...").
// Essa é a hora que vale: a do próprio cpuminer ("[2026-11-05 14:47:08]") é hora local sem fuso, e o Node
// pode estar em outro fuso que o sistema (ex.: /etc/localtime copiado em vez de link), o que descartava tudo.
function parseMinerdLog(out) {
  const perThread = {};
  let lastTs = 0, lastShare = null;
  for (const line of (out || '').split('\n')) {
    const unix = (line.match(/^(\d{9,11})(?:\.\d+)?\s/) || [])[1];
    const ts = (line.match(/\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/) || [])[1];
    const t = unix ? Number(unix) * 1000 : ts ? new Date(ts.replace(' ', 'T')).getTime() : 0;
    const m = line.match(/thread (\d+): \d+ hashes, ([\d.]+) khash\/s/);
    if (m && t && Date.now() - t < 5 * 60e3) { perThread[m[1]] = Number(m[2]) * 1000; lastTs = t; }
    if (t && line.includes('accepted:')) lastShare = t;
  }
  const hashrate = Object.values(perThread).reduce((s, v) => s + v, 0);
  return { lastTs, hashrate, lastShare };
}

function tickLocal(runner = null) {
  return new Promise((resolve) => {
    const fn = runner || ((cb) => execFile('journalctl', ['-u', 'minerd', '-u', 'mineracao-minerador', '--since', '-3 hours', '-o', 'short-unix', '--no-pager'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, cb));
    fn((err, out) => {
      localTick = { at: Date.now(), error: err ? String(err.message || err).slice(0, 200) : null, bytes: (out || '').length };
      if (err || !out) { local.running = false; return resolve(); }
      const p = parseMinerdLog(out);
      local = { at: p.lastTs, hashrate: p.hashrate, lastShare: p.lastShare || local.lastShare, running: p.hashrate > 0 };
      resolve();
    });
  });
}

async function tickProxy() {
  if (!PROXY_URL()) return;
  try {
    const s = await getJson(PROXY_URL());
    const ws = s.workers || [];
    const accepted = ws.reduce((n, w) => n + (w.accepted || 0), 0);
    if (proxy.accepted !== null && accepted > proxy.accepted) alarm('S');
    // recordes pessoais/da fazenda entram na hora, com a dificuldade calculada pelo proxy
    const byPool = {};
    for (const w of ws) if (w.lastShareAt || w.online > 0) (byPool[w.pool] = byPool[w.pool] || []).push({
      name: w.name,
      // proxy confiável > medição da pool > nominal (descarta estimativa antiga do proxy com poucos shares)
      ...(() => {
        const prev = known[w.name] || {};
        if (w.online > 0 && proxyHashrate(w)) return { hashRate: proxyHashrate(w), hrBy: 'proxy' };
        if (prev.hrBy === 'pool' && prev.hashRate > 0) return { hashRate: prev.hashRate, hrBy: 'pool' };
        if (prev.hrBy === 'proxy' && w.online === 0 && prev.hashRate > 0) return { hashRate: prev.hashRate, hrBy: 'proxy' };
        return { hashRate: EXPECTED[w.name] || prev.hashRate || 0, hrBy: 'nominal' };
      })(),
      bestDifficulty: w.bestEver,
      lastSeen: w.lastShareAt ? new Date(w.lastShareAt).toISOString() : null,
    });
    for (const [label, list] of Object.entries(byPool)) rememberWorkers(list, label);
    proxy = {
      okAt: Date.now(), error: null, accepted,
      workers: Object.fromEntries(ws.map((w) => [w.name, w])),
      recent: (s.recent || []).slice(0, 30),
      totals: s.totals || null,
      events: Array.isArray(s.events) ? s.events.slice(0, 30) : [],
      process: s.process || null,
      hist: Array.isArray(s.hist) ? s.hist : null,
      // portas cuja pool principal está fora do ar (os mineradores dessas portas estão na reserva)
      failover: (s.routes || []).filter((r) => r.upstreams && r.upstreams[0].down).map((r) => ({
        listen: r.listen, primary: r.upstreams[0].label, since: r.upstreams[0].since,
        active: (r.upstreams.slice(1).find((u) => !u.down) || {}).label || null,
      })),
      // portas do proxy (para o guia "Pools e portas" da tela de configurações)
      routes: (s.routes || []).map((r) => {
        const up = r.upstreams || [];
        const main = up[0] || r;
        return { listen: r.listen, label: main.label || r.label, host: main.host || r.host, down: !!main.down, pingMs: main.pingMs ?? null,
          backups: up.slice(1).map((u) => u.label), active: main.down ? (up.slice(1).find((u) => !u.down) || {}).label || null : null };
      }),
      bestHash: s.bestHash || null,
      dayBestHash: s.dayBestHash || null,
      week: s.week || null,
      lastWeek: s.lastWeek || null,
    };
    alarmStatus();
  } catch (e) {
    proxy.error = e.message;
  }
}

function readTempC(file = TEMP_FILE) {
  try {
    const v = Number(fs.readFileSync(file, 'utf8').trim());
    return v > 0 ? v / 1000 : null;
  } catch (_) { return null; }
}

function readCpuPct(file = '/proc/stat') {
  try {
    const f = fs.readFileSync(file, 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = f[3] + (f[4] || 0);
    const total = f.reduce((s, v) => s + v, 0);
    let pct = null;
    if (cpuPrev && total > cpuPrev.total) pct = 100 * (1 - (idle - cpuPrev.idle) / (total - cpuPrev.total));
    cpuPrev = { idle, total };
    return pct;
  } catch (_) { return null; }
}

function readMem(file = '/proc/meminfo') {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const g = (k) => Number((t.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [])[1]) * 1024;
    const total = g('MemTotal'), avail = g('MemAvailable');
    if (total > 0 && avail >= 0) return { used: total - avail, total };
  } catch (_) { /* usa o os */ }
  return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

function health() {
  return {
    worker: LOCAL_WORKER,
    localMiner: LOCAL_WORKER ? { running: local.running, hashrate: local.hashrate, lineAt: local.at || null, readAt: localTick.at || null, error: localTick.error, bytes: localTick.bytes } : null,
    tempC: readTempC(),
    cpuPct: readCpuPct(),
    load: os.loadavg()[0],
    cores: os.cpus().length,
    mem: readMem(),
    uptimeS: os.uptime(),
  };
}

function energy(view) {
  const plugs = tuyaClient ? TUYA_PLUGS.map((p) => {
    const st = tuyaPlugsState.get(p.deviceId) || { okAt: null, error: null, status: null, lastRebootIso: null, rebootCount: 0 };
    const s = st.status;
    return {
      name: p.name,
      deviceId: p.deviceId,
      worker: p.worker || null,
      watchdogMin: p.watchdogMin >= 5 ? p.watchdogMin : null,
      okAt: st.okAt,
      error: st.error,
      offline: st.error === 'tuyaoffline',
      on: s ? s.on : null,
      watts: s ? s.watts : null,
      volts: s ? s.volts : null,
      currentMa: s ? s.currentMa : null,
      kwhTotal: s ? s.kwhTotal : null,
      lastRebootAt: st.lastRebootIso,
      rebootCount: st.rebootCount,
    };
  }) : [];
  const plug = plugs[0] || null;
  const parts = view.filter((w) => w.state === 'ok' || w.state === 'quiet').map((w) => {
    const linked = plugs.filter((p) => p.worker === w.name && p.watts != null);
    const liveWatts = linked.length ? Number(linked.reduce((s, p) => s + p.watts, 0).toFixed(1)) : null;
    if (liveWatts != null) return { name: w.name, watts: liveWatts, live: true, src: 'plug' };
    if (w.bitaxe && w.bitaxe.watts > 0) return { name: w.name, watts: Number(w.bitaxe.watts.toFixed(1)), live: true, src: 'bitaxe' };
    return { name: w.name, watts: WATTS[w.name] ?? WATTS_DEFAULT, live: false, src: 'estimate' };
  });
  const wholeFarm = plugs.filter((p) => p.worker === '*' && p.watts != null);
  const watts = wholeFarm.length
    ? Number(wholeFarm.reduce((s, p) => s + p.watts, 0).toFixed(1))
    : parts.reduce((s, p) => s + p.watts, 0);
  const plugsWatts = Number(plugs.reduce((s, p) => s + (p.watts != null ? p.watts : 0), 0).toFixed(1));
  const kwhMonth = watts * 730 / 1000;
  return { parts, watts, plugsWatts, kwhMonth, costMonth: kwhMonth * TARIFA_KWH, tarifa: TARIFA_KWH, plug, plugs };
}

async function tickTuya() {
  if (!tuyaClient || !TUYA_PLUGS.length) return;
  const view = workersView();
  for (const p of TUYA_PLUGS) {
    const st = tuyaPlugsState.get(p.deviceId) || { okAt: null, error: null, status: null, lastRebootAt: 0, lastRebootIso: null, rebootCount: 0 };
    tuyaPlugsState.set(p.deviceId, st);
    const r = await tuyaClient.getStatus(p.deviceId);
    if (!r.ok) {
      st.error = r.error;
      if (r.error === 'tuyaoffline') st.status = null;   // leitura velha não pode passar por ao vivo
      continue;
    }
    st.status = r.status;
    st.okAt = new Date().toISOString();
    st.error = null;
    if (p.watchdogMin >= 5 && p.worker && p.worker !== '*') {
      const w = view.find((x) => x.name === p.worker);
      const staleMs = w && w.state === 'stale' && !w.inactive && w.lastSeen ? Date.now() - new Date(w.lastSeen).getTime() : 0;
      if (staleMs >= p.watchdogMin * 60e3 && Date.now() - st.lastRebootAt >= 60 * 60e3) {
        st.lastRebootAt = Date.now();
        const rb = await tuyaClient.powerCycle(8000, p.deviceId);
        if (rb.ok) {
          st.rebootCount++;
          st.lastRebootIso = rb.rebootedAt;
        }
      }
    }
  }
  sampleHistory();
}

// ---------------------------------------------------------------- resposta da API
// internal = uso do próprio servidor (bot do Telegram): inclui a carteira mesmo quando a tela a esconde
function snapshot(internal = false) {
  const view = workersView();
  const client = pool.client || {};
  const best = Math.max(Number(client.bestDifficulty || 0), topRecord());
  const halving = net.tip ? (() => {
    const remaining = Math.max(0, NEXT_HALVING - net.tip.height);
    return { remaining, at: Date.now() + remaining * ((net.adj && net.adj.timeAvg) || 600000) };
  })() : null;
  const steps = [...records].sort((a, b) => new Date(a.at) - new Date(b.at));
  let run = 0;
  const recordSteps = [];
  for (const r of steps) if (r.value > run) { run = r.value; recordSteps.push({ t: new Date(r.at).getTime(), v: r.value, worker: r.worker }); }
  return {
    boot: BOOT,
    tempUnit: TEMP_UNIT,
    clock: clockState,
    okAt: pool.okAt,
    ckpools: Object.entries(ckpools).map(([url, p]) => ({ url, okAt: p.okAt, error: p.error, active: p.active })),
    ocean: OCEAN_API() ? { ...ocean, ...(SHOW_WALLET || internal ? {} : { unpaidSats: null }) } : null,
    proxy: PROXY_URL() ? {
      okAt: proxy.okAt,
      error: proxy.error,
      up: proxyUp(),
      recent: proxy.recent.slice(0, 10),
      events: proxyUp() ? proxy.events || [] : [],
      process: proxyUp() ? proxy.process || null : null,
      efficiency: proxyUp() && proxy.totals ? proxy.totals.efficiency : null,
      failover: proxyUp() ? proxy.failover || [] : [],
      pingMs: proxyUp() && proxy.totals ? proxy.totals.pingMs : null,
      pingScore: proxyUp() && proxy.totals ? proxy.totals.pingScore : 'unknown',
      pools: proxyUp() && proxy.totals && Array.isArray(proxy.totals.pools) ? proxy.totals.pools : [],
    } : null,
    error: pool.error,
    staleWarnMs: STALE_WARN_MS,
    rotateS: ROTATE_S,
    farm: {
      hasData: !!pool.client || proxyUp(),
      best,
      difficulty: pool.difficulty,
      hashrate: farmHashrate(view),
      hashrateAvg: proxyUp() && proxy.totals ? proxy.totals.hashrate || null : null,
      workers: view,
      accounting: client.accounting || {},
      shares: proxyUp() && proxy.totals
        ? { today: proxy.totals.today, lastHour: proxy.totals.lastHour, source: 'proxy' }
        : { today: Number((client.accounting || {}).acceptedSharesLastDay) || 0, lastHour: Number((client.accounting || {}).acceptedSharesLastHour) || 0, source: 'public-pool' },
      lastShare: proxyUp() ? proxy.recent.find((r) => r.ok) || null : null,
      poolHashrate: Number((client.accounting || {}).hashRateLastHour) || 0,
    },
    wallet: SHOW_WALLET || internal
      ? { ...wallet, hidden: false, fiat: CURRENCY === 'USD' ? wallet.usd : wallet.brl, fiatChange24h: CURRENCY === 'USD' ? wallet.changeUsd24h : wallet.change24h }
      // escondida: só a cotação (usada no prêmio e na rede), nada de saldo ou transações
      : { hidden: true, sats: null, fiat: CURRENCY === 'USD' ? wallet.usd : wallet.brl, fiatChange24h: CURRENCY === 'USD' ? wallet.changeUsd24h : wallet.change24h },
    net: { ...net, halving },
    timeMachine: timeMachine(best),
    nearBlock: {
      tip: net.tip && net.tip.hash ? net.tip : null,
      recent: net.recentHashes || [],
      bestHash: proxy.bestHash || null,
      dayBestHash: proxy.dayBestHash || null,
    },
    luck: proxyUp() ? {
      workers: Object.values(proxy.workers).filter((w) => w.luck && w.luck.work > 0)
        .map((w) => ({ name: w.name, since: w.luck.since, ...luckOf(w.luck.work, w.luck.best) }))
        .sort((a, b) => b.factor - a.factor),
      hist: proxy.hist,
      theory: proxy.hist ? proxy.hist.map((_, k) => theoreticalShare(k)) : null,
    } : null,
    ...(() => {
      const luckWorkers = proxyUp() ? Object.values(proxy.workers).filter((w) => w.luck && w.luck.work > 0)
        .map((w) => ({ name: w.name, since: w.luck.since, ...luckOf(w.luck.work, w.luck.best) }))
        .sort((a, b) => b.factor - a.factor) : [];
      const champ = weeklyStandings(proxyUp() ? proxy.week : null, records);
      const prevChamp = proxyUp() && proxy.lastWeek ? weeklyStandings(proxy.lastWeek, records) : null;
      const championship = { ...champ, lastWeek: prevChamp && prevChamp.leader ? { key: prevChamp.key, winner: prevChamp.leader } : null };
      const proxyTotalShares = proxyUp() ? Object.values(proxy.workers).reduce((s, w) => s + (w.accepted || 0), 0) : 0;
      const poolTotalShares = Number((client.accounting || {}).totalAcceptedShares) || Number((client.accounting || {}).acceptedSharesLastDay) || 0;
      const topRec = [...records].sort((a, b) => b.value - a.value)[0];
      const ach = evaluateAchievements({
        best,
        bestWorker: topRec ? topRec.worker : null,
        totalShares: Math.max(proxyTotalShares, poolTotalShares),
        workers: view,
        proxyWorkers: proxyUp() ? Object.values(proxy.workers) : [],
        luckWorkers,
        championship,
      }, achievements);
      if (ach.newlyUnlocked.length) {
        achievements = ach.map;
        saveJson('achievements.json', achievements);
      }
      return {
        championship,
        achievements: { unlocked: ach.unlockedCount, total: ach.totalCount, list: ach.list },
      };
    })(),
    hall: [...records].sort((a, b) => b.value - a.value).slice(0, 5),
    recordSteps,
    recentRecords: [...records]
      .map((r) => ({ ...r, t: new Date(r.at).getTime() }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 10)
      .map((r) => ({ ...r, farm: recordSteps.some((s) => s.t === r.t && s.v === r.value) })),
    history,
    health: health(),
    energy: energy(view),
    bitaxes: bitaxesView(),
    theme: THEME,
  };
}

const PAGE = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fazenda de Mineração</title>
<style>
  :root, body[data-theme="obsidian"] { --bg:#0e1117; --card:#171c26; --line:#252c3a; --txt:#e6e9ef; --dim:#8a93a6; --gold:#f2a900; --on-gold:#14161c; --gold-soft:rgba(242,169,0,.06); --gold-border:rgba(242,169,0,.45); --ok:#3ecf8e; --warn:#e5534b; --backdrop:rgba(14,17,23,.88); --tip-bg:#0b0e14; --shadow:none; --radius:12px; }
  body[data-theme="ocean"] { --bg:#0b111e; --card:#131c31; --line:#223254; --txt:#e2e8f0; --dim:#8ea0c2; --gold:#38bdf8; --on-gold:#081221; --gold-soft:rgba(56,189,248,.08); --gold-border:rgba(56,189,248,.45); --ok:#34d399; --warn:#fb7185; --backdrop:rgba(11,17,30,.88); --tip-bg:#080d18; --shadow:0 4px 18px rgba(0,0,0,.28); --radius:16px; }
  body[data-theme="latte"] { --bg:#f5f3ee; --card:#ffffff; --line:#e2ded5; --txt:#1c1b18; --dim:#666159; --gold:#d97706; --on-gold:#ffffff; --gold-soft:rgba(217,119,6,.08); --gold-border:rgba(217,119,6,.42); --ok:#16a34a; --warn:#dc2626; --backdrop:rgba(28,27,24,.72); --tip-bg:#ffffff; --shadow:0 2px 10px rgba(28,27,24,.06); --radius:16px; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt); font-family:-apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; min-height:100vh; transition:background .2s, color .2s; }
  body.kiosk { cursor:none; overflow:hidden; user-select:none; }
  .page[hidden] { display:none !important; }
  /* ---------- console (fora do quiosque): barra superior, menu lateral, uma tela por vez ---------- */
  .cx-top, .cx-side, .cx-head { display:none; }
  body.console { padding:0; --cxside:232px; --cxtop:52px; }
  body.console > .cx-top { position:sticky; top:0; z-index:40; height:var(--cxtop); display:flex; align-items:center; gap:10px; padding:0 20px; background:var(--card); border-bottom:1px solid var(--line); font-size:14px; }
  .cx-brand { display:flex; align-items:center; gap:9px; color:var(--txt); text-decoration:none; font-size:15px; }
  .cx-brand b { font-weight:650; letter-spacing:-.01em; }
  .cx-logo { width:26px; height:26px; border-radius:6px; background:var(--gold); color:var(--on-gold, #111); display:grid; place-items:center; font-size:14px; }
  .cx-sep { color:var(--line); font-size:18px; } .cx-crumb { color:var(--dim); } .cx-grow { flex:1; }
  .cx-pill { display:flex; align-items:center; gap:6px; font-size:12px; border:1px solid var(--line); border-radius:999px; padding:4px 10px; color:var(--txt); white-space:nowrap; }
  .cx-pill i { width:8px; height:8px; border-radius:50%; background:var(--ok, #3fb950); display:inline-block; }
  .cx-pill.bad i { background:var(--warn); }
  .cx-badge { font:11px/1 ui-monospace, Menlo, monospace; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:4px 6px; }
  .cx-btn, body.console .cx-top .langsw { font-size:13px; border:1px solid var(--line); border-radius:6px; padding:6px 11px; color:var(--txt); text-decoration:none; white-space:nowrap; background:transparent; }
  .cx-btn:hover { border-color:var(--gold); color:var(--gold); }
  body.console .cx-shell { display:grid; grid-template-columns:var(--cxside) minmax(0, 1fr); min-height:calc(100vh - var(--cxtop)); }
  body.console .cx-side { display:block; position:sticky; top:var(--cxtop); align-self:start; height:calc(100vh - var(--cxtop)); overflow-y:auto; background:var(--card); border-right:1px solid var(--line); padding:10px 10px 24px; }
  .cx-sec { font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--dim); padding:16px 10px 6px; }
  .cx-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:6px; font-size:14px; color:var(--txt); text-decoration:none; }
  .cx-item .ic { width:20px; text-align:center; filter:grayscale(1); opacity:.65; }
  .cx-item:hover { background:var(--gold-soft); }
  .cx-item.on { background:var(--gold-soft); color:var(--gold); font-weight:600; box-shadow:inset 3px 0 0 var(--gold); }
  .cx-item.on .ic { filter:none; opacity:1; }
  .cx-item .n:not(:empty) { margin-left:auto; font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:0 7px; }
  .cx-item .n.warn:not(:empty) { color:var(--warn); border-color:var(--warn); }
  .cx-item[hidden] { display:none; }
  body.console .cx-main { padding:24px 32px 48px; min-width:0; max-width:1400px; }
  body.console .cx-head { display:flex; align-items:flex-end; gap:16px; padding-bottom:16px; margin-bottom:18px; border-bottom:1px solid var(--line); }
  .cx-head h2 { font-size:22px; font-weight:600; margin:0; letter-spacing:-.01em; }
  .cx-head p { margin:4px 0 0; color:var(--dim); font-size:14px; }
  .cx-head .narr { margin-top:6px; }
  .cx-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .cx-actions .ticket-btn { margin:0; }
  .cx-actions .ticket-btn.offpage { display:none !important; }
  body.console header { display:none; }
  body.console h2.sect { display:none; }
  body.console #pages .page { display:none; }
  body.console #pages .page.cur { display:block; }
  body.console .card { border-radius:8px; box-shadow:none; }
  @media (max-width:899px) {
    body.console > .cx-top { padding:0 12px; gap:8px; }
    body.console .cx-sep, body.console .cx-crumb, body.console #cxPing, body.console .cx-badge { display:none; }
    body.console .cx-shell { grid-template-columns:minmax(0, 1fr); }
    body.console .cx-side { position:sticky; top:var(--cxtop); z-index:30; height:auto; border-right:0; border-bottom:1px solid var(--line); padding:6px 10px; }
    body.console #cxNav { display:flex; gap:4px; overflow-x:auto; scrollbar-width:none; }
    body.console .cx-sec { display:none; }
    body.console .cx-item { white-space:nowrap; padding:7px 10px; }
    body.console .cx-item.on { box-shadow:inset 0 -2px 0 var(--gold); }
    body.console .cx-item .n:not(:empty) { margin-left:4px; }
    body.console .cx-main { padding:16px; }
    body.console .cx-head { flex-wrap:wrap; align-items:flex-start; gap:8px; }
    body.console .cx-grow + .cx-actions:empty { display:none; }
  }
  @media (max-width:599px) {
    body.console .cx-brand b { display:none; }   /* no celular fica só o logo: o ⚙️ precisa caber */
    body.console .cx-actions .cx-btn[href="?kiosk"] { display:none; }
  }
  body.console #bxcard > .label { display:none; }   /* o título da tela já diz Bitaxe */
  header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
  h1 { font-size:22px; } h1 span { color:var(--gold); }
  .upd { color:var(--dim); font-size:13px; white-space:nowrap; }
  .langsw { color:var(--dim); font-size:12px; text-decoration:none; border:1px solid var(--line); border-radius:6px; padding:2px 7px; white-space:nowrap; }
  .langsw b { color:var(--gold); font-weight:600; }
  body.kiosk .gear { display:none; }
  .narr { flex:1; min-width:0; text-align:center; color:var(--gold); font-size:14px; font-style:italic; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transition:opacity .6s; }
  .narr.fade { opacity:0; }
  .party { position:fixed; inset:0; z-index:20; display:none; align-items:center; justify-content:center; background:var(--backdrop); }
  .party.on { display:flex; }
  .party canvas { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  .party-box { position:relative; text-align:center; padding:28px 40px; border:1px solid var(--gold); border-radius:18px; background:var(--card); max-width:90vw; }
  .party-kicker { color:var(--dim); font-size:14px; letter-spacing:.12em; text-transform:uppercase; }
  .party-title { font-size:46px; font-weight:800; color:var(--gold); margin-top:6px; }
  .party-val { font-size:68px; font-weight:800; font-variant-numeric:tabular-nums; margin-top:2px; }
  .party-sub { color:var(--txt); font-size:17px; margin-top:8px; }
  .party-joke { color:var(--dim); font-size:15px; margin-top:10px; font-style:italic; }
  .party.small .party-title { font-size:32px; }
  .party.small .party-val { font-size:50px; }
  .dots { display:none; gap:7px; margin-left:auto; }
  body.kiosk .dots { display:flex; }
  .dots i { width:8px; height:8px; border-radius:50%; background:var(--line); }
  .dots i.on { background:var(--gold); }
  h2.sect { font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; margin:22px 0 10px; }
  .page:first-child h2.sect { margin-top:0; }
  body.kiosk h2.sect { display:none; }
  body.kiosk #pages { position:relative; }
  body.kiosk .page { position:absolute; inset:0; opacity:0; pointer-events:none; transition:opacity .5s; }
  body.kiosk .page.on { opacity:1; pointer-events:auto; }
  body.kiosk .page { display:flex; flex-direction:column; }
  body.kiosk .duo { flex:1; }
  body.kiosk .duo .card { display:flex; flex-direction:column; justify-content:center; }
  body.kiosk .duo .big { font-size:60px; }
  body.kiosk .duo .lead { font-size:17px; }
  body.kiosk .duo .card > .label { margin-bottom:auto; }
  body.kiosk .duo .card > :last-child { margin-bottom:auto; }
  body.kiosk .duo .sub { font-size:14px; }
  body.kiosk .p3 { flex:1; min-height:0; grid-template-rows:minmax(0,1fr) minmax(0,1fr) auto; }
  body.kiosk .duo { min-height:0; }
  body.kiosk .p3 .chart-card { display:flex; flex-direction:column; }
  body.kiosk .p3 .chart { flex:1; height:auto; min-height:90px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:14px 16px; min-width:0; }
  .label { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .big { font-size:38px; font-weight:700; margin-top:4px; font-variant-numeric:tabular-nums; }
  .grid .big { white-space:nowrap; overflow:hidden; }   /* o fitBig() reduz a fonte quando o número não cabe */
  .big.gold { color:var(--gold); }
  .sub { color:var(--dim); font-size:13px; margin-top:4px; }
  .lead { color:var(--txt); font-size:15px; margin-top:8px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); font-size:15px; }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:8px; background:var(--ok); }
  .dot.quiet { background:var(--gold); }
  .dot.stale { background:var(--warn); }
  .dot.unknown { background:var(--dim); }
  td.dim { color:var(--dim); }
  .toggle { text-transform:none; letter-spacing:0; color:var(--gold); margin-left:8px; text-decoration:none; font-size:12px; }
  body.kiosk .toggle { display:none; }
  .ticket-btn { margin-left:10px; font-size:12px; letter-spacing:0; text-transform:none; color:var(--gold); text-decoration:none; border:1px solid var(--gold); border-radius:6px; padding:2px 8px; }
  body.kiosk .ticket-btn { display:none; }
  .ticket { position:fixed; inset:0; z-index:30; display:none; flex-direction:column; align-items:center; justify-content:center; gap:12px; background:var(--backdrop); padding:16px; }
  .ticket.on { display:flex; }
  .ticket img { max-width:min(92vw, 540px); max-height:78vh; border-radius:10px; box-shadow:0 10px 40px rgba(0,0,0,.5); }
  .ticket .btns { display:flex; gap:10px; }
  .ticket button { font:inherit; font-size:14px; padding:8px 16px; border-radius:8px; border:1px solid var(--gold); background:var(--card); color:var(--txt); cursor:pointer; }
  .ticket button.main { background:var(--gold); color:var(--on-gold); font-weight:700; }
  .pool { font-size:11px; color:var(--dim); margin-left:6px; white-space:nowrap; }
  .last { display:block; font-size:11px; color:var(--dim); white-space:nowrap; }
  .last.fresh { color:var(--gold); }
  .temp { font-size:12px; color:var(--dim); border:1px solid var(--line); border-radius:6px; padding:1px 6px; margin-left:6px; white-space:nowrap; }
  .temp.warm { color:var(--gold); border-color:var(--gold); }
  .temp.hot { color:var(--warn); border-color:var(--warn); }
  .bxlist { display:grid; gap:10px; }
  .bx { border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .bx .bxh { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
  .bx .bxh b { font-size:15px; }
  .bx .bxh a { margin-left:auto; font-size:12px; color:var(--dim); }
  .bxg { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px 14px; margin-top:8px; }
  .bxg div { font-size:14px; }
  .bxg span { display:block; font-size:11px; color:var(--dim); }
  .bxg .warm { color:var(--gold); } .bxg .hot { color:var(--warn); }
  .bxwarn { color:var(--warn); font-size:13px; margin-top:6px; }
  .bxcharts { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin-top:12px; }
  .bxc { position:relative; }
  .bxc .bxct { display:flex; justify-content:space-between; gap:6px; font-size:11px; color:var(--dim); margin-bottom:2px; }
  .bxc .bxct b { color:var(--txt); font-weight:600; }
  .bxc svg { display:block; width:100%; height:64px; overflow:visible; touch-action:pan-y; }
  .bxc .tip { position:absolute; top:0; transform:translate(-50%, 0); background:var(--card); border:1px solid var(--line); border-radius:6px; padding:3px 7px; font-size:11px; color:var(--txt); white-space:nowrap; pointer-events:none; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  @media (max-width:520px) { .bxcharts { grid-template-columns:minmax(0, 1fr); } }
  .legend { float:right; text-transform:none; letter-spacing:0; }
  .legend .dot { width:7px; height:7px; margin:0 4px 0 10px; }
  .err { color:var(--warn); margin-top:8px; font-size:13px; }
  .err:empty { display:none; }
  body.kiosk #fo:not(:empty) ~ * { display:none; }
  body.kiosk .card:has(#fo:not(:empty)) .dist-cap { display:none; }   /* no kiosk, o aviso de failover ocupa o lugar da legenda */
  .bar { height:8px; background:var(--line); border-radius:4px; margin-top:10px; overflow:hidden; }
  .bar.thin { height:5px; margin-top:8px; }
  .bar i { display:block; height:100%; background:var(--gold); }
  .wallet { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:12px; }
  .wallet .big { font-size:30px; overflow-wrap:anywhere; }
  .card.wallet[hidden] { display:none; }
  .duo { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  .hexcard { margin-bottom:12px; }
  table.luck td, table.luck th { padding:6px 6px; }
  .luckbar { height:6px; background:var(--line); border-radius:3px; margin-top:4px; overflow:hidden; }
  .luckbar i { display:block; height:100%; background:var(--gold); }
  .lk-hi { color:var(--ok); font-weight:700; } .lk-lo { color:var(--warn); font-weight:700; }
  .lk-p { font-size:11px; white-space:nowrap; }
  .hist-axis { font-size:11px; text-align:right; margin-top:2px; }
  .luck-duo .lead, .champ-duo .lead, body.kiosk .luck-duo .lead { font-size:13px; color:var(--dim); margin:4px 0 6px; }
  .champ-duo { margin-top:12px; }
  .ach-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:8px; margin-top:8px; }
  .ach { display:flex; align-items:flex-start; gap:8px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; opacity:.45; }
  .ach.on { opacity:1; border-color:var(--gold-border); background:var(--gold-soft); }
  .ach-i { font-size:18px; line-height:1.2; }
  .ach-t { font-size:13px; font-weight:600; color:var(--txt); }
  .ach.on .ach-t { color:var(--gold); }
  .ach-d { font-size:11px; color:var(--dim); line-height:1.3; margin-top:2px; }
  .hist-card .chart { height:240px; }
  body.kiosk .luck-duo { flex:1; min-height:0; }
  body.kiosk .hist-card { display:flex; flex-direction:column; }
  body.kiosk .hist-card .chart { flex:1; height:auto; min-height:0; }
  .hexrow { margin-bottom:6px; }
  .hex { font-family:ui-monospace, "DejaVu Sans Mono", Menlo, monospace; font-size:15px; letter-spacing:.02em; color:var(--dim); word-break:break-all; line-height:1.35; }
  .hex .z, .z { color:var(--gold); font-weight:700; }
  .ruler { height:120px; }
  .ruler svg { width:100%; height:100%; overflow:visible; }
  body.kiosk .ruler-card { flex:1; min-height:0; display:flex; flex-direction:column; }
  body.kiosk .ruler { flex:1; min-height:0; }
  .duo .card { padding:18px 20px; }
  .duo .big { font-size:46px; margin-top:6px; }
  .p3 { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:12px; }
  .p3 .hall { grid-row:span 2; }
  .chart { height:130px; position:relative; margin-top:6px; }
  .chart svg { display:block; overflow:visible; }
  .chart text { fill:var(--dim); font-size:11px; font-family:inherit; }
  .chart .empty { color:var(--dim); font-size:13px; padding-top:44px; text-align:center; }
  .hall ol { list-style:none; margin-top:6px; }
  .hall li { display:grid; grid-template-columns:30px 1fr auto; align-items:baseline; gap:6px; padding:9px 0; border-bottom:1px solid var(--line); }
  .hall li:last-child { border-bottom:0; }
  .hall .pos { font-size:15px; color:var(--dim); font-weight:600; }
  .hall .pos.first, .hall li:first-child .val { color:var(--gold); }
  .hall .val { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
  .hall .who { color:var(--dim); font-size:12px; text-align:right; }
  .mini { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-top:8px; }
  .mini .v { font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; }
  .mini .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  .en-plugs { display:flex; flex-direction:column; gap:5px; margin-top:6px; }
  .en-prow { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; font-size:13px; color:var(--dim); }
  .en-pbtns { display:inline-flex; gap:5px; }
  body.kiosk .en-pbtns, body.kiosk .en-pin { display:none !important; }
  .en-btn { background:transparent; color:var(--gold); border:1px solid var(--line); border-radius:6px; padding:2px 7px; font-size:11px; font-family:inherit; cursor:pointer; }
  .en-btn:hover { border-color:var(--gold); }
  .en-pin { display:none; align-items:center; gap:6px; margin-top:6px; flex-wrap:wrap; }
  .en-pin.on { display:flex; }
  .en-pin input { background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:6px; padding:4px 8px; width:100px; font-size:12px; font-family:ui-monospace, monospace; }
  .en-pin span { font-size:12px; color:var(--warn); }
  .tooltip { position:fixed; pointer-events:none; background:var(--tip-bg); box-shadow:var(--shadow); border:1px solid var(--line); border-radius:8px; padding:6px 9px; font-size:12px; display:none; z-index:9; white-space:nowrap; }
  .tooltip b { color:var(--txt); } .tooltip span { color:var(--dim); }

  @media (max-width: 640px) {
    body { padding:12px; }
    header { flex-wrap:wrap; gap:4px; }
    .narr { order:5; flex-basis:100%; white-space:normal; text-align:left; font-size:13px; }
    .party-box { padding:22px 20px; }
    .party-title { font-size:30px; }
    .party-val { font-size:44px; }
    .grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .card { padding:12px; }
    .big { font-size:26px; }
    .wallet, .duo, .p3 { grid-template-columns:1fr; gap:10px; }
    .p3 .hall { grid-row:auto; }
    .wallet .big, .duo .big { font-size:28px; }
    .mini { grid-template-columns:repeat(2,minmax(0,1fr)); }
    th, td { font-size:13px; padding:7px 4px; }
    .legend { float:none; display:block; margin-top:4px; }
    .pool { display:block; margin:1px 0 0 17px; }
    .legend .dot:first-child { margin-left:0; }
    .lk-p { white-space:normal; }
    table.luck td, table.luck th { padding:7px 3px; }
  }
  @media (min-width: 641px) and (max-height: 640px) {
    body { padding:10px 14px; }
    header { margin-bottom:8px; }
    h1 { font-size:20px; }
    .grid { gap:10px; margin-bottom:10px; }
    .card { padding:10px 14px; }
    .big { font-size:30px; margin-top:2px; }
    .sub { margin-top:2px; }
    th, td { padding:3px 6px; font-size:14px; }
    .wallet { margin-top:10px; }
    .wallet .big { font-size:26px; }
    .bar { margin-top:6px; }
    .duo, .p3 { gap:10px; }
    .duo .card { padding:16px 18px; }
    .duo .big { font-size:42px; }
    .chart { height:112px; }
    body.kiosk .duo .big { font-size:56px; }
    .hall li { padding:6px 0; }
  }
  @media (max-width: 380px) {
    table.luck th:nth-child(3), table.luck td:nth-child(3) { display:none; }   /* "esperado" não cabe */
    .grid { grid-template-columns:1fr; }
    th, td { font-size:12px; padding:6px 2px; }
    th { letter-spacing:0; }
    .card { padding:10px; }
    .pool { font-size:10px; margin-left:15px; }
  }
</style>
</head>
<body data-theme="obsidian">
<div class="cx-top" id="cxTop"><a class="cx-brand" href="#overview"><span class="cx-logo">⛏</span><b>HomeMinerProxy</b></a><span class="cx-sep">/</span><span class="cx-crumb" id="cxCrumb"></span><span class="cx-grow"></span><span class="cx-pill" id="cxWorkers"></span><span class="cx-pill" id="cxPing" hidden></span><span class="cx-badge" id="cxVer" hidden></span><span id="cxLangSlot"></span><a class="cx-btn cx-gear" href="/config" id="cxGear">⚙️</a></div>
<div class="cx-shell"><aside class="cx-side"><nav id="cxNav"></nav></aside><div class="cx-main">
<div class="cx-head"><div><h2 id="cxTitle"></h2><p id="cxDesc"></p></div><span class="cx-grow"></span><div class="cx-actions" id="cxActions"></div></div>
<header>
  <h1>⛏️ Fazenda de <span>Mineração</span></h1>
  <div class="narr" id="narr"></div>
  <div class="dots" id="dots"></div>
  <a class="langsw" id="langsw" href="#" title="Switch to English"><b>PT</b> | EN</a>
  <a class="langsw gear" href="/config" title="Configurações">⚙️</a>
  <div class="upd" id="upd">carregando…</div>
</header>

<main id="pages">

<!-- Tela 1: a fazenda -->
<section class="page" data-page="overview">
  <h2 class="sect">Fazenda</h2>
  <div class="grid">
    <div class="card"><div class="label">Recorde (Best Difficulty)</div><div class="big gold" id="best">–</div><div class="sub" id="dist">–</div></div>
    <div class="card"><div class="label">Hashrate da fazenda</div><div class="big" id="hash">–</div><div class="sub" id="hashavg"></div><div class="sub" id="workers">–</div></div>
    <div class="card"><div class="label">Chance de bloco por ano</div><div class="big" id="odds">–</div><div class="sub" id="eta">–</div></div>
    <div class="card"><div class="label">Shares hoje</div><div class="big" id="shares">–</div><div class="sub" id="lasth">–</div></div>
  </div>
  <div class="card">
    <div class="label" style="margin-bottom:6px">Workers <a class="toggle" id="toggleOld" href="#"></a>
      <span class="legend"><span class="dot"></span>ativo <span class="dot quiet"></span>sem share recente <span class="dot unknown"></span>não listado <span class="dot stale"></span>parado</span>
    </div>
    <table>
      <thead><tr><th>Nome</th><th>Hashrate</th><th>Recorde</th><th>Visto há</th></tr></thead>
      <tbody id="rows"><tr><td colspan="4" class="sub">aguardando dados…</td></tr></tbody>
    </table>
    <div class="sub" style="margin-top:10px" id="netd">–</div>
    <div class="bar"><i id="prog" style="width:0%"></i></div>
    <div class="sub dist-cap" style="margin-top:4px">Distância até um bloco, em escala logarítmica.</div>
    <div class="err" id="fo"></div>
    <div class="err" id="err"></div>
    <div class="sub" style="margin-top:8px" id="pxinfo"></div>
    <details style="margin-top:6px"><summary class="sub" style="cursor:pointer">Eventos recentes</summary>
      <ul class="sub" id="evs" style="list-style:none;margin:6px 0 0;padding:0;max-height:180px;overflow:auto"></ul>
    </details>
  </div>
  <div class="card wallet">
    <div><div class="label">Carteira</div><div class="big gold" id="wbtc">–</div><div class="sub" id="wsats">–</div></div>
    <div><div class="label">Valor</div><div class="big" id="wfiat">–</div><div class="sub" id="wprice">–</div></div>
    <div><div class="label">Movimentação</div><div class="big" id="wtx">–</div><div class="sub" id="wpend">–</div></div>
  </div>
  <div class="err" id="werr"></div>
</section>

<!-- Tela 2: a rede Bitcoin -->
<section class="page" data-page="bitaxe" hidden>
  <h2 class="sect">Bitaxe</h2>
  <div class="card" id="bxcard" hidden>
    <div class="label" style="margin-bottom:6px">Bitaxe</div>
    <div class="bxlist" id="bxlist"></div>
  </div>
</section>

<section class="page" data-page="network">
  <h2 class="sect">Rede Bitcoin</h2>
  <div class="grid">
    <div class="card"><div class="label">Último bloco</div><div class="big" id="tipH">–</div><div class="sub" id="tipS">–</div></div>
    <div class="card"><div class="label">Ajuste de dificuldade</div><div class="big" id="adjC">–</div><div class="sub" id="adjS">–</div><div class="bar thin"><i id="adjP" style="width:0%"></i></div></div>
    <div class="card"><div class="label">Próximo halving</div><div class="big" id="halvB">–</div><div class="sub" id="halvS">–</div></div>
    <div class="card"><div class="label">Taxa rápida</div><div class="big" id="feeF">–</div><div class="sub" id="feeS">–</div></div>
  </div>
  <div class="duo">
    <div class="card">
      <div class="label">Prêmio em jogo</div>
      <div class="lead">Se a fazenda achar o próximo bloco, leva</div>
      <div class="big gold" id="prizeFiat">–</div>
      <div class="sub" id="prizeS">–</div>
      <div class="sub" id="priceS">–</div>
    </div>
    <div class="card">
      <div class="label">Máquina do tempo</div>
      <div class="lead" id="tmLead">–</div>
      <div class="big gold" id="tmBig">–</div>
      <div class="sub" id="tmS">–</div>
    </div>
  </div>
  <div class="err" id="nerr"></div>
</section>

<!-- Tela 3: histórico, servidor e energia -->
<section class="page" data-page="history">
  <h2 class="sect">Histórico</h2>
  <div class="p3">
    <div class="card chart-card"><div class="label">Hashrate da fazenda · últimas 24 h</div><div class="chart" id="chHr"></div></div>
    <div class="card hall"><div class="label">Hall da fama</div><ol id="hall"><li><span></span><span class="sub">aguardando dados…</span></li></ol></div>
    <div class="card chart-card"><div class="label">Evolução do recorde (escala logarítmica)</div><div class="chart" id="chRec"></div></div>
    <div class="card">
      <div class="label" id="hLabel">Servidor</div>
      <div class="mini">
        <div><div class="k">Temperatura</div><div class="v" id="hTemp">–</div></div>
        <div><div class="k">CPU</div><div class="v" id="hCpu">–</div></div>
        <div><div class="k">Memória</div><div class="v" id="hMem">–</div></div>
        <div><div class="k">Ligado há</div><div class="v" id="hUp">–</div></div>
      </div>
    </div>
    <div class="card">
      <div class="label">Energia (estimativa)</div>
      <div class="big" id="enC" style="font-size:28px">–</div>
      <div class="sub" id="enS">–</div>
      <div class="en-plugs" id="enP"></div>
      <div class="en-pin" id="enPin"><input type="password" id="enPinInp" inputmode="numeric" placeholder="PIN"><button type="button" class="en-btn" id="enPinOk">Confirmar</button><button type="button" class="en-btn" id="enPinCancel">✕</button><span id="enPinMsg"></span></div>
      <div class="sub" id="enJ">–</div>
    </div>
  </div>
</section>

<!-- Tela 4: quase bloco -->
<section class="page" data-page="near">
  <h2 class="sect">Quase bloco <a class="ticket-btn" id="ticketBtn" href="#">🎟️ Bilhete do dia</a></h2>
  <div class="card hexcard">
    <div class="hexrow"><div class="label" id="qbL1">Hash do último bloco</div><div class="hex" id="qbH1">–</div></div>
    <div class="hexrow"><div class="label" id="qbL2">Nosso melhor hash</div><div class="hex" id="qbH2">–</div></div>
    <div class="hexrow"><div class="label" id="qbL3">Melhor de hoje</div><div class="hex" id="qbH3">–</div></div>
    <div class="sub" style="margin-top:6px">Cada <b class="z">0</b> a mais na frente deixa o hash 16 vezes mais difícil de achar.</div>
  </div>
  <div class="grid">
    <div class="card"><div class="label">Zeros na frente</div><div class="big" id="qbZ">–</div><div class="sub" id="qbZs">–</div></div>
    <div class="card"><div class="label">O abismo</div><div class="big gold" id="qbGap">–</div><div class="sub" id="qbGapS">–</div></div>
    <div class="card"><div class="label">Sorte do vencedor</div><div class="big" id="qbLuck">–</div><div class="sub" id="qbLuckS">–</div></div>
    <div class="card"><div class="label">Mais sortudo (15 blocos)</div><div class="big" id="qbTop">–</div><div class="sub" id="qbTopS">–</div></div>
  </div>
  <div class="card ruler-card"><div class="label">Régua da dificuldade (escala logarítmica)</div><div id="qbRuler" class="ruler"></div></div>
</section>

<!-- Tela 5: sorte -->
<section class="page" data-page="luck">
  <h2 class="sect">Sorte</h2>
  <div class="duo luck-duo">
    <div class="card">
      <div class="label">Medidor de sorte</div>
      <div class="lead">Melhor share de cada worker comparado com o esperado para o trabalho que ele fez.</div>
      <table class="luck"><thead><tr><th>Worker</th><th>Melhor</th><th>Esperado</th><th>Sorte</th></tr></thead>
        <tbody id="lkRows"><tr><td colspan="4" class="sub">aguardando shares pelo proxy…</td></tr></tbody></table>
    </div>
    <div class="card hist-card">
      <div class="label">Distribuição dos shares</div>
      <div class="chart" id="lkHist"></div>
      <div class="sub hist-axis">dificuldade do share ÷ alvo da pool · barras: shares reais · tracejado: teoria</div>
      <div class="sub" id="lkHistS">Cada faixa tem metade dos shares da anterior, como a matemática prevê. É a prova de que a loteria é justa.</div>
    </div>
  </div>
  <div class="duo champ-duo">
    <div class="card hall">
      <div class="label">🏆 Campeonato da semana</div>
      <div class="lead" id="chLead">Ranking da semana por sorte relativa (melhor share ÷ esperado), do vovô ao ASIC.</div>
      <ol id="chRows"></ol>
      <div class="sub" id="chLast"></div>
    </div>
    <div class="card">
      <div class="label">🎖️ Conquistas <span id="achCnt" class="sub"></span></div>
      <div class="ach-grid" id="achGrid"></div>
    </div>
  </div>
</section>

</main>
</div></div>
<div class="tooltip" id="tip"></div>
<div class="ticket" id="ticket">
  <img id="ticketImg" alt="">
  <div class="btns"><button class="main" id="ticketShare">Compartilhar</button><button id="ticketSave">Baixar imagem</button><button id="ticketClose">Fechar</button></div>
</div>
<div class="party" id="party">
  <canvas id="confetti"></canvas>
  <div class="party-box">
    <div class="party-kicker" id="pKick"></div>
    <div class="party-title" id="pTitle"></div>
    <div class="party-val" id="pVal"></div>
    <div class="party-sub" id="pSub"></div>
    <div class="party-joke" id="pJoke"></div>
  </div>
</div>

<script>
const LOC = '__LOC__', CUR = '__CUR__';   // preenchidos pelo servidor (idioma e moeda)
const kiosk = new URLSearchParams(location.search).has('kiosk');
if (kiosk) document.body.classList.add('kiosk');
document.getElementById('langsw').addEventListener('click', (ev) => {
  ev.preventDefault(); ev.stopPropagation();   // no kiosk, o clique na tela também passa de página
  const next = LOC === 'pt-BR' ? 'en' : 'pt';
  document.cookie = 'lang=' + next + '; path=/; max-age=31536000; SameSite=Lax';
  if (!/[?&]lang=/.test(location.search)) return location.reload();
  location.replace(location.pathname + location.search.replace(/([?&])lang=[^&]*&?/, '$1').replace(/[?&]$/, ''));
});

const $ = (id) => document.getElementById(id);
const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
// nomes de worker vêm do usuário do minerador (qualquer um na rede pode escolher): sempre escapar antes de ir para HTML
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n, d = 0) => Number(n).toLocaleString(LOC, { maximumFractionDigits: d });
let TUNIT = 'C';   // vem do /api/mining (TEMP_UNIT)
const tmp = (c, d = 0) => (TUNIT === 'F' ? nf(c * 9 / 5 + 32, d) + ' °F' : nf(c, d) + ' °C');
const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const mesAno = (ms) => { const d = new Date(ms); return MESES[d.getMonth()] + '/' + d.getFullYear(); };
const diaMes = (ms) => new Date(ms).toLocaleDateString(LOC, { day: '2-digit', month: '2-digit' });
const hora = (ms) => new Date(ms).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' });
const money = (v) => v.toLocaleString(LOC, { style: 'currency', currency: CUR });
const moneyCompact = (v) => v >= 1e6 ? v.toLocaleString(LOC, { style: 'currency', currency: CUR, notation: 'compact', maximumFractionDigits: 2 }) : money(v);

function fmtHash(h) {
  const u = ['H/s','kH/s','MH/s','GH/s','TH/s','PH/s','EH/s']; let i = 0;
  while (h >= 1000 && i < u.length - 1) { h /= 1000; i++; }
  return nf(h, h < 10 ? 2 : 1) + ' ' + u[i];
}
function fmtBig(n) {
  const s = [[1e12,'trilhões'],[1e9,'bilhões'],[1e6,'milhões'],[1e3,'mil']];
  for (const [v, w] of s) if (n >= v) return nf(n / v, 1) + ' ' + w;
  return nf(n);
}
function dur(ms) {
  const m = ms / 60000;
  if (m < 1) return 'agora';
  if (m < 60) return nf(m) + ' min';
  const h = m / 60;
  if (h < 48) return nf(h, 1) + ' h';
  const d = h / 24;
  return nf(d, d < 10 ? 1 : 0) + ' dias';
}
const ago = (t) => t ? dur(Date.now() - new Date(t).getTime()) : '–';
const agoTxt = (t) => { const a = ago(t); return a === 'agora' ? a : 'há ' + a; };   // "há 5 min" / "agora"
function odds(hashrate, D) {
  if (!(hashrate > 0)) return null;
  const secs = D * 4294967296 / hashrate;
  return { perYear: 1 / (1 - Math.exp(-31557600 / secs)), years: secs / 31557600 };
}

// ------------------------------------------------ rotação das telas (só no kiosk)
let page = 0, rotT = null, rotS = 20;
const pages = () => Array.from(document.querySelectorAll('.page')).filter((p) => !p.hidden);
function show(i) {
  const ps = pages();
  page = (i + ps.length) % ps.length;
  ps.forEach((p, k) => p.classList.toggle('on', k === page));
  Array.from($('dots').children).forEach((d, k) => d.classList.toggle('on', k === page));
}
function schedule() { clearInterval(rotT); rotT = setInterval(() => show(page + 1), rotS * 1000); }
function fitPages() {
  if (!kiosk) return;
  const top = $('pages').getBoundingClientRect().top;
  $('pages').style.height = (window.innerHeight - top - 10) + 'px';
}
if (kiosk) {
  $('dots').innerHTML = pages().map(() => '<i></i>').join('');
  show(0); schedule(); fitPages();
  document.addEventListener('click', () => { show(page + 1); schedule(); });
}

// ------------------------------------------------ console (fora do quiosque): menu lateral, uma tela por vez
const CX = { overview: 'Visão geral', overviewD: 'Recorde, hashrate, workers e carteira da fazenda', bitaxe: 'Bitaxe', bitaxeD: 'Temperatura, consumo, pool e ações de cada Bitaxe', network: 'Rede Bitcoin', networkD: 'Dificuldade, próximo ajuste, mempool e taxas', near: 'Quase bloco', nearD: 'O quanto cada share chegou perto de um bloco', luck: 'Sorte', luckD: 'Chance de achar um bloco e o campeonato dos workers', history: 'Histórico', historyD: 'Gráficos, hall da fama, saúde do servidor e energia', gFarm: 'Fazenda', gMining: 'Mineração', gOps: 'Operação', pools: 'Pools e portas', settings: 'Configurações', kiosk: 'Modo quiosque', workers: 'workers ativos', proxyDown: 'proxy fora do ar', ping: 'ping' };
const CX_NAV = [
  [CX.gFarm, [['overview', '🏠'], ['bitaxe', '🔥']]],
  [CX.gMining, [['network', '🌐'], ['near', '🎯'], ['luck', '🍀'], ['history', '📈']]],
  [CX.gOps, [['/config#miners', '🔌', CX.pools], ['/config', '⚙️', CX.settings]]],
];
const cxPage = () => {
  const id = location.hash.slice(1), el = document.querySelector('.page[data-page="' + id + '"]');
  return el && !el.hidden ? id : 'overview';
};
function cxShow(scroll) {
  const id = cxPage();
  document.querySelectorAll('#pages .page').forEach((p) => p.classList.toggle('cur', p.dataset.page === id));
  document.querySelectorAll('#cxNav .cx-item').forEach((a) => a.classList.toggle('on', a.dataset.page === id));
  set('cxCrumb', CX[id]); set('cxTitle', CX[id]); set('cxDesc', CX[id + 'D']);
  $('ticketBtn').classList.toggle('offpage', id !== 'near');   // o bilhete do dia é da tela "Quase bloco"
  if (scroll) window.scrollTo(0, 0);
  setTimeout(() => { if (lastData) window.dispatchEvent(new Event('resize')); }, 0);   // gráficos medem a largura ao aparecer
}
if (!kiosk) {
  document.body.classList.add('console');
  $('cxNav').innerHTML = CX_NAV.map(([g, items]) => '<div class="cx-sec">' + g + '</div>' + items.map(([id, ic, label]) =>
    id[0] === '/'
      ? '<a class="cx-item" href="' + id + '"><span class="ic">' + ic + '</span>' + label + '</a>'
      : '<a class="cx-item" href="#' + id + '" data-page="' + id + '"' + (id === 'bitaxe' ? ' id="cxNavBx" hidden' : '') + '><span class="ic">' + ic + '</span>' + CX[id] + '<span class="n" id="' + (id === 'bitaxe' ? 'cxBxN' : '') + '"></span></a>').join('')).join('');
  // os elementos existentes mudam de lugar (os eventos vão junto)
  $('cxLangSlot').replaceWith($('langsw'));
  const head = document.querySelector('.cx-head > div');
  head.appendChild($('narr')); head.appendChild($('upd'));
  $('cxActions').innerHTML = '<a class="cx-btn" href="?kiosk">📺 ' + CX.kiosk + '</a>';
  $('cxActions').appendChild($('ticketBtn'));
  $('cxGear').title = CX.settings;
  fetch('/api/config/version').then((r) => r.json()).then((v) => { if (v && v.version) { set('cxVer', 'v' + v.version); $('cxVer').hidden = false; } }).catch(() => {});
  window.addEventListener('hashchange', () => cxShow(true));
  cxShow(false);
}
// barra superior: workers ativos, proxy e ping
function renderConsole(j) {
  if (kiosk) return;
  const ws = (j.farm && j.farm.workers) || [];
  const act = ws.filter((w) => !w.inactive && (w.state === 'ok' || w.state === 'quiet')).length;
  const down = j.proxy && j.proxy.up === false;
  const pill = $('cxWorkers');
  pill.classList.toggle('bad', !!down);
  pill.innerHTML = '<i></i>' + (down ? CX.proxyDown : act + ' ' + CX.workers);
  const ping = j.proxy && j.proxy.pingMs;
  $('cxPing').hidden = ping == null;
  if (ping != null) set('cxPing', CX.ping + ' ' + ping + ' ms');
  // tela Bitaxe só com Bitaxe cadastrado; o número e o alerta aparecem no menu
  const bx = j.bitaxes || [];
  const sec = document.querySelector('.page[data-page="bitaxe"]');
  const wasHidden = sec.hidden;
  sec.hidden = !bx.length; $('cxNavBx').hidden = !bx.length;
  const alert = bx.some((b) => b.alerts && Object.keys(b.alerts).length);
  set('cxBxN', bx.length ? (alert ? '⚠ ' : '') + bx.length : '');
  $('cxBxN').classList.toggle('warn', alert);
  if (wasHidden !== sec.hidden && location.hash === '#bitaxe') cxShow(false);
}

// ------------------------------------------------ gráfico de linha em SVG (uma série)
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function lineChart(el, pts, o) {
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  if (pts.length < 2) { el.innerHTML = '<div class="empty">' + o.empty + '</div>'; el._c = null; return; }
  const L = 58, R = 10, T = 8, B = 20, iw = W - L - R, ih = H - T - B;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const tx = (t) => L + (t1 > t0 ? (t - t0) / (t1 - t0) : 0.5) * iw;
  let ty, ticks;
  if (o.log) {
    const vs = pts.map((p) => Math.max(p.v, 1e-3));
    let a = Math.floor(Math.log10(Math.min.apply(null, vs))), b = Math.ceil(Math.log10(Math.max.apply(null, vs)));
    if (b === a) b = a + 1;
    ty = (v) => T + ih - (Math.log10(Math.max(v, 1e-3)) - a) / (b - a) * ih;
    ticks = []; for (let k = a; k <= b; k++) ticks.push(Math.pow(10, k));
  } else {
    const mx = niceMax(Math.max.apply(null, pts.map((p) => p.v)));
    ty = (v) => T + ih - v / mx * ih;
    ticks = [0, mx / 2, mx];
  }
  let d = 'M' + tx(pts[0].t).toFixed(1) + ' ' + ty(pts[0].v).toFixed(1);
  for (let i = 1; i < pts.length; i++) {
    const x = tx(pts[i].t).toFixed(1), y = ty(pts[i].v).toFixed(1);
    d += o.step ? ' H' + x + ' V' + y : ' L' + x + ' ' + y;
  }
  let s = '<svg width="' + W + '" height="' + H + '">';
  for (const v of ticks) {
    const y = ty(v).toFixed(1);
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--line);stroke-width:1"/>';
    s += '<text x="' + (L - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end">' + o.fmtY(v) + '</text>';
  }
  const n = Math.min(pts.length, Math.max(2, Math.min(4, Math.floor(iw / (o.labelW || 95)))));
  for (let k = 0; k < n; k++) {
    const t = t0 + (t1 - t0) * (n === 1 ? 0 : k / (n - 1));
    const anchor = k === 0 ? 'start' : (k === n - 1 ? 'end' : 'middle');
    s += '<text x="' + tx(t).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anchor + '">' + o.fmtX(t) + '</text>';
  }
  if (!o.log) {
    const base = ty(0).toFixed(1);
    s += '<path d="' + d + ' L' + tx(t1).toFixed(1) + ' ' + base + ' L' + tx(t0).toFixed(1) + ' ' + base + ' Z" style="fill:var(--gold);fill-opacity:.12;stroke:none"/>';
  }
  s += '<path d="' + d + '" style="fill:none;stroke:var(--gold);stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>';
  const last = pts[pts.length - 1];
  s += '<circle cx="' + tx(last.t).toFixed(1) + '" cy="' + ty(last.v).toFixed(1) + '" r="4" style="fill:var(--gold);stroke:var(--card);stroke-width:2"/>';
  s += '<line class="xh" x1="0" x2="0" y1="' + T + '" y2="' + (T + ih) + '" style="stroke:var(--dim);stroke-width:1;display:none"/>';
  s += '<circle class="xd" r="5" style="fill:var(--gold);stroke:var(--card);stroke-width:2;display:none"/>';
  s += '<rect x="' + L + '" y="0" width="' + iw + '" height="' + H + '" style="fill:transparent"/>';
  s += '</svg>';
  el.innerHTML = s;
  el._c = { pts, tx, ty, o };
  if (!el._hover && !kiosk) {
    el._hover = true;
    el.addEventListener('pointermove', (ev) => {
      const c = el._c; if (!c) return;
      const r = el.getBoundingClientRect(), x = ev.clientX - r.left;
      let best = c.pts[0];
      for (const p of c.pts) if (Math.abs(c.tx(p.t) - x) < Math.abs(c.tx(best.t) - x)) best = p;
      const xh = el.querySelector('.xh'), xd = el.querySelector('.xd');
      const px = c.tx(best.t), py = c.ty(best.v);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.style.display = '';
      xd.setAttribute('cx', px); xd.setAttribute('cy', py); xd.style.display = '';
      const tip = $('tip');
      tip.innerHTML = '<b>' + c.o.fmtV(best) + '</b> <span>' + c.o.fmtT(best.t) + '</span>';
      tip.style.display = 'block';
      tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + px + 12) + 'px';
      tip.style.top = (r.top + py - 34) + 'px';
    });
    el.addEventListener('pointerleave', () => {
      $('tip').style.display = 'none';
      el.querySelectorAll('.xh, .xd').forEach((n) => (n.style.display = 'none'));
    });
  }
}

// ------------------------------------------------ renderização
let lastData = null;
let showInactive = false;
try { showInactive = localStorage.getItem('showInactive') === '1'; } catch (_) { /* sem storage: padrão */ }
if (kiosk) showInactive = false;
$('toggleOld').addEventListener('click', (ev) => {
  ev.preventDefault();
  showInactive = !showInactive;
  try { localStorage.setItem('showInactive', showInactive ? '1' : '0'); } catch (_) { /* ignora */ }
  if (lastData) renderFarm(lastData);
});
let lastOcean = null;

function renderProxyExtras(p) {
  const info = $('pxinfo'), ul = $('evs');
  if (!info || !ul) return;
  if (!p || !p.up) { info.textContent = ''; ul.innerHTML = ''; return; }
  const pr = p.process, parts = [];
  if (p.efficiency != null) parts.push('Eficiência: ' + nf(p.efficiency, 1) + '%');
  if (pr) {
    const up = pr.uptimeS >= 86400 ? Math.floor(pr.uptimeS / 86400) + 'd ' + Math.floor(pr.uptimeS % 86400 / 3600) + 'h' : pr.uptimeS >= 3600 ? Math.floor(pr.uptimeS / 3600) + 'h ' + Math.floor(pr.uptimeS % 3600 / 60) + 'min' : Math.floor(pr.uptimeS / 60) + 'min';
    parts.push('Proxy: ' + up + ' no ar · ' + pr.rssMB + ' MB · CPU ' + nf(pr.cpuPct, 1) + '% · ' + pr.sessions + ' sessão(ões)' + (pr.queueBytes > 0 ? ' · fila ' + pr.queueBytes + ' B' : ''));
  }
  info.textContent = parts.join(' · ');
  const icon = { worker_up: '🟢', worker_down: '🔴', pool_up: '🟢', pool_down: '🔴', failover: '🔁', reject: '⚠️' };
  ul.innerHTML = (p.events || []).map((e) => '<li>' + (icon[e.type] || '•') + ' ' + hora(e.at) + ' — ' + esc(e.msg) + '</li>').join('') || '<li>nenhum evento ainda</li>';
}

const BXT = { noAnswer: 'sem resposta', hash: 'Hashrate (10 min)', of: 'de', expected: 'esperado', chip: 'Chip', vr: 'Regulador', power: 'Consumo', fan: 'Fan', freq: 'Frequência', pool: 'Pool', backup: 'reserva', best: 'Melhor da sessão', up: 'Ligado há', wifi: 'Wi-Fi', paused: 'pausado', overheat: 'superaquecido: o AxeOS baixou a frequência', powerFault: 'falha de energia (confira a fonte)', hwFault: 'falha de hardware', open: 'abrir o AxeOS ↗', last: 'última leitura', hot: 'chip quente', vrhot: 'regulador quente', lowhash: 'hashrate baixo', onBackup: 'na pool reserva', reboots: 'reinícios', lastAct: 'Última ação', acts: { restart: 'reiniciar', identify: 'identificar', pause: 'pausar', resume: 'retomar', fan: 'fan', point: 'apontar para o proxy' }, actFail: 'falhou', actions: 'ações ⚙️', chHash: 'Hashrate · 24 h', chTemp: 'Chip · 24 h', chWait: 'o gráfico aparece depois de 10 min de leituras' };
// Gráficos de 24 h do Bitaxe: dois pequenos lado a lado (hashrate e chip), cada um com o seu eixo, nunca dois eixos no mesmo
const BXCH = {};   // id do gráfico → pontos, para o tooltip
function bxChart(id, title, pts, fmt) {
  if (pts.length < 2) return '';
  const W = 300, H = 64, pad = 3;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const X = (t) => (t1 === t0 ? W : ((t - t0) / (t1 - t0)) * W), Y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join('');
  BXCH[id] = { pts, X, Y, fmt, W };
  const last = pts[pts.length - 1].v;
  return '<div class="bxc" data-ch="' + id + '"><div class="bxct"><span>' + title + '</span><span>' + fmt(Math.min(...vs)) + ' – ' + fmt(Math.max(...vs)) + ' · <b>' + fmt(last) + '</b></span></div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + title + ': ' + fmt(last) + '">' +
    '<line x1="0" x2="' + W + '" y1="' + (H - 0.5) + '" y2="' + (H - 0.5) + '" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
    '<path d="' + line + '" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
    '<line class="cx" x1="0" x2="0" y1="0" y2="' + H + '" stroke="var(--dim)" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/></svg></div>';
}
function bxCharts(b) {
  const h = (b.hist || []).filter((p) => p && p.t);
  const hr = h.filter((p) => p.hr > 0).map((p) => ({ t: p.t, v: p.hr }));
  const tp = h.filter((p) => p.temp != null).map((p) => ({ t: p.t, v: TUNIT === 'F' ? p.temp * 9 / 5 + 32 : p.temp }));
  const c1 = bxChart('h-' + b.name, BXT.chHash, hr, fmtHash), c2 = bxChart('t-' + b.name, BXT.chTemp, tp, (v) => nf(v, 1) + (TUNIT === 'F' ? ' °F' : ' °C'));
  return c1 || c2 ? '<div class="bxcharts">' + c1 + c2 + '</div>' : '<div class="sub" style="margin-top:8px">' + BXT.chWait + '</div>';
}
// tooltip: linha vertical + hora e valor do ponto mais perto (mouse e toque)
function bxHover(ev) {
  const box = ev.target.closest && ev.target.closest('.bxc');
  for (const c of document.querySelectorAll('.bxc')) if (c !== box) { const t = c.querySelector('.tip'); if (t) t.remove(); const cx = c.querySelector('.cx'); if (cx) cx.setAttribute('visibility', 'hidden'); }
  if (!box) return;
  const ch = BXCH[box.dataset.ch]; if (!ch) return;
  const svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
  const x = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * ch.W;
  let best = ch.pts[0];
  for (const p of ch.pts) if (Math.abs(ch.X(p.t) - x) < Math.abs(ch.X(best.t) - x)) best = p;
  const px = ch.X(best.t);
  const cx = svg.querySelector('.cx'); cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
  let tip = box.querySelector('.tip'); if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; box.appendChild(tip); }
  tip.textContent = new Date(best.t).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' }) + ' · ' + ch.fmt(best.v);
  tip.style.left = Math.min(Math.max(px / ch.W * r.width, 40), r.width - 40) + 'px';
  tip.style.top = (svg.offsetTop + 2) + 'px';   // dentro do gráfico, sem cobrir os números de cima
}
if (typeof document !== 'undefined') { document.addEventListener('mousemove', bxHover); document.addEventListener('touchstart', bxHover, { passive: true }); }
function bxTemp(t) { return t >= 68 ? 'hot' : t >= 60 ? 'warm' : ''; }
function renderBitaxes(j) {
  const list = j.bitaxes || [];
  $('bxcard').hidden = !list.length;
  const sec = $('bxcard').closest('.page');
  if (kiosk && sec.hidden !== !list.length) { sec.hidden = !list.length; $('dots').innerHTML = pages().map(() => '<i></i>').join(''); show(page); }
  if (!list.length) return;
  const st = (label, val) => '<div><span>' + label + '</span>' + val + '</div>';
  $('bxlist').innerHTML = list.map((b) => {
    const d = b.data;
    const link = /^[\w.:\-]+$/.test(b.host) ? '<a href="http://' + esc(b.host) + '/" target="_blank" rel="noopener noreferrer">' + BXT.open + '</a>' : '';
    const head = '<div class="bxh"><b>' + esc(b.name) + '</b><span class="sub">' + esc([d && d.model, d && d.version, b.host].filter(Boolean).join(' · ')) + '</span>' +
      (!b.fresh ? '<span class="temp hot">' + BXT.noAnswer + (b.okAt ? ' · ' + BXT.last + ' ' + agoTxt(b.okAt) : '') + '</span>' : '') + link + '<a href="/config#miners">' + BXT.actions + '</a></div>';
    if (!d) return '<div class="bx">' + head + '</div>';
    const hr = d.hashRate10m || d.hashRate;
    const al = b.alerts || {};
    const warn = [al.hot && BXT.hot, al.vrhot && BXT.vrhot, al.lowhash && BXT.lowhash + ' (' + al.lowhash.pct + '%)', al.fallback && BXT.onBackup,
      d.paused && BXT.paused, d.overheat && BXT.overheat, d.powerFault && BXT.powerFault, d.hardwareFault && BXT.hwFault].filter(Boolean);
    return '<div class="bx">' + head + '<div class="bxg">' +
      st(BXT.hash, fmtHash(hr) + (d.expected ? ' <span>' + BXT.of + ' ' + fmtHash(d.expected) + ' ' + BXT.expected + '</span>' : '')) +
      st(BXT.chip, d.tempC != null ? '<b class="' + bxTemp(d.tempC) + '">' + tmp(d.tempC, 1) + '</b>' : '–') +
      (d.vrTempC != null ? st(BXT.vr, tmp(d.vrTempC, 1)) : '') +
      st(BXT.power, (d.watts != null ? nf(d.watts, 1) + ' W' : '–') + (d.jth ? ' · ' + nf(d.jth, 1) + ' J/TH' : '')) +
      st(BXT.fan, (d.fanPct != null ? nf(d.fanPct) + '%' : '–') + (d.fanRpm ? ' · ' + nf(d.fanRpm) + ' RPM' : '')) +
      st(BXT.freq, (d.freqMhz != null ? nf(d.freqMhz) + ' MHz' : '–') + (d.coreMv ? ' · ' + nf(d.coreMv) + ' mV' : '')) +
      st(BXT.pool, esc((d.pool.url || '–') + (d.pool.port ? ':' + d.pool.port : '')) + (d.pool.fallback ? ' <b class="warm">(' + BXT.backup + ')</b>' : '')) +
      st(BXT.best, d.bestSessionDiff != null ? nf(d.bestSessionDiff, 0) : '–') +
      st(BXT.up, d.uptimeS != null ? dur(d.uptimeS * 1000) : '–') +
      (d.rssi != null ? st(BXT.wifi, nf(d.rssi) + ' dBm') : '') +
      (b.lastAction ? st(BXT.lastAct, (BXT.acts[b.lastAction.action] || esc(b.lastAction.action)) + ' · ' + agoTxt(b.lastAction.at) + (b.lastAction.ok ? '' : ' <b class="hot">' + BXT.actFail + '</b>')) : '') +
      (b.reboots ? st(BXT.reboots, nf(b.reboots) + (b.lastReset ? ' <span>' + esc(b.lastReset) + '</span>' : '')) : '') +
      '</div>' + bxCharts(b) + (warn.length ? '<div class="bxwarn">⚠️ ' + warn.join(' · ') + '</div>' : '') + '</div>';
  }).join('');
}
function renderFarm(j) {
  const f = j.farm, a = f.accounting || {}, D = f.difficulty;
  if (!f.hasData) return;
  set('best', f.best >= 1e7 ? fmtBig(f.best) : nf(f.best, 2));   // recordes enormes não cabem no cartão
  set('dist', f.best > 0 ? 'faltam ' + fmtBig(D / f.best) + ' de vezes' : '–');
  set('hash', fmtHash(f.hashrate));
  const av = f.hashrateAvg;
  set('hashavg', av ? '15 min ' + fmtHash(av.m15) + ' · 1 h ' + fmtHash(av.h1) + ' · 24 h ' + fmtHash(av.h24) : '');
  const inactive = f.workers.filter((w) => w.inactive).length;
  const visible = f.workers.filter((w) => showInactive || !w.inactive);
  const count = (st) => visible.filter((w) => w.state === st).length;
  const parts = [(count('ok') + count('quiet')) + ' confirmados'];
  if (count('unknown')) parts.push(count('unknown') + ' não listados');
  if (count('stale')) parts.push(count('stale') + ' parado(s)');
  if (inactive && !showInactive) parts.push(inactive + ' inativo(s) oculto(s)');
  const tg = $('toggleOld');
  tg.style.display = inactive ? '' : 'none';
  tg.textContent = showInactive ? 'esconder inativos' : 'mostrar inativos (' + inactive + ')';
  set('workers', parts.join(' · ') + (f.poolHashrate ? ' · pool mediu ~' + fmtHash(f.poolHashrate) + ' na última hora' : ''));
  const od = odds(f.hashrate, D);
  if (od) { set('odds', '1 em ' + fmtBig(od.perYear)); set('eta', 'tempo esperado: ~' + fmtBig(od.years) + ' de anos'); }
  const sh = f.shares || { today: a.acceptedSharesLastDay || 0, lastHour: a.acceptedSharesLastHour || 0 };
  set('shares', nf(sh.today));
  const ls = f.lastShare;
  set('lasth', nf(sh.lastHour) + ' na última hora' + (ls ? ' · último: ' + ls.worker + ' ' + (ls.diff < 1 ? nf(Number(ls.diff.toPrecision(3)), 8) : nf(ls.diff, 2)) + ' ' + (ago(ls.at) === 'agora' ? 'agora' : 'há ' + ago(ls.at)) : ''));

  const h = j.health || {};
  $('rows').innerHTML = visible.length ? visible.map((w) => {
    const cls = w.state === 'ok' ? '' : ' ' + w.state;
    const dim = w.state === 'ok' ? '' : ' class="dim"';
    let temp = '';
    if (h.tempC != null && w.name === h.worker) {
      temp = ' <span class="temp ' + (h.tempC >= 75 ? 'hot' : h.tempC >= 60 ? 'warm' : '') + '">' + tmp(h.tempC) + '</span>';
    }
    if (w.bitaxe) {
      const bx = w.bitaxe;
      temp = ' <span class="temp ' + bxTemp(bx.tempC) + '">' + [bx.tempC != null ? tmp(bx.tempC) : null, bx.watts != null ? nf(bx.watts, 1) + ' W' : null, bx.fallback ? BXT.backup : null, bx.paused ? BXT.paused : null].filter(Boolean).join(' · ') + '</span>';
    }
    const hr = (w.state === 'unknown' || w.approx ? '~' : '') + fmtHash(Number(w.hashRate));
    let best = Number(w.bestDifficulty) > 0 ? nf(Number(w.bestDifficulty), 2) : '–';
    if (w.lastDiff && w.lastDiff.diff != null) {
      const fresh = Date.now() - w.lastDiff.at < 5 * 60e3;   // destaque nos 5 min depois do share
      best += '<span class="last' + (fresh ? ' fresh' : '') + '">último ' + (w.lastDiff.diff < 1 ? nf(Number(w.lastDiff.diff.toPrecision(3)), 8) : nf(w.lastDiff.diff, w.lastDiff.diff < 10 ? 3 : 2)) + '</span>';
    }
    const seen = w.state === 'unknown' ? 'não listado' : ago(w.lastSeen);
    const pool = w.pool ? ' <span class="pool">' + (w.viaProxy ? '⚡ ' : '') + esc(w.pool) + '</span>' : '';
    const det = [w.ip, w.shareDiff ? 'diff ' + nf(w.shareDiff, 0) : null].filter(Boolean).join(' · ');
    const netInfo = det ? ' <span class="sub" title="extranonce1: ' + esc(w.extranonce1 || '–') + '">' + esc(det) + '</span>' : '';
    const rej = w.rejected > 0 ? ' <span class="sub" title="recusados pela pool: stale = job vencido, duplicado = share repetido">✗ ' + w.rejected + ' (stale ' + (w.stale || 0) + ' · duplicado ' + (w.duplicate || 0) + ')</span>' : '';
    const trophy = j.championship && j.championship.leader && j.championship.leader.name === w.name ? ' 🏆' : '';
    return '<tr><td><span class="dot' + cls + '"></span>' + esc(w.name) + trophy + pool + netInfo + rej + temp +
      '</td><td' + dim + '>' + hr + '</td><td>' + best +
      '</td><td' + dim + '>' + seen + '</td></tr>';
  }).join('') : '<tr><td colspan="4" class="sub">nenhum worker enviou shares ainda</td></tr>';

  const pScoreMap = { great: 'ótimo', good: 'bom', poor: 'ruim' };
  const pDot = (sc) => (sc === 'great' ? '🟢' : sc === 'good' ? '🟡' : sc === 'poor' ? '🔴' : '⚪');
  const pools = (j.proxy && j.proxy.pools) || [];
  const pingTxt = pools.length
    ? ' · Ping: ' + pools.map((p) => p.label + ' ' + pDot(p.pingScore) + ' ' + (p.pingMs != null ? nf(p.pingMs) + ' ms' : '–')).join(' · ')
    : (j.proxy && j.proxy.pingMs != null)
    ? ' · Ping da pool: ' + j.proxy.pingMs + ' ms (' + (j.proxy.pingScore === 'great' ? '🟢 ' : j.proxy.pingScore === 'good' ? '🟡 ' : '🔴 ') + (pScoreMap[j.proxy.pingScore] || '–') + ')'
    : '';
  set('netd', 'Dificuldade da rede: ' + fmtBig(D) + pingTxt);
  const pct = f.best > 1 ? Math.min(100, Math.log10(f.best) / Math.log10(D) * 100) : 0;
  $('prog').style.width = pct.toFixed(1) + '%';
}

// Números grandes ficam numa linha só: se não couberem no card, a fonte diminui até caber
function fitBig() {
  document.querySelectorAll('.grid .big').forEach((el) => {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && size > 16) { size -= 1; el.style.fontSize = size + 'px'; }
  });
}

function renderWallet(w) {
  if (!w) return;
  document.querySelector('.card.wallet').hidden = !!w.hidden;
  if (w.hidden) return set('werr', '');
  set('werr', w.error && w.sats === null ? 'Saldo indisponível: ' + w.error : '');
  if (w.sats === null) return;
  const btc = w.sats / 1e8;
  set('wbtc', btc.toLocaleString(LOC, { minimumFractionDigits: 8, maximumFractionDigits: 8 }) + ' BTC');
  const oc = lastOcean;
  set('wsats', nf(w.sats) + ' sats' + (oc && oc.unpaidSats > 0 ? ' · +' + nf(oc.unpaidSats) + ' a receber na OCEAN' : ''));
  if (w.fiat) { set('wfiat', money(btc * w.fiat)); set('wprice', '1 BTC = ' + money(w.fiat)); }
  set('wtx', nf(w.txCount) + (w.txCount === 1 ? ' transação' : ' transações'));
  set('wpend', w.pendingSats ? (w.pendingSats > 0 ? '+' : '') + nf(w.pendingSats) + ' sats pendentes' : 'nada pendente');
}

function renderNet(j) {
  const n = j.net || {}, w = j.wallet || {};
  if (n.tip) {
    set('tipH', '#' + nf(n.tip.height));
    set('tipS', agoTxt(n.tip.time * 1000) + (n.tip.pool ? ' · ' + n.tip.pool : ''));
  }
  if (n.adj && Number.isFinite(n.adj.change)) {
    set('adjC', (n.adj.change >= 0 ? '+' : '') + nf(n.adj.change, 1) + '%');
    set('adjS', 'em ~' + dur(n.adj.retargetAt - Date.now()) + ' · faltam ' + nf(n.adj.remainingBlocks) + ' blocos');
    $('adjP').style.width = Math.max(0, Math.min(100, n.adj.progress || 0)).toFixed(1) + '%';
  }
  if (n.halving) {
    set('halvB', nf(n.halving.remaining) + ' blocos');
    set('halvS', '~' + mesAno(n.halving.at) + ' · 3,125 → 1,5625 BTC');
  }
  if (n.fees) {
    set('feeF', nf(n.fees.fast) + ' sat/vB');
    set('feeS', '30 min: ' + nf(n.fees.halfHour) + ' · 1 h: ' + nf(n.fees.hour) + ' · econ.: ' + nf(n.fees.economy));
  }
  if (n.prize) {
    const btc = n.prize.sats / 1e8;
    set('prizeFiat', w.fiat ? moneyCompact(btc * w.fiat) : nf(btc, 3) + ' BTC');
    set('prizeS', nf(btc, 3) + ' BTC: 3,125 de recompensa + ' + nf(n.prize.feesSats / 1e8, 3) + ' em taxas (média dos últimos blocos)');
  }
  if (w.fiat) {
    const c = w.fiatChange24h;
    set('priceS', '1 BTC = ' + money(w.fiat) + (Number.isFinite(c) ? ' · ' + (c >= 0 ? '▲ +' : '▼ ') + nf(c, 1) + '% em 24 h' : ''));
  }
  const tm = j.timeMachine, best = j.farm.best;
  if (tm && tm.now) {
    set('tmLead', 'Seu recorde de ' + nf(best, 2) + ' já vale um bloco hoje!');
    set('tmBig', '🎉 BLOCO!'); set('tmS', 'confira a carteira');
  } else if (tm) {
    set('tmLead', 'Com o recorde de ' + nf(best, 2) + ', a fazenda teria minerado um bloco em');
    set('tmBig', mesAno(tm.from * 1000));
    set('tmS', 'dificuldade da rede na época: ' + nf(tm.diff, tm.diff < 10 ? 2 : 0) + ' · bloco ~' + nf(tm.height) +
      (tm.until ? ' · valeu até ' + mesAno(tm.until * 1000) : ''));
  } else if (best > 0) {
    set('tmLead', 'Com o recorde de ' + nf(best, 2) + ', a fazenda teria minerado um bloco em');
    set('tmBig', '–'); set('tmS', 'histórico de dificuldade ainda não carregou');
  }
  set('nerr', n.error && !n.okAt ? 'Rede indisponível: ' + n.error : '');
}

// ------------------------------------------------ tela 4: quase bloco
const zeros = (h) => (h.match(/^0*/) || [''])[0].length;
const hexHtml = (h) => { h = /^[0-9a-f]{64}$/i.test(h || '') ? h : '–'; const z = zeros(h); return '<span class="z">' + h.slice(0, z) + '</span>' + h.slice(z); };
function fmtShort(n) {
  for (const [v, w] of [[1e12, ' tri'], [1e9, ' bi'], [1e6, ' mi'], [1e3, ' mil']]) if (n >= v) return nf(n / v, n / v < 100 ? 1 : 0) + w;
  return nf(n);
}
function diffTxt(d) { return d >= 1e3 ? fmtBig(d) : nf(d, d < 1 ? 5 : 2); }
function renderNear(j) {
  const nb = j.nearBlock || {}, f = j.farm || {}, t = nb.tip;
  if (!t) return;
  set('qbL1', 'Hash do bloco #' + nf(t.height) + (t.pool ? ' · ' + t.pool : '') + ' · dificuldade ' + diffTxt(t.hashDiff));
  $('qbH1').innerHTML = hexHtml(t.hash);
  const b = nb.bestHash, d = nb.dayBestHash;
  if (b) { set('qbL2', 'Nosso melhor hash · ' + b.worker + ' · dificuldade ' + diffTxt(b.diff)); $('qbH2').innerHTML = hexHtml(b.hash); }
  else { set('qbL2', 'Nosso melhor hash'); set('qbH2', 'o proxy ainda não registrou nenhum hash'); }
  $('ticketBtn').style.display = d || b ? '' : 'none';   // o bilhete precisa de um hash registrado pelo proxy
  if (d) { set('qbL3', 'Melhor de hoje · ' + d.worker + ' · dificuldade ' + diffTxt(d.diff)); $('qbH3').innerHTML = hexHtml(d.hash); }
  else { set('qbL3', 'Melhor de hoje'); set('qbH3', '–'); }

  const zb = zeros(t.hash), zo = b ? zeros(b.hash) : null;
  set('qbZ', zo != null ? zb + ' × ' + zo : zb + ' × ?');
  set('qbZs', zo != null ? 'o bloco tem ' + (zb - zo) + ' zeros a mais que o nosso melhor: 16 elevado a ' + (zb - zo) : 'zeros do bloco × zeros do nosso melhor');

  const best = Math.max(f.best || 0, b ? b.diff : 0);
  if (best > 0 && t.hashDiff) {
    set('qbGap', fmtShort(t.hashDiff / best) + '×');
    const secs = f.hashrate > 0 ? t.hashDiff * 4294967296 / f.hashrate : 0;
    set('qbGapS', 'o hash do bloco é isso mais difícil que o nosso recorde (' + nf(best, 2) + ')' +
      (secs ? '. No ritmo da fazenda, um hash assim sai a cada ~' + fmtBig(secs / 31557600) + ' de anos.' : '.'));
  }
  if (t.hashDiff && t.target) {
    const l = t.hashDiff / t.target;
    set('qbLuck', nf(l, l < 10 ? 2 : 0) + '×');
    set('qbLuckS', 'além do mínimo da rede (' + fmtBig(t.target) + '). ' + (l < 1.5 ? 'Passou raspando.' : l < 5 ? 'Bloco normal.' : 'Sorte grande.'));
  }
  const rs = (nb.recent || []).filter((r) => r.hashDiff && r.target);
  if (rs.length) {
    const top = rs.reduce((a, r) => (r.hashDiff / r.target > a.hashDiff / a.target ? r : a));
    set('qbTop', nf(top.hashDiff / top.target, 1) + '×');
    set('qbTopS', 'bloco #' + nf(top.height) + (top.pool ? ' · ' + top.pool : '') + ' · ' + zeros(top.hash) + ' zeros');
  }
  ruler(j, t, best);
}

function ruler(j, t, best) {
  const el = $('qbRuler'); el.style.height = '';
  const W = el.clientWidth || 600;
  let H = el.clientHeight || 120;
  const max = Math.log10(t.hashDiff * 3), x = (v) => 14 + (W - 28) * Math.max(0, Math.log10(Math.max(v, 1))) / max;
  const ticks = [[1, '1'], [1e3, 'mil'], [1e6, 'milhão'], [1e9, 'bilhão'], [1e12, 'trilhão'], [1e15, 'quatrilhão']].filter(([v]) => Math.log10(v) <= max);
  // recordes dos workers: rótulos em cima da linha, em quantas fileiras forem precisas para não sobrepor
  const marks = (j.farm.workers || []).filter((w) => Number(w.bestDifficulty) >= 1 && !w.inactive)
    .map((w) => ({ v: Number(w.bestDifficulty), l: w.name })).sort((a, b) => a.v - b.v);
  const rowEnd = [];   // onde termina o último rótulo de cada fileira
  for (const m of marks) {
    m.x = x(m.v);
    const half = m.l.length * 3.4 + 6;
    m.row = rowEnd.findIndex((e) => m.x - half > e);
    if (m.row < 0) { m.row = rowEnd.length; rowEnd.push(0); }
    rowEnd[m.row] = m.x + half;
  }
  const mid = Math.max(H * 0.55, 16 + rowEnd.length * 14);
  if (mid + 30 > H) { H = Math.ceil(mid + 30); el.style.height = H + 'px'; }   // muitos workers juntos: a régua cresce
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '"><line x1="14" x2="' + (W - 14) + '" y1="' + mid + '" y2="' + mid + '" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/>';
  svg += '<line x1="14" x2="' + x(best) + '" y1="' + mid + '" y2="' + mid + '" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>';
  let tickEnd = -1e9;   // rótulos da escala que não cabem (tela estreita) ficam só com o traço
  for (const [v, l] of ticks) {
    const hw = l.length * 3.3, tx = Math.min(x(v), W - hw), fits = tx - hw - 6 > tickEnd;
    if (fits) tickEnd = tx + hw;
    svg += '<line x1="' + x(v) + '" x2="' + x(v) + '" y1="' + (mid + 5) + '" y2="' + (mid + 11) + '" stroke="var(--dim)"/>' +
      (fits ? '<text x="' + tx + '" y="' + (mid + 24) + '" fill="var(--dim)" font-size="11" text-anchor="middle">' + l + '</text>' : '');
  }
  for (const m of marks) {
    svg += '<circle cx="' + m.x + '" cy="' + mid + '" r="5" fill="var(--gold)" stroke="var(--bg)" stroke-width="2"/>' +
      '<text x="' + m.x + '" y="' + (mid - 12 - m.row * 14) + '" fill="var(--txt)" font-size="11" text-anchor="middle">' + esc(m.l) + '</text>';
  }
  // alvo da rede e hash do bloco
  const top = [[t.target, 'alvo da rede', 'var(--dim)'], [t.hashDiff, 'bloco #' + nf(t.height), 'var(--ok)']];
  top.forEach(([v, l, c], k) => {
    const mx = x(v);
    svg += '<line x1="' + mx + '" x2="' + mx + '" y1="' + (mid - 8) + '" y2="' + (mid + 8) + '" stroke="' + c + '" stroke-width="3"/>' +
      '<text x="' + Math.min(mx, W - l.length * 3.4) + '" y="' + (k ? mid - 26 : mid - 12) + '" fill="' + c + '" font-size="11" text-anchor="middle">' + esc(l) + '</text>';
  });
  el.innerHTML = svg + '</svg>';
}

// ------------------------------------------------ tela 5: sorte
function renderGamification(j) {
  const ch = j.championship || {}, st = ch.standings || [];
  const ol = $('chRows');
  if (ol) {
    ol.replaceChildren();
    if (!st.length) {
      const li = document.createElement('li');
      const sp1 = document.createElement('span');
      const sp2 = document.createElement('span');
      sp2.className = 'sub';
      sp2.textContent = 'nenhum share na semana ainda';
      li.append(sp1, sp2);
      ol.appendChild(li);
    } else {
      const cMedals = ['🏆', '🥈', '🥉', '4º', '5º'];
      st.slice(0, 5).forEach((w, i) => {
        const li = document.createElement('li');
        const pos = document.createElement('span');
        pos.className = 'pos' + (i === 0 ? ' first' : '');
        pos.textContent = cMedals[i];
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = w.factor != null ? nf(w.factor, w.factor < 10 ? 2 : 0) + '×' : diffTxt(w.best);
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = w.name + ' · ' + diffTxt(w.best) + (w.shares ? ' (' + nf(w.shares) + ' shares)' : '');
        li.append(pos, val, who);
        ol.appendChild(li);
      });
    }
  }
  const lw = ch.lastWeek && ch.lastWeek.winner;
  set('chLast', lw ? 'Campeão da semana passada: 🏆 ' + lw.name + ' (' + (lw.factor != null ? nf(lw.factor, 2) + '× · ' : '') + diffTxt(lw.best) + ')' : '');

  const ach = j.achievements || {}, list = ach.list || [];
  set('achCnt', list.length ? '(' + (ach.unlocked || 0) + '/' + (ach.total || list.length) + ')' : '');
  const grid = $('achGrid');
  if (grid) {
    grid.replaceChildren();
    const isEn = LOC !== 'pt-BR';
    for (const a of list) {
      const box = document.createElement('div');
      box.className = 'ach' + (a.unlocked ? ' on' : '');
      const pair = (isEn ? a.en : a.pt) || a.pt || ['', ''];
      const ico = document.createElement('span');
      ico.className = 'ach-i';
      ico.textContent = a.unlocked ? a.icon : '🔒';
      const txt = document.createElement('div');
      const t = document.createElement('div');
      t.className = 'ach-t';
      t.textContent = pair[0] + (a.unlocked && a.worker ? ' · ' + a.worker : '');
      const d = document.createElement('div');
      d.className = 'ach-d';
      d.textContent = pair[1];
      txt.append(t, d);
      box.append(ico, txt);
      grid.appendChild(box);
    }
  }
}

function renderLuck(j) {
  renderGamification(j);
  const L = j.luck;
  if (!L) { $('lkHist').innerHTML = '<div class="empty">os shares aparecem aqui conforme chegam pelo proxy</div>'; return; }
  const ws = L.workers || [];
  $('lkRows').innerHTML = ws.length ? ws.map((w) => {
    const cls = w.factor >= 2 ? 'lk-hi' : w.factor < 0.5 ? 'lk-lo' : '';
    const pct = Math.round(w.percentile * 100);
    return '<tr><td>' + esc(w.name) + '</td><td>' + diffTxt(w.best) + '</td><td>' + diffTxt(w.expected) +
      '</td><td><span class="' + cls + '">' + nf(w.factor, w.factor < 10 ? 2 : 0) + '×</span>' +
      '<div class="luckbar"><i style="width:' + pct + '%"></i></div><span class="sub lk-p">melhor que ' + pct + '% das fazendas iguais</span></td></tr>';
  }).join('') : '<tr><td colspan="4" class="sub">aguardando shares pelo proxy…</td></tr>';
  histChart(L.hist, L.theory);
}

function histChart(h, th) {
  const el = $('lkHist');
  if (!h || !th) return;
  const total = h.reduce((a, b) => a + b, 0);
  if (!total) { el.innerHTML = '<div class="empty">os shares aparecem aqui conforme chegam pelo proxy</div>'; return; }
  let last = h.length - 1; while (last > 0 && !h[last]) last--;
  const K = Math.max(last + 1, 8);
  const W = el.clientWidth || 500, H = el.clientHeight || 240, Lm = 40, B = 22, T = 8;
  const iw = W - Lm - 8, ih = H - B - T, bw = iw / K;
  const step = Math.ceil(K / Math.max(2, Math.min(6, Math.floor(iw / 60))));   // rótulos do eixo x sem encostar
  const maxLog = Math.log10(Math.max(total * 0.5, h[0], 1)) + 0.2;
  const y = (v) => T + ih - (v >= 1 ? Math.log10(v) / maxLog * ih : 0);
  let s = '<svg width="' + W + '" height="' + H + '">';
  for (let e = 0; e <= Math.floor(maxLog); e++) {
    const yy = y(Math.pow(10, e)).toFixed(1);
    s += '<line x1="' + Lm + '" x2="' + (W - 8) + '" y1="' + yy + '" y2="' + yy + '" style="stroke:var(--line)"/><text x="' + (Lm - 6) + '" y="' + (Number(yy) + 4) + '" text-anchor="end">' + fmtBig(Math.pow(10, e)) + '</text>';
  }
  let path = '';
  for (let k = 0; k < K; k++) {
    const x = Lm + k * bw, c = h[k] || 0, exp = total * th[k];
    if (c > 0) s += '<rect x="' + (x + 2).toFixed(1) + '" y="' + y(c).toFixed(1) + '" width="' + Math.max(1, bw - 4).toFixed(1) + '" height="' + (T + ih - y(c)).toFixed(1) + '" style="fill:var(--gold);fill-opacity:.85"><title>' + nf(c) + '</title></rect>';
    if (exp >= 0.5) path += (path ? ' L' : 'M') + (x + bw / 2).toFixed(1) + ' ' + y(Math.max(exp, 1)).toFixed(1);
    if (k % step === 0) s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmtShort(Math.pow(2, k)) + '×</text>';
  }
  s += '<path d="' + path + '" style="fill:none;stroke:var(--ok);stroke-width:2;stroke-dasharray:5 4"/>';
  el.innerHTML = s + '</svg>';
}

// ------------------------------------------------ bilhete do dia (imagem para compartilhar)
function drawTicket(j) {
  const nb = j.nearBlock || {}, t = nb.tip, b = nb.dayBestHash || nb.bestHash;
  if (!t || !b) return null;
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d'), css = getComputedStyle(document.documentElement);
  const col = (v, d) => (css.getPropertyValue(v) || d).trim() || d;
  const BG = col('--bg', '#0e1117'), CARD = col('--card', '#171c26'), GOLD = col('--gold', '#f2a900'), TXT = col('--txt', '#e6e9ef'), DIM = col('--dim', '#8a93a6'), OK = col('--ok', '#3ecf8e'), WARN = col('--warn', '#e5534b');
  const SANS = '-apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif', MONO = 'ui-monospace, Menlo, "DejaVu Sans Mono", monospace';
  const text = (s, px, y, color, opt) => {
    opt = opt || {};
    x.font = (opt.weight || '400') + ' ' + px + 'px ' + (opt.mono ? MONO : SANS);
    x.fillStyle = color; x.textAlign = opt.align || 'center';
    x.fillText(s, opt.align === 'left' ? 90 : W / 2, y);
  };
  x.fillStyle = BG; x.fillRect(0, 0, W, H);
  // bilhete com recortes nas laterais
  x.fillStyle = CARD; x.beginPath(); x.roundRect(50, 60, W - 100, H - 120, 36); x.fill();
  x.fillStyle = BG; [430, 1010].forEach((cy) => { x.beginPath(); x.arc(50, cy, 34, 0, 7); x.arc(W - 50, cy, 34, 0, 7); x.fill(); });
  x.setLineDash([14, 12]); x.strokeStyle = DIM; x.lineWidth = 3;
  [430, 1010].forEach((cy) => { x.beginPath(); x.moveTo(100, cy); x.lineTo(W - 100, cy); x.stroke(); });
  x.setLineDash([]);

  const day = new Date(b.at || Date.now());
  text('⛏️ BILHETE DE LOTERIA DO BITCOIN', 44, 170, GOLD, { weight: '800' });
  text(day.toLocaleDateString(LOC, { day: '2-digit', month: 'long', year: 'numeric' }), 36, 235, DIM);
  text('Melhor hash do dia · ' + b.worker, 40, 330, TXT, { weight: '600' });
  text('dificuldade ' + diffTxt(b.diff), 34, 385, DIM);

  // o hash em duas linhas, zeros em destaque
  const hz = zeros(b.hash), lines = [b.hash.slice(0, 32), b.hash.slice(32)];
  x.font = '600 46px ' + MONO; x.textAlign = 'left';
  const lw = x.measureText('0'.repeat(32)).width, x0 = (W - lw) / 2, cw = lw / 32;
  lines.forEach((ln, li) => {
    for (let k = 0; k < ln.length; k++) {
      x.fillStyle = li * 32 + k < hz ? GOLD : TXT;
      x.fillText(ln[k], x0 + k * cw, 530 + li * 70);
    }
  });
  const zb = zeros(t.hash);
  text(hz + ' zeros na frente', 40, 700, GOLD, { weight: '700' });
  text('o bloco #' + nf(t.height) + ' tinha ' + zb + ' zeros', 34, 755, DIM);
  text('faltaram ' + (zb - hz) + ' zeros: ' + fmtBig(t.hashDiff / b.diff) + ' de vezes mais difícil', 34, 805, TXT);

  // carimbo
  const won = b.diff >= (t.target || Infinity);
  x.save(); x.translate(W / 2, 905); x.rotate(-0.08);
  x.strokeStyle = won ? OK : WARN; x.lineWidth = 8; x.beginPath(); x.roundRect(-300, -58, 600, 116, 18); x.stroke();
  x.font = '900 64px ' + SANS; x.fillStyle = won ? OK : WARN; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(won ? 'PREMIADO! 🎉' : 'NÃO PREMIADO', 0, 4);
  x.restore();

  text('Mineração solo em casa: a loteria mais lenta do mundo.', 32, 1090, TXT);
  text('Dá para jogar também, é de graça e de código aberto:', 30, 1140, DIM);
  text('github.com/Modanez/HomeMinerProxy', 38, 1210, GOLD, { weight: '700' });
  return c;
}
let ticketBlob = null;
$('ticketBtn').addEventListener('click', (ev) => {
  ev.preventDefault(); ev.stopPropagation();
  const c = lastData && drawTicket(lastData);
  if (!c) return;
  c.toBlob((blob) => {
    ticketBlob = blob;
    $('ticketImg').src = URL.createObjectURL(blob);
    const file = new File([blob], 'bilhete.png', { type: 'image/png' });
    $('ticketShare').style.display = navigator.canShare && navigator.canShare({ files: [file] }) ? '' : 'none';
    $('ticket').classList.add('on');
  }, 'image/png');
});
$('ticketSave').addEventListener('click', () => {
  if (!ticketBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(ticketBlob); a.download = 'bilhete-' + new Date().toISOString().slice(0, 10) + '.png'; a.click();
});
$('ticketShare').addEventListener('click', () => {
  if (!ticketBlob) return;
  const file = new File([ticketBlob], 'bilhete.png', { type: 'image/png' });
  navigator.share({ files: [file], text: 'Meu bilhete de loteria do Bitcoin de hoje ⛏️ github.com/Modanez/HomeMinerProxy' }).catch(() => {});
});
$('ticketClose').addEventListener('click', () => $('ticket').classList.remove('on'));
$('ticket').addEventListener('click', (ev) => { if (ev.target === $('ticket')) $('ticket').classList.remove('on'); });

function renderHistory(j) {
  const now = Date.now();
  const hr = (j.history || []).filter((s) => now - s.t <= 24 * 3600e3).map((s) => ({ t: s.t, v: s.hr }));
  lineChart($('chHr'), hr, {
    empty: 'coletando dados… o gráfico aparece em alguns minutos',
    fmtY: (v) => v === 0 ? '0' : fmtHash(v), fmtX: hora,
    fmtV: (p) => fmtHash(p.v), fmtT: (t) => diaMes(t) + ' ' + hora(t),
  });
  const steps = (j.recordSteps || []).slice();
  if (steps.length) steps.push({ t: now, v: steps[steps.length - 1].v, worker: steps[steps.length - 1].worker });
  lineChart($('chRec'), steps, {
    log: true, step: true,
    empty: 'o gráfico aparece depois do primeiro recorde registrado',
    fmtY: (v) => v >= 1 ? fmtBig(v) : nf(v, 3),
    fmtX: steps.length && now - steps[0].t < 3 * 864e5 ? (t) => diaMes(t) + ' ' + hora(t) : diaMes,
    labelW: steps.length && now - steps[0].t < 3 * 864e5 ? 120 : 70,
    fmtV: (p) => nf(p.v, 2) + (p.worker ? ' · ' + esc(p.worker) : ''), fmtT: (t) => diaMes(t) + ' ' + hora(t),
  });

  const medals = ['1º', '2º', '3º', '4º', '5º'];
  const hall = j.hall || [];
  $('hall').innerHTML = hall.length ? hall.map((r, i) =>
    '<li><span class="pos' + (i === 0 ? ' first' : '') + '">' + medals[i] + '</span><span class="val">' + nf(r.value, 2) +
    '</span><span class="who">' + esc(r.worker) + '<br>' + (r.at ? diaMes(r.at) : '') + '</span></li>').join('')
    : '<li><span></span><span class="sub">nenhum recorde ainda</span></li>';

  const h = j.health || {};
  set('hLabel', (h.worker || 'Máquina') + ' · saúde');
  set('hTemp', h.tempC != null ? tmp(h.tempC) : '–');
  set('hCpu', h.cpuPct != null ? nf(h.cpuPct) + '%' : '–');
  set('hMem', h.mem && h.mem.total ? nf(100 * h.mem.used / h.mem.total) + '%' : '–');
  set('hUp', h.uptimeS ? dur(h.uptimeS * 1000) : '–');

  const e = j.energy || {}, od = odds(j.farm.hashrate, j.farm.difficulty);
  if (e.parts) {
    set('enC', money(e.costMonth) + '/mês');
    const eff = j.farm.hashrate >= 1e9 && e.watts > 0 ? ' · ' + nf(e.watts / (j.farm.hashrate / 1e12), 1) + ' J/TH' : '';
    set('enS', nf(e.watts) + ' W · ' + nf(e.kwhMonth) + ' kWh/mês · ' + money(e.tarifa) + '/kWh' + eff);
    const plugs = Array.isArray(e.plugs) && e.plugs.length ? e.plugs : (e.plug ? [e.plug] : []);
    const box = $('enP');
    box.replaceChildren();
    for (const p of plugs) {
      if (!p || (!p.okAt && !p.offline)) continue;
      const row = document.createElement('div');
      row.className = 'en-prow';
      const txt = document.createElement('span');
      const label = p.name || (p.worker && p.worker !== '*' ? p.worker : 'Tomada');
      const pState = p.on === false ? 'desligada' : 'ligada';
      const pWatts = p.watts != null ? ' · ' + nf(p.watts, 1) + ' W' : '';
      const pVolts = p.volts != null ? ' · ' + nf(p.volts, 0) + ' V' : '';
      txt.textContent = p.offline ? '🔌 ' + label + ': offline na nuvem Tuya' : '🔌 ' + label + ': ' + pState + pWatts + pVolts;
      row.appendChild(txt);
      if (p.deviceId && !kiosk) {
        const btns = document.createElement('span');
        btns.className = 'en-pbtns';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.className = 'en-btn';
        b1.textContent = p.on === false ? 'Ligar' : 'Desligar';
        b1.addEventListener('click', () => askPlugAction(p.deviceId, p.on === false ? 'on' : 'off'));
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.className = 'en-btn';
        b2.textContent = 'Reiniciar';
        b2.addEventListener('click', () => askPlugAction(p.deviceId, 'reboot'));
        btns.append(b1, b2);
        row.appendChild(btns);
      }
      box.appendChild(row);
    }
    set('enJ', od ? 'por uma chance de 1 em ' + fmtBig(od.perYear) + ' por ano 😄' : '');
  }
}

let savedPin = '', pendingPlug = null;
const PLUG_ERR = { selfplug: 'Essa tomada alimenta o próprio servidor: desligue pelo app da tomada', sonoffoffline: 'O Sonoff não respondeu (confira o IP e o modo LAN/DIY)', sonofflan: 'O modo LAN/DIY do Sonoff está desligado', tuyamissing: 'Faltam as credenciais da Tuya em /config', tuyaoffline: 'A tomada está offline na nuvem Tuya (sem Wi-Fi ou sem energia). Confira o app SmartLife', tuyaauth: 'A Tuya recusou o comando' };
function askPlugAction(deviceId, action) {
  pendingPlug = { deviceId, action };
  set('enPinMsg', '');
  if (savedPin) return execPlugAction(savedPin);
  $('enPin').classList.add('on');
  $('enPinInp').focus();
}
async function execPlugAction(pinVal) {
  if (!pendingPlug) return;
  const { deviceId, action } = pendingPlug;
  try {
    const r = await fetch('/api/plug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pinVal, deviceId, action }) }).then((x) => x.json());
    if (!r.ok) {
      savedPin = '';
      $('enPin').classList.add('on');
      set('enPinMsg', r.error === 'wrong' ? 'PIN errado' : (PLUG_ERR[r.error] || r.error || 'erro'));
      if (PLUG_ERR[r.error]) savedPin = pinVal;   // o PIN estava certo; o problema foi a tomada
      return;
    }
    savedPin = pinVal;
    pendingPlug = null;
    $('enPin').classList.remove('on');
    $('enPinInp').value = '';
    set('enPinMsg', '');
    load();
  } catch (_) { set('enPinMsg', 'erro'); }
}
$('enPinOk').addEventListener('click', () => execPlugAction($('enPinInp').value.trim()));
$('enPinCancel').addEventListener('click', () => { pendingPlug = null; $('enPin').classList.remove('on'); set('enPinMsg', ''); });
$('enPinInp').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); execPlugAction($('enPinInp').value.trim()); } });

// ------------------------------------------------ narrador sarcástico
const RAIO_ANO = 1.2e6;   // chance aproximada de uma pessoa ser atingida por um raio em um ano
const MEGA = 50063860;    // Mega-Sena, aposta simples de 6 números
const pick = (a) => a[Math.floor(Math.random() * a.length)];
let narrList = [], narrIdx = -1, narrT = null;

function narrate(j) {
  const f = j.farm || {}, w = j.wallet || {}, n = j.net || {}, h = j.health || {}, e = j.energy || {};
  const out = [];
  const od = odds(f.hashrate, f.difficulty);
  if (od) {
    const raio = od.perYear / RAIO_ANO;
    if (raio > 1) out.push('Ser atingido por um raio este ano é ' + fmtBig(raio) + ' vezes mais provável.');
    const mega = od.perYear / MEGA;
    if (mega > 1) out.push('Uma aposta na Mega-Sena é ' + nf(mega) + ' vezes mais provável que o nosso bloco.');
    out.push('Tempo esperado pro bloco: ' + fmtBig(od.years) + ' de anos. Paciência.');
  }
  if (f.best > 0) out.push('Faltam só ' + fmtBig(f.difficulty / f.best) + ' de vezes. Já já sai.');
  if (e.costMonth > 0) {
    out.push('Luz: ' + money(e.costMonth) + '/mês. Lucro: ' + money(0) + '. Negócio impecável.');
    if (n.prize && w.fiat) {
      const anos = (n.prize.sats / 1e8 * w.fiat) / (e.costMonth * 12);
      out.push('Se o bloco sair, a conta de luz fica paga por ' + fmtBig(anos) + ' anos.');
    }
  }
  for (const wk of (f.workers || []).filter((x) => !x.inactive)) {
    if (wk.state === 'stale') out.push('O ' + wk.name + ' está parado há ' + ago(wk.lastSeen) + '. Pediu demissão?');
    else if (wk.state === 'quiet') out.push('O ' + wk.name + ' está quieto há ' + ago(wk.lastSeen) + '. Deve estar pensando.');
    else if (wk.state === 'unknown') out.push('O ' + wk.name + ' trabalha em silêncio. A pool nem sabe que ele existe.');
    if (wk.name === 'odroid' && wk.state === 'ok') out.push('O Odroid é de 2016 e segue minerando. Respeita o vovô.');
  }
  const hall = j.hall || [];
  if (hall[0] && hall[0].worker !== '—') out.push(hall[0].worker + ' lidera o hall da fama com ' + nf(hall[0].value, 2) + '. Os outros que lutem.');
  if (j.championship && j.championship.leader) out.push('🏆 ' + j.championship.leader.name + ' lidera o campeonato da semana. Quem vai buscar?');
  const tm = j.timeMachine;
  if (tm && !tm.now) out.push('Em ' + mesAno(tm.from * 1000) + ' a gente seria milionário. Erramos de década.');
  if (h.tempC != null) {
    if (h.tempC < 50) out.push((h.worker || 'O servidor') + ' a ' + tmp(h.tempC) + '. O cooler merece um aumento.');
    else if (h.tempC >= 70) out.push((h.worker || 'O servidor') + ' a ' + tmp(h.tempC) + '. Alguém traz um ventilador?');
  }
  const sh = (f.accounting || {}).acceptedSharesLastDay;
  if (sh > 0) out.push('Já foram ' + nf(sh) + ' shares hoje. Nenhum virou bloco. Ainda.');
  if (w.sats != null && w.fiat) {
    const v = w.sats / 1e8 * w.fiat;
    out.push('Saldo: ' + money(v) + (v < 6 ? '. Dá pra um cafezinho? Não.' : '. Dá pra um pão de queijo, no máximo.'));
  }
  if (n.halving) out.push('Faltam ' + nf(n.halving.remaining) + ' blocos pro halving. Aí o prêmio cai pela metade.');
  out.push('Nenhum bloco encontrado hoje. Igual a ontem. E anteontem.');
  out.push('Mineração: o único esporte em que perder é o resultado esperado.');
  return out;
}
function narrNext() {
  if (!narrList.length) return;
  let i;
  do { i = Math.floor(Math.random() * narrList.length); } while (narrList.length > 1 && i === narrIdx);
  narrIdx = i;
  const el = $('narr');
  el.classList.add('fade');
  setTimeout(() => { el.textContent = narrList[narrIdx]; el.classList.remove('fade'); }, 600);
}
function updateNarr(j) {
  narrList = narrate(j);
  if (!narrT) { narrNext(); narrT = setInterval(narrNext, 15000); }
}

// ------------------------------------------------ comemoração de recorde
const JOKES = ['Pode chamar a imprensa.', 'O bloco está logo ali. (Não está.)', 'Isso merece um print pro grupo.',
  'Os bancos estão preocupados.', 'Satoshi ficaria orgulhoso. Talvez.'];
let seenRecT = null, partyT = null, confRaf = null;
let testParty = new URLSearchParams(location.search).has('festa');

function checkRecords(j) {
  const recs = j.recentRecords || [];
  const maxT = recs.reduce((m, r) => Math.max(m, r.t), 0);
  if (seenRecT === null) { seenRecT = maxT; return; }   // primeira carga: não comemora recorde antigo
  const fresh = recs.filter((r) => r.t > seenRecT);
  seenRecT = Math.max(seenRecT, maxT);
  if (!fresh.length) return;
  const byValue = (a, b) => b.value - a.value;
  celebrate(fresh.filter((r) => r.farm).sort(byValue)[0] || fresh.sort(byValue)[0], j);
}
function celebrate(r, j) {
  const D = j.farm.difficulty;
  const who = r.worker && r.worker !== '—' ? r.worker : 'A fazenda';
  let prev = null;
  if (r.farm && !r.test) {
    const before = (j.recordSteps || []).filter((s) => s.t < r.t);
    prev = before.length ? before[before.length - 1].v : null;
  }
  $('party').classList.toggle('small', !r.farm);
  set('pKick', r.test ? 'Teste da comemoração' : (r.farm ? 'Fazenda de mineração' : 'Recorde pessoal'));
  set('pTitle', r.farm ? 'NOVO RECORDE!' : 'Recorde do ' + who + '!');
  set('pVal', nf(r.value, 2));
  set('pSub', (r.farm ? who + ' fez o melhor hash da fazenda' + (prev ? ' (antes: ' + nf(prev, 2) + ')' : '') + '. ' : '') +
    'Faltam só ' + fmtBig(D / r.value) + ' de vezes.');
  set('pJoke', pick(JOKES));
  $('party').classList.add('on');
  confetti(r.farm ? 6000 : 3000);
  clearTimeout(partyT);
  partyT = setTimeout(endParty, r.farm ? 30000 : 12000);
}
function endParty() {
  $('party').classList.remove('on');
  cancelAnimationFrame(confRaf);
}
$('party').addEventListener('click', (ev) => { ev.stopPropagation(); endParty(); });

function confetti(ms) {
  const c = $('confetti'), ctx = c.getContext('2d');
  const W = c.width = window.innerWidth, H = c.height = window.innerHeight;
  const colors = ['#f2a900', '#3ecf8e', '#6aa9ff', '#ffffff', '#e5534b'];
  const ps = Array.from({ length: 110 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.6,
    vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3,
    r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.2,
    s: 5 + Math.random() * 6, c: pick(colors),
  }));
  const end = performance.now() + ms;
  cancelAnimationFrame(confRaf);
  const frame = (now) => {
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y > H + 20 && now < end) { p.y = -20; p.x = Math.random() * W; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (now < end || ps.some((p) => p.y < H + 20)) confRaf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  };
  confRaf = requestAnimationFrame(frame);
}

let bootSeen = null;
async function load() {
  try {
    const r = await fetch('/api/mining');
    const j = await r.json();
    TUNIT = j.tempUnit === 'F' ? 'F' : 'C';
    if (bootSeen && j.boot && j.boot !== bootSeen) return location.reload();   // painel reiniciou (configuração nova)
    bootSeen = j.boot;
    if (j.theme) document.body.dataset.theme = j.theme;
    lastData = j;
    lastOcean = j.ocean;
    if (kiosk && j.rotateS && j.rotateS !== rotS) { rotS = j.rotateS; schedule(); }
    const stale = !j.okAt || Date.now() - j.okAt > (j.staleWarnMs || 600000);
    const px = j.proxy && j.proxy.up;
    set('fo', ((j.proxy && j.proxy.failover) || []).map((f) => '⚠️ ' + f.primary + ' fora do ar desde ' + hora(f.since) +
      (f.active ? ' — mineradores da porta ' + f.listen + ' na reserva ' + f.active : ' — sem reserva no ar na porta ' + f.listen)).join(' · '));
    renderProxyExtras(j.proxy);
    set('err', j.clock && j.clock.waiting ? '🕒 Acertando o relógio pela internet antes de começar (placas sem bateria ligam com a hora errada)…'
      : j.clock && j.clock.suspect ? '🕒 O relógio não acertou pela internet: datas do histórico podem sair erradas. Confira a conexão.'
      : j.error && stale
      ? (px ? 'API da public-pool fora do ar — shares e recordes seguem ao vivo pelo proxy.'
            : 'Pool instável (' + j.error + ') — mostrando dados de ' + (j.okAt ? hora(j.okAt) : '–') + ', tentando de novo…')
      : '');
    renderWallet(j.wallet);
    renderFarm(j);
    renderBitaxes(j);
    renderConsole(j);
    renderNet(j);
    renderHistory(j);
    renderNear(j);
    renderLuck(j);
    fitBig();
    updateNarr(j);
    checkRecords(j);
    if (testParty && j.farm && j.farm.hasData) {
      testParty = false;
      celebrate({ worker: 'teste', value: j.farm.best || 1, farm: true, test: true, t: Date.now() }, j);
    }
    const upAt = Math.max(j.okAt || 0, (j.proxy && j.proxy.okAt) || 0);
    if (upAt) set('upd', 'atualizado ' + new Date(upAt).toLocaleTimeString(LOC));
  } catch (e) {
    set('err', 'Sem conexão com o servidor local.');
  }
}
window.addEventListener('resize', () => { fitPages(); if (lastData) { renderHistory(lastData); renderNear(lastData); renderLuck(lastData); fitBig(); } });
load(); setInterval(load, 20000);
</script>
</body>
</html>`;

// ---------------------------------------------------------------- resumo para widget
// As chaves do JSON ficam em português (o preset do KWGT usa esses nomes); os valores seguem o idioma.
function widgetData(lang) {
  const loc = LOCALES[lang] || LOCALES.en, W = WIDGET[lang] || WIDGET.en;
  const fmtNum = (n, d = 0) => Number(n).toLocaleString(loc, { maximumFractionDigits: d });
  const fmtBigW = (n) => { for (const [v, w] of W.big) if (n >= v) return fmtNum(n / v, 1) + ' ' + w; return fmtNum(n); };
  const fmtHashW = (h) => {
    const u = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s']; let i = 0;
    while (h >= 1000 && i < u.length - 1) { h /= 1000; i++; }
    return fmtNum(h, h < 10 ? 2 : 1) + ' ' + u[i];
  };
  const snap = snapshot();
  const f = snap.farm;
  const holder = snap.hall[0];
  const lastAt = Math.max(snap.okAt || 0, (snap.proxy && snap.proxy.okAt) || 0, ...snap.ckpools.map((p) => p.okAt || 0));
  const secs = f.hashrate > 0 ? f.difficulty * SHARE_HASHES / f.hashrate : 0;
  const perYear = secs ? 1 / (1 - Math.exp(-31557600 / secs)) : 0;
  const px = snap.proxy;
  const pingScore = px && px.pingScore;
  const pingMs = px && px.pingMs;
  const pingLabel = (W.ping && W.ping[pingScore]) || pingScore || '';
  return {
    recorde: fmtNum(f.best, 2),
    recordeNum: f.best,
    recordista: holder ? holder.worker : '',
    faltam: f.best > 0 ? fmtBigW(f.difficulty / f.best) + W.times : '',
    hashrate: fmtHashW(f.hashrate),
    minerando: f.workers.filter((w) => w.state === 'ok' || w.state === 'quiet').length,
    chance: perYear ? W.oneIn + fmtBigW(perYear) : '',
    atualizado: lastAt ? new Date(lastAt).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }) : '',
    ping: pingMs != null ? `${pingMs} ms (${pingLabel})` : '',
    pingMs: pingMs != null ? pingMs : null,
    pingScore: pingScore || 'unknown',
  };
}

// ---------------------------------------------------------------- servidor e coletas
const pageCache = {};   // página já traduzida, por idioma

function requestHandler(req, res) {
  if (settings.handle(req, res, {
    dataDir: process.env.DATA_DIR || __dirname,
    lang: pickLang(req, LANGUAGE),
    workers: () => [...new Set([...Object.keys(known), ...Object.keys(proxy.workers || {}), ...Object.keys(EXPECTED).filter((k) => EXPECTED[k] > 0)])].sort((a, b) => a.localeCompare(b)),
    onSaved: () => { console.log('configuração salva pela tela; reiniciando'); if (require.main === module) process.exit(0); },
    telegramApi: process.env.TELEGRAM_API,
    tuyaApi: process.env.TUYA_API,
    bitaxeAction: (name, action, params) => bitaxeAction(name, action, params, 'config'),
    bitaxeList: () => bitaxesView().map((b) => ({ name: b.name, host: b.host, fresh: b.fresh, paused: !!(b.data && b.data.paused), autoFan: b.data ? b.data.autoFan : null,
      tempTarget: b.data ? b.data.tempTarget : null, fanPct: b.data ? b.data.fanPct : null, lastAction: b.lastAction })),
    pools: () => ({ routes: proxy.routes && proxy.routes.length ? proxy.routes : null, hosts: [os.hostname().split('.')[0] + '.local', ...require('./setup').lanAddresses()], address: ADDRESS || null }),
  })) return;
  if (req.url.startsWith('/api/widget')) {
    // resumo enxuto e já formatado, para widgets (KWGT etc.)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(widgetData(pickLang(req, LANGUAGE))));
  }
  if (req.url.startsWith('/api/alarm')) {
    // teste manual: /api/alarm?e=T (recorde), P, S, 0, 1 ou 2
    const e = (new URL(req.url, 'http://x').searchParams.get('e') || 'T').slice(0, 1);
    const sent = '0123RPST'.includes(e) && alarm(e);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ sent, port: ALARM_PORT, connected: alarmFd !== null, quiet: quietNow() }));
  }
  if (req.url === '/api/plug' && req.method === 'POST') {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(obj));
    };
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(405, { ok: false, error: 'option' });
    let body = '', tooLarge = false;
    req.on('data', (c) => { body += c; if (body.length > 8192) { tooLarge = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooLarge) return;
      let j;
      try { j = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: 'option' }); }
      const pinCheck = settings.checkPin(j.pin, (process.env.SETTINGS_PIN || '').trim());
      if (pinCheck !== 'ok') return json(pinCheck === 'wrong' ? 403 : pinCheck === 'locked' ? 429 : 409, { ok: false, error: pinCheck });
      if (!tuyaClient || !TUYA_PLUGS.length) return json(404, { ok: false, error: 'tuyamissing' });
      const target = j.deviceId ? TUYA_PLUGS.find((p) => p.deviceId === j.deviceId) : TUYA_PLUGS[0];
      if (!target) return json(404, { ok: false, error: 'tuyaid' });
      const act = String(j.action || '');
      let r;
      if (act === 'on' || act === 'off') r = await tuyaClient.setSwitch(act === 'on', target.deviceId);
      else if (act === 'reboot') r = await tuyaClient.powerCycle(8000, target.deviceId);
      else if (act === 'info') return json(200, await tuyaClient.inspect(target.deviceId));   // diagnóstico: só leitura
      else return json(400, { ok: false, error: 'option' });
      if (r && r.ok) {
        const st = tuyaPlugsState.get(target.deviceId);
        if (st && st.status) st.status.on = act === 'reboot' ? true : act === 'on';
      }
      return json(r && r.ok ? 200 : 502, r || { ok: false, error: 'tuyaauth' });
    });
    return;
  }
  if (req.url === '/api/mining') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }
  const lang = pickLang(req, LANGUAGE);
  const html = pageCache[lang] || (pageCache[lang] = localizePage(PAGE, lang, CURRENCY, THEME));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Language': LOCALES[lang] });
  res.end(html);
}

let clockState = { waiting: false, suspect: false };
function start(port = PORT, host = '0.0.0.0') {
  const server = http.createServer(requestHandler);
  const timers = [];
  let stopped = false;
  function everyTimer(fn, ms) {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch (_) { /* a próxima rodada tenta de novo */ } finally { busy = false; }
    };
    run();
    timers.push(setInterval(run, ms));
  }
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, async () => {
      console.log(`Painel de mineração em http://${host}:${port}`);
      // placas sem bateria ligam com a hora errada: espera o relógio antes de coletar e gravar histórico
      const clk = await require('./clock').waitOk({
        appDir: __dirname, dataDir: process.env.DATA_DIR || __dirname,
        onWait: (fl) => { clockState = { waiting: true, suspect: false }; console.log(`relógio atrasado (${new Date().toISOString()}, esperado depois de ${new Date(fl).toISOString()}); aguardando o NTP`); },
      });
      clockState = { waiting: false, suspect: !clk.ok };
      if (clk.waitedMs) console.log(clk.ok ? 'relógio certo; começando' : 'o relógio não acertou (sem internet?); seguindo assim mesmo');
      if (stopped) return;
      everyTimer(tickPool, POOL_MS);
      everyTimer(tickWallet, WALLET_MS);
      everyTimer(tickNetwork, NET_MS);
      everyTimer(tickDiffHist, 3600e3);
      everyTimer(tickLocal, 60e3);
      everyTimer(tickCkpools, 120e3);
      everyTimer(tickOcean, 300e3);
      everyTimer(tickProxy, PROXY_MS);
      if (tuyaClient) everyTimer(tickTuya, 30e3);
      if (BITAXES.length) everyTimer(tickBitaxe, BITAXE_MS);
      everyTimer(async () => { alarmOpen(); alarmStatus(); }, 60e3);
      // minerador local opcional (imagens prontas): liga/desliga o serviço conforme a opção LOCAL_MINER
      require('./localminer').sync({
        enabled: process.env.LOCAL_MINER === '1', address: ADDRESS, worker: process.env.LOCAL_WORKER,
        threads: process.env.MINER_THREADS, appDir: process.env.DATA_DIR || __dirname,
      }).then((w) => { if (w) LOCAL_WORKER = w; }).catch(() => {});
      const tgBot = startTelegram();
      const mqttClient = startMqtt();
      resolve({
        server,
        timers,
        stop() {
          stopped = true;
          timers.forEach((t) => clearInterval(t));
          if (tgBot && tgBot.stop) tgBot.stop();
          if (mqttClient && mqttClient.stop) mqttClient.stop();
          return new Promise((res) => server.close(res));
        }
      });
    });
  });
}

// ---------------------------------------------------------------- bot do Telegram (opcional)
function startTelegram() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return;
  const hour = (process.env.TELEGRAM_DAILY ?? '21').trim();
  return require('./telegram').start({
    token,
    bitaxeAction: BITAXES.length ? (name, action, params, via) => bitaxeAction(name, action, params, via) : null,
    tempUnit: TEMP_UNIT,
    chatIds: (process.env.TELEGRAM_CHAT_ID || '').split(',').map((v) => v.trim()).filter(Boolean),
    lang: LANGUAGE || 'en',
    snapshot: () => snapshot(true),
    tuya: tuyaClient,
    plugs: TUYA_PLUGS,
    quiet: quietNow,
    ignore: ALARM_IGNORE,
    personal: process.env.TELEGRAM_PERSONAL === '1',
    dailyHour: /^\d{1,2}$/.test(hour) && Number(hour) < 24 ? Number(hour) : null,
    panelUrl: (process.env.TELEGRAM_PANEL_URL || '').trim() || null,
    stateFile: file('telegram.json'),
    api: process.env.TELEGRAM_API,
    backupWeekly: process.env.TELEGRAM_BACKUP === '1',
    backup: () => ({ name: `homeminer-backup-${new Date().toLocaleDateString('sv')}.json`, json: JSON.stringify(settings.exportBackup(process.env.DATA_DIR || __dirname), null, 2) }),
  });
}

// ---------------------------------------------------------------- Home Assistant / MQTT (opcional)
function startMqtt() {
  const url = (process.env.MQTT_URL || '').trim();
  if (!url) return;
  return require('./mqtt').start({
    url,
    user: (process.env.MQTT_USER || '').trim(),
    pass: process.env.MQTT_PASS || '',
    topic: (process.env.MQTT_TOPIC || '').trim() || 'homeminerproxy',
    lang: LANGUAGE || 'en',
    currency: CURRENCY,
    snapshot: () => snapshot(true),
    ignore: ALARM_IGNORE,
    personal: process.env.TELEGRAM_PERSONAL === '1',
    bitaxes: BITAXES.map((b) => b.name),
    tempUnit: TEMP_UNIT,
  });
}

if (require.main === module) {
  start();
}

function _setTuyaForTest(client, plugs, stateMap) {
  tuyaClient = client;
  if (plugs) TUYA_PLUGS = plugs;
  if (stateMap) tuyaPlugsState = stateMap;
}

module.exports = {
  requestHandler,
  start,
  snapshot,
  widgetData,
  workersView,
  farmHashrate,
  topRecord,
  addRecord,
  rememberWorkers,
  hashDiff,
  timeMachine,
  normDiff,
  parseHashrate,
  safeJson,
  loadJson,
  saveJson,
  energy,
  quietNow,
  alarm,
  alarmOpen,
  alarmStatus,
  health,
  readTempC,
  readCpuPct,
  readMem,
  sampleHistory,
  tickPool,
  tickWallet,
  tickNetwork,
  tickDiffHist,
  tickLocal,
  tickCkpools,
  tickOcean,
  tickProxy,
  tickTuya,
  getJson,
  getJsonRetry,
  initTuya,
  CKPOOL_URLS,
  parseMinerdLog,
  startTelegram,
  startMqtt,
  _setLocalForTest: (l) => { local = l; },
  _setLocalWorkerForTest: (w) => { LOCAL_WORKER = w; },
  _resetAlarmTryForTest: () => { alarmTry = 0; alarmFd = null; },
  _setTuyaForTest,
  _state: () => ({
    pool,
    wallet,
    net,
    diffHist,
    proxy,
    ocean,
    ckpools,
    known,
    records,
    history,
    achievements,
    tuyaPlugsState,
    tuyaClient,
    TUYA_PLUGS,
  }),
};
