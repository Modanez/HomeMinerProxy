// Proxy Stratum V1 da fazenda de mineração — sem dependências.
// Cada minerador se conecta no Odroid; o proxy abre uma conexão 1:1 com a pool e repassa tudo sem alterar.
// No caminho, calcula a dificuldade de cada share enviado e guarda estatísticas por worker.
//
// Uso: node proxy.js        (estatísticas em http://127.0.0.1:3336/stats)
// A pool é escolhida pela porta em que o minerador se conecta (ROUTES abaixo).
// Failover: se a pool principal de uma porta não responder, o minerador vai para a primeira reserva
// (backup) que estiver no ar; quando a principal volta, as sessões na reserva são encerradas e os
// mineradores reconectam na principal.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CKPOOL = { host: 'solo.ckpool.org', port: 3333, label: 'ckpool solo' };
const ROUTES = safeJson(process.env.PROXY_ROUTES) || [
  { listen: 3333, host: 'public-pool.io', port: 21496, label: 'public-pool', backup: [CKPOOL] },
  { listen: 3334, ...CKPOOL, backup: [{ host: 'eusolo.ckpool.org', port: 3333, label: 'ckpool solo EU' }] },
  // reserva dos ESP32: a public-pool recusa os shares abaixo de 1, mas aceita os maiores (e um bloco)
  { listen: 3335, host: 'pool.nerdminers.org', port: 3333, label: 'nerdminers', backup: [{ host: 'public-pool.io', port: 21496, label: 'public-pool' }] },
  { listen: 3337, host: 'mine.ocean.xyz', port: 3334, label: 'OCEAN' },                // sem reserva: o pagamento da OCEAN é outro modelo
  { listen: 3338, host: 'solo.atlaspool.io', port: 3333, label: 'atlaspool', backup: [CKPOOL] },   // dificuldade mínima 2.000: ASICs, não ESP32
  { listen: 3339, host: 'eusolo.ckpool.org', port: 3333, label: 'ckpool solo EU', backup: [CKPOOL] },
];
const CONNECT_TIMEOUT_MS = Number(process.env.PROXY_CONNECT_TIMEOUT_MS || 8000);
const HEALTH_MS = Number(process.env.PROXY_HEALTH_MS || 60e3);      // de quanto em quanto tempo testa as pools fora do ar
const FAILBACK = process.env.PROXY_FAILBACK !== '0';                 // voltar para a principal quando ela se recuperar
const STATS_PORT = Number(process.env.PROXY_STATS_PORT || 3336);
const STATS_FILE = process.env.PROXY_STATS_FILE || path.join(process.env.DATA_DIR || __dirname, 'proxy-stats.json');
const HASHRATE_WINDOW_MS = 60 * 60e3;   // hashrate estimado pelos shares da última hora
const RECENT_MAX = 100;                 // últimos shares guardados para o painel


function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Linha do tempo de eventos (conexões, falhas de pool, rejeições): só em memória, os mais novos primeiro
const EVENTS_MAX = 100;
const events = [];
function addEvent(type, msg, extra) {
  events.unshift({ at: Date.now(), type, msg, ...extra });
  if (events.length > EVENTS_MAX) events.length = EVENTS_MAX;
}
const cleanIp = (a) => (a ? String(a).replace(/^::ffff:/, '') : null);

// ---------------------------------------------------------------- estatísticas
// workers[nome] = { name, pool, accepted, rejected, lastShareAt, lastShareDiff, bestEver, bestSession,
//                   connectedSince, online, window: [[ts, dificuldadeAlvo], ...] }
const { weekKey } = require('./luck');
let workers = {};
let recent = [];
let today = { date: dayKey(), accepted: 0 };   // shares aceitos hoje, somando todas as pools
let week = { key: weekKey(), workers: {} };     // campeonato semanal: { shares, work, best, bestAt } por worker
let lastWeek = null;                            // semana anterior fechada (para exibir o campeão da semana passada)
let bestHash = null;                            // melhor hash que já passou pelo proxy: { worker, diff, hash, at }
// Histograma da sorte: shares aceitos por faixa k = floor(log2(dificuldade atingida / alvo)).
// A matemática prevê metade dos shares na faixa 0, um quarto na 1, um oitavo na 2…
const HIST_BUCKETS = 40;
let hist = new Array(HIST_BUCKETS).fill(0);
function bucket(diff, target) {
  if (!(diff > 0) || !(target > 0)) return -1;
  return Math.max(0, Math.min(HIST_BUCKETS - 1, Math.floor(Math.log2(diff / target))));
}
let dayBestHash = null;                         // o mesmo, só de hoje (com a data)
function noteBestHash(worker, p) {
  if (!p.hash) return;
  const e = { worker, diff: p.diff, hash: p.hash, at: p.at };
  if (!bestHash || p.diff > bestHash.diff) bestHash = e;
  if (!dayBestHash || dayBestHash.date !== dayKey() || p.diff > dayBestHash.diff) dayBestHash = { ...e, date: dayKey() };
}
function dayKey() { return new Date().toLocaleDateString('sv'); }
function rollWeek() {
  const k = weekKey();
  if (week.key !== k) {
    if (week.workers && Object.keys(week.workers).length) lastWeek = week;
    week = { key: k, workers: {} };
  }
}
try {
  // com .bak: se a energia caiu no meio da última gravação, vale a anterior (store.js)
  const saved = require('./store').readJson(STATS_FILE, null);
  if (!saved) throw new Error('sem estatísticas salvas');
  workers = saved.workers || {};
  recent = Array.isArray(saved.recent) ? saved.recent : [];
  if (Array.isArray(saved.events)) events.push(...saved.events.slice(0, EVENTS_MAX));
  if (saved.today && saved.today.date === dayKey()) today = saved.today;
  if (saved.lastWeek && saved.lastWeek.workers) lastWeek = saved.lastWeek;
  if (saved.week && saved.week.workers) { week = saved.week; rollWeek(); }
  bestHash = saved.bestHash || null;
  dayBestHash = saved.dayBestHash || null;
  if (Array.isArray(saved.hist) && saved.hist.length === HIST_BUCKETS) hist = saved.hist;
  for (const w of Object.values(workers)) { w.online = 0; w.window = []; w.bestSession = 0; }
} catch (_) { /* primeiro uso */ }

function worker(name, pool) {
  const w = workers[name] || (workers[name] = {
    name, pool, accepted: 0, rejected: 0, lastShareAt: null, lastShareDiff: null,
    bestEver: 0, bestSession: 0, connectedSince: null, online: 0, window: [], lastReject: null,
    pingMs: null, pingScore: 'unknown',
  });
  w.pool = pool;
  if (w.pingMs === undefined) w.pingMs = null;
  if (w.pingScore === undefined) w.pingScore = 'unknown';
  return w;
}

function saveStats() {
  const out = {};
  for (const [k, w] of Object.entries(workers)) { const { window, ...rest } = w; out[k] = rest; }
  try { require('./store').writeJson(STATS_FILE, { savedAt: Date.now(), workers: out, recent, events, today, week, lastWeek, bestHash, dayBestHash, hist }); } catch (_) { /* segue */ }
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

// Médias de hashrate: 15 min e 1 h saem da janela de shares; 24 h sai de baldes de 5 min (guardados no arquivo)
const BIN_MS = 5 * 60e3, DAY_MS = 24 * 3600e3;
function addBin(w, at, target) {
  const t = Math.floor(at / BIN_MS) * BIN_MS;
  const bins = w.bins || (w.bins = []);
  const last = bins[bins.length - 1];
  if (last && last[0] === t) last[1] += target; else bins.push([t, target]);
  const cut = Date.now() - DAY_MS;
  while (bins.length && bins[0][0] < cut) bins.shift();
}
function hashrateOver(w, ms) {
  const now = Date.now();
  if (ms >= DAY_MS) {
    const bins = (w.bins || []).filter(([t]) => now - t <= ms);
    if (!bins.length) return 0;
    const work = bins.reduce((n, [, d]) => n + d, 0) * 4294967296;
    return work / (Math.min(Math.max(now - bins[0][0], BIN_MS), ms) / 1000);
  }
  const win = (w.window || []).filter(([t]) => now - t <= ms);
  if (!win.length) return 0;
  const work = win.reduce((n, [, d]) => n + d, 0) * 4294967296;
  const span = Math.max(now - Math.min(w.connectedSince || now, win[0][0]), 60e3);
  return work / (Math.min(span, ms) / 1000);
}
// Motivo da rejeição: 21 job não encontrado/stale, 22 duplicado, resto (23 dificuldade baixa, 24 não autorizado...) = inválido
function rejectKind(err) {
  const code = Array.isArray(err) ? Number(err[0]) : err && Number(err.code);
  const text = Array.isArray(err) ? String(err[1] || '') : String((err && err.message) || err || '');
  if (code === 21 || /stale|job not found/i.test(text)) return 'stale';
  if (code === 22 || /duplicate/i.test(text)) return 'duplicate';
  return 'invalid';
}

const { shareDifficulty, pingScore } = require('./stratum');

// ---------------------------------------------------------------- saúde das pools (failover)
const upstreamsOf = (route) => [{ host: route.host, port: route.port, label: route.label }, ...(route.backup || [])];
const health = {};   // "host:porta" -> { down, since, error, pingMs }
const hkey = (u) => `${u.host}:${u.port}`;
const isDown = (u) => !!(health[hkey(u)] && health[hkey(u)].down);
function markDown(u, error) {
  const h = health[hkey(u)];
  if (h && h.down) { h.error = error; return; }
  health[hkey(u)] = { down: true, since: Date.now(), error, pingMs: (h && h.pingMs) ?? null };
  log(`pool ${u.label} (${hkey(u)}) fora do ar: ${error}`);
  addEvent('pool_down', `${u.label} is down: ${error}`);
}
function markUp(u, pingMs = null) {
  const h = health[hkey(u)];
  const ms = typeof pingMs === 'number' && pingMs >= 0 ? Math.round(pingMs) : (h && h.pingMs != null ? h.pingMs : null);
  if (!h || !h.down) {
    if (h) h.pingMs = ms;
    else health[hkey(u)] = { down: false, since: Date.now(), error: null, pingMs: ms };
    return;
  }
  health[hkey(u)] = { down: false, since: Date.now(), error: null, pingMs: ms };
  log(`pool ${u.label} (${hkey(u)}) voltou`);
  addEvent('pool_up', `${u.label} is back`);
}
const sessions = new Set();   // sessões ativas (para devolver à principal quando ela voltar)

function probe(u) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = net.connect(u.port, u.host);
    const done = (ok) => {
      const ms = Date.now() - t0;
      c.destroy();
      if (ok) markUp(u, ms);
      resolve(ok);
    };
    c.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    c.on('connect', () => done(true));
    c.on('error', () => done(false));
  });
}
async function healthCheck() {
  for (const route of ROUTES) {
    for (const u of upstreamsOf(route)) if (isDown(u) && await probe(u)) markUp(u);
    const primary = upstreamsOf(route)[0];
    if (!FAILBACK || isDown(primary)) continue;
    for (const s of sessions) {
      if (s.route === route && s.upIndex > 0 && !s.closed) s.close('pool principal voltou, reconectando nela');
    }
  }
}
setInterval(() => { healthCheck().catch(() => {}); }, HEALTH_MS).unref();

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
    subscribeIds: new Set(), configureIds: new Set(), worker: null, peer: down.remoteAddress, route, upIndex: 0 };
  const ups = upstreamsOf(route);
  down.setKeepAlive(true, 30e3);
  const queue = [];   // tudo que o minerador mandou antes de a pool aceitar a conexão
  let up = null, upReady = false;
  const label = () => ups[s.upIndex].label;

  // Tenta a primeira pool que não está marcada como fora; se a conexão falhar antes de abrir,
  // marca essa pool como fora e passa para a próxima, reenviando o que o minerador já mandou.
  function connectUp(start) {
    let i = start;
    while (i < ups.length && isDown(ups[i]) && i < ups.length - 1) i++;
    if (i >= ups.length) return close('nenhuma pool respondeu');
    s.upIndex = i;
    const u = ups[i];
    const connectStart = Date.now();
    const c = net.connect(u.port, u.host);
    up = c;
    c.setTimeout(CONNECT_TIMEOUT_MS, () => { if (!upReady) c.destroy(new Error('tempo esgotado')); });
    c.on('connect', () => {
      const tcpPing = Date.now() - connectStart;
      c.setTimeout(0);
      c.setKeepAlive(true, 30e3);
      upReady = true;
      s.upstream = u;   // pool em uso nesta sessão (para o ping separado por pool)
      markUp(u, tcpPing);
      s.pingMs = tcpPing;
      if (i > 0) { log(`[${route.label}] usando a reserva ${u.label}`); addEvent('failover', `port ${route.listen}: using backup ${u.label}`); }
      if (s.worker) {
        s.worker.pool = u.label;
        s.worker.pingMs = tcpPing;
        s.worker.pingScore = pingScore(tcpPing).score;
      }
      for (const l of queue) c.write(l);
      queue.length = 0;
    });
    c.on('data', fromUp);
    c.on('error', (e) => {
      if (upReady || s.closed) return close('pool: ' + (e.code || e.message));
      markDown(u, e.code || e.message);
      c.removeAllListeners('close');
      if (i + 1 < ups.length) connectUp(i + 1); else close('nenhuma pool respondeu');
    });
    c.on('close', () => { if (upReady) close('pool fechou'); });
  }

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
        s.worker = worker(name, label());
        s.worker.online++;
        s.worker.connectedSince = Date.now();
        s.worker.bestSession = 0;
        s.worker.ip = cleanIp(s.peer);
        s.worker.listen = route.listen;
        s.worker.shareDiff = s.shareDiff;
        s.worker.extranonce1 = s.en1;
        log(`[${route.label}] ${name} conectou de ${s.peer}`);
        addEvent('worker_up', `${name} connected (${cleanIp(s.peer)})`, { worker: name });
      } else if (m.method === 'mining.submit' && m.params) {
        const job = s.jobs.get(m.params[1]);
        const r = job && s.en1 ? shareDifficulty(job, s.en1, m.params, s.versionMask) : null;
        s.pending.set(m.id, { diff: r ? r.diff : null, hash: r ? r.hash : null, target: s.shareDiff, at: Date.now() });
      }
    } catch (e) { log('erro ao ler mensagem do minerador:', e.message); }
    toUp(line);
  }));

  // pool -> minerador
  const fromUp = lineReader((line) => {
    let m; try { m = JSON.parse(line); } catch (_) { down.write(line + '\n'); return; }
    try {
      if (m.method === 'mining.notify' && m.params) {
        const [jobId, prevhash, coinb1, coinb2, branches, version, nbits, , clean] = m.params;
        if (clean) s.jobs.clear();
        s.jobs.set(jobId, { prevhash, coinb1, coinb2, branches: branches || [], version, nbits });
        if (s.jobs.size > 32) s.jobs.delete(s.jobs.keys().next().value);
      } else if (m.method === 'mining.set_difficulty' && m.params) {
        s.shareDiff = Number(m.params[0]) || s.shareDiff;
        if (s.worker) s.worker.shareDiff = s.shareDiff;
      } else if (m.method === 'mining.set_extranonce' && m.params) {
        s.en1 = m.params[0];
        if (s.worker) s.worker.extranonce1 = s.en1;
      } else if (m.id !== undefined && m.id !== null) {
        if (s.subscribeIds.has(m.id) && Array.isArray(m.result)) {
          s.en1 = m.result[1];
          if (s.worker) s.worker.extranonce1 = s.en1;
          s.subscribeIds.delete(m.id);
        } else if (s.configureIds.has(m.id) && m.result) {
          if (m.result['version-rolling']) s.versionMask = m.result['version-rolling.mask'] || null;
          s.configureIds.delete(m.id);
        } else if (s.pending.has(m.id)) {
          const p = s.pending.get(m.id); s.pending.delete(m.id);
          const rtt = Math.round(Date.now() - p.at);
          s.pingMs = rtt;
          markUp(ups[s.upIndex], rtt);
          const w = s.worker; if (!w) return;
          w.pingMs = rtt;
          w.pingScore = pingScore(rtt).score;
          const ok = m.result === true;
          const entry = { at: p.at, worker: w.name, pool: label(), diff: p.diff, target: p.target, ok };
          if (ok) {
            w.accepted++;
            if (today.date !== dayKey()) today = { date: dayKey(), accepted: 0 };
            today.accepted++;
            w.lastShareAt = p.at;
            w.lastShareDiff = p.diff;
            w.window.push([p.at, p.target]);
            addBin(w, p.at, p.target);
            if (p.diff > w.bestSession) w.bestSession = p.diff;
            if (p.diff > w.bestEver) w.bestEver = p.diff;
            if (p.hash && (!w.bestHash || p.diff > w.bestHash.diff)) w.bestHash = { diff: p.diff, hash: p.hash, at: p.at };
            // medidor de sorte e campeonato semanal
            if (p.diff > 0 && p.target > 0) {
              if (!w.luck) w.luck = { since: p.at, work: 0, best: 0 };
              w.luck.work += p.target;
              if (p.diff > w.luck.best) w.luck.best = p.diff;
              rollWeek();
              const ww = week.workers[w.name] || (week.workers[w.name] = { shares: 0, work: 0, best: 0, bestAt: null });
              ww.shares++;
              ww.work += p.target;
              if (p.diff > ww.best) { ww.best = p.diff; ww.bestAt = p.at; }
              const k = bucket(p.diff, p.target);
              if (k >= 0) { hist[k]++; (w.hist || (w.hist = new Array(HIST_BUCKETS).fill(0)))[k]++; }
            }
            noteBestHash(w.name, p);
          } else {
            w.rejected++;
            const kind = rejectKind(m.error);
            if (kind !== 'invalid') w[kind] = (w[kind] || 0) + 1;
            entry.error = Array.isArray(m.error) ? m.error[1] : (m.error && m.error.message) || String(m.error || 'recusado');
            w.lastReject = { at: p.at, error: entry.error };
            addEvent('reject', `${w.name}: share rejected (${entry.error})`, { worker: w.name });
          }
          recent.unshift(entry);
          if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
        }
      }
    } catch (e) { log('erro ao ler mensagem da pool:', e.message); }
    down.write(line + '\n');
  });

  function close(why) {
    if (s.closed) return; s.closed = true;
    sessions.delete(s);
    if (s.worker) { s.worker.online = Math.max(0, s.worker.online - 1); log(`[${label()}] ${s.worker.name} desconectou (${why})`); addEvent('worker_down', `${s.worker.name} disconnected (${why})`, { worker: s.worker.name }); }
    down.destroy(); if (up) up.destroy();
  }
  s.close = close;
  s.queued = () => down.writableLength + (up ? up.writableLength : 0);
  sessions.add(s);
  down.on('close', () => close('minerador fechou'));
  down.on('error', (e) => close('minerador: ' + e.code));
  connectUp(0);
}

// Métricas do próprio processo do proxy (RAM, CPU e fila de escrita nos sockets)
let cpuPrev = { usage: process.cpuUsage(), at: Date.now() };
function processStats() {
  const now = Date.now();
  const u = process.cpuUsage();
  const dt = (now - cpuPrev.at) * 1000;   // µs
  const cpuPct = dt > 0 ? Math.round(1000 * ((u.user - cpuPrev.usage.user) + (u.system - cpuPrev.usage.system)) / dt) / 10 : 0;
  cpuPrev = { usage: u, at: now };
  const queueBytes = [...sessions].reduce((n, x) => n + (x.queued ? x.queued() : 0), 0);
  return { uptimeS: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576), cpuPct, sessions: sessions.size, queueBytes };
}
function efficiency() {
  const t = Object.values(workers).reduce((a, w) => ({ ok: a.ok + (w.accepted || 0), bad: a.bad + (w.rejected || 0) }), { ok: 0, bad: 0 });
  return t.ok + t.bad ? Math.round(10000 * t.ok / (t.ok + t.bad)) / 100 : null;
}

function startServers() {
  const servers = [];
  for (const r of ROUTES) {
    const s = net.createServer((sock) => session(sock, r))
      .on('error', (e) => log(`porta ${r.listen}:`, e.message));
    s.listen(r.listen, '0.0.0.0', () => log(`porta ${r.listen} -> ${r.host}:${r.port} (${r.label})`));
    servers.push(s);
  }

  const statsServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/stats')) { res.writeHead(404); return res.end(); }
    const list = Object.values(workers).map((w) => {
      const { window, ...rest } = w;
      const hr = hashrate(w);   // poda a janela antes de contar
      const { bins, ...slim } = rest;
      return { ...slim, hashrate: hr, shares1h: w.window.length, hashrate15m: hashrateOver(w, 15 * 60e3), hashrate24h: hashrateOver(w, DAY_MS), stale: w.stale || 0, duplicate: w.duplicate || 0 };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (today.date !== dayKey()) today = { date: dayKey(), accepted: 0 };
    rollWeek();
    const lastHour = Object.values(workers).reduce((n, w) => n + w.window.length, 0);   // hashrate() já podou a janela de 1 h
    const dayBest = dayBestHash && dayBestHash.date === dayKey() ? dayBestHash : null;
    const routes = ROUTES.map((r) => ({
      ...r,
      upstreams: upstreamsOf(r).map((u) => {
        const h = health[hkey(u)] || {};
        const ps = pingScore(h.pingMs);
        return {
          ...u,
          down: isDown(u),
          since: h.since || null,
          error: h.error || null,
          pingMs: h.pingMs ?? null,
          pingScore: ps.score,
        };
      }),
    }));
    // Ping separado por pool em uso: a nerdminers (ESP32, centenas de shares, pool pequena) não pode
    // puxar a média das outras, e as reservas só testadas pelo failover não contam.
    const inUse = new Map();
    for (const s of sessions) {
      if (!s.upstream) continue;
      const k = hkey(s.upstream);
      const e = inUse.get(k) || { label: s.upstream.label, host: s.upstream.host, port: s.upstream.port, ports: new Set(), sessions: 0 };
      e.ports.add(s.route.listen); e.sessions++;
      inUse.set(k, e);
    }
    const pools = [...inUse.entries()].map(([k, e]) => {
      const ms = (health[k] || {}).pingMs ?? null;
      return { label: e.label, host: e.host, port: e.port, ports: [...e.ports].sort(), sessions: e.sessions, pingMs: ms, pingScore: pingScore(ms).score };
    }).sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));
    const inUsePings = pools.map((p) => p.pingMs).filter((m) => typeof m === 'number' && m >= 0);
    const activePings = inUsePings.length ? inUsePings : Object.values(health).map((h) => h.pingMs).filter((m) => typeof m === 'number' && m >= 0);
    const avgPing = activePings.length ? Math.round(activePings.reduce((a, b) => a + b, 0) / activePings.length) : null;
    const pingSummary = pingScore(avgPing);
    const totals = {
      today: today.accepted,
      lastHour,
      pingMs: avgPing,
      pingScore: pingSummary.score,
      pools,
      efficiency: efficiency(),
      hashrate: { m15: list.reduce((n, w) => n + w.hashrate15m, 0), h1: list.reduce((n, w) => n + w.hashrate, 0), h24: list.reduce((n, w) => n + w.hashrate24h, 0) },
    };
    res.end(JSON.stringify({ at: Date.now(), routes, workers: list, recent, totals, events, process: processStats(), week, lastWeek, bestHash, dayBestHash: dayBest, hist }));
  }).listen(STATS_PORT, process.env.PROXY_STATS_HOST || '127.0.0.1', () => log(`estatísticas em http://${process.env.PROXY_STATS_HOST || '127.0.0.1'}:${STATS_PORT}/stats`));
  servers.push(statsServer);
  return servers;
}

if (require.main === module) {
  startServers();
  process.on('SIGTERM', () => { saveStats(); process.exit(0); });
  process.on('SIGINT', () => { saveStats(); process.exit(0); });
}

module.exports = {
  ROUTES,
  bucket,
  noteBestHash,
  dayKey,
  rollWeek,
  worker,
  hashrate,
  hashrateOver,
  rejectKind,
  addBin,
  safeJson,
  saveStats,
  session,
  startServers,
  addEvent,
  efficiency,
  processStats,
  _state: () => ({ events, workers, recent, today, week, lastWeek, bestHash, dayBestHash, hist, health }),
};
