// pub_drop.mjs — the public state leaves out an upload a newer copy of the
// same game replaced when its own public copy is missing (worker.js
// replacedMissing), in process (tests/inproc_worker.mjs).
//
// What it pins down: a room that resent a game, whose first upload never
// got its public copy, no longer leaves the public page saying a game is
// "just in" forever; a game with no newer copy stays listed (a real gap);
// so does the first copy once the newer one is gone or has no copy either;
// and the rest of the public state and the TD's hub see every upload as
// before.
// Run: node tests/pub_drop.mjs (part of npm test).

import { workerHarness } from './inproc_worker.mjs';
import { replacedMissing } from '../worker/worker.js';

const { default: fixture } = await import('../app/demo/fixture.js');
const w = await workerHarness();
const { call, sql, tick, env } = w;
let failures = 0;
let passed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + label); return; }
  failures++;
  console.error('FAIL ' + label + (detail !== undefined ? '\n    ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const enc = encodeURIComponent;

/* ---------- the rule on its own ---------- */

{
  const f = (id, bucket_id = 1, round = 5, filename = 'Round_5_A_B.qbtd.json') => ({ id, bucket_id, round, filename });
  ok('rule: a missing first copy with the resent one there is left out',
    JSON.stringify(replacedMissing([f(1443), f(1444)], new Set([1443]))) === '[1443]');
  ok('rule: nothing missing, nothing left out', replacedMissing([f(1), f(2)], new Set()).length === 0);
  ok('rule: the newest copy missing is a real gap', replacedMissing([f(1), f(2)], new Set([2])).length === 0);
  ok('rule: both copies missing, both stay', replacedMissing([f(1), f(2)], new Set([1, 2])).length === 0);
  ok('rule: another room, round or file is no replacement',
    replacedMissing([f(1), f(2, 2)], new Set([1])).length === 0
      && replacedMissing([f(1), f(2, 1, 6)], new Set([1])).length === 0
      && replacedMissing([f(1), f(2, 1, 5, 'Round_5_C_D.qbtd.json')], new Set([1])).length === 0);
  ok('rule: a newer copy of the same game counts whatever comes between',
    JSON.stringify(replacedMissing([f(1), f(2, 1, 5, 'Round_5_C_D.qbtd.json'), f(3)], new Set([1]))) === '[1]');
}

/* ---------- a published tournament, one room ---------- */

const base = fixture.entries.find((e) => e.round === 1).qbj;
function match(a, b, round) {
  const m = structuredClone(base);
  m.match_teams[0].team.name = a;
  m.match_teams[1].team.name = b;
  return { ...m, _round: round };
}
const upload = async (room, round, a, b) => (await call(
  `/b/${room}/upload?round=${round}&name=${enc(`Round_${round}_${a}_${b}.qbtd.json`)}`,
  { method: 'POST', body: JSON.stringify({ qbj: match(a, b, round), game: { game: { cycles: [] } } }) })).body.id;

const T = (await call('/api/tournaments', { method: 'POST', json: { name: 'Drop', slug: 'drop-test' } })).body;
const A = '/a/' + T.admin_secret;
const tid = T.id;
const room = (await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 101' } })).body.secret;
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: true } });

const pubKey = (id) => `t/${tid}/pub/${id}.json`;
const listed = async () => (await call('/pub/drop-test')).body.files.map((f) => f.id);
const sharded = async () => (await call('/pub/drop-test/rounds?n=1,2,3,4')).body.rounds.flatMap((r) => r.entries.map((e) => e.id));
const manifest = async () => JSON.parse(w.raw(`t/${tid}/rounds.json`));
const rebuild = async () => { sql('UPDATE tournaments SET pub_dirty = 1 WHERE id = ?', tid); await tick(); };
const asc = (xs) => [...xs].sort((x, y) => x - y);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// a public copy that never landed: the upload's row is written, its copy
// is not (the request dropped in between)
const lost = async (id) => { await env.DATA.delete(pubKey(id)); };

// round 1: the room resends a game whose first upload lost its copy
const first = await upload(room, 1, 'Alpha', 'Beta');
await lost(first);
const resent = await upload(room, 1, 'Alpha', 'Beta');
const other = await upload(room, 1, 'Gamma', 'Delta');  // the room's other game that round
// round 2: a game with no newer copy, its copy lost (a real gap)
const lone = await upload(room, 2, 'Alpha', 'Gamma');
await lost(lone);
// round 3: a resent game, both copies lost
const both1 = await upload(room, 3, 'Beta', 'Delta');
const both2 = await upload(room, 3, 'Beta', 'Delta');
const both2Copy = w.raw(pubKey(both2));
await lost(both1);
await lost(both2);
// round 4: an ordinary game
const plain = await upload(room, 4, 'Gamma', 'Beta');
await tick();

ok('the shards hold only the games with a public copy',
  eq(asc(await sharded()), [resent, other, plain]), await sharded());
ok('the public state leaves out the replaced first copy and lists the rest, gaps included',
  eq(await listed(), [resent, other, lone, both1, both2, plain]), await listed());
ok('the manifest names the replaced first copy alone', eq((await manifest()).dropped, [first]), await manifest());
ok('the TD\'s hub still lists every upload',
  eq(asc((await call(A)).body.files.map((f) => f.id)), [first, resent, other, lone, both1, both2, plain]));

// what else the public state says, against a twin tournament that never lost a copy
{
  const T2 = (await call('/api/tournaments', { method: 'POST', json: { name: 'Drop', slug: 'drop-twin' } })).body;
  const A2 = '/a/' + T2.admin_secret;
  const room2 = (await call(A2 + '/buckets', { method: 'POST', json: { room_name: 'Room 101' } })).body.secret;
  await call(A2 + '/start', { method: 'POST' });
  await call(A2, { method: 'POST', json: { published: true } });
  await upload(room2, 1, 'Alpha', 'Beta');
  await upload(room2, 1, 'Alpha', 'Beta');
  await upload(room2, 1, 'Gamma', 'Delta');
  await upload(room2, 2, 'Alpha', 'Gamma');
  await upload(room2, 3, 'Beta', 'Delta');
  await upload(room2, 3, 'Beta', 'Delta');
  await upload(room2, 4, 'Gamma', 'Beta');
  await tick();
  const a = (await call('/pub/drop-test')).body;
  const b = (await call('/pub/drop-twin')).body;
  const same = ['current_round', 'live_round', 'buzz_done', 'roster', 'format', 'final'];
  ok('the rest of the public state matches a tournament that lost nothing',
    same.every((k) => eq(a[k], b[k])), same.filter((k) => !eq(a[k], b[k])).map((k) => [k, a[k], b[k]]));
}

// the lost copy of round 3's newer upload comes back (a TD's rebuild)
w.setRaw(pubKey(both2), both2Copy);
await rebuild();
ok('a newer copy back: the first of that pair is left out too',
  eq(await listed(), [resent, other, lone, both2, plain]), await listed());
ok('a newer copy back: the manifest names both replaced copies', eq((await manifest()).dropped, [first, both1]), await manifest());

// the TD deletes round 1's resent upload: the first copy is a real gap again
await call(A + '/files/' + resent, { method: 'DELETE' });
await rebuild();
ok('newer upload deleted: the first copy is listed again',
  eq(await listed(), [first, other, lone, both2, plain]), await listed());
ok('newer upload deleted: the manifest names only what is still replaced', eq((await manifest()).dropped, [both1]), await manifest());

// and once nothing is replaced, the manifest has no list at all
await call(A + '/files/' + both2, { method: 'DELETE' });
await rebuild();
ok('nothing replaced: the manifest has no dropped list', (await manifest()).dropped === undefined, await manifest());
ok('nothing replaced: every row listed', eq(await listed(), [first, other, lone, both1, plain]), await listed());

console.log(`\n${passed} pub-drop checks passed${failures ? `, ${failures} FAILED` : ''}`);
if (failures) process.exit(1);
