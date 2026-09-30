// e2e_brackets.js — per-bracket rounds end to end against the dev Worker
// (same local setup as e2e_worker.js; migrate-brackets.sql applied):
//   node tests/e2e_brackets.js
// Two pools of six in six rooms, then crossover playoffs: each pool moves
// on its own, a room never reads past its own round, the playoffs open for
// everyone at once, the TD's buttons, a round the TD set back stays put,
// an upload for a round the room hasn't reached is flagged — and a round
// robin (one bracket) behaves exactly as before.
import { buildSchedule } from '../app/engine/schedule.js';
import { buildRosterQbj } from '../app/engine/qbj.js';
import { BASE, call, d1exec, ok, summary } from './e2e_lib.js';

const T12 = ['Stanford', 'Berkeley', 'UIUC', 'ASU', 'Chicago', 'Michigan', 'Yale', 'Penn', 'Rutgers', 'Columbia', 'Minnesota', 'Georgia Tech'];
const packet = (n) => JSON.stringify({ tossups: [{ question: 'Round ' + n + ' tossup text.', answer: 'a' + n }], bonuses: [] });

async function setup(name, format, auto = true) {
  d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const slug = 'e2ebk-' + Math.random().toString(36).slice(2, 8);
  const t = (await call('/api/tournaments', { method: 'POST', json: { name, slug } })).body;
  const A = '/a/' + t.admin_secret;
  const rooms = [];
  for (let i = 0; i < 6; i++) {
    const b = (await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (i + 1) } })).body;
    rooms.push({ id: b.id, secret: b.secret });
  }
  await call(A + '/roster?name=roster.qbj', { method: 'POST',
    body: JSON.stringify(buildRosterQbj(name, T12.map((n) => ({ name: n, players: [n + ' 1'] })))) });
  const sched = buildSchedule(format, T12, rooms.map((r, i) => ({ name: 'Room ' + (i + 1), bucket: r.id })));
  const saved = await call(A + '/schedule', { method: 'POST', json: sched });
  const nRounds = Math.max(...sched.phases.flatMap((p) => p.rounds.map((r) => r.round)));
  for (let n = 1; n <= nRounds; n++) {
    await call(`${A}/packet?round=${n}&name=P${n}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: packet(n) });
  }
  await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', autoAdvance: auto } } });
  await call(A + '/start', { method: 'POST' });
  return { A, rooms, sched, saved };
}
const detail = async (A) => (await call(A)).body;
const rounds = async (A) => {
  const d = await detail(A);
  return { current: d.tournament.current_round, br: d.tournament.bracket_rounds === null ? null : JSON.parse(d.tournament.bracket_rounds) };
};
// schedule room index -> bucket, and which rooms a bracket plays in at round n
const roomsOf = (sched, rooms, key, n) => {
  for (const ph of sched.phases) for (const r of ph.rounds) {
    if (r.round === n) return r.games.filter((g) => g.bracket === key && g.a && g.b).map((g) => rooms[g.room]);
  }
  return [];
};
const start = (room, n) => call(`/b/${room.secret}/start?round=${n}`, { method: 'POST' });

/* ---------- two pools ---------- */

const P = await setup('Bracket Pools', 'pools2');
ok('schedule save turns brackets on', P.saved.body.brackets === true, P.saved.body);
let r = await rounds(P.A);
ok('starts on round 1, brackets stored', r.current === 1 && JSON.stringify(r.br) === '{}', r);
const aRooms = (n) => roomsOf(P.sched, P.rooms, 'A', n);
const bRooms = (n) => roomsOf(P.sched, P.rooms, 'B', n);
ok('three rooms a pool', aRooms(1).length === 3 && bRooms(1).length === 3);

for (const x of aRooms(1)) await start(x, 1);
r = await rounds(P.A);
ok('Pool A all started: Pool A moves to round 2, Pool B stays', r.current === 1 && r.br.A === 2 && (r.br.B ?? 1) === 1, r);
let sa = (await call('/b/' + aRooms(2)[0].secret)).body;
let sb = (await call('/b/' + bRooms(1)[0].secret)).body;
ok('a Pool A room is on round 2 with its bracket', sa.current_round === 2 && sa.tournament_round === 1 && sa.bracket && sa.bracket.key === 'A' && sa.bracket.name === 'Pool A', sa);
ok('a Pool B room is still on round 1', sb.current_round === 1 && sb.bracket && sb.bracket.key === 'B', sb);
let pk = await fetch(`${BASE}/b/${bRooms(1)[0].secret}/packet?round=2&warm=1`);
ok('a Pool B room can\'t download round 2 yet', pk.status === 403, pk.status);
pk = await fetch(`${BASE}/b/${aRooms(2)[0].secret}/packet?round=2&warm=1`);
ok('a Pool A room can', pk.status === 200, pk.status);
ok('a Pool B room can\'t start round 2', (await start(bRooms(1)[0], 2)).status === 400);
ok('a Pool B room\'s schedule says where it is', (await call('/b/' + bRooms(1)[0].secret + '/schedule')).body.round === 1);

for (const x of bRooms(1)) await start(x, 1);
r = await rounds(P.A);
ok('Pool B catches up: current_round is the lower of the two', r.current === 2 && r.br.A === 2 && r.br.B === 2, r);

for (let n = 2; n <= 4; n++) for (const x of [...aRooms(n), ...bRooms(n)]) await start(x, n);
r = await rounds(P.A);
ok('both pools on round 5', r.current === 5 && r.br.A === 5 && r.br.B === 5, r);
for (const x of aRooms(5)) await start(x, 5);
r = await rounds(P.A);
ok('Pool A done: waits at the end of prelims', r.current === 5 && r.br.A === 5, r);
for (const x of bRooms(5)) await start(x, 5);
r = await rounds(P.A);
ok('every pool started its last round: playoffs open together', r.current === 6 && JSON.stringify(r.br) === '{}', r);
const ch = roomsOf(P.sched, P.rooms, 'CH', 6);
const co = roomsOf(P.sched, P.rooms, 'CO', 6);
ok('championship and consolation rooms', ch.length === 3 && co.length === 3, [ch.length, co.length]);
sa = (await call('/b/' + ch[0].secret)).body;
ok('a championship room says so', sa.current_round === 6 && sa.bracket && sa.bracket.name === 'Championship', sa.bracket);

// the TD's buttons
let res = await call(P.A, { method: 'POST', json: { advance: 'CH' } });
r = await rounds(P.A);
ok('advance one bracket', res.status === 200 && r.current === 6 && r.br.CH === 7 && r.br.CO === 6, [res.body, r]);
res = await call(P.A, { method: 'POST', json: { advance: 'all' } });
r = await rounds(P.A);
ok('Advance all: everyone to one past the furthest', r.current === 8 && r.br.CH === 8 && r.br.CO === 8, r);
res = await call(P.A, { method: 'POST', json: { advance: 'CO' } });
ok('a bracket at the end of its phase can\'t advance', res.status === 400, res.body);
res = await call(P.A, { method: 'POST', json: { current_round: 6 } });
r = await rounds(P.A);
ok('Set round puts every bracket on it', r.current === 6 && JSON.stringify(r.br) === '{}', r);

// set back by hand: starts from before don't push it on; a room's start moves only its bracket
for (const x of ch) await start(x, 6);
r = await rounds(P.A);
ok('championship rooms started: championship to 7', r.br.CH === 7 && r.current === 6, r);
res = await call(P.A, { method: 'POST', json: { current_round: 6 } });
for (const x of ch) await start(x, 6);
r = await rounds(P.A);
ok('set back to 6: the same rooms starting 6 again don\'t move it', (r.br.CH ?? 6) === 6 && r.current === 6, r);
for (const x of co) await start(x, 6);
r = await rounds(P.A);
ok('consolation rooms start: only consolation moves', r.br.CO === 7 && (r.br.CH ?? 6) === 6 && r.current === 6, r);

// an upload for a round the room hasn't reached
const up = await call(`/b/${co[0].secret}/upload?round=8&name=${encodeURIComponent('Round_8_early.qbj')}`, { method: 'POST', body: '{}' });
const d = await detail(P.A);
ok('the admin detail flags a game uploaded for a later round', d.early.includes(up.body.id) && d.room_rounds[co[0].id] === 7, { early: d.early, rr: d.room_rounds[co[0].id] });

/* ---------- one bracket: exactly as before ---------- */

const R = await setup('Bracket RR', 'rr');
ok('a round robin leaves brackets off', R.saved.body.brackets === false && (await detail(R.A)).tournament.bracket_rounds === null);
const st = (await call('/b/' + R.rooms[0].secret)).body;
ok('room state: no bracket, same round as the tournament', st.bracket === null && st.current_round === 1 && st.tournament_round === 1, st);
for (const x of R.rooms.slice(0, 5)) await start(x, 1);
ok('five of six started: still round 1', (await rounds(R.A)).current === 1);
pk = await fetch(`${BASE}/b/${R.rooms[0].secret}/packet?round=2&warm=1`);
ok('round 2 still locked for everyone', pk.status === 403, pk.status);
await start(R.rooms[5], 1);
r = await rounds(R.A);
ok('all six: round 2, as before', r.current === 2 && r.br === null, r);
res = await call(R.A, { method: 'POST', json: { advance: 'all' } });
r = await rounds(R.A);
ok('Advance all on a round robin is a plain +1', r.current === 3 && r.br === null, r);
ok('the round robin\'s reader schedule says one bracket', (await call('/b/' + R.rooms[0].secret + '/schedule')).body.multi === false);

// deleting a multi schedule turns brackets off
await call(P.A + '/schedule', { method: 'DELETE' });
ok('deleting the schedule turns brackets off', (await detail(P.A)).tournament.bracket_rounds === null);

summary('brackets e2e');
