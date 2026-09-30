-- Public state files on qb-td-live (worker.js "public state on
-- qb-td-live"). Apply BEFORE deploying a Worker with LIVE_SCRIPT set:
--   npx wrangler d1 execute qb-td --remote --file migrate-live.sql
-- Not re-runnable: the ALTERs fail once the columns exist.
ALTER TABLE tournaments ADD COLUMN live_want TEXT;
ALTER TABLE tournaments ADD COLUMN live_hash TEXT;
ALTER TABLE tournaments ADD COLUMN live_size INTEGER;
ALTER TABLE tournaments ADD COLUMN live_at INTEGER;
ALTER TABLE tournaments ADD COLUMN live_failed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_tournaments_live ON tournaments(pub_built) WHERE live_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournaments_live_todo ON tournaments(id) WHERE live_want IS NOT live_hash;
CREATE INDEX IF NOT EXISTS idx_tournaments_live_fill ON tournaments(id)
  WHERE published = 1 AND live_hash IS NULL AND pub_built IS NOT NULL;
