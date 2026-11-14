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
  assert.deepStrictEqual(st.bitaxes.bitaxe1, { hashrate: 1188400000000, temp: 61.5, power: 17.8, fan: 55, online: 'ON',
    alert_offline: 'OFF', alert_hot: 'OFF', alert_vrhot: 'OFF', alert_lowhash: 'OFF', alert_fallback: 'OFF', alert_fault: 'OFF' });
  const hot = mqtt.statePayload({ farm: {}, bitaxes: [{ name: 'bitaxe1', fresh: true, data: d, alerts: { hot: { tempC: 70, max: 68 } } }] });
  assert.strictEqual(hot.bitaxes.bitaxe1.alert_hot, 'ON');
  const bin = cfgs.find((c) => c.topic === 'homeassistant/binary_sensor/homeminerproxy/bitaxe_bitaxe1_hot/config');
  assert.strictEqual(JSON.parse(bin.payload).device_class, 'heat');
  assert.strictEqual(JSON.parse(bin.payload).name, 'bitaxe1 chip quente');
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

// ---------------------------------------------------------------- fase 2: alertas
const read = (over = {}) => ({ ok: true, data: { ...bx.normalize(fx('2.14')), ...over } });

test('alertas: temperatura só com 2 leituras seguidas acima do limite; volta ao normal', () => {
  let s = bx.evaluate(null, read({ tempC: 70 }), {}, 0);
  assert.deepStrictEqual(s.active, {});                       // uma leitura: ainda não
  s = bx.evaluate(s, read({ tempC: 71 }), {}, 30e3);
  assert.deepStrictEqual(s.active.hot, { tempC: 71, max: 68 });
  s = bx.evaluate(s, read({ tempC: 60 }), {}, 60e3);
  assert.ok(!s.active.hot);
  s = bx.evaluate(bx.evaluate(null, read({ tempC: 62 }), { tempMax: 60 }), read({ tempC: 62 }), { tempMax: 60 });
  assert.strictEqual(s.active.hot.max, 60);                   // limite configurado
  // regulador a 82 °C é normal no Gamma (caso real do primeiro Bitaxe do Paulo): sem alerta
  s = bx.evaluate(bx.evaluate(null, read({ vrTempC: 82 })), read({ vrTempC: 82 }));
  assert.ok(!s.active.vrhot);
  s = bx.evaluate(bx.evaluate(null, read({ vrTempC: 98 })), read({ vrTempC: 98 }));
  assert.deepStrictEqual(s.active.vrhot, { tempC: 98, max: 95 });
});

test('alertas: hashrate baixo só depois de 10 min, fora do aquecimento e sem pausa', () => {
  const low = { hashRate10m: 600e9, expected: 1200e9, uptimeS: 7200 };
  let s = bx.evaluate(null, read(low), {}, 0);
  s = bx.evaluate(s, read(low), {}, 9 * 60e3);
  assert.ok(!s.active.lowhash);
  s = bx.evaluate(s, read(low), {}, 10 * 60e3);
  assert.deepStrictEqual(s.active.lowhash, { hashRate: 600e9, expected: 1200e9, pct: 50 });
  s = bx.evaluate(s, read({ ...low, hashRate10m: 1150e9 }), {}, 11 * 60e3);
  assert.ok(!s.active.lowhash && s.lowSince === null);
  let w = bx.evaluate(null, read({ ...low, uptimeS: 300 }), {}, 0);   // acabou de ligar
  w = bx.evaluate(w, read({ ...low, uptimeS: 900 - 1 }), {}, 20 * 60e3);
  assert.ok(!w.active.lowhash);
  let p = bx.evaluate(null, read({ ...low, paused: true }), {}, 0);
  p = bx.evaluate(p, read({ ...low, paused: true }), {}, 20 * 60e3);
  assert.ok(!p.active.lowhash);
});

test('alertas: sem resposta na 3ª falha; reserva, falhas, reinício e bloco', () => {
  let s = bx.evaluate(null, read(), {}, 0);
  s = bx.evaluate(s, { ok: false, error: 'timeout' }); s = bx.evaluate(s, { ok: false, error: 'timeout' });
  assert.ok(!s.active.offline);
  s = bx.evaluate(s, { ok: false, error: 'offline' });
  assert.deepStrictEqual(s.active, { offline: { error: 'offline' } });
  s = bx.evaluate(s, read({ uptimeS: 40, resetReason: 'Brownout reset' }));   // voltou, e reiniciou
  assert.deepStrictEqual(s.active, {});
  assert.strictEqual(s.reboots, 1);
  assert.strictEqual(s.lastReset, 'Brownout reset');
  s = bx.evaluate(s, read({ uptimeS: 70, pool: { url: 'solo.ckpool.org', port: 3333, fallback: true }, powerFault: true }));
  assert.deepStrictEqual(s.active.fallback, { url: 'solo.ckpool.org', port: 3333 });
  assert.deepStrictEqual(s.active.fault, { power: true, hardware: false, overheat: false });
  assert.strictEqual(s.reboots, 1);
  s = bx.evaluate(s, read({ uptimeS: 100, blockFound: true }));
  s = bx.evaluate(s, read({ uptimeS: 130, blockFound: true }));
  assert.strictEqual(s.blocks, 1);                              // conta uma vez
});

test('Telegram: avisa quando o alerta começa e quando termina; ALARM_IGNORE silencia; bloco sempre', () => {
  const tg = require('../src/telegram');
  const base = (alerts, extra = {}) => tg.digest({ farm: { hasData: true, workers: [] }, bitaxes: [{ name: 'bitaxe1', worker: 'bitaxe1', alerts, reboots: 0, blocks: 0,
    data: { tempC: 59.2, hashRate10m: 1.19e12 }, ...extra }] });
  const ev = (a, b, o = {}) => tg.diffEvents(a, b, { lang: 'pt', ...o }).map((e) => e.text);
  const on = ev(base({}), base({ hot: { tempC: 70.4, max: 68 }, lowhash: { hashRate: 6e11, expected: 1.2e12, pct: 50 }, fallback: { url: 'solo.ckpool.org', port: 3333 } }));
  assert.deepStrictEqual(on, ['🌡️ <b>bitaxe1</b>: chip a <b>70,4 °C</b> (limite 68 °C)', '📉 <b>bitaxe1</b>: hashrate em <b>600 GH/s</b>, 50% do esperado (1,2 TH/s), há 10 min',
    '🔀 <b>bitaxe1</b> está na pool reserva (solo.ckpool.org:3333)']);
  const off = ev(base({ hot: { tempC: 70.4, max: 68 } }), base({}));
  assert.deepStrictEqual(off, ['✅ <b>bitaxe1</b>: chip de volta a 59,2 °C']);
  assert.deepStrictEqual(ev(base({}), base({ offline: {} }), { ignore: ['bitaxe1'] }), []);
  assert.match(ev(base({}), base({}, { blocks: 1 }), { ignore: ['bitaxe1'] })[0], /ENCONTROU UM BLOCO/);
  assert.deepStrictEqual(ev(base({}), base({}, { reboots: 1, lastReset: 'Brownout reset' })), ['🔄 <b>bitaxe1</b> reiniciou sozinho (Brownout reset)']);
  assert.deepStrictEqual(ev(base({}), base({ fault: { power: true, hardware: false, overheat: true } })), ['⚠️ <b>bitaxe1</b>: falha de energia (confira a fonte) · superaquecido: o AxeOS baixou a frequência']);
  assert.deepStrictEqual(ev(null, base({ hot: { tempC: 70, max: 68 } })), []);   // primeira olhada não avisa
});

// ---------------------------------------------------------------- fase 3: ações
test('fan: só faixas seguras', () => {
  assert.deepStrictEqual(bx.fanPatch({ auto: true, temptarget: 60 }), { autofanspeed: 1, temptarget: 60 });
  assert.deepStrictEqual(bx.fanPatch({ auto: false, fanspeed: 75 }), { autofanspeed: 0, fanspeed: 75 });
  for (const bad of [{ auto: true, temptarget: 80 }, { auto: true, temptarget: 45 }, { auto: false, fanspeed: 10 }, { auto: false, fanspeed: 101 }, { auto: false, fanspeed: 'x' }, {}]) {
    assert.strictEqual(bx.fanPatch(bad), null, JSON.stringify(bad));
  }
});

test('pool: grava no formato da versão (2.14 stratum*, 2.15 lista pools) e confere na releitura', () => {
  const main = { url: '192.168.0.134', port: 3338, user: 'bc1q.bitaxe1' }, backup = { url: 'solo.ckpool.org', port: 3333, user: 'bc1q.bitaxe1' };
  const p14 = bx.poolPatch(fx('2.14'), main, backup);
  assert.deepStrictEqual(p14, { stratumURL: '192.168.0.134', stratumPort: 3338, stratumUser: 'bc1q.bitaxe1', stratumPassword: 'x',
    fallbackStratumURL: 'solo.ckpool.org', fallbackStratumPort: 3333, fallbackStratumUser: 'bc1q.bitaxe1', fallbackStratumPassword: 'x' });
  assert.ok(bx.poolMatches({ ...fx('2.14'), ...p14 }, main));
  assert.ok(!bx.poolMatches(fx('2.14'), main));
  const p15 = bx.poolPatch(fx('2.15'), main, backup);
  assert.deepStrictEqual(p15.pools, [{ url: '192.168.0.134', port: 3338, user: 'bc1q.bitaxe1', password: 'x' }, { url: 'solo.ckpool.org', port: 3333, user: 'bc1q.bitaxe1', password: 'x' }]);
  assert.ok(bx.poolMatches({ ...fx('2.15'), ...p15 }, main));
});

test('ações: método e caminho certos; 404 = sem suporte; restart que derruba a conexão conta como feito', async (t) => {
  process.env.BITAXE_ALLOW_LOOPBACK = '1';
  t.after(() => { delete process.env.BITAXE_ALLOW_LOOPBACK; });
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls.push([req.method, req.url, b]);
      if (req.url === '/api/system/identify') { res.writeHead(404); return res.end(); }
      if (req.url === '/api/system/restart') return req.socket.destroy();
      res.writeHead(200); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `127.0.0.1:${server.address().port}`;
  assert.deepStrictEqual(await bx.simpleAction(host, 'pause'), { ok: true });
  assert.deepStrictEqual(await bx.simpleAction(host, 'identify'), { ok: false, error: 'unsupported' });
  assert.deepStrictEqual(await bx.simpleAction(host, 'restart'), { ok: true });
  assert.deepStrictEqual(await bx.simpleAction(host, 'frequency'), { ok: false, error: 'action' });   // fora da lista
  assert.deepStrictEqual(await bx.patch(host, { autofanspeed: 1, temptarget: 60 }), { ok: true });
  assert.deepStrictEqual(calls.map((c) => c.slice(0, 2)), [['POST', '/api/system/pause'], ['POST', '/api/system/identify'], ['POST', '/api/system/restart'], ['PATCH', '/api/system']]);
  assert.deepStrictEqual(JSON.parse(calls[3][2]), { autofanspeed: 1, temptarget: 60 });
});

test('reinício pedido pelo painel não vira "reiniciou sozinho"', () => {
  let s = bx.evaluate(null, read({ uptimeS: 5000 }), {}, 0);
  s = { ...s, expectRebootUntil: 60e3 };
  s = bx.evaluate(s, read({ uptimeS: 20 }), {}, 30e3);
  assert.strictEqual(s.reboots, 0);
  assert.strictEqual(s.expectRebootUntil, null);
  s = bx.evaluate(s, read({ uptimeS: 10 }), {}, 90e3);   // o próximo, sem pedir, conta
  assert.strictEqual(s.reboots, 1);
});

test('°F: Telegram mostra temperaturas e limites em Fahrenheit', () => {
  const tg = require('../src/telegram');
  const base = (alerts) => tg.digest({ farm: { hasData: true, workers: [] }, bitaxes: [{ name: 'bitaxe1', worker: 'bitaxe1', alerts, reboots: 0, blocks: 0, data: { tempC: 59.2 } }] });
  const on = tg.diffEvents(base({}), base({ hot: { tempC: 70.4, max: 68 } }), { lang: 'en', tempUnit: 'F' }).map((e) => e.text);
  assert.deepStrictEqual(on, ['🌡️ <b>bitaxe1</b>: chip at <b>158.7 °F</b> (limit 154 °F)']);
  const off = tg.diffEvents(base({ hot: { tempC: 70.4, max: 68 } }), base({}), { lang: 'pt', tempUnit: 'F' }).map((e) => e.text);
  assert.deepStrictEqual(off, ['✅ <b>bitaxe1</b>: chip de volta a 138,6 °F']);
  const txt = tg.statusText({ farm: { hasData: true, hashrate: 1e12, workers: [], shares: { today: 1 } }, bitaxes: [{ name: 'bitaxe1', fresh: true, data: bx.normalize(fx('2.14')) }] }, { lang: 'en', tempUnit: 'F' });
  assert.match(txt, /143 °F/);   // 61,5 °C
});

test('worker do Bitaxe em SOLO Group: sem o #grupo (e sem o .hidden)', () => {
  const d = (stratumUser) => bx.normalize({ stratumUser, hashRate: 1200 }).worker;
  assert.strictEqual(d('bc1qx.bitaxe1#firstblock'), 'bitaxe1');
  assert.strictEqual(d('bc1qx.bitaxe2#minhaturma.hidden'), 'bitaxe2');
  assert.strictEqual(d('bc1qx.bitaxe3'), 'bitaxe3');
});

test('IP do AxeOS para o link (ipv4 válido; senão nada)', () => {
  assert.strictEqual(bx.normalize({ ipv4: '192.168.0.138' }).ip, '192.168.0.138');
  assert.strictEqual(bx.normalize({ ipv4: '<script>' }).ip, null);
  assert.strictEqual(bx.normalize({}).ip, null);
});

test('scoreboard do AxeOS: top 20 em ordem, "since" vira horário, texto com sufixo', () => {
  const now = 1_800_000_000_000;
  const raw = [{ rank: 2, since: 60, difficulty: 15279226 }, { rank: 1, since: 3600, difficulty: '338.99M' }, { rank: 3, since: 10, difficulty: 0 }];
  const l = bx.normalizeScoreboard(raw, now);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].rank, 1);
  assert.ok(Math.abs(l[0].diff - 338.99e6) < 1e3);
  assert.strictEqual(l[0].at, now - 3600e3);
  assert.strictEqual(l[1].diff, 15279226);
  assert.strictEqual(bx.normalizeScoreboard({ nope: 1 }), null);
  assert.strictEqual(bx.normalizeScoreboard(Array.from({ length: 30 }, (_, i) => ({ difficulty: i + 1, since: 1 }))).length, 20);
});
