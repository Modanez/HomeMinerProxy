// Relógio das placas sem bateria: o painel espera a hora passar do "piso" antes de coletar.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const clock = require('../src/clock');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('piso: data da instalação (version.json) ou o arquivo de dados mais novo', (t) => {
  const app = tmp(t), data = tmp(t);
  assert.strictEqual(clock.floor({ appDir: app, dataDir: data }), 0);   // nada: qualquer hora vale
  fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ version: '0.4.0', installedAt: '2026-11-05T12:00:00Z' }));
  assert.strictEqual(clock.floor({ appDir: app, dataDir: data }), Date.parse('2026-11-05T12:00:00Z'));
  const rec = path.join(data, 'records.json'); fs.writeFileSync(rec, '[]');
  const later = new Date('2026-12-01T00:00:00Z'); fs.utimesSync(rec, later, later);
  assert.strictEqual(clock.floor({ appDir: app, dataDir: data }), later.getTime());
  fs.writeFileSync(path.join(data, 'outro.json'), '{}');   // fora da lista: não conta
  assert.strictEqual(clock.floor({ appDir: app, dataDir: data }), later.getTime());
});

test('ok: hora antes do piso (com 1 h de tolerância) é hora errada', () => {
  const fl = Date.parse('2026-11-05T12:00:00Z');
  assert.ok(clock.ok(0, Date.parse('2026-08-15T03:08:00Z')));
  assert.ok(!clock.ok(fl, Date.parse('2026-08-15T03:08:00Z')));   // o Odroid ligando em 15 de agosto
  assert.ok(clock.ok(fl, fl - 30 * 60e3));
  assert.ok(clock.ok(fl, fl + 1));
});

test('waitOk: com a hora certa não espera; atrasada espera e desiste no limite', async (t) => {
  const app = tmp(t);
  assert.deepStrictEqual(await clock.waitOk({ appDir: app, dataDir: app, timeoutMs: 50, stepMs: 10 }), { ok: true, waitedMs: 0, floor: 0 });
  fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ installedAt: new Date(Date.now() + 86400e3).toISOString() }));   // "instalado amanhã"
  let warned = 0;
  const r = await clock.waitOk({ appDir: app, timeoutMs: 60, stepMs: 20, onWait: () => warned++ });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.waitedMs, 60);
  assert.strictEqual(warned, 1);
  process.env.CLOCK_WAIT = '0';
  t.after(() => { delete process.env.CLOCK_WAIT; });
  assert.strictEqual((await clock.waitOk({ appDir: app, timeoutMs: 60, stepMs: 20 })).ok, true);
});

test('waitOk: segue assim que o NTP acerta a hora', async (t) => {
  const app = tmp(t);
  const realNow = Date.now;
  let fake = Date.parse('2026-08-15T03:08:00Z');
  Date.now = () => fake;
  t.after(() => { Date.now = realNow; });
  fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ installedAt: '2026-11-05T12:00:00Z' }));
  setTimeout(() => { fake = Date.parse('2026-11-05T17:21:00Z'); }, 30);   // o NTP sincronizou
  const r = await clock.waitOk({ appDir: app, timeoutMs: 5000, stepMs: 10 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.waitedMs < 1000);
});
