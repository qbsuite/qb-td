// profile_day.mjs — where the Worker's CPU goes, per route, over a whole
// simulated tournament day (tests/sim_day.js) against the local metered
// Worker. Attaches to wrangler dev's inspector (port 9229), records a
// sampling CPU profile while sim_day runs, then charges every sample to
// the route handler it ran under and divides by that route's request
// count.
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
//   SHAPE=large node tests/profile_day.mjs
//
// Local CPU is not production CPU (different machine, and workerd's
// dev mode), so read the per-route numbers as relative: which routes are
// heavy and how they grow with tournament size. Production's own
// percentiles (Cloudflare analytics) are the absolute reference.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INSPECTOR = process.env.INSPECTOR || 'ws://127.0.0.1:9229/ws';
const INTERVAL_US = Number(process.env.INTERVAL_US || 100);

// handler function -> the sim_day category it serves (outermost match
// on the stack wins, so helpers are charged to their route)
const HANDLERS = {
  pubState: 'viewer page load',
  getTournament: 'TD Live Hub full detail',
  adminTiebreakers: 'TD Live Hub tiebreakers',
  updateTournament: 'TD sets the round',
  bucketState: 'moderator: room state',
  bucketSchedule: 'moderator: schedule',
  bucketRoster: 'moderator: roster',
  bucketPacket: 'moderator: packet',
  bucketTiebreakers: 'moderator: tiebreakers',
  bucketStartRound: 'moderator: start game',
  bucketUpload: 'moderator: upload game',
  tickDirty: 'cron tick',
  getAdminTournament: 'admin link lookup (every /a/ request)',
};

// wrangler's inspector proxy only accepts its DevTools origin, and
// answers some commands with an echo of the request (no `result`) —
// any message carrying our id completes the call
const ws = new WebSocket(INSPECTOR, { headers: { Origin: 'https://devtools.devprod.cloudflare.dev' } });
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('no inspector at ' + INSPECTOR)); });

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: INTERVAL_US });
await send('Profiler.start');
console.log(`profiling (sampling every ${INTERVAL_US}µs) while sim_day runs...`);

// run the day
const simOut = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./sim_day.js', import.meta.url))], { env: process.env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; if (/round \d+\/\d+ done/.test(d)) process.stdout.write(String(d)); });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error('sim_day failed:\n' + out))));
});
const stopped = await send('Profiler.stop');
ws.close();
const profile = stopped.result.profile;
const out = fileURLToPath(new URL(`./profile_${process.env.SHAPE || 'mid'}.cpuprofile`, import.meta.url));
writeFileSync(out, JSON.stringify(profile));

// ---- charge samples to routes ----
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const routeOf = new Map(); // node id -> category or null (memo)
function route(id) {
  if (routeOf.has(id)) return routeOf.get(id);
  // walk to the root, remembering the outermost handler
  let found = null;
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const fn = byId.get(cur).callFrame.functionName;
    if (HANDLERS[fn]) found = HANDLERS[fn];
  }
  routeOf.set(id, found);
  return found;
}
const deltas = profile.timeDeltas;
const us = {};
let idle = 0; let other = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = deltas[i + 1] ?? INTERVAL_US;
  const fn = byId.get(id).callFrame.functionName;
  if (fn === '(idle)' || fn === '(program)' || fn === '(garbage collector)') {
    if (fn === '(idle)') { idle += dt; continue; }
  }
  const r = route(id);
  if (r) us[r] = (us[r] || 0) + dt; else other += dt;
}

// request counts from sim_day's JSON line
const json = JSON.parse(simOut.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
const counts = json.perCategory;
const countFor = (cat) => {
  if (cat === 'viewer page load') return Object.entries(counts).filter(([k]) => k.startsWith('viewer')).reduce((n, [, v]) => n + v, 0);
  if (cat === 'TD Live Hub full detail') return null; // subset of checks; shown as total only
  if (cat.startsWith('admin link lookup')) return Object.entries(counts).filter(([k]) => k.startsWith('TD')).reduce((n, [, v]) => n + v, 0);
  return counts[cat] ?? null;
};
const rows = Object.entries(us).sort((a, b) => b[1] - a[1]).map(([cat, t]) => {
  const n = countFor(cat);
  return { route: cat, 'CPU total (ms)': +(t / 1000).toFixed(1), requests: n ?? '-', 'CPU per request (ms)': n ? +((t / 1000) / n).toFixed(2) : '-' };
});
console.log(simOut.split('\n').filter((l) => l.startsWith('===') || l.startsWith('tournament total')).join('\n'));
console.log(`\nCPU by route (local machine; relative, not production ms), profile saved to ${out}:`);
console.table(rows);
console.log(`unattributed (router, meter, runtime): ${(other / 1000).toFixed(1)} ms; idle ${(idle / 1e6).toFixed(1)} s`);

process.exit(0);
