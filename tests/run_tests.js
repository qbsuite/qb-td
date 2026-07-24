// Engine test suite: ModaQ qbj parsing, stats aggregation, .yft generation
// (validated with a port of YellowFruit's own parse requirements), zip
// structure. Run: node tests/run_tests.js

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseMatch, parseRoster, roundFromFilename, guessRound, parseRosterLines, buildRosterQbj } from '../app/engine/qbj.js';
import { aggregate, dedupeMatches } from '../app/engine/stats.js';
import { buildYft } from '../app/engine/yft.js';
import { makeZip, readZip } from '../app/engine/zip.js';
import { roundRobinRounds, crossRounds, assignRooms, allFormats, formatsFor, buildSchedule, slotAt, setSlot, swapSlots, addRound, removeRound, validateSchedule, roomIndexForBucket, roomRounds, gameForRoom, flatRounds } from '../app/engine/schedule.js';

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

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
