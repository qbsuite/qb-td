// bench_pages.js — how long the pages that load game data take to show it,
// on a throttled connection, and how many script files they fetch: this
// checkout against another, interleaved in one headless Chrome. The pages
// run on data held in the browser (an archived tournament, the demo), so
// no Worker is involved; ?server= is a local stand-in that answers 404.
//
//   QBTD_BASELINE=<dir> node tests/bench_pages.js   # A/B against a checkout of the baseline
//   node tests/bench_pages.js                       # this checkout alone
//
// Pages: archive.html?t=<first archive>, t.html?t=demo and
// index.html?a=demo. Each is loaded RUNS (10) times cold (cache off) and
// RUNS times warm (cache on, files served with max-age=600 as GitHub Pages
// does), on Fast 4G (165 ms latency, 8.1 Mbps down, 1.35 Mbps up; DevTools'
// preset), the two checkouts taking turns. The time is from navigation
// start to the first render with data: the public page's first tab, the
// hub's round line. Pass: each median within max(3%, 20 ms) of the
// baseline's. The script files each page fetches, and how many, are
// printed for both, for the module list the design allows.
// Ports 9611 (this checkout), 9612 (stand-in Worker) and 9619 (baseline);
// QBTD_BENCH_PORTS="a,b,c" moves them.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openChrome, staticServer, stubWorker } from './cdp_lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.env.RUNS || 10);
const BASELINE = process.env.QBTD_BASELINE || null;
const [P1, P2, P3] = (process.env.QBTD_BENCH_PORTS || '9611,9612,9619').split(',').map(Number);
const slug = JSON.parse(readFileSync(path.join(ROOT, 'app/archive/index.json'), 'utf8')).tournaments[0].slug;

// served as GitHub Pages serves them: cacheable for ten minutes
async function server(root, port) {
  const st = await staticServer(root, port);
  const handlers = st.server.listeners('request');
  st.server.removeAllListeners('request');
  st.server.on('request', (req, res) => {
    const head = res.writeHead.bind(res);
    res.writeHead = (code, h = {}) => head(code, { ...h, 'Cache-Control': 'public, max-age=600' });
    for (const fn of handlers) fn(req, res);
  });
  return st;
}
const sides = [{ name: 'this', st: await server(path.join(ROOT, 'app'), P1) }];
if (BASELINE) sides.push({ name: 'baseline', st: await server(path.join(path.resolve(BASELINE), 'app'), P3) });
const stub = await stubWorker(P2);
const c = await openChrome();
const BACKEND = `&server=${encodeURIComponent(stub.url)}&live=off`;

// the moment the page first shows its data
await c.S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__shown = null;
  new MutationObserver((_, obs) => {
    const out = document.getElementById('out');
    const msg = document.getElementById('msg');
    const ready = document.querySelector('.biground')
      || (out && out.children.length && !(msg && /Loading/.test(msg.textContent)));
    if (ready && window.__shown === null) { window.__shown = performance.now(); obs.disconnect(); }
  }).observe(document, { childList: true, subtree: true, characterData: true });` });
await c.S('Network.emulateNetworkConditions', { offline: false, latency: 165,
  downloadThroughput: (9 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (1.5 * 1024 * 1024 / 8) * 0.9 });

const PAGES = [
  ['archive', `/archive.html?t=${slug}${BACKEND}`],
  ['public demo', `/t.html?t=demo${BACKEND}`],
  ['hub demo', `/index.html?a=demo${BACKEND}`],
];

async function once(side, url, cold) {
  await c.S('Network.setCacheDisabled', { cacheDisabled: cold });
  const at = c.requests.length;
  await c.goto(side.st.url + url);
  const t = await c.waitJs(`window.__shown`, 'first render of ' + url, 30000);
  const scripts = c.requests.slice(at).filter((r) => r.type === 'Script' && r.url.startsWith(side.st.url))
    .map((r) => new URL(r.url).pathname);
  return { t, scripts };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const rows = [];
let failed = 0;
for (const [label, url] of PAGES) {
  for (const cold of [true, false]) {
    const times = sides.map(() => []);
    const scripts = sides.map(() => null);
    if (!cold) for (const s of sides) await once(s, url, false); // fill the cache
    for (let i = 0; i < RUNS; i++) {
      const order = i % 2 ? [...sides.keys()].reverse() : [...sides.keys()];
      for (const k of order) {
        await c.S('Storage.clearDataForOrigin', { origin: sides[k].st.url, storageTypes: 'local_storage,session_storage' });
        const r = await once(sides[k], url, cold);
        times[k].push(r.t);
        if (cold) scripts[k] = r.scripts;
      }
    }
    const row = { page: label, cache: cold ? 'cold' : 'warm', 'ms (this)': Math.round(median(times[0])) };
    if (cold) row['scripts (this)'] = scripts[0].length;
    if (BASELINE) {
      const a = median(times[0]);
      const b = median(times[1]);
      row['ms (baseline)'] = Math.round(b);
      if (cold) {
        row['scripts (baseline)'] = scripts[1].length;
        const added = scripts[0].filter((x) => !scripts[1].includes(x));
        const gone = scripts[1].filter((x) => !scripts[0].includes(x));
        if (added.length || gone.length) row.modules = (added.length ? '+' + added.join(' +') : '') + (gone.length ? ' -' + gone.join(' -') : '');
      }
      row.ok = a <= b + Math.max(0.03 * b, 20);
      if (!row.ok) failed++;
    }
    rows.push(row);
  }
}
console.table(rows);
console.log(JSON.stringify({ runs: RUNS, baseline: BASELINE, rows }));
c.close();
for (const s of sides) s.st.server.close();
stub.server.close();
if (failed) { console.error(failed + ' page load(s) slower than the baseline by more than max(3%, 20 ms)'); process.exit(1); }
process.exit(0);
