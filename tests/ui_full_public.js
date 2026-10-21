#!/usr/bin/env node
// ui_full_public.js — the public tournament page (app/t.html) driven in a
// real headless Chrome against a local Worker, feature by feature: what a
// viewer sees (text, classes, which tab is open, the Classic report inside
// its sandboxed frame), what the page asks the server for, and what it
// does when the server or a game file misbehaves. Each check is named for
// the feature it covers (pub-01, sch-04, st-12, cat-06, bz-02, ...). A
// check whose expected answer changed with the 10/19/2026 release says so
// in its name: "[changed: <the changelog line>]".
//
// Run it (it starts and stops everything it needs, on ports 9661-9669):
//   node tests/ui_full_public.js
// or against a stack started by hand (tools/e2e_stack.mjs on a fresh
// --state; QBTD_PERSIST lets the suite reach the local D1 and R2):
//   node tools/e2e_stack.mjs --state /tmp/pubstate --worker 9661 --pages 9662
//   QBTD_BASE=http://127.0.0.1:9661 QBTD_PAGES=http://localhost:9662 \
//     QBTD_PERSIST=/tmp/pubstate node tests/ui_full_public.js
//
// Before vs after: QBTD_ROOT=<another checkout> serves that checkout's
// app/ and runs its worker/ (the suite starts that stack itself; the
// fixtures it uploads are still built by this checkout's engine):
//   mkdir /tmp/qbtd-before && git -C <repo> archive 173a444 | tar -x -C /tmp/qbtd-before
//   ln -s <repo>/node_modules /tmp/qbtd-before/node_modules
//   QBTD_ROOT=/tmp/qbtd-before node tests/ui_full_public.js
// There, the checks tagged [changed: ...] are expected to fail and every
// other check to pass; the summary lists the failures of each kind.
//
// QBTD_SECTIONS=main,aux,... runs only those sections (SECTIONS, at the
// end). QBTD_PORT_BASE moves every port (worker = base, pages +1, Chrome's
// DevTools +2, the fault proxy +4, the Worker's inspector = the base's
// ten + 9). CHROME=... points at another Chrome.
//
// Nothing here reaches the internet. Chrome resolves no host name but
// localhost (--host-resolver-rules), every page is loaded with
// ?server=<the local fault proxy>&live=off, and the two checks that need
// production host names (pub-09: the production origin, pub-10: GitHub
// snapshot blobs) answer those requests inside Chrome (Fetch
// interception) from the local files and the local Worker. Packets are
// JSON only (a .docx would be sent to the outside YAPP parser).
//
// A check that finds a bug the suite reports but does not fail on is a
// KNOWN BUG line (bug()): it says what is wrong, and turns into a
// "now passes" note once the bug is fixed.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { buildSchedule, fillPlaceholders, renameTeams, tagBrackets } from '../app/engine/schedule.js';
import { buildRosterQbj, forfeitQbj } from '../app/engine/qbj.js';
import { buildPlan, addFinals, planGroups } from '../app/engine/plan.js';
import { finalsFill, finalsProgress } from '../app/engine/finals.js';

/* ---------- configuration ---------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.QBTD_ROOT || path.join(HERE, '..'));
const APP_DIR = path.join(ROOT, 'app');
const WORKER_DIR = path.join(ROOT, 'worker');
const PB = Number(process.env.QBTD_PORT_BASE || 9661);
const PORT = { worker: PB, pages: PB + 1, cdp: PB + 2, proxy: PB + 4, live: PB + 5, inspector: Math.floor(PB / 10) * 10 + 9 };
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.env.QBTD_SECTIONS ? new Set(process.env.QBTD_SECTIONS.split(',').map((s) => s.trim())) : null;
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'qbtd-pubfull-'));
let BASE = process.env.QBTD_BASE || null;     // the Worker
let PAGES = process.env.QBTD_PAGES || null;   // the app's pages (the origin the Worker allows)
let PERSIST = process.env.QBTD_PERSIST || null;
const PROXY = `http://127.0.0.1:${PORT.proxy}`; // what the pages call the Worker
const WENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);

/* ---------- pass / fail ---------- */

const tally = { pass: 0, fail: [], bugs: [] };
const CHANGED = /\[changed: /;
function ok(name, cond, extra) {
  if (cond) { tally.pass++; console.log('  ok', name); return; }
  tally.fail.push(name);
  let x = '';
  try { x = extra === undefined ? '' : typeof extra === 'string' ? extra : JSON.stringify(extra); } catch (e) { x = String(extra); }
  console.error('FAIL', name, x.slice(0, 1500));
  process.exitCode = 1;
}
// fn returns true, or what it saw instead (printed with the failure)
async function check(name, fn) {
  let v;
  try { v = await fn(); } catch (e) { ok(name, false, e.message); return false; }
  ok(name, v === true, v);
  return v === true;
}
// A bug this suite found and reported: printed, not failed. When the bug
// is fixed the line says so, and the check can become an ordinary one.
async function bug(name, fn, what) {
  let v;
  try { v = await fn(); } catch (e) { v = e.message; }
  if (v === true) { tally.pass++; console.log('  ok', name, '(the known bug is fixed: make this an ordinary check)'); return; }
  tally.bugs.push(name + ' — ' + what);
  console.log('  KNOWN BUG', name, '—', what, '— saw:', (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 400));
}

/* ---------- processes: the stack, the fault proxy ---------- */

const kids = [];
const servers = [];
let chromeProc = null;
function stopAll() {
  try { if (chromeProc) chromeProc.kill('SIGKILL'); } catch (e) { /* gone */ }
  for (const k of kids) {
    try { process.kill(-k.pid, 'SIGTERM'); } catch (e) { try { k.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  }
  for (const s of servers) { try { s.closeAllConnections(); s.close(); } catch (e) { /* closed */ } }
}
process.on('exit', () => { stopAll(); try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) { /* busy */ } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
// one of the app's files, or null
function appFile(urlPath) {
  let file = path.join(APP_DIR, decodeURIComponent(urlPath));
  if (!file.startsWith(APP_DIR)) return null;
  try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { return null; }
  if (!existsSync(file)) return null;
  return { body: readFileSync(file), type: TYPES[path.extname(file)] || 'application/octet-stream' };
}
function listen(server, port) {
  servers.push(server);
  return new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', () => res(server)); });
}

async function startStack() {
  PERSIST = path.join(SCRATCH, 'state');
  mkdirSync(PERSIST, { recursive: true });
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'qb-td', '--local', '--file', 'schema.sql', '--persist-to', PERSIST],
    { cwd: WORKER_DIR, env: WENV, stdio: 'ignore' });
  const log = openSync(path.join(PERSIST, 'wrangler_dev.log'), 'a');
  kids.push(spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT.worker), '--ip', '127.0.0.1', '--test-scheduled',
    '--persist-to', PERSIST, '--var', `ALLOWED_ORIGIN:http://localhost:${PORT.pages}`, '--show-interactive-dev-session=false',
    '--inspector-port', String(PORT.inspector)], { cwd: WORKER_DIR, env: WENV, stdio: ['ignore', log, log], detached: true }));
  await listen(createServer((req, res) => {
    const f = appFile(new URL(req.url, 'http://x').pathname);
    if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store' });
    res.end(f.body);
  }), PORT.pages);
  BASE = `http://127.0.0.1:${PORT.worker}`;
  PAGES = `http://localhost:${PORT.pages}`;
  const end = Date.now() + 120000;
  for (;;) {
    try { if ((await fetch(BASE + '/')).ok) break; } catch (e) { /* building */ }
    if (Date.now() > end) throw new Error('the Worker did not come up; see ' + path.join(PERSIST, 'wrangler_dev.log'));
    await sleep(300);
  }
}

// The fault proxy: the pages' way to the Worker. It passes everything
// through, logs it, and lets a check fail, delay, hold or rewrite the
// answers it names (faults).
const proxyLog = [];
let faults = [];
const ORIGIN = () => new URL(PAGES).origin;
function startProxy() {
  return listen(createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      proxyLog.push({ at: Date.now(), method: req.method, path: u.pathname, search: u.search, auth: req.headers.authorization || '' });
      const rule = faults.find((f) => (!f.method || f.method === req.method) && f.test(u));
      if (rule && rule.once) faults = faults.filter((f) => f !== rule);
      if (rule && rule.delay) await sleep(rule.delay);
      if (rule && rule.hang) return; // never answers
      if (rule && rule.status) {
        res.writeHead(rule.status, { 'Content-Type': rule.type || 'application/json', 'Access-Control-Allow-Origin': ORIGIN() });
        res.end(rule.body || '');
        return;
      }
      try {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive'].includes(k)) headers[k] = v;
        }
        const r = await fetch(BASE + req.url, { method: req.method, headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
        let body = Buffer.from(await r.arrayBuffer());
        if (rule && rule.mutate) body = Buffer.from(rule.mutate(body.toString('utf8')));
        const out = {};
        r.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
        res.writeHead(r.status, out);
        res.end(body);
      } catch (e) {
        console.log('     (proxy: ' + req.method + ' ' + req.url + ' failed: ' + e.message + (e.cause ? ' / ' + e.cause.message : '') + ')');
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': ORIGIN() });
        res.end('proxy: ' + e.message);
      }
    });
  }), PORT.proxy);
}

// A stand-in for qb-td-live, for ?live=<url> on a local origin: it holds
// no files (404 to everything) and logs what it was asked.
const liveLog = [];
function startLiveFiles() {
  return listen(createServer((req, res) => {
    liveLog.push({ at: Date.now(), path: new URL(req.url, 'http://x').pathname });
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('no such file');
  }), PORT.live);
}

/* ---------- the Worker, the local D1 and R2 ---------- */

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + p, { method: opts.method || 'GET', headers, body });
      const ct = res.headers.get('content-type') || '';
      return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
    } catch (e) {
      // a wrangler CLI call resets the dev server's pooled connections
      if (attempt >= 3) throw e;
      await sleep(300);
    }
  }
}
const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, '--local', '--persist-to', PERSIST],
  { cwd: WORKER_DIR, env: WENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const d1exec = (sql) => wrangler(['d1', 'execute', 'qb-td', '--command', sql]);
function r2put(key, text) {
  const f = path.join(SCRATCH, 'r2-' + randomBytes(4).toString('hex'));
  writeFileSync(f, text);
  wrangler(['r2', 'object', 'put', 'qb-td-data/' + key, '--file', f]);
}
async function tick() {
  const r = await fetch(BASE + '/__scheduled');
  if (!r.ok) throw new Error('the cron trigger failed (' + r.status + ')');
  await r.text();
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// A tournament as the suite drives it: {slug, secret, A, tid, rooms}
async function mkTournament(name, prefix) {
  const slug = prefix + '-' + randomBytes(3).toString('hex');
  const r = await call('/api/tournaments', { method: 'POST', json: { name, slug } });
  if (r.status !== 200) throw new Error('create ' + slug + ': ' + JSON.stringify(r.body));
  const T = { slug, name, secret: r.body.admin_secret, A: '/a/' + r.body.admin_secret, rooms: [] };
  T.tid = (await call(T.A)).body.tournament.id;
  return T;
}
const detail = async (T) => (await call(T.A)).body;
const settingsOf = async (T) => JSON.parse((await detail(T)).tournament.settings || '{}');
async function must(what, p) {
  const r = await p;
  if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}
async function addRooms(T, names) {
  for (const room_name of names) {
    const b = await must('room ' + room_name, call(T.A + '/buckets', { method: 'POST', json: { room_name } }));
    T.rooms.push({ id: b.id, secret: b.secret, name: room_name });
  }
}
const room = (T, name) => T.rooms.find((r) => r.name === name);
const putRoster = (T, teams, track = { trackUG: false, trackDiv2: false }) =>
  must('roster', call(T.A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(buildRosterQbj(T.name, teams, track)) }));
const putSchedule = (T, sched) => must('schedule', call(T.A + '/schedule', { method: 'POST', json: sched }));
const putPacket = (T, round, packet) => must('packet ' + round, call(`${T.A}/packet?round=${round}&name=${encodeURIComponent('Round ' + round + '.json')}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packet) }));
const startT = (T) => must('start', call(T.A + '/start', { method: 'POST' }));
async function upload(T, roomName, round, filename, qbj) {
  return must('upload ' + filename, call(`/b/${room(T, roomName).secret}/upload?round=${round}&name=${encodeURIComponent(filename)}`,
    { method: 'POST', body: JSON.stringify(qbj) }));
}
async function saveSettings(T, change, extra = {}) {
  const next = { ...(await settingsOf(T)) };
  change(next);
  return must('settings', call(T.A, { method: 'POST', json: { settings: next, ...extra } }));
}
// a stats password as the hub sets one (buzzkey.js buzzCredentials):
// PBKDF2-SHA256 over the password, salted with the salt's own text
function buzzCred(pw, iters = 100000) {
  const salt = randomBytes(12).toString('hex');
  const token = pbkdf2Sync(pw, salt, iters, 32, 'sha256').toString('hex');
  return { settings: { mode: 'password', kdf: 'pbkdf2', iters, salt, hash: sha256(token) }, token };
}
async function setPassword(T, pw, { buzz = true, scoresheets } = {}) {
  const cred = buzzCred(pw);
  return saveSettings(T, (s) => {
    s.buzz = { ...cred.settings, mode: buzz ? 'password' : 'off' };
    if (scoresheets !== undefined) { if (scoresheets) s.scoresheets = true; else delete s.scoresheets; }
  }, { buzz_token: cred.token });
}
// The cron's rebuild, until this tournament's public data is built again
// (pub_dirty cleared and pub_built moved).
async function settle(T, label = T.slug) {
  const before = (await detail(T)).tournament.pub_built || 0;
  for (let i = 0; i < 60; i++) {
    await tick();
    const t = (await detail(T)).tournament;
    if (!t.pub_dirty && (t.pub_built || 0) > before) return;
    await sleep(100 + i * 20);
  }
  throw new Error('the public data was not rebuilt: ' + label);
}

/* ---------- Chrome over the DevTools protocol ---------- */

// Kept on every new document: the page's fetches (the Worker requests a
// check counts) and each change of #msg (the status line, with its
// "Loading" moments). Observed from before the page's module runs.
const RECORDER = `(() => {
  if (window.__qt) return;
  window.__qt = { fetches: [], msgs: [] };
  const f = window.fetch;
  window.fetch = function (u, o) {
    try { window.__qt.fetches.push({ url: String((u && u.url) || u), at: Date.now(),
      auth: !!(o && o.headers && (o.headers.Authorization || o.headers.authorization)) }); } catch (e) { /* keep going */ }
    return f.apply(this, arguments);
  };
  const watch = () => {
    const m = document.getElementById('msg');
    if (!m || m.__qtWatched) return;
    m.__qtWatched = true;
    new MutationObserver(() => window.__qt.msgs.push({ t: m.textContent, bad: m.className === 'bad', at: Date.now() }))
      .observe(m, { childList: true, characterData: true, subtree: true, attributes: true });
  };
  document.addEventListener('readystatechange', watch);
  document.addEventListener('DOMContentLoaded', watch);
})();`;

class Browser {
  async start() {
    const udd = path.join(SCRATCH, 'chrome');
    chromeProc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT.cdp}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-features=Translate,OptimizationHints,MediaRouter',
      // no host name resolves but localhost: nothing can leave this machine
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
    let wsUrl = null;
    for (let i = 0; i < 200 && !wsUrl; i++) {
      try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT.cdp}/json/version`)).json()).webSocketDebuggerUrl; }
      catch (e) { await sleep(100); }
    }
    if (!wsUrl) throw new Error('Chrome did not start');
    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.rej(new Error(p.method + ': ' + m.error.message)); else p.res(m.result);
      } else if (m.method) for (const fn of [...this.listeners]) fn(m);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error('no reply to ' + method + ' within 30s')); }, 30000);
      this.pending.set(id, { res, rej, method, timer });
    });
  }
  async newTab() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(this, targetId, sessionId);
    await tab.init();
    return tab;
  }
}

class Tab {
  constructor(br, targetId, sessionId) {
    Object.assign(this, { br, targetId, sessionId });
    this.errors = [];     // uncaught exceptions on its pages
    this.dialogs = [];
    this.reqs = [];       // every request: {url, method, headers}
    this.kids = new Map(); // out-of-process frames: session id -> {targetId} (a sandboxed report)
    this.ctxs = new Map(); // same-process frames: frame id -> its page context (an unsandboxed report)
    this.media = [];
    this.handlers = [];
    this.fn = (m) => {
      if (m.sessionId === this.sessionId) {
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          this.errors.push((d.exception && d.exception.description) || d.text);
        } else if (m.method === 'Network.requestWillBeSent') {
          this.reqs.push({ url: m.params.request.url, method: m.params.request.method, headers: m.params.request.headers, at: Date.now() });
        } else if (m.method === 'Page.javascriptDialogOpening') {
          this.dialogs.push(m.params.message);
          this.S('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
        } else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') {
          const sid = m.params.sessionId;
          this.kids.set(sid, { targetId: m.params.targetInfo.targetId, at: Date.now() });
          if (this.media.length) this.br.send('Emulation.setEmulatedMedia', { features: this.media }, sid).catch(() => {});
          // its page context too, for an exception thrown in it
          this.br.send('Runtime.enable', {}, sid).catch(() => {});
        } else if (m.method === 'Target.detachedFromTarget') {
          this.kids.delete(m.params.sessionId);
        } else if (m.method === 'Runtime.executionContextCreated') {
          const c = m.params.context;
          if (c.auxData && c.auxData.isDefault && c.auxData.frameId) this.ctxs.set(c.auxData.frameId, c.id);
        } else if (m.method === 'Runtime.executionContextDestroyed') {
          for (const [f, id] of this.ctxs) if (id === m.params.executionContextId) this.ctxs.delete(f);
        } else if (m.method === 'Runtime.executionContextsCleared') {
          this.ctxs.clear();
        }
      } else if (this.kids.has(m.sessionId) && m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push('(report) ' + ((d.exception && d.exception.description) || d.text));
      }
      for (const h of this.handlers) h(m);
    };
    br.listeners.push(this.fn);
  }
  S(method, params) { return this.br.send(method, params, this.sessionId); }
  async init() {
    await this.S('Page.enable');
    await this.S('Runtime.enable');
    await this.S('Network.enable');
    await this.S('DOM.enable');
    await this.S('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    await this.S('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await this.S('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.view('desktop');
  }
  view(kind) {
    return kind === 'phone'
      ? this.S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
      : this.S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  async dark(on) {
    this.media = [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }];
    await this.S('Emulation.setEmulatedMedia', { features: this.media });
    for (const sid of this.kids.keys()) await this.br.send('Emulation.setEmulatedMedia', { features: this.media }, sid).catch(() => {});
  }
  once(pred, ms, what) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.handlers.splice(this.handlers.indexOf(h), 1); rej(new Error('no ' + what + ' within ' + ms + 'ms')); }, ms);
      const h = (m) => { if (pred(m)) { clearTimeout(t); this.handlers.splice(this.handlers.indexOf(h), 1); res(m); } };
      this.handlers.push(h);
    });
  }
  async goto(url) {
    // the same page with another hash would only scroll: load it afresh
    const here = await this.js('location.href').catch(() => '');
    if (here.split('#')[0] === url.split('#')[0] && url.includes('#')) {
      const blank = this.once((m) => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', 30000, 'about:blank');
      await this.S('Page.navigate', { url: 'about:blank' });
      await blank;
    }
    const loaded = this.once((m) => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', 30000, 'load of ' + url);
    await this.S('Page.navigate', { url });
    await loaded;
  }
  async reload() {
    const loaded = this.once((m) => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', 30000, 'reload');
    await this.S('Page.reload');
    await loaded;
  }
  async js(expression) {
    const r = await this.S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async wait(expr, label, ms = 15000) {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      try { last = await this.js(expr); if (last) return last; } catch (e) { last = e; }
      if (Date.now() > end) {
        let seen = '';
        try { seen = await this.js(`(document.querySelector('#msg') ? '[msg: ' + document.querySelector('#msg').textContent + '] ' : '') + document.body.innerText.slice(0, 400)`); } catch (e) { /* gone */ }
        throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : '') + ' — page: ' + seen);
      }
      await sleep(50);
    }
  }
  click(sel) {
    return this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
  }
  text(sel) { return this.js(`(document.querySelector(${q(sel)}) || {}).textContent || ''`); }
  texts(sel) { return this.js(`[...document.querySelectorAll(${q(sel)})].map((e) => e.textContent.trim())`); }
  exists(sel) { return this.js(`!!document.querySelector(${q(sel)})`); }
  select(sel, value) {
    return this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
      e.value = ${q(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  }
  fill(sel, value) {
    return this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
      e.value = ${q(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  }
  // a real pointer: moved over (hover) or pressed (a click or a tap) at an element's middle
  async center(sel) {
    return this.js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
      e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  }
  async hover(sel) {
    const { x, y } = await this.center(sel);
    await this.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }
  async press(sel) {
    const { x, y } = await this.center(sel);
    await this.pressAt(x, y);
  }
  async pressAt(x, y) {
    await this.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async key(sel, key) {
    await this.js(`document.querySelector(${q(sel)}).focus(), true`);
    await this.S('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0, text: key === 'Enter' ? '\r' : undefined });
    await this.S('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 });
  }
  // Code run inside the Classic report on screen (iframe.report). Its
  // frame is found from the element, then reached where it runs: its own
  // session when it is out of process (sandboxed, as the 10/19 release
  // has it), else its page context in this tab's session (an unsandboxed
  // frame, as an older checkout has it) — so the same checks read both.
  async fjs(expression) {
    const { result } = await this.S('Runtime.evaluate', { expression: `document.querySelector('iframe.report')` });
    if (!result || !result.objectId) throw new Error('no report frame');
    const { node } = await this.S('DOM.describeNode', { objectId: result.objectId });
    this.S('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    const frameId = node.frameId;
    const kid = [...this.kids].find(([, k]) => k.targetId === frameId);
    let r;
    if (kid) r = await this.br.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, kid[0]);
    else if (this.ctxs.has(frameId)) r = await this.S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId: this.ctxs.get(frameId) });
    else throw new Error('the report frame is not running yet');
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async fwait(expr, label, ms = 15000) {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      try { last = await this.fjs(expr); if (last) return last; } catch (e) { last = e; }
      if (Date.now() > end) throw new Error('timed out (in the report): ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
      await sleep(50);
    }
  }
  fclick(sel) {
    return this.fjs(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing in the report matches ' + ${q(sel)}); e.click(); return true; })()`);
  }
  // Requests this tab makes to URLs matching `patterns` are paused and
  // answered here, inside Chrome, so they never reach the network:
  // route(url, request) returns {status, headers, body}, or 'hang' (never
  // answered), or null to let a local one through. Each is kept in
  // this.routed. A second call replaces the patterns and the route.
  async intercept(patterns, route) {
    this.routed = [];
    this.route = route;
    if (!this.paused) {
      this.paused = (m) => {
        if (m.sessionId !== this.sessionId || m.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = m.params;
        this.routed.push({ url: request.url, method: request.method, at: Date.now() });
        (async () => {
          let out;
          try { out = await this.route(request.url, request); } catch (e) { out = { status: 502, body: 'route failed: ' + e.message }; }
          if (out === 'hang') return;
          if (!out) { await this.S('Fetch.continueRequest', { requestId }); return; }
          const body = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body ?? ''));
          await this.S('Fetch.fulfillRequest', { requestId, responseCode: out.status || 200,
            responseHeaders: Object.entries(out.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
            body: body.toString('base64') });
        })().catch(() => { /* the request went away */ });
      };
      this.handlers.push(this.paused);
    }
    await this.S('Fetch.enable', { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) });
  }
  async close() {
    this.br.listeners.splice(this.br.listeners.indexOf(this.fn), 1);
    await this.br.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

/* ---------- the public page ---------- */

const pubUrl = (slug, extra = '', hash = '') => `${PAGES}/t.html?t=${slug}&live=off&server=${encodeURIComponent(PROXY)}${extra}${hash}`;
// the first load has landed: a tab is open (or the status line says why not)
async function openPub(tab, slug, { extra = '', hash = '', expectError = false } = {}) {
  await tab.goto(pubUrl(slug, extra, hash));
  if (expectError) await tab.wait(`window.__qt.msgs.some((m) => m.bad)`, 'an error on ' + slug);
  else await tab.wait(`!!document.querySelector('.tab.active') && window.__qt.msgs.some((m) => m.t !== 'Loading')`, 'the public page of ' + slug, 20000);
}
// Refresh, until its load is done (its last status: not "Loading")
async function refresh(tab) {
  const n = await tab.js('window.__qt.msgs.length');
  const f = await tab.js('window.__qt.fetches.length');
  await tab.click('#refresh');
  await tab.wait(`window.__qt.msgs.slice(${n}).some((m) => m.t !== 'Loading')`, 'the refresh to finish', 20000);
  return { msgs: await tab.js(`window.__qt.msgs.slice(${n})`), fetches: await tab.js(`window.__qt.fetches.slice(${f}).map((x) => x.url)`) };
}
const tabTo = async (tab, which) => { await tab.click('#tab-' + which); await tab.wait(`document.querySelector('#tab-${which}').classList.contains('active')`, which + ' tab'); };
// the Worker routes a list of fetched URLs reached, as paths with their query
const workerPaths = (urls) => urls.filter((u) => u.startsWith(PROXY)).map((u) => u.slice(PROXY.length));
const rowsOf = (tab, sel) => tab.js(`[...document.querySelectorAll(${q(sel)})].map((tr) => [...tr.children].map((c) => c.textContent.trim()))`);

/* ---------- games, packets, rosters ---------- */

const FIRST = ['Ada', 'Ben', 'Cy', 'Dee', 'Eli'];
const ROSTER = {}; // team -> its five players
function team(name, short = name.split(/\s+/)[0]) {
  ROSTER[name] = FIRST.map((f) => `${f} ${short}`);
  return { name, players: ROSTER[name] };
}

// One game's tossups: [{z: [[side, player, value, word]], bonus: [parts] | null, ot?, tb?}],
// side 0 the winner. Five tossups repeat: the winner's 10 (the first k of
// them go to the loser instead), the loser's 10, the winner's power, the
// loser's neg and the winner's bounceback, a dead one. An overtime adds
// the winner's 10 without a bonus.
function stdTossups({ k = 0, ot = false, n = 20, powers = true } = {}) {
  const out = [];
  let swaps = 0;
  for (let i = 0; i < n; i++) {
    const s = i % 5;
    if (s === 0) {
      if (swaps < k) { swaps++; out.push({ z: [[1, 0, 10, 30]], bonus: [10, 0, 0] }); } else out.push({ z: [[0, 0, 10, 30]], bonus: [10, 10, 0] });
    } else if (s === 1) out.push({ z: [[1, 1, 10, 50]], bonus: [10, 0, 0] });
    else if (s === 2) out.push({ z: [[0, 1, powers ? 15 : 10, 8]], bonus: [10, 10, 10] });
    else if (s === 3) out.push({ z: [[1, 0, -5, 25], [0, 2, 10, 60]], bonus: [0, 10, 0] });
    else out.push({ z: [], bonus: null });
  }
  if (ot) out.push({ z: [[0, 3, 10, 40]], bonus: null, ot: true });
  return out;
}
const deadTossups = (n) => Array.from({ length: n }, () => ({ z: [], bonus: null }));

// A MODAQ-style match .qbj for `win` against `lose`, and what it should
// count for, worked out here from the same plan (not by the app's engine).
// flip: `lose` is listed first. sub: the winner's 5th player comes in for
// the 4th at tossup 11. reg: the regulation tossup count (OT beyond it).
function mkGame({ round, win, lose, tus, flip = false, sub = false, reg = 20, round_in_file = round }) {
  const sides = [win, lose];
  const counts = [{}, {}];
  const bonusPts = [0, 0];
  const bonusesHeard = [0, 0];
  const points = [0, 0];
  const regPoints = [0, 0];
  let bn = 0;
  const mq = tus.map((t, i) => {
    const qn = { question_number: i + 1, type: 'tossup', parts: 1, ...(t.tb ? { qbtd_tiebreaker: t.tb } : {}) };
    const buzzes = t.z.map(([s, p, v, w]) => {
      const pn = ROSTER[sides[s]][p];
      counts[s][pn] = counts[s][pn] || {};
      counts[s][pn][v] = (counts[s][pn][v] || 0) + 1;
      points[s] += v;
      if (!t.ot && i < reg) regPoints[s] += v;
      return { player: { name: pn }, team: { name: sides[s] }, buzz_position: { word_index: w }, result: { value: v } };
    });
    const q = { question_number: i + 1, tossup_question: qn, buzzes };
    const got = t.z.find((x) => x[2] > 0);
    if (got && t.bonus) {
      bn++;
      const s = got[0];
      const sum = t.bonus.reduce((a, b) => a + b, 0);
      bonusPts[s] += sum; points[s] += sum; regPoints[s] += sum; bonusesHeard[s]++;
      q.bonus = { question: { question_number: bn, type: 'bonus', parts: 3 }, parts: t.bonus.map((x) => ({ controlled_points: x, bounceback_points: 0 })) };
    }
    return q;
  });
  const n = tus.length;
  const heard = (s, p) => (sub && s === 0 ? (p === 3 ? 10 : p === 4 ? n - 10 : n) : p === 4 ? 0 : n);
  const side = (s) => ({
    team: { name: sides[s], players: ROSTER[sides[s]].map((name) => ({ name })) },
    bonus_points: bonusPts[s], bonus_bounceback_points: 0,
    match_players: ROSTER[sides[s]].map((pn, p) => ({ player: { name: pn }, tossups_heard: heard(s, p),
      answer_counts: [15, 10, 0, -5].filter((v) => (counts[s][pn] || {})[v]).map((v) => ({ number: counts[s][pn][v], answer: { value: v } })) }))
      .filter((mp) => mp.tossups_heard > 0),
    lineups: sub && s === 0
      ? [{ first_question: 1, players: ROSTER[sides[s]].slice(0, 4).map((name) => ({ name })) },
        { first_question: 11, players: [0, 1, 2, 4].map((p) => ({ name: ROSTER[sides[s]][p] })) }]
      : [{ first_question: 1, players: ROSTER[sides[s]].slice(0, 4).map((name) => ({ name })) }],
  });
  const qbj = { _round: round_in_file, tossups_read: n, match_teams: (flip ? [1, 0] : [0, 1]).map(side), match_questions: mq };
  const regRead = Math.min(n, reg);
  return {
    qbj, round, win, lose, ot: Math.max(0, n - reg),
    exp: sides.map((nm, s) => ({ name: nm, points: points[s], regPoints: regPoints[s], tuh: regRead, bonusPts: bonusPts[s],
      bonusesHeard: bonusesHeard[s], players: counts[s] })),
    filename: `Round_${round_in_file}_${(flip ? [lose, win] : [win, lose]).map((x) => x.replace(/[^A-Za-z0-9]+/g, '_')).join('_')}.qbj`,
  };
}

// Packet questions: each word its own ("r2t5w17"), so a buzz's word can be
// read back off the page. `nbsp`: tossup 1 joins its 2nd and 3rd words
// with an encoded space, which MODAQ reads as two words.
const qWords = (round, t, n = 110) => Array.from({ length: n }, (_, j) => `r${round}t${t}w${j}`);
function mkPacket(round, { tuCats, bonusCats, marked = 8, nbsp = false, n = 20 }) {
  return {
    tossups: Array.from({ length: n }, (_, i) => {
      const w = qWords(round, i + 1);
      const question = nbsp && i === 0 ? [w[0], w[1] + '&nbsp;' + w[2], ...w.slice(3)].join(' ') : w.join(' ');
      return { question: question + '.', answer: `<b><u>Answer ${round}-${i + 1}</u></b>`, ...tuCats[i % tuCats.length] };
    }),
    bonuses: Array.from({ length: n }, (_, i) => ({
      leadin: `Round ${round} bonus ${i + 1} leadin. For 10 points each:`,
      parts: ['First part.', 'Second part.', 'Third part.'],
      answers: [`<b>b${round}-${i + 1}a</b>`, `<b>b${round}-${i + 1}b</b>`, `<b>b${round}-${i + 1}c</b>`],
      values: [10, 10, 10], ...bonusCats[i % bonusCats.length],
      ...(i < marked ? { difficultyModifiers: ['e', 'm', 'h'] } : {}),
    })),
  };
}
const C = (category, subcategory) => (subcategory ? { category, subcategory } : { category });
// tossups 5, 10, 15 and 20 go dead in every standard game: Fine Arts
const MAIN_TU_CATS = [C('Literature', 'American Literature'), C('Science', 'Biology'), C('History', 'World History'),
  C('Social Science', 'Economics'), C('Fine Arts', 'Painting'), C('Religion'), C('Science', 'Physics'),
  { metadata: 'Jordan Patel, Underwater Basket Weaving' }, C('Social Science', 'Psychology'), C('Fine Arts', 'Sculpture'),
  C('Literature', 'British Literature'), C('Science', 'Chemistry'), C('History', 'European History'), C('Religion'),
  C('Fine Arts', 'Painting'), C('Literature', 'American Literature'), C('Science', 'Biology'),
  { metadata: 'Jordan Patel, Underwater Basket Weaving' }, C('Social Science', 'Economics'), C('Fine Arts', 'Music')];
const MAIN_BONUS_CATS = [C('Literature'), C('Science'), C('History'), C('Religion')];

// what a list of games should count for, per team (forfeits apart)
function tallyTeams(games) {
  const t = {};
  const at = (n) => (t[n] = t[n] || { w: 0, l: 0, tie: 0, regPoints: 0, tuh: 0, bonusPts: 0, bonusesHeard: 0, games: 0 });
  for (const g of games) {
    if (g.forfeit) { at(g.win).w++; at(g.lose).l++; continue; }
    const [a, b] = g.exp;
    if (a.points === b.points) { at(a.name).tie++; at(b.name).tie++; } else { at(a.points > b.points ? a.name : b.name).w++; at(a.points > b.points ? b.name : a.name).l++; }
    for (const x of g.exp) {
      const r = at(x.name);
      r.regPoints += x.regPoints; r.tuh += x.tuh; r.bonusPts += x.bonusPts; r.bonusesHeard += x.bonusesHeard; r.games++;
    }
  }
  return t;
}
const pp = (r, reg = 20) => (r.tuh ? (r.regPoints / r.tuh) * reg : null);
const isRed = (c) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c || ''); return !!m && Number(m[1]) > 120 && Number(m[1]) > 2 * Number(m[2]) && Number(m[1]) > 2 * Number(m[3]); };
const msgIs = async (tab, text) => {
  const m = await tab.js(`({ t: document.querySelector('#msg').textContent, cls: document.querySelector('#msg').className,
    color: getComputedStyle(document.querySelector('#msg')).color })`);
  return (m.t === text && m.cls === 'bad' && isRed(m.color)) || m;
};

/* ---------- sections ---------- */

/* pub-04, pub-05: a link without a tournament, one to no tournament, and a
   tournament whose public page is off */
async function sectionLinks(br) {
  const tab = await br.newTab();
  await tab.goto(`${PAGES}/t.html?live=off&server=${encodeURIComponent(PROXY)}`);
  await tab.wait(`document.querySelector('#msg').textContent === 'Bad link'`, 'Bad link');
  await check('pub-04 bad link: t.html with no ?t= shows a red "Bad link"', () => msgIs(tab, 'Bad link'));
  await check('pub-04 bad link: and asks no server anything', async () => {
    const away = tab.reqs.filter((r) => !r.url.startsWith(PAGES) && !r.url.startsWith('about:'));
    const f = await tab.js('window.__qt.fetches');
    return (away.length === 0 && f.length === 0) || { away: away.map((r) => r.url), fetches: f };
  });

  await openPub(tab, 'no-such-tournament', { expectError: true });
  await check('pub-05 unknown slug: a red "not found", and the header stays "tournament"', async () => {
    const m = await msgIs(tab, 'not found');
    const h = await tab.js(`[document.querySelector('#tname').textContent, document.title, !!document.querySelector('.tab.active')]`);
    return (m === true && h[0] === 'tournament' && h[1] === 'tournament' && !h[2]) || { m, h };
  });

  const T = await mkTournament('Switched Off Invitational', 'pubfull-off');
  team('Quail'); team('Raven');
  await putRoster(T, [{ name: 'Quail', players: ROSTER.Quail }, { name: 'Raven', players: ROSTER.Raven }]);
  await must('page off', call(T.A, { method: 'POST', json: { published: false } }));
  await openPub(tab, T.slug, { expectError: true });
  await check('pub-05 page off: the Worker answers 404 and the page says "not found", header "tournament"', async () => {
    const m = await msgIs(tab, 'not found');
    const st = (await call('/pub/' + T.slug)).status;
    const h = await tab.text('#tname');
    return (m === true && st === 404 && h === 'tournament') || { m, st, h };
  });
  await must('page on', call(T.A, { method: 'POST', json: { published: true } }));
  await refresh(tab);
  await check('pub-05 page off: turned back on, Refresh loads it', async () => {
    const h = await tab.js(`[document.querySelector('#tname').textContent, document.title, document.querySelector('#msg').textContent,
      (document.querySelector('.tab.active') || {}).id]`);
    return (h[0] === T.name && h[1] === T.name && h[2] === '' && h[3] === 'tab-stats') || h;
  });
  await tab.close();
}

/* pub-11 pending games, sch-11 no schedule, pub-03 a tournament without a
   schedule opens on Stats */
async function sectionPending(br) {
  const tab = await br.newTab();
  const T = await mkTournament('Pending Games Cup', 'pubfull-pend');
  await addRooms(T, ['Hall 1', 'Hall 2']);
  const teams = ['Kestrel', 'Lynx', 'Marten', 'Newt'].map((n) => team(n));
  await putRoster(T, teams);
  await startT(T);
  const g1 = mkGame({ round: 1, win: 'Kestrel', lose: 'Lynx', tus: stdTossups({ k: 1 }) });
  const g2 = mkGame({ round: 1, win: 'Newt', lose: 'Marten', tus: stdTossups({ k: 2 }) });
  await upload(T, 'Hall 1', 1, g1.filename, g1.qbj);
  await upload(T, 'Hall 2', 1, g2.filename, g2.qbj);
  // no cron tick yet: the Worker has both games, no round shard holds them
  await openPub(tab, T.slug);
  await check('pub-03 opening tab: no schedule, so it opens on Stats', async () => {
    const x = await tab.js(`[document.querySelector('.tab.active').id, location.hash]`);
    return (x[0] === 'tab-stats' && x[1] === '') || x;
  });
  await check('pub-11 pending: with no games loaded the note is the whole Stats tab', async () => {
    const x = await tab.js(`[document.querySelector('#out').innerText.trim(), !!document.querySelector('.statsbar, [data-layout]')]`);
    return (x[0] === '2 games just in. Please wait for a minute before refreshing.' && !x[1]) || x;
  });
  await tabTo(tab, 'schedule');
  await check('sch-11 no schedule: the Schedule tab says "No schedule"', async () => (await tab.js(`document.querySelector('#out').innerText.trim()`)) === 'No schedule' || await tab.js(`document.querySelector('#out').innerText`));
  await settle(T);
  await tabTo(tab, 'stats');
  await refresh(tab);
  await check('pub-11 pending: once the round is built, Refresh shows the games and the note goes', async () => {
    await tab.wait(`!!document.querySelector('iframe.report')`, 'the report');
    const x = await tab.js(`[document.querySelector('#out').innerText.includes('just in'), !!document.querySelector('.statsbar')]`);
    return (!x[0] && x[1]) || x;
  });
  // a shard that holds one game fewer than the state lists: the note rides above the stats
  faults.push({ test: (u) => u.pathname === `/pub/${T.slug}/rounds`, mutate: (text) => {
    const j = JSON.parse(text);
    for (const s of j.rounds) s.entries = s.entries.slice(0, 1);
    return JSON.stringify(j);
  } });
  try {
    await tab.S('Network.clearBrowserCache'); // the shard was served max-age=60: a new load would reuse it
    await openPub(tab, T.slug);
    await check('pub-11 pending: a game the loaded shards lack is noted above the stats ("1 game just in")', async () => {
      const x = await tab.js(`[...document.querySelectorAll('#out > div.muted')].map((d) => d.textContent.trim())`);
      const bar = await tab.exists('.statsbar');
      return (x.includes('1 game just in. Please wait for a minute before refreshing.') && bar) || { x, bar };
    });
  } finally { faults = []; }
  await tab.close();
  return T;
}

/* ---------- the main tournament: a whole day, checked as it goes ----------
   Six teams, two pools of three into crossover playoffs (Championship and
   Consolation), three rooms, five rounds, JSON packets with categories.
   Pool A: Alder, Dogwood, Elm. Pool B: University of Illinois Urbana D,
   Cedar, Fir. Elm's players are undergraduates, Cedar's Division II. */

const UIUC = 'University of Illinois Urbana D';
const UIUC_CUT = 'University of Illin… D';

// a schedule's games, in order: [{round, room, a, b, aLabel, bLabel, game}]
function schedGames(sched) {
  const out = [];
  for (const ph of sched.phases) {
    for (const r of ph.rounds) {
      for (const g of r.games) out.push({ round: r.round, phase: ph.name, room: sched.rooms[g.room].name, a: g.a && (g.a.team || g.a.label), b: g.b && (g.b.team || g.b.label), g });
    }
  }
  return out;
}
const byesOf = (sched, round) => sched.phases.flatMap((ph) => ph.rounds).find((r) => r.round === round).byes.map((s) => s.team || s.label);
// a played game's score link on the schedule (pubview.js gameLines: round|a|b in schedule order)
const scoreSel = (sg) => `a.s[data-game="${[sg.round, sg.a, sg.b].map(encodeURIComponent).join('|')}"]`;

// The tables of the report page shown in the Classic frame:
// [{heads, rows}] with each row's cell texts.
const FRAME_TABLES = (page) => `[...document.querySelectorAll('#page-${page} table')].map((t) => {
  const trs = [...t.querySelectorAll('tr')];
  return { heads: trs.length ? [...trs[0].children].map((c) => c.textContent.trim()) : [], rows: trs.slice(1).map((tr) => [...tr.children].map((c) => c.textContent.trim())) };
})`;
// the id of the section a followed link marked (reportframe.js tellPlace)
const MARK_ID = `(() => { const b = document.querySelector('.qt-mark'); const own = b && (b.querySelector('[id]') || b.previousElementSibling); return own ? own.id : null; })()`;
const SHOWN_PAGE = `(() => { const s = [...document.querySelectorAll('section[id^="page-"]')].filter((x) => !x.hidden); return s.length === 1 ? s[0].id.slice(5) : s.map((x) => x.id).join(); })()`;
// New: one standings-style table's rows as {name, cells by heading}
const NEW_TABLES = `[...document.querySelectorAll('#newstats table.nstats')].map((t) => {
  const heads = [...t.querySelectorAll('thead th')].map((c) => c.textContent.trim());
  return { heads, rows: [...t.querySelectorAll('tbody tr')].map((tr) => {
    const cells = [...tr.children];
    const nameCell = tr.querySelector('td.nstick, td.name');
    const name = nameCell ? ((nameCell.querySelector('a') || {}).textContent || nameCell.textContent).trim() : '';
    return { name, tags: nameCell ? [...nameCell.querySelectorAll('.ntag')].map((x) => x.textContent) : [],
      by: Object.fromEntries(heads.map((h, i) => [h, (cells[i] || {}).textContent ? cells[i].textContent.trim() : ''])) };
  }) };
})`;

async function sectionMain(br) {
  const MT = [team('Alder'), team(UIUC, 'Illini'), team('Cedar'), team('Dogwood'), team('Elm'), team('Fir')];
  MT[4].marks = Object.fromEntries(ROSTER.Elm.map((p) => [p, { ug: true }]));
  MT[2].marks = Object.fromEntries(ROSTER.Cedar.map((p) => [p, { d2: true }]));
  const T = await mkTournament('Public Main Open', 'pubfull-main');
  await addRooms(T, ['Room 101', 'Room 102', 'Room 103']);
  await putRoster(T, MT, { trackUG: true, trackDiv2: true });
  let sched = buildSchedule('pools2', MT.map((t) => t.name), T.rooms.map((r) => ({ name: r.name, bucket: r.id })));
  await putSchedule(T, sched);
  for (let r = 1; r <= 5; r++) await putPacket(T, r, mkPacket(r, { tuCats: MAIN_TU_CATS, bonusCats: MAIN_BONUS_CATS, nbsp: r === 1 }));
  await startT(T);
  await settle(T);
  const played = [];
  const sgOf = (round, x, y) => schedGames(sched).find((s) => s.round === round && [s.a, s.b].sort().join('\n') === [x, y].sort().join('\n'));
  async function playStd(round, win, lose, opts = {}) {
    const g = mkGame({ round, win, lose, tus: stdTossups(opts), sub: !!opts.sub });
    await upload(T, sgOf(round, win, lose).room, round, g.filename, g.qbj);
    played.push(g);
    return g;
  }
  async function playFF(round, win, lose) {
    const g = { round, win, lose, forfeit: true, qbj: forfeitQbj(round, win, lose), filename: `Round_${round}_${win}_${lose}_forfeit.qbj` };
    await upload(T, sgOf(round, win, lose).room, round, g.filename, g.qbj);
    played.push(g);
    return g;
  }
  const setRound = (n) => must('round ' + n, call(T.A, { method: 'POST', json: { current_round: n } }));
  const roomStart = (name, n) => must('start ' + n, call(`/b/${room(T, name).secret}/start?round=${n}`, { method: 'POST' }));
  const tab = await br.newTab();

  /* --- before any game --- */
  await openPub(tab, T.slug);
  await check('pub-01 header: the tournament name heads the page and names the browser tab', async () => {
    const x = await tab.js(`[document.querySelector('h1#tname').textContent, document.title]`);
    return (x[0] === T.name && x[1] === T.name) || x;
  });
  await check('pub-01 header: the label beside it says "Round 1", and Refresh sits at the right', async () => {
    const x = await tab.js(`(() => { const h = document.querySelector('header'); const b = document.querySelector('#refresh');
      const br = b.getBoundingClientRect(); const hr = h.getBoundingClientRect();
      return { label: document.querySelector('#round').textContent, btn: b.textContent,
        rightmost: [...h.children].every((c) => c === b || c.getBoundingClientRect().right <= br.left + 1),
        edge: hr.right - br.right, labelLeftOfButton: document.querySelector('#round').getBoundingClientRect().right <= br.left + 1 }; })()`);
    return (x.label === 'Round 1' && x.btn === 'Refresh' && x.rightmost && x.edge < 40 && x.labelLeftOfButton) || x;
  });
  await check('pub-03 opening tab: a live tournament with a schedule opens on Schedule, its hash left alone', async () => {
    const x = await tab.js(`[document.querySelector('.tab.active').id, location.hash, !!document.querySelector('#out .schedviews')]`);
    return (x[0] === 'tab-schedule' && x[1] === '' && x[2]) || x;
  });
  await check('pub-02 tabs: Schedule, Stats and Categories (the map has rounds); no Buzzpoints while they are off', async () => {
    const x = await tab.js(`[...document.querySelectorAll('.tab')].filter((t) => !t.hidden && t.offsetParent).map((t) => t.textContent)`);
    return q(x) === q(['Schedule', 'Stats', 'Categories']) || x;
  });
  await check('pub-02 tabs: a click draws the tab, marks it active and rewrites the hash in place (#stats, #cats, #schedule)', async () => {
    const len = await tab.js('history.length');
    const seen = [];
    for (const id of ['stats', 'cats', 'schedule']) {
      await tab.click('#tab-' + id);
      const x = await tab.js(`[[...document.querySelectorAll('.tab.active')].map((t) => t.id), location.hash, history.length,
        document.querySelector('#out').innerText.trim().slice(0, 40)]`);
      seen.push(x);
      if (q(x[0]) !== q(['tab-' + id]) || x[1] !== '#' + id || x[2] !== len) return seen;
    }
    return true;
  });
  await tabTo(tab, 'stats');
  await check('st-16 no games: Stats says "No games yet", with no layout bar', async () => {
    const x = await tab.js(`[document.querySelector('#out').innerText.trim(), !!document.querySelector('.statsbar, [data-layout], iframe')]`);
    return (x[0] === 'No games yet' && !x[1]) || x;
  });
  await tabTo(tab, 'cats');
  await check('cat-07 no games: Categories says "No games yet"', async () => (await tab.js(`document.querySelector('#out').innerText.trim()`)) === 'No games yet' || tab.js(`document.querySelector('#out').innerText`));
  await tab.goto(pubUrl(T.slug, '', '#buzz'));
  await tab.wait(`!!document.querySelector('.tab.active')`, 'the page');
  await check('pub-03 opening tab: #buzz while Buzzpoints is hidden opens the usual first tab (Schedule)', async () => {
    const x = await tab.js(`[document.querySelector('.tab.active').id, document.querySelector('#tab-buzz').hidden]`);
    return (x[0] === 'tab-schedule' && x[1]) || x;
  });
  // a tab picked before the first load lands is drawn when it does
  faults.push({ test: (u) => u.pathname === '/pub/' + T.slug, delay: 1500, once: true });
  await tab.goto(pubUrl(T.slug));
  await tab.click('#tab-stats');
  const earlyErrors = tab.errors.length;
  await tab.wait(`window.__qt.msgs.some((m) => m.t !== 'Loading')`, 'the slow first load');
  await check('pub-03 opening tab: Stats clicked before the first load lands is drawn once it does, with no error', async () => {
    const x = await tab.js(`[document.querySelector('.tab.active').id, location.hash, document.querySelector('#out').innerText.trim(), document.querySelector('#msg').textContent]`);
    return (x[0] === 'tab-stats' && x[1] === '#stats' && x[2] === 'No games yet' && x[3] === '' && tab.errors.length === earlyErrors) || { x, errors: tab.errors.slice(earlyErrors) };
  });
  faults = [];

  await openPub(tab, T.slug, { hash: '#schedule' });
  await tab.click('[data-schedview="now"]');
  await tab.wait(`!!document.querySelector('.nowgrid')`, 'Now');
  await check('sch-07 chips: Now shows two pools, so the chips read All, Pool A, Pool B', async () => {
    const x = await tab.texts('.chipstack [data-pool]');
    return q(x) === q(['All', 'Pool A', 'Pool B']) || x;
  });
  await check('sch-04 full names: Now shows a long name whole, in its game and its bye line', async () => {
    const x = await tab.js(`[[...document.querySelectorAll('.nowgrid .gl .t')].map((e) => e.textContent), [...document.querySelectorAll('.nowgrid .byes')].map((e) => e.textContent.trim()), document.querySelectorAll('.nowgrid .cut').length]`);
    return (x[0].includes(UIUC) && x[1].includes('Bye: ' + byesOf(sched, 1).join(', ')) && x[2] === 0) || x;
  });
  await tab.click('[data-schedview="all"]');
  await tab.wait(`!!document.querySelector('table.sched')`, 'All rounds');
  const allHeads = () => tab.js(`[...document.querySelectorAll('table.sched')].map((t) => [...t.querySelector('tr').children].map((c) => c.textContent))`);
  await check('sch-03 All rounds: a heading for each phase', async () => q(await tab.texts('#schedout .rhead')) === q(['Prelims', 'Playoffs']) || tab.texts('#schedout .rhead'));
  await check('sch-03 All rounds: a column for each room the phase uses, and Bye when it has byes', async () => {
    const x = await allHeads();
    return q(x) === q([['', 'Room 101', 'Room 102', 'Bye'], ['', 'Room 101', 'Room 102', 'Room 103']]) || x;
  });
  await check('sch-03 All rounds: two rows a round, one line a team (a long one cut), the current round highlighted', async () => {
    const x = await tab.js(`(() => { const t = document.querySelector('table.sched'); const rows = [...t.querySelectorAll('tr')].slice(1);
      return { rows: rows.length, rounds: [...t.querySelectorAll('td.roundcell')].map((c) => [c.textContent, c.rowSpan, c.classList.contains('now')]),
        nowRows: [...new Set([...document.querySelectorAll('table.sched td.now')].map((c) => c.closest('tr').rowIndex))],
        top: [...rows[0].querySelectorAll('td.la .gl .t')].map((e) => e.textContent), bottom: [...rows[1].querySelectorAll('td.lb .gl .t')].map((e) => e.textContent) }; })()`);
    const r1 = schedGames(sched).filter((s) => s.round === 1);
    const byes = byesOf(sched, 1).map((n) => (n.length > 22 ? UIUC_CUT : n));
    const top = [...r1.map((s) => s.a), byes[0]];
    const bottom = [...r1.map((s) => s.b), byes[1]];
    return (x.rows === 6 && q(x.rounds) === q([['1', 2, true], ['2', 2, false], ['3', 2, false]]) && q(x.nowRows) === q([1, 2])
      && q(x.top) === q(top) && q(x.bottom) === q(bottom)) || { x, top, bottom };
  });
  await check('sch-05 styling: an unfilled playoff slot is italic', async () => {
    const x = await tab.js(`[...document.querySelectorAll('table.sched')[1].querySelectorAll('.gl')].map((g) => [g.querySelector('.t').textContent, g.classList.contains('ph'), getComputedStyle(g).fontStyle])`);
    return (x.length === 10 && x.every((g) => /^[AB][123]$/.test(g[0]) && g[1] && g[2] === 'italic')) || x;
  });
  await check('sch-07 chips: All rounds offers All, the pools, then the playoff brackets, in schedule order', async () => {
    const x = await tab.texts('.chipstack [data-pool]');
    return q(x) === q(['All', 'Pool A', 'Pool B', 'Championship', 'Consolation']) || x;
  });
  await tab.click('[data-pool="Championship"]');
  await check('sch-07 chips: Championship leaves its own games: one phase, its rooms, no Bye column', async () => {
    const x = { heads: await allHeads(), rh: await tab.texts('#schedout .rhead'), t: await tab.texts('table.sched .gl .t') };
    const ch = schedGames(sched).filter((s) => s.g.bracket === 'CH');
    const want = [ch.filter((s) => s.round === 4), ch.filter((s) => s.round === 5)].flatMap((r) => [...r.map((s) => s.a), ...r.map((s) => s.b)]);
    return (q(x.rh) === q(['Playoffs']) && q(x.heads) === q([['', 'Room 101', 'Room 102']]) && q(x.t) === q(want)) || { x, want };
  });
  await tab.click('[data-pool="Pool A"]');
  await check('sch-07 chips: Pool A leaves the prelims of pool A, in its one room, and no Bye column', async () => {
    const x = { heads: await allHeads(), rh: await tab.texts('#schedout .rhead'), t: await tab.texts('table.sched .gl .t') };
    return (q(x.rh) === q(['Prelims']) && q(x.heads) === q([['', 'Room 101']]) && x.t.length === 6 && x.t.every((n) => sched.pools.A.includes(n))) || x;
  });
  await tab.click('[data-schedview="now"]');
  await check('sch-07 chips: the pick holds in Now while Pool A is in view', async () => {
    const x = await tab.js(`[(document.querySelector('[data-pool].on') || {}).textContent, [...document.querySelectorAll('.nowgrid .gl .t')].map((e) => e.textContent)]`);
    return (x[0] === 'Pool A' && x[1].length && x[1].every((n) => sched.pools.A.includes(n))) || x;
  });
  await tab.click('[data-schedview="all"]');
  await tab.click('[data-pool="Championship"]');
  await tab.click('[data-schedview="now"]');
  await check('sch-07 chips: a picked bracket out of view (Championship, in Now) resets to All', async () => {
    const x = await tab.js(`[(document.querySelector('[data-pool].on') || {}).textContent, document.querySelectorAll('.nowgrid .gg').length]`);
    return (x[0] === 'All' && x[1] === 4) || x;
  });

  // sch-04: one-line names in All rounds
  await tab.click('[data-schedview="all"]');
  await tab.wait(`!!document.querySelector('table.sched .cut')`, 'a cut name');
  await check('sch-04 cut names: past 22 characters a name is cut in the middle, keeps its letter, and is dotted-underlined', async () => {
    const x = await tab.js(`[...document.querySelectorAll('table.sched .cut')].map((c) => [c.textContent, c.dataset.full, getComputedStyle(c).textDecorationStyle, getComputedStyle(c).textDecorationLine])`);
    return (x.length >= 3 && x.every((c) => c[0] === UIUC_CUT && c[1] === UIUC && c[2] === 'dotted' && c[3].includes('underline'))) || x;
  });
  const tip = () => tab.js(`(() => { const t = document.querySelector('.nametip'); if (!t) return null; const r = t.getBoundingClientRect();
    return { hidden: t.hidden, text: t.textContent, inBody: t.parentElement === document.body, pos: getComputedStyle(t).position,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, w: r.width }; })()`);
  await tab.hover('table.sched .cut');
  await check('sch-04 cut names: hovering one shows its full name in a label over the page, not clipped by the table', async () => {
    const t = await tab.wait(`(() => { const t = document.querySelector('.nametip'); return t && !t.hidden; })()`, 'the name label').then(tip);
    return (t.text === UIUC && t.inBody && ['fixed', 'absolute'].includes(t.pos) && t.inView && t.w > 0) || t;
  });
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 880 });
  await check('sch-04 cut names: moving away hides the label', async () => (await tip()).hidden === true || tip());
  await tab.js(`document.querySelector('table.sched .cut').focus(), true`);
  await check('sch-04 cut names: focusing one shows the label', async () => { const t = await tip(); return (!t.hidden && t.text === UIUC) || t; });
  await tab.js(`document.activeElement.blur(), true`);
  await tab.press('table.sched .cut');
  await check('sch-04 cut names: tapping one shows the label', async () => { const t = await tip(); return (!t.hidden && t.text === UIUC) || t; });
  await tab.pressAt(640, 10);
  await check('sch-04 cut names: a click elsewhere hides it', async () => (await tip()).hidden === true || tip());
  await tab.S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 360, deviceScaleFactor: 1, mobile: false });
  await tab.press('table.sched .cut');
  await tab.wait(`!document.querySelector('.nametip').hidden`, 'the label again');
  const y0 = await tab.js('window.scrollY');
  await tab.js(`window.scrollBy(0, window.scrollY > 40 ? -40 : 40), true`);
  await check('sch-04 cut names: scrolling hides the label', async () => {
    await tab.wait(`window.scrollY !== ${y0}`, 'the page to scroll');
    await tab.wait(`document.querySelector('.nametip').hidden`, 'the label to go', 3000);
    return true;
  });
  await tab.view('desktop');
  await tab.js('window.scrollTo(0, 0), true');

  // sch-08: follow a team
  const teamRows = () => tab.js(`[...document.querySelectorAll('#schedout table tr')].map((tr) => [[...tr.children].map((c) => c.textContent.trim()), tr.classList.contains('nowrow'),
    !!tr.querySelector('td.name.ph') && getComputedStyle(tr.querySelector('td.name.ph')).fontStyle === 'italic'])`);
  const wantTeamRows = (name, results = {}) => {
    const out = [];
    for (const r of sched.phases.flatMap((ph) => ph.rounds)) {
      const g = r.games.find((x) => (x.a && x.a.team) === name || (x.b && x.b.team) === name);
      if (g) {
        const opp = (g.a && g.a.team) === name ? g.b : g.a;
        out.push([String(r.round), opp.team || opp.label, sched.rooms[g.room].name, results[r.round] || '–']);
      } else if (r.byes.some((s) => s && s.team === name)) out.push([String(r.round), 'Bye', '', '']);
    }
    return out;
  };
  await check('sch-08 follow a team: the list is All teams, then the roster\'s teams', async () => {
    const x = await tab.texts('#teamsel option');
    return q(x) === q(['All teams', ...MT.map((t) => t.name)]) || x;
  });
  await tab.select('#teamsel', 'Elm');
  await check('sch-08 follow a team: Elm\'s rounds, opponents, rooms and results, a bye row, the current round highlighted', async () => {
    const x = await teamRows();
    const want = [[['Round', 'Opponent', 'Room', 'Result'], false, false], ...wantTeamRows('Elm').map((r) => [r, r[0] === '1', false])];
    return q(x) === q(want) || { x, want };
  });
  await check('sch-07 chips: hidden while a team is followed', async () => !(await tab.exists('#out .chipstack')) || 'chips shown');
  await tab.select('#teamsel', 'Fir');
  await check('sch-04 full names: following a team shows a long opponent name whole', async () => (await tab.texts('#schedout td.name')).includes(UIUC) || tab.texts('#schedout td.name'));
  await tab.select('#teamsel', '');
  await check('sch-08 follow a team: "All teams" goes back to the rounds', async () => {
    const x = await tab.js(`[!!document.querySelector('table.sched'), [...document.querySelectorAll('#schedout th')].some((c) => c.textContent === 'Opponent')]`);
    return (x[0] && !x[1]) || x;
  });

  /* --- round 1 --- */
  await tab.click('[data-schedview="now"]');
  const g11 = await playStd(1, 'Dogwood', 'Elm', { k: 1 });
  await playFF(1, 'Cedar', 'Fir');
  await settle(T);
  let st = (await call('/pub/' + T.slug)).body;
  let r = await refresh(tab);
  // the state carries no roster stamp (only a snapshot does), so the roster is read again with the games
  await check('pub-07 refresh: shows "Loading", then fetches the state, the round that moved (one request) and the roster read with it; no schedule or category map', async () => {
    const paths = workerPaths(r.fetches);
    return (r.msgs[0].t === 'Loading' && q([...paths].sort()) === q([`/pub/${T.slug}`, `/pub/${T.slug}/roster`, `/pub/${T.slug}/rounds?n=1@${st.rounds['1']}`].sort())) || { msgs: r.msgs, paths };
  });
  const line = (sel) => tab.js(`[...document.querySelectorAll(${q(sel)})].map((g) => ({ t: g.querySelector('.t').textContent, s: (g.querySelector('.s') || {}).textContent || null,
    won: g.classList.contains('won'), lost: g.classList.contains('lost'), weight: Number(getComputedStyle(g).fontWeight), color: getComputedStyle(g).color }))`);
  await check('pub-07 refresh: the open tab redraws in place with the round\'s results', async () => {
    const x = await line('.nowblock:first-child .gl');
    const d = x.find((l) => l.t === 'Dogwood');
    return (d && d.s === String(g11.exp[0].points)) || x;
  });
  await check('sch-05 styling: the winner\'s line is bold, the loser\'s muted', async () => {
    const x = await line('.nowblock:first-child .gl');
    const w = x.find((l) => l.t === 'Dogwood');
    const l = x.find((y) => y.t === 'Elm');
    return (w.won && w.weight >= 600 && l.lost && !l.won && l.weight < 600 && l.color !== w.color && l.s === String(g11.exp[1].points)) || x;
  });
  await check('sch-05 styling: a forfeit reads W for the winner and FF for the team that forfeited', async () => {
    const x = await line('.nowblock:first-child .gl');
    const w = x.find((l) => l.t === 'Cedar');
    const l = x.find((y) => y.t === 'Fir');
    return (w.s === 'W' && w.won && l.s === 'FF' && l.lost) || x;
  });
  // the grid's unplayed squares, while a pool is still being played
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await tab.wait(`!!document.querySelector('#newstats [data-standview]')`, 'the New standings');
  await tab.click('[data-standview="grid"]');
  await tab.wait(`!!document.querySelector('table.pgrid')`, 'the grid');
  await check('st-12 grid: an unplayed scheduled game is "R#", with its round as the tooltip', async () => {
    const x = await tab.js(`[...document.querySelectorAll('table.pgrid td.todo')].map((c) => [c.textContent, c.title])`);
    return (x.length && x.filter((c) => c[0]).every((c) => /^R[23]$/.test(c[0]) && c[1] === 'Round ' + c[0].slice(1)) && x.some((c) => c[0] === 'R2')) || x;
  });
  await tab.click('[data-standview="table"]');
  await tab.click('[data-layout="classic"]');
  await tabTo(tab, 'schedule');

  // round 2 opened, but no room has started it: still round 1 on the floor
  await setRound(2);
  await settle(T);
  r = await refresh(tab);
  await check('pub-07 refresh: with nothing moved, only the state is fetched, and no "Loading"', async () => {
    const paths = workerPaths(r.fetches);
    return (q(paths) === q([`/pub/${T.slug}`]) && !r.msgs.some((m) => m.t === 'Loading')) || { paths, msgs: r.msgs };
  });
  const nowHeads = () => tab.js(`[...document.querySelectorAll('.nowhead')].map((h) => [h.querySelector('h3').textContent, h.querySelector('.nowtag').textContent])`);
  await check('sch-02 live now: a round opened but not started by any room is not live yet', async () => {
    const x = [await tab.text('#round'), await nowHeads()];
    return (x[0] === 'Round 1' && q(x[1]) === q([['Round 1', 'Live now'], ['Round 2', 'Up next']])) || x;
  });
  await roomStart('Room 101', 2);
  await settle(T);
  r = await refresh(tab);
  await bug('sch-02 live now: once a room starts round 2, Refresh shows it Live now, round 3 Up next', async () => {
    const x = [await tab.text('#round'), await nowHeads()];
    return (x[0] === 'Round 2' && q(x[1]) === q([['Round 2', 'Live now'], ['Round 3', 'Up next']])) || x;
  }, 'a Refresh that finds only the live round moved updates the header label but does not redraw the open tab, so Now keeps the old round Live now (pubview.js load returns before render when no stamp moved)');
  await openPub(tab, T.slug, { hash: '#schedule' });
  await check('sch-02 live now: once a room starts round 2 it is Live now, round 3 Up next (on a fresh load)', async () => {
    const x = [await tab.text('#round'), await nowHeads()];
    return (x[0] === 'Round 2' && q(x[1]) === q([['Round 2', 'Live now'], ['Round 3', 'Up next']])) || x;
  });
  await check('pub-07 refresh: the round label updates though nothing else was fetched', async () => {
    const paths = workerPaths(r.fetches);
    return (q(paths) === q([`/pub/${T.slug}`]) && (await tab.text('#round')) === 'Round 2') || paths;
  });
  // an idle tab: fifteen minutes of (virtual) time, and not one request
  {
    const idle = await br.newTab();
    await openPub(idle, T.slug);
    const n = idle.reqs.length;
    const expired = idle.once((m) => m.sessionId === idle.sessionId && m.method === 'Emulation.virtualTimeBudgetExpired', 60000, 'fifteen idle minutes');
    await idle.S('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 15 * 60 * 1000 });
    await expired;
    await check('pub-07 nothing polls: an idle tab makes no request in fifteen minutes', async () => {
      const after = idle.reqs.slice(n).map((x) => x.url);
      return after.length === 0 || after;
    });
    await idle.close();
  }

  /* --- round 2 --- */
  const g21 = await playStd(2, 'Alder', 'Elm', { k: 0 });
  const g22 = await playStd(2, UIUC, 'Fir', { k: 2 });
  await settle(T);
  await refresh(tab);
  // a score opens its box score (Classic, the default layout)
  await tab.click(scoreSel(sgOf(2, 'Alder', 'Elm')));
  await tab.wait(`document.querySelector('#tab-stats').classList.contains('active') && !!document.querySelector('iframe.report')`, 'the box score');
  await check('sch-06 score link: opens Stats (Classic) at the game\'s box score, marked, with "← Back to Schedule"', async () => {
    const x = await tab.fwait(`(() => { const m = document.querySelector('.qt-mark'); return m && { page: ${SHOWN_PAGE}, text: m.textContent,
      back: (document.querySelector('.qt-back') || {}).textContent }; })()`, 'the mark');
    return (x.page === 'games' && x.text.includes('Alder') && x.text.includes('Elm') && x.text.includes(String(g21.exp[0].points))
      && x.back === '← Back to Schedule') || x;
  });
  await tab.fclick('.qt-back');
  await check('sch-06 score link: Back to Schedule returns to the Schedule tab', async () => {
    await tab.wait(`document.querySelector('#tab-schedule').classList.contains('active') && !!document.querySelector('.nowgrid')`, 'the schedule');
    return true;
  });
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await tab.wait(`!!document.querySelector('#newstats')`, 'New');
  await tabTo(tab, 'schedule');
  const errs = tab.errors.length;
  await tab.click(scoreSel(sgOf(2, UIUC, 'Fir')));
  await bug('sch-06 score link: in New, while only the prelims are played, it lands on the game in Scoreboard', async () => {
    const x = await tab.wait(`!!document.querySelector('.nsec.nmark')`, 'the marked game', 3000).catch(() => false);
    return (x && tab.errors.length === errs) || { errors: tab.errors.slice(errs), newstats: await tab.js(`(document.querySelector('#newstats') || {}).innerHTML.length`) };
  }, 'with the New layout picked and only the prelims played, clicking a score on the Schedule throws "TypeError: Cannot read properties of null (reading \'includes\')" in renderNewStats (pubview.js: stages.find(...).own.includes, own is null for the pools-only standings) and Stats stays empty');
  // the page stays broken (its pending game is never cleared) until it is loaded again
  await tab.js(`localStorage.setItem('qbtdStatsLayout', 'classic'); true`);
  await openPub(tab, T.slug, { hash: '#schedule' });

  /* --- round 3: an overtime game, a substitution --- */
  await setRound(3);
  const g31 = await playStd(3, 'Alder', 'Dogwood', { k: 3, ot: true });
  const g32 = await playStd(3, UIUC, 'Cedar', { k: 1, sub: true });
  await settle(T);
  await refresh(tab);
  // pool A's places are in first; pool B's slots stay labels
  const halfFilled = JSON.parse(JSON.stringify(sched));
  fillPlaceholders(halfFilled, { A: ['Alder', 'Dogwood', 'Elm'] });
  await putSchedule(T, halfFilled);
  await settle(T);
  st = (await call('/pub/' + T.slug)).body;
  r = await refresh(tab);
  await check('pub-07 refresh: a saved schedule moves its stamp, and only the schedule is fetched again', async () => {
    const paths = workerPaths(r.fetches);
    return q(paths) === q([`/pub/${T.slug}`, `/pub/${T.slug}/schedule`]) || paths;
  });
  sched = halfFilled;
  await tab.select('#teamsel', 'Alder');
  await check('sch-08 follow a team: W a–b results, a playoff opponent still a placeholder, the current round highlighted', async () => {
    const x = (await teamRows()).map((row) => row.slice(0, 2));
    const res = { 2: `W ${g21.exp[0].points}–${g21.exp[1].points}`, 3: `W ${g31.exp[0].points}–${g31.exp[1].points}` };
    const want = [[['Round', 'Opponent', 'Room', 'Result'], false], ...wantTeamRows('Alder', res).map((row) => [row, row[0] === '3'])];
    return q(x) === q(want) || { x, want };
  });
  await bug('sch-08 follow a team: a placeholder opponent is italic', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#schedout td.name')].filter((c) => /^B\\d$/.test(c.textContent)).map((c) => [c.className, getComputedStyle(c).fontStyle])`);
    return (x.length === 2 && x.every(([cls, fs]) => cls.includes('ph') && fs === 'italic')) || x;
  }, 'the team view marks a placeholder opponent with class "ph", but no rule styles it (td.css styles .ph only inside table.sched, pub.css only .gl.ph), so "B1" reads like a team');
  await tab.select('#teamsel', 'Fir');
  await check('sch-08 follow a team: a loss reads L a–b, a forfeit "(forfeit)"', async () => {
    const x = (await teamRows()).slice(1).map((row) => row[0][3]);
    return q(x.slice(0, 2)) === q(['L (forfeit)', `L ${g22.exp[1].points}–${g22.exp[0].points}`]) || x;
  });
  await tab.select('#teamsel', '');
  await tab.click('[data-schedview="all"]');
  await check('sch-05 styling: filled playoff slots are plain, the ones still waiting italic', async () => {
    const x = await tab.js(`[...document.querySelectorAll('table.sched')[1].querySelectorAll('.gl')].map((g) => [g.querySelector('.t').textContent, g.classList.contains('ph')])`);
    return (x.every(([n, ph]) => (/^B\d$/.test(n) ? ph : !ph)) && x.some(([n]) => n === 'Alder')) || x;
  });
  const filled = JSON.parse(JSON.stringify(halfFilled));
  fillPlaceholders(filled, { B: [UIUC, 'Cedar', 'Fir'] });
  await putSchedule(T, filled);
  sched = filled;
  await settle(T);
  await refresh(tab);

  /* --- the stats after the prelims --- */
  const prelims = tallyTeams(played);
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="classic"]');
  await tab.wait(`!!document.querySelector('iframe.report')`, 'Classic');
  await check('st-02 classic: the six pages in one frame, the first shown at once', async () => {
    const x = await tab.fwait(`(() => { const ids = [...document.querySelectorAll('section[id^="page-"]')].map((s) => s.id);
      return ids.length === 6 && { ids, shown: ${SHOWN_PAGE},
        nav: [...document.querySelectorAll('#page-standings a[href$="-top"]')].map((a) => a.textContent).slice(0, 6) }; })()`, 'the report');
    return (q(x.ids) === q(['page-standings', 'page-individuals', 'page-games', 'page-teamdetail', 'page-playerdetail', 'page-rounds'])
      && x.shown === 'standings' && q(x.nav) === q(['Standings', 'Individuals', 'Scoreboard', 'Team Detail', 'Player Detail', 'Round Report'])) || x;
  });
  await check('st-02 classic: the frame grows to its content (at least 400 px)', async () => {
    const h = await tab.js(`parseInt(document.querySelector('iframe.report').style.height, 10)`);
    const inner = await tab.fjs('document.documentElement.scrollHeight');
    return (h >= 400 && Math.abs(h - Math.max(400, inner + 16)) <= 24) || { h, inner };
  });
  const classicStandings = async () => {
    const tables = await tab.fjs(FRAME_TABLES('standings'));
    const out = {};
    for (const t of tables) {
      const iw = t.heads.indexOf('W');
      const il = t.heads.indexOf('L');
      const ip = t.heads.indexOf('PP20TUH');
      const it = t.heads.indexOf('Team');
      if (iw < 0 || ip < 0 || it < 0) continue;
      for (const row of t.rows) if (row[it]) out[row[it]] = { w: Number(row[iw]), l: Number(row[il]), pp: Number(row[ip]) };
    }
    return out;
  };
  await check('st-02 classic: standings by pool, with each team\'s W, L and points per 20 (overtime left out)', async () => {
    const x = await classicStandings();
    const bad = MT.map((t) => t.name).filter((n) => !x[n] || x[n].w !== prelims[n].w || x[n].l !== prelims[n].l
      || Math.abs(x[n].pp - pp(prelims[n])) > 0.01);
    return bad.length === 0 || { x, want: Object.fromEntries(MT.map((t) => [t.name, { ...prelims[t.name], pp: pp(prelims[t.name]) }])) };
  });
  await check('st-02 classic: the standings head each pool', async () => {
    const x = await tab.fjs(`[...document.querySelectorAll('#page-standings h2, #page-standings h3')].map((h) => h.textContent.trim())`);
    return (x.includes('Pool A') && x.includes('Pool B')) || x;
  });
  await check('st-03 sandbox: YellowFruit\'s credit link is hidden in the frame', async () => {
    const x = await tab.fjs(`[...document.querySelectorAll('.html-rpt-hide-in-yft-app')].map((e) => getComputedStyle(e).display)`);
    return (x.length > 0 && x.every((d) => d === 'none')) || x;
  });
  const sandboxTag = '[changed: The Classic stat report on the public page runs in a sandboxed frame.]';
  await check(`st-03 sandbox: the frame runs scripts only (no allow-same-origin), so the page can't reach into it ${sandboxTag}`, async () => {
    const x = await tab.js(`(() => { const f = document.querySelector('iframe.report'); return [f.getAttribute('sandbox'), f.contentDocument === null]; })()`);
    return (x[0] === 'allow-scripts' && x[1]) || x;
  });
  await check(`st-03 sandbox: the report can't reach the page, its saved links (localStorage) or its cookies ${sandboxTag}`, async () => {
    const x = await tab.fjs(`(() => { const t = (f) => { try { f(); return 'reached'; } catch (e) { return 'blocked'; } };
      return [t(() => parent.document.title), t(() => localStorage.length), t(() => document.cookie)]; })()`);
    return q(x) === q(['blocked', 'blocked', 'blocked']) || x;
  });

  // st-05: links, marks and Back inside the report
  await tab.fclick('#page-standings a[href="#teamdetail-Dogwood"]');
  await check('st-05 classic links: a team link opens Team Detail at the team, marked, with "← Back to Standings"', async () => {
    const x = await tab.fwait(`(() => { const m = document.querySelector('.qt-mark'); return m && { page: ${SHOWN_PAGE}, marks: document.querySelectorAll('.qt-mark').length,
      head: m.textContent.trim().slice(0, 40), back: (m.querySelector('.qt-back') || {}).textContent }; })()`, 'the mark');
    return (x.page === 'teamdetail' && x.marks === 1 && x.head.startsWith('Dogwood') && x.back === '← Back to Standings') || x;
  });
  await check('st-05 classic links: the page is scrolled to the marked team', async () => {
    const y = await tab.js(`(() => { const f = document.querySelector('iframe.report').getBoundingClientRect(); return f.top; })()`);
    const at = await tab.fjs(`document.querySelector('.qt-mark').getBoundingClientRect().top`);
    const top = y + at;
    return (top > -20 && top < 200) || { frameTop: y, markTop: at };
  });
  const pLink = await tab.fjs(`document.querySelector('.qt-mark a[href^="#playerdetail-"]').textContent`);
  await tab.fclick('.qt-mark a[href^="#playerdetail-"]');
  await check('st-05 classic links: a player link from there opens Player Detail, "← Back to Team Detail", one mark at a time', async () => {
    const x = await tab.fwait(`(() => { const m = document.querySelector('.qt-mark'); return ${SHOWN_PAGE} === 'playerdetail' && m && { marks: document.querySelectorAll('.qt-mark').length,
      head: m.textContent.trim().slice(0, 30), back: (m.querySelector('.qt-back') || {}).textContent }; })()`, 'the player');
    return (x.marks === 1 && ROSTER.Dogwood.includes(pLink) && x.head.startsWith(pLink) && x.back === '← Back to Team Detail') || { x, pLink };
  });
  await tab.fclick('.qt-back');
  await check('st-05 classic links: Back steps back to Team Detail with its own mark and Back link', async () => {
    const x = await tab.fwait(`(() => { const m = document.querySelector('.qt-mark'); return ${SHOWN_PAGE} === 'teamdetail' && m && { head: m.textContent.trim().slice(0, 20),
      back: (m.querySelector('.qt-back') || {}).textContent }; })()`, 'back to the team');
    return (x.head.startsWith('Dogwood') && x.back === '← Back to Standings') || x;
  });
  await tab.fclick('.qt-back');
  await check('st-05 classic links: and Back again to Standings', async () => {
    const x = await tab.fwait(`${SHOWN_PAGE} === 'standings' && { marks: document.querySelectorAll('.qt-mark').length, backs: document.querySelectorAll('.qt-back').length }`, 'back to the standings');
    return (x.marks === 0 && x.backs === 0) || x;
  });
  await tab.fclick('#page-standings a[href="#teamdetail-Dogwood"]');
  await tab.fwait(`${SHOWN_PAGE} === 'teamdetail' && !!document.querySelector('.qt-back')`, 'Team Detail');
  await tab.fclick('#page-teamdetail a[href="#games-top"]');
  await check('st-05 classic links: a link to a page\'s top clears the trail (no mark, no Back)', async () => {
    const x = await tab.fwait(`${SHOWN_PAGE} === 'games' && { marks: document.querySelectorAll('.qt-mark').length, backs: document.querySelectorAll('.qt-back').length }`, 'the Scoreboard');
    return (x.marks === 0 && x.backs === 0) || x;
  });

  // st-07: switching layouts keeps the place
  await tab.fclick('#page-games a[href="#standings-top"]');
  await tab.fwait(`${SHOWN_PAGE} === 'standings'`, 'standings');
  await tab.fclick('#page-standings a[href="#teamdetail-Elm"]');
  await tab.fwait(`${SHOWN_PAGE} === 'teamdetail' && !!document.querySelector('.qt-mark')`, 'Elm');
  await tab.click('[data-layout="new"]');
  await check('st-07 layouts: Classic to New keeps the page, the team and its mark', async () => {
    const x = await tab.wait(`(() => { const m = document.querySelector('.nsec.nmark'); return m && { sec: (document.querySelector('[data-statssec].on') || {}).textContent,
      at: m.dataset.at, head: m.querySelector('.nhead span').textContent, top: m.getBoundingClientRect().top }; })()`, 'the marked team');
    return (x.sec === 'Teams' && x.at === 'teamdetail-Elm' && x.head === 'Elm' && x.top > -20 && x.top < 160) || x;
  });
  await tab.click('[data-layout="classic"]');
  await check('st-07 layouts: and back to Classic, the same page and team, still marked', async () => {
    const x = await tab.fwait(`(() => { const m = document.querySelector('.qt-mark'); return m && { page: ${SHOWN_PAGE}, head: m.textContent.trim().slice(0, 10) }; })()`, 'Classic again');
    return (x.page === 'teamdetail' && x.head.startsWith('Elm')) || x;
  });

  // st-06: dark mode inside the report
  await tab.fclick('#page-teamdetail a[href="#standings-top"]');
  const colors = () => tab.fwait(`document.body.getBoundingClientRect().width > 0 && { bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color,
    link: getComputedStyle(document.querySelector('#page-standings a[href^="#teamdetail-"]')).color,
    even: getComputedStyle(document.querySelector('#page-standings table tr:nth-child(even)')).backgroundColor }`, 'the report colours');
  await check('st-06 classic dark mode: a light theme gets YellowFruit\'s white page', async () => {
    const x = await colors();
    return x.bg === 'rgb(255, 255, 255)' || x;
  });
  await tab.dark(true);
  await tab.reload();
  await tab.wait(`!!document.querySelector('iframe.report')`, 'Classic in the dark');
  await check('st-06 classic dark mode: with a dark system theme the report is dark (background, text, links, striped rows)', async () => {
    await tab.fwait(`getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)'`, 'dark colours');
    const x = await colors();
    return (x.bg === 'rgb(35, 35, 38)' && x.fg === 'rgb(228, 228, 231)' && x.link === 'rgb(143, 176, 245)' && x.even === 'rgb(44, 44, 49)') || x;
  });
  await tab.dark(false);
  await tab.reload();
  await tab.wait(`!!document.querySelector('.tab.active')`, 'light again');

  // the New layout
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await tab.click('[data-statssec="standings"]');
  await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'New standings');
  await check('st-09 new: six section links', async () => q(await tab.texts('.statsbar [data-statssec]')) === q(['Standings', 'Individuals', 'Scoreboard', 'Teams', 'Players', 'Rounds']) || tab.texts('.statsbar [data-statssec]'));
  const newStand = async () => {
    const out = {};
    for (const t of await tab.js(NEW_TABLES)) for (const row of t.rows) out[row.name] = { ...row.by, tags: row.tags, heads: t.heads };
    return out;
  };
  await check('st-09 new: the standings show the same numbers as Classic', async () => {
    const x = await newStand();
    const c = await (async () => { await tab.click('[data-layout="classic"]'); await tab.wait(`!!document.querySelector('iframe.report')`, 'Classic'); await tab.fwait(`!!document.querySelector('#page-standings table')`, 'standings'); const s = await classicStandings(); await tab.click('[data-layout="new"]'); await tab.click('[data-statssec="standings"]'); await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'New'); return s; })();
    const bad = MT.map((t) => t.name).filter((n) => !x[n] || Number(x[n].W) !== c[n].w || Number(x[n].L) !== c[n].l || Math.abs(Number(x[n].PP20TUH) - c[n].pp) > 0.051);
    return bad.length === 0 || { bad, x, c };
  });
  await check('st-10 new standings: a table per pool with its heading, ranked as YellowFruit ranks them', async () => {
    const heads = await tab.texts('#newstats .poolhead');
    const pools = (await tab.js(NEW_TABLES)).map((t) => t.rows.map((x) => x.name));
    return (q(heads) === q(['Pool A', 'Pool B']) && q(pools) === q([['Alder', 'Dogwood', 'Elm'], [UIUC, 'Cedar', 'Fir']])) || { heads, pools };
  });
  await check('st-10 new standings: points per 20 and TUH leave overtime out', async () => {
    const x = await newStand();
    const a = prelims.Alder;
    return (x.Alder.TUH === String(a.tuh) && a.tuh === 40 && x.Alder.PP20TUH === pp(a).toFixed(1) && x.Alder.PPB === (a.bonusPts / a.bonusesHeard).toFixed(2)) || { shown: x.Alder, want: { tuh: a.tuh, pp: pp(a), ppb: a.bonusPts / a.bonusesHeard } };
  });
  await check('st-10 new standings: UG and DII tags beside the marked teams\' names', async () => {
    const x = await newStand();
    return (q(x.Elm.tags) === q(['UG']) && q(x.Cedar.tags) === q(['DII']) && q(x.Alder.tags) === q([])) || { Elm: x.Elm.tags, Cedar: x.Cedar.tags, Alder: x.Alder.tags };
  });
  await check('st-09 new: column headers stay on screen while scrolling (sticky)', async () => (await tab.js(`getComputedStyle(document.querySelector('#newstats table.nstats thead')).position`)) === 'sticky' || 'not sticky');
  await check('st-09 new: no T column when no game was tied', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#newstats table.nstats thead th')].map((c) => c.textContent.trim())`);
    return (!x.includes('T') && x.includes('15') && x.includes('10') && x.includes('-5') && !x.includes('0')) || x;
  });
  await check('st-14 narrow: a table that fits stays put (no scroll box) on a wide screen', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#newstats .tablewrap')].map((w) => [w.className, w.parentElement.className])`);
    return (x.length && x.every(([w, f]) => w.includes('nfit') && !w.includes('nscroll') && f === 'nfade')) || x;
  });

  // st-12: Table / Grid
  await tab.click('[data-standview="grid"]');
  await tab.wait(`!!document.querySelector('table.pgrid')`, 'the grid');
  const grid = () => tab.js(`[...document.querySelectorAll('table.pgrid tbody')].map((tb) => ({ head: (tb.querySelector('.poolhead') || {}).textContent,
    cols: [...tb.querySelectorAll('th.colh')].map((c) => c.textContent), rows: [...tb.querySelectorAll('tr')].filter((tr) => tr.querySelector('th.rowh')).map((tr) => ({
      team: tr.querySelector('th.rowh').textContent,
      cells: [...tr.querySelectorAll('td')].map((c) => ({ cls: c.className, text: c.textContent, tip: c.title, link: !!c.querySelector('a[data-go^="games|"]'),
        me: c.querySelector('a') ? c.querySelector('a').childNodes[0].textContent : null, opp: (c.querySelector('.opp') || {}).textContent || null })) })) }))`);
  await check('st-12 grid: chosen, it is remembered (qbtdStandView)', async () => (await tab.js(`localStorage.getItem('qbtdStandView')`)) === 'grid' || tab.js(`localStorage.getItem('qbtdStandView')`));
  await check('st-12 grid: each pool a square grid, all in one table, short names heading the columns, W–L at the end', async () => {
    const x = await grid();
    const one = await tab.js(`document.querySelectorAll('table.pgrid').length`);
    return (one === 1 && q(x.map((p) => p.head)) === q(['Pool A', 'Pool B']) && q(x[0].cols) === q(['Alder', 'Dog', 'Elm', 'W–L'])
      && q(x[1].cols) === q(['IU D', 'Cedar', 'Fir', 'W–L']) && q(x[0].rows.map((rr) => rr.cells[rr.cells.length - 1].text)) === q(['2–0', '1–1', '0–2'])) || x;
  });
  await check('st-12 grid: a square shows both scores as a link to the game, with a tooltip', async () => {
    const x = await grid();
    const alder = x[0].rows.find((rr) => rr.team === 'Alder');
    const vsElm = alder.cells[2];
    const elm = x[0].rows.find((rr) => rr.team === 'Elm').cells[0];
    return (vsElm.link && vsElm.me === String(g21.exp[0].points) && vsElm.opp === String(g21.exp[1].points) && vsElm.tip === `Alder ${g21.exp[0].points}, Elm ${g21.exp[1].points}`
      && vsElm.cls === 'won' && elm.me === String(g21.exp[1].points) && elm.cls === 'lost' && alder.cells[0].cls === 'self') || { alder, elm };
  });
  await check('st-12 grid: a forfeit reads W and FF, with what happened as the tooltip', async () => {
    const x = await grid();
    const ced = x[1].rows.find((rr) => rr.team === 'Cedar').cells[2];
    const fir = x[1].rows.find((rr) => rr.team === 'Fir').cells[1];
    return (ced.text === 'W' && ced.tip === 'Cedar wins by forfeit' && fir.text === 'FF' && fir.tip === 'Fir forfeits to Cedar') || { ced, fir };
  });
  await tab.reload();
  await tabTo(tab, 'stats');
  await check('st-12 grid: still the grid after a reload', async () => !!(await tab.wait(`!!document.querySelector('table.pgrid')`, 'the grid after a reload')));
  await tab.click('[data-standview="table"]');
  await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'the table');

  // st-13: links and Back in New
  await tab.js('window.scrollTo(0, 0), true');
  await tab.click('#newstats a[data-go^="teams|"]:not(.x)');
  const newMark = () => tab.js(`(() => { const m = document.querySelector('.nsec.nmark'); return m && { sec: (document.querySelector('[data-statssec].on') || {}).textContent,
    head: m.querySelector('.nhead span').textContent, back: (m.querySelector('a.nback') || {}).textContent || null, top: Math.round(m.getBoundingClientRect().top),
    marks: document.querySelectorAll('.nmark').length }; })()`);
  await check('st-13 new links: a team link opens Teams at the team, marked, scrolled to, with "← Back to Standings"', async () => {
    const x = await newMark();
    return (x && x.sec === 'Teams' && x.head === 'Alder' && x.back === '← Back to Standings' && x.top >= -2 && x.top < 120 && x.marks === 1) || x;
  });
  const npLink = await tab.text('.nsec.nmark a[data-go^="players|"]');
  await tab.click('.nsec.nmark a[data-go^="players|"]');
  await check('st-13 new links: a player link from there opens Players, marked, "← Back to Teams"', async () => {
    const x = await newMark();
    return (x && x.sec === 'Players' && ROSTER.Alder.includes(npLink) && x.head === npLink && x.back === '← Back to Teams' && x.marks === 1) || { x, npLink };
  });
  await tab.click('a.nback');
  await check('st-13 new links: Back returns to Teams with its own mark and Back link', async () => {
    const x = await newMark();
    return (x && x.sec === 'Teams' && x.head === 'Alder' && x.back === '← Back to Standings') || x;
  });
  await tab.click('a.nback');
  await check('st-13 new links: and again to Standings, unmarked', async () => {
    const x = await tab.js(`[(document.querySelector('[data-statssec].on') || {}).textContent, document.querySelectorAll('.nmark, .nback').length]`);
    return (x[0] === 'Standings' && x[1] === 0) || x;
  });
  await tab.click('[data-statssec="games"]');
  await check('st-13 new links: Scoreboard has Round jump chips', async () => q(await tab.texts('.njump a.chip')) === q(['Round 1', 'Round 2', 'Round 3']) || tab.texts('.njump a.chip'));
  await tab.S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 500, deviceScaleFactor: 1, mobile: false });
  await tab.click('.njump a.chip:nth-child(2)');
  await check('st-13 new links: a Round chip scrolls to the round', async () => {
    const top = await tab.js(`Math.round(document.getElementById('nr-2').getBoundingClientRect().top)`);
    return (top >= -2 && top < 60) || top;
  });
  await tab.view('desktop');
  await tab.js('window.scrollTo(0, 0), true');
  await tab.click('#newstats a[data-go^="teams|"]');
  await tab.wait(`!!document.querySelector('.nmark')`, 'a mark');
  await tab.click('[data-statssec="rounds"]');
  await check('st-13 new links: picking a section from the bar clears the marks and the back trail', async () => {
    await tab.click('[data-statssec="teams"]');
    const x = await tab.js(`document.querySelectorAll('.nmark, .nback').length`);
    return x === 0 || x;
  });

  // st-15: forfeits and overtime
  await tab.click('[data-statssec="games"]');
  const secs = () => tab.js(`[...document.querySelectorAll('#newstats .nsec')].map((s) => ({ head: s.querySelector('.nhead span').textContent,
    meta: (s.querySelector('.nhead .meta') || {}).textContent || '', tables: s.querySelectorAll('table').length }))`);
  await check('st-15 forfeits: listed as "<winner> defeats <loser> by forfeit", with no box score', async () => {
    const x = (await secs()).find((s) => s.head.includes('forfeit'));
    return (x && x.head === 'Cedar defeats Fir by forfeit' && x.meta === 'Round 1' && x.tables === 0) || await secs();
  });
  await check('st-15 overtime: the title ends "(OT)", its head reads "Tossups read: 21 (1 in OT)"', async () => {
    const x = (await secs()).find((s) => s.head.startsWith('Alder') && s.meta.startsWith('Round 3'));
    return (x && x.head === `Alder ${g31.exp[0].points}, Dogwood ${g31.exp[1].points} (OT)` && x.meta === 'Round 3 · Tossups read: 21 (1 in OT)') || await secs();
  });

  /* --- categories (rounds 1-3) --- */
  await tabTo(tab, 'cats');
  await tab.wait(`!!document.querySelector('#out [data-catview]')`, 'categories');
  const chips = (attr) => tab.js(`[...document.querySelectorAll('#out [data-${attr}]')].map((c) => [c.firstChild.textContent, (c.querySelector('.n') || {}).textContent || '', c.classList.contains('on'), c.className.includes('unc')])`);
  await check('cat-01 views: Players (the default), Teams, By Player, Questions', async () => {
    const x = await tab.js(`[...document.querySelectorAll('[data-catview]')].map((v) => [v.textContent, v.classList.contains('on')])`);
    return q(x) === q([['Players', true], ['Teams', false], ['By Player', false], ['Questions', false]]) || x;
  });
  await check('cat-02 filters: All, then each category with its count of distinct tossups, Unknown styled apart', async () => {
    const x = await chips('cat');
    const want = [['All', '', true, false], ['Literature', '9', false, false], ['History', '6', false, false], ['Science', '12', false, false],
      ['Fine Arts', '12', false, false], ['RMPSS', '15', false, false], ['Unknown', '6', false, true]];
    return q(x) === q(want) || { x, want };
  });
  await tab.click('[data-cat="RMPSS"]');
  await check('cat-02 filters: a category adds its subcategory row (All, then its subs)', async () => {
    const x = await chips('catsub');
    return q(x) === q([['All', '', true, false], ['Religion', '6', false, false], ['Social Science', '9', false, false]]) || x;
  });
  await tab.click('[data-catsub="Social Science"]');
  await check('cat-02 filters: an RMPSS split adds a third row', async () => {
    const x = await chips('catsub2');
    return q(x) === q([['All', '', true, false], ['Economics', '6', false, false], ['Psychology', '3', false, false]]) || x;
  });
  await tab.click('[data-catsub2="Economics"]');
  // Economics: tossups 4 and 19 of each packet, where the loser's first player negs and the winner's third gets it
  const econ = {};
  for (const g of played.filter((x) => !x.forfeit)) {
    const w = ROSTER[g.win][2];
    const l = ROSTER[g.lose][0];
    econ[w] = econ[w] || { team: g.win, p: 0, g: 0, n: 0, bb: 0 };
    econ[l] = econ[l] || { team: g.lose, p: 0, g: 0, n: 0, bb: 0 };
    econ[w].g += 2; econ[w].bb += 2; econ[w].p += 20;
    econ[l].n += 2; econ[l].p -= 10;
  }
  await bug('cat-03 players: on the default format (mACF with powers, none picked), the 15 column stays when the filtered rows have no power', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#catbody table.cattable th')].map((c) => c.textContent)`);
    return x.includes('15') || x;
  }, 'a tournament whose TD never picked a format plays mACF with powers, but its public state carries format {} and the page then shows the 15 column only when someone in the filtered rows powered (pubview.js showPowers), so the column comes and goes with the filter');
  // the format as a TD who picked it has it stored (a new load: a Refresh that moves no stamp draws nothing again)
  await saveSettings(T, (s) => { s.gameFormat = 'macf-powers'; });
  await settle(T);
  await openPub(tab, T.slug, { hash: '#cats' });
  for (const sel of ['[data-cat="RMPSS"]', '[data-catsub="Social Science"]', '[data-catsub2="Economics"]']) await tab.click(sel);
  await check('cat-03 players: filtered to Economics, a row a player: Player, Team, 15, 10, -5, BB, Pts', async () => {
    const x = await tab.js(`[[...document.querySelectorAll('#catbody table.cattable th')].map((c) => c.textContent),
      [...document.querySelectorAll('#catbody table.cattable tr')].slice(1).map((tr) => [...tr.querySelectorAll('td')].map((c, i) => i === 0 ? c.firstChild.textContent : c.textContent))]`);
    const want = Object.entries(econ).map(([p, v]) => [p, v.team, '0', String(v.g), String(v.n), String(v.bb), String(v.p)]);
    const sort = (a) => q([...a].sort((m, n) => m[0].localeCompare(n[0])));
    return (q(x[0]) === q(['Player', 'Team', '15', '10', '-5', 'BB', 'Pts']) && sort(x[1]) === sort(want)) || { x, want };
  });
  await tab.click('[data-catview="team"]');
  await check('cat-04 teams: filtered, a team with no bonus heard reads "–" for PPB', async () => {
    const x = await tab.js(`[[...document.querySelectorAll('#catbody table th')].map((c) => c.textContent),
      [...document.querySelectorAll('#catbody table tr')].slice(1).map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent))]`);
    return (q(x[0]) === q(['Team', '15', '10', '-5', 'BB', 'Pts', 'Bonuses', 'Bpts', 'PPB']) && x[1].length === 6
      && x[1].filter((rr) => rr[6] === '0').every((rr) => rr[8] === '–') && x[1].some((rr) => rr[8] === '–')) || x;
  });
  await tab.click('[data-cat=""]');
  await check('cat-04 teams: unfiltered, each team\'s bonuses heard, bonus points and PPB', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#catbody table tr')].slice(1).map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent))`);
    const bad = MT.map((t) => t.name).filter((n) => {
      const rr = x.find((y) => y[0] === n);
      const want = prelims[n];
      return !rr || rr[6] !== String(want.bonusesHeard) || rr[7] !== String(want.bonusPts) || rr[8] !== (want.bonusesHeard ? (want.bonusPts / want.bonusesHeard).toFixed(2) : '–');
    });
    return bad.length === 0 || { bad, x };
  });
  await tab.click('[data-cat="Fine Arts"]');
  await tab.click('[data-catview="cat"]');
  await check('cat-07 empty: a category nobody buzzed on says "No buzzes in this category"', async () => (await tab.js(`document.querySelector('#catbody').innerText.trim().split('\\n').pop()`)) === 'No buzzes in this category' || tab.js(`document.querySelector('#catbody').innerText`));
  await tab.click('[data-catview="questions"]');
  await check('cat-07 empty: and its Questions has no bonuses: "None"', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#catbody .rhead')].map((h) => [h.textContent, (h.nextElementSibling || {}).textContent])`);
    return (x[1] && x[1][0] === 'Bonuses' && x[1][1].trim() === 'None') || x;
  });
  await tab.click('[data-cat=""]');
  await check('cat-06 questions: a Tossups table with category, subcategory and split rows', async () => {
    const x = await tab.js(`(() => { const t = document.querySelectorAll('#catbody table')[0]; return { heads: [...t.querySelectorAll('th')].map((c) => c.textContent),
      rows: [...t.querySelectorAll('tr')].slice(1).map((tr) => [tr.className, ...[...tr.children].map((c) => c.textContent)]) }; })()`);
    const fa = x.rows.find((rr) => rr[1] === 'Fine Arts');
    const econRow = x.rows.find((rr) => rr[1] === 'Economics');
    return (q(x.heads) === q(['Category', 'Tossups', 'Heard', 'Conv %', 'Power %', 'Neg %', 'Avg Buzz']) && fa && fa[0].includes('cattop') && fa[2] === '12' && fa[3] === '20'
      && fa[4] === '0%' && fa[7] === '–' && econRow && econRow[0].includes('catsub2') && x.rows.some((rr) => rr[0].includes('catsub') && rr[1] === 'Social Science')) || x;
  });
  await check('cat-06 questions: an Unknown row quotes the packet\'s own tag', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#catbody tr.uncat')].map((tr) => tr.children[0].textContent)`);
    return (x.includes('Unknown') && x.includes('“Underwater Basket Weaving”')) || x;
  });
  await check('cat-06 questions: a Bonuses table, with the note for bonuses whose packet gives no difficulty', async () => {
    const x = await tab.js(`[[...document.querySelectorAll('#catbody table')[1].querySelectorAll('th')].map((c) => c.textContent), (document.querySelector('#catbody .ranknote') || {}).textContent]`);
    return (q(x[0]) === q(['Category', 'Bonuses', 'Heard', 'PPB', 'Easy', 'Medium', 'Hard'])
      && /^iBonus difficulty not available for 24 of 48 bonuses, ranked by conversion rate\.$/.test(x[1] || '')) || x;
  });
  await tab.click('[data-catview="player"]');
  await check('cat-05 by player: the dropdown lists each "Player (Team)", by team', async () => {
    const x = await tab.texts('#catplayersel option');
    return (x[0] === `${ROSTER.Alder[0]} (Alder)` && x.every((o) => /\(.+\)$/.test(o)) && x.some((o) => o === `${ROSTER.Dogwood[2]} (Dogwood)`)) || x;
  });
  {
    const opt = await tab.js(`[...document.querySelectorAll('#catplayersel option')].findIndex((o) => o.textContent === ${q(ROSTER.Alder[2] + ' (Alder)')})`);
    await tab.select('#catplayersel', String(opt));
  }
  await check('cat-05 by player: one player\'s lines per category, its subcategories and splits indented', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#catbody table tr')].slice(1).map((tr) => [tr.children[0].textContent, tr.children[0].style.paddingLeft || '', tr.children[tr.children.length - 1].textContent])`);
    // Cy Alder gets tossups 4, 9, 14 and 19 of rounds 2 and 3: Economics, Psychology, Religion, Economics
    const has = (row) => x.some((y) => q(y) === q(row));
    return (has(['RMPSS', '', '80']) && has(['Social Science', '28px', '60']) && has(['Economics', '48px', '40']) && has(['Psychology', '48px', '20']) && has(['Religion', '28px', '20'])) || x;
  });

  /* --- phone --- */
  await tab.view('phone');
  await tabTo(tab, 'schedule');
  await tab.click('[data-schedview="now"]');
  await check('sch-12 phone: Now\'s blocks stack, with no sideways page scroll', async () => {
    const x = await tab.js(`(() => { const b = [...document.querySelectorAll('.nowblock')].map((e) => e.getBoundingClientRect()); return { b: b.map((r) => [Math.round(r.top), Math.round(r.bottom)]), sw: document.documentElement.scrollWidth, w: innerWidth }; })()`);
    return (x.b.length === 2 && x.b[1][0] >= x.b[0][1] && x.sw <= x.w + 1) || x;
  });
  await tab.click('[data-schedview="all"]');
  await check('sch-12 phone: All rounds scrolls inside its own boxes, not the page', async () => {
    const x = await tab.js(`({ sw: document.documentElement.scrollWidth, w: innerWidth, boxes: [...document.querySelectorAll('#schedout .tablewrap')].map((b) => [b.scrollWidth > b.clientWidth, getComputedStyle(b).overflowX]) })`);
    return (x.sw <= x.w + 1 && x.boxes.some((b) => b[0]) && x.boxes.every((b) => ['auto', 'scroll'].includes(b[1]))) || x;
  });
  await tab.select('#teamsel', 'Alder');
  await check('sch-12 phone: the team view has no sideways page scroll', async () => (await tab.js(`document.documentElement.scrollWidth <= innerWidth + 1`)) || tab.js('document.documentElement.scrollWidth'));
  await tab.select('#teamsel', '');
  await tabTo(tab, 'stats');
  await tab.click('[data-statssec="individuals"]');
  await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'Individuals');
  const narrow = () => tab.js(`(() => { const t = document.querySelector('#newstats table.nstats'); const w = t.parentElement; const f = w.parentElement;
    const nameCell = t.querySelector('tbody td.nstick');
    return { wrap: w.className, fade: f.className, head: getComputedStyle(t.querySelector('thead')).position, stick: getComputedStyle(nameCell).position,
      rank: getComputedStyle(nameCell.querySelector('.nrk')).display, rankCol: getComputedStyle(t.querySelector('tbody td.nrkcol')).display,
      sub: getComputedStyle(nameCell.querySelector('.subteam')).display, teamCol: getComputedStyle(t.querySelector('tbody td.teamcol')).display,
      page: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
  await check('st-14 narrow: a table too wide scrolls in its own box, header and first column sticky, an edge fade while more is to the right', async () => {
    const x = await narrow();
    return (x.wrap.includes('nscroll') && x.fade.includes('more') && x.head === 'sticky' && x.stick === 'sticky' && x.page) || x;
  });
  await check('st-14 narrow: on a phone the rank rides in the name cell and the team under the player\'s name', async () => {
    const x = await narrow();
    return (x.rank !== 'none' && x.rankCol === 'none' && x.sub === 'block' && x.teamCol === 'none') || x;
  });
  await tab.js(`(() => { const w = document.querySelector('#newstats table.nstats').parentElement; w.scrollLeft = w.scrollWidth; w.dispatchEvent(new Event('scroll')); return true; })()`);
  await check('st-14 narrow: the fade goes once the end is reached', async () => !(await tab.js(`document.querySelector('#newstats table.nstats').parentElement.parentElement.classList.contains('more')`)) || 'still fading');
  await tab.view('desktop');
  await check('st-14 narrow: back on a wide screen the table refits (no scroll box)', async () => !!(await tab.wait(`document.querySelector('#newstats table.nstats').parentElement.classList.contains('nfit')`, 'the refit')));

  /* --- round 4 under way; the stats password --- */
  await setRound(4);
  const g41 = await playStd(4, 'Alder', UIUC, { k: 2 });
  const g42 = await playStd(4, 'Cedar', 'Dogwood', { k: 1 });
  await setPassword(T, 'acorn', { buzz: true, scoresheets: true });
  await settle(T);
  await refresh(tab);
  await check('pub-02 tabs: with buzzpoints on, Buzzpoints shows', async () => (await tab.js(`!document.querySelector('#tab-buzz').hidden`)) || 'hidden');
  await check('pub-01 header: the label follows the round on the floor ("Round 4")', async () => (await tab.text('#round')) === 'Round 4' || tab.text('#round'));

  // st-11: stages
  await tab.js(`localStorage.setItem('qbtdStatsLayout', 'new'); true`);
  await openPub(tab, T.slug, { hash: '#stats' });
  await tab.wait(`!!document.querySelector('#newstats [data-statstage]')`, 'the stage chips');
  const stages = () => tab.js(`[...document.querySelectorAll('#newstats [data-statstage], #newstats .chip.off')].map((c) => [c.textContent, c.classList.contains('on'), c.classList.contains('off')])`);
  await check('st-11 stages: chips name each stage in play order, then Combined; the live round\'s stage is picked', async () => {
    const x = await stages();
    return q(x) === q([['Prelims', false, false], ['Playoffs', true, false], ['Combined', false, false]]) || x;
  });
  await check('st-10 new standings: the playoff stage\'s brackets each get a table with its heading', async () => {
    const x = await tab.texts('#newstats .poolhead');
    return (x.includes('Championship') && x.includes('Consolation')) || x;
  });
  await tab.click('[data-statssec="games"]');
  await check('st-11 stages: each section counts only the picked stage\'s games (Playoffs: round 4)', async () => q(await tab.texts('.njump a.chip')) === q(['Round 4']) || tab.texts('.njump a.chip'));
  await tab.click('[data-statstage="Prelims"]');
  await check('st-11 stages: Prelims counts rounds 1 to 3', async () => q(await tab.texts('.njump a.chip')) === q(['Round 1', 'Round 2', 'Round 3']) || tab.texts('.njump a.chip'));
  await tab.click('[data-statstage="combined"]');
  await tab.click('[data-statssec="standings"]');
  await check('st-11 stages: Combined lists every team in its final place, in one table', async () => {
    const x = (await tab.js(NEW_TABLES)).map((t) => t.rows.map((rr) => rr.name));
    return (x.length === 1 && x[0].length === 6) || x;
  });
  await tab.click('[data-standview="grid"]');
  await check('st-11 stages: in Grid view Combined is greyed out', async () => {
    const x = await stages();
    return (x.some((c) => c[0] === 'Combined' && c[2]) && !x.some((c) => c[0] === 'Combined' && c[1])) || x;
  });
  await tab.click('[data-standview="table"]');
  await tab.click('[data-statstage="Playoffs"]');
  await tabTo(tab, 'schedule');
  await tab.click('[data-schedview="all"]');
  await tab.click(scoreSel(sgOf(2, 'Alder', 'Elm')));
  await check('st-11 stages: a game opened from the schedule switches to the stage that owns its round', async () => {
    const x = await tab.wait(`(() => { const m = document.querySelector('.nsec.nmark'); return m && [m.querySelector('.nhead span').textContent,
      (document.querySelector('#newstats [data-statstage].on') || {}).textContent]; })()`, 'the round-2 game');
    return (x[0].startsWith('Alder') && x[1] === 'Prelims') || x;
  });

  // sch-06 in New, now that the stages read: lands on the game, marked, and Back returns to the schedule as it was
  await tab.js(`localStorage.setItem('qbtdStatsLayout', 'new'); true`);
  await openPub(tab, T.slug, { hash: '#schedule' });
  await tab.click('[data-schedview="all"]');
  await tab.click(scoreSel(sgOf(4, 'Cedar', 'Dogwood')));
  await check('sch-06 score link: in New it lands on the game in Scoreboard, marked, with "← Back to Schedule"', async () => {
    const x = await tab.wait(`(() => { const m = document.querySelector('.nsec.nmark'); return m && { sec: (document.querySelector('[data-statssec].on') || {}).textContent,
      head: m.querySelector('.nhead span').textContent, back: (m.querySelector('a.nback') || {}).textContent, top: m.getBoundingClientRect().top }; })()`, 'the marked game');
    const bottom = await tab.js(`window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2 && window.scrollY > 0`);
    return (x.sec === 'Scoreboard' && x.head === `Cedar ${g42.exp[0].points}, Dogwood ${g42.exp[1].points}` && x.back === '← Back to Schedule'
      && x.top >= -2 && (x.top < 120 || bottom)) || { x, bottom };
  });
  await tab.click('a.nback');
  await check('sch-06 score link: and its Back returns to the Schedule', async () => (await tab.js(`document.querySelector('.tab.active').id`)) === 'tab-schedule' || tab.js(`document.querySelector('.tab.active').id`));
  // on a phone: Back restores the page's scroll and each table's sideways scroll
  await tab.S('Emulation.setDeviceMetricsOverride', { width: 390, height: 480, deviceScaleFactor: 2, mobile: true });
  await tab.wait(`!!document.querySelector('table.sched')`, 'All rounds on a phone');
  await tab.js(`(() => { for (const w of document.querySelectorAll('#schedout .tablewrap')) w.scrollLeft = Math.floor((w.scrollWidth - w.clientWidth) / 2); window.scrollTo(0, 140); return true; })()`);
  const before = await tab.js(`[window.scrollY, ...[...document.querySelectorAll('#schedout .tablewrap')].map((w) => w.scrollLeft)]`);
  await tab.click(scoreSel(sgOf(4, 'Alder', UIUC)));
  await tab.wait(`!!document.querySelector('.nsec.nmark a.nback')`, 'the game in New');
  await tab.click('a.nback');
  await check('sch-06 back: the schedule comes back at the same page scroll and the same sideways scroll of each table', async () => {
    const x = await tab.js(`[window.scrollY, ...[...document.querySelectorAll('#schedout .tablewrap')].map((w) => w.scrollLeft)]`);
    return (before[0] > 0 && before.slice(1).some((v) => v > 0) && q(x) === q(before)) || { before, after: x };
  });
  await tab.view('desktop');

  // bz-01: the Buzzpoints password
  await tab.js('sessionStorage.clear(); true');
  await openPub(tab, T.slug, { hash: '#buzz' });
  await check('bz-01 password: locked, Buzzpoints shows a password field and View', async () => (await tab.exists('#buzzpw')) && (await tab.text('#buzzgo')) === 'View' || tab.js(`document.querySelector('#out').innerHTML.slice(0, 200)`));
  let m0 = await tab.js('window.__qt.msgs.length');
  await tab.fill('#buzzpw', 'wrong-one');
  await tab.key('#buzzpw', 'Enter');
  await tab.wait(`document.querySelector('#msg').textContent === 'Bad password'`, 'Bad password');
  await check('bz-01 password: a wrong one (Enter) says "Checking password", then a red "Bad password", asks again and stores nothing', async () => {
    const msgs = (await tab.js(`window.__qt.msgs.slice(${m0}).map((m) => m.t)`));
    const x = [await msgIs(tab, 'Bad password'), await tab.exists('#buzzpw'), await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`)];
    return (msgs.includes('Checking password') && x[0] === true && x[1] && x[2] === null) || { msgs, x };
  });
  m0 = await tab.js('window.__qt.msgs.length');
  await tab.fill('#buzzpw', 'acorn');
  await tab.click('#buzzgo');
  await tab.wait(`!!document.querySelector('[data-buzzmode]')`, 'the buzzpoints');
  await check('bz-01 password: the right one shows the views and keeps the derived key for the tab, never the password', async () => {
    const msgs = (await tab.js(`window.__qt.msgs.slice(${m0}).map((m) => m.t)`));
    const stored = await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`);
    const j = JSON.parse(stored || '{}');
    return (msgs.includes('Checking password') && /^[0-9a-f]{64}$/.test(j.tok) && !stored.includes('acorn') && typeof j.v === 'string'
      && !(await tab.js(`localStorage.getItem('qbtdBuzzKey:${T.slug}')`))) || { msgs, stored };
  });
  await check('bz-04 by round: chips for the finished rounds, the round in progress greyed', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#out .chipstack .chip')].map((c) => [c.textContent, c.classList.contains('on'), c.classList.contains('off')])`);
    return q(x) === q([['Round 1', false, false], ['Round 2', false, false], ['Round 3', true, false], ['Round 4 in progress', false, true]]) || x;
  });
  await tab.click('[data-buzzround="1"]');
  await tab.wait(`document.querySelectorAll('#buzzout details.qd').length > 0 && !document.querySelector('#buzzout').textContent.includes('Loading')`, 'round 1');
  const word = (n) => tab.js(`(() => { const d = [...document.querySelectorAll('#buzzout details.qd')].find((x) => x.querySelector('.roundcell').textContent.trim() === 'T${n}');
    d.open = true; return [...d.querySelectorAll('.qdbody .q span.bw')].map((s) => s.firstChild.textContent); })()`);
  await check('bz-04 by round: a buzz is marked on its word (round 1, tossup 2, word 51)', async () => {
    const x = await word(2);
    return q(x) === q(['r1t2w50']) || x;
  });
  await check('bz-04 by round: a buzz after an encoded space lands on MODAQ\'s word [changed: Buzz marks land on the right word when a question uses an encoded space (&nbsp;) or other HTML entities, as in MODAQ.]', async () => {
    const x = await word(1);
    return q(x) === q(['r1t1w30']) || x;
  });
  await check('bz-04 by round: a track a tossup, one dot a get and a ring a neg', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#buzzout details.qd:not(.bonus)')].map((d) => [d.querySelector('.roundcell').textContent.trim(),
      d.querySelectorAll('.bdot.get, .bdot.pow').length, d.querySelectorAll('.bdot.neg').length])`);
    return (x.length === 20 && q(x[3]) === q(['T4', 1, 1]) && q(x[4]) === q(['T5', 0, 0]) && q(x[2]) === q(['T3', 1, 0])) || x;
  });
  await tab.click('[data-buzzmode="summary"]');
  await check('bz-04 summary: a row a player who buzzed, with powers, tens, negs', async () => {
    const x = await rowsOf(tab, '#buzzout table tr');
    const cy = x.find((rr) => rr[0] === ROSTER.Alder[2]);
    return (q(x[0]) === q(['player', 'team', '15', '10', 'neg', 'avg buzz', 'best']) && cy && cy[1] === 'Alder' && cy[3] === '8') || x.slice(0, 4);
  });

  // By Category: no All chip, the first category picked, its questions from every finished round
  await tab.click('[data-buzzmode="category"]');
  const catOut = () => tab.wait(`(() => { const o = document.querySelector('#buzzcatout'); return o && !o.textContent.includes('Loading')
    && { heads: [...o.querySelectorAll('.rhead')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim()),
      labels: [...o.querySelectorAll('details.qd .roundcell')].map((c) => c.textContent.trim()) }; })()`, 'By Category');
  const litT = [1, 2, 3].flatMap((r) => MAIN_TU_CATS.map((c, i) => (c.category === 'Literature' ? `R${r} T${i + 1}` : null)).filter(Boolean));
  // a game hears 16 bonuses (four of every five tossups are got), numbered in order
  const litB = [1, 2, 3].flatMap((r) => Array.from({ length: 16 }, (_, i) => (MAIN_BONUS_CATS[i % 4].category === 'Literature' ? `R${r} B${i + 1}` : null)).filter(Boolean));
  await check('bz-04 by category: a chip a category (no All), the first picked; its tossups and bonuses from every finished round', async () => {
    const chipsSeen = await tab.js(`[...document.querySelectorAll('#out [data-buzzcat]')].map((c) => [c.firstChild.textContent, c.classList.contains('on')])`);
    const x = await catOut();
    const sorted = (a) => q([...a].sort());
    return (q(chipsSeen.map((c) => c[0])) === q(['Literature', 'History', 'Science', 'Fine Arts', 'RMPSS', 'Unknown']) && chipsSeen[0][1]
      && q(x.heads) === q([`Tossups ${litT.length}`, `Bonuses ${litB.length}`]) && sorted(x.labels) === sorted([...litT, ...litB])) || { chipsSeen, x, want: [...litT, ...litB] };
  });
  await check('bz-04 by category: a row opens to its question, the buzzes of both rooms marked on their word (R2 T1)', async () => {
    const x = await tab.js(`(() => { const d = [...document.querySelectorAll('#buzzcatout details.qd')].find((e) => e.querySelector('.roundcell').textContent.trim() === 'R2 T1');
      d.open = true; return [...d.querySelectorAll('.qdbody .q span.bw')].map((s) => [s.firstChild.textContent, s.querySelector('sup').textContent]); })()`);
    return q(x) === q([['r2t1w30', '1,2']]) || x;
  });
  await tab.click('[data-buzzcat="Science"]');
  await check('bz-04 by category: another chip lists that category\'s questions instead', async () => {
    const x = await tab.wait(`(() => { const o = document.querySelector('#buzzcatout'); return o && !o.textContent.includes('Loading')
      && [...o.querySelectorAll('details.qd .roundcell')].map((c) => c.textContent.trim()); })()`, 'Science');
    const sciT = [1, 2, 3].flatMap((r) => MAIN_TU_CATS.map((c, i) => (c.category === 'Science' ? `R${r} T${i + 1}` : null)).filter(Boolean));
    const sciB = [1, 2, 3].flatMap((r) => Array.from({ length: 16 }, (_, i) => (MAIN_BONUS_CATS[i % 4].category === 'Science' ? `R${r} B${i + 1}` : null)).filter(Boolean));
    return q([...x].sort()) === q([...sciT, ...sciB].sort()) || { x, want: [...sciT, ...sciB] };
  });

  // By Player and By Team: one side's rows, round by round, worked out from the game files sent
  const sideWant = (g, teamName, player = null) => {
    const tus = [];
    const bos = [];
    for (const mq of g.qbj.match_questions) {
      if (mq.buzzes.some((b) => b.team.name === teamName && (!player || b.player.name === player))) tus.push(mq.question_number);
      const got = mq.buzzes.find((b) => b.result.value > 0);
      if (!player && mq.bonus && got && got.team.name === teamName) bos.push(mq.bonus.question.question_number);
    }
    // a round's rows go number by number: the tossup, then the bonus of that number
    return [...new Set([...tus, ...bos])].sort((a, b) => a - b)
      .flatMap((n) => [...(tus.includes(n) ? ['T' + n] : []), ...(bos.includes(n) ? ['B' + n] : [])]);
  };
  const sideOut = () => tab.wait(`(() => { const o = document.querySelector('#buzzsideout'); return o && !o.textContent.includes('Loading')
    && [...o.querySelectorAll('.rhead')].map((h) => { const labels = []; let n = h.nextElementSibling;
      while (n && !n.classList.contains('rhead')) { if (n.matches('details.qd')) labels.push(n.querySelector('.roundcell').textContent.trim()); n = n.nextElementSibling; }
      return { round: h.textContent.trim(), labels }; }); })()`, 'the side view');
  await tab.click('[data-buzzmode="player"]');
  await check('bz-04 by player: a team list, the team\'s players who buzzed, and the first one\'s own buzzes round by round', async () => {
    const teams = await tab.texts('#buzzteamsel option');
    const players = await tab.js(`[...document.querySelectorAll('#out [data-buzzplayer]')].map((c) => [c.textContent, c.classList.contains('on')])`);
    const x = await sideOut();
    const lines = await tab.js(`[...document.querySelectorAll('#buzzsideout details.qd:not(.bonus) .buzzlist > div')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
    const want = [{ round: 'Round 2', labels: sideWant(g21, 'Alder', ROSTER.Alder[0]) }, { round: 'Round 3', labels: sideWant(g31, 'Alder', ROSTER.Alder[0]) }];
    return (q(teams) === q(['Alder', 'Cedar', 'Dogwood', 'Elm', 'Fir', UIUC]) && q(players) === q(ROSTER.Alder.slice(0, 4).map((p, i) => [p, i === 0]))
      && q(x) === q(want) && lines.length === want.flatMap((w) => w.labels).length && lines.every((l) => l.includes(`${ROSTER.Alder[0]} (Alder)`))) || { teams, players, x, want, lines };
  });
  await tab.click(`[data-buzzplayer="${ROSTER.Alder[2]}"]`);
  await check('bz-04 by player: another player\'s chip shows that player\'s buzzes instead', async () => {
    const x = await sideOut();
    const want = [{ round: 'Round 2', labels: sideWant(g21, 'Alder', ROSTER.Alder[2]) }, { round: 'Round 3', labels: sideWant(g31, 'Alder', ROSTER.Alder[2]) }];
    return q(x) === q(want) || { x, want };
  });
  await tab.click('[data-buzzmode="team"]');
  await check('bz-04 by team: the team\'s tossups and the bonuses it heard, round by round, every line its own', async () => {
    const x = await sideOut();
    const lines = await tab.js(`[[...document.querySelectorAll('#buzzsideout details.qd:not(.bonus) .buzzlist > div')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
      [...document.querySelectorAll('#buzzsideout details.qd.bonus .buzzlist > div')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())]`);
    const want = [{ round: 'Round 2', labels: sideWant(g21, 'Alder') }, { round: 'Round 3', labels: sideWant(g31, 'Alder') }];
    return (q(x) === q(want) && lines[0].length && lines[0].every((l) => l.includes('(Alder)')) && lines[1].length && lines[1].every((l) => / Alder · /.test(l))) || { x, want, lines };
  });
  await tab.select('#buzzteamsel', '4');
  await check('bz-04 by team: picking another team in the list shows its rounds (Fir: round 2 only, its round-1 forfeit has no questions)', async () => {
    const x = await sideOut();
    return q(x.map((r) => r.round)) === q(['Round 2']) || x;
  });

  // the password is proved by fetching a finished round's packet: one the browser
  // fetched with the right key a moment ago must not prove a wrong one
  await tab.js('sessionStorage.clear(); true');
  await openPub(tab, T.slug, { hash: '#buzz' });
  {
    const seen = proxyLog.length;
    await tab.fill('#buzzpw', 'wrong-again');
    await tab.click('#buzzgo');
    await tab.wait(`window.__qt.msgs.some((m) => m.t !== 'Checking password' && m.t !== 'Loading' && m.at > ${Date.now() - 50})`, 'the answer').catch(() => {});
    await tab.wait(`!!document.querySelector('[data-buzzmode]') || document.querySelector('#msg').textContent === 'Bad password'`, 'locked or not');
    await bug('bz-01 password: a wrong password is refused even right after a right one in the same browser', async () => {
      const x = [await tab.text('#msg'), await tab.exists('[data-buzzmode]'), await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`)];
      const probes = proxyLog.slice(seen).filter((y) => y.path.endsWith('/qpacket')).length;
      return (x[0] === 'Bad password' && !x[1] && x[2] === null) || { msg: x[0], unlocked: x[1], stored: !!x[2], qpacketRequestsSeenByTheServer: probes };
    }, 'the page proves a password by fetching a finished round\'s packet, which the Worker serves "Cache-Control: private, max-age=60" with no "Vary: Authorization"; for a minute after a right password the browser answers a wrong one\'s probe from its cache, so the wrong key is stored and the page reads unlocked (Scoresheets On, Buzzpoints views), until a packet it has not cached is refused');
  }

  // st-17 / st-18 / st-19: the Scoresheets switch, behind the same password
  // (a cold cache: no packet fetched with the right key can answer for a wrong one)
  await tab.S('Network.clearBrowserCache');
  await tab.js('sessionStorage.clear(); localStorage.removeItem("qbtdSheets"); localStorage.setItem("qbtdStatsLayout", "classic"); true');
  await openPub(tab, T.slug, { hash: '#stats' });
  await tab.wait(`!!document.querySelector('#sheetchip')`, 'the Scoresheets switch');
  const sw = () => tab.js(`(() => { const s = document.querySelector('#sheetchip'); return s && { inBar: !!s.closest('.statsbar'), inJump: !!s.closest('.njump'), lock: !!s.querySelector('svg.swlock'),
    state: s.querySelector('.swstate').textContent, checked: s.getAttribute('aria-checked'), locked: s.classList.contains('locked'), field: !!document.querySelector('#sheetpw') }; })()`);
  await check('st-17 scoresheets: in Classic the switch sits in the stats bar, locked: a padlock and "Locked"', async () => {
    const x = await sw();
    return (x.inBar && x.lock && x.state === 'Locked' && x.locked && x.checked === 'false' && !x.field) || x;
  });
  await tab.click('#sheetchip');
  await check('st-17 scoresheets: pressing it opens a password field and View', async () => {
    const x = await sw();
    return (x.field && (await tab.text('#sheetgo')) === 'View') || x;
  });
  await tab.fill('#sheetpw', 'not-it');
  await tab.key('#sheetpw', 'Enter');
  await tab.wait(`document.querySelector('#msg').textContent === 'Bad password'`, 'Bad password');
  await check('st-19 scoresheet password: a wrong one shows a red "Bad password", stays locked, stores nothing', async () => {
    const x = [await msgIs(tab, 'Bad password'), await sw(), await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`)];
    return (x[0] === true && x[1].locked && x[2] === null) || x;
  });
  await tab.fill('#sheetpw', 'acorn');
  await tab.click('#sheetgo');
  await tab.wait(`(() => { const s = document.querySelector('#sheetchip'); return s && !s.classList.contains('locked'); })()`, 'unlocked');
  await check('st-17 scoresheets: the right password unlocks them: the switch reads On', async () => {
    const x = await sw();
    return (!x.lock && x.state === 'On' && x.checked === 'true' && !x.field) || x;
  });
  await check('st-18 scoresheets: in Classic each finished game\'s scoresheet sits in the report\'s Scoreboard', async () => {
    const n = await tab.fwait(`document.querySelectorAll('#page-games table.sx').length`, 'scoresheets in the report');
    const wait = await tab.fjs(`[...document.querySelectorAll('#page-games .sxwait')].map((e) => e.textContent)`);
    return (n === 5 && wait.length === 2 && wait.every((t) => t === 'The scoresheet will appear when all round 4 games finish.')) || { n, wait };
  });
  await tab.click('#sheetchip');
  await check('st-17 scoresheets: pressed again they go Off, remembered (qbtdSheets)', async () => {
    const x = await sw();
    const n = await tab.fwait(`document.querySelectorAll('section#page-games').length === 1 && document.querySelectorAll('#page-games table.sx').length === 0`, 'no scoresheets');
    return (x.state === 'Off' && x.checked === 'false' && n && (await tab.js(`localStorage.getItem('qbtdSheets')`)) === 'off') || x;
  });
  await tab.click('#sheetchip');
  await tab.click('[data-layout="new"]');
  await tab.click('[data-statssec="games"]');
  await tab.click('[data-statstage="Prelims"]').catch(() => {});
  await tab.wait(`!!document.querySelector('.njump #sheetchip')`, 'the switch in New');
  await check('st-17 scoresheets: in New the switch sits at the end of the Scoreboard\'s round chips', async () => {
    const x = await tab.js(`(() => { const j = document.querySelector('.njump'); return [j.lastElementChild.contains(document.querySelector('#sheetchip')), document.querySelector('#sheetchip .swstate').textContent]; })()`);
    return (x[0] && x[1] === 'On') || x;
  });
  const sheet = (head) => tab.js(`(() => { const s = [...document.querySelectorAll('#newstats .nsec')].find((x) => x.querySelector('.nhead span').textContent.startsWith(${q(head)}));
    const t = s && s.querySelector('table.sx'); if (!t) return s ? { none: true, wait: (s.querySelector('.sxwait') || {}).textContent || null } : null;
    return { teams: [...t.querySelectorAll('thead th.tn')].map((c) => c.textContent), init: [...t.querySelectorAll('thead tr:nth-child(2) th.pl')].map((c) => c.textContent),
      rows: [...t.querySelectorAll('tbody tr')].map((tr) => [tr.querySelector('.qn').textContent, (tr.querySelector('.qc') || {}).textContent || '',
        [...tr.querySelectorAll('td.bon')].map((b) => b.textContent).join('|'), tr.querySelector('.qs').textContent]),
      final: t.querySelector('tfoot .qs').textContent, subs: [...s.querySelectorAll('.sxsubs div')].map((d) => d.textContent), beside: !!s.querySelector('.slay .sleft') }; })()`);
  await check('st-18 scoresheets: a row a tossup, a column a player headed by initials, bonus ✓/✗, the category tag, the running score', async () => {
    const x = await sheet('Dogwood');
    const sc = `${g11.exp[0].points}–${g11.exp[1].points}`;
    return (x && q(x.teams) === q(['Dogwood', 'Elm']) && q(x.init) === q(['AD', 'BD', 'CD', 'DD', 'AE', 'BE', 'CE', 'DE']) && x.rows.length === 20
      && q(x.rows[0]) === q(['1', 'AL', '|✓✗✗', '0–20']) && q(x.rows[2]) === q(['3', 'WH', '✓✓✓|', '45–40']) && x.final === sc && x.beside) || x;
  });
  await check('st-18 scoresheets: a substitution has its note', async () => {
    const x = await sheet(`${UIUC} ${g32.exp[0].points}, Cedar`);
    return (x && q(x.subs) === q([`TU 11: ${UIUC} EI subbed for DI`])) || x;
  });
  await check('st-18 scoresheets: a forfeit has none', async () => {
    const x = await sheet('Cedar defeats Fir');
    return (x && x.none && x.wait === null) || x;
  });
  await tab.click('[data-statstage="Playoffs"]');
  await check('st-18 scoresheets: a game of a round not finished says it will appear when all its games finish', async () => {
    const x = await sheet('Alder');
    return (x && x.none && x.wait === 'The scoresheet will appear when all round 4 games finish.') || x;
  });

  // st-08: Classic keeps its page across a refresh that brings new games
  await tab.click('[data-layout="classic"]');
  await tab.wait(`!!document.querySelector('iframe.report')`, 'Classic');
  await tab.fwait(`!!document.querySelector('#page-standings a[href^="#playerdetail-"]') || !!document.querySelector('a[href^="#playerdetail-"]')`, 'a player link');
  await tab.fclick('a[href="#individuals-top"]');
  await tab.fwait(`${SHOWN_PAGE} === 'individuals'`, 'Individuals');
  await tab.fclick(`#page-individuals a[href^="#playerdetail-"]:not([href$="-top"])`);
  const place = await tab.fwait(`${SHOWN_PAGE} === 'playerdetail' && document.querySelector('.qt-mark') && { id: ${MARK_ID} }`, 'a marked player');
  const g43 = await playStd(4, 'Elm', 'Fir', { k: 3 });
  await settle(T);
  r = await refresh(tab);
  await check('st-08 refresh: new games redraw Classic on the same page, at the same player, still marked', async () => {
    const x = await tab.fwait(`${SHOWN_PAGE} === 'playerdetail' && document.querySelector('.qt-mark') && { id: ${MARK_ID},
      sheets: document.querySelectorAll('#page-games table.sx').length }`, 'the redrawn report');
    return (x.id === place.id && x.sheets === 8 && workerPaths(r.fetches).some((p) => p.includes('/rounds?n=4@'))) || { x, place };
  });
  await tab.click('#sheetchip');
  await check('st-08 redraw: toggling the scoresheets keeps the Classic page and place too', async () => {
    const x = await tab.fwait(`document.querySelectorAll('#page-games table.sx').length === 0 && ${SHOWN_PAGE} === 'playerdetail' && document.querySelector('.qt-mark') && ${MARK_ID}`, 'the report without sheets');
    return x === place.id || x;
  });
  await tab.click('#sheetchip');

  // pub-03 and pub-02: hashes, and the Categories switch
  for (const [hash, id] of [['#cats', 'tab-cats'], ['#buzz', 'tab-buzz'], ['#stats', 'tab-stats'], ['#schedule', 'tab-schedule']]) {
    await openPub(tab, T.slug, { hash });
    await check(`pub-03 opening tab: ${hash} opens its tab`, async () => (await tab.js(`document.querySelector('.tab.active').id`)) === id || tab.js(`document.querySelector('.tab.active').id`));
  }
  await openPub(tab, T.slug, { hash: '#cats' });
  await saveSettings(T, (s) => { s.catStats = false; });
  await settle(T);
  await refresh(tab);
  await check('pub-02 tabs: with the TD\'s Category stats off, Categories hides on the next Refresh and the open tab falls back to Stats', async () => {
    const x = await tab.js(`[document.querySelector('#tab-cats').hidden, document.querySelector('.tab.active').id, !!document.querySelector('.statsbar')]`);
    return (x[0] && x[1] === 'tab-stats' && x[2]) || x;
  });
  await openPub(tab, T.slug, { hash: '#cats' });
  await check('pub-03 opening tab: #cats while Categories is hidden opens the usual first tab', async () => {
    const x = await tab.js(`[document.querySelector('#tab-cats').hidden, document.querySelector('.tab.active').id]`);
    return (x[0] && x[1] === 'tab-schedule') || x;
  });
  await saveSettings(T, (s) => { delete s.catStats; });
  await settle(T);
  // a category map that can't be fetched: the tab is there, and says so
  faults.push({ test: (u) => u.pathname === `/pub/${T.slug}/cats`, status: 503, body: '{"error":"down"}' });
  await tab.S('Network.clearBrowserCache');
  await openPub(tab, T.slug, { hash: '#cats' });
  await check('cat-07 empty: a category map that could not be read says "No categories"', async () => (await tab.js(`document.querySelector('#out').innerText.trim()`)) === 'No categories' || tab.js(`document.querySelector('#out').innerText`));
  faults = [];

  /* --- round 5: the end --- */
  await setRound(5);
  await playStd(5, 'Alder', 'Cedar', { k: 0 });
  await playStd(5, UIUC, 'Dogwood', { k: 2 });
  await settle(T);
  await tab.js(`localStorage.setItem('qbtdSchedView', 'now'); true`);
  await openPub(tab, T.slug);
  await check('sch-10 finished: the header says "Finished"', async () => (await tab.text('#round')) === 'Finished' || tab.text('#round'));
  await check('sch-10 finished: Now is dropped and Schedule opens on All rounds, nothing highlighted or Live now', async () => {
    const x = await tab.js(`[!!document.querySelector('[data-schedview="now"]'), (document.querySelector('[data-schedview].on') || {}).textContent,
      document.querySelectorAll('.now, .nowrow, .nowtag').length]`);
    return (!x[0] && x[1] === 'All rounds' && x[2] === 0) || x;
  });
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await check('sch-10 finished: the New stats open on Combined', async () => {
    const x = await tab.wait(`(document.querySelector('#newstats [data-statstage].on') || {}).textContent`, 'a stage');
    return x === 'Combined' || x;
  });

  // bz-02: a new password locks viewers out; bz-03: no password at all
  await tabTo(tab, 'buzz');
  await tab.wait(`!!document.querySelector('[data-buzzmode]') || !!document.querySelector('#buzzpw')`, 'buzzpoints');
  if (await tab.exists('#buzzpw')) { await tab.fill('#buzzpw', 'acorn'); await tab.click('#buzzgo'); await tab.wait(`!!document.querySelector('[data-buzzmode]')`, 'unlocked'); }
  const oldTok = JSON.parse(await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`)).tok;
  await setPassword(T, 'birch', { buzz: true, scoresheets: true });
  await settle(T);
  const mark = proxyLog.length;
  await refresh(tab);
  await check('bz-02 new password: on the next Refresh Buzzpoints asks again and the stored key is gone', async () => {
    const x = [await tab.exists('#buzzpw'), await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`)];
    return (x[0] && x[1] === null) || x;
  });
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="classic"]');
  await check('bz-02 new password: the Scoresheets switch is locked again', async () => {
    const x = await tab.wait(`(() => { const s = document.querySelector('#sheetchip'); return s && s.querySelector('.swstate').textContent; })()`, 'the switch');
    return x === 'Locked' || x;
  });
  await check('bz-02 new password: the old key is never sent', async () => {
    const sent = proxyLog.slice(mark).filter((x) => x.auth);
    return (sent.length === 0 && !proxyLog.slice(mark).some((x) => x.auth.includes(oldTok))) || sent;
  });
  await saveSettings(T, (s) => { s.statsOpen = true; });
  await settle(T);
  await tab.S('Network.clearBrowserCache'); // no packet the browser holds from the password days
  const mark2 = proxyLog.length;
  await openPub(tab, T.slug, { hash: '#buzz' });
  await tab.wait(`!!document.querySelector('[data-buzzmode]') || !!document.querySelector('#buzzpw')`, 'buzzpoints');
  await check('bz-03 no password: Buzzpoints show with no password field', async () => (!(await tab.exists('#buzzpw')) && await tab.exists('[data-buzzmode]')) || tab.js(`document.querySelector('#out').innerText.slice(0, 200)`));
  await tab.wait(`document.querySelectorAll('#buzzout details.qd').length > 0 && !document.querySelector('#buzzout').textContent.includes('Loading')`, 'a round');
  await check('bz-03 no password: the finished rounds\' question text shows, and no key is sent', async () => {
    const x = await tab.js(`document.querySelector('#buzzout details.qd summary').textContent`);
    const sent = proxyLog.slice(mark2).filter((y) => y.auth);
    return (/Answer 5-1/.test(x) && sent.length === 0 && proxyLog.slice(mark2).some((y) => y.path.endsWith('/qpacket'))) || { x, sent };
  });
  await tabTo(tab, 'stats');
  await tab.wait(`!!document.querySelector('#sheetchip')`, 'the switch');
  await check('bz-03 no password: the Scoresheets switch is unlocked (On, no padlock)', async () => {
    const x = await sw();
    return (x && !x.lock && x.state === 'On') || x;
  });
  await tab.close();
}

/* ---------- a second tournament: what the TD changes after games are in ----------
   Four teams in a round robin, two rooms, ACF (no powers) with 18
   regulation tossups. A tied game, a game filed under another round than
   its file says, a Rebuild, a room move and rename, a roster rename, load
   errors, a tiebreaker, and the password's error messages. */

async function sectionAux(br) {
  const AT = ['Wren', 'Xenia', 'Yarrow', 'Zinnia'].map((n) => team(n));
  const T = await mkTournament('Aux Classic', 'pubfull-aux');
  await addRooms(T, ['Room A', 'Room B', 'Room C']); // Room C: a spare, off the schedule
  await putRoster(T, AT);
  let sched = buildSchedule('rr', AT.map((t) => t.name), T.rooms.slice(0, 2).map((r) => ({ name: r.name, bucket: r.id })));
  await putSchedule(T, sched);
  await saveSettings(T, (s) => { s.gameFormat = 'acf'; s.formatOverrides = { regulationTossupCount: 18 }; });
  const cats = [C('Literature', 'American Literature'), C('Science', 'Biology'), C('History', 'World History'), C('Religion'), C('Fine Arts', 'Painting')];
  const withGeo = [...cats, C('Geography')];
  for (let r = 1; r <= 3; r++) await putPacket(T, r, mkPacket(r, { tuCats: r === 1 ? withGeo : cats, bonusCats: [C('Literature')], n: 18 }));
  await setPassword(T, 'quince', { buzz: true });
  await startT(T);
  await settle(T);
  const games = (round) => schedGames(sched).filter((s) => s.round === round);
  const ids = {};
  async function put(g, roomName, round = g.round) {
    const r = await upload(T, roomName, round, g.filename, g.qbj);
    ids[g.filename] = r.id;
    return r;
  }
  const aux = (o) => mkGame({ reg: 18, ...o });
  const plain = (k = 0) => stdTossups({ k, n: 18, powers: false });
  const tab = await br.newTab();

  /* --- a tied game, all dead --- */
  const [s11, s12] = games(1);
  const tie = aux({ round: 1, win: s11.a, lose: s11.b, tus: deadTossups(18) });
  await put(tie, s11.room);
  await settle(T);
  await openPub(tab, T.slug, { hash: '#stats' });
  await tab.click('[data-layout="new"]');
  await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'New standings');
  await check('st-09 new: a T column once a game was tied', async () => {
    const x = await tab.js(NEW_TABLES);
    const rows = x.flatMap((t) => t.rows);
    const a = rows.find((r) => r.name === s11.a);
    return (x[0].heads.includes('T') && a && a.by.T === '1' && a.by.W === '0' && a.by.L === '0') || x;
  });
  await tabTo(tab, 'cats');
  await tab.click('[data-catview="player"]');
  await check('cat-07 empty: By Player with no buzz at all says "No buzzes yet"', async () => (await tab.js(`document.querySelector('#catbody').innerText.trim()`)) === 'No buzzes yet' || tab.js(`document.querySelector('#catbody').innerText`));
  await tab.click('[data-catview="cat"]');
  await check('cat-07 empty: and Players says "No buzzes in this category"', async () => (await tab.js(`document.querySelector('#catbody').innerText.trim().split('\\n').pop()`)) === 'No buzzes in this category' || tab.js(`document.querySelector('#catbody').innerText`));

  /* --- a played game (one zero-value buzz) --- */
  const zeroTus = plain(1).map((t, i) => (i === 4 ? { z: [[1, 3, 0, 105]], bonus: null } : t));
  const g12 = aux({ round: 1, win: s12.a, lose: s12.b, tus: zeroTus });
  await put(g12, s12.room);
  await settle(T);
  await openPub(tab, T.slug, { hash: '#stats' });
  await tab.click('[data-statssec="individuals"]');
  await check('st-09 new: a zero-value column is left out, and no 15 column without powers (ACF)', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#newstats table.nstats thead th')].map((c) => c.textContent.trim())`);
    return (x.includes('10') && x.includes('-5') && !x.includes('0') && !x.includes('15')) || x;
  });
  await tab.click('[data-statssec="standings"]');
  const auxTally = () => tallyTeams([tie, g12]);
  await check('st-02 regulation count: points per tossup are scaled by the tournament\'s 18 regulation tossups (PP18TUH), in New', async () => {
    const x = await tab.js(NEW_TABLES);
    const row = x.flatMap((t) => t.rows).find((r) => r.name === s12.a);
    return (x[0].heads.includes('PP18TUH') && row && row.by.PP18TUH === pp(auxTally()[s12.a], 18).toFixed(1)) || { heads: x[0].heads, row, want: pp(auxTally()[s12.a], 18) };
  });
  await tab.click('[data-layout="classic"]');
  await check('st-02 regulation count: and in Classic, as the TD\'s downloaded report has it', async () => {
    const t = await tab.fwait(`(() => { const t = ${FRAME_TABLES('standings')}.find((x) => x.heads.includes('W')); return t; })()`, 'the Classic standings');
    const i = t.heads.indexOf('PP18TUH');
    const row = t.rows.find((r) => r.includes(s12.a));
    return (i >= 0 && row && Math.abs(Number(row[i]) - pp(auxTally()[s12.a], 18)) < 0.01) || t;
  });
  await tabTo(tab, 'cats');
  await check('cat-03 players: no 15 column when the format has no powers and nobody powered', async () => {
    const x = await tab.js(`[...document.querySelectorAll('#catbody table.cattable th')].map((c) => c.textContent)`);
    return q(x) === q(['Player', 'Team', '10', '-5', 'BB', 'Pts']) || x;
  });
  await tab.click('[data-cat="Geography"]');
  await check('cat-02 filters: a category read in round 1 only is offered (Geography)', async () => (await tab.js(`document.querySelector('[data-cat="Geography"]').classList.contains('on')`)) || 'not on');
  // round 1's packet replaced by one without it: the pick resets to All
  await putPacket(T, 1, mkPacket(1, { tuCats: cats, bonusCats: [C('Literature')], n: 18 }));
  await settle(T);
  const rr = await refresh(tab);
  await check('cat-02 filters: a picked category that disappears resets to All (after Refresh fetched the new map)', async () => {
    const x = await tab.js(`[!!document.querySelector('[data-cat="Geography"]'), (document.querySelector('[data-cat].on') || {}).textContent]`);
    return (!x[0] && x[1] === 'All' && workerPaths(rr.fetches).includes(`/pub/${T.slug}/cats`)) || { x, f: workerPaths(rr.fetches) };
  });

  /* --- a game filed under another round than its file says --- */
  const [s21, s22] = games(2);
  await must('round 2', call(T.A, { method: 'POST', json: { current_round: 2 } }));
  const g21 = aux({ round: 2, win: s21.a, lose: s21.b, tus: plain(2) });
  await put(g21, s21.room);
  const misfiled = aux({ round: 2, round_in_file: 1, win: s22.a, lose: s22.b, tus: plain(0) });
  await put(misfiled, s22.room, 2);
  await settle(T);
  const filedTag = '[changed: A game added under a different round than its file names now counts in the round it is filed under, as the hub shows it.]';
  await openPub(tab, T.slug, { hash: '#schedule' });
  await tab.click('[data-schedview="all"]');
  await check(`pub-15 filed round: the schedule shows its score in round 2, where it was filed ${filedTag}`, async () => {
    const s = await tab.js(`[...document.querySelectorAll('a.s[data-game]')].map((a) => [a.dataset.game, a.textContent])`);
    const key = [2, s22.a, s22.b].map(encodeURIComponent).join('|');
    const mine = s.filter(([k]) => k === key).map(([, v]) => v);
    return q(mine) === q([String(misfiled.exp[0].points), String(misfiled.exp[1].points)]) || s;
  });
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await tab.click('[data-statssec="games"]');
  await check(`pub-15 filed round: Stats lists it under Round 2 ${filedTag}`, async () => {
    const x = await secsOf(tab);
    const it = x.find((s) => s.head.startsWith(`${s22.a} ${misfiled.exp[0].points}`));
    return (it && it.meta.startsWith('Round 2 ') && x.filter((s) => s.meta.startsWith('Round 1 ')).length === 2) || x;
  });
  await tab.click('[data-statssec="rounds"]');
  await check(`pub-15 filed round: the Round report counts two games in round 2 ${filedTag}`, async () => {
    const x = await rowsOf(tab, '#newstats table.nstats tbody tr');
    return (x.find((r) => r[0] === '2') || [])[1] === '2' || x;
  });
  await tabTo(tab, 'buzz');
  await tab.fill('#buzzpw', 'quince');
  await tab.click('#buzzgo');
  await tab.wait(`!!document.querySelector('[data-buzzround="2"]')`, 'the Round 2 chip');
  await tab.click('[data-buzzround="2"]');
  const buzzLines = (n) => tab.wait(`(() => { const d = [...document.querySelectorAll('#buzzout details.qd')].find((x) => x.querySelector('.roundcell').textContent.trim() === 'T${n}');
    return d && !document.querySelector('#buzzout').textContent.includes('Loading') && [...d.querySelectorAll('.buzzlist > div')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()); })()`, 'tossup ' + n);
  await check(`pub-15 filed round: its buzzes are in round 2\'s buzzpoints ${filedTag}`, async () => {
    const x = await buzzLines(1);
    return (x.length === 2 && x.some((l) => l.includes(`(${s22.a})`) || l.includes(`(${s22.b})`))) || x;
  });

  /* --- the TD's corrections: a Rebuild, a room move, a room rename --- */
  const rebuildTag = '[changed: After a TD\'s Rebuild, a room move or a room rename, the public page shows the corrected games without waiting for new ones.]';
  await tabTo(tab, 'schedule');
  const fixed = JSON.parse(JSON.stringify(g12.qbj));
  fixed.match_teams[0].bonus_points += 30;
  await must('rebuild', call(T.A + '/bundle', { method: 'POST', body: JSON.stringify({ entries: [{ id: ids[g12.filename], round: 1, room: s12.room, filename: g12.filename, qbj: fixed }] }) }));
  await settle(T);
  await refresh(tab);
  await check(`pub-13 rebuild: Refresh shows the rebuilt game's score ${rebuildTag}`, async () => {
    const key = [1, s12.a, s12.b].map(encodeURIComponent).join('|');
    const s = await tab.js(`[...document.querySelectorAll('a.s[data-game="${key}"]')].map((a) => a.textContent)`);
    return q(s) === q([String(g12.exp[0].points + 30), String(g12.exp[1].points)]) || s;
  });
  const other = 'Room C'; // uploaded from the wrong room's link, say: the TD moves it to the spare room
  await must('move', call(`${T.A}/files/${ids[g12.filename]}`, { method: 'POST', json: { bucket_id: room(T, other).id } }));
  await settle(T);
  await tabTo(tab, 'buzz');
  await refresh(tab);
  await tab.click('[data-buzzround="1"]');
  await check(`pub-13 room move: the moved game's buzzes name its new room ${rebuildTag}`, async () => {
    const x = await buzzLines(1);
    return (x.length === 1 && x[0].endsWith('· ' + other)) || x;
  });
  await must('rename room', call(`${T.A}/buckets/${room(T, 'Room B').id}`, { method: 'POST', json: { room_name: 'Room Beta' } }));
  room(T, 'Room B').name = 'Room Beta';
  await settle(T);
  await refresh(tab);
  await check(`pub-13 room rename: buzzes from the renamed room name it ${rebuildTag}`, async () => {
    const x = (await buzzLines(1)).concat(await (async () => { await tab.click('[data-buzzround="2"]'); return buzzLines(1); })());
    return (x.some((l) => l.endsWith('· Room Beta')) && !x.some((l) => l.endsWith('· Room B'))) || x;
  });
  await tabTo(tab, 'schedule');
  await check(`pub-13 room rename: the schedule's room column says the new name ${rebuildTag}`, async () => {
    const x = await tab.js(`[...document.querySelectorAll('table.sched')].map((t) => [...t.querySelector('tr').children].map((c) => c.textContent))`);
    return (x.flat().includes('Room Beta') && !x.flat().includes('Room B')) || x;
  });

  /* --- a roster rename, arriving through Refresh --- */
  const OLD = s21.a;
  const NEW = OLD + ' Academy';
  const oldP = ROSTER[OLD][0];
  const newP = oldP.replace(' ', ' W. ');
  const renamed = AT.map((t) => (t.name === OLD
    ? { name: NEW, players: t.players.map((p) => (p === oldP ? newP : p)), formerNames: [OLD], formerPlayers: { [newP]: [oldP] } } : t));
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="classic"]');
  await tab.wait(`!!document.querySelector('iframe.report')`, 'Classic');
  await putRoster(T, renamed);
  ROSTER[NEW] = renamed.find((t) => t.name === NEW).players;
  renameTeams(sched, { [OLD]: NEW });
  await putSchedule(T, sched);
  await settle(T);
  await refresh(tab);
  const before = tallyTeams([tie, g12, g21, misfiled])[OLD];
  // what a viewer on each view sees of the rename: [classic ok, new ok, schedule ok, categories ok, buzzpoints ok]
  const renameSeen = async () => {
    const out = {};
    await tabTo(tab, 'stats');
    await tab.click('[data-layout="classic"]');
    const t = await tab.fwait(`(() => { const t = ${FRAME_TABLES('standings')}.find((x) => x.heads.includes('W')); return t && t.rows.length && t; })()`, 'standings');
    const names = t.rows.map((r) => r[t.heads.indexOf('Team')]);
    const ind = (await tab.fjs(FRAME_TABLES('individuals'))).find((x) => x.heads.includes('Player'));
    const players = ind.rows.map((r) => r[ind.heads.indexOf('Player')]);
    const row = t.rows.find((r) => r[t.heads.indexOf('Team')] === NEW);
    out.classic = names.includes(NEW) && !names.includes(OLD) && players.includes(newP) && !players.includes(oldP)
      && !!row && Number(row[t.heads.indexOf('W')]) === before.w && Number(row[t.heads.indexOf('L')]) === before.l;
    await tab.click('[data-layout="new"]');
    await tab.click('[data-statssec="individuals"]');
    const nx = await tab.js(`[...document.querySelectorAll('#newstats table.nstats tbody tr')].map((tr) => [(tr.querySelector('td.nstick a') || {}).textContent, (tr.querySelector('td.teamcol') || {}).textContent])`);
    out.new = nx.some((r) => r[0] === newP && r[1] === NEW) && !nx.some((r) => r[0] === oldP || r[1] === OLD);
    await tabTo(tab, 'schedule');
    const sx = await tab.js(`[[...document.querySelectorAll('table.sched .gl .t')].map((e) => e.textContent), [...document.querySelectorAll('#teamsel option')].map((o) => o.textContent),
      [...document.querySelectorAll('table.sched .gl')].filter((g) => g.querySelector('.t').textContent === ${q(NEW)} && g.querySelector('.s')).length]`);
    out.schedule = sx[0].includes(NEW) && !sx[0].includes(OLD) && sx[1].includes(NEW) && !sx[1].includes(OLD) && sx[2] === 2;
    await tabTo(tab, 'cats');
    const cx = await rowsOf(tab, '#catbody table.cattable tr');
    out.categories = cx.some((r) => r[0].startsWith(newP) && r[1] === NEW) && !cx.some((r) => r[0].startsWith(oldP) || r[1] === OLD);
    await tabTo(tab, 'buzz');
    await tab.click('[data-buzzround="2"]');
    await tab.wait(`!document.querySelector('#buzzout').textContent.includes('Loading') && document.querySelectorAll('#buzzout .buzzlist').length > 0`, 'round 2');
    const bx = await tab.js(`[...document.querySelectorAll('#buzzout .buzzlist > div')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
    out.buzzpoints = bx.some((l) => l.includes(`(${NEW})`)) && !bx.some((l) => l.includes(`(${OLD})`));
    return out;
  };
  const viaRefresh = await renameSeen();
  await bug('pub-14 renames: a rename arriving through Refresh reaches Classic, New, the schedule\'s results, Categories and Buzzpoints',
    async () => Object.values(viaRefresh).every(Boolean) || viaRefresh,
    'after the TD renames a team and a player (a roster with _formerNames, the schedule renamed), Refresh fetches the schedule (its stamp moved) but not the roster (the state carries no roster stamp and no round shard moved), so the games keep the old names: the renamed team\'s results drop off the schedule, which already says the new name, the team list keeps the old one, and Stats, Categories and Buzzpoints show the old names until the page is loaded again');
  await openPub(tab, T.slug, { hash: '#stats' });
  await tabTo(tab, 'buzz');
  if (await tab.exists('#buzzpw')) { await tab.fill('#buzzpw', 'quince'); await tab.click('#buzzgo'); await tab.wait(`!!document.querySelector('[data-buzzmode]')`, 'unlocked'); }
  const viaLoad = await renameSeen();
  for (const [k, label] of [['classic', 'Classic, with the team\'s whole record'], ['new', 'New'], ['schedule', 'the schedule\'s results and the team list'],
    ['categories', 'Categories'], ['buzzpoints', 'Buzzpoints']]) {
    await check(`pub-14 renames: loaded after a rename, ${label} show the new names only`, async () => viaLoad[k] === true || viaLoad);
  }

  /* --- load errors --- */
  const [s31, s32] = games(3);
  await must('round 3', call(T.A, { method: 'POST', json: { current_round: 3 } }));
  const name31 = (n) => (n === OLD ? NEW : n);
  const g31 = aux({ round: 3, win: name31(s31.a), lose: name31(s31.b), tus: plain(1) });
  await put(g31, s31.room === 'Room B' ? 'Room Beta' : s31.room);
  const title31 = `${g31.win} ${g31.exp[0].points}, ${g31.lose} ${g31.exp[1].points}`;
  await settle(T);
  faults.push({ test: (u) => u.pathname === `/pub/${T.slug}/rounds`, status: 503, body: '{"error":"shard store down"}' });
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await tab.click('[data-statssec="games"]');
  await refresh(tab);
  await check('pub-12 load errors: a round that fails to load shows a red "games: <message>", and the games already shown stay', async () => {
    const x = await tab.js(`[[...document.querySelectorAll('#out > .bad')].map((e) => [e.textContent, getComputedStyle(e).color]), [...document.querySelectorAll('#newstats .nsec .nhead span:first-child')].map((e) => e.textContent)]`);
    return (x[0].length === 1 && x[0][0][0] === 'games: shard store down' && isRed(x[0][0][1]) && x[1].length === 4 && !x[1].includes(title31)) || x;
  });
  faults = [];
  await refresh(tab);
  await check('pub-12 load errors: the next Refresh tries again and gets the round', async () => {
    const x = await tab.js(`[document.querySelectorAll('#out > .bad').length, [...document.querySelectorAll('#newstats .nsec .nhead span:first-child')].map((e) => e.textContent)]`);
    return (x[0] === 0 && x[1].includes(title31)) || x;
  });
  const broken = { _round: 3, match_teams: [{ team: { name: name31(s32.a) }, match_players: [] }, { team: { name: name31(s32.b) }, match_players: [] }] };
  const br3 = await upload(T, s32.room === 'Room B' ? 'Room Beta' : s32.room, 3, 'Broken_game.qbj', broken);
  await settle(T);
  await refresh(tab);
  await check('pub-12 load errors: a game that can\'t be read shows a red "<filename>: <message>" and is left out of the stats', async () => {
    const x = await tab.js(`[[...document.querySelectorAll('#out > .bad')].map((e) => e.textContent), document.querySelectorAll('#newstats .nsec').length]`);
    return (q(x[0]) === q(['Broken_game.qbj: Missing or invalid tossups_read']) && x[1] === 5) || x;
  });
  await must('delete', call(`${T.A}/files/${br3.id}`, { method: 'DELETE' }));
  // the round's last game, with a tiebreaker read in overtime (its id is whatever the game file says)
  const TB = '<i>TB</i> 1 & "x"';
  const g32 = aux({ round: 3, win: name31(s32.a), lose: name31(s32.b), tus: [...plain(0), { z: [[0, 0, 10, 20]], bonus: null, ot: true, tb: TB }] });
  await put(g32, s32.room === 'Room B' ? 'Room Beta' : s32.room);
  await settle(T);
  // a tiebreaker read: Replacements is offered, but says so until the tournament closes
  await tab.js('sessionStorage.clear(); true');
  await openPub(tab, T.slug, { hash: '#buzz' });
  await tab.fill('#buzzpw', 'quince');
  await tab.click('#buzzgo');
  await tab.wait(`!!document.querySelector('[data-buzzmode="replacements"]')`, 'the Replacements view');
  await tab.click('[data-buzzmode="replacements"]');
  await check('bz-05 replacements: offered once a tiebreaker was read; before the tournament closes it says "Replacement questions are not available yet."', async () => {
    const x = await tab.wait(`!document.querySelector('#buzzout').textContent.includes('Loading') && document.querySelector('#buzzout').innerText.trim()`, 'the answer');
    return x === 'Replacement questions are not available yet.' || x;
  });

  /* --- the password's other answers --- */
  faults.push({ test: (u) => u.pathname === `/pub/${T.slug}`, mutate: (text) => {
    const j = JSON.parse(text);
    if (j.buzz_kdf) j.buzz_kdf.iters = 0; // a key this browser can't derive
    return JSON.stringify(j);
  } });
  await tab.js('sessionStorage.clear(); true');
  await openPub(tab, T.slug, { hash: '#buzz' });
  await tab.fill('#buzzpw', 'quince');
  await tab.click('#buzzgo');
  await tab.wait(`document.querySelector('#msg').textContent === 'Could not check the password'`, 'the KDF failure');
  await check('bz-01 password: a key that can\'t be derived shows "Could not check the password", and nothing is stored', async () => {
    const x = [await msgIs(tab, 'Could not check the password'), await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`), await tab.exists('#buzzpw')];
    return (x[0] === true && x[1] === null && x[2]) || x;
  });
  faults = [];

  /* --- the tournament closes: Replacements --- */
  d1exec(`UPDATE tournaments SET started = started - ${4 * 86400000}, created = created - ${30 * 86400000} WHERE id = ${T.tid}`);
  await tab.S('Network.clearBrowserCache');
  await openPub(tab, T.slug, { hash: '#buzz' });
  await tab.fill('#buzzpw', 'quince');
  await tab.click('#buzzgo');
  await tab.wait(`!!document.querySelector('[data-buzzmode="replacements"]')`, 'the Replacements view');
  await tab.click('[data-buzzmode="replacements"]');
  await check('bz-05 replacements: a tiebreaker\'s name shows as text [changed: A tiebreaker\'s name in Replacements shows as text.]', async () => {
    const x = await tab.wait(`!document.querySelector('#buzzout').textContent.includes('Loading') && [...document.querySelectorAll('#buzzout details.qd .roundcell')].map((c) => [c.textContent.trim(), c.children.length])`, 'the replacements');
    return (q(x) === q([[TB, 0]])) || x;
  });

  /* --- too many attempts --- */
  for (let i = 0; i < 31; i++) await call(`/pub/${T.slug}/unlock`, { headers: { Authorization: 'Buzz not-the-key' } });
  await tab.js('sessionStorage.clear(); true');
  await tab.S('Network.clearBrowserCache');
  await openPub(tab, T.slug, { hash: '#buzz' });
  await tab.fill('#buzzpw', 'quince');
  await tab.click('#buzzgo');
  await tab.wait(`document.querySelector('#msg').textContent.includes('too many')`, 'the attempt cap');
  await check('bz-01 password: past the attempt cap, "too many attempts, wait a minute", and nothing stored', async () => {
    const x = [await msgIs(tab, 'too many attempts, wait a minute'), await tab.js(`sessionStorage.getItem('qbtdBuzzKey:${T.slug}')`)];
    return (x[0] === true && x[1] === null) || x;
  });
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="classic"]').catch(() => {});
  await tab.wait(`!!document.querySelector('#sheetchip')`, 'the switch').catch(() => {});
  await tab.close();
}
const secsOf = (tab) => tab.js(`[...document.querySelectorAll('#newstats .nsec')].map((s) => ({ head: s.querySelector('.nhead span').textContent,
  meta: (s.querySelector('.nhead .meta') || {}).textContent || '' }))`);

/* ---------- pub-06: the server fails ---------- */

const SERVER_FAILED = 'Something went wrong on the server. Please try again.';
async function sectionServerError(br) {
  const tag = '[changed: When the server fails, pages say "Something went wrong on the server. Please try again." instead of reporting a network error.]';
  const T = await mkTournament('Server Trouble Open', 'pubfull-500');
  const teams = [team('Osprey'), team('Petrel')];
  await putRoster(T, teams);
  await settle(T);
  const tab = await br.newTab();
  await openPub(tab, T.slug);
  // the prebuilt public state, unreadable: /pub/:slug throws inside the Worker
  r2put(`t/${T.tid}/pubstate.json`, '{"name": "cut off in the mid');
  await check(`pub-06 server failure: a /pub route that throws answers 500 with the message, as JSON the page can read ${tag}`, async () => {
    const r = await call('/pub/' + T.slug);
    return (r.status === 500 && r.body && r.body.error === SERVER_FAILED) || { status: r.status, body: String(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 200) };
  });
  await refresh(tab);
  await check(`pub-06 server failure: Refresh then shows a red "${SERVER_FAILED}", not a network error, and keeps what was on screen ${tag}`, async () => {
    const m = await msgIs(tab, SERVER_FAILED);
    const h = await tab.text('#tname');
    return (m === true && h === T.name) || { m, h };
  });
  await openPub(tab, T.slug, { expectError: true });
  await check(`pub-06 server failure: a first load says it too, and the header stays "tournament" ${tag}`, async () => {
    const m = await msgIs(tab, SERVER_FAILED);
    const h = await tab.js(`[document.querySelector('#tname').textContent, document.title]`);
    return (m === true && h[0] === 'tournament' && h[1] === 'tournament') || { m, h };
  });
  // the next rebuild writes the state again: Refresh loads the page
  await putRoster(T, teams);
  await settle(T);
  await refresh(tab);
  await check('pub-06 server failure: once the server answers again, Refresh loads the page and the message goes', async () => {
    const x = await tab.js(`[document.querySelector('#tname').textContent, document.querySelector('#msg').textContent, !!document.querySelector('.tab.active')]`);
    return (x[0] === T.name && x[1] === '' && x[2]) || x;
  });
  await tab.close();
}

/* ---------- pub-09: the production origin ---------- */

// The production hosts, played inside Chrome (Tab.intercept): the pages
// from this checkout's app/, qb-td by the local Worker, qb-td-live with
// no file (404, as for a tournament it doesn't hold). Nothing reaches
// the real ones.
const PROD = { pages: 'https://qbsuite.github.io', api: 'https://qb-td.denisliu10.workers.dev', live: 'https://qb-td-live.denisliu10.workers.dev' };
async function asProduction(tab) {
  await tab.intercept([PROD.pages + '/*', PROD.api + '/*', PROD.live + '/*'], async (url, req) => {
    const u = new URL(url);
    const cors = { 'Access-Control-Allow-Origin': PROD.pages };
    if (u.origin === PROD.pages) {
      const f = u.pathname.startsWith('/qb-td/app/') ? appFile(u.pathname.slice('/qb-td/app'.length)) : null;
      return f ? { status: 200, headers: { 'Content-Type': f.type }, body: f.body } : { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' };
    }
    if (u.origin === PROD.live) return { status: 404, headers: { ...cors, 'Content-Type': 'text/plain' }, body: 'not found' };
    if (req.method === 'OPTIONS') return { status: 204, headers: { ...cors, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' } };
    const r = await fetch(BASE + u.pathname + u.search, { method: req.method });
    return { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' }, body: Buffer.from(await r.arrayBuffer()) };
  });
}

async function sectionOrigin(br) {
  const tag = '[changed: On qbsuite.github.io, pages always use the qb-td server, even when a shared link names another one.]';
  const T = await mkTournament('Production Origin Open', 'pubfull-prod');
  await putRoster(T, [team('Kite'), team('Lark')]);
  await settle(T);
  const tab = await br.newTab();
  await asProduction(tab);
  const atProd = (extra) => `${PROD.pages}/qb-td/app/t.html?t=${T.slug}${extra}`;
  const landed = (t) => t.wait(`!!document.querySelector('.tab.active') || window.__qt.msgs.some((m) => m.bad)`, 'the page', 20000);
  // what a load asked of the servers: [the hosts the page asked, requests to the named server]
  const asked = (t, from) => ({
    hosts: t.routed.map((x) => x.url).filter((u) => !u.startsWith(PROD.pages)),
    named: t.reqs.slice(from).filter((x) => x.url.startsWith(PROXY)).map((x) => x.url),
  });
  const wantProd = [`${PROD.live}/t/${T.slug}.json`, `${PROD.api}/pub/${T.slug}?fb=404`];

  let from = tab.reqs.length;
  let mark = proxyLog.length;
  await tab.goto(atProd(`&server=${encodeURIComponent(PROXY)}&live=off`));
  await landed(tab);
  await check(`pub-09 production origin: a link's ?server= and ?live=off are ignored: the state comes from qb-td-live, then the qb-td Worker, never the named server ${tag}`, async () => {
    const x = asked(tab, from);
    return (q(x.hosts.slice(0, 2)) === q(wantProd) && x.hosts.every((u) => u.startsWith(PROD.api) || u.startsWith(PROD.live))
      && x.named.length === 0 && proxyLog.length === mark) || x;
  });
  await check('pub-09 production origin: and the page shows the tournament the qb-td Worker holds', async () => {
    const x = await tab.js(`[document.querySelector('#tname').textContent, document.querySelector('#msg').textContent]`);
    return (x[0] === T.name && x[1] === '') || x;
  });
  // overrides saved in this browser on the production origin
  await tab.js(`localStorage.setItem('qbtdServer', ${q(PROXY)}); localStorage.setItem('qbtdLive', 'off'); true`);
  tab.routed = [];
  from = tab.reqs.length;
  mark = proxyLog.length;
  await tab.goto(atProd(''));
  await landed(tab);
  await check(`pub-09 production origin: a saved qbtdServer / qbtdLive (localStorage) is ignored too ${tag}`, async () => {
    const x = asked(tab, from);
    return (q(x.hosts.slice(0, 2)) === q(wantProd) && x.named.length === 0 && proxyLog.length === mark
      && (await tab.text('#tname')) === T.name) || x;
  });
  await tab.js(`localStorage.removeItem('qbtdServer'); localStorage.removeItem('qbtdLive'); true`);
  await tab.close();

  // any other origin (a local test, a self-hosted copy) still honours both
  const lt = await br.newTab();
  await lt.goto(`${PAGES}/no-such-page.txt`); // this origin, to save the overrides on
  await lt.js(`localStorage.setItem('qbtdServer', ${q(PROXY)}); localStorage.setItem('qbtdLive', 'off'); true`);
  from = lt.reqs.length;
  mark = proxyLog.length;
  await lt.goto(`${PAGES}/t.html?t=${T.slug}`);
  await landed(lt);
  await check('pub-09 other origins: on a local copy, a saved qbtdServer and qbtdLive=off still point the page at that server', async () => {
    const mine = proxyLog.slice(mark).filter((x) => x.path === '/pub/' + T.slug).map((x) => x.search);
    const prod = lt.reqs.slice(from).filter((x) => /qbsuite\.github\.io|workers\.dev/.test(x.url)).map((x) => x.url);
    return (q(mine) === q(['']) && prod.length === 0 && (await lt.text('#tname')) === T.name) || { mine, prod };
  });
  await lt.js(`localStorage.removeItem('qbtdServer'); localStorage.removeItem('qbtdLive'); true`);
  const liveUrl = `http://127.0.0.1:${PORT.live}`;
  const l0 = liveLog.length;
  mark = proxyLog.length;
  await lt.goto(`${PAGES}/t.html?t=${T.slug}&server=${encodeURIComponent(PROXY)}&live=${encodeURIComponent(liveUrl)}`);
  await landed(lt);
  await check('pub-09 other origins: ?live=<url> is honoured: its state file is asked first, then the named server (?fb=404)', async () => {
    const files = liveLog.slice(l0).map((x) => x.path);
    const mine = proxyLog.slice(mark).filter((x) => x.path === '/pub/' + T.slug).map((x) => x.search);
    return (q(files) === q([`/t/${T.slug}.json`]) && q(mine) === q(['?fb=404']) && (await lt.text('#tname')) === T.name) || { files, mine };
  });
  await lt.close();
}

/* ---------- pub-10: GitHub snapshot blobs ---------- */

// A capture of a tournament as tools/archive.mjs `add` freezes one: its
// /pub responses, every game in one bundle. `pub` is the snapshot pointer
// to leave in it (the real capture drops it).
async function captureOf(T, pub = null) {
  const json = (r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body);
  const state = (await call('/pub/' + T.slug)).body;
  const ns = Object.keys(state.rounds || {});
  const shards = ns.length ? json(await call(`/pub/${T.slug}/rounds?n=${ns.join(',')}`)).rounds : [];
  const data = {
    [`/pub/${T.slug}`]: { ...state, buzz: null, buzz_v: null, buzz_done: [], packet_rounds: [], pub, rounds: undefined },
    [`/pub/${T.slug}/bundle`]: { entries: shards.flatMap((s) => s.entries || []) },
  };
  for (const p of ['/schedule', '/cats', '/roster']) {
    const r = await call(`/pub/${T.slug}${p}`);
    if (r.status === 200) data[`/pub/${T.slug}${p}`] = json(r);
  }
  return data;
}
// The archive page reading `data` as an archived tournament (its manifest
// entry and capture module answered inside Chrome); `pages`: the static
// stat report's files (archive/<slug>/<name>), when given. Any snapshot
// request is answered 404 and kept in tab.routed.
async function serveArchive(tab, slug, data, pages = null) {
  const index = JSON.parse(readFileSync(path.join(APP_DIR, 'archive', 'index.json'), 'utf8'));
  index.tournaments.unshift({ slug, name: data[`/pub/${slug}`].name, date: '2026-10-19', host: 'Here', teams: 4, rounds: 5, games: 8 });
  await tab.intercept([`${PAGES}/archive/*`, 'https://raw.githubusercontent.com/*'], async (url) => {
    const u = new URL(url);
    if (u.hostname === 'raw.githubusercontent.com') return { status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '404: Not Found' };
    if (u.pathname === '/archive/index.json') return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(index) };
    if (u.pathname === `/archive/${slug}.js`) return { status: 200, headers: { 'Content-Type': 'text/javascript' }, body: `export default ${JSON.stringify(data)};\n` };
    const page = pages && u.pathname.startsWith(`/archive/${slug}/`) ? pages[u.pathname.slice(`/archive/${slug}/`.length)] : undefined;
    if (page !== undefined) return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page };
    return null; // the archive's own files
  });
}

async function sectionSnapshots(br) {
  const T = await mkTournament('Snapshot Cup', 'pubfull-snap');
  await addRooms(T, ['Gallery 1', 'Gallery 2']);
  const teams = ['Pike', 'Quoll', 'Rook', 'Stoat'].map((n) => team(n));
  await putRoster(T, teams);
  const sched = buildSchedule('rr', teams.map((t) => t.name), T.rooms.map((r) => ({ name: r.name, bucket: r.id })));
  await putSchedule(T, sched);
  for (let r = 1; r <= 3; r++) await putPacket(T, r, mkPacket(r, { tuCats: MAIN_TU_CATS, bonusCats: MAIN_BONUS_CATS }));
  await startT(T);
  const played = [];
  const playRound = async (round) => {
    await must('round', call(T.A, { method: 'POST', json: { current_round: round } }));
    for (const s of schedGames(sched).filter((x) => x.round === round)) {
      const g = mkGame({ round, win: s.a, lose: s.b, tus: stdTossups({ k: round }) });
      await upload(T, s.room, round, g.filename, g.qbj);
      played.push(g);
    }
  };
  await playRound(1);
  await playRound(2);
  await settle(T);

  // the snapshot repo, as the publisher would have committed it: the blobs
  // the Worker serves, under a commit sha the state advertises
  const rawOf = async (p) => { const r = await fetch(BASE + p); if (!r.ok) throw new Error(p + ': ' + r.status); return Buffer.from(await r.arrayBuffer()); };
  const st = (await call('/pub/' + T.slug)).body;
  const files = {
    'roster.json': await rawOf(`/pub/${T.slug}/roster`),
    'schedule.json': await rawOf(`/pub/${T.slug}/schedule`),
    'cats.json': await rawOf(`/pub/${T.slug}/cats`),
  };
  for (const n of Object.keys(st.rounds)) {
    files[`r${n}.json`] = Buffer.from(JSON.stringify(JSON.parse(await rawOf(`/pub/${T.slug}/rounds?n=${n}`)).rounds[0]));
  }
  // the pointer the cron records after a publish (tournaments.pub_snapshot)
  const shas = new Set();
  let current = null;
  const advertise = (d) => {
    shas.add(d.sha);
    current = d;
    d1exec(`UPDATE tournaments SET pub_snapshot = '${JSON.stringify(d).replace(/'/g, "''")}' WHERE id = ${T.tid}`);
  };
  const desc = { sha: randomBytes(20).toString('hex'), at: Date.now(), rounds: { ...st.rounds }, schedule: st.schedule, cats: st.cats, roster: true, roster_at: 1 };
  advertise(desc);
  let state = (await call('/pub/' + T.slug)).body;
  // wrangler.toml names the snapshot repo; a Worker run without it gets
  // the pointer added on the way to the page
  const repo = (state.pub && state.pub.repo) || 'qbtd-tests/snapshots';
  if (!state.pub) {
    console.log('     (this Worker names no SNAPSHOT_REPO: the proxy adds the pointer to the state)');
    faults.push({ test: (u) => u.pathname === '/pub/' + T.slug, mutate: (text) => JSON.stringify({ ...JSON.parse(text), pub: { repo, ...current } }) });
  }
  await check('pub-10 snapshots: the state advertises the snapshot: its repo and commit sha', async () => {
    state = (await call('/pub/' + T.slug)).body;
    return (!state.pub || (state.pub.repo === repo && state.pub.sha === desc.sha)) || state.pub;
  });

  // GitHub, played inside Chrome: each file of the repo at a sha it holds,
  // or what snapMode says (a status, or 'hang')
  const snapMode = {};
  const tab = await br.newTab();
  await tab.intercept(['https://raw.githubusercontent.com/*'], async (url) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8' };
    const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/([a-z0-9-]+)\/([^/?]+)$/.exec(url);
    if (!m || m[1] !== repo || !shas.has(m[2]) || m[3] !== T.slug) return { status: 404, headers: cors, body: '404: Not Found' };
    const mode = snapMode[m[4]];
    if (mode === 'hang') return 'hang';
    if (typeof mode === 'number') return { status: mode, headers: cors, body: 'error' };
    return files[m[4]] ? { status: 200, headers: cors, body: files[m[4]] } : { status: 404, headers: cors, body: '404: Not Found' };
  });
  // every load reaches GitHub (or its fallback) afresh, never the browser's cache
  await tab.S('Network.setCacheDisabled', { cacheDisabled: true });
  const rawUrl = (sha, name) => `https://raw.githubusercontent.com/${repo}/${sha}/${T.slug}/${name}`;
  const workerAsked = (mark) => proxyLog.slice(mark).filter((x) => x.path.startsWith('/pub/' + T.slug)).map((x) => x.path + x.search);
  const games = () => tab.wait(`document.querySelector('#newstats') && [...document.querySelectorAll('#newstats .nsec .nhead span:first-child')].map((e) => e.textContent)`, 'the scoreboard');
  const toScoreboard = async () => {
    await tabTo(tab, 'stats');
    await tab.wait(`!!document.querySelector('[data-statssec="games"]')`, 'New');
    await tab.click('[data-statssec="games"]');
  };
  await tab.goto(`${PAGES}/no-such-page.txt`);
  await tab.js(`localStorage.setItem('qbtdStatsLayout', 'new'); true`);

  let mark = proxyLog.length;
  await openPub(tab, T.slug, { hash: '#stats' });
  await check('pub-10 snapshots: the roster, schedule, category map and each round come SHA-pinned from the snapshot repo, and the Worker serves only the state', async () => {
    const got = tab.routed.map((x) => x.url).sort();
    const want = ['roster.json', 'schedule.json', 'cats.json', 'r1.json', 'r2.json'].map((n) => rawUrl(desc.sha, n)).sort();
    return (q(got) === q(want) && q(workerAsked(mark)) === q([`/pub/${T.slug}`])) || { got, worker: workerAsked(mark) };
  });
  await toScoreboard();
  await check('pub-10 snapshots: the page shows what they hold (the four games, the schedule, the categories)', async () => {
    const g = await games();
    const extra = await tab.js(`[!document.querySelector('#tab-cats').hidden]`);
    await tabTo(tab, 'schedule');
    const sch = await tab.js(`document.querySelectorAll('#schedout .gl').length > 0`);
    return (g.length === 4 && extra[0] && sch) || { g, extra, sch };
  });

  // a file the snapshot can't give: that one from the Worker, the rest still from GitHub
  snapMode['r2.json'] = 404;
  snapMode['cats.json'] = 500;
  tab.routed = [];
  mark = proxyLog.length;
  await openPub(tab, T.slug, { hash: '#stats' });
  await check('pub-10 snapshots: a snapshot file that fails falls back to its /pub route (round 2, the category map), the others still come from GitHub', async () => {
    const w = workerAsked(mark).sort();
    const want = [`/pub/${T.slug}`, `/pub/${T.slug}/cats`, `/pub/${T.slug}/rounds?n=2@${st.rounds['2']}`].sort();
    const fromGh = tab.routed.map((x) => x.url.split('/').pop()).sort();
    return (q(w) === q(want) && q(fromGh) === q(['cats.json', 'r1.json', 'r2.json', 'roster.json', 'schedule.json'])) || { w, want, fromGh };
  });
  await toScoreboard();
  await check('pub-10 snapshots: with the fallback the page still shows every game and the categories', async () => {
    const g = await games();
    await tabTo(tab, 'cats');
    const c = await tab.wait(`!!document.querySelector('#out [data-catview]')`, 'the categories');
    return (g.length === 4 && c) || g;
  });

  // a snapshot file that hangs: given up on after 8 seconds, then the Worker
  snapMode['r2.json'] = undefined;
  snapMode['cats.json'] = undefined;
  snapMode['roster.json'] = 'hang';
  tab.routed = [];
  mark = proxyLog.length;
  await openPub(tab, T.slug, { hash: '#stats' });
  await check('pub-10 snapshots: a snapshot fetch that hangs times out after 8 s and falls back to the Worker\'s /roster', async () => {
    const asked = tab.routed.find((x) => x.url.endsWith('/roster.json'));
    const fell = proxyLog.slice(mark).find((x) => x.path === `/pub/${T.slug}/roster`);
    const waited = asked && fell ? fell.at - asked.at : null;
    return (waited !== null && waited >= 7500 && waited < 14000 && (await tab.text('#tname')) === T.name) || { asked: !!asked, fell: !!fell, waited };
  });
  snapMode['roster.json'] = undefined;

  // a round the snapshot doesn't hold at the stamp wanted: the Worker's
  await playRound(3);
  await settle(T);
  await toScoreboard();
  tab.routed = [];
  mark = proxyLog.length;
  const r3 = await refresh(tab);
  await check('pub-10 snapshots: Refresh fetches a round the snapshot lacks from the Worker; from GitHub only the roster, read with the games', async () => {
    const st3 = (await call('/pub/' + T.slug)).body;
    const w = workerAsked(mark);
    const gh = tab.routed.map((x) => x.url);
    return (q(w) === q([`/pub/${T.slug}`, `/pub/${T.slug}/rounds?n=3@${st3.rounds['3']}`]) && gh.every((u) => u === rawUrl(desc.sha, 'roster.json'))
      && (await games()).length === 6) || { w, gh, fetched: r3.fetches };
  });

  // a rename: the roster and schedule committed again, under a new sha
  const OLD = 'Pike';
  const NEW = 'Pike United';
  const renamed = teams.map((t) => (t.name === OLD ? { name: NEW, players: t.players, formerNames: [OLD] } : t));
  await putRoster(T, renamed);
  const sched2 = JSON.parse(JSON.stringify(sched));
  renameTeams(sched2, { [OLD]: NEW });
  await putSchedule(T, sched2);
  await settle(T);
  const st2 = (await call('/pub/' + T.slug)).body;
  files['roster.json'] = await rawOf(`/pub/${T.slug}/roster`);
  files['schedule.json'] = await rawOf(`/pub/${T.slug}/schedule`);
  const desc2 = { ...desc, sha: randomBytes(20).toString('hex'), at: Date.now(), schedule: st2.schedule, roster_at: 2 };
  advertise(desc2);
  await tab.click('[data-statssec="standings"]');
  tab.routed = [];
  await refresh(tab);
  await check('pub-10 snapshots: a rename the snapshot carries (roster_at moved) reaches the page on Refresh: the new name, with the team\'s whole record', async () => {
    const got = tab.routed.map((x) => x.url).sort();
    const rows = (await tab.js(NEW_TABLES)).flatMap((t) => t.rows);
    const row = rows.find((r) => r.name === NEW);
    const want = tallyTeams(played)[OLD];
    return (q(got) === q([rawUrl(desc2.sha, 'roster.json'), rawUrl(desc2.sha, 'schedule.json')].sort()) && row && !rows.some((r) => r.name === OLD)
      && Number(row.by.W) === want.w && Number(row.by.L) === want.l) || { got, names: rows.map((r) => r.name), row: row && row.by, want };
  });
  await tab.js(`localStorage.removeItem('qbtdStatsLayout'); true`);
  await tab.close();

  // the demo and the archive never use a snapshot, even one their data names
  const demo = await br.newTab();
  let planted = false;
  await demo.intercept([`${PAGES}/js/demo.js`, 'https://raw.githubusercontent.com/*'], async (url) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return { status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '404: Not Found' };
    const f = appFile('/js/demo.js');
    const text = f.body.toString('utf8');
    const ptr = JSON.stringify({ repo, ...desc2 });
    const out = text.replace("case '/pub/demo': return pubState();", `case '/pub/demo': return { ...pubState(), pub: ${ptr} };`);
    planted = out !== text;
    return { status: 200, headers: { 'Content-Type': f.type }, body: out };
  });
  await demo.goto(`${PAGES}/t.html?t=demo&server=${encodeURIComponent(PROXY)}&live=off#stats`);
  await demo.wait(`!!document.querySelector('.tab.active') && window.__qt.msgs.some((m) => m.t !== 'Loading')`, 'the demo', 20000);
  await check('pub-10 snapshots: the demo, whose state names a snapshot, fetches nothing from GitHub and shows its games', async () => {
    const named = await demo.js(`import(new URL('js/demo.js', document.baseURI).href).then((m) => m.demoPub('/pub/demo')).then((s) => !!(s.pub && s.pub.sha))`);
    const gh = demo.routed.filter((x) => x.url.startsWith('https://raw.githubusercontent.com/'));
    const shown = await demo.wait(`!!document.querySelector('iframe.report') || document.querySelectorAll('#newstats .nsec').length > 0`, 'the demo stats');
    return (planted && named && gh.length === 0 && shown) || { planted, named, gh: gh.map((x) => x.url) };
  });
  await demo.close();
  const arch = await br.newTab();
  const data = await captureOf(T, { repo, ...desc2 });
  await serveArchive(arch, T.slug, data);
  await arch.goto(`${PAGES}/archive.html?t=${T.slug}#stats`);
  await arch.wait(`!!document.querySelector('.tab.active') && !!document.querySelector('iframe.report')`, 'the archived page', 20000);
  await check('pub-10 snapshots: an archived page, whose capture names a snapshot, fetches nothing from GitHub and shows its games', async () => {
    const gh = arch.routed.filter((x) => x.url.startsWith('https://raw.githubusercontent.com/'));
    const standings = await arch.fwait(`document.querySelectorAll('#page-standings table tr').length`, 'the archived standings');
    return (gh.length === 0 && standings > 4) || { gh: gh.map((x) => x.url), standings };
  });
  await arch.close();
  d1exec(`UPDATE tournaments SET pub_snapshot = NULL WHERE id = ${T.tid}`);
}

/* ---------- st-04: names with special characters ---------- */

// Each carries markup and a script that would count itself in __xss if it
// ever ran, in the frame it ran in and, when it can, in the page.
const XSS = 'window.__xss=(window.__xss||0)+1;try{parent.__xss=(parent.__xss||0)+1}catch(e){}';
const SPECIAL = {
  teams: [`Smith & Wesson <b>Bold</b>`, `"Quoted" 'Apostrophe' Team`, `<img src=x onerror="${XSS}">`, `Tigers <script>${XSS}</script>`],
  player: `<i>Ada</i> & "Co" <img src=p onerror="${XSS}">`,
  phases: [`Prelims <u>Day</u> & "One"`, `Playoffs <img src=y onerror="${XSS}">`, `Tiebreakers <script>${XSS}</script>`, `Finals & <b>Glory</b>`],
  pools: [`Pool <i>A</i> & Co`, `Pool "B" <u>b</u>`],
  bracket: `Gold <img src=z onerror="${XSS}">`,
};
const planPhase = (name, o = {}) => ({ name, kind: 'pools', groups: 1, top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1,
  carry: true, reset: true, byes: false, sizes: null, parallelTop: false, share: false, n: 3, mode: 'rotate', ...o });
// What a stat report shows of the names: headings, result lines and table
// cells as text, and anything in them that became markup or ran.
const REPORT_READ = `(() => {
  const txt = (e) => e.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const within = [...document.querySelectorAll('section[id^="page-"]')];
  const scope = within.length ? within : [document.body];
  return {
    h2: [...document.querySelectorAll(within.length ? '#page-standings h2' : 'h2')].map(txt),
    h3: [...document.querySelectorAll(within.length ? '#page-standings h3' : 'h3')].map(txt),
    li: [...document.querySelectorAll(within.length ? '#page-standings li' : 'li')].map(txt),
    text: scope.map(txt).join(' '),
    planted: scope.reduce((n, s) => n + s.querySelectorAll('img, u, script').length, 0),
    ran: window.__xss || 0,
  };
})()`;

async function sectionSpecials(br) {
  const tag = '[changed: Team, stage and bracket names with special characters now show as text in the stat report, so they can no longer run as code.]';
  const [A, B, Cc, D] = SPECIAL.teams;
  const teams = [team(A, 'SW'), team(B, 'Quoted'), team(Cc, 'Img'), team(D, 'Tigers')];
  ROSTER[A][0] = SPECIAL.player;
  const T = await mkTournament('Special Names Invitational', 'pubfull-names');
  await addRooms(T, ['Hall 1', 'Hall 2']);
  await putRoster(T, teams);
  // two pools of two, crossover playoffs carrying the pool games, a
  // tiebreaker round and a one-game final, every name made special
  const P = [planPhase('Prelims', { groups: 2 }), planPhase('Playoffs', { sizes: [4], carry: true })];
  const s = buildPlan([A, B, Cc, D], T.rooms.map((r) => ({ name: r.name, bucket: r.id })), P, 'snake', 1);
  addFinals(s, planGroups([A, B, Cc, D], P, 'snake', () => 0.5), P, 'game', 'one');
  tagBrackets(s);
  SPECIAL.phases.forEach((n, i) => { s.phases[i].name = n; });
  for (const b of s.brackets) {
    if (b.key === 'A') b.name = SPECIAL.pools[0];
    else if (b.key === 'B') b.name = SPECIAL.pools[1];
    else b.name = s.phases[b.phase].kind ? s.phases[b.phase].name : SPECIAL.bracket;
  }
  await putSchedule(T, s);
  await startT(T);
  // A beats everyone, then B, then C
  const order = [A, B, Cc, D];
  const playR = async (round, x, y) => {
    await must('round', call(T.A, { method: 'POST', json: { current_round: round } }));
    const [w, l] = order.indexOf(x) < order.indexOf(y) ? [x, y] : [y, x];
    const room = schedGames(s).find((g) => g.round === round && [g.a, g.b].includes(x) && [g.a, g.b].includes(y));
    const g = mkGame({ round, win: w, lose: l, tus: stdTossups({ k: 1 }) });
    await upload(T, room ? room.room : 'Hall 1', round, g.filename, g.qbj);
  };
  for (const g of schedGames(s).filter((x) => x.round === 1)) await playR(1, g.a, g.b);
  const pools = Object.fromEntries(Object.entries(s.pools).map(([k, ts]) => [k, [...ts].sort((x, y) => order.indexOf(x) - order.indexOf(y))]));
  fillPlaceholders(s, pools);
  await putSchedule(T, s);
  for (const round of [2, 3]) for (const g of schedGames(s).filter((x) => x.round === round)) await playR(round, g.a, g.b);
  await playR(4, Cc, D); // the tiebreaker round: a game for third
  const fin = s.phases.find((ph) => ph.kind === 'final').rounds[0].games[0];
  fin.a = { team: A };
  fin.b = { team: B };
  await putSchedule(T, s);
  await playR(5, A, B);
  await settle(T);

  const tab = await br.newTab();
  await tab.goto(`${PAGES}/no-such-page.txt`);
  await tab.js(`localStorage.removeItem('qbtdStatsLayout'); true`);
  await openPub(tab, T.slug, { hash: '#stats' });
  await tab.wait(`!!document.querySelector('iframe.report')`, 'Classic');
  const classic = () => tab.fwait(`document.querySelector('#page-standings h2') && ${REPORT_READ}`, 'the report');
  const stageNames = [SPECIAL.phases[0], SPECIAL.phases[1], SPECIAL.phases[3]];
  const results = [`${A} def. ${B} (box)`, `${Cc} def. ${D} (box)`];
  const readsRight = (x) => ({
    stages: stageNames.every((n) => x.h2.includes(n)),
    pools: SPECIAL.pools.every((n) => x.h3.includes(n)),
    results: results.every((r) => x.li.includes(r)),
    names: [...SPECIAL.teams, SPECIAL.player].every((n) => x.text.includes(n)),
    inert: x.planted === 0 && x.ran === 0,
  });
  let x = await classic();
  let ok1 = readsRight(x);
  await check(`st-04 special names: Classic heads its stages and pools with the names as written ${tag}`, async () => (ok1.stages && ok1.pools) || { h2: x.h2, h3: x.h3 });
  await check(`st-04 special names: Classic's Finals and Tiebreakers results name the teams as written ${tag}`, async () => ok1.results || x.li);
  await check('st-04 special names: Classic\'s tables show team and player names as written', async () => ok1.names || x.text.slice(0, 600));
  await check(`st-04 special names: nothing in the names became markup or ran in the Classic report ${tag}`, async () => ok1.inert || { planted: x.planted, ran: x.ran });
  await check('st-04 special names: nothing ran in the page around the report', async () => (await tab.js('window.__xss || 0')) === 0 || 'ran');

  await tab.click('[data-layout="new"]');
  await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'New');
  await check('st-04 special names: New shows the names as written, its stage and pool heads too, and nothing ran', async () => {
    const y = await tab.js(`(() => { const box = document.querySelector('#newstats'); return { text: box.textContent, heads: [...box.querySelectorAll('.poolhead, .stagehead, [data-statstage]')].map((e) => e.textContent),
      planted: box.querySelectorAll('img, u, script').length, ran: window.__xss || 0 }; })()`);
    return ([...SPECIAL.teams, SPECIAL.phases[0], SPECIAL.phases[1]].every((n) => y.text.includes(n)) && y.planted === 0 && y.ran === 0) || y;
  });
  await tabTo(tab, 'schedule');
  await tab.click('[data-schedview="all"]').catch(() => {});
  await check('st-04 special names: the Schedule shows team, phase and bracket names as written, and nothing ran', async () => {
    const y = await tab.js(`(() => { const box = document.querySelector('#out'); return { text: box.textContent, planted: box.querySelectorAll('img, u, script, b').length, ran: window.__xss || 0 }; })()`);
    return ([...SPECIAL.teams, SPECIAL.phases[0], SPECIAL.pools[0]].every((n) => y.text.includes(n)) && y.planted === 0 && y.ran === 0) || y;
  });
  // the New click above saved the layout for this origin; the archive
  // checks below read the Classic report, the layout a new viewer gets
  await tab.js(`localStorage.removeItem('qbtdStatsLayout'); true`);
  await tab.close();

  // archived: the archive page's report, and the static report pages
  // tools/archive.mjs writes (built here with this checkout's report.js,
  // as `add` builds them: the capture, its format and its schedule)
  const data = await captureOf(T);
  const { buildReport } = await import(pathToFileURL(path.join(APP_DIR, 'engine', 'report.js')).href);
  const { readGames } = await import('../app/engine/games.js');
  const { parseRoster, rosterNameMap } = await import('../app/engine/qbj.js');
  const { dedupeMatches } = await import('../app/engine/stats.js');
  const { effectiveFormat } = await import('../app/js/read_core.js');
  const roster = parseRoster(data[`/pub/${T.slug}/roster`]);
  const { matches } = readGames(data[`/pub/${T.slug}/bundle`].entries, rosterNameMap(roster), []);
  const pages = Object.fromEntries(buildReport({ name: T.name, matches: dedupeMatches(matches), roster,
    settings: effectiveFormat(data[`/pub/${T.slug}`].format), schedule: data[`/pub/${T.slug}/schedule`] }).map((p) => [p.name, p.text]));
  const arch = await br.newTab();
  await serveArchive(arch, T.slug, data, pages);
  await arch.goto(`${PAGES}/archive.html?t=${T.slug}#stats`);
  await arch.wait(`!!document.querySelector('iframe.report')`, 'the archived page', 20000);
  x = await arch.fwait(`document.querySelector('#page-standings h2') && ${REPORT_READ}`, 'the archived report');
  ok1 = readsRight(x);
  await check(`st-04 special names: the archived page's report shows them as written, results included, and nothing ran ${tag}`, async () => (ok1.stages && ok1.results && ok1.names && ok1.inert) || { ok1, h2: x.h2, li: x.li, planted: x.planted, ran: x.ran });
  await arch.goto(`${PAGES}/archive/${T.slug}/standings.html`);
  x = await arch.wait(`document.readyState === 'complete' && ${REPORT_READ}`, 'the static report');
  ok1 = readsRight(x);
  await check(`st-04 special names: the archived static report (standings.html) shows them as written, results included, and nothing ran ${tag}`, async () => (ok1.stages && ok1.results && ok1.inert) || { ok1, h2: x.h2, li: x.li, planted: x.planted, ran: x.ran });
  await arch.close();
}

/* ---------- sch-10: crossover playoffs after Copy this phase ---------- */

// Eight teams in two pools, Copy this phase (the pools again), crossover
// playoffs filled from the pools' places, then an advantaged final, played
// through `beats` (who wins each game before the final). Slots fill as the
// hub's auto-fill fills them (finals.js finalsFill).
async function crossoverDay(label, beats) {
  const names = ['Ash', 'Birch', 'Cherry', 'Date', 'Elder', 'Fig', 'Gum', 'Hazel'].map((n) => `${n} ${label}`);
  const T = await mkTournament(`Crossover ${label} Open`, 'pubfull-x' + label.toLowerCase());
  await addRooms(T, ['Court 1', 'Court 2', 'Court 3', 'Court 4']);
  await putRoster(T, names.map((n) => team(n, n.split(' ')[0])));
  const P = [planPhase('Prelims 1', { groups: 2 }), planPhase('Prelims 2', { groups: 2, same: true }), planPhase('Playoffs', { sizes: [4, 4], carry: true })];
  const s = buildPlan(names, T.rooms.map((r) => ({ name: r.name, bucket: r.id })), P, 'snake', 1);
  addFinals(s, planGroups(names, P, 'snake', () => 0.5), P, undefined, 'advantaged');
  tagBrackets(s);
  await putSchedule(T, s);
  await startT(T);
  const games = [];
  const files = () => games.map((m, i) => ({ id: i + 1, kind: 'qbj', round: m.round, summary: JSON.stringify({ teams: m.teams.map((t) => t.name) }) }));
  const setRound = (n) => must('round', call(T.A, { method: 'POST', json: { current_round: n } }));
  const play = async (round, roomIdx, w, l) => {
    const g = mkGame({ round, win: w, lose: l, tus: stdTossups({ k: 0 }) });
    await upload(T, T.rooms[roomIdx].name, round, g.filename, g.qbj);
    games.push({ round, tossupsRead: 20, teams: g.exp.map((e) => ({ name: e.name, points: e.points, bonusPoints: e.bonusPts, players: [] })) });
  };
  let filled = s;
  for (const p of [0, 1, 2]) {
    if (p === 2) {
      filled = finalsFill(filled, games, finalsProgress(filled, files()).ready).schedule;
      await putSchedule(T, filled);
    }
    for (const r of filled.phases[p].rounds) {
      await setRound(r.round);
      for (const g of r.games) {
        const [a, b] = [g.a.team, g.b.team];
        await (beats(names, a, b) ? play(r.round, g.room, a, b) : play(r.round, g.room, b, a));
      }
    }
  }
  filled = finalsFill(filled, games, finalsProgress(filled, files()).ready).schedule;
  await putSchedule(T, filled);
  await settle(T);
  const fin = filled.phases.find((ph) => ph.kind === 'final');
  return { T, names, fin, play, setRound };
}

async function sectionFinals(br) {
  const tag = '[changed: With crossover playoffs after Copy this phase, the tournament shows as finished once no more finals are needed, and stays open while one is.]';
  const n = (names, x) => names.indexOf(x) + 1;
  const tab = await br.newTab();
  const head = () => tab.js(`[document.querySelector('#round').textContent, !!document.querySelector('[data-schedview="now"]'), document.querySelectorAll('.nowtag.live, td.now, tr.nowrow').length]`);

  // the leader two wins clear of the rest of 1st–4th place: no final needed
  const top4 = (names) => names.slice(0, 4);
  const clear = await crossoverDay('Clear', (names, a, b) => {
    const t = top4(names);
    if (t.includes(a) && t.includes(b) && a !== names[0] && b !== names[0]) {
      const cycle = { 2: 3, 3: 4, 4: 2 }; // the others each beat one and lose to one
      return cycle[n(names, a)] === n(names, b);
    }
    return n(names, a) < n(names, b);
  });
  await openPub(tab, clear.T.slug);
  await check(`sch-10 finished: crossover playoffs after Copy this phase, the leader two wins clear: no final needed, so "Finished" ${tag}`, async () => {
    const x = await head();
    const finals = q(clear.fin.rounds[0].games.map((g) => [g.a.team, g.b.team])) === q([[clear.names[0], clear.names[1]]]);
    return (x[0] === 'Finished' && !x[1] && x[2] === 0 && finals) || { x, finals: clear.fin.rounds.map((r) => r.games.map((g) => [g.a.team || g.a.label, g.b.team || g.b.label])) };
  });

  // one win clear: the final is played; open until it is decided
  const close = await crossoverDay('Close', (names, a, b) => n(names, a) < n(names, b));
  const [r1, r2] = close.fin.rounds.map((r) => r.round);
  await openPub(tab, close.T.slug);
  await check('sch-10 finished: one win clear after the playoffs: the final is still to play, so the tournament stays open (Round 8, Now offered)', async () => {
    const x = await head();
    return (x[0] === 'Round 8' && x[1]) || x;
  });
  await close.setRound(r1);
  await close.play(r1, 0, close.names[1], close.names[0]); // the leader loses the first final
  await settle(close.T);
  await refresh(tab);
  await check(`sch-10 finished: the leader lost the first final, so the second is needed and the tournament stays open (Round ${r1}) ${tag}`, async () => {
    const x = await head();
    return (x[0] === 'Round ' + r1 && x[1]) || x;
  });
  await close.setRound(r2);
  await close.play(r2, 0, close.names[0], close.names[1]);
  await settle(close.T);
  await refresh(tab);
  await check('sch-10 finished: the second final played: "Finished", Now dropped, nothing highlighted', async () => {
    const x = await head();
    return (x[0] === 'Finished' && !x[1] && x[2] === 0) || x;
  });
  await tab.close();
}

/* ---------- pub-02: a mirror whose set locks its buzzpoints ---------- */

async function sectionMirror(br) {
  const T = await mkTournament('Mirror Lock Cup', 'pubfull-mirror');
  await addRooms(T, ['Lab 1']);
  const teams = [team('Puffin'), team('Quetzal')];
  await putRoster(T, teams);
  const set = await must('set', call('/api/sets', { method: 'POST', json: { name: 'Lock Test Set', slug: 'pubfull-set-' + randomBytes(3).toString('hex') } }));
  const S = '/s/' + set.admin_secret;
  const inv = await must('invite', call(S + '/mirrors', { method: 'POST', json: { name: 'Lock mirror', host: 'Here' } }));
  await must('join', call(T.A + '/join', { method: 'POST', json: { invite: inv.invite } }));
  await setPassword(T, 'plum', { buzz: true });
  await startT(T);
  await settle(T);
  const tab = await br.newTab();
  const buzzShown = async () => {
    await tab.S('Network.clearBrowserCache');
    await openPub(tab, T.slug, { hash: '#buzz' });
    return tab.js(`[!document.querySelector('#tab-buzz').hidden, document.querySelector('.tab.active').id]`);
  };
  await check('pub-02 tabs: a mirror with its own buzzpoints on shows Buzzpoints while its set leaves them on', async () => {
    const x = await buzzShown();
    return (x[0] && x[1] === 'tab-buzz') || x;
  });
  await must('lock', call(S, { method: 'POST', json: { settings: { lockMirrorBuzz: true } } }));
  await tick();
  await bug('pub-02 tabs: once the set locks mirror buzzpoints, the mirror\'s page shows no Buzzpoints tab (and #buzz opens the usual first tab)', async () => {
    const x = await buzzShown();
    return (!x[0] && x[1] === 'tab-stats') || { shown: x[0], open: x[1], workerBuzz: (await call('/pub/' + T.slug)).body.buzz };
  }, 'saving the set\'s settings marks only the set for rebuilding (worker.js updateSet: markSet), so the mirror\'s prebuilt public state (pubstate.json) keeps buzz "password" and its page keeps the Buzzpoints tab until something else rebuilds the mirror; the question text itself is refused (qpacket checks the lock live)');
  // the mirror rebuilt for any reason (here: its TD saves a setting)
  await saveSettings(T, () => {});
  await settle(T);
  await bug('pub-02 tabs: once the mirror is rebuilt under the lock, the tab is gone and #buzz opens the usual first tab', async () => {
    const x = await buzzShown();
    return (!x[0] && x[1] === 'tab-stats') || { shown: x[0], open: x[1] };
  }, 'the cron rebuilds the mirror from TICK_ROW_SELECT (worker.js), which reads no s.settings AS set_settings, so buzzConfig never sees the set\'s lockMirrorBuzz and the rebuilt pubstate.json still has buzz "password"; same at 173a444');
  await must('unlock', call(S, { method: 'POST', json: { settings: {} } }));
  await saveSettings(T, () => {});
  await settle(T);
  await check('pub-02 tabs: unlocked again (and rebuilt), the mirror shows Buzzpoints', async () => {
    const x = await buzzShown();
    return (x[0] && x[1] === 'tab-buzz') || x;
  });
  await tab.close();
}

/* ---------- sch-09 and the rest: a browser that blocks storage ---------- */

// what a browser that blocks site data does: reading either storage throws
const BLOCK_STORAGE = `(() => { for (const k of ['localStorage', 'sessionStorage']) {
  Object.defineProperty(window, k, { configurable: true, get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); } }); } })();`;
async function sectionStorage(br) {
  const T = await mkTournament('Storage Blocked Open', 'pubfull-nostore');
  await addRooms(T, ['Den 1', 'Den 2']);
  const teams = ['Heron', 'Ibis', 'Jay', 'Kiwi'].map((nm) => team(nm));
  await putRoster(T, teams);
  const sched = buildSchedule('rr', teams.map((t) => t.name), T.rooms.map((r) => ({ name: r.name, bucket: r.id })));
  await putSchedule(T, sched);
  await startT(T);
  for (const s of schedGames(sched).filter((x) => x.round === 1)) {
    const g = mkGame({ round: 1, win: s.a, lose: s.b, tus: stdTossups({ k: 1 }) });
    await upload(T, s.room, 1, g.filename, g.qbj);
  }
  await settle(T);
  const tab = await br.newTab();
  await tab.S('Page.addScriptToEvaluateOnNewDocument', { source: BLOCK_STORAGE });
  await openPub(tab, T.slug);
  await check('sch-09 storage blocked: the page loads and opens on Schedule, in Now', async () => {
    const x = await tab.js(`[(() => { try { localStorage.length; return 'readable'; } catch (e) { return 'blocked'; } })(), document.querySelector('.tab.active').id,
      (document.querySelector('[data-schedview].on') || {}).textContent, !!document.querySelector('.nowgrid')]`);
    return (x[0] === 'blocked' && x[1] === 'tab-schedule' && x[2] === 'Now' && x[3]) || x;
  });
  await tab.click('[data-schedview="all"]');
  await check('sch-09 storage blocked: All rounds still switches', async () => !!(await tab.wait(`!!document.querySelector('table.sched')`, 'All rounds')));
  await tabTo(tab, 'stats');
  await tab.click('[data-layout="new"]');
  await check('sch-09 storage blocked: Stats still switches to New', async () => !!(await tab.wait(`!!document.querySelector('#newstats table.nstats')`, 'New')));
  await openPub(tab, T.slug);
  await check('sch-09 storage blocked: a reload keeps nothing (Now again), and nothing threw', async () => {
    const x = await tab.js(`[(document.querySelector('[data-schedview].on') || {}).textContent]`);
    return (x[0] === 'Now' && tab.errors.length === 0) || { x, errors: tab.errors };
  });
  await tab.close();
}

/* ---------- run ---------- */

const SECTIONS = [
  ['links', sectionLinks], ['pending', sectionPending], ['main', sectionMain], ['aux', sectionAux],
  ['errors', sectionServerError], ['origin', sectionOrigin], ['snapshots', sectionSnapshots], ['specials', sectionSpecials],
  ['finals', sectionFinals], ['mirror', sectionMirror], ['storage', sectionStorage],
];

async function run() {
  console.log('ui_full_public: app ' + APP_DIR + ', worker ' + WORKER_DIR);
  if (!BASE || !PAGES) await startStack();
  else if (!PERSIST) throw new Error('with QBTD_BASE, set QBTD_PERSIST too (the stack\'s --state folder)');
  await startProxy();
  await startLiveFiles();
  // a fresh day's creation budget for this machine (the Worker caps tournaments per IP)
  d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
  d1exec("UPDATE sets SET creator_ip = 'earlier-run'");
  const br = new Browser();
  await br.start();
  for (const [name, fn] of SECTIONS) {
    if (ONLY && !ONLY.has(name)) continue;
    console.log(`--- ${name}`);
    faults = [];
    try { await fn(br); } catch (e) { ok(`${name}: the section ran to its end`, false, e.stack || e.message); }
  }
  const changed = tally.fail.filter((n) => CHANGED.test(n));
  const other = tally.fail.filter((n) => !CHANGED.test(n));
  console.log(`\n${tally.pass} public-page checks passed, ${tally.fail.length} failed`
    + ` (${changed.length} tagged [changed], ${other.length} not)` + (tally.bugs.length ? `, ${tally.bugs.length} known bugs` : '')
    + ` in ${Math.round((Date.now() - started) / 1000)}s`);
  if (changed.length) console.log('failed, tagged [changed]:\n  ' + changed.join('\n  '));
  if (other.length) console.log('failed, not tagged:\n  ' + other.join('\n  '));
  if (tally.bugs.length) console.log('known bugs (reported, not failed):\n  ' + tally.bugs.join('\n  '));
}

run().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; })
  .finally(() => { stopAll(); setTimeout(() => process.exit(process.exitCode || 0), 200); });
