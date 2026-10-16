// Throwaway mock (tiebreakers-hub.html, t.html): a schedule's tiebreaker
// games (schedule.tiebreakers, written by the Live Hub) as a Tiebreakers
// block after the round they follow, in the schedule editor's and the
// public page's own markup. The rounds themselves don't change.
import { slotText } from '../app/engine/schedule.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// the tiebreaker rounds, each with its games in room order
export function tbBlocks(s) {
  const by = new Map();
  for (const g of (s && s.tiebreakers) || []) {
    if (!by.has(g.tb)) by.set(g.tb, []);
    by.get(g.tb).push(g);
  }
  return [...by.entries()].sort((x, y) => x[0] - y[0]).map(([tb, games]) => ({ tb, games: games.sort((x, y) => x.room - y.room) }));
}
// the round tiebreakers follow: the last round before the first playoff slot
export function tbAfter(s) {
  const first = s.phases.findIndex((ph) => ph.rounds.some((r) => r.games.some((g) => (g.a && (g.a.label || g.a.from)) || (g.b && (g.b.label || g.b.from)))));
  const ph = s.phases[Math.max(0, first - 1)];
  return ph.rounds[ph.rounds.length - 1].round;
}
const roomsUsed = (s, blocks) => [...new Set(blocks.flatMap((b) => b.games.map((g) => g.room)))].sort((x, y) => x - y);

// the public page's schedule grid (pubview.js renderScheduleGrid)
export function tbPublicHtml(s) {
  const blocks = tbBlocks(s);
  if (!blocks.length) return '';
  const used = roomsUsed(s, blocks);
  const line = (x) => `<div class="gl${x && x.label ? ' ph' : ''}"><span class="t">${esc(slotText(x) || '—')}</span></div>`;
  return `<div class="rhead tbrhead">Tiebreakers <span class="muted">after round ${tbAfter(s)}</span></div>
    <div class="tablewrap"><table class="sched">
      <tr><th></th>${used.map((i) => `<th>${esc(s.rooms[i].name)}</th>`).join('')}</tr>
      ${blocks.map((b) => `<tr><td class="roundcell">T${b.tb}</td>${used.map((i) => {
        const g = b.games.find((x) => x.room === i);
        return `<td>${g ? line(g.a) + line(g.b) : ''}</td>`;
      }).join('')}</tr>`).join('')}
    </table></div>`;
}

// the schedule editor's phase section (schededit.js), read-only: the Live
// Hub's Tiebreakers section is where these change
export function tbEditorHtml(s) {
  const blocks = tbBlocks(s);
  if (!blocks.length) return '';
  const used = roomsUsed(s, blocks);
  const pools = Object.keys(s.pools || {});
  return `<section class="sgphase tbedphase">
    <div class="sgphasehead"><span class="caret">▾</span><b>Tiebreakers</b><span class="muted">after round ${tbAfter(s)} · changed in the Live Hub</span></div>
    <div class="sggrid" style="grid-template-columns:40px ${used.map(() => '230px').join(' ')}">
      <div class="sgcorner"></div>
      ${used.map((i) => { const g = blocks.flatMap((b) => b.games).find((x) => x.room === i);
        return `<div class="sglane lane-${Math.max(0, pools.indexOf(g.pool)) % 4}"><i></i>Pool ${esc(g.pool)}</div>`; }).join('')}
      <div class="sgcorner sgcorner2"></div>
      ${used.map((i) => `<div class="sgroom">${esc(s.rooms[i].name)}</div>`).join('')}
      ${blocks.map((b) => `<div class="sgrnd"><span>T${b.tb}</span></div>${used.map((i) => {
        const g = b.games.find((x) => x.room === i);
        if (!g) return '<div class="sgcell empty"></div>';
        const slot = (x) => `<div class="sgslot${x && x.label ? ' ph' : ''}">${esc(slotText(x) || '—')}</div>`;
        return `<div class="sgcell"><span class="sgtag sgifneeded">If needed</span>${slot(g.a)}${slot(g.b)}</div>`;
      }).join('')}`).join('')}
    </div></section>`;
}
