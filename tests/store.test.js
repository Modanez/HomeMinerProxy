// Gravação segura: arquivo sempre inteiro, .bak com a versão anterior, leitura que se recupera sozinha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'store-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('grava atômico: sem temporários sobrando, anterior vira .bak', (t) => {
  const d = tmp(t), f = path.join(d, 'records.json');
  store.writeJson(f, { v: 1 });
  assert.deepStrictEqual(store.readJson(f), { v: 1 });
  assert.ok(!fs.existsSync(f + '.bak'));
  store.writeJson(f, { v: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { v: 1 });
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['records.json', 'records.json.bak']);
  store.writeJson(f, { v: 3 }, { mode: 0o600 });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('arquivo cortado (energia caiu no meio de uma gravação antiga): lê o .bak e avisa', (t) => {
  const d = tmp(t), f = path.join(d, 'history.json');
  store.writeJson(f, [1, 2, 3]);
  store.writeJson(f, [1, 2, 3, 4]);
  fs.writeFileSync(f, '[1, 2, 3, 4');   // corrompido
  let why = null;
  assert.deepStrictEqual(store.readJson(f, [], { onRecover: (w) => { why = w; } }), [1, 2, 3]);
  assert.strictEqual(why, 'corrupt');
  // a próxima gravação conserta: arquivo novo inteiro
  store.writeJson(f, [9]);
  assert.deepStrictEqual(store.readJson(f, []), [9]);
});

test('queda entre as duas renomeações: o arquivo some, o .bak tem a versão anterior inteira', (t) => {
  const d = tmp(t), f = path.join(d, 'workers.json');
  store.writeJson(f, { a: 1 });
  fs.renameSync(f, f + '.bak');   // o que fica no disco se a energia cair entre as duas renomeações
  let why = null;
  assert.deepStrictEqual(store.readJson(f, {}, { onRecover: (w) => { why = w; } }), { a: 1 });
  assert.strictEqual(why, 'missing');
});

test('sem arquivo nem .bak: o padrão; .bak corrompido também: o padrão', (t) => {
  const d = tmp(t), f = path.join(d, 'x.json');
  assert.deepStrictEqual(store.readJson(f, { vazio: true }), { vazio: true });
  fs.writeFileSync(f, '{'); fs.writeFileSync(f + '.bak', '[');
  assert.strictEqual(store.readJson(f, null), null);
});

test('falha ao gravar não deixa temporário nem estraga o arquivo bom', (t) => {
  const d = tmp(t), f = path.join(d, 'ok.json');
  store.writeJson(f, { bom: true });
  const ciclico = {}; ciclico.eu = ciclico;
  assert.throws(() => store.writeJson(f, ciclico));
  assert.deepStrictEqual(store.readJson(f), { bom: true });
  assert.deepStrictEqual(fs.readdirSync(d), ['ok.json']);
  fs.mkdirSync(path.join(d, 'pasta.json'));   // destino impossível
  assert.throws(() => store.writeJson(path.join(d, 'pasta.json'), { a: 1 }, { backup: false }));
  assert.ok(!fs.readdirSync(d).some((n) => n.endsWith('.tmp')));
});
