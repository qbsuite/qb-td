// demo_fixture.mjs — builds app/demo/fixture.js, the committed data behind
// the demo tournament (app/demo.html). Reads the packets in tools/demo/
// (2025 VAULT packets 1-3, exported from the qbreader mirror by
// library-of-stock/dev/oneshots/export_vault_demo_packets.py, with <i>
// converted to <em> for MODAQ's formatter) and simulates the five
// pre-played games with a seeded PRNG, so the output is deterministic and
// reviewable in diffs.
//
// The demo story: a 4-team round robin, mid-tournament. Rounds 1-2 are
// fully played, round 3 has only Room B's game in — Room A's game
// (Riverside vs Summit, both 2-0: the deciding game) is the one a demo
// visitor reads themselves in read.html?b=demo.
//
// The simulated qbj mirrors MODAQ's customExport exactly (bare snake_case
// match with match_questions[].buzzes[].buzz_position.word_index), so the
// same engine code that serves real tournaments consumes it unchanged.
//
// Run: node tools/demo_fixture.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRosterQbj } from '../app/engine/qbj.js';
import { tokenizeQuestion } from '../app/engine/buzz.js';
import { matchFilenames } from '../app/js/read_core.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAME = 'Demo Tournament';
const ROOMS = ['Room A', 'Room B'];
const CURRENT_ROUND = 3;

// Roster order doubles as seed order. Skills drive buzz frequency and depth.
const TEAMS = [
  { name: 'Summit', players: { Ada: 0.85, Boris: 0.55, Camille: 0.4, Dev: 0.3 } },
  { name: 'Riverside', players: { Elena: 0.75, Farid: 0.6, Grace: 0.45, Hugo: 0.3 } },
  { name: 'Maple Grove', players: { Iris: 0.6, Jonah: 0.45, Kira: 0.35 } },
  { name: 'Harbor View', players: { Leo: 0.5, Mina: 0.35, Noor: 0.25 } },
];

// Full 4-team round robin over 2 rooms; room index into ROOMS.
const SCHEDULE_GAMES = [
  { round: 1, room: 0, a: 'Riverside', b: 'Maple Grove' },
  { round: 1, room: 1, a: 'Summit', b: 'Harbor View' },
  { round: 2, room: 0, a: 'Riverside', b: 'Harbor View' },
  { round: 2, room: 1, a: 'Summit', b: 'Maple Grove' },
  { round: 3, room: 0, a: 'Riverside', b: 'Summit' }, // the visitor's game
  { round: 3, room: 1, a: 'Maple Grove', b: 'Harbor View' },
];

// Pre-played games with rigged winners, so standings read 2-0 vs 2-0
// going into the visitor's round-3 game.
const PLAYED = [
  { round: 1, room: 0, a: 'Riverside', b: 'Maple Grove', winner: 'Riverside' },
  { round: 1, room: 1, a: 'Summit', b: 'Harbor View', winner: 'Summit' },
  { round: 2, room: 0, a: 'Riverside', b: 'Harbor View', winner: 'Riverside' },
  { round: 2, room: 1, a: 'Summit', b: 'Maple Grove', winner: 'Summit' },
  { round: 3, room: 1, a: 'Maple Grove', b: 'Harbor View', winner: 'Maple Grove' },
];

/* ---------- deterministic PRNG (mulberry32) ---------- */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- game simulation ---------- */

const teamByName = (n) => TEAMS.find((t) => t.name === n);
const teamObj = (t) => ({
  name: t.name,
  players: Object.keys(t.players).map((name) => ({ name })),
});

function pickWeighted(rand, entries) {
  // entries: [[name, weight]]; stronger players buzz far more often
  const total = entries.reduce((n, [, w]) => n + w, 0);
  let x = rand() * total;
  for (const [name, w] of entries) {
    x -= w;
    if (x <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

function buzzerFor(rand, team) {
  return pickWeighted(rand, Object.entries(team.players).map(([n, s]) => [n, s * s]));
}

// One cycle: who buzzed where, and the bonus if someone converted.
function simCycle(rand, tossup, number, winnerTeam, loserTeam) {
  const words = tokenizeQuestion(tossup.question);
  const marked = words.indexOf('(*)');
  const powerIdx = marked > 0 ? marked : Math.floor(words.length * 0.55);
  const buzzes = [];

  const roll = rand();
  const convTeam = roll < 0.6 ? winnerTeam : roll < 0.88 ? loserTeam : null;

  if (convTeam) {
    const player = buzzerFor(rand, convTeam);
    const skill = convTeam.players[player];
    // stronger players buzz deeper into the leadin; everyone converts by the giveaway
    const depth = (1 - skill * 0.45) * (0.35 + rand() * 0.65);
    const position = Math.min(words.length - 2,
      Math.round(powerIdx * 0.5 + depth * (words.length - powerIdx * 0.5)));
    const value = position < powerIdx ? 15 : 10;
    const other = convTeam === winnerTeam ? loserTeam : winnerTeam;
    if (rand() < 0.18) {
      const negger = buzzerFor(rand, other);
      const negAt = Math.max(1, Math.round(position * (0.5 + rand() * 0.4)));
      buzzes.push({ player: negger, team: other, position: Math.min(negAt, position - 1), value: -5 });
    }
    buzzes.push({ player, team: convTeam, position, value });
  } else if (rand() < 0.4) {
    // dead with one neg
    const t = rand() < 0.5 ? winnerTeam : loserTeam;
    const negger = buzzerFor(rand, t);
    const position = Math.round(words.length * (0.4 + rand() * 0.4));
    buzzes.push({ player: negger, team: t, position, value: -5 });
  }

  buzzes.sort((x, y) => x.position - y.position);
  const mq = {
    question_number: number,
    buzzes: buzzes.map((b) => ({
      buzz_position: { word_index: b.position },
      player: { name: b.player },
      team: teamObj(b.team),
      result: { value: b.value },
    })),
    tossup_question: { parts: 1, type: 'tossup', question_number: number },
  };

  const conv = buzzes.find((b) => b.value > 0);
  let bonusPoints = 0;
  if (conv) {
    const skills = Object.values(conv.team.players);
    const avg = skills.reduce((n, s) => n + s, 0) / skills.length;
    const parts = [0, 1, 2].map(() => (rand() < 0.3 + avg * 0.65 ? 10 : 0));
    bonusPoints = parts.reduce((n, x) => n + x, 0);
    mq.bonus = {
      question: { parts: 3, type: 'bonus', question_number: number },
      parts: parts.map((p) => ({ controlled_points: p })),
    };
  }
  return { mq, conv, bonusPoints, buzzes };
}

function simGame(seed, packet, aName, bName, winnerName) {
  const rand = rng(seed);
  const a = teamByName(aName);
  const b = teamByName(bName);
  const winner = teamByName(winnerName);
  const loser = winner === a ? b : a;

  const counts = new Map(); // player -> Map(value -> n)
  const bonus = new Map([[a.name, 0], [b.name, 0]]);
  const questions = [];
  // a standard game reads 20; the packet's 21st tossup is the tiebreaker
  const read = Math.min(20, packet.tossups.length);
  for (let n = 1; n <= read; n++) {
    const { mq, conv, bonusPoints } = simCycle(rand, packet.tossups[n - 1], n, winner, loser);
    questions.push(mq);
    if (conv) bonus.set(conv.team.name, bonus.get(conv.team.name) + bonusPoints);
    for (const z of mq.buzzes) {
      const key = z.player.name;
      if (!counts.has(key)) counts.set(key, new Map());
      const c = counts.get(key);
      c.set(z.result.value, (c.get(z.result.value) || 0) + 1);
    }
  }

  const matchTeam = (t) => ({
    bonus_points: bonus.get(t.name),
    lineups: [{ first_question: 1, players: Object.keys(t.players).map((name) => ({ name })) }],
    match_players: Object.keys(t.players).map((name) => ({
      player: { name },
      answer_counts: [...(counts.get(name) || new Map()).entries()]
        .map(([value, number]) => ({ answer: { value }, number })),
      tossups_heard: read,
    })),
    team: teamObj(t),
  });

  const teams = [matchTeam(a), matchTeam(b)];
  const score = (mt) => mt.bonus_points + mt.match_players.reduce(
    (s, p) => s + p.answer_counts.reduce((x, c) => x + c.answer.value * c.number, 0), 0);
  const winnerScore = score(teams[winner === a ? 0 : 1]);
  const loserScore = score(teams[winner === a ? 1 : 0]);
  const qbj = { tossups_read: read, match_teams: teams, match_questions: questions };
  return { qbj, ok: winnerScore > loserScore };
}

// Retry with stepped seeds until the rigged winner actually wins.
function simGameForced(baseSeed, packet, aName, bName, winnerName) {
  for (let i = 0; i < 60; i++) {
    const { qbj, ok } = simGame(baseSeed + i * 1013, packet, aName, bName, winnerName);
    if (ok) return qbj;
  }
  throw new Error(`could not force ${winnerName} to win ${aName} vs ${bName}`);
}

/* ---------- assemble the fixture ---------- */

const packets = {};
for (const r of [1, 2, 3]) {
  packets[r] = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'demo', `round${r}.json`), 'utf8'));
}

const catmap = { rounds: {} };
for (const [r, p] of Object.entries(packets)) {
  catmap.rounds[r] = {
    t: p.tossups.map((q) => ({ c: q.category, s: q.subcategory || '' })),
    b: p.bonuses.map((q) => ({ c: q.category, s: q.subcategory || '' })),
  };
}

const schedule = {
  v: 1,
  rooms: ROOMS.map((name) => ({ name, bucket: null })),
  phases: [{
    name: 'Round robin',
    rounds: [1, 2, 3].map((round) => ({
      round,
      games: SCHEDULE_GAMES.filter((g) => g.round === round)
        .map((g) => ({ room: g.room, a: { team: g.a }, b: { team: g.b } })),
      byes: [],
    })),
  }],
  pools: {},
  updated: 1753500000000,
};

const entries = PLAYED.map((g, i) => ({
  id: i + 1,
  round: g.round,
  room: ROOMS[g.room],
  filename: matchFilenames(g.round, g.a, g.b).combined,
  qbj: { ...simGameForced(7000 + i * 31, packets[g.round], g.a, g.b, g.winner), _round: g.round },
}));

const fixture = {
  name: NAME,
  currentRound: CURRENT_ROUND,
  rooms: ROOMS,
  readerRoom: 0, // the demo bucket is Room A: round 3's open game
  settings: { gameFormat: 'macf-powers' },
  packets,
  roster: buildRosterQbj(NAME, TEAMS.map((t) => ({
    name: t.name, players: Object.keys(t.players),
  }))),
  schedule,
  catmap,
  entries,
};

const out = '// fixture.js — the demo tournament\'s data, generated by\n'
  + '// tools/demo_fixture.mjs. Regenerate with `node tools/demo_fixture.mjs`;\n'
  + '// never edit by hand. Served entirely in-browser by app/js/demo.js.\n'
  + 'export default ' + JSON.stringify(fixture, null, 1) + ';\n';
fs.mkdirSync(path.join(root, 'app', 'demo'), { recursive: true });
fs.writeFileSync(path.join(root, 'app', 'demo', 'fixture.js'), out);

const totalBuzz = entries.reduce((n, e) => n + e.qbj.match_questions.reduce(
  (x, q) => x + q.buzzes.length, 0), 0);
console.log(`wrote app/demo/fixture.js: ${entries.length} games, ${totalBuzz} buzzes, `
  + `${Math.round(out.length / 1024)} KB`);
