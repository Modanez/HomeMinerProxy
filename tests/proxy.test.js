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
        send({ id: null, method: 'mining.set_difficulty', params: [TARGET] });
        send({ id: null, method: 'mining.notify', params: job });
      } else if (m.method === 'mining.submit') {
        submits++;
        send(submits === 1 ? { id: m.id, result: true, error: null } : { id: m.id, result: null, error: [23, 'Difficulty too low', null] });
      }
    });
  });
  const poolPort = await new Promise((r) => pool.listen(0, '127.0.0.1', () => r(pool.address().port)));
  const [listen, statsPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const proxy = spawn(process.execPath, [path.join(__dirname, '../src/proxy.js')], {
    env: { ...process.env, PROXY_ROUTES: JSON.stringify([{ listen, host: '127.0.0.1', port: poolPort, label: 'teste' }]), PROXY_STATS_PORT: String(statsPort), DATA_DIR: dir },
    stdio: 'ignore',
  });
  t.after(() => { proxy.kill(); pool.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // minerador de teste
  const miner = await waitFor(() => new Promise((res) => { const s = net.connect(listen, '127.0.0.1', () => res(s)); s.on('error', () => res(null)); }));
  t.after(() => miner.destroy());
  const fromPool = [];
  const replies = {};
  lines(miner, (l) => { fromPool.push(l); const m = JSON.parse(l); if (m.id != null) replies[m.id] = m; });
  const sent = [
    '{"id":1,"method":"mining.subscribe","params":["teste/1.0"]}',
    '{"id":2,"method":"mining.authorize","params":["bc1qteste.vovo","x"]}',
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
});
