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
//   JSON        — JSON.parse/stringify: builtins that run in the Worker
//                 in production too: counts
//   builtins    — crypto, Response, fetch internals (no script URL).
//                 In production these count too, BUT locally this bucket
//                 also holds the simulated D1/R2 services, which in
//                 production run elsewhere and don't count. So "own + d1"
//                 is a floor and "all" a ceiling for the production figure.
// Absolute numbers are this machine's; production's own percentiles
// (Cloudflare analytics: p50 1.2 ms, p99 8.7 ms, p99.9 15.3 ms in
// September 2026) are the reference to scale against.

import { d1exec } from './e2e_lib.js';
import archive from '../app/archive/ug-nats-stanford.js';

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
  if (process.env.DUMP_LEAVES) {
    const byId0 = new Map(p.nodes.map((n) => [n.id, n]));
    const m = new Map();
    p.samples.forEach((id, i) => { const cf = byId0.get(id).callFrame; if (cf.functionName === '(idle)') return;
      const k = (cf.functionName || '(anon)') + ' @' + (cf.url || '').split('/').pop() + ':' + cf.lineNumber;
      m.set(k, (m.get(k) || 0) + (p.timeDeltas[i + 1] ?? 50)); });
    console.log([...m].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => (v / 1000).toFixed(1).padStart(7) + 'ms ' + k).join('\n'));
  }
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const t = { own: 0, d1: 0, json: 0, builtins: 0 };
  p.samples.forEach((id, i) => {
    const cf = byId.get(id).callFrame;
    if (cf.functionName === '(idle)') return;
    const dt = p.timeDeltas[i + 1] ?? 50;
    if ((cf.url || '').endsWith('worker.js')) t.own += dt;
    else if ((cf.url || '').includes('d1-api')) t.d1 += dt;
    // JSON.parse / JSON.stringify are builtins that certainly run in the
    // Worker in production too, so they're split out of the mixed bucket
    else if (!cf.url && (cf.functionName === 'parse' || cf.functionName === 'stringify')) t.json += dt;
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
const playerName = (t, p) => teamName(t) + ' P' + p;
const PLAYERS = 5;
// A real match qbj from the committed archive (the median-sized one,
// ~13KB with buzz-level detail), retargeted onto two teams — the cron's
// rebuild parses every game of a changed round, so game size is what
// its CPU scales with. Same fixture as stress_worker.js.
const sample = (() => {
  const bundle = archive[Object.keys(archive).find((k) => k.endsWith('/bundle'))];
  const sized = bundle.entries.map((e) => ({ e, n: JSON.stringify(e.qbj).length })).sort((a, b) => a.n - b.n);
  return sized[Math.floor(sized.length / 2)].e.qbj;
})();
const sampleTeamB = (sample.match_teams[1].team || {}).name;
function pairings(round) {
  const idx = [...Array(TEAMS).keys()];
  const r = (round - 1) % (TEAMS - 1);
  const rot = [idx[0], ...idx.slice(1 + r), ...idx.slice(1, 1 + r)];
  return Array.from({ length: TEAMS / 2 }, (_, i) => [rot[i], rot[TEAMS - 1 - i]]);
}
function matchFor(round, a, b) {
  const m = JSON.parse(JSON.stringify(sample));
  const names = [a, b];
  (m.match_teams || []).forEach((mt, i) => {
    if (mt.team) mt.team.name = teamName(names[i]);
    (mt.match_players || []).forEach((mp, j) => { if (mp.player) mp.player.name = playerName(names[i], j % PLAYERS); });
    (mt.lineups || []).forEach((l) => (l.players || []).forEach((p, j) => { p.name = playerName(names[i], j % PLAYERS); }));
  });
  (m.match_questions || []).forEach((q) => (q.buzzes || []).forEach((bz) => {
    const side = bz.team && bz.team.name === sampleTeamB ? 1 : 0;
    if (bz.team) bz.team.name = teamName(names[side]);
    if (bz.player) bz.player.name = playerName(names[side], 0);
  }));
  m._round = round;
  return JSON.stringify(m);
}

const K = Number(process.env.TOURNAMENTS || 4); // for the several-at-once cron case
console.log(`bench_routes: ${K} x ${SHAPE} tournament (${ROOMS} rooms x ${ROUNDS} rounds = ${ROOMS * ROUNDS} games of ~${(matchFor(1, 0, 1).length / 1024).toFixed(0)}KB), ${REPS} reps per route`);

async function playedTournament(i) {
  d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const slug = 'bench-' + SHAPE + '-' + i + '-' + Math.random().toString(36).slice(2, 7);
  const r = await call('/api/tournaments', { method: 'POST', json: { name: 'Bench ' + SHAPE + ' ' + i, slug } });
  const A = '/a/' + r.body.admin_secret;
  const rooms = [];
  for (let k = 0; k < ROOMS; k++) rooms.push((await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } })).body);
  await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify({ objects: [{ type: 'Tournament',
    registrations: Array.from({ length: TEAMS }, (_, t) => ({ name: teamName(t), teams: [{ name: teamName(t), players: Array.from({ length: PLAYERS }, (_, p) => ({ name: playerName(t, p) })) }] })) }] }) });
  await call(A + '/schedule', { method: 'POST', json: { v: 1, rooms: rooms.map((b, k) => ({ name: 'Room ' + (k + 1), bucket: b.id })),
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
  return { slug, A, rooms };
}
const Ts = [];
for (let i = 0; i < K; i++) Ts.push(await playedTournament(i));
for (let i = 0; i < 2 + Math.ceil(K / 4) * 2; i++) await call('/__scheduled');
const { slug, A, rooms } = Ts[0];
const S = '/b/' + rooms[0].secret;
const rev = (await call(A)).body.tournament.rev;
console.log('tournaments played and built; profiling...\n');

// a moderator re-exporting the last round's game: dirties the tournament
// and changes one round, which is what a busy minute's tick rebuilds
const reexport = (T) => call('/b/' + T.rooms[0].secret + '/upload?round=' + ROUNDS + '&name=R' + ROUNDS + '_0.qbj',
  { method: 'POST', body: matchFor(ROUNDS, ...pairings(ROUNDS)[0]) });

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
  ['moderator: upload game (re-export)', () => reexport(Ts[0])],
];
const rows = [];
for (const [label, fn] of ROUTES) {
  await fn(); // warm
  const t = await profiled(async () => { for (let i = 0; i < REPS; i++) await fn(); });
  const per = (x) => +(x / 1000 / REPS).toFixed(2);
  rows.push({ route: label, 'own code ms': per(t.own), 'D1 client ms': per(t.d1), 'JSON ms': per(t.json), 'other builtins ms': per(t.builtins),
    'floor (own+D1+JSON) ms': per(t.own + t.d1 + t.json), 'ceiling (all) ms': per(t.own + t.d1 + t.json + t.builtins) });
}
// The cron. Every case clears the queue first, so each profiled tick does
// exactly the work named.
async function cronCase(label, n, prep) {
  let tot = { own: 0, d1: 0, json: 0, builtins: 0 };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) await call('/__scheduled');
    await prep();
    const t = await profiled(() => call('/__scheduled'));
    for (const k of Object.keys(tot)) tot[k] += t[k];
  }
  const per = (x) => +(x / 1000 / n).toFixed(2);
  rows.push({ route: label, 'own code ms': per(tot.own), 'D1 client ms': per(tot.d1), 'JSON ms': per(tot.json),
    'other builtins ms': per(tot.builtins), 'floor (own+D1+JSON) ms': per(tot.own + tot.d1 + tot.json),
    'ceiling (all) ms': per(tot.own + tot.d1 + tot.json + tot.builtins) });
}
const CR = Number(process.env.CRON_REPS || 10);
await cronCase('cron tick, nothing to do', CR, async () => {});
await cronCase('cron tick, 1 tournament with a new game', CR, () => reexport(Ts[0]));
if (K >= 2) await cronCase(`cron tick, ${Math.min(K, 4)} tournaments each with a new game`, CR,
  async () => { for (const T of Ts.slice(0, 4)) await reexport(T); });
console.table(rows);
console.log(JSON.stringify({ shape: SHAPE, reps: REPS, rows }));
ws.close();
process.exit(0);
