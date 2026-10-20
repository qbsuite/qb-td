// games_golden.mjs — E1: the public game pipeline, pinned. The game loops
// of the public page and the archive (tests/ref_games.mjs, verbatim from
// 0cd19c5) run on every fixture (tests/games_fixtures.mjs), and what they
// give, and everything built from it — the stat report, its data, both
// YellowFruit files, buzzpoints and categories per round — must equal
// tests/golden/games.json. A refactor that moves game loading into a
// module adds its own functions to `candidates` below: each fixture goes
// through them too, and they must give what the reference copies give.
// app/engine/games.js is one: readGames as the page and the archive call
// it, and readGame in the hub's per-game step (hubPerGame).
// Run: node tests/games_golden.mjs (part of npm test).
// QBTD_UPDATE_GOLDEN=1 rewrites the golden from the current code.

import assert from 'node:assert/strict';
import { parseRoster, rosterNameMap, matchPayload } from '../app/engine/qbj.js';
import { dedupeMatches } from '../app/engine/stats.js';
import { buildReport, reportData } from '../app/engine/report.js';
import { serializeYft } from '../app/engine/yft.js';
import { serializeYft3 } from '../app/engine/yft3.js';
import { roundTossupBuzzes, buzzSummary, dedupeEntries } from '../app/engine/buzz.js';
import { readGame, readGames } from '../app/engine/games.js';
import { categoryStats } from '../app/engine/cats.js';
import { effectiveFormat } from '../app/js/read_core.js';
import { pubviewFetchMatches, pubviewLoop, archiveParseBundle, hubRef } from './ref_games.mjs';
import { allFixtures } from './games_fixtures.mjs';
import { attempt, checkGolden, jsonSha } from './golden_lib.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok', name); }
  catch (e) { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

// A moved game loader, run on each fixture beside the reference copies.
// `pub` takes what pubviewFetchMatches takes ({ entries, files, roster })
// and resolves to the same shape ({ matches, errors, rawEntries,
// loadedIds }); everything the page builds from it (report, YellowFruit,
// buzzpoints, categories) must come out the same too. `archive` takes what
// archiveParseBundle takes (bundle, roster) and gives { matches, errors }.
// Either may be left out.
const candidates = [
  // app/engine/games.js, the way the page and the archive will call it:
  // the page first takes each game's room from the live file list (on the
  // same entry objects, so the round cache keeps them), then reads them
  { name: 'games.js readGames', pub: async ({ entries, files, roster }) => {
    const names = rosterNameMap(roster);
    const loadedIds = new Set(entries.map((e) => e.id));
    const liveRoom = new Map((files || []).map((f) => [f.id, f.room]));
    for (const entry of entries) if (liveRoom.get(entry.id)) entry.room = liveRoom.get(entry.id);
    const errors = [];
    const { matches, raw } = readGames(entries, names, errors);
    return { matches, errors, rawEntries: dedupeEntries(raw), loadedIds };
  }, archive: (bundle, roster) => {
    const errors = [];
    const { matches } = readGames(bundle.entries, rosterNameMap(roster), errors);
    return { matches, errors };
  } },
];

const parsedRoster = (q) => {
  if (!q) return null;
  try { return parseRoster(q); } catch (e) { return null; }
};

// The page's loop on a fixture, and what the page reads back from it.
async function pubRun(fx, load = pubviewFetchMatches) {
  const entries = structuredClone(fx.entries);
  const roster = parsedRoster(fx.rosterQbj);
  const got = await load({ entries, files: fx.files, roster });
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

// The hub's per-game step (admin.js collectMatches, tests/ref_games.mjs)
// against readGame in its place, on the fixture's games as hub uploads:
// every other one a reader upload ({qbj, game: null}, so no MODAQ files),
// every fourth one in a room deleted since. The games come from the
// cache, so only the roster is read. Matches, raw rows and errors must be
// the reference's, key order included.
async function hubPerGame(fx) {
  const rooms = [...new Set(fx.entries.map((e) => e.room))];
  const buckets = rooms.map((room_name, i) => ({ id: i + 1, room_name }));
  const files = fx.entries.map((e, i) => ({
    id: e.id, bucket_id: i % 4 === 3 ? null : rooms.indexOf(e.room) + 1, round: e.round,
    kind: i % 2 ? 'qbj' : 'combined', error: null, r2_key: 'k' + i, size: 100 + i, created: 1e12 - i,
    filename: i % 2 ? e.filename : e.filename.replace(/\.qbj$/i, '.qbtd.json'),
  }));
  const upload = (e, i) => (i % 2 ? e.qbj : { qbj: e.qbj, game: null });
  const cacheOf = () => new Map(files.map((f, i) => [f.id + '|' + f.size + '|' + f.created + '|' + f.round,
    upload(structuredClone(fx.entries[i]), i)]));
  const pub = async (p) => {
    if (p.includes('roster')) return structuredClone(fx.rosterQbj);
    throw new Error('read past the cache: ' + p);
  };
  const t = { roster_r2_key: fx.rosterQbj ? 't/1/roster.qbj' : null };
  const ref = await hubRef({ pub }).collectMatches('/a/x', t, buckets, files, () => {}, { cache: cacheOf() });
  const got = [...cacheOf().values()];
  const matches = [];
  const raw = [];
  const errors = [];
  for (const [i, f] of files.entries()) {
    try {
      const bucket = buckets.find((b) => b.id === f.bucket_id);
      const { m, qbj: payload } = readGame(matchPayload(got[i]), ref.names,
        { id: f.id, filename: f.filename, room: bucket ? bucket.room_name : '' });
      m.filename = f.filename.replace(/\.qbtd\.json$/i, '.qbj');
      matches.push(m);
      raw.push({ id: f.id, round: m.round, room: m.room, reader: f.kind === 'combined', filename: m.filename,
        text: JSON.stringify(payload) });
    } catch (e) { errors.push(f.filename + ': ' + e.message); }
  }
  return { ref, matches, raw, errors };
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
  await test(fx.label + ': readGame does the hub\'s per-game step', async () => {
    const h = await hubPerGame(fx);
    assert.ok(h.matches.length > 0);
    assert.equal(JSON.stringify(h.matches), JSON.stringify(h.ref.matches));
    assert.equal(JSON.stringify(h.raw), JSON.stringify(h.ref.raw));
    assert.deepEqual(h.errors, h.ref.errors.filter((e) => !e.startsWith('Roster: ')));
  });
  for (const cand of candidates) {
    if (cand.pub) {
      await test(`${fx.label}: ${cand.name} loads what the public page's loop loads`, async () => {
        const rc = await pubRun(fx, cand.pub);
        assert.deepEqual(pubSummary(rc), golden[fx.label].pub);
        assert.deepEqual(derived(fx, rc), golden[fx.label].derived);
      });
    }
    if (cand.archive) {
      await test(`${fx.label}: ${cand.name} loads what the archive's loop loads`, () => {
        const a = cand.archive({ entries: structuredClone(fx.entries) }, parsedRoster(fx.rosterQbj));
        assert.deepEqual({ matches: jsonSha(a.matches), count: a.matches.length, errors: a.errors }, golden[fx.label].archive);
      });
    }
  }
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
