-- One-time migration for databases created before broadcasts existed.
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so this can't live in
-- schema.sql (which is re-runnable); a fresh database gets the column from
-- schema.sql and must NOT run this file.
--
--   npx wrangler d1 execute qb-td --remote --file migrate-announce.sql
ALTER TABLE tournaments ADD COLUMN announce TEXT NOT NULL DEFAULT '[]';
