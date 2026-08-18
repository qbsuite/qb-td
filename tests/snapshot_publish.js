// snapshot_publish.js — unit tests for the Worker's cron tick: the round
// shards it materializes and the GitHub public-snapshot publisher
// ("public snapshots on GitHub" in worker/worker.js), with D1, R2, and
// the GitHub API all mocked. No wrangler, no network:
//   node tests/snapshot_publish.js

import worker from '../worker/worker.js';

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); }
  else { console.error('FAIL', name, extra ?? ''); process.exitCode = 1; }
}

/* ---------- mocks ---------- */

function fakeDb(state) {
  // Pattern-matches the publisher's statements (bound or not); anything
  // else explodes so a new query can't silently no-op in tests.
  const make = (sql, args) => ({
    async all() {
      if (/SELECT \* FROM tournaments WHERE pub_dirty = 1/.test(sql)) {
        return { results: state.tournaments.filter((t) => t.pub_dirty && (t.published || t.pub_snapshot)) };
      }
      if (/SELECT id, round FROM files WHERE/.test(sql)) {
        return { results: state.files.filter((f) => f.tournament_id === args[0]) };
      }
      // pubStateBody's queries — still reachable through the /pub route
      if (/SELECT id, bucket_id, round, filename FROM files/.test(sql)) {
        return {
          results: state.files.filter((f) => f.tournament_id === args[0]).map((f) => ({
            id: f.id, bucket_id: f.bucket_id ?? null, round: f.round ?? 1,
            filename: f.filename ?? 'r' + (f.round ?? 1) + '.qbj',
          })),
        };
      }
      if (/SELECT id, room_name FROM buckets/.test(sql)) {
        return { results: (state.buckets || []).filter((b) => b.tournament_id === args[0]) };
      }
      if (/SELECT number FROM rounds/.test(sql)) {
        return { results: (state.rounds || []).filter((r) => r.tournament_id === args[0] && r.number <= args[1]) };
      }
      throw new Error('unexpected all(): ' + sql);
    },
    async run() {
      const t = state.tournaments.find((x) => x.id === args[0]);
      if (/SET pub_dirty = 1/.test(sql)) { t.pub_dirty = 1; return; }
      if (/SET pub_dirty = 0/.test(sql)) { t.pub_dirty = 0; return; }
      if (/SET pub_snapshot = \?2/.test(sql)) { t.pub_snapshot = args[1]; return; }
      if (/SET pub_snapshot = NULL/.test(sql)) { t.pub_snapshot = null; return; }
      throw new Error('unexpected run(): ' + sql);
    },
  });
  return { prepare: (sql) => ({ ...make(sql, []), bind: (...args) => make(sql, args) }) };
}

function r2obj(text, uploadedMs) {
  const buf = new TextEncoder().encode(text).buffer;
  return {
    arrayBuffer: async () => buf,
    json: async () => JSON.parse(text),
    textFor: () => text,
    uploaded: new Date(uploadedMs),
  };
}

// The cron writes as well as reads now (shards + their manifest), so the
// fake keeps what it wrote and hands it back — assertions read the shards
// straight out of it.
function fakeR2(objects) {
  return {
    get: async (key) => objects[key] || null,
    head: async (key) => (objects[key] ? { key } : null),
    put: async (key, body) => { objects[key] = r2obj(String(body), Date.now()); },
    delete: async (key) => { delete objects[key]; },
  };
}

// The public copy of one game, as bucketUpload writes it.
const pubGame = (id, round) => r2obj(JSON.stringify(
  { id, round, room: 'Room 1', filename: 'r' + round + '.qbj', qbj: { tossups_read: 20 } }), 1000);

const shardOf = (objects, tid, n) => JSON.parse(objects['t/' + tid + '/round/' + n + '.json'].textFor());

// Minimal GitHub Git Data API: refs, commit lookup, blob/tree/commit
// creation, ref update. Records trees + commits for assertions.
function fakeGithub() {
  const gh = {
    branchSha: null, trees: [], commits: [], blobs: [],
    failNextRefUpdate: false, failRefUpdateFrom: null, refUpdates: 0, apiCalls: 0,
  };
  gh.fetch = async (url, opts = {}) => {
    gh.apiCalls++;
    const u = String(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const reply = (status, data) => ({
      ok: status < 400, status,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.includes('/git/ref/heads/')) {
      return gh.branchSha ? reply(200, { object: { sha: gh.branchSha } }) : reply(404, {});
    }
    if (u.includes('/git/commits/') && method === 'GET') {
      return reply(200, { tree: { sha: 'tree-of-' + gh.branchSha } });
    }
    if (u.endsWith('/git/blobs')) {
      gh.blobs.push(body);
      return reply(201, { sha: 'blob-' + gh.blobs.length });
    }
    if (u.endsWith('/git/trees')) {
      gh.trees.push(body);
      return reply(201, { sha: 'tree-' + gh.trees.length });
    }
    if (u.endsWith('/git/commits')) {
      gh.commits.push(body);
      return reply(201, { sha: 'commit-' + gh.commits.length });
    }
    if (u.includes('/git/refs')) { // PATCH heads/<branch> or POST refs
      if (gh.failNextRefUpdate) { gh.failNextRefUpdate = false; return reply(422, { message: 'not ff' }); }
      if (gh.failRefUpdateFrom !== null && gh.refUpdates >= gh.failRefUpdateFrom) {
        return reply(422, { message: 'not ff' });
      }
      gh.refUpdates++;
      gh.branchSha = body.sha;
      return reply(200, {});
    }
    throw new Error('unexpected github call: ' + method + ' ' + u);
  };
  return gh;
}

function env(state, objects, gh, extra = {}) {
  return {
    DB: fakeDb(state),
    DATA: fakeR2(objects),
    SNAPSHOT_REPO: 'qbsuite/qb-td-live',
    SNAPSHOT_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
    ...extra,
  };
}

async function runCron(e) {
  const promises = [];
  await worker.scheduled({}, e, { waitUntil: (p) => promises.push(p) });
  await Promise.all(promises);
}

/* ---------- scenarios ---------- */

const realFetch = globalThis.fetch;

// 1. Fresh publish into an empty repo: the tick materializes a shard per
// round from the per-game blobs, and those plus the schedule land in ONE
// commit, the ref advances once, the descriptor mirrors pubState's
// stamps, dirty clears. Only blobs are published — viewers read the
// tournament state from /pub/:slug, so nothing state-shaped is committed.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const now = Date.now();
  const t = {
    id: 1, slug: 'stanford-open', name: 'Stanford Open', published: 1, pub_dirty: 1,
    pub_snapshot: null, roster_r2_key: null, current_round: 4, created: now,
    announce: JSON.stringify([
      { id: 'a1', text: 'lunch moved', level: 'info', created: now, expires: now + 3600_000, pub: true },
      { id: 'a2', text: 'gone', level: 'info', created: now - 10, expires: now - 1, pub: true },
      { id: 'a3', text: 'rooms only', level: 'info', created: now, expires: now + 3600_000, rooms: true },
    ]),
  };
  const state = {
    tournaments: [t],
    files: [{ id: 3, tournament_id: 1, round: 1 }, { id: 7, tournament_id: 1, round: 2 }],
  };
  const objects = {
    't/1/pub/3.json': pubGame(3, 1),
    't/1/pub/7.json': pubGame(7, 2),
    't/1/schedule.json': r2obj('{"v":1,"rooms":[],"phases":[]}', 2000),
  };
  await runCron(env(state, objects, gh));
  const snap = JSON.parse(t.pub_snapshot);
  ok('fresh publish: one commit, ref advanced once',
    gh.refUpdates === 1 && snap.sha === 'commit-1' && gh.branchSha === 'commit-1');
  ok('fresh publish: a shard per round, each holding its own game',
    shardOf(objects, 1, 1).entries.length === 1 && shardOf(objects, 1, 1).entries[0].id === 3
    && shardOf(objects, 1, 2).entries[0].id === 7);
  ok('fresh publish: round stamps mirror pubState',
    JSON.stringify(snap.rounds) === JSON.stringify({ 1: '3:1', 2: '7:1' }), snap.rounds);
  ok('fresh publish: manifest records the same stamps',
    JSON.stringify(JSON.parse(objects['t/1/rounds.json'].textFor()).rounds)
    === JSON.stringify({ 1: '3:1', 2: '7:1' }));
  ok('fresh publish: schedule stamp is the R2 upload time', snap.schedule === 2000);
  ok('fresh publish: cats/roster absent', snap.cats === null && snap.roster === false);
  ok('fresh publish: descriptor carries no branch or state fields',
    snap.branch === undefined && snap.state === undefined);
  const paths = gh.trees[0].tree.map((e) => e.path).sort();
  ok('fresh publish: blob tree holds exactly the two shards + schedule',
    JSON.stringify(paths) === JSON.stringify(
      ['stanford-open/r1.json', 'stanford-open/r2.json', 'stanford-open/schedule.json']), paths);
  ok('fresh publish: exactly one commit and one tree, no state.json anywhere',
    gh.commits.length === 1 && gh.trees.length === 1
    && !JSON.stringify(gh.trees).includes('state.json'));
  ok('fresh publish: dirty cleared', t.pub_dirty === 0);
}

// 2. Republish after the schedule was deleted: the tree carries a
// deletion entry (sha: null) because the previous descriptor had it.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const t = {
    id: 1, slug: 'stanford-open', published: 1, pub_dirty: 1, roster_r2_key: null,
    pub_snapshot: JSON.stringify({ sha: 'head-0', rounds: { 1: '3:1' }, schedule: 2000, cats: null, roster: false }),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1, round: 1 }] };
  const objects = {
    't/1/pub/3.json': pubGame(3, 1),
    't/1/rounds.json': r2obj('{"rounds":{"1":"3:1"}}', 1000),
  };
  await runCron(env(state, objects, gh));
  const del = gh.trees[0].tree.find((e) => e.path === 'stanford-open/schedule.json');
  ok('deletion: schedule removed from the tree', del && del.sha === null);
  ok('deletion: the unchanged round shard is not re-uploaded',
    gh.trees[0].tree.every((e) => e.path !== 'stanford-open/r1.json'));
  ok('deletion: new descriptor has no schedule', JSON.parse(t.pub_snapshot).schedule === null);
  ok('deletion: commit parented on the old head', gh.commits[0].parents[0] === 'head-0');
}

// 3. Oversize round shard: that round is left off the branch (the page
// Worker-falls-back for it alone) while everything else publishes. One
// round has to be enormous for this now, where the whole tournament used
// to share the one cap.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'big-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: 't/1/roster.qbj' };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1, round: 1 }] };
  const objects = {
    't/1/pub/1.json': r2obj(JSON.stringify(
      { id: 1, round: 1, room: 'A', filename: 'r1.qbj', qbj: { pad: 'x'.repeat(13 * 1024 * 1024) } }), 1000),
    't/1/roster.qbj': r2obj('{"objects":[]}', 500),
  };
  await runCron(env(state, objects, gh));
  const snap = JSON.parse(t.pub_snapshot);
  ok('oversize: round left off the branch but roster published',
    snap.rounds['1'] === undefined && snap.roster === true
    && gh.trees[0].tree.every((e) => e.path !== 'big-open/r1.json'), snap.rounds);
  ok('oversize: the shard itself is still materialized for the Worker route',
    shardOf(objects, 1, 1).entries.length === 1);
}

// 4. GitHub down: dirty restored so the next tick retries. Needs a blob
// worth committing — with nothing to publish the cron makes no call at
// all and there is no failure to survive.
{
  globalThis.fetch = async () => { throw new Error('github unreachable'); };
  const t = { id: 1, slug: 'x-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1, round: 1 }] };
  const objects = { 't/1/pub/1.json': pubGame(1, 1) };
  await runCron(env(state, objects, null));
  ok('failure: dirty flag restored', t.pub_dirty === 1);
  ok('failure: no snapshot recorded', t.pub_snapshot === null);
  ok('failure: the shard was still materialized, so the Worker route serves it',
    shardOf(objects, 1, 1).entries.length === 1);
}

// 5. Non-fast-forward ref update: retried once from a fresh head.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  gh.failNextRefUpdate = true;
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'retry-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1, round: 1 }] };
  const objects = { 't/1/pub/1.json': pubGame(1, 1) };
  await runCron(env(state, objects, gh));
  ok('ref conflict: retried from a fresh head and landed',
    gh.refUpdates === 1 && JSON.parse(t.pub_snapshot).sha === 'commit-2');
}

// 6. Feature off (no SNAPSHOT_REPO): the shards are still built — they
// are what the public page reads — and GitHub is never called. This is
// the whole reason materializing is not part of the publisher.
{
  globalThis.fetch = async () => { throw new Error('no GitHub calls expected'); };
  const t = { id: 1, slug: 'local-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1, round: 1 }] };
  const objects = { 't/1/pub/1.json': pubGame(1, 1) };
  await runCron({ DB: fakeDb(state), DATA: fakeR2(objects), SNAPSHOT_REPO: '' });
  ok('disabled: shard still materialized', shardOf(objects, 1, 1).entries[0].id === 1);
  ok('disabled: manifest written, dirty cleared',
    JSON.parse(objects['t/1/rounds.json'].textFor()).rounds['1'] === '1:1' && t.pub_dirty === 0);
  ok('disabled: nothing published', t.pub_snapshot === null);
}

// 7. Unpublish: the cron retracts the slug's folder — deletion entries
// for exactly what the descriptor recorded — then the descriptor is
// cleared so /pub stops advertising it.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const t = {
    id: 1, slug: 'gone-open', published: 0, pub_dirty: 1, roster_r2_key: null,
    pub_snapshot: JSON.stringify({
      sha: 'head-0', rounds: { 1: '3:1', 2: '7:1' }, schedule: 2000, cats: null, roster: false,
    }),
  };
  const state = { tournaments: [t], files: [] };
  await runCron(env(state, {}, gh));
  const paths = gh.trees[0].tree.map((e) => e.path).sort();
  ok('retract: deletes every published shard + the schedule, nothing else',
    JSON.stringify(paths) === JSON.stringify(
      ['gone-open/r1.json', 'gone-open/r2.json', 'gone-open/schedule.json'])
    && gh.trees[0].tree.every((e) => e.sha === null), paths);
  ok('retract: descriptor cleared, dirty cleared',
    t.pub_snapshot === null && t.pub_dirty === 0);
  ok('retract: commit says why', gh.commits[0].message === 'unpublish gone-open');
}

// 8. The ref update fails on both attempts: nothing is recorded and the
// flag comes back, so a stored descriptor always implies the branch
// really holds those blobs.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  gh.failRefUpdateFrom = 0; // every ref update fails, retry included
  const t = { id: 1, slug: 'half-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null, created: Date.now() };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1, round: 1 }] };
  const objects = { 't/1/pub/1.json': pubGame(1, 1) };
  await runCron(env(state, objects, gh));
  ok('ref update fails twice: no descriptor, dirty restored',
    t.pub_snapshot === null && t.pub_dirty === 1);
}

// 9. Live-only change (broadcast edited, blobs untouched): nothing is
// committed at all. Broadcasts reach viewers through /pub/:slug, so a
// change no blob holds costs GitHub nothing — the descriptor keeps
// advertising the commit that already has the blobs.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const now = Date.now();
  const t = {
    id: 1, slug: 'stanford-open', name: 'Stanford Open', published: 1, pub_dirty: 1,
    roster_r2_key: null, current_round: 4, created: now,
    pub_snapshot: JSON.stringify({
      sha: 'head-0', rounds: { 1: '3:1' }, schedule: null, cats: null, roster: false,
    }),
    announce: JSON.stringify([
      { id: 'b1', text: 'finals in room A', level: 'alert', created: now, expires: now + 3600_000, pub: true },
    ]),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1, round: 1 }] };
  const objects = {
    't/1/pub/3.json': pubGame(3, 1),
    't/1/rounds.json': r2obj('{"rounds":{"1":"3:1"}}', 1000),
  };
  await runCron(env(state, objects, gh));
  ok('live-only republish: nothing committed, descriptor keeps the old sha',
    gh.commits.length === 0 && gh.trees.length === 0
    && JSON.parse(t.pub_snapshot).sha === 'head-0');
  ok('live-only republish: no GitHub calls at all', gh.apiCalls === 0);
  ok('live-only republish: dirty cleared', t.pub_dirty === 0);
}

// 10. A game landed in a new round: only that round's shard is
// uploaded. The rounds already played, and the schedule, ride forward
// via base_tree and the new descriptor still records them — this is the
// per-round layout's whole point on the publish side.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const t = {
    id: 1, slug: 'stanford-open', published: 1, pub_dirty: 1, roster_r2_key: null,
    created: Date.now(),
    pub_snapshot: JSON.stringify({
      sha: 'head-0', rounds: { 1: '3:1' }, schedule: 2000, cats: null, roster: false,
      branch: 'main', state: true,
    }),
  };
  const state = {
    tournaments: [t],
    files: [{ id: 3, tournament_id: 1, round: 1 }, { id: 9, tournament_id: 1, round: 2 }],
  };
  const objects = {
    't/1/pub/3.json': pubGame(3, 1),
    't/1/pub/9.json': pubGame(9, 2),
    't/1/rounds.json': r2obj('{"rounds":{"1":"3:1"}}', 1000),
    't/1/schedule.json': r2obj('{"v":1,"rooms":[],"phases":[]}', 2000),
  };
  await runCron(env(state, objects, gh));
  ok('partial republish: blob commit carries only the new round',
    gh.trees[0].tree.map((e) => e.path).join() === 'stanford-open/r2.json',
    gh.trees[0].tree.map((e) => e.path));
  const snap = JSON.parse(t.pub_snapshot);
  ok('partial republish: descriptor advances, keeps round 1 and the schedule',
    snap.sha === 'commit-1' && snap.rounds['1'] === '3:1' && snap.rounds['2'] === '9:1'
    && snap.schedule === 2000, snap);
}

// 11. Roster re-upload moves its stamp: the roster is re-published even
// though it was present before (roster_at is the change detector).
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const t = {
    id: 1, slug: 'stanford-open', published: 1, pub_dirty: 1, roster_r2_key: 't/1/roster.qbj',
    created: Date.now(),
    pub_snapshot: JSON.stringify({
      sha: 'head-0', rounds: { 1: '3:1' }, schedule: null, cats: null, roster: true, roster_at: 500,
      branch: 'main', state: true,
    }),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1, round: 1 }] };
  const objects = {
    't/1/pub/3.json': pubGame(3, 1),
    't/1/rounds.json': r2obj('{"rounds":{"1":"3:1"}}', 1000),
    't/1/roster.qbj': r2obj('{"objects":[]}', 4000), // re-uploaded since
  };
  await runCron(env(state, objects, gh));
  ok('roster change: re-published, stamp recorded',
    gh.trees[0].tree.map((e) => e.path).join() === 'stanford-open/roster.json'
    && JSON.parse(t.pub_snapshot).roster_at === 4000);
}

// 12. Three dirty tournaments in one tick: ONE commit total, not three —
// a single batch all of them ride in. Per-tournament descriptors all
// advertise that shared commit, and the API bill stays flat as the batch
// grows.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const now = Date.now();
  const mk = (id) => ({
    id, slug: 't' + id, name: 'T' + id, published: 1, pub_dirty: 1,
    pub_snapshot: null, roster_r2_key: null, current_round: 1, created: now,
  });
  const state = {
    tournaments: [mk(1), mk(2), mk(3)],
    files: [{ id: 1, tournament_id: 1, round: 1 }, { id: 2, tournament_id: 2, round: 1 },
      { id: 3, tournament_id: 3, round: 1 }],
  };
  const objects = {
    't/1/pub/1.json': pubGame(1, 1),
    't/2/pub/2.json': pubGame(2, 1),
    't/3/pub/3.json': pubGame(3, 1),
  };
  await runCron(env(state, objects, gh));
  ok('batch: one commit for three tournaments', gh.commits.length === 1);
  ok('batch: blob commit carries all three shards',
    JSON.stringify(gh.trees[0].tree.map((e) => e.path).sort())
    === JSON.stringify(['t1/r1.json', 't2/r1.json', 't3/r1.json']));
  ok('batch: one tree, nothing state-shaped in it',
    gh.trees.length === 1 && !JSON.stringify(gh.trees).includes('state.json'));
  ok('batch: every descriptor advertises the shared blob commit',
    state.tournaments.every((t) => JSON.parse(t.pub_snapshot).sha === 'commit-1'));
  ok('batch: message names everyone', gh.commits[0].message === 'publish t1, t2, t3');
  // GET ref + GET commit + POST tree + POST commit + PATCH ref + 3 blobs
  ok('batch: eight API calls for three tournaments', gh.apiCalls === 8);
}

// 13. Mixed tick: one publish + one retract share the single batch.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const now = Date.now();
  const state = {
    tournaments: [
      { id: 1, slug: 'alive', name: 'Alive', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null, current_round: 1, created: now },
      { id: 2, slug: 'dead', published: 0, pub_dirty: 1, roster_r2_key: null, created: now,
        pub_snapshot: JSON.stringify({ sha: 'head-0', rounds: { 1: '1:1' }, schedule: null, cats: null, roster: false }) },
    ],
    files: [{ id: 1, tournament_id: 1, round: 1 }],
  };
  const objects = { 't/1/pub/1.json': pubGame(1, 1) };
  await runCron(env(state, objects, gh));
  ok('mixed tick: one batch adds alive and deletes dead',
    gh.commits.length === 1
    && JSON.stringify(gh.trees[0].tree.map((e) => e.path).sort())
    === JSON.stringify(['alive/r1.json', 'dead/r1.json'])
    && gh.commits[0].message === 'publish alive; unpublish dead');
  ok('mixed tick: descriptors settle right',
    JSON.parse(state.tournaments[0].pub_snapshot).sha === 'commit-1'
    && state.tournaments[1].pub_snapshot === null);
}

// 14. A tournament that was mid-day when this layout shipped: its games
// exist only inside the pre-shard whole-tournament bundle, with no
// per-game blobs. The first tick seeds the blobs from it and builds the
// shards, so nothing a moderator already uploaded goes missing.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'mid-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null, created: Date.now() };
  const state = {
    tournaments: [t],
    files: [{ id: 3, tournament_id: 1, round: 1 }, { id: 7, tournament_id: 1, round: 2 }],
  };
  const objects = {
    't/1/combined.json': r2obj(JSON.stringify({ entries: [
      { id: 3, round: 1, room: 'Room 1', filename: 'r1.qbj', qbj: { tossups_read: 20 } },
      { id: 7, round: 2, room: 'Room 2', filename: 'r2.qbj', qbj: { tossups_read: 20 } },
    ] }), 1000),
  };
  await runCron(env(state, objects, gh));
  ok('migration: shards built from the old bundle',
    shardOf(objects, 1, 1).entries[0].id === 3 && shardOf(objects, 1, 2).entries[0].room === 'Room 2');
  ok('migration: per-game blobs seeded, so the old bundle is read once and never again',
    JSON.parse(objects['t/1/pub/3.json'].textFor()).id === 3
    && JSON.parse(objects['t/1/pub/7.json'].textFor()).id === 7);
  ok('migration: stamps come out as if the games had always been sharded',
    JSON.stringify(JSON.parse(t.pub_snapshot).rounds) === JSON.stringify({ 1: '3:1', 2: '7:1' }));
}

// 15. A game whose public blob is missing with nothing to seed it from:
// the shard is stamped with what it actually holds, not with what D1
// says, so the next tick tries again instead of baking the gap in.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'gap-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null, created: Date.now() };
  const state = {
    tournaments: [t],
    files: [{ id: 3, tournament_id: 1, round: 1 }, { id: 4, tournament_id: 1, round: 1 }],
  };
  const objects = { 't/1/pub/3.json': pubGame(3, 1) };
  await runCron(env(state, objects, gh));
  const manifest = JSON.parse(objects['t/1/rounds.json'].textFor());
  ok('gap: shard holds the game it could read', shardOf(objects, 1, 1).entries.length === 1);
  ok('gap: stamp reflects the shard, not the file rows', manifest.rounds['1'] === '3:1');

  // the blob turns up (or the TO rebuilds); the next tick heals the round
  objects['t/1/pub/4.json'] = pubGame(4, 1);
  t.pub_dirty = 1;
  await runCron(env(state, objects, gh));
  ok('gap: the next tick picks the missing game up',
    shardOf(objects, 1, 1).entries.length === 2
    && JSON.parse(objects['t/1/rounds.json'].textFor()).rounds['1'] === '4:2');
}

// 16. The TO's rebuild re-posts games under their existing ids, so no
// stamp moves; its marker is what makes the tick rebuild every round —
// and it is consumed, so the tick after that leaves the shards alone.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'rebuild-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null, created: Date.now() };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1, round: 1 }] };
  const objects = { 't/1/pub/3.json': pubGame(3, 1) };
  await runCron(env(state, objects, gh));
  ok('rebuild: baseline shard', shardOf(objects, 1, 1).entries[0].room === 'Room 1');

  // content changes under the same id, no marker: the round's stamp
  // matches, so the tick skips it
  objects['t/1/pub/3.json'] = r2obj(JSON.stringify(
    { id: 3, round: 1, room: 'Rebuilt', filename: 'r1.qbj', qbj: { tossups_read: 20 } }), 2000);
  t.pub_dirty = 1;
  await runCron(env(state, objects, gh));
  ok('rebuild: an unchanged stamp is not rebuilt', shardOf(objects, 1, 1).entries[0].room === 'Room 1');

  // with the marker (what putBundle writes) every round is rebuilt and
  // the marker is gone afterwards; the manifest never went away
  objects['t/1/rebuild.json'] = r2obj('{}', 3000);
  t.pub_dirty = 1;
  await runCron(env(state, objects, gh));
  ok('rebuild: the marker forces the round', shardOf(objects, 1, 1).entries[0].room === 'Rebuilt');
  ok('rebuild: marker consumed', objects['t/1/rebuild.json'] === undefined);
  ok('rebuild: stamp unchanged', JSON.parse(objects['t/1/rounds.json'].textFor()).rounds['1'] === '3:1');
}

globalThis.fetch = realFetch;
console.log(passed + ' tests passed');
