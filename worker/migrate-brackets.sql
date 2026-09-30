-- Per-bracket rounds (app/engine/brackets.js): {bracketKey: round} for
-- the phase being played, NULL when the schedule has one bracket (or
-- none) and everything runs on current_round as before. Apply BEFORE
-- deploying a Worker that reads it:
--   npx wrangler d1 execute qb-td --remote --file migrate-brackets.sql
-- Not re-runnable: the ALTER fails once the column exists.
ALTER TABLE tournaments ADD COLUMN bracket_rounds TEXT;
