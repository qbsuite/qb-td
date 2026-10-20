// stats.js — standings + individual leaderboard from parsed matches
// (qbj.js parseMatch output) and an optional roster (parseRoster output).
//
// The aggregation is the standard tossup/bonus model YellowFruit and SQBS
// compute: team W/L/T, points for/against, tossups heard, per-value buzz
// counts, bonuses heard (= positive buzzes), PPB, PP20TUH.

import { resultOf } from './qbj.js';
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
   public pool table lists them: their pool (seed) order (byPool below,
   schedule.js poolStandings, finals.js finalsFill). The set page's
   cross-site table stays on aggregate(). */

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

/** YF standings comparison: win % desc (no games -> bottom), then PPTUH
    desc; 0 when two teams are level on both. */
export function standingsCompare(a, b) {
  let ap = winPct(a); let bp = winPct(b);
  if (Number.isNaN(ap)) ap = -1;
  if (Number.isNaN(bp)) bp = -1;
  if (ap !== bp) return bp - ap;
  let at = pptuh(a); let bt = pptuh(b);
  if (Number.isNaN(at)) at = -9999999;
  if (Number.isNaN(bt)) bt = -9999999;
  return bt - at;
}

/** YF standings order (standingsCompare). A stable sort: teams level on
    both keep their order in `teams`. */
export function standingsOrder(teams) {
  return [...teams].sort(standingsCompare);
}

/** Two rows level on both counts (standingsCompare): the public page
    keeps them in its table's own order. */
export const levelOn = (a, b) => !!a && !!b && standingsCompare(a, b) === 0;

/**
 * Runs of rows level on both counts (levelOn), in order: [[rows…]], each
 * of two or more. rows: in standingsOrder.
 */
export function levelRuns(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && levelOn(rows[j], rows[i])) j++;
    if (j - i > 1) out.push(rows.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Rows in standingsOrder, with teams level on both counts in their pool
 * (seed) order, as the public page's pool tables list them: in each run
 * of level teams (levelRuns), the teams of one pool take that pool's
 * places in the run in pool order. Teams in no pool, and a run's only
 * team from its pool, keep their places. pools: {A: [names]}
 * (schedule.pools), or null for the rows as they are. A new array.
 */
export function byPool(rows, pools) {
  const out = [...rows];
  if (!pools) return out;
  const at = new Map(Object.entries(pools).flatMap(([k, ms]) => ms.map((n, i) => [n, [k, i]])));
  for (const run of levelRuns(rows)) {
    const start = rows.indexOf(run[0]);
    const mine = new Map(); // pool -> its places in the run, and its teams
    run.forEach((t, k) => {
      const p = at.get(t.name);
      if (!p) return;
      if (!mine.has(p[0])) mine.set(p[0], { places: [], teams: [] });
      mine.get(p[0]).places.push(start + k);
      mine.get(p[0]).teams.push(t);
    });
    for (const { places, teams } of mine.values()) {
      teams.sort((x, y) => at.get(x.name)[1] - at.get(y.name)[1]);
      places.forEach((place, k) => { out[place] = teams[k]; });
    }
  }
  return out;
}

/**
 * aggregate(), with the team rows figured and ordered the way the public
 * page does it: overtime out (regulationFigures), and YellowFruit's order
 * (standingsOrder; teams level on both keep aggregate()'s order, which
 * ends by name, as the public page's overall table does, or with pools,
 * a pool's level teams in pool order, as its table lists them: byPool).
 * On each row pp20tuh and ppb are the regulation figures and regTuh the
 * regulation tossups heard; tuh stays all tossups heard. settings: the
 * tournament's game format, as regulationFigures takes it. pools:
 * {A: [names]} (schedule.pools), for the hub's stats table.
 */
export function standings(matches, roster = null, settings = null, pools = null) {
  const agg = regulationFigures(aggregate(matches, roster), matches, settings);
  agg.teams = byPool(standingsOrder(agg.teams), pools).map((t) => ({
    ...t,
    pp20tuh: t.regTuh ? round2((t.regPoints / t.regTuh) * 20) : 0,
    ppb: t.bonusesHeard ? round2(t.bonusPoints / t.bonusesHeard) : 0,
  }));
  return agg;
}
