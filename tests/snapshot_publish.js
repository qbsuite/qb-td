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
        return { results: state.tournaments.filter((t) => t.pub_dirty && t.published) };
      }
      if (/SELECT id FROM files/.test(sql)) {
        return { results: state.files.filter((f) => f.tournament_id === args[0]) };
      }
      throw new Error('unexpected all(): ' + sql);
    },
    async run() {
      const t = state.tournaments.find((x) => x.id === args[0]);
      if (/SET pub_dirty = 1/.test(sql)) { t.pub_dirty = 1; return; }
      if (/SET pub_dirty = 0/.test(sql)) { t.pub_dirty = 0; return; }
      if (/SET pub_snapshot = \?2/.test(sql)) { t.pub_snapshot = args[1]; return; }
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
    failNextRefUpdate: false, refUpdates: 0,
  };
  gh.fetch = async (url, opts = {}) => {
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

// 1. Fresh publish into an empty repo: bundle + schedule land, ref is
// created, descriptor mirrors pubState's stamps, dirty clears.
{
  const gh = fakeGithub();
  globalThis.fetch = gh.fetch;
  const t = { id: 1, slug: 'stanford-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [{ id: 3, tournament_id: 1 }, { id: 7, tournament_id: 1 }] };
  const objects = {
    't/1/combined.json': r2obj('{"entries":[{"id":3}]}', 1000),
    't/1/schedule.json': r2obj('{"v":1,"rooms":[],"phases":[]}', 2000),
  };
  await runCron(env(state, objects, gh));
  const snap = JSON.parse(t.pub_snapshot);
  ok('fresh publish: commit made and ref created', gh.refUpdates === 1 && snap.sha === 'commit-1');
  ok('fresh publish: version stamp mirrors pubState', snap.version === '7:2');
  ok('fresh publish: schedule stamp is the R2 upload time', snap.schedule === 2000);
  ok('fresh publish: bundle flagged, cats/roster absent',
    snap.bundle === true && snap.cats === null && snap.roster === false);
  const paths = gh.trees[0].tree.map((e) => e.path).sort();
  ok('fresh publish: tree holds exactly bundle + schedule',
    JSON.stringify(paths) === JSON.stringify(['stanford-open/bundle.json', 'stanford-open/schedule.json']));
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

// 4. GitHub down: dirty restored so the next tick retries.
{
  globalThis.fetch = async () => { throw new Error('github unreachable'); };
  const t = { id: 1, slug: 'x-open', published: 1, pub_dirty: 1, pub_snapshot: null, roster_r2_key: null };
  const state = { tournaments: [t], files: [] };
  await runCron(env(state, {}, null));
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
  ok('ref conflict: second attempt landed', gh.refUpdates === 1 && JSON.parse(t.pub_snapshot).sha === 'commit-2');
}

// 6. Feature off (no SNAPSHOT_REPO): the cron must not even touch D1.
{
  globalThis.fetch = async () => { throw new Error('no calls expected'); };
  const db = { prepare: () => { throw new Error('D1 touched with snapshots disabled'); } };
  await runCron({ DB: db, DATA: fakeR2({}), SNAPSHOT_REPO: '' });
  ok('disabled: cron is a no-op', true);
}

globalThis.fetch = realFetch;
console.log(passed + ' tests passed');
