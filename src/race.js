// Corrida: mineradores escolhidos competem share a share até N shares aceitos.
// Três jeitos de decidir (mode):
//   speed — quem chega primeiro aos N shares. Justo entre máquinas iguais (dois Bitaxe com a mesma dificuldade).
//   avg   — cada um minera os seus N shares; vence a maior sorte média por share. A sorte de um share é a
//           dificuldade que ele alcançou ÷ a dificuldade pedida; a média é geométrica, para um share gigante não
//           decidir sozinho (a média comum de uma distribuição de cauda pesada vira só "quem teve o maior").
//           Justo entre máquinas diferentes: Bitaxe contra ESP32 dá igual, porque cada share conta pela sua sorte.
//   best  — cada um minera os seus N shares; vence o maior share relativo (dificuldade ÷ pedida).
// A corrida acaba quando alguém chega em N (speed), quando todos chegam em N (avg/best) ou no tempo limite
// (padrão 24 h; quem não terminou fica atrás de quem terminou). Sem dependências e sem relógio próprio: o proxy
// chama note() a cada share aceito e tick() ao responder, e guarda o estado com o resto das estatísticas.

const MODES = ['speed', 'avg', 'best'];
const MAX_RACERS = 12;
const HISTORY = 10;
const LAST = 12;   // últimos shares de cada corredor, para o painel desenhar "share a share"

function create() { return { race: null, history: [], seq: 0 }; }

function start(state, { workers, goal, mode, maxHours } = {}, now = Date.now()) {
  const names = [...new Set((Array.isArray(workers) ? workers : []).map((w) => String(w || '').trim()).filter((w) => /^[\w.@-]{1,64}$/.test(w)))].slice(0, MAX_RACERS);
  if (names.length < 2) return { ok: false, error: 'racers' };
  const g = Math.round(Number(goal));
  if (!(g >= 1 && g <= 100000)) return { ok: false, error: 'goal' };
  const m = MODES.includes(mode) ? mode : 'speed';
  const h = Number(maxHours) > 0 ? Math.min(168, Number(maxHours)) : 24;
  if (state.race && !state.race.finishedAt) finish(state, now, 'replaced');
  state.seq = (state.seq || 0) + 1;
  state.race = {
    id: state.seq, mode: m, goal: g, startedAt: now, endsAt: now + h * 3600e3, finishedAt: null, reason: null,
    racers: Object.fromEntries(names.map((n) => [n, { shares: 0, logSum: 0, best: 0, bestDiff: 0, work: 0, doneAt: null, lastAt: null, last: [] }])),
  };
  return { ok: true, race: snapshot(state, now) };
}

function luckOf(r) { return r.shares ? Math.exp(r.logSum / r.shares) : 0; }

// Classificação: quem terminou na frente; depois pelo critério do modo
function ranking(race) {
  const rows = Object.entries(race.racers).map(([name, r]) => ({
    name, shares: r.shares, done: !!r.doneAt, doneAt: r.doneAt, luck: luckOf(r), best: r.best, bestDiff: r.bestDiff,
    progress: Math.min(1, r.shares / race.goal), lastAt: r.lastAt, last: r.last,
  }));
  const by = {
    speed: (a, b) => (a.done !== b.done ? (a.done ? -1 : 1) : a.done ? a.doneAt - b.doneAt : b.shares - a.shares || (a.lastAt || Infinity) - (b.lastAt || Infinity)),
    avg: (a, b) => (a.done !== b.done ? (a.done ? -1 : 1) : b.luck - a.luck || b.shares - a.shares),
    best: (a, b) => (a.done !== b.done ? (a.done ? -1 : 1) : b.best - a.best || b.shares - a.shares),
  }[race.mode];
  return rows.sort(by).map((r, i) => ({ ...r, place: i + 1 }));
}

function finish(state, now, reason) {
  const race = state.race;
  if (!race || race.finishedAt) return;
  race.finishedAt = now;
  race.reason = reason;
  const rank = ranking(race);
  race.winner = reason === 'cancelled' || reason === 'replaced' || !rank.length || !rank[0].shares ? null : rank[0].name;
  state.history.unshift({ id: race.id, mode: race.mode, goal: race.goal, startedAt: race.startedAt, finishedAt: now, reason, winner: race.winner,
    ranking: rank.map(({ name, shares, luck, best, bestDiff, done, doneAt, place }) => ({ name, shares, luck, best, bestDiff, done, doneAt, place })) });
  if (state.history.length > HISTORY) state.history.length = HISTORY;
}

// Um share aceito; devolve true se a corrida acabou com ele
function note(state, name, at, diff, target) {
  const race = state.race;
  if (!race || race.finishedAt) return false;
  const r = race.racers[name];
  if (!r || r.doneAt || !(diff > 0) || !(target > 0)) return false;
  if (at > race.endsAt) { finish(state, at, 'time'); return true; }
  const rel = diff / target;
  r.shares++;
  r.logSum += Math.log(rel);
  r.work += target;
  if (rel > r.best) { r.best = rel; r.bestDiff = diff; }
  r.lastAt = at;
  r.last.push([at, Math.round(diff * 100) / 100, Math.round(rel * 1000) / 1000]);
  if (r.last.length > LAST) r.last.shift();
  if (r.shares >= race.goal) r.doneAt = at;
  const all = Object.values(race.racers);
  if (race.mode === 'speed' ? !!r.doneAt : all.every((x) => x.doneAt)) { finish(state, at, 'goal'); return true; }
  return false;
}

function tick(state, now = Date.now()) {
  if (state.race && !state.race.finishedAt && now > state.race.endsAt) finish(state, now, 'time');
}

function cancel(state, now = Date.now()) {
  if (!state.race || state.race.finishedAt) return false;
  finish(state, now, 'cancelled');
  return true;
}

function snapshot(state, now = Date.now()) {
  tick(state, now);
  const race = state.race;
  return {
    at: now,
    race: race ? { id: race.id, mode: race.mode, goal: race.goal, startedAt: race.startedAt, endsAt: race.endsAt, finishedAt: race.finishedAt, reason: race.reason, winner: race.winner || null, running: !race.finishedAt, ranking: ranking(race) } : null,
    history: state.history.slice(0, HISTORY),
  };
}

// Persistência junto das estatísticas do proxy
function restore(saved) {
  const s = create();
  if (!saved || typeof saved !== 'object') return s;
  if (saved.race && saved.race.racers && typeof saved.race.racers === 'object') s.race = saved.race;
  if (Array.isArray(saved.history)) s.history = saved.history.slice(0, HISTORY);
  s.seq = Number(saved.seq) || (s.race ? s.race.id : 0);
  return s;
}

module.exports = { MODES, create, start, note, tick, cancel, snapshot, restore, ranking };
