# qb-td

Tournament hub for quizbowl TDs: collect ModaQ game files from every room,
distribute packets, track the live round, publish live stats, and export a
YellowFruit `.yft` without touching YellowFruit mid-tournament.

Part of [qbsuite](https://qbsuite.github.io/).

## How it works

- **TO dashboard** (`app/index.html`, GitHub sign-in): create a tournament,
  add a bucket per room, hand each moderator their private link, upload
  packets per round, set the live round, upload the roster qbj, download any
  file, compute stats, export.
- **Moderator bucket page** (`app/bucket.html?b=<secret>`, no login,
  mobile-first): shows the live current round, downloads that round's
  packet, uploads the game's `.qbj` + ModaQ game file.
- **Public stats page** (`app/stats.html?t=<slug>`): standings, individual
  leaderboard, and round-by-round scores computed in the browser from the
  collected qbj files. Only exists while the TO has publish switched on;
  fully decoupled from the admin side.
- **Exports**: a native `.yft` (opens in YellowFruit >= 4.0.18) and a zip of
  the raw qbj files + roster (imports via YellowFruit's ModaQ game-file
  import). Both are generated client-side in the dashboard.

## Layout

- `app/engine/` — dependency-free JS engine, shared by dashboard and stats
  page: `qbj.js` (parse ModaQ match qbj + roster), `stats.js` (standings +
  leaderboard), `yft.js` (`.yft` serialization, contract verified against
  YellowFruit 4.0.18 source), `zip.js` (store-only zip).
- `app/` — the three static pages + `js/` page code. Deployable on any
  static host; served at `qbsuite.github.io/qb-td/app/`.
- `worker/` — Cloudflare Worker (D1 metadata + R2 blobs + GitHub OAuth).
  Auth model: OAuth bearer for the TO API, unguessable bucket secret for
  moderator uploads, publish flag gating all public reads.
- `tests/` — `run_tests.js` (engine unit tests), `e2e_worker.js` (full
  TO -> moderator -> public flow against `wrangler dev`).

## Tests

```bash
node tests/run_tests.js          # engine: qbj parse, stats, .yft, zip

cd worker
printf 'SESSION_SECRET=devsecret\nGITHUB_CLIENT_SECRET=x\n' > .dev.vars
npx wrangler d1 execute qb-td --local --file schema.sql
npx wrangler dev --local --port 8799 &
cd .. && node tests/e2e_worker.js
```

## Deploy (self-hosting)

1. `cd worker`
2. `npx wrangler d1 create qb-td` — put the id in `wrangler.toml`
3. `npx wrangler r2 bucket create qb-td-data`
4. `npx wrangler d1 execute qb-td --remote --file schema.sql`
5. Create a GitHub OAuth app (callback URL
   `https://qb-td.<subdomain>.workers.dev/auth/callback`); put the client id
   in `wrangler.toml`, then
   `npx wrangler secret put GITHUB_CLIENT_SECRET`
6. `openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET`
7. `npx wrangler deploy`
8. Host `app/` anywhere static; set `ALLOWED_ORIGIN` in `wrangler.toml` to
   that origin. Point the pages at your Worker with `?server=...` or by
   editing the default in `app/js/api.js`.

## .yft verification

The generated `.yft` replicates YellowFruit's own serialization
(FileParsing.ts / CaseConversion.ts contracts, `YfVersion` 4.0.18). After
any change to `app/engine/yft.js`: generate a file from real ModaQ games,
open it in YellowFruit, confirm no version/schema errors and that YF's
report matches the stats page.
