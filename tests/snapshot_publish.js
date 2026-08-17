// snapshot_publish.js — unit tests for the Worker's GitHub public-snapshot
// publisher ("public snapshots on GitHub" in worker/worker.js), with D1,
// R2, and the GitHub API all mocked. No wrangler, no network:
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
      if (/SELECT id FROM files WHERE/.test(sql)) {
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
    uploaded: new Date(uploadedMs),
  };
}

function fakeR2(objects) {
  return { get: async (key) => objects[key] || null };
}

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

// 1. Fresh publish into an empty repo: bundle + schedule land in ONE
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
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1 }, { id: 7, tournament_id: 1 }] };
  const objects = {
    't/1/combined.json': r2obj('{"entries":[{"id":3}]}', 1000),
    't/1/schedule.json': r2obj('{"v":1,"rooms":[],"phases":[]}', 2000),
  };
  await runCron(env(state, objects, gh));
  const snap = JSON.parse(t.pub_snapshot);
  ok('fresh publish: one commit, ref advanced once',
    gh.refUpdates === 1 && snap.sha === 'commit-1' && gh.branchSha === 'commit-1');
  ok('fresh publish: version stamp mirrors pubState', snap.version === '7:2');
  ok('fresh publish: schedule stamp is the R2 upload time', snap.schedule === 2000);
  ok('fresh publish: bundle flagged, cats/roster absent',
    snap.bundle === true && snap.cats === null && snap.roster === false);
  ok('fresh publish: descriptor carries no branch or state fields',
    snap.branch === undefined && snap.state === undefined);
  const paths = gh.trees[0].tree.map((e) => e.path).sort();
  ok('fresh publish: blob tree holds exactly bundle + schedule',
    JSON.stringify(paths) === JSON.stringify(['stanford-open/bundle.json', 'stanford-open/schedule.json']));
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
    pub_snapshot: JSON.stringify({ sha: 'head-0', version: '7:2', schedule: 2000, cats: null, roster: false, bundle: true }),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1 }, { id: 7, tournament_id: 1 }] };
  const objects = { 't/1/combined.json': r2obj('{"entries":[]}', 1000) };
  await runCron(env(state, objects, gh));
  const del = gh.trees[0].tree.find((e) => e.path === 'stanford-open/schedule.json');
  ok('deletion: schedule removed from the tree', del && del.sha === null);
  ok('deletion: new descriptor has no schedule', JSON.parse(t.pub_snapshot).schedule === null);
  ok('deletion: commit parented on the old head', gh.commits[0].parents[0] === 'head-0');
}

// 3. Oversize bundle: skipped (bundle: false) while the rest publishes —
// the page then Worker-falls-back for the bundle only.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'big-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: 't/1/roster.qbj' };
  const state = { tournaments: [t], files: [] };
  const objects = {
    't/1/combined.json': r2obj('x'.repeat(13 * 1024 * 1024), 1000),
    't/1/roster.qbj': r2obj('{"objects":[]}', 500),
  };
  await runCron(env(state, objects, gh));
  const snap = JSON.parse(t.pub_snapshot);
  ok('oversize: bundle skipped but roster published',
    snap.bundle === false && snap.roster === true
    && gh.trees[0].tree.every((e) => e.path !== 'big-open/bundle.json'));
}

// 4. GitHub down: dirty restored so the next tick retries. Needs a blob
// worth committing — with nothing to publish the cron makes no call at
// all and there is no failure to survive.
{
  globalThis.fetch = async () => { throw new Error('github unreachable'); };
  const t = { id: 1, slug: 'x-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1 }] };
  await runCron(env(state, { 't/1/combined.json': r2obj('{"entries":[]}', 1000) }, null));
  ok('failure: dirty flag restored', t.pub_dirty === 1);
  ok('failure: no snapshot recorded', t.pub_snapshot === null);
}

// 5. Non-fast-forward ref update: retried once from a fresh head.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  gh.failNextRefUpdate = true;
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'retry-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1 }] };
  const objects = { 't/1/combined.json': r2obj('{"entries":[]}', 1000) };
  await runCron(env(state, objects, gh));
  ok('ref conflict: retried from a fresh head and landed',
    gh.refUpdates === 1 && JSON.parse(t.pub_snapshot).sha === 'commit-2');
}

// 6. Feature off (no SNAPSHOT_REPO): the cron must not even touch D1.
{
  globalThis.fetch = async () => { throw new Error('no calls expected'); };
  const db = { prepare: () => { throw new Error('D1 touched with snapshots disabled'); } };
  await runCron({ DB: db, DATA: fakeR2({}), SNAPSHOT_REPO: '' });
  ok('disabled: cron is a no-op', true);
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
      sha: 'head-0', version: '7:2', schedule: 2000, cats: null, roster: false,
      bundle: true,
    }),
  };
  const state = { tournaments: [t], files: [] };
  await runCron(env(state, {}, gh));
  const paths = gh.trees[0].tree.map((e) => e.path).sort();
  ok('retract: deletes bundle + schedule, nothing else',
    JSON.stringify(paths) === JSON.stringify(
      ['gone-open/bundle.json', 'gone-open/schedule.json'])
    && gh.trees[0].tree.every((e) => e.sha === null));
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
  const state = { tournaments: [t], files: [{ id: 1, tournament_id: 1 }] };
  const objects = { 't/1/combined.json': r2obj('{"entries":[]}', 1000) };
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
      sha: 'head-0', version: '3:1', schedule: null, cats: null, roster: false,
      bundle: true,
    }),
    announce: JSON.stringify([
      { id: 'b1', text: 'finals in room A', level: 'alert', created: now, expires: now + 3600_000, pub: true },
    ]),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1 }] };
  const objects = { 't/1/combined.json': r2obj('{"entries":[{"id":3}]}', 1000) };
  await runCron(env(state, objects, gh));
  ok('live-only republish: nothing committed, descriptor keeps the old sha',
    gh.commits.length === 0 && gh.trees.length === 0
    && JSON.parse(t.pub_snapshot).sha === 'head-0');
  ok('live-only republish: no GitHub calls at all', gh.apiCalls === 0);
  ok('live-only republish: dirty cleared', t.pub_dirty === 0);
}

// 10. One blob moved (a game landed), the rest unchanged: only the
// bundle is re-uploaded; schedule rides forward via base_tree and the
// new descriptor still records it.
{
  const gh = fakeGithub();
  gh.branchSha = 'head-0';
  globalThis.fetch = gh.fetch;
  const t = {
    id: 1, slug: 'stanford-open', published: 1, pub_dirty: 1, roster_r2_key: null,
    created: Date.now(),
    pub_snapshot: JSON.stringify({
      sha: 'head-0', version: '3:1', schedule: 2000, cats: null, roster: false,
      bundle: true, branch: 'main', state: true,
    }),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1 }, { id: 9, tournament_id: 1 }] };
  const objects = {
    't/1/combined.json': r2obj('{"entries":[{"id":3},{"id":9}]}', 3000),
    't/1/schedule.json': r2obj('{"v":1,"rooms":[],"phases":[]}', 2000),
  };
  await runCron(env(state, objects, gh));
  ok('partial republish: blob commit carries only the bundle',
    gh.trees[0].tree.map((e) => e.path).join() === 'stanford-open/bundle.json');
  const snap = JSON.parse(t.pub_snapshot);
  ok('partial republish: descriptor advances and still records the schedule',
    snap.sha === 'commit-1' && snap.version === '9:2' && snap.schedule === 2000);
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
      sha: 'head-0', version: '3:1', schedule: null, cats: null, roster: true, roster_at: 500,
      bundle: true, branch: 'main', state: true,
    }),
  };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1 }] };
  const objects = {
    't/1/combined.json': r2obj('{"entries":[{"id":3}]}', 1000),
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
    files: [{ id: 1, tournament_id: 1 }, { id: 2, tournament_id: 2 }, { id: 3, tournament_id: 3 }],
  };
  const objects = {
    't/1/combined.json': r2obj('{"entries":[{"id":1}]}', 1000),
    't/2/combined.json': r2obj('{"entries":[{"id":2}]}', 1000),
    't/3/combined.json': r2obj('{"entries":[{"id":3}]}', 1000),
  };
  await runCron(env(state, objects, gh));
  ok('batch: one commit for three tournaments', gh.commits.length === 1);
  ok('batch: blob commit carries all three bundles',
    JSON.stringify(gh.trees[0].tree.map((e) => e.path).sort())
    === JSON.stringify(['t1/bundle.json', 't2/bundle.json', 't3/bundle.json']));
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
        pub_snapshot: JSON.stringify({ sha: 'head-0', version: '1:1', schedule: null, cats: null, roster: false, bundle: true }) },
    ],
    files: [{ id: 1, tournament_id: 1 }],
  };
  const objects = { 't/1/combined.json': r2obj('{"entries":[{"id":1}]}', 1000) };
  await runCron(env(state, objects, gh));
  ok('mixed tick: one batch adds alive and deletes dead',
    gh.commits.length === 1
    && JSON.stringify(gh.trees[0].tree.map((e) => e.path).sort())
    === JSON.stringify(['alive/bundle.json', 'dead/bundle.json'])
    && gh.commits[0].message === 'publish alive; unpublish dead');
  ok('mixed tick: descriptors settle right',
    JSON.parse(state.tournaments[0].pub_snapshot).sha === 'commit-1'
    && state.tournaments[1].pub_snapshot === null);
}

globalThis.fetch = realFetch;
console.log(passed + ' tests passed');
