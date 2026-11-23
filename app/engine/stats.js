// stats.js — standings + individual leaderboard from parsed matches
// (qbj.js parseMatch output) and an optional roster (parseRoster output).
//
// The aggregation is the standard tossup/bonus model YellowFruit and SQBS
// compute: team W/L/T, points for/against, tossups heard, per-value buzz
// counts, bonuses heard (= positive buzzes), PPB, PP20TUH.

import { resultOf } from './qbj.js';
import { isTbRound } from './deciderphases.js';
import { answerTypes, overtimeOf, REGULATION_TOSSUPS } from './yft.js';

function round2(x) {
  return Math.round(x * 100) / 100;
}

// A re-uploaded game (a mod re-exporting after a fix, or two mods covering
// the same room) must not double-count: keep only the latest upload per
// (round, team pair). "Latest" = higher fileId when both carry one (file
// ids are upload-ordered), else the later entry in input order. Exported
// so the .yft path applies the same rule; aggregate() applies it itself.
export function dedupeMatches(matches) {
  const byGame = new Map();
  for (const m of matches) {
    const key = m.round + '\n' + m.teams.map((t) => t.name).sort().join('\n');
    const prev = byGame.get(key);
    const older = prev && Number.isFinite(prev.fileId) && Number.isFinite(m.fileId)
      && m.fileId < prev.fileId;
    if (!older) byGame.set(key, m);
  }
  return [...byGame.values()];
}

/**
 * @param matches parsed matches; each may carry extra metadata (e.g.
 *   `room`, `fileId`) which is passed through to the per-round game list.
 * @param roster optional [{name, players}] — seeds team/player order,
 *   flags unrostered names, and hands its UG / D2 marks to the rows.
 * @returns {values, teams, players, games, errors}
 */
export function aggregate(matches, roster = null) {
  matches = dedupeMatches(matches);
  const teams = new Map();   // name -> team row
  const players = new Map(); // team + '\n' + name -> player row
  const valueSet = new Set();

  const teamRow = (name) => {
    let t = teams.get(name);
    if (!t) {
      t = {
        name, gp: 0, w: 0, l: 0, t: 0,
        points: 0, pointsAgainst: 0, tuh: 0,
        counts: {}, bonusesHeard: 0, bonusPoints: 0,
        rostered: !roster,
      };
      teams.set(name, t);
    }
    return t;
  };
  const playerRow = (team, name) => {
    const key = team + '\n' + name;
    let p = players.get(key);
    if (!p) {
      p = { name, team, gp: 0, tuh: 0, counts: {}, points: 0, rostered: !roster };
      players.set(key, p);
    }
    return p;
  };

  if (roster) {
    for (const r of roster) {
      const tr = teamRow(r.name);
      tr.rostered = true;
      // Undergraduate / Division II marks, only on a row that has one
      if (r.ug) tr.ug = true;
      if (r.d2) tr.d2 = true;
      for (const pn of r.players) {
        const pr = playerRow(r.name, pn);
        pr.rostered = true;
        const mk = (r.marks || {})[pn] || {};
        if (mk.ug) pr.ug = true;
        if (mk.d2) pr.d2 = true;
      }
    }
  }

  const games = [];
  for (const m of matches) {
    const [a, b] = m.teams;
    const rows = [teamRow(a.name), teamRow(b.name)];
    const opp = [b, a];
    // a forfeit: its result, and no stats (YF's PoolTeamStats)
    if (m.forfeit) {
      m.teams.forEach((mt, i) => {
        const res = resultOf(mt, opp[i]);
        if (res === 'W') rows[i].w += 1; else if (res === 'L') rows[i].l += 1;
      });
      games.push({ round: m.round, tossupsRead: 0, teams: m.teams, forfeit: true, room: m.room, fileId: m.fileId });
      continue;
    }
    m.teams.forEach((mt, i) => {
      const row = rows[i];
      row.gp += 1;
      row.points += mt.points;
      row.pointsAgainst += opp[i].points;
      row.tuh += m.tossupsRead;
      row.bonusPoints += mt.bonusPoints;
      if (mt.points > opp[i].points) row.w += 1;
      else if (mt.points < opp[i].points) row.l += 1;
      else row.t += 1;

      for (const p of mt.players) {
        const pr = playerRow(mt.name, p.name);
        if (p.tossupsHeard > 0) {
          pr.gp += 1;
          pr.tuh += p.tossupsHeard;
        }
        for (const c of p.counts) {
          if (!c.n) continue;
          valueSet.add(c.value);
          pr.counts[c.value] = (pr.counts[c.value] || 0) + c.n;
          row.counts[c.value] = (row.counts[c.value] || 0) + c.n;
          pr.points += c.value * c.n;
          if (c.value > 0) row.bonusesHeard += c.n;
        }
      }
    });
    games.push({
      round: m.round,
      tossupsRead: m.tossupsRead,
      // full parsed teams (players, counts, bonus) so views can render a
      // per-game box score without going back to the raw qbj
      teams: m.teams,
      room: m.room, fileId: m.fileId, packets: m.packets, notes: m.notes,
    });
  }

  const values = [...valueSet].sort((x, y) => y - x);

  const teamList = [...teams.values()].map((t) => ({
    ...t,
    ppg: t.gp ? round2(t.points / t.gp) : 0,
    pp20tuh: t.tuh ? round2((t.points / t.tuh) * 20) : 0,
    ppb: t.bonusesHeard ? round2(t.bonusPoints / t.bonusesHeard) : 0,
  }));
  teamList.sort((x, y) =>
    (y.w - y.l) - (x.w - x.l) || y.pp20tuh - x.pp20tuh || x.name.localeCompare(y.name));

  const playerList = [...players.values()].map((p) => ({
    ...p,
    ppg: p.gp ? round2(p.points / p.gp) : 0,
    pp20tuh: p.tuh ? round2((p.points / p.tuh) * 20) : 0,
  }));
  playerList.sort((x, y) => y.pp20tuh - x.pp20tuh || x.name.localeCompare(y.name));

  games.sort((x, y) => x.round - y.round);

  return { values, teams: teamList, players: playerList, games };
}

/* ---------- standings as the public page ranks them ----------
   The public page and every export (report.js, the .yft) figure a team's
   rates without overtime and rank teams the YellowFruit way. The hub's
   stats table, Fill playoff slots, auto-fill and the Finals fill rank with
   the same rules (standings below), so a team is seeded where the public
   pool table ranks it. Teams level on both counts go in the order the
   public page lists them: a pool fill in pool (seed) order, as its pool
   tables do (schedule.js poolStandings), and the Finals fill as the table
   it ranks on does (finals.js publicOrder). The stats table, one table of
   the whole field, keeps standings' own order, which ends by name, as the
   public page's overall table does. The set page's cross-site table stays
   on aggregate(). */

/** A team's gets in a game: its positive buzzes. */
export const teamGets = (mt) =>
  mt.players.reduce((s, p) => s + p.counts.reduce((n, c) => n + (c.value > 0 ? c.n : 0), 0), 0);

/**
 * YF keeps overtime out of a team's rate stats when overtime has no
 * bonuses: PP20TUH is regulation points over regulation tossups, and an
 * overtime get is not a bonus heard. Per game first (each game's
 * `overtime`, yft.js overtimeOf; each side's regPoints and bonusesHeard),
 * then per team (regTuh, regPoints, bonusesHeard), on agg's rows in place.
 * matches: what agg was made from. settings: the tournament's game format
 * (read_core.js effectiveFormat): its regulation tossup count is where
 * overtime starts.
 */
export function regulationFigures(agg, matches, settings) {
  const rules = settings || {};
  const regTossups = rules.regulationTossupCount ?? REGULATION_TOSSUPS;
  const vals = answerTypes(matches, rules).values;
  for (const g of agg.games) g.overtime = overtimeOf(matches.find((src) => src.teams === g.teams) || g, regTossups);
  for (const g of agg.games) {
    for (const mt of g.teams) {
      const otCount = (positiveOnly) => vals.reduce((n, v) =>
        n + (positiveOnly && v <= 0 ? 0 : g.overtime.count(mt.name, v)), 0);
      mt.regPoints = mt.points - vals.reduce((s, v) => s + v * g.overtime.count(mt.name, v), 0);
      mt.bonusesHeard = teamGets(mt) - otCount(true);
    }
  }
  for (const t of agg.teams) {
    const mine = agg.games.flatMap((g) => g.teams.filter((mt) => mt.name === t.name).map((mt) => [g, mt]));
    t.regTuh = mine.reduce((s, [g]) => s + g.tossupsRead - g.overtime.tossups, 0);
    t.regPoints = mine.reduce((s, [, mt]) => s + mt.regPoints, 0);
    t.bonusesHeard = mine.reduce((s, [, mt]) => s + mt.bonusesHeard, 0);
  }
  return agg;
}

/* derived stats (YF StatSummaries formulas) */
export function winPct(t) {
  return (t.w + t.t / 2) / (t.w + t.l + t.t);
}
export function pptuh(t) {
  return t.regPoints / t.regTuh; // regulation only; NaN when no tossups
}

/** The figure ties in winning percentage go by (a rule's `stat`):
    'pp20' points per tossup heard (YF's), 'ppg' points per game, 'ppb'
    points per bonus heard; NaN when there is nothing to divide by. */
export function statOf(t, stat = 'pp20') {
  if (stat === 'ppg') return t.points / t.gp;
  if (stat === 'ppb') return t.bonusPoints / t.bonusesHeard;
  return pptuh(t);
}

/** YF standings comparison: win % desc (no games -> bottom), then PPTUH
    desc (or the figure `stat` names, statOf); 0 when two teams are level
    on both. */
export function standingsCompare(a, b, stat = 'pp20') {
  let ap = winPct(a); let bp = winPct(b);
  if (Number.isNaN(ap)) ap = -1;
  if (Number.isNaN(bp)) bp = -1;
  if (ap !== bp) return bp - ap;
  let at = statOf(a, stat); let bt = statOf(b, stat);
  if (Number.isNaN(at)) at = -9999999;
  if (Number.isNaN(bt)) bt = -9999999;
  return bt - at;
}

/* ---------- the TD's tiebreak ----------
   How teams with the same winning percentage rank. A tournament's
   settings.tieOrder is the order of five steps, any order, each used on
   whatever the steps before it left level:
     game  a tiebreaker game, when one was played (tiebreaker packets:
           deciderphases.js): the teams that played rank by its results,
           the others by the steps after it
     ppg   points per game          ppb   points per bonus
     h2h   head-to-head (below)
     pick  the TD's pick; until there is one the teams stay level, and
           no step after it is reached
   A tournament without tieOrder keeps its old setting, settings.tiebreak,
   read as the same order it always ranked by: points per 20 (YF's order,
   none set), points per game or per bonus, each with or without
   head-to-head first.

   Head-to-head is the tied teams' games against each other. It counts
   only when every pair of them met the same number of times, as a round
   robin has them meet: each team's winning percentage in those games
   orders them, and it runs again on any smaller group still level.

   A rule, as standingsOrder and the rest take it: {order, stat, h2h, tb,
   picks}: order the steps; stat the first figure in it (for notes that
   name one); h2h the games to go by (aggregate()'s games), or null; tb
   the tiebreaker games played (aggregate()'s games of tiebreaker rounds),
   or null; picks the TD's picks, [[names, best first]…], or null. A null
   rule is YF's order (points per 20). */

export const TIEBREAKS = ['pp20', 'ppg', 'ppb', 'h2h', 'h2h-ppg', 'h2h-ppb'];
export const TIE_STEPS = ['game', 'ppg', 'h2h', 'ppb', 'pick'];
export const DEFAULT_TIE_ORDER = ['game', 'ppg', 'h2h', 'ppb', 'pick'];
const STAT_STEPS = ['pp20', 'ppg', 'ppb'];
// the order each old setting always ranked by
const LEGACY_ORDER = { pp20: ['pp20'], ppg: ['ppg'], ppb: ['ppb'], h2h: ['h2h', 'pp20'], 'h2h-ppg': ['h2h', 'ppg'], 'h2h-ppb': ['h2h', 'ppb'] };

/** A tie order as settings.tieOrder may hold it: the five steps, each once. */
export const isTieOrder = (o) => Array.isArray(o) && o.length === TIE_STEPS.length && TIE_STEPS.every((x) => o.includes(x));

/** The steps ties go by, from a game format (rankFormat). */
export function tieOrderOf(settings) {
  if (settings && isTieOrder(settings.tieOrder)) return [...settings.tieOrder];
  const v = settings && TIEBREAKS.includes(settings.tiebreak) ? settings.tiebreak : 'pp20';
  return LEGACY_ORDER[v];
}

/** The tiebreak a game format carries: {order, stat, h2h: boolean}. */
export function tiebreakOf(settings) {
  const order = tieOrderOf(settings);
  return { order, stat: order.find((x) => STAT_STEPS.includes(x)) || 'pp20', h2h: order.includes('h2h') };
}

/** The rule for the tiebreak `tb` (tiebreakOf) over `games` (and the
    tiebreaker games and picks in `extra`), or null for YF's order. */
export const ruleOf = (tb, games, extra = {}) => (tb && !(tb.order.length === 1 && tb.order[0] === 'pp20')
  ? { order: tb.order, stat: tb.stat, h2h: tb.h2h ? games : null, tb: extra.tb || null, picks: extra.picks || null } : null);

const samePct = (a, b) => {
  const x = winPct(a); const y = winPct(b);
  return x === y || (Number.isNaN(x) && Number.isNaN(y));
};
const recText = (r) => `${r.w}–${r.l}${r.t ? '–' + r.t : ''}`;

/**
 * Head-to-head among rows tied on winning percentage, in standingsOrder.
 * games: aggregate()'s games ({teams: [mt, mt]}). Returns
 *   rows    — the rows in head-to-head order
 *   tier    — Map name -> key; two rows with the same key were not
 *             separated by head-to-head
 *   records — {name: 'w–l'} in the games among all of them, or null when
 *             head-to-head didn't count (they hadn't all met evenly)
 *   decided — 'all', 'some' or 'none' of their places it decided
 */
export function headToHead(rows, games) {
  const tier = new Map(rows.map((t) => [t.name, '']));
  let records = null;
  const step = (group, path, first) => {
    if (group.length < 2) return group;
    const names = new Set(group.map((t) => t.name));
    const met = new Map();
    const rec = new Map(group.map((t) => [t.name, { w: 0, l: 0, t: 0 }]));
    for (const g of games) {
      const [a, b] = g.teams;
      if (!names.has(a.name) || !names.has(b.name) || a.name === b.name) continue;
      const res = resultOf(a, b);
      if (!res) continue; // both forfeited: no result
      const k = [a.name, b.name].sort().join('\n');
      met.set(k, (met.get(k) || 0) + 1);
      const [ra, rb] = [rec.get(a.name), rec.get(b.name)];
      if (res === 'W') { ra.w++; rb.l++; } else if (res === 'L') { ra.l++; rb.w++; } else { ra.t++; rb.t++; }
    }
    const counts = [...met.values()];
    const even = met.size === (group.length * (group.length - 1)) / 2 && counts.every((c) => c === counts[0]);
    if (first && even) records = Object.fromEntries(group.map((t) => [t.name, recText(rec.get(t.name))]));
    if (!even) return group;
    // stable: teams level here keep their points-per-20 order
    const sorted = [...group].sort((x, y) => winPct(rec.get(y.name)) - winPct(rec.get(x.name)));
    const runs = [];
    for (const t of sorted) {
      const last = runs[runs.length - 1];
      if (last && winPct(rec.get(last[0].name)) === winPct(rec.get(t.name))) last.push(t); else runs.push([t]);
    }
    if (runs.length === 1) return group;
    return runs.flatMap((run, i) => {
      const p = path + i + '.';
      run.forEach((t) => tier.set(t.name, p));
      return step(run, p, false);
    });
  };
  const out = step(rows, '', true);
  const tiers = new Set(tier.values());
  const decided = tiers.size === rows.length ? 'all' : tiers.size > 1 ? 'some' : 'none';
  return { rows: out, tier, records, decided };
}

// Each run of rows tied on winning percentage, in place, in head-to-head
// order; returns every row's tier ('' outside a run)
function h2hPass(rows, games) {
  const tier = new Map();
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && samePct(rows[j], rows[i])) j++;
    if (j - i > 1) {
      const h = headToHead(rows.slice(i, j), games);
      rows.splice(i, j - i, ...h.rows);
      h.tier.forEach((v, k) => tier.set(k, i + ':' + v));
    }
    i = j;
  }
  return tier;
}

/** Each row's head-to-head tier (headToHead), rows in standingsOrder with
    the same games: two rows tied on winning percentage that head-to-head
    did not separate have the same tier. */
export const h2hTiers = (rows, games) => h2hPass([...rows], games);

// consecutive rows `same` puts together
function runsBy(rows, same) {
  const out = [];
  for (const t of rows) {
    const last = out[out.length - 1];
    if (last && same(last[last.length - 1], t)) last.push(t); else out.push([t]);
  }
  return out;
}
const figure = (t, stat) => { const v = statOf(t, stat); return Number.isNaN(v) ? -9999999 : v; };

// The tiebreaker games among `rows`: the teams that played rank by them,
// the way a stepladder ends (the last game's winner first, then each
// game's loser from the last game back); the others keep the places the
// steps after this one give them. null when none was played among them.
function gameStep(rows, rest, rule, key) {
  const names = new Set(rows.map((t) => t.name));
  const played = (rule.tb || []).filter((g) => g.teams.length === 2 && g.teams.every((x) => names.has(x.name)) && resultOf(g.teams[0], g.teams[1]));
  if (!played.length) return null;
  const order = [...played].sort((x, y) => x.round - y.round);
  const last = new Map();
  order.forEach((g, i) => {
    const res = resultOf(g.teams[0], g.teams[1]);
    g.teams.forEach((x, s) => last.set(x.name, { i, won: (res === 'W') === (s === 0) && res !== 'T' }));
  });
  const seeded = walk(rows, rest, rule, key);
  const slots = seeded.map((p, i) => (last.has(p.row.name) ? i : -1)).filter((i) => i >= 0);
  const players = slots.map((i) => seeded[i]).sort((x, y) => {
    const a = last.get(x.row.name), b = last.get(y.row.name);
    return b.i - a.i || Number(b.won) - Number(a.won);
  });
  const out = [...seeded];
  slots.forEach((at, k) => { out[at] = { row: players[k].row, key: key + 'g' + k + '.' }; });
  return out;
}

// rows level on everything before `steps`, as [{row, key}] in order: two
// rows with the same key were not separated by a step that isn't a figure
// (a figure splits them but they share a rank, as YF shows ties in record)
// (`grp` marks the rows a step left level together)
let grpSeq = 0;
const leaf = (rows, key) => { const grp = ++grpSeq; return rows.map((row) => ({ row, key, level: rows.length > 1, grp })); };
function walk(rows, steps, rule, key) {
  if (rows.length < 2 || !steps.length) return leaf(rows, key);
  const [c, ...rest] = steps;
  if (STAT_STEPS.includes(c)) {
    const sorted = [...rows].sort((a, b) => figure(b, c) - figure(a, c));
    return runsBy(sorted, (a, b) => figure(a, c) === figure(b, c)).flatMap((run) => walk(run, rest, rule, key));
  }
  if (c === 'h2h') {
    if (!rule.h2h) return walk(rows, rest, rule, key);
    const h = headToHead(rows, rule.h2h);
    return runsBy(h.rows, (a, b) => h.tier.get(a.name) === h.tier.get(b.name)).flatMap((run, i) => walk(run, rest, rule, key + 'h' + i + '.'));
  }
  if (c === 'game') return gameStep(rows, rest, rule, key) || walk(rows, rest, rule, key);
  if (c === 'pick') {
    // the TD's pick for these teams, best first; until then they stay level
    const pick = (rule.picks || []).find((p) => rows.every((t) => p.includes(t.name)));
    if (!pick) return leaf(rows, key);
    return [...rows].sort((a, b) => pick.indexOf(a.name) - pick.indexOf(b.name)).map((row, i) => ({ row, key: key + 'p' + i + '.' }));
  }
  return walk(rows, rest, rule, key);
}

// rows by winning percentage (no games at the bottom), each run of the same
// percentage walked through the rule's steps: [[{row, key, level}]…], a run each
function pctRuns(teams, rule) {
  const pct = (t) => { const v = winPct(t); return Number.isNaN(v) ? -1 : v; };
  const sorted = [...teams].sort((a, b) => pct(b) - pct(a));
  return runsBy(sorted, (a, b) => pct(a) === pct(b)).map((run, i) => walk(run, rule.order, rule, i + ':'));
}

/** YF standings order: winning percentage, then the TD's tie order (see
    above). A stable sort: teams level on everything keep their order in
    `teams`. rule: as ruleOf makes it, or null for YF's order. */
export function standingsOrder(teams, rule = null) {
  if (!rule || !rule.order) {
    const out = [...teams].sort((a, b) => standingsCompare(a, b, rule ? rule.stat : 'pp20'));
    if (rule && rule.h2h) h2hPass(out, rule.h2h);
    return out;
  }
  return pctRuns(teams, rule).flat().map((p) => p.row);
}

/** Each row's tie key, rows in standingsOrder: two rows share a rank
    ("N=") when they have the same key, i.e. the same winning percentage
    and no step but a figure set them apart. */
export function tieKeys(rows, rule = null) {
  const out = new Map();
  if (!rule || !rule.order) {
    const tier = rule && rule.h2h ? h2hTiers(rows, rule.h2h) : null;
    rows.forEach((t) => out.set(t.name, String(winPct(t)) + '|' + (tier ? tier.get(t.name) : '')));
    return out;
  }
  for (const run of pctRuns(rows, rule)) for (const p of run) out.set(p.row.name, p.key);
  return out;
}

/** Two rows level on both counts (standingsCompare): the public page
    keeps them in its table's own order. */
export const levelOn = (a, b, stat = 'pp20') => !!a && !!b && standingsCompare(a, b, stat) === 0;

/**
 * Runs of rows nothing in the rule separates, in order: [[rows…]], each of
 * two or more. rows: in standingsOrder. rule: as standingsOrder takes it.
 * For the old settings, rows level on both counts (levelOn), apart from
 * rows head-to-head separated.
 */
export function levelRuns(rows, rule = null) {
  if (rule && rule.order) {
    const out = [];
    for (const run of pctRuns(rows, rule)) {
      // consecutive rows left level by the same steps
      for (const g of runsBy(run, (a, b) => a.level && b.level && a.grp === b.grp)) if (g.length > 1) out.push(g.map((p) => p.row));
    }
    return out;
  }
  const tier = rule && rule.h2h ? h2hPass([...rows], rule.h2h) : null;
  const stat = rule ? rule.stat : 'pp20';
  const level = (a, b) => levelOn(a, b, stat) && (!tier || tier.get(a.name) === tier.get(b.name));
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && level(rows[j], rows[i])) j++;
    if (j - i > 1) out.push(rows.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * aggregate(), with the team rows figured and ordered the way the public
 * page does it: overtime out (regulationFigures), and YellowFruit's order
 * (standingsOrder; teams level on both keep aggregate()'s order, which
 * ends by name, as the public page's overall table does). On each
 * row pp20tuh and ppb are the regulation figures and regTuh the regulation
 * tossups heard; tuh stays all tossups heard. settings: the tournament's
 * game format, as regulationFigures takes it, with its tiebreak
 * (tiebreakOf; kept as agg.rule, head-to-head over agg.games).
 */
export function standings(matches, roster = null, settings = null, picks = null) {
  // tiebreaker games settle ties but count in no record or figure
  const counted = matches.filter((m) => !isTbRound(m.round));
  const tbGames = counted.length < matches.length ? aggregate(matches.filter((m) => isTbRound(m.round)), roster).games : null;
  const agg = regulationFigures(aggregate(counted, roster), counted, settings);
  agg.rule = ruleOf(tiebreakOf(settings), agg.games, { tb: tbGames, picks });
  agg.teams = standingsOrder(agg.teams, agg.rule).map((t) => ({
    ...t,
    pp20tuh: t.regTuh ? round2((t.regPoints / t.regTuh) * 20) : 0,
    ppb: t.bonusesHeard ? round2(t.bonusPoints / t.bonusesHeard) : 0,
  }));
  return agg;
}
