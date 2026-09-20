// Engine test suite: MODAQ qbj parsing, stats aggregation, .yft generation
// (validated with a port of YellowFruit's own parse requirements), zip
// structure. Run: node tests/run_tests.js

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseMatch, parseRoster, roundFromFilename, guessRound, parseRosterLines, buildRosterQbj } from '../app/engine/qbj.js';
import { aggregate, dedupeMatches } from '../app/engine/stats.js';
import { buildYft } from '../app/engine/yft.js';
import { buildReport } from '../app/engine/report.js';
import { makeZip, readZip } from '../app/engine/zip.js';
import { roundRobinRounds, crossRounds, assignRooms, allFormats, formatsFor, buildSchedule, slotAt, setSlot, swapSlots, moveGame, addRound, removeRound, validateSchedule, roomIndexForBucket, roomRounds, gameForRoom, flatRounds, roundIntake, insertRound, swapCells, addRoomCol, removeRoomCol, hasPlaceholders, poolStandings, fillPlaceholders, slotText } from '../app/engine/schedule.js';
import { serializeYft } from '../app/engine/yft.js';
import { serializeYft3 } from '../app/engine/yft3.js';
import { matchBuzzes, roundTossupBuzzes, buzzSummary, tokenizeQuestion, tokenizeQuestionHtml, matchBonuses, roundBonuses, mainAnswerHtml, sanitizeHtml, dedupeEntries } from '../app/engine/buzz.js';
import { categoryStats, categoryTeamStats, catPlayerLines, catTeamLines, catBreakdown, catCompare } from '../app/engine/cats.js';
import { buzzSettings, buzzToken, sha256Hex, BUZZ_ITERS } from '../app/js/buzzkey.js';
import { buildSite, setStandings, setCategories, setCatLines, setQuestionLines, setQuestionPlays, setBuzzNav, setPacketRows, setEarlierRows, setBuzzSummary, setQuestionTable, setBonusLines } from '../app/engine/setstats.js';
import { packetQuestions, matchPacket, matchSummary, assignQuestion, ledgerChoices } from '../app/engine/qmatch.js';
import { checkPacket } from '../app/engine/packetcheck.js';

// MODAQ's actual registration parser (CJS module inside the package) — the
// roster builder's output must satisfy it, since read.html feeds the
// roster straight into the embedded MODAQ.
const { parseRegistration } = createRequire(import.meta.url)('modaq/src/qbj/QBJ.js');
import { protestReport, protestsFromNotes, protestRows, projectUpheld, rulingKey, swingLines, qLabel } from '../app/js/protests.js';
import { normalizePacket, groupTeams, pickTeams, matchFilenames, combinedUpload, withRound, resolveGameFormat, PRESET_FORMATS, cleanOverrides, effectiveFormat, formatOverridesFrom, parsePowersText, powersText, metaKey, gameKey, parseMeta, storeIntact, gameMetas, staleGameKeys, roundRows, normalizeTbPool, tbSelection, tbUsedIds, tbPanelRows } from '../app/js/read_core.js';

let passed = 0;
function test(name, fn) {
  try {
    const r = fn();
    // This runner is synchronous: a returned promise would mean the
    // assertions inside never got waited on, so the test would "pass"
    // whatever it did. Await the value before the test instead.
    if (r && typeof r.then === 'function') throw new Error('test fn must be synchronous');
    passed++; console.log('  ok', name);
  } catch (e) { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

/* ---------- fixtures shaped like MODAQ's toQBJ output ---------- */

function modaqMatch({ round, teamA, teamB, tossupsRead = 20 }) {
  // team: {name, players:[{name}]}, counts: {player: {15: n, 10: n, '-5': n}}
  const mkTeam = (t) => ({
    team: { name: t.name, players: t.players.map((p) => ({ name: p.name })) },
    bonus_points: t.bonusPoints,
    lineups: [{ first_question: 1, players: t.players.map((p) => ({ name: p.name })) }],
    match_players: t.players.map((p) => ({
      player: { name: p.name },
      tossups_heard: p.tuh ?? tossupsRead,
      answer_counts: Object.entries(p.counts || {}).map(([v, n]) => ({
        number: n,
        answer: { value: Number(v) },
      })),
    })),
  });
  return {
    tossups_read: tossupsRead,
    match_teams: [mkTeam(teamA), mkTeam(teamB)],
    match_questions: [],
    _round: round,
  };
}

const M1 = modaqMatch({
  round: 1,
  teamA: { name: 'Alpha', bonusPoints: 60, players: [
    { name: 'Ann', counts: { 15: 2, 10: 2, '-5': 1 } },
    { name: 'Abe', counts: { 10: 2 } },
  ] },
  teamB: { name: 'Beta', bonusPoints: 30, players: [
    { name: 'Bob', counts: { 15: 1, 10: 2, '-5': 2 } },
  ] },
});
// Alpha: 2*15+4*10-5 = 65 tossup + 60 bonus = 125; Beta: 15+20-10 = 25 + 30 = 55

const M2 = modaqMatch({
  round: 2,
  teamA: { name: 'Alpha', bonusPoints: 30, players: [
    { name: 'Ann', counts: { 10: 3 } },
    { name: 'Abe', counts: { '-5': 1 } },
  ] },
  teamB: { name: 'Gamma', bonusPoints: 80, players: [
    { name: 'Gil', counts: { 15: 3, 10: 2 } },
  ] },
});
// Alpha: 30-5=25 +30 = 55; Gamma: 45+20=65 + 80 = 145

const ROSTER = {
  version: '2.1.1',
  objects: [{
    type: 'Tournament',
    name: 'Test Tournament',
    registrations: [
      { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Ann' }, { name: 'Abe' }] }] },
      { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] },
      { name: 'Gamma', teams: [{ name: 'Gamma', players: [{ name: 'Gil' }] }] },
    ],
  }],
};

/* ---------- qbj parsing ---------- */

console.log('qbj parsing');

test('parses a MODAQ match', () => {
  const m = parseMatch(M1);
  assert.equal(m.round, 1);
  assert.equal(m.tossupsRead, 20);
  assert.equal(m.teams[0].name, 'Alpha');
  assert.equal(m.teams[0].points, 125);
  assert.equal(m.teams[0].bonusPoints, 60);
  assert.equal(m.teams[1].points, 55);
  assert.equal(m.teams[0].players[0].counts.find((c) => c.value === 15).n, 2);
});

test('round falls back to filename', () => {
  const noRound = { ...M1 };
  delete noRound._round;
  const m = parseMatch(noRound, { filename: 'Round_7_Alpha_Beta.qbj' });
  assert.equal(m.round, 7);
  assert.equal(roundFromFilename('Round_12_X_Y.qbj'), 12);
});

test('rejects malformed matches', () => {
  assert.throws(() => parseMatch({ tossups_read: 20, match_teams: [] }), /two match_teams/);
  const noRound = { ...M1 };
  delete noRound._round;
  assert.throws(() => parseMatch(noRound, { filename: 'game.qbj' }), /round/i);
  const dupe = modaqMatch({ round: 1,
    teamA: { name: 'X', bonusPoints: 0, players: [{ name: 'P', counts: {} }] },
    teamB: { name: 'X', bonusPoints: 0, players: [{ name: 'Q', counts: {} }] } });
  assert.throws(() => parseMatch(dupe), /same name/);
});

test('accepts camelCase spellings', () => {
  const m = parseMatch({
    tossupsRead: 20, _round: 3,
    matchTeams: [
      { team: { name: 'A' }, bonusPoints: 10,
        matchPlayers: [{ player: { name: 'P' }, tossupsHeard: 20,
          answerCounts: [{ number: 1, answerType: { value: 10 } }] }] },
      { team: { name: 'B' }, bonusPoints: 0, matchPlayers: [] },
    ],
  });
  assert.equal(m.teams[0].points, 20);
});

test('unwraps a combined reader upload to its qbj half', () => {
  const m = parseMatch({ qbj: M1, game: { cycles: [], packetText: 'secret' } });
  assert.equal(m.round, 1);
  assert.equal(m.teams[0].name, 'Alpha');
});

test('parses roster from whole-file tournament qbj', () => {
  const r = parseRoster(ROSTER);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { name: 'Alpha', players: ['Ann', 'Abe'] });
});

test('parses bare registrations list', () => {
  const r = parseRoster([{ name: 'X', teams: [{ name: 'X A', players: [{ name: 'P1' }] }] }]);
  assert.deepEqual(r, [{ name: 'X A', players: ['P1'] }]);
});

/* ---------- roster editor (create roster qbj) ---------- */

console.log('roster editor');

test('parseRosterLines parses Team: Player, Player lines', () => {
  const teams = parseRosterLines('Alpha: Ann, Abe\n\n  Beta : Bob ,  ');
  assert.deepEqual(teams, [
    { name: 'Alpha', players: ['Ann', 'Abe'] },
    { name: 'Beta', players: ['Bob'] },
  ]);
});

test('parseRosterLines rejects junk with line numbers', () => {
  assert.throws(() => parseRosterLines(''), /no teams/);
  assert.throws(() => parseRosterLines('Alpha Ann Abe'), /line 1/);
  assert.throws(() => parseRosterLines('Alpha:'), /line 1: Alpha has no players/);
  assert.throws(() => parseRosterLines(': Ann'), /line 1: no team name/);
  assert.throws(() => parseRosterLines('A: P1\nA: P2'), /line 2: duplicate team A/);
});

test('buildRosterQbj round-trips through parseRoster', () => {
  const qbj = buildRosterQbj('Open', parseRosterLines('Alpha: Ann, Abe\nBeta: Bob'));
  assert.equal(qbj.objects[0].name, 'Open');
  assert.deepEqual(parseRoster(qbj), [
    { name: 'Alpha', players: ['Ann', 'Abe'] },
    { name: 'Beta', players: ['Bob'] },
  ]);
});

test('guessRound reads packet-style filenames safely', () => {
  assert.equal(guessRound('Round 4.docx'), 4);
  assert.equal(guessRound('Packet 3.json'), 3);
  assert.equal(guessRound('03.json'), 3);
  assert.equal(guessRound('2024 ACF Winter Finals.json'), null);
  assert.equal(guessRound('Packet 3 of 12.json'), null);
  assert.equal(guessRound('editors.docx'), null);
});

test('buildRosterQbj output satisfies MODAQ parseRegistration', () => {
  const qbj = buildRosterQbj('Open', parseRosterLines('Alpha: Ann, Abe\nBeta: Bob'));
  const out = parseRegistration(JSON.stringify(qbj));
  assert.equal(out.success, true, out.message);
  assert.deepEqual(out.value.map((p) => p.teamName + '/' + p.name),
    ['Alpha/Ann', 'Alpha/Abe', 'Beta/Bob']);
});

/* ---------- stats ---------- */

console.log('stats');

test('team standings math', () => {
  const { teams, values } = aggregate([parseMatch(M1), parseMatch(M2)], parseRoster(ROSTER));
  assert.deepEqual(values, [15, 10, -5]);
  const alpha = teams.find((t) => t.name === 'Alpha');
  assert.equal(alpha.w, 1);
  assert.equal(alpha.l, 1);
  assert.equal(alpha.gp, 2);
  assert.equal(alpha.points, 180);
  assert.equal(alpha.pointsAgainst, 200);
  assert.equal(alpha.tuh, 40);
  assert.equal(alpha.counts[15], 2);
  assert.equal(alpha.counts[10], 7);
  assert.equal(alpha.counts[-5], 2);
  assert.equal(alpha.bonusesHeard, 9);
  assert.equal(alpha.bonusPoints, 90);
  assert.equal(alpha.ppb, 10);            // 90 / 9
  assert.equal(alpha.pp20tuh, 90);        // 180/40*20
  const gamma = teams.find((t) => t.name === 'Gamma');
  assert.equal(gamma.w, 1);
  assert.equal(gamma.ppb, 16);            // 80 / 5
  // standings order: Beta (0-1) below Alpha (1-1)? no — sort by W-L margin
  assert.equal(teams[0].name, 'Gamma');   // 1-0
});

test('player leaderboard math', () => {
  const { players } = aggregate([parseMatch(M1), parseMatch(M2)], parseRoster(ROSTER));
  const ann = players.find((p) => p.name === 'Ann');
  assert.equal(ann.gp, 2);
  assert.equal(ann.tuh, 40);
  assert.equal(ann.points, 75);           // 30+20-5 + 30
  assert.equal(ann.pp20tuh, 37.5);
  const gil = players.find((p) => p.name === 'Gil');
  assert.equal(gil.points, 65);
  assert.equal(players[0].name, 'Gil');   // 65 pts in 20 tuh
});

test('re-uploaded games count once, latest upload wins', () => {
  const first = parseMatch(M1);
  first.fileId = 5;
  // same round + teams, corrected score, uploaded later
  const fixed = parseMatch(modaqMatch({
    round: 1,
    teamA: { name: 'Alpha', bonusPoints: 90, players: [
      { name: 'Ann', counts: { 15: 2, 10: 2, '-5': 1 } },
      { name: 'Abe', counts: { 10: 2 } },
    ] },
    teamB: { name: 'Beta', bonusPoints: 30, players: [
      { name: 'Bob', counts: { 15: 1, 10: 2, '-5': 2 } },
    ] },
  }));
  fixed.fileId = 9;
  // upload order in the array shouldn't matter when file ids are present
  const { teams, games } = aggregate([fixed, first]);
  assert.equal(games.length, 1);
  assert.equal(teams.find((t) => t.name === 'Alpha').points, 155); // 65 + 90
  assert.equal(teams.find((t) => t.name === 'Alpha').gp, 1);
});

test('dedupe matches reversed team order but not other rounds', () => {
  const a = parseMatch(M1);
  const swapped = parseMatch({ ...M1, match_teams: [M1.match_teams[1], M1.match_teams[0]] });
  assert.equal(aggregate([a, swapped]).games.length, 1);       // same pair, same round
  assert.equal(aggregate([a, parseMatch(M2)]).games.length, 2); // different games
  // no file ids at all: the later entry wins
  const { teams } = aggregate([a, swapped]);
  assert.equal(teams.find((t) => t.name === 'Alpha').points, 125);
});

test('unrostered names are flagged', () => {
  const { teams } = aggregate([parseMatch(M1)], [{ name: 'Alpha', players: ['Ann', 'Abe'] }]);
  assert.equal(teams.find((t) => t.name === 'Beta').rostered, false);
  assert.equal(teams.find((t) => t.name === 'Alpha').rostered, true);
});

/* ---------- .yft generation (validated like YF's FileParsing would) ---------- */

console.log('yft');

function collectIds(node, ids = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => collectIds(n, ids));
  else if (node && typeof node === 'object') {
    if (typeof node.id === 'string') ids.add(node.id);
    Object.values(node).forEach((v) => collectIds(v, ids));
  }
  return ids;
}
function collectRefs(node, refs = []) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, refs));
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') refs.push(node.$ref);
    Object.values(node).forEach((v) => collectRefs(v, refs));
  }
  return refs;
}

const YFT = buildYft({
  name: 'Test Tournament',
  questionSet: '2026 TEST Set',
  matches: [parseMatch(M1), parseMatch(M2)],
  roster: parseRoster(ROSTER),
});

test('whole-file shape and version gate', () => {
  assert.equal(YFT.version, '2.1.1');
  assert.equal(YFT.objects.length, 1);
  const t = YFT.objects[0];
  assert.equal(t.type, 'Tournament');
  assert.equal(t.YfData.YfVersion, '4.0.18');   // parseYftTournament gate
  assert.equal(t.name, 'Test Tournament');
  assert.equal(t.question_set, '2026 TEST Set');
});

test('snake_case conversion applied like YF CaseConversion', () => {
  const s = JSON.stringify(YFT);
  for (const bad of ['matchTeams', 'matchPlayers', 'answerCounts', 'tossupsRead',
    'answerTypes', 'scoringRules', 'questionSet', 'bonusPoints', 'tossupsHeard',
    'forfeitLoss', 'correctTossupsWithoutBonuses']) {
    assert.ok(!s.includes('"' + bad + '"'), `unconverted key ${bad}`);
  }
  // YfData contents keep their spelling
  assert.ok(s.includes('"YfVersion"'));
  assert.ok(s.includes('"trackPlayerYear"'));
  assert.ok(s.includes('"phaseType"'));
});

test('every $ref resolves to an id in the file', () => {
  const ids = collectIds(YFT);
  for (const r of collectRefs(YFT)) assert.ok(ids.has(r), `dangling $ref ${r}`);
});

test('team ids are Team_{name} (parseSeedList requirement)', () => {
  const t = YFT.objects[0];
  for (const reg of t.registrations) {
    for (const team of reg.teams) assert.equal(team.id, `Team_${team.name}`);
    for (const team of reg.teams) assert.ok(team.players.length >= 1, 'team without players');
  }
  for (const seed of t.YfData.seeds) assert.match(seed.$ref, /^Team_/);
});

test('scoring rules satisfy YF parse requirements', () => {
  const rules = YFT.objects[0].scoring_rules;
  const vals = rules.answer_types.map((a) => a.value);
  assert.deepEqual(vals, [15, 10, -5]);            // sortAnswerTypes order
  assert.ok(vals.some((v) => v > 0));              // "no positive point values" check
  assert.equal(rules.maximum_bonus_score, 30);     // bonuses in use
  assert.equal(rules.total_divisor, 5);            // -5 present
  for (const at of rules.answer_types) assert.equal(at.id, `AnswerType_${at.value}`);
});

test('phase/round/match structure', () => {
  const t = YFT.objects[0];
  assert.equal(t.phases.length, 1);
  const ph = t.phases[0];
  assert.equal(ph.YfData.phaseType, 'Prelim');
  assert.ok(ph.name);
  assert.equal(ph.rounds.length, 2);
  assert.equal(ph.rounds[0].name, '1');
  assert.equal(ph.rounds[0].YfData.number, 1);
  for (const rd of ph.rounds) {
    for (const m of rd.matches) {
      assert.equal(m.match_teams.length, 2);       // parseMatchMatchTeams
      assert.ok(Number.isFinite(m.tossups_read));
      assert.equal(m.match_questions, undefined);  // YF ignores question-level data
      for (const mt of m.match_teams) {
        assert.ok(Number.isFinite(mt.points));
        for (const mp of mt.match_players) {
          assert.ok(mp.player.$ref);
          for (const ac of mp.answer_counts) assert.ok(ac.answer_type.$ref);
        }
      }
    }
  }
});

test('match points equal tossup + bonus totals', () => {
  const t = YFT.objects[0];
  const m1 = t.phases[0].rounds[0].matches[0];
  assert.equal(m1.match_teams[0].points, 125);
  assert.equal(m1.match_teams[1].points, 55);
});

test('derives roster from matches when none given', () => {
  const y = buildYft({ name: 'X', matches: [parseMatch(M1)] });
  const names = y.objects[0].registrations.map((r) => r.name);
  assert.deepEqual(names, ['Alpha', 'Beta']);
});

test('.yft path drops superseded uploads via dedupeMatches', () => {
  const first = parseMatch(M1); first.fileId = 5;
  const again = parseMatch(M1); again.fileId = 9;
  const y = buildYft({ name: 'X', matches: dedupeMatches([first, again, parseMatch(M2)]) });
  const games = y.objects[0].phases[0].rounds.flatMap((r) => r.matches);
  assert.equal(games.length, 2);
});

// The three below are what `npm run yf-parity` checks against YellowFruit's
// own code; they pin the facts here so the unit suite notices without it.

test('every team sits in the one pool (YF builds standings pool by pool)', () => {
  const t = YFT.objects[0];
  const [pool, ...others] = t.phases[0].pools;
  assert.equal(others.length, 0);
  assert.equal(pool.YfData.size, t.registrations.flatMap((r) => r.teams).length);
  assert.deepEqual(pool.pool_teams.map((pt) => pt.team.$ref), t.YfData.seeds.map((s) => s.$ref));
  assert.ok(pool.pool_teams.length >= 3);
});

test('"School A" / "School B" share a registration, lettered, like a YF import', () => {
  const y = buildYft({
    name: 'X', matches: [parseMatch(M1)],
    roster: [
      { name: 'Penn B', players: ['Bea'] }, { name: 'Alpha', players: ['Ann', 'Abe'] },
      { name: 'Penn A', players: ['Pat'] }, { name: 'Beta', players: ['Bob'] },
      { name: 'Vitamin C', players: ['Cal'] },
    ],
  }).objects[0];
  assert.deepEqual(y.registrations.map((r) => r.name), ['Alpha', 'Beta', 'Penn', 'Vitamin']);
  const penn = y.registrations[2];
  assert.deepEqual(penn.teams.map((tm) => [tm.name, tm.YfData.letter, tm.id]),
    [['Penn B', 'B', 'Team_Penn B'], ['Penn A', 'A', 'Team_Penn A']]);
  // seeds keep roster order
  assert.deepEqual(y.YfData.seeds.map((s) => s.$ref),
    ['Team_Penn B', 'Team_Alpha', 'Team_Penn A', 'Team_Beta', 'Team_Vitamin C']);
});

test('overtime is split out of tossups read, with each team\'s overtime buzzes', () => {
  // MODAQ folds overtime into tossups_read; YF reads a 21-tossup
  // regulation as an error and leaves the game out of its stats
  const raw = modaqMatch({
    round: 3, tossupsRead: 21,
    teamA: { name: 'Alpha', bonusPoints: 30, players: [{ name: 'Ann', counts: { 10: 3 } }] },
    teamB: { name: 'Beta', bonusPoints: 40, players: [{ name: 'Bob', counts: { 10: 2, '-5': 2 } }] },
  });
  const buzz = (team, player, value) => ({ team: { name: team }, player: { name: player }, result: { value } });
  raw.match_questions = Array.from({ length: 21 }, (_, i) => ({ question_number: i + 1, buzzes: [] }));
  raw.match_questions[2].buzzes.push(buzz('Alpha', 'Ann', 10));
  raw.match_questions[20].buzzes.push(buzz('Beta', 'Bob', -5), buzz('Alpha', 'Ann', 10));
  const game = buildYft({ name: 'X', matches: [parseMatch(raw)] }).objects[0].phases[0].rounds[0].matches[0];
  assert.equal(game.tossups_read, 21);
  assert.equal(game.overtime_tossups_read, 1);
  const ot = (mt) => Object.fromEntries(mt.YfData.overTimeBuzzes.map((b) => [b.answer_type.$ref, b.number]));
  assert.deepEqual(ot(game.match_teams[0]), { AnswerType_10: 1, 'AnswerType_-5': 0 });
  assert.deepEqual(ot(game.match_teams[1]), { AnswerType_10: 0, 'AnswerType_-5': 1 });
  assert.equal(game.match_teams[0].correct_tossups_without_bonuses, 1);
  assert.equal(game.match_teams[1].correct_tossups_without_bonuses, 0);
  // a regulation game says nothing about overtime
  const plain = YFT.objects[0].phases[0].rounds[0].matches[0];
  assert.ok(!('overtime_tossups_read' in plain));
});

/* ---------- yft for YellowFruit 3 ---------- */

console.log('yft (YellowFruit 3)');

// YF 3's file is six JSON values, one per line; `npm run yf-parity` checks
// the whole thing against YF 3.0.2's own importer. These pin the shape.
const YFT3 = serializeYft3({ matches: [parseMatch(M1), parseMatch(M2)], roster: parseRoster(ROSTER) });

test('yf3: six lines — version, packets, settings, divisions, teams, games', () => {
  const lines = YFT3.split('\n');
  assert.equal(lines.length, 6, 'YF 3 splits on newlines and parses each piece');
  const [meta, packets, settings, divisions, teams, games] = lines.map((l) => JSON.parse(l));
  assert.deepEqual(meta, { version: '3.0.2' });
  assert.deepEqual([packets, divisions], [{}, {}]);
  assert.deepEqual(settings, {
    powers: '15pts', negs: true, bonuses: true, bonusesBounce: false, lightning: false,
    playersPerTeam: 4, defaultPhases: [], rptConfig: 'YF Defaults',
  });
  assert.ok(Array.isArray(teams) && Array.isArray(games));
  assert.equal(games.length, 2);
});

test('yf3: teams carry a roster keyed by player name', () => {
  const teams = JSON.parse(YFT3.split('\n')[4]);
  const alpha = teams.find((t) => t.teamName === 'Alpha');
  assert.deepEqual(Object.keys(alpha.roster).slice(0, 2), ['Ann', 'Abe']);
  assert.deepEqual(alpha.roster.Ann, { year: '', undergrad: false, div2: false });
  assert.deepEqual([alpha.divisions, alpha.rank, alpha.smallSchool], [{}, null, false]);
});

test('yf3: a game is powers / tens / negs per player, scores and tossups read', () => {
  const g = JSON.parse(YFT3.split('\n')[5])[0];
  assert.deepEqual([g.round, g.team1, g.team2, g.score1, g.score2, g.tuhtot, g.ottu], [1, 'Alpha', 'Beta', 125, 55, 20, 0]);
  assert.deepEqual(g.players1.Ann, { negs: 1, powers: 2, tens: 2, tuh: 20 });
  assert.deepEqual(g.players2.Bob, { negs: 2, powers: 1, tens: 2, tuh: 20 });
  assert.deepEqual([g.forfeit, g.tiebreaker, g.invalid, g.phases, g.notes], [false, false, false, [], '']);
});

test('yf3: 10/-5 play is written with powers off; overtime buzzes are split out', () => {
  const raw = modaqMatch({
    round: 1, tossupsRead: 21,
    teamA: { name: 'Alpha', bonusPoints: 30, players: [{ name: 'Ann', counts: { 10: 3 } }] },
    teamB: { name: 'Beta', bonusPoints: 40, players: [{ name: 'Bob', counts: { 10: 2, '-5': 2 } }] },
  });
  const buzz = (team, player, value) => ({ team: { name: team }, player: { name: player }, result: { value } });
  raw.match_questions = Array.from({ length: 21 }, (_, i) => ({ question_number: i + 1, buzzes: [] }));
  raw.match_questions[20].buzzes.push(buzz('Beta', 'Bob', -5), buzz('Alpha', 'Ann', 10));
  const lines = serializeYft3({ matches: [parseMatch(raw)] }).split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[2].powers, 'none');
  const g = lines[5][0];
  assert.deepEqual([g.tuhtot, g.ottu, g.otTen1, g.otNeg1, g.otTen2, g.otNeg2, g.otPwr1], [21, 1, 1, 0, 0, 1, 0]);
});

/* ---------- zip ---------- */

console.log('zip');

test('store-only zip structure', () => {
  const z = makeZip([
    { name: 'a/one.qbj', data: '{"x":1}' },
    { name: 'roster.qbj', data: new TextEncoder().encode('{"y":2}') },
  ]);
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);            // local header
  const eocdPos = z.length - 22;
  assert.equal(dv.getUint32(eocdPos, true), 0x06054b50);      // EOCD
  assert.equal(dv.getUint16(eocdPos + 10, true), 2);          // entry count
  const cenSize = dv.getUint32(eocdPos + 12, true);
  const cenOff = dv.getUint32(eocdPos + 16, true);
  assert.equal(cenOff + cenSize + 22, z.length);
  assert.equal(dv.getUint32(cenOff, true), 0x02014b50);       // central dir
});

async function testA(name, fn) {
  try { await fn(); passed++; console.log('  ok', name); }
  catch (e) { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

// A one-entry zip with a deflate (method 8) entry, as real zip tools emit.
// crc is left 0 — readZip trusts central-directory sizes, not checksums.
async function deflateZip(name, text) {
  const cs = new CompressionStream('deflate-raw');
  const data = new Uint8Array(await new Response(
    new Blob([text]).stream().pipeThrough(cs)).arrayBuffer());
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(8, 8, true);                 // deflate
  local.setUint32(18, data.length, true);
  local.setUint16(26, nameB.length, true);
  const cen = new DataView(new ArrayBuffer(46));
  cen.setUint32(0, 0x02014b50, true);
  cen.setUint16(10, 8, true);
  cen.setUint32(20, data.length, true);
  cen.setUint16(28, nameB.length, true);
  cen.setUint32(42, 0, true);
  const cenOff = 30 + nameB.length + data.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, 46 + nameB.length, true);
  eocd.setUint32(16, cenOff, true);
  const out = new Uint8Array(cenOff + 46 + nameB.length + 22);
  let pos = 0;
  for (const b of [new Uint8Array(local.buffer), nameB, data,
    new Uint8Array(cen.buffer), nameB, new Uint8Array(eocd.buffer)]) {
    out.set(b, pos); pos += b.length;
  }
  return out;
}

await testA('readZip round-trips makeZip (store), skipping directories', async () => {
  const z = makeZip([
    { name: 'packets/', data: '' },
    { name: 'packets/Round 1.json', data: '{"x":1}' },
    { name: 'packets/Round 2.json', data: '{"y":2}' },
  ]);
  const entries = await readZip(z);
  assert.deepEqual(entries.map((e) => e.name), ['packets/Round 1.json', 'packets/Round 2.json']);
  assert.equal(new TextDecoder().decode(entries[0].data), '{"x":1}');
});

await testA('readZip inflates deflate entries', async () => {
  const text = JSON.stringify({ tossups: Array(30).fill({ question: 'Q', answer: 'A' }) });
  const entries = await readZip(await deflateZip('Round 3.json', text));
  assert.equal(entries.length, 1);
  assert.equal(new TextDecoder().decode(entries[0].data), text);
});

await testA('readZip rejects non-zips', async () => {
  await assert.rejects(() => readZip(new TextEncoder().encode('not a zip at all......')), /not a zip/);
});

/* ---------- read_core (read.html helpers) ---------- */

console.log('read_core');

test('normalizePacket accepts MODAQ packet JSON', () => {
  const p = normalizePacket({ tossups: [{ question: 'Q', answer: 'A' }] }, 'Packet 3.json');
  assert.equal(p.name, 'Packet 3.json');
  assert.equal(p.tossups.length, 1);
  const named = normalizePacket({ name: 'Round 3', tossups: [{ question: 'Q', answer: 'A' }],
    bonuses: [{ leadin: 'L', parts: ['P'], answers: ['A'], values: [10] }] });
  assert.equal(named.name, 'Round 3');
  assert.equal(named.bonuses.length, 1);
});

test('normalizePacket rejects junk', () => {
  assert.throws(() => normalizePacket({}), /no tossups/);
  assert.throws(() => normalizePacket({ tossups: [] }), /no tossups/);
  assert.throws(() => normalizePacket({ tossups: [{ question: 'Q' }] }), /tossup 1/);
  assert.throws(() => normalizePacket({ tossups: [{ question: 'Q', answer: 'A' }], bonuses: 3 }), /bonuses/);
});

const REG_PLAYERS = [
  { name: 'Ann', teamName: 'Alpha', isStarter: true },
  { name: 'Abe', teamName: 'Alpha', isStarter: true },
  { name: 'Bob', teamName: 'Beta', isStarter: true },
  { name: 'Gil', teamName: 'Gamma', isStarter: true },
];

test('groupTeams keeps roster order', () => {
  const teams = groupTeams(REG_PLAYERS);
  assert.deepEqual(teams.map((t) => t.name), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(teams[0].players.length, 2);
  assert.throws(() => groupTeams([]), /no teams/);
});

test('pickTeams returns both teams\' players, A first', () => {
  const teams = groupTeams(REG_PLAYERS);
  const picked = pickTeams(teams, 'Gamma', 'Alpha');
  assert.deepEqual(picked.map((p) => p.name), ['Gil', 'Ann', 'Abe']);
  assert.throws(() => pickTeams(teams, 'Alpha', 'Alpha'), /different/);
  assert.throws(() => pickTeams(teams, 'Alpha', 'Delta'), /not in roster/);
  assert.throws(() => pickTeams(teams, '', 'Alpha'), /both/);
});

test('matchFilenames follow the MODAQ convention', () => {
  const f = matchFilenames(3, 'St. John\'s A', 'Beta');
  assert.equal(f.combined, 'Round_3_St_John_s_A_Beta.qbtd.json');
  assert.equal(f.qbj, 'Round_3_St_John_s_A_Beta.qbj');
  assert.equal(f.game, 'Round_3_St_John_s_A_Beta_Game.json');
  assert.equal(matchFilenames(1, '!!!', 'B').qbj, 'Round_1_Team_B.qbj');
});

test('combinedUpload packs stamped qbj + game state, surviving a bad store', () => {
  const match = { tossups_read: 20, match_teams: [] };
  const good = JSON.parse(combinedUpload(match, 5, JSON.stringify({ cycles: [] })));
  assert.equal(good.qbj._round, 5);
  assert.deepEqual(good.game, { cycles: [] });
  const noStore = JSON.parse(combinedUpload(match, 5, null));
  assert.equal(noStore.qbj._round, 5);
  assert.equal(noStore.game, null);
  assert.equal(JSON.parse(combinedUpload(match, 5, '{oops')).game, null);
});

test('withRound stamps _round without mutating', () => {
  const m = { tossups_read: 20, match_teams: [] };
  const stamped = withRound(m, 5);
  assert.equal(stamped._round, 5);
  assert.equal(m._round, undefined);
});

test('resolveGameFormat maps settings keys', () => {
  const GameFormats = { ACFGameFormat: { a: 1 }, StandardPowersMACFGameFormat: { b: 1 }, PACEGameFormat: { c: 1 } };
  assert.equal(resolveGameFormat('acf', GameFormats), GameFormats.ACFGameFormat);
  assert.equal(resolveGameFormat('macf-powers', GameFormats), GameFormats.StandardPowersMACFGameFormat);
  assert.equal(resolveGameFormat('pace', GameFormats), GameFormats.PACEGameFormat);
  assert.equal(resolveGameFormat('', GameFormats), undefined);
  assert.equal(resolveGameFormat('nonsense', GameFormats), undefined);
  assert.equal(resolveGameFormat({ gameFormat: 'acf' }, GameFormats), GameFormats.ACFGameFormat);
  assert.equal(resolveGameFormat({}, GameFormats), undefined);
});

test('PRESET_FORMATS mirror the installed MODAQ package', () => {
  // The dashboard prefills/diffs against these copies while the reader gets
  // MODAQ's real objects — a modaq bump that changes a preset must fail here.
  const { GameFormats } = createRequire(import.meta.url)('modaq');
  const pairs = [
    ['', 'UndefinedGameFormat'], ['acf', 'ACFGameFormat'],
    ['macf-powers', 'StandardPowersMACFGameFormat'], ['pace', 'PACEGameFormat'],
  ];
  for (const [key, prop] of pairs) {
    const a = { ...PRESET_FORMATS[key] };
    const b = { ...GameFormats[prop] };
    for (const o of [a, b]) { o.powers = JSON.stringify(o.powers); o.pronunciationGuideMarkers = JSON.stringify(o.pronunciationGuideMarkers); }
    assert.deepEqual(a, b, key || '(default)');
  }
});

test('cleanOverrides keeps valid fields, drops junk', () => {
  const ov = cleanOverrides({
    pairTossupsBonuses: true, negValue: -5, regulationTossupCount: 24,
    powers: [{ marker: '(*)', points: 15 }, { marker: '[+]', points: 20 }],
    pronunciationGuideMarkers: null,
    displayName: 'evil', version: 'evil',          // not overridable
    minimumOvertimeQuestionCount: 0,               // out of range
    bonusesBounceBack: 'yes',                      // wrong type
  });
  assert.deepEqual(Object.keys(ov).sort(),
    ['negValue', 'pairTossupsBonuses', 'powers', 'pronunciationGuideMarkers', 'regulationTossupCount']);
  assert.deepEqual(ov.powers.map((p) => p.points), [20, 15]); // descending
  assert.deepEqual(cleanOverrides(null), {});
  assert.deepEqual(cleanOverrides({ powers: [{ marker: '', points: 15 }] }), {});
});

test('effectiveFormat + resolveGameFormat layer overrides on the preset', () => {
  const s = { gameFormat: 'acf', formatOverrides: { pairTossupsBonuses: true, bonusesBounceBack: true } };
  const f = resolveGameFormat(s);
  assert.equal(f.pairTossupsBonuses, true);
  assert.equal(f.bonusesBounceBack, true);
  assert.equal(f.negValue, -5);                     // from ACF
  assert.equal(f.regulationTossupCount, 20);
  assert.equal(f.displayName, 'ACF (custom)');
  assert.equal(f.version, PRESET_FORMATS.acf.version);
  assert.deepEqual(effectiveFormat(s), f);
  // no preset: overrides sit on MODAQ's default (freeform) format
  const d = resolveGameFormat({ formatOverrides: { negValue: 0 } });
  assert.equal(d.negValue, 0);
  assert.equal(d.regulationTossupCount, 999);
  // pronunciation markers can be cleared outright
  const noPron = resolveGameFormat({ gameFormat: 'pace', formatOverrides: { pronunciationGuideMarkers: null } });
  assert.equal('pronunciationGuideMarkers' in noPron, false);
  // junk-only overrides fall back to the plain preset object
  const GameFormats = { ACFGameFormat: { a: 1 } };
  assert.equal(resolveGameFormat({ gameFormat: 'acf', formatOverrides: { negValue: 'x' } }, GameFormats),
    GameFormats.ACFGameFormat);
});

test('formatOverridesFrom stores only the diff vs the preset', () => {
  const want = { ...PRESET_FORMATS.acf, pairTossupsBonuses: true, negValue: -5 };
  assert.deepEqual(formatOverridesFrom('acf', want), { pairTossupsBonuses: true });
  assert.deepEqual(formatOverridesFrom('acf', { ...PRESET_FORMATS.acf }), {});
  // same values against a different preset ARE a diff
  assert.deepEqual(formatOverridesFrom('pace', { ...PRESET_FORMATS.acf, pronunciationGuideMarkers: null }),
    { negValue: -5, powers: [], pronunciationGuideMarkers: null });
});

test('parsePowersText round-trips and rejects junk', () => {
  assert.deepEqual(parsePowersText('(*)=15'), [{ marker: '(*)', points: 15 }]);
  assert.deepEqual(parsePowersText('(*)=15, [+]=20'),
    [{ marker: '[+]', points: 20 }, { marker: '(*)', points: 15 }]); // descending
  assert.deepEqual(parsePowersText(''), []);
  assert.equal(powersText(parsePowersText('[+]=20, (*)=15')), '[+]=20, (*)=15');
  assert.equal(powersText(PRESET_FORMATS.pace.powers), '(*)=20');
  assert.throws(() => parsePowersText('(*)'), /marker=points/);
  assert.throws(() => parsePowersText('=15'), /marker=points/);
  assert.throws(() => parsePowersText('(*)=x'), /marker=points/);
  assert.throws(() => parsePowersText('(*)=15, (*)=20'), /duplicate/);
});

const META = { a: 'Alpha', b: 'Beta', round: 4, packet: 'P4.json', t: 'Open', room: 'R1', started: 1000 };

test('parseMeta accepts complete records only', () => {
  assert.deepEqual(parseMeta(JSON.stringify(META)), META);
  assert.equal(parseMeta(null), null);
  assert.equal(parseMeta('{oops'), null);
  assert.equal(parseMeta(JSON.stringify({ ...META, b: '' })), null);
  assert.equal(parseMeta(JSON.stringify({ ...META, round: 0 })), null);
  assert.equal(parseMeta(JSON.stringify({ ...META, round: 'x' })), null);
  assert.equal(parseMeta(JSON.stringify({ ...META, started: undefined })), null);
});

test('storeIntact requires parseable object JSON', () => {
  assert.equal(storeIntact(JSON.stringify({ game: {} })), true);
  assert.equal(storeIntact(null), false);
  assert.equal(storeIntact('not json{'), false);
  assert.equal(storeIntact('"just a string"'), false);
});

test('gameMetas lists this room newest-first, skipping mangled entries', () => {
  const store = {
    [metaKey('sec1', 'g1')]: JSON.stringify({ ...META, started: 1000 }),
    [metaKey('sec1', 'g2')]: JSON.stringify({ ...META, a: 'Gamma', started: 3000 }),
    [metaKey('sec1', 'g3')]: '{oops',                       // mangled — skipped
    [metaKey('sec2', 'gx')]: JSON.stringify(META),          // another room
    'qbtdToken': 'tok',
  };
  const metas = gameMetas(Object.keys(store), (k) => store[k], 'sec1');
  assert.deepEqual(metas.map((m) => m.id), ['g2', 'g1']);
  assert.equal(metas[0].a, 'Gamma');
});

test('staleGameKeys keeps the newest N games, both keys dropped', () => {
  const metas = [3000, 2000, 1000].map((started, i) => ({ id: 'g' + i, ...META, started }));
  assert.deepEqual(staleGameKeys(metas, 'sec1', 2),
    [metaKey('sec1', 'g2'), gameKey('sec1', 'g2')]);
  assert.deepEqual(staleGameKeys(metas, 'sec1', 8), []);
});

test('roundRows merges packets with newest game per round, live flagged', () => {
  const packets = [{ number: 1, packet_name: 'p1.json' }, { number: 2, packet_name: 'p2.json' }];
  const metas = [ // newest-first, as gameMetas returns
    { id: 'g9', round: 1, a: 'C', b: 'D', started: 3000 },
    { id: 'g1', round: 1, a: 'A', b: 'B', started: 1000 },
    { id: 'g5', round: 7, a: 'E', b: 'F', started: 2000 }, // no packet: row kept
  ];
  const rows = roundRows(packets, metas, 2);
  assert.deepEqual(rows.map((r) => r.number), [1, 2, 7]);
  assert.deepEqual(rows.map((r) => r.live), [false, true, false]);
  assert.equal(rows[0].game.id, 'g9');                 // newest round-1 game wins
  assert.equal(rows[1].game, null);
  assert.deepEqual(rows[2], { number: 7, packet: null, live: false, game: { id: 'g5', a: 'E', b: 'F' } });
  assert.deepEqual(roundRows([], [], 1), []);
});

/* ---------- schedule generation ---------- */

function scheduleSlots(round) {
  const out = [];
  for (const g of round.games) out.push(g.a, g.b);
  out.push(...round.byes);
  return out;
}

test('roundRobinRounds even n: n-1 rounds, every pair once, no byes', () => {
  for (const n of [4, 6, 8, 10, 12]) {
    const rounds = roundRobinRounds(n);
    assert.equal(rounds.length, n - 1);
    const met = new Set();
    for (const r of rounds) {
      assert.equal(r.byes.length, 0);
      const seen = new Set();
      for (const [a, b] of r.pairs) {
        for (const t of [a, b]) { assert.ok(!seen.has(t), 'team twice in round'); seen.add(t); }
        const k = Math.min(a, b) + ':' + Math.max(a, b);
        assert.ok(!met.has(k), 'pair repeated');
        met.add(k);
      }
      assert.equal(seen.size, n);
    }
    assert.equal(met.size, n * (n - 1) / 2);
  }
});

test('roundRobinRounds odd n: n rounds, one bye each, every pair once', () => {
  for (const n of [5, 7, 9]) {
    const rounds = roundRobinRounds(n);
    assert.equal(rounds.length, n);
    const met = new Set();
    const byeCount = new Array(n).fill(0);
    for (const r of rounds) {
      assert.equal(r.byes.length, 1);
      byeCount[r.byes[0]]++;
      for (const [a, b] of r.pairs) met.add(Math.min(a, b) + ':' + Math.max(a, b));
    }
    assert.deepEqual(byeCount, new Array(n).fill(1));
    assert.equal(met.size, n * (n - 1) / 2);
  }
});

test('crossRounds: every A meets every B exactly once', () => {
  for (const [p, q] of [[2, 2], [3, 2], [3, 3], [4, 3]]) {
    const A = [...Array(p).keys()];
    const B = [...Array(q).keys()].map((i) => 100 + i);
    const rounds = crossRounds(A, B);
    assert.equal(rounds.length, Math.max(p, q));
    const met = new Set();
    for (const r of rounds) {
      const seen = new Set();
      for (const [a, b] of r.pairs) {
        assert.ok(a < 100 && b >= 100);
        met.add(a + ':' + b);
        seen.add(a); seen.add(b);
      }
      for (const t of r.byes) { assert.ok(!seen.has(t)); seen.add(t); }
      assert.equal(seen.size, p + q);
    }
    assert.equal(met.size, p * q);
  }
});

test('assignRooms keeps a team in its previous room when free', () => {
  const prev = new Map([[0, 2], [3, 1]]);
  const rooms = assignRooms([[0, 5], [3, 4], [6, 7]], 3, prev);
  assert.equal(rooms[0], 2);
  assert.equal(rooms[1], 1);
  assert.equal(rooms[2], 0);
  assert.equal(new Set(rooms).size, 3);
});

const TEAMS8 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ROOMS4 = [1, 2, 3, 4].map((i) => ({ name: 'Room ' + i, bucket: i === 1 ? 11 : null }));

test('buildSchedule rr: valid grid, sequential rounds, roster teams', () => {
  const s = buildSchedule('rr', TEAMS8, ROOMS4);
  assert.equal(s.v, 1);
  assert.deepEqual(s.rooms[0], { name: 'Room 1', bucket: 11 });
  const rounds = flatRounds(s);
  assert.equal(rounds.length, 7);
  rounds.forEach((r, i) => assert.equal(r.round, i + 1));
  assert.deepEqual(validateSchedule(s, TEAMS8), []);
  for (const r of rounds) {
    assert.equal(r.games.length, 4);
    assert.equal(new Set(r.games.map((g) => g.room)).size, 4);
  }
});

test('buildSchedule rr odd teams: byes present, still valid', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 7), ROOMS4.slice(0, 3));
  const rounds = flatRounds(s);
  assert.equal(rounds.length, 7);
  for (const r of rounds) assert.equal(r.byes.length, 1);
  assert.deepEqual(validateSchedule(s, TEAMS8), []);
});

test('buildSchedule rr2: each pair exactly twice', () => {
  const s = buildSchedule('rr2', TEAMS8.slice(0, 6), ROOMS4.slice(0, 3));
  const met = {};
  for (const r of flatRounds(s)) {
    for (const g of r.games) {
      const k = [g.a.team, g.b.team].sort().join(':');
      met[k] = (met[k] || 0) + 1;
    }
  }
  assert.deepEqual(new Set(Object.values(met)), new Set([2]));
  assert.equal(Object.keys(met).length, 15);
  // repeats live in the second phase, so no same-phase rematch warnings
  assert.deepEqual(validateSchedule(s, TEAMS8), []);
});

test('buildSchedule rr3/rr4: 4 teams in 2 rooms, each pair 3x/4x', () => {
  for (const [key, times] of [['rr3', 3], ['rr4', 4]]) {
    const s = buildSchedule(key, TEAMS8.slice(0, 4), ROOMS4.slice(0, 2));
    const rounds = flatRounds(s);
    assert.equal(rounds.length, 3 * times);
    rounds.forEach((r, i) => assert.equal(r.round, i + 1));
    const met = {};
    for (const r of rounds) {
      for (const g of r.games) {
        const k = [g.a.team, g.b.team].sort().join(':');
        met[k] = (met[k] || 0) + 1;
      }
    }
    assert.equal(Object.keys(met).length, 6);
    assert.deepEqual(new Set(Object.values(met)), new Set([times]));
    assert.deepEqual(validateSchedule(s, TEAMS8), []);
  }
  const keys = formatsFor(4, 2).map((f) => f.key);
  for (const k of ['rr', 'rr2', 'rr3', 'rr4']) assert.ok(keys.includes(k), k);
  assert.ok(!allFormats(5).some((f) => f.key === 'rr4')); // capped at 4 teams
});

test('buildSchedule pools2: prelims by pool, crossover playoffs with placeholders', () => {
  const s = buildSchedule('pools2', TEAMS8, ROOMS4);
  assert.equal(s.phases.length, 2);
  assert.equal(s.phases[0].rounds.length, 3);            // pools of 4
  assert.deepEqual(validateSchedule(s, TEAMS8), []);
  const playoff = s.phases[1];
  const labels = new Set();
  for (const r of playoff.rounds) {
    for (const g of r.games) {
      assert.ok(g.a.label && g.b.label, 'playoff slots are placeholders');
      // crossover: never two slots from the same prelim pool
      assert.notEqual(g.a.label[0], g.b.label[0]);
      labels.add(g.a.label); labels.add(g.b.label);
    }
  }
  assert.deepEqual([...labels].sort(), ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
});

test('buildSchedule pools3: playoff pools regroup by finish position', () => {
  const teams12 = [...TEAMS8, 'I', 'J', 'K', 'L'];
  const s = buildSchedule('pools3', teams12, [...ROOMS4, { name: 'Room 5', bucket: null }, { name: 'Room 6', bucket: null }]);
  assert.deepEqual(validateSchedule(s, teams12), []);
  const playoff = s.phases[1];
  for (const r of playoff.rounds) {
    for (const g of r.games) {
      assert.ok(g.a.label && g.b.label);
      // same finish position, different pools
      assert.equal(g.a.label.slice(1), g.b.label.slice(1));
      assert.notEqual(g.a.label[0], g.b.label[0]);
    }
  }
});

test('formatsFor filters by room count', () => {
  const all = allFormats(8).map((f) => f.key);
  assert.ok(all.includes('rr') && all.includes('rr2') && all.includes('pools2'));
  const cramped = formatsFor(8, 2).map((f) => f.key);
  assert.ok(!cramped.includes('rr'));
  assert.deepEqual(formatsFor(2, 8), []);
});

test('swap/setSlot/addRound/removeRound edit the grid and renumber', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 4), ROOMS4.slice(0, 2));
  const r0 = { p: 0, r: 0, g: 0, side: 'a' };
  const r1 = { p: 0, r: 0, g: 1, side: 'b' };
  const [was0, was1] = [slotAt(s, r0).team, slotAt(s, r1).team];
  swapSlots(s, r0, r1);
  assert.equal(slotAt(s, r0).team, was1);
  assert.equal(slotAt(s, r1).team, was0);
  addRound(s, 0);
  const rounds = flatRounds(s);
  assert.equal(rounds.length, 4);
  assert.equal(rounds[3].round, 4);
  assert.deepEqual(rounds[3].games.map((g) => [g.a, g.b]), [[null, null], [null, null]]);
  setSlot(s, { p: 0, r: 3, g: 0, side: 'a' }, { team: 'A' });
  assert.equal(slotAt(s, { p: 0, r: 3, g: 0, side: 'a' }).team, 'A');
  removeRound(s, 0, 0);
  assert.equal(flatRounds(s).length, 3);
  assert.equal(flatRounds(s)[0].round, 1);
});

test('moveGame swaps rooms when occupied, moves when free, keeps games sorted', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 4), ROOMS4.slice(0, 3));
  const round = s.phases[0].rounds[0];
  const [teamsIn0, teamsIn1] = round.games.map((g) => [g.a.team, g.b.team]);
  // both rooms occupied: the games trade rooms, teams travel with them
  moveGame(s, { p: 0, r: 0, g: 0 }, round.games[1].room);
  assert.deepEqual(round.games.map((g) => [g.a.team, g.b.team]), [teamsIn1, teamsIn0]);
  assert.deepEqual(round.games.map((g) => g.room), [0, 1]);
  assert.deepEqual(validateSchedule(s, TEAMS8.slice(0, 4)), []);
  // target room empty: plain move, no other game touched
  moveGame(s, { p: 0, r: 0, g: 0 }, 2);
  assert.deepEqual(round.games.map((g) => g.room), [1, 2]);
  assert.deepEqual(round.games.map((g) => [g.a.team, g.b.team]), [teamsIn0, teamsIn1]);
  assert.deepEqual(validateSchedule(s, TEAMS8.slice(0, 4)), []);
});

test('roundIntake counts clean games in vs scheduled, names rooms still out', () => {
  const buckets = [{ id: 11, room_name: 'Main' }, { id: 12, room_name: 'Annex' }];
  const s = buildSchedule('rr', TEAMS8.slice(0, 4),
    [{ name: 'Main', bucket: 11 }, { name: 'Annex', bucket: 12 }]);
  const ok = (bucket) => ({ round: 1, bucket_id: bucket, kind: 'combined', error: null });
  // one game in: the other linked room is named
  assert.deepEqual(roundIntake(s, 1, buckets, [ok(11)]),
    { got: 1, expected: 2, missing: ['Annex'] });
  // errored and non-game uploads don't count
  assert.deepEqual(roundIntake(s, 1, buckets,
    [ok(11), { ...ok(12), error: 'bad' }, { ...ok(12), kind: 'game', error: null }]).got, 1);
  // all in: nothing missing
  assert.deepEqual(roundIntake(s, 1, buckets, [ok(11), ok(12)]),
    { got: 2, expected: 2, missing: [] });
  // no schedule: one game per bucket room
  assert.deepEqual(roundIntake(null, 1, buckets, [ok(11)]),
    { got: 1, expected: 2, missing: ['Annex'] });
  // round the schedule doesn't cover: bucket fallback too
  assert.deepEqual(roundIntake(s, 99, buckets, []).expected, 2);
});

test('validateSchedule flags two games in one room', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 4), ROOMS4.slice(0, 2));
  s.phases[0].rounds[0].games[1].room = s.phases[0].rounds[0].games[0].room;
  const w = validateSchedule(s, TEAMS8.slice(0, 4));
  assert.ok(w.some((x) => x.includes('round 1: two games in Room 1')));
});

test('validateSchedule flags unknown teams, double play, same-phase rematch', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 4), ROOMS4.slice(0, 2));
  setSlot(s, { p: 0, r: 0, g: 0, side: 'a' }, { team: 'Zed' });
  const w1 = validateSchedule(s, TEAMS8.slice(0, 4));
  assert.ok(w1.some((w) => w.includes('not on roster: Zed')));
  const dup = slotAt(s, { p: 0, r: 1, g: 0, side: 'a' });
  setSlot(s, { p: 0, r: 1, g: 1, side: 'b' }, dup);
  const w2 = validateSchedule(s, TEAMS8.slice(0, 4));
  assert.ok(w2.some((w) => w.includes('twice')));
  const g0 = s.phases[0].rounds[0].games[0];
  const g2 = s.phases[0].rounds[2].games[0];
  g2.a = { ...g0.a }; g2.b = { ...g0.b };
  assert.ok(validateSchedule(s, TEAMS8.slice(0, 4)).some((w) => w.includes('again')));
});

test('gameForRoom + roomRounds + roomIndexForBucket', () => {
  const s = buildSchedule('rr', TEAMS8, ROOMS4);
  assert.equal(roomIndexForBucket(s, 11), 0);
  assert.equal(roomIndexForBucket(s, 999), null);
  const g = gameForRoom(s, 0, 1);
  assert.ok(g.a && g.b && g.a !== g.b);
  assert.equal(gameForRoom(s, 0, 99), null);
  const rr = roomRounds(s, 0);
  assert.equal(rr.length, 7);
  assert.deepEqual(rr.map((x) => x.round), [1, 2, 3, 4, 5, 6, 7]);
  // placeholder slots never preselect
  const p = buildSchedule('pools2', TEAMS8, ROOMS4);
  const playoffRound = p.phases[1].rounds[0].round;
  assert.equal(gameForRoom(p, 0, playoffRound), null);
});

/* ---------- buzz extraction ---------- */

const buzz = (team, player, position, value) => ({
  buzz_position: { word_index: position },
  player: { name: player },
  team: { name: team },
  result: { value },
});
const BUZZ_QBJ = {
  tossups_read: 3,
  match_teams: [],
  match_questions: [
    { question_number: 1,
      tossup_question: { type: 'tossup', question_number: 1 },
      buzzes: [buzz('Beta', 'Bob', 8, -5), buzz('Alpha', 'Ann', 33, 15)] },
    { question_number: 2,
      tossup_question: { type: 'tossup', question_number: 2 },
      replacement_tossup_question: { type: 'tossup', question_number: 3 },
      buzzes: [buzz('Alpha', 'Ann', 12, 10)] },
    { question_number: 3,
      tossup_question: { type: 'tossup', question_number: 4 },
      buzzes: [] },
    { question_number: 4,
      tossup_question: { type: 'tossup', question_number: 5 },
      buzzes: [ // malformed rows dropped
        { player: { name: 'Ann' }, team: { name: 'Alpha' }, result: { value: 10 } },
        buzz('Beta', 'Bea', 20, 0),
      ] },
  ],
  _round: 1,
};

test('matchBuzzes maps cycles to packet tossups, keeps dead ones, drops junk', () => {
  const rows = matchBuzzes(BUZZ_QBJ);
  assert.deepEqual(rows.map((r) => r.tossup), [1, 3, 4, 5]);
  // replacement tossup wins over the thrown-out one
  assert.equal(rows[1].tossup, 3);
  assert.deepEqual(rows[0].buzzes.map((b) => b.player), ['Bob', 'Ann']); // by position
  assert.deepEqual(rows[0].buzzes[1], { player: 'Ann', team: 'Alpha', position: 33, value: 15 });
  assert.deepEqual(rows[2].buzzes, []); // dead in this room, still listed
  assert.deepEqual(rows[3].buzzes.map((b) => b.player), ['Bea']); // missing position dropped
  // wrapped forms unwrap
  assert.equal(matchBuzzes({ qbj: BUZZ_QBJ }).length, 4);
  assert.equal(matchBuzzes({ objects: [BUZZ_QBJ] }).length, 4);
  assert.deepEqual(matchBuzzes({ tossups_read: 5 }), []);
});

test('roundTossupBuzzes merges rooms for one round', () => {
  const other = { ...BUZZ_QBJ,
    match_questions: [{ question_number: 1,
      tossup_question: { type: 'tossup', question_number: 1 },
      buzzes: [buzz('Gamma', 'Gil', 20, 10)] }] };
  const entries = [
    { round: 1, room: 'R1', qbj: BUZZ_QBJ },
    { round: 1, room: 'R2', qbj: other },
    { round: 2, room: 'R1', qbj: other },
  ];
  const rows = roundTossupBuzzes(entries, 1);
  assert.deepEqual(rows.map((r) => r.tossup), [1, 3, 4, 5]);
  assert.deepEqual(rows[0].buzzes.map((b) => [b.player, b.room]),
    [['Bob', 'R1'], ['Gil', 'R2'], ['Ann', 'R1']]);
  assert.deepEqual(rows[2], { tossup: 4, buzzes: [] }); // dead everywhere
});

test('buzzSummary tallies powers/gets/negs and correct-buzz positions', () => {
  const entries = [
    { round: 1, room: 'R1', qbj: BUZZ_QBJ },
    { round: 2, room: 'R1', qbj: BUZZ_QBJ },
  ];
  const rows = buzzSummary(entries);
  const ann = rows.find((r) => r.player === 'Ann');
  assert.deepEqual(
    { powers: ann.powers, gets: ann.gets, negs: ann.negs, correct: ann.correct },
    { powers: 2, gets: 2, negs: 0, correct: 4 });
  assert.equal(ann.avg, (33 + 12 + 33 + 12) / 4);
  assert.equal(ann.best, 12);
  const bob = rows.find((r) => r.player === 'Bob');
  assert.deepEqual({ negs: bob.negs, correct: bob.correct, avg: bob.avg, best: bob.best },
    { negs: 2, correct: 0, avg: null, best: null });
  assert.equal(rows[0].player, 'Ann'); // most correct first
});

test('matchBonuses reads controlled + bounceback parts and the controlling team', () => {
  const qbj = { ...BUZZ_QBJ,
    match_questions: [
      { question_number: 1,
        tossup_question: { type: 'tossup', question_number: 1 },
        buzzes: [buzz('Beta', 'Bob', 8, -5), buzz('Alpha', 'Ann', 33, 15)],
        bonus: { question: { parts: 3, type: 'bonus', question_number: 1 },
          parts: [{ controlled_points: 10 }, { controlled_points: 0, bounceback_points: 10 },
            { controlled_points: 10 }] } },
      { question_number: 2,
        tossup_question: { type: 'tossup', question_number: 2 },
        buzzes: [] }, // dead tossup, no bonus
    ] };
  const rows = matchBonuses(qbj);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { bonus: 1, team: 'Alpha',
    parts: [10, 0, 10], bounce: [0, 10, 0], total: 20, bounceTotal: 10 });
  assert.deepEqual(matchBonuses({ qbj }), rows); // combined wrapper unwraps
  assert.deepEqual(matchBonuses({ tossups_read: 5 }), []);
});

test('roundBonuses groups per packet bonus across rooms', () => {
  const mkQbj = (team, pts) => ({ ...BUZZ_QBJ,
    match_questions: [{ question_number: 1,
      tossup_question: { type: 'tossup', question_number: 1 },
      buzzes: [buzz(team, 'P', 5, 10)],
      bonus: { question: { parts: 3, type: 'bonus', question_number: 2 },
        parts: pts.map((p) => ({ controlled_points: p })) } }] });
  const entries = [
    { round: 1, room: 'R1', qbj: mkQbj('Alpha', [10, 10, 0]) },
    { round: 1, room: 'R2', qbj: mkQbj('Gamma', [0, 0, 10]) },
    { round: 2, room: 'R1', qbj: mkQbj('Alpha', [10, 10, 10]) },
  ];
  const rows = roundBonuses(entries, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bonus, 2);
  assert.deepEqual(rows[0].results.map((r) => [r.room, r.team, r.total]),
    [['R1', 'Alpha', 20], ['R2', 'Gamma', 10]]);
});

test('mainAnswerHtml keeps the first answerline with its formatting', () => {
  assert.equal(mainAnswerHtml('Johannes <b><u>Brahms</u></b> [accept anything]'),
    'Johannes <b><u>Brahms</u></b>');
  assert.equal(mainAnswerHtml('<u>The</u> <b><u>Golden Pot</u></b> [or <u>Der goldne Topf</u>]'),
    '<u>The</u> <b><u>Golden Pot</u></b>');
  assert.equal(mainAnswerHtml('E. T. A. Hoffmann [accept Ernst] (prompt on H)'),
    'E. T. A. Hoffmann');
  assert.equal(mainAnswerHtml('ANSWER: mitochondria'), 'mitochondria');
  // a bracket that cuts inside a tag pair still yields balanced HTML
  assert.equal(mainAnswerHtml('<b><u>red (prompt on scarlet)</u></b>'), '<b><u>red</u></b>');
  // disallowed tags drop, text is escaped
  assert.equal(mainAnswerHtml('<span class="x">a</span> <script>b</script> < 5 & six'),
    'a b &lt; 5 &amp; six');
  assert.equal(mainAnswerHtml('[weird all-bracket line]'), '[weird all-bracket line]');
  assert.equal(mainAnswerHtml(''), '');
});

test('tokenizeQuestion strips tags and splits on whitespace', () => {
  assert.deepEqual(tokenizeQuestion('For 10 points, name this <b>author</b> of&nbsp;<i>Faust</i>.'),
    ['For', '10', 'points,', 'name', 'this', 'author', 'of', 'Faust', '.']);
  assert.deepEqual(tokenizeQuestion(''), []);
});

test('sanitizeHtml keeps b/u/i/em, escapes the rest, closes dangling tags', () => {
  assert.equal(sanitizeHtml('ANSWER: <b><u>Wuthering Heights</u></b> [accept <b><u>WH</u></b>]'),
    'ANSWER: <b><u>Wuthering Heights</u></b> [accept <b><u>WH</u></b>]');
  assert.equal(sanitizeHtml('<span class="x">a</span> <script>b</script> < 5 & six'),
    'a b &lt; 5 &amp; six');
  assert.equal(sanitizeHtml('<b><u>never closed'), '<b><u>never closed</u></b>');
  assert.equal(sanitizeHtml(''), '');
});

test('tokenizeQuestionHtml keeps per-word formatting at tokenizeQuestion positions', () => {
  assert.deepEqual(tokenizeQuestionHtml('name this <b>author of <i>Faust</i></b>.'),
    ['name', 'this', '<b>author</b>', '<b>of</b>', '<b><i>Faust</i></b>', '.']);
  // dropped tags, comments, and stray angle brackets still land on the
  // same word positions tokenizeQuestion produces
  const tricky = [
    'plain <span class="x">spanned</span> tail',
    'a<b>b</b>c &nbsp; d <!-- note --> e',
    'x < 5 and <u>under lined</u> words',
    '<em>open only',
  ];
  for (const q of tricky) {
    assert.deepEqual(tokenizeQuestionHtml(q).map((w) => w.replace(/<[^>]*>/g, '')),
      tokenizeQuestion(q).map((w) =>
        w.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
      q);
  }
  assert.deepEqual(tokenizeQuestionHtml(''), []);
});

/* ---------- category stats ---------- */

function catQbj(buzzList, bonuses = {}) {
  // one match: Ann (Alpha) + Bob (Beta) rostered; 3 cycles on tossups 1-3;
  // bonuses[n] = controlled points per part for cycle n's bonus
  return {
    tossups_read: 3,
    match_teams: [
      { team: { name: 'Alpha' }, match_players: [{ player: { name: 'Ann' } }] },
      { team: { name: 'Beta' }, match_players: [{ player: { name: 'Bob' } }] },
    ],
    match_questions: [1, 2, 3].map((n) => ({
      question_number: n,
      tossup_question: { type: 'tossup', question_number: n },
      buzzes: buzzList.filter((b) => b.t === n)
        .map((b) => buzz(b.team, b.player, b.pos, b.value)),
      ...(bonuses[n] ? { bonus: {
        question: { type: 'bonus', question_number: n },
        parts: bonuses[n].map((p) => ({ controlled_points: p })),
      } } : {}),
    })),
    _round: 1,
  };
}
const CATMAP = { rounds: { 1: {
  t: [
    { c: 'Literature', s: 'American Literature' },
    { c: 'Literature', s: 'British Literature' },
    { c: 'Mythology', s: '' },
  ],
  b: [
    { c: 'Literature', s: 'American Literature' },
    { c: 'Science', s: 'Biology' },
    { c: 'Mythology', s: '' },
  ],
} } };

test('categoryStats credits only the players who buzzed', () => {
  const entries = [{ round: 1, room: 'R1', qbj: catQbj([
    { t: 1, team: 'Alpha', player: 'Ann', pos: 5, value: 15 },
    { t: 2, team: 'Beta', player: 'Bob', pos: 9, value: -5 },
    { t: 2, team: 'Alpha', player: 'Ann', pos: 20, value: 10 },
    { t: 3, team: 'Alpha', player: 'Ann', pos: 12, value: 0 }, // zeroed non-first wrong buzz
  ]) }];
  const rows = categoryStats(entries, CATMAP);
  const ann = (sub) => rows.find((r) => r.player === 'Ann' && r.sub === sub);
  assert.deepEqual(ann('American Literature'),
    { player: 'Ann', team: 'Alpha', cat: 'Literature', sub: 'American Literature',
      powers: 1, gets: 0, negs: 0, pts: 15 });
  assert.deepEqual(ann('British Literature').pts, 10);
  assert.deepEqual(rows.find((r) => r.player === 'Bob' && r.sub === 'British Literature'),
    { player: 'Bob', team: 'Beta', cat: 'Literature', sub: 'British Literature',
      powers: 0, gets: 0, negs: 1, pts: -5 });
  // no buzz, no row: Bob never appears in Mythology, Ann's zeroed buzz counts nothing
  assert.equal(rows.some((r) => r.cat === 'Mythology'), false);
  // a round missing from the map contributes nothing
  assert.deepEqual(categoryStats([{ round: 2, room: 'R1', qbj: catQbj([]) }], CATMAP), []);
});

test('catPlayerLines filters + aggregates; catBreakdown nests subs', () => {
  const entries = [{ round: 1, room: 'R1', qbj: catQbj([
    { t: 1, team: 'Alpha', player: 'Ann', pos: 5, value: 15 },
    { t: 2, team: 'Alpha', player: 'Ann', pos: 20, value: 10 },
    { t: 3, team: 'Beta', player: 'Bob', pos: 3, value: 10 },
  ]) }];
  const rows = categoryStats(entries, CATMAP);
  const lit = catPlayerLines(rows, 'Literature', '');
  assert.equal(lit[0].player, 'Ann');
  assert.deepEqual(lit[0], { player: 'Ann', team: 'Alpha', powers: 1, gets: 1, negs: 0, pts: 25 });
  assert.equal(lit.some((l) => l.player === 'Bob'), false); // Bob only buzzed on myth
  const amer = catPlayerLines(rows, 'Literature', 'American Literature');
  assert.deepEqual({ powers: amer[0].powers, pts: amer[0].pts }, { powers: 1, pts: 15 });
  const bd = catBreakdown(rows, 'Alpha', 'Ann');
  assert.deepEqual(bd.map((c) => c.cat), ['Literature']); // canonical order, buzzed cats only
  assert.deepEqual(bd[0].line, { powers: 1, gets: 1, negs: 0, pts: 25 });
  assert.deepEqual(bd[0].subs.map((s) => s.sub), ['American Literature', 'British Literature']);
  assert.deepEqual(catBreakdown(rows, 'Beta', 'Bob')[0].subs, []); // Mythology has no subcategory
  assert.ok(catCompare('Literature', 'History') < 0);
  assert.ok(catCompare('Trash', 'Zzz-unknown') < 0);
});

test('categoryTeamStats joins team buzzes + controlled bonuses; catTeamLines does ppb', () => {
  const entries = [{ id: 1, round: 1, room: 'R1', qbj: catQbj([
    { t: 1, team: 'Alpha', player: 'Ann', pos: 5, value: 15 },
    { t: 2, team: 'Beta', player: 'Bob', pos: 9, value: -5 },
    { t: 2, team: 'Alpha', player: 'Ann', pos: 20, value: 10 },
  ], { 1: [10, 10, 0], 2: [0, 10, 0] }) }];
  const rows = categoryTeamStats(entries, CATMAP);
  // bonus 1 (Amer Lit, 20 pts) and bonus 2 (Sci - Biology, 10 pts) both went to Alpha
  assert.deepEqual(rows.find((r) => r.team === 'Alpha' && r.sub === 'American Literature'),
    { team: 'Alpha', cat: 'Literature', sub: 'American Literature',
      powers: 1, gets: 0, negs: 0, pts: 15, bh: 1, bpts: 20 });
  assert.deepEqual(rows.find((r) => r.team === 'Alpha' && r.cat === 'Science'),
    { team: 'Alpha', cat: 'Science', sub: 'Biology',
      powers: 0, gets: 0, negs: 0, pts: 0, bh: 1, bpts: 10 });
  // Beta only negged: no bonus slice
  assert.equal(rows.filter((r) => r.team === 'Beta').every((r) => r.bh === 0), true);
  const all = catTeamLines(rows, '', '');
  assert.deepEqual(all[0], { team: 'Alpha', powers: 1, gets: 1, negs: 0, pts: 25,
    bh: 2, bpts: 30, ppb: 15 });
  assert.deepEqual({ negs: all[1].negs, ppb: all[1].ppb }, { negs: 1, ppb: null });
  // filtering to Literature drops the biology bonus from Alpha's ppb
  const lit = catTeamLines(rows, 'Literature', '');
  assert.deepEqual({ bh: lit[0].bh, bpts: lit[0].bpts, ppb: lit[0].ppb }, { bh: 1, bpts: 20, ppb: 20 });
});

test('cats accept the pre-bonus array map format', () => {
  const legacy = { rounds: { 1: [{ c: 'Literature', s: 'American Literature' }] } };
  const entries = [{ id: 1, round: 1, room: 'R1', qbj: catQbj([
    { t: 1, team: 'Alpha', player: 'Ann', pos: 5, value: 10 },
  ], { 1: [10, 0, 0] }) }];
  assert.equal(categoryStats(entries, legacy)[0].gets, 1);
  // no bonus categories in the old format: tossup side only
  const rows = categoryTeamStats(entries, legacy);
  assert.deepEqual({ gets: rows[0].gets, bh: rows[0].bh }, { gets: 1, bh: 0 });
});

test('dedupeEntries keeps the latest upload per round + team pair', () => {
  const mk = (id, buzzList) => ({ id, round: 1, room: 'R1', qbj: catQbj(buzzList) });
  const older = mk(3, [{ t: 1, team: 'Alpha', player: 'Ann', pos: 5, value: -5 }]);
  const newer = mk(7, [{ t: 1, team: 'Alpha', player: 'Ann', pos: 5, value: 15 }]);
  const deduped = dedupeEntries([newer, older]);
  assert.deepEqual(deduped.map((e) => e.id), [7]); // higher id wins regardless of order
  // the corrected re-export is what reaches the category join
  const rows = categoryStats(deduped, CATMAP);
  assert.deepEqual({ powers: rows[0].powers, negs: rows[0].negs }, { powers: 1, negs: 0 });
  // different rounds never collide
  assert.equal(dedupeEntries([mk(1, []), { ...mk(2, []), round: 2 }]).length, 2);
});

/* ---------- broadcasts ---------- */

// announce.js is a browser view module (it pulls esc from api.js, which
// reads location at import time), so it loads behind a shim. The ordering
// rule inside it is pure, and mirrors the Worker's — the dashboard holds
// the raw list and has to sort it the same way the read surfaces see it.
globalThis.location = globalThis.location || { search: '' };
globalThis.localStorage = globalThis.localStorage || {};
const { annLive } = await import('../app/js/announce.js');

test('annLive drops expired, alerts first then newest first', () => {
  const now = 1_000_000;
  const list = [
    { id: 'old', level: 'note', created: now - 300, expires: now + 100 },
    { id: 'dead', level: 'note', created: now - 100, expires: now - 1 },
    { id: 'new', level: 'note', created: now - 200, expires: now + 100 },
    { id: 'alert', level: 'alert', created: now - 400, expires: now + 100 },
  ];
  assert.deepEqual(annLive(list, now).map((a) => a.id), ['alert', 'new', 'old']);
  assert.equal(list[0].id, 'old'); // input untouched
  // no usable expiry means gone: broadcasts fail closed, same as the Worker
  assert.deepEqual(annLive([{ id: 'x', level: 'note', created: 1 }], now), []);
  assert.deepEqual(annLive(null, now), []);
});

/* ---------- Worker category extraction ---------- */

const { categoryFromMetadata, packetCategories } = await import('../worker/worker.js');

test('categoryFromMetadata: ACF/YAPP forms', () => {
  assert.deepEqual(categoryFromMetadata('History - World, Khang Le'), { c: 'History', s: 'World' });
  assert.deepEqual(categoryFromMetadata('Khang Le, Literature - American'), { c: 'Literature', s: 'American' });
  assert.deepEqual(categoryFromMetadata('Math, Vikram Narasimhan'), { c: 'Science', s: 'Math' });
  assert.equal(categoryFromMetadata('Just An Author'), null);
  assert.equal(categoryFromMetadata(''), null);
  assert.equal(categoryFromMetadata(undefined), null);
});

test('categoryFromMetadata: separator and position variants', () => {
  // en/em dashes read like the spaced hyphen
  assert.deepEqual(categoryFromMetadata('Literature – American'), { c: 'Literature', s: 'American' });
  assert.deepEqual(categoryFromMetadata('History—European'), { c: 'History', s: 'European' });
  // the category segment can sit anywhere in a dash chain
  assert.deepEqual(categoryFromMetadata('Jane Doe - Fine Arts - Opera'), { c: 'Fine Arts', s: 'Opera' });
  // three-part generated metadata keeps the whole tail as the sub
  assert.deepEqual(categoryFromMetadata('Fine Arts - Other Fine Arts - Film'), { c: 'Fine Arts', s: 'Other Fine Arts - Film' });
  // casing is canonicalized on the category, kept on the sub
  assert.deepEqual(categoryFromMetadata('history - european'), { c: 'History', s: 'european' });
  // Pop Culture and Trash land in one bucket
  assert.deepEqual(categoryFromMetadata('Pop Culture - Movies'), { c: 'Trash', s: 'Movies' });
});

test('categoryFromMetadata: vocabulary fallback (abbreviated/odd spellings)', () => {
  const cases = [
    ['Euro Lit, Jane Doe', 'Literature', 'European'],
    ['Jane Doe, Brit Lit', 'Literature', 'British'],
    ['AmHist', 'History', 'American'],
    ['Bio, JW', 'Science', 'Biology'],
    ['Jane Doe - Econ', 'Social Science', 'Economics'],
    ['Theology', 'Religion', ''],
    ['Myth', 'Mythology', ''],
    ['Drama', 'Literature', 'Drama'],
    ['Visual Arts', 'Fine Arts', 'Visual'],
    ['Misc. Academic', 'Other Academic', ''],
    ['TV', 'Trash', 'Television'],
    // two-word spellings beat their one-word cousins ("Earth Sci" vs "Earth")
    ['Earth Sci', 'Science', 'Earth Science'],
  ];
  for (const [meta, c, s] of cases) {
    assert.deepEqual(categoryFromMetadata(meta), { c, s }, meta);
  }
  // surname-shaped vocabulary was left out on purpose: no false positives
  assert.equal(categoryFromMetadata('Jude Law'), null);
  assert.equal(categoryFromMetadata('Chris Rock'), null);
});

test('categoryFromMetadata: bare distribution labels (2026 UG Nats)', () => {
  // the set's full label vocabulary, one label per question
  const cases = [
    ['American History', 'History', 'American'],
    ['European History', 'History', 'European'],
    ['World History', 'History', 'World'],
    ['Any History', 'History', ''],
    ['American Literature', 'Literature', 'American'],
    ['British Literature', 'Literature', 'British'],
    ['European Literature', 'Literature', 'European'],
    ['World Literature', 'Literature', 'World'],
    ['Biology', 'Science', 'Biology'],
    ['Chemistry', 'Science', 'Chemistry'],
    ['Physics', 'Science', 'Physics'],
    ['Other Science', 'Science', 'Other'],
    ['Painting / Sculpture', 'Fine Arts', 'Painting / Sculpture'],
    ['Classical Music', 'Fine Arts', 'Classical Music'],
    ['Other Fine Arts', 'Fine Arts', 'Other'],
    ['Religion', 'Religion', ''],
    ['Mythology', 'Mythology', ''],
    ['Philosophy', 'Philosophy', ''],
    ['Social Science', 'Social Science', ''],
    ['Other', 'Other Academic', ''],
  ];
  for (const [label, c, s] of cases) {
    assert.deepEqual(categoryFromMetadata(label), { c, s }, label);
  }
});

test('packetCategories: metadata-only packets map tossups and bonuses', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    tossups: [
      { question: 'q', answer: 'a', metadata: 'American History' },
      { question: 'q', answer: 'a', metadata: 'Religion' },
      { question: 'q', answer: 'a' },
    ],
    bonuses: [
      { leadin: 'l', metadata: 'Physics' },
      { leadin: 'l', category: 'Literature', subcategory: 'World Literature' },
    ],
  }));
  assert.deepEqual(packetCategories(body, 'Packet 1.json'), {
    t: [{ c: 'History', s: 'American' }, { c: 'Religion', s: '' }, null],
    b: [{ c: 'Science', s: 'Physics' }, { c: 'Literature', s: 'World Literature' }],
  });
  assert.equal(packetCategories(body, 'Packet 1.docx'), null);
});

/* ---------- html stat report ---------- */

console.log('html stat report');

// M1 (Alpha 125, Beta 55) + M2 (Gamma 145, Alpha 55) through the report.
// Alpha: 1-1, 180 pts / 40 TUH -> 90.0 PP20TUH, bonuses 90 pts on 9 heard.
// Gamma: 1-0, 145 / 20 -> 145.0. Beta: 0-1, 55 / 20 -> 55.0.
const REPORT = buildReport({
  name: 'Test Tournament',
  matches: [parseMatch(M1), parseMatch(M2)],
  roster: parseRoster(ROSTER),
});
const page = (name) => REPORT.find((f) => f.name === name).text;
// strip tags -> whitespace-collapsed text, for asserting on rendered rows
const flat = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&mdash;/g, '-').replace(/\s+/g, ' ').trim();

test('report emits YellowFruit six-page set', () => {
  assert.deepEqual(REPORT.map((f) => f.name), [
    'standings.html', 'individuals.html', 'games.html',
    'teamdetail.html', 'playerdetail.html', 'rounds.html',
  ]);
  for (const f of REPORT) {
    assert.match(f.text, /^<HTML>\n<HEAD>/, f.name + ' is a full document');
    assert.match(f.text, /<\/HTML>\s*$/, f.name + ' is closed');
    // every page carries the same nav to the other five
    for (const other of REPORT) assert.ok(f.text.includes(`<a HREF=${other.name}>`));
  }
});

// What a TD uploads to the hsquizbowl.org tournament database: YellowFruit
// saves its report as <prefix>_standings.html etc., and the database wants
// exactly that. Bare filenames are only YF's in-app preview.
test('report with a prefix is named and interlinked like a YellowFruit export', () => {
  const files = buildReport({
    name: 'Test Tournament',
    matches: [parseMatch(M1), parseMatch(M2)],
    roster: parseRoster(ROSTER),
    prefix: 'penn-bowl',
  });
  assert.deepEqual(files.map((f) => f.name), [
    'penn-bowl_standings.html', 'penn-bowl_individuals.html', 'penn-bowl_games.html',
    'penn-bowl_teamdetail.html', 'penn-bowl_playerdetail.html', 'penn-bowl_rounds.html',
  ]);
  const names = new Set(files.map((f) => f.name));
  for (const f of files) {
    const hrefs = [...f.text.matchAll(/HREF=([^\s>#]*\.html)/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 6, f.name + ' has its nav');
    for (const h of hrefs) assert.ok(names.has(h), `${f.name} links to ${h}, which is not in the set`);
  }
});

// The markup is YellowFruit's to the byte (npm run yf-parity compares whole
// pages with YF's own): attributes unquoted, a line break inside each
// generic tag, the top anchor written id=#top, YF's generator line.
test('report pages carry YellowFruit\'s titles, markup and generator line', () => {
  const titles = ['Team Standings', 'Individuals', 'Scoreboard', 'Team Detail', 'Player Detail', 'Round Report'];
  REPORT.forEach((f, i) => {
    assert.ok(f.text.includes(`<title>\n${titles[i]}\n</title>`), f.name);
    assert.ok(f.text.includes(`<h1 id=#top>\n${titles[i]}\n</h1>`), f.name);
    assert.ok(f.text.includes('<table border=0  width=100%>'), f.name);
    assert.ok(!/<meta|<!doctype/i.test(f.text) && f.text.endsWith('</HTML>'), f.name);
    // the nav label stays the short one, as in YF
    assert.ok(f.text.includes('>Standings</a>'), f.name);
    // YF's line; its version number only on the round report
    assert.match(f.text, /Made with <a HREF=\S+ target="_blank">YellowFruit<\/a> (4\.0\.18)?&nbsp;&#x1F34C;<\/div>/, f.name);
    assert.equal(f.text.includes('</a> 4.0.18&nbsp;'), f.name === 'rounds.html', f.name);
    assert.ok(!f.text.includes('qb-td'), f.name);
  });
});

test('standings: YF ordering, win pct, PP20TUH, PPB', () => {
  const rows = flat(page('standings.html'));
  assert.ok(rows.includes('Rank Team W L Pct PP20TUH 15 10 -5 TUH PPB'));
  // Gamma (1.000) above Alpha (.500) above Beta (.000)
  assert.ok(rows.indexOf('Gamma') < rows.indexOf('Alpha'));
  assert.ok(rows.indexOf('Alpha') < rows.indexOf('Beta'));
  // Gamma: 5 correct tossups -> 5 bonuses heard, 80 bonus pts -> 16.00
  assert.ok(rows.includes('1 Gamma 1 0 1.000 145.0 3 2 0 20 16.00'), rows);
  assert.ok(rows.includes('2 Alpha 1 1 0.500 90.0 2 7 2 40 10.00'), rows);
  assert.ok(rows.includes('3 Beta 0 1 0.000 55.0 1 2 2 20 10.00'), rows);
});

test('standings: teams tied on win pct share an "N=" rank', () => {
  // two teams at 0-1 tie for 2nd
  const tied = buildReport({
    name: 'T',
    matches: [parseMatch(M1), parseMatch(modaqMatch({
      round: 2,
      teamA: { name: 'Alpha', bonusPoints: 60, players: [{ name: 'Ann', counts: { 10: 6 } }] },
      teamB: { name: 'Gamma', bonusPoints: 0, players: [{ name: 'Gil', counts: { 10: 1 } }] },
    }))],
    roster: null,
  });
  const rows = flat(tied.find((f) => f.name === 'standings.html').text);
  assert.equal((rows.match(/2=/g) || []).length, 2, rows);
});

test('individuals: fractional GP and PP20TUH, ranked by PP20TUH', () => {
  const rows = flat(page('individuals.html'));
  assert.ok(rows.includes('Rank Player Team GP 15 10 -5 TUH PP20TUH'));
  // Gil: 65 pts / 20 TUH -> 65.00; Ann played both games -> GP 2.0
  assert.ok(rows.includes('1 Gil Gamma 1.0 3 2 0 20 65.00'), rows);
  assert.ok(rows.includes('Ann Alpha 2.0 2 5 1 40'), rows);
  // a player with no tossups heard is omitted entirely
  assert.ok(!rows.includes('Zed'));
});

test('scoreboard: one box score per game, YF score-string titles', () => {
  const html = page('games.html');
  assert.equal((html.match(/class="boxScoreAnchor">/g) || []).length, 2);
  assert.ok(html.includes('<h3 class="boxScoreTitle">\nAlpha 125, Beta 55\n</h3>'));
  assert.ok(html.includes('<h3 class="boxScoreTitle">\nGamma 145, Alpha 55\n</h3>'));
  assert.ok(html.includes('<div id=Round-1>') && html.includes('<div id=Round-2>'));
  // box scores are anchored by the game's YF match id, the .yft's
  assert.ok(html.includes('<div id=Match_1001~AlphaBeta class="boxScoreAnchor">'));
  // (teams in the file's order, not winner first)
  assert.ok(html.includes('<div id=Match_1002~AlphaGamma class="boxScoreAnchor">'));
  assert.ok(html.includes('Round 1 - All Games&nbsp;'));
  // bonus sub-table per game: Alpha heard 6 in M1 for 60 -> 10.00
  assert.ok(flat(html).includes('Bonuses Heard Pts PPB Alpha 6 60 10.00'), flat(html));
});

test('team detail: per-match rows plus a totals footer', () => {
  const rows = flat(page('teamdetail.html'));
  assert.ok(rows.includes('Round Opponent Score 15 10 -5 TUH BHrd BPts PPB'));
  // Alpha's two games, then its totals line
  assert.ok(rows.includes('1 Beta W 125 - 55'), rows);
  assert.ok(rows.includes('2 Gamma L 55 - 145'), rows);
  assert.ok(rows.includes('Total 1-1 2 7 2 40 9 90 10.00'), rows);
  // teams are alphabetical and anchored for the standings links
  assert.ok(page('teamdetail.html').includes('<h2 id=Alpha>\nAlpha\n</h2>'));
  assert.ok(rows.indexOf('Alpha') < rows.indexOf('Beta'));
});

test('player detail: per-match rows keyed by team-player anchor', () => {
  const html = page('playerdetail.html');
  assert.ok(html.includes('<h2 id=Alpha-Ann>\nAnn, Alpha\n</h2>'));
  assert.ok(html.includes('<h2 id=Gamma-Gil>\nGil, Gamma\n</h2>'));
  const rows = flat(html);
  assert.ok(rows.includes('Round Opponent Score GP 15 10 -5 TUH Pts'));
  // Ann: 2 games, 15*2+10*2-5 = 45 then 30 -> 75 total
  assert.ok(rows.includes('Total 2.0 2 5 1 40 75'), rows);
});

test('round report: per-round rates and a tournament total', () => {
  const rows = flat(page('rounds.html'));
  assert.ok(rows.includes('Round Games Pts/Tm/20TUH TU Powered TU Converted Negs/Tm/20TUH PPB'));
  // round 1: 180 pts over 20 TUH, 2 teams -> 90.0; 9 of 20 converted -> 45%
  assert.ok(rows.includes('1 1 90.0 15% 45% 1.5 10.00'), rows);
  // total: 380 pts, 40 TUH -> 95.0
  assert.ok(rows.includes('Total 2 95.0'), rows);
});

test('report links resolve to anchors that exist', () => {
  const anchors = new Map(REPORT.map((f) =>
    [f.name, new Set([...f.text.matchAll(/\bid=#?([^\s>]+)/g)].map((m) => m[1]))]));
  for (const f of REPORT) {
    for (const m of f.text.matchAll(/HREF=([^\s>#]+\.html)#([^\s>]+)/g)) {
      assert.ok(anchors.has(m[1]), f.name + ' links to unknown page ' + m[1]);
      assert.ok(anchors.get(m[1]).has(m[2]),
        `${f.name} links to ${m[1]}#${m[2]}, which has no such anchor`);
    }
  }
});

test('report escapes team and player names', () => {
  const evil = buildReport({
    name: 'T',
    matches: [parseMatch(modaqMatch({
      round: 1,
      teamA: { name: '<script>x</script>', bonusPoints: 0,
        players: [{ name: 'A & B', counts: { 10: 1 } }] },
      teamB: { name: 'Ok', bonusPoints: 0, players: [{ name: 'C', counts: { 10: 1 } }] },
    }))],
    roster: null,
  });
  for (const f of evil) {
    assert.ok(!f.text.includes('<script>'), f.name + ' escapes markup');
    if (f.text.includes('A &')) assert.ok(f.text.includes('A &amp; B'));
  }
});

test('report refuses an empty tournament', () => {
  assert.throws(() => buildReport({ name: 'T', matches: [], roster: null }), /no games/);
});

test('report deduplicates re-uploaded games', () => {
  // same round + same team pair uploaded twice: one box score, 1-0 records
  const a = { ...parseMatch(M1), fileId: 1 };
  const b = { ...parseMatch(M1), fileId: 2 };
  const files = buildReport({ name: 'T', matches: [a, b], roster: null });
  const games = files.find((f) => f.name === 'games.html').text;
  assert.equal((games.match(/class="boxScoreAnchor">/g) || []).length, 1);
  assert.ok(flat(files.find((f) => f.name === 'standings.html').text)
    .includes('1 Alpha 1 0'));
});

/* ---------- buzzpoints password KDF ---------- */

// The Worker's half of this is buzzAllowed, covered by e2e_worker.js; here
// we pin the browser half — the shape the Worker validates, the round trip
// it verifies, and the legacy path old tournaments still take. Derivations
// happen up front because the runner is synchronous.

const KDF_A = await buzzSettings('hunter2');
const KDF_B = await buzzSettings('hunter2');   // same password, fresh salt
const KDF_PARAMS = { kdf: 'pbkdf2', iters: KDF_A.iters, salt: KDF_A.salt };
const TOK_GOOD = await buzzToken('hunter2', KDF_PARAMS);
const TOK_BAD = await buzzToken('hunter3', KDF_PARAMS);
const TOK_LEGACY = await buzzToken('hunter2', null);
const [DIG_GOOD, DIG_BAD] = [await sha256Hex(TOK_GOOD), await sha256Hex(TOK_BAD)];

test('buzzSettings stretches with pbkdf2 and stores only a digest', () => {
  assert.equal(KDF_A.mode, 'password');
  assert.equal(KDF_A.kdf, 'pbkdf2');
  assert.equal(KDF_A.iters, BUZZ_ITERS);
  // worker.js MIN_BUZZ_ITERS — a config below it is rejected outright
  assert.ok(KDF_A.iters >= 100000, 'at or above the Worker floor');
  assert.match(KDF_A.salt, /^[0-9a-f]{24}$/);
  assert.match(KDF_A.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(KDF_A).includes('hunter2'), 'password is not stored');
});

test('the derived key verifies, and only for the right password', () => {
  assert.match(TOK_GOOD, /^[0-9a-f]{64}$/);
  assert.equal(DIG_GOOD, KDF_A.hash);
  assert.notEqual(DIG_BAD, KDF_A.hash);
  assert.ok(!TOK_GOOD.includes('hunter2'), 'the key travels, not the password');
});

test('a fresh salt gives the same password a different hash', () => {
  assert.notEqual(KDF_B.salt, KDF_A.salt);
  assert.notEqual(KDF_B.hash, KDF_A.hash);
});

test('no kdf means the legacy scheme: the token is the password', () => {
  assert.equal(TOK_LEGACY, 'hunter2');
});

/* ---------- archive ---------- */

// The archive is committed data, so it can drift from its manifest in ways
// no unit test would otherwise catch: a capture regenerated without
// updating index.json, a report folder left out of a commit, a manifest
// entry whose files never landed. Check the committed set against itself.

const ARCHIVE_DIR = new URL('../app/archive/', import.meta.url);
const archiveIndex = existsSync(new URL('index.json', ARCHIVE_DIR))
  ? JSON.parse(readFileSync(new URL('index.json', ARCHIVE_DIR), 'utf8'))
  : { tournaments: [] };

// captures are ES modules, so load them before the sync tests run
const captures = new Map();
for (const t of archiveIndex.tournaments) {
  const file = new URL(t.slug + '.js', ARCHIVE_DIR);
  if (existsSync(file)) captures.set(t.slug, (await import(file)).default);
}

test('archive manifest entries are well formed', () => {
  const slugs = new Set();
  for (const t of archiveIndex.tournaments) {
    assert.match(t.slug, /^[a-z0-9-]{3,40}$/, 'slug ' + t.slug);
    assert.ok(!slugs.has(t.slug), 'duplicate slug ' + t.slug);
    slugs.add(t.slug);
    assert.ok(t.name, t.slug + ' has a name');
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/, t.slug + ' date');
  }
  // newest first: the order the archive page lists them in
  const dates = archiveIndex.tournaments.map((t) => t.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'sorted newest first');
});

test('archive captures and report pages are all committed', () => {
  for (const t of archiveIndex.tournaments) {
    assert.ok(captures.has(t.slug), 'missing capture for ' + t.slug);
    for (const p of ['standings.html', 'individuals.html', 'games.html',
      'teamdetail.html', 'playerdetail.html', 'rounds.html']) {
      assert.ok(existsSync(new URL(t.slug + '/' + p, ARCHIVE_DIR)),
        `missing ${t.slug}/${p}`);
    }
  }
});

test('archive captures carry the paths the public page reads', () => {
  for (const [slug, data] of captures) {
    assert.ok(data[`/pub/${slug}`], slug + ' has state');
    assert.ok(data[`/pub/${slug}/bundle`], slug + ' has a bundle');
    // the buzzpoints tab needs packet text, which is never archived
    assert.equal(data[`/pub/${slug}`].buzz, null, slug + ' has buzzpoints off');
    assert.deepEqual(data[`/pub/${slug}`].announce, [], slug + ' has no live broadcasts');
    assert.ok(!data[`/pub/${slug}/qpacket`], slug + ' must not carry packet text');
  }
});

test('archive captures agree with their manifest counts', () => {
  for (const t of archiveIndex.tournaments) {
    const data = captures.get(t.slug);
    const matches = data[`/pub/${t.slug}/bundle`].entries
      .map((e) => ({ ...parseMatch(e.qbj, { filename: e.filename }), fileId: e.id }));
    const games = dedupeMatches(matches);
    assert.equal(games.length, t.games, t.slug + ' games');
    assert.equal(Math.max(...games.map((m) => m.round)), t.rounds, t.slug + ' rounds');
    assert.equal(data[`/pub/${t.slug}`].name, t.name, t.slug + ' name');
  }
});

test('archive captures carry no question text', () => {
  // Same guard tools/archive.mjs applies before writing, re-run on what
  // actually got committed. `notes` is the one long free-text field a
  // match qbj legitimately has.
  for (const [slug, data] of captures) {
    const long = [];
    (function walk(o, path) {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (k === 'notes') continue;
        if (typeof v === 'string' && v.length > 120) long.push(path + '.' + k);
        else if (typeof v === 'object') walk(v, path + '.' + k);
      }
    })(data, slug);
    assert.deepEqual(long, [], slug + ' has unexpected long strings');
  }
});

/* ---------- schedule editing: insert / cell swaps / room columns ---------- */

test('insertRound inserts mid-phase and renumbers', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 4), ROOMS4.slice(0, 2));
  insertRound(s, 0, 0); // after round 1
  const rounds = flatRounds(s);
  assert.equal(rounds.length, 4);
  rounds.forEach((r, i) => assert.equal(r.round, i + 1));
  assert.deepEqual(rounds[1].games.map((g) => [g.a, g.b]), [[null, null], [null, null]]);
  insertRound(s, 0, -1); // at the phase's start
  assert.deepEqual(flatRounds(s)[0].games.map((g) => g.a), [null, null]);
});

test('swapCells trades matches between rooms, rounds, and empty cells', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 6), ROOMS4.slice(0, 3));
  const at = (r, room) => s.phases[0].rounds[r].games.find((g) => g.room === room) || null;
  // same round, two occupied cells: whole matches trade rooms
  const [a0, b0] = [at(0, 0), at(0, 1)];
  swapCells(s, { p: 0, r: 0, room: 0 }, { p: 0, r: 0, room: 1 });
  assert.equal(at(0, 0), b0);
  assert.equal(at(0, 1), a0);
  assert.equal(at(0, 0).room, 0);
  // cross-round swap: matches move between rounds
  const [x, y] = [at(0, 2), at(1, 0)];
  swapCells(s, { p: 0, r: 0, room: 2 }, { p: 0, r: 1, room: 0 });
  assert.equal(at(1, 0), x);
  assert.equal(at(0, 2), y);
  // occupied <-> empty game: the match moves, the empty cell trades back
  insertRound(s, 0, 4);
  const moved = at(0, 0);
  swapCells(s, { p: 0, r: 0, room: 0 }, { p: 0, r: 5, room: 1 });
  assert.equal(at(0, 0).a, null, 'the empty game traded into the old cell');
  assert.equal(at(5, 1), moved);
  assert.equal(moved.room, 1);
  // a truly game-less cell also works: the match just moves there
  s.phases[0].rounds[5].games = s.phases[0].rounds[5].games.filter((g) => g.room !== 0);
  swapCells(s, { p: 0, r: 5, room: 1 }, { p: 0, r: 5, room: 0 });
  assert.equal(at(5, 1), null);
  assert.equal(at(5, 0), moved);
  assert.equal(moved.room, 0);
  // games stay room-sorted
  for (const round of s.phases[0].rounds) {
    const rooms = round.games.map((g) => g.room);
    assert.deepEqual(rooms, [...rooms].sort((p, q) => p - q));
  }
});

test('addRoomCol/removeRoomCol keep teams and shift columns', () => {
  const s = buildSchedule('rr', TEAMS8.slice(0, 6), ROOMS4.slice(0, 3));
  addRoomCol(s, 'Room X');
  assert.equal(s.rooms.length, 4);
  assert.deepEqual(s.rooms[3], { name: 'Room X', bucket: null });
  const round0 = s.phases[0].rounds[0];
  const g1 = round0.games.find((g) => g.room === 1);
  const [ta, tb] = [g1.a, g1.b];
  removeRoomCol(s, 1);
  assert.equal(s.rooms.length, 3);
  assert.ok(round0.byes.includes(ta) && round0.byes.includes(tb), 'teams dropped to byes');
  assert.ok(!round0.games.some((g) => g.a === ta || g.b === tb));
  // the old room 2 column shifted to index 1
  assert.deepEqual([...new Set(round0.games.map((g) => g.room))].sort(), [0, 1]);
});

/* ---------- playoff placeholders: pools, standings, fill ---------- */

test('buildSchedule pools2 records snake-seeded pool membership', () => {
  const s = buildSchedule('pools2', TEAMS8, ROOMS4);
  // snake: seed 1 -> A, 2 -> B, then back (3 -> B, 4 -> A), ...
  assert.deepEqual(s.pools, { A: ['A', 'D', 'E', 'H'], B: ['B', 'C', 'F', 'G'] });
  const rr = buildSchedule('rr', TEAMS8, ROOMS4);
  assert.equal(rr.pools, undefined);
});

test('poolStandings ranks pool members by overall standings', () => {
  const pools = { A: ['A', 'D', 'E', 'H'], B: ['B', 'C', 'F', 'G'] };
  const ranked = ['H', 'B', 'A', 'G', 'D', 'C']; // E and F unranked (no games)
  assert.deepEqual(poolStandings(pools, ranked), {
    A: ['H', 'A', 'D', 'E'],
    B: ['B', 'G', 'C', 'F'],
  });
});

test('fillPlaceholders replaces placeholders from pool finish order', () => {
  const s = buildSchedule('pools2', TEAMS8, ROOMS4);
  assert.ok(hasPlaceholders(s));
  // remember what label sat in every playoff slot
  const want = { A1: 'H', A2: 'A', A3: 'D', A4: 'E', B1: 'B', B2: 'G', B3: 'C', B4: 'F' };
  const expected = [];
  for (const round of s.phases[1].rounds) {
    for (const g of round.games) expected.push([g, 'a', want[g.a.label]], [g, 'b', want[g.b.label]]);
  }
  const filled = fillPlaceholders(s, {
    A: ['H', 'A', 'D', 'E'], B: ['B', 'G', 'C', 'F'],
  });
  assert.ok(filled >= expected.length, 'byes fill too');
  assert.ok(!hasPlaceholders(s));
  for (const [g, side, team] of expected) assert.equal(g[side].team, team);
  assert.deepEqual(validateSchedule(s, TEAMS8), []);
  // an unknown pool letter or missing rank stays a placeholder
  const s2 = buildSchedule('pools2', TEAMS8, ROOMS4);
  const partial = fillPlaceholders(s2, { A: ['H'] });
  assert.ok(partial > 0 && hasPlaceholders(s2));
});

/* ---------- tiebreakers (reader core) ---------- */

const TB_POOL = {
  tossups: [
    { id: 'TU1', from: 'tb.json', question: 'q1', answer: 'Mozart' },
    { id: 'TU2', from: 'tb.json', question: 'q2', answer: 'Krebs' },
  ],
  bonuses: [
    { id: 'B1', from: 'tb.json', leadin: 'l', parts: ['p'], answers: ['x'], values: [10] },
  ],
  uses: [{ q: 'TU1', round: 5, room: 'Room 1', teams: ['Alpha', 'Beta'], at: 1 }],
};

test('normalizeTbPool filters junk and keeps uses', () => {
  const pool = normalizeTbPool(TB_POOL);
  assert.equal(pool.tossups.length, 2);
  assert.equal(pool.bonuses.length, 1);
  assert.equal(pool.uses.length, 1);
  assert.equal(normalizeTbPool({ tossups: [{ id: 'TU1' }] }), null); // no question text
  assert.equal(normalizeTbPool(null), null);
  assert.equal(normalizeTbPool({ tossups: [] }), null);
});

test('tbSelection picks in pool order with matching id lists', () => {
  const pool = normalizeTbPool(TB_POOL);
  // selection order does not matter: pool order rules, so the id lists
  // always line up with where the questions land in the packet
  const sel = tbSelection(pool, new Set(['B1', 'TU1']));
  assert.deepEqual(sel.tu, ['TU1']);
  assert.deepEqual(sel.bo, ['B1']);
  assert.equal(sel.tossups.length, 1);
  assert.equal(sel.tossups[0].question, 'q1');
  assert.equal(sel.tossups[0].id, undefined, 'pool bookkeeping stripped');
  assert.equal(sel.bonuses[0].leadin, 'l');
  const both = tbSelection(pool, ['TU2', 'TU1']);
  assert.deepEqual(both.tu, ['TU1', 'TU2'], 'pool order, not selection order');
  const none = tbSelection(pool, []);
  assert.deepEqual(none, { tossups: [], bonuses: [], tu: [], bo: [] });
  assert.deepEqual(tbSelection(null, ['TU1']), { tossups: [], bonuses: [], tu: [], bo: [] });
});

test('tbUsedIds maps read questions past the base packet', () => {
  const tb = { t: 20, b: 20, tu: ['TU1', 'TU2'], bo: ['B1'] };
  const match = { match_questions: [
    { tossup_question: { question_number: 20 } },                       // regulation
    { tossup_question: { question_number: 21 },                        // TU1 read...
      replacement_tossup_question: { question_number: 22 },            // ...thrown out, TU2 replaces
      bonus: { question: { question_number: 21 } } },                  // B1 awarded
    { tossup_question: { question_number: 22 } },                      // TU2 again: deduped
    { tossup_question: { question_number: 99 } },                      // out of pool range: ignored
  ] };
  assert.deepEqual(tbUsedIds(match, tb), ['TU1', 'TU2', 'B1']);
  assert.deepEqual(tbUsedIds(match, null), []);
  assert.deepEqual(tbUsedIds({}, tb), []);
});

test('combinedUpload carries tb.used when given, omits it otherwise', () => {
  const match = { tossups_read: 21, match_teams: [] };
  const withTb = JSON.parse(combinedUpload(match, 5, '{"cycles":[]}', ['TU1']));
  assert.deepEqual(withTb.tb, { used: ['TU1'] });
  assert.equal(withTb.qbj._round, 5);
  const emptyTb = JSON.parse(combinedUpload(match, 5, null, []));
  assert.deepEqual(emptyTb.tb, { used: [] }, 'empty report still clears an old log');
  const noTb = JSON.parse(combinedUpload(match, 5, null));
  assert.equal(noTb.tb, undefined);
});

test('tbPanelRows merges tossups and bonuses with their uses', () => {
  const rows = tbPanelRows(normalizeTbPool(TB_POOL));
  assert.deepEqual(rows.map((r) => r.id), ['TU1', 'TU2', 'B1']);
  assert.equal(rows[0].heard.length, 1);
  assert.deepEqual(rows[0].heard[0].teams, ['Alpha', 'Beta']);
  assert.equal(rows[1].heard.length, 0);
  assert.deepEqual(tbPanelRows(null), []);
});

/* ---------- tricky roster names: commas + quotes survive every consumer ---------- */

test('roster names with commas and quotes round-trip our parser, MODAQ, and .yft', () => {
  const tricky = [
    { name: 'St. John’s "A"', players: ['Robert Smith, Jr.', 'Mary O’Brien'] },
    { name: 'Comma, The Team', players: ['Jean-Luc "JL" Picard'] },
  ];
  const qbj = buildRosterQbj('Tricky Open', tricky);
  assert.deepEqual(parseRoster(qbj), tricky);
  // MODAQ's own registration parser (what read.html feeds the roster into)
  const reg = parseRegistration(JSON.stringify(qbj));
  assert.ok(reg.success, reg.message);
  const teamNames = new Set(reg.value.map((p) => p.teamName));
  const playerNames = new Set(reg.value.map((p) => p.name));
  for (const t of tricky) {
    assert.ok(teamNames.has(t.name), t.name);
    for (const p of t.players) assert.ok(playerNames.has(p), p);
  }
  // .yft serialization stays valid JSON with the names intact
  const m = parseMatch(modaqMatch({ round: 1,
    teamA: { name: tricky[0].name, bonusPoints: 30,
      players: [{ name: tricky[0].players[0], counts: { 10: 2 } }] },
    teamB: { name: tricky[1].name, bonusPoints: 0,
      players: [{ name: tricky[1].players[0], counts: { 10: 1 } }] },
  }));
  const yft = serializeYft({ name: 'Tricky Open', matches: [m], roster: tricky });
  const parsedYft = JSON.parse(yft);
  assert.ok(parsedYft && typeof parsedYft === 'object');
  assert.ok(yft.includes('Robert Smith, Jr.'));
  assert.ok(yft.includes(JSON.stringify(tricky[0].name).slice(1, -1)), 'quotes escaped, name intact');
});

/* ---------- demo tournament (app/js/demo.js + generated fixture) ----------
   The runner is synchronous, so the async demoPub flows run here at top
   level and the test() blocks assert on the collected results. Order
   matters: the upload/advance sequence is stateful (in-memory storage
   shim). */

const { demoPub, reset: demoReset } = await import('../app/js/demo.js');
const demoFixture = (await import('../app/demo/fixture.js')).default;

// The demo must never touch the network — a visitor costs zero Worker
// requests. Any fetch during the flows below fails the run.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('demo flow called fetch()'); };

demoReset();
const demoState0 = await demoPub('/pub/demo');
const demoBundle0 = await demoPub('/pub/demo/bundle');
const demoBucketA = await demoPub('/b/demo');
const demoBucketB = await demoPub('/b/demo-b');
const demoSched = await demoPub('/b/demo/schedule');
const demoPacket7 = await demoPub('/b/demo/packet?round=7');
const demoCats = await demoPub('/pub/demo/cats');
let demoQpacketEarly = null;
try { await demoPub('/pub/demo/qpacket?round=7'); }
catch (e) { demoQpacketEarly = e.message; }

// the TD hub's surface
const demoAdmin0 = await demoPub('/a/demo');
const demoAdminRoster = await demoPub('/a/demo/file?key=' + encodeURIComponent('t/1/roster.qbj'));
const demoAdminSched = await demoPub('/a/demo/file?key=' + encodeURIComponent('t/1/schedule.json'));
const demoAdminPacket = await demoPub('/a/demo/file?key=' + encodeURIComponent('t/1/packet/3.json'));
const demoAdminGame = await demoPub('/a/demo/file?key=' + encodeURIComponent('t/1/file/1'));
let demoAdminWrite = null;
try { await demoPub('/a/demo/roster?name=x.qbj', { method: 'PUT', body: '{}' }); }
catch (e) { demoAdminWrite = e.message; }

// the visitor's game: round 7, Stanford vs Berkeley, uploaded like the
// reader does (combined {qbj, game})
const demoMatch = modaqMatch({ round: 7, tossupsRead: 20,
  teamA: { name: 'Berkeley', bonusPoints: 40,
    players: [{ name: 'Elena', tuh: 20, counts: { 10: 3, '-5': 1 } }] },
  teamB: { name: 'Stanford', bonusPoints: 30,
    players: [{ name: 'Ada', tuh: 20, counts: { 10: 3 } }] },
});
const demoUp1 = await demoPub(
  '/b/demo/upload?round=7&name=Round_7_Berkeley_Stanford.qbtd.json',
  { method: 'POST', body: combinedUpload(demoMatch, 7, null) });
const demoStateAfter = await demoPub('/pub/demo');
const demoQpacketLate = await demoPub('/pub/demo/qpacket?round=7');
// a re-exported game replaces, not double-counts
const demoUp2 = await demoPub(
  '/b/demo/upload?round=7&name=Round_7_Berkeley_Stanford.qbtd.json',
  { method: 'POST', body: combinedUpload(demoMatch, 7, null) });
const demoBundle2 = await demoPub('/pub/demo/bundle');
const demoBad = await demoPub(
  '/b/demo/upload?round=7&name=broken.qbj', { method: 'POST', body: 'not json' });
const demoBucketA2 = await demoPub('/b/demo');

// the TD hub's advance button, then deleting a visitor upload
await demoPub('/a/demo', { method: 'POST', json: { current_round: 8 } });
const demoStateAdv = await demoPub('/pub/demo');
const demoBucketAdv = await demoPub('/b/demo');
await demoPub('/a/demo/files/' + demoUp2.id, { method: 'DELETE' });
const demoAdminAfter = await demoPub('/a/demo');
demoReset();
const demoStateReset = await demoPub('/pub/demo');
globalThis.fetch = realFetch;

test('demo fixture: every game parses and the story holds', () => {
  const matches = demoFixture.entries.map((e) => {
    const m = parseMatch(e.qbj, { filename: e.filename });
    m.room = e.room;
    m.fileId = e.id;
    return m;
  });
  assert.equal(matches.length, 13); // rounds 1-6 + round 7 Room B
  const agg = aggregate(matches, parseRoster(demoFixture.roster));
  const top = agg.teams.slice(0, 2).map((t) => t.name).sort();
  assert.deepEqual(top, ['Berkeley', 'Stanford']);
  for (const t of agg.teams.slice(0, 2)) { assert.equal(t.w, 5); assert.equal(t.l, 1); }
  // round 7 Room A (Stanford vs Berkeley) is the visitor's — not played
  assert.deepEqual(agg.games.filter((g) => g.round === 7).map((g) => g.room), ['Room B']);
  // buzz + category views populate from the same entries
  assert.ok(buzzSummary(dedupeEntries(demoFixture.entries)).length >= 10);
  const cats = categoryStats(dedupeEntries(demoFixture.entries), demoFixture.catmap);
  assert.ok(new Set(cats.map((r) => r.cat)).size >= 8, 'category spread');
});

test('demo fixture: packets are reader-ready and fully categorized', () => {
  // MODAQ's own formatter must accept every string — it THROWS on unknown
  // tags, which is why the exporter converts qbreader's <i> to <em>.
  const { parseFormattedText } = createRequire(import.meta.url)('modaq/src/parser/FormattedTextParser.js');
  const rounds = Object.keys(demoFixture.packets).map(Number);
  assert.equal(rounds.length, 9); // triple round robin, 4 teams
  for (const n of rounds) {
    const p = normalizePacket(demoFixture.packets[n], 'round ' + n + '.json');
    assert.equal(p.tossups.length, 21); // 2022 ACF Winter: 20 + tiebreaker
    assert.equal(p.bonuses.length, 21);
    for (const t of p.tossups) {
      assert.ok(!tokenizeQuestion(t.question).includes('(*)'), 'ACF: no power marks');
      parseFormattedText(t.question, { pronunciationGuideMarkers: ['("', '")'] });
      parseFormattedText(t.answer, { pronunciationGuideMarkers: ['("', '")'] });
    }
    for (const b of p.bonuses) {
      for (const s of [b.leadin, ...b.parts, ...b.answers]) {
        parseFormattedText(s, { pronunciationGuideMarkers: ['("', '")'] });
      }
    }
    const rc = demoCats.rounds[String(n)];
    assert.equal(rc.t.length, 21);
    assert.equal(rc.b.length, 21);
    for (const c of [...rc.t, ...rc.b]) assert.ok(c.c, 'category set');
  }
  // no 15s anywhere in the simulated games either
  for (const e of demoFixture.entries) {
    for (const mq of e.qbj.match_questions) {
      for (const b of mq.buzzes) assert.ok(b.result.value <= 10, 'ACF: no powers scored');
    }
  }
});

test('demo state: mid-tournament, round 7 open in the reader room', () => {
  assert.equal(demoState0.current_round, 7);
  assert.deepEqual(demoState0.buzz_done, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(demoState0.packet_rounds, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(demoState0.files.length, 13);
  assert.equal(demoBundle0.entries.length, 13);
  assert.equal(demoQpacketEarly, 'round in progress');
  assert.equal(demoBucketA.room, 'Room A');
  assert.equal(demoBucketB.room, 'Room B');
  assert.equal(demoBucketA.packets.length, 7); // packets 8-9 stay locked
  assert.equal(demoBucketA.roster, true);
  assert.equal(demoSched.room, demoFixture.readerRoom);
  assert.equal(demoPacket7.tossups.length, 21);
});

test('demo TD hub: detail, blobs, and writes behave like the Worker', () => {
  const t = demoAdmin0.tournament;
  assert.equal(t.slug, 'demo');
  assert.equal(t.published, 1);
  assert.equal(JSON.parse(t.settings).gameFormat, 'acf');
  assert.deepEqual(demoAdmin0.buckets.map((b) => b.secret), ['demo', 'demo-b']);
  assert.equal(demoAdmin0.rounds.length, 9); // the hub sees all packets
  assert.equal(demoAdmin0.files.length, 13);
  assert.deepEqual(parseRoster(demoAdminRoster).map((x) => x.name),
    ['Stanford', 'UIUC', 'ASU', 'Berkeley']);
  assert.equal(demoAdminSched.phases.length, 3); // triple round robin
  assert.equal(demoAdminPacket.tossups.length, 21);
  parseMatch(demoAdminGame, { filename: demoAdmin0.files.find((f) => f.id === 1).filename });
  assert.equal(demoAdminWrite, 'not in the demo');
});

test('demo upload: lands in the bundle and completes round 7', () => {
  assert.equal(demoUp1.error, null);
  assert.equal(demoUp1.kind, 'combined');
  assert.deepEqual(demoStateAfter.buzz_done, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(demoStateAfter.files.length, 14);
  assert.notEqual(demoStateAfter.version, demoState0.version);
  assert.equal(demoQpacketLate.tossups.length, 21, 'buzzpoints packet unlocked');
});

test('demo flow: re-export dedupes, advance works, reset clears', () => {
  assert.ok(demoUp2.id > demoUp1.id);
  assert.equal(demoBundle2.entries.length, 15, 'raw bundle keeps both uploads');
  const matches = demoBundle2.entries.map((e) => {
    const m = parseMatch(e.qbj, { filename: e.filename });
    m.fileId = e.id;
    return m;
  });
  assert.equal(dedupeMatches(matches).length, 14, 'latest upload wins per game');
  assert.ok(demoBad.error, 'unparseable upload is flagged');
  assert.equal(demoBucketA2.uploads.length, 3);
  assert.equal(demoBucketA2.uploads[0].qbj, undefined, 'listing carries no qbj');
  assert.equal(demoStateAdv.current_round, 8, 'advance persists');
  assert.deepEqual(demoStateAdv.packet_rounds, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(demoBucketAdv.packets.length, 8, 'round 8 packet unlocked for mods');
  assert.equal(demoAdminAfter.files.length, 14, 'delete removed one visitor upload');
  assert.equal(demoStateReset.current_round, 7, 'reset restores the live round');
  assert.equal(demoStateReset.files.length, 13, 'reset restores the fixture');
});

/* ---------- protests: the reader's report and the hub's rows ---------- */

// MODAQ's Tossup supplies the points at a buzz word; the report mirrors
// GameState.protestSwings per protest.
const { Tossup } = createRequire(import.meta.url)('modaq/src/state/PacketState.js');
const PFMT = {
  powers: [{ marker: '(*)', points: 15 }], negValue: -5, pairTossupsBonuses: true,
  pronunciationGuideMarkers: ['("', '")'],
};
const pBonus = (v = 10) => ({ leadin: 'L', parts: [1, 2, 3].map(() => ({ question: 'q', answer: 'a', value: v })) });
const pStore = (cycles, format = PFMT) => ({ game: {
  packet: {
    tossups: [
      { question: 'Alpha beta gamma (*) delta epsilon zeta.', answer: 'one' },
      { question: 'Eta theta (*) iota kappa.', answer: 'two' },
      { question: 'Lambda mu nu.', answer: 'three' },
    ],
    bonuses: [pBonus(10), pBonus(10), pBonus(5)],
  },
  players: [{ name: 'Ann', teamName: 'Alpha' }, { name: 'Bob', teamName: 'Beta' }],
  gameFormat: format,
  cycles,
} });
const pBuzz = (team, tossupIndex, position) => ({
  tossupIndex, marker: { player: { name: team[0], teamName: team }, position, isLastWord: false },
});
const pParts = (team, ...pts) => pts.map((p) => (p ? { teamName: team, points: p } : { teamName: '', points: 0 }));

test('protestReport: neg, then the other team converts with bonus points', () => {
  const rep = protestReport(pStore([{
    wrongBuzzes: [pBuzz('Alpha', 0, 1)],
    correctBuzz: pBuzz('Beta', 0, 4),
    bonusAnswer: { bonusIndex: 0, receivingTeamName: 'Beta', correctParts: [], parts: pParts('Beta', 10, 10, 0) },
    tossupProtests: [{ teamName: 'Alpha', questionIndex: 0, position: 1, givenAnswer: 'foo', reason: 'prompt me' }],
  }]), null, Tossup);
  assert.equal(rep.length, 1);
  const p = rep[0];
  assert.equal(p.kind, 'tu'); assert.equal(p.q, 1); assert.equal(p.word, 2);
  assert.equal(p.team, 'Alpha'); assert.equal(p.given, 'foo'); assert.equal(p.reason, 'prompt me');
  assert.equal(p.to, 'Alpha'); assert.equal(p.from, 'Beta');
  // in power: 15 back + the 5 neg + the whole 30 bonus
  assert.deepEqual([p.detail.tu, p.detail.neg, p.detail.bonus, p.gain], [15, 5, 30, 50]);
  // MODAQ charges the converter's tossup at the protester's word (15), plus the 20 it earned
  assert.deepEqual([p.detail.oppTu, p.detail.oppBonus, p.loss], [15, 20, 35]);
});

test('protestReport: bounceback points count against the converter', () => {
  const [p] = protestReport(pStore([{
    wrongBuzzes: [pBuzz('Alpha', 0, 5)],
    correctBuzz: pBuzz('Beta', 0, 5),
    bonusAnswer: { bonusIndex: 0, receivingTeamName: 'Beta', correctParts: [], parts: [...pParts('Beta', 10), ...pParts('Alpha', 10), ...pParts('', 0)] },
    tossupProtests: [{ teamName: 'Alpha', questionIndex: 0, position: 5, givenAnswer: '', reason: 'r' }],
  }]), null, Tossup);
  assert.deepEqual([p.detail.tu, p.gain], [10, 45], 'past the power mark: 10');
  assert.deepEqual([p.detail.oppTu, p.detail.oppBonus, p.loss], [10, 0, 10]);
});

test('protestReport: dead tossup — only the protester moves', () => {
  const [p] = protestReport(pStore([
    { correctBuzz: pBuzz('Beta', 0, 4) },
    { wrongBuzzes: [pBuzz('Alpha', 1, 3)],
      tossupProtests: [{ teamName: 'Alpha', questionIndex: 1, position: 3, givenAnswer: 'x', reason: 'r' }] },
  ]), null, Tossup);
  assert.equal(p.q, 2);
  assert.deepEqual([p.detail.tu, p.detail.neg, p.detail.bonus, p.gain, p.loss], [10, 5, 30, 45, 0]);
  assert.equal(p.detail.oppTu, undefined);
});

test('protestReport: a buzz after the question ends carries no neg', () => {
  // MODAQ's words end with an end-of-question marker: position 3 of a
  // three-word tossup is "after the last word", where a wrong answer is 0
  const [p] = protestReport(pStore([{
    wrongBuzzes: [pBuzz('Alpha', 2, 3)],
    tossupProtests: [{ teamName: 'Alpha', questionIndex: 2, position: 3, givenAnswer: 'x', reason: 'r' }],
  }]), null, Tossup);
  assert.deepEqual([p.detail.tu, p.detail.neg, p.gain], [10, 0, 40]);
  const [q] = protestReport(pStore([{
    wrongBuzzes: [pBuzz('Alpha', 2, 2)],
    tossupProtests: [{ teamName: 'Alpha', questionIndex: 2, position: 2, givenAnswer: 'x', reason: 'r' }],
  }]), null, Tossup);
  assert.equal(q.detail.neg, 5, 'on the last word itself the neg still stands');
});

test('protestReport: both teams wrong — MODAQ gives the protester nothing when the other team converted after a neg', () => {
  // the converter (Beta) also negged first: MODAQ's `c` flag drops the "for" side
  const [p] = protestReport(pStore([{
    wrongBuzzes: [pBuzz('Beta', 0, 0), pBuzz('Alpha', 0, 2)],
    correctBuzz: pBuzz('Alpha', 0, 5),
    bonusAnswer: { bonusIndex: 0, receivingTeamName: 'Alpha', correctParts: [], parts: pParts('Alpha', 10, 0, 0) },
    tossupProtests: [{ teamName: 'Beta', questionIndex: 0, position: 0, givenAnswer: 'x', reason: 'r' }],
  }]), null, Tossup);
  assert.equal(p.gain, 0);
  assert.deepEqual([p.to, p.from, p.loss], ['Beta', 'Alpha', 15 + 10]);
});

test('protestReport: unpaired bonuses follow conversions and thrown-out bonuses', () => {
  const rep = protestReport(pStore([
    { correctBuzz: pBuzz('Beta', 0, 4) },                       // uses bonus 0
    { thrownOutBonuses: [{ questionIndex: 1 }],                  // bonus 1 thrown out
      wrongBuzzes: [pBuzz('Alpha', 1, 3)],
      tossupProtests: [{ teamName: 'Alpha', questionIndex: 1, position: 3, givenAnswer: '', reason: 'r' }] },
  ], { ...PFMT, pairTossupsBonuses: false }), null, Tossup);
  assert.equal(rep[0].detail.bonus, 15, 'bonus 2 (3 x 5) is next');
});

test('protestReport: bonus-part protests', () => {
  const rep = protestReport(pStore([{
    correctBuzz: pBuzz('Beta', 0, 4),
    bonusAnswer: { bonusIndex: 0, receivingTeamName: 'Beta', correctParts: [], parts: pParts('Beta', 10, 0, 0) },
    bonusProtests: [
      { teamName: 'Beta', questionIndex: 0, partIndex: 2, givenAnswer: 'LMS', reason: 'accept' },
      { teamName: 'Alpha', questionIndex: 0, partIndex: 1, givenAnswer: '', reason: 'bounceback' },
      { teamName: 'Beta', questionIndex: 9, partIndex: 0, givenAnswer: '', reason: 'no such bonus' },
    ],
  }]), null, Tossup);
  assert.equal(rep.length, 2);
  assert.deepEqual([rep[0].kind, rep[0].q, rep[0].part, rep[0].to, rep[0].from, rep[0].gain, rep[0].loss], ['b', 1, 3, 'Beta', 'Alpha', 10, 0]);
  assert.deepEqual([rep[1].part, rep[1].to, rep[1].from, rep[1].gain, rep[1].loss], [2, 'Alpha', 'Beta', 0, 10]);
});

test('protestReport: legacy persisted shapes (negBuzz, correctParts)', () => {
  const [p] = protestReport(pStore([{
    negBuzz: pBuzz('Alpha', 0, 1),
    correctBuzz: pBuzz('Beta', 0, 4),
    bonusAnswer: { bonusIndex: 0, receivingTeamName: 'Beta', correctParts: [{ index: 0, points: 10 }, { index: 1, points: 10 }] },
    tossupProtests: [{ teamName: 'Alpha', questionIndex: 0, position: 1, givenAnswer: 'foo', reason: 'r' }],
  }]), null, Tossup);
  assert.deepEqual([p.gain, p.loss], [50, 35]);
});

test('protestReport: tolerates junk and falls back to the reader format', () => {
  assert.deepEqual(protestReport(null, PFMT, Tossup), []);
  assert.deepEqual(protestReport({ game: {} }, PFMT, Tossup), []);
  const s = pStore([{ tossupProtests: [{ teamName: 'Alpha', questionIndex: 7, position: 1, reason: 'r' },
    { teamName: 'Alpha', questionIndex: 0, position: 'x', reason: 'r' }] }]);
  assert.deepEqual(protestReport(s, null, Tossup), [], 'missing tossup / bad position skipped');
  const noFmt = pStore([{ wrongBuzzes: [pBuzz('Alpha', 0, 1)],
    tossupProtests: [{ teamName: 'Alpha', questionIndex: 0, position: 1, reason: 'r' }] }], null);
  assert.deepEqual(protestReport(noFmt, null, Tossup), [], 'no format anywhere');
  assert.equal(protestReport(noFmt, PFMT, Tossup)[0].gain, 50, 'reader format fills in');
  assert.deepEqual(protestReport(noFmt.game, PFMT, Tossup).length, 1, 'a bare game works too');
});

test('protestsFromNotes: MODAQ\'s two note templates', () => {
  const notes = 'Tossup protest on tossup #3. Team "St. John\'s "A"" protested because of this reason: "said "Juárez", got prompt".\n'
    + 'Bonus protest on bonus #12. Team "UCLA" protested part 2 because of this reason: "LMS".\n'
    + 'Tossup protest on tossup #1. Team "UCLA" protested because of this reason: "x".';
  const ps = protestsFromNotes(notes);
  assert.deepEqual(ps.map((p) => [p.kind, p.q, p.part, p.team]),
    [['tu', 1, undefined, 'UCLA'], ['tu', 3, undefined, 'St. John\'s "A"'], ['b', 12, 2, 'UCLA']]);
  assert.equal(ps[1].reason, 'said "Juárez", got prompt');
  assert.equal(ps[0].gain, undefined, 'no swing from a note');
  assert.deepEqual(protestsFromNotes(undefined), []);
});

test('protestRows: newest upload per game, rulings keyed by game + question, corrected detection', () => {
  const sum = (teams, score, protests) => JSON.stringify({ teams, score, protests });
  const tu7 = { kind: 'tu', q: 7, team: 'UIUC', word: 41, given: 'J', reason: 'r', to: 'UIUC', from: 'ASU', gain: 45, loss: 30, detail: { tu: 10, neg: 5, bonus: 30, oppTu: 10, oppBonus: 20 } };
  const b12 = { kind: 'b', q: 12, part: 2, team: 'UCLA', given: '', reason: 'r', to: 'UCLA', from: 'Caltech', gain: 10, loss: 0, detail: { part: 10 } };
  const noteOnly = { kind: 'tu', q: 3, team: 'Alpha', given: '', reason: 'r' };
  const tu7b = { ...tu7, from: 'Berkeley' };
  const files = [
    { id: 41, bucket_id: 2, round: 5, kind: 'combined', error: null, created: 1000, summary: sum(['UIUC', 'ASU'], [275, 280], [tu7]) },
    { id: 42, bucket_id: 3, round: 5, kind: 'combined', error: null, created: 1100, summary: sum(['Caltech', 'UCLA'], [340, 215], [b12]) },
    { id: 26, bucket_id: 2, round: 3, kind: 'combined', error: null, created: 500, summary: sum(['UIUC', 'Berkeley'], [225, 230], [tu7b]) },
    { id: 30, bucket_id: 2, round: 3, kind: 'combined', error: null, created: 900, summary: sum(['Berkeley', 'UIUC'], [240, 235], [tu7b]) },
    { id: 12, bucket_id: 1, round: 1, kind: 'qbj', error: null, created: 100, summary: sum(['Alpha', 'Beta'], [60, 10], [noteOnly]) },
    { id: 13, bucket_id: 1, round: 1, kind: 'qbj', error: 'bad', created: 120, summary: null },
    { id: 14, bucket_id: 1, round: 2, kind: 'other', error: null, created: 130, summary: null },
  ];
  const key = rulingKey(3, ['UIUC', 'Berkeley'], tu7);
  assert.equal(key, '3/tu7/Berkeley/UIUC');
  assert.equal(rulingKey(3, ['Berkeley', 'UIUC'], tu7), key, 'team order does not matter');
  assert.equal(rulingKey(5, ['a/b', 'c'], b12), '5/b12.2/a%2Fb/c');
  const rulings = { [key]: { r: 'upheld', note: 'fix it', at: 700 }, '5/b12.2/Caltech/UCLA': { r: 'denied', note: '', at: 1200 } };
  const { rows, byFile } = protestRows(files, rulings, (b) => 'Room ' + b);
  assert.deepEqual(rows.map((r) => [r.file.id, r.ruling]),
    [[41, 'open'], [12, 'open'], [42, 'denied'], [30, 'upheld'], [26, 'upheld']],
    'open first, then ruled, then the ruled history of superseded uploads');
  const r26 = rows.find((r) => r.file.id === 26);
  assert.deepEqual([r26.superseded, r26.corrected, r26.score], [true, true, [225, 230]],
    'a superseded upload keeps its ruled protest, on the score it was ruled on');
  // ...but an unruled protest on a superseded upload is gone with it
  const gone = protestRows(files, {}, () => 'x').rows;
  assert.deepEqual(gone.map((r) => r.file.id).sort(), [12, 30, 41, 42]);
  const r30 = rows.find((r) => r.file.id === 30);
  assert.equal(r30.corrected, true, 'file 30 landed after the ruling at 700');
  assert.equal(r30.note, 'fix it');
  assert.deepEqual([r30.upheld, r30.flips], [[210, 280], true]);
  const r41 = rows.find((r) => r.file.id === 41);
  assert.deepEqual([r41.room, r41.upheld, r41.flips, r41.known], ['Room 2', [320, 250], true, true]);
  const r42 = rows.find((r) => r.file.id === 42);
  assert.deepEqual([r42.upheld, r42.flips, r42.corrected], [[340, 225], false, false]);
  const r12 = rows.find((r) => r.file.id === 12);
  assert.deepEqual([r12.known, r12.flips], [false, false]);
  assert.deepEqual(byFile.get(26), { n: 1, open: 0, superseded: true });
  assert.deepEqual(byFile.get(41), { n: 1, open: 1, superseded: false });
  assert.deepEqual(byFile.get(42), { n: 1, open: 0, superseded: false });
  assert.equal(byFile.has(13), false);
  assert.deepEqual(swingLines(r41), ['+45 UIUC: 5 neg back, 10 tossup, 30 bonus', '−30 ASU: 10 tossup, 20 bonus']);
  assert.deepEqual(swingLines(r42), ['+10 UCLA: bonus part']);
  assert.match(swingLines(r12)[0], /Swing unknown/);
  assert.equal(qLabel(b12), 'B 12, part 2');
  // a tied game: any swing matters
  assert.equal(projectUpheld({ teams: ['A', 'B'], score: [200, 200], protests: [] }, { to: 'B', from: 'A', gain: 0, loss: 10 }).flips, true);
});

/* ---------- set-wide stats (setstats.js) ---------- */

// One game as a round-shard entry: a 2-tossup packet, `buzzes` a list of
// [tossup, team, player, word, value], `bonus` = [bonus number, points]
// for the team whose correct buzz earned it.
function setGame(id, round, a, b, buzzes, bonus) {
  const counts = (team) => {
    const out = {};
    for (const [, tm, pl, , v] of buzzes) {
      if (tm !== team) continue;
      out[pl] = out[pl] || {};
      out[pl][v] = (out[pl][v] || 0) + 1;
    }
    return out;
  };
  const mt = (team) => ({
    team: { name: team },
    bonus_points: bonus && buzzes.some(([, tm, , , v]) => tm === team && v > 0) ? bonus[1] : 0,
    match_players: Object.entries(counts(team)).map(([name, c]) => ({
      player: { name }, tossups_heard: 2,
      answer_counts: Object.entries(c).map(([v, n]) => ({ number: n, answer: { value: Number(v) } })),
    })),
  });
  return {
    id, round, room: 'Room ' + id, filename: 'g' + id + '.qbj',
    qbj: {
      tossups_read: 2, _round: round, match_teams: [mt(a), mt(b)],
      match_questions: [1, 2].map((n) => {
        const mine = buzzes.filter(([t]) => t === n);
        const right = mine.find(([, , , , v]) => v > 0);
        return {
          question_number: n, tossup_question: { question_number: n },
          buzzes: mine.map(([, tm, pl, word, v]) => ({
            team: { name: tm }, player: { name: pl }, buzz_position: { word_index: word }, result: { value: v } })),
          ...(right && bonus ? { bonus: { question: { question_number: bonus[0] },
            parts: [{ controlled_points: bonus[1] }, { controlled_points: 0 }, { controlled_points: 0 }] } } : {}),
        };
      }),
    },
  };
}

// Packet 1 has two versions: v2 swapped its two tossups and reworded
// what is now T2 (question 1: rev 2). Question ids say which is which.
const SET_CATMAP = { packets: { 1: {
  1: { t: [{ c: 'History', s: 'American' }, { c: 'Science', s: 'Physics' }], b: [{ c: 'History', s: 'American' }],
    q: { t: [[1, 1], [2, 1]], b: [[3, 1]] } },
  2: { t: [{ c: 'Science', s: 'Physics' }, { c: 'History', s: 'American' }], b: [{ c: 'Science', s: 'Physics' }],
    q: { t: [[2, 1], [1, 2]], b: [[4, 1]] } },
} } };

// Two sites with the SAME team names; site B ran packet 1 on the fixed
// version — and as its round 3, not its round 1. Site C has not
// finished its round.
const SITE_A = buildSite({ id: 1, label: 'North', vmap: { 1: [1, 1] }, done: [1] }, [
  setGame(1, 1, 'Team A', 'Team B', [[1, 'Team A', 'Ann', 10, 15], [2, 'Team B', 'Bob', 30, -5], [2, 'Team A', 'Ann', 40, 10]], [1, 10]),
]);
const SITE_B = buildSite({ id: 2, label: 'South', vmap: { 3: [1, 2] }, done: [3] }, [
  setGame(7, 3, 'Team A', 'Team B', [[1, 'Team B', 'Bea', 20, 10]], [1, 30]),
]);
const SITE_C = buildSite({ id: 3, label: 'East', vmap: { 1: [1, 2], 2: null }, done: [] }, [
  setGame(9, 1, 'Team C', 'Team D', [[1, 'Team C', 'Cy', 5, 15]], [1, 20]),
]);

test('buildSite: parses, dedupes re-uploads inside one site only', () => {
  const again = buildSite({ id: 1, label: 'North', vmap: {}, done: [] }, [
    setGame(1, 1, 'Team A', 'Team B', [[1, 'Team A', 'Ann', 10, 15]], [1, 10]),
    setGame(4, 1, 'Team B', 'Team A', [[1, 'Team A', 'Ann', 10, 10]], [1, 10]),
  ]);
  assert.equal(again.entries.length, 1);
  assert.equal(again.entries[0].id, 4);
  const errors = [];
  const bad = buildSite({ id: 5, label: 'West' }, [{ id: 1, filename: 'x.qbj', qbj: { match_teams: [] } }], errors);
  assert.equal(bad.matches.length, 0);
  assert.match(errors[0], /^West · x\.qbj: /);
});

test('setStandings: same team name at two sites stays two rows', () => {
  const s = setStandings([SITE_A, SITE_B]);
  const teamAs = s.teams.filter((t) => t.name === 'Team A');
  assert.deepEqual(teamAs.map((t) => t.site).sort(), ['North', 'South']);
  assert.equal(teamAs.find((t) => t.site === 'North').w, 1);
  assert.equal(teamAs.find((t) => t.site === 'South').l, 1);
  assert.deepEqual(s.sites.map((x) => [x.label, x.teams, x.games]), [['North', 2, 1], ['South', 2, 1]]);
  // ranked by PP20TUH across sites, not by record
  assert.ok(s.teams[0].pp20tuh >= s.teams[1].pp20tuh);
  assert.deepEqual(s.values, [15, 10, -5]);
  const ann = s.players.find((pl) => pl.name === 'Ann');
  assert.equal(ann.site, 'North');
  assert.equal(ann.points, 25);
});

test('setCategories: each site reads the packet version it played', () => {
  const c = setCategories([SITE_A, SITE_B], SET_CATMAP);
  // tossup 1 was History at North (v1) but Science at South (v2)
  const ann = c.players.filter((r) => r.player === 'Ann');
  assert.deepEqual(ann.map((r) => [r.cat, r.powers, r.gets]).sort(), [['History', 1, 0], ['Science', 0, 1]]);
  const bea = c.players.find((r) => r.player === 'Bea');
  assert.deepEqual([bea.cat, bea.site, bea.gets], ['Science', 'South', 1]);
  // bonus 1 likewise: History at North, Science at South
  const southBonus = c.teams.find((r) => r.site === 'South' && r.bh);
  assert.deepEqual([southBonus.cat, southBonus.bpts], ['Science', 30]);

  const sci = c.questions.find((q) => q.cat === 'Science');
  // Science heard: North T2 (neg then get), South T1 (get)
  assert.deepEqual([sci.heard, sci.powers, sci.gets, sci.negs, sci.dead], [2, 0, 2, 1, 0]);
  const hist = c.questions.find((q) => q.cat === 'History');
  // History heard: North T1 (power), South T2 (dead)
  assert.deepEqual([hist.heard, hist.powers, hist.dead], [2, 1, 1]);
});

test('setCategories: a TD\'s own packet contributes nothing', () => {
  const own = buildSite({ id: 8, label: 'Own', vmap: { 1: null }, done: [1] },
    [setGame(2, 1, 'X', 'Y', [[1, 'X', 'Xi', 3, 15]], [1, 30])]);
  const c = setCategories([own], SET_CATMAP);
  assert.deepEqual([c.players.length, c.teams.length, c.questions.length], [0, 0, 0]);
});

test('setCatLines / setQuestionLines: filtered, per site, canonical order', () => {
  const c = setCategories([SITE_A, SITE_B], SET_CATMAP);
  const sci = setCatLines(c.players, 'Science', '', 'player');
  assert.deepEqual(sci.map((l) => [l.player, l.site, l.pts]), [['Ann', 'North', 10], ['Bea', 'South', 10], ['Bob', 'North', -5]]);
  const teams = setCatLines(c.teams, '', '', 'team');
  // Team B buzzed at both sites: two lines, never one merged
  assert.deepEqual(teams.filter((l) => l.team === 'Team B').map((l) => l.site).sort(), ['North', 'South']);
  // sites are told apart by mirror id, not by label: two mirrors both
  // called "Online" keep their same-named teams on separate lines
  const twin = setCategories([{ ...SITE_A, label: 'Online' }, { ...SITE_B, label: 'Online' }], SET_CATMAP);
  assert.equal(setCatLines(twin.teams, '', '', 'team').filter((l) => l.team === 'Team B').length, 2);
  assert.deepEqual(setQuestionLines(c.questions, '').map((l) => l.name), ['History', 'Science']);
  const subs = setQuestionLines(c.questions, 'Science');
  assert.deepEqual(subs.map((l) => [l.name, l.heard, l.ppb]), [['Physics', 2, 30]]);
});

test('setQuestionPlays: a question keeps its plays across versions, rounds and rewording', () => {
  const index = setQuestionPlays([SITE_A, SITE_B, SITE_C], SET_CATMAP);
  // question 2 (Science): North's T2 on v1, South's T1 on v2 — same wording, so ONE group
  const q2 = index.get('q2');
  assert.deepEqual([...q2.revs.keys()], [1]);
  assert.equal(q2.revs.get(1).heard, 2);
  assert.deepEqual(q2.revs.get(1).buzzes.map((b) => [b.player, b.room]),
    [['Bea', 'South · Room 7'], ['Bob', 'North · Room 1'], ['Ann', 'North · Room 1']]);
  assert.deepEqual(q2.revs.get(1).homes.map((h) => [h.p, h.v, h.pos]), [[1, 1, 2], [1, 2, 1]]);
  // question 1 (History) was reworded: North's power sits on rev 1, South heard rev 2 (dead)
  const q1 = index.get('q1');
  assert.deepEqual([...q1.revs.keys()].sort(), [1, 2]);
  assert.equal(q1.revs.get(1).buzzes[0].player, 'Ann');
  assert.deepEqual([q1.revs.get(2).heard, q1.revs.get(2).buzzes.length], [1, 0]);
  // East is mid-round: nothing of it counts yet
  assert.ok(![...index.values()].some(({ revs }) => [...revs.values()].some((g) => g.buzzes.some((b) => b.player === 'Cy'))));
  // bonuses follow the same identities: v1's bonus (q3) and v2's (q4) are different questions
  assert.equal(index.get('q3').revs.get(1).results[0].total, 10);
  assert.equal(index.get('q4').revs.get(1).results[0].total, 30);
});

test('setPacketRows: the current packet, each question with every play of it', () => {
  const index = setQuestionPlays([SITE_A, SITE_B], SET_CATMAP);
  const rows = setPacketRows(index, SET_CATMAP, 1, 2);
  assert.deepEqual(rows.map((r) => r.kind + r.pos), ['t1', 'b1', 't2']);
  const [t1, b1, t2] = rows;
  // T1 = question 2, unedited: both sites' plays on one wording
  assert.deepEqual([t1.ident, t1.heard, t1.same.heard, t1.others.length], ['q2', 2, 2, 0]);
  // T2 = question 1 reworded: South's play is on this wording, North's power on the earlier one
  assert.deepEqual([t2.ident, t2.rev, t2.heard, t2.same.heard], ['q1', 2, 2, 1]);
  assert.deepEqual(t2.others.map((g) => [g.rev, g.buzzes[0].player, g.homes[0].p, g.homes[0].v, g.homes[0].pos]),
    [[1, 'Ann', 1, 1, 1]]);
  assert.deepEqual([b1.ident, b1.heard], ['q4', 1]);
});

test('setBuzzNav / setEarlierRows: questions no current packet holds stay reachable', () => {
  const index = setQuestionPlays([SITE_A, SITE_B], SET_CATMAP);
  const nav = setBuzzNav(index, SET_CATMAP, { 1: 2 });
  assert.deepEqual(nav.packets, [1]);
  // v1's bonus (q3) is not in v2: it lives on under the version that had it
  assert.deepEqual(nav.earlier, [[1, 1]]);
  const rows = setEarlierRows(index, SET_CATMAP, { 1: 2 }, 1, 1);
  assert.deepEqual(rows.map((r) => [r.kind + r.pos, r.ident]), [['b1', 'q3']]);
});

test('setQuestionTable / setBonusLines: one line per question, bonus parts ranked by conversion', () => {
  const index = setQuestionPlays([SITE_A, SITE_B], SET_CATMAP);
  const { tossups, bonuses } = setQuestionTable(index, SET_CATMAP, { 1: 2 });
  const q1 = tossups.find((t) => t.ident === 'q1');
  // History at its current home (packet 1 v2 T2); heard at both sites on two wordings; North's power
  assert.deepEqual([q1.cat, q1.home.pos, q1.heard, q1.powers, q1.gets, q1.dead, q1.wordings], ['History', 2, 2, 1, 1, 1, 2]);
  assert.equal(q1.avgWord, 11); // on the wording most rooms heard (both heard once: the first group wins)
  const q2 = tossups.find((t) => t.ident === 'q2');
  assert.deepEqual([q2.cat, q2.heard, q2.gets, q2.negs], ['Science', 2, 2, 1]);
  // North's bonus (the fixture reads it after both of its correct buzzes): 10 on
  // part 1 both times; South's bonus is another question, converted for 30
  const b3 = bonuses.find((b) => b.ident === 'q3');
  assert.deepEqual([b3.cat, b3.heard, b3.ppb, b3.dist, b3.ranked], ['History', 2, 10, [0, 2, 0, 0], [2, 0, 0]]);
  const lines = setBonusLines(bonuses, '');
  assert.deepEqual(lines.map((l) => [l.name, l.bonuses, l.heard, l.ppb, l.easy, l.mid, l.hard]),
    [['History', 1, 2, 10, 1, 0, 0], ['Science', 1, 1, 30, 1, 0, 0]]);
  assert.deepEqual(setBonusLines(bonuses, 'Science').map((l) => [l.name, l.dist]), [['Physics', [0, 0, 0, 1]]]);
});

test('setQuestionPlays: a version nobody matched stands alone', () => {
  const bare = { packets: { 1: { 1: SET_CATMAP.packets[1][1], 2: { t: [], b: [] } } } };
  const index = setQuestionPlays([SITE_A, SITE_B], bare);
  assert.ok(index.has('u1.2.t1'));
  assert.equal(index.get('q2').revs.get(1).heard, 1); // South's play of it is not claimed
  const nav = setBuzzNav(index, bare, { 1: 2 });
  assert.deepEqual([nav.packets, nav.earlier], [[1], [[1, 1]]]);
  assert.deepEqual(setPacketRows(index, bare, 1, 2).map((r) => r.ident), ['u1.2.t1', 'u1.2.b1', 'u1.2.t2']);
});

test('setBuzzSummary: finished set rounds only, tagged by site', () => {
  const rows = setBuzzSummary([SITE_A, SITE_B, SITE_C]);
  assert.deepEqual(rows.map((r) => [r.player, r.site]), [['Ann', 'North'], ['Bea', 'South'], ['Bob', 'North']]);
  assert.equal(rows[0].correct, 2);
});

/* ---------- question identity across packet versions (qmatch.js) ---------- */

// Distinct questions share a giveaway formula and nothing else, as real
// ones do: each body is its own run of words.
const body = (n, from, to) => Array.from({ length: to - from }, (_, i) => `clue${n}x${from + i}`).join(' ');
const TU = (n, extra = '') => ({
  question: `This <b>author</b> ${body(n, 0, 12)} ${extra}${body(n, 12, 30)}. (*) For 10 points, name this writer ${body(n, 30, 34)}.`,
  answer: `<b><u>Author ${n}</u></b> [accept Writer ${n}]` });
const BN = (n) => ({ leadin: `Answer these about topic ${n}.`, parts: [`Part one of ${n}`, `Part two of ${n}`, `Part three of ${n}`],
  answers: [`A${n}`, `B${n}`, `C${n}`] });
const pkt = (tossups, bonuses = []) => packetQuestions({ tossups, bonuses });

test('matchPacket: a first upload numbers its questions', () => {
  const m = matchPacket(null, 1, pkt([TU(1), TU(2)], [BN(1)]));
  assert.deepEqual(m.q, { t: [[1, 1], [2, 1]], b: [[3, 1]] });
  assert.ok(m.report.every((r) => r.isNew && !r.edited && !r.from));
  assert.deepEqual(m.ledger.questions[2].at, [1, 2]);
  assert.equal(matchSummary(m, 1), 'all 3 questions new');
});

test('matchPacket: unchanged, reworded, reordered, new and dropped in one re-upload', () => {
  const v1 = matchPacket(null, 1, pkt([TU(1), TU(2), TU(3)], [BN(1)]));
  // T1 and T2 swap, the old T1 gains a clause, T3 is replaced, the bonus is untouched
  const v2 = matchPacket(v1.ledger, 1, pkt([TU(2), TU(1, 'and its servants '), TU(9)], [BN(1)]));
  assert.deepEqual(v2.q, { t: [[2, 1], [1, 2], [5, 1]], b: [[4, 1]] });
  const by = Object.fromEntries(v2.report.map((r) => [r.kind + r.pos, r]));
  assert.deepEqual([by.t1.edited, by.t1.from], [false, [1, 2]]);
  assert.deepEqual([by.t2.edited, by.t2.rev, by.t2.from], [true, 2, [1, 1]]);
  assert.equal(by.t3.isNew, true);
  assert.deepEqual([by.b1.isNew, by.b1.edited, by.b1.from], [false, false, null]);
  assert.deepEqual(v2.dropped, [{ kind: 't', id: 3, was: [1, 3] }]);
  assert.equal(v2.ledger.questions[3].at, null);
  assert.equal(matchSummary(v2, 1), '1 unchanged · 1 reworded (T2) · 2 in a new position · 1 new (T3) · 1 no longer in the set');
  // the input ledger is not touched
  assert.equal(v1.ledger.questions[1].revs.length, 1);
});

test('matchPacket: a question keeps its id when it moves to another packet, in either upload order', () => {
  const p1 = matchPacket(null, 1, pkt([TU(1), TU(2)]));
  const p2 = matchPacket(p1.ledger, 2, pkt([TU(3), TU(4)]));
  // repacketize: question 2 goes to packet 2. Upload the receiving packet first...
  const into = matchPacket(p2.ledger, 2, pkt([TU(3), TU(4), TU(2)]));
  assert.deepEqual(into.q.t, [[3, 1], [4, 1], [2, 1]]);
  assert.deepEqual(into.report[2].from, [1, 2]);
  assert.equal(matchSummary(into, 2), '2 unchanged · 1 moved in (T3 from packet 1 T2)');
  const outOf = matchPacket(into.ledger, 1, pkt([TU(1)]));
  assert.deepEqual(outOf.dropped, []); // it already lives in packet 2
  // ...or the packet it left first: it is dropped, then recognized on arrival
  const left = matchPacket(p2.ledger, 1, pkt([TU(1)]));
  assert.deepEqual(left.dropped.map((d) => d.id), [2]);
  const arrived = matchPacket(left.ledger, 2, pkt([TU(3), TU(4), TU(2)]));
  assert.deepEqual([arrived.q.t[2], arrived.report[2].from, arrived.report[2].isNew], [[2, 1], [1, 2], false]);
});

test('matchPacket: wording is what MODAQ indexes — markup and answerlines are not', () => {
  const v1 = matchPacket(null, 1, pkt([TU(1)]));
  const restyled = { ...TU(1), question: TU(1).question.replace('<b>author</b>', '<u>AUTHOR,</u>'), answer: 'Author 1 [or anything]' };
  assert.deepEqual(matchPacket(v1.ledger, 1, pkt([restyled])).q.t, [[1, 1]]);
  // dropping the power mark shifts every later word index: a new wording
  const unpowered = { ...TU(1), question: TU(1).question.replace('(*) ', '') };
  const m = matchPacket(v1.ledger, 1, pkt([unpowered]));
  assert.deepEqual([m.q.t, m.report[0].edited], [[[1, 2]], true]);
  // reverting to the first wording is the first wording again
  assert.deepEqual(matchPacket(m.ledger, 1, pkt([TU(1)])).q.t, [[1, 1]]);
});

test('matchPacket: same answer but a rewritten question is a new question; back-fills leave places alone', () => {
  const v1 = matchPacket(null, 1, pkt([TU(1)]));
  const rewritten = { question: 'A wholly different set of clues about something else entirely, with nothing shared. For 10 points, who?', answer: TU(1).answer };
  const m = matchPacket(v1.ledger, 1, pkt([rewritten]));
  assert.deepEqual([m.q.t, m.report[0].isNew], [[[2, 1]], true]);
  // two tossups on one subject share words, not phrasing: never one question
  const sibling = { question: `This author ${body(7, 0, 30)}. For 10 points, name this writer ${body(1, 30, 34)}.`, answer: 'Someone Else' };
  assert.equal(matchPacket(v1.ledger, 2, pkt([sibling])).report[0].isNew, true);
  const back = matchPacket(m.ledger, 1, pkt([TU(1)]), false);
  assert.deepEqual(back.q.t, [[1, 1]]);
  assert.deepEqual([back.ledger.questions[1].at, back.ledger.questions[2].at, back.dropped], [null, [1, 1], []]);
});

test('assignQuestion: the editor overrides a match, and the ledger follows', () => {
  const p1 = matchPacket(null, 1, pkt([TU(1), TU(2)]));
  // a rewrite the matcher could not recognize came in as a new question 3...
  const rewritten = { question: `Entirely ${body(5, 0, 30)}. For 10 points, name this writer ${body(1, 30, 34)}.`, answer: TU(1).answer };
  const v2 = matchPacket(p1.ledger, 1, pkt([rewritten, TU(2)]));
  assert.deepEqual(v2.q.t, [[3, 1], [2, 1]]);
  // ...and the editor says T1 is question 1 after all
  const fixed = assignQuestion(v2.ledger, 1, pkt([rewritten, TU(2)]), v2.q, 't', 1, 1);
  assert.deepEqual(fixed.q.t, [[1, 2], [2, 1]]);
  assert.deepEqual(fixed.ledger.questions[1].at, [1, 1]);
  assert.equal(fixed.ledger.questions[1].revs.length, 2);
  assert.equal(fixed.ledger.questions[3].at, null); // the false new question sits nowhere now
  // the other way: split what the matcher merged
  const split = assignQuestion(fixed.ledger, 1, pkt([rewritten, TU(2)]), fixed.q, 't', 2, null);
  assert.deepEqual(split.q.t[1], [4, 1]);
  assert.equal(split.ledger.questions[2].at, null);
  assert.throws(() => assignQuestion(fixed.ledger, 1, pkt([rewritten, TU(2)]), fixed.q, 'b', 1, 1));
  const choices = ledgerChoices(split.ledger, 't');
  assert.deepEqual(choices.map((c) => [c.id, !!c.at]), [[1, true], [4, true], [2, false], [3, false]]);
  assert.equal(choices[0].label, 'Author 1');
});

/* ---------- parse review (packetcheck.js) ---------- */

test('checkPacket: lays a packet out for a reviewer and flags what looks off', () => {
  const good = { tossups: [TU(1), TU(2)], bonuses: [BN(1), BN(2)] };
  good.tossups.forEach((t) => { t.category = 'History'; });
  const r = checkPacket(good);
  assert.equal(r.count, 0);
  assert.deepEqual([r.tossups[0].n, r.tossups[1].n, r.bonuses[1].n], [1, 2, 2]);
  assert.deepEqual([r.tossups[0].answer, r.tossups[0].words > 30, r.tossups[0].power], ['Author 1', true, true]);
  assert.equal(checkPacket({ tossups: [{ ...TU(1), answer: '<b><u>kite</u></b>s [accept x]' }] }).tossups[0].answer, 'kites');
  assert.match(r.tossups[0].head, /^This author clue1x0/);
  assert.match(r.tossups[0].tail, /clue1x33\.$/);
  assert.deepEqual(r.bonuses[1].answers, ['A2', 'B2', 'C2']);

  const bad = { tossups: [
    { question: 'Too short. For 10 points, what?', answer: 'x', category: 'History' },
    { question: TU(3).question + ' ANSWER: leaked ' + TU(4).question, answer: TU(1).answer },
    { question: TU(1).question, answer: TU(1).answer },
  ], bonuses: [
    { leadin: '', parts: ['[10] still marked', 'ok part here yes'], answers: ['a', 'b', 'c'], values: [10, 10] },
  ] };
  const b = checkPacket(bad);
  assert.deepEqual(b.tossups[0].warnings, ['very short (6 words)']);
  assert.ok(b.tossups[1].warnings.includes('"ANSWER:" inside the question text'));
  assert.ok(b.tossups[1].warnings.some((w) => /power marks/.test(w)));
  assert.deepEqual(b.bonuses[0].warnings.sort(), [
    '2 parts', '3 answers for 2 parts', 'no lead-in', 'part 1 still carries its "[10]" marker'].sort());
  assert.ok(b.warnings.includes('3 tossups but 1 bonuses'));
  assert.ok(b.warnings.some((w) => /share an answerline \(Author 1\)/.test(w)));
  assert.ok(b.warnings.some((w) => /2 tossups without category data/.test(w)));
  assert.equal(b.count, b.warnings.length + b.tossups.flatMap((t) => t.warnings).length + b.bonuses[0].warnings.length);
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));

