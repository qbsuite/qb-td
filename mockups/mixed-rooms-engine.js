// Throwaway mock (mixed-rooms.html). The board's import map points
// schededit.js here instead of the real engine: all of it passes
// through except phaseLanes, which each proposal lays out its own way.
//   ?v=before  the real lanes (each room goes to the pool that uses it most)
//   ?v=a       a phase where any room hosts two pools is one "Rooms" lane
//   ?v=c       rooms that only one pool uses keep that pool's lane; the
//              rest gather in a "Shared rooms" lane
//   ?v=b       the real lanes (the board turns rooms into pool game slots)
import * as real from '../app/engine/schedule.js?real';

export * from '../app/engine/schedule.js?real';

// the hub mock (mixed-rooms-hub.html) is C
const V = new URLSearchParams(location.search).get('v') || (/mixed-rooms-hub/.test(location.pathname) ? 'c' : 'before');

// room -> Set of brackets that play there in phase p
function roomUse(schedule, p) {
  const use = new Map();
  for (const r of schedule.phases[p].rounds) {
    for (const g of r.games) {
      if (!g.bracket || !(g.a || g.b)) continue;
      if (!use.has(g.room)) use.set(g.room, new Set());
      use.get(g.room).add(g.bracket);
    }
  }
  return use;
}

/**
 * What the picker's shared rooms would do after buildSchedule, for phase
 * p: the last n rooms are shared, and the rest split into a block for
 * each bracket of the phase (the pools in prelims). Each round, a bracket
 * sends the games its block can't hold to the shared rooms, rotating
 * which of its games go and which shared room each one gets. n = 0
 * leaves the phase as built.
 */
export function shareRooms(schedule, n, p = 0) {
  const ph = schedule.phases[p];
  const R = schedule.rooms.length;
  n = Math.max(0, Math.min(R, n));
  if (!n || !ph) return;
  const groups = [...new Set(ph.rounds.flatMap((r) => r.games.map((g) => g.bracket || '')))].sort();
  const P = groups.length;
  const ownN = groups.map((_, k) => Math.floor((R - n) / P) + (k < (R - n) % P ? 1 : 0));
  const start = ownN.map((_, k) => ownN.slice(0, k).reduce((a, b) => a + b, 0));
  ph.rounds.forEach((round, r) => {
    const sent = [];
    const used = new Set();
    groups.forEach((key, k) => {
      const games = round.games.filter((g) => (g.bracket || '') === key).sort((x, y) => x.room - y.room);
      const out = Math.max(0, games.length - ownN[k]);
      const goes = new Set(Array.from({ length: out }, (_, i) => (r + i) % games.length));
      let own = 0;
      games.forEach((g, i) => { if (goes.has(i)) sent.push(g); else used.add(g.room = start[k] + own++); });
    });
    // more games than shared rooms (a bracket left its own rooms empty):
    // the rest take those empty rooms
    const free = Array.from({ length: R - n }, (_, i) => i).filter((i) => !used.has(i));
    sent.forEach((g, i) => { g.room = i < n ? R - n + ((i + r) % n) : free.shift(); });
    round.games.sort((x, y) => x.room - y.room);
  });
}

// The real picker shows Generate only when a format fits (none does for
// 48 teams). The new picker's Custom works for any field, so the real one
// always gets a stand-in; Generate's save swaps in the plan's build.
export function formatsFor(nTeams, nRooms) {
  const list = real.formatsFor(nTeams, nRooms);
  return list.length ? list : [{ key: 'custom', name: 'Custom', desc: '', teams: nTeams, rounds: 0, roomsNeeded: 1 }];
}
export function buildSchedule(key, teams, rooms, opts = {}) {
  if (key !== 'custom') return real.buildSchedule(key, teams, rooms, opts);
  return { v: 1, rooms: rooms.map((r) => ({ name: r.name, bucket: r.bucket ?? null })), phases: [{ name: 'Round robin', rounds: [] }], updated: 0 };
}

// The editor's checks, minus "teams have no game" in an elimination
// phase: there most teams wait for a game ("Winner of game 3"), which is
// how elimination works, not a problem
export function scheduleChecks(schedule) {
  return real.scheduleChecks(schedule).filter((c) => !(c.kind === 'missing' && schedule.phases[c.p] && schedule.phases[c.p].kind));
}

export function phaseLanes(schedule, p, only) {
  if (V !== 'a' && V !== 'c') return real.phaseLanes(schedule, p, only);
  const use = roomUse(schedule, p);
  const shared = [...use].filter(([, set]) => set.size > 1).map(([room]) => room).sort((x, y) => x - y);
  if (!shared.length) return real.phaseLanes(schedule, p, only);
  if (V === 'a') return [{ key: '', name: 'Rooms', rooms: schedule.rooms.map((_, i) => i) }];
  const lanes = real.bracketRooms(schedule).filter((b) => b.phase === p)
    .map((b) => ({ key: b.key, name: b.name, rooms: b.rooms.filter((i) => !shared.includes(i)) }))
    .filter((l) => l.rooms.length);
  lanes.push({ key: '', name: 'Shared rooms', rooms: shared });
  return lanes;
}
