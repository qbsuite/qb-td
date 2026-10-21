// ui_full_livehub.js — the Live Hub (index.html?a=…, the Live view and
// its header) driven in a real headless Chrome against a local Worker and
// a local copy of the pages, the way a TD uses it on the day. Every check
// asserts what the TD sees (the page's text, what is enabled, the dialogs
// it asks, the files it downloads, opened and parsed) or what reached the
// Worker, never the page's internals.
//
// It covers the Live Hub features the other browser suites cover only in
// part or not at all (ui_e2e.js, e2e_autofill.js, e2e_saves.js and the
// ui_golden.js snapshots): the header and its links, the Setup and Live
// banners, Live now, the uploads grid and its cell panel, moving, deleting
// and downloading uploads, Add a game, Record a forfeit, Edit in MODAQ
// (through a real reader round trip), Fix stats, protests and rulings,
// advancing rounds, auto-advance, the playoff fill and the Finals fill
// (with their notes and waiting ties), the stats pick, Compute stats,
// every download (names with markup in the HTML report among them),
// Rebuild, the refresh timing and what stops a redraw, renamed teams, a
// room deleted in another tab, error notices and the Bye Room. Check names
// start with the inventory's feature number (01-53).
//
// Words used below:
//   QBJ        a game's result file (.qbj, the open tournament schema
//              that YellowFruit and MODAQ read): teams, players, buzzes.
//   QBJ bundle the hub's Download > "QBJ bundle" (a .zip): every game's
//              .qbj and MODAQ game file (_Game.json), a folder per round,
//              plus roster.qbj, for a TD who wants the raw game files.
//   reader upload  a moderator's "Upload to qb-td" (.qbtd.json): the .qbj,
//              MODAQ's saved game, and the protests, in one file. The hub
//              hands it out as MODAQ's own two files, never as it is.
//   Finals fill  a Finals game written "1st in <bracket>" against "2nd in
//              <bracket>": the hub puts the teams in once that bracket's
//              games are all in, as it does for playoff slots.
//
// Run it (it starts its own Worker on a fresh local database, a static
// server for app/, and Chrome, on ports 9641-9649, and stops them after;
// about a minute and a half):
//   node tests/ui_full_livehub.js
// Before vs after: point it at another checkout's app/ and worker/ (the
// suite and its fixtures stay this file's; 173a444 has no
// tools/e2e_stack.mjs, so the suite starts that checkout's Worker itself):
//   mkdir /tmp/qbtd-173a444 && git archive 173a444 | tar -x -C /tmp/qbtd-173a444
//   ln -s "$PWD/node_modules" /tmp/qbtd-173a444/node_modules
//   QBTD_ROOT=/tmp/qbtd-173a444 node tests/ui_full_livehub.js
// Checks whose expected result changed with an approved 10/19 change are
// tagged "[changed: <changelog line>]"; those are the ones expected to
// fail against 173a444, and no untagged check fails there. Each run
// prints "ok <name>" and "FAIL <name>" lines, "NOTE" lines for behavior
// worth a look that is not a check (bugs found, and what shows them), and
// a total.
// To use a stack already running instead (tools/e2e_stack.mjs, on main):
//   node tools/e2e_stack.mjs --state <dir> --worker 9641 --pages 9642
//   QBTD_BASE=http://127.0.0.1:9641 QBTD_PAGES=http://localhost:9642 \
//   QBTD_PERSIST=<dir> node tests/ui_full_livehub.js
// Other knobs: QBTD_LH_PORTS=<first of ten ports> (default 9641: Worker,
// +1 pages, +2 Chrome DevTools, +8 inspector), CHROME=<binary>,
// QBTD_LH_ONLY=<comma list of section ids> to run some sections only:
// setup mirror main-live main-uploads main-protests main-fix main-rename
// main-stats rounds edit refresh brackets finals finals-held
// finals-level-ot finals-rename finals-same report-escape room-gone.
//
// Nothing here leaves this machine: the pages get ?server=<local Worker>
// and &live=off (and the same in localStorage, for the links they open
// themselves), Chrome blocks every production host, and the run fails if a
// page asked one. Packets are JSON only (a .docx would go to the outside
// parser). The Worker runs without LIVE_TOKEN, so its cron calls nothing
// outside.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRosterQbj, forfeitQbj } from '../app/engine/qbj.js';
import { buildSchedule, tagBrackets, renameTeams } from '../app/engine/schedule.js';
import { readZip } from '../app/engine/zip.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.QBTD_ROOT || HERE);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const P0 = Number(process.env.QBTD_LH_PORTS || 9641);
const PORT = { worker: P0, pages: P0 + 1, cdp: P0 + 2, inspector: P0 + 8 };
const ONLY = process.env.QBTD_LH_ONLY ? new Set(process.env.QBTD_LH_ONLY.split(',')) : null;
const started = Date.now();
const tmp = mkdtempSync(path.join(tmpdir(), 'qbtd-lh-'));
const dlDir = path.join(tmp, 'downloads');
const fxDir = path.join(tmp, 'fixtures');
mkdirSync(dlDir, { recursive: true });
mkdirSync(fxDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* ---------- tally ---------- */

let passed = 0;
const failed = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); return true; }
  failed.push(name);
  let x = extra;
  try { if (x !== undefined && typeof x !== 'string') x = JSON.stringify(x).slice(0, 1500); } catch (e) { /* as is */ }
  console.error('FAIL', name, x ?? '');
  return false;
}
// a check whose body may throw: the throw is its failure
async function check(name, fn) {
  let v;
  try { v = await fn(); } catch (e) { return ok(name, false, e.message); }
  return ok(name, v === true, v);
}
const notes = []; // observed behavior worth a look, printed at the end (not checks)
const note = (text) => { notes.push(text); console.log('  note', text); };
// a wait whose timeout is not a failure of its own: the checks after it say what went wrong
// (so a run against an older checkout goes on to its other checks)
const soft = (p) => p.catch(() => null);

// changelog lines (app/changelog.txt, Release Notes for 10/19/2026) the checks below are tagged with
const CHG = {
  settings2tabs: '[changed: HUB: Settings and protest rulings saved in two hub tabs no longer undo each other. The change made in each tab is kept.]',
  renameRefresh: '[changed: LIVE HUB: A rename saved in another tab reaches the hub on its next refresh.]',
  filedRound: '[changed: LIVE HUB: A game added under a different round than its file names now counts in the round it is filed under, as the hub shows it.]',
  addRound: '[changed: LIVE HUB: Add a game fills in Round from the match file, and notes when the round picked differs from the one the file names.]',
  unreadable: '[changed: LIVE HUB: When a game cannot be read, its playoff slots wait and the hub tries again, instead of filling from incomplete standings.]',
  rankOT: '[changed: LIVE HUB: Playoff slots, auto-fill and the Finals rank teams the way the public page does, without overtime in points per 20.]',
  computeOT: '[changed: LIVE HUB: Compute stats leaves overtime out of TUH, points per 20 and PPB, and sorts teams by winning percentage, as the public page does.]',
  levelOrder: '[changed: LIVE HUB: Teams tied on both winning percentage and points per 20 now fill playoff and Finals slots in the order the public page lists them, instead of always by name.]',
  levelNote: '[changed: LIVE HUB: When tied teams also had the same points per 20, the Playoffs and Finals notes say which order they kept, and a waiting tie\'s button says so too.]',
  renameFill: '[changed: LIVE HUB: Playoff and Finals slots fill on their own after a team is renamed, also in a hub tab opened before the rename.]',
  finishedRenamed: '[changed: LIVE HUB: The Finished rounds only option counts the games of renamed teams.]',
  editNumbers: '[changed: LIVE HUB: Edit in MODAQ keeps the question numbers of replaced and added questions, so a corrected game matches the original.]',
  samePools: '[changed: SCHEDULE: When the same pools play again, such as a double round robin or Copy this phase, playoff and Finals slots are seeded on all of their games.]',
  pubCorrected: '[changed: PUBLIC PAGE: After a TD\'s Rebuild, a room move or a room rename, the public page shows the corrected games without waiting for new ones.]',
  reportEscape: '[changed: SECURITY: Team, stage and bracket names with special characters now show as text in the stat report, so they can no longer run as code.]',
  serverFail: '[changed: MISC: When the server fails, pages say "Something went wrong on the server. Please try again." instead of reporting a network error.]',
  tbOnce: '[changed: PERFORMANCE: The Live Hub fetches the tiebreaker pool only when it has changed.]',
};

/* ---------- the local stack: a Worker on a fresh database, and app/ ---------- */

const kids = [];
const wenv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };
let BASE = process.env.QBTD_BASE || null;
let PAGES = process.env.QBTD_PAGES || null;
let PERSIST = process.env.QBTD_PERSIST || null;
let pagesServer = null;
function stopAll() {
  for (const k of kids.splice(0)) {
    try { process.kill(-k.pid, 'SIGTERM'); } catch (e) { try { k.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  }
  if (pagesServer) { try { pagesServer.close(); } catch (e) { /* closed */ } pagesServer = null; }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };
function servePages(root, port) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(u.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { /* missing */ }
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}
async function startStack() {
  PERSIST = path.join(tmp, 'state');
  mkdirSync(PERSIST, { recursive: true });
  const wdir = path.join(ROOT, 'worker');
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'qb-td', '--local', '--file', 'schema.sql', '--persist-to', PERSIST],
    { cwd: wdir, env: wenv, stdio: 'ignore' });
  const log = openSync(path.join(tmp, 'wrangler_dev.log'), 'a');
  kids.push(spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT.worker), '--ip', '127.0.0.1', '--test-scheduled',
    '--persist-to', PERSIST, '--var', `ALLOWED_ORIGIN:http://localhost:${PORT.pages}`, '--show-interactive-dev-session=false',
    '--inspector-port', String(PORT.inspector)], { cwd: wdir, env: wenv, stdio: ['ignore', log, log], detached: true }));
  pagesServer = await servePages(path.join(ROOT, 'app'), PORT.pages);
  BASE = `http://127.0.0.1:${PORT.worker}`;
  PAGES = `http://localhost:${PORT.pages}`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) { /* building */ }
    if (Date.now() - t0 > 120000) throw new Error('the Worker did not come up; see ' + path.join(tmp, 'wrangler_dev.log'));
    await sleep(300);
  }
}
if (!BASE) await startStack();
else if (!PERSIST) console.log('  (QBTD_PERSIST not set: the checks that look into the local database are skipped)');
console.log(`code under test: ${ROOT}\nWorker ${BASE}, pages ${PAGES}`);

/* ---------- the Worker, from Node ---------- */

async function fetchRetry(url, opts) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, opts); } catch (e) { if (i >= 2) throw e; await sleep(300); }
  }
}
async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; }
  const res = await fetchRetry(BASE + p, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}
// a statement against the local database behind the Worker (wrangler, --local only)
function d1(sql) {
  if (!PERSIST) throw new Error('needs QBTD_PERSIST');
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'qb-td', '--local', '--json', '--command', sql, '--persist-to', PERSIST],
    { cwd: path.join(ROOT, 'worker'), env: wenv }).toString();
  try { return JSON.parse(out.slice(out.indexOf('[')))[0].results; } catch (e) { return []; }
}
const tick = async () => { const r = await fetchRetry(BASE + '/__scheduled'); await r.text(); if (!r.ok) throw new Error('cron trigger ' + r.status); };
const settingsOf = (d) => { try { return JSON.parse(d.tournament.settings || '{}') || {}; } catch (e) { return {}; } };
// the cron serves a few tournaments a tick: tick until the condition holds (true), or give up (false)
async function untilTicked(fn, label, tries = 12) {
  for (let i = 0; i < tries; i++) {
    await tick();
    try { if (await fn()) return true; } catch (e) { /* not yet */ }
    await sleep(250);
  }
  console.log('     (gave up waiting for ' + label + ')');
  return false;
}
// the room a game has in its round's public data, as the public page reads it
async function pubShardRoom(T, round, id) {
  const st = (await call('/pub/' + T.slug)).body;
  const stamp = (st.rounds || {})[round];
  if (!stamp) return null;
  const sh = (await call(`/pub/${T.slug}/rounds?n=${round}@${stamp}`)).body;
  const e = (sh.rounds || []).flatMap((r) => r.entries).find((x) => x.id === id);
  return e ? e.room : null;
}

/* ---------- Chrome over the DevTools protocol ---------- */

const udd = path.join(tmp, 'profile');
kids.push(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT.cdp}`, `--user-data-dir=${udd}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking', '--disable-component-update',
  '--disable-sync', '--disable-features=Translate,OptimizationHints,MediaRouter', 'about:blank'], { stdio: 'ignore', detached: true }));
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(60);
  }
}
const wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT.cdp}/json/version`)).json()).webSocketDebuggerUrl, 'Chrome to start', 30000);
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(p.method + ': ' + m.error.message)); else p.res(m.result);
  } else if (m.method) for (const fn of [...listeners]) { try { fn(m); } catch (e) { console.error('listener', e); } }
};
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return Promise.race([new Promise((res, rej) => pending.set(id, { res, rej, method })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('no reply to ' + method)), 30000))]);
}
const once = (pred, ms = 20000, what = 'browser event') => new Promise((res, rej) => {
  const t = setTimeout(() => { listeners.splice(listeners.indexOf(fn), 1); rej(new Error('no ' + what + ' within ' + ms + 'ms')); }, ms);
  const fn = (m) => { if (pred(m)) { clearTimeout(t); listeners.splice(listeners.indexOf(fn), 1); res(m); } };
  listeners.push(fn);
});

// production hosts: blocked in Chrome, and any page that asks one fails the run
const PROD = ['qbsuite.github.io', 'workers.dev', 'raw.githubusercontent.com', 'quizbowlreader.com', 'api.github.com',
  'github.com', 'api.cloudflare.com'];
const prodHits = [];
const downloads = new Map(); // guid -> {name, url, done}
const opened = [];           // targets pages opened themselves: {targetId, url}
listeners.push((m) => {
  if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, url: m.params.url, done: false });
  if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed' && downloads.has(m.params.guid)) downloads.get(m.params.guid).done = true;
  if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && m.params.targetInfo.openerId) {
    opened.push({ targetId: m.params.targetInfo.targetId, url: m.params.targetInfo.url });
  }
  if (m.method === 'Target.targetInfoChanged') {
    const o = opened.find((x) => x.targetId === m.params.targetInfo.targetId);
    if (o) o.url = m.params.targetInfo.url;
  }
  if (m.method === 'Network.requestWillBeSent') {
    let host = '';
    try { host = new URL(m.params.request.url).hostname; } catch (e) { /* data: and the like */ }
    if (PROD.some((h) => host === h || host.endsWith('.' + h))) prodHits.push(m.params.request.url);
  }
});
await send('Target.setDiscoverTargets', { discover: true });
await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
await send('Browser.grantPermissions', { origin: new URL(PAGES).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });

const pageErrors = [];
const knownErrors = []; // page errors of a reported bug (each noted where it is found)
/** A tab, its own session: the helpers the checks drive it with. */
async function openPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params) => send(method, params, sessionId);
  const pg = { targetId, sessionId, S, url: 'about:blank', dialogs: [], answers: [], accept: true, reqs: [], rules: [] };
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Page.javascriptDialogOpening') {
      pg.dialogs.push(m.params.message);
      const a = pg.answers.length ? pg.answers.shift() : pg.accept;
      S('Page.handleJavaScriptDialog', { accept: m.params.type === 'beforeunload' ? true : a }).catch(() => {});
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push(pg.url + ': ' + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      pg.url = m.params.frame.url;
    } else if (m.method === 'Network.requestWillBeSent') {
      pg.reqs.push({ method: m.params.request.method, url: m.params.request.url, ts: m.params.timestamp, type: m.params.type || '' });
    } else if (m.method === 'Fetch.requestPaused') {
      onPaused(pg, m.params).catch((e) => console.error('intercept', e.message));
    }
  });
  await S('Page.enable');
  await S('Runtime.enable');
  await S('DOM.enable');
  await S('Network.enable');
  await S('Network.setCacheDisabled', { cacheDisabled: true });
  await S('Network.setBlockedURLs', { urls: PROD.map((h) => `*${h}*`) });
  await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await S('Emulation.setFocusEmulationEnabled', { enabled: true });
  // every document: the local Worker, never qb-td-live, whatever the URL says
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('qbtdServer', ${q(BASE)});
    localStorage.setItem('qbtdLive', 'off'); } catch (e) {}` });
  const withServer = (url) => {
    if (!url.startsWith(PAGES) || /[?&]server=/.test(url)) return url;
    const [u, hash] = url.split('#');
    return u + (u.includes('?') ? '&' : '?') + 'server=' + encodeURIComponent(BASE) + '&live=off' + (hash !== undefined ? '#' + hash : '');
  };
  pg.goto = async (url) => {
    const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, 'load of ' + url);
    await S('Page.navigate', { url: withServer(url) });
    await loaded;
  };
  pg.reload = async () => {
    const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, 'reload');
    await S('Page.reload');
    await loaded;
  };
  pg.js = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  pg.waitJs = async (expr, label, ms = 15000) => {
    try { return await until(() => pg.js(expr), label, ms); } catch (e) {
      let seen = '';
      try { seen = await pg.js(`((document.querySelector('#msg') || {}).textContent || '') + ' || ' + document.body.innerText.slice(0, 500)`); } catch (e2) { /* gone */ }
      throw new Error(e.message + ' — page: ' + norm(seen));
    }
  };
  pg.click = (sel) => pg.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
  pg.fill = (sel, value, events = ['input', 'change']) => pg.js(`(() => { const e = document.querySelector(${q(sel)});
    if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.value = ${q(value)};
    for (const t of ${q(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); return true; })()`);
  pg.text = (sel) => pg.js(`(document.querySelector(${q(sel)}) || {}).textContent || ''`);
  pg.ntext = async (sel) => norm(await pg.text(sel));
  pg.exists = (sel) => pg.js(`!!document.querySelector(${q(sel)})`);
  pg.msg = () => pg.js(`(() => { const m = document.querySelector('#msg'); return m ? { text: m.textContent, show: m.classList.contains('show'), bad: m.classList.contains('bad') } : null; })()`);
  pg.setFiles = async (sel, files) => {
    const { root } = await S('DOM.getDocument', { depth: 0 });
    const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) throw new Error('no file input ' + sel);
    await S('DOM.setFileInputFiles', { nodeId, files });
  };
  // the texts an element shows over the next action (a busy label that comes and goes)
  pg.watchTexts = (sel) => pg.js(`(() => { window.__seen = []; const look = () => { for (const e of document.querySelectorAll(${q(sel)})) {
      const t = e.textContent.replace(/\\s+/g, ' ').trim(); if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t); } };
    if (window.__obs) window.__obs.disconnect(); window.__obs = new MutationObserver(look);
    window.__obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); look(); return true; })()`);
  pg.seenTexts = () => pg.js(`window.__seen || []`);
  pg.refresh = () => pg.js(`document.dispatchEvent(new Event('visibilitychange')); true`);
  pg.close = () => send('Target.closeTarget', { targetId }).catch(() => {});
  return pg;
}

// request rules (Fetch domain), for a Worker answer the local Worker won't give
// on its own: {stage: 'Request'|'Response', test(method, url), act}
async function onPaused(pg, ev) {
  const S = pg.S;
  const resp = ev.responseStatusCode !== undefined || ev.responseErrorReason !== undefined;
  const rule = pg.rules.find((r) => r.stage === (resp ? 'Response' : 'Request') && r.test(ev.request.method, ev.request.url));
  if (!rule) {
    if (resp) await S('Fetch.continueResponse', { requestId: ev.requestId }).catch(() => S('Fetch.continueRequest', { requestId: ev.requestId }));
    else await S('Fetch.continueRequest', { requestId: ev.requestId });
    return;
  }
  rule.hits = (rule.hits || 0) + 1;
  if (rule.times !== undefined && rule.hits >= rule.times) pg.rules.splice(pg.rules.indexOf(rule), 1);
  const cors = [{ name: 'Access-Control-Allow-Origin', value: new URL(PAGES).origin }, { name: 'Content-Type', value: 'application/json' }];
  if (!resp) {
    const out = await rule.act(ev);
    if (out.fail) { await S('Fetch.failRequest', { requestId: ev.requestId, errorReason: out.fail }); return; }
    await S('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: out.status, responseHeaders: cors,
      body: Buffer.from(typeof out.body === 'string' ? out.body : JSON.stringify(out.body)).toString('base64') });
    return;
  }
  const got = await S('Fetch.getResponseBody', { requestId: ev.requestId });
  const text = got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body;
  const next = await rule.act(text, ev);
  await S('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: ev.responseStatusCode, responseHeaders: ev.responseHeaders,
    body: Buffer.from(next).toString('base64') });
}
async function withRules(pg, rules, fn) {
  pg.rules.push(...rules);
  await pg.S('Fetch.enable', { patterns: [{ urlPattern: BASE + '/*', requestStage: 'Request' }, { urlPattern: BASE + '/*', requestStage: 'Response' }] });
  try { return await fn(); } finally {
    for (const r of rules) { const i = pg.rules.indexOf(r); if (i >= 0) pg.rules.splice(i, 1); }
    if (!pg.rules.length) await pg.S('Fetch.disable').catch(() => {});
  }
}

// a download started by a click in the page: {name, bytes}
async function download(pg, clickExpr) {
  const before = new Set(downloads.keys());
  await pg.js(clickExpr);
  const guid = await until(() => [...downloads.keys()].find((g) => !before.has(g) && downloads.get(g).done), 'a download', 20000);
  return { name: downloads.get(guid).name, url: downloads.get(guid).url, bytes: readFileSync(path.join(dlDir, guid)) };
}
async function downloadsFrom(pg, clickExpr, n) {
  const before = new Set(downloads.keys());
  await pg.js(clickExpr);
  const got = await until(() => { const f = [...downloads.keys()].filter((g) => !before.has(g)); return f.length >= n && f.every((g) => downloads.get(g).done) && f; },
    n + ' downloads', 20000);
  return got.map((g) => ({ name: downloads.get(g).name, bytes: readFileSync(path.join(dlDir, g)) }));
}

/* ---------- fixtures ---------- */

const writeFx = (name, data) => { const p = path.join(fxDir, name); writeFileSync(p, data); return p; };
const packetFor = (n) => JSON.stringify({
  tossups: Array.from({ length: 20 }, (_, i) => ({ question: `Round ${n} tossup ${i + 1}: this author wrote a novel about the sea. For 10 points, name this.`,
    answer: `answer ${n}-${i + 1}`, category: ['Literature', 'Science', 'History', 'Fine Arts'][i % 4] })),
  bonuses: Array.from({ length: 20 }, (_, i) => ({ leadin: `Round ${n} bonus ${i + 1}. For 10 points each:`,
    parts: ['First part.', 'Second part.', 'Third part.'], answers: ['a', 'b', 'c'], values: [10, 10, 10], category: 'History' })),
});
const TB_POOL = { tossups: [{ question: 'Tiebreaker one text here.', answer: 'Treaty of Ghent' }, { question: 'Tiebreaker two text here.', answer: 'Peace of Utrecht' }],
  bonuses: [{ leadin: 'Tiebreaker bonus.', parts: ['p1', 'p2', 'p3'], answers: ['x', 'y', 'z'], values: [10, 10, 10] }] };

/**
 * A match .qbj with a question-by-question record. plan: one entry per
 * tossup read, null (dead) or a list of buzzes [side, playerIndex, value]
 * (side 0 or 1). A get in regulation earns its team `bonus` points.
 * lineups: optional {side: [{first: question, players: [indexes]}]}.
 */
function matchQbj({ round, teams, players, plan, bonus = 10, regulation = 20, lineups = null, notes = undefined }) {
  const qs = [];
  const counts = [new Map(), new Map()];
  const bonusPts = [0, 0];
  let bonusNo = 0;
  plan.forEach((entry, i) => {
    const buzzes = (entry || []).map(([side, pi, v]) => {
      const c = counts[side];
      const k = pi + ':' + v;
      c.set(k, (c.get(k) || 0) + 1);
      return { player: { name: players[side][pi] }, team: { name: teams[side] }, buzz_position: { word_index: 3 + i }, result: { value: v } };
    });
    const get = (entry || []).find(([, , v]) => v > 0);
    const mq = { question_number: i + 1, tossup_question: { question_number: i + 1, type: 'tossup', parts: 1 }, buzzes };
    if (get && i < regulation) {
      bonusPts[get[0]] += bonus;
      mq.bonus = { question: { question_number: ++bonusNo, type: 'bonus', parts: 3 },
        parts: [{ controlled_points: bonus }, { controlled_points: 0 }, { controlled_points: 0 }] };
    }
    qs.push(mq);
  });
  const side = (s) => ({
    team: { name: teams[s], players: players[s].map((name) => ({ name })) },
    bonus_points: bonusPts[s],
    match_players: players[s].map((name, pi) => {
      const ac = [];
      for (const [k, n] of counts[s]) { const [p, v] = k.split(':').map(Number); if (p === pi) ac.push({ number: n, answer: { value: v } }); }
      return { player: { name }, tossups_heard: plan.length, answer_counts: ac };
    }),
    lineups: lineups && lineups[s] ? lineups[s].map((l) => ({ first_question: l.first, players: l.players.map((pi) => ({ name: players[s][pi] })) }))
      : [{ first_question: 1, players: players[s].map((name) => ({ name })) }],
  });
  return { _round: round, tossups_read: plan.length, match_teams: [side(0), side(1)], match_questions: qs, ...(notes ? { notes } : {}) };
}
// a quick game: `gets` tossups to each side (player 0), the rest dead; 20 read
function quickGame(round, teams, players, gets, extra = {}) {
  const plan = [];
  for (let i = 0; i < 20; i++) plan.push(i < gets[0] ? [[0, 0, 10]] : i < gets[0] + gets[1] ? [[1, 0, 10]] : null);
  return matchQbj({ round, teams, players, plan, ...extra });
}
const scoreOf = (m) => m.match_teams.map((mt) => mt.bonus_points + mt.match_players.reduce((s, mp) => s + mp.answer_counts.reduce((x, ac) => x + ac.number * ac.answer.value, 0), 0));

// a fresh tournament through the Worker; the caps per address are for real days, not test runs
let made = 0;
async function newTournament(name, extra = {}) {
  if (PERSIST && made++ % 8 === 0) d1("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const slug = 'lh-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) + '-' + Math.random().toString(36).slice(2, 7);
  const r = await call('/api/tournaments', { method: 'POST', json: { name, slug, ...extra } });
  if (r.status !== 200) throw new Error('create ' + name + ': ' + JSON.stringify(r.body));
  const t = r.body;
  const A = '/a/' + t.admin_secret;
  const T = {
    t, A, slug: t.slug, secret: t.admin_secret, rooms: [],
    detail: async () => (await call(T.A)).body,
    addRoom: async (room_name) => { const b = (await call(T.A + '/buckets', { method: 'POST', json: { room_name } })).body; T.rooms.push(b); return b; },
    roster: async (teams, track) => call(T.A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(buildRosterQbj(name, teams, track)) }),
    schedule: async (s) => call(T.A + '/schedule', { method: 'POST', json: s }),
    savedSchedule: async () => { const d = await T.detail(); return (await call(`${T.A}/file?key=${encodeURIComponent(`t/${d.tournament.id}/schedule.json`)}`)).body; },
    packet: async (n) => call(`${T.A}/packet?round=${n}&name=P${n}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: packetFor(n) }),
    // the settings with these keys changed, the rest as stored (the hub's Bye Room among them)
    settings: async (s) => { const cur = settingsOf(await T.detail()); return call(T.A, { method: 'POST', json: { settings: { ...cur, ...s } } }); },
    start: async () => call(T.A + '/start', { method: 'POST' }),
    upload: async (room, round, filename, body) => (await call(`/b/${room.secret}/upload?round=${round}&name=${encodeURIComponent(filename)}`,
      { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })).body,
    startRound: async (room, n) => call(`/b/${room.secret}/start?round=${n}`, { method: 'POST' }),
    file: async (f, part) => call(`${T.A}/file?key=${encodeURIComponent(f.r2_key)}${part ? '&part=' + part : ''}`),
    hub: (extraQs = '') => `${PAGES}/index.html?a=${T.secret}${extraQs}`,
  };
  return T;
}

const hub = await openPage();
// the hub, opened on the Live view
async function openLive(pg, T) {
  await pg.goto(T.hub());
  await pg.waitJs(`!!document.querySelector('.hubtab')`, 'the hub');
  if (!(await pg.exists('.biground'))) await pg.click('[data-view="live"]');
  await pg.waitJs(`!!document.querySelector('.biground')`, 'the Live view');
}
// marks the hub's view, so a redraw shows (render() replaces it all)
const markView = (pg) => pg.js(`document.querySelector('#viewbody').dataset.mark = 'kept'; true`);
const viewKept = (pg) => pg.js(`(document.querySelector('#viewbody') || {dataset: {}}).dataset.mark === 'kept'`);

/* ---------- sections ---------- */

const sections = [];
const section = (id, title, fn) => sections.push({ id, title, fn });

// real DOM drag events, as a mouse drag fires them (the schedule editor)
const dragOnto = (pg, fromExpr, toExpr) => pg.js(`(() => { const from = ${fromExpr}, to = ${toExpr}; if (!from || !to) throw new Error('drag: nothing there');
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
const fmtWhenIn = (pg, ms) => pg.js(`new Date(${ms}).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })`);
const msgIs = (pg, text, bad = null) => pg.waitJs(`(() => { const m = document.querySelector('#msg');
  return m && m.classList.contains('show') && m.textContent === ${q(text)} && (${bad === null} || m.classList.contains('bad') === ${!!bad}); })()`, 'the notice ' + text);
const dismiss = (pg) => pg.js(`(() => { const m = document.querySelector('#msg'); if (m && m.classList.contains('show')) m.click(); return true; })()`);
// a notice shows: its text, red or not
async function expectNotice(pg, name, text, bad) {
  await check(name, async () => { await msgIs(pg, text, bad); return true; });
  await dismiss(pg);
}
// what the page asked the Worker over the next `ms` (for a refresh that must not happen)
async function quietFor(pg, ms, test) {
  const n0 = pg.reqs.length;
  await sleep(ms);
  return pg.reqs.slice(n0).filter((r) => test(r.method, r.url));
}
const isDetailGet = (secret) => (m, u) => m === 'GET' && new RegExp(`/a/${secret}(\\?rev=\\d+)?$`).test(u);
const bannerTexts = (pg) => pg.js(`[...document.querySelectorAll('.banner')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())`);

const TEAMS4 = ['Ants', 'Bees', 'Cats', 'Dogs'];
const ROSTER4 = TEAMS4.map((n) => ({ name: n, players: [n + ' One', n + ' Two', n + ' Three'] }));

section('setup', '01 02 03 04 06 07 10 27 28 52: the setup flow, the header and its links', async () => {
  const pg = hub;
  const T = await newTournament('Setup Flow', { settings: { autoAdvance: true } });
  await pg.goto(T.hub());
  await pg.waitJs(`!!document.querySelector('.hubtab')`, 'the hub');
  await check('01 view: setup not done, the hub opens on Setup', async () =>
    (await pg.exists('.stepbtn')) && (await pg.ntext('.hubtab.on')).startsWith('Setup') && !(await pg.exists('.biground')));
  await check('01 view: the Setup tab shows the dot while setup is incomplete', () => pg.exists('[data-view="setup"] .ndot'));
  let d = await T.detail();
  await check('02 header: the name, "Not started · setup open until" the close time, and the slug', async () => {
    const when = await fmtWhenIn(pg, d.tournament.closes);
    const got = [await pg.text('.hubtitle h1'), await pg.ntext('.hubtitle .muted:not(.slug)'), await pg.text('.hubtitle .slug')];
    return JSON.stringify(got) === JSON.stringify(['Setup Flow', `Not started · setup open until ${when}`, T.slug]) || got;
  });
  await pg.click('[data-view="live"]');
  await pg.waitJs(`!!document.querySelector('.biground')`, 'the Live view');
  await check('01 view: clicking Live shows the Live view', async () => (await pg.ntext('.hubtab.on')) === 'Live');
  await check('06 not started: the Live view says so, with Start tournament', async () => {
    const b = await bannerTexts(pg);
    return (b[0] === 'Not started Room links show “Tournament hasn’t started” until you start it. Start tournament' && await pg.exists('#livestart')) || b;
  });
  await check('07 setup incomplete: the banner names every step still to do', async () => {
    const b = await bannerTexts(pg);
    return b[1] === 'Setup incomplete Still to do: Rooms, Roster, Schedule, Packets, MODAQ Settings, Public page Open setup' || b;
  });
  await check('10 live now: with no rooms, "No rooms yet. Add them under Setup."', async () =>
    (await pg.ntext('.livemain section')).includes('No rooms yet. Add them under Setup.') && !(await pg.exists('.ugrid')));
  // Add a game with no room to pick. Observed: with no rooms the Live
  // view's draw stops at the auto-advance switch it didn't draw (admin.js
  // renderLive, $('autoadv').onchange), so Upload, Start tournament,
  // Advance, Set round and Compute there do nothing (reported, not asserted)
  await pg.click('#addtoggle');
  await check('26 add a game: the toggle opens the panel and says so (aria-expanded)', () =>
    pg.js(`!document.querySelector('#addpanel').hidden && document.querySelector('#addtoggle').getAttribute('aria-expanded') === 'true'`));
  {
    const n0 = pageErrors.length;
    await pg.click('#addgame');
    await sleep(400);
    const said = await pg.msg();
    if (!(said && said.show && said.text === 'Pick a room')) {
      note('BUG (Live view, no rooms): Upload in Add a game does nothing (no "Pick a room"); the Live view threw '
        + JSON.stringify(pageErrors.slice(Math.max(0, n0 - 6)).map((e) => e.split('\n')[0]).slice(-1)));
    }
    // the same draw error, once per draw while there are no rooms
    knownErrors.push(/Cannot set properties of null \(setting 'onchange'\)\n\s+at renderLive/);
  }
  await pg.click('#addcancel');
  await check('26 add a game: Cancel closes it (aria-expanded false)', () =>
    pg.js(`document.querySelector('#addpanel').hidden && document.querySelector('#addtoggle').getAttribute('aria-expanded') === 'false'`));
  await pg.click('#fftoggle');
  await pg.waitJs(`!!document.querySelector('#ffpanel')`, 'the forfeit panel');
  await pg.click('#ffsave');
  await expectNotice(pg, '28 forfeit: no room to pick says "Pick a room"', 'Pick a room', true);
  await pg.click('#ffcancel');
  await check('28 forfeit: Cancel closes the panel', async () => !(await pg.exists('#ffpanel'))
    && (await pg.js(`document.querySelector('#fftoggle').getAttribute('aria-expanded')`)) === 'false');
  await pg.click('#gosetup');
  await check('07 setup incomplete: Open setup goes to the Setup view', () => pg.waitJs(`!!document.querySelector('.stepbtn') && !document.querySelector('.biground')`, 'Setup'));

  // the public page's link
  const pubUrl = `${PAGES}/t.html?t=${T.slug}`;
  await pg.click('.hubnav button.linkbtn:not(#rotate)');
  await check('03 copy public link: the notice says so', async () => { await msgIs(pg, 'Copied public link', false); return true; });
  await check('03 copy public link: the clipboard holds the public page\'s address', async () => (await pg.js('navigator.clipboard.readText()')) === pubUrl);
  await check('03 open public page: links the same address, in a new tab', () =>
    pg.js(`(() => { const a = [...document.querySelectorAll('.hubnav a')].find((x) => x.textContent === 'Open public page');
      return !!a && a.href === ${q(pubUrl)} && a.target === '_blank'; })()`));
  {
    const n0 = opened.length;
    await pg.js(`[...document.querySelectorAll('.hubnav a')].find((x) => x.textContent === 'Open public page').click(); true`);
    await check('03 open public page: clicking it opens the public page in a new tab', async () => {
      const o = await until(() => opened.slice(n0).find((x) => x.url.startsWith(pubUrl)), 'the new tab', 10000);
      await send('Target.closeTarget', { targetId: o.targetId }).catch(() => {});
      return true;
    });
  }

  // rooms, roster and a schedule: setup still incomplete; the editor's unsaved edits
  for (const n of ['Room 1', 'Room 2']) await T.addRoom(n);
  await T.roster(ROSTER4);
  await T.schedule(buildSchedule('rr', TEAMS4, T.rooms.map((b) => ({ name: b.room_name, bucket: b.id }))));
  await pg.reload();
  await pg.waitJs(`!!document.querySelector('.stepbtn')`, 'the hub again');
  await check('01 view: still incomplete (no packets yet), it opens on Setup again with the dot',
    async () => (await pg.exists('[data-view="setup"] .ndot')) && !(await pg.exists('.biground')));
  await pg.click('[data-step="sched"]');
  await pg.waitJs(`!!document.querySelector('.sgslot[data-ref]')`, 'the schedule editor');
  const slot = (i) => `document.querySelectorAll('.sgslot[data-ref]')[${i}]`;
  await dragOnto(pg, slot(0), slot(2));
  await pg.waitJs(`/1 unsaved change/.test(document.querySelector('.sgbar').textContent)`, 'an unsaved change');
  let asked = pg.dialogs.length;
  pg.answers.push(false);
  await pg.click('[data-view="live"]');
  await check('01 leave schedule: switching to Live with unsaved edits asks first', async () =>
    ((await until(() => pg.dialogs.length > asked, 'the question')) && pg.dialogs[asked] === 'The schedule has unsaved changes. Leave without saving?') || pg.dialogs.slice(asked));
  await check('01 leave schedule: Cancel keeps the TD on the Schedule step, edits kept', async () =>
    (await pg.exists('.sgbar')) && /1 unsaved change/.test(await pg.text('.sgbar')) && !(await pg.exists('.biground')));
  asked = pg.dialogs.length;
  pg.answers.push(true);
  await pg.click('[data-view="live"]');
  await check('01 leave schedule: OK goes to Live', async () => { await pg.waitJs(`!!document.querySelector('.biground')`, 'Live'); return pg.dialogs.length === asked + 1; });
  pg.answers.push(true);
  await pg.click('[data-view="setup"]');
  await pg.waitJs(`!!document.querySelector('#scheddiscard')`, 'the editor again');
  await pg.click('#scheddiscard');
  await pg.waitJs(`/Saved/.test(document.querySelector('.sgbar').textContent)`, 'discarded');

  // Add a game and Record a forfeit before Start: the rest of what they say
  await pg.click('[data-view="live"]');
  await pg.waitJs(`!!document.querySelector('#addtoggle')`, 'Live');
  await pg.click('#addtoggle');
  await pg.fill('#addround', '0');
  await pg.click('#addgame');
  await expectNotice(pg, '27 add a game: round 0 says "Pick a round"', 'Pick a round', true);
  await pg.fill('#addround', '');
  await pg.click('#addgame');
  await expectNotice(pg, '27 add a game: no round says "Pick a round"', 'Pick a round', true);
  await pg.fill('#addround', '1');
  await pg.click('#addgame');
  await expectNotice(pg, '27 add a game: no file says "Choose the game files"', 'Choose the game files', true);
  const g1 = quickGame(1, ['Ants', 'Bees'], [ROSTER4[0].players, ROSTER4[1].players], [5, 3]);
  await pg.setFiles('#addfile', [writeFx('Round_1_Ants_Bees.qbj', JSON.stringify(g1))]);
  await pg.waitJs(`document.querySelectorAll('#addlist .addfile').length === 1`, 'the file listed');
  await pg.click('#addgame');
  await expectNotice(pg, '27 add a game: before Start, "Start the tournament first…"',
    'Start the tournament first: rooms take games only once it has started', true);
  await check('27 add a game: and nothing went up', async () => (await T.detail()).files.length === 0);
  await pg.click('#addcancel');
  await pg.click('#fftoggle');
  await pg.waitJs(`!!document.querySelector('#ffpanel')`, 'the forfeit panel');
  const sched = await T.savedSchedule();
  const pairIn = (round, roomIdx) => { const g = sched.phases[0].rounds.find((r) => r.round === round).games.find((x) => x.room === roomIdx); return [g.a.team, g.b.team]; };
  await check('28 forfeit: the team lists hold every team, sorted, after "Choose a team"', async () => {
    const lists = await pg.js(`['#fflose', '#ffwin'].map((s) => [...document.querySelector(s).options].map((o) => o.textContent))`);
    const want = ['Choose a team', ...[...TEAMS4].sort()];
    return lists.every((l) => JSON.stringify(l) === JSON.stringify(want)) || lists;
  });
  await check('28 forfeit: prefilled with the pair scheduled in the first room this round, the first team forfeiting', async () =>
    JSON.stringify(await pg.js(`[document.querySelector('#ffroom').value, document.querySelector('#fflose').value, document.querySelector('#ffwin').value]`))
      === JSON.stringify([String(T.rooms[0].id), ...pairIn(1, 0)]));
  await pg.fill('#ffroom', String(T.rooms[1].id), ['change']);
  await check('28 forfeit: another room fills in its own pair', () => pg.waitJs(`document.querySelector('#fflose').value === ${q(pairIn(1, 1)[0])}
    && document.querySelector('#ffwin').value === ${q(pairIn(1, 1)[1])}`, 'room 2\'s pair'));
  await pg.fill('#ffround', '2', ['change']);
  await check('28 forfeit: another round fills in that round\'s pair', () => pg.waitJs(`document.querySelector('#fflose').value === ${q(pairIn(2, 1)[0])}
    && document.querySelector('#ffwin').value === ${q(pairIn(2, 1)[1])}`, 'round 2\'s pair'));
  await pg.fill('#ffround', '0', ['input']);
  await pg.click('#ffsave');
  await expectNotice(pg, '28 forfeit: round 0 says "Pick a round"', 'Pick a round', true);
  await pg.fill('#ffround', '1', ['input']);
  await pg.fill('#fflose', '', ['change']);
  await pg.click('#ffsave');
  await expectNotice(pg, '28 forfeit: a team not chosen says "Pick both teams"', 'Pick both teams', true);
  await pg.fill('#fflose', 'Ants', ['change']);
  await pg.fill('#ffwin', 'Ants', ['change']);
  await pg.click('#ffsave');
  await expectNotice(pg, '28 forfeit: the same team twice says "Pick two different teams"', 'Pick two different teams', true);
  await pg.fill('#ffwin', 'Bees', ['change']);
  await pg.click('#ffsave');
  await expectNotice(pg, '27 forfeit: before Start, "Start the tournament first…"',
    'Start the tournament first: rooms take games only once it has started', true);
  await pg.click('#ffcancel');

  // the rest of setup through the Worker: the hub now opens on Live
  for (const n of [1, 2, 3]) await T.packet(n);
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await pg.reload();
  await pg.waitJs(`!!document.querySelector('.hubtab')`, 'the hub, set up');
  await check('01 view: with every step done, the hub opens on Live', () => pg.waitJs(`!!document.querySelector('.biground')`, 'Live by default'));
  await check('01 view: and the Setup tab has no dot', async () => !(await pg.exists('[data-view="setup"] .ndot')));
  await check('07 setup done: no Setup incomplete banner', async () => !(await bannerTexts(pg)).some((b) => /Setup incomplete/.test(b)));

  // Start from the Live view: Cancel, then OK
  asked = pg.dialogs.length;
  pg.answers.push(false);
  await pg.click('#livestart');
  await until(() => pg.dialogs.length > asked, 'the Start question');
  await check('06 start: the question says when every link stops working', () =>
    /^Start the tournament\?\n\nRoom links start serving packets and taking games\. Your admin link and every room link stop working 48 hours from now, at .+\.$/
      .test(pg.dialogs[asked]) || pg.dialogs[asked]);
  await check('06 start: Cancel starts nothing', async () => !(await T.detail()).tournament.started && (await pg.exists('#livestart')));
  pg.answers.push(true);
  await pg.click('#livestart');
  await pg.waitJs(`/^Tournament started\\. Links close /.test(document.querySelector('#msg').textContent)`, 'started');
  d = await T.detail();
  await check('06 start: OK starts it, and the notice gives the close time', async () =>
    !!d.tournament.started && (await pg.text('#msg')) === 'Tournament started. Links close ' + await pg.js(`new Date(${d.tournament.closes}).toLocaleString()`));
  await check('06 start: the Not started banner goes', () => pg.waitJs(`!document.querySelector('#livestart') && ![...document.querySelectorAll('.banner')].some((b) => /Not started/.test(b.textContent))`, 'no banner'));
  await check('02 header: once started, "closes <Mon D, h:mm AM>"', async () =>
    (await pg.ntext('.hubtitle .muted:not(.slug)')) === 'closes ' + await fmtWhenIn(pg, d.tournament.closes));

  // a new admin link
  const oldSecret = T.secret;
  asked = pg.dialogs.length;
  pg.answers.push(false);
  await pg.click('#rotate');
  await until(() => pg.dialogs.length > asked, 'the rotate question');
  await check('04 new admin link: asks first', () => pg.dialogs[asked] === 'Mint a new admin link? The current link stops working.' || pg.dialogs[asked]);
  await check('04 new admin link: Cancel changes nothing', async () =>
    (await pg.js('location.search')).includes('a=' + oldSecret) && (await call('/a/' + oldSecret)).status === 200 && (await pg.js(`document.querySelector('#linkmodal').hidden`)));
  await pg.watchTexts('#rotate');
  pg.answers.push(true);
  await pg.click('#rotate');
  await pg.waitJs(`!document.querySelector('#linkmodal').hidden`, 'the link modal');
  const linkText = await pg.text('#modallink');
  const newSecret = (/[?&]a=([a-z0-9]+)/.exec(linkText) || [])[1];
  await check('04 new admin link: the button reads "Making a new link…" while it works', async () => (await pg.seenTexts()).includes('Making a new link…') || await pg.seenTexts());
  await check('04 new admin link: the modal shows the new link', () => (!!newSecret && newSecret !== oldSecret && linkText === `${PAGES}/index.html?a=${newSecret}`) || linkText);
  await check('04 new admin link: the address bar has it too', async () => (await pg.js('location.href')) === `${PAGES}/index.html?a=${newSecret}`);
  await check('04 new admin link: the modal gives the close time', async () =>
    (await pg.text('#modalcloses')) === await pg.js(`new Date(${d.tournament.closes}).toLocaleString()`));
  await pg.click('#modalcopy');
  await check('04 new admin link: Copy link puts it on the clipboard', async () => {
    await msgIs(pg, 'Copied admin link', false);
    return (await pg.js('navigator.clipboard.readText()')) === linkText;
  });
  // while the modal is up, a refresh redraws nothing, even with a change waiting
  T.secret = newSecret;
  T.A = '/a/' + newSecret;
  await markView(pg);
  await T.startRound(T.rooms[0], 1);
  await pg.refresh();
  const asks = await quietFor(pg, 1200, isDetailGet(newSecret));
  await check('04 new admin link: while the modal is open the hub does not redraw', async () => ((await viewKept(pg)) && asks.length === 0) || asks);
  {
    const loaded = once((m) => m.sessionId === pg.sessionId && m.method === 'Page.loadEventFired', 20000, 'the reload');
    await pg.click('#modalok');
    await loaded;
  }
  await pg.waitJs(`!!document.querySelector('.hubtab')`, 'the hub after Saved it');
  await check('04 new admin link: Saved it reloads the hub on the new link', async () => (await pg.js('location.search')).includes('a=' + newSecret));
  await pg.goto(`${PAGES}/index.html?a=${oldSecret}`);
  await check('04 new admin link: the old link now fails, with only a way back to the list', async () => {
    await msgIs(pg, 'bad link', true);
    return (await pg.js(`[...document.querySelectorAll('#view a')].map((a) => a.textContent).join('|')`)) === 'All tournaments';
  });
  await dismiss(pg);

  if (PERSIST) {
    // 52: a closed tournament
    d1(`UPDATE tournaments SET started = ${Date.now() - 49 * 3600 * 1000} WHERE id = ${d.tournament.id}`);
    await pg.goto(T.hub());
    await check('52 closed: a tournament past its 48 hours says so, with only All tournaments', async () => {
      await msgIs(pg, 'Tournament closed (links stop working 48 hours after Start, or 7 days after creation if it never started)', true);
      return (await pg.js(`[...document.querySelectorAll('#view a')].map((a) => a.textContent).join('|')`)) === 'All tournaments';
    });
    await dismiss(pg);
    // 52: a Worker that fails: a key that won't unwrap makes the route throw
    const F = await newTournament('Server Fault');
    const fid = (await F.detail()).tournament.id;
    d1(`UPDATE tournaments SET admin_wrap = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ${fid}`);
    await pg.goto(F.hub());
    await check('52 server failure: the hub says "Something went wrong on the server. Please try again." ' + CHG.serverFail, async () => {
      await pg.waitJs(`document.querySelector('#msg').classList.contains('show')`, 'a notice');
      return (await pg.text('#msg')) === 'Something went wrong on the server. Please try again.' || await pg.text('#msg');
    });
    await dismiss(pg);
  }
});

section('mirror', '02 09: the mirror line and a mirror\'s tiebreaker pool', async () => {
  const pg = hub;
  if (PERSIST) d1("UPDATE sets SET creator_ip = 'earlier-run'");
  const set = (await call('/api/sets', { method: 'POST', json: { name: 'Spring Set', slug: 'lh-set-' + Math.random().toString(36).slice(2, 7) } })).body;
  if (!set.admin_secret) throw new Error('set: ' + JSON.stringify(set));
  const SS = '/s/' + set.admin_secret;
  await call(`${SS}/tiebreakers?name=tb.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: [{ question: 'Set tiebreaker one.', answer: 'One' }, { question: 'Set tiebreaker two.', answer: 'Two' }] }) });
  const inv = (await call(`${SS}/mirrors`, { method: 'POST', json: { name: 'Mirror One' } })).body;
  if (PERSIST) d1("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const m = (await call('/i/' + inv.invite, { method: 'POST', json: { name: 'Mirror One', slug: 'lh-mirror-' + Math.random().toString(36).slice(2, 7) } })).body;
  if (!m.admin_secret) throw new Error('mirror: ' + JSON.stringify(m));
  const MA = '/a/' + m.admin_secret;
  await call(`${MA}/tiebreakers?name=own.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: [{ question: 'Own tiebreaker.', answer: 'Own' }] }) });
  await pg.goto(`${PAGES}/index.html?a=${m.admin_secret}`);
  await pg.waitJs(`!!document.querySelector('.hubtab')`, 'the mirror hub');
  if (!(await pg.exists('.biground'))) await pg.click('[data-view="live"]');
  await pg.waitJs(`!!document.querySelector('.biground')`, 'Live');
  const line = () => pg.js(`(() => { const x = [...document.querySelectorAll('.hubhead > .muted')].find((e) => /Mirror of/.test(e.textContent)); return x ? x.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
  await check('02 mirror: the header says "Mirror of <set name>", with no set page link while the set page is off', async () =>
    ((await line()) === 'Mirror of Spring Set' && !(await pg.js(`[...document.querySelectorAll('.hubhead a')].some((a) => a.textContent === 'set page')`))) || await line());
  await check('09 mirror: the tiebreaker count holds the set\'s backup questions and the tournament\'s own', async () =>
    (await pg.js(`[...document.querySelectorAll('.roundline .muted')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).find((x) => /^Tiebreakers/.test(x)) || ''`)) === 'Tiebreakers 0/3 used');
  await call(SS, { method: 'POST', json: { published: true } });
  const setSlug = (await call(SS)).body.set.slug;
  await pg.reload();
  await pg.waitJs(`!!document.querySelector('.hubhead')`, 'the mirror hub again');
  await check('02 mirror: with the set page public, a "set page" link to it', async () =>
    ((await line()) === 'Mirror of Spring Set · set page'
      && await pg.js(`[...document.querySelectorAll('.hubhead a')].some((a) => a.textContent === 'set page' && a.href === ${q(`${PAGES}/s.html?s=${setSlug}`)} && a.target === '_blank')`)) || await line());
});

/* ---------- the main day: a round robin of eight teams in four rooms, plus an Annex no game is scheduled in ---------- */

const TEAMS8 = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const PLAY = (n) => [n + ' 1', n + ' 2', n + ' 3'];
const ROSTER8 = TEAMS8.map((n) => ({ name: n, players: [...PLAY(n), n + ' Sub'] }));
const GAME_STORE = { players: [], cycles: [], packet: { tossups: [{ question: 'q', answer: 'a' }], bonuses: [] } };
// a reader upload (.qbtd.json) of a match, with MODAQ's own two files riding along
const readerFile = (qbj, extra = {}) => ({ qbj, game: { game: GAME_STORE, uiState: {} },
  modaq: { qbj: JSON.stringify(qbj, null, 4), game: JSON.stringify(GAME_STORE, null, 2) }, ...extra });
const tuProtest = (qn, team, to, from, gain, detail, given = '', reason = 'The answer line accepts it') =>
  ({ kind: 'tu', q: qn, team, word: 12, given, reason, to, from, gain, loss: 0, detail });
const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const gamesOf = (p) => [PLAY(p[0]), PLAY(p[1])];

let MAIN = null;
async function mainDay() {
  if (MAIN) return MAIN;
  const T = await newTournament('Main Day');
  for (const n of ['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Annex']) await T.addRoom(n);
  await T.roster(ROSTER8);
  const sched = buildSchedule('rr', TEAMS8, T.rooms.slice(0, 4).map((b) => ({ name: b.room_name, bucket: b.id })));
  await T.schedule(sched);
  for (let n = 1; n <= 7; n++) await T.packet(n);
  await call(`${T.A}/tiebreakers?name=tb.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(TB_POOL) });
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  const pair = (round, i) => { const g = sched.phases[0].rounds.find((r) => r.round === round).games.find((x) => x.room === i); return [g.a.team, g.b.team]; };
  const [R1, R2, R3, R4, AX] = T.rooms;
  MAIN = { T, sched, pair, R1, R2, R3, R4, AX };
  // round 1: Room 1 a reader upload with three protests, Room 2 one still
  // in progress, Room 3 started with nothing in, Room 4 a file that can't
  // be read; the Annex a lone game file for round 9
  const p = [0, 1, 2, 3].map((i) => pair(1, i));
  MAIN.p1 = p;
  MAIN.g11 = quickGame(1, p[0], gamesOf(p[0]), [6, 5]); // 120 – 100
  MAIN.P = [tuProtest(3, p[0][1], p[0][1], p[0][0], 25, { tu: 10, neg: 0, bonus: 15 }, 'treaty of utrecht'),
    tuProtest(7, p[0][0], p[0][0], p[0][1], 10, { tu: 10, neg: 0, bonus: 0 }, 'ghent'),
    tuProtest(9, p[0][0], p[0][0], p[0][1], 0, { tu: 0, neg: 0, bonus: 0 }, 'vienna', 'A late prompt')];
  MAIN.f11 = await T.upload(R1, 1, `Round_1_${p[0][0]}_${p[0][1]}.qbtd.json`, readerFile(MAIN.g11, { protests: MAIN.P }));
  MAIN.g12 = quickGame(1, p[1], gamesOf(p[1]), [3, 2]); // 60 – 40
  MAIN.f12 = await T.upload(R2, 1, `Round_1_${p[1][0]}_${p[1][1]}.qbtd.json`, readerFile(MAIN.g12, { progress: { at: 12, of: 20 } }));
  MAIN.f14 = await T.upload(R4, 1, 'Round_1_broken.qbj', '{"match_teams": "no"}');
  MAIN.f9 = await T.upload(AX, 9, 'Round_9_extra_Game.json', 'not json');
  for (const b of [R1, R2, R3]) await T.startRound(b, 1);
  // a protest lodged in Room 3 before its game is in
  MAIN.live = tuProtest(2, p[2][0], p[2][0], p[2][1], 10, { tu: 10, neg: 0, bonus: 0 }, 'paris');
  await call(`/b/${R3.secret}/protests?round=1&g=live1`, { method: 'POST', body: JSON.stringify({ teams: p[2], protests: [MAIN.live] }) });
  return MAIN;
}

const liveRows = (pg) => pg.js(`[...document.querySelectorAll('.lrow')].map((r) => ({ room: r.querySelector('.lroom').textContent,
  game: r.querySelector('.lgame').textContent.replace(/\\s+/g, ' ').trim(),
  win: [...r.querySelectorAll('.lgame .win')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()),
  acts: [...r.querySelectorAll('.lacts a, .lacts button')].map((x) => x.textContent.trim()), mark: r.querySelector('.lmark').textContent.trim(),
  pie: !!r.querySelector('.lmark .upie'), title: r.querySelector('.lmark').title, warn: r.querySelector('.lmark').classList.contains('warn'),
  bye: r.classList.contains('bye') }))`);
const gridCell = (pg, room, n) => pg.js(`(() => { const tr = [...document.querySelectorAll('.ugrid tr')].find((r) => r.querySelector('td.uroom') && r.querySelector('td.uroom').textContent === ${q(room)});
  if (!tr) return null; const td = tr.querySelectorAll('td.ucell')[${n - 1}]; if (!td) return null; const e = td.firstElementChild;
  return { tag: e.tagName, text: e.textContent.trim(), cls: [...e.classList].filter((c) => c !== 'umark' && c !== 'sel').sort().join(' '), title: e.title, pie: !!e.querySelector('.upie') }; })()`);
const panelHead = (pg) => pg.js(`(() => { const p = document.querySelector('.cellpanel .phead'); return p ? p.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const panelFiles = (pg) => pg.js(`[...document.querySelectorAll('.cellpanel .pfile')].map((r) => ({
  line: r.querySelector('.pline > span').textContent.replace(/\\s+/g, ' ').trim(), old: r.classList.contains('old'),
  meta: r.querySelector('.pmeta').textContent.replace(/\\s+/g, ' ').trim(),
  hint: (r.querySelector('.warntext:not(.pmeta *)') || {}).textContent ? r.querySelector(':scope > .warntext').textContent.replace(/\\s+/g, ' ').trim() : '',
  acts: [...r.querySelectorAll('.pacts a, .pacts button, .pacts summary')].map((x) => x.textContent.trim()) }))`);
// the panel's "Show previous uploads (N)" / "Hide previous uploads", or ''
const prevBtn = (pg) => pg.js(`(document.querySelector('.cellpanel [data-prevuploads]') || {}).textContent || ''`);
// the older uploads behind Show previous uploads, shown
const showPrev = async (pg) => {
  if (/^Show/.test(await prevBtn(pg))) await pg.click('.cellpanel [data-prevuploads]');
  await pg.waitJs(`/^Hide/.test((document.querySelector('.cellpanel [data-prevuploads]') || {}).textContent || '')`, 'the previous uploads');
};
const openCell = async (pg, bid, n) => {
  if (!(await pg.js(`!!document.querySelector('.cellpanel') && !!document.querySelector('[data-cell="${bid}:${n}"].sel')`))) await pg.click(`[data-cell="${bid}:${n}"]`);
  await pg.waitJs(`!!document.querySelector('.cellpanel') && !!document.querySelector('[data-cell="${bid}:${n}"].sel')`, 'the cell ' + bid + ':' + n);
};
const addState = (pg) => pg.js(`({ open: !document.querySelector('#addpanel').hidden, room: document.querySelector('#addroom').value,
  round: document.querySelector('#addround').value, focus: (document.activeElement || {}).id || '',
  expanded: document.querySelector('#addtoggle').getAttribute('aria-expanded') })`);
const fileRow = async (T, pred) => (await T.detail()).files.find(pred);

section('main-live', '10 17 18 19 20 53: Live now, the start chips, the uploads grid, the cell panel and the Bye Room', async () => {
  const M = await mainDay();
  const { T, R1, R2, R3, R4, AX, p1 } = M;
  const pg = hub;
  await openLive(pg, T);
  const rows = await liveRows(pg);
  const row = (room) => rows.find((r) => r.room === room) || {};
  const same = (got, want) => Object.keys(want).every((k) => JSON.stringify(got[k]) === JSON.stringify(want[k]));
  await check('10 live now: a row per room, the Bye Room left out', () => JSON.stringify(rows.map((r) => r.room)) === JSON.stringify(['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Annex']) || rows.map((r) => r.room));
  await check('10 live now: a game in shows its score, the winner bold, its downloads, Edit, the protest link, and ✓', () =>
    same(row('Room 1'), { game: `${p1[0][0]} 120 – 100 ${p1[0][1]} protest`, win: [`${p1[0][0]} 120`], acts: ['qbj', 'game', 'Edit'],
      mark: '✓', title: 'Game in', warn: false, bye: false }) || row('Room 1'));
  await check('10 live now: an unfinished upload says "· on question 12 of 20", with a pie', () =>
    same(row('Room 2'), { game: `${p1[1][0]} 60 – 40 ${p1[1][1]} · on question 12 of 20`, pie: true,
      title: 'In progress: on question 12 of 20 at the last upload', warn: true }) || row('Room 2'));
  await check('10 live now: a room that started with nothing in shows the scheduled "A v B", ○ and an Upload button', () =>
    same(row('Room 3'), { game: `${p1[2][0]} v ${p1[2][1]}`, mark: '○', title: 'Started, not uploaded', acts: ['Upload'] }) || row('Room 3'));
  await check('10 live now: a room not started shows –, in orange (its only upload can\'t be read: shown as not started)', () =>
    same(row('Room 4'), { game: `${p1[3][0]} v ${p1[3][1]}`, mark: '–', title: 'Not started', warn: true, acts: ['Upload'] }) || row('Room 4'));
  await check('10 live now: a room with no game scheduled says "No game this round", with no mark and no Upload', () =>
    same(row('Annex'), { game: 'No game this round', mark: '', bye: true, acts: [] }) || row('Annex'));
  await check('10 live now: the header counts the scheduled games in, and those in progress', async () =>
    (await pg.ntext('.livemain section .sechead')) === 'Live now 1/4 in · 1 in progress' || await pg.ntext('.livemain section .sechead'));
  await check('18 start chips: one per room this round, filled once started, the Annex "· bye"', async () => {
    const chips = await pg.js(`[...document.querySelectorAll('.startlist .sroom')].map((c) => [c.textContent.trim(), c.className.replace('sroom', '').trim(), c.title])`);
    return JSON.stringify(chips) === JSON.stringify([['Room 1', 'on', 'Started'], ['Room 2', 'on', 'Started'], ['Room 3', 'on', 'Started'],
      ['Room 4', '', 'Not started'], ['Annex · bye', 'bye', 'No game this round']]) || chips;
  });
  await check('17 auto-advance: the rail says "Auto-advance 3/4 started", the bye not counted', async () =>
    (await pg.ntext('.railtoggle')) === 'Auto-advance 3/4 started' || await pg.ntext('.railtoggle'));

  // 19: the grid
  await check('19 grid: a column per round up to the last uploaded (9), the live round highlighted', async () => {
    const th = await pg.js(`[...document.querySelectorAll('.ugrid tr')][0] ? [...[...document.querySelectorAll('.ugrid tr')][0].querySelectorAll('th')].map((x) => x.textContent + (x.classList.contains('now') ? '*' : '')) : []`);
    return JSON.stringify(th) === JSON.stringify(['Room', '1*', '2', '3', '4', '5', '6', '7', '8', '9']) || th;
  });
  const cells = {
    'Room 1': await gridCell(pg, 'Room 1', 1), 'Room 2': await gridCell(pg, 'Room 2', 1), 'Room 3': await gridCell(pg, 'Room 3', 1),
    'Room 4': await gridCell(pg, 'Room 4', 1), Annex: await gridCell(pg, 'Annex', 1), Annex9: await gridCell(pg, 'Annex', 9), future: await gridCell(pg, 'Room 1', 2),
  };
  const cellIs = (c, want) => c && Object.keys(want).every((k) => c[k] === want[k]);
  await check('19 grid: a game in is ✓', () => cellIs(cells['Room 1'], { tag: 'BUTTON', text: '✓', cls: '', title: 'Game in' }) || cells['Room 1']);
  await check('19 grid: an unfinished upload is a pie, in orange', () => cellIs(cells['Room 2'], { tag: 'BUTTON', pie: true, cls: 'warn', title: 'In progress: on question 12 of 20 at the last upload' }) || cells['Room 2']);
  await check('19 grid: started with nothing in is ○', () => cellIs(cells['Room 3'], { tag: 'BUTTON', text: '○', cls: 'muted', title: 'Started, not uploaded' }) || cells['Room 3']);
  await check('19 grid: a file that can\'t be read is !, "1 file could not be read"', () => cellIs(cells['Room 4'], { tag: 'BUTTON', text: '!', cls: 'warn', title: '1 file could not be read' }) || cells['Room 4']);
  await check('19 grid: a bye round is blank, "No game this round", and not a button', () => cellIs(cells.Annex, { tag: 'SPAN', text: '', title: 'No game this round' }) || cells.Annex);
  await check('19 grid: a game file alone is ·, "Game file only"', () => cellIs(cells.Annex9, { tag: 'BUTTON', text: '·', cls: 'muted', title: 'Game file only' }) || cells.Annex9);
  await check('19 grid: a future round is blank and not a button', () => cellIs(cells.future, { tag: 'SPAN', text: '', title: '' }) || cells.future);
  await check('19 grid: the legend under it', async () =>
    (await pg.ntext('.legend')) === '✓ in · in progress · ○ started · – missing · ! can’t read · orange: needs a look' || await pg.ntext('.legend'));

  // 53: the Bye Room, made by the hub, nowhere on the Live view
  const d = await T.detail();
  const bye = d.buckets.find((b) => b.id === settingsOf(d).byeRoom);
  await check('53 bye room: the hub made it (settings.byeRoom names it)', () => !!bye && bye.room_name === 'Bye Room' || d.buckets.map((b) => b.room_name));
  await check('53 bye room: not in the grid, the chips, Add a game\'s or Record a forfeit\'s rooms', async () => {
    await pg.click('#fftoggle');
    await pg.waitJs(`!!document.querySelector('#ffpanel')`, 'the forfeit panel');
    const seen = await pg.js(`({ grid: [...document.querySelectorAll('.ugrid td.uroom')].map((x) => x.textContent),
      chips: [...document.querySelectorAll('.startlist .sroom')].map((x) => x.textContent),
      add: [...document.querySelectorAll('#addroom option')].map((x) => x.textContent),
      ff: [...document.querySelectorAll('#ffroom option')].map((x) => x.textContent) })`);
    await pg.click('#ffcancel');
    return !Object.values(seen).flat().some((x) => /Bye Room/.test(x)) && seen.add.length === 5 && seen.ff.length === 5 || seen;
  });
  await pg.reload();
  await pg.waitJs(`!!document.querySelector('.biground')`, 'the hub again');
  await check('53 bye room: made once (two loads, one Bye Room)', async () => (await T.detail()).buckets.filter((b) => /^Bye Room/.test(b.room_name)).length === 1);

  // 20: the cell panel
  await pg.click(`[data-cell="${R1.id}:1"]`);
  await pg.waitJs(`!!document.querySelector('.cellpanel')`, 'the cell panel');
  const f11 = await fileRow(T, (f) => f.id === M.f11.id);
  await check('20 panel: "Round 1 · Room 1", Add a game here, Close', async () => (await panelHead(pg)) === 'Round 1 · Room 1 Add a game here Close' || await panelHead(pg));
  await check('20 panel: the upload\'s game line, filename · kind · size, its protest pill, downloads and actions', async () => {
    const f = await panelFiles(pg);
    return (f.length === 1 && f[0].line === `${p1[0][0]} 120 – 100 ${p1[0][1]}`
      && f[0].meta === `${f11.filename} · combined · ${fmtBytes(f11.size)} 3 protests open`
      && JSON.stringify(f[0].acts) === JSON.stringify(['Edit in MODAQ', 'Fix stats', 'Download ▾', 'qbj', 'game', 'Both', 'Delete'])) || f;
  });
  await check('20 panel: it floats after the grid, in its box, just under its room\'s row', async () => {
    const p = await pg.js(`(() => { const pop = document.querySelector('#cellpop'); if (!pop) return null; const box = pop.parentElement;
      const row = document.querySelector('tr[data-urow="${R1.id}"]');
      return { cls: pop.className, box: box.className, after: pop.previousElementSibling && pop.previousElementSibling.contains(document.querySelector('table.ugrid')),
        inTable: !!pop.closest('table'), pos: getComputedStyle(pop).position, gap: Math.round(pop.getBoundingClientRect().top - row.getBoundingClientRect().bottom) }; })()`);
    return (p && p.cls === 'cellpop cellpanel' && p.box === 'ugridbox' && p.after && !p.inTable && p.pos === 'absolute' && p.gap === 4) || p;
  });
  await check('20 panel: the two-part upload\'s downloads sit in a closed "Download ▾" menu: qbj, game and Both', () =>
    pg.js(`(() => { const d = document.querySelector('.cellpanel .pacts details.fdl'); return !!d && !d.open && d.querySelector('summary').textContent.trim() === 'Download ▾'
      && JSON.stringify([...d.querySelectorAll('.fdlpanel a, .fdlpanel button')].map((x) => x.textContent.trim())) === '["qbj","game","Both"]'; })()`));
  await pg.click('[data-closecell]');
  await check('20 panel: Close closes it', () => pg.waitJs(`!document.querySelector('.cellpanel') && !document.querySelector('.umark.sel')`, 'closed'));
  await pg.click(`[data-cell="${R1.id}:1"]`);
  await pg.waitJs(`!!document.querySelector('.cellpanel')`, 'open again');
  await pg.click(`[data-cell="${R1.id}:1"]`);
  await check('20 panel: clicking its cell again closes it', () => pg.waitJs(`!document.querySelector('.cellpanel')`, 'closed by its cell'));
  await pg.click(`[data-cell="${R1.id}:1"]`);
  await pg.waitJs(`!!document.querySelector('.cellpanel')`, 'open again');
  await pg.S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await pg.S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await check('20 panel: Escape closes it', () => pg.waitJs(`!document.querySelector('.cellpanel')`, 'closed by Escape'));
  await pg.click(`[data-cell="${R1.id}:1"]`);
  await pg.waitJs(`!!document.querySelector('.cellpanel')`, 'open again');
  await pg.click(`[data-cell="${R4.id}:1"]`);
  await check('20 panel: one cell at a time', async () => {
    await pg.waitJs(`/Room 4/.test((document.querySelector('.cellpanel .phead') || {}).textContent || '')`, 'Room 4\'s cell');
    return (await pg.js(`document.querySelectorAll('.cellpanel').length`)) === 1;
  });
  await check('20 panel: a file that can\'t be read shows the reason, and only a raw Download', async () => {
    const f = await panelFiles(pg);
    return (f.length === 1 && f[0].line === 'Round_1_broken.qbj' && f[0].meta === `Round_1_broken.qbj · qbj · ${fmtBytes(M.f14 && 21)} · ${M.f14.error}`
      && JSON.stringify(f[0].acts) === JSON.stringify(['Download', 'Delete'])) || [f, M.f14];
  });
  pg.answers.push(true);
  await pg.click(`[data-delfile="${M.f14.id}"]`);
  await check('20 panel: with nothing left in the cell, "Nothing uploaded for this round yet."', () =>
    pg.waitJs(`/Nothing uploaded for this round yet\\./.test((document.querySelector('.cellpanel') || {}).textContent || '')`, 'the empty cell'));
  await pg.click('.cellpanel [data-addfor]');
  await check('20 panel: Add a game here opens Add a game on that room and round, at the file picker', async () => {
    await pg.waitJs(`!document.querySelector('#addpanel').hidden`, 'Add a game');
    const s = await addState(pg);
    return (s.room === String(R4.id) && s.round === '1' && s.focus === 'addfile' && s.expanded === 'true') || s;
  });
  await pg.click('#addcancel');
  await pg.waitJs(`document.querySelector('#addpanel').hidden`, 'closed');
  await pg.click(`[data-cell="${R3.id}:1"]`);
  await check('20 grid: an empty live cell opens Add a game on its room and round, at the file picker', async () => {
    await pg.waitJs(`!document.querySelector('#addpanel').hidden`, 'Add a game from the cell');
    const s = await addState(pg);
    return (s.room === String(R3.id) && s.round === '1' && s.focus === 'addfile' && !(await pg.exists('.cellpanel'))) || s;
  });
  await pg.click('#addcancel');
  await pg.waitJs(`document.querySelector('#addpanel').hidden`, 'closed');
  await pg.click(`.lrow [data-addfor="${R3.id}:1"]`);
  await check('10 live now: a room\'s Upload opens Add a game on that room and round, at the file picker', async () => {
    await pg.waitJs(`!document.querySelector('#addpanel').hidden`, 'Add a game from Upload');
    const s = await addState(pg);
    return (s.room === String(R3.id) && s.round === '1' && s.focus === 'addfile' && s.expanded === 'true') || s;
  });
  await pg.click('#addcancel');
  // the rail's first open protest is the one lodged before its game came in
  await check('32 rail: a protest lodged before the upload, "Game in progress"', async () => {
    const t = await pg.ntext('.pcompact');
    return t.startsWith(`R1 · Room 3 · TU 2 ${p1[2][0]}: paris Game in progress`) || t;
  });
  await check('33 drawer: its row says "Game in progress" instead of a score', () =>
    pg.js(`[...document.querySelectorAll('#protdrawer tr.protest')].some((r) => /Game in progress/.test(r.textContent) && /paris/.test(r.textContent))`));
});

section('main-uploads', '21 22 23 24 25 26 50: Add a game, moving, deleting and downloading uploads', async () => {
  const M = await mainDay();
  const { T, R1, R2, R3, R4, pair, p1 } = M;
  const pg = hub;
  await openLive(pg, T);
  // what Add a game says of the files picked
  await pg.click('#addtoggle');
  await pg.waitJs(`!document.querySelector('#addpanel').hidden`, 'Add a game');
  const listText = () => pg.ntext('#addlist');
  await pg.setFiles('#addfile', [writeFx(`Round_1_${p1[2][0]}_${p1[2][1]}.qbtd.json`, JSON.stringify(readerFile(quickGame(1, p1[2], gamesOf(p1[2]), [4, 2]))))]);
  await check('26 add a game: a reader upload is labelled "Reader upload", with no note', async () =>
    (await pg.waitJs(`/Reader upload/.test(document.querySelector('#addlist').textContent)`, 'the label')) && (await listText()) === `Round_1_${p1[2][0]}_${p1[2][1]}.qbtd.json Reader upload` || await listText());
  const g13 = quickGame(1, p1[2], gamesOf(p1[2]), [7, 3]); // 140 – 60
  const lone = writeFx(`Round_1_${p1[2][0]}_${p1[2][1]}.qbj`, JSON.stringify(g13));
  await pg.setFiles('#addfile', [lone]);
  await check('26 add a game: a match file alone gets the note that it can\'t be reopened in the reader', async () => {
    await pg.waitJs(`/Match file/.test(document.querySelector('#addlist').textContent)`, 'the label');
    const parts = await pg.js(`[...document.querySelectorAll('#addlist > div')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())`);
    return JSON.stringify(parts) === JSON.stringify([`Round_1_${p1[2][0]}_${p1[2][1]}.qbj Match file`,
      'Stats will count it. Without the game file it can’t be reopened in the reader.']) || parts;
  });
  await pg.fill('#addround', '3', ['input']);
  await pg.setFiles('#addfile', [writeFx('Round_1_a.qbj', JSON.stringify(quickGame(1, pair(1, 0), gamesOf(pair(1, 0)), [1, 1]))),
    writeFx('Round_2_b.qbj', JSON.stringify(quickGame(2, pair(2, 0), gamesOf(pair(2, 0)), [1, 1])))]);
  await check('26 add a game: several files naming other rounds: "The files say rounds 1 and 2. They will be counted as round 3." ' + CHG.addRound, async () => {
    await pg.waitJs(`!!document.querySelector('#addwarn')`, 'the warning');
    return (await pg.ntext('#addwarn')) === 'The files say rounds 1 and 2. They will be counted as round 3.' || await pg.ntext('#addwarn');
  });
  await pg.click('#addcancel');
  // Room 3's round 1 game, from its Upload button: the match file and its game file
  await pg.click(`.lrow [data-addfor="${R3.id}:1"]`);
  await pg.waitJs(`!document.querySelector('#addpanel').hidden`, 'Add a game');
  await pg.setFiles('#addfile', [writeFx(`Round_1_${p1[2][0]}_${p1[2][1]}_Game.json`, JSON.stringify(GAME_STORE)), lone]);
  await pg.waitJs(`document.querySelectorAll('#addlist .addfile').length === 2`, 'both listed');
  // 50: while Add a game is open the hub never redraws (the files picked would go)
  await markView(pg);
  await T.startRound(R4, 1);
  await pg.refresh();
  const asked = await quietFor(pg, 1000, isDetailGet(T.secret));
  await check('50 refresh: while Add a game is open, no refresh and no redraw', async () =>
    ((await viewKept(pg)) && asked.length === 0 && (await pg.js(`document.querySelectorAll('#addlist .addfile').length`)) === 2) || asked);
  await pg.watchTexts('#addgame');
  await pg.click('#addgame');
  await check('26 add a game: "2 files added to Room 3, round 1"', async () => { await msgIs(pg, '2 files added to Room 3, round 1', false); return true; });
  await check('26 add a game: the button counted the files as they went up', async () => (await pg.seenTexts()).some((x) => /^Uploading… [12] of 2$/.test(x)) || await pg.seenTexts());
  await check('26 add a game: the panel closes and that cell opens on the game, its MODAQ game file beside the match file, nothing behind Show previous uploads', async () => {
    await pg.waitJs(`document.querySelector('#addpanel').hidden && /Round 1 · Room 3/.test((document.querySelector('.cellpanel .phead') || {}).textContent || '')`, 'the cell');
    const f = await panelFiles(pg);
    return (f.length === 2 && f[0].line === `Round_1_${p1[2][0]}_${p1[2][1]}_Game.json` && f[1].line === `${p1[2][0]} 140 – 60 ${p1[2][1]}`
      && (await prevBtn(pg)) === '') || [f, await prevBtn(pg)];
  });
  await check('26 add a game: the match file went up before its game file, through Room 3', async () => {
    const mine = (await T.detail()).files.filter((f) => f.bucket_id === R3.id && f.round === 1).sort((a, b) => a.id - b.id);
    return JSON.stringify(mine.map((f) => f.kind)) === JSON.stringify(['qbj', 'game']) || mine;
  });
  {
    const got = await download(pg, `[...document.querySelectorAll('.cellpanel .pfile')].find((r) => /_Game\\.json/.test(r.querySelector('.pline').textContent)).querySelector('.pacts a').click(); true`);
    await check('25 downloads: a MODAQ game file added by hand gets "Download", the game file under its own name', () =>
      (got.name === `Round_1_${p1[2][0]}_${p1[2][1]}_Game.json` && JSON.stringify(JSON.parse(got.bytes.toString('utf8'))) === JSON.stringify(GAME_STORE)) || [got.name, got.bytes.toString('utf8').slice(0, 200)]);
  }
  await check('50 refresh: the change waiting all along shows once the panel is closed (4/4 started)', async () => {
    await pg.waitJs(`!document.querySelector('#viewbody').dataset.mark`, 'a redraw');
    return (await pg.ntext('.railtoggle')) === 'Auto-advance 4/4 started' || await pg.ntext('.railtoggle');
  });
  await check('10 live now: Room 3 is in, and the header counts it', async () =>
    (await pg.ntext('.livemain section .sechead')) === 'Live now 2/4 in · 1 in progress' && (await liveRows(pg))[2].mark === '✓' || await pg.ntext('.livemain section .sechead'));

  // one file, a file the Worker can't read, and a game filed under another round than it says
  const p20 = pair(2, 0);
  M.g21 = matchQbj({ round: 2, teams: p20, players: gamesOf(p20), lineups: { 0: [{ first: 1, players: [0, 1] }, { first: 11, players: [0, 1, 2] }] },
    plan: [[[0, 0, 10]], [[0, 1, 10]], [[1, 0, 10]], [[0, 0, -5], [1, 1, 10]], [[0, 1, 10]], null, null, null, null, null,
      [[0, 2, 10]], null, null, null, null, null, null, null, null, null] }); // 75 – 40
  const add = async (room, round, files) => {
    await pg.click('#addtoggle');
    await pg.waitJs(`!document.querySelector('#addpanel').hidden`, 'Add a game');
    await pg.fill('#addroom', String(room.id), ['change']);
    await pg.setFiles('#addfile', files);
    await pg.waitJs(`document.querySelectorAll('#addlist .addfile').length === ${files.length}`, 'the files listed');
    if (round !== null) await pg.fill('#addround', String(round), ['input']);
  };
  await add(R1, 2, [writeFx(`Round_2_${p20[0]}_${p20[1]}.qbj`, JSON.stringify(M.g21))]);
  await pg.click('#addgame');
  await check('26 add a game: one file: "<file> added to <room>, round N"', async () => { await msgIs(pg, `Round_2_${p20[0]}_${p20[1]}.qbj added to Room 1, round 2`, false); return true; });
  await add(R4, 2, [writeFx('Round_2_bad.qbj', 'nope')]);
  await pg.click('#addgame');
  const bad = await until(() => fileRow(T, (f) => f.filename === 'Round_2_bad.qbj'), 'the bad file stored');
  await check('26 add a game: a file the Worker can\'t read is named with the reason, in red, and kept', async () => {
    await msgIs(pg, `Round_2_bad.qbj: ${bad.error}`, true);
    return !!bad.error;
  });
  await dismiss(pg);
  const p51 = pair(5, 1);
  M.g52 = quickGame(1, p51, gamesOf(p51), [5, 4]); // a round 5 game whose file says round 1
  await add(R2, null, [writeFx(`Round_1_${p51[0]}_${p51[1]}.qbj`, JSON.stringify(M.g52))]);
  await check('26 add a game: Round fills in with the round the match file names ' + CHG.addRound, () =>
    pg.waitJs(`document.querySelector('#addround').value === '1' && !document.querySelector('#addwarn')`, 'round 1 filled in'));
  await pg.fill('#addround', '5', ['input']);
  await check('26 add a game: another round typed in: "The match file says round 1. It will be counted as round 5." ' + CHG.addRound, async () => {
    await pg.waitJs(`!!document.querySelector('#addwarn')`, 'the warning');
    return (await pg.ntext('#addwarn')) === 'The match file says round 1. It will be counted as round 5.' || await pg.ntext('#addwarn');
  });
  await pg.click('#addgame');
  await soft(msgIs(pg, `Round_1_${p51[0]}_${p51[1]}.qbj added to Room 2, round 5`, false));
  const f52 = await soft(until(() => fileRow(T, (f) => f.filename === `Round_1_${p51[0]}_${p51[1]}.qbj`), 'the round 5 game'));
  await check('26 add a game: filed under round 5, the stored file says round 5 ' + CHG.filedRound, async () =>
    (!!f52 && f52.round === 5 && (await T.file(f52)).body._round === 5) || (f52 ? [f52.round, (await T.file(f52)).body._round] : 'not uploaded'));
  if (!f52) {
    // (an older hub: the game goes up as the files say, so the rest of the day matches)
    await pg.click('#addcancel');
    await T.upload(R2, 5, `Round_1_${p51[0]}_${p51[1]}.qbj`, M.g52);
  }
  M.f52 = f52;

  // 24: a newer upload of Room 2's game, then deleted: the older one counts again
  M.g12b = quickGame(1, p1[1], gamesOf(p1[1]), [9, 4]); // 180 – 80, finished
  const f12b = await T.upload(R2, 1, `Round_1_${p1[1][0]}_${p1[1][1]}.qbtd.json`, readerFile(M.g12b));
  await openLive(pg, T);
  await openCell(pg, R2.id, 1);
  await check('20 panel: only the newest upload of a game shows, the older one behind "Show previous uploads (1)"', async () => {
    const f = await panelFiles(pg);
    return (f.length === 1 && f[0].line === `${p1[1][0]} 180 – 80 ${p1[1][1]}` && !f[0].old && (await prevBtn(pg)) === 'Show previous uploads (1)') || [f, await prevBtn(pg)];
  });
  await showPrev(pg);
  await check('20 panel: Show previous uploads lists them newest first, the older one of the same game "superseded", and reads "Hide previous uploads"', async () => {
    const f = await panelFiles(pg);
    return (f.length === 2 && f[0].line === `${p1[1][0]} 180 – 80 ${p1[1][1]}` && !f[0].old
      && f[1].line === `${p1[1][0]} 60 – 40 ${p1[1][1]} · superseded` && f[1].old && (await prevBtn(pg)) === 'Hide previous uploads') || [f, await prevBtn(pg)];
  });
  await pg.click('.cellpanel [data-prevuploads]');
  await check('20 panel: Hide previous uploads puts them away again', async () => {
    await pg.waitJs(`/^Show/.test((document.querySelector('.cellpanel [data-prevuploads]') || {}).textContent || '')`, 'hidden again');
    return (await panelFiles(pg)).length === 1 && (await prevBtn(pg)) === 'Show previous uploads (1)';
  });
  await showPrev(pg);
  await check('10 live now: the newest upload counts (no longer in progress)', async () =>
    (await liveRows(pg))[1].game === `${p1[1][0]} 180 – 80 ${p1[1][1]}`);
  let n0 = pg.dialogs.length;
  const r0 = pg.reqs.length; // what the page asks the Worker from the click on: Cancel sends no delete
  pg.answers.push(false);
  await pg.click(`[data-delfile="${f12b.id}"]`);
  await until(() => pg.dialogs.length > n0, 'the question');
  await sleep(1000);
  const delAsks = pg.reqs.slice(r0).filter((x) => x.method === 'DELETE' && x.url.includes('/files/'));
  await check('24 delete: asks "Delete this file?", and Cancel keeps it', async () =>
    (pg.dialogs[n0] === 'Delete this file?' && delAsks.length === 0 && !!(await fileRow(T, (f) => f.id === f12b.id))
      && (await panelFiles(pg)).length === 2) || { dialog: pg.dialogs[n0], deletes: delAsks.length });
  pg.answers.push(true);
  await pg.click(`[data-delfile="${f12b.id}"]`);
  await check('24 delete: OK removes it, and the earlier upload counts again', async () => {
    await pg.waitJs(`document.querySelectorAll('.cellpanel .pfile').length === 1`, 'one file left');
    const f = await panelFiles(pg);
    return (!(await fileRow(T, (x) => x.id === f12b.id)) && f[0].line === `${p1[1][0]} 60 – 40 ${p1[1][1]}` && !f[0].old
      && (await liveRows(pg))[1].game === `${p1[1][0]} 60 – 40 ${p1[1][1]} · on question 12 of 20`) || f;
  });

  // 20 + 22: two different games in Room 4's round 3 cell; one belongs to Room 1
  const p33 = pair(3, 3), p30 = pair(3, 0);
  M.g33 = quickGame(3, p33, gamesOf(p33), [4, 6]);
  M.g30 = quickGame(3, p30, gamesOf(p30), [8, 2]);
  await T.upload(R4, 3, `Round_3_${p33[0]}_${p33[1]}.qbj`, M.g33);
  const stray = await T.upload(R4, 3, `Round_3_${p30[0]}_${p30[1]}.qbj`, M.g30);
  await openLive(pg, T);
  await openCell(pg, R4.id, 3);
  await check('20 panel: two different games in one cell: "2 games", in orange', async () =>
    (await panelHead(pg)) === 'Round 3 · Room 4 2 games Add a game here Close' && await pg.exists('.cellpanel .phead .warntext') || await panelHead(pg));
  await check('22 scheduled elsewhere: the game Room 1 was to play says so, with Move it there', async () => {
    const f = await panelFiles(pg);
    return f.some((x) => x.line.startsWith(p30[0]) && x.hint === 'Scheduled in Room 1. Move it there') || f;
  });
  await pg.click(`[data-moveto="${stray.id}:${R1.id}"]`);
  await check('22 scheduled elsewhere: Move it there moves it, "Moved to Room 1"', async () => {
    await msgIs(pg, 'Moved to Room 1', false);
    return (await until(() => fileRow(T, (f) => f.id === stray.id && f.bucket_id === R1.id), 'moved')) && true;
  });
  await check('22 scheduled elsewhere: the grid follows (✓ in both rooms)', () =>
    pg.waitJs(`(document.querySelector('[data-cell="${R1.id}:3"]') || {}).textContent.trim() === '✓' && document.querySelector('[data-cell="${R4.id}:3"]').textContent.trim() === '✓'`, 'the grid'));

  // 23: a game filed under the wrong round, moved to its own
  const p31 = pair(3, 1);
  M.g31 = quickGame(2, p31, gamesOf(p31), [6, 6]);
  const wrong = await T.upload(R2, 2, `Round_2_${p31[0]}_${p31[1]}.qbj`, M.g31);
  await openLive(pg, T);
  await openCell(pg, R2.id, 2);
  await check('23 move round: Move files is off until another round is picked', async () => {
    const off1 = await pg.js(`document.querySelector('[data-moveround="${wrong.id}"]').disabled`);
    const opts = await pg.js(`[...document.querySelector('[data-fileround="${wrong.id}"]').options].map((o) => o.textContent)`);
    await pg.fill(`[data-fileround="${wrong.id}"]`, '3', ['change']);
    const off2 = await pg.js(`document.querySelector('[data-moveround="${wrong.id}"]').disabled`);
    return (off1 && !off2 && JSON.stringify(opts) === JSON.stringify(Array.from({ length: 7 }, (_, i) => 'Round ' + (i + 1)))) || [off1, off2, opts];
  });
  n0 = pg.dialogs.length;
  pg.answers.push(false);
  await pg.click(`[data-moveround="${wrong.id}"]`);
  await until(() => pg.dialogs.length > n0, 'the question');
  await check('23 move round: asks first, in those words', () => pg.dialogs[n0] === 'Move this game from round 2 to round 3? Its stats, buzzpoints and the public page will count it as round 3. Please only do this if the game was filed under the wrong round.' || pg.dialogs[n0]);
  await check('23 move round: Cancel keeps it where it is', async () => (await fileRow(T, (f) => f.id === wrong.id)).round === 2);
  await pg.watchTexts(`[data-moveround="${wrong.id}"]`);
  pg.answers.push(true);
  await pg.click(`[data-moveround="${wrong.id}"]`);
  await check('23 move round: OK says "Moved to round 3"', async () => { await msgIs(pg, 'Moved to round 3', false); return true; });
  await check('23 move round: the button read "Moving…" meanwhile', async () => (await pg.seenTexts()).includes('Moving…') || await pg.seenTexts());
  await check('23 move round: the open panel follows the game to round 3', () =>
    pg.waitJs(`/^Round 3 · Room 2/.test((document.querySelector('.cellpanel .phead') || {}).textContent.replace(/\\s+/g, ' ').trim())`, 'round 3\'s cell'));
  await check('23 move round: the Worker files it under round 3, and the stored file says so', async () => {
    const f = await fileRow(T, (x) => x.id === wrong.id);
    return (f.round === 3 && (await T.file(f)).body._round === 3) || f;
  });

  // 25: the per-file downloads
  await openCell(pg, R1.id, 1);
  const dlLink = (label) => `[...document.querySelectorAll('.cellpanel .pacts a')].find((a) => a.textContent === ${q(label)}).click(); true`;
  {
    const got = await download(pg, dlLink('qbj'));
    const j = JSON.parse(got.bytes.toString('utf8'));
    await check('25 downloads: a reader upload\'s "qbj" is MODAQ\'s match file, named Round_1_<A>_<B>.qbj', () =>
      (got.name === `Round_1_${p1[0][0]}_${p1[0][1]}.qbj` && j._round === 1 && j.match_teams.map((m) => m.team.name).join() === p1[0].join()) || got.name);
    const g = await download(pg, dlLink('game'));
    await check('25 downloads: its "game" is MODAQ\'s game file, Round_1_<A>_<B>_Game.json', () =>
      (g.name === `Round_1_${p1[0][0]}_${p1[0][1]}_Game.json` && JSON.stringify(JSON.parse(g.bytes.toString('utf8'))) === JSON.stringify(GAME_STORE)) || g.name);
    await check('25 downloads: never the combined upload itself', () => !/qbtd/.test(got.name + g.name) && !('qbj' in JSON.parse(g.bytes.toString('utf8'))));
    await pg.click('.cellpanel details.fdl summary');
    await pg.waitJs(`document.querySelector('.cellpanel details.fdl').open`, 'the Download menu');
    const z = await download(pg, `document.querySelector('.cellpanel [data-dlboth]').click(); true`);
    const ents = await readZip(new Uint8Array(z.bytes));
    const ent = (n) => Buffer.from((ents.find((e) => e.name === n) || { data: new Uint8Array() }).data).toString('utf8');
    await check('25 downloads: Download ▾ > Both is one zip, named after the upload, with the two files under MODAQ\'s names', () =>
      (z.name === M.f11.filename.replace(/\.qbtd\.json$/, '') + '.zip'
        && JSON.stringify(ents.map((e) => e.name).sort()) === JSON.stringify([got.name, g.name].sort())
        && ent(got.name) === got.bytes.toString('utf8') && ent(g.name) === g.bytes.toString('utf8')) || [z.name, ents.map((e) => e.name)]);
    await check('25 downloads: and the menu closes after', () => pg.waitJs(`!document.querySelector('.cellpanel details.fdl').open`, 'the menu closed'));
  }
  await openCell(pg, R1.id, 2);
  {
    const got = await download(pg, dlLink('Download'));
    await check('25 downloads: a .qbj added by hand gets "Download", the file under its own name', () =>
      (got.name === `Round_2_${p20[0]}_${p20[1]}.qbj` && JSON.parse(got.bytes.toString('utf8')).match_teams[0].team.name === p20[0]) || got.name);
  }
  await openCell(pg, R4.id, 2);
  {
    const got = await download(pg, `[...document.querySelectorAll('.cellpanel .pfile')].find((r) => /Round_2_bad/.test(r.textContent)).querySelector('.pacts a').click(); true`);
    await check('25 downloads: a file that can\'t be read comes down as it was uploaded', () => (got.name === 'Round_2_bad.qbj' && got.bytes.toString('utf8') === 'nope') || got.name);
  }
  await check('25 downloads: Live now has the same links for a game in', async () =>
    JSON.stringify((await liveRows(pg))[0].acts) === JSON.stringify(['qbj', 'game', 'Edit']));

  // 21: a room picked from the upload's own list; the round's public data follows
  await call(T.A, { method: 'POST', json: { published: true } });
  const shardRoom = (round, id) => pubShardRoom(T, round, id);
  await check('21 room list: before the move, the public round data has the game in Room 2', async () =>
    (await untilTicked(async () => (await shardRoom(3, wrong.id)) === 'Room 2', 'round 3 public')) || await shardRoom(3, wrong.id));
  await openLive(pg, T);
  await openCell(pg, R2.id, 3);
  await pg.fill(`select[data-movefile="${wrong.id}"]`, String(M.AX.id), ['change']);
  await check('21 room list: picking the Annex moves it there, "Moved to Annex"', async () => {
    await msgIs(pg, 'Moved to Annex', false);
    return (await fileRow(T, (f) => f.id === wrong.id)).bucket_id === M.AX.id;
  });
  await check('21 room list: after the rebuild the public round data has it in the Annex, without a new game ' + CHG.pubCorrected, async () =>
    (await untilTicked(async () => (await shardRoom(3, wrong.id)) === 'Annex', 'the moved room')) || await shardRoom(3, wrong.id));
  await call(`${T.A}/buckets/${M.AX.id}`, { method: 'POST', json: { room_name: 'Annex West' } });
  await check('21 room rename: the public round data names the room\'s new name, without a new game ' + CHG.pubCorrected, async () =>
    (await untilTicked(async () => (await shardRoom(3, wrong.id)) === 'Annex West', 'the renamed room')) || await shardRoom(3, wrong.id));
  await call(`${T.A}/buckets/${M.AX.id}`, { method: 'POST', json: { room_name: 'Annex' } });
  await call(`${T.A}/files/${wrong.id}`, { method: 'POST', json: { bucket_id: R2.id } });
});

const drawerRows = (pg) => pg.js(`[...document.querySelectorAll('#protdrawer tr.protest')].map((r) => ({ ruled: r.classList.contains('ruled'),
  cells: [...r.cells].slice(0, 5).map((c) => c.innerText.replace(/\\s+/g, ' ').trim()),
  ruling: (r.querySelector('[data-rule]') || {}).value, note: (r.querySelector('[data-rnote]') || {}).value,
  who: [...r.querySelectorAll('.who, .followup')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()) }))`);
const railProtest = (pg) => pg.js(`(() => { const p = document.querySelector('.pcompact');
  return p ? [...p.querySelectorAll(':scope > span')].map((x) => (x.classList.contains('warntext') ? '!' : '') + x.textContent.replace(/\\s+/g, ' ').trim()) : null; })()`);
const clockIn = (pg, ms) => pg.js(`new Date(${ms}).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })`);
const setDrawer = async (pg, open) => {
  if ((await pg.js(`document.querySelector('#protdrawer').open`)) !== open) await pg.click('#protdrawer > summary');
  await pg.waitJs(`document.querySelector('#protdrawer').open === ${open}`, 'the drawer ' + (open ? 'open' : 'closed'));
};
// a change at the Worker the hub will see on its next refresh, and that refresh
const bumpAndRefresh = async (pg, T) => {
  await markView(pg);
  await call(T.A, { method: 'POST', json: { name: (await T.detail()).tournament.name } });
  await pg.refresh();
  await pg.waitJs(`!document.querySelector('#viewbody').dataset.mark`, 'the redraw');
};

section('main-protests', '32 33 34 35: protests in the rail and the drawer, rulings, and the links to them', async () => {
  const M = await mainDay();
  const { T, R1, R2, p1, pair } = M;
  const pg = hub;
  const [A, B] = p1[0]; // Room 1's round 1 game, A 120 – 100 B, with P1 (can flip), P2 and P3
  const key = (p, teams = [A, B]) => [1, 'tu' + p.q, ...[...teams].sort()].map(encodeURIComponent).join('/');
  const [k1, k2, k3] = M.P.map((p) => key(p));
  const rulings = async () => JSON.parse((await T.detail()).tournament.rulings || '{}');
  await openLive(pg, T);
  await check('33 drawer: opens by itself while a protest is open', () => pg.js(`document.querySelector('#protdrawer').open`));
  await check('33 drawer: the summary names the newest open one, and that it can flip the result', async () =>
    (await pg.ntext('#protdrawer > summary .muted')) === `3 open · R1 Room 1: ${B} protests TU 3 · can flip the result` || await pg.ntext('#protdrawer > summary .muted'));
  await check('32 rail: "Protests 3" and an All button', async () => (await pg.ntext('.liverail .railhead')) === 'Protests 3 All' || await pg.ntext('.liverail .railhead'));
  await check('32 rail: the newest open protest, its team\'s answer, and "Can flip" in orange with the score if upheld', async () =>
    JSON.stringify(await railProtest(pg)) === JSON.stringify(['R1 · Room 1 · TU 3', `${B}: treaty of utrecht`, `!Can flip · ${A} 120 – 125 ${B} if upheld`]) || await railProtest(pg));
  let rows = await drawerRows(pg);
  await check('33 drawer: each row has round, room and teams, question and buzz word, team, answer and reason', () =>
    JSON.stringify(rows[0] && rows[0].cells.slice(0, 4)) === JSON.stringify(['1', `Room 1 ${A} v ${B}`, 'TU 3 word 12', `${B} answered treaty of utrecht The answer line accepts it`]) || rows[0]);
  await check('33 drawer: the score, "Can flip the result", what it would be if upheld, and the swing', () =>
    rows[0].cells[4] === `${A} 120 ${B} 100 Can flip the result If upheld: ${A} 120 – ${B} 125 +25 ${B}: 0 neg back, 10 tossup, 15 bonus` || rows[0].cells[4]);
  await check('33 drawer: a protest that can\'t change the winner says "Result stands"', () =>
    rows[1].cells[4] === `${A} 120 ${B} 100 Result stands If upheld: ${A} 130 – ${B} 100 +10 ${A}: 0 neg back, 10 tossup, 0 bonus` || rows[1].cells[4]);

  // the drawer remembers the TD closing it, and opening it again, across redraws
  await setDrawer(pg, false);
  await bumpAndRefresh(pg, T);
  await check('33 drawer: closed by the TD, it stays closed through a redraw', () => pg.js(`!document.querySelector('#protdrawer').open`));
  await setDrawer(pg, true);
  await bumpAndRefresh(pg, T);
  await check('33 drawer: opened again, it stays open', () => pg.js(`document.querySelector('#protdrawer').open`));

  // 35: each link to the drawer opens it and scrolls to it (a short window, so the drawer starts out of view)
  await pg.S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 520, deviceScaleFactor: 1, mobile: false });
  const settle = () => until(async () => { const a = await pg.js('window.scrollY'); await sleep(150); return a === await pg.js('window.scrollY'); }, 'the scroll to settle');
  for (const [what, sel] of [['the Live now row\'s "protest"', '.lrow [data-goto="protdrawer"]'], ['the rail\'s All', '.railhead [data-goto="protdrawer"]'],
    ['the cell panel\'s "3 protests open"', '.cellpanel .pill[data-goto="protdrawer"]']]) {
    await settle();
    await setDrawer(pg, false);
    if (what.includes('cell')) await openCell(pg, R1.id, 1);
    await pg.js(`window.scrollTo({ top: 0, behavior: 'instant' }); true`);
    await pg.waitJs(`window.scrollY === 0 && document.querySelector('#protdrawer').getBoundingClientRect().top > window.innerHeight`, 'the drawer out of view');
    await pg.click(sel);
    await check(`35 links: ${what} opens the drawer and scrolls to it`, () => pg.waitJs(`(() => { const d = document.querySelector('#protdrawer');
      const top = d.getBoundingClientRect().top; return d.open && window.scrollY > 0 && top > -5 && top < window.innerHeight - 40; })()`, 'the drawer in view'));
  }
  await settle();
  await pg.S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await pg.js(`window.scrollTo({ top: 0, behavior: 'instant' }); true`);

  // 34: another tab rules P2 meanwhile; this tab rules P1 from the rail
  const at2 = Date.now();
  await call(T.A, { method: 'POST', json: { rulings: { [k2]: { r: 'denied', note: 'From the other tab', at: at2 } }, rulings_prev: { [k2]: null } } });
  await dismiss(pg);
  await pg.fill('.pcompact [data-rule]', 'upheld', ['change']);
  await check('34 ruling: "Saved: Upheld"', async () => { await msgIs(pg, 'Saved: Upheld', false); return true; });
  await until(async () => ((await rulings())[k1] || {}).r === 'upheld', 'the ruling saved');
  let r = await rulings();
  await check('34 ruling: saved with its time and no note, and nothing sent to the room', () => (r[k1] && r[k1].r === 'upheld' && r[k1].note === '' && Number.isFinite(r[k1].at)) || r);
  await check('34 ruling: a ruling made in another tab meanwhile is kept ' + CHG.settings2tabs, () => (r[k2] && r[k2].r === 'denied' && r[k2].note === 'From the other tab') || r);
  await check('32 rail: the next open protest, "Result stands", not in orange', async () =>
    JSON.stringify(await railProtest(pg)) === JSON.stringify(['R1 · Room 1 · TU 7', `${A}: ghent`, `Result stands · ${A} 130 – 100 ${B} if upheld`]) || await railProtest(pg));
  rows = await drawerRows(pg);
  const at1 = r[k1].at;
  await check('33 drawer: a ruled row is greyed, says the ruling and its time, and waits for the corrected game', async () => {
    const row = rows.find((x) => x.cells[2] === 'TU 3 word 12');
    return (row && row.ruled && row.ruling === 'upheld' && JSON.stringify(row.who) === JSON.stringify([`Upheld ${await clockIn(pg, at1)}`,
      'Waiting for Room 1 to upload the corrected game'])) || row;
  });
  await dismiss(pg);
  await pg.fill(`#protdrawer [data-rnote="${k1}"]`, 'Checked the answer line', ['change']);
  await msgIs(pg, 'Saved: Upheld', false);
  r = await until(async () => { const x = await rulings(); return x[k1] && x[k1].note === 'Checked the answer line' && x; }, 'the note saved').catch(() => null) || await rulings();
  await check('34 ruling: a note saved with an unchanged ruling keeps the ruling\'s time', () => (r[k1].note === 'Checked the answer line' && r[k1].at === at1) || r[k1]);
  await bumpAndRefresh(pg, T);
  await check('32 rail: after a refresh the other tab\'s ruling shows too: one open, P3 ' + CHG.settings2tabs, async () =>
    (await pg.ntext('.liverail .railhead')) === 'Protests 1 All' && (await railProtest(pg))[0] === 'R1 · Room 1 · TU 9' || [await pg.ntext('.liverail .railhead'), await railProtest(pg)]);

  // a save that fails: the error shows, and this tab's copy goes back
  await withRules(pg, [{ stage: 'Request', times: 1, test: (m, u) => m === 'POST' && u === BASE + T.A,
    act: () => ({ status: 500, body: { error: 'Something went wrong on the server. Please try again.' } }) }], async () => {
    await pg.fill(`#protdrawer [data-rule="${k3}"]`, 'withdrawn', ['change']);
    await check('34 ruling: a save that fails says so, in red', async () => { await msgIs(pg, 'Something went wrong on the server. Please try again.', true); return true; });
  });
  await dismiss(pg);
  await pg.fill(`#protdrawer [data-rnote="${k2}"]`, 'Second look', ['change']);
  // any "Saved: …": where the other tab's ruling was lost, the note goes up with "Open"
  await soft(pg.waitJs(`/^Saved: /.test(document.querySelector('#msg').textContent)`, 'the note saved'));
  r = await until(async () => { const x = await rulings(); return x[k2] && x[k2].note === 'Second look' && x; }, 'the second note').catch(() => null) || await rulings();
  await check('34 ruling: the failed ruling is not sent with the next save', () => (!r[k3] && r[k2].note === 'Second look' && r[k1].r === 'upheld') || r);
  // and this tab does not show it as made: once the next save redraws, its row is Open again
  await check('34 ruling: after the next save, the failed ruling\'s row reads Open again, as the Worker has it', async () =>
    (await pg.waitJs(`document.querySelector('#protdrawer [data-rule="${k3}"]').value === 'open'`, 'the row back to Open').catch(() => false))
      || (await drawerRows(pg)).map((x) => x.ruling));

  // the corrected game comes in, with the upheld protest in it again
  const fixed = await T.upload(R1, 1, `Round_1_${A}_${B}.qbtd.json`, readerFile(M.g11, { protests: [M.P[0]] }));
  M.f11b = fixed;
  await bumpAndRefresh(pg, T);
  rows = await drawerRows(pg);
  await check('33 drawer: the corrected upload\'s protest says "Corrected game received"', () => {
    const now = rows.find((x) => x.cells[2] === 'TU 3 word 12' && !/Before the correction/.test(x.cells[1]));
    return (now && now.who.includes('Corrected game received') && !now.who.some((w) => /Waiting/.test(w))) || rows;
  });
  await check('33 drawer: the superseded upload keeps its ruled protests, marked "Before the correction"', () =>
    rows.filter((x) => /Before the correction/.test(x.cells[1])).map((x) => x.cells[2]).join() === 'TU 3 word 12,TU 7 word 12' || rows.map((x) => x.cells.slice(1, 3)));
  await check('33 drawer: and its unruled protest drops out', () => !rows.some((x) => x.cells[2] === 'TU 9 word 12') || rows);
  await check('33 drawer + rail: nothing open ' + CHG.settings2tabs, async () =>
    (await pg.ntext('#protdrawer > summary .muted')) === 'Nothing open' && /Nothing open/.test(await pg.ntext('.liverail')));
  await openCell(pg, R1.id, 1);
  await showPrev(pg);
  await check('20 panel: the protest pills: "1 protest · ruled" on the correction, "3 protests · superseded" on the original', async () => {
    const f = await panelFiles(pg);
    return (/1 protest · ruled$/.test(f[0].meta) && /3 protests · superseded$/.test(f[1].meta)) || f.map((x) => x.meta);
  });
  // reopened: no note and Open takes the ruling away
  await setDrawer(pg, true);
  await dismiss(pg);
  await pg.fill(`#protdrawer [data-rnote="${k1}"]`, '', ['change']);
  await soft(msgIs(pg, 'Saved: Upheld', false));
  await soft(until(async () => ((await rulings())[k1] || {}).note === '', 'the note cleared'));
  await pg.fill(`#protdrawer [data-rule="${k1}"]`, 'open', ['change']);
  await check('34 ruling: Open with no note says "Reopened", and the ruling is gone', async () => {
    await msgIs(pg, 'Reopened', false);
    return !!(await until(async () => !(await rulings())[k1], 'the ruling gone').catch(() => false));
  });
  // a protest in a bare .qbj, read from its notes: no swing known
  const p41 = pair(4, 1);
  const bare = quickGame(4, p41, gamesOf(p41), [5, 5], { notes: `Tossup protest on tossup #5. Team "${p41[1]}" protested because of this reason: "Accept it".` });
  await T.upload(R2, 4, `Round_4_${p41[0]}_${p41[1]}.qbj`, bare);
  await bumpAndRefresh(pg, T);
  rows = await drawerRows(pg);
  await check('33 drawer: a protest from a bare .qbj says "Swing unknown…", with no pill', () => {
    const row = rows.find((x) => x.cells[0] === '4');
    return (row && row.cells[4] === `${p41[0]} 100 ${p41[1]} 100 Swing unknown: uploaded as a bare qbj, so the buzz position is missing`) || row;
  });
  await check('32 rail: the newest open protest first (round 4), with no score line for an unknown swing', async () =>
    JSON.stringify(await railProtest(pg)) === JSON.stringify(['R4 · Room 2 · TU 5', p41[1]]) || await railProtest(pg));
});

section('main-fix', '27 29 30 31: Fix stats, Edit in MODAQ\'s errors, and the not-started gate', async () => {
  const M = await mainDay();
  const { T, R1, R2, R3, R4, pair, p1 } = M;
  const pg = hub;
  const [A2, B2] = pair(2, 0);
  const f21 = await until(() => fileRow(T, (f) => f.filename === `Round_2_${A2}_${B2}.qbj` && f.bucket_id === R1.id), 'Room 1\'s round 2 game');
  const tables = () => pg.js(`[...document.querySelectorAll('.fixbuzz table.fxteam')].map((t) => ({ head: [...t.rows[0].cells].map((c) => c.textContent.trim()),
    rows: [...t.rows].slice(1).map((r) => [r.classList.contains('chg') ? '*' : ''].concat([...r.cells].slice(0, -1).map((c) => {
      const w = c.querySelector('.was'); return w ? w.textContent + '>' + c.textContent.slice(w.textContent.length) : c.textContent.trim(); }))) }))`);
  const saveOn = () => pg.js(`!!document.querySelector('#fixsave') && !document.querySelector('#fixsave').disabled`);
  const warn = () => pg.js(`[...document.querySelectorAll('.fixbuzz > .warntext')].map((x) => x.textContent.trim()).join(' ')`);
  await openLive(pg, T);
  await openCell(pg, R1.id, 2);
  await pg.watchTexts('.fixbuzz');
  await pg.click(`[data-fixbuzz="${f21.id}"]`);
  await pg.waitJs(`!!document.querySelector('[data-fswap="0:0"]')`, 'Fix stats');
  await check('30 fix stats: "Loading the game…" first', async () => (await pg.seenTexts())[0] === 'Loading the game…' || await pg.seenTexts());
  const tabs = () => pg.js(`[...document.querySelectorAll('[data-fixtab]')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : ''))`);
  await check('30 fix stats: Swap player buzzes, All buzzes and Lineups tabs, for a game with buzzes', async () =>
    JSON.stringify(await tabs()) === '["Swap player buzzes*","All buzzes","Lineups"]' || await tabs());
  await check('30 fix stats: a table per team, counts per value, points and tossups heard', async () => {
    const t = await tables();
    const want = [{ head: [A2, '10', '-5', 'Pts', 'TUH', ''], rows: [['', A2 + ' 1', '1', '1', '5', '20'], ['', A2 + ' 2', '2', '0', '20', '20'], ['', A2 + ' 3', '1', '0', '10', '20']] },
      { head: [B2, '10', '-5', 'Pts', 'TUH', ''], rows: [['', B2 + ' 1', '1', '0', '10', '20'], ['', B2 + ' 2', '1', '0', '10', '20'], ['', B2 + ' 3', '0', '0', '0', '20']] }];
    return JSON.stringify(t) === JSON.stringify(want) || t;
  });
  await check('30 fix stats: Save correction is off until something changes', async () => !(await saveOn()));
  await check('30 fix stats: a player can swap with a teammate, or with a roster player "Not in this game"', async () => {
    const o = await pg.js(`(() => { const s = document.querySelector('[data-fswap="0:0"]'); return { first: s.options[0].textContent,
      mates: [...s.children].filter((x) => x.tagName === 'OPTION').map((x) => x.value), group: (s.querySelector('optgroup') || {}).label,
      roster: [...s.querySelectorAll('optgroup option')].map((x) => x.value) }; })()`);
    return JSON.stringify(o) === JSON.stringify({ first: 'Swap with', mates: ['', A2 + ' 2', A2 + ' 3'], group: 'Not in this game', roster: [A2 + ' Sub'] }) || o;
  });
  await pg.fill('[data-fswap="0:0"]', A2 + ' 2', ['change']);
  await check('30 fix stats: a teammate swap shows the old counts beside the new, the rows marked', async () => {
    await pg.waitJs(`!!document.querySelector('.fixbuzz .was')`, 'the swap shown');
    const t = (await tables())[0].rows;
    return JSON.stringify(t) === JSON.stringify([['*', A2 + ' 1', '1>2', '1>0', '5>20', '20'], ['*', A2 + ' 2', '2>1', '0>1', '20>5', '20'], ['', A2 + ' 3', '1', '0', '10', '20']]) || t;
  });
  await check('30 fix stats: both players\' lists name the partner, with Undo', async () =>
    JSON.stringify(await pg.js(`['0:0', '0:1'].map((k) => { const s = document.querySelector('[data-fswap="' + k + '"]'); return [s.options[0].textContent, s.value]; })`))
      === JSON.stringify([['Undo', A2 + ' 2'], ['Undo', A2 + ' 1']]));
  await check('30 fix stats: and Save correction is on', () => saveOn());
  await pg.fill('[data-fswap="0:0"]', A2 + ' 3', ['change']);
  await check('30 fix stats: a player is in one swap at a time (picking again replaces it)', async () => {
    await pg.waitJs(`document.querySelector('[data-fswap="0:0"]').value === ${q(A2 + ' 3')}`, 'the new swap');
    const t = (await tables())[0].rows;
    return JSON.stringify(t.map((x) => x[0] + x[1])) === JSON.stringify(['*' + A2 + ' 1', A2 + ' 2', '*' + A2 + ' 3']) || t;
  });
  await check('30 fix stats: buzzes moved onto someone not in the lineup are pointed out', async () =>
    (await warn()) === `${A2} 3 was not in the lineup on question 1. ${A2} 3 was not in the lineup on question 4.` || await warn());
  await pg.fill('[data-fswap="0:0"]', '', ['change']);
  await check('30 fix stats: Undo drops the swap: nothing marked, Save off again', async () => {
    await pg.waitJs(`!document.querySelector('.fixbuzz .was')`, 'undone');
    return !(await saveOn()) && !(await warn()) && !(await pg.exists('.fixbuzz tr.chg'));
  });
  await pg.click('[data-fixtab="all"]');
  await check('30 fix stats: All buzzes lists each buzz, question and player, by team', async () => {
    await pg.waitJs(`!!document.querySelector('.fxbuzzes')`, 'All buzzes');
    const l = await pg.js(`[...document.querySelectorAll('.fxbuzzes > div')].map((d) => [d.querySelector('.fxbh').textContent,
      ...[...d.querySelectorAll('.fxrow')].map((r) => [r.querySelector('.muted').textContent, r.querySelector('select').value, r.querySelector('.num').textContent].join(' '))])`);
    return JSON.stringify(l) === JSON.stringify([[A2, `1 ${A2} 1 10`, `2 ${A2} 2 10`, `4 ${A2} 1 -5`, `5 ${A2} 2 10`, `11 ${A2} 3 10`],
      [B2, `3 ${B2} 1 10`, `4 ${B2} 2 10`]]) || l;
  });
  await pg.fill('[data-fedit="0:0"]', A2 + ' 3', ['change']);
  await check('30 fix stats: one buzz given to another player: marked, counted, and the lineup warning', async () => {
    await pg.waitJs(`!!document.querySelector('.fxrow.chg')`, 'the edit');
    const t = (await tables())[0].rows;
    return (JSON.stringify(t) === JSON.stringify([['*', A2 + ' 1', '1>0', '1', '5>-5', '20'], ['', A2 + ' 2', '2', '0', '20', '20'], ['*', A2 + ' 3', '1>2', '0', '10>20', '20']])
      && (await warn()) === `${A2} 3 was not in the lineup on question 1.` && await saveOn()) || [t, await warn()];
  });
  await pg.click('[data-fixcancel]');
  await check('30 fix stats: Cancel closes the panel, nothing saved', async () =>
    (await pg.waitJs(`!document.querySelector('.fixbuzz')`, 'closed')) && (await T.detail()).files.filter((f) => f.bucket_id === R1.id && f.round === 2).length === 1);
  await pg.click(`[data-fixbuzz="${f21.id}"]`);
  await pg.waitJs(`!!document.querySelector('[data-fswap]')`, 'open again');
  await pg.click(`[data-fixbuzz="${f21.id}"]`);
  await check('30 fix stats: its button opens and closes the panel', () => pg.waitJs(`!document.querySelector('.fixbuzz')`, 'toggled closed'));
  // Lineups: who started and each substitution, per team, as the
  // moderator's start card has them (the fixture's file says 20 tossups
  // heard for everyone; a lineup change counts them from the lineups)
  const cards = () => pg.js(`[...document.querySelectorAll('.lucards > .lucard')].map((c) => ({
    head: [...c.querySelectorAll('.luhead > *')].map((x) => x.textContent.trim()).join(' '),
    on: [...c.querySelectorAll('button.lup')].map((b) => b.dataset.name + (b.classList.contains('on') ? '*' : '')),
    subs: [...c.querySelectorAll('.lusub')].map((r) => [...r.querySelectorAll('span')].map((x) => x.textContent.trim()).join(' ')) }))`);
  await pg.click(`[data-fixbuzz="${f21.id}"]`);
  await pg.waitJs(`!!document.querySelector('[data-fswap]')`, 'open again');
  await pg.click('[data-fixtab="lineups"]');
  await check('30 fix stats: Lineups shows each team\'s players, the starters ticked, and its substitutions, as the file has them', async () => {
    await pg.waitJs(`!!document.querySelector('.lucards')`, 'Lineups');
    const c = await cards();
    return (JSON.stringify(c) === JSON.stringify([{ head: `${A2} 2 starting`, on: [A2 + ' 1*', A2 + ' 2*', A2 + ' 3', A2 + ' Sub'], subs: [`Q11 ${A2} 3 joins`] },
      { head: `${B2} 3 starting`, on: [B2 + ' 1*', B2 + ' 2*', B2 + ' 3*', B2 + ' Sub'], subs: [] }])
      && !(await pg.exists('[data-fswap]')) && !(await saveOn())) || c;
  });
  await pg.click('[data-luaddopen="0"]');
  await check('30 fix stats: Add substitution opens its form: the question (Q2 on), who comes in and who goes out, each with Nobody', async () => {
    await pg.waitJs(`!!document.querySelector('.luadd #luaq')`, 'the form');
    const o = await pg.js(`(() => { const opts = (id) => [...document.querySelector('#' + id).options].map((x) => x.value + '=' + x.textContent);
      return { q: opts('luaq'), inn: opts('luain'), out: opts('luaout'), btns: [document.querySelector('#luaok').textContent, document.querySelector('#luano').textContent],
        card: [...document.querySelectorAll('.lucard')].findIndex((c) => c.contains(document.querySelector('.luadd'))) }; })()`);
    return JSON.stringify(o) === JSON.stringify({ q: Array.from({ length: 19 }, (_, i) => `${i + 2}=Q${i + 2}`),
      inn: ['=Nobody', `${A2} 3=${A2} 3`, `${A2} Sub=${A2} Sub`], out: ['=Nobody', `${A2} 1=${A2} 1`, `${A2} 2=${A2} 2`], btns: ['Add', 'Cancel'], card: 0 }) || o;
  });
  await pg.click('#luano');
  await check('30 fix stats: its Cancel closes the form, nothing changed', async () =>
    (await pg.waitJs(`!document.querySelector('.luadd')`, 'the form closed')) && !(await saveOn()) && !(await pg.exists('.fixbuzz tr.chg')));
  await pg.click('[data-luaddopen="0"]');
  await pg.waitJs(`!!document.querySelector('#luaq')`, 'the form');
  await pg.fill('#luaq', '5', ['change']);
  await pg.waitJs(`document.querySelector('#luaq').value === '5'`, 'Q5');
  await pg.fill('#luain', A2 + ' Sub', ['change']);
  await pg.fill('#luaout', A2 + ' 2', ['change']);
  await pg.click('#luaok');
  await check('30 fix stats: Add puts the substitution in its place, in MODAQ\'s words, and closes the form', async () => {
    await pg.waitJs(`!document.querySelector('.luadd') && document.querySelectorAll('.lusub').length === 2`, 'the substitution');
    const c = await cards();
    return JSON.stringify(c[0].subs) === JSON.stringify([`Q5 ${A2} Sub in for ${A2} 2`, `Q11 ${A2} 3 joins`]) || c;
  });
  await check('30 fix stats: the tables count tossups heard from the new lineups, the roster player added, the rows marked, Save on', async () => {
    const t = (await tables())[0].rows;
    return (JSON.stringify(t) === JSON.stringify([['', A2 + ' 1', '1', '1', '5', '20'], ['*', A2 + ' 2', '2', '0', '20', '20>4'],
      ['*', A2 + ' 3', '1', '0', '10', '20>10'], ['*', A2 + ' Sub from the roster', '0', '0', '0', '0>16']]) && await saveOn()) || t;
  });
  await pg.click(`[data-lusubdel="0"][data-sub*='"q":5']`);
  await check('30 fix stats: × removes a substitution', async () => {
    await pg.waitJs(`document.querySelectorAll('.lusub').length === 1`, 'one substitution');
    return JSON.stringify((await cards())[0].subs) === JSON.stringify([`Q11 ${A2} 3 joins`]) || await cards();
  });
  await pg.click(`[data-lustart="1"][data-name="${B2} 3"]`);
  await check('30 fix stats: a starter\'s box takes them out of the starting lineup', async () => {
    await pg.waitJs(`!document.querySelector('[data-lustart="1"][data-name="${B2} 3"]').classList.contains('on')`, 'unticked');
    const c = (await cards())[1];
    const t = (await tables())[1].rows.find((r) => r[1] === B2 + ' 3');
    return (c.head === `${B2} 2 starting` && JSON.stringify(t) === JSON.stringify(['*', B2 + ' 3', '0', '0', '0', '20>0'])) || [c, t];
  });
  await pg.click('[data-fixcancel]');
  await check('30 fix stats: Cancel drops the lineup changes, nothing saved', async () =>
    (await pg.waitJs(`!document.querySelector('.fixbuzz')`, 'closed')) && (await T.detail()).files.filter((f) => f.bucket_id === R1.id && f.round === 2).length === 1);
  // a game with no buzzes: no tabs
  const p53 = pair(5, 3);
  const quiet = await T.upload(R4, 5, `Round_5_${p53[0]}_${p53[1]}.qbj`, quickGame(5, p53, gamesOf(p53), [0, 0]));
  // Edit in MODAQ and Fix stats on uploads they can't use
  const p63 = pair(6, 2);
  const lost = await T.upload(R3, 6, `Round_6_${p63[0]}_${p63[1]}.qbtd.json`, readerFile(quickGame(6, p63, gamesOf(p63), [2, 1])));
  const p62 = pair(6, 1);
  const bareReader = await T.upload(R2, 6, `Round_6_${p62[0]}_${p62[1]}.qbtd.json`, { qbj: quickGame(6, p62, gamesOf(p62), [3, 1]), game: null });
  const tid = (await T.detail()).tournament.id;
  if (PERSIST) d1(`UPDATE files SET r2_key = 't/${tid}/bucket/${R3.id}/gone-file.qbtd.json' WHERE id = ${lost.id}`);
  await openLive(pg, T);
  await openCell(pg, R4.id, 5);
  await pg.click(`[data-fixbuzz="${quiet.id}"]`);
  await check('30 fix stats: a game with no buzzes has no All buzzes tab, only Swap player buzzes and Lineups', async () => {
    await pg.waitJs(`!!document.querySelector('.fixbuzz table.fxteam')`, 'the tables');
    return JSON.stringify(await tabs()) === '["Swap player buzzes*","Lineups"]' || await tabs();
  });
  if (PERSIST) {
    await openCell(pg, R3.id, 6);
    await pg.click(`[data-fixbuzz="${lost.id}"]`);
    await check('30 fix stats: a game that can\'t be loaded says why', async () =>
      (await pg.waitJs(`(document.querySelector('.fixbuzz.warntext') || {}).textContent || ''`, 'the error')) === 'no such file');
    await pg.click(`.cellpanel [data-editfile="${lost.id}"]`);
    await expectNotice(pg, '29 edit in MODAQ: a stored file that is gone: "could not load the game file (404)"', 'could not load the game file (404)', true);
  }
  await openCell(pg, R2.id, 6);
  await pg.click(`.cellpanel [data-editfile="${bareReader.id}"]`);
  await expectNotice(pg, '29 edit in MODAQ: an upload with no MODAQ game: "this upload has no MODAQ game in it"', 'this upload has no MODAQ game in it', true);

  if (PERSIST) {
    // 27: before Start, Edit in MODAQ and Save correction say so too
    const was = (await T.detail()).tournament.started;
    d1(`UPDATE tournaments SET started = NULL WHERE id = ${tid}`);
    try {
      await openLive(pg, T);
      await openCell(pg, R1.id, 1);
      await pg.click(`.cellpanel [data-editfile="${M.f11b ? M.f11b.id : M.f11.id}"]`);
      await expectNotice(pg, '27 edit in MODAQ: before Start, "Start the tournament first…"', 'Start the tournament first: rooms take games only once it has started', true);
      await openCell(pg, R1.id, 2);
      await pg.click(`[data-fixbuzz="${f21.id}"]`);
      await pg.waitJs(`!!document.querySelector('[data-fswap="0:0"]')`, 'Fix stats');
      await pg.fill('[data-fswap="0:0"]', A2 + ' 2', ['change']);
      await pg.waitJs(`!document.querySelector('#fixsave').disabled`, 'a change to save');
      await pg.click('#fixsave');
      await expectNotice(pg, '27 fix stats: before Start, Save correction says "Start the tournament first…"', 'Start the tournament first: rooms take games only once it has started', true);
      await check('27 fix stats: and nothing went up', async () => (await T.detail()).files.filter((f) => f.bucket_id === R1.id && f.round === 2).length === 1);
    } finally { d1(`UPDATE tournaments SET started = ${was} WHERE id = ${tid}`); }

    // 31: Save correction on a game filed under round 3 whose file says round 2 (an upload from before files took their filed round)
    d1(`UPDATE files SET round = 3 WHERE id = ${f21.id}`);
    await openLive(pg, T);
    await pg.click('#calc');
    await pg.waitJs(`/games in these stats$/.test(document.querySelector('#statsnote').textContent)`, 'stats', 30000);
    const before = await pg.text('#statsnote');
    await openCell(pg, R1.id, 3);
    await pg.click(`[data-fixbuzz="${f21.id}"]`);
    await pg.waitJs(`!!document.querySelector('[data-fswap="0:0"]')`, 'Fix stats');
    await pg.fill('[data-fswap="0:0"]', A2 + ' 2', ['change']);
    await pg.waitJs(`!document.querySelector('#fixsave').disabled`, 'a change to save');
    await pg.watchTexts('#fixsave');
    await pg.click('#fixsave');
    await check('31 save correction: "Saved as a new upload. Delete it to undo."', async () => { await msgIs(pg, 'Saved as a new upload. Delete it to undo.', false); return true; });
    await check('31 save correction: the button read "Saving…" meanwhile', async () => (await pg.seenTexts()).includes('Saving…') || await pg.seenTexts());
    const fix = await until(() => fileRow(T, (f) => f.id > f21.id && f.bucket_id === R1.id && f.filename === f21.filename), 'the fix');
    await check('31 save correction: it went up through Room 1, under the filed round and the same name', () => (fix.round === 3 && fix.kind === 'qbj') || fix);
    const [o, x] = [(await T.file(await fileRow(T, (f) => f.id === f21.id))).body, (await T.file(fix)).body];
    await check('31 save correction: the original was refiled to its round first; both files say round 3 ' + CHG.filedRound, () => (o._round === 3 && x._round === 3) || [o._round, x._round]);
    await check('31 save correction: the fix trades the two players\' buzzes', () => {
      const c = (m, n) => JSON.stringify(m.match_teams[0].match_players.find((p) => p.player.name === n).answer_counts.map((a) => [a.answer.value, a.number]).sort());
      return (c(x, A2 + ' 1') === c(o, A2 + ' 2') && c(x, A2 + ' 2') === c(o, A2 + ' 1')) || [c(x, A2 + ' 1'), c(o, A2 + ' 2')];
    });
    await pg.click('#calc');
    await pg.waitJs(`!document.querySelector('#statsec').hidden && /games in these stats$/.test(document.querySelector('#statsnote').textContent)`, 'stats again', 30000);
    // Compute keeps what it read per file (id, size, created, round), but
    // never a game whose file named another round: the original,
    // restamped in place, is read again under the round it is filed in
    await check('31 save correction: in the tab that fixed it, Compute counts the game once', async () => (await pg.text('#statsnote')) === before || [before, await pg.text('#statsnote')]);
    await check('31 save correction: in that tab, in the round it is filed under (3)', async () => {
      const byRound = await statsGames(pg);
      const mine = Object.entries(byRound).filter(([, gs]) => gs.some((g) => g.includes(A2) && g.includes(B2))).map(([rd]) => rd);
      return JSON.stringify(mine) === '["3"]' || byRound;
    });
    await openLive(pg, T);
    await pg.click('#calc');
    await pg.waitJs(`!document.querySelector('#statsec').hidden && /games in these stats$/.test(document.querySelector('#statsnote').textContent)`, 'stats after a reload', 30000);
    await check('31 save correction: Compute counts the game once ' + CHG.filedRound, async () => (await pg.text('#statsnote')) === before || [before, await pg.text('#statsnote')]);
    await check('31 save correction: in the round it is filed under (3), with the fix\'s numbers ' + CHG.filedRound, async () => {
      const byRound = await statsGames(pg);
      const mine = Object.entries(byRound).filter(([, gs]) => gs.some((g) => g.includes(A2) && g.includes(B2))).map(([rd]) => rd);
      return JSON.stringify(mine) === '["3"]' || byRound;
    });

    // 30 31: a substitution saved from Lineups, on the fix that counts now
    await openCell(pg, R1.id, 3);
    await pg.click(`[data-fixbuzz="${fix.id}"]`);
    await pg.waitJs(`!!document.querySelector('[data-fixtab="lineups"]')`, 'Fix stats');
    await pg.click('[data-fixtab="lineups"]');
    await pg.click('[data-luaddopen="0"]');
    await pg.waitJs(`!!document.querySelector('#luaq')`, 'the form');
    await pg.fill('#luaq', '5', ['change']);
    await pg.waitJs(`document.querySelector('#luaq').value === '5'`, 'Q5');
    await pg.fill('#luain', A2 + ' Sub', ['change']);
    await pg.fill('#luaout', A2 + ' 2', ['change']);
    await pg.click('#luaok');
    await pg.waitJs(`!document.querySelector('#fixsave').disabled`, 'a change to save');
    await pg.click('#fixsave');
    await check('31 save correction: a lineup change saves as a new upload too', async () => { await msgIs(pg, 'Saved as a new upload. Delete it to undo.', false); return true; });
    const lu = await until(() => fileRow(T, (f) => f.id > fix.id && f.bucket_id === R1.id && f.filename === f21.filename), 'the lineup fix');
    const lb = (await T.file(lu)).body;
    const fb = (await T.file(fix)).body;
    const la = lb.match_teams[0];
    await check('31 save correction: its .qbj has the substitution in the team\'s lineups', () => {
      const got = la.lineups.map((l) => [l.first_question, ...l.players.map((p) => p.name)]);
      return JSON.stringify(got) === JSON.stringify([[1, A2 + ' 1', A2 + ' 2'], [5, A2 + ' 1', A2 + ' Sub'], [11, A2 + ' 1', A2 + ' Sub', A2 + ' 3']]) || got;
    });
    await check('31 save correction: and tossups heard counted from them, the roster player added', () => {
      const got = Object.fromEntries(la.match_players.map((p) => [p.player.name, p.tossups_heard]));
      return JSON.stringify(got) === JSON.stringify({ [A2 + ' 1']: 20, [A2 + ' 2']: 4, [A2 + ' 3']: 10, [A2 + ' Sub']: 16 }) || got;
    });
    await check('31 save correction: the other team and the buzzes are as they were', () =>
      (JSON.stringify(lb.match_teams[1]) === JSON.stringify(fb.match_teams[1]) && JSON.stringify(lb.match_questions) === JSON.stringify(fb.match_questions)
        && scoreOf(lb).join() === scoreOf(fb).join()) || [scoreOf(lb), scoreOf(fb)]);
  }
});

// the hub's Compute: its games by round, {round: [summary lines]}
const statsGames = (pg) => pg.js(`(() => { const out = {}; let rd = null;
  for (const el of document.querySelectorAll('#statsout .rhead, #statsout .game')) {
    if (el.classList.contains('rhead')) { rd = el.textContent.replace('round', '').trim(); out[rd] = []; }
    else out[rd].push((el.querySelector('summary') || el).textContent.replace(/\\s+/g, ' ').trim());
  } return out; })()`);

section('main-rename', '51: a team renamed in another tab, in the hub\'s listings', async () => {
  const M = await mainDay();
  const { T, R1, p1 } = M;
  const pg = hub;
  const [X, B] = p1[0];
  await openLive(pg, T);
  await check('51 rename: before, Live now lists the team by its name', async () => (await liveRows(pg))[0].game.startsWith(`${X} 120`));
  // the other tab saves the roster with the rename, and the schedule renamed with it (as the hub's own roster save does)
  await T.roster(ROSTER8.map((t) => (t.name === X ? { name: X + ' Prime', players: [X + ' One', X + ' 2', X + ' 3', X + ' Sub'],
    formerNames: [X], formerPlayers: { [X + ' One']: [X + ' 1'] } } : t)));
  {
    const s = await T.savedSchedule();
    renameTeams(s, { [X]: X + ' Prime' });
    await T.schedule(s);
  }
  await pg.refresh();
  await check('51 rename: on its next refresh Live now lists the game under the new name ' + CHG.renameRefresh, () =>
    pg.waitJs(`(document.querySelector('.lrow .lgame') || {}).textContent.replace(/\\s+/g, ' ').trim().startsWith(${q(X + ' Prime 120')})`, 'the new name', 10000));
  await openCell(pg, R1.id, 1);
  await check('51 rename: the cell panel too ' + CHG.renameRefresh, async () => (await panelFiles(pg)).every((f) => f.line.startsWith(`${X} Prime 120 – 100 ${B}`)) || await panelFiles(pg));
  await check('51 rename: the protest rows too ' + CHG.renameRefresh, async () => {
    await setDrawer(pg, true);
    const rows = await drawerRows(pg);
    return (rows.filter((r) => r.cells[0] === '1').every((r) => r.cells[1].includes(`${X} Prime v ${B}`)) && rows.length > 0) || rows.map((r) => r.cells[1]);
  });
  {
    const got = await download(pg, `[...document.querySelectorAll('.cellpanel .pfile')][0].querySelector('.pacts a').click(); true`);
    const j = JSON.parse(got.bytes.toString('utf8'));
    await check('51 rename: the per-file download is named and written under the new names ' + CHG.renameRefresh, () =>
      (got.name === `Round_1_${X} Prime_${B}.qbj` && j.match_teams[0].team.name === X + ' Prime'
        && j.match_teams[0].match_players.some((p) => p.player.name === X + ' One')) || [got.name, j.match_teams[0].team.name]);
  }
  await check('51 rename: the stored upload itself is not rewritten', async () => {
    const f = await fileRow(T, (x) => x.id === (M.f11b || M.f11).id);
    return (await T.file(f)).body.qbj.match_teams[0].team.name === X;
  });
  const ffList = async () => {
    await pg.click('#fftoggle');
    await pg.waitJs(`!!document.querySelector('#ffpanel')`, 'the forfeit panel');
    const l = await pg.js(`[...document.querySelector('#fflose').options].map((o) => o.textContent)`);
    await pg.click('#ffcancel');
    return l;
  };
  {
    const l = await ffList();
    if (!l.includes(X + ' Prime')) {
      note(`BUG (renamed in another tab): after the hub's refresh, Record a forfeit still lists "${X}" and not "${X} Prime" (its team lists come from the schedule and roster the tab loaded); a reload fixes it`);
    }
  }
  await openLive(pg, T);
  await check('51 rename: Record a forfeit lists the new name, not the old (after a reload)', async () => {
    const l = await ffList();
    return (l.includes(X + ' Prime') && !l.includes(X)) || l;
  });
  await openCell(pg, R1.id, 1);
  await pg.click(`.cellpanel [data-fixbuzz="${(M.f11b || M.f11).id}"]`);
  await check('51 rename: Fix stats offers only roster players not in the game, under their new names', async () => {
    await pg.waitJs(`!!document.querySelector('[data-fswap="0:0"]')`, 'Fix stats');
    const roster = await pg.js(`[...document.querySelectorAll('[data-fswap="0:0"] optgroup option')].map((x) => x.value)`);
    return JSON.stringify(roster) === JSON.stringify([X + ' Sub']) || roster;
  });
  await pg.click('[data-fixcancel]');
});

section('main-stats', '26 42 43 48: Compute, the Download menu and the QBJ bundle', async () => {
  const M = await mainDay();
  const { T } = M;
  const pg = hub;
  await openLive(pg, T);
  const d = await T.detail();
  const nReady = d.files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error).length;
  await check('42 stats: before Compute, "N games ready"', async () => (await pg.text('#statsnote')) === `${nReady} games ready` || await pg.text('#statsnote'));
  await check('43 download menu: off before Compute', () => pg.js(`document.querySelector('#dlmenu').disabled`));
  await pg.watchTexts('#calc');
  await pg.click('#calc');
  await pg.waitJs(`!document.querySelector('#statsec').hidden && /games in these stats$/.test(document.querySelector('#statsnote').textContent)`, 'stats', 30000);
  await check('42 stats: Compute counts the games it reads, "Computing stats… n of N"', async () =>
    (await pg.seenTexts()).some((x) => new RegExp(`^Computing stats… \\d+ of ${nReady}$`).test(x)) || await pg.seenTexts());
  await check('26 add a game: a game added under round 5 whose file says round 1 is counted in round 5 ' + CHG.filedRound, async () => {
    const byRound = await statsGames(pg);
    const [a, b] = M.pair(5, 1);
    return ((byRound['5'] || []).some((g) => g.includes(a) && g.includes(b)) && !(byRound['1'] || []).some((g) => g.includes(a) && g.includes(b))) || byRound;
  });
  await check('43 download menu: on after Compute', () => pg.js(`!document.querySelector('#dlmenu').disabled`));
  await pg.click('#dlmenu');
  await check('43 download menu: opens, aria-expanded true, five downloads and Rebuild public stats', async () =>
    (await pg.js(`!document.querySelector('#dlpanel').hidden && document.querySelector('#dlmenu').getAttribute('aria-expanded') === 'true'`))
      && JSON.stringify(await pg.js(`[...document.querySelectorAll('#dlpanel button')].map((b) => b.id)`)) === JSON.stringify(['dlyft4', 'dlyft3', 'dlreport', 'dlreportfiles', 'dlzip', 'rebuild']));
  // 50: an open menu holds off redraws
  await markView(pg);
  await call(T.A, { method: 'POST', json: { name: d.tournament.name } });
  await pg.refresh();
  const asked = await quietFor(pg, 1000, isDetailGet(T.secret));
  await check('50 refresh: while the Download menu is open, no refresh and no redraw', async () => ((await viewKept(pg)) && asked.length === 0) || asked);
  await pg.S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await pg.S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await check('43 download menu: Escape closes it and gives the button the focus', () =>
    pg.waitJs(`document.querySelector('#dlpanel').hidden && document.activeElement === document.querySelector('#dlmenu')`, 'closed by Escape'));
  if ((await pg.js(`document.querySelector('#dlmenu').getAttribute('aria-expanded')`)) !== 'false') {
    note('BUG (Download menu): after Escape closes it, #dlmenu still says aria-expanded="true" (a click outside sets "false")');
  }
  await pg.click('#dlmenu');
  await pg.waitJs(`!document.querySelector('#dlpanel').hidden`, 'open again');
  await pg.click('.biground');
  await check('43 download menu: a click elsewhere closes it (aria-expanded false)', () =>
    pg.waitJs(`document.querySelector('#dlpanel').hidden && document.querySelector('#dlmenu').getAttribute('aria-expanded') === 'false'`, 'closed by a click'));
  // the QBJ bundle
  await pg.click('#dlmenu');
  await pg.waitJs(`!document.querySelector('#dlpanel').hidden`, 'the menu');
  await pg.watchTexts('#dlzip');
  const z = await download(pg, `document.querySelector('#dlzip').click(); true`);
  const entries = await readZip(new Uint8Array(z.bytes));
  const names = entries.map((e) => e.name);
  await check('48 qbj bundle: <slug>-qbj.zip, its button reading "Building zip…" meanwhile', async () =>
    (z.name === `${T.slug}-qbj.zip` && (await pg.seenTexts()).includes('Building zip…')) || [z.name, await pg.seenTexts()]);
  await check('48 qbj bundle: a folder per round, and roster.qbj', () => (names.every((n) => /^round-\d+\//.test(n) || n === 'roster.qbj') && names.includes('roster.qbj')) || names);
  await check('48 qbj bundle: a game file that can\'t be read is left out, and the bundle still comes', () => !names.some((n) => n.startsWith('round-9/')) || names);
  await check('48 qbj bundle: no combined reader upload in it', () => !names.some((n) => /\.qbtd\.json$/.test(n)) || names);
  {
    const ro = new TextDecoder().decode(entries.find((e) => e.name === 'roster.qbj').data);
    await check('48 qbj bundle: roster.qbj leaves out qb-td\'s former names, and MODAQ reads it', () => {
      const j = JSON.parse(ro);
      return (!ro.includes('_formerNames') && j.version && j.objects.some((o) => o.type === 'Tournament' && o.registrations.length === 8)) || ro.slice(0, 300);
    });
  }
  // observed: a redraw after Compute hides the table and turns Download off again
  await bumpAndRefresh(pg, T);
  if (await pg.js(`document.querySelector('#statsec').hidden && document.querySelector('#dlmenu').disabled`)) {
    note('BUG (Compute stats): any redraw after Compute (a refresh that finds a change, a ruling, a round change) hides the stats table and turns Download off until Compute is pressed again');
  }
});

section('rounds', '08 12 15 16 17 32 33: the round line, Advance, Set round, auto-advance, and no protests', async () => {
  const pg = hub;
  const T = await newTournament('Rounds');
  for (const n of ['Room 1', 'Room 2']) await T.addRoom(n);
  await T.roster(ROSTER4);
  await T.schedule(buildSchedule('rr', TEAMS4, T.rooms.map((b) => ({ name: b.room_name, bucket: b.id }))));
  for (const n of [1, 2]) await T.packet(n);
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  await openLive(pg, T);
  const big = () => pg.ntext('.biground');
  const cur = async () => (await T.detail()).tournament.current_round;
  await check('08 round line: "Round 1 / 3" (the schedule\'s three rounds)', async () => (await big()) === 'Round 1 / 3' || await big());
  await check('32 33 no protests: the rail and the drawer say "None logged", and the drawer explains', async () =>
    /None logged/.test(await pg.ntext('.liverail')) && (await pg.ntext('#protdrawer > summary .muted')) === 'None logged'
      && !(await pg.js(`document.querySelector('#protdrawer').open`))
      && (await pg.js(`document.querySelector('#protdrawer .inner').textContent.replace(/\\s+/g, ' ').trim()`)) === 'Protests show up here as soon as a moderator logs them in MODAQ, with the score swing an upheld ruling would produce.');
  await check('12 advance: "Advance to round 2", no warning (its packet is in)', async () =>
    (await pg.ntext('#advround')) === 'Advance to round 2' && !/No packet/.test(await pg.ntext('.liverail .railblock')));
  await pg.click('#advround');
  await check('12 advance: it opens round 2, says "Round 2", and the hub shows it', async () => {
    await msgIs(pg, 'Round 2', false);
    await pg.waitJs(`document.querySelector('.biground').textContent.replace(/\\s+/g, ' ').trim() === 'Round 2 / 3'`, 'round 2');
    return (await cur()) === 2;
  });
  await check('12 advance: with no packet for the next round, "No packet for round 3 yet"', async () =>
    (await pg.ntext('#advround')) === 'Advance to round 3' && (await pg.js(`[...document.querySelectorAll('.liverail .warntext')].map((x) => x.textContent.trim())`)).includes('No packet for round 3 yet'));
  await pg.fill('#curround', '3', ['input']);
  await pg.click('#setround');
  await pg.waitJs(`/Round 3/.test(document.querySelector('.biground').textContent)`, 'round 3');
  await check('08 round line: "No packet for this round" when the live round has none', async () =>
    (await pg.js(`[...document.querySelectorAll('.roundline .warntext')].map((x) => x.textContent.trim())`)).includes('No packet for this round'));
  await check('15 last round: Advance is grayed out, and a note says why', async () =>
    (await pg.js(`document.querySelector('.liverail button.advance').disabled && !document.querySelector('#advround')`))
      && (await pg.ntext('.liverail .railblock')).includes('Round 3 is the last round in the schedule.'));
  // the total: the largest of the schedule's rounds, Setup's extra rounds, the live round and the packet rounds
  await T.settings({ rounds: 5 });
  await openLive(pg, T);
  await check('08 round line: the Packets step\'s extra rounds count ("/ 5")', async () => (await big()) === 'Round 3 / 5' || await big());
  await T.packet(6);
  await openLive(pg, T);
  await check('08 round line: a packet for a later round counts ("/ 6")', async () => (await big()) === 'Round 3 / 6' || await big());
  await pg.fill('#curround', '7', ['input']);
  await pg.click('#setround');
  await check('08 round line: and so does the live round ("Round 7 / 7")', () => pg.waitJs(`document.querySelector('.biground').textContent.replace(/\\s+/g, ' ').trim() === 'Round 7 / 7'`, 'round 7'));
  await check('10 live now: a round past the schedule: "No game yet" in every room, each with Upload', async () => {
    const rows = await liveRows(pg);
    return (rows.length === 2 && rows.every((r) => r.game === 'No game yet' && JSON.stringify(r.acts) === '["Upload"]' && r.mark === '–')) || rows;
  });
  // Set round with nothing sensible in it
  await dismiss(pg);
  await pg.fill('#curround', '0', ['input']);
  await pg.click('#setround');
  await expectNotice(pg, '16 set round: 0 shows the Worker\'s error, in red', 'bad round', true);
  await pg.fill('#curround', '', ['input']);
  await pg.click('#setround');
  await expectNotice(pg, '16 set round: blank shows it too', 'bad round', true);
  await check('16 set round: and the round is unchanged', async () => (await cur()) === 7);
  await pg.fill('#curround', '1', ['input']);
  await pg.click('#setround');
  await pg.waitJs(`/Round 1 \\//.test(document.querySelector('.biground').textContent)`, 'round 1');

  // auto-advance: another tab changes the game format meanwhile; the switch keeps it
  {
    const s = settingsOf(await T.detail());
    const next = { ...s, gameFormat: 'pace' };
    await call(T.A, { method: 'POST', json: { settings: next, settings_base: JSON.stringify(s), settings_touched: ['gameFormat', 'formatOverrides'] } });
  }
  await dismiss(pg);
  await pg.click('#autoadv');
  await check('17 auto-advance: switching it on says "Rounds open automatically"', async () => { await msgIs(pg, 'Rounds open automatically', false); return true; });
  let st = await until(async () => { const x = settingsOf(await T.detail()); return x.autoAdvance === true && x; }, 'saved');
  await check('17 auto-advance: the switch saves only its own setting: a format chosen in another tab is kept ' + CHG.settings2tabs, () => st.gameFormat === 'pace' || st);
  await pg.waitJs(`!!document.querySelector('#autoadv') && document.querySelector('#autoadv').checked`, 'the switch on');
  await dismiss(pg);
  await pg.click('#autoadv');
  await check('17 auto-advance: switching it off says "Rounds open when you advance them"', async () => { await msgIs(pg, 'Rounds open when you advance them', false); return true; });
  st = await until(async () => { const x = settingsOf(await T.detail()); return !x.autoAdvance && x; }, 'saved off');
  await check('17 auto-advance: off, the other tab\'s format still kept ' + CHG.settings2tabs, () => st.gameFormat === 'pace' || st);
  // every room has started round 2, whose next round has no packet yet: switched on, it waits for the packet
  await pg.fill('#curround', '2', ['input']);
  await pg.click('#setround');
  await pg.waitJs(`/Round 2 \\//.test(document.querySelector('.biground').textContent)`, 'round 2');
  for (const b of T.rooms) await T.startRound(b, 2);
  await openLive(pg, T);
  await pg.waitJs(`!!document.querySelector('#autoadv') && !document.querySelector('#autoadv').checked`, 'the switch off');
  await dismiss(pg);
  await pg.click('#autoadv');
  await msgIs(pg, 'Rounds open automatically', false);
  await check('17 auto-advance: every room started and no packet for the next: "Round 3 opens as soon as its packet is uploaded."', () =>
    pg.waitJs(`/Round 3 opens as soon as its packet is uploaded\\./.test(document.querySelector('.liverail').textContent)`, 'the note'));
  await check('17 auto-advance: and the round stays put', async () => (await cur()) === 2);
  await dismiss(pg);
  await pg.click('#autoadv');
  await msgIs(pg, 'Rounds open when you advance them', false);
  await T.packet(3);
  await openLive(pg, T);
  await dismiss(pg);
  await pg.click('#autoadv');
  await check('17 auto-advance: switched on with every room started: "Round 3 opened: every room had started Round 2"', async () => {
    await msgIs(pg, 'Round 3 opened: every room had started Round 2', false);
    return (await cur()) === 3;
  });
  await check('17 auto-advance: the hub shows round 3', () => pg.waitJs(`/Round 3 \\//.test(document.querySelector('.biground').textContent)`, 'round 3'));
  // a round set back by hand stays put: rooms starting it again change nothing
  await pg.fill('#curround', '2', ['input']);
  await pg.click('#setround');
  await pg.waitJs(`/Round 2 \\//.test(document.querySelector('.biground').textContent)`, 'set back to 2');
  for (const b of T.rooms) await T.startRound(b, 2);
  await pg.refresh();
  await check('16 set round: a round set back by hand is never pushed on by auto-advance', async () =>
    (await cur()) === 2 && /Round 2 \//.test(await pg.text('.biground')));
});

section('edit', '09 29: Edit in MODAQ, through a real reader: the game reopens, and the correction replaces it', async () => {
  const pg = hub;
  const T = await newTournament('Edit In Modaq');
  const room = await T.addRoom('Room 1');
  await T.roster([{ name: 'Ants', players: ['Ann', 'Abe'] }, { name: 'Bees', players: ['Bea', 'Bo'] }]);
  await T.packet(1);
  await call(`${T.A}/tiebreakers?name=tb.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: TB_POOL.tossups }) });
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  const modaqButton = (text) => `[...document.querySelectorAll('#modaq button, [role=menuitem], [role=menuitemcheckbox]')].find((b) => b.textContent.trim().startsWith(${q(text)}))`;
  const clickModaq = async (text) => { await pg.waitJs(`!!(${modaqButton(text)})`, text); await pg.js(`(${modaqButton(text)}).click(); true`); };
  // a moderator's game in the reader: tossup 1 replaced with tiebreaker TU1, Ann gets it, then Upload to qb-td
  await pg.goto(`${PAGES}/read.html?b=${room.secret}`);
  await pg.waitJs(`!!document.querySelector('#teama') && document.querySelector('#teama').options.length > 2`, 'the reader');
  await pg.js(`(() => { for (const [id, v] of [['teama', 'Ants'], ['teamb', 'Bees']]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await pg.click('#start');
  await pg.waitJs(`document.body.classList.contains('reading') && !!(${modaqButton('Actions')})`, 'MODAQ', 30000);
  await clickModaq('Actions');
  await clickModaq('Replace tossup');
  await pg.waitJs(`!!document.querySelector('[role=dialog] input[type=radio][id$="p:TU1"]')`, 'the Replace dialog');
  await pg.js(`document.querySelector('[role=dialog] input[type=radio][id$="p:TU1"]').click(); true`);
  await pg.waitJs(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.trim() === 'Replace tossup' && !b.disabled)`, 'Replace enabled');
  await pg.js(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Replace tossup').click(); true`);
  await pg.waitJs(`/Tiebreaker\\s+one\\s+text/.test(document.body.innerText)`, 'the replacement read');
  await pg.js(`[...document.querySelectorAll('#modaq span[class^=word]')][1].click(); true`);
  await clickModaq('Ann');
  await clickModaq('Correct');
  await pg.waitJs(`/Ants:\\s+10,\\s+Bees:\\s+0/.test(document.body.innerText)`, 'the buzz scored');
  // MODAQ saves the game a moment after the last change, and the upload's
  // game half is that save: a moderator's next click comes later than this
  const savedGame = `(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('qbtdGame:${room.secret}')); if (!k) return null;
    const s = JSON.parse(localStorage.getItem(k)); return { tossups: s.game.packet.tossups.length, buzz: !!(s.game.cycles[0] || {}).correctBuzz }; })()`;
  if (!(await pg.js(`(${savedGame} || {}).buzz === true`))) {
    note('READER (edge case): MODAQ saves the game about 300 ms after the last change, and "Upload to qb-td" sends that save as the upload\'s game half'
      + ' (the .qbj half is current): an upload within that moment carries a game without the last action, and Edit in MODAQ reopens that older game');
  }
  await pg.waitJs(`(() => { const s = ${savedGame}; return !!s && s.tossups === 21 && s.buzz; })()`, 'MODAQ\'s saved game');
  await pg.js(`[...document.querySelectorAll('#modaq button')].find((b) => b.textContent.trim() === 'Upload to qb-td' && !b.getAttribute('aria-haspopup')).click(); true`);
  const orig = await until(async () => (await T.detail()).files.find((f) => f.kind === 'combined'), 'the reader upload', 20000);
  await pg.waitJs(`/Export succeeded/.test(document.body.textContent)`, 'MODAQ\'s Export succeeded');
  const origBody = (await T.file(orig)).body;
  if (process.env.QBTD_LH_DEBUG) {
    const g = origBody.game || {};
    console.log('DEBUG game keys', Object.keys(g), 'inner', Object.keys(g.game || {}), 'cycles', JSON.stringify(((g.game || {}).cycles || []).slice(0, 1)).slice(0, 600),
      'tossup1', JSON.stringify((((g.game || {}).packet || {}).tossups || [])[0] || null).slice(0, 200));
    const ls = await pg.js(`Object.keys(localStorage).filter((k) => k.startsWith('qbtdGame')).map((k) => [k, localStorage.getItem(k).length, localStorage.getItem(k).slice(0, 300)])`);
    console.log('DEBUG localStorage', JSON.stringify(ls).slice(0, 1500));
  }
  const tuNums = (b) => b.qbj.match_questions.map((x) => [x.tossup_question.question_number, x.tossup_question.qbtd_tiebreaker || null]);
  await check('29 edit: the original upload numbers the replaced tossup after the packet, as TU1 (the reader\'s own record)', () =>
    JSON.stringify(tuNums(origBody)[0]) === JSON.stringify([21, 'TU1']) || tuNums(origBody).slice(0, 2));

  await openLive(pg, T);
  await check('09 tiebreakers: once a game reads one, "Tiebreakers 1/2 used"', async () =>
    (await pg.js(`[...document.querySelectorAll('.roundline .muted')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).find((x) => /^Tiebreakers/.test(x)) || ''`)) === 'Tiebreakers 1/2 used');
  await check('10 live now: the reader\'s upload, unfinished, shows its score and "· on question 1 of 20"', async () => {
    const r = (await liveRows(pg))[0];
    return (r.game === 'Ants 10 – 0 Bees · on question 1 of 20' && r.pie && JSON.stringify(r.acts) === '["qbj","game","Edit"]') || r;
  });
  await openCell(pg, room.id, 1);
  await pg.js(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; true`);
  await pg.click(`.cellpanel [data-editfile="${orig.id}"]`);
  const link = await pg.waitJs(`window.__opened[0] || ''`, 'the reader link');
  await check('29 edit: Edit in MODAQ opens the room\'s reader on a new game id, in a new tab', () =>
    new RegExp(`^${PAGES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/read\\.html\\?b=${room.secret}&g=fix[0-9a-z]+$`).test(link) || link);
  // the reader in this tab (the same browser: the game was saved here)
  const n0 = pg.reqs.length;
  await pg.goto(link);
  await check('29 edit: the reader resumes that exact game: the teams, the round, the score', () =>
    pg.waitJs(`document.body.classList.contains('reading') && /Ants vs Bees/.test(document.querySelector('#game').textContent)
      && /Room 1 · Round 1/.test(document.querySelector('#room').textContent) && /Ants:\\s+10,\\s+Bees:\\s+0/.test(document.body.innerText)`, 'the resumed game', 30000));
  await check('29 edit: with no fetch of the room, its packet or its load (only the tiebreaker pool)', () => {
    const asked = pg.reqs.slice(n0).filter((r) => r.url.startsWith(BASE) && r.method === 'GET').map((r) => new URL(r.url).pathname.replace('/b/' + room.secret, ''));
    return (asked.every((x) => x === '/tiebreakers')) || asked;
  });
  await pg.js(`[...document.querySelectorAll('#modaq button')].find((b) => b.textContent.trim() === 'Upload to qb-td' && !b.getAttribute('aria-haspopup')).click(); true`);
  const fix = await until(async () => (await T.detail()).files.find((f) => f.kind === 'combined' && f.id > orig.id), 'the correction', 20000);
  const fixBody = (await T.file(fix)).body;
  await check('29 edit: the correction went up through the room, as a newer upload of the same game', () =>
    (fix.bucket_id === room.id && fix.round === 1 && fix.filename === orig.filename) || fix);
  await check('29 edit: the correction numbers the replaced tossup as the original did ' + CHG.editNumbers, () =>
    JSON.stringify(tuNums(fixBody)) === JSON.stringify(tuNums(origBody)) || [tuNums(fixBody).slice(0, 2), tuNums(origBody).slice(0, 2)]);
  await openLive(pg, T);
  await openCell(pg, room.id, 1);
  await check('29 edit: in the hub the correction counts, the original behind "Show previous uploads (1)"', async () => {
    const f = await panelFiles(pg);
    return (f.length === 1 && !f[0].old && f[0].meta.startsWith(`${fix.filename} · combined`) && (await prevBtn(pg)) === 'Show previous uploads (1)') || [f, await prevBtn(pg)];
  });
  await showPrev(pg);
  await check('29 edit: in the hub the original is now "superseded"', async () => {
    const f = await panelFiles(pg);
    return (f.length === 2 && !f[0].old && f[1].old && /superseded$/.test(f[1].line)) || f;
  });
  pg.answers.push(true);
  await pg.click(`[data-delfile="${fix.id}"]`);
  await check('29 edit: deleting the correction brings the original back', async () => {
    await pg.waitJs(`document.querySelectorAll('.cellpanel .pfile').length === 1`, 'one upload');
    const f = await panelFiles(pg);
    return (!f[0].old && f[0].line === 'Ants 10 – 0 Bees') || f;
  });

  // Fix stats on the reader's own upload: Ann's tossup was Abe's
  await pg.click(`[data-fixbuzz="${orig.id}"]`);
  await pg.waitJs(`!!document.querySelector('[data-fswap="0:0"]')`, 'Fix stats');
  await pg.fill('[data-fswap="0:0"]', 'Abe', ['change']);
  await pg.waitJs(`!!document.querySelector('#fixsave') && !document.querySelector('#fixsave').disabled`, 'a change to save');
  await pg.click('#fixsave');
  await check('30 31 fix stats on a reader upload: "Saved as a new upload. Delete it to undo."', async () => { await msgIs(pg, 'Saved as a new upload. Delete it to undo.', false); return true; });
  const fixed = await until(async () => (await T.detail()).files.find((f) => f.kind === 'combined' && f.id > orig.id), 'the fix', 20000);
  await check('31 fix stats on a reader upload: it went up through the room, a newer upload of the same game', () =>
    (fixed.bucket_id === room.id && fixed.round === 1 && fixed.filename === orig.filename) || fixed);
  const [fq, fg] = [(await T.file(fixed, 'qbj')).body, (await T.file(fixed, 'game')).body];
  const gets = (m) => Object.fromEntries(m.match_teams[0].match_players.map((p) => [p.player.name, p.answer_counts.filter((c) => c.answer.value > 0).reduce((n, c) => n + c.number, 0)]));
  await check('31 fix stats on a reader upload: its .qbj gives the tossup to Abe', () => JSON.stringify(gets(fq)) === JSON.stringify({ Ann: 0, Abe: 1 }) || gets(fq));
  await check('31 fix stats on a reader upload: MODAQ\'s game file moves the buzz to Abe too, so Edit in MODAQ agrees', () => {
    const cb = JSON.stringify(((fg.cycles || [])[0] || {}).correctBuzz || null);
    return (/"Abe"/.test(cb) && !/"Ann"/.test(cb)) || cb;
  });
  await openCell(pg, room.id, 1);
  await showPrev(pg);
  await check('31 fix stats on a reader upload: the hub lists the fix first and the original as superseded', async () => {
    const f = await panelFiles(pg);
    return (f.length === 2 && !f[0].old && f[1].old) || f;
  });
});

section('refresh', '05 09 50: the refresh timing, what holds off a redraw, a failed check, and the public page mark', async () => {
  const pg = hub;
  const T = await newTournament('Refresh');
  for (const n of ['Room 1', 'Room 2']) await T.addRoom(n);
  await T.roster(ROSTER4);
  await T.schedule(buildSchedule('rr', TEAMS4, T.rooms.map((b) => ({ name: b.room_name, bucket: b.id }))));
  for (const n of [1, 2, 3]) await T.packet(n);
  await call(`${T.A}/tiebreakers?name=tb.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(TB_POOL) });
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  const tid = (await T.detail()).tournament.id;
  const tbGets = () => pg.reqs.filter((r) => r.method === 'GET' && r.url === `${BASE}${T.A}/tiebreakers`).length;

  // 09: the pool is fetched on load, and again only when it changes
  await openLive(pg, T);
  await bumpAndRefresh(pg, T); // the first refresh can still be the hub's own Bye Room save
  const tb0 = tbGets();
  for (let i = 0; i < 3; i++) await bumpAndRefresh(pg, T);
  await check('09 tiebreakers: refreshes that find other changes don\'t fetch the pool again ' + CHG.tbOnce, () => tbGets() === tb0 || [tb0, tbGets()]);
  await call(`${T.A}/tiebreakers?name=late.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tossups: [{ question: 'Late tiebreaker.', answer: 'Late' }] }) });
  await pg.refresh();
  await check('09 tiebreakers: a question added elsewhere is fetched once, on the next refresh ' + CHG.tbOnce, async () => {
    await pg.waitJs(`[...document.querySelectorAll('.roundline .muted')].some((x) => x.textContent.replace(/\\s+/g, ' ').trim() === 'Tiebreakers 0/4 used')`, 'the new count');
    return tbGets() === tb0 + 1 || [tb0, tbGets()];
  });

  // 50: the timing, with the hub's long timers run 100 times faster (30 s -> 0.3 s);
  // the public page off, so the mark never reads Updating (which checks more often)
  await call(T.A, { method: 'POST', json: { published: false } });
  const { identifier } = await pg.S('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const st = window.setTimeout;
    window.setTimeout = (fn, ms, ...a) => (ms >= 30000 ? st(fn, ms / 100, ...a) : st(fn, ms, ...a)); })();` });
  try {
    const revAsks = () => pg.reqs.filter((r) => r.method === 'GET' && new RegExp(`/a/${T.secret}\\?rev=\\d+$`).test(r.url));
    const gapsOf = (list) => list.slice(1).map((r, i) => Math.round((r.ts - list[i].ts) * 1000));
    const near = (got, want) => got.length === want.length && got.every((g, i) => g >= want[i] - 40 && g <= want[i] + 300);
    const n0 = revAsks().length;
    await openLive(pg, T);
    let asks = await until(() => { const x = revAsks().slice(n0); return x.length >= 6 && x; }, 'six checks', 15000);
    await check('50 refresh: checks every 30 s, then every 60 s after 2 quiet checks and 120 s after 4 (run 100x faster)', () =>
      near(gapsOf(asks.slice(0, 6)), [300, 600, 600, 1200, 1200]) || gapsOf(asks.slice(0, 6)));
    // a change: the check that finds it redraws, and the checks go back to every 30 s
    await markView(pg);
    const n1 = revAsks().length;
    await T.startRound(T.rooms[0], 1);
    await pg.waitJs(`!document.querySelector('#viewbody').dataset.mark`, 'the redraw on the next check', 8000);
    asks = await until(() => { const x = revAsks().slice(n1 - 1); return x.length >= 4 && x; }, 'checks after the change', 8000);
    await check('50 refresh: a check that finds a change redraws, and the checks go back to every 30 s', () => {
      const g = gapsOf(asks);
      return (g.slice(-2).every((x) => x <= 300 + 300)) || g;
    });
    // back to the tab: at once
    await until(() => { const x = revAsks(); return x.length >= 3 && gapsOf(x.slice(-3)).every((g) => g >= 1100) && x; }, 'the checks to slow down', 15000);
    const n2 = revAsks().length;
    const t0 = Date.now();
    await pg.refresh();
    await check('50 refresh: coming back to the tab checks at once', async () => {
      await until(() => revAsks().length > n2, 'the check');
      return Date.now() - t0 < 600 || Date.now() - t0;
    });
    // an input with the focus: no check, no redraw, until it loses it
    await pg.js(`document.querySelector('#curround').focus(); true`);
    await markView(pg);
    await T.startRound(T.rooms[1], 1);
    const n3 = revAsks().length;
    await pg.refresh();
    await sleep(800);
    await check('50 refresh: while an input has the focus, no check and no redraw', async () => ((await viewKept(pg)) && revAsks().length === n3) || revAsks().length - n3);
    await pg.js(`document.activeElement.blur(); true`);
    await pg.refresh();
    await check('50 refresh: once it loses the focus, the waiting change shows', async () => {
      await pg.waitJs(`!document.querySelector('#viewbody').dataset.mark`, 'the redraw');
      return (await pg.ntext('.railtoggle')) === 'Auto-advance 2/2 started' || await pg.ntext('.railtoggle');
    });
    // a check that fails leaves the screen as it was, with no error
    await dismiss(pg);
    await markView(pg);
    await withRules(pg, [{ stage: 'Request', test: (m, u) => m === 'GET' && new RegExp(`/a/${T.secret}(\\?rev=\\d+)?$`).test(u), act: () => ({ fail: 'ConnectionRefused' }) }], async () => {
      await call(T.A, { method: 'POST', json: { name: 'Refresh' } });
      const n4 = revAsks().length;
      await pg.refresh();
      await until(() => revAsks().length > n4, 'the failing check');
      await sleep(300);
      await check('50 refresh: a check that fails changes nothing on screen and shows no error', async () =>
        (await viewKept(pg)) && !(await pg.js(`document.querySelector('#msg').classList.contains('show')`)));
    });
    await pg.refresh();
    await check('50 refresh: the next check after it works redraws as usual', () => pg.waitJs(`!document.querySelector('#viewbody').dataset.mark`, 'the redraw'));

    // 05: Page off; Updating while the change waits for the rebuild, checked at least once a minute; then Up to date with no reload
    await check('05 mark: "Page off" while the public page is off', async () => (await pg.ntext('#pubmark')) === 'Page off');
    await call(T.A, { method: 'POST', json: { published: true } });
    await pg.refresh();
    await check('05 mark: turned on, it reads Updating, "Viewers see this change within a couple of minutes"', () =>
      pg.waitJs(`(() => { const m = document.querySelector('#pubmark'); return m && m.textContent.trim() === '○Updating' && m.title === 'Viewers see this change within a couple of minutes'; })()`, 'Updating'));
    const n5 = revAsks().length;
    asks = await until(() => { const x = revAsks().slice(n5); return x.length >= 7 && x; }, 'checks while Updating', 15000);
    await check('05 mark: while it reads Updating the hub checks at least once a minute (never 120 s)', () => gapsOf(asks).slice(2).every((g) => g <= 600 + 300) || gapsOf(asks));
    await markView(pg);
    await untilTicked(async () => (await T.detail()).tournament.pub_dirty === 0, 'the rebuild');
    d1(`UPDATE tournaments SET pub_built = ${Date.now() - 120000} WHERE id = ${tid}`);
    await check('05 mark: once rebuilt (and viewers\' copies old), it turns to Up to date on its own, no reload, no redraw', async () => {
      await pg.waitJs(`(() => { const m = document.querySelector('#pubmark'); return m && m.textContent.trim() === '✓Up to date' && m.title === 'Viewers see your latest changes'; })()`, 'Up to date', 10000);
      return viewKept(pg);
    });
    // the Setup view: nothing redrawn; only the mark, and only checked while it reads Updating
    await pg.click('[data-view="setup"]');
    await pg.waitJs(`!!document.querySelector('#setupsec')`, 'Setup');
    await pg.js(`document.querySelector('#setupsec').dataset.mark = 'kept'; true`);
    const n6 = revAsks().length;
    await call(T.A, { method: 'POST', json: { name: 'Refresh' } });
    await sleep(1500);
    await check('50 refresh: in Setup, with the mark Up to date, no checks at all', () => revAsks().length === n6 || revAsks().length - n6);
    await pg.reload();
    await pg.waitJs(`!!document.querySelector('.hubtab')`, 'the hub again');
    if (!(await pg.exists('#setupsec'))) await pg.click('[data-view="setup"]');
    await pg.waitJs(`!!document.querySelector('#setupsec') && /Updating/.test(document.querySelector('#pubmark').textContent)`, 'Setup, Updating');
    await pg.js(`document.querySelector('#setupsec').dataset.mark = 'kept'; true`);
    await untilTicked(async () => (await T.detail()).tournament.pub_dirty === 0, 'the rebuild');
    d1(`UPDATE tournaments SET pub_built = ${Date.now() - 120000} WHERE id = ${tid}`);
    await check('05 mark: in Setup too it turns to Up to date on its own, the step left as it was', async () => {
      await pg.waitJs(`/Up to date/.test(document.querySelector('#pubmark').textContent)`, 'Up to date in Setup', 10000);
      return pg.js(`document.querySelector('#setupsec').dataset.mark === 'kept'`);
    });
  } finally { await pg.S('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }

  // 05: with qb-td-live serving the page: pending, spreading, and failing (the Worker's live mark, as it would send it)
  const withLive = async (live, fn) => withRules(pg, [{ stage: 'Response', test: (m, u) => m === 'GET' && new RegExp(`/a/${T.secret}(\\?rev=\\d+)?$`).test(u),
    act: (text) => { const j = JSON.parse(text); if (j.tournament) { j.tournament.live = live; j.tournament.pub_dirty = 0; } else if (j.unchanged) { j.live = live; j.pub_dirty = 0; } return JSON.stringify(j); } }],
  async () => { await openLive(pg, T); return fn(); });
  const mark = () => pg.js(`(() => { const m = document.querySelector('#pubmark'); return m.textContent.trim() + ' | ' + m.title; })()`);
  await withLive({ state: 'pending' }, async () => check('05 mark: a qb-td-live deploy pending reads Updating', async () => (await mark()).startsWith('○Updating') || await mark()));
  await withLive({ state: 'ok', at: Date.now() }, async () => check('05 mark: just deployed (within 30 s) still reads Updating', async () => (await mark()).startsWith('○Updating') || await mark()));
  await withLive({ state: 'ok', at: Date.now() - 60000 }, async () => check('05 mark: deployed a while ago reads Up to date', async () => (await mark()).startsWith('✓Up to date') || await mark()));
  await withLive({ state: 'failing', since: Date.now() - 120000 }, async () => check('05 mark: deploys failing reads ⚠ Delayed, and says why', async () =>
    (await mark()) === '⚠Delayed | Publishing to the public page is failing and retrying on its own. Viewers may see older results until it lands.' || await mark()));
});

// results for two pools of four (pools2): pool A's Alpha and Delta finish 2–1, Alpha ahead
// on points per 20 without overtime, Delta ahead with it (their game went to overtime)
const POOL_RESULTS = {
  'Alpha|Hotel': { gets: { Alpha: 10, Hotel: 5 }, bonus: 5 }, 'Delta|Echo': { gets: { Delta: 10, Echo: 5 } },
  'Alpha|Echo': { gets: { Alpha: 10, Echo: 5 } }, 'Delta|Hotel': { gets: { Hotel: 8, Delta: 7 } },
  'Alpha|Delta': { ot: true }, 'Echo|Hotel': { gets: { Echo: 8, Hotel: 5 } },
  'Bravo|Golf': { gets: { Bravo: 10, Golf: 5 } }, 'Charlie|Foxtrot': { gets: { Charlie: 9, Foxtrot: 5 } },
  'Bravo|Foxtrot': { gets: { Bravo: 10, Foxtrot: 6 } }, 'Charlie|Golf': { gets: { Charlie: 8, Golf: 5 } },
  'Bravo|Charlie': { gets: { Bravo: 9, Charlie: 7 } }, 'Foxtrot|Golf': { gets: { Foxtrot: 8, Golf: 6 } },
};
function poolGame(round, a, b) {
  const r = POOL_RESULTS[[a, b].sort().join('|')];
  if (r && r.ot) {
    // tied 100–100 after 20 tossups; in overtime Alpha negs and Delta gets it
    const ai = a === 'Alpha' ? 0 : 1;
    const plan = Array.from({ length: 20 }, (_, i) => (i < 5 ? [[0, 0, 10]] : i < 10 ? [[1, 0, 10]] : null));
    plan.push([[ai, 0, -5], [1 - ai, 0, 10]]);
    return matchQbj({ round, teams: [a, b], players: gamesOf([a, b]), plan });
  }
  const g = r ? r.gets : { [a]: 6, [b]: 4 };
  return quickGame(round, [a, b], gamesOf([a, b]), [g[a], g[b]], r && r.bonus ? { bonus: r.bonus } : {});
}
const slotTeams = (s) => Object.fromEntries(s.phases.flatMap((ph) => ph.rounds.flatMap((r) => r.games.flatMap((g) => [g.a, g.b])))
  .filter((x) => x && x.from).map((x) => [x.from, x.team]));
const openLabels = (s) => [...new Set(JSON.stringify(s).match(/"label":"[A-Z]\d+"/g) || [])].map((x) => x.slice(9, -1)).sort();

section('brackets', '11 13 14 15 17 36 41 44 45 49: pools and playoffs: Live now, Advance all, the playoff fill, the stats pick', async () => {
  const pg = hub;
  const T = await newTournament('Brackets');
  for (const n of ['Hall 1', 'Hall 2', 'Hall 3', 'Hall 4', 'Spare']) await T.addRoom(n);
  await T.roster(ROSTER8);
  const sched = buildSchedule('pools2', TEAMS8, T.rooms.slice(0, 4).map((b) => ({ name: b.room_name, bucket: b.id })));
  await T.schedule(sched);
  for (const n of [1, 2, 3]) await T.packet(n);
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  const games = (n) => sched.phases.flatMap((p) => p.rounds).find((r) => r.round === n).games;
  const roomOf = (g) => T.rooms[g.room];
  const up = (g, n, body = poolGame(n, g.a.team, g.b.team), name = `Round_${n}_${g.a.team}_${g.b.team}.qbj`) => T.upload(roomOf(g), n, name, body);

  await openLive(pg, T);
  // 17: the bracket note under the switch
  await dismiss(pg);
  await pg.click('#autoadv');
  await msgIs(pg, 'Rounds open automatically', false);
  await check('17 auto-advance with brackets: "Brackets will advance to the next round once each room has started the current round."', () =>
    pg.waitJs(`/Brackets will advance to the next round once each room has started the current round\\./.test(document.querySelector('.liverail').textContent)`, 'the note'));
  await dismiss(pg);
  await pg.click('#autoadv');
  await msgIs(pg, 'Rounds open when you advance them', false);

  // round 1: Hall 1 in, Hall 2 still playing (an unfinished upload), Pool B started nowhere
  const [g11, g12] = games(1);
  await up(g11, 1);
  await up(g12, 1, readerFile(poolGame(1, g12.a.team, g12.b.team), { progress: { at: 8, of: 20 } }), `Round_1_${g12.a.team}_${g12.b.team}.qbtd.json`);
  for (const g of [g11, g12]) await T.startRound(roomOf(g), 1);
  await openLive(pg, T);
  const heads = () => pg.js(`[...document.querySelectorAll('.bcols > .bgroup')].map((g) => g.querySelector('.bhead').textContent.replace(/\\s+/g, ' ').trim())`);
  await check('11 brackets: a heading per pool with x/y in and how many are in progress, and "No game this round" last', async () =>
    JSON.stringify(await heads()) === JSON.stringify(['Pool A 1/2 in · 1 in progress', 'Pool B 0/2 in', 'No game this round']) || await heads());
  await check('11 brackets: a room with no game this round (Spare) goes under it, with no mark', async () => {
    const r = await pg.js(`[...document.querySelectorAll('.bcols > .bgroup:not([data-bracket]) .brow')].map((x) => [x.classList.contains('bye'), x.querySelector('.broom').firstChild.textContent, x.querySelector('.bgame .bteams').textContent.trim(), x.querySelector('.lmark').textContent.trim()])`);
    return JSON.stringify(r) === JSON.stringify([[true, 'Spare', 'No game this round', '']]) || r;
  });
  await check('11 brackets: an unfinished upload\'s row has a pie and "· on question 8 of 20"', async () => {
    const r = await pg.js(`(() => { const x = document.querySelector('.brow[data-room="${roomOf(g12).id}"]'); return [!!x.querySelector('.lmark .upie'), x.querySelector('.lmark').title, x.querySelector('.bteams').textContent.replace(/\\s+/g, ' ').trim()]; })()`);
    return (r[0] && r[1] === 'In progress: on question 8 of 20 at the last upload' && r[2].endsWith('· on question 8 of 20')) || r;
  });
  await check('17 brackets rail: "Auto-advance 2/4 started", and each pool\'s line', async () => {
    const lines = await pg.js(`[...document.querySelectorAll('.bline')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim() + ' | ' + ((l.querySelector('[data-advbracket]') || {}).title || ''))`);
    return ((await pg.ntext('.railtoggle')) === 'Auto-advance 2/4 started'
      && JSON.stringify(lines) === JSON.stringify(['Pool A rd 1 2/2 started Advance | Open round 2 for Pool A', 'Pool B rd 1 0/2 started Advance | Open round 2 for Pool B'])) || [await pg.ntext('.railtoggle'), lines];
  });
  // Advance all, twice: to the last round of the prelims
  await pg.watchTexts('#advall');
  await dismiss(pg);
  await pg.click('#advall');
  await check('13 advance all: "Advancing…" while it works, then "Round 2"', async () => {
    await msgIs(pg, 'Round 2', false);
    return (await pg.seenTexts()).includes('Advancing…') || await pg.seenTexts();
  });
  await pg.waitJs(`/round 2 of 3/.test(document.querySelector('.roundline').textContent)`, 'round 2');
  await dismiss(pg);
  await pg.click('#advall');
  await msgIs(pg, 'Round 3', false);
  await pg.waitJs(`/round 3 of 3/.test(document.querySelector('.roundline').textContent)`, 'round 3');
  await check('14 per-bracket advance: on a pool\'s last prelim round its line reads "last" in place of Advance', async () => {
    const l = await pg.js(`[...document.querySelectorAll('.bline')].map((x) => [!!x.querySelector('[data-advbracket]'), (x.querySelector('[title="Last round of this phase"]') || {}).textContent])`);
    return JSON.stringify(l) === JSON.stringify([[false, 'last'], [false, 'last']]) || l;
  });
  await check('13 advance all: crossing into the next phase, "Opens Playoffs for every bracket."', async () =>
    (await pg.ntext('#advall')) === 'Advance all to round 4' && (await pg.ntext('.liverail .railblock')).includes('Opens Playoffs for every bracket.') || await pg.ntext('.liverail .railblock'));
  await check('13 advance all: "No packet for round 4 yet"', async () =>
    (await pg.js(`[...document.querySelectorAll('.liverail .warntext')].map((x) => x.textContent.trim())`)).includes('No packet for round 4 yet'));

  // the prelims all in but one game a pool; Hall 2's round 1 game finished
  await up(g12, 1);
  const held = [games(3).find((g) => g.a.team === 'Echo' || g.b.team === 'Echo'), games(3).find((g) => g.a.team === 'Foxtrot' || g.b.team === 'Foxtrot')];
  for (const n of [1, 2, 3]) for (const g of games(n)) if (!(n === 1 && (g === g11 || g === g12)) && !held.includes(g)) await up(g, n);
  // 36: unsaved schedule edits hold the fill
  await openLive(pg, T);
  await pg.click('[data-view="setup"]');
  await pg.waitJs(`!!document.querySelector('[data-step="sched"]')`, 'Setup');
  await pg.click('[data-step="sched"]');
  await pg.waitJs(`!!document.querySelector('.sgslot[data-ref]')`, 'the editor');
  await dragOnto(pg, `document.querySelectorAll('.sgslot[data-ref]')[0]`, `document.querySelectorAll('.sgslot[data-ref]')[2]`);
  await pg.waitJs(`/1 unsaved change/.test(document.querySelector('.sgbar').textContent)`, 'an unsaved change');
  pg.answers.push(true);
  await pg.click('[data-view="live"]');
  await pg.waitJs(`!!document.querySelector('.biground')`, 'Live');
  for (const g of held) await up(g, 3);
  await bumpAndRefresh(pg, T);
  const posts = await quietFor(pg, 1200, (m, u) => m === 'POST' && u.endsWith('/schedule'));
  await check('36 auto-fill: with unsaved schedule edits the pools wait, though their games are all in', async () =>
    posts.length === 0 && openLabels(await T.savedSchedule()).length === 8 || [posts.length, openLabels(await T.savedSchedule())]);
  pg.answers.push(true);
  await pg.click('[data-view="setup"]');
  await pg.waitJs(`!!document.querySelector('#scheddiscard')`, 'the editor');
  await pg.click('#scheddiscard');
  await pg.waitJs(`/Saved/.test(document.querySelector('.sgbar').textContent)`, 'discarded');
  await pg.click('[data-view="live"]');
  await pg.waitJs(`!!document.querySelector('.biground')`, 'Live');

  // 36: a game that can't be read holds its pool; the other fills; the next refresh tries again
  const otFile = (await T.detail()).files.find((f) => /Round_3_(Alpha_Delta|Delta_Alpha)/.test(f.filename));
  await withRules(pg, [
    { stage: 'Request', test: (m, u) => m === 'GET' && /\/games\?ids=/.test(u), act: () => ({ status: 500, body: { error: 'Something went wrong on the server. Please try again.' } }) },
    { stage: 'Request', test: (m, u) => m === 'GET' && u.includes(encodeURIComponent(otFile.r2_key)), act: () => ({ status: 500, body: { error: 'Something went wrong on the server. Please try again.' } }) },
  ], async () => {
    await bumpAndRefresh(pg, T);
    const s = await until(async () => { const x = await T.savedSchedule(); return !openLabels(x).some((l) => l[0] === 'B') && x; }, 'pool B filled', 15000).catch(() => null);
    await check('36 auto-fill: pool B, all read, fills', () => !!s);
    await check('36 auto-fill: pool A, one game unreadable, waits instead of filling from incomplete standings ' + CHG.unreadable, async () =>
      JSON.stringify(openLabels(await T.savedSchedule())) === JSON.stringify(['A1', 'A2', 'A3', 'A4']) || openLabels(await T.savedSchedule()));
  });
  await dismiss(pg);
  await bumpAndRefresh(pg, T);
  const filled = await until(async () => { const x = await T.savedSchedule(); return !openLabels(x).length && x; }, 'pool A filled', 15000).catch(() => null);
  await check('36 auto-fill: the next refresh reads it and fills pool A, and says so ' + CHG.unreadable, async () =>
    !!filled && (await pg.waitJs(`/Filled the playoff slots from pool A/.test(document.querySelector('#msg').textContent)`, 'the notice').catch(() => false)) === true);
  const slots = filled ? slotTeams(filled) : {};
  await check('36 auto-fill: pool A ranked without overtime: Alpha (2–1, more points per 20 in regulation) first, Delta second ' + CHG.rankOT, () =>
    (slots.A1 === 'Alpha' && slots.A2 === 'Delta') || slots);
  await check('36 auto-fill: the rest of the slots as the standings put them', () =>
    JSON.stringify(['A3', 'A4', 'B1', 'B2', 'B3', 'B4'].map((k) => slots[k])) === JSON.stringify(['Echo', 'Hotel', 'Bravo', 'Charlie', 'Foxtrot', 'Golf']) || slots);

  // the playoffs: round 4 in, then the schedule's last round
  await dismiss(pg);
  await pg.click('#advall');
  await msgIs(pg, 'Round 4', false);
  const s4 = filled || await T.savedSchedule();
  const g4 = s4.phases[1].rounds.find((r) => r.round === 4).games;
  for (const g of g4) await T.upload(T.rooms[g.room], 4, `Round_4_${g.a.team}_${g.b.team}.qbj`, quickGame(4, [g.a.team, g.b.team], gamesOf([g.a.team, g.b.team]), [7, 5]));
  await openLive(pg, T);
  await check('11 brackets: the playoff round lists Championship and Consolation by name', async () =>
    JSON.stringify((await heads()).map((h) => h.split(' ')[0])) === JSON.stringify(['Championship', 'Consolation', 'No']) || await heads());
  await dismiss(pg);
  await pg.click('#advall');
  await msgIs(pg, 'Round 5', false);
  await check('15 last round with brackets: a grayed "Advance all", and "Round 5 is the last round in the schedule."', () =>
    pg.waitJs(`(() => { const b = document.querySelector('.liverail button.advance'); return b && b.disabled && b.textContent.trim() === 'Advance all' && !document.querySelector('#advall')
      && /Round 5 is the last round in the schedule\\./.test(document.querySelector('.liverail').textContent); })()`, 'grayed'));

  // 41: which games the stats use
  const pick = () => pg.js(`[...document.querySelectorAll('#statrange label')].map((l) => { const i = l.querySelector('input');
    return (i.checked ? '[x] ' : '[ ] ') + (i.disabled ? '(off) ' : '') + l.textContent.replace(/\\s+/g, ' ').trim(); })`);
  await check('41 stats pick: By stage (each stage with games, and its rounds), or Finished rounds only (and how far)', async () =>
    JSON.stringify(await pick()) === JSON.stringify(['[x] By stage', '[x] Prelims (rounds 1–3)', '[x] Playoffs (rounds 4–5)', '[ ] Finished rounds only (Rounds 1–4)']) || await pick());
  const compute = async () => {
    await pg.click('#calc');
    await pg.waitJs(`!document.querySelector('#statsec').hidden && /games/.test(document.querySelector('#statsnote').textContent) && !/ready$/.test(document.querySelector('#statsnote').textContent)`, 'stats', 30000);
  };
  await compute();
  await check('41 stats pick: every stage: "16 games in these stats"', async () => (await pg.text('#statsnote')) === '16 games in these stats' || await pg.text('#statsnote'));
  await pg.click('[data-statph="1"]');
  await check('41 stats pick: Prelims only: "12 games in Prelims", the table follows', async () =>
    (await pg.waitJs(`document.querySelector('#statsnote').textContent === '12 games in Prelims'`, 'the note').catch(() => false))
      && (await statsGamesCount(pg)) === 12 || [await pg.text('#statsnote'), await statsGamesCount(pg)]);
  const menuDl = async (id) => {
    await pg.click('#dlmenu');
    await pg.waitJs(`!document.querySelector('#dlpanel').hidden`, 'the menu');
    return download(pg, `document.querySelector('#${id}').click(); true`);
  };
  {
    const f4 = await menuDl('dlyft4');
    await check('44 yellowfruit 4: <slug>-yf4.yft, a YellowFruit 4 file (one JSON object)', () => {
      const y = JSON.parse(f4.bytes.toString('utf8'));
      return (f4.name === `${T.slug}-yf4.yft` && Array.isArray(y.objects)) || f4.name;
    });
    await check('44 yellowfruit 4: follows the pick (12 games)', () =>
      JSON.parse(f4.bytes.toString('utf8')).objects[0].phases.flatMap((p) => p.rounds.flatMap((r) => r.matches)).length === 12);
    const y3 = (await menuDl('dlyft3')).bytes.toString('utf8').split('\n').map((l) => JSON.parse(l));
    await check('45 yellowfruit 3: follows the pick (12 games)', () => y3[5].length === 12 || y3[5].length);
    const z = await readZip(new Uint8Array((await menuDl('dlzip')).bytes));
    await check('48 qbj bundle: follows the pick (rounds 1–3 only)', () =>
      JSON.stringify([...new Set(z.map((e) => e.name.split('/')[0]))].sort()) === JSON.stringify(['roster.qbj', 'round-1', 'round-2', 'round-3']) || z.map((e) => e.name));
  }
  const uploads = (await T.detail()).files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error).length; // 17: one game uploaded twice
  await pg.click('#dlmenu');
  await pg.waitJs(`!document.querySelector('#dlpanel').hidden`, 'the menu');
  await pg.click('#rebuild');
  await check('49 rebuild: posts every readable upload whatever the pick, and says so', async () => {
    await msgIs(pg, `Stats data rebuilt (${uploads} games); the public page picks it up within a minute`, false);
    return pg.js(`document.querySelector('#dlpanel').hidden`);
  });
  await pg.click('[data-statph="0"]');
  await check('41 stats pick: with no stage picked, "No games are in the stages and rounds picked." and Download off', async () =>
    (await pg.waitJs(`document.querySelector('#statsnote').textContent === 'No games in these stats'`, 'the note').catch(() => false))
      && (await pg.ntext('#statsout')) === 'No games are in the stages and rounds picked.' && await pg.js(`document.querySelector('#dlmenu').disabled`));
  await pg.click('input[name="statmode"][value="finished"]');
  await check('41 stats pick: Finished rounds only: "16 games in rounds 1–4", the stage boxes off', async () =>
    (await pg.waitJs(`document.querySelector('#statsnote').textContent === '16 games in rounds 1–4'`, 'the note').catch(() => false))
      && await pg.js(`[...document.querySelectorAll('[data-statph]')].every((x) => x.disabled)`) || await pg.text('#statsnote'));
  await bumpAndRefresh(pg, T);
  await check('41 stats pick: the choice stays through a redraw', async () =>
    (await pick()).includes('[x] Finished rounds only (Rounds 1–4)') || await pick());
  // a team renamed after its games: its rounds still count as finished
  await T.roster(ROSTER8.map((t) => (t.name === 'Golf' ? { ...t, name: 'Golf Club', formerNames: ['Golf'] } : t)));
  {
    const s = await T.savedSchedule();
    renameTeams(s, { Golf: 'Golf Club' });
    await T.schedule(s);
  }
  await openLive(pg, T);
  await check('41 stats pick: after a team is renamed, Finished rounds only still counts its games (rounds 1–4) ' + CHG.finishedRenamed, async () =>
    (await pick()).includes('[ ] Finished rounds only (Rounds 1–4)') || await pick());
});
const statsGamesCount = async (pg) => Object.values(await statsGames(pg)).reduce((n, x) => n + x.length, 0);

/* ---------- the Finals: a round robin of four, then a final between its 1st and 2nd ---------- */

const FTEAMS = ['Ants', 'Bees', 'Cats', 'Dogs'];
/**
 * A game from who got what. spec: {gets: {team: n}} tossups each team got
 * (player 1, a 10-point bonus each), {negs: {team: n}} tossups with only a
 * neg by that team (player 2), the rest of the 20 dead, and {ot: team}: tied
 * after 20, an overtime tossup the other team negs and this one gets.
 */
function specGame(round, a, b, spec) {
  const side = (n) => (n === a ? 0 : 1);
  const plan = [];
  for (const [team, n] of Object.entries(spec.gets || {})) for (let i = 0; i < n; i++) plan.push([[side(team), 0, 10]]);
  for (const [team, n] of Object.entries(spec.negs || {})) for (let i = 0; i < n; i++) plan.push([[side(team), 1, -5]]);
  while (plan.length < 20) plan.push(null);
  if (spec.ot) plan.push([[1 - side(spec.ot), 0, -5], [side(spec.ot), 0, 10]]);
  return matchQbj({ round, teams: [a, b], players: [PLAY(a), PLAY(b)], plan });
}
/**
 * A tournament of four teams in two rooms: `kind` (a round robin, or 'rr2'
 * twice over, each time its own stage), optionally a Tiebreakers round, then a Finals round whose
 * game is "1st in <from>" against "2nd in <from>" (as the editor's Add
 * phase makes it), or two named teams (`final`). Packets for every round,
 * the format set, started.
 */
async function finalsDay(name, { teams = FTEAMS, kind = 'rr', tiebreak = false, from = 'Round robin', stages = [], final = null } = {}) {
  const T = await newTournament(name);
  for (const n of ['Room 1', 'Room 2']) await T.addRoom(n);
  await T.roster(teams.map((n) => ({ name: n, players: PLAY(n) })));
  const s = buildSchedule(kind, teams, T.rooms.map((b) => ({ name: b.room_name, bucket: b.id })));
  // phases (and their brackets) renamed: stages[i] names phase i
  stages.forEach((n, i) => { s.phases[i].name = n; for (const b of s.brackets) if (b.phase === i) b.name = n; });
  let next = Math.max(...s.phases.flatMap((ph) => ph.rounds.map((r) => r.round))) + 1;
  if (tiebreak) s.phases.push({ name: 'Tiebreakers', rounds: [{ round: next++, games: [], byes: [] }], meet: 1, kind: 'tiebreak' });
  const [fa, fb] = final ? final.map((team) => ({ team })) : [{ label: `1st in ${from}` }, { label: `2nd in ${from}` }];
  s.phases.push({ name: 'Finals', kind: 'final', meet: 1, rounds: [{ round: next, games: [{ room: 0, a: fa, b: fb, bracket: 'FN' }], byes: [] }] });
  s.brackets.push({ key: 'FN', name: 'Finals', phase: s.phases.length - 1 });
  const saved = await T.schedule(s);
  if (saved.status !== 200) throw new Error('schedule: ' + JSON.stringify(saved.body));
  for (let n = 1; n <= next; n++) await T.packet(n);
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  const F = {
    T, s, finalRound: next,
    // the games of phase p as the schedule has them: {round, a, b, room}
    games: (p = 0) => s.phases[p].rounds.flatMap((r) => r.games.map((g) => ({ round: r.round, a: g.a.team, b: g.b.team, room: T.rooms[g.room] }))),
    // a game up through its room, its result from res (keyed by the two teams, sorted)
    up: (g, res, names = {}) => {
      const [a, b] = [names[g.a] || g.a, names[g.b] || g.b];
      const spec = res[[g.a, g.b].sort().join('|')];
      if (!spec) throw new Error('no result for ' + g.a + ' v ' + g.b);
      const to = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [names[k] || k, v]));
      const named = { gets: to(spec.gets), negs: to(spec.negs), ot: spec.ot && (names[spec.ot] || spec.ot) };
      return T.upload(g.room, g.round, `Round_${g.round}_${g.room.id}_${Math.random().toString(36).slice(2, 6)}.qbj`, specGame(g.round, a, b, named));
    },
    // the saved schedule's final: [a, b] as {team, from} or {label}
    savedFinal: async () => { const x = await T.savedSchedule(); const g = x.phases.find((ph) => ph.kind === 'final').rounds[0].games[0]; return [g.a, g.b]; },
  };
  return F;
}
const noteLines = (pg) => pg.js(`[...document.querySelectorAll('.playoffnote')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())`);
const statRows = (pg) => pg.js(`(() => { const t = document.querySelector('#statsout table'); return t ? [...t.rows].slice(1).map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())) : []; })()`);
const compute = async (pg) => {
  await pg.click('#calc');
  await pg.waitJs(`!document.querySelector('#statsec').hidden && / in /.test(document.querySelector('#statsnote').textContent)`, 'the stats', 30000);
};
const menuDownload = async (pg, id) => {
  if (await pg.js(`document.querySelector('#dlpanel').hidden`)) await pg.click('#dlmenu');
  await pg.waitJs(`!document.querySelector('#dlpanel').hidden`, 'the Download menu');
  return download(pg, `document.querySelector('#${id}').click(); true`);
};

// Ants and Bees finish 2–1. In regulation Ants has more points per 20 (Bees
// negged once); their own game went to overtime, which Bees won, so with
// overtime counted Bees would be ahead.
const RES_OT = {
  'Ants|Dogs': { gets: { Ants: 8, Dogs: 4 } }, 'Ants|Cats': { gets: { Ants: 8, Cats: 4 } },
  'Ants|Bees': { gets: { Ants: 5, Bees: 5 }, ot: 'Bees' },
  'Bees|Dogs': { gets: { Bees: 8, Dogs: 4 } }, 'Bees|Cats': { gets: { Bees: 8, Cats: 9 }, negs: { Bees: 1 } },
  'Cats|Dogs': { gets: { Cats: 4, Dogs: 8 } },
};

section('finals', '37 38 42: the Finals fill on their own, ranked without overtime; the Finals note; Compute leaves overtime out', async () => {
  const pg = hub;
  const F = await finalsDay('Finals Day');
  const { T } = F;
  const games = F.games();
  for (const g of games.slice(0, -1)) await F.up(g, RES_OT);
  await openLive(pg, T);
  await check('37 finals: one round robin game short, nothing is filled and no Finals note', async () =>
    JSON.stringify(await F.savedFinal()) === JSON.stringify([{ label: '1st in Round robin' }, { label: '2nd in Round robin' }]) && !(await noteLines(pg)).length);
  await F.up(games[games.length - 1], RES_OT);
  await dismiss(pg);
  await pg.refresh();
  await check('37 finals: the last game in, the next refresh fills the Finals and says so', async () => { await msgIs(pg, 'Filled the Finals from Round robin', false); return true; });
  await check('37 finals: 1st and 2nd ranked without overtime: Ants (more points per 20 in regulation) 1st, Bees 2nd ' + CHG.rankOT, async () => {
    const f = await F.savedFinal();
    return JSON.stringify(f) === JSON.stringify([{ team: 'Ants', from: '1st in Round robin' }, { team: 'Bees', from: '2nd in Round robin' }]) || f;
  });
  await check('38 finals note: "Finals · Round robin: Ants and Bees were tied at 2–1, so points per 20 decided their places." ' + CHG.rankOT, async () =>
    JSON.stringify(await noteLines(pg)) === JSON.stringify(['Finals Round robin: Ants and Bees were tied at 2–1, so points per 20 decided their places.']) || await noteLines(pg));
  // Compute, with the game that went to overtime
  await compute(pg);
  await check('42 compute: teams by winning percentage, then points per 20; overtime out of PP20TUH and TUH ' + CHG.computeOT, async () => {
    const rows = (await statRows(pg)).map((r) => [r[1], r[2], r[3], r[4], r[r.length - 2]]);
    return JSON.stringify(rows) === JSON.stringify([['Ants', '2', '1', '140', '60'], ['Bees', '2', '1', '138.33', '60'], ['Cats', '1', '2', '113.33', '60'], ['Dogs', '1', '2', '106.67', '60']]) || rows;
  });
  await check('42 compute: the overtime tossup still counts in the buzz columns (Bees 22 tens, one -5 each)', async () => {
    const rows = await statRows(pg);
    const head = await pg.js(`[...document.querySelector('#statsout table').rows[0].cells].map((c) => c.textContent.trim())`);
    const col = (v) => head.indexOf(v);
    const of = (n) => rows.find((r) => r[1] === n);
    return (of('Bees')[col('10')] === '22' && of('Bees')[col('-5')] === '1' && of('Ants')[col('-5')] === '1' && of('Ants')[col('10')] === '21') || [head, rows];
  });
  // the final's round: Live now shows the pair the fill put there
  await pg.fill('#curround', String(F.finalRound), ['input']);
  await pg.click('#setround');
  await pg.waitJs(`/Round ${F.finalRound} \\//.test(document.querySelector('.biground').textContent)`, 'the final\'s round');
  await check('37 finals: in the final\'s round, Live now has Ants v Bees in Room 1, and no game in Room 2 ' + CHG.rankOT, async () => {
    const r = (await liveRows(pg)).map((x) => [x.room, x.game]);
    return JSON.stringify(r) === JSON.stringify([['Room 1', 'Ants v Bees'], ['Room 2', 'No game this round']]) || r;
  });
  await T.upload(T.rooms[0], F.finalRound, `Round_${F.finalRound}_Ants_Bees.qbj`, specGame(F.finalRound, 'Ants', 'Bees', { gets: { Ants: 7, Bees: 5 } }));
  await bumpAndRefresh(pg, T);
  await check('38 finals note: gone once a finals game is in', async () => !(await noteLines(pg)).length || await noteLines(pg));
});

section('finals-held', '38 39: a Finals tie waiting for the TD (a Tiebreakers round), its button, and the note after', async () => {
  const pg = hub;
  const F = await finalsDay('Finals Held', { tiebreak: true });
  const { T } = F;
  // Ants and Bees 2–1 with the same points per 20 (21 gets each), no overtime
  const RES = {
    'Ants|Dogs': { gets: { Ants: 8, Dogs: 4 } }, 'Ants|Cats': { gets: { Ants: 8, Cats: 4 } }, 'Ants|Bees': { gets: { Ants: 5, Bees: 6 } },
    'Bees|Dogs': { gets: { Bees: 8, Dogs: 4 } }, 'Bees|Cats': { gets: { Bees: 7, Cats: 8 } }, 'Cats|Dogs': { gets: { Cats: 4, Dogs: 8 } },
  };
  for (const g of F.games()) await F.up(g, RES);
  await openLive(pg, T);
  const button = `document.querySelector('.playoffnote [data-fillpool="F:Round robin"]')`;
  await check('39 finals held: the note says who is tied for which places, that they are level on points per 20 too, and what filling now does ' + CHG.levelNote, async () => {
    await pg.waitJs(`!!${button}`, 'the waiting tie');
    return JSON.stringify(await noteLines(pg)) === JSON.stringify(['Finals Round robin: Ants and Bees are tied at 2–1 for 1st and 2nd place. They have the same points per 20, so filling now places them by name. Fill by name'])
      || await noteLines(pg);
  });
  await check('39 finals held: the button says what it does, "Fill by name" ' + CHG.levelNote, async () => (await pg.js(`${button}.textContent.trim()`)) === 'Fill by name');
  await check('39 finals held: nothing filled while it waits', async () => JSON.stringify(await F.savedFinal()) === JSON.stringify([{ label: '1st in Round robin' }, { label: '2nd in Round robin' }]));
  await dismiss(pg);
  await pg.js(`${button}.click(); true`);
  await check('39 finals held: the button fills them, by name (Ants 1st), and says so', async () => {
    await msgIs(pg, 'Filled the Finals from Round robin', false);
    const f = await F.savedFinal();
    return (f[0].team === 'Ants' && f[1].team === 'Bees') || f;
  });
  await check('38 finals note: "…were tied at 2–1 with the same points per 20, so they were placed by name." ' + CHG.levelNote, async () =>
    JSON.stringify(await noteLines(pg)) === JSON.stringify(['Finals Round robin: Ants and Bees were tied at 2–1 with the same points per 20, so they were placed by name.']) || await noteLines(pg));
});

section('finals-level-ot', '37 38: teams level on regulation points per 20, one game decided in overtime', async () => {
  const pg = hub;
  const F = await finalsDay('Finals Level OT');
  const { T } = F;
  // as RES_OT, but Bees without its neg: level with Ants in regulation (140 each)
  const RES = { ...RES_OT, 'Bees|Cats': { gets: { Bees: 8, Cats: 9 } } };
  for (const g of F.games()) await F.up(g, RES);
  await openLive(pg, T);
  await check('37 finals: teams level on regulation points per 20 still fill the Finals on their own', async () => { await msgIs(pg, 'Filled the Finals from Round robin', false); return true; });
  // a single round robin has no table of its own on the public page, only
  // its standings, which list Bees (who won in overtime) ahead of Ants:
  // the Finals follow that order, and the note says so rather than "by name"
  await check('37 finals: level teams fill in the public standings\' order, Bees 1st and Ants 2nd', async () => {
    const f = await F.savedFinal();
    return (f[0].team === 'Bees' && f[1].team === 'Ants') || f;
  });
  await check('38 finals note: "…were tied at 2–1 with the same points per 20, so they kept their order in the standings."', async () =>
    JSON.stringify(await noteLines(pg)) === JSON.stringify(['Finals Round robin: Bees and Ants were tied at 2–1 with the same points per 20, so they kept their order in the standings.']) || await noteLines(pg));
});

section('finals-rename', '37: the Finals fill after a team is renamed in another tab, in a hub opened before the rename', async () => {
  const pg = hub;
  const F = await finalsDay('Finals Rename');
  const { T } = F;
  // Ants 3–0, Bees 2–1, Cats 1–2, Dogs 0–3
  const RES = {
    'Ants|Dogs': { gets: { Ants: 8, Dogs: 4 } }, 'Ants|Cats': { gets: { Ants: 8, Cats: 4 } }, 'Ants|Bees': { gets: { Ants: 8, Bees: 6 } },
    'Bees|Dogs': { gets: { Bees: 8, Dogs: 4 } }, 'Bees|Cats': { gets: { Bees: 8, Cats: 4 } }, 'Cats|Dogs': { gets: { Cats: 8, Dogs: 4 } },
  };
  const games = F.games();
  const lastGame = games.find((g) => [g.a, g.b].sort().join('|') === 'Ants|Bees');
  for (const g of games.filter((x) => x !== lastGame)) await F.up(g, RES);
  await openLive(pg, T);
  // another tab renames Bees: the roster with its former name, and the schedule with it (as the hub's roster save does)
  await T.roster(FTEAMS.map((n) => (n === 'Bees' ? { name: 'Bees United', players: PLAY('Bees'), formerNames: ['Bees'] } : { name: n, players: PLAY(n) })));
  const renamed = await T.savedSchedule();
  renameTeams(renamed, { Bees: 'Bees United' });
  await T.schedule(renamed);
  await pg.refresh();
  await soft(pg.waitJs(`[...document.querySelectorAll('.lrow .lgame')].some((x) => /Bees United/.test(x.textContent))`, 'the rename', 10000));
  // the last game comes in under the new name
  await F.up(lastGame, RES, { Bees: 'Bees United' });
  await dismiss(pg);
  await pg.refresh();
  await check('37 finals after a rename: the hub opened before it fills the Finals on its next refresh ' + CHG.renameFill, async () => { await msgIs(pg, 'Filled the Finals from Round robin', false); return true; });
  await check('37 finals after a rename: Ants 1st, Bees United 2nd ' + CHG.renameFill, async () => {
    const f = await F.savedFinal();
    return (f[0].team === 'Ants' && f[1].team === 'Bees United') || f;
  });
});

section('finals-same', '37: a double round robin\'s Finals seed on both times through', async () => {
  const pg = hub;
  const F = await finalsDay('Finals Double', { kind: 'rr2', from: 'Round robin 2' });
  const { T } = F;
  // the first time through Ants wins all three; the second, Bees does and Cats beats Ants:
  // over both Bees is 5–1 and Ants 4–2; the second alone has Bees 3–0 and Cats 2–1
  const win = (w, l) => ({ gets: { [w]: 8, [l]: 4 } });
  const R1 = { 'Ants|Bees': win('Ants', 'Bees'), 'Ants|Cats': win('Ants', 'Cats'), 'Ants|Dogs': win('Ants', 'Dogs'),
    'Bees|Cats': win('Bees', 'Cats'), 'Bees|Dogs': win('Bees', 'Dogs'), 'Cats|Dogs': win('Cats', 'Dogs') };
  const R2 = { 'Ants|Bees': win('Bees', 'Ants'), 'Ants|Cats': win('Cats', 'Ants'), 'Ants|Dogs': win('Ants', 'Dogs'),
    'Bees|Cats': win('Bees', 'Cats'), 'Bees|Dogs': win('Bees', 'Dogs'), 'Cats|Dogs': win('Cats', 'Dogs') };
  for (const g of F.games(0)) await F.up(g, R1);
  for (const g of F.games(1)) await F.up(g, R2);
  await openLive(pg, T);
  await check('37 finals, double round robin: filled once both times through are in', async () => { await msgIs(pg, 'Filled the Finals from Round robin 2', false); return true; });
  await check('37 finals, double round robin: seeded on both times through, Bees (5–1) against Ants (4–2) ' + CHG.samePools, async () => {
    const f = await F.savedFinal();
    return (f[0].team === 'Bees' && f[1].team === 'Ants') || f;
  });
});

section('report-escape', '10 42 46 47: names with special characters, in the hub and in the HTML report', async () => {
  const pg = hub;
  const ODD = ['Ants', 'Bees <b>2</b>', 'Cats & Co', 'Dogs'];
  // a double round robin, each time through its own stage (the report heads each), and a final the report lists as a result
  const F = await finalsDay('Odd Names', { teams: ODD, kind: 'rr2', stages: ['Prelims <i>x</i>', 'Second <u>go</u>'], final: ['Bees <b>2</b>', 'Ants'] });
  const { T } = F;
  for (const g of [...F.games(0), ...F.games(1)]) {
    await T.upload(g.room, g.round, `Round_${g.round}_${g.room.id}.qbj`, specGame(g.round, g.a, g.b, { gets: { [g.a]: 7, [g.b]: 5 } }));
  }
  await T.upload(T.rooms[0], F.finalRound, `Round_${F.finalRound}_final.qbj`, specGame(F.finalRound, 'Bees <b>2</b>', 'Ants', { gets: { 'Bees <b>2</b>': 9, Ants: 3 } }));
  await openLive(pg, T);
  await check('10 live now: a team name with markup in it shows as text', async () => {
    const r = await pg.js(`[...document.querySelectorAll('.lrow .lgame')].map((x) => [x.textContent.replace(/\\s+/g, ' ').trim(), x.querySelectorAll('b, i, u').length])`);
    return (r.some(([t]) => t.includes('Bees <b>2</b>')) && r.every(([, n]) => n === 0)) || r;
  });
  await compute(pg);
  await check('42 compute: the stats table shows the names as text', async () => {
    const names = (await statRows(pg)).map((r) => r[1]);
    return (JSON.stringify([...names].sort()) === JSON.stringify([...ODD].sort()) && (await pg.js(`document.querySelectorAll('#statsout b, #statsout i, #statsout u').length`)) === 0) || names;
  });
  const z = await menuDownload(pg, 'dlreport');
  const pages = Object.fromEntries((await readZip(new Uint8Array(z.bytes))).map((e) => [e.name.replace(`${T.slug}_`, ''), new TextDecoder().decode(e.data)]));
  const st = pages['standings.html'] || '';
  const heads = (st.match(/<h2>[^]*?<\/h2>/g) || []).map((h) => norm(h.replace(/<\/?h2>|&nbsp;/g, '')));
  await check('46 html report zip: <slug>-report.zip, six pages', () => (z.name === `${T.slug}-report.zip` && Object.keys(pages).length === 6) || [z.name, Object.keys(pages)]);
  await check('46 html report: stage names with markup head their tables as text ' + CHG.reportEscape, () =>
    (heads.includes('Prelims &lt;i&gt;x&lt;/i&gt;') && heads.includes('Second &lt;u&gt;go&lt;/u&gt;: Total')) || heads);
  await check('46 html report: the Finals result names its teams as text ' + CHG.reportEscape, () =>
    /Bees &lt;b&gt;2&lt;\/b&gt; def\. Ants/.test(st) || (st.match(/<li>[^]*?<\/li>/g) || []).map(norm));
  await check('46 html report: no page of the six carries a name\'s markup as markup ' + CHG.reportEscape, () => {
    const raw = Object.keys(pages).filter((k) => ['<b>2</b>', '<i>x</i>', '<u>go</u>'].some((x) => pages[k].includes(x)));
    return raw.length === 0 || raw;
  });
  const six = await downloadsFrom(pg, `(() => { if (document.querySelector('#dlpanel').hidden) document.querySelector('#dlmenu').click();
    document.querySelector('#dlreportfiles').click(); return true; })()`, 6);
  await check('47 html report files: the same six pages as separate files, named <slug>_<page>.html', () =>
    (six.length === 6 && six.every((f) => f.name.startsWith(T.slug + '_') && pages[f.name.slice(T.slug.length + 1)] === f.bytes.toString('utf8'))) || six.map((f) => f.name));
  await check('47 html report files: no name\'s markup as markup there either ' + CHG.reportEscape, () =>
    !six.some((f) => ['<b>2</b>', '<i>x</i>', '<u>go</u>'].some((x) => f.bytes.toString('utf8').includes(x))) || six.map((f) => f.name));

  // one stage played in two pools: the report heads each pool's table with
  // the pool's name (a page of its own path in report.js), as text too
  {
    const P = await newTournament('Odd Pools');
    for (const n of ['Room 1', 'Room 2', 'Room 3', 'Room 4']) await P.addRoom(n);
    await P.roster(ROSTER8);
    const ps = buildSchedule('pools2', TEAMS8, P.rooms.map((b) => ({ name: b.room_name, bucket: b.id })));
    const POOLS = { A: 'Pool <i>A</i>', B: 'Pool <s>B</s>' };
    for (const b of ps.brackets) if (POOLS[b.key]) b.name = POOLS[b.key];
    const saved = await P.schedule(ps);
    if (saved.status !== 200) throw new Error('schedule: ' + JSON.stringify(saved.body));
    await P.packet(1);
    await P.settings({ gameFormat: 'acf', statsSeen: true });
    await P.start();
    for (const g of ps.phases[0].rounds.find((r) => r.round === 1).games) {
      await P.upload(P.rooms[g.room], 1, `Round_1_${g.a.team}_${g.b.team}.qbj`, poolGame(1, g.a.team, g.b.team));
    }
    await openLive(pg, P);
    await compute(pg);
    const pz = await menuDownload(pg, 'dlreport');
    const ppages = Object.fromEntries((await readZip(new Uint8Array(pz.bytes))).map((e) => [e.name.replace(`${P.slug}_`, ''), new TextDecoder().decode(e.data)]));
    const h3 = ((ppages['standings.html'] || '').match(/<h3>[^]*?<\/h3>/g) || []).map((h) => norm(h.replace(/<\/?h3>|&nbsp;/g, '')));
    await check('46 html report: pool names with markup head their pools\' tables as text', () =>
      (h3.includes('Pool &lt;i&gt;A&lt;/i&gt;') && h3.includes('Pool &lt;s&gt;B&lt;/s&gt;')) || h3);
    await check('46 html report: no page carries a pool name\'s markup as markup', () => {
      const raw = Object.keys(ppages).filter((k) => ['<i>A</i>', '<s>B</s>'].some((x) => ppages[k].includes(x)));
      return raw.length === 0 || raw;
    });
  }
});

section('room-gone', '21 30 31: a room deleted in another tab while Fix stats is open here, and its uploads after', async () => {
  const pg = hub;
  const T = await newTournament('Room Gone');
  for (const n of ['Room 1', 'Room 2']) await T.addRoom(n);
  await T.roster(ROSTER4);
  const sched = buildSchedule('rr', TEAMS4, T.rooms.map((b) => ({ name: b.room_name, bucket: b.id })));
  await T.schedule(sched);
  for (const n of [1, 2, 3]) await T.packet(n);
  await T.settings({ gameFormat: 'acf', statsSeen: true });
  await T.start();
  const [R1, R2] = T.rooms;
  const pairIn = (i) => { const g = sched.phases[0].rounds[0].games.find((x) => x.room === i); return [g.a.team, g.b.team]; };
  const players = (p) => p.map((n) => ROSTER4.find((r) => r.name === n).players);
  await T.upload(R1, 1, 'Round_1_one.qbj', quickGame(1, pairIn(0), players(pairIn(0)), [6, 4]));
  const f2 = await T.upload(R2, 1, 'Round_1_two.qbj', quickGame(1, pairIn(1), players(pairIn(1)), [5, 3]));
  await openLive(pg, T);
  await openCell(pg, R2.id, 1);
  await pg.click(`[data-fixbuzz="${f2.id}"]`);
  await pg.waitJs(`!!document.querySelector('[data-fswap="0:0"]')`, 'Fix stats');
  await pg.fill('[data-fswap="0:0"]', players(pairIn(1))[0][1], ['change']);
  await pg.waitJs(`!!document.querySelector('#fixsave') && !document.querySelector('#fixsave').disabled`, 'a change to save');
  // another tab deletes Room 2 meanwhile
  await call(`${T.A}/buckets/${R2.id}`, { method: 'DELETE' });
  const n0 = (await T.detail()).files.length;
  await dismiss(pg);
  await pg.click('#fixsave');
  await check('31 save correction: the room deleted in another tab meanwhile, the save is refused in red and nothing goes up', async () => {
    await pg.waitJs(`document.querySelector('#msg').classList.contains('show') && document.querySelector('#msg').classList.contains('bad')`, 'an error');
    const said = await pg.text('#msg');
    if (said !== 'This game\'s room is gone, so it cannot be fixed here') {
      note(`Fix stats, room deleted in another tab: Save correction says "${said}" (the Worker's answer for the dead room link), not "This game's room is gone, so it cannot be fixed here"; that message and Edit in MODAQ's "That game cannot be edited" need a room missing from this tab's own list, which no file the hub shows can have`);
    }
    return (await T.detail()).files.length === n0;
  });
  await dismiss(pg);
  await openLive(pg, T);
  await check('21 room gone: the room leaves Live now, the grid, Add a game and Record a forfeit', async () => {
    await pg.click('#fftoggle');
    await pg.waitJs(`!!document.querySelector('#ffpanel')`, 'the forfeit panel');
    const seen = await pg.js(`({ live: [...document.querySelectorAll('.lrow .lroom')].map((x) => x.textContent), grid: [...document.querySelectorAll('.ugrid td.uroom')].map((x) => x.textContent),
      add: [...document.querySelectorAll('#addroom option')].map((x) => x.textContent), ff: [...document.querySelectorAll('#ffroom option')].map((x) => x.textContent) })`);
    await pg.click('#ffcancel');
    return Object.values(seen).every((l) => JSON.stringify(l) === '["Room 1"]') || seen;
  });
  await compute(pg);
  await check('42 compute: the deleted room\'s game still counts (2 games)', async () => (await pg.text('#statsnote')) === '2 games in these stats' || await pg.text('#statsnote'));
  // a room's own picker lists "#<id>" for a room since deleted (admin.js cellPanel), but the
  // panel shows only the files of a room still there: say so if that changes
  const shown = await pg.js(`[...document.querySelectorAll('.ugrid button.umark')].length`);
  if (!(await pg.js(`[...document.querySelectorAll('select[data-movefile] option')].some((o) => /^#\\d+$/.test(o.textContent))`))) {
    note(`room deleted with an upload in it: the hub lists that upload nowhere (${shown} grid cell(s), all Room 1's), so it can't be moved to another room, downloaded or deleted from the hub, and the room picker's "#<id>" choice for a deleted room never shows; Compute still counts the game`);
  }
});

/* ===== more sections go above this line ===== */

/* ---------- run ---------- */

for (const s of sections) {
  if (ONLY && !ONLY.has(s.id)) continue;
  console.log(`\n== ${s.id}: ${s.title}`);
  try { await s.fn(); } catch (e) { ok(`${s.id}: the section ran to its end`, false, e.stack || e.message); }
}
ok('no page asked a production host', prodHits.length === 0, prodHits);
{
  const other = pageErrors.filter((e) => !knownErrors.some((re) => re.test(e)));
  ok('no uncaught error on any page (besides the reported ones noted above)', other.length === 0, other);
}
for (const n of notes) console.log('NOTE', n);
console.log(`\n${passed} checks passed, ${failed.length} failed (${((Date.now() - started) / 1000).toFixed(0)}s)`);
try { ws.close(); } catch (e) { /* closed */ }
{
  // Chrome and wrangler gone before their folders are, or Chrome writes its profile back
  const gone = kids.map((k) => new Promise((res) => {
    if (k.exitCode !== null || k.signalCode !== null) { res(); return; }
    k.once('exit', res);
    setTimeout(res, 5000);
  }));
  stopAll();
  await Promise.all(gone);
}
try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
process.exit(failed.length ? 1 : 0);

