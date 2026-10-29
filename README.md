# qb-td

Tournament hub for quizbowl TDs: collect MODAQ game files from every room,
distribute packets, track the live round, generate and publish the
schedule, publish live stats, and export a YellowFruit `.yft` without
touching YellowFruit mid-tournament.

Part of [qbsuite](https://qbsuite.github.io/).

## How it works

- **TO dashboard** (`app/index.html`, no account): creating a tournament
  mints an unguessable admin link — the only credential, shown once with a
  save-this-link warning, remembered in that device's localStorage. It
  works for a **week of setup** from creation; when the TD presses
  **Start tournament** (the last item of the setup checklist, or the
  "Not started" banner on the Live Hub, behind a confirmation), it and
  every room link work for **72 hours from then** — replacing whatever
  the week had left, earlier or later — and until then room links show
  "Tournament hasn't started" and serve nothing. (Setup's Rooms step has
  a **Test** link per room for the TD: the room link plus a test token,
  which reads the room before Start so a game can be tried with the real
  packets, roster and settings. It is read-only — a test game uploads
  nothing and starts no round — and marked as a test throughout. The
  token is a hash of the admin secret's stored hash, so a forwarded Test
  link is no admin link, and a new admin link retires it.)
  Two views. **Tournament
  Setup** is the before-the-day work, a tab per step with a done-state
  pill each (MODAQ Settings is done once a format is saved, Stats
  settings once the public page is on — it also holds the buzzpoints
  switch and password):
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
  regrouping by finish position, or into playoff brackets of two
  places from each pool (22 teams: 6/6/6/4) with pool-mates' prelim
  games carried over — clean-room circle-method pairings,
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
  advance next to the free set-any-round control, and under it the
  **Open the next round automatically** switch (off by default, one
  switch for the whole tournament): the Worker opens the next round once
  every room with a game in the current one has started it — a room has
  started a round when its reader presses Start on it, or its uploads
  page downloads that round's packet — with a chip per room showing who
  has; it never opens a round with no packet, and never pushes on a
  round the TD set back by hand; the **protests** drawer (every protest
  moderators logged in MODAQ — shown as soon as it's lodged, marked "Game
  in progress" until the game is uploaded, then from the newest upload of
  each game — round,
  room, question and buzz word, the answer given, the reason, and the
  score an upheld ruling would produce, computed the way MODAQ's own
  protest-swing check does it, flagged when it can flip the result; the
  TD records a ruling and a note per row, for the hub only — nothing is
  sent to the room, and a ruling never edits a score: the moderator
  applies it in MODAQ and uploads again, which the row reports as the
  corrected game arriving; a count sits in the status strip and each
  upload row carries a marker); settings (reader game
  format — a MODAQ preset plus every field of MODAQ's own customize
  dialog, stored as overrides so it applies to every room — and
  admin-link rotation for leaks); stats + export; and uploads grouped by round with a completeness pill per
  group (current round open by default) — each upload's room is a
  dropdown, so a game sent from the wrong room's link can be moved to
  the room it was actually played in.
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
- **No room upload page.** A room has one page, the reader below, and the
  only thing a moderator sends is MODAQ's "Upload to qb-td". A game that
  exists only as files (a lost reader session, a game scored elsewhere)
  goes to the TD, who puts it in with **Add a game** on the Live hub's
  Uploads. There used to be a second per-room page for uploading files by
  hand; a moderator took it for where packets go and uploaded those, so it
  was removed. `app/bucket.html` is kept only to send old links to the
  reader.
- **Moderator reader page** (`app/read.html?b=<secret>`, same link secret):
  an embedded [MODAQ](https://github.com/alopezlago/MODAQ) preloaded with
  a round's packet (the live round by default; played rounds stay
  selectable for a room running behind), the tournament roster, and the
  TO's game format — the mod picks the round and two teams and reads.
  With a schedule whose room is linked to this bucket, the round's
  scheduled matchup is locked in as the matchup rather than two
  pickers: changing it takes "Change teams", and starting with other
  teams asks first ("WARNING: The schedule indicates that "A" vs "B" are
  playing in the room Room 3. Are you sure you want to switch?"). Under
  the matchup the mod ticks each team's **starters** — every player
  listed, the roster's first four ticked, any number at least one — and
  MODAQ starts the game with them. The room's schedule line shows above
  the round list; a tiebreaker pool
  shows beside it with each question's heard-by state, and during a game
  the pool lives in MODAQ's Actions → Add questions dialog (qb-td's own
  selector, swapped in at bundle time — the stock file picker stays as
  its fallback). "Upload to qb-td" in MODAQ's
  menu sends one `.qbtd.json` per game into the bucket — the match qbj plus
  the full game state in a single file, plus which tiebreaker questions
  the game read and where added or replaced questions sit, so Edit in
  MODAQ numbers a correction as the game was; no file downloads or uploads. The
  dashboard and public routes split the qbj back out wherever a bare `.qbj`
  is needed (stats, the zip export, public downloads) — the game half,
  which contains the packet text, never leaves the TO side. Starting a game mints a per-game URL
  (`&g=<id>`) with its own localStorage, so each game resumes only from
  its own link (offline, zero requests), the room link always starts
  fresh against the live round, and packet re-uploads or round changes
  can never disturb a game in progress; the room link lists this
  device's in-progress games. The page never polls. Any number of moderators can share one
  link (game state is per-device), and stats + the `.yft` count only
  the latest upload per round + team pair — a re-export corrects a
  game instead of double-counting it. `.json` packets load directly; `.docx`
  packets are parsed in the mod's browser by the public YAPP service
  (the same one MODAQ's demo uses — docx question text transits
  quizbowlreader.com).
- **Public tournament page** (`app/t.html?t=<slug>`; `stats.html`
  redirects): schedule + stats + buzzpoints tabs. The schedule tab
  renders the grid with played games' scores filled in from the
  collected qbj files (exact team-name match) and a per-team view
  behind a dropdown; the stats tab has standings, individual
  leaderboard, and round-by-round scores, all computed in the browser.
  The categories tab (appears when any JSON packet carries qbreader
  category metadata) has four views, filtered by category chips with a
  subcategory row under the picked one: **Players** and **Teams** (buzz
  results per slice, with a **BB** count: bouncebacks, tossups won after
  the other team missed — any wrong buzz, no-penalty ones included; a
  count beside the others, never points, so a bounceback power is still
  a power), **By Player** (one player's per-category breakdown), and
  **Questions** (how each category played: tossups heard, conversion,
  power and neg rates and average buzz word; bonuses heard, PPB, and
  Easy / Medium / Hard part conversion — from the packet's own e/m/h
  marks, MODAQ's `difficultyModifiers`, and where a packet has none, from
  ranking each bonus's parts by how often they converted, which the tab
  says). It reads a text-free category map the Worker extracts from
  packets at upload (`/pub/:slug/cats` — categories and difficulty
  marks, no question text, so it's public without the buzzpoints gate;
  docx packets carry no categories).
  The buzzpoints tab (TO-enabled, always password-gated — off or on,
  never open) goes **By Round**, **By Category** or **Summary**. By Round
  lists a round's questions in packet order as collapsed answerlines
  (first answerline only, keeping the packet's bold/underline on the
  required part) — a tossup expands to its text with every room's
  buzzed words underlined (MODAQ's `buzz_position.word_index` rides in
  every qbj), the bonus read with it (set in under it) expands to each
  part's text and answerline, its conversion, and each room's line. By
  Category lists every finished round's tossups and bonuses in one
  category or subcategory, labelled by round, each expanding the same
  way. Summary is per player (15/10/neg counts, average and earliest
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
- **Exports**: a native `.yft` for each YellowFruit generation — one for
  YellowFruit 4 (opens in >= 4.0.18) and one for the older YellowFruit 3
  app, whose format is unrelated and which does nothing at all, not even
  an error, when handed a YellowFruit 4 file; the
  **HTML stat report** as a zip of the same six interlinked pages
  YellowFruit publishes, named the way YellowFruit saves them
  (`<slug>_standings.html`, `_individuals`, `_games`, `_teamdetail`,
  `_playerdetail`, `_rounds`) — unzip and upload the files to the
  hsquizbowl.org tournament database, which wants that prefix, or host
  the folder anywhere, no YellowFruit in the loop; and a zip of the
  games the standings count, each as its separated files — the match
  `.qbj` (imports via YellowFruit's MODAQ game-file import) and the MODAQ
  game file — plus the roster. All
  are generated client-side in the dashboard. Combined reader uploads are
  never handed out raw: the dashboard's per-file downloads (Worker
  `part=qbj|game`) and the zip both split them into those two real files.
  Likewise the roster: Setup's Download (`part=roster`) and the zip leave
  out the former names qb-td keeps to follow renames. Where they are
  built: the hub reads the games once (`app/js/hubgames.js`
  `collectMatches`, the requests and their order as before), and the
  same file makes each tournament file from them (`yftFile` for both
  YellowFruits, `reportZipFile` and `reportPages`, `qbjZipFile`,
  `rosterFileText`); they share one module so the hub's cold load asks
  for no more files than it must. One game file or the roster as the
  Worker serves it is `app/engine/exportfile.js`, which the Worker and
  the hub's per-file links share; the Worker imports only that file, so
  the zip, YellowFruit, report and stats code stay out of its bundle
  (`npm run check:bundles`). The QBJ bundle (`qbjZipFile`) holds the
  same games as the stats, the .yft and the report, and the same upload
  of each: `stats.js` `dedupeMatches` over the stages and rounds picked,
  which keeps the newest upload per round and pair of teams under the
  roster's renames. A game re-read with its teams the other way round,
  or fixed by hand later, is in it once. A reader upload saved without
  its game half gives its `.qbj` alone, as its own download does. Game
  files added by hand (Add a game) go in under the roster's renames,
  indented as MODAQ writes them; under a name the zip already holds, the
  reader's file is kept.
- **Question sets** (`app/set.html`, no account): the editor's side of a
  mirrored tournament. A set's packets, tiebreakers and reader game
  format are uploaded once; each mirror gets an **invite link** the
  editor can send weeks ahead, and the TD who opens it
  (`index.html?i=<invite>`) creates an ordinary tournament — a week of
  setup, and 72 hours from its own Start on the day — with the
  packets, the backup questions and the format already in place (or
  pastes it into a tournament they already made). Which round reads
  which packet stays the TD's choice. The games every mirror collects
  come back as **set-wide stats, category stats and buzzpoints** that
  follow each question through packet fixes and repacketizing: in the
  editor's dashboard always, and on a **public set page**
  (`app/s.html?s=<slug>`) once the editor switches it on. See "Question
  sets" below.
- **Archive** (`app/archive.html?t=<slug>`): any one past tournament. The
  list is the home page's rail, where a set's sites (`--set`) share one
  entry. An archived tournament runs the real
  `pubview.js` against a committed capture of its `/pub` responses
  (`app/archive/<slug>.js`) instead of the Worker, so the schedule, stats,
  and categories tabs work with no server and no tournament of your own,
  and keep working if the backend ever goes away. Each entry also ships its
  six-page stat report as static HTML. Buzzpoints is switched off in a
  capture: that tab needs the gated packet-text route, which isn't
  archived. See "Archiving a tournament" below.

## Question sets

A set is mirrored for a season, so its editor link lives a **year**
(`SET_TTL`); everything a mirror does still runs on a tournament's clocks.
That works because **an invite is not a tournament**: it is a one-time,
revocable credential that creates nothing until its TD uses it — either
to start a tournament (Start on the invite page) or to join one they
have already made (Tournament Setup → Packets → Join a set, which fills
the rounds still empty and leaves their own packets alone). Editors can
line mirrors up as early as they like, and the question-security story
of a running tournament (room links serve nothing before Start, and
every link is dead 72 h after it) is exactly what it was. An invite can start the mirror and therefore read the packets,
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
  that mirror's own page (schedule). Set-wide buzzpoint
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
  costs D1 rows and R2 reads in proportion to the mirrors that moved,
  in the same few D1 queries however many moved. The games
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
- **Links die 72 hours after Start** (`closesAt` in `worker.js`), or a
  week after creation if the tournament is never started. The admin link
  then answers 410 "tournament closed" and every room link "room closed":
  rooms share the tournament's deadline instead of keeping their own. A
  lost or leaked link can't be phished or abused after the event;
  published stats stay up, and the public qbj + roster remain importable
  into YellowFruit, so results outlive the link. A leak mid-tournament is
  handled by the dashboard's "new admin link" button.
- **Room links serve nothing before Start** (403 "Tournament hasn't
  started"): no packet, tiebreaker, roster, schedule or upload, whatever
  the setup week has left — so a week of setup can't leak round 1 early.
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
  upload (`files.summary`, with the teams and score), the list it sends
  whenever a game's protests change before upload (`live_protests`), and the TD's rulings
  (`tournaments.rulings`) ride on the admin route only. Rooms likewise receive only the reader game format
  from `settings` — never the buzzpoints config, whose stored hash would
  otherwise invite an offline attack on the TO's password.
- The bucket and admin pages carry `noindex` + `no-referrer` so a link
  that leaks into a crawler or an outbound click doesn't spread.
- **Request economics** (Cloudflare free tier): the public page reads
  one materialized blob per round (`t/<tid>/round/<n>.json`, rebuilt by
  the cron, TO-rebuildable) instead of fetching every game file, and
  **no public or room page polls on a timer.** Those fetch on load, on
  an explicit refresh, and (for the two moderator pages) when the tab
  regains focus — so cost is per *view*, never per open-tab-minute, and an
  idle tab costs exactly nothing. That is what makes many simultaneous
  tournaments affordable: 240 live rooms on a 60 s poll would have spent
  the entire daily budget on polling alone. The one timer is the TD's
  Live Hub, one tab per tournament, and it is built to cost almost
  nothing when idle: each check sends the `rev` it holds
  (`GET /a/:secret?rev=`) and the Worker answers `{unchanged}` from the
  admin lookup alone when nothing has moved — `tournaments.rev` is bumped
  by triggers on every table the detail reads (`migrate-rev.sql`) — and
  the checks slow from 30 s to 120 s while nothing does. Auto-advance
  never depends on it; the Worker opens rounds on the rooms' packet
  fetches. The cron's once-a-minute "anything to rebuild?" queries read
  partial indexes of only the dirty rows, so an idle tick costs the same
  with 10 tournaments on file or 10,000. `tests/sim_usage.js` measures a
  whole simulated day in D1 rows. The public page has no focus refresh on purpose — viewers are
  readers, and are expected to refresh; a moderator must not miss the TD
  advancing the round.
  Stats data changes only when a file lands; `/pub/:slug` carries a
  stamp per round and clients refetch only the rounds that moved — a
  round that has finished never moves again, so a viewer arriving late
  in a long day pays for the round in progress, not for the tournament.
  (The exception is a fix in place — the TD's Rebuild, a room move or
  rename — which rewrites games under their old ids: the forced rebuild
  that follows gives each round it changed a new stamp, newest id and
  count plus the rebuild's generation, so the snapshot and viewers'
  caches pick it up.)
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
- **Finished tournaments stop costing anything.** Every write path — the
  admin link and every room — closes at the same moment (72 h after
  Start, or a week after creation without one), so nothing can change
  after it (`closesAt` in `worker.js`) — the data is provably frozen,
  with no cron to say so. Past that point
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
- `app/` — the static pages + `js/` page code (`buzzview.js`,
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
  admin link secret for the TO API (a week of setup, 72h from Start), bucket secret for
  moderator routes, publish flag gating all public reads. No auth secrets
  to provision; the one secret a deploy must set is `OPEN_KEY_SECRET`
  (see "Buzzpoints password").
- `tests/` — `run_tests.js` (engine unit tests), `e2e_worker.js` (full
  TO -> moderator -> public flow against `wrangler dev`), `e2e_sets.js`
  (editor -> invite -> mirror -> set-wide reads, same dev Worker;
  `e2e_lib.js` is what they share), `e2e_brackets.js` (per-bracket
  rounds: pools advancing on their own, packet locks, the playoffs
  opening together, the TD's buttons; same dev Worker),
  `e2e_alerts.js` (the Discord new-activity alerts against a webhook
  sink the suite runs itself), `e2e_directory.js` (the home page's list
  of running tournaments: who is listed, linked or not, the hourly sweep),
  `snapshot_publish.js` (the cron tick, mocked), `live_publish.js` (the
  qb-td-live publisher, on `node:sqlite`).
- `tools/archive.mjs` — the archive's approval CLI (see below). The only
  code here that reads the live backend outside a browser.
- `tools/yf_parity.mjs` + `tools/yf_parity/` — `npm run yf-parity`: the
  `.yft` export checked against YellowFruit's own import and save code
  (see "YellowFruit fidelity").
- `app/js/sidebar.js` — the tournaments running on this instance ("The
  directory", below) and the approved past ones (the archive): the home
  page's sidebar and the archive list.
- `app/about.html` — what qb-td is, and the way into the demo.
- `js/demo.js` + `demo/fixture.js` — the demo tournament, reached from
  the About page (`demo.html` only redirects there). Opening any page with `?t=demo`, `?a=demo`, or
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

## Renames: teams, players and rooms

qb-td knows a team by its exact name, and a player by team and name: in
the uploaded games, the schedule, the protest rulings, and the files that
leave qb-td, which have to match what MODAQ and YellowFruit write. A
rename therefore never rewrites a game already played. How it works today:

- **Teams and players** are renamed in the roster (Setup > Roster, or an
  uploaded roster). The saved roster keeps each earlier name as
  `_formerNames` on the team or player (`qbj.js` `buildRosterQbj`,
  `carryFormerNames`). `rosterNameMap` turns the roster into an
  old-to-new map, and `renameMatch` applies it when a game is read.
  Where each rule lives:
  - Reading a game is one function, `engine/games.js` `readGame`: rename,
    parse, then tag the room and file id. The public page
    (`pubview.js` `fetchMatches`) and `tools/archive.mjs` call it through
    `readGames`; the hub's stats, exports and playoff fill call it from
    `hubgames.js` `collectMatches`. With no renames nothing is copied.
  - Which uploads count as games is `games.js` `isGameFile` (a `.qbj` or
    a reader upload, without an error), and the one that counts in a
    room's round is `newestOf` (the highest id). The hub (`admin.js`,
    `hubgames.js`) and `finals.js` use them. `schedule.js` and
    `protests.js` keep the same test written out, because they are
    bundled into the reader, which is held byte for byte
    (`npm run check:bundles`).
  - One file as it leaves qb-td is `engine/exportfile.js`: the Worker's
    game downloads (`storedFileText`, over `modaqfile.js`
    `renameModaqTexts` and `modaqExport`), its public QBJ route
    (`publicQbjText`), the roster's Setup download (`rosterExportBody`,
    which drops `_formerNames` through `qbj.js` `rosterForExport`), and
    the names and links the hub shows for each upload (`fileDownloads`,
    `uploadQbjName`). The Worker reads a roster's map with `games.js`
    `rosterNamesFromText`, which skips the parse when the text has no
    `_formerNames`.
  - The set page renames with the map the Worker writes into the set
    state (`setstats.js` `siteNames`).
  - The hub's game lists and protests map the upload summaries the same
    way (`hubgames.js` `createHubNames`, `protests.js` `renamedSummary`),
    and so do the playoff and Finals auto-fill and the "Finished rounds
    only" label (`schedule.js` `namedFiles`, `summaryTeams`).

  Auto-fill decides what is ready from the saved schedule, not the tab's
  copy (`finals.js` `fillProgress`, `autoFillSaved`). The hub loads the
  rename map again when the roster's save time (`roster_at` in the admin
  detail) moves, so a rename saved in another tab reaches it on its next
  refresh. The schedule is the one copy rewritten: after a roster save,
  `followRenames` (`admin.js`) runs `renameTeams` (`schedule.js`) on the
  saved schedule. Rosters that leave qb-td drop `_formerNames`: the
  hub's roster Download goes through the Worker's `part=roster`
  (`rosterExportResponse`, `exportfile.js` `rosterExportBody`), and the
  roster editor's Download and the QBJ bundle use `hubgames.js`
  `rosterFileText`. An uploaded roster carries no list of renames, so
  `rosterRenames` pairs a dropped team with a new one only by shared
  players (at least half of the smaller team); position alone pairs
  nothing. Player renames come only from the editor.
- **Rooms** are renamed in Setup > Rooms. The Worker writes the new name
  into the saved schedule room the bucket resolves to, by its `bucket`
  link or else by its old name (`worker.js` `renameBucket`,
  `brackets.js` `roomIndexOf`, `followRoomRename`). When another
  schedule room already has the new name, the schedule is left as it is
  and the renamed room matches that room instead. The room's games get
  the new name in their public copies, and the rename forces a rebuild,
  so the round shards and the set page's buzzpoints follow. The public
  page shows each game's current room from the state's file list. The
  schedule write lands only on the copy the Worker read, so a hub's
  schedule save made in between is renamed too, not overwritten; the
  answer names both copies (`sched_was`, `sched_etag`), so the hub that
  held the renamed copy keeps saving without a question (see "Saves from
  two hub tabs").

Known limits:

- Games are renamed in one place (`games.js` `readGame`), but upload
  summaries, the Worker's downloads, the set page and the tiebreaker log
  each apply the map themselves. The tiebreaker "heard by" log
  (`packetsui.js`, `tb_add_dialog.js`) still does not: it names the
  teams as they were when the game was uploaded.
- A protest ruling is found under the game's current team names or the
  names it was uploaded under (`protests.js` `protestRows`). A ruling
  made between two renames of one of its teams is filed under the middle
  name, so after the second rename the protest shows as open again.
- Former names stay public: the public roster route and the GitHub
  snapshot serve `_formerNames`, because the public page needs them to
  rename games.
- Without a GitHub snapshot (self-hosted or dev), a viewer's Refresh after
  a rename brings the renamed schedule but not the renamed games, until
  the page reloads or a round's games move.

## Saves from two hub tabs

A TD may have the hub open in two tabs, or two TDs on two laptops. Each
save says which copy the tab edited (`app/js/saves.js`), so a save from a
tab whose copy is out of date keeps the other tab's change instead of
writing over it. One tab alone gets what it always got, from the same
requests.

- **Settings**: the body adds `settings_base`, the settings text the
  tab's copy was read as, and `settings_touched`, the keys the save sets
  whatever its copy held (Reset to preset, `statsSeen`, auto-advance,
  the round count, the bye room). When the base is what is stored, the
  whole object is stored, as before. Otherwise only this tab's changes go
  onto what is stored (`worker.js` `mergeSettings`): the preset and its
  overrides move together, and `buzz` merges key by key unless the tab
  sets a password, which takes its whole `buzz` so the hash and
  `buzz_wrap` stay a pair. The open key and `buzz_wrap` are made once,
  for what is finally stored. Opening the next round when auto-advance
  is switched on runs only when this save is the one switching it on.
- **Rulings**: the body adds `rulings_prev`, each ruling the tab changed
  as its copy had it (not the whole map). A current copy stores the map
  as sent; a stale one puts only those rulings onto the stored map
  (`mergeRulings`; `rulingsCurrent` settles the usual one-ruling case
  from the texts).
- With a base, either one lands with one UPDATE that holds only while
  the column is what was read (`updateGuarded`). A write in the moment
  between makes it read the row again and merge once more, three tries
  in all, then 409.
- **Schedule and roster** are whole files. The hub reads them with their
  R2 etag (`X-Qbtd-Etag`, exposed, sent only on the admin file route's
  raw read of these two keys) and saves onto that copy (`putOver`, R2
  `onlyIf`): the schedule names it in an `X-Qbtd-Base` header on its
  already preflighted JSON POST, the roster in `?base=` on its simple
  text POST, so neither adds a request. A refused schedule save answers
  `{ok: false, conflict: true, etag, schedule}` with the stored copy, or
  `etag` and `schedule` null when it was deleted; the same bytes count as
  saved with no write, so two hubs filling the same playoff slots never
  ask. A refused roster save answers the stored etag (one R2 head).
  Nothing is written either way. The editor then asks (`SCHED_CONFLICT`,
  `ROSTER_CONFLICT`): OK saves this tab's version over the other, and
  Cancel keeps the edits in the tab, unsaved. Auto-fill never asks: it
  fills the stored copy once more, and stops when the schedule was
  deleted or the tab has unsaved edits.
- A save with no base is the plain save it always was: the demo, a copy
  with no etag, any older page. The client never sends `none`. Without a
  conflict, each save's D1 statements and R2 operations are the ones it
  made before, with the UPDATE and the put made conditional
  (`tests/golden/worker_meter.json`); the day totals are unchanged
  (`meter_totals.json`, with `QBTD_SEND_BASE=1` too). The save bodies
  grow by the base text.

The first save of a new schedule (Generate) sends no base, but the Worker
answers the new etag to any schedule save, so the tab's next save is
guarded from then on.

## Tests

```bash
npm test                         # the seven below, in this order; no Worker, no network
node tests/run_tests.js          # engine: qbj parse, stats, .yft, report, zip, archive
node tests/live_publish.js       # qb-td-live publisher: deploys, retries, heartbeats, unpublish, hub mark
                                 # (real SQLite from schema.sql via node:sqlite; R2 + Cloudflare API mocked)
node tests/snapshot_publish.js   # cron tick: round shards + GitHub publisher (D1/R2/GitHub mocked)
node tests/games_golden.mjs      # game loading as the public page and the archive do it, and what is
                                 # built from it, held to tests/golden/games.json
node tests/hubgames_ref.mjs      # the hub's game loading (app/js/hubgames.js) and its QBJ bundle against
                                 # admin.js's as they were: the same requests, in order and at once, the
                                 # same games, and the zip the old code builds from the counted uploads
node tests/worker_inproc.mjs     # worker.js in Node (SQLite, in-memory R2): download bytes, each
                                 # request's D1, R2 and crypto operations and its CORS/X-Qbtd-* headers,
                                 # held to tests/golden/worker_*.json
node tests/saves_worker.mjs      # two tabs saving one tournament, the Worker side (see "Saves from two
                                 # hub tabs"): what is kept, what is refused, and what each costs

cd worker
npx wrangler d1 execute qb-td --local --file schema.sql
# A local DB is disposable: deleting worker/.wrangler/state and running
# schema.sql gives a fresh one. To keep an existing one instead, run each
# migration below whose column or table it lacks (each file's header says
# what it adds), once, in this order, then schema.sql again: it is
# re-runnable and adds the tables, indexes and triggers the migrations
# leave to it. migrate-rev.sql goes last, after that schema.sql, because
# its triggers name the set tables, which only schema.sql creates. On such
# a DB the first schema.sql above may fail; a file runs as one batch, so a
# failed one changes nothing.
#   npx wrangler d1 execute qb-td --local --file migrate-announce.sql      # broadcasts (retired; the column stays)
#   npx wrangler d1 execute qb-td --local --file migrate-pub.sql           # the cron's rebuild queue
#   npx wrangler d1 execute qb-td --local --file migrate-crypt.sql         # at-rest encryption
#   npx wrangler d1 execute qb-td --local --file migrate-protests.sql      # protests in the hub
#   npx wrangler d1 execute qb-td --local --file migrate-sets.sql          # question sets
#   npx wrangler d1 execute qb-td --local --file migrate-start.sql         # Start tournament
#   npx wrangler d1 execute qb-td --local --file migrate-starts.sql        # auto-advance
#   npx wrangler d1 execute qb-td --local --file migrate-brackets.sql      # per-bracket rounds
#   npx wrangler d1 execute qb-td --local --file migrate-pubbuilt.sql      # the hub's public page mark
#   npx wrangler d1 execute qb-td --local --file migrate-live.sql          # qb-td-live
#   npx wrangler d1 execute qb-td --local --file migrate-dirtyat.sql       # the fair rebuild queue
#   npx wrangler d1 execute qb-td --local --file migrate-liveprotests.sql  # protests before upload
#   npx wrangler d1 execute qb-td --local --file migrate-alertmsg.sql      # the alerts' wrap-up
#   npx wrangler d1 execute qb-td --local --file migrate-directory.sql     # the directory
#   npx wrangler d1 execute qb-td --local --file migrate-buzzpub.sql       # buzzpoints packets as files
#   npx wrangler d1 execute qb-td --local --file schema.sql
#   npx wrangler d1 execute qb-td --local --file migrate-rev.sql           # the Live Hub rev
# --test-scheduled is required: the cron builds the round shards the
# public routes serve, and the tests trigger it via /__scheduled.
# e2e_alerts.js additionally needs the dev Worker pointed at the sink it
# runs itself, which means a line in worker/.dev.vars *before* this
# starts — .dev.vars is read once, at startup (the last two stand the
# sink in for Cloudflare's analytics API, for the usage digest):
#   DISCORD_WEBHOOK=http://127.0.0.1:8798/hook
#   CF_API_TOKEN=e2e-token
#   CF_API_BASE=http://127.0.0.1:8798/cf
# (QBTD_HOOK_PORT=<port> moves the sink; the two URLs then name that port)
npx wrangler dev --local --port 8799 --test-scheduled &
cd .. && node tests/e2e_worker.js && node tests/e2e_sets.js && node tests/e2e_brackets.js \
  && node tests/e2e_alerts.js && node tests/e2e_directory.js

# the pages themselves, in headless Chrome (no npm deps): the dev Worker
# started with --var ALLOWED_ORIGIN:http://localhost:8765, plus
# `cd app && python3 -m http.server 8765`, then
node tests/ui_e2e.js

# D1 cost checks: start the dev Worker with the row meter instead
#   npx wrangler dev --local --port 8799 --test-scheduled --var METER:1
# (the meter is dev-only: /__meter 404s without METER). e2e_usage.js
# asserts the idle cron and an unchanged Live Hub refresh stay flat;
# sim_usage.js prices a whole day — TOURNAMENTS/ROOMS/ROUNDS/ROUND_MIN,
# CLIENT=legacy|smart for the Live Hub before and after rev checks.
# e2e_sets.js run against it also counts D1 queries: a set's packet
# changes and its state's rebuild must make as many with 20 mirrors as 2
node tests/e2e_usage.js
node tests/sim_usage.js

# a whole tournament end to end (same metered dev Worker): TD setup,
# rooms playing real-size games through auto-advance, the cron, then the
# standings computed three ways — from the games themselves, from the
# public round shards, and from the TD's downloads — must match exactly,
# with categories, buzzpoints, room pages and the rebuild binding checked
node tests/e2e_day.js

# the TD hub's stats and downloads, before and after the 10/25 batching,
# side by side: ACF Fall @ UIUC replayed from its archive on a local
# Worker it starts itself, two hubs open all day (the old one from
# QBTD_BEFORE, default 0c43911), every stats table, download, Rebuild
# body and playoff fill held equal byte for byte, requests counted
node tests/hub_ab_day.js

# capacity and CPU, with a behaviour model the project owner set (moderators
# and TDs on laptops; viewers half phones, 90% checking once a round, 10%
# refreshing every 1-2 min late in each round):
SHAPE=mid node tests/sim_day.js          # one day's requests, D1 rows, R2 ops, freshness
LIVE=1 SHAPE=mid node tests/sim_day.js   # the same day with viewers reading qb-td-live (modelled)
SHAPE=large node tests/bench_routes.mjs  # CPU per route under wrangler's profiler
SHAPE=large node tests/profile_day.mjs   # a whole day's CPU profile

# what a real day cost, from Cloudflare's own analytics (wrangler login):
# invocations, errors, CPU percentiles, the minutes past 10ms CPU, D1 rows.
# A route that throws answers a JSON 500 and is not counted as an error
# there; it logs `route failed: <method> <path>` to Workers Logs.
node tools/cf_usage.mjs 2026-09-19

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

### Holding a refactor to what the code does now

The goldens in `tests/golden/` pin what the code gives today: outputs
byte for byte, the order of keys and rows, error text, which games count,
the requests the pages make and what each one costs. A change meant to
keep behaviour must leave all of them as they are. Write them again
(`QBTD_UPDATE_GOLDEN=1`) only on a commit whose behaviour is the one to
keep, and say so in its message. `tests/ref_games.mjs` keeps the game
loading code as it was at 0cd19c5, so a moved copy can be checked against it.

```bash
npm run check:bundles            # the Worker bundle (wrangler deploy --dry-run, nothing uploaded):
                                 # zip, yft, yft3, report and stats add 0 bytes, no parseMatch, gzip within
                                 # 300 B; and `npm run build:read` rebuilds read.bundle.js byte for byte
node tests/ui_golden.js          # Chrome, no Worker: the demo hub (Live, cells and their links, Compute
                                 # three ways, each download, the Rebuild body) and the demo and archive
                                 # pages tab by tab, their static files and import chains (ports 9611-9612;
                                 # QBTD_GOLDEN_PORT=<p> moves them to p and p+1, QBTD_CDP_PORT fixes Chrome's)

# local servers for the rest, on a fresh database each run: dev Worker,
# static pages, and with --proxy tools/count_proxy.mjs in front of the
# Worker; it prints the env to export (QBTD_BASE, QBTD_PAGES, ..., INSPECTOR).
# wrangler's inspector always gets a port in the same range (default: the 9
# in the Worker port's ten, 9619 here), never its own default 9229
node tools/e2e_stack.mjs --state <new dir> --worker 9613 --pages 9614 [--proxy 9615] [--meter] [--inspector 9619]

# the browser suite, written out for an A/B: two runs of the same code
# must match before a comparison with a change means anything
QBTD_CAPTURE=<dir> QBTD_PAGE_BASE=http://127.0.0.1:9615 QBTD_LIVE_PORT=9616 QBTD_CDP_PORT=9617 node tests/ui_e2e.js
node tools/ab_compare.mjs <baseline capture> <other capture>

node tests/e2e_autofill.js       # also each hub's requests all day, exactly (tests/golden/e2e_autofill_counts.json)
node tests/e2e_saves.js          # two hub tabs in Chrome saving what the other just changed: kept, or asked about
node tests/e2e_day.js            # (--meter) also the hub's collectMatches (tests/golden/e2e_day_collect.json)

# what a day costs, held to tests/golden/meter_totals.json (--meter, a fresh
# database for each); QBTD_SEND_BASE=1 sends the base a hub sends with its
# saves and must give the same totals
QBTD_METER_GOLDEN=e2e_usage node tests/e2e_usage.js
QBTD_METER_GOLDEN="sim_usage TOURNAMENTS=3 ROOMS=4 ROUNDS=3 ROUND_MIN=20 SEED=1 SAVES=1 CLIENT=smart" \
  TOURNAMENTS=3 ROOMS=4 ROUNDS=3 ROUND_MIN=20 SEED=1 SAVES=1 CLIENT=smart node tests/sim_usage.js
QBTD_METER_GOLDEN="sim_usage SEED=1 SAVES=1 CLIENT=smart (default size)" SEED=1 SAVES=1 CLIENT=smart node tests/sim_usage.js
QBTD_METER_GOLDEN="sim_day SHAPE=small" SHAPE=small node tests/sim_day.js
QBTD_METER_GOLDEN="sim_day SHAPE=mid" SHAPE=mid node tests/sim_day.js

# CPU, this checkout against a checkout of the baseline (QBTD_BASELINE),
# interleaved on one machine
node --expose-gc tests/bench_games.mjs                         # game loading in the pages, against ref_games.mjs
QBTD_BASELINE=<dir> node --expose-gc tests/cpubench.mjs        # the Worker's routes in Node
QBTD_BASELINE=<dir> node tests/bench_pages.js                  # page loads on Fast 4G (cold rows are the gate), and their script files
# per route under wrangler's profiler, both dev Workers (--meter), taking
# turns 5 runs each at REPS=100 or more; compare the medians over the runs
QBTD_BASE=<worker> INSPECTOR=<ws> REPS=100 SHAPE=small node tests/bench_routes.mjs
```

The CPU gates are `bench_games`, `cpubench` and the cold rows of
`bench_pages`; warm page loads (5-12 ms) and single `bench_routes` runs
vary too much to hold a change to.

`npm test` needs Node 22.13 or later (`live_publish.js` runs `schema.sql`
on `node:sqlite`). GitHub Actions runs it on each push and pull request
(`.github/workflows/test.yml`, Node 24). The workflow only tests: it
deploys nothing and holds no secrets. The suites that need a dev Worker or
Chrome stay manual.

## Deploy (self-hosting)

Every deploy ships a changelog entry: add a release to the top of
`app/changelog.txt` (shown at `app/changelog.html`, linked from the hub) in
the Counter-Strike release-notes style — `Release Notes for M/D/YYYY`,
`[ SECTION ]` headers, one short `- ` line per change a TD, moderator or
player would notice. `npm test` checks the file parses and stays newest
first.

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
   names `set_id` — and one from before Start tournament needs
   `npx wrangler d1 execute qb-td --remote --file migrate-start.sql`,
   also before the Worker (room routes name `started`), and one from
   before auto-advance needs
   `npx wrangler d1 execute qb-td --remote --file migrate-starts.sql`
   (the packet route writes `room_starts`), and one from before the Live
   Hub's rev needs
   `npx wrangler d1 execute qb-td --remote --file migrate-rev.sql`
   (the admin route reads `tournaments.rev`; it also adds the cron's
   dirty-row indexes), and one from before per-bracket rounds needs
   `npx wrangler d1 execute qb-td --remote --file migrate-brackets.sql`
   (every room route reads `tournaments.bracket_rounds`),
   and one from before the hub's public page mark needs
   `npx wrangler d1 execute qb-td --remote --file migrate-pubbuilt.sql`
   (the cron writes `tournaments.pub_built`),
   and one from before the fair rebuild queue needs
   `npx wrangler d1 execute qb-td --remote --file migrate-dirtyat.sql`
   (every mutation writes `tournaments.pub_dirty_at`),
   and one from before qb-td-live needs
   `npx wrangler d1 execute qb-td --remote --file migrate-live.sql`
   BEFORE a Worker with `LIVE_SCRIPT` set is deployed (the cron and the
   admin routes name the `live_*` columns),
   and one from before protests showed before upload needs
   `npx wrangler d1 execute qb-td --remote --file migrate-liveprotests.sql`
   BEFORE the Worker (the admin route reads `live_protests`),
   and one from before the alerts' wrap-up needs
   `npx wrangler d1 execute qb-td --remote --file migrate-alertmsg.sql`
   BEFORE a Worker with `DISCORD_WEBHOOK` set (the hourly wrap-up reads
   `wrapped`; see "New-activity alerts"),
   and one from before the directory needs
   `npx wrangler d1 execute qb-td --remote --file migrate-directory.sql`
   BEFORE the Worker (the tick reads and writes `tournaments.dir_entry`),
   and one from before buzzpoints packets became files needs
   `npx wrangler d1 execute qb-td --remote --file migrate-buzzpub.sql`
   BEFORE the Worker (the qb-td-live deploy reads `tournaments.buzz_pub`),
   then `schema.sql` again for its two indexes,
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
5. `npx wrangler deploy` — `wrangler.toml`'s `REBUILD` service binding
   points at this Worker's own name (`qb-td`); a self-host under another
   name changes `service` to match, or the deploy fails
   (without the binding at all, the cron rebuilds inline)
6. `openssl rand -base64 32 | npx wrangler secret put OPEN_KEY_SECRET`,
   before the hub is in use. It locks the copy of a tournament's content
   key that the Worker keeps when a TD disables the stats password (see
   "Buzzpoints password"). Without it the Worker falls back to a constant
   that is in this repo, which is only fit for local development.
7. Host `app/` anywhere static; set `ALLOWED_ORIGIN` in `wrangler.toml` to
   that origin. Point the pages at your Worker with `?server=...` or by
   editing the default in `app/js/api.js`. Pages served from
   `qbsuite.github.io` ignore `?server=` and `?live=` (and localStorage
   `qbtdServer` / `qbtdLive`), so a shared link cannot point them at
   another backend; any other origin honors them.
8. Optional: serve the public state from a files-only Worker — see
   "Public state on qb-td-live" below. Without it, leave `LIVE_SCRIPT`
   empty; nothing else changes.

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

The small state (`/pub/:slug`: which shards to fetch, the round, the
file list) is NOT published here: a branch-head raw URL is cached for
`max-age=300`, so it would trail every update by up to five minutes.
It comes from qb-td-live when that's set up (next section) — free, and
fresh within about a minute of an upload — and otherwise from the
Worker, one request per page view. Either way `pubview.js` asks with
`cache: 'no-cache'`, so the refresh button can't be silently answered
from the browser's own copy — with no poll, that button is the only way
a viewer gets newer data and it has to work every time. Buzzpoints stay
on the Worker: packet text is password-gated per request, which a
static host can't do.

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

## Public state on qb-td-live (optional)

Takes the last per-view Worker request off the public page. Every page
load or refresh used to cost one `GET /pub/:slug` — 58–82% of a
tournament day's Worker requests in `tests/sim_day.js`, from the same
100,000/day the moderators and TD run on. Each published tournament's
state is now a static file, `/t/<slug>.json`, on a second, files-only
Worker (`qb-td-live`). Requests to static assets are free, unlimited and
not counted toward that limit (checked 9/30/2026 in the account's
analytics: 3,934 asset requests, 0 script requests), so viewers cost the
Worker nothing at any audience size. Measured with `LIVE=1
tests/sim_day.js`: a tournament-day drops from 979 / 4,894 / 13,482 Worker
requests (small / mid / large) to 454 / 950 / 2,813 — on the Free plan,
~200 / ~98 / ~33 such days a day instead of ~98 / ~20 / ~7.

How it works (worker.js "public state on qb-td-live"):

- The cron's tick hands the tournaments it rebuilt to the `LivePublish`
  entrypoint (its own invocation through the `LIVE` binding), which
  deploys the files-only Worker through Cloudflare's API — upload
  session, upload the changed files, PUT — at most once a tick. Every
  deploy carries every published tournament's file; unchanged ones ride
  by hash and aren't re-uploaded.
- `live_want` (built) vs `live_hash` (deployed) makes it self-repairing:
  a failed deploy, or two overlapping ticks landing out of order, leaves
  them different and the next run redeploys. Failures retry every 5
  minutes; the tick's own fresh changes always go.
- Heartbeat: while a tournament is active (rebuilt in the last 6 h) its
  file is redeployed at least every 10 minutes, and says so. A page that
  finds a file well overdue knows deploys are stuck and asks the Worker
  instead of showing frozen results. When one tournament's heartbeat
  deploys, other active tournaments due one within 5 minutes ride along
  (a failed deploy doesn't mark them Delayed), so quiet tournaments share
  one deploy per 10 minutes rather than costing one each.
- The page (`pubview.js` `loadState`) reads the file first and falls
  back to `/pub/:slug` at most once per load or refresh: on a 404 (not
  deployed yet, or unpublished), or — skipping the file for 10 minutes in
  that tab — on an error, a timeout, or an overdue heartbeat. A file
  older than what's on screen (the edge briefly serving the previous
  deploy, ~6% of deploys for a few seconds) reads as "nothing new". The
  fallback carries `?fb=<reason>`, logged as `live fallback <slug>
  <reason>` in Workers Logs.
- Viewers see a change a tick (≤1 min) plus the deploy's spread (median
  1.2 s, max 26 s in a 200-deploy soak) after it happens. That includes
  the round number and the name, which `/pub/:slug` shows instantly.
- The hub's mark: Updating until the file carrying the change has
  deployed, then Up to date; Delayed while deploys are failing.
- Only the production pages use it: `app/js/api.js` reads the file only
  when talking to the default backend, or when `?live=<url>` (or
  localStorage `qbtdLive`) names one. `?live=off` turns it off. Pages
  served from `qbsuite.github.io` ignore `?live=` and `qbtdLive`, and
  always read it.

Setup:

1. Create the files-only Worker once, with your own login: a folder
   holding `site/_headers` (`/*` then `  Access-Control-Allow-Origin: *`)
   and any placeholder file, and a `wrangler.json` of `{ "name":
   "qb-td-live", "compatibility_date": "2026-07-01", "assets": {
   "directory": "./site" }, "workers_dev": true }`; `npx wrangler
   deploy`. After this only the cron deploys it.
2. Token: **Manage Account → Account API Tokens** (account-owned — a
   per-Worker scope on a token from My Profile fails with
   `com.cloudflare.edge.worker.script is not a supported resource
   type`), Create Token → Custom, permission group Individual Workers →
   **Editor**, Worker `qb-td-live` only, no expiry. It can deploy that
   Worker and nothing else: no reading or deploying `qb-td`, no creating
   Workers.
3. `npx wrangler d1 execute qb-td --remote --file migrate-live.sql`
4. `npx wrangler secret put LIVE_TOKEN`; set `LIVE_SCRIPT` and
   `LIVE_ACCOUNT_ID` in `wrangler.toml`; `npx wrangler deploy`. Within a
   few ticks the backfill has deployed every published tournament.
5. Point `app/js/api.js`'s default `LIVE` at the new Worker's URL.

Watching it: `node tools/cf_watch.mjs [date]` shows the whole account for
a day — script requests per Worker, asset requests, D1, R2, Durable
Objects — and how many versions `qb-td-live` has stored. Versions pile
up one per deploy (roughly 20–50 per tournament-day plus heartbeats);
there is no delete endpoint and no documented cap, and deleting and
recreating the Worker (step 1) clears them and keeps its URL. Files come
back over the next ticks — the first deploy rebuilds up to 10, backfill
adds 5 a minute — and until a tournament's file is back its viewers get
the 404 path, i.e. the Worker, as before.

A gap left on purpose: the heartbeat only covers a file deployed while
its tournament was active. If the first deploy of the day keeps failing,
viewers stay on the file from setup (served with a 200, heartbeat long
expired), so the page can't tell. The hub's Delayed mark is the signal;
check `tools/cf_watch.mjs` and the Worker's logs.

## The directory: tournaments running here

The home page lists, down its right side, the tournaments running on the
instance now and, under them, the ones that have run on it.

**Live now** is automatic, and decided by use, never by a tournament
merely existing — so the rows people make to see what the thing does stay
out. A tournament is listed once it has started and two rooms have each
uploaded a game, and drops off 48 hours after Start (`LIVE_LIST_TTL`),
a day before its links close. It is linked while
its TD has the public page on; with it off it is still listed, by name
only, in grey. That is a choice this instance makes for every TD:
switching the public page off hides the results, not the fact that the
tournament is being held here.

**Past tournaments** are never automatic. The list is the archive
(`tools/archive.mjs`, "Archiving a tournament"): the tournaments you
approved with `add`, each linked to its frozen capture, and the ones you
approved with `name` — listed by name and date, nothing to open, for a
tournament whose TD keeps the public page off. Tournaments archived with
the same `--set "<name>"` show on the rail as one entry with a link per
site (`--site "<label>"`, default the host):

```bash
node tools/archive.mjs name "2026 Quartz" --date 2026-09-19
node tools/archive.mjs unname "2026 Quartz"
```

**How the live list is served.** It is one file, `directory.json`. With
qb-td-live on it rides every deploy there as a static file, so a view of
the home page costs the Worker nothing — no request, no D1 read. Without
it the page asks `GET /pub/directory` (cached five minutes).

**What it costs to keep.** Each tournament's entry is stored on its row
(`tournaments.dir_entry`). The tick recomputes it for the tournaments it
was already rebuilding from game rows it had already read; a tournament
with its public page off, which the tick otherwise never visits, costs one
indexed count of its own games when it changes. The row is written and
the file rebuilt only when an entry actually moves — the threshold
crossed, a rename, the public page switched — a handful of times in a
tournament's life. An hourly sweep rebuilds the file regardless, which is
what takes a closed tournament out of it, and means a row deleted by hand
or a deploy that failed cannot leave it wrong for long.

Measured 2026-10-10 with the Worker's meter (`--var METER:1`), one whole
tournament through `tests/e2e_day.js`, before and after the feature:

| | before | after |
|---|---|---|
| D1 queries | 448 | 454 |
| D1 rows read | 1,299 | 1,305 |
| D1 rows written | 297 | 299 |
| R2 Class A (writes) | 56 | 57 |
| R2 Class B (reads) | 101 | 102 |

So a tournament day costs six more rows read, two more written and one
more R2 write and read. An idle minute is one more query, on a partial
index, that finds nothing.

## New-activity alerts (optional)

A Discord ping when someone puts your instance to use, so a tournament
running on it isn't something you find out about days later from the
analytics. A tournament has **one message** in the channel — its name as
the title, a `Status:` line, and a **Player page** button — which follows it:

- **New** — a tournament, or a set's mirror started from an invite, was
  created. Title, slug, and a link to the public page. (A new question
  set gets a plain message of its own.)
- **Started** — the TD pressed Start tournament: setup is over and the
  72-hour clock is running.
- **Finished** — its links have closed: rooms, games and rounds, and,
  when there is something to archive, an **Archive it** button (see
  "Archiving a tournament"), or the `tools/archive.mjs add` command with
  `ARCHIVE_REPO` unset.

The buttons are Discord link buttons, which a plain webhook may send when
the post asks for them (`with_components=true`); they only open a URL, so
no Discord application is involved. That also keeps them gray — the
colored styles are interactive — so each carries an emoji (🌐 Player page,
📦 Archive it) to stand out.

"Created" and "started" are different news — most rows are somebody
typing `asdf` to see what the thing does — so each step is posted afresh
and the previous message deleted. Discord notifies on a post and stays
silent on an edit, and this way the channel still holds one line per
tournament, always showing where it stands. The one silent edit is
**Never started**, for a tournament that sat out its setup week unused.

Nothing happens on the backend when links close, so the wrap-up runs from
a second, hourly cron trigger (`0 * * * *` in `wrangler.toml`). It only
reaches a week back: switching the webhook on does not summarize months
of old tournaments.

Alerts never carry a credential. An admin link is the whole of a
tournament's security and this posts to a third party, so what goes out
is the slug and the name — the slug is already public on a published
tournament, and the webhook is private. A webhook that is down, slow or
misconfigured cannot fail the request it rode on: the calls are handed to
`ctx.waitUntil` and every failure is swallowed.

Setup:

```bash
# once, on an existing database, BEFORE the deploy
npx wrangler d1 execute qb-td --remote --file migrate-alertmsg.sql

# Discord > Server Settings > Integrations > New Webhook > Copy URL
npx wrangler secret put DISCORD_WEBHOOK
npx wrangler deploy
```

Leave `DISCORD_WEBHOOK` unset and the whole feature is dead code: no
fetch, no query, no write.

**Weekly usage digest.** With a second secret the same channel gets one
message every Monday (15:00 UTC, a third cron trigger): the last seven
full UTC days of Worker requests and D1 rows read and written — the
week's total, and its busiest day against the Free plan's daily limit —
plus R2 storage and operations. It turns yellow when the busiest day
passes 40% of a limit and red at 70%. The numbers come from Cloudflare's
GraphQL Analytics API, so the Worker needs a token that can read them and
nothing else:

```bash
# dash.cloudflare.com > My Profile > API Tokens > Create Custom Token,
# with the single permission Account > Account Analytics > Read
npx wrangler secret put CF_API_TOKEN
```

The account is `LIVE_ACCOUNT_ID` (or `CF_ACCOUNT_ID`, if you don't run
qb-td-live). A section Cloudflare refuses is reported as unavailable, with
its reason, and the rest still arrives. `tools/cf_watch.mjs` is the same
look for a single day from your laptop, in more detail.

Cost, per tournament and only while the webhook is set: up to five calls
to a free Discord webhook (three posts, two deletes) and three one-row D1
writes (the message id at creation and start, the claim at the wrap-up).
The hourly trigger is 24 invocations a day, each one small read of the
tournaments table. Nothing measurable against any Cloudflare limit.

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

1. ~~**D1 rows read binds at roughly half the request budget.**~~ Fixed:
   `/pub/:slug` used to re-derive the state per view (one D1 row per game,
   plus rooms and rounds, and three R2 reads) — 94% of a large
   tournament's day of D1 reads in `tests/sim_day.js` (2.2M rows, 44% of
   the free 5M). The cron now stores the body (`t/<tid>/pubstate.json`,
   `putPubState`) when it rebuilds a tournament, and a view reads that
   blob plus the tournament row it already looked up — 1 D1 row, however
   many games. The row's own fields (name, round) are overlaid live; the
   file list trails an upload by a tick, as the stats always have. A
   tournament with no blob yet takes the old live path and flags itself.

2. **The cron's CPU.** Measured with real-size games (`tests/bench_routes.mjs`):
   rebuilding one tournament costs ~5ms of Worker CPU, and the tick used
   to rebuild up to four in one invocation (~19-24ms against the Free
   plan's 10ms per invocation). Each rebuild now runs as its own
   invocation: the tick calls the `Rebuild` entrypoint once per dirty
   tournament through the `REBUILD` self-binding (wrangler.toml), and
   only the GitHub commit stays in the tick. Verified on Cloudflare
   (9/28/2026, throwaway Workers): a service-binding call is billed and
   CPU-accounted as its own invocation (a caller making five calls that
   each burned far past the cap stayed at ~2ms), a named entrypoint is
   unreachable from the public URL, and each call shows as one request in
   analytics — so this costs a request per rebuild. Also measured: the
   Free plan's 10ms is not enforced per request; requests with ~1s of CPU
   succeeded and kills came at ~0.2-2s, apparently a burst allowance that
   runs down under sustained load. Don't rely on it.

   **The cron can't rebuild more than four tournaments a tick.** It used
   to take the four newest dirty ones, and that starved the oldest: in a
   9/30/2026 production test with 11 simultaneous tournaments finishing
   rounds together, the four oldest showed only 1–3 of their 12 games on
   the public page before each round ended, while the newest showed 8–10.
   Fixed: the queue is served longest-waiting first (`pub_dirty_at`,
   kept from a tournament's first unpublished change, cleared when the
   tick claims it; `migrate-dirtyat.sql`), so with N tournaments busy at
   once nobody waits more than about N/4 minutes — ~3 at 11. Raising the
   four is NOT free: each tournament costs the tick about ten
   subrequests (its claim, the Rebuild call, `pub_built`, three R2 reads
   for the GitHub publish plus its round shards, the `pub_snapshot`
   write) against the Free plan's 50, and the tick is near 40 with four.
   Going higher means batching those writes and moving the publish reads
   into the Rebuild invocation first. Question sets add to this queue: a
   set's mirror is materialized whether or not its own page is public,
   so an unpublished mirror takes a slot that only published tournaments
   used to; materializing is R2-bounded and cheap.

   Raising the *publish* limit is bounded by **memory, not GitHub**.
   The limit that binds on GitHub's side is its secondary one, 500
   content-creating requests an hour (80 a minute), not the App's
   5,000/hour. Files ride inline in the tree request (`commitFiles`), so a
   commit costs 5 calls, 3 of them content-creating, however many files
   it carries, and the tick makes at most one commit a minute: 180 an
   hour at most. (Before this, a blob upload per file made a busy tick
   3 + N, ~420/hour at four dirty tournaments a minute.) Keep it one
   batched commit per tick: per-tournament commits would break the limit
   at three tournaments changing every minute.
   `buildPublish` holds the batch's files in memory at once, and
   JSON-encoding the tree request copies them again. Per-round shards made this much
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

4. ~~**Small waste in the hot path.**~~ Fixed 10/19/2026: `pubStateBody`
   reads only the schedule's head unless buzzpoints need its rounds, and
   tells the empty category-map marker from a real map by the object's
   size (the marker is the only empty map ever stored), so the catmap is
   neither read nor parsed; `buildPublish` drops the same parse. It has
   two callers (the cron's prebuilt state and `pubState`'s live
   fallback), so it stays its own function.

5. ~~**The TD's hub read games one request each.**~~ Fixed 10/18/2026.
   Auto-fill, Fill playoff slots and Compute stats read every game
   through `GET /a/:secret/file`, one Worker request and one ~64KB
   upload (packet text included) per game, again on each press or
   reload. On 10/17/2026 (ACF Fall @ UIUC, ~170 games, plus SF) that was
   ~11.3k of the day's 19.9k Worker requests, almost all of it in the
   playoffs; `tests/sim_day.js` never modelled the TD doing it. Ranking
   now reads the games' public copies, 100 to a request
   (`GET /a/:secret/games?ids=`, worker.js `adminGames`), and Compute
   stats keeps the uploads it has read for the tab. A reload still
   reads again: a few requests now, not one per game.

## Potential: buzzer rooms in tournament rooms (not built)

An idea on hold, written down with its numbers so it can be picked up
later: give every tournament room a phone-buzzer room from
qb-scorekeeper's room server (`qb-scorekeeper/rooms`, one Durable Object
per room — the moderator's reader hosts, players buzz from their phones).
Nothing in qb-td talks to it today.

Priced on 9/28/2026 with `qb-scorekeeper/tests/sim_buzzers.mjs`: real
WebSocket clients against the real room server behind a meter
(`tests/sim/`), a moderator + 8 phones per room, 20 tossups, 100 buzzes
a game, no question log shared with players, 8 games per room per day,
8 rooms per tournament. Duration uses production's own ratio (September
2026: 94 GB-s per 43.6k inbound messages).

| Per day | DO requests | Rows written | Duration |
|---|---|---|---|
| One game | 39 | 228 | ~1 GB-s |
| One tournament (64 games) | 2.4k | 15k | 77 GB-s |
| 60 tournaments (3,840 games) | 145k | 877k | 4.6k GB-s |
| Free plan, per day | 100k | 100k | 13k GB-s |

- **Fits the free plan up to ~6 tournaments a day**; rows written are what
  run out (~9x over at 60). On Workers Paid ($5/month: 50M rows written,
  1M requests, 400k GB-s a month) four such 60-tournament days add $0.
- **Buzz volume barely matters.** Doubling to 200 buzzes a game added
  ~18% messages and ~2 writes: a losing or early buzz writes nothing,
  only the winner does. Inbound per game is ~36% pongs (every phone
  answers an RTT ping each time the buzzers open), ~26% host `state`
  frames, ~17% buzzes.
- **The writes are the host's display snapshot**: `syncRoom()` sends a
  `state` on every `render()` and the room stores each one (~150 a game)
  so late joiners get the current screen. Dropping the question log only
  saves ~9%.
- The room connections are Worker requests too (one per phone per game,
  ~38k a day at 60 tournaments), and the free plan's 100k/day Worker
  budget is shared with qb-td's own traffic (~53k at the same scale).
- The room also re-arms its expiry alarm on every message. Production's
  analytics suggest alarms don't count as rows written; if they do, the
  60-tournament figure is ~3.0M instead of 877k — still inside Paid.

What would make it viable on the free plan, roughly in order of payoff:
1. Store the host's snapshot only when it changed (or at most every few
   seconds); it only serves late joiners. Estimated to cut writes by
   most of the ~150 per game — not yet measured.
2. Ping phones for RTT every few arms instead of every arm (cuts the
   largest message type).
3. Move the room's expiry alarm off the per-message path (re-arm at most
   once an hour).

## Potential: live scores during games (not built)

An idea for later, written down 10/3/2026 with the reasoning so far.
Today stats are semi-live: a game shows on the public page once its room
uploads it. Live scores would show each room's score while the game is
still being played.

**Rooms to the Worker (cheap).** The reader already sends the protest
list whenever it changes (`read_main.js` `watchProtests`); a live score
would ride the same way. Send only when the moderator moves to the next
question, not on every buzz or bonus part, since a bonus alone could be
four score changes. That is at most one small request per tossup: about
5 rooms x 10 games x 24 tossups = 1,200 a day for a Terrapin-sized
tournament, each one Worker request and one small write, around 1% of
the free daily allowances.

**The Worker to viewers (where the cost is).** Three ways, priced for
100 viewers over a 9-hour day:

| Option | Cost | How fresh |
|---|---|---|
| A. The page polls `/pub/:slug` | ~108k Worker requests at 30 s, over the free 100k/day; ~54k at 60 s | 30-60 s |
| B. The cron writes the scores to qb-td-live; the page re-reads that static file while open | Viewers free (static assets, see "Public state on qb-td-live"); ~540 publishes a day | ~1-2 min |
| C. A Durable Object per tournament pushes to viewers over WebSockets | ~1,200 pushes in + a few hundred connections; likely within the free allowance | Instant |

**Chosen direction: B.** It keeps the no-polling-the-Worker rule, costs
nothing per viewer, and a minute is fine for a scoreboard. To do it well:

- Keep live scores in their own small file on qb-td-live, separate from
  the full public rebuild, so the tournament doesn't rebuild its shards
  and commit to the GitHub snapshot every minute all day.
- Send only teams, scores and the tossup number: never question text,
  answers, protest reasons or notes (the public-copy rule).
- The page polls the static file only while the tab is visible and a
  round is live.

**Open question to test before relying on it.** Publishing about once a
minute means about 540 qb-td-live deploys a day per active tournament.
The static reads are known to be free (measured 9/30/2026, and `LIVE=1
tests/sim_day.js`), but each deploy stores a version, and there is no
delete endpoint and no documented cap (see "Watching it" above), and the
Cloudflare API has rate limits. Try it during a low-stakes event and
watch `node tools/cf_watch.mjs` for the version count and any refused
deploys; if it is a problem, publish every few minutes or move to C.

## Deleting a tournament (operator runbook)

There is deliberately no delete API — nothing reachable from the
internet can destroy a tournament. Normally none is needed: tournaments
go final after 96 h and unpublished ones are invisible. To actually
remove one (spam, a test that got published), do it with operator
credentials from `worker/`:

```bash
# find the id, its uploaded games and its own round packets (a set
# mirror's rounds point at the set's packets under s/, which stay)
npx wrangler d1 execute qb-td --remote --command \
  "SELECT id FROM tournaments WHERE slug='<slug>'"
npx wrangler d1 execute qb-td --remote --command \
  "SELECT r2_key FROM files WHERE tournament_id=<id> UNION SELECT packet_r2_key FROM rounds WHERE tournament_id=<id> AND packet_r2_key LIKE 't/<id>/%'"

# delete rows: these six tables key off the tournament. A set's mirror
# also has a set_mirrors row (DELETE FROM set_mirrors WHERE
# tournament_id=<id>); its packets are the SET's blobs under s/, which
# stay. A whole set: its sets / set_packets / set_mirrors rows and each
# blob under s/<sid>/ (packet versions, tiebreakers, catmap, ledger,
# state).
npx wrangler d1 execute qb-td --remote --command \
  "DELETE FROM files WHERE tournament_id=<id>; DELETE FROM buckets WHERE tournament_id=<id>; DELETE FROM rounds WHERE tournament_id=<id>; DELETE FROM room_starts WHERE tournament_id=<id>; DELETE FROM live_protests WHERE tournament_id=<id>; DELETE FROM tournaments WHERE id=<id>"

# then each blob it has, all under the t/<id>/ prefix:
#   the keys from the query above (bucket/... and packet/...)
#   roster.qbj, schedule.json, catmap.json
#   tiebreakers.json, tbread.json (the tiebreaker pool, and the questions
#     the games read from it)
#   open-key.json (the content key kept for the password-free buzzpoints
#     and scoresheets; see OPEN_KEY_SECRET)
#   the public copies: pub/<file id>.json, round/<n>.json, rounds.json
#     and pubstate.json; rebuild.json (a pending rebuild); combined.json
#     (the older whole-tournament copy)
npx wrangler r2 object delete "qb-td-data/<r2_key>" --remote
```

With qb-td-live on, the deleted tournament's file goes with the next
deploy (its row is gone, so the next manifest leaves it out); to force
one now, mark any published tournament dirty (`UPDATE tournaments SET
pub_dirty = 1 WHERE id = <another id>`).

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
tournament (`BUZZ_LIMIT` in `wrangler.toml`). The cap is checked before
anything is looked up, and a request with no password is turned away
before that, so a flood past the cap reads no D1 rows and no R2 objects:
each extra guess costs one Worker request and nothing else. Two honest
limits: Cloudflare's rate limiter counts per colo rather than globally,
and it runs inside the Worker, so the requests themselves still count
toward the daily allowance. The outer layer for that is a WAF
rate-limiting rule on `/pub/*/qpacket`, which stops requests before they
reach the Worker — but WAF rules need the Worker on a custom domain in a
Cloudflare zone, and this one is on `workers.dev`, where they can't be
set.

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

**Disabling the password** (`settings.statsOpen`, meant for a question set
that is already clear) opens buzzpoints and scoresheets to anyone with the
public link, so the Worker has to open finished rounds' packets with no
key from the viewer. The TD's own request, which holds the content key,
leaves the Worker a copy of it in R2 (`t/<id>/open-key.json`), wrapped
under the `OPEN_KEY_SECRET` Worker secret, and the copy is deleted when the
TD enables a password again. The secret is what keeps that copy from
opening anything on its own: R2 read access alone still yields no question
text, though whoever holds both the secret and R2 can open those packets.
Production must set it, to a long random value:

```bash
cd worker
openssl rand -base64 32 | npx wrangler secret put OPEN_KEY_SECRET
```

Without it, `openSecret` in `worker.js` falls back to a constant that is
in this public repo; the fallback is there so a local dev Worker works
without secrets. Changing the secret later leaves existing copies
unreadable: those tournaments' buzzpoints questions answer 409 until their
TD disables the password again.

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
#   --name "Title" archives it under a different name than its TD gave it
node tools/archive.mjs refresh <slug>          # recapture after a late correction
node tools/archive.mjs rebuild [<slug>]        # report pages again from the committed capture, offline
node tools/archive.mjs remove <slug>           # un-approve
node tools/archive_goldens.mjs <slug>          # a new archive's golden entries, before the commit
```

**From Discord.** With `ARCHIVE_REPO` set (`wrangler.toml`), a
Finished alert's **Archive it** button opens a new issue on that repo, its
title and body filled in: the slug, the date the tournament started, and
an empty `host:` line to fill or leave. Submitting it is the approval.
`.github/workflows/archive.yml` checks that the issue's author can push to
the repo (anyone else's issue is closed untouched), runs `add`, gives the
new archive its golden entries (`tools/archive_goldens.mjs`) and a
changelog line (`tools/changelog_add.mjs`), runs `npm test`, pushes to
`main`, and closes the issue with what it captured. Anything that fails
leaves the issue open with a link to the log; reopen it to try again.

`add` reads the public routes, writes the frozen capture
(`app/archive/<slug>.js`), generates the six report pages
(`app/archive/<slug>/`), and adds a manifest entry to
`app/archive/index.json`. Committing that is the approval. Nothing here
writes to the backend, and the tournament's live page is unaffected either
way.

The report pages are the stat report the archived page itself shows,
built from the capture with the same options (`captureReport`, after
`pubview.js` `statsOpts`): the tournament's game format, whose regulation
tossup count scales the rate stats and splits off overtime, and the
schedule, whose stages and pools head the standings. `run_tests.js`
rebuilds each archive's pages and compares them byte for byte with the
committed ones, so a change to the report's code fails `npm test` until
`node tools/archive.mjs rebuild` has been run and its output committed.
`rebuild` reads nothing but the committed captures.

A tournament whose TD released its questions (Disable password: the public
page serves buzzpoints and scoresheets to anyone) keeps them in its archive.
`add` saves each finished round's packet and the tiebreakers it read, as
the public routes serve them, to `app/archive/packets/<slug>/`, and the
capture lists those files under `__text`; the archived page fetches one
only when a viewer opens buzzpoints or a scoresheet. Every other capture
still carries no question text, which `npm test` checks, and has its
buzzpoints and scoresheets switched off, since an archived page could
never open them.

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
committed and served forever. It warns, and still writes, when the round
shards lack a game the public state lists (refresh once the cron has
caught up). `run_tests.js` re-runs all of these checks on what actually got
committed, along with manifest-to-capture agreement.

## YellowFruit fidelity

Three exports mirror YellowFruit's own output and are checked against its
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

The YellowFruit 3 file (`app/engine/yft3.js`, downloaded as
`<slug>-yf3.yft`) is the other generation's format entirely: six JSON
values, one per line — version, packets, settings, divisions, teams,
games — where YF 4's is one tournament-schema object. YF 3 splits a file
on newlines and parses each piece before it looks at anything, so a YF 4
file makes it throw before it can show an error. The file is what YF 3.0.2
(the last 3.x) saves after a TD adds the same teams and imports the same
game `.qbj`s: tossups as powers / tens / negs only (anything over 10 is a
power, anything negative a neg, as YF 3's own importer has it), powers
off for 10/-5 play, and — again better than that importer — overtime
tossups and each team's overtime powers, tens and negs filled in.

`npm run yf-parity` (`tools/yf_parity.mjs`) checks all of that against
YellowFruit's own code rather than against a reading of it. It clones YF
at the pinned tag into `.cache/` (nothing of YF's, AGPL-3.0, enters this
repo), runs its data model headless to import each scenario's files and
save a `.yft`, builds qb-td's from the same files, and fails unless the
two are the same tournament once YF has opened and re-saved each — in
practice they are byte-identical before that too — with no game YF flags
as an error and the same six report pages rendered from both. For YF 3 it
runs 3.0.2's own game importer and validator on the same files and
requires a byte-identical file with no game marked invalid. Scenarios
(`tools/yf_parity/scenarios.mjs`): the demo tournament, and a college-style
event with A/B teams, powers, a substitution, a rostered player who never
plays, punctuation and accents in names, and an overtime game. Run it
after any change to `app/engine/yft.js`, `yft3.js` or `parseMatch`; it needs git and
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
