// hubgames.js — how the TD hub (admin.js) reads its tournament's games:
// the stored uploads and their public copies, the roster's renames, and
// the game format the hub ranks teams under. Moved out of admin.js as it
// was; the hub's own state (its caches, the schedule, the last stats)
// stays there and is passed in.
//
// No DOM, and no api.js: `pub` is passed in (api.js pub on the page,
// demo.js demoPub in the demo, a Node fetch in the tests), so the same
// code runs in Node.

import { parseRoster, matchPayload, rosterNameMap } from '../engine/qbj.js';
import { isGameFile, readGame } from '../engine/games.js';
import { modaqExport, modaqFilenames } from '../engine/modaqfile.js';
import { effectiveFormat } from './read_core.js';
import { eachLimit } from './limit.js';
import { fileSummary } from './protests.js';

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

// Every clean game file parsed, plus the roster: shared by Compute stats
// and the schedule's fill-from-standings.
// onFile(done, total) after each game file, for the caller's progress.
// opts.cache keeps what was read across calls; opts.rank says only the
// standings are wanted, so the games come from their public copies (the
// qbj half, notes stripped) in a request or two rather than one stored
// upload, packet text and all, per game. Those leave the zip's MODAQ
// files out, so Compute stats reads the uploads themselves.
export async function collectMatches(pub, a, t, buckets, files, onFile = () => {}, opts = {}) {
  const { cache = null, rank = false } = opts;
  const qbjFiles = files.filter(isGameFile);
  const errors = [];
  let roster = null;
  if (t.roster_r2_key) {
    try { roster = parseRoster(await ownedJson(pub, a, t.roster_r2_key)); }
    catch (e) { errors.push('Roster: ' + e.message); }
  }
  const names = rosterNameMap(roster);
  const matches = [];
  const raw = [];   // qbj halves: the zip download + the served stats bundle
  const games = []; // game halves of combined uploads, for the zip only
  const modaqFiles = []; // MODAQ's own two files of each reader upload, for the zip
  // the round is in the key: moving a game rewrites its file and copy
  const keyOf = (f) => f.id + '|' + f.size + '|' + f.created + '|' + f.round;
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
// own: the hub reads map and clears key directly.
export function createHubNames() {
  const hubNames = {
    key: null,
    map: null,
    async ensure(pub, a, t) {
      const key = t.roster_r2_key ? t.roster_r2_key + '@' + (t.roster_at || '') : '';
      if (hubNames.key === key) return;
      hubNames.key = key;
      hubNames.map = null;
      if (!key) return;
      try { hubNames.map = rosterNameMap(parseRoster(await ownedJson(pub, a, t.roster_r2_key))); } catch (e) { /* listed as uploaded */ }
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
