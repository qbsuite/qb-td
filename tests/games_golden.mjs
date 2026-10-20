// games_golden.mjs — E1: the public game pipeline, pinned. The game loops
// of the public page and the archive (tests/ref_games.mjs, verbatim from
// 0cd19c5) run on every fixture (tests/games_fixtures.mjs), and what they
// give, and everything built from it — the stat report, its data, both
// YellowFruit files, buzzpoints and categories per round — must equal
// tests/golden/games.json. A refactor that moves game loading into a
// module adds its own function to `candidates` below and must give the same.
// Run: node tests/games_golden.mjs (part of npm test).
// QBTD_UPDATE_GOLDEN=1 rewrites the golden from the current code.

import assert from 'node:assert/strict';
import { parseRoster, rosterNameMap } from '../app/engine/qbj.js';
import { dedupeMatches } from '../app/engine/stats.js';
import { buildReport, reportData } from '../app/engine/report.js';
import { serializeYft } from '../app/engine/yft.js';
import { serializeYft3 } from '../app/engine/yft3.js';
import { roundTossupBuzzes, buzzSummary } from '../app/engine/buzz.js';
import { categoryStats } from '../app/engine/cats.js';
import { effectiveFormat } from '../app/js/read_core.js';
import { pubviewFetchMatches, pubviewLoop, archiveParseBundle } from './ref_games.mjs';
import { allFixtures } from './games_fixtures.mjs';
import { attempt, checkGolden, jsonSha } from './golden_lib.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok', name); }
  catch (e) { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

const parsedRoster = (q) => {
  if (!q) return null;
  try { return parseRoster(q); } catch (e) { return null; }
};

// The page's loop on a fixture, and what the page reads back from it.
async function pubRun(fx) {
  const entries = structuredClone(fx.entries);
  const roster = parsedRoster(fx.rosterQbj);
  const got = await pubviewFetchMatches({ entries, files: fx.files, roster });
  const names = rosterNameMap(roster);
  const byId = new Map(entries.map((e) => [e.id, e]));
  return { entries, roster, names, byId, ...got };
}

function pubSummary(r) {
  return {
    matches: jsonSha(r.matches),
    count: r.matches.length,
    errors: r.errors,
    fileIds: r.matches.map((m) => m.fileId),
    rawEntries: jsonSha(r.rawEntries),
    rawEntryIds: r.rawEntries.map((e) => e.id),
    rawRooms: r.rawEntries.map((e) => e.room),
    entryRooms: r.entries.map((e) => e.room),
    loadedIds: [...r.loadedIds],
    // with no renames the page keeps each game's own object: no copy made
    sameObjects: r.rawEntries.every((e) => e.qbj === r.byId.get(e.id).qbj),
  };
}

// Everything the public page and the exports build from the games.
function derived(fx, r) {
  const opts = { name: fx.name, matches: dedupeMatches(r.matches), roster: r.roster,
    settings: effectiveFormat(fx.format), schedule: fx.schedule };
  const pages = attempt(() => buildReport(opts));
  const rounds = [...new Set(r.rawEntries.map((e) => e.round))].sort((a, b) => a - b);
  const per = (fn) => Object.fromEntries(rounds.map((n) => [n, jsonSha(attempt(() => fn(n)))]));
  return {
    report: Array.isArray(pages) ? Object.fromEntries(pages.map((p) => [p.name, jsonSha(p.text)])) : pages,
    reportData: jsonSha(attempt(() => reportData(opts))),
    yft4: jsonSha(attempt(() => serializeYft(opts))),
    yft3: jsonSha(attempt(() => serializeYft3(opts))),
    tossupBuzzes: per((n) => roundTossupBuzzes(r.rawEntries, n)),
    buzzSummary: { all: jsonSha(attempt(() => buzzSummary(r.rawEntries))), ...per((n) => buzzSummary(r.rawEntries.filter((e) => e.round === n))) },
    categories: fx.catmap ? { all: jsonSha(attempt(() => categoryStats(r.rawEntries, fx.catmap))),
      ...per((n) => categoryStats(r.rawEntries.filter((e) => e.round === n), fx.catmap)) } : null,
  };
}

const fixtures = await allFixtures();
const golden = {};

for (const fx of fixtures) {
  const r = await pubRun(fx);
  const arch = archiveParseBundle({ entries: structuredClone(fx.entries) }, r.roster);
  golden[fx.label] = {
    pub: pubSummary(r),
    archive: { matches: jsonSha(arch.matches), count: arch.matches.length, errors: arch.errors },
    derived: derived(fx, r),
  };
  await test(fx.label + ': the page keeps each game\'s own object unless a roster renames', () => {
    if (!r.names) assert.ok(golden[fx.label].pub.sameObjects, 'a copy was made with no renames');
    else assert.ok(r.rawEntries.some((e) => e.qbj !== r.byId.get(e.id).qbj), 'renames must not edit the fetched games in place');
  });
  await test(fx.label + ': the loop without awaits gives the same', () => {
    const entries = structuredClone(fx.entries);
    const s = pubviewLoop(entries, r.names, fx.files);
    assert.equal(jsonSha(s.matches), golden[fx.label].pub.matches);
    assert.deepEqual(s.errors, r.errors);
    assert.equal(jsonSha(s.rawEntries), golden[fx.label].pub.rawEntries);
  });
}

await test('fixtures cover what the design lists', () => {
  const v = golden['variants+renames'];
  assert.ok(v.pub.errors.some((e) => e.startsWith('Round_8_broken.qbj: ')), 'an unparseable entry');
  assert.ok(v.pub.entryRooms.includes('Library'), 'a live room override');
  assert.ok(golden['variants'].pub.rawEntryIds.length < golden['variants'].pub.count, 'dedupeEntries collapses');
  assert.ok(golden.demo.pub.fileIds.some((id) => id >= 1000), 'demo uploads');
});

await test('games.json golden: matches, raw rows, errors, rooms and every export built from them', () => {
  const diffs = checkGolden('games.json', golden);
  assert.equal(diffs.length, 0, diffs.join('\n    '));
});

console.log(passed + ' game-loading golden checks passed' + (process.exitCode ? ' (with failures)' : ''));
