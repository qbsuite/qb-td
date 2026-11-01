// yapp.js — a port of YAPP 1.3.1, the packet parser MODAQ reads .docx
// packets with (github.com/alopezlago/YetAnotherPacketParser, MIT ©
// Alejandro Lopez-Lago), so qb-td reads a .docx itself and asks the public
// YAPP service only when this can't.
//
// The aim is YAPP's own output for the same file, byte for byte: the
// JSON its web API answers with ?modaq=true (compact, as the Worker asks
// for), or its command line's (pretty, every field). That means keeping
// YAPP's quirks too, among them:
//   - only paragraphs directly in the body count (tables, content
//     controls and text boxes don't), and only runs directly in a
//     paragraph (a hyperlink's, a tracked insertion's or a field's
//     don't); a run's text is its <w:t>s, with <w:br>/<w:cr> breaking the
//     line, and tabs and special hyphens dropped;
//   - formatting is the run's own <w:b>, <w:i>, <w:u> and <w:vertAlign>,
//     never a style's, and the element being there is enough
//     (<w:b w:val="0"/> is bold, <w:u w:val="none"/> underlined);
//   - a paragraph with any <w:numId> is a numbered question;
//   - a question's lines are joined with nothing between them;
//   - line numbers in errors start at 2;
//   - text that reads as HTML goes through YAPP's sanitizer
//     (yapp_html.js), and the JSON escapes as .NET's JsonSerializer does
//     (& for &, é for é, ...).
//
// convertPacket returns {text} (YAPP's JSON), {errors} where YAPP would
// refuse the file with those messages, or {errors, unsure: true} where
// this port can't promise YAPP's answer — something .NET would read in a
// way this doesn't follow (YappUnsure) — so the caller asks YAPP.

import { readZip } from './zip.js';
import { sanitizeText, YappUnsure } from './yapp_html.js';

export { YappUnsure };

const unsure = (why) => { throw new YappUnsure(why); };

/* ---------- XML, as .NET's XmlReader reads a part ---------- */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XML_ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// characters XML 1.0 forbids (XmlReader's CheckCharacters)
const BAD_CHAR = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\ufffe\\uffff]'
  + '|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]');

function xmlDecode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&([^;&]*);|&/g, (m, ref) => {
    if (ref === undefined) unsure('a bare & in XML');
    if (ref[0] === '#') {
      const cp = /^#x[0-9a-fA-F]+$/.test(ref) ? parseInt(ref.slice(2), 16)
        : /^#[0-9]+$/.test(ref) ? parseInt(ref.slice(1), 10) : NaN;
      if (!(cp >= 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) unsure('a bad character reference');
      const c = String.fromCodePoint(cp);
      if (BAD_CHAR.test(c)) unsure('a forbidden character reference');
      return c;
    }
    if (!Object.prototype.hasOwnProperty.call(XML_ENT, ref)) unsure('an undeclared entity');
    return XML_ENT[ref];
  });
}

// part bytes -> text, as XmlReader decodes them
function partText(bytes) {
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { unsure('a part in a broken encoding'); }
  const decl = /^<\?xml\s[^?]*encoding\s*=\s*["']([^"']*)["']/.exec(text);
  if (decl && !/^(utf-8|utf-16|unicode)$/i.test(decl[1])) unsure('a part in ' + decl[1]);
  return text;
}

// One piece of markup at a '<': an end tag (1), a start tag's name (2),
// attributes (3) and / (4), a comment (5, no "--" inside, not ending in
// "-"), CDATA (6) or a processing instruction (7). Anything else (a DTD,
// a stray <) XmlReader refuses.
const MARKUP = new RegExp('<(?:/([^\\s>]+)[ \\t\\n]*>'
  + '|([^\\s/>!?]+)((?:[ \\t\\n]+[^\\s=/>]+[ \\t\\n]*=[ \\t\\n]*(?:"[^"<]*"|\'[^\'<]*\'))*)[ \\t\\n]*(/?)>'
  + '|!--((?:[^-]|-(?!-))*)-->|!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|\\?([\\s\\S]*?)\\?>)', 'y');
const ATTR = /([^\s=/>]+)[ \t\n]*=[ \t\n]*(?:"([^"]*)"|'([^']*)')/g;

// a start tag's attributes, read when asked: [qname, value] pairs
function rawAttrs(raw) {
  const out = [];
  if (!raw) return out;
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(raw))) out.push([m[1], xmlDecode((m[2] ?? m[3]).replace(/[\t\n]/g, ' '))]);
  return out;
}
const splitName = (q) => {
  const c = q.indexOf(':');
  return c < 0 ? ['', q] : [q.slice(0, c), q.slice(c + 1)];
};
// the value of attribute {ns}local in a start tag's raw attributes
function attrOf(raw, scope, local, ns) {
  if (!raw) return undefined;
  for (const [name, value] of rawAttrs(raw)) {
    const [p, l] = splitName(name);
    if (l === local && p !== 'xmlns' && name !== 'xmlns' && (p ? scope[p] : '') === ns) return value;
  }
  return undefined;
}

/**
 * Reads an XML document in one pass, as XmlReader would: well-formed,
 * namespaces resolved, no DTD, only XML's own entities. `on.start(local,
 * ns, raw, scope)` for each element (raw: its attributes, for attrOf),
 * `on.end()`, `on.text(value)`, `on.cdata(value)`, `on.other()` for
 * comments and processing instructions. Throws YappUnsure where XmlReader
 * would refuse the document.
 */
function readXml(src, on) {
  const s = src.replace(/\r\n?/g, '\n');
  if (BAD_CHAR.test(s)) unsure('a character XML forbids');
  const n = s.length;
  const names = [];
  const scopes = [{ xml: XML_NS, '': '' }];
  let rootSeen = false;
  let i = 0;
  while (i < n) {
    if (s.charCodeAt(i) !== 60) { // text up to the next <
      let j = s.indexOf('<', i);
      if (j < 0) j = n;
      const raw = s.slice(i, j);
      if (raw.includes(']]>')) unsure(']]> in text');
      if (names.length) on.text(xmlDecode(raw));
      else if (!/^[ \t\n]*$/.test(raw)) unsure('text outside the root');
      i = j;
      continue;
    }
    MARKUP.lastIndex = i;
    const m = MARKUP.exec(s);
    if (!m) unsure('markup XmlReader refuses');
    i = MARKUP.lastIndex;
    if (m[1] !== undefined) {
      if (names.pop() !== m[1]) unsure('mismatched tags');
      scopes.pop();
      on.end();
    } else if (m[2] !== undefined) {
      if (!names.length && rootSeen) unsure('two root elements');
      rootSeen = true;
      const raw = m[3];
      let scope = scopes[scopes.length - 1];
      if (raw && raw.includes('xmlns')) {
        const seen = new Set();
        for (const [name, value] of rawAttrs(raw)) {
          if (seen.has(name)) unsure('a repeated attribute');
          seen.add(name);
          if (name === 'xmlns' || name.startsWith('xmlns:')) {
            if (scope === scopes[scopes.length - 1]) scope = Object.create(scope);
            scope[name === 'xmlns' ? '' : name.slice(6)] = value;
          }
        }
      }
      const [prefix, local] = splitName(m[2]);
      const ns = scope[prefix];
      if (ns === undefined) unsure('an unbound prefix');
      on.start(local, ns, raw, scope);
      if (m[4]) on.end();
      else { names.push(m[2]); scopes.push(scope); }
    } else if (m[6] !== undefined) {
      if (!names.length) unsure('CDATA outside the root');
      on.cdata(m[6]);
    } else {
      if (m[7] !== undefined && /^xml[\s?]/i.test(m[7] + ' ') && m.index !== 0) unsure('an XML declaration not at the start');
      if (names.length) on.other();
    }
  }
  if (names.length || !rootSeen) unsure('an unfinished document');
}

// a small part as a tree: {local, ns, attrs: {local: value} (no-namespace
// ones), children}, text left out
function xmlTree(src) {
  let root = null;
  const stack = [];
  readXml(src, {
    start(local, ns, raw) {
      const attrs = {};
      for (const [name, value] of rawAttrs(raw)) if (!name.includes(':') && name !== 'xmlns') attrs[name] = value;
      const el = { local, ns, attrs, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(el);
      else root = el;
      stack.push(el);
    },
    end() { stack.pop(); },
    text() {}, cdata() {}, other() {},
  });
  return root;
}

/* ---------- the package: which part is the document ---------- */

const MAIN_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  'application/vnd.ms-word.document.macroEnabled.main+xml',
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
]);
const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/';

// the main document part's text
async function documentXml(bytes) {
  let entries;
  // only the parts this reads are inflated; the rest (images) are just named
  const want = (name) => /^(\[content_types\]\.xml|_rels\/\.rels|word\/[^/]*\.xml)$/i.test(name);
  try { entries = await readZip(bytes, want); }
  catch { return unsure('a zip this reader cannot open'); }
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  // YAPP reads a zip holding .docx files as a set of packets
  if (!byName.has('word/document.xml') || entries.some((e) => /\.docx$/i.test(e.name.split('/').pop()))) {
    unsure('not a single .docx');
  }
  const types = byName.get('[content_types].xml');
  const rels = byName.get('_rels/.rels');
  if (!types || !rels) unsure('a package without content types or relationships');
  const relRoot = xmlTree(partText(rels.data));
  const main = relRoot.children.filter((r) => r.local === 'Relationship' && r.ns === PKG_NS + 'relationships'
    && r.attrs.Type === OFFICE_DOC_REL && r.attrs.TargetMode !== 'External');
  if (main.length !== 1) unsure('no single main document');
  const target = main[0].attrs.Target;
  if (!target || /[?#%\\]|^[a-z]+:/i.test(target)) unsure('an unusual main document name');
  const partName = target.startsWith('/') ? target : '/' + target;
  const part = byName.get(partName.slice(1).toLowerCase());
  if (!part || !part.data) unsure('a missing main document');
  // its content type: an Override for it, else the Default for its extension
  const typeEls = xmlTree(partText(types.data)).children;
  const ext = partName.split('.').pop().toLowerCase();
  const override = typeEls.find((t) => t.local === 'Override' && (t.attrs.PartName || '').toLowerCase() === partName.toLowerCase());
  const def = typeEls.find((t) => t.local === 'Default' && (t.attrs.Extension || '').toLowerCase() === ext);
  if (!MAIN_TYPES.has((override || def)?.attrs.ContentType)) unsure('a main document of another type');
  const xml = partText(part.data);
  // OpenSettings.MaxCharactersInPart is 2 MB of characters
  if (xml.length > 2 * 1024 * 1024 - 1024) unsure('a document near YAPP\'s size limit');
  return xml;
}

/**
 * document.xml -> the body's lines, as DocxLexer.GetTextBlockLines sees
 * them: each a list of blocks {text, run: {b, i, u, align}, numVal}.
 * The Open XML SDK gives a paragraph's numbering, a run's properties and
 * each of those properties as the first such child, wherever it is, so a
 * run's properties fill in as its children arrive. null: no body.
 */
function textBlockLines(xml) {
  const lines = [];
  // what each open element is, as far as YAPP looks: doc, body, p, pPr,
  // numPr, r, rPr or t (null: nothing it reads)
  const kinds = [];
  let bodySeen = false;
  let para = null;
  let run = null;
  let t = null; // the open <w:t>: {nodes, text}
  readXml(xml, {
    start(local, ns, raw, scope) {
      const parent = kinds.length ? kinds[kinds.length - 1] : 'top';
      let kind = null;
      if (parent === 'top') {
        if (ns !== W || local !== 'document') unsure('a document in another schema');
        kind = 'doc';
      } else if (parent === 'doc') {
        if (local === 'body' && ns === W && !bodySeen) { bodySeen = true; kind = 'body'; }
      } else if (parent === 'body') {
        if (local === 'p') {
          if (ns !== W) unsure('a paragraph in another schema');
          para = { blocks: [], first: null, pPr: false, numPr: false, numId: false, numVal: undefined };
          kind = 'p';
        }
      } else if (parent === 'p') {
        if (local === 'pPr' && ns === W && !para.pPr) { para.pPr = true; kind = 'pPr'; }
        else if (local === 'r') {
          if (ns !== W) unsure('a run in another schema');
          run = { rPr: false, b: false, i: false, u: false, alignSeen: false, align: undefined };
          kind = 'r';
        }
      } else if (parent === 'pPr') {
        if (local === 'numPr' && ns === W && !para.numPr) { para.numPr = true; kind = 'numPr'; }
      } else if (parent === 'numPr') {
        if (local === 'numId' && ns === W && !para.numId) { para.numId = true; para.numVal = attrOf(raw, scope, 'val', W); }
      } else if (parent === 'r') {
        if (local === 'rPr' && ns === W && !run.rPr) { run.rPr = true; kind = 'rPr'; }
        else if (local === 't') {
          if (ns !== W) unsure('text in another schema');
          t = { nodes: 0, text: '' };
          kind = 't';
        } else if (local === 'br' || local === 'cr') {
          if (para.blocks.length) { lines.push(para.blocks); para.blocks = []; }
        }
      } else if (parent === 'rPr') {
        if (ns === W) {
          if (local === 'b') run.b = true;
          else if (local === 'i') run.i = true;
          else if (local === 'u') run.u = true;
          else if (local === 'vertAlign' && !run.alignSeen) { run.alignSeen = true; run.align = attrOf(raw, scope, 'val', W); }
        }
      } else if (parent === 't') {
        unsure('a <w:t> holding an element');
      }
      kinds.push(kind);
    },
    end() {
      const kind = kinds.pop();
      if (kind === 't') {
        // OpenXmlLeafTextElement keeps its one text node
        if (t.nodes > 1) unsure('a <w:t> holding more than text');
        const block = { text: t.text, run, numVal: undefined };
        para.blocks.push(block);
        if (!para.first) para.first = block;
        t = null;
      } else if (kind === 'p') {
        // the numbering goes to the paragraph's first text
        if (para.first && para.numId) para.first.numVal = para.numVal;
        lines.push(para.blocks); // blank lines too, as YAPP keeps them
        para = null;
      }
    },
    text(value) { if (t) { t.nodes++; t.text = value; } },
    cdata(value) { if (t) { t.nodes++; t.text = value; } },
    other() { if (t) t.nodes += 2; },
  });
  return bodySeen ? lines : null;
}

/* ---------- the lexer: DocxLexer + LexerClassifier ---------- */

// .NET's \s and \d: Unicode whitespace (with U+0085, without U+FEFF) and digits
const S = '[\\t\\n\\v\\f\\r\\x85\\p{Z}]';
const D = '\\p{Nd}';
const ANSWER_RE = new RegExp(`^${S}*[Aa][Nn][Ss]([Ww][Ee][Rr])?${S}*(:|\\.)${S}*`, 'u');
const QUESTION_DIGIT_RE = new RegExp(`^${S}*(${D}+|[Tt][Bb]|[Tt][Ii][Ee]([Bb][Rr][Ee][Aa][Kk][Ee][Rr])?)${S}*\\.${S}*`, 'u');
const BONUS_PART_RE = new RegExp(`^${S}*\\[(${S}*(${D}+${S}*[EeHhMm]?${S}*|[EeHhMm]${S}*))\\]${S}*`, 'u');
const METADATA_RE = new RegExp(`^${S}*<[^<>]+>${S}*`, 'u');
const TRIM_RE = new RegExp(`^${S}+|${S}+$`, 'gu');

// int.TryParse on what \d matched: ASCII digits only, and it must fit an int
// (\p{Nd} here also takes digits beyond the BMP, which .NET's \d, matching
// UTF-16 units, never does)
const astral = (m) => /[\ud800-\udfff]/.test(m) && unsure('a digit beyond the BMP');
const tryInt = (s) => (/^[0-9]+$/.test(s) && Number(s) <= 2147483647 ? Number(s) : null);

function classifyQuestionDigit(text) {
  const m = QUESTION_DIGIT_RE.exec(text);
  if (m) astral(m[0]);
  return m ? { match: m[0], number: tryInt(m[1]) } : null;
}

function classifyBonusPart(text) {
  const m = BONUS_PART_RE.exec(text);
  if (!m) return null;
  astral(m[0]);
  let value = m[1].replace(TRIM_RE, '');
  let mod = null;
  if (value.length && /\p{L}/u.test(value[value.length - 1])) {
    mod = value[value.length - 1].toLowerCase();
    value = value.slice(0, -1).replace(new RegExp(`${S}+$`, 'u'), '');
  }
  if (!value.length) return { match: m[0], value: 10, mod };
  const v = tryInt(value);
  return v === null ? null : { match: m[0], value: v, mod };
}

const seg = (text, f) => ({ text, i: f.i, b: f.b, u: f.u, sub: f.sub, sup: f.sup });
const plainText = (segs) => segs.map((s) => s.text).join('');

// FormattedText.Substring: the segments from character `start` on
function substring(segs, start) {
  if (start === 0) return segs;
  let index = 0;
  for (let k = 0; k < segs.length; k++) {
    const next = index + segs[k].text.length;
    if (index <= start && next > start) return [seg(segs[k].text.slice(start - index), segs[k]), ...segs.slice(k + 1)];
    index = next;
  }
  return [];
}

// DocxLexer.GetLinesFromTextBlockLines
function lexLines(blockLines) {
  let lastNumberingId = null;
  let currentQuestionNumber = 1;
  const lines = [];
  let f = { b: false, i: false, u: false, sub: false, sup: false };
  let current = '';
  for (const blocks of blockLines) {
    const segs = [];
    let currentNumberingId = null;
    for (const block of blocks) {
      const r = block.run;
      if (r.b !== f.b || r.i !== f.i || r.u !== f.u || (r.align === 'subscript') !== f.sub || (r.align === 'superscript') !== f.sup) {
        if (current.length) { segs.push(seg(current, f)); current = ''; }
        f = { b: r.b, i: r.i, u: r.u, sub: r.align === 'subscript', sup: r.align === 'superscript' };
      }
      current += block.text;
      const val = block.numVal;
      if (val !== undefined) {
        // Int32Value: XmlConvert.ToInt32
        if (!/^[ \t\n\r]*-?[0-9]+[ \t\n\r]*$/.test(val) || Math.abs(Number(val)) > 2147483647) unsure('a numId that is not a number');
        currentNumberingId = Number(val);
      }
    }
    if (current.length) { segs.push(seg(current, f)); current = ''; }
    if (currentNumberingId !== null && lastNumberingId !== currentNumberingId) {
      lastNumberingId = currentNumberingId;
      currentQuestionNumber = 1;
    }
    if (!segs.length) continue;
    const text = plainText(segs);
    const q = classifyQuestionDigit(text);
    let a; let bp;
    if (q) {
      let number;
      if (q.number !== null) { number = q.number; currentQuestionNumber = q.number + 1; }
      else number = currentQuestionNumber++; // a tiebreaker: the next number
      lines.push({ type: 'NumberedQuestion', text: substring(segs, q.match.length), number });
    } else if (currentNumberingId !== null) {
      lines.push({ type: 'NumberedQuestion', text: segs, number: currentQuestionNumber++ });
    } else if ((a = ANSWER_RE.exec(text))) {
      lines.push({ type: 'Answer', text: substring(segs, a[0].length) });
    } else if ((bp = classifyBonusPart(text))) {
      lines.push({ type: 'BonusPart', text: substring(segs, bp.match.length), value: bp.value, mod: bp.mod });
    } else if (METADATA_RE.test(text)) {
      lines.push({ type: 'PostQuestionMetadata', text: segs });
    } else {
      lines.push({ type: 'Unclassified', text: segs });
    }
  }
  return lines;
}

/* ---------- the parser: LinesParser ---------- */

const SNIPPET = 40;
const MAX_ERRORS = 10;

// what LinesParser fails with
class ParseFail { constructor(errors) { this.errors = errors; } }
// a .NET exception YAPP's converter turns into "Unknown error: ..."
class DotnetArgumentError extends Error {}

class Lines {
  constructor(lines) { this.lines = lines; this.index = -1; this.lineNumber = 1; }
  get current() { return this.lines[this.index] ?? null; }
  moveNext() {
    if (this.index < this.lines.length) this.index++;
    if (this.index < this.lines.length) { this.lineNumber++; return true; }
    return false;
  }
}

function failureMessage(lines, message) {
  let snippet = '';
  if (lines.current) {
    for (const s of lines.current.text) {
      const remaining = SNIPPET - snippet.length;
      snippet += s.text.length <= remaining ? s.text : s.text.slice(0, remaining);
    }
  }
  return `${message} (Line #${lines.lineNumber}${snippet.length ? `, "${snippet}"` : ''})`;
}

function addErrors(errors, more) {
  let limit = MAX_ERRORS - errors.length;
  for (const e of more) {
    if (limit <= 0) return true;
    errors.push(e);
    limit--;
  }
  return false;
}

function textFromLines(lines, context, expected) {
  let segs = lines.current.text;
  if (lines.current.type === expected) return segs;
  let checked = 0;
  let found = false;
  while (lines.moveNext()) {
    if (lines.current.type === expected) { found = true; break; }
    if (lines.current.type !== 'Unclassified') {
      throw new ParseFail([failureMessage(lines,
        `Unexpected line found. Was expecting a line of type "${expected}", but found a line of type "${lines.current.type}"`)]);
    }
    segs = segs.concat(lines.current.text);
    checked++;
  }
  if (!found) {
    throw new ParseFail([failureMessage(lines,
      `Failed to parse ${context}. No more lines found. Number of lines searched for after the last part: ${checked + 1}`)]);
  }
  return segs;
}

function postQuestionMetadata(lines) {
  if (!lines.current) return null;
  do {
    const t = lines.current.type;
    if (t === 'Answer' || t === 'Unclassified') continue;
    return t === 'PostQuestionMetadata' ? lines.current : null;
  } while (lines.moveNext());
  return null;
}

function metadataText(lines) {
  const line = postQuestionMetadata(lines);
  if (!line) return null;
  let metadata = plainText(line.text);
  if (metadata.length > 2) {
    const start = metadata.indexOf('<');
    const end = metadata.lastIndexOf('>');
    if (start >= 0 && end > start) {
      // metadata.Substring(start + 1, end - 1): the length is off when < isn't first
      if (start + 1 + (end - 1) > metadata.length) {
        throw new DotnetArgumentError("Index and length must refer to a location within the string. (Parameter 'length')");
      }
      metadata = metadata.substr(start + 1, end - 1);
    }
  }
  return metadata;
}

function nextQuestionLine(lines) {
  if (!lines.current) return null;
  do {
    if (lines.current.type === 'NumberedQuestion') return lines.current;
  } while (lines.moveNext());
  return null;
}

function parseQuestion(lines, context) {
  const question = textFromLines(lines, context, 'Answer');
  if (lines.current.type !== 'Answer') {
    throw new ParseFail([failureMessage(lines,
      `Failed to parse ${context}. Expected answer line, but found an "${lines.current.type}" line.`)]);
  }
  return { question, answer: lines.current.text };
}

function parseTossup(lines, tossupNumber) {
  if (lines.current?.type !== 'NumberedQuestion') {
    throw new ParseFail([failureMessage(lines, `Failed to parse tossup #${tossupNumber}. No question number found.`)]);
  }
  const number = lines.current.number;
  const q = parseQuestion(lines, `tossup #${tossupNumber}`);
  return { number, ...q, metadata: metadataText(lines) };
}

function parseBonusParts(lines) {
  const parts = [];
  do {
    if (lines.current.type !== 'BonusPart') break;
    const line = lines.current;
    const q = parseQuestion(lines, `bonus part #${parts.length + 1}`);
    parts.push({ ...q, value: line.value, mod: line.mod });
  } while (lines.moveNext());
  if (!parts.length) {
    throw new ParseFail([failureMessage(lines, "Failed to parse bonus parts. Couldn't find the part's value in the first block of text.")]);
  }
  return parts;
}

function parseBonus(lines, bonusNumber) {
  if (lines.current?.type !== 'NumberedQuestion') {
    throw new ParseFail([failureMessage(lines, `Failed to parse bonus #${bonusNumber}. No question number found.`)]);
  }
  const number = lines.current.number;
  const leadin = textFromLines(lines, `Bonus leadin (#${bonusNumber})`, 'BonusPart');
  const parts = parseBonusParts(lines);
  return { number, leadin, parts, metadata: metadataText(lines) };
}

// one question parsed, or its errors
const attempt = (fn) => {
  try { return { value: fn() }; }
  catch (e) { if (e instanceof ParseFail) return { errors: e.errors }; throw e; }
};

function parseTossups(lines) {
  let currentNumber = -1;
  const tossups = [];
  let errors = null;
  let line;
  while ((line = nextQuestionLine(lines)) && line.number > currentNumber) {
    currentNumber = line.number;
    const r = attempt(() => parseTossup(lines, tossups.length + 1));
    if (r.errors) {
      errors = errors || [];
      if (addErrors(errors, r.errors)) break;
      continue;
    }
    tossups.push(r.value);
  }
  if (!tossups.length && errors && errors.length !== MAX_ERRORS) {
    errors.push(failureMessage(lines, 'Failed to parse tossups. No tossups found.'));
  }
  return { tossups, errors, more: line !== null };
}

function parseBonuses(lines) {
  const bonuses = [];
  let errors = null;
  while (nextQuestionLine(lines)) {
    const r = attempt(() => parseBonus(lines, bonuses.length + 1));
    if (r.errors) {
      errors = errors || [];
      if (addErrors(errors, r.errors)) break;
      continue;
    }
    bonuses.push(r.value);
  }
  return { bonuses, errors };
}

function parsePacket(lineList) {
  const lines = new Lines(lineList);
  if (!lines.moveNext()) throw new ParseFail(['Cannot parse empty packet.']);
  const t = parseTossups(lines);
  if (!t.more) {
    if (t.errors) throw new ParseFail(t.errors);
    return { tossups: t.tossups, bonuses: null };
  }
  const b = parseBonuses(lines);
  const errors = [...(t.errors || []), ...(b.errors || [])];
  if (errors.length) throw new ParseFail(errors);
  return { tossups: t.tossups, bonuses: b.bonuses };
}

/* ---------- the compiler: sanitizer + JsonCompiler ---------- */

// FormattedTextExtensions.WriteFormattedText
function withTags(segs) {
  let out = '';
  let b = false; let i = false; let u = false; let sub = false; let sup = false;
  for (const s of segs) {
    if (sup && !s.sup) { out += '</sup>'; sup = false; }
    if (sub && !s.sub) { out += '</sub>'; sub = false; }
    if (i && !s.i) { out += '</em>'; i = false; }
    if (u && !s.u) { out += '</u>'; u = false; }
    if (b !== s.b) { out += s.b ? '<b>' : '</b>'; b = s.b; }
    if (!u && s.u) { out += '<u>'; u = true; }
    if (!i && s.i) { out += '<em>'; i = true; }
    if (!sub && s.sub) { out += '<sub>'; sub = true; }
    if (!sup && s.sup) { out += '<sup>'; sup = true; }
    out += s.text;
  }
  if (b) out += '</b>';
  if (u) out += '</u>';
  if (i) out += '</em>';
  if (sub) out += '</sub>';
  if (sup) out += '</sup>';
  return out;
}

const cleanSegs = (segs) => segs.map((s) => seg(sanitizeText(s.text), s));
const cleanMetadata = (m) => (m === null ? null : sanitizeText(m.replace(/</g, '&lt;').replace(/>/g, '&gt;')));

function packetJson(packet, modaq) {
  const tossups = packet.tossups.map((t) => {
    const question = cleanSegs(t.question);
    const answer = cleanSegs(t.answer);
    return {
      number: modaq ? null : t.number,
      question: withTags(question),
      answer: withTags(answer),
      metadata: cleanMetadata(t.metadata),
      question_sanitized: modaq ? null : plainText(question),
      answer_sanitized: modaq ? null : plainText(answer),
    };
  });
  const bonuses = packet.bonuses && packet.bonuses.map((bonus) => {
    const leadin = cleanSegs(bonus.leadin);
    const parts = bonus.parts.map((p) => ({ question: cleanSegs(p.question), answer: cleanSegs(p.answer) }));
    return {
      leadin: withTags(leadin),
      leadin_sanitized: modaq ? null : plainText(leadin),
      parts: parts.map((p) => withTags(p.question)),
      parts_sanitized: modaq ? null : parts.map((p) => plainText(p.question)),
      answers: parts.map((p) => withTags(p.answer)),
      answers_sanitized: modaq ? null : parts.map((p) => plainText(p.answer)),
      values: bonus.parts.map((p) => p.value),
      difficultyModifiers: bonus.parts.some((p) => p.mod !== null) ? bonus.parts.map((p) => p.mod) : null,
      metadata: cleanMetadata(bonus.metadata),
    };
  });
  return { tossups, bonuses };
}

// System.Text.Json with JavaScriptEncoder.Default: printable ASCII stays,
// except the HTML-sensitive " & ' + < > ` and \; everything else is \uXXXX
const SHORT = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '\\': '\\\\' };
const jsonString = (s) => '"' + s.replace(/[^\x20-\x7e]|["&'+<>\\`]/g,
  (c) => SHORT[c] || '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')) + '"';

// JsonSerializer.Serialize, nulls left out of objects (WhenWritingNull)
function serialize(value, pretty, depth = 0) {
  const nl = pretty ? '\n' + '  '.repeat(depth + 1) : '';
  const end = pretty ? '\n' + '  '.repeat(depth) : '';
  if (value === null) return 'null';
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[' + value.map((v) => nl + serialize(v, pretty, depth + 1)).join(',') + end + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== null);
  if (!keys.length) return '{}';
  return '{' + keys.map((k) => nl + jsonString(k) + (pretty ? ': ' : ':') + serialize(value[k], pretty, depth + 1)).join(',') + end + '}';
}

/* ---------- PacketConverter ---------- */

const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b
  && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8));

/**
 * A .docx packet -> what YAPP makes of it.
 * @param bytes Uint8Array (or ArrayBuffer) of the file
 * @param modaq true: the ?modaq=true web API's JSON (no numbers, no
 *   _sanitized fields); false: every field, as the command line writes it
 * @param pretty indented, as the command line writes it; the API doesn't
 * @returns {text} | {errors} | {errors, unsure: true}
 */
export async function convertPacket(bytes, { modaq = true, pretty = false } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    // anything not a zip YAPP reads as HTML, which this doesn't
    if (!isZip(b)) unsure('not a .docx');
    const blockLines = textBlockLines(await documentXml(b));
    if (!blockLines) return { errors: ['Lexing Error.', "Unable to open the .docx file: Couldn't find the body of the document."] };
    const lines = lexLines(blockLines);
    let packet;
    try { packet = parsePacket(lines); }
    catch (e) {
      if (e instanceof ParseFail) return { errors: ['Parse Error.', ...e.errors] };
      throw e;
    }
    return { text: serialize(packetJson(packet, modaq), pretty) };
  } catch (e) {
    if (e instanceof YappUnsure) return { errors: [e.message], unsure: true };
    if (e instanceof DotnetArgumentError) return { errors: ['Unknown error: ' + e.message] };
    throw e;
  }
}

// for tests/yapp_port.mjs, which follows YAPP's own unit tests
export const _internal = { readXml, textBlockLines, lexLines, parsePacket, packetJson, serialize, withTags, substring,
  classifyQuestionDigit, classifyBonusPart, ANSWER_RE, METADATA_RE, ParseFail };
