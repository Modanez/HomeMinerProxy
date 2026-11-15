// Aba Notícias: leitura de RSS/Atom sem dependências.
const test = require('node:test');
const assert = require('node:assert');
const news = require('../src/news');

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Livecoins</title>
<item><title><![CDATA[Bitcoin passa de R$ 600 mil &amp; bate recorde]]></title><link>https://livecoins.com.br/a/</link>
<pubDate>Sun, 15 Nov 2026 10:00:00 +0000</pubDate><description><![CDATA[<p>O preço <b>subiu</b> 5%&#8230;</p>]]></description></item>
<item><title>Sem link</title></item>
<item><title>Link perigoso</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Optech #380</title><link rel="alternate" href="https://bitcoinops.org/n/380/"/>
<updated>2026-11-12T00:00:00Z</updated><summary>Esta semana…</summary></entry></feed>`;

test('RSS: título, link, data e resumo sem HTML; itens sem link ou com link não-http ficam de fora', () => {
  const it = news.parseFeed(RSS);
  assert.strictEqual(it.length, 1);
  assert.strictEqual(it[0].title, 'Bitcoin passa de R$ 600 mil & bate recorde');
  assert.strictEqual(it[0].link, 'https://livecoins.com.br/a/');
  assert.strictEqual(it[0].at, Date.parse('2026-11-15T10:00:00Z'));
  assert.strictEqual(it[0].summary, 'O preço subiu 5%…');
});

test('Atom: link alternate e data updated', () => {
  const it = news.parseFeed(ATOM);
  assert.deepStrictEqual([it[0].title, it[0].link], ['Optech #380', 'https://bitcoinops.org/n/380/']);
});

test('feeds: os dois idiomas buscados juntos, cada visitante vê os do seu; lista própria vale para os dois', () => {
  const all = news.feedsFromEnv('');
  const nobs = all.filter((f) => f.name === 'No Bullshit Bitcoin');
  assert.strictEqual(nobs.length, 1, 'feed comum aos dois idiomas aparece uma vez só');
  assert.deepStrictEqual(nobs[0].langs.sort(), ['en', 'pt']);
  const state = { feeds: all.map((f) => ({ ...f, items: [] })) };
  assert.deepStrictEqual(news.forLang(state, 'pt').map((f) => f.name), ['Livecoins', 'Portal do Bitcoin', 'No Bullshit Bitcoin']);
  assert.deepStrictEqual(news.forLang(state, 'en').map((f) => f.name), ['No Bullshit Bitcoin', 'Bitcoin Magazine', 'Bitcoin Optech']);
  const f = news.feedsFromEnv('Meu|https://ex.com/rss, https://www.outro.org/feed, lixo');
  assert.deepStrictEqual(f.map((x) => x.name), ['Meu', 'outro.org']);
  assert.deepStrictEqual(f[0].langs, ['pt', 'en']);
});

test('lista por idioma: manchetes só dos feeds daquele idioma', () => {
  const state = { feeds: [
    { name: 'PT', langs: ['pt'], items: [{ title: 'a', link: 'https://a/', at: 2 }] },
    { name: 'EN', langs: ['en'], items: [{ title: 'b', link: 'https://b/', at: 1 }] },
  ] };
  assert.deepStrictEqual(news.merged(state, 40, 'pt').map((i) => i.source), ['PT']);
  assert.deepStrictEqual(news.merged(state, 40, 'en').map((i) => i.source), ['EN']);
});

test('um feed fora do ar mantém as manchetes antigas e não derruba os outros; lista única sem repetir', async () => {
  const state = { feeds: [] };
  const feeds = [{ name: 'A', url: 'https://a/' }, { name: 'B', url: 'https://b/' }];
  await news.refresh(state, feeds, { fetchText: async (u) => (u === 'https://a/' ? RSS : ATOM), now: 1000 });
  assert.strictEqual(news.merged(state).length, 2);
  await news.refresh(state, feeds, { fetchText: async (u) => { if (u === 'https://a/') throw new Error('HTTP 503'); return ATOM; }, now: 2000 });
  const a = state.feeds.find((f) => f.name === 'A');
  assert.strictEqual(a.error, 'HTTP 503');
  assert.strictEqual(a.items.length, 1, 'manchetes antigas mantidas');
  assert.strictEqual(a.okAt, 1000);
  assert.strictEqual(news.merged(state)[0].source, 'A');   // mais nova primeiro (15/11 > 12/11)
});
