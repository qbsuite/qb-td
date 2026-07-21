# qb-td

Tournament hub for quizbowl TDs: collect ModaQ game files from every room,
distribute packets, track the live round, publish live stats, and export a
YellowFruit `.yft` without touching YellowFruit mid-tournament.

Part of [qbsuite](https://qbsuite.github.io/).

## How it works

- **TO dashboard** (`app/index.html`, no account): creating a tournament
  mints an unguessable admin link — the only credential, shown once with a
  save-this-link warning, remembered in that device's localStorage, and
  dead 48 hours after creation. From it: add a bucket per room, hand each
  moderator their private link, set the round count and the live round,
  upload packets per round — one at a time, or a whole zip whose files are
  dragged onto their round slots (filenames carrying a round number can be
  auto-assigned) — create the roster in a text editor (one `Team: Player,
  Player` line per team; downloadable, or saved as the tournament's
  MODAQ-compatible roster.qbj) or upload an existing roster qbj, download
  any file, compute stats, export, rotate the admin link if it leaks.
- **Moderator bucket page** (`app/bucket.html?b=<secret>`, no login,
  mobile-first): shows the live current round, downloads any played
  round's packet (the live round is highlighted; future rounds stay
  locked), uploads the game's `.qbj` + ModaQ game file.
- **Moderator reader page** (`app/read.html?b=<secret>`, same link secret):
  an embedded [MODAQ](https://github.com/alopezlago/MODAQ) preloaded with
  a round's packet (the live round by default; played rounds stay
  selectable for a room running behind), the tournament roster, and the
  TO's game format — the mod picks the round and two teams and reads. "Upload to qb-td" in MODAQ's
  menu sends one `.qbtd.json` per game into the bucket — the match qbj plus
  the full game state in a single file; no file downloads or uploads. The
  dashboard and public routes split the qbj back out wherever a bare `.qbj`
  is needed (stats, the zip export, public downloads) — the game half,
  which contains the packet text, never leaves the TO side. Starting a game mints a per-game URL
  (`&g=<id>`) with its own localStorage, so each game resumes only from
  its own link (offline, zero requests), the room link always starts
  fresh against the live round, and packet re-uploads or round changes
  can never disturb a game in progress; the room link lists this
  device's in-progress games. Any number of moderators can share one
  link (game state is per-device), and stats + the `.yft` count only
  the latest upload per round + team pair — a re-export corrects a
  game instead of double-counting it. `.json` packets load directly; `.docx`
  packets are parsed in the mod's browser by the public YAPP service
  (the same one MODAQ's demo uses — docx question text transits
  quizbowlreader.com).
- **Public stats page** (`app/stats.html?t=<slug>`): standings, individual
  leaderboard, and round-by-round scores computed in the browser from the
  collected qbj files. Only exists while the TO has publish switched on;
  fully decoupled from the admin side.
- **Exports**: a native `.yft` (opens in YellowFruit >= 4.0.18) and a zip of
  the raw qbj files + roster (imports via YellowFruit's ModaQ game-file
  import). Both are generated client-side in the dashboard.

## Link lifetime + question security

- **No accounts.** Admin, bucket, and reader access are all unguessable
  link secrets: 20 chars from a 31-char alphabet (~99 bits) via
  `crypto.getRandomValues`; wrong secrets 404 uniformly. Tournament
  creation is open, rate-limited per IP.
- **Admin links die 48 hours after tournament creation** (410 "tournament
  closed"). A lost or leaked admin link can't be phished or abused after
  the event; published stats stay up, and the public qbj + roster remain
  importable into YellowFruit, so results outlive the link. A leak
  mid-tournament is handled by the dashboard's "new admin link" button.
- **Bucket links die 48 hours after room creation.** The bucket page shows
  "room open until ..." and the dashboard shows each room's close time;
  after that every moderator route returns "room closed". A leaked link
  stops serving packets and accepting uploads soon after the tournament.
- **Packets are only reachable through a bucket link, and only for rounds
  up to the live one** — moderators can't pull future packets, and the
  public routes never serve packets (only match qbj + roster, and only
  while the TO has publish switched on). Bucket links also serve the roster (the
  reader page preloads it); rosters aren't question material.
- The bucket and admin pages carry `noindex` + `no-referrer` so a link
  that leaks into a crawler or an outbound click doesn't spread.
- **Request economics** (Cloudflare free tier): the public stats page
  reads one materialized `combined.json` bundle (maintained on
  upload/delete, TO-rebuildable) instead of fetching every game file, and
  bucket pages poll only while visible, every 60 s. Stats data changes
  only when a file lands; clients compare the `version` stamp in
  `/pub/:slug` and refetch only on change. The reader page never polls:
  one state + packet + roster fetch at load, one upload per export click
  (~4 Worker requests per game — fewer than the manual bucket-page flow),
  and the 2 MB MODAQ bundle is a static asset on GitHub Pages, off
  Cloudflare entirely.

## Layout

- `app/engine/` — dependency-free JS engine, shared by dashboard and stats
  page: `qbj.js` (parse ModaQ match qbj + roster), `stats.js` (standings +
  leaderboard), `yft.js` (`.yft` serialization, contract verified against
  YellowFruit 4.0.18 source), `zip.js` (store-only zip).
- `app/` — the four static pages + `js/` page code. Deployable on any
  static host; served at `qbsuite.github.io/qb-td/app/`. The reader page
  is `read.html` + `js/read.bundle.js`, a committed esbuild bundle of
  MODAQ (rebuild with `npm run build:read` after editing
  `js/read_main.js` / `js/read_core.js` or bumping the `modaq` dep;
  `read_core.js` holds the pure, unit-tested helpers).
- `worker/` — Cloudflare Worker (D1 metadata + R2 blobs). Auth model:
  admin link secret for the TO API (48h lifetime), bucket secret for
  moderator routes, publish flag gating all public reads. No secrets to
  provision.
- `tests/` — `run_tests.js` (engine unit tests), `e2e_worker.js` (full
  TO -> moderator -> public flow against `wrangler dev`).

## Tests

```bash
node tests/run_tests.js          # engine: qbj parse, stats, .yft, zip

cd worker
npx wrangler d1 execute qb-td --local --file schema.sql
npx wrangler dev --local --port 8799 &
cd .. && node tests/e2e_worker.js
```

## Deploy (self-hosting)

1. `cd worker`
2. `npx wrangler d1 create qb-td` — put the id in `wrangler.toml`
3. `npx wrangler r2 bucket create qb-td-data`
4. `npx wrangler d1 execute qb-td --remote --file schema.sql`
5. `npx wrangler deploy`
6. Host `app/` anywhere static; set `ALLOWED_ORIGIN` in `wrangler.toml` to
   that origin. Point the pages at your Worker with `?server=...` or by
   editing the default in `app/js/api.js`.

## .yft verification

The generated `.yft` replicates YellowFruit's own serialization
(FileParsing.ts / CaseConversion.ts contracts, `YfVersion` 4.0.18). After
any change to `app/engine/yft.js`: generate a file from real ModaQ games,
open it in YellowFruit, confirm no version/schema errors and that YF's
report matches the stats page.

## License

MIT (see `LICENSE`). The embedded MODAQ reader and the YellowFruit
file-format relationship are documented in `THIRD_PARTY_NOTICES.md`.
