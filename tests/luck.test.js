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
