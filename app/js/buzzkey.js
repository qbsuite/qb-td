// buzzkey.js — the buzzpoints password KDF, shared by the dashboard (which
// sets a password) and the public page (which enters one).
//
// The password itself never reaches the Worker. The browser stretches it
// with PBKDF2-SHA256 into a derived key, and that key is what travels in
// the Authorization header; the Worker stores and compares only SHA-256 of
// it. That split matters twice: the Worker's per-request work stays one
// hash, well inside the free tier's 10 ms CPU budget, while a stolen
// settings row still costs an attacker a full PBKDF2 run per guess instead
// of one SHA-256.
//
// The salt and iteration count are public (they ride in /pub state so a
// viewer's browser can derive the same key) — a salt is not a secret, it
// only stops one precomputed table from covering every tournament. The
// hash is what stays server-side.
//
// Tournaments whose password predates this carry {salt, hash} with no
// `kdf` and are still verified the old way, sha256("salt:password"), with
// the password on the wire. They keep working untouched; setting a new
// password upgrades them.

export const BUZZ_ITERS = 600000; // OWASP's PBKDF2-SHA256 floor

const hex = (buf) => [...new Uint8Array(buf)]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) return sha256HexJs(text);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// SHA-256 in plain JS, for a page without crypto.subtle: browsers offer it
// only on https and localhost, so a hub self-hosted over plain http on a
// LAN address would otherwise lose its room Test links (admin.js
// testTokenReq). Short inputs only; speed doesn't matter here.
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256HexJs(text) {
  const bytes = new TextEncoder().encode(text);
  // padding: 0x80, zeros, then the bit length in the last 8 bytes
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(size);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(size - 4, (bytes.length * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] = (h[i] + x) | 0; });
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * The token the public page sends as `Authorization: Buzz <token>`.
 * `kdf` is the {kdf, iters, salt} object the Worker publishes in
 * /pub/:slug; null (a tournament from before the KDF) means the token is
 * the password itself.
 */
export async function buzzToken(password, kdf) {
  if (!kdf) return password;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: new TextEncoder().encode(kdf.salt),
    iterations: kdf.iters,
  }, key, 256);
  return hex(bits);
}

/** settings.buzz for a newly set password, with a fresh salt — plus the
    derived token itself. The token is sent to the Worker ONCE alongside
    the settings (`buzz_token`) so it can wrap the tournament's content
    key for the qpacket route (worker.js "question text encryption");
    it is never stored anywhere. */
export async function buzzCredentials(password) {
  const kdf = {
    kdf: 'pbkdf2',
    iters: BUZZ_ITERS,
    salt: hex(crypto.getRandomValues(new Uint8Array(12))),
  };
  const token = await buzzToken(password, kdf);
  return {
    settings: { mode: 'password', ...kdf, hash: await sha256Hex(token) },
    token,
  };
}

/** settings.buzz alone (buzzCredentials without the token). */
export async function buzzSettings(password) {
  return (await buzzCredentials(password)).settings;
}
