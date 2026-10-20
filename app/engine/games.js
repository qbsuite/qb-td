// games.js — reading uploaded games, one way for every page that does it:
// the public page (pubview.js), the archive builder (tools/archive.mjs),
// the TD hub (admin.js) and the Worker's roster renames.
//
// Each game is renamed under the roster's current names (qbj.js
// renameMatch), parsed (parseMatch) and tagged with its room and file id,
// in that order, so a match's keys come out as they always have. Nothing
// here fetches, sorts, dedupes or copies a list: the callers keep their
// own order (the public page's round cache, the archive's bundle, the
// hub's newest-first uploads), and what depends on that order (category
// rows, buzzes at equal positions, the first-wins QBJ zip) stays put.
// With no renames a game is not copied at all (renameMatch hands it back).
//
// Only function declarations live at the top level, so the Worker, Node
// and the browser can all import this, and a bundle keeps only what it
// uses.

import { parseMatch, renameMatch, parseRoster, rosterNameMap } from './qbj.js';

/** A file the hub, the schedule and the stats count as a game: a .qbj or
    a reader upload that could be read. */
export function isGameFile(f) {
  return (f.kind === 'qbj' || f.kind === 'combined') && !f.error;
}

/**
 * One game: `qbj` under the roster's current names (`names` from
 * rosterNameMap, or null for none), parsed, with its room and file id.
 * Returns { m, qbj } with qbj the renamed game (the same object when
 * nothing is renamed). Throws what renameMatch or parseMatch throws; the
 * caller says which file it was.
 */
export function readGame(qbj, names, { id, filename, room }) {
  const renamed = renameMatch(qbj, names);
  const m = parseMatch(renamed, { filename });
  m.room = room;
  m.fileId = id;
  return { m, qbj: renamed };
}

/**
 * Games as the public page and the archive hold them ({id, room,
 * filename, qbj}), read in the order given. A game that won't read adds
 * 'filename: message' to `errors` and is left out. Returns { matches,
 * raw }: raw rows {id, round, room, qbj} for buzzpoints and categories.
 */
export function readGames(entries, names, errors) {
  const matches = [];
  const raw = [];
  for (const entry of entries) {
    try {
      const { m, qbj } = readGame(entry.qbj, names, entry);
      matches.push(m);
      raw.push({ id: entry.id, round: m.round, room: entry.room, qbj });
    } catch (e) { errors.push(entry.filename + ': ' + e.message); }
  }
  return { matches, raw };
}

/**
 * The upload that counts among `list` (one room's files for a round): the
 * game file with the highest id, or null. The first of equal ids wins, as
 * it would first in a newest-first sort. Pass the list already narrowed
 * to the room and round; nothing else is scanned.
 */
export function newestOf(list) {
  let best = null;
  for (const f of list) if (isGameFile(f) && (best === null || f.id - best.id > 0)) best = f;
  return best;
}

/**
 * A roster file's renames (rosterNameMap) from its text, or null. Renames
 * are held only under `_formerNames` (qbj.js parseRoster), so a roster
 * without that key, spelled out or \u-escaped, has none, and most rosters
 * are that: they skip the parse. Throws on a text that isn't JSON or a
 * roster; the caller decides what that means.
 */
export function rosterNamesFromText(text) {
  if (!text.includes('_formerNames') && !text.includes('\\u')) return null;
  return rosterNameMap(parseRoster(JSON.parse(text)));
}
