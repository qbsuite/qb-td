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
  -- JSON map of the TD's protest rulings (worker.js cleanRulings), keyed
  -- by the hub (round + question + team pair). Admin route only.
  -- Existing databases get it from migrate-protests.sql.
  rulings TEXT NOT NULL DEFAULT '{}',
  roster_r2_key TEXT,                -- single roster qbj per tournament
  roster_name TEXT,
  created INTEGER NOT NULL,
  -- Derived-data queue (worker.js tickDirty): set by markPub() on every
  -- mutation that changes what the public page reads, cleared when the
  -- cron has rebuilt the round shards (and published them, if snapshots
  -- are configured). Existing databases get these from migrate-pub.sql.
  pub_dirty INTEGER NOT NULL DEFAULT 0,
  pub_snapshot TEXT,                 -- descriptor of the last published commit
  -- Mirrors of a question set (worker.js "question sets"): the set this
  -- tournament was started from, and the set's content key encrypted
  -- under this tournament's own — its rounds rows point at the set's
  -- packet blobs, which only that key opens. NULL on a TD's own
  -- tournament. Deliberately unindexed — a set's mirrors are found through
  -- set_mirrors.tournament_id. Existing databases get these from
  -- migrate-sets.sql.
  set_id INTEGER,
  set_key_enc TEXT
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
  -- A set's mirror only (worker.js mirrorsOpenFor): 1 once a room has been
  -- handed this round's packet, after which a fix uploaded to the set no
  -- longer re-points it. Existing databases get it from migrate-sets.sql.
  served INTEGER NOT NULL DEFAULT 0,
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
  created INTEGER NOT NULL,
  -- JSON {teams, score, protests} for a valid match (worker.js
  -- matchSummary): what the hub's Protests drawer reads. Never public.
  -- Existing databases get it from migrate-protests.sql.
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_tournament ON files(tournament_id);
CREATE INDEX IF NOT EXISTS idx_files_bucket ON files(bucket_id);

-- Question sets (worker.js "question sets"): a set editor uploads the
-- packets once and hands each mirror's TD an invite; starting the invite
-- creates an ordinary 48h tournament whose rounds point at the set's
-- packets. Same credential idiom as tournaments — admin_secret holds the
-- hash, admin_wrap the set's content key wrapped under the link secret —
-- but the link lives a year (SET_TTL), because a set is mirrored for a
-- season rather than played in a day.
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,         -- public set page slug (own namespace)
  name TEXT NOT NULL,
  admin_secret TEXT NOT NULL UNIQUE, -- the editor's link credential (hashed)
  admin_wrap TEXT NOT NULL,          -- content key wrapped under the admin secret
  buzz_wrap TEXT,                    -- content key wrapped under the buzzpoints derived key
  creator_ip TEXT,                   -- creation rate limiting only
  published INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', -- JSON: reader gameFormat (copied into mirrors), buzz
  created INTEGER NOT NULL,
  -- set by every mutation that changes the set page's state blob
  -- (s/<sid>/state.json); the cron is that blob's only writer
  state_dirty INTEGER NOT NULL DEFAULT 0
);

-- Every version of every packet. Blobs are immutable and rows are never
-- deleted: a mirror's rounds row pins the exact version it played, which
-- is what keeps set-wide buzzpoints honest after a packet is fixed
-- mid-season. At most one version per packet has retired = 0 — the one
-- new mirrors start with.
CREATE TABLE IF NOT EXISTS set_packets (
  set_id INTEGER NOT NULL,
  packet INTEGER NOT NULL,           -- the set's own numbering; a mirror's TD decides the round
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  -- the editor's parse review (app/engine/packetcheck.js, run in the
  -- browser): how many things looked off, and when a person signed it
  -- off. Display state only; nothing reads it.
  warnings INTEGER,
  checked INTEGER,
  PRIMARY KEY (set_id, packet, version)
);

-- One row per mirror: an invite until its TD starts it (or uses it to
-- join a tournament they already made), then the link to that tournament. The invite secret is a credential like any
-- other (hashed; wraps the set's content key so starting the mirror can
-- hand that key to the new tournament); invite_enc is the secret under
-- the set's content key, so the editor's dashboard can show the link again.
CREATE TABLE IF NOT EXISTS set_mirrors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  name TEXT NOT NULL,                -- the editor's label, prefilled as the tournament name
  slug TEXT,                         -- suggested tournament slug (the TD may change it)
  host TEXT,
  event_date TEXT,                   -- YYYY-MM-DD, display only
  invite_secret TEXT NOT NULL UNIQUE,
  invite_wrap TEXT NOT NULL,
  invite_enc TEXT NOT NULL,
  created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, -- left out of set-wide stats (a test run, a junk mirror)
  started INTEGER,                   -- when the TD started it; claims the invite
  tournament_id INTEGER,
  -- the mirror's content key under the set's, written when it starts or
  -- joins: what lets the set's editors open its stored game files
  mirror_key_enc TEXT,
  -- the cron worked on this mirror's tournament since the set's state
  -- blob last re-read it (worker.js rebuildSetState)
  state_dirty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_set_mirrors_set ON set_mirrors(set_id);
CREATE INDEX IF NOT EXISTS idx_set_mirrors_tournament ON set_mirrors(tournament_id);
