-- Start the tournament (worker.js closesAt): the column that holds when
-- the TD pressed Start. Apply BEFORE deploying a Worker that expects it:
-- room routes and the set dashboard name it.
--   npx wrangler d1 execute qb-td --remote --file migrate-start.sql
-- Run once; re-running errors on the duplicate column.
--
-- Tournaments from before Start existed ran on "48h from creation", which
-- is exactly started = created, so they keep their clocks. The one
-- exception is a tournament still inside those 48h with no games yet: it
-- gets the week of setup instead, and its TD presses Start on the day.
ALTER TABLE tournaments ADD COLUMN started INTEGER;
UPDATE tournaments SET started = created
  WHERE created < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 172800000
     OR EXISTS (SELECT 1 FROM files f WHERE f.tournament_id = tournaments.id);
