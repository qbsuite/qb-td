// Engine test suite: ModaQ qbj parsing, stats aggregation, .yft generation
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
import { roundRobinRounds, crossRounds, assignRooms, allFormats, formatsFor, buildSchedule, slotAt, setSlot, swapSlots, moveGame, addRound, removeRound, validateSchedule, roomIndexForBucket, roomRounds, gameForRoom, flatRounds, roundIntake } from '../app/engine/schedule.js';
import { matchBuzzes, roundTossupBuzzes, buzzSummary, tokenizeQuestion, matchBonuses, roundBonuses, mainAnswerHtml, dedupeEntries } from '../app/engine/buzz.js';
import { categoryStats, categoryTeamStats, catPlayerLines, catTeamLines, catBreakdown, catCompare } from '../app/engine/cats.js';

// MODAQ's actual registration parser (CJS module inside the package) — the
// roster builder's output must satisfy it, since read.html feeds the
// roster straight into the embedded MODAQ.
const { parseRegistration } = createRequire(import.meta.url)('modaq/src/qbj/QBJ.js');
import { normalizePacket, groupTeams, pickTeams, matchFilenames, combinedUpload, withRound, resolveGameFormat, PRESET_FORMATS, cleanOverrides, effectiveFormat, formatOverridesFrom, parsePowersText, powersText, metaKey, gameKey, parseMeta, storeIntact, gameMetas, staleGameKeys, roundRows } from '../app/js/read_core.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1; }
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

test('parses a ModaQ match', () => {
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

test('matchFilenames follow the ModaQ convention', () => {
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
  assert.deepEqual(categoryFromMetadata('Math, Vikram Narasimhan'), { c: 'Math', s: '' });
  assert.equal(categoryFromMetadata('Just An Author'), null);
  assert.equal(categoryFromMetadata(''), null);
  assert.equal(categoryFromMetadata(undefined), null);
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
    assert.match(f.text, /^<html>/, f.name + ' is a full document');
    assert.match(f.text, /<\/html>\s*$/, f.name + ' is closed');
    // every page carries the same nav to the other five
    for (const other of REPORT) assert.ok(f.text.includes(`href="${other.name}"`));
  }
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
  assert.equal((html.match(/class="boxScoreAnchor"><\/div>/g) || []).length, 2);
  assert.ok(html.includes('<h3 class="boxScoreTitle">Alpha 125, Beta 55</h3>'));
  assert.ok(html.includes('<h3 class="boxScoreTitle">Gamma 145, Alpha 55</h3>'));
  assert.ok(html.includes('id="Round-1"') && html.includes('id="Round-2"'));
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
  assert.ok(page('teamdetail.html').includes('<h2 id="Alpha">'));
  assert.ok(rows.indexOf('Alpha') < rows.indexOf('Beta'));
});

test('player detail: per-match rows keyed by team-player anchor', () => {
  const html = page('playerdetail.html');
  assert.ok(html.includes('<h2 id="Alpha-Ann">Ann, Alpha</h2>'));
  assert.ok(html.includes('<h2 id="Gamma-Gil">Gil, Gamma</h2>'));
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
    [f.name, new Set([...f.text.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))]));
  for (const f of REPORT) {
    for (const m of f.text.matchAll(/href="([^"#]+\.html)#([^"]+)"/g)) {
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
  assert.equal((games.match(/class="boxScoreAnchor"><\/div>/g) || []).length, 1);
  assert.ok(flat(files.find((f) => f.name === 'standings.html').text)
    .includes('1 Alpha 1 0'));
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
