// report.js — generate YellowFruit's static HTML stat report directly from
// parsed matches (qbj.js parseMatch output) + an optional roster, so a TD
// gets the standard six-page report without round-tripping through
// YellowFruit. Page set, layout, CSS, link scheme, and stat formulas are
// ported from YellowFruit 4.0.18 (HTMLReports.ts / StatSummaries.ts),
// reduced to qb-td's model: one phase, no pools/finals, no small-school,
// JV or year tracking, no lightning rounds, bouncebacks folded into bonus
// points. Undergraduate and Division II marks are YF's, column for column.
//
// buildReport({name, matches, roster, prefix}) -> [{name, text}] — the six
// files (standings/individuals/games/teamdetail/playerdetail/rounds .html),
// interlinked by filename, ready to zip or host as a folder. With a prefix
// they are named and linked `<prefix>_standings.html` etc., which is how
// YellowFruit saves a report to disk and what the hsquizbowl.org tournament
// database expects to be handed; the bare names are YF's in-app preview.

import { aggregate } from './stats.js';
import { rosterTracking, resultOf } from './qbj.js';
import { answerTypes, importOrder, matchId, overtimeOf, schoolAndLetter, PHASE_NAME, yfStages, buildYft,
  REGULATION_TOSSUPS } from './yft.js';

// Stat display scaling. YellowFruit scales its rate stats by the
// tournament's own regulation tossup count, not by a constant
// (StatReportDataTypes.ts): a 22-tossup event's report is headed PP22TUH,
// and its per-team rates divide by 22. m.regTossups carries that count
// through the model; REGULATION_TOSSUPS is only the fallback for a caller
// that hands over no game format.

// The YellowFruit release whose HTMLReports.ts this is a port of.
const YF_VERSION = '4.0.18';

// `title` is the nav label, `heading` the page's <title> and <h1> — YF
// differs between the two only for the standings page.
const PAGES = [
  { file: 'standings.html', title: 'Standings', heading: 'Team Standings' },
  { file: 'individuals.html', title: 'Individuals', heading: 'Individuals' },
  { file: 'games.html', title: 'Scoreboard', heading: 'Scoreboard' },
  { file: 'teamdetail.html', title: 'Team Detail', heading: 'Team Detail' },
  { file: 'playerdetail.html', title: 'Player Detail', heading: 'Player Detail' },
  { file: 'rounds.html', title: 'Round Report', heading: 'Round Report' },
];

const MDASH = '&mdash;';
const NBSP = '&nbsp;';

// Names only ever go into text nodes. YF writes them raw; this escapes just
// what would otherwise be read as markup and leaves quotes as YF has them.
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const alphaOnly = (s) => String(s).replace(/\W/g, '');
// Team.getTruncatedName(25), as box scores use it: a long name is cut with
// "...", a lettered team keeping its letter after the cut.
const trunc = (s, size) => (s.length <= size ? s : `${s.substring(0, size).trim()}...`);
function truncName(name) {
  if (name.length <= 25) return name;
  const [, letter] = schoolAndLetter(name);
  return letter ? `${trunc(name, 25 - letter.length - 1)} ${letter}` : trunc(name, 25);
}

/* ---------- html helpers ---------- */

// These write YF's markup to the byte — unquoted HREF/border/class/width,
// quoted td attributes with a slot's space left behind when one is absent,
// a line break inside every generic tag — because the report is read by
// programs as well as people: the hsquizbowl.org database parses uploaded
// reports, and tools/yf_parity.mjs compares these pages with YF's own.

const genericTag = (tag, ...contents) => `<${tag}>\n${contents.join('\n')}\n</${tag}>`;
const tagWithAttrs = (tag, attrs, ...contents) =>
  `<${tag} ${attrs.join(' ')}>\n${contents.join('\n')}\n</${tag}>`;
const attr = (name, val) => `${name}="${val}"`;
const cls = (...names) => attr('class', names.join(' '));

const aTag = (href, contents, newTab) =>
  (newTab ? `<a HREF=${href} target="_blank">${contents}</a>` : `<a HREF=${href}>${contents}</a>`);
const trTag = (cells) => `<tr>\n${cells.join('\n')}\n</tr>`;
const trFoot = (cells) => `<tr class=pseudoTFoot>\n${cells.join('\n')}\n</tr>`;
function tdTag({ bold, align, width, title, style } = {}, contents) {
  const slot = (name, val) => (val === undefined ? '' : attr(name, val));
  const inner = bold ? genericTag('b', contents) : contents;
  return `<td ${slot('align', align)} ${slot('title', title)} ${slot('style', style)} ${slot('width', width)}>${inner}</td>`;
}
const th = (contents, right, width) =>
  tdTag({ bold: true, align: right ? 'right' : undefined, width: width || undefined }, contents);
const textCell = (contents) => tdTag({}, contents);
const numCell = (contents) => tdTag({ align: 'right' }, contents);
function tableTag(rows, { width, cssClass, border } = {}) {
  const slot = (name, val) => (val === undefined ? '' : `${name}=${val}`);
  return `<table ${slot('border', border)} ${slot('class', cssClass)} ${slot('width', width)}>\n${rows.join('\n')}\n</table>`;
}
const abbr = (text, tip) => tagWithAttrs('abbr', [attr('title', tip)], text);

/* ---------- number formatting (YF's exact rules) ---------- */

const fmtWinPct = (p) => (Number.isNaN(p) ? MDASH : p.toFixed(3));
const fmtPpb = (pts, heard) => (heard ? (pts / heard).toFixed(2) : MDASH);

/* ---------- derived stats (YF StatSummaries formulas) ---------- */

function winPct(t) {
  return (t.w + t.t / 2) / (t.w + t.l + t.t);
}
function pptuh(t) {
  return t.regPoints / t.regTuh; // regulation only; NaN when no tossups
}

// YF standings order: win % desc (no games -> bottom), then PPTUH desc.
function sortTeamsYf(teams) {
  return [...teams].sort((a, b) => {
    let ap = winPct(a); let bp = winPct(b);
    if (Number.isNaN(ap)) ap = -1;
    if (Number.isNaN(bp)) bp = -1;
    if (ap !== bp) return bp - ap;
    let at = pptuh(a); let bt = pptuh(b);
    if (Number.isNaN(at)) at = -9999999;
    if (Number.isNaN(bt)) bt = -9999999;
    return bt - at;
  });
}

// YF rank strings: teams tied on win % share "N=" (N = rank of the first
// team in the tied run); otherwise the 1-based position.
function rankTeams(sorted) {
  const ranks = [];
  let prevPct = 2;
  let prevRank = 0;
  sorted.forEach((t, i) => {
    const pct = winPct(t);
    const tied = pct === prevPct || (Number.isNaN(pct) && Number.isNaN(prevPct));
    if (tied) {
      ranks[i] = `${prevRank}=`;
      ranks[i - 1] = `${prevRank}=`;
    } else {
      ranks[i] = String(i + 1);
      prevRank = i + 1;
    }
    prevPct = pct;
  });
  return ranks;
}

// Players sorted by PPTUH desc; exact ties share a rank marked "N=".
function rankPlayers(sorted) {
  const ranks = [];
  let prevVal;
  let prevRank = 0;
  sorted.forEach((p, i) => {
    const val = p.tuh ? p.points / p.tuh : -9999999;
    if (i > 0 && val === prevVal) {
      ranks[i] = `${prevRank}=`;
      ranks[i - 1] = `${prevRank}=`;
    } else {
      ranks[i] = String(i + 1);
      prevRank = i + 1;
    }
    prevVal = val;
  });
  return ranks;
}

const teamGets = (mt) =>
  mt.players.reduce((s, p) => s + p.counts.reduce((n, c) => n + (c.value > 0 ? c.n : 0), 0), 0);
const teamBonusesHeard = (mt) => mt.bonusesHeard; // gets, less overtime's (reportModel)
const teamCounts = (mt) => {
  const counts = {};
  for (const p of mt.players) {
    for (const c of p.counts) counts[c.value] = (counts[c.value] || 0) + c.n;
  }
  return counts;
};
const playerPoints = (p) => p.counts.reduce((s, c) => s + c.value * c.n, 0);

/* ---------- link + anchor scheme ---------- */

// Every link takes the report model `m` for its filePrefix ('' or
// '<prefix>_', YF's setFilePrefix), so a saved report links to its own
// prefixed files.
const gameAnchor = (g) => g.id; // the game's YF match id, as in the .yft
const teamLink = (m, name) => aTag(`${m.filePrefix}teamdetail.html#${alphaOnly(name)}`, esc(name));
const playerLink = (m, team, player) =>
  aTag(`${m.filePrefix}playerdetail.html#${alphaOnly(team)}-${alphaOnly(player)}`, esc(player));
const gameLink = (m, g, text) => aTag(`${m.filePrefix}games.html#${gameAnchor(g)}`, text);
const roundLink = (m, round, text) => aTag(`${m.filePrefix}games.html#Round-${round}`, text);

/* ---------- page skeleton ---------- */

// YF's stylesheet, rule for rule and in its order; written out one
// declaration per line the way YF's cssSelector does.
const STYLE_RULES = [
  ['HTML', ['font-family: Roboto, sans-serif']],
  ['table', ['font-size: 11pt', 'border-spacing: 0', 'border-collapse: collapse']],
  ['td', ['padding: 5px']],
  ['tr:nth-child(even)', ['background-color: #f2f2f2']],
  ['.headerAndDivider', ['display: flex', 'flex-direction: row', 'margin: 18px 0']],
  ['.scoreboardRoundHeader', ['width: 71%', 'position: sticky', 'top: 0', 'background-color: white',
    'padding-bottom: 10px', 'margin-bottom: -10px']],
  ['.boxScoreAnchor', ['padding-top: 30px']],
  ['.boxScoreTitle', ['width: 71%']],
  ['.inlineDivider', ['flex-grow: 1', 'height: 1px', 'background-color: #9f9f9f', 'align-self: center']],
  ['ul', ['margin: 0']],
  ['.smallText', ['font-size: 10pt']],
  ['.headerAndDivider h2', ['margin: 0']],
  ['.boxScoreTable', ['display: flex', 'gap: 15px', 'align-items: flex-start']],
  ['.pseudoTFoot', ['border-top: 1px solid #909090', 'background-color: #ffffff !important']],
  ['.floatingTOC', ['top: 150px', 'right: 35px', 'position: fixed', 'padding-right: 5px',
    'background-color: #cccccc', 'box-shadow: 4px 4px 7px #999999', 'line-height: 1.5', 'z-index: 99']],
  ['.floatingTOC ul', ['list-style-type: none', 'padding-inline-start: 20px']],
];
const cssRule = ([selector, decls]) => `${selector}{\n${decls.map((d) => `${d};`).join('\n')}\n}`;
const cssMinWidth = (px, className, pct) =>
  `@media screen and (min-width: ${px}px) {\n${cssRule([`.${className}`, [`width: ${pct}%`]])}\n}`;
const PAGE_STYLE = genericTag('style', ...STYLE_RULES.map(cssRule),
  cssMinWidth(800, 'fwBelow800px', 60), cssMinWidth(1000, 'fwBelow1000px', 80));

function topLinks(m) {
  const cells = PAGES.map((p) => tdTag({}, aTag(m.filePrefix + p.file, p.title)));
  return tableTag([trTag(cells)], { width: '100%', border: '0' });
}

function headerWithDivider(m, text, pageFile, { noTopLink, sticky } = {}) {
  const classes = sticky ? cls('headerAndDivider', 'scoreboardRoundHeader') : cls('headerAndDivider');
  const pieces = [genericTag('h2', text + NBSP), tagWithAttrs('div', [cls('inlineDivider')])];
  if (!noTopLink) {
    pieces.push(genericTag('span', NBSP),
      aTag(`${m.filePrefix}${pageFile}#top`, tagWithAttrs('span', [cls('smallText')], '&#x2191;Top')));
  }
  return tagWithAttrs('div', [classes], ...pieces);
}

// YF's document, whole: no doctype or charset, uppercase HTML/HEAD/BODY,
// the top anchor written id=#top, YF's generator line (its version on the
// round report only), and no newline after </HTML>.
function htmlPage(m, title, data, withVersion) {
  const madeWith = '<div class="html-rpt-hide-in-yft-app" style="font-size:x-small; margin-top: 10px">Made with '
    + `${aTag('https://github.com/ANadig/YellowFruit/releases', 'YellowFruit', true)} `
    + `${withVersion ? YF_VERSION : ''}${NBSP}&#x1F34C;</div>\n`;
  const content = tagWithAttrs('div', ['style="font-size: 11pt; text-size-adjust: none;"'], data, madeWith);
  const body = genericTag('BODY', topLinks(m), tagWithAttrs('h1', ['id=#top'], title), PAGE_STYLE, content);
  return genericTag('HTML', genericTag('HEAD', genericTag('title', title)), body);
}

/* ---------- stages ----------
   A tournament played in stages (prelim pools, playoff brackets, finals,
   tiebreakers) reports stage by stage, as YF does from the .yft qb-td
   writes it: the stages, pools and carried-over games come from that file
   object (yft.js buildYft), so the report and the export always agree. */

// YF's stage colors, one per pool stage in order; finals and tiebreakers
// have none
const STAGE_COLORS = ['#03a9f430', '#4caf5030', '#ffeb3b30', '#f4433630', '#673ab730', '#ff980030'];

function stagesOf(file, games) {
  const byId = new Map(games.map((g) => [g.id, g]));
  let colored = 0;
  const stages = file.phases.map((ph) => {
    const type = ph.YfData.phaseType;
    const full = type === 'Prelim' || type === 'Playoff';
    return {
      name: ph.name, type, full,
      numeric: full || !!ph.YfData.forceNumericRounds,
      color: full ? (STAGE_COLORS[colored++] ?? '') : '',
      pools: ph.pools.map((pl) => ({
        name: pl.name, carry: !!pl.YfData.hasCarryover, rr: pl.YfData.roundRobins,
        teams: (pl.pool_teams || pl.poolTeams).map((pt) => pt.team.$ref.slice('Team_'.length)),
      })),
      rounds: ph.rounds.map((rd) => ({ number: rd.YfData.number, games: rd.matches.map((mm) => byId.get(mm.id)).filter(Boolean) })),
      carriedIn: [],
    };
  });
  const byName = new Map(stages.map((st) => [st.name, st]));
  const stageOf = new Map();
  const carryOf = new Map(); // game -> the stages it carries to
  file.phases.forEach((ph, i) => {
    for (const rd of ph.rounds) for (const mm of rd.matches) {
      const g = byId.get(mm.id);
      if (!g) continue;
      stageOf.set(g, stages[i]);
      const to = (mm.carryover_phases || []).map((x) => byName.get(x.$ref.slice('Phase_'.length))).filter(Boolean);
      carryOf.set(g, to);
      for (const st of to) st.carriedIn.push(g);
    }
  });
  const full = stages.filter((st) => st.full);
  const anyCarry = full.some((st) => st.pools.some((pl) => pl.carry));
  // a full round robin prelim pool, all of it carried into the one playoff
  // stage: YF shows that stage's standings with and without the prelims
  const prelims = stages.find((st) => st.type === 'Prelim');
  const allCarry = !!prelims && full.length === 2 && prelims.pools.length === 1 && prelims.pools[0].rr >= 1;
  // the teams as the file registers them, for YF's every-team list
  const teamOrder = file.registrations.flatMap((rg) => rg.teams.map((t) => t.name));
  return { list: stages, full, stageOf, carryOf, anyCarry, allCarry, teamOrder };
}

// Each player's figures over some games, in YF's order (points per tossup
// heard, then tossups heard, then first seen), with their marks
function playersOf(m, games) {
  const out = new Map();
  for (const g of games) for (const mt of g.teams) for (const mp of mt.players) {
    const key = mt.name + '\n' + mp.name;
    if (!out.has(key)) out.set(key, { name: mp.name, team: mt.name, gp: 0, counts: {}, tuh: 0, points: 0, seen: out.size });
    const p = out.get(key);
    if (mp.tossupsHeard) p.gp += mp.tossupsHeard / g.tossupsRead;
    p.tuh += mp.tossupsHeard || 0;
    p.points += playerPoints(mp);
    for (const c of mp.counts) p.counts[c.value] = (p.counts[c.value] || 0) + c.n;
  }
  const marks = new Map(m.players.map((p) => [p.team + '\n' + p.name, p]));
  const list = [...out.values()].filter((p) => p.tuh > 0).map((p) => {
    const k = marks.get(p.team + '\n' + p.name) || {};
    return { ...p, ug: k.ug, d2: k.d2 };
  });
  return list.sort((x, y) => {
    const xv = x.points / x.tuh;
    const yv = y.points / y.tuh;
    if (xv !== yv) return yv - xv;
    if (x.tuh !== y.tuh) return xv > 0 ? y.tuh - x.tuh : x.tuh - y.tuh;
    return x.seen - y.seen;
  });
}

// Each team's (by name) figures over some games, as the standings show them
function tally(games, names) {
  const out = new Map(names.map((n) => [n, { name: n, w: 0, l: 0, t: 0, counts: {}, regTuh: 0, regPoints: 0, tuh: 0,
    bonusPoints: 0, bonusesHeard: 0 }]));
  for (const g of games) {
    for (const [mt, opp] of [[g.teams[0], g.teams[1]], [g.teams[1], g.teams[0]]]) {
      const t = out.get(mt.name);
      if (!t) continue;
      const res = resultOf(mt, opp);
      if (res === 'W') t.w++; else if (res === 'L') t.l++; else if (res === 'T') t.t++;
      if (g.forfeit) continue; // a forfeit is its result only
      for (const [v, n] of Object.entries(teamCounts(mt))) t.counts[v] = (t.counts[v] || 0) + n;
      t.regTuh += g.tossupsRead - g.overtime.tossups;
      t.regPoints += mt.regPoints;
      t.tuh += g.tossupsRead;
      t.bonusPoints += mt.bonusPoints;
      t.bonusesHeard += mt.bonusesHeard;
    }
  }
  return out;
}

/* ---------- report model ---------- */

// One derived bundle every page reads: YF-ordered team rows, player rows
// with fractional games played, per-round game lists.
function reportModel({ name, matches, roster, prefix, settings, schedule }) {
  const rules = settings || {};
  const regTossups = rules.regulationTossupCount ?? REGULATION_TOSSUPS;
  const agg = aggregate(matches, roster);
  // the columns, game order and match ids of the .yft YF would hold
  const vals = answerTypes(matches, rules).values;
  const games = importOrder(agg.games);
  games.forEach((g, i) => {
    g.id = matchId(g, i);
    g.overtime = overtimeOf(matches.find((src) => src.teams === g.teams) || g, regTossups);
  });
  const anyTies = agg.teams.some((t) => t.t > 0);

  // YF keeps overtime out of a team's rate stats when overtime has no
  // bonuses: PP20TUH is regulation points over regulation tossups, and an
  // overtime get is not a bonus heard. Per game first, then per team.
  for (const g of games) {
    for (const mt of g.teams) {
      const otCount = (positiveOnly) => vals.reduce((n, v) =>
        n + (positiveOnly && v <= 0 ? 0 : g.overtime.count(mt.name, v)), 0);
      mt.regPoints = mt.points - vals.reduce((s, v) => s + v * g.overtime.count(mt.name, v), 0);
      mt.bonusesHeard = teamGets(mt) - otCount(true);
    }
  }
  for (const t of agg.teams) {
    const mine = games.flatMap((g) => g.teams.filter((mt) => mt.name === t.name).map((mt) => [g, mt]));
    t.regTuh = mine.reduce((s, [g]) => s + g.tossupsRead - g.overtime.tossups, 0);
    t.regPoints = mine.reduce((s, [, mt]) => s + mt.regPoints, 0);
    t.bonusesHeard = mine.reduce((s, [, mt]) => s + mt.bonusesHeard, 0);
  }

  const teams = sortTeamsYf(agg.teams);
  const teamRanks = rankTeams(teams);
  // The stages the .yft gives YF (yft.js yfStages), from the schedule. With
  // one stage played, its name heads the pages and each of its pools is
  // ranked apart, in the pool's own team order for ties, as YF does.
  const plan = schedule ? yfStages(schedule, matches) : null;
  const playedRounds = new Set(agg.games.map((g) => g.round));
  const playedStages = plan ? plan.stages.filter((st) => st.rounds.some((n) => playedRounds.has(n))) : [];
  const stage = playedStages.length === 1 ? playedStages[0] : null;
  const phaseName = stage ? stage.name : PHASE_NAME;
  const byName = new Map(agg.teams.map((t) => [t.name, t]));
  const pools = stage && stage.pools.length > 1 ? stage.pools.map((pl) => {
    const sorted = sortTeamsYf(pl.teams.map((n) => byName.get(n)).filter(Boolean));
    return { name: pl.name, teams: sorted, ranks: rankTeams(sorted) };
  }) : null;
  // With two or more stages played, the stages as the .yft writes them
  // (stagesOf below): each page then goes stage by stage as YF's does.
  const stages = playedStages.length > 1
    ? stagesOf(buildYft({ name, matches, roster, settings, schedule }).objects[0], games) : null;

  // Fractional GP (sum of tuh share per game) + per-match rows, per player.
  const perPlayer = new Map(); // team\nname -> {gp, games: [{g, mt, mp}]}
  const perTeam = new Map();   // name -> [{g, mt, opp}]
  for (const g of games) {
    const [a, b] = g.teams;
    for (const [mt, opp] of [[a, b], [b, a]]) {
      if (!perTeam.has(mt.name)) perTeam.set(mt.name, []);
      perTeam.get(mt.name).push({ g, mt, opp });
      for (const mp of mt.players) {
        if (!mp.tossupsHeard) continue;
        const key = mt.name + '\n' + mp.name;
        if (!perPlayer.has(key)) perPlayer.set(key, { gp: 0, games: [] });
        const entry = perPlayer.get(key);
        entry.gp += mp.tossupsHeard / g.tossupsRead;
        entry.games.push({ g, mt, opp, mp });
      }
    }
  }

  // YF's order (StatSummaries sortPlayersByPptuh): points per tossup
  // heard, then more tossups heard first (fewer, for a player below zero),
  // then the order players first appear in the file's games
  const seenAt = new Map();
  for (const g of games) for (const mt of g.teams) for (const mp of mt.players) {
    const key = mt.name + '\n' + mp.name;
    if (!seenAt.has(key)) seenAt.set(key, seenAt.size);
  }
  const players = agg.players
    .filter((p) => p.tuh > 0)
    .map((p) => ({ ...p, ...perPlayer.get(p.team + '\n' + p.name) }));
  players.sort((x, y) => {
    const xv = x.tuh ? x.points / x.tuh : -999999;
    const yv = y.tuh ? y.points / y.tuh : -999999;
    if (xv !== yv) return yv - xv;
    if (xv > 0 && x.tuh !== y.tuh) return y.tuh - x.tuh;
    if (xv <= 0 && x.tuh !== y.tuh) return x.tuh - y.tuh;
    return (seenAt.get(x.team + '\n' + x.name) ?? 1e9) - (seenAt.get(y.team + '\n' + y.name) ?? 1e9);
  });
  const playerRanks = rankPlayers(players);

  // UG / D2 marks, from the roster; a team or player it lacks has none.
  // Each is its own switch, as in YF: a column, and the lines under a
  // marked team's or player's name, only for a mark the roster tracks.
  const tracked = rosterTracking(roster);
  const trackUG = !!(rules.trackUG ?? tracked.trackUG);
  const trackDiv2 = !!(rules.trackDiv2 ?? tracked.trackDiv2);
  const byTeamName = new Map((roster || []).map((r) => [r.name, r]));
  for (const t of teams) {
    const r = byTeamName.get(t.name) || {};
    t.ug = trackUG && !!r.ug; t.d2 = trackDiv2 && !!r.d2;
  }
  for (const p of players) {
    const mk = ((byTeamName.get(p.team) || {}).marks || {})[p.name] || {};
    p.ug = trackUG && !!mk.ug; p.d2 = trackDiv2 && !!mk.d2;
  }

  const rounds = [...new Set(agg.games.map((g) => g.round))].sort((x, y) => x - y);
  const hasPowers = vals.some((v) => v > 10);
  const hasNegs = vals.some((v) => v < 0);

  return {
    name, filePrefix: prefix ? `${prefix}_` : '', vals, anyTies, teams, teamRanks, players, playerRanks, phaseName, pools, stages, schedule,
    games, rounds, perTeam, hasPowers, hasNegs, regTossups, trackUG, trackDiv2,
  };
}

const valHeaders = (vals) => vals.map((v) => th(String(v), true, '5%'));
const valCells = (counts, vals) => vals.map((v) => numCell(String(counts[v] || 0)));
const valFootCells = (counts, vals) => vals.map((v) => th(String(counts[v] || 0), true));

const record = (t) => (t.t ? `${t.w}-${t.l}-${t.t}` : `${t.w}-${t.l}`);
const paren = (n) => (n < 0 ? `(${n})` : String(n));
const scoreOnly = (g, mine, theirs) => (g.forfeit ? 'Forfeit'
  : `${paren(mine.points)} - ${paren(theirs.points)}${g.overtime.tossups ? ' (OT)' : ''}`);
const resultLetter = (mine, theirs) => resultOf(mine, theirs);

/* ---------- standings ---------- */

function standingsHtml(m) {
  if (m.stages) return stagedStandingsHtml(m);
  const table = (teams, ranks) => {
  const rows = [trTag([
    th('Rank', false, '3%'),
    tdTag({ bold: true, width: '25%' }, 'Team'),
    ...(m.trackUG ? [th(abbr('UG', 'Undergrad'), false, '3%')] : []),
    ...(m.trackDiv2 ? [th(abbr('D2', 'Division 2'), false, '3%')] : []),
    th('W', true, '4%'),
    th('L', true, '3%'),
    ...(m.anyTies ? [th('T', true, '3%')] : []),
    th(abbr('Pct', 'Win percentage'), true, '7%'),
    th(abbr(`PP${m.regTossups}TUH`, `Points scored in regulation per ${m.regTossups} regulation tossups heard`), true, '8%'),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard in regulation'), true, '6%'),
    th(abbr('PPB', 'Points per bonus'), true, '7%'),
  ])];
  teams.forEach((t, i) => {
    rows.push(trTag([
      tdTag({}, ranks[i]),
      textCell(teamLink(m, t.name)),
      ...(m.trackUG ? [tdTag({}, t.ug ? 'UG' : '')] : []),
      ...(m.trackDiv2 ? [tdTag({}, t.d2 ? 'D2' : '')] : []),
      numCell(String(t.w)),
      numCell(String(t.l)),
      ...(m.anyTies ? [numCell(String(t.t))] : []),
      numCell(fmtWinPct(winPct(t))),
      numCell(t.regTuh ? (pptuh(t) * m.regTossups).toFixed(1) : MDASH),
      ...valCells(t.counts, m.vals),
      numCell(String(t.regTuh)),
      numCell(fmtPpb(t.bonusPoints, t.bonusesHeard)),
    ]));
  });
  return tableTag(rows, { cssClass: 'fwBelow1000px' });
  };
  const meta = genericTag('span', esc(m.name));
  const header = headerWithDivider(m, m.phaseName, 'standings.html', { noTopLink: true });
  // the blank lines are YF's: slots it leaves empty here (final ranks, a
  // pool's heading when there is one pool, its tiebreakers)
  const tables = m.pools
    ? m.pools.map((pl) => `${genericTag('h3', esc(pl.name))}\n${table(pl.teams, pl.ranks)}\n`)
    : [`\n${table(m.teams, m.teamRanks)}\n`];
  return `${meta}\n\n${header}\n${tables.join('\n')}<br/>`;
}

// A stage's or several stages' standings row cells, from tally()
function standingsCells(m, t, rank, { anyTies, cumulative = false, advance } = {}) {
  const marks = m.teams.find((x) => x.name === t.name) || {};
  return [
    ...(rank === undefined ? [] : [tdTag({}, rank)]),
    textCell(teamLink(m, t.name)),
    ...(m.trackUG ? [tdTag({}, marks.ug ? 'UG' : '')] : []),
    ...(m.trackDiv2 ? [tdTag({}, marks.d2 ? 'D2' : '')] : []),
    numCell(String(t.w)),
    numCell(String(t.l)),
    ...(anyTies ? [numCell(String(t.t))] : []),
    ...(cumulative ? [] : [numCell(fmtWinPct(winPct(t)))]),
    numCell(t.regTuh ? (pptuh(t) * m.regTossups).toFixed(1) : MDASH),
    ...valCells(t.counts, m.vals),
    numCell(String(t.regTuh)),
    numCell(fmtPpb(t.bonusPoints, t.bonusesHeard)),
    ...(advance === undefined ? [] : [tdTag({}, advance)]),
  ];
}
function standingsHeaderRow(m, { anyTies, cumulative = false, advance = false }) {
  return trTag([
    ...(cumulative ? [] : [th('Rank', false, '3%')]),
    tdTag({ bold: true, width: cumulative ? '' : '25%' }, 'Team'),
    ...(m.trackUG ? [th(abbr('UG', 'Undergrad'), false, '3%')] : []),
    ...(m.trackDiv2 ? [th(abbr('D2', 'Division 2'), false, '3%')] : []),
    th('W', true, '4%'),
    th('L', true, '3%'),
    ...(anyTies ? [th('T', true, '3%')] : []),
    ...(cumulative ? [] : [th(abbr('Pct', 'Win percentage'), true, '7%')]),
    th(abbr(`PP${m.regTossups}TUH`, `Points scored in regulation per ${m.regTossups} regulation tossups heard`), true, '8%'),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard in regulation'), true, '6%'),
    th(abbr('PPB', 'Points per bonus'), true, '7%'),
    ...(advance ? [th('Advanced To')] : []),
  ]);
}

// "Winner def. Loser (box)" lines, for finals and tiebreakers (YF writes
// the names as they are)
function resultList(m, games) {
  return genericTag('ul', games.map((g) => {
    const [a, b] = g.teams;
    const line = a.points === b.points ? `${a.name} tied ${b.name}`
      : a.points > b.points ? `${a.name} def. ${b.name}` : `${b.name} def. ${a.name}`;
    return genericTag('li', `${line} (${gameLink(m, g, 'box')})`);
  }).join('\n'));
}

// The pool stages' standings, from the latest: a table per pool, each
// over the stage's games and the games carried into it. A prelim pool
// carried whole into the one playoff stage gives that stage twice, its
// Total (with the prelims) and then its games Only, as YF does.
// [{kind: 'total' | 'stage', name, st, tables: [{pl, teams, ranks}]}]
function stageSections(m) {
  const S = m.stages;
  const gamesOf = (st) => st.rounds.flatMap((rd) => rd.games);
  const forStage = (st, extra) => {
    const games = [...gamesOf(st), ...extra];
    return st.pools.map((pl) => {
      const stats = tally(games, pl.teams);
      const teams = sortTeamsYf(pl.teams.map((n) => stats.get(n)));
      return { pl, teams, ranks: rankTeams(teams) };
    });
  };
  const out = [];
  for (let i = S.full.length - 1; i >= 0; i--) {
    const st = S.full[i];
    if (!st.pools.some((pl) => pl.teams.length)) continue;
    const both = i === S.full.length - 1 && S.allCarry;
    if (both) out.push({ kind: 'total', name: `${st.name}: Total`, st, tables: forStage(st, gamesOf(S.list.find((x) => x.type === 'Prelim'))) });
    out.push({ kind: 'stage', name: both ? `${st.name} Only` : st.name, st, tables: forStage(st, st.carriedIn) });
  }
  return out;
}

// Every team in its final place, for the New layout's Combined standings:
// the latest stage's brackets in the schedule's order, each team at its
// place in its bracket; then the teams an earlier stage ended, by their
// place in their pool, then winning percentage, then points per tossup;
// and the last final played sets 1st and 2nd. [{name, rank}], rank as
// rankTeams writes it ("3", "4=").
function finalPlacings(m) {
  const brackets = (m.schedule && m.schedule.brackets) || [];
  const at = (name) => { const i = brackets.findIndex((b) => b.name === name); return i < 0 ? Infinity : i; };
  // latest first; a stage shown as Total and Only places by its Total. One
  // stage of pools (the prelims so far): no later stage, so its pools mix
  const all = m.stages ? stageSections(m) : [];
  const secs = m.stages ? all.filter((x) => x.kind === 'total' || !all.some((y) => y.kind === 'total' && y.st === x.st))
    : [{ none: true }, { tables: m.pools.map((pl) => ({ pl, teams: pl.teams, ranks: pl.ranks })) }];
  const out = []; // {name, tie}: teams with one tie key share a place
  const seen = new Set();
  secs.forEach((sec, si) => {
    if (sec.none) return;
    const tables = sec.tables.slice().sort((a, b) => at(a.pl.name) - at(b.pl.name));
    if (si === 0) {
      for (const { pl, teams, ranks } of tables) {
        teams.forEach((t, i) => {
          if (seen.has(t.name)) return;
          seen.add(t.name);
          out.push({ name: t.name, tie: String(ranks[i]).endsWith('=') ? pl.name + '|' + ranks[i] : null });
        });
      }
      return;
    }
    const rest = [];
    for (const { teams } of tables) teams.forEach((t, i) => { if (!seen.has(t.name)) rest.push({ t, place: i }); });
    const num = (x) => (Number.isNaN(x) ? -1 : x);
    rest.sort((a, b) => a.place - b.place || num(winPct(b.t)) - num(winPct(a.t)) || num(pptuh(b.t)) - num(pptuh(a.t)));
    for (const x of rest) { seen.add(x.t.name); out.push({ name: x.t.name, tie: null }); }
  });
  // the finals: the winner of the last final played first, the other second
  const finals = (m.stages ? m.stages.list : []).filter((st) => st.type === 'Finals').flatMap((st) => st.rounds.flatMap((r) => r.games));
  const last = finals.slice().sort((a, b) => a.round - b.round).pop();
  if (last) {
    const [a, b] = last.teams;
    const res = resultOf(a, b);
    if (res === 'W' || res === 'L') {
      const [win, lose] = res === 'W' ? [a.name, b.name] : [b.name, a.name];
      const others = out.filter((x) => x.name !== win && x.name !== lose);
      out.splice(0, out.length, { name: win, tie: null }, { name: lose, tie: null }, ...others);
    }
  }
  // places: shared by a run of one tie key, written "4="
  return out.map((x, i) => {
    let first = i;
    while (x.tie && first > 0 && out[first - 1].tie === x.tie) first--;
    const shared = x.tie && ((i > 0 && out[i - 1].tie === x.tie) || (i + 1 < out.length && out[i + 1].tie === x.tie));
    return { name: x.name, rank: String(first + 1) + (shared ? '=' : '') };
  });
}

// YF's standings for a tournament in stages: finals results, then each
// pool stage from the latest, a table per pool, then every team together.
function stagedStandingsHtml(m) {
  const S = m.stages;
  const sections = [genericTag('span', esc(m.name))];
  const gamesOf = (st) => st.rounds.flatMap((rd) => rd.games);
  sections.push(S.list.filter((st) => st.type === 'Finals').map((st) => {
    const gs = gamesOf(st);
    return gs.length ? `${headerWithDivider(m, st.name, 'standings.html')}\n${genericTag('div', '', resultList(m, gs))}` : '';
  }).reverse().join('\n'));
  const forStage = (st, tables) => {
    const at = S.list.indexOf(st);
    const next = S.list.slice(at + 1).find((x) => x.type === 'Playoff');
    const tb = S.list[at + 1] && S.list[at + 1].type === 'Tiebreaker' ? S.list[at + 1] : null;
    const assigned = !!next && next.pools.some((pl) => pl.teams.length);
    const anyTies = tables.some((x) => x.teams.some((t) => t.t > 0));
    return tables.map(({ pl, teams, ranks }) => {
      const rows = [standingsHeaderRow(m, { anyTies, advance: assigned }),
        ...teams.map((t, i) => trTag(standingsCells(m, t, ranks[i], {
          anyTies, advance: assigned ? ((next.pools.find((x) => x.teams.includes(t.name)) || {}).name || '') : undefined,
        })))];
      const tbGames = tb ? gamesOf(tb).filter((g) => g.teams.some((x) => pl.teams.includes(x.name))) : [];
      const tbList = tbGames.length
        ? tagWithAttrs('div', [cls('smallText')], genericTag('span', 'Tiebreakers:'), resultList(m, tbGames)) : '';
      const head = st.pools.length > 1 ? genericTag('h3', esc(pl.name)) : '';
      return `${head}\n${tableTag(rows, { cssClass: assigned ? undefined : 'fwBelow1000px' })}\n${tbList}`;
    }).join('\n') + '<br/>';
  };
  let printed = 0;
  let combined = false;
  for (const sec of stageSections(m)) {
    if (sec.kind === 'total') combined = true;
    else printed++;
    sections.push(`${headerWithDivider(m, sec.name, 'standings.html', { noTopLink: printed === 1 })}\n${forStage(sec.st, sec.tables)}`);
  }
  if (S.list.length > 1 && !combined) {
    const all = tally(m.games, S.teamOrder);
    const teams = [...all.values()].sort((a, b) => {
      let ap = a.bonusesHeard ? a.bonusPoints / a.bonusesHeard : NaN;
      let bp = b.bonusesHeard ? b.bonusPoints / b.bonusesHeard : NaN;
      if (Number.isNaN(ap)) ap = -9999999;
      if (Number.isNaN(bp)) bp = -9999999;
      return bp - ap;
    });
    const anyTies = teams.some((t) => t.t > 0);
    const rows = [standingsHeaderRow(m, { anyTies, cumulative: true }),
      ...teams.map((t) => trTag(standingsCells(m, t, undefined, { anyTies, cumulative: true })))];
    sections.push(`${headerWithDivider(m, 'Cumulative', 'standings.html')}\n${tableTag(rows, { cssClass: 'fwBelow1000px' })}`);
  }
  return sections.join('\n');
}

/* ---------- individuals ---------- */

function individualsTable(m, players, ranks) {
  const rows = [trTag([
    ...(ranks ? [tdTag({ bold: true }, 'Rank')] : []),
    th('Player'),
    ...(m.trackUG ? [th(abbr('UG', 'Undergrad'))] : []),
    ...(m.trackDiv2 ? [th(abbr('D2', 'Division 2'))] : []),
    th('Team'),
    th(abbr('GP', 'Games played'), true),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true),
    th(abbr(`PP${m.regTossups}TUH`, `Points per ${m.regTossups} tossups heard`), true),
  ])];
  players.forEach((p, i) => {
    rows.push(trTag([
      ...(ranks ? [tdTag({}, ranks[i])] : []),
      textCell(playerLink(m, p.team, p.name)),
      ...(m.trackUG ? [tdTag({}, p.ug ? 'UG' : '')] : []),
      ...(m.trackDiv2 ? [tdTag({}, p.d2 ? 'D2' : '')] : []),
      textCell(teamLink(m, p.team)),
      numCell(p.gp.toFixed(1)),
      ...valCells(p.counts, m.vals),
      numCell(String(p.tuh)),
      numCell(((p.points / p.tuh) * m.regTossups).toFixed(2)),
    ]));
  });
  return tableTag(rows, { cssClass: 'fwBelow1000px' });
}

// One stage: its players. In stages, YF ranks the prelim players, then
// lists everyone's whole day unranked.
function individualsHtml(m) {
  if (!m.stages) {
    const header = headerWithDivider(m, m.phaseName, 'individuals.html', { noTopLink: true });
    return `${header}\n${individualsTable(m, m.players, m.playerRanks)}`;
  }
  const first = m.stages.full[0];
  const prelim = playersOf(m, first.rounds.flatMap((rd) => rd.games).concat(first.carriedIn));
  return [
    `${headerWithDivider(m, first.name, 'individuals.html', { noTopLink: true })}\n${individualsTable(m, prelim, rankPlayers(prelim))}`,
    `${headerWithDivider(m, 'All Games', 'individuals.html')}\n${individualsTable(m, m.players, null)}`,
  ].join('\n');
}

/* ---------- scoreboard ---------- */

function boxScoreTeamTable(mt, vals) {
  const rows = [trTag([
    th(esc(truncName(mt.name))),
    th('TUH', true),
    ...valHeaders(vals),
    th('Tot', true, '8%'),
  ])];
  for (const p of mt.players) {
    if (!p.tossupsHeard) continue; // YF lists the players who heard a tossup
    const counts = Object.fromEntries(p.counts.map((c) => [c.value, c.n]));
    rows.push(trTag([
      tdTag({}, esc(p.name)),
      numCell(String(p.tossupsHeard)),
      ...valCells(counts, vals),
      numCell(String(playerPoints(p))),
    ]));
  }
  rows.push(trFoot([
    tdTag({ bold: true }, 'Total'),
    tdTag({}, ''),
    ...valFootCells(teamCounts(mt), vals),
    th(String(mt.tossupPoints), true),
  ]));
  return tableTag(rows, { width: '35%' });
}

function boxScoreBonusTable(g) {
  const rows = [trTag([
    tdTag({ bold: true, width: '40%' }, 'Bonuses'),
    tdTag({ bold: true, align: 'right', width: '20%' }, 'Heard'),
    tdTag({ bold: true, align: 'right', width: '20%' }, 'Pts'),
    tdTag({ bold: true, align: 'right', width: '20%' }, 'PPB'),
  ])];
  for (const mt of g.teams) {
    const heard = teamBonusesHeard(mt);
    rows.push(trTag([
      tdTag({}, esc(truncName(mt.name))),
      numCell(String(heard)),
      numCell(String(mt.bonusPoints)),
      numCell(heard ? (mt.bonusPoints / heard).toFixed(2) : '--'), // a box score's blank, not the tables' dash
    ]));
  }
  return tableTag(rows);
}

function scoreString(g) {
  const [a, b] = g.teams;
  if (g.forfeit) {
    const lost = a.forfeitLoss ? a : b;
    return `${esc((lost === a ? b : a).name)} defeats ${esc(lost.name)} by forfeit`;
  }
  const win = b.points > a.points ? b : a;
  const lose = win === a ? b : a;
  return `${esc(win.name)} ${win.points}, ${esc(lose.name)} ${lose.points}${g.overtime.tossups ? ' (OT)' : ''}`;
}

function boxScore(m, g) {
  const tossups = `Tossups read: ${g.tossupsRead}${g.overtime.tossups ? ` (${g.overtime.tossups} in OT)` : ''}`;
  if (g.forfeit) {
    return [tagWithAttrs('div', [`id=${gameAnchor(g)}`, cls('boxScoreAnchor')]), tagWithAttrs('h3', [cls('boxScoreTitle')], scoreString(g))].join('\n');
  }
  return [
    tagWithAttrs('div', [`id=${gameAnchor(g)}`, cls('boxScoreAnchor')]),
    tagWithAttrs('h3', [cls('boxScoreTitle')], scoreString(g)),
    // a prelim game a playoff bracket carries, named as YF does
    ...((m.stages && (m.stages.carryOf.get(g) || []).length)
      ? [genericTag('p', `Carries over to: ${m.stages.carryOf.get(g).map((st) => st.name).join(', ')}`)] : []),
    genericTag('p', tossups),
    tagWithAttrs('div', [cls('boxScoreTable')], boxScoreTeamTable(g.teams[0], m.vals), boxScoreTeamTable(g.teams[1], m.vals)),
    '<br />',
    boxScoreBonusTable(g),
  ].join('\n');
}

function scoreboardHtml(m) {
  // the table of contents names each stage, then its rounds indented under
  // it; a round's heading names its stage, finals and tiebreakers aside
  const stages = m.stages ? m.stages.list.map((st) => ({ name: st.name, full: st.full, numeric: st.numeric,
    rounds: st.rounds.filter((rd) => rd.games.length).map((rd) => rd.number) }))
    : [{ name: m.phaseName, full: true, numeric: true, rounds: m.rounds }];
  const toc = tagWithAttrs('div', [cls('floatingTOC')], genericTag('ul', stages.filter((st) => st.rounds.length).flatMap((st) => (st.numeric
    ? [st.name, ...st.rounds.map((r) => `${NBSP}${NBSP}${roundLink(m, r, `Round ${r}`)}`)]
    : [roundLink(m, st.rounds[0], st.name)])).map((item) => genericTag('li', item)).join('\n')));
  const sections = stages.flatMap((st) => st.rounds.map((r) => genericTag('div', [
    ...(r !== 1 ? ['<br /><br />'] : []),
    tagWithAttrs('div', [`id=Round-${r}`]),
    headerWithDivider(m, `Round ${r}${st.full ? ` - ${st.name}` : ''}`, 'games.html', { noTopLink: r === 1, sticky: true }),
    ...m.games.filter((g) => g.round === r).map((g) => boxScore(m, g)),
  ].join('\n'))));
  return `${toc}\n${sections.join('\n')}`;
}

// A cell naming the stages a game was played in or carried to, in their
// colors (YF's; two blend corner to corner)
function stageCell(stages) {
  if (!stages.length) return textCell('');
  const colors = stages.map((st) => st.color).filter((c) => c !== '');
  const style = colors.length === 1 ? `background-color:${colors[0]}`
    : `background-image: linear-gradient(to bottom right, ${colors[0]} 50%, ${colors[1]} 51%)`;
  return tagWithAttrs('td', [attr('style', style)], stages.map((st) => st.name).join(', '));
}

/* ---------- team detail ---------- */

function teamDetailMatchTable(m, t) {
  const S = m.stages;
  const rows = [trTag([
    tdTag({ bold: true, width: '5%' }, 'Round'),
    ...(S ? [tdTag({ bold: true, width: '12%' }, 'Stage')] : []),
    ...(S && S.anyCarry ? [tdTag({ bold: true, width: '8%' }, 'Carried To')] : []),
    th('Opponent'),
    th(''),
    th('Score'),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true),
    th(abbr('BHrd', 'Bonuses heard'), true),
    th(abbr('BPts', 'Points scored on bonuses'), true),
    th(abbr('PPB', 'Points per bonus'), true),
  ])];
  for (const { g, mt, opp } of m.perTeam.get(t.name) || []) {
    const heard = teamBonusesHeard(mt);
    rows.push(trTag([
      textCell(String(g.round)),
      ...(S ? [stageCell([S.stageOf.get(g)].filter(Boolean))] : []),
      ...(S && S.anyCarry ? [stageCell(S.carryOf.get(g) || [])] : []),
      textCell(teamLink(m, opp.name)),
      textCell(resultLetter(mt, opp)),
      textCell(gameLink(m, g, scoreOnly(g, mt, opp))),
      ...(g.forfeit ? m.vals.map(() => numCell('')) : valCells(teamCounts(mt), m.vals)),
      numCell(g.forfeit ? '' : String(g.tossupsRead)),
      numCell(g.forfeit ? '' : String(heard)),
      numCell(g.forfeit ? '' : String(mt.bonusPoints)),
      numCell(g.forfeit ? '' : heard ? (mt.bonusPoints / heard).toFixed(2) : MDASH),
    ]));
  }
  rows.push(trFoot([
    textCell(''),
    ...(S ? [textCell('')] : []),
    ...(S && S.anyCarry ? [textCell('')] : []),
    th('Total'),
    th(record(t)),
    th(''),
    ...valFootCells(t.counts, m.vals),
    th(String(t.tuh), true),
    th(String(t.bonusesHeard), true),
    th(String(t.bonusPoints), true),
    th(fmtPpb(t.bonusPoints, t.bonusesHeard), true),
  ]));
  return tableTag(rows, { width: '100%' });
}

// A marked team's or player's heading: YF writes what it is marked as on
// an italic line under the name, and closes the heading up to it. `x` is a
// model team or player, its marks already limited to the tracked ones.
function detailHeading(id, title, x) {
  const attrs = [x.ug && 'Undergraduate', x.d2 && 'Division II'].filter(Boolean).join(', ');
  if (!attrs) return [tagWithAttrs('h2', [`id=${id}`], title)];
  return [
    tagWithAttrs('h2', [`id=${id}`, 'style="margin-bottom:0"'], title),
    tagWithAttrs('div', ['style="margin-bottom:15px; font-style: italic"'], attrs),
  ];
}

function teamDetailPlayerTable(m, t) {
  const onTeam = m.players.filter((p) => p.team === t.name);
  if (!onTeam.length) return '';
  const rows = [trTag([
    th('Player'),
    ...(m.trackUG ? [th(abbr('UG', 'Undergrad'))] : []),
    ...(m.trackDiv2 ? [th(abbr('D2', 'Division 2'))] : []),
    th(abbr('GP', 'Games played'), true),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true, '10%'),
    th(abbr(`PP${m.regTossups}TUH`, `Points per ${m.regTossups} tossups heard`), true, '12%'),
  ])];
  for (const p of onTeam) {
    rows.push(trTag([
      textCell(playerLink(m, p.team, p.name)),
      ...(m.trackUG ? [textCell(p.ug ? 'UG' : '')] : []),
      ...(m.trackDiv2 ? [textCell(p.d2 ? 'D2' : '')] : []),
      numCell(p.gp.toFixed(1)),
      ...valCells(p.counts, m.vals),
      numCell(String(p.tuh)),
      numCell(((p.points / p.tuh) * m.regTossups).toFixed(2)),
    ]));
  }
  return tableTag(rows, { cssClass: 'fwBelow800px' });
}

function teamDetailHtml(m) {
  const byName = [...m.teams].sort((a, b) => {
    const an = a.name.toLocaleUpperCase(); const bn = b.name.toLocaleUpperCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return byName.map((t) => [
    ...detailHeading(alphaOnly(t.name), esc(t.name), t),
    teamDetailMatchTable(m, t),
    '<br />',
    teamDetailPlayerTable(m, t),
  ].join('\n')).join('\n');
}

/* ---------- player detail ---------- */

function playerDetailTable(m, p) {
  const S = m.stages;
  const rows = [trTag([
    tdTag({ bold: true, width: '5%' }, 'Round'),
    ...(S ? [tdTag({ bold: true, width: '15%' }, 'Stage')] : []),
    th('Opponent'),
    th(''),
    th('Score'),
    th(abbr('GP', 'Games played'), true),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true),
    th('Pts', true),
  ])];
  for (const { g, mt, opp, mp } of p.games) {
    const counts = Object.fromEntries(mp.counts.map((c) => [c.value, c.n]));
    rows.push(trTag([
      textCell(String(g.round)),
      ...(S ? [stageCell([S.stageOf.get(g)].filter(Boolean))] : []),
      textCell(teamLink(m, opp.name)),
      textCell(resultLetter(mt, opp)),
      textCell(gameLink(m, g, scoreOnly(g, mt, opp))),
      numCell((mp.tossupsHeard / g.tossupsRead).toFixed(1)),
      ...valCells(counts, m.vals),
      numCell(String(mp.tossupsHeard)),
      numCell(String(playerPoints(mp))),
    ]));
  }
  rows.push(trFoot([
    textCell(''),
    ...(S ? [textCell('')] : []),
    th('Total'),
    textCell(''),
    textCell(''),
    th(p.gp.toFixed(1), true),
    ...valFootCells(p.counts, m.vals),
    th(String(p.tuh), true),
    th(String(p.points), true),
  ]));
  return tableTag(rows, { cssClass: 'fwBelow1000px' });
}

function playerDetailHtml(m) {
  const sorted = [...m.players].sort((a, b) => {
    const at = a.team.toLocaleUpperCase(); const bt = b.team.toLocaleUpperCase();
    if (at !== bt) return at < bt ? -1 : 1;
    const an = a.name.toLocaleUpperCase(); const bn = b.name.toLocaleUpperCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return sorted.map((p) => [
    ...detailHeading(`${alphaOnly(p.team)}-${alphaOnly(p.name)}`, `${esc(p.name)}, ${esc(p.team)}`, p),
    playerDetailTable(m, p),
  ].join('\n')).join('\n');
}

/* ---------- round report ---------- */

// YF's round figures, as it computes them: every point over regulation
// tossups (negs likewise), powers and conversion over all tossups read,
// and every get — overtime's too — counted as a bonus heard.
function roundTotals(games) {
  const s = { games: games.length, tuh: 0, regTuh: 0, points: 0, powers: 0, gets: 0, negs: 0, bonusPts: 0, bonusesHeard: 0 };
  for (const g of games) {
    s.tuh += g.tossupsRead;
    s.regTuh += g.tossupsRead - g.overtime.tossups;
    for (const mt of g.teams) {
      s.points += mt.points;
      s.bonusPts += mt.bonusPoints;
      s.bonusesHeard += teamGets(mt);
      for (const [v, n] of Object.entries(teamCounts(mt))) {
        const val = Number(v);
        if (val > 10) s.powers += n;
        if (val > 0) s.gets += n;
        if (val < 0) s.negs += n;
      }
    }
  }
  return s;
}

function roundReportHtml(m) {
  const S = m.stages;
  const cw = S ? '9%' : '10%';
  const rows = [trTag([
    th('Round', false, '10%'),
    ...(S ? [th('Stage', false, '15%')] : []),
    th('Games', true, '10%'),
    th(abbr(`Pts/Tm/${m.regTossups}TUH`, `Points per team per ${m.regTossups} tossups heard`), true, cw),
    ...(m.hasPowers ? [th(abbr('TU Powered', 'Percentage of tossups powered by either team'), true, cw)] : []),
    th(abbr('TU Converted', 'Percentage of tossups answered correctly by either team'), true, cw),
    ...(m.hasNegs ? [th(abbr(`Negs/Tm/${m.regTossups}TUH`,
      `Incorrect tossup interrupts per team per ${m.regTossups} tossups heard`), true, cw)] : []),
    th(abbr('PPB', 'Points per bonus'), true, cw),
  ])];

  const statCells = (s, cell) => [
    cell(String(s.games)),
    cell(s.regTuh ? ((m.regTossups * s.points) / s.regTuh / 2).toFixed(1) : MDASH),
    ...(m.hasPowers ? [cell(s.tuh ? `${((100 * s.powers) / s.tuh).toFixed(0)}%` : MDASH)] : []),
    cell(s.tuh ? `${((100 * s.gets) / s.tuh).toFixed(0)}%` : MDASH),
    ...(m.hasNegs ? [cell(s.regTuh ? ((m.regTossups * s.negs) / s.regTuh / 2).toFixed(1) : MDASH)] : []),
    cell(s.bonusesHeard ? (s.bonusPts / s.bonusesHeard).toFixed(2) : MDASH),
  ];
  const asNum = (text) => numCell(text);
  const asFoot = (text) => th(text, true);

  const played = m.games.filter((g) => !g.forfeit); // YF counts no forfeit as a game
  for (const r of m.rounds) {
    const games = played.filter((g) => g.round === r);
    if (!games.length) continue;
    rows.push(trTag([
      textCell(roundLink(m, r, String(r))),
      ...(S ? [stageCell([S.stageOf.get(games[0])].filter(Boolean))] : []),
      ...statCells(roundTotals(games), asNum),
    ]));
  }
  rows.push(trFoot([th('Total'), ...(S ? [th('')] : []), ...statCells(roundTotals(played), asFoot)]));
  return tableTag(rows);
}

/* ---------- the same numbers, as data ---------- */

/**
 * Everything the report shows, as plain data rather than YF's HTML: the
 * public page's New layout draws its own tables from this, so the two
 * layouts can never disagree on a number. Same model, same formulas, same
 * order; rates are numbers (null where the report shows a dash).
 * `anchor`s are the ids the on-page Classic report gives the same team,
 * player or game (reportframe.js), so switching layouts keeps the place.
 * @param opts as buildReport
 */
export function reportData(opts) {
  const m = reportModel(opts);
  const ratio = (a, b) => (b ? a / b : null);
  const regPer = (pts, tuh) => (tuh ? (pts / tuh) * m.regTossups : null);
  const round = (r, g) => {
    const s = roundTotals(g);
    return {
      round: r, games: s.games,
      ppTeam: s.regTuh ? (m.regTossups * s.points) / s.regTuh / 2 : null,
      powerPct: s.tuh ? (100 * s.powers) / s.tuh : null,
      convPct: s.tuh ? (100 * s.gets) / s.tuh : null,
      negsTeam: s.regTuh ? (m.regTossups * s.negs) / s.regTuh / 2 : null,
      ppb: ratio(s.bonusPts, s.bonusesHeard),
    };
  };
  const gameRow = ({ g, mt, opp }) => ({
    gameId: g.id, round: g.round, opp: opp.name, result: resultLetter(mt, opp),
    score: scoreOnly(g, mt, opp),
  });
  // standings rows for a stage's pool (tally() figures, or a team row)
  const marksOf = new Map(m.teams.map((t) => [t.name, t]));
  const standRow = (t, rank) => ({
    name: t.name, ug: (marksOf.get(t.name) || {}).ug, d2: (marksOf.get(t.name) || {}).d2,
    rank, w: t.w, l: t.l, t: t.t, pp: t.regTuh ? pptuh(t) * m.regTossups : null,
    counts: t.counts, regTuh: t.regTuh, ppb: ratio(t.bonusPoints, t.bonusesHeard),
  });
  // With a schedule: the standings by stage and pool, as the Classic
  // report heads them (latest stage first, carried-over games counted),
  // or the pools of the one stage played; null without stages or pools
  // Each pool also says which rounds its games come from (`rounds`): the
  // stage's own, the prelims' for a Total, and the earlier stages' when
  // the pool carries its pool-mates' games over.
  const roundsOf = (st) => st.rounds.map((r) => r.number);
  const stageStandings = m.stages
    ? stageSections(m).map((sec) => {
      const S = m.stages;
      const base = [...roundsOf(sec.st), ...(sec.kind === 'total' ? roundsOf(S.list.find((x) => x.type === 'Prelim')) : [])];
      const earlier = S.list.slice(0, S.list.indexOf(sec.st)).filter((x) => x.full).flatMap(roundsOf);
      return { name: sec.name, stage: sec.st.name, own: roundsOf(sec.st), pools: sec.tables.map(({ pl, teams, ranks }) => ({
        name: pl.name, rounds: [...new Set([...base, ...(pl.carry ? earlier : [])])].sort((a, b) => a - b),
        teams: teams.map((t, i) => standRow(t, ranks[i])) })) };
    })
    : m.pools ? [{ name: m.phaseName, stage: m.phaseName, own: null, pools: m.pools.map((pl) => ({ name: pl.name, rounds: null,
      teams: pl.teams.map((t, i) => standRow(t, pl.ranks[i])) })) }]
      : null;
  // Combined: each team's whole day, in its final place
  const byName = new Map(m.teams.map((t) => [t.name, t]));
  const combined = m.stages || m.pools
    ? finalPlacings(m).filter((x) => byName.has(x.name)).map((x) => standRow(byName.get(x.name), x.rank)) : null;
  return {
    name: m.name, vals: m.vals, regTossups: m.regTossups, anyTies: m.anyTies,
    trackUG: m.trackUG, trackDiv2: m.trackDiv2, stageStandings, combined,
    hasPowers: m.hasPowers, hasNegs: m.hasNegs,
    teams: m.teams.map((t, i) => {
      const pct = winPct(t);
      return {
        name: t.name, anchor: `teamdetail-${alphaOnly(t.name)}`, ug: t.ug, d2: t.d2,
        rank: m.teamRanks[i], w: t.w, l: t.l, t: t.t, record: record(t),
        pct: Number.isNaN(pct) ? null : pct, pp: t.regTuh ? pptuh(t) * m.regTossups : null,
        counts: t.counts, regTuh: t.regTuh, tuh: t.tuh,
        bonusesHeard: t.bonusesHeard, bonusPoints: t.bonusPoints, ppb: ratio(t.bonusPoints, t.bonusesHeard),
        games: (m.perTeam.get(t.name) || []).map((x) => ({
          ...gameRow(x), counts: teamCounts(x.mt), tuh: x.g.tossupsRead,
          bonusesHeard: teamBonusesHeard(x.mt), bonusPoints: x.mt.bonusPoints,
          ppb: ratio(x.mt.bonusPoints, teamBonusesHeard(x.mt)),
        })),
      };
    }),
    players: m.players.map((p, i) => ({
      name: p.name, team: p.team, anchor: `playerdetail-${alphaOnly(p.team)}-${alphaOnly(p.name)}`, ug: p.ug, d2: p.d2,
      rank: m.playerRanks[i], gp: p.gp, counts: p.counts,
      tuh: p.tuh, points: p.points, pp: regPer(p.points, p.tuh),
      games: p.games.map((x) => ({
        ...gameRow(x), gp: x.mp.tossupsHeard / x.g.tossupsRead,
        counts: Object.fromEntries(x.mp.counts.map((c) => [c.value, c.n])),
        tuh: x.mp.tossupsHeard, points: playerPoints(x.mp),
      })),
    })),
    games: m.games.map((g) => {
      const [a, b] = g.teams;
      const win = resultOf(b, a) === 'W' ? b : a;
      return {
        id: g.id, anchor: `games-${gameAnchor(g)}`, round: g.round, tossupsRead: g.tossupsRead, otTossups: g.overtime.tossups,
        ...(g.forfeit ? { forfeit: true } : {}),
        fileId: g.fileId, // the public page's scoresheet finds the game's qbj by it

        winner: win.name, loser: (win === a ? b : a).name,
        teams: g.teams.map((mt) => ({
          name: mt.name, points: mt.points, tossupPoints: mt.tossupPoints, counts: teamCounts(mt),
          ...(mt.forfeitLoss ? { forfeitLoss: true } : {}),
          bonusesHeard: teamBonusesHeard(mt), bonusPoints: mt.bonusPoints,
          ppb: ratio(mt.bonusPoints, teamBonusesHeard(mt)),
          players: mt.players.filter((p) => p.tossupsHeard).map((p) => ({
            name: p.name, tuh: p.tossupsHeard,
            counts: Object.fromEntries(p.counts.map((c) => [c.value, c.n])), points: playerPoints(p),
          })),
        })),
      };
    }),
    rounds: m.rounds.map((r) => round(r, m.games.filter((g) => g.round === r))),
    total: round(null, m.games),
  };
}

/* ---------- entry point ---------- */

/**
 * @param opts {name, matches, roster, prefix} — the shape the .yft export
 *   takes (parsed matches, deduped via aggregate, + optional roster), and
 *   an optional filename prefix for a report that will be saved to disk.
 * @returns [{name, text}] — the six report files.
 */
export function buildReport(opts) {
  const m = reportModel(opts);
  if (!m.games.length) throw new Error('no games to report');
  const contents = {
    'standings.html': standingsHtml(m),
    'individuals.html': individualsHtml(m),
    'games.html': scoreboardHtml(m),
    'teamdetail.html': teamDetailHtml(m),
    'playerdetail.html': playerDetailHtml(m),
    'rounds.html': roundReportHtml(m),
  };
  return PAGES.map((p) => ({
    name: m.filePrefix + p.file,
    text: htmlPage(m, p.heading, contents[p.file], p.file === 'rounds.html'),
  }));
}
