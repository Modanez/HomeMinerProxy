// Aba 🌐 Rede: Wi-Fi (nmcli) e Tailscale, com binários falsos.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

function sandbox(t, { wifi = true, tsState = 'NeedsLogin' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
  const log = path.join(dir, 'calls.log'), active = path.join(dir, 'tsactive'), conn = path.join(dir, 'conn');
  const sh = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 }); return f; };
  const nmcli = sh('nmcli', `
case "$*" in
  "-t -f DEVICE,TYPE,STATE,CONNECTION device")
    echo "eth0:ethernet:connected:Wired connection 1"
    ${wifi ? `if [ -f "${conn}" ]; then echo "wlan0:wifi:connected:$(sed 's/:/\\\\:/g' "${conn}")"; else echo "wlan0:wifi:disconnected:--"; fi` : ''}
    echo "lo:loopback:connected (externally):lo" ;;
  *"wifi list"*)
    echo "Casa\\\\:5G:72:WPA2:"; echo "Casa\\\\:5G:40:WPA2:"; echo ":30:WPA2:"; echo "Vizinho:55:--:" ;;
  "device wifi connect Casa:5G password certa123") printf 'Casa:5G' > "${conn}" ;;
  "device wifi connect Casa:5G password"*) echo "Error: Secrets were required, but not provided." >&2; exit 4 ;;
  "device wifi connect Sumiu"*) echo "Error: No network with SSID 'Sumiu' found." >&2; exit 10 ;;
  "connection delete id Casa:5G") rm -f "${conn}" ;;
esac`);
  const systemctl = sh('systemctl', `
case "$1" in
  is-active) [ -f "${active}" ] ;;
  enable) touch "${active}" ;;
  disable) rm -f "${active}" ;;
esac`);
  const tailscale = sh('tailscale', `
case "$1" in
  status) echo '{"BackendState":"${tsState}","AuthURL":"https://login.tailscale.com/a/abc123","Self":{"DNSName":"homeminer.tail1234.ts.net.","TailscaleIPs":["100.64.0.7"]}}' ;;
esac`);
  Object.assign(process.env, { NMCLI_PATH: nmcli, TAILSCALE_PATH: tailscale, NET_SYSTEMCTL: systemctl });
  delete require.cache[require.resolve('../src/netctl')];
  t.after(() => { delete process.env.NMCLI_PATH; delete process.env.TAILSCALE_PATH; delete process.env.NET_SYSTEMCTL; fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n'); } catch (_) { return []; } };
  return { net: require('../src/netctl'), calls, dir };
}

test('splitTerse respeita o escape do nmcli', () => {
  const { splitTerse } = require('../src/netctl');
  assert.deepStrictEqual(splitTerse('a\\:b:c\\\\d:'), ['a:b', 'c\\d', '']);
});

test('Wi-Fi: estado, procura (sem ocultas, sem repetidas), conexão, senha errada, rede sumida, esquecer', async (t) => {
  const { net, calls } = sandbox(t);
  assert.deepStrictEqual(await net.wifiStatus(), { available: true, device: 'wlan0', connected: false, ssid: null, ip: null, wired: true });
  const scan = await net.wifiScan();
  assert.deepStrictEqual(scan.networks, [{ ssid: 'Casa:5G', signal: 72, secure: true, inUse: false }, { ssid: 'Vizinho', signal: 55, secure: false, inUse: false }]);
  assert.deepStrictEqual(await net.wifiConnect('', 'x'), { ok: false, error: 'ssid' });
  assert.deepStrictEqual(await net.wifiConnect('Casa:5G', 'curta'), { ok: false, error: 'wifipass' });
  assert.deepStrictEqual(await net.wifiConnect('Casa:5G', 'errada12'), { ok: false, error: 'wifiauth' });
  assert.deepStrictEqual(await net.wifiConnect('Sumiu', 'qualquer1'), { ok: false, error: 'wifinotfound' });
  assert.deepStrictEqual(await net.wifiConnect('Casa:5G', 'certa123'), { ok: true });
  const st = await net.wifiStatus();
  assert.strictEqual(st.connected, true); assert.strictEqual(st.ssid, 'Casa:5G');
  assert.deepStrictEqual(await net.wifiForget(), { ok: true });
  assert.strictEqual((await net.wifiStatus()).connected, false);
  // a senha vai como argumento, nunca por um shell
  assert.ok(calls().includes('nmcli device wifi connect Casa:5G password certa123'));
});

test('sem adaptador Wi-Fi ou sem nmcli', async (t) => {
  const { net } = sandbox(t, { wifi: false });
  assert.deepStrictEqual(await net.wifiStatus(), { available: false, reason: 'noadapter' });
  process.env.NMCLI_PATH = '/nao/existe/nmcli';
  assert.deepStrictEqual(await net.wifiStatus(), { available: false });
});

test('Tailscale: desligado → conectar (link só com withUrl) → desconectar', async (t) => {
  const { net, calls } = sandbox(t);
  assert.deepStrictEqual(await net.tailscaleStatus(), { available: true, state: 'off' });
  const r = await net.tailscaleConnect('homeminer');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status.state, 'login');
  assert.strictEqual(r.status.authUrl, 'https://login.tailscale.com/a/abc123');
  assert.ok(calls().includes('systemctl enable --now tailscaled'));
  assert.ok(calls().includes('tailscale up --hostname=homeminer --timeout=15s'));
  assert.ok(!('authUrl' in await net.tailscaleStatus()));   // sem PIN, sem link
  assert.deepStrictEqual(await net.tailscaleDisconnect(), { ok: true });
  assert.ok(calls().includes('tailscale logout'));
  assert.strictEqual((await net.tailscaleStatus()).state, 'off');
});

test('Tailscale conectado mostra o nome e o IP; sem tailscale instalado', async (t) => {
  const { net } = sandbox(t, { tsState: 'Running' });
  await net.tailscaleConnect('home miner!');
  const st = await net.tailscaleStatus({ withUrl: true });
  assert.deepStrictEqual(st, { available: true, state: 'connected', name: 'homeminer.tail1234.ts.net', ips: ['100.64.0.7'] });
  process.env.TAILSCALE_PATH = '/nao/existe/tailscale';
  assert.deepStrictEqual(await net.tailscaleStatus(), { available: false });
  assert.deepStrictEqual(await net.tailscaleConnect(), { ok: false, error: 'notailscale' });
});

function sshSandbox(t, { active = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-'));
  const log = path.join(dir, 'calls.log'), on = path.join(dir, 'on');
  if (active) fs.writeFileSync(on, '');
  const sh = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 }); return f; };
  const env = {
    SSHD_PATH: sh('sshd', ''), SSH_KEYGEN: sh('ssh-keygen', ''), SSH_DIR: path.join(dir, 'root-ssh'), SSHD_DROPIN: path.join(dir, 'sshd_config.d', '10-homeminer.conf'),
    NET_SYSTEMCTL: sh('systemctl', `case "$1" in is-active) [ -f "${on}" ] ;; enable) touch "${on}" ;; disable) rm -f "${on}" ;; esac`),
  };
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/netctl')];
  t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n'); } catch (_) { return []; } };
  return { net: require('../src/netctl'), env, calls };
}
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBx5oUqZ8yN7rTq2mW3vKp9sLd4fGh6jK8lM0nP2qR4s paulo@mac';

test('SSH pelo painel: só com chave, senha desligada, desligar desfaz', async (t) => {
  const { net, env, calls } = sshSandbox(t);
  assert.deepStrictEqual(await net.sshStatus(), { available: true, active: false, managed: false, keys: [] });
  assert.deepStrictEqual(await net.sshEnable(''), { ok: false, error: 'sshkey' });                      // sem chave nenhuma
  assert.deepStrictEqual(await net.sshEnable('-----BEGIN OPENSSH PRIVATE KEY-----'), { ok: false, error: 'sshkey' });
  assert.deepStrictEqual(await net.sshEnable(KEY + '\ncommand="x" ssh-rsa AAAA'), { ok: false, error: 'sshkey' });   // uma linha só
  const r = await net.sshEnable('  ' + KEY + '\n');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.status, { available: true, active: true, managed: true, keys: ['paulo@mac …lM0nP2qR4s'.replace('lM0nP2qR4s', KEY.split(' ')[1].slice(-8))] });
  const ak = path.join(env.SSH_DIR, 'authorized_keys');
  assert.strictEqual(fs.readFileSync(ak, 'utf8'), KEY + '\n');
  assert.strictEqual(fs.statSync(ak).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(env.SSH_DIR).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(env.SSHD_DROPIN, 'utf8'), /PasswordAuthentication no/);
  assert.ok(calls().includes('ssh-keygen -A') && calls().includes('systemctl enable --now ssh'));
  await net.sshEnable(KEY);                                                                              // a mesma chave não repete
  assert.strictEqual(fs.readFileSync(ak, 'utf8'), KEY + '\n');
  const off = await net.sshDisable();
  assert.strictEqual(off.status.active, false);
  assert.ok(!fs.existsSync(env.SSHD_DROPIN));
});

test('SSH ligado por fora do painel: só acrescenta a chave, não mexe na configuração', async (t) => {
  const { net, env, calls } = sshSandbox(t, { active: true });
  const r = await net.sshEnable(KEY);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status.managed, false);
  assert.ok(!fs.existsSync(env.SSHD_DROPIN));
  assert.ok(!calls().some((c) => /enable --now/.test(c)));
});
