// cdp_lib.mjs — headless Chrome over the DevTools protocol (Node's own
// WebSocket, no dependencies), plus the two small local servers the page
// goldens need: the app's static files, and a stand-in Worker that answers
// 404 to everything. Used by ui_golden.js; ui_e2e.js keeps its own copy.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const until = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** Chrome, headless, on a fresh profile; one tab. */
export async function openChrome() {
  const udd = mkdtempSync(path.join(tmpdir(), 'qbtd-cdp-'));
  const fixed = process.env.QBTD_CDP_PORT || null;
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${fixed || 0}`, `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-features=Translate,OptimizationHints,MediaRouter',
    'about:blank'], { stdio: 'ignore' });
  const close = () => { try { proc.kill(); } catch (e) { /* gone */ } try { rmSync(udd, { recursive: true, force: true }); } catch (e) { /* busy */ } };
  process.on('exit', close);
  // a fixed port (QBTD_CDP_PORT) says where to connect on /json/version
  let wsUrl;
  if (fixed) {
    wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${fixed}/json/version`)).json()).webSocketDebuggerUrl, 'Chrome to start');
  } else {
    const portFile = path.join(udd, 'DevToolsActivePort');
    await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'), 'Chrome to start');
    const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
    wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
  }
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
  const send = (method, params = {}, sessionId) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => pending.set(id, { res, rej, method }));
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params) => send(method, params, sessionId);
  const once = (pred, ms = 30000, what = 'browser event') => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no ' + what + ' within ' + ms + 'ms')), ms);
    const fn = (m) => { if (pred(m)) { clearTimeout(t); listeners.splice(listeners.indexOf(fn), 1); res(m); } };
    listeners.push(fn);
  });
  const errors = [];
  const requests = [];
  const failures = []; // requests the browser gave up on, and why (net::ERR_…, CORS)
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    } else if (m.method === 'Network.requestWillBeSent') {
      requests.push({ id: m.params.requestId, method: m.params.request.method, url: m.params.request.url, type: m.params.type || '', headers: m.params.request.headers });
    } else if (m.method === 'Network.responseReceived') {
      const r = requests.find((x) => x.id === m.params.requestId);
      if (r) r.status = m.params.response.status;
    } else if (m.method === 'Network.loadingFailed') {
      const r = requests.find((x) => x.id === m.params.requestId);
      failures.push({ url: r ? r.url : '', status: r ? r.status : undefined, error: m.params.errorText, blocked: m.params.blockedReason || m.params.corsErrorStatus?.corsError || '' });
    } else if (m.method === 'Page.javascriptDialogOpening') {
      errors.push('dialog: ' + m.params.message);
      S('Page.handleJavaScriptDialog', { accept: false });
    }
  });
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Network.enable');
  await S('Network.setCacheDisabled', { cacheDisabled: true });
  await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

  async function js(expression) {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async function goto(url) {
    const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, 'load of ' + url);
    await S('Page.navigate', { url });
    await loaded;
  }
  const q = (s) => JSON.stringify(s);
  const waitJs = (expr, label, ms) => until(() => js(expr), label, ms);
  const click = (sel) => js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
  return { send, S, js, goto, waitJs, click, errors, requests, failures, close, sessionId };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

/** The app's static files on 127.0.0.1:port, every request logged.
    `rewrite(urlPath, text)` may change a JavaScript file as it is served
    (a test's instrumentation); it never touches the files on disk. */
export function staticServer(root, port, rewrite = null) {
  const log = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: u.pathname });
    let file = path.join(root, decodeURIComponent(u.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { /* missing */ }
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    let body = readFileSync(file);
    const ext = path.extname(file);
    if (rewrite && (ext === '.js' || ext === '.mjs')) {
      const out = rewrite(u.pathname, body.toString('utf8'));
      if (typeof out === 'string') body = Buffer.from(out);
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${port}` })));
}

/** A stand-in Worker: logs each request and answers 404 (with CORS), so a
    page under test that asks the backend anything is seen and gets the
    answer a missing route gives. */
export function stubWorker(port) {
  const log = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: u.pathname });
    res.writeHead(req.method === 'OPTIONS' ? 204 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
    res.end(req.method === 'OPTIONS' ? '' : '{"error":"not found"}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${port}` })));
}
