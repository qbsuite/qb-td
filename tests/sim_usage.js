// sim_usage.js — what a tournament day costs in Cloudflare's billing
// units, measured rather than estimated. Drives N tournaments through a
// compressed day against a locally running, METERED Worker:
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
//   node tests/sim_usage.js
//
// Simulated time moves in 30s steps (the Live Hub's refresh period); no
// real waiting. Each step, every tournament's TD has the Live Hub open and
// visible (the worst case: a TD who never switches tabs), rooms fetch
// packets at the start of each round and upload their game somewhere in
// its second half, and the cron runs once per simulated minute. Every
// request is metered on its own (GET /__meter around it), so D1 rows are
// charged to the thing that caused them.
//
// CLIENT=legacy replays today's Live Hub: detail + tiebreakers every 30s.
// CLIENT=smart sends the rev it holds (?rev=), skips the tiebreakers
// fetch when nothing moved, and backs off 30s -> 60s -> 120s while
// nothing changes. Against a Worker without rev support smart degrades to
// legacy's request pattern.
//
// Knobs: TOURNAMENTS (10), ROOMS (8), ROUNDS (7), ROUND_MIN (40),
// CLIENT (legacy), SCALE (60: the "N tournaments at once" row).

import { d1exec, d1row } from './e2e_lib.js';

const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';
const TOURNAMENTS = Number(process.env.TOURNAMENTS || 10);
const ROOMS = Number(process.env.ROOMS || 8);
const ROUNDS = Number(process.env.ROUNDS || 7);
const ROUND_MIN = Number(process.env.ROUND_MIN || 40);
const CLIENT = process.env.CLIENT || 'legacy';
const SCALE = Number(process.env.SCALE || 60);
const STEPS = ROUND_MIN * 2;            // 30s steps per round
const TEAMS = ROOMS * 2;

// Free-plan daily limits and Workers Paid monthly inclusions (Cloudflare
// pricing pages, 2026): what the extrapolated day is compared against.
const FREE_REQ_DAY = 100000;
const FREE_ROWS_READ_DAY = 5000000;
const FREE_ROWS_WRITTEN_DAY = 100000;

async function meter() {
  return (await fetch(BASE + '/__meter')).json();
}

// Categories the day's cost is split into.
const cost = {};
function charge(cat, before, after) {
  const c = cost[cat] || (cost[cat] = { requests: 0, rows_read: 0, rows_written: 0, samples: [] });
  c.requests++;
  const read = after.rows_read - before.rows_read;
  c.rows_read += read;
  c.rows_written += after.rows_written - before.rows_written;
  c.samples.push(read);
}

async function call(cat, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  const before = cat ? await meter() : null;
  const res = await fetch(BASE + p, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (cat) charge(cat, before, await meter());
  return { status: res.status, body };
}

async function tick() {
  const before = await meter();
  const res = await fetch(BASE + '/__scheduled');
  await res.text();
  if (!res.ok) throw new Error('cron trigger failed: run wrangler dev with --test-scheduled');
  charge('cron tick', before, await meter());
}

/* ---------- fixtures ---------- */

const teamName = (i) => 'Sim Team ' + String(i + 1).padStart(2, '0');

function pairings(round) {
  const idx = [...Array(TEAMS).keys()];
  const r = (round - 1) % (TEAMS - 1);
  const rot = [idx[0], ...idx.slice(1 + r), ...idx.slice(1, 1 + r)];
  const out = [];
  for (let i = 0; i < TEAMS / 2; i++) out.push([rot[i], rot[TEAMS - 1 - i]]);
  return out;
}

function matchFor(round, a, b) {
  const side = (t, pts) => ({
    team: { name: teamName(t) }, bonus_points: pts,
    match_players: [{ player: { name: teamName(t) + ' P1' }, tossups_heard: 20,
      answer_counts: [{ number: 3, answer: { value: 10 } }] }],
  });
  return JSON.stringify({ tossups_read: 20, _round: round, match_teams: [side(a, 30), side(b, 10)] });
}

async function setup(i) {
  const slug = 'sim-' + Math.random().toString(36).slice(2, 8) + '-' + i;
  let r = await call(null, '/api/tournaments', { method: 'POST', json: { name: 'Sim ' + i, slug } });
  if (r.status !== 200) throw new Error('create failed: ' + JSON.stringify(r.body));
  const A = '/a/' + r.body.admin_secret;
  const rooms = [];
  for (let k = 0; k < ROOMS; k++) {
    r = await call(null, A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } });
    rooms.push({ id: r.body.id, secret: r.body.secret, name: 'Room ' + (k + 1) });
  }
  await call(null, A + '/start', { method: 'POST' });
  const schedule = { v: 1, rooms: rooms.map((b) => ({ name: b.name, bucket: b.id })), phases: [{
    name: 'Prelims',
    rounds: Array.from({ length: ROUNDS }, (_, ri) => ({
      round: ri + 1,
      games: pairings(ri + 1).map(([a, b], room) => ({ room, a: { team: teamName(a) }, b: { team: teamName(b) } })),
      byes: [],
    })),
  }], updated: 0 };
  await call(null, A + '/schedule', { method: 'POST', json: schedule });
  await call(null, A, { method: 'POST', json: { published: true, current_round: 1 } });
  for (let n = 1; n <= ROUNDS; n++) {
    await call(null, A + '/packet?round=' + n + '&name=Packet' + n + '.pdf', { method: 'POST', body: 'PDF'.repeat(200) });
  }
  // what the Live Hub holds: the rev of its last full detail, and when
  // its next refresh is due
  return { A, rooms, rev: null, interval: 30, due: 0, quiet: 0 };
}

// One Live Hub refresh, the way admin.js liveRefresh does it.
async function refresh(t, now) {
  if (CLIENT === 'smart' && t.rev !== null) {
    const r = await call('hub refresh', t.A + '?rev=' + t.rev);
    if (r.body && r.body.unchanged) {
      // nothing moved: back off, 30s -> 60s -> 120s
      t.quiet++;
      t.interval = t.quiet >= 4 ? 120 : t.quiet >= 2 ? 60 : 30;
      t.due = now + t.interval;
      return;
    }
    t.rev = r.body.tournament ? r.body.tournament.rev ?? null : null;
  } else {
    const r = await call('hub refresh', t.A);
    t.rev = r.body.tournament ? r.body.tournament.rev ?? null : null;
  }
  await call('hub tiebreakers', t.A + '/tiebreakers');
  t.quiet = 0;
  t.interval = 30;
  t.due = now + t.interval;
}

/* ---------- run ---------- */

console.log(`sim: ${TOURNAMENTS} tournaments x ${ROOMS} rooms x ${ROUNDS} rounds of ${ROUND_MIN} min, client=${CLIENT}`);
// creation is capped per IP per day; earlier runs must not use it up
d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const ts = [];
for (let i = 0; i < TOURNAMENTS; i++) ts.push(await setup(i));
const inDb = d1row('SELECT COUNT(*) AS n FROM tournaments').n;
console.log(`set up; ${inDb} tournaments now in the local database\n`);

// cron cost with nothing to do, before the day starts: drain the queue
// setup just filled (a tick rebuilds at most 4 tournaments), then price one
for (let i = 0; i < Math.ceil(TOURNAMENTS / 4) + 2; i++) await tick();
const idleTick = cost['cron tick'].samples.at(-1);
delete cost['cron tick'];

let seconds = 0;
for (let round = 1; round <= ROUNDS; round++) {
  // each room's upload lands at a random step in the round's second half
  const finish = ts.map((t) => t.rooms.map(() => Math.floor(STEPS / 2 + Math.random() * (STEPS / 2))));
  for (const t of ts) {
    await call(null, t.A, { method: 'POST', json: { current_round: round } });
    for (const b of t.rooms) await call('room packet fetch', '/b/' + b.secret + '/packet?round=' + round);
  }
  for (let s = 0; s < STEPS; s++) {
    for (const [ti, t] of ts.entries()) {
      const games = pairings(round);
      for (const [k, b] of t.rooms.entries()) {
        if (finish[ti][k] !== s) continue;
        const [a, bb] = games[k];
        await call('room upload', '/b/' + b.secret + '/upload?round=' + round + '&name=R' + round + '_' + k + '.qbj',
          { method: 'POST', body: matchFor(round, a, bb) });
      }
      if (t.due <= seconds) await refresh(t, seconds);
    }
    if (s % 2 === 1) await tick();
    seconds += 30;
  }
  const hub = cost['hub refresh'];
  process.stdout.write(`round ${round}: hub refreshes so far ${hub.requests}, last full refresh read ${hub.samples.filter((x) => x > 10).at(-1) ?? hub.samples.at(-1)} rows\n`);
}

/* ---------- report ---------- */

const hours = seconds / 3600;
console.log(`\n=== one simulated day: ${hours.toFixed(1)}h, ${TOURNAMENTS} tournaments, client=${CLIENT} ===`);
const rows = Object.entries(cost).map(([cat, c]) => ({
  what: cat,
  requests: c.requests,
  rows_read: c.rows_read,
  rows_written: c.rows_written,
  'rows/request': +(c.rows_read / c.requests).toFixed(1),
  'max rows/request': Math.max(...c.samples),
}));
console.table(rows);
const tot = (k) => rows.reduce((n, r) => n + r[k], 0);
// cron rows during the day are rebuild work, which grows with tournaments;
// cron requests don't (one tick a minute for the whole account)
const perT = { requests: (tot('requests') - (cost['cron tick'] ? cost['cron tick'].requests : 0)) / TOURNAMENTS, rows_read: tot('rows_read') / TOURNAMENTS,
  rows_written: tot('rows_written') / TOURNAMENTS };
// the cron runs once a minute for the whole account, not per tournament
const cronPerDay = cost['cron tick'] ? { requests: 1440, rows_read: 1440 * idleTick } : { requests: 0, rows_read: 0 };

console.log(`\nidle cron tick (nothing dirty) read ${idleTick} rows with ${inDb} tournaments in the database` +
  ` -> ${(1440 * idleTick).toLocaleString()} rows/day before anyone plays`);
console.log(`per tournament-day: ${Math.round(perT.requests).toLocaleString()} requests, ` +
  `${Math.round(perT.rows_read).toLocaleString()} rows read, ${Math.round(perT.rows_written).toLocaleString()} rows written`);

for (const n of [TOURNAMENTS, SCALE]) {
  const req = n * perT.requests + cronPerDay.requests;
  const rr = n * perT.rows_read + cronPerDay.rows_read;
  const rw = n * perT.rows_written;
  const pct = (a, b) => (100 * a / b).toFixed(0) + '% of free';
  console.log(`${n} tournaments at once, one ${hours.toFixed(1)}h day: ` +
    `${Math.round(req).toLocaleString()} requests (${pct(req, FREE_REQ_DAY)}), ` +
    `${Math.round(rr).toLocaleString()} rows read (${pct(rr, FREE_ROWS_READ_DAY)}), ` +
    `${Math.round(rw).toLocaleString()} rows written (${pct(rw, FREE_ROWS_WRITTEN_DAY)})`);
}
