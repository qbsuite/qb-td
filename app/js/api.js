// api.js — Worker base URL + fetch helper shared by the qb-td pages.
// Point a page at another backend with ?server=... or localStorage
// qbtdServer (same convention as qb-scorekeeper). There is no login:
// admin, bucket, and public routes are all keyed by link secrets.

const qs = new URLSearchParams(location.search);
export const API = qs.get('server') || localStorage.qbtdServer
  || 'https://qb-td.denisliu10.workers.dev';

// The demo tournament (demo.html): the 'demo' slug/admin id and the
// 'demo'/'demo-b' bucket secrets are its reserved names, and every pub()
// call is served in-browser from the committed fixture by demo.js — the
// pages themselves run unchanged.
const DEMO = qs.get('t') === 'demo' || qs.get('a') === 'demo'
  || ['demo', 'demo-b'].includes(qs.get('b'));
let demoModule = null;

// A frozen snapshot of /pub responses, keyed by path. Set by the archive
// page (archive.html) so the real public page code runs with no Worker
// behind it; every other page leaves this null and hits the API.
let frozen = null;

/** Serve pub() from an in-memory {path: response} map instead of the
    network. Call before importing the page module that reads it. */
export function useFrozenData(map) {
  frozen = map;
}

/** True when pub() answers from local data (demo fixture or an archive
    capture) rather than the network. Pages must then ignore any GitHub
    snapshot pointers riding in that data — the frozen copy is already
    the complete source, and the snapshot repo may have moved on. */
export function usingStaticData() {
  return DEMO || frozen !== null;
}

/** JSON call to any Worker route. Throws Error(message) on failure.
    Pass opts.json to send a JSON body. Non-JSON responses (blobs) return
    the raw Response. */
export async function pub(path, opts = {}) {
  if (DEMO) {
    // Resolved against the page URL at runtime (every page lives in app/),
    // NOT a static './demo.js': the specifier must stay non-literal so
    // esbuild leaves it out of read.bundle.js — the fixture inside demo.js
    // is far too big to ride along with MODAQ.
    if (!demoModule) demoModule = await import(new URL('js/demo.js', document.baseURI).href);
    return demoModule.demoPub(path, opts);
  }
  if (frozen) {
    // A frozen page is read-only: unknown paths fail the way a missing
    // blob does, so callers take their existing "not published" branch.
    if (!Object.prototype.hasOwnProperty.call(frozen, path)) {
      throw new Error('not available in this archived copy');
    }
    return frozen[path];
  }
  if (opts.json !== undefined) {
    opts = {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: JSON.stringify(opts.json),
    };
  }
  const res = await fetch(API + path, opts);
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('request failed (' + res.status + ')');
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed (' + res.status + ')');
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function download(filename, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
