// Testes do cliente MQTT 3.1.1 e Home Assistant Auto-Discovery.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const mq = require('../src/mqtt');

// Decodifica pacotes MQTT 3.1.1 recebidos de um buffer TCP
function parseMqttPackets(buf) {
  const pkts = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) break;
    const header = buf[i];
    const type = header >> 4;
    const retain = (header & 0x01) === 1;
    let mult = 1, len = 0, idx = i + 1;
    let b;
    do {
      if (idx >= buf.length) return { pkts, rest: buf.slice(i) };
      b = buf[idx++];
      len += (b & 0x7f) * mult;
      mult *= 128;
    } while ((b & 0x80) !== 0);
    if (idx + len > buf.length) break;
    const body = buf.slice(idx, idx + len);
    i = idx + len;
    if (type === 1) {
      // CONNECT
      const protoLen = body.readUInt16BE(0);
      const proto = body.slice(2, 2 + protoLen).toString('utf8');
      const level = body[2 + protoLen];
      const flags = body[3 + protoLen];
      let p = 6 + protoLen;
      const readStr = () => { const l = body.readUInt16BE(p); p += 2; const s = body.slice(p, p + l).toString('utf8'); p += l; return s; };
      const clientId = readStr();
      const willTopic = (flags & 0x04) ? readStr() : null;
      const willPayload = (flags & 0x04) ? readStr() : null;
      const user = (flags & 0x80) ? readStr() : null;
      const pass = (flags & 0x40) ? readStr() : null;
      pkts.push({ type: 'CONNECT', proto, level, flags, clientId, willTopic, willPayload, user, pass });
    } else if (type === 3) {
      // PUBLISH (QoS 0)
      const tLen = body.readUInt16BE(0);
      const topic = body.slice(2, 2 + tLen).toString('utf8');
      const payload = body.slice(2 + tLen).toString('utf8');
      pkts.push({ type: 'PUBLISH', retain, topic, payload });
    } else if (type === 12) {
      pkts.push({ type: 'PINGREQ' });
    } else if (type === 14) {
      pkts.push({ type: 'DISCONNECT' });
    }
  }
  return { pkts, rest: buf.slice(i) };
}

test('parseBroker e cleanTopic validam URLs, hosts e prefixos', () => {
  assert.deepStrictEqual(mq.parseBroker('192.168.0.10'), { protocol: 'mqtt:', tls: false, host: '192.168.0.10', port: 1883, user: '', pass: '' });
  assert.deepStrictEqual(mq.parseBroker('mqtt://homeassistant.local:1883', 'miner', 's3cr3t'), {
    protocol: 'mqtt:', tls: false, host: 'homeassistant.local', port: 1883, user: 'miner', pass: 's3cr3t',
  });
  assert.deepStrictEqual(mq.parseBroker('mqtts://u:p@broker.example.com'), {
    protocol: 'mqtts:', tls: true, host: 'broker.example.com', port: 8883, user: 'u', pass: 'p',
  });
  assert.strictEqual(mq.parseBroker(''), null);
  assert.strictEqual(mq.parseBroker('http://192.168.0.10:1883'), null);
  assert.strictEqual(mq.parseBroker('mqtt://999.999.999.999'), null);
  assert.strictEqual(mq.parseBroker('mqtt://host/caminho'), null);
  assert.strictEqual(mq.parseBroker('mqtt://host:99999'), null);
  assert.strictEqual(mq.parseBroker('mqtt://host:0'), null);
  assert.strictEqual(mq.parseBroker(null), null);

  assert.strictEqual(mq.cleanTopic(''), 'homeminerproxy');
  assert.strictEqual(mq.cleanTopic('/fazenda/solo/'), 'fazenda/solo');
  assert.strictEqual(mq.cleanTopic('invalido#wild'), null);
  assert.strictEqual(mq.cleanTopic('invalido+wild'), null);
  assert.strictEqual(mq.cleanTopic('a/b/c/d/e'), null);
  assert.strictEqual(mq.cleanTopic('a'.repeat(60)), null);
});

test('codificação MQTT, Auto-Discovery e statePayload', () => {
  assert.deepStrictEqual([...mq.encodeVarInt(42)], [42]);
  assert.deepStrictEqual([...mq.encodeVarInt(321)], [0xc1, 0x02]);

  const cfgsPt = mq.discoveryConfigs('homeminerproxy', 'pt', 'BRL');
  assert.strictEqual(cfgsPt.length, 12);   // 11 sensores + 1 binary_sensor (pool_failover)
  const hrCfg = JSON.parse(cfgsPt.find((c) => c.topic.endsWith('/hashrate/config')).payload);
  assert.strictEqual(hrCfg.name, 'Hashrate da fazenda');
  assert.strictEqual(hrCfg.device.name, 'Fazenda de Mineração');
  const costCfg = JSON.parse(cfgsPt.find((c) => c.topic.endsWith('/cost_month/config')).payload);
  assert.strictEqual(costCfg.unit_of_measurement, 'BRL');

  const st = mq.statePayload({
    farm: {
      hashrate: 1.25e12, best: 9876.54321,
      shares: { today: 120, lastHour: 15 },
      workers: [
        { name: 'bitaxe', state: 'ok', hashRate: 1.25e12 },
        { name: 'nerdminer', state: 'stale', hashRate: 0 },
      ],
    },
    hall: [{ worker: 'bitaxe', value: 9876.54321 }],
    energy: { watts: 21.5, kwhMonth: 15.48, costMonth: 13.93, plug: { okAt: '2026-11-04T00:00:00Z', on: true, watts: 45.2, volts: 220.4 } },
    championship: { leader: { name: 'bitaxe', factor: 1.42 } },
    achievements: { unlocked: 4, total: 10 },
    proxy: { failover: [{ listen: 3333 }] },
    health: { tempC: 48.3 },
  });
  assert.strictEqual(st.hashrate, 1250000000000);
  assert.strictEqual(st.best_difficulty, 9876.5432);
  assert.strictEqual(st.best_worker, 'bitaxe');
  assert.strictEqual(st.workers_active, 1);
  assert.strictEqual(st.workers_stopped, 1);
  assert.strictEqual(st.weekly_leader, 'bitaxe');
  assert.strictEqual(st.weekly_leader_luck, 1.42);
  assert.strictEqual(st.achievements_unlocked, 4);
  assert.strictEqual(st.pool_failover, 'ON');
  assert.strictEqual(st.server_temp_c, 48.3);
  assert.strictEqual(st.plug_on, 'ON');
  assert.strictEqual(st.plug_watts, 45.2);
  assert.strictEqual(st.plug_volts, 220.4);
});

test('testBroker e start() conversam com um broker MQTT 3.1.1 real via TCP', async (t) => {
  const received = [];
  let connackCode = 0;

  const broker = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseMqttPackets(buf);
      buf = parsed.rest;
      for (const p of parsed.pkts) {
        received.push(p);
        if (p.type === 'CONNECT') {
          sock.write(Buffer.from([0x20, 0x02, 0x00, connackCode]));
        }
      }
    });
  });
  await new Promise((res) => broker.listen(0, '127.0.0.1', res));
  const port = broker.address().port;
  t.after(() => broker.close());

  // 1. testBroker com sucesso
  const okRes = await mq.testBroker(`mqtt://127.0.0.1:${port}`, 'usuario', 'senha123', 'fazenda');
  assert.deepStrictEqual(okRes, { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(received.some((p) => p.type === 'CONNECT' && p.user === 'usuario' && p.pass === 'senha123' && p.willTopic === 'fazenda/availability'));
  assert.ok(received.some((p) => p.type === 'PUBLISH' && p.topic === 'fazenda/availability' && p.payload === 'online' && p.retain === true));
  assert.ok(received.some((p) => p.type === 'DISCONNECT'));

  // 2. testBroker com erro de autenticação (CONNACK rc=4)
  connackCode = 4;
  const authRes = await mq.testBroker(`mqtt://127.0.0.1:${port}`, 'usuario', 'errada', 'fazenda');
  assert.deepStrictEqual(authRes, { ok: false, error: 'mqttauth' });

  // testBroker com erro rc=2, protocolo inválido, timeout e erro de conexão
  connackCode = 2;
  const rc2Res = await mq.testBroker(`mqtt://127.0.0.1:${port}`);
  assert.deepStrictEqual(rc2Res, { ok: false, error: 'CONNACK 2' });

  const deadRes = await mq.testBroker('mqtt://127.0.0.1:1');
  assert.strictEqual(deadRes.ok, false);

  const badBroker = net.createServer((sock) => {
    sock.write(Buffer.from([0x00, 0x00, 0x00, 0x00])); // byte 0 não é 0x20
  });
  await new Promise((res) => badBroker.listen(0, '127.0.0.1', res));
  const badProtoRes = await mq.testBroker(`mqtt://127.0.0.1:${badBroker.address().port}`);
  assert.deepStrictEqual(badProtoRes, { ok: false, error: 'protocol' });
  badBroker.close();

  const slowBroker = net.createServer(() => {});
  await new Promise((res) => slowBroker.listen(0, '127.0.0.1', res));
  const toRes = await mq.testBroker(`mqtt://127.0.0.1:${slowBroker.address().port}`, '', '', 'fazenda', 20);
  assert.deepStrictEqual(toRes, { ok: false, error: 'timeout' });
  slowBroker.close();

  // testBroker com host inválido
  assert.deepStrictEqual(await mq.testBroker(''), { ok: false, error: 'host' });

  // testBroker com TLS (mqtts://) em porta fechada
  const tlsRes = await mq.testBroker('mqtts://127.0.0.1:1');
  assert.strictEqual(tlsRes.ok, false);

  // 3. start() contínuo: publica Auto-Discovery, state, workers e eventos de transição
  connackCode = 0;
  received.length = 0;
  let currentSnap = {
    farm: {
      hasData: true, hashrate: 1.2e12, best: 1000,
      shares: { today: 10, lastHour: 2 },
      workers: [{ name: 'bitaxe', state: 'ok', hashRate: 1.2e12, bestDifficulty: 1000, pool: 'ckpool solo', viaProxy: true }],
    },
    hall: [{ worker: 'bitaxe', value: 1000 }],
    energy: {
      watts: 20, kwhMonth: 14.4, costMonth: 12.96,
      plugs: [{ name: 'Tomada 1', deviceId: 'eb123', okAt: '2026-11-04T00:00:00Z', on: true, watts: 15.5, volts: 220, currentMa: 70, kwhTotal: 1.2 }],
    },
    championship: { leader: { name: 'bitaxe', factor: 1.1 } },
    achievements: { unlocked: 1, total: 10, list: [{ id: 'first_share', unlocked: true, title: 'Primeira faísca', desc: '1 share' }] },
    proxy: { failover: [] },
    wallet: { confirmedSats: 0, pendingSats: 0 },
  };

  const client = mq.start({
    url: `mqtt://127.0.0.1:${port}`,
    user: 'miner',
    pass: 'pass',
    topic: 'homeminerproxy',
    lang: 'pt',
    currency: 'BRL',
    snapshot: () => currentSnap,
    everyMs: 60000,
    log: () => {},
  });
  t.after(() => client.stop());

  // espera receber o state inicial e os 12 pacotes de Auto-Discovery
  const waitUntil = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('timeout esperando pacotes MQTT');
  };

  await waitUntil(() => received.some((p) => p.type === 'PUBLISH' && p.topic === 'homeminerproxy/worker/bitaxe'));
  await waitUntil(() => received.some((p) => p.type === 'PUBLISH' && p.topic === 'homeminerproxy/plug/Tomada_1'));
  assert.strictEqual(received.filter((p) => p.type === 'PUBLISH' && p.topic.startsWith('homeassistant/')).length, 12);
  const stateMsg = JSON.parse(received.find((p) => p.type === 'PUBLISH' && p.topic === 'homeminerproxy/state').payload);
  assert.strictEqual(stateMsg.best_difficulty, 1000);
  assert.strictEqual(stateMsg.best_worker, 'bitaxe');

  // simula um novo recorde da fazenda + conquista desbloqueada e dispara tick()
  currentSnap = {
    ...currentSnap,
    farm: {
      ...currentSnap.farm,
      best: 50000,
      workers: [{ name: 'bitaxe', state: 'ok', hashRate: 1.2e12, bestDifficulty: 50000, pool: 'ckpool solo', viaProxy: true }],
    },
    hall: [{ worker: 'bitaxe', value: 50000 }],
    achievements: {
      unlocked: 2, total: 10,
      list: [
        { id: 'first_share', unlocked: true, title: 'Primeira faísca', desc: '1 share' },
        { id: 'diff_10k', unlocked: true, worker: 'bitaxe', title: ' Clube dos 10K', desc: 'Dificuldade >= 10K' },
      ],
    },
  };
  client.tick();

  await waitUntil(() => received.filter((p) => p.type === 'PUBLISH' && p.topic === 'homeminerproxy/event').length >= 2);
  const events = received.filter((p) => p.type === 'PUBLISH' && p.topic === 'homeminerproxy/event').map((p) => JSON.parse(p.payload));
  assert.ok(events.some((e) => e.type === 'farm_record'), 'publicou evento farm_record');
  assert.ok(events.some((e) => e.type === 'achievement_unlocked'), 'publicou evento achievement_unlocked');
  client.stop();

  // 4. start() recusado pelo broker (CONNACK code != 0) e reconexão
  const rejectBroker = net.createServer((sock) => {
    sock.on('data', () => {
      sock.write(Buffer.from([0x20, 0x02, 0x00, 0x05])); // código 5: não autorizado
      sock.destroy();
    });
  });
  await new Promise((res) => rejectBroker.listen(0, '127.0.0.1', res));
  t.after(() => rejectBroker.close());

  let logMsg = '';
  const rejectClient = mq.start({
    url: `mqtt://127.0.0.1:${rejectBroker.address().port}`,
    log: (m) => { logMsg += m; },
    reconnectMs: 50,
  });
  t.after(() => rejectClient.stop());
  await waitUntil(() => logMsg.includes('recusou'));
  rejectClient.stop();

  // 5. Casos de borda: start inválido, connectPacket e discovery em inglês
  assert.strictEqual(mq.start({ url: '' }), null);

  const pktWillRetain = mq.connectPacket({ willTopic: 't', willPayload: 'p', willRetain: true, user: 'u', pass: '' });
  assert.ok(pktWillRetain.length > 0);

  const enDiscov = mq.discoveryConfigs('homeminerproxy', 'en', 'USD');
  assert.strictEqual(enDiscov.length, 12);
  const esDiscov = mq.discoveryConfigs('homeminerproxy', 'es', 'EUR');
  assert.strictEqual(esDiscov.length, 12);

  // start com timeout de socket
  const hungBroker = net.createServer(() => {});
  await new Promise((res) => hungBroker.listen(0, '127.0.0.1', res));
  const hungClient = mq.start({
    url: `mqtt://127.0.0.1:${hungBroker.address().port}`,
    topic: '###invalido',
    timeoutMs: 15,
    pingMs: 15,
  });
  t.after(() => { hungClient.stop(); hungBroker.close(); });
  await new Promise((r) => setTimeout(r, 40));
  hungClient.stop();

  // statePayload vazio
  const emptyState = mq.statePayload(null);
  assert.strictEqual(emptyState.hashrate, 0);
  assert.strictEqual(emptyState.workers_active, 0);

  // pingPacket e disconnectPacket
  assert.deepStrictEqual(mq.pingPacket(), Buffer.from([0xc0, 0x00]));
  assert.deepStrictEqual(mq.disconnectPacket(), Buffer.from([0xe0, 0x00]));

  // publishPacket com Buffer
  const bufPkt = mq.publishPacket('topic', Buffer.from('payload'));
  assert.ok(bufPkt.length > 0);

  // encodeStr com null/vazio
  assert.ok(mq.encodeStr(null).length >= 2);

  // testBroker com tópico inválido que cai no fallback 'homeminerproxy'
  const defTopicRes = await mq.testBroker(`mqtt://127.0.0.1:${port}`, '', '', '###invalido');
  assert.strictEqual(defTopicRes.ok, true);

  // statePayload com plug desligado e plug sem watts/volts
  const offPlugsState = mq.statePayload({
    energy: { plugs: [{ okAt: '2026-11-04', on: false, watts: null, volts: null }] },
  });
  assert.strictEqual(offPlugsState.plug_on, 'OFF');
  assert.strictEqual(offPlugsState.plug_watts, null);
  assert.strictEqual(offPlugsState.plug_volts, null);

  // start() com snapshot lançando erro e com worker/plug sem nome
  let throwOnce = true;
  const snapThrowClient = mq.start({
    url: `mqtt://127.0.0.1:${port}`,
    snapshot: () => {
      if (throwOnce) { throwOnce = false; throw new Error('erro no snapshot'); }
      return {
        farm: {
          hasData: true,
          workers: [{ name: '', state: 'ok' }, { name: 'w1', state: 'ok' }],
        },
        energy: {
          plugs: [{ deviceId: 'eb123', name: '', okAt: '2026-11-04', on: false }],
        },
      };
    },
    everyMs: 60000,
  });
  t.after(() => snapThrowClient.stop());
  await new Promise((r) => setTimeout(r, 60));
  snapThrowClient.tick();
  await waitUntil(() => received.some((p) => p.type === 'PUBLISH' && p.topic.includes('eb123')));
  snapThrowClient.publish('manual/buffer', Buffer.from('test'));
  snapThrowClient.stop();
});
