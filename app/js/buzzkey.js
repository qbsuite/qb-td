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
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
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
