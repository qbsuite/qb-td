// e2e_docx_cats.js — categories from .docx packets (worker.js
// packetCategoriesOf) against a locally running Worker, which sends the
// packet to YAPP as the reader does:
//   cd worker && npx wrangler dev --local --port 8799
// then: node tests/e2e_docx_cats.js
// A .docx round gets its categories when it is uploaded; a tournament
// whose map is missing gets one on the hub's next load (the backfill).
// Synthetic packets only.
import { execSync } from 'node:child_process';
import { makeZip } from '../app/engine/zip.js';
import { BASE, PERSIST, call, ok, summary } from './e2e_lib.js';

const enc = (s) => new TextEncoder().encode(s);
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function docx(lines) {
  const body = lines.map((t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join('');
  return makeZip([
    { name: '[Content_Types].xml', data: enc('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: enc('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) },
  ]);
}
const TAGS = ['<Literature, American>', '<Science, Biology>', '<History, European>'];
function packet(tagged = true) {
  const l = [];
  for (let i = 1; i <= 3; i++) l.push(`${i}. Sim tossup ${i} text about a sim thing. For 10 points, name this sim answer.`, `ANSWER: sim answer ${i}`, ...(tagged ? [TAGS[i - 1]] : []));
  l.push('Bonuses');
  for (let i = 1; i <= 2; i++) l.push(`${i}. Sim bonus ${i} leadin. For 10 points each:`, '[10] Sim part one.', 'ANSWER: sim a', '[10] Sim part two.', 'ANSWER: sim b', '[10] Sim part three.', 'ANSWER: sim c', ...(tagged ? [TAGS[2 - i]] : []));
  return docx(l);
}
const rnd = () => Math.random().toString(36).slice(2, 8);
async function make() {
  const slug = 'docx-' + rnd();
  const r = await call('/api/tournaments', { method: 'POST', json: { name: 'Docx Cats ' + slug, slug } });
  const A = '/a/' + r.body.admin_secret;
  await call(A, { method: 'POST', json: { published: true } });
  return { slug, id: r.body.id, A };
}
const put = (T, round, bytes, name = `Round ${round}.docx`) => fetch(`${BASE}${T.A}/packet?round=${round}&name=${encodeURIComponent(name)}`,
  { method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: bytes }).then((r) => r.status);
const cats = (T) => fetch(`${BASE}/pub/${T.slug}/cats`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/* ----- an uploaded .docx round ----- */
const T = await make();
ok('a .docx packet uploads', (await put(T, 1, packet())) === 200);
let c = await cats(T);
ok('its categories are in the map at once', c.status === 200 && !!c.body.rounds['1'], c);
const r1 = c.body && c.body.rounds['1'];
ok('each tossup in the place the reader reads it',
  !!r1 && JSON.stringify(r1.t.map((x) => x && x.c)) === JSON.stringify(['Literature', 'Science', 'History']), r1 && r1.t);
ok('and each bonus', !!r1 && JSON.stringify(r1.b.map((x) => x && x.c)) === JSON.stringify(['Science', 'Literature']), r1 && r1.b);
ok('with subcategories where the tag names one', !!r1 && r1.t[1].s === 'Biology', r1 && r1.t[1]);
ok('a second .docx round joins the map', (await put(T, 2, packet())) === 200 && !!(await cats(T)).body.rounds['2']);
ok('a .docx with no tags adds nothing', (await put(T, 3, packet(false))) === 200 && !(await cats(T)).body.rounds['3']);

/* ----- the parse is kept: the reader gets it, the download the file ----- */
const room = (await call(T.A + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } })).body.secret;
await call(T.A + '/start', { method: 'POST' });
const asJson = await fetch(`${BASE}/b/${room}/packet?round=1&warm=1&parsed=1`);
const parsed = await asJson.json().catch(() => null);
ok('the reader gets YAPP\'s parse as JSON', asJson.status === 200 && /^application\/json/.test(asJson.headers.get('content-type'))
  && parsed && parsed.tossups.length === 3 && parsed.bonuses.length === 2, { status: asJson.status, type: asJson.headers.get('content-type') });
ok('with the packet\'s own text', parsed && /Sim tossup 2 text/.test(parsed.tossups[1].question), parsed && parsed.tossups[1]);
const file = await fetch(`${BASE}/b/${room}/packet?round=1&warm=1`);
const bytes = new Uint8Array(await file.arrayBuffer());
ok('the download is the .docx as uploaded', file.status === 200 && bytes.length === packet().length && bytes[0] === 0x50 && bytes[1] === 0x4b, bytes.length);
// a YAPP_COUNT url (a counting proxy in front of YAPP) shows the calls
if (process.env.QBTD_YAPP_COUNT) {
  const count = async () => (await (await fetch(process.env.QBTD_YAPP_COUNT)).json()).count;
  const before = await count();
  for (let i = 0; i < 3; i++) await fetch(`${BASE}/b/${room}/packet?round=2&warm=1&parsed=1`).then((r) => r.arrayBuffer());
  ok('three more reader loads send YAPP nothing', (await count()) === before, { before, after: await count() });
}

/* ----- the backfill: a tournament whose map went missing ----- */
execSync(`npx wrangler r2 object delete qb-td-data/t/${T.id}/catmap.json --local${PERSIST}`, { cwd: new URL('../worker', import.meta.url).pathname, stdio: 'ignore' });
ok('with its map gone the tab has nothing', (await cats(T)).status === 404);
await call(T.A);
let back = null;
for (let i = 0; i < 60 && !back; i++) {
  const x = await cats(T);
  if (x.status === 200 && x.body.rounds['1'] && x.body.rounds['2']) back = x;
  else await new Promise((r) => setTimeout(r, 500));
}
ok('the hub\'s next load rebuilds it from the .docx rounds', !!back, back);

summary('docx categories e2e');
