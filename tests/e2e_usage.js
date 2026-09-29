// e2e_usage.js — the Worker's D1 bill stays flat where it should. Needs a
// METERED local Worker (the meter is what these checks read):
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
//   node tests/e2e_usage.js
//
// Four promises, each a scaling cost measured in rows read:
// - the once-a-minute cron costs the same with 1 or 1,000 tournaments on
//   file: finding "nothing to rebuild" reads the dirty rows, not the table
// - a Live Hub refresh that finds nothing new costs the admin lookup and
//   nothing else (GET /a/:secret?rev=), and every change a TD could be
//   waiting to see moves the rev so it is never missed
// - a public page view reads the prebuilt state: a flat handful of rows
//   however many games, with games showing after the next tick and the
//   tournament row's own fields (name, round) at once
// - broadcasts are gone, and auto-advance needs no open Live Hub

import { execSync } from 'node:child_process';
import { BASE, WORKER_DIR, call, d1exec, tick, ok, summary } from './e2e_lib.js';

async function meter() {
  const res = await fetch(BASE + '/__meter');
  if (!res.ok) throw new Error('no /__meter: run wrangler dev with --var METER:1');
  return res.json();
}

// rows read by fn's requests
async function rowsRead(fn) {
  const before = await meter();
  const out = await fn();
  return { rows: (await meter()).rows_read - before.rows_read, out };
}

// Every row of a local D1 query (e2e_lib's d1row returns only the first).
function d1rows(sql) {
  const out = execSync(`npx wrangler d1 execute qb-td --local --json --command "${sql}"`,
    { cwd: WORKER_DIR }).toString();
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const MATCH = (round) => JSON.stringify({
  tossups_read: 20, _round: round,
  match_teams: [
    { team: { name: 'Alpha' }, bonus_points: 30,
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20, answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
    { team: { name: 'Beta' }, bonus_points: 0,
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20, answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});

// creation is capped per IP per day (20); this suite makes more than that
let made = 0;
async function makeTournament(name) {
  if (made++ % 15 === 0) d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const slug = 'use-' + Math.random().toString(36).slice(2, 8);
  const r = await call('/api/tournaments', { method: 'POST', json: { name, slug } });
  if (r.status !== 200) throw new Error('create failed: ' + JSON.stringify(r.body));
  return { A: '/a/' + r.body.admin_secret, tid: r.body.id, slug };
}

/* ---------- the cron: flat in the number of tournaments ---------- */

// settle whatever earlier runs left dirty, then price an idle tick
await tick(); await tick();
const idle1 = (await rowsRead(tick)).rows;
for (let i = 0; i < 25; i++) await makeTournament('Idle ' + i);
await tick(); await tick();
const idle2 = (await rowsRead(tick)).rows;
const onFile = d1rows('SELECT COUNT(*) AS n FROM tournaments')[0].n;
ok(`idle cron tick reads a constant handful of rows (${idle1} -> ${idle2} with 25 more tournaments, ${onFile} on file)`,
  idle2 <= 4 && idle2 <= idle1 + 1, { idle1, idle2 });

const planT = d1rows(
  // worker.js tickTournaments, verbatim
  'EXPLAIN QUERY PLAN SELECT t.*, (s.published = 1 AND m.hidden = 0) AS set_published FROM tournaments t ' +
  'LEFT JOIN sets s ON s.id = t.set_id LEFT JOIN set_mirrors m ON m.tournament_id = t.id ' +
  'WHERE t.pub_dirty = 1 AND (t.published = 1 OR t.pub_snapshot IS NOT NULL OR t.set_id IS NOT NULL) ' +
  'ORDER BY t.created DESC LIMIT 4'
).map((x) => x.detail).join(' | ');
ok('dirty-tournament query uses the partial index', /idx_tournaments_dirty/.test(planT), planT);
const planS = d1rows('EXPLAIN QUERY PLAN SELECT id FROM sets WHERE state_dirty = 1 ORDER BY id LIMIT 8')
  .map((x) => x.detail).join(' | ');
ok('dirty-set query uses the partial index', /idx_sets_dirty/.test(planS), planS);

/* ---------- the Live Hub: cheap when nothing moved ---------- */

const T = await makeTournament('Usage Hub');
const { A } = T;
let r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
const room1 = r.body;
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 2' } });
const room2 = r.body;
await call(A + '/packet?round=1&name=Packet1.pdf', { method: 'POST', body: 'PDFBYTES' });
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: true } });

r = await call(A);
ok('detail carries a rev', r.status === 200 && Number.isInteger(r.body.tournament.rev), r.body.tournament);
let rev = r.body.tournament.rev;

let m = await rowsRead(() => call(A + '?rev=' + rev));
ok('unchanged refresh says so', m.out.status === 200 && m.out.body.unchanged === true && m.out.body.rev === rev, m.out.body);
ok('unchanged refresh carries no detail', m.out.body.buckets === undefined && m.out.body.files === undefined, m.out.body);
const full = await rowsRead(() => call(A));
ok(`unchanged refresh reads only the admin lookup (${m.rows} rows vs ${full.rows} for the full detail)`,
  m.rows <= 6 && m.rows < full.rows, { unchanged: m.rows, full: full.rows });

r = await call(A + '?rev=' + (rev - 1));
ok('a stale rev gets the full detail', r.status === 200 && Array.isArray(r.body.buckets) && r.body.tournament.rev === rev, r.body);
r = await call(A + '?rev=nope');
ok('a junk rev gets the full detail', r.status === 200 && Array.isArray(r.body.buckets), r.body);

// Every change the Live Hub shows must move the rev. After each, the rev
// the hub held must come back as a full detail, and the new rev as
// unchanged again.
async function moves(label, fn) {
  await fn();
  const got = await call(A + '?rev=' + rev);
  const moved = got.status === 200 && got.body.unchanged !== true && got.body.tournament
    && got.body.tournament.rev !== rev;
  ok('rev moves: ' + label, moved, got.body.unchanged ? 'still unchanged' : got.body);
  if (moved) rev = got.body.tournament.rev;
}
async function stays(label, fn) {
  await fn();
  const got = await call(A + '?rev=' + rev);
  ok('rev stays: ' + label, got.body.unchanged === true, got.body);
}

await moves('room created', () => call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 3' } }));
const room3 = (await call(A)).body.buckets.find((b) => b.room_name === 'Room 3');
rev = (await call(A)).body.tournament.rev;
await moves('room renamed', () => call(`${A}/buckets/${room3.id}`, { method: 'POST', json: { room_name: 'Room Three' } }));
await moves('room deleted', () => call(`${A}/buckets/${room3.id}`, { method: 'DELETE' }));
await moves('packet uploaded', () => call(A + '/packet?round=2&name=Packet2.pdf', { method: 'POST', body: 'PDFBYTES' }));
await moves('roster uploaded', () => call(A + '/roster?name=roster.qbj', { method: 'POST',
  body: JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
    { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Ann' }] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Bob' }] }] },
  ] }] }) }));
await moves('room started a round (packet fetch)', () => call('/b/' + room1.secret + '/packet?round=1'));
await moves('game uploaded', () => call('/b/' + room1.secret + '/upload?round=1&name=R1_Alpha_Beta.qbj',
  { method: 'POST', body: MATCH(1) }));
const fileId = (await call(A)).body.files[0].id;
rev = (await call(A)).body.tournament.rev;
await moves('file moved to another room', () => call(`${A}/files/${fileId}`, { method: 'POST', json: { bucket_id: room2.id } }));
await moves('file deleted', () => call(`${A}/files/${fileId}`, { method: 'DELETE' }));
await moves('round set by the TD', () => call(A, { method: 'POST', json: { current_round: 2 } }));
await moves('renamed', () => call(A, { method: 'POST', json: { name: 'Usage Hub Renamed' } }));
await moves('settings changed', () => call(A, { method: 'POST', json: { settings: { gameFormat: 'acf' } } }));
await moves('public page switched off', () => call(A, { method: 'POST', json: { published: false } }));
await moves('protest ruled', () => call(A, { method: 'POST', json: { rulings: { 'r1|q3|Alpha|Beta': { r: 'upheld', note: 'ok' } } } }));
await moves('tiebreakers uploaded', () => call(A + '/tiebreakers?name=tb.json', { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tossups: [{ question: 'tb one', answer: 'Mozart' }] }) }));
await moves('tiebreakers cleared', () => call(A + '/tiebreakers', { method: 'DELETE' }));

// the cron rebuilding the public shards changes nothing the hub shows
await call('/b/' + room2.secret + '/upload?round=2&name=R2_Alpha_Beta.qbj', { method: 'POST', body: MATCH(2) });
rev = (await call(A)).body.tournament.rev;
await stays('cron tick rebuilds the public page', () => tick());
await stays('a room re-fetching a packet it already started', () => call('/b/' + room1.secret + '/packet?round=1'));
await stays('reads of any kind', async () => { await call(A); await call('/pub/' + T.slug); await call('/b/' + room1.secret); });

/* ---------- the public page: prebuilt, flat per view ---------- */
{
  const P = await makeTournament('Usage Public');
  const pb = [];
  for (let k = 0; k < 3; k++) pb.push((await call(P.A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } })).body);
  await call(P.A + '/packet?round=1&name=P1.pdf', { method: 'POST', body: 'PDFBYTES' });
  await call(P.A + '/start', { method: 'POST' });
  await call(P.A, { method: 'POST', json: { published: true } });
  const game = (k) => call('/b/' + pb[k].secret + '/upload?round=1&name=R1_' + k + '.qbj', { method: 'POST', body: MATCH(1) });
  await game(0);
  await tick();
  const one = await rowsRead(() => call('/pub/' + P.slug));
  ok('public state lists the game after a tick', one.out.body.files.length === 1, one.out.body.files);
  await game(1);
  await game(2);
  let before = await call('/pub/' + P.slug);
  ok('a new game waits for the tick (prebuilt state)', before.body.files.length === 1, before.body.files.length);
  await tick();
  const three = await rowsRead(() => call('/pub/' + P.slug));
  ok('...and is listed after it', three.out.body.files.length === 3, three.out.body.files.length);
  ok(`a public view reads a flat handful of rows (${one.rows} with 1 game, ${three.rows} with 3)`,
    three.rows <= 3 && three.rows === one.rows, { one: one.rows, three: three.rows });
  const shard = (await call('/pub/' + P.slug + '/rounds?n=1')).body;
  ok('the round shard is valid JSON listing every game', shard.rounds && shard.rounds[0].entries.length === 3
    && shard.rounds[0].entries.every((e) => e.qbj && e.id), shard);
  ok('the shard stamp matches the state', shard.rounds[0].v === three.out.body.rounds['1'], [shard.rounds[0].v, three.out.body.rounds]);
  await call(P.A, { method: 'POST', json: { name: 'Usage Public Renamed', current_round: 2 } });
  const live = (await call('/pub/' + P.slug)).body;
  ok('name and round number show at once, no tick', live.name === 'Usage Public Renamed' && live.current_round === 2, live);
}

/* ---------- broadcasts are gone ---------- */

r = await call(A, { method: 'POST', json: { announce: [{ id: 'b1', text: 'hello', pub: true, rooms: true, expires: Date.now() + 3600e3 }] } });
ok('broadcast writes are refused', r.status === 400, r.body);
r = await call(A, { method: 'POST', json: { published: true } });
r = await call('/pub/' + T.slug);
ok('public state has no broadcasts', r.status === 200 && r.body.announce === undefined, r.body);
r = await call('/b/' + room1.secret);
ok('room state has no broadcasts', r.status === 200 && r.body.announce === undefined, r.body);
r = await call('/b/' + room1.secret + '/upload?round=2&name=R2_again.qbj', { method: 'POST', body: MATCH(2) });
ok('upload response has no broadcasts', r.status === 200 && r.body.announce === undefined, r.body);
r = await call(A);
ok('admin detail has no broadcasts', r.body.tournament.announce === undefined, r.body.tournament);

/* ---------- auto-advance runs with no Live Hub open ---------- */
{
  const U = await makeTournament('Usage Auto');
  const b1 = (await call(U.A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } })).body;
  const b2 = (await call(U.A + '/buckets', { method: 'POST', json: { room_name: 'Room 2' } })).body;
  await call(U.A + '/packet?round=1&name=P1.pdf', { method: 'POST', body: 'PDFBYTES' });
  await call(U.A + '/packet?round=2&name=P2.pdf', { method: 'POST', body: 'PDFBYTES' });
  await call(U.A + '/start', { method: 'POST' });
  await call(U.A, { method: 'POST', json: { settings: { autoAdvance: true } } });
  const heldRev = (await call(U.A)).body.tournament.rev;
  // from here on the TD's hub is closed: only rooms talk to the Worker
  await call('/b/' + b1.secret + '/packet?round=1');
  await call('/b/' + b2.secret + '/packet?round=1');
  r = await call('/b/' + b1.secret);
  ok('round 2 opened with every room started and no hub open', r.body.current_round === 2, r.body.current_round);
  r = await call(U.A + '?rev=' + heldRev);
  ok('a hub reopening sees the advance', r.body.unchanged !== true && r.body.tournament.current_round === 2, r.body);
}

summary('usage e2e');
