// ui_full_reader.js — the moderator's reader page (read.html) driven in a
// real headless Chrome against a local Worker, feature by feature, checking
// what the moderator and the TD see: the page's text and colours, which
// buttons are on, the dialogs, what the page sends the Worker, and what the
// hub then shows. Feature ids (R01…) follow the reader inventory; a check
// whose expected result moved with an approved 10/19 change says so in its
// name: [changed: <changelog line>].
//
// It starts everything it needs, on fresh local state, and stops it all at
// the end: the dev Worker (`wrangler dev --local`, no secrets, nothing
// remote), a static server for app/, and Chrome. Every hostname but
// localhost is unresolvable in that Chrome (--host-resolver-rules), so no
// page can reach production, GitHub, MODAQ's font CDN or the .docx parser.
// Packets are JSON only.
//
//   node tests/ui_full_reader.js
//
// Ports: 9651 Worker, 9652 pages, 9653 Chrome DevTools, 9659 the Worker's
// inspector (QBTD_PORT_BASE=<n> moves them to n, n+1, n+2, n+8).
//
// Before vs after: QBTD_ROOT points the Worker and the pages at another
// checkout's worker/ and app/ (this checkout's wrangler and this file's
// fixtures are used either way). For the code before the 10/19-10/20
// changes:
//   git worktree add /tmp/qbtd-before 173a444
//   QBTD_ROOT=/tmp/qbtd-before node tests/ui_full_reader.js > before.txt
//   node tests/ui_full_reader.js > after.txt
//   diff before.txt after.txt
// Checks tagged [changed: …] are expected to differ; any other difference
// is a regression (or a fix). The run never stops at a failed section: each
// section is checked on its own, so an older checkout runs to the end too.
//
// Using a stack that is already running (tools/e2e_stack.mjs): pass
// QBTD_BASE, QBTD_PAGES and QBTD_PERSIST as it prints them. QBTD_ONLY=<regex>
// runs only the sections whose id or title matches (fixtures are always
// made). CHROME=<path> picks another Chrome.
//
// A check named "known bug" pins a defect as it reproduces today: it passes
// while the defect is there, says "fixed" once the right result shows, and
// fails on anything else.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../app/engine/zip.js';

/* ====================================================================== */
/* configuration                                                          */
/* ====================================================================== */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.QBTD_ROOT || REPO);
const PORT0 = Number(process.env.QBTD_PORT_BASE || 9651);
const OWN_STACK = !process.env.QBTD_BASE;
const BASE = process.env.QBTD_BASE || `http://127.0.0.1:${PORT0}`;
const PAGES = process.env.QBTD_PAGES || `http://localhost:${PORT0 + 1}`;
const CDP_PORT = Number(process.env.QBTD_CDP_PORT || PORT0 + 2);
const INSPECT_PORT = PORT0 + 8;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WRANGLER = path.join(REPO, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const ONLY = process.env.QBTD_ONLY ? new RegExp(process.env.QBTD_ONLY, 'i') : null;
const tmp = mkdtempSync(path.join(tmpdir(), 'qbtd-reader-'));
const STATE = OWN_STACK ? path.join(tmp, 'state') : process.env.QBTD_PERSIST;
const DL = path.join(tmp, 'downloads');
const FX = path.join(tmp, 'fixtures');
mkdirSync(DL, { recursive: true });
mkdirSync(FX, { recursive: true });
if (!STATE) { console.error('QBTD_PERSIST is needed with QBTD_BASE (the running Worker\'s --persist-to folder)'); process.exit(2); }
for (const p of [PORT0, PORT0 + 1, CDP_PORT, INSPECT_PORT]) {
  if (OWN_STACK && (p < 9600 || p > 9699)) { console.error('ports must be 9600-9699'); process.exit(2); }
}
const started = Date.now();
const wenv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };

// the changelog lines (Release Notes for 10/19/2026) a check's result moved with
const CH = {
  oneRequest: '[ PERFORMANCE ] The reader page loads a room link with one request rather than four.',
  serverFail: '[ MISC ] When the server fails, pages say "Something went wrong on the server. Please try again." instead of reporting a network error.',
  prodServer: '[ SECURITY ] On qbsuite.github.io, pages always use the qb-td server, even when a shared link names another one.',
  renameRoom: '[ SCHEDULE ] Renaming a room renames its line on the saved schedule, also when the room was matched by name.',
  editNumbers: '[ LIVE HUB ] Edit in MODAQ keeps the question numbers of replaced and added questions, so a corrected game matches the original.',
  testLinks: '[ SECURITY ] Room Test links no longer contain the admin link\'s secret.',
};
const changed = (key) => ` [changed: ${CH[key]}]`;

/* ====================================================================== */
/* tally                                                                  */
/* ====================================================================== */

let passed = 0;
let failed = 0;
let knownBugs = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); return true; }
  failed++;
  console.log('FAIL', name, extra === undefined ? '' : typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 1500));
  return false;
}
// a defect pinned as it reproduces today (see the header)
function known(name, got, buggy, fixed) {
  if (got === buggy) { knownBugs++; passed++; console.log('  ok', 'known bug:', name, '(still reproduces)'); return; }
  if (got === fixed) { passed++; console.log('  ok', 'known bug:', name, '(fixed)'); return; }
  failed++;
  console.log('FAIL', 'known bug:', name, JSON.stringify({ got, buggy, fixed }));
}
async function check(name, fn) {
  let v;
  try { v = await fn(); } catch (e) { return ok(name, false, e.message); }
  return ok(name, v === true, v);
}
const tabs = []; // every tab, for recovery after a stalled page
async function section(id, title, fn) {
  if (ONLY && !ONLY.test(id + ' ' + title)) return;
  console.log(`\n${id}. ${title}`);
  try { await fn(); } catch (e) {
    ok(`${id}: the section ran to its end`, false, (e && e.stack) || String(e));
    // a page that stopped answering would take every later section with it
    for (const t of tabs) {
      const alive = await Promise.race([t.S('Runtime.evaluate', { expression: '1', returnByValue: true }).then(() => true, () => true), sleep(5000).then(() => false)]);
      if (!alive) { console.log(`     (a tab stopped answering at ${t.here}; it is replaced by a fresh one)`); await t.recover(); }
      else if (t.onPaused) await t.unintercept().catch(() => {});
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000, every = 50) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(every);
  }
}

/* ====================================================================== */
/* the local stack                                                        */
/* ====================================================================== */

const kids = [];
let pageServer = null;
function stopAll() {
  for (const k of kids) {
    try { process.kill(-k.pid, 'SIGTERM'); } catch (e) { try { k.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  }
  if (pageServer) try { pageServer.close(); } catch (e) { /* closed */ }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
function servePages(root, port) {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let file = path.join(root, decodeURIComponent(u.pathname));
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { /* missing */ }
      if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
const wranglerArgs = (args) => [WRANGLER, ...args, '--persist-to', STATE];
function d1(sql) {
  const out = execFileSync(process.execPath, wranglerArgs(['d1', 'execute', 'qb-td', '--local', '--json', '--command', sql]),
    { cwd: path.join(ROOT, 'worker'), env: wenv, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
function r2put(key, body) {
  const f = path.join(tmp, 'r2-' + Math.random().toString(36).slice(2));
  writeFileSync(f, body);
  execFileSync(process.execPath, wranglerArgs(['r2', 'object', 'put', 'qb-td-data/' + key, '--local', '--file', f, '--content-type', 'application/json']),
    { cwd: path.join(ROOT, 'worker'), env: wenv, stdio: 'ignore' });
  rmSync(f, { force: true });
}
async function startStack() {
  if (!OWN_STACK) return;
  if (!existsSync(path.join(ROOT, 'worker', 'worker.js')) || !existsSync(path.join(ROOT, 'app', 'read.html'))) {
    throw new Error('QBTD_ROOT has no worker/worker.js or app/read.html: ' + ROOT);
  }
  mkdirSync(STATE, { recursive: true });
  execFileSync(process.execPath, wranglerArgs(['d1', 'execute', 'qb-td', '--local', '--file', 'schema.sql']),
    { cwd: path.join(ROOT, 'worker'), env: wenv, stdio: 'ignore' });
  const log = (await import('node:fs')).openSync(path.join(tmp, 'wrangler_dev.log'), 'a');
  kids.push(spawn(process.execPath, wranglerArgs(['dev', '--local', '--port', String(PORT0), '--ip', '127.0.0.1', '--test-scheduled',
    '--var', `ALLOWED_ORIGIN:${PAGES}`, '--show-interactive-dev-session=false', '--inspector-port', String(INSPECT_PORT)]),
  { cwd: path.join(ROOT, 'worker'), env: wenv, stdio: ['ignore', log, log], detached: true }));
  pageServer = await servePages(path.join(ROOT, 'app'), PORT0 + 1);
  await until(async () => (await fetch(BASE + '/')).ok, 'the dev Worker (see ' + path.join(tmp, 'wrangler_dev.log') + ')', 120000, 300);
}

/* ====================================================================== */
/* Worker calls                                                           */
/* ====================================================================== */

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; }
  let res;
  for (let i = 0; ; i++) {
    try { res = await fetch(BASE + p, { ...opts, headers }); break; } catch (e) { if (i >= 2) throw e; await sleep(300); }
  }
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(),
    cors: res.headers.get('access-control-allow-origin') };
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
// worker.js testToken over secretHash: the TD's Test link token
const testTokenOf = (admin) => sha('qbtd-test:' + sha('qbtd-cred:' + admin));

/* ====================================================================== */
/* Chrome over the DevTools protocol                                      */
/* ====================================================================== */

let ws;
let msgId = 0;
const pending = new Map();
const browserListeners = [];
const downloads = new Map(); // guid -> {name, done}
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { res, rej, method })),
    sleep(60000).then(() => { throw new Error('no reply to ' + method + ' within 60 s'); }),
  ]);
}
async function startChrome() {
  const udd = path.join(tmp, 'profile');
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-features=Translate,OptimizationHints,MediaRouter',
    // nothing but this machine: no production, GitHub, font CDN or .docx parser
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    'about:blank'], { stdio: 'ignore', detached: true });
  kids.push(proc);
  const wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl,
    'Chrome on port ' + CDP_PORT, 20000, 100);
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.rej(new Error(p.method + ': ' + m.error.message)); else p.res(m.result);
    } else if (m.method) for (const fn of [...browserListeners]) fn(m);
  };
  browserListeners.push((m) => {
    if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, done: false });
    if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') {
      const d = downloads.get(m.params.guid);
      if (d) d.done = true;
    }
  });
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL, eventsEnabled: true });
}

const q = (s) => JSON.stringify(s);
const workerPath = (u) => u.slice(BASE.length).replace(/^\/b\/[a-z0-9]{10,40}/, '/b/:s').replace(/^\/a\/[a-z0-9]{10,40}/, '/a/:a');

class Tab {
  constructor(sessionId, targetId) {
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.reqs = [];        // every request the page sent: {id, method, url, postData, status, t}
    this.dialogs = [];     // every alert/confirm: {type, message}
    this.answers = [];     // how the next confirms are answered (default: OK)
    this.errors = [];      // uncaught page errors
    this.onPaused = null;  // Fetch.requestPaused handler
    this.here = 'about:blank';
    browserListeners.push((m) => this.event(m));
  }
  S(method, params) { return send(method, params, this.sessionId); }
  event(m) {
    if (m.sessionId !== this.sessionId) return;
    const p = m.params;
    if (m.method === 'Network.requestWillBeSent') {
      const e = { id: p.requestId, method: p.request.method, url: p.request.url, postData: p.request.postData, type: p.type || '', t: Date.now() };
      if (p.request.hasPostData && p.request.postData === undefined) {
        e.bodyP = this.S('Network.getRequestPostData', { requestId: p.requestId }).then((x) => x.postData, () => null);
      }
      this.reqs.push(e);
    } else if (m.method === 'Network.responseReceived') {
      const e = [...this.reqs].reverse().find((x) => x.id === p.requestId);
      if (e) e.status = p.response.status;
    } else if (m.method === 'Network.loadingFailed') {
      const e = [...this.reqs].reverse().find((x) => x.id === p.requestId);
      if (e) e.failed = p.errorText || true;
    } else if (m.method === 'Page.javascriptDialogOpening') {
      this.dialogs.push({ type: p.type, message: p.message });
      const accept = p.type === 'confirm' && this.answers.length ? this.answers.shift() : true;
      this.S('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      this.errors.push(this.here + ': ' + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) {
      this.here = p.frame.url;
    } else if (m.method === 'Fetch.requestPaused') {
      if (this.onPaused) this.onPaused(p);
      else this.S('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
  }
  async init() {
    await this.S('Page.enable');
    await this.S('Runtime.enable');
    await this.S('DOM.enable');
    await this.S('Network.enable', { maxPostDataSize: 65536 });
    await this.S('Network.setCacheDisabled', { cacheDisabled: true });
    await this.S('Page.setInterceptFileChooserDialog', { enabled: true });
    await this.S('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.desktop();
    return this;
  }
  desktop() { return this.S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }); }
  async js(expression) {
    const r = await this.S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  loaded() {
    return new Promise((res) => {
      const fn = (m) => {
        if (m.sessionId === this.sessionId && m.method === 'Page.loadEventFired') {
          browserListeners.splice(browserListeners.indexOf(fn), 1);
          res();
        }
      };
      browserListeners.push(fn);
    });
  }
  async goto(url) {
    const done = this.loaded();
    await this.S('Page.navigate', { url });
    await Promise.race([done, sleep(30000).then(() => { throw new Error('no load of ' + url); })]);
  }
  async reload() {
    const done = this.loaded();
    await this.S('Page.reload', { ignoreCache: true });
    await Promise.race([done, sleep(30000).then(() => { throw new Error('no reload'); })]);
  }
  // a wait that, on a timeout, says what the page showed
  async waitJs(expr, label, ms = 15000) {
    try { return await until(() => this.js(expr), label, ms); } catch (e) {
      let seen = '';
      try { seen = await this.js(`((document.querySelector('#msg') || {}).textContent || '') + ' || ' + (document.body ? document.body.innerText.slice(0, 500) : '')`); } catch (e2) { /* gone */ }
      throw new Error(e.message + ' -- page: ' + seen);
    }
  }
  text(sel) { return this.js(`((document.querySelector(${q(sel)}) || {}).textContent || '')`); }
  exists(sel) { return this.js(`!!document.querySelector(${q(sel)})`); }
  // shown: in the layout (not display:none anywhere up the tree)
  shown(sel) { return this.js(`(() => { const e = document.querySelector(${q(sel)}); return !!e && e.getClientRects().length > 0; })()`); }
  click(sel) {
    return this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
  }
  // a real mouse click at the middle of the element (it lands on whatever is on top there)
  async mouse(sel) {
    const box = await this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error('nothing matches ' + sel);
    await this.mouseAt(box.x, box.y);
  }
  async mouseAt(x, y) {
    await this.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  // typed into a field, as a keyboard would
  async type(sel, text) {
    await this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.focus();
      if (e.select) e.select(); return true; })()`);
    await this.S('Input.insertText', { text });
  }
  // a <select> picked from its list
  pick(sel, value) {
    return this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
      e.value = ${q(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value === ${q(value)}; })()`);
  }
  async key(key, code, keyCode, modifiers = 0) {
    await this.S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await this.S('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }
  mark() { return this.reqs.length; }
  // the page's requests to the Worker since a mark, preflights left out: 'GET /b/:s/load'
  worker(since = 0) {
    return this.reqs.slice(since).filter((r) => r.url.startsWith(BASE) && r.method !== 'OPTIONS' && r.type !== 'Preflight')
      .map((r) => r.method + ' ' + workerPath(r.url));
  }
  workerReqs(since = 0) {
    return this.reqs.slice(since).filter((r) => r.url.startsWith(BASE) && r.method !== 'OPTIONS' && r.type !== 'Preflight');
  }
  async body(r) { return r.postData !== undefined ? r.postData : r.bodyP ? r.bodyP : null; }
  async block(urls) { await this.S('Network.setBlockedURLs', { urls }); }
  async intercept(patterns, handler) {
    this.onPaused = handler;
    await this.S('Fetch.enable', { patterns });
  }
  async unintercept() {
    this.onPaused = null;
    await this.S('Fetch.disable');
  }
  async storage() { return this.js('JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))').then(JSON.parse); }
  // a page that stopped answering the protocol: closed, and this Tab
  // carries on in a fresh one (same profile, so the device's games stay)
  async recover() {
    try { await send('Target.closeTarget', { targetId: this.targetId }); } catch (e) { /* gone */ }
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.onPaused = null;
    await this.init();
  }
}
async function newTab() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const t = await new Tab(sessionId, targetId).init();
  tabs.push(t);
  return t;
}
async function downloadFrom(tab, sel) {
  const before = new Set(downloads.keys());
  await tab.click(sel);
  const guid = await until(() => [...downloads.keys()].find((g) => !before.has(g) && downloads.get(g).done), 'a download from ' + sel, 30000);
  return { name: downloads.get(guid).name, bytes: readFileSync(path.join(DL, guid)) };
}

// a file put in a page's file input, as the file picker would
async function setFiles(tab, sel, files) {
  const { root } = await tab.S('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await tab.S('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) throw new Error('no file input ' + sel);
  await tab.S('DOM.setFileInputFiles', { nodeId, files });
}
const writeFx = (name, data) => { const f = path.join(FX, name); writeFileSync(f, data); return f; };

/* ====================================================================== */
/* the reader page and MODAQ, as a moderator works them                   */
/* ====================================================================== */

const enc = encodeURIComponent;
// every page load names the local Worker and turns qb-td-live off
const readUrl = (secret, extra = '') => `${PAGES}/read.html?b=${secret}${extra}&server=${enc(BASE)}&live=off`;
const hubUrl = (admin) => `${PAGES}/index.html?a=${admin}&server=${enc(BASE)}&live=off`;

// the colour var(--bad) and var(--ok) resolve to, set against an element's own
const colourIs = (tab, sel, cssVar) => tab.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return false;
  const probe = document.createElement('span'); probe.style.color = 'var(${cssVar})'; document.body.appendChild(probe);
  const want = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(e).color === want; })()`);
const red = (tab, sel) => colourIs(tab, sel, '--bad');
const green = (tab, sel) => colourIs(tab, sel, '--ok');

// the room page before a game: settled once the picker and its panels have drawn
async function openRoom(tab, secret, extra = '', ready = 'teams') {
  await tab.goto(readUrl(secret, extra));
  if (ready === 'teams') {
    await tab.waitJs(`!document.querySelector('#teamrow').hidden && document.querySelector('#teama').options.length > 1`, 'the team row of ' + secret);
  } else if (ready === 'msg') {
    await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'a message on ' + secret);
  }
}
// what the room page shows, as one string (to compare two loads)
const roomView = (tab) => tab.js(`[document.title, document.querySelector('header').innerText, document.querySelector('#msg').textContent,
  document.querySelector('.rstart').innerText, document.querySelector('#teama').value, document.querySelector('#teamb').value].join('\\n')`);
const roundButtons = (tab) => tab.js(`[...document.querySelectorAll('#roundrows .rnd')].map((e) => ({ n: e.textContent, tag: e.tagName,
  live: e.classList.contains('live'), sel: e.classList.contains('sel'), off: e.classList.contains('off'), title: e.title }))`);
const starterCols = (tab) => tab.js(`[...document.querySelectorAll('#starters .lineup')].map((l) => ({
  team: l.dataset.side, count: l.querySelector('.count').textContent, none: l.querySelector('.count').classList.contains('none'),
  players: [...l.querySelectorAll('[data-player]')].map((b) => ({ name: b.dataset.player, on: b.classList.contains('on'),
    bench: !!b.querySelector('.bench'), pressed: b.getAttribute('aria-pressed') })) }))`);
const devGames = (tab) => tab.js(`[...document.querySelectorAll('.devgames > div')].map((d) => ({ text: d.querySelector('.muted').textContent,
  link: d.querySelector('a').textContent, href: d.querySelector('a').getAttribute('href') }))`);

async function startGame(tab) {
  await tab.click('#start');
  await tab.waitJs(`document.body.classList.contains('reading') && !!document.querySelector('#modaq .ms-CommandBar')`, 'MODAQ to open', 20000);
  return new URL(await tab.js('location.href')).searchParams.get('g');
}

// MODAQ (1.41.1) inside the reader
const mq = {
  // a command bar button by its label (Options, View, Actions, Upload to qb-td, Help...)
  async cmd(tab, label) {
    await tab.js(`(() => { const b = [...document.querySelectorAll('#modaq .ms-CommandBar button')]
      .find((x) => (x.querySelector('.ms-Button-label') || {}).textContent === ${q(label)});
      if (!b) throw new Error('no command ' + ${q(label)}); b.click(); return true; })()`);
  },
  // the split button's chevron next to the export button
  async exportMenu(tab) {
    await tab.js(`(() => { const bs = [...document.querySelectorAll('#modaq .ms-CommandBar button')];
      const i = bs.findIndex((x) => (x.querySelector('.ms-Button-label') || {}).textContent === 'Upload to qb-td');
      bs[i + 1].click(); return true; })()`);
  },
  // the items of the open menus, in order: {text, disabled, checked}
  menuItems(tab) {
    return tab.js(`[...document.querySelectorAll('.ms-ContextualMenu-header, .ms-ContextualMenu button.ms-ContextualMenu-link, .ms-ContextualMenu a.ms-ContextualMenu-link')]
      .map((b) => b.classList.contains('ms-ContextualMenu-header') ? { header: b.textContent }
        : { text: (b.querySelector('.ms-ContextualMenu-itemText') || {}).textContent, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true,
          checked: b.getAttribute('aria-checked') === 'true' })`);
  },
  // through open menus by item text, with the mouse: an item with a submenu
  // is pointed at until its submenu opens (clicked if it does not), any
  // other item is clicked; each step waits for its item
  async menu(tab, ...path) {
    for (const t of path) {
      const find = `[...document.querySelectorAll('.ms-ContextualMenu .ms-ContextualMenu-link')].filter((b) => (b.querySelector('.ms-ContextualMenu-itemText') || {}).textContent === ${q(t)}).pop()`;
      // a callout is drawn first and placed a moment later: wait until the item is on top where it shows
      const it = await tab.waitJs(`(() => { const b = ${find}; if (!b) return null; const r = b.getBoundingClientRect();
        const x = r.x + Math.min(40, r.width / 2), y = r.y + r.height / 2;
        const top = r.width > 0 && document.elementFromPoint(x, y);
        if (!top || top.closest('.ms-ContextualMenu-link') !== b) return null;
        return { x, y, sub: b.getAttribute('aria-haspopup') === 'true', menus: document.querySelectorAll('.ms-ContextualMenu').length }; })()`,
      'menu item ' + t, 5000);
      if (it.sub) {
        await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: it.x, y: it.y });
        const opened = await until(() => tab.js(`document.querySelectorAll('.ms-ContextualMenu').length > ${it.menus}`), 'submenu', 1500).catch(() => false);
        if (!opened) {
          await tab.js(`(${find}).click(), true`);
          await until(() => tab.js(`document.querySelectorAll('.ms-ContextualMenu').length > ${it.menus}`), 'the submenu of ' + t, 3000);
        }
      } else {
        await tab.mouseAt(it.x, it.y);
      }
    }
  },
  async closeMenus(tab) {
    for (let i = 0; i < 4 && await tab.exists('.ms-ContextualMenu'); i++) {
      await tab.key('Escape', 'Escape', 27);
      await sleep(50);
    }
  },
  async action(tab, ...path) { await mq.closeMenus(tab); await mq.cmd(tab, path[0]); await mq.menu(tab, ...path.slice(1)); },
  // a word of the tossup, clicked as a moderator does
  async word(tab, i) {
    await tab.waitJs(`!!document.querySelector('#modaq span[data-index="${i}"]')`, 'word ' + i, 5000);
    await tab.mouse(`#modaq span[data-index="${i}"]`);
    await tab.waitJs(`!!document.querySelector('.ms-ContextualMenu')`, 'the buzz menu', 5000);
  },
  async buzz(tab, i, player, verdict) {
    await mq.word(tab, i);
    await mq.menu(tab, player, verdict === 'correct' ? 'Correct ✓' : 'Wrong ✗');
    await tab.waitJs(`!document.querySelector('.ms-ContextualMenu')`, 'the buzz menu closing', 5000).catch(() => mq.closeMenus(tab));
  },
  // the players in the buzz menu, per team: what MODAQ has as playing now
  async buzzMenu(tab, i = 0) {
    await mq.word(tab, i);
    const items = await mq.menuItems(tab);
    await mq.closeMenus(tab);
    const out = {};
    let cur = null;
    for (const it of items) { if (it.header) { cur = it.header; out[cur] = []; } else if (cur) out[cur].push(it.text); }
    return out;
  },
  next: (tab) => tab.js(`[...document.querySelectorAll('#modaq button')].find((b) => b.textContent.includes('Next')).click(), true`),
  prev: (tab) => tab.js(`[...document.querySelectorAll('#modaq button')].find((b) => b.textContent.includes('Previous')).click(), true`),
  async goTo(tab, n) {
    for (let i = 0; i < 60; i++) {
      const at = await mq.at(tab);
      if (at === n) return;
      await (at < n ? mq.next(tab) : mq.prev(tab));
      await until(async () => (await mq.at(tab)) !== at, 'the question to move from ' + at, 5000);
    }
    throw new Error('could not reach question ' + n);
  },
  at: (tab) => tab.js(`(() => { const m = /Question #(\\d+)/.exec(document.querySelector('#modaq').innerText); return m ? Number(m[1]) : 0; })()`),
  score: (tab) => tab.js(`(() => { const lines = document.querySelector('#modaq').innerText.split('\\n');
    const l = lines.find((x) => /^.+: -?\\d+, .+: -?\\d+$/.test(x.trim())); return l ? l.trim() : null; })()`),
  // the tossup on screen: its text and answer
  tossup: (tab) => tab.js(`(() => { const w = document.querySelector('#modaq span[data-index="0"]'); if (!w) return '';
    return w.closest('[class]').parentElement.innerText.replace(/\\s+/g, ' ').trim(); })()`),
  view: (tab) => tab.js(`document.querySelector('#modaq').innerText`),
  // the open dialog (title + body), or ''
  dialog: (tab) => tab.js(`(() => { const d = [...document.querySelectorAll('.ms-Dialog-main')].pop(); return d ? d.innerText : ''; })()`),
  async dialogButton(tab, text) {
    await tab.waitJs(`[...document.querySelectorAll('.ms-Dialog-main button')].some((b) => b.textContent === ${q(text)})`, 'dialog button ' + text, 5000);
    await tab.js(`(() => { const b = [...document.querySelectorAll('.ms-Dialog-main button')].filter((x) => x.textContent === ${q(text)}).pop(); b.click(); return true; })()`);
  },
  dialogButtonState: (tab, text) => tab.js(`(() => { const b = [...document.querySelectorAll('.ms-Dialog-main button')].filter((x) => x.textContent === ${q(text)}).pop();
    return b ? { disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', primary: b.classList.contains('ms-Button--primary') } : null; })()`),
  async waitDialog(tab, title, ms = 8000) {
    await tab.waitJs(`[...document.querySelectorAll('.ms-Dialog-main')].some((d) => d.innerText.startsWith(${q(title)}))`, 'the dialog ' + title, ms);
    return mq.dialog(tab);
  },
  async noDialog(tab) { await tab.waitJs(`!document.querySelector('.ms-Dialog-main')`, 'the dialog to close', 8000); },
  // the Event Log's lines, per question
  events: (tab) => tab.js(`document.querySelector('#modaq').innerText.split('\\n#\\nEvents\\n')[1] || ''`),
};

/* ====================================================================== */
/* fixtures                                                               */
/* ====================================================================== */

const TEAMS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
// a long name with letters outside ASCII, for the upload's file name
const LONGTEAM = 'Université de Montréal "A" — Équipe Très Longue';
const pl = (team, j) => `${team} P${j}`;
const regOf = (n) => ({ name: n, teams: [{ name: n, players: [1, 2, 3, 4, 5].map((j) => ({ name: pl(n, j) })) }] });
const rosterOf = (teams) => JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'Reader Full', registrations: teams.map(regOf) }] });
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const words = (n, s) => Array.from({ length: n }, (_, i) => WORDS[(i + s) % 8]).join(' ');
// 22 tossups (two for overtime) and 22 bonuses; word 0 is "R<n>T<i>", words
// 1-30 come before the power mark (*), the rest after it
const packetOf = (r, tag = '') => JSON.stringify({
  tossups: Array.from({ length: 22 }, (_, i) => ({ question: `R${r}T${i + 1}${tag} ${words(30, i)} (*) ${words(10, i)}. For 10 points, name this.`,
    answer: `answer ${r}-${i + 1}${tag}` })),
  bonuses: Array.from({ length: 22 }, (_, i) => ({ leadin: `R${r}B${i + 1}${tag} leadin. For 10 points each:`,
    parts: ['First part.', 'Second part.', 'Third part.'], answers: [`b${i + 1}a`, `b${i + 1}b`, `b${i + 1}c`], values: [10, 10, 10] })),
});
const POOL = JSON.stringify({
  tossups: [{ question: 'Tiebreaker one asks about a treaty.', answer: 'Treaty of Ghent' },
    { question: 'Tiebreaker two asks about a peace.', answer: 'Peace of Utrecht' },
    { question: 'Tiebreaker three asks about a congress.', answer: 'Congress of Vienna' }],
  bonuses: [{ leadin: 'Tiebreaker bonus one leadin.', parts: ['TB one part one.', 'TB one part two.', 'TB one part three.'], answers: ['tbx', 'tby', 'tbz'], values: [10, 10, 10] },
    { leadin: 'Tiebreaker bonus two leadin.', parts: ['TB two part one.', 'TB two part two.', 'TB two part three.'], answers: ['tbu', 'tbv', 'tbw'], values: [10, 10, 10] }],
});
// a packet file a moderator loads in Add questions or Replace
const FILE_PACKET = JSON.stringify({
  tossups: [{ question: 'File tossup one is about a river delta.', answer: 'Nile' }, { question: 'File tossup two is about a mountain range.', answer: 'Andes' }],
  bonuses: [{ leadin: 'File bonus leadin.', parts: ['File part one.', 'File part two.', 'File part three.'], answers: ['fa', 'fb', 'fc'], values: [10, 10, 10] }],
});
const POWER_WORD = 3;   // a buzz here is in power
const LATE_WORD = 35;   // a buzz here is after the power mark

async function tournament(name) {
  const r = await call('/api/tournaments', { method: 'POST', json: { name, slug: 'rf-' + Math.random().toString(36).slice(2, 8) } });
  if (r.status !== 200) throw new Error('could not create ' + name + ': ' + JSON.stringify(r.body));
  const A = '/a/' + r.body.admin_secret;
  const T = { name, id: r.body.id, admin: r.body.admin_secret, A, rooms: {}, settings: {} };
  T.room = async (roomName) => {
    const b = (await call(A + '/buckets', { method: 'POST', json: { room_name: roomName } })).body;
    T.rooms[roomName] = b;
    return b;
  };
  T.packet = (round, name, body, type = 'application/json') => call(`${A}/packet?round=${round}&name=${enc(name)}`,
    { method: 'POST', headers: { 'Content-Type': type }, body });
  T.roster = (text) => call(A + '/roster?name=roster.qbj', { method: 'POST', body: text });
  T.schedule = (s) => call(A + '/schedule', { method: 'POST', json: s });
  T.pool = (text) => call(`${A}/tiebreakers?name=tb.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
  T.setSettings = async (s) => { T.settings = s; return call(A, { method: 'POST', json: { settings: s } }); };
  T.round = (n) => call(A, { method: 'POST', json: { current_round: n } });
  T.start = () => call(A + '/start', { method: 'POST' });
  T.detail = async () => (await call(A)).body;
  T.renameRoom = (b, room_name) => call(`${A}/buckets/${b.id}`, { method: 'POST', json: { room_name } });
  return T;
}

// the main tournament's schedule: room 0-5 are linked by their bucket,
// room 6 by name only (written another way), room 7 is named like the Bye
// Room. Room 1 has no game in round 3, and only one team in round 4.
const PAIRS = [['Alpha', 'Beta'], ['Gamma', 'Delta'], ['Epsilon', 'Zeta'], ['Alpha', 'Gamma'], ['Beta', 'Delta'], ['Gamma', 'Zeta'],
  ['Delta', 'Epsilon'], ['Beta', 'Zeta'], ['Alpha', 'Delta'], ['Beta', 'Epsilon'], ['Alpha', 'Zeta'], ['Gamma', 'Epsilon'],
  ['Beta', 'Gamma'], ['Delta', 'Zeta'], ['Alpha', 'Epsilon']];
function mainSchedule(T) {
  const names = ['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Room 5', 'Room 6'];
  const rooms = [...names.map((n) => ({ name: n, bucket: T.rooms[n].id })), { name: ' lecture HALL ', bucket: null }, { name: 'Bye Room', bucket: null }];
  const rounds = [1, 2, 3, 4].map((round) => ({
    round,
    games: rooms.map((_, room) => {
      if (room === 0 && round === 3) return null;
      if (room === 0 && round === 4) return { room, a: { team: 'Alpha' }, b: null };
      const [a, b] = PAIRS[(round * 5 + room) % PAIRS.length];
      return { room, a: { team: a }, b: { team: b } };
    }).filter(Boolean),
    byes: round === 2 ? [{ team: 'Epsilon' }] : round === 3 ? [{ team: 'Alpha' }, { team: 'Zeta' }] : [],
  }));
  return { v: 1, rooms, phases: [{ name: 'Prelims', rounds }], updated: 0 };
}
const gameAt = (S, roomIndex, round) => {
  const r = S.phases[0].rounds.find((x) => x.round === round);
  const g = r && r.games.find((x) => x.room === roomIndex);
  return g && g.a && g.b ? { a: g.a.team, b: g.b.team } : null;
};

/* ====================================================================== */
/* run                                                                    */
/* ====================================================================== */

console.log(`ui_full_reader: app/ and worker/ from ${ROOT}${ROOT === REPO ? ' (this checkout)' : ''}; Worker ${BASE}, pages ${PAGES}`);
await startStack();
await startChrome();
const tab = await newTab();
// the creation cap counts per address per day; earlier local runs must not use it up
d1("UPDATE tournaments SET creator_ip = 'earlier-run'");

// The main tournament: nine rooms, seven teams, packets for rounds 1-4, the
// schedule above, a tiebreaker pool and a Bye Room. Not started yet.
const M = await tournament('Reader Full Open');
for (const n of ['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Room 5', 'Room 6', 'Lecture Hall', 'Annex', 'Bye Room']) await M.room(n);
await M.roster(rosterOf([...TEAMS, LONGTEAM]));
for (const r of [1, 2, 3, 4]) await M.packet(r, `P${r}.json`, packetOf(r));
const MS = mainSchedule(M);
await M.schedule(MS);
await M.pool(POOL);
await M.setSettings({ byeRoom: M.rooms['Bye Room'].id });
const room = (n) => M.rooms[n].secret;
const TEST = testTokenOf(M.admin);

/* ---------------------------------------------------------------------- */

await section('R01', 'a room link with no ?b= secret', async () => {
  const m = tab.mark();
  await tab.goto(`${PAGES}/read.html?server=${enc(BASE)}&live=off`);
  await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'the message line');
  ok('R01 the message line says "bad link"', (await tab.text('#msg')) === 'bad link', await tab.text('#msg'));
  ok('R01 in red', await red(tab, '#msg'));
  ok('R01 no picker, no round list, no side panels', await tab.js(`document.querySelector('#picker').hidden && !document.querySelector('#roundrows').children.length
    && document.querySelector('#schedpanel').hidden && document.querySelector('#tbpanel').hidden`));
  await sleep(300);
  ok('R01 no request to the Worker', tab.worker(m).length === 0, tab.worker(m));
});

await section('R02', 'an unknown room secret', async () => {
  const fake = 'abcdefghjkmnpqrstuvw';
  const m = tab.mark();
  await openRoom(tab, fake, '', 'msg');
  ok('R02 the message line says "bad link"', (await tab.text('#msg')) === 'bad link', await tab.text('#msg'));
  ok('R02 in red', await red(tab, '#msg'));
  ok('R02 no picker', await tab.js(`document.querySelector('#picker').hidden && !document.querySelector('#roundrows').children.length`));
  ok('R02 the page asks once, for /load' + changed('oneRequest'), JSON.stringify(tab.worker(m)) === JSON.stringify(['GET /b/:s/load']), tab.worker(m));
  const load = await call(`/b/${fake}/load`);
  ok('R02 Worker: /load answers each part 404 "bad link"', load.status === 200
    && ['', '/schedule', '/roster', '/tiebreakers'].every((k) => load.body[k] && load.body[k].s === 404 && JSON.parse(load.body[k].b).error === 'bad link'), load.body);
  const each = await Promise.all(['', '/schedule', '/roster', '/tiebreakers', '/packet'].map((k) => call(`/b/${fake}${k}`)));
  ok('R02 Worker: the room, schedule, roster, pool and packet routes answer 404 "bad link"',
    each.every((r) => r.status === 404 && r.body.error === 'bad link'), each.map((r) => r.status));
});

await section('R03', 'before Start: Tournament hasn\'t started', async () => {
  const m = tab.mark();
  await openRoom(tab, room('Room 2'), '', 'msg');
  await sleep(500); // nothing more should go out after the message
  ok('R03 the message', (await tab.text('#msg')) === "Tournament hasn't started. Reload this page once the TD starts it.", await tab.text('#msg'));
  ok('R03 in red', await red(tab, '#msg'));
  ok('R03 no round list, matchup or side panels', await tab.js(`document.querySelector('#picker').hidden && !document.querySelector('#roundrows').children.length
    && document.querySelector('#teamrow').hidden && document.querySelector('#schedpanel').hidden && document.querySelector('#tbpanel').hidden`));
  ok('R03 one Worker request, GET /load: no packet, no POST' + changed('oneRequest'),
    JSON.stringify(tab.worker(m)) === JSON.stringify(['GET /b/:s/load']), tab.worker(m));
  const load = await call(`/b/${room('Room 2')}/load`);
  ok('R03 Worker: all four parts answer 403 "Tournament hasn\'t started"', ['', '/schedule', '/roster', '/tiebreakers']
    .every((k) => load.body[k] && load.body[k].s === 403 && JSON.parse(load.body[k].b).error === "Tournament hasn't started"), load.body);
});

await section('RT', 'the TD\'s Test link before Start', async () => {
  const m = tab.mark();
  await openRoom(tab, room('Room 2'), '&test=' + TEST);
  ok('RT the tab title starts "TEST - "', (await tab.js('document.title')) === 'TEST - Reader Full Open - Room 2', await tab.js('document.title'));
  ok('RT the test strip', (await tab.shown('#teststrip')) && (await tab.text('#teststrip')).replace(/\s+/g, ' ').trim()
    === 'This is a test room. Please do not send this link to moderators. Games that are exported from test rooms are NOT saved.', await tab.text('#teststrip'));
  ok('RT the header tag says "Test game"', (await tab.shown('#testtag')) && (await tab.text('#testtag')) === 'Test game');
  ok('RT the button reads "Start test game"', (await tab.text('#start')) === 'Start test game');
  // a test reads every round with a packet, not only those reached
  ok('RT every round with a packet is listed', JSON.stringify((await roundButtons(tab)).map((b) => b.n)) === JSON.stringify(['1', '2', '3', '4']), await roundButtons(tab));
  const asked = tab.worker(m);
  ok('RT one /load with &test=, then the packet with &test=' + changed('oneRequest'),
    asked.length === 2 && /^GET \/b\/:s\/load\?test=[0-9a-f]{64}$/.test(asked[0]) && /^GET \/b\/:s\/packet\?round=1&warm=1&test=[0-9a-f]{64}$/.test(asked[1]), asked);
  ok('RT the Test link has no admin secret in it' + changed('testLinks'), !(await tab.js('location.href')).includes(M.admin));
  // a test game: no start sent, kept apart, nothing uploaded
  const m2 = tab.mark();
  const id = await startGame(tab);
  const href = await tab.js('location.href');
  ok('RT Start sends nothing to the Worker but the packet (warmed already)', !tab.worker(m2).some((x) => x.startsWith('POST')), tab.worker(m2));
  ok('RT the game link keeps &test= and &server=', href.includes('&test=' + TEST) && new URL(href).searchParams.get('server') === BASE && !!id, href);
  ok('RT the title stays "TEST - "', (await tab.js('document.title')).startsWith('TEST - '));
  ok('RT the test strip stays over the game', await tab.shown('#teststrip'));
  const g1 = gameAt(MS, 1, 1);
  const m3 = tab.mark();
  // a neg, protested: a room's game would send it within 5 s (R36)
  await mq.buzz(tab, 5, pl(g1.b, 1), 'wrong');
  await mq.word(tab, 5);
  await mq.menu(tab, pl(g1.b, 1), 'Protest');
  await mq.waitDialog(tab, 'Add Protest');
  await tab.type('.ms-Dialog-main textarea', 'a test answer');
  await tab.js(`document.querySelectorAll('.ms-Dialog-main textarea')[1].focus(), true`);
  await tab.S('Input.insertText', { text: 'A test protest' });
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  ok('RT the protest is logged in the test game', (await mq.events(tab)).includes('rotest'), (await mq.events(tab)).slice(0, 200));
  await mq.buzz(tab, POWER_WORD, pl(g1.a, 1), 'correct');
  await mq.cmd(tab, 'Upload to qb-td');
  await until(() => tab.dialogs.some((d) => d.message === 'This is a test game, so nothing was uploaded.'), 'the test game alert', 5000);
  ok('RT Upload says "This is a test game, so nothing was uploaded."', true);
  await sleep(6000); // a protest check has run by now (every 5 s)
  ok('RT R36 nothing goes to the Worker from a test game: no protests, no upload', tab.worker(m3).length === 0, tab.worker(m3));
  ok('RT MODAQ shows no "Export Succeeded"', !(await mq.dialog(tab)).startsWith('Export'));
  const keys = Object.keys(await tab.storage());
  ok('RT a test game is stored apart from the room\'s games', keys.includes(`qbtdMeta:${room('Room 2')}-test:${id}`) && !keys.some((k) => k.startsWith(`qbtdMeta:${room('Room 2')}:`)), keys);
});

// the tournament starts, and goes to round 3
await M.start();
await M.round(3);

await section('R03b', 'after Start, the room link shows the picker', async () => {
  await openRoom(tab, room('Room 2'));
  ok('R03 after Start, reloading shows the round list and the matchup', (await tab.text('#msg')) === ''
    && (await roundButtons(tab)).length === 3 && !(await tab.js(`document.querySelector('#schedmatch').hidden`)));
});
// A second tab opens Room 1's link now and stays on it to the end: after
// its first load it must ask the Worker for nothing (R06).
const watch = await newTab();
const watchFrom = Date.now();
await openRoom(watch, room('Room 1'));

await section('R06', 'one request for the room (/b/:secret/load)', async () => {
  const asked = watch.worker(0);
  ok('R06 a room link: GET /load, then GET /packet?round=3&warm=1, nothing else' + changed('oneRequest'),
    JSON.stringify(asked) === JSON.stringify(['GET /b/:s/load', 'GET /b/:s/packet?round=3&warm=1']), asked);
  const m = tab.mark();
  await openRoom(tab, room('Bye Room'), '&test=bye');
  const bye = tab.worker(m);
  ok('R06 a Bye Room link: the same, with &test=bye' + changed('oneRequest'),
    JSON.stringify(bye) === JSON.stringify(['GET /b/:s/load?test=bye', 'GET /b/:s/packet?round=3&warm=1&test=bye']), bye);
});

await section('R07', 'when /load fails, each part is fetched on its own', async () => {
  const S3 = room('Room 3');
  await openRoom(tab, S3);
  const want = await roomView(tab);
  const parts = ['GET /b/:s', 'GET /b/:s/schedule', 'GET /b/:s/roster', 'GET /b/:s/tiebreakers'];
  const once = (got, list) => list.every((x) => got.filter((y) => y === x).length === 1);
  // blocked
  await tab.block(['*/load*']);
  let m = tab.mark();
  try { await openRoom(tab, S3); } finally { await tab.block([]); }
  let got = tab.worker(m);
  ok('R07 /load blocked: the room, schedule, roster and pool are each fetched once, then the packet', once(got, parts)
    && got.includes('GET /b/:s/packet?round=3&warm=1'), got);
  ok('R07 /load blocked: the page looks the same (matchup, starters, panels, no roster error)', (await roomView(tab)) === want,
    { want, got: await roomView(tab) });
  // a part whose status is not an integer
  await tab.intercept([{ urlPattern: '*/load*', requestStage: 'Response' }], async (p) => {
    const r = await tab.S('Fetch.getResponseBody', { requestId: p.requestId });
    const j = JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body);
    j['/roster'].s = String(j['/roster'].s);
    await tab.S('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: p.responseHeaders,
      body: Buffer.from(JSON.stringify(j)).toString('base64') });
  });
  m = tab.mark();
  try { await openRoom(tab, S3); } finally { await tab.unintercept(); }
  got = tab.worker(m);
  ok('R07 a part with a status that is not a number ("200"): that part alone is fetched again', once(got, ['GET /b/:s/load', 'GET /b/:s/roster'])
    && !['GET /b/:s', 'GET /b/:s/schedule', 'GET /b/:s/tiebreakers'].some((x) => got.includes(x)), got);
  ok('R07 and the page looks the same', (await roomView(tab)) === want);
  // answers older than 30 s: a clock that moves 31 s between reads
  const { identifier } = await tab.S('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const now = Date.now.bind(Date); let skew = 0;
    Date.now = () => { const t = now() + skew; skew += 31000; return t; }; })();` });
  m = tab.mark();
  try { await openRoom(tab, S3); } finally { await tab.S('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
  got = tab.worker(m);
  ok('R07 /load answers more than 30 s old are fetched again: each part once after /load', got[0] === 'GET /b/:s/load' && once(got, parts), got);
  ok('R07 and the page looks the same', (await roomView(tab)) === want);
});

await section('R05', 'a server failure on load', async () => {
  // one part throws: the schedule blob reads as null
  r2put(`t/${M.id}/schedule.json`, 'null');
  try {
    const m = tab.mark();
    await openRoom(tab, room('Room 3'));
    await tab.waitJs(`!document.querySelector('#tbpanel').hidden`, 'the tiebreakers panel');
    await sleep(300);
    ok('R05 one /load part failing: the other three are used (round list, team pickers, tiebreakers)' + changed('oneRequest'),
      (await roundButtons(tab)).length === 3 && (await tab.js(`document.querySelector('#teama').options.length`)) === 8
        && !(await tab.js(`document.querySelector('#tbpanel').hidden`)));
    ok('R05 one /load part failing: no scheduled matchup and no schedule panel, with nothing said', (await tab.text('#msg')) === ''
      && (await tab.js(`document.querySelector('#schedmatch').hidden && document.querySelector('#schedpanel').hidden && !document.querySelector('#teampickers').hidden`)));
    ok('R05 one /load part failing: no part is fetched again' + changed('oneRequest'),
      JSON.stringify(tab.worker(m)) === JSON.stringify(['GET /b/:s/load', 'GET /b/:s/packet?round=3&warm=1']), tab.worker(m));
    const load = await call(`/b/${room('Room 3')}/load`);
    ok('R05 Worker: that part is a JSON 500, the other three 200' + changed('serverFail'), load.status === 200 && load.body['/schedule'].s === 500
      && JSON.parse(load.body['/schedule'].b).error === 'Something went wrong on the server. Please try again.'
      && ['', '/roster', '/tiebreakers'].every((k) => load.body[k].s === 200), load.body['/schedule']);
  } finally { await M.schedule(MS); }
  // every part throws: the room's key won't unwrap
  const annex = M.rooms['Annex'];
  const wrap = d1(`SELECT wrap FROM buckets WHERE id = ${annex.id}`)[0].wrap;
  d1(`UPDATE buckets SET wrap = '${'A'.repeat(wrap.length)}' WHERE id = ${annex.id}`);
  try {
    await openRoom(tab, annex.secret, '', 'msg');
    ok('R05 the room failing: the message line says "Something went wrong on the server. Please try again."' + changed('serverFail'),
      (await tab.text('#msg')) === 'Something went wrong on the server. Please try again.', await tab.text('#msg'));
    ok('R05 in red, with no picker', (await red(tab, '#msg')) && (await tab.js(`document.querySelector('#picker').hidden`)));
    const r = await call(`/b/${annex.secret}`);
    ok('R05 Worker: a JSON 500 with CORS headers' + changed('serverFail'), r.status === 500 && r.body.error === 'Something went wrong on the server. Please try again.'
      && r.cors === PAGES, [r.status, r.body, r.cors]);
  } finally { d1(`UPDATE buckets SET wrap = '${wrap}' WHERE id = ${annex.id}`); }
  await openRoom(tab, annex.secret);
  ok('R05 the room works again once its key is whole', (await tab.text('#msg')) === '');
});

await section('R08', 'which Worker the page uses: ?server=, localStorage qbtdServer', async () => {
  await openRoom(tab, room('Room 3'));
  const nh = await tab.js(`document.querySelector('#newgame').getAttribute('href')`);
  ok('R08 with ?server=: the room link the page builds keeps &server=', new URL(nh, PAGES).searchParams.get('server') === BASE, nh);
  await tab.js(`localStorage.setItem('qbtdServer', ${q(BASE)}); localStorage.setItem('qbtdLive', 'off'); true`);
  try {
    const m = tab.mark();
    await tab.goto(`${PAGES}/read.html?b=${room('Room 3')}`);
    await tab.waitJs(`!document.querySelector('#teamrow').hidden`, 'the room via localStorage');
    ok('R08 with only localStorage qbtdServer: the page reads the local Worker', tab.worker(m)[0] === 'GET /b/:s/load' && (await tab.text('#msg')) === '', tab.worker(m));
    ok('R08 and its links carry no &server=', !(await tab.js(`document.querySelector('#newgame').getAttribute('href')`)).includes('server='));
  } finally { await tab.js(`localStorage.removeItem('qbtdServer'); localStorage.removeItem('qbtdLive'); true`); }
});

await section('R09', 'header and tab title before a game', async () => {
  await openRoom(tab, room('Room 2'));
  ok('R09 the tab title is "<Tournament> - <Room>"', (await tab.js('document.title')) === 'Reader Full Open - Room 2', await tab.js('document.title'));
  ok('R09 the header: the tournament, then "<Room> · Round <n>"', (await tab.text('#tname')) === 'Reader Full Open'
    && (await tab.text('#room')) === 'Room 2 · Round 3', [await tab.text('#tname'), await tab.text('#room')]);
  ok('R09 before a game: no "A vs B" and no New game link', !(await tab.shown('#game')) && !(await tab.shown('#newgame')));
});

await section('R10', 'the round list', async () => {
  await openRoom(tab, room('Room 2'));
  const b = await roundButtons(tab);
  ok('R10 one button per round with a packet up to the room\'s round (round 4 has a packet but is not listed)',
    JSON.stringify(b.map((x) => x.n)) === JSON.stringify(['1', '2', '3']) && b.every((x) => x.tag === 'A'), b);
  ok('R10 the live round has the dot and the title "The live round"', b[2].live && b[2].title === 'The live round' && !b[0].live && !b[1].live
    && b[0].title === 'Round 1' && (await tab.js(`getComputedStyle(document.querySelector('.rnd.live'), '::after').content`)) === '""'
    && (await tab.js(`getComputedStyle(document.querySelector('.rnd[data-round="1"]'), '::after').content`)) === 'none', b);
  ok('R10 the live round is selected (outlined) when it has a packet', b[2].sel && !b[0].sel && !b[1].sel
    && (await tab.js(`getComputedStyle(document.querySelector('.rnd.sel')).boxShadow`)) !== (await tab.js(`getComputedStyle(document.querySelector('.rnd[data-round="1"]')).boxShadow`)));
  ok('R10 "Packet: <name>" names the selected round\'s packet', (await tab.text('#packetname')) === 'Packet: P3.json', await tab.text('#packetname'));
});

await section('R14', 'the scheduled matchup, locked in', async () => {
  await openRoom(tab, room('Room 2'));
  const g = gameAt(MS, 1, 3);
  ok('R14 "From the schedule · Round 3 in Room 2"', (await tab.text('#schedfrom')) === 'From the schedule · Round 3 in Room 2', await tab.text('#schedfrom'));
  ok('R14 a large "A vs B"', (await tab.text('#mteama')) === g.a && (await tab.text('#mteamb')) === g.b
    && (await tab.js(`parseFloat(getComputedStyle(document.querySelector('.matchup')).fontSize)`)) >= 24);
  ok('R14 the pickers are hidden; "Change teams" shows', !(await tab.shown('#teampickers')) && (await tab.shown('#changeteams'))
    && (await tab.text('#changeteams')) === 'Change teams' && !(await tab.shown('#useschedteams')));
});

await section('R16', 'Change teams / Use the scheduled teams', async () => {
  const g = gameAt(MS, 2, 3);
  await openRoom(tab, room('Room 3'));
  await tab.click('#changeteams');
  ok('R16 Change teams: two dropdowns with the scheduled teams picked', (await tab.shown('#teampickers'))
    && (await tab.js(`document.querySelector('#teama').value`)) === g.a && (await tab.js(`document.querySelector('#teamb').value`)) === g.b);
  ok('R16 the matchup and "Change teams" hide; "Use the scheduled teams" shows', !(await tab.shown('#schedmatch')) && !(await tab.shown('#changeteams'))
    && (await tab.shown('#useschedteams')) && (await tab.text('#useschedteams')) === 'Use the scheduled teams');
  await tab.pick('#teama', 'Alpha');
  await tab.click('#useschedteams');
  ok('R16 Use the scheduled teams: the scheduled matchup is back, locked', (await tab.shown('#schedmatch')) && !(await tab.shown('#teampickers'))
    && (await tab.text('#mteama')) === g.a && (await tab.text('#mteamb')) === g.b && (await tab.shown('#changeteams')) && !(await tab.shown('#useschedteams'))
    && (await tab.js(`document.querySelector('#teama').value`)) === g.a);
});

await section('R17', 'starting with other teams: the switch warning', async () => {
  const g = gameAt(MS, 2, 3);
  const S3 = room('Room 3');
  await openRoom(tab, S3);
  await tab.click('#changeteams');
  await tab.pick('#teama', 'Alpha');
  await tab.pick('#teamb', 'Beta');
  const want = `WARNING: The schedule indicates that "${g.a}" vs "${g.b}" are playing in the room Room 3. Are you sure you want to switch?`;
  let m = tab.mark();
  let d0 = tab.dialogs.length;
  tab.answers.push(false);
  await tab.click('#start');
  await until(() => tab.dialogs.length > d0, 'the switch warning', 5000);
  ok('R17 the warning names the scheduled teams and the room', tab.dialogs[d0].type === 'confirm' && tab.dialogs[d0].message === want, tab.dialogs[d0]);
  await sleep(300);
  ok('R17 Cancel starts nothing', !(await tab.js(`document.body.classList.contains('reading')`)) && !(await tab.js('location.search')).includes('&g=')
    && !tab.worker(m).some((x) => x.startsWith('POST')), tab.worker(m));
  m = tab.mark();
  d0 = tab.dialogs.length;
  tab.answers.push(true);
  await startGame(tab);
  ok('R17 OK starts with the picked teams', (await tab.text('#game')) === 'Alpha vs Beta' && (await mq.score(tab)) === 'Alpha: 0, Beta: 0'
    && tab.worker(m).includes('POST /b/:s/start?round=3'), [await tab.text('#game'), await mq.score(tab)]);
  // the scheduled teams on swapped sides are no switch
  await openRoom(tab, S3);
  await tab.click('#changeteams');
  await tab.pick('#teama', g.b);
  await tab.pick('#teamb', g.a);
  d0 = tab.dialogs.length;
  await startGame(tab); // the confirm that round 3 already has a game here is answered OK
  ok('R17 the scheduled teams on swapped sides: no warning', !tab.dialogs.slice(d0).some((x) => x.message.startsWith('WARNING'))
    && (await tab.text('#game')) === `${g.b} vs ${g.a}`, tab.dialogs.slice(d0));
});

await section('R18', 'changing round re-applies the schedule', async () => {
  await openRoom(tab, room('Room 1'));
  ok('R18 a round where the schedule has nothing for this room: the pickers, empty, and no "From the schedule"',
    (await tab.shown('#teampickers')) && !(await tab.shown('#schedmatch')) && (await tab.js(`document.querySelector('#teama').value === '' && document.querySelector('#teamb').value === ''`)));
  await tab.pick('#teama', 'Beta');
  await tab.pick('#teamb', 'Gamma');
  await tab.click('.rnd[data-round="3"]');
  ok('R18 picking that round again leaves the moderator\'s own pick', (await tab.js(`document.querySelector('#teama').value + '/' + document.querySelector('#teamb').value`)) === 'Beta/Gamma');
  for (const n of [2, 1]) {
    await tab.click(`.rnd[data-round="${n}"]`);
    const g = gameAt(MS, 0, n);
    ok(`R18 round ${n}: its scheduled matchup locks in`, (await tab.shown('#schedmatch')) && (await tab.text('#mteama')) === g.a
      && (await tab.text('#mteamb')) === g.b && (await tab.text('#schedfrom')) === `From the schedule · Round ${n} in Room 1`
      && (await tab.text('#packetname')) === `Packet: P${n}.json`);
  }
  await tab.click('.rnd[data-round="3"]');
  ok('R18 back on round 3: the pickers again, nothing locked', (await tab.shown('#teampickers')) && !(await tab.shown('#schedmatch')) && !(await tab.shown('#changeteams')));
});

await section('R19', 'a room the schedule does not name', async () => {
  await openRoom(tab, M.rooms['Annex'].secret);
  ok('R19 two team dropdowns, empty, with a blank first option', (await tab.shown('#teampickers'))
    && (await tab.js(`['#teama', '#teamb'].every((s) => { const e = document.querySelector(s); return e.value === '' && e.options[0].value === '' && e.options[0].textContent === ''; })`)));
  ok('R19 every roster team in each', JSON.stringify(await tab.js(`[...document.querySelector('#teama').options].slice(1).map((o) => o.textContent)`))
    === JSON.stringify([...TEAMS, LONGTEAM]) && (await tab.js(`document.querySelector('#teamb').options.length`)) === 8);
  ok('R19 no "From the schedule" and no schedule panel', !(await tab.shown('#schedmatch')) && !(await tab.shown('#schedpanel')) && (await tab.text('#msg')) === '');
});

await section('R20', 'team picker validation', async () => {
  await openRoom(tab, M.rooms['Annex'].secret);
  const m = tab.mark();
  const tryStart = async () => { await tab.click('#start'); await sleep(150); return tab.text('#msg'); };
  ok('R20 no team picked: "pick both teams"', (await tryStart()) === 'pick both teams' && (await red(tab, '#msg')));
  await tab.pick('#teama', 'Alpha');
  ok('R20 one team picked: "pick both teams"', (await tryStart()) === 'pick both teams');
  await tab.pick('#teamb', 'Alpha');
  ok('R20 the same team twice: "pick two different teams"', (await tryStart()) === 'pick two different teams' && (await red(tab, '#msg')));
  // the dropdowns offer only roster teams; a name from elsewhere only gets in by editing the page
  await tab.js(`(() => { const o = document.createElement('option'); o.textContent = 'Nobody U'; document.querySelector('#teamb').appendChild(o); return true; })()`);
  await tab.pick('#teamb', 'Nobody U');
  ok('R20 a name not on the roster (put in by editing the page): "team not in roster"', (await tryStart()) === 'team not in roster' && (await red(tab, '#msg')));
  ok('R20 nothing starts', !(await tab.js(`document.body.classList.contains('reading')`)) && !tab.worker(m).some((x) => x.startsWith('POST')), tab.worker(m));
});

await section('R24', 'this room\'s schedule panel', async () => {
  await openRoom(tab, room('Room 2'));
  const rows = await tab.js(`[...document.querySelectorAll('#schedrows tr')].map((r) => ({ cells: [...r.cells].map((c) => c.textContent.trim()), now: r.classList.contains('now') }))`);
  const want = [1, 2, 3, 4].map((n) => ({ cells: [String(n), `${gameAt(MS, 1, n).a} v ${gameAt(MS, 1, n).b}`], now: n === 3 }));
  ok('R24 "This room\'s schedule": one row per round, "N | A v B", round 3 highlighted', (await tab.text('#schedpanel h2')) === 'This room’s schedule'
    && JSON.stringify(rows) === JSON.stringify(want), rows);
  ok('R24 the highlighted row stands out', (await tab.js(`getComputedStyle(document.querySelector('#schedrows tr.now td')).fontWeight`)) === '600');
  await openRoom(tab, room('Room 1'));
  const r1 = await tab.js(`[...document.querySelectorAll('#schedrows tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()).join(' | '))`);
  ok('R24 a round with no game here has no row; an empty side reads "—"',
    JSON.stringify(r1) === JSON.stringify([`1 | ${gameAt(MS, 0, 1).a} v ${gameAt(MS, 0, 1).b}`, `2 | ${gameAt(MS, 0, 2).a} v ${gameAt(MS, 0, 2).b}`, '4 | Alpha v —']), r1);
  await openRoom(tab, M.rooms['Annex'].secret);
  ok('R24 a room with no schedule rows: no panel', !(await tab.shown('#schedpanel')));
});

await section('R25', 'the tiebreakers panel', async () => {
  await openRoom(tab, room('Room 2'));
  await tab.waitJs(`!document.querySelector('#tbpanel').hidden`, 'the tiebreakers panel');
  const rows = await tab.js(`[...document.querySelectorAll('#tbrows tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()))`);
  ok('R25 "Tiebreakers": one row per question with its kind, "unused"', (await tab.text('#tbpanel h2')) === 'Tiebreakers'
    && JSON.stringify(rows) === JSON.stringify([['TU1', 'Tossup', 'unused'], ['TU2', 'Tossup', 'unused'], ['TU3', 'Tossup', 'unused'],
      ['B1', 'Bonus', 'unused'], ['B2', 'Bonus', 'unused']]), rows);
  ok('R25 "unused" in green', await green(tab, '#tbrows .ok'));
  ok('R25 the note under it', (await tab.text('#tbbase')) === 'During a game, you can add these from Actions → Add questions, either in place of a thrown-out question or at the end of the packet.');
});

await section('R15', 'finding this room in the schedule: by link, by name, after a rename', async () => {
  const hall = M.rooms['Lecture Hall'];
  await openRoom(tab, hall.secret);
  const g = gameAt(MS, 6, 3);
  ok('R15 a room the schedule names another way (" lecture HALL "): its matchup by name', (await tab.text('#schedfrom')) === 'From the schedule · Round 3 in Lecture Hall'
    && (await tab.text('#mteama')) === g.a && (await tab.text('#mteamb')) === g.b && (await tab.shown('#schedpanel')));
  await M.renameRoom(hall, 'Great Hall');
  const sched = await call(`/b/${hall.secret}/schedule`);
  ok('R15 renaming that room renames its line on the saved schedule' + changed('renameRoom'), sched.body.room === 6 && sched.body.schedule.rooms[6].name === 'Great Hall',
    sched.body.room !== undefined ? [sched.body.room, sched.body.schedule && sched.body.schedule.rooms.map((r) => r.name)] : sched);
  await openRoom(tab, hall.secret);
  ok('R15 after the rename the reader still has its matchup and schedule panel' + changed('renameRoom'),
    (await tab.text('#room')) === 'Great Hall · Round 3' && (await tab.text('#schedfrom')) === 'From the schedule · Round 3 in Great Hall'
      && (await tab.shown('#schedmatch')) && (await tab.shown('#schedpanel')), [await tab.text('#room'), await tab.text('#schedfrom')]);
  // a room linked by its bucket keeps its matchup, and its line follows the new name too
  const r6 = M.rooms['Room 6'];
  await M.renameRoom(r6, 'Room Six');
  await openRoom(tab, r6.secret);
  ok('R15 a linked room renamed: its matchup, under the new name', (await tab.text('#schedfrom')) === 'From the schedule · Round 3 in Room Six'
    && (await tab.text('#mteama')) === gameAt(MS, 5, 3).a);
  ok('R15 and its line on the saved schedule follows', (await call(`/b/${r6.secret}/schedule`)).body.schedule.rooms[5].name === 'Room Six');
  await M.renameRoom(r6, 'Room 6');
  // the Bye Room is never a schedule room, even with a line of its name
  await openRoom(tab, room('Bye Room'), '&test=bye');
  const byeS = await call(`/b/${room('Bye Room')}/schedule?test=bye`);
  ok('R15 the Bye Room is no schedule room, though the schedule has a "Bye Room" line', byeS.body.room === null
    && (await tab.text('#schedfrom')) === 'On a bye in round 3' && !(await tab.shown('#schedpanel')), [byeS.body.room, await tab.text('#schedfrom')]);
});

await section('RB', 'the Bye Room', async () => {
  const S = room('Bye Room');
  await openRoom(tab, S, '&test=bye');
  ok('RB the tab title starts "BYE - "', (await tab.js('document.title')) === 'BYE - Reader Full Open - Bye Room', await tab.js('document.title'));
  ok('RB the strip and tag say it is the Bye Room', (await tab.text('#teststrip')) === 'This is the Bye Room. Games read here are NOT saved.'
    && (await tab.text('#testtag')) === 'Bye Room' && (await tab.text('#start')) === 'Start bye-round game');
  ok('RB round 3: the two teams on a bye are the matchup', (await tab.text('#mteama')) === 'Alpha' && (await tab.text('#mteamb')) === 'Zeta' && !(await tab.shown('#byelist')));
  await tab.click('.rnd[data-round="2"]');
  ok('RB round 2: one team on a bye is said, and put in the first picker', (await tab.text('#byelist')) === 'Epsilon is on a bye in round 2.'
    && (await tab.shown('#teampickers')) && (await tab.js(`document.querySelector('#teama').value`)) === 'Epsilon');
  await tab.click('.rnd[data-round="1"]');
  ok('RB round 1: no team on a bye, said so; the last round\'s bye team is not kept', (await tab.text('#byelist')) === 'No team is on a bye in round 1.'
    && (await tab.js(`document.querySelector('#teama').value`)) === '');
  await tab.click('.rnd[data-round="3"]');
  const m = tab.mark();
  await startGame(tab);
  ok('RB a bye-round game sends no start', !tab.worker(m).some((x) => x.startsWith('POST')), tab.worker(m));
  await mq.buzz(tab, POWER_WORD, pl('Alpha', 1), 'correct');
  const m2 = tab.mark();
  await mq.cmd(tab, 'Upload to qb-td');
  await until(() => tab.dialogs.some((d) => d.message === 'This is the Bye Room, so nothing was uploaded.'), 'the Bye Room alert', 5000);
  ok('RB Upload says "This is the Bye Room, so nothing was uploaded." and sends nothing', !tab.worker(m2).some((x) => x.startsWith('POST')));
});

/* ---------------------------------------------------------------------- */
/* a game in Room 2: Start, reading, protests, uploads, resume            */
/* ---------------------------------------------------------------------- */

const hub = await newTab();
async function openHub() {
  await hub.goto(hubUrl(M.admin));
  await hub.waitJs(`!!document.querySelector('.hubtab')`, 'the hub');
  if (!(await hub.exists('.biground'))) await hub.click('[data-view="live"]');
  await hub.waitJs(`!!document.querySelector('.biground')`, 'the Live Hub');
}
// one click on Upload to qb-td, through to MODAQ's answer: the POST and its parsed body
async function upload(t, { expect = 'Export Succeeded', dismiss = true } = {}) {
  const m = t.mark();
  await mq.cmd(t, 'Upload to qb-td');
  const text = await mq.waitDialog(t, expect, 60000);
  const req = t.workerReqs(m).find((r) => r.method === 'POST' && /\/upload\?/.test(r.url));
  const raw = req ? await t.body(req) : null;
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
  if (dismiss) { await mq.dialogButton(t, 'OK'); await mq.noDialog(t); }
  return { text, req, raw, body, posts: t.worker(m).filter((x) => x.startsWith('POST /b/:s/upload')).length };
}
// the hub's Protests drawer as the TD reads it, opened
async function drawerText() {
  if (!(await hub.js(`document.querySelector('#protdrawer').open`))) await hub.click('#protdrawer summary');
  return hub.js(`document.querySelector('#protdrawer').innerText`);
}
const roomFiles = async (b, round) => (await M.detail()).files.filter((f) => f.bucket_id === b.id && (round === undefined || f.round === round));
const G2 = { secret: room('Room 2'), teams: gameAt(MS, 1, 3) };

await section('R26', 'Start game', async () => {
  const { a, b } = G2.teams;
  const held = [];
  await tab.intercept([{ urlPattern: '*/packet*', requestStage: 'Request' }], (p) => held.push(p.requestId));
  try {
    await openRoom(tab, G2.secret);
    await until(() => held.length >= 1, 'the packet request (held)', 5000);
    G2.m = tab.mark();
    await tab.click('#start');
    await sleep(300);
    ok('R26 Start turns itself off while the packet loads', await tab.js(`document.querySelector('#start').disabled && !document.body.classList.contains('reading')`));
    for (const id of held.splice(0)) await tab.S('Fetch.continueRequest', { requestId: id });
    await tab.waitJs(`document.body.classList.contains('reading') && !!document.querySelector('#modaq .ms-CommandBar')`, 'MODAQ after the packet', 20000);
  } finally { await tab.unintercept(); }
  const href = await tab.js('location.href');
  const u = new URL(href);
  G2.id = u.searchParams.get('g');
  G2.link = href;
  ok('R26 one POST /start?round=3', tab.worker(G2.m).filter((x) => x === 'POST /b/:s/start?round=3').length === 1, tab.worker(G2.m));
  ok('R26 the address becomes the game link: ?b=…&server=…&g=<id>', u.searchParams.get('b') === G2.secret && u.searchParams.get('server') === BASE
    && /^[a-z0-9]{6,}$/.test(G2.id || '') && !u.searchParams.has('test'), href);
  ok('R26 the picker and both side panels are gone', !(await tab.shown('#picker')) && !(await tab.shown('#schedpanel')) && !(await tab.shown('#tbpanel')));
  ok('R26 R09 during the game the header adds "A vs B" and a New game link', (await tab.shown('#game')) && (await tab.text('#game')) === `${a} vs ${b}`
    && (await tab.shown('#newgame')) && (await tab.text('#newgame')) === 'New game');
  const ng = new URL(await tab.js(`document.querySelector('#newgame').href`));
  ok('R26 New game links to the room link, keeping &server=', ng.searchParams.get('b') === G2.secret && ng.searchParams.get('server') === BASE && !ng.searchParams.has('g'), ng.href);
  ok('R26 MODAQ opens on the round\'s packet', (await mq.tossup(tab)).startsWith('1. R3T1 ') && (await mq.view(tab)).includes('Packet: P3.json'), await mq.tossup(tab));
  ok('R26 with the two teams, left team first', (await mq.score(tab)) === `${a}: 0, ${b}: 0`, await mq.score(tab));
  const bm = await mq.buzzMenu(tab, 0);
  ok('R26 each team\'s first four players playing (the roster\'s starters)', JSON.stringify(bm) === JSON.stringify({ [a]: [1, 2, 3, 4].map((j) => pl(a, j)), [b]: [1, 2, 3, 4].map((j) => pl(b, j)) }), bm);
  await mq.action(tab, 'Options', 'Change Format...');
  const fmt = await mq.waitDialog(tab, 'Customize Game Format');
  ok('R26 R28 with no format picked, MODAQ plays mACF with powers (20 tossups, -5 negs, powers)', /Format\s+mACF with powers/.test(fmt)
    && fmt.includes('Tossups in regulation: 20') && fmt.includes('Neg value: -5') && fmt.includes('Has powers: Yes'), fmt.slice(0, 300));
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
  const st = await tab.storage();
  const meta = JSON.parse(st[`qbtdMeta:${G2.secret}:${G2.id}`] || 'null');
  ok('R26 the game is kept on this device under its id', !!meta && meta.a === a && meta.b === b && meta.round === 3 && meta.packet === 'P3.json'
    && meta.room === 'Room 2' && meta.t === 'Reader Full Open' && !!st[`qbtdGame:${G2.secret}:${G2.id}`], meta);
  const d = await M.detail();
  ok('R26 the Worker records Room 2 as started on round 3', (d.starts || []).some((x) => x.bucket_id === M.rooms['Room 2'].id && x.round === 3), d.starts);
});

await section('R34', 'reading in MODAQ: buzzes, bonuses, moving between questions', async () => {
  const { a, b } = G2.teams;
  const saved = async () => (await tab.storage())[`qbtdGame:${G2.secret}:${G2.id}`];
  const s0 = await saved();
  await mq.buzz(tab, POWER_WORD, pl(a, 1), 'correct');
  ok('R34 a buzz in power scores 15 (mACF)', (await mq.score(tab)) === `${a}: 15, ${b}: 0`, await mq.score(tab));
  ok('R34 the Event Log says so', (await mq.events(tab)).includes(`${pl(a, 1)} (${a}) for 15`));
  await tab.click('#modaq input[aria-label="Part 1: Missed"]');
  await tab.click('#modaq input[aria-label="Part 3: Missed"]');
  ok('R34 two bonus parts right: 20 more', (await mq.score(tab)) === `${a}: 35, ${b}: 0` && (await mq.events(tab)).includes(`${a} 20 on bonus (✓✗✓)`), await mq.score(tab));
  await until(async () => (await saved()) !== s0, 'the game to be saved', 5000);
  ok('R34 the game is saved on this device as it changes', true);
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
  ok('R34 Next: question 2, its tossup', (await mq.tossup(tab)).startsWith('2. R3T2 '));
  await mq.buzz(tab, 5, pl(b, 2), 'wrong');
  ok('R34 a neg: -5', (await mq.score(tab)) === `${a}: 35, ${b}: -5`, await mq.score(tab));
  await mq.buzz(tab, LATE_WORD, pl(a, 2), 'correct');
  ok('R34 a buzz after the power mark: 10', (await mq.score(tab)) === `${a}: 45, ${b}: -5`, await mq.score(tab));
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 3, 'question 3', 5000);
  ok('R34 a dead tossup: no score change, the bonus still shows (Always show bonus is on)', (await mq.score(tab)) === `${a}: 45, ${b}: -5`
    && (await mq.view(tab)).includes('R3B3 leadin'), await mq.score(tab));
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 4, 'question 4', 5000);
  await mq.buzz(tab, LATE_WORD, pl(b, 1), 'correct');
  for (const n of [1, 2, 3]) await tab.click(`#modaq input[aria-label="Part ${n}: Missed"]`);
  ok('R34 the other team: 10 and 30 on the bonus', (await mq.score(tab)) === `${a}: 45, ${b}: 35`, await mq.score(tab));
  await mq.prev(tab);
  await until(async () => (await mq.at(tab)) === 3, 'back to question 3', 5000);
  ok('R34 Previous goes back a question', (await mq.tossup(tab)).startsWith('3. R3T3 '));
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 4, 'question 4 again', 5000);
  const ev = await mq.events(tab);
  ok('R34 the Event Log lists each question\'s buzzes and bonus', ev.includes(`${pl(b, 2)} (${b}) for -5`) && ev.includes(`${pl(a, 2)} (${a}) for 10`)
    && ev.includes(`${pl(b, 1)} (${b}) for 10`) && ev.includes(`${b} 30 on bonus (✓✓✓)`), ev.slice(0, 400));
  const labels = await tab.js(`[...document.querySelectorAll('#modaq .ms-CommandBar .ms-Button-label')].map((x) => x.textContent)`);
  ok('R34 MODAQ\'s own New game menu is hidden', JSON.stringify(labels) === JSON.stringify(['Options', 'View', 'Actions', 'Upload to qb-td', 'Help...']), labels);
});

await section('R36', 'live protests while the game is in progress', async () => {
  const { a, b } = G2.teams;
  const protestPosts = (m) => tab.workerReqs(m).filter((r) => r.method === 'POST' && r.url.includes('/protests?'));
  const bodyOf = async (r) => JSON.parse(await tab.body(r));
  const fill2 = async (given, reason) => {
    await tab.type('.ms-Dialog-main textarea', given);
    await tab.js(`document.querySelectorAll('.ms-Dialog-main textarea')[1].focus(), true`);
    await tab.S('Input.insertText', { text: reason });
    await mq.dialogButton(tab, 'OK');
    await mq.noDialog(tab);
  };
  // a protest on question 2's neg
  await mq.goTo(tab, 2);
  let m = tab.mark();
  await mq.word(tab, 5);
  await mq.menu(tab, pl(b, 2), 'Protest');
  await mq.waitDialog(tab, 'Add Protest');
  await fill2('treaty of utrecht', 'The answer line accepts it');
  let posts = await until(() => protestPosts(m).length >= 1 && protestPosts(m), 'the live protest POST', 12000);
  const p1 = await bodyOf(posts[0]);
  ok('R36 within one check (5 s), POST /protests?round=3&g=<id>', new URL(posts[0].url).searchParams.get('round') === '3'
    && new URL(posts[0].url).searchParams.get('g') === G2.id, posts[0].url);
  ok('R36 the body: the teams and the protest, numbered like the upload', JSON.stringify(p1.teams) === JSON.stringify([a, b]) && p1.protests.length === 1
    && p1.protests[0].kind === 'tu' && p1.protests[0].q === 2 && p1.protests[0].team === b && p1.protests[0].given === 'treaty of utrecht'
    && p1.protests[0].reason === 'The answer line accepts it', p1);
  await openHub();
  const drawer = await drawerText();
  ok('R36 the hub\'s Protests drawer shows it, marked "Game in progress", before any upload', drawer.includes('Game in progress') && drawer.includes('treaty of utrecht')
    && drawer.includes('The answer line accepts it'), drawer.slice(0, 400));
  // a server fault: the next check sends it again, with nothing changed
  let n500 = 0;
  await tab.intercept([{ urlPattern: '*/protests*', requestStage: 'Request' }], (p) => {
    if (n500++ === 0) {
      tab.S('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: PAGES }], body: Buffer.from('{"error":"Something went wrong on the server. Please try again."}').toString('base64') });
    } else tab.S('Fetch.continueRequest', { requestId: p.requestId });
  });
  try {
    m = tab.mark();
    await mq.goTo(tab, 1);
    await mq.action(tab, 'Actions', 'Protest bonus...', '2');
    await mq.waitDialog(tab, 'Add Protest');
    await fill2('second part answer', 'Prompt was not given');
    posts = await until(() => protestPosts(m).length >= 2 && protestPosts(m), 'the protest sent again after a 500', 14000);
    const [x, y] = [await tab.body(posts[0]), await tab.body(posts[1])];
    ok('R36 a 500: the next check sends the same list again, with nothing changed', x === y && JSON.parse(y).protests.length === 2
      && JSON.parse(y).protests.some((pp) => pp.kind === 'b'), JSON.parse(y).protests.map((pp) => pp.kind));
  } finally { await tab.unintercept(); }
  // a refusal: nothing more until the game changes
  await tab.intercept([{ urlPattern: '*/protests*', requestStage: 'Request' }], (p) => {
    tab.S('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 400, responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
      { name: 'Access-Control-Allow-Origin', value: PAGES }], body: Buffer.from('{"error":"bad protests"}').toString('base64') });
  });
  try {
    m = tab.mark();
    await mq.goTo(tab, 2);
    await mq.word(tab, 5);
    await mq.menu(tab, pl(b, 2), 'Protest');
    await mq.waitDialog(tab, 'Remove protest');
    await mq.dialogButton(tab, 'Remove'); // the tossup protest comes off
    await until(() => protestPosts(m).length >= 1, 'the refused POST', 12000);
    await sleep(11000); // two more checks
    ok('R36 a refusal (400): not sent again while nothing changes', protestPosts(m).length === 1, protestPosts(m).length);
  } finally { await tab.unintercept(); }
  // offline: the next check tries again
  let failedOnce = false;
  await tab.intercept([{ urlPattern: '*/protests*', requestStage: 'Request' }], (p) => {
    if (!failedOnce) { failedOnce = true; tab.S('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }); }
    else tab.S('Fetch.continueRequest', { requestId: p.requestId });
  });
  try {
    m = tab.mark();
    await mq.goTo(tab, 1);
    await mq.action(tab, 'Actions', 'Protest bonus...', '2');
    await mq.waitDialog(tab, 'Remove protest');
    await mq.dialogButton(tab, 'Remove'); // the bonus protest comes off too
    posts = await until(() => protestPosts(m).length >= 2 && protestPosts(m), 'the protest list sent again after going offline', 14000);
    ok('R36 offline: the next check sends again; removing every protest sends an empty list', JSON.parse(await tab.body(posts[1])).protests.length === 0,
      await tab.body(posts[1]));
  } finally { await tab.unintercept(); }
  await openHub();
  const after = await drawerText();
  ok('R36 and the hub\'s row is cleared', !after.includes('treaty of utrecht') && !after.includes('Game in progress'), after.slice(0, 300));
});

await section('R42', 'Upload to qb-td', async () => {
  const { a, b } = G2.teams;
  await mq.goTo(tab, 4);
  await mq.exportMenu(tab);
  const items = await mq.menuItems(tab);
  ok('R42 the export split button reads "Upload to qb-td", its menu "Upload to qb-td" and "Backup to JSON..."',
    JSON.stringify(items.map((x) => x.text)) === JSON.stringify(['Upload to qb-td', 'Backup to JSON...']) && items.every((x) => !x.disabled), items);
  await mq.closeMenus(tab);
  const u = await upload(tab);
  ok('R42 MODAQ says "Export Succeeded" / "Export succeeded."', u.text.startsWith('Export Succeeded') && u.text.includes('Export succeeded.'), u.text);
  const url = u.req && new URL(u.req.url);
  ok('R42 one POST /upload?round=3&name=Round_3_<A>_<B>.qbtd.json', u.posts === 1 && url.searchParams.get('round') === '3'
    && url.searchParams.get('name') === `Round_3_${a}_${b}.qbtd.json`, u.req && u.req.url);
  const body = u.body || {};
  ok('R42 the body: qbj, game, tb, progress and MODAQ\'s own export', ['qbj', 'game', 'tb', 'progress', 'modaq'].every((k) => k in body)
    && typeof body.modaq.qbj === 'string' && typeof body.modaq.game === 'string', Object.keys(body));
  const teams = ((body.qbj && body.qbj.match_teams) || []).map((t) => t.team && t.team.name);
  ok('R42 the qbj is the game: its teams and round', JSON.stringify(teams) === JSON.stringify([a, b]) && body.qbj._round === 3, { teams, round: body.qbj && body.qbj._round });
  ok('R42 tb: nothing from the pool read, and the question record', Array.isArray(body.tb.used) && body.tb.used.length === 0 && body.tb.map && body.tb.map.t === 22 && body.tb.map.b === 22, body.tb);
  // MODAQ's own Backup to JSON, for round 3, writes the same two files
  await mq.exportMenu(tab);
  await mq.menu(tab, 'Backup to JSON...');
  await mq.waitDialog(tab, 'Export to JSON');
  for (let i = 0; i < 2; i++) await tab.mouse('.ms-Dialog-main button[aria-label="Increase round number by 1"]');
  await tab.waitJs(`document.querySelector('.ms-Dialog-main input').value === '3'`, 'round 3 in the Backup dialog');
  const bq = await downloadFrom(tab, '.ms-Dialog-main a[download$=".qbj"]');
  await sleep(300);
  // each Export closes the dialog: open it again for the game file (the round stays 3)
  if (!(await tab.exists('.ms-Dialog-main'))) { await mq.exportMenu(tab); await mq.menu(tab, 'Backup to JSON...'); await mq.waitDialog(tab, 'Export to JSON'); }
  const bg = await downloadFrom(tab, '.ms-Dialog-main a[download$="_Game.json"]');
  if (await tab.exists('.ms-Dialog-main')) { await mq.dialogButton(tab, 'Cancel'); await mq.noDialog(tab); }
  ok('R42 modaq.qbj is byte for byte the QBJ MODAQ\'s Backup to JSON writes for round 3', bq.name === `Round_3_${a}_${b}.qbj` && bq.bytes.toString('utf8') === body.modaq.qbj, bq.name);
  // the one difference: "hasUpdates", true while the upload is made, false once MODAQ has marked the export done
  const gx = bg.bytes.toString('utf8');
  const gy = body.modaq.game.replace('"hasUpdates": true,', '"hasUpdates": false,');
  let at = 0;
  while (at < gx.length && gx[at] === gy[at]) at++;
  ok('R42 modaq.game is its game file as Backup writes it (but for "hasUpdates", true at upload time)', bg.name === `Round_3_${a}_${b}_Game.json` && gx === gy
    && body.modaq.game.includes('"hasUpdates": true,'), { name: bg.name, at, backup: gx.slice(Math.max(0, at - 80), at + 80), upload: gy.slice(Math.max(0, at - 80), at + 80) });
  const files = await roomFiles(M.rooms['Room 2'], 3);
  ok('R42 the hub gets a "combined" file in Room 2, round 3', files.length === 1 && files[0].kind === 'combined' && !files[0].error
    && files[0].filename === `Round_3_${a}_${b}.qbtd.json`, files);
  // R46: begun here, so it says how far it got
  ok('R46 progress: {at: 4, of: 20}', JSON.stringify(body.progress) === JSON.stringify({ at: 4, of: 20 }), body.progress);
  await openHub();
  const cell = `[data-cell="${M.rooms['Room 2'].id}:3"]`;
  ok('R46 the hub marks it in progress: "In progress: on question 4 of 20 at the last upload"',
    (await hub.js(`(document.querySelector(${q(cell)}) || {}).title || ''`)).includes('In progress: on question 4 of 20 at the last upload'),
    await hub.js(`(document.querySelector(${q(cell)}) || {}).title || ''`));
});

await section('R43', 'the uploading note, and a second click while it runs', async () => {
  const held = [];
  await tab.intercept([{ urlPattern: '*/upload*', requestStage: 'Request' }], (p) => held.push(p.requestId));
  try {
    const m = tab.mark();
    await mq.cmd(tab, 'Upload to qb-td');
    await tab.waitJs(`!!document.querySelector('.uploading')`, 'the uploading note', 5000);
    ok('R43 a full-screen note: "Uploading the game. Please wait." (role=status)', (await tab.text('.uploading')).trim() === 'Uploading the game. Please wait.'
      && (await tab.js(`document.querySelector('.uploading').getAttribute('role')`)) === 'status'
      && (await tab.js(`(() => { const r = document.querySelector('.uploading').getBoundingClientRect(); return r.width >= innerWidth - 1 && r.height >= innerHeight - 1; })()`)));
    // a mouse click on the button lands on the note
    const at = await tab.js(`(() => { const b = [...document.querySelectorAll('#modaq .ms-CommandBar button')].find((x) => (x.querySelector('.ms-Button-label') || {}).textContent === 'Upload to qb-td');
      const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, top: document.elementFromPoint(x, y).className }; })()`);
    ok('R43 the note takes the clicks', at.top === 'uploading', at);
    await tab.mouseAt(at.x, at.y);
    // a click that reaches the button anyway (the keyboard) joins the running upload
    await mq.cmd(tab, 'Upload to qb-td');
    await sleep(500);
    ok('R43 a second click sends no second POST', tab.worker(m).filter((x) => x.startsWith('POST /b/:s/upload')).length === 1 && held.length === 1, tab.worker(m));
    for (const id of held.splice(0)) await tab.S('Fetch.continueRequest', { requestId: id });
    await mq.waitDialog(tab, 'Export Succeeded', 20000);
    ok('R43 the note leaves once the upload lands', !(await tab.exists('.uploading')));
    await mq.dialogButton(tab, 'OK');
    await mq.noDialog(tab).catch(async () => { await mq.dialogButton(tab, 'OK'); await mq.noDialog(tab); });
    ok('R43 one file for one upload', (await roomFiles(M.rooms['Room 2'], 3)).length === 2);
  } finally { await tab.unintercept(); }
});

await section('R31', 'resuming from the game link', async () => {
  const { a, b } = G2.teams;
  const before = { score: await mq.score(tab), at: await mq.at(tab), tossup: await mq.tossup(tab) };
  // the TD replaces round 3's packet and moves on to round 4: the game is not touched
  await M.packet(3, 'P3.json', packetOf(3, 'X'));
  await M.round(4);
  try {
    const m = tab.mark();
    await tab.goto(G2.link);
    await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'the game again');
    await sleep(500);
    ok('R31 the game link restores the game: score and question', (await mq.score(tab)) === before.score && (await mq.at(tab)) === before.at, [await mq.score(tab), await mq.at(tab), before]);
    ok('R31 the packet as it was read (a re-upload and a round change do not reach it)', (await mq.tossup(tab)) === before.tossup && !(await mq.view(tab)).includes('R3T1X'),
      await mq.tossup(tab));
    ok('R31 the header is the game\'s: its round, not the room\'s new one', (await tab.text('#room')) === 'Room 2 · Round 3' && (await tab.text('#game')) === `${a} vs ${b}`);
    const asked = tab.worker(m);
    ok('R31 the only request: GET /tiebreakers', JSON.stringify(asked) === JSON.stringify(['GET /b/:s/tiebreakers']), asked);
  } finally {
    await M.packet(3, 'P3.json', packetOf(3));
    await M.round(3);
  }
});

await section('R33', 'the New game link during a game', async () => {
  const { a, b } = G2.teams;
  await tab.goto(G2.link);
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'the game');
  const done = tab.loaded();
  await tab.mouse('#newgame');
  await done;
  await tab.waitJs(`!document.querySelector('#teamrow').hidden`, 'the room link');
  ok('R33 New game opens the room link with the picker', !(await tab.js('location.search')).includes('&g=') && (await tab.shown('#picker')));
  const dg = await devGames(tab);
  ok('R33 this game is listed "on this device" with Continue', dg.length === 1 && dg[0].text === `Round 3: ${a} vs ${b} on this device`
    && dg[0].link === 'Continue' && new URL(dg[0].href, PAGES).searchParams.get('g') === G2.id && new URL(dg[0].href, PAGES).searchParams.get('server') === BASE, dg);
  const done2 = tab.loaded();
  await tab.mouse('.devgames a');
  await done2;
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'the game from Continue');
  ok('R30 Continue opens the game', (await tab.js('location.href')) === new URL(dg[0].href, PAGES).href && (await mq.at(tab)) === 4);
});

await section('R44', 'a stalled upload gives up after 45 s', async () => {
  await tab.intercept([{ urlPattern: '*/upload*', requestStage: 'Request' }], () => { /* never answered */ });
  try {
    const t0 = Date.now();
    await mq.cmd(tab, 'Upload to qb-td');
    await tab.waitJs(`!!document.querySelector('.uploading')`, 'the uploading note', 5000);
    const text = await mq.waitDialog(tab, 'Export Error', 60000);
    const took = Date.now() - t0;
    ok('R44 after 45 s: MODAQ\'s "Export Error", "Export failed: the upload took too long. Please check the connection and upload again."',
      text.includes('Export failed: the upload took too long. Please check the connection and upload again.') && took >= 44000 && took < 55000, { text, took });
    ok('R44 the uploading note is gone', !(await tab.exists('.uploading')));
    await mq.dialogButton(tab, 'OK');
    await mq.noDialog(tab);
  } finally { await tab.unintercept(); }
  const u = await upload(tab);
  ok('R44 uploading again then works', u.text.startsWith('Export Succeeded') && (await roomFiles(M.rooms['Room 2'], 3)).length === 3, u.text);
});

await section('R47', 're-exporting replaces the game', async () => {
  const { a, b } = G2.teams;
  const R2 = M.rooms['Room 2'];
  // an upload with a protest, which the TD rules on
  await mq.goTo(tab, 2);
  await mq.word(tab, 5);
  await mq.menu(tab, pl(b, 2), 'Protest');
  await mq.waitDialog(tab, 'Add Protest');
  await tab.type('.ms-Dialog-main textarea', 'treaty of paris');
  await tab.js(`document.querySelectorAll('.ms-Dialog-main textarea')[1].focus(), true`);
  await tab.S('Input.insertText', { text: 'Paris was also acceptable' });
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  // MODAQ saves the game 200 ms after a change; the upload reads the saved game
  await until(async () => ((await tab.storage())[`qbtdGame:${G2.secret}:${G2.id}`] || '').includes('Paris was also acceptable'), 'the protest saved', 5000);
  const withProtest = await upload(tab);
  ok('R47 an upload carries its protests', Array.isArray(withProtest.body.protests) && withProtest.body.protests.length === 1
    && withProtest.body.protests[0].given === 'treaty of paris', withProtest.body && withProtest.body.protests);
  await openHub();
  await until(async () => (await drawerText()).includes('treaty of paris'), 'the uploaded protest on the hub', 8000);
  await hub.pick('#protdrawer select[data-rule]', 'upheld');
  await hub.waitJs(`document.querySelector('#msg').textContent === 'Saved: Upheld'`, 'the ruling saved');
  // the moderator corrects the game (the protest off) and exports it again, its teams the other way round
  await mq.word(tab, 5);
  await mq.menu(tab, pl(b, 2), 'Protest');
  await mq.waitDialog(tab, 'Remove protest');
  await mq.dialogButton(tab, 'Remove');
  await mq.noDialog(tab);
  await until(async () => !((await tab.storage())[`qbtdGame:${G2.secret}:${G2.id}`] || '').includes('Paris was also acceptable'), 'the protest removal saved', 5000);
  await mq.action(tab, 'Actions', 'Reorder teams...');
  await mq.waitDialog(tab, 'Reorder teams');
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  ok('R34 Reorder teams swaps the sides', (await mq.score(tab)).startsWith(`${b}: `), await mq.score(tab));
  await sleep(400); // MODAQ's save
  const swapped = await upload(tab);
  const steams = swapped.body.qbj.match_teams.map((t) => t.team.name);
  ok('R47 the re-export: same file name, the teams the other way round in its qbj', new URL(swapped.req.url).searchParams.get('name') === `Round_3_${a}_${b}.qbtd.json`
    && JSON.stringify(steams) === JSON.stringify([b, a]), steams);
  const files = await roomFiles(R2, 3);
  await openHub();
  await hub.click(`[data-cell="${R2.id}:3"]`);
  await hub.waitJs(`!!document.querySelector('.cellpanel')`, 'the cell panel');
  const rows = await hub.js(`[...document.querySelectorAll('.cellpanel .pfile')].map((p) => ({ old: p.classList.contains('old'), text: p.querySelector('.pline').innerText }))`);
  ok('R47 the hub lists every upload of the game, all but the newest marked "superseded"', rows.length === files.length && files.length >= 5 && !rows[0].old
    && rows.slice(1).every((r) => r.old && r.text.includes('superseded')), rows);
  await hub.click('[data-closecell]');
  const drawer = await drawerText();
  ok('R47 its protest now comes from the newest upload: "Before the correction", "Corrected game received"',
    drawer.includes('treaty of paris') && drawer.includes('Before the correction') && drawer.includes('Corrected game received'), drawer.slice(0, 600));
  await hub.click('#calc');
  await hub.waitJs(`!document.querySelector('#statsec').hidden && !!document.querySelector('#statsout table') && !document.querySelector('#dlmenu').disabled`, 'stats', 30000);
  ok('R47 Compute counts the game once', /^1 games? in these stats$/.test(await hub.text('#statsnote')), await hub.text('#statsnote'));
  await hub.click('#dlmenu');
  await hub.waitJs(`!document.querySelector('#dlpanel').hidden`, 'the downloads menu');
  const zip = await readZip(new Uint8Array((await downloadFrom(hub, '#dlzip')).bytes));
  const names = zip.map((e) => e.name);
  const entry = (n) => { const e = zip.find((x) => x.name === n); return e ? new TextDecoder().decode(e.data) : null; };
  // one file per name: an export under a name already there keeps the newest (hubgames.js qbjZipFile)
  ok('R47 the QBJ bundle keeps the game\'s export under each team order: Round_3_A_B.qbj and Round_3_B_A.qbj',
    names.includes(`round-3/Round_3_${a}_${b}.qbj`) && names.includes(`round-3/Round_3_${b}_${a}.qbj`), names);
  ok('R47 under a name used twice, the newest upload\'s file', entry(`round-3/Round_3_${a}_${b}.qbj`) === withProtest.body.modaq.qbj
    && entry(`round-3/Round_3_${b}_${a}.qbj`) === swapped.body.modaq.qbj);
  await hub.click('#dlmenu');
  await hub.waitJs(`!document.querySelector('#dlpanel').hidden`, 'the downloads menu');
  const yft = JSON.parse((await downloadFrom(hub, '#dlyft4')).bytes.toString('utf8'));
  const games = yft.objects[0].phases.flatMap((p) => p.rounds.flatMap((r) => r.matches));
  ok('R47 the YellowFruit .yft has the game once', games.length === 1, games.length);
});

/* ---------------------------------------------------------------------- */
/* the start card: starters, seating, sides (Room 4)                      */
/* ---------------------------------------------------------------------- */

// a drag with the mouse, as Chrome runs it: pressed on `from`, moved to
// `to`, dropped there (or cancelled when the page refuses the drop)
async function drag(t, from, to) {
  await t.S('Input.setInterceptDrags', { enabled: true });
  const got = new Promise((res) => {
    const fn = (m) => {
      if (m.sessionId === t.sessionId && m.method === 'Input.dragIntercepted') { browserListeners.splice(browserListeners.indexOf(fn), 1); res(m.params.data); }
    };
    browserListeners.push(fn);
    setTimeout(() => { const i = browserListeners.indexOf(fn); if (i >= 0) browserListeners.splice(i, 1); res(null); }, 3000);
  });
  await t.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await t.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await t.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6, button: 'left', buttons: 1 });
  }
  const data = await got;
  if (data) {
    await t.S('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data });
    await t.S('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
    await t.S('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
  }
  await t.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await t.S('Input.setInterceptDrags', { enabled: false });
  return !!data;
}
const centre = (t, sel, dy = 0) => t.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
  e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 + ${dy} * r.height }; })()`);
const order = async (t) => Object.fromEntries((await starterCols(t)).map((c) => [c.team, c.players.map((p) => p.name)]));
const G4 = { secret: room('Room 4'), teams: gameAt(MS, 3, 3) };
const pbtn = (team, name) => `#starters [data-team="${team}"][data-player="${name}"]`;

await section('R21', 'the starters checklist', async () => {
  const { a, b } = G4.teams;
  await openRoom(tab, G4.secret);
  let cols = await starterCols(tab);
  ok('R21 a column per team, every roster player, in roster order', JSON.stringify(cols.map((c) => c.team)) === JSON.stringify([a, b])
    && cols.every((c) => JSON.stringify(c.players.map((p) => p.name)) === JSON.stringify([1, 2, 3, 4, 5].map((j) => pl(c.team, j)))), cols);
  ok('R21 the roster\'s starters (the first four) ticked, "4 starting"; the fifth reads "bench"', cols.every((c) => c.count === '4 starting' && !c.none
    && c.players.slice(0, 4).every((p) => p.on && !p.bench && p.pressed === 'true') && !c.players[4].on && c.players[4].bench && c.players[4].pressed === 'false'), cols);
  await tab.click(pbtn(a, pl(a, 5)));
  await tab.click(pbtn(a, pl(a, 1)));
  cols = await starterCols(tab);
  ok('R21 a click ticks a player in, another out: any number a team', cols[0].count === '4 starting' && cols[0].players[4].on && !cols[0].players[0].on && cols[0].players[0].bench, cols[0]);
  await tab.click(pbtn(a, pl(a, 2)));
  await tab.click(pbtn(a, pl(a, 3)));
  await tab.click(pbtn(a, pl(a, 4)));
  ok('R21 one starter: "1 starting"', (await starterCols(tab))[0].count === '1 starting');
  for (let j = 1; j <= 4; j++) await tab.click(pbtn(b, pl(b, j)));
  cols = await starterCols(tab);
  ok('R21 none: "0 starting", in red', cols[1].count === '0 starting' && cols[1].none && (await red(tab, '#starters .lineup:nth-child(2) .count')), cols[1]);
  const m = tab.mark();
  await tab.click('#start');
  await sleep(200);
  ok('R21 Start with a team at 0: "Pick at least one starter for <team>", in red, nothing starts', (await tab.text('#msg')) === `Pick at least one starter for ${b}`
    && (await red(tab, '#msg')) && !(await tab.js(`document.body.classList.contains('reading')`)) && !tab.worker(m).some((x) => x.startsWith('POST')), await tab.text('#msg'));
  await tab.click(pbtn(a, pl(a, 5)));
  await tab.click('#start');
  await sleep(200);
  ok('R21 both at 0: "Pick at least one starter for A and B"', (await tab.text('#msg')) === `Pick at least one starter for ${a} and ${b}`, await tab.text('#msg'));
  // the line-up started below: a: P2 and P5, b: P3
  await tab.click(pbtn(a, pl(a, 2)));
  await tab.click(pbtn(a, pl(a, 5)));
  await tab.click(pbtn(b, pl(b, 3)));
  cols = await starterCols(tab);
  ok('R21 the counts follow', cols[0].count === '2 starting' && cols[1].count === '1 starting' && !cols[1].none, cols.map((c) => c.count));
});

await section('R22', 'seating order: Alt+Up/Down and dragging', async () => {
  const { a, b } = G4.teams;
  await tab.js(`document.querySelector(${q(pbtn(a, pl(a, 5)))}).focus(), true`);
  await tab.key('ArrowUp', 'ArrowUp', 38, 1);
  ok('R22 Alt+Up moves a player up one place', JSON.stringify((await order(tab))[a]) === JSON.stringify([1, 2, 3, 5, 4].map((j) => pl(a, j))), await order(tab));
  ok('R22 and keeps the focus on that player', (await tab.js(`document.activeElement && document.activeElement.dataset.player`)) === pl(a, 5));
  await tab.js(`document.querySelector(${q(pbtn(a, pl(a, 1)))}).focus(), true`);
  await tab.key('ArrowDown', 'ArrowDown', 40, 1);
  ok('R22 Alt+Down moves a player down one place', JSON.stringify((await order(tab))[a]) === JSON.stringify([2, 1, 3, 5, 4].map((j) => pl(a, j))), await order(tab));
  // by its grip, to the top of its team's list
  const from = await centre(tab, `#starters .prow[data-name="${pl(b, 3)}"] .grip`);
  const to = await centre(tab, `#starters .prow[data-name="${pl(b, 1)}"]`, -0.3);
  const dragged = await drag(tab, from, to);
  ok('R22 dragging a player by its grip reorders the list', dragged && JSON.stringify((await order(tab))[b]) === JSON.stringify([3, 1, 2, 4, 5].map((j) => pl(b, j))), { dragged, order: await order(tab) });
  // never into the other team
  const before = await order(tab);
  const from2 = await centre(tab, `#starters .prow[data-name="${pl(b, 5)}"] .grip`);
  const to2 = await centre(tab, `#starters .prow[data-name="${pl(a, 1)}"]`, -0.3);
  await drag(tab, from2, to2);
  ok('R22 a row cannot be dropped into the other team', JSON.stringify(await order(tab)) === JSON.stringify(before), await order(tab));
});

await section('R23', 'swapping sides', async () => {
  const { a, b } = G4.teams;
  await tab.click(`#starters .lineup[data-side="${a}"] [data-swap]`);
  ok('R23 the swap grip ("Swap sides") puts the other team on the left', JSON.stringify((await starterCols(tab)).map((c) => c.team)) === JSON.stringify([b, a])
    && (await tab.js(`document.querySelector('#teama').value`)) === b && (await tab.js(`document.querySelector('[data-swap]').getAttribute('aria-label')`)) === 'Swap sides');
  ok('R23 the locked matchup turns with it', (await tab.text('#mteama')) === b && (await tab.text('#mteamb')) === a && (await tab.shown('#schedmatch')));
  // a column dragged onto the other swaps them back
  const from = await centre(tab, `#starters .lineup[data-side="${b}"] h4 .lname`);
  const to = await centre(tab, `#starters .lineup[data-side="${a}"] h4`);
  const dragged = await drag(tab, from, to);
  ok('R23 dragging one column onto the other swaps them', dragged && JSON.stringify((await starterCols(tab)).map((c) => c.team)) === JSON.stringify([a, b]), { dragged, cols: (await starterCols(tab)).map((c) => c.team) });
  await tab.click(`#starters .lineup[data-side="${a}"] [data-swap]`);
  const d0 = tab.dialogs.length;
  G4.id = await startGame(tab);
  ok('R23 Start after a swap does not warn: the scheduled teams, other way round', !tab.dialogs.slice(d0).some((x) => x.message.startsWith('WARNING')), tab.dialogs.slice(d0));
  ok('R23 the left column is the left team in MODAQ', (await mq.score(tab)) === `${b}: 0, ${a}: 0`, await mq.score(tab));
  const bm = await mq.buzzMenu(tab, 0);
  ok('R21 MODAQ opens with exactly the ticked players playing', JSON.stringify(bm) === JSON.stringify({ [b]: [pl(b, 3)], [a]: [pl(a, 2), pl(a, 5)] }), bm);
  await mq.action(tab, 'Actions', 'Player');
  await sleep(300);
  const items = await mq.menuItems(tab);
  await mq.closeMenus(tab);
  const per = {};
  let cur = null;
  for (const it of items) { if (it.header === a || it.header === b) { cur = it.header; per[cur] = []; } else if (it.header) cur = null; else if (cur) per[cur].push(it.text); }
  ok('R22 MODAQ lists each team\'s players in the seating order', JSON.stringify(per[a]) === JSON.stringify([2, 1, 3, 5, 4].map((j) => pl(a, j)))
    && JSON.stringify(per[b]) === JSON.stringify([3, 1, 2, 4, 5].map((j) => pl(b, j))), per);
});

/* ---------------------------------------------------------------------- */
/* earlier rounds, and a round set back (Room 5, Room 1)                  */
/* ---------------------------------------------------------------------- */

await section('R11', 'played rounds stay selectable; future rounds locked', async () => {
  const S5 = room('Room 5');
  const g = gameAt(MS, 4, 2);
  await openRoom(tab, S5);
  await tab.click('.rnd[data-round="2"]');
  ok('R11 clicking an earlier round selects it and names its packet', (await roundButtons(tab)).find((x) => x.n === '2').sel && (await tab.text('#packetname')) === 'Packet: P2.json');
  ok('R11 and locks in that round\'s scheduled matchup', (await tab.text('#schedfrom')) === 'From the schedule · Round 2 in Room 5'
    && (await tab.text('#mteama')) === g.a && (await tab.text('#mteamb')) === g.b);
  const m = tab.mark();
  await startGame(tab);
  ok('R11 Start reads that round\'s packet (a room running behind)', tab.worker(m).includes('GET /b/:s/packet?round=2&warm=1') && (await mq.tossup(tab)).startsWith('1. R2T1 ')
    && tab.worker(m).includes('POST /b/:s/start?round=2'), tab.worker(m));
  ok('R11 the header says round 2', (await tab.text('#room')) === 'Room 5 · Round 2');
  ok('R11 the Worker records the start on round 2', ((await M.detail()).starts || []).some((x) => x.bucket_id === M.rooms['Room 5'].id && x.round === 2));
  // the TD sets the round back after the page loaded
  const S1 = room('Room 1');
  await openRoom(tab, S1); // round 3's packet comes with the page
  await M.round(1);
  try {
    await tab.click('.rnd[data-round="2"]');
    const m2 = tab.mark();
    await tab.click('#start');
    await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'the refusal');
    ok('R11 Start on a round that is now ahead of the room: "not the live round yet", in red', (await tab.text('#msg')) === 'not the live round yet' && (await red(tab, '#msg')),
      await tab.text('#msg'));
    ok('R11 Start is on again, nothing started', !(await tab.js(`document.querySelector('#start').disabled`)) && !(await tab.js(`document.body.classList.contains('reading')`))
      && tab.workerReqs(m2).some((r) => r.url.includes('/packet?round=2') && r.status === 403), tab.workerReqs(m2).map((r) => r.url + ' ' + r.status));
    // the round whose packet came with the page
    await tab.click('.rnd[data-round="3"]');
    await tab.pick('#teama', 'Alpha');
    await tab.pick('#teamb', 'Beta');
    const m3 = tab.mark();
    await tab.click('#start');
    await tab.waitJs(`document.body.classList.contains('reading') || document.querySelector('#msg').textContent.length > 0`, 'Start on round 3');
    await sleep(500);
    const what = (await tab.js(`document.body.classList.contains('reading')`)) ? 'the game starts' : await tab.text('#msg');
    const startAnswer = tab.workerReqs(m3).find((r) => r.url.includes('/start?round=3'));
    known('R11 Start on the round now ahead of the room, whose packet came with the page: the game starts (the Worker refuses its start, 400)',
      what === 'the game starts' && startAnswer && startAnswer.status === 400 ? 'the game starts' : what, 'the game starts', 'not the live round yet');
  } finally { await M.round(3); }
});

/* ---------------------------------------------------------------------- */
/* MODAQ: throwing out, and the rest of its menus (Room 5)                */
/* ---------------------------------------------------------------------- */

const G5 = { secret: room('Room 5'), teams: gameAt(MS, 4, 3) };
// the X (Delete) of the Event Log entry that reads `text` (MODAQ's CycleItem:
// one box per entry, its text and, when it can be deleted, its X)
const eventX = (text) => `[...document.querySelectorAll('#modaq div[class*="eventContainer"]')]
  .filter((c) => !c.querySelector('div[class*="eventContainer"]') && c.innerText.trim().split('\\n')[0].trim() === ${q(text)})
  .map((c) => c.querySelector('button[aria-label="Delete"]')).filter(Boolean)`;
const hasEventX = (t, text) => t.js(`${eventX(text)}.length > 0`);
async function deleteEvent(t, text) {
  const id = 'del' + Math.random().toString(36).slice(2, 8);
  await t.js(`(() => { const b = ${eventX(text)}[0]; if (!b) throw new Error('no X for ' + ${q(text)}); b.id = ${q(id)}; return true; })()`);
  await t.mouse('#' + id);
}

await section('R35', 'Throw out tossup / Throw out bonus', async () => {
  const { a, b } = G5.teams;
  await openRoom(tab, G5.secret);
  G5.id = await startGame(tab);
  await mq.buzz(tab, 5, pl(a, 2), 'wrong');
  ok('R35 a neg on question 1', (await mq.score(tab)) === `${a}: -5, ${b}: 0`, await mq.score(tab));
  await tab.mouse('#modaq button[aria-label="Throw out tossup"]');
  const d = await mq.waitDialog(tab, 'Throw out Tossup');
  ok('R35 the X on the tossup asks first', d.includes('Click OK to throw out the tossup. To undo this, click on the X next to its event in the Event Log.'), d);
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  ok('R35 thrown out: "Threw out tossup #1", the next tossup (2) read in its place', (await mq.events(tab)).includes('Threw out tossup #1') && (await mq.tossup(tab)).startsWith('2. R3T2 '), await mq.tossup(tab));
  ok('R35 the thrown-out tossup\'s neg goes with it', (await mq.score(tab)) === `${a}: 0, ${b}: 0`, await mq.score(tab));
  await mq.buzz(tab, 5, pl(a, 3), 'wrong');
  ok('R35 a neg on the tossup now in that slot counts', (await mq.score(tab)) === `${a}: -5, ${b}: 0`, await mq.score(tab));
  // question 2: thrown out from the Actions menu, then undone with its X
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
  await mq.action(tab, 'Actions', 'Throw out tossup');
  await mq.waitDialog(tab, 'Throw out Tossup');
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  ok('R35 Actions > Throw out tossup: "Threw out tossup #3", tossup 4 read instead', (await mq.events(tab)).includes('Threw out tossup #3') && (await mq.tossup(tab)).startsWith('4. R3T4 '), await mq.tossup(tab));
  await deleteEvent(tab, 'Threw out tossup #3');
  const sure = await mq.waitDialog(tab, '', 5000).catch(() => '');
  if (sure) await mq.dialogButton(tab, (await tab.js(`[...document.querySelectorAll('.ms-Dialog-main button')].map((x) => x.textContent)`)).find((x) => ['Yes', 'OK', 'Delete', 'Remove'].includes(x)));
  await until(async () => (await mq.tossup(tab)).startsWith('3. R3T3 '), 'the throw-out undone', 5000);
  ok('R35 its X undoes it: tossup 3 is back', !(await mq.events(tab)).includes('Threw out tossup #3'));
  // a bonus thrown out, then undone
  await mq.buzz(tab, LATE_WORD, pl(b, 1), 'correct');
  const bonusNow = (await mq.view(tab)).match(/R3B\d+ leadin/);
  await mq.action(tab, 'Actions', 'Throw out bonus');
  const db = await mq.waitDialog(tab, 'Throw out Bonus');
  ok('R35 Throw out bonus asks first', db.includes('Click OK to throw out the bonus.'), db);
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  const ev = await mq.events(tab);
  ok('R35 "Threw out bonus #N", the next bonus in its place', /Threw out bonus #\d+/.test(ev) && !(await mq.view(tab)).includes(bonusNow[0]), ev.slice(0, 300));
  await deleteEvent(tab, ev.match(/Threw out bonus #\d+/)[0]);
  const sure2 = await mq.waitDialog(tab, '', 5000).catch(() => '');
  if (sure2) await mq.dialogButton(tab, (await tab.js(`[...document.querySelectorAll('.ms-Dialog-main button')].map((x) => x.textContent)`)).find((x) => ['Yes', 'OK', 'Delete', 'Remove'].includes(x)));
  await until(async () => (await mq.view(tab)).includes(bonusNow[0]), 'the bonus throw-out undone', 5000);
  ok('R35 its X undoes it: the bonus is back', !/Threw out bonus/.test(await mq.events(tab)));
});

await section('R34b', 'MODAQ\'s Options, View, Help and Actions menus', async () => {
  const { a, b } = G5.teams;
  const viewItem = async (name) => { await mq.closeMenus(tab); await mq.cmd(tab, 'View'); await sleep(200); const it = (await mq.menuItems(tab)).find((x) => x.text === name); await mq.closeMenus(tab); return it; };
  const toggle = (name) => mq.action(tab, 'View', name);
  const clock = () => tab.js(`/\\b\\d{1,2}:\\d{2}:\\d{2}\\s?[AP]M\\b/.test(document.querySelector('#modaq').innerText)`);
  ok('R34 View > Clock: on, a clock shows', (await viewItem('Clock')).checked && (await clock()));
  await toggle('Clock');
  ok('R34 View > Clock off: the clock goes', !(await viewItem('Clock')).checked && !(await clock()));
  await toggle('Clock');
  ok('R34 Event Log on: the log shows', (await viewItem('Event Log')).checked && (await mq.view(tab)).includes('\nEvents\n'));
  await toggle('Event Log');
  ok('R34 Event Log off: the log goes', !(await viewItem('Event Log')).checked && !(await mq.view(tab)).includes('\nEvents\n'));
  await toggle('Event Log');
  ok('R34 Packet Name on: "Packet: P3.json"', (await viewItem('Packet Name')).checked && (await mq.view(tab)).includes('Packet: P3.json'));
  await toggle('Packet Name');
  ok('R34 Packet Name off: the name goes', !(await viewItem('Packet Name')).checked && !(await mq.view(tab)).includes('Packet: P3.json'));
  await toggle('Packet Name');
  // a dead tossup's bonus: shown with Always show bonus, hidden without
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 3, 'question 3', 5000);
  const deadBonus = /R3B\d+ leadin/.test(await mq.view(tab));
  await toggle('Always show bonus');
  ok('R34 Always show bonus: a dead tossup\'s bonus shows when on, and not when off', deadBonus && !(await viewItem('Always show bonus')).checked && !/R3B\d+ leadin/.test(await mq.view(tab)));
  await toggle('Always show bonus');
  const bg = () => tab.js(`(() => { let e = document.querySelector('#modaq .ms-CommandBar'); while (e && getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)') e = e.parentElement; return e ? getComputedStyle(e).backgroundColor : ''; })()`);
  const light = await bg();
  await toggle('Dark Mode');
  ok('R34 Dark Mode: on, and the colours change', (await viewItem('Dark Mode')).checked && (await bg()) !== light, [light, await bg()]);
  await toggle('Dark Mode');
  ok('R34 Dark Mode off again', !(await viewItem('Dark Mode')).checked && (await bg()) === light);
  const line = await mq.score(tab);
  await toggle('Vertical Score');
  ok('R34 Vertical Score: the score no longer on one line', (await viewItem('Vertical Score')).checked && (await mq.score(tab)) === null, await mq.score(tab));
  await toggle('Vertical Score');
  ok('R34 Vertical Score off: one line again', !(await viewItem('Vertical Score')).checked && (await mq.score(tab)) === line, await mq.score(tab));
  await toggle('Highlight Bonus');
  ok('R34 Highlight Bonus toggles', !(await viewItem('Highlight Bonus')).checked);
  await toggle('Highlight Bonus');
  await mq.action(tab, 'View', 'Scoresheet...');
  const sheet = await mq.waitDialog(tab, 'Scoresheet');
  ok('R34 Scoresheet... shows the scoresheet', sheet.includes(`${a.toUpperCase()} VS. ${b.toUpperCase()}`), sheet.slice(0, 100));
  await mq.dialogButton(tab, 'Close');
  await mq.noDialog(tab);
  await mq.action(tab, 'Options', 'Font...');
  const font = await mq.waitDialog(tab, 'Font');
  ok('R34 Options > Font... opens the font dialog', font.includes('Font size') && font.includes('Pronunciation guide color'), font.slice(0, 120));
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
  await mq.cmd(tab, 'Help...');
  const help = await mq.waitDialog(tab, 'Help');
  ok('R34 Help... opens MODAQ\'s help', help.includes('How to use MODAQ'), help.slice(0, 80));
  await mq.dialogButton(tab, 'Close');
  await mq.noDialog(tab);
  // players: leave, enter, substitute, rename, add
  await mq.action(tab, 'Actions', 'Player', pl(a, 4), 'Leave');
  const leave = await mq.waitDialog(tab, 'Let Player Leave');
  ok('R34 Leave asks first', leave.includes(`Are you sure you want to let the player "${pl(a, 4)}" from team "${a}" leave the game before question #3?`), leave);
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  let bm = await mq.buzzMenu(tab, 0);
  ok('R34 Actions > Player > Leave: the player is out', !bm[a].includes(pl(a, 4)) && bm[a].length === 3, bm);
  await mq.action(tab, 'Actions', 'Player', pl(a, 5), 'Enter');
  bm = await mq.buzzMenu(tab, 0);
  ok('R34 Player > Enter: the player is in', bm[a].includes(pl(a, 5)) && bm[a].length === 4, bm);
  await mq.action(tab, 'Actions', 'Player', pl(a, 1), pl(a, 4));
  const sub = await mq.waitDialog(tab, 'Substitute Player');
  ok('R34 a substitution in the middle of a half asks first', sub.includes('Are you sure you want to substitute before question #3?'), sub);
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  bm = await mq.buzzMenu(tab, 0);
  ok('R34 Player > Substitute: one out, the other in', bm[a].includes(pl(a, 4)) && !bm[a].includes(pl(a, 1)), bm);
  await mq.action(tab, 'Actions', 'Player', pl(b, 1), 'Rename');
  await mq.waitDialog(tab, 'Rename');
  await tab.type('.ms-Dialog-main input[type="text"]', 'Renamed Player');
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  bm = await mq.buzzMenu(tab, 0);
  ok('R34 Player > Rename: the new name', bm[b].includes('Renamed Player') && !bm[b].includes(pl(b, 1)), bm);
  await mq.action(tab, 'Actions', 'Add player...');
  await mq.waitDialog(tab, 'Add Player');
  await tab.type('.ms-Dialog-main input[type="text"]', 'New Player');
  await mq.dialogButton(tab, 'Add');
  await mq.noDialog(tab);
  bm = await mq.buzzMenu(tab, 0);
  ok('R34 Add player...: the new player plays', Object.values(bm).some((list) => list.includes('New Player')), bm);
  await mq.action(tab, 'Actions', 'Reorder players...');
  const rp = await mq.waitDialog(tab, 'Reorder Players');
  ok('R34 Reorder players... opens its dialog', rp.includes('Drag and drop players into the desired position'), rp.slice(0, 100));
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
  await mq.action(tab, 'Actions', 'Rename team...');
  await mq.waitDialog(tab, 'Rename Team');
  await tab.type('.ms-Dialog-main input[type="text"]', a + ' Renamed');
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  ok('R34 Rename team...: the scoreboard follows', ((await mq.score(tab)) || '').startsWith(a + ' Renamed: '), await mq.score(tab));
  // Backup to JSON...: MODAQ's own files, as the upload carries them
  await mq.exportMenu(tab);
  await mq.menu(tab, 'Backup to JSON...');
  const bk = await mq.waitDialog(tab, '');
  ok('R34 Backup to JSON... opens MODAQ\'s "Export to JSON"', bk.startsWith('Export to JSON') && bk.includes('Export game') && bk.includes('Export QBJ'), bk.slice(0, 200));
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
});

/* ---------------------------------------------------------------------- */
/* Add questions, Replace, Undo, and the tiebreaker log (Room 6)          */
/* ---------------------------------------------------------------------- */

const G6 = { secret: room('Room 6'), teams: gameAt(MS, 5, 3) };
// labels as read, without Fluent's icon glyphs (private-use characters)
const CLEAN = `const clean = (s) => String(s || '').replace(/[\\uE000-\\uF8FF]/g, '').trim();`;
const dlgChecks = (t) => t.js(`(() => { ${CLEAN} return [...document.querySelectorAll('.ms-Dialog-main .ms-Checkbox')].map((c) => ({ label: clean(c.innerText),
  disabled: c.classList.contains('is-disabled') || !!c.querySelector('input:disabled') })); })()`);
const dlgRadios = (t) => t.js(`(() => { ${CLEAN} return [...document.querySelectorAll('.ms-Dialog-main input[type=radio]')].map((r) => ({
  label: clean((document.querySelector('label[for="' + r.id + '"]') || {}).innerText), disabled: r.disabled, checked: r.checked })); })()`);
async function dlgClick(t, label, kind = 'checkbox') {
  const id = 'pick' + Math.random().toString(36).slice(2, 8);
  await t.js(`(() => { ${CLEAN} const all = [...document.querySelectorAll('.ms-Dialog-main input[type=${kind}]')];
    const i = all.find((x) => { const l = x.id && document.querySelector('label[for="' + x.id + '"]'); return l && clean(l.innerText).startsWith(${q(label)}); });
    if (!i) throw new Error('no ${kind} ' + ${q(label)}); document.querySelector('label[for="' + i.id + '"]').id = ${q(id)}; return true; })()`);
  await t.mouse('#' + id);
}
const tbOf = async (t, secret, id) => (JSON.parse((await t.storage())[`qbtdMeta:${secret}:${id}`] || '{}').tb) || null;
const fileFx = () => writeFx('more-questions.json', FILE_PACKET);

await section('R37', 'Add questions: the tiebreaker pool', async () => {
  await openRoom(tab, G6.secret);
  G6.id = await startGame(tab);
  await mq.action(tab, 'Actions', 'Add questions...');
  const d = await mq.waitDialog(tab, 'Add Questions');
  ok('R37 "Add Questions", with the note to use Replace for the question being read',
    d.includes('To replace the question being read, please use Replace tossup or Replace bonus in the Actions menu instead.'), d.slice(0, 300));
  ok('R37 the pool: "Tiebreaker questions from the tournament director. Check with the TD which one to read."',
    d.includes('Tiebreaker questions from the tournament director. Check with the TD which one to read.'));
  const checks = await dlgChecks(tab);
  ok('R37 one checkbox per question: "TU1 · Tossup — <answer>"', JSON.stringify(checks.map((c) => c.label)) === JSON.stringify(['TU1 · Tossup — Treaty of Ghent',
    'TU2 · Tossup — Peace of Utrecht', 'TU3 · Tossup — Congress of Vienna', 'B1 · Bonus — tbx / tby / tbz', 'B2 · Bonus — tbu / tbv / tbw']) && checks.every((c) => !c.disabled), checks);
  const radios = await dlgRadios(tab);
  ok('R37 "Where should they go?": Here (picked) or At the end of the packet', d.includes('Where should they go?')
    && JSON.stringify(radios) === JSON.stringify([{ label: 'Here', disabled: false, checked: true }, { label: 'At the end of the packet', disabled: false, checked: false }]), radios);
  ok('R37 "Or load more questions from a packet file:" with MODAQ\'s loader', d.includes('Or load more questions from a packet file:') && (await tab.exists('.ms-Dialog-main input[type=file]')));
  ok('R37 the buttons: Add selected (off with nothing ticked, the main one), Load file, Cancel', JSON.stringify(await mq.dialogButtonState(tab, 'Add selected')) === JSON.stringify({ disabled: true, primary: true })
    && (await mq.dialogButtonState(tab, 'Load file')).primary === false && !!(await mq.dialogButtonState(tab, 'Cancel')));
  await dlgClick(tab, 'TU1 ·');
  ok('R37 ticking one: "Add selected (1)", on', JSON.stringify(await mq.dialogButtonState(tab, 'Add selected (1)')) === JSON.stringify({ disabled: false, primary: true }));
  await mq.dialogButton(tab, 'Add selected (1)');
  await mq.noDialog(tab);
  ok('R38 "Here" on a fresh question: TU1 is read now, in place of question 1', (await mq.tossup(tab)).includes('Tiebreaker one asks about a treaty.'), await mq.tossup(tab));
  const tb = await tbOf(tab, G6.secret, G6.id);
  ok('R38 the game records the added question\'s place and pool id', !!tb && tb.tuAt && tb.tuAt['0'] === 'TU1' && tb.t === 22, tb);
  await mq.action(tab, 'Actions', 'Add questions...');
  await mq.waitDialog(tab, 'Add Questions');
  const again = (await dlgChecks(tab))[0];
  ok('R37 a question already in this game: "(already in this game)", off', again.label === 'TU1 · Tossup — Treaty of Ghent (already in this game)' && again.disabled, again);
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
});

await section('R38', 'where added questions go: Here or at the end', async () => {
  const { a, b } = G6.teams;
  await mq.buzz(tab, 1, pl(a, 1), 'correct');
  ok('R38 the added tossup is played like any other, with the packet\'s bonus 1', (await mq.view(tab)).includes('R3B1 leadin') && (await mq.score(tab)) === `${a}: 10, ${b}: 0`, await mq.score(tab));
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
  ok('R38 the packet goes on after it: question 2 reads the packet\'s tossup 1', (await mq.tossup(tab)).includes('R3T1 '), await mq.tossup(tab));
  await mq.buzz(tab, 5, pl(b, 1), 'wrong');
  await mq.action(tab, 'Actions', 'Add questions...');
  await mq.waitDialog(tab, 'Add Questions');
  await dlgClick(tab, 'TU2 ·');
  let radios = await dlgRadios(tab);
  let d = await mq.dialog(tab);
  ok('R38 the current question has buzzes: Here is off, "The current question already has buzzes or results, so new questions can only go at the end of the packet."',
    radios[0].disabled && radios[1].checked && d.includes('The current question already has buzzes or results, so new questions can only go at the end of the packet.'), radios);
  await mq.dialogButton(tab, 'Add selected (1)');
  await mq.noDialog(tab);
  let tb = await tbOf(tab, G6.secret, G6.id);
  ok('R38 "At the end of the packet": appended after the packet', !!tb && tb.tuAt['23'] === 'TU2' && (await mq.tossup(tab)).includes('R3T1 '), tb);
  // a bonus may go in where a bonus was thrown out
  await mq.goTo(tab, 2);
  await mq.buzz(tab, LATE_WORD, pl(a, 2), 'correct');
  ok('R38 question 2 answered: its bonus is the packet\'s bonus 2', (await mq.view(tab)).includes('R3B2 leadin'));
  await mq.action(tab, 'Actions', 'Throw out bonus');
  await mq.waitDialog(tab, 'Throw out Bonus');
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  await mq.action(tab, 'Actions', 'Add questions...');
  await mq.waitDialog(tab, 'Add Questions');
  await dlgClick(tab, 'B1 ·');
  radios = await dlgRadios(tab);
  ok('R38 a bonus after a thrown-out bonus may go Here', !radios[0].disabled && radios[0].checked, radios);
  await mq.dialogButton(tab, 'Add selected (1)');
  await mq.noDialog(tab);
  ok('R38 and it is read now', (await mq.view(tab)).includes('Tiebreaker bonus one leadin.'));
  tb = await tbOf(tab, G6.secret, G6.id);
  ok('R38 the game records the bonus\'s place too', !!tb && Object.values(tb.boAt || {}).includes('B1'), tb);
});

await section('R39', 'Replace tossup / Replace bonus', async () => {
  const { a, b } = G6.teams;
  await tab.click('#modaq input[aria-label="Part 1: Missed"]');
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 3, 'question 3', 5000);
  await mq.action(tab, 'Actions', 'Replace bonus...');
  let d = await mq.waitDialog(tab, 'Replace Bonus');
  ok('R39 Replace bonus before a correct answer: "There is no bonus on this question. A bonus can be replaced once a team has answered the tossup correctly."',
    d.includes('There is no bonus on this question. A bonus can be replaced once a team has answered the tossup correctly.') && !(await mq.dialogButtonState(tab, 'Replace bonus')), d);
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
  const tu = await mq.tossup(tab);
  const n = Number(tu.split('.')[0]);
  await mq.action(tab, 'Actions', 'Replace tossup...');
  d = await mq.waitDialog(tab, 'Replace Tossup');
  ok('R39 "Tossup N on question 3 will be thrown out, …" and how to undo it',
    d.includes(`Tossup ${n} on question 3 will be thrown out, and the tossup you pick will be read in its place. To undo it, click the X next to its event in the Event Log.`), d.slice(0, 300));
  ok('R39 "From the tournament director. Please check with the TD which one to read."', d.includes('From the tournament director. Please check with the TD which one to read.'));
  let radios = await dlgRadios(tab);
  ok('R39 the pool\'s tossups, those already in this game off', JSON.stringify(radios) === JSON.stringify([
    { label: 'TU1 — Treaty of Ghent (already in this game)', disabled: true, checked: false },
    { label: 'TU2 — Peace of Utrecht (already in this game)', disabled: true, checked: false },
    { label: 'TU3 — Congress of Vienna', disabled: false, checked: false }]), radios);
  ok('R39 "Or pick from a packet file:"; Replace tossup off until a pick', d.includes('Or pick from a packet file:')
    && (await mq.dialogButtonState(tab, 'Replace tossup')).disabled === true);
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`document.querySelectorAll('.ms-Dialog-main input[type=radio]').length === 5`, 'the file\'s tossups as options');
  radios = await dlgRadios(tab);
  ok('R39 a loaded file\'s tossups: "n. question… — answer"', radios[3].label === '1. File tossup one is about a river delta. — Nile'
    && radios[4].label === '2. File tossup two is about a mountain range. — Andes', radios.slice(3));
  ok('R39 the loader now reads "Or load a different packet file:"', (await mq.dialog(tab)).includes('Or load a different packet file:'));
  await dlgClick(tab, 'TU3 —', 'radio');
  ok('R39 a pick turns Replace tossup on', (await mq.dialogButtonState(tab, 'Replace tossup')).disabled === false);
  await mq.dialogButton(tab, 'Replace tossup');
  await mq.noDialog(tab);
  ok('R39 the pick is read in place of question 3', (await mq.tossup(tab)).includes('Tiebreaker three asks about a congress.') && (await mq.at(tab)) === 3, await mq.tossup(tab));
  ok('R39 the Event Log: "Replaced tossup #N"', (await mq.events(tab)).includes(`Replaced tossup #${n}`), (await mq.events(tab)).slice(0, 300));
  // the bonus, once the replacement is answered
  await mq.buzz(tab, 1, pl(b, 1), 'correct');
  const bonusN = Number(((await mq.view(tab)).match(/\n(\d+)\. R3B\d+ leadin/) || [])[1]);
  await mq.action(tab, 'Actions', 'Replace bonus...');
  d = await mq.waitDialog(tab, 'Replace Bonus');
  ok('R39 "Bonus N on question 3 will be thrown out, …"', d.includes(`Bonus ${bonusN} on question 3 will be thrown out, and the bonus you pick will be read in its place.`), d.slice(0, 300));
  radios = await dlgRadios(tab);
  ok('R39 the pool\'s bonuses: "B1 — answers (already in this game)" off, B2 on', radios[0].label === 'B1 — tbx / tby / tbz (already in this game)' && radios[0].disabled
    && radios[1].label === 'B2 — tbu / tbv / tbw' && !radios[1].disabled, radios);
  await dlgClick(tab, 'B2 —', 'radio');
  await mq.dialogButton(tab, 'Replace bonus');
  await mq.noDialog(tab);
  ok('R39 Replace bonus: the pick is read', (await mq.view(tab)).includes('Tiebreaker bonus two leadin.') && (await mq.events(tab)).includes(`Replaced bonus #${bonusN}`),
    (await mq.events(tab)).slice(0, 400));
  await tab.click('#modaq input[aria-label="Part 2: Missed"]');
});

await section('R40', 'replacing an earlier question', async () => {
  const { a, b } = G6.teams;
  await mq.next(tab); // question 4: nobody answers
  await until(async () => (await mq.at(tab)) === 4, 'question 4', 5000);
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 5, 'question 5', 5000);
  await mq.buzz(tab, LATE_WORD, pl(a, 3), 'correct');
  await mq.goTo(tab, 4);
  // R38: a question with no results of its own, but later ones with results
  await mq.action(tab, 'Actions', 'Add questions...');
  await mq.waitDialog(tab, 'Add Questions');
  // the pool is all in this game by now: questions from a packet file
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`document.querySelector('.ms-Dialog-main').innerText.includes('2 tossup')`, 'the file loaded');
  const radios = await dlgRadios(tab);
  ok('R38 later questions have results: Here is off, "Later questions in this game already have results, so new questions can only go at the end of the packet."',
    radios[0].disabled && (await mq.dialog(tab)).includes('Later questions in this game already have results, so new questions can only go at the end of the packet.'), radios);
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
  await mq.action(tab, 'Actions', 'Replace tossup...');
  const d = await mq.waitDialog(tab, 'Replace Tossup');
  ok('R40 later questions keep their results: "Please enter the replacement\'s result on question 4."',
    d.includes('Later questions already have results, and they keep them. Please enter the replacement\'s result on question 4.'), d.slice(0, 600));
  ok('R40 a dead tossup: "Tossup went dead. It may make more sense to throw it out … Are you sure you want to replace?"',
    d.includes('Tossup went dead. It may make more sense to throw it out or leave the question as is and add a new question at the end of the game instead. Are you sure you want to replace?'));
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`[...document.querySelectorAll('.ms-Dialog-main input[type=radio]')].length >= 4`, 'the file options');
  await dlgClick(tab, '2. File tossup two', 'radio');
  await mq.dialogButton(tab, 'Replace tossup');
  await mq.noDialog(tab);
  ok('R40 the replacement is read on question 4', (await mq.tossup(tab)).includes('File tossup two is about a mountain range.') && (await mq.at(tab)) === 4, await mq.tossup(tab));
  await mq.buzz(tab, 1, pl(b, 2), 'correct');
  ok('R40 answered: a blank bonus, "Bonus for the replacement tossup. Please read the bonus the TD gives, and enter its parts here."',
    (await mq.view(tab)).includes('Bonus for the replacement tossup. Please read the bonus the TD gives, and enter its parts here.'), (await mq.view(tab)).slice(0, 200));
  // an answered earlier question: its bonus is held for the replacement
  await mq.goTo(tab, 6);
  await mq.buzz(tab, LATE_WORD, pl(a, 1), 'correct');
  await mq.goTo(tab, 5);
  const own = Number(((await mq.view(tab)).match(/\n(\d+)\. R3B\d+ leadin/) || [])[1]);
  await mq.action(tab, 'Actions', 'Replace tossup...');
  const d2 = await mq.waitDialog(tab, 'Replace Tossup');
  ok('R40 an answered question: "If it is answered, bonus M is read again."', d2.includes(`If it is answered, bonus ${own} is read again.`), d2.slice(0, 400));
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`[...document.querySelectorAll('.ms-Dialog-main input[type=radio]')].length >= 4`, 'the file options');
  await dlgClick(tab, '1. File tossup one', 'radio');
  await mq.dialogButton(tab, 'Replace tossup');
  await mq.noDialog(tab);
  ok('R40 the bonus waits for the replacement: "Bonus #M held for the replacement tossup"', (await mq.events(tab)).includes(`Bonus #${own} held for the replacement tossup`),
    (await mq.events(tab)).slice(0, 600));
});

await section('R41', 'undoing a replacement from the Event Log', async () => {
  const ev = await mq.events(tab);
  const reps = [...ev.matchAll(/Replaced tossup #(\d+)/g)].map((m) => Number(m[1]));
  const withX = [];
  for (const n of reps) if (await hasEventX(tab, `Replaced tossup #${n}`)) withX.push(n);
  ok('R41 the replacements read "Replaced tossup #N"; only the latest has an X, earlier ones none', reps.length === 3 && withX.length === 1
    && withX[0] === reps[reps.length - 1], { reps, withX });
  const at = await mq.at(tab);
  const before = await mq.tossup(tab);
  await deleteEvent(tab, `Replaced tossup #${withX[0]}`);
  const sure = await mq.waitDialog(tab, 'Delete Event', 5000);
  ok('R41 MODAQ asks first: "Are you sure you want to delete the event …"', sure.includes(`Are you sure you want to delete the event "Replaced tossup #${withX[0]}"`), sure);
  await mq.dialogButton(tab, 'OK');
  await mq.noDialog(tab);
  await mq.goTo(tab, at);
  ok('R41 undone: the question is as it was (its packet tossup and its answer), the inserted question gone', !(await mq.events(tab)).includes(`Replaced tossup #${withX[0]}`)
    && (await mq.tossup(tab)) !== before && /R3T\d+ /.test(await mq.tossup(tab)) && !(await mq.events(tab)).includes('held for the replacement'),
  [before, await mq.tossup(tab)]);
  // a replacement followed by added questions can no longer be undone
  await mq.goTo(tab, 6);
  await mq.action(tab, 'Actions', 'Replace tossup...');
  await mq.waitDialog(tab, 'Replace Tossup');
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`[...document.querySelectorAll('.ms-Dialog-main input[type=radio]')].length >= 4`, 'the file options');
  await dlgClick(tab, '2. File tossup two', 'radio');
  await mq.dialogButton(tab, 'Replace tossup');
  await mq.noDialog(tab);
  const latest = Number(((await mq.events(tab)).match(/Replaced tossup #(\d+)(?![\s\S]*Replaced tossup #)/) || [])[1]);
  ok('R41 the new replacement is the latest: it has the X', await hasEventX(tab, `Replaced tossup #${latest}`));
  await mq.action(tab, 'Actions', 'Add questions...');
  await mq.waitDialog(tab, 'Add Questions');
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`document.querySelector('.ms-Dialog-main').innerText.includes('2 tossup')`, 'the file loaded');
  await dlgClick(tab, 'At the end of the packet', 'radio');
  await mq.dialogButton(tab, 'Load file');
  await mq.noDialog(tab);
  // the replacement can no longer be undone: read_core undoReplace would say so in an "Undo Replacement"
  // dialog, but adding questions drops the undo record (tbRecordAdd), so its X is simply gone
  let got = 'no X, no message';
  if (await hasEventX(tab, `Replaced tossup #${latest}`)) {
    await deleteEvent(tab, `Replaced tossup #${latest}`);
    await mq.waitDialog(tab, 'Delete Event', 5000);
    await mq.dialogButton(tab, 'OK');
    const why = await mq.waitDialog(tab, 'Undo Replacement', 5000).catch(() => '');
    got = why.includes('Questions were added to this game after the replacement, so it can no longer be undone.') ? 'the message' : why || 'X, no message';
    if (why) { await mq.dialogButton(tab, 'OK'); await mq.noDialog(tab); }
  }
  known('R41 a replacement followed by Add questions: the X goes without a word (expected: "Questions were added to this game after the replacement, so it can no longer be undone.")',
    got, 'no X, no message', 'the message');
  ok('R41 and the replacement stays', (await mq.events(tab)).includes(`Replaced tossup #${latest}`));
});

await section('R48', 'the upload numbers added questions; the tiebreakers read are logged', async () => {
  const { a, b } = G6.teams;
  await sleep(400); // MODAQ's save
  const u = await upload(tab);
  const body = u.body || {};
  const mqs = (body.qbj && body.qbj.match_questions) || [];
  ok('R38 the upload numbers the added tossup after the packet and tags it qbtd_tiebreaker' + changed('editNumbers'),
    mqs[0] && mqs[0].tossup_question.question_number === 23 && mqs[0].tossup_question.qbtd_tiebreaker === 'TU1', mqs[0] && mqs[0].tossup_question);
  ok('R38 packet questions keep the TD\'s packet numbers (question 2 is the packet\'s tossup 1)', mqs[1] && mqs[1].tossup_question.question_number === 1, mqs[1] && mqs[1].tossup_question);
  ok('R38 the upload carries the record (tb.map) for Edit in MODAQ' + changed('editNumbers'), body.tb && body.tb.map && body.tb.map.tuAt && body.tb.map.tuAt['0'] === 'TU1', body.tb);
  const used = (body.tb && body.tb.used) || [];
  ok('R48 tb.used names the pool questions this game read', ['TU1', 'TU3', 'B1', 'B2'].every((x) => used.includes(x)) && !used.includes('TU2'), used);
  const pool = (await call(M.A + '/tiebreakers')).body;
  const mine = (pool.uses || []).filter((x) => x.round === 3 && x.room === 'Room 6' && JSON.stringify(x.teams) === JSON.stringify([a, b]));
  ok('R48 the Worker logs each, with the round, room and teams', JSON.stringify(mine.map((x) => x.q).sort()) === JSON.stringify([...used].sort()), pool.uses);
  // another room sees them heard
  await openRoom(tab, room('Room 3'));
  await tab.waitJs(`!document.querySelector('#tbpanel').hidden`, 'the tiebreakers panel');
  const rows = await tab.js(`[...document.querySelectorAll('#tbrows tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()))`);
  ok('R25 R48 the panel: "heard A & B (R3, Room 6)" for the ones read, "unused" for the rest', JSON.stringify(rows) === JSON.stringify([
    ['TU1', 'Tossup', `heard ${a} & ${b} (R3, Room 6)`], ['TU2', 'Tossup', 'unused'], ['TU3', 'Tossup', `heard ${a} & ${b} (R3, Room 6)`],
    ['B1', 'Bonus', `heard ${a} & ${b} (R3, Room 6)`], ['B2', 'Bonus', `heard ${a} & ${b} (R3, Room 6)`]]), rows);
  ok('R25 "heard" in red', await red(tab, '#tbrows .bad'));
  await tab.goto(G2.link);
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'Room 2\'s game');
  await mq.action(tab, 'Actions', 'Add questions...');
  const d = await mq.waitDialog(tab, 'Add Questions');
  ok('R37 R48 in another game\'s Add questions: "Heard by A & B (Round 3, Room 6)"', d.includes(`Heard by ${a} & ${b} (Round 3, Room 6)`), d.slice(0, 600));
  ok('R37 in red', await tab.js(`[...document.querySelectorAll('.ms-Dialog-main div')].some((e) => e.textContent.startsWith('Heard by') && getComputedStyle(e).color === 'rgb(164, 38, 44)')`));
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
  // the same game exported again: its log entries are replaced, not doubled
  await tab.goto(`${readUrl(G6.secret)}&g=${G6.id}`);
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'Room 6\'s game');
  await upload(tab);
  const pool2 = (await call(M.A + '/tiebreakers')).body;
  const mine2 = (pool2.uses || []).filter((x) => x.round === 3 && JSON.stringify([...x.teams].sort()) === JSON.stringify([a, b].sort()));
  ok('R47 R48 a re-export replaces the game\'s log entries rather than doubling them', mine2.length === mine.length, mine2);
});

/* ---------------------------------------------------------------------- */
/* the TD's game format, overtime, a long team name (Annex)               */
/* ---------------------------------------------------------------------- */

const ANNEX = M.rooms['Annex'].secret;
async function annexGame(a, b) {
  await openRoom(tab, ANNEX);
  await tab.pick('#teama', a);
  await tab.pick('#teamb', b);
  return startGame(tab); // a later game in round 3 is confirmed (OK)
}

await section('R28', 'the TD\'s game format in MODAQ', async () => {
  const base = { byeRoom: M.rooms['Bye Room'].id };
  const cases = [
    { name: 'ACF', settings: { gameFormat: 'acf' }, fmt: 'ACF', lines: ['Tossups in regulation: 20', 'Neg value: -5', 'Has powers: No', 'Bonuses bounce back: No'], power: 10, neg: -5 },
    { name: 'PACE NSC', settings: { gameFormat: 'pace' }, fmt: 'PACE', lines: ['Tossups in regulation: 20', 'Neg value: 0', 'Has powers: Yes'], power: 20, neg: 0 },
    { name: 'saved overrides', settings: { gameFormat: 'acf', formatOverrides: { regulationTossupCount: 18, negValue: -10, powers: [{ marker: '(*)', points: 20 }],
      bonusesBounceBack: true, pairTossupsBonuses: true } }, fmt: 'ACF (custom)', lines: ['Tossups in regulation: 18', 'Neg value: -10', 'Has powers: Yes', 'Bonuses bounce back: Yes'],
    power: 20, neg: -10 },
  ];
  try {
    for (const c of cases) {
      await M.setSettings({ ...base, ...c.settings });
      await annexGame('Alpha', 'Beta');
      await mq.action(tab, 'Options', 'Change Format...');
      const fmt = await mq.waitDialog(tab, 'Customize Game Format');
      ok(`R28 ${c.name}: MODAQ starts with the format's rules (${c.lines.join(', ')})`, c.lines.every((l) => fmt.includes(l)), fmt.slice(0, 300));
      // the name in MODAQ's Format box: MODAQ picks it among its own four formats by name
      const shown = await until(() => tab.js(`((document.querySelector('.ms-Dialog-main .ms-Dropdown-title') || {}).textContent || '')`), 'the Format box', 3000).catch(() => '');
      if (c.settings.formatOverrides) known('R28 saved overrides: MODAQ\'s Format box reads "Freeform format", not "ACF (custom)" (MODAQ knows only its own four names)', shown, 'Freeform format', 'ACF (custom)');
      else ok(`R28 ${c.name}: MODAQ's Format box reads "${c.fmt}"`, shown === c.fmt, shown);
      await mq.dialogButton(tab, 'Cancel');
      await mq.noDialog(tab);
      await mq.buzz(tab, POWER_WORD, pl('Alpha', 1), 'correct');
      ok(`R28 ${c.name}: a buzz before the power mark scores ${c.power}`, (await mq.score(tab)) === `Alpha: ${c.power}, Beta: 0`, await mq.score(tab));
      await mq.next(tab);
      await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
      await mq.buzz(tab, 5, pl('Beta', 1), 'wrong');
      ok(`R28 ${c.name}: a neg scores ${c.neg}`, (await mq.score(tab)) === `Alpha: ${c.power}, Beta: ${c.neg}`, await mq.score(tab));
      if (c.settings.formatOverrides) {
        await mq.goTo(tab, 1);
        await mq.action(tab, 'Actions', 'Replace tossup...');
        const d = await mq.waitDialog(tab, 'Replace Tossup');
        ok('R40 a format with a bonus paired to each tossup: "This game format reads a bonus with each tossup, so only the latest question can be replaced."',
          d.includes('This game format reads a bonus with each tossup, so only the latest question can be replaced.') && !(await mq.dialogButtonState(tab, 'Replace tossup')), d);
        await mq.dialogButton(tab, 'Cancel');
        await mq.noDialog(tab);
      }
    }
  } finally { await M.setSettings(base); }
});

await section('R34c', 'overtime', async () => {
  await annexGame('Gamma', 'Delta');
  await mq.buzz(tab, POWER_WORD, pl('Gamma', 1), 'correct');
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
  await mq.buzz(tab, POWER_WORD, pl('Delta', 1), 'correct');
  await mq.goTo(tab, 20);
  const nextLabel = () => tab.js(`[...document.querySelectorAll('#modaq button')].map((b) => b.textContent).find((t) => /Next|Export/.test(t))`);
  ok('R34 tied after the last regulation question: Next goes on', (await mq.score(tab)) === 'Gamma: 15, Delta: 15' && (await nextLabel()) === 'Next →', [await mq.score(tab), await nextLabel()]);
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 21, 'question 21', 5000);
  ok('R34 overtime: question 21 reads tossup 21', (await mq.tossup(tab)).startsWith('21. R3T21 '), await mq.tossup(tab));
  await mq.buzz(tab, LATE_WORD, pl('Gamma', 2), 'correct');
  ok('R34 an overtime tossup has no bonus (mACF)', (await mq.score(tab)) === 'Gamma: 25, Delta: 15' && !(await tab.exists('#modaq input[aria-label="Part 1: Missed"]')), await mq.score(tab));
  ok('R34 decided: the next button exports', (await nextLabel()) === 'Export...', await nextLabel());
});

await section('R34d', 'overtime under saved overrides: with bonuses, at least two questions', async () => {
  const base = { byeRoom: M.rooms['Bye Room'].id };
  await M.setSettings({ ...base, gameFormat: 'macf-powers', formatOverrides: { regulationTossupCount: 4, overtimeIncludesBonuses: true, minimumOvertimeQuestionCount: 2 } });
  try {
    await annexGame('Epsilon', 'Zeta');
    await mq.action(tab, 'Options', 'Change Format...');
    const fmt = await mq.waitDialog(tab, 'Customize Game Format');
    const inputs = await tab.js(`[...document.querySelectorAll('.ms-Dialog-main input')].map((i) => i.value)`);
    ok('R28 the overrides reach MODAQ: 4 tossups in regulation, at least 2 in overtime', fmt.includes('Tossups in regulation: 4')
      && JSON.stringify(inputs.slice(0, 2)) === JSON.stringify(['4', '2']), { inputs, fmt: fmt.slice(0, 200) });
    await mq.dialogButton(tab, 'Cancel');
    await mq.noDialog(tab);
    const nextLabel = () => tab.js(`[...document.querySelectorAll('#modaq button')].map((b) => b.textContent).find((t) => /Next|Export/.test(t))`);
    await mq.buzz(tab, POWER_WORD, pl('Epsilon', 1), 'correct');
    await mq.next(tab);
    await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
    await mq.buzz(tab, POWER_WORD, pl('Zeta', 1), 'correct');
    await mq.goTo(tab, 5);
    await mq.buzz(tab, LATE_WORD, pl('Epsilon', 2), 'correct');
    ok('R28 overtime bonuses on: an overtime tossup answered brings its bonus', (await tab.exists('#modaq input[aria-label="Part 1: Missed"]'))
      && (await mq.score(tab)) === 'Epsilon: 25, Zeta: 15', await mq.score(tab));
    ok('R28 at least two overtime questions: the game goes on after the first', (await nextLabel()) === 'Next →', await nextLabel());
    await mq.next(tab);
    await until(async () => (await mq.at(tab)) === 6, 'question 6', 5000);
    ok('R28 after the second, it is decided: the next button exports', (await nextLabel()) === 'Export...', await nextLabel());
  } finally { await M.setSettings(base); }
});

await section('R42b', 'the upload\'s file name: ASCII, at most 40 characters a team', async () => {
  await annexGame(LONGTEAM, 'Alpha');
  await mq.buzz(tab, POWER_WORD, pl(LONGTEAM, 1), 'correct');
  await sleep(400);
  const u = await upload(tab);
  ok('R42 "Round_3_<A>_<B>.qbtd.json" with each name cleaned to letters, digits and _ and cut at 40',
    new URL(u.req.url).searchParams.get('name') === 'Round_3_Universit_de_Montr_al_A_quipe_Tr_s_Longu_Alpha.qbtd.json', u.req && u.req.url);
  ok('R42 the qbj keeps the team\'s own name', u.body.qbj.match_teams[0].team.name === LONGTEAM, u.body.qbj.match_teams[0].team);
});

await section('R46b', 'a game from before progress was kept sends none', async () => {
  // as if the game had been saved before the reader kept how far it got
  const key = `qbtdMeta:${G5.secret}:${G5.id}`;
  await tab.goto(`${readUrl(G5.secret)}&g=${G5.id}`);
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'Room 5\'s game');
  await tab.js(`(() => { const m = JSON.parse(localStorage.getItem(${q(key)})); delete m.reached; localStorage.setItem(${q(key)}, JSON.stringify(m)); return true; })()`);
  await tab.reload();
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'Room 5\'s game again');
  const u = await upload(tab);
  ok('R46 no progress in its upload', u.body && !('progress' in u.body), u.body && Object.keys(u.body));
  await openHub();
  const title = await hub.js(`(document.querySelector('[data-cell="${M.rooms['Room 5'].id}:3"]') || {}).title || ''`);
  ok('R46 and the hub counts it as finished ("Game in")', title.startsWith('Game in') && !title.includes('In progress'), title);
});

/* ---------------------------------------------------------------------- */
/* this device's games (Great Hall, formerly Lecture Hall)                */
/* ---------------------------------------------------------------------- */

const HALL = M.rooms['Lecture Hall'].secret;
const HALLG = gameAt(MS, 6, 3);
const hallIds = [];

await section('R29', 'a second game in the same round on this device', async () => {
  await openRoom(tab, HALL);
  hallIds.push(await startGame(tab));
  await openRoom(tab, HALL);
  const m = tab.mark();
  const d0 = tab.dialogs.length;
  tab.answers.push(false);
  await tab.click('#start');
  await until(() => tab.dialogs.length > d0, 'the question', 5000);
  ok('R29 Start asks "round 3 already has a game on this device (A vs B). start a new one?"',
    tab.dialogs[d0].type === 'confirm' && tab.dialogs[d0].message === `round 3 already has a game on this device (${HALLG.a} vs ${HALLG.b}). start a new one?`, tab.dialogs[d0]);
  await sleep(300);
  ok('R29 Cancel starts nothing', !(await tab.js(`document.body.classList.contains('reading')`)) && !tab.worker(m).some((x) => x.startsWith('POST')));
  for (let i = 0; i < 8; i++) {
    await openRoom(tab, HALL);
    hallIds.push(await startGame(tab));
  }
  ok('R29 OK starts a new game each time', new Set(hallIds).size === 9, hallIds);
  const keys = Object.keys(await tab.storage()).filter((k) => k.startsWith(`qbtdMeta:${HALL}:`));
  ok('R29 the device keeps the 8 newest games of the room', keys.length === 8 && !keys.includes(`qbtdMeta:${HALL}:${hallIds[0]}`), keys.length);
  await tab.goto(`${readUrl(HALL)}&g=${hallIds[0]}`);
  await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'the oldest game link');
  ok('R29 the oldest game\'s link: "game not on this device"', (await tab.text('#msg')) === 'game not on this device');
  for (const id of [hallIds[1], hallIds[8]]) {
    await tab.goto(`${readUrl(HALL)}&g=${id}`);
    await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar') || document.querySelector('#msg').textContent.length > 0`, 'a kept game');
    ok(`R29 a kept game opens (${id === hallIds[1] ? 'the oldest kept' : 'the newest'})`, await tab.exists('#modaq .ms-CommandBar'));
  }
  await tab.goto(G2.link);
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar') || document.querySelector('#msg').textContent.length > 0`, 'Room 2\'s game');
  ok('R29 other rooms\' games are never touched', await tab.exists('#modaq .ms-CommandBar'));
});

await section('R30', 'the room link lists this device\'s games', async () => {
  await openRoom(tab, HALL);
  let dg = await devGames(tab);
  ok('R30 "Round 3: A vs B on this device" with Continue to the newest game of the round', dg.length === 1
    && dg[0].text === `Round 3: ${HALLG.a} vs ${HALLG.b} on this device` && new URL(dg[0].href, PAGES).searchParams.get('g') === hallIds[8], dg);
  // a game whose saved MODAQ state is corrupt (a cleared or broken entry)
  await tab.js(`localStorage.setItem(${q(`qbtdGame:${HALL}:${hallIds[8]}`)}, '{not json'), true`);
  await openRoom(tab, HALL);
  dg = await devGames(tab);
  ok('R30 a game with a corrupt saved state is not listed (Continue goes to the next newest)', dg.length === 1 && new URL(dg[0].href, PAGES).searchParams.get('g') === hallIds[7], dg);
  await tab.goto(`${readUrl(HALL)}&g=${hallIds[8]}`);
  await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'the corrupt game link');
  ok('R32 R30 its link: "game not on this device"', (await tab.text('#msg')) === 'game not on this device');
});

await section('R32', 'a game link that is not on this device', async () => {
  await tab.goto(`${readUrl(room('Room 3'))}&g=zzzzzz9999`);
  await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'the message');
  ok('R32 "game not on this device", in red', (await tab.text('#msg')) === 'game not on this device' && (await red(tab, '#msg')));
  ok('R32 "This game link belongs to another device or its saved state was cleared."', (await tab.shown('#notfound'))
    && (await tab.text('#notfound')).replace(/\s+/g, ' ').includes('This game link belongs to another device or its saved state was cleared.'));
  const href = new URL(await tab.js(`document.querySelector('#roomlink').href`));
  ok('R32 "Start a new game" links to the room link, keeping &server=', (await tab.text('#roomlink')) === 'Start a new game'
    && href.searchParams.get('b') === room('Room 3') && href.searchParams.get('server') === BASE && !href.searchParams.has('g'), href.href);
  await tab.goto(`${PAGES}/read.html?b=${room('Room 3')}&test=${TEST}&g=zzzzzz9999&server=${enc(BASE)}&live=off`);
  await tab.waitJs(`document.querySelector('#msg').textContent.length > 0`, 'the message (test)');
  const th = new URL(await tab.js(`document.querySelector('#roomlink').href`));
  ok('R32 from a Test link it keeps &test= too', th.searchParams.get('test') === TEST && th.searchParams.get('server') === BASE, th.href);
});

/* ---------------------------------------------------------------------- */
/* a tournament with no schedule, no pool, and roster trouble (Aux)       */
/* ---------------------------------------------------------------------- */

const X = await tournament('Reader Aux');
for (const n of ['Aux 1', 'Aux 2']) await X.room(n);
for (const r of [1, 2]) await X.packet(r, `A${r}.json`, packetOf(r));
await X.start();
await X.round(3);
const AUX1 = X.rooms['Aux 1'].secret;
const AUX2 = X.rooms['Aux 2'].secret;
let auxGame = null;

await section('R13', 'roster problems', async () => {
  await openRoom(tab, AUX1, '', 'msg');
  ok('R13 no roster: "no roster", in red', (await tab.text('#msg')) === 'no roster' && (await red(tab, '#msg')), await tab.text('#msg'));
  ok('R13 the round buttons still show, but no team row or Start', (await roundButtons(tab)).length === 2 && !(await tab.shown('#teamrow')) && !(await tab.shown('#start')));
  ok('R10 the live round with no packet: the latest round with one is selected', JSON.stringify((await roundButtons(tab)).map((b) => [b.n, b.sel, b.live])) === JSON.stringify([['1', false, false], ['2', true, false]])
    && (await tab.text('#packetname')) === 'Packet: A2.json', await roundButtons(tab));
  await X.roster(rosterOf(TEAMS));
  // a game on this device, then the roster breaks
  await openRoom(tab, AUX1);
  await tab.click('.rnd[data-round="1"]');
  await tab.pick('#teama', 'Alpha');
  await tab.pick('#teamb', 'Beta');
  auxGame = await startGame(tab);
  await X.roster(JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'X', registrations: [{ name: 'Alpha' }] }] }));
  await openRoom(tab, AUX1, '', 'msg');
  ok('R13 a roster MODAQ cannot read: "roster: <MODAQ\'s message>", in red', (await tab.text('#msg')) === 'roster: Registration is missing a teams field.' && (await red(tab, '#msg')),
    await tab.text('#msg'));
  ok('R13 the round buttons and this device\'s games still show; no team row', (await roundButtons(tab)).length === 2 && (await devGames(tab)).length === 1
    && !(await tab.shown('#teamrow')), await devGames(tab));
  await X.roster(JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'X', registrations: [] }] }));
  await openRoom(tab, AUX1, '', 'msg');
  ok('R13 a roster with no registrations: MODAQ\'s own message, "roster: Registration has no players"', (await tab.text('#msg')) === 'roster: Registration has no players'
    && !(await tab.shown('#teamrow')), await tab.text('#msg'));
  // MODAQ reads players with an empty name; the reader keeps none of them
  await X.roster(JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'X', registrations: [{ name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: '' }] }] }] }] }));
  await openRoom(tab, AUX1, '', 'msg');
  ok('R13 a roster with no team the reader can use: "no teams in roster"', (await tab.text('#msg')) === 'no teams in roster' && (await red(tab, '#msg')) && !(await tab.shown('#teamrow')), await tab.text('#msg'));
  await X.roster(rosterOf(TEAMS));
});

await section('R19b', 'no schedule, no tiebreaker pool', async () => {
  const m = tab.mark();
  await openRoom(tab, AUX2);
  await sleep(300);
  ok('R19 no schedule (its 404 is quiet): two empty dropdowns, every team, no "From the schedule", no schedule panel', (await tab.text('#msg')) === ''
    && (await tab.js(`document.querySelector('#teama').value === '' && document.querySelector('#teamb').value === '' && document.querySelector('#teama').options.length === 7`))
    && !(await tab.shown('#schedmatch')) && !(await tab.shown('#schedpanel')));
  ok('R25 no pool (404): no Tiebreakers panel', !(await tab.shown('#tbpanel')));
  const load = await call(`/b/${AUX2}/load`);
  ok('R19 R25 Worker: /schedule 404 "no schedule", /tiebreakers 404 "no tiebreakers"', load.body['/schedule'].s === 404 && load.body['/tiebreakers'].s === 404,
    [load.body['/schedule'], load.body['/tiebreakers']]);
  ok('R19 nothing fetched again on its own' + changed('oneRequest'), JSON.stringify(tab.worker(m)) === JSON.stringify(['GET /b/:s/load', 'GET /b/:s/packet?round=2&warm=1']), tab.worker(m));
});

await section('R37b', 'Add questions and Replace with no pool', async () => {
  await tab.goto(`${readUrl(AUX1)}&g=${auxGame}`);
  await tab.waitJs(`!!document.querySelector('#modaq .ms-CommandBar')`, 'the Aux game');
  await mq.action(tab, 'Actions', 'Add questions...');
  const d = await mq.waitDialog(tab, 'Add Questions');
  ok('R37 no pool: "No tiebreaker pool from the tournament director — load a packet file instead."', d.includes('No tiebreaker pool from the tournament director — load a packet file instead.')
    && d.includes('Where should they go?') && (await tab.exists('.ms-Dialog-main input[type=file]')), d);
  ok('R37 no pool: Load file is the main button, and there is no Add selected', (await mq.dialogButtonState(tab, 'Load file')).primary === true && !(await mq.dialogButtonState(tab, 'Add selected')));
  await setFiles(tab, '.ms-Dialog-main input[type=file]', [fileFx()]);
  await tab.waitJs(`document.querySelector('.ms-Dialog-main').innerText.includes('2 tossup')`, 'the file loaded');
  await dlgClick(tab, 'Here', 'radio');
  await mq.dialogButton(tab, 'Load file');
  await mq.noDialog(tab);
  ok('R38 a file\'s questions added Here: read now', (await mq.tossup(tab)).includes('File tossup one is about a river delta.'), await mq.tossup(tab));
  const tb = await tbOf(tab, AUX1, auxGame);
  ok('R38 recorded with no pool id (\'\')', !!tb && tb.tuAt && tb.tuAt['0'] === '' && tb.tuAt['1'] === '', tb);
  await mq.next(tab);
  await until(async () => (await mq.at(tab)) === 2, 'question 2', 5000);
  await mq.action(tab, 'Actions', 'Replace tossup...');
  const r = await mq.waitDialog(tab, 'Replace Tossup');
  ok('R39 no pool: "There are no tossups from the tournament director. Please load a packet file and pick one from it."',
    r.includes('There are no tossups from the tournament director. Please load a packet file and pick one from it.'), r);
  await mq.dialogButton(tab, 'Cancel');
  await mq.noDialog(tab);
});

await section('R30b', 'a game whose round lost its packet', async () => {
  const mv = await call(`${X.A}/packets/move`, { method: 'POST', json: { from: 1, to: 9 } });
  try {
    await openRoom(tab, AUX1);
    const b = await roundButtons(tab);
    ok('R10 R30 its round keeps a grey button, "No packet for round 1", not a link', mv.status === 200 && b[0].n === '1' && b[0].tag === 'SPAN' && b[0].off
      && b[0].title === 'No packet for round 1', b);
    await tab.click('#roundrows .rnd.off');
    ok('R10 clicking it selects nothing', !(await roundButtons(tab))[0].sel && (await roundButtons(tab))[1].sel);
    const dg = await devGames(tab);
    ok('R30 and its game is still listed with Continue', dg.length === 1 && dg[0].text === 'Round 1: Alpha vs Beta on this device'
      && new URL(dg[0].href, PAGES).searchParams.get('g') === auxGame, dg);
  } finally { await call(`${X.A}/packets/move`, { method: 'POST', json: { from: 9, to: 1 } }); }
});

/* ---------------------------------------------------------------------- */
/* no packets yet; packets the reader cannot read                         */
/* ---------------------------------------------------------------------- */

await section('R12', 'no packets yet', async () => {
  const E = await tournament('Reader Empty');
  const e1 = await E.room('Empty 1');
  await E.roster(rosterOf(TEAMS));
  await E.start();
  const m = tab.mark();
  await openRoom(tab, e1.secret, '', 'msg');
  await sleep(300);
  ok('R12 "no packets yet", in red', (await tab.text('#msg')) === 'no packets yet' && (await red(tab, '#msg')), await tab.text('#msg'));
  ok('R12 an empty round list, no team row', (await roundButtons(tab)).length === 0 && (await tab.shown('#picker')) && !(await tab.shown('#teamrow')));
  ok('R12 no roster or packet fetched' + changed('oneRequest'), JSON.stringify(tab.worker(m)) === JSON.stringify(['GET /b/:s/load']), tab.worker(m));
});

await section('R27', 'packets the reader cannot read', async () => {
  const K = await tournament('Reader Packets');
  const k1 = await K.room('Pk 1');
  await K.roster(rosterOf(TEAMS));
  const good = JSON.parse(packetOf(1));
  const cases = [
    [1, 'P1.json', JSON.stringify({ bonuses: [] }), 'application/json', 'packet JSON has no tossups array'],
    [2, 'P2.json', JSON.stringify({ tossups: [] }), 'application/json', 'packet has no tossups'],
    [3, 'P3.json', JSON.stringify({ tossups: [{ question: 'Only a question.' }] }), 'application/json', 'tossup 1 is missing question or answer text'],
    [4, 'P4.json', JSON.stringify({ tossups: good.tossups, bonuses: {} }), 'application/json', 'packet bonuses is not an array'],
    [5, 'P5.pdf', 'PDFBYTES', 'application/pdf', 'packet is pdf; the reader needs .json or .docx'],
  ];
  for (const [n, name, body, type] of cases) await K.packet(n, name, body, type);
  await K.packet(6, 'P6.json', JSON.stringify({ tossups: good.tossups, bonuses: good.bonuses.map(({ values, ...b }) => b) }));
  await K.start();
  await K.round(6);
  for (const [n, , , , msg] of cases) {
    await openRoom(tab, k1.secret);
    await tab.click(`.rnd[data-round="${n}"]`);
    await tab.pick('#teama', 'Alpha');
    await tab.pick('#teamb', 'Beta');
    await tab.click('#start');
    await tab.waitJs(`document.querySelector('#msg').textContent.length > 0 || document.body.classList.contains('reading')`, 'round ' + n);
    ok(`R27 round ${n}: "${msg}", in red; Start on again`, (await tab.text('#msg')) === msg && (await red(tab, '#msg')) && !(await tab.js(`document.querySelector('#start').disabled`))
      && !(await tab.js(`document.body.classList.contains('reading')`)), await tab.text('#msg'));
  }
  // a bonus with no point values: the reader lets it through (a set's parse review warns of it; a TD's own upload is not checked)
  const errs = tab.errors.length;
  await openRoom(tab, k1.secret);
  await tab.pick('#teama', 'Alpha');
  await tab.pick('#teamb', 'Beta');
  await tab.click('#start');
  await tab.waitJs(`document.body.classList.contains('reading') || document.querySelector('#msg').textContent.length > 0`, 'Start on round 6');
  const opened = await until(() => tab.exists('#modaq .ms-CommandBar'), 'MODAQ', 5000).catch(() => false);
  const crash = tab.errors.slice(errs).find((e) => /loadPacket/.test(e)) || '';
  known('R27 a bonus with no point values: MODAQ throws in loadPacket and the game area stays blank, with no message (expected: a message like the other packet errors)',
    !opened && crash ? 'blank' : opened ? 'MODAQ opens' : 'blank, other error', 'blank', 'a message');
  ok('R27 (that game is already stored and its start sent: the address is the game link)', (await tab.js('location.search')).includes('&g='));
});

/* ---------------------------------------------------------------------- */
/* upload errors, then the tournament closes                              */
/* ---------------------------------------------------------------------- */

const exportFailed = (text) => (String(text).split('\n').find((l) => l.startsWith('Export failed:')) || text).trim();

await section('R45', 'upload errors', async () => {
  const C = await tournament('Reader Closes');
  const c1 = await C.room('Close 1');
  await C.roster(rosterOf(TEAMS));
  await C.packet(1, 'C1.json', packetOf(1));
  await C.start();
  await openRoom(tab, c1.secret);
  await tab.pick('#teama', 'Alpha');
  await tab.pick('#teamb', 'Beta');
  await startGame(tab);
  await mq.buzz(tab, POWER_WORD, pl('Alpha', 1), 'correct');
  await sleep(400);
  const fail = async () => exportFailed((await upload(tab, { expect: 'Export Error' })).text);
  // the room's upload cap
  d1(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 600) INSERT INTO files (tournament_id, bucket_id, round, kind, r2_key, filename, size, error, created) SELECT ${C.id}, ${c1.id}, 1, 'other', 'cap/' || x, 'cap' || x || '.txt', 1, NULL, 0 FROM c`);
  try {
    const t = await fail();
    ok('R45 the room\'s upload cap reached: MODAQ\'s "Export Error", "Export failed: upload cap reached."', t === 'Export failed: upload cap reached.', t);
  } finally { d1(`DELETE FROM files WHERE bucket_id = ${c1.id} AND r2_key LIKE 'cap/%'`); }
  // bodies the Worker refuses, swapped in on the way
  const swapped = async (body) => {
    await tab.intercept([{ urlPattern: '*/upload*', requestStage: 'Request' }], (p) => {
      tab.S('Fetch.continueRequest', { requestId: p.requestId, postData: Buffer.from(body).toString('base64') }).catch(() => {});
    });
    try { return await fail(); } finally { await tab.unintercept(); }
  };
  let t = await swapped(Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  ok('R45 a file over 8 MB: "Export failed: file too large."', t === 'Export failed: file too large.', t);
  t = await swapped('{"qbj":{}}');
  ok('R45 a stored file the Worker could not read: "Export failed: <filename>: <error>."', t === 'Export failed: Round_1_Alpha_Beta.qbtd.json: no match with exactly two match_teams.', t);
  // a body of no bytes (the reader never sends one; the page shows the Worker's refusal as it would any other)
  await tab.intercept([{ urlPattern: '*/upload*', requestStage: 'Request' }], (p) => {
    tab.S('Fetch.continueRequest', { requestId: p.requestId, postData: '' }).catch(() => {});
  });
  let empty;
  try { empty = exportFailed((await upload(tab, { expect: 'Export' })).text); } finally { await tab.unintercept(); }
  // a server failure: the room's key won't unwrap
  const wrap = d1(`SELECT wrap FROM buckets WHERE id = ${c1.id}`)[0].wrap;
  d1(`UPDATE buckets SET wrap = '${'A'.repeat(wrap.length)}' WHERE id = ${c1.id}`);
  try {
    t = await fail();
    known('R45 a server failure: "Export failed: Something went wrong on the server. Please try again.." (MODAQ adds its own period: two)' + changed('serverFail'),
      t, 'Export failed: Something went wrong on the server. Please try again..', 'Export failed: Something went wrong on the server. Please try again.');
  } finally { d1(`UPDATE buckets SET wrap = '${wrap}' WHERE id = ${c1.id}`); }
  ok('R45 an empty body: "Export failed: empty file."', empty === 'Export failed: empty file.', empty);
  // the tournament closes: 48 hours after Start
  d1(`UPDATE tournaments SET started = started - ${49 * 3600 * 1000} WHERE id = ${C.id}`);
  t = await fail();
  ok('R45 the room closed: "Export failed: room closed."', t === 'Export failed: room closed.', t);
  ok('R43 after a failure the uploading note is gone', !(await tab.exists('.uploading')));
  // R04: the room link now
  await openRoom(tab, c1.secret, '', 'msg');
  ok('R04 a closed room\'s link: "room closed", in red, nothing else', (await tab.text('#msg')) === 'room closed' && (await red(tab, '#msg'))
    && !(await tab.shown('#picker')) && (await tab.text('#tname')) === 'qb-td' && (await tab.text('#room')) === '', await tab.text('#msg'));
  const load = await call(`/b/${c1.secret}/load`);
  const gets = await Promise.all(['', '/schedule', '/roster', '/tiebreakers', '/packet?round=1'].map((x) => call(`/b/${c1.secret}${x}`)));
  const posts = await Promise.all(['/upload?round=1&name=x.qbj', '/start?round=1', '/protests?round=1&g=abc'].map((x) => call(`/b/${c1.secret}${x}`, { method: 'POST', body: '{}' })));
  ok('R04 Worker: every /b/ route answers 410 "room closed"', ['', '/schedule', '/roster', '/tiebreakers'].every((k) => load.body[k].s === 410)
    && [...gets, ...posts].every((r) => r.status === 410 && r.body.error === 'room closed'), [load.body, gets.map((r) => r.status), posts.map((r) => r.status)]);
  // never started: rooms close a week after the tournament was made
  const N = await tournament('Reader Never Started');
  const n1 = await N.room('Never 1');
  d1(`UPDATE tournaments SET created = created - ${8 * 24 * 3600 * 1000} WHERE id = ${N.id}`);
  await openRoom(tab, n1.secret, '', 'msg');
  ok('R04 never started, made over a week ago: "room closed"', (await tab.text('#msg')) === 'room closed' && (await red(tab, '#msg')), await tab.text('#msg'));
});

/* ---------------------------------------------------------------------- */

await section('RZ', 'after the run', async () => {
  const wait = 31000 - (Date.now() - watchFrom);
  if (wait > 0) await sleep(wait);
  const asked = watch.worker(0);
  ok('R06 the room link opened at the start has asked for nothing since its load (31 s and more): no part fetched on its own' + changed('oneRequest'),
    JSON.stringify(asked) === JSON.stringify(['GET /b/:s/load', 'GET /b/:s/packet?round=3&warm=1']), asked);
  const all = tabs.flatMap((t) => t.reqs.map((r) => r.url));
  const prod = all.filter((u) => /qbsuite\.github\.io|workers\.dev|githubusercontent|quizbowlreader|api\.github\.com|api\.cloudflare\.com/.test(u));
  ok('no page asked for production, GitHub, Cloudflare or the .docx parser', prod.length === 0, prod);
  const outside = [...new Set(all.filter((u) => /^https?:/.test(u) && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)).map((u) => new URL(u).host))];
  console.log('     (hosts outside this machine the pages tried, none of them reachable from this Chrome: ' + (outside.join(', ') || 'none') + ')');
});

//@@END

/* ====================================================================== */

const pageErrors = tabs.flatMap((t) => t.errors);
if (pageErrors.length) console.log('page errors seen:\n' + pageErrors.slice(0, 10).map((e) => '     ' + e.split('\n').slice(0, 2).join(' / ')).join('\n'));
console.log(`\n${passed} reader checks passed, ${failed} failed${knownBugs ? `, ${knownBugs} of the passes pin a known bug` : ''} (${Math.round((Date.now() - started) / 1000)} s)`);
stopAll();
await sleep(500);
try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* Chrome still letting go of its profile */ }
process.exit(failed ? 1 : 0);
