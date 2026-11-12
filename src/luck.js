// Medidor de sorte, campeonato semanal e conquistas da fazenda.
// Cada hash tem chance 1/D de atingir dificuldade D. Com W unidades de trabalho (W × 2^32 hashes),
// a probabilidade de o melhor share ficar abaixo de B é exp(-W/B). Daí:
//   esperado (mediana do melhor share) = W / ln 2
//   sorte = melhor / esperado            (1 = normal, 2 = o dobro do esperado)
//   percentil = exp(-W / melhor)         (fração de fazendas com o mesmo trabalho que fariam pior)

function luckOf(work, best) {
  if (!(work > 0) || !(best > 0)) return null;
  const expected = work / Math.LN2;
  return { work, best, expected, factor: best / expected, percentile: Math.exp(-work / best) };
}

// Fração teórica de shares na faixa k (dificuldade entre 2^k e 2^(k+1) vezes o alvo)
const theoreticalShare = (k) => Math.pow(2, -(k + 1));

// Chave da semana (segunda a domingo): data local da segunda-feira no formato AAAA-MM-DD.
function weekKey(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();   // 0 = domingo, 1 = segunda…
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d.toLocaleDateString('sv');
}

// Ranking semanal entre os workers.
// Ordena primeiro pelo fator de sorte da semana (melhor share ÷ esperado para o trabalho da semana),
// permitindo que um ESP32/devkit dispute o troféu de igual para igual com um Bitaxe; sem trabalho
// medido pelo proxy, desempata pelo maior share bruto da semana.
function weeklyStandings(weekObj, records = [], now = Date.now()) {
  const key = (weekObj && weekObj.key) || weekKey(now);
  const map = new Map();
  const src = (weekObj && weekObj.workers) || {};
  for (const [name, w] of Object.entries(src)) {
    if (!w || (!(w.shares > 0) && !(w.best > 0))) continue;
    map.set(name, {
      name,
      shares: Number(w.shares) || 0,
      work: Number(w.work) || 0,
      best: Number(w.best) || 0,
      bestAt: w.bestAt || null,
    });
  }
  for (const r of records || []) {
    if (!r || !r.worker || r.worker === '—' || !(r.value > 0) || !r.at) continue;
    const t = new Date(r.at).getTime();
    if (!Number.isFinite(t) || weekKey(t) !== key) continue;
    const cur = map.get(r.worker) || { name: r.worker, shares: 0, work: 0, best: 0, bestAt: null };
    if (r.value > cur.best) { cur.best = Number(r.value); cur.bestAt = t; }
    map.set(r.worker, cur);
  }
  const standings = [...map.values()].map((w) => {
    const lk = luckOf(w.work, w.best);
    return {
      ...w,
      expected: lk ? lk.expected : null,
      factor: lk ? lk.factor : null,
      percentile: lk ? lk.percentile : null,
    };
  }).sort((a, b) => {
    if (a.factor != null && b.factor != null) return b.factor - a.factor || b.best - a.best;
    if (a.factor != null) return -1;
    if (b.factor != null) return 1;
    return b.best - a.best;
  });
  const topDiff = [...standings].sort((a, b) => b.best - a.best)[0] || null;
  return { key, standings, leader: standings[0] || null, topDiff };
}

// Catálogo de conquistas da fazenda (pt e en).
const ACHIEVEMENTS = [
  { id: 'first_share', icon: '⛏️', pt: ['Primeira faísca', 'Primeiro share aceito na fazenda'], en: ['First spark', 'First accepted share on the farm'] },
  { id: 'diff_1k', icon: '🎯', pt: ['Clube dos 1.000', 'Um share com dificuldade acima de 1.000'], en: ['1,000 club', 'A share with difficulty over 1,000'] },
  { id: 'diff_1m', icon: '🚀', pt: ['Um em um milhão', 'Um share com dificuldade acima de 1 milhão'], en: ['One in a million', 'A share with difficulty over 1 million'] },
  { id: 'diff_1b', icon: '☄️', pt: ['Quase bloco (1 bi)', 'Um share com dificuldade acima de 1 bilhão'], en: ['Billionaire hash', 'A share with difficulty over 1 billion'] },
  { id: 'diff_1t', icon: '🌋', pt: ['Um trilhão', 'Um share com dificuldade acima de 1 trilhão'], en: ['Trillion hash', 'A share with difficulty over 1 trillion'] },
  { id: 'shares_1k', icon: '📦', pt: ['Mil tentativas', '1.000 shares aceitos na fazenda'], en: ['A thousand tries', '1,000 accepted shares on the farm'] },
  { id: 'shares_100k', icon: '🏭', pt: ['100 mil tentativas', '100.000 shares aceitos na fazenda'], en: ['100,000 tries', '100,000 accepted shares on the farm'] },
  { id: 'luck_2x', icon: '🍀', pt: ['Dobro da sorte', 'Worker com sorte de pelo menos 2× o esperado'], en: ['Double luck', 'A worker with at least 2× expected luck'] },
  { id: 'luck_10x', icon: '⚡', pt: ['Raio na cabeça (10×)', 'Worker com sorte de pelo menos 10× o esperado'], en: ['Lightning strike (10×)', 'A worker with at least 10× expected luck'] },
  { id: 'week_nonstop', icon: '🛡️', pt: ['Uma semana sem parar', '7 dias seguidos minerando sem cair'], en: ['One week nonstop', '7 days in a row mining without stopping'] },
  { id: 'underdog', icon: '🐢', pt: ['Troféu vovô', 'Líder da semana com menos de 10% do maior hashrate'], en: ['Underdog trophy', 'Weekly leader with under 10% of the top hashrate'] },
  // o prêmio de ouro: um share acima da dificuldade da rede é um bloco
  { id: 'block', icon: '🏆', golden: true, pt: ['Prêmio de ouro: bloco achado!', 'Um share acima da dificuldade da rede: a fazenda achou um bloco'], en: ['Golden prize: block found!', 'A share above the network difficulty: the farm found a block'] },
];

// Avalia quais conquistas já foram atingidas e preserva as já desbloqueadas em `saved`.
function evaluateAchievements(ctx = {}, saved = {}, now = Date.now()) {
  const best = Number(ctx.best) || 0;
  const netDiff = Number(ctx.networkDifficulty) || 0;
  const bestWorker = ctx.bestWorker && ctx.bestWorker !== '—' ? ctx.bestWorker : null;
  const totalShares = Number(ctx.totalShares) || 0;
  const workers = Array.isArray(ctx.workers) ? ctx.workers : [];
  const proxyWorkers = Array.isArray(ctx.proxyWorkers) ? ctx.proxyWorkers : [];
  const luckWorkers = Array.isArray(ctx.luckWorkers) ? ctx.luckWorkers : [];
  const champ = ctx.championship || null;

  const topLuck = luckWorkers[0] || null;
  const nonstop = proxyWorkers.find((w) => w && w.online > 0 && w.connectedSince && now - w.connectedSince >= 7 * 86400e3);
  const maxHr = workers.reduce((m, w) => Math.max(m, Number(w.hashRate) || 0), 0);
  const leaderName = champ && champ.leader ? champ.leader.name : null;
  const leaderWorker = leaderName ? workers.find((w) => w.name === leaderName) : null;
  const leaderHr = leaderWorker ? Number(leaderWorker.hashRate) || 0 : 0;
  const isUnderdog = !!(champ && champ.leader && champ.standings && champ.standings.length >= 2 && maxHr > 0 && leaderHr > 0 && leaderHr <= maxHr * 0.1);

  const checks = {
    first_share: () => (totalShares >= 1 || best > 0 ? { worker: bestWorker || (workers[0] && workers[0].name) || null } : null),
    diff_1k: () => (best >= 1e3 ? { worker: bestWorker } : null),
    diff_1m: () => (best >= 1e6 ? { worker: bestWorker } : null),
    diff_1b: () => (best >= 1e9 ? { worker: bestWorker } : null),
    diff_1t: () => (best >= 1e12 ? { worker: bestWorker } : null),
    shares_1k: () => (totalShares >= 1e3 ? { worker: null } : null),
    shares_100k: () => (totalShares >= 1e5 ? { worker: null } : null),
    luck_2x: () => (topLuck && topLuck.factor >= 2 ? { worker: topLuck.name } : null),
    luck_10x: () => (topLuck && topLuck.factor >= 10 ? { worker: topLuck.name } : null),
    week_nonstop: () => (nonstop ? { worker: nonstop.name } : null),
    underdog: () => (isUnderdog ? { worker: leaderName } : null),
    block: () => (netDiff > 0 && best >= netDiff ? { worker: bestWorker } : null),
  };

  const map = {};
  for (const [k, v] of Object.entries(saved || {})) {
    if (v && typeof v === 'object' && ACHIEVEMENTS.some((a) => a.id === k)) {
      map[k] = { unlockedAt: v.unlockedAt || new Date(now).toISOString(), worker: v.worker || null };
    }
  }
  const newlyUnlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (map[a.id]) continue;
    const hit = checks[a.id] && checks[a.id]();
    if (hit) {
      map[a.id] = { unlockedAt: new Date(now).toISOString(), worker: hit.worker || null };
      newlyUnlocked.push({ id: a.id, icon: a.icon, pt: a.pt, en: a.en, ...map[a.id] });
    }
  }
  const list = ACHIEVEMENTS.map((a) => ({
    id: a.id,
    icon: a.icon,
    golden: !!a.golden,
    pt: a.pt,
    en: a.en,
    unlocked: !!map[a.id],
    unlockedAt: map[a.id] ? map[a.id].unlockedAt : null,
    worker: map[a.id] ? map[a.id].worker : null,
  }));
  return { map, list, unlockedCount: Object.keys(map).length, total: ACHIEVEMENTS.length, totalCount: ACHIEVEMENTS.length, newlyUnlocked };
}

module.exports = { luckOf, theoreticalShare, weekKey, weeklyStandings, ACHIEVEMENTS, evaluateAchievements };
