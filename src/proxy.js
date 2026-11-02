// Proxy Stratum V1 da fazenda de mineração — sem dependências.
// Cada minerador se conecta no Odroid; o proxy abre uma conexão 1:1 com a pool e repassa tudo sem alterar.
// No caminho, calcula a dificuldade de cada share enviado e guarda estatísticas por worker.
//
// Uso: node proxy.js        (estatísticas em http://127.0.0.1:3336/stats)
// A pool é escolhida pela porta em que o minerador se conecta (ROUTES abaixo).

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROUTES = safeJson(process.env.PROXY_ROUTES) || [
  { listen: 3333, host: 'public-pool.io', port: 21496, label: 'public-pool' },
  { listen: 3334, host: 'solo.ckpool.org', port: 3333, label: 'ckpool solo' },
  { listen: 3335, host: 'pool.nerdminers.org', port: 3333, label: 'nerdminers' },
  { listen: 3337, host: 'mine.ocean.xyz', port: 3334, label: 'OCEAN' },
  { listen: 3338, host: 'solo.atlaspool.io', port: 3333, label: 'atlaspool' },        // dificuldade mínima 2.000: ASICs (Bitaxe), não ESP32
  { listen: 3339, host: 'eusolo.ckpool.org', port: 3333, label: 'ckpool solo EU' },
];
const STATS_PORT = Number(process.env.PROXY_STATS_PORT || 3336);
const STATS_FILE = process.env.PROXY_STATS_FILE || path.join(process.env.DATA_DIR || __dirname, 'proxy-stats.json');
const HASHRATE_WINDOW_MS = 60 * 60e3;   // hashrate estimado pelos shares da última hora
const RECENT_MAX = 100;                 // últimos shares guardados para o painel


function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- estatísticas
// workers[nome] = { name, pool, accepted, rejected, lastShareAt, lastShareDiff, bestEver, bestSession,
//                   connectedSince, online, window: [[ts, dificuldadeAlvo], ...] }
let workers = {};
let recent = [];
let today = { date: dayKey(), accepted: 0 };   // shares aceitos hoje, somando todas as pools
let bestHash = null;                            // melhor hash que já passou pelo proxy: { worker, diff, hash, at }
let dayBestHash = null;                         // o mesmo, só de hoje (com a data)
function noteBestHash(worker, p) {
  if (!p.hash) return;
  const e = { worker, diff: p.diff, hash: p.hash, at: p.at };
  if (!bestHash || p.diff > bestHash.diff) bestHash = e;
  if (!dayBestHash || dayBestHash.date !== dayKey() || p.diff > dayBestHash.diff) dayBestHash = { ...e, date: dayKey() };
}
function dayKey() { return new Date().toLocaleDateString('sv'); }
try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  workers = saved.workers || {};
  recent = Array.isArray(saved.recent) ? saved.recent : [];
  if (saved.today && saved.today.date === dayKey()) today = saved.today;
  bestHash = saved.bestHash || null;
  dayBestHash = saved.dayBestHash || null;
  for (const w of Object.values(workers)) { w.online = 0; w.window = []; w.bestSession = 0; }
} catch (_) { /* primeiro uso */ }

function worker(name, pool) {
  const w = workers[name] || (workers[name] = {
    name, pool, accepted: 0, rejected: 0, lastShareAt: null, lastShareDiff: null,
    bestEver: 0, bestSession: 0, connectedSince: null, online: 0, window: [], lastReject: null,
  });
  w.pool = pool;
  return w;
}

function saveStats() {
  const out = {};
  for (const [k, w] of Object.entries(workers)) { const { window, ...rest } = w; out[k] = rest; }
  try { fs.writeFileSync(STATS_FILE, JSON.stringify({ savedAt: Date.now(), workers: out, recent, today, bestHash, dayBestHash })); } catch (_) { /* segue */ }
}
setInterval(saveStats, 60e3).unref();

function hashrate(w) {
  const now = Date.now();
  w.window = w.window.filter(([t]) => now - t <= HASHRATE_WINDOW_MS);
  if (!w.window.length) return 0;
  const work = w.window.reduce((s, [, d]) => s + d, 0) * 4294967296;
  const span = Math.max(now - Math.min(w.connectedSince || now, w.window[0][0]), 60e3);
  return work / (Math.min(span, HASHRATE_WINDOW_MS) / 1000);
}

const { shareDifficulty } = require('./stratum');

// ---------------------------------------------------------------- sessão minerador <-> pool
function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > 1e6) buf = '';   // proteção contra lixo
  };
}

function session(down, route) {
  const s = { en1: null, shareDiff: 1, versionMask: null, jobs: new Map(), pending: new Map(),
    subscribeIds: new Set(), configureIds: new Set(), worker: null, peer: down.remoteAddress };
  const up = net.connect(route.port, route.host);
  up.setKeepAlive(true, 30e3);
  down.setKeepAlive(true, 30e3);
  const queue = [];
  let upReady = false;
  up.on('connect', () => { upReady = true; for (const l of queue) up.write(l); queue.length = 0; });

  const toUp = (line) => (upReady ? up.write(line + '\n') : queue.push(line + '\n'));

  // minerador -> pool
  down.on('data', lineReader((line) => {
    let m; try { m = JSON.parse(line); } catch (_) { toUp(line); return; }
    try {
      if (m.method === 'mining.subscribe') s.subscribeIds.add(m.id);
      else if (m.method === 'mining.configure') s.configureIds.add(m.id);
      else if (m.method === 'mining.authorize' && m.params) {
        const user = String(m.params[0] || '');
        const name = user.includes('.') ? user.slice(user.indexOf('.') + 1) : '(sem nome)';
        s.worker = worker(name, route.label);
        s.worker.online++;
        s.worker.connectedSince = Date.now();
        s.worker.bestSession = 0;
        log(`[${route.label}] ${name} conectou de ${s.peer}`);
      } else if (m.method === 'mining.submit' && m.params) {
        const job = s.jobs.get(m.params[1]);
        const r = job && s.en1 ? shareDifficulty(job, s.en1, m.params, s.versionMask) : null;
        s.pending.set(m.id, { diff: r ? r.diff : null, hash: r ? r.hash : null, target: s.shareDiff, at: Date.now() });
      }
    } catch (e) { log('erro ao ler mensagem do minerador:', e.message); }
    toUp(line);
  }));

  // pool -> minerador
  up.on('data', lineReader((line) => {
    let m; try { m = JSON.parse(line); } catch (_) { down.write(line + '\n'); return; }
    try {
      if (m.method === 'mining.notify' && m.params) {
        const [jobId, prevhash, coinb1, coinb2, branches, version, nbits, , clean] = m.params;
        if (clean) s.jobs.clear();
        s.jobs.set(jobId, { prevhash, coinb1, coinb2, branches: branches || [], version, nbits });
        if (s.jobs.size > 32) s.jobs.delete(s.jobs.keys().next().value);
      } else if (m.method === 'mining.set_difficulty' && m.params) {
        s.shareDiff = Number(m.params[0]) || s.shareDiff;
      } else if (m.method === 'mining.set_extranonce' && m.params) {
        s.en1 = m.params[0];
      } else if (m.id !== undefined && m.id !== null) {
        if (s.subscribeIds.has(m.id) && Array.isArray(m.result)) {
          s.en1 = m.result[1];
          s.subscribeIds.delete(m.id);
        } else if (s.configureIds.has(m.id) && m.result) {
          if (m.result['version-rolling']) s.versionMask = m.result['version-rolling.mask'] || null;
          s.configureIds.delete(m.id);
        } else if (s.pending.has(m.id)) {
          const p = s.pending.get(m.id); s.pending.delete(m.id);
          const w = s.worker; if (!w) return;
          const ok = m.result === true;
          const entry = { at: p.at, worker: w.name, pool: route.label, diff: p.diff, target: p.target, ok };
          if (ok) {
            w.accepted++;
            if (today.date !== dayKey()) today = { date: dayKey(), accepted: 0 };
            today.accepted++;
            w.lastShareAt = p.at;
            w.lastShareDiff = p.diff;
            w.window.push([p.at, p.target]);
            if (p.diff > w.bestSession) w.bestSession = p.diff;
            if (p.diff > w.bestEver) w.bestEver = p.diff;
            if (p.hash && (!w.bestHash || p.diff > w.bestHash.diff)) w.bestHash = { diff: p.diff, hash: p.hash, at: p.at };
            noteBestHash(w.name, p);
          } else {
            w.rejected++;
            entry.error = Array.isArray(m.error) ? m.error[1] : (m.error && m.error.message) || String(m.error || 'recusado');
            w.lastReject = { at: p.at, error: entry.error };
          }
          recent.unshift(entry);
          if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
        }
      }
    } catch (e) { log('erro ao ler mensagem da pool:', e.message); }
    down.write(line + '\n');
  }));

  const close = (why) => {
    if (s.closed) return; s.closed = true;
    if (s.worker) { s.worker.online = Math.max(0, s.worker.online - 1); log(`[${route.label}] ${s.worker.name} desconectou (${why})`); }
    down.destroy(); up.destroy();
  };
  down.on('close', () => close('minerador fechou'));
  up.on('close', () => close('pool fechou'));
  down.on('error', (e) => close('minerador: ' + e.code));
  up.on('error', (e) => close('pool: ' + e.code));
}

for (const r of ROUTES) {
  net.createServer((sock) => session(sock, r))
    .on('error', (e) => log(`porta ${r.listen}:`, e.message))
    .listen(r.listen, '0.0.0.0', () => log(`porta ${r.listen} -> ${r.host}:${r.port} (${r.label})`));
}

// ---------------------------------------------------------------- estatísticas via HTTP (só local)
http.createServer((req, res) => {
  if (!req.url.startsWith('/stats')) { res.writeHead(404); return res.end(); }
  const list = Object.values(workers).map((w) => {
    const { window, ...rest } = w;
    const hr = hashrate(w);   // poda a janela antes de contar
    return { ...rest, hashrate: hr, shares1h: w.window.length };
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (today.date !== dayKey()) today = { date: dayKey(), accepted: 0 };
  const lastHour = Object.values(workers).reduce((n, w) => n + w.window.length, 0);   // hashrate() já podou a janela de 1 h
  const dayBest = dayBestHash && dayBestHash.date === dayKey() ? dayBestHash : null;
  res.end(JSON.stringify({ at: Date.now(), routes: ROUTES, workers: list, recent, totals: { today: today.accepted, lastHour }, bestHash, dayBestHash: dayBest }));
}).listen(STATS_PORT, process.env.PROXY_STATS_HOST || '127.0.0.1', () => log(`estatísticas em http://127.0.0.1:${STATS_PORT}/stats`));

process.on('SIGTERM', () => { saveStats(); process.exit(0); });
process.on('SIGINT', () => { saveStats(); process.exit(0); });
