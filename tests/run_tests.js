// Engine test suite: MODAQ qbj parsing, stats aggregation, .yft generation
// (validated with a port of YellowFruit's own parse requirements), zip
// structure. Run: node tests/run_tests.js

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseMatch, parseRoster, roundFromFilename, guessRound, parseRosterLines, buildRosterQbj, teamMarks,
  rosterNameMap, renameMatch, carryFormerNames, forfeitQbj, resultOf, rosterForExport } from '../app/engine/qbj.js';
import { aggregate, dedupeMatches } from '../app/engine/stats.js';
import { buildYft, yfStages } from '../app/engine/yft.js';
import { buildReport, reportData } from '../app/engine/report.js';
import { reportSrcdoc, mountReport, reportPlace } from '../app/js/reportframe.js';
import { makeZip, readZip } from '../app/engine/zip.js';
import { parseDocxQuestions } from '../app/engine/docxq.js';
import { roundRobinRounds, crossRounds, assignRooms, allFormats, formatsFor, buildSchedule, slotAt, setSlot, swapSlots, moveGame, addRound, removeRound, validateSchedule, roomIndexForBucket, roomRounds, gameForRoom, flatRounds, roundIntake, roundRooms, insertRound, swapCells, addRoomCol, removeRoomCol, hasPlaceholders, poolStandings, fillPlaceholders, fillReport, prelimProgress, prelimRounds, autoFill, slotText, tagBrackets, bracketRooms, phaseLanes, scheduleChecks, mulberry32, finishedThrough, renameTeams, rosterRenames, removeTeam, poolOf, tradePools, tradesLocked } from '../app/engine/schedule.js';
import { createHash as schedHash } from 'node:crypto';
import { bracketModel, bracketRounds, roomRound, roomBracket, roomIndexOf, followRoomRename, autoAdvance, advanceAll, advanceBracket, slotLabel, liveLayout, bracketRooms as bkRooms } from '../app/engine/brackets.js';
import { serializeYft } from '../app/engine/yft.js';
import { serializeYft3 } from '../app/engine/yft3.js';
import { tiebreakerBuzzes, matchBuzzes, roundTossupBuzzes, buzzSummary, tokenizeQuestion, questionWords, matchBonuses, roundBonuses, mainAnswerHtml, sanitizeHtml, dedupeEntries, sideRounds } from '../app/engine/buzz.js';
import { decodeEntities } from '../app/engine/entities.js';
import { categoryStats, categoryTeamStats, catPlayerLines, catTeamLines, catBreakdown, catCompare,
  categoryQuestionStats, questionLines, categoryQuestions, catOfEntry } from '../app/engine/cats.js';
import { buzzSettings, buzzToken, sha256Hex, sha256HexJs, BUZZ_ITERS } from '../app/js/buzzkey.js';
import { buildScoresheet, teamInitials, catTag } from '../app/engine/scoresheet.js';
import { sheetHtml, exampleSheetHtml } from '../app/js/sheetview.js';
import { buildSite, siteNames, setStandings, setCategories, setCatLines, setQuestionLines, setQuestionPlays, setBuzzNav, setPacketRows, setEarlierRows, setBuzzSummary, setQuestionTable, setBonusLines } from '../app/engine/setstats.js';
import { packetQuestions, matchPacket, matchSummary, assignQuestion, ledgerChoices } from '../app/engine/qmatch.js';
import { checkPacket } from '../app/engine/packetcheck.js';
import { buildPlan, planGroups, rebracketChecks, addFinals, shareRooms, handOk } from '../app/engine/plan.js';
import HDWHITE from '../app/engine/hdwhite.js';
import { finalsSources, finalsProgress, finalsFill, scheduleFinished } from '../app/engine/finals.js';
import { eachLimit } from '../app/js/limit.js';
import { modaqExport, modaqFilenames, qbjTextWithRound, renameModaqTexts } from '../app/engine/modaqfile.js';
import { applyBuzzFix, buzzFixView, lineupGaps } from '../app/engine/buzzfix.js';

// MODAQ's actual registration parser (CJS module inside the package) — the
// roster builder's output must satisfy it, since read.html feeds the
// roster straight into the embedded MODAQ.
const { parseRegistration } = createRequire(import.meta.url)('modaq/src/qbj/QBJ.js');
import { protestReport, protestsFromNotes, protestRows, projectUpheld, rulingKey, swingLines, qLabel, fileSummary } from '../app/js/protests.js';
import { normalizePacket, groupTeams, pickTeams, orderPlayers, matchFilenames, combinedUpload, withRound, resolveGameFormat, PRESET_FORMATS, cleanOverrides, effectiveFormat, formatOverridesFrom, formatKey, DEFAULT_FORMAT, GAME_FORMAT_OPTIONS, parsePowersText, powersText, metaKey, gameKey, parseMeta, storeIntact, gameMetas, staleGameKeys, roundRows, normalizeTbPool, tbSelection, tbUsedIds, tbPanelRows, tbState, tbRecordAdd, tbAddedIds, tbNumbering, tbRemapMatch, readerInsertPoint, addCounts, replaceCheck, afterThrowOut, gameProgress, replaceQuestion, syncReserved, keepsThrownOut, heldBonusText, placeholderBonus, undoReplace, undoTop } from '../app/js/read_core.js';

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

/* ---------- Undergraduate / Division II marks ---------- */

console.log('UG / DII marks');

// Only players are marked, each UG or DII. Alpha: Ann UG, Abe DII, so the
// team is UG (every player UG or DII) and not DII. Beta: its one player
// DII, so the team is DII, and so not UG. The third team: nobody marked.
const UGM = { ug: true, d2: false };
const D2M = { ug: false, d2: true };
const markedTeams = () => {
  const teams = parseRoster(ROSTER).map((t) => ({ name: t.name, players: [...t.players] }));
  teams[0].marks = { Ann: UGM, Abe: D2M };
  teams[1].marks = Object.fromEntries(teams[1].players.map((p) => [p, D2M]));
  return teams;
};
const TRACKS = {
  neither: { trackUG: false, trackDiv2: false },
  ug: { trackUG: true, trackDiv2: false },
  d2: { trackUG: false, trackDiv2: true },
  both: { trackUG: true, trackDiv2: true },
};
const markedRoster = (track) => parseRoster(buildRosterQbj('Open', markedTeams(), track));
const MARK_MATCHES = () => [parseMatch(M1), parseMatch(M2)];
const pageOf = (files, name) => files.find((f) => f.name === name).text;
const hits = (text, re) => (text.match(re) || []).length;
const teamFlags = (roster) => roster.map((t) => [!!t.ug, !!t.d2]);

test('marks: a team is DII when every player is, else UG when every player is UG or DII', () => {
  const both = TRACKS.both;
  assert.deepEqual(teamMarks(['a', 'b'], { a: UGM, b: UGM }, both), { ug: true, d2: false });
  assert.deepEqual(teamMarks(['a', 'b'], { a: UGM, b: D2M }, both), { ug: true, d2: false });
  assert.deepEqual(teamMarks(['a', 'b'], { a: D2M, b: D2M }, both), { ug: false, d2: true }); // DII, not both
  assert.deepEqual(teamMarks(['a', 'b'], { a: UGM }, both), { ug: false, d2: false });
  assert.deepEqual(teamMarks(['a', 'b'], { a: D2M }, both), { ug: false, d2: false });
  assert.deepEqual(teamMarks(['a', 'b'], {}, both), { ug: false, d2: false });
  assert.deepEqual(teamMarks([], {}, both), { ug: false, d2: false });
  // an untracked mark counts for nothing
  assert.deepEqual(teamMarks(['a', 'b'], { a: UGM, b: D2M }, TRACKS.ug), { ug: false, d2: false });
  assert.deepEqual(teamMarks(['a', 'b'], { a: UGM, b: UGM }, TRACKS.ug), { ug: true, d2: false });
  assert.deepEqual(teamMarks(['a', 'b'], { a: D2M, b: D2M }, TRACKS.d2), { ug: false, d2: true });
  assert.deepEqual(teamMarks(['a', 'b'], { a: D2M, b: D2M }, TRACKS.neither), { ug: false, d2: false });
});

test('marks: with neither switch on, the roster file is the one it always was', () => {
  const plain = parseRoster(ROSTER).map((t) => ({ name: t.name, players: [...t.players] }));
  assert.equal(JSON.stringify(buildRosterQbj('Open', markedTeams(), TRACKS.neither)),
    JSON.stringify(buildRosterQbj('Open', plain)));
  assert.equal(JSON.stringify(buildRosterQbj('Open', plain)).includes('YfData'), false);
  const back = markedRoster(TRACKS.neither);
  assert.deepEqual(back, plain);
  assert.deepEqual(back.track, TRACKS.neither);
});

test('marks: a roster round-trips its players\' marks, and its teams follow from them', () => {
  const back = markedRoster(TRACKS.both);
  assert.deepEqual(back.track, TRACKS.both);
  assert.deepEqual(back[0].marks, { Ann: UGM, Abe: D2M });
  assert.deepEqual(teamFlags(back), [[true, false], [false, true], [false, false]]);
  assert.deepEqual(back[2], parseRoster(ROSTER)[2]); // an unmarked team is {name, players}
  // and the file says the same of each team, for YellowFruit to read
  const file = buildRosterQbj('Open', markedTeams(), TRACKS.both).objects[0].registrations.map((r) => r.teams[0].YfData);
  assert.deepEqual(file, [{ isUG: true, isD2: false }, { isUG: false, isD2: true }, undefined]);
});

test('marks: a team cannot be marked by hand, in an entry or in a file', () => {
  const teams = markedTeams();
  teams[2].ug = true; teams[2].d2 = true; // nobody on it is marked
  delete teams[1].marks; teams[1].ug = true;
  assert.deepEqual(teamFlags(parseRoster(buildRosterQbj('Open', teams, TRACKS.both))), [[true, false], [false, false], [false, false]]);
  const qbj = buildRosterQbj('Open', markedTeams(), TRACKS.both);
  qbj.objects[0].registrations[2].teams[0].YfData = { isUG: true, isD2: true };
  qbj.objects[0].registrations[1].teams[0].YfData = { isUG: false, isD2: false };
  assert.deepEqual(teamFlags(parseRoster(qbj)), [[true, false], [false, true], [false, false]]);
});

test('marks: one switch on keeps that mark and drops the other everywhere', () => {
  const ug = markedRoster(TRACKS.ug);
  assert.deepEqual(ug.track, TRACKS.ug);
  assert.deepEqual(ug[0].marks, { Ann: UGM });
  assert.equal(ug[1].marks, undefined); // Beta's players were DII only
  assert.deepEqual(teamFlags(ug), [[false, false], [false, false], [false, false]]); // Abe no longer counts
  assert.equal(JSON.stringify(buildRosterQbj('Open', markedTeams(), TRACKS.ug)).includes('"isD2":true'), false);
  const d2 = markedRoster(TRACKS.d2);
  assert.deepEqual(d2[0].marks, { Abe: D2M });
  assert.deepEqual(teamFlags(d2), [[false, false], [false, true], [false, false]]);
  assert.equal(JSON.stringify(buildRosterQbj('Open', markedTeams(), TRACKS.d2)).includes('"isUG":true'), false);
});

test('marks: an uploaded roster with marks and no switches tracks what it marks', () => {
  const qbj = buildRosterQbj('Open', markedTeams(), TRACKS.both);
  delete qbj.objects[0].YfData;
  assert.deepEqual(parseRoster(qbj).track, TRACKS.both);
  const ugOnly = buildRosterQbj('Open', markedTeams(), TRACKS.ug);
  delete ugOnly.objects[0].YfData;
  assert.deepEqual(parseRoster(ugOnly).track, TRACKS.ug);
});

test('marks: a marked roster still satisfies MODAQ parseRegistration', () => {
  const out = parseRegistration(JSON.stringify(buildRosterQbj('Open', markedTeams(), TRACKS.both)));
  assert.equal(out.success, true, out.message);
  assert.deepEqual(out.value.slice(0, 3).map((p) => p.teamName + '/' + p.name), ['Alpha/Ann', 'Alpha/Abe', 'Beta/Bob']);
});

test('marks: the stat report gains one column per switch, and none with neither', () => {
  const base = buildReport({ name: 'T', matches: MARK_MATCHES(), roster: parseRoster(ROSTER) });
  const cols = (track) => {
    const files = buildReport({ name: 'T', matches: MARK_MATCHES(), roster: markedRoster(track) });
    return {
      files,
      ug: hits(pageOf(files, 'standings.html'), /<abbr title="Undergrad">\nUG\n<\/abbr>/g),
      d2: hits(pageOf(files, 'standings.html'), /<abbr title="Division 2">\nD2\n<\/abbr>/g),
      iug: hits(pageOf(files, 'individuals.html'), /<abbr title="Undergrad">\nUG\n<\/abbr>/g),
      id2: hits(pageOf(files, 'individuals.html'), /<abbr title="Division 2">\nD2\n<\/abbr>/g),
    };
  };
  const neither = cols(TRACKS.neither);
  assert.deepEqual(neither.files, base); // every page, byte for byte
  assert.deepEqual([neither.ug, neither.d2, neither.iug, neither.id2], [0, 0, 0, 0]);
  const ug = cols(TRACKS.ug);
  assert.deepEqual([ug.ug, ug.d2, ug.iug, ug.id2], [1, 0, 1, 0]);
  assert.equal(pageOf(ug.files, 'playerdetail.html').includes('Division II'), false);
  assert.equal(pageOf(ug.files, 'playerdetail.html').includes('font-style: italic">\nUndergraduate\n'), true);
  const d2 = cols(TRACKS.d2);
  assert.deepEqual([d2.ug, d2.d2, d2.iug, d2.id2], [0, 1, 0, 1]);
  assert.equal(pageOf(d2.files, 'teamdetail.html').includes('Undergraduate'), false);
  assert.equal(pageOf(d2.files, 'playerdetail.html').includes('Undergraduate'), false);
  assert.equal(pageOf(d2.files, 'teamdetail.html').includes('font-style: italic">\nDivision II\n'), true);
  const both = cols(TRACKS.both);
  assert.deepEqual([both.ug, both.d2, both.iug, both.id2], [1, 1, 1, 1]);
  // Beta, all DII, is Division II and not Undergraduate; nothing is both
  assert.equal(pageOf(both.files, 'teamdetail.html').includes('font-style: italic">\nDivision II\n'), true);
  assert.equal(pageOf(both.files, 'teamdetail.html').includes('Undergraduate, Division II'), false);
});

test('marks: both .yft files carry exactly the tracked marks', () => {
  const opts = (roster) => ({ name: 'T', matches: MARK_MATCHES(), roster });
  const plain4 = serializeYft(opts(parseRoster(ROSTER)));
  const plain3 = serializeYft3(opts(parseRoster(ROSTER)));
  assert.equal(serializeYft(opts(markedRoster(TRACKS.neither))), plain4);
  assert.equal(serializeYft3(opts(markedRoster(TRACKS.neither))), plain3);
  for (const [key, track] of Object.entries(TRACKS)) {
    const both = track.trackUG && track.trackDiv2;
    const t = buildYft(opts(markedRoster(track))).objects[0];
    assert.equal(t.YfData.trackUG, track.trackUG, key);
    assert.equal(t.YfData.trackDiv2, track.trackDiv2, key);
    const team = (n) => t.registrations.flatMap((r) => r.teams).find((x) => x.name === n);
    assert.deepEqual([team('Alpha').YfData.isUG, team('Alpha').YfData.isD2], [both, false], key);
    assert.deepEqual([team('Beta').YfData.isUG, team('Beta').YfData.isD2], [false, track.trackDiv2], key);
    const ann = team('Alpha').players.find((p) => p.name === 'Ann');
    assert.deepEqual([ann.YfData.isUG, ann.YfData.isD2], [track.trackUG, false], key);
    const abe = team('Alpha').players.find((p) => p.name === 'Abe');
    assert.deepEqual([abe.YfData.isUG, abe.YfData.isD2], [false, track.trackDiv2], key);
    const y3 = JSON.parse(serializeYft3(opts(markedRoster(track))).split('\n')[4]);
    const beta3 = y3.find((x) => x.teamName === 'Beta');
    assert.deepEqual([beta3.teamUGStatus, beta3.teamD2Status], [false, track.trackDiv2], key);
    assert.deepEqual(y3.find((x) => x.teamName === 'Alpha').roster.Abe, { year: '', undergrad: false, div2: track.trackDiv2 }, key);
  }
});

test('marks: aggregate hands the marks to the rows it shows them on', () => {
  const agg = aggregate(MARK_MATCHES(), markedRoster(TRACKS.both));
  const alpha = agg.teams.find((t) => t.name === 'Alpha');
  assert.deepEqual([alpha.ug, alpha.d2], [true, undefined]);
  const abe = agg.players.find((p) => p.name === 'Abe');
  assert.deepEqual([abe.ug, abe.d2], [undefined, true]);
  const plain = aggregate(MARK_MATCHES(), markedRoster(TRACKS.neither));
  assert.deepEqual(plain, aggregate(MARK_MATCHES(), parseRoster(ROSTER)));
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

/* ---------- docxq: the fallback .docx question reader ---------- */

// a minimal Word document: each paragraph a list of [text, 'bui' flags]
// runs; '\n' inside a paragraph is a line break
const docxOf = (paras) => {
  const x = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = ([t, f = '']) => '<w:r>' + (f ? '<w:rPr>' + (f.includes('b') ? '<w:b/>' : '') + (f.includes('i') ? '<w:i/>' : '')
    + (f.includes('u') ? '<w:u w:val="single"/>' : '') + (f.includes('x') ? '<w:b w:val="0"/>' : '') + '</w:rPr>' : '')
    + t.split('\n').map((piece) => `<w:t xml:space="preserve">${x(piece)}</w:t>`).join('<w:br/>') + '</w:r>';
  const body = paras.map((p) => '<w:p><w:pPr><w:jc w:val="left"/></w:pPr>' + (typeof p === 'string' ? [[p]] : p).map(run).join('') + '</w:p>').join('');
  const enc = new TextEncoder();
  return makeZip([
    { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`) },
  ]);
};
const ANS = (t) => [['ANSWER: '], [t, 'bu']];

await testA('docxq: tossups however they are numbered, and a file of bonuses alone', async () => {
  // the three layouts YAPP refuses or reads as nothing
  for (const label of [(i) => '1. ', (i) => `TB${i}. `, (i) => '', (i) => `Tiebreaker ${i}: `, (i) => `${i}) `]) {
    const q = await parseDocxQuestions(docxOf([1, 2, 3].flatMap((i) => [`${label(i)}Tossup ${i} text. For 10 points, name it.`, ANS('answer ' + i), ''])));
    assert.deepEqual(q.tossups, [1, 2, 3].map((i) => ({ question: `Tossup ${i} text. For 10 points, name it.`, answer: `<b><u>answer ${i}</u></b>` })), label(1));
    assert.deepEqual([q.bonuses, q.skipped], [[], []]);
  }
  const b = await parseDocxQuestions(docxOf(['Bonuses', '', '1. Leadin one. For 10 points each:', '[10e] Easy part.', ANS('a'),
    '[10m] Middle part.', ANS('b'), '[10h] Hard part.', ANS('c'), '<Science, Biology>', '',
    '2. Leadin two:', '[10] P1', ANS('d'), '[15] P2', ANS('e')]));
  assert.deepEqual(b.tossups, []);
  assert.deepEqual(b.bonuses, [
    { leadin: 'Leadin one. For 10 points each:', parts: ['Easy part.', 'Middle part.', 'Hard part.'],
      answers: ['<b><u>a</u></b>', '<b><u>b</u></b>', '<b><u>c</u></b>'], values: [10, 10, 10],
      difficultyModifiers: ['e', 'm', 'h'], metadata: 'Science, Biology' },
    { leadin: 'Leadin two:', parts: ['P1', 'P2'], answers: ['<b><u>d</u></b>', '<b><u>e</u></b>'], values: [10, 15] },
  ]);
  assert.deepEqual(b.skipped, []);
});

await testA('docxq: a whole packet, with formatting, line breaks, headings and stray lines', async () => {
  const q = await parseDocxQuestions(docxOf([
    'ACF Fall 2026: Tiebreakers', 'Edited by Someone', 'Tossups', '',
    // power in bold, a title in italics, the answer on a line break in the same paragraph
    [['1. '], ['This author of ', ''], ['Emma', 'i'], [' wrote early clues (*)', 'b'], [' and later ones. For 10 points, name this author of Pride & Prejudice.\nANS'], ['WER: Jane '], ['Austen', 'bu'], [' [accept Jane <Austen>]']],
    '<Literature, British>', '',
    'Note to moderator: read slowly.',
    [['2. Second tossup?', '']], [['ANSWER: ', 'b'], ['x', 'bu'], ['y', 'x']],
    'Bonuses',
    'A bonus leadin with no number. For 10 points each:', '[10] First\nANSWER: one', '[10] Second, which runs', 'onto a second line.', 'ANSWER: two', '[10] Third', 'ANSWER: three',
    'ANSWER: an answer with no question',
    'A trailing line with nothing after it.',
  ]));
  assert.deepEqual(q.tossups, [
    { question: 'This author of <em>Emma</em> <b>wrote early clues (*)</b> and later ones. For 10 points, name this author of Pride &amp; Prejudice.',
      answer: 'Jane <b><u>Austen</u></b> [accept Jane &lt;Austen&gt;]', metadata: 'Literature, British' },
    { question: 'Second tossup?', answer: '<b><u>x</u></b>y' },
  ]);
  assert.deepEqual(q.bonuses, [{ leadin: 'A bonus leadin with no number. For 10 points each:',
    parts: ['First', 'Second, which runs onto a second line.', 'Third'], answers: ['one', 'two', 'three'], values: [10, 10, 10] }]);
  // everything it didn't use is reported, headings aside
  assert.deepEqual(q.skipped, ['ACF Fall 2026: Tiebreakers', 'Edited by Someone', 'Note to moderator: read slowly.',
    'ANSWER: an answer with no question', 'A trailing line with nothing after it.']);
  // the pool takes it as it takes YAPP's JSON
  assert.deepEqual(normalizePacket({ tossups: q.tossups, bonuses: q.bonuses }, 'tb.json').tossups.length, 2);
});

await testA('docxq: not a document, or one with no questions', async () => {
  await assert.rejects(parseDocxQuestions(new TextEncoder().encode('{"tossups":[]}')), /not a \.docx file/);
  await assert.rejects(parseDocxQuestions(makeZip([{ name: 'a.txt', data: new Uint8Array(1) }])), /not a \.docx file/);
  await assert.rejects(parseDocxQuestions(docxOf(['Just a heading', 'and some prose.'])), /no questions found/);
});

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

test('normalizePacket takes a bonus-only packet only when asked (tiebreaker pool uploads)', () => {
  const bonuses = [{ leadin: 'L', parts: ['p'], answers: ['a'], values: [10] }];
  const p = normalizePacket({ bonuses }, 'Spare bonuses.json', { bonusOnly: true });
  assert.deepEqual(p, { tossups: [], bonuses, name: 'Spare bonuses.json' });
  assert.deepEqual(normalizePacket({ tossups: [], bonuses }, 'x.json', { bonusOnly: true }).tossups, []);
  assert.throws(() => normalizePacket({ bonuses }, 'x.json'), /no tossups/);
  assert.throws(() => normalizePacket({ tossups: [], bonuses: [] }, 'x.json', { bonusOnly: true }), /no tossups/);
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

test('orderPlayers puts each team in seating order; the rest keep the roster\'s', () => {
  const pl = (teamName, name) => ({ teamName, name });
  const players = [pl('A', 'a1'), pl('A', 'a2'), pl('A', 'a3'), pl('B', 'b1'), pl('B', 'b2')];
  const names = (ps) => ps.map((p) => p.name).join(' ');
  assert.equal(names(orderPlayers(players, null)), 'a1 a2 a3 b1 b2');
  assert.equal(names(orderPlayers(players, { A: ['a3', 'a1', 'a2'], B: ['b2', 'b1'] })), 'a3 a1 a2 b2 b1');
  // a player the order doesn't name (added to the roster since) goes last
  assert.equal(names(orderPlayers(players, { A: ['a2', 'a1'] })), 'a2 a1 a3 b1 b2');
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
  assert.equal(resolveGameFormat({ gameFormat: 'acf' }, GameFormats), GameFormats.ACFGameFormat);
  // No format picked, or an unrecognized one, is mACF with powers — not
  // MODAQ's UndefinedGameFormat. "No format" used to leave the reader
  // enforcing nothing (999 tossups) and gave the exports no honest
  // regulation count to scale by; DEFAULT_FORMAT is a real rule set.
  assert.equal(resolveGameFormat('', GameFormats), GameFormats.StandardPowersMACFGameFormat);
  assert.equal(resolveGameFormat('nonsense', GameFormats), GameFormats.StandardPowersMACFGameFormat);
  assert.equal(resolveGameFormat({}, GameFormats), GameFormats.StandardPowersMACFGameFormat);
});

test('formatKey: a stored preset wins, anything else is the default', () => {
  assert.equal(formatKey({ gameFormat: 'acf' }), 'acf');
  assert.equal(formatKey({ gameFormat: 'pace' }), 'pace');
  assert.equal(formatKey({}), DEFAULT_FORMAT);
  assert.equal(formatKey({ gameFormat: '' }), DEFAULT_FORMAT);
  assert.equal(formatKey({ gameFormat: 'nonsense' }), DEFAULT_FORMAT);
  assert.equal(formatKey(null), DEFAULT_FORMAT);
  // the option list no longer offers "no format"
  assert.ok(!GAME_FORMAT_OPTIONS.some((o) => o.value === ''));
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
  // no preset: overrides sit on the default preset, mACF with powers.
  // This is the QUARTZ 2026 shape — a TO who only ticked one box and
  // never picked a format — and the reason the number below is 20 and
  // not 999: a tournament always exports an honest regulation count now.
  const d = resolveGameFormat({ formatOverrides: { negValue: 0 } });
  assert.equal(d.negValue, 0);
  assert.equal(d.regulationTossupCount, 20);
  assert.deepEqual(d.powers, PRESET_FORMATS['macf-powers'].powers);
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

test('buildSchedule pools3x2: 22 teams into playoff brackets of 6/6/6/4, pool-mates carried over', () => {
  const teams = Array.from({ length: 22 }, (_, i) => 'Team ' + (i + 1));
  const rooms = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Room ' + (i + 1), bucket: null }));
  const fmt = allFormats(22).find((f) => f.key === 'pools3x2');
  assert.equal(fmt.rounds, 11);
  assert.equal(fmt.roomsNeeded, 11);
  assert.ok(/6\/6\/6\/4/.test(fmt.desc), fmt.desc);
  // one room short: not offered, and not buildable
  assert.ok(!formatsFor(22, 10).some((f) => f.key === 'pools3x2'));
  assert.throws(() => buildSchedule('pools3x2', teams, rooms(10)), /Needs 11 rooms/);

  const s = buildSchedule('pools3x2', teams, rooms(11));
  assert.deepEqual(validateSchedule(s, teams), []);
  assert.deepEqual(scheduleChecks(s), []);
  // prelims are pools3's, game for game
  assert.deepEqual(s.phases[0], buildSchedule('pools3', teams, rooms(11)).phases[0]);
  assert.deepEqual(s.brackets.filter((b) => b.phase === 1).map((b) => b.name),
    ['1st\u20136th place', '7th\u201312th place', '13th\u201318th place', '19th\u201322nd place']);

  const po = s.phases[1];
  assert.deepEqual(po.rounds.map((r) => r.round), [8, 9, 10, 11]);
  // the last bracket skips its pool-mates' game, so it needs three rounds, not four
  assert.deepEqual(po.rounds.map((r) => r.games.length), [11, 11, 10, 9]);
  assert.deepEqual(po.rounds.map((r) => r.byes.map((b) => b.label).sort()), [[], [], ['A7', 'A8'], ['A7', 'A8', 'B7', 'C7']]);
  const met = new Map();
  for (const r of po.rounds) for (const g of r.games) {
    const k = [g.a.label, g.b.label].sort().join(' ');
    met.set(k, (met.get(k) || 0) + 1);
  }
  // a full bracket: every pair from different pools once, pool-mates never
  [['T1', [1, 2]], ['T2', [3, 4]], ['T3', [5, 6]]].forEach(([key, places]) => {
    const members = ['A', 'B', 'C'].flatMap((l) => places.map((n) => l + n));
    for (const x of members) for (const y of members) {
      if (x >= y) continue;
      assert.equal(met.get(x + ' ' + y) || 0, x[0] === y[0] ? 0 : 1, x + ' v ' + y);
    }
    assert.ok(po.rounds.flatMap((r) => r.games).filter((g) => members.includes(g.a.label)).every((g) => g.bracket === key));
  });
  // the short last bracket plays everyone once, except its two pool-mates: their prelim game carries over
  for (const pair of ['A7 B7', 'A7 C7', 'A8 B7', 'A8 C7', 'B7 C7']) assert.equal(met.get(pair), 1, pair);
  assert.equal(met.get('A7 A8'), undefined);

  // brackets keep their own rounds, and the placeholders fill from pool finish
  const m = bracketModel(s);
  assert.ok(m.multi);
  assert.deepEqual(m.phases[1].keys, ['T1', 'T2', 'T3', 'T4']);
  assert.equal(fillPlaceholders(s, s.pools), 2 * (11 * 3 + 9) + 4);
  assert.deepEqual(scheduleChecks(s), []);
  assert.deepEqual(bracketModel(s).phases[1].keys, ['T1', 'T2', 'T3', 'T4']);
});

test('pools x2 formats: every size builds clean, full brackets have no byes', () => {
  for (let n = 9; n <= 36; n++) {
    for (const f of allFormats(n).filter((x) => /x2$/.test(x.key))) {
      const rooms = Array.from({ length: f.roomsNeeded }, (_, i) => ({ name: 'R' + i, bucket: null }));
      const teams = Array.from({ length: n }, (_, i) => 'T' + i);
      const s = buildSchedule(f.key, teams, rooms);
      assert.deepEqual(scheduleChecks(s), [], n + ' ' + f.key);
      assert.equal(s.phases.reduce((a, p) => a + p.rounds.length, 0), f.rounds, n + ' ' + f.key);
      assert.ok(Math.max(...s.phases.flatMap((p) => p.rounds.map((r) => r.games.length))) <= f.roomsNeeded, n + ' ' + f.key);
      const k = Number(f.key[5]);
      const first = s.phases[1].rounds[0];
      if (n % k === 0 && (n / k) % 2 === 0) assert.equal(first.byes.length, 0, n + ' ' + f.key);
      // every bracket, the short last one too, carries pool-mates' prelim game instead of replaying it
      for (const g of s.phases[1].rounds.flatMap((r) => r.games)) assert.notEqual(g.a.label[0], g.b.label[0], n + ' ' + f.key);
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

test('sideRounds keeps one team or player: their buzzes, and a team\'s bonuses', () => {
  const qbj = { ...BUZZ_QBJ,
    match_questions: [
      { question_number: 1,
        tossup_question: { type: 'tossup', question_number: 1 },
        buzzes: [buzz('Beta', 'Bob', 8, -5), buzz('Alpha', 'Ann', 33, 15)],
        bonus: { question: { parts: 3, type: 'bonus', question_number: 1 },
          parts: [{ controlled_points: 10 }, { controlled_points: 0 }, { controlled_points: 10 }] } },
      { question_number: 2,
        tossup_question: { type: 'tossup', question_number: 2 },
        buzzes: [buzz('Alpha', 'Cy', 20, 10)],
        bonus: { question: { parts: 3, type: 'bonus', question_number: 2 },
          parts: [{ controlled_points: 10 }, { controlled_points: 10 }, { controlled_points: 0 }] } },
      { question_number: 3,
        tossup_question: { type: 'tossup', question_number: 3 },
        buzzes: [] },
    ] };
  const entries = [{ round: 1, room: 'R1', qbj }, { round: 2, room: 'R1', qbj }];
  const team = sideRounds(entries, [1], 'Alpha');
  assert.deepEqual(team.map((r) => r.round), [1]);
  assert.deepEqual(team[0].tossups.map((t) => [t.tossup, t.buzzes.map((b) => b.player)]),
    [[1, ['Ann']], [2, ['Cy']]]); // Bob's neg is Beta's, the dead tossup is nobody's
  assert.deepEqual(team[0].tossups.map((t) => t.dead), [false, false]);
  assert.deepEqual(team[0].bonuses.map((b) => [b.bonus, b.results.map((r) => r.total)]), [[1, [20]], [2, [20]]]);
  const ann = sideRounds(entries, [1, 2], 'Alpha', 'Ann');
  assert.deepEqual(ann.map((r) => [r.round, r.tossups.map((t) => t.tossup), r.bonuses.length]),
    [[1, [1], 0], [2, [1], 0]]);
  const beta = sideRounds(entries, [1], 'Beta');
  assert.deepEqual(beta.map((r) => [r.tossups.length, r.bonuses.length]), [[1, 0]]);
  assert.equal(beta[0].tossups[0].dead, false); // Bob negged, but Ann got it in that game
  assert.deepEqual(sideRounds(entries, [1], 'Gamma'), []);
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

test('questionWords numbers words as MODAQ does: tags inside words, guides and power marks skipped, an end marker', () => {
  const ACF = PRESET_FORMATS.acf;
  const POW = PRESET_FORMATS['macf-powers'];
  const plain = (q, f) => questionWords(q, f).words.map((w) => [w.html.replace(/<[^>]*>/g, ''), w.at]);
  // a tag is not a word break: the period stays on "Wedding."
  assert.deepEqual(plain('plays like <em>Blood Wedding</em>.', ACF),
    [['plays', 0], ['like', 1], ['Blood', 2], ['Wedding.', 3]]);
  assert.equal(questionWords('plays like <em>Blood Wedding</em>.', ACF).end, 4);
  // quoted guides, straight or curly, aren't counted; (*) only with powers
  assert.deepEqual(plain('Lorca (\u201clor-kuh\u201d) wrote (*) this ("play")', ACF),
    [['Lorca', 0], ['(\u201clor-kuh\u201d)', null], ['wrote', 1], ['(*)', 2], ['this', 3], ['("play")', null]]);
  assert.deepEqual(plain('wrote (*) this', POW), [['wrote', 0], ['(*)', null], ['this', 1]]);
  // formatting kept per word
  assert.deepEqual(questionWords('<b>for <em>ten</em></b> points', ACF).words.map((w) => w.html),
    ['<b>for</b>', '<em><b>ten</b></em>', 'points']);
  assert.deepEqual(questionWords('', ACF), { words: [], end: 0 });
  // a guide joined to its word: one word, its buzz mark on what comes before the guide
  const dv = questionWords('of Dvo\u0159\u00e1k(\u201cd\u2019VORE-zhahk\u201d).', ACF).words[1];
  assert.equal(dv.at, 1);
  assert.equal(dv.lead, 'Dvo\u0159\u00e1k');
  assert.equal(dv.rest, '<span class="pg">(\u201cd\u2019VORE-zhahk\u201d)</span>.');
  // an encoded no-break space is a space, as MODAQ decodes it: the guide is a word of its own
  assert.deepEqual(plain('of Dvo\u0159\u00e1k&nbsp;(\u201cd\u2019VORE-zhahk\u201d).', ACF),
    [['of', 0], ['Dvo\u0159\u00e1k', 1], ['(\u201cd\u2019VORE-zhahk\u201d).', null]]);
  // references show as the characters they are; brackets one spells out are text, not a tag
  assert.deepEqual(questionWords('see &lt;p&gt; at AT&amp;T, caf&eacute; &copy 2026 &bogus;', ACF).words.map((w) => w.html),
    ['see', '&lt;p&gt;', 'at', 'AT&amp;T,', 'caf\u00e9', '\u00a9', '2026', '&amp;bogus;']);

  // locked against the installed MODAQ, loading the text as its reader
  // does (loadPacket, which decodes references first): the same count and
  // the same word at every index
  const { loadPacket } = createRequire(import.meta.url)('modaq/src/components/PacketLoaderController.js');
  const modaqTossup = (q) => loadPacket({ uiState: { setPacketStatus() {} } }, { tossups: [{ question: q, answer: 'a' }] }).tossups[0];
  const shownText = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const texts = [
    'This composer\u2019s works include a <em>Grand Duo</em> sonata and a <em>Trout</em> quintet.',
    'Theodor N\u00f6ldeke (\u201cnull-DECK-uh\u201d). In a chapter (*) called \u201cThe Confederates,\u201d one (pause) protagonist',
    'a<b>b</b>c &nbsp; d <u>under lined</u> ("guide two") <req>req</req>uired [read slowly] end',
    ' leading space and  double  spaces ("x")  after',
    'Mr.&nbsp;Smith wrote this book. For 10 points, name him.',
    'one&#160;two&#xA0;three&ensp;four (&quot;kai poh CHAY&quot;) &ldquo;five&rdquo; &lt;b&gt;six&lt;/b&gt; seven&lpar;*&rpar; eight',
    'AT&amp;T &amp;nbsp; &copy 2026 &notit; &bogus; &#128; &#xD800; end',
  ];
  for (const f of [ACF, POW, PRESET_FORMATS.pace, PRESET_FORMATS['']]) {
    for (const q of texts) {
      const m = modaqTossup(q).getWords(f).filter((w) => w.canBuzzOn);
      const ours = questionWords(q, f);
      assert.equal(ours.end, m.length - 1, q);
      for (const w of ours.words.filter((x) => x.at !== null)) {
        const mw = m.find((x) => x.wordIndex === w.at);
        assert.equal(shownText(w.html), mw.word.map((sg) => sg.text).join(''), q);
      }
    }
  }
});

test('decodeEntities decodes as he does, which MODAQ decodes packet text with', () => {
  const he = createRequire(import.meta.url)('he');
  // he's own table, read from its source: it exports no list of names
  const src = readFileSync(createRequire(import.meta.url).resolve('he'), 'utf8');
  const names = Object.keys(new Function('return ' + /var decodeMap = (\{.*?\});/s.exec(src)[1])());
  assert.ok(names.length > 2000);
  // every named reference, with and without its semicolon, and run into more text
  for (const n of names) {
    for (const t of [`&${n};`, `&${n}`, `x&${n}y;`, `&${n}=1`]) assert.equal(decodeEntities(t), he.decode(t), t);
  }
  const odd = ['&#0;', '&#65', '&#x41;', '&#X41', '&#128;', '&#x9F;', '&#xD800;', '&#1114112;', '&#99999999999999999999;',
    '&#;', '&#x;', '& amp;', '&&amp;;', '&ampamp;', '&notin;', '&notit;', '&NotNestedLessLess;', '&fjlig;', 'no refs'];
  for (const t of odd) assert.equal(decodeEntities(t), he.decode(t), t);
  // what each reference decodes to can be marked, and nothing else
  assert.equal(decodeEntities('<a> &lt;b&gt; &ltc', (s) => '[' + s + ']'), '<a> [<]b[>] [<]c');
});

test('roundRooms: who plays a round, by bucket link then room name; the rest have a bye', () => {
  const buckets = [{ id: 11, room_name: 'Room 1' }, { id: 12, room_name: 'Room 2' }, { id: 13, room_name: 'Library' }];
  const schedule = {
    rooms: [{ name: 'Room 1', bucket: 11 }, { name: ' library ', bucket: null }, { name: 'Room 2', bucket: 12 }],
    phases: [{ name: 'P', rounds: [
      { round: 1, games: [{ room: 0, a: { team: 'A' }, b: { team: 'B' } }, { room: 1, a: { team: 'C' }, b: { team: 'D' } }], byes: [] },
      // a placeholder game (no second team yet) is no game
      { round: 2, games: [{ room: 2, a: { team: 'A' }, b: null }], byes: [] },
    ] }],
  };
  assert.deepEqual(roundRooms(schedule, 1, buckets).map((r) => [r.name, r.bye]),
    [['Room 1', false], ['Room 2', true], ['Library', false]]);
  assert.deepEqual(roundRooms(schedule, 2, buckets).map((r) => r.bye), [true, true, true]);
  // no such round in the schedule (or no schedule): every room plays
  assert.deepEqual(roundRooms(schedule, 9, buckets).map((r) => r.bye), [false, false, false]);
  assert.deepEqual(roundRooms(null, 1, buckets).map((r) => r.bye), [false, false, false]);
});

const { parseChangelog } = await import('../app/js/changelog.js');
const changelogText = (await import('node:fs')).readFileSync(new URL('../app/changelog.txt', import.meta.url), 'utf8');
test('changelog.txt parses: newest first, every release has changes, every line short', () => {
  const releases = parseChangelog(changelogText);
  assert.ok(releases.length > 0);
  for (let i = 1; i < releases.length; i++) {
    assert.ok(releases[i - 1].iso > releases[i].iso, `out of order: ${releases[i - 1].date} then ${releases[i].date}`);
  }
  for (const r of releases) {
    assert.ok(r.sections.length > 0, r.date + ' has no sections');
    for (const s of r.sections) {
      assert.ok(s.items.length > 0, `${r.date} [ ${s.name} ] is empty`);
      for (const it of s.items) assert.ok(it.length <= 160, `${r.date}: too long for a changelog line: ${it}`);
    }
  }
  assert.throws(() => parseChangelog('Release Notes for 1/2/2026\nstray line'), /can't place/);
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
    { player: 'Ann', team: 'Alpha', cat: 'Literature', sub: 'American Literature', sub2: '',
      powers: 1, gets: 0, negs: 0, bb: 0, pts: 15 });
  assert.deepEqual(ann('British Literature').pts, 10);
  // Ann's 10 came after Beta's neg: a bounceback, counted beside the get, not added to points
  assert.deepEqual({ gets: ann('British Literature').gets, bb: ann('British Literature').bb }, { gets: 1, bb: 1 });
  assert.deepEqual(rows.find((r) => r.player === 'Bob' && r.sub === 'British Literature'),
    { player: 'Bob', team: 'Beta', cat: 'Literature', sub: 'British Literature', sub2: '',
      powers: 0, gets: 0, negs: 1, bb: 0, pts: -5 });
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
  assert.deepEqual(lit[0], { player: 'Ann', team: 'Alpha', powers: 1, gets: 1, negs: 0, bb: 0, pts: 25 });
  assert.equal(lit.some((l) => l.player === 'Bob'), false); // Bob only buzzed on myth
  const amer = catPlayerLines(rows, 'Literature', 'American Literature');
  assert.deepEqual({ powers: amer[0].powers, pts: amer[0].pts }, { powers: 1, pts: 15 });
  const bd = catBreakdown(rows, 'Alpha', 'Ann');
  assert.deepEqual(bd.map((c) => c.cat), ['Literature']); // canonical order, buzzed cats only
  assert.deepEqual(bd[0].line, { powers: 1, gets: 1, negs: 0, bb: 0, pts: 25 });
  assert.deepEqual(bd[0].subs.map((s) => s.sub), ['American Literature', 'British Literature']);
  // Mythology sits under RMPSS, as its subcategory
  assert.deepEqual(catBreakdown(rows, 'Beta', 'Bob').map((c) => [c.cat, c.subs.map((x) => x.sub)]), [['RMPSS', ['Mythology']]]);
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
    { team: 'Alpha', cat: 'Literature', sub: 'American Literature', sub2: '',
      powers: 1, gets: 0, negs: 0, bb: 0, pts: 15, bh: 1, bpts: 20 });
  assert.deepEqual(rows.find((r) => r.team === 'Alpha' && r.cat === 'Science'),
    { team: 'Alpha', cat: 'Science', sub: 'Biology', sub2: '',
      powers: 0, gets: 0, negs: 0, bb: 0, pts: 0, bh: 1, bpts: 10 });
  // Beta only negged: no bonus slice
  assert.equal(rows.filter((r) => r.team === 'Beta').every((r) => r.bh === 0), true);
  const all = catTeamLines(rows, '', '');
  // tossup 2: Beta negged, then Alpha got it: one bounceback for Alpha
  assert.deepEqual(all[0], { team: 'Alpha', powers: 1, gets: 1, negs: 0, bb: 1, pts: 25,
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

test('bouncebacks: any earlier miss by the other team; a power stays a power', () => {
  const entries = [{ id: 1, round: 1, room: 'R1', qbj: catQbj([
    // tossup 1: Bob misses for no penalty, then Ann powers it
    { t: 1, team: 'Beta', player: 'Bob', pos: 3, value: 0 },
    { t: 1, team: 'Alpha', player: 'Ann', pos: 8, value: 15 },
    // tossup 2: a clean get, nobody missed first
    { t: 2, team: 'Beta', player: 'Bob', pos: 30, value: 10 },
  ]) }];
  const rows = categoryStats(entries, CATMAP);
  const ann = rows.find((r) => r.player === 'Ann');
  assert.deepEqual({ powers: ann.powers, bb: ann.bb, pts: ann.pts }, { powers: 1, bb: 1, pts: 15 });
  assert.equal(rows.find((r) => r.player === 'Bob' && r.gets).bb, 0);
  // the zero-point miss itself earns no row of its own
  assert.equal(rows.filter((r) => r.player === 'Bob').length, 1);
});

test('categoryQuestionStats: tossup readings, and bonus difficulty from marks or by rank', () => {
  const MARKED = { rounds: {
    1: { t: CATMAP.rounds[1].t, b: [
      { c: 'Literature', s: 'American Literature', d: 'hem' }, // marked: part 1 is hard
      { c: 'Science', s: 'Biology' },                          // unmarked: ranked
      { c: 'Mythology', s: '', d: 'ee' },                      // malformed marks: ranked
    ] },
  } };
  const game = (id, buzzList, bonuses) => ({ id, round: 1, room: 'R' + id, qbj: {
    ...catQbj(buzzList, bonuses), match_teams: [
      { team: { name: 'T' + id + 'a' }, match_players: [{ player: { name: 'Ann' } }] },
      { team: { name: 'T' + id + 'b' }, match_players: [{ player: { name: 'Bob' } }] },
    ] } });
  const entries = [
    game(1, [
      { t: 1, team: 'Alpha', player: 'Ann', pos: 4, value: 15 },
      { t: 2, team: 'Beta', player: 'Bob', pos: 2, value: -5 },
      { t: 2, team: 'Alpha', player: 'Ann', pos: 9, value: 10 },
      { t: 3, team: 'Alpha', player: 'Ann', pos: 7, value: 10 },
    ], { 1: [0, 10, 10], 2: [0, 10, 0], 3: [10, 10, 10] }),
    game(2, [
      { t: 1, team: 'Alpha', player: 'Ann', pos: 10, value: 10 },
      { t: 2, team: 'Beta', player: 'Bob', pos: 5, value: -5 }, // dead after the neg
      { t: 3, team: 'Beta', player: 'Bob', pos: 6, value: 10 },
    ], { 1: [10, 10, 0], 3: [0, 10, 0] }),
  ];
  const q = categoryQuestionStats(entries, MARKED);
  const t = (sub) => q.tossups.find((r) => r.sub === sub);
  // American Lit tossup: one question, read in both rooms — converted twice,
  // one power, words 5 and 11. Readings never pass for questions: with two
  // rooms, heard is double the question count.
  assert.deepEqual({ ...t('American Literature') }, { cat: 'Literature', sub: 'American Literature', sub2: '',
    questions: 1, heard: 2, conv: 2, powers: 1, negs: 0, words: [5, 11] });
  // British Lit: read twice, converted once (after a neg), negged both times
  assert.deepEqual({ heard: t('British Literature').heard, conv: t('British Literature').conv,
    negs: t('British Literature').negs }, { heard: 2, conv: 1, negs: 2 });
  const b = (cat) => q.bonuses.find((r) => r.cat === cat);
  // marked 'hem': game 1 got parts 2+3 (e, m), game 2 got parts 1+2 (h, e)
  assert.deepEqual({ ...b('Literature') }, { cat: 'Literature', sub: 'American Literature', sub2: '',
    questions: 1, heard: 2, pts: 40, dHeard: 2, e: 2, m: 1, h: 1, marked: 1, ranked: 0 });
  // biology was read once (game 2 had no correct buzz on tossup 2): ranked by
  // its only reading, the converted part is the easy one
  assert.deepEqual({ heard: b('Science').heard, e: b('Science').e, m: b('Science').m,
    h: b('Science').h, ranked: b('Science').ranked }, { heard: 1, e: 1, m: 0, h: 0, ranked: 1 });
  // malformed marks fall back to ranking: part 2 converted twice (easy),
  // part 1 and 3 once each, ties in packet order (part 1 medium)
  assert.deepEqual({ e: b('RMPSS').e, m: b('RMPSS').m, h: b('RMPSS').h,
    dHeard: b('RMPSS').dHeard, ranked: b('RMPSS').ranked, marked: b('RMPSS').marked },
    { e: 2, m: 1, h: 1, dHeard: 2, ranked: 1, marked: 0 });

  // display lines: a category, then its subcategories; filters narrow
  const lines = questionLines(q.tossups, '', '');
  assert.deepEqual(lines.map((l) => [l.cat, l.sub, l.isSub, l.questions, l.heard]), [
    ['Literature', '', false, 2, 4],
    ['Literature', 'American Literature', true, 1, 2],
    ['Literature', 'British Literature', true, 1, 2],
    ['RMPSS', '', false, 1, 2],
    ['RMPSS', 'Mythology', true, 1, 2],
  ]);
  assert.deepEqual(questionLines(q.tossups, 'Literature', 'British Literature').map((l) => [l.sub, l.heard]),
    [['British Literature', 2]]);
  assert.deepEqual(questionLines(q.tossups, 'Literature', '')[0].words, [5, 11, 10]);
  // a subcategory named like its category folds into it
  assert.deepEqual(questionLines([{ cat: 'Geography', sub: 'Geography', heard: 3 }], '', '')
    .map((l) => [l.sub, l.isSub, l.heard]), [['', false, 3]]);
});

test('catOfEntry: RMPSS is a parent, an unread tag is Unknown, and it sorts last', () => {
  assert.deepEqual(catOfEntry({ c: 'Beliefs', s: '' }), { cat: 'RMPSS', sub: 'Beliefs', sub2: '' });
  assert.deepEqual(catOfEntry({ c: 'Social Science', s: 'Economics' }), { cat: 'RMPSS', sub: 'Social Science', sub2: 'Economics' });
  // Beliefs' halves sit beside Philosophy, not under Beliefs
  assert.deepEqual(catOfEntry({ c: 'Beliefs', s: 'Narratives' }), { cat: 'RMPSS', sub: 'Narratives', sub2: '' });
  assert.deepEqual(catOfEntry({ c: 'Beliefs', s: 'Practices' }), { cat: 'RMPSS', sub: 'Practices', sub2: '' });
  assert.deepEqual(catOfEntry({ c: 'Literature', s: 'American' }), { cat: 'Literature', sub: 'American', sub2: '' });
  assert.deepEqual(catOfEntry({ u: 'Visual Culture' }), { cat: 'Unknown', sub: 'Visual Culture', sub2: '' });
  assert.equal(catOfEntry(null), null);
  assert.deepEqual(['Unknown', 'Trash', 'Zoology', 'RMPSS', 'Literature'].sort(catCompare),
    ['Literature', 'RMPSS', 'Trash', 'Zoology', 'Unknown']);
});

test('questionLines and catBreakdown: an RMPSS category\'s own split is a third level', () => {
  const rows = [
    { cat: 'RMPSS', sub: 'Beliefs', sub2: 'Narratives', questions: 2, heard: 4 },
    { cat: 'RMPSS', sub: 'Beliefs', sub2: 'Practices', questions: 1, heard: 2 },
    { cat: 'RMPSS', sub: 'Philosophy', sub2: '', questions: 1, heard: 2 },
  ];
  const at = (cat, sub, sub2) => questionLines(rows, cat, sub, sub2).map((l) => [l.level, l.sub2 || l.sub || l.cat, l.questions]);
  assert.deepEqual(at('', '', ''), [[0, 'RMPSS', 4], [1, 'Beliefs', 3], [2, 'Narratives', 2], [2, 'Practices', 1], [1, 'Philosophy', 1]]);
  // a picked subcategory keeps its split under it; a picked split is alone
  assert.deepEqual(at('RMPSS', 'Beliefs', ''), [[1, 'Beliefs', 3], [2, 'Narratives', 2], [2, 'Practices', 1]]);
  assert.deepEqual(at('RMPSS', 'Beliefs', 'Practices'), [[2, 'Practices', 1]]);
  const line = (pts) => ({ powers: 0, gets: pts / 10, negs: 0, bb: 0, pts });
  const bd = catBreakdown([
    { team: 'A', player: 'Ann', cat: 'RMPSS', sub: 'Beliefs', sub2: 'Narratives', ...line(20) },
    { team: 'A', player: 'Ann', cat: 'RMPSS', sub: 'Beliefs', sub2: 'Practices', ...line(30) },
    { team: 'A', player: 'Ann', cat: 'RMPSS', sub: 'Philosophy', sub2: '', ...line(10) },
  ], 'A', 'Ann');
  assert.deepEqual(bd[0].subs.map((x) => [x.sub, x.line.pts, x.subs.map((y) => [y.sub, y.line.pts])]),
    [['Beliefs', 50, [['Practices', 30], ['Narratives', 20]]], ['Philosophy', 10, []]]);
  assert.equal(catPlayerLines([
    { team: 'A', player: 'Ann', cat: 'RMPSS', sub: 'Beliefs', sub2: 'Narratives', ...line(20) },
    { team: 'A', player: 'Ann', cat: 'RMPSS', sub: 'Beliefs', sub2: 'Practices', ...line(30) },
  ], 'RMPSS', 'Beliefs', 'Practices')[0].pts, 30);
});

test('categoryQuestions: one category across rounds, oldest first, with its category', () => {
  const map = { rounds: {
    1: { t: [{ c: 'Science', s: 'Physics' }, { c: 'History', s: '' }], b: [{ c: 'Science', s: 'Biology' }] },
    2: { t: [{ c: 'History', s: '' }, { c: 'Science', s: 'Chemistry' }], b: [] },
  } };
  const tu = { 1: [{ tossup: 1, buzzes: [] }, { tossup: 2, buzzes: [] }],
    2: [{ tossup: 1, buzzes: [] }, { tossup: 2, buzzes: [] }] };
  const bn = { 1: [{ bonus: 1, results: [] }], 2: [] };
  const sci = categoryQuestions(map, [2, 1], 'Science', '', (n) => tu[n], (n) => bn[n]);
  assert.deepEqual(sci.tossups.map((x) => [x.round, x.tossup, x.sub]), [[1, 1, 'Physics'], [2, 2, 'Chemistry']]);
  assert.deepEqual(sci.bonuses.map((x) => [x.round, x.bonus, x.cat]), [[1, 1, 'Science']]);
  assert.equal(categoryQuestions(map, [1, 2], 'Science', 'Chemistry', (n) => tu[n], (n) => bn[n]).tossups.length, 1);
  assert.equal(categoryQuestions(map, [1, 2], '', '', (n) => tu[n], (n) => bn[n]).tossups.length, 4);
});

/* ---------- browser-module shim ---------- */

// api.js reads location at import time; the demo tests below load it
// (through demo.js), so give Node the two globals it touches.
globalThis.location = globalThis.location || { search: '' };
globalThis.localStorage = globalThis.localStorage || {};

/* ---------- buzzpoints markup ---------- */

const { replacementsHtml } = await import('../app/js/buzzview.js');

// A tiebreaker's id rides in the uploaded game (qbtd_tiebreaker), so the
// Replacements view must show it as text, with or without the pool's text.
test('buzzpoints: a tiebreaker id from an uploaded game is shown as text', () => {
  const id = '<img src=x onerror=alert(1)>';
  const qbj = { match_teams: [{ team: { name: 'A' } }, { team: { name: 'B' } }], match_questions: [
    { question_number: 1, tossup_question: { question_number: 1, qbtd_tiebreaker: id },
      buzzes: [{ team: { name: 'A' }, player: { name: 'p' }, buzz_position: { word_index: 3 }, result: { value: 10 } }],
      bonus: { question: { question_number: 1, qbtd_tiebreaker: id + 'B' }, parts: [{ controlled_points: 10 }] } }] };
  const read = tiebreakerBuzzes([{ id: 1, round: 3, room: 'R1', qbj }]);
  const pool = { tossups: [{ id, question: 'Q', answer: 'A' }], bonuses: [{ id: id + 'B', leadin: 'L', parts: ['p'], answers: ['a'] }] };
  for (const html of [replacementsHtml(read, null), replacementsHtml(read, pool)]) {
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('<span class="roundcell">&lt;img src=x onerror=alert(1)&gt;</span>'));
    assert.ok(html.includes('<span class="roundcell">&lt;img src=x onerror=alert(1)&gt;B</span>'));
  }
});

// A shared link's ?server= / ?live= must not move the production pages
// (they hold the saved admin and set links); any other origin keeps them.
// Each import is its own module instance, read with its own location.
await testA('api.js: the production pages ignore ?server= and ?live=, other origins keep them', async () => {
  const was = [globalThis.location, globalThis.localStorage];
  const load = (origin, search, storage, tag) => {
    globalThis.location = { origin, search };
    globalThis.localStorage = storage;
    return import('../app/js/api.js?' + tag);
  };
  const PROD = 'https://qb-td.denisliu10.workers.dev';
  const PROD_LIVE = 'https://qb-td-live.denisliu10.workers.dev';
  try {
    let m = await load('https://qbsuite.github.io', '?t=x&server=https://evil.example&live=https://evil.example', {}, 'prod1');
    assert.deepEqual([m.API, m.LIVE], [PROD, PROD_LIVE]);
    m = await load('https://qbsuite.github.io', '?t=x&live=off', { qbtdServer: 'https://evil.example', qbtdLive: 'https://evil.example' }, 'prod2');
    assert.deepEqual([m.API, m.LIVE], [PROD, PROD_LIVE]);
    // local tests and self-hosted copies: exactly as before
    m = await load('http://localhost:8765', '?a=x&server=http://127.0.0.1:8799', {}, 'local1');
    assert.deepEqual([m.API, m.LIVE], ['http://127.0.0.1:8799', null]);
    m = await load('http://localhost:8765', '?live=https://live.example', { qbtdServer: 'https://self.example' }, 'local2');
    assert.deepEqual([m.API, m.LIVE], ['https://self.example', 'https://live.example']);
    m = await load('https://td.example.org', '?live=off', {}, 'self1');
    assert.deepEqual([m.API, m.LIVE], [PROD, null]);
    m = await load('https://td.example.org', '', {}, 'self2');
    assert.deepEqual([m.API, m.LIVE], [PROD, PROD_LIVE]);
  } finally {
    [globalThis.location, globalThis.localStorage] = was;
  }
});

// The reader retries a protest send on a network failure or a server
// fault, and waits on a refusal: pub() carries the status to tell them
// apart (the Worker now answers a fault with a JSON 500, not a bare one).
await testA('pub: a failed call carries the HTTP status', async () => {
  const { pub } = await import('../app/js/api.js');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Something went wrong on the server. Please try again.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(pub('/b/x/protests', { method: 'POST' }), (e) => e.status === 500 && /server/.test(e.message));
    globalThis.fetch = async () => new Response('nope', { status: 403 });
    await assert.rejects(pub('/a/x/file'), (e) => e.status === 403 && /403/.test(e.message));
  } finally { globalThis.fetch = realFetch; }
});

/* ---------- Worker category extraction ---------- */

const { categoryFromMetadata, packetCategories, tagWithoutWriter } = await import('../worker/worker.js');

test('categoryFromMetadata: Beliefs is a category, its named half the subcategory', () => {
  assert.deepEqual(categoryFromMetadata('Jordan Patel, Beliefs - Narratives'), { c: 'Beliefs', s: 'Narratives' });
  assert.deepEqual(categoryFromMetadata('Jordan Patel, Beliefs - Practices'), { c: 'Beliefs', s: 'Practices' });
  assert.deepEqual(categoryFromMetadata('JP, Beliefs (Narratives and Practices)'), { c: 'Beliefs', s: '' });
  assert.deepEqual(categoryFromMetadata('Beliefs'), { c: 'Beliefs', s: '' });
  // 2026 Terrapin's own tags: the half alone, after the writers' initials
  assert.deepEqual(categoryFromMetadata('Narratives'), { c: 'Beliefs', s: 'Narratives' });
  assert.deepEqual(categoryFromMetadata('JPMT, Practices'), { c: 'Beliefs', s: 'Practices' });
  assert.deepEqual(categoryFromMetadata('JPMT/AY, Narratives'), { c: 'Beliefs', s: 'Narratives' });
  assert.deepEqual(categoryFromMetadata('IBP/MS, Practices'), { c: 'Beliefs', s: 'Practices' });
  // inside a longer tag the word is left alone
  assert.notDeepEqual(categoryFromMetadata('Christian Practices'), { c: 'Beliefs', s: 'Practices' });
});

test('tagWithoutWriter drops a leading name or initials, and nothing else', () => {
  assert.equal(tagWithoutWriter('Jordan Patel, Visual Culture'), 'Visual Culture');
  assert.equal(tagWithoutWriter('J. Patel, Interdisciplinary - Space'), 'Interdisciplinary - Space');
  assert.equal(tagWithoutWriter('JP, Misc. (Food)'), 'Misc. (Food)');
  assert.equal(tagWithoutWriter('María José García-López, Beliefs'), 'Beliefs');
  assert.equal(tagWithoutWriter('JPMT/AY, Visual Culture'), 'Visual Culture');
  assert.equal(tagWithoutWriter('Ann Lee & Bo Kim, Visual Culture'), 'Visual Culture');
  // topics, category words and a lone word stay
  assert.equal(tagWithoutWriter('CE, Politics'), 'CE, Politics');
  assert.equal(tagWithoutWriter('Visual Arts, Film'), 'Visual Arts, Film');
  assert.equal(tagWithoutWriter('Visual Culture, Space'), 'Visual Culture, Space');
  assert.equal(tagWithoutWriter('Patel, Beliefs'), 'Patel, Beliefs');
  // a name with nothing after it is the whole tag
  assert.equal(tagWithoutWriter('Jordan Patel'), 'Jordan Patel');
});

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
      { question: 'q', answer: 'a', metadata: '<b>Jordan Patel, Visual Culture</b>' },
    ],
    bonuses: [
      { leadin: 'l', metadata: 'Physics' },
      { leadin: 'l', category: 'Literature', subcategory: 'World Literature' },
    ],
  }));
  assert.deepEqual(packetCategories(body, 'Packet 1.json'), {
    // no tag: nothing; a tag nothing recognizes: kept, without its writer
    t: [{ c: 'History', s: 'American' }, { c: 'Religion', s: '' }, null, { u: 'Visual Culture' }],
    b: [{ c: 'Science', s: 'Physics' }, { c: 'Literature', s: 'World Literature' }],
  });
  assert.equal(packetCategories(body, 'Packet 1.docx'), null);
});

test('packetCategories: bonuses keep their e/m/h difficulty marks', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    tossups: [{ question: 'q', answer: 'a', category: 'Science', subcategory: 'Physics' }],
    bonuses: [
      { leadin: 'l', category: 'Science', subcategory: 'Physics', difficultyModifiers: ['m', 'E', 'h'] },
      { leadin: 'l', category: 'History', subcategory: '' },
      { leadin: 'l', category: 'Religion', subcategory: '', difficultyModifiers: ['e', 'x', 'h'] },
      { leadin: 'l', difficultyModifiers: ['e', 'm', 'h'] }, // no category: nothing to file it under
    ],
  }));
  assert.deepEqual(packetCategories(body, 'p.json').b, [
    { c: 'Science', s: 'Physics', d: 'meh' },
    { c: 'History', s: '' },
    { c: 'Religion', s: '' },
    null,
  ]);
});

/* ---------- html stat report ---------- */

console.log('html stat report');

const STAGED = (await import('../tools/yf_parity/scenarios.mjs')).SCENARIOS;
test('forfeits: a win and a loss, no stats, shown as YellowFruit shows them', () => {
  const sc = STAGED.find((x) => x.key === 'pools');
  const roster = parseRoster(sc.roster);
  const played = sc.games.map((g) => parseMatch(g.qbj, { filename: g.filename }));
  const [win, lose] = [roster[0].name, roster[2].name];
  const ff = parseMatch(forfeitQbj(6, win, lose));
  assert.equal(ff.forfeit, true);
  assert.equal(ff.round, 6);
  assert.equal(ff.tossupsRead, 0);
  assert.deepEqual(ff.teams.map((t) => [t.name, !!t.forfeitLoss, t.points, t.players.length]), [[win, false, 0, 0], [lose, true, 0, 0]]);
  assert.equal(resultOf(ff.teams[0], ff.teams[1]), 'W');
  assert.equal(resultOf(ff.teams[1], ff.teams[0]), 'L');
  assert.equal(resultOf({ forfeitLoss: true }, { forfeitLoss: true }), '', 'a double forfeit is no result');
  // the record moves; nothing else does
  const before = aggregate(played, roster);
  const after = aggregate([...played, ff], roster);
  const t = (agg, n) => agg.teams.find((x) => x.name === n);
  assert.equal(t(after, win).w, t(before, win).w + 1);
  assert.equal(t(after, lose).l, t(before, lose).l + 1);
  for (const n of [win, lose]) {
    for (const k of ['gp', 'points', 'tuh', 'bonusPoints', 'bonusesHeard', 't']) assert.equal(t(after, n)[k], t(before, n)[k], n + ' ' + k);
    assert.deepEqual(t(after, n).counts, t(before, n).counts);
  }
  assert.deepEqual(after.players, before.players);
  // the report: the box score is its result, team detail says Forfeit with
  // blank stats, the round report leaves it out
  const pages = buildReport({ name: 'F', matches: dedupeMatches([...played, ff]), roster });
  const page = (p) => pages.find((f) => f.name === p + '.html').text;
  assert.ok(page('games').includes(`${win} defeats ${lose} by forfeit`));
  assert.ok(!page('rounds').includes('>6</a>') && !page('rounds').includes('#Round-6'), 'no round of forfeits in the round report');
  assert.ok(/Forfeit<\/a>/.test(page('teamdetail')));
  // the New layout's data: the winner, and the forfeit marked
  const g = reportData({ name: 'F', matches: dedupeMatches([...played, ff]), roster }).games.find((x) => x.round === 6);
  assert.equal(g.forfeit, true);
  assert.equal(g.winner, win);
  assert.equal(g.loser, lose);
  // both YellowFruit files carry it
  const y = JSON.parse(serializeYft({ name: 'F', matches: dedupeMatches([...played, ff]), roster }));
  const mt = y.objects[0].phases.flatMap((ph) => ph.rounds).flatMap((r) => r.matches).find((m) => m.match_teams.some((x) => x.forfeit_loss));
  assert.ok(mt && mt.match_teams.find((x) => x.forfeit_loss).team.$ref === `Team_${lose}`);
  const y3 = JSON.parse(serializeYft3({ matches: dedupeMatches([...played, ff]), roster }).split('\n')[5]).find((x) => x.forfeit);
  assert.deepEqual([y3.team1, y3.team2, y3.round, y3.players1], [win, lose, 6, null]);
});

test('stats pick: any stages, or the finished rounds, export cleanly — both YellowFruit files and the report', () => {
  for (const sc of STAGED.filter((x) => x.pick)) {
    const matches = dedupeMatches(sc.games.map((g) => parseMatch(g.qbj, { filename: g.filename })));
    const opts = { name: sc.name, matches, roster: parseRoster(sc.roster), schedule: sc.schedule };
    const yf = JSON.parse(serializeYft(opts)).objects[0];
    const inFile = yf.phases.flatMap((ph) => ph.rounds.flatMap((r) => r.matches || [])).length;
    assert.equal(inFile, matches.length, sc.key + ': every picked game in the YellowFruit 4 file');
    const poolStages = yf.phases.filter((ph) => ['Prelim', 'Playoff'].includes(ph.YfData.phaseType));
    assert.equal(poolStages[0].YfData.phaseType, 'Prelim', sc.key + ': the first pool stage is YellowFruit\'s Prelim stage');
    const yf3 = serializeYft3(opts);
    assert.ok(yf3.length > 0, sc.key + ': YellowFruit 3 file');
    assert.equal(buildReport(opts).length, 6, sc.key + ': six report pages');
  }
  assert.ok(STAGED.filter((x) => x.pick).length >= 7);
});

test('Combined standings: the final decides 1st and 2nd, then the playoff brackets in order, each team at its place', () => {
  const data = (key) => {
    const sc = STAGED.find((x) => x.key === key);
    const matches = dedupeMatches(sc.games.map((g) => parseMatch(g.qbj, { filename: g.filename })));
    return { sc, matches, rd: reportData({ name: sc.name, matches, roster: parseRoster(sc.roster), schedule: sc.schedule }) };
  };
  // mid-playoffs, no final: the top bracket's table, then the bottom one's
  let { rd } = data('playoffs');
  const play = rd.stageStandings.find((x) => x.stage === 'Playoffs').pools;
  assert.deepEqual(rd.combined.map((t) => t.name), [...play[0].teams, ...play[1].teams].map((t) => t.name));
  assert.equal(rd.combined.length, 12);
  assert.ok(rd.combined.slice(6).every((t) => Number.parseInt(t.rank, 10) >= 7), 'the second bracket starts at 7th');
  // with the final played: its winner 1st, the other finalist 2nd, the rest in order
  const f = data('finals');
  const last = f.matches.filter((m) => m.round === 9)[0];
  const win = last.teams[0].points > last.teams[1].points ? last.teams[0].name : last.teams[1].name;
  const lose = last.teams.find((t) => t.name !== win).name;
  assert.deepEqual(f.rd.combined.slice(0, 2).map((t) => [t.rank, t.name]), [['1', win], ['2', lose]]);
  const top = f.rd.stageStandings.find((x) => x.stage === 'Playoffs').pools[0].teams.map((t) => t.name).filter((n) => n !== win && n !== lose);
  assert.deepEqual(f.rd.combined.slice(2, 6).map((t) => t.name), top);
  // whole-day records: every game each team played
  const games = (n) => f.matches.filter((m) => m.teams.some((t) => t.name === n)).length;
  for (const t of f.rd.combined) assert.equal(t.w + t.l + t.t, games(t.name), t.name);
  // prelims only: one stage, its pools mixed by place
  ({ rd } = data('pools'));
  assert.equal(rd.combined.length, 12);
  const firsts = rd.stageStandings[0].pools.map((p) => p.teams[0].name);
  assert.deepEqual(rd.combined.slice(0, 2).map((t) => t.name).sort(), firsts.sort(), 'the pool winners first');
});

test('New layout standings match Classic\'s, stage by stage and pool by pool, in each staged scenario', () => {
  // Classic's standings page as [{stage, pools: [{name, teams}]}]; Finals
  // (result lines) and Cumulative (every team together) are Classic's own
  const classic = (html) => html.split(/<h2>\n/).slice(1).map((sec) => {
    const stage = sec.slice(0, sec.indexOf('&nbsp;'));
    const parts = sec.split(/<h3>\n/);
    const tableNames = (t) => [...t.split('</table>')[0].matchAll(/teamdetail\.html#[^>]*>([^<]+)<\/a>/g)].map((x) => x[1]);
    const pools = parts.length > 1 ? parts.slice(1).map((x) => ({ name: x.slice(0, x.indexOf('\n')), teams: tableNames(x) }))
      : [{ name: null, teams: tableNames(parts[0]) }];
    return { stage, pools };
  }).filter((x) => !['Finals', 'Cumulative'].includes(x.stage) && x.pools.some((p) => p.teams.length));
  let n = 0;
  for (const sc of STAGED) {
    if (!sc.schedule) continue;
    const matches = dedupeMatches(sc.games.map((g) => parseMatch(g.qbj, { filename: g.filename })));
    const roster = parseRoster(sc.roster);
    const opts = { name: sc.name, matches, roster, schedule: sc.schedule };
    const rd = reportData(opts);
    const html = buildReport(opts).find((f) => f.name === 'standings.html').text;
    const want = classic(html);
    if (!rd.stageStandings) {
      assert.ok(want.length <= 1 && want.every((x) => x.pools.length === 1), sc.key + ': no stages or pools, one table');
      continue;
    }
    const got = rd.stageStandings.map((sec) => ({ stage: sec.name, pools: sec.pools.map((pl) => ({ name: rd.stageStandings.length === 1 && sec.pools.length === 1 ? null : pl.name, teams: pl.teams.map((t) => t.name) })) }));
    // one stage played: Classic names it in its single heading
    const fix = (x) => x.map((sec) => ({ ...sec, pools: sec.pools.map((p) => (sec.pools.length === 1 ? { ...p, name: null } : p)) }));
    assert.deepEqual(fix(got), fix(want), sc.key);
    n++;
  }
  assert.ok(n >= 4, 'scenarios with stages: ' + n);
});

test('html stat report: a prelim stage with pools ranks each pool apart, under the stage name', () => {
  const sc = STAGED.find((x) => x.key === 'pools');
  const matches = dedupeMatches(sc.games.map((g) => parseMatch(g.qbj, { filename: g.filename })));
  const roster = parseRoster(sc.roster);
  const page = (pages, p) => pages.find((f) => f.name === p + '.html').text;
  const staged = buildReport({ name: sc.name, matches, roster, schedule: sc.schedule });
  const st = page(staged, 'standings');
  assert.ok(st.includes('<h3>\nPool A\n</h3>') && st.includes('<h3>\nPool B\n</h3>'), 'a heading per pool');
  assert.ok(st.includes('Prelims') && !st.includes('All Games'));
  const tables = st.split('<h3>').slice(1);
  for (const [i, t] of tables.entries()) {
    const names = sc.schedule.pools[i ? 'B' : 'A'];
    assert.ok(names.every((n) => t.includes(`>${n}<`) || t.includes(`\n${n}\n`)), 'pool ' + i + ' holds its own teams');
    assert.ok(/<td\s*>\s*1=?\s*<\/td>/.test(t), 'ranks start at 1 in each pool');
  }
  assert.ok(page(staged, 'individuals').includes('Prelims'));
  assert.ok(page(staged, 'games').includes('Round 1 - Prelims'));
  // without the schedule, one table as before
  const plain = page(buildReport({ name: sc.name, matches, roster }), 'standings');
  assert.ok(plain.includes('All Games') && !plain.includes('<h3>'));
});

test('html stat report: stages played in turn report as YellowFruit does — finals, playoffs, prelims, cumulative', () => {
  const sc = STAGED.find((x) => x.key === 'finals');
  const matches = dedupeMatches(sc.games.map((g) => parseMatch(g.qbj, { filename: g.filename })));
  const roster = parseRoster(sc.roster);
  const pages = buildReport({ name: sc.name, matches, roster, schedule: sc.schedule });
  const page = (p) => pages.find((f) => f.name === p + '.html').text;
  const heads = [...page('standings').matchAll(/<h2>\n([^\n]*)&nbsp;\n<\/h2>/g)].map((x) => x[1]);
  assert.deepEqual(heads, ['Finals', 'Playoffs', 'Prelims', 'Cumulative']);
  assert.ok(/def\. .* \(<a HREF=games\.html#/.test(page('standings')), 'the final as a result line');
  assert.ok(page('standings').includes('Advanced To') && page('standings').includes('1st–6th place'));
  const ind = [...page('individuals').matchAll(/<h2>\n([^\n]*)&nbsp;\n<\/h2>/g)].map((x) => x[1]);
  assert.deepEqual(ind, ['Prelims', 'All Games']);
  assert.ok(page('games').includes('Round 6 - Playoffs') && page('games').includes('Carries over to: Playoffs'));
  assert.ok(page('teamdetail').includes('Stage') && page('teamdetail').includes('Carried To'));
  assert.ok(page('playerdetail').includes('Stage') && page('rounds').includes('Stage'));
  // the New layout's numbers are untouched by it
  assert.equal(reportData({ name: sc.name, matches, roster, schedule: sc.schedule }).teams.length, 12);
});

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

// The public stats tab shows the six pages in one srcdoc frame. A srcdoc
// document's base URL is its parent's, so a "#x" link the browser follows
// loads the surrounding page inside the frame: every link must be
// frame-local and followed by the frame's own click handler.
test('in-page report frame: links are frame-local and resolve', () => {
  const doc = reportSrcdoc(REPORT);
  const ids = new Set([...doc.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]));
  const hrefs = [...doc.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])
    .filter((h) => !/^https?:/.test(h));
  assert.ok(hrefs.length > 20);
  for (const h of hrefs) {
    assert.match(h, /^#/, h + ' would navigate the frame');
    assert.ok(ids.has(h.slice(1)), h + ' has no target');
  }
  assert.ok(doc.includes('preventDefault'), 'the frame follows its links itself');
  assert.ok(!doc.includes('hashchange'), 'nothing depends on the browser navigating');
});

test('in-page report frame follows the reader theme; the report itself never does', () => {
  const doc = reportSrcdoc(REPORT);
  // the tab tracks the reader's theme...
  assert.match(doc, /@media \(prefers-color-scheme: dark\)/);
  assert.match(doc, /color-scheme:dark/);
  // ...overriding every colour YellowFruit's own stylesheet sets, so no
  // light-mode swatch is left stranded on a dark page
  for (const sel of ['tr:nth-child(even)', '.scoreboardRoundHeader', '.pseudoTFoot',
    '.floatingTOC', '.inlineDivider']) {
    const inDark = doc.slice(doc.indexOf('prefers-color-scheme: dark'));
    assert.ok(inDark.includes(sel), sel + ' keeps its light colour in dark mode');
  }
  // ...and the frame paints its own background rather than letting the
  // page show through
  assert.match(doc, /body\{[^}]*background:#fff/);

  // The files a TD downloads are YellowFruit's white report, untouched:
  // engine/report.js must not gain any of this. tools/yf_parity.mjs checks
  // them byte for byte against YellowFruit's own, which this guards in the
  // suite that runs on every change.
  for (const page of REPORT) {
    assert.ok(!/prefers-color-scheme/.test(page.text), page.name + ' must not carry a theme');
    assert.ok(!/color-scheme/.test(page.text), page.name + ' must not set a colour scheme');
  }
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

// The staged report writes names in more places than the one-stage one:
// Finals and Tiebreaker result lines, stage headings, the scoreboard's
// contents, the Stage and Carried To cells, Advanced To. A team name
// comes from whoever uploaded the game; stage and bracket names from the
// schedule.
test('staged report escapes team, stage and bracket names', () => {
  const sc = STAGED.find((x) => x.key === 'tiebreak'); // prelims, tiebreakers, playoffs, final: all played
  const swap = { 'Ames A': '<xss-final onclick=x>', Elm: '<xss-tb>', Prelims: '<xss-prelims>', Tiebreakers: '<xss-tbs>',
    Playoffs: '<xss-playoffs> & more', Finals: '<xss-finals>', '1st–6th place': '<xss-bracket>' };
  let text = JSON.stringify(sc);
  for (const [from, to] of Object.entries(swap)) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  const ev = JSON.parse(text);
  const matches = dedupeMatches(ev.games.map((g) => parseMatch(g.qbj, { filename: g.filename })));
  const pages = buildReport({ name: ev.name, matches, roster: parseRoster(ev.roster), schedule: ev.schedule });
  const page = (p) => pages.find((f) => f.name === p + '.html').text;
  for (const f of pages) assert.ok(!f.text.includes('<xss'), f.name + ' writes a name as markup');
  // every sink was reached, its name written as text
  const st = page('standings');
  assert.ok(st.includes('<li>\n&lt;xss-final onclick=x&gt; def. Bloom ('), 'the Finals result line');
  assert.ok(st.includes('<li>\n&lt;xss-tb&gt; def. Gale A ('), 'the Tiebreakers result line');
  for (const h of ['&lt;xss-finals&gt;', '&lt;xss-playoffs&gt; &amp; more', '&lt;xss-prelims&gt;']) {
    assert.ok(st.includes(`<h2>\n${h}&nbsp;\n</h2>`), 'the heading ' + h);
  }
  assert.ok(st.includes('<td    >&lt;xss-bracket&gt;</td>'), 'Advanced To');
  const games = page('games');
  assert.ok(games.includes('<li>\n&lt;xss-tbs&gt;\n</li>'), 'the scoreboard\'s contents');
  assert.ok(games.includes('<h2>\nRound 7 - &lt;xss-playoffs&gt; &amp; more&nbsp;\n</h2>'), 'a round\'s heading');
  assert.ok(games.includes('<p>\nCarries over to: &lt;xss-playoffs&gt; &amp; more\n</p>'), 'Carries over to');
  assert.ok(page('teamdetail').includes('">\n&lt;xss-prelims&gt;\n</td>'), 'the Stage cell');
  assert.ok(page('individuals').includes('<h2>\n&lt;xss-prelims&gt;&nbsp;\n</h2>'), 'the individuals heading');
  // and the in-page frame keeps them text
  assert.ok(!reportSrcdoc(pages).includes('<xss'));
});

// The frame is sandboxed, so the page can't read where the reader is; the
// frame says so by message, and only its own, well-formed messages count.
test('in-page report frame: sandboxed, its place read from its own messages', () => {
  const frame = { contentWindow: {}, style: {}, getBoundingClientRect: () => ({ top: 100 }) };
  const box = { html: '', set innerHTML(v) { this.html = v; }, querySelector: () => frame };
  const had = globalThis.window;
  let onMessage = null;
  globalThis.window = { addEventListener: (type, fn) => { if (type === 'message') onMessage = fn; }, removeEventListener() {} };
  try {
    mountReport(box, REPORT);
    const sandbox = /sandbox="([^"]*)"/.exec(box.html);
    assert.ok(sandbox && sandbox[1].split(' ').includes('allow-scripts'), box.html);
    assert.ok(!sandbox[1].includes('allow-same-origin'), 'the frame gets an origin of its own');
    assert.equal(reportPlace(box), null, 'nothing said yet');
    const say = (data, source = frame.contentWindow) => onMessage({ source, data: { qbtdReport: 'place', ...data } });
    // the frame is 100px down the screen: the last anchor at most 80px from the top
    say({ page: 'games', marked: null, anchors: [['games-Round-1', -400], ['games-Match_1', -30], ['games-Round-2', 500]] });
    assert.deepEqual(reportPlace(box), { page: 'games', anchor: 'games-Match_1' });
    say({ page: 'teamdetail', marked: 'teamdetail-Ames', anchors: [['teamdetail-Ames', 0]] });
    assert.deepEqual(reportPlace(box), { page: 'teamdetail', anchor: 'teamdetail-Ames', marked: true });
    say({ page: 'games', marked: null, anchors: [] }, {}); // another window
    say({ page: '__proto__', marked: null, anchors: [] }); // no such page
    say({ page: 'games', marked: null, anchors: 'x' });
    assert.deepEqual(reportPlace(box), { page: 'teamdetail', anchor: 'teamdetail-Ames', marked: true });
  } finally { globalThis.window = had; }
});

test('in-page report frame: a start place cannot end the frame\'s script', () => {
  const doc = reportSrcdoc(REPORT, { start: { page: 'games', anchor: '</script><script>parent.x=1</script>', back: 'Schedule' } });
  assert.equal((doc.match(/<\/script>/gi) || []).length, 1, 'one script, closed once');
  assert.ok(!doc.includes('<script>parent.x'));
});

// The frame's own script, run against a stand-in document `width` wide
// (0: not laid out yet, as a sandboxed frame can be when its script runs).
function runFrameScript(doc, width) {
  const script = /<script>([\s\S]*)<\/script>/.exec(doc)[1];
  const posted = [];
  const frames = [];
  const on = {};
  const pages = {};
  const env = { width };
  const document = {
    body: { getBoundingClientRect: () => ({ width: env.width }) },
    documentElement: { scrollHeight: 900 },
    getElementById: (id) => (id.startsWith('page-')
      ? (pages[id] ||= { hidden: true, querySelector: () => null, querySelectorAll: () => [] }) : null),
    addEventListener() {},
  };
  const window = { scrollTo() {},
    addEventListener: (t, fn) => (on[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { on[t] = on[t].filter((f) => f !== fn); } };
  new Function('window', 'document', 'parent', 'requestAnimationFrame', script)(
    window, document, { postMessage: (m) => posted.push(m) }, (fn) => frames.push(fn));
  return { posted, env,
    fire: (t) => [...(on[t] || [])].forEach((fn) => fn({})),
    nextFrame: () => frames.splice(0).forEach((fn) => fn()),
    pending: () => frames.length,
    shown: () => Object.keys(pages).filter((k) => !pages[k].hidden) };
}

// Sandboxed, the frame's layout can be missing when its script runs; the
// first page waits for it then, and only then.
test('in-page report frame: the first page is shown at once when the frame is laid out', () => {
  const doc = reportSrcdoc(REPORT, { start: { page: 'games' } });
  const told = (f) => f.posted.map((m) => m.qbtdReport + (m.page ? ':' + m.page : ''));
  // laid out: shown as the script runs, as before the sandbox
  let f = runFrameScript(doc, 800);
  assert.deepEqual(f.shown(), ['page-games']);
  assert.deepEqual(told(f), ['height', 'place:games']);
  assert.equal(f.pending(), 0);
  // not yet: nothing until the frame's first animation frame, and the
  // start page still comes before what the load event shows
  f = runFrameScript(doc, 0);
  f.fire('load');
  assert.deepEqual(f.posted, []);
  f.env.width = 800;
  f.nextFrame();
  assert.deepEqual(f.shown(), ['page-games']);
  assert.deepEqual(told(f), ['height', 'place:games', 'height', 'place:games']);
  // still unsized on that frame: it waits for a resize
  f = runFrameScript(doc, 0);
  f.nextFrame();
  assert.deepEqual(f.posted, []);
  f.env.width = 800;
  f.fire('resize');
  f.nextFrame();
  assert.deepEqual(f.shown(), ['page-games']);
  // a resize tells the page the reader's place at once
  const n = f.posted.length;
  f.fire('resize');
  assert.deepEqual(told(f).slice(n), ['place:games']);
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

// A hub on plain http from a LAN address has no crypto.subtle; the room
// Test links (admin.js testTokenReq) still need the same digest there.
await testA('sha256Hex without crypto.subtle: the plain-JS digest matches node', async () => {
  const node = (s) => schedHash('sha256').update(s).digest('hex');
  // around the 55/56/64-byte padding edges, multi-block, and non-ASCII
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
    const s = 'a'.repeat(n);
    assert.equal(sha256HexJs(s), node(s), 'length ' + n);
  }
  assert.equal(sha256HexJs('Zoë → 東京 🏆'), node('Zoë → 東京 🏆'));
  const was = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a) => a }, configurable: true });
  try {
    const secret = 'abcDEF123456';
    const token = await sha256Hex('qbtd-test:' + await sha256Hex('qbtd-cred:' + secret));
    assert.equal(token, node('qbtd-test:' + node('qbtd-cred:' + secret)));
  } finally {
    Object.defineProperty(globalThis, 'crypto', was);
  }
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

test('archive entries listed by name only are a name and a date', () => {
  for (const t of archiveIndex.named || []) {
    assert.ok(t.name && typeof t.name === 'string', 'named entry has a name');
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/, t.name + ' date');
    assert.ok(!('slug' in t), t.name + ' carries no slug: there is nothing to open');
  }
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

/* ---------- schedule: brackets, generation options, checks ---------- */

// every format and field size, generated with default options, minus the
// new bracket fields: identical to the generator before options existed
// rooms changed once on purpose: every pool and bracket now keeps its own
// block of rooms (what { rooms: 'blocks' } used to build); pairings did not
test('buildSchedule defaults are unchanged (brackets aside) for every format, 3-36 teams', () => {
  const strip = (x) => {
    const c = JSON.parse(JSON.stringify(x));
    delete c.brackets;
    for (const ph of c.phases) { delete ph.meet; for (const r of ph.rounds) for (const g of r.games) delete g.bracket; }
    return c;
  };
  const out = {};
  for (let n = 3; n <= 36; n++) {
    const teams = Array.from({ length: n }, (_, i) => 'T' + (i + 1));
    // (the x2 bracket formats came later and have their own tests)
    for (const f of allFormats(n).filter((x) => !/x2$/.test(x.key))) {
      const rooms = Array.from({ length: f.roomsNeeded + 1 }, (_, i) => ({ name: 'R' + (i + 1), bucket: null }));
      out[n + ':' + f.key] = JSON.stringify(strip(buildSchedule(f.key, teams, rooms)));
    }
  }
  assert.equal(Object.keys(out).length, 84);
  assert.equal(schedHash('sha256').update(JSON.stringify(out)).digest('hex'),
    '195103b08e39a2a2cd10c817244f49f6ef7c1b7dd0969fe8601eb30c80ee4332');
});

const T12 = Array.from({ length: 12 }, (_, i) => 'T' + (i + 1));
const R6 = Array.from({ length: 6 }, (_, i) => ({ name: 'R' + (i + 1), bucket: null }));
const everyGame = (s) => s.phases.flatMap((ph) => ph.rounds.flatMap((r) => r.games));

test('buildSchedule tags every game with a bracket, and lists the brackets with their rooms', () => {
  const names = (s) => s.brackets.map((b) => b.name + '@' + b.phase + ':' + b.rooms.join(','));
  assert.deepEqual(names(buildSchedule('rr', T12, R6)), ['Round robin@0:0,1,2,3,4,5']);
  assert.deepEqual(names(buildSchedule('pools2', T12, R6)),
    ['Pool A@0:0,1,2', 'Pool B@0:3,4,5', 'Championship@1:0,1,2', 'Consolation@1:3,4,5']);
  assert.deepEqual(buildSchedule('pools3', T12, R6).brackets.map((b) => b.name),
    ['Pool A', 'Pool B', 'Pool C', '1st\u20133rd place', '4th\u20136th place', '7th\u20139th place', '10th\u201312th place']);
  assert.deepEqual(buildSchedule('rr2', T12.slice(0, 6), R6).brackets.map((b) => b.name), ['Round robin 1', 'Round robin 2']);
  for (const f of allFormats(12)) {
    const s = buildSchedule(f.key, T12, R6);
    assert.ok(everyGame(s).every((g) => g.bracket), f.key + ': a game has no bracket');
    assert.ok(s.phases.every((ph) => ph.meet === 1), f.key + ': meet');
  }
});

test('tagBrackets works out the same brackets for a schedule saved before brackets existed', () => {
  for (const key of ['rr', 'pools2', 'pools3', 'pools4']) {
    const fresh = buildSchedule(key, T12, R6);
    const old = JSON.parse(JSON.stringify(fresh));
    delete old.brackets;
    for (const g of everyGame(old)) delete g.bracket;
    tagBrackets(old);
    assert.deepEqual(everyGame(old).map((g) => g.bracket), everyGame(fresh).map((g) => g.bracket), key);
    assert.deepEqual(bracketRooms(old).map((b) => b.key + b.rooms), fresh.brackets.map((b) => b.key + b.rooms), key);
  }
});

test('phaseLanes groups room columns by bracket, filters to one, and keeps unclaimed rooms', () => {
  const s = buildSchedule('pools2', T12, R6);
  assert.deepEqual(phaseLanes(s, 0).map((l) => l.name + ':' + l.rooms), ['Pool A:0,1,2', 'Pool B:3,4,5']);
  assert.deepEqual(phaseLanes(s, 1, ['CO']).map((l) => l.name + ':' + l.rooms), ['Consolation:3,4,5']);
  s.rooms.push({ name: 'Spare', bucket: null });
  assert.deepEqual(phaseLanes(s, 0).map((l) => l.name), ['Pool A', 'Pool B', 'Other rooms']);
});

test('generation options are seeded: same seed same schedule, and every option keeps the schedule sound', () => {
  const sig = (s) => JSON.stringify(s.phases.map((ph) => ph.rounds.map((r) => r.games.map((g) => [g.room, slotText(g.a), slotText(g.b)]))));
  const pairs = (s) => JSON.stringify(everyGame(s).map((g) => [slotText(g.a), slotText(g.b)].sort().join('|')).sort());
  const base = buildSchedule('pools2', T12, R6);
  for (const opts of [{ seeding: 'random' }, { roundOrder: 'shuffle' }, { rooms: 'shuffle' }, { rooms: 'rotate' }, { rooms: 'keep' }]) {
    const a = buildSchedule('pools2', T12, R6, { ...opts, seed: 7 });
    assert.equal(sig(a), sig(buildSchedule('pools2', T12, R6, { ...opts, seed: 7 })), JSON.stringify(opts) + ' not reproducible');
    if (opts.rooms !== 'keep') assert.notEqual(sig(a), sig(buildSchedule('pools2', T12, R6, { ...opts, seed: 8 })), JSON.stringify(opts) + ' ignores the seed');
    assert.deepEqual(scheduleChecks(a), [], JSON.stringify(opts) + ' made a problem');
    for (const r of a.phases.flatMap((ph) => ph.rounds)) {
      assert.equal(new Set(r.games.map((g) => g.room)).size, r.games.length, 'two games in one room');
    }
    // room and round options move games around but never change who plays whom
    if (opts.seeding !== 'random') assert.equal(pairs(a), pairs(base), JSON.stringify(opts) + ' changed the pairings');
  }
  // random seeding still puts every team in exactly one pool
  const rs = buildSchedule('pools2', T12, R6, { seeding: 'random', seed: 3 });
  assert.deepEqual(Object.values(rs.pools).flat().sort(), [...T12].sort());
  // rotate spreads teams over more rooms than the default keeps them in
  const spread = (s) => {
    const seen = new Map();
    for (const r of s.phases[0].rounds) for (const g of r.games) for (const t of [slotText(g.a), slotText(g.b)]) {
      if (!seen.has(t)) seen.set(t, new Set());
      seen.get(t).add(g.room);
    }
    return [...seen.values()].reduce((n, x) => n + x.size, 0) / seen.size;
  };
  assert.ok(spread(buildSchedule('pools2', T12, R6, { rooms: 'rotate', seed: 3 })) > spread(base));
  // every option, in every phase: a pool's or bracket's games stay in
  // its own block of rooms, the same block whichever option is picked
  const blockOf = (s) => s.phases.map((ph) => {
    const by = {};
    for (const g of ph.rounds.flatMap((r) => r.games)) (by[g.bracket] = by[g.bracket] || new Set()).add(g.room);
    return Object.entries(by).map(([k, v]) => k + ':' + [...v].sort((x, y) => x - y).join(',')).sort();
  });
  for (const key of ['pools2', 'pools3', 'pools3x2']) {
    const keep = buildSchedule(key, T12, R6);
    for (const p of blockOf(keep)) {
      for (const b of p) {
        const rooms = b.split(':')[1].split(',').map(Number);
        assert.equal(rooms.at(-1) - rooms[0] + 1, rooms.length, key + ' ' + b + ' rooms not contiguous');
      }
    }
    for (const rooms of ['shuffle', 'rotate']) assert.deepEqual(blockOf(buildSchedule(key, T12, R6, { rooms, seed: 3 })), blockOf(keep), key + ' ' + rooms);
  }
  // rotate moves teams around their block, in the playoffs too
  const spreadIn = (s, p) => {
    const seen = new Map();
    for (const r of s.phases[p].rounds) for (const g of r.games) for (const t of [slotText(g.a), slotText(g.b)]) {
      if (!seen.has(t)) seen.set(t, new Set());
      seen.get(t).add(g.room);
    }
    return [...seen.values()].reduce((n, x) => n + x.size, 0) / seen.size;
  };
  const T18 = Array.from({ length: 18 }, (_, i) => 'T' + (i + 1));
  const R9 = Array.from({ length: 9 }, (_, i) => ({ name: 'R' + (i + 1), bucket: null }));
  const rot = buildSchedule('pools3x2', T18, R9, { rooms: 'rotate', seed: 3 });
  const kept = buildSchedule('pools3x2', T18, R9);
  for (const p of [0, 1]) assert.ok(spreadIn(rot, p) > spreadIn(kept, p), 'phase ' + p);
  // older saved options still build: blocks is keep, blockrotate is rotate
  assert.equal(sig(buildSchedule('pools2', T12, R6, { rooms: 'blocks' })), sig(base));
  assert.equal(sig(buildSchedule('pools2', T12, R6, { rooms: 'blockrotate', seed: 3 })), sig(buildSchedule('pools2', T12, R6, { rooms: 'rotate', seed: 3 })));
  // the PRNG itself is deterministic and in [0, 1)
  const g1 = mulberry32(42);
  const g2 = mulberry32(42);
  for (let i = 0; i < 5; i++) { const x = g1(); assert.equal(x, g2()); assert.ok(x >= 0 && x < 1); }
});

test('scheduleChecks: double-booked, missing, half-empty, and meetings beyond what the phase allows', () => {
  const s = buildSchedule('rr', T12.slice(0, 4), R6.slice(0, 2));
  assert.deepEqual(scheduleChecks(s), []);
  const r1 = s.phases[0].rounds[0];
  const kept = r1.games[1].a;
  r1.games[1].a = r1.games[0].a; // one team in two games, another gone
  const c = scheduleChecks(s);
  assert.ok(c.some((x) => x.kind === 'twice' && x.r === 0 && x.key === slotText(r1.games[0].a)), JSON.stringify(c));
  assert.ok(c.some((x) => x.kind === 'missing' && x.key === slotText(kept)), JSON.stringify(c));
  assert.equal(c[0].sev, 0);
  r1.games[1].a = kept;
  r1.games[1].b = null;
  assert.ok(scheduleChecks(s).some((x) => x.kind === 'half' && x.room === r1.games[1].room));
  // a double round robin as one phase: pairs meet twice, which meet: 2 allows
  const d = buildSchedule('rr', T12.slice(0, 4), R6.slice(0, 2));
  const again = JSON.parse(JSON.stringify(d.phases[0].rounds));
  d.phases[0].rounds.push(...again);
  assert.ok(scheduleChecks(d).some((x) => x.kind === 'again'));
  d.phases[0].meet = 2;
  assert.deepEqual(scheduleChecks(d), []);
  // an inserted empty round is not "missing" every team
  const e = buildSchedule('rr', T12.slice(0, 4), R6.slice(0, 2));
  insertRound(e, 0, 0);
  assert.deepEqual(scheduleChecks(e), []);
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

test('fillReport: missing prelim files, uploads off the schedule, and ties that decide a bracket', () => {
  // 23 teams, pools of 8/8/7, brackets of two places per pool
  const teams = Array.from({ length: 23 }, (_, i) => 'Team ' + (i + 1));
  const rooms = Array.from({ length: 11 }, (_, i) => ({ name: 'Room ' + (i + 1), bucket: null }));
  const s = buildSchedule('pools3x2', teams, rooms);
  // the lower-numbered team always wins, so pools finish in seed order with no ties
  const side = (name, points) => ({ name, points, bonusPoints: 0, players: [] });
  const num = (t) => Number(t.split(' ')[1]);
  const game = (round, a, b, pa, pb) => ({ round, tossupsRead: 20, teams: [side(a, pa), side(b, pb)] });
  const prelimGames = s.phases[0].rounds.flatMap((r) => r.games.map((g) => {
    const [w, l] = num(g.a.team) < num(g.b.team) ? [g.a.team, g.b.team] : [g.b.team, g.a.team];
    return game(r.round, w, l, 400 - num(w), 100);
  }));
  const clean = fillReport(s, aggregate(prelimGames));
  assert.deepEqual([clean.missing, clean.extra, clean.ties], [[], [], []]);
  const filled = JSON.parse(JSON.stringify(s));
  assert.equal(fillPlaceholders(filled, clean.ranks), 4 * 23);
  assert.ok(!hasPlaceholders(filled));

  // one file missing, and the same game uploaded under the wrong round
  const lost = prelimGames[5];
  const r = fillReport(s, aggregate([...prelimGames.filter((g) => g !== lost), { ...lost, round: lost.round + 1 }]));
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].round, lost.round);
  assert.deepEqual([r.missing[0].a, r.missing[0].b].sort(), lost.teams.map((t) => t.name).sort());
  assert.ok(/^Room \d+$/.test(r.missing[0].room));
  assert.deepEqual(r.extra, [{ round: lost.round + 1, a: lost.teams[0].name, b: lost.teams[1].name }]);

  // upsets: winner beats loser instead (pool A, in finish order: A[0] 7-0, A[1] 6-1, A[2] 5-2, ...)
  const A = s.pools.A;
  const upset = (pairs) => prelimGames.map((g) => {
    const names = g.teams.map((x) => x.name);
    const hit = pairs.find(([w, l]) => names.includes(w) && names.includes(l));
    return hit ? game(g.round, hit[0], hit[1], 300, 200) : g;
  });
  // A[2] beats A[0]: A[0], A[1], A[2] all 6-1 for places 1-3, across 1st–6th and 7th–12th place
  const agg = aggregate(upset([[A[2], A[0]]]));
  const tied = fillReport(s, agg);
  assert.equal(tied.ties.length, 1);
  const t = tied.ties[0];
  assert.equal(t.pool, 'A');
  assert.equal(t.record, '6\u20131');
  assert.deepEqual(t.teams.map((x) => x.name).sort(), [A[0], A[1], A[2]].sort());
  assert.deepEqual(t.teams.map((x) => x.bracket), ['1st\u20136th place', '1st\u20136th place', '7th\u201312th place']);
  // in the order the fill uses: points per 20 tossups heard
  for (let i = 1; i < t.teams.length; i++) assert.ok(t.teams[i - 1].pp20tuh >= t.teams[i].pp20tuh);
  assert.deepEqual(tied.ranks.A.slice(0, 3), t.teams.map((x) => x.name));
  // ties that stay inside one bracket are not notes: A[2] beats A[0] and A[3] beats A[1]
  // gives A[0], A[2] at 6-1 (both 1st–6th place) and A[1], A[3] at 5-2 (both 7th–12th place)
  assert.deepEqual(fillReport(s, aggregate(upset([[A[2], A[0]], [A[3], A[1]]]))).ties, []);
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

test('tbRecordAdd: appends and mid-packet inserts, legacy meta converted', () => {
  // legacy meta: two tossups appended after a 20-tossup packet
  const legacy = { t: 20, b: 20, tu: ['TU1', 'TU2'], bo: [] };
  assert.deepEqual(tbState(legacy).tuAt, { 20: 'TU1', 21: 'TU2' });
  // TU3 replaces a thrown-out question: inserted at game index 5, so the
  // appended ones move down one
  let tb = tbRecordAdd(legacy, { t: 22, b: 20 }, { t: 5, b: 20 }, { tu: ['TU3'], bo: [] });
  assert.deepEqual(tb.tuAt, { 5: 'TU3', 21: 'TU1', 22: 'TU2' });
  assert.equal(tb.t, 20, 'base packet size kept');
  // a packet-file question inserted at the same spot records an empty id
  tb = tbRecordAdd(tb, { t: 23, b: 20 }, { t: 5, b: 20 }, { tu: [''], bo: [] });
  assert.deepEqual(tb.tuAt, { 5: '', 6: 'TU3', 22: 'TU1', 23: 'TU2' });
  assert.deepEqual(tbAddedIds(tb), ['TU3', 'TU1', 'TU2']);
  // first add on a fresh game starts the mapping at the dialog's base
  const fresh = tbRecordAdd(null, { t: 20, b: 20 }, { t: 8, b: 7 }, { tu: ['TU1'], bo: ['B1'] });
  assert.deepEqual(fresh, { t: 20, b: 20, tuAt: { 8: 'TU1' }, boAt: { 7: 'B1' } });
});

test('tbRemapMatch numbers an inserted tiebreaker as if appended', () => {
  // packet of 20; TU1 inserted at game index 5 (game question 6) after
  // packet tossup 5 was thrown out; B1 inserted at game bonus index 3
  const tb = tbRecordAdd(null, { t: 20, b: 20 }, { t: 5, b: 3 }, { tu: ['TU1'], bo: ['B1'] });
  const num = tbNumbering(tb);
  assert.equal(num.tu(5), 5, 'before the insert: unchanged');
  assert.equal(num.tu(6), 21, 'the inserted tossup follows the packet');
  assert.equal(num.tu(7), 6, 'packet tossup 6 keeps its number');
  assert.equal(num.tu(21), 20);
  assert.equal(num.bo(4), 21);
  assert.equal(num.bo(5), 4);
  const match = { match_questions: [
    { tossup_question: { question_number: 5 }, replacement_tossup_question: { question_number: 6 },
      bonus: { question: { question_number: 4 } } },
    { tossup_question: { question_number: 7 }, bonus: { question: { question_number: 5 } } },
  ] };
  const out = tbRemapMatch(match, tb);
  assert.equal(out.match_questions[0].replacement_tossup_question.question_number, 21);
  assert.equal(out.match_questions[0].bonus.question.question_number, 21);
  assert.equal(out.match_questions[1].tossup_question.question_number, 6);
  assert.equal(out.match_questions[1].bonus.question.question_number, 4);
  assert.equal(match.match_questions[1].tossup_question.question_number, 7, 'input untouched');
  assert.deepEqual(tbUsedIds(out, tb), ['TU1', 'B1']);
  // legacy appended-only metas number exactly as before
  const legacy = { t: 20, b: 20, tu: ['TU1'], bo: [] };
  assert.equal(tbNumbering(legacy).tu(21), 21);
  assert.equal(tbNumbering(legacy).tu(3), 3);
});

test('buzzpoints: a room that inserted a tiebreaker lines up with one that did not', () => {
  const buzz = (name, word, value) => ({ player: { name }, team: { name: 'A' },
    buzz_position: { word_index: word }, result: { value } });
  // room 1: packet tossup 5 thrown out, TU1 inserted and read in its place,
  // then packet tossup 6 read next (game question 7)
  const tb = tbRecordAdd(null, { t: 20, b: 20 }, { t: 5, b: 20 }, { tu: ['TU1'], bo: [] });
  const room1 = tbRemapMatch({ match_questions: [
    { tossup_question: { question_number: 5 }, replacement_tossup_question: { question_number: 6 },
      buzzes: [buzz('Ann', 30, 10)] },
    { tossup_question: { question_number: 7 }, buzzes: [buzz('Bob', 12, 15)] },
  ] }, tb);
  // room 2: no throw-out, packet tossup 6 read in order
  const room2 = { match_questions: [
    { tossup_question: { question_number: 6 }, buzzes: [buzz('Cy', 20, 10)] },
  ] };
  const byTu = roundTossupBuzzes([{ round: 1, qbj: room1 }, { round: 1, qbj: room2 }], 1);
  const t6 = byTu.find((x) => x.tossup === 6);
  assert.deepEqual(t6.buzzes.map((b) => b.player), ['Bob', 'Cy'], 'both rooms on packet tossup 6');
  const tbRow = byTu.find((x) => x.tb === 'TU1');
  assert.deepEqual(tbRow.buzzes.map((b) => b.player), ['Ann'], 'the tiebreaker stays off the packet questions');
  assert.equal(byTu[byTu.length - 1], tbRow, 'tiebreakers after the packet questions');
});

test('buzzpoints: different tiebreakers in different rooms stay apart', () => {
  const buzz = (name) => ({ player: { name }, team: { name: 'A' }, buzz_position: { word_index: 3 }, result: { value: 10 } });
  const room = (id, who) => tbRemapMatch({ match_questions: [
    { tossup_question: { question_number: 21 }, buzzes: [buzz(who)],
      bonus: { question: { question_number: 21 }, parts: [{ controlled_points: 10 }] } },
  ] }, tbRecordAdd(null, { t: 20, b: 20 }, { t: 20, b: 20 }, { tu: [id], bo: ['B' + id.slice(2)] }));
  const entries = [{ round: 2, qbj: room('TU2', 'Ann') }, { round: 2, qbj: room('TU10', 'Bob') },
    { round: 2, qbj: room('TU2', 'Cy') }];
  const tus = roundTossupBuzzes(entries, 2);
  assert.deepEqual(tus.map((t) => [t.tb, t.buzzes.map((b) => b.player)]),
    [['TU2', ['Ann', 'Cy']], ['TU10', ['Bob']]], 'one row per tiebreaker, TU2 before TU10');
  assert.deepEqual(roundBonuses(entries, 2).map((b) => [b.tb, b.results.length]), [['B2', 2], ['B10', 1]]);
  // games uploaded before the tag keep grouping by number
  const old = { match_questions: [{ tossup_question: { question_number: 21 }, buzzes: [buzz('Dee')] }] };
  assert.equal(roundTossupBuzzes([{ round: 2, qbj: old }], 2)[0].tossup, 21);
});

test('tiebreakerBuzzes: one row per replacement across rounds and rooms', () => {
  const buzz = (name) => ({ player: { name }, team: { name: 'A' }, buzz_position: { word_index: 3 }, result: { value: 10 } });
  const game = (id, who) => tbRemapMatch({ match_questions: [
    { tossup_question: { question_number: 3 }, buzzes: [buzz('Pat')] },
    { tossup_question: { question_number: 21 }, buzzes: [buzz(who)] },
  ] }, tbRecordAdd(null, { t: 20, b: 20 }, { t: 20, b: 20 }, { tu: [id], bo: [] }));
  const read = tiebreakerBuzzes([
    { round: 3, room: 'A', qbj: game('TU1', 'Ann') }, { round: 7, room: 'B', qbj: game('TU1', 'Bob') },
    { round: 7, room: 'C', qbj: game('TU2', 'Cy') },
  ]);
  assert.deepEqual(read.tossups.map((t) => [t.tb, t.buzzes.map((b) => b.player + '@' + b.round)]),
    [['TU1', ['Ann@3', 'Bob@7']], ['TU2', ['Cy@7']]]);
  assert.deepEqual(read.bonuses, []);
});

test('readerInsertPoint: allowed after a throw-out, refused once records point past it', () => {
  // cycle 4 read packet tossup index 4, threw it out (a neg stays on it);
  // the reader now shows index 5
  const cycles = [{}, {}, {}, {}, {
    wrongBuzzes: [{ tossupIndex: 4 }], thrownOutTossups: [{ questionIndex: 4 }],
  }, {}, {}];
  const base = { cycles, cycleIndex: 4, curT: 5, curB: 4, bonusCount: 20, tossups: true, bonuses: false };
  assert.deepEqual(readerInsertPoint(base), { t: 5, b: 4 });
  // a buzz already on the question now showing: only the end is safe
  const buzzed = cycles.map((c, i) => (i === 4 ? { ...c, wrongBuzzes: [{ tossupIndex: 4 }, { tossupIndex: 5 }] } : c));
  assert.deepEqual(readerInsertPoint({ ...base, cycles: buzzed }), { error: 'current' });
  // the mod went back a cycle: later cycles have results
  const later = cycles.map((c, i) => (i === 6 ? { correctBuzz: { tossupIndex: 6 } } : c));
  assert.deepEqual(readerInsertPoint({ ...base, cycles: later }), { error: 'later' });
  // bonus thrown out: its emptied answer points at the next bonus, which
  // is exactly the slot the replacement takes
  const tob = [{}, {}, {}, {}, {
    correctBuzz: { tossupIndex: 4 }, thrownOutBonuses: [{ questionIndex: 3 }],
    bonusAnswer: { bonusIndex: 4, parts: [{ points: 0 }, { points: 0 }, { points: 0 }] },
  }];
  const bonusOnly = { cycles: tob, cycleIndex: 4, curT: 4, curB: 4, bonusCount: 20, tossups: false, bonuses: true };
  assert.deepEqual(readerInsertPoint(bonusOnly), { t: 4, b: 4 });
  const scored = tob.map((c, i) => (i === 4 ? { ...c, bonusAnswer: { bonusIndex: 4, parts: [{ points: 10 }] } } : c));
  assert.deepEqual(readerInsertPoint({ ...bonusOnly, cycles: scored }), { error: 'current' });
  // bonuses ran out: curB -1 means insert at the end of the bonuses
  assert.equal(readerInsertPoint({ ...bonusOnly, cycles: [], curB: -1 }).b, 20);
});

test('addCounts: a replacement bonus can go Here after a thrown-out bonus', () => {
  // the dialog's own path: pick one pool bonus after the reader threw out
  // the bonus that followed a correct buzz on the current tossup
  const cycles = [{}, {}, {}, {}, {
    correctBuzz: { tossupIndex: 4 }, thrownOutBonuses: [{ questionIndex: 3 }],
    bonusAnswer: { bonusIndex: 4, parts: [{ points: 0 }, { points: 0 }, { points: 0 }] },
  }];
  const at = { cycles, cycleIndex: 4, curT: 4, curB: 4, bonusCount: 20 };
  const bonus = addCounts(true, { tossups: [], bonuses: [{}] }, null);
  assert.deepEqual(bonus, { tossups: 0, bonuses: 1 });
  assert.deepEqual(readerInsertPoint({ ...at, tossups: bonus.tossups > 0, bonuses: bonus.bonuses > 0 }), { t: 4, b: 4 });
  // a tossup picked as well still can't go Here: the current tossup was answered
  const both = addCounts(true, { tossups: [{}], bonuses: [{}] }, null);
  assert.deepEqual(readerInsertPoint({ ...at, tossups: both.tossups > 0, bonuses: both.bonuses > 0 }), { error: 'current' });
  // a loaded file with just a bonus, nothing picked
  assert.deepEqual(addCounts(false, { tossups: [], bonuses: [] }, { tossups: [], bonuses: [{}] }), { tossups: 0, bonuses: 1 });
  // nothing yet: judged as a tossup
  assert.deepEqual(addCounts(false, { tossups: [], bonuses: [] }, null), { tossups: 1, bonuses: 0 });
});

/* ---------- Replace tossup / Replace bonus, on MODAQ's own game state ----------
   The steps tb_add_dialog's replaceNow takes: check, throw out, find the
   reader's place, record the add, insert. */
const modaqRequire = createRequire(import.meta.url);
const { GameState: MGame } = modaqRequire('modaq/src/state/GameState.js');
const { PacketState: MPacket, Tossup: MTossup, Bonus: MBonus } = modaqRequire('modaq/src/state/PacketState.js');
const { Player: MPlayer } = modaqRequire('modaq/src/state/TeamState.js');
const { ACFGameFormat } = modaqRequire('modaq/src/state/GameFormats.js');
const { toQBJ } = modaqRequire('modaq/src/qbj/QBJ.js');
function replaceGame() {
  const tu = (i, tag = 'P') => new MTossup(`${tag}${i} words to buzz on`, `${tag}${i} answer`);
  const bo = (i, tag = 'P') => new MBonus(`${tag}B${i}`, [1, 2, 3].map((k) => ({ question: 'part ' + k, answer: 'a', value: 10 })));
  const packet = new MPacket();
  packet.setTossups(Array.from({ length: 20 }, (_, i) => tu(i + 1)));
  packet.setBonuses(Array.from({ length: 20 }, (_, i) => bo(i + 1)));
  packet.setName('Packet');
  const game = new MGame();
  game.setGameFormat(ACFGameFormat);
  game.loadPacket(packet);
  const A = new MPlayer('Ann', 'Alpha', true);
  const B = new MPlayer('Bob', 'Beta', true);
  game.addNewPlayers([A, B]);
  const g = { game, A, B, tb: null, tu, bo };
  g.correct = (ci, who) => {
    game.cycles[ci].addCorrectBuzz({ player: who, position: 2, points: 10 }, game.getTossupIndex(ci), game.gameFormat, game.getBonusIndex(ci), 3);
    game.cycles[ci].setBonusPartAnswer(0, who.teamName, 10);
  };
  g.neg = (ci, who, position = 1) => game.cycles[ci].addWrongBuzz({ player: who, position, points: -5, isLastWord: false }, game.getTossupIndex(ci), game.gameFormat);
  // MODAQ's throw-out plus clearThrownOutNegs, as the patched reader does
  g.throwOut = (ci) => {
    const c = game.cycles[ci];
    const t = game.getTossupIndex(ci);
    c.addThrownOutTossup(t);
    const next = afterThrowOut(c, t);
    c.wrongBuzzes = next.wrongBuzzes;
    c.tossupProtests = next.tossupProtests;
    if (next.changed) c.updateNeg(game.gameFormat);
  };
  g.scores = () => Object.fromEntries(g.upload().teams.map((t) => [t.name, t.points]));
  // the shipped procedure (read_core replaceQuestion), as the dialog runs it
  const makePacket = (tossups, bonuses, name) => {
    const p = new MPacket();
    p.setTossups(tossups);
    p.setBonuses(bonuses);
    p.setName(name);
    return p;
  };
  g.replace = (ci, kind, question, id, bonus = null, bonusId = '') => {
    const out = replaceQuestion({ game, cycleIndex: ci, kind, question, id, bonus, bonusId, tb: g.tb, act: (fn) => fn(), makePacket });
    if (out.error) return out.error;
    g.tb = out.tb;
    return '';
  };
  // what syncReserved does on every result in the reader
  g.sync = () => syncReserved({ game, tb: g.tb, act: (fn) => fn() });
  g.undo = () => {
    const out = undoReplace({ game, tb: g.tb, act: (fn) => fn(), makePacket });
    if (out.error) return out.error;
    g.tb = out.tb;
    return '';
  };
  // the whole game as it stands: what it uploads, the packet, the questions
  g.state = () => JSON.stringify([toQBJ(game, 'Packet', 1), game.packet.tossups.map((t) => t.question),
    game.packet.bonuses.map((x) => x.leadin), game.cycles.length, g.view()]);
  // each question as MODAQ shows it: tossup and bonus text
  g.view = () => game.cycles.slice(0, 20).map((c, ci) => (game.getTossup(ci) || {}).question?.split(' ')[0]
    + '/' + (c.correctBuzz && game.getBonus(ci) ? game.getBonus(ci).leadin : '-'));
  g.upload = () => parseMatch(withRound(tbRemapMatch(toQBJ(game, 'Packet', 1), g.tb), 1));
  g.qbj = () => tbRemapMatch(toQBJ(game, 'Packet', 1), g.tb);
  return g;
}

test('Replace tossup: after a neg, the pick is read next in its place and the rest of the packet follows', () => {
  const g = replaceGame();
  for (let ci = 0; ci < 3; ci++) g.correct(ci, g.A);
  g.neg(3, g.A);
  assert.equal(g.replace(3, 'tossup', g.tu(1, 'TB'), 'TU1'), '');
  assert.equal(g.game.getTossup(3).question.slice(0, 3), 'TB1', 'the replacement is the tossup being read');
  g.correct(3, g.B);
  for (let ci = 4; ci < 20; ci++) g.correct(ci, g.B);
  assert.equal(g.game.getTossup(4).question.slice(0, 2), 'P5', 'packet tossup 5 comes next; tossup 4 is not read again');
  assert.equal(g.game.getBonus(3).leadin, 'PB4', 'the bonus after the replacement is the next packet bonus');
  const m = g.upload();
  assert.equal(m.tossupsRead, 20);
  const qs = g.qbj().match_questions;
  assert.equal(qs[3].replacement_tossup_question.question_number, 21, 'numbered after the packet');
  assert.equal(qs[3].tossup_question.qbtd_tiebreaker, 'TU1');
  assert.deepEqual(qs.slice(4).map((q) => q.tossup_question.question_number), Array.from({ length: 16 }, (_, i) => i + 5));
  assert.deepEqual(qs.map((q) => q.bonus && q.bonus.question.question_number), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(tbUsedIds(g.qbj(), g.tb), ['TU1']);
});

test('Replace bonus: the pick is read in place of the thrown-out bonus, then the packet resumes', () => {
  const g = replaceGame();
  for (let ci = 0; ci < 5; ci++) g.correct(ci, g.A);
  g.game.cycles[5].addCorrectBuzz({ player: g.B, position: 2, points: 10 }, g.game.getTossupIndex(5), g.game.gameFormat, g.game.getBonusIndex(5), 3);
  assert.equal(g.replace(5, 'bonus', g.bo(1, 'TB'), 'B1'), '');
  assert.equal(g.game.getBonus(5).leadin, 'TBB1');
  g.game.cycles[5].setBonusPartAnswer(0, 'Beta', 10);
  for (let ci = 6; ci < 20; ci++) g.correct(ci, g.A);
  assert.equal(g.game.getBonus(6).leadin, 'PB7', 'bonus 6 was thrown out, so bonus 7 is next');
  const qs = g.qbj().match_questions;
  assert.equal(qs[5].bonus.question.question_number, 21);
  assert.equal(qs[5].bonus.question.qbtd_tiebreaker, 'B1');
  assert.equal(qs[5].bonus.parts[0].controlled_points, 10);
  assert.deepEqual(qs.map((q) => q.tossup_question.question_number), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(tbUsedIds(g.qbj(), g.tb), ['B1']);
});

test('Replace: a tossup and then its bonus on one question, and a packet-file pick (no pool id)', () => {
  const g = replaceGame();
  g.correct(0, g.A);
  assert.equal(g.replace(1, 'tossup', g.tu(9, 'F'), ''), '');
  g.correct(1, g.B);
  assert.equal(g.replace(1, 'bonus', g.bo(9, 'F'), ''), '');
  assert.equal(g.game.getTossup(1).question.slice(0, 2), 'F9');
  assert.equal(g.game.getBonus(1).leadin, 'FB9');
  for (let ci = 2; ci < 20; ci++) g.correct(ci, g.A);
  const qs = g.qbj().match_questions;
  assert.equal(qs[1].tossup_question.question_number, 21);
  assert.equal(qs[1].bonus.question.question_number, 21);
  assert.ok(!qs[1].tossup_question.qbtd_tiebreaker && !qs[1].bonus.question.qbtd_tiebreaker);
  assert.equal(qs[2].tossup_question.question_number, 3);
  assert.equal(qs[2].bonus.question.question_number, 3);
  assert.equal(g.upload().tossupsRead, 20);
});

test('Replace and throw out: scores and earlier bonuses stand; a thrown-out tossup takes its negs with it', () => {
  // the same nine questions played twice: once straight, once with
  // tossup 6 negged by Alpha and replaced, then Beta negs the replacement
  // and Alpha gets it
  const play = (replace) => {
    const g = replaceGame();
    for (let ci = 0; ci < 5; ci++) {
      g.correct(ci, ci % 2 ? g.B : g.A);
      g.game.cycles[ci].setBonusPartAnswer(1, (ci % 2 ? g.B : g.A).teamName, 10);
    }
    if (replace) {
      g.neg(5, g.A, 14);
      assert.equal(g.replace(5, 'tossup', g.tu(1, 'TB'), 'TU1'), '');
    }
    g.neg(5, g.B, 1); // before Alpha's correct buzz (word 2)
    g.correct(5, g.A);
    for (let ci = 6; ci < 9; ci++) g.correct(ci, g.B);
    return g;
  };
  const plain = play(false);
  const replaced = play(true);
  // by hand: Alpha questions 1, 3, 5 at 10 + 20 and question 6 at 10 + 10 = 110;
  // Beta questions 2, 4 at 10 + 20 and 7-9 at 10 + 10, less the neg on 6 = 115
  assert.deepEqual(plain.scores(), { Alpha: 110, Beta: 115 });
  assert.deepEqual(replaced.scores(), { Alpha: 110, Beta: 115 }, 'the thrown-out neg is gone; the replacement neg counts');
  const qs = (g) => g.qbj().match_questions;
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(qs(replaced)[i].bonus.parts.map((p) => p.controlled_points), [10, 10, 0], 'question ' + (i + 1) + ' keeps its bonus');
    assert.deepEqual(qs(replaced)[i].buzzes, qs(plain)[i].buzzes);
  }
  assert.deepEqual(qs(replaced)[5].buzzes.map((b) => b.team.name + ' ' + b.result.value), ['Beta -5', 'Alpha 10']);
  // a neg left on a thrown-out tossup would have taken the replacement neg's points
  const kept = replaceGame();
  kept.neg(0, kept.A, 14);
  kept.game.cycles[0].addThrownOutTossup(0);
  kept.neg(0, kept.B, 9);
  assert.equal(kept.game.cycles[0].wrongBuzzes[1].marker.points, 0, 'MODAQ alone: only the first neg in a slot counts');
  // and MODAQ's own Throw out, as patched, clears it the same way
  const thrown = replaceGame();
  thrown.neg(0, thrown.A, 14);
  thrown.throwOut(0);
  assert.equal(thrown.game.cycles[0].wrongBuzzes, undefined);
  thrown.neg(0, thrown.B, 9);
  assert.equal(thrown.game.cycles[0].wrongBuzzes[0].marker.points, -5);
});

test('reader bundle: MODAQ Throw out tossup clears the thrown-out negs', () => {
  const bundle = readFileSync(new URL('../app/js/read.bundle.js', import.meta.url), 'utf8');
  assert.ok(/addThrownOutTossup\(\w-1\),[^;]{0,40}\.clearThrownOutNegs\(/.test(bundle), 'run npm run build:read');
});

// eight questions played: Alpha 0, Beta 1 (two bonus parts), Alpha 2,
// Beta negs then Alpha gets 3, nobody gets 4 (an Alpha neg), Beta 5,
// Alpha 6, Beta 7; question 9 is being read. Beta's neg on 3 stands,
// before Alpha's buzz: Alpha 75, Beta 65
function playedGame() {
  const g = replaceGame();
  g.correct(0, g.A);
  g.correct(1, g.B); g.game.cycles[1].setBonusPartAnswer(1, 'Beta', 10);
  g.correct(2, g.A);
  g.neg(3, g.B); g.correct(3, g.A);
  g.neg(4, g.A);
  g.correct(5, g.B);
  g.correct(6, g.A);
  g.correct(7, g.B);
  return g;
}
const qnums = (g) => g.qbj().match_questions.map((q) => [q.tossup_question.question_number, q.bonus ? q.bonus.question.question_number : null]);
const sameExcept = (a, b, skip) => a.every((x, i) => skip.includes(i) || JSON.stringify(x) === JSON.stringify(b[i]));

test('Replace tossup on an earlier question: a dead replacement leaves later questions, results and bonuses as they were', () => {
  const g = playedGame();
  const view = g.view();
  const nums = qnums(g);
  assert.deepEqual(g.scores(), { Alpha: 75, Beta: 65 });
  assert.equal(g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1', g.bo(1, 'TB'), 'B1'), '');
  assert.equal(g.view()[2], 'TB1/-', 'question 3 reads the replacement, not yet answered');
  assert.ok(sameExcept(g.view(), view, [2]), JSON.stringify(g.view()));
  assert.deepEqual(g.scores(), { Alpha: 55, Beta: 65 }, 'Alpha loses question 3: 10 and its bonus part');
  assert.ok(sameExcept(qnums(g), nums, [2]), JSON.stringify(qnums(g)));
  assert.deepEqual(qnums(g)[2], [21, null]);
  assert.deepEqual(tbUsedIds(g.qbj(), g.tb), ['TU1'], 'the held bonus was not read');
  const held = g.tb.reserve[2];
  assert.equal(heldBonusText(g.tb, held), `Bonus #${held + 1} held for the replacement tossup`);
  assert.ok(keepsThrownOut(g.tb, true, 2) && keepsThrownOut(g.tb, false, 2) && keepsThrownOut(g.tb, false, held));
  assert.equal(g.sync(), false, 'nothing to fix while it stays dead');
});

test('Replace tossup on an earlier question: it keeps its bonus, read again if the replacement is answered', () => {
  const g = playedGame();
  const view = g.view();
  const nums = qnums(g);
  assert.equal(replaceCheck({ cycles: g.game.cycles, cycleIndex: 2, kind: 'tossup', tb: g.tb }).needBonus, false, 'no bonus to pick');
  g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1');
  assert.equal(g.view()[2], 'TB1/-');
  assert.ok(sameExcept(g.view(), view, [2]) && sameExcept(qnums(g), nums, [2]));
  assert.deepEqual(g.scores(), { Alpha: 55, Beta: 65 }, "Alpha's 10 and part on question 3 go");
  assert.equal(heldBonusText(g.tb, 2), 'Bonus #3 held for the replacement tossup');
  g.correct(2, g.B);
  assert.equal(g.sync(), true);
  assert.equal(g.view()[2], 'TB1/PB3', 'Beta answers the replacement and hears the same bonus 3');
  assert.ok(sameExcept(g.view(), view, [2]), JSON.stringify(g.view()));
  assert.deepEqual(g.scores(), { Alpha: 55, Beta: 85 });
  assert.ok(sameExcept(qnums(g), nums, [2]), JSON.stringify(qnums(g)));
  assert.deepEqual(qnums(g)[2], [21, 3]);
  assert.deepEqual(tbUsedIds(g.qbj(), g.tb), ['TU1']);
  // the answer is taken back: bonus 3 is held again, later questions as they were
  g.game.cycles[2].removeCorrectBuzz();
  g.sync();
  assert.equal(g.view()[2], 'TB1/-');
  assert.ok(sameExcept(g.view(), view, [2]) && sameExcept(qnums(g), nums, [2]));
  assert.deepEqual(g.scores(), { Alpha: 55, Beta: 65 });
});

test('Replace tossup on an earlier question nobody answered: a blank bonus is held and scored if answered', () => {
  const g = playedGame();
  const view = g.view();
  const nums = qnums(g);
  assert.equal(replaceCheck({ cycles: g.game.cycles, cycleIndex: 4, kind: 'tossup', tb: g.tb }).needBonus, true, 'question 5 had no bonus');
  assert.equal(g.replace(4, 'tossup', g.tu(1, 'TB'), 'TU1'), 'needbonus', 'the procedure wants the bonus to hold');
  const ph = placeholderBonus(g.game.packet.bonuses);
  assert.deepEqual(ph.values, [10, 10, 10], 'valued as the packet bonuses');
  const held = new MBonus(ph.leadin, ph.parts.map((q, i) => ({ question: q, answer: ph.answers[i], value: ph.values[i] })));
  assert.equal(g.replace(4, 'tossup', g.tu(1, 'TB'), 'TU1', held, ''), '');
  assert.ok(sameExcept(g.view(), view, [4]) && sameExcept(qnums(g), nums, [4]));
  g.correct(4, g.B);
  g.sync();
  assert.ok(g.view()[4].startsWith('TB1/Bonus for the replacement tossup'));
  g.game.cycles[4].setBonusPartAnswer(2, 'Beta', 10);
  assert.deepEqual(g.scores(), { Alpha: 80, Beta: 95 }, "Alpha's neg goes; Beta: 10 and two parts");
  assert.ok(sameExcept(g.view(), view, [4]) && sameExcept(qnums(g), nums, [4]));
  // the TD's real bonus can still go in its place
  assert.equal(g.replace(4, 'bonus', g.bo(1, 'TB'), 'B1'), '');
  assert.equal(g.view()[4], 'TB1/TBB1');
  assert.ok(sameExcept(g.view(), view, [4]) && sameExcept(qnums(g), nums, [4]));
});

test('Replace tossup on an earlier question that only had a neg; the neg goes with it', () => {
  const g = playedGame();
  const view = g.view();
  const nums = qnums(g);
  g.replace(4, 'tossup', g.tu(2, 'TB'), 'TU2', g.bo(1, 'TB'), 'B1');
  assert.deepEqual(g.scores(), { Alpha: 80, Beta: 65 }, "Alpha's neg on question 5 is gone");
  g.correct(4, g.A);
  g.sync();
  assert.equal(g.view()[4], 'TB2/TBB1');
  assert.ok(sameExcept(g.view(), view, [4]), JSON.stringify(g.view()));
  assert.ok(sameExcept(qnums(g), nums, [4]), JSON.stringify(qnums(g)));
  assert.deepEqual(g.scores(), { Alpha: 100, Beta: 65 });
});

test('Replace bonus on an earlier question: the new bonus is read there, later bonuses stay', () => {
  const g = playedGame();
  const view = g.view();
  const nums = qnums(g);
  assert.equal(g.replace(1, 'bonus', g.bo(1, 'TB'), 'B1'), '');
  assert.equal(g.view()[1], 'P2/TBB1');
  assert.ok(sameExcept(g.view(), view, [1]), JSON.stringify(g.view()));
  assert.deepEqual(g.scores(), { Alpha: 75, Beta: 45 }, "Beta's two parts on the thrown-out bonus go");
  g.game.cycles[1].setBonusPartAnswer(2, 'Beta', 10);
  assert.deepEqual(g.scores(), { Alpha: 75, Beta: 55 });
  assert.ok(sameExcept(qnums(g), nums, [1]));
  assert.deepEqual(qnums(g)[1], [2, 21]);
});

test('Replace twice in one slot, and a tossup then its bonus, on an earlier question and on the current one', () => {
  const g = playedGame();
  const view = g.view();
  const nums = qnums(g);
  // replaced, answered, then found to be bad too: the question keeps bonus 3 throughout
  g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1');
  g.correct(2, g.B);
  g.sync();
  assert.equal(g.view()[2], 'TB1/PB3');
  assert.equal(replaceCheck({ cycles: g.game.cycles, cycleIndex: 2, kind: 'tossup', tb: g.tb }).needBonus, false);
  assert.equal(g.replace(2, 'tossup', g.tu(2, 'TB'), 'TU2'), '');
  assert.equal(g.view()[2], 'TB2/-');
  g.correct(2, g.A);
  g.sync();
  assert.equal(g.view()[2], 'TB2/PB3');
  // and its bonus is replaced as well
  assert.equal(g.replace(2, 'bonus', g.bo(3, 'TB'), 'B3'), '');
  assert.equal(g.view()[2], 'TB2/TBB3');
  g.game.cycles[2].setBonusPartAnswer(2, 'Alpha', 10);
  assert.ok(sameExcept(g.view(), view, [2]), JSON.stringify(g.view()));
  assert.ok(sameExcept(qnums(g), nums, [2]), JSON.stringify(qnums(g)));
  assert.deepEqual(g.scores(), { Alpha: 75, Beta: 65 }, 'Alpha: 10 and a part on question 3 again');
  // a dead replacement replaced again keeps the bonus held for it
  const h = playedGame();
  h.replace(4, 'tossup', h.tu(1, 'TB'), 'TU1', h.bo(1, 'TB'), 'B1');
  assert.equal(replaceCheck({ cycles: h.game.cycles, cycleIndex: 4, kind: 'tossup', tb: h.tb }).needBonus, false);
  assert.equal(h.replace(4, 'tossup', h.tu(2, 'TB'), 'TU2'), '');
  h.correct(4, h.B);
  h.sync();
  assert.equal(h.view()[4], 'TB2/TBB1');
  assert.deepEqual(tbUsedIds(h.qbj(), h.tb), ['TU2', 'B1']);
  // on the current question: twice (it keeps bonus 8), then its bonus twice
  g.correct(8, g.A);
  g.replace(8, 'tossup', g.tu(4, 'TB'), 'TU4');
  g.replace(8, 'tossup', g.tu(5, 'TB'), 'TU5');
  g.correct(8, g.B);
  assert.equal(g.view()[8], 'TB5/PB8');
  g.replace(8, 'bonus', g.bo(4, 'TB'), 'B4');
  g.replace(8, 'bonus', g.bo(5, 'TB'), 'B5');
  assert.equal(g.view()[8], 'TB5/TBB5');
  for (let ci = 9; ci < 20; ci++) g.correct(ci, g.A);
  // packet bonus 8 was replaced on question 9, so question 10 reads 9
  assert.equal(g.view()[9], 'P10/PB9');
  assert.equal(g.upload().tossupsRead, 20);
});

test('Undo replace: each kind comes back exactly as it was, results and all, latest first', () => {
  // an earlier tossup that had been answered, then its replacement answered too
  let g = playedGame();
  let before = g.state();
  const tbBefore = JSON.stringify(g.tb);
  g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1');
  assert.deepEqual(undoTop(g.tb), { ci: 2, kind: 'tossup', thrown: 2 });
  g.correct(2, g.B);
  g.sync();
  g.game.cycles[2].setBonusPartAnswer(2, 'Beta', 10);
  assert.notEqual(g.state(), before);
  assert.equal(g.undo(), '');
  assert.equal(g.state(), before, 'Alpha\'s tossup and bonus part are back; the replacement is gone');
  assert.equal(JSON.stringify(g.tb), tbBefore);
  assert.deepEqual(g.scores(), { Alpha: 75, Beta: 65 });
  assert.equal(g.undo(), 'noundo', 'nothing left to take back');
  // an earlier bonus
  g = playedGame();
  before = g.state();
  g.replace(1, 'bonus', g.bo(1, 'TB'), 'B1');
  g.game.cycles[1].setBonusPartAnswer(2, 'Beta', 10);
  assert.equal(g.undo(), '');
  assert.equal(g.state(), before);
  // the current question, which adds a question to the packet and a cycle at the end
  g = playedGame();
  g.neg(8, g.A, 3);
  before = g.state();
  g.replace(8, 'tossup', g.tu(1, 'TB'), 'TU1');
  assert.equal(g.game.packet.tossups.length, 21);
  assert.equal(g.undo(), '');
  assert.equal(g.state(), before, "the neg is back, and the packet and cycles are as they were");
  // an earlier unanswered tossup, with its blank bonus held
  g = playedGame();
  before = g.state();
  const ph = placeholderBonus(g.game.packet.bonuses);
  g.replace(4, 'tossup', g.tu(1, 'TB'), 'TU1', new MBonus(ph.leadin, ph.parts.map((q, i) => ({ question: q, answer: ph.answers[i], value: ph.values[i] }))), '');
  g.correct(4, g.B);
  g.sync();
  assert.equal(g.undo(), '');
  assert.equal(g.state(), before);
  // two replacements come off latest first, and a slot can be replaced again after
  g = playedGame();
  before = g.state();
  g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1');
  const mid = g.state();
  g.replace(5, 'bonus', g.bo(1, 'TB'), 'B1');
  assert.deepEqual(undoTop(g.tb), { ci: 5, kind: 'bonus', thrown: 4 });
  assert.equal(g.undo(), '');
  assert.equal(g.state(), mid);
  assert.equal(g.undo(), '');
  assert.equal(g.state(), before);
  assert.equal(g.replace(2, 'tossup', g.tu(2, 'TB'), 'TU2'), '');
  assert.equal(g.view()[2], 'TB2/-');
  // questions added another way since: the replacement can no longer be taken back
  g = playedGame();
  g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1');
  const p = new MPacket();
  p.setTossups([...g.game.packet.tossups, g.tu(9, 'X')]);
  p.setBonuses(g.game.packet.bonuses);
  p.setName('Packet');
  g.game.loadPacket(p);
  g.tb = { ...g.tb, tuAt: { ...g.tb.tuAt, 21: '' } };
  const now = g.state();
  assert.equal(g.undo(), 'changed');
  assert.equal(g.state(), now, 'and nothing moved');
});

test('Replace: refused, with nothing changed, without a held bonus, a bonus being read, or in a paired format', () => {
  const g = replaceGame();
  for (let ci = 0; ci < 6; ci++) if (ci !== 2) g.correct(ci, g.A);
  g.neg(6, g.B);
  const before = JSON.stringify(g.qbj());
  assert.equal(g.replace(2, 'tossup', g.tu(1, 'TB'), 'TU1'), 'needbonus', 'an earlier unanswered question needs a bonus held for it');
  assert.equal(g.replace(6, 'bonus', g.bo(1, 'TB'), 'B1'), 'nobonus', 'no correct buzz yet');
  assert.equal(JSON.stringify(g.qbj()), before);
  assert.equal(g.game.packet.tossups.length, 20);
  assert.equal(g.game.packet.bonuses.length, 20);
  const paired = replaceGame();
  paired.game.setGameFormat({ ...ACFGameFormat, pairTossupsBonuses: true });
  for (let ci = 0; ci < 3; ci++) paired.correct(ci, paired.A);
  assert.equal(paired.replace(0, 'tossup', paired.tu(1, 'TB'), 'TU1', paired.bo(1, 'TB'), 'B1'), 'paired');
  assert.equal(paired.replace(2, 'tossup', paired.tu(1, 'TB'), 'TU1'), '', 'the latest question still can be');
  // the current tossup, buzzes and all, needs no held bonus
  assert.equal(g.replace(6, 'tossup', g.tu(1, 'TB'), 'TU1'), '');
});

test('reader bundle: the event log keeps a replacement\'s throw-outs and names a held bonus', () => {
  const bundle = readFileSync(new URL('../app/js/read.bundle.js', import.meta.url), 'utf8');
  assert.ok(/isLastThrownOutQuestion&&!\([^)]*\),[^)]*\)\)\.keepsThrownOutHere\(/.test(bundle), 'run npm run build:read');
  assert.ok(/\.thrownOutText\(\w\.isTossup,/.test(bundle), 'run npm run build:read');
  assert.ok(/\.undoHandler\(\w\.cycle,\w\.isTossup,\w\.thrownOutEvent\.questionIndex\)/.test(bundle), 'the latest replacement undoes from the event log');
});

test('reader bundle: the Actions menu carries Replace tossup and Replace bonus', () => {
  const bundle = readFileSync(new URL('../app/js/read.bundle.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('Replace tossup...') && bundle.includes('Replace bonus...'), 'run npm run build:read');
});

test('upload progress: the furthest question reached rides with a reader upload, and the hub reads it', () => {
  assert.deepEqual(gameProgress(3, 20), { at: 3, of: 20 });
  assert.equal(gameProgress(undefined, 20), null, 'a game begun before tracking reports nothing');
  assert.equal(gameProgress(5, undefined), null);
  const withP = JSON.parse(combinedUpload({ tossups_read: 20, match_teams: [] }, 3, '{}', null, null, { at: 7, of: 20 }));
  assert.deepEqual(withP.progress, { at: 7, of: 20 });
  const without = JSON.parse(combinedUpload({ tossups_read: 20, match_teams: [] }, 3, '{}'));
  assert.equal(without.progress, undefined, 'and an upload without it is as before');
  // the hub's reading of a file's summary
  const sum = (o) => fileSummary({ summary: JSON.stringify({ teams: ['A', 'B'], score: [100, 50], protests: [], ...o }) });
  assert.deepEqual(sum({ progress: { at: 7, of: 20 } }).progress, { at: 7, of: 20 });
  assert.equal(sum({}).progress, null, 'old uploads: finished, as before');
  assert.equal(sum({ progress: { at: 'x', of: 20 } }).progress, null);
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
// the TD moves a visitor upload to the other room; fixture games stay put
const demoMoved = await demoPub('/a/demo/files/' + demoUp2.id,
  { method: 'POST', json: { bucket_id: 2 } });
const demoBucketBMoved = await demoPub('/b/demo-b');
const demoAdminMoved = await demoPub('/a/demo');
const demoStateMoved = await demoPub('/pub/demo');
const demoMoveFixture = await demoPub('/a/demo/files/' + demoFixture.entries[0].id,
  { method: 'POST', json: { bucket_id: 2 } }).catch((e) => e);
const demoMoveNowhere = await demoPub('/a/demo/files/' + demoUp2.id,
  { method: 'POST', json: { bucket_id: 99 } }).catch((e) => e);
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
  assert.equal(demoMoved.room_name, demoFixture.rooms[1]);
  assert.ok(demoBucketBMoved.uploads.some((u) => u.id === demoUp2.id), 'moved upload listed in room B');
  assert.equal(demoAdminMoved.files.find((f) => f.id === demoUp2.id).bucket_id, 2);
  assert.equal(demoStateMoved.files.find((f) => f.id === demoUp2.id).room, demoFixture.rooms[1]);
  assert.ok(demoMoveFixture instanceof Error, 'fixture games cannot move');
  assert.ok(demoMoveNowhere instanceof Error, 'unknown room rejected');
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

test('renameTeams: a renamed team keeps its games, byes and pool', () => {
  const sc = {
    v: 1, rooms: [{ name: 'R1', bucket: null }],
    phases: [{ name: 'Prelims', rounds: [
      { round: 1, games: [{ room: 0, a: { team: 'Old' }, b: { team: 'B' } }], byes: [{ team: 'C' }] },
      { round: 2, games: [{ room: 0, a: { team: 'C' }, b: { team: 'B' } }], byes: [{ team: 'Old' }, null] },
      { round: 3, games: [{ room: 0, a: { label: 'A1' }, b: { team: 'Old', from: 'A2' } }], byes: [] },
    ] }],
    pools: { A: ['Old', 'B', 'C'] },
  };
  assert.equal(renameTeams(sc, { Old: 'New' }), 4);
  const names = JSON.stringify(sc);
  assert.ok(!names.includes('"Old"') && validateSchedule(sc, ['New', 'B', 'C']).every((w) => !/roster/i.test(w)), names);
  assert.deepEqual(sc.phases[0].rounds[2].games[0].b, { team: 'New', from: 'A2' });
  assert.deepEqual(sc.pools.A, ['New', 'B', 'C']);
  // two teams trading names
  renameTeams(sc, { B: 'C', C: 'B' });
  assert.deepEqual(sc.pools.A, ['New', 'C', 'B']);
  assert.equal(renameTeams(sc, {}), 0);
});

test('rosterRenames: renamed teams found by their players, then by seed', () => {
  const T = (name, ...players) => ({ name, players });
  const old = [T('A', 'a1', 'a2', 'a3', 'a4'), T('B', 'b1', 'b2', 'b3', 'b4'), T('C', 'c1', 'c2', 'c3')];
  assert.deepEqual(rosterRenames(old, [T('A', 'a1'), T('Bee', 'b1', 'b2', 'b3', 'b4'), T('C', 'c1')]), { B: 'Bee' });
  // renamed and reseeded at once, with a player swapped out
  assert.deepEqual(rosterRenames(old, [T('Bee', 'b1', 'b2', 'b3', 'b9'), T('A', 'a1'), T('C', 'c1')]), { B: 'Bee' });
  // two renamed and swapped seeds: players decide, not position
  assert.deepEqual(rosterRenames(old, [T('Cee', 'c1', 'C2', ' c3 '), T('Bee', 'b1', 'b2'), T('A')]), { B: 'Bee', C: 'Cee' });
  // no players in common: the same seed is the same team
  assert.deepEqual(rosterRenames(old, [T('A'), T('Bee', 'x'), T('C')]), { B: 'Bee' });
  // reordered, dropped, or added: nothing renamed
  assert.deepEqual(rosterRenames(old, [old[2], old[0], old[1]]), {});
  assert.deepEqual(rosterRenames(old, [old[0], old[1]]), {});
  assert.deepEqual(rosterRenames(old, [...old, T('D', 'd1')]), {});
  // a replacement team in a dropped team's seed takes its place
  assert.deepEqual(rosterRenames(old, [old[0], T('New', 'n1', 'n2'), old[2]]), { B: 'New' });
});

/* ---------- roster renames: games played under an earlier name ---------- */

const renameArchive = (await import('../app/archive/2026terrapinopenatusc.js')).default;
const renameGames = renameArchive['/pub/2026terrapinopenatusc/bundle'].entries;
const renameRoster = parseRoster(renameArchive['/pub/2026terrapinopenatusc/roster']);
// a renamed team (UCSD Unc -> UC San Diego) with one renamed player
// (Jake Anderson -> Jacob Anderson), as the editor saves it
function renamedRoster() {
  const next = renameRoster.map((t) => (t.name !== 'UCSD Unc' ? t
    : { ...t, name: 'UC San Diego', players: t.players.map((p) => (p === 'Jake Anderson' ? 'Jacob Anderson' : p)) }));
  return parseRoster(buildRosterQbj('T', carryFormerNames(renameRoster, next,
    { 'UCSD Unc': 'UC San Diego' }, { 'UC San Diego': { 'Jake Anderson': 'Jacob Anderson' } })));
}

test('roster renames: former names round-trip through the roster file, and MODAQ still reads it', () => {
  const r = renamedRoster();
  const t = r.find((x) => x.name === 'UC San Diego');
  assert.deepEqual(t.formerNames, ['UCSD Unc']);
  assert.deepEqual(t.formerPlayers, { 'Jacob Anderson': ['Jake Anderson'] });
  assert.equal(r.filter((x) => x.formerNames || x.formerPlayers).length, 1, 'only the renamed team carries any');
  const reg = parseRegistration(JSON.stringify(buildRosterQbj('T', r)));
  assert.equal(reg.success, true, reg.message);
  assert.ok(reg.value.some((p) => p.teamName === 'UC San Diego' && p.name === 'Jacob Anderson'));
  // a roster with no renames is the file it always was
  assert.ok(!JSON.stringify(buildRosterQbj('T', renameRoster)).includes('_formerNames'));
});

test('roster renames: a roster leaving qb-td drops the former names, keeps the rest', () => {
  const saved = buildRosterQbj('T', [{ name: 'New U', players: ['Annie', 'Bo'], formerNames: ['Old U'],
    formerPlayers: { Annie: ['Ann'] }, marks: { Annie: { ug: true }, Bo: { ug: true } } }], { trackUG: true, trackDiv2: false });
  const out = rosterForExport(saved);
  assert.ok(JSON.stringify(saved).includes('_formerNames'), 'the saved roster keeps them');
  assert.ok(!JSON.stringify(out).includes('_formerNames') && !JSON.stringify(out).includes('Old U') && !JSON.stringify(out).includes('"Ann"'));
  const back = parseRoster(out);
  assert.deepEqual(back.map((t) => [t.name, t.players, t.ug]), [['New U', ['Annie', 'Bo'], true]]);
  assert.deepEqual(back[0].marks, { Annie: { ug: true, d2: false }, Bo: { ug: true, d2: false } });
  assert.equal(JSON.stringify(rosterForExport(renameRoster)), JSON.stringify(renameRoster), 'nothing to drop: the same content');
  const reg = parseRegistration(JSON.stringify(out));
  assert.equal(reg.success, true, reg.message);
});

test('roster renames: a second rename keeps both earlier names; a team taking a freed name starts fresh', () => {
  const once = renamedRoster();
  const twice = parseRoster(buildRosterQbj('T', carryFormerNames(once,
    once.map((t) => (t.name === 'UC San Diego' ? { ...t, name: 'UCSD' } : t)), { 'UC San Diego': 'UCSD' })));
  assert.deepEqual(twice.find((x) => x.name === 'UCSD').formerNames, ['UCSD Unc', 'UC San Diego']);
  assert.deepEqual(twice.find((x) => x.name === 'UCSD').formerPlayers, { 'Jacob Anderson': ['Jake Anderson'] });
  // renamed back: the current name is not also a former one
  const back = carryFormerNames(once, once.map((t) => (t.name === 'UC San Diego' ? { ...t, name: 'UCSD Unc' } : t)),
    { 'UC San Diego': 'UCSD Unc' });
  assert.deepEqual(back.find((x) => x.name === 'UCSD Unc').formerNames, ['UC San Diego']);
  // a new team named UCSD Unc after the rename: no history, and the old
  // name's games stay with it rather than moving to UC San Diego
  const taken = carryFormerNames(renameRoster, [...renamedRoster(), { name: 'UCSD Unc', players: ['Someone'] }],
    { 'UCSD Unc': 'UC San Diego' });
  assert.equal(taken.find((x) => x.name === 'UCSD Unc').formerNames, undefined);
  const takenMap = rosterNameMap(taken);
  assert.ok(!takenMap || !takenMap.teams.has('UCSD Unc'));
  assert.equal(rosterNameMap(renameRoster), null, 'nothing renamed: nothing to map');
});

test('roster renames: games played under the old names count under the new ones', () => {
  const roster = renamedRoster();
  const names = rosterNameMap(roster);
  const before = aggregate(renameGames.map((e) => parseMatch(e.qbj, { filename: e.filename })), roster);
  assert.ok(before.teams.some((t) => t.name === 'UCSD Unc' && !t.rostered), 'without renaming: a split row');
  const parsed = renameGames.map((e) => parseMatch(renameMatch(e.qbj, names), { filename: e.filename }));
  const agg = aggregate(parsed, roster);
  assert.ok(!agg.teams.some((t) => t.name === 'UCSD Unc'));
  assert.ok(agg.teams.every((t) => t.rostered), agg.teams.filter((t) => !t.rostered).map((t) => t.name).join());
  const ucsd = agg.teams.find((t) => t.name === 'UC San Diego');
  const old = aggregate(renameGames.map((e) => parseMatch(e.qbj, { filename: e.filename })), renameRoster)
    .teams.find((t) => t.name === 'UCSD Unc');
  assert.equal(ucsd.gp, old.gp);
  assert.equal(ucsd.w, old.w);
  assert.equal(ucsd.points, old.points);
  assert.ok(agg.players.some((p) => p.name === 'Jacob Anderson' && p.team === 'UC San Diego' && p.gp > 0));
  assert.ok(!agg.players.some((p) => p.name === 'Jake Anderson'));
  // the file itself is renamed throughout (scoresheets and buzzpoints
  // read it), and the original is untouched
  const e = renameGames.find((x) => JSON.stringify(x.qbj).includes('UCSD Unc'));
  const text = JSON.stringify(renameMatch(e.qbj, names));
  assert.ok(!text.includes('UCSD Unc') && !text.includes('Jake Anderson'), 'no old name left in the file');
  assert.ok(JSON.stringify(e.qbj).includes('UCSD Unc'), 'original kept');
  assert.equal(renameMatch(e.qbj, null), e.qbj, 'no renames: the same object');
});

test('roster renames: the exports and the HTML report carry only the new names', () => {
  const roster = renamedRoster();
  const names = rosterNameMap(roster);
  const matches = renameGames.map((e, i) => Object.assign(parseMatch(renameMatch(e.qbj, names), { filename: e.filename }),
    { fileId: e.id, room: e.room, filename: e.filename }));
  const opts = { name: 'T', matches: dedupeMatches(matches), roster };
  for (const [what, text] of [['yft4', serializeYft(opts)], ['yft3', serializeYft3(opts)],
    ['report', buildReport(opts).map((f) => f.text).join('')]]) {
    assert.ok(text.includes('UC San Diego') && text.includes('Jacob Anderson'), what + ': new names');
    assert.ok(!text.includes('UCSD Unc') && !text.includes('Jake Anderson'), what + ': no old names');
  }
});

test('roster renames: an uploaded roster that renames a team records it, and keeps earlier names', () => {
  const once = renamedRoster(); // UCSD Unc -> UC San Diego, saved
  // a file with UC San Diego now called UCSD, matched by its players
  const upload = once.map((t) => (t.name === 'UC San Diego' ? { name: 'UCSD', players: t.players } : { name: t.name, players: t.players }));
  const renames = rosterRenames(once, upload);
  assert.deepEqual(renames, { 'UC San Diego': 'UCSD' });
  const saved = parseRoster(buildRosterQbj('T', carryFormerNames(once, upload, renames)));
  const t = saved.find((x) => x.name === 'UCSD');
  assert.deepEqual(t.formerNames, ['UCSD Unc', 'UC San Diego']);
  assert.deepEqual(t.formerPlayers, { 'Jacob Anderson': ['Jake Anderson'] }, 'player renames carry over by name');
  const agg = aggregate(renameGames.map((e) => parseMatch(renameMatch(e.qbj, rosterNameMap(saved)), { filename: e.filename })), saved);
  assert.ok(agg.teams.every((x) => x.rostered) && agg.teams.some((x) => x.name === 'UCSD' && x.gp > 0));
});

test('roster renames: UG / DII marks follow the renamed player and team', () => {
  const T = { trackUG: true, trackDiv2: false };
  const before = [{ name: 'Old U', players: ['Ann', 'Bo'], marks: { Ann: { ug: true }, Bo: { ug: true } } }];
  const next = [{ name: 'New U', players: ['Annie', 'Bo'], marks: { Annie: { ug: true }, Bo: { ug: true } } }];
  const saved = parseRoster(buildRosterQbj('T', carryFormerNames(before, next, { 'Old U': 'New U' }, { 'New U': { Ann: 'Annie' } }), T));
  assert.equal(saved[0].ug, true);
  assert.deepEqual(saved[0].marks, { Annie: { ug: true, d2: false }, Bo: { ug: true, d2: false } });
  const game = { match_teams: [
    { team: { name: 'Old U', players: [{ name: 'Ann' }] }, match_players: [{ player: { name: 'Ann' }, tossups_heard: 20, answer_counts: [{ answer: { value: 10 }, number: 1 }] }], bonus_points: 0 },
    { team: { name: 'Other', players: [{ name: 'Zed' }] }, match_players: [{ player: { name: 'Zed' }, tossups_heard: 20, answer_counts: [] }], bonus_points: 0 }],
  tossups_read: 20, _round: 1 };
  const agg = aggregate([parseMatch(renameMatch(game, rosterNameMap(saved)))], [...saved, { name: 'Other', players: ['Zed'] }]);
  const annie = agg.players.find((p) => p.name === 'Annie');
  assert.ok(annie && annie.ug && annie.team === 'New U');
});

test('roster renames: names held as plain strings, camelCase keys, and a whole-file wrapper', () => {
  const map = rosterNameMap([{ name: 'New', players: ['Pat'], formerNames: ['Old'], formerPlayers: { Pat: ['Patrick'] } }]);
  const qbj = { objects: [{ type: 'Match', matchTeams: [{ team: 'Old', matchPlayers: [{ player: 'Patrick' }], lineups: [{ players: ['Patrick'] }] },
    { team: 'Other', matchPlayers: [] }], matchQuestions: [{ buzzes: [{ team: 'Old', player: 'Patrick' }] }] }] };
  const out = renameMatch(qbj, map);
  const m = out.objects[0];
  assert.equal(m.matchTeams[0].team, 'New');
  assert.equal(m.matchTeams[0].matchPlayers[0].player, 'Pat');
  assert.equal(m.matchTeams[0].lineups[0].players[0], 'Pat');
  assert.deepEqual(m.matchQuestions[0].buzzes[0], { team: 'New', player: 'Pat' });
  assert.equal(m.matchTeams[1].team, 'Other');
  assert.equal(qbj.objects[0].matchTeams[0].team, 'Old', 'original untouched');
  // a player only matches on their own team
  const other = renameMatch({ match_teams: [{ team: { name: 'Other' }, match_players: [{ player: { name: 'Patrick' } }] }] }, map);
  assert.equal(other.match_teams[0].match_players[0].player.name, 'Patrick');
});

test('roster renames: a correction uploaded under the new name replaces the original game', () => {
  const names = rosterNameMap(renamedRoster());
  const e = renameGames.find((x) => JSON.stringify(x.qbj).includes('UCSD Unc'));
  const original = parseMatch(renameMatch(e.qbj, names), { filename: e.filename });
  original.fileId = 1;
  // the correction, as a reader would upload it after the rename
  const fixed = parseMatch(JSON.parse(JSON.stringify(e.qbj).replaceAll('UCSD Unc', 'UC San Diego')
    .replaceAll('Jake Anderson', 'Jacob Anderson')), { filename: e.filename });
  fixed.fileId = 2;
  assert.equal(dedupeMatches([original, fixed]).length, 1);
  assert.equal(dedupeMatches([original, fixed])[0].fileId, 2);
});

test('tradePools: two teams trade every prelim game and their pools, nothing else', () => {
  const teams = Array.from({ length: 12 }, (_, i) => 'T' + (i + 1));
  const rooms = Array.from({ length: 6 }, (_, i) => ({ name: 'R' + i, bucket: null }));
  const sc = buildSchedule('pools3', teams, rooms);
  const before = JSON.parse(JSON.stringify(sc));
  const [x] = sc.pools.A;
  const [y] = sc.pools.B;
  const opp = (s, t) => s.phases[0].rounds.map((r) => {
    const g = r.games.find((gg) => gg.a.team === t || gg.b.team === t);
    return g ? [g.room, g.a.team === t ? g.b.team : g.a.team] : 'bye';
  });
  assert.equal(tradePools(sc, x, y), true);
  assert.equal(poolOf(sc, x), 'B');
  assert.equal(poolOf(sc, y), 'A');
  assert.equal(sc.pools.A.indexOf(y), before.pools.A.indexOf(x)); // the same seed place
  const swapName = (n) => (n === x ? y : n === y ? x : n);
  // each takes the other's rooms and opponents, round by round
  assert.deepEqual(opp(sc, x), opp(before, y).map((o) => (o === 'bye' ? o : [o[0], swapName(o[1])])));
  assert.deepEqual(opp(sc, y), opp(before, x).map((o) => (o === 'bye' ? o : [o[0], swapName(o[1])])));
  assert.deepEqual(sc.phases.slice(1), before.phases.slice(1)); // playoffs untouched
  assert.deepEqual(scheduleChecks(sc), []);
  // every prelim game is still inside one pool
  for (const r of sc.phases[0].rounds) for (const g of r.games) assert.equal(poolOf(sc, g.a.team), poolOf(sc, g.b.team));
  // trading back restores it exactly
  tradePools(sc, x, y);
  assert.deepEqual(sc, before);
});

test('tradePools: refuses teams in one pool, or not in a pool', () => {
  const teams = Array.from({ length: 12 }, (_, i) => 'T' + (i + 1));
  const sc = buildSchedule('pools3', teams, Array.from({ length: 6 }, (_, i) => ({ name: 'R' + i, bucket: null })));
  const before = JSON.stringify(sc);
  assert.equal(tradePools(sc, sc.pools.A[0], sc.pools.A[1]), false);
  assert.equal(tradePools(sc, sc.pools.A[0], 'Nobody'), false);
  assert.equal(JSON.stringify(sc), before);
  assert.equal(poolOf(sc, 'Nobody'), null);
});

test('tradesLocked: open until a prelim round has a game in', () => {
  const teams = Array.from({ length: 12 }, (_, i) => 'T' + (i + 1));
  const sc = buildSchedule('pools3', teams, Array.from({ length: 6 }, (_, i) => ({ name: 'R' + i, bucket: null })));
  const prelims = sc.phases[0].rounds.map((r) => r.round);
  const playoff = sc.phases[1].rounds[0].round;
  assert.equal(tradesLocked(sc, new Set()), false);
  assert.equal(tradesLocked(sc, new Set([playoff])), false);
  assert.equal(tradesLocked(sc, new Set([prelims[0]])), true);
  assert.equal(tradesLocked(sc, new Set([prelims[prelims.length - 1]])), true);
  // a format without pools has nothing to trade
  assert.equal(tradesLocked(buildSchedule('rr', teams.slice(0, 6), Array.from({ length: 3 }, (_, i) => ({ name: 'R' + i, bucket: null }))), new Set()), true);
});

test('removeTeam: a dropped team leaves open game slots, no byes, no pool place', () => {
  const sc = { phases: [{ rounds: [
    { round: 1, games: [{ room: 0, a: { team: 'X' }, b: { team: 'B' } }], byes: [{ team: 'C' }, null] },
    { round: 2, games: [{ room: 0, a: { team: 'C' }, b: { team: 'B' } }], byes: [{ team: 'X' }] },
  ] }], pools: { A: ['X', 'B', 'C'] } };
  assert.equal(removeTeam(sc, 'X'), 3);
  assert.equal(sc.phases[0].rounds[0].games[0].a, null);
  assert.deepEqual(sc.phases[0].rounds[0].byes, [{ team: 'C' }, null]);
  assert.deepEqual(sc.phases[0].rounds[1].byes, []);
  assert.deepEqual(sc.pools.A, ['B', 'C']);
});

test('protestRows: protests lodged before the upload show until the game arrives', () => {
  const sum = (teams, score, protests) => JSON.stringify({ teams, score, protests });
  const tu4 = { kind: 'tu', q: 4, team: 'Alpha', word: 9, given: 'x', reason: 'r', to: 'Alpha', from: 'Beta', gain: 20, loss: 0, detail: { tu: 10, neg: 0, bonus: 10 } };
  const tu9 = { ...tu4, q: 9 };
  const live = [
    { bucket_id: 1, round: 2, game: 'g1', at: 500, summary: JSON.stringify({ teams: ['Alpha', 'Beta'], protests: [tu4] }) },
    { bucket_id: 2, round: 2, game: 'g2', at: 500, summary: JSON.stringify({ teams: ['Gamma', 'Delta'], protests: [tu4] }) },
    { bucket_id: 1, round: 2, game: 'bad', at: 500, summary: '{not json' },
  ];
  // nothing uploaded yet: both games' protests are listed, with no score
  let { rows } = protestRows([], {}, (b) => 'Room ' + b, live);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].live, rows[0].score, rows[0].flips, rows[0].known], [true, null, false, true]);
  assert.equal(rows[0].key, rulingKey(2, ['Alpha', 'Beta'], tu4));
  assert.deepEqual(swingLines(rows[0]), ['+20 Alpha: 0 neg back, 10 tossup, 10 bonus']);
  // a ruling made while the game is in progress keys the same as the upload's
  ({ rows } = protestRows([], { [rulingKey(2, ['Beta', 'Alpha'], tu4)]: { r: 'upheld', note: '', at: 600 } }, () => 'x', live));
  assert.equal(rows.find((r) => r.teams[0] === 'Alpha').ruling, 'upheld');
  // the game uploaded after them: the upload's rows replace them
  const up = { id: 7, bucket_id: 1, round: 2, kind: 'combined', error: null, created: 800, summary: sum(['Beta', 'Alpha'], [100, 90], [tu4]) };
  ({ rows } = protestRows([up], {}, () => 'x', live));
  assert.deepEqual(rows.map((r) => [r.file.id, !!r.live, r.teams[0]]).sort(), [[0, true, 'Gamma'], [7, false, 'Beta']]);
  // a protest lodged after the upload is added; the ones it has are not doubled
  const later = [{ ...live[0], at: 900, summary: JSON.stringify({ teams: ['Alpha', 'Beta'], protests: [tu4, tu9] }) }];
  ({ rows } = protestRows([up], {}, () => 'x', later));
  assert.deepEqual(rows.map((r) => [r.file.id, r.p.q]).sort(), [[0, 9], [7, 4]]);
});

test('protestRows: a renamed team lists under its new name, and keeps rulings made before the rename', () => {
  const sum = (teams, score, protests) => JSON.stringify({ teams, score, protests });
  const tu4 = { kind: 'tu', q: 4, team: 'UCSD Unc', word: 9, given: 'x', reason: 'r', to: 'UCSD Unc', from: 'Beta', gain: 20, loss: 0, detail: { tu: 10, neg: 0, bonus: 10 } };
  const names = rosterNameMap([{ name: 'UC San Diego', players: ['P'], formerNames: ['UCSD Unc'] }, { name: 'Beta', players: ['Q'] }]);
  const old = { id: 7, bucket_id: 1, round: 2, kind: 'combined', error: null, created: 800, summary: sum(['UCSD Unc', 'Beta'], [100, 110], [tu4]) };
  // ruled while the team still had its old name
  const rulings = { [rulingKey(2, ['UCSD Unc', 'Beta'], tu4)]: { r: 'upheld', note: 'n', at: 900 } };
  let { rows } = protestRows([old], rulings, () => 'x', [], names);
  assert.deepEqual(rows[0].teams, ['UC San Diego', 'Beta']);
  assert.deepEqual([rows[0].p.team, rows[0].p.to, rows[0].p.from], ['UC San Diego', 'UC San Diego', 'Beta']);
  assert.equal(rows[0].ruling, 'upheld', 'the ruling made under the old name');
  assert.equal(rows[0].key, rulingKey(2, ['UC San Diego', 'Beta'], tu4), 'a new ruling files under the new name');
  assert.deepEqual(rows[0].upheld, [120, 110]);
  // a correction uploaded under the new name supersedes the old upload
  const fixed = { ...old, id: 9, created: 1000, summary: sum(['UC San Diego', 'Beta'], [100, 110], [{ ...tu4, team: 'UC San Diego', to: 'UC San Diego' }]) };
  ({ rows } = protestRows([old, fixed], rulings, () => 'x', [], names));
  assert.deepEqual(rows.map((r) => [r.file.id, r.superseded]).sort(), [[7, true], [9, false]]);
  // a protest lodged live, under the old name
  const live = [{ bucket_id: 1, round: 3, game: 'g', at: 500, summary: JSON.stringify({ teams: ['UCSD Unc', 'Beta'], protests: [tu4, 'junk'] }) }];
  ({ rows } = protestRows([], {}, () => 'x', live, names));
  assert.deepEqual([rows.length, rows[0].teams[0], rows[0].p.to], [1, 'UC San Diego', 'UC San Diego']);
  // no roster renames: as before
  ({ rows } = protestRows([old], rulings, () => 'x', []));
  assert.equal(rows[0].teams[0], 'UCSD Unc');
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

test('buildSite: a mirror\'s roster renames apply to its games, and only to its own', () => {
  // at North, Team A is now Team Alpha and its Ann is Annie (worker.js mirrorRenames)
  const names = { teams: { 'Team A': 'Team Alpha' }, players: { 'Team Alpha\nAnn': 'Annie' } };
  const games = [setGame(1, 1, 'Team A', 'Team B', [[1, 'Team A', 'Ann', 10, 15]], [1, 10])];
  const north = buildSite({ id: 1, label: 'North', vmap: { 1: [1, 1] }, done: [1], names }, games);
  const south = buildSite({ id: 2, label: 'South', vmap: { 1: [1, 1] }, done: [1] }, games);
  const st = setStandings([north, south]);
  assert.deepEqual(st.teams.filter((t) => t.site === 'North').map((t) => t.name).sort(), ['Team Alpha', 'Team B']);
  assert.ok(st.players.some((p) => p.site === 'North' && p.name === 'Annie' && p.team === 'Team Alpha'));
  assert.ok(!st.players.some((p) => p.site === 'North' && p.name === 'Ann'));
  assert.ok(st.players.some((p) => p.site === 'South' && p.name === 'Ann' && p.team === 'Team A'), 'another mirror keeps its names');
  assert.ok(!JSON.stringify(north.entries).includes('"Ann"'), 'buzzpoints read the renamed game');
  assert.equal(siteNames({ names: null }), null);
});

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
  const good = { tossups: [TU(1), TU(2)], bonuses: [BN(1), BN(2)].map((b) => ({ ...b, values: [10, 10, 10] })) };
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
    '2 parts', '3 answers for 2 parts — MODAQ will not load this packet', 'no lead-in',
    'part 1 still carries its "[10]" marker'].sort());
  assert.ok(b.warnings.includes('3 tossups but 1 bonuses'));
  assert.ok(b.warnings.some((w) => /share an answerline \(Author 1\)/.test(w)));
  assert.ok(b.warnings.some((w) => /2 tossups without category data/.test(w)));
  assert.equal(b.count, b.warnings.length + b.tossups.flatMap((t) => t.warnings).length + b.bonuses[0].warnings.length);
});

test('checkPacket: says so when MODAQ\'s own loader would refuse the packet', () => {
  // locked against the installed MODAQ: each of these fails its loadPacket
  // (a throw, or a refusal with no packet), and the review names it
  const { loadPacket } = createRequire(import.meta.url)('modaq/src/components/PacketLoaderController.js');
  const loads = (p) => {
    try { return !!loadPacket({ uiState: { setPacketStatus() {} } }, JSON.parse(JSON.stringify(p))); } catch (e) { return false; }
  };
  const tu = { ...TU(1), category: 'History' };
  const bn = { ...BN(1), values: [10, 10, 10] };
  const NO = /MODAQ will not load this packet$/;
  const flagged = (p) => checkPacket(p).tossups.concat(checkPacket(p).bonuses).flatMap((q) => q.warnings).filter((w) => NO.test(w));
  const refused = {
    'no point values': { bonuses: [{ ...bn, values: undefined }] },
    'an empty values list': { bonuses: [{ ...bn, values: [] }] },
    'too few values': { bonuses: [{ ...bn, values: [10, 10] }] },
    'no parts': { bonuses: [{ ...bn, parts: undefined }] },
    'no answers': { bonuses: [{ ...bn, answers: undefined }] },
    'an answer that is not text': { bonuses: [{ ...bn, answers: ['A1', null, 'C1'] }] },
    'a part that is not text': { bonuses: [{ ...bn, parts: ['Part one of 1', 5, 'Part three of 1'] }] },
    'no lead-in at all': { bonuses: [{ ...bn, leadin: undefined }] },
    'a bonus that is not one': { bonuses: [null] },
    'tossup metadata that is not text': { tossups: [{ ...tu, metadata: { author: 'x' } }] },
    'bonus metadata that is not text': { bonuses: [{ ...bn, metadata: 7 }] },
  };
  for (const [what, p] of Object.entries(refused)) {
    const packet = { tossups: [tu], bonuses: [bn], ...p };
    assert.equal(loads(packet), false, what + ': MODAQ refuses it');
    assert.equal(flagged(packet).length, 1, what + ': ' + JSON.stringify(flagged(packet)));
  }
  assert.deepEqual(flagged({ tossups: [tu], bonuses: [{ ...bn, values: undefined }] }), ['no point values — MODAQ will not load this packet']);
  // what MODAQ loads draws no such warning, odd as it may look
  for (const p of [{ tossups: [tu], bonuses: [bn] }, { tossups: [tu], bonuses: [{ ...bn, leadin: '' }] },
    { tossups: [{ ...tu, metadata: '' }], bonuses: [{ ...bn, values: ['10', '10', '10'] }] }, { tossups: [tu] }]) {
    assert.equal(loads(p), true, JSON.stringify(p));
    assert.deepEqual(flagged(p), []);
  }
});

/* ---------- per-bracket rounds (brackets.js) ---------- */

const BK12 = ['Stanford', 'Berkeley', 'UIUC', 'ASU', 'Chicago', 'Michigan', 'Yale', 'Penn', 'Rutgers', 'Columbia', 'Minnesota', 'Georgia Tech'];
const BR6 = [1, 2, 3, 4, 5, 6].map((i) => ({ name: 'Room ' + i, bucket: 100 + i }));
const pools2 = () => buildSchedule('pools2', BK12, BR6);
const poolRoom = (m, key) => bkRooms(m, key, 1)[0];

test('brackets: a two-pool schedule is multi, a round robin is not', () => {
  const m = bracketModel(pools2());
  assert.equal(m.multi, true);
  assert.deepEqual(m.phases.map((p) => [p.first, p.last, p.keys]), [[1, 5, ['A', 'B']], [6, 8, ['CH', 'CO']]]);
  assert.deepEqual(m.brackets.map((b) => [b.key, b.color]), [['A', 0], ['B', 1], ['CH', 0], ['CO', 1]]);
  const rr = bracketModel(buildSchedule('rr', BK12, BR6));
  assert.equal(rr.multi, false);
  assert.equal(bracketModel(null), null);
  // one bracket: nothing keeps its own round
  assert.deepEqual(bracketRounds(rr, 3, '{"ph1":5}'), { phase: null, rounds: {} });
});

test('brackets: stored rounds read at least current_round and at most the phase end', () => {
  const m = bracketModel(pools2());
  assert.deepEqual(bracketRounds(m, 2, '{"A":4}').rounds, { A: 4, B: 2 });
  assert.deepEqual(bracketRounds(m, 3, { A: 1, B: 9 }).rounds, { A: 3, B: 5 });
  assert.deepEqual(bracketRounds(m, 7, '{}').rounds, { CH: 7, CO: 7 });
  assert.equal(bracketRounds(m, 40, '{}').phase, null, 'past the schedule: current_round only');
});

test('brackets: a room is on its bracket\'s round; idle rooms on current_round', () => {
  const m = bracketModel(pools2());
  const st = bracketRounds(m, 2, { A: 3, B: 2 });
  const a = poolRoom(m, 'A');
  const b = poolRoom(m, 'B');
  assert.equal(roomRound(m, st, a, 2), 3);
  assert.equal(roomRound(m, st, b, 2), 2);
  assert.equal(roomBracket(m, st, a, 2), 'A');
  assert.equal(roomRound(m, st, null, 2), 2);
  assert.equal(roomIndexOf(m.schedule, { id: 102, room_name: 'x' }), 1, 'bucket link');
  assert.equal(roomIndexOf(m.schedule, { id: 999, room_name: ' room 3 ' }), 2, 'name fallback');
  assert.equal(roomIndexOf(m.schedule, { id: 999, room_name: 'nope' }), null);
});

test('brackets: a room rename follows the schedule room the bucket resolves to', () => {
  const sched = () => ({ rooms: [{ name: 'Room 1', bucket: 101 }, { name: 'Room 2', bucket: null },
    { name: 'Room 3', bucket: 103 }, { name: 'Room 4', bucket: 77 }] });
  // linked: the link wins over any name
  let s = sched();
  assert.equal(followRoomRename(s, { id: 101, room_name: 'Room 1' }, 'Library'), true);
  assert.deepEqual(s.rooms.map((r) => r.name), ['Library', 'Room 2', 'Room 3', 'Room 4']);
  // matched by name only (a room made after the schedule): it keeps matching
  s = sched();
  assert.equal(followRoomRename(s, { id: 102, room_name: ' room 2 ' }, 'Gym', [101, 102, 103]), true);
  assert.equal(s.rooms[1].name, 'Gym');
  assert.equal(roomIndexOf(s, { id: 102, room_name: 'Gym' }), 1);
  assert.equal(s.rooms[1].bucket, null, 'renamed, not linked');
  // a name match never takes a room linked to another of the rooms
  s = sched();
  assert.equal(followRoomRename(s, { id: 104, room_name: 'Room 3' }, 'Annex', [101, 102, 103, 104]), false);
  assert.equal(s.rooms[2].name, 'Room 3');
  // ...but a link to a room since removed is no claim
  s = sched();
  assert.equal(followRoomRename(s, { id: 104, room_name: 'Room 4' }, 'Annex', [101, 102, 103, 104]), true);
  assert.equal(s.rooms[3].name, 'Annex');
  // a name another schedule room has: the schedule stays as it was and the
  // room now matches that one, rather than the schedule gaining a twin
  s = { rooms: [{ name: 'Room 1', bucket: null }, { name: 'Library', bucket: null }] };
  assert.equal(followRoomRename(s, { id: 5, room_name: 'Room 1' }, ' library ', [5]), false);
  assert.deepEqual(s.rooms.map((r) => r.name), ['Room 1', 'Library']);
  assert.equal(roomIndexOf(s, { id: 5, room_name: ' library ' }), 1);
  // (a linked room's schedule rooms follow it whatever the name, as always)
  s = sched();
  assert.equal(followRoomRename(s, { id: 101, room_name: 'Room 1' }, 'Room 2'), true);
  assert.equal(s.rooms[0].name, 'Room 2');
  // ...while its own name in other letters is no clash
  s = sched();
  assert.equal(followRoomRename(s, { id: 102, room_name: 'Room 2' }, 'ROOM 2', [102]), true);
  assert.equal(s.rooms[1].name, 'ROOM 2');
  // nothing to follow, or nothing moved
  assert.equal(followRoomRename(sched(), { id: 105, room_name: 'Room 9' }, 'X', [105]), false);
  assert.equal(followRoomRename(sched(), { id: 101, room_name: 'Room 1' }, 'Room 1'), false);
  assert.equal(followRoomRename(null, { id: 101, room_name: 'Room 1' }, 'X'), false);
});

test('brackets: auto-advance moves a finished bracket one round and nothing else', () => {
  const m = bracketModel(pools2());
  const st = bracketRounds(m, 2, {});
  const aRooms = new Set(bkRooms(m, 'A', 2));
  const bRooms = new Set(bkRooms(m, 'B', 2));
  const env = (startedAt, packets = [3, 4, 5, 6]) => ({
    matched: () => true, started: (r) => startedAt[r] || new Set(), hasPacket: (r) => packets.includes(r),
  });
  assert.deepEqual(autoAdvance(m, st, 2, env({ 2: aRooms })), { current: 2, rounds: { A: 3, B: 2 } });
  assert.equal(autoAdvance(m, st, 2, env({ 2: aRooms }), 'B'), null, 'a B room\'s start never moves A');
  assert.equal(autoAdvance(m, st, 2, env({ 2: aRooms }, [])), null, 'no packet, no round');
  assert.equal(autoAdvance(m, st, 2, { ...env({ 2: aRooms }), matched: (i) => !aRooms.has(i) }), null, 'a room with no link never opens');
  assert.deepEqual(autoAdvance(m, st, 2, env({ 2: new Set([...aRooms, ...bRooms]) })), { current: 3, rounds: { A: 3, B: 3 } });
  // one round per call: starts left over from before a set-back don't cascade
  const back = bracketRounds(m, 2, {});
  const all = new Set([...aRooms, ...bRooms]);
  assert.deepEqual(autoAdvance(m, back, 2, env({ 2: all, 3: all, 4: all })), { current: 3, rounds: { A: 3, B: 3 } });
});

test('brackets: the playoffs open together once every pool has started its last round', () => {
  const m = bracketModel(pools2());
  const aRooms = bkRooms(m, 'A', 5);
  const bRooms = bkRooms(m, 'B', 5);
  const env = (s) => ({ matched: () => true, started: (r) => (r === 5 ? s : new Set()), hasPacket: () => true });
  const st = bracketRounds(m, 5, { A: 5, B: 5 });
  assert.equal(autoAdvance(m, st, 5, env(new Set(aRooms))), null, 'Pool B still reading round 5');
  assert.deepEqual(autoAdvance(m, st, 5, env(new Set([...aRooms, ...bRooms]))), { current: 6, rounds: {} });
  // Pool A done, Pool B a round behind: A waits at the phase end
  const st2 = bracketRounds(m, 4, { A: 5, B: 4 });
  assert.equal(autoAdvance(m, st2, 4, env(new Set(aRooms)), 'A'), null);
  assert.deepEqual(bracketRounds(m, 6, '{}').rounds, { CH: 6, CO: 6 });
});

test('brackets: Advance all and one bracket at a time', () => {
  const m = bracketModel(pools2());
  assert.deepEqual(advanceAll(m, bracketRounds(m, 3, { A: 4, B: 3 }), 3), { current: 5, rounds: { A: 5, B: 5 } });
  assert.deepEqual(advanceAll(m, bracketRounds(m, 4, { A: 5, B: 4 }), 4), { current: 5, rounds: { A: 5, B: 5 } });
  assert.deepEqual(advanceAll(m, bracketRounds(m, 5, { A: 5, B: 5 }), 5), { current: 6, rounds: {} });
  assert.deepEqual(advanceAll(m, bracketRounds(m, 8, {}), 8), { current: 9, rounds: {} }, 'past the last phase');
  assert.deepEqual(advanceBracket(m, bracketRounds(m, 2, {}), 'A'), { current: 2, rounds: { A: 3, B: 2 } });
  assert.equal(advanceBracket(m, bracketRounds(m, 5, { A: 5, B: 5 }), 'A'), null, 'at the phase end');
  const rr = bracketModel(buildSchedule('rr', BK12, BR6));
  assert.deepEqual(advanceAll(rr, bracketRounds(rr, 4, null), 4), { current: 5, rounds: {} });
});

test('brackets: filled playoff slots keep their label and still tag', () => {
  const s = pools2();
  for (const ph of s.phases) for (const r of ph.rounds) for (const g of r.games) delete g.bracket;
  delete s.brackets;
  fillPlaceholders(s, { A: s.pools.A, B: s.pools.B });
  const g = s.phases[1].rounds[0].games[0];
  assert.equal(g.a.from, 'A1');
  assert.equal(slotLabel(g.a), s.pools.A[0] + ' (A1)');
  const m = bracketModel(s);
  assert.deepEqual(m.phases[1].keys, ['CH', 'CO']);
  assert.equal(slotLabel({ label: 'B2' }), 'Pool B 2nd');
  assert.equal(slotLabel({ label: 'C11' }), 'Pool C 11th');
  assert.equal(slotLabel({ team: 'Yale' }), 'Yale');
  assert.equal(liveLayout(1), 'plain');
  assert.equal(liveLayout(2), 'columns');
  assert.equal(liveLayout(12), 'columns');
});

/* ---------- plan.js: the format picker's builder ---------- */

const planPhase = (name, o = {}) => ({ name, kind: 'pools', groups: 1, top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1,
  carry: true, reset: true, byes: false, sizes: null, parallelTop: false, share: false, n: 3, mode: 'rotate', ...o });
const planTeams = (t) => Array.from({ length: t }, (_, i) => 'T' + (i + 1));
const planRooms = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Room ' + (i + 1), bucket: null }));
const pairsByPhase = (s) => s.phases.map((p) => p.rounds.flatMap((r) => r.games.map((g) => [slotText(g.a), slotText(g.b)].sort().join(' v '))).sort());
const namesOf = (s) => s.phases.map((p) => p.name).join('|') + ' / ' + s.brackets.map((b) => b.key + '=' + b.name + '@' + b.phase).join(' ');
// today's engine defaults as plans (the picker's mapping)
function engineAsPlan(f, t) {
  const rr = /^rr(\d?)$/.exec(f.key);
  if (rr) {
    const k = Number(rr[1]) || 1;
    return Array.from({ length: k }, (_, i) => planPhase(k === 1 ? 'Round robin' : 'Round robin ' + (i + 1), i ? { same: true } : {}));
  }
  const m = /^pools(\d)(x2)?$/.exec(f.key);
  const k = Number(m[1]);
  return [planPhase('Prelims', { groups: k }), planPhase('Playoffs', { per: k === 2 ? -1 : m[2] ? 2 : 1 })];
}

test('plan: every engine default format comes out identical (pools, games, rounds, names)', () => {
  let n = 0;
  for (let t = 6; t <= 30; t++) {
    for (const f of allFormats(t)) {
      const teams = planTeams(t);
      const rooms = planRooms(f.roomsNeeded);
      const eng = buildSchedule(f.key, teams, rooms, {});
      const mine = buildPlan(teams, rooms, engineAsPlan(f, t), 'snake', 1);
      const label = `${t} ${f.key}`;
      assert.deepEqual(mine.phases.map((p) => p.rounds.length), eng.phases.map((p) => p.rounds.length), label + ' rounds');
      assert.deepEqual(pairsByPhase(mine), pairsByPhase(eng), label + ' games');
      assert.deepEqual(mine.pools || null, eng.pools || null, label + ' pools');
      assert.equal(namesOf(mine), namesOf(eng), label + ' names');
      n++;
    }
  }
  assert.equal(n, 105);
});

// hdwhite's formats as plans (the picker's mapping)
function hdAsPlan(f) {
  const out = [];
  for (let c = 0; c < f.cycles; c++) {
    const one = f.k === 1 && !f.sizes;
    out.push(planPhase(one ? (f.cycles > 1 ? 'Round robin ' + (c + 1) : 'Round robin') : 'Prelims', { groups: f.k, same: c > 0, byes: f.byes }));
  }
  if (f.sizes) out.push(planPhase('Playoffs', { sizes: f.sizes, parallelTop: f.parallelTop, carry: f.k > 1 && !f.repeat,
    per: f.k === 2 && f.sizes.length === 2 ? -1 : 1 }));
  return out;
}

test('plan: pools by hand: the TD\'s pools are the prelim pools; playoffs still follow the places', () => {
  const teams = planTeams(12);
  const rooms = planRooms(6);
  const hand = [[teams[0], teams[1], teams[4], teams[5], teams[8]], [teams[2], teams[3], teams[6], teams[7], teams[9], teams[10], teams[11]]];
  const phases = [
    { name: 'Prelims', kind: 'pools', groups: 2, sizes: [5, 7], hand, mode: 'rotate' },
    { name: 'Playoffs', kind: 'pools', sizes: [6, 6], per: 1, carry: true, mode: 'rotate' },
  ];
  const s = buildPlan(teams, rooms, phases, 'hand', 1);
  assert.deepEqual(s.pools, { A: hand[0], B: hand[1] });
  for (const r of s.phases[0].rounds) for (const g of r.games) {
    const k = hand.findIndex((h) => h.includes(g.a.team));
    assert.ok(hand[k].includes(g.b.team), 'a prelim game stays in its pool');
  }
  const pairs = new Set(s.phases[0].rounds.flatMap((r) => r.games.map((g) => [g.a.team, g.b.team].sort().join('|'))));
  assert.equal(pairs.size, 10 + 21, 'a full round robin in each pool');
  assert.ok(s.phases[1].rounds.flat().every((r) => r.games.every((g) => g.a.label && g.b.label)), 'playoffs are places');
  // the same plan seeded by snake ignores the hand
  assert.deepEqual(buildPlan(teams, rooms, phases.map((p) => ({ ...p, sizes: p.sizes && [6, 6] })), 'snake', 1).pools.A,
    [teams[0], teams[3], teams[4], teams[7], teams[8], teams[11]]);
});

test('plan: pools by hand that don\'t fit the roster fall back to the snake', () => {
  const teams = planTeams(8);
  const snake = planGroups(teams, [{ name: 'P', kind: 'pools', groups: 2 }], 'snake', () => 0.5)[0].map((g) => g.members.map((m) => m.id));
  const bad = [
    [[teams[0], teams[1], teams[2], teams[3]], [teams[4], teams[5], teams[6]]],            // a team missing
    [[teams[0], teams[1], teams[2], teams[3]], [teams[3], teams[4], teams[5], teams[6], teams[7]]], // a team twice
    [[teams[0]], teams.slice(1)],                                                           // a pool of one
    [teams.slice()],                                                                        // one pool
    [[...teams.slice(0, 4), 'Nobody'], teams.slice(4)],                                     // a team not on the roster
  ];
  for (const hand of bad) {
    assert.equal(handOk(hand, teams), false, JSON.stringify(hand));
    const got = planGroups(teams, [{ name: 'P', kind: 'pools', groups: 2, hand }], 'hand', () => 0.5)[0].map((g) => g.members.map((m) => m.id));
    assert.deepEqual(got, snake);
  }
  assert.equal(handOk([teams.slice(0, 3), teams.slice(3)], teams), true);
});

test('plan: hdwhite formats build with hdwhite round counts (14b and 21a one round shorter)', () => {
  const shorter = [];
  let n = 0;
  for (const [t, list] of Object.entries(HDWHITE)) {
    for (const f of list) {
      const s = buildPlan(planTeams(Number(t)), planRooms(f.rooms), hdAsPlan(f), 'snake', 1);
      const rounds = s.phases.reduce((k, p) => k + p.rounds.length, 0);
      assert.ok(Math.max(...s.phases.flatMap((p) => p.rounds.map((r) => r.games.length))) <= f.rooms, f.key + ' fits hdwhite\'s rooms');
      assert.deepEqual(scheduleChecks(s), [], f.key + ' checks');
      if (rounds !== f.rounds) { assert.equal(rounds, f.rounds - 1, f.key); shorter.push(f.key); }
      n++;
    }
  }
  assert.equal(n, 61);
  assert.deepEqual(shorter.sort(), ['14b', '21a']);
});

test('plan: hdwhite 23c (8/8/7 into 6/6/6/5) is the engine’s pools3x2 — the ACF Fall @ UIUC schedule', () => {
  const teams = planTeams(23);
  const f = HDWHITE[23].find((x) => x.key === '23c');
  const eng = buildSchedule('pools3x2', teams, planRooms(11), {});
  const mine = buildPlan(teams, planRooms(11), hdAsPlan(f), 'snake', 1);
  assert.deepEqual(pairsByPhase(mine), pairsByPhase(eng));
  assert.equal(namesOf(mine), namesOf(eng));
  assert.deepEqual(mine.phases.map((p) => p.rounds.length), [7, 4]);
});

const poolSizesOf = (n, k) => Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
test('plan: every hdwhite field size and 48 builds sensibly, any pool count, with playoffs and finals', () => {
  const sizes = [...Object.keys(HDWHITE).map(Number), 48];
  let n = 0;
  for (const t of sizes) {
    const teams = planTeams(t);
    for (let k = 1; k <= Math.floor(t / 3); k++) {
      const prev = planGroups(teams, [planPhase('Prelims', { groups: k })], 'snake', () => 0.5)[0];
      // the picker's default next phase: as many pools as before (2+), whole places
      const deepest = Math.max(...prev.map((g) => g.members.length));
      const at = (place) => prev.filter((g) => g.members.length >= place).length;
      let place = 1;
      const sizesOut = poolSizesOf(deepest, Math.min(deepest, Math.max(2, k))).map((m) => { let sum = 0; for (let i = 0; i < m; i++) sum += at(place++); return sum; });
      if (sizesOut.length > 1 && sizesOut[sizesOut.length - 1] === 1) sizesOut.push(sizesOut.pop() + sizesOut.pop());
      const P = [planPhase('Prelims', { groups: k }), planPhase('Playoffs', { sizes: sizesOut, carry: k > 1 })];
      const s = buildPlan(teams, planRooms(Math.floor(t / 2)), P, 'snake', 1);
      addFinals(s, planGroups(teams, P, 'snake', () => 0.5), P);
      assert.deepEqual(scheduleChecks(s), [], `${t} teams, ${k} pools`);
      // every playoff pool has games for every team
      for (const g of planGroups(teams, P, 'snake', () => 0.5)[1]) assert.ok(g.members.length > 1, `${t}/${k}: ${g.name} has one team`);
      n++;
    }
  }
  assert.equal(n, 182); // every hdwhite field size and 48, every pool count of 3+ teams
});

test('plan: crossover pools of equal parts take the fewest rounds, each cross pair once, no byes', () => {
  for (const [q, m] of [[3, 4], [3, 6], [4, 4], [3, 8], [6, 2], [4, 3], [2, 5], [5, 4]]) {
    const t = q * m;
    const s = buildPlan(planTeams(t), planRooms(t), [planPhase('Prelims', { groups: q }), planPhase('Playoffs', { sizes: [t] })], 'snake', 1);
    const pr = s.phases[1].rounds;
    const pairs = pr.flatMap((r) => r.games.map((g) => [slotText(g.a), slotText(g.b)].sort().join('-')));
    assert.equal(pr.length, (q - 1) * m, `${q}x${m} rounds`);
    assert.equal(new Set(pairs).size, (q * (q - 1) / 2) * m * m, `${q}x${m} pairs`);
    assert.equal(pr.reduce((c, r) => c + r.byes.length, 0), 0, `${q}x${m} byes`);
  }
  // 48 teams, 6 pools of 8, the top two of each pool together: 10 rounds, no byes
  const P = [planPhase('Prelims', { groups: 6 }), planPhase('Playoffs', { per: 2 })];
  const s = buildPlan(planTeams(48), planRooms(24), P, 'snake', 1);
  assert.deepEqual(s.phases.map((p) => p.rounds.length), [7, 10]);
  assert.equal(s.phases[1].rounds.reduce((c, r) => c + r.byes.length, 0), 0);
});

test('plan: a split place is compared across pools, and fill places it by winning percentage, then PP20', () => {
  const teams = planTeams(13);
  const P = [planPhase('Prelims', { sizes: [7, 6], groups: 2 }), planPhase('Playoffs', { sizes: [7, 6] })];
  const g = planGroups(teams, P, 'snake', () => 0.5)[1];
  assert.deepEqual(g[0].members.map((m) => m.slot.label), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'Better 4th place']);
  assert.deepEqual(g[1].members.map((m) => m.slot.label).slice(0, 2), ['Other 4th place', 'A5']);
  const s = buildPlan(teams, planRooms(7), P, 'snake', 1);
  // B4 (4–2) beats A4 (4–3) on winning percentage
  const row = (name, w, l, pp) => ({ name, w, l, t: 0, pp20tuh: pp });
  const order = [...s.pools.A, ...s.pools.B];
  const agg = { teams: order.map((n, i) => row(n, 10 - i, i, 100)), games: [] };
  const A4 = s.pools.A[3], B4 = s.pools.B[3];
  agg.teams.find((x) => x.name === A4).w = 4; agg.teams.find((x) => x.name === A4).l = 3;
  agg.teams.find((x) => x.name === B4).w = 4; agg.teams.find((x) => x.name === B4).l = 2;
  const rep = fillReport(s, agg);
  assert.deepEqual(rep.ranks['#4'], [B4, A4]);
  fillPlaceholders(s, rep.ranks);
  const all = s.phases[1].rounds.flatMap((r) => r.games.flatMap((x) => [x.a, x.b]));
  assert.ok(all.some((x) => x.team === B4 && x.from === 'Better 4th place'));
  assert.ok(all.some((x) => x.team === A4 && x.from === 'Other 4th place'));
  // the same winning percentage: listed, PP20 decides
  agg.teams.find((x) => x.name === B4).l = 3;
  agg.teams.find((x) => x.name === B4).pp20tuh = 150;
  const rep2 = fillReport(buildPlan(teams, planRooms(7), P, 'snake', 1), agg);
  assert.equal(rep2.compared.length, 1);
  assert.deepEqual(rep2.ranks['#4'], [B4, A4]);
});

test('plan: pools past D fill from standings, and the editor names them', () => {
  const teams = planTeams(20);
  const P = [planPhase('Prelims', { groups: 5 }), planPhase('Playoffs', { per: 1 })];
  const s = buildPlan(teams, planRooms(10), P, 'snake', 1);
  const ranks = Object.fromEntries(Object.entries(s.pools).map(([k, v]) => [k, v]));
  fillPlaceholders(s, ranks);
  assert.ok(s.phases[1].rounds.every((r) => r.games.every((g) => g.a.team && g.b.team)));
  assert.equal(fillPlaceholders(buildPlan(teams, planRooms(10), P, 'snake', 1), ranks) > 0, true);
});

test('plan: rooms shared by all pools get their own lane in the editor', () => {
  const s = buildPlan(planTeams(18), planRooms(9), [planPhase('Prelims', { groups: 3, share: true, n: 3 })], 'snake', 1);
  tagBrackets(s);
  const lanes = phaseLanes(s, 0);
  assert.deepEqual(lanes.map((l) => l.name), ['Pool A', 'Pool B', 'Pool C', 'Shared rooms']);
  assert.deepEqual(lanes[3].rooms, [6, 7, 8]);
  // a schedule without shared rooms keeps today's lanes
  const plain = buildSchedule('pools3x2', planTeams(23), planRooms(11), {});
  tagBrackets(plain);
  assert.ok(!phaseLanes(plain, 0).some((l) => l.shared) && !phaseLanes(plain, 1).some((l) => l.shared));
  void shareRooms;
});

test('plan: tiebreaker rounds, finals and elimination pass the editor’s checks', () => {
  const teams = planTeams(12);
  const P = [planPhase('Prelims', { groups: 2 }), planPhase('Playoffs', { per: -1, ties: 'game' })];
  const s = buildPlan(teams, planRooms(6), P, 'snake', 1);
  addFinals(s, planGroups(teams, P, 'snake', () => 0.5), P, 'game');
  assert.deepEqual(s.phases.map((p) => p.name + (p.kind ? ':' + p.kind : '')), ['Prelims', 'Tiebreakers:tiebreak', 'Playoffs', 'Tiebreakers:tiebreak', 'Finals:final']);
  assert.deepEqual(scheduleChecks(s), []);
  const e = buildPlan(planTeams(16), planRooms(8), [planPhase('Prelims', { groups: 4 }), planPhase('Playoffs', { kind: 'double', top: 2 })], 'snake', 1);
  assert.equal(e.phases[1].rounds.reduce((k, r) => k + r.games.length, 0), 15);
  assert.deepEqual(scheduleChecks(e), []);
  assert.deepEqual(rebracketChecks(planGroups(planTeams(16), [planPhase('Prelims', { groups: 4 }), planPhase('Playoffs', { kind: 'double', top: 2 })], 'snake', () => 0.5),
    [planPhase('Prelims', { groups: 4 }), planPhase('Playoffs', { kind: 'double', top: 2 })], 1).filter((c) => !c.ok), []);
});


/* ---------- playoff slots that fill themselves ---------- */

// A tournament day in miniature: each prelim game gets a random result and
// an upload row (what the hub holds: round + summary teams/score) plus the
// parsed match aggregate() reads.
function playDay(s, seed, scoreOf = null) {
  const rnd = mulberry32(seed);
  const side = (name, points) => ({ name, points, bonusPoints: 0, players: [] });
  const out = [];
  let id = 0;
  for (const r of prelimRounds(s)) {
    for (const g of r.games) {
      if (!g.a || !g.a.team || !g.b || !g.b.team) continue;
      const [pa, pb] = scoreOf ? scoreOf(g.a.team, g.b.team, rnd) : (() => {
        const x = 5 * Math.floor(rnd() * 80) + 10, y = 5 * Math.floor(rnd() * 80) + 10;
        return x === y ? [x + 5, y] : [x, y];
      })();
      const m = { round: r.round, tossupsRead: 20, teams: [side(g.a.team, pa), side(g.b.team, pb)] };
      out.push({ m, f: { id: ++id, kind: 'combined', round: r.round, error: null,
        summary: JSON.stringify({ teams: [g.a.team, g.b.team], score: [pa, pb] }) } });
    }
  }
  return out;
}
// Upload the day's games in a random order; each time a pool finishes,
// auto-fill the saved schedule from that pool's games, as the hub does.
function autoDay(s, games, seed) {
  const rnd = mulberry32(seed + 7);
  const order = games.slice().sort(() => rnd() - 0.5);
  let saved = JSON.parse(JSON.stringify(s));
  let ready = 0, fills = 0;
  const up = [];
  for (const g of order) {
    up.push(g);
    const prog = prelimProgress(saved, up.map((x) => x.f));
    if (prog.ready.length === ready) continue;
    ready = prog.ready.length;
    const ids = new Set(prog.files.map((f) => f.id));
    const res = autoFill(saved, aggregate(up.filter((x) => ids.has(x.f.id)).map((x) => x.m)), prog.ready);
    // pools not done keep their slots open
    for (const p of Object.keys(saved.pools)) {
      if (!prog.ready.includes(p)) assert.ok(!res.pools.includes(p));
    }
    if (res.filled) { saved = res.schedule; fills++; }
  }
  return { saved, fills };
}
const manualFill = (s, games) => {
  const c = JSON.parse(JSON.stringify(s));
  fillPlaceholders(c, fillReport(s, aggregate(games.map((x) => x.m))).ranks);
  return c;
};

test('auto-fill: ACF Fall @ UIUC format (23 teams, 8/8/7 crossover), pools finishing in random order', () => {
  const s = buildSchedule('pools3x2', Array.from({ length: 23 }, (_, i) => 'Team ' + (i + 1)),
    Array.from({ length: 11 }, (_, i) => ({ name: 'Room ' + (i + 1), bucket: null })));
  for (let seed = 1; seed <= 150; seed++) {
    const games = playDay(s, seed);
    const { saved, fills } = autoDay(s, games, seed);
    assert.ok(fills >= 1 && fills <= 3);
    assert.ok(!hasPlaceholders(saved), 'seed ' + seed);
    assert.deepEqual(saved, manualFill(s, games), 'seed ' + seed);
  }
  // nothing fills before a pool is done, and an upload list with no summaries reads as nothing in
  const games = playDay(s, 3);
  const prog = prelimProgress(s, games.slice(0, -1).map((x) => x.f));
  assert.ok(prog.ready.length < 3);
  assert.deepEqual(prelimProgress(s, games.map((x) => ({ ...x.f, summary: null }))).ready, []);
  // a re-upload of the same game and a file that couldn't be read change nothing
  const dup = [...games, { m: games[0].m, f: { ...games[0].f, id: 999 } }, { m: null, f: { id: 1000, kind: 'qbj', round: 1, error: 'bad', summary: null } }];
  assert.deepEqual(prelimProgress(s, dup.map((x) => x.f)).ready, ['A', 'B', 'C']);
  const res = autoFill(s, aggregate(dedupeMatches(dup.filter((x) => x.m).map((x) => x.m))), ['A', 'B', 'C']);
  assert.deepEqual(res.schedule, manualFill(s, games));
});

test('auto-fill: pools by hand (23c, non-snake pools reseeded inside, and uneven 7/5) play through to filled playoffs and YellowFruit stages', () => {
  const teams = planTeams(23);
  const f = HDWHITE[23].find((x) => x.key === '23c');
  // a split nothing like the snake, each pool in its own seed order
  const rnd = mulberry32(42);
  const mixed = teams.slice().sort(() => rnd() - 0.5);
  const hand = [mixed.slice(0, 8), mixed.slice(8, 16), mixed.slice(16)];
  const phases = hdAsPlan(f);
  Object.assign(phases[0], { hand, sizes: [8, 8, 7] });
  const s = buildPlan(teams, planRooms(11), phases, 'hand', 1);
  tagBrackets(s);
  assert.deepEqual(s.pools, { A: hand[0], B: hand[1], C: hand[2] });
  assert.deepEqual(s.phases.map((p) => p.rounds.length), [7, 4]);
  for (let seed = 1; seed <= 40; seed++) {
    const games = playDay(s, seed);
    const { saved } = autoDay(s, games, seed);
    assert.ok(!hasPlaceholders(saved), 'seed ' + seed);
    assert.deepEqual(saved, manualFill(s, games), 'seed ' + seed);
    // each pool's winner is the one its own games say
    const agg = aggregate(games.map((x) => x.m));
    const ranks = poolStandings(s.pools, agg.teams.map((t) => t.name));
    const firsts = saved.phases[1].rounds.flatMap((r) => r.games).flatMap((g) => [g.a, g.b]).filter((x) => /^[ABC]1$/.test(x.from));
    for (const x of firsts) assert.equal(x.team, ranks[x.from[0]][0], 'seed ' + seed + ' ' + x.from);
    // YellowFruit: the prelim stage's pools are the hand-picked ones
    const played = saved.phases.flatMap((ph) => ph.rounds.flatMap((r) => r.games.map((g) => ({ round: r.round, teams: [{ name: g.a.team }, { name: g.b.team }] }))));
    const st = yfStages(saved, played);
    assert.ok(st, 'seed ' + seed + ': yfStages');
    assert.deepEqual(st.stages[0].pools.map((pl) => pl.teams.slice().sort()), hand.map((h) => h.slice().sort()));
  }
  // uneven pools by hand: 7/5 into crossover playoffs
  const t12 = planTeams(12);
  const h2 = [[t12[11], t12[0], t12[5], t12[6], t12[2], t12[9], t12[4]], [t12[1], t12[3], t12[7], t12[8], t12[10]]];
  const s2 = buildPlan(t12, planRooms(6), [
    planPhase('Prelims', { groups: 2, sizes: [7, 5], hand: h2 }),
    planPhase('Playoffs', { sizes: [6, 6], carry: true }),
  ], 'hand', 1);
  tagBrackets(s2);
  assert.deepEqual(s2.pools, { A: h2[0], B: h2[1] });
  for (let seed = 1; seed <= 20; seed++) {
    const games = playDay(s2, seed);
    assert.equal(games.length, 21 + 10, 'every prelim pair once');
    const { saved } = autoDay(s2, games, seed);
    assert.ok(!hasPlaceholders(saved), 'seed ' + seed);
    assert.deepEqual(saved, manualFill(s2, games), 'seed ' + seed);
  }
});

test('auto-fill: hdwhite and engine formats end where the Fill button does, places compared across pools last', () => {
  let n = 0, compared = 0;
  const cases = [];
  for (const [t, list] of Object.entries(HDWHITE)) for (const f of list) {
    if (f.sizes) cases.push([f.key, buildPlan(planTeams(Number(t)), planRooms(f.rooms), hdAsPlan(f), 'snake', 1)]);
  }
  for (let t = 6; t <= 30; t++) for (const f of allFormats(t)) {
    if (f.key.startsWith('pools')) cases.push([t + ' ' + f.key, buildSchedule(f.key, planTeams(t), planRooms(f.roomsNeeded), {})]);
  }
  for (const [key, s] of cases) {
    if (!s.pools || !hasPlaceholders(s)) continue;
    const hasCmp = JSON.stringify(s).includes(' place"');
    for (let seed = 1; seed <= 3; seed++) {
      const games = playDay(s, seed * 31);
      const { saved } = autoDay(s, games, seed);
      assert.deepEqual(saved, manualFill(s, games), key + ' seed ' + seed);
      // compared places wait for the last pool
      if (hasCmp) {
        const firstPool = Object.keys(s.pools)[0];
        const only = games.filter((x) => s.pools[firstPool].includes(x.m.teams[0].name));
        const part = autoFill(s, aggregate(only.map((x) => x.m)), [firstPool]);
        assert.ok(!JSON.stringify(part.schedule).match(/"from":"[^"]* place"/), key + ' compared early');
        compared++;
      }
      n++;
    }
  }
  assert.ok(n > 250, 'ran ' + n);
  assert.ok(compared > 0);
});

test('auto-fill: a game off the schedule holds its pool until the TD says fill anyway', () => {
  const s = buildSchedule('pools3x2', planTeams(23), planRooms(11), {});
  const games = playDay(s, 5);
  const A = s.pools.A;
  // pool A's first two teams also played an unscheduled game in round 2
  const stray = { round: 2, tossupsRead: 20, teams: [{ name: A[0], points: 300, bonusPoints: 0, players: [] }, { name: A[1], points: 100, bonusPoints: 0, players: [] }] };
  const all = [...games.map((x) => x.m), stray];
  const res = autoFill(s, aggregate(all), ['A', 'B', 'C']);
  assert.deepEqual(res.odd.map((x) => x.pool), ['A']);
  assert.deepEqual(res.pools, ['B', 'C']);
  assert.ok(JSON.stringify(res.schedule).includes('"label":"A1"'));
  const forced = autoFill(s, aggregate(all), ['A', 'B', 'C'], ['A']);
  assert.deepEqual([forced.odd, forced.pools], [[], ['A', 'B', 'C']]);
  assert.ok(!hasPlaceholders(forced.schedule));
});

test('auto-fill: with a Tiebreakers phase, ties for different brackets wait; points per 20 when the TD asks', () => {
  const teams = planTeams(16);
  const P = [planPhase('Prelims', { groups: 2 }), planPhase('Playoffs', { per: -1, ties: 'game' })];
  const s = buildPlan(teams, planRooms(8), P, 'snake', 1);
  assert.ok(s.phases.some((p) => p.kind === 'tiebreak'));
  // tiebreaker rounds aren't prelim rounds
  assert.ok(!prelimRounds(s).some((r) => s.phases.find((p) => p.kind === 'tiebreak').rounds.includes(r)));
  // pool A: a rock-paper-scissors three-way tie for places 4–6, across the halves; everyone else by seed
  const A = s.pools.A;
  const rank = (x) => A.includes(x) ? A.indexOf(x) : Number(x.slice(1));
  const cyc = [[A[3], A[4]], [A[4], A[5]], [A[5], A[3]]];
  const games = playDay(s, 1, (a, b) => {
    const c = cyc.find(([w, l]) => (w === a && l === b) || (w === b && l === a));
    const win = c ? c[0] : rank(a) <= rank(b) ? a : b;
    const bonus = { [A[3]]: 40, [A[4]]: 20, [A[5]]: 0 }[win] || 0;
    return win === a ? [300 + bonus, 100] : [100, 300 + bonus];
  });
  const res = autoFill(s, aggregate(games.map((x) => x.m)), ['A', 'B']);
  assert.equal(res.held.length, 1);
  assert.equal(res.held[0].pool, 'A');
  assert.deepEqual(res.held[0].teams.map((x) => x.name).sort(), [A[3], A[4], A[5]].sort());
  // pool A's other places and all of pool B fill; A4–A6 wait
  const txt = JSON.stringify(res.schedule);
  for (const l of ['A4', 'A5', 'A6']) assert.ok(txt.includes(`"label":"${l}"`), l);
  assert.ok(!txt.includes('"label":"A1"') && !txt.includes('"label":"A7"') && !txt.includes('"label":"B1"'));
  const pp = autoFill(res.schedule, aggregate(games.map((x) => x.m)), ['A', 'B'], ['A']);
  assert.deepEqual(pp.held, []);
  assert.equal(pp.ties.length, 1);
  assert.ok(!hasPlaceholders({ ...pp.schedule, phases: pp.schedule.phases.filter((p) => !p.kind) }));
  // without a Tiebreakers phase the same tie just goes by points per 20
  const plain = buildPlan(teams, planRooms(8), [planPhase('Prelims', { groups: 2 }), planPhase('Playoffs', { per: -1 })], 'snake', 1);
  const r2 = autoFill(plain, aggregate(games.map((x) => x.m)), ['A', 'B']);
  assert.deepEqual(r2.held, []);
  assert.ok(!hasPlaceholders(r2.schedule));
  // the caller can say ties wait (or don't), whatever the schedule has
  assert.equal(autoFill(plain, aggregate(games.map((x) => x.m)), ['A', 'B'], [], { holdTies: true }).held.length, 1);
  assert.deepEqual(autoFill(s, aggregate(games.map((x) => x.m)), ['A', 'B'], [], { holdTies: false }).held, []);
});

test('prelimRounds: both cycles of a double round robin, never tiebreaker rounds', () => {
  const f = Object.values(HDWHITE).flat().find((x) => x.cycles === 2 && x.sizes);
  const s = buildPlan(planTeams(f.sizes.reduce((a, b) => a + b, 0)), planRooms(f.rooms), hdAsPlan(f), 'snake', 1);
  assert.equal(prelimRounds(s).length, s.phases[0].rounds.length + s.phases[1].rounds.length);
});

test('buildPlan: a smaller last bracket plays its rounds first and finishes early', () => {
  // ACF Fall @ UIUC's shape: pools 8/7/7, then crossover brackets 6/6/6/4.
  // The 4-team bracket needs 3 rounds of a 4-round phase; its rounds come
  // first and its last round is off, never an empty round in the middle.
  const base = { kind: 'pools', top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1, carry: true,
    reset: true, byes: false, parallelTop: false, share: false, n: 3, mode: 'rotate' };
  const phases = [{ ...base, name: 'Prelims', groups: 3, sizes: null }, { ...base, name: 'Playoffs', groups: 1, sizes: [6, 6, 6, 4] }];
  for (const seed of [1, 5070, 77, 4242]) {
    const s = buildPlan(planTeams(22), planRooms(11), phases, 'random', seed);
    const po = s.phases.find((p) => p.name === 'Playoffs');
    const small = s.brackets.filter((b) => b.phase === 1).map((b) => b.key)
      .find((k) => po.rounds.reduce((n, r) => n + r.games.filter((g) => g.bracket === k).length, 0) === 5);
    const per = po.rounds.map((r) => r.games.filter((g) => g.bracket === small).length);
    assert.equal(po.rounds.length, 4);
    assert.ok(per.slice(0, 3).every((n) => n > 0) && per[3] === 0, `seed ${seed}: ${per}`);
    // its teams sit out the last round, and nobody else is touched
    assert.equal(po.rounds[3].byes.length, 4);
    assert.ok(po.rounds.every((r) => r.games.filter((g) => g.bracket !== small).length === 9));
    assert.deepEqual(validateSchedule(s), []);
  }
});

test('addFinals: one game final if needed, and one game final always played', () => {
  const base = { kind: 'pools', top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1, carry: true,
    reset: true, byes: false, parallelTop: false, share: false, n: 3, mode: 'rotate' };
  const P = [{ ...base, name: 'Prelims', groups: 3, sizes: null }, { ...base, name: 'Playoffs', groups: 1, sizes: [6, 6, 6, 4] }];
  const teams = planTeams(22);
  const build = (style) => {
    const s = buildPlan(teams, planRooms(11), P, 'random', 5070);
    const got = addFinals(s, planGroups(teams, P, 'random', () => 0.5), P, undefined, style);
    return { s, got, fin: s.phases[s.phases.length - 1] };
  };
  const adv = build();
  assert.equal(adv.fin.rounds.length, 2);
  assert.ok(adv.fin.rounds.every((r) => r.games[0].ifNeeded));
  const one = build('one');
  assert.equal(one.got.one, true);
  assert.equal(one.fin.kind, 'final');
  assert.equal(one.fin.meet, 1);
  assert.equal(one.fin.rounds.length, 1);
  assert.equal(one.fin.rounds[0].games.length, 1);
  assert.equal(one.fin.rounds[0].games[0].ifNeeded, undefined);
  assert.equal(one.fin.rounds[0].games[0].a.label, '1st in 1st–6th place');
  assert.equal(one.fin.rounds[0].games[0].b.label, '2nd in 1st–6th place');
  assert.deepEqual(validateSchedule(one.s), []);
  // if needed: the advantaged rule's first game, without the second
  const oneif = build('oneif');
  assert.equal(oneif.fin.rounds.length, 1);
  assert.equal(oneif.fin.meet, 1);
  assert.equal(oneif.fin.rounds[0].games[0].ifNeeded, 'unless the leader is two wins clear');
  assert.equal(oneif.got.always, false);
  assert.equal(one.got.always, true);
});

/* ---------- YellowFruit stages from the schedule ---------- */

// two pools of three, then a 4-team top bracket (two from each pool) and
// a 2-team bottom one; `extra` adds games to the playoff rounds
function stageSched(extra = []) {
  const g = (bracket, a, b) => ({ room: 0, bracket, a: { team: a }, b: { team: b } });
  return {
    pools: { A: ['a1', 'a2', 'a3'], B: ['b1', 'b2', 'b3'] },
    brackets: [{ key: 'A', name: 'Pool A', phase: 0 }, { key: 'B', name: 'Pool B', phase: 0 },
      { key: 'T1', name: 'Top', phase: 1 }, { key: 'T2', name: 'Bottom', phase: 1 }],
    phases: [
      { name: 'Prelims', meet: 1, rounds: [
        { round: 1, games: [g('A', 'a1', 'a2'), g('B', 'b1', 'b2')], byes: [] },
        { round: 2, games: [g('A', 'a1', 'a3'), g('B', 'b1', 'b3')], byes: [] },
        { round: 3, games: [g('A', 'a2', 'a3'), g('B', 'b2', 'b3')], byes: [] }] },
      { name: 'Playoffs', meet: 1, rounds: [
        { round: 4, games: [g('T1', 'a1', 'b1'), g('T1', 'a2', 'b2'), g('T2', 'a3', 'b3'), ...extra.filter((x) => x.round === 4).map((x) => x.g)], byes: [] },
        { round: 5, games: [g('T1', 'a1', 'b2'), g('T1', 'a2', 'b1'), ...extra.filter((x) => x.round === 5).map((x) => x.g)], byes: [] }] },
    ],
  };
}
const stageGames = (s) => s.phases.flatMap((p) => p.rounds.flatMap((r) => r.games.map((g) => ({ round: r.round, teams: [{ name: g.a.team }, { name: g.b.team }] }))));

test('yfStages: pools, then brackets carrying their pool-mates\' games', () => {
  const s = stageSched();
  const plan = yfStages(s, stageGames(s));
  assert.deepEqual(plan.stages.map((x) => [x.name, x.type]), [['Prelims', 'Prelim'], ['Playoffs', 'Playoff']]);
  assert.deepEqual(plan.stages[1].pools.map((p) => [p.name, p.teams.length, p.carry]), [['Top', 4, true], ['Bottom', 2, false]]);
});

test('yfStages: a bracket that replays its pool-mates carries nothing', () => {
  const g = (a, b) => ({ room: 1, bracket: 'T1', a: { team: a }, b: { team: b } });
  const s = stageSched([{ round: 4, g: g('a1', 'a2') }, { round: 5, g: g('b1', 'b2') }]);
  // a team twice in a round is fine for this check: the rule reads pairs
  const plan = yfStages(s, stageGames(s));
  assert.equal(plan.stages[1].pools[0].carry, false);
});

test('yfStages: an elimination bracket carries nothing', () => {
  const s = stageSched();
  s.phases[1].kind = 'single';
  assert.equal(yfStages(s, stageGames(s)).stages[1].pools[0].carry, false);
});

test('yfStages: a stage not played yet is left out; the pools still count', () => {
  const s = stageSched();
  for (const r of s.phases[1].rounds) for (const g of r.games) { g.a = { label: 'A1' }; g.b = { label: 'B2' }; }
  const plan = yfStages(s, stageGames(stageSched()).filter((m) => m.round <= 3));
  assert.ok(plan && plan.stages[1].unplayed && plan.stages[0].pools.length === 2);
});

test('yfStages: a played final whose slots were never filled in is still a Finals stage', () => {
  const s = stageSched();
  s.phases.push({ name: 'Finals', kind: 'final', meet: 2, rounds: [{ round: 6, games: [{ room: 0, bracket: 'FN',
    a: { label: '1st in Top' }, b: { label: '2nd in Top' } }], byes: [] }] });
  const plan = yfStages(s, [...stageGames(stageSched()), { round: 6, teams: [{ name: 'a1' }, { name: 'b1' }] }]);
  assert.ok(plan && plan.stages[2].type === 'Finals' && !plan.stages[2].unplayed);
});

test('yfStages: one stage, or anything it can\'t place, keeps the single pool', () => {
  const rr = { phases: [{ name: 'Round robin', meet: 3, rounds: [{ round: 1, games: [{ bracket: 'A', a: { team: 'x' }, b: { team: 'y' } }] }] }] };
  assert.equal(yfStages(rr, [{ round: 1, teams: [{ name: 'x' }, { name: 'y' }] }]), null);
  assert.equal(yfStages(null, []), null);
  const s = stageSched();
  // a game between pools in the prelims, or in a round the schedule lacks
  assert.equal(yfStages(s, [...stageGames(s), { round: 2, teams: [{ name: 'a2' }, { name: 'b3' }] }]), null);
  assert.equal(yfStages(s, [...stageGames(s), { round: 9, teams: [{ name: 'a1' }, { name: 'b1' }] }]), null);
});

/* ---------- scoresheets ---------- */

// a MODAQ-shaped match with lineups, buzzes and bonus parts
function sheetMatch() {
  const buzz = (team, player, value) => ({ team: { name: team }, player: { name: player },
    buzz_position: { word_index: 10 }, result: { value } });
  const bonus = (...pts) => ({ question: { question_number: 1 }, parts: pts.map((x) => ({ controlled_points: x, bounceback_points: 0 })) });
  return {
    tossups_read: 4,
    match_teams: [
      { team: { name: 'Alpha' }, lineups: [
          { first_question: 1, players: [{ name: 'Ann Lee' }, { name: 'Bo Kim' }] },
          { first_question: 3, players: [{ name: 'Ann Lee' }, { name: 'Cy Park' }] }],
        match_players: [{ player: { name: 'Ann Lee' } }, { player: { name: 'Bo Kim' } }, { player: { name: 'Cy Park' } }] },
      { team: { name: 'Beta' }, lineups: [{ first_question: 1, players: [{ name: 'Evan Shah' }, { name: 'Emma Stone' }] }],
        match_players: [{ player: { name: 'Evan Shah' } }, { player: { name: 'Emma Stone' } }] },
    ],
    match_questions: [
      { question_number: 1, tossup_question: { question_number: 1 }, buzzes: [buzz('Alpha', 'Ann Lee', 15)], bonus: bonus(10, 10, 0) },
      { question_number: 2, tossup_question: { question_number: 2 },
        buzzes: [buzz('Beta', 'Emma Stone', -5), buzz('Alpha', 'Bo Kim', 10)], bonus: bonus(0, 0, 0) },
      { question_number: 3, tossup_question: { question_number: 3 }, buzzes: [buzz('Beta', 'Evan Shah', 0)] },
      { question_number: 4, tossup_question: { question_number: 4 }, buzzes: [buzz('Beta', 'Evan Shah', 10)], bonus: bonus(10, 10, 10) },
      { question_number: 5, tossup_question: { question_number: 5 }, buzzes: [buzz('Alpha', 'Cy Park', 10)] },
    ],
  };
}

test('buildScoresheet: cells, bonus parts, running score and overtime', () => {
  const cats = [{ c: 'Literature', s: 'American Literature' }, { c: 'Science', s: 'Other Science' }, null,
    { c: 'History', s: 'Ancient History' }, { c: 'Social Science', s: 'Social Science' }];
  const sh = buildScoresheet(sheetMatch(), cats, 4);
  assert.deepEqual(sh.teams.map((t) => t.players.map((p) => p.initials)), [['AL', 'BK', 'CP'], ['ESh', 'ESt']]);
  assert.deepEqual(sh.rows[0].cells, [[15, null, null], [null, null]]);
  assert.deepEqual(sh.rows[0].bonus, [[true, true, false], null]);
  // a neg and the other team's pick-up share the row; the bonus goes to the 10
  assert.deepEqual(sh.rows[1].cells, [[null, 10, null], [null, -5]]);
  assert.deepEqual(sh.rows[1].bonus, [[false, false, false], null]);
  // a 0 is marked, and earns no bonus
  assert.deepEqual(sh.rows[2].cells[1], [0, null]);
  assert.deepEqual(sh.rows[2].bonus, [null, null]);
  assert.deepEqual(sh.rows.map((r) => r.score), [[35, 0], [45, -5], [45, -5], [45, 35], [55, 35]]);
  assert.deepEqual(sh.final, [55, 35]);
  assert.deepEqual(sh.rows.map((r) => r.ot), [false, false, false, false, true]);
  assert.deepEqual(sh.rows.map((r) => r.cat && r.cat.label), ['AL', 'OSci', null, 'AnH', 'SS']);
  assert.equal(sh.rows[0].cat.family, 'lit');
  assert.equal(sh.rows[4].cat.family, 'rmp');
});

test('buildScoresheet: substitutions from the lineups', () => {
  const sh = buildScoresheet(sheetMatch(), null, 20);
  assert.deepEqual(sh.subs, [{ n: 3, team: 0, in: ['Cy Park'], out: ['Bo Kim'] }]);
  // out of the game: Cy Park before the sub, Bo Kim after it
  assert.deepEqual(sh.rows.map((r) => r.out[0]), [
    [false, false, true], [false, false, true], [false, true, false], [false, true, false], [false, true, false]]);
  assert.deepEqual(sh.rows[2].subs, [0]);
  assert.ok(sh.rows.every((r) => r.cat === null));
});

test('buildScoresheet: no tossup data means no scoresheet', () => {
  assert.equal(buildScoresheet({ tossups_read: 20, match_teams: [{}, {}] }), null);
});

test('sheetHtml: without categories the column is left out, the rest stays', () => {
  const none = sheetHtml(buildScoresheet(sheetMatch(), null, 4), 4);
  assert.ok(!none.includes('class="qc"') && !none.includes('class="cf'));
  assert.ok(none.includes('<table class="sx">') && none.includes('55–35'));
  assert.ok(none.includes('TU 3: Alpha CP subbed for BK'));
  const cats = [{ c: 'Literature', s: 'American Literature' }];
  assert.ok(sheetHtml(buildScoresheet(sheetMatch(), cats, 4), 4).includes('class="cf lit"'));
});

test('exampleSheetHtml: the hub\'s example draws', () => {
  const h = exampleSheetHtml();
  assert.equal((h.match(/<tr/g) || []).length, 11); // two header rows, 8 tossups, the final score
  assert.ok(h.includes('subbed for') && h.includes('class="cf hist"') && h.includes('−5'));
});

test('teamInitials: unique within a team', () => {
  const m = teamInitials(['Evan Shah', 'Emma Stone', 'Fiona Ruiz', 'Plato']);
  assert.deepEqual([...m.values()], ['ESh', 'ESt', 'FR', 'Pl']);
  // the same initials on two teams are fine: each team is its own list
  assert.equal(teamInitials(['Ann Kim']).get('Ann Kim'), 'AK');
});

test('catTag: subcategory initials, else the category\'s short form, else cut to four', () => {
  assert.equal(catTag({ c: 'Fine Arts', s: 'Visual Fine Arts' }).label, 'VFA');
  assert.equal(catTag({ c: 'Mythology', s: '' }).label, 'Myth');
  assert.equal(catTag({ c: 'Geography', s: 'Geography' }).family, 'oth');
  assert.equal(catTag({ c: 'Science', s: 'Astronomy' }).label, 'Sci');
  assert.equal(catTag({ c: 'Linguistics', s: '' }).label, 'Ling');
  // packets' short forms, as ACF Fall @ UIUC's give them
  const tag = (c, s) => catTag({ c, s }).label;
  assert.equal(tag('History', 'European'), 'EH');
  assert.equal(tag('Literature', 'British'), 'BL');
  assert.equal(tag('Fine Arts', 'Visual'), 'VFA');
  assert.equal(tag('Fine Arts', 'Other'), 'OFA');
  assert.equal(tag('Science', 'Other'), 'OSci');
  assert.equal(tag('Science', 'Other Science: Computer'), 'OSci');
  assert.equal(tag('Science', 'Other Science: Math and Computer'), 'OSci');
  assert.equal(tag('Social Science', 'Anthropology'), 'Anth');
  assert.equal(tag('Beliefs', ''), 'Bel');
  assert.equal(catTag({ c: 'Science', s: 'Social Science: Political' }).family, 'rmp');
  assert.equal(tag('Science', 'Social Science: Political'), 'SS');
  assert.equal(catTag(null), null);
});


/* ---------- finals fill themselves (finals.js) ---------- */

// UIUC's shape: pools of 8/7/7, brackets of 6/6/6/4 carrying pool-mates'
// games, then an advantaged final between 1st and 2nd of the top bracket
function finalsDay(seed, opts = {}) {
  const teams = planTeams(22);
  const P = [planPhase('Prelims', { groups: 3 }), planPhase('Playoffs', { sizes: [6, 6, 6, 4], carry: true })];
  const s = buildPlan(teams, planRooms(11), P, 'snake', 1);
  if (opts.tiebreak) s.phases.push({ name: 'Tiebreakers', rounds: [{ round: 12, games: [], byes: [] }], meet: 1, kind: 'tiebreak' });
  addFinals(s, planGroups(teams, P, 'snake', () => 0.5), P);
  const rnd = mulberry32(seed);
  const game = (round, a, b, tens) => {
    const t = tens || [4 + Math.floor(rnd() * 8), 4 + Math.floor(rnd() * 8)];
    if (t[0] === t[1]) t[0]++;
    return { round, tossupsRead: 20, teams: [{ name: a, points: t[0] * 20, bonusPoints: t[0] * 10, players: [] },
      { name: b, points: t[1] * 20, bonusPoints: t[1] * 10, players: [] }] };
  };
  const games = prelimRounds(s).flatMap((r) => r.games.map((g) => game(r.round, g.a.team, g.b.team)));
  fillPlaceholders(s, fillReport(s, aggregate(games)).ranks);
  for (const r of s.phases[1].rounds) for (const g of r.games) games.push(game(r.round, g.a.team, g.b.team, opts.tens && opts.tens(g)));
  let id = 0;
  const files = games.map((m) => ({ id: ++id, kind: 'qbj', round: m.round, summary: JSON.stringify({ teams: m.teams.map((t) => t.name) }) }));
  return { s, games, files };
}
const finalTeams = (s) => s.phases.find((ph) => ph.kind === 'final').rounds.map((r) => r.games.map((g) => [g.a.team || g.a.label, g.b.team || g.b.label]));

// four teams, a round robin, then an advantaged final if needed; `beats`
// lists who wins each round robin game
function rrFinal(beats) {
  const teams = planTeams(4);
  const P = [planPhase('Round robin', { groups: 1 })];
  const s = buildPlan(teams, planRooms(2), P, 'snake', 1);
  tagBrackets(s);
  addFinals(s, planGroups(teams, P, 'snake', () => 0.5), P, undefined, 'advantaged');
  const game = (round, w, l) => ({ round, tossupsRead: 20, teams: [{ name: w, points: 300, bonusPoints: 100, players: [] }, { name: l, points: 100, bonusPoints: 50, players: [] }] });
  const games = s.phases[0].rounds.flatMap((r) => r.games.map((g) => {
    const [a, b] = [g.a.team, g.b.team];
    return game(r.round, beats(a, b) ? a : b, beats(a, b) ? b : a);
  }));
  const files = games.map((m, i) => ({ id: i + 1, kind: 'qbj', round: m.round, summary: JSON.stringify({ teams: m.teams.map((t) => t.name) }) }));
  const filled = finalsFill(s, games, finalsProgress(s, files).ready).schedule;
  const fin = filled.phases.find((ph) => ph.kind === 'final');
  return { s, filled, games, game, fin };
}

test('finished: a round robin is finished when its last game is in; finished rounds stop at the first one missing a game', () => {
  const teams = planTeams(4);
  const s = buildPlan(teams, planRooms(2), [planPhase('Round robin', { groups: 1 })], 'snake', 1);
  const game = (r, g) => ({ round: r.round, tossupsRead: 20, teams: [{ name: g.a.team, points: 200, bonusPoints: 0, players: [] }, { name: g.b.team, points: 100, bonusPoints: 0, players: [] }] });
  const games = s.phases[0].rounds.flatMap((r) => r.games.map((g) => game(r, g)));
  assert.equal(scheduleFinished(s, games), true);
  assert.equal(scheduleFinished(s, games.slice(0, -1)), false);
  assert.equal(scheduleFinished(s, []), false);
  assert.equal(finishedThrough(s, games), 3);
  const r2 = s.phases[0].rounds[1];
  const missing = games.filter((m) => !(m.round === r2.round && m.teams[0].name === r2.games[0].a.team));
  assert.equal(finishedThrough(s, missing), 1, 'round 2 is missing a game, so only round 1 counts');
  assert.equal(finishedThrough(s, games.filter((m) => m.round === 1)), 1);
  assert.equal(finishedThrough(s, []), 0);
});

test('finished: pools waiting on playoff teams, or a final waiting on its bracket, are not finished', () => {
  const { s, games } = finalsDay(5);
  // prelims and playoffs in, the final's teams not filled in yet
  assert.equal(scheduleFinished(s, games), false);
  const prelimsOnly = JSON.parse(JSON.stringify(s));
  // before the playoffs are filled: still placeholders
  const raw = buildPlan(planTeams(22), planRooms(11), [planPhase('Prelims', { groups: 3 }), planPhase('Playoffs', { sizes: [6, 6, 6, 4], carry: true })], 'snake', 1);
  const pre = games.filter((m) => prelimRounds(raw).some((r) => r.round === m.round));
  assert.equal(scheduleFinished(raw, pre), false);
  assert.ok(prelimsOnly);
});

test('finished: an advantaged final — skipped when the leader is two wins clear, a second game only when the leader loses the first', () => {
  const rank = (x) => Number(x.slice(1));
  // T1 wins everything, T2 beats T3 and T4: 3–0 and 2–1, one win apart: the final is played
  let x = rrFinal((a, b) => rank(a) < rank(b));
  const [g1] = x.fin.rounds[0].games;
  assert.deepEqual([g1.a.team, g1.b.team], ['T1', 'T2']);
  assert.equal(scheduleFinished(x.filled, x.games), false, 'the first final is still to play');
  assert.equal(scheduleFinished(x.filled, [...x.games, x.game(x.fin.rounds[0].round, 'T1', 'T2')]), true, 'the leader won it: no second game');
  const lost = [...x.games, x.game(x.fin.rounds[0].round, 'T2', 'T1')];
  assert.equal(scheduleFinished(x.filled, lost), false, 'the leader lost it: the second game decides');
  assert.equal(scheduleFinished(x.filled, [...lost, x.game(x.fin.rounds[1].round, 'T1', 'T2')]), true);
  // level going in (T1 and T2 both 2–1): one game, whoever wins it — no second game
  const level = { 'T1,T2': true, 'T2,T3': true, 'T3,T1': true, 'T1,T4': true, 'T2,T4': true, 'T3,T4': true };
  x = rrFinal((a, b) => level[[a, b].join()] ?? !level[[b, a].join()]);
  const lf = x.fin.rounds[0].games[0];
  const [p1, p2] = [lf.a.team, lf.b.team];
  assert.equal(scheduleFinished(x.filled, x.games), false, 'the one-game final still to play');
  assert.equal(scheduleFinished(x.filled, [...x.games, x.game(x.fin.rounds[0].round, p2, p1)]), true, 'the second-listed team won it: still finished');
  assert.equal(scheduleFinished(x.filled, [...x.games, x.game(x.fin.rounds[0].round, p1, p2)]), true);
  // T1 3–0; T2, T3 and T4 all 1–2: the leader is two wins clear, no final
  const cycle = { T2: 'T4', T4: 'T3', T3: 'T2' }; // each of the others beats one and loses to one
  x = rrFinal((a, b) => (a === 'T1' || b === 'T1' ? a === 'T1' : cycle[a] === b));
  assert.equal(scheduleFinished(x.filled, x.games), true, 'no final needed');
  // finished rounds stop at the round robin: the final nobody played doesn't stretch them
  assert.equal(finishedThrough(x.filled, x.games), 3);
  x = rrFinal((a, b) => rank(a) < rank(b));
  const fr = x.fin.rounds[0].round;
  assert.equal(finishedThrough(x.filled, x.games), 3, 'the final still to play');
  assert.equal(finishedThrough(x.filled, [...x.games, x.game(fr, 'T1', 'T2')]), fr, 'the final played: it counts');
});

test('finished: a one-game final uploaded under the "if needed" round still counts everywhere; moved to its own round, the tournament is finished', () => {
  // T1 and T2 level going in: a one-game final, played but filed as the second final's round
  const level = { 'T1,T2': true, 'T2,T3': true, 'T3,T1': true, 'T1,T4': true, 'T2,T4': true, 'T3,T4': true };
  const x = rrFinal((a, b) => level[[a, b].join()] ?? !level[[b, a].join()]);
  const [r12, r13] = x.fin.rounds.map((r) => r.round);
  const { a, b } = x.fin.rounds[0].games[0];
  const asR13 = [...x.games, x.game(r13, b.team, a.team)]; // the second-listed team won it
  const asR12 = [...x.games, x.game(r12, b.team, a.team)];
  // filed as round 13: nothing is lost
  assert.equal(finishedThrough(x.filled, asR13), r13, 'finished rounds reach it');
  assert.equal(scheduleFinished(x.filled, asR13), false, 'its own round looks unplayed, so not finished yet');
  // moved to round 12: finished, and still counted the same way
  assert.equal(scheduleFinished(x.filled, asR12), true);
  // a tournament shaped like ACF Fall @ UIUC (pools, playoff brackets, an
  // advantaged final): the final filed under the second final's round is
  // in the Finals stage, the report, Combined and the YellowFruit file
  const day = finalsDay(5);
  const filled = finalsFill(day.s, day.games, finalsProgress(day.s, day.files).ready).schedule;
  const fin = filled.phases.find((ph) => ph.kind === 'final');
  const g = fin.rounds[0].games[0];
  const late = fin.rounds[fin.rounds.length - 1].round;
  const won = { round: late, tossupsRead: 20, teams: [{ name: g.b.team, points: 400, bonusPoints: 200, players: [] }, { name: g.a.team, points: 200, bonusPoints: 100, players: [] }] };
  const all = dedupeMatches([...day.games, won]);
  const y = yfStages(filled, all);
  assert.equal([...y.placed].filter(([m, st]) => m === won && st.type === 'Finals').length, 1, 'in the Finals stage');
  const rd2 = reportData({ name: 'F', matches: all, schedule: filled });
  assert.equal(rd2.games.length, all.length, 'every game in the report');
  assert.equal(rd2.combined[0].name, g.b.team, 'Combined: its winner 1st');
  assert.equal(JSON.parse(serializeYft({ name: 'F', matches: all, schedule: filled })).objects[0].phases
    .flatMap((ph) => ph.rounds.flatMap((r) => r.matches || [])).length, all.length, 'every game in the YellowFruit file');
});

test('finals: the source is the top bracket, its carryover the same as the YellowFruit file\'s', () => {
  const { s, games } = finalsDay(5);
  const src = finalsSources(s);
  assert.equal(src.length, 1);
  assert.deepEqual([src[0].name, src[0].places, src[0].teams.length, src[0].games.length], ['1st–6th place', [1, 2], 6, 12]);
  // A1/A2, B1/B2, C1/C2 were pool-mates and don't meet again: those three games carry
  assert.equal(src[0].carry, true);
  assert.equal(src[0].carried.length, 3);
  const yf = yfStages(s, games);
  assert.equal(yf.stages[1].pools.find((p) => p.name === '1st–6th place').carry, src[0].carry);
});

test('finals: nothing fills while a game of the top bracket is missing', () => {
  const { s, games, files } = finalsDay(5);
  const src = finalsSources(s)[0];
  const g = src.games[3];
  const drop = files.findIndex((f) => f.round === g.round && JSON.parse(f.summary).teams.sort().join() === [g.a, g.b].sort().join());
  const fewer = files.filter((_, i) => i !== drop);
  assert.deepEqual(finalsProgress(s, fewer).ready, []);
  // a game of another bracket missing doesn't hold the finals
  const other = files.findIndex((f) => f.round === 11 && !src.teams.includes(JSON.parse(f.summary).teams[0]));
  assert.deepEqual(finalsProgress(s, files.filter((_, i) => i !== other)).ready, ['1st–6th place']);
  // and the games read are only that bracket's and its carried prelim games
  const prog = finalsProgress(s, files);
  assert.equal(prog.files.length, 15);
  assert.equal(finalsFill(s, [], prog.ready).filled, 0, 'no games read: nothing fills');
});

test('finals: filled from the bracket\'s standings, net wins then points per 20, carryover counted', () => {
  for (const seed of [5, 9, 13, 21, 34]) {
    const { s, games, files } = finalsDay(seed);
    const src = finalsSources(s)[0];
    const prog = finalsProgress(s, files);
    const res = finalsFill(s, games, prog.ready);
    const carried = new Set(src.carried.map((c) => [c.a, c.b].sort().join('\n')));
    const mine = games.filter((m) => m.teams.every((t) => src.teams.includes(t.name))
      && (m.round >= 8 || carried.has(m.teams.map((t) => t.name).sort().join('\n'))));
    assert.equal(mine.length, 15, `seed ${seed}: 12 bracket games and 3 carried`);
    const order = aggregate(mine).teams.map((t) => t.name);
    assert.equal(res.filled, 4, `seed ${seed}`);
    assert.deepEqual(finalTeams(res.schedule), [[[order[0], order[1]]], [[order[0], order[1]]]], `seed ${seed}`);
    assert.deepEqual(res.brackets, ['1st–6th place']);
    assert.equal(hasPlaceholders(res.schedule), false);
    // the slots keep where they came from, as playoff slots do
    assert.equal(res.schedule.phases[2].rounds[0].games[0].a.from, '1st in 1st–6th place');
    // the original is untouched
    assert.equal(s.phases[2].rounds[0].games[0].a.label, '1st in 1st–6th place');
  }
});

test('finals: a tie for a finals place is settled by points per 20 and noted; with a Tiebreakers phase it waits', () => {
  // a seed whose top bracket has a tie reaching a finals place
  let found = null;
  for (let seed = 1; seed < 200 && !found; seed++) {
    const d = finalsDay(seed);
    const res = finalsFill(d.s, d.games, finalsProgress(d.s, d.files).ready);
    if (res.ties.length) found = { seed, res };
  }
  assert.ok(found, 'a seed with a tie');
  const x = found.res.ties[0];
  assert.ok(x.teams.length > 1 && x.teams.some((tm) => tm.place <= 2));
  assert.ok(x.teams.every((tm, i) => !i || tm.pp20tuh <= x.teams[i - 1].pp20tuh), 'points per 20, best first');
  const d = finalsDay(found.seed, { tiebreak: true });
  const prog = finalsProgress(d.s, d.files);
  const held = finalsFill(d.s, d.games, prog.ready);
  assert.equal(held.filled, 0);
  assert.equal(held.held.length, 1);
  assert.equal(held.held[0].record, x.record);
  // the TD says use points per 20
  const forced = finalsFill(d.s, d.games, prog.ready, ['1st–6th place']);
  assert.equal(forced.filled, 4);
  assert.equal(forced.ties.length, 1);
});

test('finals: a top bracket game uploaded under the wrong team name waits', () => {
  const { s, games, files } = finalsDay(5);
  const src = finalsSources(s)[0];
  const g = src.games[0];
  const bad = games.map((m) => (m.round === g.round && m.teams.map((t) => t.name).sort().join() === [g.a, g.b].sort().join()
    ? { ...m, teams: [{ ...m.teams[0], name: m.teams[0].name + ' (typo)' }, m.teams[1]] } : m));
  assert.equal(finalsFill(s, bad, finalsProgress(s, files).ready).filled, 0);
});

test('finals: a round robin\'s final, and pools whose winners meet, fill too', () => {
  const ph = planPhase;
  for (const [teams, phases, rooms, labels] of [
    [planTeams(8), [ph('Round robin')], 4, ['1st in Round robin', '2nd in Round robin']],
    [planTeams(10), [ph('Prelims', { groups: 2 })], 5, ['1st in Pool A', '1st in Pool B']],
  ]) {
    const s = buildPlan(teams, planRooms(rooms), phases, 'snake', 1);
    addFinals(s, planGroups(teams, phases, 'snake', () => 0.5), phases);
    const fin = s.phases[s.phases.length - 1].rounds[0].games[0];
    assert.deepEqual([fin.a.label, fin.b.label], labels);
    // the lower-numbered team wins every game
    const games = s.phases[0].rounds.flatMap((r) => r.games.map((g) => {
      const n = (x) => Number(x.slice(1));
      const [w, l] = n(g.a.team) < n(g.b.team) ? [g.a.team, g.b.team] : [g.b.team, g.a.team];
      return { round: r.round, tossupsRead: 20, teams: [{ name: w, points: 300, bonusPoints: 100, players: [] }, { name: l, points: 100, bonusPoints: 30, players: [] }] };
    }));
    let id = 0;
    const files = games.map((m) => ({ id: ++id, kind: 'qbj', round: m.round, summary: JSON.stringify({ teams: m.teams.map((t) => t.name) }) }));
    const res = finalsFill(s, games, finalsProgress(s, files).ready);
    const got = res.schedule.phases[res.schedule.phases.length - 1].rounds[0].games[0];
    const want = s.pools ? Object.values(s.pools).map((m) => m.slice().sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)))[0]) : ['T1', 'T2'];
    assert.deepEqual([got.a.team, got.b.team], want, labels.join(' / '));
  }
});

await testA('eachLimit: any count of items, in order, never more than n at once, failures kept apart', async () => {
  for (const count of [0, 1, 2, 5, 6, 7, 11, 12, 13, 113]) {
    for (const n of [1, 6, 50]) {
      let running = 0, most = 0;
      const calls = new Array(count).fill(0);
      const progress = [];
      const out = await eachLimit(Array.from({ length: count }, (_, i) => i), n, async (x, i) => {
        calls[i]++;
        running++; most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, (x * 7) % 5));
        running--;
        if (x % 5 === 3) throw new Error('bad ' + x);
        return x * 10;
      }, (done, total) => progress.push([done, total]));
      assert.equal(out.length, count, `${count}/${n}`);
      assert.ok(calls.every((c) => c === 1), `${count}/${n}: each item once`);
      assert.ok(most <= n, `${count}/${n}: at most ${n} at once (${most})`);
      out.forEach((o, i) => (i % 5 === 3 ? assert.equal(o.error.message, 'bad ' + i) : assert.equal(o.value, i * 10)));
      assert.deepEqual(progress.map((p) => p[0]), Array.from({ length: count }, (_, i) => i + 1), `${count}/${n}: progress counts up`);
      assert.ok(progress.every((p) => p[1] === count));
    }
  }
});

test('modaqfile: a reader upload hands back MODAQ\'s own export texts unchanged; older uploads are rebuilt in MODAQ\'s shape', () => {
  const qbj = { tossups_read: 20, match_teams: [{ team: { name: 'A B' } }, { team: { name: 'C' } }], match_questions: [], _round: 3, packets: 'P 1 + 2' };
  const qbjText = JSON.stringify(qbj, null, 2);
  const game = { packet: { tossups: [] }, cycles: [], teamNames: ['A B', 'C'] };
  const gameText = JSON.stringify(game, null, 2);
  // saved at upload: verbatim
  const root = { qbj: { ...qbj }, game: { game, uiState: {} }, modaq: { qbj: qbjText, game: gameText } };
  let out = modaqExport(root, 3);
  assert.equal(out.qbj, qbjText);
  assert.equal(out.game, gameText);
  // filed under another round: only _round moves
  out = modaqExport(root, 2);
  assert.equal(out.qbj, JSON.stringify({ ...qbj, _round: 2 }, null, 2));
  assert.equal(qbjTextWithRound(qbjText, 3), qbjText, 'the same round: the very same text');
  // an older upload: the reader's qbj had _round appended after packets, and the game half was {game, uiState}
  const old = { qbj: { tossups_read: 20, match_teams: qbj.match_teams, match_questions: [], packets: 'P 1 + 2', _round: 3 }, game: { game, uiState: { x: 1 } } };
  out = modaqExport(old, 3);
  assert.equal(out.qbj, qbjText, 'MODAQ\'s key order: _round before packets');
  assert.equal(out.game, gameText, 'the game alone, as MODAQ writes it');
  // MODAQ's file names: team names joined by "_", spaces kept
  assert.deepEqual(modaqFilenames(3, ['A B', 'C']), { qbj: 'Round_3_A B_C.qbj', game: 'Round_3_A B_C_Game.json' });
});

test('modaqfile: a roster rename reaches MODAQ\'s own QBJ and game file, everywhere they name the team or player', () => {
  // Chicago C's Andy Lui is Andy Liu now; Old U is New U, and its Ann is Annie
  const names = rosterNameMap([
    { name: 'Chicago C', players: ['Andy Liu', 'Bo'], formerPlayers: { 'Andy Liu': ['Andy Lui'] } },
    { name: 'New U', players: ['Annie'], formerNames: ['Old U'], formerPlayers: { Annie: ['Ann'] } }]);
  const p = (name, teamName) => ({ name, teamName, isStarter: true });
  const qbj = { tossups_read: 2, match_teams: [
    { team: { name: 'Chicago C', players: [{ name: 'Andy Lui' }, { name: 'Bo' }] }, bonus_points: 10,
      match_players: [{ player: { name: 'Andy Lui' }, tossups_heard: 2, answer_counts: [{ number: 1, answer: { value: 10 } }] }],
      lineups: [{ first_question: 1, players: [{ name: 'Andy Lui' }, { name: 'Bo' }] }] },
    { team: { name: 'Old U', players: [{ name: 'Ann' }] }, bonus_points: 0,
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 2, answer_counts: [{ number: 1, answer: { value: -5 } }] }],
      lineups: [{ first_question: 1, players: [{ name: 'Ann' }] }] }],
  match_questions: [{ question_number: 1, buzzes: [
    { buzz_position: { word_index: 3 }, player: { name: 'Ann' }, team: { name: 'Old U', players: [{ name: 'Ann' }] }, result: { value: -5 } },
    { buzz_position: { word_index: 9 }, player: { name: 'Andy Lui' }, team: { name: 'Chicago C', players: [{ name: 'Andy Lui' }, { name: 'Bo' }] }, result: { value: 10 } }] }],
  _round: 1, packets: 'Packet A' };
  const game = { players: [p('Andy Lui', 'Chicago C'), p('Bo', 'Chicago C'), p('Ann', 'Old U')],
    cycles: [{
      wrongBuzzes: [{ marker: { player: p('Ann', 'Old U'), position: 3, points: -5, isLastWord: false }, tossupIndex: 0 }],
      correctBuzz: { marker: { player: p('Andy Lui', 'Chicago C'), position: 9, points: 10 }, tossupIndex: 0 },
      bonusAnswer: { bonusIndex: 0, receivingTeamName: 'Chicago C', parts: [{ teamName: 'Chicago C', points: 10 }] },
      playerLeaves: [{ outPlayer: p('Bo', 'Chicago C') }], playerJoins: [{ inPlayer: p('Andy Lui', 'Chicago C') }],
      tossupProtests: [{ teamName: 'Old U', questionIndex: 0, position: 3, reason: '' }] }],
    packet: { tossups: [{ question: 'Old U and Andy Lui', answer: 'x' }], bonuses: [] }, gameFormat: { pointsForPowers: [] } };
  const root = { qbj, game: { game, uiState: {} }, modaq: { qbj: JSON.stringify(qbj, null, 2), game: JSON.stringify(game, null, 2) } };
  const out = modaqExport(root, 1, names);
  const q = JSON.parse(out.qbj);
  const g = JSON.parse(out.game);
  // no old name left outside the packet text
  const noOld = (x) => !/Andy Lui|"Ann"|Old U/.test(JSON.stringify(x));
  assert.ok(noOld(q), out.qbj);
  assert.ok(noOld({ ...g, packet: null }), out.game);
  assert.deepEqual(q.match_teams.map((mt) => mt.team.name), ['Chicago C', 'New U']);
  assert.equal(q.match_questions[0].buzzes[1].player.name, 'Andy Liu');
  assert.deepEqual(g.players.map((x) => x.name + '/' + x.teamName), ['Andy Liu/Chicago C', 'Bo/Chicago C', 'Annie/New U']);
  assert.equal(g.cycles[0].wrongBuzzes[0].marker.player.name, 'Annie');
  assert.equal(g.cycles[0].wrongBuzzes[0].marker.player.teamName, 'New U');
  assert.equal(g.cycles[0].correctBuzz.marker.player.name, 'Andy Liu');
  assert.equal(g.cycles[0].playerJoins[0].inPlayer.name, 'Andy Liu');
  assert.equal(g.cycles[0].tossupProtests[0].teamName, 'New U');
  assert.equal(g.packet.tossups[0].question, 'Old U and Andy Lui', 'the packet text is the packet\'s');
  // the scores, buzz words and packet name are MODAQ's
  const m = parseMatch(q);
  assert.deepEqual(m.teams.map((t) => t.points), [20, -5]);
  assert.equal(q.match_questions[0].buzzes[1].buzz_position.word_index, 9);
  assert.equal(q.packets, 'Packet A');
  // still MODAQ's layout (2-space JSON), and the stats see the same game
  assert.equal(out.qbj, JSON.stringify(q, null, 2));
  assert.equal(JSON.stringify(q), JSON.stringify(renameMatch(qbj, names)));
  // nothing to rename: MODAQ's very text
  const keep = rosterNameMap([{ name: 'Elsewhere', players: ['Z'], formerNames: ['Gone'] }]);
  assert.equal(modaqExport(root, 1, keep).qbj, root.modaq.qbj);
  assert.equal(modaqExport(root, 1, keep).game, root.modaq.game);
  assert.equal(modaqExport(root, 1).qbj, root.modaq.qbj, 'no roster map: as before');
  // an older upload rebuilt from the reader's own halves is renamed too
  const older = modaqExport({ qbj, game: { game, uiState: {} } }, 1, names);
  assert.ok(noOld(JSON.parse(older.qbj)) && noOld({ ...JSON.parse(older.game), packet: null }));
  // a .qbj or game file added by hand, as text
  const bare = renameModaqTexts({ qbj: JSON.stringify(qbj), game: JSON.stringify(game) }, names);
  assert.ok(noOld(JSON.parse(bare.qbj)) && noOld({ ...JSON.parse(bare.game), packet: null }));
  assert.deepEqual(renameModaqTexts({ qbj: 'not json', game: null }, names), { qbj: 'not json', game: null });
  // a player only matches on their own team
  const other = renameModaqTexts({ qbj: null, game: JSON.stringify({ players: [p('Andy Lui', 'Elsewhere')], cycles: [] }) }, names);
  assert.equal(JSON.parse(other.game).players[0].name, 'Andy Lui');
});

/* ---------- Fix buzzes: a moderator's flipped names, put right ----------
   Real MODAQ games, played through its own state: the game as the
   moderator recorded it (Ann's and Bea's buzzes credited to each other)
   and the game as it should have been recorded. The fix has to turn the
   first upload into the second exactly, every copy of it, and MODAQ has
   to reopen the fixed game (the reader's resume, mobx-sync) to the same
   result. */
const { AppState: MApp } = modaqRequire('modaq/src/state/AppState.js');
const { AsyncTrunk: MTrunk } = modaqRequire('mobx-sync');
const { toQBJString: mToQBJString } = modaqRequire('modaq/src/qbj/QBJ.js');
async function mobxStore(app) {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const trunk = new MTrunk(app, { storage, storageKey: 'g', delay: 0 });
  await trunk.init();
  return { mem, trunk };
}
// a game played out, with `who` deciding whom the moderator credits
async function playedUpload(who) {
  const app = new MApp();
  const { mem, trunk } = await mobxStore(app);
  const game = app.game;
  const packet = new MPacket();
  packet.setTossups(Array.from({ length: 20 }, (_, i) => new MTossup(`T${i + 1} one two three four five six`, 'a')));
  packet.setBonuses(Array.from({ length: 20 }, (_, i) => new MBonus(`B${i + 1}`, [1, 2, 3].map(() => ({ question: 'p', answer: 'a', value: 10 })))));
  packet.setName('Packet');
  game.setGameFormat(ACFGameFormat);
  game.loadPacket(packet);
  const P = Object.fromEntries([['Ann', 'Alpha', true], ['Bea', 'Alpha', true], ['Cal', 'Alpha', true], ['Dee', 'Alpha', false],
    ['Bob', 'Beta', true], ['Ben', 'Beta', true]].map(([n, t, s]) => [n, new MPlayer(n, t, s)]));
  game.addNewPlayers(Object.values(P));
  const p = (ci, name) => P[who(ci, name)];
  const right = (ci, name, position = 3) => {
    game.cycles[ci].addCorrectBuzz({ player: p(ci, name), position, points: 10 }, game.getTossupIndex(ci), game.gameFormat, game.getBonusIndex(ci), 3);
    game.cycles[ci].setBonusPartAnswer(0, P[name].teamName, 10);
  };
  const wrong = (ci, name, position = 1) => game.cycles[ci].addWrongBuzz({ player: p(ci, name), position, points: -5, isLastWord: false }, game.getTossupIndex(ci), game.gameFormat);
  right(0, 'Ann'); wrong(1, 'Bea'); right(1, 'Bob', 4); wrong(2, 'Ann'); wrong(2, 'Ben', 2);
  right(3, 'Bea'); right(4, 'Ann', 2); right(5, 'Cal'); wrong(6, 'Bob'); right(6, 'Ann', 5);
  wrong(7, 'Ann', 2); right(7, 'Bea', 2); right(8, 'Ben'); right(9, 'Bea', 1);
  game.cycles[10].addSwapSubstitution(P.Dee, P.Cal);
  right(10, 'Dee'); right(11, 'Ann'); wrong(12, 'Bea'); right(13, 'Bob'); right(14, 'Bea', 4);
  for (let ci = 15; ci < 20; ci++) right(ci, ci % 2 ? 'Ann' : 'Ben');
  await trunk.persist();
  trunk.disposer && trunk.disposer();
  const storeText = mem.get('g');
  const qbj = toQBJ(game, 'Packet', 4);
  return JSON.parse(combinedUpload(qbj, 4, storeText, null, null, null,
    { qbj: mToQBJString(game, 'Packet', 4), game: JSON.stringify(game, null, 2) }));
}
// what the reader does on Edit in MODAQ: resume the saved state, export it
async function reopened(root) {
  const app = new MApp();
  const { trunk } = await mobxStore(app);
  trunk.disposer && trunk.disposer();
  const mem = new Map([['g', JSON.stringify(root.game)]]);
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const again = new MApp();
  const t2 = new MTrunk(again, { storage, storageKey: 'g', delay: 0 });
  await t2.init();
  t2.disposer && t2.disposer();
  return { qbj: mToQBJString(again.game, 'Packet', 4), game: JSON.stringify(again.game, null, 2) };
}
const flipAB = (ci, n) => (n === 'Ann' ? 'Bea' : n === 'Bea' ? 'Ann' : n);
const asIs = (ci, n) => n;
const bfFlipped = await playedUpload(flipAB);
const bfTruth = await playedUpload(asIs);
// the same game, with the buzz on question 15 really Cal's
const bfTruthCal = await playedUpload((ci, n) => (ci === 14 ? 'Cal' : n));
// Ann was really Eve all game, never entered
const bfEve = await playedUpload((ci, n) => (n === 'Ann' ? 'Ann' : n));
const swapAB = { swaps: [{ team: 'Alpha', from: 'Ann', to: 'Bea' }] };
const bfFixed = applyBuzzFix(bfFlipped, swapAB);
const bfReopened = await reopened(bfFixed);
// the saved game, less the time it was saved
const noStamp = (g) => { const { lastUpdate, ...rest } = g; return rest; };
const gameHalf = (r) => noStamp(r.game.game);
const gameFile = (text) => noStamp(JSON.parse(text));

test('Fix buzzes: swapping two teammates turns the flipped upload into the right one, all copies', () => {
  assert.notDeepEqual(bfFlipped.qbj, bfTruth.qbj, 'the fixture really is flipped');
  assert.deepEqual(bfFixed.qbj, bfTruth.qbj, 'the stats qbj');
  assert.equal(bfFixed.modaq.qbj, bfTruth.modaq.qbj, 'MODAQ\'s qbj, to the byte');
  assert.deepEqual(gameFile(bfFixed.modaq.game), gameFile(bfTruth.modaq.game), 'MODAQ\'s game file');
  assert.deepEqual(gameHalf(bfFixed), gameHalf(bfTruth), 'the saved game the reader resumes');
  const a = parseMatch(bfFixed, { filename: 'x.qbtd.json' });
  const f = parseMatch(bfFlipped, { filename: 'x.qbtd.json' });
  assert.deepEqual(a.teams.map((t) => t.points), f.teams.map((t) => t.points), 'neither score moves');
});

test('Fix buzzes: Edit in MODAQ reopens the fixed game exactly as fixed', () => {
  assert.equal(bfReopened.qbj, bfFixed.modaq.qbj);
  assert.equal(bfReopened.qbj, bfTruth.modaq.qbj);
  assert.deepEqual(gameFile(bfReopened.game), gameFile(bfTruth.modaq.game));
});

test('Fix buzzes: a swap equals editing each of the two players\' buzzes, and the original is untouched', () => {
  const before = JSON.stringify(bfFlipped);
  const view = buzzFixView(bfFlipped);
  const edits = view.buzzes.filter((b) => b.team === 'Alpha' && (b.player === 'Ann' || b.player === 'Bea'))
    .map((b) => ({ q: b.q, j: b.j, to: flipAB(0, b.player) }));
  assert.ok(edits.length > 10);
  assert.deepEqual(applyBuzzFix(bfFlipped, { edits }), bfFixed);
  assert.equal(JSON.stringify(bfFlipped), before);
});

test('Fix buzzes: after a swap, All buzzes shows the swapped names, and an edit there lands on top', () => {
  // the view All buzzes draws: the upload with the swap applied
  const shown = buzzFixView(applyBuzzFix(bfFlipped, swapAB));
  assert.deepEqual(shown, buzzFixView(bfTruth));
  const b = shown.buzzes.find((x) => x.q === 14);
  assert.equal(b.player, 'Bea', 'question 15 reads Bea once swapped');
  const both = applyBuzzFix(bfFlipped, { ...swapAB, edits: [{ q: 14, j: b.j, to: 'Cal' }] });
  assert.deepEqual(both.qbj, bfTruthCal.qbj);
  assert.equal(both.modaq.qbj, bfTruthCal.modaq.qbj);
  assert.deepEqual(gameHalf(both), gameHalf(bfTruthCal));
  // an edit back to the swapped name changes nothing
  assert.deepEqual(applyBuzzFix(bfFlipped, { ...swapAB, edits: [{ q: 14, j: b.j, to: 'Bea' }] }), bfFixed);
});

test('Fix buzzes: buzzes stay on their team', () => {
  const view = buzzFixView(bfFlipped);
  const ann = view.buzzes.find((x) => x.player === 'Ann');
  assert.throws(() => applyBuzzFix(bfFlipped, { edits: [{ q: ann.q, j: ann.j, to: 'Bob' }] }), /not playing for Alpha/);
  assert.throws(() => applyBuzzFix(bfFlipped, { swaps: [{ team: 'Alpha', from: 'Ann', to: 'Bob' }] }), /plays for Beta/);
  assert.throws(() => applyBuzzFix(bfFlipped, { swaps: [{ team: 'Alpha', from: 'Bob', to: 'Ann' }] }), /not playing for Alpha/);
  assert.throws(() => applyBuzzFix(bfFlipped, { swaps: [swapAB.swaps[0], { team: 'Alpha', from: 'Bea', to: 'Cal' }] }), /another swap/);
});

test('Fix buzzes: a roster player never entered takes the name throughout', () => {
  const fixed = applyBuzzFix(bfEve, { swaps: [{ team: 'Alpha', from: 'Ann', to: 'Eve' }] });
  const text = JSON.stringify(fixed);
  assert.ok(!/"Ann"/.test(text), 'no Ann left in any copy');
  const m = parseMatch(fixed, { filename: 'x.qbtd.json' });
  const was = parseMatch(bfEve, { filename: 'x.qbtd.json' });
  const line = (mm, n) => mm.teams[0].players.find((x) => x.name === n);
  assert.deepEqual(line(m, 'Eve'), { ...line(was, 'Ann'), name: 'Eve' });
});
const bfEveReopened = await reopened(applyBuzzFix(bfEve, { swaps: [{ team: 'Alpha', from: 'Ann', to: 'Eve' }] }));
test('Fix buzzes: the renamed game reopens in MODAQ under the new name', () => {
  const fixed = applyBuzzFix(bfEve, { swaps: [{ team: 'Alpha', from: 'Ann', to: 'Eve' }] });
  assert.equal(bfEveReopened.qbj, fixed.modaq.qbj);
});

test('Fix buzzes: a bare qbj from elsewhere, counts kept in its own shape', () => {
  const bare = JSON.parse(JSON.stringify(bfFlipped.qbj));
  // another tool's counts: each value listed, zeros included
  for (const mt of bare.match_teams) for (const mp of mt.match_players) {
    for (const v of [10, 0, -5]) if (!mp.answer_counts.some((ac) => ac.answer.value === v)) mp.answer_counts.push({ answer: { value: v }, number: 0 });
  }
  const fixed = applyBuzzFix(bare, swapAB);
  const truth = parseMatch(bfTruth.qbj);
  const got = parseMatch(fixed);
  const counts = (mm) => mm.teams.map((t) => t.players.map((p) => [p.name, [10, 0, -5].map((v) => (p.counts.find((c) => c.value === v) || { n: 0 }).n)]));
  assert.deepEqual(counts(got), counts(truth));
  assert.equal(fixed.match_teams[0].match_players[0].answer_counts.length, 3, 'zero entries stay');
});

test('Fix buzzes: a buzz moved to someone not in the lineup is flagged', () => {
  const view = buzzFixView(bfFlipped);
  const dee = view.buzzes.find((x) => x.player === 'Dee');
  const cal = view.buzzes.find((x) => x.player === 'Cal');
  assert.equal(lineupGaps(bfFlipped).size, 0);
  const gaps = lineupGaps(applyBuzzFix(bfFlipped, { edits: [{ q: dee.q, j: dee.j, to: 'Cal' }, { q: cal.q, j: cal.j, to: 'Dee' }] }));
  assert.deepEqual([...gaps].sort(), [`${cal.q}:${cal.j}`, `${dee.q}:${dee.j}`].sort());
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
