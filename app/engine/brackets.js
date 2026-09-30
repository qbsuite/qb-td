// brackets.js — per-bracket rounds. Shared by the Worker (which rounds a
// room may read and start, auto-advance) and the pages (Live Hub, reader,
// room page), so both sides apply the same rules.
//
// Semantics
// - Brackets come from the schedule: its `brackets` list and each game's
//   `bracket`, worked out by tagBrackets for schedules saved before those
//   existed. A schedule is "multi" when some phase has two or more
//   brackets; only then do brackets keep their own rounds. With one
//   bracket (a plain round robin) or no schedule, everything runs on
//   tournaments.current_round exactly as before.
// - tournaments.bracket_rounds holds {bracketKey: round} for the phase
//   being played. tournaments.current_round is always the lowest of them:
//   "the round the tournament is on", the furthest-behind bracket. A
//   stored round below current_round reads as current_round, and none
//   goes past the last round of its phase.
// - A room's round is the round of the bracket whose game it hosts at
//   that bracket's round; a room hosting nothing there (bye, idle) is on
//   current_round. A room reads packets up to its own round, never past.
// - Auto-advance: when every room with a game in a bracket's round has
//   started it and the next round's packet is up, that bracket moves one
//   round, never past the end of its phase. A room's start only moves its
//   own bracket, one round, so a round the TD set back by hand is never
//   pushed on by starts from before the set-back (the Worker records a
//   start once). The next phase opens for every bracket at once, on its
//   first round, when every bracket of this phase is on its last round
//   and every room playing there has started it.
// - Manual: Advance all to N+1 (N = the highest bracket round) moves
//   every bracket to min(N+1, phase end); when every bracket is already
//   on the phase end it opens the next phase instead. Set round X resets
//   every bracket to X. One bracket can be advanced on its own, up to its
//   phase end.

import { tagBrackets, slotText } from './schedule.js';

export const LANE_COLORS = 8; // .lane-0..7 in td.css

const clone = (x) => JSON.parse(JSON.stringify(x));
const norm = (x) => String(x || '').trim().toLowerCase();

/**
 * The schedule's bracket structure, or null without a usable schedule.
 * { multi, schedule (tagged copy), brackets: [{key, name, phase, color}],
 *   phases: [{p, name, first, last, keys}] }. color is the lane index
 *   the schedule editor gives the bracket (its order in its phase).
 */
export function bracketModel(schedule) {
  if (!schedule || !Array.isArray(schedule.phases) || !schedule.phases.length) return null;
  const s = clone(schedule);
  const list = tagBrackets(s);
  const phases = s.phases.map((ph, p) => {
    const nums = ph.rounds.map((r) => r.round).filter((n) => Number.isInteger(n));
    const used = new Set(ph.rounds.flatMap((r) => r.games.filter((g) => g.a || g.b).map((g) => g.bracket)));
    const keys = list.filter((b) => b.phase === p && used.has(b.key)).map((b) => b.key);
    return { p, name: ph.name, first: nums.length ? Math.min(...nums) : null, last: nums.length ? Math.max(...nums) : null, keys };
  });
  const brackets = list.map((b) => ({
    key: b.key, name: b.name, phase: b.phase,
    color: Math.max(0, list.filter((x) => x.phase === b.phase).findIndex((x) => x.key === b.key)) % LANE_COLORS,
  }));
  return { multi: phases.some((ph) => ph.keys.length > 1), schedule: s, brackets, phases };
}

export function bracketInfo(model, key) {
  return (model && model.brackets.find((b) => b.key === key)) || null;
}

/** The phase whose rounds include `round`, or null. */
export function phaseOfRound(model, round) {
  if (!model) return null;
  return model.phases.find((ph) => ph.first !== null && round >= ph.first && round <= ph.last) || null;
}

/**
 * Where each bracket is: { phase (the phase object, or null), rounds:
 * {key: round} } for the phase containing current_round. Empty rounds
 * (and phase null) when the schedule isn't multi or current_round is
 * outside every phase — then only current_round counts.
 */
export function bracketRounds(model, currentRound, stored) {
  const none = { phase: null, rounds: {} };
  if (!model || !model.multi) return none;
  const ph = phaseOfRound(model, currentRound);
  if (!ph || !ph.keys.length) return none;
  let st = stored;
  if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = null; } }
  const rounds = {};
  for (const k of ph.keys) {
    const v = st && Number.isInteger(st[k]) ? st[k] : currentRound;
    rounds[k] = Math.min(Math.max(v, currentRound), ph.last);
  }
  return { phase: ph, rounds };
}

export function minRound(state, currentRound) {
  const v = Object.values(state.rounds);
  return v.length ? Math.min(...v) : currentRound;
}
export function maxRound(state, currentRound) {
  const v = Object.values(state.rounds);
  return v.length ? Math.max(...v) : currentRound;
}

function roundOf(model, n) {
  for (const ph of model.schedule.phases) for (const r of ph.rounds) if (r.round === n) return r;
  return null;
}

/** Room indices with a two-sided game of `key` in round n. */
export function bracketRooms(model, key, n) {
  const r = roundOf(model, n);
  if (!r) return [];
  return r.games.filter((g) => g.bracket === key && g.a && g.b).map((g) => g.room);
}

/** The game in room `roomIndex` in round n, or null. */
export function gameIn(model, roomIndex, n) {
  const r = model ? roundOf(model, n) : null;
  return r ? r.games.find((g) => g.room === roomIndex) || null : null;
}

/** A room's round (see the header). roomIndex null → current_round. */
export function roomRound(model, state, roomIndex, currentRound) {
  if (!state.phase || roomIndex === null || roomIndex === undefined) return currentRound;
  let best = null;
  for (const [key, r] of Object.entries(state.rounds)) {
    const g = gameIn(model, roomIndex, r);
    if (g && g.bracket === key && (g.a || g.b) && (best === null || r < best)) best = r;
  }
  return best === null ? currentRound : best;
}

/** The bracket a room is in at its round (key), or null. */
export function roomBracket(model, state, roomIndex, currentRound) {
  if (!model || !model.multi || roomIndex === null || roomIndex === undefined) return null;
  const r = roomRound(model, state, roomIndex, currentRound);
  const g = gameIn(model, roomIndex, r);
  return g && g.bracket ? g.bracket : null;
}

/** Schedule room index for a bucket: its link, then a name match. */
export function roomIndexOf(schedule, bucket) {
  if (!schedule || !Array.isArray(schedule.rooms) || !bucket) return null;
  let i = schedule.rooms.findIndex((r) => r && r.bucket === bucket.id);
  if (i === -1) i = schedule.rooms.findIndex((r) => r && norm(r.name) === norm(bucket.room_name));
  return i === -1 ? null : i;
}

/**
 * Auto-advance. started(n) → Set of room indices that started round n;
 * matched(roomIndex) → whether a bucket plays in that room; hasPacket(n).
 * only: a bracket key (a room's start moves only its bracket), or null
 * for all brackets. Returns {current, rounds} to store, or null.
 */
export function autoAdvance(model, state, currentRound, { started, matched, hasPacket }, only = null) {
  if (!state.phase) return null;
  const ph = state.phase;
  const rounds = { ...state.rounds };
  let changed = false;
  const done = (key, r) => {
    const rooms = bracketRooms(model, key, r);
    if (rooms.some((i) => !matched(i))) return false;
    const s = started(r);
    return rooms.every((i) => s.has(i));
  };
  for (const key of ph.keys) {
    if (only && key !== only) continue;
    const r = rounds[key];
    if (r >= ph.last) continue;
    if (done(key, r) && hasPacket(r + 1)) { rounds[key] = r + 1; changed = true; }
  }
  // the next phase opens for everyone at once
  const next = model.phases.find((x) => x.p > ph.p && x.first !== null);
  if (next && ph.keys.every((k) => rounds[k] === ph.last && done(k, ph.last)) && hasPacket(next.first)) {
    return { current: next.first, rounds: {} };
  }
  if (!changed) return null;
  return { current: Math.min(...Object.values(rounds)), rounds };
}

/** Advance all (see the header): {current, rounds}. */
export function advanceAll(model, state, currentRound) {
  if (!state.phase) return { current: currentRound + 1, rounds: {} };
  const ph = state.phase;
  const vals = Object.values(state.rounds);
  if (vals.every((r) => r === ph.last)) {
    const next = model.phases.find((x) => x.p > ph.p && x.first !== null);
    return { current: next ? next.first : ph.last + 1, rounds: {} };
  }
  const to = Math.min(Math.max(...vals) + 1, ph.last);
  const rounds = Object.fromEntries(Object.keys(state.rounds).map((k) => [k, to]));
  return { current: to, rounds };
}

/** One bracket forward a round, up to its phase end; null if it can't. */
export function advanceBracket(model, state, key) {
  if (!state.phase || !(key in state.rounds) || state.rounds[key] >= state.phase.last) return null;
  const rounds = { ...state.rounds, [key]: state.rounds[key] + 1 };
  return { current: Math.min(...Object.values(rounds)), rounds };
}

/**
 * A slot for display: a team name, "Stanford (A1)" once a playoff slot
 * is filled, or "Pool A 1st" while it's still a placeholder.
 */
export function slotLabel(s) {
  if (!s) return '';
  if (s.team) return s.from ? `${s.team} (${s.from})` : s.team;
  const m = s.label ? /^([A-Z])(\d+)$/.exec(s.label) : null;
  if (!m) return slotText(s);
  const n = Number(m[2]);
  const ord = n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  return `Pool ${m[1]} ${ord}`;
}

/** Two-column heading grid for every multi-bracket phase (one place to
    change if it should depend on the bracket count later). */
export function liveLayout(nBrackets) {
  return nBrackets > 1 ? 'columns' : 'plain';
}
