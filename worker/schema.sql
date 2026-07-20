-- D1 schema for the qb-td Worker (worker.js).
-- Apply with: npx wrangler d1 execute qb-td --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,              -- provider-namespaced id, e.g. "gh:12345"
  login TEXT NOT NULL,               -- display handle at last login
  created INTEGER NOT NULL           -- ms epoch of first login
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,         -- public stats URL slug
  name TEXT NOT NULL,
  owner_uid TEXT NOT NULL,           -- users.uid of the TO
  current_round INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', -- JSON: YfData flags + scoring options
  roster_r2_key TEXT,                -- single roster qbj per tournament
  roster_name TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tournaments_owner ON tournaments(owner_uid);

-- One bucket per room; the secret in the bucket link is the moderator's
-- only credential (no login).
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  room_name TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,
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
  kind TEXT NOT NULL,                -- 'qbj' | 'game' | 'other'
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  error TEXT,                        -- qbj validation error, if any
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_tournament ON files(tournament_id);
CREATE INDEX IF NOT EXISTS idx_files_bucket ON files(bucket_id);
