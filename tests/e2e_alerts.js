// e2e_alerts.js — the new-activity alerts (worker.js "new-activity
// alerts") end to end against a locally running Worker.
//
// The dev Worker has to be pointed at this suite's own webhook sink,
// which only exists while this file is running:
//   worker/.dev.vars:  DISCORD_WEBHOOK=http://127.0.0.1:8798/hook
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled
// then: node tests/e2e_alerts.js
//
// The sink plays Discord's side of a webhook: a POST creates a message
// and answers its id, and a PATCH or DELETE on that id edits or removes
// it. So what the suite checks is what the channel would look like.
//
// What it pins down: a tournament has one message, which follows it from
// New to Started to Finished (each step a fresh post, the old one
// deleted); games coming in announce nothing; the hourly wrap-up
// summarizes a closed tournament once and quietly relabels one that was
// never started; no credential ever leaves the Worker; and a webhook that
// is refusing connections cannot fail the request it rode on.

import { createServer } from 'node:http';
import { BASE, call, d1exec, d1row, ok, summary } from './e2e_lib.js';

const HOOK_PORT = 8798;

const channel = new Map();   // message id -> its current body
const log = [];              // every call the Worker made: { method, id, body }
let nextId = 100000;
const sink = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = { unparsed: raw }; }
    const m = /^\/hook(?:\/messages\/(\d+))?(?:\?.*)?$/.exec(req.url);
    const id = m && m[1];
    log.push({ method: req.method, id: id || null, body, url: req.url });
    if (!m) { res.writeHead(404).end(); return; }
    if (req.method === 'POST' && !id) {
      const made = String(nextId++);
      channel.set(made, body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: made }));
    } else if (id && !channel.has(id)) {
      res.writeHead(404).end();
    } else if (req.method === 'PATCH') {
      channel.set(id, body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id }));
    } else if (req.method === 'DELETE') {
      channel.delete(id);
      res.writeHead(204).end();
    } else {
      res.writeHead(405).end();
    }
  });
});
await new Promise((resolve) => sink.listen(HOOK_PORT, '127.0.0.1', resolve));

// Alerts ride on ctx.waitUntil: they are sent just after the response the
// caller already has, so an assertion waits for the sink to settle rather
// than reading it the instant the fetch resolves.
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  return cond();
}
// Nothing more arrived in the window an alert would have arrived in.
async function quiet(ms = 1500) {
  const before = log.length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return log.length === before;
}
const embed = (id) => (channel.get(id) && channel.get(id).embeds && channel.get(id).embeds[0]) || {};
const status = (id) => String(embed(id).description || '').split('\n')[0];
const titles = () => [...channel.keys()].map((id) => embed(id).title + ' / ' + status(id));
const posts = () => log.filter((c) => c.method === 'POST').length;
const msgOf = (tid) => d1row(`SELECT alert_msg FROM tournaments WHERE id = ${tid}`).alert_msg;
// The hourly trigger, as wrangler dev --test-scheduled exposes it.
async function hourly() {
  const res = await fetch(BASE + '/__scheduled?cron=' + encodeURIComponent('0 * * * *'));
  if (!res.ok) throw new Error('cron trigger failed (' + res.status + ')');
  await res.text();
}
const DAY = 24 * 3600 * 1000;

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

// Other suites leave closed (backdated) tournaments behind on a shared
// local database, and the hourly run would summarize them into this
// suite's channel. Retire whatever is already there, as the migration
// does for a production database.
d1exec('UPDATE tournaments SET wrapped = 1');

/* ----- created ----- */

const slug = 'alert-' + Math.random().toString(36).slice(2, 8);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'Alert E2E', slug } });
ok('create tournament', r.status === 200 && r.body.admin_secret.length >= 10, r.body);
const A = '/a/' + r.body.admin_secret;
const adminSecret = r.body.admin_secret;
const tid = r.body.id;

ok('creation posts one message', (await until(() => channel.size === 1)) && posts() === 1, titles());
const created = [...channel.keys()][0];
ok('its title is the tournament name', embed(created).title === 'Alert E2E', titles());
ok('then its status', status(created) === 'Status: New tournament', embed(created));
ok('then the public page link, on its own line',
  embed(created).description.split('\n')[1].endsWith('/t.html?t=' + slug), embed(created));
ok('the post asked for the message back', log[0].url.includes('wait=true'), log[0].url);
ok('the message id is remembered', await until(() => msgOf(tid) === created), msgOf(tid));

/* ----- rooms ----- */

r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
ok('create bucket', r.status === 200 && r.body.secret.length >= 10, r.body);
const room1 = r.body.secret;
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 2' } });
const room2 = r.body.secret;
ok('adding rooms does not alert', await quiet(), log.length);

/* ----- started ----- */

// created and started are different news: starting posts afresh (Discord
// notifies on a post, not an edit) and takes the "New" message away
r = await call(A + '/start', { method: 'POST' });
ok('start the tournament', r.status === 200, r.body);
ok('starting posts a new message', await until(() => posts() === 2), log.map((c) => c.method));
ok('the channel still has one message for it',
  (await until(() => channel.size === 1 && !channel.has(created))), [...channel.keys()]);
const startedMsg = [...channel.keys()][0];
ok('it says the tournament started',
  embed(startedMsg).title === 'Alert E2E' && status(startedMsg) === 'Status: Started', titles());
ok('with the public page link under it',
  embed(startedMsg).description.split('\n')[1].endsWith('/t.html?t=' + slug), embed(startedMsg));
ok('the new message id is remembered', await until(() => msgOf(tid) === startedMsg), msgOf(tid));
r = await call(A + '/start', { method: 'POST' });
ok('a second start is refused and does not alert', r.status === 409 && (await quiet()), [r.status, log.length]);

// the TD's own page is not told about the operator's bookkeeping
r = await call(A);
ok('the admin route does not expose the alert columns',
  r.status === 200 && !('alert_msg' in r.body.tournament) && !('wrapped' in r.body.tournament),
  Object.keys(r.body.tournament || {}));

/* ----- games are not news ----- */

const [u1, u2] = await Promise.all([
  call(`/b/${room1}/upload?round=1&name=Round_1_Alpha_Beta.qbj`, { method: 'POST', body: MATCH }),
  call(`/b/${room2}/upload?round=1&name=Round_1_Alpha_Beta.qbj`, { method: 'POST', body: MATCH }),
]);
ok('both rooms upload fine', u1.status === 200 && u2.status === 200, [u1.status, u2.status]);
ok('uploads do not alert', await quiet(), log.length);

/* ----- the wrap-up ----- */

await hourly();
ok('a running tournament is not wrapped up', await quiet(), titles());

// its 48 hours ran out an hour ago
d1exec(`UPDATE tournaments SET started = ${Date.now() - 2 * DAY - 3600 * 1000} WHERE id = ${tid}`);
await hourly();
ok('the wrap-up posts a new message', await until(() => posts() === 3), log.map((c) => c.method));
ok('and it is again the only one', await until(() => channel.size === 1 && !channel.has(startedMsg)), [...channel.keys()]);
const done = [...channel.keys()][0];
ok('it says the tournament finished',
  embed(done).title === 'Alert E2E' && status(done) === 'Status: Finished', titles());
ok('it counts rooms, games and rounds',
  embed(done).description.includes('2 rooms, 2 games, 1 round'), embed(done).description);
ok('it gives the archive command',
  embed(done).description.includes('node tools/archive.mjs add ' + slug), embed(done).description);
ok('the tournament is marked wrapped',
  d1row(`SELECT wrapped FROM tournaments WHERE id = ${tid}`).wrapped === 1);
await hourly();
ok('a second hourly run says nothing more', await quiet(), titles());

// never started: its setup week ran out, and that is not news — the "New"
// message is relabelled where it stands
const slugU = 'alert-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'Unused E2E', slug: slugU } });
const tidU = r.body.id;
const secretU = r.body.admin_secret;
ok('a second tournament gets its own message', await until(() => channel.size === 2), titles());
const unusedMsg = [...channel.keys()].find((id) => id !== done);
const before = posts();
d1exec(`UPDATE tournaments SET created = ${Date.now() - 8 * DAY} WHERE id = ${tidU}`);
await hourly();
ok('an unused tournament is relabelled in place',
  (await until(() => status(unusedMsg) === 'Status: Never started')) && posts() === before
    && embed(unusedMsg).title === 'Unused E2E',
  titles());
ok('by an edit, which does not notify', log[log.length - 1].method === 'PATCH', log[log.length - 1].method);

// a tournament that closed long ago is left alone (the webhook was off, or
// the row predates the columns): no backlog on the day alerts go on
const slugO = 'alert-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'Old E2E', slug: slugO } });
const tidO = r.body.id;
const secretO = r.body.admin_secret;
await until(() => channel.size === 3);
await call('/a/' + secretO + '/start', { method: 'POST' });
await until(() => titles().includes('Old E2E / Status: Started'));
d1exec(`UPDATE tournaments SET created = ${Date.now() - 40 * DAY}, started = ${Date.now() - 30 * DAY} WHERE id = ${tidO}`);
await hourly();
ok('a tournament closed weeks ago is not summarized',
  (await quiet()) && titles().includes('Old E2E / Status: Started'), titles());

/* ----- what must never go out ----- */

const sent = JSON.stringify(log);
ok('no admin secret in any alert',
  !sent.includes(adminSecret) && !sent.includes(secretU) && !sent.includes(secretO));
ok('no room secret in any alert', !sent.includes(room1) && !sent.includes(room2));

/* ----- a webhook that is down ----- */

// The alert is a nicety; the tournament it rode on is not. With nothing
// listening, creation, start, upload and the hourly run must all still work.
await new Promise((resolve) => sink.close(resolve));
const slug2 = 'alert-' + Math.random().toString(36).slice(2, 8);
r = await call('/api/tournaments', { method: 'POST', json: { name: 'Sink Down', slug: slug2 } });
ok('creation survives a dead webhook', r.status === 200 && r.body.id > 0, r.body);
const tid2 = r.body.id;
const A2 = '/a/' + r.body.admin_secret;
r = await call(A2 + '/start', { method: 'POST' });
ok('starting survives a dead webhook', r.status === 200 && r.body.started > 0, r.body);
r = await call(A2 + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
r = await call(`/b/${r.body.secret}/upload?round=1&name=Round_1_Alpha_Beta.qbj`,
  { method: 'POST', body: MATCH });
ok('upload survives a dead webhook', r.status === 200 && r.body.error === null, r.body);
d1exec(`UPDATE tournaments SET started = ${Date.now() - 2 * DAY - 3600 * 1000} WHERE id = ${tid2}`);
await hourly();
ok('the hourly run survives a dead webhook',
  await until(() => d1row(`SELECT wrapped FROM tournaments WHERE id = ${tid2}`).wrapped === 1));
ok('the ordinary tick still runs', (await fetch(BASE + '/__scheduled')).ok);

summary('alerts e2e');
