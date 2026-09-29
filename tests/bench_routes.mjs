// bench_routes.mjs — CPU per request, route by route, on a fully played
// tournament, against the local Worker under wrangler dev's CPU profiler.
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
//   SHAPE=large node tests/bench_routes.mjs
//
// A whole-day profile can't split CPU between routes (an await drops the
// handler from the sampled stack), so each route is run on its own, REPS
// times in a row, inside its own profile: every non-idle sample in that
// window belongs to that route.
//
// Samples are split by where the code lives:
//   worker.js   — qb-td's own code: counts in production
//   d1-api      — the D1 client library, which runs inside the Worker in
//                 production too: counts
//   builtins    — JSON, crypto, Response, fetch internals (no script URL).
//                 In production these count too, BUT locally this bucket
//                 also holds the simulated D1/R2 services, which in
//                 production run elsewhere and don't count. So "own + d1"
//                 is a floor and "all" a ceiling for the production figure.
// Absolute numbers are this machine's; production's own percentiles
// (Cloudflare analytics: p50 1.2 ms, p99 8.7 ms, p99.9 15.3 ms in
// September 2026) are the reference to scale against.

import { d1exec } from './e2e_lib.js';

const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';
const INSPECTOR = process.env.INSPECTOR || 'ws://127.0.0.1:9229/ws';
const REPS = Number(process.env.REPS || 100);
const SHAPES = { small: { rooms: 4, rounds: 6 }, mid: { rooms: 8, rounds: 8 }, large: { rooms: 16, rounds: 11 } };
const SHAPE = process.env.SHAPE || 'large';
const { rooms: ROOMS, rounds: ROUNDS } = SHAPES[SHAPE];
const TEAMS = ROOMS * 2;

/* ---------- inspector ---------- */
// wrangler's inspector proxy only accepts its DevTools origin, and answers
// some commands with an echo of the request: any message with our id
// completes the call
const ws = new WebSocket(INSPECTOR, { headers: { Origin: 'https://devtools.devprod.cloudflare.dev' } });
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('no inspector at ' + INSPECTOR)); });
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 50 });

async function profiled(fn) {
  await send('Profiler.start');
  await fn();
  const p = (await send('Profiler.stop')).result.profile;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const t = { own: 0, d1: 0, builtins: 0 };
  p.samples.forEach((id, i) => {
    const cf = byId.get(id).callFrame;
    if (cf.functionName === '(idle)') return;
    const dt = p.timeDeltas[i + 1] ?? 50;
    if ((cf.url || '').endsWith('worker.js')) t.own += dt;
    else if ((cf.url || '').includes('d1-api')) t.d1 += dt;
    else t.builtins += dt;
  });
  return t;
}

/* ---------- a played tournament ---------- */
const call = async (p, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; }
  const res = await fetch(BASE + p, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
};
const teamName = (i) => 'Bench Team ' + String(i + 1).padStart(2, '0');
function pairings(round) {
  const idx = [...Array(TEAMS).keys()];
  const r = (round - 1) % (TEAMS - 1);
  const rot = [idx[0], ...idx.slice(1 + r), ...idx.slice(1, 1 + r)];
  return Array.from({ length: TEAMS / 2 }, (_, i) => [rot[i], rot[TEAMS - 1 - i]]);
}
const matchFor = (round, a, b) => JSON.stringify({ tossups_read: 20, _round: round, match_teams: [a, b].map((t, s) => ({
  team: { name: teamName(t) }, bonus_points: 30 * (2 - s),
  match_players: [0, 1, 2, 3].map((p) => ({ player: { name: teamName(t) + ' P' + p }, tossups_heard: 20,
    answer_counts: [{ number: 2, answer: { value: 10 } }, { number: 1, answer: { value: 15 } }] })) })) });

console.log(`bench_routes: ${SHAPE} tournament (${ROOMS} rooms x ${ROUNDS} rounds = ${ROOMS * ROUNDS} games), ${REPS} reps per route`);
d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slug = 'bench-' + SHAPE + '-' + Math.random().toString(36).slice(2, 7);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'Bench ' + SHAPE, slug } });
const A = '/a/' + r.body.admin_secret;
const rooms = [];
for (let k = 0; k < ROOMS; k++) rooms.push((await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } })).body);
await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify({ objects: [{ type: 'Tournament',
  registrations: Array.from({ length: TEAMS }, (_, i) => ({ name: teamName(i), teams: [{ name: teamName(i), players: [0, 1, 2, 3].map((p) => ({ name: teamName(i) + ' P' + p })) }] })) }] }) });
await call(A + '/schedule', { method: 'POST', json: { v: 1, rooms: rooms.map((b, i) => ({ name: 'Room ' + (i + 1), bucket: b.id })),
  phases: [{ name: 'Prelims', rounds: Array.from({ length: ROUNDS }, (_, ri) => ({ round: ri + 1,
    games: pairings(ri + 1).map(([a, b], room) => ({ room, a: { team: teamName(a) }, b: { team: teamName(b) } })), byes: [] })) }], updated: 0 } });
for (let n = 1; n <= ROUNDS; n++) await call(A + '/packet?round=' + n + '&name=Packet' + n + '.pdf', { method: 'POST', body: 'PDF'.repeat(500) });
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: true, current_round: ROUNDS } });
for (let n = 1; n <= ROUNDS; n++) {
  for (const [k, [a, b]] of pairings(n).entries()) {
    await call('/b/' + rooms[k].secret + '/upload?round=' + n + '&name=R' + n + '_' + k + '.qbj', { method: 'POST', body: matchFor(n, a, b) });
  }
}
for (let i = 0; i < 6; i++) await call('/__scheduled');
const S = '/b/' + rooms[0].secret;
const rev = (await call(A)).body.tournament.rev;
console.log('tournament played and built; profiling...\n');

/* ---------- routes ---------- */
const ROUTES = [
  ['viewer page load (GET /pub/:slug)', () => call('/pub/' + slug)],
  ['Live Hub check, unchanged (?rev=)', () => call(A + '?rev=' + rev)],
  ['Live Hub full detail', () => call(A)],
  ['Live Hub / moderator tiebreakers', () => call(S + '/tiebreakers')],
  ['moderator: room state', () => call(S)],
  ['moderator: schedule', () => call(S + '/schedule')],
  ['moderator: roster', () => call(S + '/roster')],
  ['moderator: packet', () => call(S + '/packet?round=1&warm=1')],
  ['moderator: start game', () => call(S + '/start?round=' + ROUNDS, { method: 'POST' })],
  ['moderator: upload game (re-export)', () => call(S + '/upload?round=1&name=R1_0.qbj', { method: 'POST', body: matchFor(1, ...pairings(1)[0]) })],
  ['cron tick, nothing to do', () => call('/__scheduled')],
];
const rows = [];
for (const [label, fn] of ROUTES) {
  await fn(); // warm
  const t = await profiled(async () => { for (let i = 0; i < REPS; i++) await fn(); });
  const per = (x) => +(x / 1000 / REPS).toFixed(2);
  rows.push({ route: label, 'own code ms': per(t.own), 'D1 client ms': per(t.d1), 'builtins ms': per(t.builtins),
    'floor (own+D1) ms': per(t.own + t.d1), 'ceiling (all) ms': per(t.own + t.d1 + t.builtins) });
}
// the cron with work: a rebuild of this tournament (flag it dirty first;
// fewer reps, the flag costs a CLI round trip)
{
  const n = Math.min(REPS, 15);
  let tot = { own: 0, d1: 0, builtins: 0 };
  for (let i = 0; i < n; i++) {
    d1exec(`UPDATE tournaments SET pub_dirty = 1 WHERE slug = '${slug}'`);
    const t = await profiled(() => call('/__scheduled'));
    for (const k of Object.keys(tot)) tot[k] += t[k];
  }
  const per = (x) => +(x / 1000 / n).toFixed(2);
  rows.push({ route: `cron tick, rebuilding this tournament (${n} reps)`, 'own code ms': per(tot.own), 'D1 client ms': per(tot.d1),
    'builtins ms': per(tot.builtins), 'floor (own+D1) ms': per(tot.own + tot.d1), 'ceiling (all) ms': per(tot.own + tot.d1 + tot.builtins) });
}
console.table(rows);
console.log(JSON.stringify({ shape: SHAPE, reps: REPS, rows }));
ws.close();
process.exit(0);
