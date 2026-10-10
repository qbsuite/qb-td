-- Migration for the alerts' one-message-per-tournament and wrap-up
-- (worker.js "new-activity alerts"). Apply BEFORE deploying a Worker that
-- names these columns — the hourly wrap-up query reads `wrapped` whenever
-- DISCORD_WEBHOOK is set:
--   npx wrangler d1 execute qb-td --remote --file migrate-alertmsg.sql
-- Not re-runnable: the ALTERs fail once the columns exist.
--
-- alert_msg — the id of the tournament's message in the operator's
--             Discord channel, so its next step can replace it.
-- wrapped   — 1 once the closing summary has been claimed.
ALTER TABLE tournaments ADD COLUMN alert_msg TEXT;
ALTER TABLE tournaments ADD COLUMN wrapped INTEGER NOT NULL DEFAULT 0;

-- Rows that predate the columns never had a message to follow up on, and
-- the ones that closed in the last week would each be summarized on the
-- first hourly run. Retire them all: the first wrap-up you get is for a
-- tournament created after this.
UPDATE tournaments SET wrapped = 1;
