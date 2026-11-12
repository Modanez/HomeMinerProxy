// Idiomas: a tradução para o inglês cobre a página inteira e a página traduzida continua válida.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EN, localizePage, pickLang } = require('../src/i18n');

const src = fs.readFileSync(path.join(__dirname, '../src/painel.js'), 'utf8');
const PAGE = src.slice(src.indexOf('const PAGE = `') + 14, src.indexOf('</html>`;') + 7);
const script = (html) => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
const noComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '');

test('todo trecho da tabela EN existe na página em português', () => {
  const missing = EN.filter(([pt]) => !PAGE.includes(pt)).map(([pt]) => pt);
  assert.deepStrictEqual(missing, []);
});

test('o script da página compila nos dois idiomas', () => {
  for (const lang of ['pt', 'en']) {
    assert.doesNotThrow(() => new vm.Script(script(localizePage(PAGE, lang, 'USD'))), `script em ${lang}`);
  }
});

test('a página em inglês não tem sobras em português', () => {
  const en = noComments(localizePage(PAGE, 'en', 'USD'));
  const pt = /[ãõçáéíóúâêô]|\b(faltam|bloco|blocos|agora|parado|nenhum|recorde|fazenda|vezes|hoje|último|carregando|dificuldade|carteira|saldo|melhor|atualizado|teste)\b/i;
  const literals = [...en.matchAll(/'([^'\n]{2,})'|>([^<>{}\n]{2,})</g)].map((m) => (m[1] || m[2]).trim());
  assert.deepStrictEqual(literals.filter((l) => pt.test(l)), []);
});

test('locale e moeda são injetados', () => {
  assert.match(localizePage(PAGE, 'pt', 'BRL'), /const LOC = 'pt-BR', CUR = 'BRL';/);
  assert.match(localizePage(PAGE, 'en', 'USD'), /const LOC = 'en-US', CUR = 'USD';/);
  assert.match(localizePage(PAGE, 'en', 'USD'), /<html lang="en">/);
  assert.match(localizePage(PAGE, 'pt', 'BRL', 'ocean'), /<body data-theme="ocean">/);
  assert.match(localizePage(PAGE, 'en', 'USD', 'latte'), /<body data-theme="latte">/);
  assert.match(localizePage(PAGE, 'pt', 'BRL', 'neon'), /<body data-theme="neon">/);
  // tema padrão omitido e tema inválido que cai no fallback obsidian
  assert.match(localizePage(PAGE, 'pt', 'BRL'), /<body data-theme="obsidian">/);
  assert.match(localizePage(PAGE, 'pt', 'BRL', 'invalido'), /<body data-theme="obsidian">/);
  // idioma desconhecido cai no locale padrão en-US
  assert.match(localizePage(PAGE, 'es', 'EUR'), /const LOC = 'en-US', CUR = 'EUR';/);
});

test('tabela WIDGET exportada nos dois idiomas', () => {
  const { WIDGET } = require('../src/i18n');
  assert.ok(WIDGET.pt.big.length > 0);
  assert.ok(WIDGET.en.big.length > 0);
  assert.strictEqual(WIDGET.pt.oneIn, '1 em ');
  assert.strictEqual(WIDGET.en.oneIn, '1 in ');
});

test('escolha do idioma: ?lang > LANGUAGE do servidor > navegador > inglês', () => {
  const req = (url, al) => ({ url, headers: al ? { 'accept-language': al } : {} });
  assert.strictEqual(pickLang(req('/?lang=en', 'pt-BR'), 'pt'), 'en');
  assert.strictEqual(pickLang(req('/?lang=pt-BR'), ''), 'pt');
  assert.strictEqual(pickLang(req('/', 'en-US'), 'pt'), 'pt');
  assert.strictEqual(pickLang(req('/', 'pt-BR,pt;q=0.9,en;q=0.8'), ''), 'pt');
  assert.strictEqual(pickLang(req('/', 'de-DE,en;q=0.5'), ''), 'en');
  assert.strictEqual(pickLang(req('/', 'fr-FR'), ''), 'en');
  assert.strictEqual(pickLang(req('/?lang=xx'), ''), 'en');
  // sem headers e sem serverLang
  assert.strictEqual(pickLang({ url: '/', headers: {} }), 'en');
  assert.strictEqual(pickLang({ url: '/' }), 'en');
});

test('botão PT|EN: o cookie vence o LANGUAGE do servidor, mas não o ?lang', () => {
  const req = (url, cookie) => ({ url, headers: { cookie, 'accept-language': 'pt-BR' } });
  assert.strictEqual(pickLang(req('/', 'lang=en'), 'pt'), 'en');
  assert.strictEqual(pickLang(req('/', 'outro=1; lang=pt'), 'en'), 'pt');
  assert.strictEqual(pickLang(req('/?lang=en', 'lang=pt'), 'pt'), 'en');
  assert.strictEqual(pickLang(req('/', 'xlang=en'), 'pt'), 'pt');   // nome de cookie parecido não conta
  assert.strictEqual(pickLang(req('/', 'lang=<script>'), 'pt'), 'pt');
});

// O script do navegador mora num template literal: uma barra invertida sozinha some ("\w" vira "w").
// Foi assim que o botão do AxeOS nunca apareceu (/^[\w.:\-]+$/ virou /^[w.:-]+$/ e recusava o IP).
test('script da página sem barra invertida solta (some no template literal)', () => {
  const bad = PAGE.split('\n').filter((l) => /(^|[^\\])\\(?![\\`$])/.test(l)).map((l) => l.trim().slice(0, 80));
  assert.deepStrictEqual(bad, []);
});
