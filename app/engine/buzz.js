// buzz.js — per-buzz data from MODAQ match qbj. MODAQ's export carries
// match_questions[].buzzes[] with buzz_position.word_index (word offset
// into the tossup as MODAQ displayed it), player, team, and result.value
// (15/10/0/neg; non-first wrong buzzes are already zeroed by MODAQ).
// The public page's buzzpoints tab merges these across every room
// reading the same packet; question text comes separately from the
// TD-gated packet route.

import { matchPayload } from './qbj.js';

export function unwrapMatch(json) {
  let obj = matchPayload(json);
  if (obj && Array.isArray(obj.objects)) {
    obj = obj.objects.find((o) => o && (o.match_teams || o.matchTeams)) || obj;
  }
  return obj || {};
}

/**
 * All read tossups in one match qbj (any accepted wrapping), grouped by
 * the PACKET tossup number (1-based; thrown-out tossups resolve to the
 * replacement actually played). [{tossup, buzzes: [{player, team,
 * position, value}]}] — a cycle nobody buzzed on still appears (empty
 * buzzes: it went dead in that room); malformed buzzes are dropped.
 */
export function matchBuzzes(json) {
  const match = unwrapMatch(json);
  const questions = Array.isArray(match.match_questions) ? match.match_questions : [];
  const out = [];
  for (const mq of questions) {
    if (!mq) continue;
    const read = (mq.replacement_tossup_question && mq.replacement_tossup_question.question_number)
      ? mq.replacement_tossup_question : mq.tossup_question;
    const tossup = (read && read.question_number) || mq.question_number;
    if (!Number.isInteger(tossup) || tossup < 1) continue;
    const tb = read && typeof read.qbtd_tiebreaker === 'string' ? read.qbtd_tiebreaker : '';
    const buzzes = [];
    for (const b of (Array.isArray(mq.buzzes) ? mq.buzzes : [])) {
      const player = b && b.player && typeof b.player.name === 'string' ? b.player.name.trim() : '';
      const team = b && b.team && typeof b.team.name === 'string' ? b.team.name.trim() : '';
      const position = b && b.buzz_position ? b.buzz_position.word_index : undefined;
      const value = b && b.result ? Number(b.result.value) : NaN;
      if (!player || !Number.isInteger(position) || position < 0 || !Number.isFinite(value)) continue;
      buzzes.push({ player, team, position, value });
    }
    out.push({ tossup, ...(tb ? { tb } : {}), buzzes: buzzes.sort((x, y) => x.position - y.position) });
  }
  return out;
}

/**
 * The stats.js dedupeMatches rule applied to raw bundle entries
 * ({id, round, qbj}): a re-uploaded game (mod re-exporting after a fix)
 * keeps only the latest upload per (round, team pair) — file ids are
 * upload-ordered; without ids the later entry in input order wins. The
 * buzz-based views (buzzpoints, categories) read raw entries instead of
 * parsed matches, so they need their own pass.
 */
export function dedupeEntries(entries) {
  const byGame = new Map();
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const match = unwrapMatch(e.qbj);
    const teams = (Array.isArray(match.match_teams) ? match.match_teams : [])
      .map((mt) => mt && mt.team && typeof mt.team.name === 'string' ? mt.team.name.trim() : '')
      .sort();
    const key = e.round + '\n' + teams.join('\n');
    const prev = byGame.get(key);
    const older = prev && Number.isFinite(prev.id) && Number.isFinite(e.id)
      && e.id < prev.id;
    if (!older) byGame.set(key, e);
  }
  return [...byGame.values()];
}

// Packet questions in packet order, then tiebreakers by pool id (TU2
// before TU10).
const byPacketThenTiebreaker = (num) => (a, b) => {
  if (!a.tb !== !b.tb) return a.tb ? 1 : -1;
  if (a.tb) return a.tb.localeCompare(b.tb, 'en', { numeric: true });
  return num(a) - num(b);
};

/**
 * One round's buzzes across every room, merged per packet tossup.
 * entries: [{round, room, qbj}] (the raw stats-bundle rows). Returns
 * [{tossup, buzzes: [{player, team, position, value, room}]}] sorted by
 * tossup, buzzes by position.
 */
export function roundTossupBuzzes(entries, round) {
  const byTossup = new Map();
  for (const e of entries) {
    if (!e || e.round !== round) continue;
    for (const { tossup, tb, buzzes } of matchBuzzes(e.qbj)) {
      const key = tb ? 'tb:' + tb : tossup;
      if (!byTossup.has(key)) byTossup.set(key, { tossup, ...(tb ? { tb } : {}), buzzes: [] });
      for (const b of buzzes) byTossup.get(key).buzzes.push({ ...b, room: e.room || '' });
    }
  }
  return [...byTossup.values()]
    .sort(byPacketThenTiebreaker((q) => q.tossup))
    .map((q) => ({ ...q, buzzes: q.buzzes.sort((x, y) => x.position - y.position) }));
}

/**
 * Bonus results in one match qbj: [{bonus, team, parts, bounce, total,
 * bounceTotal}]. bonus = the packet bonus number MODAQ assigned; team =
 * the controlling team (from the cycle's correct buzz); parts = the
 * controlled points per part; bounce = bounceback points per part (all
 * zero unless the format bounces).
 */
export function matchBonuses(json) {
  const match = unwrapMatch(json);
  const questions = Array.isArray(match.match_questions) ? match.match_questions : [];
  const out = [];
  for (const mq of questions) {
    const b = mq && mq.bonus;
    if (!b || !Array.isArray(b.parts) || !b.parts.length) continue;
    const bonus = b.question && b.question.question_number;
    if (!Number.isInteger(bonus) || bonus < 1) continue;
    const tb = typeof b.question.qbtd_tiebreaker === 'string' ? b.question.qbtd_tiebreaker : '';
    const correct = Array.isArray(mq.buzzes)
      ? mq.buzzes.find((x) => x && x.result && Number(x.result.value) > 0) : null;
    const team = correct && correct.team && typeof correct.team.name === 'string'
      ? correct.team.name.trim() : '';
    const parts = b.parts.map((p) => Number(p && p.controlled_points) || 0);
    const bounce = b.parts.map((p) => Number(p && p.bounceback_points) || 0);
    out.push({
      bonus, ...(tb ? { tb } : {}), team, parts, bounce,
      total: parts.reduce((n, x) => n + x, 0),
      bounceTotal: bounce.reduce((n, x) => n + x, 0),
    });
  }
  return out;
}

/**
 * One round's bonus results across every room, grouped per packet
 * bonus: [{bonus, results: [{room, team, parts, bounce, total,
 * bounceTotal}]}] sorted by bonus number.
 */
export function roundBonuses(entries, round) {
  const byBonus = new Map();
  for (const e of entries) {
    if (!e || e.round !== round) continue;
    for (const r of matchBonuses(e.qbj)) {
      const key = r.tb ? 'tb:' + r.tb : r.bonus;
      if (!byBonus.has(key)) byBonus.set(key, { bonus: r.bonus, ...(r.tb ? { tb: r.tb } : {}), results: [] });
      byBonus.get(key).results.push({ ...r, room: e.room || '' });
    }
  }
  return [...byBonus.values()].sort(byPacketThenTiebreaker((q) => q.bonus));
}

/**
 * Every pool tiebreaker read in any round, for the Replacements view: one
 * row per pool id over all rooms and rounds (a replacement read in rounds
 * 3 and 7 is one row). {tossups: [{tb, tossup, buzzes}], bonuses: [{tb,
 * bonus, results}]}, sorted by id.
 */
export function tiebreakerBuzzes(entries) {
  const tus = new Map();
  const bos = new Map();
  for (const e of entries) {
    if (!e) continue;
    const at = { room: e.room || '', round: e.round };
    for (const { tossup, tb, buzzes } of matchBuzzes(e.qbj)) {
      if (!tb) continue;
      if (!tus.has(tb)) tus.set(tb, { tb, tossup, buzzes: [] });
      for (const b of buzzes) tus.get(tb).buzzes.push({ ...b, ...at });
    }
    for (const r of matchBonuses(e.qbj)) {
      if (!r.tb) continue;
      if (!bos.has(r.tb)) bos.set(r.tb, { tb: r.tb, bonus: r.bonus, results: [] });
      bos.get(r.tb).results.push({ ...r, ...at });
    }
  }
  const sort = byPacketThenTiebreaker(() => 0);
  return {
    tossups: [...tus.values()].sort(sort).map((q) => ({ ...q, buzzes: q.buzzes.sort((x, y) => x.position - y.position) })),
    bonuses: [...bos.values()].sort(sort),
  };
}

/**
 * Per-player buzz table over every entry: powers (value > 10), gets
 * (0 < value <= 10), negs (value < 0), avg word position and earliest
 * word position over correct buzzes. Sorted most correct first, then
 * earliest average.
 */
export function buzzSummary(entries) {
  const players = new Map();
  for (const e of entries) {
    if (!e) continue;
    for (const { buzzes } of matchBuzzes(e.qbj)) {
      for (const b of buzzes) {
        const key = JSON.stringify([b.team, b.player]);
        if (!players.has(key)) {
          players.set(key, { player: b.player, team: b.team,
            powers: 0, gets: 0, negs: 0, sum: 0, correct: 0, best: null });
        }
        const p = players.get(key);
        if (b.value > 10) p.powers++;
        else if (b.value > 0) p.gets++;
        else if (b.value < 0) p.negs++;
        if (b.value > 0) {
          p.correct++;
          p.sum += b.position;
          if (p.best === null || b.position < p.best) p.best = b.position;
        }
      }
    }
  }
  return [...players.values()]
    .map(({ sum, correct, ...p }) => ({ ...p,
      correct, avg: correct ? sum / correct : null }))
    .sort((a, b) => b.correct - a.correct || (a.avg ?? 1e9) - (b.avg ?? 1e9));
}

/**
 * Packet text as display HTML with the packet's own bold/underline
 * formatting kept: only b/strong/u/i/em survive — all other tags are
 * dropped, all text is escaped, unclosed kept-tags are closed so
 * nothing leaks into surrounding markup.
 */
export function sanitizeHtml(html) {
  const head = String(html || '')
    .replace(/<(\/?)(b|strong|u|i|em)\b[^>]*>/gi, '<$1$2>')  // drop tag attributes
    .replace(/<(?!\/?(?:b|strong|u|i|em)>)[^>]*>/gi, ' ');   // drop other tags
  const KEEP = /^<\/?(?:b|strong|u|i|em)>$/i;
  const out = head.split(/(<\/?(?:b|strong|u|i|em)>)/gi)
    .map((part) => KEEP.test(part) ? part.toLowerCase()
      : part.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+|nbsp);)/gi, '&amp;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  // close anything left open (e.g. by mainAnswerHtml's bracket cut)
  const open = [];
  for (const m of out.matchAll(/<(\/?)(b|strong|u|i|em)>/g)) {
    if (!m[1]) open.push(m[2]);
    else if (open.lastIndexOf(m[2]) !== -1) open.splice(open.lastIndexOf(m[2]), 1);
  }
  return out + open.reverse().map((t) => '</' + t + '>').join('');
}

/**
 * The first main answerline as display HTML: everything before the
 * first [accept ...] / (prompt ...) clause, sanitized.
 */
export function mainAnswerHtml(html) {
  const s = String(html || '').replace(/^\s*ANSWER:\s*/i, '');
  const cut = s.search(/[[(]/);
  return sanitizeHtml(cut > 0 ? s.slice(0, cut) : s);
}

/**
 * Question text -> word array matching MODAQ's word positions as closely
 * as packet text allows (tags stripped, whitespace-split). word_index N
 * means the buzz came on words[N].
 */
export function tokenizeQuestion(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// MODAQ's reader directives (FormattedTextParser defaultReaderDirectives):
// read aloud as a cue, never buzzable
const READER_DIRECTIVES = ['(emphasize)', '(emphasise)', '(pause)', '(read slowly)',
  '[emphasize]', '[emphasise]', '[pause]', '[read slowly]'];
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A tossup's words exactly as MODAQ numbers them for word_index
 * (PacketState Tossup.getWords over FormattedTextParser), so a buzz lands
 * on the word the reader clicked: {words: [{html, at}], end}.
 *   - a word runs until whitespace, across tags: "<em>Blood Wedding</em>."
 *     is two words, the second "Wedding."
 *   - pronunciation guides, power marks and reader directives are shown
 *     but not counted (at: null)
 *   - `end` is MODAQ's end-of-question marker, the word after the last:
 *     a buzz there came once the question was finished
 * `format` is the game format the rooms read with (read_core.js
 * effectiveFormat): its powers and pronunciationGuideMarkers, MODAQ's
 * ["(", ")"] when it names none. Each word's html is self-contained
 * (em/b/u/sub/sup reopened around it), safe to wrap in its own span;
 * `lead` and `rest` split it at a guide inside the word.
 */
export function questionWords(text, format = {}) {
  text = String(text || '');
  const g = Array.isArray(format.pronunciationGuideMarkers) ? format.pronunciationGuideMarkers : ['(', ')'];
  const guides = [[g[0], g[1]]];
  // MODAQ reads straight and curly quotes in a guide alike
  if (g[0].includes('"') || g[1].includes('"')) guides.push([g[0].replace(/"/g, '\u201c'), g[1].replace(/"/g, '\u201d')]);
  if (g[0].includes('\u201c') || g[1].includes('\u201d')) guides.push([g[0].replace(/\u201c/g, '"'), g[1].replace(/\u201d/g, '"')]);
  const extra = guides.map((m) => `|${escRe(m[0])}|${escRe(m[1])}`).join('')
    + '|' + READER_DIRECTIVES.map(escRe).join('|');

  // parseFormattedText: runs of text with their formatting
  const segs = [];
  const st = { em: false, b: false, u: false, sub: false, sup: false, pron: false };
  const push = (t, pron = st.pron) => { if (t) segs.push({ ...st, pron, text: t }); };
  let from = 0;
  for (const m of text.matchAll(new RegExp(`<\\/?em>|<\\/?req>|<\\/?b>|<\\/?u>|<\\/?sub>|<\\/?sup>${extra}`, 'gi'))) {
    const tag = m[0].toLowerCase();
    // a guide's closing marker stays in the guide's text
    const close = guides.find((x) => tag === x[1].toLowerCase());
    push(text.slice(from, m.index + (close ? close[1].length : 0)));
    let skip = true;
    const t = /^<(\/?)(em|req|b|u|sub|sup)>$/.exec(tag);
    if (t) {
      const on = !t[1];
      if (t[2] === 'req') { st.b = on; st.u = on; } else st[t[2]] = on;
    } else if (guides.some((x) => tag === x[0].toLowerCase())) { skip = false; st.pron = true; }
    else if (close) st.pron = false;
    else push(m[0], true); // a reader directive: its own unbuzzable word
    from = skip ? m.index + m[0].length : m.index;
  }
  if (from < text.length) push(text.slice(from));

  // splitFormattedTextIntoWords: whitespace ends a word, tags don't
  const raw = [];
  let cur = [];
  for (const sg of segs) {
    const parts = sg.text.split(/\s+/g);
    if (parts.length === 1) { cur.push(sg); continue; }
    if (parts[0]) cur.push({ ...sg, text: parts[0] });
    raw.push(cur);
    cur = [];
    for (let i = 1; i < parts.length - 1; i++) if (parts[i]) raw.push([{ ...sg, text: parts[i] }]);
    if (parts[parts.length - 1]) cur.push({ ...sg, text: parts[parts.length - 1] });
  }
  if (cur.length) raw.push(cur);

  // getWords: power marks and guides don't count
  const powers = Array.isArray(format.powers) ? format.powers : [];
  // a guide is faded, as MODAQ shows it (class "pg")
  const html = (segs) => segs.map((sg) => {
    const tags = ['em', 'b', 'u', 'sub', 'sup'].filter((k) => sg[k]);
    const body = sg.text.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ')
      .replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const out = tags.map((k) => `<${k}>`).join('') + body + tags.slice().reverse().map((k) => `</${k}>`).join('');
    return sg.pron ? `<span class="pg">${out}</span>` : out;
  }).join('');
  let n = 0;
  const words = [];
  for (const word of raw) {
    // MODAQ keeps an empty word (two spaces after a guide); it shows nothing
    const full = word.map((sg) => sg.text).join('').trim();
    const counted = !powers.some((p) => full.startsWith(p.marker)) && !(word.length && word[0].pron);
    // a guide joined to its word ("Dvořák&nbsp;(“d’VORE-zhahk”).") is part
    // of that word, but a buzz marks only what comes before it: `lead`,
    // then `rest` from the guide on
    const g = word.findIndex((sg) => sg.pron);
    const lead = html(g < 0 ? word : word.slice(0, g));
    const rest = g < 0 ? '' : html(word.slice(g));
    const trimmed = lead.replace(/\s+$/, '');
    words.push({ html: lead + rest, lead: trimmed, rest: (trimmed !== lead ? ' ' : '') + rest, at: counted ? n++ : null });
  }
  return { words, end: n };
}
