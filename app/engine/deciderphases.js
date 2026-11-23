// deciderphases.js — a schedule's tiebreaker deciders (app/js/deciders.js)
// as a Tiebreakers phase of their own, for the code that reads a schedule
// by its phases: the stats' stages (yft.js yfStages), a room's game for a
// round (schedule.js gameForRoom), the player page's schedule. The saved
// schedule keeps them apart (`deciders.games`), so its rounds never move.
//
// A decider on tiebreaker packet k is played as round TB_ROUND + k: a
// number no schedule reaches, which the packet is also stored under.
export const TB_ROUND = 900;
export const isTbRound = (n) => Number(n) > TB_ROUND;
/** "Round 7", or "Tiebreaker 2" for a tiebreaker packet's round. */
export const roundLabel = (n) => (isTbRound(n) ? 'Tiebreaker ' + (Number(n) - TB_ROUND) : 'Round ' + n);

/** The schedule with its tiebreaker deciders as a phase (kind 'tiebreak')
    after the phase holding the round they follow; the same object when it
    has none. Brackets keep pointing at their own phases. */
export function withDeciderPhases(schedule) {
  const games = (schedule && schedule.deciders && Array.isArray(schedule.deciders.games) ? schedule.deciders.games : [])
    .filter((g) => g && Number.isInteger(g.tb) && g.tb > 0);
  if (!games.length || !Array.isArray(schedule.phases)) return schedule;
  if (schedule.phases.some((ph) => ph.deciders)) return schedule; // already in
  const after = games[0].after;
  let at = schedule.phases.findIndex((ph) => (ph.rounds || []).some((r) => r.round === after));
  if (at < 0) at = 0;
  const tbs = [...new Set(games.map((g) => g.tb))].sort((x, y) => x - y);
  const phase = { name: 'Tiebreakers', kind: 'tiebreak', meet: 1, deciders: true, after,
    rounds: tbs.map((k) => ({ round: TB_ROUND + k, byes: [],
      games: games.filter((g) => g.tb === k).map((g) => ({ room: g.room, a: g.a, b: g.b, decider: g.n })) })) };
  return { ...schedule,
    phases: [...schedule.phases.slice(0, at + 1), phase, ...schedule.phases.slice(at + 1)],
    brackets: (schedule.brackets || []).map((b) => (b.phase > at ? { ...b, phase: b.phase + 1 } : b)) };
}

/* ---- what a schedule keeps of its deciders (the hub's side is app/js/deciders.js) ---- */

/** The schedule's deciders, always whole (a schedule saved before has none). */
export function decOf(s) {
  const d = (s && s.deciders) || {};
  return { parts: d.parts || {}, slots: Number(d.slots) || 0, ties: d.ties || {}, added: Array.isArray(d.added) ? d.added : [], games: Array.isArray(d.games) ? d.games : [], hold: !!d.hold, released: Number(d.released) || 0 };
}
/** The round deciders follow when nothing says otherwise: the last before the first playoff slot. */
export function decAfter(s) {
  const first = s.phases.findIndex((ph) => ph.rounds.some((r) => r.games.some((g) => (g.a && (g.a.label || g.a.from)) || (g.b && (g.b.label || g.b.from)))));
  const ph = s.phases[Math.max(0, first - 1)];
  return ph.rounds[ph.rounds.length - 1].round;
}
/** The tossups and bonuses a part of a packet holds: [from, to) of its length. */
export function partRange(part, n) {
  const half = Math.floor(n / 2);
  return part === 'first' ? [0, half] : part === 'second' ? [half, n] : [0, n];
}
/** The games to play, in order, numbered as deciders: [{n, ...game}]. */
export const decGames = (s) => decOf(s).games.slice().sort((x, y) => x.n - y.n);


// A side of one of the TD's own deciders as it stands: {team} once known, {label} until then.
export function ownSide(d, y, side, depth = 0) {
  const x = y && y[side];
  if (x && x.team) return { team: x.team };
  if (x && Number.isInteger(x.dec) && depth < 8) {
    const o = d.added[x.dec];
    const from = o && o.win ? ownSide(d, o, (x.take === 'loser') === (o.win === 'a') ? 'b' : 'a', depth + 1) : null;
    return from && from.team ? { team: from.team } : { label: x.label || '' };
  }
  if (y && y.res && y.res[side]) return { team: y.res[side] };
  return { label: (x && x.label) || '' };
}

// A packet's JSON with the half no decider read emptied, each question left at its own number:
// the other half may be another tiebreaker's, still to be played. null when it can't be done.
export function packetHalf(text, part) {
  let pk;
  try { pk = JSON.parse(text); } catch (e) { return null; }
  if (!pk || !Array.isArray(pk.tossups)) return null;
  // (an emptied question still reads as one: the page checks each tossup has its two strings)
  const cut = (list, blank) => {
    if (!Array.isArray(list)) return list;
    const mid = Math.floor(list.length / 2);
    return list.map((q, i) => ((part === 'first' ? i < mid : i >= mid) ? q : blank));
  };
  return JSON.stringify({ ...pk, tossups: cut(pk.tossups, { question: '', answer: '' }),
    bonuses: cut(pk.bonuses, { leadin: '', parts: [], answers: [], values: [] }) });
}
