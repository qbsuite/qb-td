// upload_prune.mjs — room uploads are stored compressed, and cleared once
// links close (worker.js pruneUploads), in process (tests/inproc_worker.mjs).
//
// What it pins down: an upload is gzipped before it is encrypted and every
// download gives it back as sent; at close the hourly cron deletes only
// the uploads a newer one from the same room, round and two teams
// replaced (never a room's second game, never another room's copy); a
// week later it deletes the rest; the rows, the public copies and so the
// public page stay exactly as they were; a set's mirror keeps its newest
// uploads while the set's link lasts, and its editors' file list drops
// the ones that are gone; a tournament is looked at once per step.
// Run: node tests/upload_prune.mjs (part of npm test).

import { workerHarness } from './inproc_worker.mjs';

const { default: fixture } = await import('../app/demo/fixture.js');
const w = await workerHarness();
const { call, sql, keys, rawObj, tick } = w;
let failures = 0;
let passed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + label); return; }
  failures++;
  console.error('FAIL ' + label + (detail !== undefined ? '\n    ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const enc = encodeURIComponent;
const HOUR = '0 * * * *';
const DAY = 24 * 3600 * 1000;

// a demo game with its two teams renamed: a different match per pair
const base = fixture.entries.find((e) => e.round === 1).qbj;
function match(a, b, round) {
  const m = structuredClone(base);
  m.match_teams[0].team.name = a;
  m.match_teams[1].team.name = b;
  return { ...m, _round: round };
}
// a reader upload: the match plus a game state carrying a packet's worth of text
const packetish = { tossups: Array.from({ length: 20 }, (_, i) => ({ question: 'Question text '.repeat(40) + i, answer: 'Answer ' + i })) };
const upload = (room, round, a, b) => call(
  `/b/${room}/upload?round=${round}&name=${enc(`Round_${round}_${a}_${b}.qbtd.json`)}`,
  { method: 'POST', body: JSON.stringify({ qbj: match(a, b, round), game: { game: { packet: packetish, cycles: [] } } }) });

/* ---------- a published tournament, two rooms ---------- */

const T = (await call('/api/tournaments', { method: 'POST', json: { name: 'Prune', slug: 'prune' } })).body;
const A = '/a/' + T.admin_secret;
const tid = T.id;
const rooms = [];
for (const n of ['Room 1', 'Room 2']) rooms.push((await call(A + '/buckets', { method: 'POST', json: { room_name: n } })).body.secret);
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: true } });

const sent = [];
for (const [room, round, a, b] of [
  [0, 1, 'Alpha', 'Beta'],   // replaced by the next
  [0, 1, 'Beta', 'Alpha'],   // its correction (team order doesn't matter)
  [0, 1, 'Gamma', 'Delta'],  // the room's second game that round
  [1, 1, 'Alpha', 'Beta'],   // another room's copy of the first
  [1, 2, 'Gamma', 'Alpha'],  // round 2, once
  [1, 2, 'Gamma', 'Alpha'],  // and again
]) {
  const r = await upload(rooms[room], round, a, b);
  sent.push(r.body && r.body.id);
}
const fileRows = () => sql('SELECT id, r2_key, gone FROM files WHERE tournament_id = ? ORDER BY id', tid);
const rows = fileRows();
ok('six uploads stored', rows.length === 6 && rows.every((f) => rawObj(f.r2_key)), rows.length);

/* ---------- compressed, and given back as sent ---------- */

const first = rawObj(rows[0].r2_key);
const size0 = sql('SELECT size FROM files WHERE id = ?', rows[0].id)[0].size;
ok('an upload is stored gzipped and encrypted', first.custom.gz === '1' && first.custom.enc === '1', first.custom);
ok('at well under its size', first.bytes.length < size0 / 2, { stored: first.bytes.length, size: size0 });
let r = await call(`${A}/file?key=${enc(rows[0].r2_key)}`);
ok('the hub\'s download is the file as uploaded', r.status === 200 && r.body && r.body.qbj && r.body.game.game.packet.tossups.length === 20, r.status);
r = await call(`${A}/file?key=${enc(rows[0].r2_key)}&part=qbj`);
ok('and its qbj half comes out of it', r.status === 200 && r.body && Array.isArray(r.body.match_teams), r.status);
r = await call(`${A}/uploads?ids=${rows.map((f) => f.id).join(',')}`);
ok('the hub\'s batch read gets every upload', r.status === 200 && rows.every((f) => r.text.includes(`"id":${f.id}`)), r.status);

/* ---------- open: nothing is cleared ---------- */

await tick();
// the public page: its file list, both rounds' games, each game's qbj
async function publicPage() {
  const state = (await call('/pub/prune')).body || {};
  const rounds = (await call('/pub/prune/rounds?n=1,2')).text;
  const qbjs = [];
  for (const f of rows) qbjs.push((await call(`/pub/prune/qbj/${f.id}`)).text);
  return { files: state.files, rounds, qbjs };
}
const pubBefore = await publicPage();
ok('the public page has the six games on it', pubBefore.files && pubBefore.files.length === 6
  && pubBefore.qbjs.every((q) => JSON.parse(q).match_teams) && /Gamma/.test(pubBefore.rounds), pubBefore.files);
await tick(HOUR);
ok('while links are open the hourly cron clears nothing', fileRows().every((f) => !f.gone && rawObj(f.r2_key)));

/* ---------- at close: only the replaced uploads ---------- */

const closeAt = (agoMs) => sql('UPDATE tournaments SET started = ? WHERE id = ?', Date.now() - 72 * 3600 * 1000 - agoMs, tid);
closeAt(1000);
await tick(HOUR);
let now = fileRows();
const goneIds = now.filter((f) => f.gone).map((f) => f.id);
ok('at close: the replaced upload in each room, round and pair goes, nothing else',
  JSON.stringify(goneIds) === JSON.stringify([rows[0].id, rows[4].id]), goneIds);
ok('its blob is deleted, the others are kept', now.every((f) => !!rawObj(f.r2_key) === !f.gone));
ok('every row stays', now.length === 6);
ok('the tournament is marked as at the first step', sql('SELECT uploads_pruned FROM tournaments WHERE id = ?', tid)[0].uploads_pruned === 1);
await tick();
ok('the public page is unchanged', JSON.stringify(await publicPage()) === JSON.stringify(pubBefore));
const { ops } = await w.measured(() => tick(HOUR));
ok('the next hour does not look at it again', !ops.some((l) => /FROM files WHERE tournament_id = \? AND gone IS NULL/.test(l)), ops.filter((l) => /files/.test(l)));

/* ---------- a week after close: the rest ---------- */

closeAt(7 * DAY + 1000);
await tick(HOUR);
now = fileRows();
ok('a week after close every upload is gone', now.every((f) => f.gone && !rawObj(f.r2_key)), now);
ok('and no other blob under the tournament went with them',
  keys().some((k) => k.startsWith(`t/${tid}/pub/`)) && keys().some((k) => k.startsWith(`t/${tid}/round/`)));
ok('every row still stays', now.length === 6);
ok('the tournament is marked as done', sql('SELECT uploads_pruned FROM tournaments WHERE id = ?', tid)[0].uploads_pruned === 2);
await tick();
ok('the public page is still unchanged', JSON.stringify(await publicPage()) === JSON.stringify(pubBefore));

/* ---------- a set's mirror keeps its newest while the set lasts ---------- */

const set = (await call('/api/sets', { method: 'POST', json: { name: 'Prune Set', slug: 'prune-set' } })).body;
const S = '/s/' + set.admin_secret;
const inv = (await call(S + '/mirrors', { method: 'POST', json: { name: 'Mirror' } })).body;
const M = (await call('/i/' + inv.invite, { method: 'POST', json: { name: 'Mirror', slug: 'prune-mirror' } })).body;
const MA = '/a/' + M.admin_secret;
const mroom = (await call(MA + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } })).body.secret;
await call(MA + '/start', { method: 'POST' });
await upload(mroom, 1, 'Alpha', 'Beta');
await upload(mroom, 1, 'Alpha', 'Beta');
const mid = M.id || sql("SELECT id FROM tournaments WHERE slug = 'prune-mirror'")[0].id;
const sid = sql('SELECT set_id FROM tournaments WHERE id = ?', mid)[0].set_id;
const editorList = async () => ((await call(`${S}/files?m=${mid}`)).body || {}).files || [];
ok('the set\'s editors list both of the mirror\'s uploads', (await editorList()).length === 2);
sql('UPDATE tournaments SET started = ? WHERE id = ?', Date.now() - 72 * 3600 * 1000 - 8 * DAY, mid);
await tick(HOUR);
const mrows = () => sql('SELECT id, r2_key, gone FROM files WHERE tournament_id = ? ORDER BY id', mid);
let mr = mrows();
ok('a mirror closed a week ago, its set still live: only the replaced upload goes',
  mr[0].gone === 1 && !mr[1].gone && !!rawObj(mr[1].r2_key), mr);
await tick(HOUR);
ok('and the newest stays, hour after hour', !mrows()[1].gone);
const listed = await editorList();
ok('the editors\' list drops the one that is gone', listed.length === 1 && listed[0].id === mr[1].id, listed.map((f) => f.id));
r = await call(`${S}/gamefile?m=${mid}&id=${mr[1].id}&part=qbj`);
ok('and the kept one still downloads, compressed or not', r.status === 200 && Array.isArray(r.body && r.body.match_teams), r.status);
sql('UPDATE sets SET created = ? WHERE id = ?', Date.now() - 366 * DAY, sid);
await tick(HOUR);
mr = mrows();
ok('once the set\'s link has expired, the rest goes too', mr.every((f) => f.gone && !rawObj(f.r2_key)), mr);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
