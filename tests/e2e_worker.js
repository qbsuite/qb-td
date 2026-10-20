// e2e_worker.js — end-to-end smoke test against a locally running Worker:
//   cd worker && npx wrangler dev --local --port 8799   (schema applied)
// then: node tests/e2e_worker.js
//
// Exercises the full TO -> moderator -> public flow. No login anywhere:
// the admin link secret (minted at creation) is the TO's credential.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buzzSettings, buzzToken } from '../app/js/buzzkey.js';
import { parseMatch } from '../app/engine/qbj.js';
import { WORKER_DIR, PERSIST, BASE, storedCred, testToken, d1row, d1exec, r2get, r2put, fetchRetry, call, maxAge, tick, ok, summary } from './e2e_lib.js';

const MATCH = JSON.stringify({
  tossups_read: 20, _round: 1,
  // protest reasons quote answers; public copies must drop notes
  notes: 'Tossup protest on tossup #3. Team "Alpha" protested because of this reason: "PROTESTLEAKANSWER".',
  match_teams: [
    { team: { name: 'Alpha' }, bonus_points: 30,
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20,
        answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: 'Beta' }, bonus_points: 0,
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20,
        answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});

// The reader's one-request start (worker.js bucketLoad) must answer each
// of its four parts exactly as that part's own route does: status, type
// and body, byte for byte — the page reads them as if it had asked each.
async function roomLoadMatches(label, sec, q = '') {
  const res = await fetchRetry(`${BASE}/b/${sec}/load${q}`);
  const got = res.status === 200 ? await res.json() : null;
  const diffs = [];
  for (const sub of ['', '/schedule', '/roster', '/tiebreakers']) {
    const one = await fetchRetry(`${BASE}/b/${sec}${sub}${q}`);
    const want = { s: one.status, t: one.headers.get('content-type') || '', b: await one.text() };
    const have = got && got[sub];
    if (!have || have.s !== want.s || have.t !== want.t || have.b !== want.b) diffs.push({ sub, have, want });
  }
  ok('room load = its four routes: ' + label, got && !diffs.length && Object.keys(got).length === 4, diffs);
}

// bad admin link is a uniform 404
let r = await call('/a/abcdefghjkmnpqrstuvw');
ok('bad admin link 404', r.status === 404);

// create tournament: open, returns the admin secret + expiry
// creation is capped per IP per day; earlier local runs must not use it up
d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slug = 'e2e-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'E2E Open', slug } });
ok('create tournament', r.status === 200 && r.body.id > 0 && r.body.admin_secret.length >= 10, r.body);
// a week of setup; the 48h only starts when the TD presses Start
ok('creation reports a week of setup',
  r.body.closes > Date.now() + (7 * 24 - 1) * 3600 * 1000 && r.body.closes < Date.now() + (7 * 24 + 1) * 3600 * 1000,
  r.body.closes);
let A = '/a/' + r.body.admin_secret;
const tid = r.body.id;

r = await call('/api/tournaments', { method: 'POST', json: { name: 'dupe', slug } });
ok('duplicate slug rejected', r.status === 409);

// 'demo' belongs to the in-browser demo tournament (app/js/demo.js)
r = await call('/api/tournaments', { method: 'POST', json: { name: 'demo', slug: 'demo' } });
ok('demo slug reserved', r.status === 409, r.body);

// detail hides the secret and echoes expiry
r = await call(A);
ok('admin detail', r.status === 200 && r.body.tournament.slug === slug, r.body);
ok('detail omits secrets', r.body.tournament.admin_secret === undefined && r.body.tournament.creator_ip === undefined);
ok('detail: no roster, no roster save time', r.body.tournament.roster_at === null, r.body.tournament.roster_at);

// bucket
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
ok('create bucket', r.status === 200 && r.body.secret.length >= 10, r.body);
const secret = r.body.secret;

// packet upload + roster
r = await call(`${A}/packet?round=1&name=Packet1.pdf`, { method: 'POST', body: 'PDFBYTES' });
ok('upload packet', r.status === 200, r.body);
const ROSTER0 = JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
  { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Ann' }] }] },
  { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] },
] }] });
r = await call(`${A}/roster?name=roster.qbj`, { method: 'POST', body: ROSTER0 });
ok('upload roster', r.status === 200, r.body);
// the detail says when the roster was saved: a hub reloads its renames
// when that moves, so another tab's rename reaches it
{
  const at = (await call(A)).body.tournament.roster_at;
  ok('detail: the roster\'s save time', Number.isInteger(at) && Math.abs(Date.now() - at) < 60000, at);
  await new Promise((res) => setTimeout(res, 20));
  r = await call(`${A}/roster?name=roster.qbj`, { method: 'POST', body: ROSTER0 });
  const again = (await call(A)).body.tournament.roster_at;
  ok('detail: saving the roster again moves it', r.status === 200 && again > at, [at, again]);
}
// Setup's roster Download (part=roster): the roster as it leaves qb-td,
// without the former names only qb-td reads; one with none, as stored
{
  const rosterUrl = (part) => `${BASE}${A}/file?key=${encodeURIComponent(`t/${tid}/roster.qbj`)}&dl=roster.qbj${part}`;
  let res = await fetch(rosterUrl('&part=roster'));
  ok('roster download: a roster with no former names comes down byte for byte',
    res.status === 200 && (await res.text()) === ROSTER0
      && res.headers.get('content-disposition').startsWith('attachment; filename="roster.qbj"'), res.status);
  const renamed = { objects: [{ type: 'Tournament', registrations: [
    { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Ann' }], _formerNames: ['Alef'] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob', _formerNames: ['Bobby'] }] }] },
  ] }] };
  await call(`${A}/roster?name=roster.qbj`, { method: 'POST', body: JSON.stringify(renamed, null, 2) });
  res = await fetch(rosterUrl('&part=roster'));
  const text = await res.text();
  const want = JSON.parse(JSON.stringify(renamed));
  delete want.objects[0].registrations[0].teams[0]._formerNames;
  delete want.objects[0].registrations[1].teams[0].players[0]._formerNames;
  ok('roster download: after a rename, the former names are left out', res.status === 200
    && !text.includes('_formerNames') && text === JSON.stringify(want, null, 2)
    && res.headers.get('content-type') === 'application/json', text);
  // the hub's own read keeps them: its renames come from there
  res = await fetch(rosterUrl(''));
  ok('roster download: the hub\'s read still has them', (await res.text()).includes('_formerNames'));
  await call(`${A}/roster?name=roster.qbj`, { method: 'POST', body: ROSTER0 });
}

// Before Start, a room link serves nothing: not the round's packet, not
// the tiebreakers, not uploads — the mod's page shows the message.
r = await call('/b/' + secret);
ok('room before Start says so', r.status === 403 && r.body.error === "Tournament hasn't started", r.body);
r = await call(`/b/${secret}/upload?round=1&name=early.qbj`, { method: 'POST', body: MATCH });
ok('room before Start takes no upload', r.status === 403, r.body);
for (const route of ['packet', 'tiebreakers', 'roster', 'schedule']) {
  const res = await fetch(`${BASE}/b/${secret}/${route}`);
  ok(`room before Start serves no ${route}`, res.status === 403, res.status);
}
await roomLoadMatches('before Start', secret);
await roomLoadMatches('a link that is no room', 'abcdefghjkmnpqrstuvwxyz');
// The TD's Test link: the room link plus the tournament's test token
// reads the room before Start — reads only, and nothing counts.
{
  let T = '?test=' + testToken(A.slice(3));
  await roomLoadMatches('a Test link before Start', secret, T);
  await roomLoadMatches('a wrong test key', secret, '?test=abcdefghjkmnpqrstuvw');
  await roomLoadMatches('the admin secret as a test key', secret, '?test=' + A.slice(3));
  r = await call('/b/' + secret + T);
  ok('test link reads the room before Start', r.status === 200 && r.body.test === true
    && r.body.packets.length === 1, r.body);
  let res = await fetch(`${BASE}/b/${secret}/packet${T}&round=1`);
  ok('test link reads the packet', res.status === 200 && (await res.text()) === 'PDFBYTES', res.status);
  res = await fetch(`${BASE}/b/${secret}/roster${T}`);
  ok('test link reads the roster', res.status === 200, res.status);
  r = await call('/b/' + secret + '?test=abcdefghjkmnpqrstuvw');
  ok('a wrong test key is the plain room link', r.status === 403, r.body);
  r = await call(`/b/${secret}/upload${T}&round=1&name=early.qbj`, { method: 'POST', body: MATCH });
  ok('test link takes no upload', r.status === 403, r.body);
  r = await call(`/b/${secret}/start${T}&round=1`, { method: 'POST' });
  ok('test link starts no round', r.status === 403, r.body);
  r = await call(A);
  ok('a test leaves no trace', !r.body.files.length && !(r.body.starts || []).length, r.body.starts);
  // the token is no credential, and the admin secret is no test key
  r = await call('/b/' + secret + '?test=' + A.slice(3));
  ok('the admin secret is not a test key', r.status === 403, r.body);
  r = await call('/a/' + testToken(A.slice(3)));
  ok('the test token is no admin link', r.status === 404, r.body);
  r = await call('/b/' + secret + '?test=' + storedCred(A.slice(3)));
  ok('nor is the stored hash a test key', r.status === 403, r.body);
  // a new admin link retires the old Test links
  r = await call(A + '/rotate', { method: 'POST' });
  ok('test link: rotate before Start', r.status === 200, r.body);
  A = '/a/' + r.body.admin_secret;
  r = await call('/b/' + secret + T);
  ok('a new admin link retires the old Test link', r.status === 403, r.body);
  T = '?test=' + testToken(A.slice(3));
  r = await call('/b/' + secret + T);
  ok('the new Test link reads the room', r.status === 200 && r.body.test === true, r.body);
}
r = await call(A);
ok('detail before Start: not started, a week of setup',
  !r.body.tournament.started && r.body.tournament.closes > Date.now() + 6 * 24 * 3600 * 1000, r.body.tournament);

// Start: every link now closes 48h from here, replacing the setup clock
r = await call(A + '/start', { method: 'POST' });
ok('start the tournament', r.status === 200 && r.body.started > 0
  && r.body.closes === r.body.started + 48 * 3600 * 1000, r.body);
const startedAt = r.body.started;
r = await call(A + '/start', { method: 'POST' });
ok('starting twice is refused', r.status === 409, r.body);
r = await call(A);
ok('detail after Start: closes 48h from Start',
  r.body.tournament.started === startedAt && r.body.tournament.closes === startedAt + 48 * 3600 * 1000,
  r.body.tournament);

// The bye room (settings.byeRoom): the one room kept for reading to teams
// on a bye. Its link reads the room after Start like a Test link, with no
// admin secret in it; it reads the round being played and no later one,
// and nothing it does is kept.
{
  const made = (await call(A + '/buckets', { method: 'POST', json: { room_name: 'Bye 1' } })).body;
  const before = JSON.parse((await call(A)).body.tournament.settings || '{}');
  r = await call(A, { method: 'POST', json: { settings: { ...before, byeRoom: made.id } } });
  ok('bye room: marked', r.status === 200, r.body);
  r = await call('/b/' + made.secret + '?test=bye');
  ok('bye room: reads after Start, in test mode', r.status === 200 && r.body.test === true, r.body);
  r = await call('/b/' + made.secret);
  ok('bye room: its plain link is the same test read', r.status === 200 && r.body.test === true, r.body);
  await roomLoadMatches('the bye room', made.secret);
  let res = await fetch(`${BASE}/b/${made.secret}/packet?round=1&test=bye`);
  ok('bye room: reads the round being played', res.status === 200, res.status);
  res = await fetch(`${BASE}/b/${made.secret}/packet?round=2&test=bye`);
  ok('bye room: no later round', res.status === 403 || res.status === 404, res.status);
  r = await call(`/b/${made.secret}/upload?round=1&name=bye.qbj`, { method: 'POST', body: MATCH });
  ok('bye room: no upload', r.status === 403 && /bye room/.test(r.body.error), r.body);
  r = await call(`/b/${made.secret}/start?round=1`, { method: 'POST' });
  ok('bye room: no round start', r.status === 403, r.body);
  r = await call(A);
  ok('bye room: leaves no trace', !r.body.files.some((f) => f.bucket_id === made.id)
    && !(r.body.starts || []).some((x) => x.bucket_id === made.id), r.body.starts);
  // a playing room again: its link is a room's link again
  r = await call(A, { method: 'POST', json: { settings: before } });
  r = await call('/b/' + made.secret);
  ok('bye room: switched off, a playing room', r.status === 200 && r.body.test === undefined, r.body);
  await call(`${A}/buckets/${made.id}`, { method: 'DELETE' });
}

// moderator flow
r = await call('/b/' + secret);
ok('bucket state', r.status === 200 && r.body.room === 'Room 1' && r.body.current_round === 1, r.body);
ok('bucket sees packet', r.body.packet && r.body.packet.packet_name === 'Packet1.pdf', r.body.packet);

r = await call(`/b/${secret}/upload?round=1&name=Round_1_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH });
ok('mod uploads qbj', r.status === 200 && r.body.kind === 'qbj' && r.body.error === null, r.body);
const firstQbjId = r.body.id;

r = await call(`/b/${secret}/upload?round=1&name=Round_1_Alpha_Beta_Game.json`,
  { method: 'POST', body: '{"cycles":[]}' });
ok('mod uploads game file', r.status === 200 && r.body.kind === 'game', r.body);

r = await call(`/b/${secret}/upload?round=1&name=broken.qbj`,
  { method: 'POST', body: 'not json' });
ok('broken qbj flagged', r.status === 200 && r.body.error === 'not valid JSON', r.body);

r = await call('/b/wrongsecret12345');
ok('bad secret rejected', r.status === 404);

// packet download through bucket
{
  const res = await fetch(`${BASE}/b/${secret}/packet`);
  ok('mod downloads packet', res.status === 200 && (await res.text()) === 'PDFBYTES');
}

// roster download through bucket (read.html preload path)
{
  const res = await fetch(`${BASE}/b/${secret}/roster`);
  ok('mod downloads roster', res.status === 200 && (await res.text()).includes('Alpha'));
}

// question security at rest: D1 holds only hashes of the link secrets
// (nothing stored opens a page) and question-text blobs are ciphertext
// in R2 — an operator browsing bucket or database sees no question text
{
  const trow = d1row(`SELECT admin_secret, admin_wrap FROM tournaments WHERE slug = '${slug}'`);
  ok('admin secret stored hashed + key wrapped',
    trow && trow.admin_secret === storedCred(A.slice(3)) && !!trow.admin_wrap, trow);
  const brow = d1row(`SELECT wrap, secret_enc FROM buckets WHERE secret = '${storedCred(secret)}'`);
  ok('bucket secret stored hashed + key wrapped', brow && !!brow.wrap, brow);
  ok('bucket secret kept only encrypted for the dashboard',
    brow && brow.secret_enc && !brow.secret_enc.includes(secret), brow);
  // ...and the dashboard renders the room links from the admin detail,
  // so the detail must hand back the real secret, not what D1 stores
  const detail = (await call(A)).body;
  ok('admin detail returns the working room secret',
    detail.buckets.length === 1 && detail.buckets[0].secret === secret, detail.buckets);
  const packet = r2get(`t/${tid}/packet/1/Packet1.pdf`);
  ok('packet is ciphertext at rest', !packet.includes('PDFBYTES'), packet.length);
  const qbjKey = (await call(A)).body.files.find((f) => f.filename === 'Round_1_Alpha_Beta.qbj').r2_key;
  ok('reader upload is ciphertext at rest', !r2get(qbjKey).includes('match_teams'));
}

// tournament settings flow through to the bucket state
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf',
  formatOverrides: { pairTossupsBonuses: true, bonusesBounceBack: true } } } });
ok('set settings', r.status === 200);
r = await call('/b/' + secret);
ok('bucket state carries settings + roster flag',
  r.body.settings && r.body.settings.gameFormat === 'acf' && r.body.roster === true, r.body);
ok('bucket state carries format overrides',
  r.body.settings.formatOverrides && r.body.settings.formatOverrides.pairTossupsBonuses === true,
  r.body.settings);

// schedule: TO saves it, the bucket view resolves its room, /pub stays
// gated until publish
r = await call('/pub/' + slug + '/schedule');
ok('no schedule pub 404', r.status === 404);
r = await call('/b/' + secret + '/schedule');
ok('no schedule bucket 404', r.status === 404);
const bucketId = (await call(A)).body.buckets[0].id;
const SCHED = {
  v: 1,
  rooms: [{ name: 'Room 1', bucket: bucketId }, { name: 'Room 2', bucket: null }],
  phases: [{ name: 'Prelims', rounds: [
    { round: 1, games: [{ room: 0, a: { team: 'Alpha' }, b: { team: 'Beta' } }], byes: [] },
    { round: 2, games: [{ room: 1, a: { team: 'Beta' }, b: { team: 'Alpha' } }], byes: [] },
  ] }],
  updated: 0,
};
r = await call(A + '/schedule', { method: 'POST', json: SCHED });
ok('schedule saved', r.status === 200, r.body);
r = await call(A + '/schedule', { method: 'POST', json: { v: 2, rooms: [], phases: [] } });
ok('unknown schedule version rejected', r.status === 400);
r = await call(A + '/schedule', { method: 'POST', body: 'not json' });
ok('bad schedule json rejected', r.status === 400);
r = await call(A + '/schedule', { method: 'POST',
  body: '{"v":1,"rooms":[],"phases":[],"pad":"' + 'x'.repeat(260 * 1024) + '"}' });
ok('oversized schedule rejected', r.status === 413);
r = await call('/b/' + secret + '/schedule');
ok('bucket schedule resolves its room',
  r.status === 200 && r.body.room === 0
  && r.body.schedule.phases[0].rounds[0].games[0].a.team === 'Alpha', r.body);
// no bucket link but a matching room name still resolves (schedules made
// before the rooms existed)
r = await call(A + '/schedule', { method: 'POST', json: { ...SCHED,
  rooms: [{ name: ' room 1 ', bucket: null }, { name: 'Room 2', bucket: null }] } });
ok('unlinked schedule saved', r.status === 200);
r = await call('/b/' + secret + '/schedule');
ok('bucket schedule falls back to name match', r.status === 200 && r.body.room === 0, r.body.room);
r = await call(A + '/schedule', { method: 'POST', json: SCHED });
ok('linked schedule restored', r.status === 200);
// a new tournament starts public; turning the page off hides all of it
r = await call('/pub/' + slug);
ok('a new tournament starts public', r.status === 200, r.status);
r = await call(A, { method: 'POST', json: { published: false } });
ok('turn the public page off', r.status === 200);
r = await call('/pub/' + slug + '/schedule');
ok('unpublished schedule hidden', r.status === 404);

// public gate: unpublished -> 404
r = await call('/pub/' + slug);
ok('unpublished hidden', r.status === 404);

// publish, then public state
r = await call(A, { method: 'POST', json: { published: true, current_round: 2 } });
ok('publish + set round', r.status === 200);

// played rounds stay downloadable after the round moves on; future rounds
// stay locked; the bucket state lists every reachable round's packet
r = await call('/b/' + secret);
ok('bucket lists played-round packets',
  r.body.packets.length === 1 && r.body.packets[0].number === 1
  && r.body.current_round === 2, r.body.packets);
{
  const res = await fetch(`${BASE}/b/${secret}/packet?round=1`);
  ok('past round packet still served', res.status === 200 && (await res.text()) === 'PDFBYTES');
  const future = await fetch(`${BASE}/b/${secret}/packet?round=3`);
  ok('future round packet locked', future.status === 403);
}

r = await call('/pub/' + slug);
ok('public state', r.status === 200 && r.body.name === 'E2E Open' && r.body.current_round === 2, r.body);
ok('public lists only valid qbj', r.body.files.length === 1 && r.body.files[0].room === 'Room 1', r.body.files);
ok('pub state carries schedule stamp', typeof r.body.schedule === 'number' && r.body.schedule > 0, r.body.schedule);
// A live tournament caches briefly (refresh bursts collapse) and is not final.
ok('live state is not final', r.body.final === false, r.body.final);
ok('live state caches briefly', maxAge(r.cache) > 0 && maxAge(r.cache) <= 60, r.cache);

{
  const res = await fetch(`${BASE}/pub/${slug}/schedule`);
  const sj = await res.json();
  ok('public schedule served', res.status === 200 && sj.rooms.length === 2
    && sj.phases[0].rounds[0].games[0].a.team === 'Alpha', sj);
  const sCache = res.headers.get('cache-control');
  ok('public schedule briefly cacheable',
    maxAge(sCache) > 0 && maxAge(sCache) <= 60, sCache);
}
r = await call(A + '/schedule', { method: 'DELETE' });
ok('schedule deleted', r.status === 200);
r = await call('/pub/' + slug + '/schedule');
ok('deleted schedule 404', r.status === 404);
r = await call('/pub/' + slug);
ok('schedule stamp cleared', r.body.schedule === null, r.body.schedule);
r = await call(A + '/schedule', { method: 'POST', json: SCHED });
ok('schedule restored', r.status === 200);

// Two tabs (E10, here on wrangler's own R2 and D1): a save that names the
// copy it edited lands only on that copy. Schedule: X-Qbtd-Base, which
// the preflight allows; roster: ?base=; each read names its copy in
// X-Qbtd-Etag. Settings: settings_base, merged onto what is stored.
{
  const fileUrl = (key) => `${BASE}${A}/file?key=${encodeURIComponent(key)}`;
  const schedKey = `t/${tid}/schedule.json`;
  let res = await fetchRetry(fileUrl(schedKey));
  const e1 = res.headers.get('x-qbtd-etag');
  ok('E10: the schedule read names its copy', res.status === 200 && !!e1
    && res.headers.get('access-control-expose-headers') === 'X-Qbtd-Etag', [...res.headers]);
  res = await fetchRetry(`${BASE}${A}/schedule`, { method: 'OPTIONS', headers: { Origin: 'http://localhost',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-qbtd-base' } });
  ok('E10: the preflight allows X-Qbtd-Base', res.status === 204
    && res.headers.get('access-control-allow-headers') === 'Authorization, Content-Type, X-Qbtd-Base', [...res.headers]);
  const SCHED2 = { ...SCHED, updated: 2 };
  r = await call(A + '/schedule', { method: 'POST', json: SCHED2, headers: { 'X-Qbtd-Base': e1 } });
  const e2 = r.body.etag;
  ok('E10: a schedule save on the copy it read lands, with the new etag', r.status === 200 && r.body.ok === true
    && typeof e2 === 'string' && e2 !== e1, r.body);
  res = await fetchRetry(fileUrl(schedKey));
  ok('E10: ...which the next read names', res.headers.get('x-qbtd-etag') === e2, res.headers.get('x-qbtd-etag'));
  r = await call(A + '/schedule', { method: 'POST', json: { ...SCHED, updated: 3 }, headers: { 'X-Qbtd-Base': e1 } });
  ok('E10: a save on a copy another tab replaced is refused, with the stored copy', r.status === 200
    && r.body.ok === false && r.body.conflict === true && r.body.etag === e2
    && JSON.stringify(r.body.schedule) === JSON.stringify(SCHED2), r.body);
  r = await call(A + '/schedule', { method: 'POST', json: SCHED2, headers: { 'X-Qbtd-Base': e1 } });
  ok('E10: the same bytes count as saved', r.body.ok === true && r.body.etag === e2, r.body);
  r = await call(A + '/schedule', { method: 'POST', json: SCHED, headers: { 'X-Qbtd-Base': e2 } });
  ok('E10: the schedule as it was', r.body.ok === true, r.body);

  const rosterKey = `t/${tid}/roster.qbj`;
  res = await fetchRetry(fileUrl(rosterKey));
  const r1 = res.headers.get('x-qbtd-etag');
  ok('E10: the roster read names its copy', res.status === 200 && !!r1 && (await res.text()) === ROSTER0, r1);
  // (R2's etag is the content's hash: the same bytes saved again keep it)
  const ROSTER0b = JSON.stringify(JSON.parse(ROSTER0), null, 2);
  r = await call(`${A}/roster?name=roster.qbj&base=${encodeURIComponent(r1)}`, { method: 'POST', body: ROSTER0b });
  const r2 = r.body.etag;
  ok('E10: a roster save on the copy it read lands, with the new etag', r.status === 200
    && r.body.filename === 'roster.qbj' && typeof r2 === 'string' && r2 !== r1, r.body);
  r = await call(`${A}/roster?name=roster.qbj&base=${encodeURIComponent(r1)}`, { method: 'POST', body: ROSTER0 });
  ok('E10: a roster save on a replaced copy is refused, with the stored etag', r.status === 200
    && r.body.ok === false && r.body.conflict === true && r.body.etag === r2, r.body);
  r = await call(`${A}/roster?name=roster.qbj&base=${encodeURIComponent(r2)}`, { method: 'POST', body: ROSTER0 });
  ok('E10: the roster as it was', r.status === 200 && r.body.etag === r1, r.body);

  const held = (await call(A)).body.tournament.settings;
  const tab = JSON.parse(held);
  r = await call(A, { method: 'POST', json: { settings: { ...tab, catStats: false }, settings_base: held } });
  ok('E10: settings saved on the copy read', r.status === 200, r.body);
  r = await call(A, { method: 'POST', json: { settings: { ...tab, rounds: 9 }, settings_base: held } });
  const merged = JSON.parse((await call(A)).body.tournament.settings);
  ok('E10: a stale tab\'s settings save keeps the other tab\'s change', r.status === 200
    && merged.catStats === false && merged.rounds === 9 && merged.gameFormat === tab.gameFormat, merged);
  r = await call(A, { method: 'POST', json: { settings: tab } });
  ok('E10: the settings as they were', r.status === 200 && (await call(A)).body.tournament.settings === held);
}

// broadcasts were retired (9/28/2026): a dashboard still open from before
// hears so, and no surface carries the field any more
r = await call(A, { method: 'POST', json: { announce: [] } });
ok('broadcast writes refused', r.status === 400 && /removed/.test(r.body.error), r.body);
r = await call('/pub/' + slug);
ok('public state carries no broadcasts', r.body.announce === undefined, r.body);
ok('public state advertises no self-expiry hint',
  r.body.final_after === undefined && r.body.final === false, r.body.final_after);
r = await call('/b/' + secret);
ok('room state carries no broadcasts', r.body.announce === undefined, r.body);

// buzzpoints gate: settings.buzz drives the qpacket route; the public
// state exposes only the mode + a salt-derived buzz_v, never salt/hash.
// Password is the only mode, and rounds unlock only once every
// scheduled game is in.
r = await call('/pub/' + slug);
ok('buzz off by default', r.body.buzz === null && r.body.buzz_v === null
  && r.body.packet_rounds.length === 0, r.body.buzz);
{
  const bare = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`);
  ok('qpacket 401 with no password, before any lookup', bare.status === 401);
  const res = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`, { headers: { Authorization: 'Buzz x' } });
  ok('qpacket 404 when buzz off', res.status === 404);
}
const buzzSalt = 'testsalt';
const buzzHash = createHash('sha256').update(buzzSalt + ':hunter2').digest('hex');
r = await call(A, { method: 'POST', json: { settings: {
  gameFormat: 'acf', buzz: { mode: 'password', salt: buzzSalt, hash: buzzHash } } } });
ok('buzz password set', r.status === 200);
// set without the derived token (an out-of-date client): the password
// checks out but nothing can unwrap the content key — locked, not text
{
  const locked = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz hunter2' } });
  ok('qpacket locked without a key wrap', locked.status === 409, locked.status);
}
r = await call(A, { method: 'POST', json: { buzz_token: 'hunter2', settings: {
  gameFormat: 'acf', buzz: { mode: 'password', salt: buzzSalt, hash: buzzHash } } } });
ok('buzz key wrapped on re-set', r.status === 200);
// rooms get the reader game format but never the buzz config (its hash
// would enable an offline attack on the TO's password)
r = await call('/b/' + secret);
ok('bucket settings hide buzz config',
  r.body.settings.gameFormat === 'acf' && r.body.settings.buzz === undefined,
  r.body.settings);
r = await call('/pub/' + slug);
ok('pub state exposes only buzz mode',
  r.body.buzz === 'password' && !JSON.stringify(r.body).includes(buzzHash)
  && !JSON.stringify(r.body).includes(buzzSalt), r.body.buzz);
ok('packet rounds listed', r.body.packet_rounds.length === 1 && r.body.packet_rounds[0] === 1,
  r.body.packet_rounds);
ok('buzz_v is a 12-hex stamp', /^[0-9a-f]{12}$/.test(r.body.buzz_v), r.body.buzz_v);
const buzzV1 = r.body.buzz_v;
// round 1: 1 scheduled game, 1 clean upload -> done. round 2: scheduled,
// nothing in -> not listed.
ok('buzz_done lists only finished rounds',
  JSON.stringify(r.body.buzz_done) === '[1]', r.body.buzz_done);
{
  const noauth = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`);
  ok('qpacket 401 without password', noauth.status === 401);
  const wrong = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz wrong' } });
  ok('qpacket 401 wrong password', wrong.status === 401);
  const right = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz hunter2' } });
  ok('qpacket serves packet with password', right.status === 200 && (await right.text()) === 'PDFBYTES');
  ok('qpacket private cache', (right.headers.get('cache-control') || '').includes('private'));
  const future = await fetch(`${BASE}/pub/${slug}/qpacket?round=9`,
    { headers: { Authorization: 'Buzz hunter2' } });
  ok('qpacket future round locked', future.status === 403);
  const ongoing = await fetch(`${BASE}/pub/${slug}/qpacket?round=2`,
    { headers: { Authorization: 'Buzz hunter2' } });
  ok('qpacket ongoing round locked', ongoing.status === 403
    && (await ongoing.json()).error === 'round in progress');
}
// new password (fresh salt) moves buzz_v and kills the old password
const buzzHash2 = createHash('sha256').update('salt2:hunter3').digest('hex');
r = await call(A, { method: 'POST', json: { buzz_token: 'hunter3', settings: {
  gameFormat: 'acf', buzz: { mode: 'password', salt: 'salt2', hash: buzzHash2 } } } });
ok('buzz password rotated', r.status === 200);
r = await call('/pub/' + slug);
ok('buzz_v moves with the password', /^[0-9a-f]{12}$/.test(r.body.buzz_v)
  && r.body.buzz_v !== buzzV1, r.body.buzz_v);
{
  const stale = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz hunter2' } });
  ok('old password rejected after rotate', stale.status === 401);
  const fresh = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz hunter3' } });
  ok('new password accepted', fresh.status === 200);
}
// current scheme: the browser stretches the password with PBKDF2 and the
// derived key is what travels, so the Worker only ever hashes that key.
// The salt and iteration count go public (a viewer's browser needs them);
// the hash must not.
const kdfSettings = await buzzSettings('hunter4');
const kdfToken = await buzzToken('hunter4',
  { kdf: 'pbkdf2', iters: kdfSettings.iters, salt: kdfSettings.salt });
r = await call(A, { method: 'POST',
  json: { buzz_token: kdfToken, settings: { gameFormat: 'acf', buzz: kdfSettings } } });
ok('pbkdf2 password set', r.status === 200);
r = await call('/pub/' + slug);
ok('pub state publishes kdf params but never the hash',
  r.body.buzz_kdf && r.body.buzz_kdf.kdf === 'pbkdf2'
  && r.body.buzz_kdf.iters === kdfSettings.iters
  && r.body.buzz_kdf.salt === kdfSettings.salt
  && !JSON.stringify(r.body).includes(kdfSettings.hash), r.body.buzz_kdf);
{
  const right = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz ' + kdfToken } });
  ok('qpacket accepts the derived key', right.status === 200
    && (await right.text()) === 'PDFBYTES');
  // the password itself is no longer a credential under this scheme
  const asPw = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz hunter4' } });
  ok('qpacket rejects the raw password once stretched', asPw.status === 401);
  const wrong = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz ' + 'f'.repeat(64) } });
  ok('qpacket rejects a wrong key', wrong.status === 401);
}
// a config below the iteration floor is not a weak gate, it is no gate
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf',
  buzz: { ...kdfSettings, iters: 10 } } } });
ok('under-stretched config write accepted', r.status === 200);
{
  const weak = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
    { headers: { Authorization: 'Buzz ' + kdfToken } });
  ok('qpacket 404 when iters is below the floor', weak.status === 404);
}
r = await call('/pub/' + slug);
ok('under-stretched config reads as off', r.body.buzz === null, r.body.buzz);
// unknown kdf likewise: fail shut, never fall back to the legacy compare
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf',
  buzz: { ...kdfSettings, kdf: 'md5' } } } });
ok('unknown kdf write accepted', r.status === 200);
r = await call('/pub/' + slug);
ok('unknown kdf reads as off', r.body.buzz === null, r.body.buzz);

// the stats password, scoresheets and the category switch: neither
// scoresheets nor buzzpoints switch on without a stored password, and the
// password stays with buzzpoints off (mode 'off') for scoresheets to use
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', scoresheets: true } } });
ok('scoresheets refused without a password', r.status === 400 && r.body.error === 'set a password first', r.body);
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: { mode: 'password' } } } });
ok('buzzpoints refused without a password', r.status === 400, r.body);
r = await call(A, { method: 'POST', json: { buzz_token: kdfToken,
  settings: { gameFormat: 'acf', scoresheets: true, buzz: { ...kdfSettings, mode: 'off' } } } });
ok('scoresheets on behind a password with buzzpoints off', r.status === 200, r.body);
r = await call('/pub/' + slug);
ok('pub state: scoresheets on, buzzpoints off',
  r.body.scoresheets === true && r.body.buzz === null
  && r.body.buzz_kdf && r.body.buzz_kdf.salt === kdfSettings.salt
  && JSON.stringify(r.body.buzz_done) === '[1]' && r.body.packet_rounds.length === 0
  && !JSON.stringify(r.body).includes(kdfSettings.hash), r.body);
{
  const bare = await fetch(`${BASE}/pub/${slug}/unlock`);
  ok('unlock 401 with no password', bare.status === 401);
  const wrong = await fetch(`${BASE}/pub/${slug}/unlock`, { headers: { Authorization: 'Buzz ' + 'f'.repeat(64) } });
  ok('unlock 401 with a wrong password', wrong.status === 401);
  const right = await fetch(`${BASE}/pub/${slug}/unlock`, { headers: { Authorization: 'Buzz ' + kdfToken } });
  ok('unlock accepts the stats password', right.status === 200);
  // buzzpoints off: no packet text, whatever the password
  const pkt = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`, { headers: { Authorization: 'Buzz ' + kdfToken } });
  ok('qpacket 404 with buzzpoints off', pkt.status === 404);
}
// buzzpoints back on with the kept password: no new password needed
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', scoresheets: true,
  buzz: { ...kdfSettings, mode: 'password' } } } });
{
  const pkt = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`, { headers: { Authorization: 'Buzz ' + kdfToken } });
  ok('buzzpoints back on serve packets on the kept password', r.status === 200 && pkt.status === 200);
}
// Category stats off hides the tab; scoresheets keep their category map
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', scoresheets: true, catStats: false,
  buzz: { ...kdfSettings, mode: 'password' } } } });
r = await call('/pub/' + slug);
ok('category stats off: the tab flag only, the map stays as it was',
  r.body.cat_tab === false && 'cats' in r.body, r.body);
// both off: nothing for the password to unlock
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: { ...kdfSettings, mode: 'off' } } } });
r = await call('/pub/' + slug);
ok('scoresheets and buzzpoints off', r.body.scoresheets === false && r.body.buzz === null
  && r.body.buzz_v === null, r.body);
{
  const res = await fetch(`${BASE}/pub/${slug}/unlock`, { headers: { Authorization: 'Buzz ' + kdfToken } });
  ok('unlock 404 with nothing switched on', res.status === 404);
}

// attempt cap: only meaningful when the ratelimit binding is present, so
// the run says which it checked rather than passing silently either way
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: kdfSettings } } });
{
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`,
      { headers: { Authorization: 'Buzz ' + 'a'.repeat(64) } });
    if (res.status === 429) { limited++; break; }
  }
  if (limited) ok('qpacket caps repeated attempts', true);
  else console.log('  -- attempt cap not exercised: no ratelimit binding in this dev run');
}

// passwordless mode no longer exists: legacy 'public' reads as off
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: { mode: 'public' } } } });
ok('legacy public settings write accepted', r.status === 200);
{
  // (the attempt cap above is spent, so only the password-less path can be asked)
  const open = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`);
  ok('qpacket stays shut for legacy public mode', open.status === 401, open.status);
}
r = await call('/pub/' + slug);
ok('legacy public mode reads as off', r.body.buzz === null && r.body.buzz_v === null, r.body.buzz);

// category map: extracted from JSON packets at upload, text-free, public
ok('no catmap yet', r.body.cats === null, r.body.cats);
r = await call('/pub/' + slug + '/cats');
ok('cats 404 before a categorized packet', r.status === 404);
const CATPACKET = JSON.stringify({
  tossups: [
    { question: 'q1 text', answer: 'a1', category: 'Literature', subcategory: 'American Literature' },
    { question: 'q2 text', answer: 'a2', category: 'Science', subcategory: 'Biology' },
    { question: 'q3 text', answer: 'a3' },
  ],
  bonuses: [
    { leadin: 'b1 text', metadata: 'World History' },
    // difficulty marks travel with the category (text-free), for the questions view
    { leadin: 'b2 text', category: 'Science', subcategory: 'Physics', difficultyModifiers: ['h', 'e', 'm'] },
  ],
});
r = await call(`${A}/packet?round=2&name=Packet2.json`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: CATPACKET });
ok('categorized packet uploads', r.status === 200, r.body);
r = await call('/pub/' + slug);
ok('pub state carries cats stamp', typeof r.body.cats === 'number' && r.body.cats > 0, r.body.cats);
r = await call('/pub/' + slug + '/cats');
ok('cats served, text-free',
  r.status === 200 && r.body.rounds['2'].t.length === 3
  && r.body.rounds['2'].t[0].c === 'Literature'
  && r.body.rounds['2'].t[0].s === 'American Literature'
  && r.body.rounds['2'].t[2] === null
  && r.body.rounds['2'].b[0].c === 'History'
  && r.body.rounds['2'].b[0].s === 'World'
  && r.body.rounds['2'].b[0].d === undefined
  && r.body.rounds['2'].b[1].d === 'hem'
  && !JSON.stringify(r.body).includes('q1 text')
  && !JSON.stringify(r.body).includes('b1 text'), r.body);
// replacement packet without categories clears the round's entry
r = await call(`${A}/packet?round=2&name=Packet2.json`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tossups: [{ question: 'q', answer: 'a' }] }) });
ok('uncategorized replacement uploads', r.status === 200);
r = await call('/pub/' + slug + '/cats');
ok('replacement clears the map (last categorized round gone -> 404)', r.status === 404, r.status);
r = await call('/pub/' + slug);
ok('cats stamp cleared with it', r.body.cats === null, r.body.cats);
r = await call(`${A}/packet?round=2&name=Packet2.json`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: CATPACKET });
ok('categorized packet restored', r.status === 200);

// ACF/YAPP metadata-string packets ("Cat - Sub, Author", author-first,
// bare category) parse too
r = await call(`${A}/packet?round=3&name=Packet3.json`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tossups: [
    { question: 'q', answer: 'a', metadata: 'History - World, Khang Le' },
    { question: 'q', answer: 'a', metadata: 'Khang Le, Literature - American' },
    { question: 'q', answer: 'a', metadata: 'Math, Vikram Narasimhan' },
    { question: 'q', answer: 'a', metadata: 'Just An Author' },
  ] }) });
ok('metadata packet uploads', r.status === 200, r.body);
r = await call('/pub/' + slug + '/cats');
ok('metadata categories parsed', r.status === 200
  && r.body.rounds['3'].t[0].c === 'History' && r.body.rounds['3'].t[0].s === 'World'
  && r.body.rounds['3'].t[1].c === 'Literature' && r.body.rounds['3'].t[1].s === 'American'
  && r.body.rounds['3'].t[2].c === 'Science' && r.body.rounds['3'].t[2].s === 'Math'
  && r.body.rounds['3'].t[3].u === 'Just An Author' && !r.body.rounds['3'].t[3].c, r.body.rounds['3']);

// bare distribution labels (one label per question, 2026 UG Nats style)
r = await call(`${A}/packet?round=4&name=Packet4.json`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tossups: [
    { question: 'q', answer: 'a', metadata: 'American History' },
    { question: 'q', answer: 'a', metadata: 'Any History' },
    { question: 'q', answer: 'a', metadata: 'World Literature' },
    { question: 'q', answer: 'a', metadata: 'Physics' },
    { question: 'q', answer: 'a', metadata: 'Other Science' },
    { question: 'q', answer: 'a', metadata: 'Painting / Sculpture' },
    { question: 'q', answer: 'a', metadata: 'Classical Music' },
    { question: 'q', answer: 'a', metadata: 'Other Fine Arts' },
    { question: 'q', answer: 'a', metadata: 'Social Science' },
    { question: 'q', answer: 'a', metadata: 'Other' },
  ] }) });
ok('label packet uploads', r.status === 200, r.body);
r = await call('/pub/' + slug + '/cats');
{
  const c4 = r.status === 200 && r.body.rounds['4'] ? r.body.rounds['4'].t : null;
  const eq = (i, c, s) => c4 && c4[i] && c4[i].c === c && c4[i].s === s;
  ok('bare labels parsed', eq(0, 'History', 'American') && eq(1, 'History', '')
    && eq(2, 'Literature', 'World') && eq(3, 'Science', 'Physics')
    && eq(4, 'Science', 'Other') && eq(5, 'Fine Arts', 'Painting / Sculpture')
    && eq(6, 'Fine Arts', 'Classical Music') && eq(7, 'Fine Arts', 'Other')
    && eq(8, 'Social Science', '') && eq(9, 'Other Academic', ''), c4);
}

// backfill: wipe the map (as if the packets predate extraction), then a
// dashboard load rebuilds it off the response path
execSync(`npx wrangler r2 object delete qb-td-data/t/${tid}/catmap.json --local${PERSIST}`,
  { cwd: WORKER_DIR, stdio: 'ignore' });
r = await call('/pub/' + slug);
ok('cats gone after wipe', r.body.cats === null, r.body.cats);
await call(A); // triggers the waitUntil backfill
let backfilled = null;
for (let i = 0; i < 20 && backfilled === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  backfilled = (await call('/pub/' + slug)).body.cats;
}
ok('dashboard load backfills the map', backfilled !== null, backfilled);
r = await call('/pub/' + slug + '/cats');
ok('backfilled map has both rounds', r.status === 200
  && r.body.rounds['2'] && r.body.rounds['3'], r.body);

// a map written by an older parser (no version metadata) reads as stale:
// the next dashboard load rebuilds it with the current parser
execSync(`node -e "process.stdout.write(JSON.stringify({rounds:{}}))" | npx wrangler r2 object put qb-td-data/t/${tid}/catmap.json --pipe --content-type application/json --local${PERSIST}`,
  { cwd: WORKER_DIR, stdio: 'ignore', shell: true });
r = await call('/pub/' + slug + '/cats');
ok('stale map planted', r.status === 200 && !Object.keys(r.body.rounds).length, r.body);
// an empty map is the "checked, nothing found" marker: the public state
// (built live here, as no tick has run yet) tells it by R2's object size
// and keeps the Categories tab hidden
r = await call('/pub/' + slug);
ok('an empty map keeps the tab hidden', r.status === 200 && r.body.cats === null, r.body.cats);
await call(A); // triggers the version-stale backfill
let healed = null;
for (let i = 0; i < 20 && healed === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const cur = (await call('/pub/' + slug + '/cats')).body;
  if (cur && cur.rounds && cur.rounds['3']) healed = cur;
}
ok('version-stale map rebuilt with current parser', healed !== null
  && healed.rounds['2'] && healed.rounds['3'], healed);

r = await call('/pub/' + slug);   // the sections below read files off this

{
  const res = await fetch(`${BASE}/pub/${slug}/qbj/${r.body.files[0].id}`);
  const text = await res.text();
  ok('public qbj download', res.status === 200 && JSON.parse(text).tossups_read === 20);
  ok('public qbj drops protest notes', !text.includes('PROTESTLEAKANSWER'));
  const rr = await fetch(`${BASE}/pub/${slug}/roster`);
  ok('public roster download', rr.status === 200 && (await rr.text()).includes('Alpha'));
}

// per-round shards: the upload writes only its own game blob, and the
// cron folds it into the round the page reads
r = await call('/pub/' + slug);
ok('unmaterialized upload moves no stamp',
  Object.keys(r.body.rounds).length === 0 && r.body.version === '0:0', r.body.rounds);
await tick();
r = await call('/pub/' + slug);
const v1 = r.body.version;
ok('tick materializes round 1', r.body.rounds['1'] && v1.includes(':'), r.body.rounds);
r = await call('/pub/' + slug + '/rounds?n=1');
ok('round shard served', r.status === 200 && r.body.rounds.length === 1
  && r.body.rounds[0].entries.length === 1, r.body);
ok('shard entry carries room/round/qbj',
  r.body.rounds[0].entries[0].room === 'Room 1' && r.body.rounds[0].entries[0].round === 1
  && r.body.rounds[0].entries[0].qbj.tossups_read === 20, r.body.rounds[0].entries[0]);
ok('shard stamp matches the state',
  r.body.rounds[0].v === (await call('/pub/' + slug)).body.rounds['1'], r.body.rounds[0].v);
// protest reasons (match notes) quote answers; the public copies — which
// are served live and committed to the snapshot repo — must drop them
ok('shard strips protest notes', !JSON.stringify(r.body).includes('PROTESTLEAKANSWER'));
// One request covers a whole first load, and rounds with no shard are
// simply absent rather than failing the batch.
r = await call('/pub/' + slug + '/rounds?n=1,7');
ok('unplayed round is omitted, not an error',
  r.status === 200 && r.body.rounds.length === 1 && r.body.rounds[0].round === 1, r.body);
// The page keys each round with the stamp it expects, so the browser
// cache can't serve a pre-move copy; the Worker ignores the stamp.
r = await call('/pub/' + slug + '/rounds?n=1@' + v1 + ',7@0:0');
ok('stamp-keyed rounds request served the same',
  r.status === 200 && r.body.rounds.length === 1 && r.body.rounds[0].round === 1, r.body);
r = await call('/pub/' + slug + '/rounds');
ok('rounds request needs an n', r.status === 400, r.body);
r = await call('/pub/' + slug + '/rounds?n=' + Array.from({ length: 101 }, (_, i) => i + 1).join(','));
ok('oversized rounds request rejected', r.status === 400 && /100/.test(r.body.error), r.body);

const MATCH2 = MATCH.replace('"_round": 1', '"_round": 2').replace('_round":1', '_round":2');
r = await call(`/b/${secret}/upload?round=2&name=Round_2_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH2 });
ok('second qbj uploads', r.status === 200 && r.body.error === null, r.body);
const secondQbjId = r.body.id;

// The cron hands each tournament's rebuild to its own invocation
// (REBUILD binding), so the trigger can return before that rebuild has
// landed: wait for it rather than read once.
await tick();
for (let i = 0; i < 20; i++) {
  r = await call('/pub/' + slug);
  if (r.body.version !== v1 && r.body.rounds && r.body.rounds['2']) break;
  await new Promise((res) => setTimeout(res, 250));
}
ok('version moves on upload', r.body.version !== v1, r.body.version);
ok('a new round gets its own stamp, leaving round 1 alone',
  r.body.rounds['2'] && r.body.rounds['1'] === v1.split(':')[0] + ':1', r.body.rounds);

r = await call(`${A}/files/${secondQbjId}`, { method: 'DELETE' });
ok('delete second qbj', r.status === 200);
await tick();
r = await call('/pub/' + slug);
ok('emptied round drops out', r.body.rounds['2'] === undefined, r.body.rounds);
r = await call('/pub/' + slug + '/rounds?n=2');
ok('emptied round shard deleted', r.status === 200 && r.body.rounds.length === 0, r.body);

// TO rebuild round-trip: re-post public copies, next tick rebuilds shards
r = await call(`${A}/bundle`, {
  method: 'POST',
  body: JSON.stringify({ entries: [{ id: 999, round: 1, room: 'Room 1', filename: 'x.qbj', qbj: JSON.parse(MATCH) }] }),
});
ok('rebuild accepted', r.status === 200 && r.body.entries === 1, r.body);
r = await call(`${A}/bundle`, {
  method: 'POST',
  body: JSON.stringify({ entries: Array.from({ length: 201 }, (_, i) => ({ id: i, qbj: {} })) }),
});
ok('oversized rebuild batch rejected', r.status === 400 && /200/.test(r.body.error), r.body);
r = await call('/pub/' + slug + '/qbj/999');
ok('rebuilt game served', r.status === 200 && r.body.tossups_read === 20, r.body);
// A rebuild must not blank the public page while it waits for the tick:
// the state keeps advertising the shards it has (id 999 has no file
// row, so the stamps don't move either), and only the marker tells the
// tick to rebuild every round regardless.
r = await call('/pub/' + slug);
ok('rebuild leaves the current shards advertised',
  r.body.rounds['1'] === v1.split(':')[0] + ':1', r.body.rounds);
r = await call('/pub/' + slug + '/rounds?n=1');
ok('rebuild leaves the current shard served', r.status === 200
  && r.body.rounds.length === 1 && r.body.rounds[0].entries.length === 1, r.body);
// Plant a stale copy of an existing game with the same id: its stamp is
// unchanged, so only a forced rebuild would pick the new content up.
r = await call(`${A}/bundle`, {
  method: 'POST',
  body: JSON.stringify({ entries: [{ id: firstQbjId, round: 1, room: 'Rebuilt Room', filename: 'x.qbj', qbj: JSON.parse(MATCH) }] }),
});
ok('rebuild of an existing game accepted', r.status === 200 && r.body.entries === 1, r.body);
await tick();
r = await call('/pub/' + slug + '/rounds?n=1');
ok('forced rebuild refreshes an unchanged-stamp round',
  r.status === 200 && r.body.rounds[0].entries[0].room === 'Rebuilt Room', r.body);
r = await call('/pub/' + slug);
// same games, other contents: the stamp keeps its ids and moves, so the
// GitHub snapshot and viewers holding the round fetch it again
ok('a rebuilt round keeps its ids and gets a new stamp',
  r.body.rounds['1'].startsWith(v1.split(':')[0] + ':1:'), r.body.rounds);
// the dashboard rebuilds from admin downloads, which keep notes — the
// Worker must strip them again on the way back in
ok('rebuild strips notes too', !JSON.stringify(r.body).includes('PROTESTLEAKANSWER'));
// The marker is consumed: the next tick, if nothing changed, does not
// rewrite the shard (its stamp stays, and the round survives untouched).
r = await call(`${A}/bundle`, {
  method: 'POST',
  body: JSON.stringify({ entries: [{ id: firstQbjId, round: 1, room: 'Room 1', filename: 'x.qbj', qbj: JSON.parse(MATCH) }] }),
});
await tick();
r = await call('/pub/' + slug + '/rounds?n=1');
ok('second rebuild restores the room', r.body.rounds[0].entries[0].room === 'Room 1', r.body);

// A route that throws (here on a corrupt prebuilt state) answers a JSON
// 500 with CORS headers, which the page can read, rather than Cloudflare's
// bare 500, which it could only report as a network failure.
{
  const built = r2get(`t/${tid}/pubstate.json`);
  r2put(`t/${tid}/pubstate.json`, 'not json');
  r = await call('/pub/' + slug);
  ok('a thrown error is a JSON 500 the page can read',
    r.status === 500 && typeof r.body.error === 'string' && Boolean(r.cors), [r.status, r.body, r.cors]);
  r2put(`t/${tid}/pubstate.json`, built);
  r = await call('/pub/' + slug);
  ok('the route answers again once the blob is whole', r.status === 200, r.status);
}

// A tournament published before the shards existed is in the state
// "games, no manifest". The state must flag itself for the next tick
// rather than sit there empty — a finished tournament can't be mutated
// back into the queue — and must not advertise the long cache while it
// is in that state. Such a tournament also has no prebuilt public state
// (pubstate.json came later still), which is what sends a view down the
// live path at all.
for (const key of ['rounds.json', 'pubstate.json']) {
  execSync(`npx wrangler r2 object delete qb-td-data/t/${tid}/${key} --local${PERSIST}`,
    { cwd: WORKER_DIR, stdio: 'ignore' });
}
r = await call('/pub/' + slug);
ok('unmaterialized state reports no rounds', Object.keys(r.body.rounds).length === 0, r.body.rounds);
ok('unmaterialized state caches briefly', maxAge(r.cache) <= 60, r.cache);
await tick();
r = await call('/pub/' + slug);
ok('a view was enough to get it rebuilt', Object.keys(r.body.rounds).length > 0, r.body.rounds);

// combined reader upload: one file carries qbj + game state; the game half
// (full packet text) must never reach the bundle or a public route
{
  const q = JSON.parse(MATCH);
  q._round = 3;
  const combined = JSON.stringify({ qbj: q, game: { packetText: 'SECRETQUESTIONTEXT', cycles: [] } });
  r = await call(`/b/${secret}/upload?round=3&name=Round_3_Alpha_Beta.qbtd.json`,
    { method: 'POST', body: combined });
  ok('combined upload accepted', r.status === 200 && r.body.kind === 'combined' && r.body.error === null, r.body);
  const cid = r.body.id;

  await tick();
  r = await call('/pub/' + slug + '/rounds?n=3');
  const entry = r.body.rounds[0].entries.find((e) => e.id === cid);
  ok('shard stores only the qbj half',
    entry && entry.qbj.tossups_read === 20 && !JSON.stringify(entry).includes('SECRETQUESTIONTEXT'), entry);

  const res = await fetch(`${BASE}/pub/${slug}/qbj/${cid}`);
  const text = await res.text();
  ok('public route serves extracted qbj only',
    res.status === 200 && JSON.parse(text).tossups_read === 20 && !text.includes('SECRETQUESTIONTEXT'));
  ok('extracted download renamed to .qbj',
    (res.headers.get('content-disposition') || '').includes('Round_3_Alpha_Beta.qbj'));

  const broken = await call(`/b/${secret}/upload?round=3&name=bad.qbtd.json`,
    { method: 'POST', body: '{"game": {}}' });
  ok('combined without a match flagged', broken.status === 200 && broken.body.error !== null, broken.body);

  // the TO downloads a combined upload as its two real files, not the wrapper
  r = await call(A);
  const cfile = r.body.files.find((f) => f.id === cid);
  const fileUrl = (extra) => `${BASE}${A}/file?key=${encodeURIComponent(cfile.r2_key)}${extra}`;
  const qres = await fetch(fileUrl('&part=qbj&dl=Round_3_Alpha_Beta.qbj'));
  const qtext = await qres.text();
  ok('admin part=qbj serves the bare match',
    qres.status === 200 && JSON.parse(qtext).tossups_read === 20 && !qtext.includes('SECRETQUESTIONTEXT'));
  ok('admin qbj keeps notes for the .yft', qtext.includes('PROTESTLEAKANSWER'));
  ok('part=qbj named .qbj',
    (qres.headers.get('content-disposition') || '').includes('Round_3_Alpha_Beta.qbj'));
  const gres = await fetch(fileUrl('&part=game&dl=Round_3_Alpha_Beta_Game.json'));
  const gtext = await gres.text();
  ok('admin part=game serves the game state',
    gres.status === 200 && JSON.parse(gtext).cycles.length === 0 && gtext.includes('SECRETQUESTIONTEXT'));
  ok('part=game named _Game.json',
    (gres.headers.get('content-disposition') || '').includes('Round_3_Alpha_Beta_Game.json'));

  // a roster rename (Ann is Annie now): the game comes down under the new name
  const rosterWith = (ann) => JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
    { name: 'Alpha', teams: [{ name: 'Alpha', players: [ann] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] },
  ] }] });
  // written straight to the stored roster: the upload route would also
  // flag a public rebuild, which later checks time themselves against
  const rosterKey = d1row(`SELECT roster_r2_key FROM tournaments WHERE slug = '${slug}'`).roster_r2_key;
  const rosterWas = r2get(rosterKey);
  r2put(rosterKey, rosterWith({ name: 'Annie', _formerNames: ['Ann'] }));
  const renamed = JSON.parse(await (await fetch(fileUrl('&part=qbj&dl=Round_3_Alpha_Beta.qbj'))).text());
  ok('admin part=qbj: under the roster\'s new name',
    renamed.match_teams[0].match_players[0].player.name === 'Annie' && !JSON.stringify(renamed).includes('"Ann"'), renamed.match_teams[0]);
  ok('admin part=qbj: the same game otherwise', renamed.tossups_read === 20 && renamed.match_teams[0].bonus_points === 30);
  const pubRenamed = JSON.parse(await (await fetch(`${BASE}/pub/${slug}/qbj/${cid}`)).text());
  ok('public qbj: under the roster\'s new name too', pubRenamed.match_teams[0].match_players[0].player.name === 'Annie'
    && !JSON.stringify(pubRenamed).includes('SECRETQUESTIONTEXT'), pubRenamed.match_teams[0]);
  // the rename key spelled with a \u escape is still the key (the Worker
  // skips parsing rosters that hold no renames, and must not skip this one)
  r2put(rosterKey, rosterWith({ name: 'Annie', _formerNames: ['Ann'] }).replace('"_formerNames"', '"\\u005fformerNames"'));
  const escaped = JSON.parse(await (await fetch(fileUrl('&part=qbj&dl=Round_3_Alpha_Beta.qbj'))).text());
  ok('admin part=qbj: an escaped rename key renames too', escaped.match_teams[0].match_players[0].player.name === 'Annie', escaped.match_teams[0]);
  r2put(rosterKey, rosterWas);
  ok('admin part=qbj: no rename, MODAQ\'s text again', (await (await fetch(fileUrl('&part=qbj&dl=x.qbj'))).text()) === qtext);

  // the hub ranks on games' public copies, many to a request (adminGames)
  const batch = await call(`${A}/games?ids=${cid},${broken.body.id},999999`);
  const btext = JSON.stringify(batch.body);
  ok('games batch: the public copy of each, by id', batch.status === 200 && batch.body.games.length === 1
    && batch.body.games[0].id === cid && batch.body.games[0].qbj.tossups_read === 20, batch.body);
  ok('games batch: no packet text, no notes', !btext.includes('SECRETQUESTIONTEXT') && !btext.includes('PROTESTLEAKANSWER'));
  ok('games batch: a flagged or unknown id is missing',
    JSON.stringify(batch.body.missing) === JSON.stringify([broken.body.id, 999999]), batch.body.missing);
  const tooMany = await call(`${A}/games?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`);
  ok('games batch: at most 100 ids', tooMany.status === 400, tooMany.status);

  // protests: the file row's summary (teams, score, protests) is what the
  // hub's Protests drawer reads. This upload had no structured report, so
  // the protest comes from the qbj's notes — no swing.
  const sum = JSON.parse(cfile.summary);
  ok('summary carries teams and score',
    sum.teams.join(',') === 'Alpha,Beta' && sum.score.join(',') === '60,10', sum);
  ok('protest parsed from the notes', sum.protests.length === 1
    && sum.protests[0].kind === 'tu' && sum.protests[0].q === 3 && sum.protests[0].team === 'Alpha'
    && sum.protests[0].reason === 'PROTESTLEAKANSWER' && sum.protests[0].gain === undefined, sum.protests);

  // a reader upload's structured report (swing included) wins over the notes
  const q2 = JSON.parse(MATCH);
  q2._round = 3;
  r = await call(`/b/${secret}/upload?round=3&name=Round_3_Alpha_Beta.qbtd.json`, {
    method: 'POST',
    body: JSON.stringify({ qbj: q2, game: { cycles: [] }, protests: [
      { kind: 'tu', q: 3, team: 'Alpha', word: 12, given: 'PROTESTLEAKANSWER', reason: 'PROTESTLEAKANSWER',
        to: 'Alpha', from: 'Beta', gain: 45, loss: 30, detail: { tu: 10, neg: 5, bonus: 30, oppTu: 10, oppBonus: 20 } },
      { kind: 'zzz', q: 1 },
      { kind: 'b', q: 4, part: 2, team: 'Beta', reason: 'x'.repeat(2000), to: 'Beta', from: 'Alpha', gain: 10, loss: 0, detail: { part: 10 } },
    ] }),
  });
  ok('reader report upload accepted', r.status === 200 && r.body.error === null, r.body);
  const cid2 = r.body.id;
  r = await call(A);
  const sum2 = JSON.parse(r.body.files.find((f) => f.id === cid2).summary);
  ok('reader report stored with its swing', sum2.protests.length === 2
    && sum2.protests[0].gain === 45 && sum2.protests[0].loss === 30 && sum2.protests[0].word === 12
    && sum2.protests[0].detail.oppBonus === 20 && sum2.protests[1].part === 2
    && sum2.protests[1].reason.length === 500, sum2);

  // protests lodged in a game not uploaded yet: the reader sends the list
  // whenever it changes, and the admin detail carries it
  const lp = { kind: 'tu', q: 6, team: 'Beta', word: 4, given: 'PROTESTLEAKANSWER', reason: 'early',
    to: 'Beta', from: 'Alpha', gain: 20, loss: 0, detail: { tu: 10, neg: 0, bonus: 10 } };
  r = await call(`/b/${secret}/protests?round=3&g=abc123`, { method: 'POST',
    json: { teams: ['Alpha', 'Beta'], protests: [lp] } });
  ok('live protests accepted', r.status === 200 && r.body.ok, r.body);
  r = await call(`/b/${secret}/protests?round=3&g=ABC!`, { method: 'POST', json: { teams: ['Alpha', 'Beta'], protests: [lp] } });
  ok('live protests: bad game id refused', r.status === 400, r.body);
  r = await call(`/b/${secret}/protests?round=3&g=abc123`, { method: 'POST', json: { teams: ['Alpha'], protests: [lp] } });
  ok('live protests: two teams required', r.status === 400, r.body);
  const revBefore = (await call(A)).body.tournament.rev;
  r = await call(A);
  const lrow = (r.body.live_protests || []).find((x) => x.game === 'abc123');
  ok('admin detail carries live protests', lrow && lrow.round === 3
    && JSON.parse(lrow.summary).protests[0].reason === 'early', r.body.live_protests);
  r = await call(`/b/${secret}/protests?round=3&g=abc123`, { method: 'POST', json: { teams: ['Alpha', 'Beta'], protests: [] } });
  r = await call(A);
  ok('an empty list clears the game, and the hub sees it move',
    !(r.body.live_protests || []).some((x) => x.game === 'abc123') && r.body.tournament.rev > revBefore, r.body.live_protests);
  r = await call(`/b/${secret}/protests?round=3&g=abc123`, { method: 'POST', json: { teams: ['Alpha', 'Beta'], protests: [lp] } });

  await tick();
  r = await call('/pub/' + slug + '/rounds?n=3');
  ok('round shard carries no summary', !JSON.stringify(r.body).includes('"summary"')
    && !JSON.stringify(r.body).includes('PROTESTLEAKANSWER'));
  r = await call('/pub/' + slug);
  ok('public state carries neither rulings nor summaries',
    r.body.rulings === undefined && !JSON.stringify(r.body).includes('summary'), r.body);
  r = await call('/b/' + secret);
  ok('room state carries no summaries', !JSON.stringify(r.body).includes('"summary"')
    && !JSON.stringify(r.body).includes('PROTESTLEAKANSWER'));

  // rulings: the TD's own record — whole-map writes on the admin route,
  // like settings
  const rkey = '3/tu3/Alpha/Beta';
  r = await call(A, { method: 'POST', json: { rulings: {
    [rkey]: { r: 'upheld', note: '  Accept it  ', at: 5 },
    'x/open': { r: 'open', note: '' },
  } } });
  ok('rulings saved', r.status === 200, r.body);
  r = await call(A);
  const rul = JSON.parse(r.body.tournament.rulings);
  ok('rulings round-trip; note trimmed; empty open entry dropped',
    rul[rkey].r === 'upheld' && rul[rkey].note === 'Accept it' && rul[rkey].at === 5
    && rul['x/open'] === undefined, rul);
  r = await call(A, { method: 'POST', json: { rulings: { k: { r: 'maybe' } } } });
  ok('unknown ruling rejected', r.status === 400, r.body);
  r = await call(A, { method: 'POST', json: { rulings: [] } });
  ok('rulings must be a map', r.status === 400, r.body);

  // clean up so the later file counts hold
  await call(`${A}/files/${cid2}`, { method: 'DELETE' });
  const noPart = await fetch(fileUrl('&dl=x.qbtd.json'));
  ok('no part still serves the raw blob', noPart.status === 200 && (await noPart.text()).includes('"qbj"'));
  const badPart = await fetch(`${BASE}${A}/file?key=${encodeURIComponent(cfile.r2_key.replace(/^t\/\d+/, 't/999999'))}&part=qbj`);
  ok('part respects the ownership boundary', badPart.status === 403);
}

// tiebreakers: the TO's packet splits into individually tracked questions,
// the reader pool serves them (with the usage log), and reader uploads log
// exactly which questions each match read
{
  r = await call('/b/' + secret + '/tiebreakers');
  ok('no tiebreakers 404', r.status === 404);
  // the hub refetches the pool only when the detail's tb_stamp moves: it
  // must move on every write the pool route would show, and only then
  const tbStamp = async () => (await call(A)).body.tb_stamp;
  const stamps = [await tbStamp()];
  const stampMoved = async (what) => {
    const now = await tbStamp();
    ok('tb_stamp moves: ' + what, now && !stamps.includes(now), [stamps, now]);
    stamps.push(now);
  };
  ok('tb_stamp with no pool', stamps[0] === '-|-', stamps[0]);
  const TBPACKET = JSON.stringify({
    tossups: [
      { question: 'tb tossup one', answer: 'Mozart' },
      { question: 'tb tossup two', answer: 'the Krebs cycle' },
    ],
    bonuses: [{ leadin: 'lead', parts: ['p1', 'p2', 'p3'],
      answers: ['x', 'y', 'z'], values: [10, 10, 10] }],
  });
  r = await call(`${A}/tiebreakers?name=tb.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: TBPACKET });
  ok('tiebreaker packet splits', r.status === 200 && r.body.added.tossups === 2
    && r.body.added.bonuses === 1 && r.body.tossups === 2, r.body);
  await stampMoved('a pool uploaded');
  r = await call(`${A}/tiebreakers?name=tb2.docx`, { method: 'POST', body: 'x' });
  ok('docx tiebreaker rejected', r.status === 400, r.body);
  ok('tb_stamp holds: a rejected upload, and a plain refresh', await tbStamp() === stamps.at(-1) && await tbStamp() === stamps.at(-1));
  r = await call(`${A}/tiebreakers?name=tb2.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: [{ question: 'tb three', answer: 'Treaty of Ghent' }] }) });
  ok('second tiebreaker packet appends with continuing ids',
    r.status === 200 && r.body.tossups === 3, r.body);
  // spare bonuses come as a file of their own: no tossups at all
  r = await call(`${A}/tiebreakers?name=bonuses.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bonuses: [{ leadin: 'only', parts: ['p1', 'p2', 'p3'], answers: ['x', 'y', 'z'], values: [10, 10, 10] }] }) });
  ok('a bonus-only tiebreaker packet splits', r.status === 200 && r.body.added.tossups === 0
    && r.body.added.bonuses === 1 && r.body.tossups === 3 && r.body.bonuses === 2, r.body);
  // one question can be taken out again; its id is not handed out twice
  r = await call(`${A}/tiebreakers?id=B2`, { method: 'DELETE' });
  ok('one tiebreaker question is removed', r.status === 200 && r.body.tossups === 3 && r.body.bonuses === 1, r.body);
  await stampMoved('one question removed');
  r = await call(`${A}/tiebreakers?id=B2`, { method: 'DELETE' });
  ok('removing it twice is a 404', r.status === 404, r.body);
  r = await call(`${A}/tiebreakers?name=bonuses2.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bonuses: [{ leadin: 'again', parts: ['p1'], answers: ['x'], values: [10] }] }) });
  r = await call(A + '/tiebreakers');
  ok('a later upload takes the next id, not the removed one',
    r.body.bonuses.map((b) => b.id).join(',') === 'B1,B3', r.body.bonuses.map((b) => b.id));
  r = await call(`${A}/tiebreakers?id=B3`, { method: 'DELETE' });
  ok('and that one goes too', r.status === 200 && r.body.bonuses === 1, r.body);
  r = await call(`${A}/tiebreakers?name=empty.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tossups: [], bonuses: [] }) });
  ok('a tiebreaker packet with no questions is rejected', r.status === 400, r.body);
  r = await call(`${A}/tiebreakers?name=bad.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: [{ question: 'no answer' }] }) });
  ok('tossup without answer rejected', r.status === 400, r.body);
  r = await call('/b/' + secret + '/tiebreakers');
  await roomLoadMatches('a started room with a pool, roster and schedule', secret);
  ok('reader pool served with ids and empty log',
    r.status === 200 && r.body.tossups.length === 3
    && r.body.tossups[0].id === 'TU1' && r.body.tossups[2].id === 'TU3'
    && r.body.bonuses[0].id === 'B1' && r.body.uses.length === 0, r.body);
  // tiebreakers are question text: ciphertext at rest like the packets
  ok('tiebreaker pool is ciphertext at rest',
    !r2get(`t/${tid}/tiebreakers.json`).includes('Mozart'));

  // One part that throws (here a schedule blob that reads as null) answers
  // in /load as its own route does under the router's boundary, a JSON 500
  // the page can read, and the other three parts still come back whole.
  {
    const sched = r2get(`t/${tid}/schedule.json`);
    r2put(`t/${tid}/schedule.json`, 'null');
    const alone = await call('/b/' + secret + '/schedule');
    ok('a schedule route that throws answers a JSON 500',
      alone.status === 500 && alone.body.error === 'Something went wrong on the server. Please try again.' && Boolean(alone.cors),
      [alone.status, alone.body, alone.cors]);
    const load = await call('/b/' + secret + '/load');
    ok('room load with one part throwing: 200, that part a 500, the other three whole',
      load.status === 200 && load.body['/schedule'].s === 500
      && ['', '/roster', '/tiebreakers'].every((sub) => load.body[sub].s === 200), [load.status, load.body]);
    await roomLoadMatches('one part throwing', secret);
    r2put(`t/${tid}/schedule.json`, sched);
    const back = await call('/b/' + secret + '/schedule');
    ok('the schedule route answers again once the blob is whole', back.status === 200, back.status);
  }

  // a reader upload reports which pool questions its game read
  const q = JSON.parse(MATCH);
  q._round = 5;
  r = await call(`/b/${secret}/upload?round=5&name=Round_5_Alpha_Beta.qbtd.json`,
    { method: 'POST', body: JSON.stringify({ qbj: q, game: { cycles: [] },
      tb: { used: ['TU2', 'B1', 'NOPE'] } }) });
  ok('tb-reporting upload accepted', r.status === 200 && r.body.error === null, r.body);
  await stampMoved('a room\'s upload logs its uses');
  const tbFile1 = r.body.id;
  r = await call('/b/' + secret + '/tiebreakers');
  ok('usage logged with the match',
    r.body.uses.length === 2
    && r.body.uses.every((u) => u.round === 5 && u.room === 'Room 1'
      && u.teams.join(',') === 'Alpha,Beta')
    && r.body.uses.map((u) => u.q).sort().join(',') === 'B1,TU2', r.body.uses);

  // a re-export of the same game replaces its log instead of double-counting
  r = await call(`/b/${secret}/upload?round=5&name=Round_5_Alpha_Beta.qbtd.json`,
    { method: 'POST', body: JSON.stringify({ qbj: q, game: { cycles: [] },
      tb: { used: ['TU3'] } }) });
  const tbFile2 = r.body.id;
  r = await call('/b/' + secret + '/tiebreakers');
  ok('re-export replaces the game log',
    r.body.uses.length === 1 && r.body.uses[0].q === 'TU3', r.body.uses);
  // Edit in MODAQ's correction carries the question record alone (read_core
  // readerUpload): the log stays as the game's own upload left it
  const logged = JSON.stringify(r.body.uses);
  r = await call(`/b/${secret}/upload?round=5&name=Round_5_Alpha_Beta.qbtd.json`,
    { method: 'POST', body: JSON.stringify({ qbj: q, game: { cycles: [] },
      tb: { map: { t: 20, b: 20, tuAt: { 20: 'TU3' }, boAt: {} } } }) });
  ok('a correction with the record alone is accepted', r.status === 200 && r.body.error === null, r.body);
  const tbFile3 = r.body.id;
  r = await call('/b/' + secret + '/tiebreakers');
  ok('and leaves the log as it was', JSON.stringify(r.body.uses) === logged, r.body.uses);

  // the Replacements view: the text of every tiebreaker read, ciphertext at
  // rest, buzz-gated, and shut until the tournament closes
  ok('read tiebreakers stored as ciphertext',
    r2get(`t/${tid}/tbread.json`).length > 0 && !r2get(`t/${tid}/tbread.json`).includes('Krebs'));
  r = await call(A, { method: 'POST', json: { buzz_token: kdfToken, settings: { gameFormat: 'acf', buzz: kdfSettings } } });
  ok('buzz back on for the replacements check', r.status === 200);
  const qtb = () => fetch(`${BASE}/pub/${slug}/qtiebreakers`, { headers: { Authorization: 'Buzz ' + kdfToken } });
  let res = await fetch(`${BASE}/pub/${slug}/qtiebreakers`);
  ok('replacements 401 without password', res.status === 401, res.status);
  res = await qtb();
  ok('replacements shut while the tournament runs', res.status === 403
    && (await res.json()).error === 'tournament not closed yet');
  const startedAt = d1row(`SELECT started FROM tournaments WHERE slug = '${slug}'`).started;
  d1exec(`UPDATE tournaments SET started = ${Date.now() - 49 * 3600 * 1000} WHERE slug = '${slug}'`);
  res = await qtb();
  const read = res.status === 200 ? await res.json() : null;
  ok('replacements open once closed, read questions only',
    read && read.tossups.map((x) => x.id).sort().join(',') === 'TU2,TU3'
    && read.bonuses.map((x) => x.id).join(',') === 'B1'
    && read.tossups.some((x) => x.answer === 'the Krebs cycle')
    && !JSON.stringify(read).includes('Mozart') && read.uses.length === 0, read || res.status);
  d1exec(`UPDATE tournaments SET started = ${startedAt} WHERE slug = '${slug}'`);
  r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: { mode: 'public' } } } });
  ok('buzz off again', r.status === 200);

  // clean up so the later file counts hold
  await call(`${A}/files/${tbFile1}`, { method: 'DELETE' });
  await call(`${A}/files/${tbFile2}`, { method: 'DELETE' });
  await call(`${A}/files/${tbFile3}`, { method: 'DELETE' });
  r = await call(`${A}/tiebreakers`, { method: 'DELETE' });
  ok('tiebreaker pool deleted', r.status === 200);
  r = await call('/b/' + secret + '/tiebreakers');
  ok('deleted pool 404', r.status === 404);
  ok('tb_stamp back to no pool', await tbStamp() === '-|-');
}

// bucket rename: the TO edits a room name in place
{
  const bid = (await call(A)).body.buckets[0].id;
  const stampBefore = (await call('/pub/' + slug)).body.rounds['1'];
  r = await call(`${A}/buckets/${bid}`, { method: 'POST', json: { room_name: 'Library 204' } });
  ok('bucket renamed', r.status === 200 && r.body.room_name === 'Library 204', r.body);
  r = await call('/b/' + secret);
  ok('rename reflected in bucket state', r.body.room === 'Library 204', r.body.room);
  // the saved schedule's copy of the name follows on the schedule room the
  // room resolves to (roomIndexOf: its link, else its old name), and the
  // public data is flagged for a rebuild so game rows follow too
  r = await call('/b/' + secret + '/schedule');
  ok('rename reaches the saved schedule', r.body.schedule.rooms[r.body.room].name === 'Library 204'
    && r.body.schedule.rooms.some((x) => x.bucket === null && x.name === 'Room 2'), r.body.schedule && r.body.schedule.rooms);
  ok('rename flags a public rebuild', d1row(`SELECT pub_dirty FROM tournaments WHERE slug = '${slug}'`).pub_dirty === 1);
  // the hub's public page mark: an unchanged refresh carries the flag and
  // the last rebuild's time
  let held = (await call(A)).body.tournament.rev;
  r = await call(A + '?rev=' + held);
  ok('an unchanged refresh carries the public page state', r.body.unchanged === true && r.body.pub_dirty === 1 && 'pub_built' in r.body, r.body);
  const t0 = Date.now();
  await tick();
  r = await call(A + '?rev=' + held);
  ok('the rebuild clears it and records when', r.body.unchanged === true && r.body.pub_dirty === 0 && r.body.pub_built >= t0 - 1000, r.body);
  r = await call('/pub/' + slug);
  ok('rebuilt public game rows carry the new room name', r.body.files.some((f) => f.room === 'Library 204')
    && !r.body.files.some((f) => f.room === 'Room 1'), r.body.files.map((f) => f.room));
  // the round shards too, which set pages label buzzes from: the rename
  // rewrites the room's public copies and forces their rebuild
  r = await call('/pub/' + slug + '/rounds?n=1');
  ok('the rebuilt shard carries the new room name',
    r.body.rounds[0].entries.find((e) => e.id === firstQbjId).room === 'Library 204', r.body.rounds[0].entries.map((e) => e.room));
  ok('and its stamp moved', r.body.rounds[0].v !== stampBefore && r.body.rounds[0].v.startsWith(stampBefore.split(':').slice(0, 2).join(':') + ':'),
    [stampBefore, r.body.rounds[0].v]);
  r = await call(`${A}/buckets/${bid}`, { method: 'POST', json: { room_name: 'Room 1' } });
  ok('rename back', r.status === 200);
  r = await call('/b/' + secret + '/schedule');
  ok('and the schedule follows back', r.body.schedule.rooms[r.body.room].name === 'Room 1');
  r = await call(`${A}/buckets/999999`, { method: 'POST', json: { room_name: 'X' } });
  ok('rename unknown room 404', r.status === 404, r.body);
  r = await call(`${A}/buckets/${bid}`, { method: 'POST', json: { room_name: '  ' } });
  ok('empty rename rejected', r.status === 400, r.body);
  // a schedule room matched only by its name (its room was made after the
  // schedule was saved) follows a rename too, and so stays matched
  const late = (await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 2' } })).body;
  r = await call('/b/' + late.secret + '/schedule');
  const lateIdx = r.body.room;
  ok('a late room matches its schedule room by name',
    Number.isInteger(lateIdx) && r.body.schedule.rooms[lateIdx].bucket === null, r.body);
  r = await call(`${A}/buckets/${late.id}`, { method: 'POST', json: { room_name: 'Library 205' } });
  ok('the late room renamed', r.status === 200, r.body);
  r = await call('/b/' + late.secret + '/schedule');
  ok('its schedule room follows, and still matches it', r.body.room === lateIdx
    && r.body.schedule.rooms[lateIdx].name === 'Library 205' && r.body.schedule.rooms[lateIdx].bucket === null, r.body);
  await call(`${A}/buckets/${late.id}`, { method: 'POST', json: { room_name: 'Room 2' } });
  r = await call(`${A}/buckets/${late.id}`, { method: 'DELETE' });
  ok('the late room removed again', r.status === 200, r.body);
}

// room reassignment: a moderator uploaded from the wrong room's link, and
// the TD moves the game to the room it was actually played in. Everything
// that names a room follows: both rooms' upload lists, the public file
// list, the rebuilt round shard, and the tiebreaker log.
{
  r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 9' } });
  const room9 = { id: r.body.id, secret: r.body.secret };
  r = await call(`${A}/tiebreakers?name=tbmove.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: [{ question: 'tb move', answer: 'Brahms' }] }) });
  ok('tiebreaker pool for the move test', r.status === 200, r.body);
  const q = JSON.parse(MATCH);
  q._round = 6;
  r = await call(`/b/${secret}/upload?round=6&name=Round_6_Alpha_Beta.qbtd.json`,
    { method: 'POST', body: JSON.stringify({ qbj: q, game: { cycles: [] },
      tb: { used: ['TU1'] } }) });
  ok('game uploaded from the wrong room', r.status === 200 && r.body.error === null, r.body);
  const mvId = r.body.id;
  // A tick's rebuild runs in its own invocation (REBUILD) and can land
  // after the trigger returns; a forced one (the renames above leave one
  // pending) rereads all rounds, so wait for it rather than read once.
  const settled = async (path, done) => {
    for (let i = 0; ; i++) {
      const got = await call(path);
      if (done(got.body) || i === 20) return got;
      await new Promise((res) => setTimeout(res, 250));
    }
  };
  const roomIn6 = (body) => {
    const e = body && body.rounds && body.rounds[0] && body.rounds[0].entries.find((x) => x.id === mvId);
    return e ? e.room : null;
  };
  await tick();
  r = await settled('/pub/' + slug + '/rounds?n=6', roomIn6);
  ok('shard names the uploading room first', roomIn6(r.body) === 'Room 1', r.body);
  const stamp6 = (await settled('/pub/' + slug, (b) => b.rounds && b.rounds['6'])).body.rounds['6'];

  r = await call(`${A}/files/${mvId}`, { method: 'POST', json: { bucket_id: room9.id } });
  ok('file moved to another room', r.status === 200 && r.body.room_name === 'Room 9', r.body);
  r = await call(A);
  ok('moved file carries the new bucket',
    r.body.files.find((f) => f.id === mvId).bucket_id === room9.id);
  r = await call('/b/' + secret);
  ok('old room no longer lists the game', !r.body.uploads.some((u) => u.id === mvId), r.body.uploads);
  r = await call('/b/' + room9.secret);
  ok('new room lists the game', r.body.uploads.some((u) => u.id === mvId), r.body.uploads);
  // the public state is prebuilt by the cron: a move shows there on the
  // next tick, like the stats always have
  await tick();
  r = await settled('/pub/' + slug, (b) => (b.files || []).some((f) => f.id === mvId && f.room === 'Room 9'));
  ok('public file list names the new room after the tick',
    r.status === 200 && r.body.files.find((f) => f.id === mvId).room === 'Room 9', r.body.files);
  r = await call('/b/' + secret + '/tiebreakers');
  ok('tiebreaker log follows the game',
    r.body.uses.length === 1 && r.body.uses[0].room === 'Room 9', r.body.uses);

  await tick();
  r = await settled('/pub/' + slug, (b) => b.rounds['6'] !== stamp6);
  ok('the move keeps the round\'s ids and moves its stamp',
    r.body.rounds['6'] !== stamp6 && r.body.rounds['6'].startsWith(stamp6.split(':').slice(0, 2).join(':') + ':'), r.body.rounds);
  r = await call('/pub/' + slug + '/rounds?n=6');
  ok('rebuilt shard names the new room', roomIn6(r.body) === 'Room 9', r.body);

  r = await call(`${A}/files/${mvId}`, { method: 'POST', json: { bucket_id: room9.id } });
  ok('move to the same room is a no-op', r.status === 200, r.body);
  r = await call(`${A}/files/${mvId}`, { method: 'POST', json: { bucket_id: 999999 } });
  ok('move to unknown room 404', r.status === 404, r.body);
  r = await call(`${A}/files/999999`, { method: 'POST', json: { bucket_id: room9.id } });
  ok('move unknown file 404', r.status === 404, r.body);
  r = await call(`${A}/files/${mvId}`, { method: 'POST', json: {} });
  ok('move without a room rejected', r.status === 400, r.body);

  await call(`${A}/files/${mvId}`, { method: 'DELETE' });
  await call(`${A}/tiebreakers`, { method: 'DELETE' });
  await call(`${A}/buckets/${room9.id}`, { method: 'DELETE' });
  await tick();
}

// Add a game: a file whose own _round says another round than the one the
// TD files it under takes the filed round wherever the round is written
// (the stored file, MODAQ's own QBJ text, the public copy), so the stats
// count it where the hub shows it. A reader's upload, already saying its
// round, is stored as it came.
{
  const raw = async (key) => (await fetch(`${BASE}${A}/file?key=${encodeURIComponent(key)}`)).text();
  const rowOf = async (id) => (await call(A)).body.files.find((f) => f.id === id);
  const q = JSON.parse(MATCH);
  q._round = 2;
  const as7 = JSON.stringify({ ...q, _round: 7 }, null, 2);
  r = await call(`/b/${secret}/upload?round=7&name=Round_2_Alpha_Beta.qbj`, { method: 'POST', body: JSON.stringify(q, null, 2) });
  ok('a .qbj saying round 2 is added under round 7', r.status === 200 && r.body.round === 7 && r.body.error === null, r.body);
  const qbjId = r.body.id;
  const row = await rowOf(qbjId);
  ok('its files row says round 7', row.round === 7, row);
  ok('the stored .qbj says round 7, as MODAQ writes one', (await raw(row.r2_key)) === as7);
  // the same game as a reader upload, with MODAQ's own QBJ text inside
  r = await call(`/b/${secret}/upload?round=7&name=Round_2_Alpha_Beta.qbtd.json`, { method: 'POST',
    body: JSON.stringify({ qbj: q, game: { cycles: [] }, modaq: { qbj: JSON.stringify(q, null, 2), game: '{"cycles":[]}' } }) });
  ok('a reader upload saying round 2 is added under round 7', r.status === 200 && r.body.round === 7 && r.body.error === null, r.body);
  const combId = r.body.id;
  const crow = await rowOf(combId);
  const croot = JSON.parse(await raw(crow.r2_key));
  ok('both of its QBJ copies say round 7', crow.round === 7 && croot.qbj._round === 7 && croot.modaq.qbj === as7, croot);
  const part = await fetch(`${BASE}${A}/file?key=${encodeURIComponent(crow.r2_key)}&part=qbj`);
  ok('its QBJ download is MODAQ\'s text for round 7', (await part.text()) === as7);
  await tick();
  let entries = [];
  for (let i = 0; i < 20 && entries.length < 2; i++) {
    r = await call('/pub/' + slug + '/rounds?n=7');
    entries = r.body.rounds.length ? r.body.rounds[0].entries.filter((e) => e.id === qbjId || e.id === combId) : [];
    if (entries.length < 2) await new Promise((res) => setTimeout(res, 250));
  }
  ok('both public copies say round 7', entries.length === 2 && entries.every((e) => e.round === 7 && e.qbj._round === 7), entries);
  ok('the stats count both in round 7', entries.length === 2
    && entries.every((e) => parseMatch(e.qbj, { filename: e.filename }).round === 7));
  r = await call('/pub/' + slug + '/qbj/' + qbjId);
  ok('the public QBJ route says round 7', r.status === 200 && r.body._round === 7, r.body);
  // a reader's own upload already says its round
  const q3 = { ...q, _round: 3 };
  const readerText = JSON.stringify({ qbj: q3, game: { cycles: [] }, modaq: { qbj: JSON.stringify(q3, null, 2), game: '{}' } });
  r = await call(`/b/${secret}/upload?round=3&name=Round_3_Alpha_Beta.qbtd.json`, { method: 'POST', body: readerText });
  const readerId = r.body.id;
  const rrow = await rowOf(readerId);
  ok('a reader upload under its own round is stored as it came',
    (await raw(rrow.r2_key)) === readerText && rrow.size === readerText.length, rrow);
  // a game added before uploads were stamped: moving it to the round it
  // is already filed under stamps it where it is
  r2put(row.r2_key, JSON.stringify(q, null, 2));
  r2put(`t/${tid}/pub/${qbjId}.json`, JSON.stringify({ id: qbjId, round: 7, room: 'Room 1', filename: 'Round_2_Alpha_Beta.qbj', qbj: q }));
  r = await call(`${A}/files/${qbjId}`, { method: 'POST', json: { round: 7 } });
  ok('moving an unstamped game to its own round goes through', r.status === 200 && r.body.round === 7, r.body);
  ok('and stamps its stored file', (await raw(row.r2_key)) === as7);
  r = await call('/pub/' + slug + '/qbj/' + qbjId);
  ok('and its public copy', r.status === 200 && r.body._round === 7, r.body);
  // a .qbj from elsewhere keeps its own layout: only the round changes
  r = await call(`/b/${secret}/upload?round=7&name=game.qbj`, { method: 'POST', body: JSON.stringify(q) + '\n' });
  const compactId = r.body.id;
  ok('a compact .qbj added under another round stays compact, only its round changed',
    (await raw((await rowOf(compactId)).r2_key)) === JSON.stringify({ ...q, _round: 7 }) + '\n');
  // one MODAQ exported with no round gets it where MODAQ writes it, before
  // packets, in the stored file and the public QBJ alike
  const unround = {};
  for (const [k, v] of Object.entries({ ...q, packets: 'Packet' })) if (k !== '_round') unround[k] = v;
  const as5 = {};
  for (const [k, v] of Object.entries(unround)) { if (k === 'packets') as5._round = 5; as5[k] = v; }
  r = await call(`/b/${secret}/upload?round=5&name=game.qbj`, { method: 'POST', body: JSON.stringify(unround, null, 2) });
  const unroundId = r.body.id;
  ok('a .qbj with no round added under round 5 is stored as MODAQ writes it for round 5',
    (await raw((await rowOf(unroundId)).r2_key)) === JSON.stringify(as5, null, 2));
  r = await call('/pub/' + slug + '/qbj/' + unroundId);
  const pubKeys = r.status === 200 ? Object.keys(r.body) : [];
  ok('and its public QBJ has the round in the same place', r.body._round === 5
    && pubKeys.indexOf('_round') === pubKeys.indexOf('packets') - 1, r.body);
  // its stored file gone: moving it to its own round leaves it as it was,
  // and to another says what is wrong
  d1exec(`UPDATE files SET r2_key = 't/${tid}/gone.qbj' WHERE id = ${compactId}`);
  r = await call(`${A}/files/${compactId}`, { method: 'POST', json: { round: 7 } });
  ok('moving a game whose file is gone to its own round is fine', r.status === 200 && r.body.round === 7, r.body);
  r = await call(`${A}/files/${compactId}`, { method: 'POST', json: { round: 4 } });
  ok('and to another round says the file is missing', r.status === 404, r.body);
  for (const id of [qbjId, combId, readerId, compactId, unroundId]) await call(`${A}/files/${id}`, { method: 'DELETE' });
  await tick();
}

// filenames longer than the 100-char storage cap keep their suffix, so kind
// detection still sees "_Game.json" / ".qbj" (real MODAQ names with two long
// team names overflow the cap)
{
  const longTeams = 'They Will Just Let Anyone Edit Chicago Open These Days_I have no buzzer and I must neg scream';
  r = await call(`/b/${secret}/upload?round=4&name=${encodeURIComponent(`Round_4_${longTeams}_Game.json`)}`,
    { method: 'POST', body: '{"cycles":[]}' });
  ok('long game filename keeps kind=game',
    r.status === 200 && r.body.kind === 'game' && /_Game\.json$/.test(r.body.filename)
    && r.body.filename.length <= 100, r.body);
  const q = JSON.parse(MATCH);
  q._round = 4;
  r = await call(`/b/${secret}/upload?round=4&name=${encodeURIComponent(`Round_4_${longTeams} the second.qbj`)}`,
    { method: 'POST', body: JSON.stringify(q) });
  ok('long qbj filename keeps kind=qbj',
    r.status === 200 && r.body.kind === 'qbj' && r.body.error === null
    && /^Round_4_/.test(r.body.filename) && /\.qbj$/.test(r.body.filename), r.body);
}

// rotate: old admin link dies, new one works
r = await call(A + '/rotate', { method: 'POST' });
ok('rotate mints a new secret', r.status === 200 && r.body.admin_secret.length >= 10, r.body);
const oldA = A;
A = '/a/' + r.body.admin_secret;
r = await call(oldA);
ok('old admin link dead after rotate', r.status === 404);
r = await call(A);
ok('new admin link works', r.status === 200 && r.body.tournament.slug === slug);
// rotation rewrapped the content key: the new link decrypts blobs the
// old one wrote (and the old link, being dead, can't decrypt anything)
{
  const res = await fetch(`${BASE}${A}/file?key=${encodeURIComponent(`t/${tid}/packet/1/Packet1.pdf`)}`);
  ok('rotated link still decrypts packets',
    res.status === 200 && (await res.text()) === 'PDFBYTES', res.status);
}

// bucket state carries lifetime info: the tournament's own deadline
r = await call('/b/' + secret);
ok('bucket closes with the tournament, 48h from Start',
  r.body.closes === startedAt + 48 * 3600 * 1000, r.body.closes);
ok('bucket upload count', r.body.upload_count === 7, r.body.upload_count);
r = await call(`${A}/buckets/1/reopen`, { method: 'POST' });
ok('rooms no longer reopen on their own clock', r.status === 404, r.status);
r = await call(A); // the checks below read this detail out of `r`

// admin detail reflects everything (rounds 1-3 + the label-packet round 4)
ok('admin detail files', r.status === 200 && r.body.files.length === 7 && r.body.rounds.length === 4, r.body.files);

// file delete
const delId = r.body.files.find((f) => f.filename === 'broken.qbj').id;
r = await call(`${A}/files/${delId}`, { method: 'DELETE' });
ok('delete file', r.status === 200);
r = await call(A);
ok('file gone', r.body.files.length === 6);

// bucket delete kills the link
r = await call(`${A}/buckets/${r.body.buckets[0].id}`, { method: 'DELETE' });
ok('delete bucket', r.status === 200);
r = await call('/b/' + secret);
ok('bucket link dead', r.status === 404);

// Auto-advance: with the TD's switch on, the next round opens once every
// room with a game in the current one has started it. Its own tournament,
// so the main one's round and rooms stay as the checks around it expect.
{
  const aslug = 'e2e-auto-' + Math.random().toString(36).slice(2, 6);
  const AA = '/a/' + (await call('/api/tournaments', { method: 'POST', json: { name: 'Auto', slug: aslug } })).body.admin_secret;
  // another tournament's admin link can't batch-read the main one's games
  const mainGame = (await call(A)).body.files.find((f) => f.kind === 'combined' && !f.error);
  const cross = await call(`${AA}/games?ids=${mainGame.id}`);
  ok('games batch: another tournament\'s game is missing', cross.status === 200 && !cross.body.games.length
    && JSON.stringify(cross.body.missing) === JSON.stringify([mainGame.id]), cross.body);
  const mk = async (name) => (await call(AA + '/buckets', { method: 'POST', json: { room_name: name } })).body;
  const [r1, r2, r3] = [await mk('Room 1'), await mk('Room 2'), await mk('Room 3')];
  for (const n of [1, 2]) await call(`${AA}/packet?round=${n}&name=P${n}.json`, { method: 'POST', body: '{"tossups":[]}' });
  // Room 3 has a bye in round 1
  await call(AA + '/schedule', { method: 'POST', json: { v: 1, updated: 0,
    rooms: [{ name: 'Room 1', bucket: r1.id }, { name: 'Room 2', bucket: r2.id }, { name: 'Room 3', bucket: r3.id }],
    phases: [{ name: 'P', rounds: [
      { round: 1, games: [{ room: 0, a: { team: 'A' }, b: { team: 'B' } }, { room: 1, a: { team: 'C' }, b: { team: 'D' } }], byes: [] },
      { round: 2, games: [{ room: 0, a: { team: 'A' }, b: { team: 'C' } }, { room: 2, a: { team: 'B' }, b: { team: 'D' } }], byes: [] },
    ] }] } });
  await call(AA + '/start', { method: 'POST' });
  const round = async () => (await call(AA)).body.tournament.current_round;

  // the reader warming its cache is not starting
  await fetch(`${BASE}/b/${r1.secret}/packet?round=1&warm=1`);
  ok('a warm fetch starts nothing', (await call(AA)).body.starts.length === 0);
  // switch off: rooms starting never moves the round
  r = await call(`/b/${r1.secret}/start?round=1`, { method: 'POST' });
  ok('reader says it started', r.status === 200, r.body);
  await call(`/b/${r2.secret}/start?round=1`, { method: 'POST' });
  ok('with the switch off, the round stays', await round() === 1);
  ok('the dashboard sees who started',
    (await call(AA)).body.starts.filter((x) => x.round === 1).length === 2);
  // switching it on once everyone has started opens the round there and then
  const settings = JSON.parse((await call(AA)).body.tournament.settings || '{}');
  r = await call(AA, { method: 'POST', json: { settings: { ...settings, autoAdvance: true } } });
  ok('switching on with every room started opens the next round', r.body.advanced === true && await round() === 2, r.body);
  // the public page's Live now stays on the round being played until a
  // room starts the next one
  const pubLive = async () => { await tick(); const p = (await call('/pub/' + aslug)).body; return [p.current_round, p.live_round]; };
  ok('public: round 2 open, round 1 still live', JSON.stringify(await pubLive()) === '[2,1]');

  // round 2: Room 2 has the bye, so Rooms 1 and 3 are the ones waited on.
  // Round 3 has no packet yet, so even then it stays.
  await call(`/b/${r1.secret}/start?round=2`, { method: 'POST' });
  ok('one room of two: still round 2', await round() === 2);
  ok('public: a room starting round 2 makes it live', JSON.stringify(await pubLive()) === '[2,2]');
  // a download from the uploads page counts too (rooms reading off paper)
  await fetch(`${BASE}/b/${r3.secret}/packet?round=2`);
  ok('every room started, but no packet for round 3: stays', await round() === 2);
  await call(`${AA}/packet?round=3&name=P3.json`, { method: 'POST', body: '{"tossups":[]}' });
  ok('round 3\'s packet arriving opens it, every room having started', await round() === 3);
  // the TD setting a round back wins: rooms that had already started it
  // don't push it on again
  await call(AA, { method: 'POST', json: { current_round: 1 } });
  await call(`/b/${r2.secret}/start?round=1`, { method: 'POST' });
  await fetch(`${BASE}/b/${r1.secret}/packet?round=1`);
  ok('a round the TD set back is not pushed on by old starts', await round() === 1);
  ok('public: never live past the open round', JSON.stringify(await pubLive()) === '[1,1]');
  r = await call(`/b/${r1.secret}/start?round=9`, { method: 'POST' });
  ok('a start for a round not open yet is refused', r.status === 400, r.body);
}

// Expiry. A second room, so the closed tournament's rooms can be checked
// after the first room was deleted above.
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 9' } });
const lateRoom = r.body.secret;
ok('room made after Start works at once', (await call('/b/' + lateRoom)).status === 200);

// 48h after Start everything closes together: the admin link and every
// room — rooms no longer keep a clock of their own
d1exec(`UPDATE tournaments SET started = ${Date.now() - 49 * 3600 * 1000} WHERE slug = '${slug}'`);
r = await call(A);
ok('expired admin link 410', r.status === 410 && r.body.error === 'tournament closed', r);
r = await call(A + '/rotate', { method: 'POST' });
ok('expired admin cannot rotate', r.status === 410);
r = await call('/b/' + lateRoom);
ok('its rooms close with it', r.status === 410 && r.body.error === 'room closed', r);
r = await call(`/b/${lateRoom}/upload?round=1&name=late.qbj`, { method: 'POST', body: MATCH });
ok('closed room takes no upload', r.status === 410);
for (const route of ['packet', 'roster', 'schedule']) {
  const res = await fetch(`${BASE}/b/${lateRoom}/${route}`);
  ok(`closed room serves no ${route}`, res.status === 410, res.status);
}
r = await call('/pub/' + slug);
ok('published stats survive admin expiry', r.status === 200 && r.body.name === 'E2E Open', r.body);

// ...and being past every upload deadline marks the tournament final, so
// the public page drops its poll and the answer caches for a week.
ok('expired tournament is final', r.body.final === true, r.body.final);
ok('final state caches for a week', maxAge(r.cache) >= 7 * 24 * 3600, r.cache);
r = await call('/pub/' + slug + '/rounds?n=1');
ok('final round shards cache for a week', maxAge(r.cache) >= 7 * 24 * 3600, r.cache);

// The rule itself, on tournaments backdated in D1: Start replaces the
// setup deadline whichever way it moves it.
{
  const day = 24 * 3600 * 1000;
  const make = async (tag) => {
    const sl = 'e2e-clk-' + tag + '-' + Math.random().toString(36).slice(2, 6);
    const made = (await call('/api/tournaments', { method: 'POST', json: { name: 'Clock ' + tag, slug: sl } })).body;
    return { sl, A2: '/a/' + made.admin_secret };
  };
  const now = Date.now();
  // never started: setup runs out after a week
  const idle = await make('idle');
  d1exec(`UPDATE tournaments SET created = ${now - 7 * day - 3600 * 1000} WHERE slug = '${idle.sl}'`);
  ok('never started: closed after a week of setup', (await call(idle.A2)).status === 410);
  // started on day 4: closes on day 6, days before setup would have ended
  const early = await make('early');
  d1exec(`UPDATE tournaments SET created = ${now - 4 * day}, started = ${now - 49 * 3600 * 1000} WHERE slug = '${early.sl}'`);
  ok('started on day 4: closed 48h later despite setup time left', (await call(early.A2)).status === 410);
  // started at the end of setup: runs 48h past the week
  const late = await make('late');
  d1exec(`UPDATE tournaments SET created = ${now - 8 * day}, started = ${now - 3600 * 1000} WHERE slug = '${late.sl}'`);
  r = await call(late.A2);
  ok('started late in setup: open 48h from Start, past the week',
    r.status === 200 && r.body.tournament.closes === now - 3600 * 1000 + 48 * 3600 * 1000, r.body);
}

summary('e2e');
