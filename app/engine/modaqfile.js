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

// The order MODAQ's toQBJ writes a match's keys in
const QBJ_KEYS = ['tossups_read', 'match_teams', 'match_questions', 'notes', '_round', 'packets'];

/** MODAQ's file names for a game: {qbj, game}. */
export function modaqFilenames(round, teamNames) {
  const base = `Round_${round}_${(teamNames || []).join('_')}`;
  return { qbj: base + '.qbj', game: base + '_Game.json' };
}

/** A MODAQ QBJ text with its _round set to `round`: unchanged when it
    already is, else the same text with only that value moved. */
export function qbjTextWithRound(text, round) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return text; }
  if (!obj || typeof obj !== 'object' || obj._round === round) return text;
  obj._round = round;
  return JSON.stringify(obj, null, 2);
}

/**
 * The QBJ and game texts MODAQ would export for a reader upload
 * ({qbj, game, modaq?}), filed under `round`. null for a half the upload
 * doesn't have.
 */
export function modaqExport(root, round) {
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
  return out;
}
