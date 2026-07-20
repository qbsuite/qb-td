// api.js — Worker base URL, session token handling, fetch helpers shared
// by the qb-td pages. Point a page at another backend with ?server=... or
// localStorage qbtdServer (same convention as qb-moderator).

const qs = new URLSearchParams(location.search);
export const API = qs.get('server') || localStorage.qbtdServer
  || 'https://qb-td.denisliu10.workers.dev';

const TOKEN_KEY = 'qbtdToken';

// The OAuth callback lands back on the page with #td=<token>.
export function captureToken() {
  const m = /[#&]td=([^&]+)/.exec(location.hash);
  if (m) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search);
  }
  return localStorage.getItem(TOKEN_KEY);
}
export function token() { return localStorage.getItem(TOKEN_KEY); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

export function loginUrl() {
  return API + '/auth/login?return=' + encodeURIComponent(location.href.split('#')[0]);
}

/** Authed JSON call to the admin API. Throws Error(message) on any failure. */
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) { clearToken(); throw new Error('sign in required'); }
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('request failed (' + res.status + ')');
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed (' + res.status + ')');
  return data;
}

/** Unauthed JSON call (bucket + public routes). */
export async function pub(path, opts = {}) {
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
