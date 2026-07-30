// e2e_worker.js — end-to-end smoke test against a locally running Worker:
//   cd worker && npx wrangler dev --local --port 8799   (schema applied)
// then: node tests/e2e_worker.js
//
// Exercises the full TO -> moderator -> public flow. No login anywhere:
// the admin link secret (minted at creation) is the TO's credential.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buzzSettings, buzzToken } from '../app/js/buzzkey.js';

const WORKER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker');

const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  const res = await fetch(BASE + path, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

const MATCH = JSON.stringify({
  tossups_read: 20, _round: 1,
  match_teams: [
    { team: { name: 'Alpha' }, bonus_points: 30,
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20,
        answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: 'Beta' }, bonus_points: 0,
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20,
        answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); }
  else { console.error('FAIL', name, extra ?? ''); process.exitCode = 1; }
}

// bad admin link is a uniform 404
let r = await call('/a/abcdefghjkmnpqrstuvw');
ok('bad admin link 404', r.status === 404);

// create tournament: open, returns the admin secret + expiry
const slug = 'e2e-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'E2E Open', slug } });
ok('create tournament', r.status === 200 && r.body.id > 0 && r.body.admin_secret.length >= 10, r.body);
ok('creation reports 48h expiry',
  r.body.closes > Date.now() + 47 * 3600 * 1000 && r.body.closes < Date.now() + 49 * 3600 * 1000,
  r.body.closes);
let A = '/a/' + r.body.admin_secret;

r = await call('/api/tournaments', { method: 'POST', json: { name: 'dupe', slug } });
ok('duplicate slug rejected', r.status === 409);

// detail hides the secret and echoes expiry
r = await call(A);
ok('admin detail', r.status === 200 && r.body.tournament.slug === slug, r.body);
ok('detail omits secrets', r.body.tournament.admin_secret === undefined && r.body.tournament.creator_ip === undefined);

// bucket
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
ok('create bucket', r.status === 200 && r.body.secret.length >= 10, r.body);
const secret = r.body.secret;

// packet upload + roster
r = await call(`${A}/packet?round=1&name=Packet1.pdf`, { method: 'POST', body: 'PDFBYTES' });
ok('upload packet', r.status === 200, r.body);
r = await call(`${A}/roster?name=roster.qbj`, {
  method: 'POST',
  body: JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
    { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Ann' }] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] },
  ] }] }),
});
ok('upload roster', r.status === 200, r.body);

// moderator flow
r = await call('/b/' + secret);
ok('bucket state', r.status === 200 && r.body.room === 'Room 1' && r.body.current_round === 1, r.body);
ok('bucket sees packet', r.body.packet && r.body.packet.packet_name === 'Packet1.pdf', r.body.packet);

r = await call(`/b/${secret}/upload?round=1&name=Round_1_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH });
ok('mod uploads qbj', r.status === 200 && r.body.kind === 'qbj' && r.body.error === null, r.body);

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

{
  const res = await fetch(`${BASE}/pub/${slug}/schedule`);
  const sj = await res.json();
  ok('public schedule served', res.status === 200 && sj.rooms.length === 2
    && sj.phases[0].rounds[0].games[0].a.team === 'Alpha', sj);
  ok('public schedule briefly cacheable',
    (res.headers.get('cache-control') || '').includes('max-age=60'));
}
r = await call(A + '/schedule', { method: 'DELETE' });
ok('schedule deleted', r.status === 200);
r = await call('/pub/' + slug + '/schedule');
ok('deleted schedule 404', r.status === 404);
r = await call('/pub/' + slug);
ok('schedule stamp cleared', r.body.schedule === null, r.body.schedule);
r = await call(A + '/schedule', { method: 'POST', json: SCHED });
ok('schedule restored', r.status === 200);

// broadcasts: one whole-list write on the tournament row, filtered per
// audience on the way out. Who else received a message never reaches a
// viewer, and nothing expired is ever served.
const ANN_HOUR = 3600000;
const annNow = Date.now();
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 2' } });
ok('create second room', r.status === 200, r.body);
const room2 = { id: r.body.id, secret: r.body.secret };
r = await call(A);
const room1Id = r.body.buckets[0].id;

const ANN = [
  { id: 'bpub', text: 'lunch 12:15-1:00, round 6 reads at 1:05', level: 'note',
    pub: true, rooms: true, created: annNow - 60000, expires: annNow + ANN_HOUR },
  { id: 'bone', text: 'send round 5 scores', level: 'alert',
    pub: false, rooms: [room1Id], created: annNow, expires: annNow + ANN_HOUR },
  { id: 'bgone', text: 'already over', level: 'note',
    pub: true, rooms: true, created: annNow - ANN_HOUR, expires: annNow - 1 },
];
r = await call(A, { method: 'POST', json: { announce: ANN } });
ok('set broadcasts', r.status === 200, r.body);

r = await call('/pub/' + slug);
ok('public page gets its broadcast',
  r.body.announce.length === 1 && r.body.announce[0].id === 'bpub', r.body.announce);
ok('public broadcast hides its audience',
  r.body.announce[0].pub === undefined && r.body.announce[0].rooms === undefined,
  r.body.announce[0]);

r = await call('/b/' + secret);
ok('targeted room gets both, alert first',
  r.body.announce.map((x) => x.id).join(',') === 'bone,bpub', r.body.announce);
r = await call('/b/' + room2.secret);
ok('other room gets only the tournament-wide one',
  r.body.announce.map((x) => x.id).join(',') === 'bpub', r.body.announce);
ok('expired broadcast served to nobody',
  !r.body.announce.some((x) => x.id === 'bgone'), r.body.announce);

// the reader page never polls: its upload response carries them instead
r = await call(`/b/${room2.secret}/upload?round=1&name=bcast.qbj`,
  { method: 'POST', body: MATCH });
ok('upload response carries broadcasts',
  r.status === 200 && r.body.announce.length === 1 && r.body.announce[0].id === 'bpub',
  r.body.announce);
const annFileId = r.body.id;

// validation
r = await call(A, { method: 'POST', json: { announce: [
  { text: 'no expiry', pub: true, rooms: true, created: annNow }] } });
ok('broadcast without an expiry rejected', r.status === 400 && /expiry/.test(r.body.error), r.body);
r = await call(A, { method: 'POST', json: { announce: [
  { text: 'nobody', pub: false, rooms: false, created: annNow, expires: annNow + ANN_HOUR }] } });
ok('broadcast without an audience rejected', r.status === 400, r.body);
r = await call(A, { method: 'POST', json: { announce: [
  { text: '   ', pub: true, rooms: true, created: annNow, expires: annNow + ANN_HOUR }] } });
ok('empty broadcast rejected', r.status === 400, r.body);
r = await call(A, { method: 'POST', json: { announce: 'nope' } });
ok('non-array announce rejected', r.status === 400, r.body);
r = await call(A, { method: 'POST', json: { announce: Array.from({ length: 9 }, (_, i) => (
  { text: 'msg ' + i, pub: true, rooms: true, created: annNow, expires: annNow + ANN_HOUR })) } });
ok('broadcast cap enforced', r.status === 400 && /8/.test(r.body.error), r.body);
r = await call('/b/' + secret);
ok('rejected writes leave the live list alone',
  r.body.announce.map((x) => x.id).join(',') === 'bone,bpub', r.body.announce);

// text is capped, and an expiry can never outlive the tournament itself
r = await call(A, { method: 'POST', json: { announce: [
  { id: 'blong', text: 'x'.repeat(300), pub: true, rooms: true,
    created: annNow, expires: annNow + 90 * ANN_HOUR }] } });
ok('overlong broadcast accepted', r.status === 200, r.body);
r = await call(A);
{
  const stored = JSON.parse(r.body.tournament.announce)[0];
  ok('broadcast text capped at 200', stored.text.length === 200, stored.text.length);
  ok('broadcast expiry clamped to tournament close',
    stored.expires === r.body.tournament.closes, [stored.expires, r.body.tournament.closes]);
}

// clear, and put the tournament back the way the rest of the run expects it
r = await call(A, { method: 'POST', json: { announce: [] } });
ok('broadcasts cleared', r.status === 200);
r = await call('/pub/' + slug);
ok('cleared broadcasts leave the public page empty', r.body.announce.length === 0, r.body.announce);
r = await call(`${A}/files/${annFileId}`, { method: 'DELETE' });
ok('broadcast test file removed', r.status === 200);
r = await call(`${A}/buckets/${room2.id}`, { method: 'DELETE' });
ok('second room removed', r.status === 200);

// buzzpoints gate: settings.buzz drives the qpacket route; the public
// state exposes only the mode + a salt-derived buzz_v, never salt/hash.
// Password is the only mode, and rounds unlock only once every
// scheduled game is in.
r = await call('/pub/' + slug);
ok('buzz off by default', r.body.buzz === null && r.body.buzz_v === null
  && r.body.packet_rounds.length === 0, r.body.buzz);
{
  const res = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`);
  ok('qpacket 404 when buzz off', res.status === 404);
}
const buzzSalt = 'testsalt';
const buzzHash = createHash('sha256').update(buzzSalt + ':hunter2').digest('hex');
r = await call(A, { method: 'POST', json: { settings: {
  gameFormat: 'acf', buzz: { mode: 'password', salt: buzzSalt, hash: buzzHash } } } });
ok('buzz password set', r.status === 200);
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
r = await call(A, { method: 'POST', json: { settings: {
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
r = await call(A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: kdfSettings } } });
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
  const open = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`);
  ok('qpacket 404 for legacy public mode', open.status === 404);
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
  bonuses: [{ leadin: 'b1 text', metadata: 'World History' }],
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
  && r.body.rounds['3'].t[2].c === 'Math' && r.body.rounds['3'].t[2].s === ''
  && r.body.rounds['3'].t[3] === null, r.body.rounds['3']);

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
const tid = (await call(A)).body.tournament.id;
execSync(`npx wrangler r2 object delete qb-td-data/t/${tid}/catmap.json --local`,
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

r = await call('/pub/' + slug);   // the sections below read files off this

{
  const res = await fetch(`${BASE}/pub/${slug}/qbj/${r.body.files[0].id}`);
  const text = await res.text();
  ok('public qbj download', res.status === 200 && JSON.parse(text).tossups_read === 20);
  const rr = await fetch(`${BASE}/pub/${slug}/roster`);
  ok('public roster download', rr.status === 200 && (await rr.text()).includes('Alpha'));
}

// combined stats bundle: built on upload, one entry per valid qbj
r = await call('/pub/' + slug);
const v1 = r.body.version;
ok('pub state has version', typeof v1 === 'string' && v1.includes(':'), v1);
r = await call('/pub/' + slug + '/bundle');
ok('bundle served', r.status === 200 && r.body.entries.length === 1, r.body);
ok('bundle entry carries room/round/qbj',
  r.body.entries[0].room === 'Room 1' && r.body.entries[0].round === 1
  && r.body.entries[0].qbj.tossups_read === 20, r.body.entries[0]);

const MATCH2 = MATCH.replace('"_round": 1', '"_round": 2').replace('_round":1', '_round":2');
r = await call(`/b/${secret}/upload?round=2&name=Round_2_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH2 });
ok('second qbj uploads', r.status === 200 && r.body.error === null, r.body);
const secondQbjId = r.body.id;

r = await call('/pub/' + slug);
ok('version moves on upload', r.body.version !== v1, r.body.version);
r = await call('/pub/' + slug + '/bundle');
ok('bundle grows', r.body.entries.length === 2, r.body.entries.length);

r = await call(`${A}/files/${secondQbjId}`, { method: 'DELETE' });
ok('delete second qbj', r.status === 200);
r = await call('/pub/' + slug + '/bundle');
ok('bundle shrinks on delete', r.body.entries.length === 1, r.body.entries.length);

// TO bundle rebuild round-trip
r = await call(`${A}/bundle`, {
  method: 'POST',
  body: JSON.stringify({ entries: [{ id: 999, round: 1, room: 'Room 1', filename: 'x.qbj', qbj: JSON.parse(MATCH) }] }),
});
ok('bundle rebuild accepted', r.status === 200 && r.body.entries === 1, r.body);
r = await call('/pub/' + slug + '/bundle');
ok('rebuilt bundle served', r.body.entries[0].id === 999, r.body.entries[0]);

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

  r = await call('/pub/' + slug + '/bundle');
  const entry = r.body.entries.find((e) => e.id === cid);
  ok('bundle stores only the qbj half',
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
  ok('part=qbj named .qbj',
    (qres.headers.get('content-disposition') || '').includes('Round_3_Alpha_Beta.qbj'));
  const gres = await fetch(fileUrl('&part=game&dl=Round_3_Alpha_Beta_Game.json'));
  const gtext = await gres.text();
  ok('admin part=game serves the game state',
    gres.status === 200 && JSON.parse(gtext).cycles.length === 0 && gtext.includes('SECRETQUESTIONTEXT'));
  ok('part=game named _Game.json',
    (gres.headers.get('content-disposition') || '').includes('Round_3_Alpha_Beta_Game.json'));
  const noPart = await fetch(fileUrl('&dl=x.qbtd.json'));
  ok('no part still serves the raw blob', noPart.status === 200 && (await noPart.text()).includes('"qbj"'));
  const badPart = await fetch(`${BASE}${A}/file?key=${encodeURIComponent(cfile.r2_key.replace(/^t\/\d+/, 't/999999'))}&part=qbj`);
  ok('part respects the ownership boundary', badPart.status === 403);
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

// bucket state carries lifetime info
r = await call('/b/' + secret);
ok('bucket closes stamp ~48h out',
  r.body.closes > Date.now() + 47 * 3600 * 1000 && r.body.closes < Date.now() + 49 * 3600 * 1000,
  r.body.closes);
ok('bucket upload count', r.body.upload_count === 7, r.body.upload_count);

// bucket expiry: backdate the bucket, every mod route dies with "room closed"
execSync(
  `npx wrangler d1 execute qb-td --local --command "UPDATE buckets SET created = 1 WHERE secret = '${secret}'"`,
  { cwd: WORKER_DIR, stdio: 'ignore' },
);
r = await call('/b/' + secret);
ok('expired bucket state 410', r.status === 410 && r.body.error === 'room closed', r);
r = await call(`/b/${secret}/upload?round=1&name=late.qbj`, { method: 'POST', body: MATCH });
ok('expired bucket upload 410', r.status === 410);
{
  const res = await fetch(`${BASE}/b/${secret}/packet`);
  ok('expired bucket packet 410', res.status === 410);
  const rr = await fetch(`${BASE}/b/${secret}/roster`);
  ok('expired bucket roster 410', rr.status === 410);
  const sr = await fetch(`${BASE}/b/${secret}/schedule`);
  ok('expired bucket schedule 410', sr.status === 410);
}
// the TO's own access is unaffected by room expiry
r = await call(A);
ok('TO access survives room expiry', r.status === 200);

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

// admin expiry: backdate the tournament — admin routes die with 410,
// published stats stay up
execSync(
  `npx wrangler d1 execute qb-td --local --command "UPDATE tournaments SET created = 1 WHERE slug = '${slug}'"`,
  { cwd: WORKER_DIR, stdio: 'ignore' },
);
r = await call(A);
ok('expired admin link 410', r.status === 410 && r.body.error === 'tournament closed', r);
r = await call(A + '/rotate', { method: 'POST' });
ok('expired admin cannot rotate', r.status === 410);
r = await call('/pub/' + slug);
ok('published stats survive admin expiry', r.status === 200 && r.body.name === 'E2E Open', r.body);

console.log(passed + ' e2e checks passed' + (process.exitCode ? ' (with failures)' : ''));
