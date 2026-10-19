// finals.js — Finals slots that fill themselves.
//
// A finals game's slots name a place in an earlier bracket ("1st in
// 1st–6th place", "2nd in Pool A": plan.js addFinals, or the editor's Add
// phase). Once every game that bracket was scheduled to play is in, its
// standings decide the places, the way the pools decide the playoff slots
// (schedule.js autoFill): net wins, then points per 20 tossups heard, from
// the bracket's own games plus the games its pool-mates carry over from the
// stage before — the same carryover the YellowFruit 4 file sets up
// (yft.js yfStages). Ties are settled by points per 20 and noted, or wait
// for the TD when the schedule has a Tiebreakers phase.

import { aggregate, dedupeMatches } from './stats.js';
import { playedMap, teamOf, gameKey, summaryTeams } from './schedule.js';

const FIN_RE = /^(\d+)(?:st|nd|rd|th) in (.+)$/;
const MINOR = new Set(['tiebreak', 'final']);
const nameOf = (x) => (x && typeof x.team === 'string' && x.team ? x.team : null);
const pairKey = (round, x, y) => round + '\n' + [x, y].sort().join('\n');
const key2 = (x, y) => [x, y].sort().join('\n');

// The teams of bracket `key` in phase p, and the games it was scheduled.
// The prelim pools ("Pool A" as bracket A) are the pools' own games.
function bracketGames(schedule, p, key) {
  const ph = schedule.phases[p];
  const games = [];
  const teams = new Set();
  let open = false;
  for (const r of ph.rounds || []) {
    for (const g of r.games || []) {
      if (g.bracket !== key) continue;
      const a = nameOf(g.a), b = nameOf(g.b);
      if (!a || !b) { open = true; continue; }
      games.push({ round: r.round, a, b });
      teams.add(a); teams.add(b);
    }
    for (const s of r.byes || []) if (s && s.label) open = true;
  }
  return { games, teams: [...teams], open };
}

// Groups of the nearest full stage before phase p: the pools, or that
// phase's brackets. [{teams: [...]}]
function groupsBefore(schedule, p) {
  for (let q = p - 1; q >= 0; q--) {
    const ph = schedule.phases[q];
    if (MINOR.has(ph.kind)) continue;
    const by = new Map();
    for (const r of ph.rounds || []) for (const g of r.games || []) {
      if (!g.bracket) continue;
      for (const t of [nameOf(g.a), nameOf(g.b)]) {
        if (!t) continue;
        if (!by.has(g.bracket)) by.set(g.bracket, new Set());
        by.get(g.bracket).add(t);
      }
    }
    return { phase: q, groups: [...by.values()].map((s) => [...s]) };
  }
  return null;
}

/**
 * Every finals source: the bracket each "Nth in <name>" slot reads.
 * Returns [{name, phase, key, places: [n…], teams, games, open, carry,
 *   carried: [{a, b}] (pool-mate pairs whose earlier games count),
 *   prevRounds: [round…]}]
 */
export function finalsSources(schedule) {
  if (!schedule || !Array.isArray(schedule.phases)) return [];
  const brackets = schedule.brackets || [];
  const out = new Map();
  schedule.phases.forEach((ph, fp) => {
    for (const r of ph.rounds || []) {
      for (const s of [...(r.games || []).flatMap((g) => [g.a, g.b]), ...(r.byes || [])]) {
        const m = s && s.label ? FIN_RE.exec(s.label) : null;
        if (!m) continue;
        // the latest bracket of that name before the finals
        const b = brackets.filter((x) => x.name === m[2] && x.phase < fp).sort((x, y) => y.phase - x.phase)[0];
        if (!b) continue;
        if (!out.has(m[2])) out.set(m[2], { name: m[2], phase: b.phase, key: b.key, places: new Set() });
        out.get(m[2]).places.add(Number(m[1]));
      }
    }
  });
  return [...out.values()].map((src) => {
    const { games, teams, open } = bracketGames(schedule, src.phase, src.key);
    // carryover: pool-mates of the stage before whose pair this bracket
    // doesn't play again (the YellowFruit rule, yft.js yfStages)
    const prev = groupsBefore(schedule, src.phase);
    const here = new Set(games.map((g) => key2(g.a, g.b)));
    const mates = [];
    if (prev && !['single', 'double'].includes(schedule.phases[src.phase].kind)) {
      for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
        if (prev.groups.some((gr) => gr.includes(teams[i]) && gr.includes(teams[j]))) mates.push({ a: teams[i], b: teams[j] });
      }
    }
    const carry = mates.some((x) => !here.has(key2(x.a, x.b)));
    const prevRounds = prev && carry ? (schedule.phases[prev.phase].rounds || []).map((r) => r.round) : [];
    return { ...src, places: [...src.places].sort((x, y) => x - y), teams, games, open, carry,
      carried: carry ? mates : [], prevRounds };
  });
}

/**
 * Which finals sources have every game in, from upload metadata alone
 * (each good upload's summary names its two teams), as prelimProgress
 * does for pools. files: the hub's file rows, their summaries under the
 * schedule's team names (protests.js namedFiles). Returns
 *   ready — source bracket names with nothing left to play
 *   files — the uploads their standings are made from
 *   sig   — changes whenever one of those uploads does
 */
export function finalsProgress(schedule, files) {
  const good = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error && Number.isInteger(f.round));
  const have = new Set(good.map((f) => { const x = summaryTeams(f); return x && pairKey(f.round, x[0], x[1]); }).filter(Boolean));
  const ready = [];
  const need = new Set();
  for (const src of finalsSources(schedule)) {
    if (src.open || !src.games.length || !src.games.every((g) => have.has(pairKey(g.round, g.a, g.b)))) continue;
    ready.push(src.name);
    const rounds = new Set([...src.games.map((g) => g.round), ...src.prevRounds]);
    const members = new Set(src.teams);
    for (const f of good) {
      const x = summaryTeams(f);
      if (x && rounds.has(f.round) && members.has(x[0]) && members.has(x[1])) need.add(f);
    }
  }
  const mine = [...need];
  return { ready, files: mine, sig: ready.join('\n') + '|' + mine.map((f) => f.id).sort((x, y) => x - y).join(',') };
}

/**
 * Fill the finals slots whose source bracket is done, on a copy.
 * matches: parsed games (parseMatch), at least those finalsProgress named.
 * ready: source names from finalsProgress. force: names the TD said to
 * fill anyway (ties by points per 20). opts.holdTies as in autoFill.
 * Returns {schedule, filled, brackets, ties, held}:
 *   ties — [{bracket, record, teams: [{name, pp20tuh, place}]}], a tie
 *          that reaches a finals place, settled by points per 20
 *   held — the same, waiting for the TD
 */
export function finalsFill(schedule, matches, ready, force = [], opts = {}) {
  const copy = JSON.parse(JSON.stringify(schedule));
  const holdTies = opts.holdTies !== undefined ? opts.holdTies : schedule.phases.some((ph) => ph.kind === 'tiebreak');
  const all = dedupeMatches(matches);
  const order = {};
  const ties = [];
  const held = [];
  for (const src of finalsSources(schedule)) {
    if (!ready.includes(src.name)) continue;
    const members = new Set(src.teams);
    const inBracket = new Set(src.games.map((g) => g.round));
    const carried = new Set(src.carried.map((x) => key2(x.a, x.b)));
    const prev = new Set(src.prevRounds);
    const games = all.filter((m) => {
      const [a, b] = m.teams.map((t) => t.name);
      if (!members.has(a) || !members.has(b)) return false;
      return inBracket.has(m.round) || (prev.has(m.round) && carried.has(key2(a, b)));
    });
    // every scheduled game must be among them (a wrong team name waits)
    const got = new Set(games.map((m) => pairKey(m.round, m.teams[0].name, m.teams[1].name)));
    if (!src.games.every((g) => got.has(pairKey(g.round, g.a, g.b)))) continue;
    const rows = aggregate(games).teams.filter((t) => members.has(t.name));
    const rec = (t) => t.w + '–' + t.l + (t.t ? '–' + t.t : '');
    const deepest = Math.max(...src.places);
    let hold = false;
    for (let i = 0; i < rows.length && i < deepest;) {
      let j = i + 1;
      while (j < rows.length && rec(rows[j]) === rec(rows[i])) j++;
      // a tie reaching a finals place: the order decides who plays, or who
      // is the leader
      if (j - i > 1) {
        const x = { bracket: src.name, record: rec(rows[i]),
          teams: rows.slice(i, j).map((t, k) => ({ name: t.name, pp20tuh: t.pp20tuh, place: i + k + 1 })) };
        if (holdTies && !force.includes(src.name)) { held.push(x); hold = true; } else ties.push(x);
      }
      i = j;
    }
    if (!hold) order[src.name] = rows.map((t) => t.name);
  }
  let filled = 0;
  const done = new Set();
  const resolve = (slot) => {
    const m = slot && slot.label ? FIN_RE.exec(slot.label) : null;
    const team = m && order[m[2]] ? order[m[2]][Number(m[1]) - 1] : null;
    if (!team) return slot;
    filled++;
    done.add(m[2]);
    return { team, from: slot.label };
  };
  for (const ph of copy.phases) {
    for (const r of ph.rounds) {
      for (const g of r.games) { g.a = resolve(g.a); g.b = resolve(g.b); }
      r.byes = (r.byes || []).map(resolve);
    }
  }
  return { schedule: copy, filled, brackets: [...done], ties: ties.filter((x) => done.has(x.bracket)), held };
}

/** True when the schedule has a finals slot still to fill. */
export function hasFinalsSlots(schedule) {
  return finalsSources(schedule).length > 0;
}

/**
 * True when the tournament is over: every scheduled game between known
 * teams is in, no playoff slot waits for a team, and each "if needed"
 * game was played or turned out not to be needed — a final the leader
 * is two wins clear of, a second final the leader won the first of, a
 * double elimination reset the unbeaten team won. Tiebreakers never
 * hold it open.
 */
export function scheduleFinished(schedule, matches) {
  if (!schedule || !Array.isArray(schedule.phases) || !schedule.phases.length) return false;
  const played = playedMap(matches);
  if (!played.size) return false;
  const all = schedule.phases.flatMap((ph) => ph.rounds.map((r) => ({ r, ph })));
  // net wins in the bracket a finals slot reads ("1st in Championship"),
  // over its games and the ones carried into it, as finalsFill ranks it
  // (finalsSources reads the slots' labels: a filled slot keeps its label as `from`)
  const asLabels = JSON.parse(JSON.stringify(schedule));
  for (const ph of asLabels.phases) for (const r of ph.rounds) for (const g of r.games) {
    for (const k of ['a', 'b']) if (g[k] && g[k].from && FIN_RE.test(g[k].from)) g[k] = { label: g[k].from };
  }
  const sources = new Map(finalsSources(asLabels).map((src) => [src.name, src]));
  const netWins = (slot) => {
    const m = slot && slot.from ? FIN_RE.exec(slot.from) : null;
    const src = m ? sources.get(m[2]) : null;
    if (!src) return null;
    const me = teamOf(slot);
    const inBracket = new Set(src.games.map((g) => g.round));
    const prev = new Set(src.prevRounds);
    const carried = new Set(src.carried.map((x) => key2(x.a, x.b)));
    let net = 0;
    for (const { r } of all) {
      const counts = inBracket.has(r.round) || prev.has(r.round);
      if (!counts) continue;
      for (const g of r.games) {
        const [a, b] = [teamOf(g.a), teamOf(g.b)];
        if (a !== me && b !== me) continue;
        if (!inBracket.has(r.round) && !carried.has(key2(a, b))) continue;
        const res = played.get(gameKey(r.round, g));
        if (res && res.win) net += res.win === me ? 1 : -1;
      }
    }
    return net;
  };
  // an elimination phase's games by number ("Winner of game 7")
  const gameNo = (ph, n) => {
    for (const r of ph.rounds) for (const g of r.games) if (g.game === n) return { g, round: r.round };
    return null;
  };
  const needed = (g, round, ph) => {
    const a = teamOf(g.a);
    const b = teamOf(g.b);
    const why = typeof g.ifNeeded === 'string' ? g.ifNeeded : '';
    if (/two wins clear/.test(why)) {
      // the leader against the second: played unless one is two wins clear
      if (!a || !b) return true;
      const na = netWins(g.a);
      const nb = netWins(g.b);
      // two wins clear: four apart in net wins (a win and a loss each)
      return na === null || nb === null || Math.abs(na - nb) < 4;
    }
    if (/loses the first game/.test(why)) {
      // an advantaged final's second game: only if there was a leader (one
      // win clear going in; teams level play one game) and it lost the first
      const na = netWins(g.a);
      const nb = netWins(g.b);
      if (na !== null && nb !== null && na - nb !== 2) return false;
      const first = all.find((x) => x.r.round < round && x.r.games.some((y) => y.ifNeeded && teamOf(y.a) === a && teamOf(y.b) === b));
      if (!first) return false;
      const res = played.get(gameKey(first.r.round, first.r.games.find((y) => teamOf(y.a) === a && teamOf(y.b) === b)));
      // not played: the first game decides whether there is a second
      return !!res && res.win !== a;
    }
    // a double elimination reset: only if the final's second team won it
    const m = /^Winner of game (\d+)$/.exec((g.a && (g.a.label || g.a.from)) || '');
    const src = m ? gameNo(ph, Number(m[1])) : null;
    if (src) {
      const res = played.get(gameKey(src.round, src.g));
      return !res || res.win === teamOf(src.g.b);
    }
    return false;
  };
  for (const { r, ph } of all) {
    if (ph.kind === 'tiebreak') continue;
    for (const g of r.games) {
      if (!g.a && !g.b) continue;
      const done = teamOf(g.a) && teamOf(g.b) && played.has(gameKey(r.round, g));
      if (done) continue;
      if (g.ifNeeded) { if (needed(g, r.round, ph)) return false; continue; }
      return false;
    }
  }
  return true;
}
