// statsview.js — render an aggregate() result as standings + individuals +
// per-round games with expandable box scores. Shared by the TO dashboard,
// the public stats page, and the set page — which passes {site: true,
// games: false}: its rows come from several mirrors (setstats.js
// setStandings), so each carries the site it played at, and the game
// lists stay on the mirrors' own pages.
//
// Column layout follows YellowFruit's reports: W/L as a tight pair, then a
// rule before every stat column (PP20TUH, each point value, TUH, PPB). The
// zero-point count is omitted (it's implied by TUH); the ties column only
// appears if a tie was actually played.

import { esc } from './api.js';

const playerPts = (p) => p.counts.reduce((s, c) => s + c.value * c.n, 0);
const bonusesHeard = (t) =>
  t.players.reduce((s, p) => s + p.counts.reduce((n, c) => n + (c.value > 0 ? c.n : 0), 0), 0);
const ppb1 = (pts, heard) => (heard ? Math.round((pts / heard) * 100) / 100 : 0);

function valCells(vals, counts, tag = 'td') {
  return vals.map((v) => `<${tag} class="num sep">${counts[v] || 0}</${tag}>`).join('');
}

function boxScore(t, vals) {
  const heard = bonusesHeard(t);
  return `<div class="tablewrap"><table class="box">
    <tr><th class="name">${esc(t.name)} ${t.points}</th>
      ${vals.map((v) => `<th class="num sep">${v}</th>`).join('')}
      <th class="num sep">TUH</th><th class="num sep">pts</th></tr>
    ${t.players.map((p) => {
      const counts = Object.fromEntries(p.counts.map((c) => [c.value, c.n]));
      return `<tr>
        <td class="name">${esc(p.name)}</td>
        ${valCells(vals, counts)}
        <td class="num sep">${p.tossupsHeard}</td>
        <td class="num sep">${playerPts(p)}</td>
      </tr>`;
    }).join('')}
    <tr class="muted"><td>bonus</td><td colspan="${vals.length + 2}">
      ${t.bonusPoints} pts on ${heard} · ppb ${ppb1(t.bonusPoints, heard)}</td></tr>
  </table></div>`;
}

function gameRow(g, vals) {
  const summary = `${esc(g.teams[0].name)} ${g.teams[0].points},
    ${esc(g.teams[1].name)} ${g.teams[1].points}
    ${g.room ? `<span class="muted">· ${esc(g.room)}</span>` : ''}`;
  // pre-detail bundle entries carry no player lines: plain row, no expander
  if (!g.teams[0].players) return `<div class="game plain">${summary}</div>`;
  return `<details class="game"><summary>${summary}</summary>
    <div class="boxes">${g.teams.map((t) => boxScore(t, vals)).join('')}</div>
  </details>`;
}

export function renderStats(out, agg, errors = [], opts = {}) {
  const site = opts.site ? (row) => `<td class="name muted">${esc(row.site || '')}</td>` : () => '';
  const siteHead = opts.site ? '<th class="name">site</th>' : '';
  const vals = agg.values.filter((v) => v !== 0);
  const ties = agg.teams.some((t) => t.t > 0);
  const rounds = [...new Set((agg.games || []).map((g) => g.round))];

  out.innerHTML = `
    ${errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}
    <h2>standings</h2>
    <div class="tablewrap"><table>
      <tr><th></th><th class="name">team</th>${siteHead}
        <th class="num sep">W</th><th class="num">L</th>${ties ? '<th class="num">T</th>' : ''}
        <th class="num sep">PP20TUH</th>
        ${vals.map((v) => `<th class="num sep">${v}</th>`).join('')}
        <th class="num sep">TUH</th><th class="num sep">PPB</th></tr>
      ${agg.teams.map((tm, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="name">${esc(tm.name)}${tm.rostered ? '' : ' <span class="bad" title="not in roster">?</span>'}</td>
        ${site(tm)}
        <td class="num sep">${tm.w}</td><td class="num">${tm.l}</td>${ties ? `<td class="num">${tm.t}</td>` : ''}
        <td class="num sep">${tm.pp20tuh}</td>
        ${valCells(vals, tm.counts)}
        <td class="num sep">${tm.tuh}</td><td class="num sep">${tm.ppb}</td>
      </tr>`).join('')}
    </table></div>
    <h2>individuals</h2>
    <div class="tablewrap"><table>
      <tr><th></th><th class="name">player</th><th class="name">team</th>${siteHead}
        <th class="num sep">GP</th>
        ${vals.map((v) => `<th class="num sep">${v}</th>`).join('')}
        <th class="num sep">TUH</th><th class="num sep">pts</th>
        <th class="num sep">PP20TUH</th></tr>
      ${agg.players.map((p, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="name">${esc(p.name)}${p.rostered ? '' : ' <span class="bad" title="not in roster">?</span>'}</td>
        <td class="name">${esc(p.team)}</td>
        ${site(p)}
        <td class="num sep">${p.gp}</td>
        ${valCells(vals, p.counts)}
        <td class="num sep">${p.tuh}</td><td class="num sep">${p.points}</td>
        <td class="num sep">${p.pp20tuh}</td>
      </tr>`).join('')}
    </table></div>
    ${opts.games === false ? '' : `<h2>games</h2>
    ${rounds.map((rn) => `
      <div class="rhead">round ${rn}</div>
      ${agg.games.filter((g) => g.round === rn).map((g) => gameRow(g, vals)).join('')}
    `).join('')}`}`;
}
