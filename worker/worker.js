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
// Question sets add three more on the same idiom (see "question sets"):
//   /s/*      — a set editor's API; the set link lives a year (SET_TTL).
//   /i/*      — a mirror invite: the editor mints one per mirror, and the
//               TD who starts it gets an ordinary /a/ tournament whose
//               rounds are the set's packets.
//   /pubset/* — the public set page, gated by the set's own publish flag.
//
// Storage: metadata in D1 (schema.sql), blobs in R2 under t/<tid>/...
// (a set's under s/<sid>/...).
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
const MAX_BUNDLE = 32 * 1024 * 1024;     // rebuild request body cap
const MAX_REBUILD = 200;                 // games per rebuild request (each is its own blob)
const MAX_ROUNDS_PER_FETCH = 100;        // round shards one /pub/:slug/rounds may ask for
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
const MAX_PROTESTS = 50;                 // protests kept per uploaded game
const MAX_PROTEST_TEXT = 500;            // reason / given-answer text cap
const MAX_RULINGS = 500;                 // TD rulings per tournament
const MAX_RULING_NOTE = 300;
const MAX_RULINGS_JSON = 64 * 1024;
// A set is mirrored for a season, not played in a day: its editor link
// lives a year. What it guards is the packets and the power to mint
// mirrors; every mirror it starts still runs on the 48h clocks above.
const SET_TTL = 365 * 24 * 3600 * 1000;
const SET_CREATE_PER_IP_DAY = 5;
const SET_CREATE_GLOBAL_DAY = 50;
const MAX_SET_MIRRORS = 200;
// Mirrors started from invites, per day. Their own budget: an editor's
// invites must not be able to spend the open-creation quota above (and
// lock every TD out), nor be a way around it.
const START_PER_IP_DAY = 20;
const START_GLOBAL_DAY = 300;
// A claimed invite whose tournament never got linked (the Worker died
// between the two) becomes startable again after this long.
const INVITE_CLAIM_TTL = 5 * 60 * 1000;
const MAX_SET_PACKETS = 400;             // packet versions per set, retired ones included

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

   Public blobs (the per-game copies and the round shards built from
   them, schedule, catmap, roster) stay plaintext by design: they are
   text-free and the whole point is serving them without credentials.
   The cron holds no secrets and needs none.

   Question sets use the same scheme one level up: a set has its own
   content key (wrapped under the editor's link, each mirror invite, and
   the set's buzzpoints key), and its packets are encrypted under that. A
   mirror's rounds rows point at those blobs rather than copying them, so
   the mirror carries the set's key encrypted under its own content key
   (tournaments.set_key_enc) — every credential that opens the mirror's
   key opens the set's through it (blobKey below). The cost, stated
   plainly: a mirror's packets stop being "cryptographically gone" when
   its own links expire; they go when the set's link does. */

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

// The key that opens one blob for one credential holder — a tournament
// or bucket row carrying ckey (and, on a set's mirror, set_key_enc). A
// set's blobs live under s/ and open with the set's key, recovered
// through the holder's own; everything else is the holder's own. Cached
// on the holder, so a request pays for the unwrap once.
async function blobKey(holder, r2key) {
  if (!String(r2key).startsWith('s/')) return holder.ckey || null;
  if (holder.skey === undefined) {
    holder.skey = holder.ckey && holder.set_key_enc
      ? b64ToBytes(await decField(holder.ckey, holder.set_key_enc)) : null;
  }
  return holder.skey;
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
// text, so only the extracted qbj half may ever reach a public blob or
// route. `teams` (the two team names) and `root` (for the tb
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
  // qbj: what the game's public blob stores (an {objects} wrapper is
  // kept as-is — the engine unwraps it — but a combined file
  // contributes only .qbj).
  return { error: null, qbj: obj, root, teams: names, match };
}

/* ---------- protests ----------
   MODAQ logs a protest in its game state and repeats it as free text in
   the match's `notes`. The reader page turns the game state into a
   structured list at upload (app/js/protests.js protestReport — swing
   included, computed the way MODAQ does) and sends it as the .qbtd.json's
   `protests`; the Worker keeps it on the file row as `summary`, with the
   teams and final score, so the hub's Protests drawer needs no blob
   reads. A bare .qbj (bucket page, or a file produced elsewhere) has only
   the notes, so those are parsed instead — no swing, since the buzz
   position isn't in the note. Summaries ride only on the admin route;
   public copies carry neither notes nor summaries. */

// A team's final score from its match_team (MODAQ writes no total).
function teamScore(mt) {
  let pts = 0;
  for (const mp of (mt && (mt.match_players || mt.matchPlayers)) || []) {
    for (const ac of (mp && (mp.answer_counts || mp.answerCounts)) || []) {
      const v = ac && ac.answer ? Number(ac.answer.value) : NaN;
      const n = ac ? Number(ac.number) : NaN;
      if (Number.isFinite(v) && Number.isFinite(n)) pts += v * n;
    }
  }
  pts += Number((mt && (mt.bonus_points ?? mt.bonusPoints)) || 0);
  pts += Number((mt && (mt.bonus_bounceback_points ?? mt.bonusBouncebackPoints)) || 0);
  return pts;
}

// MODAQ's two note templates (qbj/QBJ.js): "Tossup protest on tossup #N.
// Team "X" protested because of this reason: "R"." and "Bonus protest on
// bonus #N. Team "X" protested part P because of this reason: "R"."
function protestsFromNotes(notes) {
  if (typeof notes !== 'string' || !notes) return [];
  const out = [];
  const tu = /Tossup protest on tossup #(\d+)\. Team "(.*?)" protested because of this reason: "([\s\S]*?)"\.(?=\n|$)/g;
  const bo = /Bonus protest on bonus #(\d+)\. Team "(.*?)" protested part (\d+) because of this reason: "([\s\S]*?)"\.(?=\n|$)/g;
  let m;
  while ((m = tu.exec(notes))) {
    out.push({ kind: 'tu', q: Number(m[1]), team: m[2], given: '', reason: m[3] });
  }
  while ((m = bo.exec(notes))) {
    out.push({ kind: 'b', q: Number(m[1]), part: Number(m[3]), team: m[2], given: '', reason: m[4] });
  }
  return out.sort((x, y) => x.q - y.q);
}

// The reader's report, bounded. Shape: app/js/protests.js protestReport.
function cleanProtests(list) {
  if (!Array.isArray(list)) return null;
  const text = (s) => String(s ?? '').slice(0, MAX_PROTEST_TEXT);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = [];
  for (const p of list.slice(0, MAX_PROTESTS)) {
    if (!p || typeof p !== 'object') continue;
    const kind = p.kind === 'b' ? 'b' : p.kind === 'tu' ? 'tu' : null;
    const q = Number(p.q);
    if (!kind || !Number.isInteger(q) || q < 1 || q > 999) continue;
    const detail = {};
    for (const k of ['tu', 'neg', 'bonus', 'oppTu', 'oppBonus', 'part']) {
      if (p.detail && p.detail[k] !== undefined) detail[k] = num(p.detail[k]);
    }
    out.push({
      kind, q,
      ...(kind === 'b' ? { part: Math.max(1, Math.min(99, Number(p.part) || 1)) } : {}),
      team: text(p.team), given: text(p.given), reason: text(p.reason),
      ...(kind === 'tu' && Number.isInteger(p.word) ? { word: p.word } : {}),
      to: text(p.to), from: text(p.from), gain: num(p.gain), loss: num(p.loss), detail,
    });
  }
  return out;
}

// files.summary for a valid match upload: JSON text or null.
function matchSummary(match, reported) {
  if (!match) return null;
  const teams = (match.match_teams || match.matchTeams || []).map((mt) => {
    const t = mt && mt.team;
    return typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : '');
  });
  const score = (match.match_teams || match.matchTeams || []).map(teamScore);
  const protests = cleanProtests(reported) || protestsFromNotes(match.notes);
  const json = JSON.stringify({ teams, score, protests });
  return json.length > 64 * 1024 ? JSON.stringify({ teams, score, protests: [] }) : json;
}

// Whole-map write (POST /a/:secret with `rulings`): {key: {r, note, at}},
// keyed by the hub (round + question + team pair). Returns {error} or {json}.
function cleanRulings(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { error: 'bad rulings' };
  const keys = Object.keys(map);
  if (keys.length > MAX_RULINGS) return { error: `too many rulings (${MAX_RULINGS} max)` };
  const out = {};
  for (const k of keys) {
    const v = map[k];
    if (!v || typeof v !== 'object' || k.length > 400) return { error: 'bad ruling' };
    const r = ['open', 'upheld', 'denied', 'withdrawn'].includes(v.r) ? v.r : null;
    if (!r) return { error: 'bad ruling' };
    const note = String(v.note ?? '').trim().slice(0, MAX_RULING_NOTE);
    if (r === 'open' && !note) continue; // an open protest with nothing to say has no entry
    out[k] = { r, note, at: Number.isInteger(v.at) ? v.at : Date.now() };
  }
  const json = JSON.stringify(out);
  if (json.length > MAX_RULINGS_JSON) return { error: 'rulings too large' };
  return { error: null, json };
}

// MODAQ writes protest reasons — moderator free text that routinely
// quotes answers — verbatim into the match's `notes`. Nothing public
// renders notes, so every public copy of a qbj (the per-game blob, the
// round shards built from it, and /pub qbj downloads) drops the field;
// the TO's admin downloads keep it for the .yft. Mutates and returns its
// argument.
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

/* ---------- public game blobs and per-round shards ----------
   The public copy of a game is its own object, t/<tid>/pub/<fileId>.json,
   written once by the upload that produced it. Nothing is shared, so the
   36 rooms of a big tournament never contend, and a moderator's upload
   costs one small write however deep into the day it lands.

   What the stats page reads is derived from those: one shard per round
   (t/<tid>/round/<n>.json) plus a manifest of their stamps
   (t/<tid>/rounds.json). The cron is their only writer — materialize()
   below — so there is no concurrent-writer problem to lose a game to.
   A shard is rebuilt, never mutated: D1's file rows say which games are
   in the round and the per-game blobs hold their contents, so the only
   way to drift is a missing blob, which the rebuild reports and retries
   rather than silently baking in.

   Finished rounds never change again, which is the other half of the
   point: a viewer refreshing late in the day refetches the one round
   that moved instead of every game of the tournament.

   The cost is freshness. A game reaches the public page on the next tick
   (~a minute) rather than the instant it lands — the lag snapshot
   viewers already had, now shared by everyone. */

// Legacy games seeded from the pre-shard bundle per tick (see
// materialize): bounds the work when a tournament that was mid-flight at
// deploy time first materializes.
const PUB_BACKFILL_PER_TICK = 200;

const pubGameKey = (tid, fileId) => `t/${tid}/pub/${fileId}.json`;
const roundBlobKey = (tid, n) => `t/${tid}/round/${n}.json`;
const manifestKey = (tid) => `t/${tid}/rounds.json`;
// Written by the TO's rebuild (putBundle), consumed by the next
// materialize: "rebuild every shard, whether or not its stamp moved".
// A separate object rather than a flag inside the manifest so that
// setting it is a bare put — no read-modify-write to race the cron on.
const rebuildKey = (tid) => `t/${tid}/rebuild.json`;

// A stats stamp: newest file id + how many. Used per round (the client
// refetches a round when its stamp moves) and, folded together, for the
// tournament-wide `version` that predates the shards.
function statsVersion(rows) {
  return (rows.length ? rows[rows.length - 1].id : 0) + ':' + rows.length;
}

function manifestVersion(manifest) {
  let lastId = 0;
  let count = 0;
  for (const v of Object.values(manifest.rounds)) {
    const [id, n] = String(v).split(':').map(Number);
    if (id > lastId) lastId = id;
    count += n || 0;
  }
  return lastId + ':' + count;
}

async function putPubGame(env, tid, entry) {
  await env.DATA.put(pubGameKey(tid, entry.id), JSON.stringify(entry), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function readManifest(env, tid) {
  const obj = await env.DATA.get(manifestKey(tid));
  const m = obj ? await obj.json().catch(() => null) : null;
  return m && m.rounds && typeof m.rounds === 'object' ? m : { rounds: {} };
}

// The pre-shard whole-tournament bundle, as {fileId -> entry}. Only read
// when a round is missing per-game blobs: tournaments that were already
// running when this layout shipped have their games only in here, and
// this is what moves them across.
async function readLegacyBundle(env, tid) {
  const obj = await env.DATA.get(`t/${tid}/combined.json`);
  const bundle = obj ? await obj.json().catch(() => null) : null;
  if (!bundle || !Array.isArray(bundle.entries)) return null;
  return new Map(bundle.entries
    .filter((e) => e && typeof e.id === 'number')
    .map((e) => [e.id, e]));
}

/**
 * Rebuild every round shard whose stamp no longer matches D1, and the
 * manifest over them. Cron-only: one writer, no locking.
 *
 * A shard is stamped with what it actually contains, not with what D1
 * says it should — so a rebuild that came up short (a blob not written
 * yet, a backfill that ran out of budget) stamps differently from the
 * round's D1 stamp and is retried on the next tick until it converges.
 *
 * @returns {manifest, changed: [round], removed: [round]}
 */
async function materialize(env, t) {
  const tid = t.id;
  const { results: rows } = await env.DB.prepare(
    "SELECT id, round FROM files WHERE tournament_id = ?1 AND kind IN ('qbj', 'combined') AND error IS NULL ORDER BY round, id"
  ).bind(tid).all();

  const byRound = new Map();
  for (const f of rows) {
    if (!byRound.has(f.round)) byRound.set(f.round, []);
    byRound.get(f.round).push(f);
  }

  const prev = await readManifest(env, tid);
  // A pending TO rebuild re-posted the games' public copies under their
  // existing ids, so the D1 stamps did not move: rebuild every round
  // regardless. The marker is cleared BEFORE the blobs are read, so a
  // rebuild request landing mid-tick either has its blobs read here or
  // leaves a fresh marker for the next tick — never neither.
  const forced = Boolean(await env.DATA.head(rebuildKey(tid)));
  if (forced) await env.DATA.delete(rebuildKey(tid));
  const manifest = { rounds: {}, at: Date.now() };
  const changed = [];
  const removed = [];
  let legacy;             // undefined = not looked for yet, null = none
  let backfill = PUB_BACKFILL_PER_TICK;

  for (const [n, fs] of [...byRound].sort((a, b) => a[0] - b[0])) {
    const want = statsVersion(fs);
    if (!forced && prev.rounds[n] === want) { manifest.rounds[n] = want; continue; }

    const entries = new Array(fs.length).fill(null);
    await Promise.all(fs.map(async (f, i) => {
      const obj = await env.DATA.get(pubGameKey(tid, f.id));
      if (obj) entries[i] = await obj.json().catch(() => null);
    }));

    const gaps = entries.map((e, i) => (e ? -1 : i)).filter((i) => i >= 0);
    if (gaps.length) {
      if (legacy === undefined) legacy = await readLegacyBundle(env, tid);
      for (const i of gaps) {
        if (backfill <= 0) break;
        const entry = legacy && legacy.get(fs[i].id);
        if (!entry) continue;
        entries[i] = entry;
        backfill -= 1;
        await putPubGame(env, tid, entry);
      }
    }

    const kept = entries.filter(Boolean);
    if (kept.length < fs.length) {
      console.log('tournament', tid, 'round', n, 'is missing',
        fs.length - kept.length, 'public game blobs; will retry next tick');
    }
    const got = (kept.length ? kept[kept.length - 1].id : 0) + ':' + kept.length;
    await env.DATA.put(roundBlobKey(tid, n), JSON.stringify({ v: got, round: n, entries: kept }), {
      httpMetadata: { contentType: 'application/json' },
    });
    manifest.rounds[n] = got;
    changed.push(n);
  }

  for (const n of Object.keys(prev.rounds)) {
    if (manifest.rounds[n] === undefined) {
      await env.DATA.delete(roundBlobKey(tid, n));
      removed.push(Number(n));
    }
  }
  await env.DATA.put(manifestKey(tid), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
  return { manifest, changed, removed };
}

/* ---------- public snapshots on GitHub (optional) ----------
   Moves the audience-scaling bytes off the Worker: every blob the public
   page refetches when stamps move (round shards / schedule / cats /
   roster) is
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

// Flag a tournament for the next cron tick. Called from every mutation
// that changes derived public data; a cheap single UPDATE, so it's just
// awaited inline. Unconditional even with snapshots off — the tick also
// materializes the round shards the public page reads, which is why
// migrate-pub.sql is no longer optional.
async function markPub(env, tid) {
  await env.DB.prepare('UPDATE tournaments SET pub_dirty = 1 WHERE id = ?1').bind(tid).run();
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

// A slow GitHub must fail the tick — which re-flags the tournament and
// tries again next minute — rather than hang it: a hung tick outlives
// the minute and the next one starts on top of it. GitHub being down
// was always handled; this is for it being merely degraded.
const GITHUB_TIMEOUT_MS = 15000;

async function github(env, method, path, body, bearer) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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
// advertises — { sha, at, rounds, schedule, cats, roster, roster_at } —
// once the batch's commit sha is known. Stamps mirror pubState, and
// `rounds` names exactly the round shards the branch holds (the page
// falls back to the Worker route for any round absent from it).
//
// Takes the manifest materialize() just wrote, so the publisher commits
// the shards as they were built rather than re-deriving anything.
//
// shardsOnly: a set's mirror whose own page is off. The set page reads
// its round shards and nothing else, so nothing else is committed — and
// anything a previous full publish left on the branch is deleted.
async function buildPublish(env, t, manifest, shardsOnly = false) {
  const prev = (() => {
    try { return JSON.parse(t.pub_snapshot) || null; } catch (e) { return null; }
  })();

  const [schedObj, catsObj, rosterObj] = shardsOnly ? [null, null, null] : await Promise.all([
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
  const schedStamp = schedObj ? schedObj.uploaded.getTime() : null;
  const rosterStamp = rosterObj ? rosterObj.uploaded.getTime() : null;

  // A blob whose stamp matches the last publish is already at the branch
  // head (base_tree carries it forward), so re-uploading it only spends
  // GitHub API calls — the difference between a broadcast-only republish
  // costing 6 calls and 13, and what keeps a 30-tournament day under the
  // App's 5,000/hour rate limit. Skips need prev.sha: without a prior
  // commit the stamps have nothing on the branch to vouch for.
  const had = {
    schedule: prev && prev.schedule !== null && prev.schedule !== undefined,
    cats: prev && prev.cats !== null && prev.cats !== undefined,
    roster: prev && prev.roster,
  };
  const same = prev && prev.sha ? {
    schedule: had.schedule && prev.schedule === schedStamp,
    cats: had.cats && prev.cats === catsStamp,
    roster: had.roster && prev.roster_at === rosterStamp,
  } : {};
  const entries = [];
  const want = (name, body, key) => {
    if (body !== null) { if (!same[key]) entries.push([`${t.slug}/${name}`, body, false]); }
    else if (had[key]) entries.push([`${t.slug}/${name}`, null, true]);
  };

  // Round shards: publish the ones whose stamp moved, carry the rest
  // forward, and delete the ones that no longer exist. Same skip rule as
  // the blobs above, one round at a time — which is the whole point, a
  // round that finished hours ago is never uploaded again.
  const prevRounds = (prev && prev.sha && prev.rounds) || {};
  const rounds = {};
  for (const [n, v] of Object.entries(manifest.rounds)) {
    if (prevRounds[n] === v) { rounds[n] = v; continue; }
    const obj = await env.DATA.get(roundBlobKey(t.id, n));
    const body = obj ? await obj.arrayBuffer() : null;
    if (body === null || body.byteLength > PUB_MAX_SNAPSHOT) continue; // page falls back to the Worker
    entries.push([`${t.slug}/r${n}.json`, body, false]);
    rounds[n] = v;
  }
  for (const n of Object.keys(prevRounds)) {
    if (manifest.rounds[n] === undefined) entries.push([`${t.slug}/r${n}.json`, null, true]);
  }
  // One-time tidy: a tournament published under the pre-shard layout has
  // a whole-tournament bundle.json at the branch head that nothing reads
  // any more.
  if (prev && prev.bundle) entries.push([`${t.slug}/bundle.json`, null, true]);

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
        rounds: sha === null ? {} : rounds,
        schedule: schedStamp,
        cats: catsStamp,
        roster: Boolean(rosterObj),
        roster_at: rosterStamp,
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
  const out = [
    [`${t.slug}/bundle.json`, null, prev && prev.bundle], // pre-shard layout
    [`${t.slug}/schedule.json`, null, prev && prev.schedule !== null && prev.schedule !== undefined],
    [`${t.slug}/cats.json`, null, prev && prev.cats !== null && prev.cats !== undefined],
    [`${t.slug}/roster.json`, null, prev && prev.roster],
  ];
  for (const n of Object.keys((prev && prev.rounds) || {})) {
    out.push([`${t.slug}/r${n}.json`, null, true]);
  }
  return out;
}

// Cron tick: for dirty tournaments, rebuild the round shards the public
// page reads (materialize) and then — if snapshots are configured —
// publish what moved. Dirty unpublished ones with a snapshot on the
// branch are retracted instead. A few per minute so a tick stays bounded
// (the rest carry their flag to the next tick).
//
// Materializing is not optional: with snapshots off it is the only thing
// that makes an uploaded game public, so it runs first and independently
// of the GitHub half. The publish half is ONE commit regardless of
// tournament count: a single batch of every tournament's changed shards
// and retractions. Per-tournament commits would spend the ~10-call
// Git-Data-API overhead once per tournament; batching spends it once per
// tick, which is what keeps a fully loaded cron inside GitHub's
// 5,000 requests/hour App limit.
//
// A set's mirror is in the queue whether or not its own page is public:
// its shards are what the set's editors (and, once the set is published,
// the set page) read. Its blobs go to GitHub when either flag says
// public — the mirror's own, or its set's.
async function tickDirty(env) {
  await tickTournaments(env);
  await tickSets(env);
}

async function tickTournaments(env) {
  const { results } = await env.DB.prepare(
    // set_published: the set's page shows this mirror — the set is public
    // and the editor has not hidden the mirror from it
    'SELECT t.*, (s.published = 1 AND m.hidden = 0) AS set_published FROM tournaments t ' +
    'LEFT JOIN sets s ON s.id = t.set_id LEFT JOIN set_mirrors m ON m.tournament_id = t.id ' +
    'WHERE t.pub_dirty = 1 AND (t.published = 1 OR t.pub_snapshot IS NOT NULL OR t.set_id IS NOT NULL) ' +
    'ORDER BY t.created DESC LIMIT 4'
  ).all();
  if (!results.length) return;
  const reflag = (id) =>
    env.DB.prepare('UPDATE tournaments SET pub_dirty = 1 WHERE id = ?1').bind(id).run();
  // Claim before working: a mutation mid-tick re-sets the flag and the
  // next tick picks it up, instead of the clear losing its write.
  for (const t of results) {
    await env.DB.prepare('UPDATE tournaments SET pub_dirty = 0 WHERE id = ?1').bind(t.id).run();
    // A mirror that moved makes its half of the set's state blob stale.
    // Recorded in D1, not handed to tickSets in memory, so a rebuild that
    // fails (or a tick that dies in between) still knows what to re-read.
    if (t.set_id) {
      await env.DB.prepare('UPDATE set_mirrors SET state_dirty = 1 WHERE tournament_id = ?1').bind(t.id).run();
      await markSet(env, t.set_id);
    }
  }

  const pubs = [];     // { t, entries, snapOf }
  const retracts = []; // { t, entries }
  const snapshots = snapshotsEnabled(env);
  for (const t of results) {
    try {
      const isPublic = t.published || t.set_published;
      const { manifest } = isPublic || t.set_id ? await materialize(env, t) : {};
      if (!snapshots) continue;
      // public only through its set: the games go out, the mirror's own
      // page (schedule, roster, category map) stays its TD's call
      if (isPublic) pubs.push({ t, ...(await buildPublish(env, t, manifest, !t.published)) });
      else if (t.pub_snapshot) retracts.push({ t, entries: retractEntries(t) });
    } catch (e) {
      console.log('tick failed for', t.slug, e.message);
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

const cleanSlug = (s) => String(s || '').trim().toLowerCase();

// {status, message} for a slug + name pair that can't be created, else
// null. Shared by tournaments, sets, and mirrors started from an invite.
function slugNameError(slug, name) {
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
    return { status: 400, message: 'slug must be 3-40 chars: a-z, 0-9, hyphens' };
  }
  // the in-browser demo tournament owns t.html?t=demo
  if (slug === 'demo') return { status: 409, message: 'slug is reserved' };
  if (!name) return { status: 400, message: 'name required' };
  return null;
}

// The tournament row and its credentials. `set` ({id, key}) makes it a
// set's mirror: it records the set and carries the set's content key
// under its own (see blobKey). Returns null when the slug is taken.
async function insertTournament(env, { slug, name, ip, settings, set }) {
  const adminSecret = randToken();
  const created = Date.now();
  // Content key: minted here, stored only wrapped (see "question text
  // encryption"). D1 gets the secret's hash, never the secret.
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const out = await env.DB.prepare(
      'INSERT INTO tournaments (slug, name, admin_secret, admin_wrap, creator_ip, settings, created, set_id, set_key_enc) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
    ).bind(slug, name, await secretHash(adminSecret), await wrapKey(adminSecret, 'admin', rawKey),
      ip, JSON.stringify(settings || {}), created,
      set ? set.id : null, set ? await encField(rawKey, b64bytes(set.key)) : null).run();
    return { id: out.meta.last_row_id, adminSecret, created, rawKey };
  } catch (e) {
    return null;
  }
}

async function createTournament(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const slug = cleanSlug(body.slug);
  const name = cleanName(body.name);
  const bad = slugNameError(slug, name);
  if (bad) return err(env, bad.status, bad.message);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const since = Date.now() - 24 * 3600 * 1000;
  // set mirrors are counted against their own budget (startInvite)
  const { results } = await env.DB.prepare(
    'SELECT SUM(creator_ip = ?1) AS mine, COUNT(*) AS all_ips FROM tournaments WHERE created > ?2 AND set_id IS NULL'
  ).bind(ip, since).all();
  if ((results[0].mine || 0) >= CREATE_PER_IP_DAY || results[0].all_ips >= CREATE_GLOBAL_DAY) {
    return err(env, 429, 'creation limit reached, try again tomorrow');
  }

  const made = await insertTournament(env, { slug, name, ip, settings: body.settings });
  if (!made) return err(env, 409, 'slug already taken');
  return json(env, {
    id: made.id, slug, name,
    admin_secret: made.adminSecret, closes: made.created + ADMIN_TTL,
  });
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
  const [buckets, rounds, files, catsHead, sets, setPackets] = await Promise.all([
    env.DB.prepare('SELECT id, room_name, secret, secret_enc, created FROM buckets WHERE tournament_id = ?1 ORDER BY id').bind(id).all(),
    env.DB.prepare('SELECT number, packet_name, packet_r2_key FROM rounds WHERE tournament_id = ?1 ORDER BY number').bind(id).all(),
    env.DB.prepare('SELECT id, bucket_id, round, kind, r2_key, filename, size, error, created, summary FROM files WHERE tournament_id = ?1 ORDER BY created DESC').bind(id).all(),
    env.DATA.head(`t/${id}/catmap.json`),
    t.set_id
      ? env.DB.prepare('SELECT slug, name, published, settings FROM sets WHERE id = ?1').bind(t.set_id).all()
      : { results: [] },
    t.set_id
      ? env.DB.prepare(
        'SELECT packet, version, name, r2_key, retired FROM set_packets WHERE set_id = ?1 ORDER BY packet, version'
      ).bind(t.set_id).all()
      : { results: [] },
  ]);
  // packets from before category extraction existed — or from before
  // the current parser (version in R2 custom metadata): backfill once,
  // off the response path
  const staleCats = !catsHead || (catsHead.customMetadata || {}).v !== CATMAP_VERSION;
  if (staleCats && ctx && rounds.results.some((r) => /\.json$/i.test(r.packet_name))) {
    ctx.waitUntil(rebuildCatmap(env, t));
  }
  // Room secrets go back to the TO in the clear — they ARE the room
  // links — but the credential column holds only the hash on new rows;
  // the plaintext travels encrypted under the content key this request
  // just unwrapped (secret_enc). Legacy rows carry the secret itself.
  const rooms = await Promise.all(buckets.results.map(async ({ secret_enc, ...b }) => ({
    ...b, secret: secret_enc && t.ckey ? await decField(t.ckey, secret_enc) : b.secret,
  })));
  const { admin_secret, creator_ip, admin_wrap, buzz_wrap, ckey, skey, set_key_enc, ...pub_t } = t;
  return json(env, {
    // `set` is what the dashboard's mirror notice reads: whose packets
    // these are, that the games are shared with that set's editors, and
    // whether those editors have switched mirror buzzpoints off.
    // set_packets lets the TD put any of the set's packets on any round.
    tournament: {
      ...pub_t, closes: t.created + ADMIN_TTL,
      set: sets.results[0] ? {
        slug: sets.results[0].slug, name: sets.results[0].name, published: sets.results[0].published,
        lock_buzz: mirrorBuzzLocked(sets.results[0].settings),
      } : null,
    },
    set_packets: setPackets.results,
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
  if (body.rulings !== undefined) {
    const cleaned = cleanRulings(body.rulings);
    if (cleaned.error) return err(env, 400, cleaned.error);
    sets.push('rulings = ?'); binds.push(cleaned.json);
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
   no category data, so their rounds simply stay absent. One packet at a
   time touches a round, but two rounds can land at once, so this one
   keeps its conditional-write retry. */

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
async function rebuildCatmap(env, t) {
  const tid = t.id;
  const { results } = await env.DB.prepare(
    'SELECT number, packet_r2_key, packet_name FROM rounds WHERE tournament_id = ?1'
  ).bind(tid).all();
  const map = { rounds: {} };
  for (const row of results) {
    if (!/\.json$/i.test(row.packet_name)) continue;
    const obj = await env.DATA.get(row.packet_r2_key);
    if (!obj) continue;
    const cats = packetCategories(
      await readBlob(obj, await blobKey(t, row.packet_r2_key)), row.packet_name);
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
  // Ownership boundary: only this tournament's prefix is reachable —
  // plus, on a set's mirror, the set packets its own rounds point at.
  if (!key.startsWith(`t/${t.id}/`)) {
    const { results } = t.set_id && key.startsWith(`s/${t.set_id}/packet/`)
      ? await env.DB.prepare(
        'SELECT 1 AS ok FROM rounds WHERE tournament_id = ?1 AND packet_r2_key = ?2'
      ).bind(t.id, key).all()
      : { results: [] };
    if (!results.length) return err(env, 403, 'bad key');
  }
  const obj = await env.DATA.get(key);
  if (!obj) return err(env, 404, 'no such file');
  const dl = url.searchParams.get('dl') || key.split('/').pop();
  return storedFileResponse(env, obj, await blobKey(t, key), dl, url.searchParams.get('part'));
}

// A stored blob as a download, decrypted with `rawKey`. part=qbj|game
// splits a combined reader upload (.qbtd.json = {qbj, game}) into the
// file consumers actually use. Only ever behind a credential that holds
// the tournament's key — the TO's link, or the link of the set it
// mirrors: the game half carries the packet text.
async function storedFileResponse(env, obj, rawKey, dl, part) {
  if (part !== 'qbj' && part !== 'game') return blobResponseDec(env, obj, rawKey, dl);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readBlob(obj, rawKey)));
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
    await env.DATA.delete(pubGameKey(id, fileId));
    await markPub(env, id);
  }
  return json(env, { ok: true });
}

// Escape hatch for drift: the dashboard re-posts the public copies of
// games it fetched from the stored files, and the next tick rebuilds
// every shard from them. The rebuild marker is what forces that —
// otherwise unchanged round stamps would skip the rebuild. The manifest
// itself is left alone, so viewers keep the current shards until the
// rebuilt ones exist rather than getting an empty page for a tick.
//
// Posted in batches, because each entry is its own write: MAX_REBUILD
// bounds one request's R2 traffic, and app/js/admin.js chunks to match.
async function putBundle(request, env, t) {
  const id = t.id;
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BUNDLE) return err(env, 413, 'bundle too large');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return err(env, 400, 'bad json'); }
  if (!parsed || !Array.isArray(parsed.entries)) return err(env, 400, 'bad bundle');
  if (parsed.entries.length > MAX_REBUILD) {
    return err(env, 400, `post at most ${MAX_REBUILD} games per request`);
  }
  const entries = parsed.entries.filter((e) => e && typeof e === 'object' && Number.isInteger(e.id));
  // The dashboard rebuilds from admin downloads, which keep match notes;
  // no public copy may (stripMatchNotes).
  await Promise.all(entries.map((e) => putPubGame(env, id, {
    id: e.id, round: e.round, room: e.room, filename: e.filename, qbj: stripMatchNotes(e.qbj),
  })));
  // After the blobs, so a materialize that sees the marker sees them too.
  await env.DATA.put(rebuildKey(id), '{}', { httpMetadata: { contentType: 'application/json' } });
  await markPub(env, id);
  return json(env, { entries: entries.length });
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
// A set's pool: same blob shape, under the set's key. Starting a mirror
// copies it (without the usage log) into the new tournament's own pool.
const SET_TB_KEY = (sid) => `s/${sid}/tiebreakers.json`;

function emptyTbPool() {
  return { v: 1, seq: { t: 0, b: 0 }, tossups: [], bonuses: [], uses: [] };
}

async function readTbPool(env, key, rawKey) {
  const obj = await env.DATA.get(key);
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

async function writeTbPool(env, key, rawKey, mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { cur, pool } = await readTbPool(env, key, rawKey);
    const out = mutate(pool);
    if (out && out.error) return out;
    const text = JSON.stringify(pool);
    if (text.length > MAX_TB_BLOB) return { error: 'tiebreaker pool too large' };
    const onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    try {
      const put = await putBlob(env, key, text, 'application/json', rawKey, { onlyIf });
      if (put) return { error: null, pool };
    } catch (e) { /* precondition failed -> retry */ }
  }
  console.log('tiebreaker update lost the retry race for', key);
  return { error: 'concurrent update, try again' };
}

// POST /a/:secret/tiebreakers?name=... (and /s/:secret/tiebreakers, for a
// set's pool) — split a packet JSON into pool questions. Repeated uploads
// append (ids keep counting); the same rules as the reader's own packet
// validation, so a pool question is guaranteed to load in MODAQ.
async function uploadTiebreakers(request, url, env, poolKey, rawKey) {
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
  const out = await writeTbPool(env, poolKey, rawKey, (pool) => {
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

async function deleteTiebreakers(env, poolKey) {
  await env.DATA.delete(poolKey);
  return json(env, { ok: true });
}

// A set's pool is emptied, not deleted: its id counter must survive, or a
// re-upload would hand out TU1 again and every mirror's "heard by" log
// would attach to a different question.
async function clearSetTiebreakers(env, s) {
  const out = await writeTbPool(env, SET_TB_KEY(s.id), s.ckey, (pool) => {
    pool.tossups = [];
    pool.bonuses = [];
  });
  if (out.error) return err(env, 400, out.error);
  return json(env, { ok: true });
}

// The pool a tournament's rooms and dashboard see. On a set's mirror that
// is the SET's pool — read live, so questions the editors add mid-season
// reach mirrors already running — followed by the TD's own; the set's
// ids are prefixed so the two counters can't collide, and the usage log
// (the mirror's alone) refers to the merged ids. `holder` is a tournament
// or bucket row ({ckey, set_key_enc}); returns null when there is nothing.
async function mergedTbPool(env, holder, tid, setId) {
  const own = await readTbPool(env, TB_KEY(tid), holder.ckey);
  const pool = own.pool;
  if (setId) {
    const fromSet = await readTbPool(env, SET_TB_KEY(setId), await blobKey(holder, SET_TB_KEY(setId)));
    const tag = (q) => ({ ...q, id: 'S-' + q.id, set: true });
    pool.tossups = [...fromSet.pool.tossups.map(tag), ...pool.tossups];
    pool.bonuses = [...fromSet.pool.bonuses.map(tag), ...pool.bonuses];
  }
  return pool.tossups.length || pool.bonuses.length ? pool : null;
}

async function adminTiebreakers(env, t) {
  const pool = await mergedTbPool(env, t, t.id, t.set_id);
  return pool ? json(env, pool) : err(env, 404, 'no tiebreakers');
}

// GET /b/:secret/tiebreakers — the reader's copy of the pool: full
// question text (packet trust level) plus the usage log, so the mod can
// see which teams have already heard each question.
async function bucketTiebreakers(env, secret) {
  const b = await getBucketRow(env, secret);
  if (!b) return err(env, 404, 'bad link');
  if (bucketClosed(b)) return err(env, 410, 'room closed');
  const pool = await mergedTbPool(env, b, b.tournament_id, b.set_id);
  return pool ? json(env, pool) : err(env, 404, 'no tiebreakers');
}

// A reader upload reported which pool questions its game read. One game =
// one log entry set: a re-export of the same game (same round + teams)
// replaces its earlier entries instead of double-logging.
async function logTbUses(env, b, roomName, round, teams, usedIds) {
  const tid = b.tournament_id;
  const rawKey = b.ckey;
  // the ids a game may report: the merged pool's. On a mirror with only
  // the set's questions the log still lives in the mirror's own blob,
  // which this write creates.
  const merged = await mergedTbPool(env, b, tid, b.set_id);
  if (!merged) return; // no pool: nothing to log against (and nothing to clear)
  const known = new Set([...merged.tossups, ...merged.bonuses].map((q) => q.id));
  const pairKey = (ts) => [...ts].sort().join('\n');
  const gameKey = round + '\n' + pairKey(teams);
  await writeTbPool(env, TB_KEY(tid), rawKey, (pool) => {
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
    't.current_round, t.roster_r2_key, t.settings, t.announce, t.set_id, t.set_key_enc ' +
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
  let summary = null;  // files.summary: teams, score, protests (matchSummary)
  let tbReport = null; // {teams, used} from a reader upload's tb field
  if (isQbj || isCombined) {
    const parsed = extractMatch(new TextDecoder().decode(buf));
    error = parsed.error;
    qbjObj = parsed.qbj || null;
    if (!error) summary = matchSummary(parsed.match, isCombined && parsed.root ? parsed.root.protests : null);
    if (!error && isCombined && parsed.root && parsed.root.tb
      && Array.isArray(parsed.root.tb.used) && parsed.teams.every(Boolean)) {
      tbReport = {
        teams: parsed.teams,
        used: parsed.root.tb.used.filter((x) => typeof x === 'string').slice(0, 200),
      };
    }
  }

  // Encrypted at rest: a combined upload's game half carries the full
  // packet text. The extracted qbj half (text-free) goes to this game's
  // public blob below in plaintext — that is the only public copy.
  const key = `t/${b.tournament_id}/bucket/${b.id}/${randToken(8)}-${filename}`;
  await putBlob(env, key, buf, 'application/json', b.ckey);
  const out = await env.DB.prepare(
    'INSERT INTO files (tournament_id, bucket_id, round, kind, r2_key, filename, size, error, created, summary) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
  ).bind(b.tournament_id, b.id, round, kind, key, filename, buf.byteLength, error, Date.now(), summary).run();
  const fileId = out.meta.last_row_id;

  if (qbjObj && !error) {
    // One small write of this game alone — no shared object to read back,
    // re-serialize or lose a race on. The cron folds it into its round's
    // shard on the next tick.
    await putPubGame(env, b.tournament_id, {
      id: fileId, round, room: b.room_name, filename, qbj: stripMatchNotes(qbjObj),
    });
    await markPub(env, b.tournament_id);
  }
  if (tbReport) {
    await logTbUses(env, b, b.room_name, round, tbReport.teams, tbReport.used);
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
  // On a set's mirror, the first room to be handed a round pins it: from
  // here on some moderator is reading this text, so a fix the editors
  // upload must not swap the round underneath the others (mirrorsOpenFor).
  // A write only the first time; the WHERE makes every later one a no-op.
  if (b.set_key_enc) {
    await env.DB.prepare(
      'UPDATE rounds SET served = 1 WHERE tournament_id = ?1 AND number = ?2 AND served = 0'
    ).bind(b.tournament_id, round).run();
  }
  return blobResponseDec(env, obj, await blobKey(b, results[0].packet_r2_key), results[0].packet_name);
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
    // set_settings: see buzzConfig.
    'SELECT t.*, s.settings AS set_settings FROM tournaments t LEFT JOIN sets s ON s.id = t.set_id ' +
    'WHERE t.slug = ?1 AND t.published = 1'
  ).bind(slug).all();
  return results[0] || null;
}

/* ---------- buzzpoints gate ----------
   Password is the ONLY mode: buzzpoints are off or gated, never open.
   The gated resource is packet text; buzz positions themselves ride in
   the public round shards.

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

// A set's editors may not want question text shown anywhere while later
// mirrors are still to play: settings.lockMirrorBuzz on the SET switches
// its mirrors' own buzzpoints off, whatever their TDs have configured.
function mirrorBuzzLocked(setSettings) {
  try { return Boolean((JSON.parse(setSettings || '{}') || {}).lockMirrorBuzz); } catch (e) { return false; }
}

// `t` is any row with a settings column — a tournament or a set. A
// tournament row from getPublishedTournament carries its set's settings
// (set_settings), which can veto the tournament's own.
function buzzConfig(t) {
  if (t.set_settings && mirrorBuzzLocked(t.set_settings)) return null;
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

// buzz_v: a one-way stamp that moves with the password (see above).
async function buzzStamp(b) {
  return (await sha256Hex('buzzv:' + b.salt)).slice(0, 12);
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

// Rounds every room has turned in, from the clean game rows ({round,
// bucket_id}), the room count, the schedule (or null) and any extra
// candidate rounds. The rule roundDone applies to one round, over all of
// them at once: the /pub state's buzz_done, and a set's per-mirror copy.
function doneRounds(rows, roomCount, sched, candidates = []) {
  const inByRound = new Map();
  for (const f of rows) {
    if (!inByRound.has(f.round)) inByRound.set(f.round, new Set());
    inByRound.get(f.round).add(f.bucket_id);
  }
  return [...new Set([...inByRound.keys(), ...candidates])].filter((rn) => {
    const scheduled = scheduledGames(sched, rn);
    const expected = scheduled !== null ? scheduled : roomCount;
    return (inByRound.get(rn) || new Set()).size >= expected;
  }).sort((x, y) => x - y);
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

// The password gate itself, for a tournament's qpacket route and a set's:
// null when the request may proceed, else the response to send. `scope`
// keys the attempt counter (a set's slugs are their own namespace).
async function buzzGate(request, env, scope, b) {
  // Guessing the password is an online attack, so cap attempts per IP.
  // Generous enough for a viewer opening every round of a long tournament,
  // tight enough that a wordlist is hopeless. Two limits of what this is:
  // Cloudflare's rate limiter counts per colo rather than globally, and it
  // runs inside the Worker, so it protects the password but not the
  // request budget — a WAF rate-limiting rule on this path is the outer
  // layer for that (README).
  if (env.BUZZ_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.BUZZ_LIMIT.limit({ key: scope + ':' + ip });
    if (!success) return err(env, 429, 'too many attempts, wait a minute');
  }
  if (!(await buzzAllowed(request, b))) return err(env, 401, 'bad password');
  return null;
}

// A gated packet, decrypted with the key the verified token unwraps from
// `wrap` (buzz_wrap, written when the password was set). `holderOf` turns
// that key into blobKey's holder. A missing or mismatched wrap means the
// password was set by a client that never sent the token — setting it
// again repairs it.
async function gatedPacket(request, env, obj, key, name, wrap, holderOf) {
  let rawKey = null;
  if (blobEnc(obj)) {
    if (!wrap) return err(env, 409, 'packets locked — set the buzzpoints password again');
    try {
      const unwrapped = await unwrapKey((request.headers.get('Authorization') || '').slice(5), 'buzz', wrap);
      rawKey = await blobKey(holderOf(unwrapped), key);
    } catch (e) {
      return err(env, 409, 'packets locked — set the buzzpoints password again');
    }
  }
  const res = await blobResponseDec(env, obj, rawKey, name);
  res.headers.set('Cache-Control', 'private, max-age=60');
  return res;
}

// Packet text for the buzzpoints tab: publish-gated, buzz-gated, and —
// same question-security rule as the moderator route — played rounds
// only, where played means every room has turned the round in.
async function pubQPacket(request, url, env, slug) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const b = buzzConfig(t);
  if (!b) return err(env, 404, 'not found');
  const denied = await buzzGate(request, env, slug, b);
  if (denied) return denied;
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
  // the token opens the tournament's key; on a mirror that opens the set's
  return gatedPacket(request, env, obj, results[0].packet_r2_key, results[0].packet_name,
    t.buzz_wrap, (ckey) => ({ ckey, set_key_enc: t.set_key_enc }));
}

// The /pub/:slug body. Served fresh on every page load or refresh: the
// page never polls, so this stays on the Worker where it can't be stale.
// `pub` is the snapshot descriptor to advertise: the route passes the
// stored one, the publisher passes the one it just committed.
async function pubStateBody(env, t, pub) {
  const [files, buckets, schedObj, packetRounds, catsHead, manifest] = await Promise.all([
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
    readManifest(env, t.id),
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
    buzzV = await buzzStamp(buzz);
    const sched = schedObj ? await schedObj.json().catch(() => null) : null;
    buzzDone = doneRounds(rows, buckets.results.length, sched,
      packetRounds.results.map((r) => r.number));
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
    // Stats: one stamp per round shard, so a client refetches the round
    // that moved and nothing else. These follow the materialized shards
    // rather than the file rows above — a game that has landed but is not
    // in a shard yet must not move a stamp, or the client would fetch,
    // find nothing new, and stop looking.
    rounds: manifest.rounds,
    // Fold of the same stamps, kept for anything that just wants to know
    // whether the stats moved at all.
    version: manifestVersion(manifest),
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

async function pubState(env, slug, ctx) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const pub = (() => {
    if (!env.SNAPSHOT_REPO || !t.pub_snapshot) return null;
    try {
      const snap = JSON.parse(t.pub_snapshot);
      return snap && snap.sha ? { repo: env.SNAPSHOT_REPO, ...snap } : null;
    } catch (e) { return null; }
  })();
  const body = await pubStateBody(env, t, pub);
  // Games but no shards to serve them from: a tournament published
  // before the round shards existed. Flag it so the next tick
  // materializes it — otherwise
  // a finished tournament, which nothing can mutate any more, would
  // have no way back. And don't let this answer cache for the week a
  // finished tournament normally gets, because it is about to change.
  const unbuilt = body.files.length > 0 && !Object.keys(body.rounds).length;
  if (unbuilt && ctx) ctx.waitUntil(markPub(env, t.id));
  return json(env, body, 200, unbuilt ? PUB_CACHE_LIVE : pubCache(t));
}

/* Games for the rounds asked for: ?n=3,4,5 -> {"rounds":[<shard>, ...]}.
   The stamps in /pub/:slug `rounds` say which ones to ask for, and a
   finished round's shard never changes again, so a refresh asks for the
   round in progress and nothing else.

   Each round may carry the stamp the caller expects, ?n=3@120:36,4@...,
   which this route ignores: it exists to make the URL differ whenever
   the stamp does, so the browser's HTTP cache (this response is
   max-age'd like every public blob) can never hand back the shard from
   before the round moved. Without it a viewer refreshing twice inside
   the cache window would hold a stale round while believing it current.

   Batched on purpose. Snapshot viewers fetch one file per round from
   GitHub, where per-round granularity is free; here, one request per
   round would mean a first load of a 17-round tournament costing 18
   Worker requests instead of 2 — and the Worker path is what serves
   every viewer of a tournament that predates snapshots, or any
   tournament while publishing is broken.

   The shards are streamed back to back, bytes as stored: no parse, no
   whole-tournament buffer, so serving all of a big tournament costs
   about what serving one round does. */
async function pubRounds(env, slug, url) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  return streamRounds(env, t.id, url, pubCache(t));
}

async function streamRounds(env, tid, url, cacheSeconds) {
  const asked = [...new Set((url.searchParams.get('n') || '').split(',')
    .map((s) => Number(s.split('@')[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 1000))];
  if (!asked.length) return err(env, 400, 'no rounds requested');
  if (asked.length > MAX_ROUNDS_PER_FETCH) {
    return err(env, 400, `at most ${MAX_ROUNDS_PER_FETCH} rounds per request`);
  }
  const objs = (await Promise.all(asked.sort((a, b) => a - b)
    .map((n) => env.DATA.get(roundBlobKey(tid, n))))).filter(Boolean);

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    try {
      await w.write(enc.encode('{"rounds":['));
      for (let i = 0; i < objs.length; i++) {
        if (i) await w.write(enc.encode(','));
        const reader = objs[i].body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await w.write(value);
        }
      }
      await w.write(enc.encode(']}'));
      await w.close();
    } catch (e) {
      // Viewer navigated away mid-stream, or a blob read failed: the
      // response is already committed, so all that's left is to end it.
      await w.abort(e).catch(() => {});
    }
  })();

  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'application/json');
  if (cacheSeconds) headers.set('Cache-Control', 'public, max-age=' + cacheSeconds);
  return new Response(readable, { status: 200, headers });
}

// Public per-game qbj download, served from the game's public blob
// rather than the stored file: that blob is exactly the public copy —
// validated match qbj only (a combined file's game half carries the full
// packet text), notes stripped, and readable without the content key
// that encrypts the stored file at rest. A file with no public blob
// (validation error, or a deletion) is simply not public.
async function pubQbj(env, slug, fileId) {
  const t = await getPublishedTournament(env, slug);
  if (!t) return err(env, 404, 'not found');
  const obj = await env.DATA.get(pubGameKey(t.id, fileId));
  const entry = obj ? await obj.json().catch(() => null) : null;
  if (!entry || !entry.qbj) return err(env, 404, 'no such file');
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

/* ---------- question sets (/s/*, /i/*, /pubset/*) ----------
   A set is the editor's side of a mirrored tournament: the packets are
   uploaded once, each mirror's TD gets an invite, and the games every
   mirror collects come back as set-wide stats, category stats and
   buzzpoints.

   Lifetimes. The set link lives a year (SET_TTL) — it is mirrored for a
   season. Nothing else changes clocks: an invite is NOT a tournament. It
   is a one-time, revocable credential the editor can mint weeks ahead.
   The TD either starts it when the event is close — which creates an
   ordinary tournament on the ordinary 48h clocks (ADMIN_TTL, BUCKET_TTL,
   FINAL_TTL), its rounds and reader game format already filled in — or
   uses it to join a tournament they have already made (joinSet).

   Packets, not rounds. The set numbers its PACKETS; which round a mirror
   plays a packet in is its TD's business (chooseSetPacket) — a site
   short on time skips one, a site with playoffs reorders them. A mirror
   starts with packet N on round N, and everything set-wide is keyed by
   the packet a game was read from, never by the round it was played in.

   Packets are referenced, not copied. A mirror's rounds rows point at
   the set's blobs (s/<sid>/packet/<packet>/v<version>-<token>/<name>),
   and the mirror carries the set's content key under its own (blobKey).
   Every upload is a new immutable version; the one before it is retired,
   never deleted. A fix therefore reaches the mirrors that have not
   started that packet yet — live ones only, skipping any round a TD gave
   a packet of their own — while a mirror whose rooms have opened it
   stays pinned to the text its buzz positions are recorded against.

   Questions keep their identity across all of that. Editors fix wording,
   move questions between packets, repacketize. Each packet version can
   carry a question map — per position, [question id, text revision] —
   so the set page follows a QUESTION wherever it was read: every play of
   it counts towards its conversion, buzz positions are laid only over
   the wording they were recorded against, and a question that moved or
   was reworded says so. The map is text-free and public (it lives in the
   category map blob). It is computed in the editor's browser, which has
   the text and no CPU budget to respect (app/engine/qmatch.js), against
   a ledger of every question the set has held — that one is question
   text, so it is stored under the set's key and only the set link reads
   it (getLedger / putQmap). A version without a map simply stands alone.

   Reading the games back needs no keys at all. A mirror's public copies
   and round shards are text-free plaintext (see "public game blobs"), so
   the set routes simply stream the mirrors' shards. The cron keeps one
   small state blob per set (s/<sid>/state.json: which mirrors, their
   shard stamps and snapshot shas, which packet version each round ran,
   which rounds each has finished) so the set page costs one D1 row and
   one R2 read however many mirrors there are — it is rebuilt only for
   the mirrors a tick actually touched, the rest carried forward.

   The stored game files are another matter: a reader upload's game half
   is MODAQ's full state, encrypted under the MIRROR's key. Editors get
   them too — a mirror hands its set its key when it starts or joins
   (set_mirrors.mirror_key_enc, the mirror's content key under the set's)
   — and the invite page and the mirror's dashboard both say so.

   Who sees what. The editor's link reads everything, always. The public
   set page exists while the set's own `published` flag is on, and then
   shows every mirror's results — a mirror TD's publish switch governs
   only that mirror's own page (schedule, broadcasts). Set-wide buzzpoint
   text is password-gated exactly like a tournament's (buzzGate), served
   for a packet version once any mirror has finished a round on it; when
   to hand that password out, with later mirrors still to play, is the
   editor's call — and the same editors can switch their mirrors' own
   buzzpoints off altogether (mirrorBuzzLocked). */

const setPacketPrefix = (sid) => `s/${sid}/packet/`;
const setCatmapKey = (sid) => `s/${sid}/catmap.json`;
const setStateKey = (sid) => `s/${sid}/state.json`;
const setLedgerKey = (sid) => `s/${sid}/ledger.json`;
const MAX_LEDGER = 8 * 1024 * 1024;
const MAX_QMAP = 500;                    // questions per packet side in a question map

// Flag a set's state blob for the next tick (the cron is its only writer).
async function markSet(env, sid) {
  await env.DB.prepare('UPDATE sets SET state_dirty = 1 WHERE id = ?1').bind(sid).run();
}

// Resolve a set link: s.ckey is the set's content key, per request.
async function getAdminSet(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sets WHERE admin_secret = ?1'
  ).bind(await secretHash(secret)).all();
  const s = results[0] || null;
  if (s) s.ckey = await unwrapKey(secret, 'set', s.admin_wrap);
  return s;
}
function setClosed(s) {
  return Date.now() > s.created + SET_TTL;
}

async function createSet(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const slug = cleanSlug(body.slug);
  const name = cleanName(body.name);
  const bad = slugNameError(slug, name);
  if (bad) return err(env, bad.status, bad.message);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { results } = await env.DB.prepare(
    'SELECT SUM(creator_ip = ?1) AS mine, COUNT(*) AS all_ips FROM sets WHERE created > ?2'
  ).bind(ip, Date.now() - 24 * 3600 * 1000).all();
  if ((results[0].mine || 0) >= SET_CREATE_PER_IP_DAY || results[0].all_ips >= SET_CREATE_GLOBAL_DAY) {
    return err(env, 429, 'creation limit reached, try again tomorrow');
  }

  const adminSecret = randToken();
  const created = Date.now();
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const out = await env.DB.prepare(
      'INSERT INTO sets (slug, name, admin_secret, admin_wrap, creator_ip, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(slug, name, await secretHash(adminSecret), await wrapKey(adminSecret, 'set', rawKey),
      ip, created).run();
    return json(env, {
      id: out.meta.last_row_id, slug, name,
      admin_secret: adminSecret, closes: created + SET_TTL,
    });
  } catch (e) {
    return err(env, 409, 'slug already taken');
  }
}

// A leaked set link: same move as rotateAdmin. Invites and mirrors are
// untouched — they hold the content key under their own secrets.
async function rotateSet(env, s) {
  const adminSecret = randToken();
  await env.DB.prepare(
    'UPDATE sets SET admin_secret = ?2, admin_wrap = ?3 WHERE id = ?1'
  ).bind(s.id, await secretHash(adminSecret), await wrapKey(adminSecret, 'set', s.ckey)).run();
  return json(env, { admin_secret: adminSecret });
}

async function getSet(env, s, ctx) {
  const [packets, mirrors, games, catsHead, tbHead] = await Promise.all([
    env.DB.prepare(
      'SELECT packet, version, name, retired, created, warnings, checked FROM set_packets WHERE set_id = ?1 ORDER BY packet, version'
    ).bind(s.id).all(),
    env.DB.prepare(
      'SELECT m.id, m.name, m.slug, m.host, m.event_date, m.invite_enc, m.created, m.revoked, m.hidden, m.started, ' +
      'm.tournament_id, m.mirror_key_enc IS NOT NULL AS files, t.slug AS t_slug, t.name AS t_name, ' +
      't.created AS t_created, t.current_round AS t_round, t.published AS t_published ' +
      'FROM set_mirrors m LEFT JOIN tournaments t ON t.id = m.tournament_id WHERE m.set_id = ?1 ORDER BY m.id'
    ).bind(s.id).all(),
    env.DB.prepare(
      "SELECT tournament_id, COUNT(*) AS n FROM files WHERE kind IN ('qbj', 'combined') AND error IS NULL " +
      'AND tournament_id IN (SELECT tournament_id FROM set_mirrors WHERE set_id = ?1 AND tournament_id IS NOT NULL) ' +
      'GROUP BY tournament_id'
    ).bind(s.id).all(),
    env.DATA.head(setCatmapKey(s.id)),
    env.DATA.head(SET_TB_KEY(s.id)),
  ]);
  // same lazy backfill as a tournament's map: a parser bump re-reads the
  // stored packets, off the response path
  const staleCats = !catsHead || (catsHead.customMetadata || {}).v !== CATMAP_VERSION;
  if (staleCats && ctx && packets.results.some((r) => /\.json$/i.test(r.name))) {
    ctx.waitUntil(rebuildSetCatmap(env, s));
  }
  const gamesBy = new Map(games.results.map((g) => [g.tournament_id, g.n]));
  const { admin_secret, admin_wrap, buzz_wrap, creator_ip, ckey, ...pub_s } = s;
  return json(env, {
    set: { ...pub_s, closes: s.created + SET_TTL },
    packets: packets.results,
    tiebreakers: !!tbHead,
    mirrors: await Promise.all(mirrors.results.map(async ({ invite_enc, t_slug, t_name, t_created, t_round, t_published, ...m }) => ({
      ...m,
      // an invite is only worth showing while it can still be used
      invite: !m.tournament_id && !m.revoked ? await decField(s.ckey, invite_enc) : null,
      tournament: m.tournament_id ? {
        id: m.tournament_id, slug: t_slug, name: t_name, created: t_created,
        current_round: t_round, published: !!t_published,
        closes: t_created + ADMIN_TTL, games: gamesBy.get(m.tournament_id) || 0,
        // until then its rooms can still upload — and a packet fix still
        // reaches its unplayed rounds (mirrorsOpenFor uses the same window)
        final: t_created + FINAL_TTL,
      } : null,
    }))),
  });
}

async function updateSet(request, env, s) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const sets = [];
  const binds = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return err(env, 400, 'bad name');
    sets.push('name = ?'); binds.push(name);
  }
  if (body.published !== undefined) {
    sets.push('published = ?'); binds.push(body.published ? 1 : 0);
  }
  if (body.settings !== undefined) {
    if (typeof body.settings !== 'object' || body.settings === null) return err(env, 400, 'bad settings');
    const text = JSON.stringify(body.settings);
    if (text.length > 4096) return err(env, 400, 'settings too large');
    sets.push('settings = ?'); binds.push(text);
    // same one-time token handoff as updateTournament: hash and wrap move together
    if (typeof body.buzz_token === 'string' && body.buzz_token
      && body.settings.buzz && body.settings.buzz.mode === 'password') {
      sets.push('buzz_wrap = ?');
      binds.push(await wrapKey(body.buzz_token, 'buzz', s.ckey));
    }
  }
  if (!sets.length) return err(env, 400, 'nothing to update');
  await env.DB.prepare(`UPDATE sets SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, s.id).run();
  if (body.published !== undefined) {
    // The set's flag decides whether its mirrors' blobs belong on GitHub:
    // queue them all, and the cron publishes or retracts each.
    await env.DB.prepare(
      'UPDATE tournaments SET pub_dirty = 1 WHERE id IN ' +
      '(SELECT tournament_id FROM set_mirrors WHERE set_id = ?1 AND tournament_id IS NOT NULL)'
    ).bind(s.id).run();
  }
  await markSet(env, s.id);
  return json(env, { ok: true });
}

/* ----- packets ----- */

// The set's category map: like a tournament's, keyed one level deeper —
// {packets: {"<packet>": {"<version>": {t, b, q}}}} — because mirrors of
// one set can have played different versions of a packet. `q` is the
// version's question map ({t: [[qid, rev] | null, ...], b: [...]}, see
// putQmap); t/b are absent for a packet with no category data. `patch`
// is merged into the version's entry. Text-free, so public.
async function updateSetCatmap(env, sid, packet, version, patch) {
  const key = setCatmapKey(sid);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await env.DATA.get(key);
    let map = { packets: {} };
    if (cur) {
      map = await cur.json().catch(() => ({ packets: {} }));
      if (!map || typeof map.packets !== 'object') map = { packets: {} };
    }
    const p = String(packet);
    if (!map.packets[p] || typeof map.packets[p] !== 'object') map.packets[p] = {};
    map.packets[p][String(version)] = { ...(map.packets[p][String(version)] || {}), ...patch };
    // an older parser's map stays marked old (see updateCatmap)
    const v = cur ? (cur.customMetadata || {}).v || '1' : CATMAP_VERSION;
    const onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    try {
      const put = await env.DATA.put(key, JSON.stringify(map), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { v },
        onlyIf,
      });
      if (put) return true;
    } catch (e) { /* precondition failed -> retry */ }
  }
  console.log('catmap update lost the retry race for set', sid);
  return false;
}

// Recompute every version's categories from the stored packets (a parser
// bump). Question maps are the editor's work, not derivable here, so
// they are carried over from the map being replaced.
async function rebuildSetCatmap(env, s) {
  const [{ results }, prevObj] = await Promise.all([
    env.DB.prepare('SELECT packet, version, r2_key, name FROM set_packets WHERE set_id = ?1').bind(s.id).all(),
    env.DATA.get(setCatmapKey(s.id)),
  ]);
  const prev = (prevObj && await prevObj.json().catch(() => null)) || { packets: {} };
  const map = { packets: {} };
  for (const row of results) {
    const old = ((prev.packets || {})[String(row.packet)] || {})[String(row.version)] || {};
    let cats = null;
    if (/\.json$/i.test(row.name)) {
      const obj = await env.DATA.get(row.r2_key);
      if (obj) cats = packetCategories(await readBlob(obj, s.ckey), row.name);
    }
    const entry = { ...(cats || {}), ...(old.q ? { q: old.q } : {}) };
    if (!Object.keys(entry).length) continue;
    if (!map.packets[String(row.packet)]) map.packets[String(row.packet)] = {};
    map.packets[String(row.packet)][String(row.version)] = entry;
  }
  // conditional on the map this rebuild started from: a question map
  // recorded meanwhile (putQmap) must not be rebuilt away — the next
  // dashboard load simply rebuilds again from the newer map
  try {
    await env.DATA.put(setCatmapKey(s.id), JSON.stringify(map), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { v: CATMAP_VERSION },
      onlyIf: prevObj ? { etagMatches: prevObj.etag } : { etagDoesNotMatch: '*' },
    });
  } catch (e) { return; }
  await markSet(env, s.id);
}

// A version's {t, b} categories from the set's map, or null.
function versionCats(setCats, packet, version) {
  const e = setCats && setCats.packets && setCats.packets[String(packet)]
    && setCats.packets[String(packet)][String(version)];
  return e && (Array.isArray(e.t) || Array.isArray(e.b)) ? { t: e.t || [], b: e.b || [] } : null;
}

// Where a change to one packet still reaches: [{tid, round}] — every
// round, in a started mirror still inside its own write window, that
// points at some version of the packet, has no clean game yet, and has
// not been handed to a room (rounds.served, set by bucketPacket). Once
// one moderator is reading a version the whole site stays on it, or that
// site's buzz positions would be recorded against two different texts.
// A round the TD gave a packet of their own never matches the prefix.
//
// `offer`: the packet is brand new to the set, so mirrors that have
// neither it nor anything on the round of the same number get it there —
// the default a mirror would have started with.
async function mirrorsOpenFor(env, sid, packet, offer) {
  const prefix = `${setPacketPrefix(sid)}${packet}/%`;
  const since = Date.now() - FINAL_TTL;
  const mirrors = '(SELECT tournament_id FROM set_mirrors WHERE set_id = ?1 AND tournament_id IS NOT NULL)';
  const played = "SELECT 1 FROM files f WHERE f.tournament_id = t.id AND f.kind IN ('qbj', 'combined') AND f.error IS NULL AND f.round = ";
  const { results: open } = await env.DB.prepare(
    'SELECT r.tournament_id AS tid, r.number AS round FROM rounds r JOIN tournaments t ON t.id = r.tournament_id ' +
    `WHERE t.created > ?2 AND t.id IN ${mirrors} AND r.served = 0 AND r.packet_r2_key LIKE ?3 ` +
    `AND NOT EXISTS (${played}r.number)`
  ).bind(sid, since, prefix).all();
  if (!offer) return open;
  const { results: fresh } = await env.DB.prepare(
    `SELECT t.id AS tid, ?4 AS round FROM tournaments t WHERE t.created > ?2 AND t.id IN ${mirrors} ` +
    'AND NOT EXISTS (SELECT 1 FROM rounds r WHERE r.tournament_id = t.id AND (r.number = ?4 OR r.packet_r2_key LIKE ?3)) ' +
    `AND NOT EXISTS (${played}?4)`
  ).bind(sid, since, prefix, packet).all();
  return [...open, ...fresh];
}

async function uploadSetPacket(request, url, env, s) {
  const packet = Number(url.searchParams.get('packet'));
  if (!Number.isInteger(packet) || packet < 1 || packet > 999) return err(env, 400, 'bad packet number');
  const filename = cleanFilename(url.searchParams.get('name'));
  const body = await request.arrayBuffer();
  if (!body.byteLength) return err(env, 400, 'empty body');
  if (body.byteLength > MAX_PACKET) return err(env, 413, 'packet too large');

  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n, MAX(CASE WHEN packet = ?2 THEN version END) AS v, ' +
    'SUM(packet = ?2 AND retired = 0) AS live FROM set_packets WHERE set_id = ?1'
  ).bind(s.id, packet).all();
  if (results[0].n >= MAX_SET_PACKETS) return err(env, 403, 'packet cap reached');
  const version = (results[0].v || 0) + 1;
  // new to the set, or back after being removed: offered to mirrors
  // that have nothing on its round
  const offer = !results[0].live;

  // the token keeps two racing uploads of one packet from sharing a blob
  const key = `${setPacketPrefix(s.id)}${packet}/v${version}-${randToken(6)}/${filename}`;
  await putBlob(env, key, body,
    request.headers.get('Content-Type') || 'application/octet-stream', s.ckey);
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE set_packets SET retired = 1 WHERE set_id = ?1 AND packet = ?2').bind(s.id, packet),
      env.DB.prepare(
        'INSERT INTO set_packets (set_id, packet, version, r2_key, name, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(s.id, packet, version, key, filename, Date.now()),
    ]);
  } catch (e) {
    // two uploads of one packet raced for the same version number
    return err(env, 409, 'concurrent upload, try again');
  }
  const cats = packetCategories(body, filename);
  if (cats) await updateSetCatmap(env, s.id, packet, version, cats);

  const open = await mirrorsOpenFor(env, s.id, packet, offer);
  for (const { tid, round } of open) {
    await env.DB.prepare(
      'INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(tournament_id, number) DO UPDATE SET packet_r2_key = ?3, packet_name = ?4 WHERE served = 0'
    ).bind(tid, round, key, filename).run();
    await updateCatmap(env, tid, round, cats);
    await markPub(env, tid);
  }
  await markSet(env, s.id);
  return json(env, { packet, version, filename, mirrors: new Set(open.map((o) => o.tid)).size });
}

// DELETE /s/:secret/packet?packet=N — take a packet out of the set (one
// dropped on the wrong slot, or merged away in a repacketizing). Its
// versions are retired, not deleted: a mirror that played one still
// points at it, and its questions keep their plays.
async function retireSetPacket(url, env, s) {
  const packet = Number(url.searchParams.get('packet'));
  if (!Number.isInteger(packet) || packet < 1 || packet > 999) return err(env, 400, 'bad packet number');
  const open = await mirrorsOpenFor(env, s.id, packet, false);
  await env.DB.prepare(
    'UPDATE set_packets SET retired = 1 WHERE set_id = ?1 AND packet = ?2'
  ).bind(s.id, packet).run();
  for (const { tid, round } of open) {
    await env.DB.prepare(
      'DELETE FROM rounds WHERE tournament_id = ?1 AND number = ?2 AND served = 0 AND packet_r2_key LIKE ?3'
    ).bind(tid, round, `${setPacketPrefix(s.id)}${packet}/%`).run();
    await updateCatmap(env, tid, round, null);
    await markPub(env, tid);
  }
  await markSet(env, s.id);
  return json(env, { ok: true, mirrors: new Set(open.map((o) => o.tid)).size });
}

// POST /s/:secret/packet/status {packet, v, warnings?, checked?} — the
// parse review's verdict on one version: how many warnings the browser's
// check raised, and whether a person has signed the packet off (checked:
// true stamps now, false clears). Display state, nothing reads it.
async function setPacketStatus(request, env, s) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const packet = Number(body.packet);
  const version = Number(body.v);
  const sets = [];
  const binds = [];
  if (body.warnings !== undefined) {
    const n = Number(body.warnings);
    if (!Number.isInteger(n) || n < 0 || n > 9999) return err(env, 400, 'bad warnings');
    sets.push('warnings = ?'); binds.push(n);
  }
  if (body.checked !== undefined) { sets.push('checked = ?'); binds.push(body.checked ? Date.now() : null); }
  if (!sets.length) return err(env, 400, 'nothing to update');
  const out = await env.DB.prepare(
    `UPDATE set_packets SET ${sets.join(', ')} WHERE set_id = ? AND packet = ? AND version = ?`
  ).bind(...binds, s.id, packet, version).run();
  if (!out.meta.changes) return err(env, 404, 'no such packet');
  return json(env, { ok: true });
}

async function setPacketRow(env, sid, url) {
  const packet = Number(url.searchParams.get('packet'));
  const version = Number(url.searchParams.get('v'));
  if (!Number.isInteger(packet) || !Number.isInteger(version)) return null;
  const { results } = await env.DB.prepare(
    'SELECT r2_key, name FROM set_packets WHERE set_id = ?1 AND packet = ?2 AND version = ?3'
  ).bind(sid, packet, version).all();
  return results[0] || null;
}

// GET /s/:secret/file?packet=&v= — any version, decrypted. Also what the
// editor's own buzzpoints view reads: the link is the key, no password.
async function setPacketFile(url, env, s) {
  const row = await setPacketRow(env, s.id, url);
  const obj = row ? await env.DATA.get(row.r2_key) : null;
  if (!obj) return err(env, 404, 'no such packet');
  return blobResponseDec(env, obj, s.ckey, row.name);
}

async function setTiebreakers(env, s) {
  const obj = await env.DATA.get(SET_TB_KEY(s.id));
  if (!obj) return err(env, 404, 'no tiebreakers');
  return blobResponseDec(env, obj, s.ckey, null);
}

/* ----- question identity: the ledger and the per-version question map ----- */

// GET /s/:secret/ledger — every question the set has held, with its text
// revisions: what the editor's browser matches a new upload against
// (app/engine/qmatch.js). Question text, so encrypted under the set's
// key and served to the set link alone. The Worker never parses it —
// a season's ledger is a megabyte, and the free tier's CPU budget is
// 10 ms — so the body is the blob's etag on the first line and the
// ledger's bytes after it (both empty when there is none), and the
// write below takes the same shape back. The etag lets that write
// refuse to overwrite a ledger someone else moved.
async function getLedger(env, s) {
  const obj = await env.DATA.get(setLedgerKey(s.id));
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  if (!obj) return new Response('\n', { status: 200, headers });
  const buf = await readBlob(obj, s.ckey);
  return new Response(new Blob([obj.etag + '\n', buf]), { status: 200, headers });
}

// {error} or a cleaned question-map side: [[qid, rev] | null, ...]
function cleanQmapSide(list) {
  if (!Array.isArray(list) || list.length > MAX_QMAP) return { error: 'bad question map' };
  const out = [];
  for (const e of list) {
    if (e === null) { out.push(null); continue; }
    if (!Array.isArray(e) || e.length !== 2 || !e.every((n) => Number.isInteger(n) && n > 0 && n < 1e9)) {
      return { error: 'bad question map' };
    }
    out.push([e[0], e[1]]);
  }
  return { list: out };
}

// POST /s/:secret/qmap — record one version's question map together
// with the ledger it was matched into. Body: one line of JSON {packet,
// v, q: {t, b}, etag}, then the ledger's bytes, which are stored as they
// come (see getLedger). The ledger goes first and conditionally: two
// editors matching at once must not both extend the same ledger (the
// second would reuse question ids the first just handed out) — the
// loser gets 409, refetches, and matches again.
async function putQmap(request, env, s) {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_LEDGER) return err(env, 413, 'ledger too large');
  const nl = raw.indexOf(10);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw.subarray(0, nl < 0 ? raw.length : nl))); }
  catch (e) { return err(env, 400, 'bad json'); }
  const ledger = nl < 0 ? new Uint8Array(0) : raw.subarray(nl + 1);
  const row = await setPacketRow(env, s.id, new URL(
    `http://x/?packet=${Number(body.packet)}&v=${Number(body.v)}`));
  if (!row) return err(env, 404, 'no such packet');
  const t = cleanQmapSide(body.q && body.q.t);
  const b = cleanQmapSide(body.q && body.q.b);
  if (t.error || b.error) return err(env, 400, t.error || b.error);
  // an object, by its first and last bytes — the contents are the browser's
  if (ledger.byteLength < 2 || ledger[0] !== 123 || ledger[ledger.byteLength - 1] !== 125) return err(env, 400, 'bad ledger');

  const onlyIf = body.etag ? { etagMatches: String(body.etag) } : { etagDoesNotMatch: '*' };
  let put = null;
  try {
    put = await putBlob(env, setLedgerKey(s.id), ledger, 'application/json', s.ckey, { onlyIf });
  } catch (e) { /* precondition failed */ }
  if (!put) return err(env, 409, 'ledger moved, match again');
  if (!(await updateSetCatmap(env, s.id, Number(body.packet), Number(body.v), { q: { t: t.list, b: b.list } }))) {
    return err(env, 409, 'concurrent update, try again');
  }
  await markSet(env, s.id);
  return json(env, { ok: true, etag: put.etag });
}

/* ----- mirrors and their invites ----- */

// {error} or the cleaned fields present in `body`.
function cleanMirrorFields(body) {
  const out = {};
  if (body.name !== undefined) {
    out.name = cleanName(body.name);
    if (!out.name) return { error: 'name required' };
  }
  if (body.slug !== undefined) {
    out.slug = cleanSlug(body.slug) || null;
    if (out.slug && slugNameError(out.slug, 'x')) return { error: slugNameError(out.slug, 'x').message };
  }
  if (body.host !== undefined) out.host = cleanName(body.host) || null;
  if (body.event_date !== undefined) {
    out.event_date = String(body.event_date || '').trim() || null;
    if (out.event_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.event_date)) return { error: 'date must be YYYY-MM-DD' };
  }
  return out;
}

async function createMirror(request, env, s) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const f = cleanMirrorFields({ name: body.name, slug: body.slug, host: body.host, event_date: body.event_date });
  if (f.error) return err(env, 400, f.error);
  if (!f.name) return err(env, 400, 'name required');
  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM set_mirrors WHERE set_id = ?1'
  ).bind(s.id).all();
  if (results[0].n >= MAX_SET_MIRRORS) return err(env, 403, 'mirror cap reached');

  const secret = randToken();
  const out = await env.DB.prepare(
    'INSERT INTO set_mirrors (set_id, name, slug, host, event_date, invite_secret, invite_wrap, invite_enc, created) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(s.id, f.name, f.slug ?? null, f.host ?? null, f.event_date ?? null,
    await secretHash(secret), await wrapKey(secret, 'invite', s.ckey),
    await encField(s.ckey, secret), Date.now()).run();
  return json(env, { id: out.meta.last_row_id, name: f.name, invite: secret });
}

// POST /s/:secret/mirrors/:id — relabel, revoke an unused invite, or
// hide a mirror from the set-wide stats (a test run). Nothing here
// reaches into the mirror's tournament: that belongs to its TD.
async function updateMirror(request, env, s, mirrorId) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const { results } = await env.DB.prepare(
    'SELECT id, started, tournament_id FROM set_mirrors WHERE id = ?1 AND set_id = ?2'
  ).bind(mirrorId, s.id).all();
  if (!results.length) return err(env, 404, 'no such mirror');
  const f = cleanMirrorFields(body);
  if (f.error) return err(env, 400, f.error);
  if (body.revoked !== undefined) {
    if (results[0].tournament_id && body.revoked) return err(env, 409, 'already started');
    f.revoked = body.revoked ? 1 : 0;
  }
  if (body.hidden !== undefined) f.hidden = body.hidden ? 1 : 0;
  const cols = Object.keys(f);
  if (!cols.length) return err(env, 400, 'nothing to update');
  await env.DB.prepare(
    `UPDATE set_mirrors SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`
  ).bind(...cols.map((c) => f[c]), mirrorId).run();
  // hidden decides whether the set makes this mirror's games public, so
  // the cron must look at the mirror again (publish or retract)
  if (f.hidden !== undefined && results[0].tournament_id) await markPub(env, results[0].tournament_id);
  await markSet(env, s.id);
  return json(env, { ok: true });
}

// Resolve an invite link. 404 for unknown and revoked alike; the set's
// own expiry closes its invites with it.
async function getInviteRow(env, secret) {
  const { results } = await env.DB.prepare(
    'SELECT m.*, s.name AS set_name, s.slug AS set_slug, s.settings AS set_settings, s.created AS set_created ' +
    'FROM set_mirrors m JOIN sets s ON s.id = m.set_id WHERE m.invite_secret = ?1 AND m.revoked = 0'
  ).bind(await secretHash(secret)).all();
  return results[0] || null;
}

// Used for good (its tournament is linked), or claimed moments ago by a
// start still in flight. A claim that never got its tournament — the
// Worker died in between — lapses, so the invite is not lost with it.
function inviteTaken(m) {
  return Boolean(m.tournament_id) || (m.started && m.started > Date.now() - INVITE_CLAIM_TTL);
}

async function getInvite(env, secret) {
  const m = await getInviteRow(env, secret);
  if (!m) return err(env, 404, 'bad link');
  if (Date.now() > m.set_created + SET_TTL) return err(env, 410, 'set closed');
  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM set_packets WHERE set_id = ?1 AND retired = 0'
  ).bind(m.set_id).all();
  return json(env, {
    set: m.set_name, name: m.name, slug: m.slug, host: m.host, event_date: m.event_date,
    packets: results[0].n, started: inviteTaken(m) ? m.started : null,
  });
}

// An invite, checked and claimed for one use: {error: Response} or {m,
// setKey, release}. The claim re-checks everything that could have
// changed since the row was read — a revoke, or another use, racing
// this one — so two clicks can't make (or join) two tournaments.
async function claimInvite(env, secret) {
  const m = await getInviteRow(env, secret);
  if (!m) return { error: err(env, 404, 'bad link') };
  if (Date.now() > m.set_created + SET_TTL) return { error: err(env, 410, 'set closed') };
  if (inviteTaken(m)) return { error: err(env, 409, 'this mirror has already been started') };
  const setKey = await unwrapKey(secret, 'invite', m.invite_wrap);
  const now = Date.now();
  const claim = await env.DB.prepare(
    'UPDATE set_mirrors SET started = ?2 WHERE id = ?1 AND revoked = 0 AND tournament_id IS NULL ' +
    'AND (started IS NULL OR started <= ?3)'
  ).bind(m.id, now, now - INVITE_CLAIM_TTL).run();
  if (!claim.meta.changes) return { error: err(env, 409, 'this mirror has already been started') };
  return {
    m, setKey, claimedAt: now,
    release: () => env.DB.prepare(
      'UPDATE set_mirrors SET started = NULL, tournament_id = NULL, mirror_key_enc = NULL WHERE id = ?1 AND started = ?2'
    ).bind(m.id, now).run(),
  };
}

// Tie a tournament to a claimed invite's mirror row, then give it the
// set's current packets: packet N on round N, wherever the tournament
// has nothing on that round yet and is not already using that packet.
// Returns the rounds it filled.
//
// Link first, THEN read the packets. From the link on, a packet the
// editor uploads reaches this mirror through mirrorsOpenFor; anything
// uploaded before it is in the read below. Either order is covered, and
// where both apply the upload's row wins (DO NOTHING here, an upsert
// there) — it is never the older version. mirror_key_enc is the
// mirror's content key under the set's: what lets the set's editors
// open this mirror's stored game files (setMirrorFile).
//
// The link holds only for the claim that authorized it: a claim that
// lapsed and was re-claimed by someone else, or an invite revoked while
// this start was in flight, links nothing (and the caller undoes its
// tournament).
async function linkMirror(env, m, setKey, tid, mirrorKey, claimedAt) {
  const linked = await env.DB.prepare(
    'UPDATE set_mirrors SET tournament_id = ?2, mirror_key_enc = ?3 ' +
    'WHERE id = ?1 AND tournament_id IS NULL AND revoked = 0 AND started = ?4'
  ).bind(m.id, tid, await encField(setKey, b64bytes(mirrorKey)), claimedAt).run();
  if (!linked.meta.changes) throw new Error('invite no longer valid');
  const [{ results: packets }, { results: have }] = await Promise.all([
    env.DB.prepare(
      'SELECT packet, version, r2_key, name FROM set_packets WHERE set_id = ?1 AND retired = 0'
    ).bind(m.set_id).all(),
    env.DB.prepare('SELECT number, packet_r2_key FROM rounds WHERE tournament_id = ?1').bind(tid).all(),
  ]);
  const taken = new Set(have.map((r) => r.number));
  const using = (p) => have.some((r) => r.packet_r2_key.startsWith(`${setPacketPrefix(m.set_id)}${p.packet}/`));
  const fill = packets.filter((p) => !taken.has(p.packet) && !using(p));
  if (fill.length) {
    await env.DB.batch(fill.map((p) => env.DB.prepare(
      'INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(tournament_id, number) DO NOTHING'
    ).bind(tid, p.packet, p.r2_key, p.name)));
  }
  return { packets, fill };
}

// Best effort after linkMirror: the filled rounds' categories, from the
// set's map into the mirror's, in one conditional write. A mirror works
// without it — the dashboard's own backfill (rebuildCatmap) rebuilds a
// missing or stale map from the packets.
async function fillMirrorCatmap(env, setId, tid, fill) {
  const catsObj = await env.DATA.get(setCatmapKey(setId));
  const setCats = catsObj ? await catsObj.json().catch(() => null) : null;
  const add = fill.map((p) => [String(p.packet), versionCats(setCats, p.packet, p.version)]).filter(([, c]) => c);
  if (!add.length) return;
  const key = `t/${tid}/catmap.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await env.DATA.get(key);
    const map = (cur && await cur.json().catch(() => null)) || { rounds: {} };
    if (!map.rounds || typeof map.rounds !== 'object') map.rounds = {};
    for (const [round, cats] of add) map.rounds[round] = cats;
    const onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    try {
      const put = await env.DATA.put(key, JSON.stringify(map), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { v: cur ? (cur.customMetadata || {}).v || '1' : (catsObj.customMetadata || {}).v || '1' },
        onlyIf,
      });
      if (put) return;
    } catch (e) { /* precondition failed -> retry */ }
  }
}

// POST /i/:secret {name, slug} — start the mirror: an ordinary tournament
// (the 48h clocks start now), prefilled from the set.
async function startInvite(request, env, secret) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const slug = cleanSlug(body.slug);
  const name = cleanName(body.name);
  const bad = slugNameError(slug, name);
  if (bad) return err(env, bad.status, bad.message);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { results: quota } = await env.DB.prepare(
    'SELECT SUM(creator_ip = ?1) AS mine, COUNT(*) AS all_ips FROM tournaments WHERE created > ?2 AND set_id IS NOT NULL'
  ).bind(ip, Date.now() - 24 * 3600 * 1000).all();
  if ((quota[0].mine || 0) >= START_PER_IP_DAY || quota[0].all_ips >= START_GLOBAL_DAY) {
    return err(env, 429, 'creation limit reached, try again tomorrow');
  }

  const claimed = await claimInvite(env, secret);
  if (claimed.error) return claimed.error;
  const { m, setKey, release, claimedAt } = claimed;

  // settings are filled in below, once the packets are known
  const made = await insertTournament(env, {
    slug, name, settings: {}, ip, set: { id: m.set_id, key: setKey },
  });
  if (!made) {
    await release();
    return err(env, 409, 'slug already taken');
  }
  let linked;
  try {
    linked = await linkMirror(env, m, setKey, made.id, made.rawKey, claimedAt);
    // The reader format is the set's; the round count is the editor's
    // planned one, or however far the packets go if that is further.
    // Never the set's buzzpoints config: that password is the editor's,
    // and a mirror's is its TD's to set.
    let setSettings = {};
    try { setSettings = JSON.parse(m.set_settings) || {}; } catch (e) { /* keep {} */ }
    const planned = Number(setSettings.rounds);
    const settings = {
      rounds: Math.max(1, Number.isInteger(planned) && planned <= 999 ? planned : 1,
        ...linked.packets.map((p) => p.packet)),
    };
    for (const k of ['gameFormat', 'formatOverrides']) {
      if (setSettings[k] !== undefined) settings[k] = setSettings[k];
    }
    await env.DB.prepare('UPDATE tournaments SET settings = ?2 WHERE id = ?1')
      .bind(made.id, JSON.stringify(settings)).run();
  } catch (e) {
    // no rounds, no mirror: undo, and the invite can be started again
    await env.DB.prepare('DELETE FROM rounds WHERE tournament_id = ?1').bind(made.id).run();
    await env.DB.prepare('DELETE FROM tournaments WHERE id = ?1').bind(made.id).run();
    await release();
    return err(env, 500, 'could not start the mirror, try again');
  }
  try { await fillMirrorCatmap(env, m.set_id, made.id, linked.fill); } catch (e) {
    console.log('mirror category map incomplete for tournament', made.id, e.message);
  }
  await markPub(env, made.id);
  await markSet(env, m.set_id);
  return json(env, {
    id: made.id, slug, name, admin_secret: made.adminSecret,
    closes: made.created + ADMIN_TTL, set: m.set_name, rounds: linked.fill.length,
  });
}

// POST /a/:secret/join {invite} — a TD who made their tournament before
// the invite reached them uses it on that tournament instead: it becomes
// the set's mirror as it stands. Its own packets stay where they are
// (the set only fills the rounds still empty), its games start counting
// for the set, and its clocks are the ones it already had.
async function joinSet(request, env, t) {
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const secret = String(body.invite || '').trim();
  if (!/^[a-z0-9]{10,40}$/.test(secret)) return err(env, 400, 'bad invite');
  if (t.set_id) return err(env, 409, 'this tournament already mirrors a set');
  // legacy (pre-encryption) tournaments have no key to hold the set's under
  if (!t.ckey) return err(env, 409, 'this tournament cannot join a set');

  const claimed = await claimInvite(env, secret);
  if (claimed.error) return claimed.error;
  const { m, setKey, release, claimedAt } = claimed;
  // Two joins racing on one tournament: the second finds set_id taken
  // and must not touch what the first did — so the join is claimed
  // first, and only a claim that stuck is ever rolled back.
  const keyEnc = await encField(t.ckey, b64bytes(setKey));
  const joined = await env.DB.prepare(
    'UPDATE tournaments SET set_id = ?2, set_key_enc = ?3 WHERE id = ?1 AND set_id IS NULL'
  ).bind(t.id, m.set_id, keyEnc).run();
  if (!joined.meta.changes) {
    await release();
    return err(env, 409, 'this tournament already mirrors a set');
  }
  let linked;
  try {
    linked = await linkMirror(env, m, setKey, t.id, t.ckey, claimedAt);
  } catch (e) {
    // rounds the link may have filled point at blobs this tournament
    // can no longer open once the key goes: they go with it
    await env.DB.prepare('DELETE FROM rounds WHERE tournament_id = ?1 AND packet_r2_key LIKE ?2')
      .bind(t.id, setPacketPrefix(m.set_id) + '%').run();
    await env.DB.prepare(
      'UPDATE tournaments SET set_id = NULL, set_key_enc = NULL WHERE id = ?1 AND set_key_enc = ?2'
    ).bind(t.id, keyEnc).run();
    await release();
    return err(env, 500, 'could not join the set, try again');
  }
  try { await fillMirrorCatmap(env, m.set_id, t.id, linked.fill); } catch (e) {
    console.log('mirror category map incomplete for tournament', t.id, e.message);
  }
  await markPub(env, t.id);
  await markSet(env, m.set_id);
  return json(env, { ok: true, set: m.set_name, rounds: linked.fill.length });
}

// POST /a/:secret/setpacket {round, packet} — the TD's choice of which
// of the set's packets a round reads (packet: null clears the round).
// Always the packet's current version. Refused once the round has a
// game: that game was read from what is there now.
async function chooseSetPacket(request, env, t) {
  if (!t.set_id) return err(env, 409, 'not a mirror of a set');
  let body;
  try { body = await request.json(); } catch (e) { return err(env, 400, 'bad json'); }
  const round = Number(body.round);
  if (!Number.isInteger(round) || round < 1 || round > 999) return err(env, 400, 'bad round');
  const { results: played } = await env.DB.prepare(
    "SELECT 1 AS ok FROM files WHERE tournament_id = ?1 AND round = ?2 AND kind IN ('qbj', 'combined') AND error IS NULL LIMIT 1"
  ).bind(t.id, round).all();
  if (played.length) return err(env, 409, 'round ' + round + ' already has games');

  if (body.packet === null) {
    await env.DB.prepare('DELETE FROM rounds WHERE tournament_id = ?1 AND number = ?2').bind(t.id, round).run();
    await updateCatmap(env, t.id, round, null);
    await markPub(env, t.id);
    return json(env, { round, packet: null });
  }
  const packet = Number(body.packet);
  const { results } = Number.isInteger(packet) ? await env.DB.prepare(
    'SELECT version, r2_key, name FROM set_packets WHERE set_id = ?1 AND packet = ?2 AND retired = 0'
  ).bind(t.set_id, packet).all() : { results: [] };
  if (!results.length) return err(env, 404, 'no such packet in the set');
  const p = results[0];
  // served resets with the packet: nobody has been handed THIS one here
  // — unless it is the one already there, whose pin stays
  await env.DB.prepare(
    'INSERT INTO rounds (tournament_id, number, packet_r2_key, packet_name) VALUES (?1, ?2, ?3, ?4) ' +
    'ON CONFLICT(tournament_id, number) DO UPDATE SET packet_name = ?4, ' +
    'served = CASE WHEN packet_r2_key = ?3 THEN served ELSE 0 END, packet_r2_key = ?3'
  ).bind(t.id, round, p.r2_key, p.name).run();
  const catsObj = await env.DATA.get(setCatmapKey(t.set_id));
  await updateCatmap(env, t.id, round,
    versionCats(catsObj ? await catsObj.json().catch(() => null) : null, packet, p.version));
  await markPub(env, t.id);
  return json(env, { round, packet, version: p.version });
}

/* ----- a mirror's stored game files, for the set's editors ----- */

// The mirror's content key, through the set's. null: not this set's
// mirror, or one from before mirrors handed their key over.
async function mirrorKeyFor(env, s, tid) {
  const { results } = Number.isInteger(tid) ? await env.DB.prepare(
    'SELECT mirror_key_enc FROM set_mirrors WHERE set_id = ?1 AND tournament_id = ?2'
  ).bind(s.id, tid).all() : { results: [] };
  if (!results.length || !results[0].mirror_key_enc) return null;
  return b64ToBytes(await decField(s.ckey, results[0].mirror_key_enc));
}

// GET /s/:secret/files?m=<tournament id> — that mirror's uploads, as the
// TD's own dashboard lists them.
async function setMirrorFiles(env, s, url) {
  const tid = Number(url.searchParams.get('m'));
  if (!(await mirrorKeyFor(env, s, tid))) return err(env, 404, 'no such mirror');
  const { results } = await env.DB.prepare(
    'SELECT f.id, f.round, f.kind, f.filename, f.size, f.error, f.created, b.room_name AS room ' +
    'FROM files f LEFT JOIN buckets b ON b.id = f.bucket_id WHERE f.tournament_id = ?1 ORDER BY f.round, f.id'
  ).bind(tid).all();
  return json(env, { files: results });
}

// GET /s/:secret/gamefile?m=&id=&part=qbj|game — one of them, decrypted:
// the match qbj, or the MODAQ game file a reader upload carries.
async function setMirrorFile(env, s, url) {
  const tid = Number(url.searchParams.get('m'));
  const rawKey = await mirrorKeyFor(env, s, tid);
  if (!rawKey) return err(env, 404, 'no such mirror');
  const fileId = Number(url.searchParams.get('id'));
  const { results } = Number.isInteger(fileId) ? await env.DB.prepare(
    'SELECT r2_key, filename FROM files WHERE id = ?1 AND tournament_id = ?2'
  ).bind(fileId, tid).all() : { results: [] };
  const obj = results.length ? await env.DATA.get(results[0].r2_key) : null;
  if (!obj) return err(env, 404, 'no such file');
  return storedFileResponse(env, obj, rawKey, results[0].filename, url.searchParams.get('part'));
}

/* ----- the set's state blob and the routes that read the games ----- */

// One mirror's heavy half of the state: what its shards hold, which set
// packet + version each of its rounds ran ([packet, version], or null
// for a packet of the TD's own), and which rounds every room has turned in.
async function mirrorState(env, tid, packetOf) {
  const [manifest, rounds, files, buckets, schedObj] = await Promise.all([
    readManifest(env, tid),
    env.DB.prepare('SELECT number, packet_r2_key FROM rounds WHERE tournament_id = ?1').bind(tid).all(),
    env.DB.prepare(
      "SELECT round, bucket_id FROM files WHERE tournament_id = ?1 AND kind IN ('qbj', 'combined') AND error IS NULL"
    ).bind(tid).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM buckets WHERE tournament_id = ?1').bind(tid).all(),
    env.DATA.get(`t/${tid}/schedule.json`),
  ]);
  const sched = schedObj ? await schedObj.json().catch(() => null) : null;
  return {
    rounds: manifest.rounds,
    vmap: Object.fromEntries(rounds.results.map((r) => [r.number, packetOf.get(r.packet_r2_key) ?? null])),
    done: doneRounds(files.results, buckets.results[0].n, sched),
  };
}

/**
 * Rebuild s/<sid>/state.json. Cron-only: one writer. Only the mirrors the
 * tick flagged (set_mirrors.state_dirty, set when the tick works on the
 * mirror's tournament) and mirrors the previous blob has never seen pay
 * for mirrorState; everything else is carried forward, so a busy Saturday
 * costs D1 reads in proportion to the mirrors that moved, not to the
 * mirrors that exist. The flags clear only after the blob is written —
 * a rebuild that fails re-reads the same mirrors next tick.
 */
async function rebuildSetState(env, sid) {
  const [prevObj, mirrors, packets, catsObj] = await Promise.all([
    env.DATA.get(setStateKey(sid)),
    env.DB.prepare(
      'SELECT m.id AS mirror_id, m.state_dirty, m.name AS label, m.host, m.event_date, ' +
      't.id, t.slug, t.name, t.published, t.created, t.pub_snapshot ' +
      'FROM set_mirrors m JOIN tournaments t ON t.id = m.tournament_id ' +
      'WHERE m.set_id = ?1 AND m.hidden = 0 ORDER BY m.id'
    ).bind(sid).all(),
    env.DB.prepare('SELECT packet, version, r2_key, retired FROM set_packets WHERE set_id = ?1').bind(sid).all(),
    env.DATA.get(setCatmapKey(sid)),
  ]);
  const prev = prevObj ? await prevObj.json().catch(() => null) : null;
  const prevBy = new Map(((prev && prev.mirrors) || []).map((m) => [m.id, m]));
  const packetOf = new Map(packets.results.map((p) => [p.r2_key, [p.packet, p.version]]));

  let cats = null;
  if (catsObj) {
    const parsed = await catsObj.json().catch(() => null);
    if (parsed && parsed.packets && Object.keys(parsed.packets).length) cats = catsObj.uploaded.getTime();
  }

  // Claim the flags before the work, like the tournament half: a flag
  // set by an overlapping tick while this one reads stays set. A rebuild
  // that fails puts the claimed ones back (tickSets).
  const reread = mirrors.results.filter((t) => !prevBy.get(t.id) || t.state_dirty).map((t) => t.mirror_id);
  for (const id of reread) {
    await env.DB.prepare('UPDATE set_mirrors SET state_dirty = 0 WHERE id = ?1').bind(id).run();
  }
  const out = [];
  for (const t of mirrors.results) {
    const old = prevBy.get(t.id);
    const heavy = old && !reread.includes(t.mirror_id)
      ? { rounds: old.rounds, vmap: old.vmap, done: old.done }
      : await mirrorState(env, t.id, packetOf);
    // the snapshot descriptor is on the row, so it is always current
    let pub = null;
    try {
      const snap = env.SNAPSHOT_REPO && t.pub_snapshot ? JSON.parse(t.pub_snapshot) : null;
      if (snap && snap.sha) pub = { sha: snap.sha, rounds: snap.rounds || {} };
    } catch (e) { /* no usable snapshot */ }
    out.push({
      id: t.id, label: t.label, host: t.host, date: t.event_date,
      slug: t.slug, name: t.name, page: !!t.published, created: t.created,
      ...heavy, pub,
    });
  }
  await env.DATA.put(setStateKey(sid), JSON.stringify({
    v: 2, at: Date.now(), cats,
    packets: Object.fromEntries(packets.results.filter((p) => !p.retired).map((p) => [p.packet, p.version])),
    mirrors: out,
  }), { httpMetadata: { contentType: 'application/json' } });
  return reread;
}

// The second half of the tick: state blobs for flagged sets — by their
// own mutations, or by the first half having worked on one of their
// mirrors.
async function tickSets(env) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM sets WHERE state_dirty = 1 ORDER BY id LIMIT 8'
  ).all();
  for (const s of results) {
    // claim before working, as the tournament half does
    await env.DB.prepare('UPDATE sets SET state_dirty = 0 WHERE id = ?1').bind(s.id).run();
    try {
      await rebuildSetState(env, s.id);
    } catch (e) {
      console.log('set state failed for set', s.id, e.message);
      // whatever mirrors this rebuild had claimed are stale again
      await env.DB.prepare(
        'UPDATE set_mirrors SET state_dirty = 1 WHERE set_id = ?1 AND tournament_id IS NOT NULL'
      ).bind(s.id).run();
      await markSet(env, s.id);
    }
  }
}

// The set page's state: the cron's blob plus what lives on the row. The
// same body serves the editor (always) and the public route (published).
async function setStateBody(env, s) {
  const obj = await env.DATA.get(setStateKey(s.id));
  const blob = (obj && await obj.json().catch(() => null)) || { at: null, cats: null, packets: {}, mirrors: [] };
  const buzz = buzzConfig(s);
  return {
    name: s.name, slug: s.slug,
    buzz: buzz ? buzz.mode : null,
    buzz_kdf: buzzKdf(buzz),
    buzz_v: buzz ? await buzzStamp(buzz) : null,
    // where mirrors[].pub shas resolve (see "public snapshots on GitHub")
    repo: env.SNAPSHOT_REPO || null,
    at: blob.at, cats: blob.cats, packets: blob.packets, mirrors: blob.mirrors,
  };
}

async function getPublishedSet(env, slug) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sets WHERE slug = ?1 AND published = 1'
  ).bind(slug).all();
  return results[0] || null;
}

async function pubSetState(env, slug) {
  const s = await getPublishedSet(env, slug);
  if (!s) return err(env, 404, 'not found');
  return json(env, await setStateBody(env, s), 200, PUB_CACHE_LIVE);
}

// One mirror's round shards, ?m=<tournament id>&n=3,4 — pubRounds for a
// mirror whose own page may be off. Hidden mirrors are not served.
async function setRounds(env, s, url, cacheSeconds) {
  const tid = Number(url.searchParams.get('m'));
  const { results } = Number.isInteger(tid) ? await env.DB.prepare(
    'SELECT 1 AS ok FROM set_mirrors WHERE set_id = ?1 AND tournament_id = ?2 AND hidden = 0'
  ).bind(s.id, tid).all() : { results: [] };
  if (!results.length) return err(env, 404, 'no such mirror');
  return streamRounds(env, tid, url, cacheSeconds);
}

async function pubSetRounds(env, slug, url) {
  const s = await getPublishedSet(env, slug);
  if (!s) return err(env, 404, 'not found');
  return setRounds(env, s, url, PUB_CACHE_LIVE);
}

async function setCats(env, s, cacheSeconds) {
  const obj = await env.DATA.get(setCatmapKey(s.id));
  if (!obj) return err(env, 404, 'no categories');
  return blobResponse(env, obj, null, cacheSeconds);
}

async function pubSetCats(env, slug) {
  const s = await getPublishedSet(env, slug);
  if (!s) return err(env, 404, 'not found');
  return setCats(env, s, PUB_CACHE_LIVE);
}

// Set-wide buzzpoint text: ?packet=&v=. Same gate as a tournament's, and
// the same played-rounds-only rule one level up — a version of a packet
// is served once some mirror has every room in for a round it ran it on.
async function pubSetQPacket(request, url, env, slug) {
  const s = await getPublishedSet(env, slug);
  if (!s) return err(env, 404, 'not found');
  const b = buzzConfig(s);
  if (!b) return err(env, 404, 'not found');
  const denied = await buzzGate(request, env, 'set:' + slug, b);
  if (denied) return denied;
  const packet = Number(url.searchParams.get('packet'));
  const version = Number(url.searchParams.get('v'));
  if (!Number.isInteger(packet) || packet < 1 || !Number.isInteger(version)) return err(env, 400, 'bad packet');
  const stateObj = await env.DATA.get(setStateKey(s.id));
  const state = stateObj ? await stateObj.json().catch(() => null) : null;
  const played = ((state && state.mirrors) || []).some((m) => (m.done || []).some((round) => {
    const pv = (m.vmap || {})[round];
    return Array.isArray(pv) && pv[0] === packet && pv[1] === version;
  }));
  if (!played) return err(env, 403, 'not played yet');
  const row = await setPacketRow(env, s.id, url);
  const obj = row ? await env.DATA.get(row.r2_key) : null;
  if (!obj) return err(env, 404, 'no such packet');
  return gatedPacket(request, env, obj, row.r2_key, row.name, s.buzz_wrap, (skey) => ({ skey }));
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
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})$/)) && method === 'GET') return pubState(env, m[1], ctx);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/rounds$/)) && method === 'GET') return pubRounds(env, m[1], url);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/qbj\/(\d+)$/)) && method === 'GET') return pubQbj(env, m[1], Number(m[2]));
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/roster$/)) && method === 'GET') return pubRoster(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/schedule$/)) && method === 'GET') return pubSchedule(env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/qpacket$/)) && method === 'GET') return pubQPacket(request, url, env, m[1]);
    if ((m = path.match(/^\/pub\/([a-z0-9-]{3,40})\/cats$/)) && method === 'GET') return pubCats(env, m[1]);

    // Public set routes — gated by the set's own publish flag inside.
    if ((m = path.match(/^\/pubset\/([a-z0-9-]{3,40})$/)) && method === 'GET') return pubSetState(env, m[1]);
    if ((m = path.match(/^\/pubset\/([a-z0-9-]{3,40})\/rounds$/)) && method === 'GET') return pubSetRounds(env, m[1], url);
    if ((m = path.match(/^\/pubset\/([a-z0-9-]{3,40})\/cats$/)) && method === 'GET') return pubSetCats(env, m[1]);
    if ((m = path.match(/^\/pubset\/([a-z0-9-]{3,40})\/qpacket$/)) && method === 'GET') return pubSetQPacket(request, url, env, m[1]);

    // Open (rate-limited) tournament creation; the response carries the
    // admin secret, shown to the TO exactly once by the dashboard.
    if (path === '/api/tournaments' && method === 'POST') return createTournament(request, env);
    if (path === '/api/sets' && method === 'POST') return createSet(request, env);

    // A mirror invite: read what it is, or start it (once).
    if ((m = path.match(/^\/i\/([a-z0-9]{10,40})$/)) && method === 'GET') return getInvite(env, m[1]);
    if ((m = path.match(/^\/i\/([a-z0-9]{10,40})$/)) && method === 'POST') return startInvite(request, env, m[1]);

    // Set editor routes — the set link is the credential (SET_TTL).
    if ((m = path.match(/^\/s\/([a-z0-9]{10,40})(\/.*)?$/))) {
      const s = await getAdminSet(env, m[1]);
      if (!s) return err(env, 404, 'bad link');
      if (setClosed(s)) return err(env, 410, 'set closed');
      const sub = m[2] || '';
      let mm;
      if (sub === '' && method === 'GET') return getSet(env, s, ctx);
      if (sub === '' && method === 'POST') return updateSet(request, env, s);
      if (sub === '/rotate' && method === 'POST') return rotateSet(env, s);
      if (sub === '/packet' && method === 'POST') return uploadSetPacket(request, url, env, s);
      if (sub === '/packet' && method === 'DELETE') return retireSetPacket(url, env, s);
      if (sub === '/packet/status' && method === 'POST') return setPacketStatus(request, env, s);
      if (sub === '/ledger' && method === 'GET') return getLedger(env, s);
      if (sub === '/qmap' && method === 'POST') return putQmap(request, env, s);
      if (sub === '/files' && method === 'GET') return setMirrorFiles(env, s, url);
      if (sub === '/gamefile' && method === 'GET') return setMirrorFile(env, s, url);
      if (sub === '/file' && method === 'GET') return setPacketFile(url, env, s);
      if (sub === '/tiebreakers' && method === 'GET') return setTiebreakers(env, s);
      if (sub === '/tiebreakers' && method === 'POST') return uploadTiebreakers(request, url, env, SET_TB_KEY(s.id), s.ckey);
      if (sub === '/tiebreakers' && method === 'DELETE') return clearSetTiebreakers(env, s);
      if (sub === '/mirrors' && method === 'POST') return createMirror(request, env, s);
      if ((mm = sub.match(/^\/mirrors\/(\d+)$/)) && method === 'POST') return updateMirror(request, env, s, Number(mm[1]));
      if (sub === '/state' && method === 'GET') return json(env, await setStateBody(env, s));
      if (sub === '/rounds' && method === 'GET') return setRounds(env, s, url, 0);
      if (sub === '/cats' && method === 'GET') return setCats(env, s, 0);
    }

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
      if (sub === '/tiebreakers' && method === 'GET') return adminTiebreakers(env, t);
      if (sub === '/tiebreakers' && method === 'POST') return uploadTiebreakers(request, url, env, TB_KEY(t.id), t.ckey);
      if (sub === '/tiebreakers' && method === 'DELETE') return deleteTiebreakers(env, TB_KEY(t.id));
      if (sub === '/packet' && method === 'POST') return uploadPacket(request, url, env, t);
      if (sub === '/roster' && method === 'POST') return uploadRoster(request, url, env, t);
      if (sub === '/schedule' && method === 'POST') return putSchedule(request, env, t);
      if (sub === '/schedule' && method === 'DELETE') return deleteSchedule(env, t);
      if (sub === '/file' && method === 'GET') return adminDownload(url, env, t);
      if ((mm = sub.match(/^\/files\/(\d+)$/)) && method === 'DELETE') return deleteFile(env, t, Number(mm[1]));
      if (sub === '/bundle' && method === 'POST') return putBundle(request, env, t);
      if (sub === '/setpacket' && method === 'POST') return chooseSetPacket(request, env, t);
      if (sub === '/join' && method === 'POST') return joinSet(request, env, t);
    }

    return err(env, 404, 'not found');
  },

  // Cron (wrangler.toml [triggers]): rebuilds dirty tournaments' round
  // shards and, when configured, publishes them to the GitHub data repo.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tickDirty(env));
  },
};
