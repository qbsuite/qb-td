// ref_games.mjs — the game-loading code as it stands at 0cd19c5, and the
// hub's QBJ bundle built from it, copied verbatim, for the equivalence
// tests (tests/games_golden.mjs, hubgames_ref.mjs, e2e_day.js,
// bench_games.mjs) to hold a refactor against. Each copy sits inside a
// small wrapper that supplies what its page module would (its module
// state, its fetch helper); the lines between the BEGIN and END marks are
// the source lines named there, re-indented to sit in the wrapper and
// otherwise unchanged. Never edit those lines: when the
// code they were taken from changes on purpose, the goldens change with it
// and these copies stay as the record of what it was.

import { parseMatch, parseRoster, rosterNameMap, renameMatch, matchPayload, rosterForExport } from '../app/engine/qbj.js';
import { dedupeEntries } from '../app/engine/buzz.js';
import { modaqExport, modaqFilenames, renameModaqTexts } from '../app/engine/modaqfile.js';
import { makeZip } from '../app/engine/zip.js';
import { effectiveFormat } from '../app/js/read_core.js';
import { eachLimit } from '../app/js/limit.js';

export const PINNED = '0cd19c5';

/* ---------- the public page (app/js/pubview.js) ---------- */

/** fetchMatches as pubview.js runs it, on entries already fetched: the
    page's `state` is { files } (its live file list) and its round or
    bundle fetch answers `entries`. Returns the page's module state after
    the call: the matches, rawEntries and loadedIds. */
export async function pubviewFetchMatches({ entries: given, files, roster }) {
  const state = { rounds: null, files };
  let loadedIds = null;
  let rawEntries = [];
  const fetchRounds = async () => given;
  const fetchWholeBundle = async () => given;
  const errors = [];
  // BEGIN app/js/pubview.js@0cd19c5:200-224
  // rosterP: the roster's fetch, whose former names rename the games
  async function fetchMatches(errors, rosterP) {
    const entries = state.rounds ? await fetchRounds(errors) : await fetchWholeBundle(errors);
    const names = rosterNameMap(await rosterP);
    loadedIds = new Set(entries.map((e) => e.id));
    // A shard keeps the room a game had when it was built; the state's file
    // list is read live, so a TD's room reassignment (or rename) shows here
    // without the shard having to move.
    const liveRoom = new Map((state.files || []).map((f) => [f.id, f.room]));
    const out = [];
    const raw = [];
    for (const entry of entries) {
      if (liveRoom.get(entry.id)) entry.room = liveRoom.get(entry.id);
      try {
        const qbj = renameMatch(entry.qbj, names);
        const m = parseMatch(qbj, { filename: entry.filename });
        m.room = entry.room;
        m.fileId = entry.id;
        out.push(m);
        raw.push({ id: entry.id, round: m.round, room: entry.room, qbj });
      } catch (e) { errors.push(entry.filename + ': ' + e.message); }
    }
    rawEntries = dedupeEntries(raw);
    return out;
  }
  // END
  const out = await fetchMatches(errors, Promise.resolve(roster));
  return { matches: out, errors, rawEntries, loadedIds };
}

/** The same loop with nothing awaited, for the CPU comparison
    (bench_games.mjs): `names` is rosterNameMap's answer. */
export function pubviewLoop(entries, names, files) {
  const state = { files };
  const errors = [];
  let loadedIds = null;
  let rawEntries = [];
  // BEGIN app/js/pubview.js@0cd19c5:204-222
  loadedIds = new Set(entries.map((e) => e.id));
  // A shard keeps the room a game had when it was built; the state's file
  // list is read live, so a TD's room reassignment (or rename) shows here
  // without the shard having to move.
  const liveRoom = new Map((state.files || []).map((f) => [f.id, f.room]));
  const out = [];
  const raw = [];
  for (const entry of entries) {
    if (liveRoom.get(entry.id)) entry.room = liveRoom.get(entry.id);
    try {
      const qbj = renameMatch(entry.qbj, names);
      const m = parseMatch(qbj, { filename: entry.filename });
      m.room = entry.room;
      m.fileId = entry.id;
      out.push(m);
      raw.push({ id: entry.id, round: m.round, room: entry.room, qbj });
    } catch (e) { errors.push(entry.filename + ': ' + e.message); }
  }
  rawEntries = dedupeEntries(raw);
  // END
  return { matches: out, errors, rawEntries, loadedIds };
}

/* ---------- the archive (tools/archive.mjs) ---------- */

// BEGIN tools/archive.mjs@0cd19c5:190-205
/** Parse the bundle the way pubview.js does, so page and report agree:
    renamed teams and players under the roster's current names. */
function parseBundle(bundle, roster) {
  const matches = [];
  const errors = [];
  const names = rosterNameMap(roster);
  for (const entry of bundle.entries) {
    try {
      const m = parseMatch(renameMatch(entry.qbj, names), { filename: entry.filename });
      m.room = entry.room;
      m.fileId = entry.id;
      matches.push(m);
    } catch (e) { errors.push(entry.filename + ': ' + e.message); }
  }
  return { matches, errors };
}
// END
export { parseBundle as archiveParseBundle };

/* ---------- the TD hub (app/js/admin.js) ---------- */

/** The hub's game loading with its pub() (api.js) passed in: a page's
    pub, demo.js demoPub, or tests/e2e_lib.js nodePub against a Worker. */
export function hubRef({ pub, FETCH_AT_ONCE = 6 }) {
  // BEGIN app/js/admin.js@0cd19c5:3058-3162
  // Blob routes return parsed JSON when stored as JSON (qbj, roster,
  // combined), a raw Response otherwise.
  async function fetchOwnedJson(a, key) {
    const res = await pub(`${a}/file?key=${encodeURIComponent(key)}`);
    return res instanceof Response ? JSON.parse(await res.text()) : res;
  }

  // The public copies of these games (worker.js adminGames), GAMES_BATCH to
  // a request: id -> its qbj half. One the Worker has no copy of, or a
  // batch that fails, is left out for the caller to read on its own.
  const GAMES_BATCH = 100;
  async function fetchGameCopies(a, files) {
    const out = new Map();
    for (let i = 0; i < files.length; i += GAMES_BATCH) {
      const ids = files.slice(i, i + GAMES_BATCH).map((f) => f.id);
      try {
        const got = await pub(`${a}/games?ids=${ids.join(',')}`);
        for (const g of (got && got.games) || []) {
          if (g && g.qbj && typeof g.qbj === 'object') out.set(g.id, g.qbj);
        }
      } catch (e) { /* read one by one below */ }
    }
    return out;
  }

  // Every clean game file parsed, plus the roster: shared by Compute stats
  // and the schedule's fill-from-standings.
  // onFile(done, total) after each game file, for the caller's progress.
  // opts.cache keeps what was read across calls; opts.rank says only the
  // standings are wanted, so the games come from their public copies (the
  // qbj half, notes stripped) in a request or two rather than one stored
  // upload, packet text and all, per game. Those leave the zip's MODAQ
  // files out, so Compute stats reads the uploads themselves.
  async function collectMatches(a, t, buckets, files, onFile = () => {}, opts = {}) {
    const { cache = null, rank = false } = opts;
    const qbjFiles = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
    const errors = [];
    let roster = null;
    if (t.roster_r2_key) {
      try { roster = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)); }
      catch (e) { errors.push('Roster: ' + e.message); }
    }
    const names = rosterNameMap(roster);
    const matches = [];
    const raw = [];   // qbj halves: the zip download + the served stats bundle
    const games = []; // game halves of combined uploads, for the zip only
    const modaqFiles = []; // MODAQ's own two files of each reader upload, for the zip
    // the round is in the key: moving a game rewrites its file and copy
    const keyOf = (f) => f.id + '|' + f.size + '|' + f.created + '|' + f.round;
    const copies = rank ? await fetchGameCopies(a, qbjFiles.filter((f) => !(cache && cache.has(keyOf(f))))) : new Map();
    // Each file is its own round trip to the Worker (a quarter second or
    // more), so they're read FETCH_AT_ONCE at a time rather than one after
    // another, then parsed in upload order so the output doesn't change.
    // auto-fill keeps the games it has read: a pool finishing later
    // fetches only its own
    const got = await eachLimit(qbjFiles, FETCH_AT_ONCE, async (f) => {
      const ck = keyOf(f);
      const full = cache && cache.has(ck) ? cache.get(ck)
        : copies.has(f.id) ? copies.get(f.id) : await fetchOwnedJson(a, f.r2_key);
      if (cache) cache.set(ck, full);
      return full;
    }, onFile);
    for (const [i, f] of qbjFiles.entries()) {
      try {
        // Combined reader uploads contribute only their qbj half downstream
        // (the game half carries the full packet text; the TO's zip gets it
        // as the separate MODAQ game file).
        if (got[i].error) throw got[i].error;
        const full = got[i].value;
        // under the roster's current names, should a team or player be renamed
        const payload = renameMatch(matchPayload(full), names);
        const m = parseMatch(payload, { filename: f.filename });
        const room = buckets.find((b) => b.id === f.bucket_id);
        m.room = room ? room.room_name : '';
        m.fileId = f.id;
        // the name this game's .qbj carries in the QBJ bundle, which the
        // .yft records the way YellowFruit notes an imported file
        m.filename = f.filename.replace(/\.qbtd\.json$/i, '.qbj');
        matches.push(m);
        raw.push({
          id: f.id, round: m.round, room: m.room, reader: f.kind === 'combined',
          filename: m.filename,
          text: JSON.stringify(payload),
        });
        if (f.kind === 'combined' && full.game && typeof full.game === 'object') {
          // MODAQ's own two files for this game (engine/modaqfile.js), under
          // the roster's current names
          const exp = modaqExport(full, m.round, names);
          // named by its own QBJ's teams, in MODAQ's order
          let named = m.teams.map((tm) => tm.name);
          try { named = JSON.parse(exp.qbj).match_teams.map((mt) => mt.team.name); } catch (e) { /* keep the parsed names */ }
          const fileNames = modaqFilenames(m.round, named);
          modaqFiles.push({ round: m.round, qbjName: fileNames.qbj, qbj: exp.qbj, gameName: fileNames.game, game: exp.game });
          games.push({
            round: m.round,
            filename: f.filename.replace(/\.qbtd\.json$/i, '_Game.json'),
            text: JSON.stringify(full.game),
          });
        }
      } catch (e) {
        errors.push(f.filename + ': ' + e.message);
      }
    }
    return { roster, names, matches, raw, games, errors, modaqFiles };
  }
  // END

  // BEGIN app/js/admin.js@0cd19c5:3164-3171
  // The tournament's game format: its regulation tossup count is where
  // overtime starts when the hub ranks teams (stats.js standings), as it is
  // on the public page.
  function gameFormat(t) {
    let settings = {};
    try { settings = JSON.parse(t.settings) || {}; } catch (e) { /* keep {} */ }
    return effectiveFormat(settings);
  }
  // END
  return { fetchOwnedJson, fetchGameCopies, collectMatches, gameFormat, GAMES_BATCH };
}

/** The QBJ bundle download as showStats built it, on what Compute stats
    left in its scope: `got` (collectMatches' answer), `modaqFiles` and
    `raw` narrowed to the stages and rounds picked, `inPick` (a file's
    round), the tournament `t`, its `files` and admin path `a`. `pub`
    answers the reads; `download(name, data, type)` gets the file.
    Returns buildZip. */
export function hubZipRef({ pub, a, t, files, got, modaqFiles, raw, inPick, download }) {
  const { fetchOwnedJson } = hubRef({ pub });
  // BEGIN app/js/admin.js@0cd19c5:3417-3452
  const buildZip = async () => {
    // Every game as its separated files: match .qbj + MODAQ game file.
    // Files list newest-first, so first-wins dedupe keeps the latest
    // upload of a re-exported game (same name twice would break the zip).
    const seen = new Set();
    const entries = [];
    const add = (round, filename, data) => {
      const name = `round-${round}/${filename}`;
      if (seen.has(name)) return;
      seen.add(name);
      entries.push({ name, data });
    };
    // a reader upload: MODAQ's own .qbj and _Game.json, as its Backup to
    // JSON dialog writes them (engine/modaqfile.js), under the roster's
    // current names
    for (const x of modaqFiles) {
      if (x.qbj) add(x.round, x.qbjName, x.qbj);
      if (x.game) add(x.round, x.gameName, x.game);
    }
    // a .qbj the TD added by hand: indented as MODAQ writes (2 spaces)
    const indent = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; } };
    for (const r of raw.filter((x) => !x.reader)) add(r.round, r.filename, indent(r.text));
    // game files that went up separately from their .qbj (Add a game)
    for (const f of files.filter((x) => x.kind === 'game' && inPick(x))) {
      try {
        const text = JSON.stringify(await fetchOwnedJson(a, f.r2_key), null, 2);
        add(f.round, f.filename, renameModaqTexts({ qbj: null, game: text }, got.names).game);
      }
      catch (e) { /* bundle still useful without it */ }
    }
    if (t.roster_r2_key) {
      try { entries.push({ name: 'roster.qbj', data: JSON.stringify(rosterForExport(await fetchOwnedJson(a, t.roster_r2_key)), null, 2) }); }
      catch (e) { /* bundle still useful without it */ }
    }
    download(t.slug + '-qbj.zip', makeZip(entries), 'application/zip');
  };
  // END
  return buildZip;
}

/** The MODAQ files collectMatches gave at 0cd19c5, from what it gives
    now. Since 10/20 each carries its upload's `id`, so the QBJ bundle
    can hold only the upload the standings count, and a reader upload
    saved without its game half gives its .qbj too, with `game: null`;
    the pinned code left that upload out. Everything else is as it was:
    the same entries, in the same order, with the same keys and bytes. */
export function pinnedModaqFiles(modaqFiles) {
  return modaqFiles.filter((x) => x.game !== null).map(({ id, ...x }) => x);
}
