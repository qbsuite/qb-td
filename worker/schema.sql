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
  -- Per-bracket rounds, JSON {bracketKey: round} (app/engine/brackets.js):
  -- NULL unless the schedule has more than one bracket in a phase; then
  -- current_round is the lowest of them. Existing databases get it from
  -- migrate-brackets.sql.
  bracket_rounds TEXT,
  -- When the TD pressed Start (worker.js closesAt): NULL during setup,
  -- when the admin link lives SETUP_TTL from creation and room links
  -- serve nothing; once set, every link closes RUN_TTL after it.
  -- Existing databases get it from migrate-start.sql.
  started INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', -- JSON: reader gameFormat etc.
  -- Retired: the TD's broadcasts, removed 9/28/2026. Nothing reads or
  -- writes it; kept so existing databases and this file agree.
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
  -- when it started waiting (epoch ms): the queue is served oldest first,
  -- so a busy tournament can't starve the rest. Existing databases get it
  -- from migrate-dirtyat.sql.
  pub_dirty_at INTEGER,
  pub_snapshot TEXT,                 -- descriptor of the last published commit
  -- When the cron last finished rebuilding it (epoch ms): the hub's
  -- public page mark. Existing databases get it from migrate-pubbuilt.sql.
  pub_built INTEGER,
  -- The public state file on qb-td-live (worker.js "public state on
  -- qb-td-live"): live_want is the hash of the body last built, live_hash
  -- /size/at what the last successful deploy shipped. They differ until a
  -- deploy lands, which is what retries it; live_failed_at paces retries.
  -- Existing databases get these from migrate-live.sql.
  live_want TEXT,
  live_hash TEXT,
  live_size INTEGER,
  live_at INTEGER,
  live_failed_at INTEGER,
  -- Mirrors of a question set (worker.js "question sets"): the set this
  -- tournament was started from, and the set's content key encrypted
  -- under this tournament's own — its rounds rows point at the set's
  -- packet blobs, which only that key opens. NULL on a TD's own
  -- tournament. Deliberately unindexed — a set's mirrors are found through
  -- set_mirrors.tournament_id. Existing databases get these from
  -- migrate-sets.sql.
  set_id INTEGER,
  set_key_enc TEXT,
  -- The Live Hub's change counter: moves whenever anything the admin
  -- detail shows changes (triggers at the end of this file), so a refresh
  -- holding the current rev is answered "unchanged" for the price of the
  -- admin lookup. Existing databases get it from migrate-rev.sql.
  rev INTEGER NOT NULL DEFAULT 0
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

-- The first time each room was handed a round's packet (worker.js
-- noteRoomStart): a room has started that round. Drives auto-advance
-- (settings.autoAdvance) and the Live Hub's room chips. Existing
-- databases get it from migrate-starts.sql (or by re-running this file).
CREATE TABLE IF NOT EXISTS room_starts (
  bucket_id INTEGER NOT NULL,
  tournament_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, round)
);
CREATE INDEX IF NOT EXISTS idx_room_starts_tournament ON room_starts(tournament_id, round);

-- Protests a reader has logged in a game it hasn't uploaded yet
-- (worker.js bucketLiveProtests): the reader sends the game's protest list
-- whenever it changes, so the TD sees a protest the moment it's lodged
-- rather than at upload. One row per game on a reader (game = the reader's
-- game id); an empty list deletes it. summary is {teams, protests}, the
-- shape of files.summary without a score. Admin route only. Existing
-- databases get it from migrate-liveprotests.sql (or by re-running this file).
CREATE TABLE IF NOT EXISTS live_protests (
  bucket_id INTEGER NOT NULL,
  tournament_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  game TEXT NOT NULL,
  summary TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, game)
);
CREATE INDEX IF NOT EXISTS idx_live_protests_tournament ON live_protests(tournament_id);

-- ---------- Live Hub rev + cron dirty indexes ----------
-- (same statements as migrate-rev.sql, which also adds the rev column
-- to existing databases)

-- The cron's "anything to rebuild?" queries (worker.js tickTournaments,
-- tickSets) run every minute and almost always find nothing. Indexing
-- only the rows they can pick makes that answer cost those rows, not a
-- scan of every tournament and set ever created. The tournament index
-- carries the query's whole condition, not just pub_dirty: a private
-- tournament stays dirty (its rebuild waits for it to go public), so a
-- pub_dirty-only index would still grow with every one of those.
CREATE INDEX IF NOT EXISTS idx_tournaments_dirty ON tournaments(pub_dirty_at)
  WHERE pub_dirty = 1 AND (published = 1 OR pub_snapshot IS NOT NULL OR set_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sets_dirty ON sets(id) WHERE state_dirty = 1;

-- The cron's qb-td-live questions (worker.js liveCandidates), asked every
-- minute: the same rule as above, each index holds only the rows its
-- query can pick. live: every deployed file (the manifest, heartbeats);
-- todo: built but not yet deployed; backfill: published, built, never
-- deployed.
CREATE INDEX IF NOT EXISTS idx_tournaments_live ON tournaments(pub_built) WHERE live_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournaments_live_todo ON tournaments(id) WHERE live_want IS NOT live_hash;
CREATE INDEX IF NOT EXISTS idx_tournaments_live_fill ON tournaments(id)
  WHERE published = 1 AND live_hash IS NULL AND pub_built IS NOT NULL;

-- rev moves whenever anything the admin detail (worker.js getTournament)
-- returns changes, so a Live Hub holding the current rev can be told
-- "unchanged" for the price of the admin lookup. Triggers rather than
-- code: a write path added later can't forget to bump it. The cron's own
-- columns (pub_dirty, pub_snapshot) are deliberately not listed — a
-- rebuild changes nothing the hub shows.
CREATE TRIGGER IF NOT EXISTS rev_tournament AFTER UPDATE OF
  slug, name, current_round, started, published, settings, rulings, roster_r2_key, roster_name, set_id
  ON tournaments
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS rev_bucket_ins AFTER INSERT ON buckets
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_bucket_upd AFTER UPDATE ON buckets
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_bucket_del AFTER DELETE ON buckets
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = OLD.tournament_id; END;

CREATE TRIGGER IF NOT EXISTS rev_round_ins AFTER INSERT ON rounds
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_round_upd AFTER UPDATE ON rounds
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_round_del AFTER DELETE ON rounds
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = OLD.tournament_id; END;

CREATE TRIGGER IF NOT EXISTS rev_file_ins AFTER INSERT ON files
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_file_upd AFTER UPDATE ON files
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_file_del AFTER DELETE ON files
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = OLD.tournament_id; END;

CREATE TRIGGER IF NOT EXISTS rev_start_ins AFTER INSERT ON room_starts
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_start_del AFTER DELETE ON room_starts
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = OLD.tournament_id; END;

CREATE TRIGGER IF NOT EXISTS rev_liveprot_ins AFTER INSERT ON live_protests
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_liveprot_upd AFTER UPDATE ON live_protests
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_liveprot_del AFTER DELETE ON live_protests
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = OLD.tournament_id; END;

-- a set's name, page switch and settings, and its packet list, show on
-- every mirror's hub; mirrors are found through set_mirrors (indexed),
-- as everywhere else
CREATE TRIGGER IF NOT EXISTS rev_set_upd AFTER UPDATE OF slug, name, published, settings ON sets
  BEGIN UPDATE tournaments SET rev = rev + 1
    WHERE id IN (SELECT tournament_id FROM set_mirrors WHERE set_id = NEW.id); END;
CREATE TRIGGER IF NOT EXISTS rev_set_packet_ins AFTER INSERT ON set_packets
  BEGIN UPDATE tournaments SET rev = rev + 1
    WHERE id IN (SELECT tournament_id FROM set_mirrors WHERE set_id = NEW.set_id); END;
CREATE TRIGGER IF NOT EXISTS rev_set_packet_upd AFTER UPDATE ON set_packets
  BEGIN UPDATE tournaments SET rev = rev + 1
    WHERE id IN (SELECT tournament_id FROM set_mirrors WHERE set_id = NEW.set_id); END;
