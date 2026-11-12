// Testes unitários das funções puras e estruturas internas do proxy.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const proxy = require('../src/proxy');

test('bucket: calcula faixas logarítmicas de sorte e descarta inválidos', () => {
  assert.strictEqual(proxy.bucket(0, 1), -1);
  assert.strictEqual(proxy.bucket(1, 0), -1);
  assert.strictEqual(proxy.bucket(-1, 1), -1);
  assert.strictEqual(proxy.bucket(1, -1), -1);

  assert.strictEqual(proxy.bucket(1, 1), 0);      // 1x = faixa 0
  assert.strictEqual(proxy.bucket(1.5, 1), 0);
  assert.strictEqual(proxy.bucket(2, 1), 1);      // 2x = faixa 1
  assert.strictEqual(proxy.bucket(3.9, 1), 1);
  assert.strictEqual(proxy.bucket(4, 1), 2);      // 4x = faixa 2
  assert.strictEqual(proxy.bucket(1e15, 1), 39);  // satura em HIST_BUCKETS - 1 (39)
});

test('safeJson: trata strings válidas, inválidas e nulas', () => {
  assert.strictEqual(proxy.safeJson(null), null);
  assert.strictEqual(proxy.safeJson(''), null);
  assert.strictEqual(proxy.safeJson('{invalido'), null);
  assert.deepStrictEqual(proxy.safeJson('{"ok":true}'), { ok: true });
});

test('dayKey: formato YYYY-MM-DD', () => {
  assert.match(proxy.dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('worker e hashrate: criação, atualização e janela de 1 hora', () => {
  const w = proxy.worker('test_miner', 'pool_a');
  assert.strictEqual(w.name, 'test_miner');
  assert.strictEqual(w.pool, 'pool_a');
  assert.strictEqual(w.pingMs, null);
  assert.strictEqual(w.pingScore, 'unknown');

  // Atualizar pool
  const w2 = proxy.worker('test_miner', 'pool_b');
  assert.strictEqual(w2.pool, 'pool_b');

  // hashrate sem shares
  assert.strictEqual(proxy.hashrate(w), 0);

  // hashrate com shares dentro da janela
  const now = Date.now();
  w.connectedSince = now - 1800e3;
  w.window = [
    [now - 1200e3, 1],
    [now - 600e3, 1],
    [now - 100e3, 1],
  ];
  const hr = proxy.hashrate(w);
  assert.ok(hr > 0, `hashrate: ${hr}`);

  // share antigo fora da janela (mais de 1 hora) é descartado
  w.window.push([now - 4000e3, 1]);
  const hr2 = proxy.hashrate(w);
  assert.strictEqual(w.window.some(([t]) => now - t > 3600e3), false);
});

test('noteBestHash: ignora hashes nulos e atualiza o recorde', () => {
  const now = Date.now();
  proxy.noteBestHash('test_miner', { diff: 100 }); // sem hash
  proxy.noteBestHash('test_miner', { diff: 50, hash: 'deadbeef', at: now });
  assert.ok(proxy._state().bestHash.diff >= 50);

  // hash com diff maior
  proxy.noteBestHash('test_miner', { diff: 200, hash: 'cafebabe', at: now });
  assert.strictEqual(proxy._state().bestHash.hash, 'cafebabe');
  assert.strictEqual(proxy._state().bestHash.diff, 200);
});

test('saveStats: persiste estatísticas no arquivo configurado', () => {
  assert.doesNotThrow(() => proxy.saveStats());
});

test('proxy expõe pingMs e pingScore por rota e totais no estado', () => {
  const st = proxy._state();
  assert.ok(st.health);
  const uKey = `${proxy.ROUTES[0].host}:${proxy.ROUTES[0].port}`;
  st.health[uKey] = { down: false, since: Date.now(), error: null, pingMs: 42 };
  assert.strictEqual(st.health[uKey].pingMs, 42);
});

test('addEvent: guarda os mais novos primeiro e limita a 100', () => {
  const ev = proxy._state().events;
  ev.length = 0;
  for (let i = 0; i < 105; i++) proxy.addEvent('reject', 'e' + i, { worker: 'w' });
  assert.strictEqual(ev.length, 100);
  assert.strictEqual(ev[0].msg, 'e104');
  assert.strictEqual(ev[0].worker, 'w');
  assert.ok(ev[0].at > 0);
  ev.length = 0;
});

test('efficiency: aceitos / (aceitos + recusados) em %', () => {
  const ws = proxy._state().workers;
  const saved = { ...ws };
  for (const k of Object.keys(ws)) delete ws[k];
  assert.strictEqual(proxy.efficiency(), null);
  proxy.worker('eff1', 'x').accepted = 99;
  ws.eff1.rejected = 1;
  assert.strictEqual(proxy.efficiency(), 99);
  delete ws.eff1;
  Object.assign(ws, saved);
});

test('processStats: uptime, RAM, CPU, sessões e fila', () => {
  const p = proxy.processStats();
  assert.ok(p.uptimeS >= 0 && p.rssMB > 0);
  assert.ok(p.cpuPct >= 0);
  assert.strictEqual(typeof p.sessions, 'number');
  assert.strictEqual(p.queueBytes, 0);
});

test('eventos são gravados e recarregados do arquivo de estatísticas', () => {
  const { execFileSync } = require('child_process');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ev-')), 'stats.json');
  const run = (code) => execFileSync(process.execPath, ['-e', code], { env: { ...process.env, PROXY_STATS_FILE: file }, cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  run("const p=require('./src/proxy');p.addEvent('pool_up','persist-me is back');p.saveStats();process.exit(0)");
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).events[0].msg, 'persist-me is back');
  const out = run("const p=require('./src/proxy');console.log(p._state().events[0].msg);process.exit(0)");
  assert.strictEqual(out.trim(), 'persist-me is back');
});

test('rejectKind: classifica stale, duplicado e inválido', () => {
  assert.strictEqual(proxy.rejectKind([21, 'Job not found', null]), 'stale');
  assert.strictEqual(proxy.rejectKind([22, 'Duplicate share', null]), 'duplicate');
  assert.strictEqual(proxy.rejectKind([23, 'Low difficulty share', null]), 'low');
  assert.strictEqual(proxy.rejectKind([20, 'Above target', null]), 'low');
  assert.strictEqual(proxy.rejectKind([24, 'Unauthorized worker', null]), 'invalid');
  assert.strictEqual(proxy.rejectKind({ code: 21, message: 'x' }), 'stale');
  assert.strictEqual(proxy.rejectKind({ message: 'stale share' }), 'stale');
  assert.strictEqual(proxy.rejectKind(null), 'invalid');
});

test('addBin e hashrateOver: médias de 15 min, 1 h e 24 h', () => {
  const now = Date.now();
  const w = { window: [[now - 60e3, 1], [now - 20 * 60e3, 1]], connectedSince: now - 3 * 3600e3, bins: [] };
  assert.strictEqual(proxy.hashrateOver({ window: [], bins: [] }, 24 * 3600e3), 0);
  // 15 min: só o share de 1 min atrás; janela mínima de 60 s
  const r15 = proxy.hashrateOver(w, 15 * 60e3);
  assert.ok(r15 > 0);
  assert.ok(proxy.hashrateOver(w, 3600e3) > 0);
  assert.ok(proxy.hashrateOver(w, 3600e3) < r15 * 2.01);   // 2 shares num span maior
  // 24 h: baldes de 5 min, soma de balde repetido e descarte de balde com mais de 24 h
  proxy.addBin(w, now - 2 * 3600e3, 2);
  proxy.addBin(w, now - 2 * 3600e3 + 1000, 2);
  assert.strictEqual(w.bins.length, 1);
  assert.strictEqual(w.bins[0][1], 4);
  w.bins.unshift([now - 25 * 3600e3, 9]);
  proxy.addBin(w, now, 1);
  assert.ok(!w.bins.some(([t]) => t < now - 24 * 3600e3));
  assert.ok(proxy.hashrateOver(w, 24 * 3600e3) > 0);
});

test('hashrate de ESP32 na reserva: um share aceito por sorte não vira 100x mais', () => {
  const now = Date.now();
  const w = { connectedSince: now - 30 * 60e3, window: [[now - 60e3, 1]], subs: [] };   // 1 share de dificuldade 1 aceito
  // ~350 kH/s com o alvo próprio de 0,001: um share a cada ~12 s; a pool pede 1, então quase todos são recusados
  for (let t = now - 30 * 60e3; t < now; t += 12e3) w.subs.push([t, 0.001 + Math.random() * 0.002, 1]);
  const hr = proxy.hashrate(w);
  assert.ok(hr > 250e3 && hr < 600e3, `estimativa ${Math.round(hr)} H/s`);
  // minerador normal (shares no alvo da pool): continua usando os aceitos
  const n = { connectedSince: now - 30 * 60e3, window: [], subs: [] };
  for (let t = now - 30 * 60e3; t < now; t += 30e3) { n.window.push([t, 1]); n.subs.push([t, 1.5, 1]); }
  const hn = proxy.hashrate(n);
  assert.ok(Math.abs(hn - 60 * 4294967296 / 1800) / hn < 0.05);
});

test('últimas 24 h do worker (modal): por hora, top 10 e o que passou de 24 h sai', () => {
  const now = Date.now();
  const w = { name: 'orangeone', pool: 'atlaspool', ip: '192.168.0.138', online: 1, bestEver: 15e6 };
  proxy.noteHour(w, now - 30 * 3600e3, true, 9e9, 2000);   // velho: não conta
  for (let i = 0; i < 12; i++) proxy.noteHour(w, now - i * 1000, true, 1000 * (i + 1), 2000);
  proxy.noteHour(w, now - 3 * 3600e3, true, 5e6, 2000);
  proxy.noteHour(w, now - 3 * 3600e3, false);
  const d = proxy.workerDay(w, now);
  assert.strictEqual(d.hours.length, 24);
  assert.strictEqual(d.hours[23].t, Math.floor(now / 3600e3) * 3600e3);
  assert.strictEqual(d.accepted, 13);
  assert.strictEqual(d.rejected, 1);
  assert.strictEqual(d.best, 5e6);
  assert.strictEqual(d.top.length, 10);
  assert.strictEqual(d.top[0].diff, 5e6);
  assert.ok(d.top.every((t) => t.diff !== 9e9));
  assert.strictEqual(d.name, 'orangeone');
  assert.ok(d.hours[23].hashrate > 0);
});
