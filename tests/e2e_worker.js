// e2e_worker.js — end-to-end smoke test against a locally running Worker:
//   cd worker && npx wrangler dev --local --port 8799   (schema applied,
//   .dev.vars with SESSION_SECRET=devsecret)
// then: node tests/e2e_worker.js
//
// Exercises the full TO -> moderator -> public flow with a token minted
// with the dev secret (same HMAC format the Worker verifies).

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';
const SECRET = 'devsecret';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function mintToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(body).digest();
  return body + '.' + b64url(sig);
}

const token = mintToken({ u: 'gh:1', l: 'testuser', exp: Date.now() + 3600_000 });

async function call(path, opts = {}, auth = true) {
  const headers = { ...(opts.headers || {}) };
  if (auth) headers.Authorization = 'Bearer ' + token;
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

// unauthed admin is rejected
let r = await call('/api/tournaments', {}, false);
ok('admin requires auth', r.status === 401);

// user row must exist for the FK-ish flow (Worker creates it on OAuth;
// mint path bypasses that, so nothing depends on users here)

// create tournament
const slug = 'e2e-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'E2E Open', slug } });
ok('create tournament', r.status === 200 && r.body.id > 0, r.body);
const tid = r.body.id;

r = await call('/api/tournaments', { method: 'POST', json: { name: 'dupe', slug } });
ok('duplicate slug rejected', r.status === 409);

// bucket
r = await call(`/api/tournaments/${tid}/buckets`, { method: 'POST', json: { room_name: 'Room 1' } });
ok('create bucket', r.status === 200 && r.body.secret.length >= 10, r.body);
const secret = r.body.secret;

// packet upload + roster
r = await call(`/api/tournaments/${tid}/packet?round=1&name=Packet1.pdf`,
  { method: 'POST', body: 'PDFBYTES' });
ok('upload packet', r.status === 200, r.body);
r = await call(`/api/tournaments/${tid}/roster?name=roster.qbj`, {
  method: 'POST',
  body: JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
    { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Ann' }] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] },
  ] }] }),
});
ok('upload roster', r.status === 200, r.body);

// another user can't see it
const other = mintToken({ u: 'gh:2', l: 'other', exp: Date.now() + 3600_000 });
{
  const res = await fetch(`${BASE}/api/tournaments/${tid}`, { headers: { Authorization: 'Bearer ' + other } });
  ok('cross-tenant read blocked', res.status === 404);
}

// moderator flow
r = await call('/b/' + secret, {}, false);
ok('bucket state', r.status === 200 && r.body.room === 'Room 1' && r.body.current_round === 1, r.body);
ok('bucket sees packet', r.body.packet && r.body.packet.packet_name === 'Packet1.pdf', r.body.packet);

r = await call(`/b/${secret}/upload?round=1&name=Round_1_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH }, false);
ok('mod uploads qbj', r.status === 200 && r.body.kind === 'qbj' && r.body.error === null, r.body);

r = await call(`/b/${secret}/upload?round=1&name=Round_1_Alpha_Beta_Game.json`,
  { method: 'POST', body: '{"cycles":[]}' }, false);
ok('mod uploads game file', r.status === 200 && r.body.kind === 'game', r.body);

r = await call(`/b/${secret}/upload?round=1&name=broken.qbj`,
  { method: 'POST', body: 'not json' }, false);
ok('broken qbj flagged', r.status === 200 && r.body.error === 'not valid JSON', r.body);

r = await call('/b/wrongsecret12345', {}, false);
ok('bad secret rejected', r.status === 404);

// packet download through bucket
{
  const res = await fetch(`${BASE}/b/${secret}/packet`);
  ok('mod downloads packet', res.status === 200 && (await res.text()) === 'PDFBYTES');
}

// public gate: unpublished -> 404
r = await call('/pub/' + slug, {}, false);
ok('unpublished hidden', r.status === 404);

// publish, then public state
r = await call('/api/tournaments/' + tid, { method: 'POST', json: { published: true, current_round: 2 } });
ok('publish + set round', r.status === 200);

r = await call('/pub/' + slug, {}, false);
ok('public state', r.status === 200 && r.body.name === 'E2E Open' && r.body.current_round === 2, r.body);
ok('public lists only valid qbj', r.body.files.length === 1 && r.body.files[0].room === 'Room 1', r.body.files);

{
  const res = await fetch(`${BASE}/pub/${slug}/qbj/${r.body.files[0].id}`);
  const text = await res.text();
  ok('public qbj download', res.status === 200 && JSON.parse(text).tossups_read === 20);
  const rr = await fetch(`${BASE}/pub/${slug}/roster`);
  ok('public roster download', rr.status === 200 && (await rr.text()).includes('Alpha'));
}

// admin detail reflects everything
r = await call('/api/tournaments/' + tid);
ok('admin detail', r.status === 200 && r.body.files.length === 3 && r.body.rounds.length === 1, r.body.files);

// file delete
const delId = r.body.files.find((f) => f.filename === 'broken.qbj').id;
r = await call(`/api/tournaments/${tid}/files/${delId}`, { method: 'DELETE' });
ok('delete file', r.status === 200);
r = await call('/api/tournaments/' + tid);
ok('file gone', r.body.files.length === 2);

// bucket delete kills the link
r = await call(`/api/tournaments/${tid}/buckets/${r.body.buckets[0].id}`, { method: 'DELETE' });
ok('delete bucket', r.status === 200);
r = await call('/b/' + secret, {}, false);
ok('bucket link dead', r.status === 404);

console.log(passed + ' e2e checks passed' + (process.exitCode ? ' (with failures)' : ''));
