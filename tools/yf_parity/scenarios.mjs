// The tournaments the parity check runs: each is what a TD holds at the end
// of the day — a roster .qbj and one reader-made .qbj per game — plus the
// rule set they would pick in YellowFruit's new-tournament screen.

import fixture from '../../app/demo/fixture.js';
import { buildRosterQbj } from '../../app/engine/qbj.js';

// A game file shaped like MODAQ's QBJ export (what the reader uploads):
// inline team and player objects, answer values inline, only the players
// who were in a lineup, and a match_questions entry per tossup read saying
// who buzzed. Overtime is MODAQ's way too: folded into tossups_read, the
// extra tossups at the end of match_questions. `overtime` lists those
// buzzes, [{team, player, value}] per overtime tossup; they are part of
// the players' counts.
function game(round, a, b, { tossupsRead = 20, overtime = [] } = {}) {
  const regulation = tossupsRead - overtime.length;
  const late = overtime.flat();
  const questions = Array.from({ length: tossupsRead }, (_, i) => ({
    question_number: i + 1, buzzes: [], tossup_question: { parts: 1, type: 'tossup', question_number: i + 1 },
  }));
  const buzz = (q, team, player, value) => questions[q].buzzes.push({
    buzz_position: { word_index: 40 }, player: { name: player },
    team: { name: team.name, players: team.players.map((x) => ({ name: x.name })) }, result: { value },
  });
  let next = 0;
  for (const t of [a, b]) for (const pl of t.players) for (const [v, n] of Object.entries(pl.counts || {})) {
    const inOvertime = late.filter((x) => x.team === t.name && x.player === pl.name && x.value === Number(v)).length;
    for (let k = 0; k < n - inOvertime; k++) buzz(next++ % regulation, t, pl.name, Number(v));
  }
  overtime.forEach((buzzes, i) => buzzes.forEach((x) =>
    buzz(regulation + i, [a, b].find((t) => t.name === x.team), x.player, x.value)));
  const side = (t) => ({
    team: { name: t.name, players: t.players.map((p) => ({ name: p.name })) },
    bonus_points: t.bonus,
    lineups: [{ first_question: 1, players: t.players.map((p) => ({ name: p.name })) }],
    match_players: t.players.map((p) => ({
      player: { name: p.name },
      tossups_heard: p.tuh ?? tossupsRead,
      answer_counts: Object.entries(p.counts || {}).map(([v, n]) => ({ number: n, answer: { value: Number(v) } })),
    })),
  });
  return {
    filename: `Round_${round}_${a.name}_${b.name}.qbj`.replace(/[^\w.]+/g, '_'),
    qbj: { tossups_read: tossupsRead, match_teams: [side(a), side(b)], match_questions: questions, _round: round },
    // what a TD keys into YF's game form for an overtime game
    overtime: overtime.length ? {
      tossups: overtime.length,
      buzzes: Object.fromEntries([a, b].map((t) => [t.name, Object.fromEntries(
        [...new Set(late.filter((x) => x.team === t.name).map((x) => x.value))]
          .map((v) => [v, late.filter((x) => x.team === t.name && x.value === v).length]))])),
    } : undefined,
  };
}
const P = (name, counts, tuh) => ({ name, counts, tuh });

// What a real college event throws at the format: two teams from one
// school, punctuation and non-ASCII in names, powers, a mid-game
// substitution, a rostered player who never plays, a player with no
// buzzes, an overtime game, and a round where nobody negs.
const ROSTER = [
  { name: 'Penn A', players: ['Ana Ng', 'Bo Chen', 'Cy Young', 'Di Wu', 'Eve Holt'] },
  { name: 'Penn B', players: ['Fay Lin', 'Gus Park'] },
  { name: "St. John's (MD)", players: ["Hal O'Neil", 'Ida Bloom', 'Jo Sato'] },
  { name: 'Université Laval', players: ['Kim Côté', 'Léo Roy', 'Max Dion'] },
];
const college = [
  game(1,
    { name: 'Penn A', bonus: 150, players: [
      P('Ana Ng', { 15: 2, 10: 3, '-5': 1 }), P('Bo Chen', { 10: 2 }),
      P('Cy Young', { 15: 1 }, 12), P('Di Wu', {}, 8) /* subbed in for Cy */, P('Eve Holt', {})] },
    { name: 'Penn B', bonus: 40, players: [P('Fay Lin', { 10: 3, '-5': 2 }), P('Gus Park', { 15: 1 })] }),
  game(1,
    { name: "St. John's (MD)", bonus: 110, players: [
      P("Hal O'Neil", { 15: 3, 10: 1 }), P('Ida Bloom', { 10: 2, '-5': 1 }), P('Jo Sato', {})] },
    { name: 'Université Laval', bonus: 90, players: [
      P('Kim Côté', { 10: 4 }), P('Léo Roy', { 15: 1, '-5': 3 }), P('Max Dion', { 10: 1 })] }),
  // overtime: 175-175 after 20; on the 21st Laval negs and Penn A gets it
  game(2,
    { name: 'Penn A', bonus: 120, players: [
      P('Ana Ng', { 15: 1, 10: 4 }, 21), P('Bo Chen', { 10: 1, '-5': 2 }, 21), P('Eve Holt', { 10: 1 }, 21)] },
    { name: 'Université Laval', bonus: 110, players: [
      P('Kim Côté', { 15: 2, 10: 2 }, 21), P('Léo Roy', { 10: 2 }, 21), P('Max Dion', { '-5': 2 }, 21)] },
    { tossupsRead: 21, overtime: [[
      { team: 'Université Laval', player: 'Max Dion', value: -5 },
      { team: 'Penn A', player: 'Eve Holt', value: 10 }]] }),
  // nobody negs
  game(2,
    { name: 'Penn B', bonus: 60, players: [P('Fay Lin', { 10: 4 }), P('Gus Park', { 10: 1 })] },
    { name: "St. John's (MD)", bonus: 200, players: [
      P("Hal O'Neil", { 15: 4, 10: 2 }), P('Ida Bloom', { 10: 3 }), P('Jo Sato', { 15: 1 })] }),
  game(3,
    { name: "St. John's (MD)", bonus: 130, players: [
      P("Hal O'Neil", { 15: 2, 10: 3, '-5': 2 }), P('Ida Bloom', { 10: 2 }), P('Jo Sato', {})] },
    { name: 'Penn A', bonus: 100, players: [
      P('Ana Ng', { 15: 3, 10: 1 }), P('Bo Chen', { 10: 2, '-5': 1 }), P('Cy Young', { 10: 1 }), P('Di Wu', {})] }),
];

// The college roster with Undergraduate and Division II marks. Only
// players are marked (a player is one or the other); a team's marks follow
// from them (qbj.js teamMarks). Penn A has two marked players of five, so
// the team is neither; Penn B is all Division II, so DII (and not UG);
// St. John's is two UG and a DII, so UG; Laval has none. Run with both
// tracked, with each alone (the other's marks must then be nowhere: not a
// column, not a line, not a flag in a file — and St. John's is then not
// UG, its DII player being unmarked), and with a switch on that nobody is
// marked for, which YellowFruit shows as an empty column.
const UG = { ug: true, d2: false };
const D2 = { ug: false, d2: true };
const MARKED = [
  { ...ROSTER[0], marks: { 'Di Wu': UG, 'Eve Holt': D2 } },
  { ...ROSTER[1], marks: { 'Fay Lin': D2, 'Gus Park': D2 } },
  { ...ROSTER[2], marks: { "Hal O'Neil": UG, 'Ida Bloom': UG, 'Jo Sato': D2 } },
  ROSTER[3],
];
const markedScenario = (key, name, teams, track) => ({
  key, name, ruleSet: 'mAcfPowers', roster: buildRosterQbj(name, teams, track), games: college,
});

// A tournament that does NOT read 20 tossups a game. Every export scales
// its rate stats by the regulation count and splits overtime on it, and
// for a long time qb-td simply assumed 20: this event's last two tossups
// became "overtime" in every game, which moved regulation points, TUH and
// bonuses heard on every page, and the .yft told YellowFruit 20 while the
// games held 22. Both were wrong in ways no 20-tossup fixture can show.
// 24 tossups, overtime in threes, and one genuine overtime game.
const LONG_ROSTER = [
  { name: 'Ridge', players: ['Amy Fox', 'Ben Ito', 'Cal Reyes'] },
  { name: 'Northgate', players: ['Dee Osei', 'Eli Park'] },
  { name: 'Westbrook', players: ['Fin Ahmad', 'Gia Silva', 'Hugo Metz'] },
];
const longRounds = [
  game(1,
    { name: 'Ridge', bonus: 180, players: [
      P('Amy Fox', { 15: 3, 10: 4, '-5': 1 }), P('Ben Ito', { 10: 2 }), P('Cal Reyes', { 15: 1 })] },
    { name: 'Northgate', bonus: 70, players: [P('Dee Osei', { 10: 3, '-5': 2 }), P('Eli Park', { 15: 1, 10: 1 })] },
    { tossupsRead: 24 }),
  game(2,
    { name: 'Westbrook', bonus: 150, players: [
      P('Fin Ahmad', { 15: 2, 10: 3 }), P('Gia Silva', { 10: 2, '-5': 1 }), P('Hugo Metz', {})] },
    { name: 'Ridge', bonus: 130, players: [
      P('Amy Fox', { 15: 1, 10: 3 }), P('Ben Ito', { 10: 2, '-5': 2 }), P('Cal Reyes', { 10: 1 })] },
    { tossupsRead: 24 }),
  // Genuinely tied after 24 — 205 each, 65 on tossups plus 140 on bonuses
  // — then three overtime tossups settle it 215-200. The tie has to be
  // real, and the bonus totals divisible by ten: both
  // YellowFruits check that a game which went to overtime was level at the
  // end of regulation, and say so on the game if it was not. Getting the
  // regulation count wrong is exactly what breaks that arithmetic.
  game(3,
    { name: 'Northgate', bonus: 140, players: [
      P('Dee Osei', { 15: 2, 10: 4 }, 27), P('Eli Park', { 10: 1, '-5': 1 }, 27)] },
    { name: 'Westbrook', bonus: 140, players: [
      P('Fin Ahmad', { 15: 2, 10: 2 }, 27), P('Gia Silva', { 10: 2, '-5': 1 }, 27),
      P('Hugo Metz', { '-5': 1 }, 27)] },
    { tossupsRead: 27, overtime: [
      [{ team: 'Westbrook', player: 'Hugo Metz', value: -5 }],
      [{ team: 'Northgate', player: 'Dee Osei', value: 10 }],
      [] ] }),
  game(4,
    { name: 'Ridge', bonus: 110, players: [
      P('Amy Fox', { 15: 2, 10: 2 }), P('Ben Ito', { 10: 1, '-5': 1 }), P('Cal Reyes', {})] },
    { name: 'Westbrook', bonus: 90, players: [
      P('Fin Ahmad', { 10: 3 }), P('Gia Silva', { 15: 1, '-5': 1 }), P('Hugo Metz', { 10: 1 })] },
    { tossupsRead: 24 }),
];

// Staged tournaments, as qb-td schedules them: 12 teams in two prelim pools
// of six (a round robin, five rounds), then playoff brackets by place
// (top three of each pool, bottom three) that carry their prelim games
// and play the other pool's three over three rounds, then a one-game
// final. Results come from a seeded draw; `upTo` stops the day after a
// round, so a scenario can hold the prelims only, or stop mid-playoffs.
// The check (yf_parity.mjs) is YellowFruit's own report of qb-td's
// staged file against qb-td's report.
function stagedScenario(key, name, upTo, { marks = false } = {}) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const SCHOOLS = ['Ames', 'Bloom', 'Cedar', 'Dover', 'Elm', 'Fargo', 'Gale', 'Hale', 'Iona', 'Jett', 'Kent', 'Lyle'];
  const teams = SCHOOLS.map((n, i) => ({ name: n + (i % 3 === 0 ? ' A' : ''), players: [0, 1, 2].map((k) => n + ' Player ' + (k + 1)) }));
  const pools = { A: teams.filter((_, i) => i % 2 === 0).map((t) => t.name), B: teams.filter((_, i) => i % 2 === 1).map((t) => t.name) };
  const rr = (names) => {
    const list = [...names];
    const rounds = [];
    for (let r = 0; r < list.length - 1; r++) {
      const pairs = [];
      for (let i = 0; i < list.length / 2; i++) pairs.push([list[i], list[list.length - 1 - i]]);
      rounds.push(pairs);
      list.splice(1, 0, list.pop());
    }
    return rounds;
  };
  const byName = new Map(teams.map((t) => [t.name, t]));
  const games = [];
  // a game's result: the stronger side (earlier in the list) more often wins;
  // a few draws make tied records
  const play = (round, x, y) => {
    const side = (t, strong) => {
      const gets = Math.max(0, Math.round((strong ? 8 : 5) + rnd() * 5 - 2)); // at most 11 + 8 of 20
      const negs = Math.round(rnd() * 2);
      const counts = [0, 1, 2].map(() => ({}));
      for (let k = 0; k < gets; k++) { const pl = counts[Math.floor(rnd() * 3)]; pl[10] = (pl[10] || 0) + 1; }
      for (let k = 0; k < negs; k++) { const pl = counts[Math.floor(rnd() * 3)]; pl['-5'] = (pl['-5'] || 0) + 1; }
      return { name: t.name, bonus: gets * 10 + Math.round(rnd() * gets) * 10,
        players: t.players.map((pn, k) => P(pn, counts[k])) };
    };
    const xi = teams.indexOf(byName.get(x));
    const yi = teams.indexOf(byName.get(y));
    const strongX = rnd() < (xi < yi ? 0.65 : 0.35);
    games.push(game(round, side(byName.get(x), strongX), side(byName.get(y), !strongX)));
  };
  const prelim = { A: rr(pools.A), B: rr(pools.B) };
  const phases = [{ name: 'Prelims', rounds: [] }, { name: 'Playoffs', rounds: [] }, { name: 'Finals', kind: 'final', rounds: [] }];
  for (let r = 0; r < 5; r++) {
    const pairs = [...prelim.A[r].map((p) => [...p, 'A']), ...prelim.B[r].map((p) => [...p, 'B'])];
    phases[0].rounds.push({ round: r + 1, games: pairs.map(([x, y, k], i) => ({ room: i, a: { team: x }, b: { team: y }, bracket: k })) });
    if (r + 1 <= upTo) for (const [x, y] of pairs) play(r + 1, x, y);
  }
  // playoff brackets by place, drawn from the prelim pools' order as written
  const top = [...pools.A.slice(0, 3), ...pools.B.slice(0, 3)];
  const bottom = [...pools.A.slice(3), ...pools.B.slice(3)];
  for (let r = 0; r < 3; r++) {
    const cross = (b) => [0, 1, 2].map((i) => [b[i], b[3 + ((i + r) % 3)]]);
    const pairs = [...cross(top).map((p) => [...p, 'P1']), ...cross(bottom).map((p) => [...p, 'P2'])];
    phases[1].rounds.push({ round: 6 + r, games: pairs.map(([x, y, k], i) => ({ room: i, a: { team: x }, b: { team: y }, bracket: k })) });
    if (6 + r <= upTo) for (const [x, y] of pairs) play(6 + r, x, y);
  }
  phases[2].rounds.push({ round: 9, games: [{ room: 0, a: { team: top[0] }, b: { team: top[3] } }] });
  if (upTo >= 9) play(9, top[0], top[3]);
  const schedule = { v: 1, rooms: [], phases, pools,
    brackets: [{ key: 'P1', name: '1st–6th place', phase: 1 }, { key: 'P2', name: '7th–12th place', phase: 1 }] };
  const rosterTeams = teams.map((t, i) => ({ name: t.name, players: t.players,
    ...(marks ? { marks: Object.fromEntries(t.players.map((p) => [p, { ug: i % 4 === 1, d2: i % 4 === 2 }])) } : {}) }));
  return { key, name, ruleSet: 'Acf', schedule,
    roster: buildRosterQbj(name, rosterTeams, marks ? { trackUG: true, trackDiv2: true } : undefined), games };
}

export const SCENARIOS = [
  markedScenario('marks', 'Marked Open', MARKED, { trackUG: true, trackDiv2: true }),
  markedScenario('marks-ug', 'Undergrad Open', MARKED, { trackUG: true, trackDiv2: false }),
  markedScenario('marks-d2', 'Division II Open', MARKED, { trackUG: false, trackDiv2: true }),
  markedScenario('marks-empty', 'Unmarked Open', ROSTER, { trackUG: true, trackDiv2: false }),
  {
    // the committed demo tournament: 10/-5, 13 games over 7 rounds, a
    // triple round robin that is one game short
    key: 'demo', name: fixture.name, ruleSet: 'Acf',
    roster: fixture.roster,
    games: fixture.entries.map((e) => ({ filename: e.filename, qbj: e.qbj })),
  },
  {
    key: 'college', name: 'Parity Open', ruleSet: 'mAcfPowers',
    roster: buildRosterQbj('Parity Open', ROSTER),
    games: college,
  },
  {
    // `rules` is the tournament's MODAQ game format (read_core.js
    // effectiveFormat), the thing the TO sets under Tournament Setup ->
    // MODAQ Settings. It reaches the .yft's scoring rules, the overtime
    // split and the stat report's scaling; YellowFruit's own import gets
    // the same numbers typed into its Rules page (yf_parity/import.ts).
    key: 'long', name: 'Long Rounds Invitational', ruleSet: 'mAcfPowers',
    rules: {
      regulationTossupCount: 24,
      minimumOvertimeQuestionCount: 3,
      negValue: -5,
      powers: [{ marker: '(*)', points: 15 }],
      bonusesBounceBack: false,
      overtimeIncludesBonuses: false,
    },
    roster: buildRosterQbj('Long Rounds Invitational', LONG_ROSTER),
    games: longRounds,
  },
  stagedScenario('pools', 'Pools Open', 5, { marks: true }),
];
