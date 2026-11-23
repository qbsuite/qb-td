// statsview.js — the hub's stats under the grid (Show stats): an
// aggregate() result as standings, individuals and the games by round,
// each game opening to its box scores. Rows are stats.js standings (the
// public page's order, overtime out of TUH and PPB), in the player
// page's columns, with points per game where it has points per 20.
//
// Compact, as the public page's tables are: W/L as a tight pair, then a
// rule before each group of stat columns. The zero-point count is omitted
// (it's implied by TUH); the ties column only appears if a tie was played.
// Standings and individuals side by side, the games below by round.

import { roundLabel } from '../engine/deciderphases.js';
import { esc } from './api.js';

const playerPts = (p) => p.counts.reduce((s, c) => s + c.value * c.n, 0);
const bonusesHeard = (t) =>
  t.players.reduce((s, p) => s + p.counts.reduce((n, c) => n + (c.value > 0 ? c.n : 0), 0), 0);
const fx = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '');

const valCells = (vals, counts) => vals.map((v, i) => `<td class="num${i ? '' : ' g0'}">${counts[v] || 0}</td>`).join('');
const valHeads = (vals) => vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('');

function boxScore(t, vals) {
  const heard = bonusesHeard(t);
  return `<div class="tablewrap"><table class="box">
    <tr><th class="name">${esc(t.name)}</th>${valHeads(vals)}<th class="num g0">TUH</th><th class="num">Pts</th></tr>
    ${t.players.map((p) => {
      const counts = Object.fromEntries(p.counts.map((c) => [c.value, c.n]));
      return `<tr><td class="name">${esc(p.name)}</td>${valCells(vals, counts)}
        <td class="num g0">${p.tossupsHeard}</td><td class="num">${playerPts(p)}</td></tr>`;
    }).join('')}
    <tr class="muted"><td class="name">Bonuses</td><td class="num" colspan="${vals.length + 2}">
      ${t.bonusPoints} on ${heard} &middot; ${fx(heard ? t.bonusPoints / heard : 0)} PPB</td></tr>
  </table></div>`;
}

function gameRow(g, vals) {
  const room = g.room ? `<span class="muted">${esc(g.room)}</span>` : '<span></span>';
  // a forfeit is its result: no score, no box score
  if (g.forfeit) {
    const [win, lose] = g.teams[0].forfeitLoss ? [g.teams[1], g.teams[0]] : g.teams;
    return `<div class="game plain"><span>${esc(win.name)} defeats ${esc(lose.name)} by forfeit</span>${room}</div>`;
  }
  const [a, b] = g.teams;
  const side = (t, o) => (t.points > o.points ? `<b>${esc(t.name)} ${t.points}</b>` : `${esc(t.name)} ${t.points}`);
  const summary = `<span>${side(a, b)}, ${side(b, a)}</span>${room}`;
  // pre-detail bundle entries carry no player lines: plain row, no expander
  if (!a.players) return `<div class="game plain">${summary}</div>`;
  return `<details class="game"><summary>${summary}</summary>
    <div class="boxes">${g.teams.map((t) => boxScore(t, vals)).join('')}</div>
  </details>`;
}

// Undergraduate / Division II marks beside a name; aggregate() sets them
// only on a row the roster marks
const markTags = (x) => (x.ug ? '<span class="ntag" title="Undergraduate">UG</span>' : '')
  + (x.d2 ? '<span class="ntag d2" title="Division II">DII</span>' : '');
const unrostered = (x) => (x.rostered ? '' : ' <span class="bad" title="Not in the roster">?</span>');

export function renderStats(out, agg, errors = [], opts = {}) {
  // opts.vals: the point values to give columns (the rules' own), else the ones scored
  const vals = (opts.vals || agg.values).filter((v) => v !== 0);
  const ties = agg.teams.some((t) => t.t > 0);
  const rounds = [...new Set((agg.games || []).map((g) => g.round))];

  const standingsHtml = `<div class="tablewrap"><table>
      <tr><th class="rk"></th><th class="name">Team</th>
        <th class="num g0">W</th><th class="num">L</th>${ties ? '<th class="num">T</th>' : ''}
        <th class="num g0" title="Points per game">PPG</th>${valHeads(vals)}
        <th class="num g0" title="Tossups heard in regulation">TUH</th><th class="num" title="Points per bonus">PPB</th></tr>
      ${agg.teams.map((tm, i) => `<tr>
        <td class="rk">${i + 1}</td>
        <td class="name">${esc(tm.name)}${markTags(tm)}${unrostered(tm)}</td>
        <td class="num g0">${tm.w}</td><td class="num">${tm.l}</td>${ties ? `<td class="num">${tm.t}</td>` : ''}
        <td class="num g0">${fx(tm.ppg, 1)}</td>${valCells(vals, tm.counts)}
        <td class="num g0">${tm.regTuh ?? tm.tuh}</td><td class="num">${fx(tm.ppb)}</td>
      </tr>`).join('')}
    </table></div>`;
  const playersHtml = `<div class="tablewrap"><table>
      <tr><th class="rk"></th><th class="name">Player</th><th class="name">Team</th>
        <th class="num g0">GP</th>${valHeads(vals)}
        <th class="num g0">TUH</th><th class="num" title="Points per game">PPG</th></tr>
      ${agg.players.map((p, i) => `<tr>
        <td class="rk">${i + 1}</td>
        <td class="name">${esc(p.name)}${markTags(p)}${unrostered(p)}</td>
        <td class="name muted">${esc(p.team)}</td>
        <td class="num g0">${p.gp}</td>${valCells(vals, p.counts)}
        <td class="num g0">${p.tuh}</td><td class="num">${fx(p.ppg)}</td>
      </tr>`).join('')}
    </table></div>`;
  const gamesHtml = `<div class="hgames">${rounds.map((rn) => `<div class="hround">
      <div class="rhead">${roundLabel(rn)}</div>
      ${agg.games.filter((g) => g.round === rn).map((g) => gameRow(g, vals)).join('')}
    </div>`).join('')}</div>`;
  const errs = errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('');

  out.innerHTML = `<div class="hstats">${errs}
    <div class="hcols">
      <div><h3>Standings</h3>${standingsHtml}</div>
      <div><h3>Individuals</h3>${playersHtml}</div>
    </div>
    ${opts.games === false ? '' : `<h3>Games</h3>${gamesHtml}`}
  </div>`;
}
