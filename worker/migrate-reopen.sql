-- An operator's override for when a tournament's links close (worker.js
-- closesAt): NULL keeps the usual clocks; a time in ms replaces them, to
-- reopen a finished tournament for a few more days (README "Reopening a
-- tournament").
-- Apply BEFORE deploying the Worker that reads this column:
--   npx wrangler d1 execute qb-td --remote --file migrate-reopen.sql
-- Not re-runnable: the ALTER fails once the column exists.
ALTER TABLE tournaments ADD COLUMN closes_at INTEGER;
