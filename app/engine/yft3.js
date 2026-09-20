// yft3.js — generate a YellowFruit 3 .yft from parsed matches + roster, for
// TDs still on the 3.x app (its last release is 3.0.2). YF 3 and YF 4 share
// a file extension and nothing else: a YF 4 file is one tournament-schema
// JSON object (yft.js); a YF 3 file is six JSON values, one per line —
//   {version} / packets / settings / divisions / teams / games
// (MainInterface.writeJSON). YF 3 splits the file on newlines and parses
// each piece before it looks at anything, so handed a YF 4 file it throws
// before it can show an error: the app just does nothing.
//
// This is an independent implementation of that format (YF is AGPL-3.0; no
// YF code is copied here — see THIRD_PARTY_NOTICES.md). The target is the
// file YF 3.0.2 saves after a TD adds the same teams and imports the same
// game .qbj files (SingleGameQBJImport.importGame, then validateGame), key
// for key and in its key order. tools/yf_parity.mjs runs that YF 3 code
// against this output; run it after any change here.
//
// What YF 3 can hold is narrower than YF 4: tossups are powers / tens /
// negs and nothing else, so a value above 10 counts as a power and any
// negative value as a neg, which is also what YF 3's own importer does.
// Overtime is again the place this does better than that importer, which
// never sees it in a MODAQ file: `ottu` and each team's overtime powers,
// tens and negs are filled in from the per-tossup record.

import { answerTypes, importOrder, overtimeOf, REGULATION_TOSSUPS } from './yft.js';

// Files say which YF wrote them; YF refuses one from a later minor version.
const YF3_VERSION = '3.0.2';
// The report configuration every YF 3 install has (SYS_DEFAULT_RPT_NAME).
const DEFAULT_RPT = 'YF Defaults';

/**
 * Build the YF 3 file's six sections.
 * @param opts {matches, roster} — as buildYft takes them: matches from
 *   qbj.parseMatch, roster from qbj.parseRoster (teams and players seen only
 *   in matches are added).
 * @returns {metadata, packets, settings, divisions, teams, games}
 */
export function buildYft3(opts) {
  const rules = opts.settings || {}; // the MODAQ game format (see yft.js)
  if (!opts.matches || !opts.matches.length) throw new Error('No matches to export');
  const matches = importOrder(opts.matches);

  // Roster: given, else from the matches; either way every team and
  // player the games mention is on it (YF 3 rejects a game otherwise).
  const roster = (opts.roster || []).map((r) => ({ name: r.name, players: [...r.players] }));
  const byTeam = new Map(roster.map((r) => [r.name, r]));
  for (const m of matches) for (const t of m.teams) {
    let entry = byTeam.get(t.name);
    if (!entry) { byTeam.set(t.name, (entry = { name: t.name, players: [] })); roster.push(entry); }
    for (const p of t.players) if (!entry.players.includes(p.name)) entry.players.push(p.name);
  }

  const { values } = answerTypes(matches, rules);
  // the tournament's own regulation length, as in yft.js — not a constant
  const regulation = rules.regulationTossupCount ?? REGULATION_TOSSUPS;
  const top = Math.max(...values);
  const settings = {
    powers: top >= 20 ? '20pts' : top > 10 ? '15pts' : 'none',
    negs: values.some((v) => v < 0),
    bonuses: matches.some((m) => m.teams.some((t) => t.bonusPoints > 0)),
    bonusesBounce: rules.bonusesBounceBack ?? false,
    lightning: false,
    playersPerTeam: 4,
    defaultPhases: [],
    rptConfig: DEFAULT_RPT,
  };

  // AddTeamModal.handleAdd + MainInterface.addTeam
  const teams = roster.map((r) => ({
    teamName: r.name,
    smallSchool: false,
    jrVarsity: false,
    teamUGStatus: false,
    teamD2Status: false,
    roster: Object.fromEntries(r.players.map((p) => [p, { year: '', undergrad: false, div2: false }])),
    divisions: {},
    rank: null,
  }));

  const count = (p, test) => p.counts.reduce((n, c) => n + (test(c.value) ? c.n : 0), 0);
  const line = (t) => Object.fromEntries(t.players.map((p) => [p.name, {
    negs: count(p, (v) => v < 0),
    powers: count(p, (v) => v > 10),
    tens: count(p, (v) => v === 10),
    tuh: p.tossupsHeard || 0,
  }]));

  // keys in the order YF 3's importer writes them, `invalid` last where
  // validateGame adds it
  const games = matches.map((m) => {
    const [a, b] = m.teams;
    const ot = overtimeOf(m, regulation);
    const otCount = (t, test) => values.reduce((n, v) => n + (test(v) ? ot.count(t.name, v) : 0), 0);
    return {
      bbPts1: 0,
      bbPts2: 0,
      forfeit: false,
      lightningPts1: 0,
      lightningPts2: 0,
      notes: m.notes ?? '',
      otNeg1: otCount(a, (v) => v < 0),
      otNeg2: otCount(b, (v) => v < 0),
      otPwr1: otCount(a, (v) => v > 10),
      otPwr2: otCount(b, (v) => v > 10),
      otTen1: otCount(a, (v) => v === 10),
      otTen2: otCount(b, (v) => v === 10),
      ottu: ot.tossups,
      phases: [],
      players1: line(a),
      players2: line(b),
      round: m.round,
      score1: a.points,
      score2: b.points,
      team1: a.name,
      team2: b.name,
      tiebreaker: false,
      tuhtot: m.tossupsRead,
      validationMsg: '',
      invalid: false,
    };
  });

  return { metadata: { version: YF3_VERSION }, packets: {}, settings, divisions: {}, teams, games };
}

/** The YF 3 .yft file bytes: the six sections, one JSON value per line. */
export function serializeYft3(opts) {
  const f = buildYft3(opts);
  return [f.metadata, f.packets, f.settings, f.divisions, f.teams, f.games]
    .map((section) => JSON.stringify(section)).join('\n');
}
