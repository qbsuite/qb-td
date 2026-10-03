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
  if (o.rooms !== 'keep') {
    schedule.phases.forEach((ph) => reassignRooms(ph, o.rooms, rng, schedule.rooms.length));
  }
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
    const k = Number(key.slice(5));
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
 * Re-seat a phase's games in rooms. mode:
 *   blocks  — each bracket gets a fixed block of rooms, in bracket order,
 *             and teams keep their room within it where they can
 *   shuffle — every round's games land in random rooms
 *   rotate  — each game goes to the free room its two teams have used
 *             least so far (teams see the rooms evenly, best effort)
 * Only rooms the phase needs are used (its busiest round's game count).
 */
function reassignRooms(phase, mode, rng, nRooms) {
  const need = Math.min(nRooms, Math.max(0, ...phase.rounds.map((r) => r.games.filter((g) => g.a || g.b).length)));
  if (!need) return;
  const tkey = (s) => (s ? s.team || s.label || '' : '');
  if (mode === 'blocks') {
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
    const prev = new Map();
    for (const r of phase.rounds) {
      const next = new Map();
      for (const b of order) {
        const games = r.games.filter((g) => (g.bracket || '') === b);
        const pairs = games.map((g) => [tkey(g.a), tkey(g.b)]);
        const local = new Map([...prev].filter(([, room]) => room >= start.get(b) && room < start.get(b) + size.get(b))
          .map(([t, room]) => [t, room - start.get(b)]));
        const got = assignRooms(pairs, size.get(b), local);
        games.forEach((g, i) => { g.room = start.get(b) + got[i]; pairs[i].forEach((t) => next.set(t, g.room)); });
      }
      prev.clear();
      for (const [t, room] of next) prev.set(t, room);
      r.games.sort((x, y) => x.room - y.room);
    }
    return;
  }
  const visits = new Map();
  const seen = (t, room) => ((visits.get(t) || new Map()).get(room) || 0);
  for (const r of phase.rounds) {
    const games = r.games.filter((g) => g.a || g.b);
    if (mode === 'shuffle') {
      const rooms = shuffled([...Array(need).keys()], rng);
      games.forEach((g, i) => { g.room = rooms[i % need]; });
    } else {
      const free = new Set([...Array(need).keys()]);
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
    }
    // placeholder rows with no teams (an inserted round) keep their rooms
    r.games.sort((x, y) => x.room - y.room);
  }
}

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
          g.bracket = add('F' + pa.n, ORD(pa.n) + ' place', p);
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
  const brs = bracketRooms(schedule).filter((b) => b.phase === p && (!only || only.includes(b.key)));
  const lanes = brs.filter((b) => b.rooms.length).map((b) => ({ key: b.key, name: b.name, rooms: b.rooms }));
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
      if (!empty) {
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

const PH_RE = /^([A-D])(\d+)$/;

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
 * Pool-by-pool finish order from overall standings. pools: {A: [names]}
 * (schedule.pools); rankedNames: team names best-first (aggregate()
 * standings order). Teams with no games yet keep their pool (seed) order,
 * after any ranked teams.
 */
export function poolStandings(pools, rankedNames) {
  const rank = new Map(rankedNames.map((n, i) => [n, i]));
  const out = {};
  for (const [letter, members] of Object.entries(pools || {})) {
    out[letter] = [...members].sort((x, y) =>
      (rank.has(x) ? rank.get(x) : Infinity) - (rank.has(y) ? rank.get(y) : Infinity));
  }
  return out;
}

/**
 * Replace playoff placeholder slots ("A1" = pool A's 1st) with real teams
 * from per-pool finish order ({A: [names best-first]}). Slots whose pool
 * or position is unknown stay placeholders. Returns how many were filled.
 */
export function fillPlaceholders(schedule, poolRanks) {
  let filled = 0;
  const resolve = (slot) => {
    if (!slot || !slot.label) return slot;
    const m = PH_RE.exec(slot.label);
    if (!m) return slot;
    const team = (poolRanks[m[1]] || [])[Number(m[2]) - 1];
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

/**
 * Renames implied by replacing one roster with another when nothing says
 * which team became which (an uploaded file). Teams are [{name, players}].
 * Only a team whose name left the roster can have been renamed, and only
 * to a name that wasn't on it. Such teams pair up by their players first
 * (a renamed team keeps most of them, so a rename survives a reseed and a
 * player or two changing), most shared first, needing at least half of
 * the smaller team; any left over pair by seed. Returns {old: new}.
 */
export function rosterRenames(oldTeams, newTeams) {
  const norm = (x) => String(x || '').trim().toLowerCase();
  const before = new Set(oldTeams.map((t) => t.name));
  const after = new Set(newTeams.map((t) => t.name));
  const gone = oldTeams.map((t, i) => ({ t, i })).filter((x) => !after.has(x.t.name));
  const fresh = newTeams.map((t, i) => ({ t, i })).filter((x) => !before.has(x.t.name));
  const players = (t) => new Set((t.players || []).map(norm).filter(Boolean));
  const pairs = [];
  for (const o of gone) {
    const op = players(o.t);
    for (const n of fresh) {
      const np = players(n.t);
      const shared = [...op].filter((x) => np.has(x)).length;
      if (shared && shared * 2 >= Math.min(op.size, np.size)) pairs.push({ o, n, shared });
    }
  }
  pairs.sort((x, y) => y.shared - x.shared || x.o.i - y.o.i);
  const out = {};
  const usedNew = new Set();
  for (const { o, n } of pairs) {
    if (o.t.name in out || usedNew.has(n.t.name)) continue;
    out[o.t.name] = n.t.name;
    usedNew.add(n.t.name);
  }
  for (const o of gone) {
    if (o.t.name in out) continue;
    const n = fresh.find((x) => x.i === o.i && !usedNew.has(x.t.name));
    if (!n) continue;
    out[o.t.name] = n.t.name;
    usedNew.add(n.t.name);
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
