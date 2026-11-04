// Bot do Telegram: avisos da fazenda e comandos (/status, /workers, /sorte, /recordes).
// Sem dependências: fala direto com a API HTTP do Telegram, por long polling (nada precisa ficar exposto).
//
// Avisos: recorde da fazenda, worker parado e de volta, failover de pool, dinheiro entrando na carteira
// (um bloco achado!) e um resumo diário. No horário silencioso (QUIET_HOURS) as mensagens chegam sem som.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- textos
const STRINGS = {
  pt: {
    loc: 'pt-BR',
    record: (w, d) => `🏆 <b>Novo recorde da fazenda!</b>\n${w} chegou a <b>${d}</b>`,
    personal: (w, d) => `⭐ Recorde pessoal: ${w} chegou a <b>${d}</b>`,
    stopped: (w, ago) => `🔴 <b>${w} parou</b>: sem share há ${ago}`,
    back: (w) => `🟢 ${w} voltou a minerar`,
    failover: (port, primary, active) => `⚠️ <b>${primary} fora do ar</b>: os mineradores da porta ${port} foram para a reserva ${active || '(nenhuma disponível)'}`,
    failback: (port, primary) => `✅ ${primary} voltou: a porta ${port} está de novo na pool principal`,
    money: (sats) => `💰 Entraram <b>${sats} sats</b> na carteira`,
    block: (btc) => `🎉🎉🎉 <b>ACHAMOS UM BLOCO!</b> 🎉🎉🎉\nEntraram <b>${btc} BTC</b> na carteira!`,
    dailyTitle: (d) => `📋 <b>Resumo do dia</b> · ${d}`,
    hashrate: 'Hashrate',
    mining: (n, t) => `Minerando: ${n} de ${t} workers`,
    sharesToday: 'Shares hoje',
    dayBest: (d, w) => `Melhor hash do dia: <b>${d}</b> (${w})`,
    farmRecord: (d, w) => `Recorde da fazenda: <b>${d}</b> (${w})`,
    luckiest: (w, f) => `Mais sortudo: ${w} (${f}×)`,
    failoverNow: (port, primary, active) => `⚠️ porta ${port}: ${primary} fora, usando ${active || '–'}`,
    stoppedNow: (list) => `🔴 Parados: ${list}`,
    panel: 'Abrir o painel',
    noData: 'Ainda sem dados das pools. Tente de novo em um minuto.',
    workersTitle: '<b>Workers</b>',
    neverSeen: 'nunca visto',
    luckTitle: '<b>Sorte</b> (melhor share × esperado para o trabalho feito)',
    luckEmpty: 'Ainda sem shares pelo proxy desde a última contagem.',
    luckRow: (w, f, p) => `${w}: <b>${f}×</b> · melhor que ${p}% das fazendas iguais`,
    recordsTitle: '<b>Hall da fama</b>',
    recordsEmpty: 'Nenhum recorde ainda.',
    achievement: (icon, title, desc, w) => `${icon} <b>Nova conquista!</b>\n<b>${title}</b>${w ? ' · ' + w : ''}\n${desc}`,
    champTitle: '🏆 <b>Campeonato da semana</b> (por sorte relativa)',
    champEmpty: 'Nenhum share na semana ainda.',
    champRow: (m, w, f, d, sh) => `${m} <b>${w}</b> · ${f ? f + '× · ' : ''}${d}${sh ? ' (' + sh + ' shares)' : ''}`,
    champLast: (w, d) => `Campeão da semana passada: 🏆 <b>${w}</b> (${d})`,
    sundayWinner: (w, f, d) => `\n🏆 <b>Campeão da semana:</b> ${w} (${f ? f + '× · ' : ''}${d})`,
    achTitle: (u, t) => `🎖️ <b>Conquistas da fazenda</b> (${u}/${t})`,
    plugReboot: (w) => `🔌 <b>Tomada reiniciada automaticamente</b>${w && w !== '*' ? ' (' + w + ')' : ''}: minerador sem shares pelo tempo limite`,
    plugNone: 'Tomada inteligente não configurada. Configure em Tomada Inteligente (SmartLife / Tuya) na tela /config.',
    plugTitle: '🔌 <b>Tomada inteligente</b>',
    plugState: (on) => `Estado: <b>${on === false ? '🔴 desligada' : '🟢 ligada'}</b>`,
    plugPower: (w, v, ma) => `Consumo: <b>${w} W</b>${v != null ? ' · ' + v + ' V' : ''}${ma != null ? ' · ' + ma + ' mA' : ''}`,
    plugWorker: (w) => `Vinculada a: <b>${w === '*' ? 'fazenda inteira' : w || 'só monitorar'}</b>`,
    plugActions: 'Comandos: <code>/tomada ligar</code> · <code>/tomada desligar</code> · <code>/tomada reiniciar</code>',
    plugSwitched: (on) => on ? '🟢 Tomada <b>ligada</b>.' : '🔴 Tomada <b>desligada</b>.',
    plugRebooted: '🔄 Tomada <b>reiniciada</b> (desligou 8 s e religou).',
    plugErr: (e) => `⚠️ Falha ao falar com a tomada: ${e}`,
    help: '<b>Comandos</b>\n/status · resumo da fazenda\n/workers · cada worker\n/sorte · medidor de sorte\n/recordes · hall da fama\n/campeonato · ranking da semana\n/conquistas · marcos da fazenda\n/tomada · leitura e controle da tomada SmartLife\n/bilhete · bilhete de loteria de hoje\n/ajuda · esta lista',
    ticketCaption: (d, w) => `🎟️ Bilhete de hoje: melhor hash <b>${d}</b> (${w}). Não premiado… ainda!`,
    noTicket: 'Ainda não há bilhete hoje: falta um share de hoje passando pelo proxy ou o hash do último bloco.',
    setup: (id) => `Olá! O id deste chat é <code>${id}</code>.\nColoque <code>TELEGRAM_CHAT_ID=${id}</code> em /etc/mineracao.env e reinicie o painel:\n<code>sudo systemctl restart mineracao-painel</code>`,
    hello: 'Pronto! Este chat vai receber os avisos da fazenda. ⛏️\n\n',
    commands: [['status', 'Resumo da fazenda'], ['workers', 'Cada worker'], ['sorte', 'Medidor de sorte'], ['recordes', 'Hall da fama'], ['campeonato', 'Ranking da semana'], ['conquistas', 'Marcos da fazenda'], ['tomada', 'Tomada inteligente (SmartLife)'], ['bilhete', 'Bilhete de loteria de hoje'], ['ajuda', 'Comandos']],
    units: ['', ' mil', ' mi', ' bi', ' tri', ' quatri'],
    ago: { s: 's', min: 'min', h: 'h', d: 'd' },
  },
  en: {
    loc: 'en-US',
    record: (w, d) => `🏆 <b>New farm record!</b>\n${w} reached <b>${d}</b>`,
    personal: (w, d) => `⭐ Personal record: ${w} reached <b>${d}</b>`,
    stopped: (w, ago) => `🔴 <b>${w} stopped</b>: no share for ${ago}`,
    back: (w) => `🟢 ${w} is mining again`,
    failover: (port, primary, active) => `⚠️ <b>${primary} is down</b>: miners on port ${port} moved to backup ${active || '(none available)'}`,
    failback: (port, primary) => `✅ ${primary} is back: port ${port} is on the main pool again`,
    money: (sats) => `💰 <b>${sats} sats</b> arrived in the wallet`,
    block: (btc) => `🎉🎉🎉 <b>WE FOUND A BLOCK!</b> 🎉🎉🎉\n<b>${btc} BTC</b> arrived in the wallet!`,
    dailyTitle: (d) => `📋 <b>Daily summary</b> · ${d}`,
    hashrate: 'Hashrate',
    mining: (n, t) => `Mining: ${n} of ${t} workers`,
    sharesToday: 'Shares today',
    dayBest: (d, w) => `Best hash today: <b>${d}</b> (${w})`,
    farmRecord: (d, w) => `Farm record: <b>${d}</b> (${w})`,
    luckiest: (w, f) => `Luckiest: ${w} (${f}×)`,
    failoverNow: (port, primary, active) => `⚠️ port ${port}: ${primary} down, using ${active || '–'}`,
    stoppedNow: (list) => `🔴 Stopped: ${list}`,
    panel: 'Open the dashboard',
    noData: 'No pool data yet. Try again in a minute.',
    workersTitle: '<b>Workers</b>',
    neverSeen: 'never seen',
    luckTitle: '<b>Luck</b> (best share vs. expected for the work done)',
    luckEmpty: 'No shares through the proxy since the count started.',
    luckRow: (w, f, p) => `${w}: <b>${f}×</b> · better than ${p}% of identical farms`,
    recordsTitle: '<b>Hall of fame</b>',
    recordsEmpty: 'No records yet.',
    achievement: (icon, title, desc, w) => `${icon} <b>New achievement!</b>\n<b>${title}</b>${w ? ' · ' + w : ''}\n${desc}`,
    champTitle: '🏆 <b>Weekly championship</b> (by relative luck)',
    champEmpty: 'No shares this week yet.',
    champRow: (m, w, f, d, sh) => `${m} <b>${w}</b> · ${f ? f + '× · ' : ''}${d}${sh ? ' (' + sh + ' shares)' : ''}`,
    champLast: (w, d) => `Last week's champion: 🏆 <b>${w}</b> (${d})`,
    sundayWinner: (w, f, d) => `\n🏆 <b>Champion of the week:</b> ${w} (${f ? f + '× · ' : ''}${d})`,
    achTitle: (u, t) => `🎖️ <b>Farm achievements</b> (${u}/${t})`,
    plugReboot: (w) => `🔌 <b>Smart plug auto-rebooted</b>${w && w !== '*' ? ' (' + w + ')' : ''}: miner had no shares for the watchdog limit`,
    plugNone: 'Smart plug not configured. Set it up under Smart Plug (SmartLife / Tuya) in /config.',
    plugTitle: '🔌 <b>Smart plug</b>',
    plugState: (on) => `State: <b>${on === false ? '🔴 off' : '🟢 on'}</b>`,
    plugPower: (w, v, ma) => `Power: <b>${w} W</b>${v != null ? ' · ' + v + ' V' : ''}${ma != null ? ' · ' + ma + ' mA' : ''}`,
    plugWorker: (w) => `Linked to: <b>${w === '*' ? 'whole farm' : w || 'monitor only'}</b>`,
    plugActions: 'Commands: <code>/plug on</code> · <code>/plug off</code> · <code>/plug reboot</code>',
    plugSwitched: (on) => on ? '🟢 Smart plug turned <b>on</b>.' : '🔴 Smart plug turned <b>off</b>.',
    plugRebooted: '🔄 Smart plug <b>rebooted</b> (off for 8 s, then back on).',
    plugErr: (e) => `⚠️ Smart plug error: ${e}`,
    help: '<b>Commands</b>\n/status · farm summary\n/workers · each worker\n/luck · luck meter\n/records · hall of fame\n/championship · weekly ranking\n/achievements · farm milestones\n/plug · smart plug reading & control\n/ticket · today\'s lottery ticket\n/help · this list',
    ticketCaption: (d, w) => `🎟️ Today's ticket: best hash <b>${d}</b> (${w}). Not a winner… yet!`,
    noTicket: 'No ticket yet today: it needs a share from today through the proxy and the latest block hash.',
    setup: (id) => `Hi! This chat's id is <code>${id}</code>.\nPut <code>TELEGRAM_CHAT_ID=${id}</code> in /etc/mineracao.env and restart the dashboard:\n<code>sudo systemctl restart mineracao-painel</code>`,
    hello: 'All set! This chat will get the farm alerts. ⛏️\n\n',
    commands: [['status', 'Farm summary'], ['workers', 'Each worker'], ['luck', 'Luck meter'], ['records', 'Hall of fame'], ['championship', 'Weekly ranking'], ['achievements', 'Farm milestones'], ['plug', 'Smart plug (SmartLife)'], ['ticket', 'Today\'s lottery ticket'], ['help', 'Commands']],
    units: ['', 'k', 'M', 'G', 'T', 'P'],
    ago: { s: 's', min: 'min', h: 'h', d: 'd' },
  },
};
const ALIASES = { sorte: 'luck', recordes: 'records', campeonato: 'championship', championship: 'championship', conquistas: 'achievements', achievements: 'achievements', tomada: 'plug', plug: 'plug', ajuda: 'help', bilhete: 'ticket', ticket: 'ticket', start: 'start', status: 'status', workers: 'workers', luck: 'luck', records: 'records', help: 'help' };

// ---------------------------------------------------------------- formatação
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function formatter(lang) {
  const T = STRINGS[lang] || STRINGS.en;
  const num = (n, d = 2) => Number(n).toLocaleString(T.loc, { maximumFractionDigits: d });
  const diff = (d) => {
    d = Number(d) || 0;
    if (d < 1) return num(d, 5);
    const k = Math.min(T.units.length - 1, Math.floor(Math.log10(d) / 3));
    return d < 1e6 ? num(d, 2) : num(d / Math.pow(1000, k), 2) + T.units[k];
  };
  const hashrate = (h) => {
    const u = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let i = 0; h = Number(h) || 0;
    while (h >= 1000 && i < u.length - 1) { h /= 1000; i++; }
    return num(h, h < 10 ? 2 : 1) + ' ' + u[i];
  };
  const ago = (ms) => {
    const s = Math.max(0, ms / 1000), A = T.ago;
    if (s < 90) return Math.round(s) + ' ' + A.s;
    if (s < 5400) return Math.round(s / 60) + ' ' + A.min;
    if (s < 172800) return num(s / 3600, 1) + ' ' + A.h;
    return Math.round(s / 86400) + ' ' + A.d;
  };
  return { T, num, diff, hashrate, ago };
}

// ---------------------------------------------------------------- o que mudou desde a última olhada
// Resumo do /api/mining só com o que os avisos precisam.
function digest(snap) {
  const f = snap.farm || {};
  const plug = (snap.energy || {}).plug || {};
  return {
    hasData: !!f.hasData,
    best: Number(f.best) || 0,
    bestWorker: ((snap.hall || [])[0] || {}).worker || '—',
    workers: (f.workers || []).map((w) => ({ name: w.name, state: w.state, inactive: !!w.inactive, best: Number(w.bestDifficulty) || 0, lastSeen: w.lastSeen })),
    failover: ((snap.proxy || {}).failover || []).map((r) => ({ listen: r.listen, primary: r.primary, active: r.active })),
    sats: (snap.wallet || {}).okAt ? (snap.wallet || {}).sats : null,
    achievements: ((snap.achievements || {}).list || []).filter((a) => a.unlocked).map((a) => ({ id: a.id, icon: a.icon, pt: a.pt, en: a.en, worker: a.worker })),
    plugReboots: Number(plug.rebootCount) || 0,
    plugWorker: plug.worker || '',
  };
}

// Compara dois resumos e devolve os avisos. `down` guarda quem já foi anunciado como parado.
function diffEvents(prev, cur, opts = {}) {
  const fm = formatter(opts.lang);
  const T = fm.T, out = [];
  const ignore = opts.ignore || [], down = opts.down || new Set(), now = opts.now || Date.now();
  if (!prev || !cur.hasData) return out;
  if (cur.best > prev.best + 1e-9 && prev.best > 0) out.push({ type: 'record', text: T.record(escHtml(cur.bestWorker), fm.diff(cur.best)) });
  const before = new Map(prev.workers.map((w) => [w.name, w]));
  for (const w of cur.workers) {
    const p = before.get(w.name);
    if (opts.personal && p && w.best > p.best + 1e-9 && !(w.best >= cur.best && cur.best > prev.best)) {
      out.push({ type: 'personal', text: T.personal(escHtml(w.name), fm.diff(w.best)) });
    }
    if (ignore.includes(w.name)) continue;
    if (w.state === 'stale' && !w.inactive && !down.has(w.name)) {
      down.add(w.name);
      out.push({ type: 'stopped', text: T.stopped(escHtml(w.name), w.lastSeen ? fm.ago(now - new Date(w.lastSeen).getTime()) : '–') });
    } else if ((w.state === 'ok' || w.state === 'quiet') && down.has(w.name)) {
      down.delete(w.name);
      out.push({ type: 'back', text: T.back(escHtml(w.name)) });
    }
  }
  const was = new Set(prev.failover.map((r) => r.listen)), is = new Set(cur.failover.map((r) => r.listen));
  for (const r of cur.failover) if (!was.has(r.listen)) out.push({ type: 'failover', text: T.failover(r.listen, escHtml(r.primary), escHtml(r.active)) });
  for (const r of prev.failover) if (!is.has(r.listen)) out.push({ type: 'failback', text: T.failback(r.listen, escHtml(r.primary)) });
  if (prev.sats != null && cur.sats != null && cur.sats > prev.sats) {
    const got = cur.sats - prev.sats;
    out.push(got >= 1e8
      ? { type: 'block', text: T.block(fm.num(got / 1e8, 8)) }
      : { type: 'money', text: T.money(fm.num(got, 0)) });
  }
  const prevAch = new Set((prev.achievements || []).map((a) => a.id));
  for (const a of cur.achievements || []) {
    if (!prevAch.has(a.id)) {
      const pair = (opts.lang === 'pt' ? a.pt : a.en) || a.pt || [a.id, ''];
      out.push({ type: 'achievement', text: T.achievement(a.icon || '🎖️', escHtml(pair[0]), escHtml(pair[1]), a.worker ? escHtml(a.worker) : '') });
    }
  }
  if ((cur.plugReboots || 0) > (prev.plugReboots || 0)) {
    out.push({ type: 'plug_reboot', text: T.plugReboot(escHtml(cur.plugWorker || '')) });
  }
  return out;
}

// ---------------------------------------------------------------- respostas aos comandos
function statusText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T, f = snap.farm || {};
  if (!f.hasData) return T.noData;
  const ws = (f.workers || []).filter((w) => !w.inactive && w.state !== 'unknown');
  const mining = ws.filter((w) => w.state === 'ok' || w.state === 'quiet');
  const stale = ws.filter((w) => w.state === 'stale');
  const top = (snap.hall || [])[0];
  const day = (snap.nearBlock || {}).dayBestHash;
  const luck = ((snap.luck || {}).workers || [])[0];
  const lines = [
    `⛏️ ${T.hashrate}: <b>${fm.hashrate(f.hashrate)}</b>`,
    T.mining(mining.length, ws.length),
    `${T.sharesToday}: ${fm.num((f.shares || {}).today || 0, 0)}`,
  ];
  if (day && day.date === (opts.today || new Date().toLocaleDateString('sv'))) lines.push(T.dayBest(fm.diff(day.diff), escHtml(day.worker)));
  if (top) lines.push(T.farmRecord(fm.diff(top.value), escHtml(top.worker)));
  if (luck) lines.push(T.luckiest(escHtml(luck.name), fm.num(luck.factor, 2)));
  for (const r of (snap.proxy || {}).failover || []) lines.push(T.failoverNow(r.listen, escHtml(r.primary), escHtml(r.active)));
  if (stale.length) lines.push(T.stoppedNow(stale.map((w) => escHtml(w.name)).join(', ')));
  if (opts.panelUrl) lines.push(`\n<a href="${escHtml(opts.panelUrl)}">${T.panel}</a>`);
  return lines.join('\n');
}

function workersText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T, f = snap.farm || {};
  if (!f.hasData) return T.noData;
  const dot = { ok: '🟢', quiet: '🟡', stale: '🔴', unknown: '⚪' };
  const now = opts.now || Date.now();
  const rows = (f.workers || []).filter((w) => !w.inactive).map((w) =>
    `${dot[w.state] || '⚪'} <b>${escHtml(w.name)}</b> · ${fm.hashrate(w.hashRate)} · ${fm.diff(w.bestDifficulty)}` +
    ` · ${w.lastSeen ? fm.ago(now - new Date(w.lastSeen).getTime()) : T.neverSeen}`);
  return [T.workersTitle, ...rows].join('\n');
}

function luckText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T;
  const ws = (snap.luck || {}).workers || [];
  if (!ws.length) return T.luckTitle + '\n' + T.luckEmpty;
  return [T.luckTitle, ...ws.map((w) => T.luckRow(escHtml(w.name), fm.num(w.factor, 2), Math.round(w.percentile * 100)))].join('\n');
}

function recordsText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T;
  const hall = snap.hall || [];
  if (!hall.length) return T.recordsTitle + '\n' + T.recordsEmpty;
  const medal = ['🥇', '🥈', '🥉', '4.', '5.'];
  return [T.recordsTitle, ...hall.slice(0, 5).map((r, i) =>
    `${medal[i]} <b>${fm.diff(r.value)}</b> · ${escHtml(r.worker)} · ${new Date(r.at).toLocaleDateString(T.loc)}`)].join('\n');
}

function championshipText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T;
  const ch = snap.championship || {}, st = ch.standings || [];
  const medal = ['🏆', '🥈', '🥉', '4.', '5.'];
  const lines = [T.champTitle];
  if (!st.length) lines.push(T.champEmpty);
  else {
    for (const [i, w] of st.slice(0, 5).entries()) {
      lines.push(T.champRow(medal[i] || `${i + 1}.`, escHtml(w.name), w.factor != null ? fm.num(w.factor, 2) : null, fm.diff(w.best), w.shares ? fm.num(w.shares, 0) : null));
    }
  }
  const lw = ch.lastWeek && ch.lastWeek.winner;
  if (lw) lines.push('\n' + T.champLast(escHtml(lw.name), fm.diff(lw.best)));
  return lines.join('\n');
}

function achievementsText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T;
  const ach = snap.achievements || {}, list = ach.list || [];
  const isPt = opts.lang === 'pt';
  const lines = [T.achTitle(ach.unlocked || 0, ach.total || list.length)];
  for (const a of list) {
    const pair = (isPt ? a.pt : a.en) || a.pt || [a.id, ''];
    const ico = a.unlocked ? a.icon : '🔒';
    lines.push(`${ico} <b>${escHtml(pair[0])}</b>${a.unlocked && a.worker ? ' (' + escHtml(a.worker) + ')' : ''} — ${escHtml(pair[1])}`);
  }
  return lines.join('\n');
}

function plugText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T;
  const p = opts.live || ((snap.energy || {}).plug) || null;
  if (!p || (!p.okAt && p.on === undefined && p.watts === undefined)) return T.plugNone;
  return [
    T.plugTitle,
    T.plugState(p.on),
    T.plugPower(fm.num(p.watts || 0, 1), p.volts != null ? fm.num(p.volts, 0) : null, p.currentMa != null ? fm.num(p.currentMa, 0) : null),
    T.plugWorker(escHtml(p.worker || '')),
    T.plugActions,
  ].join('\n');
}

function dailyText(snap, opts = {}) {
  const fm = formatter(opts.lang), T = fm.T;
  const d = new Date(opts.now || Date.now());
  const date = d.toLocaleDateString(T.loc);
  const ld = (snap.championship || {}).leader;
  const sun = d.getDay() === 0 && ld ? T.sundayWinner(escHtml(ld.name), ld.factor != null ? fm.num(ld.factor, 2) : null, fm.diff(ld.best)) : '';
  return T.dailyTitle(date) + '\n\n' + statusText(snap, opts) + sun;
}

// Melhor hash de hoje (o bilhete só sai com um share de hoje e o hash do último bloco)
function todayBest(snap, today = new Date().toLocaleDateString('sv')) {
  const nb = snap.nearBlock || {};
  return nb.tip && nb.dayBestHash && nb.dayBestHash.date === today ? nb.dayBestHash : null;
}

// Gera o PNG do bilhete com o ticket.py (Pillow, o mesmo do placar do cubo). Sem Python ou Pillow: null.
function ticketImage(snap, lang, opts = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(opts.python || 'python3', [opts.script || path.join(__dirname, 'ticket.py'), '--lang', lang], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (_) { return resolve(null); }
    const out = [];
    const timer = setTimeout(() => p.kill(), opts.timeoutMs || 30000);
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.stdout.on('data', (c) => out.push(c));
    p.on('close', (code) => { clearTimeout(timer); const png = Buffer.concat(out); resolve(code === 0 && png.length > 100 ? png : null); });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(snap));
  });
}

// "/sorte@MeuBot arg" → "luck"
function parseCommand(text) {
  const m = /^\/([a-zA-Z_]+)(?:@\S+)?/.exec(String(text || '').trim());
  return m ? ALIASES[m[1].toLowerCase()] || null : null;
}

// ---------------------------------------------------------------- cliente da API
function apiCall(base, token, method, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}/bot${token}/${method}`);
    const data = JSON.stringify(body || {});
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (_) { /* resposta inválida */ }
        if (j && j.ok) return resolve(j.result);
        const err = new Error((j && j.description) || `HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    req.end(data);
  });
}

// Upload de foto (multipart/form-data, sem dependências)
function apiPhoto(base, token, fields, png, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const boundary = '----fazenda' + Date.now().toString(16);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="bilhete.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const u = new URL(`${base}/bot${token}/sendPhoto`);
    const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* inválida */ } if (j && j.ok) resolve(j.result); else reject(new Error((j && j.description) || `HTTP ${res.statusCode}`)); });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------- o bot
// opts: token, chatIds[], lang, snapshot(), quiet(), ignore[], personal, dailyHour (null = sem resumo),
//       panelUrl, stateFile, api (base da API; muda nos testes), tickMs, warmupMs, log
function start(opts) {
  const lang = STRINGS[opts.lang] ? opts.lang : 'en';
  const T = STRINGS[lang];
  const base = (opts.api || 'https://api.telegram.org').replace(/\/$/, '');
  const chatIds = (opts.chatIds || []).map(String).filter(Boolean);
  const log = opts.log || ((m) => console.log('telegram: ' + m));
  const call = (method, body, t) => apiCall(base, opts.token, method, body, t);
  const fopts = () => ({ lang, panelUrl: opts.panelUrl, ignore: opts.ignore || [], personal: !!opts.personal });

  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8')); } catch (_) { /* primeira vez */ }
  const state = { offset: saved.offset || 0, lastDaily: saved.lastDaily || null };
  const save = () => { if (opts.stateFile) try { fs.writeFileSync(opts.stateFile, JSON.stringify(state)); } catch (_) { /* segue */ } };

  let stopped = false;
  const timers = [];

  const send = (chatId, text, silent) => call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: !!silent,
  }).catch((e) => log('falha ao enviar: ' + e.message));
  const broadcast = (text, silent) => Promise.all(chatIds.map((id) => send(id, text, silent)));
  // foto com legenda; se a foto falhar, manda só o texto (a legenda do Telegram vai até 1024 caracteres)
  const sendPhoto = (chatId, png, caption, silent) => apiPhoto(base, opts.token, {
    chat_id: chatId, caption: caption.length <= 1024 ? caption : undefined, parse_mode: 'HTML', disable_notification: silent ? 'true' : undefined,
  }, png).then(() => (caption.length > 1024 ? send(chatId, caption, silent) : null))
    .catch((e) => { log('falha ao enviar o bilhete: ' + e.message); return send(chatId, caption, silent); });
  const ticketFor = (snap) => (todayBest(snap) ? ticketImage(snap, lang, { python: opts.python, script: opts.ticketScript }) : Promise.resolve(null));

  // comandos
  async function handle(msg) {
    if (!msg || !msg.chat || typeof msg.text !== 'string') return;
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    const id = String(msg.chat.id);
    if (!chatIds.includes(id)) {
      // sem chat configurado, o /start ensina a configurar; com chat configurado, estranhos são ignorados
      if (cmd === 'start' && !chatIds.length) await send(id, T.setup(id));
      return;
    }
    const snap = opts.snapshot();
    const o = fopts();
    if (cmd === 'ticket') {
      const png = await ticketFor(snap), b = todayBest(snap);
      if (!png) return send(id, T.noTicket);
      const fm = formatter(lang);
      return sendPhoto(id, png, T.ticketCaption(fm.diff(b.diff), escHtml(b.worker)));
    }
    if (cmd === 'plug') {
      const arg = ((/^\/\S+\s+(\S+)/.exec(msg.text.trim()) || [])[1] || '').toLowerCase();
      if (arg === 'ligar' || arg === 'on') {
        if (!opts.tuya) return send(id, T.plugNone);
        const r = await opts.tuya.setSwitch(true);
        return send(id, r && r.ok ? T.plugSwitched(true) : T.plugErr(escHtml((r && r.error) || 'erro')));
      }
      if (arg === 'desligar' || arg === 'off') {
        if (!opts.tuya) return send(id, T.plugNone);
        const r = await opts.tuya.setSwitch(false);
        return send(id, r && r.ok ? T.plugSwitched(false) : T.plugErr(escHtml((r && r.error) || 'erro')));
      }
      if (arg === 'reiniciar' || arg === 'reboot') {
        if (!opts.tuya) return send(id, T.plugNone);
        const r = await opts.tuya.powerCycle(opts.rebootOffMs || 8000);
        return send(id, r && r.ok ? T.plugRebooted : T.plugErr(escHtml((r && r.error) || 'erro')));
      }
      let live = null;
      if (opts.tuya && typeof opts.tuya.getStatus === 'function') {
        const r = await opts.tuya.getStatus();
        if (r && r.ok && r.status) live = { ...((snap.energy || {}).plug || {}), ...r.status, okAt: new Date().toISOString() };
      }
      return send(id, plugText(snap, { ...o, live }));
    }
    const text = cmd === 'status' ? statusText(snap, o)
      : cmd === 'workers' ? workersText(snap, o)
        : cmd === 'luck' ? luckText(snap, o)
          : cmd === 'records' ? recordsText(snap, o)
            : cmd === 'championship' ? championshipText(snap, o)
              : cmd === 'achievements' ? achievementsText(snap, o)
                : cmd === 'start' ? T.hello + T.help
                  : T.help;
    await send(id, text);
  }

  async function poll() {
    while (!stopped) {
      try {
        const ups = await call('getUpdates', { offset: state.offset, timeout: opts.pollS ?? 50, allowed_updates: ['message'] }, ((opts.pollS ?? 50) + 10) * 1000);
        for (const u of ups) {
          state.offset = u.update_id + 1;
          try { await handle(u.message); } catch (e) { log('erro no comando: ' + e.message); }
        }
        if (ups.length) save();
      } catch (e) {
        if (stopped) return;
        if (e.status === 401 || e.status === 404) { log('token recusado pelo Telegram; confira TELEGRAM_BOT_TOKEN'); return; }
        log('sem conexão com o Telegram (' + e.message + '); tento de novo em 30 s');
        await new Promise((r) => timers.push(setTimeout(r, 30e3)));
      }
    }
  }

  // avisos
  let prev = null;
  const down = new Set();
  function tick() {
    let snap;
    try { snap = opts.snapshot(); } catch (_) { return; }
    const cur = digest(snap);
    if (!cur.hasData) return;
    if (!chatIds.length) { prev = cur; return; }
    const silent = opts.quiet ? opts.quiet() : false;
    for (const ev of diffEvents(prev, cur, { ...fopts(), down })) broadcast(ev.text, silent && ev.type !== 'block');
    prev = cur;
    // resumo diário, uma vez por dia, na hora marcada
    const now = new Date(), day = now.toLocaleDateString('sv');
    if (opts.dailyHour != null && now.getHours() === opts.dailyHour && state.lastDaily !== day) {
      state.lastDaily = day; save();
      const text = dailyText(snap, fopts());
      ticketFor(snap).then((png) => Promise.all(chatIds.map((id) => (png ? sendPhoto(id, png, text, silent) : send(id, text, silent)))));
    }
  }

  call('getMe').then((me) => {
    log(`bot @${me.username} ativo` + (chatIds.length ? `, avisos para ${chatIds.length} chat(s)` : '; mande /start para o bot para descobrir o TELEGRAM_CHAT_ID'));
    call('setMyCommands', { commands: T.commands.map(([command, description]) => ({ command, description })) }).catch(() => {});
  }).catch((e) => log('não consegui falar com o Telegram: ' + e.message));
  poll();
  // espera as primeiras coletas antes de comparar, para não avisar "voltou" de quem só estava sem dados
  timers.push(setTimeout(() => { tick(); timers.push(setInterval(tick, opts.tickMs || 60e3)); }, opts.warmupMs ?? 120e3));
  for (const t of timers) if (t.unref) t.unref();

  return {
    tick, broadcast,
    stop() { stopped = true; timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); },
  };
}

module.exports = { start, todayBest, ticketImage, digest, diffEvents, statusText, workersText, luckText, recordsText, championshipText, achievementsText, plugText, dailyText, parseCommand, formatter, STRINGS };
