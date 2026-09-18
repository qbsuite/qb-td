// e2e_sets.js — end-to-end test of question sets against a locally
// running Worker (same setup as e2e_worker.js, migrate-sets.sql applied):
//   node tests/e2e_sets.js
//
// Editor -> invite -> mirror TD -> moderator -> set-wide reads: a set's
// packets uploaded once, a mirror started from an invite (or an existing
// tournament joined to the set) and running on them — on the rounds its
// TD chooses — a mid-season packet fix reaching only the rounds not yet
// opened, question maps following questions across versions, and the
// games (and game files) coming back through the set routes.

import { buzzSettings, buzzToken } from '../app/js/buzzkey.js';
import { BASE, storedCred, d1row, d1exec, r2get, call, maxAge, tick, ok, summary } from './e2e_lib.js';

const packet = (marker, category) => JSON.stringify({
  tossups: [
    { question: `For ten points, ${marker} one.`, answer: '<b><u>First</u></b>', category, subcategory: 'American' },
    { question: `For ten points, ${marker} two.`, answer: '<b><u>Second</u></b>', category: 'Science', subcategory: 'Physics' },
  ],
  bonuses: [
    { leadin: `${marker} bonus`, parts: ['a', 'b', 'c'], answers: ['x', 'y', 'z'], values: [10, 10, 10], category },
  ],
});

const game = (round, a, b) => JSON.stringify({
  tossups_read: 20, _round: round,
  match_teams: [
    { team: { name: a }, bonus_points: 20,
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20,
        answer_counts: [{ number: 2, answer: { value: 10 } }] }] },
    { team: { name: b }, bonus_points: 0,
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20,
        answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
  ],
});

const text = async (path, headers) => {
  const res = await fetch(BASE + path, { headers });
  return { status: res.status, body: await res.text() };
};
const rnd = () => Math.random().toString(36).slice(2, 8);

// Every run of this suite starts a few mirrors from one IP, and the
// Worker caps those per IP per day (START_PER_IP_DAY): earlier runs'
// mirrors are handed to another IP so the cap counts only this run.
d1exec("UPDATE tournaments SET creator_ip = 'earlier-run' WHERE set_id IS NOT NULL");

/* ---------- the set ---------- */

let r = await call('/s/abcdefghjkmnpqrstuvw');
ok('bad set link 404', r.status === 404);

const setSlug = 'e2e-set-' + rnd();
r = await call('/api/sets', { method: 'POST', json: { name: 'E2E Set', slug: setSlug } });
ok('create set', r.status === 200 && r.body.admin_secret.length >= 10, r.body);
ok('set link lives a year', r.body.closes > Date.now() + 364 * 24 * 3600 * 1000
  && r.body.closes < Date.now() + 366 * 24 * 3600 * 1000, r.body.closes);
const setSecret = r.body.admin_secret;
const sid = r.body.id;
let S = '/s/' + setSecret;

r = await call('/api/sets', { method: 'POST', json: { name: 'dupe', slug: setSlug } });
ok('duplicate set slug rejected', r.status === 409);
r = await call('/api/sets', { method: 'POST', json: { name: 'x', slug: 'No Good' } });
ok('bad set slug rejected', r.status === 400);

r = await call(S);
ok('set detail', r.status === 200 && r.body.set.slug === setSlug && r.body.packets.length === 0, r.body);
ok('set detail omits credentials', r.body.set.admin_secret === undefined
  && r.body.set.admin_wrap === undefined && r.body.set.creator_ip === undefined, r.body.set);
ok('set credential stored hashed',
  d1row(`SELECT admin_secret FROM sets WHERE id = ${sid}`).admin_secret === storedCred(setSecret));

// packets: every upload is a version
r = await call(`${S}/packet?packet=1&name=Round1.json`, { method: 'POST', body: packet('SETSECRET-R1V1', 'History') });
ok('upload set packet', r.status === 200 && r.body.version === 1 && r.body.mirrors === 0, r.body);
r = await call(`${S}/packet?packet=2&name=Round2.json`, { method: 'POST', body: packet('SETSECRET-R2V1', 'Literature') });
ok('upload second round', r.status === 200 && r.body.version === 1, r.body);
r = await call(`${S}/packet?packet=0&name=x.json`, { method: 'POST', body: '{}' });
ok('bad round rejected', r.status === 400);

const r1v1 = d1row(`SELECT r2_key FROM set_packets WHERE set_id = ${sid} AND packet = 1 AND version = 1`).r2_key;
ok('set packets live under the set prefix', r1v1.startsWith(`s/${sid}/packet/1/v1-`), r1v1);
ok('set packet encrypted at rest', !r2get(r1v1).toString('latin1').includes('SETSECRET'));
{
  const dl = await text(`${S}/file?packet=1&v=1`);
  ok('editor downloads a packet version', dl.status === 200 && dl.body.includes('SETSECRET-R1V1'), dl.status);
  const none = await text(`${S}/file?packet=1&v=9`);
  ok('unknown version 404', none.status === 404);
}
r = await call(`${S}/packet/status`, { method: 'POST', json: { packet: 1, v: 1, warnings: 2 } });
ok('record a parse review', r.status === 200, r.body);
r = await call(`${S}/packet/status`, { method: 'POST', json: { packet: 1, v: 1, checked: true } });
r = await call(S);
ok('packets carry their review state',
  r.body.packets[0].warnings === 2 && typeof r.body.packets[0].checked === 'number' && r.body.packets[1].checked === null, r.body.packets);
r = await call(`${S}/packet/status`, { method: 'POST', json: { packet: 9, v: 1, checked: true } });
ok('a review needs its packet', r.status === 404);
r = await call(`${S}/cats`);
ok('set category map keyed by round and version', r.status === 200
  && r.body.packets['1']['1'].t[0].c === 'History' && r.body.packets['2']['1'].b[0].c === 'Literature', r.body);

// question identity: a version's question map rides in the (public,
// text-free) category map; the ledger it was matched against is question
// text, kept under the set's key
r = await call(S + '/ledger');
ok('no ledger yet', r.status === 200 && r.body === '\n', JSON.stringify(r.body));
const ledger1 = { v: 1, seq: 3, questions: { 1: { kind: 't', revs: [{ text: 'LEDGERSECRET one' }] } } };
const qmapBody = (meta, ledger) => JSON.stringify(meta) + '\n' + JSON.stringify(ledger);
r = await call(S + '/qmap', { method: 'POST', body: qmapBody({ packet: 1, v: 1, q: { t: [[1, 1], [2, 1]], b: [[3, 1]] }, etag: null }, ledger1) });
ok('record a question map', r.status === 200 && typeof r.body.etag === 'string', r.body);
const ledgerEtag = r.body.etag;
r = await call(S + '/qmap', { method: 'POST', body: qmapBody({ packet: 1, v: 1, q: { t: [], b: [] }, etag: null }, ledger1) });
ok('a stale ledger is refused', r.status === 409, r.body);
r = await call(S + '/qmap', { method: 'POST', body: qmapBody({ packet: 1, v: 1, q: { t: [[1, 'x']], b: [] }, etag: ledgerEtag }, ledger1) });
ok('a malformed question map is refused', r.status === 400, r.body);
r = await call(S + '/qmap', { method: 'POST', body: qmapBody({ packet: 1, v: 1, q: { t: [], b: [] }, etag: ledgerEtag }, 'nope') });
ok('a ledger that is not an object is refused', r.status === 400, r.body);
r = await call(S + '/qmap', { method: 'POST', body: qmapBody({ packet: 9, v: 1, q: { t: [], b: [] }, etag: ledgerEtag }, ledger1) });
ok('a question map needs its packet', r.status === 404, r.body);
r = await call(S + '/ledger');
ok('ledger reads back through the set link, etag first',
  r.body.split('\n')[0] === ledgerEtag && JSON.parse(r.body.slice(r.body.indexOf('\n') + 1)).seq === 3, r.body);
ok('ledger encrypted at rest', !r2get(`s/${sid}/ledger.json`).toString('latin1').includes('LEDGERSECRET'));
r = await call(`${S}/cats`);
ok('question map sits beside the categories', JSON.stringify(r.body.packets['1']['1'].q) === JSON.stringify({ t: [[1, 1], [2, 1]], b: [[3, 1]] })
  && r.body.packets['1']['1'].t[0].c === 'History', r.body.packets['1']);

// tiebreakers + reader format ride into every mirror
r = await call(`${S}/tiebreakers?name=tb.json`, { method: 'POST', body: packet('SETSECRET-TB', 'History') });
ok('set tiebreaker pool', r.status === 200 && r.body.tossups === 2 && r.body.bonuses === 1, r.body);
r = await call(S, { method: 'POST', json: { settings: { gameFormat: 'acf' } } });
ok('set settings saved', r.status === 200, r.body);

/* ---------- invite -> mirror ---------- */

r = await call(`${S}/mirrors`, { method: 'POST', json: { name: '', host: 'Nowhere' } });
ok('mirror needs a name', r.status === 400);
r = await call(`${S}/mirrors`, { method: 'POST', json: { name: 'Stanford mirror', event_date: '10/12' } });
ok('mirror date must be ISO', r.status === 400, r.body);
const mirrorSlug = 'e2e-mirror-' + rnd();
r = await call(`${S}/mirrors`, { method: 'POST',
  json: { name: 'Stanford mirror', slug: mirrorSlug, host: 'Stanford', event_date: '2026-10-12' } });
ok('create mirror invite', r.status === 200 && r.body.invite.length >= 10, r.body);
const invite = r.body.invite;
const mirrorId = r.body.id;

ok('invite stored hashed', d1row(`SELECT invite_secret FROM set_mirrors WHERE id = ${mirrorId}`)
  .invite_secret === storedCred(invite));
r = await call(S);
ok('editor can read the invite back', r.body.mirrors[0].invite === invite && r.body.mirrors[0].tournament === null, r.body.mirrors);

r = await call('/i/abcdefghjkmnpqrstuvw');
ok('bad invite 404', r.status === 404);
r = await call('/i/' + invite);
ok('invite describes the mirror', r.status === 200 && r.body.set === 'E2E Set' && r.body.name === 'Stanford mirror'
  && r.body.slug === mirrorSlug && r.body.packets === 2 && r.body.started === null, r.body);

r = await call('/i/' + invite, { method: 'POST', json: { name: 'Stanford mirror', slug: 'x' } });
ok('start rejects a bad slug', r.status === 400);
r = await call('/i/' + invite);
ok('a rejected start leaves the invite startable', r.body.started === null);

r = await call('/i/' + invite, { method: 'POST', json: { name: 'Stanford Mirror of E2E', slug: mirrorSlug } });
ok('start the mirror', r.status === 200 && r.body.admin_secret.length >= 10 && r.body.rounds === 2, r.body);
ok('a started mirror is an ordinary 48h tournament',
  r.body.closes > Date.now() + 47 * 3600 * 1000 && r.body.closes < Date.now() + 49 * 3600 * 1000);
const A = '/a/' + r.body.admin_secret;
const tid = r.body.id;

r = await call('/i/' + invite, { method: 'POST', json: { name: 'again', slug: mirrorSlug + '-2' } });
ok('an invite starts once', r.status === 409, r.body);
r = await call(S);
ok('editor sees the started mirror', r.body.mirrors[0].invite === null
  && r.body.mirrors[0].tournament.slug === mirrorSlug && r.body.mirrors[0].tournament.games === 0, r.body.mirrors);

// the mirror's dashboard: rounds prefilled, format copied, keys not leaked
r = await call(A);
ok('mirror knows its set', r.status === 200 && r.body.tournament.set.name === 'E2E Set'
  && r.body.tournament.set.slug === setSlug, r.body.tournament);
ok('mirror rounds prefilled from the set', r.body.rounds.length === 2
  && r.body.rounds[0].packet_r2_key === r1v1 && r.body.rounds[0].packet_name === 'Round1.json', r.body.rounds);
{
  const settings = JSON.parse(r.body.tournament.settings);
  ok('mirror settings prefilled', settings.rounds === 2 && settings.gameFormat === 'acf', settings);
  ok('set buzz config never copied', settings.buzz === undefined);
}
ok('mirror detail omits key material', r.body.tournament.set_key_enc === undefined
  && r.body.tournament.skey === undefined && r.body.tournament.ckey === undefined);
ok('mirror sees the set\'s packets to choose from', r.body.set_packets.length === 2
  && r.body.set_packets[0].packet === 1 && r.body.set_packets[0].r2_key === r1v1, r.body.set_packets);

{
  const dl = await text(`${A}/file?key=${encodeURIComponent(r1v1)}`);
  ok('mirror TD downloads a set packet', dl.status === 200 && dl.body.includes('SETSECRET-R1V1'), dl.status);
  const other = await text(`${A}/file?key=${encodeURIComponent(`s/${sid + 999}/packet/1/v1-aaaaaa/Round1.json`)}`);
  ok("another set's prefix is refused", other.status === 403);
  const unref = await text(`${A}/file?key=${encodeURIComponent(`s/${sid}/packet/9/v1-aaaaaa/x.json`)}`);
  ok('an unreferenced set key is refused', unref.status === 403);
}

// a room reads the set's packet through its own link
r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
const room = r.body.secret;
{
  const p1 = await text(`/b/${room}/packet?round=1`);
  ok('room reads the set packet', p1.status === 200 && p1.body.includes('SETSECRET-R1V1'), p1.status);
  const p2 = await text(`/b/${room}/packet?round=2`);
  ok('future set rounds stay locked', p2.status === 403);
  const tb = await call(`/b/${room}/tiebreakers`);
  ok('rooms read the set\'s backup questions, ids set apart', tb.status === 200
    && tb.body.tossups.length === 2 && tb.body.tossups[0].id === 'S-TU1' && tb.body.tossups[0].set === true
    && tb.body.tossups[0].question.includes('SETSECRET-TB') && tb.body.uses.length === 0, tb.body);
}
// the pool is read live: what the editors add later reaches a running mirror
r = await call(`${S}/tiebreakers?name=tb2.json`, { method: 'POST', body: packet('SETSECRET-TB2', 'History') });
ok('editors add backup questions mid-season', r.status === 200 && r.body.tossups === 4, r.body);
// ...and the TD's own pool sits after it, its ids untouched
r = await call(`${A}/tiebreakers?name=own-tb.json`, { method: 'POST', body: packet('TD-TB', 'History') });
ok('TD adds their own backup questions', r.status === 200 && r.body.tossups === 2, r.body);
r = await call(`${A}/tiebreakers`);
ok('TD dashboard sees both pools merged', r.status === 200
  && r.body.tossups.map((q) => q.id).join() === 'S-TU1,S-TU2,S-TU3,S-TU4,TU1,TU2', r.body.tossups.map((q) => q.id));

/* ---------- games come back ---------- */

r = await call(`/b/${room}/upload?name=r1.qbtd.json&round=1`, { method: 'POST', body: JSON.stringify({
  qbj: JSON.parse(game(1, 'Alpha', 'Beta')), game: { marker: 'MODAQSTATE' }, tb: { used: ['S-TU3', 'TU2', 'nope'] } }) });
ok('room uploads a game', r.status === 200 && !r.body.error, r.body);
const gameFileId = r.body.id;
await tick();
{
  const tb = await call(`/b/${room}/tiebreakers`);
  ok('usage log covers set and own questions alike',
    tb.body.uses.map((u) => u.q).sort().join() === 'S-TU3,TU2', tb.body.uses);
}

// the editors can open a mirror's stored game files — MODAQ's included
r = await call(`${S}/files?m=${tid}`);
ok('editor lists a mirror\'s uploads', r.status === 200 && r.body.files.length === 1
  && r.body.files[0].id === gameFileId && r.body.files[0].room === 'Room 1', r.body);
{
  const g = await text(`${S}/gamefile?m=${tid}&id=${gameFileId}&part=game`);
  ok('editor downloads the MODAQ game file', g.status === 200 && g.body.includes('MODAQSTATE'), g.status);
  const qb = await text(`${S}/gamefile?m=${tid}&id=${gameFileId}&part=qbj`);
  ok('editor downloads the match qbj', qb.status === 200 && qb.body.includes('Alpha') && !qb.body.includes('MODAQSTATE'), qb.status);
  const other = await text(`${S}/gamefile?m=${tid + 9999}&id=${gameFileId}&part=game`);
  ok('files of a tournament outside the set are refused', other.status === 404);
}
ok('the mirror\'s key is held under the set\'s, not in the clear',
  !/^[A-Za-z0-9+/=]{44}$/.test(d1row(`SELECT mirror_key_enc FROM set_mirrors WHERE id = ${mirrorId}`).mirror_key_enc));

r = await call(S + '/state');
ok('set state lists the mirror', r.status === 200 && r.body.mirrors.length === 1
  && r.body.mirrors[0].id === tid && r.body.mirrors[0].label === 'Stanford mirror'
  && r.body.mirrors[0].host === 'Stanford' && r.body.mirrors[0].date === '2026-10-12', r.body);
ok('an unpublished mirror still materializes for its set',
  r.body.mirrors[0].rounds['1'] !== undefined && r.body.mirrors[0].page === false, r.body.mirrors[0]);
ok('state pins packet versions per mirror',
  JSON.stringify(r.body.mirrors[0].vmap) === JSON.stringify({ 1: [1, 1], 2: [2, 1] }), r.body.mirrors[0].vmap);
ok('state reports finished rounds', JSON.stringify(r.body.mirrors[0].done) === '[1]', r.body.mirrors[0].done);
ok('state carries current packet versions', JSON.stringify(r.body.packets) === JSON.stringify({ 1: 1, 2: 1 }), r.body.packets);
ok('state carries the category stamp', typeof r.body.cats === 'number');

r = await call(`${S}/rounds?m=${tid}&n=1`);
ok('editor reads a mirror\'s games', r.status === 200 && r.body.rounds.length === 1
  && r.body.rounds[0].entries.length === 1 && r.body.rounds[0].entries[0].qbj.match_teams.length === 2, r.body);
r = await call(`${S}/rounds?m=${tid + 9999}&n=1`);
ok('a tournament outside the set is refused', r.status === 404);

// public set page: the set's own flag, not the mirror's
r = await call('/pubset/' + setSlug);
ok('unpublished set 404', r.status === 404);
r = await call(S, { method: 'POST', json: { published: true } });
ok('publish set', r.status === 200);
r = await call('/pubset/' + setSlug);
ok('public set state', r.status === 200 && r.body.name === 'E2E Set' && r.body.mirrors.length === 1
  && r.body.buzz === null, r.body);
ok('public set state is cacheable', maxAge(r.cache) === 60, r.cache);
r = await call(`/pubset/${setSlug}/rounds?m=${tid}&n=1`);
ok('public set serves an unpublished mirror\'s games', r.status === 200 && r.body.rounds[0].entries.length === 1, r.body);
r = await call(`/pubset/${setSlug}/cats`);
ok('public set category map', r.status === 200 && r.body.packets['1']['1'].t.length === 2
  && r.body.packets['1']['1'].q.t.length === 2);
r = await call('/pub/' + mirrorSlug);
ok('the mirror\'s own page stays its TD\'s call', r.status === 404);

/* ---------- a mid-season fix ---------- */

r = await call(`${S}/packet?packet=1&name=Round1-fixed.json`, { method: 'POST', body: packet('SETSECRET-R1V2', 'History') });
ok('a played round is not re-pointed', r.status === 200 && r.body.version === 2 && r.body.mirrors === 0, r.body);
r = await call(`${S}/packet?packet=2&name=Round2-fixed.json`, { method: 'POST', body: packet('SETSECRET-R2V2', 'Geography') });
ok('an unplayed round follows the fix', r.body.version === 2 && r.body.mirrors === 1, r.body);
r = await call(`${S}/packet?packet=3&name=Round3.json`, { method: 'POST', body: packet('SETSECRET-R3V1', 'Trash') });
ok('a new round reaches live mirrors', r.body.version === 1 && r.body.mirrors === 1, r.body);
await call(`${S}/packet?packet=4&name=Round4.json`, { method: 'POST', body: packet('SETSECRET-R4V1', 'Trash') });

r = await call(A);
{
  const by = Object.fromEntries(r.body.rounds.map((x) => [x.number, x]));
  ok('mirror keeps the version it played', by[1].packet_r2_key === r1v1, by[1]);
  ok('mirror picked up round 2 v2', by[2].packet_name === 'Round2-fixed.json', by[2]);
  ok('mirror picked up round 3', by[3] && by[3].packet_name === 'Round3.json', by[3]);
}
await call(A, { method: 'POST', json: { current_round: 2 } });
{
  const p2 = await text(`/b/${room}/packet?round=2`);
  ok('room now reads the fixed round', p2.body.includes('SETSECRET-R2V2'), p2.status);
}
// ...and from that moment the round is pinned: a moderator is reading v2,
// so a further fix must not put other rooms of this site on different text
r = await call(`${S}/packet?packet=2&name=Round2-again.json`, { method: 'POST', body: packet('SETSECRET-R2V3', 'Mythology') });
ok('a round a room is already reading is not re-pointed', r.body.version === 3 && r.body.mirrors === 0, r.body);
{
  const p2 = await text(`/b/${room}/packet?round=2`);
  ok('the site stays on the version it started the round with', p2.body.includes('SETSECRET-R2V2'), p2.status);
}
await call(A, { method: 'POST', json: { published: true } });
await tick();
r = await call(`/pub/${mirrorSlug}/cats`);
ok('mirror category map follows the fix', r.status === 200 && r.body.rounds['2'].t[0].c === 'Geography'
  && r.body.rounds['3'].t[0].c === 'Trash' && r.body.rounds['1'].t[0].c === 'History', r.body);

// which round reads which packet is the TD's call
r = await call(`${A}/setpacket`, { method: 'POST', json: { round: 6, packet: 3 } });
ok('TD puts a set packet on another round', r.status === 200 && r.body.version === 1, r.body);
r = await call(`${A}/setpacket`, { method: 'POST', json: { round: 1, packet: 3 } });
ok('a round with games keeps its packet', r.status === 409, r.body);
r = await call(`${A}/setpacket`, { method: 'POST', json: { round: 7, packet: 99 } });
ok('only the set\'s packets can be chosen', r.status === 404, r.body);
r = await call(A);
ok('the chosen round points at the set\'s packet',
  r.body.rounds.find((x) => x.number === 6).packet_r2_key === r.body.rounds.find((x) => x.number === 3).packet_r2_key, r.body.rounds);

// a TD's own packet is theirs: the set stops touching that round
r = await call(`${A}/packet?round=3&name=Own3.json`, { method: 'POST', body: packet('TD-OWN', 'History') });
ok('TD overrides a round', r.status === 200);
r = await call(`${S}/packet?packet=3&name=Round3-v2.json`, { method: 'POST', body: packet('SETSECRET-R3V2', 'Trash') });
ok('a fix follows the packet to the round the TD put it on, not the overridden one',
  r.body.version === 2 && r.body.mirrors === 1, r.body);
r = await call(A);
ok('round 6 took the fix, round 3 stayed the TD\'s',
  r.body.rounds.find((x) => x.number === 6).packet_name === 'Round3-v2.json'
  && r.body.rounds.find((x) => x.number === 3).packet_name === 'Own3.json', r.body.rounds);
r = await call(`${A}/setpacket`, { method: 'POST', json: { round: 6, packet: null } });
ok('TD clears a round', r.status === 200, r.body);
r = await call(A);
ok('cleared round is gone', !r.body.rounds.some((x) => x.number === 6), r.body.rounds);

// retiring a round takes it out of mirrors that have not reached it...
r = await call(`${S}/packet?packet=4`, { method: 'DELETE' });
ok('retire a round', r.status === 200 && r.body.mirrors === 1, r.body);
r = await call(A);
ok('retired round leaves the mirror', !r.body.rounds.some((x) => x.number === 4), r.body.rounds);
// ...but not out of one whose rooms are already reading it
r = await call(`${S}/packet?packet=2`, { method: 'DELETE' });
ok('retiring a round in play leaves that mirror alone', r.status === 200 && r.body.mirrors === 0, r.body);
r = await call(A);
ok('the round in play keeps its packet', r.body.rounds.some((x) => x.number === 2 && x.packet_name === 'Round2-fixed.json'), r.body.rounds);
r = await call(S);
ok('retired versions are kept, flagged',
  r.body.packets.filter((x) => x.packet === 2).length === 3
  && r.body.packets.filter((x) => x.packet === 2).every((x) => x.retired === 1), r.body.packets);
ok('editor sees how long each mirror can still change',
  r.body.mirrors[0].tournament.final === r.body.mirrors[0].tournament.created + 96 * 3600 * 1000, r.body.mirrors[0].tournament);
await tick();
r = await call(S + '/state');
ok('state follows: played pin, pinned fix, own packet, retired rounds',
  JSON.stringify(r.body.mirrors[0].vmap) === JSON.stringify({ 1: [1, 1], 2: [2, 2], 3: null })
  && JSON.stringify(r.body.packets) === JSON.stringify({ 1: 2, 3: 2 }), r.body);
ok('state sees the mirror\'s page go public', r.body.mirrors[0].page === true);

/* ---------- buzzpoints text ---------- */

{
  const cred = await buzzSettings('setpw');
  const tok = await buzzToken('setpw', cred);
  r = await call(S, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: cred }, buzz_token: tok } });
  ok('set buzz password', r.status === 200, r.body);
  r = await call('/pubset/' + setSlug);
  ok('public set advertises the gate, not the hash', r.body.buzz === 'password'
    && r.body.buzz_kdf.salt === cred.salt && JSON.stringify(r.body).indexOf(cred.hash) === -1, r.body);

  const q = `/pubset/${setSlug}/qpacket`;
  const noauth = await text(`${q}?packet=1&v=1`);
  ok('set qpacket needs the password', noauth.status === 401);
  const wrong = await text(`${q}?packet=1&v=1`, { Authorization: 'Buzz ' + await buzzToken('nope', cred) });
  ok('set qpacket rejects a wrong password', wrong.status === 401);
  const right = await text(`${q}?packet=1&v=1`, { Authorization: 'Buzz ' + tok });
  ok('set qpacket serves the version a mirror played', right.status === 200 && right.body.includes('SETSECRET-R1V1'), right.status);
  const unplayed = await text(`${q}?packet=1&v=2`, { Authorization: 'Buzz ' + tok });
  ok('an unplayed version stays locked', unplayed.status === 403, unplayed.status);
  const future = await text(`${q}?packet=3&v=2`, { Authorization: 'Buzz ' + tok });
  ok('an unplayed round stays locked', future.status === 403, future.status);

  // the mirror's own buzzpoints: its TD's password opens the SET's packet
  const mcred = await buzzSettings('mirrorpw');
  const mtok = await buzzToken('mirrorpw', mcred);
  await call(A, { method: 'POST', json: { settings: { rounds: 3, buzz: mcred }, buzz_token: mtok } });
  const mq = await text(`/pub/${mirrorSlug}/qpacket?round=1`, { Authorization: 'Buzz ' + mtok });
  ok('mirror buzzpoints decrypt the set packet', mq.status === 200 && mq.body.includes('SETSECRET-R1V1'), mq.status);
  const cross = await text(`${q}?packet=1&v=1`, { Authorization: 'Buzz ' + mtok });
  ok('a mirror password does not open the set', cross.status === 401);

  // the editors can switch their mirrors' own buzzpoints off altogether
  r = await call(S, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: cred, lockMirrorBuzz: true } } });
  ok('lock mirror buzzpoints', r.status === 200);
  const locked = await text(`/pub/${mirrorSlug}/qpacket?round=1`, { Authorization: 'Buzz ' + mtok });
  ok('a locked mirror serves no question text', locked.status === 404, locked.status);
  r = await call('/pub/' + mirrorSlug);
  ok('a locked mirror\'s page shows no buzzpoints tab', r.status === 200 && r.body.buzz === null && r.body.packet_rounds.length === 0, r.body);
  r = await call(A);
  ok('the mirror\'s dashboard is told', r.body.tournament.set.lock_buzz === true, r.body.tournament.set);
  const still = await text(`${q}?packet=1&v=1`, { Authorization: 'Buzz ' + tok });
  ok('the set\'s own buzzpoints are unaffected', still.status === 200);
  await call(S, { method: 'POST', json: { settings: { gameFormat: 'acf', buzz: cred } } });
  const unlocked = await text(`/pub/${mirrorSlug}/qpacket?round=1`, { Authorization: 'Buzz ' + mtok });
  ok('unlocking restores them', unlocked.status === 200, unlocked.status);
}

/* ---------- a tournament that already exists joins the set ---------- */

{
  const jslug = 'e2e-joined-' + rnd();
  r = await call('/api/tournaments', { method: 'POST', json: { name: 'Made Earlier', slug: jslug } });
  const J = '/a/' + r.body.admin_secret;
  const jid = r.body.id;
  await call(`${J}/packet?round=1&name=Mine.json`, { method: 'POST', body: packet('JOINER-OWN', 'History') });
  r = await call(`${J}/setpacket`, { method: 'POST', json: { round: 2, packet: 1 } });
  ok('only a mirror can choose set packets', r.status === 409, r.body);
  r = await call(`${S}/mirrors`, { method: 'POST', json: { name: 'Joined mirror', host: 'Late U' } });
  const jinvite = r.body.invite;

  r = await call(`${J}/join`, { method: 'POST', json: { invite: 'abcdefghjkmnpqrstuvw' } });
  ok('joining needs a real invite', r.status === 404, r.body);
  r = await call(`${J}/join`, { method: 'POST', json: { invite: jinvite } });
  ok('an existing tournament joins the set', r.status === 200 && r.body.set === 'E2E Set', r.body);
  r = await call(J);
  ok('joined tournament is a mirror now', r.body.tournament.set && r.body.tournament.set.slug === setSlug, r.body.tournament);
  {
    const by = Object.fromEntries(r.body.rounds.map((x) => [x.number, x]));
    ok('its own packet stays, the set fills the empty rounds',
      by[1].packet_name === 'Mine.json' && by[3] && by[3].packet_r2_key.startsWith(`s/${sid}/packet/3/`)
      && !by[2], by); // packet 2 is retired by now; packet 1 stays off round 1
  }
  r = await call(`${J}/setpacket`, { method: 'POST', json: { round: 2, packet: 1 } });
  ok('and it can place the set\'s packets like any mirror', r.status === 200, r.body);
  r = await call(J + '/buckets', { method: 'POST', json: { room_name: 'J1' } });
  {
    const p2 = await text(`/b/${r.body.secret}/packet?round=1`);
    ok('its rooms still read its own round 1', p2.body.includes('JOINER-OWN'), p2.status);
  }
  r = await call(`${J}/join`, { method: 'POST', json: { invite: jinvite } });
  ok('a tournament joins once', r.status === 409, r.body);
  r = await call('/i/' + jinvite, { method: 'POST', json: { name: 'x', slug: 'e2e-reuse-' + rnd() } });
  ok('a used invite cannot also start a mirror', r.status === 409, r.body);
  r = await call(S);
  ok('editor sees the joined mirror', r.body.mirrors.some((x) => x.tournament && x.tournament.id === jid && x.files === 1), r.body.mirrors);
  r = await call(`${S}/files?m=${jid}`);
  ok('and can reach its files', r.status === 200 && Array.isArray(r.body.files), r.body);
}

/* ---------- hiding, revoking, rotating, expiry ---------- */

r = await call(`${S}/mirrors/${mirrorId}`, { method: 'POST', json: { hidden: true } });
ok('hide a mirror', r.status === 200);
await tick();
r = await call('/pubset/' + setSlug);
ok('hidden mirror leaves the set page', !r.body.mirrors.some((m) => m.id === tid), r.body.mirrors);
r = await call(`/pubset/${setSlug}/rounds?m=${tid}&n=1`);
ok('hidden mirror\'s games are not served', r.status === 404);
await call(`${S}/mirrors/${mirrorId}`, { method: 'POST', json: { hidden: false } });
await tick();
r = await call('/pubset/' + setSlug);
ok('unhidden mirror returns with its state',
  (r.body.mirrors.find((m) => m.id === tid) || { rounds: {} }).rounds['1'] !== undefined, r.body.mirrors);

r = await call(`${S}/mirrors/${mirrorId}`, { method: 'POST', json: { revoked: true } });
ok('a started mirror cannot be revoked', r.status === 409);
r = await call(`${S}/mirrors`, { method: 'POST', json: { name: 'Second mirror' } });
const invite2 = r.body.invite;
r = await call(`${S}/mirrors/${r.body.id}`, { method: 'POST', json: { revoked: true } });
ok('revoke an invite', r.status === 200);
r = await call('/i/' + invite2);
ok('revoked invite 404', r.status === 404);
r = await call('/i/' + invite2, { method: 'POST', json: { name: 'x', slug: 'e2e-revoked-' + rnd() } });
ok('revoked invite cannot start', r.status === 404);

r = await call(`${S}/mirrors`, { method: 'POST', json: { name: 'Third mirror' } });
const invite3 = r.body.invite;

// A start that claimed the invite and then died before its tournament
// existed must not strand the invite: the claim lapses.
r = await call(`${S}/mirrors`, { method: 'POST', json: { name: 'Stuck mirror' } });
const stuck = r.body;
d1exec(`UPDATE set_mirrors SET started = ${Date.now()} WHERE id = ${stuck.id}`);
r = await call('/i/' + stuck.invite, { method: 'POST', json: { name: 'Stuck', slug: 'e2e-stuck-' + rnd() } });
ok('a fresh claim blocks a second start', r.status === 409, r.body);
d1exec(`UPDATE set_mirrors SET started = ${Date.now() - 10 * 60 * 1000} WHERE id = ${stuck.id}`);
r = await call('/i/' + stuck.invite);
ok('a lapsed claim reads as not started', r.status === 200 && r.body.started === null, r.body);
r = await call(S);
ok('editor still sees a stranded invite', r.body.mirrors.find((x) => x.id === stuck.id).invite === stuck.invite);
r = await call('/i/' + stuck.invite, { method: 'POST', json: { name: 'Stuck', slug: 'e2e-stuck-' + rnd() } });
ok('a lapsed claim can be started again', r.status === 200 && r.body.rounds === 2, r.body);

r = await call(S + '/rotate', { method: 'POST' });
ok('rotate set link', r.status === 200 && r.body.admin_secret !== setSecret, r.body);
ok('old set link dead', (await call(S)).status === 404);
S = '/s/' + r.body.admin_secret;
{
  const dl = await text(`${S}/file?packet=1&v=2`);
  ok('new set link still opens the packets', dl.status === 200 && dl.body.includes('SETSECRET-R1V2'), dl.status);
}
r = await call('/i/' + invite3);
ok('invites survive a set link rotation', r.status === 200 && r.body.packets === 2, r.body);

d1exec(`UPDATE sets SET created = 1 WHERE id = ${sid}`);
r = await call(S);
ok('expired set link 410', r.status === 410 && r.body.error === 'set closed', r.body);
r = await call('/i/' + invite3, { method: 'POST', json: { name: 'late', slug: 'e2e-late-' + rnd() } });
ok('invites close with their set', r.status === 410, r.body);
r = await call('/pubset/' + setSlug);
ok('published set page survives the link', r.status === 200 && r.body.mirrors.length >= 1);
{
  const p1 = await text(`/b/${room}/packet?round=1`);
  ok('a running mirror outlives the set link', p1.status === 200 && p1.body.includes('SETSECRET-R1V1'), p1.status);
}

summary('set e2e');
