// O painel sobe sem internet, serve a página e as APIs, e recusa subir sem endereço.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PAINEL = path.join(__dirname, '../src/painel.js');
const OFFLINE = path.join(__dirname, 'helpers/offline.js');

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
const post = (url, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const u = new URL(url); const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b || '{}') })); }); req.on('error', rej); req.write(d); req.end(); });
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) { /* tenta de novo */ } if (Date.now() > end) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 100)); } };

test('sem BTC_ADDRESS o painel não sobe', () => {
  const env = { ...process.env }; delete env.BTC_ADDRESS;
  const r = spawnSync(process.execPath, ['-r', OFFLINE, PAINEL], { env, encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /BTC_ADDRESS/);
});

test('painel serve a página e as APIs sem internet', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-'));
  fs.writeFileSync(path.join(dir, 'workers.json'), JSON.stringify({ vovo: { name: 'vovo', hashRate: 3.5e5, bestDifficulty: 38.76, lastSeen: new Date().toISOString(), pool: 'nerdminers' } }));
  const p = spawn(process.execPath, ['-r', OFFLINE, PAINEL], {
    env: { ...process.env, BTC_ADDRESS: 'bc1qteste', PORT: String(port), DATA_DIR: dir, PROXY_URL: '', ALARM_PORT: path.join(dir, 'sem-sirene'), CKPOOL_URLS: '', OCEAN_API: '', SETTINGS_PIN: '123456' },
    stdio: 'ignore',
  });
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const page = await waitFor(() => get(`http://127.0.0.1:${port}/?lang=pt`));
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Fazenda de/);
  assert.match(page.body, /Quase bloco/);

  const api = JSON.parse((await get(`http://127.0.0.1:${port}/api/mining`)).body);
  assert.ok(api.farm, 'sem farm');
  const vovo = api.farm.workers.find((w) => w.name === 'vovo');
  assert.ok(vovo, 'worker salvo não apareceu');
  assert.strictEqual(vovo.bestDifficulty, 38.76);
  assert.ok(api.hall.some((r) => r.value === 38.76), 'recorde não entrou no hall da fama');

  const widget = JSON.parse((await get(`http://127.0.0.1:${port}/api/widget?lang=pt`)).body);
  assert.strictEqual(widget.recorde, '38,76');
  const widgetEn = JSON.parse((await get(`http://127.0.0.1:${port}/api/widget?lang=en`)).body);
  assert.strictEqual(widgetEn.recorde, '38.76');

  const en = await get(`http://127.0.0.1:${port}/?lang=en`);
  assert.match(en.body, /<html lang="en">/);
  assert.match(en.body, /Almost a block/);
  assert.match(en.body, /const LOC = 'en-US', CUR = 'USD';/);

  const plugBadPin = await post(`http://127.0.0.1:${port}/api/plug`, { pin: '000000', action: 'on' });
  assert.strictEqual(plugBadPin.status, 403);
  assert.strictEqual(plugBadPin.body.error, 'wrong');

  const plugUnconfigured = await post(`http://127.0.0.1:${port}/api/plug`, { pin: '123456', action: 'on' });
  assert.strictEqual(plugUnconfigured.status, 404);
  assert.strictEqual(plugUnconfigured.body.ok, false);
});

test('conta de luz: moeda e preço do kWh configuráveis', async (t) => {
  const run = async (extra) => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-'));
    const p = spawn(process.execPath, ['-r', OFFLINE, PAINEL], {
      env: { ...process.env, BTC_ADDRESS: 'bc1qteste', PORT: String(port), DATA_DIR: dir, PROXY_URL: '', ALARM_PORT: path.join(dir, 'x'), CKPOOL_URLS: '', OCEAN_API: '', LANGUAGE: '', CURRENCY: '', POWER_PRICE_KWH: '', TARIFA_KWH: '', ...extra },
      stdio: 'ignore',
    });
    t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
    const api = JSON.parse((await waitFor(() => get(`http://127.0.0.1:${port}/api/mining`))).body);
    const page = (await get(`http://127.0.0.1:${port}/?lang=en`)).body;
    return { tarifa: api.energy.tarifa, cur: (page.match(/CUR = '(\w+)'/) || [])[1] };
  };
  assert.deepStrictEqual(await run({}), { tarifa: 0.15, cur: 'USD' });
  assert.deepStrictEqual(await run({ LANGUAGE: 'pt-BR' }), { tarifa: 0.9, cur: 'BRL' });
  assert.deepStrictEqual(await run({ CURRENCY: 'brl', POWER_PRICE_KWH: '1.05' }), { tarifa: 1.05, cur: 'BRL' });
  assert.deepStrictEqual(await run({ CURRENCY: 'USD', TARIFA_KWH: '0.22' }), { tarifa: 0.22, cur: 'USD' });   // nome antigo continua valendo
});
