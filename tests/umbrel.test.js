// O app do Umbrel (pasta umbrel/) tem de acompanhar o proxy: as portas abertas são as das rotas padrão.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'umbrel');
const compose = fs.readFileSync(path.join(dir, 'modanez-homeminerproxy', 'docker-compose.yml'), 'utf8');
const manifest = fs.readFileSync(path.join(dir, 'modanez-homeminerproxy', 'umbrel-app.yml'), 'utf8');

test('Umbrel: portas do docker-compose = portas das rotas padrão do proxy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'proxy.js'), 'utf8');
  const routes = src.slice(src.indexOf('const ROUTES ='), src.indexOf('];', src.indexOf('const ROUTES =')));
  const want = [...routes.matchAll(/listen: (\d+)/g)].map((m) => Number(m[1])).sort();
  const open = [...compose.matchAll(/- "(\d+):(\d+)"/g)].map((m) => { assert.strictEqual(m[1], m[2]); return Number(m[1]); }).sort();
  assert.deepStrictEqual(open, want);
});

test('Umbrel: manifesto e compose coerentes', () => {
  const id = /^id: (\S+)/m.exec(manifest)[1];
  assert.strictEqual(id, 'modanez-homeminerproxy');
  assert.ok(id.startsWith(/^id: "(\w+)"/m.exec(fs.readFileSync(path.join(dir, 'umbrel-app-store.yml'), 'utf8'))[1] + '-'), 'id do app começa com o id da loja');
  assert.match(compose, new RegExp(`APP_HOST: ${id}_painel_1`));
  assert.match(compose, new RegExp(`PROXY_URL: http://${id}_proxy_1:3336/stats`));
  assert.match(/^version: "([^"]+)"/m.exec(manifest)[1], /^\d+\.\d+\.\d+$/);
  assert.ok(!/restart: on-failure/.test(compose), 'o painel sai com 0 para reiniciar: precisa de unless-stopped');
});

// O Umbrel cria a pasta de dados do app com dono 1000:1000 só se ela vier no pacote (data/.gitkeep);
// sem ela, o Docker cria como root e o painel (usuário node, 1000) não consegue gravar: EACCES no assistente.
test('umbrel: pasta de dados no pacote e serviços como 1000:1000', () => {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'umbrel', 'modanez-homeminerproxy');
  assert.ok(fs.existsSync(path.join(dir, 'data', '.gitkeep')));
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  assert.strictEqual((compose.match(/user: "1000:1000"/g) || []).length, 2);
});
