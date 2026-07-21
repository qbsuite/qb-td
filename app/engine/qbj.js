// qbj.js — parse ModaQ match .qbj files and roster/registration qbj into
// normalized objects the stats engine and .yft generator consume.
//
// ModaQ's export (MODAQ src/qbj/QBJ.ts toQBJ) is a BARE match object in
// snake_case match-schema form, with a nonstandard `_round` field. Other
// tools may emit camelCase or wrap objects in {version, objects: [...]};
// every reader here accepts both spellings and both wrappings.

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}

function asName(x) {
  if (typeof x === 'string') return x.trim();
  if (x && typeof x.name === 'string') return x.name.trim();
  return '';
}

/** Round number from the qbj's `_round` or a ModaQ-style filename
    (`Round_3_A_B.qbj`). Returns null if neither yields one. */
export function roundFromFilename(filename) {
  const m = /round[ _-]?(\d+)/i.exec(filename || '');
  return m ? Number(m[1]) : null;
}

/** Best-effort round guess for a packet filename: an explicit "round N",
    else the file's only small number ("Packet 3.json", "03.docx" — but not
    "2024 ACF Winter.json"). Null when there's no safe guess. */
export function guessRound(filename) {
  const byWord = roundFromFilename(filename);
  if (byWord) return byWord;
  const nums = (String(filename || '').match(/\d+/g) || [])
    .map(Number).filter((n) => n >= 1 && n <= 99);
  return nums.length === 1 ? nums[0] : null;
}

/** The qbj payload inside any accepted container. The reader uploads one
    combined `.qbtd.json` per game — {qbj: <match>, game: <MODAQ state>} —
    whose game half (full packet text) every stats/export consumer must
    ignore; bare matches and {objects} wrappers pass through unchanged. */
export function matchPayload(json) {
  if (json && json.qbj && typeof json.qbj === 'object') return json.qbj;
  return json;
}

/**
 * Parse one match qbj. Accepts the parsed JSON object (or a whole-file
 * {objects: [...]} wrapper containing a Match). Throws Error with a
 * user-facing message on anything the stats engine can't work with.
 *
 * Returns {round, tossupsRead, packets, notes, teams: [
 *   {name, points, tossupPoints, bonusPoints, players: [
 *     {name, tossupsHeard, counts: [{value, n}]}]}]}
 */
export function parseMatch(json, opts = {}) {
  let obj = matchPayload(json);
  if (obj && Array.isArray(obj.objects)) {
    obj = obj.objects.find((o) => o && (o.type === 'Match' || pick(o, 'match_teams', 'matchTeams')));
    if (!obj) throw new Error('No Match object found in file');
  }
  if (!obj || typeof obj !== 'object') throw new Error('Not a qbj match object');

  const rawTeams = pick(obj, 'match_teams', 'matchTeams');
  if (!Array.isArray(rawTeams) || rawTeams.length !== 2) {
    throw new Error('Match must have exactly two match_teams');
  }

  const round = Number(pick(obj, '_round') ?? roundFromFilename(opts.filename));
  if (!Number.isFinite(round) || round < 1) {
    throw new Error('No round number (missing _round and none in the filename)');
  }

  const tossupsRead = Number(pick(obj, 'tossups_read', 'tossupsRead'));
  if (!Number.isFinite(tossupsRead) || tossupsRead < 1) {
    throw new Error('Missing or invalid tossups_read');
  }

  const teams = rawTeams.map((mt) => {
    const name = asName(pick(mt, 'team'));
    if (!name) throw new Error('A match_team has no team name');
    const rawPlayers = pick(mt, 'match_players', 'matchPlayers') || [];
    const players = rawPlayers.map((mp) => {
      const pname = asName(pick(mp, 'player'));
      if (!pname) throw new Error(`A player on ${name} has no name`);
      const counts = (pick(mp, 'answer_counts', 'answerCounts') || []).map((ac) => {
        const n = Number(pick(ac, 'number') ?? 0);
        const answer = pick(ac, 'answer', 'answer_type', 'answerType') || {};
        const value = Number(pick(answer, 'value'));
        if (!Number.isFinite(value)) throw new Error(`Bad answer value for ${pname} on ${name}`);
        if (!Number.isFinite(n) || n < 0) throw new Error(`Bad answer count for ${pname} on ${name}`);
        return { value, n };
      });
      const tossupsHeard = Number(pick(mp, 'tossups_heard', 'tossupsHeard') ?? 0);
      return { name: pname, tossupsHeard, counts };
    });

    const bonusPoints = Number(pick(mt, 'bonus_points', 'bonusPoints') ?? 0);
    const bounceback = Number(pick(mt, 'bonus_bounceback_points', 'bonusBouncebackPoints') ?? 0);
    const tossupPoints = players.reduce(
      (s, p) => s + p.counts.reduce((t, c) => t + c.value * c.n, 0), 0);
    const explicit = pick(mt, 'points');
    const points = Number.isFinite(Number(explicit))
      ? Number(explicit)
      : tossupPoints + bonusPoints + bounceback;
    return { name, points, tossupPoints, bonusPoints: points - tossupPoints, players };
  });

  if (teams[0].name === teams[1].name) throw new Error('Both match_teams have the same name');

  return {
    round,
    tossupsRead,
    packets: pick(obj, 'packets') || undefined,
    notes: pick(obj, 'notes') || undefined,
    teams,
  };
}

/**
 * Parse the roster editor's text format — one team per line,
 * `Team Name: Player, Player, ...`. Returns [{name, players}].
 * Throws with a line number on anything malformed.
 */
export function parseRosterLines(text) {
  const teams = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) throw new Error(`line ${i + 1}: expected Team: Player, Player`);
    const name = line.slice(0, at).trim();
    const players = line.slice(at + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (!name) throw new Error(`line ${i + 1}: no team name`);
    if (!players.length) throw new Error(`line ${i + 1}: ${name} has no players`);
    if (seen.has(name)) throw new Error(`line ${i + 1}: duplicate team ${name}`);
    seen.add(name);
    teams.push({ name, players });
  }
  if (!teams.length) throw new Error('no teams');
  return teams;
}

/**
 * Roster qbj from [{name, players}]: a serialized tournament with one
 * registration per team — the shape MODAQ's parseQbjRegistration reads
 * (each team needs >= 1 player), YellowFruit imports, and parseRoster
 * round-trips.
 */
export function buildRosterQbj(tournamentName, teams) {
  return {
    version: '2.1.1',
    objects: [{
      type: 'Tournament',
      name: tournamentName || 'Tournament',
      registrations: teams.map((t) => ({
        name: t.name,
        teams: [{ name: t.name, players: t.players.map((p) => ({ name: p })) }],
      })),
    }],
  };
}

/**
 * Parse a roster/registration qbj into [{name, players: [names]}], one entry
 * per team. Accepts: a whole file ({objects: [...]} with a Tournament and/or
 * Registration objects), a bare {registrations: [...]} object, or a bare
 * array of registrations/teams. A Registration's teams each become one entry.
 */
export function parseRoster(json) {
  const regs = [];
  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const teams = pick(obj, 'teams');
    const players = pick(obj, 'players');
    if (Array.isArray(teams)) {
      for (const t of teams) collect(t);
    } else if (Array.isArray(players) && asName(obj)) {
      regs.push({ name: asName(obj), players: players.map(asName).filter(Boolean) });
    }
  };

  if (Array.isArray(json)) {
    for (const o of json) collect(o);
  } else if (json && Array.isArray(json.objects)) {
    for (const o of json.objects) {
      collect(o);
      const registrations = pick(o, 'registrations');
      if (Array.isArray(registrations)) for (const r of registrations) collect(r);
    }
  } else if (json && Array.isArray(pick(json, 'registrations'))) {
    for (const r of pick(json, 'registrations')) collect(r);
  } else {
    collect(json);
  }

  // dedupe by team name, first occurrence wins
  const seen = new Set();
  const out = [];
  for (const r of regs) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  if (!out.length) throw new Error('No teams found in roster file');
  return out;
}
