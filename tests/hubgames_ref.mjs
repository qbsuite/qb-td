// hubgames_ref.mjs — E9: the hub's game loading, app/js/hubgames.js, held
// to the admin.js code it was moved from (tests/ref_games.mjs hubRef, as
// at 0cd19c5). Each case runs both on the same answers, each through its
// own logging pub(), and they must make the same requests in the same
// order with as many in flight, report the same progress, and give the
// same roster, renames, matches, raw rows, MODAQ files, game halves and
// errors, key order included. The answers come from:
//   a stand-in pub  330 uploads of every kind, with renames, a deleted
//                   room, a read that fails, text that isn't JSON, a
//                   game that won't parse, a reader upload whose MODAQ
//                   export throws after the game is counted, and a
//                   /games route that misses some ids, sends a copy that
//                   isn't a game and fails a whole batch; Compute stats
//                   and the playoff fill (rank), each called twice on its
//                   cache, a round move, no roster, a roster that fails
//   the demo        demo.js demoPub, which has no /games route
//   the Worker      worker/worker.js in this process
//                   (tests/inproc_worker.mjs), with D1 and R2 operations
//                   that must match too
// On top of matching the reference, the request pattern is pinned: the
// roster first, /games batches of 100 one after another, at most 6 file
// reads at once, and a second call on the same cache reading only the
// roster. The hub's other moved pieces (gameFormat, the roster renames
// the listings use) are checked against the same reference or admin.js
// as it was.
// The QBJ bundle download is held the same way: admin.js's buildZip as
// the file has it now (tests/admin_src.mjs) against the copy pinned in
// ref_games.mjs (hubZipRef), on what each collectMatches above gave:
// the same reads in the same order, one at a time, the same D1 and R2
// operations, and the same zip byte for byte. Its own cases: a re-upload
// with the teams swapped (both kept), a .qbj added by hand under MODAQ's
// name for a reader's game (the reader's wins), a '/' in a team name (a
// folder), and game files that can't be read (left out).
// Run: node tests/hubgames_ref.mjs (part of npm test; Node 22.5+).

import assert from 'node:assert/strict';
import { parseRoster, rosterNameMap } from '../app/engine/qbj.js';
import { fileSummary as uploadedSummary } from '../app/js/protests.js';
import { collectMatches, gameFormat, createHubNames, ownedJson } from '../app/js/hubgames.js';
import { hubRef, hubZipRef } from './ref_games.mjs';
import { hubOwnBuildZip } from './admin_src.mjs';
import { readZip } from '../app/engine/zip.js';
import { workerHarness } from './inproc_worker.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok', name); }
  catch (e) { console.error('FAIL', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

// A pub() that logs each request as it starts, and how many game file
// reads and /games batches are in flight at once.
function logged(pub) {
  const rec = { log: [], fileMax: 0, gamesMax: 0 };
  let files = 0;
  let games = 0;
  rec.pub = async (path, opts) => {
    rec.log.push(path);
    const isGames = path.includes('/games?');
    const isFile = path.includes('/file?') && !path.includes('roster');
    if (isGames) rec.gamesMax = Math.max(rec.gamesMax, ++games);
    if (isFile) rec.fileMax = Math.max(rec.fileMax, ++files);
    try { return await pub(path, opts); }
    finally { if (isGames) games--; if (isFile) files--; }
  };
  return rec;
}

// What a call gives, as text where order counts (key order included).
const outputOf = (o) => ({
  roster: JSON.stringify(o.roster), matches: JSON.stringify(o.matches), raw: JSON.stringify(o.raw),
  games: JSON.stringify(o.games), modaqFiles: JSON.stringify(o.modaqFiles), errors: JSON.stringify(o.errors),
});

/**
 * The reference and hubgames.js, each called `calls.length` times in
 * turn with its own pub (makePub() gives a fresh one) and its own caches;
 * calls[i] = { a, t, buckets, files, opts: () => opts } with opts made
 * fresh per side (each side its own cache, kept across its calls when
 * the same Map is handed back). Asserts both sides match call by call and
 * returns what hubgames.js did.
 */
async function bothSides(makePub, calls, measure = null) {
  const sides = {};
  for (const side of ['ref', 'cand']) {
    const rec = logged(makePub());
    const ref = hubRef({ pub: rec.pub });
    const caches = new Map();
    const runs = [];
    const ops = [];
    for (const c of calls) {
      const opts = c.opts ? c.opts(caches) : undefined;
      const progress = [];
      const at = rec.log.length;
      const onFile = (done, total) => progress.push([done, total]);
      const run = () => (side === 'ref'
        ? ref.collectMatches(c.a, c.t, c.buckets, c.files, onFile, ...(opts ? [opts] : []))
        : collectMatches(rec.pub, c.a, c.t, c.buckets, c.files, onFile, ...(opts ? [opts] : [])));
      let out;
      if (measure) { const m = await measure(run); out = m.res; ops.push(m.ops); } else out = await run();
      runs.push({ out, progress, log: rec.log.slice(at), cache: opts && opts.cache });
    }
    sides[side] = { rec, runs, ops };
  }
  const { ref, cand } = sides;
  assert.deepEqual(cand.rec.log, ref.rec.log, 'the same requests in the same order');
  assert.deepEqual(cand.ops, ref.ops, 'the same D1 statements and R2 operations');
  assert.equal(cand.rec.fileMax, ref.rec.fileMax, 'as many file reads at once');
  assert.equal(cand.rec.gamesMax, ref.rec.gamesMax, 'as many /games batches at once');
  for (const [i, r] of ref.runs.entries()) {
    const c = cand.runs[i];
    assert.deepEqual(c.progress, r.progress, `call ${i + 1}: the same progress`);
    assert.deepEqual(outputOf(c.out), outputOf(r.out), `call ${i + 1}: the same games`);
    assert.deepEqual(c.out.names, r.out.names, `call ${i + 1}: the same renames`);
    assert.deepEqual(Object.keys(c.out), Object.keys(r.out), `call ${i + 1}: the same fields`);
    if (r.cache) {
      assert.deepEqual([...c.cache.keys()], [...r.cache.keys()], `call ${i + 1}: the same cache keys`);
      assert.deepEqual([...c.cache.values()], [...r.cache.values()], `call ${i + 1}: the same cached games`);
    }
  }
  return cand;
}

/* ---------- the QBJ bundle (admin.js showStats buildZip) ---------- */

const ownBuildZip = await hubOwnBuildZip();

/**
 * The QBJ bundle as admin.js builds it now and as it was (hubZipRef),
 * each with its own logging pub (makePub() gives a fresh one), on what
 * Compute stats left: `got` from collectMatches and `keep`, the rounds
 * picked (null for all), narrowed as showStats narrows them. Asserts the
 * same reads in the same order, one at a time, the same D1 and R2
 * operations when `measure` is given, and the same file byte for byte.
 * Returns the file, with its entries read back.
 */
async function bothZips(makePub, { a, t, files, got, keep = null }, measure = null) {
  const inPick = (x) => !keep || keep.has(x.round);
  const modaqFiles = (got.modaqFiles || []).filter(inPick);
  const raw = got.raw.filter(inPick);
  const sides = {};
  for (const side of ['ref', 'cand']) {
    const rec = logged(makePub());
    let open = 0;
    let most = 0;
    const pub = async (path, opts) => {
      most = Math.max(most, ++open);
      try { return await rec.pub(path, opts); } finally { open--; }
    };
    const dl = [];
    const download = (name, data, type) => dl.push({ name, data, type });
    const ctx = { pub, a, t, files, got, modaqFiles, raw, inPick, download };
    const buildZip = side === 'ref' ? hubZipRef(ctx) : ownBuildZip(ctx);
    const ops = measure ? (await measure(buildZip)).ops : (await buildZip(), null);
    sides[side] = { log: rec.log, most, dl, ops };
  }
  const { ref, cand } = sides;
  assert.deepEqual(cand.log, ref.log, 'the same reads in the same order');
  assert.ok(cand.most <= 1 && ref.most <= 1, 'one read at a time');
  assert.deepEqual(cand.ops, ref.ops, 'the same D1 statements and R2 operations');
  assert.equal(ref.dl.length, 1);
  assert.equal(cand.dl.length, 1, 'one download');
  const [r, c] = [ref.dl[0], cand.dl[0]];
  assert.deepEqual([c.name, c.type], [r.name, r.type], 'the same name and type');
  assert.ok(c.data instanceof Uint8Array && r.data instanceof Uint8Array);
  const entries = await readZip(c.data);
  assert.deepEqual(entries.map((e) => e.name), (await readZip(r.data)).map((e) => e.name), 'the same entries in order');
  assert.ok(Buffer.from(c.data).equals(Buffer.from(r.data)), 'the same zip, byte for byte');
  return { ...c, entries, log: cand.log };
}
const zipText = (z, name) => { const e = z.entries.find((x) => x.name === name); return e ? new TextDecoder().decode(e.data) : null; };

/* ---------- a stand-in pub: every kind of upload, and every way to fail ---------- */

const match = (round, a = 'Alpha', b = 'Beta') => ({
  tossups_read: 20,
  match_teams: [
    { team: { name: a, players: [{ name: 'Ann' }, { name: 'Al' }] }, bonus_points: 30,
      lineups: [{ first_question: 1, players: [{ name: 'Ann' }, { name: 'Al' }] }],
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20, answer_counts: [{ number: 3, answer: { value: 10 } }] },
        { player: { name: 'Al' }, tossups_heard: 20, answer_counts: [] }] },
    { team: { name: b, players: [{ name: 'Bob' }, { name: 'Bea' }] }, bonus_points: 0,
      lineups: [{ first_question: 1, players: [{ name: 'Bob' }, { name: 'Bea' }] }],
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20, answer_counts: [{ number: 1, answer: { value: 10 } }] },
        { player: { name: 'Bea' }, tossups_heard: 20, answer_counts: [] }] },
  ],
  match_questions: [1, 2, 3, 4].map((q) => ({ question_number: q, tossup_question: { question_number: q, type: 'tossup', parts: 1 },
    buzzes: [{ player: { name: q % 2 ? 'Ann' : 'Bob' }, team: { name: q % 2 ? a : b }, buzz_position: { word_index: 10 * q }, result: { value: 10 } }] })),
  notes: '', _round: round, packets: 'P' + round,
});
const gameOf = (a, b) => ({
  players: [{ name: 'Ann', teamName: a, isStarter: true }, { name: 'Al', teamName: a, isStarter: true },
    { name: 'Bob', teamName: b, isStarter: true }, { name: 'Bea', teamName: b, isStarter: true }],
  teamNames: [a, b],
  packet: { tossups: [{ question: 'Q'.repeat(100), answer: 'A' }], bonuses: [] },
  cycles: [{ correctBuzz: { marker: { player: { name: 'Ann', teamName: a }, position: 10, points: 10 } } }],
});
const rosterQbj = { version: '2.1.1', objects: [{ type: 'Tournament', name: 'Stand-in', registrations: [
  { name: 'Alpha Prime', teams: [{ name: 'Alpha Prime', _formerNames: ['Alpha'], players: [{ name: 'Annie', _formerNames: ['Ann'] }, { name: 'Al' }] }] },
  { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }, { name: 'Bea' }] }] },
  { name: 'Gamma', teams: [{ name: 'Gamma', players: [{ name: 'Gil' }] }] },
] }] };

const N = 330;
const ROSTER_KEY = 't/1/roster.qbj';
const store = new Map(); // r2_key -> () => what the Worker answers (a fresh copy each read)
const files = [];
const BOOM = 'Round_9_boom.qbtd.json';
for (let i = 0; i < N; i++) {
  const id = 9000 - i; // the hub's list is newest first
  const round = 1 + (i % 9);
  const [a, b] = i % 3 ? ['Alpha', 'Beta'] : ['Gamma', 'Alpha'];
  const kinds = ['combined', 'qbj', 'combined-legacy', 'combined-nogame', 'qbj', 'game', 'other', 'qbj-error', 'combined', 'qbj'];
  let kind = kinds[i % kinds.length];
  let filename = `Round_${round}_${a}_${b}_${i}`;
  const key = 't/1/up/' + id;
  let value;
  if (kind === 'combined') value = () => ({ qbj: match(round, a, b), game: { game: gameOf(a, b), uiState: {} },
    modaq: { qbj: JSON.stringify(match(round, a, b), null, 4), game: JSON.stringify(gameOf(a, b), null, 2) },
    protests: [], progress: { at: 20, of: 20 } });
  else if (kind === 'combined-legacy') value = () => ({ qbj: match(round, a, b), game: { game: gameOf(a, b), uiState: {} } });
  else if (kind === 'combined-nogame') value = () => ({ qbj: match(round, a, b), game: null });
  else if (kind === 'game') value = () => gameOf(a, b);
  else if (kind === 'other') value = () => new Response('hello', { headers: { 'Content-Type': 'text/plain' } });
  else value = () => match(round, a, b);
  kind = kind.replace(/-.*/, '');
  filename += kind === 'combined' ? '.qbtd.json' : kind === 'game' ? '_Game.json' : kind === 'other' ? '.txt' : '.qbj';
  // the special cases, by position
  if (i === 11) { // a reader upload whose MODAQ export throws once it is counted
    kind = 'combined';
    filename = BOOM;
    // (not enumerable: a comparison of what was cached doesn't trip it)
    value = () => ({ qbj: match(9, a, b), game: { game: gameOf(a, b), uiState: {} },
      modaq: Object.defineProperty({ game: '{}' }, 'qbj', { get() { throw new Error('boom'); }, enumerable: false }) });
  }
  if (i === 21) value = () => { throw Object.assign(new Error('request failed (404)'), { status: 404 }); }; // a read that fails
  if (i === 31) value = () => new Response(JSON.stringify(match(round, a, b), null, 2), { headers: { 'Content-Type': 'application/octet-stream' } });
  if (i === 41) value = () => new Response('{"not json', { headers: { 'Content-Type': 'application/octet-stream' } });
  if (i === 51) value = () => ({ x: 1 }); // stored, but no game in it
  store.set(key, value);
  files.push({ id, bucket_id: i === 61 ? null : 1 + (i % 4), round, kind, r2_key: key, filename, size: 1000 + i,
    created: 2e12 - i * 1000, error: kind === 'qbj' && i % 10 === 7 ? 'not a game' : null, summary: null });
}
store.set(ROSTER_KEY, () => structuredClone(rosterQbj));
const buckets = [{ id: 1, room_name: 'Room A' }, { id: 2, room_name: 'Room B' }, { id: 3, room_name: 'Room C' }]; // room 4 deleted
const t = { roster_r2_key: ROSTER_KEY, roster_at: 5, settings: '{}' };

// a few microtask turns per request, more for some, so reads finish out
// of order (deterministically)
const turns = async (n) => { for (let k = 0; k < n; k++) await null; };
function standIn({ rosterFails = false } = {}) {
  return async (path) => {
    const q = path.indexOf('?');
    const query = new URLSearchParams(path.slice(q + 1));
    if (path.startsWith('/a/x/games?')) {
      const ids = query.get('ids').split(',').map(Number);
      await turns(3);
      if (ids.includes(files[150].id)) throw new Error('request failed (500)'); // a batch that fails
      // a copy of each game but some (and none of one that can't be read)
      const games = [];
      for (const id of ids.filter((x) => x % 7 !== 0)) {
        let v;
        try { v = store.get('t/1/up/' + id)(); } catch (e) { continue; }
        if (v instanceof Response) continue;
        games.push({ id, qbj: id % 11 === 0 ? 'not an object' : v && v.qbj && typeof v.qbj === 'object' ? v.qbj : v });
      }
      return { games };
    }
    if (path.startsWith('/a/x/file?')) {
      const key = query.get('key');
      await turns((key.length * 7) % 5);
      if (key === ROSTER_KEY && rosterFails) throw new Error('request failed (500)');
      if (!store.has(key)) throw new Error('no such file');
      return store.get(key)();
    }
    throw new Error('not a route: ' + path);
  };
}
const gameFiles = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
const call = (extra = {}) => ({ a: '/a/x', t, buckets, files, ...extra });
const isRoster = (p) => p === '/a/x/file?key=' + encodeURIComponent(ROSTER_KEY);
const fileRead = (f) => '/a/x/file?key=' + encodeURIComponent(f.r2_key);
// the reads that fail are not kept, so a second call makes them again
const failing = [files[21], files[41]];

await test('stand-in: Compute stats, then again on its cache', async () => {
  const cand = await bothSides(() => standIn(), [
    call({ opts: (c) => ({ cache: c.get('s') || c.set('s', new Map()).get('s') }) }),
    call({ opts: (c) => ({ cache: c.get('s') }) }),
  ]);
  const [first, second] = cand.runs;
  assert.ok(isRoster(first.log[0]), 'the roster is read first');
  assert.equal(first.log.length, 1 + gameFiles.length, 'then each game file once');
  assert.ok(!first.log.some((p) => p.includes('/games?')), 'no /games without rank');
  assert.equal(cand.rec.fileMax, 6, 'six file reads at once');
  assert.deepEqual(first.progress.at(-1), [gameFiles.length, gameFiles.length]);
  assert.ok(isRoster(second.log[0]));
  assert.deepEqual(second.log.slice(1), failing.map(fileRead), 'a second call reads the roster and what failed, nothing else');
  const out = first.out;
  assert.ok(out.names && out.names.teams.get('Alpha') === 'Alpha Prime', 'renames from the roster');
  assert.ok(out.matches.some((m) => m.room === '') && out.matches.some((m) => m.room === 'Room C'), 'a deleted room and a live one');
  assert.ok(out.matches.some((m) => m.filename === BOOM.replace('.qbtd.json', '.qbj')), 'the game whose export throws still counts');
  assert.ok(out.errors.includes(BOOM + ': boom'), 'and its error is listed');
  assert.ok(!out.modaqFiles.some((x) => x.qbjName.includes('boom')));
  assert.ok(out.errors.some((e) => e.startsWith(files[21].filename + ': request failed (404)')), 'a read that fails');
  assert.ok(out.errors.some((e) => e.startsWith(files[41].filename + ': ')), 'text that is not JSON');
  assert.ok(out.errors.some((e) => e.startsWith(files[51].filename + ': ')), 'a file with no game in it');
  assert.ok(out.matches.some((m) => m.fileId === files[31].id), 'JSON served as a raw Response');
  assert.ok(out.modaqFiles.length > 0 && out.games.length === out.modaqFiles.length);
  assert.ok(out.matches.every((m, i) => i === 0 || m.fileId < out.matches[i - 1].fileId), 'upload order kept');
  // the QBJ bundle from it: every round, then rounds 2, 3 and 5 only
  const tz = { ...t, slug: 'stand-in' };
  const all = await bothZips(() => standIn(), { ...call({ t: tz }), got: out });
  const gameReads = files.filter((f) => f.kind === 'game').map(fileRead);
  assert.deepEqual(all.log, [...gameReads, '/a/x/file?key=' + encodeURIComponent(ROSTER_KEY)], 'each game file, then the roster');
  assert.equal(all.name, 'stand-in-qbj.zip');
  assert.ok(all.entries.at(-1).name === 'roster.qbj' && !zipText(all, 'roster.qbj').includes('_formerNames'));
  assert.ok(all.entries.some((e) => e.name.endsWith('_Game.json') && new TextDecoder().decode(e.data).includes('Alpha Prime')), 'game files renamed');
  const some = await bothZips(() => standIn(), { ...call({ t: tz }), got: out, keep: new Set([2, 3, 5]) });
  assert.ok(some.entries.every((e) => e.name === 'roster.qbj' || /^round-[235]\//.test(e.name)) && some.entries.length > 10);
  assert.deepEqual(some.log.slice(0, -1), files.filter((f) => f.kind === 'game' && [2, 3, 5].includes(f.round)).map(fileRead));
});

await test('stand-in: the playoff fill (rank), then again on its cache, then after a round move', async () => {
  const moved = files.map((f, i) => (i === 8 ? { ...f, round: f.round + 1 } : f));
  const cand = await bothSides(() => standIn(), [
    call({ opts: (c) => ({ cache: c.get('r') || c.set('r', new Map()).get('r'), rank: true }) }),
    call({ opts: (c) => ({ cache: c.get('r'), rank: true }) }),
    call({ files: moved, opts: (c) => ({ cache: c.get('r'), rank: true }) }),
  ]);
  const [first, second, third] = cand.runs;
  assert.ok(isRoster(first.log[0]), 'the roster is read first');
  const batches = first.log.filter((p) => p.includes('/games?'));
  assert.deepEqual(batches.map((p) => new URLSearchParams(p.split('?')[1]).get('ids').split(',').length), [100, 100, gameFiles.length - 200]);
  assert.deepEqual(first.log.slice(1, 4), batches, 'the batches come before any file read');
  assert.equal(cand.rec.gamesMax, 1, 'one batch at a time');
  assert.ok(first.log.length > 4 && cand.rec.fileMax === 6, 'what the copies miss is read, six at once');
  assert.ok(isRoster(second.log[0]));
  assert.deepEqual(second.log.slice(1), ['/a/x/games?ids=' + failing.map((f) => f.id).join(','), ...failing.map(fileRead)],
    'a second call reads the roster and what failed, nothing else');
  assert.deepEqual(third.log.slice(1), ['/a/x/games?ids=' + [files[8], ...failing].map((f) => f.id).join(','), ...failing.map(fileRead)],
    'a moved game is read again');
  assert.ok(first.out.modaqFiles.length < cand.runs[0].out.matches.length);
});

await test('stand-in: no options, no roster, and a roster that fails', async () => {
  await bothSides(() => standIn(), [call({ opts: null })]);
  const none = await bothSides(() => standIn(), [call({ t: { ...t, roster_r2_key: null } })]);
  assert.equal(none.runs[0].out.names, null);
  const failed = await bothSides(() => standIn({ rosterFails: true }), [call({})]);
  assert.equal(failed.runs[0].out.errors[0], 'Roster: request failed (500)');
});

await test('the QBJ bundle: re-uploads, a name taken twice, a folder in a name, reads that fail', async () => {
  // newest first, as the hub lists uploads
  const zstore = new Map();
  const zfiles = [];
  let zid = 500;
  const reader = (round, a, b, extra = {}) => () => ({ qbj: { ...match(round, a, b), ...extra }, game: { game: gameOf(a, b), uiState: {} },
    modaq: { qbj: JSON.stringify({ ...match(round, a, b), ...extra }, null, 4), game: JSON.stringify(gameOf(a, b), null, 2) }, protests: [] });
  const up = (kind, round, filename, value) => {
    const id = zid--;
    zstore.set('t/9/up/' + id, value);
    zfiles.push({ id, bucket_id: 1, round, kind, r2_key: 't/9/up/' + id, filename, size: 100, created: 1e12 + id, error: null, summary: null });
  };
  up('combined', 1, 'Round_1_Gamma_Beta.qbtd.json', reader(1, 'Gamma', 'Beta'));                 // re-exported, teams swapped
  up('qbj', 1, 'Round_1_Beta_Gamma.qbj', () => ({ ...match(1, 'Beta', 'Gamma'), notes: 'by hand, newer' })); // MODAQ's name, by hand
  up('combined', 1, 'Round_1_Beta_Gamma.qbtd.json', reader(1, 'Beta', 'Gamma'));
  up('game', 1, 'Round_1_Beta_Gamma_Game.json', () => gameOf('Beta', 'Gamma'));                   // MODAQ's game file name, by hand
  up('qbj', 1, 'Round_1_Beta_Gamma.qbj', () => ({ ...match(1, 'Beta', 'Gamma'), notes: 'by hand, older' }));
  up('combined', 2, 'Round_2_AB_Beta.qbtd.json', reader(2, 'A/B Club', 'Beta'));                 // a '/' in a team name
  up('game', 2, 'Round_2_A_B_Game.json', () => { throw new Error('request failed (404)'); });    // can't be read
  up('game', 3, 'Round_3_Gamma_Alpha_Game.json', () => gameOf('Gamma', 'Alpha'));                 // renamed
  up('game', 3, 'Round_3_bad_Game.json', () => new Response('{"not json', { headers: { 'Content-Type': 'application/octet-stream' } }));
  up('game', 3, 'Round_3_text_Game.json', () => new Response(JSON.stringify(gameOf('Beta', 'Alpha')), { headers: { 'Content-Type': 'application/octet-stream' } }));
  up('qbj', 3, 'Round_3_Gamma_Alpha.qbj', () => ({ ...match(3, 'Gamma', 'Alpha') }));
  up('combined', 4, 'Round_4_Beta_Alpha.qbtd.json', () => ({ qbj: match(4, 'Beta', 'Alpha'), game: null })); // no game half
  up('combined', 4, 'Round_4_Alpha_Beta.qbtd.json', () => ({ qbj: match(4), game: { game: gameOf('Alpha', 'Beta'), uiState: {} } })); // no MODAQ texts
  up('game', 5, 'Round_5_Alpha_Beta_Game.json', () => gameOf('Alpha', 'Beta'));
  up('other', 5, 'notes.txt', () => new Response('hello', { headers: { 'Content-Type': 'text/plain' } }));
  const zpub = ({ rosterFails = false } = {}) => async (path) => {
    const key = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('key');
    await turns(key.length % 3);
    if (key === ROSTER_KEY) { if (rosterFails) throw new Error('request failed (500)'); return structuredClone(rosterQbj); }
    if (!zstore.has(key)) throw new Error('no such file');
    return zstore.get(key)();
  };
  const tz = { roster_r2_key: ROSTER_KEY, roster_at: 1, settings: '{}', slug: 'zip-cases' };
  const c = { a: '/a/z', t: tz, buckets: [{ id: 1, room_name: 'Room A' }], files: zfiles };
  const got = await collectMatches(zpub(), c.a, tz, c.buckets, zfiles);
  const z = await bothZips(() => zpub(), { ...c, got });
  const names = z.entries.map((e) => e.name);
  assert.ok(names.includes('round-1/Round_1_Gamma_Beta.qbj') && names.includes('round-1/Round_1_Beta_Gamma.qbj'), 'both exports of the re-exported game');
  assert.equal(names.filter((n) => n === 'round-1/Round_1_Beta_Gamma.qbj').length, 1, 'one file under a name');
  assert.ok(!zipText(z, 'round-1/Round_1_Beta_Gamma.qbj').includes('by hand'), 'the reader\'s file beats the one added by hand');
  assert.equal(zipText(z, 'round-1/Round_1_Beta_Gamma_Game.json'), JSON.stringify(gameOf('Beta', 'Gamma'), null, 2), 'and its game file');
  assert.ok(names.includes('round-2/Round_2_A/B Club_Beta.qbj'), 'a \'/\' in a team name makes a folder');
  assert.ok(!names.some((n) => /Round_2_A_B_Game|Round_3_bad_Game/.test(n)), 'game files that can\'t be read are left out');
  assert.ok(zipText(z, 'round-3/Round_3_Gamma_Alpha_Game.json').includes('"Alpha Prime"'), 'a game file under the roster\'s names');
  assert.ok(names.includes('round-3/Round_3_text_Game.json') && names.includes('round-3/Round_3_Gamma_Alpha.qbj'));
  assert.ok(!names.includes('round-4/Round_4_Beta_Alpha_Game.json') && names.includes('round-4/Round_4_Alpha Prime_Beta_Game.json'),
    'no game half, no game file; an upload without MODAQ texts still gives both');
  assert.ok(!names.includes('notes.txt') && names.at(-1) === 'roster.qbj');
  assert.equal(z.log.length, 6 + 1, 'six game files, then the roster');
  // the rounds picked, without a roster, and with a roster that fails
  const picked = await bothZips(() => zpub(), { ...c, got, keep: new Set([1, 3]) });
  assert.ok(picked.entries.every((e) => e.name === 'roster.qbj' || /^round-[13]\//.test(e.name)));
  assert.equal(picked.log.length, 4 + 1, 'only the picked rounds\' game files are read');
  const none = await bothZips(() => zpub(), { ...c, t: { ...tz, roster_r2_key: null }, got });
  assert.ok(!none.entries.some((e) => e.name === 'roster.qbj') && none.log.length === 6);
  const failed = await bothZips(() => zpub({ rosterFails: true }), { ...c, got });
  assert.ok(!failed.entries.some((e) => e.name === 'roster.qbj') && failed.log.length === 7);
  // no renames: the game files as they were read, 2-space indented
  const plain = await bothZips(() => zpub(), { ...c, t: { ...tz, roster_r2_key: null }, got: { ...got, names: null } });
  assert.equal(zipText(plain, 'round-3/Round_3_Gamma_Alpha_Game.json'), JSON.stringify(gameOf('Gamma', 'Alpha'), null, 2));
});

/* ---------- the demo (demo.js) ---------- */

await test('demo: Compute stats and the playoff fill on the demo, with uploads', async () => {
  const ls = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (ls && ls.get && ls.configurable) Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
  const { demoPub, reset } = await import('../app/js/demo.js');
  const { default: fixture } = await import('../app/demo/fixture.js');
  reset();
  try {
    const sb = fixture.entries.find((e) => e.round === 4 && e.room === 'Room A').qbj;
    const live = { ...structuredClone(sb), _round: 7 };
    await demoPub('/b/demo/upload?round=7&name=Round_7_Stanford_Berkeley.qbtd.json', { method: 'POST', body: JSON.stringify({
      qbj: live, game: { game: { players: [], cycles: [] }, uiState: {} }, modaq: { qbj: JSON.stringify(live, null, 4), game: '{}' },
      protests: [], progress: { at: 20, of: 20 } }) });
    await demoPub('/b/demo/upload?round=7&name=broken.qbj', { method: 'POST', body: '{"x":1}' });
    const d = await demoPub('/a/demo');
    const c = { a: '/a/demo', t: d.tournament, buckets: d.buckets, files: d.files };
    const cand = await bothSides(() => demoPub, [
      { ...c, opts: (k) => ({ cache: k.get('s') || k.set('s', new Map()).get('s') }) },
      { ...c, opts: (k) => ({ cache: k.get('r') || k.set('r', new Map()).get('r'), rank: true }) },
      { ...c, opts: (k) => ({ cache: k.get('r'), rank: true }) },
    ]);
    const [stats, fill] = cand.runs;
    assert.ok(stats.out.matches.some((m) => m.fileId === 1000) && stats.out.matches.length === fixture.entries.length + 1);
    assert.ok(fill.log.some((p) => p.includes('/games?')), 'the fill asks for copies, which the demo has none of');
    const z = await bothZips(() => demoPub, { ...c, got: stats.out });
    assert.ok(z.entries.length > fixture.entries.length && z.entries.some((e) => e.name === 'roster.qbj'));
  } finally { reset(); }
});

/* ---------- the Worker (worker/worker.js in this process) ---------- */

await test('Worker: the same games, requests, D1 statements and R2 reads', async () => {
  const w = await workerHarness();
  const { quiet, measured, setRaw, sql } = w;
  const enc = encodeURIComponent;
  const T = (await quiet(() => w.call('/api/tournaments', { method: 'POST', json: { name: 'Hub Games', slug: 'hub-games' } }))).body;
  const A = '/a/' + T.admin_secret;
  const rooms = [];
  for (let k = 0; k < 3; k++) rooms.push((await quiet(() => w.call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } }))).body);
  const roster = JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'Hub Games', registrations: [
    { name: 'Alpha Prime', teams: [{ name: 'Alpha Prime', _formerNames: ['Alpha'], players: [{ name: 'Ann' }, { name: 'Al' }] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }, { name: 'Bea', _formerNames: ['Bee'] }] }] },
  ] }] });
  await quiet(() => w.call(A + '/roster?name=roster.qbj', { method: 'POST', body: roster }));
  for (let n = 1; n <= 4; n++) await quiet(() => w.call(`${A}/packet?round=${n}&name=P${n}.pdf`, { method: 'POST', body: 'PDF'.repeat(50) }));
  await quiet(() => w.call(A + '/start', { method: 'POST' }));
  await quiet(() => w.call(A, { method: 'POST', json: { published: true, current_round: 3 } }));
  const up = async (k, round, name, body) => (await quiet(() => w.call(`/b/${rooms[k].secret}/upload?round=${round}&name=${enc(name)}`, { method: 'POST', body }))).body;
  const reader = (round, extra = {}) => JSON.stringify({ qbj: match(round), game: { game: gameOf('Alpha', 'Beta'), uiState: {} },
    modaq: { qbj: JSON.stringify(match(round), null, 4), game: JSON.stringify(gameOf('Alpha', 'Beta'), null, 2) }, protests: [], ...extra });
  await up(0, 1, 'Round_1_Alpha_Beta.qbj', JSON.stringify(match(1), null, 2));
  const r1 = await up(1, 1, 'Round_1_Alpha_Beta.qbtd.json', reader(1));
  await up(1, 2, 'Round_2_Alpha_Beta.qbtd.json', JSON.stringify({ qbj: match(2), game: { game: gameOf('Alpha', 'Beta'), uiState: {} } }));
  await up(2, 2, 'Round_2_Beta_Alpha.qbtd.json', JSON.stringify({ qbj: match(2, 'Beta', 'Alpha'), game: null }));
  await up(0, 1, 'Round_1_Alpha_Beta_Game.json', JSON.stringify(gameOf('Alpha', 'Beta'), null, 2));
  await up(2, 1, 'broken.qbj', '{"x":1}');
  await up(2, 1, 'notes.txt', 'hello');
  await up(0, 3, 'Round_2_Alpha_Beta.qbj', JSON.stringify(match(2), null, 2));
  await up(1, 3, 'Round_3_Alpha_Beta.qbj', JSON.stringify({ version: '2.1.1', objects: [{ type: 'Match', ...match(3) }] }));
  const gone = await up(2, 3, 'Round_3_Beta_Alpha.qbtd.json', reader(3));
  await up(0, 1, 'Round_1_Alpha_Beta.qbtd.json', reader(1)); // a re-export: both are read
  await quiet(() => w.call(`${A}/files/${r1.id}`, { method: 'POST', json: { round: 2 } }));
  await quiet(() => w.call(`${A}/buckets/${rooms[2].id}`, { method: 'DELETE' }));
  // a stored upload whose bytes no longer read as JSON
  setRaw(sql('SELECT r2_key FROM files WHERE id = ?', gone.id)[0].r2_key, 'not json', {});
  const pubOf = async (path, opts = {}) => {
    const r = await w.call(path, opts);
    const ct = r.headers['content-type'] || '';
    const failed = (message) => Object.assign(new Error(message), { status: r.status });
    if (!ct.includes('application/json')) {
      if (r.status < 200 || r.status > 299) throw failed('request failed (' + r.status + ')');
      return new Response(r.bytes, { status: r.status, headers: r.headers });
    }
    const data = JSON.parse(r.text);
    if (r.status < 200 || r.status > 299) throw failed(data.error || 'request failed (' + r.status + ')');
    return data;
  };
  const d = (await quiet(() => w.call(A))).body;
  assert.ok(d.files.some((f) => !d.buckets.some((b) => b.id === f.bucket_id)), 'an upload from a deleted room');
  const c = { a: A, t: d.tournament, buckets: d.buckets, files: d.files };
  const metered = await bothSides(() => pubOf, [
    { ...c, opts: (k) => ({ cache: k.get('s') || k.set('s', new Map()).get('s') }) },
    { ...c, opts: (k) => ({ cache: k.get('r') || k.set('r', new Map()).get('r'), rank: true }) },
    { ...c, opts: (k) => ({ cache: k.get('r'), rank: true }) },
  ], measured);
  assert.ok(metered.ops[0].some((x) => x.startsWith('r2 get')) && metered.ops[1].some((x) => x.startsWith('d1')), 'the meter saw the reads');
  const cand = await bothSides(() => pubOf, [{ ...c, opts: () => ({}) }]);
  const out = cand.runs[0].out;
  assert.ok(out.matches.some((m) => m.teams.some((tm) => tm.name === 'Alpha Prime')), 'renamed');
  assert.ok(out.errors.some((e) => e.startsWith('Round_3_Beta_Alpha.qbtd.json: ')), 'the unreadable upload');
  assert.ok(out.modaqFiles.length >= 2);
  // the QBJ bundle, its reads metered
  const z = await bothZips(() => pubOf, { ...c, got: out }, measured);
  assert.ok(z.entries.some((e) => e.name === 'round-1/Round_1_Alpha_Beta_Game.json') && z.entries.at(-1).name === 'roster.qbj');
  assert.ok(!zipText(z, 'roster.qbj').includes('_formerNames') && zipText(z, 'round-1/Round_1_Alpha_Beta_Game.json').includes('Alpha Prime'));
  await bothZips(() => pubOf, { ...c, got: out, keep: new Set([2]) }, measured);
});

/* ---------- gameFormat and the hub's roster renames ---------- */

await test('gameFormat: as the reference, on every kind of settings', () => {
  const ref = hubRef({ pub: null });
  for (const settings of [undefined, null, '', 'not json', 'null', '{}', '{"gameFormat":"acf"}',
    JSON.stringify({ gameFormat: 'pace', formatOverrides: { regulationTossupCount: 24 } })]) {
    assert.deepEqual(gameFormat({ settings }), ref.gameFormat({ settings }));
  }
});

await test('createHubNames: the listings\' renames, loaded once per roster save', async () => {
  // admin.js@0cd19c5:283-298, with its fetch helper and module state
  const refNames = { key: null, map: null };
  const refEnsure = async (pub, a, tt) => {
    const key = tt.roster_r2_key ? tt.roster_r2_key + '@' + (tt.roster_at || '') : '';
    if (refNames.key === key) return;
    refNames.key = key;
    refNames.map = null;
    if (!key) return;
    try { refNames.map = rosterNameMap(parseRoster(await hubRef({ pub }).fetchOwnedJson(a, tt.roster_r2_key))); } catch (e) { /* listed as uploaded */ }
  };
  const refSummary = (f) => {
    const s = uploadedSummary(f);
    if (!s || !refNames.map) return s;
    return { ...s, teams: s.teams.map((n) => refNames.map.teams.get(n) || n) };
  };
  const h = createHubNames();
  const reads = { ref: 0, cand: 0 };
  const pubFor = (side) => async (p) => { reads[side]++; return standIn()(p); };
  const sums = [null, {}, { summary: 'not json' }, { summary: JSON.stringify({ teams: ['Alpha', 'Beta'], score: [10, 0] }) },
    { summary: { teams: ['Gamma', 'Alpha '], score: ['5', null], protests: [{ team: 'Alpha' }, 3], progress: { at: 3, of: 20 } } }];
  const steps = [
    ['first load', t], ['the same roster again', t], ['saved in another tab', { ...t, roster_at: 6 }],
    ['saved here (key cleared)', { ...t, roster_at: 6 }, true], ['no roster', { ...t, roster_r2_key: null }],
    ['a roster that fails', { ...t, roster_r2_key: 't/1/missing.qbj' }],
    ['the same failed roster (not read again)', { ...t, roster_r2_key: 't/1/missing.qbj' }], ['back again', t],
  ];
  for (const [label, tt, clear] of steps) {
    if (clear) { h.key = null; refNames.key = null; }
    await refEnsure(pubFor('ref'), '/a/x', tt);
    await h.ensure(pubFor('cand'), '/a/x', tt);
    assert.equal(h.key, refNames.key, label + ': key');
    assert.deepEqual(h.map, refNames.map, label + ': map');
    assert.equal(reads.cand, reads.ref, label + ': roster reads');
    for (const f of sums) assert.equal(JSON.stringify(h.summary(f)), JSON.stringify(refSummary(f)), label + ': summary');
  }
  assert.equal(reads.cand, 5, 'read on the first load, each save, the failing roster, and back');
  assert.ok(await ownedJson(standIn(), '/a/x', ROSTER_KEY));
});

console.log(passed + ' hub game-loading checks passed' + (process.exitCode ? ' (with failures)' : ''));
