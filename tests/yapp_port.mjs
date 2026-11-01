// yapp_port.mjs — app/engine/yapp.js, the port of YAPP 1.3.1.
//
// Three parts: YAPP's own unit tests (LexerClassifierTests,
// LineParserTests, FormattedTextTests, JsonCompilerTests), case for case;
// the sanitizer (yapp_html.js) on what packet text can hold; and small
// .docx files built here, whose expected JSON spells out YAPP's quirks
// (numbered lists, skipped hyperlink runs, dropped tabs, <w:b w:val="0"/>,
// tables, tiebreakers, the metadata off-by-one, .NET's JSON escapes).
// tools/yapp_diff.mjs checks the port against YAPP's own command line on
// real packets.
// Run: node tests/yapp_port.mjs (part of npm test).

import assert from 'node:assert/strict';
import { convertPacket, _internal } from '../app/engine/yapp.js';
import { sanitizeText, YappUnsure } from '../app/engine/yapp_html.js';
import { makeZip } from '../app/engine/zip.js';

const { parsePacket, packetJson, serialize, withTags, classifyQuestionDigit, classifyBonusPart, ANSWER_RE, METADATA_RE, ParseFail } = _internal;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push(name + ': ' + e.message); }
}

/* ---------- LexerClassifierTests ---------- */

const answerMatch = (s) => ANSWER_RE.exec(s)?.[0];
for (const tag of ['Answer:', 'ANSWER:', 'Ans:', '  Answer:  ', 'Answer.']) {
  await test('answer ' + JSON.stringify(tag), () => assert.equal(answerMatch(tag + ' My answer'), tag + ' '));
}
await test('answer, no space after', () => assert.equal(answerMatch('Answer:My answer'), 'Answer:'));
for (const tag of ['1.', '[10]', 'An ox', 'Answer something']) {
  await test('not an answer ' + JSON.stringify(tag), () => assert.equal(answerMatch(tag + ' My answer'), undefined));
}

for (const [tag, value, mod] of [['[10]', 10, null], ['[234]', 234, null], [' [ 15 ] ', 15, null], ['[10e]', 10, 'e'],
  ['[10m]', 10, 'm'], ['[15h]', 15, 'h'], ['[10E]', 10, 'e'], ['[ 20 e ]', 20, 'e'], ['[e]', 10, 'e'], ['[m]', 10, 'm'],
  ['[h]', 10, 'h']]) {
  await test('bonus part ' + JSON.stringify(tag), () => {
    assert.deepEqual(classifyBonusPart(tag + ' My bonus part'), { match: tag + ' ', value, mod });
  });
}
await test('bonus part, no space after', () => {
  assert.deepEqual(classifyBonusPart('[10]My bonus part'), { match: '[10]', value: 10, mod: null });
});
for (const tag of ['[]', '[u]', '[10o]', '10]', '[10 ', '[1.2]', 'Answer:', '17.', '[9876543210h]']) {
  await test('not a bonus part ' + JSON.stringify(tag), () => assert.equal(classifyBonusPart(tag + ' My bonus part'), null));
}

await test('metadata', () => {
  assert.ok(METADATA_RE.test('<Johnson, American Lit>'));
  assert.ok(METADATA_RE.test('<Johnson, American Lit 1900+, 100%>'));
  assert.ok(METADATA_RE.test('<Garcia-Garcia: American Lit ~2000>'));
  assert.ok(!METADATA_RE.test('(Johnson, American Lit)'));
  assert.ok(!METADATA_RE.test('[Johnson, American Lit]'));
});

for (const [tag, number] of [['1. ', 1], ['23. ', 23], [' 2 .', 2], ['TB.', null], ['tB.', null], ['Tiebreaker.', null],
  ['Tie.', null], ['01.', 1]]) {
  await test('question digit ' + JSON.stringify(tag), () => {
    assert.deepEqual(classifyQuestionDigit(tag + ' The question'), { match: tag + ' ', number });
  });
}
await test('question digit, 1.2.', () => assert.deepEqual(classifyQuestionDigit('1.2. The question'), { match: '1.', number: 1 }));
await test('question digit, too large', () => {
  assert.deepEqual(classifyQuestionDigit('9876543210. The question'), { match: '9876543210. ', number: null });
});
for (const tag of ['Tie ', 'Answer:', '[10]', '-1.']) {
  await test('not a question digit ' + JSON.stringify(tag), () => assert.equal(classifyQuestionDigit(tag + ' The question'), null));
}

/* ---------- LineParserTests ---------- */

const plainSeg = (text) => ({ text, i: false, b: false, u: false, sub: false, sup: false });
const Q = (number, text) => ({ type: 'NumberedQuestion', text: [plainSeg(text)], number });
const A = (text) => ({ type: 'Answer', text: [plainSeg(text)] });
const P = (text, value, mod = null) => ({ type: 'BonusPart', text: [plainSeg(text)], value, mod });
const M = (metadata) => ({ type: 'PostQuestionMetadata', text: [plainSeg(`<${metadata}>`)] });
const L = (text) => ({ type: 'Unclassified', text: [plainSeg(text)] });
const parse = (lines) => {
  try { return { value: parsePacket(lines) }; }
  catch (e) { if (e instanceof ParseFail) return { errors: e.errors }; throw e; }
};
const textOf = (segs) => segs.map((s) => s.text).join('');

await test('empty packet fails', () => assert.ok(parse([]).errors));
await test('failure messages are capped', () => {
  const lines = [];
  for (let i = 1; i <= 30; i++) lines.push(Q(i, `Question without answer #${i}`));
  const { errors } = parse(lines);
  assert.equal(errors.filter((m) => m.startsWith('Unexpected line found. Was expecting a line of type "Answer"')).length, 10);
  assert.equal(errors.filter((m) => m.startsWith('Unexpected line found. Was expecting a line of type "BonusPart"')).length, 10);
});
await test('one tossup', () => {
  const { value } = parse([Q(1, 'This is my tossup'), A('An answer')]);
  assert.equal(value.tossups.length, 1);
  assert.equal(value.bonuses, null);
  const t = value.tossups[0];
  assert.deepEqual([t.number, textOf(t.question), textOf(t.answer), t.metadata], [1, 'This is my tossup', 'An answer', null]);
});
await test('one tossup with metadata', () => {
  const { value } = parse([Q(1, 'This is my tossup'), A('An answer'), M('Some metadata')]);
  assert.equal(value.tossups[0].metadata, 'Some metadata');
});
await test('one tossup and bonus', () => {
  const { value } = parse([Q(2, 'This is my tossup'), A('An answer'), Q(2, 'This is my leadin'),
    P('Part #1', 10), A('Answer #1'), P('Part #2', 10), A('Answer #2')]);
  assert.equal(value.tossups.length, 1);
  assert.equal(value.bonuses.length, 1);
  const b = value.bonuses[0];
  assert.equal(b.number, 2);
  assert.deepEqual(b.parts.map((p) => [textOf(p.question), textOf(p.answer), p.value]),
    [['Part #1', 'Answer #1', 10], ['Part #2', 'Answer #2', 10]]);
});
await test('two tossups', () => {
  const { value } = parse([Q(1, 'This is my tossup'), A('An answer'), L(''), Q(2, 'Another tossup'), A('Answer #2')]);
  assert.deepEqual(value.tossups.map((t) => [t.number, textOf(t.question), textOf(t.answer), t.metadata]),
    [[1, 'This is my tossup', 'An answer', null], [2, 'Another tossup', 'Answer #2', null]]);
});
await test('two tossups with metadata', () => {
  const { value } = parse([Q(1, 'This is my tossup'), A('An answer'), M('<Alice, Science>'), L(''),
    Q(2, 'Another tossup'), A('Answer #2'), L(''), M('<Bob, Literature>')]);
  assert.deepEqual(value.tossups.map((t) => t.metadata), ['<Alice, Science>', '<Bob, Literature>']);
});
await test('a tossup split over two lines', () => {
  const { value } = parse([Q(1, 'This is my tossup'), L(' that was split'), A('An answer'), L(''), M('<John, American History>')]);
  assert.equal(textOf(value.tossups[0].question), 'This is my tossup that was split');
  assert.equal(value.tossups[0].metadata, '<John, American History>');
});
await test('a bonus part split over two lines', () => {
  const { value } = parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), P('Bonus part that is', 10), L(' split'),
    A('An answer'), P('Second part question', 10), A('Second answer')]);
  assert.equal(value.bonuses[0].parts.length, 2);
  assert.equal(textOf(value.bonuses[0].parts[0].question), 'Bonus part that is split');
});
await test('a bonus part with no answer fails', () => {
  assert.equal(parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), P('Bonus part that is', 10), A('Answer again'),
    P('Second part question with no answer', 10)]).errors.length, 1);
});
await test('a bonus part then another part fails', () => {
  const { errors } = parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), P('Bonus part that is', 10),
    P('Skipped the last answer', 10), A('The answer')]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('Unexpected line found. Was expecting a line of type "Answer", but found a line of type "BonusPart"'));
});
await test('a leadin then an answer fails', () => {
  const { errors } = parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), A('The answer'), P('Bonus part', 10),
    A('The next answer')]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('Unexpected line found. Was expecting a line of type "BonusPart", but found a line of type "Answer"'));
});
await test('a bonus with no parts fails', () => {
  assert.equal(parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), Q(2, 'Another leadin and question'),
    P('Bonus part that is', 10), A('Answer again')]).errors.length, 1);
});
await test('a bonus with metadata', () => {
  const { value } = parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), P('Bonus part that is', 10), A('The answer'),
    M('My metadata')]);
  assert.equal(value.bonuses[0].parts.length, 1);
  assert.equal(value.bonuses[0].metadata, 'My metadata');
});
await test('a part with a difficulty', () => {
  const { value } = parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), P('Bonus part that is', 10, 'h'), A('The answer')]);
  assert.equal(value.bonuses[0].parts[0].mod, 'h');
});
await test('leading lines are ignored', () => {
  assert.equal(parse([L('Irrelevant intro'), L('More intro'), Q(1, 'Question text'), A('Answer text')]).value.tossups.length, 1);
});
await test('a tossup with no answer fails', () => {
  assert.equal(parse([Q(1, 'Tossup'), Q(2, 'Second tossup!'), A('Answer')]).errors.length, 1);
});
await test('the error snippet is 40 characters', () => {
  const [message] = parse([Q(1, 'First question'), Q(2, 'X'.repeat(200)), A('A2')]).errors;
  assert.ok(message.includes('X'.repeat(40)) && !message.includes('X'.repeat(41)));
});
await test('two tossup failures', () => {
  const { errors } = parse([Q(1, 'Tossup'), Q(2, 'Second tossup!'), A('Answer'), Q(3, 'Third tossup'), Q(4, 'Fourth tossup'),
    A('Fourth Answer')]);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Second') && errors[1].includes('Fourth'));
});
await test('two bonus failures', () => {
  const { errors } = parse([Q(1, 'Tossup'), A('Answer'), Q(1, 'Bonus leadin'), Q(2, 'Another leadin and question'),
    P('Bonus part that is', 10), A('Answer again'), Q(3, 'Third bonus leadin'), Q(4, 'Fourth leadin and question'),
    P('Some part', 10), A('Answer again')]);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Another leadin') && errors[1].includes('Fourth leadin'));
});
await test('tossup and bonus failures', () => {
  const { errors } = parse([Q(1, 'Tossup'), Q(2, 'Second Tossup'), A('Answer'), Q(1, 'Bonus leadin'),
    Q(2, 'Another leadin and question'), P('Bonus part', 10), A('Answer again')]);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Second') && errors[1].includes('Another leadin'));
});

/* ---------- FormattedTextTests ---------- */

await test('formatting tags', () => {
  const f = (text, o = {}) => ({ text, i: !!o.i, b: !!o.b, u: !!o.u, sub: !!o.sub, sup: !!o.sup });
  assert.equal(withTags([f('First'), f('Second', { i: 1 }), f('Third', { i: 1, b: 1 }), f('Fourth', { i: 1, b: 1, u: 1 }),
    f('Fifth', { i: 1, b: 1, u: 1, sub: 1 }), f('Sixth', { i: 1, b: 1, u: 1, sup: 1 }), f('Seventh', { i: 1, b: 1, u: 1 }),
    f('Eighth', { i: 1, b: 1 }), f('Ninth', { i: 1 }), f('Tenth')]),
  'First<em>Second<b>Third<u>Fourth<sub>Fifth</sub><sup>Sixth</sup>Seventh</u>Eighth</b>Ninth</em>Tenth');
});

/* ---------- JsonCompilerTests ---------- */

const onePacket = {
  tossups: [{ number: 1, question: [plainSeg('My question')], answer: [plainSeg('My answer')], metadata: '<Alice - History>' }],
  bonuses: [{ number: 1, leadin: [plainSeg('The leadin')], metadata: 'BonusMetadata',
    parts: [{ question: [plainSeg('BonusQuestion')], answer: [plainSeg('BonusAnswer')], value: 10, mod: 'e' }] }],
};
await test('compile, every field', () => {
  assert.equal(serialize(packetJson(onePacket, false), false),
    '{"tossups":[{"number":1,"question":"My question","answer":"My answer","metadata":"\\u0026lt;Alice - History\\u0026gt;",'
    + '"question_sanitized":"My question","answer_sanitized":"My answer"}],"bonuses":[{"leadin":"The leadin",'
    + '"leadin_sanitized":"The leadin","parts":["BonusQuestion"],"parts_sanitized":["BonusQuestion"],"answers":["BonusAnswer"],'
    + '"answers_sanitized":["BonusAnswer"],"values":[10],"difficultyModifiers":["e"],"metadata":"BonusMetadata"}]}');
});
await test('compile, MODAQ format', () => {
  assert.equal(serialize(packetJson(onePacket, true), false),
    '{"tossups":[{"question":"My question","answer":"My answer","metadata":"\\u0026lt;Alice - History\\u0026gt;"}],'
    + '"bonuses":[{"leadin":"The leadin","parts":["BonusQuestion"],"answers":["BonusAnswer"],"values":[10],'
    + '"difficultyModifiers":["e"],"metadata":"BonusMetadata"}]}');
});
await test('compile, pretty', () => {
  const packet = { tossups: [{ number: 1, question: [plainSeg('Q')], answer: [plainSeg('A')], metadata: null }], bonuses: null };
  assert.equal(serialize(packetJson(packet, true), true),
    '{\n  "tossups": [\n    {\n      "question": "Q",\n      "answer": "A"\n    }\n  ]\n}');
  assert.ok(!serialize(packetJson(packet, true), false).includes('\n'));
});
await test('.NET JSON escapes', () => {
  assert.equal(serialize({ s: 'é "q" \'a\' + `b` \\ \n\t\u2014 😀 \u007f' }, false),
    '{"s":"\\u00E9 \\u0022q\\u0022 \\u0027a\\u0027 \\u002B \\u0060b\\u0060 \\\\ \\n\\t\\u2014 \\uD83D\\uDE00 \\u007F"}');
});

/* ---------- the sanitizer ---------- */

for (const [input, output] of [
  ['plain text', 'plain text'],
  ['a < b > c', 'a &lt; b &gt; c'],
  ['AT&T', 'AT&amp;T'],
  ['&amp; &eacute; &#233; &#x2014; &#150;', '&amp; é é \u2014 \u2013'],
  ['&notit; &copy 2026', '\u00acit; \u00a9 2026'],
  ['no\u00a0break', 'no&nbsp;break'],
  ['x <i>y</i> z', 'x  z'],
  ['x <b>bold</b>y', 'x y'],
  ['x <foo bar="1>2">gone', 'x '],
  ['unclosed <foo', 'unclosed '],
  ['a <!-- c --> b', 'a  b'],
  ['a</b>c', 'ac'],
  ['a</>c', 'ac'],
  ['x <3', 'x &lt;3'],
  ['<ND, Lit> answer', ''],
  ['<b>x<i>y</i>z</b>w', 'w'],
  ['<style>a</b>c</style>d', 'd'],
  ['<p>x</p>y', 'y'],
  ['a\r\nb', 'a\nb'],
]) {
  await test('sanitize ' + JSON.stringify(input), () => assert.equal(sanitizeText(input), output));
}
for (const input of ['<table>x', '<p>a<div>b', '<b>x<i>y</b>z', '<form>x</form>', '<svg>x</svg>', '<h1>x</h2>y']) {
  await test('sanitize, unsure ' + JSON.stringify(input), () => assert.throws(() => sanitizeText(input), YappUnsure));
}

/* ---------- whole .docx files ---------- */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const p = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const numbered = (numId, ...runs) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runs.join('')}</w:p>`;
const docx = (body) => makeZip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>' },
  { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>' },
  { name: 'word/document.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<w:body>${body}<w:sectPr/></w:body></w:document>` },
]);

await test('docx: a tossup and a bonus', async () => {
  const file = docx([
    p(r('1. This is a '), r('test', '<w:b/><w:u w:val="single"/>'), r(' & more.')),
    p(r('ANSWER: '), r('answer', '<w:b/><w:u w:val="single"/>')),
    p(r('<Lit, American>')),
    p(r('1. Leadin text.')),
    p(r('[10e] Part one.')), p(r('ANSWER: one')),
    p(r('[10m] Part two.')), p(r('ANSWER: two')),
  ].join(''));
  // the tags still open at the end close in YAPP's fixed order: </b></u>
  assert.deepEqual(await convertPacket(file), { text: '{"tossups":[{"question":"This is a \\u003Cb\\u003E\\u003Cu\\u003Etest'
    + '\\u003C/u\\u003E\\u003C/b\\u003E \\u0026amp; more.","answer":"\\u003Cb\\u003E\\u003Cu\\u003Eanswer\\u003C/b\\u003E'
    + '\\u003C/u\\u003E","metadata":"Lit, American"}],"bonuses":[{"leadin":"Leadin text.","parts":["Part one.","Part two."],'
    + '"answers":["one","two"],"values":[10,10],"difficultyModifiers":["e","m"]}]}' });
  const full = await convertPacket(file, { modaq: false, pretty: true });
  assert.ok(full.text.startsWith('{\n  "tossups": [\n    {\n      "number": 1,\n      "question": "This is a'));
  assert.ok(full.text.includes('"question_sanitized": "This is a test \\u0026amp; more."'));
});

await test('docx: YAPP\'s quirks', async () => {
  const file = docx([
    numbered(3, r('First tossup with a'), '<w:hyperlink r:id="rId9"><w:r><w:t>LINK</w:t></w:r></w:hyperlink>', r(' tab'),
      '<w:r><w:tab/><w:t>here</w:t></w:r>', '<w:r><w:br/><w:t>ANSWER: one</w:t></w:r>'),
    p(r('<Sci, Bio>')),
    numbered(3, r('Second', '<w:b w:val="0"/>'), r(' tossup')),
    p(r('ANSWER: two')),
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>3. Hidden</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    p(r('TB. Tiebreaker question')),
    p(r('ANSWER: three')),
    p(r(' <Lit>')),
  ].join(''));
  assert.deepEqual(await convertPacket(file), { text: '{"tossups":[{"question":"First tossup with a tabhere","answer":"one",'
    + '"metadata":"Sci, Bio"},{"question":"\\u003Cb\\u003ESecond\\u003C/b\\u003E tossup","answer":"two"},'
    + '{"question":"Tiebreaker question","answer":"three","metadata":"Lit\\u0026gt;"}]}' });
});

await test('docx: metadata after two spaces is a .NET error', async () => {
  const file = docx([p(r('1. Q')), p(r('ANSWER: A')), p(r('  <Lit>'))].join(''));
  assert.deepEqual(await convertPacket(file),
    { errors: ["Unknown error: Index and length must refer to a location within the string. (Parameter 'length')"] });
});

await test('docx: parse errors, lines counted from 2', async () => {
  assert.deepEqual(await convertPacket(docx(p(r('1. Question without answer')))), { errors: ['Parse Error.',
    'Failed to parse tossup #1. No more lines found. Number of lines searched for after the last part: 1 (Line #2)',
    'Failed to parse tossups. No tossups found. (Line #2)'] });
});

await test('docx: unsure cases go to YAPP', async () => {
  assert.equal((await convertPacket(new TextEncoder().encode('<html><body>1. Q</body></html>'))).unsure, true);
  assert.equal((await convertPacket(docx(p(r('1. Q <table>x')) + p(r('ANSWER: A'))))).unsure, true);
  assert.equal((await convertPacket(docx('<!DOCTYPE x>' + p(r('1. Q'))))).unsure, true);
});

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`yapp_port: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`yapp_port: ${passed} passed`);
