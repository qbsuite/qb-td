// deciders.mjs — tiebreaker deciders (app/js/deciders.js, app/engine/deciderphases.js): the
// schedule keeps them apart from its rounds; the stats, a room's game and the player page read
// them as a Tiebreakers phase.   node tests/deciders.mjs
import assert from 'node:assert/strict';
import { withDeciderPhases, roundLabel, isTbRound, TB_ROUND } from '../app/engine/deciderphases.js';
import { gameForRoom, autoFill } from '../app/engine/schedule.js';
import { yfStages } from '../app/engine/yft.js';
import { decOf, decAfter, partRange, decGames } from '../app/engine/deciderphases.js';
import { buildYft } from '../app/engine/yft.js';
import { parseMatch } from '../app/engine/qbj.js';
import { ownSide, packetHalf } from '../app/engine/deciderphases.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok ' + name); };
const T = (team) => ({ team });
const sched = () => ({ v: 1, rooms: [{ name: 'Room 1', bucket: 11 }, { name: 'Room 2', bucket: 12 }],
  pools: { A: ['A1', 'A2', 'A3', 'A4'] },
  brackets: [{ key: 'A', name: 'Pool A', phase: 0 }, { key: 'T1', name: 'Top', phase: 1 }, { key: 'T2', name: 'Bottom', phase: 1 }],
  phases: [
    { name: 'Prelims', meet: 1, rounds: [
      { round: 1, byes: [], games: [{ room: 0, a: T('A1'), b: T('A2'), bracket: 'A' }, { room: 1, a: T('A3'), b: T('A4'), bracket: 'A' }] },
      { round: 2, byes: [], games: [{ room: 0, a: T('A1'), b: T('A3'), bracket: 'A' }, { room: 1, a: T('A2'), b: T('A4'), bracket: 'A' }] }] },
    { name: 'Playoffs', meet: 1, rounds: [
      { round: 3, byes: [], games: [{ room: 0, a: { label: 'A1' }, b: { label: 'A2' }, bracket: 'T1' }, { room: 1, a: { label: 'A3' }, b: { label: 'A4' }, bracket: 'T2' }] }] }] });
const withGames = () => { const s = sched(); s.deciders = { parts: { 2: 'second' }, released: 1, games: [
  { n: 1, pool: 'A', game: 1, tb: 1, room: 0, a: T('A3'), b: T('A2'), after: 2 },
  { n: 2, pool: 'A', game: 2, tb: 2, room: 0, a: T('A1'), b: { label: 'Winner of A3 vs A2' }, after: 2 }] }; return s; };

test('a schedule without deciders is handed back as it is', () => {
  const s = sched();
  assert.equal(withDeciderPhases(s), s);
  assert.deepEqual(decOf(s), { parts: {}, slots: 0, ties: {}, added: [], games: [], hold: false, released: 0 });
});
test('deciders become a Tiebreakers phase after the round they follow, one round per tiebreaker packet', () => {
  const s = withGames(), w = withDeciderPhases(s);
  assert.deepEqual(w.phases.map((p) => p.name), ['Prelims', 'Tiebreakers', 'Playoffs']);
  assert.deepEqual(w.phases[1].rounds.map((r) => r.round), [TB_ROUND + 1, TB_ROUND + 2]);
  assert.equal(w.phases[1].kind, 'tiebreak');
  assert.equal(w.phases[1].after, 2);
  // the saved schedule is untouched, and its rounds keep their numbers
  assert.deepEqual(s.phases.map((p) => p.name), ['Prelims', 'Playoffs']);
  assert.deepEqual(w.phases[2].rounds.map((r) => r.round), [3]);
  // brackets still point at their own phases
  assert.deepEqual(w.brackets.map((b) => b.phase), [0, 2, 2]);
  assert.equal(withDeciderPhases(w), w, 'done once');
});
test('a room finds its decider under the tiebreaker packet\'s round, and nothing in another room', () => {
  const s = withGames();
  assert.deepEqual(gameForRoom(s, 0, TB_ROUND + 1), { a: 'A3', b: 'A2' });
  assert.equal(gameForRoom(s, 1, TB_ROUND + 1), null);
  assert.equal(gameForRoom(s, 0, TB_ROUND + 2), null, 'a game still waiting on a winner has no teams yet');
  assert.deepEqual(gameForRoom(s, 0, 2), { a: 'A1', b: 'A3' }, 'the rounds are as they were');
});
test('the stats give deciders a stage of their own, apart from the prelims', () => {
  // (the stats wait for the playoff slots to be filled)
  const s = withGames();
  s.phases[1].rounds[0].games = [{ room: 0, a: T('A1'), b: T('A2'), bracket: 'T1' }, { room: 1, a: T('A3'), b: T('A4'), bracket: 'T2' }];
  s.deciders.games[1].b = T('A3');
  const M = (round, x, y) => ({ round, teams: [{ name: x }, { name: y }] });
  // the prelims and the first decider played
  const plan = yfStages(s, [M(1, 'A1', 'A2'), M(1, 'A3', 'A4'), M(2, 'A1', 'A3'), M(2, 'A2', 'A4'), M(TB_ROUND + 1, 'A3', 'A2')]);
  const stages = Array.isArray(plan) ? plan : plan.stages;
  const tb = stages.find((x) => x.rounds.includes(TB_ROUND + 1));
  assert.ok(tb, 'a stage holds the tiebreaker rounds');
  assert.equal(tb.type, 'Tiebreaker');
  assert.ok(!stages.find((x) => x.rounds.includes(1)).rounds.includes(TB_ROUND + 1), 'not the prelims');
});
test('labels: a tiebreaker packet\'s round reads as Tiebreaker k', () => {
  assert.equal(roundLabel(7), 'Round 7');
  assert.equal(roundLabel(TB_ROUND + 2), 'Tiebreaker 2');
  assert.ok(isTbRound(901) && !isTbRound(900) && !isTbRound(12));
});
test('a half of a packet: the first half, the second, or all of it', () => {
  assert.deepEqual(partRange('first', 20), [0, 10]);
  assert.deepEqual(partRange('second', 20), [10, 20]);
  assert.deepEqual(partRange('whole', 20), [0, 20]);
  assert.deepEqual(partRange(undefined, 10), [0, 10]);
});
test('deciders follow the last round before the first playoff slot, in number order', () => {
  const s = withGames();
  assert.equal(decAfter(s), 2);
  assert.deepEqual(decGames(s).map((g) => g.n), [1, 2]);
});
test('auto-fill holds ties across a cut only when the schedule says deciders are on', () => {
  // A2 and A3 level at 1-1 for the last Top spot
  const agg = { teams: [
    { name: 'A1', w: 2, l: 0, t: 0, gp: 2, points: 600, regPoints: 600, regTuh: 40, bonusPoints: 300, bonusesHeard: 20 },
    { name: 'A2', w: 1, l: 1, t: 0, gp: 2, points: 400, regPoints: 400, regTuh: 40, bonusPoints: 200, bonusesHeard: 20 },
    { name: 'A3', w: 1, l: 1, t: 0, gp: 2, points: 300, regPoints: 300, regTuh: 40, bonusPoints: 150, bonusesHeard: 20 },
    { name: 'A4', w: 0, l: 2, t: 0, gp: 2, points: 100, regPoints: 100, regTuh: 40, bonusPoints: 50, bonusesHeard: 20 }],
    games: [
      { round: 1, teams: [{ name: 'A1', points: 300 }, { name: 'A2', points: 100 }] }, { round: 1, teams: [{ name: 'A3', points: 200 }, { name: 'A4', points: 50 }] },
      { round: 2, teams: [{ name: 'A1', points: 300 }, { name: 'A3', points: 100 }] }, { round: 2, teams: [{ name: 'A2', points: 300 }, { name: 'A4', points: 50 }] }] };
  const plain = autoFill(sched(), agg, ['A']);
  assert.equal(plain.held.length, 0, 'without deciders the tie goes by the tie-break figure');
  const s = sched(); s.deciders = { hold: true };
  const held = autoFill(s, agg, ['A']);
  assert.equal(held.held.length, 1, 'with them it waits');
  assert.deepEqual(held.held[0].teams.map((t) => t.name).sort(), ['A2', 'A3']);
});
test('the YellowFruit file: deciders are one round half past the stage, named for it, each game marked a tiebreaker', () => {
  const s = withGames();
  s.phases[1].rounds[0].games = [{ room: 0, a: T('A1'), b: T('A2'), bracket: 'T1' }, { room: 1, a: T('A3'), b: T('A4'), bracket: 'T2' }];
  s.deciders.games[1].b = T('A3');
  const qbj = (x, y, tuh) => ({ tossups_read: tuh, match_questions: [], match_teams: [[x, 3], [y, 1]].map(([name, gets]) => ({
    team: { name, players: [{ name: name + ' p' }] }, bonus_points: gets * 10,
    match_players: [{ player: { name: name + ' p' }, tossups_heard: tuh, answer_counts: [{ number: gets, answer: { value: 10 } }] }] })) });
  let id = 0;
  const M = (round, x, y, tuh = 20) => ({ ...parseMatch(qbj(x, y, tuh), { filename: `Round_${round}_${x}_${y}.qbj` }), round, fileId: ++id, id: ++id });
  const matches = [M(1, 'A1', 'A2'), M(1, 'A3', 'A4'), M(2, 'A1', 'A3'), M(2, 'A2', 'A4'), M(TB_ROUND + 1, 'A3', 'A2', 10), M(TB_ROUND + 2, 'A1', 'A3', 10)];
  const t = buildYft({ name: 'X', matches, schedule: s }).objects.find((o) => o.type === 'Tournament');
  const tb = t.phases.find((ph) => ph.YfData.phaseType === 'Tiebreaker');
  assert.ok(tb, 'a Tiebreaker phase');
  assert.equal(tb.YfData.code, '2T'); // as YF's recomputePhaseCodes numbers it (yft.js yfPhases)
  assert.equal(tb.YfData.forceNumericRounds, undefined);
  assert.deepEqual(tb.rounds.map((r) => [r.YfData.number, r.name, r.matches.length]), [[2.5, 'Tiebreakers', 2]]);
  assert.ok(tb.rounds[0].matches.every((m) => m.tiebreaker === true));
  assert.ok(t.phases[0].rounds.every((r) => r.matches.every((m) => m.tiebreaker === false)));
});
test('a decider of the TD\'s own: a side is a team, a place once its bracket is done, or an earlier one\'s winner or loser', () => {
  const d = { added: [
    { name: 'Play-in', a: { label: '2nd in Pool B' }, b: T('B3'), res: { a: 'B2' }, win: 'b' },
    { name: 'Next', a: { dec: 0, take: 'winner', label: 'Winner of Play-in' }, b: { dec: 0, take: 'loser', label: 'Loser of Play-in' } },
    { name: 'Open', a: { label: '1st in Top' }, b: { dec: 1, take: 'winner', label: 'Winner of Next' } }] };
  assert.deepEqual(ownSide(d, d.added[0], 'a'), { team: 'B2' });
  assert.deepEqual(ownSide(d, d.added[0], 'b'), { team: 'B3' });
  assert.deepEqual(ownSide(d, d.added[1], 'a'), { team: 'B3' }, 'the winner');
  assert.deepEqual(ownSide(d, d.added[1], 'b'), { team: 'B2' }, 'the loser');
  assert.deepEqual(ownSide(d, d.added[2], 'a'), { label: '1st in Top' }, 'a place not known yet keeps its words');
  assert.deepEqual(ownSide(d, d.added[2], 'b'), { label: 'Winner of Next' }, 'a game not played yet keeps its words');
});
test('half a packet for the player page: the other half emptied, each question still at its own number', () => {
  const pk = { name: 'TB', tossups: Array.from({ length: 20 }, (_, i) => ({ question: 'q' + (i + 1), answer: 'a' + (i + 1) })),
    bonuses: Array.from({ length: 20 }, (_, i) => ({ leadin: 'b' + (i + 1), parts: ['x', 'y', 'z'], answers: ['1', '2', '3'] })) };
  const first = JSON.parse(packetHalf(JSON.stringify(pk), 'first')), second = JSON.parse(packetHalf(JSON.stringify(pk), 'second'));
  assert.equal(first.tossups.length, 20);
  assert.deepEqual(first.tossups.map((q) => (q.question ? 1 : 0)).join(''), '11111111110000000000');
  assert.deepEqual(second.tossups.map((q) => (q.question ? 1 : 0)).join(''), '00000000001111111111');
  assert.equal(second.tossups[10].question, 'q11');
  assert.deepEqual(first.bonuses.map((q) => q.parts.length).join(''), '33333333330000000000');
  assert.ok(!JSON.stringify(first).includes('q11') && !JSON.stringify(first).includes('b11'), 'nothing of the other half is left');
  assert.ok(first.tossups.every((q) => typeof q.question === 'string' && typeof q.answer === 'string'), 'still a packet the page reads');
  assert.equal(packetHalf('not json', 'first'), null);
  assert.equal(packetHalf('{"bonuses":[]}', 'first'), null);
});
console.log(n + ' decider checks passed');
