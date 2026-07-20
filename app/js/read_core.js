// read_core.js — pure helpers behind read.html (the embedded-MODAQ reader
// page). No DOM, no network, no MODAQ imports: everything here runs under
// tests/run_tests.js. read_main.js wires these to the page and to MODAQ.

/** Validate a parsed packet JSON into MODAQ's IPacket shape
    ({tossups: [{question, answer}], bonuses?}). Throws a user-facing
    Error on anything MODAQ would reject. */
export function normalizePacket(json, name) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.tossups)) {
    throw new Error('packet JSON has no tossups array');
  }
  if (!json.tossups.length) throw new Error('packet has no tossups');
  json.tossups.forEach((t, i) => {
    if (!t || typeof t.question !== 'string' || typeof t.answer !== 'string') {
      throw new Error('tossup ' + (i + 1) + ' is missing question or answer text');
    }
  });
  if (json.bonuses !== undefined && !Array.isArray(json.bonuses)) {
    throw new Error('packet bonuses is not an array');
  }
  return { tossups: json.tossups, bonuses: json.bonuses, name: json.name || name };
}

/** Group MODAQ IPlayer[] (from parseQbjRegistration) into
    [{name, players}] per team, roster order preserved. */
export function groupTeams(players) {
  const byTeam = new Map();
  for (const p of players || []) {
    if (!p || !p.name || !p.teamName) continue;
    if (!byTeam.has(p.teamName)) byTeam.set(p.teamName, []);
    byTeam.get(p.teamName).push(p);
  }
  if (!byTeam.size) throw new Error('no teams in roster');
  return [...byTeam.entries()].map(([name, players]) => ({ name, players }));
}

/** The two picked teams' players, first team's players first.
    Throws if the pick is invalid. */
export function pickTeams(teams, nameA, nameB) {
  if (!nameA || !nameB) throw new Error('pick both teams');
  if (nameA === nameB) throw new Error('pick two different teams');
  const a = teams.find((t) => t.name === nameA);
  const b = teams.find((t) => t.name === nameB);
  if (!a || !b) throw new Error('team not in roster');
  return [...a.players, ...b.players];
}

/** ModaQ-convention filenames. The reader uploads only `combined`
    (one `.qbtd.json` = {qbj, game} per game); `qbj`/`game` are the names
    consumers derive when splitting it back apart. */
export function matchFilenames(round, nameA, nameB) {
  const clean = (s) => String(s).replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Team';
  const base = `Round_${round}_${clean(nameA)}_${clean(nameB)}`;
  return { combined: base + '.qbtd.json', qbj: base + '.qbj', game: base + '_Game.json' };
}

/** The single per-game upload: MODAQ's qbj (round stamped) + the persisted
    game state (may be null if persistence hasn't flushed yet). */
export function combinedUpload(match, round, storeText) {
  let game = null;
  try { game = JSON.parse(storeText); } catch (e) { /* upload the qbj anyway */ }
  return JSON.stringify({ qbj: withRound(match, round), game });
}

/** Stamp the round onto a qbj match (MODAQ's customExport omits _round;
    YellowFruit and the stats engine both key on it). */
export function withRound(match, round) {
  return { ...match, _round: round };
}

// tournaments.settings.gameFormat -> key into MODAQ's GameFormats export.
// '' / unknown -> undefined (MODAQ's own default format).
const FORMAT_KEYS = {
  'acf': 'ACFGameFormat',
  'macf-powers': 'StandardPowersMACFGameFormat',
  'pace': 'PACEGameFormat',
};
export const GAME_FORMAT_OPTIONS = [
  { value: '', label: 'default' },
  { value: 'acf', label: 'ACF (no powers)' },
  { value: 'macf-powers', label: 'mACF with powers' },
  { value: 'pace', label: 'PACE NSC' },
];
export function resolveGameFormat(key, GameFormats) {
  const prop = FORMAT_KEYS[key];
  return prop ? GameFormats[prop] : undefined;
}

/* ---------- per-game storage ----------
   Every started game gets its own id, minted at start and carried in the
   URL (?b=<secret>&g=<id>). Storage is keyed by that id:
     qbtdMeta:<secret>:<id> — {a, b, round, packet, t, room, started}
     qbtdGame:<secret>:<id> — MODAQ's persisted GameState
   A game link resumes exactly its own game (no server fetch, no guessing);
   the bare room link always starts fresh with the current packet. Packet
   re-uploads and round changes can't touch an existing game. */

export function metaKey(secret, id) { return `qbtdMeta:${secret}:${id}`; }
export function gameKey(secret, id) { return `qbtdGame:${secret}:${id}`; }

/** Parse + validate a stored game meta. Null on anything short of a
    complete record — callers treat that as "no such game". */
export function parseMeta(text) {
  let m = null;
  try { m = JSON.parse(text); } catch (e) { return null; }
  if (!m || typeof m !== 'object') return null;
  if (typeof m.a !== 'string' || !m.a || typeof m.b !== 'string' || !m.b) return null;
  if (!Number.isInteger(m.round) || m.round < 1) return null;
  if (typeof m.started !== 'number') return null;
  return m;
}

/** True when a game's MODAQ store survived as intact JSON — resuming
    without it would mount MODAQ with no packet and no New Game button. */
export function storeIntact(text) {
  try { const s = JSON.parse(text); return !!s && typeof s === 'object'; }
  catch (e) { return false; }
}

/** This room's games found in storage, newest first: [{id, ...meta}].
    `get` is a (key) => string lookup so tests can fake localStorage. */
export function gameMetas(allKeys, get, secret) {
  const prefix = `qbtdMeta:${secret}:`;
  const out = [];
  for (const k of allKeys) {
    if (!k.startsWith(prefix)) continue;
    const meta = parseMeta(get(k));
    if (meta) out.push({ id: k.slice(prefix.length), ...meta });
  }
  return out.sort((x, y) => y.started - x.started);
}

/** Storage keys of this room's oldest games beyond the newest `keep`
    (parsed packets make game states big enough to care about mobile
    quota). Other rooms' games are never touched. */
export function staleGameKeys(metas, secret, keep = 8) {
  return metas.slice(keep).flatMap((m) => [metaKey(secret, m.id), gameKey(secret, m.id)]);
}
