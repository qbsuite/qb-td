// api.js — Worker base URL + fetch helper shared by the qb-td pages.
// Point a page at another backend with ?server=... or localStorage
// qbtdServer (same convention as qb-moderator). There is no login:
// admin, bucket, and public routes are all keyed by link secrets.

const qs = new URLSearchParams(location.search);
export const API = qs.get('server') || localStorage.qbtdServer
  || 'https://qb-td.denisliu10.workers.dev';

/** JSON call to any Worker route. Throws Error(message) on failure.
    Pass opts.json to send a JSON body. Non-JSON responses (blobs) return
    the raw Response. */
export async function pub(path, opts = {}) {
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
