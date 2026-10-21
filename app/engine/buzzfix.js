// buzzfix.js — fixing who got which buzz in an uploaded game, when a
// moderator credited one player's buzzes to a teammate.
//
// A fix is {swaps, edits}:
//   swaps: [{team, from, to}], whole game. With `to` also playing for the
//     team, the two trade buzzes: each of `from`'s goes to `to` and the
//     reverse, exactly as editing each of those buzzes would. Who heard
//     which tossups (the lineups) stays as recorded. With `to` not in the
//     game (a roster player the moderator never entered), `from` is
//     renamed `to` everywhere the file names them.
//   edits: [{q, j, to}]: match_questions[q].buzzes[j] goes to `to`, a
//     teammate in the game. An edit wins over a swap on the same buzz.
// A buzz never changes team, so neither score moves; the answer counts
// follow the buzzes.
//
// The upload can be a bare match qbj or the reader's combined file
// {qbj, game: {game, uiState}, modaq: {qbj, game}}; all of its copies get
// the same change, so the stats, the downloads and Edit in MODAQ agree.
// MODAQ's qbj (QBJ.ts toQBJ) has one match question per game cycle, in
// order, and a cycle's buzzes in its orderedBuzzes order, which is how a
// qbj buzz finds its MODAQ marker.

import { matchPayload, renameMatch } from './qbj.js';

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}
const asName = (x) => (typeof x === 'string' ? x.trim() : x && typeof x.name === 'string' ? x.name.trim() : '');
const setName = (holder, key, to) => {
  if (typeof holder[key] === 'string') holder[key] = to;
  else if (holder[key] && typeof holder[key] === 'object') holder[key].name = to;
};
const clone = (x) => JSON.parse(JSON.stringify(x));

/** The Match object inside a qbj (bare, or wrapped in {objects}), or null. */
function matchOf(json) {
  let obj = matchPayload(json);
  if (obj && Array.isArray(obj.objects)) {
    obj = obj.objects.find((o) => o && (o.type === 'Match' || pick(o, 'match_teams', 'matchTeams')));
  }
  return obj && typeof obj === 'object' ? obj : null;
}

const teamsOf = (m) => pick(m, 'match_teams', 'matchTeams') || [];
const playersOf = (mt) => pick(mt, 'match_players', 'matchPlayers') || [];
const questionsOf = (m) => pick(m, 'match_questions', 'matchQuestions') || [];
const buzzesOf = (q) => pick(q || {}, 'buzzes') || [];
const valueOf = (b) => Number(pick(pick(b, 'result') || {}, 'value'));
const wordOf = (b) => pick(pick(b, 'buzz_position', 'buzzPosition') || {}, 'word_index', 'wordIndex');
const teamNamed = (m, name) => teamsOf(m).find((mt) => asName(pick(mt, 'team')) === name) || null;
const namesOf = (mt) => (mt ? playersOf(mt).map((mp) => asName(pick(mp, 'player'))).filter(Boolean) : []);

/** What the fix panel shows: the teams with their players, in file order,
    and each buzz ({q, j, n, team, player, value}; n counts from 1), or
    buzzes null when the file has no buzz-by-buzz record. */
export function buzzFixView(root) {
  const m = matchOf(root);
  if (!m) throw new Error('No match in this file');
  const teams = teamsOf(m).map((mt) => ({ name: asName(pick(mt, 'team')), players: namesOf(mt) }));
  const qs = questionsOf(m);
  const buzzes = [];
  qs.forEach((q, i) => buzzesOf(q).forEach((b, j) => {
    buzzes.push({ q: i, j, n: i + 1, team: asName(pick(b, 'team')), player: asName(pick(b, 'player')), value: valueOf(b) });
  }));
  return { teams, buzzes: qs.length ? buzzes : null };
}

/** Buzzes credited to a player who was not in the team's lineup on that
    question, as 'q:j' keys. Empty when the file records no lineups. */
export function lineupGaps(root) {
  const m = matchOf(root);
  const out = new Set();
  if (!m) return out;
  questionsOf(m).forEach((q, i) => buzzesOf(q).forEach((b, j) => {
    const mt = teamNamed(m, asName(pick(b, 'team')));
    const lus = mt ? (pick(mt, 'lineups') || []).filter((l) => l && Number.isFinite(Number(pick(l, 'first_question', 'firstQuestion')))) : [];
    if (!lus.length) return;
    let at = null;
    for (const l of lus) if (Number(pick(l, 'first_question', 'firstQuestion')) <= i + 1) at = l;
    const on = at ? (pick(at, 'players') || []).map(asName) : [];
    if (!on.includes(asName(pick(b, 'player')))) out.add(i + ':' + j);
  }));
  return out;
}

/* ---------- the qbj ---------- */

function renameQbj(m, team, map) {
  const players = new Map([...map].map(([from, to]) => [team + '\n' + from, to]));
  return matchOf(renameMatch(m, { teams: new Map(), players }));
}

// a player's answer counts as MODAQ builds them (QBJ.ts updateAnswerCount):
// the values they got, in the order they first got each
function countsFromBuzzes(m, team, name) {
  const out = [];
  for (const q of questionsOf(m)) {
    for (const b of buzzesOf(q)) {
      if (asName(pick(b, 'team')) !== team || asName(pick(b, 'player')) !== name) continue;
      const v = valueOf(b);
      const ac = out.find((x) => x.answer.value === v);
      if (ac) ac.number++;
      else out.push({ answer: { value: v }, number: 1 });
    }
  }
  return out;
}
const countsKey = (list) => JSON.stringify((list || []).map((ac) =>
  [Number(pick(pick(ac, 'answer', 'answer_type', 'answerType') || {}, 'value')), Number(pick(ac, 'number') ?? 0)]));

// one answer count moved, for a file whose counts are not MODAQ's own: d is +1 or -1
function bump(mp, value, d) {
  const key = mp.answerCounts && !mp.answer_counts ? 'answerCounts' : 'answer_counts';
  const list = mp[key] || (mp[key] = []);
  const ac = list.find((x) => Number(pick(pick(x, 'answer', 'answer_type', 'answerType') || {}, 'value')) === value);
  if (!ac) {
    if (d < 0) throw new Error(`${asName(mp.player)} has no ${value} to move`);
    list.push({ answer: { value }, number: 1 });
    return;
  }
  const n = Number(pick(ac, 'number') ?? 0) + d;
  if (n < 0) throw new Error(`${asName(mp.player)} has no ${value} to move`);
  ac.number = n;
}

// buzzes moved to other players: changes [{q, j, from, to}]
function moveQbj(m, changes) {
  const teams = new Set();
  for (const c of changes) teams.add(asName(pick(buzzesOf(questionsOf(m)[c.q])[c.j], 'team')));
  // counts MODAQ wrote are rebuilt from the buzzes, so the file reads as if
  // MODAQ had exported it with the right names; others move one at a time
  const modaqShaped = new Map([...teams].map((t) => {
    const mt = teamNamed(m, t);
    return [t, playersOf(mt).every((mp) => countsKey(pick(mp, 'answer_counts', 'answerCounts'))
      === countsKey(countsFromBuzzes(m, t, asName(pick(mp, 'player')))))];
  }));
  for (const c of changes) {
    const b = buzzesOf(questionsOf(m)[c.q])[c.j];
    const team = asName(pick(b, 'team'));
    if (asName(pick(b, 'player')) !== c.from) throw new Error(`Question ${c.q + 1} does not match the rest of the file`);
    if (!modaqShaped.get(team)) {
      const mt = teamNamed(m, team);
      const src = playersOf(mt).find((mp) => asName(pick(mp, 'player')) === c.from);
      const dst = playersOf(mt).find((mp) => asName(pick(mp, 'player')) === c.to);
      if (!src || !dst) throw new Error(`Question ${c.q + 1} names a player missing from ${team}`);
      if (!Number.isFinite(valueOf(b))) throw new Error(`Question ${c.q + 1} has a buzz with no value`);
      bump(src, valueOf(b), -1);
      bump(dst, valueOf(b), +1);
    }
    setName(b, 'player', c.to);
  }
  for (const [t, shaped] of modaqShaped) {
    if (!shaped) continue;
    for (const mp of playersOf(teamNamed(m, t))) {
      const key = mp.answerCounts && !mp.answer_counts ? 'answerCounts' : 'answer_counts';
      mp[key] = countsFromBuzzes(m, t, asName(pick(mp, 'player')));
    }
  }
}

/* ---------- MODAQ's game ---------- */

// the GameState inside the reader's saved state ({game, uiState}) or bare
const gameOf = (g) => (g && g.game && typeof g.game === 'object' && 'uiState' in g ? g.game : g);
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
// a cycle's buzzes, older MODAQ shapes included (protests.js normCycle)
const cycleBuzzes = (c) => [c.correctBuzz, ...list(c.wrongBuzzes), ...list(c.noPenaltyBuzzes), ...list(c.negBuzz)]
  .filter((b) => b && b.marker && b.marker.player);

// the Player objects a game holds, as MODAQ's tryUpdatePlayerName walks them
function gamePlayers(g) {
  const out = [...list(g.players)];
  for (const c of list(g.cycles)) {
    if (!c) continue;
    for (const b of cycleBuzzes(c)) out.push(b.marker.player);
    for (const x of list(c.playerJoins)) out.push(x && x.inPlayer);
    for (const x of list(c.playerLeaves)) out.push(x && x.outPlayer);
    for (const x of list(c.subs)) out.push(x && x.inPlayer, x && x.outPlayer);
  }
  return out.filter((p) => p && typeof p === 'object');
}

function renameGame(g, team, map) {
  for (const p of gamePlayers(g)) {
    if (p.teamName === team && map.has(p.name)) p.name = map.get(p.name);
  }
}

// the MODAQ marker of qbj buzz j on question q: the cycle's buzzes by
// this player at this word, taken in order (MODAQ's orderedBuzzes: by
// tossup, then wrong before right)
function markerFor(g, m, q, j) {
  const qb = buzzesOf(questionsOf(m)[q]);
  const b = qb[j];
  const team = asName(pick(b, 'team'));
  const name = asName(pick(b, 'player'));
  const word = wordOf(b);
  const same = (x) => asName(pick(x, 'team')) === team && asName(pick(x, 'player')) === name && wordOf(x) === word;
  const c = list(g.cycles)[q];
  const hits = (c ? cycleBuzzes(c) : [])
    .filter((x) => x.marker.player.teamName === team && x.marker.player.name === name && x.marker.position === word)
    .sort((x, y) => (x.tossupIndex ?? 0) - (y.tossupIndex ?? 0) || (x === c.correctBuzz) - (y === c.correctBuzz));
  if (hits.length !== qb.filter(same).length) {
    throw new Error(`The saved MODAQ game does not match its qbj on question ${q + 1}`);
  }
  return hits[qb.slice(0, j).filter(same).length].marker;
}

/* ---------- the fix ---------- */

// the swaps, checked: renames (to someone not in the game) and pairs, as
// name maps per team
function swapPlan(m, swaps) {
  const renames = new Map();
  const pairs = new Map();
  const used = new Map();
  for (const s of swaps || []) {
    const mt = teamNamed(m, s.team);
    if (!mt) throw new Error(`${s.team} is not in this game`);
    const names = namesOf(mt);
    const from = String(s.from || '').trim();
    const to = String(s.to || '').trim();
    if (!names.includes(from)) throw new Error(`${from} is not playing for ${s.team} in this game`);
    if (!to || to === from) throw new Error('Pick another player to swap with');
    const other = teamsOf(m).find((x) => x !== mt && namesOf(x).includes(to));
    if (other) throw new Error(`${to} plays for ${asName(pick(other, 'team'))}, not ${s.team}`);
    const u = used.get(s.team) || new Set();
    if (u.has(from) || u.has(to)) throw new Error(`${from} or ${to} is already in another swap`);
    u.add(from).add(to);
    used.set(s.team, u);
    const into = names.includes(to) ? pairs : renames;
    const map = into.get(s.team) || new Map();
    map.set(from, to);
    if (into === pairs) map.set(to, from);
    into.set(s.team, map);
  }
  return { renames, pairs };
}

/** The upload with the fix applied, as a new object (root is untouched).
    Throws, with a message for the TD, on a fix the file can't take. */
export function applyBuzzFix(root, fix) {
  const out = clone(root);
  let m = matchOf(out);
  if (!m) throw new Error('No match in this file');
  const { renames, pairs } = swapPlan(m, fix && fix.swaps);
  const edits = new Map(((fix && fix.edits) || []).map((e) => [e.q + ':' + e.j, String(e.to || '').trim()]));

  // MODAQ's games: the saved state and MODAQ's own export of it
  const games = [];
  if (out.game && typeof out.game === 'object') games.push(gameOf(out.game));
  const modaqGame = out.modaq && typeof out.modaq.game === 'string' ? JSON.parse(out.modaq.game) : null;
  if (modaqGame) games.push(modaqGame);
  const modaqQbj = out.modaq && typeof out.modaq.qbj === 'string' ? JSON.parse(out.modaq.qbj) : null;

  // 1. players never entered: renamed throughout
  let mq = modaqQbj && matchOf(modaqQbj);
  for (const [team, map] of renames) {
    m = renameQbj(m, team, map);
    if (mq) mq = renameQbj(mq, team, map);
    for (const g of games) renameGame(g, team, map);
  }

  // 2. buzzes moved between teammates
  const changes = [];
  questionsOf(m).forEach((q, i) => buzzesOf(q).forEach((b, j) => {
    const team = asName(pick(b, 'team'));
    const from = asName(pick(b, 'player'));
    const key = i + ':' + j;
    const to = edits.has(key) ? edits.get(key) : (pairs.get(team) && pairs.get(team).get(from)) || from;
    if (to === from) return;
    if (!namesOf(teamNamed(m, team)).includes(to)) throw new Error(`${to} is not playing for ${team} in this game`);
    changes.push({ q: i, j, from, to });
  }));
  for (const key of edits.keys()) {
    const [i, j] = key.split(':').map(Number);
    if (!buzzesOf(questionsOf(m)[i])[j]) throw new Error(`No buzz ${j + 1} on question ${i + 1}`);
  }
  // each marker found before any moves, while both sides still agree
  for (const g of games) {
    const marks = changes.map((c) => markerFor(g, m, c.q, c.j));
    changes.forEach((c, i) => {
      const p = list(g.players).find((x) => x.teamName === marks[i].player.teamName && x.name === c.to);
      marks[i].player = { ...marks[i].player, name: c.to, ...(p ? { isStarter: p.isStarter } : {}) };
    });
  }
  moveQbj(m, changes);
  if (mq) moveQbj(mq, changes);

  // the copies back in place
  let result = out;
  if (out.qbj && typeof out.qbj === 'object') out.qbj = m;
  else if (Array.isArray(out.objects)) {
    out.objects[out.objects.findIndex((o) => o && (o.type === 'Match' || pick(o, 'match_teams', 'matchTeams')))] = m;
  } else result = m;
  if (mq) {
    if (Array.isArray(modaqQbj.objects)) {
      modaqQbj.objects[modaqQbj.objects.findIndex((o) => o && (o.type === 'Match' || pick(o, 'match_teams', 'matchTeams')))] = mq;
      out.modaq.qbj = JSON.stringify(modaqQbj, null, 2);
    } else out.modaq.qbj = JSON.stringify(mq, null, 2);
  }
  if (modaqGame) out.modaq.game = JSON.stringify(modaqGame, null, 2);
  return result;
}

/* ---------- lineups: who was in, from which question ----------
   A team's lineups are [{from, players}]: from the first question (1)
   on, each entry the players in from question `from` until the next one,
   as MODAQ's qbj records them (match_teams[].lineups, first_question).
   Changing them rewrites the qbj's lineups and each player's
   tossups_heard (MODAQ counts a player on each question their lineup
   holds them), and MODAQ's games: who started (isStarter) and, at each
   change, the team's joins and leaves on that question's cycle, the
   events MODAQ itself makes when it reads lineups back from a qbj. */

const lineupsOf = (mt) => (pick(mt, 'lineups') || [])
  .filter((l) => l && Number.isFinite(Number(pick(l, 'first_question', 'firstQuestion'))))
  .map((l) => ({ from: Number(pick(l, 'first_question', 'firstQuestion')), players: (pick(l, 'players') || []).map(asName).filter(Boolean) }));

/** What the lineup panel shows: the number of questions, and each team's
    players in the game and lineups (none recorded: all its players from
    question 1). */
export function lineupView(root) {
  const m = matchOf(root);
  if (!m) throw new Error('No match in this file');
  return {
    questions: questionsOf(m).length,
    teams: teamsOf(m).map((mt) => {
      const players = namesOf(mt);
      const lineups = lineupsOf(mt);
      return { name: asName(pick(mt, 'team')), players, lineups: lineups.length ? lineups : [{ from: 1, players }] };
    }),
  };
}

// the lineups, checked and tidied: in order from question 1, each a
// change from the one before, players once each
function lineupPlan(m, team, segs) {
  const mt = teamNamed(m, team);
  if (!mt) throw new Error(`${team} is not in this game`);
  const n = questionsOf(m).length;
  const others = new Set(teamsOf(m).filter((x) => x !== mt).flatMap(namesOf));
  const out = [];
  for (const s of segs || []) {
    const from = Number(s.from);
    const players = [...new Set((s.players || []).map((p) => String(p || '').trim()).filter(Boolean))];
    if (!Number.isInteger(from) || from < 1 || from > Math.max(n, 1)) throw new Error(`${team}: question ${s.from} is not in this game`);
    for (const p of players) if (others.has(p)) throw new Error(`${p} plays for the other team`);
    if (out.length && from <= out[out.length - 1].from) throw new Error(`${team}: two changes on question ${from}`);
    const prev = out[out.length - 1];
    if (prev && prev.players.length === players.length && prev.players.every((p) => players.includes(p))) continue;
    out.push({ from, players });
  }
  if (!out.length || out[0].from !== 1) throw new Error(`${team}: the lineup has to start on question 1`);
  return out;
}

const inAt = (segs, q) => { let at = segs[0]; for (const s of segs) if (s.from <= q) at = s; return at.players; };

function lineupsQbj(m, team, segs) {
  const mt = teamNamed(m, team);
  const key = mt.matchPlayers && !mt.match_players ? 'matchPlayers' : 'match_players';
  const mps = mt[key] || (mt[key] = []);
  const have = new Set(namesOf(mt));
  const tp = mt.team && typeof mt.team === 'object' && Array.isArray(mt.team.players) ? mt.team.players : null;
  for (const name of segs.flatMap((s) => s.players)) {
    if (have.has(name)) continue;
    have.add(name);
    // a roster player the moderator never entered, as MODAQ lists a player
    const player = { name };
    mps.push({ player, answer_counts: [], tossups_heard: 0 });
    if (tp && !tp.some((p) => asName(p) === name)) tp.push(player);
  }
  mt.lineups = segs.map((s) => ({ first_question: s.from, players: s.players.map((name) => ({ name })) }));
  const n = questionsOf(m).length;
  for (const mp of mps) {
    const name = asName(pick(mp, 'player'));
    let heard = 0;
    for (let q = 1; q <= n; q++) if (inAt(segs, q).includes(name)) heard++;
    if ('tossupsHeard' in mp && !('tossups_heard' in mp)) mp.tossupsHeard = heard; else mp.tossups_heard = heard;
  }
}

const CHANGES = ['playerJoins', 'playerLeaves', 'subs'];
const eventTeam = (e) => ((e && (e.inPlayer || e.outPlayer)) || {}).teamName;

function lineupsGame(g, team, segs) {
  const starters = new Set(segs[0].players);
  const players = Array.isArray(g.players) ? g.players : (g.players = []);
  for (const name of new Set(segs.flatMap((s) => s.players))) {
    if (!players.some((p) => p && p.teamName === team && p.name === name)) players.push({ name, teamName: team, isStarter: false });
  }
  for (const p of gamePlayers(g)) if (p.teamName === team) p.isStarter = starters.has(p.name);
  const cycles = list(g.cycles);
  for (const c of cycles) {
    if (!c) continue;
    for (const k of CHANGES) {
      if (!Array.isArray(c[k])) continue;
      c[k] = c[k].filter((e) => eventTeam(e) !== team);
      if (!c[k].length) delete c[k];
    }
  }
  const who = (name) => ({ name, teamName: team, isStarter: starters.has(name) });
  for (let i = 1; i < segs.length; i++) {
    const c = cycles[segs[i].from - 1];
    if (!c) throw new Error(`The saved MODAQ game has no question ${segs[i].from}`);
    const before = segs[i - 1].players;
    const now = segs[i].players;
    const leaves = before.filter((p) => !now.includes(p)).map((p) => ({ outPlayer: who(p) }));
    const joins = now.filter((p) => !before.includes(p)).map((p) => ({ inPlayer: who(p), isInactive: false }));
    if (leaves.length) c.playerLeaves = [...(c.playerLeaves || []), ...leaves];
    if (joins.length) c.playerJoins = [...(c.playerJoins || []), ...joins];
  }
}

/** The upload with new lineups for some teams ({team: [{from, players}]}),
    as a new object (root is untouched). Throws, with a message for the
    TD, on lineups the file can't take. */
export function applyLineupFix(root, lineups) {
  const out = clone(root);
  const m = matchOf(out);
  if (!m) throw new Error('No match in this file');
  const plans = Object.entries(lineups || {}).map(([team, segs]) => [team, lineupPlan(m, team, segs)]);
  const modaqQbj = out.modaq && typeof out.modaq.qbj === 'string' ? JSON.parse(out.modaq.qbj) : null;
  const mq = modaqQbj && matchOf(modaqQbj);
  const games = [];
  if (out.game && typeof out.game === 'object') games.push(gameOf(out.game));
  const modaqGame = out.modaq && typeof out.modaq.game === 'string' ? JSON.parse(out.modaq.game) : null;
  if (modaqGame) games.push(modaqGame);
  for (const [team, segs] of plans) {
    lineupsQbj(m, team, segs);
    if (mq) lineupsQbj(mq, team, segs);
    for (const g of games) lineupsGame(g, team, segs);
  }
  if (mq) out.modaq.qbj = JSON.stringify(modaqQbj, null, 2);
  if (modaqGame) out.modaq.game = JSON.stringify(modaqGame, null, 2);
  return out;
}
