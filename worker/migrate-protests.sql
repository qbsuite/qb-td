-- One-time migration for databases created before protests reached the
-- hub. SQLite has no "ADD COLUMN IF NOT EXISTS", so this can't live in
-- schema.sql (which is re-runnable); a fresh database gets the columns
-- from schema.sql and must NOT run this file.
--
--   npx wrangler d1 execute qb-td --remote --file migrate-protests.sql
ALTER TABLE tournaments ADD COLUMN rulings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE files ADD COLUMN summary TEXT;
