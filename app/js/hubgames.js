// hubgames.js — how the TD hub (admin.js) reads its tournament's games:
// the stored uploads and their public copies, the roster's renames, and
// the game format the hub ranks teams under. Moved out of admin.js as it
// was; the hub's own state (its caches, the schedule, the last stats)
// stays there and is passed in.
//
// It also builds the hub's tournament downloads from what it read (the
// YellowFruit 4 and 3 files, the HTML report, the QBJ bundle and the
// roster file; see "The hub's downloads" below), and passes on
// engine/exportfile.js, so the hub imports its downloads from one place.
// They share this file so a cold load of the hub fetches one module
// fewer: on a slow link each module the hub waits for adds to its first
// render.
//
// No DOM, and no api.js: `pub` is passed in (api.js pub on the page,
// demo.js demoPub in the demo, a Node fetch in the tests), so the same
// code runs in Node. The Worker never imports this file: zip.js, the
// YellowFruits and the report would all enter its bundle.

import { parseRoster, matchPayload, rosterNameMap, rosterForExport } from '../engine/qbj.js';
import { isGameFile, readGame } from '../engine/games.js';
import { modaqExport, modaqFilenames, renameModaqTexts } from '../engine/modaqfile.js';
import { uploadQbjName } from '../engine/exportfile.js';
import { serializeYft } from '../engine/yft.js';
import { serializeYft3 } from '../engine/yft3.js';
import { buildReport } from '../engine/report.js';
import { dedupeMatches } from '../engine/stats.js';
import { makeZip } from '../engine/zip.js';
import { effectiveFormat } from './read_core.js';
import { eachLimit } from './limit.js';
import { fileSummary } from './protests.js';

export { uploadQbjName, publicQbjName, publicQbjText, storedFileText, rosterExportBody, fileDownloads } from '../engine/exportfile.js';

// Game files read at once by Compute stats and the playoff fill
const FETCH_AT_ONCE = 6;

// Blob routes return parsed JSON when stored as JSON (qbj, roster,
// combined), a raw Response otherwise.
export async function ownedJson(pub, a, key) {
  const res = await pub(`${a}/file?key=${encodeURIComponent(key)}`);
  return res instanceof Response ? JSON.parse(await res.text()) : res;
}

// The public copies of these games (worker.js adminGames), GAMES_BATCH to
// a request: id -> its qbj half. One the Worker has no copy of, or a
// batch that fails, is left out for the caller to read on its own.
const GAMES_BATCH = 100;
export async function gameCopies(pub, a, files) {
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

// What a read is kept under in a collectMatches cache: the round is in
// the key, as moving a game rewrites its file and copy
export const cacheKey = (f) => f.id + '|' + f.size + '|' + f.created + '|' + f.round;

// The stored uploads themselves (worker.js adminUploads), UPLOADS_BATCH
// to a request, one request after another, into `cache` as
// collectMatches keeps them, so its call after this reads none of them.
// One at a time: each answer is ~1.5 MB of reader uploads, and three
// in flight at once from a browser broke the local Worker (hub_ab_day.js)
// where the same three from Node never did; fifteen in a row for a
// 150-game day take about as long as the reads they replace. One the
// Worker leaves out, a game file that isn't JSON, or a batch that fails
// is left for collectMatches to read on its own (and say why).
// onDone(done, total) as uploads land, for the caller's progress.
const UPLOADS_BATCH = 10;
// what fetchUploads reads: the game uploads and the game files added by hand
export const isUpload = (f) => (isGameFile(f) || f.kind === 'game') && !f.error;
export async function fetchUploads(pub, a, files, cache, onDone = () => {}) {
  const want = files.filter((f) => isUpload(f) && !cache.has(cacheKey(f)));
  const byId = new Map(want.map((f) => [f.id, f]));
  let done = 0;
  for (let i = 0; i < want.length; i += UPLOADS_BATCH) {
    const batch = want.slice(i, i + UPLOADS_BATCH);
    try {
      const got = await pub(`${a}/uploads?ids=${batch.map((f) => f.id).join(',')}`);
      for (const x of (got && got.files) || []) {
        const f = byId.get(x && x.id);
        if (!f) continue;
        let body = x.body;
        if (body === undefined) { try { body = JSON.parse(x.text); } catch (e) { continue; } }
        if (body && typeof body === 'object') cache.set(cacheKey(f), body);
      }
    } catch (e) { /* read one by one by collectMatches */ }
    done += batch.length;
    onDone(done, want.length);
  }
  return want.length;
}

// Every clean game file parsed, plus the roster: shared by Compute stats
// and the schedule's fill-from-standings.
// onFile(done, total) after each game file, for the caller's progress.
// opts.roster ({ json }, the roster as the hub already read it: hubNames
// rosterFor) saves reading it again; opts.cache keeps what was read across calls; opts.rank says only the
// standings are wanted, so the games come from their public copies (the
// qbj half, notes stripped) in a request or two rather than one stored
// upload, packet text and all, per game. Those leave the zip's MODAQ
// files out, so Compute stats reads the uploads themselves.
export async function collectMatches(pub, a, t, buckets, files, onFile = () => {}, opts = {}) {
  const { cache = null, rank = false, roster: given = null } = opts;
  const qbjFiles = files.filter(isGameFile);
  const errors = [];
  let roster = null;
  if (t.roster_r2_key) {
    try { roster = parseRoster(given ? given.json : await ownedJson(pub, a, t.roster_r2_key)); }
    catch (e) { errors.push('Roster: ' + e.message); }
  }
  const names = rosterNameMap(roster);
  const matches = [];
  const raw = [];   // qbj halves: the zip download + the served stats bundle
  const games = []; // game halves of combined uploads, for the zip only
  const modaqFiles = []; // MODAQ's own files of each reader upload, for the zip
  const keyOf = cacheKey;
  const copies = rank ? await gameCopies(pub, a, qbjFiles.filter((f) => !(cache && cache.has(keyOf(f))))) : new Map();
  // Each file is its own round trip to the Worker (a quarter second or
  // more), so they're read FETCH_AT_ONCE at a time rather than one after
  // another, then parsed in upload order so the output doesn't change.
  // auto-fill keeps the games it has read: a pool finishing later
  // fetches only its own
  const got = await eachLimit(qbjFiles, FETCH_AT_ONCE, async (f) => {
    const ck = keyOf(f);
    const full = cache && cache.has(ck) ? cache.get(ck)
      : copies.has(f.id) ? copies.get(f.id) : await ownedJson(pub, a, f.r2_key);
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
      // under the roster's current names, should a team or player be
      // renamed (games.js readGame), in the room it is filed under now
      const qbj = matchPayload(full);
      const room = buckets.find((b) => b.id === f.bucket_id);
      const { m, qbj: payload } = readGame(qbj, names, { id: f.id, filename: f.filename, room: room ? room.room_name : '' });
      // A file whose game names another round than the one it is filed
      // under (an upload from before 10/19) is refiled in place the
      // first time it is fixed: its id, size and round can stay as they
      // were, so it is never kept, and the next call reads it again
      // rather than count it under its old round beside the fix.
      if (cache && m.round !== f.round) cache.delete(keyOf(f));
      // the name this game's .qbj carries in the QBJ bundle, which the
      // .yft records the way YellowFruit notes an imported file
      m.filename = uploadQbjName(f.filename);
      matches.push(m);
      raw.push({
        id: f.id, round: m.round, room: m.room, reader: f.kind === 'combined',
        filename: m.filename,
        text: JSON.stringify(payload),
      });
      if (f.kind === 'combined') {
        // the upload itself has a qbj half, a game half or both; its
        // public copy (rank) is the qbj half alone, and gives no files
        const half = !!full.game && typeof full.game === 'object';
        if (half || (full.qbj && typeof full.qbj === 'object')) {
          // MODAQ's own two files for this game (engine/modaqfile.js),
          // under the roster's current names, with the upload's id: the
          // QBJ bundle holds the upload the standings count. One saved
          // without its game half has no game file, as its own download
          // has none (exportfile.js storedFileText); its .qbj is MODAQ's.
          const exp = modaqExport(full, m.round, names);
          // named by its own QBJ's teams, in MODAQ's order
          let named = m.teams.map((tm) => tm.name);
          try { named = JSON.parse(exp.qbj).match_teams.map((mt) => mt.team.name); } catch (e) { /* keep the parsed names */ }
          const fileNames = modaqFilenames(m.round, named);
          modaqFiles.push({ id: f.id, round: m.round, qbjName: fileNames.qbj, qbj: exp.qbj, gameName: fileNames.game, game: half ? exp.game : null });
        }
        if (half) {
          games.push({
            round: m.round,
            filename: f.filename.replace(/\.qbtd\.json$/i, '_Game.json'),
            text: JSON.stringify(full.game),
          });
        }
      }
    } catch (e) {
      errors.push(f.filename + ': ' + e.message);
    }
  }
  return { roster, names, matches, raw, games, errors, modaqFiles };
}

// The tournament's game format: its regulation tossup count is where
// overtime starts when the hub ranks teams (stats.js standings), as it is
// on the public page.
export function gameFormat(t) {
  let settings = {};
  try { settings = JSON.parse(t.settings) || {}; } catch (e) { /* keep {} */ }
  return effectiveFormat(settings);
}

// The roster's renames (qbj.js rosterNameMap), so a game uploaded under a
// team's old name is listed under its new one, as the stats count it.
// The hub holds one of these. ensure() loads them again whenever the
// roster is saved, from the hub (which sets key to null) or from another
// tab (its save time, roster_at, moves). key and map are the object's
// own: the hub reads map and clears key directly. The roster read is kept
// too (json), so Compute stats, the playoff fill and the QBJ bundle take
// it from here rather than read it again (rosterFor).
export function createHubNames() {
  const keyOf = (t) => (t.roster_r2_key ? t.roster_r2_key + '@' + (t.roster_at || '') : '');
  const hubNames = {
    key: null,
    map: null,
    json: null,
    async ensure(pub, a, t) {
      const key = keyOf(t);
      if (hubNames.key === key) return;
      hubNames.key = key;
      hubNames.map = null;
      hubNames.json = null;
      if (!key) return;
      try {
        const json = await ownedJson(pub, a, t.roster_r2_key);
        hubNames.map = rosterNameMap(parseRoster(json));
        hubNames.json = json;
      } catch (e) { /* listed as uploaded */ }
    },
    // { json }: the roster `t` names, as read here, or null when this
    // hasn't read that one (a save since, or a read that failed: the
    // caller reads it, and says why it couldn't)
    rosterFor(t) {
      return hubNames.json && hubNames.key && hubNames.key === keyOf(t) ? { json: hubNames.json } : null;
    },
    // a file's summary (protests.js), its teams under their current names
    summary(f) {
      const s = fileSummary(f);
      if (!s || !hubNames.map) return s;
      return { ...s, teams: s.teams.map((n) => hubNames.map.teams.get(n) || n) };
    },
  };
  return hubNames;
}

/* ---------- The hub's downloads ----------
   Built one way: the YellowFruit 4 and 3 files, the HTML report (zipped or
   as its six pages), the QBJ bundle and the roster file. Nothing here
   reads or writes storage: the hub reads what goes in, calls these, and
   hands the file to the browser (admin.js keeps its reads, its menu and
   its messages). One game file or the roster as the Worker serves it is
   engine/exportfile.js, passed on above. */

/** The YellowFruit file for `version` 4 or 3, from the stats' export
    options: { name: <slug>-yf4.yft or <slug>-yf3.yft, data, type }. The
    two share an extension and nothing else, so each is named apart. */
export function yftFile(slug, opts, version) {
  return version === 3
    ? { name: slug + '-yf3.yft', data: serializeYft3(opts), type: 'application/json' }
    : { name: slug + '-yf4.yft', data: serializeYft(opts), type: 'application/json' };
}

/** The HTML report's six pages, [{ name, text }], named <slug>_standings.html
    and so on, as YellowFruit saves them (the hsquizbowl.org tournament
    database refuses report files without that prefix). */
export function reportPages(slug, opts) {
  return buildReport({ ...opts, prefix: slug });
}

/** The six report pages zipped, so they land as one folder ready to host. */
export function reportZipFile(slug, opts) {
  const pages = reportPages(slug, opts);
  return { name: slug + '-report.zip', data: makeZip(pages.map((f) => ({ name: f.name, data: f.text }))), type: 'application/zip' };
}

/** The roster as a file to hand out: without the former names only qb-td
    reads, indented as MODAQ writes (2 spaces). */
export function rosterFileText(qbj) {
  return JSON.stringify(rosterForExport(qbj), null, 2);
}

/**
 * The QBJ bundle: the games the standings count, each as its separate
 * files, in a folder per round, plus the roster. From what the hub has
 * read:
 * - matches: the games in the stages and rounds picked (collectMatches);
 *   of a game uploaded more than once only the upload the standings,
 *   the .yft and the report count goes in (stats.js dedupeMatches: the
 *   newest per round and teams, under the roster's renames), so a game
 *   re-read with its teams the other way round is in it once
 * - modaqFiles: each reader upload's MODAQ .qbj and game file, as its
 *   Backup to JSON dialog writes them (hubgames.js collectMatches),
 *   under the roster's current names; an upload saved without its game
 *   half gives its .qbj alone, as its own download does
 * - raw: the games' rows from the same call; a .qbj added by hand
 *   (not a reader's) goes in indented as MODAQ writes (2 spaces)
 * - gameFiles: the game files that went up apart from their .qbj (Add a
 *   game), read one after another in upload order, each
 *   { round, filename, text } with the text 2-space indented, or
 *   { round, filename, error } for one that couldn't be read (left out)
 * - roster: { json } as read, { error }, or null without a roster
 * - names: the roster's renames (rosterNameMap) the game files take
 * A name the zip already holds is not added again (the same name twice
 * would break the zip): the reader's files come first, then the .qbj
 * files added by hand, then the game files, so a reader's game file
 * beats one added by hand under MODAQ's name.
 */
export function qbjZipFile(slug, { matches, modaqFiles, raw, gameFiles, roster, names }) {
  const counted = new Set(dedupeMatches(matches).map((m) => m.fileId));
  const seen = new Set();
  const entries = [];
  const add = (round, filename, data) => {
    const name = `round-${round}/${filename}`;
    if (seen.has(name)) return;
    seen.add(name);
    entries.push({ name, data });
  };
  for (const x of modaqFiles) {
    if (!counted.has(x.id)) continue;
    if (x.qbj) add(x.round, x.qbjName, x.qbj);
    if (x.game) add(x.round, x.gameName, x.game);
  }
  const indent = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; } };
  for (const r of raw.filter((x) => !x.reader && counted.has(x.id))) add(r.round, r.filename, indent(r.text));
  for (const g of gameFiles) {
    if (g.error) continue; // the bundle is still useful without it
    try { add(g.round, g.filename, renameModaqTexts({ qbj: null, game: g.text }, names).game); }
    catch (e) { /* the bundle is still useful without it */ }
  }
  if (roster && !roster.error) {
    try { entries.push({ name: 'roster.qbj', data: rosterFileText(roster.json) }); }
    catch (e) { /* the bundle is still useful without it */ }
  }
  return { name: slug + '-qbj.zip', data: makeZip(entries), type: 'application/zip' };
}
