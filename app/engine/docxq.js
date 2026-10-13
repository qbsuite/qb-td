// docxq.js — qb-td's own fallback reader for .docx question files.
//
// Packets in .docx normally go through the public YAPP service. YAPP
// expects a whole packet (numbered tossups, then bonuses), so it refuses
// the files a tiebreaker pool is made of: bonuses alone, or tossups whose
// numbering restarts or reads "TB1.". This reads the same documents by
// their lines instead of their numbering:
//   - a line starting "ANSWER:" is an answer;
//   - a line starting "[10]" (or [10e], [15], [M], ...) is a bonus part;
//   - any other text is a question: a tossup when an answer follows it
//     directly, a bonus leadin when a part does.
// The output is the packet JSON YAPP gives MODAQ ({tossups, bonuses},
// answers and emphasis marked with <b>, <u> and <em>), so everything
// downstream treats it the same.
//
// It is deliberately a fallback (packetsui.js says so when it is used):
// it knows nothing of YAPP's rarer layouts, and anything it can't place
// is reported rather than guessed at.

import { readZip } from './zip.js';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  }
  return Object.prototype.hasOwnProperty.call(XML_ENTITIES, e) ? XML_ENTITIES[e] : m;
});
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// <w:b/> is on; <w:b w:val="0"/> (or false/none) switches an inherited one off
const propOn = (rPr, tag) => {
  const m = new RegExp('<w:' + tag + '(?:\\s[^>]*)?/?>').exec(rPr);
  if (!m) return false;
  const val = /w:val="([^"]*)"/.exec(m[0]);
  return !val || !/^(0|false|none|off)$/i.test(val[1]);
};

/**
 * A document.xml string -> its lines, in order:
 * [[{text, b, u, i}, ...], ...]. A line is a paragraph, or the piece of
 * one between line breaks (a question and its ANSWER: are often one
 * paragraph with a break between them). Runs carry their own bold,
 * underline and italic; tabs become spaces. Text inside tables comes out
 * in reading order like any other.
 */
export function docxParagraphs(xml) {
  const out = [];
  const paraRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = paraRe.exec(xml))) {
    let line = [];
    const runRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
    let rm;
    while ((rm = runRe.exec(pm[1]))) {
      const body = rm[1];
      const rPr = (/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body) || [, ''])[1];
      const fmt = { b: propOn(rPr, 'b'), u: propOn(rPr, 'u'), i: propOn(rPr, 'i') };
      let text = '';
      const flush = () => { if (text) line.push({ text, ...fmt }); text = ''; };
      const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)(?:\s[^>]*)?\/>|<w:noBreakHyphen\/>/g;
      let tm;
      while ((tm = partRe.exec(body))) {
        if (tm[1] !== undefined) text += decodeXml(tm[1]);
        else if (tm[2] === 'tab') text += ' ';
        else if (tm[2]) { flush(); out.push(line); line = []; }
        else text += '-';
      }
      flush();
    }
    out.push(line);
  }
  return out;
}

const plain = (runs) => runs.map((r) => r.text).join('').replace(/[ \s]+/g, ' ').trim();

// Runs -> the marked-up text MODAQ shows, with `skip` leading characters
// (a question number, "ANSWER:", "[10]") left out.
function markup(runs, skip) {
  let left = skip;
  let html = '';
  let open = '';
  const close = () => { html += open.split('').reverse().map((t) => `</${t === 'e' ? 'em' : t}>`).join(''); open = ''; };
  for (const r of runs) {
    let text = r.text.replace(/ /g, ' ');
    if (left > 0) {
      const cut = Math.min(left, text.length);
      text = text.slice(cut);
      left -= cut;
    }
    if (!text) continue;
    const want = (r.b ? 'b' : '') + (r.u ? 'u' : '') + (r.i ? 'e' : '');
    // whitespace between two runs of the same emphasis stays inside it
    if (want !== open && text.trim()) {
      close();
      // the space before a bold or italic word stays outside its tags
      const lead = /^\s*/.exec(text)[0];
      html += lead;
      text = text.slice(lead.length);
      html += want.split('').map((t) => `<${t === 'e' ? 'em' : t}>`).join('');
      open = want;
    }
    html += escapeHtml(text);
  }
  close();
  return html.replace(/\s+/g, ' ').replace(/\s+(<\/(?:b|u|em)>)/g, '$1 ').replace(/\s+/g, ' ').trim();
}

const ANSWER_RE = /^\s*answer\s*:\s*/i;
// [10], [10e], [15], [5], [M], [E], [H], [10m]: a bonus part's marker
const PART_RE = /^\s*\[\s*(\d{1,2})?\s*([emh])?\s*\]\s*/i;
// a question's own number or label: "1.", "12)", "TB1.", "Tiebreaker 2:", "Tossup 3."
const NUMBER_RE = /^\s*(?:(?:tb|tiebreakers?|tossups?|bonus(?:es)?|extra|replacement)\s*#?\s*\d*|#?\d+)\s*[.):]\s*/i;
// a heading between questions, never part of one
const HEADING_RE = /^\s*(?:tossups?|bonus(?:es)?|tiebreakers?|tie-breakers?|extras?|replacements?|spares?|packet|round|finals?)\b[^.?!]{0,40}$/i;
// "<Science, Biology>" or "<JD>" under an answer: the question's tag line
const TAG_RE = /^\s*<[^<>]{1,80}>\s*$/;

/**
 * Paragraphs (docxParagraphs) -> { tossups, bonuses, skipped }.
 * skipped: the text of every line that couldn't be placed, so the caller
 * can show what was left out.
 */
export function questionsFromParagraphs(paragraphs) {
  const tossups = [];
  const bonuses = [];
  const skipped = [];
  let block = [];      // question text lines waiting for what follows them
  let bonus = null;    // the bonus being read
  let part = null;     // its part waiting for an answer
  let last = null;     // the question the next tag line belongs to

  const takeBlock = () => {
    // A question is one line: the one right above its answer or first
    // part. Anything else waiting there (a credit line, a note to the
    // moderator) is reported as left out, headings aside.
    const lines = block.filter((runs) => !HEADING_RE.test(plain(runs)));
    block = [];
    if (!lines.length) return '';
    for (const runs of lines.slice(0, -1)) skipped.push(plain(runs));
    const runs = lines[lines.length - 1];
    const raw = runs.map((r) => r.text).join('');
    const num = NUMBER_RE.exec(raw);
    // only strip a number when text follows it
    return markup(runs, num && raw.slice(num[0].length).trim() ? num[0].length : 0);
  };
  const endBonus = () => {
    if (part) { skipped.push(part.text); part = null; }
    if (bonus && bonus.parts.length) { bonuses.push(bonus); last = bonus; }
    else if (bonus && bonus.leadin) skipped.push(bonus.leadin);
    bonus = null;
  };

  for (const runs of paragraphs) {
    const text = plain(runs);
    if (!text) continue;
    const raw = runs.map((r) => r.text).join('');

    if (TAG_RE.test(text)) {
      if (last && !block.length && !part) last.metadata = text.replace(/^\s*<|>\s*$/g, '').trim();
      continue;
    }

    const pm = PART_RE.exec(raw);
    // "[10]" needs something after it to be a part ("[1]" as a footnote isn't)
    if (pm && (pm[1] || pm[2]) && raw.slice(pm[0].length).trim()) {
      if (part) { skipped.push(part.text); part = null; }
      if (block.length || !bonus) {
        endBonus();
        bonus = { leadin: takeBlock(), parts: [], answers: [], values: [] };
      }
      part = { text: markup(runs, pm[0].length), value: Number(pm[1]) || 10, diff: (pm[2] || '').toLowerCase() };
      continue;
    }

    const am = ANSWER_RE.exec(raw);
    if (am) {
      const answer = markup(runs, am[0].length);
      if (part) {
        bonus.parts.push(part.text);
        bonus.answers.push(answer);
        bonus.values.push(part.value);
        if (part.diff || bonus.difficultyModifiers) {
          bonus.difficultyModifiers = bonus.difficultyModifiers || bonus.parts.slice(0, -1).map(() => '');
          bonus.difficultyModifiers.push(part.diff);
        }
        part = null;
        last = bonus; // a tag line under the last part belongs to the bonus
      } else if (block.length) {
        endBonus();
        const question = takeBlock();
        if (question) { last = { question, answer }; tossups.push(last); }
        else skipped.push(text);
      } else {
        skipped.push(text);
      }
      continue;
    }

    // plain text: a new question starts, so a bonus being read is over
    if (bonus && !part) endBonus();
    if (part) { part.text += ' ' + markup(runs, 0); continue; } // a part running onto a second line
    block.push(runs);
  }
  endBonus();
  for (const runs of block) {
    const text = plain(runs);
    if (!HEADING_RE.test(text)) skipped.push(text);
  }
  for (const b of bonuses) {
    if (b.difficultyModifiers && !b.difficultyModifiers.some(Boolean)) delete b.difficultyModifiers;
  }
  return { tossups, bonuses, skipped };
}

/**
 * A .docx file's bytes -> { tossups, bonuses, skipped }. Throws when the
 * bytes aren't a Word document or hold no questions at all.
 */
export async function parseDocxQuestions(bytes) {
  let entries;
  try { entries = await readZip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  catch (e) { throw new Error('not a .docx file'); }
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('not a .docx file');
  const out = questionsFromParagraphs(docxParagraphs(new TextDecoder().decode(doc.data)));
  if (!out.tossups.length && !out.bonuses.length) throw new Error('no questions found');
  return out;
}
