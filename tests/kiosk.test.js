// Tela ligada na placa (KIOSK): com systemctl e apt falsos.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

function sandbox(t, { unit = true, apt = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  const log = path.join(dir, 'calls.log');
  const sc = path.join(dir, 'systemctl'), ap = path.join(dir, 'apt-get');
  fs.writeFileSync(sc, `#!/bin/sh\necho "systemctl $*" >> "${log}"\ncase "$*" in "is-active --quiet"*|"is-enabled --quiet"*) [ -f "${dir}/on" ] || exit 3 ;; "enable --now"*|"start"*) touch "${dir}/on" ;; "disable --now"*) rm -f "${dir}/on" ;; esac\n`, { mode: 0o755 });
  fs.writeFileSync(ap, `#!/bin/sh\necho "apt $*" >> "${log}"\nexit ${apt}\n`, { mode: 0o755 });
  const unitFile = path.join(dir, 'mineracao-kiosk.service');
  if (unit) fs.writeFileSync(unitFile, '[Unit]\n');
  const drm = path.join(dir, 'drm'); fs.mkdirSync(path.join(drm, 'card0-HDMI-A-1'), { recursive: true });
  fs.writeFileSync(path.join(drm, 'card0-HDMI-A-1', 'status'), 'connected\n');
  const prev = {};
  const env = { KIOSK_UNIT_FILE: unitFile, KIOSK_SYSTEMCTL: sc, KIOSK_APT: ap, KIOSK_DRM_DIR: drm };
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  delete require.cache[require.resolve('../src/kiosk')];
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; } fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n'); } catch (_) { return []; } };
  return { ks: require('../src/kiosk'), calls, dir, drm };
}
const wait = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30)); };

test('sem o serviço (Docker): não aparece e não mexe em nada', async (t) => {
  const { ks, calls, dir } = sandbox(t, { unit: false });
  assert.strictEqual(ks.available(), false);
  assert.strictEqual((await ks.sync({ enabled: true, dataDir: dir })).reason, 'nounit');
  assert.deepStrictEqual(calls(), []);
});

test('ligar sem o navegador: instala pelo apt em segundo plano e mostra "instalando"', async (t) => {
  const { ks, calls, dir } = sandbox(t);
  if (ks.installed()) return t.skip('cage e chromium já instalados nesta máquina');
  assert.strictEqual(ks.available(), true);
  const r = await ks.sync({ enabled: true, dataDir: dir });
  assert.strictEqual(r.installing, true);
  assert.strictEqual(ks.status(dir).installing, true);
  await wait(() => calls().some((c) => c.includes('install')));
  await wait(() => !ks.status(dir).installing);
  assert.ok(calls().some((c) => /^apt install -y -q --no-install-recommends cage chromium/.test(c)));
  // o apt "terminou" mas o cage não apareceu (apt falso): fica o erro e o serviço não liga
  assert.ok(ks.status(dir).error);
  assert.ok(!calls().some((c) => c.startsWith('systemctl enable')));
});

test('desligar: desliga o serviço se estava ligado', async (t) => {
  const { ks, calls, dir } = sandbox(t);
  fs.writeFileSync(path.join(dir, 'on'), '');
  await ks.sync({ enabled: false, dataDir: dir });
  assert.ok(calls().includes('systemctl disable --now mineracao-kiosk'));
  assert.ok(!fs.existsSync(path.join(dir, 'on')));
});

test('tela no HDMI: conectada, desconectada ou sem como saber', (t) => {
  const { ks, drm } = sandbox(t);
  assert.strictEqual(ks.screen(), true);
  fs.writeFileSync(path.join(drm, 'card0-HDMI-A-1', 'status'), 'disconnected\n');
  assert.strictEqual(ks.screen(), false);
  assert.strictEqual(ks.screen(path.join(drm, 'nada')), null);
});
