// ui_golden.js — E4: the pages that run on data held in the browser (the
// demo, and the archived tournaments), pinned in headless Chrome. No
// Worker: the pages get ?server= a local stand-in that answers 404 and
// &live=off, so nothing can reach a real backend, and any request to a
// host other than the two local servers fails the run.
//   index.html?a=demo  the Live Hub (grid, Live now, a cell's files and
//                      their download links, protests), Compute stats with
//                      every stage, Finished rounds only and one stage off,
//                      and each download's bytes: YellowFruit 4 and 3, the
//                      report zip and its six files, the QBJ zip, and the
//                      body the Rebuild posts. Once as the demo ships and
//                      once after a few uploads (a reader game, a
//                      re-export that supersedes it, a protest, a file
//                      that won't parse).
//   t.html?t=demo, archive.html?t=<each archive>
//                      every tab and view: Schedule (Now, All rounds),
//                      Stats (Classic and New, each section), Buzzpoints
//                      (each view), Categories (each view)
// plus, per page, the static files it loads and the longest chain of
// static imports. Everything must equal tests/golden/ui_golden.json,
// except that the modules the restructuring design adds (NEW_MODULES) may
// join a page's static files; they are listed, not held to the golden.
// Needs Chrome (CHROME=…). Ports 9611 and 9612 (QBTD_GOLDEN_PORT moves
// both). Run: node tests/ui_golden.js; QBTD_UPDATE_GOLDEN=1 rewrites.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, staticServer, stubWorker } from './cdp_lib.mjs';
import { checkGolden, sha } from './golden_lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const PORT = Number(process.env.QBTD_GOLDEN_PORT || 9611);
const NEW_MODULES = ['/engine/games.js', '/js/hubgames.js', '/engine/exportfile.js', '/engine/exports.js', '/js/saves.js'];
const newSeen = new Set();
const staticsOf = (log) => {
  const all = [...new Set(log.map((r) => r.path))].sort();
  for (const p of all) if (NEW_MODULES.includes(p)) newSeen.add(p);
  return all.filter((p) => !NEW_MODULES.includes(p));
};
const SLUGS = JSON.parse(readFileSync(path.join(APP, 'archive/index.json'), 'utf8')).tournaments.map((t) => t.slug);

// demo.js served with every pub() call it answers logged, so the hub's
// requests (and the Rebuild's body) can be read back; nothing else changes
const instrument = (p, text) => {
  if (p !== '/js/demo.js') return null;
  if (!text.includes('export async function demoPub(')) throw new Error('demo.js no longer exports demoPub as expected');
  return text.replace('export async function demoPub(', 'async function demoPubInner(') + `
export async function demoPub(path, opts = {}) {
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : typeof opts.body === 'string' ? opts.body : null;
  (globalThis.__demoCalls ||= []).push({ method: (opts.method || 'GET').toUpperCase(), path, body });
  return demoPubInner(path, opts);
}
`;
};

const st = await staticServer(APP, PORT, instrument);
const stub = await stubWorker(PORT + 1);
const c = await openChrome();
const BACKEND = `&server=${encodeURIComponent(stub.url)}&live=off`;

// downloads, caught as the page makes them (api.js download clicks a blob link)
await c.S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__dl = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:')) {
      const name = this.download;
      window.__dl.push(fetch(this.href).then((r) => r.arrayBuffer()).then(async (b) => ({ name, bytes: b.byteLength,
        sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('') })));
      return;
    }
    return click.call(this);
  };` });

/* ---------- normalizing what a clock decides ---------- */

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
function norm(html) {
  return String(html)
    .replace(new RegExp(MONTH + ' \\d{1,2}, \\d{1,2}:\\d{2}\\s?(?:AM|PM)', 'g'), '<when>')
    .replace(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/g, '<time>')
    .replace(/\b\d+ (?:seconds?|minutes?|hours?|days?|min|h|s) ago\b/g, '<ago>')
    .replace(/blob:[^"' )]+/g, 'blob:<url>')
    .replace(new RegExp(stub.url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'), '<stub>')
    .replace(/%3A%2F%2F127\.0\.0\.1%3A\d+/g, '<stub-enc>');
}
const hashed = (html) => ({ sha256: sha(norm(html)).slice(0, 24), chars: norm(html).length });

async function settle(expr = `document.getElementById('out') ? document.getElementById('out').innerHTML : document.getElementById('view').innerHTML`) {
  let last = null;
  let same = 0;
  for (let i = 0; i < 200 && same < 3; i++) {
    await new Promise((r) => setTimeout(r, 60));
    const now = await c.js(expr + ` + '|' + ((document.getElementById('msg') || {}).textContent || '')`);
    if (now === last && !/Loading|Computing/.test(now.slice(now.lastIndexOf('|')))) same++; else same = 0;
    last = now;
  }
}

async function load(url) {
  const at = st.log.length;
  const reqAt = c.requests.length;
  await c.goto(url);
  await settle();
  return { statics: () => st.log.slice(at), reqs: () => c.requests.slice(reqAt) };
}

// what left the browser for anywhere but the two local servers
const foreign = (reqs) => reqs.filter((r) => !r.url.startsWith(st.url) && !r.url.startsWith(stub.url)
  && !r.url.startsWith('blob:') && !r.url.startsWith('data:') && !r.url.startsWith('about:'));

/* ---------- the public page ---------- */

async function views(attr) {
  return c.js(`[...document.querySelectorAll('#out [data-${attr}]')].map((e) => e.dataset['${attr}'.replace(/-([a-z])/g, (m, x) => x.toUpperCase())])`);
}
async function pick(attr, v) {
  await c.js(`(() => { const e = document.querySelector('#out [data-${attr}="${v}"]'); if (!e) throw new Error('no ${attr} ${v}'); e.click(); return true; })()`);
  await settle();
}
const outHtml = () => c.js(`document.getElementById('out').innerHTML`);

async function publicPage(url) {
  const page = await load(url);
  const out = { header: norm(await c.js(`document.querySelector('header').innerText`)), tabs: {} };
  const tabs = await c.js(`[...document.querySelectorAll('.tab')].filter((b) => !b.hidden).map((b) => b.dataset.tab)`);
  out.tabsShown = tabs;
  out.firstTab = await c.js(`(document.querySelector('.tab.on') || {}).dataset?.tab || null`);
  for (const tab of tabs) {
    await c.click(`.tab[data-tab="${tab}"]`);
    await settle();
    const t = out.tabs[tab] = { first: hashed(await outHtml()) };
    const groups = { schedule: ['schedview'], stats: ['layout'], buzz: ['buzzmode'], cats: ['catview'] }[tab] || [];
    for (const attr of groups) {
      for (const v of await views(attr)) {
        await pick(attr, v);
        t[attr + '=' + v] = hashed(await outHtml());
        if (attr === 'layout' && v === 'new') {
          for (const s of await views('statssec')) { await pick('statssec', s); t['new/' + s] = hashed(await outHtml()); }
        }
        if (attr === 'buzzmode' && v === 'round') {
          for (const r of await views('buzzround')) { await pick('buzzround', r); t['round/' + r] = hashed(await outHtml()); }
        }
      }
    }
  }
  out.errors = await c.js(`(document.getElementById('msg') || {}).textContent || ''`);
  out.statics = staticsOf(page.statics());
  out.foreign = foreign(page.reqs()).map((r) => r.method + ' ' + r.url);
  return out;
}

/* ---------- the TD hub ---------- */

const downloads = async (ids, n) => {
  await c.js(`window.__dl = []; true`);
  for (const id of ids) await c.click('#' + id);
  await c.waitJs(`window.__dl.length >= ${n}`, 'downloads ' + ids.join(','), 30000);
  // by name: the six report files go one at a time, beside the others
  return (await c.js(`Promise.all(window.__dl)`)).sort((x, y) => x.name.localeCompare(y.name));
};
const hubStats = async () => ({
  note: await c.js(`document.getElementById('statsnote').textContent`),
  range: norm(await c.js(`(document.getElementById('statrange') || {}).innerText || ''`)),
  out: hashed(await c.js(`document.getElementById('statsout').innerHTML`)),
});

async function hub(label) {
  const page = await load(st.url + '/index.html?a=demo' + BACKEND);
  await c.waitJs(`!!document.querySelector('.hubtab')`, 'hub');
  await c.click('[data-view="live"]');
  await settle(`document.getElementById('view').innerHTML`);
  const out = { label };
  out.live = hashed(await c.js(`document.getElementById('view').innerHTML`));
  out.grid = await c.js(`[...document.querySelectorAll('[data-cell]')].map((b) => b.dataset.cell + ' ' + b.className.replace(/\\s+/g, ' ').trim() + ' ' + b.title + ' ' + b.textContent.trim())`);
  out.liveNow = norm(await c.js(`[...document.querySelectorAll('.livenow, .liverow, [class*="live"]')].slice(0, 1).map((e) => e.innerText).join('|')`));
  out.rail = norm(await c.js(`[...document.querySelectorAll('.railblock')].map((e) => e.innerText).join('\\n--\\n')`));
  out.cells = {};
  for (const cell of await c.js(`[...document.querySelectorAll('[data-cell]')].filter((b) => /Game in|!|superseded|re-export|in progress/i.test(b.title)).map((b) => b.dataset.cell)`)) {
    await c.click(`[data-cell="${cell}"]`);
    await settle(`document.getElementById('view').innerHTML`);
    out.cells[cell] = {
      panel: norm(await c.js(`[...document.querySelectorAll('.pfile')].map((e) => e.innerText).join('\\n')`)),
      // recorded only: in the demo these point at the backend, never fetched
      links: (await c.js(`[...document.querySelectorAll('.pfile a[href]')].map((a) => a.getAttribute('href'))`)).map(norm),
    };
    await c.click(`[data-cell="${cell}"]`);
    await settle(`document.getElementById('view').innerHTML`);
  }
  out.protests = norm(await c.js(`(document.getElementById('protdrawer') || {}).innerText || ''`));
  out.protestsHtml = hashed(await c.js(`(document.getElementById('protdrawer') || {}).innerHTML || ''`));

  // Compute with every stage
  await c.js(`window.__demoCalls = []; true`);
  await c.click('#calc');
  await c.waitJs(`!document.getElementById('dlmenu').disabled || /No readable/.test(document.getElementById('statsout').textContent)`, 'stats', 30000);
  await settle(`document.getElementById('statsout').innerHTML`);
  out.computeRequests = await c.js(`window.__demoCalls.map((x) => x.method + ' ' + x.path.replace(/key=t%2F1%2Ffile%2F\\d+/, 'key=<game>'))`);
  out.all = { ...(await hubStats()), downloads: await downloads(['dlyft4', 'dlyft3', 'dlreport', 'dlreportfiles', 'dlzip'], 10) };
  await c.js(`window.__demoCalls = []; true`);
  await c.click('#rebuild');
  await c.waitJs(`window.__demoCalls.some((x) => x.path === '/a/demo/bundle')`, 'rebuild', 20000);
  out.rebuild = await c.js(`window.__demoCalls.filter((x) => x.method === 'POST').map((x) => ({ path: x.path, entries: JSON.parse(x.body).entries.length }))`);
  out.rebuildBody = sha(await c.js(`window.__demoCalls.filter((x) => x.method === 'POST').map((x) => x.body).join('\\n')`)).slice(0, 24);

  // Finished rounds only
  await c.click('input[name="statmode"][value="finished"]');
  await settle(`document.getElementById('statsnote').textContent + document.getElementById('statsout').innerHTML`);
  out.finished = { ...(await hubStats()), downloads: await downloads(['dlyft4', 'dlyft3', 'dlreport', 'dlzip'], 4) };
  // back to stages, with the first one off
  await c.click('input[name="statmode"][value="stages"]');
  await settle(`document.getElementById('statsnote').textContent`);
  if (await c.js(`!!document.querySelector('[data-statph]')`)) {
    await c.click('[data-statph]');
    await settle(`document.getElementById('statsnote').textContent + document.getElementById('statsout').innerHTML`);
    out.oneOff = { ...(await hubStats()), downloads: await downloads(['dlyft4', 'dlyft3', 'dlreport', 'dlzip'], 4) };
    await c.click('[data-statph]');
    await settle(`document.getElementById('statsnote').textContent`);
  }
  out.statics = staticsOf(page.statics());
  out.foreign = foreign(page.reqs()).map((r) => r.method + ' ' + r.url);
  out.backend = page.reqs().filter((r) => r.url.startsWith(stub.url)).map((r) => r.method + ' ' + r.url.slice(stub.url.length));
  return out;
}

// a few uploads through the demo's own room route, as a room would make
// them: Room A's live game from the reader, then re-exported with its
// teams the other way round (superseding it), a protest in its notes, and
// a file that won't parse in Room B
async function seedDemo() {
  // from a page that hasn't loaded the demo: the public page renames rooms
  // in the fixture's own entries as it loads them
  await c.goto(st.url + '/about.html');
  await c.js(`(async () => {
    const m = await import(new URL('js/demo.js', document.baseURI).href);
    const fx = (await import(new URL('demo/fixture.js', document.baseURI).href)).default;
    const sb = fx.entries.find((e) => e.id === 7).qbj; // round 4, Room A: Stanford v Berkeley
    const live = { ...structuredClone(sb), _round: 7,
      notes: 'Tossup protest on tossup #3. Team "Berkeley" protested because of this reason: "close enough".' };
    const reader = { qbj: live, game: { game: { players: [], cycles: [] }, uiState: {} },
      modaq: { qbj: JSON.stringify(live, null, 4), game: '{}' }, progress: { at: 20, of: 20 } };
    await m.demoPub('/b/demo/upload?round=7&name=Round_7_Stanford_Berkeley.qbtd.json', { method: 'POST', body: JSON.stringify(reader) });
    const again = { ...structuredClone(live), match_teams: structuredClone(live.match_teams).reverse() };
    await m.demoPub('/b/demo/upload?round=7&name=Round_7_Berkeley_Stanford.qbj', { method: 'POST', body: JSON.stringify(again, null, 2) });
    await m.demoPub('/b/demo-b/upload?round=7&name=Round_7_broken.qbj', { method: 'POST', body: '{"match_teams": []}' });
    return true;
  })()`);
}

/* ---------- the run ---------- */

const golden = { pages: {} };
const clear = () => c.S('Storage.clearDataForOrigin', { origin: st.url, storageTypes: 'all' });

await c.goto(st.url + '/about.html');
await clear();
golden.pages['hub demo'] = await hub('as shipped');
golden.pages['public demo'] = await publicPage(st.url + '/t.html?t=demo' + BACKEND);
await seedDemo();
golden.pages['hub demo after uploads'] = await hub('after uploads');
golden.pages['public demo after uploads'] = await publicPage(st.url + '/t.html?t=demo' + BACKEND);
await clear();
for (const s of SLUGS) {
  golden.pages['archive ' + s] = await publicPage(st.url + '/archive.html?t=' + s + BACKEND);
  await clear();
}

// the longest chain of static imports from each page's script
function chain(entry) {
  const memo = new Map();
  const depth = (f, seen = new Set()) => {
    if (memo.has(f)) return memo.get(f);
    if (seen.has(f)) return 0;
    seen.add(f);
    const src = readFileSync(path.join(APP, f), 'utf8');
    let d = 1;
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|^import\s+['"](\.[^'"]+)['"]/gms)) {
      const dep = path.normalize(path.join(path.dirname(f), m[1] || m[2]));
      d = Math.max(d, 1 + depth(dep, seen));
    }
    seen.delete(f);
    memo.set(f, d);
    return d;
  };
  return depth(entry);
}
golden.importChain = Object.fromEntries(['js/admin.js', 'js/pubview.js', 'js/archive.js'].map((f) => [f, chain(f)]));
golden.pageErrors = c.errors.map(norm);
golden.stubRequests = stub.log.map((r) => r.method + ' ' + r.path);

const problems = [];
const foreignAll = Object.values(golden.pages).flatMap((p) => p.foreign);
if (foreignAll.length) problems.push('requests left the two local servers: ' + foreignAll.join(', '));
if (c.errors.length) problems.push('page errors: ' + c.errors.join(' | '));
const diffs = checkGolden('ui_golden.json', golden);
if (diffs.length) problems.push('ui_golden.json:\n    ' + diffs.join('\n    '));
if (newSeen.size) console.log('  new modules the design allows, loaded: ' + [...newSeen].join(', '));
for (const [k, p] of Object.entries(golden.pages)) console.log(`  ${k}: ${p.statics.length} static files${p.tabs ? ', tabs ' + Object.keys(p.tabs).join(' ') : ''}`);
c.close();
st.server.close();
stub.server.close();
if (problems.length) { console.error('FAIL ' + problems.join('\nFAIL ')); process.exit(1); }
console.log('ui golden: the demo and archive pages match');
process.exit(0);
