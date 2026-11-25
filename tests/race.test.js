const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/race');

test('corrida: precisa de 2 corredores e meta válida', () => {
  const s = R.create();
  assert.strictEqual(R.start(s, { workers: ['a'], goal: 10 }).error, 'racers');
  assert.strictEqual(R.start(s, { workers: ['a', 'b'], goal: 0 }).error, 'goal');
  assert.strictEqual(R.start(s, { workers: ['a', 'a'], goal: 10 }).error, 'racers', 'nomes repetidos contam uma vez');
  assert.ok(R.start(s, { workers: ['a', 'b'], goal: 10 }).ok);
});

test('corrida velocidade: quem chega primeiro aos N shares vence e a corrida acaba', () => {
  const s = R.create();
  R.start(s, { workers: ['orangeone', 'blackone'], goal: 3, mode: 'speed' }, 0);
  R.note(s, 'orangeone', 1, 2000, 2000);
  R.note(s, 'blackone', 2, 2000, 2000);
  R.note(s, 'blackone', 3, 4000, 2000);
  R.note(s, 'nerdminer', 3, 1e9, 1);   // não está na corrida
  assert.strictEqual(R.note(s, 'blackone', 4, 2000, 2000), true);
  const snap = R.snapshot(s, 5);
  assert.strictEqual(snap.race.winner, 'blackone');
  assert.strictEqual(snap.race.running, false);
  assert.deepStrictEqual(snap.race.ranking.map((r) => r.name), ['blackone', 'orangeone']);
  assert.strictEqual(R.note(s, 'orangeone', 6, 2000, 2000), false, 'depois do fim nada conta');
  assert.strictEqual(snap.history[0].winner, 'blackone');
});

test('corrida média: cada um faz os seus N; vence a maior sorte média (geométrica), justa entre máquinas diferentes', () => {
  const s = R.create();
  R.start(s, { workers: ['bitaxe', 'esp32'], goal: 2, mode: 'avg' }, 0);
  R.note(s, 'bitaxe', 1, 4000, 2000);    // 2×
  R.note(s, 'bitaxe', 2, 4000, 2000);    // 2× → terminou, mas a corrida segue até o esp32 terminar
  assert.strictEqual(R.snapshot(s, 3).race.running, true);
  R.note(s, 'esp32', 4, 0.0009, 0.0001); // 9×
  R.note(s, 'esp32', 5, 0.0001, 0.0001); // 1× → média geométrica 3×
  const snap = R.snapshot(s, 6);
  assert.strictEqual(snap.race.running, false);
  assert.strictEqual(snap.race.winner, 'esp32');
  assert.ok(Math.abs(snap.race.ranking[0].luck - 3) < 1e-9);
});

test('corrida maior share: vence o maior share relativo', () => {
  const s = R.create();
  R.start(s, { workers: ['a', 'b'], goal: 1, mode: 'best' }, 0);
  R.note(s, 'a', 1, 50e6, 2000);
  R.note(s, 'b', 2, 30, 1);
  assert.strictEqual(R.snapshot(s, 3).race.winner, 'a');
});

test('corrida: tempo limite encerra e quem terminou fica na frente; cancelar não tem vencedor; estado sobrevive ao reinício', () => {
  const s = R.create();
  R.start(s, { workers: ['a', 'b'], goal: 2, mode: 'avg', maxHours: 1 }, 0);
  R.note(s, 'a', 1, 2, 1); R.note(s, 'a', 2, 2, 1);
  R.note(s, 'b', 3, 100, 1);
  const snap = R.snapshot(s, 3600e3 + 1);
  assert.strictEqual(snap.race.reason, 'time');
  assert.strictEqual(snap.race.winner, 'a', 'b teve sorte maior, mas não terminou');
  R.start(s, { workers: ['a', 'b'], goal: 5 }, 10);
  assert.strictEqual(R.cancel(s, 11), true);
  assert.strictEqual(R.snapshot(s, 12).race.winner, null);
  const back = R.restore(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(back.history.length, 2);
  R.start(back, { workers: ['a', 'b'], goal: 5 }, 20);
  assert.strictEqual(back.race.id, 3, 'numeração continua');
});
