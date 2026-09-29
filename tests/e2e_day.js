// e2e_day.js — one whole tournament, end to end, with every output checked
// against the games that were actually played. Needs a METERED local
// Worker (the cron's rebuild count is read from the meter):
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
//   node tests/e2e_day.js
//
// The TD sets up (rooms, roster, schedule, categorized JSON packets,
// buzzpoints password, auto-advance) and never touches the round again:
// rooms move it by starting games. Each room loads its page, downloads
// its packet (and can't download the next one), starts, and uploads a
// real-size MODAQ game (the archive's median match, ~13KB with buzzes);
// one room re-exports a game. The cron runs between rounds.
//
// Then the same standings are computed three ways and must agree exactly:
//   expected — the uploaded games, parsed and aggregated right here
//   public   — the public page's path: round shards -> parseMatch -> aggregate
//   exports  — the TD's path: every file downloaded -> parseMatch -> aggregate,
//              plus the YellowFruit export built from it
// and the rest of what a viewer or TD sees is checked against the inputs:
// file list and rooms, categories, buzzpoints, room pages, the cron's
// rebuilds going through the REBUILD binding, a view's D1 cost.

import archive from '../app/archive/ug-nats-stanford.js';
import { parseMatch, parseRoster, matchPayload } from '../app/engine/qbj.js';
import { aggregate } from '../app/engine/stats.js';
import { buildYft } from '../app/engine/yft.js';
import { buzzSettings, buzzToken } from '../app/js/buzzkey.js';
import { BASE, call, d1exec, tick, ok, summary } from './e2e_lib.js';

const ROOMS = 4;
const ROUNDS = 4;
const TEAMS = ROOMS * 2;
const PLAYERS = 5;

const meter = async () => (await fetch(BASE + '/__meter')).json();

/* ---------- fixtures ---------- */

const teamName = (i) => 'Day School ' + String.fromCharCode(65 + i);
const playerName = (t, p) => teamName(t) + ' Player ' + (p + 1);

// the archive's median-size real match: buzz-level detail and all
const sample = (() => {
  const bundle = archive[Object.keys(archive).find((k) => k.endsWith('/bundle'))];
  const sized = bundle.entries.map((e) => ({ e, n: JSON.stringify(e.qbj).length })).sort((a, b) => a.n - b.n);
  return sized[Math.floor(sized.length / 2)].e.qbj;
})();
const sampleTeamB = (sample.match_teams[1].team || {}).name;

// A game between teams a and b. `flip` swaps which side gets the sample's
// winning line, so results differ across games and the standings are
// worth comparing.
function matchFor(round, a, b, flip) {
  const m = JSON.parse(JSON.stringify(sample));
  const names = flip ? [b, a] : [a, b];
  (m.match_teams || []).forEach((mt, i) => {
    if (mt.team) mt.team.name = teamName(names[i]);
    (mt.match_players || []).forEach((mp, j) => { if (mp.player) mp.player.name = playerName(names[i], j % PLAYERS); });
    (mt.lineups || []).forEach((l) => (l.players || []).forEach((p, j) => { p.name = playerName(names[i], j % PLAYERS); }));
  });
  (m.match_questions || []).forEach((q) => (q.buzzes || []).forEach((bz) => {
    const side = bz.team && bz.team.name === sampleTeamB ? 1 : 0;
    if (bz.team) bz.team.name = teamName(names[side]);
    if (bz.player) bz.player.name = playerName(names[side], 0);
  }));
  delete m.notes;
  m._round = round;
  return m;
}

function pairings(round) {
  const idx = [...Array(TEAMS).keys()];
  const r = (round - 1) % (TEAMS - 1);
  const rot = [idx[0], ...idx.slice(1 + r), ...idx.slice(1, 1 + r)];
  return Array.from({ length: TEAMS / 2 }, (_, i) => [rot[i], rot[TEAMS - 1 - i]]);
}

const CATS = [['Literature', 'American Literature'], ['Science', 'Biology'], ['History', 'World History'],
  ['Fine Arts', 'Painting'], ['Religion', null]];
function packetFor(n) {
  return {
    tossups: Array.from({ length: 20 }, (_, i) => ({
      question: `Round ${n} tossup ${i + 1} text`, answer: `answer ${n}-${i + 1}`,
      category: CATS[i % CATS.length][0], ...(CATS[i % CATS.length][1] ? { subcategory: CATS[i % CATS.length][1] } : {}),
    })),
    bonuses: Array.from({ length: 20 }, (_, i) => ({
      leadin: `Round ${n} bonus ${i + 1}`, parts: ['p1', 'p2', 'p3'], answers: ['x', 'y', 'z'], values: [10, 10, 10],
      category: CATS[(i + 2) % CATS.length][0],
    })),
  };
}

const roster = { objects: [{ type: 'Tournament', registrations: Array.from({ length: TEAMS }, (_, t) => ({
  name: teamName(t), teams: [{ name: teamName(t), players: Array.from({ length: PLAYERS }, (_, p) => ({ name: playerName(t, p) })) }],
})) }] };

// the fields a standings table and the leaderboard show
const teamView = (agg) => agg.teams.map((t) => ({ name: t.name, gp: t.gp, w: t.w, l: t.l, t: t.t, points: t.points,
  pointsAgainst: t.pointsAgainst, tuh: t.tuh, counts: t.counts, bonusesHeard: t.bonusesHeard, bonusPoints: t.bonusPoints }))
  .sort((x, y) => x.name.localeCompare(y.name));
const playerView = (agg) => agg.players.map((p) => ({ name: p.name, team: p.team, gp: p.gp, tuh: p.tuh, counts: p.counts, points: p.points }))
  .sort((x, y) => (x.team + x.name).localeCompare(y.team + y.name));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- the TD sets up ---------- */

d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slug = 'e2eday-' + Math.random().toString(36).slice(2, 8);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'E2E Day', slug } });
ok('TD creates the tournament', r.status === 200, r.body);
const A = '/a/' + r.body.admin_secret;
const rooms = [];
for (let k = 0; k < ROOMS; k++) {
  r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } });
  rooms.push({ id: r.body.id, secret: r.body.secret, name: 'Room ' + (k + 1) });
}
ok('TD creates the rooms', rooms.every((b) => b.secret), rooms);
r = await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(roster) });
ok('TD uploads the roster', r.status === 200, r.body);
r = await call(A + '/schedule', { method: 'POST', json: { v: 1, rooms: rooms.map((b) => ({ name: b.name, bucket: b.id })),
  phases: [{ name: 'Prelims', rounds: Array.from({ length: ROUNDS }, (_, ri) => ({ round: ri + 1,
    games: pairings(ri + 1).map(([a, b], room) => ({ room, a: { team: teamName(a) }, b: { team: teamName(b) } })), byes: [] })) }],
  updated: 0 } });
ok('TD saves the schedule', r.status === 200, r.body);
const packets = {};
for (let n = 1; n <= ROUNDS; n++) {
  packets[n] = JSON.stringify(packetFor(n));
  r = await call(`${A}/packet?round=${n}&name=Packet${n}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: packets[n] });
  if (r.status !== 200) ok('packet ' + n + ' uploads', false, r.body);
}
ok('TD uploads a categorized packet per round', true);
const kdf = await buzzSettings('dayhunter');
const token = await buzzToken('dayhunter', { kdf: 'pbkdf2', iters: kdf.iters, salt: kdf.salt });
r = await call(A, { method: 'POST', json: { buzz_token: token, settings: { gameFormat: 'acf', autoAdvance: true, buzz: kdf } } });
ok('TD sets the format, buzzpoints password and auto-advance', r.status === 200, r.body);
r = await call(A + '/start', { method: 'POST' });
ok('TD presses Start', r.status === 200, r.body);
r = await call(A, { method: 'POST', json: { published: true } });
ok('TD turns the public page on', r.status === 200, r.body);

/* ---------- the day: rooms play, the TD never sets a round ---------- */

const played = []; // { round, room, file, qbj, id }
let rebuildsSeen = 0;
for (let n = 1; n <= ROUNDS; n++) {
  const games = pairings(n);
  for (const [k, b] of rooms.entries()) {
    const S = '/b/' + b.secret;
    const st = await call(S);
    if (st.body.current_round !== n) ok(`round ${n}: ${b.name} sees round ${n}`, false, st.body.current_round);
    const pk = await call(S + '/packet?round=' + n + '&warm=1');
    const got = typeof pk.body === 'string' ? pk.body : JSON.stringify(pk.body);
    if (!same(JSON.parse(got), JSON.parse(packets[n]))) ok(`round ${n}: ${b.name} gets its exact packet`, false, got.slice(0, 120));
    if (n < ROUNDS && k === 0) {
      const future = await fetch(`${BASE}${S}/packet?round=${n + 1}`);
      ok(`round ${n}: next round's packet is locked`, future.status === 403, future.status);
    }
    r = await call(S + '/start?round=' + n, { method: 'POST' });
    if (r.status !== 200) ok(`round ${n}: ${b.name} starts`, false, r.body);
  }
  ok(`round ${n}: every room saw round ${n}, got its exact packet and started`, true);
  const adv = await call('/b/' + rooms[0].secret);
  ok(`round ${n}: auto-advance moved the round once every room started`, adv.body.current_round === Math.min(n + 1, ROUNDS)
    || (n === ROUNDS && adv.body.current_round === ROUNDS), adv.body.current_round);

  for (const [k, b] of rooms.entries()) {
    const [a, bb] = games[k];
    const qbj = matchFor(n, a, bb, (n + k) % 2 === 1);
    const name = `Round_${n}_${teamName(a)}_${teamName(bb)}.qbj`.replace(/ /g, '_');
    r = await call(`/b/${b.secret}/upload?round=${n}&name=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(qbj) });
    if (r.status !== 200 || r.body.error) ok(`round ${n}: ${b.name} uploads`, false, r.body);
    played.push({ round: n, room: b.name, file: name, qbj, id: r.body.id });
  }
  // a moderator re-exports round 2's first game (a fix): same game, newer file
  if (n === 2) {
    const g = played.find((p) => p.round === 2 && p.room === 'Room 1');
    r = await call(`/b/${rooms[0].secret}/upload?round=2&name=${encodeURIComponent(g.file)}`, { method: 'POST', body: JSON.stringify(g.qbj) });
    ok('round 2: a re-export uploads', r.status === 200 && !r.body.error, r.body);
    played.push({ ...g, id: r.body.id, reexport: true });
  }
  ok(`round ${n}: every room's game uploaded`, true);

  const m0 = await meter();
  await tick();
  const m1 = await meter();
  rebuildsSeen += m1.rebuild_invocations - m0.rebuild_invocations;
  ok(`round ${n}: the cron's rebuild ran as its own invocation (REBUILD binding)`,
    m1.rebuild_invocations > m0.rebuild_invocations, { before: m0.rebuild_invocations, after: m1.rebuild_invocations });
  const pubNow = (await call('/pub/' + slug)).body;
  ok(`round ${n}: the public page lists every game uploaded so far`,
    pubNow.files.length === played.length && pubNow.rounds[n] !== undefined, { files: pubNow.files.length, played: played.length });
}

/* ---------- expected results, from the games themselves ---------- */

const originals = played.filter((p) => !p.reexport);
const rosterParsed = parseRoster(roster);
const expected = aggregate(originals.map((p) => Object.assign(parseMatch(p.qbj, { filename: p.file }), { room: p.room, fileId: p.id })), rosterParsed);
ok('expected standings have every team, all rostered', expected.teams.length === TEAMS
  && expected.teams.every((t) => t.rostered) && expected.players.every((p) => p.rostered), expected.teams.map((t) => t.name));

/* ---------- the public page ---------- */

const pubState = (await call('/pub/' + slug)).body;
const shards = (await call('/pub/' + slug + '/rounds?n=' + Array.from({ length: ROUNDS }, (_, i) => i + 1).join(','))).body.rounds;
const entries = shards.flatMap((s) => s.entries);
ok('public shards hold every upload, re-export included', entries.length === played.length, entries.length);
ok('every public entry names the room that uploaded it', entries.every((e) => played.some((p) => p.id === e.id && p.room === e.room)));
ok('public copies carry no moderator notes', !JSON.stringify(entries).includes('"notes"'));
const liveRoom = new Map(pubState.files.map((f) => [f.id, f.room]));
const pubMatches = entries.map((e) => Object.assign(parseMatch(e.qbj, { filename: e.filename }), { room: liveRoom.get(e.id) || e.room, fileId: e.id }));
const pubAgg = aggregate(pubMatches, rosterParsed);
ok('public standings match the games exactly', same(teamView(pubAgg), teamView(expected)), { pub: teamView(pubAgg).slice(0, 2), exp: teamView(expected).slice(0, 2) });
ok('public individual stats match exactly', same(playerView(pubAgg), playerView(expected)));
ok('the re-export counts once, not twice', pubAgg.teams.reduce((n, t) => n + t.gp, 0) === originals.length * 2);
for (let n = 1; n <= ROUNDS; n++) {
  const stamp = pubState.rounds[n];
  const shard = shards.find((s) => s.round === n);
  if (!shard || shard.v !== stamp) ok(`round ${n}: shard stamp matches the state`, false, { stamp, v: shard && shard.v });
}
ok('every round shard matches its stamp in the state', true);

// a view reads the prebuilt state: flat D1 cost
const v0 = await meter();
await call('/pub/' + slug);
const v1 = await meter();
ok(`a public view reads ${v1.rows_read - v0.rows_read} D1 row(s)`, v1.rows_read - v0.rows_read <= 3, v1.rows_read - v0.rows_read);

// categories: the map the Categories tab reads, per packet question
const cats = (await call('/pub/' + slug + '/cats')).body;
ok('categories published for every round', Object.keys(cats.rounds || {}).length === ROUNDS, Object.keys(cats.rounds || {}));
ok('each tossup carries its packet category', [1, 2, 3, 4].every((n) => cats.rounds[n].t.every((c, i) => c && c.c === CATS[i % CATS.length][0])), cats.rounds[1]);
ok('categories are text-free', !JSON.stringify(cats).includes('tossup 1 text'));

// buzzpoints: every round has all rooms in, so all are readable with the password
ok('buzzpoints on, every round done', pubState.buzz === 'password' && [1, 2, 3, 4].every((n) => pubState.buzz_done.includes(n)), pubState.buzz_done);
const qp = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`, { headers: { Authorization: 'Buzz ' + token } });
ok('buzzpoints packet text opens with the password', qp.status === 200 && same(JSON.parse(await qp.text()), JSON.parse(packets[1])), qp.status);
const qpBad = await fetch(`${BASE}/pub/${slug}/qpacket?round=1`, { headers: { Authorization: 'Buzz ' + 'f'.repeat(64) } });
ok('...and not without it', qpBad.status === 401, qpBad.status);

/* ---------- the TD's exports ---------- */

const detail = (await call(A)).body;
const qbjFiles = detail.files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
ok('the Live Hub lists every upload', qbjFiles.length === played.length, qbjFiles.length);
const exportMatches = [];
for (const f of qbjFiles) {
  const res = await fetch(`${BASE}${A}/file?key=${encodeURIComponent(f.r2_key)}`);
  const m = parseMatch(matchPayload(JSON.parse(await res.text())), { filename: f.filename });
  m.room = detail.buckets.find((b) => b.id === f.bucket_id).room_name;
  m.fileId = f.id;
  exportMatches.push(m);
}
const exportAgg = aggregate(exportMatches, rosterParsed);
ok('Compute stats (the TD\'s download path) matches the games exactly', same(teamView(exportAgg), teamView(expected)));
ok('...individuals too', same(playerView(exportAgg), playerView(expected)));
let yft = null;
try { yft = buildYft({ matches: exportMatches, roster: rosterParsed, settings: {} }); } catch (e) { yft = e; }
ok('the YellowFruit export builds and has every team', yft && !(yft instanceof Error)
  && Array.from({ length: TEAMS }, (_, t) => teamName(t)).every((name) => JSON.stringify(yft).includes(name)), yft instanceof Error ? yft.message : null);

/* ---------- room pages ---------- */

for (const b of rooms) {
  const st = (await call('/b/' + b.secret)).body;
  const mine = played.filter((p) => p.room === b.name);
  if (st.upload_count !== mine.length) ok(`${b.name} lists its own uploads`, false, { listed: st.upload_count, mine: mine.length });
}
ok('every room page lists exactly its own uploads', true);
ok(`the cron rebuilt through the binding on every busy tick (${rebuildsSeen} invocations)`, rebuildsSeen >= ROUNDS, rebuildsSeen);

summary('day e2e');
