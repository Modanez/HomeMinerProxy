// Notícias de bitcoin (aba Notícias): manchetes de alguns feeds RSS/Atom, sem dependências.
// NEWS_FEEDS="Nome|https://site/feed, Outro|https://…" troca a lista (vale nos dois idiomas); NEWS=0 desliga a aba.
// Padrão: em português, Livecoins, Portal do Bitcoin e No Bullshit Bitcoin; em inglês, No Bullshit Bitcoin,
// Bitcoin Magazine e Bitcoin Optech. Cada feed é buscado a cada 30 min; um feed fora do ar não derruba os outros.

const http = require('http');
const https = require('https');

const DEFAULT_FEEDS = {
  pt: [
    ['Livecoins', 'https://livecoins.com.br/feed/'],
    ['Portal do Bitcoin', 'https://portaldobitcoin.uol.com.br/feed/'],
    ['No Bullshit Bitcoin', 'https://www.nobsbitcoin.com/rss/'],
  ],
  en: [
    ['No Bullshit Bitcoin', 'https://www.nobsbitcoin.com/rss/'],
    ['Bitcoin Magazine', 'https://bitcoinmagazine.com/.rss/full/'],
    ['Bitcoin Optech', 'https://bitcoinops.org/feed.xml'],
  ],
};

// Todos os feeds de fábrica, marcados com o idioma: o servidor busca os dois idiomas e cada visitante vê os do idioma
// que escolheu no painel (PT | EN). Lista própria em NEWS_FEEDS vale para os dois idiomas.
function feedsFromEnv(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const out = [];
    for (const [lang, list] of Object.entries(DEFAULT_FEEDS)) for (const [name, url] of list) {
      const f = out.find((x) => x.url === url);
      if (f) f.langs.push(lang); else out.push({ name, url, langs: [lang] });
    }
    return out;
  }
  return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf('|');
    const name = i > 0 ? s.slice(0, i).trim() : null, url = (i > 0 ? s.slice(i + 1) : s).trim();
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { /* nome = url */ }
    return /^https?:\/\//i.test(url) ? { name: name || host, url, langs: ['pt', 'en'] } : null;
  }).filter(Boolean).slice(0, 8);
}

// ---------------------------------------------------------------- texto do XML
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] ?? m));
// conteúdo de texto: decodifica (o HTML vem escapado dentro do XML), tira as tags e junta espaços
const text = (s) => decode(decode(s)).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block); return m ? m[1] : ''; };
const safeUrl = (u) => { const s = decode(String(u || '').trim()); return /^https?:\/\//i.test(s) ? s : null; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

// RSS 2.0 (<item>) ou Atom (<entry>) → [{ title, link, at, summary }]
function parseFeed(xml) {
  const src = String(xml || '');
  const atom = !/<item[\s>]/i.test(src) && /<entry[\s>]/i.test(src);
  const blocks = src.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const title = text(tag(b, 'title'));
    let link = null;
    if (atom) {
      const alt = /<link\b[^>]*rel=["']alternate["'][^>]*>/i.exec(b) || /<link\b[^>]*>/i.exec(b);
      const href = alt && /href=["']([^"']+)["']/i.exec(alt[0]);
      link = safeUrl(href && href[1]);
    } else link = safeUrl(text(tag(b, 'link'))) || safeUrl(text(tag(b, 'guid')));
    const when = text(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const at = Date.parse(when);
    const summary = clip(text(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content')), 220);
    return title && link ? { title: clip(title, 200), link, at: Number.isFinite(at) ? at : null, summary } : null;
  }).filter(Boolean);
}

// GET de texto com redirecionamento (até 3), tempo limite e teto de tamanho
function getText(url, { timeoutMs = 15000, maxBytes = 3e6, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('http:') ? http : https).get(url, {
      timeout: timeoutMs, family: 4,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 HomeMinerProxy/1.0', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getText(new URL(res.headers.location, url).href, { timeoutMs, maxBytes, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('grande demais')); return; } body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Busca todos os feeds; guarda o último resultado bom de cada um (um feed fora do ar mantém as manchetes antigas)
async function refresh(state, feeds, { fetchText = getText, now = Date.now(), perFeed = 15 } = {}) {
  state.at = now;
  state.feeds = await Promise.all(feeds.map(async (f) => {
    const prev = (state.feeds || []).find((p) => p.url === f.url) || {};
    try {
      const items = parseFeed(await fetchText(f.url)).slice(0, perFeed);
      if (!items.length) throw new Error('feed vazio ou formato desconhecido');
      return { name: f.name, url: f.url, langs: f.langs, okAt: now, error: null, items };
    } catch (e) {
      return { name: f.name, url: f.url, langs: f.langs, okAt: prev.okAt || 0, error: e.message, items: prev.items || [] };
    }
  }));
  return state;
}

// Lista única, mais novas primeiro, sem repetir o mesmo link
function forLang(state, lang) { return (state.feeds || []).filter((f) => !f.langs || f.langs.includes(lang)); }
function merged(state, limit = 40, lang) {
  const seen = new Set(), out = [];
  for (const f of lang ? forLang(state, lang) : state.feeds || []) for (const it of f.items) if (!seen.has(it.link)) { seen.add(it.link); out.push({ ...it, source: f.name }); }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

module.exports = { DEFAULT_FEEDS, feedsFromEnv, forLang, parseFeed, getText, refresh, merged, decode, text };
