// report.js — generate YellowFruit's static HTML stat report directly from
// parsed matches (qbj.js parseMatch output) + an optional roster, so a TD
// gets the standard six-page report without round-tripping through
// YellowFruit. Page set, layout, CSS, link scheme, and stat formulas are
// ported from YellowFruit 4.0.18 (HTMLReports.ts / StatSummaries.ts),
// reduced to qb-td's model: one phase, no pools/finals, no SS/JV/UG/D2
// tracking, no lightning rounds, bouncebacks folded into bonus points.
//
// buildReport({name, matches, roster}) -> [{name, text}] — the six files
// (standings/individuals/games/teamdetail/playerdetail/rounds .html),
// interlinked by those exact filenames, ready to zip or host as a folder.

import { aggregate } from './stats.js';

// Stat display scaling: points per 20 tossups heard, the convention used
// across qb-td (and YellowFruit's default regulation tossup count).
const REG_TUH = 20;

const PAGES = [
  { file: 'standings.html', title: 'Standings' },
  { file: 'individuals.html', title: 'Individuals' },
  { file: 'games.html', title: 'Scoreboard' },
  { file: 'teamdetail.html', title: 'Team Detail' },
  { file: 'playerdetail.html', title: 'Player Detail' },
  { file: 'rounds.html', title: 'Round Report' },
];

const MDASH = '&mdash;';
const NBSP = '&nbsp;';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const alphaOnly = (s) => String(s).replace(/[^0-9A-Za-z]/g, '');

/* ---------- html helpers (ported from YF's tag builders) ---------- */

const aTag = (href, contents) => `<a href="${href}">${contents}</a>`;
const trTag = (cells) => `<tr>\n${cells.join('\n')}\n</tr>`;
const trFoot = (cells) => `<tr class="pseudoTFoot">\n${cells.join('\n')}\n</tr>`;
function tdTag({ bold, align, width, title } = {}, contents) {
  const attrs = [
    align ? ` align="${align}"` : '',
    width ? ` width="${width}"` : '',
    title ? ` title="${esc(title)}"` : '',
  ].join('');
  return `<td${attrs}>${bold ? `<b>${contents}</b>` : contents}</td>`;
}
const th = (contents, right, width) =>
  tdTag({ bold: true, align: right ? 'right' : undefined, width }, contents);
const textCell = (contents) => tdTag({}, contents);
const numCell = (contents) => tdTag({ align: 'right' }, contents);
function tableTag(rows, { width, cssClass, border } = {}) {
  const attrs = [
    border !== undefined ? ` border="${border}"` : '',
    cssClass ? ` class="${cssClass}"` : '',
    width ? ` width="${width}"` : '',
  ].join('');
  return `<table${attrs}>\n${rows.join('\n')}\n</table>`;
}
const abbr = (text, tip) => `<abbr title="${esc(tip)}">${text}</abbr>`;

/* ---------- number formatting (YF's exact rules) ---------- */

const fmtWinPct = (p) => (Number.isNaN(p) ? MDASH : p.toFixed(3));
const fmtPpb = (pts, heard) => (heard ? (pts / heard).toFixed(2) : MDASH);

/* ---------- derived stats (YF StatSummaries formulas) ---------- */

function winPct(t) {
  return (t.w + t.t / 2) / (t.w + t.l + t.t);
}
function pptuh(t) {
  return t.points / t.tuh; // NaN when tuh is 0
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

const teamBonusesHeard = (mt) =>
  mt.players.reduce((s, p) => s + p.counts.reduce((n, c) => n + (c.value > 0 ? c.n : 0), 0), 0);
const teamCounts = (mt) => {
  const counts = {};
  for (const p of mt.players) {
    for (const c of p.counts) counts[c.value] = (counts[c.value] || 0) + c.n;
  }
  return counts;
};
const playerPoints = (p) => p.counts.reduce((s, c) => s + c.value * c.n, 0);

/* ---------- link + anchor scheme ---------- */

const gameAnchor = (g) =>
  `R${g.round}-${alphaOnly(g.teams[0].name)}-${alphaOnly(g.teams[1].name)}`;
const teamLink = (name) => aTag(`teamdetail.html#${alphaOnly(name)}`, esc(name));
const playerLink = (team, player) =>
  aTag(`playerdetail.html#${alphaOnly(team)}-${alphaOnly(player)}`, esc(player));
const gameLink = (g, text) => aTag(`games.html#${gameAnchor(g)}`, text);
const roundLink = (round, text) => aTag(`games.html#Round-${round}`, text);

/* ---------- page skeleton ---------- */

const PAGE_STYLE = `<style>
html{font-family: Roboto, sans-serif;}
table{font-size: 11pt; border-spacing: 0; border-collapse: collapse;}
td{padding: 5px;}
tr:nth-child(even){background-color: #f2f2f2;}
.headerAndDivider{display: flex; flex-direction: row; margin: 18px 0;}
.headerAndDivider h2{margin: 0;}
.scoreboardRoundHeader{width: 71%; position: sticky; top: 0; background-color: white; padding-bottom: 10px; margin-bottom: -10px;}
.boxScoreAnchor{padding-top: 30px;}
.boxScoreTitle{width: 71%;}
.inlineDivider{flex-grow: 1; height: 1px; background-color: #9f9f9f; align-self: center;}
.smallText{font-size: 10pt;}
ul{margin: 0;}
.boxScoreTable{display: flex; gap: 15px; align-items: flex-start;}
.pseudoTFoot{border-top: 1px solid #909090; background-color: #ffffff !important;}
.floatingTOC{top: 150px; right: 35px; position: fixed; padding-right: 5px; background-color: #cccccc; box-shadow: 4px 4px 7px #999999; line-height: 1.5; z-index: 99;}
.floatingTOC ul{list-style-type: none; padding-inline-start: 20px;}
@media screen and (min-width: 1000px) {.fwBelow1000px{width: 80%;}}
@media screen and (min-width: 800px) {.fwBelow800px{width: 60%;}}
</style>`;

function topLinks() {
  const cells = PAGES.map((p) => tdTag({}, aTag(p.file, p.title)));
  return tableTag([trTag(cells)], { width: '100%', border: '0' });
}

function headerWithDivider(text, pageFile, { noTopLink, sticky } = {}) {
  const cls = sticky ? 'headerAndDivider scoreboardRoundHeader' : 'headerAndDivider';
  const pieces = [`<h2>${text}${NBSP}</h2>`, '<div class="inlineDivider"></div>'];
  if (!noTopLink) {
    pieces.push(`<span>${NBSP}</span>`,
      aTag(`${pageFile}#top`, `<span class="smallText">&#x2191;Top</span>`));
  }
  return `<div class="${cls}">\n${pieces.join('\n')}\n</div>`;
}

function htmlPage(title, data) {
  const footer = '<div style="font-size:x-small; margin-top: 10px">Made with '
    + '<a href="https://qbsuite.github.io/qb-td/" target="_blank">qb-td</a></div>';
  return `<html>\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n</head>\n<body>\n`
    + `${topLinks()}\n<h1 id="top">${esc(title)}</h1>\n${PAGE_STYLE}\n`
    + `<div style="font-size: 11pt; text-size-adjust: none;">\n${data}\n${footer}\n</div>\n`
    + `</body>\n</html>\n`;
}

/* ---------- report model ---------- */

// One derived bundle every page reads: YF-ordered team rows, player rows
// with fractional games played, per-round game lists.
function reportModel({ name, matches, roster }) {
  const agg = aggregate(matches, roster);
  const vals = agg.values.filter((v) => v !== 0);
  const anyTies = agg.teams.some((t) => t.t > 0);

  const teams = sortTeamsYf(agg.teams);
  const teamRanks = rankTeams(teams);

  // Fractional GP (sum of tuh share per game) + per-match rows, per player.
  const perPlayer = new Map(); // team\nname -> {gp, games: [{g, mt, mp}]}
  const perTeam = new Map();   // name -> [{g, mt, opp}]
  for (const g of agg.games) {
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
    name, vals, anyTies, teams, teamRanks, players, playerRanks,
    games: agg.games, rounds, perTeam, hasPowers, hasNegs,
  };
}

const valHeaders = (vals) => vals.map((v) => th(String(v), true, '5%'));
const valCells = (counts, vals) => vals.map((v) => numCell(String(counts[v] || 0)));
const valFootCells = (counts, vals) => vals.map((v) => th(String(counts[v] || 0), true));

const record = (t) => (t.t ? `${t.w}-${t.l}-${t.t}` : `${t.w}-${t.l}`);
const paren = (n) => (n < 0 ? `(${n})` : String(n));
const scoreOnly = (mine, theirs) => `${paren(mine.points)} - ${paren(theirs.points)}`;
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
    th(abbr(`PP${REG_TUH}TUH`, `Points per ${REG_TUH} tossups heard`), true, '8%'),
    ...valHeaders(m.vals),
    th(abbr('TUH', 'Tossups heard'), true, '6%'),
    th(abbr('PPB', 'Points per bonus'), true, '7%'),
  ])];
  m.teams.forEach((t, i) => {
    rows.push(trTag([
      tdTag({}, m.teamRanks[i]),
      textCell(teamLink(t.name)),
      numCell(String(t.w)),
      numCell(String(t.l)),
      ...(m.anyTies ? [numCell(String(t.t))] : []),
      numCell(fmtWinPct(winPct(t))),
      numCell(t.tuh ? ((t.points / t.tuh) * REG_TUH).toFixed(1) : MDASH),
      ...valCells(t.counts, m.vals),
      numCell(String(t.tuh)),
      numCell(fmtPpb(t.bonusPoints, t.bonusesHeard)),
    ]));
  });
  const meta = `<span>${esc(m.name)}</span>`;
  const header = headerWithDivider('All Games', 'standings.html', { noTopLink: true });
  return `${meta}\n${header}\n${tableTag(rows, { cssClass: 'fwBelow1000px' })}<br/>`;
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
      textCell(playerLink(p.team, p.name)),
      textCell(teamLink(p.team)),
      numCell(p.gp.toFixed(1)),
      ...valCells(p.counts, m.vals),
      numCell(String(p.tuh)),
      numCell(((p.points / p.tuh) * REG_TUH).toFixed(2)),
    ]));
  });
  const header = headerWithDivider('All Games', 'individuals.html', { noTopLink: true });
  return `${header}\n${tableTag(rows, { cssClass: 'fwBelow1000px' })}`;
}

/* ---------- scoreboard ---------- */

function boxScoreTeamTable(mt, vals) {
  const rows = [trTag([
    th(esc(mt.name)),
    th('TUH', true),
    ...valHeaders(vals),
    th('Tot', true, '8%'),
  ])];
  for (const p of mt.players) {
    if (!p.tossupsHeard && !p.counts.some((c) => c.n)) continue;
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
      tdTag({}, esc(mt.name)),
      numCell(String(heard)),
      numCell(String(mt.bonusPoints)),
      numCell(heard ? (mt.bonusPoints / heard).toFixed(2) : MDASH),
    ]));
  }
  return tableTag(rows);
}

function scoreString(g) {
  const [a, b] = g.teams;
  const win = b.points > a.points ? b : a;
  const lose = win === a ? b : a;
  return `${esc(win.name)} ${win.points}, ${esc(lose.name)} ${lose.points}`;
}

function boxScore(g) {
  const vals = [...new Set(g.teams.flatMap((t) =>
    t.players.flatMap((p) => p.counts.filter((c) => c.n).map((c) => c.value))))]
    .filter((v) => v !== 0).sort((x, y) => y - x);
  return [
    `<div id="${gameAnchor(g)}" class="boxScoreAnchor"></div>`,
    `<h3 class="boxScoreTitle">${scoreString(g)}</h3>`,
    `<p>Tossups read: ${g.tossupsRead}${g.room ? ` ${NBSP}|${NBSP} ${esc(g.room)}` : ''}</p>`,
    `<div class="boxScoreTable">\n${boxScoreTeamTable(g.teams[0], vals)}\n${boxScoreTeamTable(g.teams[1], vals)}\n</div>`,
    '<br />',
    boxScoreBonusTable(g),
  ].join('\n');
}

function scoreboardHtml(m) {
  const toc = `<div class="floatingTOC">\n<ul>\n${m.rounds.map((r) =>
    `<li>${roundLink(r, `Round ${r}`)}</li>`).join('\n')}\n</ul>\n</div>`;
  const sections = m.rounds.map((r, i) => {
    const games = m.games.filter((g) => g.round === r);
    return '<div>\n' + [
      ...(i > 0 ? ['<br /><br />'] : []),
      `<div id="Round-${r}"></div>`,
      headerWithDivider(`Round ${r}`, 'games.html', { noTopLink: i === 0, sticky: true }),
      ...games.map(boxScore),
    ].join('\n') + '\n</div>';
  });
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
      textCell(teamLink(opp.name)),
      textCell(resultLetter(mt, opp)),
      textCell(gameLink(g, scoreOnly(mt, opp))),
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
      textCell(playerLink(p.team, p.name)),
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
    `<h2 id="${alphaOnly(t.name)}">${esc(t.name)}</h2>`,
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
      textCell(teamLink(opp.name)),
      textCell(resultLetter(mt, opp)),
      textCell(gameLink(g, scoreOnly(mt, opp))),
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
    `<h2 id="${alphaOnly(p.team)}-${alphaOnly(p.name)}">${esc(p.name)}, ${esc(p.team)}</h2>`,
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

  const roundTotals = (games) => {
    const s = { games: games.length, tuh: 0, points: 0, powers: 0, gets: 0, negs: 0, bonusPts: 0, bonusesHeard: 0 };
    for (const g of games) {
      s.tuh += g.tossupsRead;
      for (const mt of g.teams) {
        s.points += mt.points;
        s.bonusPts += mt.bonusPoints;
        s.bonusesHeard += teamBonusesHeard(mt);
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
    cell(s.tuh ? ((REG_TUH * s.points) / s.tuh / 2).toFixed(1) : MDASH),
    ...(m.hasPowers ? [cell(s.tuh ? `${((100 * s.powers) / s.tuh).toFixed(0)}%` : MDASH)] : []),
    cell(s.tuh ? `${((100 * s.gets) / s.tuh).toFixed(0)}%` : MDASH),
    ...(m.hasNegs ? [cell(s.tuh ? ((REG_TUH * s.negs) / s.tuh / 2).toFixed(1) : MDASH)] : []),
    cell(s.bonusesHeard ? (s.bonusPts / s.bonusesHeard).toFixed(2) : MDASH),
  ];
  const asNum = (text) => numCell(text);
  const asFoot = (text) => th(text, true);

  for (const r of m.rounds) {
    rows.push(trTag([
      textCell(roundLink(r, String(r))),
      ...statCells(roundTotals(m.games.filter((g) => g.round === r)), asNum),
    ]));
  }
  rows.push(trFoot([th('Total'), ...statCells(roundTotals(m.games), asFoot)]));
  return tableTag(rows);
}

/* ---------- entry point ---------- */

/**
 * @param opts {name, matches, roster} — same shape the .yft export takes:
 *   parsed matches (deduping is applied via aggregate) + optional roster.
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
  return PAGES.map((p) => ({ name: p.file, text: htmlPage(p.title, contents[p.file]) }));
}
