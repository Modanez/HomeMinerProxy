// Minerador local opcional: liga/desliga o serviço mineracao-minerador conforme a opção.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
  const log = path.join(dir, 'calls.log'), state = path.join(dir, 'active');
  // systemctl falso: registra as chamadas e guarda se o serviço está ligado
  const fake = path.join(dir, 'systemctl');
  fs.writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  is-active|is-enabled) [ -f "${state}" ] && exit 0 || exit 3 ;;
  restart|enable) [ "$1" = restart ] && touch "${state}"; exit 0 ;;
  disable) rm -f "${state}"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  const minerd = path.join(dir, 'minerd'); fs.writeFileSync(minerd, '#!/bin/sh\n', { mode: 0o755 });
  const unit = path.join(dir, 'mineracao-minerador.service'); fs.writeFileSync(unit, '[Service]\n');
  Object.assign(process.env, { LOCAL_MINER_SYSTEMCTL: fake, MINERD_PATH: minerd, LOCAL_MINER_UNIT_FILE: unit });
  delete require.cache[require.resolve('../src/localminer')];
  t.after(() => { delete process.env.LOCAL_MINER_SYSTEMCTL; delete process.env.MINERD_PATH; delete process.env.LOCAL_MINER_UNIT_FILE; fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n'); } catch (_) { return []; } };
  return { dir, calls, lm: require('../src/localminer') };
}
const ADDR = 'bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w';

test('liga: grava o usuário e os núcleos e sobe o serviço; sem mudança não reinicia', async (t) => {
  const { dir, calls, lm } = sandbox(t);
  assert.strictEqual(lm.available(), true);
  const w = await lm.sync({ enabled: true, address: ADDR, worker: 'odroid', threads: '2', appDir: dir });
  assert.strictEqual(w, 'odroid');
  assert.match(fs.readFileSync(path.join(dir, 'minerador.env'), 'utf8'), new RegExp(`MINER_USER=${ADDR}\\.odroid\\nMINER_THREADS=${Math.min(2, lm.cores()) === 2 ? 2 : lm.defaultThreads()}\\nMINER_PORT=3333`));
  assert.deepStrictEqual(calls(), ['enable mineracao-minerador', 'is-active --quiet mineracao-minerador', 'restart mineracao-minerador']);
  await lm.sync({ enabled: true, address: ADDR, worker: 'odroid', threads: '2', appDir: dir });
  assert.strictEqual(calls().filter((c) => c.startsWith('restart')).length, 1);   // mesma configuração e rodando: não reinicia
});

test('desliga: para e desativa o serviço; nome inválido vira o nome do aparelho', async (t) => {
  const { dir, calls, lm } = sandbox(t);
  await lm.sync({ enabled: true, address: ADDR, worker: 'nome com espaço', threads: '999', appDir: dir });
  const env = fs.readFileSync(path.join(dir, 'minerador.env'), 'utf8');
  assert.match(env, new RegExp(`MINER_USER=${ADDR}\\.${lm.workerOf('').replace('.', '\\.')}\\n`));
  assert.match(env, new RegExp(`MINER_THREADS=${lm.defaultThreads()}\\n`));
  assert.strictEqual(await lm.sync({ enabled: false, address: ADDR, appDir: dir }), null);
  assert.ok(calls().includes('disable --now mineracao-minerador'));
});

test('sem cpuminer ou sem o serviço: não faz nada', async (t) => {
  const { dir, calls, lm } = sandbox(t);
  process.env.MINERD_PATH = path.join(dir, 'nao-existe');
  delete require.cache[require.resolve('../src/localminer')];
  const lm2 = require('../src/localminer');
  assert.strictEqual(lm2.available(), false);
  assert.strictEqual(await lm2.sync({ enabled: true, address: ADDR, appDir: dir }), null);
  assert.deepStrictEqual(calls(), []);
  assert.ok(lm);
});

test('assistente: passo "minerar também" só onde dá para minerar', () => {
  const setup = require('../src/setup');
  const base = { LANGUAGE: 'pt-BR', BTC_ADDRESS: ADDR, pin: '424242', pin2: '424242' };
  assert.ok(!('LOCAL_MINER' in setup.validate({ ...base, LOCAL_MINER: '1', MINER_THREADS: '1' }, '', null, false).values));
  assert.deepStrictEqual(setup.validate({ ...base, LOCAL_MINER: '1', MINER_THREADS: '1', LOCAL_WORKER: 'odroid' }, '', null, true).values,
    { LANGUAGE: 'pt-BR', BTC_ADDRESS: ADDR, LOCAL_MINER: '1', MINER_THREADS: '1', LOCAL_WORKER: 'odroid' });
  assert.strictEqual(setup.validate({ ...base, LOCAL_MINER: '0' }, '', null, true).values.LOCAL_MINER, '0');
  assert.deepStrictEqual(setup.validate({ ...base, LOCAL_MINER: '1', MINER_THREADS: '0', LOCAL_WORKER: 'a b' }, '', null, true).errors, { MINER_THREADS: 'threads', LOCAL_WORKER: 'name' });
});
