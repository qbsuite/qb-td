// inproc_worker.mjs — worker/worker.js run inside Node, against SQLite
// (node:sqlite, worker/schema.sql) for D1 and an in-memory R2 with etags
// and conditional puts, with every D1 statement, R2 call and WebCrypto
// call it makes logged. What one request costs Cloudflare is that log:
// D1 queries and rows, R2 Class A (put, list) and Class B (get, head)
// operations. Used by worker_inproc.mjs (the per-route goldens) and
// cpubench.mjs (CPU per route). Needs Node 22.5 or later.
//
//   const w = await workerHarness();            // this checkout's worker.js
//   const w = await workerHarness(otherDir);    // another checkout's, side by side
//   const { res, ops } = await w.measured(() => w.call('/a/…/file?key=…'));

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// WebCrypto is global: each harness logs into whichever log is current
let cryptoLog = null;
const subtle = globalThis.crypto.subtle;
for (const m of ['digest', 'importKey', 'exportKey', 'deriveKey', 'deriveBits', 'encrypt', 'decrypt', 'sign', 'verify', 'wrapKey', 'unwrapKey']) {
  if (typeof subtle[m] !== 'function' || subtle[m].__counted) continue;
  const orig = subtle[m].bind(subtle);
  const counted = (...a) => { if (cryptoLog) cryptoLog.push('crypto ' + m); return orig(...a); };
  counted.__counted = true;
  subtle[m] = counted;
}

// One statement's text as logged: whitespace collapsed, nothing cut.
export const sqlText = (sql) => sql.replace(/\s+/g, ' ').trim();

// R2 keys as logged: the parts that differ run to run (random tokens in
// upload keys) replaced by a placeholder; ids stay, the database is fresh.
export const keyPattern = (k) => String(k)
  .replace(/\/bucket\/(\d+)\/[a-z0-9]{8}-/, '/bucket/$1/{rand}-');

/** A fresh Worker: its own database, bucket and module instance. */
export async function workerHarness(root = ROOT, extraEnv = {}) {
  const href = pathToFileURL(path.join(root, 'worker/worker.js')).href + (root === ROOT ? '' : '?' + encodeURIComponent(root));
  const worker = (await import(href)).default;
  const schema = readFileSync(path.join(root, 'worker/schema.sql'), 'utf8');

  let log = [];
  const bump = (line) => log.push(line);

  /* D1 */
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const plain = (r) => (r ? { ...r } : null);
  let inBatch = false;
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { bump('d1' + (inBatch ? '.batch' : '') + ' all ' + sqlText(sql)); return { results: db.prepare(sql).all(...args).map(plain), meta: {} }; },
    async run() { bump('d1' + (inBatch ? '.batch' : '') + ' run ' + sqlText(sql)); const r = db.prepare(sql).run(...args); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    async first(col) { bump('d1 first ' + sqlText(sql)); const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : plain(r)) : null; },
    async raw() { bump('d1 raw ' + sqlText(sql)); return db.prepare(sql).all(...args).map((r) => Object.values(r)); },
  });
  const DB = {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      bump('d1 batch ' + list.length);
      inBatch = true;
      try { const out = []; for (const s of list) out.push(await s.run()); return out; } finally { inBatch = false; }
    },
    exec: async (sql) => { bump('d1 exec ' + sqlText(sql)); db.exec(sql); return { count: 1 }; },
  };

  /* R2 */
  const objects = new Map();
  let etagSeq = 0;
  let clock = Date.parse('2026-10-01T12:00:00Z');
  const meta = (k, o) => ({ key: k, size: o.bytes.byteLength, uploaded: new Date(o.at), etag: o.etag, httpEtag: '"' + o.etag + '"',
    customMetadata: o.custom, httpMetadata: o.http, version: o.etag });
  const toBytes = async (body) => {
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    if (body && typeof body.getReader === 'function') return new Uint8Array(await new Response(body).arrayBuffer());
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    return new TextEncoder().encode(String(body));
  };
  const DATA = {
    async head(k) { bump('r2 head ' + keyPattern(k)); const o = objects.get(k); return o ? meta(k, o) : null; },
    async get(k, opts = {}) {
      bump('r2 get ' + keyPattern(k) + (opts && opts.onlyIf ? ' (conditional)' : ''));
      const o = objects.get(k);
      if (!o) return null;
      const bytes = o.bytes;
      return { ...meta(k, o),
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        blob: async () => new Blob([bytes]),
        get body() { return new Blob([bytes]).stream(); },
        writeHttpMetadata(h) { if (o.http.contentType) h.set('Content-Type', o.http.contentType); } };
    },
    async put(k, body, opts = {}) {
      const c = opts.onlyIf || null;
      bump('r2 put ' + keyPattern(k) + (c ? ' (conditional)' : ''));
      const cur = objects.get(k);
      if (c) {
        const want = c.etagMatches;
        const not = c.etagDoesNotMatch;
        if (want !== undefined && (!cur || (want !== '*' && cur.etag !== String(want).replace(/"/g, '')))) return null;
        if (not !== undefined && cur && (not === '*' || cur.etag === String(not).replace(/"/g, ''))) return null;
      }
      const o = { bytes: await toBytes(body), at: (clock += 1000), etag: 'e' + (++etagSeq), custom: opts.customMetadata || {}, http: opts.httpMetadata || {} };
      objects.set(k, o);
      return meta(k, o);
    },
    async delete(k) {
      for (const x of [].concat(k)) { bump('r2 delete ' + keyPattern(x)); objects.delete(x); }
    },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      bump('r2 list ' + keyPattern(prefix));
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.map((k) => meta(k, objects.get(k))), truncated: false, delimitedPrefixes: [] };
    },
  };

  const env = { DB, DATA, ALLOWED_ORIGIN: 'http://localhost', PAGES_URL: 'http://localhost/app', ...extraEnv };
  let waits = [];
  const ctx = { waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); }, passThroughOnException() {} };
  const settle = async () => { while (waits.length) { const w = waits; waits = []; await Promise.all(w); } };

  async function call(p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; delete opts.json; }
    const res = await worker.fetch(new Request('http://w' + p, { ...opts, headers }), env, ctx);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await settle();
    const text = new TextDecoder().decode(bytes);
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, body, text, bytes, headers: Object.fromEntries(res.headers) };
  }
  const tick = async (cron = '* * * * *') => { await worker.scheduled({ cron, scheduledTime: Date.now() }, env, ctx); await settle(); };

  /** fn's own log: D1 statements, R2 operations and crypto calls, in order. */
  async function measured(fn) {
    log = [];
    cryptoLog = log;
    let res;
    try { res = await fn(); } finally { cryptoLog = null; }
    const ops = log;
    log = [];
    return { res, ops };
  }
  const quiet = async (fn) => (await measured(fn)).res;

  return {
    worker, env, call, tick, measured, quiet,
    sql: (q, ...a) => db.prepare(q).all(...a).map(plain),
    raw: (k) => (objects.get(k) ? new TextDecoder().decode(objects.get(k).bytes) : null),
    rawObj: (k) => objects.get(k) || null,
    etag: (k) => (objects.get(k) ? objects.get(k).etag : null),
    setRaw: (k, text, http = { contentType: 'application/json' }) => {
      objects.set(k, { bytes: typeof text === 'string' ? new TextEncoder().encode(text) : text, at: (clock += 1000), etag: 'e' + (++etagSeq), custom: {}, http });
    },
    keys: () => [...objects.keys()],
  };
}

/** Op counts by kind, for a summary line: d1, r2 get/put/…, crypto. */
export function opCounts(ops) {
  const out = {};
  for (const l of ops) {
    const [a, b] = l.split(' ');
    const k = a === 'r2' || a === 'crypto' ? a + '.' + b : a;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
