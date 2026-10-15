// plan.js — the schedule builder behind the format picker (schededit.js).
// A plan is a list of phases; the picker's Format menu fills one in from
// hdwhite's formats (hdwhite.js) and Custom edits it. A built schedule has
// buildSchedule's shape (rooms, phases of rounds of games, pools,
// brackets), so the editor, the Live Hub, the rooms and the public page
// read it unchanged; a phase may also carry `kind` ('tiebreak', 'final',
// 'single', 'double') and a game `ifNeeded`.
//
// Phases:
//   first     kind 'pools': `groups` pools (or `sizes`), snake or random seeding
//   later     `same`: the groups of the phase before, played again
//             `sizes`: pools by finish, best places first ("6/6/6/5"); a
//             place cut by a pool's edge is compared across pools
//             ("Better 4th place": winning percentage, then points per 20)
//             `per`: places per pool when no sizes (per -1: each pool's own
//             top half and bottom half, as the 2-pool defaults do)
//             kind 'single' / 'double': elimination of the top `top` of
//             each pool, seeded by place
//   carry     crossover: pairs from the same earlier pool don't play again
//   ties      'pp20' or 'game' (a free round before the phase for tiebreakers)
//   byes      an even pool's round robin with a bye round for each team
//   share, n, mode   rooms: the last n rooms shared by all pools; how teams move
//   meets     how many times each pair plays
// Rounds are always shuffled within a pools phase.
import { poolSizes, roundRobinRounds, crossRounds, mulberry32 } from './schedule.js';

// What sharing rooms does, for phase p: the last n rooms are shared, and
// the rest split into a block for each bracket of the phase. Each round, a
// bracket sends the games its block can't hold to the shared rooms,
// rotating which of its games go and which shared room each one gets.
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

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const names = (xs) => (xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1));
export const ORD = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function snake(items, sizes) {
  const groups = sizes.map(() => []);
  let i = 0;
  for (let row = 0; i < items.length; row++) {
    const seq = [...sizes.keys()];
    if (row % 2) seq.reverse();
    for (const g of seq) if (i < items.length && groups[g].length < sizes[g]) groups[g].push(items[i++]);
  }
  return groups;
}

// a group's rounds: [[x, y], ...] per round. Without carry-over it is the
// circle method; with it, the pairs left are packed (the best of many tries)
function groupRounds(members, meets, skip, byes) {
  // byes ("full round-robin with byes"): an even group's last round is
  // split in two, so each team sits out exactly one round and the round
  // robin takes as many rounds as there are teams
  if (byes && members.length % 2 === 0 && members.length > 2 && !skip) {
    const once = groupRounds(members, 1, null, false);
    const last = once.pop();
    const half = Math.ceil(last.length / 2);
    const withByes = [...once, last.slice(0, half), last.slice(half)];
    return Array.from({ length: meets }, () => withByes).flat();
  }
  let base;
  if (!skip) {
    base = roundRobinRounds(members.length).map((r) => r.pairs.map(([i, j]) => [members[i], members[j]]));
  } else {
    const sources = [...new Set(members.map((x) => x.from))];
    const mates = (x) => members.filter((y) => y !== x && skip(x, y)).length;
    if (sources.length === 2 && members.every((x) => mates(x) === members.filter((y) => y.from === x.from).length - 1)) {
      // two halves crossing over: a Latin square, each team meets the other half once
      const A = members.filter((x) => x.from === sources[0]);
      const B = members.filter((x) => x.from === sources[1]);
      base = crossRounds(A.map((_, i) => i), B.map((_, i) => i)).map((r) => r.pairs.map(([i, j]) => [A[i], B[j]]));
      return Array.from({ length: meets }, () => base).flat();
    }
    if (members.length % 2 === 0 && members.every((x) => mates(x) === 1)) {
      // each team has one pool-mate (the top two of each pool): seat each
      // pair opposite in the circle method's first round and leave it out
      const n = members.length;
      const order = new Array(n);
      const pairs = [];
      const seen = new Set();
      for (const x of members) {
        if (seen.has(x)) continue;
        const y = members.find((z) => z !== x && skip(x, z));
        seen.add(x); seen.add(y);
        pairs.push([x, y]);
      }
      pairs.forEach(([x, y], i) => { order[i] = x; order[n - 1 - i] = y; });
      base = roundRobinRounds(n).slice(1).map((r) => r.pairs.map(([i, j]) => [order[i], order[j]]));
      return Array.from({ length: meets }, () => base).flat();
    }
    const all = [];
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      if (!skip(members[i], members[j])) all.push([members[i], members[j]]);
    }
    // Equal parts crossing over: q earlier pools with m teams each, every
    // team playing everyone not from its own pool. Exact constructions,
    // (q − 1)·m rounds, the least possible:
    //   m even  split each part in two halves; a round robin of the 2q
    //           halves with each part's halves seated opposite, leaving out
    //           the one round where they meet; each pairing of halves is a
    //           Latin square (m = 2 is the pool-mates-opposite case)
    //   q even  a round robin of the parts, each pairing a Latin square
    const parts = [...new Set(members.map((x) => x.from))].map((k) => members.filter((x) => x.from === k));
    const m = parts[0].length;
    const crossing = parts.length >= 2 && parts.every((x) => x.length === m)
      && members.every((x) => members.every((y) => x === y || skip(x, y) === (x.from === y.from)));
    if (crossing && (m % 2 === 0 || parts.length % 2 === 0)) {
      const units = m % 2 === 0 ? [...parts.map((x) => x.slice(0, m / 2)), ...parts.map((x) => x.slice(m / 2)).reverse()] : parts;
      const unitRounds = roundRobinRounds(units.length).slice(m % 2 === 0 ? 1 : 0);
      base = unitRounds.flatMap((ur) => {
        const squares = ur.pairs.map(([i, j]) => crossRounds(units[i].map((_, a) => a), units[j].map((_, b) => b))
          .map((r) => r.pairs.map(([a, b]) => [units[i][a], units[j][b]])));
        return squares[0].map((_, k) => squares.flatMap((sq) => sq[k]));
      });
      return Array.from({ length: meets }, () => base).flat();
    }
    // nothing skipped after all (a pool of 1st places from different
    // pools): the circle method, in the fewest rounds
    if (all.length === (members.length * (members.length - 1)) / 2) return groupRounds(members, meets, null, false);
    // Pack the pairs left into rounds. Each round pairs the teams with the
    // most games still to play first (they set how many rounds it takes);
    // the best of many tries. The least possible is the busiest team's games.
    const rng = mulberry32(members.length * 31 + all.length);
    const floor = Math.max(0, ...members.map((m) => all.filter((p) => p[0] === m || p[1] === m).length));
    const byId = new Map(members.map((m) => [m.id, m]));
    for (let tries = 0; tries < 300 && !(base && base.length <= floor); tries++) {
      const left = new Map(members.map((m) => [m.id, new Set()]));
      for (const [x, y] of all) { left.get(x.id).add(y.id); left.get(y.id).add(x.id); }
      const out = [];
      let games = all.length;
      while (games > 0) {
        const jitter = new Map(members.map((m) => [m.id, rng()]));
        const busiest = (a, b) => left.get(b).size - left.get(a).size || jitter.get(a) - jitter.get(b);
        const used = new Set();
        const round = [];
        for (const v of [...left.keys()].sort(busiest)) {
          if (used.has(v) || !left.get(v).size) continue;
          const w = [...left.get(v)].filter((u) => !used.has(u)).sort(busiest)[0];
          if (w === undefined) continue;
          used.add(v); used.add(w);
          left.get(v).delete(w); left.get(w).delete(v);
          round.push([byId.get(v), byId.get(w)]);
          games--;
        }
        out.push(round);
      }
      if (!base || out.length < base.length) base = out;
    }
  }
  return Array.from({ length: meets }, () => base).flat();
}

// the teams of the phase before, by place: [[1st places], [2nd places], ...]
// After tiered brackets (1st–2nd place, then 3rd–4th place …) everyone in a
// higher bracket finishes above everyone in a lower one, so the order is
// bracket first, then place in it.
function byPlace(prev, p, top) {
  const tiers = [...new Set(prev.map((g) => g.tier || 0))];
  const rows = [];
  let place = 0;
  for (const tr of tiers) {
    const gs = prev.filter((g) => (g.tier || 0) === tr);
    const full = Math.max(...gs.map((g) => g.members.length));
    const deepest = top && tiers.length === 1 ? Math.min(top, full) : full;
    for (let pos = 0; pos < deepest; pos++) {
      place++;
      rows.push(gs.filter((g) => pos < g.members.length).map((g) => ({
        id: `${p}:${g.key}:${pos}`, place: tiers.length > 1 ? place : pos + 1, from: g.key,
        slot: { label: p === 1 && /^[A-Z]$/.test(g.key) ? g.key + (pos + 1) : `${ORD(pos + 1)} in ${g.name}` },
      })));
    }
  }
  return rows;
}

// Standard rebracketing of one tier into m pools: place by place, each
// team goes to the pool with room that has the fewest of its place, then
// the fewest teams from its own earlier group, then the snake's turn.
function rebracket(rows, m) {
  const total = rows.reduce((n, r) => n + r.length, 0);
  const cap = poolSizes(total, m);
  const pools = Array.from({ length: m }, () => []);
  rows.forEach((row, ri) => {
    const order = [...Array(m).keys()];
    if (ri % 2) order.reverse();
    for (const team of row) {
      let best = -1;
      let score = null;
      for (const j of order) {
        if (pools[j].length >= cap[j]) continue;
        const s = [pools[j].filter((x) => x.place === team.place).length, pools[j].filter((x) => x.from === team.from).length];
        if (!score || s[0] < score[0] || (s[0] === score[0] && s[1] < score[1])) { best = j; score = s; }
      }
      pools[best].push(team);
    }
  });
  return pools;
}

/** The groups of each phase: [{key, name, members: [{id, slot, from, place}], tier}].
    An elimination phase has one group: its seeds in order. */
export function planGroups(teams, phases, seeding, rng) {
  const out = [];
  const order = seeding === 'random' ? shuffle(teams, rng) : teams.slice();
  phases.forEach((ph, p) => {
    if (p === 0) {
      // pool sizes as given ("6/6"), or `groups` pools as even as can be
      const given = ph.sizes && ph.sizes.reduce((a, b) => a + b, 0) === teams.length ? ph.sizes : null;
      const G = given ? given.length : Math.max(1, Math.min(ph.groups, Math.floor(teams.length / 2)));
      out.push(snake(order.map((t) => ({ id: t, slot: { team: t } })), given || poolSizes(teams.length, G)).map((members, k) => ({
        key: G > 1 ? LETTERS[k] : 'ph1', name: G > 1 ? 'Pool ' + LETTERS[k] : ph.name, members,
      })));
      return;
    }
    if (ph.same) {
      // the same groups as the phase before, played again (a copied
      // phase: a fifth round robin, the prelim pools a second time)
      out.push(out[p - 1].map((g) => ({ ...g, key: out[p - 1].length === 1 ? 'ph' + (p + 1) : `${g.key}~${p + 1}`,
        name: out[p - 1].length === 1 ? ph.name : g.name, members: g.members.map((m) => ({ ...m, from: m.from || g.key })) })));
      return;
    }
    const rows = byPlace(out[p - 1], p, ph.top);
    if (ph.sizes && ph.sizes.length && ph.kind !== 'single' && ph.kind !== 'double') {
      out.push(bySizes(rows, ph, p));
      return;
    }
    if (ph.kind === 'single' || ph.kind === 'double') {
      out.push([{ key: `p${p + 1}`, name: ph.name, members: eliminationSeeds(rows), tier: 0 }]);
      return;
    }
    // per -1: top half and bottom half of each group by its own size
    // (a pool of 5 sends 3 up, a pool of 4 sends 2)
    const halves = ph.per === -1;
    const per = halves ? Math.ceil(rows.length / 2) : Math.max(1, Math.min(rows.length, ph.per || 1));
    const tiers = halves ? 2 : Math.ceil(rows.length / per);
    const sizeOf = new Map(out[p - 1].map((g) => [g.key, ph.top ? Math.min(ph.top, g.members.length) : g.members.length]));
    const groups = [];
    for (let i = 0; i < tiers; i++) {
      const upper = (x) => x.place <= Math.ceil(sizeOf.get(x.from) / 2);
      const tierRows = halves ? rows.map((r) => r.filter((x) => (i === 0) === upper(x))).filter((r) => r.length)
        : rows.slice(i * per, (i + 1) * per);
      // names and keys as the engine gives them (1st place F1, 1st–2nd
      // place T1, Championship CH); later phases add their number
      const last = Math.min((i + 1) * per, rows.length);
      const tierName = tiers === 1 ? ph.name : per === 1 && !halves ? ORD(i + 1) + ' place' : halves ? ['Championship', 'Consolation'][i]
        : i * per + 1 === last ? `${ORD(last)} place` : `${ORD(i * per + 1)}–${ORD(last)} place`;
      const tierKey = (tiers === 1 ? 'ph' + (p + 1) : per === 1 && !halves ? 'F' + (i + 1) : halves ? ['CH', 'CO'][i] : 'T' + (i + 1))
        + (p > 1 && tiers > 1 ? '~' + (p + 1) : '');
      if (ph.cross) {
        // crossover: the earlier groups in pairs (A with B, C with D; an
        // odd one out joins the last pair), each pair one playoff pool
        const keys = out[p - 1].map((g) => g.key);
        const pairs = [];
        for (let j = 0; j < keys.length; j += 2) pairs.push(keys.slice(j, j + 2));
        if (pairs.length > 1 && pairs[pairs.length - 1].length === 1) pairs[pairs.length - 2].push(...pairs.pop());
        const label = (pr) => pr.join('/');
        pairs.forEach((pr) => {
          const members = tierRows.flat().filter((x) => pr.includes(x.from));
          if (members.length) groups.push({ key: `${tierKey}${pairs.length > 1 ? pr.join('') : ''}`, name: pairs.length > 1 ? `${tierName} ${label(pr)}` : tierName, members, tier: i, cross: true });
        });
        continue;
      }
      const size = tierRows.reduce((n, r) => n + r.length, 0);
      const m = Math.max(1, Math.min(ph.pools || 1, Math.floor(size / 2)));
      rebracket(tierRows, m).forEach((members, j) => groups.push({
        key: `${tierKey}${m > 1 ? LETTERS[j] : ''}`, name: m > 1 ? `${tierName} ${j + 1}` : tierName, members, tier: i,
        // the engine lists a one-team tier of 2+ places ("7th place" in
        // brackets of 6) but not a one-team place group ("8th place")
        listed: per > 1 && !halves,
      }));
    }
    out.push(groups);
  });
  return out;
}

// Seeds for an elimination bracket: by place (1st places first). Within
// a place the order is open until the day (it comes from stats then), so
// each place after the first is turned so that as few first-round games
// as possible are between teams from the same earlier group.
function eliminationSeeds(rows) {
  const n = rows.reduce((k, r) => k + r.length, 0);
  const size = 2 ** Math.ceil(Math.log2(Math.max(2, n)));
  const order = bracketOrder(size);
  const clashes = (seeds) => {
    let c = 0;
    for (let i = 0; i < size; i += 2) {
      const x = seeds[order[i] - 1];
      const y = seeds[order[i + 1] - 1];
      if (x && y && x.from === y.from) c++;
    }
    return c;
  };
  let best = rows.flat();
  let bestC = clashes(best);
  const turns = rows.map((r) => r.length);
  const pick = (i, acc) => {
    if (!bestC) return;
    if (i === rows.length) {
      const seeds = acc.flat();
      const c = clashes(seeds);
      if (c < bestC) { best = seeds; bestC = c; }
      return;
    }
    for (let t = 0; t < (i ? turns[i] : 1); t++) pick(i + 1, [...acc, [...rows[i].slice(t), ...rows[i].slice(0, t)]]);
  };
  pick(0, []);
  return best;
}

// Playoff brackets by size, as hdwhite gives them ("into playoff
// brackets of 9, 6 and 8"): the finish order (1st places, then 2nd
// places, …) is cut into brackets of those sizes. Brackets that end
// partway through a place are joined with the next ones of the same
// size into one tier and spread evenly by rebracketing ("three of five"
// after a six); with
// `parallelTop`, so are the first two ("two parallel top brackets").
function bySizes(rows, ph, p) {
  const flat = rows.flat();
  const bounds = new Set();
  let at = 0;
  for (const r of rows) { at += r.length; bounds.add(at); }
  const sizes = ph.sizes.slice();
  const tiers = [];
  let i = 0;
  let used = 0;
  while (i < sizes.length && used < flat.length) {
    const tier = [sizes[i++]];
    let end = used + tier[0];
    // join the next bracket when this one stops partway through a place
    // and the next is the same size (parallel brackets), or for the
    // parallel top brackets; otherwise cut where the size says
    while (i < sizes.length && end < flat.length
      && ((!bounds.has(end) && sizes[i] === tier[0]) || (ph.parallelTop && tiers.length === 0 && tier.length < 2))) {
      tier.push(sizes[i++]);
      end += tier[tier.length - 1];
    }
    tiers.push({ sizes: tier, from: used, to: Math.min(end, flat.length) });
    used = end;
  }
  // A place cut by a tier's edge (7/6 into 7/6: one of A4 and B4 goes
  // up) isn't decided by pool letter: its slots are the place's teams
  // compared with each other ("Better 4th place", "Other 4th place"),
  // by winning percentage, then points per 20 tossups heard, when the
  // slots are filled. Who they are isn't known yet, so no game of theirs
  // can carry over.
  const cuts = tiers.slice(0, -1).map((tr) => tr.to);
  const split = [];
  let at2 = 0;
  for (const r of rows) {
    const from = at2;
    at2 += r.length;
    if (!cuts.some((c) => c > from && c < at2)) continue;
    const names = r.length === 2 ? ['Better', 'Other'] : r.map((_, i) => (i ? ORD(i + 1) + '-best' : 'Best'));
    r.forEach((m, i) => { m.slot = { label: `${names[i]} ${ORD(m.place)} place` }; m.from = `compared:${m.place}:${i}`; });
    split.push(r[0].place);
  }
  const placeOf = (k) => flat[Math.min(k, flat.length - 1)].place;
  const groups = [];
  tiers.forEach((tr, ti) => {
    const members = flat.slice(tr.from, tr.to);
    const a = placeOf(tr.from);
    const b = placeOf(tr.to - 1);
    const halves = rows.length > 1 && tiers.length === 2 && ph.per === -1;
    const name = tiers.length === 1 ? ph.name : halves ? ['Championship', 'Consolation'][ti] : a === b ? `${ORD(a)} place` : `${ORD(a)}–${ORD(b)} place`;
    const key = (tiers.length === 1 ? 'ph' + (p + 1) : halves ? ['CH', 'CO'][ti] : a === b && tr.sizes.length === 1 ? 'F' + a : 'T' + (ti + 1)) + (p > 1 && tiers.length > 1 ? '~' + (p + 1) : '');
    if (tr.sizes.length === 1) { groups.push({ key, name, members, tier: ti, listed: true }); return; }
    // a tier of parallel brackets: by place, keeping pool-mates apart
    const tierRows = [];
    for (const m of members) { const last = tierRows[tierRows.length - 1]; if (last && last[0].place === m.place) last.push(m); else tierRows.push([m]); }
    const spread = rebracket(tierRows, tr.sizes.length);
    spread.forEach((g, j) => groups.push({ key: key + LETTERS[j], name: `${name} ${LETTERS[j]}`, members: g, tier: ti, listed: true }));
  });
  groups.split = split; // places compared across groups ("Better 4th place")
  return groups;
}

// standard bracket order for a power of two: 1, 8, 4, 5, 2, 7, 3, 6
function bracketOrder(size) {
  let seeds = [1];
  while (seeds.length < size) {
    const n = seeds.length * 2 + 1;
    seeds = seeds.flatMap((s) => [s, n - s]);
  }
  return seeds;
}

// An elimination bracket's rounds: [{games: [{a, b, id}], byes}]. Game ids
// run on within the phase; later slots read "Winner of game 3".
function eliminationRounds(seeds, kind, reset) {
  const N = seeds.length;
  const S = 2 ** Math.ceil(Math.log2(Math.max(2, N)));
  let id = 0;
  const W = (g) => ({ label: `Winner of game ${g.id}` });
  const L = (g) => ({ label: `Loser of game ${g.id}` });
  const rounds = [];
  // winners bracket, round 1 (a top seed with no opponent goes straight on)
  const order = bracketOrder(S);
  let alive = [];
  const r1 = { games: [], byes: [] };
  for (let i = 0; i < S; i += 2) {
    const x = seeds[order[i] - 1];
    const y = seeds[order[i + 1] - 1];
    if (x && y) { const g = { id: ++id, a: x.slot, b: y.slot }; r1.games.push(g); alive.push(W(g)); } else { const s = x || y; r1.byes.push(s.slot); alive.push(s.slot); }
  }
  rounds.push(r1);
  const wLosers = [r1.games.map(L)];
  while (alive.length > 1) {
    const r = { games: [], byes: [] };
    const next = [];
    for (let i = 0; i < alive.length; i += 2) { const g = { id: ++id, a: alive[i], b: alive[i + 1] }; r.games.push(g); next.push(W(g)); }
    rounds.push(r);
    wLosers.push(r.games.map(L));
    alive = next;
  }
  if (kind !== 'double') return rounds;
  // losers bracket: round 1's losers play each other; then the survivors
  // meet each later winners round's losers, then each other
  const wChamp = alive[0];
  let at = 1; // the schedule round the next losers round shares
  const put = (games) => { while (rounds.length <= at) rounds.push({ games: [], byes: [] }); rounds[at].games.push(...games); at++; };
  const pair = (slots) => { const gs = []; for (let i = 0; i + 1 < slots.length; i += 2) gs.push({ id: ++id, a: slots[i], b: slots[i + 1] }); return gs; };
  let lb = wLosers[0];
  if (lb.length > 1) { const games = pair(lb); put(games); lb = games.map(W); }
  for (let k = 1; k < wLosers.length; k++) {
    const incoming = wLosers[k];
    const games = lb.map((s, i) => ({ id: ++id, a: s, b: incoming[incoming.length - 1 - i] })).filter((g) => g.b);
    put(games);
    lb = games.map(W);
    if (lb.length > 1) { const g2 = pair(lb); put(g2); lb = g2.map(W); }
  }
  const final = { id: ++id, a: wChamp, b: lb[0] };
  put([final]);
  if (reset) put([{ id: ++id, a: { label: `Winner of game ${final.id}` }, b: { label: `Loser of game ${final.id}` }, ifNeeded: true }]);
  return rounds;
}

/** Build the schedule; throws when the rooms can't hold a round. */
export function buildPlan(teams, rooms, phases, seeding, seed) {
  const given = phases[0].sizes ? phases[0].sizes.reduce((a, b) => a + b, 0) : teams.length;
  if (given !== teams.length) throw new Error(`The pools hold ${given} teams, but there are ${teams.length}.`);
  const rng = mulberry32(Number(seed) || 1);
  const groupsBy = planGroups(teams, phases, seeding, rng);
  const R = rooms.length;
  const s = { v: 1, rooms: rooms.map((r) => ({ ...r })), phases: [], brackets: [], format: 'custom' };
  if (groupsBy[0].length > 1) s.pools = Object.fromEntries(groupsBy[0].map((g) => [g.key, g.members.map((m) => m.id)]));
  let roundNo = 1;
  phases.forEach((ph, p) => {
    const groups = groupsBy[p];
    const elim = p > 0 && (ph.kind === 'single' || ph.kind === 'double');
    let rounds;
    if (elim) {
      const key = groups[0].key;
      rounds = eliminationRounds(groups[0].members, ph.kind, ph.reset).map((r) => ({
        games: r.games.map((g) => ({ room: 0, a: g.a, b: g.b, bracket: key, game: g.id, ...(g.ifNeeded ? { ifNeeded: true } : {}) })),
        byes: r.byes,
      }));
      rounds.forEach((round) => {
        if (round.games.length > R) throw new Error(`${ph.name} needs ${round.games.length} rooms`);
        round.games.forEach((g, i) => { g.room = i; });
      });
    } else {
      const skip = p > 0 && ph.carry && !ph.same ? (x, y) => x.from === y.from : null;
      const per = groups.map((g) => groupRounds(g.members, ph.meets || 1, skip, ph.byes));
      const nRounds = Math.max(...per.map((r) => r.length));
      rounds = Array.from({ length: nRounds }, (_, r) => {
        const games = [];
        const byes = [];
        groups.forEach((g, k) => {
          const pairs = per[k][r] || [];
          const playing = new Set(pairs.flat().map((m) => m.id));
          pairs.forEach(([x, y]) => games.push({ room: 0, a: x.slot, b: y.slot, bracket: g.key }));
          g.members.filter((m) => !playing.has(m.id)).forEach((m) => byes.push(m.slot));
        });
        return { games, byes };
      });
      rounds = shuffle(rounds, rng); // rounds are always shuffled
      // each group gets a block of rooms as big as its busiest round
      const need = groups.map((g) => Math.max(0, ...rounds.map((r) => r.games.filter((x) => x.bracket === g.key).length)));
      const total = need.reduce((a, b) => a + b, 0);
      if (total > R) throw new Error(`${ph.name} needs ${total} rooms`);
      rounds.forEach((round, r) => {
        let start = 0;
        groups.forEach((g, k) => {
          const games = round.games.filter((x) => x.bracket === g.key);
          const slots = [...Array(need[k]).keys()];
          const order = ph.mode === 'shuffle' ? shuffle(slots, rng) : ph.mode === 'rotate' ? slots.map((_, i) => slots[(i + r) % slots.length]) : slots;
          games.forEach((x, i) => { x.room = start + order[i]; });
          start += need[k];
        });
      });
    }
    // ties for a spot settled by a tiebreaker game: a free round first,
    // played only if needed
    if (p > 0 && ph.ties === 'game' && !ph.same) {
      s.phases.push({ name: 'Tiebreakers', rounds: [{ round: roundNo++, games: [], byes: [] }], meet: 1, kind: 'tiebreak' });
    }
    rounds.forEach((round) => { round.games.sort((x, y) => x.room - y.room); round.round = roundNo++; });
    s.phases.push({ name: ph.name, rounds, meet: ph.meets || 1, ...(elim ? { kind: ph.kind } : {}) });
    // a group of one team has no games, so no bracket, except where the
    // engine lists one
    const at = s.phases.length - 1;
    for (const g of groups) if (g.members.length > 1 || g.listed) s.brackets.push({ key: g.key, name: g.name, phase: at });
    if (!elim && ph.share && groups.length > 1) shareRooms(s, ph.n, at);
  });
  return s;
}

/** The preview line's facts (rounds and rooms used), or the error. */
export function planPreview(teams, rooms, phases, seeding, seed) {
  try {
    const s = buildPlan(teams, rooms, phases, seeding, seed);
    const nr = s.phases.reduce((n, ph) => n + (ph.kind === 'tiebreak' ? 0 : ph.rounds.length), 0);
    const used = new Set(s.phases.flatMap((ph) => ph.rounds.flatMap((r) => r.games.map((g) => g.room))));
    return { ok: true, rounds: s.phases.filter((ph) => ph.kind !== 'tiebreak').map((ph) => ph.rounds.length), schedule: s,
      tiebreak: s.phases.filter((ph) => ph.kind === 'tiebreak').length,
      text: `${nr} rounds · ${used.size} of ${rooms.length} rooms used` };
  } catch (e) { return { ok: false, rounds: [], text: e.message }; }
}

/** Ways to split the places that go up into tiers: [{per, tiers, label}] */
export function tierSplits(deepest) {
  const out = [];
  for (let per = 1; per <= deepest; per++) {
    const tiers = Math.ceil(deepest / per);
    if (out.some((x) => x.tiers === tiers)) continue;
    // two tiers: each group's own top half (per -1), as the 2-pool defaults do
    if (tiers === 2) { out.push({ per: -1, tiers, label: 'Top half and bottom half' }); continue; }
    const label = tiers === 1 ? 'One tier' : per === 1 ? 'Each place its own tier' : `Top ${per}, next ${per}, …`;
    out.push({ per, tiers, label });
  }
  return out;
}

/**
 * The rebracketing checks for phase p (p > 0): [{ok, text}]. Tests the
 * groups the plan makes: pool sizes, places spread evenly across the
 * pools of a tier, teams from the same earlier group kept apart (or
 * their games carried over); for elimination, the bracket's shape.
 */
export function rebracketChecks(groupsBy, phases, p) {
  const ph = phases[p];
  const groups = groupsBy[p];
  const prevName = phases[p - 1].name.toLowerCase();
  const unit = p === 1 ? 'pool' : 'group';
  const out = [];
  if (ph.same) {
    return [{ ok: true, text: `The same ${groups.length === 1 ? 'teams' : unit + 's'} as ${prevName}, and each pair plays again.` }];
  }
  if (ph.kind === 'single' || ph.kind === 'double') {
    const seeds = groups[0].members;
    const n = seeds.length;
    const size = 2 ** Math.ceil(Math.log2(Math.max(2, n)));
    out.push({ ok: true, text: `${n} teams, seeded by place: ${seeds.slice(0, 4).map((m) => m.slot.label).join(', ')}${n > 4 ? ', …' : ''}` });
    out.push({ ok: true, text: n === size ? 'No byes are needed.' : `The top ${size - n} seeds get a first-round bye.` });
    out.push({ ok: true, text: 'The top two seeds can only meet in the final.' });
    if (ph.kind === 'double' && n !== size) out.push({ ok: false, text: 'Double elimination works best with 4, 8 or 16 teams. Some losers-bracket games will be uneven.' });
    const order = bracketOrder(size);
    const clash = [];
    for (let i = 0; i < size; i += 2) {
      const x = seeds[order[i] - 1];
      const y = seeds[order[i + 1] - 1];
      if (x && y && x.from === y.from) clash.push(`${x.slot.label} and ${y.slot.label}`);
    }
    out.push(clash.length ? { ok: false, text: `Teams from the same ${unit} meet in the first round: ${clash.join('; ')}.` }
      : { ok: true, text: `No first-round game is a rematch from ${prevName}.` });
    return out;
  }
  const tiers = [...new Set(groups.map((g) => g.tier))];
  const inTier = (t) => groups.filter((g) => g.tier === t);
  const sizes = [...new Set(groups.map((g) => g.members.length).filter((k) => k > 1))].sort((a, b) => b - a);
  const uneven = tiers.some((t) => { const s = inTier(t).map((g) => g.members.length); return Math.max(...s) - Math.min(...s) > 1; });
  out.push(uneven ? { ok: false, text: 'Some playoff pools in the same tier differ by more than one team.' }
    : { ok: true, text: `Playoff pools of ${sizes.join(' or ')} teams.` });
  if (ph.cross) {
    const sources = groups.filter((g) => g.tier === 0).map((g) => [...new Set(g.members.map((m) => m.from))].join('/'));
    out.push({ ok: true, text: `Crossover: ${sources.join(' and ')} play together${ph.carry ? `, and teams only play teams from other ${unit}s` : ''}.` });
  } else if (groups.length > tiers.length) {
    const unevenPlaces = tiers.some((t) => {
      const gs = inTier(t);
      const places = [...new Set(gs.flatMap((g) => g.members.map((m) => m.place)))];
      return places.some((pl) => { const c = gs.map((g) => g.members.filter((m) => m.place === pl).length); return Math.max(...c) - Math.min(...c) > 1; });
    });
    out.push(unevenPlaces ? { ok: false, text: 'Some playoff pools get more teams of one place than others.' }
      : { ok: true, text: 'Each playoff pool in a tier gets the same places.' });
  }
  const alone = groups.filter((g) => g.members.length === 1);
  if (alone.length) out.push({ ok: false, text: `${names(alone.map((g) => `${g.name} has only ${g.members[0].slot.label}`))}, so ${alone.length === 1 ? 'that team has' : 'those teams have'} no games in ${phases[p].name.toLowerCase()}.` });
  const together = groups.reduce((n, g) => {
    const c = new Map();
    for (const m of g.members) c.set(m.from, (c.get(m.from) || 0) + 1);
    return n + [...c.values()].reduce((a, k) => a + (k * (k - 1)) / 2, 0);
  }, 0);
  if (!together) out.push({ ok: true, text: `No playoff pool has two teams from the same ${unit}.` });
  else if (ph.carry) out.push({ ok: true, text: `${together} pairs from the same ${unit} share a playoff pool. Their games from ${prevName} carry over.` });
  // crossover off: pool-mates play again, which is a choice, not a problem
  return out;
}

/**
 * Finals after the last phase, added to a built schedule in place:
 * between 1st and 2nd of the top pool, or between the winners of two
 * parallel top pools. Every finals game depends on results, so each is
 * marked ifNeeded with when it's played (the usual rule: no final when
 * the leader is two wins clear; an advantaged final, where the leader
 * needs one win and the challenger two, when one win clear; one game
 * when tied). Returns what the finals are, or null when there's no top
 * pool to take them from.
 */
export function addFinals(s, groupsBy, phases, ties = 'pp20') {
  const last = groupsBy[groupsBy.length - 1];
  const kind = phases[phases.length - 1].kind;
  if (kind === 'single' || kind === 'double') return null; // elimination has its own final
  const top = last.filter((g) => (g.tier || 0) === 0 && g.members.length > 1);
  if (!top.length) return null;
  const parallel = top.length > 1;
  const name = (g) => g.name;
  const a = parallel ? { label: `1st in ${name(top[0])}` } : { label: `1st in ${name(top[0])}` };
  const b = parallel ? { label: `1st in ${name(top[1])}` } : { label: `2nd in ${name(top[0])}` };
  let round = Math.max(...s.phases.flatMap((p) => p.rounds.map((r) => r.round))) + 1;
  // a tie for a place in the final settled by a game: a free round first
  if (ties === 'game') s.phases.push({ name: 'Tiebreakers', rounds: [{ round: round++, games: [], byes: [] }], meet: 1, kind: 'tiebreak' });
  const key = 'FN';
  const rounds = [{ round: round++, games: [{ room: 0, a, b, bracket: key, ifNeeded: parallel ? undefined : 'unless the leader is two wins clear' }], byes: [] }];
  if (!parallel) rounds.push({ round: round++, games: [{ room: 0, a: { ...a }, b: { ...b }, bracket: key, ifNeeded: 'if the leader loses the first game of an advantaged final' }], byes: [] });
  s.phases.push({ name: 'Finals', rounds, meet: parallel ? 1 : 2, kind: 'final' });
  s.brackets.push({ key, name: 'Finals', phase: s.phases.length - 1 });
  return { parallel, a: a.label, b: b.label };
}

/**
 * Filling a split place: the teams of that place, from different pools,
 * compared best first by winning percentage, then points per 20 tossups
 * heard. teams: [{name, pool, w, l, t, pp20}]; up: how many go up.
 * Returns {order, notes}: notes say how a tie that decides who goes up
 * was broken, or that it couldn't be, for the TD to settle (or play a
 * tiebreaker game) before filling.
 */
export function comparePlace(place, teams, up) {
  const pct = (x) => (x.w + (x.t || 0) / 2) / Math.max(1, x.w + x.l + (x.t || 0));
  const rec = (x) => `${x.w}–${x.l}${x.t ? '–' + x.t : ''}`;
  const order = [...teams].sort((x, y) => pct(y) - pct(x) || y.pp20 - x.pp20);
  const notes = [];
  // only a tie across the line matters: the last team up and the first left out
  if (up > 0 && up < order.length) {
    const inn = order[up - 1];
    const out = order[up];
    if (pct(inn) === pct(out)) {
      const tied = order.filter((x) => pct(x) === pct(inn));
      const list = names(tied.map((x) => `${x.name} (Pool ${x.pool}, ${rec(x)})`));
      if (inn.pp20 !== out.pp20) {
        notes.push(`${ORD(place)} places ${list} have the same winning percentage. Points per 20 tossups heard decides who goes up: `
          + tied.map((x) => `${x.name} ${x.pp20.toFixed(2)}`).join(', ') + '.');
      } else {
        notes.push(`${ORD(place)} places ${list} have the same winning percentage and points per 20 tossups heard. Please decide who goes up, or play a tiebreaker game, before filling.`);
      }
    }
  }
  return { order: order.map((x) => x.name), notes };
}

/**
 * A tie within a pool that decides a spot, as filling would report it.
 * teams: [{name, pp20}] tied on record, best first by points per 20;
 * method: 'pp20' or 'game'. With points per 20 the fill goes ahead and
 * says so; with a tiebreaker game it waits for that game.
 */
export function poolTieNote(pool, record, teams, spot, method) {
  const list = names(teams.map((x) => x.name));
  if (method === 'game') {
    return { wait: true, text: `Pool ${pool}: ${list} are tied at ${record} for ${spot}. Please play a tiebreaker game in the tiebreaker round, then fill.` };
  }
  return { wait: false, text: `Pool ${pool}: ${list} are tied at ${record} for ${spot}. Points per 20 tossups heard decides: `
    + teams.map((x) => `${x.name} ${x.pp20.toFixed(2)}`).join(', ') + '.' };
}
