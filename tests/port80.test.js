// Porta 80 além da 3000 (com uma porta alta no lugar da 80 para o teste).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');

const get = (port) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/x' }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d)); }).on('error', reject));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('a segunda porta entrega ao mesmo servidor; HTTP80=0 desliga', async (t) => {
  const { mirror, wanted } = require('../src/port80');
  const main = http.createServer((req, res) => res.end('painel ' + req.url));
  await new Promise((r) => main.listen(0, '127.0.0.1', r));
  t.after(() => main.close());
  const alt = await freePort();
  const logs = [];
  const m = mirror(main, { port: alt, host: '127.0.0.1', mainPort: main.address().port, log: (l) => logs.push(l) });
  t.after(() => m.close());
  if (!wanted(main.address().port)) return t.skip('sem root: não abre a porta baixa');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(await get(alt), 'painel /x');
  assert.ok(logs.some((l) => l.includes(String(alt))));
  process.env.HTTP80 = '0';
  t.after(() => { delete process.env.HTTP80; });
  assert.strictEqual(wanted(3000), false);
  assert.strictEqual(wanted(80), false);
});

test('porta ocupada: avisa uma vez e segue', async (t) => {
  const { mirror, wanted } = require('../src/port80');
  if (!wanted(3000)) return t.skip('sem root');
  const busy = net.createServer(); await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const main = http.createServer((req, res) => res.end('ok'));
  const logs = [];
  const m = mirror(main, { port: busy.address().port, host: '127.0.0.1', mainPort: 3000, log: (l) => logs.push(l), retryMs: 50 });
  t.after(() => m.close());
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(logs.filter((l) => l.includes('indisponível')).length, 1);
});
