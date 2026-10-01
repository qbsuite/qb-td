-- The cron's rebuild queue, served longest-waiting first (worker.js
-- tickTournaments): newest-first starved the oldest tournaments whenever
-- more than four were busy at once (seen 9/30/2026 with 11 simultaneous
-- tournaments: the oldest few showed 1-3 of 12 games inside their round).
-- Apply BEFORE deploying the Worker that writes pub_dirty_at:
--   npx wrangler d1 execute qb-td --remote --file migrate-dirtyat.sql
-- Not re-runnable: the ALTER fails once the column exists. Rows already
-- dirty have no time and sort first, i.e. are served first.
ALTER TABLE tournaments ADD COLUMN pub_dirty_at INTEGER;
DROP INDEX IF EXISTS idx_tournaments_dirty;
CREATE INDEX IF NOT EXISTS idx_tournaments_dirty ON tournaments(pub_dirty_at)
  WHERE pub_dirty = 1 AND (published = 1 OR pub_snapshot IS NOT NULL OR set_id IS NOT NULL);
