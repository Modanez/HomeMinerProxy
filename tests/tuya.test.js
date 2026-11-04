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

  // DPs numéricos legados (1, 18, 19, 20, 17)
  const s2 = tuya.parseStatus({ status: [{ code: '1', value: false }, { code: '19', value: 0 }, { code: '20', value: 1270 }] });
  assert.strictEqual(s2.on, false);
  assert.strictEqual(s2.watts, 0);
  assert.strictEqual(s2.volts, 127);
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

