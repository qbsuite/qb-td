-- The Live Hub's change counter (tournaments.rev) and the cron's dirty
-- indexes. Apply BEFORE deploying a Worker that expects it: the admin
-- detail reads rev, and the Live Hub sends it back.
--   npx wrangler d1 execute qb-td --remote --file migrate-rev.sql
-- NOT re-runnable as a whole: the ALTER fails on a second run (the column
-- is already there). Everything after it is IF NOT EXISTS, so after a
-- failed ALTER, run the rest by hand or from schema.sql.
ALTER TABLE tournaments ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- The cron's "anything to rebuild?" queries (worker.js tickTournaments,
-- tickSets) run every minute and almost always find nothing. Indexing
-- only the rows they can pick makes that answer cost those rows, not a
-- scan of every tournament and set ever created. The tournament index
-- carries the query's whole condition, not just pub_dirty: a private
-- tournament stays dirty (its rebuild waits for it to go public), so a
-- pub_dirty-only index would still grow with every one of those.
CREATE INDEX IF NOT EXISTS idx_tournaments_dirty ON tournaments(created)
  WHERE pub_dirty = 1 AND (published = 1 OR pub_snapshot IS NOT NULL OR set_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sets_dirty ON sets(id) WHERE state_dirty = 1;

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
