// Assistente de primeira configuração: quando o painel sobe sem BTC_ADDRESS (imagem recém-gravada,
// Docker sem .env), ele entra em "modo instalação" e serve só este passo a passo no navegador:
// idioma, endereço de bitcoin, PIN e moeda/kWh. No fim grava DATA_DIR/settings.json e o PIN e
// reinicia; o systemd (ou o Docker) sobe o painel de novo, agora no modo normal.
// Segurança: só existe enquanto não há endereço. Se o .env já tem SETTINGS_PIN, o assistente pede esse PIN.

const http = require('http');
const os = require('os');
const settings = require('./settings');
const localminer = require('./localminer');

const PIN_RE = /^\d{6,12}$/;
const field = (k) => settings.FIELDS.find((f) => f.key === k);

// IPs da rede de casa, para a tela final dizer onde apontar os mineradores
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// Valida o formulário. Devolve { values, pin } ou { errors }.
function validate(form, envPin, pinState, canMine = localminer.available()) {
  const errors = {}, values = {};
  const lang = form.LANGUAGE === 'en' ? 'en' : form.LANGUAGE === 'pt-BR' ? 'pt-BR' : null;
  if (!lang) errors.LANGUAGE = 'option'; else values.LANGUAGE = lang;
  // unidade de temperatura: só C ou F (o painel e o Telegram usam a escolhida)
  if (form.TEMP_UNIT != null && form.TEMP_UNIT !== '') {
    if (form.TEMP_UNIT === 'C' || form.TEMP_UNIT === 'F') values.TEMP_UNIT = form.TEMP_UNIT; else errors.TEMP_UNIT = 'option';
  }
  for (const k of ['BTC_ADDRESS', 'CURRENCY', 'POWER_PRICE_KWH']) {
    const r = settings.clean(field(k), form[k]);
    if (r.error) errors[k] = r.error; else if (r.value !== '') values[k] = r.value;
  }
  // minerar também com este aparelho (só onde o cpuminer existe)
  if (canMine) {
    const on = form.LOCAL_MINER === true || form.LOCAL_MINER === '1';
    values.LOCAL_MINER = on ? '1' : '0';
    if (on) {
      const n = Number(form.MINER_THREADS);
      if (!(Number.isInteger(n) && n >= 1 && n <= localminer.cores())) errors.MINER_THREADS = 'threads';
      else values.MINER_THREADS = String(n);
      const w = String(form.LOCAL_WORKER || '').trim();
      if (w && !/^[\w.\-]{1,64}$/.test(w)) errors.LOCAL_WORKER = 'name';
      else if (w) values.LOCAL_WORKER = w;
    }
  }
  let pin = null;
  if (envPin) {
    if ((pinState || settings.checkPin(form.pin, envPin)) !== 'ok') errors.pin = 'wrong';
  } else {
    pin = String(form.pin || '').trim();
    if (!PIN_RE.test(pin)) errors.pin = 'pin';
    else if (String(form.pin2 || '').trim() !== pin) errors.pin2 = 'pin2';
  }
  return Object.keys(errors).length ? { errors } : { values, pin };
}

function apply(dataDir, values, pin) {
  const overlay = { ...settings.readOverlay(dataDir), ...values };
  settings.save(dataDir, overlay);
  if (pin) settings.savePin(dataDir, pin);
}

// ---------------------------------------------------------------- página
const S = {
  pt: {
    title: 'Primeira configuração', hello: 'Bem-vindo à sua fazenda de mineração! ⛏️',
    intro: 'Poucos passos e o painel está pronto. Dá para mudar tudo depois em ⚙️ Configurações.',
    step: 'Passo', of: 'de', next: 'Continuar', back: 'Voltar', finish: 'Concluir',
    s1: 'Idioma', s1h: 'Do painel, do cubo e do bot do Telegram.',
    s2: 'Endereço de bitcoin', s2h: 'O endereço público que os seus mineradores usam como usuário (o prêmio do bloco vai para ele). Só o endereço público: nunca digite seed ou chave privada.',
    s3: 'PIN de administração', s3h: 'Protege as configurações, as tomadas e as atualizações. Use de 6 a 12 números.',
    s3env: 'Este servidor já tem um PIN em /etc/mineracao.env (SETTINGS_PIN). Digite esse PIN.',
    pin: 'PIN', pin2: 'Repita o PIN',
    s4: 'Conta de luz', s4h: 'Para estimar quanto a fazenda gasta. Pode deixar o padrão.',
    sm: 'Minerar também com este aparelho?', smh: 'Além de servidor, ele pode minerar com a própria CPU. São poucos MH/s (loteria pura) e a placa esquenta: use dissipador. Dá para mudar depois em ⚙️ Configurações.',
    mineNo: 'Não, só servidor', mineYes: 'Sim, minerar também', threads: 'Núcleos', worker: 'Nome no painel',
    currency: 'Moeda', kwh: 'Preço do kWh', tunit: 'Temperatura', auto: 'Automática',
    done: 'Pronto! Reiniciando o painel…', doneH: 'Enquanto isso, aponte os seus mineradores para este servidor:',
    user: 'Usuário em cada minerador', userH: 'troque "nome" pelo nome que vai aparecer no painel; senha: x',
    ports: [['3333', 'cpuminer (PC, celular, Raspberry)'], ['3335', 'NerdMiner e placas ESP32'], ['3334', 'Bitaxe (ckpool solo)'], ['3338', 'Bitaxe (AtlasPool)']],
    server: 'Servidor', opening: 'Abrindo o painel…',
    err: { option: 'Escolha uma opção', threads: 'Escolha os núcleos', name: 'Use letras, números, ponto, hífen ou _', address: 'Endereço inválido', price: 'Use um número entre 0 e 100', pin: 'Use de 6 a 12 números', pin2: 'Os PINs não são iguais', wrong: 'PIN errado', locked: 'Muitas tentativas erradas. Espere 15 minutos.', fix: 'Corrija os campos marcados.', net: 'Sem resposta do servidor. Tente de novo.' },
  },
  en: {
    title: 'First setup', hello: 'Welcome to your mining farm! ⛏️',
    intro: 'A few steps and the dashboard is ready. You can change everything later in ⚙️ Settings.',
    step: 'Step', of: 'of', next: 'Continue', back: 'Back', finish: 'Finish',
    s1: 'Language', s1h: 'For the dashboard, the cube and the Telegram bot.',
    s2: 'Bitcoin address', s2h: 'The public address your miners use as username (the block reward goes there). Public address only: never type a seed or private key.',
    s3: 'Admin PIN', s3h: 'Protects settings, smart plugs and updates. Use 6 to 12 digits.',
    s3env: 'This server already has a PIN in /etc/mineracao.env (SETTINGS_PIN). Type that PIN.',
    pin: 'PIN', pin2: 'Repeat the PIN',
    s4: 'Power bill', s4h: 'To estimate what the farm costs. The defaults are fine.',
    sm: 'Also mine with this device?', smh: 'Besides being the server, it can mine with its own CPU. It is a few MH/s (pure lottery) and the board gets hot: use a heatsink. You can change it later in ⚙️ Settings.',
    mineNo: 'No, server only', mineYes: 'Yes, mine too', threads: 'Cores', worker: 'Name on the dashboard',
    currency: 'Currency', kwh: 'Price per kWh', tunit: 'Temperature', auto: 'Automatic',
    done: 'Done! Restarting the dashboard…', doneH: 'Meanwhile, point your miners to this server:',
    user: 'Username on each miner', userH: 'replace "name" with the name to show on the dashboard; password: x',
    ports: [['3333', 'cpuminer (PC, phone, Raspberry)'], ['3335', 'NerdMiner and ESP32 boards'], ['3334', 'Bitaxe (ckpool solo)'], ['3338', 'Bitaxe (AtlasPool)']],
    server: 'Server', opening: 'Opening the dashboard…',
    err: { option: 'Pick an option', threads: 'Pick the cores', name: 'Use letters, digits, dot, dash or _', address: 'Invalid address', price: 'Use a number from 0 to 100', pin: 'Use 6 to 12 digits', pin2: 'The PINs do not match', wrong: 'Wrong PIN', locked: 'Too many wrong tries. Wait 15 minutes.', fix: 'Fix the highlighted fields.', net: 'No answer from the server. Try again.' },
  },
};

function page(lang, envPin) {
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-br' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HomeMinerProxy</title>
<style>
  :root { --bg:#0e1117; --card:#171c26; --line:#252c3a; --txt:#e6e9ef; --dim:#8a93a6; --gold:#f2a900; --ok:#3ecf8e; --warn:#e5534b; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt); font-family:-apple-system, "Segoe UI", Roboto, sans-serif; padding:24px 16px; max-width:560px; margin:0 auto; line-height:1.45; }
  h1 { font-size:22px; margin-bottom:6px; } .intro { color:var(--dim); font-size:14px; margin-bottom:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; }
  .stepn { color:var(--gold); font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin-bottom:6px; }
  h2 { font-size:18px; margin-bottom:6px; } .hint { color:var(--dim); font-size:13px; margin:4px 0 12px; }
  label.l { display:block; font-size:13px; font-weight:600; margin:10px 0 5px; }
  input, select { width:100%; background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:11px 12px; font-size:16px; font-family:inherit; }
  input.mono { font-family:ui-monospace, Menlo, monospace; font-size:14px; }
  .bad input, .bad select { border-color:var(--warn); } .ferr { color:var(--warn); font-size:12px; margin-top:4px; min-height:14px; }
  .langs { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .langs button { background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:10px; padding:16px; font-size:16px; cursor:pointer; }
  .langs button.on { border-color:var(--gold); color:var(--gold); }
  .bar { display:flex; justify-content:space-between; gap:10px; margin-top:18px; }
  button.main { background:var(--gold); color:#111; border:0; border-radius:8px; padding:11px 18px; font-size:16px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--dim); border:1px solid var(--line); border-radius:8px; padding:11px 16px; font-size:15px; cursor:pointer; }
  button:disabled { opacity:.5; } [hidden] { display:none !important; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  #msg { color:var(--warn); font-size:13px; margin-top:10px; min-height:18px; }
  .ports { width:100%; border-collapse:collapse; margin:10px 0; font-size:14px; } .ports td { border-top:1px solid var(--line); padding:7px 4px; }
  .ports td:first-child { color:var(--gold); font-weight:600; width:60px; }
  code { font-family:ui-monospace, Menlo, monospace; font-size:13px; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:2px 6px; word-break:break-all; }
  .ok { color:var(--ok); font-weight:600; font-size:17px; margin-bottom:8px; }
</style></head><body>
<h1 id="hello"></h1><p class="intro" id="intro"></p>
<div class="card" id="wizard">
  <div class="stepn" id="stepn"></div>
  <section data-s="1"><h2 data-t="s1"></h2><p class="hint" data-t="s1h"></p>
    <div class="langs"><button type="button" data-lang="pt-BR">🇧🇷 Português</button><button type="button" data-lang="en">🇺🇸 English</button></div></section>
  <section data-s="2" hidden><h2 data-t="s2"></h2><p class="hint" data-t="s2h"></p>
    <div class="f" data-k="BTC_ADDRESS"><input id="addr" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bc1q…"><div class="ferr"></div></div></section>
  <section data-s="3" hidden><h2 data-t="s3"></h2><p class="hint" data-t="${envPin ? 's3env' : 's3h'}"></p>
    <div class="f" data-k="pin"><label class="l" data-t="pin"></label><input id="pin" type="password" inputmode="numeric" autocomplete="new-password"><div class="ferr"></div></div>
    ${envPin ? '' : '<div class="f" data-k="pin2"><label class="l" data-t="pin2"></label><input id="pin2" type="password" inputmode="numeric" autocomplete="new-password"><div class="ferr"></div></div>'}</section>
  <section data-s="m" hidden><h2 data-t="sm"></h2><p class="hint" data-t="smh"></p>
    <div class="langs"><button type="button" data-mine="0" data-t="mineNo"></button><button type="button" data-mine="1" data-t="mineYes"></button></div>
    <div class="row2" id="mineopts" hidden><div class="f" data-k="MINER_THREADS"><label class="l" data-t="threads"></label><select id="threads"></select><div class="ferr"></div></div>
    <div class="f" data-k="LOCAL_WORKER"><label class="l" data-t="worker"></label><input id="mworker" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="ferr"></div></div></div></section>
  <section data-s="4" hidden><h2 data-t="s4"></h2><p class="hint" data-t="s4h"></p>
    <div class="row2"><div class="f" data-k="CURRENCY"><label class="l" data-t="currency"></label><select id="cur"><option value="BRL">BRL (R$)</option><option value="USD">USD (US$)</option></select><div class="ferr"></div></div>
    <div class="f" data-k="POWER_PRICE_KWH"><label class="l" data-t="kwh"></label><input id="kwh" inputmode="decimal"><div class="ferr"></div></div></div>
    <div class="f" data-k="TEMP_UNIT"><label class="l" data-t="tunit"></label><select id="tunit"><option value="C">°C (Celsius)</option><option value="F">°F (Fahrenheit)</option></select><div class="ferr"></div></div></section>
  <div id="msg"></div>
  <div class="bar"><button type="button" class="ghost" id="back" data-t="back"></button><button type="button" class="main" id="next"></button></div>
</div>
<div class="card" id="done" hidden>
  <div class="ok" data-t="done"></div><p class="hint" data-t="doneH"></p>
  <p><span data-t="server"></span>: <code id="srv"></code></p>
  <table class="ports" id="ports"></table>
  <p><span data-t="user"></span>:</p><p><code id="usr" style="display:block;margin-top:6px"></code></p><p class="hint" data-t="userH"></p>
  <p class="hint" id="opening"></p>
</div>
<script>
const S = ${JSON.stringify(S)}, ENV_PIN = ${envPin ? 'true' : 'false'};
let lang = (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt-BR' : '${lang === 'pt' ? 'pt-BR' : 'en'}', pos = 0, info = { hosts: [] }, mine = false;
const order = () => (info.canMine ? ['1', '2', '3', 'm', '4'] : ['1', '2', '3', '4']);
const cur = () => order()[pos];
const $ = (id) => document.getElementById(id);
const T = () => S[lang === 'en' ? 'en' : 'pt'];
function render() {
  const t = T();
  document.documentElement.lang = lang === 'en' ? 'en' : 'pt-br';
  $('hello').textContent = t.hello; $('intro').textContent = t.intro; document.title = t.title + ' · HomeMinerProxy';
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t[e.dataset.t];
  for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('on', b.dataset.lang === lang);
  for (const s of document.querySelectorAll('section[data-s]')) s.hidden = s.dataset.s !== cur();
  $('stepn').textContent = t.step + ' ' + (pos + 1) + ' ' + t.of + ' ' + order().length;
  $('back').style.visibility = pos > 0 ? 'visible' : 'hidden';
  $('next').textContent = pos < order().length - 1 ? t.next : t.finish;
  for (const b of document.querySelectorAll('[data-mine]')) b.classList.toggle('on', (b.dataset.mine === '1') === mine);
  $('mineopts').hidden = !mine;
  if (!$('kwh').value) $('kwh').value = $('cur').value === 'USD' ? '0.15' : '0.90';
}
fetch('/api/setup').then((r) => r.json()).then((j) => {
  info = j;
  if (j.canMine) {
    const sel = $('threads');
    for (let n = 1; n <= j.cores; n++) sel.add(new Option(String(n), String(n)));
    sel.value = String(j.defaultThreads);
    $('mworker').value = j.worker || '';
  }
  render();
}).catch(() => {});
for (const b of document.querySelectorAll('[data-mine]')) b.addEventListener('click', () => { mine = b.dataset.mine === '1'; render(); });
for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => { lang = b.dataset.lang; $('cur').value = lang === 'en' ? 'USD' : 'BRL'; $('tunit').value = lang === 'en' ? 'F' : 'C'; $('kwh').value = ''; render(); });
$('cur').addEventListener('change', () => { $('kwh').value = ''; render(); });
$('cur').value = lang === 'en' ? 'USD' : 'BRL';
$('tunit').value = lang === 'en' ? 'F' : 'C';   // inglês começa em USD e °F; dá para trocar
const showErrors = (errs) => { for (const f of document.querySelectorAll('.f[data-k]')) { const e = errs[f.dataset.k]; f.classList.toggle('bad', !!e); f.querySelector('.ferr').textContent = e ? (T().err[e] || e) : ''; } };
const stepOf = { BTC_ADDRESS: '2', pin: '3', pin2: '3', LOCAL_MINER: 'm', MINER_THREADS: 'm', LOCAL_WORKER: 'm', CURRENCY: '4', POWER_PRICE_KWH: '4', TEMP_UNIT: '4' };
$('back').addEventListener('click', () => { pos = Math.max(0, pos - 1); $('msg').textContent = ''; render(); });
$('next').addEventListener('click', async () => {
  const t = T();
  $('msg').textContent = '';
  if (cur() === '2' && !$('addr').value.trim()) return showErrors({ BTC_ADDRESS: 'address' });
  if (cur() === '3' && !ENV_PIN && $('pin').value !== ($('pin2') || {}).value) return showErrors({ pin2: 'pin2' });
  showErrors({});
  if (pos < order().length - 1) { pos++; render(); return; }
  $('next').disabled = true;
  try {
    const body = { LANGUAGE: lang, BTC_ADDRESS: $('addr').value, pin: $('pin').value, pin2: ($('pin2') || {}).value, CURRENCY: $('cur').value, POWER_PRICE_KWH: $('kwh').value, TEMP_UNIT: $('tunit').value,
      LOCAL_MINER: info.canMine && mine ? '1' : '0', MINER_THREADS: $('threads').value, LOCAL_WORKER: $('mworker').value };
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.errors) { showErrors(r.errors); pos = Math.min(...Object.keys(r.errors).map((k) => Math.max(0, order().indexOf(stepOf[k] || '4')))); render(); $('msg').textContent = t.err.fix; return; }
    if (r.error) { $('msg').textContent = t.err[r.error] || r.error; return; }
    done(r.addr || body.BTC_ADDRESS.trim());
  } catch (_) { $('msg').textContent = t.err.net; } finally { $('next').disabled = false; }
});
function done(addr) {
  const t = T();
  $('wizard').hidden = true; $('done').hidden = false; $('intro').hidden = true;
  const host = location.hostname, local = (h) => /^(localhost|127\.|::1)/.test(h);
  const hosts = [host].concat(info.hosts || []).filter((h, i, a) => h && !local(h) && a.indexOf(h) === i);
  $('srv').textContent = hosts.join('  ·  ') || host;
  $('ports').replaceChildren(...t.ports.map(([p, d]) => { const tr = document.createElement('tr'); tr.innerHTML = '<td></td><td></td>'; tr.children[0].textContent = p; tr.children[1].textContent = d; return tr; }));
  $('usr').textContent = addr + (lang === 'en' ? '.name' : '.nome');
  $('opening').textContent = t.opening;
  const go = async () => { for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); try { const x = await fetch('/api/mining', { cache: 'no-store' }); if (x.ok) { location.href = '/'; return; } } catch (_) {} } };
  setTimeout(go, 8000);   // dá tempo de ler as portas antes de abrir o painel
}
render();
</script></body></html>`;
}

// ---------------------------------------------------------------- servidor do modo instalação
function serve(opts) {
  const dataDir = opts.dataDir;
  const envPin = () => (process.env.SETTINGS_PIN || '').trim();
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let finished = false;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/setup' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      return res.end(page(opts.lang || 'en', !!envPin()));
    }
    if (url === '/api/setup' && req.method === 'GET') {
      const canMine = localminer.available();
      return json(res, 200, { setup: true, hosts: [os.hostname() + '.local', ...lanAddresses()], envPin: !!envPin(),
        canMine, cores: localminer.cores(), defaultThreads: localminer.defaultThreads(), worker: localminer.workerOf('') });
    }
    if (url === '/api/setup' && req.method === 'POST') {
      if (finished) return json(res, 409, { error: 'done' });
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 405, { error: 'option' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch (_) { return json(res, 400, { error: 'option' }); }
        form = form || {};
        // PIN do .env: confere uma vez só (cada erro conta para o bloqueio de 15 minutos)
        const pinState = envPin() ? settings.checkPin(form.pin, envPin()) : null;
        if (pinState === 'locked') return json(res, 429, { error: 'locked' });
        const v = validate(form, envPin(), pinState);
        if (v.errors) return json(res, 400, { errors: v.errors });
        try { apply(dataDir, v.values, v.pin); } catch (e) { return json(res, 500, { error: e.message }); }
        finished = true;
        json(res, 200, { ok: true, restart: true, addr: v.values.BTC_ADDRESS });
        console.log('primeira configuração concluída; reiniciando no modo normal');
        if (opts.onDone) setTimeout(opts.onDone, 600);
      });
      return undefined;
    }
    if (url.startsWith('/api/')) return json(res, 503, { setup: true, error: 'setup' });
    res.writeHead(302, { Location: '/setup' });
    return res.end();
  });
  server.listen(opts.port, opts.host || '0.0.0.0', () => console.log(`Modo instalação: abra http://${os.hostname()}.local:${opts.port}/setup (ou o IP deste servidor)`));
  return server;
}

module.exports = { validate, apply, page, serve, lanAddresses, PIN_RE };
