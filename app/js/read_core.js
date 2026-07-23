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

/* ---------- game format ----------
   tournaments.settings: {gameFormat: preset key, formatOverrides: partial
   IGameFormat}. The preset picks a MODAQ built-in; overrides layer the
   TO's tweaks (paired bonuses, bouncebacks, powers, ...) on top of it —
   the same fields MODAQ's own customize-format dialog edits, set once for
   every room instead of per reader. */

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

// MODAQ's preset formats, mirrored so the dashboard (which doesn't bundle
// MODAQ) can prefill and diff the customize panel. '' is UndefinedGameFormat,
// what a reader gets when no format prop is passed. tests/run_tests.js
// locks every entry against the installed modaq package.
const COMMON = {
  bonusesBounceBack: false, minimumOvertimeQuestionCount: 1,
  overtimeIncludesBonuses: false, regulationTossupCount: 20,
  timeoutsAllowed: 1, pronunciationGuideMarkers: ['("', '")'],
  pairTossupsBonuses: false, version: '2024-03-20',
};
export const PRESET_FORMATS = {
  '': { ...COMMON, displayName: 'Freeform format', negValue: -5,
    powers: [{ marker: '(*)', points: 15 }], regulationTossupCount: 999, timeoutsAllowed: 999 },
  'acf': { ...COMMON, displayName: 'ACF', negValue: -5, powers: [] },
  'macf-powers': { ...COMMON, displayName: 'mACF with powers', negValue: -5,
    powers: [{ marker: '(*)', points: 15 }] },
  'pace': { ...COMMON, displayName: 'PACE', negValue: 0,
    powers: [{ marker: '(*)', points: 20 }] },
};

// The IGameFormat fields a TO may override — exactly MODAQ's
// customize-format dialog. pronunciationGuideMarkers: null means "none"
// (undefined can't survive the settings JSON round trip).
export const OVERRIDE_FIELDS = [
  'regulationTossupCount', 'negValue', 'powers', 'minimumOvertimeQuestionCount',
  'bonusesBounceBack', 'overtimeIncludesBonuses', 'pairTossupsBonuses',
  'pronunciationGuideMarkers',
];

/** Drop unknown keys and wrong-typed values from stored overrides. */
export function cleanOverrides(ov) {
  if (!ov || typeof ov !== 'object') return {};
  const out = {};
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (int(ov.regulationTossupCount, 1, 999)) out.regulationTossupCount = ov.regulationTossupCount;
  if (int(ov.negValue, -100, 0)) out.negValue = ov.negValue;
  if (int(ov.minimumOvertimeQuestionCount, 1, 99)) out.minimumOvertimeQuestionCount = ov.minimumOvertimeQuestionCount;
  for (const k of ['bonusesBounceBack', 'overtimeIncludesBonuses', 'pairTossupsBonuses']) {
    if (typeof ov[k] === 'boolean') out[k] = ov[k];
  }
  if (Array.isArray(ov.powers) && ov.powers.every((p) =>
    p && typeof p.marker === 'string' && p.marker && int(p.points, 1, 1000))) {
    out.powers = [...ov.powers].sort((x, y) => y.points - x.points);
  }
  if (ov.pronunciationGuideMarkers === null) out.pronunciationGuideMarkers = null;
  else if (Array.isArray(ov.pronunciationGuideMarkers)
    && ov.pronunciationGuideMarkers.length === 2
    && ov.pronunciationGuideMarkers.every((m) => typeof m === 'string' && m)) {
    out.pronunciationGuideMarkers = ov.pronunciationGuideMarkers;
  }
  return out;
}

/** The full format a reader in this tournament plays under: preset base
    plus any cleaned overrides. Always returns a complete IGameFormat. */
export function effectiveFormat(settings) {
  const s = settings || {};
  const base = PRESET_FORMATS[s.gameFormat in PRESET_FORMATS ? s.gameFormat : ''];
  const ov = cleanOverrides(s.formatOverrides);
  if (!Object.keys(ov).length) return base;
  const out = { ...base, ...ov, displayName: base.displayName + ' (custom)' };
  if (out.pronunciationGuideMarkers === null) delete out.pronunciationGuideMarkers;
  return out;
}

/** The gameFormat prop for MODAQ, or undefined for MODAQ's own default.
    Accepts the settings object (or, legacy, a bare preset key). With no
    overrides a preset resolves to MODAQ's own object when GameFormats is
    supplied. */
export function resolveGameFormat(settings, GameFormats) {
  const s = typeof settings === 'string' ? { gameFormat: settings } : (settings || {});
  const key = s.gameFormat in FORMAT_KEYS ? s.gameFormat : '';
  const ov = cleanOverrides(s.formatOverrides);
  if (!Object.keys(ov).length) {
    if (!key) return undefined;
    return (GameFormats && GameFormats[FORMAT_KEYS[key]]) || PRESET_FORMATS[key];
  }
  return effectiveFormat({ gameFormat: key, formatOverrides: ov });
}

/** Only the fields of `want` that differ from the preset — what the
    dashboard stores as settings.formatOverrides. */
export function formatOverridesFrom(presetKey, want) {
  const base = PRESET_FORMATS[presetKey in PRESET_FORMATS ? presetKey : ''];
  const ov = {};
  for (const k of OVERRIDE_FIELDS) {
    const baseVal = k === 'pronunciationGuideMarkers' ? (base[k] || null) : base[k];
    if (want[k] !== undefined && JSON.stringify(want[k]) !== JSON.stringify(baseVal)) ov[k] = want[k];
  }
  return ov;
}

/** "marker=points, marker=points" -> IPowerMarker[] sorted by points
    descending (MODAQ requires descending). '' -> no powers. Throws a
    user-facing Error on junk. */
export function parsePowersText(text) {
  const chunks = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  const powers = chunks.map((c) => {
    const at = c.lastIndexOf('=');
    const marker = at < 0 ? '' : c.slice(0, at).trim();
    const points = Number(c.slice(at + 1).trim());
    if (!marker || !Number.isInteger(points) || points < 1 || points > 1000) {
      throw new Error('powers: use marker=points, like (*)=15');
    }
    return { marker, points };
  });
  if (new Set(powers.map((p) => p.marker)).size !== powers.length) {
    throw new Error('powers: duplicate marker');
  }
  return powers.sort((x, y) => y.points - x.points);
}

/** Inverse of parsePowersText, for prefilling the dashboard field. */
export function powersText(powers) {
  return (powers || []).map((p) => p.marker + '=' + p.points).join(', ');
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

/** One picker row per round, merging the reachable packets with this
    device's in-progress games (metas newest-first; the newest game per
    round wins). Rounds with a game but no packet still get a row so the
    game stays reachable. Sorted by round number. */
export function roundRows(packets, metas, currentRound) {
  const byRound = new Map();
  for (const p of packets || []) {
    byRound.set(p.number, {
      number: p.number, packet: p.packet_name, live: p.number === currentRound, game: null,
    });
  }
  for (const m of metas || []) {
    let row = byRound.get(m.round);
    if (!row) {
      row = { number: m.round, packet: null, live: m.round === currentRound, game: null };
      byRound.set(m.round, row);
    }
    if (!row.game) row.game = { id: m.id, a: m.a, b: m.b };
  }
  return [...byRound.values()].sort((x, y) => x.number - y.number);
}
