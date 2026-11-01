-- Room uploads cleared once links close (worker.js pruneUploads): the
-- hourly cron deletes the uploads a newer one replaced at close, and the
-- rest a week later (a set's mirror keeps its newest while the set's link
-- lasts). Rows stay; files.gone marks the ones whose blob is gone.
-- Apply BEFORE deploying the Worker that reads these columns:
--   npx wrangler d1 execute qb-td --remote --file migrate-prune.sql
-- Not re-runnable: the ALTERs fail once the columns exist.
ALTER TABLE files ADD COLUMN gone INTEGER;
ALTER TABLE tournaments ADD COLUMN uploads_pruned INTEGER;
