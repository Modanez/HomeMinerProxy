// Teste de ponta a ponta do proxy: pool falsa <- proxy <- minerador de teste.
// Confere que as mensagens passam sem alteração e que o proxy conta e mede os shares.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { shareDifficulty } = require('../src/stratum');

const TARGET = 0.00005;   // ~200 mil hashes por share: rápido em JS

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function lines(sock, onMsg) {
  let buf = '';
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) onMsg(l); } });
}
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) { /* tenta de novo */ } if (Date.now() > end) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 100)); } };

test('proxy repassa, mede e conta os shares', async (t) => {
  // pool falsa: aceita o 1º submit e recusa o 2º
  const received = [];
  let submits = 0;
  const job = ['1', crypto.randomBytes(32).toString('hex'), '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20' + crypto.randomBytes(8).toString('hex'),
    crypto.randomBytes(6).toString('hex') + 'ffffffff0100f2052a01000000', [crypto.randomBytes(32).toString('hex')], '20000000', '1d00ffff', '6553f100', true];
  const pool = net.createServer((c) => {
    const send = (o) => c.write(JSON.stringify(o) + '\n');
    lines(c, (l) => {
      received.push(l);
      const m = JSON.parse(l);
      if (m.method === 'mining.subscribe') send({ id: m.id, result: [[['mining.notify', 'x']], 'deadbeef', 4], error: null });
      else if (m.method === 'mining.authorize') {
        send({ id: m.id, result: true, error: null });
        send({ id: null, method: 'mining.set_extranonce', params: ['deadbeef'] });
        send({ id: null, method: 'mining.set_difficulty', params: [TARGET] });
        send({ id: null, method: 'mining.notify', params: job });
      } else if (m.method === 'mining.configure') {
        send({ id: m.id, result: { 'version-rolling': true, 'version-rolling.mask': '1fffe000' } });
      } else if (m.method === 'mining.submit') {
        submits++;
        send(submits === 1 ? { id: m.id, result: true, error: null } : { id: m.id, result: null, error: [23, 'Difficulty too low', null] });
      }
    });
  });
  const poolPort = await new Promise((r) => pool.listen(0, '127.0.0.1', () => r(pool.address().port)));
  const [listen, statsPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  fs.writeFileSync(path.join(dir, 'proxy-stats.json'), JSON.stringify({
    savedAt: Date.now() - 86400e3,
    workers: { salvo: { name: 'salvo', bestEver: 10, online: 1 } },
    today: { date: '2020-01-01', accepted: 5 },
    week: { key: '2020-01-01', workers: { salvo: { shares: 1, work: 1, best: 1 } } },
    lastWeek: { key: '2019-12-25', workers: {} },
    bestHash: { worker: 'salvo', diff: 0.000001, hash: '00', at: 1 },
    dayBestHash: { worker: 'salvo', diff: 0.000001, hash: '00', at: 1, date: '2020-01-01' },
    hist: new Array(40).fill(0),
  }));
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify([{ listen, host: '127.0.0.1', port: poolPort, label: 'teste' }]), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir },
    stdio: 'ignore',
  });
  // o proxy grava as estatísticas ao sair: espera ele terminar antes de apagar a pasta
  t.after(async () => {
    const gone = proxy.exitCode != null ? null : new Promise((r) => proxy.once('exit', r));
    proxy.kill(); pool.close(); await gone;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  // minerador de teste
  const miner = await waitFor(() => new Promise((res) => { const s = net.connect(listen, '127.0.0.1', () => res(s)); s.on('error', () => res(null)); }));
  t.after(() => miner.destroy());
  const fromPool = [];
  const replies = {};
  lines(miner, (l) => { fromPool.push(l); const m = JSON.parse(l); if (m.id != null) replies[m.id] = m; });
  const sent = [
    '{"id":1,"method":"mining.subscribe","params":["teste/1.0"]}',
    '{"id":2,"method":"mining.authorize","params":["bc1qteste.vovo","x"]}',
    '{"id":10,"method":"mining.configure","params":[["version-rolling"],{"version-rolling.mask":"1fffe000"}]}',
  ];
  for (const l of sent) miner.write(l + '\n');
  await waitFor(() => fromPool.some((l) => l.includes('mining.notify')));

  // minera um share de verdade contra o job recebido
  const en1 = replies[1].result[1];
  const j = { prevhash: job[1], coinb1: job[2], coinb2: job[3], branches: job[4], version: job[5], nbits: job[6] };
  let share = null;
  for (let n = 0; n < 5e6 && !share; n++) {
    const nonce = n.toString(16).padStart(8, '0');
    const r = shareDifficulty(j, en1, ['bc1qteste.vovo', '1', '00000000', job[7], nonce], null);
    if (r.diff >= TARGET) share = { nonce, r };
  }
  assert.ok(share, 'não achou share');
  const good = `{"id":3,"method":"mining.submit","params":["bc1qteste.vovo","1","00000000","${job[7]}","${share.nonce}"]}`;
  const bad = `{"id":4,"method":"mining.submit","params":["bc1qteste.vovo","1","00000001","${job[7]}","00000000"]}`;
  miner.write(good + '\n'); miner.write(bad + '\n');
  await waitFor(() => replies[3] && replies[4]);

  // as linhas chegaram na pool exatamente como o minerador mandou
  assert.deepStrictEqual(received, [...sent, good, bad]);

  const s = await waitFor(async () => { const r = await getJson(`http://127.0.0.1:${statsPort}/stats`); return r.workers.length && r; });
  const w = s.workers.find((x) => x.name === 'vovo');
  assert.ok(w, 'worker não apareceu');
  assert.strictEqual(w.pool, 'teste');
  assert.strictEqual(w.accepted, 1);
  assert.strictEqual(w.rejected, 1);
  assert.strictEqual(w.online, 1);
  assert.ok(Math.abs(w.bestEver - share.r.diff) < 1e-9);
  assert.strictEqual(s.bestHash.hash, share.r.hash);
  assert.strictEqual(s.totals.today, 1);
  assert.strictEqual(s.recent[0].ok, false);
  assert.strictEqual(s.recent[0].error, 'Difficulty too low');
  assert.strictEqual(s.recent[1].target, TARGET);
  // rejeição com código 23 é "inválido": não conta como stale nem duplicado
  assert.strictEqual(w.stale, 0);
  assert.strictEqual(w.duplicate, 0);
  assert.ok(w.hashrate24h > 0 && w.hashrate15m > 0);
  assert.ok(!('bins' in w));
  assert.ok(s.totals.hashrate.h24 > 0 && s.totals.hashrate.m15 > 0);
  assert.strictEqual(w.ip, '127.0.0.1');
  assert.strictEqual(s.totals.efficiency, 50);
  assert.ok(s.events.some((e) => e.type === 'worker_up' && e.worker === 'vovo'));
});

test('rotas padrão: todas as pools, portas sem repetição', async (t) => {
  const statsPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const env = { ...process.env, PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir };
  delete env.PROXY_ROUTES;
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], { env, stdio: 'ignore' });
  t.after(() => { proxy.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = await waitFor(() => getJson(`http://127.0.0.1:${statsPort}/stats`));
  const byPort = Object.fromEntries(s.routes.map((r) => [r.listen, r.host]));
  assert.strictEqual(new Set(s.routes.map((r) => r.listen)).size, s.routes.length, 'porta repetida');
  assert.ok(!s.routes.some((r) => r.listen === statsPort));
  assert.strictEqual(byPort[3333], 'public-pool.io');
  assert.strictEqual(byPort[3334], 'solo.ckpool.org');
  assert.strictEqual(byPort[3335], 'pool.nerdminers.org');
  assert.strictEqual(byPort[3338], 'solo.atlaspool.io');
  assert.strictEqual(byPort[3339], 'eusolo.ckpool.org');
});

// pool falsa mínima: responde subscribe/authorize e manda um job com uma marca no job_id
function miniPool(tag) {
  return net.createServer((c) => {
    lines(c, (l) => {
      const m = JSON.parse(l);
      const send = (o) => c.write(JSON.stringify(o) + '\n');
      if (m.method === 'mining.subscribe') send({ id: m.id, result: [[['mining.notify', 'x']], 'cafebabe', 4], error: null });
      else if (m.method === 'mining.authorize') {
        send({ id: m.id, result: true, error: null });
        send({ id: null, method: 'mining.notify', params: [tag, '00'.repeat(32), '01', '02', [], '20000000', '1d00ffff', '6553f100', true] });
      }
    });
  });
}
function mine(port, user = 'bc1qteste.esp') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const got = { jobs: [], closed: false, sock: s };
    lines(s, (l) => { const m = JSON.parse(l); if (m.method === 'mining.notify') got.jobs.push(m.params[0]); });
    s.on('close', () => { got.closed = true; });
    s.on('error', reject);
    s.on('connect', () => {
      s.write('{"id":1,"method":"mining.subscribe","params":[]}\n{"id":2,"method":"mining.authorize","params":[' + JSON.stringify(user) + ',"x"]}\n');
      resolve(got);
    });
  });
}

test('failover: pool principal fora vai para a reserva e volta quando ela se recupera', async (t) => {
  const [primaryPort, listen, statsPort] = [await freePort(), await freePort(), await freePort()];
  const backup = miniPool('reserva');
  const backupPort = await new Promise((r) => backup.listen(0, '127.0.0.1', () => r(backup.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const routes = [{ listen, host: '127.0.0.1', port: primaryPort, label: 'principal', backup: [{ host: '127.0.0.1', port: backupPort, label: 'reserva' }] }];
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify(routes), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir, PROXY_HEALTH_MS: '300', PROXY_CONNECT_TIMEOUT_MS: '1000', PROXY_FAILBACK_STABLE_S: '0' },
    stdio: 'ignore',
  });
  let primary = null;
  t.after(() => { proxy.kill(); backup.close(); if (primary) primary.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => getJson(`http://127.0.0.1:${statsPort}/stats`));

  // 1) principal fora (porta fechada): o minerador recebe o job da reserva
  const a = await mine(listen);
  await waitFor(() => a.jobs.length);
  assert.deepStrictEqual(a.jobs, ['reserva']);
  let s = await getJson(`http://127.0.0.1:${statsPort}/stats`);
  assert.strictEqual(s.routes[0].upstreams[0].down, true);
  assert.strictEqual(s.workers.find((w) => w.name === 'esp').pool, 'reserva');

  // 2) a principal volta: a sessão na reserva é encerrada e a próxima conexão vai para a principal
  primary = miniPool('principal');
  await new Promise((r) => primary.listen(primaryPort, '127.0.0.1', r));
  await waitFor(() => a.closed, 5000);
  const b = await mine(listen);
  t.after(() => b.sock.destroy());
  await waitFor(() => b.jobs.length);
  assert.deepStrictEqual(b.jobs, ['principal']);
  s = await getJson(`http://127.0.0.1:${statsPort}/stats`);
  assert.strictEqual(s.routes[0].upstreams[0].down, false);
  assert.strictEqual(s.workers.find((w) => w.name === 'esp').pool, 'principal');
});

test('failback espera a principal ficar estável; quem não volta aparece em missing', async (t) => {
  const [primaryPort, listen, statsPort] = [await freePort(), await freePort(), await freePort()];
  const backup = miniPool('reserva');
  const backupPort = await new Promise((r) => backup.listen(0, '127.0.0.1', () => r(backup.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const routes = [{ listen, host: '127.0.0.1', port: primaryPort, label: 'principal', backup: [{ host: '127.0.0.1', port: backupPort, label: 'reserva' }] }];
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify(routes), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir, PROXY_HEALTH_MS: '300', PROXY_CONNECT_TIMEOUT_MS: '1000',
      PROXY_FAILBACK_STABLE_S: '4', PROXY_MISSING_MIN: '0.02' },   // 4 s: folga para máquina lenta (CI)
    stdio: 'ignore',
  });
  let primary = null;
  t.after(() => { proxy.kill(); backup.close(); if (primary) primary.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => getJson(`http://127.0.0.1:${statsPort}/stats`));
  const stats = () => getJson(`http://127.0.0.1:${statsPort}/stats`);

  const a = await mine(listen);
  await waitFor(() => a.jobs.length);
  assert.deepStrictEqual(a.jobs, ['reserva']);

  // a principal volta, mas o minerador fica na reserva até ela ficar estável (4 s)
  primary = miniPool('principal');
  await new Promise((r) => primary.listen(primaryPort, '127.0.0.1', r));
  await waitFor(async () => !(await stats()).routes[0].upstreams[0].down, 3000);
  let s = await stats();
  assert.strictEqual(a.closed, false, 'ainda na reserva logo depois da volta');
  assert.strictEqual(s.routes[0].onBackup, 1);
  await waitFor(() => a.closed, 10000);

  // não reconectou: vira "missing" e um evento
  // a lista sai na hora; o evento vem na próxima volta do health check: espera os dois
  await waitFor(async () => { const x = await stats(); return x.missing.length && x.events.some((e) => e.type === 'missing'); }, 6000);
  s = await stats();
  assert.strictEqual(s.missing[0].name, 'esp');
  assert.strictEqual(s.missing[0].why, 'pool');
  assert.ok(s.events.some((e) => e.type === 'missing' && /esp did not reconnect/.test(e.msg)));
  // voltou: sai da lista
  const b = await mine(listen);
  t.after(() => b.sock.destroy());
  await waitFor(() => b.jobs.length);
  assert.deepStrictEqual(b.jobs, ['principal']);
  s = await stats();
  assert.deepStrictEqual(s.missing, []);
});

test('pool instável (cai e volta): um aviso de instável e um de estável, não um por minuto', async (t) => {
  const [primaryPort, listen, statsPort] = [await freePort(), await freePort(), await freePort()];
  const backup = miniPool('reserva');
  const backupPort = await new Promise((r) => backup.listen(0, '127.0.0.1', () => r(backup.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const routes = [{ listen, host: '127.0.0.1', port: primaryPort, label: 'principal', backup: [{ host: '127.0.0.1', port: backupPort, label: 'reserva' }] }];
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify(routes), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir, PROXY_HEALTH_MS: '250', PROXY_CONNECT_TIMEOUT_MS: '800', PROXY_FAILBACK_STABLE_S: '2' },
    stdio: 'ignore',
  });
  let primary = null;
  t.after(() => { proxy.kill(); backup.close(); if (primary) primary.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const stats = () => getJson(`http://127.0.0.1:${statsPort}/stats`);
  await waitFor(stats);
  const a = await mine(listen);
  t.after(() => a.sock.destroy());
  await waitFor(() => a.jobs.length);
  const open = async () => { primary = miniPool('principal'); await new Promise((r) => primary.listen(primaryPort, '127.0.0.1', r)); };
  const shut = () => new Promise((r) => { primary.close(r); primary = null; });
  // volta, cai, volta, cai, volta... antes de ficar 2 s estável
  for (let i = 0; i < 3; i++) {
    await open();
    await waitFor(async () => !(await stats()).routes[0].upstreams[0].down, 3000);
    await shut();
    await waitFor(async () => (await stats()).routes[0].upstreams[0].down, 3000);
  }
  await open();
  await waitFor(() => a.closed, 8000);   // estável: os mineradores voltam
  await waitFor(async () => (await stats()).events.some((e) => /is stable again/.test(e.msg)), 3000);
  const ev = (await stats()).events.map((e) => e.msg);
  assert.strictEqual(ev.filter((m) => /is unstable/.test(m)).length, 1);
  assert.strictEqual(ev.filter((m) => /is stable again/.test(m)).length, 1);
  assert.ok(ev.filter((m) => /principal is back/.test(m)).length <= 1, ev.join(' | '));
});

test('pool que manda trabalho nas sessões abertas não é dada como fora por uma conexão nova recusada', async (t) => {
  const [primaryPort, listen, statsPort] = [await freePort(), await freePort(), await freePort()];
  // pool que manda um job novo a cada 300 ms para quem está conectado
  const clients = new Set();
  const mk = () => net.createServer((c) => {
    clients.add(c); c.on('close', () => clients.delete(c)); c.on('error', () => {});
    lines(c, (l) => {
      const m = JSON.parse(l), send = (o) => c.write(JSON.stringify(o) + '\n');
      if (m.method === 'mining.subscribe') send({ id: m.id, result: [[['mining.notify', 'x']], 'cafebabe', 4], error: null });
      else if (m.method === 'mining.authorize') send({ id: m.id, result: true, error: null });
    });
  });
  let pool = mk();
  await new Promise((r) => pool.listen(primaryPort, '127.0.0.1', r));
  let n = 0;
  const tick = setInterval(() => { for (const c of clients) c.write(JSON.stringify({ id: null, method: 'mining.notify', params: ['j' + (n++), '00'.repeat(32), '01', '02', [], '20000000', '1d00ffff', '6553f100', true] }) + '\n'); }, 300);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const routes = [{ listen, host: '127.0.0.1', port: primaryPort, label: 'principal' }];   // sem reserva, como a nerdminers
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify(routes), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir, PROXY_HEALTH_MS: '300', PROXY_CONNECT_TIMEOUT_MS: '800' },
    stdio: 'ignore',
  });
  t.after(() => { clearInterval(tick); proxy.kill(); for (const c of clients) c.destroy(); pool.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const stats = () => getJson(`http://127.0.0.1:${statsPort}/stats`);
  await waitFor(stats);
  const a = await mine(listen);
  t.after(() => a.sock.destroy());
  await waitFor(() => a.jobs.length >= 2);
  // a pool para de aceitar conexões novas (as abertas continuam recebendo trabalho)
  pool.close();   // sem esperar: o close só termina quando as conexões abertas acabam
  const b = await mine(listen);
  t.after(() => b.sock.destroy());
  await new Promise((r) => setTimeout(r, 1500));
  let s = await stats();
  assert.strictEqual(s.routes[0].upstreams[0].down, false, 'continua no ar: as sessões abertas recebem trabalho');
  assert.strictEqual(b.closed, false, 'a conexão nova espera e tenta de novo');
  // a pool volta a aceitar: a conexão nova entra nela
  pool = mk();
  await new Promise((r) => pool.listen(primaryPort, '127.0.0.1', r));
  await waitFor(() => b.jobs.length, 8000);
  s = await stats();
  assert.ok(!s.events.some((e) => e.type === 'pool_down'), 'nenhum aviso de pool fora');
});

test('SOLO Group (endereço.worker#grupo): o grupo vai para a pool e o nome do worker fica limpo', async (t) => {
  const [listen, statsPort] = [await freePort(), await freePort()];
  let seenUser = null;
  const pool = net.createServer((c) => lines(c, (l) => {
    const m = JSON.parse(l), send = (o) => c.write(JSON.stringify(o) + '\n');
    if (m.method === 'mining.subscribe') send({ id: m.id, result: [[['mining.notify', 'x']], 'cafebabe', 4], error: null });
    else if (m.method === 'mining.authorize') { seenUser = m.params[0]; send({ id: m.id, result: true, error: null }); send({ id: null, method: 'mining.notify', params: ['g', '00'.repeat(32), '01', '02', [], '20000000', '1d00ffff', '6553f100', true] }); }
  }));
  const poolPort = await new Promise((r) => pool.listen(0, '127.0.0.1', () => r(pool.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify([{ listen, host: '127.0.0.1', port: poolPort, label: 'bitronics ASIC' }]), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir },
    stdio: 'ignore',
  });
  t.after(() => { proxy.kill(); pool.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => getJson(`http://127.0.0.1:${statsPort}/stats`));
  const a = await mine(listen, 'bc1qteste.bitaxe1#firstblock');
  t.after(() => a.sock.destroy());
  await waitFor(() => a.jobs.length);
  assert.strictEqual(seenUser, 'bc1qteste.bitaxe1#firstblock');
  const w = (await getJson(`http://127.0.0.1:${statsPort}/stats`)).workers.find((x) => x.name === 'bitaxe1');
  assert.ok(w, 'worker bitaxe1 (sem o #grupo)');
  assert.strictEqual(w.group, 'firstblock');
});

test('ping separado por pool em uso (reservas só testadas não entram)', async (t) => {
  const [l1, l2, statsPort] = [await freePort(), await freePort(), await freePort()];
  const p1 = miniPool('um'), p2 = miniPool('dois'), spare = miniPool('reserva');
  const port1 = await new Promise((r) => p1.listen(0, '127.0.0.1', () => r(p1.address().port)));
  const port2 = await new Promise((r) => p2.listen(0, '127.0.0.1', () => r(p2.address().port)));
  const portS = await new Promise((r) => spare.listen(0, '127.0.0.1', () => r(spare.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const routes = [
    { listen: l1, host: '127.0.0.1', port: port1, label: 'public-pool', backup: [{ host: '127.0.0.1', port: portS, label: 'ckpool' }] },
    { listen: l2, host: '127.0.0.1', port: port2, label: 'nerdminers' },
  ];
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify(routes), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir }, stdio: 'ignore',
  });
  const socks = [];
  t.after(() => { socks.forEach((s) => s.destroy()); proxy.kill(); p1.close(); p2.close(); spare.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => getJson(`http://127.0.0.1:${statsPort}/stats`));
  for (const port of [l1, l2, l2]) { const m = await mine(port); socks.push(m.sock); await waitFor(() => m.jobs.length); }
  const s = await waitFor(async () => { const j = await getJson(`http://127.0.0.1:${statsPort}/stats`); return j.totals.pools.length === 2 && j; });
  assert.deepStrictEqual(s.totals.pools.map((p) => [p.label, p.sessions, p.ports]), [['nerdminers', 2, [l2]], ['public-pool', 1, [l1]]]);
  for (const p of s.totals.pools) { assert.ok(p.pingMs >= 0, p.label); assert.ok(['great', 'good', 'poor'].includes(p.pingScore)); }
  assert.ok(!s.totals.pools.some((p) => p.label === 'ckpool'));   // reserva sem minerador não aparece
});
