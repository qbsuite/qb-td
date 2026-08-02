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
    const tossup = (mq.replacement_tossup_question && mq.replacement_tossup_question.question_number)
      || (mq.tossup_question && mq.tossup_question.question_number)
      || mq.question_number;
    if (!Number.isInteger(tossup) || tossup < 1) continue;
    const buzzes = [];
    for (const b of (Array.isArray(mq.buzzes) ? mq.buzzes : [])) {
      const player = b && b.player && typeof b.player.name === 'string' ? b.player.name.trim() : '';
      const team = b && b.team && typeof b.team.name === 'string' ? b.team.name.trim() : '';
      const position = b && b.buzz_position ? b.buzz_position.word_index : undefined;
      const value = b && b.result ? Number(b.result.value) : NaN;
      if (!player || !Number.isInteger(position) || position < 0 || !Number.isFinite(value)) continue;
      buzzes.push({ player, team, position, value });
    }
    out.push({ tossup, buzzes: buzzes.sort((x, y) => x.position - y.position) });
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
    for (const { tossup, buzzes } of matchBuzzes(e.qbj)) {
      if (!byTossup.has(tossup)) byTossup.set(tossup, []);
      for (const b of buzzes) byTossup.get(tossup).push({ ...b, room: e.room || '' });
    }
  }
  return [...byTossup.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tossup, buzzes]) => ({ tossup, buzzes: buzzes.sort((x, y) => x.position - y.position) }));
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
    const correct = Array.isArray(mq.buzzes)
      ? mq.buzzes.find((x) => x && x.result && Number(x.result.value) > 0) : null;
    const team = correct && correct.team && typeof correct.team.name === 'string'
      ? correct.team.name.trim() : '';
    const parts = b.parts.map((p) => Number(p && p.controlled_points) || 0);
    const bounce = b.parts.map((p) => Number(p && p.bounceback_points) || 0);
    out.push({
      bonus, team, parts, bounce,
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
      if (!byBonus.has(r.bonus)) byBonus.set(r.bonus, []);
      byBonus.get(r.bonus).push({ ...r, room: e.room || '' });
    }
  }
  return [...byBonus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bonus, results]) => ({ bonus, results }));
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

/**
 * Question text -> per-word display HTML, aligned 1:1 with
 * tokenizeQuestion's positions: every tag still acts as a word boundary
 * (so buzz indices are unchanged), but b/strong/u/i/em formatting is
 * kept — reopened and closed around each word, so every entry is
 * self-contained and safe to wrap in its own span.
 */
export function tokenizeQuestionHtml(text) {
  const words = [];
  const open = [];
  const parts = String(text || '').split(/(<[^>]*>)/);
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (pi % 2) {  // captured tag — a word boundary, exactly like tokenizeQuestion
      const m = /^<(\/?)(b|strong|u|i|em)\b[^>]*>$/i.exec(part);
      if (!m) continue;
      const tag = m[2].toLowerCase();
      if (!m[1]) open.push(tag);
      else if (open.lastIndexOf(tag) !== -1) open.splice(open.lastIndexOf(tag), 1);
      continue;
    }
    for (const w of part.replace(/&nbsp;/g, ' ').split(/\s+/)) {
      if (!w) continue;
      const t = w.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);)/gi, '&amp;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
      words.push(open.map((x) => '<' + x + '>').join('') + t
        + open.slice().reverse().map((x) => '</' + x + '>').join(''));
    }
  }
  return words;
}
