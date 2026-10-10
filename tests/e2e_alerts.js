// e2e_alerts.js — the new-activity alerts (worker.js "new-activity
// alerts") end to end against a locally running Worker.
//
// The dev Worker has to be pointed at this suite's own webhook sink,
// which only exists while this file is running:
//   worker/.dev.vars:  DISCORD_WEBHOOK=http://127.0.0.1:8798/hook
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled
// then: node tests/e2e_alerts.js
//
// What it pins down: a creation announces once, pressing Start tournament
// announces once, games coming in announce nothing, no credential ever
// leaves the Worker, and a webhook that is refusing connections cannot
// fail the request it rode on.

import { createServer } from 'node:http';
import { call, ok, summary } from './e2e_lib.js';

const HOOK_PORT = 8798;

const got = [];
const sink = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { got.push(JSON.parse(body || '{}')); } catch (e) { got.push({ unparsed: body }); }
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => sink.listen(HOOK_PORT, '127.0.0.1', resolve));

// Alerts ride on ctx.waitUntil: they are posted just after the response
// the caller already has, so the assertion has to wait for the sink
// rather than read it the instant the fetch resolves.
async function alerts(n, ms = 5000) {
  const until = Date.now() + ms;
  while (got.length < n && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return got.length;
}
// Nothing more arrived in the window an alert would have arrived in.
async function noMoreThan(n, ms = 1500) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return got.length <= n;
}
const title = (i) => (got[i] && got[i].embeds && got[i].embeds[0].title) || '';
const desc = (i) => (got[i] && got[i].embeds && got[i].embeds[0].description) || '';

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

/* ----- created ----- */

const slug = 'alert-' + Math.random().toString(36).slice(2, 8);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'Alert E2E', slug } });
ok('create tournament', r.status === 200 && r.body.admin_secret.length >= 10, r.body);
const A = '/a/' + r.body.admin_secret;
const adminSecret = r.body.admin_secret;

ok('creation alerts once', (await alerts(1)) === 1, got.length);
ok('creation alert names the tournament', title(0) === 'New tournament: Alert E2E', title(0));
ok('creation alert carries the slug', desc(0).includes(slug), desc(0));
ok('creation alert links the public page', desc(0).includes('/t.html?t=' + slug), desc(0));

/* ----- rooms ----- */

r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
ok('create bucket', r.status === 200 && r.body.secret.length >= 10, r.body);
const room1 = r.body.secret;
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 2' } });
const room2 = r.body.secret;
ok('a second room does not alert', await noMoreThan(1), got.length);

/* ----- started ----- */

// rooms can only upload once the TD has pressed Start tournament, and
// that press is news of its own: created and started are different things
r = await call(A + '/start', { method: 'POST' });
ok('start the tournament', r.status === 200, r.body);
ok('starting alerts once', (await alerts(2)) === 2, got.length);
ok('start alert says it started', title(1) === 'Started: Alert E2E', title(1));
ok('start alert carries the slug and the public page',
  desc(1).includes(slug) && desc(1).includes('/t.html?t=' + slug), desc(1));
r = await call(A + '/start', { method: 'POST' });
ok('a second start is refused and does not alert',
  r.status === 409 && (await noMoreThan(2)), [r.status, got.length]);

/* ----- games are not news ----- */

const [u1, u2] = await Promise.all([
  call(`/b/${room1}/upload?round=1&name=Round_1_Alpha_Beta.qbj`, { method: 'POST', body: MATCH }),
  call(`/b/${room2}/upload?round=1&name=Round_1_Alpha_Beta.qbj`, { method: 'POST', body: MATCH }),
]);
ok('both rooms upload fine', u1.status === 200 && u2.status === 200, [u1.status, u2.status]);
ok('uploads do not alert', await noMoreThan(2), got.length);

/* ----- what must never go out ----- */

const sent = JSON.stringify(got);
ok('no admin secret in any alert', !sent.includes(adminSecret));
ok('no room secret in any alert', !sent.includes(room1) && !sent.includes(room2));

/* ----- a webhook that is down ----- */

// The alert is a nicety; the tournament it rode on is not. With nothing
// listening, creation and upload must still succeed.
await new Promise((resolve) => sink.close(resolve));
const slug2 = 'alert-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'Sink Down', slug: slug2 } });
ok('creation survives a dead webhook', r.status === 200 && r.body.id > 0, r.body);
const A2 = '/a/' + r.body.admin_secret;
r = await call(A2 + '/start', { method: 'POST' });
ok('starting survives a dead webhook', r.status === 200 && r.body.started > 0, r.body);
r = await call(A2 + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
r = await call(`/b/${r.body.secret}/upload?round=1&name=Round_1_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH });
ok('upload survives a dead webhook', r.status === 200 && r.body.error === null, r.body);

summary('alerts e2e');
