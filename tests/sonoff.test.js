// Tomadas Sonoff (modo DIY / LAN): validação, cliente contra um Sonoff falso, painel e Telegram.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sonoff = require('../src/sonoff');
const { normalizePlugs } = require('../src/tuya');

// Sonoff falso: guarda as requisições e o estado do relé. v1 manda "data" como texto, v2 como objeto.
function fakeSonoff({ v1 = false, errorCode = 0 } = {}) {
  const calls = [];
  let state = 'on';
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      calls.push({ path: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (errorCode) return res.end(JSON.stringify({ seq: 1, error: errorCode }));
      if (req.url === '/zeroconf/switch') { state = body.data.switch; return res.end(JSON.stringify({ seq: 2, error: 0 })); }
      if (req.url === '/zeroconf/info') {
        const data = { switch: state, startup: 'off', ssid: 'casa', bssid: 'x', signalStrength: -50 };
        return res.end(JSON.stringify({ seq: 3, error: 0, data: v1 ? JSON.stringify(data) : data }));
      }
      res.end(JSON.stringify({ seq: 4, error: 404 }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, state: () => state, host: `127.0.0.1:${server.address().port}` })));
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

test('IP do Sonoff e lista de tomadas com tipo', () => {
  for (const ok of ['192.168.0.50', '192.168.0.50:8081', 'sonoff-quarto.local']) assert.ok(sonoff.validHost(ok), ok);
  for (const bad of ['192.168.0.999', 'http://x', 'a b', '', '1.2.3']) assert.ok(!sonoff.validHost(bad), bad);
  const r = normalizePlugs([
    { type: 'sonoff', host: '192.168.0.50', worker: 'devkit', watchdogMin: 15 },
    { type: 'sonoff', host: '192.168.0.51', deviceId: '1000abcdef' },   // Device ID real informado
    { deviceId: 'eb49d08081c5ba5e80ackt', worker: 'bitaxe' },          // Tuya continua igual
    { type: 'sonoff', host: '' },                                        // linha vazia: ignora
  ]);
  assert.deepStrictEqual(r.list, [
    { name: 'devkit', type: 'sonoff', host: '192.168.0.50', deviceId: 'sonoff_192_168_0_50', worker: 'devkit', watchdogMin: 15 },
    { name: 'Tomada 2', type: 'sonoff', host: '192.168.0.51', deviceId: '1000abcdef', worker: '', watchdogMin: 0 },
    { name: 'bitaxe', deviceId: 'eb49d08081c5ba5e80ackt', worker: 'bitaxe', watchdogMin: 0 },
  ]);
  assert.strictEqual(normalizePlugs([{ type: 'sonoff', host: '192.168.0.999' }]).error, 'host');
  // salvar de novo (o id sintético volta do navegador) dá o mesmo resultado
  assert.deepStrictEqual(normalizePlugs(r.list).list, r.list);
});

test('cliente DIY: liga, desliga, lê o estado (v1 e v2) e traduz erros', async (t) => {
  for (const v1 of [false, true]) {
    const s = await fakeSonoff({ v1 });
    t.after(() => s.server.close());
    const plug = { type: 'sonoff', host: s.host, deviceId: sonoff.syntheticId(s.host) };
    const c = sonoff.createClient({ plugs: [plug] });
    assert.deepStrictEqual(await c.setSwitch(false, plug.deviceId), { ok: true, on: false });
    assert.deepStrictEqual(s.calls[0], { path: '/zeroconf/switch', body: { deviceid: '', data: { switch: 'off' } } });   // id sintético não vai
    const st = await c.getStatus(plug.deviceId);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.status.on, false);
    assert.strictEqual(st.status.watts, null);
    const rb = await c.powerCycle(10, plug.deviceId);
    assert.ok(rb.ok && rb.rebootedAt);
    assert.strictEqual(s.state(), 'on');
  }
  const real = await fakeSonoff();
  t.after(() => real.server.close());
  const withId = { type: 'sonoff', host: real.host, deviceId: '1000abcdef' };
  await sonoff.createClient({ plugs: [withId] }).setSwitch(true, withId.deviceId);
  assert.strictEqual(real.calls[0].body.deviceid, '1000abcdef');

  const lanOff = await fakeSonoff({ errorCode: 401 });
  t.after(() => lanOff.server.close());
  assert.deepStrictEqual(await sonoff.testSonoff(lanOff.host), { ok: false, error: 'sonofflan' });
  const port = await freePort();
  assert.deepStrictEqual(await sonoff.testSonoff('127.0.0.1:' + port, '', 1500), { ok: false, error: 'sonoffoffline' });
  assert.deepStrictEqual(await sonoff.testSonoff('192.168.0.999'), { ok: false, error: 'host' });
});

const req = (port, method, url, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('error', rej); r.end(data);
});
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) { /* subindo */ } if (Date.now() > end) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 100)); } };

test('painel: lê e controla o Sonoff, e não desliga a tomada do próprio servidor', async (t) => {
  const devkit = await fakeSonoff(), odroid = await fakeSonoff();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoff-'));
  const plugs = [
    { type: 'sonoff', host: devkit.host, worker: 'devkit' },
    { type: 'sonoff', host: odroid.host, worker: 'odroid' },
  ];
  const p = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/offline.js'), path.join(__dirname, '../src/painel.js')], {
    env: { ...process.env, BTC_ADDRESS: 'bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w', PORT: String(port), DATA_DIR: dir, PROXY_URL: '', ALARM_PORT: path.join(dir, 'x'),
      CKPOOL_URLS: '', OCEAN_API: '', SETTINGS_PIN: '424242', LOCAL_WORKER: 'odroid', TUYA_PLUGS: JSON.stringify(plugs), TUYA_CLIENT_ID: '', TUYA_SECRET: '' },
    stdio: 'ignore',
  });
  t.after(() => { p.kill(); devkit.server.close(); odroid.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // a leitura do estado aparece no painel sem credenciais da Tuya
  const en = await waitFor(async () => { const j = JSON.parse((await req(port, 'GET', '/api/mining')).body); return j.energy.plugs.length === 2 && j.energy.plugs.every((x) => x.okAt) && j.energy; });
  assert.deepStrictEqual(en.plugs.map((x) => [x.worker, x.on]), [['devkit', true], ['odroid', true]]);

  const devId = en.plugs[0].deviceId, selfId = en.plugs[1].deviceId;
  let r = await req(port, 'POST', '/api/plug', { pin: '424242', deviceId: devId, action: 'off' });
  assert.deepStrictEqual(JSON.parse(r.body), { ok: true, on: false });
  assert.strictEqual(devkit.state(), 'off');
  r = await req(port, 'POST', '/api/plug', { pin: '424242', deviceId: devId, action: 'on' });
  assert.strictEqual(devkit.state(), 'on');

  r = await req(port, 'POST', '/api/plug', { pin: '424242', deviceId: selfId, action: 'off' });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(JSON.parse(r.body).error, 'selfplug');
  r = await req(port, 'POST', '/api/plug', { pin: '424242', deviceId: selfId, action: 'reboot' });
  assert.strictEqual(JSON.parse(r.body).error, 'selfplug');
  assert.ok(!odroid.calls.some((c) => c.path === '/zeroconf/switch'));   // nunca mandou desligar o servidor
  assert.strictEqual((await req(port, 'POST', '/api/plug', { pin: '1', deviceId: devId, action: 'off' })).status, 403);
});
