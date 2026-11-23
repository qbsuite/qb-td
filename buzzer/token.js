// buzzer/token.js — the join token both Workers share. The qb-td Worker
// signs one once it has checked who is asking (a player's buzzer password,
// a room's own link); the buzzer Worker only has to check the signature,
// so it needs no database and no call back to qb-td.
//
//   v1.<payload>.<signature>     both base64url; HMAC-SHA256 under
//                                BUZZER_SECRET, a secret set on both Workers
//   payload: { s, r, rm, x, c }
//     s   tournament slug
//     r   'p' a player, 'm' a moderator (may Clear)
//     rm  the room ids (qb-td bucket ids) this token opens
//     x   when the token stops working, ms. A player's lasts hours, so a
//         changed password or an unticked room stops old tokens the same day
//     c   when the tournament's links close, ms: rooms hang up then
//     g   where the tournament's rooms are made (a Cloudflare location
//         hint, REGIONS below); left out for the default, enam
//
// WebCrypto only, so it runs unchanged in Workers and in Node's tests.

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const key = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export const PLAYER_TOKEN_MS = 12 * 60 * 60 * 1000;

// Where a tournament's rooms can be made: the hints Cloudflare places
// rooms in for real (sam, afr and me only stand for a nearby one of these).
export const REGIONS = ['enam', 'wnam', 'weur', 'eeur', 'apac', 'oc'];
export const regionOf = (g) => (REGIONS.includes(g) ? g : 'enam');

export async function signToken(secret, { slug, role, rooms, expires, closes, region }) {
  if (!secret) throw new Error('no BUZZER_SECRET');
  const body = b64(enc.encode(JSON.stringify({ s: slug, r: role === 'reader' ? 'm' : 'p', rm: rooms, x: expires, c: closes, ...(regionOf(region) === 'enam' ? {} : { g: region }) })));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode('v1.' + body));
  return `v1.${body}.${b64(sig)}`;
}

/** The token's claims when it is genuine, unexpired and opens this room of
    this tournament; otherwise a short reason (never thrown: a bad token is
    an ordinary refusal). */
export async function checkToken(secret, token, { slug, room, now = Date.now() }) {
  if (!secret) return { error: 'not configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { error: 'bad token' };
  let ok = false;
  let p = null;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), unb64(parts[2]), enc.encode('v1.' + parts[1]));
    p = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
  } catch (e) { return { error: 'bad token' }; }
  if (!ok || !p || typeof p !== 'object') return { error: 'bad token' };
  if (p.s !== slug) return { error: 'bad token' };
  if (!(now < p.x) || !(now < p.c)) return { error: 'expired' };
  if (!Array.isArray(p.rm) || !p.rm.includes(room)) return { error: 'no buzzer in this room' };
  return { role: p.r === 'm' ? 'reader' : 'player', closes: p.c, expires: p.x, region: regionOf(p.g) };
}

// ------------------------------------------------------------ live rooms
// The token for a tournament's live room (worker.js LiveRoom): the room
// that keeps the public page and the Live Hub up to date and carries each
// room's score while a game is played. Its own prefix, so a buzzer token
// never opens a live room and a live token never opens a buzzer.
//
//   l1.<payload>.<signature>     HMAC-SHA256 under BUZZER_SECRET
//   payload: { s, r, rm, x, c, g }
//     r   'v' a viewer (the public page), 't' the TD (the Live Hub),
//         's' a room's scorer (the reader page)
//     rm  a scorer's room (qb-td bucket id); absent otherwise
//     x   when it stops working, ms; c when the links close, ms
//     g   the tournament's region, as for the buzzer; absent for enam
const LIVE_ROLES = { viewer: 'v', td: 't', scorer: 's' };

export async function signLiveToken(secret, { slug, role, room, expires, closes, region }) {
  if (!secret) throw new Error('no BUZZER_SECRET');
  const r = LIVE_ROLES[role];
  if (!r) throw new Error('bad live role');
  const p = { s: slug, r, x: expires, c: closes, ...(r === 's' ? { rm: room } : {}), ...(regionOf(region) === 'enam' ? {} : { g: region }) };
  const body = b64(enc.encode(JSON.stringify(p)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode('l1.' + body));
  return `l1.${body}.${b64(sig)}`;
}

/** A live token's claims when genuine, unexpired and for this tournament;
    otherwise { error }. */
export async function checkLiveToken(secret, token, { slug, now = Date.now() }) {
  if (!secret) return { error: 'not configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'l1') return { error: 'bad token' };
  let ok = false;
  let p = null;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), unb64(parts[2]), enc.encode('l1.' + parts[1]));
    p = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
  } catch (e) { return { error: 'bad token' }; }
  if (!ok || !p || typeof p !== 'object' || p.s !== slug) return { error: 'bad token' };
  if (!(now < p.x) || !(now < p.c)) return { error: 'expired' };
  const role = Object.keys(LIVE_ROLES).find((k) => LIVE_ROLES[k] === p.r);
  if (!role) return { error: 'bad token' };
  if (role === 'scorer' && !Number.isInteger(p.rm)) return { error: 'bad token' };
  return { role, room: role === 'scorer' ? p.rm : null, closes: p.c, expires: p.x, region: regionOf(p.g) };
}

/** The live room's Durable Object name: one per tournament and region
    (a hint only counts when a room is first made, so another region is
    another room). The qb-td Worker reaches the same room by this name. */
export const liveRoomName = (slug, region) => 'live:' + slug + (regionOf(region) === 'enam' ? '' : '@' + regionOf(region));
