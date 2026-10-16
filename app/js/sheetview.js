// sheetview.js — one game's scoresheet as HTML (engine/scoresheet.js has
// the data), shared by the public Scoreboard (pubview.js) and the hub's
// example of what a scoresheet is (admin.js). Its styles are td.css .sx.

import { buildScoresheet } from '../engine/scoresheet.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One game's scoresheet (engine/scoresheet.js): a row per tossup, a
// column per player headed by initials, each team's bonus parts, the
// category tag and the score so far. Hatched cells are players out of the
// game; a substitution's tossup carries ⇄ and a line on the columns that
// changed, with one short line per substitution underneath.
const pts = (v) => (v < 0 ? '\u2212' + Math.abs(v) : String(v));
// "55–35"; a negative side goes in brackets so the dash and the minus
// don't run together: "55–(−5)"
const side = (v) => (v < 0 ? '(' + pts(v) + ')' : String(v));
const scoreText = ([x, y]) => side(x) + '\u2013' + side(y);
function subWords(sh, sub) {
  const init = new Map(sh.teams[sub.team].players.map((p) => [p.name, p.initials]));
  const tag = (n) => esc(init.get(n) || n);
  const n = Math.max(sub.in.length, sub.out.length);
  const bits = [];
  for (let i = 0; i < n; i++) {
    const a = sub.in[i];
    const b = sub.out[i];
    bits.push(a && b ? `${tag(a)} subbed for ${tag(b)}` : a ? `${tag(a)} came in` : `${tag(b)} went out`);
  }
  return `TU ${sub.n}: ${esc(sh.teams[sub.team].name)} ${bits.join(', ')}`;
}
export function sheetHtml(sh, regTossups) {
  const cat = sh.rows.some((r) => r.cat);
  const lead = cat ? '<th></th><th></th>' : '<th></th>';
  const half = Math.floor(regTossups / 2) + 1;
  const marks = (parts) => parts.map((y) => (y ? '<span class="y">\u2713</span>' : '<span class="x">\u2717</span>')).join('');
  const rows = sh.rows.map((r, i) => {
    const here = sh.subs.filter((x) => x.n === r.n);
    const changed = (ti, name) => here.some((x) => x.team === ti && (x.in.includes(name) || x.out.includes(name)));
    const cls = r.ot && !(sh.rows[i - 1] || {}).ot ? 'ot' : !r.ot && r.n === half ? 'half' : '';
    const team = (t, ti) => t.players.map((p, k) => {
      const v = r.cells[ti][k];
      return `<td class="pl${k ? '' : ' t0'}${r.out[ti][k] ? ' out' : ''}${changed(ti, p.name) ? ' chg' : ''}"${
        v !== null ? ` title="${esc(p.name + ' ' + pts(v))}"` : ''}>${v !== null ? `<b>${pts(v)}</b>` : ''}</td>`;
    }).join('') + `<td class="bon">${r.bonus[ti] ? `<span class="m">${marks(r.bonus[ti])}</span>` : ''}</td>`;
    return `<tr${cls ? ` class="${cls}"` : ''}><td class="qn">${r.ot ? 'OT' : r.n}${here.length
      ? `<span class="sub" title="${here.map((x) => subWords(sh, x)).join('; ')}">\u21c4</span>` : ''}</td>${cat
      ? `<td class="qc">${r.cat ? `<span class="cf ${r.cat.family}" title="${esc(r.cat.title)}">${esc(r.cat.label)}</span>` : ''}</td>` : ''}${
      sh.teams.map(team).join('')}<td class="qs">${scoreText(r.score)}</td></tr>`;
  }).join('');
  return `<div class="sxwrap"><div class="tablewrap"><table class="sx">
    <thead><tr>${lead}${sh.teams.map((t) => `<th class="tn t0" colspan="${t.players.length + 1}" title="${esc(t.name)}">${esc(t.name)}</th>`).join('')}<th></th></tr>
    <tr>${lead}${sh.teams.map((t) => t.players.map((p, k) =>
      `<th class="pl${k ? '' : ' t0'}" title="${esc(p.name)}">${esc(p.initials)}</th>`).join('') + '<th class="bon">Bon</th>').join('')}<th class="qs">Score</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>${cat ? '<td></td><td></td>' : '<td></td>'}${sh.teams.map((t) => t.players.map((p, k) =>
      `<td class="pl${k ? '' : ' t0'}"></td>`).join('') + '<td class="bon"></td>').join('')}<td class="qs">${scoreText(sh.final)}</td></tr></tfoot>
  </table></div>${sh.subs.length ? `<div class="sxsubs">${sh.subs.map((x) => `<div>${subWords(sh, x)}</div>`).join('')}</div>` : ''}</div>`;
}


/* ---------- the hub's example ---------- */

// A short made-up game for the hub's "What is a scoresheet?": a power, a
// neg picked up by the other team, a 0, a dead tossup, a substitution and
// a category on each tossup, in eight tossups.
const P = (name) => ({ name });
const buzz = (team, player, value) => ({ team: P(team), player: P(player), buzz_position: { word_index: 20 }, result: { value } });
const bonus = (...pts) => ({ question: { question_number: 1 }, parts: pts.map((x) => ({ controlled_points: x })) });
const EXAMPLE = {
  match_teams: [
    { team: P('Ohio State'), lineups: [
        { first_question: 1, players: [P('Ada Lin'), P('Ben Cho'), P('Cy Ruiz')] },
        { first_question: 5, players: [P('Ada Lin'), P('Ben Cho'), P('Dee Park')] }],
      match_players: [P('Ada Lin'), P('Ben Cho'), P('Cy Ruiz'), P('Dee Park')].map((p) => ({ player: p })) },
    { team: P('Kentucky'), lineups: [{ first_question: 1, players: [P('Eli Moss'), P('Fay Wu'), P('Gus Ford')] }],
      match_players: [P('Eli Moss'), P('Fay Wu'), P('Gus Ford')].map((p) => ({ player: p })) },
  ],
  match_questions: [
    [buzz('Ohio State', 'Ada Lin', 15)], [buzz('Kentucky', 'Fay Wu', -5), buzz('Ohio State', 'Ben Cho', 10)],
    [buzz('Kentucky', 'Eli Moss', 10)], [], [buzz('Ohio State', 'Dee Park', 10)],
    [buzz('Ohio State', 'Ben Cho', 0), buzz('Kentucky', 'Gus Ford', 10)], [buzz('Kentucky', 'Fay Wu', 15)],
    [buzz('Ohio State', 'Ada Lin', 10)],
  ].map((buzzes, i) => ({ question_number: i + 1, tossup_question: { question_number: i + 1 }, buzzes,
    ...(buzzes.some((b) => b.result.value > 0) ? { bonus: bonus(...[[10, 10, 0], [10, 0, 0], [10, 10, 10], [], [0, 10, 0], [10, 0, 10], [10, 10, 0], [0, 0, 10]][i]) } : {}) })),
};
const EXAMPLE_CATS = [['Literature', 'American Literature'], ['Science', 'Biology'], ['History', 'European History'],
  ['Fine Arts', 'Visual Fine Arts'], ['Religion', 'Religion'], ['Science', 'Physics'], ['Mythology', 'Mythology'],
  ['History', 'World History']].map(([c, s]) => ({ c, s }));

/** The hub's example scoresheet, as HTML. */
export function exampleSheetHtml() {
  return sheetHtml(buildScoresheet(EXAMPLE, EXAMPLE_CATS, 8), 8);
}
