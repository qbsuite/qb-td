// worker_inproc.mjs — E3: what the Worker's game, download and save routes
// answer and what each request costs, pinned. worker.js runs in this
// process (tests/inproc_worker.mjs: SQLite for D1, an in-memory R2), so
// every D1 statement, R2 operation (with its key and whether it is
// conditional) and WebCrypto call is logged, and two goldens must match:
//   tests/golden/worker_downloads.json  status, Content-Type,
//     Content-Disposition, Cache-Control and the body's sha256 of each
//     download: a game's file whole or split (part=qbj|game), under each
//     kind of roster rename; the roster's Setup download; the public
//     per-game QBJ; the hub's /games batch
//   tests/golden/worker_meter.json  the exact operation list of each
//     request: those downloads, the saves (with no base, and with a base
//     equal to what is stored), uploads, room and round moves, the
//     Rebuild, the hub's refresh, the public routes, and cron ticks,
//     one of them rebuilding a question set's state with a mirror whose
//     roster renames and one whose roster doesn't
//   tests/golden/worker_headers.json  the CORS (Access-Control-*), Vary
//     and X-Qbtd-* headers of each of those responses, so a header added
//     to one route (or to all of them) shows up. Each distinct set is
//     listed once under a short hash, and each request names its set.
// Run: node tests/worker_inproc.mjs (part of npm test; Node 22.5+).
// QBTD_UPDATE_GOLDEN=1 rewrites the goldens from the current code.

import { workerHarness, opCounts } from './inproc_worker.mjs';
import { checkGolden, sha } from './golden_lib.mjs';

const w = await workerHarness();
const { call, quiet, measured, sql, raw, setRaw, etag } = w;
const enc = encodeURIComponent;
const downloads = {};
const meter = {};
const headerSets = {};
const headersOf = {};
let failures = 0;

// the response headers a browser acts on beyond the body: CORS, Vary, and
// qb-td's own (X-Qbtd-*), names lowercased, sorted
const HEADER_RE = /^(access-control-|x-qbtd-|vary$)/;
function noteHeaders(label, res) {
  if (!res || !res.headers) return;
  const kept = Object.fromEntries(Object.entries(res.headers).filter(([k]) => HEADER_RE.test(k)).sort(([a], [b]) => a.localeCompare(b)));
  const id = sha(JSON.stringify(kept)).slice(0, 8);
  headerSets[id] = kept;
  headersOf[label] = id;
}

// one request: its operation list goes into the meter golden under `label`
async function op(label, fn) {
  if (meter[label]) throw new Error('two requests labelled ' + label);
  const { res, ops } = await measured(fn);
  meter[label] = { status: res ? res.status : null, ops };
  noteHeaders(label, res);
  return res;
}
// a download: its answer goes into the downloads golden too
async function dl(label, path) {
  const res = await op(label, () => call(path));
  const h = res.headers;
  downloads[label] = {
    // (an upload's stored name starts with a random token: placeholdered)
    status: res.status, type: h['content-type'] || null,
    disposition: h['content-disposition'] ? h['content-disposition'].replace(/(["'])[a-z0-9]{8}-/g, '$1{rand}-') : null,
    cache: h['cache-control'] || null, bytes: res.bytes.length, sha256: sha(res.bytes),
  };
  return res;
}

/* ---------- a tournament with two teams ---------- */

const T = (await quiet(() => call('/api/tournaments', { method: 'POST', json: { name: 'In Process', slug: 'inproc-games' } }))).body;
const A = '/a/' + T.admin_secret;
const tid = T.id;
const rooms = [];
for (let k = 0; k < 3; k++) rooms.push((await quiet(() => call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } }))).body);
const S = (k) => '/b/' + rooms[k].secret;
const ROSTER_KEY = `t/${tid}/roster.qbj`;

const team = (name, players, extra = {}) => ({ name, teams: [{ name, players: players.map((p) => (typeof p === 'string' ? { name: p } : p)), ...extra }] });
const rosterOf = (regs) => ({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'In Process', registrations: regs }] });
const ROSTERS = {
  plain: JSON.stringify(rosterOf([team('Alpha', ['Ann', 'Al']), team('Beta', ['Bob', 'Bea'])])),
  team: JSON.stringify(rosterOf([team('Alpha Prime', ['Ann', 'Al'], { _formerNames: ['Alpha'] }), team('Beta', ['Bob', 'Bea'])])),
  player: JSON.stringify(rosterOf([team('Alpha', [{ name: 'Annie', _formerNames: ['Ann'] }, 'Al']), team('Beta', ['Bob', 'Bea'])])),
  // \u-escaped, as some editors save: "Béta Club", formerly Beta
  escaped: JSON.stringify(rosterOf([team('Alpha', ['Ann', 'Al']), team('Béta Club', ['Bob', 'Bea'], { _formerNames: ['Beta'] })]))
    .replace(/é/g, '\\u00e9'),
  // a rename no game here uses: the map exists and changes nothing
  noop: JSON.stringify(rosterOf([team('Alpha', ['Ann', 'Al']), team('Beta', ['Bob', 'Bea']), team('Gamma', ['Gil'], { _formerNames: ['Delta'] })])),
  // the rename's key itself \u-escaped: only the escape says to parse
  escapedKey: JSON.stringify(rosterOf([team('Alpha', [{ name: 'Annie', _formerNames: ['Ann'] }, 'Al']), team('Beta', ['Bob', 'Bea'])]))
    .replace('_formerNames', '\\u005fformerNames'),
  // \u-escaped with no rename at all: parsed, no map
  escapedPlain: JSON.stringify(rosterOf([team('Alpha', ['Ann', 'Al']), team('Beta', ['Bob', 'Béa'])])).replace(/é/g, '\\u00e9'),
};
await quiet(() => call(A + '/roster?name=roster.qbj', { method: 'POST', body: ROSTERS.plain }));
for (let n = 1; n <= 4; n++) await quiet(() => call(`${A}/packet?round=${n}&name=P${n}.pdf`, { method: 'POST', body: 'PDF'.repeat(50) }));
await quiet(() => call(A + '/start', { method: 'POST' }));
await quiet(() => call(A, { method: 'POST', json: { published: true, current_round: 3 } }));

const match = (round, notes = 'Tossup protest on tossup #3. Team "Alpha" protested because of this reason: "LEAK".') => ({
  tossups_read: 20,
  match_teams: [
    { team: { name: 'Alpha', players: [{ name: 'Ann' }, { name: 'Al' }] }, bonus_points: 30,
      lineups: [{ first_question: 1, players: [{ name: 'Ann' }, { name: 'Al' }] }],
      match_players: [{ player: { name: 'Ann' }, tossups_heard: 20, answer_counts: [{ number: 3, answer: { value: 10 } }] },
        { player: { name: 'Al' }, tossups_heard: 20, answer_counts: [] }] },
    { team: { name: 'Beta', players: [{ name: 'Bob' }, { name: 'Bea' }] }, bonus_points: 0,
      lineups: [{ first_question: 1, players: [{ name: 'Bob' }, { name: 'Bea' }] }],
      match_players: [{ player: { name: 'Bob' }, tossups_heard: 20, answer_counts: [{ number: 1, answer: { value: 10 } }] },
        { player: { name: 'Bea' }, tossups_heard: 20, answer_counts: [] }] },
  ],
  match_questions: [1, 2, 3, 4].map((q) => ({ question_number: q, tossup_question: { question_number: q, type: 'tossup', parts: 1 },
    buzzes: [{ player: { name: q % 2 ? 'Ann' : 'Bob' }, team: { name: q % 2 ? 'Alpha' : 'Beta' }, buzz_position: { word_index: 10 * q }, result: { value: 10 } }] })),
  notes, _round: round, packets: 'P' + round,
});
const game = {
  players: [{ name: 'Ann', teamName: 'Alpha', isStarter: true }, { name: 'Al', teamName: 'Alpha', isStarter: true },
    { name: 'Bob', teamName: 'Beta', isStarter: true }, { name: 'Bea', teamName: 'Beta', isStarter: true }],
  teamNames: ['Alpha', 'Beta'],
  packet: { tossups: [{ question: 'Q'.repeat(400), answer: 'A' }], bonuses: [] },
  cycles: [{ correctBuzz: { marker: { player: { name: 'Ann', teamName: 'Alpha' }, position: 10, points: 10 } } },
    { correctBuzz: { marker: { player: { name: 'Bob', teamName: 'Beta' }, position: 20, points: 10 } } }],
};
const combined = (round, extra = {}) => JSON.stringify({ qbj: match(round), game: { game, uiState: {} },
  modaq: { qbj: JSON.stringify(match(round), null, 4), game: JSON.stringify(game, null, 2) },
  protests: [], progress: { at: 20, of: 20 }, tb: { used: [] }, ...extra });

/* ---------- uploads, both shapes and every kind ---------- */

const up = async (label, k, round, name, body) =>
  (await op('upload: ' + label, () => call(`${S(k)}/upload?round=${round}&name=${enc(name)}`, { method: 'POST', body }))).body;
const F = {};
F.bare = await up('bare .qbj', 0, 1, 'Round_1_Alpha_Beta.qbj', JSON.stringify(match(1), null, 2));
F.reader = await up('reader .qbtd.json', 1, 1, 'Round_1_Alpha_Beta.qbtd.json', combined(1));
F.legacy = await up('reader .qbtd.json without MODAQ texts', 1, 2, 'Round_2_Alpha_Beta.qbtd.json',
  JSON.stringify({ qbj: match(2), game: { game, uiState: {} } }));
F.nogame = await up('reader .qbtd.json with game null', 2, 2, 'Round_2_Beta_Alpha.qbtd.json', JSON.stringify({ qbj: match(2), game: null }));
F.gamefile = await up('_Game.json', 0, 1, 'Round_1_Alpha_Beta_Game.json', JSON.stringify(game, null, 2));
F.errored = await up('a .qbj that is not a game', 2, 1, 'broken.qbj', '{"x":1}');
F.other = await up('another kind of file', 2, 1, 'notes.txt', 'hello');
F.stamped = await up('bare .qbj saying round 2, filed under 3', 0, 3, 'Round_2_Alpha_Beta.qbj', JSON.stringify(match(2), null, 2));
F.wrapped = await up('bare .qbj in an {objects} wrapper', 1, 3, 'Round_3_Alpha_Beta.qbj',
  JSON.stringify({ version: '2.1.1', objects: [{ type: 'Match', ...match(3) }] }));
const keyOf = (f) => sql('SELECT r2_key FROM files WHERE id = ?', f.id)[0].r2_key;

// stored files no upload makes any more, put straight into the bucket:
// a reader upload whose _round is missing, "3", null or true, and .qbj
// files added by hand in each spelling
const HAND = {
  roundMissing: (() => { const m = match(1); delete m._round; return JSON.stringify({ qbj: m, game: { game, uiState: {} }, modaq: { qbj: JSON.stringify(m, null, 4), game: JSON.stringify(game, null, 2) } }); })(),
  roundString: JSON.stringify({ qbj: { ...match(1), _round: '3' }, game: { game, uiState: {} }, modaq: { qbj: JSON.stringify(match(1), null, 4), game: JSON.stringify(game, null, 2) } }),
  roundNull: JSON.stringify({ qbj: { ...match(1), _round: null }, game: { game, uiState: {} } }),
  roundTrue: JSON.stringify({ qbj: { ...match(1), _round: true }, game: { game, uiState: {} } }),
  compact: JSON.stringify(match(1)),
  fourSpace: JSON.stringify(match(1), null, 4),
  crlf: JSON.stringify(match(1), null, 2).replace(/\n/g, '\r\n'),
  noRound: (() => { const m = match(1); delete m._round; return JSON.stringify(m, null, 2); })(),
  notJson: 'not json at all',
};
for (const [k, text] of Object.entries(HAND)) setRaw(`t/${tid}/hand/${k}.qbj`, text);

/* ---------- downloads: every file, every part, every roster ---------- */

const files = { ...Object.fromEntries(Object.entries(F).map(([k, f]) => [k, keyOf(f)])),
  ...Object.fromEntries(Object.keys(HAND).map((k) => ['hand-' + k, `t/${tid}/hand/${k}.qbj`])) };
const PARTS = [null, 'qbj', 'game', 'xyz'];
const download = (label, key, part, name = 'x') => dl(label, `${A}/file?key=${enc(key)}${part ? '&part=' + part : ''}&dl=${enc(name)}`);
for (const [rname, text] of Object.entries(ROSTERS)) {
  setRaw(ROSTER_KEY, text);
  for (const [fname, key] of Object.entries(files)) {
    for (const part of PARTS) await download(`file ${fname} part=${part || '-'} roster=${rname}`, key, part, fname + '.qbj');
  }
}
setRaw(ROSTER_KEY, ROSTERS.plain);
await download('file reader no dl', files.reader, 'qbj', '');
await dl('file reader no dl param', `${A}/file?key=${enc(files.reader)}&part=qbj`);
await dl('file outside the tournament (403)', `${A}/file?key=${enc('t/999/x.qbj')}`);
await dl('file missing (404)', `${A}/file?key=${enc(`t/${tid}/nothing.qbj`)}`);
await dl('file schedule before one is saved', `${A}/file?key=${enc(`t/${tid}/schedule.json`)}`);

// after a round move: the reader upload refiled under round 2
await op('move: reader upload to round 2', () => call(`${A}/files/${F.reader.id}`, { method: 'POST', json: { round: 2 } }));
for (const [rname, text] of Object.entries(ROSTERS)) {
  setRaw(ROSTER_KEY, text);
  for (const part of PARTS) await download(`file reader after round move part=${part || '-'} roster=${rname}`, files.reader, part, 'moved.qbj');
}

// the roster's Setup download (part=roster): with and without former
// names, saved compact (an upload) or indented (the editor), and shapes
// that are not rosters at all
const ROSTER_FILES = {
  'plain compact': ROSTERS.plain,
  'renames compact': ROSTERS.team,
  'plain indented': JSON.stringify(JSON.parse(ROSTERS.plain), null, 2),
  'renames indented': JSON.stringify(JSON.parse(ROSTERS.player), null, 2),
  'renames escaped': ROSTERS.escaped,
  'null': 'null',
  'empty list': '[]',
  'not json': 'Alpha: Ann, Al',
  'duplicate keys': '{"objects":[{"type":"Tournament","registrations":[],"type":"Tournament"}],"version":"2.1.1"}',
  'proto key': '{"__proto__":{"x":1},"objects":[{"type":"Tournament","registrations":[{"name":"A","_formerNames":["B"],"teams":[]}]}]}',
};
for (const [label, text] of Object.entries(ROSTER_FILES)) {
  setRaw(ROSTER_KEY, text);
  await download('roster download: ' + label, ROSTER_KEY, 'roster', 'roster.qbj');
  await download('roster raw: ' + label, ROSTER_KEY, null, 'roster.qbj');
}
await download('roster part on a game file', files.bare, 'roster', 'g.qbj');
// the roster as uploaded through the route, both ways
await op('roster POST (no base)', () => call(A + '/roster?name=roster.qbj', { method: 'POST', body: ROSTERS.team }));
await download('roster download after upload', ROSTER_KEY, 'roster', 'roster.qbj');
await op('roster POST (base equal to the stored etag)', () => call(`${A}/roster?name=roster.qbj&base=${enc(etag(ROSTER_KEY))}`, { method: 'POST', body: ROSTERS.plain }));

/* ---------- the public per-game QBJ and the hub's batch ---------- */

await quiet(() => call(`${A}/bundle`, { method: 'POST', body: JSON.stringify({ entries: [
  { id: F.legacy.id, round: 2, room: 'Room 2', filename: 'Round_2_Alpha_Beta.qbtd.json', qbj: match(2) }] }) }));
const pubIds = { 'upload copy': F.bare.id, 'reader upload copy': F.reader.id, 'objects wrapper': F.wrapped.id,
  'rebuild copy': F.legacy.id, 'missing': 424242, 'error file': F.errored.id };
for (const [rname, text] of Object.entries(ROSTERS)) {
  setRaw(ROSTER_KEY, text);
  for (const [label, id] of Object.entries(pubIds)) await dl(`pub qbj ${label} roster=${rname}`, `/pub/inproc-games/qbj/${id}`);
}
setRaw(ROSTER_KEY, ROSTERS.plain);

const T2 = (await quiet(() => call('/api/tournaments', { method: 'POST', json: { name: 'Other', slug: 'inproc-other' } }))).body;
const A2 = '/a/' + T2.admin_secret;
const room2 = (await quiet(() => call(A2 + '/buckets', { method: 'POST', json: { room_name: 'Elsewhere' } }))).body;
await quiet(() => call(A2 + '/start', { method: 'POST' }));
const other = (await quiet(() => call(`/b/${room2.secret}/upload?round=1&name=o.qbj`, { method: 'POST', body: JSON.stringify(match(1)) }))).body;
const gameIds = sql("SELECT id FROM files WHERE tournament_id = ? AND kind IN ('qbj', 'combined') AND error IS NULL ORDER BY id", tid).map((r) => r.id);
await dl('games batch: every game', `${A}/games?ids=${gameIds.join(',')}`);
await dl('games batch: missing, flagged, another tournament\'s, repeated',
  `${A}/games?ids=${[gameIds[0], 99999, F.errored.id, other.id, gameIds[0], F.other.id].join(',')}`);
await dl('games batch: nothing valid', `${A}/games?ids=a,-1,0`);
await dl('games batch: too many', `${A}/games?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`);

/* ---------- saves: with no base, and with a base equal to what is stored ---------- */

const settingsText = () => sql('SELECT settings FROM tournaments WHERE id = ?', tid)[0].settings;
const save = (label, body, headers = {}) => op(label, () => call(A, { method: 'POST', json: body, headers }));
const base = () => JSON.stringify(JSON.parse(settingsText() || '{}'));
await save('settings POST (no base)', { settings: { gameFormat: 'acf' } });
await save('settings POST (base equal)', { settings: { gameFormat: 'acf', catStats: true }, settings_base: base() });
await save('settings POST statsOpen on (no base)', { settings: { gameFormat: 'acf', statsOpen: true } });
await save('settings POST statsOpen off (no base)', { settings: { gameFormat: 'acf', statsOpen: false } });
await save('settings POST statsOpen on (base equal)', { settings: { gameFormat: 'acf', statsOpen: true }, settings_base: base() });
await save('settings POST statsOpen off (base equal)', { settings: { gameFormat: 'acf', statsOpen: false }, settings_base: base() });
await save('settings POST autoAdvance (no base)', { settings: { gameFormat: 'acf', autoAdvance: true } });
await save('settings POST autoAdvance off (base equal)', { settings: { gameFormat: 'acf', autoAdvance: false }, settings_base: base() });
await save('settings POST autoAdvance on (base equal)', { settings: { gameFormat: 'acf', autoAdvance: true }, settings_base: base() });
await save('settings POST password with no hash (refused)', { settings: { buzz: { mode: 'password' } } });
const R1 = { 'r1|q3|Alpha|Beta': { r: 'upheld', note: 'ok' } };
await save('rulings POST (no base)', { rulings: R1 });
const R2 = { ...R1, 'r1|q4|Beta|Alpha': { r: 'denied', note: '' } };
await save('rulings POST (base equal)', { rulings: R2, rulings_prev: { 'r1|q4|Beta|Alpha': null } });
await save('round POST', { current_round: 3 });

const sched = (n) => ({ v: 1, rooms: rooms.map((b, k) => ({ name: 'Room ' + (k + 1), bucket: b.id })),
  phases: [{ name: 'Prelims', rounds: Array.from({ length: n }, (_, i) => ({ round: i + 1,
    games: [{ room: 0, a: { team: 'Alpha' }, b: { team: 'Beta' } }], byes: [] })) }], updated: 0 });
const SCHED_KEY = `t/${tid}/schedule.json`;
await op('schedule POST (no header)', () => call(A + '/schedule', { method: 'POST', json: sched(3) }));
await dl('file schedule raw', `${A}/file?key=${enc(SCHED_KEY)}`);
await op('schedule POST (matching header)', () => call(A + '/schedule', { method: 'POST', json: sched(4), headers: { 'X-Qbtd-Base': etag(SCHED_KEY) } }));
await op('schedule DELETE', () => call(A + '/schedule', { method: 'DELETE' }));
await op('schedule POST after a delete (no header)', () => call(A + '/schedule', { method: 'POST', json: sched(4) }));
await op('preflight OPTIONS /schedule', () => call(A + '/schedule', { method: 'OPTIONS',
  headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-qbtd-base' } }));
meter['preflight OPTIONS /schedule'].headers = Object.fromEntries(Object.entries((await call(A + '/schedule', { method: 'OPTIONS' })).headers)
  .filter(([k]) => k.startsWith('access-control')));

await op('room rename (schedule follows)', () => call(`${A}/buckets/${rooms[0].id}`, { method: 'POST', json: { room_name: 'Library' } }));
await op('room rename, no schedule room for it', () => call(`${A}/buckets/${rooms[2].id}`, { method: 'POST', json: { room_name: 'Annex' } }));
await op('move: bare .qbj to another room', () => call(`${A}/files/${F.bare.id}`, { method: 'POST', json: { bucket_id: rooms[2].id } }));
await op('move: to the room it is in', () => call(`${A}/files/${F.bare.id}`, { method: 'POST', json: { bucket_id: rooms[2].id } }));
await op('move: bare .qbj to round 2', () => call(`${A}/files/${F.bare.id}`, { method: 'POST', json: { round: 2 } }));
await op('move: to the round it is in', () => call(`${A}/files/${F.bare.id}`, { method: 'POST', json: { round: 2 } }));
await op('Rebuild: bundle with 3 entries, one orphan', () => call(`${A}/bundle`, { method: 'POST', body: JSON.stringify({ entries: [
  { id: F.bare.id, round: 2, room: 'Annex', filename: 'Round_1_Alpha_Beta.qbj', qbj: match(2) },
  { id: F.reader.id, round: 2, room: 'Room 2', filename: 'Round_1_Alpha_Beta.qbtd.json', qbj: match(2) },
  { id: 777, round: 1, room: 'Room 1', filename: 'x.qbj', qbj: match(1) }] }) }));

/* ---------- the hub's refresh and the public routes ---------- */

const rev = (await quiet(() => call(A))).body.tournament.rev;
await op('hub refresh, unchanged (?rev=)', () => call(A + '?rev=' + rev));
await op('hub full detail', () => call(A));
await op('cron tick: the tournament is dirty', () => w.tick());
await op('cron tick: nothing to do', () => w.tick());
await op('public state', () => call('/pub/inproc-games'));
await op('public rounds 1-3', () => call('/pub/inproc-games/rounds?n=1,2,3'));
await dl('public roster', '/pub/inproc-games/roster');
await dl('public schedule', '/pub/inproc-games/schedule');

/* ---------- a question set's mirror: the cron renames its games ---------- */

const set = (await quiet(() => call('/api/sets', { method: 'POST', json: { name: 'In Process Set', slug: 'inproc-set' } }))).body;
const inv = (await quiet(() => call(`/s/${set.admin_secret}/mirrors`, { method: 'POST', json: { name: 'Mirror One' } }))).body;
const mirror = (await quiet(() => call('/i/' + inv.invite, { method: 'POST', json: { name: 'Mirror One', slug: 'inproc-mirror' } }))).body;
const MA = '/a/' + mirror.admin_secret;
const mroom = (await quiet(() => call(MA + '/buckets', { method: 'POST', json: { room_name: 'M1' } }))).body;
await quiet(() => call(MA + '/roster?name=roster.qbj', { method: 'POST', body: ROSTERS.plain }));
await quiet(() => call(MA + '/start', { method: 'POST' }));
await quiet(() => call(`/b/${mroom.secret}/upload?round=1&name=m.qbj`, { method: 'POST', body: JSON.stringify(match(1)) }));
for (let i = 0; i < 3; i++) await quiet(() => w.tick());
await quiet(() => call(MA + '/roster?name=roster.qbj', { method: 'POST', body: ROSTERS.plain.replace('"Bea"', '"Bea", "_x": 1') }));
await op('cron tick: a set mirror is dirty, its roster renames nothing', () => w.tick());
await quiet(() => call(MA + '/roster?name=roster.qbj', { method: 'POST', body: ROSTERS.team }));
await op('cron tick: a set mirror is dirty, its roster renames a team', () => w.tick());
const stateBlob = JSON.parse(raw(`s/${set.id}/state.json`) || 'null');
meter['set state: the mirror\'s renames'] = { names: stateBlob && stateBlob.mirrors.map((m) => m.names) };

/* ---------- the goldens ---------- */

const check = (name, value, n = Object.keys(value).length) => {
  const diffs = checkGolden(name, value);
  if (diffs.length) { failures++; console.error('FAIL ' + name + '\n    ' + diffs.join('\n    ')); }
  else console.log('  ok ' + name + ' (' + n + ' requests)');
};
check('worker_downloads.json', downloads);
check('worker_meter.json', meter);
check('worker_headers.json', { sets: Object.fromEntries(Object.entries(headerSets).sort(([a], [b]) => a.localeCompare(b))), requests: headersOf },
  Object.keys(headersOf).length);
const tally = {};
for (const m of Object.values(meter)) for (const [k, n] of Object.entries(opCounts(m.ops || []))) tally[k] = (tally[k] || 0) + n;
console.log('  (' + Object.keys(meter).length + ' requests metered: ' + JSON.stringify(tally) + ')');
if (failures) process.exitCode = 1;
console.log((failures ? 'worker in-process goldens FAILED' : 'worker in-process goldens match'));
