// Idiomas do painel: o código-fonte da página está em português (pt-BR); a versão em inglês é gerada
// trocando cada trecho da tabela EN abaixo. O teste tests/i18n.test.js garante que todo trecho da
// tabela existe na página, então uma alteração no texto em português que quebre a tradução é detectada.

const LOCALES = { pt: 'pt-BR', en: 'en-US' };

// Escolhe o idioma: ?lang= na URL > botão PT|EN (cookie) > LANGUAGE do servidor > idioma do navegador > inglês
function pickLang(req, serverLang) {
  const q = new URL(req.url, 'http://x').searchParams.get('lang');
  const norm = (v) => { v = String(v || '').toLowerCase(); return v.startsWith('pt') ? 'pt' : v.startsWith('en') ? 'en' : ''; };
  if (norm(q)) return norm(q);
  const cookie = (String(req.headers.cookie || '').match(/(?:^|;\s*)lang=([^;]*)/) || [])[1];
  if (norm(cookie)) return norm(cookie);
  if (serverLang) return serverLang;
  const accept = String(req.headers['accept-language'] || '').split(',').map((s) => norm(s.trim())).find(Boolean);
  return accept || 'en';
}

// [trecho em português, trecho em inglês] — aplicados em ordem (os mais longos e específicos primeiro)
const EN = [
  // ---------- cabeçalho e telas fixas
  ['<html lang="pt-br">', '<html lang="en">'],
  ['<title>Fazenda de Mineração</title>', '<title>Mining Farm</title>'],
  ['<h1>⛏️ Fazenda de <span>Mineração</span></h1>', '<h1>⛏️ Mining <span>Farm</span></h1>'],
  ['<div class="upd" id="upd">carregando…</div>', '<div class="upd" id="upd">loading…</div>'],
  ['title="Configurações"', 'title="Settings"'],
  ['<a class="langsw" id="langsw" href="#" title="Switch to English"><b>PT</b> | EN</a>', '<a class="langsw" id="langsw" href="#" title="Mudar para português">PT | <b>EN</b></a>'],
  ['<h2 class="sect">Fazenda</h2>', '<h2 class="sect">Farm</h2>'],
  ['<div class="label">Recorde (Best Difficulty)</div>', '<div class="label">Record (best difficulty)</div>'],
  ['<div class="label">Hashrate da fazenda</div>', '<div class="label">Farm hashrate</div>'],
  ['<div class="label">Chance de bloco por ano</div>', '<div class="label">Block odds per year</div>'],
  ['<div class="label">Shares hoje</div>', '<div class="label">Shares today</div>'],
  ['<span class="dot"></span>ativo <span class="dot quiet"></span>sem share recente <span class="dot unknown"></span>não listado <span class="dot stale"></span>parado',
    '<span class="dot"></span>active <span class="dot quiet"></span>no recent share <span class="dot unknown"></span>not listed <span class="dot stale"></span>stopped'],
  ['<th>Nome</th><th>Hashrate</th><th>Recorde</th><th>Visto há</th>', '<th>Name</th><th>Hashrate</th><th>Record</th><th>Last seen</th>'],
  ['<td colspan="4" class="sub">aguardando dados…</td>', '<td colspan="4" class="sub">waiting for data…</td>'],
  ['Distância até um bloco, em escala logarítmica.', 'Distance to a block, on a log scale.'],
  ['<div class="label">Carteira</div>', '<div class="label">Wallet</div>'],
  ['<div class="label">Valor</div><div class="big" id="wfiat">', '<div class="label">Value</div><div class="big" id="wfiat">'],
  ['<div class="label">Movimentação</div>', '<div class="label">Activity</div>'],
  ['<h2 class="sect">Rede Bitcoin</h2>', '<h2 class="sect">Bitcoin network</h2>'],
  ['<div class="label">Último bloco</div>', '<div class="label">Latest block</div>'],
  ['<div class="label">Ajuste de dificuldade</div>', '<div class="label">Difficulty adjustment</div>'],
  ['<div class="label">Próximo halving</div>', '<div class="label">Next halving</div>'],
  ['<div class="label">Taxa rápida</div>', '<div class="label">Fast fee</div>'],
  ['<div class="label">Prêmio em jogo</div>', '<div class="label">Prize at stake</div>'],
  ['<div class="lead">Se a fazenda achar o próximo bloco, leva</div>', '<div class="lead">If the farm finds the next block, it takes home</div>'],
  ['<div class="label">Máquina do tempo</div>', '<div class="label">Time machine</div>'],
  ['<h2 class="sect">Histórico</h2>', '<h2 class="sect">History</h2>'],
  ['<div class="label">Hashrate da fazenda · últimas 24 h</div>', '<div class="label">Farm hashrate · last 24 h</div>'],
  ['<div class="label">Hall da fama</div>', '<div class="label">Hall of fame</div>'],
  ['<span class="sub">aguardando dados…</span>', '<span class="sub">waiting for data…</span>'],
  ['<div class="label">Evolução do recorde (escala logarítmica)</div>', '<div class="label">Record over time (log scale)</div>'],
  ['<div class="label" id="hLabel">Servidor</div>', '<div class="label" id="hLabel">Server</div>'],
  ['<div class="k">Temperatura</div>', '<div class="k">Temperature</div>'],
  ['<div class="k">Memória</div>', '<div class="k">Memory</div>'],
  ['<div class="k">Ligado há</div>', '<div class="k">Uptime</div>'],
  ['<div class="label">Energia (estimativa)</div>', '<div class="label">Energy (estimate)</div>'],
  ['<div class="label" id="qbL1">Hash do último bloco</div>', '<div class="label" id="qbL1">Latest block hash</div>'],
  ['<div class="label" id="qbL2">Nosso melhor hash</div>', '<div class="label" id="qbL2">Our best hash</div>'],
  ['<div class="label" id="qbL3">Melhor de hoje</div>', '<div class="label" id="qbL3">Best today</div>'],
  ['Cada <b class="z">0</b> a mais na frente deixa o hash 16 vezes mais difícil de achar.', 'Each extra leading <b class="z">0</b> makes the hash 16 times harder to find.'],
  ['<div class="label">Zeros na frente</div>', '<div class="label">Leading zeros</div>'],
  ['<div class="label">O abismo</div>', '<div class="label">The gap</div>'],
  ['<div class="label">Sorte do vencedor</div>', '<div class="label">Winner\'s luck</div>'],
  ['<div class="label">Mais sortudo (15 blocos)</div>', '<div class="label">Luckiest (15 blocks)</div>'],
  ['<div class="label">Régua da dificuldade (escala logarítmica)</div>', '<div class="label">Difficulty ruler (log scale)</div>'],

  // ---------- formatos
  ["const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];", "const MESES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];"],
  ["const s = [[1e12,'trilhões'],[1e9,'bilhões'],[1e6,'milhões'],[1e3,'mil']];", "const s = [[1e12,'trillion'],[1e9,'billion'],[1e6,'million'],[1e3,'thousand']];"],
  ["if (m < 1) return 'agora';", "if (m < 1) return 'now';"],
  ["return nf(d, d < 10 ? 1 : 0) + ' dias';", "return nf(d, d < 10 ? 1 : 0) + ' days';"],
  ["[[1e12, ' tri'], [1e9, ' bi'], [1e6, ' mi'], [1e3, ' mil']]", "[[1e12, ' T'], [1e9, ' B'], [1e6, ' M'], [1e3, ' k']]"],
  ["[[1, '1'], [1e3, 'mil'], [1e6, 'milhão'], [1e9, 'bilhão'], [1e12, 'trilhão'], [1e15, 'quatrilhão']]", "[[1, '1'], [1e3, 'thousand'], [1e6, 'million'], [1e9, 'billion'], [1e12, 'trillion'], [1e15, 'quadrillion']]"],
  ["const medals = ['1º', '2º', '3º', '4º', '5º'];", "const medals = ['1st', '2nd', '3rd', '4th', '5th'];"],

  // ---------- tela da fazenda
  ["'faltam ' + fmtBig(D / f.best) + ' de vezes'", "fmtBig(D / f.best) + ' times to go'"],
  ["' confirmados'", "' confirmed'"],
  ["' não listados'", "' not listed'"],
  ["' parado(s)'", "' stopped'"],
  ["' inativo(s) oculto(s)'", "' inactive hidden'"],
  ["'esconder inativos' : 'mostrar inativos ('", "'hide inactive' : 'show inactive ('"],
  ["' · pool mediu ~' + fmtHash(f.poolHashrate) + ' na última hora'", "' · pool measured ~' + fmtHash(f.poolHashrate) + ' in the last hour'"],
  ["set('odds', '1 em ' + fmtBig(od.perYear)); set('eta', 'tempo esperado: ~' + fmtBig(od.years) + ' de anos');", "set('odds', '1 in ' + fmtBig(od.perYear)); set('eta', 'expected time: ~' + fmtBig(od.years) + ' years');"],
  ["nf(sh.lastHour) + ' na última hora' + (ls ? ' · último: '", "nf(sh.lastHour) + ' in the last hour' + (ls ? ' · latest: '"],
  ["(ago(ls.at) === 'agora' ? 'agora' : 'há ' + ago(ls.at))", "(ago(ls.at) === 'now' ? 'now' : ago(ls.at) + ' ago')"],
  ["'\">último '", "'\">latest '"],
  ["w.state === 'unknown' ? 'não listado' : ago(w.lastSeen)", "w.state === 'unknown' ? 'not listed' : ago(w.lastSeen)"],
  ["'<tr><td colspan=\"4\" class=\"sub\">nenhum worker enviou shares ainda</td></tr>'", "'<tr><td colspan=\"4\" class=\"sub\">no worker has sent shares yet</td></tr>'"],
  ["set('netd', 'Dificuldade da rede: '", "set('netd', 'Network difficulty: '"],
  ["'Saldo indisponível: '", "'Balance unavailable: '"],
  ["' a receber na OCEAN'", "' unpaid at OCEAN'"],
  ["(w.txCount === 1 ? ' transação' : ' transações')", "(w.txCount === 1 ? ' transaction' : ' transactions')"],
  ["' sats pendentes' : 'nada pendente'", "' sats pending' : 'nothing pending'"],

  // ---------- rede
  ["const agoTxt = (t) => { const a = ago(t); return a === 'agora' ? a : 'há ' + a; };", "const agoTxt = (t) => { const a = ago(t); return a === 'now' ? a : a + ' ago'; };"],
  ["'em ~' + dur(n.adj.retargetAt - Date.now()) + ' · faltam ' + nf(n.adj.remainingBlocks) + ' blocos'", "'in ~' + dur(n.adj.retargetAt - Date.now()) + ' · ' + nf(n.adj.remainingBlocks) + ' blocks to go'"],
  ["set('halvB', nf(n.halving.remaining) + ' blocos');", "set('halvB', nf(n.halving.remaining) + ' blocks');"],
  ["' · 3,125 → 1,5625 BTC'", "' · 3.125 → 1.5625 BTC'"],
  ["' BTC: 3,125 de recompensa + ' + nf(n.prize.feesSats / 1e8, 3) + ' em taxas (média dos últimos blocos)'", "' BTC: 3.125 subsidy + ' + nf(n.prize.feesSats / 1e8, 3) + ' in fees (average of recent blocks)'"],
  ["+ '% em 24 h'", "+ '% in 24 h'"],
  ["'Seu recorde de ' + nf(best, 2) + ' já vale um bloco hoje!'", "'Your record of ' + nf(best, 2) + ' is worth a block today!'"],
  ["set('tmBig', '🎉 BLOCO!'); set('tmS', 'confira a carteira');", "set('tmBig', '🎉 BLOCK!'); set('tmS', 'check your wallet');"],
  ["'dificuldade da rede na época: '", "'network difficulty back then: '"],
  ["' · bloco ~'", "' · block ~'"],
  ["' · valeu até '", "' · valid until '"],
  ["'Com o recorde de ' + nf(best, 2) + ', a fazenda teria minerado um bloco em'", "'With the record of ' + nf(best, 2) + ', the farm would have mined a block in'"],
  ["'histórico de dificuldade ainda não carregou'", "'difficulty history has not loaded yet'"],
  ["'Rede indisponível: '", "'Network unavailable: '"],

  // ---------- quase bloco
  ["'Hash do bloco #'", "'Block #'"],
  ["(t.pool ? ' · ' + t.pool : '') + ' · dificuldade ' + diffTxt(t.hashDiff)", "(t.pool ? ' · ' + t.pool : '') + ' · difficulty ' + diffTxt(t.hashDiff)"],
  ["set('qbL2', 'Nosso melhor hash · ' + b.worker + ' · dificuldade '", "set('qbL2', 'Our best hash · ' + b.worker + ' · difficulty '"],
  ["set('qbL2', 'Nosso melhor hash'); set('qbH2', 'o proxy ainda não registrou nenhum hash');", "set('qbL2', 'Our best hash'); set('qbH2', 'the proxy has not recorded any hash yet');"],
  ["set('qbL3', 'Melhor de hoje · ' + d.worker + ' · dificuldade '", "set('qbL3', 'Best today · ' + d.worker + ' · difficulty '"],
  ["set('qbL3', 'Melhor de hoje');", "set('qbL3', 'Best today');"],
  ["'o bloco tem ' + (zb - zo) + ' zeros a mais que o nosso melhor: 16 elevado a ' + (zb - zo) : 'zeros do bloco × zeros do nosso melhor'", "'the block has ' + (zb - zo) + ' more zeros than our best: 16 to the power of ' + (zb - zo) : 'block zeros × our best zeros'"],
  ["'o hash do bloco é isso mais difícil que o nosso recorde ('", "'the block hash is this much harder than our record ('"],
  ["'. No ritmo da fazenda, um hash assim sai a cada ~' + fmtBig(secs / 31557600) + ' de anos.'", "'. At the farm\\'s pace, a hash like that comes up every ~' + fmtBig(secs / 31557600) + ' years.'"],
  ["'além do mínimo da rede (' + fmtBig(t.target) + '). ' + (l < 1.5 ? 'Passou raspando.' : l < 5 ? 'Bloco normal.' : 'Sorte grande.')", "'beyond the network minimum (' + fmtBig(t.target) + '). ' + (l < 1.5 ? 'Just made it.' : l < 5 ? 'A normal block.' : 'Big luck.')"],
  ["set('qbTopS', 'bloco #'", "set('qbTopS', 'block #'"],
  ["[t.target, 'alvo da rede', 'var(--dim)'], [t.hashDiff, 'bloco #'", "[t.target, 'network target', 'var(--dim)'], [t.hashDiff, 'block #'"],

  // ---------- histórico
  ["'coletando dados… o gráfico aparece em alguns minutos'", "'collecting data… the chart shows up in a few minutes'"],
  ["'o gráfico aparece depois do primeiro recorde registrado'", "'the chart shows up after the first recorded record'"],
  ["'<li><span></span><span class=\"sub\">nenhum recorde ainda</span></li>'", "'<li><span></span><span class=\"sub\">no records yet</span></li>'"],
  ["(h.worker || 'Máquina') + ' · saúde'", "(h.worker || 'Machine') + ' · health'"],
  ["set('enC', money(e.costMonth) + '/mês');", "set('enC', money(e.costMonth) + '/month');"],
  ["' kWh/mês · '", "' kWh/month · '"],
  ["'por uma chance de 1 em ' + fmtBig(od.perYear) + ' por ano 😄'", "'for a 1 in ' + fmtBig(od.perYear) + ' chance per year 😄'"],

  // ---------- narrador
  ["'Ser atingido por um raio este ano é ' + fmtBig(raio) + ' vezes mais provável.'", "'Getting struck by lightning this year is ' + fmtBig(raio) + ' times more likely.'"],
  ["if (mega > 1) out.push('Uma aposta na Mega-Sena é ' + nf(mega) + ' vezes mais provável que o nosso bloco.');", "if (mega > 1) out.push('Winning the Powerball jackpot is ' + nf(mega) + ' times more likely than our block.');"],
  ["const MEGA = 50063860;    // Mega-Sena, aposta simples de 6 números", "const MEGA = 292201338;   // Powerball jackpot, single ticket"],
  ["'Tempo esperado pro bloco: ' + fmtBig(od.years) + ' de anos. Paciência.'", "'Expected time to a block: ' + fmtBig(od.years) + ' years. Patience.'"],
  ["'Faltam só ' + fmtBig(f.difficulty / f.best) + ' de vezes. Já já sai.'", "'Only ' + fmtBig(f.difficulty / f.best) + ' times to go. Any minute now.'"],
  ["'Luz: ' + money(e.costMonth) + '/mês. Lucro: ' + money(0) + '. Negócio impecável.'", "'Power: ' + money(e.costMonth) + '/month. Profit: ' + money(0) + '. Flawless business.'"],
  ["'Se o bloco sair, a conta de luz fica paga por ' + fmtBig(anos) + ' anos.'", "'If the block comes, the power bill is paid for ' + fmtBig(anos) + ' years.'"],
  ["out.push('O ' + wk.name + ' está parado há ' + ago(wk.lastSeen) + '. Pediu demissão?');", "out.push(wk.name + ' has been stopped for ' + ago(wk.lastSeen) + '. Did it quit?');"],
  ["out.push('O ' + wk.name + ' está quieto há ' + ago(wk.lastSeen) + '. Deve estar pensando.');", "out.push(wk.name + ' has been quiet for ' + ago(wk.lastSeen) + '. Must be thinking.');"],
  ["out.push('O ' + wk.name + ' trabalha em silêncio. A pool nem sabe que ele existe.');", "out.push(wk.name + ' works in silence. The pool doesn\\'t even know it exists.');"],
  ["'O Odroid é de 2016 e segue minerando. Respeita o vovô.'", "'The Odroid is from 2016 and still mining. Respect your elders.'"],
  ["' lidera o hall da fama com ' + nf(hall[0].value, 2) + '. Os outros que lutem.'", "' leads the hall of fame with ' + nf(hall[0].value, 2) + '. The others can try harder.'"],
  ["if (j.championship && j.championship.leader) out.push('🏆 ' + j.championship.leader.name + ' lidera o campeonato da semana. Quem vai buscar?');", "if (j.championship && j.championship.leader) out.push('🏆 ' + j.championship.leader.name + ' leads the weekly championship. Who will catch up?');"],
  ["out.push('Em ' + mesAno(tm.from * 1000) + ' a gente seria milionário. Erramos de década.');", "out.push('In ' + mesAno(tm.from * 1000) + ' we would be millionaires. Wrong decade.');"],
  ["(h.worker || 'O servidor') + ' a ' + nf(h.tempC) + ' °C. O cooler merece um aumento.'", "(h.worker || 'The server') + ' at ' + nf(h.tempC) + ' °C. The cooler deserves a raise.'"],
  ["(h.worker || 'O servidor') + ' a ' + nf(h.tempC) + ' °C. Alguém traz um ventilador?'", "(h.worker || 'The server') + ' at ' + nf(h.tempC) + ' °C. Someone bring a fan?'"],
  ["'Já foram ' + nf(sh) + ' shares hoje. Nenhum virou bloco. Ainda.'", "nf(sh) + ' shares today. None became a block. Yet.'"],
  ["'Saldo: ' + money(v) + (v < 6 ? '. Dá pra um cafezinho? Não.' : '. Dá pra um pão de queijo, no máximo.')", "'Balance: ' + money(v) + (v < 6 ? '. Enough for a coffee? No.' : '. A donut, at most.')"],
  ["'Faltam ' + nf(n.halving.remaining) + ' blocos pro halving. Aí o prêmio cai pela metade.'", "nf(n.halving.remaining) + ' blocks until the halving. Then the prize drops by half.'"],
  ["'Nenhum bloco encontrado hoje. Igual a ontem. E anteontem.'", "'No block found today. Same as yesterday. And the day before.'"],
  ["'Mineração: o único esporte em que perder é o resultado esperado.'", "'Mining: the only sport where losing is the expected outcome.'"],

  // ---------- comemoração
  ["const JOKES = ['Pode chamar a imprensa.', 'O bloco está logo ali. (Não está.)', 'Isso merece um print pro grupo.',\n  'Os bancos estão preocupados.', 'Satoshi ficaria orgulhoso. Talvez.'];",
    "const JOKES = ['Call the press.', 'The block is right there. (It is not.)', 'Screenshot this for the group chat.',\n  'The banks are worried.', 'Satoshi would be proud. Maybe.'];"],
  ["r.worker && r.worker !== '—' ? r.worker : 'A fazenda'", "r.worker && r.worker !== '—' ? r.worker : 'The farm'"],
  ["r.test ? 'Teste da comemoração' : (r.farm ? 'Fazenda de mineração' : 'Recorde pessoal')", "r.test ? 'Celebration test' : (r.farm ? 'Mining farm' : 'Personal record')"],
  ["r.farm ? 'NOVO RECORDE!' : 'Recorde do ' + who + '!'", "r.farm ? 'NEW RECORD!' : who + '\\'s record!'"],
  ["who + ' fez o melhor hash da fazenda' + (prev ? ' (antes: '", "who + ' made the farm\\'s best hash' + (prev ? ' (before: '"],
  ["'Faltam só ' + fmtBig(D / r.value) + ' de vezes.'", "'Only ' + fmtBig(D / r.value) + ' times to go.'"],

  // ---------- estado da conexão
  ["'API da public-pool fora do ar — shares e recordes seguem ao vivo pelo proxy.'", "'public-pool API is down — shares and records keep coming live through the proxy.'"],
  ["'Pool instável (' + j.error + ') — mostrando dados de ' + (j.okAt ? hora(j.okAt) : '–') + ', tentando de novo…'", "'Pool unstable (' + j.error + ') — showing data from ' + (j.okAt ? hora(j.okAt) : '–') + ', retrying…'"],
  ["set('upd', 'atualizado '", "set('upd', 'updated '"],
  ["'Sem conexão com o servidor local.'", "'No connection to the local server.'"],
  ["' fora do ar desde ' + hora(f.since) +\n      (f.active ? ' — mineradores da porta ' + f.listen + ' na reserva ' + f.active : ' — sem reserva no ar na porta ' + f.listen)",
    "' down since ' + hora(f.since) +\n      (f.active ? ' — miners on port ' + f.listen + ' moved to backup ' + f.active : ' — no backup available on port ' + f.listen)"],
  ["celebrate({ worker: 'teste',", "celebrate({ worker: 'test',"],

  // ---------- sorte
  ['<h2 class="sect">Sorte</h2>', '<h2 class="sect">Luck</h2>'],
  ['<div class="label">Medidor de sorte</div>', '<div class="label">Luck meter</div>'],
  ['<div class="lead">Melhor share de cada worker comparado com o esperado para o trabalho que ele fez.</div>', '<div class="lead">Each worker\'s best share compared with what its work should have produced.</div>'],
  ['<th>Worker</th><th>Melhor</th><th>Esperado</th><th>Sorte</th>', '<th>Worker</th><th>Best</th><th>Expected</th><th>Luck</th>'],
  ['aguardando shares pelo proxy…', 'waiting for shares through the proxy…'],
  ['<div class="label">Distribuição dos shares</div>', '<div class="label">Share distribution</div>'],
  ['Cada faixa tem metade dos shares da anterior, como a matemática prevê. É a prova de que a loteria é justa.', 'Each band holds half the shares of the one before, just as the math predicts. Proof that the lottery is fair.'],
  ['<span class="sub lk-p">melhor que \' + pct + \'% das fazendas iguais</span>', '<span class="sub lk-p">luckier than \' + pct + \'% of identical farms</span>'],
  ['os shares aparecem aqui conforme chegam pelo proxy', 'shares show up here as they arrive through the proxy'],
  ['dificuldade do share ÷ alvo da pool · barras: shares reais · tracejado: teoria', 'share difficulty ÷ pool target · bars: real shares · dashed: theory'],
  ['<div class="label">🏆 Campeonato da semana</div>', '<div class="label">🏆 Weekly championship</div>'],
  ['<div class="lead" id="chLead">Ranking da semana por sorte relativa (melhor share ÷ esperado), do vovô ao ASIC.</div>', '<div class="lead" id="chLead">Weekly ranking by relative luck (best share ÷ expected), from grandpa to ASIC.</div>'],
  ['<div class="label">🎖️ Conquistas <span id="achCnt" class="sub"></span></div>', '<div class="label">🎖️ Achievements <span id="achCnt" class="sub"></span></div>'],
  ["sp2.textContent = 'nenhum share na semana ainda';", "sp2.textContent = 'no shares this week yet';"],
  ["const cMedals = ['🏆', '🥈', '🥉', '4º', '5º'];", "const cMedals = ['🏆', '🥈', '🥉', '4th', '5th'];"],
  ["set('chLast', lw ? 'Campeão da semana passada: 🏆 ' + lw.name + ' (' + (lw.factor != null ? nf(lw.factor, 2) + '× · ' : '') + diffTxt(lw.best) + ')' : '');", "set('chLast', lw ? 'Last week\\'s champion: 🏆 ' + lw.name + ' (' + (lw.factor != null ? nf(lw.factor, 2) + '× · ' : '') + diffTxt(lw.best) + ')' : '');"],

  // ---------- bilhete do dia
  ['<a class="ticket-btn" id="ticketBtn" href="#">🎟️ Bilhete do dia</a>', '<a class="ticket-btn" id="ticketBtn" href="#">🎟️ Today\'s ticket</a>'],
  ['<h2 class="sect">Quase bloco <a', '<h2 class="sect">Almost a block <a'],
  ['<button class="main" id="ticketShare">Compartilhar</button><button id="ticketSave">Baixar imagem</button><button id="ticketClose">Fechar</button>',
    '<button class="main" id="ticketShare">Share</button><button id="ticketSave">Download image</button><button id="ticketClose">Close</button>'],
  ["'⛏️ BILHETE DE LOTERIA DO BITCOIN'", "'⛏️ BITCOIN LOTTERY TICKET'"],
  ["'Melhor hash do dia · '", "'Best hash of the day · '"],
  ["text('dificuldade ' + diffTxt(b.diff)", "text('difficulty ' + diffTxt(b.diff)"],
  ["hz + ' zeros na frente'", "hz + ' leading zeros'"],
  ["'o bloco #' + nf(t.height) + ' tinha ' + zb + ' zeros'", "'block #' + nf(t.height) + ' had ' + zb + ' zeros'"],
  ["'faltaram ' + (zb - hz) + ' zeros: ' + fmtBig(t.hashDiff / b.diff) + ' de vezes mais difícil'", "(zb - hz) + ' zeros short: ' + fmtBig(t.hashDiff / b.diff) + ' times harder'"],
  ["won ? 'PREMIADO! 🎉' : 'NÃO PREMIADO'", "won ? 'WINNER! 🎉' : 'NOT A WINNER'"],
  ["'Mineração solo em casa: a loteria mais lenta do mundo.'", "'Home solo mining: the slowest lottery in the world.'"],
  ["'Dá para jogar também, é de graça e de código aberto:'", "'You can play too. It is free and open source:'"],
  ["'Meu bilhete de loteria do Bitcoin de hoje ⛏️ github.com/Modanez/HomeMinerProxy'", "'My Bitcoin lottery ticket for today ⛏️ github.com/Modanez/HomeMinerProxy'"],
  ["'bilhete-' + new Date()", "'ticket-' + new Date()"],
];

// Gera a página no idioma e na moeda pedidos (o resultado é guardado em cache por quem chama)
function localizePage(page, lang, currency) {
  let out = page.replace("const LOC = '__LOC__', CUR = '__CUR__';", `const LOC = '${LOCALES[lang] || LOCALES.en}', CUR = '${currency}';`);
  if (lang === 'en') for (const [pt, en] of EN) out = out.split(pt).join(en);
  return out;
}

// Textos do widget (/api/widget)
const WIDGET = {
  pt: { big: [[1e12, 'tri'], [1e9, 'bi'], [1e6, 'mi'], [1e3, 'mil']], times: ' de vezes', oneIn: '1 em ' },
  en: { big: [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']], times: ' times to go', oneIn: '1 in ' },
};

module.exports = { pickLang, localizePage, EN, LOCALES, WIDGET };
