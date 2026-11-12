// Medidor de sorte, campeonato semanal e conquistas: confere as fórmulas e simulações.
const test = require('node:test');
const assert = require('node:assert');
const { luckOf, theoreticalShare, weekKey, weeklyStandings, ACHIEVEMENTS, evaluateAchievements } = require('../src/luck');

test('sorte 1 = exatamente o esperado (mediana)', () => {
  const W = 1000;
  const l = luckOf(W, W / Math.LN2);
  assert.ok(Math.abs(l.factor - 1) < 1e-12);
  assert.ok(Math.abs(l.percentile - 0.5) < 1e-12);   // metade das fazendas iguais faria pior
});

test('sem trabalho ou sem share não há medida', () => {
  assert.strictEqual(luckOf(0, 10), null);
  assert.strictEqual(luckOf(10, 0), null);
  assert.strictEqual(luckOf(-5, 10), null);
  assert.strictEqual(luckOf(10, -5), null);
});

test('simulação: o percentil do melhor share é uniforme (a fórmula está calibrada)', () => {
  // Simula fazendas com o mesmo trabalho: cada share com alvo 1 atinge dificuldade 1/U (U uniforme).
  let seed = 42;   // mulberry32: gerador simples e reproduzível
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  const farms = 4000, shares = 200;
  let belowHalf = 0, belowTenth = 0;
  for (let f = 0; f < farms; f++) {
    let best = 0;
    for (let i = 0; i < shares; i++) best = Math.max(best, 1 / rnd());
    const p = luckOf(shares, best).percentile;
    if (p < 0.5) belowHalf++;
    if (p < 0.1) belowTenth++;
  }
  assert.ok(Math.abs(belowHalf / farms - 0.5) < 0.03, `metade: ${belowHalf / farms}`);
  assert.ok(Math.abs(belowTenth / farms - 0.1) < 0.02, `décimo: ${belowTenth / farms}`);
});

test('histograma teórico: metade, um quarto, um oitavo…', () => {
  assert.strictEqual(theoreticalShare(0), 0.5);
  assert.strictEqual(theoreticalShare(1), 0.25);
  assert.strictEqual(theoreticalShare(2), 0.125);
  const sum = Array.from({ length: 40 }, (_, k) => theoreticalShare(k)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('weekKey e campeonato semanal: ordena por sorte relativa e incorpora recordes da semana', () => {
  // 2026-11-04 (quarta) e 2026-11-08 (domingo) pertencem à mesma semana iniciada na segunda 2026-11-02
  const wed = new Date(2026, 10, 4, 15, 0, 0).getTime();
  const sun = new Date(2026, 10, 8, 21, 0, 0).getTime();
  assert.strictEqual(weekKey(wed), '2026-11-02');
  assert.strictEqual(weekKey(sun), '2026-11-02');

  const weekObj = {
    key: '2026-11-02',
    workers: {
      bitaxe: { shares: 1000, work: 100000, best: 120000, bestAt: wed },   // esperado ~144269 -> sorte ~0,83×
      devkit: { shares: 20, work: 20, best: 100, bestAt: wed },            // esperado ~28,85 -> sorte ~3,47×
    },
  };
  const recs = [
    { worker: 'nerdminer', value: 500, at: new Date(2026, 10, 5, 10, 0, 0).toISOString() },
    { worker: 'antigo', value: 999999, at: new Date(2026, 9, 1, 10, 0, 0).toISOString() },
  ];
  const ch = weeklyStandings(weekObj, recs, wed);
  assert.strictEqual(ch.key, '2026-11-02');
  assert.strictEqual(ch.leader.name, 'devkit');       // o vovô devkit lidera pela sorte relativa!
  assert.strictEqual(ch.topDiff.name, 'bitaxe');      // maior dificuldade bruta da semana
  assert.deepStrictEqual(ch.standings.map((w) => w.name), ['devkit', 'bitaxe', 'nerdminer']);
});

test('conquistas: desbloqueia marcos, detecta troféu vovô (underdog) e preserva histórico', () => {
  const now = Date.now();
  const champ = {
    leader: { name: 'devkit', factor: 3.5, best: 150 },
    standings: [{ name: 'devkit', factor: 3.5, best: 150 }, { name: 'bitaxe', factor: 0.9, best: 50000 }],
  };
  const r1 = evaluateAchievements({
    best: 1500,
    bestWorker: 'bitaxe',
    totalShares: 1200,
    workers: [{ name: 'devkit', hashRate: 350000 }, { name: 'bitaxe', hashRate: 1.2e12 }],
    proxyWorkers: [{ name: 'odroid', online: 1, connectedSince: now - 8 * 86400e3 }],
    luckWorkers: [{ name: 'devkit', factor: 3.5 }],
    championship: champ,
  }, {}, now);

  const ids = r1.newlyUnlocked.map((a) => a.id);
  assert.ok(ids.includes('first_share'));
  assert.ok(ids.includes('diff_1k'));
  assert.ok(ids.includes('shares_1k'));
  assert.ok(ids.includes('luck_2x'));
  assert.ok(ids.includes('week_nonstop'));
  assert.ok(ids.includes('underdog'));
  assert.ok(!ids.includes('diff_1m'));
  assert.strictEqual(r1.totalCount, ACHIEVEMENTS.length);

  // segunda avaliação com os mesmos dados não repete newlyUnlocked e preserva os já salvos
  const r2 = evaluateAchievements({ best: 10, totalShares: 5 }, r1.map, now);
  assert.deepStrictEqual(r2.newlyUnlocked, []);
  assert.strictEqual(r2.unlockedCount, r1.unlockedCount);
});

test('cobertura completa de weeklyStandings e desempates', () => {
  const mon = new Date(2026, 10, 2, 12, 0, 0).getTime();
  assert.strictEqual(weekKey(), weekKey(Date.now()));
  assert.strictEqual(weekKey(mon), '2026-11-02');

  // Dois workers sem factor (work = 0), exercitando b.best - a.best (linha 64)
  const recs = [
    null,
    { worker: '' },
    { worker: '—', value: 100, at: new Date(mon).toISOString() },
    { worker: 'w1', value: 0, at: new Date(mon).toISOString() },
    { worker: 'w1', value: 50, at: 'data-invalida' },
    { worker: 'w1', value: 50 },
    { worker: 'w1', value: 10, at: new Date(mon).toISOString() },
    { worker: 'w1', value: 5, at: new Date(mon).toISOString() }, // menor que cur.best
    { worker: 'w2', value: 20, at: new Date(mon).toISOString() },
  ];
  const emptyWeek = {
    key: '2026-11-02',
    workers: {
      invalido: null,
      semShares: { shares: 0, best: 0 },
    },
  };
  const ch = weeklyStandings(emptyWeek, recs, mon);
  assert.strictEqual(ch.standings[0].name, 'w2');
  assert.strictEqual(ch.standings[1].name, 'w1');

  // Empate de factor desempatando por best e empate total
  const weekTied = {
    key: '2026-11-02',
    workers: {
      a: { shares: 10, work: 100, best: 200 },
      b: { shares: 10, work: 100, best: 200 },
      c: { shares: 10, work: 100, best: 150 },
    },
  };
  const chTied = weeklyStandings(weekTied, [], mon);
  assert.strictEqual(chTied.standings.length, 3);

  // Sem weekObj e sem records
  const chEmpty = weeklyStandings(null, null, mon);
  assert.deepStrictEqual(chEmpty.standings, []);
  assert.strictEqual(chEmpty.leader, null);
  assert.strictEqual(chEmpty.topDiff, null);

  // Worker sem factor ordenado contra worker com factor (exercita b.factor != null)
  // e worker com shares mas sem best
  const weekMixed = {
    key: '2026-11-02',
    workers: {
      soShares: { shares: 5, work: 0, best: 0 },
      semFactor: { shares: 0, work: 0, best: 50 },
      comFactor: { shares: 10, work: 10, best: 100 },
    },
  };
  const chMixed = weeklyStandings(weekMixed, [], mon);
  assert.strictEqual(chMixed.standings[0].name, 'comFactor');
  assert.strictEqual(chMixed.standings[1].name, 'semFactor');
});

test('cobertura de todas as conquistas e edge cases de evaluateAchievements', () => {
  const now = Date.now();
  // Conquistas de alta dificuldade e shares
  const res = evaluateAchievements({
    best: 2e9,
    bestWorker: '—', // deve virar null e pegar workers[0]
    totalShares: 2e5,
    workers: [{ name: 'fallbackWorker', hashRate: 1000 }],
    luckWorkers: [{ name: 'superLucky', factor: 12 }],
    proxyWorkers: [
      null,
      { online: 0, connectedSince: now - 10 * 86400e3 },
      { online: 1, connectedSince: now - 1 * 86400e3 },
      { online: 1, connectedSince: now - 8 * 86400e3, name: 'minerHero' },
    ],
  }, {
    conquistaInexistente: { unlockedAt: '2026-01-01' },
    diff_1k: null,
    diff_1m: 'nao-objeto',
    shares_1k: { worker: 'salvo' }, // sem unlockedAt, deve usar now
  }, now);

  const ids = res.newlyUnlocked.map((a) => a.id);
  assert.ok(ids.includes('first_share'));
  assert.ok(ids.includes('diff_1b'));
  assert.ok(ids.includes('shares_100k'));
  assert.ok(ids.includes('luck_10x'));
  assert.ok(ids.includes('week_nonstop'));

  // Contexto onde nada é atingido e branches negativos de checks
  const resEmpty = evaluateAchievements({
    best: 0,
    totalShares: 0,
    workers: [{ name: 'w1' }, { name: 'w2', hashRate: 'invalido' }],
    luckWorkers: [{ name: 'w1', factor: 1 }],
    championship: { leader: { name: 'w1' }, standings: [{ name: 'w1' }] },
  }, {}, now);
  assert.strictEqual(resEmpty.newlyUnlocked.length, 0);

  // Championship com leader não underdog (líder tem hashrate alto)
  const resNotUnderdog = evaluateAchievements({
    workers: [{ name: 'bitaxe', hashRate: 1e12 }, { name: 'devkit', hashRate: 100 }],
    championship: { leader: { name: 'bitaxe' }, standings: [{}, {}] },
  });
  assert.strictEqual(resNotUnderdog.newlyUnlocked.length, 0);

  // evaluateAchievements com contexto nulo ou propriedades não-array e worker sem nome
  const emptyRes = evaluateAchievements();
  assert.strictEqual(emptyRes.unlockedCount, 0);
  const nullSavedRes = evaluateAchievements({}, null);
  assert.strictEqual(nullSavedRes.unlockedCount, 0);

  const nonArrayRes = evaluateAchievements({
    best: 10,
    totalShares: 1,
    workers: [{}], // worker sem name
    proxyWorkers: 'string',
    luckWorkers: null,
  });
  assert.ok(nonArrayRes.map.first_share);
  assert.strictEqual(nonArrayRes.map.first_share.worker, null);
});

test('conquistas: 1 trilhão e o prêmio de ouro (bloco = share acima da dificuldade da rede)', () => {
  const net = 148.4e12, now = Date.now();
  const quase = evaluateAchievements({ best: 2e12, bestWorker: 'orangeone', networkDifficulty: net }, {}, now);
  const ids = quase.newlyUnlocked.map((a) => a.id);
  assert.ok(ids.includes('diff_1t'));
  assert.ok(!ids.includes('block'));
  const semRede = evaluateAchievements({ best: 2e14, bestWorker: 'orangeone' }, {}, now);   // sem dificuldade conhecida, não inventa bloco
  assert.ok(!semRede.newlyUnlocked.some((a) => a.id === 'block'));
  const bloco = evaluateAchievements({ best: 150e12, bestWorker: 'orangeone', networkDifficulty: net }, quase.map, now);
  assert.deepStrictEqual(bloco.newlyUnlocked.map((a) => a.id), ['block']);
  assert.strictEqual(bloco.map.block.worker, 'orangeone');
  const g = bloco.list.find((a) => a.id === 'block');
  assert.ok(g.golden && g.unlocked);
  assert.strictEqual(ACHIEVEMENTS[ACHIEVEMENTS.length - 1].id, 'block', 'o prêmio de ouro fica por último');
});
