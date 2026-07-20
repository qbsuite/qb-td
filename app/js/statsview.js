// statsview.js — render an aggregate() result as standings + individuals +
// games tables. Shared by the TO dashboard and the public stats page.

import { esc } from './api.js';

export function renderStats(out, agg, errors = []) {
  const vals = agg.values;
  out.innerHTML = `
    ${errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}
    <h2>standings</h2>
    <div class="tablewrap"><table>
      <tr><th></th><th>team</th><th class="num">W</th><th class="num">L</th><th class="num">T</th>
        ${vals.map((v) => `<th class="num">${v}</th>`).join('')}
        <th class="num">TUH</th><th class="num">pts</th><th class="num">PP20TUH</th><th class="num">PPB</th></tr>
      ${agg.teams.map((tm, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(tm.name)}${tm.rostered ? '' : ' <span class="bad" title="not in roster">?</span>'}</td>
        <td class="num">${tm.w}</td><td class="num">${tm.l}</td><td class="num">${tm.t}</td>
        ${vals.map((v) => `<td class="num">${tm.counts[v] || 0}</td>`).join('')}
        <td class="num">${tm.tuh}</td><td class="num">${tm.points}</td>
        <td class="num">${tm.pp20tuh}</td><td class="num">${tm.ppb}</td>
      </tr>`).join('')}
    </table></div>
    <h2>individuals</h2>
    <div class="tablewrap"><table>
      <tr><th></th><th>player</th><th>team</th><th class="num">GP</th>
        ${vals.map((v) => `<th class="num">${v}</th>`).join('')}
        <th class="num">TUH</th><th class="num">pts</th><th class="num">PP20TUH</th></tr>
      ${agg.players.map((p, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(p.name)}${p.rostered ? '' : ' <span class="bad" title="not in roster">?</span>'}</td>
        <td>${esc(p.team)}</td><td class="num">${p.gp}</td>
        ${vals.map((v) => `<td class="num">${p.counts[v] || 0}</td>`).join('')}
        <td class="num">${p.tuh}</td><td class="num">${p.points}</td><td class="num">${p.pp20tuh}</td>
      </tr>`).join('')}
    </table></div>
    <h2>games</h2>
    <div class="tablewrap"><table>
      <tr><th class="num">round</th><th>result</th><th>room</th></tr>
      ${agg.games.map((g) => `<tr>
        <td class="num">${g.round}</td>
        <td>${esc(g.teams[0].name)} ${g.teams[0].points}, ${esc(g.teams[1].name)} ${g.teams[1].points}</td>
        <td>${esc(g.room || '')}</td>
      </tr>`).join('')}
    </table></div>`;
}
