#!/usr/bin/env node
// ui_full_sets.js — question sets, driven in a real headless Chrome the way
// an editor and a mirror's director use them: the set list and the New set
// form (set.html), a set's dashboard (Packets, Versions, the parse Review,
// tiebreakers, Mirrors, Stats, Settings), a mirror's invite page
// (index.html?i=), a mirror's own hub, and the public set page (s.html).
// Each check asserts what a person sees — the page's text, which buttons
// are there and enabled, dialogs, downloaded files opened and read — or
// what the page sent to the Worker, never the page's internals.
//
// Run it (nothing else needed; it starts and stops its own servers):
//   node tests/ui_full_sets.js
// It starts, on a fresh local database:
//   - the Worker: wrangler dev --local on 127.0.0.1:9671 (--test-scheduled,
//     inspector 9679), with no secrets, so it reaches nothing outside;
//   - the app's pages on http://localhost:9672 (a small static server here);
//   - headless Chrome, DevTools on 9673.
// Every page is loaded with ?server=<the local Worker>&live=off. Packets are
// JSON only (a .docx would go to the outside YAPP parser), and the browser
// blocks production hosts; one check at the end fails if any page tried to
// reach a host other than this machine.
//
// Before vs after (the code before the 10/19-10/20 changes is 173a444):
//   mkdir -p /tmp/qbtd-before
//   git -C <repo> archive 173a444 app worker | tar -x -C /tmp/qbtd-before
//   QBTD_ROOT=/tmp/qbtd-before node tests/ui_full_sets.js > /tmp/sets-before.txt
//   node tests/ui_full_sets.js > /tmp/sets-after.txt
//   diff <(grep -E '^(  ok|FAIL)' /tmp/sets-before.txt | cut -c1-160) \
//        <(grep -E '^(  ok|FAIL)' /tmp/sets-after.txt | cut -c1-160)
// git archive copies the two folders out without touching any checkout (a
// `git worktree add` of 173a444 works too). QBTD_ROOT points the stack at
// that copy's app/ and worker/ (and its schema.sql); this file, its zip
// reader and wrangler stay this checkout's, so the copy needs no npm install.
// Checks named "[changed: <release note>]" expect what an approved 10/19
// change brought, so they are the ones expected to fail on the older code.
// The older code also throws in set.html once a set has a packet (the
// Remove-packet row's missing anchor), which the last check reports.
// Checks marked "(known bug …)" pass while a reported bug still reproduces
// and print a note once it no longer does.
//
// Options (environment):
//   QBTD_ROOT                  the checkout whose app/ and worker/ are tested
//   QBTD_SETS_WORKER_PORT      9671    QBTD_SETS_PAGES_PORT      9672
//   QBTD_CDP_PORT              9673    QBTD_SETS_INSPECTOR_PORT  9679
//   QBTD_SETS_KEEP=1           keep the temporary folder (database, downloads, logs)
//   CHROME                     the Chrome binary
//   QBTD_BASE, QBTD_PAGES, QBTD_PERSIST   use a stack that is already running
//                              (tools/e2e_stack.mjs prints them) instead

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, readZip } from '../app/engine/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, '..');
const ROOT = path.resolve(process.env.QBTD_ROOT || TOOLS);
const WRANGLER = path.join(TOOLS, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const portOf = (name, dflt) => Number(process.env[name] || dflt);
const W_PORT = portOf('QBTD_SETS_WORKER_PORT', 9671);
const P_PORT = portOf('QBTD_SETS_PAGES_PORT', 9672);
const CDP_PORT = portOf('QBTD_CDP_PORT', 9673);
const I_PORT = portOf('QBTD_SETS_INSPECTOR_PORT', 9679);
const KEEP = process.env.QBTD_SETS_KEEP === '1';
const startedAt = Date.now();
const tmp = mkdtempSync(path.join(tmpdir(), 'qbtd-sets-ui-'));
const dlDir = path.join(tmp, 'downloads');
const fxDir = path.join(tmp, 'fixtures');
mkdirSync(dlDir, { recursive: true });
mkdirSync(fxDir, { recursive: true });
const WENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };
const RUN = Math.random().toString(36).slice(2, 7);
const DAY = 24 * 3600 * 1000;

// the 10/19 release notes these checks follow (app/changelog.txt)
const CH = {
  lock: '[changed: Turning off mirror buzzpoints is no longer undone by adding or removing a packet or changing the format afterward.]',
  modaq: '[changed: The parse review says when MODAQ will not load a packet, for example a bonus with no point values.]',
  ledger: "[changed: A question ledger or category map that can't be read is left as it is, and the editor says so, instead of being overwritten.]",
  many: '[changed: Packet uploads and removals work for sets with many mirrors.]',
  dl: '[changed: Game downloads and public page updates use less server time.]',
  tb: '[changed: The Live Hub fetches the tiebreaker pool only when it has changed.]',
  bye: "[changed: The set page no longer waits on a mirror's Bye Room before showing a round as finished.]",
  room: '[changed: Renaming a room updates the room name shown with buzzes on set pages.]',
};

/* ---------- tally ---------- */

let passed = 0;
let failed = 0;
const knownNotes = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); return; }
  failed++;
  let more = '';
  if (extra !== undefined) more = typeof extra === 'string' ? extra : JSON.stringify(extra);
  console.error('FAIL', name, more.length > 900 ? more.slice(0, 900) + '…' : more);
}
// a check whose body may throw: a throw fails it with the reason
async function check(name, fn) {
  let v;
  try { v = await fn(); } catch (e) { ok(name, false, e.message); return; }
  ok(name, v === true, v);
}
// A reported bug, checked as it behaves now: it passes while the bug
// reproduces, and says so once it no longer does (the check then needs
// its expected result turned around).
function knownBug(name, reproduces, extra) {
  passed++;
  if (reproduces) console.log('  ok', name, '(known bug, still reproduces)');
  else {
    knownNotes.push(name);
    console.log('  ok', name, '(NOTE: this known bug no longer reproduces; update the check)', extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

/* ---------- the stack: a dev Worker, the pages, Chrome ---------- */

const kids = [];
const servers = [];
function stopAll() {
  for (const k of kids) {
    try { process.kill(-k.pid, 'SIGTERM'); } catch (e) { try { k.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  }
  for (const s of servers) { try { s.close(); } catch (e) { /* closed */ } }
  kids.length = 0;
  servers.length = 0;
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(130); });

const until = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await new Promise((r) => setTimeout(r, 60));
  }
};
const portBusy = (port) => new Promise((res) => {
  const s = createConnection(port, '127.0.0.1');
  s.on('connect', () => { s.end(); res(true); });
  s.on('error', () => res(false));
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
// the app's static files, as GitHub Pages serves them (no caching here)
function staticServer(root, port) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(u.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { /* missing */ }
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

let BASE;
let PAGES;
let STATE;
const external = !!(process.env.QBTD_BASE && process.env.QBTD_PAGES && process.env.QBTD_PERSIST);
if (external) {
  BASE = process.env.QBTD_BASE.replace(/\/$/, '');
  PAGES = process.env.QBTD_PAGES.replace(/\/$/, '');
  STATE = path.resolve(process.env.QBTD_PERSIST);
} else {
  for (const p of [W_PORT, P_PORT, CDP_PORT, I_PORT]) {
    if (p < 9600 || p > 9699) { console.error('ports must be 9600-9699'); process.exit(2); }
    if (await portBusy(p)) { console.error(`port ${p} is in use; pick others (see the header)`); process.exit(2); }
  }
  STATE = path.join(tmp, 'state');
  mkdirSync(STATE, { recursive: true });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'qb-td', '--local', '--file', 'schema.sql', '--persist-to', STATE],
    { cwd: path.join(ROOT, 'worker'), env: WENV, stdio: 'ignore' });
  const log = openSync(path.join(tmp, 'wrangler_dev.log'), 'a');
  kids.push(spawn(process.execPath, [WRANGLER, 'dev', '--local', '--port', String(W_PORT), '--ip', '127.0.0.1', '--test-scheduled',
    '--persist-to', STATE, '--var', `ALLOWED_ORIGIN:http://localhost:${P_PORT}`, '--show-interactive-dev-session=false',
    '--inspector-port', String(I_PORT)], { cwd: path.join(ROOT, 'worker'), env: WENV, stdio: ['ignore', log, log], detached: true }));
  servers.push(await staticServer(path.join(ROOT, 'app'), P_PORT));
  BASE = `http://127.0.0.1:${W_PORT}`;
  PAGES = `http://localhost:${P_PORT}`;
  await until(async () => (await fetch(BASE + '/')).ok, 'the dev Worker (see ' + path.join(tmp, 'wrangler_dev.log') + ')', 120000);
}
console.log(`stack: Worker ${BASE}, pages ${PAGES}, code under test ${ROOT}`);

/* ---------- the Worker, its database and its bucket, from Node ---------- */

const wrangler = (args) => execFileSync(process.execPath, [WRANGLER, ...args],
  { cwd: path.join(ROOT, 'worker'), env: WENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
// rows of the last statement (several may be given, ;-separated)
function d1(sql) {
  const out = wrangler(['d1', 'execute', 'qb-td', '--local', '--json', '--command', sql, '--persist-to', STATE]);
  const parsed = JSON.parse(out.slice(out.search(/^\[/m)));
  return parsed[parsed.length - 1].results;
}
const r2file = () => path.join(tmp, 'r2-' + Math.random().toString(36).slice(2));
function r2get(key) {
  const f = r2file();
  wrangler(['r2', 'object', 'get', 'qb-td-data/' + key, '--local', '--file', f, '--persist-to', STATE]);
  const b = readFileSync(f);
  rmSync(f);
  return b;
}
function r2put(key, body) {
  const f = r2file();
  writeFileSync(f, body);
  wrangler(['r2', 'object', 'put', 'qb-td-data/' + key, '--local', '--file', f, '--persist-to', STATE]);
  rmSync(f);
}
const r2del = (key) => wrangler(['r2', 'object', 'delete', 'qb-td-data/' + key, '--local', '--persist-to', STATE]);

// The wrangler CLI resets the dev server's keep-alive sockets: one retry
// on a fresh connection.
async function fetchRetry(url, opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, opts); } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  const res = await fetchRetry(BASE + p, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body };
}
async function api(p, opts) {
  const r = await call(p, opts);
  if (r.status !== 200) throw new Error(`${opts && opts.method || 'GET'} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const tick = async () => { const r = await fetchRetry(BASE + '/__scheduled'); await r.text(); };
const setDetail = (secret) => api('/s/' + secret);
const settingsOf = async (secret) => JSON.parse((await setDetail(secret)).set.settings || '{}');
const packetsOf = async (secret) => (await setDetail(secret)).packets;
const ledgerOf = async (secret) => (await call(`/s/${secret}/ledger`)).body;
async function createSetApi(name, slug) {
  const b = await api('/api/sets', { method: 'POST', json: { name, slug } });
  return { secret: b.admin_secret, slug: b.slug, name: b.name, id: b.id, closes: b.closes };
}
const uploadApi = (secret, packet, name, body) =>
  api(`/s/${secret}/packet?packet=${packet}&name=${encodeURIComponent(name)}`, { method: 'POST', body });
// a mirror started from a fresh invite, the way the invite page does it
async function startMirrorApi(secret, name, slug) {
  const inv = await api(`/s/${secret}/mirrors`, { method: 'POST', json: { name } });
  const t = await api('/i/' + inv.invite, { method: 'POST', json: { name, slug } });
  return { mirrorId: inv.id, invite: inv.invite, admin: t.admin_secret, tid: t.id, slug };
}

/* ---------- Chrome over the DevTools protocol ---------- */

const chromeDir = path.join(tmp, 'chrome');
kids.push(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${chromeDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-features=Translate,OptimizationHints,MediaRouter', 'about:blank'],
{ stdio: 'ignore', detached: true }));
const wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl,
  'Chrome to start', 30000);
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
  } else if (m.method) for (const fn of [...listeners]) fn(m);
};
const deadline = (p, ms, what) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(new Error('no ' + what + ' within ' + ms + 'ms')), ms))]);
const send = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return deadline(new Promise((res, rej) => pending.set(id, { res, rej, method })), 60000, 'reply to ' + method);
};
const once = (pred, ms = 20000, what = 'browser event') => deadline(new Promise((res) => {
  const fn = (m) => { if (pred(m)) { listeners.splice(listeners.indexOf(fn), 1); res(m); } };
  listeners.push(fn);
}), ms, what);
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params) => send(method, params, sessionId);

const pageErrors = [];
const dialogs = [];
let dialogAccept = true;   // false: the next confirm() is answered Cancel
const netLog = [];         // {method, url, type}
const offHost = [];        // requests for anything but this machine
const downloads = new Map();
const pausedQmap = [];     // requests held by the ledger-race check
let here = 'about:blank';
listeners.push((m) => {
  if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, done: false });
  if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') {
    const d = downloads.get(m.params.guid);
    if (d) d.done = true;
  }
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message);
    S('Page.handleJavaScriptDialog', { accept: dialogAccept });
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(here + ': ' + ((d.exception && d.exception.description) || d.text));
  } else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
    here = m.params.frame.url;
  } else if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    netLog.push({ method: r.method, url: r.url, type: m.params.type || '' });
    if (/^(https?|wss?):/.test(r.url) && !['localhost', '127.0.0.1'].includes(new URL(r.url).hostname)) offHost.push(r.url);
  } else if (m.method === 'Fetch.requestPaused') {
    pausedQmap.push(m.params);
  }
});
await S('Page.enable');
await S('Runtime.enable');
await S('DOM.enable');
await S('Network.enable');
await S('Network.setCacheDisabled', { cacheDisabled: true });
// production and the outside parser are out of reach for these pages
await S('Network.setBlockedURLs', { urls: ['*quizbowlreader.com*', '*workers.dev*', '*github.io*', '*githubusercontent.com*',
  '*github.com*', '*cloudflare.com*', '*googleapis.com*', '*gstatic.com*'] });
await S('Page.setInterceptFileChooserDialog', { enabled: true });
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
const ORIGIN = new URL(PAGES).origin;
const grantClipboard = () => send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
await grantClipboard();
await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
const desktop = (height = 1000) => S('Emulation.setDeviceMetricsOverride', { width: 1280, height, deviceScaleFactor: 1, mobile: false });
await desktop();

/* ---------- page helpers ---------- */

const q = (s) => JSON.stringify(s);
async function js(expression) {
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function seen() {
  try {
    return ' — page: ' + await js(`((document.querySelector('#msg') || {}).textContent || '') + ' || '
      + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500)`);
  } catch (e) { return ''; }
}
async function waitJs(expr, label, ms = 15000) {
  try { return await until(() => js(expr), label, ms); } catch (e) { throw new Error(e.message + await seen()); }
}
const click = (sel) => js(`(() => { const e = document.querySelector(${q(sel)});
  if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
const fill = (sel, value, events = ['input', 'change']) => js(`(() => {
  const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
  e.value = ${q(value)}; for (const t of ${q(events)}) e.dispatchEvent(new Event(t, { bubbles: true }));
  return true; })()`);
const text = (sel) => js(`((document.querySelector(${q(sel)}) || {}).textContent || '').replace(/\\s+/g, ' ').trim()`);
const exists = (sel) => js(`!!document.querySelector(${q(sel)})`);
const msgText = () => js(`document.querySelector('#msg').textContent`);
const msgBad = () => js(`document.querySelector('#msg').classList.contains('bad')`);
const clearMsg = () => js(`(() => { const m = document.querySelector('#msg'); if (m) m.textContent = ''; return true; })()`);
async function waitMsg(re, label) {
  await waitJs(`${re}.test(document.querySelector('#msg').textContent)`, label || 'the message ' + re);
  return msgText();
}
const clipboard = () => js('navigator.clipboard.readText()');
const workerReqs = (since) => netLog.slice(since).filter((r) => r.url.startsWith(BASE) && r.method !== 'OPTIONS' && r.type !== 'Preflight');
// a short settle, only where a check is that something does NOT happen
const settle = (ms = 400) => js(`new Promise((r) => setTimeout(() => r(true), ${ms}))`);

function pageUrl(file, params = {}) {
  const u = new URL(PAGES + '/' + file);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('server', BASE);
  u.searchParams.set('live', 'off');
  return u.href;
}
async function goto(url) {
  const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, 'load of ' + url);
  await S('Page.navigate', { url });
  await loaded;
}
const open = (file, params) => goto(pageUrl(file, params));
async function toTab(key) {
  await click(`[data-settab="${key}"]`);
  await waitJs(`document.querySelector('[data-settab="${key}"]').classList.contains('active')`, 'the ' + key + ' tab');
}
async function openSet(secret, tab = 'packets') {
  await open('set.html', { a: secret });
  await waitJs(`!!document.querySelector('[data-settab]') && !!document.querySelector('#setbody').children.length`, 'the set dashboard');
  if (tab !== 'packets') await toTab(tab);
  else await waitJs(`!!document.querySelector('.pktable')`, 'the packet slots');
}
async function pick(sel, files) {
  const opened = once((m) => m.sessionId === sessionId && m.method === 'Page.fileChooserOpened', 10000, 'a file chooser from ' + sel);
  await click(sel);
  const { params } = await opened;
  await S('DOM.setFileInputFiles', { backendNodeId: params.backendNodeId, files });
}
async function download(trigger, label) {
  const before = new Set(downloads.keys());
  await trigger();
  const guid = await until(() => [...downloads.keys()].find((g) => !before.has(g) && downloads.get(g).done), 'the download of ' + label, 30000);
  return { name: downloads.get(guid).name, bytes: readFileSync(path.join(dlDir, guid)) };
}
// real DOM drag events with a DataTransfer, as a mouse drag fires them
const dragOnto = (fromExpr, toExpr) => js(`(() => {
  const from = ${fromExpr}; const to = ${toExpr};
  if (!from || !to) throw new Error('drag: nothing to drag from (' + !!from + ') or onto (' + !!to + ')');
  const dt = new DataTransfer();
  const ev = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  ev(from, 'dragstart'); ev(to, 'dragenter'); ev(to, 'dragover'); ev(to, 'drop'); ev(from, 'dragend');
  return true; })()`);
const chipExpr = (name) => `[...document.querySelectorAll('[data-chip]')].find((c) => c.textContent.trim().startsWith(${q(name)}))`;
const slotExpr = (n) => `document.querySelector('.slot[data-round="${n}"]')`;
const chips = () => js(`[...document.querySelectorAll('[data-chip]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())`);
// every sample of `fn` (page source of a function) as the DOM changes, until samples()
async function observe(fn) {
  await js(`(() => { window.__samples = []; let last = null;
    const take = () => { let v; try { v = JSON.stringify((${fn})()); } catch (e) { v = 'null'; }
      if (v !== last) { last = v; window.__samples.push(JSON.parse(v)); } };
    take(); if (window.__obs) window.__obs.disconnect();
    window.__obs = new MutationObserver(take);
    window.__obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return true; })()`);
}
const samples = () => js(`(() => { if (window.__obs) window.__obs.disconnect(); return window.__samples || []; })()`);
const slotRows = () => js(`[...document.querySelectorAll('.pktable tr.slot')].map((tr) => ({
  n: Number(tr.dataset.round), label: tr.querySelector('.pkn').textContent,
  file: tr.querySelector('.pkfile').textContent.replace(/\\s+/g, ' ').trim(), warn: tr.classList.contains('warn'),
  pick: (tr.querySelector('[data-pickround]') || {}).title || null, preview: !!tr.querySelector('[data-preview]'),
  dl: tr.querySelector('a.icon[download]') ? tr.querySelector('a.icon[download]').getAttribute('href') : null,
  drag: !!tr.querySelector('[data-move]') }))`);
const versionsDetails = `[...document.querySelectorAll('#setbody details')].find((d) => d.querySelector('summary').textContent.trim() === 'Versions')`;
const versionRows = () => js(`(() => { const d = ${versionsDetails}; if (!d) return null;
  return [...d.querySelectorAll('tr')].slice(1).map((tr) => { const td = tr.querySelectorAll('td'); const a = td[2].querySelector('a');
    return { pv: td[0].textContent.trim() + ':' + td[1].textContent.trim().replace(/^v/, ''), v: td[1].textContent.trim(),
      file: a.textContent, href: a.getAttribute('href'), dl: a.hasAttribute('download'), uploaded: td[3].textContent.trim(),
      state: td[4].textContent.trim(), green: !!td[4].querySelector('.ok'),
      questions: td[5].textContent.replace(/\\s+/g, ' ').trim(), match: !!td[5].querySelector('[data-match]'),
      notMatchedRed: !!td[5].querySelector('.bad'), parse: td[6].textContent.replace(/\\s+/g, ' ').trim(),
      parseRed: !!td[6].querySelector('.bad'), parseGreen: !!td[6].querySelector('.ok'),
      review: !!td[7].querySelector('[data-review]'), muted: tr.classList.contains('muted') }; }); })()`);
const vrow = (rows, pv) => (rows || []).find((r) => r.pv === pv) || {};
async function openReview(pv) {
  await click(`[data-review="${pv}"]`);
  await waitJs(`!!document.querySelector('.review') || /could not be read as questions/.test(document.querySelector('#setbody').textContent)`,
    'the review of ' + pv);
}
async function backToPackets() {
  await click('#reviewback');
  await waitJs(`!!document.querySelector('.pktable')`, 'the packets again');
}
const reviewRows = () => js(`[...document.querySelectorAll('.review .qrow')].map((r) => {
  const sel = r.querySelector('select[data-reassign]');
  return { n: r.querySelector('.roundcell').textContent, head: r.querySelector('.qhead').textContent.replace(/\\s+/g, ' ').trim(),
    answer: (r.querySelector('.qhead > b') || {}).textContent || '', answerRed: !!r.querySelector('.qhead > b .bad'),
    meta: (r.querySelector('.qhead > .muted') || {}).textContent || '',
    ident: r.querySelector('.ident').textContent, identRed: r.querySelector('.ident').classList.contains('bad'),
    warns: [...r.querySelectorAll('.warn')].map((w) => w.textContent.replace(/^\\u26a0\\s*/, '').trim()),
    picker: sel ? sel.options[0].textContent : null, key: sel ? sel.dataset.reassign : null,
    options: sel ? [...sel.options].map((o) => [o.value, o.textContent.replace(/\\s+/g, ' ').trim()]) : [] }; })`);
const reviewSummary = () => js(`(() => { const box = document.querySelector('#setbody');
  const sum = [...box.querySelectorAll('div.muted')].find((d) => / tossups, \\d+ bonuses\\./.test(d.textContent));
  return { header: (box.querySelector('.row b') || {}).textContent || '', file: (box.querySelector('.row .mono') || {}).textContent || '',
    summary: sum ? sum.textContent.replace(/\\s+/g, ' ').trim() : '', notMatchedRed: !!(sum && [...sum.querySelectorAll('b.bad')].some((b) => /has not been matched/.test(b.textContent))),
    packetWarns: [...box.querySelectorAll(':scope > div.bad')].map((d) => d.textContent.replace(/^\\u26a0\\s*/, '').trim()),
    check: !!box.querySelector('#check'), uncheck: !!box.querySelector('#uncheck'),
    checked: (box.querySelector('.row .ok') || {}).textContent || '', back: (box.querySelector('#reviewback') || {}).textContent || '' }; })()`);
const storedLinks = () => js(`JSON.parse(localStorage.getItem('qbtdSetLinks') || '[]')`);
const today = () => js(`new Date().toLocaleDateString()`);

/* ---------- fixtures: JSON packets only ---------- */

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// made-up words, so no two questions share phrasing by accident
const SYL = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'to', 'vi', 'ze', 'po', 'qu', 'de', 'fa', 'gi', 'ho', 'ju',
  'bel', 'dor', 'fen', 'gal', 'hun', 'lir', 'mor', 'nas', 'pel', 'rin', 'sol', 'tav', 'ulm', 'wen', 'yor', 'zan'];
function wordsFrom(seed) {
  const r = prng(seed);
  const word = () => [0, 1, 2].map(() => SYL[Math.floor(r() * SYL.length)]).join('');
  return (n) => Array.from({ length: n }, word).join(' ');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const CATS = ['History', 'Literature', 'Science', 'Fine Arts'];
// a packet the parse review finds nothing wrong with
function cleanPacket(seed, { tossups = 4, bonuses = 4, meta = false, diff = false } = {}) {
  const w = wordsFrom(seed);
  return {
    tossups: Array.from({ length: tossups }, (_, i) => ({
      question: `${cap(w(30))}. For 10 points, name this ${w(2)}.`,
      answer: `<b><u>${cap(w(1))}</u></b> [accept ${w(1)}]`,
      category: CATS[i % CATS.length],
      ...(meta ? { metadata: `Editor ${i + 1}, ${CATS[i % CATS.length]}` } : {}),
    })),
    bonuses: Array.from({ length: bonuses }, (_, i) => ({
      leadin: `${cap(w(10))}. For 10 points each:`,
      parts: [0, 1, 2].map(() => `${cap(w(8))}.`),
      answers: [0, 1, 2].map(() => `<b>${cap(w(1))}</b>`),
      values: [10, 10, 10],
      category: CATS[(i + 1) % CATS.length],
      ...(diff && i === 0 ? { difficultyModifiers: ['e', 'm', 'h'] } : {}),
    })),
  };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const labelOf = (tu) => /<u>([^<]+)<\/u>/.exec(tu.answer)[1];
const reword = (tu) => ({ ...tu, question: tu.question.replace(/^((?:\S+ ){5})\S+/, '$1reworded') });
function fx(rel, data) {
  const p = path.join(fxDir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data));
  return p;
}

const A_P1 = cleanPacket(101);
const A_P2 = cleanPacket(202, { meta: true, diff: true });
const A_P3 = cleanPacket(303);
const A_P1v2 = clone(A_P1);
A_P1v2.tossups[0] = reword(A_P1.tossups[0]);
A_P1v2.tossups[2] = clone(A_P2.tossups[3]);
const A_NEWP = cleanPacket(505, { tossups: 1, bonuses: 1 });
// a tossup inserted at the top and a bonus added at the end (5 and 5: no count warning)
const A_P1v4 = { tossups: [A_NEWP.tossups[0], ...clone(A_P1v2.tossups)], bonuses: [...clone(A_P1v2.bonuses), A_NEWP.bonuses[0]] };

// every parse warning the review gives, and every MODAQ-will-not-load one
const W = wordsFrom(909);
const okTu = (extra = '') => `${cap(W(30))}${extra}. For 10 points, name this ${W(2)}.`;
const WARN = {
  tossups: [
    { question: '', answer: '<b>Empty question</b>', category: 'History' },
    { question: 'Short question here. For 10 points, name it.', answer: '<b>Shorty</b>', category: 'History' },
    { question: `${cap(W(230))}. For 10 points, name this.`, answer: '<b>Longform</b>', category: 'History' },
    { question: okTu(), answer: '', category: 'History' },
    { question: okTu(), answer: W(45), category: 'History' },
    { question: okTu(' ANSWER: leaked'), answer: '<b>Leaky</b>', category: 'History' },
    { question: '1. ' + okTu(), answer: '<b>Labelled</b>', category: 'History' },
    { question: `${cap(W(10))} (*) ${W(10)} (*) ${W(10)}. For 10 points, name this.`, answer: '<b>Twopower</b>', category: 'History' },
    { question: `${cap(W(30))}. Name this ${W(2)}.`, answer: '<b>Shared</b>', category: 'History' },
    { question: `${cap(W(15))} (*) ${W(15)}. For 10 points, name this.`, answer: '<b>Shared</b>', metadata: 5 },
  ],
  bonuses: [
    { leadin: 'Two parts here. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ba</b>', '<b>Bb</b>'], values: [10, 10], category: 'Science' },
    { leadin: 'Few answers. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ca</b>', '<b>Cb</b>'], values: [10, 10, 10], category: 'Science' },
    { leadin: 'An empty part. For 10 points each:', parts: [`${cap(W(6))}.`, '', `${cap(W(6))}.`], answers: ['<b>Da</b>', '<b>Db</b>', '<b>Dc</b>'], values: [10, 10, 10], category: 'Science' },
    { leadin: 'A marker left in. For 10 points each:', parts: [`[10] ${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ea</b>', '<b>Eb</b>', '<b>Ec</b>'], values: [10, 10, 10], category: 'Science' },
    { leadin: 'A short part. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, 'Too short.'], answers: ['<b>Fa</b>', '<b>Fb</b>', '<b>Fc</b>'], values: [10, 10, 10], category: 'Science' },
    { leadin: 'An empty answer. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ga</b>', '', '<b>Gc</b>'], values: [10, 10, 10], category: 'Science' },
    { leadin: 'Values short. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ha</b>', '<b>Hb</b>', '<b>Hc</b>'], values: [10, 10], category: 'Science' },
    { leadin: 'A zero value. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ia</b>', '<b>Ib</b>', '<b>Ic</b>'], values: [10, 0, 10], category: 'Science' },
    { leadin: '', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ja</b>', '<b>Jb</b>', '<b>Jc</b>'], values: [10, 10, 10], category: 'Science' },
    { leadin: 'No values at all. For 10 points each:', parts: [`${cap(W(6))}.`, `${cap(W(6))}.`, `${cap(W(6))}.`], answers: ['<b>Ka</b>', '<b>Kb</b>', '<b>Kc</b>'], category: 'Science', metadata: { editor: 'X' } },
    { leadin: [`Lead in as a list ${W(4)}. For 10 points each:`], parts: [`${cap(W(6))}.`, [`${W(5)}`], `${cap(W(6))}.`], answers: ['<b>La</b>', '<b>Lb</b>', [`${W(2)}`]], values: [10, 10, 10], category: 'Science' },
    5,
  ],
};
const WARN_EXPECTED = {
  T1: ['no question text'], T2: [/^very short \(\d+ words\)$/],
  T3: [/^very long \(\d+ words\) — two questions run together\?$/], T4: ['no answerline'],
  T5: ['answerline is 45 words — question text in the answer?'], T6: ['"ANSWER:" inside the question text'],
  T7: ['starts with a question label'], T8: ['2 power marks'], T9: ['no "For 10 points"'],
  T10: ['This tossup\'s metadata is not text, so MODAQ will not load this packet.'],
  B1: ['2 parts'], B2: ['2 answers for 3 parts'], B3: ['part 2 is empty'], B4: ['part 1 still carries its "[10]" marker'],
  B5: ['part 3 is very short'], B6: ['answer 2 is empty'], B7: ['values do not match the parts'], B8: ['a part has no point value'],
  B9: ['no lead-in'],
  B10: ['This bonus has no point values, so MODAQ will not load this packet.', 'This bonus\'s metadata is not text, so MODAQ will not load this packet.'],
  B11: ['Part 2 is not text, so MODAQ will not load this packet.', 'Answer 3 is not text, so MODAQ will not load this packet.',
    'This bonus\'s lead-in is not text, so MODAQ will not load this packet.'],
  B12: ['This entry is not a bonus, so MODAQ will not load this packet.'],
};
const MODAQ_KEYS = new Set(['T10', 'B10', 'B11', 'B12']);
const WARN_PACKET_LEVEL = ['10 tossups but 12 bonuses', '1 of 10 tossups carry a power mark', 'T9 and T10 share an answerline (Shared)',
  '1 tossups without category data'];
WARN.tossups[3].category = undefined; // T4 has no category data (and no metadata)
const NOCAT = { tossups: cleanPacket(808, { bonuses: 0 }).tossups.map(({ category, ...tu }) => tu) };

/* ---------- sections ---------- */

async function section(name, fn) {
  console.log('\n# ' + name);
  try { await fn(); } catch (e) {
    ok(name + ': the section ran to its end', false, (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  }
}

let A = null; // the main set, made with the form
let B = null; // a set whose ledger and category map go bad
let C = null; // a set with mirrors
let D = null; // a set with 20 mirrors, then 200
let E = null; // a set past its year

await section('setup: this device points at the local Worker', async () => {
  await open('set.html');
  await js(`localStorage.setItem('qbtdServer', ${q(BASE)}); localStorage.setItem('qbtdLive', 'off');
    localStorage.removeItem('qbtdSetLinks'); true`);
  // a stack that ran before: its sets and mirrors don't count against this run's daily caps
  if (external) d1("UPDATE sets SET creator_ip = 'earlier-run'; UPDATE tournaments SET creator_ip = 'earlier-run'");
});

/* ---------- SET-01: the list on this device ---------- */

await section('SET-01 the set list, empty', async () => {
  await open('set.html');
  await waitJs(`!!document.querySelector('#newbtn')`, 'the set list');
  const page = await js(`(() => { const h = [...document.querySelectorAll('#view h2')];
    return { heads: h.map((x) => x.textContent), first: h[0].nextElementSibling.textContent.trim(),
      firstMuted: h[0].nextElementSibling.classList.contains('muted'),
      name: document.querySelector('#newname').placeholder, slug: document.querySelector('#newslug').placeholder,
      create: document.querySelector('#newbtn').textContent,
      note: [...document.querySelectorAll('#view div.muted')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
      dash: [...document.querySelectorAll('#view a')].map((a) => [a.textContent, a.getAttribute('href')]) }; })()`);
  ok('SET-01: the page is headed "Sets on this device"', page.heads[0] === 'Sets on this device', page.heads);
  ok('SET-01: with no saved sets the list says "None yet"', page.first === 'None yet' && page.firstMuted, page.first);
  ok('SET-01: below it, the New set form: Name, URL name and Create',
    page.heads[1] === 'New set' && page.name === 'Name' && page.slug === 'URL name' && page.create === 'Create', page);
  ok('SET-01: a paragraph explains what a set is',
    page.note.includes('A set holds a tournament’s packets once, for every site that mirrors it.'), page.note);
  ok('SET-01: a "TO dashboard" link goes to index.html', page.dash.some(([t, h]) => t === 'TO dashboard' && h === 'index.html'), page.dash);
});

/* ---------- SET-02: the New set form ---------- */

await section('SET-02 create a set with the form, and the Save this link modal', async () => {
  const slug = 'sets-ui-a-' + RUN;
  await fill('#newname', 'Sets UI Main');
  await fill('#newslug', slug);
  const mark = netLog.length;
  await click('#newbtn');
  await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the Save this link modal');
  const link = await js(`document.querySelector('#modallink').textContent`);
  const m = /\/set\.html\?a=([a-z0-9]+)$/.exec(link);
  ok('SET-02: Create sends the set to the Worker (POST /api/sets)',
    netLog.slice(mark).some((r) => r.method === 'POST' && r.url === BASE + '/api/sets'));
  ok('SET-02: the modal "Save this link" shows the set link, set.html?a=…', !!m && link === `${PAGES}/set.html?a=${m[1]}`
    && (await text('#linkmodal h2')) === 'Save this link', link);
  A = { secret: m[1], slug, name: 'Sets UI Main' };
  const d = await setDetail(A.secret);
  A.id = d.set.id;
  A.closes = d.set.closes;
  ok('SET-02: the link opens the set just made', d.set.slug === slug && d.set.name === 'Sets UI Main', d.set);
  ok('SET-02: the set link lives a year', A.closes > Date.now() + 364 * DAY && A.closes < Date.now() + 366 * DAY, A.closes);
  await check('SET-02: the modal says "It works for a year, until <date>"', async () => js(`[...document.querySelectorAll('#linkmodal p')]
    .some((p) => p.textContent.replace(/\\s+/g, ' ').trim() === 'It works for a year, until ' + new Date(${A.closes}).toLocaleDateString() + '.')`));
  ok('SET-02: this device lists the new set straight away', (await storedLinks())[0].slug === slug);
  await clearMsg();
  await click('#modalcopy');
  await waitMsg(/^Copied set link$/);
  ok('SET-02: "Copy link" says "Copied set link"', (await msgText()) === 'Copied set link');
  ok('SET-02: "Copy link" puts the set link on the clipboard', (await clipboard()) === link);
  await click('#modalok');
  await waitJs(`location.search === '?a=${A.secret}' && !!document.querySelector('[data-settab]')`, 'the new set\'s dashboard');
  ok('SET-02: "Saved it" closes the modal and opens the new set\'s dashboard', true);
  ok('SET-02: the dashboard (no ?server= in its address) reads the local Worker that localStorage names',
    netLog.slice(mark).some((r) => r.method === 'GET' && r.url === `${BASE}/s/${A.secret}`));
  await open('set.html');
  await waitJs(`!!document.querySelector('#newbtn')`, 'the set list');
  const row = await js(`(() => { const a = [...document.querySelectorAll('#view .card a')].find((x) => x.getAttribute('href') === ${q(`${PAGES}/set.html?a=${A.secret}`)});
    if (!a) return null; const card = a.closest('.card');
    return { name: a.querySelector('b').textContent, slug: card.querySelector('.mono').textContent, open: card.textContent.replace(/\\s+/g, ' ') }; })()`);
  ok('SET-02: the list on this device shows the set as a link to its dashboard, with its URL name',
    row && row.name === 'Sets UI Main' && row.slug === slug, row);
  ok('SET-02: … and "Open until <date>"', row && row.open.includes('Open until ' + await js(`new Date(${A.closes}).toLocaleDateString()`)), row);
});

/* ---------- SET-03: what Create refuses ---------- */

await section('SET-03 create-set errors', async () => {
  await open('set.html');
  await waitJs(`!!document.querySelector('#newbtn')`, 'the set list');
  const tryCreate = async (name, slug) => {
    await clearMsg();
    await fill('#newname', name);
    await fill('#newslug', slug);
    await click('#newbtn');
    await waitJs(`document.querySelector('#msg').textContent !== ''`, 'an answer to Create');
    return { text: await msgText(), red: await msgBad(), modal: await js(`!document.querySelector('#linkmodal').hidden`) };
  };
  for (const [what, name, slug, want] of [
    ['a URL name already in use', 'Again', () => A.slug, 'that URL name is already taken'],
    ['the reserved URL name demo', 'Demo', () => 'demo', 'that URL name is reserved'],
    ['the reserved URL name directory', 'Directory', () => 'directory', 'that URL name is reserved'],
    ['a URL name with a space and capitals', 'Bad', () => 'No Good', 'URL name must be 3-40 characters: a-z, 0-9, hyphens'],
    ['a missing name', '', () => 'sets-ui-noname-' + RUN, 'name required'],
  ]) {
    const r = await tryCreate(name, slug());
    ok(`SET-03: ${what} says "${want}" in red, and no link is shown`, r.text === want && r.red && !r.modal, r);
  }
  // four more sets (this run's others) reach the five-a-day limit
  B = await createSetApi('Sets UI Ledger', 'sets-ui-b-' + RUN);
  C = await createSetApi('Sets UI Mirrors', 'sets-ui-c-' + RUN);
  D = await createSetApi('Sets UI Many', 'sets-ui-d-' + RUN);
  E = await createSetApi('Sets UI Closed', 'sets-ui-e-' + RUN);
  const r = await tryCreate('Sixth', 'sets-ui-f-' + RUN);
  ok('SET-03: a sixth set from one address in a day says "creation limit reached, try again tomorrow" in red',
    r.text === 'creation limit reached, try again tomorrow' && r.red && !r.modal, r);
  ok('SET-03: the device list did not gain a set', (await storedLinks()).length === 1, await storedLinks());
  // E is a set opened a year ago; and the cap is lifted for the rest of the run
  const n = d1(`UPDATE sets SET created = 1 WHERE id = ${E.id}; UPDATE sets SET creator_ip = 'earlier-run';
    SELECT COUNT(*) AS n FROM sets WHERE slug LIKE '%-${RUN}'`)[0].n;
  ok('SET-03: nothing refused was created (five sets made in this run)', n === 5, n);
});

/* ---------- SET-04: opening a set link ---------- */

await section('SET-04 opening a set link: bad, closed, valid', async () => {
  const onlyAllSets = () => js(`(() => { const links = [...document.querySelectorAll('#view a')];
    return links.length === 1 && links[0].textContent === 'All sets' && links[0].getAttribute('href') === 'set.html'
      && !document.querySelector('[data-settab]'); })()`);
  await open('set.html', { a: 'abcdefghjkmnpqrstuvw' });
  await waitMsg(/./, 'an answer for an unknown link');
  ok('SET-04: an unknown set link says "bad link" in red', (await msgText()) === 'bad link' && await msgBad(), await msgText());
  ok('SET-04: … with only an "All sets" link', await onlyAllSets());
  await open('set.html', { a: E.secret });
  await waitMsg(/./, 'an answer for a closed set');
  ok('SET-04: a set past its year says "Set closed (set links work for a year)" in red',
    (await msgText()) === 'Set closed (set links work for a year)' && await msgBad(), await msgText());
  ok('SET-04: … with only an "All sets" link', await onlyAllSets());
  ok('SET-04: a closed set is not added to this device\'s list', !(await storedLinks()).some((e) => e.slug === E.slug));
  await openSet(B.secret);
  ok('SET-04: a valid link opens the dashboard and adds the set to this device\'s list', (await storedLinks())[0].slug === B.slug);
  await openSet(A.secret);
  const list = await storedLinks();
  ok('SET-04: opening a set again moves it to the top, once', list.map((e) => e.slug).join() === [A.slug, B.slug].join(), list);
  // a device that already keeps 30 sets, some past their year
  const fakes = Array.from({ length: 30 }, (_, i) => ({ secret: 'fakesecret' + String(i).padStart(10, '0'), slug: `old-set-${i}`,
    name: `Old set ${i}`, closes: i % 2 ? Date.now() - DAY : Date.now() + 30 * DAY }));
  await js(`localStorage.setItem('qbtdSetLinks', ${q(JSON.stringify(fakes))}); true`);
  await openSet(B.secret);
  const after = await storedLinks();
  ok('SET-04: opening one more keeps 30, the newest first, and drops the oldest',
    after.length === 30 && after[0].slug === B.slug && !after.some((e) => e.slug === 'old-set-29'), after.map((e) => e.slug));
  await open('set.html');
  await waitJs(`!!document.querySelector('#newbtn')`, 'the set list');
  const rows = await js(`[...document.querySelectorAll('#view .card')].map((c) => ({ text: c.textContent.replace(/\\s+/g, ' ').trim(),
    link: (c.querySelector('a') || {}).textContent || null, href: c.querySelector('a') ? c.querySelector('a').getAttribute('href') : null,
    mutedName: !!c.querySelector('b.muted'), pill: (c.querySelector('.pill') || {}).textContent || null }))`);
  ok('SET-01: the list shows up to 30 sets, newest first', rows.length === 30 && rows[0].text.startsWith('Sets UI Ledger'), rows.length);
  const closed = rows.find((r) => r.text.startsWith('Old set 1 '));
  ok('SET-01: a set past its year is greyed out with a "Closed" pill and a "Page" link to s.html?s=<slug>',
    closed && closed.mutedName && closed.pill === 'Closed' && closed.link === 'Page' && closed.href === `${PAGES}/s.html?s=old-set-1`, closed);
  const openRow = rows.find((r) => r.text.startsWith('Old set 0 '));
  ok('SET-01: an open set is a link to set.html?a=<secret> with "Open until <date>"', openRow && openRow.href === `${PAGES}/set.html?a=${fakes[0].secret}`
    && openRow.text.includes('old-set-0') && openRow.text.includes('Open until ' + await js(`new Date(${fakes[0].closes}).toLocaleDateString()`)), openRow);
  // back to this run's sets only
  await js(`localStorage.setItem('qbtdSetLinks', JSON.stringify(JSON.parse(localStorage.getItem('qbtdSetLinks')).filter((e) => !e.slug.startsWith('old-set-')))); true`);
});

/* ---------- SET-05: header and tabs ---------- */

await section('SET-05 the dashboard header and tabs', async () => {
  await openSet(A.secret);
  const head = await js(`(() => { const rows = document.querySelectorAll('#view > .row'); const back = rows[0].querySelector('a');
    return { back: back.textContent, href: back.getAttribute('href'), off: rows[0].textContent.includes('Public page off'),
      copy: !!document.querySelector('#copypub'), name: rows[1].querySelector('b').textContent, slug: rows[1].querySelector('.mono').textContent,
      tabs: [...document.querySelectorAll('[data-settab]')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
      active: document.querySelector('[data-settab].active').dataset.settab }; })()`);
  ok('SET-05: a "← All sets" link goes to set.html', head.back === '← All sets' && head.href === 'set.html', head);
  ok('SET-05: an unpublished set says "Public page off" (no public link, no Copy)', head.off && !head.copy, head);
  ok('SET-05: the set name and URL name', head.name === 'Sets UI Main' && head.slug === A.slug, head);
  ok('SET-05: the tabs are Packets, Mirrors 0/0, Stats and Settings, Packets first',
    head.tabs.join('|') === 'Packets|Mirrors 0/0|Stats|Settings' && head.active === 'packets', head.tabs);
  const mark = netLog.length;
  for (const k of ['mirrors', 'settings', 'packets', 'settings', 'mirrors', 'packets']) await toTab(k);
  ok('SET-05: switching between Packets, Mirrors and Settings asks the Worker nothing', workerReqs(mark).length === 0,
    workerReqs(mark).map((r) => r.method + ' ' + r.url));
  // a short window, scrolled: a tab click keeps the place
  await desktop(420);
  await toTab('settings');
  await js('window.scrollTo(0, 150); true');
  const y0 = await js('window.scrollY');
  await click('[data-settab="settings"]');
  const y1 = await js('window.scrollY');
  await click('[data-settab="mirrors"]');
  const y2 = await js('window.scrollY');
  await desktop();
  ok('SET-05: a tab click redraws without moving the scroll position', y0 === 150 && y1 === 150 && y2 === 150, [y0, y1, y2]);
});

/* ---------- SET-06: how many packet slots ---------- */

await section('SET-06 Add a packet / Remove last (and SET-41: they keep the mirror-buzzpoints lock)', async () => {
  await openSet(A.secret);
  const count = () => text('.pkcount');
  const dropOff = () => js(`document.querySelector('#dropslot').disabled`);
  ok('SET-06: a new set has "1 packet", an empty Packet 1, and Remove last off',
    (await count()) === '1 packet' && await dropOff() && JSON.stringify((await slotRows()).map((r) => [r.label, r.file]))
      === JSON.stringify([['Packet 1', 'No packet yet']]), [await count(), await slotRows()]);
  await toTab('settings');
  await clearMsg();
  await click('#mirrorbuzz');
  await waitMsg(/^Mirror buzzpoints are off$/);
  ok('SET-41: unticking "Mirrors may run their own buzzpoints" saves the lock', (await settingsOf(A.secret)).lockMirrorBuzz === true);
  await toTab('packets');
  const slotsTo = async (n, btn) => {
    await click(btn);
    await until(async () => (await settingsOf(A.secret)).rounds === n, 'rounds ' + n);
    await waitJs(`document.querySelectorAll('.pktable tr.slot').length === ${n}`, n + ' slots');
  };
  await slotsTo(2, '#addslot');
  ok('SET-06: "Add a packet" saves 2 and adds an empty "Packet 2" row; the heading reads "2 packets"', (await count()) === '2 packets'
    && JSON.stringify((await slotRows())[1]) === JSON.stringify({ n: 2, label: 'Packet 2', file: 'No packet yet', warn: false,
      pick: 'Upload', preview: false, dl: null, drag: false }), await slotRows());
  ok('SET-06: Remove last is on once there are 2', !(await dropOff()));
  await slotsTo(3, '#addslot');
  await slotsTo(2, '#dropslot');
  ok('SET-06: "Remove last" saves one fewer', (await count()) === '2 packets');
  ok(`SET-41: "Remove last" keeps the mirror-buzzpoints lock ${CH.lock}`, (await settingsOf(A.secret)).lockMirrorBuzz === true,
    await settingsOf(A.secret));
  await slotsTo(1, '#dropslot');
  ok('SET-06: at 1, Remove last is off again', await dropOff() && (await count()) === '1 packet');
  await slotsTo(2, '#addslot');
});

/* ---------- SET-07: staging ---------- */

const pPacket1 = fx('loose/Packet 1.json', A_P1);
const pPacket2 = fx('loose/Packet 2.json', A_P2);
const pRound3 = fx('loose/Round 3.json', A_P3);
const pExtra = fx('loose/extra.json', cleanPacket(404));
const pCopy1 = fx('loose/Packet 1 copy.json', cleanPacket(111));
const enc = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));
async function stage(files, want) {
  await clearMsg();
  await pick('#pickfiles', files);
  await waitMsg(/staged$/);
  await waitJs(`document.querySelectorAll('[data-chip]').length >= ${want || files.length}`, 'the staged chips');
}
const clearStaged = async () => {
  if (await exists('#zipclear')) { await click('#zipclear'); await waitJs(`!document.querySelector('.pkstaged')`, 'the staging row cleared'); }
};

await section('SET-07 staging: Upload packet zip / Upload packets / Clear', async () => {
  await openSet(A.secret);
  const zip = fx('zips/packets.zip', makeZip([
    { name: 'Packets/Packet 1.json', data: enc(A_P1) },
    { name: 'Packets/Packet 2.json', data: enc(A_P2) },
    { name: 'Packets/Round 3.json', data: enc(A_P3) },
    { name: 'Packets/extra.json', data: enc(cleanPacket(404)) },
    { name: 'Packets/notes.txt', data: enc('read me') },
    { name: '__MACOSX/Packets/._Packet 1.json', data: enc('resource fork') },
    { name: 'Packets/.hidden 4.json', data: enc(A_P3) },
  ]));
  await clearMsg();
  await pick('#pickzip', [zip]);
  await waitMsg(/staged$/);
  ok('SET-07: a zip stages only its .json files, not __MACOSX, dotfiles or notes: "4 packets staged"', (await msgText()) === '4 packets staged',
    await msgText());
  ok('SET-07: each chip names its file, and "→ Packet N" when the name has a number', JSON.stringify(await chips()) === JSON.stringify(
    ['Packet 1.json → Packet 1', 'Packet 2.json → Packet 2', 'Round 3.json → Packet 3', 'extra.json']), await chips());
  ok('SET-07: while chips are staged an empty slot reads "No packet yet · drop one here"',
    (await slotRows()).every((r) => r.file === 'No packet yet · drop one here'), await slotRows());
  ok('SET-07: the staging row has "Assign by filename" and "Clear"',
    (await text('#zipauto')) === 'Assign by filename' && (await text('#zipclear')) === 'Clear');
  await clearStaged();
  ok('SET-07: "Clear" empties the staging row', !(await exists('[data-chip]'))
    && (await slotRows()).every((r) => r.file === 'No packet yet'), await slotRows());
  const none = fx('zips/none.zip', makeZip([{ name: 'readme.txt', data: enc('nothing') }, { name: 'scores.csv', data: enc('a,b') }]));
  await clearMsg();
  await pick('#pickzip', [none]);
  await waitMsg(/./);
  ok('SET-07: a zip without packets says "No .json or .docx files in the zip" in red, and stages nothing',
    (await msgText()) === 'No .json or .docx files in the zip' && await msgBad() && !(await exists('[data-chip]')), await msgText());
  const stuck = await js(`({ zip: document.querySelector('#pickzip').disabled, label: document.querySelector('#pickzip').textContent,
    files: document.querySelector('#pickfiles').disabled, add: document.querySelector('#addslot').disabled })`);
  ok('SET-07: after a zip with no packets, "Upload packet zip" is usable again at once, and Upload packets and Add a packet are on',
    !stuck.zip && stuck.label !== 'Reading zip…' && !stuck.files && !stuck.add, stuck);
  await stage([pPacket2]);
  ok('SET-07: "Upload packets" stages loose files the same way: "1 packet staged"', (await msgText()) === '1 packet staged'
    && JSON.stringify(await chips()) === JSON.stringify(['Packet 2.json → Packet 2']), [await msgText(), await chips()]);
  await stage([pRound3, pExtra], 3);
  ok('SET-07: more loose files join the staged ones: "2 packets staged"', (await msgText()) === '2 packets staged'
    && (await chips()).length === 3, await chips());
  await clearStaged();
});

/* ---------- SET-08: Assign by filename ---------- */

await section('SET-08 Assign by filename', async () => {
  await stage([pExtra, pRound3]);
  await clearMsg();
  await click('#zipauto');
  await waitMsg(/./);
  ok('SET-08: with no staged name naming a free slot it says so in red, and uploads nothing',
    (await msgText()) === 'No staged packet has a free round in its name: drag them onto rounds' && await msgBad()
      && (await packetsOf(A.secret)).length === 0, await msgText());
  ok('SET-08: … and the chips stay staged', (await chips()).length === 2);
  await clearStaged();
  await stage([pPacket1, pPacket2, pCopy1, pRound3, pExtra]);
  await observe(`() => ({ btn: (document.querySelector('#zipauto') || {}).textContent || '',
    up: [...document.querySelectorAll('.slot.up')].map((s) => s.dataset.round) })`);
  await clearMsg();
  await click('#zipauto');
  await waitMsg(/assigned/);
  const smp = await samples();
  ok('SET-08: Packet 1 and Packet 2 land; the second "1", the "3" past the last slot and the unnumbered file stay: "2 assigned, 3 left to drag"',
    (await msgText()) === '2 assigned, 3 left to drag' && !(await msgBad()), await msgText());
  ok('SET-08: the button counts up as it uploads ("Uploading packets… 1 of 2", "… 2 of 2")',
    smp.some((s) => s.btn.includes('Uploading packets… 1 of 2')) && smp.some((s) => s.btn.includes('Uploading packets… 2 of 2')),
    smp.map((s) => s.btn));
  const ups = smp.map((s) => s.up.join()).filter(Boolean).filter((x, i, a) => a[i - 1] !== x);
  ok('SET-08: one slot spins at a time, Packet 1 and then Packet 2', ups.join('|') === '1|2' && !smp.some((s) => s.up.length > 1), ups);
  await waitJs(`document.querySelectorAll('[data-chip]').length === 3 && /v1/.test(document.querySelector('.slot[data-round="2"]').textContent)`, 'the slots filled');
  ok('SET-08: the chips not placed stay staged', JSON.stringify(await chips())
    === JSON.stringify(['Packet 1 copy.json → Packet 1', 'Round 3.json → Packet 3', 'extra.json']), await chips());
  const pk = await packetsOf(A.secret);
  ok('SET-08: the Worker has Packet 1.json as packet 1 and Packet 2.json as packet 2, nothing else',
    pk.map((p) => `${p.packet}:${p.version}:${p.name}`).join() === '1:1:Packet 1.json,2:1:Packet 2.json', pk);
  ok('SET-08: the final message replaces each upload\'s own summary (as built: "2 assigned, …")', (await msgText()) === '2 assigned, 3 left to drag');
  // a packet the Worker refuses: over the 16 MB packet cap
  const huge = fx('huge/Huge 4.json', JSON.stringify({ tossups: [{ question: 'kalo '.repeat(3500000), answer: 'a' }] }));
  for (const n of [3, 4]) {
    await click('#addslot');
    await waitJs(`document.querySelectorAll('.pktable tr.slot').length === ${n}`, n + ' slots');
  }
  await stage([huge], 4);
  await clearMsg();
  await click('#zipauto');
  await waitMsg(/^Uploaded/, 'the failed upload', 60000);
  ok('SET-08: a failed upload says which and why, and that the rest are still staged',
    (await msgText()) === 'Uploaded 1 of 2. Huge 4.json: packet too large. The rest are still staged: press Assign by filename to try again.'
      && await msgBad(), await msgText());
  await waitJs(`/Round 3.json/.test(document.querySelector('.slot[data-round="3"]').textContent)`, 'packet 3 in its slot');
  ok('SET-08: the one that failed stays staged with the others', JSON.stringify(await chips())
    === JSON.stringify(['Packet 1 copy.json → Packet 1', 'extra.json', 'Huge 4.json → Packet 4']), await chips());
  ok('SET-08: Round 3.json went up as packet 3; nothing went up as packet 4',
    (await packetsOf(A.secret)).map((p) => `${p.packet}:${p.name}`).join() === '1:Packet 1.json,2:Packet 2.json,3:Round 3.json');
  await clearStaged();
  // Remove last over a slot that holds a packet (inventory: gap)
  await click('#dropslot');
  await until(async () => (await settingsOf(A.secret)).rounds === 3, 'rounds 3');
  await waitJs(`document.querySelectorAll('.pktable tr.slot').length === 3`, '3 slots');
  const enabled = !(await js(`document.querySelector('#dropslot').disabled`));
  await click('#dropslot');
  await until(async () => (await settingsOf(A.secret)).rounds === 2, 'rounds 2 saved');
  await settle(); // the redraw after the save
  knownBug('SET-06: with a packet in the last slot, Remove last stays enabled, saves one fewer and changes nothing on screen (gap: no minSlots on a set)',
    enabled && (await slotRows()).length === 3 && (await text('.pkcount')) === '3 packets', { enabled, rows: (await slotRows()).length });
  await click('#addslot');
  await until(async () => (await settingsOf(A.secret)).rounds === 4, 'rounds 4');
  await waitJs(`document.querySelectorAll('.pktable tr.slot').length === 4`, '4 slots');
});

/* ---------- SET-09, SET-11: dragging a staged packet onto a slot ---------- */

const pFix = fx('v2/P1 fix.json', A_P1v2);
const pFixAgain = fx('v3/P1 fix again.json', A_P1v2);
const pV4 = fx('v4/P1 v4.json', A_P1v4);
const pUnread = fx('bad/Unreadable 3.json', { bonuses: [] });
const pWarn = fx('warn/Warnings 3.json', WARN);
let warnCount = null;

async function dropAndWait(file, slot, re) {
  const name = path.basename(file);
  await stage([file], 1);
  await clearMsg();
  await dragOnto(chipExpr(name), slotExpr(slot));
  const m = await waitMsg(re, 'the upload of ' + name);
  await waitJs(`!document.querySelector('[data-chip]') && document.querySelector('.slot[data-round="${slot}"]').textContent.includes(${q(name)})`,
    name + ' in its slot');
  return m;
}

await section('SET-09/SET-11 drop a staged packet on a slot; what the upload says', async () => {
  const before = dialogs.length;
  const mark = netLog.length;
  const m = await dropAndWait(pFix, 1, /^Packet 1 v2/);
  const want = 'Packet 1 v2: 6 unchanged · 1 reworded (T1) · 1 moved in (T3 from packet 2 T4) · 1 no longer in the set.';
  ok(`SET-11: an upload that rewords T1 and takes T3 from packet 2 says "${want}"`, m === want, m);
  ok('SET-11: … not in red (nothing to check in its parse)', !(await msgBad()));
  ok('SET-09: an occupied slot takes the dropped file as its next version, with no question asked', dialogs.length === before, dialogs.slice(before));
  ok('SET-09: the chip leaves the staging row and the upload\'s summary stays', !(await exists('.pkstaged')) && (await msgText()) === want);
  const sent = workerReqs(mark).map((r) => r.method + ' ' + r.url.slice(BASE.length));
  ok('SET-11: the page uploads it, records its parse count, reads the ledger and saves the question map',
    sent.includes(`POST /s/${A.secret}/packet?packet=1&name=P1%20fix.json`) && sent.includes(`POST /s/${A.secret}/packet/status`)
      && sent.includes(`GET /s/${A.secret}/ledger`) && sent.includes(`POST /s/${A.secret}/qmap`), sent);
  const pk = (await packetsOf(A.secret)).filter((p) => p.packet === 1);
  ok('SET-09: the old version is retired, the new one current, with 0 warnings recorded',
    pk.length === 2 && pk[0].retired === 1 && pk[1].retired === 0 && pk[1].warnings === 0, pk);
  ok('SET-11: the same file again says "all 8 questions unchanged"',
    (await dropAndWait(pFixAgain, 1, /^Packet 1 v3/)) === 'Packet 1 v3: all 8 questions unchanged.', await msgText());
  ok('SET-11: a tossup added at the top and a bonus at the end say what moved down and what is new',
    (await dropAndWait(pV4, 1, /^Packet 1 v4/)) === 'Packet 1 v4: 4 unchanged · 4 in a new position · 2 new (T1, B5).', await msgText());
  const un = await dropAndWait(pUnread, 3, /^Packet 3/);
  ok('SET-11: a packet whose questions cannot be read still uploads, and says so in red',
    un === 'Packet 3 is now v2, but its questions could not be read: review it, and until it can be matched its buzzpoints will not be joined to other versions.'
      && await msgBad(), un);
  const wm = await dropAndWait(pWarn, 3, /^Packet 3 v3/);
  const k = /^Packet 3 v3: .+\. (\d+) things to check in the parse — open Review\.$/.exec(wm);
  ok('SET-11: a packet with parse warnings ends "K things to check in the parse — open Review." in red', !!k && await msgBad(), wm);
  warnCount = k ? Number(k[1]) : null;
  const v3 = (await packetsOf(A.secret)).find((p) => p.packet === 3 && p.version === 3);
  ok('SET-11: the count is saved as the version\'s warnings', v3 && v3.warnings === warnCount, [v3, warnCount]);
  ok('SET-12: a current version with warnings reads "(v3, K warnings)" in its slot',
    (await slotRows())[2].file === `Warnings 3.json (v3, ${warnCount} warnings)`, (await slotRows())[2]);
  // a placed packet does not move on a set
  ok('SET-09: a placed packet has no drag handle on a set', (await slotRows()).every((r) => !r.drag));
  const mark2 = netLog.length;
  await js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'round:1');
    ${slotExpr(2)}.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
  await settle();
  ok('SET-09: dropping a placed packet on another slot does nothing (no request, no Undo)',
    workerReqs(mark2).length === 0 && !(await exists('.pkundo')), workerReqs(mark2));
});

/* ---------- SET-22, SET-27, SET-28, SET-29: Review on packet 1 ---------- */

await section('SET-22/SET-27 the parse review: header, summary, rows, what each question is', async () => {
  // the review panel draws "Reading the packet…" before it has the packet
  const first = await js(`(() => { document.querySelector('[data-review="1:2"]').click();
    const b = document.querySelector('#setbody'); return { back: (b.querySelector('#reviewback') || {}).textContent, text: b.textContent }; })()`);
  ok('SET-22: Review shows "← Packets" and "Reading the packet…" first',
    first.back === '← Packets' && first.text.includes('Reading the packet…'), first);
  await waitJs(`!!document.querySelector('.review')`, 'the review of 1:2');
  let s = await reviewSummary();
  ok('SET-22: it is headed "Packet 1 v2" with the file name', s.header === 'Packet 1 v2' && s.file === 'P1 fix.json', s);
  ok('SET-22: the summary reads "4 tossups, 4 bonuses." and "Nothing looks off to the parser — still read the answerlines and the bonus parts."',
    s.summary.startsWith('4 tossups, 4 bonuses. Nothing looks off to the parser — still read the answerlines and the bonus parts.'), s.summary);
  ok('SET-22: … then the matcher sentence', s.summary.includes('Each question shows what the matcher decided it is; overrule it where it is wrong and the buzzpoints follow.'), s.summary);
  ok('SET-22: a retired version adds "This version is retired — its plays still count…"',
    s.summary.includes('This version is retired — its plays still count, under whatever its questions are.'), s.summary);
  let rows = await reviewRows();
  const ident = (r) => rows.find((x) => x.n === r).ident;
  ok('SET-27: v2 reads T1 "reworded (wording 2)", T2 "unchanged", T3 moved in from packet 2 T4, T4 "unchanged"',
    ident('T1') === 'reworded (wording 2)' && ident('T2') === 'unchanged' && /^moved in from packet 2 T4 \(v1\)$/.test(ident('T3'))
      && ident('T4') === 'unchanged', rows.map((r) => r.n + ' ' + r.ident));
  ok('SET-27: v2\'s bonuses read "unchanged"', ['B1', 'B2', 'B3', 'B4'].every((b) => ident(b) === 'unchanged'));
  const t1 = rows.find((r) => r.n === 'T1');
  ok('SET-27: a tossup row: "T1", its answer in bold, its word count', t1.answer === labelOf(A_P1.tossups[0]) && /\b37 words\b/.test(t1.meta), t1);
  const b1 = rows.find((r) => r.n === 'B1');
  ok('SET-27: a bonus row: "B1", the answers joined by " / ", "3 parts · 10/10/10"',
    b1.answer === A_P1.bonuses[0].answers.map((a) => a.replace(/<\/?b>/g, '')).join(' / ') && b1.meta === '3 parts · 10/10/10', b1);
  const full = await js(`(() => { const d = document.querySelector('.review .qrow details'); d.open = true;
    return [...d.querySelectorAll('.q')].map((x) => x.textContent); })()`);
  ok('SET-27: a row opens to the full question and its ANSWER line',
    full[0] === A_P1v2.tossups[0].question && full[1].startsWith('ANSWER: ' + labelOf(A_P1.tossups[0])), full);
  ok('SET-28: a matched row\'s picker reads "This is…"', rows.every((r) => r.picker === 'This is…'));
  await backToPackets();
  ok('SET-22: "← Packets" goes back to the slots', await exists('.pktable'));
  await openReview('1:4');
  s = await reviewSummary();
  rows = await reviewRows();
  ok('SET-22: the current version has no retired sentence', !s.summary.includes('retired'), s.summary);
  ok('SET-27: v4 reads T1 "new to the set" and T2-T5 "was T1"…"was T4"',
    JSON.stringify(rows.filter((r) => r.n.startsWith('T')).map((r) => r.ident))
      === JSON.stringify(['new to the set', 'was T1', 'was T2', 'was T3', 'was T4']), rows.map((r) => r.ident));
  ok('SET-27: v4 reads B1-B4 "unchanged" and the added B5 "new to the set"',
    JSON.stringify(rows.filter((r) => r.n.startsWith('B')).map((r) => r.ident))
      === JSON.stringify(['unchanged', 'unchanged', 'unchanged', 'unchanged', 'new to the set']), rows.map((r) => r.ident));
});

await section('SET-28 reassign a question in the review', async () => {
  let rows = await reviewRows();
  const t1 = rows.find((r) => r.n === 'T1');
  const p2t1 = `packet 2 T1 — ${labelOf(A_P2.tossups[0])}`;
  const opt = t1.options.find((o) => o[1] === p2t1);
  ok('SET-28: the picker offers "a question new to the set" and the set\'s tossups ("packet P T# — <answer>")',
    t1.options[1][1] === 'a question new to the set' && !!opt && t1.options.every((o) => !/^packet \d+ B/.test(o[1])), t1.options.map((o) => o[1]));
  await observe(`() => document.querySelector('#msg').textContent`);
  await clearMsg();
  await fill('select[data-reassign="t:1"]', opt[0], ['change']);
  await waitMsg(/^T1 reassigned$/);
  await waitJs(`!!document.querySelector('.review') && !/^new to the set$/.test(document.querySelector('.review .qrow .ident').textContent)`, 'the redraw');
  ok('SET-28: choosing one says "Reassigning…" and then "T1 reassigned"', (await samples()).includes('Reassigning…'));
  rows = await reviewRows();
  ok('SET-28: the row now reads where that question came from', /^moved in from packet 2 T1 \(v1\), reworded$/.test(rows[0].ident), rows[0].ident);
  await clearMsg();
  await fill('select[data-reassign="t:1"]', 'new', ['change']);
  await waitMsg(/^T1 reassigned$/);
  await waitJs(`document.querySelector('.review .qrow .ident').textContent === 'new to the set'`, 'T1 new again');
  ok('SET-28: "a question new to the set" makes it new again', true);
});

await section('SET-29 Mark as checked / Unmark', async () => {
  let s = await reviewSummary();
  ok('SET-29: an unchecked version offers "Mark as checked"', s.check && !s.uncheck, s);
  await clearMsg();
  await click('#check');
  await waitMsg(/marked as checked/);
  ok('SET-29: it says "Packet 1 v4 marked as checked"', (await msgText()) === 'Packet 1 v4 marked as checked');
  await waitJs(`!!document.querySelector('#uncheck')`, 'Unmark');
  s = await reviewSummary();
  ok('SET-29: the header shows "Checked <date>" and "Unmark"', s.checked === 'Checked ' + await today() && s.uncheck, s);
  await backToPackets();
  ok('SET-29: the slot stops being red and reads "(v4, checked)"', JSON.stringify((({ file, warn }) => ({ file, warn }))((await slotRows())[0]))
    === JSON.stringify({ file: 'P1 v4.json (v4, checked)', warn: false }), (await slotRows())[0]);
  const v = vrow(await versionRows(), '1:4');
  ok('SET-29: the Versions Parse column shows "Checked <date>" in green', v.parse === 'Checked ' + await today() && v.parseGreen, v);
  await openReview('1:4');
  await clearMsg();
  await click('#uncheck');
  await waitMsg(/^Unmarked$/);
  await waitJs(`!!document.querySelector('#check')`, 'Mark as checked again');
  await backToPackets();
  ok('SET-29: "Unmark" says "Unmarked" and the packet is red again', JSON.stringify((({ file, warn }) => ({ file, warn }))((await slotRows())[0]))
    === JSON.stringify({ file: 'P1 v4.json (v4, unreviewed)', warn: true }), (await slotRows())[0]);
});

/* ---------- SET-10: the row's upload icon ---------- */

const pAgain = fx('again/P2 again.json', A_P2);
const pNoTu = fx('notu/No tossups 4.json', { tossups: [] });
await section('SET-10 the per-row Upload/Replace icon', async () => {
  const rows = await slotRows();
  ok('SET-10: an occupied row\'s icon says "Replace", an empty one\'s "Upload"', rows[1].pick === 'Replace' && rows[3].pick === 'Upload',
    rows.map((r) => r.pick));
  await clearMsg();
  await pick('[data-pickround="2"]', [pAgain]);
  await waitJs(`document.querySelector('.slot[data-round="2"]').textContent.includes('P2 again.json (v2')`, 'packet 2 v2 in its slot');
  const pk = (await packetsOf(A.secret)).filter((p) => p.packet === 2);
  ok('SET-10: Replace uploads the picked file as the packet\'s next version', pk.length === 2 && pk[0].retired === 1
    && pk[1].name === 'P2 again.json' && pk[1].retired === 0, pk);
  knownBug('SET-10: after a row upload the message is only "Packet 2: P2 again.json", not the upload\'s summary (packetsui says it after setadmin\'s upload)',
    (await msgText()) === 'Packet 2: P2 again.json', await msgText());
  await clearMsg();
  await pick('[data-pickround="4"]', [pNoTu]);
  await waitJs(`document.querySelector('.slot[data-round="4"]').textContent.includes('No tossups 4.json (v1')`, 'packet 4 in its slot');
  ok('SET-10: Upload on an empty slot makes its first version', (await packetsOf(A.secret)).some((p) => p.packet === 4 && p.version === 1));
  knownBug('SET-10: the red "its questions could not be read" warning is replaced by a plain "Packet 4: No tossups 4.json"',
    (await msgText()) === 'Packet 4: No tossups 4.json' && !(await msgBad()), [await msgText(), await msgBad()]);
});

/* ---------- SET-12, SET-13, SET-14 ---------- */

await section('SET-12 packet rows: name, review state, red until checked, Download', async () => {
  const rows = await slotRows();
  ok('SET-12: each occupied slot reads "<file> (vN, …)"', JSON.stringify(rows.map((r) => r.file)) === JSON.stringify([
    'P1 v4.json (v4, unreviewed)', 'P2 again.json (v2, unreviewed)', `Warnings 3.json (v3, ${warnCount} warnings)`, 'No tossups 4.json (v1, unreviewed)']),
  rows.map((r) => r.file));
  ok('SET-12: every slot not yet checked is red', rows.every((r) => r.warn));
  ok('SET-12: the download icon points at /s/<secret>/file?packet=&v=', rows[1].dl === `${BASE}/s/${A.secret}/file?packet=2&v=2`, rows[1].dl);
  const got = await download(() => click('.slot[data-round="2"] a.icon[download]'), 'packet 2');
  ok('SET-12: Download saves the file under its uploaded name, as uploaded (decrypted)',
    got.name === 'P2 again.json' && Buffer.compare(got.bytes, readFileSync(pAgain)) === 0, got.name);
});

await section('SET-13 the packet preview dialog', async () => {
  const first = await js(`(() => { document.querySelector('[data-preview="2"]').click(); const v = document.querySelector('.pkview');
    return v && { role: v.getAttribute('role'), label: v.getAttribute('aria-label'), name: v.querySelector('.pkviewname').textContent,
      loading: v.querySelector('.pkpage').textContent.trim() }; })()`);
  // on a set the slot's name carries its version and review state, and the dialog shows that name
  const slotName = 'P2 again.json (v2, unreviewed)';
  ok(`SET-13: the eye icon opens a dialog named "Packet 2 · ${slotName}", "Loading the packet" first`, first && first.role === 'dialog'
    && first.label === slotName && first.name === 'Packet 2 · ' + slotName && first.loading === 'Loading the packet', first);
  await waitJs(`!!document.querySelector('.pkview .pktitle')`, 'the packet pages');
  const pv = await js(`(() => { const v = document.querySelector('.pkview');
    return { title: v.querySelector('.pktitle').textContent, counts: v.querySelector('.pkcounts').textContent,
      pairs: [...v.querySelectorAll('.pkpair')].map((p) => [...p.querySelectorAll('.pkno')].map((n) => n.textContent)),
      answers: [...v.querySelectorAll('.pka')].map((a) => a.textContent), meta: [...v.querySelectorAll('.pkm')].map((m) => m.textContent),
      firstQ: v.querySelector('.pkpair .pkq').textContent, dl: v.querySelector('.pkviewbar a.icon[download]').getAttribute('href') }; })()`);
  ok('SET-13: it shows the name and "4 tossups, 4 bonuses"', pv.title === slotName && pv.counts === '4 tossups, 4 bonuses', pv);
  ok('SET-13: pages go tossup 1, bonus 1, tossup 2, … with part markers ([10e]/[10m]/[10h] where the packet has them)',
    JSON.stringify(pv.pairs[0]) === JSON.stringify(['1.', 'B1.', '[10e]', '[10m]', '[10h]'])
      && JSON.stringify(pv.pairs[1]) === JSON.stringify(['2.', 'B2.', '[10]', '[10]', '[10]']) && pv.pairs.length === 4, pv.pairs);
  ok('SET-13: the question text is there in full', pv.firstQ === '1. ' + A_P2.tossups[0].question, pv.firstQ);
  ok('SET-13: each tossup and each part has its ANSWER line', pv.answers.length === 16 && pv.answers.every((a) => a.startsWith('ANSWER: '))
    && pv.answers[0] === 'ANSWER: ' + labelOf(A_P2.tossups[0]) + ' ' + A_P2.tossups[0].answer.replace(/^.*<\/b> /, ''), pv.answers.slice(0, 2));
  ok('SET-13: metadata lines show as <…>', JSON.stringify(pv.meta) === JSON.stringify(A_P2.tossups.map((t) => `<${t.metadata}>`)), pv.meta);
  ok('SET-13: the dialog has a Download icon for the same file', pv.dl === `${BASE}/s/${A.secret}/file?packet=2&v=2`, pv.dl);
  await click('.pkview [data-close]');
  ok('SET-13: the X closes it', !(await exists('.pkview')));
  const reopen = async () => { await click('[data-preview="2"]'); await waitJs(`!!document.querySelector('.pkview .pktitle')`, 'the preview'); };
  await reopen();
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitJs(`!document.querySelector('.pkview')`, 'Escape to close the preview');
  ok('SET-13: Escape closes it', true);
  await reopen();
  await click('.pkview .pkpage');
  ok('SET-13: a click on the page itself leaves it open', await exists('.pkview'));
  await click('.pkview');
  ok('SET-13: a click on the backdrop closes it', !(await exists('.pkview')));
});

await section('SET-14 the note under the slots (no mirrors)', async () => {
  const note = await js(`(() => { const d = [...document.querySelectorAll('#setbody div.muted')].find((x) => x.textContent.includes('Packets are the set'));
    return d ? { text: d.textContent.replace(/\\s+/g, ' ').trim(), bold: !!d.querySelector('b') } : null; })()`);
  ok('SET-14: the note explains numbering, replacing by dropping, matching and red-until-checked', note
    && note.text.startsWith('Packets are the set\'s own numbering: a mirror starts with packet N on round N')
    && note.text.includes('Drop a packet on an occupied slot to replace it')
    && note.text.includes('Every upload is matched against the rest of the set')
    && note.text.includes('A packet stays red until a person has reviewed how it parsed and marked it checked'), note);
  ok('SET-14: with no mirror running it names none ("A running mirror whose rooms…")', note && !note.bold
    && note.text.includes('A running mirror whose rooms have not opened the packet yet switches to the new version'), note);
});

/* ---------- SET-15, SET-16, SET-19, SET-20, SET-23..26: Versions and the rest of Review ---------- */

const A_P5 = cleanPacket(606);
const A_P6 = cleanPacket(707);
await section('SET-15 the Versions table', async () => {
  await uploadApi(A.secret, 3, 'Missing answer 3.json', JSON.stringify({ tossups: [{ question: 'x' }] }));
  await uploadApi(A.secret, 3, 'No categories 3.json', JSON.stringify(NOCAT));
  await uploadApi(A.secret, 5, 'API5.json', JSON.stringify(A_P5));
  await uploadApi(A.secret, 6, 'API6.json', JSON.stringify(A_P6));
  await openSet(A.secret);
  const rows = await versionRows();
  const pk = await packetsOf(A.secret);
  ok('SET-15: one row per version, retired ones included', rows && rows.length === pk.length && rows.length === 14, rows && rows.map((r) => r.pv));
  const cur = rows.filter((r) => r.state === 'Current').map((r) => r.pv);
  ok('SET-15: the newest of each packet reads "Current" in green, the rest "Retired" and muted',
    cur.join() === '1:4,2:2,3:5,4:1,5:1,6:1' && rows.every((r) => (r.state === 'Current') === (r.green && !r.muted)
      && (r.state === 'Retired') === r.muted), rows.map((r) => [r.pv, r.state, r.muted]));
  const r11 = vrow(rows, '1:1');
  ok('SET-15: the file is a download link to that version', r11.file === 'Packet 1.json' && r11.dl
    && r11.href === `${BASE}/s/${A.secret}/file?packet=1&v=1`, r11);
  await check('SET-15: the upload time', async () => js(`(${q(rows.map((r) => r.uploaded))}).join() === ${q(pk)}.map((p) => new Date(p.created).toLocaleString()).join()`));
  ok('SET-15: Questions: "8 questions" for a first version, and what moved against the one before',
    vrow(rows, '1:1').questions === '8 questions' && vrow(rows, '1:2').questions === '8 questions, 1 reworded, 1 not in v1, 1 of v1 gone'
      && vrow(rows, '1:3').questions === '8 questions' && vrow(rows, '1:4').questions === '10 questions, 2 not in v3',
    ['1:1', '1:2', '1:3', '1:4'].map((x) => vrow(rows, x).questions));
  ok('SET-15: a version with no question map reads "Not matched" in red, with a Match button',
    ['3:2', '3:4', '3:5', '4:1', '5:1', '6:1'].every((x) => vrow(rows, x).questions === 'Not matched Match' && vrow(rows, x).notMatchedRed && vrow(rows, x).match),
    rows.map((r) => [r.pv, r.questions]));
  ok('SET-15: Parse: "No warnings", "K warnings" in red, "Unreviewed"', vrow(rows, '1:4').parse === 'No warnings'
    && vrow(rows, '3:3').parse === `${warnCount} warnings` && vrow(rows, '3:3').parseRed && vrow(rows, '5:1').parse === 'Unreviewed',
  ['1:4', '3:3', '5:1'].map((x) => vrow(rows, x).parse));
  ok('SET-15: every row has a Review button', rows.every((r) => r.review));
  // one warning is "1 warning", in the slot and in the Parse column
  d1(`UPDATE set_packets SET warnings = 1 WHERE set_id = ${A.id} AND packet = 6 AND version = 1`);
  await openSet(A.secret);
  const one = { slot: ((await slotRows()).find((r) => r.n === 6) || {}).file, parse: vrow(await versionRows(), '6:1').parse };
  d1(`UPDATE set_packets SET warnings = NULL WHERE set_id = ${A.id} AND packet = 6 AND version = 1`);
  await openSet(A.secret);
  ok('SET-12/SET-15: a version with one warning reads "(v1, 1 warning)" in its slot and "1 warning" under Parse',
    one.slot === 'API6.json (v1, 1 warning)' && one.parse === '1 warning', one);
});

await section('SET-23/SET-24 parse warnings in the review', async () => {
  await openReview('3:3');
  const s = await reviewSummary();
  const rows = await reviewRows();
  ok('SET-22: the summary says "K things look off — warnings are hints, not verdicts: read the question."',
    s.summary.startsWith(`10 tossups, 12 bonuses. ${warnCount} things look off — warnings are hints, not verdicts: read the question.`), s.summary);
  for (const [key, wants] of Object.entries(WARN_EXPECTED)) {
    const r = rows.find((x) => x.n === key);
    const has = r && wants.every((w) => r.warns.some((x) => (w instanceof RegExp ? w.test(x) : x === w)));
    const tag = MODAQ_KEYS.has(key) ? ' ' + CH.modaq : '';
    ok(`SET-${MODAQ_KEYS.has(key) ? 24 : 23}: ${key} warns ${wants.map(String).join(' + ')}${tag}`, !!has, r && r.warns);
  }
  ok('SET-23: packet-level warnings show in red above the list',
    WARN_PACKET_LEVEL.every((w) => s.packetWarns.includes(w)), s.packetWarns);
  const total = rows.reduce((n, r) => n + r.warns.length, 0) + s.packetWarns.length;
  ok('SET-23: the count saved for the version is the number of warnings shown', total === warnCount, [total, warnCount]);
  ok('SET-27: an empty answerline reads "(no answerline)" in red; an empty bonus answer "?" in red',
    rows.find((r) => r.n === 'T4').answer === '(no answerline)' && rows.find((r) => r.n === 'T4').answerRed
      && rows.find((r) => r.n === 'B6').answer.replace(/\s/g, '') === 'Ga/?/Gc', [rows.find((r) => r.n === 'T4'), rows.find((r) => r.n === 'B6').answer]);
  ok('SET-27: a tossup with one power mark reads "· power"', / · power$/.test(rows.find((r) => r.n === 'T10').meta), rows.find((r) => r.n === 'T10').meta);
  await backToPackets();
  await openReview('3:5');
  const n = await reviewSummary();
  ok('SET-23: a packet with no bonuses and no categories says both',
    n.packetWarns.includes('no bonuses') && n.packetWarns.includes('no category data — this packet contributes nothing to category stats'), n.packetWarns);
  ok('SET-22: an unmatched version says in bold red "This version has not been matched"', n.notMatchedRed
    && n.summary.includes('This version has not been matched: its buzzpoints stand alone until it is (Match, under Versions).'), n.summary);
  const nr = await reviewRows();
  ok('SET-27: its rows read "not matched" in red, and the picker "Assign…"', nr.every((r) => r.ident === 'not matched' && r.identRed && r.picker === 'Assign…'),
    nr.map((r) => [r.ident, r.picker]));
  await backToPackets();
});

await section('SET-25 a packet that cannot be read, in the review', async () => {
  for (const [pv, reason] of [['3:2', 'packet JSON has no tossups array'], ['4:1', 'packet has no tossups'],
    ['3:4', 'tossup 1 is missing question or answer text']]) {
    await openReview(pv);
    const t = await text('#setbody');
    ok(`SET-25: ${pv} says "This packet could not be read as questions: ${reason}. …"`, t.includes(`This packet could not be read as questions: ${reason}.`)
      && t.includes('A packet MODAQ cannot read is one no mirror can play — replace it.'), t);
    await backToPackets();
    ok(`SET-25: the back link still works (${pv})`, true);
  }
});

await section('SET-16 Match (success)', async () => {
  await observe(`() => document.querySelector('#msg').textContent`);
  await clearMsg();
  await click('[data-match="5:1"]');
  await waitMsg(/^Packet 5 v1/);
  ok('SET-16: Match says "Matching…" and then "Packet 5 v1: all 8 questions new."',
    (await samples()).includes('Matching…') && (await msgText()) === 'Packet 5 v1: all 8 questions new.', await msgText());
  await waitJs(`!document.querySelector('[data-match="5:1"]')`, 'the refreshed Versions table');
  ok('SET-16: the row then shows its question note instead of "Not matched"', vrow(await versionRows(), '5:1').questions === '8 questions');
});

await section('SET-19 two editors at once: a match that loses the ledger race tries again', async () => {
  await S('Fetch.enable', { patterns: [{ urlPattern: `*/s/${A.secret}/qmap*`, requestStage: 'Request' }] });
  pausedQmap.length = 0;
  try {
    await clearMsg();
    await click('[data-match="6:1"]');
    await until(() => pausedQmap.length === 1, 'the first question-map save');
    // meanwhile, another editor saves a question map over the same ledger
    const [etag, ...rest] = (await ledgerOf(A.secret)).split('\n');
    const ledger = JSON.parse(rest.join('\n'));
    ledger.seq += 1;
    ledger.questions[String(ledger.seq)] = { kind: 't', revs: [{ key: 'other editor wording', answer: 'other editor', label: 'Other Editor' }], at: null };
    const q5 = (await api(`/s/${A.secret}/cats`)).packets['5']['1'].q;
    await api(`/s/${A.secret}/qmap`, { method: 'POST', body: JSON.stringify({ packet: 5, v: 1, q: q5, etag }) + '\n' + JSON.stringify(ledger) });
    await S('Fetch.continueRequest', { requestId: pausedQmap[0].requestId });
    await until(() => pausedQmap.length === 2, 'the save tried again');
    await S('Fetch.continueRequest', { requestId: pausedQmap[1].requestId });
    await waitMsg(/^Packet 6 v1/);
  } finally { await S('Fetch.disable'); }
  ok('SET-19: the page saved twice and says "Packet 6 v1: all 8 questions new." with no error',
    pausedQmap.length === 2 && (await msgText()) === 'Packet 6 v1: all 8 questions new.' && !(await msgBad()), await msgText());
  const after = JSON.parse((await ledgerOf(A.secret)).split('\n').slice(1).join('\n'));
  const labels = Object.values(after.questions).map((x) => x.revs[x.revs.length - 1].label);
  ok('SET-19: the retry built on the other editor\'s ledger: both their question and packet 6\'s are in it',
    labels.includes('Other Editor') && labels.includes(labelOf(A_P6.tossups[0])), labels.length);
});

await section('SET-20 remove a packet from the set', async () => {
  await waitJs(`!!document.querySelector('.pktable')`, 'the slots');
  knownBug('SET-20: the "Remove packet" select and "Remove from set" button are not drawn (setadmin.js inserts them after .chiprow, which is gone)',
    !(await exists('#rmbtn')) && !(await exists('#rmround')));
  // the removal itself, made through the Worker, shows on the page
  await api(`/s/${A.secret}/packet?packet=6`, { method: 'DELETE' });
  await openSet(A.secret);
  ok('SET-20: a packet removed (through the Worker) leaves the slots, and its versions read "Retired"',
    !(await exists('.slot[data-round="6"]')) && vrow(await versionRows(), '6:1').state === 'Retired', await slotRows());
});

/* ---------- SET-30, SET-31: the set's tiebreaker pool ---------- */

const tb1 = fx('tb/tb1.json', { tossups: [{ question: 'Tiebreaker one text here.', answer: 'Treaty of Ghent' },
  { question: 'Tiebreaker two text here.', answer: 'Peace of Utrecht' }],
bonuses: [{ leadin: 'Tiebreaker bonus.', parts: ['p1', 'p2', 'p3'], answers: ['x', 'y', 'z'], values: [10, 10, 10] }] });
const tb2 = fx('tb/tb2.json', { tossups: [{ question: 'Spare tossup.', answer: 'Spare One' }] });
const tb3 = fx('tb/tb3.json', { bonuses: [{ leadin: 'Spare bonus.', parts: ['a', 'b', 'c'], answers: ['d', 'e', 'f'], values: [10, 10, 10] }] });
const tb4 = fx('tb/tb4.json', { tossups: [{ question: 'Fourth spare.', answer: 'Spare Four' }] });
const tbBad = fx('tb/bad.json', { foo: 1 });
const tbTxt = fx('tb/notes.txt', 'not a packet');
const tb5 = fx('tb/tb5.json', { tossups: [{ question: 'Chip spare.', answer: 'Spare Five' }] });
const tbRows = () => js(`(() => { const sec = [...document.querySelectorAll('h2')].find((h) => /tiebreakers/i.test(h.textContent));
  let el = sec; const out = { heads: null, rows: [], none: false };
  while ((el = el.nextElementSibling)) {
    if (el.classList.contains('tablewrap')) { const trs = [...el.querySelectorAll('tr')];
      out.heads = [...trs[0].querySelectorAll('th')].map((t) => t.textContent);
      out.rows = trs.slice(1).map((tr) => ({ id: tr.querySelector('td').textContent, cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\\s+/g, ' ').trim()),
        remove: !!tr.querySelector('[data-tbremove]') })); }
    if (el.classList.contains('muted') && el.textContent === 'No tiebreaker questions yet') out.none = true;
  } return out; })()`);
await section('SET-30/SET-31 the set\'s backup questions and tiebreakers', async () => {
  ok('SET-31: with no questions it reads "No tiebreaker questions yet", with no Delete pool', (await tbRows()).none && !(await exists('#tbclear')));
  ok('SET-30: the section is "Backup questions + tiebreakers"', await js(`[...document.querySelectorAll('#setbody h2')].some((h) => h.textContent === 'Backup questions + tiebreakers')`));
  await clearMsg();
  await pick('#picktb', [tb1]);
  await waitMsg(/split into/);
  ok('SET-30: one file says "tb1.json split into 2 tossups + 1 bonus"', (await msgText()) === 'tb1.json split into 2 tossups + 1 bonus');
  await waitJs(`!!document.querySelector('#tbclear')`, 'the pool table');
  let t = await tbRows();
  ok('SET-31: the table has Question, Kind and Answer, a Remove column, and no Status on a set',
    JSON.stringify(t.heads) === JSON.stringify(['Question', 'Kind', 'Answer', '']), t.heads);
  ok('SET-31: rows read TU1, TU2, B1 with "<answer> (<file>)"', JSON.stringify(t.rows.map((r) => r.cells.slice(0, 3))) === JSON.stringify([
    ['TU1', 'Tossup', 'Treaty of Ghent (tb1.json)'], ['TU2', 'Tossup', 'Peace of Utrecht (tb1.json)'], ['B1', 'Bonus', 'x / y / z (tb1.json)']]),
  t.rows);
  await clearMsg();
  await pick('#picktb', [tb2, tb3]);
  await waitMsg(/files were added/);
  ok('SET-30: several files in the order picked: "2 files were added to the pool."', (await msgText()) === '2 files were added to the pool.');
  await waitJs(`document.querySelectorAll('[data-tbremove]').length === 5`, 'five questions');
  await clearMsg();
  await pick('#picktb', [tb4, tbTxt, tbBad]);
  await waitMsg(/files were added/);
  ok('SET-30: some unreadable: "1 of 3 files were added. These could not be read: notes.txt, bad.json." in red',
    (await msgText()) === '1 of 3 files were added. These could not be read: notes.txt, bad.json.' && await msgBad(), await msgText());
  await clearMsg();
  await pick('#picktb', [tbTxt]);
  await waitMsg(/./);
  ok('SET-30: another kind of file says "Tiebreaker packets need to be .json or .docx files."',
    (await msgText()) === 'Tiebreaker packets need to be .json or .docx files.' && await msgBad(), await msgText());
  await waitJs(`document.querySelectorAll('[data-tbremove]').length === 6`, 'six questions');
  await stage([tb5]);
  await clearMsg();
  await dragOnto(chipExpr('tb5.json'), `document.querySelector('#tbdrop')`);
  await waitMsg(/^tb5.json split/);
  ok('SET-30: a staged .json chip dropped on "Or drop a staged .json packet chip here" is split the same way',
    (await msgText()) === 'tb5.json split into 1 tossup + 0 bonuses');
  await waitJs(`document.querySelectorAll('[data-tbremove]').length === 7 && !document.querySelector('[data-chip]')`, 'the chip used up');
  ok('SET-30: … and the chip leaves the staging row', true);
  dialogAccept = false;
  let n = dialogs.length;
  await click('[data-tbremove="TU1"]');
  await until(() => dialogs.length > n, 'the remove question');
  dialogAccept = true;
  await settle();
  ok('SET-31: Remove asks "Remove TU1 from the pool?"; Cancel keeps it', dialogs[n] === 'Remove TU1 from the pool?'
    && (await tbRows()).rows.some((r) => r.id === 'TU1'), dialogs.slice(n));
  await clearMsg();
  await click('[data-tbremove="TU1"]');
  await waitMsg(/removed from the pool/);
  await waitJs(`!document.querySelector('[data-tbremove="TU1"]')`, 'TU1 gone');
  ok('SET-31: OK says "TU1 was removed from the pool." and the row goes', (await msgText()) === 'TU1 was removed from the pool.');
  n = dialogs.length;
  dialogAccept = false;
  await click('#tbclear');
  await until(() => dialogs.length > n, 'the delete question');
  dialogAccept = true;
  await settle();
  ok('SET-31: Delete pool asks "Delete the tiebreaker pool?"; Cancel keeps it', dialogs[n] === 'Delete the tiebreaker pool?' && (await tbRows()).rows.length === 6);
  await click('#tbclear');
  await waitJs(`!document.querySelector('#tbclear')`, 'the pool emptied');
  ok('SET-31: OK empties it: "No tiebreaker questions yet"', (await tbRows()).none);
  await clearMsg();
  await pick('#picktb', [tb2]);
  await waitMsg(/split into/);
  await waitJs(`!!document.querySelector('#tbclear')`, 'the pool table again');
  t = await tbRows();
  ok('SET-31: question ids keep counting after Delete pool (no second TU1)', t.rows.length === 1 && t.rows[0].id === 'TU6', t.rows.map((r) => r.id));
});

/* ---------- SET-39 .. SET-42: Settings ---------- */

await section('SET-39 the public set page switch (and SET-05: the header link and Copy)', async () => {
  await toTab('settings');
  const note = await js(`[...document.querySelectorAll('#setbody div.muted')].map((d) => d.textContent.replace(/\\s+/g, ' ')).find((t) => t.includes('Combined stats'))`);
  ok('SET-39: the note says mirrors whose own page is off are included', (note || '').includes('including mirrors whose own page their director has left off'), note);
  await clearMsg();
  await click('#pub');
  await waitMsg(/^Set page is public$/);
  await waitJs(`!!document.querySelector('#copypub')`, 'the header link');
  const link = `${PAGES}/s.html?s=${A.slug}`;
  const shown = await js(`(() => { const s = document.querySelector('#setbody a.mono'); const h = document.querySelector('#view > .row a.mono');
    return { s: s && [s.getAttribute('href'), s.target], h: h && [h.getAttribute('href'), h.target, h.textContent] }; })()`);
  ok('SET-39: ticking it says "Set page is public" and shows the s.html link here', shown.s && shown.s[0] === link && shown.s[1] === '_blank', shown);
  ok('SET-05: the header shows the public link (new tab) and a Copy button', shown.h && shown.h[0] === link && shown.h[1] === '_blank' && shown.h[2] === link, shown);
  await clearMsg();
  await click('#copypub');
  await waitMsg(/^Copied public link$/);
  ok('SET-05: Copy says "Copied public link" and puts the link on the clipboard', (await clipboard()) === link);
  await open('s.html', { s: A.slug });
  await waitJs(`document.querySelector('#sname').textContent === 'Sets UI Main'`, 'the public set page');
  ok('SET-39: s.html now serves the set', (await text('#sites')) === '0 sites', await text('#sites'));
  await openSet(A.secret, 'settings');
  await clearMsg();
  await click('#pub');
  await waitMsg(/^Set page is private$/);
  await waitJs(`document.querySelector('#view > .row').textContent.includes('Public page off')`, 'the header');
  ok('SET-39: unticking says "Set page is private" and the header reads "Public page off"', !(await exists('#copypub')));
  await open('s.html', { s: A.slug });
  await waitJs(`/not found/.test(document.querySelector('.setmsg').textContent)`, 'the closed public page');
  ok('SET-39: s.html then says "not found"', (await text('.setmsg')) === 'not found' && await js(`document.querySelector('.setmsg').classList.contains('bad')`));
});

await section('SET-40 the set\'s buzzpoints password (and SET-41: the lock survives it)', async () => {
  await openSet(A.secret, 'settings');
  const opts = await js(`[...document.querySelector('#buzzmode').options].map((o) => o.textContent)`);
  ok('SET-40: Buzzpoints offers "Off" and "On (password)"', opts.join('|') === 'Off|On (password)', opts);
  ok('SET-40: with buzzpoints off the password field is hidden', await js(`document.querySelector('#buzzpw').hidden && document.querySelector('#buzzset').hidden`));
  await clearMsg();
  await fill('#buzzmode', 'password', ['change']);
  await waitMsg(/^Set a password$/);
  ok('SET-40: choosing On with no password stored shows the field and "Set password", and says "Set a password"',
    await js(`!document.querySelector('#buzzpw').hidden && !document.querySelector('#buzzset').hidden`));
  await clearMsg();
  await click('#buzzset');
  await waitMsg(/./);
  ok('SET-40: Set password with nothing typed says "Enter a password" in red', (await msgText()) === 'Enter a password' && await msgBad());
  await fill('#buzzpw', 'pw-sets-ui');
  await observe(`() => document.querySelector('#msg').textContent`);
  await clearMsg();
  await click('#buzzset');
  await waitMsg(/^Buzzpoints password set$/, 'the password set', 30000);
  ok('SET-40: it says "Setting password…" and then "Buzzpoints password set"', (await samples()).includes('Setting password…'));
  await waitJs(`[...document.querySelectorAll('#setbody .pill')].some((p) => p.textContent === 'Password set')`, 'the Password set pill');
  let st = await settingsOf(A.secret);
  ok('SET-40: a "Password set" pill appears; the Worker holds the hash, not the password', st.buzz && st.buzz.mode === 'password'
    && typeof st.buzz.hash === 'string' && !JSON.stringify(st).includes('pw-sets-ui'), st.buzz);
  ok(`SET-41: setting the password keeps the mirror-buzzpoints lock ${CH.lock}`, st.lockMirrorBuzz === true, st);
  const cred = st.buzz;
  await clearMsg();
  await fill('#buzzmode', '', ['change']);
  await waitMsg(/^Buzzpoints off$/);
  st = await settingsOf(A.secret);
  ok('SET-40: Off says "Buzzpoints off" and drops the stored password', st.buzz === undefined, st);
  ok(`SET-41: turning buzzpoints off keeps the mirror-buzzpoints lock ${CH.lock}`, st.lockMirrorBuzz === true, st);
  // a password kept from before with buzzpoints off (mode 'off'): On turns it back on as it is
  await api('/s/' + A.secret, { method: 'POST', json: { settings: { ...st, buzz: { ...cred, mode: 'off' } } } });
  await openSet(A.secret, 'settings');
  await clearMsg();
  await fill('#buzzmode', 'password', ['change']);
  await waitMsg(/^Buzzpoints on$/);
  st = await settingsOf(A.secret);
  ok('SET-40: On while a password is stored says "Buzzpoints on" and keeps it', st.buzz.mode === 'password' && st.buzz.hash === cred.hash, st.buzz);
  const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  ok('SET-40: … whole, with its stretching (salt and iterations) as it was, so the password still works',
    sorted(st.buzz) === sorted({ ...cred, mode: 'password' }), [Object.keys(cred), Object.keys(st.buzz)]);
});

await section('SET-42 "Mirrors start with": the reader game format (and SET-41: the lock survives it)', async () => {
  await openSet(A.secret, 'settings');
  await clearMsg();
  await fill('#gformat', 'pace', ['change']);
  await waitMsg(/^Game format saved$/);
  let st = await settingsOf(A.secret);
  ok('SET-42: picking a preset says "Game format saved" and saves it', st.gameFormat === 'pace', st);
  ok(`SET-41: a format change keeps the lock and the packet count ${CH.lock}`, st.lockMirrorBuzz === true && st.rounds === 4, st);
  ok('SET-42: the customize panel starts closed', await js(`document.querySelector('#fmtpanel').hidden`));
  await click('#fmtedit');
  ok('SET-42: "Customize MODAQ settings" opens it, with Tossups, Neg, Powers, Overtime tossups, Paired bonuses, Bouncebacks, Overtime bonuses, Pronunciation marks',
    await js(`!document.querySelector('#fmtpanel').hidden && ['fmttossups', 'fmtneg', 'fmtpowers', 'fmtot', 'fmtpaired', 'fmtbounce', 'fmtotbonus', 'fmtpron1', 'fmtpron2']
      .every((id) => !!document.getElementById(id))`));
  await toTab('mirrors');
  await toTab('settings');
  ok('SET-42: the panel stays open across a redraw', await js(`!document.querySelector('#fmtpanel').hidden`));
  await fill('#fmttossups', '21');
  await clearMsg();
  await click('#fmtsave');
  await waitMsg(/^Game format saved$/);
  await waitJs(`[...document.querySelectorAll('#setbody .pill')].some((p) => p.textContent === 'Custom')`, 'the Custom pill');
  st = await settingsOf(A.secret);
  ok('SET-42: "Save format" stores the change as an override and shows a "Custom" pill',
    st.formatOverrides && st.formatOverrides.regulationTossupCount === 21 && st.gameFormat === 'pace', st);
  ok(`SET-41: … and keeps the lock ${CH.lock}`, st.lockMirrorBuzz === true);
  await fill('#fmtpron1', '(');
  await fill('#fmtpron2', '');
  await clearMsg();
  await click('#fmtsave');
  await waitMsg(/./);
  ok('SET-42: one pronunciation mark alone says "Pronunciation marks: fill both or neither" in red',
    (await msgText()) === 'Pronunciation marks: fill both or neither' && await msgBad(), await msgText());
  await fill('#fmtpron1', '');
  await fill('#fmttossups', '0');
  await clearMsg();
  await click('#fmtsave');
  await waitMsg(/./);
  ok('SET-42: a value out of range says "Bad value: …" in red', /^Bad value: regulationTossupCount$/.test(await msgText()) && await msgBad(), await msgText());
  await clearMsg();
  await click('#fmtreset');
  await waitMsg(/^Game format reset$/);
  await waitJs(`![...document.querySelectorAll('#setbody .pill')].some((p) => p.textContent === 'Custom')`, 'the Custom pill gone');
  st = await settingsOf(A.secret);
  ok('SET-42: "Reset to preset" says "Game format reset" and drops the overrides', st.formatOverrides === undefined && st.gameFormat === 'pace', st);
  // Powers that cannot be read
  const errsBefore = pageErrors.length;
  await fill('#fmtpowers', 'garbage');
  await clearMsg();
  await click('#fmtsave');
  await settle();
  const said = await msgText();
  const threw = pageErrors.slice(errsBefore).some((e) => /powers: use marker=points/.test(e));
  const st2 = await settingsOf(A.secret);
  ok('SET-42: Powers that cannot be read ("garbage") say "powers: use marker=points, like (*)=15" in red, throw nothing and save nothing',
    !threw && said === 'powers: use marker=points, like (*)=15' && await msgBad() && JSON.stringify(st2) === JSON.stringify(st),
    { said, errors: pageErrors.slice(errsBefore), st2 });
});

/* ---------- the set link: New set link, and a stale page ---------- */

await section('Settings: New set link (rotation); a page left on the old link', async () => {
  await openSet(A.secret, 'settings');
  ok('Rotation: Settings says "Open until <date>"', (await text('#setbody')).includes('Open until ' + await js(`new Date(${A.closes}).toLocaleDateString()`)));
  let n = dialogs.length;
  dialogAccept = false;
  const mark = netLog.length;
  await click('#rotate');
  await until(() => dialogs.length > n, 'the rotate question');
  dialogAccept = true;
  await settle();
  ok('Rotation: "New set link" asks first; Cancel changes nothing', dialogs[n] === 'Make a new set link? The current one stops working for everyone who has it. '
    + 'Invites and running mirrors are not affected.' && !workerReqs(mark).some((r) => r.url.endsWith('/rotate')), dialogs.slice(n));
  n = dialogs.length;
  await click('#rotate');
  await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the new link\'s modal');
  const link = await js(`document.querySelector('#modallink').textContent`);
  const m = /\/set\.html\?a=([a-z0-9]+)$/.exec(link);
  ok('Rotation: OK shows the new link in "Save this link"', !!m && m[1] !== A.secret && link === `${PAGES}/set.html?a=${m[1]}`, link);
  const old = A.secret;
  A.secret = m[1];
  const early = await storedLinks();
  ok('Rotation: while "Save this link" is still open, this device already keeps the set under the new link (the old one no longer works)',
    early.filter((e) => e.slug === A.slug).length === 1 && early.find((e) => e.slug === A.slug).secret === A.secret,
    early.filter((e) => e.slug === A.slug).map((e) => e.secret === A.secret ? 'new' : 'old'));
  await click('#modalok');
  await waitJs(`location.search === '?a=${A.secret}' && !!document.querySelector('[data-settab]')`, 'the dashboard on the new link');
  ok('Rotation: "Saved it" opens the dashboard on the new link', true);
  const list = await storedLinks();
  ok('Rotation: this device keeps the set once, under the new link', list.filter((e) => e.slug === A.slug).length === 1
    && list.find((e) => e.slug === A.slug).secret === A.secret, list);
  await open('set.html', { a: old });
  await waitMsg(/./);
  ok('SET-04: the old link now says "bad link"', (await msgText()) === 'bad link' && await msgBad());
  // another editor makes a new link while this page is open: the preview can't load
  await openSet(A.secret);
  const again = await api(`/s/${A.secret}/rotate`, { method: 'POST' });
  await clearMsg();
  await click('[data-preview="2"]');
  await waitJs(`!!document.querySelector('.pkview .bad')`, 'the preview error');
  ok('SET-13: a preview that cannot load says why inside the dialog, and in red under the header',
    (await text('.pkview .bad')) === 'could not load the packet (404)' && (await msgText()) === 'could not load the packet (404)' && await msgBad(),
    [await text('.pkview .bad'), await msgText()]);
  await click('.pkview [data-close]');
  A.secret = again.admin_secret;
});

/* ---------- set B: a ledger and a category map that can't be read ---------- */

const B1 = cleanPacket(1001);
const B1v2 = { ...clone(B1), tossups: [reword(B1.tossups[0]), ...clone(B1.tossups.slice(1))] };
await section('SET-17/SET-18/SET-26/SET-28 a ledger or category map that cannot be read is left as it is', async () => {
  await openSet(B.secret);
  ok('SET-15: a set with no packets has no Versions table', (await versionRows()) === null);
  ok('SET-11: a first upload says "all 8 questions new"',
    (await dropAndWait(fx('b/B1.json', B1), 1, /^Packet 1 v1/)) === 'Packet 1 v1: all 8 questions new.', await msgText());
  // the ledger as a newer qb-td would leave it
  const putLedger = async (ledgerText) => {
    const etag = (await ledgerOf(B.secret)).split('\n')[0] || null;
    await api(`/s/${B.secret}/qmap`, { method: 'POST', body: JSON.stringify({ packet: 1, v: 1, q: { t: [], b: [] }, etag }) + '\n' + ledgerText });
    return ledgerOf(B.secret);
  };
  let stored = await putLedger(JSON.stringify({ v: 2, seq: 40, questions: { 7: { kind: 't' } } }));
  await openSet(B.secret);
  const up = await dropAndWait(fx('b2/B1 fix.json', B1v2), 1, /^Packet 1( is now)? v2/);
  ok(`SET-17: an upload over a ledger from a newer qb-td still goes up, and its match refuses in red ${CH.ledger}`,
    up === 'Packet 1 is now v2, but matching its questions failed (The set\'s question ledger was saved by a newer version of this page, so nothing was changed. '
      + 'Please reload the page and try again.) — use Match under Versions.' && await msgBad(), up);
  ok(`SET-17: … and the ledger is left byte for byte ${CH.ledger}`, (await ledgerOf(B.secret)) === stored);
  await openReview('1:2');
  ok(`SET-26: the review still shows, and says in red its labels may be incomplete (newer ledger) ${CH.ledger}`,
    (await exists('.review')) && (await msgText()) === 'The set\'s question ledger was saved by a newer version of this page, so the question labels below may be incomplete. Please reload the page.'
      && await msgBad(), await msgText());
  await clearMsg();
  await fill('select[data-reassign="t:1"]', 'new', ['change']);
  await waitMsg(/^(?!Reassigning…$)./);
  ok(`SET-28: a reassignment over that ledger refuses in red and the picker resets ${CH.ledger}`,
    (await msgText()) === 'The set\'s question ledger was saved by a newer version of this page, so nothing was changed. Please reload the page and try again.'
      && await msgBad() && (await js(`document.querySelector('select[data-reassign="t:1"]').value`)) === '', await msgText());
  ok(`SET-17: … and the ledger is left as it is ${CH.ledger}`, (await ledgerOf(B.secret)) === stored);
  stored = await putLedger('{not json}');
  await openSet(B.secret);
  await openReview('1:2');
  ok(`SET-26: an unreadable ledger: the review says "…could not be read, so the question labels below may be incomplete. Please report the problem." ${CH.ledger}`,
    (await msgText()) === 'The set\'s question ledger could not be read, so the question labels below may be incomplete. Please report the problem.', await msgText());
  await clearMsg();
  await fill('select[data-reassign="t:1"]', 'new', ['change']);
  await waitMsg(/^(?!Reassigning…$)./);
  ok(`SET-28: … and a reassignment refuses: "…could not be read, so nothing was changed. Please report the problem, since reloading the page will not fix it." ${CH.ledger}`,
    (await msgText()) === 'The set\'s question ledger could not be read, so nothing was changed. Please report the problem, since reloading the page will not fix it.'
      && (await ledgerOf(B.secret)) === stored, await msgText());
  // a good ledger again, and then a category map that can't be read
  await putLedger(JSON.stringify({ v: 1, seq: 0, questions: {} }));
  const key = `s/${B.id}/catmap.json`;
  r2put(key, '{"packets": not json');
  stored = await ledgerOf(B.secret);
  await openSet(B.secret);
  const cm = await dropAndWait(fx('b3/B1 again.json', B1v2), 1, /^Packet 1( is now)? v3/);
  ok(`SET-18: an upload over an unreadable category map goes up, and says the match was not saved ${CH.ledger}`,
    cm === 'Packet 1 is now v3, but matching its questions failed (the set category map could not be read, so nothing was saved) — use Match under Versions.'
      && await msgBad(), cm);
  ok('SET-18: the version is there', (await packetsOf(B.secret)).filter((p) => p.packet === 1).length === 3);
  ok(`SET-18: the category map is left exactly as it was, and the ledger is not written ${CH.ledger}`,
    r2get(key).toString() === '{"packets": not json' && (await ledgerOf(B.secret)) === stored);
});

/* ---------- set C: mirrors ---------- */

const C1 = cleanPacket(2001);
const C2 = cleanPacket(2002);
const C3 = cleanPacket(2003);
const C2v2 = { ...clone(C2), tossups: [reword(C2.tossups[0]), ...clone(C2.tossups.slice(1))] };
const C2v3 = { ...clone(C2v2), tossups: [reword(C2v2.tossups[0]), ...clone(C2v2.tossups.slice(1))] };
C2v2.tossups[1].question = C2v2.tossups[1].question.replace(/^\S+/, 'Fixwording');
const C1v2 = { ...clone(C1), tossups: [reword(C1.tossups[0]), ...clone(C1.tossups.slice(1))] };
const mirrorRows = () => js(`(() => { const t = [...document.querySelectorAll('#setbody h2')].find((h) => h.textContent === 'Mirrors');
  const wrap = t.nextElementSibling; if (!wrap.querySelector('table')) return { none: wrap.textContent };
  return [...wrap.querySelectorAll('tr')].slice(1).map((tr) => { const td = tr.querySelectorAll('td');
    return { name: td[0].querySelector('b').textContent, sub: td[0].querySelector('div').textContent.replace(/\\s+/g, ' ').trim(),
      status: td[1].textContent.replace(/\\s+/g, ' ').trim(), pills: [...td[1].querySelectorAll('.pill')].map((p) => [p.textContent, p.classList.contains('on')]),
      link: td[2].textContent.replace(/\\s+/g, ' ').trim(), page: td[2].querySelector('a') ? [td[2].querySelector('a').textContent, td[2].querySelector('a').getAttribute('href'), td[2].querySelector('a').target] : null,
      buttons: [...td[3].querySelectorAll('button')].map((b) => b.textContent), muted: tr.classList.contains('muted'),
      copy: (td[3].querySelector('[data-copy]') || {}).dataset ? td[3].querySelector('[data-copy]').dataset.copy : null }; }); })()`);
const mrow = async (name) => (await mirrorRows()).find((r) => r.name === name);
let north = null;
let northRoom = null;
let east = null;

await section('SET-33/SET-34/SET-35/SET-36 the Mirrors tab: invites', async () => {
  await openSet(C.secret, 'mirrors');
  let rows = await mirrorRows();
  ok('SET-34: with no mirrors the table reads "None yet"', rows.none === 'None yet', rows);
  ok('SET-34: with no packets the note says "the set’s packets"', (await text('#setbody')).includes('with the set’s packets, the backup questions'));
  await uploadApi(C.secret, 1, 'C1.json', JSON.stringify(C1));
  await uploadApi(C.secret, 2, 'C2.json', JSON.stringify(C2));
  await openSet(C.secret, 'settings');
  // the format and a buzzpoints password, for the mirror started below
  await clearMsg();
  await fill('#gformat', 'macf-powers', ['change']);
  await waitMsg(/^Game format saved$/);
  await click('#fmtedit');
  await fill('#fmttossups', '22');
  await clearMsg();
  await click('#fmtsave');
  await waitMsg(/^Game format saved$/);
  await fill('#buzzmode', 'password', ['change']);
  await waitMsg(/^Set a password$/);
  await fill('#buzzpw', 'pw-mirrors');
  await clearMsg();
  await click('#buzzset');
  await waitMsg(/^Buzzpoints password set$/, 'the password', 30000);
  await toTab('mirrors');
  ok('SET-34: the note names the number of current packets ("these 2 packets")', (await text('#setbody')).includes('with these 2 packets, the backup questions'));
  ok('SET-33: the fields are Name, Host, Event date and Suggested URL name, then Create invite', await js(`document.querySelector('#mname').placeholder.startsWith('Name')
    && document.querySelector('#mhost').placeholder === 'Host' && document.querySelector('#mdate').type === 'date'
    && document.querySelector('#mslug').placeholder === 'Suggested URL name (optional)' && document.querySelector('#madd').textContent === 'Create invite'`));
  const tryInvite = async (fields) => {
    for (const [id, v] of Object.entries({ mname: '', mhost: '', mdate: '', mslug: '', ...fields })) await fill('#' + id, v);
    await clearMsg();
    await click('#madd');
    await waitMsg(/./);
    return { text: await msgText(), red: await msgBad() };
  };
  for (const [what, fields, want] of [
    ['no name', { mhost: 'Nowhere' }, 'name required'],
    ['a reserved URL name', { mname: 'Demo mirror', mslug: 'demo' }, 'that URL name is reserved'],
    ['a bad URL name', { mname: 'Bad mirror', mslug: 'No Good' }, 'URL name must be 3-40 characters: a-z, 0-9, hyphens'],
  ]) {
    const r = await tryInvite(fields);
    ok(`SET-33: ${what} says "${want}" in red`, r.text === want && r.red, r);
  }
  const northSlug = 'sets-ui-north-' + RUN;
  let r = await tryInvite({ mname: 'North mirror', mhost: 'North U', mdate: '2026-11-07', mslug: northSlug });
  ok('SET-33: Create invite says "Copied invite link for North mirror"', r.text === 'Copied invite link for North mirror' && !r.red, r);
  await waitJs(`document.querySelectorAll('#setbody table tr').length === 2`, 'the North row');
  rows = await mirrorRows();
  const n0 = rows[0];
  ok('SET-33: … and the clipboard holds its invite link, index.html?i=<secret>', (await clipboard()) === `${PAGES}/index.html?i=${n0.copy}`, await clipboard());
  ok('SET-34: the new row: the name, "host · date", "Invite not started", the invite link, Copy invite and Revoke',
    n0.name === 'North mirror' && n0.sub === 'North U · 2026-11-07' && n0.status === 'Invite not started'
      && n0.link === `${PAGES}/index.html?i=${n0.copy}` && n0.buttons.join('|') === 'Copy invite|Revoke' && !n0.muted, n0);
  north = { invite: n0.copy, slug: northSlug };
  // with the clipboard refused
  await send('Browser.setPermission', { permission: { name: 'clipboard-write' }, setting: 'denied', origin: ORIGIN });
  r = await tryInvite({ mname: 'South mirror' });
  await grantClipboard();
  ok('SET-33: with no clipboard it says "Invite created"', r.text === 'Invite created' && !r.red, r);
  await waitJs(`document.querySelectorAll('#setbody table tr').length === 3`, 'the South row');
  const south = await mrow('South mirror');
  await clearMsg();
  await click(`[data-copy="${south.copy}"]`);
  await waitMsg(/^Copied invite link$/);
  ok('SET-35: "Copy invite" says "Copied invite link" and puts index.html?i=<secret> on the clipboard',
    (await clipboard()) === `${PAGES}/index.html?i=${south.copy}`);
  r = await tryInvite({ mname: 'Spare mirror' });
  await waitJs(`document.querySelectorAll('#setbody table tr').length === 4`, 'the Spare row');
  const spare = await mrow('Spare mirror');
  const spareId = await js(`document.querySelector('[data-copy="${spare.copy}"]').parentElement.querySelector('[data-revoke]').dataset.revoke`);
  let n = dialogs.length;
  dialogAccept = false;
  await click(`[data-revoke="${spareId}"]`);
  await until(() => dialogs.length > n, 'the revoke question');
  dialogAccept = true;
  await settle();
  ok('SET-36: Revoke asks "Revoke this invite? The link stops working; make a new mirror to replace it."; Cancel keeps it',
    dialogs[n] === 'Revoke this invite? The link stops working; make a new mirror to replace it.' && (await mrow('Spare mirror')).status === 'Invite not started');
  n = dialogs.length;
  await click(`[data-revoke="${spareId}"]`);
  await waitJs(`[...document.querySelectorAll('#setbody tr')].some((tr) => tr.textContent.includes('Spare mirror') && tr.textContent.includes('Revoked'))`, 'Revoked');
  const sp = await mrow('Spare mirror');
  ok('SET-36: OK: the row reads "Revoked", muted, with no link and no buttons', sp.status === 'Revoked' && sp.muted && sp.link === '' && sp.buttons.length === 0, sp);
  ok('SET-34: the tab label counts started/total: "Mirrors 0/3"', (await text('[data-settab="mirrors"]')) === 'Mirrors 0/3');
  await open('index.html', { i: spare.copy });
  await waitMsg(/./);
  ok('SET-36: the revoked invite\'s page says "This invite link is not valid (it may have been revoked)"',
    (await msgText()) === 'This invite link is not valid (it may have been revoked)' && await msgBad(), await msgText());
});

await section('Invite page: a mirror\'s director starts it (and SET-42: what a mirror starts with)', async () => {
  await open('index.html', { i: north.invite });
  await waitJs(`!!document.querySelector('#invstart')`, 'the invite page');
  const page = await js(`({ h: document.querySelector('#view h2').textContent, card: document.querySelector('#view .card').textContent.replace(/\\s+/g, ' ').trim(),
    name: document.querySelector('#invname').value, slug: document.querySelector('#invslug').value })`);
  ok('Invite: the page is headed "Mirror of Sets UI Mirrors" and shows the name, host, date and "2 packets"',
    page.h === 'Mirror of Sets UI Mirrors' && page.card.startsWith('North mirror North U 2026-11-07 2 packets,'), page);
  ok('Invite: the form starts with the mirror\'s name and suggested URL name', page.name === 'North mirror' && page.slug === north.slug, page);
  await click('#invstart');
  await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the admin link modal');
  const link = await js(`document.querySelector('#modallink').textContent`);
  const m = /index\.html\?a=([a-z0-9]+)$/.exec(link);
  ok('Invite: "Create tournament" makes the tournament and shows its admin link', !!m, link);
  north.admin = m[1];
  await click('#modalok');
  await waitJs(`!!document.querySelector('.hubtab')`, 'the mirror\'s hub');
  ok('Invite: "Saved it" opens the mirror\'s hub, which says "Mirror of Sets UI Mirrors"',
    (await text('#view')).includes('Mirror of Sets UI Mirrors'));
  const t = (await api('/a/' + north.admin)).tournament;
  north.tid = t.id;
  const st = JSON.parse(t.settings || '{}');
  ok('SET-42: the mirror starts with the set\'s game format and its customized settings', st.gameFormat === 'macf-powers'
    && st.formatOverrides && st.formatOverrides.regulationTossupCount === 22, st);
  ok('SET-42: … and never the set\'s buzzpoints password', st.buzz === undefined && !JSON.stringify(t).includes('pw-mirrors'), st);
});

await section('SET-34 a started mirror\'s row; SET-14 the running count', async () => {
  await openSet(C.secret, 'mirrors');
  const t = (await api('/a/' + north.admin)).tournament;
  const n0 = await mrow('North mirror');
  ok('SET-34: a started mirror reads "Running" (green) with "round N · 0 games"', n0.pills[0][0] === 'Running' && n0.pills[0][1]
    && n0.status === `Running round ${t.current_round} · 0 games`, n0);
  ok('SET-34: its Link column has the tournament name, slug and a "Page" link (new tab) to t.html?t=',
    n0.link.startsWith(`North mirror ${north.slug}`) && n0.page && n0.page[0] === 'Page' && n0.page[1] === `${PAGES}/t.html?t=${north.slug}`
      && n0.page[2] === '_blank', n0);
  ok('SET-36: a started mirror has no Revoke; it has "Hide from stats" (no "Game files" with no games)',
    n0.buttons.join('|') === 'Hide from stats', n0.buttons);
  const refused = await call(`/s/${C.secret}/mirrors/${(await setDetail(C.secret)).mirrors.find((x) => x.name === 'North mirror').id}`,
    { method: 'POST', json: { revoked: true } });
  ok('SET-36: the Worker refuses to revoke a started mirror: "already started"', refused.status === 409 && refused.body.error === 'already started', refused);
  ok('SET-34: the tab label reads "Mirrors 1/3"', (await text('[data-settab="mirrors"]')) === 'Mirrors 1/3');
  await toTab('packets');
  const note = await js(`[...document.querySelectorAll('#setbody div.muted')].find((x) => x.textContent.includes('Packets are the set')).querySelector('b').textContent`);
  ok('SET-14: with a mirror running the note starts its sentence with a bold "1 mirror is running now"', note === '1 mirror is running now', note);
});

const hubPackets = async (admin) => {
  await open('index.html', { a: admin });
  await waitJs(`!!document.querySelector('.hubtab')`, 'the hub');
  await click('[data-view="setup"]');
  await waitJs(`!!document.querySelector('[data-step="packets"]')`, 'setup');
  await click('[data-step="packets"]');
  await waitJs(`!!document.querySelector('.pktable')`, 'the hub packets');
};
const hubRows = () => js(`[...document.querySelectorAll('.pktable tr.slot')].map((tr) => tr.querySelector('.pkfile').textContent.replace(/\\s+/g, ' ').trim())`);
const readsRows = () => js(`(() => { const d = [...document.querySelectorAll('details')].find((x) => /Which packet each round reads/.test(x.textContent));
  return d ? [...d.querySelectorAll('tr')].slice(1).map((tr) => tr.querySelectorAll('td')[1].textContent.replace(/\\s+/g, ' ').trim()) : null; })()`);

await section('SET-21 a new version reaches running mirrors', async () => {
  await openSet(C.secret);
  const fix = await dropAndWait(fx('c/C2 fix.json', C2v2), 2, /^Packet 2 v2/);
  ok('SET-21: the upload says "Sent to 1 running mirror that had not opened it."', fix.endsWith('. Sent to 1 running mirror that had not opened it.'), fix);
  await click('#addslot');
  await waitJs(`document.querySelectorAll('.pktable tr.slot').length === 3`, 'slot 3');
  const add = await dropAndWait(fx('c/C3.json', C3), 3, /^Packet 3 v1/);
  ok('SET-21: a packet new to the set is offered to the mirror with nothing on round 3', add === 'Packet 3 v1: all 8 questions new. Sent to 1 running mirror that had not opened it.', add);
  // the director puts their own packet on round 1: the set leaves it alone
  await api(`/a/${north.admin}/packet?round=1&name=Own1.json`, { method: 'POST', body: JSON.stringify(cleanPacket(2999)) });
  const own = await dropAndWait(fx('c/C1 fix.json', C1v2), 1, /^Packet 1 v2/);
  ok('SET-21: a fix to a packet whose round the director replaced reaches no one (no "Sent to")', !own.includes('Sent to'), own);
  await hubPackets(north.admin);
  const rows = await hubRows();
  ok('SET-21: the mirror\'s hub shows the new version on round 2, the new packet on round 3, and its own packet on round 1',
    rows[0] === 'Own1.json' && rows[1] === 'C2 fix.json (from Sets UI Mirrors)' && rows[2] === 'C3.json (from Sets UI Mirrors)', rows);
  const reads = await readsRows();
  ok('SET-21: "Which packet each round reads": your own packet, Packet 2 v2, Packet 3 v1',
    reads && reads[0].startsWith('Your own packet') && reads[1] === 'Packet 2 v2' && reads[2] === 'Packet 3 v1', reads);
  // a room reads round 2: the new text; from then on the round stays on it
  northRoom = (await api(`/a/${north.admin}/buckets`, { method: 'POST', json: { room_name: 'Room 1' } })).secret;
  await api(`/a/${north.admin}/start`, { method: 'POST' });
  await api(`/a/${north.admin}`, { method: 'POST', json: { current_round: 2 } });
  const p2 = await call(`/b/${northRoom}/packet?round=2`);
  ok('SET-21: the mirror\'s room reads the new text', p2.status === 200 && JSON.stringify(p2.body).includes('Fixwording'), p2.status);
  await openSet(C.secret);
  const late = await dropAndWait(fx('c/C2 again.json', C2v3), 2, /^Packet 2 v3/);
  ok('SET-21: once a room has opened round 2, a further fix is not sent there', !late.includes('Sent to'), late);
  const again = await call(`/b/${northRoom}/packet?round=2`);
  ok('SET-21: … and the room keeps reading the version it opened', JSON.stringify(again.body).includes('Fixwording'));
});

const tbC = fx('tbc/tbC.json', { tossups: [{ question: 'Set spare one.', answer: 'Set Spare One' }, { question: 'Set spare two.', answer: 'Set Spare Two' }] });
await section('SET-32 the set\'s pool reaches the mirror', async () => {
  await openSet(C.secret);
  await clearMsg();
  await pick('#picktb', [tbC]);
  await waitMsg(/split into/);
  await api(`/a/${north.admin}/tiebreakers?name=own-tb.json`, { method: 'POST', body: JSON.stringify({ tossups: [{ question: 'Own spare.', answer: 'Own Spare' }] }) });
  await hubPackets(north.admin);
  const pool = await tbRows();
  ok('SET-32: the mirror\'s hub lists the set\'s questions first as S-TU1, S-TU2, "(<file>, from the set)", then its own',
    JSON.stringify(pool.rows.map((r) => [r.id, r.cells[2]])) === JSON.stringify([['S-TU1', 'Set Spare One (tbC.json, from the set)'],
      ['S-TU2', 'Set Spare Two (tbC.json, from the set)'], ['TU1', 'Own Spare (own-tb.json)']]), pool.rows);
  ok('SET-32: the set\'s questions have no Remove link; the director\'s own do', !pool.rows[0].remove && !pool.rows[1].remove && pool.rows[2].remove, pool.rows);
  const note = await js(`[...document.querySelectorAll('.secnote')].map((p) => p.textContent.replace(/\\s+/g, ' ')).find((t) => t.includes('backup questions are listed first'))`);
  ok('SET-32: the note explains the set\'s questions come first and Delete pool removes only the director\'s', !!note && note.includes('Delete pool removes only yours'), note);
  const n = dialogs.length;
  await click('#tbclear');
  await waitJs(`document.querySelectorAll('[data-tbremove]').length === 0 && !!document.querySelector('#tbclear')`, 'the own pool deleted');
  ok('SET-32: the mirror\'s Delete pool removes only its own questions', dialogs[n] === 'Delete the tiebreaker pool? The usage log goes with it.'
    && JSON.stringify((await tbRows()).rows.map((r) => r.id)) === JSON.stringify(['S-TU1', 'S-TU2']), (await tbRows()).rows);
  const roomPool = await call(`/b/${northRoom}/tiebreakers`);
  ok('SET-32: the rooms read the merged pool (what MODAQ offers under Actions → Add questions)',
    roomPool.status === 200 && roomPool.body.tossups.map((x) => x.id).join() === 'S-TU1,S-TU2', roomPool.body);
  // the Live Hub's own refresh: the pool is asked for only when it moved
  await click('[data-view="live"]');
  await waitJs(`!!document.querySelector('.biground')`, 'the Live Hub');
  const tbGets = (since) => workerReqs(since).filter((r) => r.method === 'GET' && r.url.startsWith(`${BASE}/a/${north.admin}/tiebreakers`)).length;
  const detailGets = (since) => workerReqs(since).filter((r) => r.method === 'GET' && r.url.startsWith(`${BASE}/a/${north.admin}?rev=`)).length;
  let mark = netLog.length;
  await api(`/a/${north.admin}/buckets`, { method: 'POST', json: { room_name: 'Room 2' } });
  await js(`document.dispatchEvent(new Event('visibilitychange')); true`);
  await until(() => detailGets(mark) >= 1, 'the hub\'s refresh');
  await waitJs(`document.body.textContent.includes('Room 2')`, 'the refreshed hub');
  await settle();
  ok(`SET-32: a hub refresh after a change that leaves the pool alone does not fetch the pool ${CH.tb}`, tbGets(mark) === 0, tbGets(mark));
  mark = netLog.length;
  await api(`/s/${C.secret}/tiebreakers?name=tbC2.json`, { method: 'POST', body: JSON.stringify({ tossups: [{ question: 'Set spare three.', answer: 'Set Spare Three' }] }) });
  await js(`document.dispatchEvent(new Event('visibilitychange')); true`);
  await until(() => tbGets(mark) >= 1, 'the pool fetched again');
  ok('SET-32: questions the editors add mid-season reach the running mirror\'s hub (fetched once)', tbGets(mark) === 1, tbGets(mark));
  await click('[data-view="setup"]');
  await click('[data-step="packets"]');
  await waitJs(`!!document.querySelector('.pktable')`, 'the hub packets');
  ok('SET-32: … listed as S-TU3', (await tbRows()).rows.map((r) => r.id).join() === 'S-TU1,S-TU2,S-TU3', (await tbRows()).rows);
});

/* ---------- games come in: the zip, Stats, s.html, hiding ---------- */

function matchQbj(round, a, b, scoreA) {
  return { tossups_read: 20, _round: round,
    match_teams: [
      { team: { name: a }, bonus_points: scoreA, match_players: [{ player: { name: a === 'Alpha' ? 'Ann' : a + ' P1' }, tossups_heard: 20,
        answer_counts: [{ number: 3, answer: { value: 10 } }] }] },
      { team: { name: b }, bonus_points: 0, match_players: [{ player: { name: b + ' P1' }, tossups_heard: 20,
        answer_counts: [{ number: 1, answer: { value: 10 } }] }] },
    ],
    match_questions: [] };
}
const gameState = (marker) => ({ game: { players: [], cycles: [], marker }, uiState: {} });
await section('SET-38 a mirror\'s game files (zip)', async () => {
  const up = (name, body) => api(`/b/${northRoom}/upload?round=1&name=${encodeURIComponent(name)}`, { method: 'POST', body });
  const reader = (qbj, marker) => JSON.stringify({ qbj, game: gameState(marker),
    modaq: { qbj: JSON.stringify(qbj, null, 4), game: JSON.stringify(gameState(marker).game, null, 2) } });
  await up('Round_1_Alpha_Beta.qbtd.json', reader(matchQbj(1, 'Alpha', 'Beta', 10), 'FIRST-UPLOAD'));
  await up('Round_1_Alpha_Beta.qbtd.json', reader(matchQbj(1, 'Alpha', 'Beta', 30), 'NEWEST-UPLOAD'));
  await up('Round_1_Gamma_Delta.qbj', JSON.stringify(matchQbj(1, 'Gamma', 'Delta', 20), null, 2));
  // the director renames Alpha's player afterwards
  await api(`/a/${north.admin}/roster?name=roster.qbj`, { method: 'POST', body: JSON.stringify({ objects: [{ type: 'Tournament', registrations: [
    { name: 'Alpha', teams: [{ name: 'Alpha', players: [{ name: 'Annie', _formerNames: ['Ann'] }] }] },
    { name: 'Beta', teams: [{ name: 'Beta', players: [{ name: 'Beta P1' }] }] },
    { name: 'Gamma', teams: [{ name: 'Gamma', players: [{ name: 'Gamma P1' }] }] },
    { name: 'Delta', teams: [{ name: 'Delta', players: [{ name: 'Delta P1' }] }] }] }] }) });
  await tick();
  await openSet(C.secret, 'mirrors');
  const n0 = await mrow('North mirror');
  ok('SET-34: the row counts the games: "round 2 · 3 games"', n0.status === 'Running round 2 · 3 games', n0.status);
  ok('SET-38: "Game files" appears once the mirror has games', n0.buttons.join('|') === 'Game files|Hide from stats', n0.buttons);
  await observe(`() => document.querySelector('#msg').textContent`);
  await clearMsg();
  const got = await download(() => click('[data-files]'), 'the game files');
  await waitMsg(/^\d+ files/);
  ok('SET-38: it says "Collecting game files…", then downloads <mirror slug>-games.zip and says "3 files"',
    (await samples()).includes('Collecting game files…') && got.name === `${north.slug}-games.zip` && (await msgText()) === '3 files', [got.name, await msgText()]);
  const zip = await readZip(new Uint8Array(got.bytes));
  const names = zip.map((e) => e.name).sort();
  ok('SET-38: round-1/ holds each reader game as its .qbj and its _Game.json, and the file added by hand as itself',
    JSON.stringify(names) === JSON.stringify(['round-1/Round_1_Alpha_Beta.qbj', 'round-1/Round_1_Alpha_Beta_Game.json', 'round-1/Round_1_Gamma_Delta.qbj']), names);
  const entry = (n) => new TextDecoder().decode(zip.find((e) => e.name === n).data);
  const files = (await api('/a/' + north.admin)).files;
  const newest = files.filter((f) => f.filename === 'Round_1_Alpha_Beta.qbtd.json').sort((x, y) => y.id - x.id)[0];
  const hand = files.find((f) => f.filename === 'Round_1_Gamma_Delta.qbj');
  const own = async (f, part) => (await fetchRetry(`${BASE}/a/${north.admin}/file?key=${encodeURIComponent(f.r2_key)}&part=${part}`)).text();
  ok(`SET-38: the .qbj is the one the director downloads (MODAQ's own export), from the newest upload under that name ${CH.dl}`,
    entry('round-1/Round_1_Alpha_Beta.qbj') === await own(newest, 'qbj') && entry('round-1/Round_1_Alpha_Beta.qbj').includes('"bonus_points": 30'),
    entry('round-1/Round_1_Alpha_Beta.qbj').slice(0, 300));
  ok(`SET-38: the _Game.json is MODAQ's game backup from the same upload ${CH.dl}`,
    entry('round-1/Round_1_Alpha_Beta_Game.json') === await own(newest, 'game') && entry('round-1/Round_1_Alpha_Beta_Game.json').includes('NEWEST-UPLOAD'));
  ok('SET-38: both use the mirror\'s current roster names (Annie, not Ann)', entry('round-1/Round_1_Alpha_Beta.qbj').includes('"Annie"')
    && !entry('round-1/Round_1_Alpha_Beta.qbj').includes('"Ann"'));
  ok(`SET-38: the file added by hand comes out as the director downloads it ${CH.dl}`, entry('round-1/Round_1_Gamma_Delta.qbj') === await own(hand, 'qbj'));
  north.files = files;
});

await section('Stats tab and s.html: the mirror\'s games; SET-37 hide from stats / show in stats', async () => {
  // the cron works in the background: tick until the set's state has
  // North with its round 1 games (or, hidden, without North at all)
  const northIn = async (want, label) => {
    const end = Date.now() + 40000;
    for (;;) {
      await tick();
      for (let i = 0; i < 10; i++) {
        const m = (await api(`/s/${C.secret}/state`)).mirrors.find((x) => x.id === north.tid);
        if (want ? m && m.rounds && m.rounds['1'] : !m) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (Date.now() > end) throw new Error('timed out: ' + label);
    }
  };
  await northIn(true, 'the set state with North\'s games');
  await openSet(C.secret, 'stats');
  await waitJs(`!!document.querySelector('#setstats .setout table')`, 'the editor\'s stats');
  const sites = () => js(`[...document.querySelectorAll('#setstats .setout table')][0] ? [...[...document.querySelectorAll('#setstats .setout table')][0].querySelectorAll('tr')].slice(1)
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())) : []`);
  let s = await sites();
  ok('Stats: the editor\'s Stats tab lists the mirror with its host and date', s.length === 1 && s[0][0] === 'North mirror' && s[0][1] === 'North U' && s[0][2] === '2026-11-07', s);
  const games = s.length ? Number(s[0][4]) : 0;
  ok('Stats: … with its games (the re-exported Alpha–Beta game once, and Gamma–Delta)', games === 2, s);
  ok('Stats: … and the standings below', await js(`document.querySelectorAll('#setstats .setstats table').length > 0`)
    && (await text('#setstats .setstats')).includes('Alpha'));
  await toTab('settings');
  await clearMsg();
  await click('#pub');
  await waitMsg(/^Set page is public$/);
  await open('s.html', { s: C.slug });
  await waitJs(`document.querySelector('#sites').textContent === '1 site' && !!document.querySelector('#view .setout table')`, 'the public set page');
  ok('s.html: the public set page lists the mirror ("1 site")', (await text('#view .setout table')).includes('North mirror'), await text('#view'));
  await openSet(C.secret, 'mirrors');
  d1(`UPDATE tournaments SET pub_dirty = 0, pub_dirty_at = NULL WHERE id = ${north.tid}`);
  await clearMsg();
  await click('[data-hide]');
  await waitMsg(/^Set-wide stats update within a minute$/);
  const queued = d1(`SELECT pub_dirty FROM tournaments WHERE id = ${north.tid}`)[0].pub_dirty;
  ok('SET-37: hiding a mirror queues its own public pages for the cron (the set no longer makes its games public)', queued === 1, queued);
  await waitJs(`[...document.querySelectorAll('#setbody tr')].some((tr) => tr.textContent.includes('Hidden from stats'))`, 'the hidden row');
  const h = await mrow('North mirror');
  ok('SET-37: "Hide from stats" says "Set-wide stats update within a minute"; the row is muted with a "Hidden from stats" pill and "Show in stats"',
    h.muted && h.pills.some((p) => p[0] === 'Hidden from stats') && h.buttons.includes('Show in stats'), h);
  await northIn(false, 'the set state without North');
  await toTab('stats');
  await waitJs(`/No mirrors have started yet/.test(document.querySelector('#setstats').textContent)`, 'the stats without North');
  ok('SET-37: after the next tick the mirror leaves the editor\'s Stats tab', true);
  await open('s.html', { s: C.slug });
  await waitJs(`document.querySelector('#sites').textContent === '0 sites' && /No mirrors have started yet/.test(document.querySelector('#view').textContent)`,
    'the public page without North');
  ok('SET-37: … and the public set page ("0 sites", "No mirrors have started yet")', !(await text('#view')).includes('North mirror'));
  const refused = await call(`/pubset/${C.slug}/rounds?m=${north.tid}&n=1`);
  ok('SET-37: … and its rounds are refused on set routes', refused.status === 404, refused.status);
  const own = await call(`/a/${north.admin}`);
  ok('SET-37: nothing in the mirror\'s own tournament changes', own.body.files.length === north.files.length && own.body.tournament.published === 1);
  await openSet(C.secret, 'mirrors');
  await clearMsg();
  await click('[data-hide]');
  await waitMsg(/^Set-wide stats update within a minute$/);
  await northIn(true, 'North back in the set state');
  await toTab('stats');
  await waitJs(`!!document.querySelector('#setstats .setout table')`, 'the stats with North again');
  s = await sites();
  ok('SET-37: "Show in stats" brings it back with its games', s.length === 1 && s[0][0] === 'North mirror' && Number(s[0][4]) === games, [s, games]);
});

await section('SET-34 statuses: setup week, Finished; SET-41 what the lock does to a mirror', async () => {
  east = await startMirrorApi(C.secret, 'East mirror', 'sets-ui-east-' + RUN);
  d1(`UPDATE tournaments SET published = 0 WHERE id = ${east.tid}`); // its director has not made its page public
  await openSet(C.secret, 'mirrors');
  let e = await mrow('East mirror');
  ok('SET-34: a mirror still in its setup week (not yet Started) reads "Running" too (observed)', e.pills[0][0] === 'Running', e);
  ok('SET-34: a started mirror whose own page is off has its name and slug but no "Page" link',
    e.link.startsWith(`East mirror ${east.slug}`) && e.page === null, e);
  d1(`UPDATE tournaments SET created = ${Date.now() - 9 * DAY}, started = ${Date.now() - 50 * 3600 * 1000} WHERE id = ${east.tid}`);
  await openSet(C.secret, 'mirrors');
  e = await mrow('East mirror');
  ok('SET-34: once its links have closed it reads "Finished" (not green)', e.pills[0][0] === 'Finished' && !e.pills[0][1], e);
  ok('SET-34: the tab label reads "Mirrors 2/4"', (await text('[data-settab="mirrors"]')) === 'Mirrors 2/4');
  const pks = await packetsOf(C.secret);
  const live = pks.filter((p) => !p.retired).length;
  ok('SET-34: with retired versions in the set, the note still counts only the current packets',
    pks.some((p) => p.retired) && (await text('#setbody')).includes(`with these ${live} packets, the backup questions`),
    [live, pks.length, (await text('#setbody')).match(/with (these \d+ packets|the set)/)]);
  await toTab('packets');
  const runningNote = await js(`[...document.querySelectorAll('#setbody div.muted')].find((x) => x.textContent.includes('Packets are the set')).querySelector('b').textContent`);
  ok('SET-14: a finished mirror is not counted as running ("1 mirror is running now" with East finished)',
    runningNote === '1 mirror is running now', runningNote);
  // the lock as the mirror's director sees it; changing it queues the
  // started mirrors' public state for the cron
  const dirty = () => d1(`SELECT id, pub_dirty FROM tournaments WHERE id IN (${north.tid}, ${east.tid}) ORDER BY id`).map((r) => r.pub_dirty);
  d1(`UPDATE tournaments SET pub_dirty = 0, pub_dirty_at = NULL WHERE id IN (${north.tid}, ${east.tid})`);
  await toTab('settings');
  await clearMsg();
  await click('#mirrorbuzz');
  await waitMsg(/^Mirror buzzpoints are off$/);
  ok('SET-41: the mirror is told the set has buzzpoints off', (await api('/a/' + north.admin)).tournament.set.lock_buzz === true);
  ok('SET-41: switching mirror buzzpoints off queues each started mirror\'s public state', dirty().every((n) => n === 1), dirty());
  await open('index.html', { a: north.admin });
  await waitJs(`!!document.querySelector('.hubtab')`, 'the mirror hub');
  await click('[data-view="setup"]');
  await click('[data-step="stats"]');
  await waitJs(`!!document.querySelector('#buzzmode')`, 'the hub\'s stats settings');
  ok('SET-41: the mirror\'s hub disables its Buzzpoints switch and says the set\'s editors switched buzzpoints off',
    await js(`document.querySelector('#buzzmode').disabled`) && (await text('#view')).includes('have switched buzzpoints off for its mirrors'));
  await openSet(C.secret, 'settings');
  d1(`UPDATE tournaments SET pub_dirty = 0, pub_dirty_at = NULL WHERE id IN (${north.tid}, ${east.tid})`);
  await clearMsg();
  await click('#mirrorbuzz');
  await waitMsg(/^Mirrors may run their own buzzpoints$/);
  ok('SET-41: ticking it again says "Mirrors may run their own buzzpoints" and the mirror is free again',
    (await api('/a/' + north.admin)).tournament.set.lock_buzz === false);
  ok('SET-41: … and queues each started mirror\'s public state again', dirty().every((n) => n === 1), dirty());
  d1(`UPDATE tournaments SET pub_dirty = 0, pub_dirty_at = NULL WHERE id IN (${north.tid}, ${east.tid})`);
  await api('/s/' + C.secret, { method: 'POST', json: { settings: await settingsOf(C.secret) } });
  ok('SET-41: a settings save that leaves the lock alone queues no mirror', dirty().every((n) => n === 0), dirty());
});

await section('SET-38 game files that cannot be read', async () => {
  const hand = north.files.find((f) => f.filename === 'Round_1_Gamma_Delta.qbj');
  r2del(hand.r2_key);
  // a room's upload that is not a game file (kind "other") is no game file either
  await api(`/b/${northRoom}/upload?round=1&name=${encodeURIComponent('Round 1 notes.txt')}`, { method: 'POST', body: 'scorekeeper notes' });
  await openSet(C.secret, 'mirrors');
  await clearMsg();
  const got = await download(() => click('[data-files]'), 'the game files');
  await waitMsg(/^\d+ files/);
  const gotNames = (await readZip(new Uint8Array(got.bytes))).map((e) => e.name);
  ok('SET-38: a file that cannot be read is left out and counted: "2 files (1 could not be read)"',
    (await msgText()) === '2 files (1 could not be read)' && gotNames.length === 2, await msgText());
  ok('SET-38: a room upload that is not a game (a .txt) is not in the zip', !gotNames.some((n) => /notes/.test(n)), gotNames);
  for (const f of north.files.filter((x) => x.filename === 'Round_1_Alpha_Beta.qbtd.json')) r2del(f.r2_key);
  await clearMsg();
  await click('[data-files]');
  await waitMsg(/^(No game files yet|\d+ files)/);
  ok('SET-38: with nothing to put in the zip it says "No game files yet" in red', (await msgText()) === 'No game files yet' && await msgBad(), await msgText());
});

/* ---------- set buzzpoints: a mirror with a Bye Room, a renamed room, the public gate ---------- */

const G1 = cleanPacket(4001);
await section('Set buzzpoints: the Stats tab\'s Buzzpoints, a Bye Room, a renamed room, the public page\'s password', async () => {
  const G = await createSetApi('Sets UI Buzz', 'sets-ui-g-' + RUN);
  await openSet(G.secret);
  ok('Buzz: the set\'s packet is matched on upload', (await dropAndWait(fx('g/G1.json', G1), 1, /^Packet 1 v1/)) === 'Packet 1 v1: all 8 questions new.');
  const west = await startMirrorApi(G.secret, 'West mirror', 'sets-ui-west-' + RUN);
  const WA = '/a/' + west.admin;
  const room = await api(WA + '/buckets', { method: 'POST', json: { room_name: 'Room 1' } });
  const bye = await api(WA + '/buckets', { method: 'POST', json: { room_name: 'Bye Room' } });
  const before = JSON.parse((await api(WA)).tournament.settings || '{}');
  await api(WA, { method: 'POST', json: { settings: { ...before, byeRoom: bye.id } } });
  await api(WA + '/start', { method: 'POST' });
  const game = { ...matchQbj(1, 'Alpha', 'Beta', 10),
    match_questions: [
      { question_number: 1, tossup_question: { question_number: 1, type: 'tossup', parts: 1 },
        buzzes: [{ team: { name: 'Alpha' }, player: { name: 'Ann' }, buzz_position: { word_index: 7 }, result: { value: 10 } }] },
      { question_number: 2, tossup_question: { question_number: 2, type: 'tossup', parts: 1 }, buzzes: [] },
    ] };
  await api(`/b/${room.secret}/upload?round=1&name=Round_1_Alpha_Beta.qbj`, { method: 'POST', body: JSON.stringify(game) });
  // the cron, until the set's state has West's round 1 as finished
  const westState = async () => (await api(`/s/${G.secret}/state`)).mirrors.find((m) => m.id === west.tid);
  const tickUntil = async (pred, label) => {
    const end = Date.now() + 40000;
    for (;;) {
      await tick();
      for (let i = 0; i < 10; i++) {
        const m = await westState();
        if (m && pred(m)) return m;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (Date.now() > end) throw new Error('timed out: ' + label + ' ' + JSON.stringify(await westState()));
    }
  };
  let m;
  try { m = await tickUntil((x) => x.rounds && x.rounds['1'] && (x.done || []).includes(1), 'round 1 finished at West'); } catch (e) { m = await westState(); }
  ok(`Buzz: with Room 1 in and only the Bye Room left, the set counts round 1 as finished ${CH.bye}`,
    !!m && (m.done || []).includes(1), m && m.done);
  const buzzLine = async () => {
    await openSet(G.secret, 'stats');
    await waitJs(`!!document.querySelector('#setstats [data-tab="buzz"]') && !document.querySelector('#setstats [data-tab="buzz"]').hidden`, 'the Buzzpoints tab');
    await click('#setstats [data-tab="buzz"]');
    // no question rows at all (no finished round): the checks below say so
    try { await waitJs(`!!document.querySelector('#setstats .buzzout details.qd')`, 'the buzzpoints', 15000); } catch (e) { return null; }
    return js(`(() => { const d = document.querySelector('#setstats .buzzout details.qd'); if (!d) return null; d.open = true;
      return { head: d.querySelector('summary').textContent.replace(/\\s+/g, ' ').trim(),
        buzzes: [...d.querySelectorAll('.buzzlist > div')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()) }; })()`);
  };
  let t1 = await buzzLine();
  ok(`Buzz: the editor's Buzzpoints tab shows packet 1's T1 with the buzz, its word and "site · room" ${CH.bye}`,
    !!t1 && t1.head.startsWith('T1 ' + labelOf(G1.tossups[0])) && t1.buzzes.length === 1
      && t1.buzzes[0] === '1 +10 Ann (Alpha) · word 8 · West mirror · Room 1', t1);
  // the director renames the room
  const stamp = m && m.rounds ? m.rounds['1'] : null;
  await api(`${WA}/buckets/${room.id}`, { method: 'POST', json: { room_name: 'Hall A' } });
  try { await tickUntil((x) => x.rounds && x.rounds['1'] && x.rounds['1'] !== stamp, 'round 1 rebuilt after the rename'); } catch (e) { /* checked below */ }
  t1 = await buzzLine();
  ok(`Buzz: after the room is renamed, the buzz reads "West mirror · Hall A" ${CH.room}`,
    !!t1 && t1.buzzes[0] === '1 +10 Ann (Alpha) · word 8 · West mirror · Hall A', t1);
  // the public page's Buzzpoints sit behind the set's password
  await toTab('settings');
  await clearMsg();
  await click('#pub');
  await waitMsg(/^Set page is public$/);
  await fill('#buzzmode', 'password', ['change']);
  await waitMsg(/^Set a password$/);
  await fill('#buzzpw', 'pw-buzz');
  await clearMsg();
  await click('#buzzset');
  await waitMsg(/^Buzzpoints password set$/, 'the password', 30000);
  await open('s.html', { s: G.slug });
  await waitJs(`document.querySelector('#sites').textContent === '1 site' && !document.querySelector('[data-tab="buzz"]').hidden`, 'the public page');
  await click('[data-tab="buzz"]');
  await waitJs(`!!document.querySelector('.buzzpw')`, 'the password box');
  ok('s.html: the public Buzzpoints tab asks for the set\'s password first', !(await exists('details.qd')));
  await fill('.buzzpw', 'wrong-password');
  await click('.buzzgo');
  try {
    await waitJs(`/bad password/.test(document.querySelector('.setmsg').textContent) || !document.querySelector('.buzzpw')`, 'an answer to the password', 30000);
  } catch (e) { /* the check says what happened */ }
  // (the password is tried on a version some site has finished: round 1,
  // finished with the Bye Room left out)
  ok(`s.html: a wrong password says "bad password" in red ${CH.bye}`, (await text('.setmsg')) === 'bad password'
    && await js(`document.querySelector('.setmsg').classList.contains('bad')`), await text('#view'));
  if (await exists('.buzzpw')) {
    await fill('.buzzpw', 'pw-buzz');
    await click('.buzzgo');
  }
  try { await waitJs(`!!document.querySelector('.buzzout details.qd')`, 'the public buzzpoints', 30000); } catch (e) { /* checked below */ }
  const pubT1 = await js(`(() => { const d = document.querySelector('.buzzout details.qd'); if (!d) return null; d.open = true;
    return { head: d.querySelector('summary').textContent.replace(/\\s+/g, ' ').trim(), text: d.querySelector('.qdbody').textContent }; })()`);
  ok(`s.html: the right password shows the question text with its buzzes ${CH.bye}`, !!pubT1 && pubT1.head.startsWith('T1 ' + labelOf(G1.tossups[0]))
    && pubT1.text.replace(/\s+/g, ' ').includes(G1.tossups[0].question.split(' ').slice(0, 4).join(' '))
    && pubT1.text.includes('Ann (Alpha) · word 8 · West mirror · Hall A'), pubT1);
});

/* ---------- set D: twenty mirrors, then two hundred ---------- */

await section(`SET-21 twenty mirrors ${CH.many}`, async () => {
  await uploadApi(D.secret, 1, 'D1.json', JSON.stringify(cleanPacket(3001)));
  d1("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const mirrors = [];
  for (let i = 0; i < 20; i += 5) {
    mirrors.push(...await Promise.all(Array.from({ length: 5 }, (_, j) => startMirrorApi(D.secret, `Many ${i + j + 1}`, `sets-ui-many-${RUN}-${i + j + 1}`))));
  }
  d1("UPDATE tournaments SET creator_ip = 'earlier-run'");
  await openSet(D.secret);
  ok('SET-34: the tab label reads "Mirrors 20/20"', (await text('[data-settab="mirrors"]')) === 'Mirrors 20/20');
  ok('SET-14: the note says "20 mirrors are running now"', await js(`[...document.querySelectorAll('#setbody div.muted')].find((x) => x.textContent.includes('Packets are the set')).querySelector('b').textContent`) === '20 mirrors are running now');
  const fix = await dropAndWait(fx('d/D1 fix.json', cleanPacket(3001, { tossups: 5 })), 1, /^Packet 1 v2/);
  ok(`SET-21: a fix says "Sent to 20 running mirrors that had not opened it." ${CH.many}`, fix.endsWith('. Sent to 20 running mirrors that had not opened it.'), fix);
  const roundsOf = async (m) => (await api('/a/' + m.admin)).rounds;
  const all = await Promise.all(mirrors.map(roundsOf));
  ok(`SET-21: each of the 20 mirrors reads the fix on round 1 ${CH.many}`, all.every((rs) => rs.find((r) => r.number === 1).packet_name === 'D1 fix.json'),
    all.map((rs) => (rs.find((r) => r.number === 1) || {}).packet_name));
  await click('#addslot');
  await waitJs(`document.querySelectorAll('.pktable tr.slot').length === 2`, 'slot 2');
  const add = await dropAndWait(fx('d/D2.json', cleanPacket(3002)), 2, /^Packet 2 v1/);
  ok(`SET-21: a new packet says "Sent to 20 running mirrors…" ${CH.many}`, add.endsWith('. Sent to 20 running mirrors that had not opened it.'), add);
  // removed (through the Worker: the page has no button, SET-20) and back
  await api(`/s/${D.secret}/packet?packet=2`, { method: 'DELETE' });
  const gone = await Promise.all(mirrors.map(roundsOf));
  ok(`SET-20/21: a removal takes it out of each of the 20 ${CH.many}`, gone.every((rs) => !rs.some((r) => r.number === 2)));
  await openSet(D.secret);
  const back = await dropAndWait(fx('d2/D2 back.json', cleanPacket(3002)), 2, /^Packet 2 v2/);
  ok(`SET-21: a packet back after removal is offered again: "Sent to 20 running mirrors…" ${CH.many}`, back.endsWith('. Sent to 20 running mirrors that had not opened it.'), back);
});

await section('SET-33 the mirror cap', async () => {
  const have = (await setDetail(D.secret)).mirrors.length;
  for (let i = have; i < 200; i += 20) {
    await Promise.all(Array.from({ length: Math.min(20, 200 - i) }, (_, j) => api(`/s/${D.secret}/mirrors`, { method: 'POST', json: { name: `Invite ${i + j + 1}` } })));
  }
  await openSet(D.secret, 'mirrors');
  ok('SET-34: 200 mirrors are listed', (await mirrorRows()).length === 200);
  await fill('#mname', 'One too many');
  await clearMsg();
  await click('#madd');
  await waitMsg(/./);
  ok('SET-33: the 201st says "mirror cap reached" in red', (await msgText()) === 'mirror cap reached' && await msgBad(), await msgText());
});

/* ---------- whole run ---------- */

await section('the whole run', async () => {
  ok('no uncaught errors in any page', pageErrors.length === 0, pageErrors);
  ok('no page asked for anything outside this machine', offHost.length === 0, [...new Set(offHost)]);
});

try { ws.close(); } catch (e) { /* closed */ }
// Chrome and the dev Worker write into the temporary folder as they shut
// down: it is removed once they have exited (or after 10 s)
const exited = kids.map((k) => new Promise((r) => { if (k.exitCode !== null || k.signalCode !== null) r(); else k.once('exit', r); }));
stopAll();
await Promise.race([Promise.all(exited), new Promise((r) => setTimeout(r, 10000))]);
if (!KEEP) { try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ } } else console.log('kept', tmp);
console.log(`\n(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
if (knownNotes.length) console.log('known bugs that no longer reproduce:', knownNotes.length);
console.log(`${passed} set ui checks passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
