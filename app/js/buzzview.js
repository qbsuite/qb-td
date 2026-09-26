// buzzview.js — the buzzpoints markup: one packet question as a collapsed
// answerline that expands to its text with every buzz marked, the bonus
// read with it, and the per-player summary table. Shared by the public
// tournament page (pubview.js) and the set page (setview.js), which shows
// the same thing over every mirror of a set — there `room` reads
// "site · room", the summary grows a site column, and one question's
// plays are laid out per wording (setview.js, from the pieces below).

import { esc } from './api.js';
import { normalizePacket } from './read_core.js';
import { tokenizeQuestionHtml, mainAnswerHtml, sanitizeHtml } from '../engine/buzz.js';

export { mainAnswerHtml };

const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';

/** A packet route's response (api.js pub(): parsed JSON, or the raw
    Response for anything else) -> normalized packet: JSON directly, docx
    through the same public YAPP service the reader uses. The bytes
    decide, not the Content-Type: a .json packet uploaded without one is
    still JSON. */
export async function readPacket(res, label) {
  if (!(res instanceof Response)) return normalizePacket(res, label);
  const bytes = await res.arrayBuffer();
  let parsed = null;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (e) { /* not JSON: a docx */ }
  if (parsed) return normalizePacket(parsed, label);
  const yapp = await fetch(YAPP, { method: 'POST', body: bytes, mode: 'cors' });
  if (!yapp.ok) throw new Error('packet parser failed (' + yapp.status + ')');
  return normalizePacket(await yapp.json(), label);
}

function buzzWordClass(hits) {
  if (hits.some((b) => b.value > 10)) return 'pow';
  if (hits.some((b) => b.value > 0)) return 'get';
  if (hits.some((b) => b.value < 0)) return 'neg';
  return 'zero';
}

const buzzCls = (b) => b.value > 10 ? 'pow-t' : b.value > 0 ? 'ok' : b.value < 0 ? 'bad' : 'muted';

/* The pieces, for callers that lay a question out themselves (the set
   page shows one question's plays grouped by wording): */

/** A full answerline under its question — a tossup's or a bonus part's,
    laid out the same way; a packet that already prefixes ANSWER: doesn't
    get it twice. */
function answerLineHtml(answer) {
  return `<div class="q muted">ANSWER: ${sanitizeHtml(String(answer).replace(/^\s*ANSWER:\s*/i, ''))}</div>`;
}

/** A tossup's text with each buzz marked on its word, then the full
    answerline. `tu` = the packet's tossup, or null for no text. */
export function tossupTextHtml(tu, buzzes) {
  if (!tu) return '';
  const words = tokenizeQuestionHtml(tu.question);
  const byPos = new Map();
  buzzes.forEach((b, i) => {
    const pos = Math.min(b.position, words.length - 1);
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push({ i, b });
  });
  return '<div class="q">' + words.map((w, wi) => {
    const hits = byPos.get(wi);
    if (!hits) return w;
    const cls = buzzWordClass(hits.map((h) => h.b));
    return `<span class="bw ${cls}">${w}<sup>${hits.map((h) => h.i + 1).join(',')}</sup></span>`;
  }).join(' ') + '</div>'
    + answerLineHtml(tu.answer);
}

/** The numbered buzz list under a tossup's text. */
export function buzzListHtml(buzzes) {
  if (!buzzes.length) return '<div class="buzzlist">no buzzes</div>';
  return `<div class="buzzlist">
    ${buzzes.map((b, i) => `<div><span class="${buzzCls(b)}">${i + 1} ${b.value > 0 ? '+' : ''}${b.value}</span>
        ${esc(b.player)} (${esc(b.team)}) &middot; word ${b.position + 1}${b.room ? ' &middot; ' + esc(b.room) : ''}</div>`).join('')}
  </div>`;
}

/**
 * A tossup's summary numbers. With `heard` (how many games read it):
 * power / conversion / neg rates over that many rooms — what a set's
 * editors read a question by — and the average correct buzz word, taken
 * from `positioned` when given (buzzes on ONE wording: a word index
 * means nothing across two). Without: the bare buzz positions.
 */
export function tossupMetaHtml(buzzes, heard, positioned = buzzes) {
  if (!heard) {
    const dead = buzzes.some((b) => b.value > 0) ? '' : '<span class="bad">dead</span> ';
    return dead + buzzes.map((b) => `<span class="${buzzCls(b)}">${b.position + 1}</span>`).join(' ');
  }
  const powers = buzzes.filter((b) => b.value > 10).length;
  const gets = buzzes.filter((b) => b.value > 0).length;
  const negs = buzzes.filter((b) => b.value < 0).length;
  const pct = (n) => Math.round((n / heard) * 100) + '%';
  const right = positioned.filter((b) => b.value > 0);
  const avg = right.length
    ? (right.reduce((n, b) => n + b.position, 0) / right.length + 1).toFixed(0) : null;
  return `${heard} room${heard === 1 ? '' : 's'} &middot; `
    + (powers ? `<span class="pow-t">${pct(powers)}</span> ` : '')
    + `<span class="${gets ? 'ok' : 'bad'}">${pct(gets)}</span>`
    + (negs ? ` <span class="bad">${pct(negs)} neg</span>` : '')
    + (avg ? ` &middot; avg word ${avg}` : '');
}

/** One tossup of a packet (1-based `tossup`), collapsed to its answerline. */
export function tossupHtml(tossup, buzzes, packet, heard) {
  const tu = packet && packet.tossups && packet.tossups[tossup - 1];
  return `
    <details class="qd">
      <summary><span class="roundcell">T${tossup}</span>
        ${tu ? mainAnswerHtml(tu.answer) : '<span class="muted">(no packet text)</span>'}
        <span class="qdmeta">${tossupMetaHtml(buzzes, heard)}</span></summary>
      <div class="qdbody">
        ${tossupTextHtml(tu, buzzes)}
        ${buzzListHtml(buzzes)}
      </div>
    </details>`;
}

/** A bonus's summary numbers: average and per-part conversion. */
export function bonusMetaHtml(results) {
  const heard = results.length;
  if (!heard) return '';
  const nParts = Math.max(...results.map((r) => r.parts.length));
  const conv = [];
  for (let p = 0; p < nParts; p++) conv.push(results.filter((r) => r.parts[p] > 0).length);
  const avg = results.reduce((n, r) => n + r.total, 0) / heard;
  return `${avg.toFixed(1)} avg &middot; ${conv.map((c) => c + '/' + heard).join(' ')}`;
}

/** A bonus's parts — each part's text, then its answerline the way a
    tossup's sits under its text — with their conversion, then each room's
    line. `bz` = the packet's bonus, or null for no text. */
export function bonusBodyHtml(bz, results) {
  const heard = results.length;
  const answers = bz && Array.isArray(bz.answers) ? bz.answers : [];
  const partsText = bz && Array.isArray(bz.parts) ? bz.parts : [];
  // every part the packet has, even before any room has played it
  const nParts = Math.max(0, ...results.map((r) => r.parts.length), partsText.length, answers.length);
  const rows = [];
  for (let p = 0; p < nParts; p++) {
    const c = results.filter((r) => r.parts[p] > 0).length;
    rows.push(`
      <div class="q">${heard ? `<span class="${c ? 'ok' : 'bad'}">${c}/${heard}</span> ` : ''}${
        partsText[p] ? sanitizeHtml(partsText[p]) : ''}</div>
      ${answers[p] ? answerLineHtml(answers[p]) : ''}`);
  }
  return `${bz && bz.leadin ? `<div class="q">${sanitizeHtml(bz.leadin)}</div>` : ''}
    ${rows.join('')}
    <div class="buzzlist">
      ${results.map((r) => `<div>
        <span class="${r.total > 20 ? 'pow-t' : r.total > 0 ? 'ok' : 'muted'}">${r.total}</span>
        ${r.team ? esc(r.team) : '<span class="muted">?</span>'}
        &middot; ${r.parts.join(' ')}${r.bounceTotal ? ` &middot; +${r.bounceTotal} bounce` : ''}${r.room ? ' &middot; ' + esc(r.room) : ''}
      </div>`).join('')}
    </div>`;
}

/** A bonus's answerlines, as its collapsed label. */
export function bonusAnswersHtml(bz) {
  const answers = bz && Array.isArray(bz.answers) ? bz.answers : [];
  return answers.length
    ? answers.map((a) => mainAnswerHtml(a)).join(' <span class="muted">/</span> ')
    : '<span class="muted">(no packet text)</span>';
}

export function bonusHtml(bonus, results, packet) {
  const bz = packet && Array.isArray(packet.bonuses) && packet.bonuses[bonus - 1];
  return `
    <details class="qd bonus">
      <summary><span class="roundcell">B${bonus}</span>
        ${bonusAnswersHtml(bz)}
        <span class="qdmeta">${bonusMetaHtml(results)}</span></summary>
      <div class="qdbody">${bonusBodyHtml(bz, results)}</div>
    </details>`;
}

/**
 * A round, interleaved by packet position: tossup N, then the bonus N
 * read with it. tossups/bonuses are buzz.js roundTossupBuzzes /
 * roundBonuses output.
 */
export function roundHtml(tossups, bonuses, packet) {
  const tossupByNo = new Map(tossups.map((t) => [t.tossup, t]));
  const bonusByNo = new Map(bonuses.map((b) => [b.bonus, b]));
  const numbers = [...new Set([...tossupByNo.keys(), ...bonusByNo.keys()])].sort((a, b) => a - b);
  return numbers.map((n) => {
    let html = '';
    if (tossupByNo.has(n)) html += tossupHtml(n, tossupByNo.get(n).buzzes, packet);
    if (bonusByNo.has(n)) html += bonusHtml(n, bonusByNo.get(n).results, packet);
    return html;
  }).join('');
}

/** buzz.js buzzSummary rows as a table; rows carrying `site` get a column. */
export function buzzSummaryHtml(rows) {
  if (!rows.length) return '<div class="muted">no buzzes yet</div>';
  const sites = rows.some((p) => p.site);
  return `<div class="tablewrap"><table>
    <tr><th class="name">player</th><th class="name">team</th>${sites ? '<th class="name">site</th>' : ''}
      <th class="num">15</th><th class="num">10</th>
      <th class="num">neg</th><th class="num">avg buzz</th><th class="num">best</th></tr>
    ${rows.map((p) => `<tr>
      <td class="name">${esc(p.player)}</td><td class="name muted">${esc(p.team)}</td>
      ${sites ? `<td class="name muted">${esc(p.site || '')}</td>` : ''}
      <td class="num">${p.powers}</td><td class="num">${p.gets}</td><td class="num">${p.negs}</td>
      <td class="num">${p.avg === null ? '–' : (p.avg + 1).toFixed(1)}</td>
      <td class="num">${p.best === null ? '–' : p.best + 1}</td></tr>`).join('')}
  </table></div>`;
}
