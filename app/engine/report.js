// report.js — generate YellowFruit's static HTML stat report directly from
// parsed matches (qbj.js parseMatch output) + an optional roster, so a TD
// gets the standard six-page report without round-tripping through
// YellowFruit. Page set, layout, CSS, link scheme, and stat formulas are
// ported from YellowFruit 4.0.18 (HTMLReports.ts / StatSummaries.ts),
// reduced to qb-td's model: one phase, no pools/finals, no SS/JV/UG/D2
// tracking, no lightning rounds, bouncebacks folded into bonus points.
//
// buildReport({name, matches, roster, prefix}) -> [{name, text}] — the six
// files (standings/individuals/games/teamdetail/playerdetail/rounds .html),
// interlinked by filename, ready to zip or host as a folder. With a prefix
// they are named and linked `<prefix>_standings.html` etc., which is how
// YellowFruit saves a report to disk and what the hsquizbowl.org tournament
// database expects to be handed; the bare names are YF's in-app preview.

import { aggregate } from './stats.js';
import { answerTypes, importOrder, matchId, overtimeOf, schoolAndLetter, PHASE_NAME } from './yft.js';

// Stat display scaling: points per 20 tossups heard, the convention used
// across qb-td (and YellowFruit's default regulation tossup count).
const REG_TUH = 20;

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

/* ---------- report model ---------- */

// One derived bundle every page reads: YF-ordered team rows, player rows
// with fractional games played, per-round game lists.
function reportModel({ name, matches, roster, prefix }) {
  const agg = aggregate(matches, roster);
  // the columns, game order and match ids of the .yft YF would hold
  const vals = answerTypes(matches).values;
  const games = importOrder(agg.games);
  games.forEach((g, i) => {
    g.id = matchId(g, i);
    g.overtime = overtimeOf(matches.find((src) => src.teams === g.teams) || g);
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

  const players = agg.players
    .filter((p) => p.tuh > 0)
    .map((p) => ({ ...p, ...perPlayer.get(p.team + '\n' + p.name) }));
  players.sort((x, y) => {
    const xv = x.tuh ? x.points / x.tuh : -9999999;
    const yv = y.tuh ? y.points / y.tuh : -9999999;
    return yv - xv || x.name.localeCompare(y.name);
  });
  const playerRanks = rankPlayers(players);

  const rounds = [...new Set(agg.games.map((g) => g.round))].sort((x, y) => x - y);
  const hasPowers = vals.some((v) => v > 10);
  const hasNegs = vals.some((v) => v < 0);

  return {
    name, filePrefix: prefix ? `${prefix}_` : '', vals, anyTies, teams, teamRanks, players, playerRanks,
    games, rounds, perTeam, hasPowers, hasNegs,
  };
}

const valHeaders = (vals) => vals.map((v) => th(String(v), true, '5%'));
const valCells = (counts, vals) => vals.map((v) => numCell(String(counts[v] || 0)));
const valFootCells = (counts, vals) => vals.map((v) => th(String(counts[v] || 0), true));

const record = (t) => (t.t ? `${t.w}-${t.l}-${t.t}` : `${t.w}-${t.l}`);
const paren = (n) => (n < 0 ? `(${n})` : String(n));
const scoreOnly = (g, mine, theirs) =>
  `${paren(mine.points)} - ${paren(theirs.points)}${g.overtime.tossups ? ' (OT)' : ''}`;
const resultLetter = (mine, theirs) =>
  (mine.points > theirs.points ? 'W' : mine.points < theirs.points ? 'L' : 'T');

/* ---------- standings ---------- */

function standingsHtml(m) {
  const rows = [trTag([
    th('Rank', false, '3%'),
    tdTag({ bold: true, width: '25%' }, 'Team'),
    th('W', true, '4%'),
    th('L', true, '3%'),
    ...(m.anyTies ? [th('T', true, '3%')] : []),
    th(abbr('Pct', 'Win percentage'), true, '7%'),
    th(abbr(`PP${REG_TUH}TUH`, `Points scored in regulation per ${REG_TUH} regulation tossups heard`), true, '8%'),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard in regulation'), true, '6%'),
    th(abbr('PPB', 'Points per bonus'), true, '7%'),
  ])];
  m.teams.forEach((t, i) => {
    rows.push(trTag([
      tdTag({}, m.teamRanks[i]),
      textCell(teamLink(m, t.name)),
      numCell(String(t.w)),
      numCell(String(t.l)),
      ...(m.anyTies ? [numCell(String(t.t))] : []),
      numCell(fmtWinPct(winPct(t))),
      numCell(t.regTuh ? (pptuh(t) * REG_TUH).toFixed(1) : MDASH),
      ...valCells(t.counts, m.vals),
      numCell(String(t.regTuh)),
      numCell(fmtPpb(t.bonusPoints, t.bonusesHeard)),
    ]));
  });
  const meta = genericTag('span', esc(m.name));
  const header = headerWithDivider(m, PHASE_NAME, 'standings.html', { noTopLink: true });
  // the blank lines are YF's: slots it leaves empty for a one-stage,
  // one-pool tournament (no final ranks, pool heading or tiebreakers)
  return `${meta}\n\n${header}\n\n${tableTag(rows, { cssClass: 'fwBelow1000px' })}\n<br/>`;
}

/* ---------- individuals ---------- */

function individualsHtml(m) {
  const rows = [trTag([
    tdTag({ bold: true }, 'Rank'),
    th('Player'),
    th('Team'),
    th(abbr('GP', 'Games played'), true),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true),
    th(abbr(`PP${REG_TUH}TUH`, `Points per ${REG_TUH} tossups heard`), true),
  ])];
  m.players.forEach((p, i) => {
    rows.push(trTag([
      tdTag({}, m.playerRanks[i]),
      textCell(playerLink(m, p.team, p.name)),
      textCell(teamLink(m, p.team)),
      numCell(p.gp.toFixed(1)),
      ...valCells(p.counts, m.vals),
      numCell(String(p.tuh)),
      numCell(((p.points / p.tuh) * REG_TUH).toFixed(2)),
    ]));
  });
  const header = headerWithDivider(m, 'All Games', 'individuals.html', { noTopLink: true });
  return `${header}\n${tableTag(rows, { cssClass: 'fwBelow1000px' })}`;
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
  const win = b.points > a.points ? b : a;
  const lose = win === a ? b : a;
  return `${esc(win.name)} ${win.points}, ${esc(lose.name)} ${lose.points}${g.overtime.tossups ? ' (OT)' : ''}`;
}

function boxScore(m, g) {
  const tossups = `Tossups read: ${g.tossupsRead}${g.overtime.tossups ? ` (${g.overtime.tossups} in OT)` : ''}`;
  return [
    tagWithAttrs('div', [`id=${gameAnchor(g)}`, cls('boxScoreAnchor')]),
    tagWithAttrs('h3', [cls('boxScoreTitle')], scoreString(g)),
    genericTag('p', tossups),
    tagWithAttrs('div', [cls('boxScoreTable')], boxScoreTeamTable(g.teams[0], m.vals), boxScoreTeamTable(g.teams[1], m.vals)),
    '<br />',
    boxScoreBonusTable(g),
  ].join('\n');
}

function scoreboardHtml(m) {
  // the table of contents names the stage, then its rounds indented under it
  const toc = tagWithAttrs('div', [cls('floatingTOC')], genericTag('ul', [
    PHASE_NAME, ...m.rounds.map((r) => `${NBSP}${NBSP}${roundLink(m, r, `Round ${r}`)}`),
  ].map((item) => genericTag('li', item)).join('\n')));
  const sections = m.rounds.map((r) => genericTag('div', [
    ...(r !== 1 ? ['<br /><br />'] : []),
    tagWithAttrs('div', [`id=Round-${r}`]),
    headerWithDivider(m, `Round ${r} - ${PHASE_NAME}`, 'games.html', { noTopLink: r === 1, sticky: true }),
    ...m.games.filter((g) => g.round === r).map((g) => boxScore(m, g)),
  ].join('\n')));
  return `${toc}\n${sections.join('\n')}`;
}

/* ---------- team detail ---------- */

function teamDetailMatchTable(m, t) {
  const rows = [trTag([
    tdTag({ bold: true, width: '5%' }, 'Round'),
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
      textCell(teamLink(m, opp.name)),
      textCell(resultLetter(mt, opp)),
      textCell(gameLink(m, g, scoreOnly(g, mt, opp))),
      ...valCells(teamCounts(mt), m.vals),
      numCell(String(g.tossupsRead)),
      numCell(String(heard)),
      numCell(String(mt.bonusPoints)),
      numCell(heard ? (mt.bonusPoints / heard).toFixed(2) : MDASH),
    ]));
  }
  rows.push(trFoot([
    textCell(''),
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

function teamDetailPlayerTable(m, t) {
  const onTeam = m.players.filter((p) => p.team === t.name);
  if (!onTeam.length) return '';
  const rows = [trTag([
    th('Player'),
    th(abbr('GP', 'Games played'), true),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true, '10%'),
    th(abbr(`PP${REG_TUH}TUH`, `Points per ${REG_TUH} tossups heard`), true, '12%'),
  ])];
  for (const p of onTeam) {
    rows.push(trTag([
      textCell(playerLink(m, p.team, p.name)),
      numCell(p.gp.toFixed(1)),
      ...valCells(p.counts, m.vals),
      numCell(String(p.tuh)),
      numCell(((p.points / p.tuh) * REG_TUH).toFixed(2)),
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
    tagWithAttrs('h2', [`id=${alphaOnly(t.name)}`], esc(t.name)),
    teamDetailMatchTable(m, t),
    '<br />',
    teamDetailPlayerTable(m, t),
  ].join('\n')).join('\n');
}

/* ---------- player detail ---------- */

function playerDetailTable(m, p) {
  const rows = [trTag([
    tdTag({ bold: true, width: '5%' }, 'Round'),
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
    tagWithAttrs('h2', [`id=${alphaOnly(p.team)}-${alphaOnly(p.name)}`], `${esc(p.name)}, ${esc(p.team)}`),
    playerDetailTable(m, p),
  ].join('\n')).join('\n');
}

/* ---------- round report ---------- */

function roundReportHtml(m) {
  const cw = '10%';
  const rows = [trTag([
    th('Round', false, '10%'),
    th('Games', true, cw),
    th(abbr(`Pts/Tm/${REG_TUH}TUH`, `Points per team per ${REG_TUH} tossups heard`), true, cw),
    ...(m.hasPowers ? [th(abbr('TU Powered', 'Percentage of tossups powered by either team'), true, cw)] : []),
    th(abbr('TU Converted', 'Percentage of tossups answered correctly by either team'), true, cw),
    ...(m.hasNegs ? [th(abbr(`Negs/Tm/${REG_TUH}TUH`,
      `Incorrect tossup interrupts per team per ${REG_TUH} tossups heard`), true, cw)] : []),
    th(abbr('PPB', 'Points per bonus'), true, cw),
  ])];

  // YF's round figures, as it computes them: every point over regulation
  // tossups (negs likewise), powers and conversion over all tossups read,
  // and every get — overtime's too — counted as a bonus heard.
  const roundTotals = (games) => {
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
  };

  const statCells = (s, cell) => [
    cell(String(s.games)),
    cell(s.regTuh ? ((REG_TUH * s.points) / s.regTuh / 2).toFixed(1) : MDASH),
    ...(m.hasPowers ? [cell(s.tuh ? `${((100 * s.powers) / s.tuh).toFixed(0)}%` : MDASH)] : []),
    cell(s.tuh ? `${((100 * s.gets) / s.tuh).toFixed(0)}%` : MDASH),
    ...(m.hasNegs ? [cell(s.regTuh ? ((REG_TUH * s.negs) / s.regTuh / 2).toFixed(1) : MDASH)] : []),
    cell(s.bonusesHeard ? (s.bonusPts / s.bonusesHeard).toFixed(2) : MDASH),
  ];
  const asNum = (text) => numCell(text);
  const asFoot = (text) => th(text, true);

  for (const r of m.rounds) {
    rows.push(trTag([
      textCell(roundLink(m, r, String(r))),
      ...statCells(roundTotals(m.games.filter((g) => g.round === r)), asNum),
    ]));
  }
  rows.push(trFoot([th('Total'), ...statCells(roundTotals(m.games), asFoot)]));
  return tableTag(rows);
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
