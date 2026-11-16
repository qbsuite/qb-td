// node buzzer/token.test.mjs — the join token: what opens a room and what doesn't.
import assert from 'node:assert/strict';
import { signToken, checkToken, PLAYER_TOKEN_MS } from './token.js';

const now = Date.UTC(2026, 10, 16);
const closes = now + 72 * 3600 * 1000;
const S = 'a-secret';
const player = await signToken(S, { slug: 'fall', role: 'player', rooms: [3, 4], expires: now + PLAYER_TOKEN_MS, closes });
const reader = await signToken(S, { slug: 'fall', role: 'reader', rooms: [3], expires: closes, closes });
const at = (o) => ({ slug: 'fall', room: 3, now, ...o });

assert.deepEqual(await checkToken(S, player, at()), { role: 'player', closes, expires: now + PLAYER_TOKEN_MS });
assert.equal((await checkToken(S, reader, at())).role, 'reader');
// a player's token never becomes a moderator's
assert.equal((await checkToken(S, player, at({ room: 4 }))).role, 'player');
// the wrong room, tournament or secret
assert.equal((await checkToken(S, player, at({ room: 5 }))).error, 'no buzzer in this room');
assert.equal((await checkToken(S, reader, at({ room: 4 }))).error, 'no buzzer in this room');
assert.equal((await checkToken(S, player, at({ slug: 'winter' }))).error, 'bad token');
assert.equal((await checkToken('other', player, at())).error, 'bad token');
// expiry: a player's after its hours, anyone's once the links close
assert.equal((await checkToken(S, player, at({ now: now + PLAYER_TOKEN_MS }))).error, 'expired');
assert.equal((await checkToken(S, reader, at({ now: closes - 1 }))).role, 'reader');
assert.equal((await checkToken(S, reader, at({ now: closes }))).error, 'expired');
// tampering: a player rewriting their payload to a moderator's
const [v, body, sig] = player.split('.');
const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
forged.r = 'm';
assert.equal((await checkToken(S, [v, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.'), at())).error, 'bad token');
for (const junk of ['', 'v1', 'v1.a.b', 'v2.' + body + '.' + sig, null, 'v1.%%%.%%%']) {
  assert.equal((await checkToken(S, junk, at())).error, 'bad token', String(junk));
}
// an unset secret refuses everything rather than signing with nothing
assert.equal((await checkToken('', player, at())).error, 'not configured');
await assert.rejects(signToken('', { slug: 'x', role: 'player', rooms: [1], expires: 1, closes: 1 }));
console.log('token: all checks passed');
