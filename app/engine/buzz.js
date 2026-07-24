// buzz.js — per-buzz data from ModaQ match qbj. MODAQ's export carries
// match_questions[].buzzes[] with buzz_position.word_index (word offset
// into the tossup as MODAQ displayed it), player, team, and result.value
// (15/10/0/neg; non-first wrong buzzes are already zeroed by MODAQ).
// The public page's buzzpoints tab merges these across every room
// reading the same packet; question text comes separately from the
// TD-gated packet route.

import { matchPayload } from './qbj.js';

function unwrapMatch(json) {
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
 * The main answer from a packet answerline: the underlined portion(s)
 * (packet convention for the required part), else the text before the
 * first [accept ...] / (prompt ...) clause. Tags stripped either way.
 */
export function mainAnswer(html) {
  const s = String(html || '');
  const u = [...s.matchAll(/<u[^>]*>([\s\S]*?)<\/u>/gi)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
  if (u.length) return u.join(' ').replace(/\s+/g, ' ');
  const plain = s.replace(/<[^>]*>/g, '').replace(/^ANSWER:\s*/i, '');
  const head = plain.split(/[[(]/)[0].replace(/\s+/g, ' ').trim();
  return head || plain.replace(/\s+/g, ' ').trim();
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
