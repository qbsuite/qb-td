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
//
// WebCrypto only, so it runs unchanged in Workers and in Node's tests.

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const key = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export const PLAYER_TOKEN_MS = 12 * 60 * 60 * 1000;

export async function signToken(secret, { slug, role, rooms, expires, closes }) {
  if (!secret) throw new Error('no BUZZER_SECRET');
  const body = b64(enc.encode(JSON.stringify({ s: slug, r: role === 'reader' ? 'm' : 'p', rm: rooms, x: expires, c: closes })));
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
  return { role: p.r === 'm' ? 'reader' : 'player', closes: p.c, expires: p.x };
}
