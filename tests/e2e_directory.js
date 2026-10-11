// e2e_directory.js — the directory (worker.js "the directory": the home
// page's list of tournaments running on this instance) end to end against
// a locally running Worker:
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled
// then: node tests/e2e_directory.js
//
// What it pins down: a tournament is listed by use and never by merely
// existing (once two rooms have uploaded), however many games one room
// puts in; the link is only there while the public page is on, and a
// tournament with it off is listed by name alone; a rename reaches the
// list; nothing a moderator or TD holds as a credential is in it; and the
// hourly sweep takes a closed tournament out — the past is the archive's
// list, by approval, never this one's.

import { BASE, call, d1exec, d1row, tick, ok, summary } from './e2e_lib.js';

const MATCH = (round) => JSON.stringify({
  tossups_read: 20, _round: round,
  match_teams: [
    { team: { name: 'Alpha' }, bonus_points: 30,
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20,
        answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: 'Beta' }, bonus_points: 0,
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20,
        answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});
const rnd = () => Math.random().toString(36).slice(2, 8);

async function directory() {
  const res = await fetch(BASE + '/pub/directory');
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json(), text: '' };
}
const entryOf = (dir, name) => dir.body.t.find((e) => e.n === name);
async function make(name, rooms) {
  const slug = 'dir-' + rnd();
  const r = await call('/api/tournaments', { method: 'POST', json: { name, slug } });
  const A = '/a/' + r.body.admin_secret;
  const secrets = [];
  for (let i = 1; i <= rooms; i++) {
    const b = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + i } });
    secrets.push(b.body.secret);
  }
  return { slug, id: r.body.id, A, admin: r.body.admin_secret, rooms: secrets };
}
const upload = (room, round, tag = '') =>
  call(`/b/${room}/upload?round=${round}&name=Round_${round}_Alpha_Beta${tag}.qbj`, { method: 'POST', body: MATCH(round) });

/* ----- the route ----- */

let d = await directory();
ok('the directory answers', d.status === 200 && d.body.v === 1 && Array.isArray(d.body.t), d.body);
ok('and may be cached for a few minutes', /max-age=300/.test(d.cache || ''), d.cache);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'Not A Slug', slug: 'directory' } });
ok('"directory" cannot be taken as a slug', r.status === 409, r.status);

/* ----- live: two rooms have uploaded ----- */

const nameA = 'Dir Live ' + rnd();
const a = await make(nameA, 2);
await tick();
ok('a tournament that merely exists is not listed', !entryOf(await directory(), nameA));

await call(a.A + '/start', { method: 'POST' });
await tick();
ok('nor one that has only been started', !entryOf(await directory(), nameA));

r = await upload(a.rooms[0], 1);
ok('one room uploads', r.status === 200 && r.body.error === null, r.body);
await tick();
ok('one room reporting is still not a tournament', !entryOf(await directory(), nameA));

await upload(a.rooms[1], 1);
await tick();
d = await directory();
let e = entryOf(d, nameA);
ok('two rooms reporting lists it', Boolean(e), d.body);
ok('with its link, the public page being on', e && e.s === a.slug, e);
const row = d1row(`SELECT started FROM tournaments WHERE id = ${a.id}`);
ok('and when it started and closes', e && e.d === row.started && e.c === row.started + 48 * 3600 * 1000, e);

/* ----- what a change costs: only a moved entry rewrites anything ----- */

const before = d1row(`SELECT dir_entry FROM tournaments WHERE id = ${a.id}`).dir_entry;
await upload(a.rooms[0], 2);
await tick();
ok('another game leaves the entry as it was',
  d1row(`SELECT dir_entry FROM tournaments WHERE id = ${a.id}`).dir_entry === before);

/* ----- the public page off: listed by name, not linked ----- */

r = await call(a.A, { method: 'POST', json: { published: false } });
ok('the TD turns the public page off', r.status === 200, r.body);
await tick();
await tick(); // the retraction, then the list
e = entryOf(await directory(), nameA);
ok('it stays listed, by name', Boolean(e) && e.n === nameA, e);
ok('with no link', e && e.s === null, e);

// while it is off, changes still reach the list (the tick's main pass
// no longer visits this row)
await call(a.A, { method: 'POST', json: { name: nameA + ' II' } });
await tick();
ok('a rename reaches the list with the page off', Boolean(entryOf(await directory(), nameA + ' II')), (await directory()).body);

r = await call(a.A, { method: 'POST', json: { published: true } });
await tick();
e = entryOf(await directory(), nameA + ' II');
ok('turning it back on brings the link back', e && e.s === a.slug, e);

/* ----- one room is not a tournament, however busy ----- */

const nameB = 'Dir Solo ' + rnd();
const b = await make(nameB, 1);
await call(b.A + '/start', { method: 'POST' });
for (let round = 1; round <= 5; round++) {
  await upload(b.rooms[0], round);
  await upload(b.rooms[0], round, '_b');
}
await tick();
ok('ten games over five rounds from one room is not listed', !entryOf(await directory(), nameB));

const nameC = 'Dir Test ' + rnd();
const c = await make(nameC, 1);
await call(c.A + '/start', { method: 'POST' });
for (let i = 0; i < 12; i++) await upload(c.rooms[0], 1, '_' + i);
await tick();
ok('a dozen games in one round is somebody testing', !entryOf(await directory(), nameC));

/* ----- newest first, and nothing secret ----- */

d = await directory();
const starts = d.body.t.map((x) => x.d);
ok('newest first', starts.every((v, i) => i === 0 || starts[i - 1] >= v), starts);
const raw = JSON.stringify(d.body);
ok('no admin or room secret in the directory',
  ![a.admin, b.admin, c.admin, ...a.rooms, ...b.rooms, ...c.rooms].some((s) => raw.includes(s)));
ok('an entry is name, link and the two dates, nothing more',
  d.body.t.every((x) => Object.keys(x).sort().join() === 'c,d,n,s'), d.body.t[0]);

/* ----- the hourly sweep ----- */

// Nothing happens on the backend when a tournament closes, so nothing
// marks it dirty: the sweep is what takes it out of the file. (It is also
// what repairs a row removed by hand.) Its 48 hours ran out an hour ago:
const full = nameA + ' II';
d1exec(`UPDATE tournaments SET started = ${Date.now() - 49 * 3600 * 1000} WHERE id = ${a.id}`);
await tick();
ok('a tournament that has closed is still in the file until the sweep', Boolean(entryOf(await directory(), full)));
const res = await fetch(BASE + '/__scheduled?cron=' + encodeURIComponent('0 * * * *'));
await res.text();
let gone = false;
for (let i = 0; i < 40 && !gone; i++) {
  gone = !entryOf(await directory(), full);
  if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
}
ok('the hourly sweep takes it out', gone);

summary('directory e2e');
