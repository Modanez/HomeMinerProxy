// Tela de configurações: validação, gravação por cima do .env, PIN, backup/restauração e o ciclo salvar → reiniciar.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const st = require('../src/settings');

const ADDR = 'bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w';
const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefghijklmno';
const field = (k) => st.FIELDS.find((f) => f.key === k);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));

test('validação dos campos', () => {
  assert.deepStrictEqual(st.clean(field('BTC_ADDRESS'), ' ' + ADDR.toUpperCase() + ' '), { value: ADDR });
  assert.deepStrictEqual(st.clean(field('BTC_ADDRESS'), '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), { value: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' });
  assert.ok(st.clean(field('BTC_ADDRESS'), 'bc1q; rm -rf /').error);
  assert.ok(st.clean(field('BTC_ADDRESS'), '').error);
  assert.deepStrictEqual(st.clean(field('POWER_PRICE_KWH'), '0,90'), { value: '0.9' });
  assert.ok(st.clean(field('POWER_PRICE_KWH'), '-1').error);
  assert.deepStrictEqual(st.clean(field('LANGUAGE'), 'pt-BR'), { value: 'pt-BR' });
  assert.ok(st.clean(field('LANGUAGE'), 'fr').error);
  assert.deepStrictEqual(st.clean(field('ALARM_IGNORE'), ['macbook', 'macbook', ' tablet ']), { value: 'macbook,tablet' });
  assert.ok(st.clean(field('ALARM_IGNORE'), ['a b']).error);
  // WATTS e EXPECTED por worker
  assert.deepStrictEqual(st.clean(field('WATTS'), { nerdminer: '1,5', bitaxe: 20, vazio: '' }), { value: '{"bitaxe":20,"nerdminer":1.5}' });
  assert.deepStrictEqual(st.clean(field('WATTS'), {}), { value: '' });
  assert.ok(st.clean(field('WATTS'), { bitaxe: -5 }).error);
  assert.ok(st.clean(field('WATTS'), { 'bad name': 10 }).error);
  assert.ok(st.clean(field('WATTS'), '{invalido').error);
  assert.deepStrictEqual(st.clean(field('EXPECTED'), { bitaxe: '1,2 TH/s', nerdminer: '350 kH/s', macbook: '9M', devkit: 0, vazio: '' }),
    { value: '{"bitaxe":1200000000000,"devkit":0,"macbook":9000000,"nerdminer":350000}' });
  assert.deepStrictEqual(st.clean(field('EXPECTED'), ''), { value: '' });
  assert.ok(st.clean(field('EXPECTED'), { bitaxe: 'muito' }).error);
  assert.ok(st.clean(field('EXPECTED'), { 'bad/name': '1T' }).error);
  assert.deepStrictEqual(st.clean(field('CUBE_IP'), '192.168.0.136'), { value: '192.168.0.136' });
  assert.deepStrictEqual(st.clean(field('CUBE_IP'), 'cubo.local'), { value: 'cubo.local' });
  assert.ok(st.clean(field('CUBE_IP'), '192.168.0.999').error);
  assert.ok(st.clean(field('CUBE_IP'), 'http://x').error);
  assert.deepStrictEqual(st.clean(field('TELEGRAM_BOT_TOKEN'), TOKEN), { value: TOKEN });
  assert.ok(st.clean(field('TELEGRAM_BOT_TOKEN'), 'abc').error);
  for (const pasted of [' ' + TOKEN + '\n', '"' + TOKEN + '"', 'bot' + TOKEN, 'https://api.telegram.org/bot' + TOKEN + '/getMe', TOKEN.slice(0, 20) + ' ' + TOKEN.slice(20)]) {
    assert.deepStrictEqual(st.clean(field('TELEGRAM_BOT_TOKEN'), pasted), { value: TOKEN }, pasted);   // do jeito que costuma vir colado
  }
  assert.ok(st.clean(field('TELEGRAM_BOT_TOKEN'), 'senhaSalvaDoNavegador123').error);
  assert.deepStrictEqual(st.clean(field('TELEGRAM_CHAT_ID'), '42, -100123'), { value: '42,-100123' });
  assert.ok(st.clean(field('TELEGRAM_CHAT_ID'), '@paulo').error);
  assert.deepStrictEqual(st.clean(field('TELEGRAM_DAILY'), ''), { value: 'off' });
  assert.deepStrictEqual(st.clean(field('TELEGRAM_DAILY'), '07'), { value: '7' });
  assert.ok(st.clean(field('TELEGRAM_DAILY'), '24').error);
  assert.deepStrictEqual(st.clean(field('TELEGRAM_PERSONAL'), true), { value: '1' });
  assert.ok(st.clean(field('TELEGRAM_PANEL_URL'), 'javascript:alert(1)').error);
});

test('só o que mudou vai para o settings.json, por cima do .env', () => {
  const dir = tmp();
  const env = {
    BTC_ADDRESS: ADDR, TARIFA_KWH: '0.90', LANGUAGE: 'pt-BR', CURRENCY: 'BRL',
    ALARM_IGNORE: 'macbook', WATTS: '{"nerdminer": 1, "bitaxe": 20}', EXPECTED: '{"bitaxe": 1.2e12}',
    CUBE_IP: '192.168.0.136', LOCAL_WORKER: 'odroid',
  };
  st.applyOverlay(dir, env);
  const cur = st.current(env);
  assert.strictEqual(cur.POWER_PRICE_KWH, '0.90');        // nome antigo (TARIFA_KWH) aparece no campo novo
  assert.deepStrictEqual(cur.ALARM_IGNORE, ['macbook']);
  assert.deepStrictEqual(cur.WATTS, { bitaxe: 20, nerdminer: 1 });
  assert.deepStrictEqual(cur.EXPECTED, { bitaxe: 1.2e12 });
  assert.strictEqual(cur.TELEGRAM_DAILY, '21');           // padrão quando não definido
  assert.deepStrictEqual(cur.TELEGRAM_BOT_TOKEN, { set: false });

  // mandar o formulário inteiro sem mudar nada não grava nada (mesmo se o JSON do .env tinha outra ordem de chaves)
  const same = { ...cur, WATTS: { bitaxe: '20', nerdminer: '1' }, EXPECTED: { bitaxe: '1.2T' }, TELEGRAM_BOT_TOKEN: '', TELEGRAM_PERSONAL: false };
  assert.deepStrictEqual(st.merge(dir, same, { ...env }).overlay, {});

  let r = st.merge(dir, {
    ...same, CURRENCY: 'USD', POWER_PRICE_KWH: '0,15',
    WATTS: { bitaxe: 22, nerdminer: 1 }, EXPECTED: { bitaxe: '1.5 TH/s', nerdminer: '350k' },
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_DAILY: '',
  }, env);
  assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.overlay, {
    CURRENCY: 'USD', POWER_PRICE_KWH: '0.15',
    WATTS: '{"bitaxe":22,"nerdminer":1}', EXPECTED: '{"bitaxe":1500000000000,"nerdminer":350000}',
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_DAILY: 'off',
  });
  st.save(dir, r.overlay);
  assert.strictEqual((fs.statSync(path.join(dir, 'settings.json')).mode & 0o777).toString(8), '600');   // tem o token

  // reinício: o overlay vale por cima do .env, e o token nunca aparece inteiro
  const env2 = { BTC_ADDRESS: ADDR, TARIFA_KWH: '0.90', LANGUAGE: 'pt-BR', CURRENCY: 'BRL', WATTS: '{"nerdminer": 1, "bitaxe": 20}', EXPECTED: '{"bitaxe": 1.2e12}' };
  st.applyOverlay(dir, env2);
  assert.strictEqual(env2.CURRENCY, 'USD');
  const cur2 = st.current(env2);
  assert.deepStrictEqual(cur2.WATTS, { bitaxe: 22, nerdminer: 1 });
  assert.deepStrictEqual(cur2.EXPECTED, { bitaxe: 1.5e12, nerdminer: 350000 });
  assert.deepStrictEqual(cur2.TELEGRAM_BOT_TOKEN, { set: true, tail: TOKEN.slice(-4) });
  assert.strictEqual(cur2.TELEGRAM_DAILY, '');
  assert.ok(!JSON.stringify(cur2).includes(TOKEN));

  // token vazio = manter; voltar a moeda, WATTS e EXPECTED para os do .env tira as chaves do arquivo; remover o token
  r = st.merge(dir, { TELEGRAM_BOT_TOKEN: '', CURRENCY: 'BRL', WATTS: { bitaxe: 20, nerdminer: 1 }, EXPECTED: { bitaxe: '1.2T' } }, env2);
  assert.deepStrictEqual(r.overlay, { POWER_PRICE_KWH: '0.15', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_DAILY: 'off' });
  r = st.merge(dir, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN_clear: true }, env2);
  assert.ok(!('TELEGRAM_BOT_TOKEN' in r.overlay));            // o .env não tem token: basta tirar do arquivo
  const env3 = { BTC_ADDRESS: ADDR, TELEGRAM_BOT_TOKEN: TOKEN };   // token no .env: remover pela tela grava vazio por cima
  st.applyOverlay(tmp(), env3);
  assert.strictEqual(st.merge(dir, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN_clear: true }, env3).overlay.TELEGRAM_BOT_TOKEN, '');
  st.applyOverlay(dir, env2);
  assert.deepStrictEqual(st.merge(dir, { BTC_ADDRESS: 'xyz', CUBE_IP: '1.2.3' }, env2).errors, { BTC_ADDRESS: 'address', CUBE_IP: 'host' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup e restauração: exporta, valida e restaura os arquivos da fazenda', () => {
  const dir1 = tmp(), dir2 = tmp();
  st.save(dir1, { CURRENCY: 'USD', WATTS: '{"bitaxe":20}' });
  fs.writeFileSync(path.join(dir1, 'workers.json'), JSON.stringify({ bitaxe: { name: 'bitaxe', hashRate: 1.2e12, hrBy: 'pool', bestDifficulty: 4096, lastSeen: '2026-11-03T12:00:00.000Z', pool: 'ckpool solo' } }));
  fs.writeFileSync(path.join(dir1, 'records.json'), JSON.stringify([{ worker: 'bitaxe', value: 4096, at: '2026-11-03T12:00:00.000Z' }]));
  fs.writeFileSync(path.join(dir1, 'history.json'), JSON.stringify([{ t: 1762170000000, hr: 1200000000000 }]));

  const bkp = st.exportBackup(dir1);
  assert.strictEqual(bkp.version, 1);
  assert.strictEqual(bkp.data.settings.CURRENCY, 'USD');
  assert.strictEqual(bkp.data.records[0].value, 4096);

  // rejeita backups adulterados ou malformados
  assert.ok(st.restoreBackup(dir2, null).error);
  assert.ok(st.restoreBackup(dir2, { version: 2, data: {} }).error);
  assert.ok(st.restoreBackup(dir2, { version: 1, data: {} }).error);
  assert.ok(st.restoreBackup(dir2, { version: 1, data: { settings: { BTC_ADDRESS: 'invalido' } } }).error);
  assert.ok(st.restoreBackup(dir2, { version: 1, data: { workers: { '../etc/passwd': { hashRate: 1 } } } }).error);
  assert.ok(st.restoreBackup(dir2, { version: 1, data: { records: [{ worker: 'x', value: -1 }] } }).error);

  const env2 = { BTC_ADDRESS: ADDR };
  const res = st.restoreBackup(dir2, bkp, env2);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(env2.CURRENCY, 'USD');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir2, 'records.json'), 'utf8')), bkp.data.records);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir2, 'workers.json'), 'utf8')), bkp.data.workers);
  assert.strictEqual((fs.statSync(path.join(dir2, 'settings.json')).mode & 0o777).toString(8), '600');

  fs.rmSync(dir1, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('PIN: certo, errado e bloqueio depois de 5 erros', () => {
  st.resetPinFails();
  assert.strictEqual(st.checkPin('1', ''), 'nopin');
  assert.strictEqual(st.checkPin('123456', '123456'), 'ok');
  for (let i = 0; i < 5; i++) assert.strictEqual(st.checkPin('000000', '123456'), 'wrong');
  assert.strictEqual(st.checkPin('123456', '123456'), 'locked');
  assert.strictEqual(st.checkPin('123456', '123456', Date.now() + 16 * 60e3), 'ok');
  st.resetPinFails();
});

test('página nos dois idiomas, sem PIN só leitura, script válido', () => {
  const pt = st.page('pt', true), en = st.page('en', true);
  assert.match(pt, /Configurações[\s\S]*Consumo por worker[\s\S]*new_worker_watts[\s\S]*new_worker_hr[\s\S]*Backup e restauração[\s\S]*Salvar e reiniciar/);
  assert.match(en, /Settings[\s\S]*Power per worker[\s\S]*new_worker_watts[\s\S]*new_worker_hr[\s\S]*Backup and restore[\s\S]*Save and restart/);
  assert.doesNotMatch(st.page('pt', false), /id="save"/);
  assert.match(st.page('pt', false), /SETTINGS_PIN/);
  for (const html of [pt, en]) {
    const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(code));
  }
});

test('o cubo lê CUBE_IP e LANGUAGE do settings.json', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ CUBE_IP: '10.0.0.9', LANGUAGE: 'en', BTC_ADDRESS: ADDR }));
  const r = spawnSync('python3', ['-c', 'import cubo; print(cubo.CUBE_IP, cubo.LANG)'], {
    cwd: path.join(__dirname, '../src'), env: { ...process.env, DATA_DIR: dir, CUBE_IP: '192.168.0.136', LANGUAGE: 'pt-BR' }, encoding: 'utf8',
  });
  if (/No module named 'PIL'/.test(r.stderr)) return;   // sem Pillow nesta máquina
  assert.strictEqual(r.stdout.trim(), '10.0.0.9 en');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- de ponta a ponta no painel
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const req = (port, method, url, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('error', rej); r.end(data);
});
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) { /* ainda subindo */ } if (Date.now() > end) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 100)); } };

test('salvar pela tela (incluindo WATTS/EXPECTED) e backup/restore gravam, reiniciam e voltam com os valores novos', async (t) => {
  const port = await freePort();
  const dir = tmp();
  const env = { ...process.env, BTC_ADDRESS: ADDR, PORT: String(port), DATA_DIR: dir, PROXY_URL: '', ALARM_PORT: path.join(dir, 'x'), CKPOOL_URLS: '', OCEAN_API: '',
    SETTINGS_PIN: '424242', LANGUAGE: 'pt-BR', CURRENCY: 'BRL', TELEGRAM_BOT_TOKEN: '', TELEGRAM_API: 'http://127.0.0.1:9' };
  const run = () => spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/offline.js'), path.join(__dirname, '../src/painel.js')], { env, stdio: 'ignore' });
  let p = run();
  t.after(() => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const pageRes = await waitFor(() => req(port, 'GET', '/config'));
  assert.strictEqual(pageRes.status, 200);
  assert.match(pageRes.body, /Configurações/);
  const main = await req(port, 'GET', '/?lang=pt');
  assert.match(main.body, /href="\/config"/);
  const boot1 = JSON.parse((await req(port, 'GET', '/api/mining')).body).boot;

  const cfg = JSON.parse((await req(port, 'GET', '/api/config')).body);
  assert.strictEqual(cfg.values.BTC_ADDRESS, ADDR);
  assert.strictEqual(cfg.pin, true);

  assert.strictEqual((await req(port, 'POST', '/api/config', { pin: '1', values: { CURRENCY: 'USD' } })).status, 403);
  const bad = await req(port, 'POST', '/api/config', { pin: '424242', values: { CURRENCY: 'EUR' } });
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(JSON.parse(bad.body).errors, { CURRENCY: 'option' });
  // sem JSON (formulário de outro site) não passa
  const form = await new Promise((res) => { const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/config', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, (x) => { x.resume(); res(x.statusCode); }); r.end('pin=424242'); });
  assert.strictEqual(form, 405);
  const tg = await req(port, 'POST', '/api/config/test', { pin: '424242', what: 'telegram', values: { TELEGRAM_CHAT_ID: 'ModanezMinerBot' } });
  assert.deepStrictEqual(JSON.parse(tg.body).errors, { TELEGRAM_CHAT_ID: 'chatid' });   // nome do bot no lugar do id

  const exited = new Promise((res) => p.once('exit', res));
  const ok = await req(port, 'POST', '/api/config', {
    pin: '424242',
    values: { CURRENCY: 'USD', ALARM_IGNORE: ['macbook'], WATTS: { bitaxe: 18 }, EXPECTED: { bitaxe: '1.2T' } },
  });
  assert.deepStrictEqual(JSON.parse(ok.body), { ok: true, restart: true });
  assert.strictEqual(await exited, 0);   // systemd / Docker sobem de novo
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), {
    CURRENCY: 'USD', ALARM_IGNORE: 'macbook', WATTS: '{"bitaxe":18}', EXPECTED: '{"bitaxe":1200000000000}',
  });

  p = run();
  const snap = await waitFor(async () => JSON.parse((await req(port, 'GET', '/api/mining')).body));
  assert.notStrictEqual(snap.boot, boot1);   // a página percebe e recarrega
  assert.ok(snap.farm.workers.some((w) => w.name === 'bitaxe' && w.nominal === 1.2e12), 'worker esperado entrou no painel');
  const cfg2 = JSON.parse((await req(port, 'GET', '/api/config')).body);
  assert.strictEqual(cfg2.values.CURRENCY, 'USD');
  assert.deepStrictEqual(cfg2.values.ALARM_IGNORE, ['macbook']);
  assert.deepStrictEqual(cfg2.values.WATTS, { bitaxe: 18 });
  assert.deepStrictEqual(cfg2.values.EXPECTED, { bitaxe: 1.2e12 });
  assert.ok(cfg2.workers.includes('bitaxe'));

  // exportar backup e restaurar com um recorde novo
  const bkpRes = JSON.parse((await req(port, 'POST', '/api/config/backup', { pin: '424242' })).body);
  assert.strictEqual(bkpRes.ok, true);
  assert.strictEqual(bkpRes.backup.data.settings.WATTS, '{"bitaxe":18}');

  bkpRes.backup.data.records = [{ worker: 'bitaxe', value: 77777, at: '2026-11-03T15:00:00.000Z' }];
  const exited2 = new Promise((res) => p.once('exit', res));
  const restRes = JSON.parse((await req(port, 'POST', '/api/config/restore', { pin: '424242', backup: bkpRes.backup })).body);
  assert.strictEqual(restRes.ok, true);
  assert.strictEqual(await exited2, 0);

  p = run();
  const snap2 = await waitFor(async () => JSON.parse((await req(port, 'GET', '/api/mining')).body));
  assert.strictEqual(snap2.farm.best, 77777);
});
