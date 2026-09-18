// packetcheck.js — did the packet parse the way a human would read it?
// A set's editors upload JSON or docx (docx through YAPP), and a question
// that parsed wrong — an answerline glued to the next question, a bonus
// with two parts, a stray "[10]" — reads wrong in every mirror's MODAQ
// and skews every stat built on it. This lays a packet out the way a
// reviewer checks it (answerline, length, how it opens and ends, the
// bonus parts with their answers and values) and flags what looks off.
// Warnings are hints for a person, never a verdict: a packet with none
// can still be wrong, and an unusual one can be right.

import { tokenizeQuestion, mainAnswerHtml } from './buzz.js';

// inline formatting is dropped without a gap ("<u>kite</u>s" is "kites");
// any other tag is a boundary
const plain = (html) => String(html ?? '').replace(/<\/?(?:b|u|i|em|strong)\b[^>]*>/gi, '')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
const mainAnswer = (html) => plain(mainAnswerHtml(html));

const SHORT_TOSSUP = 25;   // words; a real tossup is rarely under 50
const LONG_TOSSUP = 220;   // two questions run together read as one very long one
const LONG_ANSWER = 40;    // words in the main answerline: probably question text

// {question, answer} -> its review row
function checkTossup(tu, n) {
  const words = tokenizeQuestion(tu.question);
  const answer = mainAnswer(tu.answer);
  const warnings = [];
  if (!words.length) warnings.push('no question text');
  else if (words.length < SHORT_TOSSUP) warnings.push('very short (' + words.length + ' words)');
  else if (words.length > LONG_TOSSUP) warnings.push('very long (' + words.length + ' words) — two questions run together?');
  if (!answer) warnings.push('no answerline');
  else if (answer.split(/\s+/).length > LONG_ANSWER) warnings.push('answerline is ' + answer.split(/\s+/).length + ' words — question text in the answer?');
  if (/\bANSWER:/i.test(plain(tu.question))) warnings.push('"ANSWER:" inside the question text');
  if (/^\s*(\d+\.|tossup\b|tu\b)/i.test(plain(tu.question))) warnings.push('starts with a question label');
  const powers = (plain(tu.question).match(/\(\*\)/g) || []).length;
  if (powers > 1) warnings.push(powers + ' power marks');
  if (words.length && !/for\s+(10|ten)\s+points|ftp\b|for ten points/i.test(plain(tu.question))) {
    warnings.push('no "For 10 points"');
  }
  return {
    n, words: words.length, answer, power: powers === 1,
    head: words.slice(0, 12).join(' '), tail: words.slice(-8).join(' '),
    warnings,
  };
}

// {leadin, parts, answers, values} -> its review row
function checkBonus(bn, n) {
  const parts = Array.isArray(bn.parts) ? bn.parts.map(plain) : [];
  const answers = Array.isArray(bn.answers) ? bn.answers.map(mainAnswer) : [];
  const values = Array.isArray(bn.values) ? bn.values.map(Number) : [];
  const warnings = [];
  if (parts.length !== 3) warnings.push(parts.length + ' part' + (parts.length === 1 ? '' : 's'));
  if (answers.length !== parts.length) warnings.push(answers.length + ' answers for ' + parts.length + ' parts');
  parts.forEach((p, i) => {
    if (!p) warnings.push('part ' + (i + 1) + ' is empty');
    else if (/^\s*\[\d+\]/.test(p)) warnings.push('part ' + (i + 1) + ' still carries its "[10]" marker');
    else if (p.split(/\s+/).length < 4) warnings.push('part ' + (i + 1) + ' is very short');
  });
  answers.forEach((a, i) => { if (!a) warnings.push('answer ' + (i + 1) + ' is empty'); });
  if (values.length && values.length !== parts.length) warnings.push('values do not match the parts');
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) warnings.push('a part has no point value');
  if (!plain(bn.leadin)) warnings.push('no lead-in');
  return { n, leadin: plain(bn.leadin), parts, answers, values, warnings };
}

/**
 * Review a normalized packet (read_core.js normalizePacket). Returns
 * {tossups, bonuses, warnings, count}: per-question rows with their own
 * warnings, packet-level warnings, and the total number of warnings.
 */
export function checkPacket(packet) {
  const tossups = (packet.tossups || []).map((tu, i) => checkTossup(tu, i + 1));
  const bonuses = (packet.bonuses || []).map((bn, i) => checkBonus(bn, i + 1));
  const warnings = [];
  if (bonuses.length && tossups.length !== bonuses.length) {
    warnings.push(tossups.length + ' tossups but ' + bonuses.length + ' bonuses');
  }
  if (!bonuses.length) warnings.push('no bonuses');
  const powered = tossups.filter((t) => t.power).length;
  if (powered && powered !== tossups.length) {
    warnings.push(powered + ' of ' + tossups.length + ' tossups carry a power mark');
  }
  const seen = new Map();
  for (const t of tossups) {
    const k = t.answer.toLowerCase();
    if (!k) continue;
    if (seen.has(k)) warnings.push('T' + seen.get(k) + ' and T' + t.n + ' share an answerline (' + t.answer + ')');
    else seen.set(k, t.n);
  }
  const withCats = (packet.tossups || []).filter((t) => t && (t.category || t.metadata)).length;
  if (!withCats) warnings.push('no category data — this packet contributes nothing to category stats');
  else if (withCats !== tossups.length) warnings.push((tossups.length - withCats) + ' tossups without category data');
  const count = warnings.length
    + tossups.reduce((n, t) => n + t.warnings.length, 0)
    + bonuses.reduce((n, b) => n + b.warnings.length, 0);
  return { tossups, bonuses, warnings, count };
}
