// worker.js — qb-td backend (Cloudflare Worker + D1 + R2). Deploy/setup:
// ../README.md.
//
// Three access levels, three route families:
//   /api/*  — the TO's admin API. Requires a session minted by the GitHub
//             OAuth flow (stateless HMAC bearer token, copied from
//             library-of-stock sync/worker.js). Everything is scoped to the
//             signed-in owner; there is no cross-tenant read.
//   /b/*    — the moderator bucket API. No login: the unguessable bucket
//             secret in the URL is the credential. Grants upload + packet
//             download for that one room only.
//   /pub/*  — the public stats API. No auth, but only serves tournaments
//             the TO has published, and only match qbj + roster blobs —
//             never packets, never admin metadata, never bucket secrets.
//
// Storage: metadata in D1 (schema.sql), blobs in R2 under t/<tid>/...
// All blob reads stream through the Worker so the publish gate is enforced
// in one place.

const TOKEN_TTL = 90 * 24 * 3600 * 1000; // session lifetime: 90 days
const STATE_TTL = 10 * 60 * 1000;        // oauth state lifetime: 10 minutes
const MAX_UPLOAD = 8 * 1024 * 1024;      // moderator file cap
const MAX_PACKET = 16 * 1024 * 1024;     // packet cap
const MAX_TOURNAMENTS_PER_USER = 20;
const MAX_BUCKETS = 60;
const MAX_FILES_PER_BUCKET = 300;
const MAX_NAME = 120;

/* ---------- base64url + HMAC helpers (from sync/worker.js) ---------- */
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64url(sig);
}
async function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret),
      b64urlToBytes(sig), enc.encode(body));
  } catch (e) { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); }
  catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/* ---------- responses ---------- */
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}
function err(env, status, message) { return json(env, { error: message }, status); }

function blobResponse(env, r2obj, filename) {
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', r2obj.httpMetadata?.contentType || 'application/octet-stream');
  if (filename) {
    headers.set('Content-Disposition',
      `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`);
  }
  return new Response(r2obj.body, { status: 200, headers });
}

async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7), env.SESSION_SECRET);
}

/* ---------- oauth flow (from sync/worker.js) ---------- */
async function authLogin(url, env) {
  const ret = url.searchParams.get('return') || '';
  if (!ret.startsWith(env.ALLOWED_ORIGIN)) {
    return new Response('bad return url (must be on ' + env.ALLOWED_ORIGIN + ')', { status: 400 });
  }
  const state = await signToken({ r: ret, exp: Date.now() + STATE_TTL }, env.SESSION_SECRET);
  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', url.origin + '/auth/callback');
  gh.searchParams.set('state', state);
  return Response.redirect(gh.toString(), 302);
}

// GitHub 5xxs transiently; a 5xx means the request wasn't processed, so
// retrying is safe even for the one-shot code exchange.
async function ghFetch(url, init) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400 * attempt));
    res = await fetch(url, init);
    if (res.status < 500) return res;
  }
  return res;
}

async function authCallback(url, env) {
  const state = await verifyToken(url.searchParams.get('state') || '', env.SESSION_SECRET);
  if (!state || !state.r) return new Response('bad or expired oauth state', { status: 400 });
  const code = url.searchParams.get('code');
  if (!code) return new Response('missing code', { status: 400 });

  const tokenRes = await ghFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'qb-td' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tok.access_token) {
    console.log('token exchange failed:', tokenRes.status, tok.error || 'no error field', tok.error_description || '');
    return new Response('github token exchange failed' + (tok.error ? ' (' + tok.error + ')' : ''), { status: 502 });
  }

  const userRes = await ghFetch('https://api.github.com/user', {
    headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'qb-td' },
  });
  const gh = await userRes.json().catch(() => ({}));
  if (!gh.id) {
    console.log('user lookup failed:', userRes.status, gh.message || 'no message');
    return new Response('github user lookup failed' + (gh.message ? ' (' + gh.message + ')' : ''), { status: 502 });
  }

  const uid = 'gh:' + gh.id;
  const login = String(gh.login || uid);
  await env.DB.prepare(
    'INSERT INTO users (uid, login, created) VALUES (?1, ?2, ?3) ON CONFLICT(uid) DO UPDATE SET login = ?2'
  ).bind(uid, login, Date.now()).run();

  const session = await signToken({ u: uid, l: login, exp: Date.now() + TOKEN_TTL }, env.SESSION_SECRET);
  // Fragment, not query: never hits server logs, and the client strips it.
  return Response.redirect(state.r + '#td=' + session, 302);
}

/* ---------- misc helpers ---------- */
function randToken(len = 20) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/l/i
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
function cleanFilename(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[^\w.\- ()\[\]]/g, '_');
  return base.slice(0, 100) || 'file';
}
function cleanName(s) {
  return String(s || '').trim().slice(0, MAX_NAME);
}

// Light server-side qbj sanity check; the dashboard does full engine
// validation. Returns an error string or null.
function validateQbj(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return 'not valid JSON'; }
  if (obj && Array.isArray(obj.objects)) {
    obj = obj.objects.find((o) => o && (o.match_teams || o.matchTeams)) || obj;
  }
  const teams = obj && (obj.match_teams || obj.matchTeams);
  if (!Array.isArray(teams) || teams.length !== 2) return 'no match with exactly two match_teams';
  return null;
}

async function getOwnedTournament(env, user, id) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM tournaments WHERE id = ?1 AND owner_uid = ?2'
  ).bind(id, user.u).all();
  return results[0] || null;
}

/* ---------- TO admin API (/api/*, OAuth-gated) ---------- */

async function listTournaments(env, user) {
  const { results } = await env.DB.prepare(
    'SELECT id, slug, name, current_round, published, created FROM tournaments WHERE owner_uid = ?1 ORDER BY created DESC'
  ).bind(user.u).all();
  return json(env, { tournaments: results });
}

async function createTournament(request, env, user) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const slug = String(body.slug || '').trim().toLowerCase();
  const name = cleanName(body.name);
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
    return err(env, 400, 'slug must be 3-40 chars: a-z, 0-9, hyphens');
  }
  if (!name) return err(env, 400, 'name required');

  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM tournaments WHERE owner_uid = ?1'
  ).bind(user.u).all();
  if (results[0].n >= MAX_TOURNAMENTS_PER_USER) return err(env, 403, 'tournament cap reached');

  try {
    const out = await env.DB.prepare(
      'INSERT INTO tournaments (slug, name, owner_uid, settings, created) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(slug, name, user.u, JSON.stringify(body.settings || {}), Date.now()).run();
    return json(env, { id: out.meta.last_row_id, slug });
  } catch (e) {
    return err(env, 409, 'slug already taken');
  }
}

async function getTournament(env, user, id) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  const [buckets, rounds, files] = await Promise.all([
    env.DB.prepare('SELECT id, room_name, secret, created FROM buckets WHERE tournament_id = ?1 ORDER BY id').bind(id).all(),
    env.DB.prepare('SELECT number, packet_name, packet_r2_key FROM rounds WHERE tournament_id = ?1 ORDER BY number').bind(id).all(),
    env.DB.prepare('SELECT id, bucket_id, round, kind, r2_key, filename, size, error, created FROM files WHERE tournament_id = ?1 ORDER BY created DESC').bind(id).all(),
  ]);
  return json(env, {
    tournament: t,
    buckets: buckets.results,
    rounds: rounds.results,
    files: files.results,
  });
}

async function updateTournament(request, env, user, id) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }

  const sets = [];
  const binds = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return err(env, 400, 'bad name');
    sets.push('name = ?'); binds.push(name);
  }
  if (body.current_round !== undefined) {
    const n = Number(body.current_round);
    if (!Number.isInteger(n) || n < 1 || n > 999) return err(env, 400, 'bad round');
    sets.push('current_round = ?'); binds.push(n);
  }
  if (body.published !== undefined) {
    sets.push('published = ?'); binds.push(body.published ? 1 : 0);
  }
  if (body.settings !== undefined) {
    if (typeof body.settings !== 'object' || body.settings === null) return err(env, 400, 'bad settings');
    const s = JSON.stringify(body.settings);
    if (s.length > 4096) return err(env, 400, 'settings too large');
    sets.push('settings = ?'); binds.push(s);
  }
  if (!sets.length) return err(env, 400, 'nothing to update');

  await env.DB.prepare(
    `UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();
  return json(env, { ok: true });
}

async function createBucket(request, env, user, id) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const roomName = cleanName(body.room_name);
  if (!roomName) return err(env, 400, 'room_name required');

  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM buckets WHERE tournament_id = ?1'
  ).bind(id).all();
  if (results[0].n >= MAX_BUCKETS) return err(env, 403, 'bucket cap reached');

  const secret = randToken();
  const out = await env.DB.prepare(
    'INSERT INTO buckets (tournament_id, room_name, secret, created) VALUES (?1, ?2, ?3, ?4)'
  ).bind(id, roomName, secret, Date.now()).run();
  return json(env, { id: out.meta.last_row_id, room_name: roomName, secret });
}

async function deleteBucket(env, user, id, bucketId) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  // Files already uploaded stay downloadable; only the mod's access dies.
  await env.DB.prepare(
    'DELETE FROM buckets WHERE id = ?1 AND tournament_id = ?2'
  ).bind(bucketId, id).run();
  return json(env, { ok: true });
}

async function uploadPacket(request, url, env, user, id) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  const round = Number(url.searchParams.get('round'));
  if (!Number.isInteger(round) || round < 1 || round > 999) return err(env, 400, 'bad round');
  const filename = cleanFilename(url.searchParams.get('name'));

  const body = await request.arrayBuffer();
  if (!body.byteLength) return err(env, 400, 'empty body');
  if (body.byteLength > MAX_PACKET) return err(env, 413, 'packet too large');

  const key = `t/${id}/packet/${round}/${filename}`;
  await env.DATA.put(key, body, {
    httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
  });
  await env.DB.prepare(
    'INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?1, ?2, ?3, ?4) ' +
    'ON CONFLICT(tournament_id, number) DO UPDATE SET packet_r2_key = ?3, packet_name = ?4'
  ).bind(id, round, key, filename).run();
  return json(env, { round, filename });
}

async function uploadRoster(request, url, env, user, id) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  const filename = cleanFilename(url.searchParams.get('name') || 'roster.qbj');
  const body = await request.arrayBuffer();
  if (!body.byteLength) return err(env, 400, 'empty body');
  if (body.byteLength > MAX_UPLOAD) return err(env, 413, 'roster too large');

  const key = `t/${id}/roster.qbj`;
  await env.DATA.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  await env.DB.prepare(
    'UPDATE tournaments SET roster_r2_key = ?2, roster_name = ?3 WHERE id = ?1'
  ).bind(id, key, filename).run();
  return json(env, { filename });
}

async function adminDownload(url, env, user, id) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  const key = url.searchParams.get('key') || '';
  // Ownership boundary: only this tournament's prefix is reachable.
  if (!key.startsWith(`t/${id}/`)) return err(env, 403, 'bad key');
  const obj = await env.DATA.get(key);
  if (!obj) return err(env, 404, 'no such file');
  return blobResponse(env, obj, url.searchParams.get('dl') || key.split('/').pop());
}

async function deleteFile(env, user, id, fileId) {
  const t = await getOwnedTournament(env, user, id);
  if (!t) return err(env, 404, 'not found');
  const { results } = await env.DB.prepare(
    'SELECT r2_key FROM files WHERE id = ?1 AND tournament_id = ?2'
  ).bind(fileId, id).all();
  if (!results.length) return err(env, 404, 'no such file');
  await env.DATA.delete(results[0].r2_key);
  await env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(fileId).run();
  return json(env, { ok: true });
}

/* ---------- moderator bucket API (/b/*, secret-authed) ---------- */

async function getBucketRow(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT b.id, b.room_name, b.tournament_id, t.name AS tournament_name, ' +
    't.current_round, t.roster_r2_key ' +
    'FROM buckets b JOIN tournaments t ON t.id = b.tournament_id WHERE b.secret = ?1'
  ).bind(secret).all();
  return results[0] || null;
}

async function bucketState(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  const [packet, uploads] = await Promise.all([
    env.DB.prepare(
      'SELECT number, packet_name FROM rounds WHERE tournament_id = ?1 AND number = ?2'
    ).bind(b.tournament_id, b.current_round).all(),
    env.DB.prepare(
      'SELECT id, round, kind, filename, size, error, created FROM files WHERE bucket_id = ?1 ORDER BY created DESC'
    ).bind(b.id).all(),
  ]);
  return json(env, {
    tournament: b.tournament_name,
    room: b.room_name,
    current_round: b.current_round,
    packet: packet.results[0] || null,
    uploads: uploads.results,
  });
}

async function bucketUpload(request, url, env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');

  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM files WHERE bucket_id = ?1'
  ).bind(b.id).all();
  if (results[0].n >= MAX_FILES_PER_BUCKET) return err(env, 403, 'upload cap reached');

  const filename = cleanFilename(url.searchParams.get('name'));
  let round = Number(url.searchParams.get('round'));
  if (!Number.isInteger(round) || round < 1 || round > 999) round = b.current_round;

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return err(env, 400, 'empty file');
  if (buf.byteLength > MAX_UPLOAD) return err(env, 413, 'file too large');

  const isQbj = /\.qbj$/i.test(filename);
  const kind = isQbj ? 'qbj' : /_game\.json$/i.test(filename) ? 'game' : 'other';
  let error = null;
  if (isQbj) error = validateQbj(new TextDecoder().decode(buf));

  const key = `t/${b.tournament_id}/bucket/${b.id}/${randToken(8)}-${filename}`;
  await env.DATA.put(key, buf, { httpMetadata: { contentType: 'application/json' } });
  const out = await env.DB.prepare(
    'INSERT INTO files (tournament_id, bucket_id, round, kind, r2_key, filename, size, error, created) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(b.tournament_id, b.id, round, kind, key, filename, buf.byteLength, error, Date.now()).run();
  return json(env, { id: out.meta.last_row_id, filename, round, kind, error });
}

async function bucketPacket(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  const { results } = await env.DB.prepare(
    'SELECT packet_r2_key, packet_name FROM rounds WHERE tournament_id = ?1 AND number = ?2'
  ).bind(b.tournament_id, b.current_round).all();
  if (!results.length) return err(env, 404, 'no packet for the current round');
  const obj = await env.DATA.get(results[0].packet_r2_key);
  if (!obj) return err(env, 404, 'packet missing');
  return blobResponse(env, obj, results[0].packet_name);
}

/* ---------- public stats API (/pub/*, publish-gated) ---------- */

async function getPublishedTournament(env, slug) {
  const { results } = await env.DB.prepare(
    'SELECT id, slug, name, current_round, roster_r2_key FROM tournaments WHERE slug = ?1 AND published = 1'
  ).bind(slug).all();
  return results[0] || null;
}

async function pubState(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const [files, buckets] = await Promise.all([
    env.DB.prepare(
      "SELECT id, bucket_id, round, filename FROM files WHERE tournament_id = ?1 AND kind = 'qbj' AND error IS NULL ORDER BY round, id"
    ).bind(t.id).all(),
    env.DB.prepare(
      'SELECT id, room_name FROM buckets WHERE tournament_id = ?1'
    ).bind(t.id).all(),
  ]);
  const rooms = Object.fromEntries(buckets.results.map((b) => [b.id, b.room_name]));
  return json(env, {
    name: t.name,
    current_round: t.current_round,
    roster: !!t.roster_r2_key,
    files: files.results.map((f) => ({
      id: f.id, round: f.round, filename: f.filename, room: rooms[f.bucket_id] || null,
    })),
  });
}

async function pubQbj(env, slug, fileId) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const { results } = await env.DB.prepare(
    "SELECT r2_key, filename FROM files WHERE id = ?1 AND tournament_id = ?2 AND kind = 'qbj'"
  ).bind(fileId, t.id).all();
  if (!results.length) return err(env, 404, 'no such file');
  const obj = await env.DATA.get(results[0].r2_key);
  if (!obj) return err(env, 404, 'file missing');
  return blobResponse(env, obj, results[0].filename);
}

async function pubRoster(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  if (!t.roster_r2_key) return err(env, 404, 'no roster');
  const obj = await env.DATA.get(t.roster_r2_key);
  if (!obj) return err(env, 404, 'roster missing');
  return blobResponse(env, obj, 'roster.qbj');
}

/* ---------- router ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // OAuth endpoints are navigations (no auth header yet).
    if (path === '/auth/login' && method === 'GET') return authLogin(url, env);
    if (path === '/auth/callback' && method === 'GET') return authCallback(url, env);

    if (path === '/') return new Response('qb-td: tournament hub backend. See /auth/login.', { status: 200 });

    // Moderator bucket routes — the secret is the credential.
    let m;
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})$/)) && method === 'GET') return bucketState(env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/upload$/)) && method === 'POST') return bucketUpload(request, url, env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/packet$/)) && method === 'GET') return bucketPacket(env, m[1]);

    // Public stats routes — publish-gated inside.
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})$/)) && method === 'GET') return pubState(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/qbj\/(\d+)$/)) && method === 'GET') return pubQbj(env, m[1], Number(m[2]));
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/roster$/)) && method === 'GET') return pubRoster(env, m[1]);

    // Everything under /api and /auth/me requires a session.
    const user = await requireUser(request, env);
    if (!user) return err(env, 401, 'sign in required');

    if (path === '/auth/me' && method === 'GET') {
      return json(env, { uid: user.u, login: user.l, exp: user.exp });
    }

    if (path === '/api/tournaments' && method === 'GET') return listTournaments(env, user);
    if (path === '/api/tournaments' && method === 'POST') return createTournament(request, env, user);

    if ((m = path.match(/^\/api\/tournaments\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'GET') return getTournament(env, user, id);
      if (method === 'POST') return updateTournament(request, env, user, id);
    }
    if ((m = path.match(/^\/api\/tournaments\/(\d+)\/buckets$/)) && method === 'POST') {
      return createBucket(request, env, user, Number(m[1]));
    }
    if ((m = path.match(/^\/api\/tournaments\/(\d+)\/buckets\/(\d+)$/)) && method === 'DELETE') {
      return deleteBucket(env, user, Number(m[1]), Number(m[2]));
    }
    if ((m = path.match(/^\/api\/tournaments\/(\d+)\/packet$/)) && method === 'POST') {
      return uploadPacket(request, url, env, user, Number(m[1]));
    }
    if ((m = path.match(/^\/api\/tournaments\/(\d+)\/roster$/)) && method === 'POST') {
      return uploadRoster(request, url, env, user, Number(m[1]));
    }
    if ((m = path.match(/^\/api\/tournaments\/(\d+)\/file$/)) && method === 'GET') {
      return adminDownload(url, env, user, Number(m[1]));
    }
    if ((m = path.match(/^\/api\/tournaments\/(\d+)\/files\/(\d+)$/)) && method === 'DELETE') {
      return deleteFile(env, user, Number(m[1]), Number(m[2]));
    }

    return err(env, 404, 'not found');
  },
};
