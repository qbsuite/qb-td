#!/usr/bin/env node
// ui_full_setup.js — the home page, the invite page and Tournament Setup
// driven in a real headless Chrome against a local Worker, one feature at a
// time, checking what the TD sees: the text on the page, which buttons are
// enabled, the questions the page asks (confirm), the notices, the clipboard,
// the new tabs it opens, the bytes of each download, and what reached the
// Worker. Feature ids (HOME-01, ROOMS-03, PK-09, …) are the setup inventory's.
//
// Checks whose expected result differs from the code before 10/19/2026
// (commit 173a444) because of an approved change carry
// "[changed: <changelog line>]" in their name; on an older checkout those
// are the ones expected to fail. A few checks pin what the code does today
// where it looks wrong; their names say "(reported)", so a fix shows up as
// that check failing:
//   - the Live view of a tournament with no rooms throws while it is drawn
//     (renderLive wires #autoadv, drawn only with rooms), and its Start
//     tournament button, among others wired after it, does nothing
//   - a packet zip with no .json/.docx leaves the Packets section busy
//     ("Reading zip…", its buttons off) until the next redraw
//   - 60 rooms made at once leave no space for the Bye Room, silently
//   - a blank room name is not saved, but the field stays blank until the
//     next redraw
//
// Run (starts its own local stack, then stops it):
//   node tests/ui_full_setup.js
// It starts, on ports 9631-9639 only:
//   9631  wrangler dev --local (fresh --persist-to dir under the OS temp
//         dir, schema.sql loaded, --test-scheduled, no secrets: the cron
//         publishes nothing anywhere)
//   9632  a static server for app/ (pages at http://localhost:9632)
//   9637  headless Chrome's DevTools (fresh profile)
//   9639  the dev Worker's inspector
// Every page is loaded with ?server=<local Worker>&live=off, its storage
// says the same before any script runs, and every request the browser makes
// to a host other than the two local servers is refused; any but MODAQ's
// own font and icon requests (res.cdn.office.net, made inside the reader)
// fails the run. Packets are JSON only (a .docx would go to the outside
// YAPP parser). Some states are set up through the Worker's routes or the
// local database (rooms by the dozen, games turned in by rooms, a set and
// its invites, backdated clocks, a database fault for the server-failure
// text); what is checked is what the pages then show and do.
//
// Before vs after: point the stack at another checkout's app/ and worker/
// (the fixtures and this file stay the ones here):
//   mkdir -p /tmp/qbtd-before && git -C <repo> archive 173a444 app worker | tar -x -C /tmp/qbtd-before
//   QBTD_ROOT=/tmp/qbtd-before node tests/ui_full_setup.js
// The old Worker needs no node_modules of its own (wrangler is this
// checkout's). Compare the two runs' "FAIL" lines: only checks tagged
// [changed: …] should differ. (10/20/2026: main 285 of 285; 173a444 268
// of 285, the 17 failing all tagged [changed: …].)
//
// Or against a stack already running (tools/e2e_stack.mjs):
//   QBTD_BASE=http://127.0.0.1:9631 QBTD_PAGES=http://localhost:9632 \
//   QBTD_PERSIST=<its --state dir> node tests/ui_full_setup.js
// Other knobs: QBTD_CDP_PORT (9637), CHROME, QBTD_KEEP_STATE=1 (keep the
// state dir). Exit 0 when every check passes.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archive from '../app/archive/ug-nats-stanford.js';
import { makeZip } from '../app/engine/zip.js';
import { buildRosterQbj, forfeitQbj } from '../app/engine/qbj.js';

const started = Date.now();
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.QBTD_ROOT || REPO);
const APP = path.join(ROOT, 'app');
const WORKER_DIR = path.join(ROOT, 'worker');
const WRANGLER = process.env.WRANGLER || path.join(REPO, 'node_modules', '.bin', 'wrangler');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W_PORT = 9631;
const P_PORT = 9632;
const CDP_PORT = Number(process.env.QBTD_CDP_PORT || 9637);
const I_PORT = 9639;
const WENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 8);
const q = (x) => JSON.stringify(x);
const E = encodeURIComponent;
const DAY = 24 * 3600 * 1000;

// The approved 10/19/2026 changes these checks follow (app/changelog.txt)
const CH = {
  server: '[changed: When the server fails, pages say "Something went wrong on the server. Please try again." instead of reporting a network error.]',
  test: "[changed: Room Test links no longer contain the admin link's secret. Test links made before this update stop working, so please copy them again.]",
  note: '[changed: The Rooms note now points to the Bye Room link for unofficial scrims, since nothing played there is saved.]',
  replace: '[changed: Replacing the packet of a round that already has games now asks first.]',
  rename: '[changed: Renaming a room renames its line on the saved schedule, also when the room was matched by name.]',
  tbperf: '[changed: The Live Hub fetches the tiebreaker pool only when it has changed.]',
  pubrename: "[changed: After a TD's Rebuild, a room move or a room rename, the public page shows the corrected games without waiting for new ones.]",
};
const SERVER_FAIL = 'Something went wrong on the server. Please try again.';

/* ---------- tally ---------- */

let passed = 0;
const failures = [];
let section = '';
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); return true; }
  failures.push(name);
  const said = extra === undefined ? '' : typeof extra === 'string' ? extra : JSON.stringify(extra);
  console.error('FAIL', name, said ? '— ' + said.slice(0, 600) : '');
  process.exitCode = 1;
  return false;
}
async function check(name, fn) {
  let v;
  try { v = await fn(); } catch (e) { return ok(name, false, e.message); }
  return ok(name, v === true, v);
}
const until = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(50);
  }
};

/* ---------- the local stack ---------- */

const kids = [];
let staticSrv = null;
let STATE = null;
let BASE = process.env.QBTD_BASE || '';
let PAGES = process.env.QBTD_PAGES || '';
let PERSIST = process.env.QBTD_PERSIST || '';
const ownStack = !(BASE && PAGES);
function stopAll() {
  for (const k of kids) {
    try { process.kill(-k.pid, 'SIGTERM'); } catch (e) { try { k.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  }
  if (staticSrv) { try { staticSrv.close(); } catch (e) { /* closed */ } }
}
process.on('exit', () => {
  stopAll();
  for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  if (ownStack && STATE && !process.env.QBTD_KEEP_STATE) { try { rmSync(STATE, { recursive: true, force: true }); } catch (e) { /* busy */ } }
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
function serveApp(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let file = path.join(APP, decodeURIComponent(u.pathname));
      if (!file.startsWith(APP)) { res.writeHead(403); res.end(); return; }
      try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { /* missing */ }
      if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
async function startStack() {
  if (!ownStack) {
    if (!PERSIST) throw new Error('QBTD_PERSIST (the dev Worker\'s --persist-to dir) is needed with QBTD_BASE/QBTD_PAGES');
    return;
  }
  if (!existsSync(path.join(WORKER_DIR, 'worker.js')) || !existsSync(path.join(APP, 'index.html'))) {
    throw new Error('QBTD_ROOT has no worker/worker.js or app/index.html: ' + ROOT);
  }
  STATE = mkdtempSync(path.join(tmpdir(), 'qbtd-setup-state-'));
  PERSIST = STATE;
  execFileSync(WRANGLER, ['d1', 'execute', 'qb-td', '--local', '--file', 'schema.sql', '--persist-to', STATE],
    { cwd: WORKER_DIR, env: WENV, stdio: 'ignore' });
  const log = openSync(path.join(STATE, 'wrangler_dev.log'), 'a');
  kids.push(spawn(WRANGLER, ['dev', '--local', '--port', String(W_PORT), '--ip', '127.0.0.1', '--test-scheduled',
    '--persist-to', STATE, '--var', `ALLOWED_ORIGIN:http://localhost:${P_PORT}`, '--show-interactive-dev-session=false',
    '--inspector-port', String(I_PORT)], { cwd: WORKER_DIR, env: WENV, stdio: ['ignore', log, log], detached: true }));
  staticSrv = await serveApp(P_PORT);
  BASE = `http://127.0.0.1:${W_PORT}`;
  PAGES = `http://localhost:${P_PORT}`;
  await until(async () => (await fetch(BASE + '/')).status > 0, 'the dev Worker (see ' + path.join(STATE, 'wrangler_dev.log') + ')', 120000);
}

/* ---------- the Worker and its local database, from Node ---------- */

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  let res;
  for (let i = 0; ; i++) {
    // wrangler's CLI resets the dev server's pooled connections: a fresh one works
    try { res = await fetch(BASE + p, { method: opts.method || 'GET', headers, body }); break; } catch (e) { if (i >= 2) throw e; await sleep(300); }
  }
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
function d1(sql, json = false) {
  const args = ['d1', 'execute', 'qb-td', '--local', '--persist-to', PERSIST, '--command', sql];
  if (json) args.push('--json');
  const out = execFileSync(WRANGLER, args, { cwd: WORKER_DIR, env: WENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return json ? JSON.parse(out.slice(out.indexOf('['))) : null;
}
const d1rows = (sql) => d1(sql, true)[0].results;
async function tick() {
  const r = await fetch(BASE + '/__scheduled');
  await r.text();
  if (!r.ok) throw new Error('cron trigger failed: ' + r.status);
}
// this machine makes every tournament; the Worker allows 20 a day per IP
const resetIp = () => d1("UPDATE tournaments SET creator_ip = 'suite-earlier' WHERE creator_ip NOT LIKE 'filler%'");
const sha = (s) => createHash('sha256').update(s).digest('hex');
const testTokenOf = (secret) => sha('qbtd-test:' + sha('qbtd-cred:' + secret));
async function apiTournament(name, settings = { autoAdvance: true }) {
  const slug = 'st-' + rnd() + rnd();
  let r = await call('/api/tournaments', { method: 'POST', json: { name, slug, settings } });
  if (r.status === 429) { resetIp(); r = await call('/api/tournaments', { method: 'POST', json: { name, slug, settings } }); }
  if (r.status !== 200) throw new Error('could not create ' + name + ': ' + JSON.stringify(r.body));
  return { name, slug, secret: r.body.admin_secret, id: r.body.id, A: '/a/' + r.body.admin_secret };
}
const detail = async (T) => (await call(T.A)).body;
const settingsOf = (d) => JSON.parse((d.tournament && d.tournament.settings) || '{}');
const byeOf = (d) => { const id = settingsOf(d).byeRoom; return (d.buckets || []).find((b) => b.id === id) || null; };
const roomsOf = (d) => { const id = settingsOf(d).byeRoom; return (d.buckets || []).filter((b) => b.id !== id); };

/* ---------- fixtures ---------- */

const fx = mkdtempSync(path.join(tmpdir(), 'qbtd-setup-fx-'));
const dlDir = path.join(fx, 'downloads');
mkdirSync(dlDir, { recursive: true });
process.on('exit', () => { try { rmSync(fx, { recursive: true, force: true }); } catch (e) { /* busy */ } });
const writeFx = (name, data) => { const p = path.join(fx, name.replace(/\//g, '_')); writeFileSync(p, data); return p; };

const TEAMS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const player = (team, j) => `${team} P${(j % 4) + 1}`;
const rosterJson = JSON.stringify(buildRosterQbj('Setup Suite', TEAMS.map((name) => ({ name, players: [0, 1, 2, 3].map((j) => player(name, j)) }))));
const CATS = ['Literature', 'Science', 'History', 'Fine Arts', 'Religion', 'Geography'];
// a packet whose every question says where it is from
const packetJson = (tag, n = 20) => JSON.stringify({
  tossups: Array.from({ length: n }, (_, i) => ({
    question: `${tag} tossup ${i + 1}: this author wrote a novel about the sea. For 10 points, name this writer.`,
    answer: `${tag} answer ${i + 1}`, category: CATS[(i + tag.length) % CATS.length], metadata: `Writer ${i + 1}, ${CATS[(i + tag.length) % CATS.length]}`,
  })),
  bonuses: Array.from({ length: n }, (_, i) => ({
    leadin: `${tag} bonus ${i + 1}. For 10 points each:`, parts: ['First part.', 'Second part.', 'Third part.'],
    answers: ['alpha', 'beta', 'gamma'], values: [10, 10, 10], category: CATS[(i + 2) % CATS.length],
  })),
});
const tbJson = (tag, tossups, bonuses = 0) => JSON.stringify({
  tossups: Array.from({ length: tossups }, (_, i) => ({ question: `${tag} tiebreaker ${i + 1} text.`, answer: `${tag} TB answer ${i + 1}` })),
  bonuses: Array.from({ length: bonuses }, (_, i) => ({ leadin: `${tag} tiebreaker bonus ${i + 1}.`, parts: ['p1', 'p2', 'p3'],
    answers: [`${tag} bx`, `${tag} by`, `${tag} bz`], values: [10, 10, 10] })),
});
// the archive's median real match, renamed onto two of our teams
const sample = (() => {
  const bundle = archive[Object.keys(archive).find((k) => k.endsWith('/bundle'))];
  const sized = bundle.entries.map((e) => ({ e, n: JSON.stringify(e.qbj).length })).sort((a, b) => a.n - b.n);
  return sized[Math.floor(sized.length / 2)].e.qbj;
})();
const sampleB = (sample.match_teams[1].team || {}).name;
function matchFor(round, a, b) {
  const m = JSON.parse(JSON.stringify(sample));
  const names = [a, b];
  (m.match_teams || []).forEach((mt, i) => {
    if (mt.team) mt.team.name = names[i];
    (mt.match_players || []).forEach((mp, j) => { if (mp.player) mp.player.name = player(names[i], j); });
    (mt.lineups || []).forEach((l) => (l.players || []).forEach((p, j) => { p.name = player(names[i], j); }));
  });
  (m.match_questions || []).forEach((mq) => (mq.buzzes || []).forEach((bz) => {
    const side = bz.team && bz.team.name === sampleB ? 1 : 0;
    if (bz.team) bz.team.name = names[side];
    if (bz.player) bz.player.name = player(names[side], 0);
  }));
  delete m.notes;
  m._round = round;
  return m;
}
async function roomUpload(bucket, round, name, text) {
  return call(`/b/${bucket.secret}/upload?round=${round}&name=${E(name)}`, { method: 'POST', body: text });
}

// the hub's questions about another tab's save (saves.js), when the checkout has them
const conflictAsks = (() => {
  try {
    const src = readFileSync(path.join(APP, 'js', 'saves.js'), 'utf8');
    return ['SCHED_CONFLICT', 'ROSTER_CONFLICT'].map((n) => {
      const m = new RegExp(`export const ${n} = ([^;]+);`).exec(src);
      return m ? Function(`"use strict"; return (${m[1]});`)() : null;
    }).filter(Boolean);
  } catch (e) { return []; }
})();

/* ---------- Chrome over the DevTools protocol ---------- */

await startStack();
const PAGES_ORIGIN = new URL(PAGES).origin;
const local = (u) => {
  if (/^(data|blob|about|chrome|devtools):/.test(u)) return true;
  try { const x = new URL(u); return x.origin === PAGES_ORIGIN || x.origin === new URL(BASE).origin; } catch (e) { return false; }
};
console.log(`stack: Worker ${BASE}, pages ${PAGES} (${APP}), state ${PERSIST}`);

const udd = mkdtempSync(path.join(tmpdir(), 'qbtd-setup-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-features=Translate,OptimizationHints,MediaRouter',
  'about:blank'], { stdio: 'ignore', detached: true });
kids.push(chrome);
process.on('exit', () => { try { rmSync(udd, { recursive: true, force: true }); } catch (e) { /* busy */ } });
const wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl, 'Chrome to start');
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
  } else if (m.method) for (const fn of [...listeners]) { try { fn(m); } catch (e) { console.error('listener:', e.message); } }
};
const deadline = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('no ' + what + ' within ' + ms + 'ms')), ms))]);
const send = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return deadline(new Promise((res, rej) => pending.set(id, { res, rej, method })), 60000, 'reply to ' + method);
};
const { targetId: mainTarget } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId: mainTarget, flatten: true });
const S = (method, params) => send(method, params, sessionId);
const once = (pred, ms = 20000, what = 'browser event') => deadline(new Promise((res) => {
  const fn = (m) => { if (pred(m)) { listeners.splice(listeners.indexOf(fn), 1); res(m); } };
  listeners.push(fn);
}), ms, what);

// what the pages did: errors, dialogs (answered from `answers`, OK by
// default), requests, new tabs, downloads, refused hosts
const pageErrors = [];
const dialogs = [];
const answers = [];
let here = 'about:blank';
const reqs = [];
const newTabs = [];
const downloads = new Map();
const refused = [];
listeners.push((m) => {
  if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, url: m.params.url, done: false });
  if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') { const d = downloads.get(m.params.guid); if (d) d.done = true; }
  if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') && m.params.targetInfo.type === 'page'
    && m.params.targetInfo.targetId !== mainTarget) {
    const info = m.params.targetInfo;
    if (info.url && info.url !== 'about:blank' && !newTabs.some((t) => t.id === info.targetId)) {
      newTabs.push({ id: info.targetId, url: info.url });
      send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
  }
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Page.javascriptDialogOpening') {
    const accept = answers.length ? answers.shift() : true;
    dialogs.push({ message: m.params.message, type: m.params.type, accept });
    if (conflictAsks.includes(m.params.message)) ok(`no question about another tab's save in a one-tab run (${section})`, false, m.params.message);
    S('Page.handleJavaScriptDialog', { accept }).catch(() => {});
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(here + ': ' + ((d.exception && d.exception.description) || d.text));
  } else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
    here = m.params.frame.url;
  } else if (m.method === 'Network.requestWillBeSent') {
    reqs.push({ method: m.params.request.method, url: m.params.request.url, type: m.params.type || '', page: here });
  }
});

// Every request passes here (Fetch, request stage): another host is
// refused; a hook may hold a request (to see the page mid-action) or answer it.
const hooks = [];
listeners.push(async (m) => {
  if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
  const p = m.params;
  try {
    if (!local(p.request.url)) {
      refused.push(p.request.method + ' ' + p.request.url);
      await S('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
      return;
    }
    const h = hooks.find((x) => x.match(p.request));
    if (h) { await h.handle(p); return; }
    await S('Fetch.continueRequest', { requestId: p.requestId });
  } catch (e) { /* the page went away */ }
});
// hold the requests `match` takes until release(): {paused, next(), release()}
function hold(match) {
  const h = { paused: [], match: (r) => r.method !== 'OPTIONS' && match(r) };
  h.handle = async (p) => { h.paused.push(p); };
  h.next = (label, i = 0) => until(() => h.paused[i], label || 'a held request');
  h.release = async () => {
    hooks.splice(hooks.indexOf(h), 1);
    for (const p of h.paused.splice(0)) await S('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  };
  hooks.push(h);
  return h;
}
// answer the requests `match` takes with fn(request) -> {status, body, headers}
function answer(match, fn) {
  const h = { match: (r) => r.method !== 'OPTIONS' && match(r), count: 0 };
  h.handle = async (p) => {
    h.count++;
    const out = await fn(p.request);
    if (out === 'fail') { await S('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }); return; }
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': PAGES_ORIGIN, ...(out.headers || {}) };
    await S('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: out.status || 200,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: Buffer.from(out.body || '').toString('base64') });
  };
  h.off = () => { const i = hooks.indexOf(h); if (i >= 0) hooks.splice(i, 1); };
  hooks.push(h);
  return h;
}

await S('Page.enable');
await S('Runtime.enable');
await S('DOM.enable');
await S('Network.enable');
await S('Network.setCacheDisabled', { cacheDisabled: true });
await S('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
await S('Page.setInterceptFileChooserDialog', { enabled: true });
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Target.setDiscoverTargets', { discover: true });
await send('Browser.grantPermissions', { origin: PAGES_ORIGIN, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
// before any page script: this origin's pages use the local Worker and no qb-td-live
await S('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('qbtdServer', ${q(BASE)});
  localStorage.setItem('qbtdLive', 'off'); } catch (e) {}` });

const withLocal = (u) => u + (u.includes('?') ? '&' : '?') + 'server=' + E(BASE) + '&live=off';
async function goto(url) {
  const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, 'load of ' + url);
  await S('Page.navigate', { url });
  await loaded;
}
const home = () => goto(withLocal(`${PAGES}/index.html`));
const adminUrl = (secret) => withLocal(`${PAGES}/index.html?a=${secret}`);
async function js(expression) {
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function waitJs(expr, label, ms) {
  try { return await until(() => js(expr), label, ms); } catch (e) {
    let seen = '';
    try { seen = await js(`((document.querySelector('#msg') || {}).textContent || '') + ' || ' + document.body.innerText.slice(0, 500)`); } catch (e2) { /* gone */ }
    throw new Error(e.message + ' — page: ' + seen.replace(/\s+/g, ' '));
  }
}
const click = (sel) => js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
const fill = (sel, value, events = ['input', 'change']) => js(`(() => {
  const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
  e.value = ${q(value)}; for (const t of ${q(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); return true; })()`);
const text = (sel) => js(`(() => { const e = document.querySelector(${q(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const exists = (sel) => js(`!!document.querySelector(${q(sel)})`);
const msgNow = () => js(`({ text: document.querySelector('#msg').textContent, bad: document.querySelector('#msg').classList.contains('bad'),
  show: document.querySelector('#msg').classList.contains('show') })`);
const clearMsg = () => js(`(() => { const m = document.querySelector('#msg'); m.textContent = ''; m.className = ''; return true; })()`);
// a notice: its text exactly, red or not
const sayIs = (t, bad = false, label) => waitJs(`(() => { const m = document.querySelector('#msg');
  return m.textContent === ${q(t)} && m.classList.contains('show') && m.classList.contains('bad') === ${bad}; })()`, label || 'the notice ' + t);
// typed as a person types: focus, select what's there, then the keys
async function typeInto(sel, value) {
  await js(`(() => { const e = document.querySelector(${q(sel)}); e.focus(); e.select(); return true; })()`);
  if (value === '') {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  } else await S('Input.insertText', { text: value });
}
async function setFiles(sel, files) {
  const { root } = await S('DOM.getDocument', { depth: 0 });
  const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) throw new Error('no file input ' + sel);
  await S('DOM.setFileInputFiles', { nodeId, files });
}
async function clickPick(sel, files) {
  const opened = once((m) => m.sessionId === sessionId && m.method === 'Page.fileChooserOpened', 10000, 'file chooser');
  await click(sel);
  const { params } = await opened;
  await S('DOM.setFileInputFiles', { backendNodeId: params.backendNodeId, files });
}
async function download(sel) {
  const before = new Set(downloads.keys());
  await click(sel);
  const guid = await until(() => [...downloads.keys()].find((g) => !before.has(g) && downloads.get(g).done), 'download from ' + sel);
  return { name: downloads.get(guid).name, bytes: readFileSync(path.join(dlDir, guid)) };
}
// a click that opens a new tab: the URL it opened
async function newTab(sel) {
  const n = newTabs.length;
  await click(sel);
  return (await until(() => newTabs[n], 'a new tab from ' + sel, 10000)).url;
}
// the next dialog(s) answered thus; returns the messages once they came.
// An answer no dialog took is taken back, so it can't answer a later one.
async function withDialogs(list, fn, { optional = false, ms = 10000 } = {}) {
  const n = dialogs.length;
  const queued = answers.length;
  answers.push(...list);
  try {
    await fn();
    // optional: a question that never comes is an answer too (the messages that did)
    await until(() => dialogs.length >= n + list.length, 'the question(s) asked', optional ? 3000 : ms).catch((e) => { if (!optional) throw e; });
  } finally {
    const asked = dialogs.length - n;
    answers.splice(queued, Math.max(0, list.length - asked));
  }
  return dialogs.slice(n, n + list.length).map((d) => d.message);
}
// a packet row's file name (a placed packet's grip is not part of it)
const pkName = (k) => js(`(() => { const x = document.querySelector('.pktable tr[data-round="${k}"] .pkitem'); return x ? x.lastChild.textContent : null; })()`);
const reqCount = (pred) => reqs.filter((r) => r.method !== 'OPTIONS' && pred(r)).length;
const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return u; } };
const clip = () => js('navigator.clipboard.readText()');
// the page's own clock words: fmtWhen (admin.js), toLocaleString, shortDay
const pageWhen = (ms) => js(`new Date(${ms}).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })`);
const pageLocale = (ms) => js(`new Date(${ms}).toLocaleString()`);
const pageDay = (ms) => js(`new Date(${ms}).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })`);
// a real mouse drag of `src` onto `dst` (DevTools drag interception)
async function center(sel) {
  return js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
    e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
// Both ends must be on screen at once: the window grows to the page's height
// for the drag (the layout's width is unchanged), and goes back after.
async function drag(src, dst) {
  const tall = await js(`Math.max(1000, document.documentElement.scrollHeight + 40)`);
  if (tall > 1000) {
    await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: tall, deviceScaleFactor: 1, mobile: false });
    await js(`window.scrollTo(0, 0); true`);
  }
  await S('Input.setInterceptDrags', { enabled: true });
  try {
    const rect = (sel) => js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom }; })()`);
    const a = await rect(src);
    const b = await rect(dst);
    if (b.top < 0 || b.bottom > tall || a.top < 0 || a.bottom > tall) throw new Error('drag ends off screen: ' + src + ' → ' + dst);
    const got = once((m) => m.sessionId === sessionId && m.method === 'Input.dragIntercepted', 5000, 'the drag to start');
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + 8, y: a.y + 8, button: 'left', buttons: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1 });
    const { params: { data } } = await got;
    for (const type of ['dragEnter', 'dragOver', 'drop']) await S('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
    return data;
  } finally {
    await S('Input.setInterceptDrags', { enabled: false });
    if (tall > 1000) await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
}
// a file from the desktop dropped onto `dst`
async function dropFile(dst, file) {
  const b = await center(dst);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await S('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data });
}
// the reader: start a game on round `round` (two different teams), then
// press MODAQ's "Upload to qb-td"; returns what the page said
async function readerStartAndUpload(round) {
  await waitJs(`document.querySelectorAll('#roundrows [data-round]').length > 0 && !document.querySelector('#picker').hidden`, 'the reader\'s pre-game screen');
  await js(`(() => { const r = document.querySelector('#roundrows [data-round="${round}"]'); if (r) r.click(); return true; })()`);
  await js(`(() => { const a = document.querySelector('#teama'), b = document.querySelector('#teamb');
    if (a && b && (!a.value || a.value === b.value)) {
      const vals = [...a.options].map((o) => o.value).filter(Boolean);
      a.value = vals[0]; a.dispatchEvent(new Event('change'));
      b.value = vals.find((v) => v !== a.value); b.dispatchEvent(new Event('change'));
    } return true; })()`);
  await click('#start');
  await waitJs(`document.body.classList.contains('reading') && document.querySelector('#modaq').innerText.replace(/\\s+/g, ' ').includes('tossup 1:')`, 'MODAQ', 30000);
  const findUp = `[...document.querySelectorAll('#modaq button')].find((x) => x.textContent.trim() === 'Upload to qb-td')`;
  await waitJs(`(() => { const b = ${findUp}; return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; })()`, 'Upload to qb-td enabled');
  return withDialogs([true], () => js(`(() => { ${findUp}.click(); return true; })()`));
}
async function openHub(T, stepName) {
  await goto(adminUrl(T.secret));
  await waitJs(`!!document.querySelector('.hubtab')`, 'the hub of ' + T.name);
  if (stepName) await openStep(stepName);
}
async function openStep(step) {
  if (!(await exists('.stepbtn'))) { await click('[data-view="setup"]'); await waitJs(`!!document.querySelector('.stepbtn')`, 'the step list'); }
  await click(`[data-step="${step}"]`);
  await waitJs(`(document.querySelector('.stepbtn.on') || {}).dataset.step === ${q(step)}`, 'the ' + step + ' step');
}
const stepDetail = (step) => text(`[data-step="${step}"] .sdetail`);
const stepDone = (step) => js(`document.querySelector('[data-step="${step}"] .mark').classList.contains('done')`);

async function runSection(name, fn) {
  section = name;
  answers.length = 0;
  console.log('\n== ' + name);
  try { await fn(); } catch (e) { ok(`${name}: the section ran to its end`, false, e.stack || e.message); }
}

/* ================= HOME: the create form, this device's list, the rail ================= */

let T1 = null; // the tournament most of the setup sections work on (made on the home page)

await runSection('HOME', async () => {
  resetIp();
  await home();
  await waitJs(`!!document.querySelector('#newname')`, 'the home page');

  // HOME-07: nothing on this device yet
  await check('HOME-07 empty: the list says None yet, with a link to how it works', () => js(`(() => {
    const f = document.querySelector('details[data-fold="yours"]');
    const n = f.querySelector('.trow.none'); const a = n && n.querySelector('a');
    return !!n && n.textContent.replace(/\\s+/g, ' ').trim() === 'None yet. Create one above, or see how it works first.'
      && a.getAttribute('href') === 'about.html#demo' && f.querySelector('summary h2').textContent === 'Your tournaments'
      && f.querySelector('summary .muted').textContent === '0 on this device'; })()`));

  // HOME-01 / HOME-02: the URL name follows the name, and says where the public page will be
  const slugNow = () => js(`document.querySelector('#newslug').value`);
  const hintNow = () => js(`document.querySelector('#newhint').textContent`);
  await typeInto('#newname', 'Café Open @ USC, 2026!');
  ok('HOME-01 slug: accents fold and other characters become hyphens', (await slugNow()) === 'cafe-open-usc-2026', await slugNow());
  ok('HOME-02 hint: "Public page: <pages>/t.html?t=<slug>" while the URL name has text',
    (await hintNow()) === `Public page: ${PAGES}/t.html?t=cafe-open-usc-2026`, await hintNow());
  await typeInto('#newname', 'aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd eeee');
  ok('HOME-01 slug: at most 40 characters, with no hyphen left at the end',
    (await slugNow()) === 'aaaaaaaaa-bbbbbbbbb-ccccccccc-ddddddddd', await slugNow());
  await typeInto('#newslug', 'my-own-url');
  await typeInto('#newname', 'Something Else Entirely');
  ok('HOME-01 slug: a URL name the TD typed stops following the name', (await slugNow()) === 'my-own-url', await slugNow());
  await typeInto('#newslug', '');
  ok('HOME-02 hint: empty while the URL name is blank', (await hintNow()) === '' && (await slugNow()) === '', await hintNow());
  await typeInto('#newname', 'Spring Open');
  ok('HOME-01 slug: clearing the URL name hands it back to the name', (await slugNow()) === 'spring-open', await slugNow());

  // HOME-03 / HOME-05: create, as the TD does
  const slug1 = 'setup-suite-' + rnd();
  await typeInto('#newname', 'Setup Suite Open');
  await typeInto('#newslug', slug1);
  const h = hold((r) => r.method === 'POST' && r.url === BASE + '/api/tournaments');
  await click('#newbtn');
  const paused = await h.next('the create request');
  await check('HOME-03 create: the button spins and says Creating… while it works', () => js(`(() => {
    const b = document.querySelector('#newbtn');
    return b.disabled && !!b.querySelector('.spin') && b.textContent.trim() === 'Creating…'; })()`));
  {
    let body = {};
    try { body = JSON.parse(paused.request.postData || '{}'); } catch (e) { /* not JSON */ }
    ok('HOME-03 create: it posts the name and URL name with rounds opening themselves (settings.autoAdvance true)',
      body.name === 'Setup Suite Open' && body.slug === slug1 && body.settings && body.settings.autoAdvance === true, body);
  }
  await h.release();
  await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the Save this link modal');
  const link = await text('#modallink');
  const secret = (/[?&]a=([a-z0-9]+)/.exec(link) || [])[1];
  T1 = { name: 'Setup Suite Open', slug: slug1, secret, A: '/a/' + secret };
  ok('HOME-05 modal: shows the full admin link', link === `${PAGES}/index.html?a=${secret}`, link);
  const d = await detail(T1);
  T1.id = d.tournament && d.tournament.id;
  ok('HOME-03 create: the Worker has the tournament, rounds opening themselves',
    d.tournament && d.tournament.slug === slug1 && settingsOf(d).autoAdvance === true, d.tournament);
  ok('HOME-05 modal: the setup deadline is creation plus 7 days', d.tournament.closes - d.tournament.created === 7 * DAY,
    [d.tournament.created, d.tournament.closes]);
  ok('HOME-05 modal: and is shown in local time', (await text('#modalcloses')) === await pageLocale(d.tournament.closes),
    [await text('#modalcloses'), await pageLocale(d.tournament.closes)]);
  ok('HOME-03 create: the tournament joins this device\'s list', await js(`(() => {
    const l = JSON.parse(localStorage.getItem('qbtdAdminLinks') || '[]');
    return l.length === 1 && l[0].secret === ${q(secret)} && l[0].slug === ${q(slug1)} && l[0].name === 'Setup Suite Open'; })()`));
  await click('#modalcopy');
  await sayIs('Copied admin link');
  ok('HOME-05 modal: Copy link puts the admin link on the clipboard', (await clip()) === link);
  {
    const nav = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 20000, 'the admin link to open');
    await click('#modalok');
    await nav;
  }
  ok('HOME-05 modal: Saved it opens the admin link', here === link, here);
  await waitJs(`!!document.querySelector('.hubtab')`, 'the hub');

  // HOME-06: the list
  await home();
  await waitJs(`!!document.querySelector('details[data-fold="yours"] .trow')`, 'the list');
  const shortClose = await pageDay(d.tournament.closes);
  await check('HOME-06 list: an open tournament links to its admin link, "open until <Mon D>"', () => js(`(() => {
    const r = document.querySelector('details[data-fold="yours"] .trow'); const a = r.querySelector('a.nm');
    return !!a && a.textContent === 'Setup Suite Open' && a.href === ${q(link)} && r.querySelector('.st').textContent === ${q('open until ' + shortClose)}
      && document.querySelector('details[data-fold="yours"] summary .muted').textContent === '1 on this device'; })()`));
  const TB = await apiTournament('Second Device Open');
  await openHub(TB);
  await home();
  await waitJs(`document.querySelectorAll('details[data-fold="yours"] .trow').length === 2`, 'two entries');
  ok('HOME-06 list: opening an admin link adds it, newest first', JSON.stringify(await js(`[...document.querySelectorAll('details[data-fold="yours"] .trow .nm')].map((x) => x.textContent)`))
    === JSON.stringify(['Second Device Open', 'Setup Suite Open']) && (await text('details[data-fold="yours"] summary .muted')) === '2 on this device');

  // HOME-08: Remove asks, Cancel keeps, OK forgets only this device's entry
  const forgetSel = `[data-forget="${secret}"]`;
  let asked = await withDialogs([false], () => click(forgetSel));
  ok('HOME-08 remove: asks before removing an open one, and says the tournament is not deleted',
    asked[0] === 'Remove "Setup Suite Open" from this device?\n\nThe tournament itself is not deleted: its rooms and public page keep working. '
      + 'This device forgets its admin link, so keep a copy if you still need to manage it.', asked[0]);
  ok('HOME-08 remove: Cancel keeps it', await exists(forgetSel) && !(await msgNow()).show);
  await withDialogs([true], () => click(forgetSel));
  await sayIs('Removed Setup Suite Open from this device');
  ok('HOME-08 remove: OK takes it off this device\'s list and redraws',
    !(await exists(forgetSel)) && (await text('details[data-fold="yours"] summary .muted')) === '1 on this device'
      && !(await js(`localStorage.getItem('qbtdAdminLinks')`)).includes(secret));
  {
    const r = await call(T1.A);
    ok('HOME-08 remove: the tournament itself keeps working', r.status === 200 && r.body.tournament.slug === slug1, r.status);
  }
  // opening the admin link brings it back, first
  await openHub(T1);
  await home();
  await waitJs(`!!document.querySelector(${q(forgetSel)})`, 'the entry back');
  ok('HOME-06 list: opening the admin link again puts it back, first', (await text('details[data-fold="yours"] .trow .nm')) === 'Setup Suite Open');

  // the fold remembers, per device
  await click('details[data-fold="yours"] summary');
  await waitJs(`!document.querySelector('details[data-fold="yours"]').open`, 'the fold closed');
  await home();
  await waitJs(`!!document.querySelector('details[data-fold="yours"]')`, 'the list');
  ok('HOME-06 fold: closed stays closed after a reload', !(await js(`document.querySelector('details[data-fold="yours"]').open`)));
  await click('details[data-fold="yours"] summary');
  await waitJs(`document.querySelector('details[data-fold="yours"]').open`, 'the fold open');
  await home();
  await waitJs(`!!document.querySelector('details[data-fold="yours"]')`, 'the list');
  ok('HOME-06 fold: open stays open after a reload', await js(`document.querySelector('details[data-fold="yours"]').open`));

  // at most 30: a device with 30 already keeps the newest 30
  const real = await js(`localStorage.getItem('qbtdAdminLinks')`);
  await js(`(() => { const l = JSON.parse(localStorage.getItem('qbtdAdminLinks'));
    for (let i = l.length; i < 30; i++) l.push({ secret: 'fake' + i + 'aaaaaaaaaaaa', slug: 'fake-' + i, name: 'Old ' + i, closes: Date.now() + 86400000, created: 1000 + i });
    localStorage.setItem('qbtdAdminLinks', JSON.stringify(l)); return true; })()`);
  const TC = await apiTournament('Thirty First Open');
  await openHub(TC);
  await home();
  await waitJs(`document.querySelectorAll('details[data-fold="yours"] .trow').length >= 30`, 'the full list');
  ok('HOME-06 list: at most 30, the newest kept', await js(`(() => {
    const names = [...document.querySelectorAll('details[data-fold="yours"] .trow .nm')].map((x) => x.textContent);
    return names.length === 30 && names[0] === 'Thirty First Open' && !names.includes('Old 29')
      && document.querySelector('details[data-fold="yours"] summary .muted').textContent === '30 on this device'; })()`));
  await js(`localStorage.setItem('qbtdAdminLinks', ${q(real)}); true`);

  // HOME-04: each refusal is a red notice that stays, and the button works again
  await home();
  await waitJs(`!!document.querySelector('#newname')`, 'the home page');
  const ip = d1rows(`SELECT creator_ip FROM tournaments WHERE slug = '${slug1}'`)[0].creator_ip;
  const tryCreate = async (name, slug, want, label, tag = '') => {
    await typeInto('#newname', name);
    await typeInto('#newslug', slug);
    await clearMsg();
    await click('#newbtn');
    await check(`HOME-04 error: ${label} says "${want}" in red${tag ? ' ' + tag : ''}`, () => sayIs(want, true, label));
    await check(`HOME-04 error: after ${label} the button is usable again, and no link is shown`, () => js(`(() => {
      const b = document.querySelector('#newbtn');
      return !b.disabled && b.textContent.trim() === 'Create tournament' && !b.querySelector('.spin') && document.querySelector('#linkmodal').hidden; })()`));
  };
  await tryCreate('Bad Slug Open', 'ab', 'URL name must be 3-40 characters: a-z, 0-9, hyphens', 'a short URL name');
  await sleep(4600);
  ok('HOME-04 error: the red notice is still up after the 4 seconds a confirmation lasts', (await msgNow()).show);
  await click('#msg');
  ok('HOME-04 error: and a click dismisses it', !(await msgNow()).show);
  await tryCreate('Under Score Open', 'under_score', 'URL name must be 3-40 characters: a-z, 0-9, hyphens', 'an underscore');
  await tryCreate('Demo Again', 'demo', 'that URL name is reserved', 'demo');
  await tryCreate('Directory Open', 'directory', 'that URL name is reserved', 'directory');
  await tryCreate('', 'nameless-open-' + rnd(), 'name required', 'an empty name');
  await tryCreate('Taken Open', slug1, 'that URL name is already taken', 'a taken URL name');
  // 20 a day from one address
  d1(`INSERT INTO tournaments (slug, name, admin_secret, creator_ip, created) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
    SELECT 'filler-ip-' || i, 'Filler', 'filler-ip-secret-' || i, '${ip}', ${Date.now()} FROM n`);
  await tryCreate('Limit Open', 'limit-open-' + rnd(), 'creation limit reached, try again tomorrow', '20 made today from this address');
  d1("UPDATE tournaments SET created = 1 WHERE slug LIKE 'filler-ip-%'");
  // 300 a day overall
  d1(`INSERT INTO tournaments (slug, name, admin_secret, creator_ip, created) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
    SELECT 'filler-all-' || i, 'Filler', 'filler-all-secret-' || i, 'filler-elsewhere', ${Date.now()} FROM n`);
  await tryCreate('Limit Open', 'limit-open-' + rnd(), 'creation limit reached, try again tomorrow', '300 made today overall');
  d1("UPDATE tournaments SET created = 1 WHERE slug LIKE 'filler-all-%'");
  // a Worker that throws (its database refuses the query)
  d1('ALTER TABLE tournaments RENAME COLUMN creator_ip TO creator_ip_suite_off');
  try {
    await tryCreate('Crash Open', 'crash-open-' + rnd(), SERVER_FAIL, 'a Worker failure', CH.server);
  } finally {
    d1('ALTER TABLE tournaments RENAME COLUMN creator_ip_suite_off TO creator_ip');
  }
  {
    const r = await call('/api/tournaments', { method: 'POST', json: { name: 'After Crash', slug: 'after-crash-' + rnd() } });
    ok('HOME-04 error: creation works again once the database is back', r.status === 200, r.body);
  }
  resetIp();
});

/* ================= INVITE: a set's mirror started from its invite ================= */

let SET = null;   // { secret, slug, name, S }
let MIRROR = null; // the tournament started from the invite
const makeSet = async (name) => {
  const slug = 'suite-set-' + rnd();
  const r = await call('/api/sets', { method: 'POST', json: { name, slug } });
  if (r.status !== 200) throw new Error('set: ' + JSON.stringify(r.body));
  return { name, slug, secret: r.body.admin_secret, id: r.body.id, S: '/s/' + r.body.admin_secret };
};
const makeInvite = async (set, name, extra = {}) => {
  const r = await call(`${set.S}/mirrors`, { method: 'POST', json: { name, slug: 'suite-mirror-' + rnd(), ...extra } });
  if (r.status !== 200) throw new Error('invite: ' + JSON.stringify(r.body));
  return { invite: r.body.invite, id: r.body.id, slug: r.body.slug || null };
};
const SET_PACKETS = { 1: packetJson('SetR1'), 2: packetJson('SetR2') };

await runSection('INVITE', async () => {
  SET = await makeSet('Suite Set');
  for (const n of [1, 2]) {
    const r = await call(`${SET.S}/packet?packet=${n}&name=${E('Set Round ' + n + '.json')}`, { method: 'POST', body: SET_PACKETS[n] });
    if (r.status !== 200) throw new Error('set packet: ' + JSON.stringify(r.body));
  }
  await call(`${SET.S}/tiebreakers?name=set%20backups.json`, { method: 'POST', body: tbJson('SetBackup', 1) });
  await call(SET.S, { method: 'POST', json: { settings: { gameFormat: 'acf' } } });
  const inv = await makeInvite(SET, 'Suite Mirror', { host: 'Host University', event_date: '2026-11-07' });
  const invRow = (await call('/i/' + inv.invite)).body;

  await goto(withLocal(`${PAGES}/index.html?i=${inv.invite}`));
  await waitJs(`!!document.querySelector('#invstart')`, 'the invite page');
  ok('INV-01 invite: says whose mirror it is', (await text('#view h2')) === 'Mirror of Suite Set', await text('#view h2'));
  ok('INV-01 invite: the mirror\'s name, host and date', (await text('#view .card > div')) === 'Suite Mirror Host University 2026-11-07',
    await text('#view .card > div'));
  {
    const t = await text('#view');
    ok('INV-01 invite: the packet count and what comes with it', t.includes('2 packets, the set’s backup questions and the reader’s game format come with it'), t);
    ok('INV-01 invite: explains the week of setup, the 48 hours, and that it works once',
      t.includes('Creating the tournament gives you a week to set it up.') && t.includes('The 48-hour clock only starts when you press Start tournament')
        && t.includes('This invite can be used once.'), t);
  }
  ok('INV-01 invite: Name and URL name come filled in', (await js(`document.querySelector('#invname').value`)) === 'Suite Mirror'
    && (await js(`document.querySelector('#invslug').value`)) === invRow.slug, invRow.slug);

  // INV-02: a bad or taken URL name, then the real start
  const tryStart = async (slug, want, label) => {
    await fill('#invslug', slug);
    await clearMsg();
    await click('#invstart');
    await check(`INV-02 invite: ${label} says "${want}" in red`, () => sayIs(want, true, label));
    await check(`INV-02 invite: after ${label} the button works again and the invite is still unused`, async () =>
      (await js(`(() => { const b = document.querySelector('#invstart'); return !b.disabled && b.textContent.trim() === 'Create tournament'; })()`))
        && (await call('/i/' + inv.invite)).body.started === null);
  };
  await tryStart('x', 'URL name must be 3-40 characters: a-z, 0-9, hyphens', 'a bad URL name');
  await tryStart(T1.slug, 'that URL name is already taken', 'a taken URL name');
  await fill('#invslug', invRow.slug);
  await fill('#invname', 'Suite Mirror Open');
  const before = await js(`JSON.parse(localStorage.getItem('qbtdAdminLinks') || '[]').length`);
  const h = hold((r) => r.method === 'POST' && r.url === `${BASE}/i/${inv.invite}`);
  await click('#invstart');
  await h.next('the start request');
  ok('INV-01 invite: Create tournament spins and says Creating…', await js(`(() => { const b = document.querySelector('#invstart');
    return b.disabled && !!b.querySelector('.spin') && b.textContent.trim() === 'Creating…'; })()`));
  await h.release();
  await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the Save this link modal');
  const link = await text('#modallink');
  const secret = (/[?&]a=([a-z0-9]+)/.exec(link) || [])[1];
  MIRROR = { name: 'Suite Mirror Open', slug: invRow.slug, secret, A: '/a/' + secret };
  ok('INV-01 invite: the Save this link modal shows the new admin link', !!secret && link === `${PAGES}/index.html?a=${secret}`, link);
  ok('INV-01 invite: the mirror joins this device\'s list', await js(`(() => {
    const l = JSON.parse(localStorage.getItem('qbtdAdminLinks') || '[]');
    return l.length === ${before + 1} && l[0].secret === ${q(secret)} && l[0].name === 'Suite Mirror Open'; })()`));
  {
    const nav = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 20000, 'the mirror to open');
    await click('#modalok');
    await nav;
  }
  await waitJs(`!!document.querySelector('.hubtab')`, 'the mirror\'s hub');
  // HUB-05: the mirror line
  ok('HUB-05 mirror line: "Mirror of <set>", with no set page link while the set page is off',
    await js(`(() => { const x = [...document.querySelectorAll('.hubhead .muted')].find((e) => /^Mirror of/.test(e.textContent));
      return !!x && x.textContent.trim() === 'Mirror of Suite Set' && !x.querySelector('a'); })()`));
  await openStep('packets');
  await waitJs(`document.querySelectorAll('.pktable tr[data-round]').length === 2`, 'the set\'s rounds');
  ok('INV-01 mirror: starts with the set\'s rounds, each "(from <set>)"', JSON.stringify(await js(`[...document.querySelectorAll('.pktable tr[data-round]')]
    .map((tr) => tr.querySelector('.pkitem') ? tr.querySelector('.pkitem').lastChild.textContent : '')`))
    === JSON.stringify(['Set Round 1.json (from Suite Set)', 'Set Round 2.json (from Suite Set)']));
  ok('INV-01 mirror: and the set\'s backup questions, marked as from the set, with no Remove', await js(`(() => {
    const rows = [...document.querySelectorAll('#setupsec table tr')].filter((tr) => tr.textContent.includes('SetBackup TB answer 1'));
    return rows.length === 1 && rows[0].textContent.includes('(set backups.json, from the set)') && !rows[0].querySelector('[data-tbremove]'); })()`));
  ok('INV-01 mirror: and the set\'s game format', (await stepDetail('modaq')) === 'ACF (no powers)', await stepDetail('modaq'));
  // PK-09 / PK-12 on a mirror: no grips, and an empty round has nothing to drop
  ok('PK-09 mirror: a mirror\'s packets have no drag grip', !(await exists('.pktable [data-move]')));
  await click('#addslot');
  await waitJs(`document.querySelectorAll('.pktable tr[data-round]').length === 3`, 'a third round');
  ok('PK-12 mirror: an empty round says only "No packet yet", with only the upload icon', await js(`(() => {
    const tr = document.querySelector('.pktable tr[data-round="3"]');
    return tr.querySelector('.pkfile').textContent.replace(/\\s+/g, ' ').trim() === 'No packet yet'
      && !tr.querySelector('[data-preview]') && !tr.querySelector('a[download]') && tr.querySelector('[data-pickround="3"]').title === 'Upload'; })()`));
  // PK-11 on a mirror: a set packet downloads under its own name
  {
    const got = await download('.pktable tr[data-round="1"] a[download]');
    ok('PK-11 mirror: the set\'s packet on a round downloads, under its name and bytes', got.name === 'Set Round 1.json'
      && got.bytes.toString('utf8') === SET_PACKETS[1], got.name);
  }
  // TB-04 / TB-05 on a mirror: own questions go, the set's stay
  await setFiles('#tbfile', [writeFx('own mirror tb.json', tbJson('MirrorOwn', 2))]);
  await waitJs(`document.querySelector('#setupsec').textContent.includes('MirrorOwn TB answer 2')`, 'the mirror\'s own questions');
  ok('TB-04 mirror: the mirror\'s own questions have Remove, the set\'s do not', await js(`(() => {
    const rows = [...document.querySelectorAll('#setupsec table tr')];
    const own = rows.filter((tr) => tr.textContent.includes('MirrorOwn')); const set = rows.filter((tr) => tr.textContent.includes('SetBackup'));
    return own.length === 2 && own.every((tr) => tr.querySelector('[data-tbremove]')) && set.length === 1 && !set[0].querySelector('[data-tbremove]'); })()`));
  await withDialogs([true], () => click('#tbclear'));
  await waitJs(`!document.querySelector('#setupsec').textContent.includes('MirrorOwn')`, 'own questions gone');
  ok('TB-05 mirror: Delete pool removes only the tournament\'s own questions',
    (await text('#setupsec')).includes('SetBackup TB answer 1') && !(await text('#setupsec')).includes('No tiebreaker questions yet'));
  // HUB-05: with the set page published, a link to it
  await call(SET.S, { method: 'POST', json: { published: true } });
  await openHub(MIRROR);
  ok('HUB-05 mirror line: "· set page" links to the published set page', await js(`(() => {
    const x = [...document.querySelectorAll('.hubhead .muted')].find((e) => /^Mirror of/.test(e.textContent)); const a = x && x.querySelector('a');
    return !!a && x.textContent.replace(/\\s+/g, ' ').trim() === 'Mirror of Suite Set · set page' && a.textContent === 'set page'
      && a.href === ${q(`${PAGES}/s.html?s=${SET.slug}`)} && a.target === '_blank'; })()`));

  // INV-02: used, invalid, revoked, closed
  const allLink = () => js(`[...document.querySelectorAll('#view a')].some((a) => a.textContent === 'All tournaments' && a.getAttribute('href') === 'index.html')`);
  await goto(withLocal(`${PAGES}/index.html?i=${inv.invite}`));
  const usedAt = (await call('/i/' + inv.invite)).body.started;
  await check('INV-02 invite: used once already, it says when, and to ask the set\'s editors for a new one', async () => sayIs(
    `This mirror was already started on ${await pageLocale(usedAt)}. Its admin link was shown then — ask the set’s editors for a new invite if it is lost.`, true));
  ok('INV-02 invite: with an All tournaments link (used)', await allLink() && !(await exists('#invstart')));
  await goto(withLocal(`${PAGES}/index.html?i=abcdefghjkmnpqrstuvw`));
  await check('INV-02 invite: an invalid invite is "not valid (it may have been revoked)"', () => sayIs('This invite link is not valid (it may have been revoked)', true));
  ok('INV-02 invite: with an All tournaments link (invalid)', await allLink());
  const inv2 = await makeInvite(SET, 'Revoked Mirror');
  await call(`${SET.S}/mirrors/${inv2.id}`, { method: 'POST', json: { revoked: true } });
  await goto(withLocal(`${PAGES}/index.html?i=${inv2.invite}`));
  await check('INV-02 invite: a revoked invite says the same', () => sayIs('This invite link is not valid (it may have been revoked)', true));
  const oldSet = await makeSet('Old Set');
  const inv3 = await makeInvite(oldSet, 'Late Mirror');
  d1(`UPDATE sets SET created = created - ${366 * DAY} WHERE id = ${oldSet.id}`);
  await goto(withLocal(`${PAGES}/index.html?i=${inv3.invite}`));
  await check('INV-02 invite: a closed set says "This set has closed"', () => sayIs('This set has closed', true));
  ok('INV-02 invite: with an All tournaments link (closed set)', await allLink());
});

/* ================= a mirror's rounds: which set packet each one reads ================= */

let setRound2Name = 'Set Round 2.json';
await runSection('MIRROR ROUNDS', async () => {
  await openHub(MIRROR, 'packets');
  const reads = () => js(`(() => { const d = [...document.querySelectorAll('#setupsec details')].find((x) => x.querySelector('summary').textContent === 'Which packet each round reads');
    return d ? [...d.querySelectorAll('tr')].slice(1).map((tr) => [...tr.cells].slice(0, 2).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')
      + (tr.querySelector('select') ? ' | picker' : ' | ' + tr.cells[2].textContent.trim())) : null; })()`);
  ok('MIRROR rounds: "Which packet each round reads" lists each round\'s set packet and version, each with a picker',
    JSON.stringify(await reads()) === JSON.stringify(['1 | Packet 1 v1 | picker', '2 | Packet 2 v1 | picker', '3 | — | picker']), await reads());
  ok('MIRROR rounds: the picker offers the set\'s packets, and No packet where there is one', await js(`(() => {
    const o = (k) => [...document.querySelector('[data-setpacket="' + k + '"]').options].map((x) => x.textContent).join(',');
    return o(1) === 'Change…,Packet 1,Packet 2,No packet' && o(3) === 'Change…,Packet 1,Packet 2'; })()`));
  await clearMsg();
  await fill('[data-setpacket="3"]', '1', ['change']);
  await sayIs('Round 3 reads packet 1');
  await check('MIRROR rounds: a packet on two rounds is marked "also on round N" on both', () => waitJs(`(() => {
    const t = (k) => document.querySelector('[data-setpacket="' + k + '"]').closest('tr').cells[1].textContent.replace(/\\s+/g, ' ').trim();
    return t(3) === 'Packet 1 v1 also on round 1' && t(1) === 'Packet 1 v1 also on round 3'; })()`, 'the twice marks'));
  await clearMsg();
  await fill('[data-setpacket="3"]', 'none', ['change']);
  await sayIs('Round 3 has no packet now');
  await check('MIRROR rounds: No packet empties the round', async () => {
    const r = await until(async () => { const x = await reads(); return x && x[2] === '3 | — | picker' && x; }, 'round 3 empty', 8000);
    return JSON.stringify(r) === JSON.stringify(['1 | Packet 1 v1 | picker', '2 | Packet 2 v1 | picker', '3 | — | picker'])
      && !(await detail(MIRROR)).rounds.some((x) => x.number === 3);
  });
  await clearMsg();
  await clickPick('[data-pickround="3"]', [writeFx('Own Mirror Round 3.json', packetJson('MirrorR3'))]);
  await sayIs('Round 3: Own Mirror Round 3.json');
  await check('MIRROR rounds: a packet the TD uploads is "Your own packet (not part of the set’s stats)"', async () =>
    !!(await until(async () => { const r = await reads(); return r && r[2] === '3 | Your own packet (not part of the set’s stats) | picker'; }, 'own packet', 8000))
      && (await pkName(3)) === 'Own Mirror Round 3.json');
  // a fix from the set's editors reaches a round no room has opened
  const fix = await call(`${SET.S}/packet?packet=2&name=${E('Set Round 2 fixed.json')}`, { method: 'POST', body: packetJson('SetR2fix') });
  if (fix.status === 200) setRound2Name = 'Set Round 2 fixed.json';
  await openHub(MIRROR, 'packets');
  ok('MIRROR rounds: a fix the set\'s editors upload reaches a round with no games', (await reads())[1] === '2 | Packet 2 v2 | picker'
    && (await pkName(2)) === 'Set Round 2 fixed.json (from Suite Set)', [await reads(), await pkName(2)]);
  // a played round keeps its version and has no picker
  const room = (await call(`${MIRROR.A}/buckets`, { method: 'POST', json: { room_name: 'Mirror Room 1' } })).body;
  await call(`${MIRROR.A}/start`, { method: 'POST' });
  await roomUpload(room, 1, 'Round_1_Alpha_Bravo.qbj', JSON.stringify(matchFor(1, 'Alpha', 'Bravo')));
  await call(`${SET.S}/packet?packet=1&name=${E('Set Round 1 fixed.json')}`, { method: 'POST', body: packetJson('SetR1fix') });
  await openHub(MIRROR);
  if (!(await exists('.stepbtn'))) await click('[data-view="setup"]');
  await openStep('packets');
  ok('MIRROR rounds: a round with games says Played, keeps the version it was read with, and says the set has moved on',
    (await reads())[0] === '1 | Packet 1 v1 — the set is on v2; this round stays on what it was opened with | Played', (await reads())[0]);
});

/* ================= HUB: header, steps, views ================= */

await runSection('HUB', async () => {
  await openHub(T1);
  const d = await detail(T1);
  ok('HUB-01 load: a tournament with setup to do opens on Setup',
    await js(`document.querySelector('.hubtab[data-view="setup"]').classList.contains('on') && document.querySelectorAll('.stepbtn').length === 6`));
  // HUB-02 header
  const when = await pageWhen(d.tournament.closes);
  ok('HUB-02 header: the name, "Not started · setup open until <Mon D, h:mm>" and the slug', await js(`(() => {
    const h = document.querySelector('.hubtitle');
    return h.querySelector('h1').textContent === 'Setup Suite Open'
      && h.querySelector('span.muted:not(.slug)').textContent.replace(/\\s+/g, ' ').trim() === ${q('Not started · setup open until ' + when)}
      && h.querySelector('.slug').textContent === ${q(T1.slug)}; })()`), await text('.hubtitle'));
  ok('HUB-02 header: Setup carries a dot while setup is incomplete', await exists('.hubtab[data-view="setup"] .ndot'));
  await click('.hubnav button.linkbtn:not(#rotate)');
  await sayIs('Copied public link');
  ok('HUB-02 header: Copy public link copies t.html?t=<slug>', (await clip()) === `${PAGES}/t.html?t=${T1.slug}`, await clip());
  ok('HUB-02 header: Open public page opens the public page in a new tab',
    (await newTab('.hubnav a[target="_blank"]')).startsWith(`${PAGES}/t.html?t=${T1.slug}`));
  ok('HUB-02 header: the public page mark and New admin link are there', await exists('.hubnav #pubmark') && (await text('#rotate')) === 'New admin link');
  // HUB-06 the step list as it starts
  const details = async () => js(`[...document.querySelectorAll('.stepbtn')].map((b) => b.dataset.step + ':' + (b.querySelector('.mark').classList.contains('done') ? '✓' : '○')
    + ':' + b.querySelector('.mark').textContent + ':' + b.querySelector('.sdetail').textContent)`);
  ok('HUB-06 steps: a new tournament: None yet, 0/1 rounds, Not saved, Public, all ○', JSON.stringify(await details()) === JSON.stringify([
    'rooms:○:○:None yet', 'roster:○:○:None yet', 'sched:○:○:None yet', 'packets:○:○:0/1 rounds', 'modaq:○:○:Not saved', 'stats:○:○:Public']), await details());
  // HUB-07 / START-02: the Live view's banners
  const e0 = pageErrors.length;
  await click('[data-view="live"]');
  await waitJs(`!!document.querySelector('#gosetup')`, 'the Live view');
  // With no rooms the Live view is drawn and wired without an error (the
  // round controls are drawn only with rooms), and its Start tournament asks
  {
    const errs = pageErrors.slice(e0).filter((x) => /renderLive/.test(x));
    const asked = await withDialogs([false], () => click('#livestart'));
    ok('START-02 live: with no rooms yet, the Live view is drawn without an error and its Start tournament asks the question; Cancel does nothing',
      errs.length === 0 && /^Start the tournament\?/.test(asked[0] || '') && !reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/start`), [errs, asked]);
  }
  ok('START-02 live: before Start, "Not started" with a Start tournament button', await js(`(() => {
    const b = [...document.querySelectorAll('.banner')].find((x) => x.querySelector('#livestart'));
    return !!b && b.textContent.replace(/\\s+/g, ' ').trim() === 'Not started Room links show “Tournament hasn’t started” until you start it. Start tournament'; })()`),
  await text('.banner'));
  ok('HUB-07 live: "Setup incomplete · Still to do: <steps>" with Open setup', await js(`(() => {
    const b = [...document.querySelectorAll('.banner')].find((x) => x.querySelector('#gosetup'));
    return !!b && b.querySelector('.warntext').textContent === 'Setup incomplete'
      && b.querySelector('.muted').textContent === 'Still to do: Rooms, Roster, Schedule, Packets, MODAQ Settings, Public page'
      && b.querySelector('#gosetup').textContent === 'Open setup'; })()`));
  await click('#gosetup');
  await check('HUB-07 live: Open setup switches to Setup', () => waitJs(`document.querySelector('.hubtab[data-view="setup"]').classList.contains('on')
    && !!document.querySelector('.stepbtn')`, 'Setup'));
});

/* ================= ROOMS ================= */

let BYE = null;
await runSection('ROOMS', async () => {
  await openHub(T1, 'rooms');
  ok('ROOMS-01 empty: "No rooms yet", and "Create [8] rooms" with Create rooms', await js(`(() => {
    const s = document.querySelector('#setupsec');
    const lab = document.querySelector('#roomn').closest('label');
    return [...s.querySelectorAll('.muted')].some((x) => x.textContent === 'No rooms yet') && document.querySelector('#roomn').value === '8'
      && lab.textContent.replace(/\\s+/g, ' ').trim() === 'Create rooms' && document.querySelector('#mkrooms').textContent === 'Create rooms'; })()`));
  await fill('#roomn', '3', ['input']);
  let n = 0;
  const h = hold((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/buckets` && ++n === 2);
  await click('#mkrooms');
  await h.next('the second room');
  ok('ROOMS-01 create: each room\'s row shows as it is made, "Links ready in a moment"', await js(`(() => {
    const rows = [...document.querySelectorAll('.roomtable tr.fresh')];
    return rows.length === 1 && JSON.stringify([...rows[0].cells].map((c) => c.textContent.trim())) === '["Room 1","Links ready in a moment","0",""]'; })()`),
  await js(`[...document.querySelectorAll('.roomtable tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join('|'))`));
  ok('HUB-10 busy: the button spins and counts, "Creating rooms… 2 of 3", with a progress bar', await js(`(() => {
    const b = document.querySelector('#mkrooms');
    return b.disabled && !!b.querySelector('.spin') && b.textContent.trim() === 'Creating rooms… 2 of 3' && !!document.querySelector('#setupsec .busybar'); })()`),
  await text('#mkrooms'));
  const sent = reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/buckets`);
  await click('#mkrooms');
  await sleep(150);
  ok('HUB-10 busy: pressing it again sends nothing', reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/buckets`) === sent);
  await h.release();
  await sayIs('3 rooms created');
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 3`, 'three room rows');
  ok('ROOMS-01 create: Room 1…3, with their links, once done', JSON.stringify(await js(`[...document.querySelectorAll('[data-roomrename]')].map((x) => x.value)`))
    === JSON.stringify(['Room 1', 'Room 2', 'Room 3']) && !(await exists('#setupsec .busybar')));
  // ROOMS-11: the Bye Room, made once, kept apart
  let d = await until(async () => { const x = await detail(T1); return byeOf(x) && x; }, 'the Bye Room');
  BYE = byeOf(d);
  ok('ROOMS-11 bye: the hub makes one "Bye Room" and keeps it as settings.byeRoom', BYE.room_name === 'Bye Room'
    && d.buckets.filter((b) => /^Bye Room/.test(b.room_name)).length === 1);
  await waitJs(`!!document.querySelector('.byesec')`, 'the Bye Room section');
  ok('ROOMS-11 bye: not in the room table or the room count', (await js(`document.querySelectorAll('.roomtable [data-roomrename]').length`)) === 3
    && !(await js(`[...document.querySelectorAll('.roomtable input')].some((x) => /Bye/.test(x.value))`)) && (await stepDetail('rooms')) === '3 rooms');
  // ROOMS-07 the note before Start
  ok('ROOMS-07 note: before Start, what room links and Test links do, and the Bye Room for scrims ' + CH.note,
    (await text('#setupsec p.muted')) === 'Room links show “Tournament hasn’t started” until you press Start tournament. Test simulates a room for json testing purposes '
      + 'without needing to start the tournament. Games that are exported from test rooms are NOT saved. Please use the Bye Room link for unofficial scrims, since nothing played there is saved.',
    await text('#setupsec p.muted'));
  // ROOMS-12 the Bye Room's link
  const byeLink = `${PAGES}/read.html?b=${BYE.secret}&test=bye`;
  ok('ROOMS-12 bye: below the table, "Bye Room" with Copy and Open, and its note', await js(`(() => {
    const s = document.querySelector('.byesec'); const a = s.querySelector('a');
    return s.querySelector('strong').textContent === 'Bye Room' && s.querySelector('#copybye').textContent === 'Copy'
      && a.textContent === 'Open' && a.href === ${q(byeLink)} && a.target === '_blank'
      && s.querySelector('p.muted').textContent === 'Bye Room can be used by several readers at once and does not export or save results.'; })()`));
  await click('#copybye');
  await sayIs('Copied Bye Room link');
  ok('ROOMS-12 bye: Copy puts read.html?b=<bye>&test=bye on the clipboard', (await clip()) === byeLink, await clip());
  ok('ROOMS-12 bye: Open opens it in a new tab', (await newTab('.byesec a')) === byeLink);
  // ROOMS-05: per-room Copy and Open
  const rooms = roomsOf(d);
  ok('ROOMS-05 room: Open opens the room\'s reader link in a new tab', (await newTab('.roomtable tr:nth-child(2) .linkpair a.muted')) === `${PAGES}/read.html?b=${rooms[0].secret}`);
  await click('.roomtable tr:nth-child(3) .linkpair button');
  await sayIs('Copied Room 2 reader link');
  ok('ROOMS-05 room: Copy says "Copied <room> reader link", with no admin secret in it', (await clip()) === `${PAGES}/read.html?b=${rooms[1].secret}`
    && !(await clip()).includes(T1.secret));
  // ROOMS-10: Copy all
  await click('#copyrooms');
  await sayIs('Copied all room links');
  {
    const c = await clip();
    ok('ROOMS-10 copy all: one "<room>: <reader link>" line a room, in order, no Test links, no Bye Room',
      c === rooms.map((b) => `${b.room_name}: ${PAGES}/read.html?b=${b.secret}`).join('\n') && !c.includes('test=') && !c.includes('Bye'), c);
  }
  // ROOMS-02: Add more, the others wait, names continue
  ok('ROOMS-02 add: with rooms, "Add [2] more rooms" / Add rooms', (await js(`document.querySelector('#roomn').value`)) === '2'
    && (await js(`document.querySelector('#roomn').closest('label').textContent.replace(/\\s+/g, ' ').trim()`)) === 'Add more rooms'
    && (await text('#mkrooms')) === 'Add rooms');
  n = 0;
  const h2 = hold((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/buckets` && ++n === 1);
  await click('#mkrooms');
  await h2.next('the first added room');
  ok('HUB-10 busy: the other buttons of the step wait while rooms are made', await js(`(() => {
    const others = [...document.querySelectorAll('#setupsec button')].filter((b) => b.id !== 'mkrooms');
    return others.length >= 8 && others.every((b) => b.disabled) && document.querySelector('#mkrooms').textContent.trim() === 'Creating rooms… 1 of 2'; })()`));
  await h2.release();
  await sayIs('2 rooms created');
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 5`, 'five rooms');
  ok('HUB-10 busy: and work again after', await js(`[...document.querySelectorAll('#setupsec button')].every((b) => !b.disabled)`));
  ok('ROOMS-02 add: new rooms continue after the highest "Room N"', JSON.stringify(await js(`[...document.querySelectorAll('[data-roomrename]')].map((x) => x.value)`))
    === JSON.stringify(['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Room 5']));
  await fill('#roomn', '0', ['input']);
  await click('#mkrooms');
  await sayIs('1 room created');
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 6`, 'six rooms');
  ok('ROOMS-02 add: a count under 1 makes one room', (await js(`[...document.querySelectorAll('[data-roomrename]')].map((x) => x.value).pop()`)) === 'Room 6');
  // ROOMS-04: inline rename, trimmed; a blank name is not saved
  d = await detail(T1);
  const r6 = roomsOf(d).find((b) => b.room_name === 'Room 6');
  await fill(`[data-roomrename="${r6.id}"]`, '  Room 10  ', ['change']);
  await sayIs('Renamed to Room 10');
  ok('ROOMS-04 rename: the trimmed name is saved', (await until(async () => roomsOf(await detail(T1)).find((b) => b.id === r6.id).room_name === 'Room 10', 'rename')));
  await waitJs(`document.querySelector('[data-roomrename="${r6.id}"]').value === 'Room 10'`, 'the renamed row');
  await fill('#roomn', '1', ['input']);
  await click('#mkrooms');
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 7`, 'seven rooms');
  ok('ROOMS-02 add: after a "Room 10", the next is Room 11', (await js(`[...document.querySelectorAll('[data-roomrename]')].map((x) => x.value).pop()`)) === 'Room 11');
  const renames = reqCount((r) => r.method === 'POST' && /\/buckets\/\d+$/.test(pathOf(r.url)));
  await clearMsg();
  await fill(`[data-roomrename="${r6.id}"]`, '   ', ['change']);
  await sleep(300);
  ok('ROOMS-04 rename: a blank name is not saved', reqCount((r) => r.method === 'POST' && /\/buckets\/\d+$/.test(pathOf(r.url))) === renames
    && roomsOf(await detail(T1)).find((b) => b.id === r6.id).room_name === 'Room 10' && !(await msgNow()).show);
  ok('ROOMS-04 rename: the blank field stays blank until the next redraw (reported)', (await js(`document.querySelector('[data-roomrename="${r6.id}"]').value`)) === '');
  await openStep('rooms');
  ok('ROOMS-04 rename: the next redraw shows the saved name again', (await js(`document.querySelector('[data-roomrename="${r6.id}"]').value`)) === 'Room 10');
  // ROOMS-09: Remove asks; Cancel keeps; OK removes, and its link stops reading
  d = await detail(T1);
  const r11 = roomsOf(d).find((b) => b.room_name === 'Room 11');
  const dels = () => reqCount((r) => r.method === 'DELETE' && pathOf(r.url) === `${T1.A}/buckets/${r11.id}`);
  let asked = await withDialogs([false], () => click(`[data-delbucket="${r11.id}"]`));
  ok('ROOMS-09 remove: asks "Remove this room? Its link stops working. Uploaded files stay."', asked[0] === 'Remove this room? Its link stops working. Uploaded files stay.', asked);
  ok('ROOMS-09 remove: Cancel keeps it', dels() === 0 && await exists(`[data-roomrename="${r11.id}"]`) && roomsOf(await detail(T1)).some((b) => b.id === r11.id));
  await withDialogs([true], () => click(`[data-delbucket="${r11.id}"]`));
  await waitJs(`!document.querySelector('[data-roomrename="${r11.id}"]')`, 'the row gone');
  ok('ROOMS-09 remove: OK removes it and redraws', !roomsOf(await detail(T1)).some((b) => b.id === r11.id));
  await goto(withLocal(`${PAGES}/read.html?b=${r11.secret}`));
  await check('ROOMS-09 remove: the removed room\'s link no longer reads ("bad link")', () => waitJs(`document.querySelector('#msg').textContent === 'bad link'`, 'bad link'));

  // names continue after the room count when that is higher; a taken "Bye Room" makes "Bye Room 2"
  const TN = await apiTournament('Named Rooms Open');
  for (const name of ['Hall A', 'Bye Room', 'Room 1']) await call(`${TN.A}/buckets`, { method: 'POST', json: { room_name: name } });
  await openHub(TN, 'rooms');
  const dn = await until(async () => { const x = await detail(TN); return byeOf(x) && x; }, 'the Bye Room of a tournament with a "Bye Room"');
  ok('ROOMS-11 bye: when "Bye Room" is taken, the hub makes "Bye Room 2"', byeOf(dn).room_name === 'Bye Room 2', byeOf(dn));
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 3`, 'three rows');
  await fill('#roomn', '1', ['input']);
  await click('#mkrooms');
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 4`, 'four rows');
  ok('ROOMS-02 add: names continue after the room count when it is higher than the last "Room N"',
    (await js(`[...document.querySelectorAll('[data-roomrename]')].map((x) => x.value).pop()`)) === 'Room 4');
});

/* ================= ROSTER + SCHEDULE for T1, then leaving unsaved edits ================= */

let schedRounds = 0;
await runSection('SCHEDULE GUARD', async () => {
  const r = await call(`${T1.A}/roster?name=roster.qbj`, { method: 'POST', body: rosterJson });
  if (r.status !== 200) throw new Error('roster: ' + JSON.stringify(r.body));
  await openHub(T1, 'sched');
  await waitJs(`!!document.querySelector('#schedgen') && !document.querySelector('#schedgen').disabled`, 'the format picker');
  const h = hold((x) => x.method === 'POST' && pathOf(x.url) === `${T1.A}/schedule`);
  await click('#schedgen');
  await h.next('the schedule save');
  ok('HUB-10 busy: Generate says "Generating…" with a spinner', await js(`(() => { const b = document.querySelector('#schedgen');
    return !!b && b.disabled && !!b.querySelector('.spin') && b.textContent.trim() === 'Generating…'; })()`), await text('#schedgen'));
  await h.release();
  await sayIs('Schedule saved');
  const sched = await until(async () => { const x = await call(`${T1.A}/file?key=${E(`t/${T1.id}/schedule.json`)}`); return x.status === 200 && x.body; }, 'the saved schedule');
  schedRounds = Math.max(...sched.phases.flatMap((p) => p.rounds.map((x) => x.round)));
  await waitJs(`!!document.querySelector('#schedaddround')`, 'the editor');
  // HUB-08: unsaved edits ask before leaving
  await click('#schedaddround');
  await waitJs(`!document.querySelector('#schedsave').disabled`, 'an unsaved edit');
  let asked = await withDialogs([false], () => click('[data-step="rooms"]'));
  ok('HUB-08 leave: another step asks "The schedule has unsaved changes. Leave without saving?"', asked[0] === 'The schedule has unsaved changes. Leave without saving?', asked);
  ok('HUB-08 leave: Cancel stays on the schedule, edits kept', (await js(`document.querySelector('.stepbtn.on').dataset.step`)) === 'sched'
    && !(await js(`document.querySelector('#schedsave').disabled`)));
  asked = await withDialogs([false], () => click('[data-view="live"]'));
  ok('HUB-08 leave: the Live tab asks the same, and Cancel stays', asked[0] === 'The schedule has unsaved changes. Leave without saving?'
    && await js(`document.querySelector('.hubtab[data-view="setup"]').classList.contains('on') && !!document.querySelector('#schedsave')`));
  await js(`window.__stay = 1; true`);
  const n0 = dialogs.length;
  answers.push(false);
  await js(`setTimeout(() => location.reload(), 0); true`);
  await until(() => dialogs.length > n0, 'the leave warning');
  await sleep(300);
  ok('HUB-08 leave: reloading shows the browser\'s leave warning, and staying keeps the page', dialogs[n0].type === 'beforeunload'
    && await js(`window.__stay === 1 && !!document.querySelector('#schedsave') && !document.querySelector('#schedsave').disabled`), dialogs[n0]);
  await withDialogs([true], () => click('[data-step="rooms"]'));
  await waitJs(`(document.querySelector('.stepbtn.on') || {}).dataset.step === 'rooms'`, 'the rooms step');
  ok('HUB-08 leave: OK leaves the schedule', true);
  // throw the edit away so later steps start clean
  await openStep('sched');
  await waitJs(`!!document.querySelector('#scheddiscard')`, 'the editor');
  if (!(await js(`document.querySelector('#scheddiscard').disabled`))) await withDialogs([true], () => click('#scheddiscard'));
  await waitJs(`document.querySelector('#schedsave').disabled`, 'nothing unsaved');
});

/* ================= ROOMS-04: a room renamed, matched by name on the schedule ================= */

await runSection('ROOM RENAME ON THE SCHEDULE', async () => {
  const key = `t/${T1.id}/schedule.json`;
  const s = (await call(`${T1.A}/file?key=${E(key)}`)).body;
  const d = await detail(T1);
  const i = 1;
  const b = roomsOf(d).find((x) => x.id === s.rooms[i].bucket);
  s.rooms[i].bucket = null; // matched by its name only
  const put = await call(`${T1.A}/schedule`, { method: 'POST', json: s });
  if (put.status !== 200) throw new Error('schedule: ' + JSON.stringify(put.body));
  await openHub(T1, 'rooms');
  await fill(`[data-roomrename="${b.id}"]`, 'Hall Nine', ['change']);
  await sayIs('Renamed to Hall Nine');
  await check('ROOMS-04 rename: a schedule room matched by name follows the rename ' + CH.rename, async () =>
    !!(await until(async () => (await call(`${T1.A}/file?key=${E(key)}`)).body.rooms[i].name === 'Hall Nine', 'the saved schedule renamed', 8000)));
  await openStep('sched');
  await waitJs(`!!document.querySelector('.sgroom[data-room="${i}"]')`, 'the schedule rooms');
  ok('ROOMS-04 rename: this tab\'s schedule shows the new name ' + CH.rename, (await text(`.sgroom[data-room="${i}"]`)) === 'Hall Nine', await text(`.sgroom[data-room="${i}"]`));
  await click('#schedaddround');
  await waitJs(`!document.querySelector('#schedsave').disabled`, 'an edit');
  const n0 = dialogs.length;
  const h = hold((x) => x.method === 'POST' && pathOf(x.url) === `${T1.A}/schedule`);
  await click('#schedsave');
  await h.next('the save');
  ok('HUB-10 busy: Save schedule says "Saving…" with a spinner', await js(`(() => { const b = document.querySelector('#schedsave');
    return b.disabled && !!b.querySelector('.spin') && b.textContent.trim() === 'Saving…'; })()`));
  await h.release();
  await sayIs('Schedule saved');
  const after = (await call(`${T1.A}/file?key=${E(key)}`)).body;
  ok('ROOMS-04 rename: the tab\'s next save is not questioned and keeps the rename and the edit ' + CH.rename,
    dialogs.length === n0 && after.rooms[i].name === 'Hall Nine' && Math.max(...after.phases.flatMap((p) => p.rounds.map((x) => x.round))) === schedRounds + 1,
    { asked: dialogs.slice(n0), room: after.rooms[i] });
  schedRounds += 1;
});

/* ================= PACKETS ================= */

const PK = {}; // round -> text uploaded
await runSection('PACKETS', async () => {
  // PK-01 on a tournament with no schedule: the count comes from the packets and settings
  const TP = await apiTournament('Packet Count Open');
  await openHub(TP, 'packets');
  ok('PK-01 count: with no schedule and no packets, "1 round", no note, one row', (await text('.pkcount')) === '1 round'
    && (await js(`document.querySelectorAll('.pktable tr[data-round]').length`)) === 1);
  await call(`${TP.A}/packet?round=4&name=${E('Late Round.json')}`, { method: 'POST', body: packetJson('Late') });
  await openHub(TP, 'packets');
  ok('PK-01 count: the highest round with a packet sets the count', (await text('.pkcount')) === '4 rounds'
    && (await js(`document.querySelectorAll('.pktable tr[data-round]').length`)) === 4);
  ok('PK-02 remove last: off at the last round holding a packet', await js(`document.querySelector('#dropslot').disabled`));
  await click('#addslot');
  await waitJs(`document.querySelector('.pkcount').textContent === '5 rounds'`, 'five rounds');
  ok('PK-02 add: Add a round saves settings.rounds + 1', settingsOf(await detail(TP)).rounds === 5 && !(await js(`document.querySelector('#dropslot').disabled`)));
  await click('#dropslot');
  await waitJs(`document.querySelector('.pkcount').textContent === '4 rounds'`, 'four rounds');
  ok('PK-02 remove last: saves settings.rounds - 1 and stops at the packet', settingsOf(await detail(TP)).rounds === 4 && await js(`document.querySelector('#dropslot').disabled`));
  await call(TP.A, { method: 'POST', json: { current_round: 7 } });
  await openHub(TP, 'packets');
  ok('PK-01 count: a live round past the packets sets the count, and Remove last stops there', (await text('.pkcount')) === '7 rounds'
    && (await js(`document.querySelectorAll('.pktable tr[data-round]').length`)) === 7 && await js(`document.querySelector('#dropslot').disabled`), await text('.pkcount'));

  // T1: the schedule's rounds
  await openHub(T1, 'packets');
  ok('PK-01 count: T1 has the schedule\'s rounds', (await text('.pkcount')) === `${schedRounds} rounds · from the schedule`, await text('.pkcount'));
  // PK-12: empty rows on a tournament of its own
  ok('PK-12 empty: "No packet yet · drop one here" (packets can be moved here), with only the upload icon', await js(`[...document.querySelectorAll('.pktable tr[data-round]')].every((tr) =>
    tr.querySelector('.pkfile').textContent.replace(/\\s+/g, ' ').trim() === 'No packet yet · drop one here'
      && !tr.querySelector('[data-preview]') && !tr.querySelector('a[download]') && tr.querySelector('[data-pickround]').title === 'Upload')`));
  // TB-03: no pool yet
  ok('TB-03 list: with no pool, "No tiebreaker questions yet" and no Delete pool', (await text('#setupsec')).includes('No tiebreaker questions yet') && !(await exists('#tbclear')));

  // PK-03 zip staging
  const zip = (name, entries) => writeFx(name, Buffer.from(makeZip(entries.map(([n, data]) => ({ name: n, data })))));
  PK[1] = packetJson('R1');
  PK[2] = packetJson('R2');
  PK[3] = packetJson('R3');
  const z1 = zip('packets.zip', [['Round 1.json', PK[1]], ['pk/Round 2.json', PK[2]], ['__MACOSX/pk/._Round 2.json', 'junk'],
    ['pk/.hidden.json', '{}'], ['notes.txt', 'hello'], ['Extra Packet.json', packetJson('Extra')]]);
  await clearMsg();
  await setFiles('#zipfile', [z1]);
  await sayIs('3 packets staged');
  ok('PK-03 zip: its .json entries are staged by file name, skipping __MACOSX and dot files, each with "→ Round N" when the name has one',
    JSON.stringify(await js(`[...document.querySelectorAll('.pkstaged .chip')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())`))
      === JSON.stringify(['Round 1.json → Round 1', 'Round 2.json → Round 2', 'Extra Packet.json']),
    await js(`[...document.querySelectorAll('.pkstaged .chip')].map((c) => c.textContent)`));
  ok('PK-12 empty: still "· drop one here" with chips staged', (await text('.pktable tr[data-round="1"] .pkfile')) === 'No packet yet · drop one here');
  // PK-06 Clear
  const packetPosts = () => reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/packet`);
  const p0 = packetPosts();
  await click('#zipclear');
  await waitJs(`!document.querySelector('.pkstaged')`, 'no chips');
  ok('PK-06 clear: Clear empties the staged chips and uploads nothing', packetPosts() === p0 && (await detail(T1)).rounds.length === 0);
  await clearMsg();
  await setFiles('#zipfile', [zip('nothing.zip', [['readme.txt', 'no packets here'], ['__MACOSX/._x.json', 'junk']])]);
  await check('PK-03 zip: a zip with no packets says "No .json or .docx files in the zip"', () => sayIs('No .json or .docx files in the zip', true));
  ok('PK-03 zip: after a zip with no packets the section is usable again at once, "Upload packet zip" and its buttons on',
    await js(`(() => { const b = document.querySelector('#pickzip');
      return !b.disabled && b.textContent.trim() !== 'Reading zip…' && !document.querySelector('#pickfiles').disabled
        && !document.querySelector('#picktb').disabled && !document.querySelector('#addslot').disabled; })()`), await text('#pickzip'));
  await openStep('packets');
  await clearMsg();
  await setFiles('#zipfile', [writeFx('broken.zip', 'this is not a zip file at all')]);
  await check('PK-03 zip: an unreadable zip shows its error in red', () => waitJs(`(() => { const m = document.querySelector('#msg');
    return m.classList.contains('show') && m.classList.contains('bad') && m.textContent.length > 0; })()`, 'a red error'));
  ok('PK-03 zip: and stages nothing, the button usable again', !(await exists('.pkstaged')) && !(await js(`document.querySelector('#pickzip').disabled`)));
  // PK-04 loose files
  await clearMsg();
  await setFiles('#pfiles', [writeFx('Round 3.json', PK[3]), writeFx('Spare.json', packetJson('Spare'))]);
  await sayIs('2 packets staged');
  ok('PK-04 files: loose files are staged as chips, "N packets staged"', JSON.stringify(await js(`[...document.querySelectorAll('.pkstaged .chip')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())`))
    === JSON.stringify(['Round 3.json → Round 3', 'Spare.json']));
  await click('#zipclear');
  await waitJs(`!document.querySelector('.pkstaged')`, 'no chips');

  // PK-08 (no games): one file straight onto round 2
  await clearMsg();
  await clickPick('[data-pickround="2"]', [writeFx('Round 2.json', PK[2])]);
  await sayIs('Round 2: Round 2.json');
  await waitJs(`((document.querySelector('.pktable tr[data-round="2"] .pkitem') || {}).lastChild || {}).textContent === 'Round 2.json'`, 'round 2 filled');
  ok('PK-08 upload: the row\'s icon says Replace once the round has a packet', (await js(`document.querySelector('[data-pickround="2"]').title`)) === 'Replace');

  // PK-05 Assign by filename: collisions, an occupied round, out of range, a failure, with progress
  const files = [
    writeFx('Round 1.json', PK[1]),
    writeFx('Round 01 copy.json', packetJson('R1copy')), // same round as the one before it
    writeFx('Round 2 again.json', packetJson('R2again')), // round 2 has a packet
    writeFx('Round 3.json', PK[3]),
    writeFx('Round 4.json', ''), // the Worker refuses an empty file
    writeFx('Round 99.json', packetJson('R99')), // no such row
    writeFx('Spare.json', packetJson('Spare')),
  ];
  await clearMsg();
  await setFiles('#pfiles', files);
  await sayIs('7 packets staged');
  const h = hold((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/packet`);
  await click('#zipauto');
  await h.next('the first packet upload');
  ok('HUB-10 busy: Assign by filename counts, "Uploading packets… 1 of 3", with a bar, and the round being uploaded spins', await js(`(() => {
    const b = document.querySelector('#zipauto');
    return b.disabled && !!b.querySelector('.spin') && b.textContent.trim() === 'Uploading packets… 1 of 3' && !!document.querySelector('#setupsec .busybar')
      && document.querySelector('.pktable tr[data-round="1"]').classList.contains('up')
      && [...document.querySelectorAll('#setupsec button')].filter((x) => x.id !== 'zipauto').every((x) => x.disabled); })()`), await text('#zipauto'));
  await h.release();
  await check('PK-05 assign: a failed upload stays staged, and the notice names it',
    () => sayIs('Uploaded 2 of 3. Round 4.json: empty body. The rest are still staged: press Assign by filename to try again.', true));
  let d = await detail(T1);
  ok('PK-05 assign: only free rounds within the rows are filled, never over a packet or one taken in the same pass',
    JSON.stringify(d.rounds.map((r) => r.number + ':' + r.packet_name)) === JSON.stringify(['1:Round 1.json', '2:Round 2.json', '3:Round 3.json']),
    d.rounds.map((r) => r.number + ':' + r.packet_name));
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 5`, 'the leftovers');
  ok('PK-05 assign: the rows it filled name their packets', (await pkName(1)) === 'Round 1.json' && (await pkName(3)) === 'Round 3.json' && (await pkName(4)) === null);
  ok('PK-05 assign: the rest stay staged to drag', JSON.stringify(await js(`[...document.querySelectorAll('.pkstaged .chip')].map((c) => c.textContent.split(' →')[0].trim())`))
    === JSON.stringify(['Round 01 copy.json', 'Round 2 again.json', 'Round 99.json', 'Spare.json', 'Round 4.json']));
  await click('#zipclear');
  await waitJs(`!document.querySelector('.pkstaged')`, 'cleared');
  await setFiles('#pfiles', [writeFx('Round 2 again.json', packetJson('R2again')), writeFx('Spare.json', packetJson('Spare'))]);
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 2`, 'two chips');
  await clearMsg();
  await click('#zipauto');
  await check('PK-05 assign: with nothing placeable, "No staged packet has a free round in its name: drag them onto rounds"',
    () => sayIs('No staged packet has a free round in its name: drag them onto rounds', true));
  await click('#zipclear');
  await waitJs(`!document.querySelector('.pkstaged')`, 'cleared');
  PK[4] = packetJson('R4');
  await setFiles('#pfiles', [writeFx('Round 4.json', PK[4]), writeFx('Spare.json', packetJson('Spare'))]);
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 2`, 'two chips');
  await clearMsg();
  await click('#zipauto');
  await sayIs('1 assigned, 1 left to drag');
  ok('PK-05 assign: "N assigned, M left to drag"', (await detail(T1)).rounds.some((r) => r.number === 4 && r.packet_name === 'Round 4.json'));

  // PK-07: a chip dragged onto an empty round uploads there and leaves the chips
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 1`, 'the Spare chip');
  await drag('.pkstaged .chip[data-chip="0"]', '.pktable tr[data-round="5"]');
  await waitJs(`((document.querySelector('.pktable tr[data-round="5"] .pkitem') || {}).lastChild || {}).textContent === 'Spare.json'`, 'round 5 filled by the drop');
  ok('PK-07 drag: a dropped chip uploads to that round and is unstaged', !(await exists('.pkstaged'))
    && (await detail(T1)).rounds.some((r) => r.number === 5 && r.packet_name === 'Spare.json'));
  // a file from the desktop is not a chip
  await setFiles('#pfiles', [writeFx('Keep Me.json', packetJson('Keep'))]);
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 1`, 'one chip');
  const p1 = packetPosts();
  await dropFile('.pktable tr[data-round="6"]', writeFx('From Desktop.json', packetJson('Desk')));
  await sleep(400);
  ok('PK-07 drag: a file dragged in from the desktop is ignored, never taken as the first chip', packetPosts() === p1
    && !(await detail(T1)).rounds.some((r) => r.number === 6) && (await js(`document.querySelectorAll('.pkstaged .chip').length`)) === 1);
  await click('#zipclear');
  await waitJs(`!document.querySelector('.pkstaged')`, 'cleared');

  // PK-09: drag a placed packet: move, Undo; swap, Undo; no question with no games
  const roundsNow = async () => (await detail(T1)).rounds.map((r) => r.number + ':' + r.packet_name).join(',');
  const catsOf = async () => (await call(`/pub/${T1.slug}/cats`)).body;
  const cats0 = await catsOf();
  const n0 = dialogs.length;
  await drag('.pktable [data-move="1"]', '.pktable tr[data-round="6"]');
  await waitJs(`!!document.querySelector('.pkundo')`, 'the Undo bar');
  ok('PK-09 move: onto an empty round moves it, "Moved Round 1’s packet to Round 6."', (await text('.pkundo span')) === 'Moved Round 1’s packet to Round 6.'
    && (await roundsNow()) === '2:Round 2.json,3:Round 3.json,4:Round 4.json,5:Spare.json,6:Round 1.json', await roundsNow());
  {
    const c = await catsOf();
    ok('PK-09 move: its categories follow it', c && c.rounds && JSON.stringify(c.rounds['6']) === JSON.stringify(cats0.rounds['1']) && !c.rounds['1'],
      c && c.rounds && Object.keys(c.rounds));
  }
  await click('#pkundo');
  await waitJs(`!document.querySelector('.pkundo') && ((document.querySelector('.pktable tr[data-round="1"] .pkitem') || {}).lastChild || {}).textContent === 'Round 1.json'`, 'undone');
  ok('PK-09 move: Undo moves it back', (await roundsNow()) === '1:Round 1.json,2:Round 2.json,3:Round 3.json,4:Round 4.json,5:Spare.json');
  await drag('.pktable [data-move="1"]', '.pktable tr[data-round="3"]');
  await waitJs(`!!document.querySelector('.pkundo')`, 'the Undo bar');
  ok('PK-09 swap: onto a round with a packet swaps them, "Swapped rounds 1 and 3."', (await text('.pkundo span')) === 'Swapped rounds 1 and 3.'
    && (await roundsNow()) === '1:Round 3.json,2:Round 2.json,3:Round 1.json,4:Round 4.json,5:Spare.json', await roundsNow());
  await click('#pkundo');
  await waitJs(`!document.querySelector('.pkundo') && ((document.querySelector('.pktable tr[data-round="1"] .pkitem') || {}).lastChild || {}).textContent === 'Round 1.json'`, 'swap undone');
  ok('PK-09 swap: Undo swaps them back', (await roundsNow()) === '1:Round 1.json,2:Round 2.json,3:Round 3.json,4:Round 4.json,5:Spare.json');
  ok('PK-09: with no games in, nothing is asked', dialogs.length === n0, dialogs.slice(n0));

  // PK-10 preview
  await click('[data-preview="1"]');
  await waitJs(`!!document.querySelector('.pkview .pkcounts')`, 'the preview');
  ok('PK-10 preview: a dialog "Round 1 · Round 1.json" with Download and Close', await js(`(() => {
    const v = document.querySelector('.pkview');
    return v.getAttribute('role') === 'dialog' && v.querySelector('.pkviewname').textContent === 'Round 1 · Round 1.json'
      && !!v.querySelector('a[download]') && !!v.querySelector('[data-close]'); })()`));
  ok('PK-10 preview: the packet title and "20 tossups, 20 bonuses"', (await text('.pkview .pktitle')) === 'Round 1.json' && (await text('.pkview .pkcounts')) === '20 tossups, 20 bonuses');
  {
    const want = JSON.parse(PK[1]);
    const pairs = await js(`[...document.querySelectorAll('.pkview .pkpair')].map((s) => [...s.querySelectorAll('p')].map((p) => p.textContent.replace(/\\s+/g, ' ').trim()))`);
    const expect = want.tossups.map((tu, i) => {
      const b = want.bonuses[i];
      return [`${i + 1}. ${tu.question}`, `ANSWER: ${tu.answer}`, `<${tu.metadata}>`, `B${i + 1}. ${b.leadin}`,
        ...b.parts.flatMap((part, j) => [`[10] ${part}`, `ANSWER: ${b.answers[j]}`])];
    });
    ok('PK-10 preview: each tossup, its answer and metadata, then its bonus with [10] parts and answers, in order', JSON.stringify(pairs) === JSON.stringify(expect),
      JSON.stringify(pairs[0]) + ' vs ' + JSON.stringify(expect[0]));
  }
  await click('.pkview [data-close]');
  ok('PK-10 preview: × closes it', !(await exists('.pkview')));
  await click('[data-preview="2"]');
  await waitJs(`!!document.querySelector('.pkview .pkcounts')`, 'the preview again');
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await check('PK-10 preview: Esc closes it', () => waitJs(`!document.querySelector('.pkview')`, 'closed by Esc'));
  await click('[data-preview="3"]');
  await waitJs(`!!document.querySelector('.pkview .pkcounts')`, 'the preview again');
  await click('.pkview');
  ok('PK-10 preview: a click outside the page closes it', !(await exists('.pkview')));
  const bad = answer((r) => r.method === 'GET' && r.url.includes(`${T1.A}/file?key=`) && !r.url.includes('&dl='), () => ({ status: 404, body: '{"error":"not found"}' }));
  await clearMsg();
  await click('[data-preview="4"]');
  await check('PK-10 preview: a packet that cannot be loaded shows a red error in the dialog', () => waitJs(`(document.querySelector('.pkview .pkpage .bad') || {}).textContent === 'could not load the packet (404)'
    && document.querySelector('#msg').classList.contains('bad')`, 'the error'));
  bad.off();
  await click('.pkview [data-close]');

  // PK-11 download under the original name
  {
    const got = await download('.pktable tr[data-round="3"] a[download]');
    ok('PK-11 download: a round\'s packet downloads under its original name, as uploaded', got.name === 'Round 3.json' && got.bytes.toString('utf8') === PK[3], got.name);
  }

  // TB-01: one file, several files, refusals
  const tbPosts = () => reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/tiebreakers`);
  await clearMsg();
  const th = hold((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/tiebreakers`);
  await setFiles('#tbfile', [writeFx('tb one.json', tbJson('One', 2, 1))]);
  await th.next('the tiebreaker upload');
  ok('HUB-10 busy: the tiebreaker upload says "Splitting…"', (await text('#picktb')) === 'Splitting…' && await js(`document.querySelector('#picktb').disabled`));
  await th.release();
  await sayIs('tb one.json split into 2 tossups + 1 bonuses');
  await waitJs(`[...document.querySelectorAll('#setupsec table tr')].filter((tr) => tr.textContent.includes('Unused')).length === 3`, 'three questions');
  ok('TB-01 upload: the pool lists each question: id, Kind, answer (file), Unused', JSON.stringify(await js(`[...document.querySelectorAll('#setupsec table tr')]
    .filter((tr) => tr.querySelector('td.mono')).map((tr) => [...tr.querySelectorAll('td')].slice(0, 4).map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).join('|'))`))
    === JSON.stringify(['TU1|Tossup|One TB answer 1 (tb one.json)|Unused', 'TU2|Tossup|One TB answer 2 (tb one.json)|Unused',
      'B1|Bonus|One bx / One by / One bz (tb one.json)|Unused']), await text('#setupsec table'));
  for (const [name, body, want] of [
    ['tb bad.json', '{ not json', 'not valid JSON'],
    ['tb empty.json', '{}', 'packet JSON has no tossups or bonuses'],
    ['tb noanswer.json', JSON.stringify({ tossups: [{ question: 'A question with no answer.' }] }), 'a tossup is missing question or answer text'],
    ['tb noparts.json', JSON.stringify({ bonuses: [{ leadin: 'A bonus with nothing in it.' }] }), 'a bonus is missing parts or answers'],
  ]) {
    await clearMsg();
    await setFiles('#tbfile', [writeFx(name, body)]);
    await check(`TB-01 upload: the Worker's refusal shows, "${want}"`, () => sayIs(want, true));
  }
  const tp0 = tbPosts();
  await clearMsg();
  await setFiles('#tbfile', [writeFx('tb notes.txt', 'plain text')]);
  await check('TB-01 upload: another file type gives "Tiebreaker packets need to be .json or .docx files."', () => sayIs('Tiebreaker packets need to be .json or .docx files.', true));
  ok('TB-01 upload: and sends nothing', tbPosts() === tp0);
  await clearMsg();
  await setFiles('#tbfile', [writeFx('tb two.json', tbJson('Two', 1)), writeFx('tb three.json', tbJson('Three', 1))]);
  await sayIs('2 files were added to the pool.');
  ok('TB-01 upload: several files go one after another, in order', (await js(`[...document.querySelectorAll('#setupsec table td.mono')].map((x) => x.textContent).join(',')`)) === 'TU1,TU2,TU3,TU4,B1');
  await clearMsg();
  await setFiles('#tbfile', [writeFx('tb four.json', tbJson('Four', 1)), writeFx('tb bad.json', '{ not json'), writeFx('tb notes.txt', 'plain')]);
  await check('TB-01 upload: with some unreadable, "k of N files were added. These could not be read: …"',
    () => sayIs('1 of 3 files were added. These could not be read: tb bad.json, tb notes.txt.', true));

  // TB-02: a staged .json chip dropped on the tiebreaker target
  await setFiles('#pfiles', [writeFx('tb chip.json', tbJson('Chip', 1))]);
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 1`, 'the chip');
  await clearMsg();
  await drag('.pkstaged .chip[data-chip="0"]', '#tbdrop');
  await sayIs('tb chip.json split into 1 tossups + 0 bonuses');
  await waitJs(`!document.querySelector('.pkstaged') && document.querySelector('#setupsec').textContent.includes('Chip TB answer 1')`, 'split and unstaged');
  ok('TB-02 drop: a staged .json chip dropped on the target splits into the pool and is unstaged', true);

  // TB-03: the pool is fetched again only when it changes
  const tbGets = () => reqCount((r) => r.method === 'GET' && pathOf(r.url) === `${T1.A}/tiebreakers`);
  const g0 = tbGets();
  await click('#addslot');
  await waitJs(`document.querySelector('.pkcount').textContent.startsWith('${schedRounds + 1} rounds')`, 'a round added');
  ok('TB-03 list: a redraw after another change does not fetch the pool again ' + CH.tbperf, tbGets() === g0, tbGets() - g0);
  await click('#dropslot');
  await waitJs(`document.querySelector('.pkcount').textContent.startsWith('${schedRounds} rounds')`, 'back');

  // TB-04: remove one question
  const deletes = () => reqCount((r) => r.method === 'DELETE' && pathOf(r.url) === `${T1.A}/tiebreakers`);
  let asked = await withDialogs([false], () => click('[data-tbremove="TU3"]'));
  ok('TB-04 remove: asks "Remove TU3 from the pool?"', asked[0] === 'Remove TU3 from the pool?', asked);
  ok('TB-04 remove: Cancel keeps it', deletes() === 0 && await exists('[data-tbremove="TU3"]'));
  await clearMsg();
  await withDialogs([true], () => click('[data-tbremove="TU3"]'));
  await sayIs('TU3 was removed from the pool.');
  await waitJs(`!document.querySelector('[data-tbremove="TU3"]')`, 'TU3 gone');
  ok('TB-04 remove: OK removes it and the list refreshes', !((await call(`${T1.A}/tiebreakers`)).body.tossups || []).some((x) => x.id === 'TU3'));
  ok('TB-03 list: a change to the pool fetches it again', tbGets() > g0);

  // TB-05: Delete pool
  asked = await withDialogs([false], () => click('#tbclear'));
  ok('TB-05 delete: asks "Delete the tiebreaker pool? The usage log goes with it."', asked[0] === 'Delete the tiebreaker pool? The usage log goes with it.', asked);
  ok('TB-05 delete: Cancel keeps it', await exists('[data-tbremove="TU1"]'));
  await withDialogs([true], () => click('#tbclear'));
  await waitJs(`document.querySelector('#setupsec').textContent.includes('No tiebreaker questions yet')`, 'the empty pool');
  ok('TB-05 delete: OK empties it, and Delete pool is gone', !(await exists('#tbclear')) && !(await exists('[data-tbremove]')));
  // back to a small pool for the day
  await setFiles('#tbfile', [writeFx('tb day.json', tbJson('Day', 2))]);
  await waitJs(`document.querySelectorAll('[data-tbremove]').length === 2`, 'the day\'s pool');
});

/* ================= MODAQ + PUBLIC PAGE steps' details, and finishing setup ================= */

await runSection('STEP DETAILS', async () => {
  await openHub(T1, 'modaq');
  await fill('#gformat', 'acf', ['change']);
  await waitJs(`document.querySelector('[data-step="modaq"] .sdetail').textContent === 'ACF (no powers)'`, 'the format saved');
  const d = await detail(T1);
  ok('HUB-06 steps: with rooms, roster, schedule, packets and a format: N rooms, Saved, Saved, x/y rounds, the preset', JSON.stringify(await js(`[...document.querySelectorAll('.stepbtn')]
    .map((b) => b.dataset.step + ':' + (b.querySelector('.mark').classList.contains('done') ? '✓' : '○') + ':' + b.querySelector('.sdetail').textContent)`))
    === JSON.stringify([`rooms:✓:${roomsOf(d).length} rooms`, 'roster:✓:Saved', 'sched:✓:Saved', `packets:✓:${d.rounds.length}/${schedRounds} rounds`,
      'modaq:✓:ACF (no powers)', 'stats:○:Public']), await js(`[...document.querySelectorAll('.sdetail')].map((x) => x.textContent)`));
  // the last step: opening it finishes setup, and the page stays on Setup
  await openStep('stats');
  await waitJs(`document.querySelector('[data-step="stats"] .mark').classList.contains('done')`, 'the public page step done');
  ok('HUB-06 steps: finishing setup on the Public page step keeps the page on Setup, and the Setup dot goes',
    await js(`document.querySelector('.hubtab[data-view="setup"]').classList.contains('on') && !document.querySelector('.ndot') && !!document.querySelector('#pub')`));
  // Buzzpoints + Scoresheets on, behind a password
  await fill('#buzzmode', 'on', ['change']);
  await waitJs(`!!document.querySelector('#statspw')`, 'the password field');
  await fill('#statspw', 'hunter22', ['input']);
  const h = hold((r) => r.method === 'POST' && pathOf(r.url) === T1.A);
  await click('#pwset');
  await h.next('the password save');
  ok('HUB-10 busy: Set password says "Setting password…"', (await text('#pwset')) === 'Setting password…' && await js(`!!document.querySelector('#pwset .spin')`), await text('#pwset'));
  await h.release();
  await waitJs(`document.querySelector('[data-step="stats"] .sdetail').textContent === 'Public · Buzzpoints on'`, 'buzzpoints on');
  await waitJs(`!!document.querySelector('#sheetsmode')`, 'the scoresheets switch');
  await fill('#sheetsmode', 'on', ['change']);
  await check('HUB-06 steps: "Public · Scoresheets on · Buzzpoints on"', () => waitJs(`document.querySelector('[data-step="stats"] .sdetail').textContent === 'Public · Scoresheets on · Buzzpoints on'`, 'both on'));
  await js(`document.querySelector('#pub').checked = false; document.querySelector('#pub').dispatchEvent(new Event('change')); true`);
  await check('HUB-06 steps: with the page off, "Page off · …"', () => waitJs(`document.querySelector('[data-step="stats"] .sdetail').textContent === 'Page off · Scoresheets on · Buzzpoints on'`, 'page off'));
  await waitJs(`!!document.querySelector('#pub') && !document.querySelector('#pub').checked`, 'redrawn off');
  await js(`document.querySelector('#pub').checked = true; document.querySelector('#pub').dispatchEvent(new Event('change')); true`);
  await waitJs(`document.querySelector('[data-step="stats"] .sdetail').textContent === 'Public · Scoresheets on · Buzzpoints on'`, 'page on');
  // HUB-01: a tournament with every step done opens on Live
  await openHub(T1);
  await check('HUB-01 load: with every step done, the hub opens on Live', () => waitJs(`document.querySelector('.hubtab[data-view="live"]').classList.contains('on')
    && !!document.querySelector('.roundline') && !document.querySelector('#gosetup')`, 'the Live view'));
});

/* ================= HUB-03: the public page mark ================= */

await runSection('PUBLIC PAGE MARK', async () => {
  await openHub(T1, 'rooms');
  await waitJs(`/Updating/.test(document.querySelector('#pubmark').textContent)`, 'Updating after the changes');
  ok('HUB-03 mark: after a change it reads Updating, with what it means as a tooltip', (await js(`document.querySelector('#pubmark').title`)) === 'Viewers see this change within a couple of minutes');
  // the cron rebuilds and a minute passes: the mark moves on Setup without a redraw
  // the trigger answers before the tick is done, and a tick takes the oldest
  // few: tick until T1's rebuild is written, then a minute on
  await until(async () => { await tick(); return d1rows(`SELECT pub_dirty FROM tournaments WHERE id = ${T1.id}`)[0].pub_dirty === 0; },
    'the cron to rebuild T1', 60000);
  d1(`UPDATE tournaments SET pub_built = 1000, pub_dirty = 0 WHERE id = ${T1.id}`);
  await js(`document.querySelector('#setupsec').__probe = 1; document.querySelector('#roomn').value = '7'; true`);
  await js(`document.dispatchEvent(new Event('visibilitychange')); true`);
  await check('HUB-03 mark: once rebuilt it reads Up to date', () => waitJs(`/Up to date/.test(document.querySelector('#pubmark').textContent)
    && document.querySelector('#pubmark').title === 'Viewers see your latest changes'`, 'Up to date', 10000));
  ok('HUB-03 mark: on Setup it changes without redrawing the step', await js(`document.querySelector('#setupsec').__probe === 1 && document.querySelector('#roomn').value === '7'`));
  // Delayed: the Worker reports qb-td-live deploys failing (its answer changed in flight)
  const fake = answer((r) => r.method === 'GET' && r.url === BASE + T1.A, async () => {
    const real = await call(T1.A);
    real.body.tournament.live = { state: 'failing', at: null };
    real.body.tournament.pub_dirty = 0;
    return { status: 200, body: JSON.stringify(real.body) };
  });
  await openHub(T1, 'rooms');
  fake.off();
  ok('HUB-03 mark: while qb-td-live deploys fail it reads Delayed, with a tooltip', (await text('#pubmark')).endsWith('Delayed')
    && (await js(`document.querySelector('#pubmark').title`)) === 'Publishing to the public page is failing and retrying on its own. Viewers may see older results until it lands.',
  await text('#pubmark'));
});

/* ================= ROOMS-06 Test links in the reader, HUB-04 a new admin link ================= */

await runSection('TEST LINKS + NEW ADMIN LINK', async () => {
  await openHub(T1, 'rooms');
  const d = await detail(T1);
  const room = roomsOf(d)[0];
  const token = testTokenOf(T1.secret);
  // the first room's Test link, as the hub shows it
  const hubTest = () => js(`(() => { const a = [...document.querySelectorAll('.roomtable tr')][1].querySelectorAll('.linkpair a');
    const t = [...a].find((x) => x.textContent === 'Test'); return t ? t.href : null; })()`);
  const testHref = await hubTest();
  ok('ROOMS-06 test: each room has a Test link before Start', !!testHref && testHref.startsWith(`${PAGES}/read.html?b=${room.secret}&test=`), testHref);
  ok('ROOMS-06 test: it is read.html?b=<room>&test=<token from the admin secret>, never the secret ' + CH.test,
    testHref === `${PAGES}/read.html?b=${room.secret}&test=${token}` && ![...await js(`[...document.querySelectorAll('.roomtable a')].map((a) => a.href)`)].some((h) => h.includes(T1.secret)),
    testHref);
  // the reader, before Start, with the real packets and roster, saving nothing
  const starts0 = reqCount((r) => r.method === 'POST' && /\/start$/.test(pathOf(r.url)) && r.url.includes('/b/'));
  await goto(withLocal(testHref));
  await check('ROOMS-06 test: opened, the reader runs the room in test mode before Start', () => waitJs(`!document.querySelector('#teststrip').hidden
    && document.querySelector('#teststrip').textContent === 'This is a test room. Please do not send this link to moderators. Games that are exported from test rooms are NOT saved.'
    && document.querySelector('#testtag').textContent === 'Test game' && document.querySelector('#start').textContent === 'Start test game'
    && document.querySelectorAll('#roundrows [data-round]').length > 0`, 'test mode'));
  ok('ROOMS-06 test: with the tournament\'s rounds and roster', await js(`(() => {
    const opts = [...document.querySelectorAll('#teama option')].map((o) => o.textContent);
    return ${q(TEAMS)}.every((t) => opts.includes(t)) && [...document.querySelectorAll('#roundrows [data-round]')].some((x) => x.dataset.round === '1'); })()`));
  {
    const uploads0 = reqCount((r) => r.method === 'POST' && /\/upload$/.test(pathOf(r.url)));
    let said = null;
    try { said = await readerStartAndUpload(1); } catch (e) { said = e.message; }
    await check('ROOMS-06 test: Start test game reads the round\'s own packet in MODAQ', () => waitJs(`document.body.classList.contains('reading')
      && document.querySelector('#modaq').innerText.replace(/\\s+/g, ' ').includes('R1 tossup 1: this author wrote a novel')`, 'MODAQ with round 1', 30000));
    ok('ROOMS-06 test: its Upload to qb-td says "This is a test game, so nothing was uploaded." and sends nothing',
      Array.isArray(said) && said[0] === 'This is a test game, so nothing was uploaded.'
        && reqCount((r) => r.method === 'POST' && /\/upload$/.test(pathOf(r.url))) === uploads0, said);
    ok('ROOMS-06 test: and no start is recorded', reqCount((r) => r.method === 'POST' && /\/start$/.test(pathOf(r.url)) && r.url.includes('/b/')) === starts0
      && !((await detail(T1)).starts || []).length);
  }
  // the old style: the admin secret as the test key
  await goto(withLocal(`${PAGES}/read.html?b=${room.secret}&test=${T1.secret}`));
  await check('ROOMS-06 test: an old-style Test link (test=<admin secret>) is refused ' + CH.test, () => waitJs(`document.querySelector('#msg').textContent === "Tournament hasn't started. Reload this page once the TD starts it."
    && document.querySelector('#picker').hidden`, 'refused'));
  // the Bye Room reads before Start
  await goto(withLocal(`${PAGES}/read.html?b=${BYE.secret}&test=bye`));
  await check('ROOMS-12 bye: the Bye Room link reads before Start, as the Bye Room', () => waitJs(`!document.querySelector('#teststrip').hidden
    && document.querySelector('#teststrip').textContent === 'This is the Bye Room. Games read here are NOT saved.'
    && document.querySelector('#testtag').textContent === 'Bye Room' && document.querySelector('#start').textContent === 'Start bye-round game'
    && document.querySelectorAll('#roundrows [data-round]').length > 0`, 'the bye room'));

  // HUB-04: New admin link
  await openHub(T1, 'rooms');
  const rotates = () => reqCount((r) => r.method === 'POST' && r.url.endsWith('/rotate'));
  let asked = await withDialogs([false], () => click('#rotate'));
  ok('HUB-04 rotate: asks "Mint a new admin link? The current link stops working."', asked[0] === 'Mint a new admin link? The current link stops working.', asked);
  ok('HUB-04 rotate: Cancel does nothing', rotates() === 0 && here === adminUrl(T1.secret) && (await call(T1.A)).status === 200);
  const h = hold((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/rotate`);
  answers.push(true);
  await click('#rotate');
  await h.next('the rotate request');
  ok('HUB-04 rotate: "Making a new link…" while it works', (await text('#rotate')) === 'Making a new link…' && await js(`document.querySelector('#rotate').disabled`));
  await h.release();
  await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the Save this link modal');
  const link = await text('#modallink');
  const fresh = (/[?&]a=([a-z0-9]+)/.exec(link) || [])[1];
  ok('HUB-04 rotate: the URL now holds the new link', !!fresh && fresh !== T1.secret && (await js('location.search')) === '?a=' + fresh);
  ok('HUB-04 rotate: this device\'s list has the new link instead of the old', await js(`(() => { const l = JSON.parse(localStorage.getItem('qbtdAdminLinks') || '[]');
    return l.some((e) => e.secret === ${q(fresh)} && e.slug === ${q(T1.slug)}) && !l.some((e) => e.secret === ${q(T1.secret)}); })()`));
  ok('HUB-04 rotate: the Save this link modal shows it', link === `${PAGES}/index.html?a=${fresh}`);
  {
    const nav = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 20000, 'the reload');
    await click('#modalok');
    await nav;
  }
  await waitJs(`!!document.querySelector('.hubtab')`, 'the reloaded hub');
  ok('HUB-04 rotate: Saved it reloads the hub on the new link', here.includes('a=' + fresh));
  const old = { ...T1 };
  T1.secret = fresh;
  T1.A = '/a/' + fresh;
  if (!(await exists('.stepbtn'))) await click('[data-view="setup"]');
  await openStep('rooms');
  const newHref = await hubTest();
  ok('HUB-04 rotate: the reloaded page shows new Test links', !!newHref && newHref !== testHref && newHref.startsWith(`${PAGES}/read.html?b=${room.secret}&test=`), newHref);
  ok('HUB-04 rotate: carrying the new link\'s token, not its secret ' + CH.test, newHref === `${PAGES}/read.html?b=${room.secret}&test=${testTokenOf(fresh)}`, newHref);
  await goto(adminUrl(old.secret));
  await check('HUB-04 rotate: the old admin link fails ("bad link"), with an All tournaments link', () => waitJs(`document.querySelector('#msg').textContent === 'bad link'
    && [...document.querySelectorAll('#view a')].some((a) => a.textContent === 'All tournaments')`, 'bad link'));
  await goto(withLocal(testHref));
  await check('HUB-04 rotate: a Test link made with the old link stops working', () => waitJs(`document.querySelector('#msg').textContent === "Tournament hasn't started. Reload this page once the TD starts it."`, 'refused'));
  await goto(withLocal(newHref));
  await check('HUB-04 rotate: the new Test link reads the room', () => waitJs(`!document.querySelector('#teststrip').hidden && document.querySelectorAll('#roundrows [data-round]').length > 0`, 'test mode'));
});

/* ================= START, and what changes after it ================= */

await runSection('START', async () => {
  await openHub(T1);
  if (!(await exists('.stepbtn'))) await click('[data-view="setup"]');
  await openStep('rooms');
  const startPosts = () => reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/start`);
  const t0 = Date.now();
  let asked = await withDialogs([false], () => click('#starttour'));
  const m = /^Start the tournament\?\n\nRoom links start serving packets and taking games\. Your admin link and every room link stop working 48 hours from now, at (.+)\.$/.exec(asked[0] || '');
  const at = m ? await js(`Date.parse(${q(m[1])})`) : NaN;
  ok('START-01 start: the question says links start serving packets and close 48 hours from now, at <time>',
    !!m && Math.abs(at - (t0 + 48 * 3600 * 1000)) < 5 * 60 * 1000, asked[0]);
  ok('START-01 start: Cancel does nothing', startPosts() === 0 && !(await detail(T1)).tournament.started && await exists('#starttour'));
  // START-02 from the Live banner
  await click('[data-view="live"]');
  await waitJs(`!!document.querySelector('#livestart')`, 'the Not started banner');
  asked = await withDialogs([false], () => click('#livestart'));
  ok('START-02 live: the banner\'s Start tournament asks the same question; Cancel does nothing', /^Start the tournament\?/.test(asked[0]) && startPosts() === 0);
  const h = hold((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/start`);
  answers.push(true);
  await click('#livestart');
  await h.next('the start request');
  ok('START-02 live: "Starting…" while it works', (await text('#livestart')) === 'Starting…');
  await h.release();
  const d = await until(async () => { const x = await detail(T1); return x.tournament.started && x; }, 'started');
  await check('START-02 live: notices "Tournament started. Links close <time>"', async () => sayIs('Tournament started. Links close ' + await pageLocale(d.tournament.closes)));
  await check('START-02 live: the Not started banner goes', () => waitJs(`!document.querySelector('#livestart') && !!document.querySelector('.roundline')`, 'no banner'));
  const when = await pageWhen(d.tournament.closes);
  ok('START-01 start: the header switches to "closes <…>"', (await js(`document.querySelector('.hubtitle span.muted:not(.slug)').textContent.replace(/\\s+/g, ' ').trim()`)) === 'closes ' + when);
  await click('[data-view="setup"]');
  await openStep('rooms');
  const startedLines = () => js(`[...document.querySelectorAll('.stepstart > div')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())`);
  ok('START-01 start: the step list shows "Started" and "Links close <…>"', JSON.stringify(await startedLines()) === JSON.stringify(['Started', 'Links close ' + when]),
    await startedLines());
  // START-03
  ok('START-03 rooms: after Start the Test links are gone', !(await js(`[...document.querySelectorAll('.roomtable a')].some((a) => a.textContent === 'Test')`))
    && (await js(`document.querySelectorAll('.roomtable .linkpair a').length`)) === (await js(`document.querySelectorAll('[data-roomrename]').length`)));
  ok('START-03 rooms: and the note says when room links stop working', (await text('#setupsec p.muted')) === `Room links work until ${await pageLocale(d.tournament.closes)}, when the tournament closes.`,
    await text('#setupsec p.muted'));
  // START-01's OK path from the step list, on another tournament
  const TS = await apiTournament('Step Start Open');
  await call(`${TS.A}/buckets`, { method: 'POST', json: { room_name: 'Room 1' } });
  await openHub(TS, 'rooms');
  await withDialogs([true], () => click('#starttour'));
  const ds = await until(async () => { const x = await detail(TS); return x.tournament.started && x; }, 'started from the step list');
  await check('START-01 start: OK from the step list starts it, notices when links close, and the list says Started', async () =>
    (await sayIs('Tournament started. Links close ' + await pageLocale(ds.tournament.closes)))
      && (await waitJs(`JSON.stringify([...document.querySelectorAll('.stepstart > div')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()))
        === ${q(JSON.stringify(['Started', 'Links close ' + await pageWhen(ds.tournament.closes)]))}`, 'Started')));
  // ROOMS-12: the Bye Room after Start, and its uploads refused
  await goto(withLocal(`${PAGES}/read.html?b=${BYE.secret}&test=bye`));
  await check('ROOMS-12 bye: the Bye Room link still reads after Start', () => waitJs(`!document.querySelector('#teststrip').hidden && document.querySelector('#testtag').textContent === 'Bye Room'
    && document.querySelectorAll('#roundrows [data-round]').length > 0`, 'the bye room'));
  {
    const uploads0 = reqCount((r) => r.method === 'POST' && /\/upload$/.test(pathOf(r.url)));
    let said = null;
    try { said = await readerStartAndUpload(1); } catch (e) { said = e.message; }
    ok('ROOMS-12 bye: a Bye Room game\'s Upload to qb-td says "This is the Bye Room, so nothing was uploaded." and sends nothing',
      Array.isArray(said) && said[0] === 'This is the Bye Room, so nothing was uploaded.'
        && reqCount((r) => r.method === 'POST' && /\/upload$/.test(pathOf(r.url))) === uploads0
        && !((await detail(T1)).starts || []).some((x) => x.bucket_id === BYE.id), said);
  }
  {
    const r = await roomUpload(BYE, 1, 'Round_1_Alpha_Bravo.qbj', JSON.stringify(matchFor(1, 'Alpha', 'Bravo')));
    ok('ROOMS-12 bye: an upload sent to its route anyway is refused, "This is a bye room, so nothing from it is saved"', r.status === 403 && r.body.error === 'This is a bye room, so nothing from it is saved', r.body);
  }
});

/* ================= after Start: files, replacing and moving packets with games in ================= */

await runSection('GAMES IN', async () => {
  const d = await detail(T1);
  const [ra, rb, rc] = roomsOf(d);
  const up = async (b, round, name, body) => { const r = await roomUpload(b, round, name, body); if (r.status !== 200 || r.body.error) throw new Error(name + ': ' + JSON.stringify(r.body)); };
  await up(ra, 1, 'Round_1_Alpha_Bravo.qbj', JSON.stringify(matchFor(1, 'Alpha', 'Bravo')));
  await up(ra, 1, 'Round_1_Alpha_Bravo_Game.json', '{"cycles":[]}');
  await up(ra, 1, 'Round_1_Alpha_Bravo.qbj', JSON.stringify(matchFor(1, 'Alpha', 'Bravo'))); // a re-export: the same pair
  await up(rb, 1, 'Round_1_Charlie_Delta.qbtd.json', JSON.stringify({ qbj: matchFor(1, 'Charlie', 'Delta'), game: { cycles: [] }, tb: { used: ['TU2'] } }));
  await up(rc, 1, 'Round_1_Foxtrot_Echo_Forfeit.qbj', JSON.stringify(forfeitQbj(1, 'Foxtrot', 'Echo')));
  await up(ra, 2, 'Round_2_Alpha_Charlie.qbj', JSON.stringify(matchFor(2, 'Alpha', 'Charlie')));
  // ROOMS-08 the Files column
  await openHub(T1);
  if (!(await exists('.stepbtn'))) await click('[data-view="setup"]');
  await openStep('rooms');
  ok('ROOMS-08 files: each room row counts the files that room uploaded', JSON.stringify(await js(`[...document.querySelectorAll('.roomtable tr')].slice(1, 4)
    .map((tr) => tr.querySelector('td.num.muted').textContent)`)) === JSON.stringify(['4', '1', '1']), await js(`[...document.querySelectorAll('.roomtable td.num.muted')].map((x) => x.textContent)`));
  // TB-03 Heard by, TB-04's extra words for a heard question
  await openStep('packets');
  const tu2 = await js(`(() => { const tr = [...document.querySelectorAll('#setupsec table tr')].find((x) => x.querySelector('td.mono') && x.querySelector('td.mono').textContent === 'TU2');
    return tr ? [...tr.querySelectorAll('td')][3].textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  ok('TB-03 list: a question read in a game says "Heard by A & B (Round n, room)"', tu2 === `Heard by Charlie & Delta (Round 1, ${rb.room_name})`, tu2);
  const asked = await withDialogs([false], () => click('[data-tbremove="TU2"]'));
  ok('TB-04 remove: a heard question adds that its game keeps its record', asked[0] === 'Remove TU2 from the pool? It has already been read in a game, and that game keeps its record.', asked);
  // PK-08 Replace asks, counting team pairs (not MODAQ files or forfeits)
  const posts = () => reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/packet`);
  const p0 = posts();
  let q1 = await withDialogs([false], () => clickPick('[data-pickround="1"]', [writeFx('Round 1 v2.json', packetJson('R1v2'))]), { optional: true });
  ok('PK-08 replace: with games in it asks first, counting team pairs, not MODAQ files or forfeits ' + CH.replace,
    q1[0] === 'Replace Round 1\'s packet with Round 1 v2.json? 2 games already uploaded will use the new packet for their buzzpoints and categories.', q1);
  await sleep(300);
  ok('PK-08 replace: Cancel keeps the packet ' + CH.replace, posts() === p0 && (await detail(T1)).rounds.find((r) => r.number === 1).packet_name === 'Round 1.json');
  await openStep('packets');
  q1 = await withDialogs([true], () => clickPick('[data-pickround="2"]', [writeFx('Round 2 v2.json', packetJson('R2v2'))]), { optional: true });
  ok('PK-08 replace: one game, "1 game … its buzzpoints" ' + CH.replace,
    q1[0] === 'Replace Round 2\'s packet with Round 2 v2.json? 1 game already uploaded will use the new packet for its buzzpoints and categories.', q1);
  await sayIs('Round 2: Round 2 v2.json');
  ok('PK-08 replace: OK replaces it', (await detail(T1)).rounds.find((r) => r.number === 2).packet_name === 'Round 2 v2.json');
  // PK-07: a chip dropped on a round with games asks the same question
  await setFiles('#pfiles', [writeFx('Round 1 v3.json', packetJson('R1v3'))]);
  await waitJs(`document.querySelectorAll('.pkstaged .chip').length === 1`, 'the chip');
  const p1 = posts();
  const r1Name = (await detail(T1)).rounds.find((r) => r.number === 1).packet_name;
  let said = await withDialogs([false], () => drag('.pkstaged .chip[data-chip="0"]', '.pktable tr[data-round="1"]'), { optional: true });
  ok('PK-07 drag: a chip dropped on a round with games asks the Replace question first ' + CH.replace,
    said[0] === 'Replace Round 1\'s packet with Round 1 v3.json? 2 games already uploaded will use the new packet for their buzzpoints and categories.', said);
  await sleep(300);
  ok('PK-07 drag: Cancel keeps the packet and the chip ' + CH.replace, posts() === p1 && (await js(`document.querySelectorAll('.pkstaged .chip').length`)) === 1
    && (await detail(T1)).rounds.find((r) => r.number === 1).packet_name === r1Name);
  await openStep('packets');
  if (await exists('#zipclear')) await click('#zipclear');
  await waitJs(`!document.querySelector('.pkstaged')`, 'cleared');
  const r1Now = (await detail(T1)).rounds.find((r) => r.number === 1).packet_name;
  // PK-09 with games: it asks first; the count is every file the rounds hold
  const moves = () => reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${T1.A}/packets/move`);
  const m0 = moves();
  said = await withDialogs([false], () => drag('.pktable [data-move="1"]', '.pktable tr[data-round="2"]'), { optional: true });
  ok('PK-09 swap: rounds with games ask first, "Swap the packets of rounds 1 and 2? …"',
    said[0] === 'Swap the packets of rounds 1 and 2? 6 games already uploaded will use the packet now in their round.', said);
  const held = new Set((await detail(T1)).rounds.map((r) => r.number));
  const rows = await js(`document.querySelectorAll('.pktable tr[data-round]').length`);
  let empty = Array.from({ length: rows }, (_, i) => i + 1).find((k) => !held.has(k));
  if (!empty) {
    await click('#addslot');
    await waitJs(`document.querySelectorAll('.pktable tr[data-round]').length === ${rows + 1}`, 'a round to move to');
    empty = rows + 1;
  }
  said = await withDialogs([false], () => drag('.pktable [data-move="1"]', `.pktable tr[data-round="${empty}"]`), { optional: true });
  ok('PK-09 move: a round with games asks first, "Move Round 1\'s packet to Round N? …"',
    said[0] === `Move Round 1's packet to Round ${empty}? 5 games already uploaded will use the packet now in their round.`, said);
  ok('PK-09: Cancel moves nothing', moves() === m0 && (await detail(T1)).rounds.find((r) => r.number === 1).packet_name === r1Now);

  // ROOMS-04: a room renamed after its games are in: their public copies follow
  const shard = async () => { const x = await call(`/pub/${T1.slug}/rounds?n=1`); return x.status === 200 ? JSON.stringify(x.body) : ''; };
  await until(async () => { await tick(); return (await shard()).includes(`"room":${q(rb.room_name)}`); }, 'round 1 on the public page', 60000);
  await openStep('rooms');
  await fill(`[data-roomrename="${rb.id}"]`, 'Hall Ten', ['change']);
  await sayIs('Renamed to Hall Ten');
  const after = await until(async () => { await tick(); const t = await shard(); return t.includes('"room":"Hall Ten"') && t; }, 'the public copy renamed', 20000).catch(async () => shard());
  ok('ROOMS-04 rename: after games are in, the public copies of the room\'s games take the new name ' + CH.pubrename,
    after.includes('"room":"Hall Ten"') && !after.includes(`"room":${q(rb.room_name)}`), (after.match(/"room":"[^"]*"/g) || []).join(' '));
});

/* ================= ROOMS-03 the 60-room cap and partial failures; HUB-09 server failure ================= */

await runSection('ROOM CAP + FAILURES', async () => {
  // 60 at once (any larger count is cut to 60): the cap leaves no room for the Bye Room
  const T60 = await apiTournament('Sixty Rooms Open');
  await openHub(T60, 'rooms');
  await fill('#roomn', '999', ['input']);
  await click('#mkrooms');
  await waitJs(`document.querySelector('#msg').textContent === '60 rooms created'`, '60 rooms', 90000);
  await waitJs(`document.querySelectorAll('[data-roomrename]').length === 60`, 'sixty rows', 30000);
  ok('ROOMS-02 add: a count over 60 makes 60', (await detail(T60)).buckets.length === 60);
  await sleep(1000);
  const d60 = await detail(T60);
  ok('ROOMS-03 cap: 60 rooms at once leave no space for the Bye Room, which never appears, and nothing says so (reported)',
    !byeOf(d60) && !(await exists('.byesec')) && !(await msgNow()).bad, settingsOf(d60));
  // 58 rooms + the Bye Room, then 3 more: one made, then the cap
  const T58 = await apiTournament('Fifty Eight Rooms Open');
  for (let i = 1; i <= 58; i++) await call(`${T58.A}/buckets`, { method: 'POST', json: { room_name: 'Room ' + i } });
  await openHub(T58, 'rooms');
  await until(async () => byeOf(await detail(T58)), 'the Bye Room (59 rooms)');
  await openStep('rooms');
  await fill('#roomn', '3', ['input']);
  await clearMsg();
  await click('#mkrooms');
  await check('ROOMS-03 cap: a partial failure says how many were made and what to press',
    () => sayIs('Created 1 of 3 rooms. Room 60 failed: bucket cap reached. Press Add rooms to make the other 2.', true));
  ok('ROOMS-03 cap: the Worker stops at 60 rooms, the Bye Room among them', (await detail(T58)).buckets.length === 60);
  // a Worker failure partway (its database refuses one room)
  const TF = await apiTournament('Failing Rooms Open');
  d1("CREATE TRIGGER IF NOT EXISTS suite_room_boom BEFORE INSERT ON buckets WHEN NEW.room_name = 'Room 3' BEGIN SELECT RAISE(ABORT, 'suite boom'); END");
  try {
    await openHub(TF, 'rooms');
    await fill('#roomn', '4', ['input']);
    await clearMsg();
    await click('#mkrooms');
    await check('ROOMS-03 failure: "Created 2 of 4 rooms. Room 3 failed: <message>. Press Create rooms to make the other 2." ' + CH.server,
      () => sayIs(`Created 2 of 4 rooms. Room 3 failed: ${SERVER_FAIL}. Press Create rooms to make the other 2.`, true));
    ok('HUB-09 notice: a Worker failure reads "Something went wrong on the server. Please try again." in red ' + CH.server,
      (await msgNow()).bad && (await msgNow()).text.includes(SERVER_FAIL));
    await waitJs(`document.querySelectorAll('[data-roomrename]').length === 2`, 'the two made');
    ok('ROOMS-03 failure: the rooms that were made stay, the button usable again', (await text('#mkrooms')) === 'Add rooms' && !(await js(`document.querySelector('#mkrooms').disabled`)));
  } finally {
    d1('DROP TRIGGER IF EXISTS suite_room_boom');
  }
});

/* ================= HUB-01 closed tournaments and bad links ================= */

await runSection('CLOSED + BAD LINKS', async () => {
  const closedText = 'Tournament closed (links stop working 48 hours after Start, or 7 days after creation if it never started)';
  const TC = await apiTournament('Closed Setup Open');
  d1(`UPDATE tournaments SET created = created - ${8 * DAY} WHERE slug = '${TC.slug}'`);
  await goto(adminUrl(TC.secret));
  await check('HUB-01 load: 7 days after creation, never started: "Tournament closed (…)"', () => sayIs(closedText, true));
  ok('HUB-01 load: with an All tournaments link', await js(`[...document.querySelectorAll('#view a')].some((a) => a.textContent === 'All tournaments' && a.getAttribute('href') === 'index.html')`));
  const TR = await apiTournament('Closed Run Open');
  await call(`${TR.A}/start`, { method: 'POST' });
  d1(`UPDATE tournaments SET started = started - ${49 * 3600 * 1000} WHERE slug = '${TR.slug}'`);
  await goto(adminUrl(TR.secret));
  await check('HUB-01 load: 48 hours after Start: the same "Tournament closed (…)"', () => sayIs(closedText, true));
  await goto(adminUrl('abcdefghjkmnpqrstuvw'));
  await check('HUB-01 load: a bad link shows the Worker\'s "bad link"', () => sayIs('bad link', true));
  ok('HUB-01 load: with an All tournaments link (bad link)', await js(`[...document.querySelectorAll('#view a')].some((a) => a.textContent === 'All tournaments')`));
});

/* ================= SET-01 Join a set ================= */

await runSection('JOIN A SET', async () => {
  const TJ = await apiTournament('Joining Open');
  await call(`${TJ.A}/packet?round=1&name=${E('Own Round 1.json')}`, { method: 'POST', body: packetJson('Own1') });
  await openHub(TJ, 'packets');
  ok('SET-01 join: the Packets step has a "Join a set" fold with an Invite link field and Join set', await js(`(() => {
    const f = [...document.querySelectorAll('#setupsec details')].find((x) => x.querySelector('summary').textContent === 'Join a set');
    return !!f && !!f.querySelector('#joininvite') && f.querySelector('#joininvite').placeholder === 'Invite link' && f.querySelector('#joinbtn').textContent === 'Join set'; })()`));
  const joins = () => reqCount((r) => r.method === 'POST' && pathOf(r.url) === `${TJ.A}/join`);
  const inv = await makeInvite(SET, 'Joined Mirror');
  await fill('#joininvite', `${PAGES}/index.html?i=${inv.invite}`, ['input']);
  let asked = await withDialogs([false], () => click('#joinbtn'));
  ok('SET-01 join: asks "Join this set? Everything the rooms upload here will be shared with its editors."',
    asked[0] === 'Join this set? Everything the rooms upload here will be shared with its editors.', asked);
  ok('SET-01 join: Cancel does nothing', joins() === 0 && (await call('/i/' + inv.invite)).body.started === null);
  await fill('#joininvite', 'not an invite', ['input']);
  await clearMsg();
  await withDialogs([true], () => click('#joinbtn'));
  await check('SET-01 join: a bad invite says "bad invite"', () => sayIs('bad invite', true));
  await fill('#joininvite', `${PAGES}/index.html?i=${inv.invite}`, ['input']);
  await clearMsg();
  await withDialogs([true], () => click('#joinbtn'));
  await check('SET-01 join: the pasted link joins: "Joined <set>: 1 empty round filled from the set"', () => sayIs('Joined Suite Set: 1 empty round filled from the set'));
  await check('SET-01 join: then the header shows the mirror line, and the set\'s round "(from <set>)" beside the own one', () => waitJs(`(() => {
    const x = [...document.querySelectorAll('.hubhead .muted')].find((e) => /^Mirror of/.test(e.textContent));
    const names = [...document.querySelectorAll('.pktable tr[data-round]')].map((tr) => ((tr.querySelector('.pkitem') || {}).lastChild || {}).textContent || '');
    return !!x && /^Mirror of Suite Set/.test(x.textContent.trim()) && names[0] === 'Own Round 1.json' && names[1] === ${q(setRound2Name + ' (from Suite Set)')}
      && !document.querySelector('#joinbtn'); })()`, 'the mirror'));
  // the bare invite
  const TJ2 = await apiTournament('Bare Invite Open');
  const inv2 = await makeInvite(SET, 'Bare Mirror');
  await openHub(TJ2, 'packets');
  await fill('#joininvite', inv2.invite, ['input']);
  await clearMsg();
  await withDialogs([true], () => click('#joinbtn'));
  await check('SET-01 join: the bare invite works too: "Joined Suite Set: 2 empty rounds filled from the set"', () => sayIs('Joined Suite Set: 2 empty rounds filled from the set'));
  // a page that does not know its tournament joined a set meanwhile
  const TJ3 = await apiTournament('Stale Join Open');
  await openHub(TJ3, 'packets');
  const inv3 = await makeInvite(SET, 'Stale Mirror A');
  await call(`${TJ3.A}/join`, { method: 'POST', json: { invite: inv3.invite } });
  const inv4 = await makeInvite(SET, 'Stale Mirror B');
  await fill('#joininvite', inv4.invite, ['input']);
  await clearMsg();
  await withDialogs([true], () => click('#joinbtn'));
  await check('SET-01 join: "this tournament already mirrors a set"', () => sayIs('this tournament already mirrors a set', true));
  // a tournament from before content keys cannot join
  const legacySecret = 'legacy' + rnd() + rnd() + 'abcd';
  const legacySlug = 'legacy-' + rnd();
  d1(`INSERT INTO tournaments (slug, name, admin_secret, creator_ip, created, published) VALUES ('${legacySlug}', 'Legacy Open', '${legacySecret}', 'filler-legacy', ${Date.now()}, 1)`);
  await goto(adminUrl(legacySecret));
  const loaded = await until(() => js(`!!document.querySelector('.hubtab') || document.querySelector('#msg').classList.contains('show')`), 'the legacy hub').catch(() => false);
  if (loaded && await exists('.hubtab')) {
    await openStep('packets');
    await fill('#joininvite', 'abcdefghjkmnpqrstuvw', ['input']);
    await clearMsg();
    await withDialogs([true], () => click('#joinbtn'));
    await check('SET-01 join: a tournament made before content keys: "this tournament cannot join a set"', () => sayIs('this tournament cannot join a set', true));
  } else ok('SET-01 join: a legacy tournament\'s hub loads', false, await msgNow());
});

/* ================= HOME-09 the rail, HOME-07 closed entries ================= */

await runSection('HOME RAIL + CLOSED ENTRIES', async () => {
  // two tournaments running, each with games in two rooms: one public, one not
  const live = [];
  for (const [name, pub] of [['Rail Public Open', true], ['Rail Hidden Open', false]]) {
    const T = await apiTournament(name);
    const b1 = (await call(`${T.A}/buckets`, { method: 'POST', json: { room_name: 'Room 1' } })).body;
    const b2 = (await call(`${T.A}/buckets`, { method: 'POST', json: { room_name: 'Room 2' } })).body;
    await call(`${T.A}/start`, { method: 'POST' });
    await roomUpload(b1, 1, 'Round_1_Alpha_Bravo.qbj', JSON.stringify(matchFor(1, 'Alpha', 'Bravo')));
    await roomUpload(b2, 1, 'Round_1_Charlie_Delta.qbj', JSON.stringify(matchFor(1, 'Charlie', 'Delta')));
    if (!pub) await call(T.A, { method: 'POST', json: { published: false } });
    live.push(T);
  }
  // the cron lists a started tournament once two rooms have games in; a tick takes the oldest few
  const listed = (x) => (x.t || []).some((e) => e.n === 'Rail Public Open') && (x.t || []).some((e) => e.n === 'Rail Hidden Open');
  const dir = await until(async () => { await tick(); await sleep(300); const x = (await call('/pub/directory')).body; return listed(x) && x; },
    'the directory to list both', 90000).catch(async () => (await call('/pub/directory')).body);
  ok('HOME-09 rail: the local directory lists both running tournaments', (dir.t || []).some((e) => e.n === 'Rail Public Open' && e.s === live[0].slug)
    && (dir.t || []).some((e) => e.n === 'Rail Hidden Open' && e.s === null), dir);
  await home();
  await waitJs(`!document.querySelector('#tside').hidden && !!document.querySelector('#tside .railblock')`, 'the rail');
  ok('HOME-09 rail: "Live now" links a tournament to its public page while the page is on', await js(`(() => {
    const b = [...document.querySelectorAll('#tside .railblock')].find((x) => x.querySelector('.railhead b').textContent === 'Live now');
    const a = b && [...b.querySelectorAll('a.it')].find((x) => x.textContent.includes('Rail Public Open'));
    return !!a && a.getAttribute('href') === ${q('t.html?t=' + live[0].slug)}; })()`));
  ok('HOME-09 rail: and names one whose page is off, "public page off", with no link', await js(`(() => {
    const b = [...document.querySelectorAll('#tside .railblock')].find((x) => x.querySelector('.railhead b').textContent === 'Live now');
    const s = b && [...b.querySelectorAll('.it')].find((x) => x.textContent.includes('Rail Hidden Open'));
    return !!s && s.tagName === 'SPAN' && s.querySelector('small').textContent === 'public page off'; })()`));
  const index = JSON.parse(readFileSync(path.join(APP, 'archive', 'index.json'), 'utf8'));
  ok('HOME-09 rail: "Past tournaments" from the archive, with an All link, one year: no year labels', await js(`(() => {
    const b = [...document.querySelectorAll('#tside .railblock')].find((x) => x.querySelector('.railhead b').textContent === 'Past tournaments');
    if (!b) return false;
    const all = b.querySelector('.railhead a');
    const links = [...b.querySelectorAll('a.it')].map((a) => a.getAttribute('href'));
    return all.textContent === 'All' && all.getAttribute('href') === 'archive.html' && !b.querySelector('.yr')
      && ${q(index.tournaments.map((t) => 'archive.html?t=' + t.slug))}.every((h) => links.includes(h))
      && ${q((index.named || []).map((t) => t.name))}.every((n) => [...b.querySelectorAll('span.it')].some((s) => s.textContent.includes(n))); })()`));
  // more than one year: a label above each
  const twoYears = answer((r) => r.method === 'GET' && r.url === `${PAGES}/archive/index.json`, () => ({ status: 200,
    body: JSON.stringify({ ...index, named: [...(index.named || []), { name: 'Old Fall Open', date: '2025-10-04' }] }) }));
  await home();
  await waitJs(`!!document.querySelector('#tside .yr')`, 'year labels');
  twoYears.off();
  ok('HOME-09 rail: with more than one year, a label above each', JSON.stringify(await js(`[...document.querySelectorAll('#tside .yr')].map((x) => x.textContent)`)) === JSON.stringify(['2026', '2025']));
  // nothing to list: hidden; a failure: hidden, page fine
  const noDir = answer((r) => r.method === 'GET' && r.url === `${BASE}/pub/directory`, () => ({ status: 200, body: '{"v":1,"t":[]}' }));
  const noArch = answer((r) => r.method === 'GET' && r.url === `${PAGES}/archive/index.json`, () => ({ status: 200, body: '{}' }));
  await home();
  await waitJs(`!!document.querySelector('#newname')`, 'the home page');
  await sleep(500);
  ok('HOME-09 rail: hidden when both lists are empty', await js(`document.querySelector('#tside').hidden`) && noDir.count > 0 && noArch.count > 0);
  noDir.off();
  noArch.off();
  const errs0 = pageErrors.length;
  const failDir = answer((r) => r.method === 'GET' && r.url === `${BASE}/pub/directory`, () => 'fail');
  const failArch = answer((r) => r.method === 'GET' && r.url === `${PAGES}/archive/index.json`, () => ({ status: 500, body: 'oops' }));
  await home();
  await waitJs(`!!document.querySelector('#newname') && !!document.querySelector('details[data-fold="yours"]')`, 'the home page');
  await sleep(500);
  failDir.off();
  failArch.off();
  ok('HOME-09 rail: a failure there never breaks the page: the form and list show, the rail hides', await js(`document.querySelector('#tside').hidden
    && !document.querySelector('#newbtn').disabled`) && pageErrors.length === errs0 && failDir.count > 0, pageErrors.slice(errs0));

  // HOME-07: a week on, an entry is closed: muted, "closed", and its public page
  const entries = await js(`JSON.parse(localStorage.getItem('qbtdAdminLinks') || '[]')`);
  const e = entries.find((x) => x.slug === T1.slug);
  const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const real = Date.now; Date.now = () => real() + ${10 * DAY}; })();` });
  try {
    await home();
    await waitJs(`!!document.querySelector('details[data-fold="yours"] .trow')`, 'the list a week on');
    ok('HOME-07 closed: a closed tournament shows its name muted with no link, "closed", and a Public page link', await js(`(() => {
      const r = [...document.querySelectorAll('details[data-fold="yours"] .trow')].find((x) => x.querySelector('.nm').textContent === ${q(e.name)});
      const pub = r && [...r.querySelectorAll('a')].find((a) => a.textContent === 'Public page');
      return !!r && r.querySelector('.nm').tagName === 'SPAN' && r.querySelector('.nm').classList.contains('muted') && r.querySelector('.st').textContent === 'closed'
        && !!pub && pub.href === ${q(`${PAGES}/t.html?t=${T1.slug}`)}; })()`));
    const asked = await withDialogs([false], () => click(`[data-forget="${e.secret}"]`));
    ok('HOME-08 remove: for a closed one, the question says there is nothing left to manage', asked[0] === `Remove "${e.name}" from this device?\n\n`
      + 'The tournament itself is not deleted: its rooms and public page keep working. It has closed, so there is nothing left to manage.', asked);
  } finally {
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
});

/* ================= anywhere ================= */

section = 'END';
ok('no uncaught page errors on any page', pageErrors.length === 0, pageErrors);
// MODAQ (inside the reader) asks Microsoft's CDN for its Fluent UI fonts and
// icons: refused like any other host, listed, but not a backend request
const MODAQ_ASSETS = /^GET https:\/\/res(-\d+)?\.cdn\.office\.net\//;
const offMachine = refused.filter((x) => !MODAQ_ASSETS.test(x));
ok('no request for another backend left this machine (the local Worker only, no qb-td-live)', offMachine.length === 0, offMachine);
if (refused.length > offMachine.length) console.log(`  (refused ${refused.length - offMachine.length} requests of MODAQ's for its Fluent UI fonts and icons on res.cdn.office.net)`);
ok('no question about another tab\'s save in a one-tab run', !dialogs.some((x) => conflictAsks.includes(x.message)));

try { ws.close(); } catch (e) { /* closed */ }
console.log(`\n${passed} setup checks passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(0)}s, app/ and worker/ from ${ROOT})`);
if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
process.exit(failures.length ? 1 : 0);
