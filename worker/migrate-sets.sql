-- Question sets (worker.js "question sets"): the columns that tie a
-- mirror tournament (and its rounds) to its set. The three set tables themselves are
-- CREATE TABLE IF NOT EXISTS in schema.sql — re-run that too.
--   npx wrangler d1 execute qb-td --remote --file schema.sql
--   npx wrangler d1 execute qb-td --remote --file migrate-sets.sql
-- Apply BEFORE deploying a Worker that expects them: the cron's dirty
-- query names set_id. Run once; re-running errors on the duplicate column.
ALTER TABLE tournaments ADD COLUMN set_id INTEGER;
ALTER TABLE tournaments ADD COLUMN set_key_enc TEXT;
ALTER TABLE rounds ADD COLUMN served INTEGER NOT NULL DEFAULT 0;
