// stress_worker.js — drives a full-size tournament through a locally
// running Worker to find where the design bends. Same setup as
// e2e_worker.js:
//   cd worker && npx wrangler dev --local --port 8799   (schema applied)
//   node tests/stress_worker.js
//
// Default shape is the hardest single event qb-td could plausibly be
// asked to run: 72 teams, 36 rooms, 17 rounds -> 612 games. Override
// with TEAMS / ROOMS / ROUNDS env vars.
//
// Payloads are real: every upload is a match qbj lifted from the
// committed archive capture (app/archive/ug-nats-stanford.js, ~13KB a
// game) with the names swapped, so bundle growth and request sizes match
// what a real day produces rather than a toy fixture.

import archive from '../app/archive/ug-nats-stanford.js';

const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';
const TEAMS = Number(process.env.TEAMS || 72);
const ROOMS = Number(process.env.ROOMS || Math.floor(TEAMS / 2));
const ROUNDS = Number(process.env.ROUNDS || 17);
// How many of a round's rooms upload at once. Rooms really do finish
// together (the round ends when the last question is read), so the
// default is "all of them"; lower it to find the concurrency a single
// tournament can actually absorb.
const CONC = Number(process.env.CONC || ROOMS);
const TIMEOUT = Number(process.env.TIMEOUT || 60000);
const PLAYERS = 5;

const ms = (t) => Math.round(t);
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const kb = (n) => (n / 1024).toFixed(1) + 'KB';

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  const t0 = performance.now();
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(BASE + p, { ...opts, headers, signal: AbortSignal.timeout(TIMEOUT) });
      break;
    } catch (e) {
      // A timeout is a result, not a transport hiccup: report it instead
      // of retrying into an already-wedged Worker.
      if (e.name === 'TimeoutError') {
        return { status: 0, body: { error: 'timeout after ' + TIMEOUT + 'ms' }, bytes: 0, took: performance.now() - t0 };
      }
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const took = performance.now() - t0;
  const ct = res.headers.get('content-type') || '';
  let body = buf.toString('utf8');
  if (ct.includes('json')) { try { body = JSON.parse(body); } catch (e) { /* keep text */ } }
  return { status: res.status, body, bytes: buf.length, took };
}

/* ---------- fixtures ---------- */

const teamName = (i) => 'Stress University ' + String(i + 1).padStart(2, '0');
const playerName = (t, p) => 'Player ' + (t + 1) + '-' + (p + 1);

// One real match qbj from the archive, retargeted onto two teams. Keeps
// the buzz-level detail (match_questions) that makes a game ~13KB.
const sample = (() => {
  const bundle = archive[Object.keys(archive).find((k) => k.endsWith('/bundle'))];
  const sized = bundle.entries.map((e) => ({ e, n: JSON.stringify(e.qbj).length }))
    .sort((a, b) => a.n - b.n);
  return sized[Math.floor(sized.length / 2)].e.qbj;
})();
const sampleTeamB = (sample.match_teams[1].team || {}).name;

function matchFor(round, a, b) {
  const m = JSON.parse(JSON.stringify(sample));
  const names = [a, b];
  (m.match_teams || []).forEach((mt, i) => {
    const ti = names[i];
    if (mt.team) mt.team.name = teamName(ti);
    (mt.match_players || []).forEach((mp, j) => {
      if (mp.player) mp.player.name = playerName(ti, j % PLAYERS);
    });
    (mt.lineups || []).forEach((l) => {
      (l.players || []).forEach((p, j) => { p.name = playerName(ti, j % PLAYERS); });
    });
  });
  (m.match_questions || []).forEach((q) => {
    (q.buzzes || []).forEach((bz) => {
      const side = bz.team && bz.team.name === sampleTeamB ? 1 : 0;
      if (bz.team) bz.team.name = teamName(names[side]);
      if (bz.player) bz.player.name = playerName(names[side], 0);
    });
  });
  m._round = round;
  return JSON.stringify(m);
}

// Circle-method pairings: every team plays every round (36 games, no
// byes) — the densest a field of this size gets.
function pairings(round) {
  const n = TEAMS;
  const idx = [...Array(n).keys()];
  const r = (round - 1) % (n - 1);
  const rot = [idx[0], ...idx.slice(1 + r), ...idx.slice(1, 1 + r)];
  const out = [];
  for (let i = 0; i < n / 2; i++) out.push([rot[i], rot[n - 1 - i]]);
  return out.slice(0, ROOMS);
}

/* ---------- run ---------- */

function step(name, extra) { console.log(name, extra ? JSON.stringify(extra) : ''); }

// Run the cron by hand (wrangler dev --test-scheduled).
async function tick() {
  const t0 = performance.now();
  const res = await fetch(BASE + '/__scheduled');
  await res.text();
  if (!res.ok) throw new Error('cron trigger failed (' + res.status + '): use --test-scheduled');
  return ms(performance.now() - t0);
}

// What the stats tab costs a viewer, measured the way the page fetches
// it. Sharded: one blob per round, and only the rounds whose stamp moved
// are refetched. Pre-shard: the one whole-tournament bundle, every time
// anything moves. Same harness drives both so the numbers compare.
const held = new Map(); // round -> stamp already "downloaded"
async function readStats(state) {
  let movedBytes = 0;
  let totalBytes = 0;
  let entries = 0;
  if (state.rounds) {
    const all = Object.keys(state.rounds);
    const moved = all.filter((n) => held.get(n) !== state.rounds[n]);
    const full = await call('/pub/' + slug + '/rounds?n=' + all.join(','));
    totalBytes = full.bytes;
    entries = ((full.body.rounds) || []).reduce((n, r) => n + (r.entries || []).length, 0);
    if (moved.length) {
      const since = await call('/pub/' + slug + '/rounds?n=' + moved.join(','));
      movedBytes = since.bytes;
      for (const n of moved) held.set(n, state.rounds[n]);
    }
  } else {
    const bundle = await call('/pub/' + slug + '/bundle');
    const body = typeof bundle.body === 'string' ? JSON.parse(bundle.body) : bundle.body;
    totalBytes = bundle.bytes;
    movedBytes = bundle.bytes;
    entries = body && Array.isArray(body.entries) ? body.entries.length : -1;
  }
  return { movedBytes, totalBytes, entries };
}

// Run fn over items with at most n in flight, results in input order.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

console.log('stress: ' + TEAMS + ' teams / ' + ROOMS + ' rooms / ' + ROUNDS + ' rounds = ' + ROOMS * ROUNDS + ' games');
console.log('sample game qbj: ' + kb(Buffer.byteLength(matchFor(1, 0, 1))) + '\n');

const slug = 'stress-' + Math.random().toString(36).slice(2, 8);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'Stress Open', slug } });
if (r.status !== 200) { console.error('create failed', r.status, r.body); process.exit(1); }
const A = '/a/' + r.body.admin_secret;
const tid = r.body.id;
step('create tournament', { slug, tid, ms: ms(r.took) });

const roster = { objects: [{ type: 'Tournament', registrations: Array.from({ length: TEAMS }, (_, i) => ({
  name: teamName(i),
  teams: [{ name: teamName(i), players: Array.from({ length: PLAYERS }, (_, p) => ({ name: playerName(i, p) })) }],
})) }] };
r = await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(roster) });
step('upload roster', { status: r.status, bytes: kb(JSON.stringify(roster).length), ms: ms(r.took) });

const rooms = [];
const roomTimes = [];
for (let i = 0; i < ROOMS; i++) {
  r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (i + 1) } });
  if (r.status !== 200) { step('bucket create FAILED', { i, status: r.status, body: r.body }); break; }
  roomTimes.push(r.took);
  rooms.push({ id: r.body.id, secret: r.body.secret, name: 'Room ' + (i + 1) });
}
step('create rooms', { made: rooms.length, wanted: ROOMS, p50: ms(pct(roomTimes, 0.5)), max: ms(Math.max(...roomTimes)) });

const schedule = { v: 1, rooms: rooms.map((b) => ({ name: b.name, bucket: b.id })), phases: [{
  name: 'Prelims',
  rounds: Array.from({ length: ROUNDS }, (_, ri) => ({
    round: ri + 1,
    games: pairings(ri + 1).map(([a, b], room) => ({ room, a: { team: teamName(a) }, b: { team: teamName(b) } })),
    byes: [],
  })),
}], updated: 0 };
const schedBytes = Buffer.byteLength(JSON.stringify(schedule));
r = await call(A + '/schedule', { method: 'POST', json: schedule });
step('save schedule', { status: r.status, bytes: kb(schedBytes), capKB: 256, ms: ms(r.took) });

r = await call(A, { method: 'POST', json: { published: true, current_round: 1 } });
step('publish', { status: r.status });

for (let n = 1; n <= ROUNDS; n++) {
  await call(A + '/packet?round=' + n + '&name=Packet' + n + '.pdf', { method: 'POST', body: 'PDF'.repeat(1000) });
}
step('upload packets', { rounds: ROUNDS });

const rows = [];
let uploadFail = 0;
for (let round = 1; round <= ROUNDS; round++) {
  await call(A, { method: 'POST', json: { current_round: round } });
  const games = pairings(round);
  const t0 = performance.now();
  const results = await pool(games, CONC, ([a, b], i) => {
    const room = rooms[i % rooms.length];
    const name = 'Round_' + round + '_' + a + '_' + b + '.qbj';
    return call('/b/' + room.secret + '/upload?round=' + round + '&name=' + name,
      { method: 'POST', body: matchFor(round, a, b) });
  });
  const wall = performance.now() - t0;
  const times = results.map((x) => x.took);
  const bad = results.filter((x) => x.status !== 200 || (x.body && x.body.error));
  uploadFail += bad.length;

  // The cron is what turns uploaded games into what the public page
  // reads (a no-op on the pre-shard Worker, which built its bundle
  // inline), so time it as part of the round.
  const tickMs = await tick();
  const pub = await call('/pub/' + slug);
  const stats = await readStats(pub.body);
  const admin = await call(A);
  const expect = round * games.length;

  const row = {
    round,
    games: expect,
    upWall: ms(wall),
    upP50: ms(pct(times, 0.5)),
    upP95: ms(pct(times, 0.95)),
    upMax: ms(Math.max(...times)),
    upFail: bad.length,
    tickMs,
    pubMs: ms(pub.took),
    pubKB: +(pub.bytes / 1024).toFixed(1),
    // what a viewer who was already up to date pulls to see this round...
    refreshKB: +(stats.movedBytes / 1024).toFixed(1),
    // ...and what someone opening the page for the first time pulls
    fullMB: +(stats.totalBytes / 1024 / 1024).toFixed(2),
    entries: stats.entries,
    lost: expect - stats.entries,
    adminMs: ms(admin.took),
    adminKB: +(admin.bytes / 1024).toFixed(1),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (bad.length) console.log('   upload errors:', JSON.stringify(bad.slice(0, 3).map((x) => [x.status, x.body])));
}

// The TO side of a finished day: "Compute stats", the qbj zip download
// and the rebuild button all run collectMatches (app/js/admin.js), which
// fetches every game file one at a time through /a/:secret/file. Time
// that loop — it is the dashboard's cost, and it is serial.
{
  const admin = await call(A);
  const qbjFiles = admin.body.files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
  const t0 = performance.now();
  const times = [];
  let bytes = 0;
  for (const f of qbjFiles) {
    const one = await call(A + '/file?key=' + encodeURIComponent(f.r2_key));
    times.push(one.took);
    bytes += one.bytes;
  }
  const wall = performance.now() - t0;
  step('TO collectMatches (serial per-file fetch)', {
    files: qbjFiles.length,
    wallSec: +(wall / 1000).toFixed(1),
    perFileP50: ms(pct(times, 0.5)),
    perFileP95: ms(pct(times, 0.95)),
    totalMB: +(bytes / 1024 / 1024).toFixed(2),
  });
}

console.log('\n=== summary ===');
console.table(rows);
const last = rows[rows.length - 1];
const first = rows[0];
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
console.log('\ngames ' + last.games + ', games missing from public stats: ' + last.lost +
  ', upload failures: ' + uploadFail);
console.log('upload p50 ' + first.upP50 + 'ms -> ' + last.upP50 + 'ms, max ' +
  first.upMax + 'ms -> ' + last.upMax + 'ms; round wall ' + first.upWall + 'ms -> ' + last.upWall + 'ms');
console.log('cron tick ' + first.tickMs + 'ms -> ' + last.tickMs + 'ms');
console.log('viewer refresh after a round: ' + first.refreshKB + 'KB -> ' + last.refreshKB +
  'KB; whole-tournament load ' + last.fullMB + 'MB; a viewer refreshing every round pulls ' +
  (sum('refreshKB') / 1024).toFixed(1) + 'MB across the day');
console.log('/pub/:slug ' + first.pubMs + 'ms -> ' + last.pubMs + 'ms (' + first.pubKB + 'KB -> ' +
  last.pubKB + 'KB), admin ' + first.adminMs + 'ms -> ' + last.adminMs + 'ms (' +
  first.adminKB + 'KB -> ' + last.adminKB + 'KB)');
