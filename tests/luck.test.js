// Medidor de sorte: confere as fórmulas e compara com uma simulação de mineração.
const test = require('node:test');
const assert = require('node:assert');
const { luckOf, theoreticalShare } = require('../src/luck');

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
