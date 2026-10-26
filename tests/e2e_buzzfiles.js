// e2e_buzzfiles.js — buzzpoints packets as static files (worker.js) end to
// end against a locally running Worker:
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled
// then: node tests/e2e_buzzfiles.js
//
// What it pins down: a finished round's packet becomes a file encrypted
// under the buzzpoints key when the upload that finishes the round lands,
// and not before; /pub/:slug/unlock checks the password and hands out that
// key, never on a wrong password; the file opens with it to the packet
// itself; the public state lists the file (and carries the key only with
// No password, where the cron makes the files); a new password means a new
// key and new files; a packet replaced drops its round's file.

import { webcrypto } from 'node:crypto';
import { BASE, call, d1row, r2get, tick, ok, summary } from './e2e_lib.js';
import { buzzCredentials } from '../app/js/buzzkey.js';

const subtle = webcrypto.subtle;
const rnd = () => Math.random().toString(36).slice(2, 8);
const PACKET = (round) => JSON.stringify({
  tossups: [1, 2].map((i) => ({ question: `Buzzfile tossup ${i} round ${round}.`, answer: `answer ${round}-${i}` })),
  bonuses: [{ leadin: `Buzzfile bonus round ${round}.`, parts: ['p1', 'p2', 'p3'], answers: ['a', 'b', 'c'], values: [10, 10, 10] }],
});
const MATCH = (round, a, b) => JSON.stringify({
  tossups_read: 20, _round: round,
  match_teams: [
    { team: { name: a }, bonus_points: 30, match_players: [{ player: { name: a + ' 1' }, tossups_heard: 20, answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: b }, bonus_points: 0, match_players: [{ player: { name: b + ' 1' }, tossups_heard: 20, answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});
const row = (id) => d1row(`SELECT buzz_key_enc, buzz_pub FROM tournaments WHERE id = ${id}`);
const pubOf = (id) => JSON.parse(row(id).buzz_pub || '{}');
const unlock = (slug, token) => fetch(`${BASE}/pub/${slug}/unlock`, { headers: { Authorization: 'Buzz ' + token } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
async function open(keyB64, bytes) {
  const key = await subtle.importKey('raw', Buffer.from(keyB64, 'base64'), 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))).toString('utf8');
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); }
}

// a tournament: two rooms, packets for rounds 1 and 2, a password, started
async function make(password, rounds = 2) {
  const slug = 'bzf-' + rnd();
  let r = await call('/api/tournaments', { method: 'POST', json: { name: 'Buzz Files ' + slug, slug } });
  const T = { slug, id: r.body.id, A: '/a/' + r.body.admin_secret, rooms: [] };
  for (const n of ['Room 1', 'Room 2']) T.rooms.push((await call(T.A + '/buckets', { method: 'POST', json: { room_name: n } })).body.secret);
  for (let n = 1; n <= rounds; n++) await call(`${T.A}/packet?round=${n}&name=P${n}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: PACKET(n) });
  const cred = await buzzCredentials(password);
  T.token = cred.token;
  r = await call(T.A, { method: 'POST', json: { published: true, buzz_token: cred.token, settings: { gameFormat: 'acf', buzz: cred.settings } } });
  await call(T.A + '/start', { method: 'POST' });
  return T;
}
const upload = (T, i, round) => call(`/b/${T.rooms[i]}/upload?round=${round}&name=Round_${round}_A${i}_B${i}.qbj`, { method: 'POST', body: MATCH(round, 'A' + i, 'B' + i) });

/* ----- a round's file, made by the upload that finishes it ----- */
const T = await make('buzzfile-pw-1');
await upload(T, 0, 1);
ok('one room in: no file yet (the round is still being played)', !pubOf(T.id)['1']);
await upload(T, 1, 1);
const e1 = pubOf(T.id)['1'];
ok('the upload that finishes round 1 makes its file', !!e1 && /^[0-9a-f]{32}$/.test(e1.h) && e1.live === 0, row(T.id));
ok('a buzzpoints key exists, stored encrypted', !!row(T.id).buzz_key_enc && !row(T.id).buzz_key_enc.includes('{'));

/* ----- unlock: the password, then the key ----- */
let u = await unlock(T.slug, 'not-the-token');
ok('a wrong password: 401 and no key', u.status === 401 && !(u.body && u.body.key), u);
u = await unlock(T.slug, T.token);
ok('the right password: the key', u.status === 200 && u.body.ok === true && typeof u.body.key === 'string' && Buffer.from(u.body.key, 'base64').length === 32, u);
const key1 = u.body.key;
const text = await open(key1, r2get(`t/${T.id}/buzzpub/1.bin`));
ok('the file opens with that key to the packet itself', text === PACKET(1), text.slice(0, 80));

/* ----- the public state lists it ----- */
await tick();
let st = (await call('/pub/' + T.slug)).body;
ok('the state lists round 1\'s file by hash', st.buzz_files && st.buzz_files['1'] === e1.h, st.buzz_files);
ok('and never the key, behind a password', st.buzz_key === undefined);
ok('round 2, not played, has no file', st.buzz_files['2'] === undefined);

/* ----- a new password: a new key, new files ----- */
const cred2 = await buzzCredentials('buzzfile-pw-2');
await call(T.A, { method: 'POST', json: { buzz_token: cred2.token, settings: { gameFormat: 'acf', buzz: cred2.settings } } });
ok('a new password drops the key and the files', row(T.id).buzz_key_enc === null && row(T.id).buzz_pub === null, row(T.id));
u = await unlock(T.slug, T.token);
ok('the old password no longer unlocks', u.status === 401, u.status);
u = await unlock(T.slug, cred2.token);
ok('the new one hands out a different key', u.status === 200 && u.body.key && u.body.key !== key1);
const e1b = await until(() => pubOf(T.id)['1']);
ok('and round 1\'s file is made again under it (after the unlock)', !!e1b && e1b.h !== e1.h, pubOf(T.id));
ok('which the new key opens', (await open(u.body.key, r2get(`t/${T.id}/buzzpub/1.bin`))) === PACKET(1));

/* ----- a packet replaced: its file goes ----- */
await call(`${T.A}/packet?round=1&name=P1b.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: PACKET(1).replace('Buzzfile', 'Replaced') });
ok('replacing round 1\'s packet drops its file', !pubOf(T.id)['1'], pubOf(T.id));
u = await unlock(T.slug, cred2.token);
const e1c = await until(() => pubOf(T.id)['1']);
ok('the next unlock makes it from the new packet', !!e1c && (await open(u.body.key, r2get(`t/${T.id}/buzzpub/1.bin`))).includes('Replaced'));

/* ----- No password: the cron makes the files, the state carries the key ----- */
const O = await make('buzzfile-open');
await call(O.A, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: JSON.parse(d1row(`SELECT settings FROM tournaments WHERE id = ${O.id}`).settings).buzz, statsOpen: true } } });
await upload(O, 0, 1);
await upload(O, 1, 1);
await tick(); await tick();
st = (await call('/pub/' + O.slug)).body;
ok('No password: the state lists the file and carries the key', st.buzz === 'open' && st.buzz_files && st.buzz_files['1'] && typeof st.buzz_key === 'string', { buzz: st.buzz, files: st.buzz_files, key: !!st.buzz_key });
ok('which opens it', st.buzz_key && (await open(st.buzz_key, r2get(`t/${O.id}/buzzpub/1.bin`))) === PACKET(1));

/* ----- a new password: the hub has every finished round made at once ----- */
const M = await make('buzzfile-many', 8);
for (let n = 1; n <= 8; n++) {
  await call(M.A, { method: 'POST', json: { current_round: n } });
  await upload(M, 0, n); await upload(M, 1, n);
}
ok('eight finished rounds, eight files', Object.keys(pubOf(M.id)).length === 8, Object.keys(pubOf(M.id)));
const cred3 = await buzzCredentials('buzzfile-many-2');
await call(M.A, { method: 'POST', json: { buzz_token: cred3.token, settings: { gameFormat: 'acf', buzz: cred3.settings } } });
ok('a new password drops them', row(M.id).buzz_pub === null);
let r = await call(M.A + '/buzzfiles', { method: 'POST' });
ok('the hub\'s first call makes six and says two are left', r.status === 200 && r.body.made === 6 && r.body.left === 2, r.body);
r = await call(M.A + '/buzzfiles', { method: 'POST' });
ok('its second makes the rest', r.body.made === 2 && r.body.left === 0 && Object.keys(pubOf(M.id)).length === 8, r.body);
r = await call(M.A + '/buzzfiles', { method: 'POST' });
ok('then there is nothing to do', r.body.made === 0 && r.body.left === 0, r.body);
u = await unlock(M.slug, cred3.token);
ok('and they open with the new password\'s key', (await open(u.body.key, r2get(`t/${M.id}/buzzpub/8.bin`))) === PACKET(8));
r = await call('/a/not-a-real-admin-secret/buzzfiles', { method: 'POST' });
ok('only the admin link can ask', r.status === 404 || r.status === 401, r.status);

/* ----- No password, then a password again: a new key ----- */
const openKey = st.buzz_key;
const settingsO = JSON.parse(d1row(`SELECT settings FROM tournaments WHERE id = ${O.id}`).settings);
delete settingsO.statsOpen;
await call(O.A, { method: 'POST', json: { settings: settingsO } });
ok('back to a password: the key that was public is dropped', row(O.id).buzz_key_enc === null && row(O.id).buzz_pub === null, row(O.id));
await call(O.A + '/buzzfiles', { method: 'POST' });
let opened = true;
try { await open(openKey, r2get(`t/${O.id}/buzzpub/1.bin`)); } catch (e) { opened = false; }
ok('and the new file does not open with it', !opened);
await tick();
st = (await call('/pub/' + O.slug)).body;
ok('the state no longer carries a key', st.buzz_key === undefined && st.buzz === 'password', { buzz: st.buzz, key: !!st.buzz_key });

summary('buzzpoints files e2e');
