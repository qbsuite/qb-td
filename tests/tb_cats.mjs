// tb_cats.mjs — replacement and tiebreaker questions in the category map,
// in process (tests/inproc_worker.mjs).
//
// What it pins down: when a game reports the pool questions it read, their
// categories go into the public category map's `tb` lists by pool id (the
// same tags a packet question has, a bonus's e/m/h marks too); questions
// nobody has read are not listed; the round lists are untouched; a later
// packet upload, a packet upload and a full rebuild both keep the lists;
// and category stats built from the map count the replacement in its own
// category. Run: node tests/tb_cats.mjs (part of npm test).

import { workerHarness } from './inproc_worker.mjs';
import { categoryStats, categoryTeamStats } from '../app/engine/cats.js';

const w = await workerHarness();
const { call } = w;
let failures = 0;
let passed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + label); return; }
  failures++;
  console.error('FAIL ' + label + (detail !== undefined ? '\n    ' + JSON.stringify(detail).slice(0, 600) : ''));
}
const enc = encodeURIComponent;
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const T = (await call('/api/tournaments', { method: 'POST', json: { name: 'Tb cats', slug: 'tb-cats' } })).body;
const A = '/a/' + T.admin_secret;
const room = (await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } })).body.secret;

// round 1's packet: three tagged tossups and bonuses
const tu = (i, category, subcategory) => ({ question: 'Tossup ' + i + ' text. For 10 points, name it.', answer: 'Answer ' + i, category, subcategory });
const bo = (i, category, subcategory, marks) => ({ leadin: 'Bonus ' + i, parts: ['a', 'b', 'c'], answers: ['x', 'y', 'z'], values: [10, 10, 10], category, subcategory,
  ...(marks ? { difficultyModifiers: marks } : {}) });
const packet = { tossups: [tu(1, 'Literature', 'American Literature'), tu(2, 'Literature', 'British Literature'), tu(3, 'Science', 'Biology')],
  bonuses: [bo(1, 'Literature', 'American Literature'), bo(2, 'Science', 'Biology'), bo(3, 'History', 'American History')] };
await post(`${A}/packet?round=1&name=${enc('Packet 1.json')}`, packet);
// the pool: TU1 by its fields, TU2 by an ACF-style tag, TU3 untagged; B1 marked
const pool = { tossups: [tu(91, 'History', 'World History'), { question: 'Tagged tossup. For 10 points, name it.', answer: 'A', metadata: 'Fine Arts - Painting, A Writer' },
  { question: 'Untagged tossup. For 10 points, name it.', answer: 'B' }],
  bonuses: [bo(91, 'Science', 'Physics', ['e', 'm', 'h']), bo(92, 'Geography', '')] };
const added = (await post(`${A}/tiebreakers?name=${enc('spares.json')}`, pool)).body;
ok('the pool takes three tossups and two bonuses', added && added.tossups === 3 && added.bonuses === 2, added);
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: true } });

const cats = async () => { const r = await call('/pub/tb-cats/cats'); return r.status === 200 ? r.body : null; };
let map = await cats();
ok('before any game the map has the round and no replacement lists', map && map.rounds && map.rounds['1'] && !map.tb, map);

// a game: tossup 2 replaced by TU1 (Bob gets it), and its bonus by B1
const buzz = (player, team, value) => ({ player: { name: player }, team: { name: team }, buzz_position: { word_index: 7 }, result: { value } });
const qbj = {
  tossups_read: 3,
  match_teams: [{ team: { name: 'Alpha' }, match_players: [{ player: { name: 'Ann' } }] }, { team: { name: 'Beta' }, match_players: [{ player: { name: 'Bob' } }] }],
  match_questions: [
    { question_number: 1, tossup_question: { type: 'tossup', question_number: 1 }, buzzes: [buzz('Ann', 'Alpha', 10)],
      bonus: { question: { type: 'bonus', question_number: 1 }, parts: [{ controlled_points: 10 }, { controlled_points: 0 }, { controlled_points: 0 }] } },
    { question_number: 2, tossup_question: { type: 'tossup', question_number: 4, qbtd_tiebreaker: 'TU1' },
      replacement_tossup_question: { type: 'tossup', question_number: 4, qbtd_tiebreaker: 'TU1' }, buzzes: [buzz('Bob', 'Beta', 10)],
      bonus: { question: { type: 'bonus', question_number: 4, qbtd_tiebreaker: 'B1' }, parts: [{ controlled_points: 10 }, { controlled_points: 10 }, { controlled_points: 0 }] } },
    { question_number: 3, tossup_question: { type: 'tossup', question_number: 3 }, buzzes: [] },
  ],
  _round: 1,
};
const up = await call(`/b/${room}/upload?round=1&name=${enc('Round_1_Alpha_Beta.qbtd.json')}`,
  { method: 'POST', body: JSON.stringify({ qbj, game: null, tb: { used: ['TU1', 'B1'], map: { t: 3, b: 3, tuAt: { 2: 'TU1' }, boAt: { 2: 'B1' } } } }) });
ok('the game uploads', up.status === 200, up.body);

map = await cats();
ok('the questions the game read are listed with their categories', map && map.tb
  && JSON.stringify(map.tb.t) === JSON.stringify({ TU1: { c: 'History', s: 'World History' } })
  && JSON.stringify(map.tb.b) === JSON.stringify({ B1: { c: 'Science', s: 'Physics', d: 'emh' } }), map && map.tb);
ok('questions nobody has read are not listed', map && !('TU2' in map.tb.t) && !('B2' in map.tb.b));
ok('the round lists are as they were', map && map.rounds['1'].t.length === 3 && map.rounds['1'].t[1].s === 'British Literature');

const entries = [{ round: 1, room: 'Room 1', qbj }];
const bob = categoryStats(entries, map).filter((r) => r.player === 'Bob');
ok('category stats: the replacement counts for Bob as History', bob.length === 1 && bob[0].cat === 'History' && bob[0].gets === 1 && bob[0].pts === 10, bob);
const beta = categoryTeamStats(entries, map).filter((r) => r.team === 'Beta').map((r) => [r.cat, r.gets, r.bh, r.bpts]).sort();
ok('category stats: Beta has the History tossup and the Science bonus', JSON.stringify(beta) === JSON.stringify([['History', 1, 0, 0], ['Science', 0, 1, 20]]), beta);

// a second game reads the tagged tossup and the same bonus again
const up2 = await call(`/b/${room}/upload?round=1&name=${enc('Round_1_Gamma_Delta.qbtd.json')}`,
  { method: 'POST', body: JSON.stringify({ qbj: { ...qbj, match_teams: [{ team: { name: 'Gamma' } }, { team: { name: 'Delta' } }], match_questions: [] }, game: null, tb: { used: ['TU2', 'TU3', 'B1'] } }) });
map = await cats();
ok('a later game adds what it read; an untagged question has no entry', up2.status === 200 && map.tb.t.TU1 && map.tb.t.TU2 && map.tb.t.TU2.c === 'Fine Arts' && !('TU3' in map.tb.t), map && map.tb);

// the map's other writers keep the lists
await post(`${A}/packet?round=2&name=${enc('Packet 2.json')}`, packet);
map = await cats();
ok('a packet upload keeps the lists', map && map.rounds['2'] && map.tb && map.tb.t.TU1 && map.tb.b.B1, map && map.tb);
await call(`${A}/tiebreakers?id=TU1`, { method: 'DELETE' });
map = await cats();
ok('taking a read question out of the pool keeps its entry', map && map.tb && map.tb.t.TU1);

// a full rebuild (the dashboard load finds the map written by an older parser)
const stored = w.rawObj(`t/${T.id}/catmap.json`);
stored.custom = { v: '1' };
await call(A);
if (w.settle) await w.settle();
map = await cats();
const after = w.rawObj(`t/${T.id}/catmap.json`);
ok('a rebuild writes the map afresh and keeps the lists', after && after.custom && after.custom.v !== '1'
  && map && map.rounds['1'] && map.rounds['2'] && map.tb && map.tb.t.TU1 && map.tb.t.TU1.c === 'History' && map.tb.t.TU2 && map.tb.b.B1 && map.tb.b.B1.d === 'emh',
  { custom: after && after.custom, tb: map && map.tb });

if (failures) process.exitCode = 1;
console.log(failures ? `tb cats: ${failures} FAILED` : `${passed} tb-cats checks passed`);
