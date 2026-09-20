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
  "what did I tell people?"); the **protests** drawer (every protest
  moderators logged in MODAQ, from the newest upload of each game — round,
  room, question and buzz word, the answer given, the reason, and the
  score an upheld ruling would produce, computed the way MODAQ's own
  protest-swing check does it, flagged when it can flip the result; the
  TD records a ruling and a note per row, for the hub only — nothing is
  sent to the room, and a ruling never edits a score: the moderator
  applies it in MODAQ and uploads again, which the row reports as the
  corrected game arriving; a count sits in the status strip and each
  upload row carries a marker); settings (public page, reader game
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
  TD's broadcasts for this room (alerts first, then newest first). It is
  the fallback path, not the main one — the reader page below is — but it
  is not redundant: it is the only way to hand a moderator a packet MODAQ
  cannot open (a PDF), and the only way to submit a `.qbj` produced
  elsewhere when a reader session is lost. It shares the reader's link
  secret, so a mod can always reach it by editing the URL.
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
  YellowFruit publishes, named the way YellowFruit saves them
  (`<slug>_standings.html`, `_individuals`, `_games`, `_teamdetail`,
  `_playerdetail`, `_rounds`) — unzip and upload the files to the
  hsquizbowl.org tournament database, which wants that prefix, or host
  the folder anywhere, no YellowFruit in the loop; and a zip of
  every game's separated files — the match `.qbj` (imports via YellowFruit's
  MODAQ game-file import) and the MODAQ game file — plus the roster. All
  are generated client-side in the dashboard. Combined reader uploads are
  never handed out raw: the dashboard's per-file downloads (Worker
  `part=qbj|game`) and the zip both split them into those two real files.
- **Question sets** (`app/set.html`, no account): the editor's side of a
  mirrored tournament. A set's packets, tiebreakers and reader game
  format are uploaded once; each mirror gets an **invite link** the
  editor can send weeks ahead, and the TD who opens it
  (`index.html?i=<invite>`) presses Start to get an ordinary tournament —
  the 48-hour clock starts then, not when the invite was made — with the
  packets, the backup questions and the format already in place (or
  pastes it into a tournament they already made). Which round reads
  which packet stays the TD's choice. The games every mirror collects
  come back as **set-wide stats, category stats and buzzpoints** that
  follow each question through packet fixes and repacketizing: in the
  editor's dashboard always, and on a **public set page**
  (`app/s.html?s=<slug>`) once the editor switches it on. See "Question
  sets" below.
- **Archive** (`app/archive.html`): a curated list of past tournaments, and
  with `?t=<slug>` any one of them. An archived tournament runs the real
  `pubview.js` against a committed capture of its `/pub` responses
  (`app/archive/<slug>.js`) instead of the Worker, so the schedule, stats,
  and categories tabs work with no server and no tournament of your own,
  and keep working if the backend ever goes away. Each entry also ships its
  six-page stat report as static HTML. Buzzpoints is switched off in a
  capture: that tab needs the gated packet-text route, which isn't
  archived. See "Archiving a tournament" below.

## Question sets

A set is mirrored for a season, so its editor link lives a **year**
(`SET_TTL`); everything a mirror does still runs on the 48-hour clocks.
That works because **an invite is not a tournament**: it is a one-time,
revocable credential that creates nothing until its TD uses it — either
to start a tournament (Start on the invite page) or to join one they
have already made (Tournament Setup → Packets → Join a set, which fills
the rounds still empty and leaves their own packets alone). Editors can
line mirrors up as early as they like, and the question-security story
of a running tournament (links dead 48 h after creation) is exactly what
it was. An invite can start the mirror and therefore read the packets,
so it should travel the way the packets themselves would; the set
dashboard shows which invites are still unused, and revokes them.

- **Packets, not rounds.** The set numbers its packets; which round a
  mirror reads a packet in is its TD's call (a mirror starts with packet
  N on round N, and the dashboard's Packets tab puts any packet on any
  round — skip one, reorder them, keep some for playoffs). Everything
  set-wide is keyed by the packet a game was read from, never by the
  round it was played in.
- **Packets are referenced, not copied.** A mirror's rounds point at the
  set's packet blobs. Every upload of a packet is a new immutable
  **version** and the one before it is retired, never deleted. So a fix
  uploaded mid-season reaches every *running* mirror that has not
  opened that packet yet, while a mirror that has stays pinned to the
  text its buzz positions belong to. "Opened" means the first room was
  handed the packet (`rounds.served`), not the first game coming back:
  once one moderator is reading a version the whole site stays on it,
  because two versions inside one site's round could never be told apart
  afterwards. A TD may still upload their own packet for a round; the
  set then stops updating that round there, and its games drop out of
  the set's category stats and buzzpoints (its scores still count).
  Removing a packet from the set takes it out of running mirrors that
  have not opened it.
- **Questions keep their identity through rewording and repacketizing.**
  Editors fix wording, move questions between packets, split and merge
  packets. Each packet version can carry a *question map* — per
  position, `[question id, wording revision]` — computed in the editor's
  browser at upload (`app/engine/qmatch.js`, against a ledger of every
  question the set has held; the ledger is question text, so it lives
  encrypted under the set's key and only the set link reads it) and
  stored, text-free, beside the categories in the set's public map. The
  editor is told what each upload did ("41 unchanged · 1 reworded (T1)",
  "1 moved in (T3 from packet 2 T5)", "1 no longer in the set"), and a
  version that was never matched — a packet the browser could not read —
  is labelled so and offered a Match button. On the buzzpoints tab this
  means: a packet's page lists its *current* questions, each with every
  play of it anywhere (whatever round, whatever packet it sat in then);
  plays on the current wording are drawn over the current text, plays on
  an earlier wording get their own block over the text those rooms
  actually heard ("2 wordings", "moved" badges say which); and questions
  that are in no current packet any more stay reachable under the
  version that last held them. Set-wide category stats read each site's
  version of each packet, so a question counts under the category it
  had where it was played.
- **A person checks every packet.** The set dashboard's Review panel
  (Packets → Versions → Review) lays a version out the way a reviewer
  reads it — answerline, length, how each tossup opens and ends, each
  bonus's parts with their answers and values — and flags what looks
  mis-parsed (`app/engine/packetcheck.js`: a two-part bonus, a stray
  `[10]`, "ANSWER:" inside a question, two tossups sharing an answerline,
  missing category data…). Warnings are hints, never verdicts; a packet
  chip stays red until someone marks the version **checked**. The same
  panel shows what the matcher decided each question is and lets the
  editor overrule it — "this is packet 2 T5" or "this is new" — and the
  buzzpoints follow the correction (`qmatch.js` `assignQuestion`).
- **Conversion statistics.** The categories tab has a tossups view (per
  category or subcategory: heard, power / conversion / dead rates, negs,
  bonus PPB), a bonuses view (PPB, the 0/10/20/30 split, and how each
  bonus's easiest, middle and hardest part converted — ranked by how the
  parts actually converted, since nothing in a packet says which was
  meant to be easy), players and teams. The buzzpoints tab adds an
  all-tossups table, hardest first, with each question's answer,
  category, and its numbers pooled over every site that heard it.
- **Mirrors in or out.** A row of site pills above every set-wide view
  toggles mirrors in and out; excluded ones are struck through there and
  marked in the sites table, and the count says how many are in.
- **Backup questions.** The set's tiebreaker / replacement pool is read
  *live* by every mirror's rooms (`mergedTbPool`) — questions the editors
  add mid-season reach mirrors already running — with the set's ids
  prefixed (`S-TU1`) so a TD's own additions can't collide, and the usage
  log stays the mirror's own. A set's pool is emptied, never deleted, so
  its id counter survives.
- **Encryption, one level up.** A set has its own content key, wrapped
  under the editor's link, each invite, and the set's buzzpoints key. A
  mirror carries that key encrypted under its *own* content key, so every
  credential that opens the mirror (admin link, room links, its
  buzzpoints password) opens the set's packets through it, and nothing
  else does. The honest cost: a mirror's question text is no longer
  cryptographically gone when the mirror's links expire — it goes when
  the set's link does. And the mirror hands its own key to the set the
  same way (`set_mirrors.mirror_key_enc`): its editors can download the
  mirror's stored game files, MODAQ game files included, from the set
  dashboard — the invite page and the mirror's dashboard both say so.
- **Reading the games back needs no keys.** A mirror's public game copies
  and round shards are text-free, so the set routes simply serve the
  mirrors' shards. A mirror is materialized by the cron whether or not
  its own page is public, because its set's editors read those shards.
- **Who sees what.** The editor's link reads everything, always. The
  public set page exists while the *set's* publish switch is on, and then
  shows every mirror not hidden from stats — including mirrors whose TD
  left their own page off. A mirror TD's publish switch governs only
  that mirror's own page (schedule, broadcasts). Set-wide buzzpoint
  **text** is password-gated exactly like a tournament's, and served for
  a packet version once any one mirror has every room in for a round
  that read it. Whoever holds that password can read those questions
  while later mirrors are still to play: when to hand it out is the
  editor's call, and the dashboard says so. The same editors can switch
  their **mirrors' own buzzpoints off** (Settings → "Mirrors may run
  their own buzzpoints"): while unticked no mirror of the set shows any
  question text, whatever its TD configured, and the TD's dashboard says
  why. The editor's own Stats tab needs no password — the set link
  already is the key.
- **Set-wide stats are per site, side by side.** Team names mean
  something only inside their own mirror ("Team A" plays at three
  sites), and so does the re-upload rule. So the engine runs once per
  site (`app/engine/setstats.js`) and the rows are tagged with their
  site; across sites, teams and players are ranked by PP20TUH rather than
  by records earned against different fields. The categories tab adds
  the editors' view — per category or subcategory, tossups heard,
  power / conversion / dead rates, negs, and bonus PPB over every site.
- **Request economics.** The set page costs one Worker request per view:
  `/pubset/:slug` is one D1 row plus one small R2 blob
  (`s/<sid>/state.json`) that the cron keeps — which mirrors, their
  shard stamps and snapshot SHAs, which packet version each round read,
  which rounds each has finished. A tick rebuilds it only for the mirrors
  it actually touched and carries the rest forward, so a busy Saturday
  costs D1 reads in proportion to the mirrors that moved. The games
  themselves come SHA-pinned from the mirrors' own GitHub snapshot
  folders, with one Worker request per mirror as the fallback. A
  mirror's round shards are published when *either* flag says public —
  its own, or its set's (unless the editor hid it); its schedule, roster
  and category map only when its *own* page is on, so a TD who never
  published does not find those in a public repo whose history is
  forever. Nothing polls.
- **Hiding a mirror** (a test run, a junk start) takes it out of the
  set-wide views; nothing the editor can do reaches into a mirror's
  tournament, which belongs to its TD.
- **Abuse backstops.** Set creation is open and rate-limited like
  tournament creation (tighter: 5 per IP per day). Mirrors started from
  invites draw on their own daily budget rather than the open-creation
  one, so an editor's invites can neither lock TDs out of creating
  tournaments nor be a way around that limit. An invite is claimed
  before anything is created — two clicks can't make two tournaments —
  and a claim whose tournament never materialized lapses after five
  minutes instead of stranding the invite.

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
- **Set links live a year; invites live until started, revoked, or the
  set closes.** See "Question sets" above — a mirror started from an
  invite is an ordinary tournament on the clocks in this section.
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
  match qbj's `notes` field verbatim. The Worker strips `notes` when it
  writes a game's public copy — the only copy the round shards, the
  per-game qbj downloads, the GitHub snapshot repo and archive captures
  are ever built from — so none of them carry it; the TO's admin downloads keep it
  for the `.yft`. The structured protest list the reader sends with each
  upload (`files.summary`, with the teams and score) and the TD's rulings
  (`tournaments.rulings`) ride on the admin route only. Rooms likewise receive only the reader game format
  from `settings` — never the buzzpoints config, whose stored hash would
  otherwise invite an offline attack on the TO's password.
- The bucket and admin pages carry `noindex` + `no-referrer` so a link
  that leaks into a crawler or an outbound click doesn't spread.
- **Request economics** (Cloudflare free tier): the public page reads
  one materialized blob per round (`t/<tid>/round/<n>.json`, rebuilt by
  the cron, TO-rebuildable) instead of fetching every game file, and
  **nothing anywhere polls on a timer.** Every page fetches on load, on
  an explicit refresh, and (for the two moderator pages) when the tab
  regains focus — so cost is per *view*, never per open-tab-minute, and an
  idle tab costs exactly nothing. That is what makes many simultaneous
  tournaments affordable: 240 live rooms on a 60 s poll would have spent
  the entire daily budget on polling alone. Broadcasts add no requests of
  their own: they live in a column on the tournament row and ride out on
  those state responses plus every moderator upload response, so a mod
  sees one when they next touch the page and a viewer on their next
  refresh. The public page has no focus refresh on purpose — viewers are
  readers, and are expected to refresh; a moderator must not miss the TD
  advancing the round.
  Stats data changes only when a file lands; `/pub/:slug` carries a
  stamp per round and clients refetch only the rounds that moved — a
  round that has finished never moves again, so a viewer arriving late
  in a long day pays for the round in progress, not for the tournament.
  Request *count* stays flat as rounds multiply: whatever the snapshot
  can't answer is fetched from the Worker in a single
  `/pub/:slug/rounds?n=…` (the shards streamed back to back), so a first
  load is two requests and a refresh is two, whether the tournament has
  three rounds or seventeen. Each round in that request carries the
  stamp the page expects (`n=5@<stamp>`, ignored by the Worker) so the
  URL — and with it the browser's cache key — changes whenever the
  round does; the response is `max-age=60` like every public blob, and
  without the stamp a second refresh inside that minute would be served
  the pre-move shard. The schedule is one R2 blob
  (`t/<tid>/schedule.json`) with its own stamp in `/pub/:slug` (R2
  head), refetched only when it moves and served with `max-age=60`;
  the reader fetches it once per load. The reader page costs a state +
  schedule + tiebreakers + roster + packet fetch when a room link opens
  and one upload per export click — about six Worker requests per game —
  and the 2 MB MODAQ bundle is a static asset on GitHub Pages, off
  Cloudflare entirely.
- **Finished tournaments stop costing anything.** Rooms can only be
  created while the admin link lives (48 h), and each room accepts
  uploads for 48 h after its own creation, so nothing can change after
  `created + 96 h` (`FINAL_TTL` in `worker.js`) — the data is provably
  frozen, with no extra column or cron to say so. Past that point
  `/pub/:slug` reports `final: true` and every public blob is served with
  a week's `max-age` instead of a minute's, so a repeat visitor's blobs
  come from their own browser cache. With nothing polling on the public
  page, a tab left open on last season's tournament is already silent;
  this makes returning to it nearly free as well. Caching *inside* the
  Worker would not help — a `workers.dev` request invokes the Worker
  whether or not the response is cached (verified: no `cf-cache-status`
  on any response), so the saving has to come from the browser not
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
  zip), `cats.js` (category slices), `setstats.js` (the same engine run
  per mirror and put side by side, for a question set, and its
  buzzpoints gathered per question), `qmatch.js` (question identity
  across a set's packet versions).
- `app/` — the static pages + `js/` page code (`announce.js` renders
  the TD's broadcasts on all three read surfaces; `buzzview.js`,
  `statsview.js`, `packetsui.js` and `formatui.js` are the pieces the
  tournament pages share with the set pages — `set.html` + `setadmin.js`
  for editors, `s.html` + `setpub.js` for the public, both over
  `setview.js`). Deployable on any
  static host; served at `qbsuite.github.io/qb-td/app/`. `archive.html` +
  `archive/` are the archive page and its committed captures. The reader page
  is `read.html` + `js/read.bundle.js`, a committed esbuild bundle of
  MODAQ (rebuild with `npm run build:read` — `tools/build_read.mjs`,
  which also swaps MODAQ's stock Add Questions dialog for the tiebreaker
  selector `js/tb_add_dialog.js`, bridged to the page by
  `js/tb_bridge.js` — after editing `js/read_main.js` /
  `js/read_core.js` / `js/tb_add_dialog.js` or bumping the `modaq` dep;
  `read_core.js` holds the pure, unit-tested helpers; `js/protests.js`,
  shared with the hub, turns MODAQ's game state into the protest list
  the upload carries and builds the hub's Protests drawer from it).
- `worker/` — Cloudflare Worker (D1 metadata + R2 blobs). Auth model:
  admin link secret for the TO API (48h lifetime), bucket secret for
  moderator routes, publish flag gating all public reads. No secrets to
  provision.
- `tests/` — `run_tests.js` (engine unit tests), `e2e_worker.js` (full
  TO -> moderator -> public flow against `wrangler dev`), `e2e_sets.js`
  (editor -> invite -> mirror -> set-wide reads, same dev Worker;
  `e2e_lib.js` is what the two share), `snapshot_publish.js` (the cron
  tick, mocked).
- `tools/archive.mjs` — the archive's approval CLI (see below). The only
  code here that reads the live backend outside a browser.
- `tools/yf_parity.mjs` + `tools/yf_parity/` — `npm run yf-parity`: the
  `.yft` export checked against YellowFruit's own import and save code
  (see "YellowFruit fidelity").
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
node tests/snapshot_publish.js   # cron tick: round shards + GitHub publisher (D1/R2/GitHub mocked)

cd worker
npx wrangler d1 execute qb-td --local --file schema.sql
# an existing local DB from before at-rest encryption needs, once:
#   npx wrangler d1 execute qb-td --local --file migrate-crypt.sql
# ...and one from before protests reached the hub:
#   npx wrangler d1 execute qb-td --local --file migrate-protests.sql
# ...and one from before question sets (re-run schema.sql first: it
# creates the three set tables):
#   npx wrangler d1 execute qb-td --local --file migrate-sets.sql
# --test-scheduled is required: the cron builds the round shards the
# public routes serve, and the tests trigger it via /__scheduled
npx wrangler dev --local --port 8799 --test-scheduled &
cd .. && node tests/e2e_worker.js && node tests/e2e_sets.js

# optional, and slow: a full-size tournament end to end (72 teams, 36
# rooms, 17 rounds by default; TEAMS/ROOMS/ROUNDS/CONC override) against
# the same dev Worker, reporting upload latency, tick cost, and what a
# viewer downloads per refresh
node tests/stress_worker.js
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
   and one from before the cron's derived-data queue needs
   `npx wrangler d1 execute qb-td --remote --file migrate-pub.sql`,
   and one from before protests reached the hub needs
   `npx wrangler d1 execute qb-td --remote --file migrate-protests.sql`,
   and one from before question sets needs `schema.sql` run again (it
   creates the set tables) and then
   `npx wrangler d1 execute qb-td --remote --file migrate-sets.sql`
   BEFORE the Worker that expects it is deployed — the cron's queue query
   names `set_id`,
   each once — `schema.sql` is re-runnable and can't add a column.
   Apply `migrate-crypt.sql` BEFORE deploying a Worker that expects it;
   tournaments created before the migration stay on the legacy
   plaintext paths and age out within 48 h. `migrate-pub.sql` is
   required whether or not you enable snapshots: its `pub_dirty` column
   is the queue the cron rebuilds round shards from)
   (upgrading a database that predates the round shards: queue every
   published tournament for one rebuild with
   `npx wrangler d1 execute qb-td --remote --command "UPDATE tournaments
   SET pub_dirty = 1 WHERE published = 1"`, then let the cron drain it.
   Skipping this is not fatal — `pubState` flags a tournament that has
   games but no shards the first time anyone views it — but the bulk
   flag converges everything in a few ticks instead of on demand)
5. `npx wrangler deploy`
6. Host `app/` anywhere static; set `ALLOWED_ORIGIN` in `wrangler.toml` to
   that origin. Point the pages at your Worker with `?server=...` or by
   editing the default in `app/js/api.js`.

## Public snapshots on GitHub (optional)

Makes public stat viewing free at any audience size. Without it, every
viewer's blob fetches (the round shards, schedule, category map, roster)
hit the Worker, so a popular event spends the same 100k-requests/day
budget the moderator rooms and TO dashboard run on.
With it, the Worker publishes those blobs to a GitHub data repo in one
atomic commit per change (at most one per minute per tournament), and
`/pub/:slug` advertises the commit SHA. The page then fetches
`raw.githubusercontent.com/<repo>/<sha>/…` — SHA-pinned raw URLs are
immutable, so there is no CDN staleness to reason about, and they never
touch the Worker.

The small state stays on the Worker deliberately. It is one response per
page view — the page never polls — so it costs almost nothing, and going
direct means it is never stale: a refresh shows results as soon as the
cron has committed them. Publishing it to a branch-head raw URL instead
would add GitHub's `max-age=300` to every update and save almost nothing.
`pubview.js` requests it with `cache: 'no-cache'`, so the refresh button
can't be silently answered from the browser's own copy — with no poll,
that button is the only way a viewer gets newer data and it has to work
every time. Buzzpoints stay on the Worker too: packet text is
password-gated per request, which a static host can't do.

Every blob fetch falls back to the `/pub` routes, so a failed publish, a
pruned repo, or turning the feature off just means Worker serving —
exactly the behavior without this section. Unpublishing a tournament
makes the next cron tick delete its folder from the branch head; nothing
points at it once `/pub/:slug` stops advertising the SHA, so that is
tidiness rather than correctness. Archive captures ignore snapshots
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
3. Set `SNAPSHOT_REPO = "owner/repo"` in `wrangler.toml`, `npx wrangler
   deploy`. Setting `SNAPSHOT_REPO` back to `""` turns the GitHub half
   off again; the cron keeps running either way, because it also
   materializes the round shards the public page reads.
   (`migrate-pub.sql` is part of the base deploy, not this section.)

Freshness: a refresh shows everything the cron has committed, so a
viewer is at most one tick (~a minute) behind the moderators. Nothing
pushes — an open tab does not update itself, by design — so what a viewer
sees is always "as of when they last asked".

The data repo's history grows one small commit per change; old slugs
can be deleted from the branch freely (archived pages don't read it, and
SHA-pinned fetches of *recorded* snapshots still resolve through
history).

## Known scaling limits (none of this bites yet)

Sized against a deliberately hard case: **30 simultaneous tournaments,
16 teams each, full round robin** — 15 rounds x 8 rooms = 120 games per
tournament, 3,600 games, 240 live rooms, over an ~8 hour day. At the
handful of concurrent tournaments this actually runs today, every item
below is inert. They are written down because the request budget is *not*
the first thing that breaks, which is counterintuitive.

Fixed Worker load at that scale is about 32k requests/day (reader pages
~21.6k at ~6 per game, TO dashboards ~9k, cron 1.4k), leaving ~68k of
the 100k/day free tier for public viewers at one request per page view.
That part scales. What breaks first:

1. **D1 rows read binds at roughly half the request budget.** Every
   `/pub/:slug` re-derives the state from scratch, including a query that
   returns **one row per game** (`pubStateBody`'s `files` query) — 120 rows by the end
   of a 16-team RR, plus buckets and rounds, ~145 rows per public page
   view. Against D1's 5M-rows/day free tier that caps public views at
   ~34k/day (~1,100 per tournament), well before the request budget runs
   out. Note this is a *read*-side cost: writes are already incremental
   (a game's public copy is one blob written by its upload, the cron
   rebuilds only the round that moved, and the publisher only commits
   blobs whose stamps moved), so "we only append on change" is true and
   does not help here.

   The fix that fits the existing design is to **materialize the
   `/pub/:slug` body into a small R2 blob** in the cron tick — the same
   pattern the round shards already use — making the route O(1) instead
   of O(games). Its stamps would then come from the same rebuild that
   writes the shards, so there is nothing new to invalidate. `markPub` already fires on every mutation that can change
   the state, so no new invalidation plumbing is needed and no staleness
   is introduced. (A short Worker Cache API TTL is less work but
   reintroduces exactly the staleness the no-poll design removed.)
   Measure before committing to it: it trades D1 rows for an R2 read.

2. **The cron cannot keep up, and starves the losers.** The tick takes
   `ORDER BY created DESC LIMIT 4`. With ~30 tournaments finishing rounds
   around the same time the dirty queue is 30 deep and drains at 4/minute,
   so the last tournament waits ~7-8 minutes — and because the ordering is
   newest-first, it is systematically the *oldest* tournaments that wait,
   every round. This binds harder than it used to: the tick is what
   materializes the round shards, so a tournament at the back of the
   queue has games that are uploaded, safe, and simply not public yet.
   The public page says so (`pendingNote` in `pubview.js` counts games
   the state knows about that the shards don't hold), which turns the
   symptom from silence into a number, but the fix is the queue:
   **order by how long a tournament has been dirty, not by age**, and
   raise the limit (question sets add to this queue: a set's mirror is
   materialized whether or not its own page is public, so an unpublished
   mirror now takes a slot that only published tournaments used to; a
   set's own state blob is already the materialized pattern item 1 asks
   for, rebuilt per touched mirror) — materializing is R2-bounded and cheap, so the two
   halves of the tick want different limits.

   Raising the *publish* limit is bounded by **memory, not GitHub**
   (GitHub is ~5+N calls/tick against a 5,000/hour App limit).
   `buildPublish` holds the batch's blobs in memory at once and base64
   for the blob API inflates ~1.33x. Per-round shards made this much
   smaller — a round of a 16-team RR is ~100KB where the whole
   tournament's bundle was ~1.6MB — but the shape of the risk is the
   same, so: **cap the batch by total bytes rather than count** (there is
   already a per-blob cap, `PUB_MAX_SNAPSHOT`).

3. ~~**No fetch has a timeout anywhere.**~~ Fixed: the page's snapshot
   fetches (`pubview.js` `fetchSnap`, 8s) and the cron's GitHub API
   calls (`worker.js` `github()`, 15s) carry `AbortSignal.timeout`, so a
   *slow* GitHub now takes the same fallback path a *down* one always
   did — the viewer falls to the Worker route, the tick fails and
   re-flags the tournament for the next minute. The tick's total time is
   what matters: a tick that outlives its minute overlaps the next one,
   which is the only way the shards could ever have two writers.

4. **Small waste in the hot path.** `pubStateBody` does full
   `env.DATA.get()` on the schedule and catmap (the third and fifth
   entries of its `Promise.all`) when usually only their timestamps are wanted; the
   catmap also gets parsed to test non-emptiness, which wants a cheap
   stored marker instead. Also `pubStateBody` now has exactly one caller
   and could fold into `pubState` (cosmetic).

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

# delete rows (all four tables key off the tournament; a set's mirror
# also has a set_mirrors row — DELETE FROM set_mirrors WHERE
# tournament_id=<id> — and its packets are the SET's blobs under s/, which
# stay). A whole set: its sets / set_packets / set_mirrors rows and every
# blob under s/<sid>/ (packet versions, tiebreakers, catmap, ledger,
# state). Then each blob —
# everything lives under the t/<id>/ prefix: the uploads from the query
# above, packet keys from the rounds table, the public game copies
# (pub/<file id>.json) and their round shards (round/<n>.json,
# rounds.json), and schedule.json / catmap.json / roster.qbj /
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
receives text-free public data (round shards, schedule, category map,
roster), so normally this is fine — but a roster carries player names,
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

The generated `.yft` is the file YellowFruit 4.0.18 itself saves after a TD
imports the same roster `.qbj` and game `.qbj`s into a custom one-stage
schedule: one stage, one pool holding every team (YF builds standings pool
by pool — a file with no pool opens to an empty standings page), lettered
teams (`Penn A`, `Penn B`) under their school's registration, YF's id
schemes, the standard rule set when the scored values fit one. Overtime is
the one place it does better than YF's own importer: the reader's files
fold overtime into `tossups_read`, which YF rejects as an over-long
regulation and drops from the stats, so the `.yft` splits the overtime
tossups out and lists each team's overtime buzzes, as a TD would have to
by hand.

`npm run yf-parity` (`tools/yf_parity.mjs`) checks all of that against
YellowFruit's own code rather than against a reading of it. It clones YF
at the pinned tag into `.cache/` (nothing of YF's, AGPL-3.0, enters this
repo), runs its data model headless to import each scenario's files and
save a `.yft`, builds qb-td's from the same files, and fails unless the
two are the same tournament once YF has opened and re-saved each — in
practice they are byte-identical before that too — with no game YF flags
as an error and the same six report pages rendered from both. Scenarios
(`tools/yf_parity/scenarios.mjs`): the demo tournament, and a college-style
event with A/B teams, powers, a substitution, a rostered player who never
plays, punctuation and accents in names, and an overtime game. Run it
after any change to `app/engine/yft.js` or `parseMatch`; it needs git and
network the first time. The unit suite pins the same facts without it.

The HTML stat report (`app/engine/report.js`) writes the six pages
YellowFruit 4.0.18 saves for the same tournament, byte for byte — the
report is read by programs as well as people (the hsquizbowl.org database
parses what is uploaded to it), so the markup is YF's and not a tidier
equivalent: attributes unquoted SQBS-style (`<a HREF=...>`, `<table
border=0 width=100%>`), a line break inside each generic tag, no doctype
or charset, the top anchor written `id=#top`, YF's stylesheet, box scores
anchored by the game's match id from the `.yft`, YF's generator line.
Filenames are bare for the in-page view, as in YF's own preview, and
`<prefix>_` on files and links alike for the download, as in YF's
save-to-disk. The numbers are YF's too, quirks included: win % counts a
tie as half a win, `N=` tie ranks, fractional games played; a team's
PP20TUH and TUH are regulation-only and an overtime get is not a bonus
heard, while the round report divides every point by regulation tossups
and does count overtime gets as bonuses heard. The tossup-value columns
are the `.yft`'s answer types. It covers what qb-td models: one stage, no
finals, no small-school/JV/UG/D2 tracking, no lightning rounds,
bouncebacks folded into bonus points; names are escaped only where they
would otherwise be read as markup. `npm run yf-parity` compares all six
pages with YF's own for every scenario — run it after any change here.

## License

MIT (see `LICENSE`). The embedded MODAQ reader and the YellowFruit
file-format relationship are documented in `THIRD_PARTY_NOTICES.md`.
