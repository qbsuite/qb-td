// sim_day.js — one whole tournament day, played against a locally running
// METERED Worker, with every request priced in Cloudflare's billing units.
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
//   SHAPE=mid node tests/sim_day.js
//
// Who does what (the behaviour model was given by the project owner,
// 9/28/2026 — change it here, not by guessing):
// - Moderators run rooms on laptops. Each room plays one game per round:
//   at the round's start the reader loads the bare room link (state,
//   schedule, roster, packet, tiebreakers), presses Start, refreshes the
//   tiebreaker pool, and uploads the game somewhere in the round's second
//   half. That is read_main.js's own request list.
// - The TD keeps the Live Hub open on a laptop all day (two laptops on a
//   large event), refreshing the way admin.js does: rev check, 30s backing
//   off to 120s while nothing moves. The TD sets each round.
// - Viewers: SHAPE's count, half on phones, half on laptops. 90% check
//   once per round (a random moment in its second half, plus a first look
//   at the start of the day). 10% are refreshers: every 1-2 minutes
//   through the last 20 minutes of each round, and once at its start.
//   A public page load is GET /pub/:slug; its blobs come from the GitHub
//   snapshot in production (September 2026: 120 Worker fallbacks all
//   month), so they cost the Worker nothing and aren't simulated.
// - The cron runs once a simulated minute.
//
// Simulated time moves in 30s steps with no real waiting. Every request is
// metered on its own (GET /__meter around it), so D1 rows and R2
// operations are charged to the request that caused them.
//
// Freshness: after every cron tick the first room's latest upload is
// looked for on the public state, unmetered: how many minutes until the
// game is listed (files) and until its stats shard moves (rounds).
//
// PUSH (modelled, not run): the same viewer events priced as if a Durable
// Object per tournament pushed each rebuilt state to connected viewers.
// A connection costs 1 Worker + 1 DO request; laptops stay connected
// (plus RECONNECT_PER_HOUR drops); a phone that wakes to check reconnects;
// pushes cost 1 DO request per rebuild. See the report at the end.
//
// LIVE=1 (modelled): the page reads its state from qb-td-live (worker.js
// "public state on qb-td-live"), so a viewer's load is a free static-asset
// request, not a Worker one — they're counted, not sent. What the Worker
// pays instead: one LivePublish invocation per tick that rebuilt the
// tournament, plus a heartbeat deploy whenever ten minutes pass without
// one (the tournament is active all day).
//
// Knobs: SHAPE (small|mid|large), ROUND_MIN (40), PHONE_SHARE (0.5),
// REFRESHER_SHARE (0.1), RECONNECT_PER_HOUR (0.5, laptop viewers, PUSH),
// LIVE (0).

import { d1exec, d1row } from './e2e_lib.js';

const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';
const SHAPES = {
  small: { rooms: 4, rounds: 6, viewers: 40, hubs: 1 },
  mid: { rooms: 8, rounds: 8, viewers: 150, hubs: 1 },
  large: { rooms: 16, rounds: 11, viewers: 400, hubs: 2 },
};
const SHAPE = process.env.SHAPE || 'mid';
const { rooms: ROOMS, rounds: ROUNDS, viewers: VIEWERS, hubs: HUBS } = SHAPES[SHAPE];
const ROUND_MIN = Number(process.env.ROUND_MIN || 40);
const PHONE_SHARE = Number(process.env.PHONE_SHARE ?? 0.5);
const REFRESHER_SHARE = Number(process.env.REFRESHER_SHARE ?? 0.1);
const RECONNECT_PER_HOUR = Number(process.env.RECONNECT_PER_HOUR ?? 0.5);
const LIVE = process.env.LIVE === '1';
const LIVE_HEARTBEAT_S = 600;
const STEP = 30;                        // seconds per step
const STEPS = (ROUND_MIN * 60) / STEP;  // steps per round
const TEAMS = ROOMS * 2;

// deterministic randomness, so two builds see the same day
let seed = Number(process.env.SEED || 42);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/* ---------- metering ---------- */

const meter = async () => (await fetch(BASE + '/__meter')).json();
const UNITS = ['rows_read', 'rows_written', 'r2_class_a', 'r2_class_b'];
const cost = {};
function charge(cat, before, after) {
  const c = cost[cat] || (cost[cat] = { requests: 0, samples: [], ...Object.fromEntries(UNITS.map((u) => [u, 0])) });
  c.requests++;
  for (const u of UNITS) c[u] += (after[u] || 0) - (before[u] || 0);
  c.samples.push((after.rows_read || 0) - (before.rows_read || 0));
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

const teamName = (i) => 'Day Team ' + String(i + 1).padStart(2, '0');
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
    match_players: [0, 1, 2, 3].map((p) => ({ player: { name: teamName(t) + ' P' + p }, tossups_heard: 20,
      answer_counts: [{ number: 2, answer: { value: 10 } }, { number: 1, answer: { value: 15 } }] })),
  });
  return JSON.stringify({ tossups_read: 20, _round: round, match_teams: [side(a, 60), side(b, 30)] });
}

/* ---------- setup ---------- */

console.log(`sim_day: ${SHAPE} — ${ROOMS} rooms x ${ROUNDS} rounds of ${ROUND_MIN} min, ` +
  `${VIEWERS} viewers (${PHONE_SHARE * 100}% phones, ${REFRESHER_SHARE * 100}% refreshers), ${HUBS} Live Hub laptop(s)`);
d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slug = 'day-' + SHAPE + '-' + Math.random().toString(36).slice(2, 7);
let r = await call(null, '/api/tournaments', { method: 'POST', json: { name: 'Day ' + SHAPE, slug } });
if (r.status !== 200) throw new Error('create failed: ' + JSON.stringify(r.body));
const A = '/a/' + r.body.admin_secret;
const rooms = [];
for (let k = 0; k < ROOMS; k++) {
  r = await call(null, A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } });
  rooms.push({ id: r.body.id, secret: r.body.secret, name: 'Room ' + (k + 1) });
}
await call(null, A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify({ objects: [{ type: 'Tournament',
  registrations: Array.from({ length: TEAMS }, (_, i) => ({ name: teamName(i),
    teams: [{ name: teamName(i), players: [0, 1, 2, 3].map((p) => ({ name: teamName(i) + ' P' + p })) }] })) }] }) });
await call(null, A + '/schedule', { method: 'POST', json: { v: 1, rooms: rooms.map((b) => ({ name: b.name, bucket: b.id })),
  phases: [{ name: 'Prelims', rounds: Array.from({ length: ROUNDS }, (_, ri) => ({ round: ri + 1,
    games: pairings(ri + 1).map(([a, b], room) => ({ room, a: { team: teamName(a) }, b: { team: teamName(b) } })), byes: [] })) }],
  updated: 0 } });
for (let n = 1; n <= ROUNDS; n++) {
  await call(null, A + '/packet?round=' + n + '&name=Packet' + n + '.pdf', { method: 'POST', body: 'PDF'.repeat(500) });
}
await call(null, A + '/start', { method: 'POST' });
await call(null, A, { method: 'POST', json: { published: true, current_round: 1 } });
for (let i = 0; i < 4; i++) await tick(); // drain setup's dirt
delete cost['cron tick'];

const hubs = Array.from({ length: HUBS }, () => ({ rev: null, quiet: 0, due: 0 }));
async function hubRefresh(h, now) {
  if (h.rev !== null) {
    const x = await call('TD Live Hub check', A + '?rev=' + h.rev);
    if (x.body && x.body.unchanged) {
      h.quiet++;
      h.due = now + (h.quiet >= 4 ? 120 : h.quiet >= 2 ? 60 : 30);
      return;
    }
    h.rev = x.body.tournament.rev;
  } else {
    h.rev = (await call('TD Live Hub check', A)).body.tournament.rev;
  }
  await call('TD Live Hub tiebreakers', A + '/tiebreakers');
  h.quiet = 0;
  h.due = now + 30;
}

// viewers: device and kind fixed for the day
const viewers = Array.from({ length: VIEWERS }, () => ({
  phone: rand() < PHONE_SHARE,
  refresher: rand() < REFRESHER_SHARE,
}));
const pushLog = { connects: 0, laptopConnects: 0, phoneConnects: 0 };
const liveLog = { loads: 0, deploys: 0, heartbeats: 0, lastDeploy: 0 };
const viewerLoad = (v) => {
  if (LIVE) { liveLog.loads++; return null; }
  return call(`viewer page load (${v.refresher ? 'refresher' : 'once per round'})`, '/pub/' + slug, { headers: { 'Cache-Control': 'no-cache' } });
};

/* ---------- the day ---------- */

let now = 0;
const fresh = []; // minutes from upload to listed / to stats
let watch = null; // { at, file, listed, stats }
let rebuilds = 0; // state changes a push design would send

// first look at the start of the day: everyone once
for (const v of viewers) {
  await viewerLoad(v);
  pushLog.connects++; v.phone ? pushLog.phoneConnects++ : pushLog.laptopConnects++;
}

for (let round = 1; round <= ROUNDS; round++) {
  if (round > 1) await call('TD sets the round', A, { method: 'POST', json: { current_round: round } });
  const games = pairings(round);
  const startAt = rooms.map(() => Math.floor(rand() * 3));
  const uploadAt = rooms.map(() => Math.floor(STEPS / 2 + rand() * (STEPS / 2 - 1)));
  // once-per-round viewers pick a moment in the second half
  const checkAt = viewers.map(() => Math.floor(STEPS / 2 + rand() * (STEPS / 2)));
  const nextRefresh = viewers.map(() => 0);
  const lateFrom = STEPS - (20 * 60) / STEP;

  for (let s = 0; s < STEPS; s++) {
    for (const [k, b] of rooms.entries()) {
      const S = '/b/' + b.secret;
      if (startAt[k] === s) {
        await call('moderator: room state', S);
        await call('moderator: schedule', S + '/schedule');
        await call('moderator: roster', S + '/roster');
        await call('moderator: packet', S + '/packet?round=' + round + '&warm=1');
        await call('moderator: tiebreakers', S + '/tiebreakers');
        await call('moderator: start game', S + '/start?round=' + round, { method: 'POST' });
        await call('moderator: tiebreakers', S + '/tiebreakers');
      }
      if (uploadAt[k] === s) {
        const [a, bb] = games[k];
        const name = `R${round}_${k}.qbj`;
        if (k !== 0) {
          await call('moderator: upload game', S + '/upload?round=' + round + '&name=' + name,
            { method: 'POST', body: matchFor(round, a, bb) });
        } else {
          const st = (await call(null, '/pub/' + slug)).body;
          // stamp from before the upload; then look right away, since a
          // live-computed list shows the game before any tick
          watch = { at: now, file: name, listed: null, stats: null, round, stamp: (st.rounds || {})[round] ?? null };
          await call('moderator: upload game', S + '/upload?round=' + round + '&name=' + name,
            { method: 'POST', body: matchFor(round, a, bb) });
          const after = (await call(null, '/pub/' + slug)).body;
          if ((after.files || []).some((f) => f.filename === name)) watch.listed = 0;
          continue;
        }
      }
    }
    for (const h of hubs) if (h.due <= now) await hubRefresh(h, now);
    for (const [i, v] of viewers.entries()) {
      if (v.refresher) {
        const inLate = s >= lateFrom;
        if (s === 0 || (inLate && nextRefresh[i] <= now)) {
          await viewerLoad(v);
          if (inLate) nextRefresh[i] = now + 60 + Math.floor(rand() * 61);
          // PUSH: a laptop refresher just watches the open page; a phone
          // wakes and reconnects each time it checks
          if (v.phone) { pushLog.connects++; pushLog.phoneConnects++; }
        }
      } else if (checkAt[i] === s) {
        await viewerLoad(v);
        if (v.phone) { pushLog.connects++; pushLog.phoneConnects++; }
      }
    }
    now += STEP;
    if (s % 2 === 1) {
      const before = await meter();
      await tick();
      const after = await meter();
      if (after.rows_written > before.rows_written) rebuilds++;
      if (LIVE) {
        if (after.rebuild_invocations > before.rebuild_invocations) { liveLog.deploys++; liveLog.lastDeploy = now; }
        else if (now - liveLog.lastDeploy >= LIVE_HEARTBEAT_S) { liveLog.heartbeats++; liveLog.lastDeploy = now; }
      }
      if (watch) {
        const st = (await call(null, '/pub/' + slug)).body;
        const mins = (now - watch.at) / 60;
        if (watch.listed === null && (st.files || []).some((f) => f.filename === watch.file)) watch.listed = mins;
        if (watch.stats === null && st.rounds && st.rounds[watch.round] && st.rounds[watch.round] !== watch.stamp) watch.stats = mins;
        if (watch.listed !== null && watch.stats !== null) { fresh.push(watch); watch = null; }
      }
    }
  }
  process.stdout.write(`round ${round}/${ROUNDS} done\n`);
}
const hours = now / 3600;
const laptopViewers = viewers.filter((v) => !v.phone).length;
const drops = Math.round(laptopViewers * hours * RECONNECT_PER_HOUR);
pushLog.connects += drops;
pushLog.laptopConnects += drops;

/* ---------- report ---------- */

console.log(`\n=== ${SHAPE}: one ${hours.toFixed(1)}h day ===`);
const rows = Object.entries(cost).map(([cat, c]) => ({
  what: cat,
  requests: c.requests,
  'D1 rows read': c.rows_read,
  'D1 rows written': c.rows_written,
  'R2 class A': c.r2_class_a,
  'R2 class B': c.r2_class_b,
  'rows/request': +(c.rows_read / c.requests).toFixed(1),
  'max rows': Math.max(...c.samples),
}));
console.table(rows);
const sum = (k) => rows.reduce((n, x) => n + x[k], 0);
// the cron's requests are the account's, once a minute all day, not this
// tournament's; its rows during the day are this tournament's rebuilds
const totals = {
  requests: sum('requests') - (cost['cron tick'] ? cost['cron tick'].requests : 0),
  rows_read: sum('D1 rows read'), rows_written: sum('D1 rows written'),
  r2a: sum('R2 class A'), r2b: sum('R2 class B'),
};
const viewerRows = rows.filter((x) => x.what.startsWith('viewer'));
const viewerReq = viewerRows.reduce((n, x) => n + x.requests, 0);
console.log(`\ntournament total (excluding the account-wide cron requests): ${totals.requests} requests, ` +
  `${totals.rows_read} rows read, ${totals.rows_written} rows written, R2 ${totals.r2a} A / ${totals.r2b} B`);
console.log(`viewers: ${viewerReq} page loads = ${(100 * viewerReq / totals.requests).toFixed(0)}% of requests, ` +
  `${viewerRows.reduce((n, x) => n + x['D1 rows read'], 0)} rows = ` +
  `${(100 * viewerRows.reduce((n, x) => n + x['D1 rows read'], 0) / totals.rows_read).toFixed(0)}% of rows`);
if (fresh.length) {
  const avg = (k) => (fresh.reduce((n, f) => n + f[k], 0) / fresh.length).toFixed(1);
  const max = (k) => Math.max(...fresh.map((f) => f[k])).toFixed(1);
  console.log(`freshness (${fresh.length} uploads): listed on the public page after avg ${avg('listed')} / max ${max('listed')} min; ` +
    `in the stats after avg ${avg('stats')} / max ${max('stats')} min`);
}
if (LIVE) {
  const deployReq = liveLog.deploys + liveLog.heartbeats;
  console.log(`\nLIVE (modelled): ${liveLog.loads} viewer state loads served by qb-td-live (free, not Worker requests); ` +
    `${liveLog.deploys} deploys + ${liveLog.heartbeats} heartbeats = ${deployReq} LivePublish invocations. ` +
    `Worker requests for the tournament: ${totals.requests + deployReq}`);
}
console.log(`\nPUSH (modelled): viewer page loads ${viewerReq} -> ${pushLog.connects} connections ` +
  `(${pushLog.laptopConnects} laptop incl. ${drops} wifi drops, ${pushLog.phoneConnects} phone), ` +
  `each 1 Worker + 1 DO request; plus ~${rebuilds} DO requests for pushes`);
console.log(JSON.stringify({ shape: SHAPE, hours, totals, viewerReq, live: LIVE ? liveLog : null,
  perCategory: Object.fromEntries(Object.entries(cost).map(([k, c]) => [k, c.requests])), viewerRows: viewerRows.reduce((n, x) => n + x['D1 rows read'], 0),
  push: { ...pushLog, rebuilds }, fresh: fresh.map((f) => [f.listed, f.stats]) }));
