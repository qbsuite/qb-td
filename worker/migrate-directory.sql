-- Migration for the directory (worker.js "the directory": the home page's
-- list of tournaments run on this instance). Apply BEFORE deploying a
-- Worker that names the column — the tick reads and writes dir_entry:
--   npx wrangler d1 execute qb-td --remote --file migrate-directory.sql
-- then run schema.sql again for the two new indexes (it is re-runnable):
--   npx wrangler d1 execute qb-td --remote --file schema.sql
-- Not re-runnable: the ALTER fails once the column exists.
--
-- dir_entry — the tournament's line in the directory as JSON, NULL while
--             it isn't listed.
ALTER TABLE tournaments ADD COLUMN dir_entry TEXT;

-- Tournaments that already ran are never dirty again, so the tick would
-- never list them. Give each the entry dirEntry() would: listed as past
-- with 10 games over 5 rounds (or as live with 2 rooms reporting — the
-- page drops those once they close), linked only while its public page is
-- on. 172800000 is RUN_TTL.
UPDATE tournaments SET dir_entry = (
  SELECT json_object(
    'n', tournaments.name,
    's', CASE WHEN tournaments.published = 1 THEN tournaments.slug END,
    'd', tournaments.started,
    'c', tournaments.started + 172800000,
    'live', json(CASE WHEN c.rooms >= 2 THEN 'true' ELSE 'false' END),
    'past', json(CASE WHEN c.games >= 10 AND c.rounds >= 5 THEN 'true' ELSE 'false' END))
  FROM (SELECT COUNT(DISTINCT bucket_id) AS rooms, COUNT(*) AS games, COUNT(DISTINCT round) AS rounds
        FROM files WHERE tournament_id = tournaments.id AND kind IN ('qbj', 'combined') AND error IS NULL) AS c
  WHERE c.rooms >= 2 OR (c.games >= 10 AND c.rounds >= 5)
) WHERE started IS NOT NULL;
