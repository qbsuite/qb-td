// finals.js — Finals slots that fill themselves.
//
// A finals game's slots name a place in an earlier bracket ("1st in
// 1st–6th place", "2nd in Pool A": plan.js addFinals, or the editor's Add
// phase). Once every game that bracket was scheduled to play is in, its
// standings decide the places, the way the pools decide the playoff slots
// (schedule.js autoFill): winning percentage, then points per 20 tossups
// heard, as the public page ranks them (stats.js standings), from the
// bracket's own games plus the games its pool-mates carry over from the
// stage before — the same carryover the YellowFruit 4 file sets up
// (yft.js yfStages). A bracket whose pools play again (a double round
// robin, Copy this phase) counts each time they played. Ties are settled
// by points per 20 and noted, or wait for the TD when the schedule has a
// Tiebreakers phase.

import { standings, standingsOrder, levelOn, recordOf, dedupeMatches } from './stats.js';
import { playedMap, teamOf, gameKey, summaryTeams, prelimProgress, autoFill } from './schedule.js';

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

// A slot as a phase of the same pools again copies it: its team, or the
// place it holds or was filled from
const slotId = (s) => (!s ? null : s.label || s.from ? 'L' + (s.label || s.from) : s.team ? 'T' + s.team : null);

// Each time the pools of bracket `key` in phase p played, earliest first:
// [{phase, key}]. A phase of the same pools again (plan.js planGroups
// `same`: a double round robin's second cycle, Copy this phase, the
// replay Add phase puts after tiered pools) copies the phase before's
// groups slot for slot, so each of its brackets holds exactly the slots of
// one bracket there. Pools made anew (places, tiers, crossovers) hold
// places from the phase before instead, and the walk back stops there.
function cyclesOf(schedule, p, key) {
  const slots = (q, k) => {
    const ids = new Set();
    for (const r of schedule.phases[q].rounds || []) {
      for (const g of r.games || []) if (g.bracket === k) for (const s of [g.a, g.b]) if (slotId(s)) ids.add(slotId(s));
    }
    return [...ids].sort().join('\n');
  };
  const out = [{ phase: p, key }];
  if (schedule.phases[p].kind) return out;
  for (let q = p - 1; q >= 0; q--) {
    const ph = schedule.phases[q];
    if (MINOR.has(ph.kind)) continue;
    if (ph.kind) break;
    const mine = slots(out[0].phase, out[0].key);
    const keys = new Set((ph.rounds || []).flatMap((r) => (r.games || []).map((g) => g.bracket)).filter(Boolean));
    const k = [...keys].find((x) => slots(q, x) === mine);
    if (k === undefined) break;
    out.unshift({ phase: q, key: k });
  }
  return out;
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
 *   prevRounds: [round…]}]. games are the bracket's over each time its
 * pools played (cyclesOf); teams in the order its own games list them.
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
    const each = cyclesOf(schedule, src.phase, src.key).map((c) => ({ ...c, ...bracketGames(schedule, c.phase, c.key) }));
    const { teams } = each[each.length - 1];
    const games = each.flatMap((c) => c.games);
    const open = each.some((c) => c.open);
    // carryover: pool-mates of the stage before whose pair this bracket
    // doesn't play again (the YellowFruit rule, yft.js yfStages), from the
    // first time its pools played
    const prev = groupsBefore(schedule, each[0].phase);
    const here = new Set(each[0].games.map((g) => key2(g.a, g.b)));
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
 * schedule's team names (schedule.js namedFiles). Returns
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
 * fill anyway (ties by points per 20). opts.holdTies as in autoFill;
 * opts.settings: the tournament's game format, for its regulation tossup
 * count (stats.js standings).
 * Returns {schedule, filled, brackets, ties, held}:
 *   ties — [{bracket, record, teams: [{name, pp20tuh, place}]}], a tie
 *          (the same winning percentage) that reaches a finals place,
 *          settled by points per 20
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
    // ranked as the public page ranks a table (stats.js standings), level
    // teams in the bracket's own order
    const row = new Map(standings(games, null, opts.settings).teams.map((t) => [t.name, t]));
    const rows = standingsOrder(src.teams.map((n) => row.get(n)).filter(Boolean));
    const deepest = Math.max(...src.places);
    let hold = false;
    for (let i = 0; i < rows.length && i < deepest;) {
      let j = i + 1;
      while (j < rows.length && levelOn(rows[j], rows[i])) j++;
      // a tie reaching a finals place: the order decides who plays, or who
      // is the leader
      if (j - i > 1) {
        const x = { bracket: src.name, record: recordOf(rows.slice(i, j)),
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

/**
 * What the hub's auto-fill looks at (admin.js autoFillSlots), from upload
 * metadata alone: prelimProgress for the pools (none ready without pools)
 * and finalsProgress for the Finals. files: the hub's file rows under the
 * roster's renames (schedule.js namedFiles). Returns
 *   pools, finals — those two results
 *   files — the uploads both rank on, each once
 *   sig   — changes whenever one of them does
 */
export function fillProgress(schedule, files) {
  const pools = schedule.pools ? prelimProgress(schedule, files) : { ready: [], left: {}, files: [], sig: '' };
  const finals = finalsProgress(schedule, files);
  const ids = new Set();
  const all = [...pools.files, ...finals.files].filter((f) => !ids.has(f.id) && ids.add(f.id));
  return { pools, finals, files: all, sig: pools.sig + '#' + finals.sig };
}

/**
 * The hub's auto-fill of the saved schedule, on a copy: the pools rank on
 * their prelim games only (autoFill), then the Finals on the schedule
 * with the pools filled (finalsFill). Readiness comes from `saved`, never
 * from an older copy of it: a rename saved since would leave a pool's
 * games out of what was read. matches: the games of fillProgress(saved,
 * files).files, each with its fileId. A pool or the Finals with one of
 * its uploads not among them (a read that failed) waits, as standings
 * without that game would be wrong. Ties points per 20 settled go on
 * schedule.filled, for the pages' notes. force: pool letters, and 'F:' +
 * a finals bracket, the TD said to fill anyway. settings: the
 * tournament's game format, for its regulation tossup count (stats.js
 * standings). Returns {schedule (saved itself when nothing filled),
 * playoffs, finals}: autoFill's and finalsFill's results, or null when
 * nothing of theirs was ready.
 */
export function autoFillSaved(saved, files, matches, roster = null, force = [], settings = null) {
  const read = new Set(matches.map((m) => m.fileId));
  let next = saved;
  let playoffs = null;
  let finals = null;
  const prog = saved.pools ? prelimProgress(saved, files) : null;
  if (prog && prog.ready.length) {
    const poolOf = new Map(Object.entries(saved.pools).flatMap(([p, ms]) => ms.map((m) => [m, p])));
    const unread = new Set(prog.files.filter((f) => !read.has(f.id)).flatMap((f) => summaryTeams(f).map((n) => poolOf.get(n))));
    const ids = new Set(prog.files.map((f) => f.id));
    playoffs = autoFill(next, standings(matches.filter((m) => ids.has(m.fileId)), roster, settings),
      prog.ready.filter((p) => !unread.has(p)), force.filter((x) => !x.startsWith('F:')));
    if (playoffs.filled) {
      const had = new Set((next.filled || []).map((x) => x.pool + ' ' + x.record));
      playoffs.schedule.filled = [...(next.filled || []), ...playoffs.ties.filter((x) => !had.has(x.pool + ' ' + x.record))
        .map((x) => ({ pool: x.pool, record: x.record, teams: x.teams.map((tm) => ({ name: tm.name, bracket: tm.bracket })) }))];
      next = playoffs.schedule;
    }
  }
  const fp = finalsProgress(next, files);
  if (fp.ready.length) {
    const ready = fp.files.every((f) => read.has(f.id)) ? fp.ready : [];
    finals = finalsFill(next, matches, ready, force.filter((x) => x.startsWith('F:')).map((x) => x.slice(2)), { settings });
    if (finals.filled) {
      const had = new Set((next.filled || []).map((x) => (x.pool || x.bracket) + ' ' + x.record));
      finals.schedule.filled = [...(next.filled || []), ...finals.ties.filter((x) => !had.has(x.bracket + ' ' + x.record))
        .map((x) => ({ bracket: x.bracket, record: x.record, teams: x.teams.map((tm) => ({ name: tm.name, place: tm.place })) }))];
      next = finals.schedule;
    }
  }
  return { schedule: next, playoffs, finals };
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
