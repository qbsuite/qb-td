// schedule.js — tournament schedule generation + editing. Clean-room
// pairings (circle-method round robin, cyclic Latin-square crossovers);
// the format catalog's team/room/round shapes follow common quizbowl
// practice (full/double RR, pool play into playoffs).
//
// Schedule shape (stored as t/<tid>/schedule.json, v1):
//   { v: 1,
//     rooms:  [{name, bucket}],            // bucket: D1 bucket id or null
//     phases: [{name, rounds: [{round, games: [{room, a, b}], byes: [slot]}]}],
//     pools:  {A: [team, ...], ...},       // pool formats only: membership
//     updated: <ms> }
// A slot is {team: "<exact roster name>"} for a real team, {label: "A1"}
// for a playoff placeholder ("A1" = pool A's 1st-place finisher), or null
// for an empty editor slot. Round numbers are global and sequential
// across phases (they are packet round numbers). `pools` records which
// teams the generator seeded into each pool, so placeholders can later
// be filled from standings (fillPlaceholders).

import { standingsOrder, levelOn, recordOf } from './stats.js';

function slotEq(a, b) {
  if (!a || !b) return false;
  return a.team ? a.team === b.team : !!a.label && a.label === b.label;
}
export function slotText(s) {
  return s ? (s.team || s.label || '') : '';
}

/* ---------- pairing math ---------- */

/**
 * Circle-method round robin for n teams (indices 0..n-1).
 * Returns rounds: [{pairs: [[i, j], ...], byes: [i, ...]}].
 * Even n: n-1 rounds, no byes. Odd n: n rounds, one bye per round,
 * each team exactly one bye.
 */
export function roundRobinRounds(n) {
  if (n < 2) return [];
  const ghost = n % 2 === 1 ? n : -1;
  const m = ghost === -1 ? n : n + 1;
  const seats = [];
  for (let i = 0; i < m; i++) seats.push(i);
  const rounds = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs = [];
    const byes = [];
    for (let i = 0; i < m / 2; i++) {
      const a = seats[i];
      const b = seats[m - 1 - i];
      if (a === ghost) byes.push(b);
      else if (b === ghost) byes.push(a);
      else pairs.push([a, b]);
    }
    rounds.push({ pairs, byes });
    // rotate all but seat 0
    seats.splice(1, 0, seats.pop());
  }
  return rounds;
}

/**
 * Cyclic Latin-square rounds where every member of group A meets every
 * member of group B exactly once (crossover play between two pools whose
 * intra-pool results carry over). Groups are index arrays into the team
 * list. max(|A|, |B|) rounds; unmatched teams get byes.
 */
export function crossRounds(groupA, groupB) {
  const r = Math.max(groupA.length, groupB.length);
  const rounds = [];
  for (let t = 0; t < r; t++) {
    const pairs = [];
    const byes = [];
    const used = new Set();
    for (let i = 0; i < r; i++) {
      const a = i < groupA.length ? groupA[i] : -1;
      const j = (i + t) % r;
      const b = j < groupB.length ? groupB[j] : -1;
      if (a !== -1 && b !== -1) { pairs.push([a, b]); used.add(b); }
      else if (a !== -1) byes.push(a);
    }
    for (const b of groupB) if (!used.has(b)) byes.push(b);
    rounds.push({ pairs, byes });
  }
  return rounds;
}

/** Split n into k near-even pool sizes, larger pools first. */
export function poolSizes(n, k) {
  const base = Math.floor(n / k);
  const extra = n % k;
  const sizes = [];
  for (let i = 0; i < k; i++) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

// Snake-seed indices 0..n-1 into pools of the given sizes (seed 1 → pool
// A, seed 2 → pool B, ..., then back), so roster order acts as seeding.
function snakePools(n, sizes) {
  const k = sizes.length;
  const pools = sizes.map(() => []);
  let seed = 0;
  for (let row = 0; seed < n; row++) {
    const seq = [...Array(k).keys()];
    if (row % 2 === 1) seq.reverse();
    for (const p of seq) {
      if (seed < n && pools[p].length < sizes[p]) pools[p].push(seed++);
    }
  }
  return pools;
}

/**
 * Assign a room index to each pair, preferring a room either team used
 * last round (teams keep their room across rounds when possible).
 * prevRoom: Map(teamIndexOrName -> room). Returns array of room indices.
 */
export function assignRooms(pairs, nRooms, prevRoom) {
  const taken = new Set();
  const out = new Array(pairs.length).fill(-1);
  const wants = (pair) => {
    const w = [];
    for (const t of pair) {
      const r = prevRoom ? prevRoom.get(t) : undefined;
      if (r !== undefined && r < nRooms) w.push(r);
    }
    return w;
  };
  for (let i = 0; i < pairs.length; i++) {
    for (const r of wants(pairs[i])) {
      if (!taken.has(r)) { out[i] = r; taken.add(r); break; }
    }
  }
  let next = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (out[i] !== -1) continue;
    while (taken.has(next)) next++;
    out[i] = next;
    taken.add(next);
  }
  return out;
}

/* ---------- format catalog ---------- */

const POOL_LETTERS = 'ABCD';

function rrPhase(name, teamRefs, nRooms, firstRound, slotFor) {
  // teamRefs: array of pool index-arrays played in parallel each round.
  const perPool = teamRefs.map((pool) => roundRobinRounds(pool.length));
  const nRounds = Math.max(...perPool.map((r) => r.length));
  const rounds = [];
  const prevRoom = new Map();
  for (let r = 0; r < nRounds; r++) {
    const pairs = [];
    const byes = [];
    perPool.forEach((poolRounds, p) => {
      const pr = r < poolRounds.length ? poolRounds[r] : null;
      if (!pr) {
        // shorter pool finished early: its teams sit out this round
        for (const t of teamRefs[p]) byes.push(t);
        return;
      }
      for (const [x, y] of pr.pairs) pairs.push([teamRefs[p][x], teamRefs[p][y]]);
      for (const x of pr.byes) byes.push(teamRefs[p][x]);
    });
    const roomOf = assignRooms(pairs, nRooms, prevRoom);
    prevRoom.clear();
    pairs.forEach((pair, i) => { for (const t of pair) prevRoom.set(t, roomOf[i]); });
    rounds.push({
      round: firstRound + r,
      games: pairs.map((pair, i) => ({ room: roomOf[i], a: slotFor(pair[0]), b: slotFor(pair[1]) }))
        .sort((g1, g2) => g1.room - g2.room),
      byes: byes.map(slotFor),
    });
  }
  return { name, rounds };
}

function crossPhase(name, groupA, groupB, nRooms, firstRound, slotFor) {
  const rr = crossRounds(groupA, groupB);
  const rounds = [];
  const prevRoom = new Map();
  rr.forEach((pr, r) => {
    const roomOf = assignRooms(pr.pairs, nRooms, prevRoom);
    prevRoom.clear();
    pr.pairs.forEach((pair, i) => { for (const t of pair) prevRoom.set(t, roomOf[i]); });
    rounds.push({
      round: firstRound + r,
      games: pr.pairs.map((pair, i) => ({ room: roomOf[i], a: slotFor(pair[0]), b: slotFor(pair[1]) }))
        .sort((g1, g2) => g1.room - g2.room),
      byes: pr.byes.map(slotFor),
    });
  });
  return { name, rounds };
}

/**
 * Playoff brackets of two finish positions per pool: [[{pool, pos}]],
 * best bracket first, each in finish order (A1 B1 C1 A2 B2 C2). A pool
 * too short for a position simply isn't in that bracket.
 */
function tierBrackets(sizes) {
  const out = [];
  const maxSize = Math.max(...sizes);
  for (let from = 0; from < maxSize; from += 2) {
    const members = [];
    for (let pos = from; pos < from + 2; pos++) {
      sizes.forEach((n, pool) => { if (n > pos) members.push({ pool, pos }); });
    }
    out.push(members);
  }
  return out;
}

/**
 * One bracket's rounds: [{pairs: [[i, j]], byes: [i]}] over indices into
 * `members`. A full bracket (two from each of the k pools) skips the
 * games between pool-mates — their prelim game carries over — by seating
 * every pool's pair opposite each other in the circle method's first
 * round and leaving that round out, so nobody ever sits. A short bracket
 * (a pool too small to fill its places) skips its pool-mates' games too,
 * in as few rounds as they fit (carryRounds).
 */
function tierRounds(members, k) {
  const rr = roundRobinRounds(members.length);
  const full = members.length === 2 * k
    && new Set(members.map((m) => m.pool)).size === k;
  if (!full) return carryRounds(members);
  // seat[circle index] = member index
  const seat = [];
  rr[0].pairs.forEach(([x, y], pool) => {
    const [first, second] = members.map((m, i) => [m, i]).filter(([m]) => m.pool === pool).map(([, i]) => i);
    seat[x] = first;
    seat[y] = second;
  });
  return rr.slice(1).map((r) => ({ pairs: r.pairs.map(([x, y]) => [seat[x], seat[y]]), byes: [] }));
}

/**
 * Every game between members of different pools, once each, in the
 * fewest rounds: a search that splits the games into rounds where no
 * team plays twice, from the lower bound up (brackets are at most 8
 * teams, so this is quick). Members not playing in a round have a bye.
 */
function carryRounds(members) {
  const n = members.length;
  const games = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (members[i].pool !== members[j].pool) games.push([i, j]);
  }
  if (!games.length) return [];
  const degree = (i) => games.filter((g) => g.includes(i)).length;
  const lower = Math.max(Math.ceil(games.length / Math.floor(n / 2)), ...members.map((_, i) => degree(i)));
  for (let R = lower; R <= games.length; R++) {
    const busy = [...Array(R)].map(() => new Set());
    const at = new Array(games.length);
    const place = (e) => {
      if (e === games.length) return true;
      const [x, y] = games[e];
      for (let r = 0; r < R; r++) {
        if (busy[r].has(x) || busy[r].has(y)) continue;
        busy[r].add(x); busy[r].add(y); at[e] = r;
        if (place(e + 1)) return true;
        busy[r].delete(x); busy[r].delete(y);
        // an empty round is like any other empty round: try just one
        if (!busy[r].size) break;
      }
      return false;
    };
    if (!place(0)) continue;
    return busy.map((_, r) => ({
      pairs: games.filter((_, e) => at[e] === r),
      byes: members.map((_, i) => i).filter((i) => !busy[r].has(i)),
    }));
  }
  return roundRobinRounds(n);
}

/**
 * Concrete formats available for a team count. Each entry:
 * {key, name, desc, rounds, roomsNeeded, teams}. Filter by your room
 * count with formatsFor(). build with buildSchedule().
 */
export function allFormats(nTeams) {
  const out = [];
  if (nTeams < 3) return out;
  const rrRounds = nTeams % 2 === 0 ? nTeams - 1 : nTeams;
  const rrRooms = Math.floor(nTeams / 2);
  if (nTeams <= 16) {
    out.push({
      key: 'rr', name: 'full round robin', teams: nTeams,
      rounds: rrRounds, roomsNeeded: rrRooms,
      desc: `${rrRounds} rounds, ${rrRooms} rooms` + (nTeams % 2 ? ', 1 bye per round' : ''),
    });
  }
  // repeated round robins for small fields (a 4-team, 2-room day is
  // classically a triple or quadruple RR)
  const REPEATS = [[2, 'double', 9], [3, 'triple', 6], [4, 'quadruple', 4]];
  for (const [k, word, cap] of REPEATS) {
    if (nTeams > cap) continue;
    out.push({
      key: 'rr' + k, name: word + ' round robin', teams: nTeams,
      rounds: rrRounds * k, roomsNeeded: rrRooms,
      desc: `${rrRounds * k} rounds, ${rrRooms} rooms` + (nTeams % 2 ? ', 1 bye per round' : ''),
    });
  }
  for (let k = 2; k <= 4; k++) {
    if (nTeams < k * 3 || nTeams > k * 9) continue;
    const sizes = poolSizes(nTeams, k);
    const prelim = Math.max(...sizes.map((s) => (s % 2 === 0 ? s - 1 : s)));
    const prelimRooms = sizes.reduce((n, s) => n + Math.floor(s / 2), 0);
    if (k === 2) {
      const top = sizes.map((s) => Math.ceil(s / 2));
      const bot = sizes.map((s, i) => s - top[i]);
      const playoff = Math.max(...top) > 0 ? Math.max(top[0], top[1]) : 0;
      const playRooms = Math.min(top[0], top[1]) + Math.min(bot[0], bot[1]);
      out.push({
        key: 'pools2', name: '2 pools, crossover playoffs', teams: nTeams,
        rounds: prelim + Math.max(playoff, Math.max(bot[0], bot[1])),
        roomsNeeded: Math.max(prelimRooms, playRooms),
        desc: `pools of ${sizes.join(' and ')}, then top ${top.join('+')} and bottom ` +
          `${bot.join('+')} cross over (prelim results carry)`,
      });
    } else {
      // playoff pools regroup by prelim finish position; same-position
      // teams come from different pools, so nothing repeats
      const maxSize = sizes[0];
      const posPools = [];
      for (let p = 0; p < maxSize; p++) posPools.push(sizes.filter((s) => s > p).length);
      const playoff = Math.max(...posPools.map((s) => (s % 2 === 0 ? s - 1 : s)));
      const playRooms = posPools.reduce((n, s) => n + Math.floor(s / 2), 0);
      out.push({
        key: 'pools' + k, name: `${k} pools, playoff pools by finish`, teams: nTeams,
        rounds: prelim + playoff, roomsNeeded: Math.max(prelimRooms, playRooms),
        desc: `pools of ${sizes.join('/')}, then teams regroup by finish position`,
      });
      // the same pools into bigger playoff brackets: two finish positions
      // from every pool (the top two of each, the next two, ...)
      const tiers = tierBrackets(sizes);
      if (tiers.length > 1 || tiers[0].length > k) {
        const tRounds = Math.max(...tiers.map((t) => tierRounds(t, k).length));
        const tRooms = tiers.reduce((n, t) => n + Math.floor(t.length / 2), 0);
        const tSizes = tiers.map((t) => t.length);
        const byes = tSizes.some((n) => n % 2) || new Set(tiers.map((t) => tierRounds(t, k).length)).size > 1;
        out.push({
          key: 'pools' + k + 'x2', name: `${k} pools, playoff brackets of ${2 * k}`, teams: nTeams,
          rounds: prelim + tRounds, roomsNeeded: Math.max(prelimRooms, tRooms),
          desc: `pools of ${sizes.join('/')}, then brackets of ${tSizes.join('/')} by finish, two places from each pool ` +
            `(prelim games between pool-mates carry over${byes ? '; a smaller last bracket has byes' : ''})`,
        });
      }
    }
  }
  return out;
}

export function formatsFor(nTeams, nRooms) {
  return allFormats(nTeams).filter((f) => f.roomsNeeded <= nRooms);
}

/**
 * Build a schedule. teams: exact roster names in seed order. rooms:
 * [{name, bucket}] (length >= the format's roomsNeeded).
 */
export function buildSchedule(key, teams, rooms, opts = {}) {
  const o = { seeding: 'snake', roundOrder: 'asis', rooms: 'keep', seed: 1, ...opts };
  const rng = mulberry32(Number(o.seed) || 1);
  // random seeding: the roster order stops mattering (pools and circle
  // positions both come from the shuffled order)
  if (o.seeding === 'random') teams = shuffled(teams, rng);
  const schedule = buildBase(key, teams, rooms);
  if (o.roundOrder === 'shuffle') {
    for (const ph of schedule.phases) ph.rounds = shuffled(ph.rounds, rng);
    renumber(schedule);
  }
  tagBrackets(schedule);
  schedule.phases.forEach((ph) => reassignRooms(ph, o.rooms, rng, schedule.rooms.length));
  schedule.brackets = bracketRooms(schedule, schedule.brackets);
  for (const ph of schedule.phases) ph.meet = 1;
  return schedule;
}

function buildBase(key, teams, rooms) {
  const fmt = allFormats(teams.length).find((f) => f.key === key);
  if (!fmt) throw new Error('No such format for ' + teams.length + ' teams');
  if (rooms.length < fmt.roomsNeeded) throw new Error('Needs ' + fmt.roomsNeeded + ' rooms');
  const teamSlot = (i) => ({ team: teams[i] });
  const phases = [];
  const all = teams.map((_, i) => i);
  let poolRecord = null; // pool formats record membership for fillPlaceholders
  let tierList = null;   // bracket list a format names itself

  const repeat = /^rr([234])$/.exec(key);
  if (key === 'rr') {
    phases.push(rrPhase('Round robin', [all], rooms.length, 1, teamSlot));
  } else if (repeat) {
    const k = Number(repeat[1]);
    let next = 1;
    for (let i = 0; i < k; i++) {
      const ph = rrPhase('Round robin ' + (i + 1), [all], rooms.length, next, teamSlot);
      next += ph.rounds.length;
      phases.push(ph);
    }
  } else {
    const km = /^pools([234])(x2)?$/.exec(key);
    const k = Number(km[1]);
    const sizes = poolSizes(teams.length, k);
    const pools = snakePools(teams.length, sizes);
    poolRecord = {};
    pools.forEach((idxs, p) => { poolRecord[POOL_LETTERS[p]] = idxs.map((i) => teams[i]); });
    const prelim = rrPhase('Prelims', pools, rooms.length, 1, teamSlot);
    const next = prelim.rounds.length + 1;
    // playoff slots are placeholders ("A1" = pool A's 1st place) the TD
    // fills in after prelims
    const ph = (pool, pos) => ({ label: POOL_LETTERS[pool] + (pos + 1) });
    if (k === 2) {
      const top = sizes.map((s) => Math.ceil(s / 2));
      const champA = [];
      const champB = [];
      const consA = [];
      const consB = [];
      for (let pos = 0; pos < sizes[0]; pos++) {
        if (pos < top[0]) champA.push(ph(0, pos)); else consA.push(ph(0, pos));
      }
      for (let pos = 0; pos < sizes[1]; pos++) {
        if (pos < top[1]) champB.push(ph(1, pos)); else consB.push(ph(1, pos));
      }
      // placeholder-slot phases pair slots, not team indices: build with
      // identity refs over a slot array
      const slots = [...champA, ...champB, ...consA, ...consB];
      const idx = (arr, base) => arr.map((_, i) => base + i);
      const champ = crossPhase('Playoffs', idx(champA, 0), idx(champB, champA.length),
        rooms.length, next, (i) => slots[i]);
      const cons = crossPhase('Consolation', idx(consA, champA.length + champB.length),
        idx(consB, champA.length + champB.length + consA.length),
        rooms.length, next, (i) => slots[i]);
      // merge consolation games into the playoff rounds (played in parallel)
      champ.rounds.forEach((r, i) => {
        const c = cons.rounds[i];
        if (!c) return;
        const used = new Set(r.games.map((g) => g.room));
        let free = 0;
        for (const g of c.games) {
          while (used.has(free)) free++;
          used.add(free);
          r.games.push({ room: free, a: g.a, b: g.b });
        }
        r.games.sort((g1, g2) => g1.room - g2.room);
        r.byes.push(...c.byes);
      });
      for (let i = champ.rounds.length; i < cons.rounds.length; i++) {
        cons.rounds[i].round = next + i;
        champ.rounds.push(cons.rounds[i]);
      }
      phases.push(prelim, champ);
    } else if (km[2]) {
      // brackets of two finish positions per pool, played side by side
      const tiers = tierBrackets(sizes);
      const perTier = tiers.map((t) => tierRounds(t, k));
      const nRounds = Math.max(...perTier.map((r) => r.length));
      const slot = (m) => ph(m.pool, m.pos);
      // named for the overall places a bracket decides: the teams in the
      // brackets above it come first
      const name = (t) => {
        const before = tiers.slice(0, tiers.indexOf(t)).reduce((n, x) => n + x.length, 0);
        const lo = before + 1;
        const hi = before + t.length;
        return lo === hi ? ORD(lo) + ' place' : ORD(lo) + '\u2013' + ORD(hi) + ' place';
      };
      const rounds = [];
      const prevRoom = new Map();
      for (let r = 0; r < nRounds; r++) {
        const pairs = [];
        const byes = [];
        perTier.forEach((tr, t) => {
          const pr = tr[r];
          // a shorter bracket has finished: its teams sit this round out
          if (!pr) { byes.push(...tiers[t].map(slot)); return; }
          for (const [x, y] of pr.pairs) pairs.push({ t, a: slot(tiers[t][x]), b: slot(tiers[t][y]) });
          byes.push(...pr.byes.map((x) => slot(tiers[t][x])));
        });
        const roomOf = assignRooms(pairs.map((g) => [g.a.label, g.b.label]), rooms.length, prevRoom);
        prevRoom.clear();
        pairs.forEach((g, i) => { prevRoom.set(g.a.label, roomOf[i]); prevRoom.set(g.b.label, roomOf[i]); });
        rounds.push({
          round: next + r,
          games: pairs.map((g, i) => ({ room: roomOf[i], a: g.a, b: g.b, bracket: 'T' + (g.t + 1) }))
            .sort((g1, g2) => g1.room - g2.room),
          byes,
        });
      }
      phases.push(prelim, { name: 'Playoffs', rounds });
      // tagBrackets reads a game across finish positions as a crossover
      // (Championship/Consolation), so these brackets are named here
      tierList = [
        ...pools.map((_, p) => ({ key: POOL_LETTERS[p], name: 'Pool ' + POOL_LETTERS[p], phase: 0 })),
        ...tiers.map((t, i) => ({ key: 'T' + (i + 1), name: name(t), phase: 1 })),
      ];
    } else {
      const maxSize = sizes[0];
      const slots = [];
      const posPools = [];
      for (let pos = 0; pos < maxSize; pos++) {
        const pool = [];
        for (let p = 0; p < k; p++) {
          if (sizes[p] > pos) { pool.push(slots.length); slots.push(ph(p, pos)); }
        }
        posPools.push(pool);
      }
      phases.push(prelim,
        rrPhase('Playoffs', posPools, rooms.length, next, (i) => slots[i]));
    }
  }
  return {
    v: 1,
    rooms: rooms.map((r) => ({ name: r.name, bucket: r.bucket ?? null })),
    phases,
    ...(poolRecord ? { pools: poolRecord } : {}),
    ...(tierList ? { brackets: tierList } : {}),
    updated: 0,
  };
}


/* ---------- generation options ---------- */

/** Seeded PRNG (mulberry32): the same seed always builds the same schedule. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Re-seat a phase's games in rooms. Each bracket (a pool, a playoff
 * bracket) gets a fixed block of rooms, in bracket order, and its games
 * stay in that block. Within a block, mode:
 *   keep    — teams keep their room where they can
 *   shuffle — every round's games land in random rooms
 *   rotate  — each game goes to the free room its two teams have used
 *             least so far (teams see the rooms evenly, best effort)
 * 'blocks' and 'blockrotate' are older names for keep and rotate. When
 * the blocks would need more rooms than there are, the phase is one block.
 */
function reassignRooms(phase, mode, rng, nRooms) {
  mode = ROOM_MODES[mode] || 'keep';
  const tkey = (s) => (s ? s.team || s.label || '' : '');
  const order = [];
  const size = new Map();
  for (const r of phase.rounds) {
    const per = new Map();
    for (const g of r.games) {
      const b = g.bracket || '';
      if (!order.includes(b)) order.push(b);
      per.set(b, (per.get(b) || 0) + 1);
    }
    for (const [b, n] of per) size.set(b, Math.max(size.get(b) || 0, n));
  }
  const start = new Map();
  let at = 0;
  for (const b of order) { start.set(b, at); at += size.get(b); }
  // too many rooms for blocks: one block of every room
  const blockOf = at <= nRooms ? (g) => g.bracket || '' : () => '';
  if (at > nRooms) {
    order.splice(0, order.length, '');
    start.set('', 0);
    size.set('', Math.max(0, ...phase.rounds.map((r) => r.games.length)));
  }
  const visits = new Map();
  const seen = (t, room) => ((visits.get(t) || new Map()).get(room) || 0);
  const prev = new Map();
  for (const r of phase.rounds) {
    const next = new Map();
    for (const b of order) {
      const games = r.games.filter((g) => blockOf(g) === b);
      const rooms = [...Array(size.get(b)).keys()].map((i) => start.get(b) + i);
      if (mode === 'shuffle') {
        const pick = shuffled(rooms, rng);
        games.forEach((g, i) => { g.room = pick[i]; });
      } else if (mode === 'rotate') {
        const free = new Set(rooms);
        for (const g of shuffled(games, rng)) {
          let best = -1;
          let score = Infinity;
          for (const room of [...free].sort((x, y) => x - y)) {
            const sc = seen(tkey(g.a), room) + seen(tkey(g.b), room);
            if (sc < score) { score = sc; best = room; }
          }
          g.room = best;
          free.delete(best);
          for (const t of [tkey(g.a), tkey(g.b)]) {
            if (!t) continue;
            if (!visits.has(t)) visits.set(t, new Map());
            visits.get(t).set(best, seen(t, best) + 1);
          }
        }
      } else {
        const pairs = games.map((g) => [tkey(g.a), tkey(g.b)]);
        const local = new Map([...prev].filter(([, room]) => room >= start.get(b) && room < start.get(b) + size.get(b))
          .map(([t, room]) => [t, room - start.get(b)]));
        const got = assignRooms(pairs, size.get(b), local);
        games.forEach((g, i) => { g.room = start.get(b) + got[i]; pairs[i].forEach((t) => next.set(t, g.room)); });
      }
    }
    prev.clear();
    for (const [t, room] of next) prev.set(t, room);
    r.games.sort((x, y) => x.room - y.room);
  }
}
const ROOM_MODES = { keep: 'keep', shuffle: 'shuffle', rotate: 'rotate', blocks: 'keep', blockrotate: 'rotate' };

/* ---------- brackets ---------- */

const ORD = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
  : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

/**
 * Which bracket each game belongs to, worked out from the schedule
 * itself: a prelim game whose two teams share a pool is that pool's; a
 * playoff game between placeholders is Championship/Consolation (both
 * sides in the top half of their pools, or not) when the phase crosses
 * finish positions, else that finish position's pool ("1st place"). Any
 * other phase is one bracket named after the phase. Writes g.bracket
 * where it's missing and returns the bracket list [{key, name, phase}].
 */
export function tagBrackets(schedule) {
  const pools = schedule.pools || {};
  const poolOf = new Map();
  for (const [letter, members] of Object.entries(pools)) for (const t of members) poolOf.set(t, letter);
  const size = (letter) => (pools[letter] || []).length;
  const pos = (s) => {
    const lab = s && (s.label || s.from);
    const m = lab ? PH_RE.exec(lab) : null;
    return m ? { pool: m[1], n: Number(m[2]) } : null;
  };
  const list = schedule.brackets ? schedule.brackets.map((b) => ({ ...b })) : [];
  const add = (key, name, phase) => {
    if (!list.some((b) => b.key === key)) list.push({ key, name, phase });
    return key;
  };
  schedule.phases.forEach((ph, p) => {
    const games = ph.rounds.flatMap((r) => r.games);
    const labeled = games.filter((g) => pos(g.a) && pos(g.b));
    const crossing = labeled.some((g) => pos(g.a).n !== pos(g.b).n);
    for (const g of games) {
      if (g.bracket) continue;
      const pa = pos(g.a);
      const pb = pos(g.b);
      if (pa && pb) {
        if (crossing) {
          const top = (x) => x.n <= Math.ceil(size(x.pool) / 2);
          g.bracket = top(pa) && top(pb) ? add('CH', 'Championship', p) : add('CO', 'Consolation', p);
        } else if (pa.n === pb.n) {
          // the nth of each pool play for the places after the teams placed
          // above them (pools of uneven size: only those big enough count)
          const at = (n) => Object.values(pools).filter((ms) => ms.length >= n).length || 2;
          let before = 0;
          for (let n = 1; n < pa.n; n++) before += at(n);
          const lo = before + 1;
          const hi = before + at(pa.n);
          g.bracket = add('F' + pa.n, lo === hi ? `${ORD(lo)} place` : `${ORD(lo)}\u2013${ORD(hi)} place`, p);
        }
        continue;
      }
      const la = g.a && g.a.team ? poolOf.get(g.a.team) : null;
      const lb = g.b && g.b.team ? poolOf.get(g.b.team) : null;
      if (la && la === lb && p === 0) { g.bracket = add(la, 'Pool ' + la, p); continue; }
      if (!Object.keys(pools).length && (g.a || g.b)) g.bracket = add('ph' + (p + 1), ph.name, p);
    }
  });
  // a pool phase whose games didn't all tag (edited across pools) and
  // any phase that tagged nothing still gets one bracket for its games
  schedule.phases.forEach((ph, p) => {
    if (list.some((b) => b.phase === p)) return;
    const key = add('ph' + (p + 1), ph.name, p);
    for (const r of ph.rounds) for (const g of r.games) if (!g.bracket && (g.a || g.b)) g.bracket = key;
  });
  schedule.brackets = list;
  return list;
}

/** Brackets with the rooms their games use most ({...b, rooms: [...]}) —
    each room goes to the bracket that plays in it most often in a phase. */
export function bracketRooms(schedule, brackets) {
  const out = (brackets || schedule.brackets || []).map((b) => ({ ...b, rooms: [] }));
  schedule.phases.forEach((ph, p) => {
    const count = new Map(); // room -> Map(bracket -> n)
    for (const r of ph.rounds) {
      for (const g of r.games) {
        if (!g.bracket || !(g.a || g.b)) continue;
        if (!count.has(g.room)) count.set(g.room, new Map());
        const m = count.get(g.room);
        m.set(g.bracket, (m.get(g.bracket) || 0) + 1);
      }
    }
    for (const [room, m] of count) {
      const best = [...m].sort((x, y) => y[1] - x[1])[0][0];
      const b = out.find((x) => x.key === best && x.phase === p);
      if (b) b.rooms.push(room);
    }
  });
  for (const b of out) b.rooms.sort((x, y) => x - y);
  return out;
}

/**
 * The editor's lanes for one phase: [{key, name, rooms}] in bracket
 * order, then "Other rooms" for rooms no bracket claims. Only brackets
 * in `only` (a key list) when given.
 */
export function phaseLanes(schedule, p, only) {
  // rooms that more than one bracket uses in this phase (rooms shared by
  // pools) gather in a "Shared rooms" lane; each game there says its bracket
  const use = new Map();
  for (const r of schedule.phases[p].rounds) {
    for (const g of r.games) {
      if (!g.bracket || !(g.a || g.b)) continue;
      if (!use.has(g.room)) use.set(g.room, new Set());
      use.get(g.room).add(g.bracket);
    }
  }
  const shared = [...use].filter(([, set]) => set.size > 1).map(([room]) => room).sort((x, y) => x - y);
  const brs = bracketRooms(schedule).filter((b) => b.phase === p && (!only || only.includes(b.key)));
  const lanes = brs.map((b) => ({ key: b.key, name: b.name, rooms: b.rooms.filter((i) => !shared.includes(i)) })).filter((l) => l.rooms.length);
  if (shared.length) lanes.push({ key: '', name: 'Shared rooms', rooms: shared, shared: true });
  if (!only) {
    const used = new Set(lanes.flatMap((l) => l.rooms));
    const other = schedule.rooms.map((_, i) => i).filter((i) => !used.has(i));
    if (other.length) lanes.push({ key: '', name: 'Other rooms', rooms: other });
  }
  return lanes;
}

/**
 * Problems for the editor's Checks list, most serious first:
 *   {sev: 0|1, kind, p, r, room?, key?, text}
 * kinds: twice (a team in two places in one round), missing (a team or
 * playoff slot of this phase with no game or bye this round), half (a
 * game with one side empty), again (a pair meeting more often than the
 * phase allows — phase.meet, default 1).
 */
export function scheduleChecks(schedule) {
  const out = [];
  schedule.phases.forEach((ph, p) => {
    const expected = new Set();
    for (const r of ph.rounds) {
      for (const g of r.games) for (const s of [g.a, g.b]) if (s) expected.add(slotText(s));
      for (const s of r.byes) if (s) expected.add(slotText(s));
    }
    const met = new Map();
    ph.rounds.forEach((r, ri) => {
      const where = new Map();
      const note = (t, room) => { if (!t) return; if (!where.has(t)) where.set(t, []); where.get(t).push(room); };
      for (const g of r.games) { note(slotText(g.a), g.room); note(slotText(g.b), g.room); }
      for (const s of r.byes) note(slotText(s), 'bye');
      for (const [t, rooms] of where) {
        if (rooms.length > 1) out.push({ sev: 0, kind: 'twice', p, r: ri, key: t, room: rooms.find((x) => x !== 'bye'), text: `Round ${r.round}: ${t} is in two places` });
      }
      const empty = r.games.every((g) => !g.a && !g.b) && !r.byes.length;
      // a tiebreaker round, finals and elimination (plan.js `kind`): most
      // slots wait on results, so a team without a game is how they work
      if (!empty && !ph.kind) {
        const missing = [...expected].filter((t) => !where.has(t));
        if (missing.length) {
          out.push({ sev: 0, kind: 'missing', p, r: ri, key: missing[0],
            text: `Round ${r.round}: ` + (missing.length > 2 ? `${missing.length} teams have` : missing.join(' and ') + (missing.length === 1 ? ' has' : ' have')) + ' no game' });
        }
      }
      for (const g of r.games) {
        if (!!g.a !== !!g.b) {
          const room = schedule.rooms[g.room] ? schedule.rooms[g.room].name : 'room ' + (g.room + 1);
          out.push({ sev: 1, kind: 'half', p, r: ri, room: g.room, text: `Round ${r.round}, ${room}: a game is missing a team` });
        }
        const a = slotText(g.a);
        const b = slotText(g.b);
        if (!a || !b) continue;
        const k = a < b ? a + '|' + b : b + '|' + a;
        met.set(k, [...(met.get(k) || []), { r: ri, room: g.room, round: r.round }]);
      }
    });
    const allowed = ph.meet || 1;
    for (const [k, seen] of met) {
      if (seen.length <= allowed) continue;
      const [a, b] = k.split('|');
      const last = seen[seen.length - 1];
      out.push({ sev: 1, kind: 'again', p, r: last.r, room: last.room,
        text: `${ph.name}: ${a} and ${b} meet ${seen.length} times` + (allowed > 1 ? ` (${allowed} planned)` : '') });
    }
  });
  return out.sort((x, y) => x.sev - y.sev);
}

/* ---------- editing ---------- */

// A slot ref: {p, r, g, side: 'a'|'b'} for a game slot, {p, r, bye: i}
// for a bye slot.
export function slotAt(schedule, ref) {
  const round = schedule.phases[ref.p].rounds[ref.r];
  return ref.bye !== undefined ? round.byes[ref.bye] : round.games[ref.g][ref.side];
}
export function setSlot(schedule, ref, slot) {
  const round = schedule.phases[ref.p].rounds[ref.r];
  if (ref.bye !== undefined) round.byes[ref.bye] = slot;
  else round.games[ref.g][ref.side] = slot;
}
export function swapSlots(schedule, ref1, ref2) {
  const s1 = slotAt(schedule, ref1);
  setSlot(schedule, ref1, slotAt(schedule, ref2));
  setSlot(schedule, ref2, s1);
}

/**
 * Move a game ({p, r, g} ref) to a room within its round. If another
 * game holds that room, the two games trade rooms (their teams move
 * with them). Same-round only: room numbers are per-round, so a
 * cross-round trade could stack two games in one room.
 */
export function moveGame(schedule, ref, roomIndex) {
  const round = schedule.phases[ref.p].rounds[ref.r];
  const game = round.games[ref.g];
  const other = round.games.find((g) => g !== game && g.room === roomIndex);
  if (other) other.room = game.room;
  game.room = roomIndex;
  round.games.sort((g1, g2) => g1.room - g2.room);
}

/** Renumber all rounds sequentially (1..N) across phases, in order. */
export function renumber(schedule) {
  let n = 1;
  for (const ph of schedule.phases) for (const r of ph.rounds) r.round = n++;
}

/** Append an empty round (null slots in every room) to a phase. */
export function addRound(schedule, phaseIndex) {
  const games = schedule.rooms.map((_, i) => ({ room: i, a: null, b: null }));
  schedule.phases[phaseIndex].rounds.push({ round: 0, games, byes: [] });
  renumber(schedule);
}
export function removeRound(schedule, phaseIndex, roundIndex) {
  schedule.phases[phaseIndex].rounds.splice(roundIndex, 1);
  renumber(schedule);
}

/** Insert an empty round after roundIndex within a phase (-1 inserts at
    the phase's start). Later rounds renumber. */
export function insertRound(schedule, phaseIndex, afterRoundIndex) {
  const games = schedule.rooms.map((_, i) => ({ room: i, a: null, b: null }));
  schedule.phases[phaseIndex].rounds.splice(afterRoundIndex + 1, 0,
    { round: 0, games, byes: [] });
  renumber(schedule);
}

/**
 * Swap the matches in two grid cells ({p, r, room} each), possibly in
 * different rounds or phases: whole games trade places, teams riding
 * along. A cell without a game receives the other cell's game (the move
 * case); two empty cells are a no-op.
 */
export function swapCells(schedule, c1, c2) {
  const round1 = schedule.phases[c1.p].rounds[c1.r];
  const round2 = schedule.phases[c2.p].rounds[c2.r];
  const g1 = round1.games.find((g) => g.room === c1.room);
  const g2 = round2.games.find((g) => g.room === c2.room);
  if (g1 === g2) return;
  const move = (game, from, to, toRoom) => {
    from.games.splice(from.games.indexOf(game), 1);
    game.room = toRoom;
    to.games.push(game);
  };
  if (g1 && g2) {
    move(g1, round1, round2, c2.room);
    move(g2, round2, round1, c1.room);
  } else if (g1) {
    move(g1, round1, round2, c2.room);
  } else if (g2) {
    move(g2, round2, round1, c1.room);
  }
  round1.games.sort((x, y) => x.room - y.room);
  if (round2 !== round1) round2.games.sort((x, y) => x.room - y.room);
}

/** Append a room column (empty in every round). */
export function addRoomCol(schedule, name) {
  schedule.rooms.push({ name, bucket: null });
}

/**
 * Remove a room column. Teams in that column's games drop to their
 * round's byes (nothing is lost); games in later columns shift left.
 */
export function removeRoomCol(schedule, roomIndex) {
  for (const ph of schedule.phases) {
    for (const round of ph.rounds) {
      const g = round.games.find((x) => x.room === roomIndex);
      if (g) {
        if (g.a) round.byes.push(g.a);
        if (g.b) round.byes.push(g.b);
        round.games.splice(round.games.indexOf(g), 1);
      }
      for (const x of round.games) if (x.room > roomIndex) x.room--;
    }
  }
  schedule.rooms.splice(roomIndex, 1);
}

/* ---------- playoff placeholders ---------- */

const PH_RE = /^([A-Z])(\d+)$/;
// a place compared across pools ("Better 4th place", "Other 4th place",
// "Best 2nd place", "3rd-best 2nd place"): plan.js makes these when a
// pool's edge cuts a place
const CMP_RE = /^(Better|Other|Best|(\d+)(?:st|nd|rd|th)-best) (\d+)(?:st|nd|rd|th) place$/;
const cmpIndex = (m) => (m[1] === 'Better' || m[1] === 'Best' ? 0 : m[1] === 'Other' ? 1 : Number(m[2]) - 1);

/** True when any slot in the schedule is still a placeholder. */
export function hasPlaceholders(schedule) {
  for (const ph of schedule.phases) {
    for (const round of ph.rounds) {
      for (const g of round.games) if ((g.a && g.a.label) || (g.b && g.b.label)) return true;
      if (round.byes.some((s) => s && s.label)) return true;
    }
  }
  return false;
}

/**
 * Pool-by-pool finish order: {A: [names best-first]}. pools: {A: [names]}
 * (schedule.pools); teams: standings rows (stats.js standings). Each pool
 * is ranked as its table on the public page ranks it (standingsOrder):
 * teams level on winning percentage and points per tossup keep their
 * pool (seed) order, and teams with no games yet come last, in that order.
 */
export function poolStandings(pools, teams) {
  const row = new Map(teams.map((t) => [t.name, t]));
  const out = {};
  for (const [letter, members] of Object.entries(pools || {})) {
    out[letter] = standingsOrder(members.map((n) => row.get(n) || { name: n, w: 0, l: 0, t: 0 })).map((t) => t.name);
  }
  return out;
}

/**
 * Replace playoff placeholder slots ("A1" = pool A's 1st) with real teams
 * from per-pool finish order ({A: [names best-first]}). Slots whose pool
 * or position is unknown stay placeholders. Returns how many were filled.
 */
/**
 * What the TD should know before filling playoff slots. agg is
 * stats.js standings()'s result (team rows with the public page's
 * figures, games). Returns
 *   ranks   — poolStandings, what fillPlaceholders takes
 *   missing — prelim games on the schedule with no game file:
 *             [{round, room, a, b}]
 *   extra   — prelim-round games uploaded that the schedule doesn't
 *             have (often the reason one is missing): [{round, a, b}]
 *   ties    — teams in a pool with the same winning percentage (the
 *             same record, at a pool's end) whose order sends them to
 *             different playoff brackets: [{pool, record, teams: [{name,
 *             pp20tuh, bracket}]}], in finish order
 */
// The rounds pools are ranked on: each phase before the first with a
// playoff slot (a double round robin's both cycles), less tiebreaker and
// finals phases, whose games aren't pool games.
export function prelimRounds(schedule) {
  const out = [];
  for (const ph of schedule.phases) {
    const open = ph.rounds.some((r) => r.games.some((g) => (g.a && g.a.label) || (g.b && g.b.label) || (g.a && g.a.from) || (g.b && g.b.from)));
    if (open) break;
    if (!ph.kind) out.push(...ph.rounds);
  }
  return out;
}

export function fillReport(schedule, agg) {
  const ranks = poolStandings(schedule.pools, agg.teams);
  const pair = (round, x, y) => round + '\n' + [x, y].sort().join('\n');
  const prelim = prelimRounds(schedule);
  const prelimSet = new Set(prelim.map((r) => r.round));
  const played = new Set(agg.games.map((g) => pair(g.round, g.teams[0].name, g.teams[1].name)));
  const scheduled = new Set();
  const missing = [];
  for (const r of prelim) {
    for (const g of r.games) {
      if (!g.a || !g.a.team || !g.b || !g.b.team) continue;
      scheduled.add(pair(r.round, g.a.team, g.b.team));
      if (!played.has(pair(r.round, g.a.team, g.b.team))) {
        missing.push({ round: r.round, room: schedule.rooms[g.room] ? schedule.rooms[g.room].name : 'Room ' + (g.room + 1), a: g.a.team, b: g.b.team });
      }
    }
  }
  const extra = agg.games.filter((g) => prelimSet.has(g.round) && !scheduled.has(pair(g.round, g.teams[0].name, g.teams[1].name)))
    .map((g) => ({ round: g.round, a: g.teams[0].name, b: g.teams[1].name }));
  // the bracket each placeholder plays in ("A3" -> "3rd–4th place")
  const tagged = JSON.parse(JSON.stringify(schedule));
  const names = new Map(tagBrackets(tagged).map((b) => [b.key + '@' + b.phase, b.name]));
  const bracketOf = new Map();
  tagged.phases.forEach((ph, p) => {
    for (const r of ph.rounds) {
      for (const g of r.games) {
        for (const x of [g.a, g.b]) {
          const lab = x && x.label;
          if (lab && g.bracket && !bracketOf.has(lab)) bracketOf.set(lab, names.get(g.bracket + '@' + p) || g.bracket);
        }
      }
    }
  });
  const row = new Map(agg.teams.map((x) => [x.name, x]));
  const ties = [];
  for (const [pool, list] of Object.entries(ranks)) {
    for (let i = 0; i < list.length;) {
      let j = i + 1;
      while (j < list.length && levelOn(row.get(list[j]), row.get(list[i]))) j++;
      if (j - i > 1) {
        const teams = list.slice(i, j).map((name, k) => ({ name, pp20tuh: row.get(name).pp20tuh, bracket: bracketOf.get(pool + (i + k + 1)) || null }));
        if (new Set(teams.map((x) => x.bracket)).size > 1) ties.push({ pool, record: recordOf(list.slice(i, j).map((n) => row.get(n))), teams });
      }
      i = j;
    }
  }
  // A place compared across pools: its teams by winning percentage, then
  // points per 20 tossups heard (the pools may differ in size), level
  // teams in pool order. A tie in winning percentage is listed with how
  // points per 20 broke it, or that it couldn't.
  const compared = [];
  const places = new Set();
  for (const ph of schedule.phases) for (const r of ph.rounds) {
    for (const x of [...r.games.flatMap((g) => [g.a, g.b]), ...r.byes]) {
      const c = x && x.label ? CMP_RE.exec(x.label) : null;
      if (c) places.add(Number(c[3]));
    }
  }
  const poolLists = Object.entries(ranks);
  for (const place of [...places].sort((a, b) => a - b)) {
    const teams = standingsOrder(poolLists.map(([pool, list]) => ({ pool, name: list[place - 1] }))
      .filter((x) => x.name && row.has(x.name)).map((x) => ({ ...x, ...row.get(x.name) })));
    ranks['#' + place] = teams.map((x) => x.name);
    for (let i = 0; i < teams.length;) {
      let j = i + 1;
      while (j < teams.length && levelOn(teams[j], teams[i])) j++;
      if (j - i > 1) compared.push({ place, teams: teams.slice(i, j).map((x) => ({ name: x.name, pool: x.pool, pp20tuh: x.pp20tuh,
        record: x.w + '–' + x.l + (x.t ? '–' + x.t : '') })) });
      i = j;
    }
  }
  return { ranks, missing, extra, ties, compared };
}

/**
 * The two teams a file row's summary names, or null. The Worker stores
 * the summary as JSON text; namedFiles hands it over as an object.
 */
export function summaryTeams(f) {
  let s = f.summary;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
  return s && Array.isArray(s.teams) && s.teams.length === 2 ? s.teams.map(String) : null;
}

/**
 * File rows with their summaries' teams under the roster's renames
 * (qbj.js rosterNameMap), for what pairs uploads with the saved schedule,
 * which a roster save renames (prelimProgress, finals.js finalsProgress).
 * A renamed row's summary keeps only its teams. The same rows when
 * nothing is renamed.
 */
export function namedFiles(files, names) {
  if (!names || !names.teams.size) return files;
  return files.map((f) => {
    const x = summaryTeams(f);
    return x ? { ...f, summary: { teams: x.map((n) => names.teams.get(n) || n) } } : f;
  });
}

/**
 * Which pools have all their prelim games in, from upload metadata alone
 * (each good upload's summary names its two teams), so the hub can tell
 * without fetching a game. files: the hub's file rows, their summaries
 * under the schedule's team names (namedFiles). Returns
 *   ready — pool letters with no prelim game left
 *   left  — {A: games still to come}
 *   files — the good prelim uploads of the ready pools' teams
 *   sig   — changes whenever a prelim upload does
 */
export function prelimProgress(schedule, files) {
  const prelim = prelimRounds(schedule);
  const rounds = new Set(prelim.map((r) => r.round));
  const pair = (round, x, y) => round + '\n' + [x, y].sort().join('\n');
  const mine = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error && rounds.has(f.round));
  const have = new Set(mine.map(summaryTeams).map((x, i) => x && pair(mine[i].round, x[0], x[1])).filter(Boolean));
  const poolOf = new Map(Object.entries(schedule.pools || {}).flatMap(([p, ms]) => ms.map((m) => [m, p])));
  const left = Object.fromEntries(Object.keys(schedule.pools || {}).map((p) => [p, 0]));
  for (const r of prelim) {
    for (const g of r.games) {
      if (!g.a || !g.a.team || !g.b || !g.b.team || have.has(pair(r.round, g.a.team, g.b.team))) continue;
      for (const p of new Set([poolOf.get(g.a.team), poolOf.get(g.b.team)])) if (p) left[p]++;
    }
  }
  const ready = Object.keys(left).filter((p) => !left[p]);
  const files2 = mine.filter((f) => { const x = summaryTeams(f); return x && x.some((n) => ready.includes(poolOf.get(n))); });
  return { ready, left, files: files2, sig: mine.map((f) => f.id).sort((x, y) => x - y).join(',') };
}

/**
 * Fill the playoff slots of pools whose prelims are done (ready, from
 * prelimProgress), on a copy. agg: stats.js standings() of those pools'
 * games. A pool waits for the TD when a prelim-round game of its teams isn't on
 * the schedule (`odd`), or, when ties wait for the TD, when a tie sends
 * teams to different brackets (`held`). Ties wait when opts.holdTies says
 * so, else when the schedule has a Tiebreakers phase. Places compared
 * across pools fill once all pools are done and nothing waits. force:
 * pool letters the TD said to fill anyway (ties by points per 20).
 * Returns {schedule, filled, pools, ties, held, odd}.
 */
export function autoFill(schedule, agg, ready, force = [], opts = {}) {
  const report = fillReport(schedule, agg);
  const ok = new Set(ready);
  const poolOf = new Map(Object.entries(schedule.pools || {}).flatMap(([p, ms]) => ms.map((m) => [m, p])));
  const odd = new Map();
  for (const g of report.extra) {
    for (const p of new Set([poolOf.get(g.a), poolOf.get(g.b)])) {
      if (p && ok.has(p) && !force.includes(p)) odd.set(p, [...(odd.get(p) || []), g]);
    }
  }
  const holdTies = opts.holdTies !== undefined ? opts.holdTies : schedule.phases.some((ph) => ph.kind === 'tiebreak');
  const held = holdTies ? report.ties.filter((x) => ok.has(x.pool) && !odd.has(x.pool) && !force.includes(x.pool)) : [];
  const ranks = {};
  for (const [k, list] of Object.entries(report.ranks)) {
    if (k[0] !== '#' && ok.has(k) && !odd.has(k)) ranks[k] = list.slice();
  }
  for (const x of held) for (const tm of x.teams) ranks[x.pool][ranks[x.pool].indexOf(tm.name)] = undefined;
  const all = Object.keys(schedule.pools || {}).every((p) => ok.has(p));
  if (all && !odd.size && !held.length) {
    for (const [k, list] of Object.entries(report.ranks)) if (k[0] === '#') ranks[k] = list;
  }
  const copy = JSON.parse(JSON.stringify(schedule));
  const open = (s) => {
    const out = new Set();
    for (const ph of s.phases) for (const r of ph.rounds) {
      for (const x of [...r.games.flatMap((g) => [g.a, g.b]), ...r.byes]) {
        const m = x && x.label ? PH_RE.exec(x.label) : null;
        if (m) out.add(m[1]);
      }
    }
    return out;
  };
  const before = open(copy);
  const filled = fillPlaceholders(copy, ranks);
  const after = open(copy);
  // the pools this fill moved, for the TD's note
  const pools = [...before].filter((k) => ranks[k] && ranks[k].some(Boolean) && !after.has(k)).sort();
  const ties = report.ties.filter((x) => ranks[x.pool] && !held.includes(x));
  return { schedule: copy, filled, pools, ties, held, odd: [...odd.entries()].map(([pool, games]) => ({ pool, games })) };
}

export function fillPlaceholders(schedule, poolRanks) {
  let filled = 0;
  const resolve = (slot) => {
    if (!slot || !slot.label) return slot;
    const c = CMP_RE.exec(slot.label);
    const m = c ? null : PH_RE.exec(slot.label);
    if (!m && !c) return slot;
    // a compared place reads its order from poolRanks['#4'] (fillReport)
    const team = c ? (poolRanks['#' + c[3]] || [])[cmpIndex(c)] : (poolRanks[m[1]] || [])[Number(m[2]) - 1];
    if (!team) return slot;
    filled++;
    // `from` keeps the slot it filled, so pages can say "Stanford (A1)"
    // and bracket tagging still reads a filled playoff game
    return { team, from: slot.label };
  };
  for (const ph of schedule.phases) {
    for (const round of ph.rounds) {
      for (const g of round.games) {
        g.a = resolve(g.a);
        g.b = resolve(g.b);
      }
      round.byes = round.byes.map(resolve);
    }
  }
  return filled;
}

/**
 * Follow roster renames ({old: new}) through a schedule, in place: every
 * game and bye slot and the pool lists. Names swap all at once, so two
 * teams trading names works. Returns how many names changed.
 */
export function renameTeams(schedule, renames) {
  let n = 0;
  const has = (x) => Object.prototype.hasOwnProperty.call(renames, x);
  const slot = (s) => {
    if (!s || !s.team || !has(s.team)) return s;
    n++;
    return { ...s, team: renames[s.team] };
  };
  for (const ph of schedule.phases || []) {
    for (const round of ph.rounds || []) {
      for (const g of round.games || []) {
        g.a = slot(g.a);
        g.b = slot(g.b);
      }
      round.byes = (round.byes || []).map(slot);
    }
  }
  for (const k of Object.keys(schedule.pools || {})) {
    schedule.pools[k] = schedule.pools[k].map((x) => (has(x) ? (n++, renames[x]) : x));
  }
  return n;
}

/**
 * Take a team out of a schedule, in place: its game slots go empty (the
 * editor shows them as open slots to fill), its byes and its pool place
 * go. Returns how many places it was in.
 */
export function removeTeam(schedule, team) {
  let n = 0;
  const slot = (s) => (s && s.team === team ? (n++, null) : s);
  for (const ph of schedule.phases || []) {
    for (const round of ph.rounds || []) {
      for (const g of round.games || []) {
        g.a = slot(g.a);
        g.b = slot(g.b);
      }
      const byes = round.byes || [];
      round.byes = byes.filter((x) => !(x && x.team === team));
      n += byes.length - round.byes.length;
    }
  }
  for (const k of Object.keys(schedule.pools || {})) {
    const before = schedule.pools[k].length;
    schedule.pools[k] = schedule.pools[k].filter((x) => x !== team);
    n += before - schedule.pools[k].length;
  }
  return n;
}

/* ---------- pool trades ---------- */

// Pool play is the first phase of a pool format: the phase tagBrackets
// files under the pools, and the one `pools` records membership for.

/** The pool a team was seeded into ("A"), or null. */
export function poolOf(schedule, team) {
  for (const [k, members] of Object.entries(schedule.pools || {})) if (members.includes(team)) return k;
  return null;
}

/** Whether pool trades are closed: a prelim game has come in.
    playedRounds: round numbers with at least one game uploaded. */
export function tradesLocked(schedule, playedRounds) {
  const prelims = (schedule.phases || [])[0];
  if (!prelims || !Object.keys(schedule.pools || {}).length) return true;
  return prelims.rounds.some((r) => playedRounds.has(r.round));
}

/**
 * Trade two teams from different pools, in place: each takes the other's
 * place in every prelim round (opponents, rooms, byes) and in the pool
 * lists. Pool sizes stay the same, so every round robin stays whole, and
 * playoff slots ("A1") are untouched. Returns false (and changes nothing)
 * unless both teams are in pools, and different ones.
 */
export function tradePools(schedule, x, y) {
  const px = poolOf(schedule, x);
  const py = poolOf(schedule, y);
  if (!px || !py || px === py) return false;
  const other = (s) => (s && s.team === x ? { ...s, team: y } : s && s.team === y ? { ...s, team: x } : s);
  for (const round of (schedule.phases[0] || { rounds: [] }).rounds) {
    for (const g of round.games) {
      g.a = other(g.a);
      g.b = other(g.b);
    }
    round.byes = round.byes.map(other);
  }
  schedule.pools[px] = schedule.pools[px].map((t) => (t === x ? y : t));
  schedule.pools[py] = schedule.pools[py].map((t) => (t === y ? x : t));
  return true;
}

/**
 * Renames implied by replacing one roster with another when nothing says
 * which team became which (an uploaded file). Teams are [{name, players}].
 * Only a team whose name left the roster can have been renamed, and only
 * to a name that wasn't on it. Such teams pair up by their players (a
 * renamed team keeps most of them, so a rename survives a reseed and a
 * player or two changing), most shared first, needing at least half of
 * the smaller team. Position alone pairs nothing: a new team in a dropped
 * team's row is a new team, and the dropped team's games stay its own.
 * Returns {old: new}.
 */
export function rosterRenames(oldTeams, newTeams) {
  const norm = (x) => String(x || '').trim().toLowerCase();
  const before = new Set(oldTeams.map((t) => t.name));
  const after = new Set(newTeams.map((t) => t.name));
  const gone = oldTeams.filter((t) => !after.has(t.name));
  const fresh = newTeams.filter((t) => !before.has(t.name));
  const players = (t) => new Set((t.players || []).map(norm).filter(Boolean));
  const pairs = [];
  for (const o of gone) {
    const op = players(o);
    for (const n of fresh) {
      const np = players(n);
      const shared = [...op].filter((x) => np.has(x)).length;
      if (shared && shared * 2 >= Math.min(op.size, np.size)) pairs.push({ o, n, shared });
    }
  }
  // most shared first; the sort is stable, so equal counts keep roster order
  pairs.sort((x, y) => y.shared - x.shared);
  const out = {};
  const usedNew = new Set();
  for (const { o, n } of pairs) {
    if (o.name in out || usedNew.has(n.name)) continue;
    out[o.name] = n.name;
    usedNew.add(n.name);
  }
  return out;
}

/**
 * Warnings for the editor: unknown team names, a team playing twice in
 * one round, repeat matchups within a phase. Placeholders and empty
 * slots are legal (they're visible in the grid) and not flagged.
 */
export function validateSchedule(schedule, rosterNames) {
  const warnings = [];
  const known = new Set(rosterNames || []);
  const seenUnknown = new Set();
  for (const ph of schedule.phases) {
    const met = new Set();
    for (const round of ph.rounds) {
      const inRound = new Set();
      const slots = [];
      for (const g of round.games) slots.push(g.a, g.b);
      slots.push(...round.byes);
      for (const s of slots) {
        if (!s) continue;
        if (s.team && rosterNames && !known.has(s.team) && !seenUnknown.has(s.team)) {
          seenUnknown.add(s.team);
          warnings.push('not on roster: ' + s.team);
        }
        const t = slotText(s);
        if (!t) continue;
        if (inRound.has(t)) warnings.push('round ' + round.round + ': ' + t + ' twice');
        inRound.add(t);
      }
      for (const g of round.games) {
        const a = slotText(g.a);
        const b = slotText(g.b);
        if (!a || !b) continue;
        const pairKey = JSON.stringify(a < b ? [a, b] : [b, a]);
        if (met.has(pairKey)) warnings.push('round ' + round.round + ': ' + a + ' v ' + b + ' again');
        met.add(pairKey);
      }
      // two games in one room hide each other in the grid
      const roomsUsed = new Set();
      for (const g of round.games) {
        if (roomsUsed.has(g.room)) {
          const name = schedule.rooms[g.room] ? schedule.rooms[g.room].name : 'room ' + (g.room + 1);
          warnings.push('round ' + round.round + ': two games in ' + name);
        }
        roomsUsed.add(g.room);
      }
    }
  }
  return warnings;
}

/* ---------- lookups (public page, reader) ---------- */

export function roomIndexForBucket(schedule, bucketId) {
  const i = schedule.rooms.findIndex((r) => r.bucket === bucketId);
  return i === -1 ? null : i;
}

/** All rounds for one room: [{round, a, b}] with slot objects. */
export function roomRounds(schedule, roomIndex) {
  const out = [];
  for (const ph of schedule.phases) {
    for (const round of ph.rounds) {
      const g = round.games.find((x) => x.room === roomIndex);
      if (g) out.push({ round: round.round, a: g.a, b: g.b });
    }
  }
  return out;
}

/**
 * The game scheduled in a room for a round, as real team names —
 * {a, b} — or null when there's no game there or either slot is a
 * placeholder/empty (nothing to preselect).
 */
export function gameForRoom(schedule, roomIndex, roundNumber) {
  for (const ph of schedule.phases) {
    for (const round of ph.rounds) {
      if (round.round !== roundNumber) continue;
      const g = round.games.find((x) => x.room === roomIndex);
      if (g && g.a && g.a.team && g.b && g.b.team) return { a: g.a.team, b: g.b.team };
      return null;
    }
  }
  return null;
}

/** All schedule rounds flattened: [{round, phase, games, byes}]. */
export function flatRounds(schedule) {
  const out = [];
  schedule.phases.forEach((ph) => {
    for (const round of ph.rounds) out.push({ ...round, phase: ph.name });
  });
  return out;
}

/**
 * Round intake for the dashboard: games in vs expected for a round,
 * naming the rooms still out. Expected = scheduled games with both
 * slots filled; without a schedule (or a round it doesn't cover), one
 * game per bucket room. buckets: [{id, room_name}]; files:
 * [{round, bucket_id, kind, error}] — only clean qbj/combined count.
 */
/**
 * Which rooms play a round, for the Live Hub's auto-advance chips:
 * [{id, name, bye}] over every bucket. The schedule's games are resolved
 * to buckets the way the Worker does it (worker.js roomsPlaying — bucket
 * link, then room name); a room with no game that round is a bye. Without
 * the round in the schedule, every room plays.
 */
export function roundRooms(schedule, roundNumber, buckets) {
  const round = schedule ? flatRounds(schedule).find((r) => r.round === roundNumber) : null;
  if (!round) return buckets.map((b) => ({ id: b.id, name: b.room_name, bye: false }));
  const norm = (x) => String(x || '').trim().toLowerCase();
  const playing = new Set();
  for (const g of round.games.filter((x) => x.a && x.b)) {
    const room = schedule.rooms[g.room] || {};
    const b = buckets.find((x) => x.id === room.bucket)
      || buckets.find((x) => norm(x.room_name) === norm(room.name));
    if (b) playing.add(b.id);
  }
  return buckets.map((b) => ({ id: b.id, name: b.room_name, bye: !playing.has(b.id) }));
}

export function roundIntake(schedule, roundNumber, buckets, files) {
  const inRooms = new Set(files
    .filter((f) => f.round === roundNumber
      && (f.kind === 'qbj' || f.kind === 'combined') && !f.error)
    .map((f) => f.bucket_id));
  let expected = buckets.length;
  let missing = buckets.filter((b) => !inRooms.has(b.id)).map((b) => b.room_name);
  const round = schedule
    ? flatRounds(schedule).find((r) => r.round === roundNumber) : null;
  if (round) {
    const games = round.games.filter((g) => g.a && g.b);
    expected = games.length;
    missing = games.map((g) => {
      const room = schedule.rooms[g.room] || {};
      const b = buckets.find((x) => x.id === room.bucket);
      if (b) return inRooms.has(b.id) ? null : b.room_name;
      // unlinked room: its uploads can't be matched, name it regardless
      return room.name || 'room ' + (g.room + 1);
    }).filter(Boolean);
  }
  if (inRooms.size >= expected) missing = [];
  return { got: inRooms.size, expected, missing };
}

/* ---------- finished ---------- */

// The games played, by round and team pair: {round|a|b (sorted) -> winner}
// (a tie has no winner). `matches` are parsed games (qbj.js parseMatch);
// a later upload of the same game replaces an earlier one.
export function playedMap(matches) {
  const out = new Map();
  for (const m of matches || []) {
    const [a, b] = m.teams || [];
    if (!a || !b) continue;
    let win = null;
    if (m.forfeit) win = a.forfeitLoss ? (b.forfeitLoss ? null : b.name) : a.name;
    else if (a.points !== b.points) win = a.points > b.points ? a.name : b.name;
    out.set(m.round + '|' + [a.name, b.name].sort().join('|'), { win });
  }
  return out;
}
export const teamOf = (s) => (s && typeof s.team === 'string' ? s.team : null);
export const gameKey = (round, g) => round + '|' + [teamOf(g.a), teamOf(g.b)].sort().join('|');

/**
 * Whether a round's games are all in: each game between two known teams
 * has a result, and no game still waits for a team (a placeholder).
 * "If needed" games and tiebreakers never hold a round open.
 */
function roundIn(round, phase, played) {
  return round.games.every((g) => {
    if (g.ifNeeded || phase.kind === 'tiebreak') return true;
    if (!g.a && !g.b) return true;
    if (!teamOf(g.a) || !teamOf(g.b)) return false;
    return played.has(gameKey(round.round, g));
  });
}

/**
 * The last round of an unbroken run of finished rounds from the first:
 * the stats a TD can compile without a half-played round. 0 when the
 * first round isn't finished; rounds with no games are skipped over.
 */
export function finishedThrough(schedule, matches) {
  if (!schedule || !Array.isArray(schedule.phases)) return 0;
  const played = playedMap(matches);
  const rounds = schedule.phases.flatMap((ph) => ph.rounds.map((r) => ({ r, ph })))
    .filter(({ r }) => r.games.length).sort((x, y) => x.r.round - y.r.round);
  let last = 0;
  for (const { r, ph } of rounds) {
    if (!roundIn(r, ph, played)) break;
    last = r.round;
  }
  // a final or tiebreaker nobody played (not needed, or not yet) doesn't
  // stretch the run: it ends at the last round with a game in
  const playedRounds = [...played.keys()].map((k) => Number(k.split('|')[0])).filter((n) => n <= last);
  return playedRounds.length ? Math.max(...playedRounds) : 0;
}
