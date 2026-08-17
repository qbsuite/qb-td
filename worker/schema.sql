-- D1 schema for the qb-td Worker (worker.js).
-- Apply with: npx wrangler d1 execute qb-td --remote --file schema.sql

-- No accounts: the unguessable admin_secret in the TO's link is the only
-- credential, and it stops working 48h after creation (worker.js ADMIN_TTL).
--
-- Question-text encryption (worker.js "question text encryption"): rows
-- with admin_wrap set store SHA-256 of the admin secret in admin_secret
-- (64 hex chars — link secrets are 10-40 chars, so the two can never
-- collide) and their question-text blobs in R2 are encrypted under a
-- per-tournament content key held only in the wrap columns. Rows without
-- admin_wrap are legacy: plaintext secret, plaintext blobs.
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,         -- public stats URL slug
  name TEXT NOT NULL,
  admin_secret TEXT NOT NULL UNIQUE, -- the TO's admin link credential (hashed; see above)
  admin_wrap TEXT,                   -- content key wrapped under the admin secret
  buzz_wrap TEXT,                    -- content key wrapped under the buzzpoints derived key
  creator_ip TEXT,                   -- creation rate limiting only
  current_round INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', -- JSON: reader gameFormat etc.
  -- JSON array of live broadcasts (worker.js cleanAnnounce). Its own column,
  -- not a settings key: a long game-format override must not be able to
  -- crowd out announcements, or the reverse.
  announce TEXT NOT NULL DEFAULT '[]',
  roster_r2_key TEXT,                -- single roster qbj per tournament
  roster_name TEXT,
  created INTEGER NOT NULL,
  -- Derived-data queue (worker.js tickDirty): set by markPub() on every
  -- mutation that changes what the public page reads, cleared when the
  -- cron has rebuilt the round shards (and published them, if snapshots
  -- are configured). Existing databases get these from migrate-pub.sql.
  pub_dirty INTEGER NOT NULL DEFAULT 0,
  pub_snapshot TEXT                  -- descriptor of the last published commit
);
CREATE INDEX IF NOT EXISTS idx_tournaments_created ON tournaments(created);

-- One bucket per room; the secret in the bucket link is the moderator's
-- only credential (no login).
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  room_name TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,       -- hashed when wrap is set (see tournaments)
  wrap TEXT,                         -- content key wrapped under this room's secret
  secret_enc TEXT,                   -- the secret itself, encrypted under the content key (for the TO's links)
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buckets_tournament ON buckets(tournament_id);

-- A round row exists iff a packet was uploaded for it; the live current
-- round is tournaments.current_round.
CREATE TABLE IF NOT EXISTS rounds (
  tournament_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  packet_r2_key TEXT NOT NULL,
  packet_name TEXT NOT NULL,
  PRIMARY KEY (tournament_id, number)
);

-- Moderator uploads (packets and the roster live above, not here).
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  bucket_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- 'qbj' | 'combined' | 'game' | 'other'
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  error TEXT,                        -- qbj validation error, if any
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_tournament ON files(tournament_id);
CREATE INDEX IF NOT EXISTS idx_files_bucket ON files(bucket_id);
