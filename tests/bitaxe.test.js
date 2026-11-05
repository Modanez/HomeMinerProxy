// Bitaxe pela API do AxeOS: lista, normalização (2.14 e 2.15), leitura de um Bitaxe falso, descoberta,
// MQTT e /status do Telegram.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const bx = require('../src/bitaxe');
const fx = (v) => require(path.join(__dirname, 'fixtures', `bitaxe-${v}.json`));

test('lista nome=IP: só rede de casa, sem repetidos', () => {
  assert.deepStrictEqual(bx.parseList(''), []);
  assert.deepStrictEqual(bx.parseList('bitaxe1=192.168.0.140, bitaxe2 = 192.168.0.141'), [{ name: 'bitaxe1', host: '192.168.0.140' }, { name: 'bitaxe2', host: '192.168.0.141' }]);
  assert.deepStrictEqual(bx.parseList('gamma=bitaxe.local; b=10.0.0.9'), [{ name: 'gamma', host: 'bitaxe.local' }, { name: 'b', host: '10.0.0.9' }]);
  for (const bad of ['bitaxe1=8.8.8.8', 'bitaxe1=127.0.0.1', 'bitaxe1', 'a b=192.168.0.2', 'x=192.168.0.2, x=192.168.0.3', 'x=192.168.0.2, y=192.168.0.2', 'x=http://192.168.0.2', 'x=172.32.0.1']) {
    assert.strictEqual(bx.parseList(bad), null, bad);
  }
  assert.ok(bx.isPrivateHost('172.20.1.1') && !bx.isPrivateHost('evil.com'));
});

test('dificuldade com sufixo ou número', () => {
  assert.strictEqual(bx.parseDiff('4.29G'), 4.29e9);
  assert.strictEqual(bx.parseDiff('12.3M'), 12.3e6);
  assert.strictEqual(bx.parseDiff(812000), 812000);
  assert.strictEqual(bx.parseDiff('abc'), null);
});

test('normaliza o /api/system/info da 2.14 (campos stratum*)', () => {
  const d = bx.normalize(fx('2.14'));
  assert.strictEqual(d.model, 'BM1370');
  assert.strictEqual(d.version, 'v2.14.2');
  assert.strictEqual(d.hashRate10m, 1188.4e9);
  assert.strictEqual(d.expected, 1200e9);
  assert.strictEqual(d.tempC, 61.5);
  assert.strictEqual(d.vrTempC, 52);
  assert.strictEqual(d.watts, 17.82);
  assert.strictEqual(d.volts, 5.1);
  assert.ok(Math.abs(d.jth - 17.82 / 1.1953) < 1e-9);
  assert.strictEqual(d.coreMv, 1144);
  assert.strictEqual(d.bestDiff, 4.29e9);
  assert.strictEqual(d.bestSessionDiff, 12.3e6);
  assert.deepStrictEqual(d.pool, { url: '192.168.0.134', port: 3338, fallback: false });
  assert.strictEqual(d.worker, 'bitaxe1');
  assert.strictEqual(d.fanRpm, 4100);
  assert.strictEqual(d.autoFan, true);
  assert.strictEqual(d.paused, false);
});

test('normaliza a 2.15 (lista "pools") e a reserva em uso', () => {
  const d = bx.normalize(fx('2.15'));
  assert.deepStrictEqual(d.pool, { url: 'solo.ckpool.org', port: 3333, fallback: true });
  assert.strictEqual(d.worker, 'bitaxe2');
  assert.strictEqual(d.vrTempC, null);   // 0 = sem sensor
  assert.strictEqual(d.bestDiff, 4.29e9);
  assert.strictEqual(d.coreMv, 1150);
  assert.strictEqual(bx.normalize(null), null);
  const empty = bx.normalize({});
  assert.strictEqual(empty.hashRate, null);
  assert.strictEqual(empty.worker, null);
});

function fakeBitaxe(t, body) {
  return new Promise((resolve) => {
    let reply = body;
    const server = http.createServer((req, res) => {
      if (req.url !== '/api/system/info') { res.writeHead(404); return res.end(); }
      if (reply === 'hang') return;   // não responde: timeout
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
    });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ host: `127.0.0.1:${server.address().port}`, set: (b) => { reply = b; }, server });
    });
  });
}

test('lê um Bitaxe falso; recusa JSON que não é Bitaxe; loopback só com a variável de teste', async (t) => {
  const f = await fakeBitaxe(t, fx('2.14'));
  assert.deepStrictEqual(await bx.info(f.host), { ok: false, error: 'host' });   // sem BITAXE_ALLOW_LOOPBACK
  process.env.BITAXE_ALLOW_LOOPBACK = '1';
  t.after(() => { delete process.env.BITAXE_ALLOW_LOOPBACK; });
  const r = await bx.info(f.host);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.worker, 'bitaxe1');
  f.set({ hello: 'world' });
  assert.deepStrictEqual(await bx.info(f.host), { ok: false, error: 'notbitaxe' });
  f.set('not json');
  assert.deepStrictEqual(await bx.info(f.host), { ok: false, error: 'json' });
  f.set('hang');
  assert.deepStrictEqual(await bx.info(f.host, 300), { ok: false, error: 'timeout' });
  f.server.close();
  assert.deepStrictEqual(await bx.info(f.host, 300), { ok: false, error: 'offline' });
});

test('descoberta: varre a /24 do servidor e devolve só quem responde como Bitaxe', async () => {
  const seen = [];
  const probe = async (h) => { seen.push(h); return h === '192.168.0.140' || h === '192.168.0.141' ? { ok: true, data: bx.normalize(fx(h.endsWith('140') ? '2.14' : '2.15')) } : { ok: false }; };
  const found = await bx.discover(['192.168.0.134', '8.8.8.8', 'fe80::1'], { probe, concurrency: 8 });
  assert.strictEqual(seen.length, 253);   // 254 da sub-rede menos o próprio servidor
  assert.ok(!seen.includes('192.168.0.134'));
  assert.deepStrictEqual(found.map((f) => [f.host, f.worker, f.model]), [['192.168.0.140', 'bitaxe1', 'BM1370'], ['192.168.0.141', 'bitaxe2', 'BM1370']]);
});

test('MQTT: sensores por Bitaxe no discovery e no estado', () => {
  const mqtt = require('../src/mqtt');
  const cfgs = mqtt.discoveryConfigs('homeminerproxy', 'pt', 'BRL', ['bitaxe1']);
  const temp = cfgs.find((c) => c.topic === 'homeassistant/sensor/homeminerproxy/bitaxe_bitaxe1_temp/config');
  assert.ok(temp);
  const p = JSON.parse(temp.payload);
  assert.strictEqual(p.name, 'bitaxe1 temperatura do chip');
  assert.strictEqual(p.device_class, 'temperature');
  assert.match(p.value_template, /value_json\.bitaxes\.bitaxe1\.temp/);
  const d = bx.normalize(fx('2.14'));
  const st = mqtt.statePayload({ farm: {}, bitaxes: [{ name: 'bitaxe1', fresh: true, data: d }, { name: 'bitaxe2', fresh: false, data: null }] });
  assert.deepStrictEqual(st.bitaxes.bitaxe1, { hashrate: 1188400000000, temp: 61.5, power: 17.8, fan: 55, online: 'ON' });
  assert.strictEqual(st.bitaxes.bitaxe2.online, 'OFF');
  assert.strictEqual(mqtt.statePayload({ farm: {} }).bitaxes, undefined);
});

test('Telegram /status: uma linha por Bitaxe, e aviso quando não responde', () => {
  const tg = require('../src/telegram');
  const d = bx.normalize(fx('2.15'));
  const txt = tg.statusText({ farm: { hasData: true, hashrate: 2.3e12, workers: [], shares: { today: 10 } },
    bitaxes: [{ name: 'bitaxe2', fresh: true, data: d }, { name: 'bitaxe1', fresh: false, data: null }] }, { lang: 'pt' });
  assert.match(txt, /🟧 <b>bitaxe2<\/b> · 1,17 TH\/s · 69 °C · 18,4 W · na reserva/);
  assert.match(txt, /bitaxe1: o Bitaxe não responde/);
});
