-- Protests from games not yet uploaded (worker.js bucketLiveProtests).
-- Apply BEFORE deploying a Worker that expects it: the admin detail reads
-- this table.
--   npx wrangler d1 execute qb-td --remote --file migrate-liveprotests.sql
-- Re-runnable.
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

CREATE TRIGGER IF NOT EXISTS rev_liveprot_ins AFTER INSERT ON live_protests
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_liveprot_upd AFTER UPDATE ON live_protests
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = NEW.tournament_id; END;
CREATE TRIGGER IF NOT EXISTS rev_liveprot_del AFTER DELETE ON live_protests
  BEGIN UPDATE tournaments SET rev = rev + 1 WHERE id = OLD.tournament_id; END;
