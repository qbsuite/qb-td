// qmatch.js — question identity across packet versions of a question set.
//
// Editors fix wording, move questions between packets, repacketize. For
// set-wide buzzpoints to survive that, every packet version carries a
// question map: per position, [question id, text revision]. This module
// computes one, by matching an uploaded packet's questions against the
// set's ledger — every question the set has held, with each wording it
// has had. It runs in the editor's browser (setadmin.js): that is where
// the text is, with no CPU budget to respect; the Worker stores the
// result (worker.js putQmap) and never matches anything itself.
//
// Two notions of "the same", kept apart on purpose:
//   - the same QUESTION (one id): its conversion numbers add up across
//     every site that heard it, whatever packet or wording it had there;
//   - the same WORDING (one revision of an id): only then does a buzz's
//     word index point at the same word, so only then are buzz positions
//     drawn over one text. A revision is the exact token sequence of the
//     question as read — adding a power mark or one word shifts every
//     later index, so it is a new revision, while a change to the
//     answerline alone is not.
//
// Ledger: {v: 1, seq, questions: {<id>: {kind: 't'|'b', revs: [{key,
// answer, label}], at: [packet, position] | null, last?}}} — `key` is
// the normalized wording (so the ledger is question text: it lives
// encrypted under the set's key), `label` the answerline as a person
// reads it, `at` where the question sits in the set's CURRENT packets,
// `last` where it sat when it was dropped from them.
//
// The matcher is a first pass. Where it is wrong — two questions with
// the same phrasing formula, a rewrite too thorough to recognize — the
// editor corrects one position by hand (assignQuestion), and the
// correction is just another edit to the same map and ledger.

// inline formatting is dropped without a gap ("<u>kite</u>s" is one word,
// as MODAQ reads it); any other tag is a word boundary
const stripTags = (s) => String(s ?? '').replace(/<\/?(?:b|u|i|em|strong)\b[^>]*>/gi, '')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&').replace(/&(?:lt|gt|quot|#\d+|#x[\da-f]+);/gi, ' ');

// The wording as a token sequence, one token per whitespace-separated
// word exactly as MODAQ counts them; case and punctuation are dropped
// from each token but a punctuation-only token (a power mark) still
// holds its place, because it holds a word index.
function tokens(text) {
  return stripTags(text).split(/\s+/).filter(Boolean)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || '*');
}

const wordingKey = (parts) => parts.map((p) => tokens(p).join(' ')).join(' | ');

// first answerline only, as plain lowercase words: what two wordings of
// one question almost always still share
function answerKey(answer) {
  const s = stripTags(answer).replace(/^\s*ANSWER:\s*/i, '');
  const cut = s.search(/[[(]/);
  return tokens(cut > 0 ? s.slice(0, cut) : s).filter((w) => w !== '*').join(' ');
}

// the answerline for a person: first answer, tags off, cut short
function answerLabel(answer) {
  const s = stripTags(answer).replace(/^\s*ANSWER:\s*/i, '');
  const cut = s.search(/[[(]/);
  return (cut > 0 ? s.slice(0, cut) : s).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** A normalized packet (read_core.js normalizePacket) as the two lists
    this module matches: {t: [{key, answer, label}], b: [...]}. */
export function packetQuestions(packet) {
  const t = (packet.tossups || []).map((q) => ({
    key: wordingKey([q.question]), answer: answerKey(q.answer), label: answerLabel(q.answer) }));
  const b = (packet.bonuses || []).map((q) => ({
    key: wordingKey([q.leadin || '', ...(Array.isArray(q.parts) ? q.parts : [])]),
    answer: (Array.isArray(q.answers) ? q.answers : []).map(answerKey).join(' / '),
    label: (Array.isArray(q.answers) ? q.answers : []).map(answerLabel).join(' / ').slice(0, 80),
  }));
  return { t, b };
}

const revOf = (item) => ({ key: item.key, answer: item.answer, label: item.label || '' });

// Dice coefficient over adjacent-word pairs. Pairs, not words: two
// tossups on the same subject share a lot of vocabulary and almost no
// phrasing, while an edited question keeps most of its phrasing.
function bigrams(key) {
  const w = key.split(' ').filter((x) => x !== '*' && x !== '|');
  const out = new Set();
  for (let i = 0; i + 1 < w.length; i++) out.add(w[i] + ' ' + w[i + 1]);
  return out;
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return (2 * both) / (a.size + b.size);
}

const SAME_QUESTION = 0.5;        // phrasing overlap that makes it the same question...
const SAME_WITH_ANSWER = 0.25;    // ...or less, when the answerline also agrees

export function emptyLedger() {
  return { v: 1, seq: 0, questions: {} };
}

/**
 * Match one packet version's questions into the ledger.
 *
 * @param ledger    the set's ledger (not mutated), or null for a new set
 * @param packet    the packet number being uploaded
 * @param questions packetQuestions() of it
 * @param current   this version is the packet's current one (the normal
 *                  upload). false when back-filling a map for an older
 *                  version: ids are still assigned, but where questions
 *                  sit NOW is left as it was.
 * @returns {ledger, q, report, dropped}
 *   q       {t: [[id, rev], ...], b: [...]} — the version's question map
 *   report  per question {kind, pos, id, rev, isNew, edited, from}: from
 *           is [packet, pos] when the question sat somewhere else before
 *   dropped [{kind, id, was: [packet, pos]}] — in this packet before,
 *           and in no current packet now
 */
export function matchPacket(ledger, packet, questions, current = true) {
  const next = ledger && ledger.v === 1 && ledger.questions
    ? JSON.parse(JSON.stringify(ledger)) : emptyLedger();
  const q = { t: [], b: [] };
  const report = [];
  const used = new Set(); // ids already placed in this packet version

  for (const kind of ['t', 'b']) {
    const list = questions[kind] || [];
    const ids = Object.keys(next.questions).filter((id) => next.questions[id].kind === kind);
    const assigned = new Array(list.length).fill(null); // {id, rev, edited}

    // 1. identical wording
    const exact = new Map();
    for (const id of ids) {
      next.questions[id].revs.forEach((r, i) => { if (!exact.has(r.key)) exact.set(r.key, [id, i + 1]); });
    }
    list.forEach((item, i) => {
      const hit = exact.get(item.key);
      if (hit && !used.has(hit[0])) {
        assigned[i] = { id: hit[0], rev: hit[1], edited: false };
        used.add(hit[0]);
      }
    });

    // 2. reworded: best phrasing overlap first, one-to-one
    const pairs = [];
    const grams = new Map();
    const gramsOf = (key) => { if (!grams.has(key)) grams.set(key, bigrams(key)); return grams.get(key); };
    list.forEach((item, i) => {
      if (assigned[i]) return;
      for (const id of ids) {
        if (used.has(id)) continue;
        let best = 0;
        let sameAnswer = false;
        for (const r of next.questions[id].revs) {
          best = Math.max(best, dice(gramsOf(item.key), gramsOf(r.key)));
          if (item.answer && r.answer === item.answer) sameAnswer = true;
        }
        if (best >= SAME_QUESTION || (sameAnswer && best >= SAME_WITH_ANSWER)) pairs.push({ i, id, score: best });
      }
    });
    pairs.sort((x, y) => y.score - x.score);
    for (const { i, id } of pairs) {
      if (assigned[i] || used.has(id)) continue;
      next.questions[id].revs.push(revOf(list[i]));
      assigned[i] = { id, rev: next.questions[id].revs.length, edited: true };
      used.add(id);
    }

    // 3. everything else is new to the set
    list.forEach((item, i) => {
      const pos = i + 1;
      let a = assigned[i];
      const isNew = !a;
      if (isNew) {
        const id = String(++next.seq);
        next.questions[id] = { kind, revs: [revOf(item)], at: null };
        a = { id, rev: 1, edited: false };
        used.add(id);
      }
      // where it sat before: its current place, or — when the packet it
      // came out of was uploaded first — the place it was dropped from
      const was = next.questions[a.id].at || next.questions[a.id].last || null;
      const from = !isNew && was && (was[0] !== packet || was[1] !== pos) ? was : null;
      if (current) {
        next.questions[a.id].at = [packet, pos];
        delete next.questions[a.id].last;
      }
      q[kind].push([Number(a.id), a.rev]);
      report.push({ kind, pos, id: Number(a.id), rev: a.rev, isNew, edited: a.edited, from });
    });
  }

  // what this packet held before and no longer does
  const dropped = [];
  if (current) {
    for (const [id, item] of Object.entries(next.questions)) {
      if (item.at && item.at[0] === packet && !used.has(id)) {
        dropped.push({ kind: item.kind, id: Number(id), was: item.at });
        item.last = item.at;
        item.at = null;
      }
    }
  }
  return { ledger: next, q, report, dropped };
}

/**
 * The editor's correction: position `pos` of `kind` in `packet`'s
 * version (whose map is `q` and questions `questions`) IS question
 * `target` (an id in the ledger, of the same kind) — or, with target
 * null, a question the set has not seen. Returns {ledger, q} to store
 * with putQmap, like matchPacket. `current` as for matchPacket.
 */
export function assignQuestion(ledger, packet, questions, q, kind, pos, target, current = true) {
  const next = ledger && ledger.v === 1 && ledger.questions
    ? JSON.parse(JSON.stringify(ledger)) : emptyLedger();
  const map = { t: [...(q && q.t) || []], b: [...(q && q.b) || []] };
  const item = (questions[kind] || [])[pos - 1];
  if (!item) throw new Error('no such question');
  const before = map[kind][pos - 1];
  let id;
  let rev;
  if (target === null) {
    id = String(++next.seq);
    next.questions[id] = { kind, revs: [revOf(item)], at: null };
    rev = 1;
  } else {
    id = String(target);
    const entry = next.questions[id];
    if (!entry || entry.kind !== kind) throw new Error('no such question in the set');
    rev = entry.revs.findIndex((r) => r.key === item.key) + 1;
    if (!rev) { entry.revs.push(revOf(item)); rev = entry.revs.length; }
  }
  while (map[kind].length < pos) map[kind].push(null);
  map[kind][pos - 1] = [Number(id), rev];
  if (current) {
    next.questions[id].at = [packet, pos];
    delete next.questions[id].last;
    // the question this position was taken from, if it now sits nowhere
    if (before && String(before[0]) !== id) {
      const old = next.questions[String(before[0])];
      if (old && old.at && old.at[0] === packet && old.at[1] === pos) { old.last = old.at; old.at = null; }
    }
  }
  return { ledger: next, q: map };
}

/** The set's questions of one kind as picker choices, current packets
    first: [{id, label, at}]. */
export function ledgerChoices(ledger, kind) {
  if (!ledger || !ledger.questions) return [];
  return Object.entries(ledger.questions)
    .filter(([, e]) => e.kind === kind)
    .map(([id, e]) => ({ id: Number(id), label: e.revs[e.revs.length - 1].label || e.revs[e.revs.length - 1].answer, at: e.at || null }))
    .sort((a, b) => (a.at ? 0 : 1) - (b.at ? 0 : 1)
      || (a.at && b.at ? a.at[0] - b.at[0] || a.at[1] - b.at[1] : 0) || a.id - b.id);
}

/** One line for the editor: what an upload did to `packet`'s questions.
    Arrivals from another packet are named one by one; questions that
    only changed position inside the packet (everything after an
    insertion does) are counted, not listed. */
export function matchSummary({ report, dropped }, packet) {
  const label = (r) => (r.kind === 't' ? 'T' : 'B') + r.pos;
  const total = report.length;
  const isNew = report.filter((r) => r.isNew);
  const moved = report.filter((r) => r.from && r.from[0] !== packet);
  const shifted = report.filter((r) => r.from && r.from[0] === packet);
  const edited = report.filter((r) => r.edited);
  const parts = [];
  const same = report.filter((r) => !r.isNew && !r.edited && !r.from).length;
  if (same) parts.push(same === total ? 'all ' + total + ' questions unchanged' : same + ' unchanged');
  if (edited.length) parts.push(edited.length + ' reworded (' + edited.map(label).join(', ') + ')');
  if (moved.length) {
    parts.push(moved.length + ' moved in (' + moved.map((r) =>
      label(r) + ' from packet ' + r.from[0] + ' ' + (r.kind === 't' ? 'T' : 'B') + r.from[1]).join(', ') + ')');
  }
  if (shifted.length) parts.push(shifted.length + ' in a new position');
  if (isNew.length) parts.push(isNew.length === total ? 'all ' + total + ' questions new' : isNew.length + ' new (' + isNew.map(label).join(', ') + ')');
  if (dropped.length) parts.push(dropped.length + ' no longer in the set');
  return parts.join(' · ');
}
