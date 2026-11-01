// yapp_kept.mjs — a .docx packet goes to YAPP once (worker.js "YAPP's
// parse, kept"), in process (tests/inproc_worker.mjs) against a fake YAPP
// on a local port that counts what it is sent. It answers 400 to a body
// starting REFUSE (a file YAPP can't read), 503 while `down`, and
// otherwise a YAPP-shaped packet whose tossup is the body's own text, so
// each answer shows which file it was made from.
//
// What it pins down: the upload is the one call; the reader, the hub's
// preview, the public buzzpoints route, its static files, a set's editor
// and a mirror's rooms all get that parse, and the downloads the file; a
// file replaced under the same name is parsed again; one YAPP refused is
// never sent again; one it couldn't be reached for is served as the file
// and parsed when YAPP is back; a packet from before this (no parse kept)
// is parsed the first time it is asked for, once; buzzpoints files from
// before are made again from the parse, a JSON packet's only marked; the
// category backfill doesn't ask again for what it has, and waits before
// asking again for what it couldn't get.
// Run: node tests/yapp_kept.mjs (part of npm test).

import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { workerHarness } from './inproc_worker.mjs';
import { buzzCredentials } from '../app/js/buzzkey.js';

let calls = 0;
let down = false;
let busy = 0; // this many 429s first
const yapp = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    calls++;
    const text = Buffer.concat(chunks).toString('utf8');
    if (down) { res.writeHead(503); res.end('down'); return; }
    if (busy > 0) { busy--; res.writeHead(429, { 'Retry-After': '1' }); res.end('slow down'); return; }
    if (text.startsWith('REFUSE')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errorMessages: ['Parse Error.'] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tossups: [{ question: 'Tossup from ' + text, answer: 'answer', metadata: 'Literature, American' }],
      bonuses: [{ leadin: 'Bonus from ' + text, parts: ['p1', 'p2', 'p3'], answers: ['a', 'b', 'c'], values: [10, 10, 10],
        difficultyModifiers: ['e', 'm', 'h'], metadata: 'Science, Biology' }],
    }));
  });
});
await new Promise((r) => yapp.listen(0, '127.0.0.1', r));
const YAPP_URL = `http://127.0.0.1:${yapp.address().port}/yapp/api/parse?modaq=true`;

const w = await workerHarness(undefined, { YAPP_URL });
const { call, sql, keys, rawObj } = w;
let failures = 0;
let passed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + label); return; }
  failures++;
  console.error('FAIL ' + label + (detail !== undefined ? '\n    ' + JSON.stringify(detail).slice(0, 400) : ''));
}
// how many calls `fn` sends YAPP
async function sent(fn) {
  const before = calls;
  const out = await fn();
  return { out, n: calls - before };
}
const enc = encodeURIComponent;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isJson = (r) => (r.headers['content-type'] || '').startsWith('application/json');

/* ---------- a tournament: two rooms, a password, started ---------- */

const T = (await call('/api/tournaments', { method: 'POST', json: { name: 'Kept Parse', slug: 'kept-parse' } })).body;
const A = '/a/' + T.admin_secret;
const tid = T.id;
const rooms = [];
for (const n of ['Room 1', 'Room 2']) rooms.push((await call(A + '/buckets', { method: 'POST', json: { room_name: n } })).body.secret);
const putPacket = (round, name, body, type = DOCX) =>
  call(`${A}/packet?round=${round}&name=${enc(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body });
const packetKey = (round) => sql('SELECT packet_r2_key FROM rounds WHERE tournament_id = ? AND number = ?', tid, round)[0].packet_r2_key;
const keptKey = (round) => packetKey(round).replace('/packet/', '/parsed/');
const reader = (k, round) => call(`/b/${rooms[k]}/packet?round=${round}&warm=1&parsed=1`);

/* ---------- the upload is the one call ---------- */

let s = await sent(() => putPacket(1, 'Round 1.docx', 'R1 first text'));
ok('a .docx upload sends YAPP the packet once', s.out.status === 200 && s.n === 1, { status: s.out.status, n: s.n });
const kept1 = rawObj(keptKey(1));
ok('and keeps the parse beside it, encrypted, stamped with the packet\'s etag',
  !!kept1 && kept1.custom.enc === '1' && kept1.custom.src === w.etag(packetKey(1)), kept1 && kept1.custom);
ok('its categories come from that parse', (() => {
  const m = JSON.parse(w.raw(`t/${tid}/catmap.json`) || '{}');
  return m.rounds && m.rounds['1'] && m.rounds['1'].t[0].c === 'Literature' && m.rounds['1'].b[0].c === 'Science';
})(), w.raw(`t/${tid}/catmap.json`));

await call(A + '/start', { method: 'POST' });
const cred = await buzzCredentials('kept-parse-pw');
await call(A, { method: 'POST', json: { published: true, buzz_token: cred.token, settings: { gameFormat: 'acf', buzz: cred.settings } } });

s = await sent(async () => [await reader(0, 1), await reader(1, 1), await reader(0, 1)]);
ok('three reader loads of the round: YAPP is not asked', s.n === 0, s.n);
ok('each gets the parse as JSON', s.out.every((r) => r.status === 200 && isJson(r) && r.body.tossups[0].question === 'Tossup from R1 first text'),
  s.out.map((r) => [r.status, r.headers['content-type']]));
let r = await call(`/b/${rooms[0]}/packet?round=1`);
ok('the room\'s download is still the .docx itself, by its name',
  r.status === 200 && r.text === 'R1 first text' && r.headers['content-type'] === DOCX && /Round 1\.docx/.test(r.headers['content-disposition'] || ''),
  { status: r.status, type: r.headers['content-type'], cd: r.headers['content-disposition'] });

s = await sent(() => call(`${A}/file?key=${enc(packetKey(1))}&parsed=1`));
ok('the hub\'s preview gets the parse, without asking YAPP', s.n === 0 && isJson(s.out) && s.out.body.tossups[0].question === 'Tossup from R1 first text', s.out.status);
r = await call(`${A}/file?key=${enc(packetKey(1))}&dl=${enc('Round 1.docx')}`);
ok('the hub\'s download is the .docx', r.text === 'R1 first text' && r.headers['content-type'] === DOCX, r.headers);
r = await call(`${A}/file?key=${enc(`t/${tid}/schedule.json`)}&parsed=1`);
ok('parsed=1 on a file that is not a packet changes nothing', r.status === 404, r.status);

/* ---------- a JSON packet: as it was ---------- */

const JSON_PACKET = JSON.stringify({ tossups: [{ question: 'JSON tossup', answer: 'x' }], bonuses: [] });
s = await sent(() => putPacket(4, 'Round 4.json', JSON_PACKET, 'application/json'));
ok('a JSON upload sends YAPP nothing', s.n === 0 && s.out.status === 200, s);
ok('and keeps no parse', !keys().some((k) => k.startsWith(`t/${tid}/parsed/4/`)));
await call(A, { method: 'POST', json: { current_round: 4 } });
r = await reader(0, 4);
ok('the reader gets the packet as stored', r.status === 200 && r.text === JSON_PACKET, r.text.slice(0, 80));

/* ---------- replaced under the same name: parsed again ---------- */

s = await sent(() => putPacket(1, 'Round 1.docx', 'R1 second text'));
ok('a new file under the same name is parsed again', s.n === 1 && rawObj(keptKey(1)).custom.src === w.etag(packetKey(1)), s.n);
r = await reader(0, 1);
ok('and the reader gets the new parse, never the old', r.body && r.body.tossups[0].question === 'Tossup from R1 second text', r.body);

/* ---------- a file YAPP refuses: asked once ---------- */

s = await sent(() => putPacket(2, 'Round 2.docx', 'REFUSE this one'));
ok('a file YAPP refuses: the upload still lands, one call', s.out.status === 200 && s.n === 1, s);
ok('the refusal is kept under the packet\'s etag', rawObj(keptKey(2)) && rawObj(keptKey(2)).custom.fail === '400', rawObj(keptKey(2)) && rawObj(keptKey(2)).custom);
s = await sent(async () => [await reader(0, 2), await reader(1, 2)]);
ok('the reader is told the parser could not read it, and YAPP is not asked again',
  s.n === 0 && s.out.every((x) => x.status === 422 && /could not read/.test(x.body.error)), s.out.map((x) => [x.status, x.body]));
s = await sent(async () => { for (let i = 0; i < 3; i++) await call(A); });
ok('hub loads don\'t send it again', s.n === 0, s.n);

/* ---------- YAPP down: the file, then the parse once it is back ---------- */

down = true;
s = await sent(() => putPacket(3, 'Round 3.docx', 'R3 text'));
ok('YAPP down at upload: the upload lands, no parse kept', s.out.status === 200 && !rawObj(keptKey(3)), s.out.status);
s = await sent(() => reader(0, 3));
ok('the reader asks it once more and, still down, gets the .docx to parse itself',
  s.n === 1 && s.out.status === 200 && s.out.text === 'R3 text' && s.out.headers['content-type'] === DOCX, { n: s.n, type: s.out.headers['content-type'] });
down = false;
s = await sent(async () => [await reader(0, 3), await reader(1, 3), await reader(0, 3)]);
ok('YAPP back: the next load parses it, and that is the last call', s.n === 1 && s.out.every((x) => isJson(x) && x.body.tossups[0].question === 'Tossup from R3 text'), s.n);

/* ---------- a packet from before: parsed when first asked for ---------- */

const legacyKey = `t/${tid}/packet/5/Legacy.docx`;
w.setRaw(legacyKey, 'R5 legacy', { contentType: DOCX });
sql('INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?, ?, ?, ?) RETURNING number', tid, 5, legacyKey, 'Legacy.docx');
await call(A, { method: 'POST', json: { current_round: 5 } });
s = await sent(async () => [await reader(0, 5), await reader(1, 5), await reader(0, 5)]);
ok('a packet stored before this is parsed on its first load, once', s.n === 1 && s.out.every((x) => isJson(x) && x.body.tossups[0].question === 'Tossup from R5 legacy'), s.n);
ok('(its parse is encrypted under the tournament\'s key, though the old file was stored plain)', rawObj(`t/${tid}/parsed/5/Legacy.docx`) && rawObj(`t/${tid}/parsed/5/Legacy.docx`).custom.enc === '1');

/* ---------- YAPP busy (429): wait and try again ---------- */

const busyKey = `t/${tid}/packet/8/Busy.docx`;
w.setRaw(busyKey, 'R8 busy', { contentType: DOCX });
sql('INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?, ?, ?, ?) RETURNING number', tid, 8, busyKey, 'Busy.docx');
await call(A, { method: 'POST', json: { current_round: 8 } });
busy = 1;
s = await sent(() => reader(0, 8));
ok('YAPP busy on a first load: the Worker waits, asks again, and the reader gets the parse',
  s.n === 2 && isJson(s.out) && s.out.body.tossups[0].question === 'Tossup from R8 busy', { n: s.n, status: s.out.status });
s = await sent(() => reader(1, 8));
ok('and it is kept', s.n === 0 && isJson(s.out), s.n);
await call(A, { method: 'POST', json: { current_round: 5 } });

/* ---------- moved rounds: the parse goes with the packet ---------- */

s = await sent(() => call(A + '/packets/move', { method: 'POST', json: { from: 1, to: 3 } }));
ok('swapping two rounds asks YAPP nothing', s.out.status === 200 && s.n === 0, s.out.body);
r = await reader(0, 3);
ok('round 3 now reads round 1\'s packet', r.body && r.body.tossups[0].question === 'Tossup from R1 second text', r.body);
r = await reader(0, 1);
ok('and round 1 round 3\'s', r.body && r.body.tossups[0].question === 'Tossup from R3 text', r.body);
await call(A + '/packets/move', { method: 'POST', json: { from: 3, to: 1 } });

/* ---------- the public buzzpoints route and its files ---------- */

const MATCH = (round, a, b) => JSON.stringify({
  tossups_read: 20, _round: round,
  match_teams: [
    { team: { name: a }, bonus_points: 30, match_players: [{ player: { name: a + ' 1' }, tossups_heard: 20, answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: b }, bonus_points: 0, match_players: [{ player: { name: b + ' 1' }, tossups_heard: 20, answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});
const finish = async (round) => {
  for (let k = 0; k < 2; k++) await call(`/b/${rooms[k]}/upload?round=${round}&name=Round_${round}_A${k}_B${k}.qbj`, { method: 'POST', body: MATCH(round, 'A' + k, 'B' + k) });
};
const pubOf = () => JSON.parse(sql('SELECT buzz_pub FROM tournaments WHERE id = ?', tid)[0].buzz_pub || '{}');
const unlockKey = async () => (await call('/pub/kept-parse/unlock', { headers: { Authorization: 'Buzz ' + cred.token } })).body.key;
async function openFile(round) {
  const k = await unlockKey();
  const o = rawObj(`t/${tid}/buzzpub/${round}.bin`);
  if (!o) return null;
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(k, 'base64'), 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: o.bytes.subarray(0, 12) }, key, o.bytes.subarray(12))).toString('utf8');
}

s = await sent(async () => { await finish(1); await finish(3); await finish(5); });
ok('finishing rounds 1, 3 and 5 asks YAPP nothing', s.n === 0, s.n);
let pubs = pubOf();
ok('their buzzpoints files are made, marked as holding the parse', ['1', '3', '5'].every((n) => pubs[n] && pubs[n].p === 1), pubs);
ok('a viewer\'s file is the parse, so the browser has nothing to send YAPP',
  JSON.parse(await openFile(1)).tossups[0].question === 'Tossup from R1 second text');
s = await sent(() => call('/pub/kept-parse/qpacket?round=1', { headers: { Authorization: 'Buzz ' + cred.token } }));
ok('the buzzpoints route gives the parse too', s.n === 0 && isJson(s.out) && s.out.body.tossups[0].question === 'Tossup from R1 second text'
  && s.out.headers['cache-control'] === 'private, max-age=60', { n: s.n, type: s.out.headers['content-type'], cc: s.out.headers['cache-control'] });
await finish(2);
r = await call('/pub/kept-parse/qpacket?round=2', { headers: { Authorization: 'Buzz ' + cred.token } });
ok('a refused packet: the buzzpoints route says so', r.status === 422, r.status);
pubs = pubOf();
ok('and its file stays the .docx, marked so it is not tried again', pubs['2'] && pubs['2'].x === 1 && (await openFile(2)) === 'REFUSE this one', pubs['2']);
await finish(4);
ok('a JSON packet\'s file is marked too', pubOf()['4'] && pubOf()['4'].p === 1, pubOf()['4']);

// files made before this change: a .docx round's held the .docx, unmarked
const plainEntry = (e) => ({ h: e.h, s: e.s, live: e.live });
const legacy = { ...pubs, 1: plainEntry(pubs['1']), 4: plainEntry(pubOf()['4']) };
sql('UPDATE tournaments SET buzz_pub = ? WHERE id = ? RETURNING id', JSON.stringify(legacy), tid);
const file4 = rawObj(`t/${tid}/buzzpub/4.bin`).etag;
s = await sent(() => call('/pub/kept-parse/unlock', { headers: { Authorization: 'Buzz ' + cred.token } }));
pubs = pubOf();
ok('an unlock makes an old .docx round\'s file again, from the parse, asking YAPP nothing', s.n === 0 && pubs['1'].p === 1 && pubs['1'].h !== legacy['1'].h, pubs['1']);
ok('an old JSON round\'s file is only marked, not made again', pubs['4'].p === 1 && pubs['4'].h === legacy['4'].h && rawObj(`t/${tid}/buzzpub/4.bin`).etag === file4, pubs['4']);
s = await sent(async () => { for (let i = 0; i < 3; i++) await call('/pub/kept-parse/unlock', { headers: { Authorization: 'Buzz ' + cred.token } }); });
ok('later unlocks have nothing to make', s.n === 0 && JSON.stringify(pubOf()) === JSON.stringify(pubs), pubOf());

// YAPP down when a round finishes: the .docx goes up, and is made again later
w.setRaw(`t/${tid}/packet/6/Six.docx`, 'R6 text', { contentType: DOCX });
sql('INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?, ?, ?, ?) RETURNING number', tid, 6, `t/${tid}/packet/6/Six.docx`, 'Six.docx');
await call(A, { method: 'POST', json: { current_round: 6 } });
down = true;
s = await sent(() => finish(6));
ok('YAPP down as round 6 finishes: one call, and its file is the .docx with the time it tried',
  s.n === 1 && typeof pubOf()['6'].d === 'number' && (await openFile(6)) === 'R6 text', { n: s.n, e: pubOf()['6'] });
s = await sent(async () => { for (let i = 0; i < 3; i++) await call('/pub/kept-parse/unlock', { headers: { Authorization: 'Buzz ' + cred.token } }); });
ok('unlocks soon after don\'t ask again', s.n === 0, s.n);
down = false;
const tried = pubOf();
tried['6'].d -= 31 * 60 * 1000;
sql('UPDATE tournaments SET buzz_pub = ? WHERE id = ? RETURNING id', JSON.stringify(tried), tid);
s = await sent(() => call('/pub/kept-parse/unlock', { headers: { Authorization: 'Buzz ' + cred.token } }));
ok('half an hour on, it is parsed and its file made again', s.n === 1 && pubOf()['6'].p === 1
  && JSON.parse(await openFile(6)).tossups[0].question === 'Tossup from R6 text', { n: s.n, e: pubOf()['6'] });

/* ---------- the category backfill ---------- */

await w.env.DATA.delete(`t/${tid}/catmap.json`);
s = await sent(() => call(A));
const cm = JSON.parse(w.raw(`t/${tid}/catmap.json`) || '{}');
ok('a missing map is rebuilt from the kept parses, asking YAPP nothing', s.n === 0 && cm.rounds && cm.rounds['1'] && cm.rounds['3'] && cm.rounds['5'],
  { n: s.n, rounds: cm.rounds && Object.keys(cm.rounds) });
ok('and stamped current (a refused packet is not a reason to retry)', rawObj(`t/${tid}/catmap.json`).custom.v === '6', rawObj(`t/${tid}/catmap.json`).custom);

w.setRaw(`t/${tid}/packet/7/Seven.docx`, 'R7 text', { contentType: DOCX });
sql('INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?, ?, ?, ?) RETURNING number', tid, 7, `t/${tid}/packet/7/Seven.docx`, 'Seven.docx');
await w.env.DATA.delete(`t/${tid}/catmap.json`);
down = true;
s = await sent(() => call(A));
ok('YAPP down: the backfill asks only for the one round it has no parse for', s.n === 1, s.n);
ok('and leaves the map to retry, with the time', rawObj(`t/${tid}/catmap.json`).custom.v === 'retry' && Number(rawObj(`t/${tid}/catmap.json`).custom.at) > 0,
  rawObj(`t/${tid}/catmap.json`).custom);
s = await sent(async () => { for (let i = 0; i < 3; i++) await call(A); });
ok('hub loads in the next minutes don\'t ask again', s.n === 0, s.n);
down = false;
const cmObj = rawObj(`t/${tid}/catmap.json`);
cmObj.custom.at = String(Date.now() - 11 * 60 * 1000);
s = await sent(() => call(A));
ok('ten minutes on, the next load gets round 7, once', s.n === 1 && JSON.parse(w.raw(`t/${tid}/catmap.json`)).rounds['7'] && rawObj(`t/${tid}/catmap.json`).custom.v === '6', s.n);

/* ---------- a question set: its editor and a mirror's rooms ---------- */

const set = (await call('/api/sets', { method: 'POST', json: { name: 'Kept Set', slug: 'kept-set' } })).body;
const SA = '/s/' + set.admin_secret;
s = await sent(() => call(`${SA}/packet?packet=1&name=${enc('Packet 1.docx')}`, { method: 'POST', headers: { 'Content-Type': DOCX }, body: 'S1 text' }));
ok('a set\'s .docx upload: one call', s.out.status === 200 && s.n === 1, s);
s = await sent(async () => [await call(`${SA}/file?packet=1&v=1&parsed=1`), await call(`${SA}/file?packet=1&v=1&parsed=1`)]);
ok('the editor\'s review reads the parse, without asking', s.n === 0 && s.out.every((x) => isJson(x) && x.body.tossups[0].question === 'Tossup from S1 text'), s.out.map((x) => x.status));
r = await call(`${SA}/file?packet=1&v=1`);
ok('the editor\'s download is the .docx', r.text === 'S1 text' && r.headers['content-type'] === DOCX, r.headers['content-type']);
const inv = (await call(`${SA}/mirrors`, { method: 'POST', json: { name: 'Mirror' } })).body;
const mirror = (await call('/i/' + inv.invite, { method: 'POST', json: { name: 'Mirror', slug: 'kept-mirror' } })).body;
const MA = '/a/' + mirror.admin_secret;
const mroom = (await call(MA + '/buckets', { method: 'POST', json: { room_name: 'M1' } })).body.secret;
await call(MA + '/start', { method: 'POST' });
s = await sent(() => call(`/b/${mroom}/packet?round=1&warm=1&parsed=1`));
ok('a mirror\'s room reads the set\'s parse, without asking', s.n === 0 && isJson(s.out) && s.out.body.tossups[0].question === 'Tossup from S1 text', { n: s.n, status: s.out.status });
const mkey = sql('SELECT packet_r2_key FROM rounds WHERE tournament_id = ?', mirror.id)[0].packet_r2_key;
s = await sent(() => call(`${MA}/file?key=${enc(mkey)}&parsed=1`));
ok('so does the mirror\'s hub preview', s.n === 0 && isJson(s.out), s.out.status);

yapp.close();
console.log(`${passed} kept-parse checks passed` + (failures ? `, ${failures} FAILED` : ''));
if (failures) process.exitCode = 1;
