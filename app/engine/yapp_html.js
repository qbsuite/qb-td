// yapp_html.js — what YAPP's HTML sanitizer makes of one run of packet
// text (yapp.js's port of YAPP's SanitizeHtmlTransformer).
//
// YAPP passes each run of text through Ganss.Xss HtmlSanitizer 9.0.892
// with no tag allowed: AngleSharp 0.17.1 parses the run as the body of
// "<!doctype html><html><body>" + text, every element is removed along
// with everything inside it, comments go, and the body's remaining text is
// written back out with &, <, > and the no-break space escaped. So plain
// text comes back with its character references decoded and those four
// escaped, and anything that parses as a tag takes the rest of its
// element with it.
//
// The HTML tree rules that decide where an element ends are long; this
// follows them for what packet text can hold (stray < signs, an unknown
// <tag> or two, inline elements closed in order) and throws YappUnsure for
// the rest — tables, forms, foreign content, end tags out of order — so
// that a packet holding one goes to YAPP itself instead of being guessed.

import { decodeEntities } from './entities.js';

export class YappUnsure extends Error {}

const words = (s) => new Set(s.trim().split(/\s+/));

// start tags that close nothing and hold nothing
const VOID = words('area br embed img keygen wbr input param source track base basefont bgsound link meta image');
// start tags the body ignores (their attributes go to <html>/<body>, which aren't written out)
const IGNORED = words('html body head caption col colgroup frame tbody td tfoot th thead tr');
// elements whose content is raw text up to their own end tag
const RAW = words('style script title textarea iframe noembed noframes xmp');
// start tags whose rules can move text out of an element (foster parenting,
// form pointers, scoping markers, foreign content), anywhere
const UNSURE = words('table select template svg math frameset form applet marquee object noscript isindex menuitem');
// the formatting elements, safe to nest while each closes in order
const FORMATTING = words('a b big code em font i nobr s small strike strong tt u');
// every other start tag the spec names; only "any other start tag" and
// the formatting ones are safe inside an open element
const NAMED = words(`address article aside blockquote center details dialog dir div dl fieldset figcaption
  figure footer header hgroup main menu nav ol p search section summary ul h1 h2 h3 h4 h5 h6 pre listing li dd dt
  plaintext button hr option optgroup rb rtc rp rt`);
const HEADING = words('h1 h2 h3 h4 h5 h6');

const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isSpace = (c) => c === '\t' || c === '\n' || c === '\f' || c === ' ';

const escapeText = (s) => s.replace(/[&\u00a0<>]/g, (c) => ({ '&': '&amp;', '\u00a0': '&nbsp;', '<': '&lt;', '>': '&gt;' })[c]);

/** HtmlSanitizer.Sanitize(text) with no tags allowed, as YAPP calls it. */
export function sanitizeText(input) {
  const s = String(input).replace(/\r\n?/g, '\n');
  if (!/[<&\u00a0>]/.test(s)) return s.replace(/\0/g, '');
  const stack = [];
  let out = '';
  let text = '';
  const flush = () => {
    if (text && !stack.length) out += decodeEntities(text).replace(/\0/g, '');
    text = '';
  };
  let i = 0;
  const n = s.length;

  // a tag from s[i] ('<' or '</' already passed to `at`); returns
  // {name, end} or null when the input ends inside it (the tag is dropped)
  const readTag = (at) => {
    let j = at;
    let name = '';
    while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') name += s[j++];
    name = name.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/\0/g, '�');
    // attributes: names, = and values, quoted or not; only where the tag ends matters
    while (j < n) {
      const c = s[j];
      if (c === '>') return { name, end: j + 1 };
      if (isSpace(c) || c === '/') { j++; continue; }
      // an attribute name
      j++;
      while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++;
      while (j < n && isSpace(s[j])) j++;
      if (s[j] !== '=') continue;
      j++;
      while (j < n && isSpace(s[j])) j++;
      if (s[j] === '"' || s[j] === "'") {
        const close = s.indexOf(s[j], j + 1);
        if (close < 0) return null;
        j = close + 1;
      } else {
        while (j < n && !isSpace(s[j]) && s[j] !== '>') j++;
      }
    }
    return null;
  };

  const startTag = (name) => {
    if (IGNORED.has(name)) return;
    if (UNSURE.has(name)) throw new YappUnsure('<' + name + '>');
    if (stack.length) {
      // inside an element: hr and xmp may close a <p> around it, and the
      // named ones have rules of their own
      if (name === 'hr' || name === 'xmp' || (NAMED.has(name) && !VOID.has(name)) || HEADING.has(name)) {
        throw new YappUnsure('<' + name + '> inside <' + stack[stack.length - 1] + '>');
      }
      if ((name === 'a' || name === 'nobr') && stack.includes(name)) throw new YappUnsure('<' + name + '> twice');
    }
    if (VOID.has(name) || name === 'hr') return;
    if (name === 'plaintext') { i = n; return; } // the rest of the text is inside it
    stack.push(name);
    if (RAW.has(name)) {
      // raw text up to </name followed by a space, / or >
      const re = new RegExp('</' + name + '(?=[\\t\\n\\f />])', 'gi');
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) { i = n; return; }
      // script data has escaped states of its own once it holds <!--
      if (name === 'script' && s.slice(i, m.index).includes('<!--')) throw new YappUnsure('<script> holding <!--');
      const tag = readTag(m.index + 2);
      if (!tag) { i = n; return; }
      stack.pop();
      i = tag.end;
    }
  };

  const endTag = (name) => {
    if (!stack.length) return; // an end tag with nothing open changes nothing the body keeps
    if (stack[stack.length - 1] === name) { stack.pop(); return; }
    if (stack.includes(name)) throw new YappUnsure('</' + name + '> out of order');
    if (HEADING.has(name) && stack.some((e) => HEADING.has(e))) throw new YappUnsure('</' + name + '>');
    // anything else is ignored, or (</p>, </br>) makes an element of its own
  };

  while (i < n) {
    const c = s[i];
    if (c !== '<') { text += c; i++; continue; }
    const d = s[i + 1];
    if (d !== undefined && isAlpha(d)) {
      flush();
      const tag = readTag(i + 1);
      if (!tag) break;
      i = tag.end;
      startTag(tag.name);
    } else if (d === '/') {
      const e = s[i + 2];
      if (e === undefined) { text += '</'; i += 2; continue; }
      flush();
      if (e === '>') { i += 3; continue; }
      if (isAlpha(e)) {
        const tag = readTag(i + 2);
        if (!tag) break;
        i = tag.end;
        endTag(tag.name);
      } else {
        const close = s.indexOf('>', i + 2); // a bogus comment
        i = close < 0 ? n : close + 1;
      }
    } else if (d === '!') {
      flush();
      if (s.startsWith('--', i + 2)) {
        let j = i + 4;
        if (s[j] === '>') i = j + 1;
        else if (s[j] === '-' && s[j + 1] === '>') i = j + 2;
        else {
          const a = s.indexOf('-->', j);
          const b = s.indexOf('--!>', j);
          const end = a < 0 ? (b < 0 ? -1 : b + 4) : (b < 0 || a < b ? a + 3 : b + 4);
          i = end < 0 ? n : end;
        }
      } else {
        const close = s.indexOf('>', i + 2); // a doctype, CDATA or bogus comment
        i = close < 0 ? n : close + 1;
      }
    } else if (d === '?') {
      flush();
      const close = s.indexOf('>', i + 2);
      i = close < 0 ? n : close + 1;
    } else {
      text += '<';
      i++;
    }
  }
  flush();
  return escapeText(out);
}
