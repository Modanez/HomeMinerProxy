// Testes da matemática do share com blocos reais: se a ordem dos bytes estiver errada, o hash não bate.
const test = require('node:test');
const assert = require('node:assert');
const { shareDifficulty, hashDifficulty, swap32, pingScore } = require('../src/stratum');

// Transação coinbase do bloco gênese e do bloco 1
const GENESIS_CB = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';
const BLOCK1_CB = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0704ffff001d0104ffffffff0100f2052a0100000043410496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858eeac00000000';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const BLOCK1_HASH = '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048';

// Divide a coinbase como uma pool faria: coinb1 | extranonce1 (4 bytes) | extranonce2 (4 bytes) | coinb2
function asStratum(cb, at) {
  return { coinb1: cb.slice(0, at), en1: cb.slice(at, at + 8), en2: cb.slice(at + 8, at + 16), coinb2: cb.slice(at + 16) };
}
// No Stratum, o prevhash vai com cada palavra de 4 bytes invertida
const stratumPrev = (displayHex) => swap32(Buffer.from(displayHex, 'hex').reverse()).toString('hex');

test('bloco gênese: remonta o cabeçalho e chega no hash oficial', () => {
  const p = asStratum(GENESIS_CB, 80);
  const job = { coinb1: p.coinb1, coinb2: p.coinb2, branches: [], version: '00000001', prevhash: '0'.repeat(64), nbits: '1d00ffff' };
  const r = shareDifficulty(job, p.en1, ['user.w', 'job', p.en2, '495fab29', '7c2bac1d'], null);
  assert.strictEqual(r.hash, GENESIS_HASH);
  assert.ok(Math.abs(r.diff - 2536.426) < 0.01, `dificuldade ${r.diff}`);
});

test('bloco 1: prevhash no formato Stratum (palavras invertidas)', () => {
  const p = asStratum(BLOCK1_CB, 20);
  const job = { coinb1: p.coinb1, coinb2: p.coinb2, branches: [], version: '00000001', prevhash: stratumPrev(GENESIS_HASH), nbits: '1d00ffff' };
  const r = shareDifficulty(job, p.en1, ['user.w', 'job', p.en2, '4966bc61', '9962e301'], null);
  assert.strictEqual(r.hash, BLOCK1_HASH);
});

test('version rolling (BIP310): bits da máscara vêm do minerador, o resto do job', () => {
  const p = asStratum(GENESIS_CB, 80);
  const base = { coinb1: p.coinb1, coinb2: p.coinb2, branches: ['11'.repeat(32)], prevhash: '0'.repeat(64), nbits: '1d00ffff' };
  const submit = ['u', 'j', p.en2, '495fab29', '7c2bac1d'];
  const rolled = shareDifficulty({ ...base, version: '20000000' }, p.en1, [...submit, '00ffe000'], '1fffe000');
  const direct = shareDifficulty({ ...base, version: '20ffe000' }, p.en1, submit, null);
  assert.strictEqual(rolled.hash, direct.hash);
  // bits fora da máscara enviados pelo minerador são ignorados
  const outside = shareDifficulty({ ...base, version: '20000000' }, p.en1, [...submit, 'e0ffe001'], '1fffe000');
  assert.strictEqual(outside.hash, direct.hash);
});

test('ramos da merkle mudam o hash', () => {
  const p = asStratum(GENESIS_CB, 80);
  const job = { coinb1: p.coinb1, coinb2: p.coinb2, branches: [], version: '00000001', prevhash: '0'.repeat(64), nbits: '1d00ffff' };
  const a = shareDifficulty(job, p.en1, ['u', 'j', p.en2, '495fab29', '7c2bac1d'], null);
  const b = shareDifficulty({ ...job, branches: ['ab'.repeat(32)] }, p.en1, ['u', 'j', p.en2, '495fab29', '7c2bac1d'], null);
  assert.notStrictEqual(a.hash, b.hash);
});

test('cabeçalho com tamanho errado devolve null', () => {
  const job = { coinb1: '00', coinb2: '00', branches: [], version: '00000001', prevhash: '00', nbits: '1d00ffff' };
  assert.strictEqual(shareDifficulty(job, '00', ['u', 'j', '00', '495fab29', '7c2bac1d'], null), null);
});

test('hashDifficulty: dificuldade 1 é o alvo mínimo do Bitcoin', () => {
  assert.strictEqual(hashDifficulty('00000000ffff' + '0'.repeat(52)), 1);
  assert.strictEqual(hashDifficulty('0'.repeat(64)), Infinity);
  assert.ok(Math.abs(hashDifficulty(GENESIS_HASH) - 2536.426) < 0.01);
});

test('version rolling: branches com vbits sem mask ou mask sem vbits', () => {
  const p = asStratum(GENESIS_CB, 80);
  const base = { coinb1: p.coinb1, coinb2: p.coinb2, branches: [], prevhash: '0'.repeat(64), nbits: '1d00ffff', version: '20000000' };
  const submitWithVbits = ['u', 'j', p.en2, '495fab29', '7c2bac1d', '00ffe000'];
  const submitWithoutVbits = ['u', 'j', p.en2, '495fab29', '7c2bac1d'];

  // vbits presente, mas versionMask ausente
  const r1 = shareDifficulty(base, p.en1, submitWithVbits, null);
  // versionMask presente, mas vbits ausente
  const r2 = shareDifficulty(base, p.en1, submitWithoutVbits, '1fffe000');
  assert.strictEqual(r1.hash, r2.hash);
});

test('pingScore: classifica latência em ótimo, bom e ruim', () => {
  assert.deepStrictEqual(pingScore(null), { score: 'unknown', ms: null, label: '–', emoji: '⚪', color: 'gray' });
  assert.deepStrictEqual(pingScore(NaN), { score: 'unknown', ms: null, label: '–', emoji: '⚪', color: 'gray' });
  assert.deepStrictEqual(pingScore(-10), { score: 'unknown', ms: null, label: '–', emoji: '⚪', color: 'gray' });

  const otimo = pingScore(45.2);
  assert.strictEqual(otimo.score, 'great');
  assert.strictEqual(otimo.label, 'ótimo');
  assert.strictEqual(otimo.emoji, '🟢');
  assert.strictEqual(otimo.ms, 45);

  const limiteOtimo = pingScore(100);
  assert.strictEqual(limiteOtimo.score, 'great');

  const bom = pingScore(150);
  assert.strictEqual(bom.score, 'good');
  assert.strictEqual(bom.label, 'bom');
  assert.strictEqual(bom.emoji, '🟡');

  const limiteBom = pingScore(250);
  assert.strictEqual(limiteBom.score, 'good');

  const ruim = pingScore(320);
  assert.strictEqual(ruim.score, 'poor');
  assert.strictEqual(ruim.label, 'ruim');
  assert.strictEqual(ruim.emoji, '🔴');
});
