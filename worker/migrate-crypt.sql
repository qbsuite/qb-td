-- Migration for at-rest question-text encryption (worker.js "question
-- text encryption"). Apply BEFORE deploying the Worker that uses it:
--   npx wrangler d1 execute qb-td --remote --file migrate-crypt.sql
--
-- New tournaments get a random per-tournament content key that encrypts
-- every question-text blob in R2 (packets, tiebreakers, moderator game
-- uploads). The key is stored only WRAPPED under keys derived from the
-- link secrets, and the secrets themselves are stored only as SHA-256
-- hashes — so neither D1 nor R2 at rest can produce question text.
--
-- admin_wrap — content key wrapped under the admin link secret. Its
--              presence marks a new-style row: admin_secret then holds
--              SHA-256 of the secret (64 hex chars — link secrets are
--              10-40 chars, so the two can never collide), not the
--              secret itself.
-- buzz_wrap  — content key wrapped under the buzzpoints derived key,
--              written when the TO sets a password (the dashboard sends
--              the derived token once, purely for wrapping). Lets the
--              password-gated /pub qpacket route decrypt packets.
-- buckets.wrap — content key wrapped under that room's bucket secret;
--              buckets.secret likewise holds the hash when wrap is set.
-- buckets.secret_enc — the room secret encrypted under the content key, so
--              the TO's dashboard (which unwraps the content key from the
--              admin link) can still render the room links.
--
-- Legacy rows (all columns NULL) keep the plaintext-secret, plaintext-
-- blob code paths; the 48h link TTL ages them out of every write path
-- within two days of this migration.
ALTER TABLE tournaments ADD COLUMN admin_wrap TEXT;
ALTER TABLE tournaments ADD COLUMN buzz_wrap TEXT;
ALTER TABLE buckets ADD COLUMN wrap TEXT;
ALTER TABLE buckets ADD COLUMN secret_enc TEXT;
