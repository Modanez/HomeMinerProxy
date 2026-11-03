// Medidor de sorte.
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

module.exports = { luckOf, theoreticalShare };
