-- Rooms starting rounds (worker.js noteRoomStart), for auto-advance.
-- Apply BEFORE deploying a Worker that expects it: the packet route
-- writes here on every hand-out.
--   npx wrangler d1 execute qb-td --remote --file migrate-starts.sql
-- Re-runnable.
CREATE TABLE IF NOT EXISTS room_starts (
  bucket_id INTEGER NOT NULL,
  tournament_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, round)
);
CREATE INDEX IF NOT EXISTS idx_room_starts_tournament ON room_starts(tournament_id, round);
