// Bot do Telegram: detecção de avisos, textos dos comandos e conversa com uma API falsa do Telegram.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tg = require('../src/telegram');

const worker = (name, state, best, extra = {}) => ({ name, state, bestDifficulty: best, hashRate: 1e6, lastSeen: new Date(Date.now() - 3 * 3600e3).toISOString(), inactive: false, ...extra });
const snap = (o = {}) => ({
  farm: { hasData: true, best: 100, hashrate: 16.5e6, shares: { today: 6244 }, workers: [worker('odroid', 'ok', 100), worker('vovo', 'ok', 38.76)], ...o.farm },
  hall: o.hall || [{ worker: 'odroid', value: 100, at: '2026-11-01T10:00:00Z' }],
  proxy: { failover: o.failover || [] },
  wallet: { okAt: 1, sats: o.sats ?? 9248 },
  luck: { workers: [{ name: 'vovo', factor: 2.69, percentile: 0.77 }] },
  nearBlock: {
    tip: { height: 974200, hash: '00000000000000000000' + 'ab'.repeat(22), hashDiff: 6.08e14, target: 1.484e14 },
    dayBestHash: { worker: 'odroid', diff: 5.22, hash: '00000000' + 'cd'.repeat(28), at: Date.parse('2026-11-02T15:00:00Z'), date: o.dayDate || '2026-11-02' },
  },
  championship: o.championship || {
    key: '2026-11-02',
    leader: { name: 'vovo', factor: 2.69, best: 38.76, shares: 42 },
    standings: [{ name: 'vovo', factor: 2.69, best: 38.76, shares: 42 }, { name: 'odroid', factor: 1.1, best: 100, shares: 500 }],
    lastWeek: { key: '2026-10-26', winner: { name: 'odroid', factor: 1.8, best: 95 } },
  },
  achievements: o.achievements || {
    unlocked: 1,
    total: 2,
    list: [
      { id: 'first_share', icon: '⛏️', pt: ['Primeira faísca', 'Primeiro share aceito'], en: ['First spark', 'First accepted share'], unlocked: true, worker: 'odroid' },
      { id: 'diff_1k', icon: '🎯', pt: ['Clube dos 1.000', 'Acima de 1.000'], en: ['1,000 club', 'Over 1,000'], unlocked: false, worker: null },
    ],
  },
});

test('comandos em português e inglês, com ou sem @bot', () => {
  assert.strictEqual(tg.parseCommand('/sorte'), 'luck');
  assert.strictEqual(tg.parseCommand('/luck@FazendaBot'), 'luck');
  assert.strictEqual(tg.parseCommand('/RECORDES'), 'records');
  assert.strictEqual(tg.parseCommand('/campeonato'), 'championship');
  assert.strictEqual(tg.parseCommand('/championship'), 'championship');
  assert.strictEqual(tg.parseCommand('/conquistas'), 'achievements');
  assert.strictEqual(tg.parseCommand('/achievements'), 'achievements');
  assert.strictEqual(tg.parseCommand('/tomada'), 'plug');
  assert.strictEqual(tg.parseCommand('/plug reiniciar'), 'plug');
  assert.strictEqual(tg.parseCommand('/ajuda'), 'help');
  assert.strictEqual(tg.parseCommand('/bilhete'), 'ticket');
  assert.strictEqual(tg.parseCommand('/ticket'), 'ticket');
  assert.strictEqual(tg.parseCommand('/status agora'), 'status');
  assert.strictEqual(tg.parseCommand('oi'), null);
  assert.strictEqual(tg.parseCommand('/rm -rf'), null);
});

test('primeira olhada não gera aviso; recorde da fazenda gera', () => {
  const a = tg.digest(snap());
  assert.deepStrictEqual(tg.diffEvents(null, a, { lang: 'pt' }), []);
  assert.deepStrictEqual(tg.diffEvents(a, a, { lang: 'pt' }), []);
  const b = tg.digest(snap({ farm: { best: 1889.37, workers: [worker('odroid', 'ok', 1889.37), worker('vovo', 'ok', 38.76)] }, hall: [{ worker: 'odroid', value: 1889.37, at: '2026-11-02T10:00:00Z' }] }));
  const ev = tg.diffEvents(a, b, { lang: 'pt', personal: true });
  assert.deepStrictEqual(ev.map((e) => e.type), ['record']);   // quem bateu o recorde da fazenda não ganha aviso pessoal repetido
  assert.match(ev[0].text, /odroid chegou a <b>1\.889,37<\/b>/);
  const en = tg.diffEvents(a, b, { lang: 'en' });
  assert.match(en[0].text, /New farm record.*\n.*1,889\.37/s);
});

test('recorde pessoal só quando ligado', () => {
  const a = tg.digest(snap());
  const b = tg.digest(snap({ farm: { workers: [worker('odroid', 'ok', 100), worker('vovo', 'ok', 50)] } }));
  assert.deepStrictEqual(tg.diffEvents(a, b, { lang: 'pt' }), []);
  assert.deepStrictEqual(tg.diffEvents(a, b, { lang: 'pt', personal: true }).map((e) => e.type), ['personal']);
});

test('worker parado avisa uma vez e avisa quando volta; ignorados e inativos não', () => {
  const down = new Set();
  const a = tg.digest(snap());
  const b = tg.digest(snap({ farm: { workers: [worker('odroid', 'stale', 100), worker('vovo', 'stale', 38.76), worker('velho', 'stale', 1, { inactive: true })] } }));
  const ev = tg.diffEvents(a, b, { lang: 'pt', down, ignore: ['vovo'] });
  assert.deepStrictEqual(ev.map((e) => e.type), ['stopped']);
  assert.match(ev[0].text, /odroid parou.*há 3 h/);
  assert.deepStrictEqual(tg.diffEvents(b, b, { lang: 'pt', down, ignore: ['vovo'] }), []);   // não repete
  const c = tg.digest(snap());
  assert.deepStrictEqual(tg.diffEvents(b, c, { lang: 'pt', down, ignore: ['vovo'] }).map((e) => e.type), ['back']);
});

test('failover, volta da pool, dinheiro e bloco', () => {
  const a = tg.digest(snap());
  const b = tg.digest(snap({ failover: [{ listen: 3333, primary: 'public-pool', active: 'ckpool solo' }] }));
  const ev = tg.diffEvents(a, b, { lang: 'pt' });
  assert.deepStrictEqual(ev.map((e) => e.type), ['failover']);
  assert.match(ev[0].text, /public-pool fora do ar.*porta 3333.*ckpool solo/);
  assert.deepStrictEqual(tg.diffEvents(b, a, { lang: 'en' }).map((e) => e.type), ['failback']);
  assert.match(tg.diffEvents(a, tg.digest(snap({ sats: 10248 })), { lang: 'pt' })[0].text, /1\.000 sats/);
  const blk = tg.diffEvents(a, tg.digest(snap({ sats: 9248 + 312500000 })), { lang: 'pt' });
  assert.deepStrictEqual(blk.map((e) => e.type), ['block']);
  assert.match(blk[0].text, /ACHAMOS UM BLOCO.*3,125 BTC/s);
});

test('nomes com HTML não quebram a mensagem', () => {
  const a = tg.digest(snap());
  const b = tg.digest(snap({ farm: { best: 200, workers: [worker('<b>x', 'ok', 200)] }, hall: [{ worker: '<b>x', value: 200, at: '2026-11-02T10:00:00Z' }] }));
  assert.match(tg.diffEvents(a, b, { lang: 'pt' })[0].text, /&lt;b&gt;x/);
});

test('textos dos comandos', () => {
  const s = snap();
  const st = tg.statusText(s, { lang: 'pt', today: '2026-11-02', panelUrl: 'http://odroid:3000' });
  assert.match(st, /16,5 MH\/s/);
  assert.match(st, /Minerando: 2 de 2 workers/);
  assert.match(st, /Shares hoje: 6\.244/);
  assert.match(st, /Melhor hash do dia: <b>5,22<\/b> \(odroid\)/);
  assert.match(st, /Mais sortudo: vovo \(2,69×\)/);
  assert.match(st, /href="http:\/\/odroid:3000"/);
  assert.match(tg.statusText(s, { lang: 'en', today: '2026-11-01' }), /Mining: 2 of 2 workers/);
  assert.doesNotMatch(tg.statusText(s, { lang: 'en', today: '2026-11-01' }), /Best hash today/);   // melhor de outro dia não conta
  assert.match(tg.statusText({ farm: { hasData: false } }, { lang: 'pt' }), /Ainda sem dados/);
  assert.match(tg.workersText(s, { lang: 'pt' }), /🟢 <b>odroid<\/b> · 1 MH\/s · 100 · 3 h/);
  assert.match(tg.luckText(s, { lang: 'pt' }), /vovo: <b>2,69×<\/b> · melhor que 77%/);
  assert.match(tg.recordsText(s, { lang: 'en' }), /🥇 <b>100<\/b> · odroid/);
  assert.match(tg.championshipText(s, { lang: 'pt' }), /🏆 <b>vovo<\/b> · 2,69× · 38,76 \(42 shares\)/);
  assert.match(tg.championshipText(s, { lang: 'en' }), /Last week's champion: 🏆 <b>odroid<\/b>/);
  assert.match(tg.achievementsText(s, { lang: 'pt' }), /⛏️ <b>Primeira faísca<\/b> \(odroid\)/);
  assert.match(tg.achievementsText(s, { lang: 'en' }), /🔒 <b>1,000 club<\/b>/);
  assert.match(tg.dailyText(s, { lang: 'pt', now: Date.parse('2026-11-02T23:00:00Z') }), /Resumo do dia/);
  // domingo anuncia o campeão da semana no resumo diário
  assert.match(tg.dailyText(s, { lang: 'pt', now: new Date(2026, 10, 8, 21, 0, 0).getTime() }), /Campeão da semana:.*vovo/);
  // nova conquista gera aviso
  const d1 = tg.digest(s);
  const d2 = tg.digest(snap({
    achievements: {
      unlocked: 2, total: 2,
      list: [
        { id: 'first_share', icon: '⛏️', pt: ['Primeira faísca', 'Primeiro share aceito'], en: ['First spark', 'First accepted share'], unlocked: true, worker: 'odroid' },
        { id: 'diff_1k', icon: '🎯', pt: ['Clube dos 1.000', 'Acima de 1.000'], en: ['1,000 club', 'Over 1,000'], unlocked: true, worker: 'vovo' },
      ],
    },
  }));
  const achEv = tg.diffEvents(d1, d2, { lang: 'pt' });
  assert.deepStrictEqual(achEv.map((e) => e.type), ['achievement']);
  assert.match(achEv[0].text, /Nova conquista!.*<b>Clube dos 1\.000<\/b> · vovo/s);
  // tomada SmartLife / Tuya: /tomada e aviso de reinício automático
  assert.match(tg.plugText(s, { lang: 'pt' }), /Tomada inteligente não configurada/);
  const sPlug = { ...s, energy: { plug: { okAt: '2026-11-04T00:00:00Z', on: true, watts: 45.2, volts: 220, currentMa: 205, worker: 'bitaxe', rebootCount: 1 } } };
  assert.match(tg.plugText(sPlug, { lang: 'pt' }), /Consumo: <b>45,2 W<\/b> · 220 V · 205 mA/);
  assert.match(tg.plugText(sPlug, { lang: 'en' }), /Power: <b>45\.2 W<\/b> · 220 V · 205 mA/);
  const rbEv = tg.diffEvents(d1, tg.digest(sPlug), { lang: 'pt' });
  assert.deepStrictEqual(rbEv.map((e) => e.type), ['plug_reboot']);
  assert.match(rbEv[0].text, /Tomada reiniciada automaticamente<\/b> \(bitaxe\)/);
  const fm = tg.formatter('pt');
  assert.strictEqual(fm.diff(148.4e12), '148,4 tri');
  assert.strictEqual(tg.formatter('en').diff(148.4e12), '148.4T');
  assert.strictEqual(fm.diff(0.00149), '0,00149');
  assert.strictEqual(fm.diff(250000), '250.000');
});

// ---------------------------------------------------------------- API falsa do Telegram
function fakeTelegram() {
  const sent = [], calls = [], queue = [];
  let id = 1;
  const server = http.createServer((req, res) => {
    let b = '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const multipart = /^multipart/.test(req.headers['content-type'] || '');
      b = Buffer.concat(chunks).toString(multipart ? 'latin1' : 'utf8');   // latin1 preserva os bytes do PNG
      const method = req.url.split('/').pop();
      const body = multipart ? { raw: Buffer.from(b, 'latin1').toString('utf8') } : b ? JSON.parse(b) : {};
      calls.push({ url: req.url, method, body });
      const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      if (!req.url.startsWith('/botTOKEN123/')) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); }
      if (method === 'getMe') return reply({ username: 'FazendaBot' });
      if (method === 'sendMessage') { sent.push(body); return reply({ message_id: sent.length }); }
      if (method === 'sendPhoto') { sent.push({ photo: true, raw: body.raw }); return reply({ message_id: sent.length }); }
      if (method === 'getUpdates') {
        const ups = queue.splice(0).filter((u) => u.update_id >= (body.offset || 0));
        return ups.length ? reply(ups) : setTimeout(() => reply([]), 100);
      }
      reply(true);
    });
  });
  const push = (chatId, text) => queue.push({ update_id: id++, message: { chat: { id: chatId }, text } });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, sent, calls, push, url: `http://127.0.0.1:${server.address().port}` })));
}
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 50)); } };

test('bot responde só ao chat configurado e manda os avisos', async (t) => {
  const api = await fakeTelegram();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  let current = snap();
  const bot = tg.start({ token: 'TOKEN123', chatIds: ['42'], lang: 'pt', snapshot: () => current, api: api.url, pollS: 0, warmupMs: 1e9, stateFile: path.join(dir, 'telegram.json'), log: () => {} });
  t.after(() => { bot.stop(); api.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await waitFor(() => api.calls.some((c) => c.method === 'setMyCommands'));
  const cmds = api.calls.find((c) => c.method === 'setMyCommands').body.commands.map((c) => c.command);
  assert.deepStrictEqual(cmds, ['status', 'workers', 'sorte', 'recordes', 'campeonato', 'conquistas', 'tomada', 'bilhete', 'ajuda']);

  api.push(999, '/status');   // estranho: ignorado
  api.push(42, '/status');
  await waitFor(() => api.sent.length >= 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(api.sent.length, 1);
  assert.strictEqual(String(api.sent[0].chat_id), '42');
  assert.strictEqual(api.sent[0].parse_mode, 'HTML');
  assert.match(api.sent[0].text, /Minerando: 2 de 2/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'telegram.json'), 'utf8')).offset >= 2);   // não reprocessa depois de reiniciar

  // avisos: a primeira olhada só registra; o recorde seguinte vira mensagem
  bot.tick();
  current = snap({ farm: { best: 500 }, hall: [{ worker: 'vovo', value: 500, at: '2026-11-02T10:00:00Z' }] });
  bot.tick();
  await waitFor(() => api.sent.length >= 2);
  assert.match(api.sent[1].text, /Novo recorde da fazenda!.*vovo chegou a <b>500<\/b>/s);
});

test('sem TELEGRAM_CHAT_ID, o /start ensina a configurar', async (t) => {
  const api = await fakeTelegram();
  const bot = tg.start({ token: 'TOKEN123', chatIds: [], lang: 'en', snapshot: () => snap(), api: api.url, pollS: 0, warmupMs: 1e9, log: () => {} });
  t.after(() => { bot.stop(); api.server.close(); });
  api.push(777, '/status');
  api.push(777, '/start');
  await waitFor(() => api.sent.length >= 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(api.sent.length, 1);
  assert.match(api.sent[0].text, /TELEGRAM_CHAT_ID=777/);
});

test('o painel liga o bot quando há TELEGRAM_BOT_TOKEN', async (t) => {
  const api = await fakeTelegram();
  const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-tg-'));
  const p = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/offline.js'), path.join(__dirname, '../src/painel.js')], {
    env: { ...process.env, BTC_ADDRESS: 'bc1qteste', PORT: String(port), DATA_DIR: dir, PROXY_URL: '', ALARM_PORT: path.join(dir, 'x'), CKPOOL_URLS: '', OCEAN_API: '',
      TELEGRAM_BOT_TOKEN: 'TOKEN123', TELEGRAM_CHAT_ID: '42', TELEGRAM_API: api.url, LANGUAGE: 'pt-BR' },
    stdio: 'ignore',
  });
  t.after(() => { p.kill(); api.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => api.calls.some((c) => c.method === 'getMe'), 10000);
  api.push(42, '/ajuda');
  await waitFor(() => api.sent.length >= 1, 10000);
  assert.match(api.sent[0].text, /\/sorte · medidor de sorte/);
});

const hasPillow = require('child_process').spawnSync('python3', ['-c', 'import PIL']).status === 0;

test('bilhete do dia em PNG pelo ticket.py', { skip: !hasPillow && 'sem Pillow' }, async () => {
  const today = new Date().toLocaleDateString('sv');
  const png = await tg.ticketImage(snap({ dayDate: today }), 'pt');
  assert.ok(png && png.subarray(1, 4).toString() === 'PNG');
  assert.strictEqual(png.readUInt32BE(16), 1080);
  assert.strictEqual(png.readUInt32BE(20), 1350);
  assert.strictEqual(await tg.ticketImage({ nearBlock: {} }, 'en'), null);   // sem dados: sem bilhete
  assert.strictEqual(await tg.ticketImage(snap(), 'pt', { python: 'python-que-nao-existe' }), null);
  assert.ok(tg.todayBest(snap({ dayDate: today })));
  assert.strictEqual(tg.todayBest(snap({ dayDate: '2020-01-01' })), null);   // melhor de outro dia não vira bilhete
});

test('/bilhete e resumo diário mandam a foto do bilhete', { skip: !hasPillow && 'sem Pillow' }, async (t) => {
  const api = await fakeTelegram();
  const today = new Date().toLocaleDateString('sv');
  let current = snap({ dayDate: '2020-01-01' });
  const bot = tg.start({ token: 'TOKEN123', chatIds: ['42'], lang: 'pt', snapshot: () => current, api: api.url, pollS: 0, warmupMs: 1e9, dailyHour: new Date().getHours(), log: () => {} });
  t.after(() => { bot.stop(); api.server.close(); });

  api.push(42, '/bilhete');   // ainda sem share de hoje
  await waitFor(() => api.sent.length >= 1);
  assert.match(api.sent[0].text, /Ainda não há bilhete hoje/);

  current = snap({ dayDate: today });
  api.push(42, '/bilhete');
  await waitFor(() => api.sent.length >= 2, 15000);
  assert.ok(api.sent[1].photo);
  assert.match(api.sent[1].raw, /name="chat_id"\r\n\r\n42/);
  assert.match(api.sent[1].raw, /PNG\r\n\x1a\n[\s\S]*IHDR/);
  assert.match(api.sent[1].raw, /Bilhete de hoje: melhor hash <b>5,22<\/b> \(odroid\)/);

  bot.tick();   // hora do resumo: foto com o resumo na legenda
  await waitFor(() => api.sent.length >= 3, 15000);
  assert.ok(api.sent[2].photo);
  assert.match(api.sent[2].raw, /Resumo do dia/);
  assert.match(api.sent[2].raw, /name="parse_mode"\r\n\r\nHTML/);
});
