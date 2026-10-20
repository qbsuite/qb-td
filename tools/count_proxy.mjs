#!/usr/bin/env node
// count_proxy.mjs — a counting proxy between the pages under test and the
// local dev Worker. Each request is logged with its flow (set by the test),
// method, route template (secrets, slugs, ids and keys replaced by their
// kind), status, request and response bytes, for a preflight the
// headers it asks for (Access-Control-Request-Headers), and the response's
// CORS, Vary and X-Qbtd-* headers (hdr; local ports and X-Qbtd-* values
// taken out). What a refactor must keep: the same non-OPTIONS requests per
// flow, the same preflight header sets, the same GET response bytes, the
// same response headers per route.
//
//   node tools/count_proxy.mjs --port 9615 --target http://127.0.0.1:9613 [--log file.jsonl]
//
// Control routes, for the test driving the pages (never forwarded):
//   POST /__flow?name=<flow>   later requests are logged under <flow>
//   GET  /__log                the log so far, as JSON
//   POST /__reset              empties the log

import { Agent, createServer, request as httpRequest } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const PORT = Number(opt('port', 9615));
const TARGET = new URL(opt('target', 'http://127.0.0.1:9613'));
const LOG = opt('log');

/** A request's route with what differs run to run replaced by its kind. */
export function routeTemplate(method, rawUrl) {
  const u = new URL(rawUrl, 'http://x');
  let p = u.pathname
    .replace(/^\/a\/[a-z0-9]{10,40}/, '/a/:admin')
    .replace(/^\/b\/[a-z0-9]{10,40}/, '/b/:room')
    .replace(/^\/s\/[a-z0-9]{10,40}/, '/s/:set')
    .replace(/^\/i\/[a-z0-9]{10,40}/, '/i/:invite')
    .replace(/^\/(pub|pubset)\/[a-z0-9-]{3,40}/, '/$1/:slug')
    .replace(/\/(files|buckets|mirrors)\/\d+/, '/$1/:id')
    .replace(/\/qbj\/\d+$/, '/qbj/:id');
  const q = [];
  for (const [k, v] of [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (k === 'key') {
      const key = v.replace(/^t\/\d+\//, '');
      q.push('key=' + (key === 'roster.qbj' ? 'roster' : key === 'schedule.json' ? 'schedule'
        : /^bucket\//.test(key) ? 'upload' : /^packet\//.test(key) ? 'packet' : /^s\//.test(v) ? 'setpacket' : 'other'));
    } else if (k === 'ids') q.push('ids=' + v.split(',').length);
    else if (k === 'rev') q.push('rev');
    else if (k === 'n') q.push('n=' + v.split(',').length);
    else if (['part', 'round', 'warm', 'fb'].includes(k)) q.push(k + '=' + v);
    else q.push(k);
  }
  return method + ' ' + p + (q.length ? '?' + q.join('&') : '');
}

/** A response's CORS, Vary and X-Qbtd-* headers as one line: names
    sorted, local ports and X-Qbtd-* values (etags) left out. */
export function headerLine(h) {
  return Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => /^(access-control-|x-qbtd-|vary$)/.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => (k.startsWith('x-qbtd-') ? k : k + ': ' + String(v).replace(/\/\/(localhost|127\.0\.0\.1):\d+/g, '//$1:<port>')))
    .join(' | ');
}

let flow = '';
let log = [];
// a fresh connection per request: wrangler's CLI calls (d1 execute, r2
// object) reset the dev server's keep-alive sockets, and a reused dead one
// would fail a request the page made
const agent = new Agent({ keepAlive: false });
const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const server = main && createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__flow') { flow = u.searchParams.get('name') || ''; res.end('ok'); return; }
  if (u.pathname === '/__log') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(log)); return; }
  if (u.pathname === '/__reset') { log = []; res.end('ok'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: TARGET.host };
    const up = httpRequest({ hostname: TARGET.hostname, port: TARGET.port, path: req.url, method: req.method, headers, agent }, (r) => {
      const out = [];
      r.on('data', (c) => out.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(out);
        const row = { flow, method: req.method, route: routeTemplate(req.method, req.url), status: r.statusCode,
          reqBytes: body.length, resBytes: buf.length, hdr: headerLine(r.headers),
          acrh: req.method === 'OPTIONS' ? String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).sort().join(',') : undefined,
          acrm: req.method === 'OPTIONS' ? req.headers['access-control-request-method'] || '' : undefined };
        log.push(row);
        if (LOG) appendFileSync(LOG, JSON.stringify(row) + '\n');
        res.writeHead(r.statusCode, r.headers);
        res.end(buf);
      });
    });
    up.on('error', (e) => {
      log.push({ flow, method: req.method, route: routeTemplate(req.method, req.url), status: 502, error: e.message });
      res.writeHead(502, { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy: ' + e.message }));
    });
    up.end(body);
  });
});
if (server) server.listen(PORT, '127.0.0.1', () => console.log(`count_proxy on http://127.0.0.1:${PORT} -> ${TARGET.origin}`));
