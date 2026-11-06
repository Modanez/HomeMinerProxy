const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../src/discover');

test('sub-rede: só endereços privados, sem o próprio servidor', () => {
  const h = d.subnetHosts(['192.168.0.134', '8.8.8.8', 'fe80::1']);
  assert.strictEqual(h.length, 253);
  assert.ok(!h.includes('192.168.0.134'));
  assert.ok(h.includes('192.168.0.1') && h.includes('192.168.0.254'));
});

test('pool do cgminer: separa host e porta', () => {
  assert.deepStrictEqual(d.splitPool('stratum+tcp://192.168.0.134:3333'), { url: '192.168.0.134', port: 3333 });
  assert.deepStrictEqual(d.splitPool('solo.ckpool.org:3333'), { url: 'solo.ckpool.org', port: 3333 });
  assert.deepStrictEqual(d.splitPool('pool.example'), { url: 'pool.example', port: null });
});

test('hashrate do cgminer: MHS, GHS ou THS', () => {
  assert.strictEqual(d.cgHashrate({ 'MHS 5s': 6000000 }), 6e12);
  assert.strictEqual(d.cgHashrate({ 'GHS av': 4000 }), 4e12);
  assert.strictEqual(d.cgHashrate({ 'THS 5s': 0, 'THS av': 13.5 }), 13.5e12);
});

test('MAC da Espressif e tabela ARP', () => {
  assert.ok(d.isEspressif('24:6f:28:aa:bb:cc'));
  assert.ok(!d.isEspressif('00:11:22:33:44:55'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-'));
  const f = path.join(dir, 'arp');
  fs.writeFileSync(f, 'IP address       HW type     Flags       HW address            Mask     Device\n' +
    '192.168.0.50     0x1         0x2         24:6f:28:aa:bb:cc     *        eth0\n' +
    '192.168.0.60     0x1         0x0         00:00:00:00:00:00     *        eth0\n');
  const m = d.readArp(f);
  assert.strictEqual(m.get('192.168.0.50'), '24:6F:28:AA:BB:CC');
  assert.ok(!m.has('192.168.0.60'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API do cgminer: summary, version e pools', async (t) => {
  const answers = {
    summary: { STATUS: [{ STATUS: 'S' }], SUMMARY: [{ 'MHS 5s': 4100000 }] },
    version: { VERSION: [{ Type: 'Avalon Nano3', CGMiner: '4.11.1' }] },
    pools: { POOLS: [{ URL: 'stratum+tcp://solo.ckpool.org:3333', User: 'bc1qxyz.avalon', Status: 'Alive', 'Stratum Active': true }] },
  };
  const srv = net.createServer((s) => s.on('data', (b) => { const c = JSON.parse(String(b)).command; s.end(JSON.stringify(answers[c]) + '\0'); }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const r = await d.cgminerInfo('127.0.0.1', 1000, srv.address().port);
  assert.ok(r.ok);
  assert.strictEqual(r.data.model, 'Avalon Nano3');
  assert.strictEqual(r.data.hashRate, 4.1e12);
  assert.deepStrictEqual(r.data.pool, { url: 'solo.ckpool.org', port: 3333, user: 'bc1qxyz.avalon' });
  // sem API: falha rápida
  const none = await d.cgminerInfo('127.0.0.1', 300, 1);
  assert.strictEqual(none.ok, false);
});

test('varredura: reconhece cada tipo e diz se minera pelo proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-'));
  const arp = path.join(dir, 'arp');
  fs.writeFileSync(arp, 'IP address HW type Flags HW address Mask Device\n' +
    '192.168.0.10 0x1 0x2 aa:bb:cc:00:00:10 * eth0\n192.168.0.20 0x1 0x2 24:0a:c4:00:00:20 * eth0\n' +
    '192.168.0.21 0x1 0x2 24:0a:c4:00:00:21 * eth0\n192.168.0.30 0x1 0x2 11:22:33:00:00:30 * eth0\n');
  const axe = async (ip) => ip === '192.168.0.10' ? { ok: true, data: { model: 'Gamma', hostname: 'bitaxe', worker: 'bitaxe1', hashRate: 1.2e12, pool: { url: '192.168.0.134', port: 3335 } } }
    : ip === '192.168.0.11' ? { ok: true, data: { model: 'Gamma', hostname: 'bitaxe2', worker: 'bitaxe2', hashRate: 1.1e12, pool: { url: 'solo.ckpool.org', port: 3333 } } } : { ok: false };
  const cg = async (ip) => ip === '192.168.0.40' ? { ok: true, data: { model: 'Avalon Nano3', hashRate: 4e12, pool: { url: 'pool.example', port: 3333, user: 'x.avalon' } } } : { ok: false };
  const out = await d.scan(['192.168.0.134'], {
    hosts: ['192.168.0.10', '192.168.0.11', '192.168.0.20', '192.168.0.21', '192.168.0.30', '192.168.0.40'], arpFile: arp, probeAxe: axe, probeCg: cg,
    known: { ourHosts: ['192.168.0.134', 'homeminer.local'], workers: { '192.168.0.21': 'nerdminer', '192.168.0.30': 'macbook' }, bitaxes: [{ name: 'bitaxe1', host: '192.168.0.10' }] },
  });
  const by = Object.fromEntries(out.map((x) => [x.ip, x]));
  assert.deepStrictEqual(out.map((x) => x.ip), ['192.168.0.10', '192.168.0.11', '192.168.0.20', '192.168.0.21', '192.168.0.30', '192.168.0.40']);
  assert.strictEqual(by['192.168.0.10'].via, 'proxy'); assert.strictEqual(by['192.168.0.10'].registered, 'bitaxe1');
  assert.strictEqual(by['192.168.0.11'].via, 'direct'); assert.strictEqual(by['192.168.0.11'].registered, null);
  assert.strictEqual(by['192.168.0.20'].kind, 'esp32'); assert.strictEqual(by['192.168.0.20'].via, 'unknown');
  assert.strictEqual(by['192.168.0.21'].kind, 'esp32'); assert.strictEqual(by['192.168.0.21'].via, 'proxy'); assert.strictEqual(by['192.168.0.21'].proxyWorker, 'nerdminer');
  assert.strictEqual(by['192.168.0.30'].kind, 'proxy'); assert.strictEqual(by['192.168.0.30'].proxyWorker, 'macbook');
  assert.strictEqual(by['192.168.0.40'].kind, 'cgminer'); assert.strictEqual(by['192.168.0.40'].worker, 'avalon'); assert.strictEqual(by['192.168.0.40'].via, 'direct');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configurações: aba Descobrir e expressões do navegador com as barras intactas', () => {
  const html = require('../src/settings').page('pt', true, 'obsidian');
  assert.ok(html.includes('data-pane="discover"') && html.includes('id="dsc_run"'));
  // o script do navegador vem de um template literal: "\w" sem barra dupla viraria "w"
  assert.ok(html.includes(".replace(/[^\\w.\\-]/g, '')"));
  assert.ok(html.includes('(:\\d{2,5})?$/'));
});
