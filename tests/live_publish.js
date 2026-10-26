// live_publish.js — unit tests for the public state files on qb-td-live
// ("public state on qb-td-live" in worker/worker.js): the cron's deploy,
// its retry/repair columns, heartbeats, backfill and unpublish, the hub's
// mark, and the /pub/:slug fallback. D1 is REAL SQLite (node:sqlite)
// loaded with worker/schema.sql, so the publisher's SQL — UPDATE ... FROM
// json_each, ->>, the partial indexes — runs as written. R2 and the
// Cloudflare assets API are faked; the API fake answers like the real one
// (asks only for hashes it doesn't hold, 202/201 per bucket, serves the
// last deployed version). No wrangler, no network:
//   node tests/live_publish.js
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { LivePublish } from '../worker/worker.js';

// The Worker logs the failures these tests provoke (console.log); hold
// its lines back, and show them only above a check that fails or a crash.
const print = console.log;
let held = [];
console.log = (...x) => { held.push(x.join(' ')); };
process.on('exit', (code) => { if (code) for (const l of held) console.error('  | ' + l); });

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; print('  ok', name); }
  else { for (const l of held) console.error('  | ' + l); console.error('FAIL', name, extra ?? ''); process.exitCode = 1; }
  held = [];
}

/* ---------- clock ---------- */
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const MIN = 60 * 1000;

/* ---------- D1: real SQLite behind the D1 API ---------- */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  const counts = { queries: 0 };
  const plain = (r) => (r ? { ...r } : null);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { counts.queries++; return { results: db.prepare(sql).all(...args).map(plain), meta: {} }; },
    async run() { counts.queries++; const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    async first(col) { counts.queries++; const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : plain(r)) : null; },
  });
  return { raw: db, counts, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

/* ---------- R2 ---------- */
function r2() {
  const objects = {};
  const obj = (text, at) => ({
    text: async () => text, json: async () => JSON.parse(text),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer, uploaded: new Date(at), etag: 'e' + at,
  });
  const counts = { get: 0, put: 0 };
  return {
    objects, counts,
    get: async (k) => { counts.get++; return objects[k] ? obj(objects[k].text, objects[k].at) : null; },
    head: async (k) => (objects[k] ? { key: k, uploaded: new Date(objects[k].at),
      size: new TextEncoder().encode(objects[k].text).byteLength } : null),
    put: async (k, body) => {
      counts.put++;
      objects[k] = { text: typeof body === 'string' ? body : new TextDecoder().decode(body), at: Date.now() };
    },
    delete: async (k) => { delete objects[k]; },
  };
}

/* ---------- the Cloudflare assets API ---------- */
function cloudflare() {
  const cf = {
    store: {}, deployed: null, metadata: null, calls: [], failPut: false, onPut: null,
    uploads: [], sessions: [],
  };
  let seq = 0;
  cf.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    cf.calls.push(method + ' ' + u.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+/, ''));
    const reply = (status, result) => new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ message: 'nope' }] }),
      { status, headers: { 'Content-Type': 'application/json' } });
    if (opts.headers?.Authorization !== 'Bearer live-token' && !/\/workers\/assets\/upload/.test(u)) return reply(403, null);
    if (/\/assets-upload-session$/.test(u)) {
      const { manifest } = JSON.parse(opts.body);
      const need = [...new Set(Object.values(manifest).map((f) => f.hash))].filter((h) => !(h in cf.store));
      const jwt = 'session-' + (++seq);
      cf.sessions.push({ manifest, need, jwt });
      return reply(200, { jwt, buckets: need.length ? [need] : [] });
    }
    if (/\/workers\/assets\/upload\?base64=true$/.test(u)) {
      const hashes = [];
      for (const [h, blob] of opts.body.entries()) {
        cf.store[h] = Buffer.from(await blob.text(), 'base64').toString('utf8');
        hashes.push(h);
      }
      cf.uploads.push(hashes);
      return reply(201, { jwt: 'done-' + (++seq) });
    }
    if (/\/workers\/scripts\/qb-td-live$/.test(u) && method === 'PUT') {
      if (cf.onPut) await cf.onPut();
      if (cf.failPut) return reply(500, null);
      const meta = JSON.parse(await opts.body.get('metadata').text());
      const session = cf.sessions[cf.sessions.length - 1];
      cf.metadata = meta;
      cf.deployed = Object.fromEntries(Object.entries(session.manifest).map(([p, f]) => [p, cf.store[f.hash]]));
      return reply(200, { id: 'v' + (++seq) });
    }
    return reply(403, null); // the scoped token can't do anything else
  };
  return cf;
}

/* ---------- a world ---------- */
function world(opts = {}) {
  const DB = d1();
  const DATA = r2();
  const cf = cloudflare();
  globalThis.fetch = cf.fetch;
  const env = {
    DB, DATA, ALLOWED_ORIGIN: 'https://qbsuite.github.io',
    ...(opts.off ? {} : { LIVE_SCRIPT: 'qb-td-live', LIVE_ACCOUNT_ID: 'acct', LIVE_TOKEN: 'live-token' }),
  };
  let nextId = 1;
  const add = ({ noPubstate = false, ...fields } = {}) => {
    const id = nextId++;
    const t = { slug: 'tour-' + id, name: 'Tournament ' + id, admin_secret: 'adminsecret' + String(id).padStart(4, '0'),
      created: clock, started: clock, published: 1, pub_built: clock, current_round: 2, ...fields };
    const cols = Object.keys(t);
    DB.raw.prepare(`INSERT INTO tournaments (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
      .run(id, ...cols.map((c) => t[c]));
    if (!noPubstate) {
      DATA.objects[`t/${id}/pubstate.json`] = { text: JSON.stringify({
        name: 'stale name from the build', current_round: 1, rounds: { 1: '1:1' }, files: [{ id: 9, round: 1 }],
        schedule: null, cats: null, buzz: null, final: false, version: 'v1',
      }), at: clock };
    }
    return id;
  };
  const row = (id) => ({ ...DB.raw.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) });
  const tick = async () => {
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  const live = (slug) => (cf.deployed && cf.deployed[`/t/${slug}.json`] ? JSON.parse(cf.deployed[`/t/${slug}.json`]) : null);
  return { DB, DATA, cf, env, add, row, tick, live };
}
const addNoPubstate = (w, fields = {}) => w.add({ ...fields, noPubstate: true });

/* ---------- scenarios ---------- */

// 1. Backfill: published tournaments with a built pubstate go live on the
// first tick; unpublished and never-built ones don't.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add({ name: 'Second Open' });
  const off = w.add({ published: 0 });
  const unbuilt = w.add({ pub_built: null });
  await w.tick();
  ok('backfill: one deploy, assets only',
    w.cf.calls.filter((c) => c.startsWith('PUT')).length === 1 && w.cf.metadata && !('main_module' in w.cf.metadata));
  ok('backfill: CORS rides the assets config',
    w.cf.metadata.assets.config._headers.includes('Access-Control-Allow-Origin: *'));
  ok('backfill: health file + the two published, built tournaments',
    JSON.stringify(Object.keys(w.cf.deployed).sort())
    === JSON.stringify(['/health.json', '/t/tour-1.json', '/t/tour-2.json']), Object.keys(w.cf.deployed));
  const f = w.live('tour-2');
  ok('backfill: file = pubstate + the row\'s live fields, stamped, no final',
    f.name === 'Second Open' && f.current_round === 2 && f.at === clock && f.hb_ms === 10 * MIN
    && f.hb_until > clock && !('final' in f) && f.rounds['1'] === '1:1', f);
  const ra = w.row(a);
  ok('backfill: want == hash, size and at recorded',
    ra.live_hash && ra.live_want === ra.live_hash && ra.live_size > 0 && ra.live_at === clock && ra.live_failed_at === null, ra);
  ok('backfill: unpublished and never-built untouched',
    w.row(off).live_want === null && w.row(unbuilt).live_want === null && w.row(unbuilt).live_hash === null);

  // 2. Nothing due: an idle tick deploys nothing.
  w.cf.calls.length = 0;
  clock += MIN;
  await w.tick();
  ok('idle tick: no Cloudflare calls', w.cf.calls.length === 0, w.cf.calls);

  // 3. The tick's own change: only the changed file is uploaded; the
  // unchanged one rides the manifest by hash.
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('Renamed Open', a);
  const before = w.row(b).live_hash;
  const res = await (await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env)).json();
  ok('change: deployed', res.deployed === true && w.live('tour-1').name === 'Renamed Open', res);
  ok('change: only the new file uploaded', w.cf.uploads.at(-1).length === 1, w.cf.uploads.at(-1));
  ok('change: unchanged tournament keeps its file and hash',
    w.live('tour-2').name === 'Second Open' && w.row(b).live_hash === before);
}

// 4. A failed deploy: nothing claims success, want != hash, the retry
// waits LIVE_RETRY_MS, and then lands.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  await w.tick();
  const deployedHash = w.row(a).live_hash;
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('New Name', a);
  w.cf.failPut = true;
  clock += MIN;
  const res = await (await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env)).json();
  const r = w.row(a);
  ok('failure: reported, not thrown', res.deployed === false && /500/.test(res.error), res);
  ok('failure: live_hash still the old deploy, want the new body, failure stamped',
    r.live_hash === deployedHash && r.live_want !== deployedHash && r.live_failed_at === clock, r);
  ok('failure: viewers still have the old file', w.live('tour-1').name === 'Tournament 1');
  w.cf.failPut = false;
  w.cf.calls.length = 0;
  clock += 2 * MIN;
  await w.tick();
  ok('failure: no retry before 5 minutes', w.cf.calls.length === 0, w.cf.calls);
  clock += 4 * MIN;
  await w.tick();
  const r2row = w.row(a);
  ok('failure: retried after 5 minutes and landed',
    w.live('tour-1').name === 'New Name' && r2row.live_hash === r2row.live_want && r2row.live_failed_at === null, r2row);
}

// 5. Out-of-order deploys: a slow run lands after a newer one. Its
// write-back records what IT shipped for every file, so the row reads
// want != hash, and the next tick repairs it.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add();
  await w.tick();
  const shippedB = w.row(b).live_hash;
  // while run A (for tournament a) is mid-deploy, a newer run deploys b
  w.cf.onPut = async () => {
    w.cf.onPut = null;
    w.DB.raw.prepare('UPDATE tournaments SET live_want = ?, live_hash = ? WHERE id = ?').run('newer-b', 'newer-b', b);
  };
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('A changed', a);
  clock += MIN;
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env);
  const rb = w.row(b);
  ok('race: the late deploy records what it shipped for b', rb.live_hash === shippedB && rb.live_want === 'newer-b', rb);
  w.cf.calls.length = 0;
  clock += MIN;
  await w.tick();
  const rb2 = w.row(b);
  ok('race: next tick redeploys b and settles', w.cf.calls.some((c) => c.startsWith('PUT'))
    && rb2.live_hash === rb2.live_want && rb2.live_hash !== 'newer-b', rb2);
}

// 6. Unpublish through the admin route: the file goes on the next tick.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add();
  await w.tick();
  const secret = w.row(a).admin_secret;
  const r = await worker.fetch(new Request('https://w/a/' + secret, {
    method: 'POST', body: JSON.stringify({ published: false }), headers: { 'Content-Type': 'application/json' },
  }), w.env, { waitUntil() {} });
  ok('unpublish: route ok, want cleared', r.status === 200 && w.row(a).live_want === null && w.row(a).live_hash, await r.text());
  clock += MIN;
  await w.tick();
  ok('unpublish: file gone, the other stays',
    !w.cf.deployed['/t/tour-1.json'] && !!w.cf.deployed['/t/tour-2.json'], Object.keys(w.cf.deployed));
  const ra = w.row(a);
  ok('unpublish: row cleared', ra.live_hash === null && ra.live_want === null && ra.live_at === null, ra);
  void b;
}

// 7. Heartbeat: an active tournament's file is redeployed every 10
// minutes with a fresh stamp; one quiet for 6 hours isn't.
{
  clock = realNow();
  const w = world();
  const active = w.add();
  const quiet = w.add({ pub_built: clock - 7 * 3600 * 1000 });
  await w.tick();
  const at0 = w.live('tour-1').at;
  const quietAt0 = w.row(quiet).live_at;
  clock += 11 * MIN;
  await w.tick();
  ok('heartbeat: active file redeployed with a fresh at', w.live('tour-1').at === clock && w.live('tour-1').at > at0);
  ok('heartbeat: quiet tournament left alone', w.row(quiet).live_at === quietAt0);
  w.cf.calls.length = 0;
  clock += 3 * MIN;
  await w.tick();
  ok('heartbeat: not due again inside 10 minutes', w.cf.calls.length === 0, w.cf.calls);
  void active;
}

// 7b. Heartbeats fall into step: active tournaments due within half an
// interval ride another's heartbeat deploy, so a quiet hour costs about
// one deploy per interval for all of them, not one per tournament — and
// no file ever goes longer than an interval (plus a tick) unstamped.
{
  clock = realNow();
  const w = world();
  const t0 = clock;
  const ids = [w.add()];
  await w.tick();
  clock += 3 * MIN; ids.push(w.add()); await w.tick();
  clock += 3 * MIN; ids.push(w.add()); await w.tick();
  const quiet = w.add({ pub_built: clock - 7 * 3600 * 1000 });
  await w.tick();
  const quietAt0 = w.row(quiet).live_at;
  const puts = () => w.cf.calls.filter((c) => /^PUT \/workers\/scripts\/qb-td-live$/.test(c)).length;
  w.cf.calls.length = 0;
  let oldest = 0;
  for (let m = 0; m < 60; m++) {
    clock += MIN;
    await w.tick();
    for (const id of ids) oldest = Math.max(oldest, clock - w.live('tour-' + id).at);
  }
  console.log('    deploys in the hour:', puts());
  ok('heartbeat step: three quiet active tournaments, at most 7 deploys an hour (16 before)', puts() <= 7, puts());
  ok('heartbeat step: no file older than an interval plus a tick', oldest <= 11 * MIN, oldest / MIN);
  const ats = ids.map((id) => w.live('tour-' + id).at);
  ok('heartbeat step: their stamps fall together', new Set(ats).size === 1, ats.map((x) => (x - t0) / MIN));
  ok('heartbeat step: a tournament quiet for 6 hours never rides', w.row(quiet).live_at === quietAt0);
  ok('heartbeat step: riders end in sync (live_want follows the hash they shipped)',
    ids.every((id) => w.row(id).live_want === w.row(id).live_hash), ids.map((id) => w.row(id)));
  // a change still goes at once
  w.cf.calls.length = 0;
  clock += MIN;
  w.DB.raw.prepare('UPDATE tournaments SET live_want = ? WHERE id = ?').run('changed', ids[0]);
  await w.tick();
  ok('heartbeat step: a change still deploys on the next tick', puts() === 1, w.cf.calls);
}

// 7c. Riders only ride a heartbeat. A run that only a parked row brought
// up (published, but no pubstate to publish) still ships nothing, so a
// parked row next to an active tournament costs no deploys of its own.
{
  const deploysIn2h = async (parked) => {
    clock = realNow();
    const w = world();
    w.add();
    await w.tick();
    clock += 3 * MIN;
    if (parked === 'never built') addNoPubstate(w);
    if (parked === 'lost') {
      // deployed once, then its pubstate went missing
      const lost = w.add();
      await w.tick();
      delete w.DATA.objects[`t/${lost}/pubstate.json`];
    }
    await w.tick();
    w.cf.calls.length = 0;
    for (let m = 0; m < 120; m++) { clock += MIN; await w.tick(); }
    return w.cf.calls.filter((c) => /^PUT \/workers\/scripts\/qb-td-live$/.test(c)).length;
  };
  const alone = await deploysIn2h(null);
  const neverBuilt = await deploysIn2h('never built');
  const lost = await deploysIn2h('lost');
  ok('parked + active: no deploys beyond the active one\'s heartbeats (never built)', neverBuilt === alone, { alone, neverBuilt });
  ok('parked + active: no deploys beyond the active one\'s heartbeats (pubstate lost)', lost === alone, { alone, lost });
}

// 7d. A failed deploy with a rider on it: the tournament whose heartbeat
// it was reads Delayed, as before. The rider doesn't (nothing of its was
// waiting on that deploy), and its own heartbeat comes when it would have.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  await w.tick();
  clock += 4 * MIN;
  const b = w.add();
  await w.tick();
  const b0 = w.row(b);
  const markOf = async (id) => (await (await worker.fetch(new Request('https://w/a/' + w.row(id).admin_secret), w.env,
    { waitUntil() {} })).json()).tournament.live.state;
  // 7 minutes later: a's heartbeat is due, b is half due and rides
  clock += 7 * MIN;
  w.cf.failPut = true;
  await w.tick();
  const tried = w.cf.sessions.at(-1).manifest;
  ok('rider failure: the failed deploy carried a rebuilt file for the rider',
    tried['/t/tour-2.json'] && tried['/t/tour-2.json'].hash !== b0.live_hash, tried);
  const b1 = w.row(b);
  ok('rider failure: the rider\'s row is as it was',
    ['live_want', 'live_hash', 'live_at', 'live_failed_at'].every((k) => b1[k] === b0[k]), { b0, b1 });
  ok('rider failure: the heartbeat\'s own tournament is stamped, as before',
    w.row(a).live_failed_at === clock && w.row(a).live_want !== w.row(a).live_hash, w.row(a));
  clock += 2 * MIN;
  ok('rider failure: the hub reads Delayed for the heartbeat\'s tournament only',
    (await markOf(a)) === 'failing' && (await markOf(b)) === 'ok', [await markOf(a), await markOf(b)]);
  w.cf.failPut = false;
  const marks = [];
  let oldest = 0;
  for (let m = 0; m < 12; m++) {
    clock += MIN;
    await w.tick();
    marks.push(await markOf(b));
    oldest = Math.max(oldest, clock - w.live('tour-2').at);
  }
  ok('rider failure: the rider never reads Delayed afterwards', !marks.includes('failing'), marks.join(','));
  ok('rider failure: its file is restamped on its own heartbeat, within an interval plus a tick',
    oldest <= 11 * MIN && w.live('tour-2').at > b0.live_at, oldest / MIN);
  ok('rider failure: both settle', [a, b].every((id) => w.row(id).live_want === w.row(id).live_hash
    && w.row(id).live_failed_at === null), [w.row(a), w.row(b)]);
}

// 7e. A busy hour: one tournament changes each minute, so a deploy goes
// out on each tick. The quiet ones are still restamped about once per
// interval, not on each change's deploy: that would rebuild and upload
// their files twice as often and save no deploy.
{
  clock = realNow();
  const w = world();
  const busy = w.add();
  await w.tick();
  const quiet = [];
  for (let i = 0; i < 3; i++) { clock += 3 * MIN; quiet.push(w.add()); await w.tick(); }
  const stamps = Object.fromEntries(quiet.map((id) => [id, [w.row(id).live_at]]));
  w.cf.calls.length = 0;
  for (let m = 0; m < 60; m++) {
    clock += MIN;
    w.DB.raw.prepare('UPDATE tournaments SET pub_dirty = 1, pub_dirty_at = ? WHERE id = ?').run(clock, busy);
    await w.tick();
    for (const id of quiet) if (w.row(id).live_at !== stamps[id].at(-1)) stamps[id].push(w.row(id).live_at);
  }
  const puts = w.cf.calls.filter((c) => /^PUT \/workers\/scripts\/qb-td-live$/.test(c)).length;
  const restamps = quiet.map((id) => stamps[id].length - 1);
  print('    busy hour: restamps of the quiet three:', restamps.join(', '));
  ok('busy hour: a deploy on each tick', puts === 60, puts);
  ok('busy hour: quiet tournaments restamped at most 6 times each in the hour', restamps.every((n) => n <= 6), restamps);
  // once in step, a quiet file is restamped only when its heartbeat is due
  const lastGaps = quiet.map((id) => stamps[id].slice(-3)).map(([x, y, z]) => [y - x, z - y]).flat();
  ok('busy hour: in step, no quiet file restamped before its heartbeat', lastGaps.every((g) => g > 10 * MIN),
    lastGaps.map((g) => g / MIN));
}

// 8. Published and built, but no pubstate to publish: parked on the
// failure cadence, not retried every minute.
{
  clock = realNow();
  const w = world();
  const lost = addNoPubstate(w);
  await w.tick();
  const r = w.row(lost);
  ok('unbuildable: parked', r.live_want === '-' && r.live_failed_at === clock && r.live_hash === null, r);
  w.cf.calls.length = 0;
  clock += MIN;
  await w.tick();
  ok('unbuildable: no deploy next minute', w.cf.calls.length === 0, w.cf.calls);
  clock += 6 * MIN;
  await w.tick();
  ok('unbuildable: its 5-minute retry finds nothing to ship and deploys nothing',
    !w.cf.calls.some((c) => c.startsWith('PUT') || c.includes('upload-session')), w.cf.calls);
}

// 8b. An unpublished tournament whose columns still say "deployed" (the
// unpublish write missed): the next deploy of anything drops its file.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add();
  await w.tick();
  w.DB.raw.prepare('UPDATE tournaments SET published = 0 WHERE id = ?').run(a); // want == hash still
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('B changed', b);
  clock += MIN;
  await LivePublish.fetch(new Request('https://live/?ids=' + b), w.env);
  const ra = w.row(a);
  ok('unpublished: file dropped by the next deploy, row cleared',
    !w.cf.deployed['/t/tour-1.json'] && !!w.cf.deployed['/t/tour-2.json'] && ra.live_hash === null && ra.live_want === null,
    { ra, files: Object.keys(w.cf.deployed) });
  w.cf.calls.length = 0;
  clock += MIN;
  await w.tick();
  ok('unpublished: settled — no follow-up deploy', w.cf.calls.length === 0, w.cf.calls);
}

// 8d. An outage on an active tournament: retries stay 5 minutes apart
// even once its heartbeat is overdue, and the hub reads Delayed between
// them (a try every minute would keep re-stamping the failure).
{
  clock = realNow();
  const w = world();
  const a = w.add();
  await w.tick();
  const secret = w.row(a).admin_secret;
  w.cf.failPut = true;
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('During outage', a);
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env); // first failure
  const tries = [];
  const marks = [];
  for (let m = 1; m <= 20; m++) {
    clock += MIN;
    const before = w.cf.calls.filter((c) => c.startsWith('PUT')).length;
    await w.tick();
    if (w.cf.calls.filter((c) => c.startsWith('PUT')).length > before) tries.push(m);
    clock += 30 * 1000;
    marks.push((await (await worker.fetch(new Request('https://w/a/' + secret), w.env, { waitUntil() {} })).json()).tournament.live.state);
    clock -= 30 * 1000;
  }
  // "more than 5 minutes since the last try", checked once a minute
  const gaps = tries.map((m, i) => m - (i ? tries[i - 1] : 0));
  ok('outage: retries 5-6 minutes apart, never every minute, heartbeat or not',
    tries.length >= 3 && gaps.every((g) => g >= 5 && g <= 6), tries);
  ok('outage: the hub reads Delayed except right after a try',
    marks.every((st, i) => st === (tries.includes(i + 1) ? 'pending' : 'failing')), marks.join(','));
}

// 8c. The deploy stamps a failure before it starts (success clears it),
// so a run killed outright still waits five minutes to retry.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  let during = null;
  w.cf.onPut = async () => { during = w.row(a).live_failed_at; };
  await w.tick();
  ok('pre-stamp: failure stamped during the deploy, cleared after', during === clock && w.row(a).live_failed_at === null,
    { during, after: w.row(a).live_failed_at });
}

// 9. Cloudflare asks for a file an earlier deploy shipped but it no
// longer holds: that tournament is rebuilt and the deploy goes again.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add();
  await w.tick();
  delete w.cf.store[w.row(b).live_hash];
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('A again', a);
  clock += MIN;
  const res = await (await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env)).json();
  const rb = w.row(b);
  ok('lost file: rebuilt and redeployed', res.deployed === true && w.live('tour-2') && w.live('tour-2').at === clock
    && rb.live_hash === rb.live_want, { res, rb });
}

// 9b. qb-td-live deleted and recreated with many tournaments live: one
// run rebuilds what it may, the rest leave the deploy and backfill brings
// them back a few per tick; no run goes near 50 subrequests.
{
  clock = realNow();
  const w = world();
  const ids = Array.from({ length: 25 }, () => w.add());
  for (let i = 0; i < 6; i++) { await w.tick(); clock += MIN; } // backfill all 25 (5 a tick)
  ok('recreate: all 25 live first', ids.every((id) => w.row(id).live_hash), ids.filter((id) => !w.row(id).live_hash));
  w.cf.store = {}; // the new Worker holds nothing
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('Changed', ids[0]);
  w.DB.counts.queries = 0; w.DATA.counts.get = 0; w.DATA.counts.put = 0; w.cf.calls.length = 0;
  const res = await (await LivePublish.fetch(new Request('https://live/?ids=' + ids[0]), w.env)).json();
  const sub = w.DB.counts.queries + w.DATA.counts.get + w.DATA.counts.put + w.cf.calls.length;
  ok('recreate: the run deploys what it rebuilt, under 50 subrequests (' + sub + ')',
    res.deployed === true && sub < 50 && Object.keys(w.cf.deployed).length === 11, { res, sub, files: Object.keys(w.cf.deployed).length });
  for (let i = 0; i < 5; i++) { clock += MIN; await w.tick(); }
  ok('recreate: backfill brings every file back within a few ticks',
    ids.every((id) => w.cf.deployed[`/t/tour-${id}.json`]) && ids.every((id) => w.row(id).live_hash === w.row(id).live_want),
    ids.filter((id) => !w.cf.deployed[`/t/tour-${id}.json`]));
}

// 9c. A lost file whose tournament can't be rebuilt (its pubstate is
// gone): dropped instead of failing every deploy for good.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add();
  await w.tick();
  w.cf.store = {};
  delete w.DATA.objects[`t/${b}/pubstate.json`];
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('A moves on', a);
  clock += MIN;
  const res = await (await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env)).json();
  const rb = w.row(b);
  ok('lost + unbuildable: the deploy still lands, the orphan leaves it',
    res.deployed === true && w.live('tour-1').name === 'A moves on' && !w.cf.deployed['/t/tour-2.json'] && rb.live_hash === null,
    { res, rb });
}

// 10. A deleted tournament's file goes with the next deploy.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const b = w.add();
  await w.tick();
  w.DB.raw.prepare('DELETE FROM tournaments WHERE id = ?').run(b);
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('Still here', a);
  clock += MIN;
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env);
  ok('deleted: its file dropped', !w.cf.deployed['/t/tour-2.json'] && !!w.cf.deployed['/t/tour-1.json']);
}

// 11. Feature off: the tick touches neither Cloudflare nor the live columns.
{
  clock = realNow();
  const w = world({ off: true });
  w.add();
  await w.tick();
  ok('off: no Cloudflare calls', w.cf.calls.length === 0, w.cf.calls);
}

// 12. The fallback route: same state as the file (minus the stamps, plus
// final), and the reason is logged.
{
  clock = realNow();
  const w = world();
  const a = w.add({ name: 'Parity Open' });
  await w.tick();
  const logs = [];
  const log = console.log;
  console.log = (...x) => { logs.push(x.join(' ')); };
  const r = await worker.fetch(new Request('https://w/pub/tour-1?fb=old'), w.env, { waitUntil() {} });
  console.log = log;
  const body = await r.json();
  const file = w.live('tour-1');
  const strip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  ok('fallback: /pub/:slug and the file agree',
    JSON.stringify(strip(body, ['final'])) === JSON.stringify(strip(file, ['at', 'hb_ms', 'hb_until'])),
    { body, file });
  ok('fallback: reason logged', logs.some((l) => l === 'live fallback tour-1 old'), logs);
  void a;
}

// 13. The hub's mark.
{
  clock = realNow();
  const w = world();
  const a = w.add();
  const secret = w.row(a).admin_secret;
  const markOf = async () => (await (await worker.fetch(new Request('https://w/a/' + secret), w.env, { waitUntil() {} })).json()).tournament.live;
  ok('mark: pending before the first deploy', (await markOf()).state === 'pending');
  await w.tick();
  const m = await markOf();
  ok('mark: ok once deployed', m.state === 'ok' && m.at === clock, m);
  w.cf.failPut = true;
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('x', a);
  clock += MIN;
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env);
  ok('mark: pending right after a failed try (could be a deploy in flight)', (await markOf()).state === 'pending');
  clock += 2 * MIN;
  ok('mark: failing once the failure is over a minute old', (await markOf()).state === 'failing');
  const rev = w.row(a).rev;
  const unchanged = await (await worker.fetch(new Request('https://w/a/' + secret + '?rev=' + rev), w.env, { waitUntil() {} })).json();
  ok('mark: the unchanged refresh carries it too', unchanged.unchanged && unchanged.live.state === 'failing', unchanged);
}

// 14. The tick end to end: a dirty, published tournament is rebuilt
// (real materialize over real SQL) and its file deployed in that tick.
{
  clock = realNow();
  const w = world();
  const a = w.add({ pub_dirty: 1, pub_built: null });
  delete w.DATA.objects[`t/${a}/pubstate.json`];
  await w.tick();
  const f = w.live('tour-1');
  ok('tick: rebuilt and deployed in one tick', !!f && f.name === 'Tournament 1' && w.row(a).pub_dirty === 0, { f, row: w.row(a) });
}

// 14b. Through the LIVE binding (as in production): the tick reads the
// entrypoint's answer, so the call doesn't end as clientDisconnected.
{
  clock = realNow();
  const w = world();
  w.add();
  const answers = [];
  w.env.LIVE = { fetch: async (u) => { const r = await LivePublish.fetch(new Request(u), w.env); answers.push(r); return r; } };
  await w.tick();
  ok('binding: deployed through LIVE, answer read', answers.length === 1 && answers[0].bodyUsed && !!w.live('tour-1'),
    answers.map((r) => r.bodyUsed));
}

// 14c. The rebuild queue is served longest-waiting first: a tournament
// that keeps changing can't starve the ones behind it (with newest-first
// the oldest waited out every busy minute).
{
  clock = realNow();
  const w = world();
  const ids = Array.from({ length: 6 }, () => w.add({ pub_built: null }));
  // all six waiting, the OLDEST-created waiting longest
  ids.forEach((id, i) => w.DB.raw.prepare('UPDATE tournaments SET pub_dirty = 1, pub_dirty_at = ? WHERE id = ?')
    .run(clock - (10 - i) * 1000, id));
  await w.tick();
  const claimed = () => ids.filter((id) => w.row(id).pub_dirty === 0);
  ok('queue: the four that waited longest go first', JSON.stringify(claimed()) === JSON.stringify(ids.slice(0, 4)), claimed());
  ok('queue: claiming clears the wait stamp', ids.slice(0, 4).every((id) => w.row(id).pub_dirty_at === null));
  // the served four change again at once (a busy round): they queue BEHIND
  // the two still waiting
  clock += MIN;
  for (const id of ids.slice(0, 4)) {
    w.DB.raw.prepare('UPDATE tournaments SET pub_dirty = 1, pub_dirty_at = COALESCE(pub_dirty_at, ?) WHERE id = ?').run(clock, id);
  }
  await w.tick();
  ok('queue: the two left waiting are served next, not starved',
    w.row(ids[4]).pub_dirty === 0 && w.row(ids[5]).pub_dirty === 0, ids.map((id) => w.row(id).pub_dirty));
  // two of the re-marked four were served alongside; the other two still
  // wait, stamped with when they were first marked again
  const still = ids.slice(0, 4).filter((id) => w.row(id).pub_dirty === 1);
  ok('queue: 4 a tick — two of the re-marked still waiting', still.length === 2 && still.every((id) => w.row(id).pub_dirty_at === clock),
    still.map((id) => w.row(id)));
  const secret = w.row(still[0]).admin_secret;
  clock += 5000;
  // a real change through the admin route (markPub) keeps the first stamp
  await worker.fetch(new Request('https://w/a/' + secret, { method: 'POST', body: JSON.stringify({ name: 'Renamed again' }),
    headers: { 'Content-Type': 'application/json' } }), w.env, { waitUntil() {} });
  ok('queue: a further change keeps its place (first wait stamp kept)', w.row(still[0]).pub_dirty_at === clock - 5000,
    w.row(still[0]).pub_dirty_at);
}

// 15. Budget: a full run (10 tournaments) stays well inside the Free
// plan's 50 subrequests per invocation.
{
  clock = realNow();
  const w = world();
  const ids = Array.from({ length: 30 }, () => w.add());
  // 4 from the tick, 6 retries due, and backfill (5) for the rest: 15
  // candidates for a run that takes 10
  w.DB.raw.prepare("UPDATE tournaments SET live_want = 'x' WHERE id BETWEEN 11 AND 16").run();
  w.DB.counts.queries = 0; w.DATA.counts.get = 0; w.DATA.counts.put = 0; w.cf.calls.length = 0;
  await LivePublish.fetch(new Request('https://live/?ids=' + ids.slice(26, 30).join(',')), w.env);
  const sub = w.DB.counts.queries + w.DATA.counts.get + w.DATA.counts.put + w.cf.calls.length;
  ok('budget: one run caps at 10 tournaments, the tick\'s own first',
    Object.keys(w.cf.deployed).length === 11 && ids.slice(26, 30).every((id) => w.cf.deployed[`/t/tour-${id}.json`]),
    Object.keys(w.cf.deployed));
  ok('budget: under 50 subrequests (' + sub + ')', sub < 50,
    { d1: w.DB.counts.queries, r2get: w.DATA.counts.get, r2put: w.DATA.counts.put, api: w.cf.calls.length });
}

// 16. The hourly sweep on an instance where nothing has ever been listed:
// no directory file, so nothing to deploy — before, every sweep deployed
// (and stored a qb-td-live version) because none recorded what it shipped.
{
  clock = realNow();
  const w = world();
  w.add();
  await w.tick();
  const sweep = async () => {
    const waits = [];
    await worker.scheduled({ cron: '0 * * * *' }, w.env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  w.cf.calls.length = 0;
  for (let h = 0; h < 3; h++) { clock += 60 * MIN; await sweep(); }
  ok('sweep: empty directory, no deploys', !w.cf.calls.some((c) => c.startsWith('PUT')), w.cf.calls);
  // once something is listed, the sweep ships it once and then rests
  w.DB.raw.prepare('UPDATE tournaments SET dir_entry = ? WHERE id = 1')
    .run(JSON.stringify({ n: 'Tournament 1', s: 'tour-1', d: clock, c: clock + 48 * 60 * MIN }));
  await sweep();
  const puts = () => w.cf.calls.filter((c) => c.startsWith('PUT')).length;
  ok('sweep: a listed tournament is deployed', puts() === 1 && !!w.cf.deployed['/directory.json'], w.cf.calls);
  clock += 60 * MIN;
  await sweep();
  ok('sweep: then no redeploy while unchanged', puts() === 1, w.cf.calls);
}

// Buzzpoints packets as static files: finished rounds' files ride the
// deploy for published tournaments with buzzpoints on; a new one is read
// from R2 and uploaded once, then rides by hash; one Cloudflare lost is
// sent again; buzzpoints off ships none.
{
  clock = realNow();
  const w = world();
  const hashOf = async (text) => {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b64 + 'bin'));
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
  };
  const on = JSON.stringify({ buzz: { mode: 'password', salt: 's', hash: 'h' } });
  const a = w.add({ settings: on });
  const off = w.add({ settings: '{}' });
  const f1 = 'encrypted round one';
  const f2 = 'encrypted round two';
  const h1 = await hashOf(f1);
  const h2 = await hashOf(f2);
  w.DATA.objects[`t/${a}/buzzpub/1.bin`] = { text: f1, at: clock };
  w.DATA.objects[`t/${a}/buzzpub/2.bin`] = { text: f2, at: clock };
  w.DATA.objects[`t/${off}/buzzpub/1.bin`] = { text: f1 + ' off', at: clock };
  const setPub = (id, obj) => w.DB.raw.prepare('UPDATE tournaments SET buzz_pub = ? WHERE id = ?').run(JSON.stringify(obj), id);
  setPub(a, { 1: { h: h1, s: f1.length, live: 0 } });
  setPub(off, { 1: { h: await hashOf(f1 + ' off'), s: 10, live: 0 } });
  await w.tick();
  const paths = () => Object.keys(w.cf.deployed || {}).filter((p) => p.startsWith('/q/')).sort();
  ok('buzz files: a finished round\'s file is on qb-td-live under the tournament\'s slug',
    JSON.stringify(paths()) === JSON.stringify([`/q/tour-${a}/1-${h1}.bin`]) && w.cf.deployed[`/q/tour-${a}/1-${h1}.bin`] === f1, paths());
  ok('buzz files: buzzpoints off ships none', !paths().some((p) => p.includes(`tour-${off}/`)));
  ok('buzz files: marked live once deployed', JSON.parse(w.row(a).buzz_pub)['1'].live === 1, w.row(a).buzz_pub);
  ok('buzz files: they last a year (named by hash)', w.cf.metadata.assets.config._headers.includes('/q/*\n  Cache-Control: public, max-age=31536000, immutable'));

  // a second round: only it is uploaded; the first rides by hash
  setPub(a, { 1: { h: h1, s: f1.length, live: 1 }, 2: { h: h2, s: f2.length, live: 0 } });
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('Renamed', a);
  w.cf.uploads.length = 0;
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env);
  ok('buzz files: a new round is uploaded, the deployed one rides by hash',
    JSON.stringify(paths()) === JSON.stringify([`/q/tour-${a}/1-${h1}.bin`, `/q/tour-${a}/2-${h2}.bin`].sort())
    && w.cf.uploads.flat().includes(h2) && !w.cf.uploads.flat().includes(h1), { paths: paths(), uploads: w.cf.uploads });
  ok('buzz files: both marked live', Object.values(JSON.parse(w.row(a).buzz_pub)).every((e) => e.live === 1));

  // Cloudflare lost them (the Worker recreated): read from R2 and sent again
  for (const h of [h1, h2]) delete w.cf.store[h];
  w.DB.raw.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run('Renamed again', a);
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env);
  ok('buzz files: lost ones are sent again', w.cf.deployed[`/q/tour-${a}/1-${h1}.bin`] === f1 && w.cf.deployed[`/q/tour-${a}/2-${h2}.bin`] === f2, paths());

  // buzzpoints switched off: the files leave qb-td-live
  w.DB.raw.prepare('UPDATE tournaments SET settings = ?, name = ? WHERE id = ?').run('{}', 'Off now', a);
  await LivePublish.fetch(new Request('https://live/?ids=' + a), w.env);
  ok('buzz files: buzzpoints off takes them down', paths().length === 0, paths());
}

Date.now = realNow;
print(passed + ' tests passed');
