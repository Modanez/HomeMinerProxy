// Testes unitários para src/painel.js: cobre todas as funções puras, coletas e handlers HTTP
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.BTC_ADDRESS = 'bc1qtestaddress1234567890';
const painel = require('../src/painel');

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

test('hashDiff: converte hex de hash em dificuldade proporcional', () => {
  const d = painel.hashDiff('00000000000000000000' + '11'.repeat(22));
  assert.ok(typeof d === 'number' && d > 0);
  assert.strictEqual(painel.hashDiff('invalido-hex-zzz'), null);
  assert.strictEqual(painel.hashDiff('0'), null);
});

test('safeJson: trata strings válidas, inválidas e vazias', () => {
  assert.deepStrictEqual(painel.safeJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(painel.safeJson('invalido'), {});
  assert.deepStrictEqual(painel.safeJson(''), {});
  assert.deepStrictEqual(painel.safeJson(null), {});
});

test('loadJson e saveJson: manipulação segura de arquivos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-json-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    painel.saveJson('teste.json', { ok: true, num: 42 });
    assert.deepStrictEqual(painel.loadJson('teste.json', {}), { ok: true, num: 42 });
    assert.deepStrictEqual(painel.loadJson('nao_existe.json', { fallback: 1 }), { fallback: 1 });

    fs.writeFileSync(path.join(dir, 'corrompido.json'), '{invalido');
    assert.deepStrictEqual(painel.loadJson('corrompido.json', { fallback: 2 }), { fallback: 2 });
  } finally {
    process.env.DATA_DIR = oldDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseHashrate: interpreta unidades k, M, G, T, P, E e numéricos', () => {
  assert.strictEqual(painel.parseHashrate(1234), 1234);
  assert.strictEqual(painel.parseHashrate('1.5 K'), 1500);
  assert.strictEqual(painel.parseHashrate('2 M'), 2000000);
  assert.strictEqual(painel.parseHashrate('3 G'), 3000000000);
  assert.strictEqual(painel.parseHashrate('4 T'), 4000000000000);
  assert.strictEqual(painel.parseHashrate('5 P'), 5000000000000000);
  assert.strictEqual(painel.parseHashrate('6 E'), 6000000000000000000);
  assert.strictEqual(painel.parseHashrate('sem_numero'), 0);
  assert.strictEqual(painel.parseHashrate(''), 0);
  assert.strictEqual(painel.parseHashrate(null), 0);
});

test('normDiff: normaliza histórico de dificuldade da mempool', () => {
  assert.strictEqual(painel.normDiff(null), null);
  assert.strictEqual(painel.normDiff([]), null);
  assert.strictEqual(painel.normDiff({ invalid: true }), null);

  const rawArr = [[1700000000000, 100, 50], [1700002000000, 200, 60]];
  const outArr = painel.normDiff(rawArr);
  assert.ok(Array.isArray(outArr));
  assert.strictEqual(outArr[0].h, 0); // Genesis adicionado porque out[0].h <= 2016
  assert.strictEqual(outArr[1].t, 1700000000);

  const rawObj = {
    difficulty: [
      { time: 1700000000, height: 2500, difficulty: 70 },
      { timestamp: 1700005000, height: 3000, difficulty: 80 },
    ],
  };
  const outObj = painel.normDiff(rawObj);
  assert.strictEqual(outObj.length, 2);
  assert.strictEqual(outObj[0].h, 2500);
});

test('timeMachine: compara melhor dificuldade com histórico', () => {
  assert.strictEqual(painel.timeMachine(0), null);
  assert.strictEqual(painel.timeMachine(-5), null);

  const st = painel._state();
  st.pool.difficulty = 1000;
  assert.deepStrictEqual(painel.timeMachine(1500), { now: true });

  st.diffHist.list = [
    { t: 100, h: 10, d: 50 },
    { t: 200, h: 20, d: 200 },
    { t: 300, h: 30, d: 500 },
  ];
  assert.strictEqual(painel.timeMachine(10), null);
  const tm = painel.timeMachine(150);
  assert.ok(tm);
  assert.strictEqual(tm.diff, 50);
  assert.strictEqual(tm.from, 100);
  assert.strictEqual(tm.until, 200);
});

test('workersView, farmHashrate, topRecord, addRecord e rememberWorkers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-wk-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    painel.rememberWorkers([
      { name: 'w1', hashRate: 500000, bestDifficulty: 10, lastSeen: new Date().toISOString() },
      { name: 'w2', hashRate: 1500000, bestDifficulty: 25, lastSeen: new Date().toISOString() },
    ], 'pool1');

    painel.addRecord('w3', 100);
    assert.ok(painel.topRecord() >= 100);

    const view = painel.workersView();
    assert.ok(Array.isArray(view));
    assert.ok(view.length >= 2);
    assert.ok(typeof painel.farmHashrate(view) === 'number');
  } finally {
    process.env.DATA_DIR = oldDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sampleHistory e energy: registro e retenção temporal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-hist-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    painel.sampleHistory();
    // chamada subsequente rápida deve retornar sem duplicar (debounce de SAMPLE_MS)
    painel.sampleHistory();
    const loaded = painel.loadJson('history.json', []);
    assert.ok(Array.isArray(loaded));

    const view = painel.workersView();
    const en = painel.energy(view);
    assert.ok(en && typeof en === 'object');
    assert.ok(typeof en.tarifa === 'number');
  } finally {
    process.env.DATA_DIR = oldDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quietNow e alarm: comportamento seguro sem sirene física', () => {
  assert.ok(typeof painel.quietNow() === 'boolean');
  assert.strictEqual(painel.alarm('0'), false);
  assert.strictEqual(painel.alarm('T'), false);
  painel.alarmOpen();
  painel.alarmStatus();
});

test('getJson e getJsonRetry com servidor mock', async (t) => {
  let reqCount = 0;
  const server = http.createServer((req, res) => {
    reqCount++;
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, count: reqCount }));
    }
    if (req.url === '/bad-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{bad');
    }
    if (req.url === '/fail') {
      res.writeHead(500);
      return res.end('server error');
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => server.close());

  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const base = `http://127.0.0.1:${port}`;

  const ok = await painel.getJson(`${base}/ok`);
  assert.strictEqual(ok.success, true);

  await assert.rejects(painel.getJson(`${base}/fail`), /HTTP 500/);
  await assert.rejects(painel.getJson(`${base}/bad-json`), /SyntaxError|JSON/);

  const retryOk = await painel.getJsonRetry(`${base}/ok`, 2);
  assert.strictEqual(retryOk.success, true);
});

test('snapshot e widgetData: formatação em pt e en', () => {
  const snap = painel.snapshot(true);
  assert.ok(snap && snap.farm);
  assert.ok(typeof snap.boot === 'string');

  const wPt = painel.widgetData('pt');
  assert.ok(wPt.recorde !== undefined);
  assert.ok(typeof wPt.hashrate === 'string');

  const wEn = painel.widgetData('en');
  assert.ok(wEn.recorde !== undefined);
  assert.ok(typeof wEn.hashrate === 'string');
});

test('requestHandler: respostas completas das rotas HTTP', async (t) => {
  const server = http.createServer(painel.requestHandler);
  t.after(() => server.close());
  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const base = `http://127.0.0.1:${port}`;

  // GET / (raiz)
  const homePt = await new Promise((res) => http.get(`${base}/?lang=pt`, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: b }));
  }));
  assert.strictEqual(homePt.status, 200);
  assert.match(homePt.body, /<html/);

  // GET /api/mining
  const mining = await new Promise((res) => http.get(`${base}/api/mining`, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) }));
  }));
  assert.strictEqual(mining.status, 200);
  assert.ok(mining.body.farm);

  // GET /api/widget
  const widget = await new Promise((res) => http.get(`${base}/api/widget?lang=pt`, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) }));
  }));
  assert.strictEqual(widget.status, 200);
  assert.ok(widget.body.recorde !== undefined);

  // GET /api/alarm
  const alarmRes = await new Promise((res) => http.get(`${base}/api/alarm?e=T`, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) }));
  }));
  assert.strictEqual(alarmRes.status, 200);
  assert.strictEqual(alarmRes.body.sent, false);

  // POST /api/plug com Content-Type errado
  const badPlugCt = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, { method: 'POST' }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end('texto plano');
  });
  assert.strictEqual(badPlugCt.status, 405);

  // POST /api/plug com JSON inválido
  const badPlugJson = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end('{invalido');
  });
  assert.strictEqual(badPlugJson.status, 400);

  // POST /api/plug com PIN incorreto
  process.env.SETTINGS_PIN = '123456';
  const badPin = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '000000', action: 'on' }));
  });
  assert.strictEqual(badPin.status, 403);

  // POST /api/plug sem tuyaClient configurado -> 404
  painel._setTuyaForTest(null, [], new Map());
  const noTuya = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '123456', action: 'on' }));
  });
  assert.strictEqual(noTuya.status, 404);

  // POST /api/plug com tuyaClient mockado
  let mockAction = null;
  const mockTuya = {
    setSwitch: async (on, devId) => { mockAction = { on, devId }; return { ok: true }; },
    powerCycle: async (ms, devId) => { mockAction = { reboot: true, devId }; return { ok: true }; },
    getStatus: async (devId) => ({ ok: true, status: { on: true, watts: 10 } }),
  };
  const mockPlugs = [{ name: 'P1', deviceId: 'dev1', worker: 'w1', watchdogMin: 10 }];
  const mockStateMap = new Map([['dev1', { okAt: null, error: null, status: { on: false }, lastRebootAt: 0, lastRebootIso: null, rebootCount: 0 }]]);
  painel._setTuyaForTest(mockTuya, mockPlugs, mockStateMap);

  // action 'on'
  const actOn = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '123456', deviceId: 'dev1', action: 'on' }));
  });
  assert.strictEqual(actOn.status, 200);
  assert.strictEqual(mockAction.on, true);

  // action 'off'
  const actOff = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '123456', deviceId: 'dev1', action: 'off' }));
  });
  assert.strictEqual(actOff.status, 200);
  assert.strictEqual(mockAction.on, false);

  // action 'reboot'
  const actRb = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '123456', deviceId: 'dev1', action: 'reboot' }));
  });
  assert.strictEqual(actRb.status, 200);
  assert.strictEqual(mockAction.reboot, true);

  // action inválida
  const actBad = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '123456', deviceId: 'dev1', action: 'invalido' }));
  });
  assert.strictEqual(actBad.status, 400);

  // deviceId desconhecido
  const actUnknownDev = await new Promise((res) => {
    const req = http.request(`${base}/api/plug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode }));
    });
    req.end(JSON.stringify({ pin: '123456', deviceId: 'dev999', action: 'on' }));
  });
  assert.strictEqual(actUnknownDev.status, 404);
});

test('health, readTempC, readCpuPct e readMem: métricas de hardware', () => {
  const h = painel.health();
  assert.ok(h && typeof h === 'object');
  assert.ok(typeof h.uptimeS === 'number');
  assert.ok(typeof h.cores === 'number');

  const temp = painel.readTempC();
  assert.ok(temp === null || (typeof temp === 'number' && temp > 0));
  // a primeira leitura volta null, mas outros testes deste arquivo podem ter lido a CPU antes
  const cpu = painel.readCpuPct();
  assert.ok(cpu === null || (typeof cpu === 'number' && cpu >= 0 && cpu <= 100), String(cpu));
  const mem = painel.readMem();
  assert.ok(mem && mem.total > 0);
});

test('tickTuya: leitura de estado e watchdog de reboot', async () => {
  let rebootTriggered = false;
  const mockTuya = {
    getStatus: async (id) => ({ ok: true, status: { on: true, watts: 15.5, volts: 220, currentMa: 70, kwhTotal: 1.2 } }),
    powerCycle: async (ms, id) => { rebootTriggered = true; return { ok: true, rebootedAt: new Date().toISOString() }; },
  };
  const mockPlugs = [{ name: 'P1', deviceId: 'dev1', worker: 'w1', watchdogMin: 5 }];
  const mockStateMap = new Map([['dev1', { okAt: null, error: null, status: null, lastRebootAt: 0, lastRebootIso: null, rebootCount: 0 }]]);
  painel._setTuyaForTest(mockTuya, mockPlugs, mockStateMap);

  painel.rememberWorkers([{ name: 'w1', hashRate: 50e6, bestDifficulty: 10, lastSeen: new Date(Date.now() - 3 * 3600e3).toISOString() }], 'pool1');

  await painel.tickTuya();
  assert.ok(mockStateMap.get('dev1').status);
  assert.strictEqual(rebootTriggered, true);

  // Com erro do getStatus
  mockTuya.getStatus = async () => ({ ok: false, error: 'falha' });
  await painel.tickTuya();
  assert.strictEqual(mockStateMap.get('dev1').error, 'falha');
});

test('ticks de pool, wallet, network, diffHist, ckpool, ocean, proxy e local', async (t) => {
  const server = http.createServer((req, res) => {
    const json = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.url.includes('/price')) {
      return json({ bitcoin: { brl: 350000, usd: 60000, brl_24h_change: 2.5, usd_24h_change: 2.5 } });
    }

    // Public Pool
    if (req.url.includes('/client/')) {
      return json({
        workers: [],
        accounting: { totalAcceptedShares: 100, acceptedSharesLastDay: 50, acceptedSharesLastHour: 5, hashRateLastHour: 1e6 },
        bestDifficulty: 99999999,
      });
    }
    if (req.url.endsWith('/network')) {
      return json({ difficulty: 1000000000000 });
    }

    // Mempool
    if (req.url.includes('/address/')) {
      return json({ chain_stats: { funded_txo_sum: 50000, spent_txo_sum: 10000, tx_count: 2 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
    }
    if (req.url.endsWith('/v1/blocks')) {
      return json([{ height: 800000, timestamp: 1700000000, id: '00000000000000000000' + '33'.repeat(22), difficulty: 50000000000000, extras: { pool: { name: 'PoolName' }, reward: 312500000 } }]);
    }
    if (req.url.endsWith('/v1/difficulty-adjustment')) {
      return json({ difficultyChange: 1.5, progressPercent: 50, remainingBlocks: 1000, estimatedRetargetDate: 1700500000, timeAvg: 600000 });
    }
    if (req.url.endsWith('/v1/fees/recommended')) {
      return json({ fastestFee: 20, halfHourFee: 15, hourFee: 10, economyFee: 5, minimumFee: 2 });
    }
    if (req.url.includes('/mining/difficulty-adjustments')) {
      const arr = [];
      for (let i = 0; i < 15; i++) {
        arr.push({ time: 1600000000 + i * 20160, height: 600000 + i * 2016, difficulty: (15 + i) * 1e12 });
      }
      return json(arr);
    }

    // Proxy
    if (req.url.endsWith('/stats')) {
      return json({
        workers: [{ name: 'w1', accepted: 10, online: 1, hashrate: 1e6, shares1h: 50, lastShareAt: Date.now(), pool: 'public-pool' }],
        recent: [{ ok: true }],
        totals: { today: 100, lastHour: 10 },
        routes: [{ listen: '3333', upstreams: [{ label: 'p1', down: true, since: Date.now() }, { label: 'p2', down: false }] }],
      });
    }

    // Ocean
    if (req.url.includes('/user_hashrate_full/')) {
      return json({ result: { workers: { 'w1': { hashrate_60s: 1000000 } } } });
    }
    if (req.url.includes('/statsnap/')) {
      return json({ result: { unpaid: '0.001', estimated_earn_next_block: '0.0001', latest_share_ts: 1700000000 } });
    }

    // Ckpools
    if (req.url.includes('/users/')) {
      return json({ worker: [{ workername: 'user.ck1', hashrate1hr: '1.5M', hashrate5m: '1.2M', bestever: 50, lastshare: Math.floor(Date.now() / 1000) }] });
    }

    res.writeHead(404);
    res.end();
  });
  t.after(() => server.close());

  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const base = `http://127.0.0.1:${port}`;

  process.env.POOL_API = base;
  process.env.MEMPOOL_API = base;
  process.env.COINGECKO_API = `${base}/price`;
  process.env.PROXY_URL = `${base}/stats`;
  process.env.OCEAN_API = base;
  process.env.CKPOOL_URLS = `${base}/users/test`;

  await painel.tickPool();
  await painel.tickWallet();
  await painel.tickNetwork();
  await painel.tickDiffHist();
  await painel.tickProxy();
  await painel.tickOcean();
  await painel.tickCkpools();
  await painel.tickLocal();

  assert.ok(painel._state().pool.okAt > 0);
  assert.ok(painel._state().wallet.okAt > 0);
  assert.ok(painel._state().net.okAt > 0);
  assert.ok(painel._state().proxy.okAt > 0);
  assert.ok(painel._state().ocean.okAt > 0);
});


test('start e stop: ciclo de vida do servidor do painel', async () => {
  const port = await freePort();
  const instance = await painel.start(port, '127.0.0.1');
  assert.ok(instance && instance.server);
  assert.ok(typeof instance.stop === 'function');
  await instance.stop();
});

test('initTuya e CKPOOL_URLS padrão', () => {
  const oldDeviceId = process.env.TUYA_DEVICE_ID;
  const oldClientId = process.env.TUYA_CLIENT_ID;
  const oldSecret = process.env.TUYA_SECRET;
  const oldCkpool = process.env.CKPOOL_URLS;
  try {
    process.env.TUYA_DEVICE_ID = 'dev-unit-test';
    process.env.TUYA_CLIENT_ID = 'unit-client-id';
    process.env.TUYA_SECRET = 'unit-secret';
    const res = painel.initTuya();
    assert.strictEqual(res.plugs.length, 1);
    assert.ok(res.client);

    delete process.env.CKPOOL_URLS;
    const urls = painel.CKPOOL_URLS();
    assert.ok(Array.isArray(urls));
    assert.ok(urls.some((u) => u.includes('nerdminers')));
  } finally {
    process.env.TUYA_DEVICE_ID = oldDeviceId;
    process.env.TUYA_CLIENT_ID = oldClientId;
    process.env.TUYA_SECRET = oldSecret;
    if (oldCkpool !== undefined) process.env.CKPOOL_URLS = oldCkpool;
    else delete process.env.CKPOOL_URLS;
    painel.initTuya();
  }
});

test('workersView com worker local ativo', () => {
  painel.rememberWorkers([{ name: 'localminer', hashRate: 1000 }], 'local');
  painel._setLocalWorkerForTest('localminer');
  painel._setLocalForTest({ at: Date.now(), hashrate: 75000, lastShare: Date.now(), running: true });
  const view = painel.workersView();
  const lm = view.find((w) => w.name === 'localminer');
  assert.ok(lm);
  assert.strictEqual(lm.source, 'local');
  assert.strictEqual(lm.state, 'ok');
  assert.strictEqual(lm.hashRate, 75000);
});

test('parseMinerdLog: interpreta hashrate e shares aceitos do log', () => {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const log = [
    `[${nowStr}] thread 0: 1000 hashes, 50.5 khash/s`,
    `[${nowStr}] thread 1: 1000 hashes, 49.5 khash/s`,
    `[${nowStr}] accepted: 1/1 (100%), 100 khash/s (yay!!!)`,
  ].join('\n');
  const parsed = painel.parseMinerdLog(log);
  assert.strictEqual(parsed.hashrate, 100000);
  assert.ok(parsed.lastShare > 0);
  assert.ok(parsed.lastTs > 0);

  const empty = painel.parseMinerdLog('');
  assert.strictEqual(empty.hashrate, 0);
  assert.strictEqual(empty.lastShare, null);
});

test('parseMinerdLog: a hora do journal (short-unix) vale, mesmo com o fuso do Node diferente do sistema', () => {
  const now = Math.floor(Date.now() / 1000);
  const off = new Date(Date.now() - 3 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);   // hora do cpuminer 3 h "atrás" para o Node
  const log = [
    `${now - 30}.123456 homeminer minerd[812]: [${off}] thread 0: 41045675 hashes, 685.63 khash/s`,
    `${now - 10}.654321 homeminer minerd[812]: [${off}] thread 1: 41266343 hashes, 687.66 khash/s`,
    `${now - 5}.000001 homeminer minerd[812]: [${off}] accepted: 3/3 (100.00%), 2058.42 khash/s (yay!!!)`,
    `${now - 4000}.1 homeminer minerd[812]: [${off}] thread 2: 1 hashes, 999.00 khash/s`,   // velho: fica de fora
  ].join('\n');
  const p = painel.parseMinerdLog(log);
  assert.strictEqual(Math.round(p.hashrate), 1373290);
  assert.strictEqual(p.lastShare, (now - 5) * 1000);
  assert.strictEqual(p.lastTs, (now - 10) * 1000);
});

test('readTempC, readCpuPct e readMem com arquivos simulados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
  try {
    const tempF = path.join(dir, 'temp');
    fs.writeFileSync(tempF, '55000\n');
    assert.strictEqual(painel.readTempC(tempF), 55);

    const statF = path.join(dir, 'stat');
    fs.writeFileSync(statF, 'cpu  100 20 50 800 10 0 0 0 0 0\n');
    assert.strictEqual(painel.readCpuPct(statF), null); // primeira leitura armazena cpuPrev
    fs.writeFileSync(statF, 'cpu  150 30 70 850 15 0 0 0 0 0\n');
    const pct = painel.readCpuPct(statF);
    assert.ok(typeof pct === 'number' && pct > 0);

    const memF = path.join(dir, 'meminfo');
    fs.writeFileSync(memF, 'MemTotal:        8000000 kB\nMemAvailable:    4000000 kB\n');
    const mem = painel.readMem(memF);
    assert.strictEqual(mem.total, 8000000 * 1024);
    assert.strictEqual(mem.used, 4000000 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('energy e snapshot com Tuya e proxy sorte ativos', () => {
  const mockPlugs = [{ deviceId: 'd1', name: 'Tomada 1', worker: 'w1', watchdogMin: 10 }];
  const mockState = new Map([['d1', { okAt: Date.now(), error: null, status: { on: true, watts: 15, volts: 120, currentMa: 125, kwhTotal: 5.5 }, lastRebootIso: '2026-01-01', rebootCount: 1 }]]);
  const mockClient = { getDeviceStatus: () => Promise.resolve({}) };
  painel._setTuyaForTest(mockClient, mockPlugs, mockState);

  const eng = painel.energy([{ name: 'w1', state: 'ok' }]);
  assert.strictEqual(eng.watts, 15);
  assert.strictEqual(eng.plugs.length, 1);
  assert.strictEqual(eng.plugs[0].watts, 15);

  const state = painel._state();
  state.net.tip = { height: 830000, hash: '00000000000000000001' };
  state.net.adj = { timeAvg: 600000 };
  state.proxy.okAt = Date.now();
  state.proxy.workers = {
    w1: { name: 'w1', online: 1, shares1h: 50, hashrate: 1e6, luck: { work: 100, best: 50, since: Date.now() }, accepted: 10 }
  };
  state.proxy.hist = [1, 2, 3];

  const snap = painel.snapshot(true);
  assert.ok(snap.net && snap.net.halving);
  assert.ok(snap.luck && snap.luck.workers.length > 0);

  painel._setTuyaForTest(null, [], new Map());
});

test('startMqtt e startTelegram com variáveis setadas', () => {
  const oldMqtt = process.env.MQTT_URL;
  const oldTg = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.MQTT_URL = '';
    assert.strictEqual(painel.startMqtt(), undefined);

    process.env.TELEGRAM_BOT_TOKEN = '';
    assert.strictEqual(painel.startTelegram(), undefined);

    process.env.MQTT_URL = 'mqtt://127.0.0.1:1';
    const m = painel.startMqtt();
    if (m && m.stop) m.stop();
  } finally {
    process.env.MQTT_URL = oldMqtt;
    process.env.TELEGRAM_BOT_TOKEN = oldTg;
  }
});

test('tickLocal com customReader e alarmOpen com arquivo existente', async () => {
  await painel.tickLocal((cb) => cb(null, '[2026-01-01 12:00:00] thread 0: 500 hashes, 10 khash/s\naccepted: 1/1'));
  await painel.tickLocal();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-'));
  try {
    const fakeDev = path.join(dir, 'fake-serial');
    fs.writeFileSync(fakeDev, '');
    painel._resetAlarmTryForTest();
    painel.alarmOpen(fakeDev, (cb) => cb(null));
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    painel._resetAlarmTryForTest();
  }
});

test('recordes: o mesmo share vindo da pool (2 casas) e do proxy conta uma vez só', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-rec-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const at = new Date().toISOString();
    painel.rememberWorkers([{ name: 'macdup', hashRate: 9e6, bestDifficulty: 141095.12, lastSeen: at }], 'public-pool');
    painel.rememberWorkers([{ name: 'macdup', hashRate: 9e6, bestDifficulty: 141095.1234, lastSeen: at }], 'public-pool');
    painel.addRecord('—', 141095.12);   // recorde do endereço que a pool devolve: o mesmo share
    const hits = painel.snapshot().hall.filter((r) => Math.abs(r.value - 141095.12) < 1);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].worker, 'macdup');
    // um share maior de verdade continua virando recorde
    painel.rememberWorkers([{ name: 'macdup', hashRate: 9e6, bestDifficulty: 141200, lastSeen: at }], 'public-pool');
    assert.strictEqual(painel.snapshot().hall.filter((r) => r.worker === 'macdup').length, 2);
  } finally {
    process.env.DATA_DIR = oldDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordes repetidos já gravados: limpa mantendo o mais antigo e o nome do worker', () => {
  const out = painel.dedupeRecords([
    { worker: 'macbook', value: 1410.95, at: '2026-11-06T10:00:00Z' },
    { worker: 'macbook', value: 1410.9534, at: '2026-11-06T10:00:20Z' },
    { worker: '—', value: 1889.37, at: '2026-11-05T14:21:00Z' },
    { worker: 'devkit', value: 1889.3712, at: '2026-11-05T14:22:00Z' },
    { worker: 'macbook', value: 774.93, at: '2026-11-05T09:00:00Z' },
    { worker: 'macbook', value: 774.93, at: '2026-11-05T09:01:00Z' },
    { worker: 'tablet', value: 774.93, at: '2026-11-05T09:02:00Z' },
  ]);
  assert.deepStrictEqual(out.map((r) => [r.worker, r.value, r.at]), [
    ['devkit', 1889.3712, '2026-11-05T14:21:00Z'],
    ['macbook', 1410.9534, '2026-11-06T10:00:00Z'],
    ['macbook', 774.93, '2026-11-05T09:00:00Z'],
    ['tablet', 774.93, '2026-11-05T09:02:00Z'],
  ]);
});

test('recordes com dificuldade fracionária (< 1, ex.: NerdMiner / ESP32)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-nerd-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const state = painel._state();
  const oldRecords = state.records.slice();
  const oldPoolClient = state.pool.client;
  state.records.length = 0;
  state.pool.client = {};
  try {
    const at = new Date().toISOString();
    // Share inicial com diff < 1 deve ser registrado
    painel.rememberWorkers([{ name: 'nmminer', hashRate: 994000, bestDifficulty: 0.297, lastSeen: at }], 'nerdminers');
    assert.strictEqual(painel.topRecord(), 0.297);
    assert.strictEqual(painel.snapshot().farm.best, 0.297);

    // Novo recorde fracionário
    painel.rememberWorkers([{ name: 'nmminer', hashRate: 994000, bestDifficulty: 0.5339238, lastSeen: at }], 'nerdminers');
    assert.strictEqual(painel.topRecord(), 0.5339238);
    assert.strictEqual(painel.snapshot().farm.best, 0.5339238);

    // O mesmo share vindo com menos casas decimais (ex.: 0.53) não duplica
    painel.rememberWorkers([{ name: 'nmminer', hashRate: 994000, bestDifficulty: 0.53, lastSeen: at }], 'nerdminers');
    const records = painel.snapshot().hall.filter((r) => r.worker === 'nmminer');
    assert.strictEqual(records.length, 2); // 0.297 e 0.5339238
  } finally {
    state.records.length = 0;
    state.records.push(...oldRecords);
    state.pool.client = oldPoolClient;
    process.env.DATA_DIR = oldDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inicialização com workers.json preexistente não causa ReferenceError de sameShare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-init-'));
  fs.writeFileSync(path.join(dir, 'workers.json'), JSON.stringify({
    miner1: { name: 'miner1', bestDifficulty: 0.5, lastSeen: new Date().toISOString() }
  }));
  const { execFileSync } = require('child_process');
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)}; require('./src/painel');`]);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
