// worker.js — qb-td backend (Cloudflare Worker + D1 + R2). Deploy/setup:
// ../README.md.
//
// No accounts anywhere. Three access levels, three route families, all
// keyed by unguessable link secrets:
//   /a/*    — the TO's admin API. The admin_secret minted at tournament
//             creation is the only credential; it expires 48h after
//             creation (ADMIN_TTL). Creation itself (POST
//             /api/tournaments) is open, rate-limited per IP.
//   /b/*    — the moderator bucket API. The bucket secret in the URL is
//             the credential. Grants upload + packet download for that
//             one room only.
//   /pub/*  — the public stats API. No auth, but only serves tournaments
//             the TO has published, and only match qbj + roster blobs —
//             never packets, never admin metadata, never secrets.
//
// Storage: metadata in D1 (schema.sql), blobs in R2 under t/<tid>/...
// All blob reads stream through the Worker so the publish gate is enforced
// in one place.

// Admin and bucket links die 48h after their row's creation (question
// security: a leaked link stops working soon after the tournament; a
// forgotten one can't be phished later). Published stats stay up — the
// publish flag, not the admin link, gates /pub.
const ADMIN_TTL = 48 * 3600 * 1000;
const BUCKET_TTL = 48 * 3600 * 1000;
// Tournament creation is open; these are griefing backstops.
const CREATE_PER_IP_DAY = 20;
const CREATE_GLOBAL_DAY = 300;
const BUCKET_LIST_LIMIT = 20;            // recent uploads shown to the mod
const MAX_UPLOAD = 8 * 1024 * 1024;      // moderator file cap
const MAX_PACKET = 16 * 1024 * 1024;     // packet cap
const MAX_BUNDLE = 32 * 1024 * 1024;     // combined stats blob cap
const MAX_BUCKETS = 60;
// Sized for one shared bucket carrying a whole tournament (several mods on
// one link, ~2 files per game, re-exports adding rows).
const MAX_FILES_PER_BUCKET = 600;
const MAX_NAME = 120;

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
  if (base.length <= 100) return base || 'file';
  // Long names keep their head, tail, and extension: kind detection and the
  // .qbtd.json rename key off the suffix (".qbj", "_Game.json", ".qbtd.json").
  const ext = (/(?:\.[A-Za-z0-9]{1,8}){1,2}$/.exec(base) || [''])[0];
  const stem = base.slice(0, base.length - ext.length);
  const keep = 100 - ext.length;
  const head = Math.ceil(keep / 2);
  return stem.slice(0, head) + stem.slice(stem.length - (keep - head)) + ext;
}
function cleanName(s) {
  return String(s || '').trim().slice(0, MAX_NAME);
}

// The reader uploads ONE `.qbtd.json` per game: {qbj: <match>, game:
// <MODAQ state>}. The game half holds the full packet text, so only the
// extracted qbj half may ever reach the bundle or a public route.
function extractMatch(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { error: 'not valid JSON' }; }
  if (obj && obj.qbj && typeof obj.qbj === 'object') obj = obj.qbj;
  let match = obj;
  if (match && Array.isArray(match.objects)) {
    match = match.objects.find((o) => o && (o.match_teams || o.matchTeams)) || match;
  }
  const teams = match && (match.match_teams || match.matchTeams);
  if (!Array.isArray(teams) || teams.length !== 2) {
    return { error: 'no match with exactly two match_teams' };
  }
  // qbj: what the bundle stores (an {objects} wrapper is kept as-is —
  // the engine unwraps it — but a combined file contributes only .qbj).
  return { error: null, qbj: obj };
}

/* ---------- combined stats bundle ----------
   t/<tid>/combined.json holds every valid match qbj (raw, with room/round
   metadata) so the public stats page is 2 requests instead of one per
   file. Maintained incrementally on upload/delete with R2 conditional
   writes (retry on concurrent-writer conflict). Derived data: if it ever
   drifts (e.g. writes exhausted retries), the TO dashboard's rebuild
   button re-materializes it from the files themselves. */

async function updateBundle(env, tid, mutate) {
  const key = `t/${tid}/combined.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await env.DATA.get(key);
    let bundle = { entries: [] };
    if (cur) {
      bundle = await cur.json().catch(() => ({ entries: [] }));
      if (!Array.isArray(bundle.entries)) bundle = { entries: [] };
    }
    mutate(bundle);
    const onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    try {
      const put = await env.DATA.put(key, JSON.stringify(bundle), {
        httpMetadata: { contentType: 'application/json' },
        onlyIf,
      });
      if (put) return true;
    } catch (e) { /* precondition failed -> retry */ }
  }
  console.log('bundle update lost the retry race for tournament', tid);
  return false;
}

/* ---------- TO admin API (/a/*, admin-link-authed) ----------
   The router resolves the admin secret and expiry once; every handler
   receives the tournament row `t`. */

async function getAdminTournament(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM tournaments WHERE admin_secret = ?1'
  ).bind(secret).all();
  return results[0] || null;
}
function adminClosed(t) {
  return Date.now() > t.created + ADMIN_TTL;
}

async function createTournament(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const slug = String(body.slug || '').trim().toLowerCase();
  const name = cleanName(body.name);
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
    return err(env, 400, 'slug must be 3-40 chars: a-z, 0-9, hyphens');
  }
  if (!name) return err(env, 400, 'name required');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const since = Date.now() - 24 * 3600 * 1000;
  const { results } = await env.DB.prepare(
    'SELECT SUM(creator_ip = ?1) AS mine, COUNT(*) AS all_ips FROM tournaments WHERE created > ?2'
  ).bind(ip, since).all();
  if ((results[0].mine || 0) >= CREATE_PER_IP_DAY || results[0].all_ips >= CREATE_GLOBAL_DAY) {
    return err(env, 429, 'creation limit reached, try again tomorrow');
  }

  const adminSecret = randToken();
  const created = Date.now();
  try {
    const out = await env.DB.prepare(
      'INSERT INTO tournaments (slug, name, admin_secret, creator_ip, settings, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(slug, name, adminSecret, ip, JSON.stringify(body.settings || {}), created).run();
    return json(env, {
      id: out.meta.last_row_id, slug, name,
      admin_secret: adminSecret, closes: created + ADMIN_TTL,
    });
  } catch (e) {
    return err(env, 409, 'slug already taken');
  }
}

// A leaked admin link mid-tournament: mint a new secret, the old link dies.
async function rotateAdmin(env, t) {
  const adminSecret = randToken();
  await env.DB.prepare(
    'UPDATE tournaments SET admin_secret = ?2 WHERE id = ?1'
  ).bind(t.id, adminSecret).run();
  return json(env, { admin_secret: adminSecret });
}

async function getTournament(env, t) {
  const id = t.id;
  const [buckets, rounds, files] = await Promise.all([
    env.DB.prepare('SELECT id, room_name, secret, created FROM buckets WHERE tournament_id = ?1 ORDER BY id').bind(id).all(),
    env.DB.prepare('SELECT number, packet_name, packet_r2_key FROM rounds WHERE tournament_id = ?1 ORDER BY number').bind(id).all(),
    env.DB.prepare('SELECT id, bucket_id, round, kind, r2_key, filename, size, error, created FROM files WHERE tournament_id = ?1 ORDER BY created DESC').bind(id).all(),
  ]);
  const { admin_secret, creator_ip, ...pub_t } = t;
  return json(env, {
    tournament: { ...pub_t, closes: t.created + ADMIN_TTL },
    buckets: buckets.results,
    rounds: rounds.results,
    files: files.results,
  });
}

async function updateTournament(request, env, t) {
  const id = t.id;
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

async function createBucket(request, env, t) {
  const id = t.id;
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

async function deleteBucket(env, t, bucketId) {
  // Files already uploaded stay downloadable; only the mod's access dies.
  await env.DB.prepare(
    'DELETE FROM buckets WHERE id = ?1 AND tournament_id = ?2'
  ).bind(bucketId, t.id).run();
  return json(env, { ok: true });
}

async function uploadPacket(request, url, env, t) {
  const id = t.id;
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

async function uploadRoster(request, url, env, t) {
  const id = t.id;
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

async function adminDownload(url, env, t) {
  const key = url.searchParams.get('key') || '';
  // Ownership boundary: only this tournament's prefix is reachable.
  if (!key.startsWith(`t/${t.id}/`)) return err(env, 403, 'bad key');
  const obj = await env.DATA.get(key);
  if (!obj) return err(env, 404, 'no such file');
  return blobResponse(env, obj, url.searchParams.get('dl') || key.split('/').pop());
}

async function deleteFile(env, t, fileId) {
  const id = t.id;
  const { results } = await env.DB.prepare(
    'SELECT r2_key, kind, error FROM files WHERE id = ?1 AND tournament_id = ?2'
  ).bind(fileId, id).all();
  if (!results.length) return err(env, 404, 'no such file');
  await env.DATA.delete(results[0].r2_key);
  await env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(fileId).run();
  if ((results[0].kind === 'qbj' || results[0].kind === 'combined') && !results[0].error) {
    await updateBundle(env, id, (bundle) => {
      bundle.entries = bundle.entries.filter((e) => e.id !== fileId);
    });
  }
  return json(env, { ok: true });
}

// Escape hatch for bundle drift: the dashboard re-materializes the bundle
// from the files it already fetched and posts it whole.
async function putBundle(request, env, t) {
  const id = t.id;
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BUNDLE) return err(env, 413, 'bundle too large');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return err(env, 400, 'bad json'); }
  if (!parsed || !Array.isArray(parsed.entries)) return err(env, 400, 'bad bundle');
  await env.DATA.put(`t/${id}/combined.json`, body, {
    httpMetadata: { contentType: 'application/json' },
  });
  return json(env, { entries: parsed.entries.length });
}

/* ---------- moderator bucket API (/b/*, secret-authed) ---------- */

async function getBucketRow(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT b.id, b.room_name, b.created, b.tournament_id, t.name AS tournament_name, ' +
    't.current_round, t.roster_r2_key, t.settings ' +
    'FROM buckets b JOIN tournaments t ON t.id = b.tournament_id WHERE b.secret = ?1'
  ).bind(secret).all();
  return results[0] || null;
}

// 410 keeps "expired" distinct from "never existed" so the mod's page can
// say "room closed" instead of "bad link".
function bucketClosed(b) {
  return Date.now() > b.created + BUCKET_TTL;
}

async function bucketState(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  const [packet, uploads, count] = await Promise.all([
    env.DB.prepare(
      'SELECT number, packet_name FROM rounds WHERE tournament_id = ?1 AND number = ?2'
    ).bind(b.tournament_id, b.current_round).all(),
    env.DB.prepare(
      'SELECT id, round, kind, filename, size, error, created FROM files WHERE bucket_id = ?1 ORDER BY created DESC LIMIT ?2'
    ).bind(b.id, BUCKET_LIST_LIMIT).all(),
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM files WHERE bucket_id = ?1'
    ).bind(b.id).all(),
  ]);
  let settings = {};
  try { settings = JSON.parse(b.settings) || {}; } catch (e) { /* keep {} */ }
  return json(env, {
    tournament: b.tournament_name,
    room: b.room_name,
    current_round: b.current_round,
    closes: b.created + BUCKET_TTL,
    packet: packet.results[0] || null,
    roster: !!b.roster_r2_key,
    settings,
    uploads: uploads.results,
    upload_count: count.results[0].n,
  });
}

async function bucketUpload(request, url, env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');

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
  const isCombined = /\.qbtd\.json$/i.test(filename);
  const kind = isQbj ? 'qbj' : isCombined ? 'combined' : /_game\.json$/i.test(filename) ? 'game' : 'other';
  let error = null;
  let qbjObj = null;
  if (isQbj || isCombined) {
    const parsed = extractMatch(new TextDecoder().decode(buf));
    error = parsed.error;
    qbjObj = parsed.qbj || null;
  }

  const key = `t/${b.tournament_id}/bucket/${b.id}/${randToken(8)}-${filename}`;
  await env.DATA.put(key, buf, { httpMetadata: { contentType: 'application/json' } });
  const out = await env.DB.prepare(
    'INSERT INTO files (tournament_id, bucket_id, round, kind, r2_key, filename, size, error, created) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(b.tournament_id, b.id, round, kind, key, filename, buf.byteLength, error, Date.now()).run();
  const fileId = out.meta.last_row_id;

  if (qbjObj && !error) {
    await updateBundle(env, b.tournament_id, (bundle) => {
      bundle.entries = bundle.entries.filter((e) => e.id !== fileId);
      bundle.entries.push({
        id: fileId, round, room: b.room_name, filename, qbj: qbjObj,
      });
    });
  }
  return json(env, { id: fileId, filename, round, kind, error });
}

async function bucketPacket(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  const { results } = await env.DB.prepare(
    'SELECT packet_r2_key, packet_name FROM rounds WHERE tournament_id = ?1 AND number = ?2'
  ).bind(b.tournament_id, b.current_round).all();
  if (!results.length) return err(env, 404, 'no packet for the current round');
  const obj = await env.DATA.get(results[0].packet_r2_key);
  if (!obj) return err(env, 404, 'packet missing');
  return blobResponse(env, obj, results[0].packet_name);
}

// The reader page (read.html) preloads the roster into its embedded MODAQ so
// the mod only picks teams. Same credential + lifetime rules as the packet.
async function bucketRoster(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  if (!b.roster_r2_key) return err(env, 404, 'no roster');
  const obj = await env.DATA.get(b.roster_r2_key);
  if (!obj) return err(env, 404, 'roster missing');
  return blobResponse(env, obj, 'roster.qbj');
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
      "SELECT id, bucket_id, round, filename FROM files WHERE tournament_id = ?1 AND kind IN ('qbj', 'combined') AND error IS NULL ORDER BY round, id"
    ).bind(t.id).all(),
    env.DB.prepare(
      'SELECT id, room_name FROM buckets WHERE tournament_id = ?1'
    ).bind(t.id).all(),
  ]);
  const rooms = Object.fromEntries(buckets.results.map((b) => [b.id, b.room_name]));
  const rows = files.results;
  return json(env, {
    name: t.name,
    current_round: t.current_round,
    roster: !!t.roster_r2_key,
    // Stats only change when a file lands (or is deleted): clients compare
    // this stamp and refetch the bundle only when it moves.
    version: (rows.length ? rows[rows.length - 1].id : 0) + ':' + rows.length,
    files: rows.map((f) => ({
      id: f.id, round: f.round, filename: f.filename, room: rooms[f.bucket_id] || null,
    })),
  });
}

async function pubBundle(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const obj = await env.DATA.get(`t/${t.id}/combined.json`);
  if (!obj) return err(env, 404, 'no bundle');
  return blobResponse(env, obj, null);
}

async function pubQbj(env, slug, fileId) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const { results } = await env.DB.prepare(
    "SELECT r2_key, filename, kind FROM files WHERE id = ?1 AND tournament_id = ?2 AND kind IN ('qbj', 'combined')"
  ).bind(fileId, t.id).all();
  if (!results.length) return err(env, 404, 'no such file');
  const obj = await env.DATA.get(results[0].r2_key);
  if (!obj) return err(env, 404, 'file missing');
  if (results[0].kind !== 'combined') return blobResponse(env, obj, results[0].filename);
  // A combined file's game half carries the full packet text — the public
  // route serves only the extracted qbj half.
  const parsed = extractMatch(await obj.text());
  if (parsed.error) return err(env, 404, 'file unreadable');
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'application/json');
  headers.set('Content-Disposition',
    `attachment; filename="${results[0].filename.replace(/\.qbtd\.json$/i, '.qbj').replace(/["\\\r\n]/g, '_')}"`);
  return new Response(JSON.stringify(parsed.qbj), { status: 200, headers });
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

    if (path === '/') return new Response('qb-td: tournament hub backend.', { status: 200 });

    // Moderator bucket routes — the secret is the credential.
    let m;
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})$/)) && method === 'GET') return bucketState(env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/upload$/)) && method === 'POST') return bucketUpload(request, url, env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/packet$/)) && method === 'GET') return bucketPacket(env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/roster$/)) && method === 'GET') return bucketRoster(env, m[1]);

    // Public stats routes — publish-gated inside.
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})$/)) && method === 'GET') return pubState(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/bundle$/)) && method === 'GET') return pubBundle(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/qbj\/(\d+)$/)) && method === 'GET') return pubQbj(env, m[1], Number(m[2]));
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/roster$/)) && method === 'GET') return pubRoster(env, m[1]);

    // Open (rate-limited) tournament creation; the response carries the
    // admin secret, shown to the TO exactly once by the dashboard.
    if (path === '/api/tournaments' && method === 'POST') return createTournament(request, env);

    // Admin routes — the admin secret is the credential, and it expires.
    if ((m = path.match(/^\/a\/([a-z0-9]{10,40})(\/.*)?$/))) {
      const t = await getAdminTournament(env, m[1]);
      if (!t) return err(env, 404, 'bad link');
      if (adminClosed(t)) return err(env, 410, 'tournament closed');
      const sub = m[2] || '';
      let mm;
      if (sub === '' && method === 'GET') return getTournament(env, t);
      if (sub === '' && method === 'POST') return updateTournament(request, env, t);
      if (sub === '/rotate' && method === 'POST') return rotateAdmin(env, t);
      if (sub === '/buckets' && method === 'POST') return createBucket(request, env, t);
      if ((mm = sub.match(/^\/buckets\/(\d+)$/)) && method === 'DELETE') return deleteBucket(env, t, Number(mm[1]));
      if (sub === '/packet' && method === 'POST') return uploadPacket(request, url, env, t);
      if (sub === '/roster' && method === 'POST') return uploadRoster(request, url, env, t);
      if (sub === '/file' && method === 'GET') return adminDownload(url, env, t);
      if ((mm = sub.match(/^\/files\/(\d+)$/)) && method === 'DELETE') return deleteFile(env, t, Number(mm[1]));
      if (sub === '/bundle' && method === 'POST') return putBundle(request, env, t);
    }

    return err(env, 404, 'not found');
  },
};
