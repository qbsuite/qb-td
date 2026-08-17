-- Migration for the cron's derived-data queue. REQUIRED for any database
-- created before these columns joined schema.sql — the cron builds the
-- round shards the public stats page reads, snapshots or not:
--   npx wrangler d1 execute qb-td --remote --file migrate-pub.sql
--
-- pub_dirty    — set by markPub() on every mutation that changes derived
--                public data; cleared once the cron has rebuilt it.
-- pub_snapshot — JSON descriptor of the last published commit:
--                {sha, at, rounds, schedule, cats, roster, roster_at}.
--                Advertised on /pub/:slug as `pub` so the page fetches
--                blobs SHA-pinned from raw.githubusercontent.com.
ALTER TABLE tournaments ADD COLUMN pub_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN pub_snapshot TEXT;
