-- Migration for the GitHub public-snapshot publisher (worker.js
-- "public snapshots on GitHub"). Apply BEFORE setting SNAPSHOT_REPO:
--   npx wrangler d1 execute qb-td --remote --file migrate-pub.sql
--
-- pub_dirty    — set by markPub() on every blob-affecting mutation;
--                cleared when the cron publishes.
-- pub_snapshot — JSON descriptor of the last published commit:
--                {sha, at, version, schedule, cats, roster, bundle}.
--                Advertised on /pub/:slug as `pub` so the page fetches
--                blobs SHA-pinned from raw.githubusercontent.com.
ALTER TABLE tournaments ADD COLUMN pub_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN pub_snapshot TEXT;
