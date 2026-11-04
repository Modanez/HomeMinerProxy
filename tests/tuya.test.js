// Testes do cliente SmartLife / Tuya OpenAPI v1.0 (assinatura HMAC-SHA256, DPs de energia e controle da tomada).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const tuya = require('../src/tuya');

test('validConfig e signRequest validam credenciais e calculam HMAC-SHA256 determinístico', () => {
  assert.strictEqual(tuya.validConfig({}), null);
  assert.strictEqual(tuya.validConfig({ clientId: 'curto', secret: '12345678', deviceId: '12345678' }), null);
  assert.strictEqual(tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345', deviceId: 'dev_12345', region: 'xx' }), null);
  const cfg = tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345', deviceId: 'dev_12345', region: 'us' });
  assert.strictEqual(cfg.baseUrl, 'https://openapi.tuyaus.com');

  const sig1 = tuya.signRequest({
    clientId: 'client_12345',
    secret: 'secret_12345',
    accessToken: 'tok_abc',
    method: 'GET',
    pathWithQuery: '/v1.0/iot-03/devices/dev_12345/status',
    body: '',
    timestamp: '1700000000000',
    nonce: '01020304',
  });
  assert.match(sig1, /^[0-9A-F]{64}$/);
  // Mudar qualquer parâmetro muda a assinatura
  const sig2 = tuya.signRequest({
    clientId: 'client_12345',
    secret: 'secret_12345',
    accessToken: 'tok_abc',
    method: 'POST',
    pathWithQuery: '/v1.0/iot-03/devices/dev_12345/commands',
    body: '{"commands":[{"code":"switch_1","value":true}]}',
    timestamp: '1700000000000',
    nonce: '01020304',
  });
  assert.notStrictEqual(sig1, sig2);
});

test('parseStatus converte DPs padrão Tuya (switch_1, cur_power em dW, cur_voltage em dV, cur_current em mA)', () => {
  const s1 = tuya.parseStatus([
    { code: 'switch_1', value: true },
    { code: 'cur_power', value: 452 },     // 45,2 W (ventilador / Bitaxe)
    { code: 'cur_voltage', value: 2204 },  // 220,4 V
    { code: 'cur_current', value: 215 },   // 215 mA
    { code: 'add_ele', value: 1250 },      // 1,25 kWh
  ]);
  assert.strictEqual(s1.on, true);
  assert.strictEqual(s1.watts, 45.2);
  assert.strictEqual(s1.volts, 220.4);
  assert.strictEqual(s1.currentMa, 215);
  assert.strictEqual(s1.kwhTotal, 1.25);
  assert.strictEqual(s1.switchCode, 'switch_1');

  // DPs numéricos legados (1, 18, 19, 20, 17) e shadow v2.0 (properties)
  const s2 = tuya.parseStatus({ status: [{ code: '1', value: false }, { code: '19', value: 0 }, { code: '20', value: 1270 }] });
  assert.strictEqual(s2.on, false);
  assert.strictEqual(s2.watts, 0);
  assert.strictEqual(s2.volts, 127);

  const s3 = tuya.parseStatus({ properties: [{ code: 'switch_1', value: true }, { code: 'cur_power', value: 650 }] });
  assert.strictEqual(s3.on, true);
  assert.strictEqual(s3.watts, 65);

  // normalizePlugs: valida lista dinâmica e migra configuração legada de tomada única
  const leg = tuya.normalizePlugs('', { deviceId: 'eb49d08081c5ba5e80ackt', worker: 'bitaxe', watchdogMin: 10 });
  assert.deepStrictEqual(leg.list, [{ name: 'bitaxe', deviceId: 'eb49d08081c5ba5e80ackt', worker: 'bitaxe', watchdogMin: 10 }]);
  const multi = tuya.normalizePlugs([
    { name: 'Ventilador', deviceId: 'eb1111111111111111', worker: '', watchdogMin: 0 },
    { name: 'Bitaxe Supra', deviceId: 'eb2222222222222222', worker: 'bitaxe', watchdogMin: 15 },
    { name: 'Duplicada', deviceId: 'eb1111111111111111', worker: '*', watchdogMin: 0 },
  ]);
  assert.strictEqual(multi.list.length, 2);
  assert.strictEqual(multi.list[0].name, 'Ventilador');
  assert.strictEqual(multi.list[1].watchdogMin, 15);
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: 'curto' }]).error, 'tuyaid');
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: 'eb1111111111111111', watchdogMin: 2 }]).error, 'watchdog');
  assert.strictEqual(tuya.normalizePlugs('{invalido').error, 'tuyaplugs');
  assert.strictEqual(tuya.normalizePlugs('[{"deviceId":"dev_12345"}]').list.length, 1);
  assert.strictEqual(tuya.normalizePlugs(Array(35).fill({ deviceId: 'dev_12345' })).error, 'tuyaplugs');
  assert.strictEqual(tuya.normalizePlugs([null]).error, 'tuyaplugs');
  assert.strictEqual(tuya.normalizePlugs([['array']]).error, 'tuyaplugs');
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: '' }]).list.length, 0);
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: 'dev_12345', worker: 'invalido?!' }]).error, 'name');
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: 'dev_12345', name: 'a'.repeat(60) }]).error, 'name');
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: 'dev_12345', watchdogMin: 'invalido' }]).error, 'watchdog');
  assert.strictEqual(tuya.normalizePlugs([{ deviceId: 'dev_12345', watchdogMin: 2000 }]).error, 'watchdog');
  assert.strictEqual(tuya.normalizePlugs(null).list.length, 0);
  assert.strictEqual(tuya.normalizePlugs('', { deviceId: 'curto' }).list.length, 0);

  // parseStatus com objeto direto, switch_led, switch e valores vazios
  const directObj = tuya.parseStatus({ switch_led: true, switch: false, cur_power: 'nao-numero' });
  assert.strictEqual(directObj.on, false);
  assert.strictEqual(directObj.watts, null);

  const directObj2 = tuya.parseStatus({ switch_led: true });
  assert.strictEqual(directObj2.switchCode, 'switch_led');
  assert.strictEqual(directObj2.on, true);

  const emptyStatus = tuya.parseStatus(null);
  assert.strictEqual(emptyStatus.on, null);
  assert.strictEqual(emptyStatus.watts, null);

  // legacy com worker '*' e watchdog fora da faixa
  const legStar = tuya.normalizePlugs('', { deviceId: 'eb49d08081c5ba5e80ackt', worker: '*', watchdogMin: 1 });
  assert.strictEqual(legStar.list[0].name, 'Tomada 1');
  assert.strictEqual(legStar.list[0].watchdogMin, 0);

  // item com worker '*' gerando nome 'Tomada 1'
  const starItem = tuya.normalizePlugs([{ deviceId: 'eb49d08081c5ba5e80ackt', worker: '*' }]);
  assert.strictEqual(starItem.list[0].name, 'Tomada 1');

  // item sem name mas com worker válido 'bitaxe' gera rawName = worker
  const wNameItem = tuya.normalizePlugs([{ deviceId: 'eb49d08081c5ba5e80ackt', worker: 'bitaxe' }]);
  assert.strictEqual(wNameItem.list[0].name, 'bitaxe');

  // legacy com apenas deviceId (sem worker e sem watchdogMin)
  const bareLeg = tuya.normalizePlugs('', { deviceId: 'eb49d08081c5ba5e80ackt' });
  assert.strictEqual(bareLeg.list[0].name, 'Tomada 1');
  assert.strictEqual(bareLeg.list[0].watchdogMin, 0);
});

test('validConfig, testPlug vazio e powerCycle com falha', async () => {
  // allowNoDevice
  const noDev = tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345', allowNoDevice: true });
  assert.ok(noDev);
  assert.strictEqual(noDev.deviceId, '');

  // deviceId inválido com allowNoDevice
  assert.strictEqual(tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345', deviceId: 'curto', allowNoDevice: true }), null);
  // secret inválido
  assert.strictEqual(tuya.validConfig({ clientId: 'client_12345', secret: 'curto' }), null);
  // deviceId omitido sem allowNoDevice
  assert.strictEqual(tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345' }), null);
  // region vazia usa 'us'
  const defReg = tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345', deviceId: 'dev_12345', region: '' });
  assert.strictEqual(defReg.region, 'us');
  const spaceReg = tuya.validConfig({ clientId: 'client_12345', secret: 'secret_12345', deviceId: 'dev_12345', region: '   ' });
  assert.strictEqual(spaceReg.region, 'us');

  // getStatus e setSwitch sem devId e sem cfg.deviceId (allowNoDevice: true)
  const noDevClient = tuya.createClient({ clientId: 'client_12345', secret: 'secret_12345', allowNoDevice: true });
  assert.strictEqual((await noDevClient.getStatus()).error, 'tuyaid');
  assert.strictEqual((await noDevClient.setSwitch(true)).error, 'tuyaid');

  // signRequest sem nonce
  const sigNoNonce = tuya.signRequest({ clientId: 'c', secret: 's', timestamp: 123 });
  assert.ok(sigNoNonce);

  // testPlug sem client válido
  const noClient = await tuya.testPlug();
  assert.strictEqual(noClient.ok, false);
  assert.strictEqual(noClient.error, 'tuyamissing');

  // getStatus e setSwitch com devId inválido
  const client = tuya.createClient({ clientId: 'client_12345', secret: 'secret_12345', deviceId: 'dev_12345' });
  const badDevGet = await client.getStatus('curto');
  assert.strictEqual(badDevGet.error, 'tuyaid');
  const badDevSet = await client.setSwitch(true, 'curto');
  assert.strictEqual(badDevSet.error, 'tuyaid');
});

test('createClient e testPlug conversam com servidor Tuya OpenAPI v1.0 (token, renovação 1010, leitura e comandos)', async (t) => {
  let tokenCount = 0;
  let switchOn = true;
  let powerDw = 185; // 18,5 W
  let expireNextCall = false;
  const commandsSent = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.client_id !== 'client_valid_123') {
        return res.end(JSON.stringify({ success: false, code: 1004, msg: 'sign invalid' }));
      }
      if (req.url.startsWith('/v1.0/token')) {
        tokenCount++;
        return res.end(JSON.stringify({
          success: true,
          result: { access_token: 'tok_' + tokenCount, expire_time: 7200 },
        }));
      }
      if (expireNextCall) {
        expireNextCall = false;
        return res.end(JSON.stringify({ success: false, code: 1010, msg: 'token is expired' }));
      }
      if (req.url === '/v1.0/iot-03/devices/dev_valid_456/status' && req.method === 'GET') {
        return res.end(JSON.stringify({
          success: true,
          result: [
            { code: 'switch_1', value: switchOn },
            { code: 'cur_power', value: powerDw },
            { code: 'cur_voltage', value: 2195 },
            { code: 'cur_current', value: 90 },
          ],
        }));
      }
      if (req.url === '/v1.0/iot-03/devices/dev_valid_456/commands' && req.method === 'POST') {
        const j = JSON.parse(body);
        commandsSent.push(j.commands);
        if (j.commands && j.commands[0]) switchOn = !!j.commands[0].value;
        return res.end(JSON.stringify({ success: true, result: true }));
      }
      res.end(JSON.stringify({ success: false, code: 1106, msg: 'permission deny' }));
    });
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  // 1. Credenciais inválidas no testPlug
  const badAuth = await tuya.testPlug({ clientId: 'wrong_client_id', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase });
  assert.strictEqual(badAuth.ok, false);
  assert.match(badAuth.error, /sign invalid/);

  // 2. Cliente válido: lê status e reutiliza token em cache
  const client = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase });
  const st1 = await client.getStatus();
  assert.strictEqual(st1.ok, true);
  assert.strictEqual(st1.status.on, true);
  assert.strictEqual(st1.status.watts, 18.5);
  assert.strictEqual(st1.status.volts, 219.5);
  assert.strictEqual(tokenCount, 1);

  powerDw = 420; // 42,0 W
  const st2 = await client.getStatus();
  assert.strictEqual(st2.status.watts, 42);
  assert.strictEqual(tokenCount, 1); // usou o token em cache

  // 3. Se o token expirar (código 1010), renova sozinho e repete a chamada
  expireNextCall = true;
  const st3 = await client.getStatus();
  assert.strictEqual(st3.ok, true);
  assert.strictEqual(tokenCount, 2);

  // 4. Desligar, ligar e powerCycle (reiniciar)
  const offRes = await client.setSwitch(false);
  assert.strictEqual(offRes.ok, true);
  assert.strictEqual(switchOn, false);

  const cycleRes = await client.powerCycle(20);
  assert.strictEqual(cycleRes.ok, true);
  assert.strictEqual(switchOn, true);
  assert.strictEqual(commandsSent.length, 3); // false, false, true
});

test('fallback de comandos v1.0/devices e falha no powerCycle', async (t) => {
  let postCount = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1.0/token')) {
      return res.end(JSON.stringify({ success: true, result: { access_token: 'tok_test', expire_time: 7200 } }));
    }
    if (req.method === 'POST') {
      postCount++;
      // Primeiro endpoint (/iot-03) falha; segundo (/devices) tem sucesso
      if (req.url.includes('/iot-03/')) {
        return res.end(JSON.stringify({ success: false, code: 1106, msg: 'permission deny' }));
      }
      return res.end(JSON.stringify({ success: true, result: true }));
    }
    res.end(JSON.stringify({ success: true, result: [{ code: '1', value: true }] }));
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const client = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase });
  const sw = await client.setSwitch(true);
  assert.strictEqual(sw.ok, true);
  assert.strictEqual(postCount, 2); // Tentou iot-03 e fez fallback para devices

  // Resposta não-JSON
  const htmlServer = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html>Bad Gateway</html>');
  });
  await new Promise((res) => htmlServer.listen(0, '127.0.0.1', res));
  t.after(() => htmlServer.close());

  const clientHtml = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase: `http://127.0.0.1:${htmlServer.address().port}` });
  const badHtmlRes = await clientHtml.getStatus();
  assert.strictEqual(badHtmlRes.ok, false);

  // Servidor que rejeita ambos endpoints de comando (exercita : r no setSwitch)
  let cmdCalls = 0;
  const failCmdServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1.0/token')) {
      return res.end(JSON.stringify({ success: true, result: { access_token: 'tok_test', expire_time: 7200 } }));
    }
    if (req.method === 'POST') {
      cmdCalls++;
      // simula primeiro comando (desligar) sucedendo, segundo (ligar) falhando
      if (cmdCalls > 1) {
        return res.end(JSON.stringify({ success: false, description: 'ambos falharam' }));
      }
      return res.end(JSON.stringify({ success: true, result: true }));
    }
    res.end(JSON.stringify({ success: true, result: [] }));
  });
  await new Promise((res) => failCmdServer.listen(0, '127.0.0.1', res));
  t.after(() => failCmdServer.close());

  const clientFailOn = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase: `http://127.0.0.1:${failCmdServer.address().port}` });
  // powerCycle onde religar falha (exercita : on)
  const cycleFailOn = await clientFailOn.powerCycle(10);
  assert.strictEqual(cycleFailOn.ok, false);
  assert.strictEqual(cycleFailOn.error, 'ambos falharam');

  // URL malformada e timeout/erro de rede
  const badUrlClient = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase: 'http://[::1' });
  assert.strictEqual((await badUrlClient.getStatus()).ok, false);

  // Erro ECONNREFUSED em porta fechada
  const deadClient = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase: 'http://127.0.0.1:1' });
  assert.strictEqual((await deadClient.getStatus()).ok, false);

  // rawRequest direto: timeout e resposta sem mensagem de erro
  const slowServer = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('{}'), 100);
      return;
    }
    // Resposta com success: false sem msg nem description
    res.end(JSON.stringify({ success: false }));
  });
  await new Promise((res) => slowServer.listen(0, '127.0.0.1', res));
  t.after(() => slowServer.close());

  const slowBase = `http://127.0.0.1:${slowServer.address().port}`;
  const toRes = await tuya._test.rawRequest(slowBase, 'GET', '/slow', {}, '', 15);
  assert.strictEqual(toRes.ok, false);
  assert.match(toRes.error, /timeout/);

  const noMsgRes = await tuya._test.rawRequest(slowBase, 'GET', '/nomsg', {});
  assert.strictEqual(noMsgRes.ok, false);
  assert.strictEqual(noMsgRes.error, 'HTTP 200');

  // powerCycle com falha no setSwitch
  const failCycle = await client.powerCycle(10, 'curto');
  assert.strictEqual(failCycle.ok, false);
  assert.strictEqual(failCycle.error, 'tuyaid');
});

test('probing automático dos 6 data centers da Tuya em caso de datacenter suspenso', async (t) => {
  const https = require('https');
  const { PassThrough } = require('stream');
  const origRequest = https.request;

  t.after(() => { https.request = origRequest; });

  https.request = (url, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const req = new PassThrough();
    const hostname = url.hostname || (typeof url === 'string' ? new URL(url).hostname : '');
    const pathname = url.pathname || (typeof url === 'string' ? new URL(url).pathname : '');

    setImmediate(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      callback(res);

      if (hostname === 'openapi.tuyaus.com') {
        // No us, token funciona mas dispositivo retorna code 1004 sem mensagem especial
        if (pathname.includes('/token')) {
          res.end(JSON.stringify({ success: true, result: { access_token: 'tok_us' } })); // sem expire_time (cai em 7200)
        } else {
          res.end(JSON.stringify({ success: false, code: 1004, msg: 'outro_erro' }));
        }
      } else if (hostname === 'openapi-ueaz.tuyaus.com') {
        // Primeiro da lista others falha no token (exercita continue)
        res.end(JSON.stringify({ success: false, code: 9999 }));
      } else if (hostname === 'openapi.tuyaeu.com') {
        // Terceiro datacenter responde com sucesso
        if (pathname.includes('/token')) {
          res.end(JSON.stringify({ success: true, result: { access_token: 'tok_eu', expire_time: 7200 } }));
        } else {
          res.end(JSON.stringify({ success: true, result: [{ code: 'switch_1', value: true }] }));
        }
      } else {
        res.end(JSON.stringify({ success: false, code: 1004, msg: 'outro' }));
      }
    });

    return req;
  };

  const client = tuya.createClient({
    clientId: 'client_valid_123',
    secret: 'secret_valid_123',
    deviceId: 'dev_valid_456',
    region: 'us', // sem apiBase para usar probing de ALL_ENDPOINTS
  });

  const st = await client.getStatus();
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.status.on, true);

  // Probing onde todos os outros falham (exercitando linha 224: return first)
  https.request = (url, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const req = new PassThrough();
    const pathname = url.pathname || (typeof url === 'string' ? new URL(url).pathname : '');

    setImmediate(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      callback(res);
      if (pathname.includes('/token')) {
        res.end(JSON.stringify({ success: true, result: { access_token: 'tok_fail', expire_time: 7200 } }));
      } else {
        res.end(JSON.stringify({ success: false, code: 1106, msg: 'permission deny' }));
      }
    });
    return req;
  };

  const clientAllFail = tuya.createClient({
    clientId: 'client_valid_123',
    secret: 'secret_valid_123',
    deviceId: 'dev_valid_456',
    region: 'us',
  });
  const stFail = await clientAllFail.getStatus();
  assert.strictEqual(stFail.ok, false);

  // Probing com códigos 1106 e 28841105
  for (const c of [1106, 28841105]) {
    https.request = (url, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const req = new PassThrough();
      const pathname = url.pathname || (typeof url === 'string' ? new URL(url).pathname : '');
      setImmediate(() => {
        const res = new PassThrough();
        res.statusCode = 200;
        callback(res);
        if (pathname.includes('/token')) {
          res.end(JSON.stringify({ success: true, result: { access_token: 'tok_test', expire_time: 7200 } }));
        } else {
          res.end(JSON.stringify({ success: false, code: c }));
        }
      });
      return req;
    };
    const cCli = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', region: 'us' });
    const r = await cCli.getStatus();
    assert.strictEqual(r.ok, false);
  }
});


test('inspect: traz online, status bruto, funções e o código de comando usado', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1.0/token')) return res.end(JSON.stringify({ success: true, result: { access_token: 'tok', expire_time: 7200 } }));
    if (req.url === '/v1.0/devices/dev_valid_456') {
      return res.end(JSON.stringify({ success: true, result: { online: false, category: 'cz', product_name: 'Smart Plug', status: [{ code: 'switch_1', value: true }] } }));
    }
    if (req.url === '/v1.0/devices/dev_valid_456/functions') {
      return res.end(JSON.stringify({ success: true, result: { category: 'cz', functions: [{ code: 'switch_1', type: 'Boolean', values: '{}' }] } }));
    }
    res.end(JSON.stringify({ success: false, code: 1106, msg: 'permission deny' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const client = tuya.createClient({ clientId: 'client_valid_123', secret: 'secret_valid_123', deviceId: 'dev_valid_456', apiBase });

  assert.deepStrictEqual(await client.inspect('lixo!'), { ok: false, error: 'tuyaid' });
  const r = await client.inspect();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.online, false);
  assert.strictEqual(r.category, 'cz');
  assert.strictEqual(r.product, 'Smart Plug');
  assert.strictEqual(r.commandCode, 'switch_1');
  assert.strictEqual(r.functions[0].code, 'switch_1');
  assert.deepStrictEqual(r.errors, { info: null, functions: null });
});
