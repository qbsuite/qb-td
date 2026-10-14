// qbj.js — parse MODAQ match .qbj files and roster/registration qbj into
// normalized objects the stats engine and .yft generator consume.
//
// MODAQ's export (MODAQ src/qbj/QBJ.ts toQBJ) is a BARE match object in
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

/** Round number from the qbj's `_round` or a MODAQ-style filename
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
 * Returns {round, tossupsRead, tossupBuzzes, packets, notes, teams: [
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

  // Who scored what on each tossup, in the order read — only when the file
  // has a question for every tossup read (the reader's always do). It is
  // what tells an overtime buzz from a regulation one.
  const questions = pick(obj, 'match_questions', 'matchQuestions');
  const tossupBuzzes = Array.isArray(questions) && questions.length === tossupsRead
    ? questions.map((q) => (pick(q, 'buzzes') || []).map((b) => ({
      team: asName(pick(b, 'team')),
      value: Number(pick(pick(b, 'result') || {}, 'value')),
    })).filter((b) => b.team && Number.isFinite(b.value)))
    : undefined;

  return {
    round,
    tossupsRead,
    tossupBuzzes,
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
 *
 * Undergraduate and Division II marks ride in YellowFruit's own fields: a
 * player's (`marks`, by player name) and the team's as YfData.isUG / isD2,
 * and which of the two the tournament tracks as the Tournament's
 * YfData.trackUG / trackDiv2. Only players are marked; a team's marks
 * follow from its players' (teamMarks), whatever `ug` / `d2` the entry
 * carries. A mark the tournament does not track is not written, so a
 * roster that tracks neither is the file it always was.
 */
export function buildRosterQbj(tournamentName, teams, track = rosterTracking(teams)) {
  const mark = (m) => {
    const ug = !!(track.trackUG && m && m.ug);
    const d2 = !!(track.trackDiv2 && m && m.d2);
    return ug || d2 ? { YfData: { isUG: ug, isD2: d2 } } : {};
  };
  const teamMark = (t) => mark(teamMarks(t.players, t.marks, track));
  return {
    version: '2.1.1',
    objects: [{
      type: 'Tournament',
      name: tournamentName || 'Tournament',
      ...(track.trackUG || track.trackDiv2 ? { YfData: { trackUG: !!track.trackUG, trackDiv2: !!track.trackDiv2 } } : {}),
      registrations: teams.map((t) => ({
        name: t.name,
        teams: [{ name: t.name, ...teamMark(t),
          players: t.players.map((p) => ({ name: p, ...mark((t.marks || {})[p]) })) }],
      })),
    }],
  };
}

/**
 * A team's marks, from its players': Division II when every player is
 * Division II, otherwise Undergraduate when every player is Undergraduate
 * or Division II. A team is one or the other, never both (an all-DII team
 * is DII), and is never marked by hand. Only tracked marks count: with
 * Division II untracked, a team is UG when every player is.
 * @param players the team's player names
 * @param marks {player name: {ug, d2}} for its marked players
 * @returns {ug, d2}
 */
export function teamMarks(players, marks, track) {
  const names = (players || []).filter(Boolean);
  const of = (p) => (marks || {})[p] || {};
  const d2 = (p) => !!(track.trackDiv2 && of(p).d2);
  const ug = (p) => !!(track.trackUG && of(p).ug);
  const allD2 = !!track.trackDiv2 && names.length > 0 && names.every(d2);
  return {
    ug: !allD2 && !!track.trackUG && names.length > 0 && names.every((p) => ug(p) || d2(p)),
    d2: allD2,
  };
}

/** Which marks a roster tracks, {trackUG, trackDiv2}: what parseRoster
    read from its file (`roster.track`), else whatever any team or player
    on it is marked with — the rule YellowFruit applies to a file that
    predates the switches. No roster tracks nothing. */
export function rosterTracking(teams) {
  if (teams && teams.track) return { trackUG: !!teams.track.trackUG, trackDiv2: !!teams.track.trackDiv2 };
  const any = (k) => (teams || []).some((tm) => tm[k] || Object.values(tm.marks || {}).some((m) => m[k]));
  return { trackUG: any('ug'), trackDiv2: any('d2') };
}

/**
 * Parse a roster/registration qbj into [{name, players: [names]}], one entry
 * per team. Accepts: a whole file ({objects: [...]} with a Tournament and/or
 * Registration objects), a bare {registrations: [...]} object, or a bare
 * array of registrations/teams. A Registration's teams each become one entry.
 *
 * A marked entry also carries its marks — `marks`, {player name: {ug, d2}},
 * for its marked players, and `ug` / `d2` (true) for the team, which are
 * worked out from those (teamMarks), not read from the file — and the
 * returned array a `track` property, {trackUG, trackDiv2} (see
 * rosterTracking; not enumerable, so a roster still compares and
 * serializes as its teams). A mark the roster does not track is dropped
 * here, so nothing downstream can show it, and an entry with no marks is
 * {name, players} and nothing else.
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
      const yf = (o) => (o && typeof o === 'object' && pick(o, 'YfData', 'yf_data')) || {};
      const marks = {};
      for (const p of players) {
        const y = yf(p);
        if (asName(p) && (y.isUG || y.isD2)) marks[asName(p)] = { ug: !!y.isUG, d2: !!y.isD2 };
      }
      regs.push({ name: asName(obj), players: players.map(asName).filter(Boolean),
        ug: !!yf(obj).isUG, d2: !!yf(obj).isD2, marks });
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

  // the switches as the file sets them (a Tournament's YfData), else as
  // its marks imply
  const holder = json && Array.isArray(json.objects) && json.objects.find((o) => {
    const y = o && typeof o === 'object' && pick(o, 'YfData', 'yf_data');
    return y && (y.trackUG !== undefined || y.trackDiv2 !== undefined);
  });
  const y = holder && pick(holder, 'YfData', 'yf_data');
  const track = y ? { trackUG: !!y.trackUG, trackDiv2: !!y.trackDiv2 } : rosterTracking(out);
  for (const r of out) {
    for (const [pn, m] of Object.entries(r.marks)) {
      m.ug = m.ug && track.trackUG;
      m.d2 = m.d2 && track.trackDiv2;
      if (!m.ug && !m.d2) delete r.marks[pn];
    }
    // the team's own marks follow from its players', whatever the file says
    const tm = teamMarks(r.players, r.marks, track);
    delete r.ug;
    delete r.d2;
    if (tm.ug) r.ug = true;
    if (tm.d2) r.d2 = true;
    if (!Object.keys(r.marks).length) delete r.marks;
  }
  Object.defineProperty(out, 'track', { value: track });
  return out;
}
