-- When the cron last rebuilt a tournament's public data (worker.js
-- tickTournaments), epoch ms. The hub's "Updating / Up to date" mark
-- next to Open public page reads it with pub_dirty. Apply BEFORE
-- deploying a Worker that writes it:
--   npx wrangler d1 execute qb-td --remote --file migrate-pubbuilt.sql
-- Not re-runnable: the ALTER fails once the column exists.
ALTER TABLE tournaments ADD COLUMN pub_built INTEGER;
