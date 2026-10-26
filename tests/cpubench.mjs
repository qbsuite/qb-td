// cpubench.mjs — CPU per request for the Worker's game, download and save
// routes, in this process (tests/inproc_worker.mjs), with a reader-size
// upload (~120 KB: packet text in the game half and again in MODAQ's
// texts). Comparative only: what it measures is this machine's.
//
//   node --expose-gc tests/cpubench.mjs                       # this checkout alone
//   QBTD_BASELINE=<dir> node --expose-gc tests/cpubench.mjs   # A/B against another checkout
//
// With QBTD_BASELINE (a checkout of the commit to hold to, e.g.
// `git worktree add <dir> <commit>` with node_modules linked), both
// Workers run side by side, each with its own database, interleaved route
// by route over ROUNDS rounds (5) of REPS requests (200), the order
// alternating each round. Pass: each route's median is within max(5%,
// 0.02 ms) of the baseline's. Exit 1 on a failure.

import { workerHarness } from './inproc_worker.mjs';

const REPS = Number(process.env.REPS || 200);
const ROUNDS = Number(process.env.ROUNDS || 5);
const BASELINE = process.env.QBTD_BASELINE || null;

const match = (round, extra = {}) => ({ tossups_read: 20,
  match_teams: [
    { team: { name: 'Alpha' }, bonus_points: 30, match_players: [{ player: { name: 'Ann' }, tossups_heard: 20, answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: 'Beta' }, bonus_points: 0, match_players: [{ player: { name: 'Bob' }, tossups_heard: 20, answer_counts: [{ number: 1, answer: { value: 10 } }] }] }],
  match_questions: Array.from({ length: 20 }, (_, q) => ({ question_number: q + 1, buzzes: [{ player: { name: 'Ann' }, team: { name: 'Alpha' }, buzz_position: { word_index: 40 }, result: { value: 10 } }] })),
  notes: '', _round: round, packets: 'P1', ...extra });
const game = { players: [{ name: 'Ann', teamName: 'Alpha' }, { name: 'Bob', teamName: 'Beta' }],
  packet: { tossups: Array.from({ length: 20 }, () => ({ question: 'word '.repeat(600) })) },
  cycles: Array.from({ length: 20 }, () => ({ buzzes: [{ marker: { player: { name: 'Ann', teamName: 'Alpha' } } }] })) };
const readerBody = JSON.stringify({ qbj: match(1), game: { game, uiState: {} },
  modaq: { qbj: JSON.stringify(match(1), null, 4), game: JSON.stringify(game, null, 2) }, protests: [], progress: { at: 20, of: 20 }, tb: { used: [] } });
const rosterQbj = (renamed) => JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
  { name: 'Alpha', teams: [{ name: 'Alpha', players: [renamed ? { name: 'Annie', _formerNames: ['Ann'] } : { name: 'Ann' }] }] },
  { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] }] }] });
// a rulings map near the most the Worker keeps (500 rulings, 64 KB as
// stored; 61 KB here), each ruling with its time, as cleanRulings stores
// it and the hub holds it
const bigRulings = Object.fromEntries(Array.from({ length: 480 }, (_, i) => [`r${1 + (i % 12)}|q${i}|Team ${i}|Team ${i + 1}`, { r: 'upheld', note: 'x'.repeat(58), at: 1760000000000 + i }]));
const ruledKey = Object.keys(bigRulings)[0];
// the map with its first ruling set to r, as the hub's saveRuling sends one change
const ruled = (r) => ({ ...bigRulings, [ruledKey]: { ...bigRulings[ruledKey], r } });

// One Worker set up with a played tournament and a set mirror; its routes.
async function setup(root) {
  const w = await workerHarness(root || undefined);
  const { call, quiet, sql, setRaw, etag } = w;
  const t = (await quiet(() => call('/api/tournaments', { method: 'POST', json: { name: 'Bench', slug: 'cpu-bench' } }))).body;
  const A = '/a/' + t.admin_secret;
  const room = (await quiet(() => call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } }))).body;
  await quiet(() => call(A + '/roster?name=roster.qbj', { method: 'POST', body: rosterQbj(false) }));
  await quiet(() => call(A + '/start', { method: 'POST' }));
  await quiet(() => call(A, { method: 'POST', json: { published: true, current_round: 3 } }));
  const up = (await quiet(() => call('/b/' + room.secret + '/upload?round=1&name=Round_1_Alpha_Beta.qbtd.json', { method: 'POST', body: readerBody }))).body;
  const key = sql('SELECT r2_key FROM files WHERE id=?', up.id)[0].r2_key;
  for (let i = 0; i < 99; i++) await quiet(() => call('/b/' + room.secret + '/upload?round=1&name=R1_' + i + '.qbj', { method: 'POST', body: JSON.stringify(match(1)) }));
  const ids = sql('SELECT id FROM files').map((r) => r.id).slice(0, 100).join(',');
  // ten reader uploads, packet text and all, for the QBJ bundle's batch read
  const readerIds = [up.id];
  for (let i = 0; i < 9; i++) readerIds.push((await quiet(() => call('/b/' + room.secret + '/upload?round=1&name=Round_1_R' + i + '.qbtd.json', { method: 'POST', body: readerBody }))).body.id);
  await quiet(() => w.tick());
  const sched = { v: 1, rooms: [{ name: 'Room 1', bucket: room.id }], phases: [{ name: 'Prelims', rounds: [1, 2, 3].map((n) => ({ round: n,
    games: [{ room: 0, a: { team: 'Alpha' }, b: { team: 'Beta' } }], byes: [] })) }], updated: 0 };
  await quiet(() => call(A + '/schedule', { method: 'POST', json: sched }));
  await quiet(() => call(A, { method: 'POST', json: { rulings: bigRulings } }));
  // a question set with this one mirror
  const set = (await quiet(() => call('/api/sets', { method: 'POST', json: { name: 'Bench Set', slug: 'cpu-set' } }))).body;
  const inv = (await quiet(() => call(`/s/${set.admin_secret}/mirrors`, { method: 'POST', json: { name: 'M' } }))).body;
  const mirror = (await quiet(() => call('/i/' + inv.invite, { method: 'POST', json: { name: 'M', slug: 'cpu-mirror' } }))).body;
  const MA = '/a/' + mirror.admin_secret;
  const mroom = (await quiet(() => call(MA + '/buckets', { method: 'POST', json: { room_name: 'M1' } }))).body;
  await quiet(() => call(MA + '/start', { method: 'POST' }));
  for (let i = 0; i < 8; i++) await quiet(() => call(`/b/${mroom.secret}/upload?round=1&name=m${i}.qbj`, { method: 'POST', body: JSON.stringify(match(1)) }));
  await quiet(() => call(MA + '/roster?name=roster.qbj', { method: 'POST', body: rosterQbj(true) }));
  for (let i = 0; i < 3; i++) await quiet(() => w.tick());

  const enc = encodeURIComponent;
  const settingsNow = () => sql('SELECT settings FROM tournaments WHERE id = ?', t.id)[0].settings || '{}';
  let flip = false;
  let held = 'upheld';
  const routes = {
    ['upload reader .qbtd.json (~' + Math.round(readerBody.length / 1024) + ' KB)']: () => call('/b/' + room.secret + '/upload?round=1&name=Round_1_Alpha_Beta.qbtd.json', { method: 'POST', body: readerBody }),
    'admin raw download': () => call(`${A}/file?key=${enc(key)}&dl=x`),
    'admin part=qbj, no renames': () => call(`${A}/file?key=${enc(key)}&part=qbj&dl=x.qbj`),
    'admin part=game, no renames': () => call(`${A}/file?key=${enc(key)}&part=game&dl=x.json`),
    'pub qbj, no renames': () => call(`/pub/cpu-bench/qbj/${up.id}`),
    'admin games?ids= (100 ids)': () => call(`${A}/games?ids=${ids}`),
    'admin uploads?ids= (10 reader uploads)': () => call(`${A}/uploads?ids=${readerIds.join(',')}`),
    'roster download (part=roster), no renames': () => call(`${A}/file?key=${enc(`t/${t.id}/roster.qbj`)}&part=roster&dl=r.qbj`),
    'settings save, no base': () => call(A, { method: 'POST', json: { settings: { gameFormat: (flip = !flip) ? 'acf' : 'naqt' } } }),
    'settings save, equal base': () => { const b = JSON.stringify(JSON.parse(settingsNow())); return call(A, { method: 'POST', json: { settings: { gameFormat: (flip = !flip) ? 'acf' : 'naqt' }, settings_base: b } }); },
    // one ruling changed per save, flipping, so the stored map is always
    // the hub's copy (held): with rulings_prev, the Worker's current-copy path
    'rulings save (64 KB map), no base': () => call(A, { method: 'POST', json: { rulings: ruled(held = held === 'upheld' ? 'denied' : 'upheld') } }),
    'rulings save (64 KB map), equal base': () => {
      const prev = ruled(held)[ruledKey];
      return call(A, { method: 'POST', json: { rulings: ruled(held = held === 'upheld' ? 'denied' : 'upheld'), rulings_prev: { [ruledKey]: prev } } });
    },
    'schedule save, no header': () => call(A + '/schedule', { method: 'POST', json: sched }),
    'schedule save, matching header': () => call(A + '/schedule', { method: 'POST', json: sched, headers: { 'X-Qbtd-Base': etag(`t/${t.id}/schedule.json`) } }),
    'roster save, no base': () => call(A + '/roster?name=roster.qbj', { method: 'POST', body: rosterQbj(false) }),
    'roster save, equal base': () => call(`${A}/roster?name=roster.qbj&base=${enc(etag(`t/${t.id}/roster.qbj`))}`, { method: 'POST', body: rosterQbj(false) }),
    'cron tick: a set mirror with renames is dirty': async () => { await quiet(() => call(MA + '/roster?name=roster.qbj', { method: 'POST', body: rosterQbj(true) })); return w.tick(); },
    RENAMES: null,
    'admin part=qbj, renames': () => call(`${A}/file?key=${enc(key)}&part=qbj&dl=x.qbj`),
    'admin part=game, renames': () => call(`${A}/file?key=${enc(key)}&part=game&dl=x.json`),
    'pub qbj, renames': () => call(`/pub/cpu-bench/qbj/${up.id}`),
    'roster download (part=roster), renames': () => call(`${A}/file?key=${enc(`t/${t.id}/roster.qbj`)}&part=roster&dl=r.qbj`),
  };
  return { w, routes, renames: () => setRaw(`t/${t.id}/roster.qbj`, rosterQbj(true)) };
}

// the main thread's CPU (process.threadCpuUsage, Node 23.9+), which leaves
// out the garbage collector's helper threads; after a collection, so one
// side doesn't pay for the other's garbage
const usage = process.threadCpuUsage ? () => process.threadCpuUsage() : () => process.cpuUsage();
async function cpuOf(w, fn) {
  for (let i = 0; i < 5; i++) await w.quiet(fn);
  if (globalThis.gc) globalThis.gc();
  const c0 = usage();
  for (let i = 0; i < REPS; i++) await w.quiet(fn);
  const c = usage();
  return (c.user - c0.user + c.system - c0.system) / 1000 / REPS;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const sides = [await setup(null)];
if (BASELINE) sides.push(await setup(BASELINE));
const labels = Object.keys(sides[0].routes);
const results = Object.fromEntries(labels.filter((l) => sides[0].routes[l]).map((l) => [l, sides.map(() => [])]));
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 ? [...sides.keys()].reverse() : [...sides.keys()];
  for (const side of sides) side.named = false;
  for (const label of labels) {
    for (const i of order) {
      const s = sides[i];
      if (!s.routes[label]) { if (!s.named) { s.renames(); s.named = true; } continue; }
      results[label][i].push(await cpuOf(s.w, s.routes[label]));
    }
  }
  // the next round starts again without renames
  for (const s of sides) s.w.setRaw(s.w.keys().find((k) => /^t\/1\/roster\.qbj$/.test(k)), rosterQbj(false));
}

const rows = [];
let failed = 0;
for (const [label, per] of Object.entries(results)) {
  const row = { route: label, 'ms (this)': +median(per[0]).toFixed(3) };
  if (BASELINE) {
    const a = median(per[0]);
    const b = median(per[1]);
    row['ms (baseline)'] = +b.toFixed(3);
    row.ratio = +(a / b).toFixed(3);
    row.ok = a <= b + Math.max(0.05 * b, 0.02);
    if (!row.ok) failed++;
  }
  rows.push(row);
}
console.table(rows);
console.log(JSON.stringify({ reps: REPS, rounds: ROUNDS, baseline: BASELINE, rows }));
if (failed) { console.error(failed + ' route(s) slower than the baseline by more than max(5%, 0.02 ms)'); process.exitCode = 1; }
