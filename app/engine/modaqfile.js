// modaqfile.js — a game's files exactly as MODAQ itself exports them.
//
// MODAQ's Backup to JSON dialog (ExportToJsonDialog) writes a game as
//   Round_<n>_<team>_<team>.qbj       QBJ.toQBJString(game, packet, n)
//   Round_<n>_<team>_<team>_Game.json JSON.stringify(game, null, 2)
// (team names joined by "_" as they are, spaces kept). The reader saves
// those two texts with each upload (read_main.js, `modaq`), and the hub
// and the Worker hand them back unchanged, so a TD's download is MODAQ's
// own file. An upload from before the reader saved them is rebuilt as
// closely as it can be: the QBJ's keys in MODAQ's order with the round in
// it, and the game alone rather than the reader's saved {game, uiState}.
//
// A roster rename (qbj.js rosterNameMap) reaches these files too: given
// the roster's map, both come back under the current names, as the stats
// count the game. Nothing to rename leaves MODAQ's text as it was.

import { renameMatch, withRound } from './qbj.js';

// The order MODAQ's toQBJ writes a match's keys in
const QBJ_KEYS = ['tossups_read', 'match_teams', 'match_questions', 'notes', '_round', 'packets'];

/** MODAQ's file names for a game: {qbj, game}. */
export function modaqFilenames(round, teamNames) {
  const base = `Round_${round}_${(teamNames || []).join('_')}`;
  return { qbj: base + '.qbj', game: base + '_Game.json' };
}

/** A MODAQ QBJ text with its _round set to `round` (qbj.js withRound):
    unchanged when it already is, else the same text with only that value
    moved, indented as MODAQ writes it. */
export function qbjTextWithRound(text, round) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return text; }
  const out = withRound(obj, round);
  return !out || out === obj ? text : JSON.stringify(out, null, 2);
}

/** MODAQ's game file (parsed) under a roster's renames: its players
    ({name, teamName}, in the player list and in every buzz, join, leave
    and swap) and the teams it names (teamName, receivingTeamName). A
    copy; null when nothing in it is renamed. The packet is left alone. */
function renameGame(game, map) {
  let changed = false;
  const team = (n) => { const now = map.teams.get(n); if (now && now !== n) { changed = true; return now; } return n; };
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'packet') out[k] = v;
      else if ((k === 'teamName' || k === 'receivingTeamName') && typeof v === 'string') out[k] = team(v);
      else if (k === 'teamNames' && Array.isArray(v)) out[k] = v.map((n) => (typeof n === 'string' ? team(n) : n));
      else out[k] = walk(v);
    }
    // a player is keyed by their team's current name (rosterNameMap)
    if (typeof out.name === 'string' && typeof out.teamName === 'string') {
      const now = map.players.get(out.teamName + '\n' + out.name);
      if (now && now !== out.name) { out.name = now; changed = true; }
    }
    return out;
  };
  const out = walk(game);
  return changed ? out : null;
}

/** MODAQ texts {qbj, game} (either may be null) under the roster's
    renames (`names`, rosterNameMap): each the same text when nothing in
    it is renamed. Also for a bare .qbj or game file added by hand. */
export function renameModaqTexts(texts, names) {
  const out = { ...texts };
  if (!names) return out;
  if (out.qbj) {
    try {
      const q = JSON.parse(out.qbj);
      const r = renameMatch(q, names);
      if (JSON.stringify(r) !== JSON.stringify(q)) out.qbj = JSON.stringify(r, null, 2);
    } catch (e) { /* not JSON: as it was */ }
  }
  if (out.game) {
    try {
      const r = renameGame(JSON.parse(out.game), names);
      if (r) out.game = JSON.stringify(r, null, 2);
    } catch (e) { /* not JSON: as it was */ }
  }
  return out;
}

/**
 * The QBJ and game texts MODAQ would export for a reader upload
 * ({qbj, game, modaq?}), filed under `round`. null for a half the upload
 * doesn't have. `names` (rosterNameMap) puts both under the roster's
 * current names.
 */
export function modaqExport(root, round, names = null) {
  const out = { qbj: null, game: null };
  if (!root || typeof root !== 'object') return out;
  const m = root.modaq && typeof root.modaq === 'object' ? root.modaq : null;
  if (m && typeof m.qbj === 'string') out.qbj = qbjTextWithRound(m.qbj, round);
  else if (root.qbj && typeof root.qbj === 'object') {
    const q = root.qbj;
    const o = {};
    for (const k of QBJ_KEYS) {
      if (k === '_round') o._round = round;
      else if (q[k] !== undefined) o[k] = q[k];
    }
    for (const k of Object.keys(q)) if (!(k in o)) o[k] = q[k];
    out.qbj = JSON.stringify(o, null, 2);
  }
  if (m && typeof m.game === 'string') out.game = m.game;
  else if (root.game && typeof root.game === 'object') {
    // the reader's saved state is {game, uiState}; MODAQ's file is the game
    const g = root.game.game && typeof root.game.game === 'object' && 'uiState' in root.game ? root.game.game : root.game;
    out.game = JSON.stringify(g, null, 2);
  }
  return renameModaqTexts(out, names);
}
