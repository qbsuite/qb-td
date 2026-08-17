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
// in one place. Question-text blobs are encrypted at rest under a
// per-tournament key that only the link secrets can unwrap, and the
// secrets themselves are stored hashed — see "question text encryption".

// Admin and bucket links die 48h after their row's creation (question
// security: a leaked link stops working soon after the tournament; a
// forgotten one can't be phished later). Published stats stay up — the
// publish flag, not the admin link, gates /pub.
const ADMIN_TTL = 48 * 3600 * 1000;
const BUCKET_TTL = 48 * 3600 * 1000;
// A tournament's data is provably final once every write path is dead.
// Rooms can only be created while the admin link lives (ADMIN_TTL), and a
// room accepts uploads for BUCKET_TTL after its own creation, so the last
// possible upload lands at created + ADMIN_TTL + BUCKET_TTL. From then on
// /pub answers can be cached hard: the long tail of finished tournaments
// costs one request per visitor, and a return visit costs none.
const FINAL_TTL = ADMIN_TTL + BUCKET_TTL;
// Live state may be re-served briefly to anything that caches it. The
// public page deliberately revalidates past this (pubview.js) so its
// refresh button can't no-op; the value is here for other /pub consumers
// and for a future CDN in front of the Worker.
const PUB_CACHE_LIVE = 60;               // seconds
const PUB_CACHE_FINAL = 7 * 24 * 3600;   // results can no longer move
// Tournament creation is open; these are griefing backstops.
const CREATE_PER_IP_DAY = 20;
const CREATE_GLOBAL_DAY = 300;
const BUCKET_LIST_LIMIT = 20;            // recent uploads shown to the mod
const MAX_UPLOAD = 8 * 1024 * 1024;      // moderator file cap
const MAX_PACKET = 16 * 1024 * 1024;     // packet cap
const MAX_BUNDLE = 32 * 1024 * 1024;     // combined stats blob cap
const MAX_SCHEDULE = 256 * 1024;         // schedule blob cap
const MAX_BUCKETS = 60;
// Sized for one shared bucket carrying a whole tournament (several mods on
// one link, ~2 files per game, re-exports adding rows).
const MAX_FILES_PER_BUCKET = 600;
const MAX_NAME = 120;
const MAX_ANNOUNCE = 8;                  // live broadcasts per tournament
const MAX_ANNOUNCE_TEXT = 200;
const MAX_ANNOUNCE_JSON = 2048;
const MAX_TB_BLOB = 8 * 1024 * 1024;     // tiebreaker pool blob cap
const MAX_TB_USES = 500;                 // usage log cap (griefing backstop)

/* ---------- responses ---------- */
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}
function json(env, data, status = 200, cacheSeconds = 0) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(env) };
  if (cacheSeconds) headers['Cache-Control'] = 'public, max-age=' + cacheSeconds;
  return new Response(JSON.stringify(data), { status, headers });
}
function err(env, status, message) { return json(env, { error: message }, status); }

function blobResponse(env, r2obj, filename, cacheSeconds = 0) {
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', r2obj.httpMetadata?.contentType || 'application/octet-stream');
  if (filename) {
    headers.set('Content-Disposition',
      `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`);
  }
  // slow-moving public blobs let the browser self-serve on refresh spam
  if (cacheSeconds) headers.set('Cache-Control', 'public, max-age=' + cacheSeconds);
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

/* ---------- question text encryption ----------
   Question-text blobs (packets, the tiebreaker pool, moderator game
   uploads) are encrypted at rest with a random per-tournament content
   key, and that key is stored only WRAPPED under keys derived from the
   link secrets — which are themselves stored only as SHA-256 hashes. So
   neither R2 nor D1 at rest can produce question text: every request
   that legitimately needs plaintext carries a secret in its URL (or the
   buzzpoints derived key in its Authorization header), and the Worker
   unwraps the content key per request, in memory only.

   What this is and is not: it makes question text unreadable to anyone
   browsing the bucket or database (operator included), and once a
   tournament's links expire the text is cryptographically gone even
   though the blobs remain. It does NOT defend against a malicious
   operator modifying the running Worker to capture secrets in flight —
   nothing can, since the Worker must produce plaintext for moderators.

   Mechanics: tournaments carry admin_wrap (content key wrapped under
   the admin secret) and buzz_wrap (wrapped under the buzzpoints derived
   key, written when the TO sets a password — the dashboard sends the
   derived token once, purely for wrapping); each bucket carries wrap
   (wrapped under its own secret). Credential columns hold SHA-256 of
   the secret on new rows (64 hex chars; real secrets are 10-40 chars,
   so lookups check both forms and the two can never collide). Encrypted
   R2 objects are AES-256-GCM (iv || ciphertext) marked with
   customMetadata {enc: '1', ct: <original content type>}; blobs without
   the marker are legacy plaintext and serve as before. Rows without
   admin_wrap are legacy throughout — the 48h TTL ages them out of every
   write path within two days of the migration (migrate-crypt.sql).

   Public blobs (bundle, schedule, catmap, roster) stay plaintext by
   design: they are text-free and the whole point is serving them
   without credentials. The cron publisher holds no secrets and needs
   none. */

const enc8 = (s) => new TextEncoder().encode(s);
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// What credential columns store for new rows. Domain-separated so the
// stored value can't double as anything else derived from the secret.
function secretHash(secret) {
  return sha256Hex('qbtd-cred:' + secret);
}

// AES-GCM key-encryption key for one role ('admin' | 'bucket' | 'buzz')
// of one secret. HKDF, not PBKDF2: link secrets are ~99-bit random
// values, so stretching would cost CPU and buy nothing.
async function deriveKek(secret, role) {
  const ikm = await crypto.subtle.importKey('raw', enc8(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc8('qb-td-wrap-v1'), info: enc8(role) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function aesEncrypt(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return out;
}
async function aesDecrypt(key, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12));
}

// wrap/unwrap the raw 32-byte content key under a secret-derived KEK
async function wrapKey(secret, role, rawKey) {
  return b64bytes(await aesEncrypt(await deriveKek(secret, role), rawKey));
}
async function unwrapKey(secret, role, wrapped) {
  return new Uint8Array(await aesDecrypt(await deriveKek(secret, role), b64ToBytes(wrapped)));
}

function contentKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// A short string encrypted under the content key, for D1 columns that
// must be readable back through a link but not from the database alone
// (buckets.secret_enc: the room secret, which the TO's dashboard renders
// as the room's links — its credential column holds only the hash).
async function encField(rawKey, text) {
  return b64bytes(await aesEncrypt(await contentKey(rawKey), enc8(text)));
}
async function decField(rawKey, b64) {
  return new TextDecoder().decode(await aesDecrypt(await contentKey(rawKey), b64ToBytes(b64)));
}

function blobEnc(r2obj) {
  return (r2obj.customMetadata || {}).enc === '1';
}

// R2 put that encrypts when the tournament has a content key. `opts`
// may carry onlyIf (conditional writes keep working — the etag guards
// the ciphertext exactly as it would the plaintext) and customMetadata.
async function putBlob(env, key, body, contentType, rawKey, opts = {}) {
  if (!rawKey) {
    return env.DATA.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: opts.customMetadata,
      onlyIf: opts.onlyIf,
    });
  }
  return env.DATA.put(key, await aesEncrypt(await contentKey(rawKey), typeof body === 'string' ? enc8(body) : new Uint8Array(body)), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { ...(opts.customMetadata || {}), enc: '1', ct: contentType },
    onlyIf: opts.onlyIf,
  });
}

// The blob's plaintext bytes, whichever way it is stored. An encrypted
// blob with no key available is a caller bug (the routes that reach one
// always hold a secret); GCM auth failure on a wrong key throws.
async function readBlob(r2obj, rawKey) {
  const buf = await r2obj.arrayBuffer();
  if (!blobEnc(r2obj)) return buf;
  return aesDecrypt(await contentKey(rawKey), buf);
}

// blobResponse for maybe-encrypted objects.
async function blobResponseDec(env, r2obj, rawKey, filename, cacheSeconds = 0) {
  if (!blobEnc(r2obj)) return blobResponse(env, r2obj, filename, cacheSeconds);
  const buf = await readBlob(r2obj, rawKey);
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', (r2obj.customMetadata || {}).ct || 'application/octet-stream');
  if (filename) {
    headers.set('Content-Disposition',
      `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`);
  }
  if (cacheSeconds) headers.set('Cache-Control', 'public, max-age=' + cacheSeconds);
  return new Response(buf, { status: 200, headers });
}

// The reader uploads ONE `.qbtd.json` per game: {qbj: <match>, game:
// <MODAQ state>, tb?: {used: [ids]}}. The game half holds the full packet
// text, so only the extracted qbj half may ever reach the bundle or a
// public route. `teams` (the two team names) and `root` (for the tb
// field) ride along for the tiebreaker usage log.
function extractMatch(text) {
  let root;
  try { root = JSON.parse(text); } catch (e) { return { error: 'not valid JSON' }; }
  let obj = root;
  if (obj && obj.qbj && typeof obj.qbj === 'object') obj = obj.qbj;
  let match = obj;
  if (match && Array.isArray(match.objects)) {
    match = match.objects.find((o) => o && (o.match_teams || o.matchTeams)) || match;
  }
  const teams = match && (match.match_teams || match.matchTeams);
  if (!Array.isArray(teams) || teams.length !== 2) {
    return { error: 'no match with exactly two match_teams' };
  }
  const names = teams.map((mt) => {
    const t = mt && mt.team;
    return typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : '');
  });
  // qbj: what the bundle stores (an {objects} wrapper is kept as-is —
  // the engine unwraps it — but a combined file contributes only .qbj).
  return { error: null, qbj: obj, root, teams: names };
}

// MODAQ writes protest reasons — moderator free text that routinely
// quotes answers — verbatim into the match's `notes`. Nothing public
// renders notes, so every public copy of a qbj (the bundle, and /pub
// qbj downloads served from it) drops the field; the TO's admin
// downloads keep it for the .yft. Mutates and returns its argument.
function stripMatchNotes(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  delete obj.notes;
  if (Array.isArray(obj.objects)) {
    for (const o of obj.objects) {
      if (o && typeof o === 'object') delete o.notes;
    }
  }
  return obj;
}

/* ---------- broadcasts ----------
   The TO's short messages to the public page and/or the moderator rooms.
   They live as one JSON array on the tournament row so they ride along on
   requests both surfaces already make (/pub/:slug, /b/:secret) — no new
   route, no new blob, and nothing starts polling that wasn't already.

   Every message carries an expiry, and it is not optional: the admin link
   dies 48h after creation while the published page outlives it, so a
   message with no end would strand "lunch at 12:15" on a finished
   tournament with nobody left who can take it down. */

// Whole-list write (POST /a/:secret with `announce`), same idiom as
// settings. Returns {error} or {json} ready to bind.
function cleanAnnounce(list, t) {
  if (!Array.isArray(list)) return { error: 'bad announce' };
  if (list.length > MAX_ANNOUNCE) return { error: `too many broadcasts (${MAX_ANNOUNCE} max)` };
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') return { error: 'bad broadcast' };
    const text = String(a.text ?? '').trim().slice(0, MAX_ANNOUNCE_TEXT);
    if (!text) return { error: 'broadcast text required' };
    const toPub = !!a.pub;
    let rooms = false;
    if (a.rooms === true) rooms = true;
    else if (Array.isArray(a.rooms)) {
      rooms = [...new Set(a.rooms.map(Number).filter((n) => Number.isInteger(n)))]
        .slice(0, MAX_BUCKETS);
      if (!rooms.length) rooms = false;
    }
    if (!toPub && rooms === false) return { error: 'broadcast needs an audience' };
    const created = Number.isInteger(a.created) ? a.created : Date.now();
    const expires = Number(a.expires);
    if (!Number.isInteger(expires)) return { error: 'broadcast needs an expiry' };
    out.push({
      id: /^[a-z0-9]{1,16}$/.test(String(a.id || '')) ? String(a.id) : randToken(6),
      text,
      level: a.level === 'alert' ? 'alert' : 'note',
      pub: toPub,
      rooms,
      created,
      // never past the tournament's own close
      expires: Math.min(expires, t.created + ADMIN_TTL),
    });
  }
  const json = JSON.stringify(out);
  if (json.length > MAX_ANNOUNCE_JSON) return { error: 'broadcasts too large' };
  return { error: null, json };
}

function parseAnnounce(row) {
  let list;
  try { list = JSON.parse(row.announce || '[]'); } catch (e) { return []; }
  return Array.isArray(list) ? list.filter((a) => a && typeof a === 'object') : [];
}

// What a viewer gets: text and level, never the audience — a room has no
// business learning that a message also went to the public page, or to
// which other rooms. Alerts first, then newest first. A message with no
// usable expiry is already gone (fail closed).
function visibleAnnounce(list) {
  const now = Date.now();
  return list
    .filter((a) => Number(a.expires) > now)
    .map((a) => ({ id: a.id, text: a.text, level: a.level, created: a.created }))
    .sort((x, y) => (x.level === y.level
      ? y.created - x.created
      : x.level === 'alert' ? -1 : 1));
}
function pubAnnounce(row) {
  return visibleAnnounce(parseAnnounce(row).filter((a) => a.pub));
}
function roomAnnounce(row, bucketId) {
  return visibleAnnounce(parseAnnounce(row).filter((a) =>
    a.rooms === true || (Array.isArray(a.rooms) && a.rooms.includes(bucketId))));
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

/* ---------- public snapshots on GitHub (optional) ----------
   Moves the audience-scaling bytes off the Worker: every blob the public
   page refetches when stamps move (bundle / schedule / cats / roster) is
   also published to a GitHub data repo, one atomic commit per change,
   and /pub/:slug advertises the commit SHA. The page then fetches
   raw.githubusercontent.com/<repo>/<sha>/<slug>/*.json — SHA-pinned raw
   URLs are immutable (no CDN staleness) and don't touch the Worker, so
   viewer count stops mattering to the request budget.

   The small stuff stays here on purpose. /pub/:slug is one response per
   page view — the page does not poll — so serving it from the Worker
   costs almost nothing and, unlike a branch-head raw URL (mutable,
   ~5-minute CDN cache), it is never stale: a refresh shows results as
   soon as the cron has committed them. It also keeps what must stay
   gated (buzzpoints packet text — password-checked per request, must
   never sit in a public repo), and answers every published route as the
   snapshot's fallback.

   Mechanics: mutations set tournaments.pub_dirty (markPub); a 1-minute
   cron publishes dirty published tournaments — cron serializes the
   commits, so simultaneous room uploads can't race two commits against
   each other — and retracts dirty unpublished ones (deletes the slug's
   folder from the branch head; nothing points at it once /pub/:slug
   stops advertising the sha, so this is tidiness, not correctness).
   The publisher claims (dirty=0) before it works and restores the flag
   on failure, so a mutation landing mid-publish just schedules the next
   one. pub_snapshot records what the last commit contained — the
   per-blob stamps mirror pubState's, so the client's
   refetch-on-stamp-move logic works identically either way. Only blobs
   are published, so a mutation that changes nothing a blob holds (a
   broadcast, the round number) needs no publish at all — it reaches
   viewers through /pub/:slug on their next refresh.

   Config (all optional — with SNAPSHOT_REPO unset this whole section is
   dead code): SNAPSHOT_REPO ("owner/repo") + SNAPSHOT_BRANCH vars, and a
   GitHub credential with contents:write on that one repo — either a
   GitHub App (GITHUB_APP_ID + GITHUB_INSTALLATION_ID vars,
   GITHUB_APP_KEY secret holding the PKCS#8 private key) or a
   fine-grained PAT (GITHUB_TOKEN secret). Apply migrate-pub.sql first.
   Setup: ../README.md ("Public snapshots on GitHub"). */

// Bundles above this stay Worker-served (snapshot skips them, the page
// falls back): base64 + commit of a huge blob isn't worth the CPU, and
// tournaments that big are rare.
const PUB_MAX_SNAPSHOT = 12 * 1024 * 1024;

function snapshotsEnabled(env) {
  return Boolean(env.SNAPSHOT_REPO
    && (env.GITHUB_TOKEN || (env.GITHUB_APP_KEY && env.GITHUB_APP_ID && env.GITHUB_INSTALLATION_ID)));
}

// Flag a tournament for the next cron publish. Called from every
// mutation that changes a snapshotted blob; a cheap single UPDATE, so
// it's just awaited inline.
async function markPub(env, tid) {
  if (!snapshotsEnabled(env)) return;
  await env.DB.prepare('UPDATE tournaments SET pub_dirty = 1 WHERE id = ?1').bind(tid).run();
}

// The stats stamp, shared verbatim between pubState and the publisher so
// the page's refetch logic can't tell the two sources apart.
function statsVersion(rows) {
  return (rows.length ? rows[rows.length - 1].id : 0) + ':' + rows.length;
}

/* ----- GitHub auth: App installation token (preferred) or PAT ----- */

let ghTokenCache = null; // { token, expiresAt } — per-isolate

function b64bytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function githubToken(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (ghTokenCache && Date.now() < ghTokenCache.expiresAt) return ghTokenCache.token;
  const pem = env.GITHUB_APP_KEY.replace(/-----[A-Z ]+-----|\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const b64url = (b) => b64bytes(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(enc.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(header + '.' + payload));
  const jwt = header + '.' + payload + '.' + b64url(sig);
  const data = await github(env, 'POST',
    `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, undefined, jwt);
  ghTokenCache = { token: data.token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return data.token;
}

async function github(env, method, path, body, bearer) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: `Bearer ${bearer || await githubToken(env)}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qb-td-snapshots',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`github ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/* ----- the publisher ----- */

// One commit of [path, body, hadBefore] entries onto the branch head:
// body is bytes to write, null means delete — but only when hadBefore
// says the path was actually committed before, so sha:null can't point
// at paths that never existed. A concurrent writer (overlapping cron,
// manual push to the data repo) makes the ref update non-fast-forward;
// retry from a fresh head once. Returns the new commit sha, or the
// unchanged head when nothing needed committing.
async function commitFiles(env, message, entries) {
  const repo = env.SNAPSHOT_REPO;
  const branch = env.SNAPSHOT_BRANCH || 'main';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await github(env, 'GET', `/repos/${repo}/git/ref/heads/${branch}`);
    const head = ref ? ref.object.sha : null;
    const baseTree = head
      ? (await github(env, 'GET', `/repos/${repo}/git/commits/${head}`)).tree.sha
      : undefined;

    const tree = [];
    for (const [path, body, hadBefore] of entries) {
      if (body !== null) {
        const blob = await github(env, 'POST', `/repos/${repo}/git/blobs`,
          { content: b64bytes(body), encoding: 'base64' });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      } else if (hadBefore && head) {
        tree.push({ path, mode: '100644', type: 'blob', sha: null });
      }
    }
    if (!tree.length) return head; // nothing to commit (or delete)

    const newTree = await github(env, 'POST', `/repos/${repo}/git/trees`,
      baseTree ? { base_tree: baseTree, tree } : { tree });
    const commit = await github(env, 'POST', `/repos/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: head ? [head] : [],
    });
    try {
      if (head) {
        await github(env, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha });
      } else {
        await github(env, 'POST', `/repos/${repo}/git/refs`,
          { ref: `refs/heads/${branch}`, sha: commit.sha });
      }
      return commit.sha;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  return null; // unreachable: attempt 1 either returned or threw
}

// Gather one tournament's publishable blobs. Returns { entries, snapOf }:
// entries feed the tick's shared batch commit, and snapOf(batchSha)
// builds the descriptor that pub_snapshot stores and /pub/:slug
// advertises — { sha, at, version, schedule, cats, roster, roster_at,
// bundle, branch, state } — once the batch's commit sha is known. Stamps
// mirror pubState, booleans say which files the branch actually holds
// (the page falls back to the Worker route for anything absent).
async function buildPublish(env, t) {
  const prev = (() => {
    try { return JSON.parse(t.pub_snapshot) || null; } catch (e) { return null; }
  })();

  // Same query ordering as pubState so the stamps agree.
  const [files, bundleObj, schedObj, catsObj, rosterObj] = await Promise.all([
    env.DB.prepare(
      "SELECT id FROM files WHERE tournament_id = ?1 AND kind IN ('qbj', 'combined') AND error IS NULL ORDER BY round, id"
    ).bind(t.id).all(),
    env.DATA.get(`t/${t.id}/combined.json`),
    env.DATA.get(`t/${t.id}/schedule.json`),
    env.DATA.get(`t/${t.id}/catmap.json`),
    t.roster_r2_key ? env.DATA.get(t.roster_r2_key) : null,
  ]);

  // cats: same non-empty rule as pubState — an empty backfill marker
  // keeps the tab hidden, so it isn't published either.
  let catsStamp = null;
  let catsBody = null;
  if (catsObj) {
    const buf = await catsObj.arrayBuffer();
    const parsed = (() => {
      try { return JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return null; }
    })();
    if (parsed && parsed.rounds && Object.keys(parsed.rounds).length) {
      catsStamp = catsObj.uploaded.getTime();
      catsBody = buf;
    }
  }
  const bundleBody = bundleObj ? await bundleObj.arrayBuffer() : null;
  const bundleOk = bundleBody !== null && bundleBody.byteLength <= PUB_MAX_SNAPSHOT;

  const version = statsVersion(files.results);
  const schedStamp = schedObj ? schedObj.uploaded.getTime() : null;
  const rosterStamp = rosterObj ? rosterObj.uploaded.getTime() : null;

  // A blob whose stamp matches the last publish is already at the branch
  // head (base_tree carries it forward), so re-uploading it only spends
  // GitHub API calls — the difference between a broadcast-only republish
  // costing 6 calls and 13, and what keeps a 30-tournament day under the
  // App's 5,000/hour rate limit. Skips need prev.sha: without a prior
  // commit the stamps have nothing on the branch to vouch for.
  const had = {
    bundle: prev && prev.bundle,
    schedule: prev && prev.schedule !== null && prev.schedule !== undefined,
    cats: prev && prev.cats !== null && prev.cats !== undefined,
    roster: prev && prev.roster,
  };
  const same = prev && prev.sha ? {
    bundle: had.bundle && prev.version === version,
    schedule: had.schedule && prev.schedule === schedStamp,
    cats: had.cats && prev.cats === catsStamp,
    roster: had.roster && prev.roster_at === rosterStamp,
  } : {};
  const entries = [];
  const want = (name, body, key) => {
    if (body !== null) { if (!same[key]) entries.push([`${t.slug}/${name}`, body, false]); }
    else if (had[key]) entries.push([`${t.slug}/${name}`, null, true]);
  };
  want('bundle.json', bundleOk ? bundleBody : null, 'bundle');
  want('schedule.json', schedObj ? await schedObj.arrayBuffer() : null, 'schedule');
  want('cats.json', catsBody, 'cats');
  want('roster.json', rosterObj ? await rosterObj.arrayBuffer() : null, 'roster');

  return {
    entries,
    snapOf: (batchSha) => {
      // Nothing of this tournament's in the batch: keep advertising the
      // commit that already holds its blobs (any commit whose tree
      // contains them serves; the last one recorded certainly does).
      const sha = entries.length === 0 && prev && prev.sha ? prev.sha : batchSha;
      return {
        sha,
        at: Date.now(),
        version,
        schedule: schedStamp,
        cats: catsStamp,
        roster: Boolean(rosterObj),
        roster_at: rosterStamp,
        bundle: bundleOk && sha !== null,
      };
    },
  };
}

// Unpublish: deletion entries that remove the slug's folder from the
// branch head, so the page's GitHub poll stops finding it (SHA-pinned
// history keeps old commits fetchable, but nothing advertises them any
// more). Only paths the last descriptor recorded are deleted.
function retractEntries(t) {
  let prev = null;
  try { prev = JSON.parse(t.pub_snapshot) || null; } catch (e) { /* nothing recorded */ }
  return [
    [`${t.slug}/bundle.json`, null, prev && prev.bundle],
    [`${t.slug}/schedule.json`, null, prev && prev.schedule !== null && prev.schedule !== undefined],
    [`${t.slug}/cats.json`, null, prev && prev.cats !== null && prev.cats !== undefined],
    [`${t.slug}/roster.json`, null, prev && prev.roster],
  ];
}

// Cron tick: publish dirty published tournaments — and retract dirty
// unpublished ones that still have a snapshot on the branch — a few per
// minute so a tick stays bounded (the rest carry their flag to the next
// tick). The whole tick is ONE commit regardless of tournament count: a
// single batch of every tournament's changed blobs and retractions.
// Per-tournament commits would spend the ~10-call Git-Data-API overhead
// once per tournament; batching spends it once per tick, which is what
// keeps a fully loaded cron inside GitHub's 5,000 requests/hour App
// limit.
async function publishDirty(env) {
  if (!snapshotsEnabled(env)) return;
  const { results } = await env.DB.prepare(
    'SELECT * FROM tournaments WHERE pub_dirty = 1 AND (published = 1 OR pub_snapshot IS NOT NULL) ORDER BY created DESC LIMIT 4'
  ).all();
  if (!results.length) return;
  const reflag = (id) =>
    env.DB.prepare('UPDATE tournaments SET pub_dirty = 1 WHERE id = ?1').bind(id).run();
  // Claim before working: a mutation mid-publish re-sets the flag and
  // the next tick picks it up, instead of the clear losing its write.
  for (const t of results) {
    await env.DB.prepare('UPDATE tournaments SET pub_dirty = 0 WHERE id = ?1').bind(t.id).run();
  }

  const pubs = [];     // { t, entries, snapOf }
  const retracts = []; // { t, entries }
  for (const t of results) {
    try {
      if (t.published) pubs.push({ t, ...(await buildPublish(env, t)) });
      else retracts.push({ t, entries: retractEntries(t) });
    } catch (e) {
      console.log('snapshot build failed for', t.slug, e.message);
      await reflag(t.id);
    }
  }
  if (!pubs.length && !retracts.length) return;

  try {
    const batch = [...pubs, ...retracts].flatMap((p) => p.entries);
    const message = [
      pubs.length ? 'publish ' + pubs.map((p) => p.t.slug).join(', ') : '',
      retracts.length ? 'unpublish ' + retracts.map((r) => r.t.slug).join(', ') : '',
    ].filter(Boolean).join('; ');
    const batchSha = batch.length ? await commitFiles(env, message, batch) : null;

    // Record what each tournament's blobs now are, so /pub/:slug can
    // advertise the sha and the page's stamp comparisons line up with
    // what the branch actually holds.
    const snaps = pubs.map((p) => ({ t: p.t, snap: p.snapOf(batchSha) }));
    for (const { t, snap } of snaps) {
      await env.DB.prepare('UPDATE tournaments SET pub_snapshot = ?2 WHERE id = ?1')
        .bind(t.id, JSON.stringify(snap)).run();
    }
    for (const r of retracts) {
      await env.DB.prepare('UPDATE tournaments SET pub_snapshot = NULL WHERE id = ?1')
        .bind(r.t.id).run();
    }
  } catch (e) {
    console.log('snapshot batch failed:', e.message);
    for (const p of [...pubs, ...retracts]) await reflag(p.t.id);
  }
}

/* ---------- TO admin API (/a/*, admin-link-authed) ----------
   The router resolves the admin secret and expiry once; every handler
   receives the tournament row `t`. */

// Resolve an admin link. New rows store the secret's hash (and match on
// it); legacy rows match on the raw value. When the row carries
// admin_wrap, the raw secret from the URL unwraps the content key onto
// t.ckey — per request, in memory only; getTournament strips it.
async function getAdminTournament(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM tournaments WHERE admin_secret = ?1 OR admin_secret = ?2'
  ).bind(secret, await secretHash(secret)).all();
  const t = results[0] || null;
  if (t && t.admin_wrap) t.ckey = await unwrapKey(secret, 'admin', t.admin_wrap);
  return t;
}
function adminClosed(t) {
  return Date.now() > t.created + ADMIN_TTL;
}

// Past every write path's expiry (FINAL_TTL): the tournament's files,
// schedule, roster and category map can never change again.
function tournamentFinal(t) {
  return Date.now() > t.created + FINAL_TTL;
}
// How long a /pub answer for this tournament stays good.
function pubCache(t) {
  return tournamentFinal(t) ? PUB_CACHE_FINAL : PUB_CACHE_LIVE;
}

async function createTournament(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const slug = String(body.slug || '').trim().toLowerCase();
  const name = cleanName(body.name);
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
    return err(env, 400, 'slug must be 3-40 chars: a-z, 0-9, hyphens');
  }
  // the in-browser demo tournament owns t.html?t=demo
  if (slug === 'demo') return err(env, 409, 'slug is reserved');
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
  // Content key: minted here, stored only wrapped (see "question text
  // encryption"). D1 gets the secret's hash, never the secret.
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const out = await env.DB.prepare(
      'INSERT INTO tournaments (slug, name, admin_secret, admin_wrap, creator_ip, settings, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    ).bind(slug, name, await secretHash(adminSecret), await wrapKey(adminSecret, 'admin', rawKey),
      ip, JSON.stringify(body.settings || {}), created).run();
    return json(env, {
      id: out.meta.last_row_id, slug, name,
      admin_secret: adminSecret, closes: created + ADMIN_TTL,
    });
  } catch (e) {
    return err(env, 409, 'slug already taken');
  }
}

// A leaked admin link mid-tournament: mint a new secret, the old link
// dies. The content key is rewrapped under the new secret (the request
// already unwrapped it), so the old link can no longer decrypt anything.
async function rotateAdmin(env, t) {
  const adminSecret = randToken();
  await env.DB.prepare(
    'UPDATE tournaments SET admin_secret = ?2, admin_wrap = ?3 WHERE id = ?1'
  ).bind(t.id, await secretHash(adminSecret),
    t.ckey ? await wrapKey(adminSecret, 'admin', t.ckey) : null).run();
  return json(env, { admin_secret: adminSecret });
}

async function getTournament(env, t, ctx) {
  const id = t.id;
  const [buckets, rounds, files, catsHead] = await Promise.all([
    env.DB.prepare('SELECT id, room_name, secret, secret_enc, created FROM buckets WHERE tournament_id = ?1 ORDER BY id').bind(id).all(),
    env.DB.prepare('SELECT number, packet_name, packet_r2_key FROM rounds WHERE tournament_id = ?1 ORDER BY number').bind(id).all(),
    env.DB.prepare('SELECT id, bucket_id, round, kind, r2_key, filename, size, error, created FROM files WHERE tournament_id = ?1 ORDER BY created DESC').bind(id).all(),
    env.DATA.head(`t/${id}/catmap.json`),
  ]);
  // packets from before category extraction existed — or from before
  // the current parser (version in R2 custom metadata): backfill once,
  // off the response path
  const staleCats = !catsHead || (catsHead.customMetadata || {}).v !== CATMAP_VERSION;
  if (staleCats && ctx && rounds.results.some((r) => /\.json$/i.test(r.packet_name))) {
    ctx.waitUntil(rebuildCatmap(env, id, t.ckey));
  }
  // Room secrets go back to the TO in the clear — they ARE the room
  // links — but the credential column holds only the hash on new rows;
  // the plaintext travels encrypted under the content key this request
  // just unwrapped (secret_enc). Legacy rows carry the secret itself.
  const rooms = await Promise.all(buckets.results.map(async ({ secret_enc, ...b }) => ({
    ...b, secret: secret_enc && t.ckey ? await decField(t.ckey, secret_enc) : b.secret,
  })));
  const { admin_secret, creator_ip, admin_wrap, buzz_wrap, ckey, ...pub_t } = t;
  return json(env, {
    tournament: { ...pub_t, closes: t.created + ADMIN_TTL },
    buckets: rooms,
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
    // Setting a buzzpoints password: the dashboard sends the derived
    // token once, purely so the content key can be wrapped under it —
    // that wrap is what lets the password-gated qpacket route decrypt
    // packets. The token is never stored; hash and wrap always move
    // together, so an existing wrap is only replaced by a matching one.
    if (typeof body.buzz_token === 'string' && body.buzz_token
      && t.ckey && body.settings.buzz && body.settings.buzz.mode === 'password') {
      sets.push('buzz_wrap = ?');
      binds.push(await wrapKey(body.buzz_token, 'buzz', t.ckey));
    }
  }
  if (body.announce !== undefined) {
    const cleaned = cleanAnnounce(body.announce, t);
    if (cleaned.error) return err(env, 400, cleaned.error);
    sets.push('announce = ?'); binds.push(cleaned.json);
  }
  if (!sets.length) return err(env, 400, 'nothing to update');

  await env.DB.prepare(
    `UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();
  // Flagging on every field is deliberately broad. Most of these (name,
  // round, broadcasts) only ever reach viewers through /pub/:slug, so
  // they need no publish at all; settings can change what a blob holds,
  // and publishing recomputes cheaply and idempotently, so one flag for
  // the whole route beats reasoning about which fields matter.
  // Unpublishing flags too: the cron sees published = 0 and retracts the
  // slug's folder from the branch.
  await markPub(env, id);
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

  // New-style tournaments store the hash plus the secret encrypted under
  // the content key (getTournament hands it back to the TO). A legacy
  // tournament has no content key, so its rooms stay legacy too —
  // plaintext secret, plaintext blobs — rather than becoming rows whose
  // links the dashboard could never render again.
  const secret = randToken();
  const out = await env.DB.prepare(
    'INSERT INTO buckets (tournament_id, room_name, secret, wrap, secret_enc, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  ).bind(id, roomName, t.ckey ? await secretHash(secret) : secret,
    t.ckey ? await wrapKey(secret, 'bucket', t.ckey) : null,
    t.ckey ? await encField(t.ckey, secret) : null, Date.now()).run();
  await markPub(env, id); // room names ride the published state (files[].room)
  return json(env, { id: out.meta.last_row_id, room_name: roomName, secret });
}

async function deleteBucket(env, t, bucketId) {
  // Files already uploaded stay downloadable; only the mod's access dies.
  await env.DB.prepare(
    'DELETE FROM buckets WHERE id = ?1 AND tournament_id = ?2'
  ).bind(bucketId, t.id).run();
  await markPub(env, t.id); // room count feeds buzz_done's expected-games math
  return json(env, { ok: true });
}

async function renameBucket(request, env, t, bucketId) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const roomName = cleanName(body.room_name);
  if (!roomName) return err(env, 400, 'room_name required');
  const out = await env.DB.prepare(
    'UPDATE buckets SET room_name = ?3 WHERE id = ?1 AND tournament_id = ?2'
  ).bind(bucketId, t.id, roomName).run();
  if (!out.meta.changes) return err(env, 404, 'no such room');
  return json(env, { id: bucketId, room_name: roomName });
}

/* Text-free per-question category map (t/<tid>/catmap.json, {rounds:
   {"<n>": {t: [{c, s} | null, ...], b: [...]}}}), extracted from
   qbreader-format JSON packets at upload time. It powers the public
   categories tab without exposing any question text; docx packets carry
   no category data, so their rounds simply stay absent. Maintained with
   the same conditional-write retry as the stats bundle. */

// Primary categories we recognize inside ACF/YAPP metadata strings
// ("History - World, Author" / "Author, History - World" / "Physics,
// Author"). Keys are lowercase, values the canonical display form, so
// differently-cased tags land in one bucket; "Pop Culture" reads as
// Trash so a set mixing the two names stays one bucket.
const META_CATS = new Map([
  ['literature', 'Literature'], ['history', 'History'], ['science', 'Science'],
  ['fine arts', 'Fine Arts'], ['religion', 'Religion'], ['mythology', 'Mythology'],
  ['philosophy', 'Philosophy'], ['social science', 'Social Science'],
  ['current events', 'Current Events'], ['geography', 'Geography'],
  ['other academic', 'Other Academic'], ['trash', 'Trash'], ['pop culture', 'Trash'],
]);

// Bare distribution labels ("American History", "Physics", "Painting /
// Sculpture", "Other") used by sets that tag each question with a single
// label instead of ACF-style metadata. Field labels map onto their
// primary category; "<Sub> History/Literature/Science/Fine Arts" splits
// on the suffix ("Any" reads as no subcategory).
const SCIENCE_FIELDS = new Set(['physics', 'chemistry', 'biology', 'math',
  'astronomy', 'computer science', 'earth science', 'engineering']);
const ARTS_FIELDS = new Set(['painting / sculpture', 'painting/sculpture',
  'painting', 'sculpture', 'classical music', 'music', 'opera', 'jazz',
  'architecture', 'film', 'photography', 'dance', 'musicals']);
const SOCIAL_FIELDS = new Set(['political science', 'economics', 'psychology',
  'sociology', 'anthropology', 'linguistics']);
// "Social Science" before "Science": "Other Social Science" is social
const LABEL_SUFFIXES = [[' social science', 'Social Science'],
  [' history', 'History'], [' literature', 'Literature'],
  [' fine arts', 'Fine Arts'], [' science', 'Science']];

function categoryFromLabel(label) {
  const lower = label.toLowerCase();
  if (lower === 'other') return { c: 'Other Academic', s: '' };
  if (SCIENCE_FIELDS.has(lower)) return { c: 'Science', s: label };
  if (ARTS_FIELDS.has(lower)) return { c: 'Fine Arts', s: label };
  if (SOCIAL_FIELDS.has(lower)) return { c: 'Social Science', s: label };
  for (const [suffix, cat] of LABEL_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      const sub = label.slice(0, label.length - suffix.length).trim();
      // a sub that is itself a primary category ("Science History") means
      // the label reads backwards — let the vocabulary sort it out
      if (META_CATS.has(sub.toLowerCase())) break;
      return { c: cat, s: sub.toLowerCase() === 'any' ? '' : sub };
    }
  }
  return null;
}

// One comma-chunk of a metadata string. Dash-separated segments (plain
// hyphen needs spaces; en/em dashes don't) are scanned for a primary
// category — it may sit anywhere ("Author - History - European"), and
// whatever follows it is the subcategory, kept in the set's own words.
// A chunk with no dashes falls back to the bare-label vocabulary.
function categoryFromChunk(chunk) {
  const segs = chunk.split(/\s+-\s+|\s*[–—]\s*/)
    .map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const canon = META_CATS.get(segs[i].toLowerCase());
    if (canon) return { c: canon, s: segs.slice(i + 1).join(' - ') };
  }
  return segs.length === 1 ? categoryFromLabel(segs[0]) : null;
}

// Last-resort vocabulary for tags nothing above understood: real-world
// subcategory spellings ("Euro Lit", "AmHist", "Bio", "Theology"...)
// collected from qbreader's packet-parser standardize-subcats table
// (github.com/qbreader/packet-parser), mapped onto qb-td display
// categories. Matched by token subset over the whole metadata string,
// so separators, author names, and word order don't matter. A few
// packet-parser spellings that are common surnames or lone generic
// words (Law, Rock, R&B, Soul, Culture, Thought, Stories, Practices,
// Performance) are deliberately left out — down here a false positive
// is worse than an uncategorized question.
const CAT_VOCAB = [
  // Literature
  ['American Lit|AmLit|US Literature|US Lit|U.S. Literature|Miscellaneous American', 'Literature', 'American'],
  ['British Lit|Brit Lit|Anglo Lit|British Literature|British Miscellaneous', 'Literature', 'British'],
  ['Ancient Literature|Classical Literature', 'Literature', 'Classical'],
  ['European Lit|Euro Lit|EuroLit|European/World Lit|European Literature', 'Literature', 'European'],
  ['World Lit|World Literature', 'Literature', 'World'],
  ['Other Lit|Mixed Lit|Any Lit|Misc Lit|Misc Literature|Miscellaneous Literature|Literary Criticism|Nonfiction|Essay|Other Literature', 'Literature', 'Other'],
  ['Literature Shakespeare', 'Literature', 'European'],
  ['Drama', 'Literature', 'Drama'], ['Poetry', 'Literature', 'Poetry'],
  ['Long Fiction', 'Literature', 'Long Fiction'], ['Short Fiction', 'Literature', 'Short Fiction'],
  // History
  ['American Hist|AmHist|US Hist|US History|U.S. History|American History', 'History', 'American'],
  ['Ancient History|Classical History', 'History', 'Ancient'],
  ['British History|BritHist|European Hist|Euro History|Europe History|Continental History|ContHist|Mediterranean History|Other Western History|European History', 'History', 'European'],
  ['World Hist|International Hist|Commonwealth History|Commonwealth/Misc|African History|Asian History|World History', 'History', 'World'],
  ['Misc History|Misc. History|Mixed History|Any History|Other History|Historiography|Archaeology|Historio/Archaeo|Zeitgeist', 'History', 'Other'],
  // Science
  ['Bio|Biology|Botany', 'Science', 'Biology'],
  ['Chem|Chemistry', 'Science', 'Chemistry'],
  ['Phys|Physics', 'Science', 'Physics'],
  ['Math|Mathematics|Statistics', 'Science', 'Math'],
  ['Astro|Astronomy', 'Science', 'Astronomy'],
  ['Computer Science|CompSci', 'Science', 'Computer Science'],
  ['Earth Science|Earth Sci|Earth|Atmospheric Science|Environmental Science|Ocean Science', 'Science', 'Earth Science'],
  ['Engineering', 'Science', 'Engineering'],
  ['Other Sci|OSci|Misc Science|Misc. Science|Science Tech|Science History|Science Culture|Science Academic|Science African|Science Applied/Eng|Other Science', 'Science', 'Other'],
  // Fine Arts
  ['Painting', 'Fine Arts', 'Painting'], ['Sculpture', 'Fine Arts', 'Sculpture'],
  ['Visual FA|Visual Fine Art|Visual Fine Arts|Visual Arts|Visual Art|European Art|World Art', 'Fine Arts', 'Visual'],
  ['Auditory FA|Auditory Fine Art|Auditory Fine Arts|Audial Fine Arts|Auditory Arts|Auditory Art', 'Fine Arts', 'Auditory'],
  ['Classical Music|Fine Arts Music', 'Fine Arts', 'Classical Music'],
  ['Photography', 'Fine Arts', 'Photography'], ['Architecture', 'Fine Arts', 'Architecture'],
  ['Film', 'Fine Arts', 'Film'], ['Jazz', 'Fine Arts', 'Jazz'],
  ['Opera', 'Fine Arts', 'Opera'], ['Musicals', 'Fine Arts', 'Musicals'],
  ['Dance|Ballet', 'Fine Arts', 'Dance'], ['Theatre|Theater', 'Fine Arts', 'Theater'],
  ['Other Arts|Other Fine Art|Misc. FA|Misc Art|Misc. Art|Any Art|OArts|OArt|OtherArt|OVisArt|OAudArt|Performing Arts|Fashion|Other Fine Arts', 'Fine Arts', 'Other'],
  // RMP
  ['Rel|Theology|Buddhism|Hinduism|Islam|Bible|New Testament|Hebrew Bible|Christian Practice|Jewish Practice|Bible/Christianity', 'Religion', ''],
  ['Myth|Legends|Misc Belief', 'Mythology', ''],
  ['Phil/Thought|PhilO', 'Philosophy', ''],
  // Social Science
  ['Econ|Economics|Economy|Economic', 'Social Science', 'Economics'],
  ['Psych|Psychology', 'Social Science', 'Psychology'],
  ['Linguistics', 'Social Science', 'Linguistics'],
  ['Sociology', 'Social Science', 'Sociology'],
  ['Anthro|Anthropology', 'Social Science', 'Anthropology'],
  ['Political Science', 'Social Science', 'Political Science'],
  ['Other Social Science', 'Social Science', 'Other'],
  // the rest
  ['CE|Modern World', 'Current Events', ''],
  ['Geo', 'Geography', ''],
  ["Misc. Academic|Mixed Academic|Miscellaneous|General Knowledge|Writer's Choice|Writer’s Choice|My Choice|OA", 'Other Academic', ''],
  ['Movies', 'Trash', 'Movies'], ['Pop Music', 'Trash', 'Music'],
  ['Sports', 'Trash', 'Sports'], ['TV|Small Screen|Television', 'Trash', 'Television'],
  ['Video Games', 'Trash', 'Video Games'],
  ['Comic|Comics|Manga|Popular Culture|Other Pop Culture', 'Trash', 'Other'],
];

const metaTokens = (s) => s.toLowerCase().replace(/[–—()]/g, ' ')
  .split(/[\s\/,;:.&-]+/).filter(Boolean);

// compiled once: every spelling as a token list, most words first so
// "Classical Music" wins over a hypothetical one-word cousin
const VOCAB = CAT_VOCAB
  .flatMap(([spellings, c, s]) =>
    spellings.split('|').map((sp) => ({ tokens: metaTokens(sp), c, s })))
  .sort((a, b) => b.tokens.length - a.tokens.length);

function categoryFromVocab(meta) {
  const tokens = new Set(metaTokens(meta));
  for (const v of VOCAB) {
    if (v.tokens.every((t) => tokens.has(t))) return { c: v.c, s: v.s };
  }
  return null;
}

export function categoryFromMetadata(meta) {
  if (typeof meta !== 'string' || !meta) return null;
  let best = null;
  for (const part of meta.split(',')) {
    const cand = categoryFromChunk(part.trim());
    // a part carrying a subcategory beats one without
    if (cand && (!best || (cand.s && !best.s))) best = cand;
  }
  return best || categoryFromVocab(meta);
}

// Round entry shape: {t: [{c, s} | null, ...], b: [...]} — tossup and
// bonus categories by packet position. Maps written before bonuses were
// extracted store a bare tossup array; readers accept both.
export function packetCategories(body, filename) {
  if (!/\.json$/i.test(filename)) return null;
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return null; }
  if (!parsed || !Array.isArray(parsed.tossups) || !parsed.tossups.length) return null;
  const catOf = (q) => {
    if (!q) return null;
    if (typeof q.category === 'string' && q.category) {
      return { c: q.category, s: typeof q.subcategory === 'string' ? q.subcategory : '' };
    }
    return categoryFromMetadata(q.metadata);
  };
  const t = parsed.tossups.map(catOf);
  const b = (Array.isArray(parsed.bonuses) ? parsed.bonuses : []).map(catOf);
  return t.some(Boolean) || b.some(Boolean) ? { t, b } : null;
}

// Parser generation, stamped into R2 custom metadata on every catmap
// write. Bump it when categoryFromMetadata learns new formats: maps
// written by an older parser then read as stale and the dashboard load
// backfills them, so already-uploaded tournaments pick up the
// improvement without a re-upload.
const CATMAP_VERSION = '2';

// Backfill for packets uploaded before category extraction existed (or
// before the current parser understood their format): recompute the
// whole map from the stored packets. Triggered from the dashboard load
// when the map is missing or version-stale; writes an empty {rounds:{}}
// marker when nothing has categories so the attempt isn't repeated
// every load.
async function rebuildCatmap(env, tid, rawKey) {
  const { results } = await env.DB.prepare(
    'SELECT number, packet_r2_key, packet_name FROM rounds WHERE tournament_id = ?1'
  ).bind(tid).all();
  const map = { rounds: {} };
  for (const row of results) {
    if (!/\.json$/i.test(row.packet_name)) continue;
    const obj = await env.DATA.get(row.packet_r2_key);
    if (!obj) continue;
    const cats = packetCategories(await readBlob(obj, rawKey), row.packet_name);
    if (cats) map.rounds[String(row.number)] = cats;
  }
  await env.DATA.put(`t/${tid}/catmap.json`, JSON.stringify(map), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { v: CATMAP_VERSION },
  });
  await markPub(env, tid);
}

async function updateCatmap(env, tid, round, cats) {
  const key = `t/${tid}/catmap.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await env.DATA.get(key);
    let map = { rounds: {} };
    if (cur) {
      map = await cur.json().catch(() => ({ rounds: {} }));
      if (!map || typeof map.rounds !== 'object') map = { rounds: {} };
    }
    if (cats) map.rounds[String(round)] = cats;
    else if (cur) delete map.rounds[String(round)]; // replacement without categories clears the round
    else return; // nothing stored, nothing to clear
    if (!Object.keys(map.rounds).length) {
      // an empty map reads as "no categories": drop the blob so the tab hides
      if (cur) { await env.DATA.delete(key); await markPub(env, tid); }
      return;
    }
    // merging one round into a map an older parser wrote must not mark
    // the whole map current — keep its version so the backfill still
    // rebuilds the other rounds; only rebuildCatmap certifies current
    const v = cur ? (cur.customMetadata || {}).v || '1' : CATMAP_VERSION;
    const onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    try {
      const put = await env.DATA.put(key, JSON.stringify(map), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { v },
        onlyIf,
      });
      if (put) { await markPub(env, tid); return; }
    } catch (e) { /* precondition failed -> retry */ }
  }
  console.log('catmap update lost the retry race for tournament', tid);
}

async function pubCats(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const obj = await env.DATA.get(`t/${t.id}/catmap.json`);
  if (!obj) return err(env, 404, 'no categories');
  return blobResponse(env, obj, null, pubCache(t));
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
  // encrypted at rest; category extraction below reads the plaintext body
  await putBlob(env, key, body,
    request.headers.get('Content-Type') || 'application/octet-stream', t.ckey);
  await env.DB.prepare(
    'INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?1, ?2, ?3, ?4) ' +
    'ON CONFLICT(tournament_id, number) DO UPDATE SET packet_r2_key = ?3, packet_name = ?4'
  ).bind(id, round, key, filename).run();
  await updateCatmap(env, id, round, packetCategories(body, filename));
  await markPub(env, id); // packet_rounds rides the published state
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
  await markPub(env, id);
  return json(env, { filename });
}

async function adminDownload(url, env, t) {
  const key = url.searchParams.get('key') || '';
  // Ownership boundary: only this tournament's prefix is reachable.
  if (!key.startsWith(`t/${t.id}/`)) return err(env, 403, 'bad key');
  const obj = await env.DATA.get(key);
  if (!obj) return err(env, 404, 'no such file');
  const dl = url.searchParams.get('dl') || key.split('/').pop();
  const part = url.searchParams.get('part');
  if (part !== 'qbj' && part !== 'game') return blobResponseDec(env, obj, t.ckey, dl);
  // part=qbj|game splits a combined reader upload (.qbtd.json = {qbj,
  // game}) into the file consumers actually use. Admin-only: the game
  // half carries the packet text, which never leaves the TO side.
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readBlob(obj, t.ckey)));
  } catch (e) { return err(env, 400, 'not a combined file'); }
  const half = parsed && typeof parsed === 'object' ? parsed[part] : null;
  if (!half || typeof half !== 'object') return err(env, 404, 'no ' + part + ' half in this file');
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'application/json');
  headers.set('Content-Disposition', `attachment; filename="${dl.replace(/["\\\r\n]/g, '_')}"`);
  return new Response(JSON.stringify(half), { status: 200, headers });
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
    await markPub(env, id);
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
  // The dashboard rebuilds from admin downloads, which keep match notes;
  // the public bundle must not (stripMatchNotes).
  for (const e of parsed.entries) {
    if (e && typeof e === 'object') stripMatchNotes(e.qbj);
  }
  await env.DATA.put(`t/${id}/combined.json`, JSON.stringify(parsed), {
    httpMetadata: { contentType: 'application/json' },
  });
  await markPub(env, id);
  return json(env, { entries: parsed.entries.length });
}

/* ---------- schedule (R2 blob t/<tid>/schedule.json) ----------
   Written whole by the TO's schedule editor; served publicly on the
   tournament page and to reader rooms (which preselect the scheduled
   teams). Same publish/secret gates as every other blob. */

function scheduleShapeError(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'bad schedule';
  if (parsed.v !== 1) return 'unknown schedule version';
  if (!Array.isArray(parsed.rooms) || !Array.isArray(parsed.phases)) return 'bad schedule';
  return null;
}

async function putSchedule(request, env, t) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_SCHEDULE) return err(env, 413, 'schedule too large');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return err(env, 400, 'bad json'); }
  const shapeErr = scheduleShapeError(parsed);
  if (shapeErr) return err(env, 400, shapeErr);
  await env.DATA.put(`t/${t.id}/schedule.json`, body, {
    httpMetadata: { contentType: 'application/json' },
  });
  await markPub(env, t.id);
  return json(env, { ok: true });
}

async function deleteSchedule(env, t) {
  await env.DATA.delete(`t/${t.id}/schedule.json`);
  await markPub(env, t.id);
  return json(env, { ok: true });
}

async function pubSchedule(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const obj = await env.DATA.get(`t/${t.id}/schedule.json`);
  if (!obj) return err(env, 404, 'no schedule');
  return blobResponse(env, obj, null, pubCache(t));
}

// The reader room's view: the whole schedule plus which room index this
// bucket is (rooms[].bucket link), so it can preselect the round's teams.
// Fetched once per page load — deliberately not part of the polled
// bucket state.
async function bucketSchedule(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  const obj = await env.DATA.get(`t/${b.tournament_id}/schedule.json`);
  if (!obj) return err(env, 404, 'no schedule');
  let schedule;
  try { schedule = await obj.json(); } catch (e) { return err(env, 404, 'no schedule'); }
  const rooms = Array.isArray(schedule.rooms) ? schedule.rooms : [];
  // bucket link first; fall back to a room-name match so schedules made
  // before the rooms existed (or never hand-linked) still resolve
  const norm = (x) => String(x || '').trim().toLowerCase();
  let room = rooms.findIndex((r) => r && r.bucket === b.id);
  if (room === -1) room = rooms.findIndex((r) => r && norm(r.name) === norm(b.room_name));
  return json(env, { room: room === -1 ? null : room, schedule });
}

/* ---------- tiebreakers (R2 blob t/<tid>/tiebreakers.json) ----------
   The TO uploads a tiebreaker packet; it is split into individually
   trackable questions (TU1, B1, ...) because MODAQ adds tiebreakers to a
   game one question at a time. Every room's reader appends the whole pool
   to its packet, and each reader upload reports which pool questions the
   game actually read (root.tb.used), so the log always says which teams
   have heard which question. Blob shape:
     {v: 1, seq: {t, b},
      tossups: [{id, from, question, answer, ...}],
      bonuses: [{id, from, leadin, parts, answers, values, ...}],
      uses:    [{q, round, room, teams: [a, b], at}]}
   Question text is served only through admin/bucket-authed routes — the
   same trust level as packets. */

const TB_KEY = (tid) => `t/${tid}/tiebreakers.json`;

function emptyTbPool() {
  return { v: 1, seq: { t: 0, b: 0 }, tossups: [], bonuses: [], uses: [] };
}

async function readTbPool(env, tid, rawKey) {
  const obj = await env.DATA.get(TB_KEY(tid));
  if (!obj) return { cur: null, pool: emptyTbPool() };
  const pool = await readBlob(obj, rawKey)
    .then((buf) => JSON.parse(new TextDecoder().decode(buf))).catch(() => null);
  if (!pool || pool.v !== 1 || !Array.isArray(pool.tossups)) {
    return { cur: obj, pool: emptyTbPool() };
  }
  pool.bonuses = Array.isArray(pool.bonuses) ? pool.bonuses : [];
  pool.uses = Array.isArray(pool.uses) ? pool.uses : [];
  pool.seq = pool.seq && Number.isInteger(pool.seq.t) ? pool.seq : { t: 0, b: 0 };
  return { cur: obj, pool };
}

async function writeTbPool(env, tid, rawKey, mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { cur, pool } = await readTbPool(env, tid, rawKey);
    const out = mutate(pool);
    if (out && out.error) return out;
    const text = JSON.stringify(pool);
    if (text.length > MAX_TB_BLOB) return { error: 'tiebreaker pool too large' };
    const onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    try {
      const put = await putBlob(env, TB_KEY(tid), text, 'application/json', rawKey, { onlyIf });
      if (put) return { error: null, pool };
    } catch (e) { /* precondition failed -> retry */ }
  }
  console.log('tiebreaker update lost the retry race for tournament', tid);
  return { error: 'concurrent update, try again' };
}

// POST /a/:secret/tiebreakers?name=... — split a packet JSON into pool
// questions. Repeated uploads append (ids keep counting); the same rules
// as the reader's own packet validation, so a pool question is guaranteed
// to load in MODAQ.
async function uploadTiebreakers(request, url, env, t) {
  const name = cleanFilename(url.searchParams.get('name') || 'tiebreakers.json');
  if (!/\.json$/i.test(name)) {
    return err(env, 400, 'tiebreaker packets must be .json (docx cannot be split server-side)');
  }
  const body = await request.arrayBuffer();
  if (!body.byteLength) return err(env, 400, 'empty body');
  if (body.byteLength > MAX_PACKET) return err(env, 413, 'packet too large');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return err(env, 400, 'not valid JSON'); }
  if (!parsed || !Array.isArray(parsed.tossups) || !parsed.tossups.length) {
    return err(env, 400, 'packet JSON has no tossups array');
  }
  for (const q of parsed.tossups) {
    if (!q || typeof q.question !== 'string' || typeof q.answer !== 'string') {
      return err(env, 400, 'a tossup is missing question or answer text');
    }
  }
  const bonuses = Array.isArray(parsed.bonuses) ? parsed.bonuses : [];
  for (const b of bonuses) {
    if (!b || !Array.isArray(b.parts) || !Array.isArray(b.answers)) {
      return err(env, 400, 'a bonus is missing parts or answers');
    }
  }
  const out = await writeTbPool(env, t.id, t.ckey, (pool) => {
    for (const q of parsed.tossups) {
      pool.tossups.push({ id: 'TU' + (++pool.seq.t), from: name, ...q });
    }
    for (const b of bonuses) {
      pool.bonuses.push({ id: 'B' + (++pool.seq.b), from: name, ...b });
    }
  });
  if (out.error) return err(env, 400, out.error);
  return json(env, {
    added: { tossups: parsed.tossups.length, bonuses: bonuses.length },
    tossups: out.pool.tossups.length,
    bonuses: out.pool.bonuses.length,
  });
}

async function deleteTiebreakers(env, t) {
  await env.DATA.delete(TB_KEY(t.id));
  return json(env, { ok: true });
}

// GET /b/:secret/tiebreakers — the reader's copy of the pool: full
// question text (packet trust level) plus the usage log, so the mod can
// see which teams have already heard each question.
async function bucketTiebreakers(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  const obj = await env.DATA.get(TB_KEY(b.tournament_id));
  if (!obj) return err(env, 404, 'no tiebreakers');
  return blobResponseDec(env, obj, b.ckey, null);
}

// A reader upload reported which pool questions its game read. One game =
// one log entry set: a re-export of the same game (same round + teams)
// replaces its earlier entries instead of double-logging.
async function logTbUses(env, tid, rawKey, roomName, round, teams, usedIds) {
  const { cur } = await readTbPool(env, tid, rawKey);
  if (!cur) return; // no pool: nothing to log against (and nothing to clear)
  const pairKey = (ts) => [...ts].sort().join('\n');
  const gameKey = round + '\n' + pairKey(teams);
  await writeTbPool(env, tid, rawKey, (pool) => {
    const known = new Set([...pool.tossups, ...pool.bonuses].map((q) => q.id));
    const ids = [...new Set(usedIds.filter((id) => known.has(id)))];
    pool.uses = pool.uses.filter((u) =>
      u.round + '\n' + pairKey(u.teams || []) !== gameKey);
    const now = Date.now();
    for (const q of ids) {
      pool.uses.push({ q, round, room: roomName, teams, at: now });
    }
    pool.uses = pool.uses.slice(-MAX_TB_USES);
  });
}

/* ---------- moderator bucket API (/b/*, secret-authed) ---------- */

// Same raw-or-hash lookup as getAdminTournament; b.ckey is the unwrapped
// content key when this bucket's tournament is encrypted.
async function getBucketRow(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT b.id, b.room_name, b.created, b.tournament_id, b.wrap, t.name AS tournament_name, ' +
    't.current_round, t.roster_r2_key, t.settings, t.announce ' +
    'FROM buckets b JOIN tournaments t ON t.id = b.tournament_id WHERE b.secret = ?1 OR b.secret = ?2'
  ).bind(secret, await secretHash(secret)).all();
  const b = results[0] || null;
  if (b && b.wrap) b.ckey = await unwrapKey(secret, 'bucket', b.wrap);
  return b;
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
  const [rounds, uploads, count] = await Promise.all([
    env.DB.prepare(
      'SELECT number, packet_name FROM rounds WHERE tournament_id = ?1 AND number <= ?2 ORDER BY number'
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
  // Rooms need the reader game format, nothing else — the buzzpoints
  // config in particular carries the stored password hash, which must
  // never leave the Worker (see "buzzpoints gate").
  delete settings.buzz;
  const packets = rounds.results;
  return json(env, {
    tournament: b.tournament_name,
    room: b.room_name,
    current_round: b.current_round,
    closes: b.created + BUCKET_TTL,
    packet: packets.find((p) => p.number === b.current_round) || null,
    packets,
    roster: !!b.roster_r2_key,
    settings,
    announce: roomAnnounce(b, b.id),
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
  let tbReport = null; // {teams, used} from a reader upload's tb field
  if (isQbj || isCombined) {
    const parsed = extractMatch(new TextDecoder().decode(buf));
    error = parsed.error;
    qbjObj = parsed.qbj || null;
    if (!error && isCombined && parsed.root && parsed.root.tb
      && Array.isArray(parsed.root.tb.used) && parsed.teams.every(Boolean)) {
      tbReport = {
        teams: parsed.teams,
        used: parsed.root.tb.used.filter((x) => typeof x === 'string').slice(0, 200),
      };
    }
  }

  // Encrypted at rest: a combined upload's game half carries the full
  // packet text. The extracted qbj half (text-free) goes to the public
  // bundle below in plaintext — that is the only public copy.
  const key = `t/${b.tournament_id}/bucket/${b.id}/${randToken(8)}-${filename}`;
  await putBlob(env, key, buf, 'application/json', b.ckey);
  const out = await env.DB.prepare(
    'INSERT INTO files (tournament_id, bucket_id, round, kind, r2_key, filename, size, error, created) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(b.tournament_id, b.id, round, kind, key, filename, buf.byteLength, error, Date.now()).run();
  const fileId = out.meta.last_row_id;

  if (qbjObj && !error) {
    await updateBundle(env, b.tournament_id, (bundle) => {
      bundle.entries = bundle.entries.filter((e) => e.id !== fileId);
      bundle.entries.push({
        id: fileId, round, room: b.room_name, filename, qbj: stripMatchNotes(qbjObj),
      });
    });
    await markPub(env, b.tournament_id);
  }
  if (tbReport) {
    await logTbUses(env, b.tournament_id, b.ckey, b.room_name, round, tbReport.teams, tbReport.used);
  }
  // Broadcasts ride back on the upload response: it's how the reader page
  // (which never polls) picks up new messages, at exactly the between-rounds
  // moment they're written for.
  return json(env, { id: fileId, filename, round, kind, error, announce: roomAnnounce(b, b.id) });
}

async function bucketPacket(env, secret, url) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  // Played rounds stay readable (a room running behind still needs them);
  // future rounds stay locked (question security).
  let round = Number(url.searchParams.get('round'));
  if (!Number.isInteger(round) || round < 1) round = b.current_round;
  if (round > b.current_round) return err(env, 403, 'not the live round yet');
  const { results } = await env.DB.prepare(
    'SELECT packet_r2_key, packet_name FROM rounds WHERE tournament_id = ?1 AND number = ?2'
  ).bind(b.tournament_id, round).all();
  if (!results.length) return err(env, 404, 'no packet for round ' + round);
  const obj = await env.DATA.get(results[0].packet_r2_key);
  if (!obj) return err(env, 404, 'packet missing');
  return blobResponseDec(env, obj, b.ckey, results[0].packet_name);
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
    // SELECT * rather than an explicit column list: pub_snapshot only
    // exists after migrate-pub.sql, and naming it here would break every
    // /pub route on a deploy that lands before the migration. With * the
    // column simply reads as undefined and `pub` stays null.
    // (created rides along for tournamentFinal(): it decides how long
    // public answers cache and whether the page keeps polling.)
    'SELECT * FROM tournaments WHERE slug = ?1 AND published = 1'
  ).bind(slug).all();
  return results[0] || null;
}

/* ---------- buzzpoints gate ----------
   Password is the ONLY mode: buzzpoints are off or gated, never open.
   The gated resource is packet text; buzz positions themselves ride in
   the public stats bundle.

   The TD's dashboard stores settings.buzz. Two shapes:

     {mode, kdf: 'pbkdf2', iters, salt, hash} — current. app/js/buzzkey.js
     stretches the password in the browser with PBKDF2-SHA256; the derived
     key is what arrives in the Authorization header, and `hash` is SHA-256
     of that key. So the Worker never receives the password, and its work
     per request stays one hash — the free tier allows 10 ms CPU, nowhere
     near enough to run PBKDF2 here. `iters` and `salt` are published in
     /pub/:slug because a viewer's browser needs them to derive the same
     key; a salt is not a secret, it only stops one precomputed table from
     covering every tournament.

     {mode, salt, hash} — tournaments whose password predates the KDF.
     hash is SHA-256("salt:password") and the password itself is on the
     wire. Still accepted so those tournaments keep working; the TD
     setting a new password upgrades them.

   Either way `hash` never leaves the Worker, so there is nothing public
   to attack offline. buzz_v — a one-way stamp derived from the salt —
   moves when the TD sets a new password, so viewers' cached keys
   invalidate. Online guessing is capped in pubQPacket. */

const MIN_BUZZ_ITERS = 100000;

function buzzConfig(t) {
  try {
    const b = (JSON.parse(t.settings) || {}).buzz;
    if (!b || b.mode !== 'password') return null;
    if (typeof b.salt !== 'string' || typeof b.hash !== 'string') return null;
    if (b.kdf === undefined) return b; // legacy sha256("salt:password")
    if (b.kdf !== 'pbkdf2') return null;
    if (!Number.isInteger(b.iters) || b.iters < MIN_BUZZ_ITERS) return null;
    return b;
  } catch (e) { /* fall through */ }
  return null;
}

// The KDF parameters a viewer's browser needs, and nothing else.
function buzzKdf(b) {
  return b && b.kdf === 'pbkdf2' ? { kdf: 'pbkdf2', iters: b.iters, salt: b.salt } : null;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Both sides are digests, never the secret, so a timing leak would give an
// attacker nothing they could invert — but constant time costs four lines
// and saves the next reader from having to work that out.
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function buzzAllowed(request, b) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Buzz /.test(auth)) return false;
  const token = auth.slice(5);
  // pbkdf2: the browser already did the stretching, so hash the derived
  // key once. legacy: the token IS the password.
  const got = b.kdf === 'pbkdf2'
    ? await sha256Hex(token)
    : await sha256Hex(b.salt + ':' + token);
  return sameDigest(got, b.hash);
}

// Scheduled games with both slots filled for a round; null when the
// schedule doesn't cover it.
function scheduledGames(sched, round) {
  for (const ph of (sched && sched.phases) || []) {
    for (const r of ph.rounds || []) {
      if (r.round === round) return (r.games || []).filter((g) => g.a && g.b).length;
    }
  }
  return null;
}

// A round is done when every scheduled game (every bucket room, without
// a schedule) has a clean game file. Buzzpoints stay hidden for a round
// until nobody is still playing it — a lagging room's teams must not
// read the round's answers mid-game.
async function roundDone(env, t, round) {
  const [files, buckets] = await Promise.all([
    env.DB.prepare(
      "SELECT DISTINCT bucket_id FROM files WHERE tournament_id = ?1 AND round = ?2 AND kind IN ('qbj', 'combined') AND error IS NULL"
    ).bind(t.id, round).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM buckets WHERE tournament_id = ?1').bind(t.id).all(),
  ]);
  let expected = buckets.results[0].n;
  const obj = await env.DATA.get(`t/${t.id}/schedule.json`);
  if (obj) {
    const n = scheduledGames(await obj.json().catch(() => null), round);
    if (n !== null) expected = n;
  }
  return files.results.length >= expected;
}

// Packet text for the buzzpoints tab: publish-gated, buzz-gated, and —
// same question-security rule as the moderator route — played rounds
// only, where played means every room has turned the round in.
async function pubQPacket(request, url, env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const b = buzzConfig(t);
  if (!b) return err(env, 404, 'not found');
  // Guessing the password is an online attack, so cap attempts per IP.
  // Generous enough for a viewer opening every round of a long tournament,
  // tight enough that a wordlist is hopeless. Two limits of what this is:
  // Cloudflare's rate limiter counts per colo rather than globally, and it
  // runs inside the Worker, so it protects the password but not the
  // request budget — a WAF rate-limiting rule on this path is the outer
  // layer for that (README).
  if (env.BUZZ_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.BUZZ_LIMIT.limit({ key: slug + ':' + ip });
    if (!success) return err(env, 429, 'too many attempts, wait a minute');
  }
  if (!(await buzzAllowed(request, b))) return err(env, 401, 'bad password');
  const round = Number(url.searchParams.get('round'));
  if (!Number.isInteger(round) || round < 1) return err(env, 400, 'bad round');
  if (round > t.current_round) return err(env, 403, 'not the live round yet');
  if (!(await roundDone(env, t, round))) return err(env, 403, 'round in progress');
  const { results } = await env.DB.prepare(
    'SELECT packet_r2_key, packet_name FROM rounds WHERE tournament_id = ?1 AND number = ?2'
  ).bind(t.id, round).all();
  if (!results.length) return err(env, 404, 'no packet for round ' + round);
  const obj = await env.DATA.get(results[0].packet_r2_key);
  if (!obj) return err(env, 404, 'packet missing');
  // Encrypted packet: the verified token unwraps the content key via
  // buzz_wrap (written when the TO set the password). A missing or
  // mismatched wrap means the password was set by a client that never
  // sent the token — setting it again repairs it.
  let rawKey = null;
  if (blobEnc(obj)) {
    if (!t.buzz_wrap) return err(env, 409, 'packets locked — set the buzzpoints password again');
    try {
      rawKey = await unwrapKey((request.headers.get('Authorization') || '').slice(5), 'buzz', t.buzz_wrap);
    } catch (e) {
      return err(env, 409, 'packets locked — set the buzzpoints password again');
    }
  }
  const res = await blobResponseDec(env, obj, rawKey, results[0].packet_name);
  res.headers.set('Cache-Control', 'private, max-age=60');
  return res;
}

// The /pub/:slug body. Served fresh on every page load or refresh: the
// page never polls, so this stays on the Worker where it can't be stale.
// `pub` is the snapshot descriptor to advertise: the route passes the
// stored one, the publisher passes the one it just committed.
async function pubStateBody(env, t, pub) {
  const [files, buckets, schedObj, packetRounds, catsHead] = await Promise.all([
    env.DB.prepare(
      "SELECT id, bucket_id, round, filename FROM files WHERE tournament_id = ?1 AND kind IN ('qbj', 'combined') AND error IS NULL ORDER BY round, id"
    ).bind(t.id).all(),
    env.DB.prepare(
      'SELECT id, room_name FROM buckets WHERE tournament_id = ?1'
    ).bind(t.id).all(),
    env.DATA.get(`t/${t.id}/schedule.json`),
    env.DB.prepare(
      'SELECT number FROM rounds WHERE tournament_id = ?1 AND number <= ?2 ORDER BY number'
    ).bind(t.id, t.current_round).all(),
    env.DATA.get(`t/${t.id}/catmap.json`),
  ]);
  // an empty map is a "checked, nothing found" backfill marker: the
  // tab stays hidden
  let catsStamp = null;
  if (catsHead) {
    const parsed = await catsHead.json().catch(() => null);
    if (parsed && parsed.rounds && Object.keys(parsed.rounds).length) {
      catsStamp = catsHead.uploaded.getTime();
    }
  }
  const buzz = buzzConfig(t);
  const rooms = Object.fromEntries(buckets.results.map((b) => [b.id, b.room_name]));
  const rows = files.results;
  // rounds every room has turned in — the only rounds the buzz tab shows
  let buzzDone = [];
  let buzzV = null;
  if (buzz) {
    buzzV = (await sha256Hex('buzzv:' + buzz.salt)).slice(0, 12);
    const sched = schedObj ? await schedObj.json().catch(() => null) : null;
    const inByRound = new Map();
    for (const f of rows) {
      if (!inByRound.has(f.round)) inByRound.set(f.round, new Set());
      inByRound.get(f.round).add(f.bucket_id);
    }
    const candidates = new Set([...inByRound.keys(), ...packetRounds.results.map((r) => r.number)]);
    buzzDone = [...candidates].filter((rn) => {
      const scheduled = scheduledGames(sched, rn);
      const expected = scheduled !== null ? scheduled : buckets.results.length;
      return (inByRound.get(rn) || new Set()).size >= expected;
    }).sort((x, y) => x - y);
  }
  return {
    name: t.name,
    current_round: t.current_round,
    roster: !!t.roster_r2_key,
    // TO broadcasts addressed to the public page; audience fields stay server-side
    announce: pubAnnounce(t),
    // stamp for the schedule tab: refetch only when this moves
    schedule: schedObj ? schedObj.uploaded.getTime() : null,
    // buzzpoints tab: the mode, the KDF parameters a viewer's browser
    // needs to derive the key, and buzz_v — which moves with the password
    // so viewers re-enter it. Never the hash.
    buzz: buzz ? buzz.mode : null,
    buzz_kdf: buzzKdf(buzz),
    buzz_v: buzzV,
    buzz_done: buzzDone,
    packet_rounds: buzz ? packetRounds.results.map((r) => r.number) : [],
    // categories tab: refetch the (text-free) category map when this moves
    cats: catsStamp,
    // Stats only change when a file lands (or is deleted): clients compare
    // this stamp and refetch the bundle only when it moves.
    version: statsVersion(rows),
    // Latest GitHub snapshot (see "public snapshots on GitHub"): the page
    // fetches its blobs SHA-pinned from raw.githubusercontent.com instead
    // of the /pub blob routes, falling back here when absent/stale.
    pub,
    files: rows.map((f) => ({
      id: f.id, round: f.round, filename: f.filename, room: rooms[f.bucket_id] || null,
    })),
    // Every write path has expired: nothing here can move again, so the
    // answer caches for a week.
    final: tournamentFinal(t),
  };
}

async function pubState(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const pub = (() => {
    if (!env.SNAPSHOT_REPO || !t.pub_snapshot) return null;
    try {
      const snap = JSON.parse(t.pub_snapshot);
      return snap && snap.sha ? { repo: env.SNAPSHOT_REPO, ...snap } : null;
    } catch (e) { return null; }
  })();
  return json(env, await pubStateBody(env, t, pub), 200, pubCache(t));
}

async function pubBundle(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const obj = await env.DATA.get(`t/${t.id}/combined.json`);
  if (!obj) return err(env, 404, 'no bundle');
  return blobResponse(env, obj, null, pubCache(t));
}

// Public per-game qbj download. Served from the bundle, not the stored
// file: the bundle entry is exactly the public copy — validated match
// qbj only (a combined file's game half carries the full packet text),
// notes stripped, and readable without the content key that encrypts
// the stored file at rest. A file missing from the bundle (validation
// error, or drift the TO hasn't rebuilt) is simply not public.
async function pubQbj(env, slug, fileId) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const obj = await env.DATA.get(`t/${t.id}/combined.json`);
  const bundle = obj ? await obj.json().catch(() => null) : null;
  const entry = bundle && Array.isArray(bundle.entries)
    ? bundle.entries.find((e) => e && e.id === fileId) : null;
  if (!entry) return err(env, 404, 'no such file');
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'public, max-age=' + pubCache(t));
  headers.set('Content-Disposition',
    `attachment; filename="${String(entry.filename || 'game.qbj').replace(/\.qbtd\.json$/i, '.qbj').replace(/["\\\r\n]/g, '_')}"`);
  return new Response(JSON.stringify(entry.qbj), { status: 200, headers });
}

async function pubRoster(env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  if (!t.roster_r2_key) return err(env, 404, 'no roster');
  const obj = await env.DATA.get(t.roster_r2_key);
  if (!obj) return err(env, 404, 'roster missing');
  return blobResponse(env, obj, 'roster.qbj', pubCache(t));
}

/* ---------- router ---------- */
export default {
  async fetch(request, env, ctx) {
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
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/packet$/)) && method === 'GET') return bucketPacket(env, m[1], url);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/roster$/)) && method === 'GET') return bucketRoster(env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/schedule$/)) && method === 'GET') return bucketSchedule(env, m[1]);
    if ((m = path.match(/^\/b\/([a-z0-9]{10,40})\/tiebreakers$/)) && method === 'GET') return bucketTiebreakers(env, m[1]);

    // Public stats routes — publish-gated inside.
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})$/)) && method === 'GET') return pubState(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/bundle$/)) && method === 'GET') return pubBundle(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/qbj\/(\d+)$/)) && method === 'GET') return pubQbj(env, m[1], Number(m[2]));
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/roster$/)) && method === 'GET') return pubRoster(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/schedule$/)) && method === 'GET') return pubSchedule(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/qpacket$/)) && method === 'GET') return pubQPacket(request, url, env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/cats$/)) && method === 'GET') return pubCats(env, m[1]);

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
      if (sub === '' && method === 'GET') return getTournament(env, t, ctx);
      if (sub === '' && method === 'POST') return updateTournament(request, env, t);
      if (sub === '/rotate' && method === 'POST') return rotateAdmin(env, t);
      if (sub === '/buckets' && method === 'POST') return createBucket(request, env, t);
      if ((mm = sub.match(/^\/buckets\/(\d+)$/)) && method === 'DELETE') return deleteBucket(env, t, Number(mm[1]));
      if ((mm = sub.match(/^\/buckets\/(\d+)$/)) && method === 'POST') return renameBucket(request, env, t, Number(mm[1]));
      if (sub === '/tiebreakers' && method === 'POST') return uploadTiebreakers(request, url, env, t);
      if (sub === '/tiebreakers' && method === 'DELETE') return deleteTiebreakers(env, t);
      if (sub === '/packet' && method === 'POST') return uploadPacket(request, url, env, t);
      if (sub === '/roster' && method === 'POST') return uploadRoster(request, url, env, t);
      if (sub === '/schedule' && method === 'POST') return putSchedule(request, env, t);
      if (sub === '/schedule' && method === 'DELETE') return deleteSchedule(env, t);
      if (sub === '/file' && method === 'GET') return adminDownload(url, env, t);
      if ((mm = sub.match(/^\/files\/(\d+)$/)) && method === 'DELETE') return deleteFile(env, t, Number(mm[1]));
      if (sub === '/bundle' && method === 'POST') return putBundle(request, env, t);
    }

    return err(env, 404, 'not found');
  },

  // Cron (wrangler.toml [triggers]): publishes dirty tournaments' public
  // snapshots to the GitHub data repo. No-op unless configured.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(publishDirty(env));
  },
};
