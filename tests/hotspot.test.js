// Rede de configuração sem cabo (hotspot), com um nmcli falso.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

function sandbox(t, { ap = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'));
  const log = path.join(dir, 'calls.log'), active = path.join(dir, 'active');
  const nmcli = path.join(dir, 'nmcli');
  fs.writeFileSync(nmcli, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "-t -f DEVICE,TYPE device") echo "eth0:ethernet"; echo "wlan0:wifi" ;;
  "-t -f WIFI-PROPERTIES.AP device show wlan0") echo "WIFI-PROPERTIES.AP:${ap ? 'yes' : 'no'}" ;;
  "-t -f NAME connection show --active") echo "Wired connection 1"; [ -f "${active}" ] && echo "homeminer-setup" ;;
  *"wifi list"*) echo "Casa:80:WPA2:"; echo "Vizinho:40::"; echo "HomeMiner-Setup:99::" ;;
  "connection up id homeminer-setup") touch "${active}" ;;
  "connection down id homeminer-setup") rm -f "${active}" ;;
  "device wifi connect Casa password certa1234") ;;
  "device wifi connect"*) echo "Error: Secrets were required, but not provided." >&2; exit 4 ;;
esac
`, { mode: 0o755 });
  const prev = { NMCLI_PATH: process.env.NMCLI_PATH, DATA_DIR: process.env.DATA_DIR };
  Object.assign(process.env, { NMCLI_PATH: nmcli, DATA_DIR: dir });
  for (const m of ['../src/netctl', '../src/hotspot', '../src/setup']) delete require.cache[require.resolve(m)];
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; } fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n'); } catch (_) { return []; } };
  return { hs: require('../src/hotspot'), calls, dir, active };
}

test('rota padrão: só conta com gateway', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const head = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
  fs.writeFileSync(path.join(dir, 'with'), head + 'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n');
  fs.writeFileSync(path.join(dir, 'without'), head + 'wlan0\t002A0A0A\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n');
  const { hasDefaultRoute } = require('../src/hotspot');
  assert.strictEqual(hasDefaultRoute(path.join(dir, 'with')), true);
  assert.strictEqual(hasDefaultRoute(path.join(dir, 'without')), false);
  assert.strictEqual(hasDefaultRoute(path.join(dir, 'missing')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formulário do Wi-Fi', () => {
  const { checkWifiForm } = require('../src/hotspot');
  assert.strictEqual(checkWifiForm('', 'x'), 'ssid');
  assert.strictEqual(checkWifiForm('Casa', '1234'), 'wifipass');
  assert.strictEqual(checkWifiForm('Casa', ''), null);
  assert.strictEqual(checkWifiForm('Casa', 'certa1234'), null);
});

test('liga o hotspot (rede aberta, modo shared) e guarda as redes por perto', async (t) => {
  const { hs, calls } = sandbox(t);
  assert.strictEqual(await hs.apDevice(), 'wlan0');
  const r = await hs.start('wlan0');
  assert.ok(r.ok);
  const add = calls().find((c) => c.startsWith('connection add'));
  assert.match(add, /ifname wlan0 con-name homeminer-setup autoconnect no ssid HomeMiner-Setup 802-11-wireless.mode ap/);
  assert.match(add, /ipv4.method shared ipv4.addresses 10.42.0.1\/24/);
  assert.ok(!/psk|key-mgmt/.test(add));
  const st = await hs.status();
  assert.strictEqual(st.active, true);
  assert.deepStrictEqual(st.networks.map((n) => n.ssid), ['Casa', 'Vizinho']);   // sem a própria rede
  assert.strictEqual(st.networks[0].secure, true);
  assert.strictEqual(st.networks[1].secure, false);
});

test('sem Wi-Fi com modo AP: não há onde criar o hotspot', async (t) => {
  const { hs } = sandbox(t, { ap: false });
  assert.strictEqual(await hs.apDevice(), null);
});

test('trocar para o Wi-Fi de casa: senha errada volta o hotspot com o motivo', async (t) => {
  const { hs, active } = sandbox(t);
  await hs.start('wlan0');
  const wait = async () => {};
  const bad = await hs.connectFromAp('Casa', 'errada123', { wait });
  assert.strictEqual(bad.ok, false);
  assert.ok(fs.existsSync(active), 'hotspot de volta');
  let st = await hs.status();
  assert.strictEqual(st.lastError, 'wifiauth');
  assert.strictEqual(st.lastSsid, 'Casa');
  const ok = await hs.connectFromAp('Casa', 'certa1234', { wait });
  assert.ok(ok.ok);
  assert.ok(!fs.existsSync(active), 'hotspot desligado');
  st = await hs.status();
  assert.strictEqual(st.active, false);
  assert.strictEqual(st.lastError, null);
});

test('assistente na rede de configuração: só idioma e Wi-Fi; responde antes de trocar de rede', async (t) => {
  const { hs } = sandbox(t);
  await hs.start('wlan0');
  const setup = require('../src/setup');
  let asked = null;
  const srv = setup.serve({ port: 0, host: '127.0.0.1', dataDir: process.env.DATA_DIR, lang: 'pt', connectFromAp: async (ssid, pass) => { asked = [ssid, pass]; return { ok: true }; } });
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  const g = await call('GET', '/api/setup');
  assert.strictEqual(g.json.hotspot.active, true);
  assert.deepStrictEqual(g.json.hotspot.networks.map((n) => n.ssid), ['Casa', 'Vizinho']);
  const bad = await call('POST', '/api/setup/wifi', { ssid: 'Casa', password: '123' });
  assert.strictEqual(bad.json.error, 'wifipass');
  const ok = await call('POST', '/api/setup/wifi', { ssid: 'Casa', password: 'certa1234' });
  assert.strictEqual(ok.json.ok, true);
  assert.strictEqual(ok.json.pending, true);
  assert.strictEqual(asked, null, 'só troca de rede depois de responder');
  await new Promise((r) => setTimeout(r, 1700));
  assert.deepStrictEqual(asked, ['Casa', 'certa1234']);
  // a página tem o passo do Wi-Fi
  const html = setup.page('pt', false);
  assert.ok(html.includes('data-s="w"') && html.includes('/api/setup/wifi'));
});

test('assistente fora do hotspot: sem passo de Wi-Fi e sem troca de rede', async (t) => {
  sandbox(t);
  const setup = require('../src/setup');
  const srv = setup.serve({ port: 0, host: '127.0.0.1', dataDir: process.env.DATA_DIR, lang: 'pt' });
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const get = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/setup' }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }));
  assert.strictEqual(get.hotspot, null);
  const post = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/setup/wifi', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); });
    req.end(JSON.stringify({ ssid: 'Casa', password: 'certa1234' }));
  });
  assert.strictEqual(post.status, 409);
  assert.strictEqual(post.json.error, 'nohotspot');
});
