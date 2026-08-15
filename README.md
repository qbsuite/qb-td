# qb-td

Tournament hub for quizbowl TDs: collect MODAQ game files from every room,
distribute packets, track the live round, generate and publish the
schedule, publish live stats, and export a YellowFruit `.yft` without
touching YellowFruit mid-tournament.

Part of [qbsuite](https://qbsuite.github.io/).

## How it works

- **TO dashboard** (`app/index.html`, no account): creating a tournament
  mints an unguessable admin link — the only credential, shown once with a
  save-this-link warning, remembered in that device's localStorage, and
  dead 48 hours after creation. Two views. **Tournament Setup** is the
  before-the-day work, four steps with a done-state pill each:
  **Rooms** (create N at once — Room 1…N, renamed inline in the table —
  each room a bucket whose private reader/bucket links go to its
  moderator), **Packets + Tiebreakers** (every upload is one button that
  opens the picker — a whole zip staged as chips dragged onto round
  slots, filenames carrying a round number auto-assigned without ever
  overwriting an uploaded round, or loose files the same way; a
  tiebreaker packet is split into individually tracked questions — see
  below), **Roster** (structured editor: one card per team, one field
  per name — so commas in *Smith, Jr.* and quotes in *St. John's "A"*
  can never split a name, verified against MODAQ's and YellowFruit's own
  parsers — Tab/Enter grows the player list, card order is seed order
  with reorder arrows; or upload an existing roster qbj, previewed
  before it saves), and **Schedule** (pick a format for the team/room
  count — full round robin; double, triple, or quadruple RR for small
  fields; 2 pools with carryover crossover playoffs; 3-4 pools
  regrouping by finish position — clean-room circle-method pairings,
  snake-seeded from roster order — then edit anywhere in the grid:
  click a slot for a dropdown of teams still free that round, drag
  chips to swap teams, drag a match box (or its ⇄ handle) to trade
  whole matches between any two cells, insert or delete rounds from any
  row, add or drop room columns (a dropped column's teams land in the
  bye tray), and link each schedule room to a bucket. Playoff slots are
  placeholders ("A1" = pool A's 1st) — **Fill playoff slots from
  standings** resolves them from the collected games' standings once
  prelims are in, and hand-editing stays the override). The **Live Hub**
  is the day-of page, carrying a notice until setup is complete: a
  status strip tracks the live round (packet up, games in vs scheduled,
  which rooms are still out, tiebreakers used vs unused) with one-click
  advance next to the free set-any-round control; the **broadcasts**
  drawer (one line, up to 200 characters, addressed to the public page
  and/or the rooms — every room, or a checked few — as a note or an
  alert, with a mandatory expiry from 30 minutes to the tournament's own
  close; a table of what's live, each removable, and the drawer's
  summary carries the newest one so a collapsed drawer still answers
  "what did I tell people?"); settings (public page, reader game
  format — a MODAQ preset plus every field of MODAQ's own customize
  dialog, stored as overrides so it applies to every room — and
  admin-link rotation for leaks); stats + export with the buzzpoints
  control; and uploads grouped by round with a completeness pill per
  group (current round open by default).
- **Tiebreakers**: a tiebreaker packet uploads once and is split into
  individually tracked questions (TU1, TU2, … B1, …), answerlines shown
  on the dashboard. In every room's MODAQ, **Actions → Add questions…**
  lists the pool — each question with who has already heard it — and
  appends exactly the picked question to the end of the packet, mid-game,
  through MODAQ's own supported path (thrown-out tossups and tied games
  both land there naturally). Every "Upload to qb-td" reports which pool
  questions the game actually read, so the dashboard log always says
  which teams have heard which question — a re-export of the same game
  replaces its entries instead of double-counting, and a question is
  logged only when it was truly read (an added-but-unreached question
  stays unused).
- **Moderator bucket page** (`app/bucket.html?b=<secret>`, no login,
  mobile-first): shows the live current round, downloads any played
  round's packet (the live round is highlighted; future rounds stay
  locked), uploads the game's `.qbj` + MODAQ game file, and carries the
  TD's broadcasts for this room (alerts first, then newest first).
- **Moderator reader page** (`app/read.html?b=<secret>`, same link secret):
  an embedded [MODAQ](https://github.com/alopezlago/MODAQ) preloaded with
  a round's packet (the live round by default; played rounds stay
  selectable for a room running behind), the tournament roster, and the
  TO's game format — the mod picks the round and two teams and reads.
  With a schedule whose room is linked to this bucket, the pickers
  preselect the round's scheduled matchup (still overridable) and the
  room's schedule line shows above the round list; a tiebreaker pool
  shows beside it with each question's heard-by state, and during a game
  the pool lives in MODAQ's Actions → Add questions dialog (qb-td's own
  selector, swapped in at bundle time — the stock file picker stays as
  its fallback). "Upload to qb-td" in MODAQ's
  menu sends one `.qbtd.json` per game into the bucket — the match qbj plus
  the full game state in a single file, plus which tiebreaker questions
  the game read; no file downloads or uploads. The
  dashboard and public routes split the qbj back out wherever a bare `.qbj`
  is needed (stats, the zip export, public downloads) — the game half,
  which contains the packet text, never leaves the TO side. Starting a game mints a per-game URL
  (`&g=<id>`) with its own localStorage, so each game resumes only from
  its own link (offline, zero requests), the room link always starts
  fresh against the live round, and packet re-uploads or round changes
  can never disturb a game in progress; the room link lists this
  device's in-progress games. The TD's newest broadcast sits on one quiet
  strip above MODAQ, picked up when the room link loads and again from
  every upload's response — the page still never polls. Any number of moderators can share one
  link (game state is per-device), and stats + the `.yft` count only
  the latest upload per round + team pair — a re-export corrects a
  game instead of double-counting it. `.json` packets load directly; `.docx`
  packets are parsed in the mod's browser by the public YAPP service
  (the same one MODAQ's demo uses — docx question text transits
  quizbowlreader.com).
- **Public tournament page** (`app/t.html?t=<slug>`; `stats.html`
  redirects): schedule + stats + buzzpoints tabs, under any broadcast the
  TD addressed to the public page. The schedule tab
  renders the grid with played games' scores filled in from the
  collected qbj files (exact team-name match) and a per-team view
  behind a dropdown; the stats tab has standings, individual
  leaderboard, and round-by-round scores, all computed in the browser.
  The categories tab (appears when any JSON packet carries qbreader
  category metadata) shows per-player buzz results sliced by category
  and subcategory — filter pills by category, or a by-player view with
  each player's per-category breakdown; it reads a text-free category
  map the Worker extracts from packets at upload (`/pub/:slug/cats` —
  no question text, so it's public without the buzzpoints gate; docx
  packets carry no categories).
  The buzzpoints tab (TO-enabled, always password-gated — off or on,
  never open) lists each
  round's questions in packet order as collapsed answerlines (first
  answerline only, keeping the packet's bold/underline on the required
  part) — a tossup
  expands to its text with every room's buzzed words underlined
  (MODAQ's `buzz_position.word_index` rides in every qbj), the bonus
  read with it expands to per-part conversion and each room's line —
  plus a per-player summary (15/10/neg counts, average and earliest
  correct buzz). Question text comes from the round packets through a gated
  route; the TO's password is stretched in the browser (PBKDF2-SHA256,
  600k iterations, random salt — `app/js/buzzkey.js`) and only the derived
  key is ever sent, so the Worker neither receives nor stores the password
  and its own per-request work stays one hash. The salt and iteration
  count are public because a viewer's browser needs them; the stored hash
  is not, and attempts are capped per IP. Setting a new password moves the
  public `buzz_v` stamp, so viewers must enter it again. See "Buzzpoints
  password" below. A round's buzzpoints and packet text stay hidden — server-
  gated for text, tab-wide for the view — until every room has turned
  that round in (scheduled games when a schedule exists, one game per
  room otherwise), so a lagging room's teams can't read answers
  mid-round. Only exists while the TO
  has publish switched on; fully decoupled from the admin side.
- **Exports**: a native `.yft` (opens in YellowFruit >= 4.0.18); the
  **HTML stat report** as a zip of the same six interlinked pages
  YellowFruit publishes (`standings.html`, `individuals.html`, `games.html`,
  `teamdetail.html`, `playerdetail.html`, `rounds.html`) — unzip and host
  the folder anywhere, no YellowFruit in the loop; and a zip of
  every game's separated files — the match `.qbj` (imports via YellowFruit's
  MODAQ game-file import) and the MODAQ game file — plus the roster. All
  are generated client-side in the dashboard. Combined reader uploads are
  never handed out raw: the dashboard's per-file downloads (Worker
  `part=qbj|game`) and the zip both split them into those two real files.
- **Archive** (`app/archive.html`): a curated list of past tournaments, and
  with `?t=<slug>` any one of them. An archived tournament runs the real
  `pubview.js` against a committed capture of its `/pub` responses
  (`app/archive/<slug>.js`) instead of the Worker, so the schedule, stats,
  and categories tabs work with no server and no tournament of your own,
  and keep working if the backend ever goes away. Each entry also ships its
  six-page stat report as static HTML. Buzzpoints is switched off in a
  capture: that tab needs the gated packet-text route, which isn't
  archived. See "Archiving a tournament" below.

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
  while the TO has publish switched on). The one exception is opt-in:
  the buzzpoints packet route (`/pub/:slug/qpacket`), which the TO
  explicitly enables (password-gated or public) and which serves played
  rounds only, under the same future-round lock. Bucket links also serve the roster (the
  reader page preloads it); rosters aren't question material. The
  tiebreaker pool (question text included) is served only through admin
  and bucket links — the same trust level as packets; only the
  bucket-side copy carries the usage log the reader panel shows.
- **Question text is encrypted at rest — the operator can't read it
  either.** Every question-text blob (packets, the tiebreaker pool, the
  reader's combined game uploads) is AES-256-GCM-encrypted in R2 under a
  random per-tournament content key, and that key is stored only wrapped
  under keys derived from the link secrets — which D1 itself holds only
  as SHA-256 hashes. Every request that legitimately needs plaintext
  carries a secret in its URL (or the buzzpoints derived key in its
  `Authorization` header); the Worker unwraps the content key per
  request, in memory only. So browsing the R2 bucket or the database —
  operator included — yields ciphertext and hashes, a D1 leak hands out
  no working links, and once a tournament's links expire its question
  text is cryptographically gone even though the blobs remain. The
  honest limit: nothing can stop a malicious operator from *modifying
  the running Worker* to capture secrets in flight — the Worker must
  produce plaintext for moderators. What encryption removes is at-rest
  and retroactive access. (`worker.js` "question text encryption",
  `migrate-crypt.sql`.)
- **Match `notes` never reach a public copy.** MODAQ writes protest
  reasons — moderator free text that routinely quotes answers — into the
  match qbj's `notes` field verbatim. The Worker strips `notes` from
  every bundle entry (and the public per-game qbj downloads are served
  from the bundle), so the live public page, the GitHub snapshot repo,
  and archive captures never carry it; the TO's admin downloads keep it
  for the `.yft`. Rooms likewise receive only the reader game format
  from `settings` — never the buzzpoints config, whose stored hash would
  otherwise invite an offline attack on the TO's password.
- The bucket and admin pages carry `noindex` + `no-referrer` so a link
  that leaks into a crawler or an outbound click doesn't spread.
- **Request economics** (Cloudflare free tier): the public page
  reads one materialized `combined.json` bundle (maintained on
  upload/delete, TO-rebuildable) instead of fetching every game file, and
  bucket pages poll only while visible, every 60 s. Broadcasts add no
  requests at all: they live in a column on the tournament row and ride
  out on those two state responses (so a room sees one within a minute,
  the public page within five) plus the moderator upload response.
  Stats data changes
  only when a file lands; clients compare the `version` stamp in
  `/pub/:slug` and refetch only on change. The schedule is one R2 blob
  (`t/<tid>/schedule.json`) with its own stamp in `/pub/:slug` (R2
  head), refetched only when it moves and served with `max-age=60`;
  the reader fetches it once per load, never on the bucket poll. The reader page never polls:
  one state + packet + roster fetch at load, one upload per export click
  (~4 Worker requests per game — fewer than the manual bucket-page flow),
  and the 2 MB MODAQ bundle is a static asset on GitHub Pages, off
  Cloudflare entirely.
- **Finished tournaments stop costing anything.** Rooms can only be
  created while the admin link lives (48 h), and each room accepts
  uploads for 48 h after its own creation, so nothing can change after
  `created + 96 h` (`FINAL_TTL` in `worker.js`) — the data is provably
  frozen, with no extra column or cron to say so. Past that point
  `/pub/:slug` reports `final: true`, every public answer is served with
  a week's `max-age` instead of a minute's, and `pubview.js` clears its
  poll timer for good. A tab left open on last season's tournament stops
  talking to the Worker, and a repeat visitor is served by their own
  browser cache. This is what keeps the long tail flat: a finished
  tournament costs about one request per visitor rather than one every
  five minutes per open tab. Caching *inside* the Worker would not do
  this — a `workers.dev` request invokes the Worker whether or not the
  response is cached, so the saving has to come from the browser not
  asking.

## Layout

- `app/engine/` — dependency-free JS engine, shared by dashboard and the
  public page: `qbj.js` (parse MODAQ match qbj + roster), `stats.js`
  (standings + leaderboard), `schedule.js` (round-robin/pool generation,
  format catalog, editing helpers, room lookups), `buzz.js` (per-buzz
  extraction from match qbj, room-merged tossup buzzes, player buzz
  summary), `yft.js` (`.yft`
  serialization, contract verified against YellowFruit 4.0.18 source),
  `report.js` (the six-page HTML stat report, ported from YellowFruit
  4.0.18's `HTMLReports.ts` / `StatSummaries.ts`), `zip.js` (store-only
  zip).
- `app/` — the static pages + `js/` page code (`announce.js` renders
  the TD's broadcasts on all three read surfaces). Deployable on any
  static host; served at `qbsuite.github.io/qb-td/app/`. `archive.html` +
  `archive/` are the archive page and its committed captures. The reader page
  is `read.html` + `js/read.bundle.js`, a committed esbuild bundle of
  MODAQ (rebuild with `npm run build:read` — `tools/build_read.mjs`,
  which also swaps MODAQ's stock Add Questions dialog for the tiebreaker
  selector `js/tb_add_dialog.js`, bridged to the page by
  `js/tb_bridge.js` — after editing `js/read_main.js` /
  `js/read_core.js` / `js/tb_add_dialog.js` or bumping the `modaq` dep;
  `read_core.js` holds the pure, unit-tested helpers).
- `worker/` — Cloudflare Worker (D1 metadata + R2 blobs). Auth model:
  admin link secret for the TO API (48h lifetime), bucket secret for
  moderator routes, publish flag gating all public reads. No secrets to
  provision.
- `tests/` — `run_tests.js` (engine unit tests), `e2e_worker.js` (full
  TO -> moderator -> public flow against `wrangler dev`).
- `tools/archive.mjs` — the archive's approval CLI (see below). The only
  code here that reads the live backend outside a browser.
- `app/demo.html` + `js/demo.js` + `demo/fixture.js` — the demo
  tournament. Opening any page with `?t=demo`, `?a=demo`, or
  `?b=demo` / `?b=demo-b` (the slug is reserved; real bucket secrets are
  long random tokens) makes `api.js` serve every `pub()` call from
  `demo.js` in the browser: the committed fixture holds a 4-team triple
  round robin (Stanford, Berkeley, UIUC, ASU) mid-event, the TD hub
  runs read-only against it (advance-round and visitor-upload deletes
  work; stats, report, `.yft`, and zip exports are client-side anyway),
  and games a visitor reads in the embedded MODAQ upload into
  localStorage and flow into stats, buzzpoints, and categories. A demo
  visitor costs zero Worker requests — the unit suite runs the whole
  flow with `fetch` stubbed to throw. The packets in `tools/demo/` are
  2022 ACF Winter packets 1-9 (via qbreader, `<i>` converted to `<em>`
  for MODAQ's formatter); regenerate the fixture with
  `node tools/demo_fixture.mjs`. In `read.bundle.js` the demo module
  loads via a runtime `import()` (non-literal specifier, so esbuild
  leaves it out of the bundle) — the fixture never rides along with
  MODAQ.

## Tests

```bash
node tests/run_tests.js          # engine: qbj parse, stats, .yft, report, zip, archive
node tests/snapshot_publish.js   # GitHub snapshot publisher (D1/R2/GitHub mocked)

cd worker
npx wrangler d1 execute qb-td --local --file schema.sql
# an existing local DB from before at-rest encryption needs, once:
#   npx wrangler d1 execute qb-td --local --file migrate-crypt.sql
npx wrangler dev --local --port 8799 &
cd .. && node tests/e2e_worker.js
```

`wrangler` is a pinned devDependency, so `npm install` puts the tested
version on `npx` rather than leaving the suite on whatever the global npx
cache last downloaded. `e2e_worker.js` backdates the tournament row at the
end, which is also how it exercises the `final` caching path.

## Deploy (self-hosting)

1. `cd worker`
2. `npx wrangler d1 create qb-td` — put the id in `wrangler.toml`
3. `npx wrangler r2 bucket create qb-td-data`
4. `npx wrangler d1 execute qb-td --remote --file schema.sql`
   (a database created before broadcasts existed also needs
   `npx wrangler d1 execute qb-td --remote --file migrate-announce.sql`,
   and one from before at-rest encryption needs
   `npx wrangler d1 execute qb-td --remote --file migrate-crypt.sql`,
   each once — `schema.sql` is re-runnable and can't add a column.
   Apply `migrate-crypt.sql` BEFORE deploying a Worker that expects it;
   tournaments created before the migration stay on the legacy
   plaintext paths and age out within 48 h)
5. `npx wrangler deploy`
6. Host `app/` anywhere static; set `ALLOWED_ORIGIN` in `wrangler.toml` to
   that origin. Point the pages at your Worker with `?server=...` or by
   editing the default in `app/js/api.js`.

## Public snapshots on GitHub (optional)

Makes public stat viewing free at any audience size. Without it, every
viewer's requests (the 5-minute state poll, plus blob refetches of the
stats bundle, schedule, category map, roster) hit the Worker — and the
bundle grows with the tournament, so a popular event spends the same
100k-requests/day budget the moderator rooms and TO dashboard run on.
With it, the Worker publishes to a GitHub data repo on every change (at
most once per minute per tournament): first the blobs, one atomic
commit, then `<slug>/state.json` — a frozen copy of the `/pub/:slug`
response carrying that blob commit's SHA. The public page fetches blobs
SHA-pinned from `raw.githubusercontent.com/<repo>/<sha>/…` (immutable,
CDN-served) and polls `state.json` from the branch head, whose ~5-minute
CDN cache matches the poll cadence — so a steady viewer sends the Worker
*nothing*. The Worker answers one `/pub/:slug` per page load (that's how
the page learns the repo and branch, and it beats the CDN's staleness on
open) and keeps serving every route as the automatic fallback. Two
things a frozen state can't compute travel as data: broadcasts carry
their expiry (the page filters), and `final_after` tells the page when
to stop polling on its own. Buzzpoints stay on the Worker: packet text
is password-gated per request, which a static host can't do.

Every fetch falls back to the `/pub` routes, so a failed publish, a
pruned repo, or turning the feature off just means Worker serving —
exactly the behavior without this section. Unpublishing a tournament
makes the next cron tick delete its folder from the branch head, so the
static poll stops finding it. Archive captures ignore snapshots
entirely (the capture is the data).

Setup:

1. Create a **public** data repo (e.g. `qbsuite/qb-td-live`) with an
   initial commit (README is fine — the publisher can create the branch
   but a non-empty repo avoids the edge).
2. Credential with **contents:write on only that repo** — either a
   GitHub App (create under the org: no webhook, Repository permissions →
   Contents: Read and write, install on the data repo only; then fill
   `GITHUB_APP_ID` + `GITHUB_INSTALLATION_ID` in `wrangler.toml` and
   `npx wrangler secret put GITHUB_APP_KEY` with the private key
   converted to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in app.pem`) or a
   fine-grained PAT (`npx wrangler secret put GITHUB_TOKEN`).
3. `npx wrangler d1 execute qb-td --remote --file migrate-pub.sql` (once).
4. Set `SNAPSHOT_REPO = "owner/repo"` in `wrangler.toml`, `npx wrangler
   deploy`. The cron trigger deploys with it; setting `SNAPSHOT_REPO`
   back to `""` turns the whole feature off again.

Freshness: a change is committed within ~a minute; a viewer's next
5-minute poll sees it as soon as the raw CDN's ~5-minute cache on the
branch-head `state.json` turns over — worst case roughly two poll
periods end to end, typically one. The refresh button skips all of that
(it re-asks the Worker directly). The data repo's history grows two
small commits per change; old slugs can be deleted from the branch
freely (archived pages don't read it, and SHA-pinned fetches of
*recorded* snapshots still resolve through history).

## Deleting a tournament (operator runbook)

There is deliberately no delete API — nothing reachable from the
internet can destroy a tournament. Normally none is needed: tournaments
go final after 96 h and unpublished ones are invisible. To actually
remove one (spam, a test that got published), do it with operator
credentials from `worker/`:

```bash
# find the id and its uploaded blobs
npx wrangler d1 execute qb-td --remote --command \
  "SELECT id FROM tournaments WHERE slug='<slug>'"
npx wrangler d1 execute qb-td --remote --command \
  "SELECT r2_key FROM files WHERE tournament_id=<id>"

# delete rows (all four tables key off the tournament), then each blob —
# everything lives under the t/<id>/ prefix: the uploads from the query
# above, packet keys from the rounds table, and the derived
# combined.json / schedule.json / catmap.json / roster.qbj /
# tiebreakers.json where present
npx wrangler d1 execute qb-td --remote --command \
  "DELETE FROM files WHERE tournament_id=<id>; DELETE FROM buckets WHERE tournament_id=<id>; DELETE FROM rounds WHERE tournament_id=<id>; DELETE FROM tournaments WHERE id=<id>"
npx wrangler r2 object delete "qb-td-data/<r2_key>" --remote
```

If snapshots are enabled, also `git rm -r <slug>` in the data repo —
harmless to skip (nothing points at it once `/pub/:slug` is gone), but
tidy. Know what that does and doesn't remove: **git history is
forever** on a public repo — deleting a folder from the branch head
leaves every old commit fetchable by SHA. The snapshot repo only ever
receives text-free public data (bundle, schedule, category map, roster,
state), so normally this is fine — but a roster carries player names,
and a true scrub of anything that should never have been published
means rewriting history (`git filter-repo` + force push), not just
`git rm`.

## Buzzpoints password

The one place qb-td has a user-chosen secret rather than a generated one,
so it gets the scrutiny that implies.

**The Worker never sees the password.** `app/js/buzzkey.js` stretches it
with PBKDF2-SHA256 (600k iterations, per-tournament random salt) in the
browser, and the derived key is what travels in `Authorization: Buzz`.
`settings.buzz.hash` is SHA-256 of that key, so verification costs the
Worker one hash — the free tier allows 10 ms CPU per request, nowhere near
enough to run PBKDF2 server-side. `iters` and `salt` are published in
`/pub/:slug` because a viewer's browser needs them to derive the same key;
a salt is not a secret, it only stops one precomputed table covering every
tournament. The hash never leaves the Worker, so there is nothing public
to attack offline, and if a settings row ever did leak, each guess costs a
full PBKDF2 run rather than one SHA-256.

**Online guessing is capped** at 30 attempts per minute per IP per
tournament (`BUZZ_LIMIT` in `wrangler.toml`). Two honest limits: Cloudflare's
rate limiter counts per colo rather than globally, and it runs inside the
Worker, so it protects the password but not the request budget. A WAF
rate-limiting rule on `/pub/*/qpacket` is the outer layer for that, and
worth adding if anyone ever points a script at this — a flood would burn
the daily request allowance and take the live public page down with it.

**What is still on the TD.** None of the above rescues a guessable
password. 30 attempts a minute is a wall for a wordlist but not for
"stanford" as the third guess. Generating the password instead of letting
the TD pick one would remove the problem rather than slow it; that is a
deliberate open choice, not an oversight.

**Setting a password also sends the derived key once** (`buzz_token`
alongside the settings): the Worker wraps the tournament's content key
under it (`buzz_wrap`) so the gated `qpacket` route can decrypt packets
at request time, then discards it — it is stored on neither side. A
password set by a client that skipped the token (or a wrap that
predates the current password) leaves the route answering 409 "packets
locked"; setting the password again repairs it.

Tournaments whose password predates the KDF carry `{mode, salt, hash}`
with no `kdf`, verified the old way (`sha256("salt:password")`, password
on the wire). They keep working; setting a new password upgrades them.
A config claiming `kdf` but with unknown parameters or fewer than 100k
iterations fails shut — the tab reads as off rather than as a weak gate.

## Archiving a tournament

A published tournament is public but unlisted: you need its slug to find
it, and it lives only as long as the Worker and its R2 bucket do. The
archive is the curated other half, and joining it takes an explicit
approval.

```bash
node tools/archive.mjs list                    # published tournaments, and which are archived
node tools/archive.mjs add <slug> --date 2026-07-25 --host "Stanford"
node tools/archive.mjs refresh <slug>          # recapture after a late correction
node tools/archive.mjs remove <slug>           # un-approve
```

`add` reads the public routes, writes the frozen capture
(`app/archive/<slug>.js`), generates the six report pages
(`app/archive/<slug>/`), and adds a manifest entry to
`app/archive/index.json`. Committing that is the approval. Nothing here
writes to the backend, and the tournament's live page is unaffected either
way.

The gate is deliberately outside the Worker. An `archived` column plus an
owner-only route would mean the first real account in a system whose whole
auth model is link secrets; here the credential is the Cloudflare login
`list` needs plus push access to this repo. Keeping captures in the repo
rather than in R2 also means the archive survives the backend: about 18 KB
gzipped per tournament, which is what git stores and what a visitor
downloads, and `archive.html` imports only the one capture being viewed.

`add` refuses to write if the bundle contains any long string outside
`notes` (the field MODAQ writes "Tossup thrown out on question N" into),
since that would mean packet text leaking into a file about to be
committed and served forever. `run_tests.js` re-runs that check on what
actually got committed, along with manifest-to-capture agreement.

## YellowFruit fidelity

Two exports mirror YellowFruit's own output and are checked against its
source rather than guessed at.

The generated `.yft` replicates YellowFruit's serialization
(FileParsing.ts / CaseConversion.ts contracts, `YfVersion` 4.0.18). After
any change to `app/engine/yft.js`: generate a file from real MODAQ games,
open it in YellowFruit, confirm no version/schema errors and that YF's
report matches the stats page.

The HTML stat report (`app/engine/report.js`) is a port of YellowFruit
4.0.18's `HTMLReports.ts` — same six filenames, page order, table columns,
CSS, anchor scheme, and the `StatSummaries.ts` formulas (win % counts ties
as half a win, PP20TUH, fractional games played, `N=` tie ranks). It covers
what qb-td models: one phase, no pools or finals, no small-school/JV/UG/D2
tracking, no lightning rounds, bouncebacks folded into bonus points. Its
tossup-value columns come from values actually scored (the same rule the
live stats page uses), where YellowFruit uses the tournament's configured
answer types. After changing it, regenerate from real games and diff
against a report YellowFruit produces from the same `.yft`.

## License

MIT (see `LICENSE`). The embedded MODAQ reader and the YellowFruit
file-format relationship are documented in `THIRD_PARTY_NOTICES.md`.
