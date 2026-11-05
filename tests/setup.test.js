// Assistente de primeira configuração e botão de atualizar.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const setup = require('../src/setup');
const update = require('../src/update');

const ADDR = 'bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w';
const PAINEL = path.join(__dirname, '../src/painel.js');
const OFFLINE = path.join(__dirname, 'helpers/offline.js');
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const req = (port, method, url, body, type = 'application/json') => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) } : {} }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
  });
  r.on('error', rej); r.end(data);
});
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) { /* subindo */ } if (Date.now() > end) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 100)); } };
function painel(port, dir, extra = {}) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, PROXY_URL: '', ALARM_PORT: path.join(dir, 'x'), CKPOOL_URLS: '', OCEAN_API: '', UPDATE_CHECK: '0', ...extra };
  delete env.BTC_ADDRESS; delete env.SETTINGS_PIN;
  Object.assign(env, extra);
  return spawn(process.execPath, ['-r', OFFLINE, PAINEL], { env, stdio: 'ignore' });
}

test('validação do assistente', () => {
  assert.deepStrictEqual(setup.validate({ LANGUAGE: 'pt-BR', BTC_ADDRESS: ADDR.toUpperCase(), pin: '424242', pin2: '424242', CURRENCY: 'BRL', POWER_PRICE_KWH: '0,9' }, ''),
    { values: { LANGUAGE: 'pt-BR', BTC_ADDRESS: ADDR, CURRENCY: 'BRL', POWER_PRICE_KWH: '0.9' }, pin: '424242' });
  assert.deepStrictEqual(setup.validate({ LANGUAGE: 'fr', BTC_ADDRESS: 'xyz', pin: '12', pin2: '12', CURRENCY: 'EUR', POWER_PRICE_KWH: '-1' }, '').errors,
    { LANGUAGE: 'option', BTC_ADDRESS: 'address', CURRENCY: 'option', POWER_PRICE_KWH: 'price', pin: 'pin' });
  assert.deepStrictEqual(setup.validate({ LANGUAGE: 'en', BTC_ADDRESS: ADDR, pin: '424242', pin2: '424243' }, '').errors, { pin2: 'pin2' });
  assert.strictEqual(setup.validate({ LANGUAGE: 'en', BTC_ADDRESS: ADDR, pin: '424242' }, '999999', 'wrong').errors.pin, 'wrong');   // PIN do .env
  assert.match(setup.page('pt', false), /Primeira configuração/);
  assert.match(setup.page('en', true), /s3env/);
});

test('sem endereço: assistente no navegador, grava, reinicia no modo normal com o PIN escolhido', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  let p = painel(port, dir);
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const root = await waitFor(() => req(port, 'GET', '/'));
  assert.strictEqual(root.status, 302);
  assert.strictEqual(root.headers.location, '/setup');
  assert.match((await req(port, 'GET', '/setup')).body, /HomeMinerProxy/);
  assert.strictEqual((await req(port, 'GET', '/api/mining')).status, 503);
  assert.strictEqual(JSON.parse((await req(port, 'GET', '/api/setup')).body).envPin, false);

  const bad = await req(port, 'POST', '/api/setup', { LANGUAGE: 'pt-BR', BTC_ADDRESS: 'xyz', pin: '1', pin2: '1' });
  assert.strictEqual(bad.status, 400);
  assert.ok(JSON.parse(bad.body).errors.BTC_ADDRESS);
  assert.strictEqual((await req(port, 'POST', '/api/setup', { pin: '424242' }, 'text/plain')).status, 405);

  const exited = new Promise((res) => p.once('exit', res));
  const ok = await req(port, 'POST', '/api/setup', { LANGUAGE: 'pt-BR', BTC_ADDRESS: ADDR, pin: '424242', pin2: '424242', CURRENCY: 'BRL', POWER_PRICE_KWH: '0,90' });
  assert.deepStrictEqual(JSON.parse(ok.body), { ok: true, restart: true, addr: ADDR });
  assert.strictEqual(await exited, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { LANGUAGE: 'pt-BR', BTC_ADDRESS: ADDR, CURRENCY: 'BRL', POWER_PRICE_KWH: '0.9' });
  assert.strictEqual((fs.statSync(path.join(dir, 'pin.json')).mode & 0o777).toString(8), '600');
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))).includes('424242'));   // PIN fora do settings.json e do backup

  p = painel(port, dir);   // o systemd sobe de novo: agora no modo normal
  const snap = await waitFor(async () => { const r = await req(port, 'GET', '/api/mining'); return r.status === 200 && JSON.parse(r.body); });
  assert.ok(snap.farm);
  const cfg = JSON.parse((await req(port, 'GET', '/api/config')).body);
  assert.strictEqual(cfg.values.BTC_ADDRESS, ADDR);
  assert.strictEqual(cfg.pin, true);
  assert.strictEqual((await req(port, 'POST', '/api/config', { pin: '000000', values: {} })).status, 403);
  assert.strictEqual((await req(port, 'POST', '/api/config', { pin: '424242', values: {} })).status, 200);   // o PIN escolhido vale
  assert.strictEqual((await req(port, 'GET', '/setup')).status, 200);   // a URL antiga cai na página normal, não no assistente
  assert.doesNotMatch((await req(port, 'GET', '/setup')).body, /Primeira configuração/);
});

test('se o .env já tem SETTINGS_PIN, o assistente pede esse PIN', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const p = painel(port, dir, { SETTINGS_PIN: '777777' });
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.strictEqual(JSON.parse((await waitFor(() => req(port, 'GET', '/api/setup'))).body).envPin, true);
  const wrong = await req(port, 'POST', '/api/setup', { LANGUAGE: 'en', BTC_ADDRESS: ADDR, pin: '123456' });
  assert.deepStrictEqual(JSON.parse(wrong.body).errors, { pin: 'wrong' });
  const exited = new Promise((res) => p.once('exit', res));
  assert.strictEqual((await req(port, 'POST', '/api/setup', { LANGUAGE: 'en', BTC_ADDRESS: ADDR, pin: '777777' })).status, 200);
  await exited;
  assert.ok(!fs.existsSync(path.join(dir, 'pin.json')));   // o PIN continua sendo o do .env
});

test('versões e botão de atualizar', async (t) => {
  assert.ok(update.newer('0.10.0', '0.9.9'));
  assert.ok(update.newer('v1.0.0', '0.9.0'));
  assert.ok(!update.newer('0.3.0', '0.3.0'));
  assert.ok(!update.newer('0.2.9', '0.3.0'));
  assert.strictEqual(update.canUpdate({ repo: null }, {}).ok, false);

  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const flag = path.join(dir, 'atualizou');
  const p = painel(port, dir, { BTC_ADDRESS: ADDR, SETTINGS_PIN: '424242', UPDATE_CMD: `touch "${flag}"` });
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const v = JSON.parse((await waitFor(() => req(port, 'GET', '/api/config/version'))).body);
  assert.strictEqual(v.version, require('../package.json').version);
  assert.strictEqual(v.canUpdate, true);
  assert.ok(!('repo' in v));   // a pasta do servidor não sai na API
  assert.strictEqual((await req(port, 'POST', '/api/config/update', { pin: '1' })).status, 403);
  assert.deepStrictEqual(JSON.parse((await req(port, 'POST', '/api/config/update', { pin: '424242' })).body), { ok: true, restart: true });
  await waitFor(() => fs.existsSync(flag), 5000);
  const ok = await waitFor(async () => { const j = JSON.parse((await req(port, 'GET', '/api/config/version')).body); return j.lastUpdate && j.lastUpdate; });
  assert.strictEqual(ok.ok, true);
});

test('atualização que falha aparece com o motivo (ex.: git pull recusado)', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const p = painel(port, dir, { BTC_ADDRESS: ADDR, SETTINGS_PIN: '424242', UPDATE_CMD: 'echo "fatal: Authentication failed" >&2; exit 128' });
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => req(port, 'GET', '/api/config/version'));
  assert.strictEqual((await req(port, 'POST', '/api/config/update', { pin: '424242' })).status, 200);
  const lu = await waitFor(async () => JSON.parse((await req(port, 'GET', '/api/config/version')).body).lastUpdate);
  assert.strictEqual(lu.ok, false);
  assert.strictEqual(lu.rc, 128);
  assert.match(lu.tail.join('\n'), /Authentication failed/);
});

test('sem systemd nem repositório, o botão explica em vez de atualizar', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const p = painel(port, dir, { BTC_ADDRESS: ADDR, SETTINGS_PIN: '424242', INVOCATION_ID: '' });
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const v = JSON.parse((await waitFor(() => req(port, 'GET', '/api/config/version'))).body);
  assert.strictEqual(v.canUpdate, false);
  assert.ok(['docker', 'norepo', 'nosystemd'].includes(v.reason));
  const r = await req(port, 'POST', '/api/config/update', { pin: '424242' });
  assert.strictEqual(r.status, 409);
});

test('aba Rede: GET só diz o que existe; estado e ações só com o PIN', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
  const ts = path.join(dir, 'tailscale'), sc = path.join(dir, 'systemctl');
  fs.writeFileSync(ts, '#!/bin/sh\n[ "$1" = status ] && echo \'{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/xyz","Self":{}}\'\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(sc, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const p = painel(port, dir, { BTC_ADDRESS: ADDR, SETTINGS_PIN: '424242', NMCLI_PATH: path.join(dir, 'sem-nmcli'), TAILSCALE_PATH: ts, NET_SYSTEMCTL: sc, SSHD_PATH: path.join(dir, 'sem-sshd') });
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const caps = JSON.parse((await waitFor(() => req(port, 'GET', '/api/config/net'))).body);
  assert.strictEqual(typeof caps.docker, 'boolean');
  delete caps.docker;
  assert.deepStrictEqual(caps, { wifi: false, wifiReason: null, tailscale: true, tsState: 'login', ssh: false });
  assert.doesNotMatch(JSON.stringify(caps), /login\.tailscale/);
  assert.match((await req(port, 'GET', '/config')).body, /data-tab="net"/);
  assert.strictEqual((await req(port, 'POST', '/api/config/net', { pin: '1', action: 'status' })).status, 403);
  const st = JSON.parse((await req(port, 'POST', '/api/config/net', { pin: '424242', action: 'status' })).body);
  assert.strictEqual(st.tailscale.state, 'login');
  assert.strictEqual(st.tailscale.authUrl, 'https://login.tailscale.com/a/xyz');
  assert.strictEqual(st.wifi.available, false);
  assert.strictEqual((await req(port, 'POST', '/api/config/net', { pin: '424242', action: 'rm -rf' })).status, 400);
});

test('relógio atrasado: o painel abre, avisa e só começa a coletar depois', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-'));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ installedAt: new Date(Date.now() + 86400e3).toISOString() }));
  const p = painel(port, dir, { BTC_ADDRESS: ADDR, CLOCK_WAIT_MIN: '0.05' });   // desiste em 3 s
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = JSON.parse((await waitFor(() => req(port, 'GET', '/api/mining'))).body);
  assert.deepStrictEqual(first.clock, { waiting: true, suspect: false });
  const after = await waitFor(async () => { const j = JSON.parse((await req(port, 'GET', '/api/mining')).body); return !j.clock.waiting && j.clock; }, 15000);
  assert.deepStrictEqual(after, { waiting: false, suspect: true });
});
