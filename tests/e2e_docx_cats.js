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
import { BASE, call, ok, summary } from './e2e_lib.js';

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

/* ----- the backfill: a tournament whose map went missing ----- */
execSync(`npx wrangler r2 object delete qb-td-data/t/${T.id}/catmap.json --local`, { cwd: new URL('../worker', import.meta.url).pathname, stdio: 'ignore' });
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
