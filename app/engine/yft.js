// yft.js — generate a YellowFruit .yft file from parsed matches + roster.
//
// Contract verified against YellowFruit v4.0.18 source (ANadig/YellowFruit,
// src/renderer/DataModel/): a .yft is {version: '2.1.1', objects:
// [Tournament]} where the Tournament and its sub-objects mirror YF's own
// toFileObject() output — camelCase built first, then key-renamed the same
// way YF's writer does (CaseConversion.ts camelCaseToSnakeCase, called from
// TournamentManager.generateWholeFileObj). This is an independent
// implementation of the file format (YF is AGPL-3.0; no YF code is copied
// here — see THIRD_PARTY_NOTICES.md); only the format facts below come from
// reading YF's source. Load-bearing details:
//   - YfData.YfVersion must be present and <= the reader's app version
//     (FileParsing.parseYftTournament). We stamp 4.0.18: generated files
//     need YF >= 4.0.18. Do not lower it — older stamps trigger YF's
//     data-upgrade transforms (e.g. lightning_points fixups).
//   - $ref strings must equal ids elsewhere in the file, and team ids must
//     be exactly `Team_{name}` (parseSeedList re-derives them from names).
//   - scoringRules.answerTypes needs >= 1 positive value; every Match needs
//     exactly two matchTeams; every Phase needs a name and >= 1 round.
//   - YF ignores question-level data (Tournament.useQuestionLevelData is
//     hard-coded false), so matchQuestions are omitted entirely.
//   - Teams must sit in a pool: YF builds its standings pool by pool, so a
//     phase with `pools: []` opens to an empty Team Standings page.
//
// The target is the file YF itself saves after a TD imports the same
// roster and game files into a custom one-stage schedule — field for
// field, ids included. tools/yf_parity.mjs runs YF's own import and save
// code against this output and fails on any difference; run it after
// every change here.

const YF_VERSION = '4.0.18';

// The stage and its pool, where YF would say "New Stage" / "New Pool".
export const PHASE_NAME = 'All Games';
export const POOL_NAME = 'All Teams';

// YF numbers players and matches from these (Player.idCounter, and
// Match.idCounter as it stands when the first game is imported).
const FIRST_PLAYER_ID = 1000;
const FIRST_MATCH_ID = 1001;

// Team.getLinkIdAbbrName for a team with no letter: the name's word
// characters, cut to 20.
const abbrName = (name) => String(name).replace(/\W/g, '').substring(0, 20);

// GeneralUtils.teamGetNameAndLetter: "Penn B" is school "Penn", letter "B";
// a name not ending in space + one A-Z letter is its own school.
function schoolAndLetter(teamName) {
  const m = /^(.*) ([A-Za-z])$/.exec(teamName);
  return m ? [m[1].trim(), m[2].toUpperCase()] : [teamName, ''];
}

// YF's standard rule sets, by the tossup values they score. A tournament
// whose observed values fit one is written as that rule set, the way a TD
// would have picked it (so a 15/10/-5 event where nobody negged still gets
// its -5 column).
const RULE_SETS = [
  { key: 'Acf', values: [10, -5] },
  { key: 'mAcfPowers', values: [15, 10, -5] },
];

// The fixed set of keys YF's CaseConversion.ts snake_cases — format facts
// required for compatibility (the names follow the qbj tournament-schema
// conventions). Unlisted keys, including everything inside YfData, keep
// their spelling.
const SNAKE = {
  shortName: 'short_name', tournamentSite: 'tournament_site',
  scoringRules: 'scoring_rules', startDate: 'start_date', endDate: 'end_date',
  questionSet: 'question_set', teamsPerMatch: 'teams_per_match',
  maximumPlayersPerTeam: 'maximum_players_per_team',
  regulationTossupCount: 'regulation_tossup_count',
  maximumRegulationTossupCount: 'maximum_regulation_tossup_count',
  minimumOvertimeQuestionCount: 'minimum_overtime_question_count',
  overtimeIncludesBonuses: 'overtime_includes_bonuses',
  totalDivisor: 'total_divisor', maximumBonusScore: 'maximum_bonus_score',
  bonusDivisor: 'bonus_divisor', minimumPartsPerBonus: 'minimum_parts_per_bonus',
  maximumPartsPerBonus: 'maximum_parts_per_bonus',
  pointsPerBonusPart: 'points_per_bonus_part',
  bonusesBounceBack: 'bonuses_bounce_back',
  lightningCountPerTeam: 'lightning_count_per_team',
  maximumLightningScore: 'maximum_lightning_score',
  lightningDivisor: 'lightning_divisor',
  lightningsBounceBack: 'lightnings_bounce_back',
  answerTypes: 'answer_types', shortLabel: 'short_label',
  awardsBonus: 'awards_bonus', cardsTraded: 'cards_traded',
  poolTeams: 'pool_teams', tossupsRead: 'tossups_read',
  overtimeTossupsRead: 'overtime_tossups_read', matchTeams: 'match_teams',
  carryoverPhases: 'carryover_phases', matchQuestions: 'match_questions',
  questionNumber: 'question_number', tossupQuestion: 'tossup_question',
  bonusPoints: 'bonus_points', buzzPosition: 'buzz_position',
  wordIndex: 'word_index', forfeitLoss: 'forfeit_loss',
  correctTossupsWithoutBonuses: 'correct_tossups_without_bonuses',
  bonusBouncebackPoints: 'bonus_bounceback_points',
  lightningPoints: 'lightning_points',
  lightningBouncebackPoints: 'lightning_bounceback_points',
  matchPlayers: 'match_players', suppressFromStatistics: 'suppress_from_statistics',
  tossupsHeard: 'tossups_heard', answerCounts: 'answer_counts',
  answerType: 'answer_type', firstQuestion: 'first_question',
  externalId: 'external_id', categoryGroup: 'category_group',
};

function toSnake(node) {
  if (Array.isArray(node)) return node.map(toSnake);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined) continue;
    out[SNAKE[k] || k] = toSnake(v);
  }
  return out;
}

const ref = ($ref) => ({ $ref });

/**
 * Build the .yft file object.
 * @param opts {name, questionSet, startDate, endDate, matches, roster,
 *   settings} — matches from qbj.parseMatch, roster from qbj.parseRoster
 *   (falls back to teams/players observed in matches). settings may carry
 *   the YfData tracking flags (trackPlayerYear etc.).
 * @returns the whole-file object; JSON.stringify it for the .yft bytes.
 */
export function buildYft(opts) {
  const settings = opts.settings || {};
  if (!opts.matches || !opts.matches.length) throw new Error('No matches to export');
  // Round by round, and within a round in upload order (the dashboard
  // hands them over newest first): the order a TD would import them in,
  // which is the order YF numbers and lists them.
  const matches = [...opts.matches].sort((a, b) => a.round - b.round || (a.fileId ?? 0) - (b.fileId ?? 0));

  // Roster: given, else derived from matches (union of observed lineups).
  let roster = opts.roster;
  if (!roster || !roster.length) {
    const byTeam = new Map();
    for (const m of matches) for (const t of m.teams) {
      let entry = byTeam.get(t.name);
      if (!entry) byTeam.set(t.name, (entry = { name: t.name, players: [] }));
      for (const p of t.players) if (!entry.players.includes(p.name)) entry.players.push(p.name);
    }
    roster = [...byTeam.values()].sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // matches may include teams/players a stale roster lacks — merge them in
    roster = roster.map((r) => ({ name: r.name, players: [...r.players] }));
    const byTeam = new Map(roster.map((r) => [r.name, r]));
    for (const m of matches) for (const t of m.teams) {
      let entry = byTeam.get(t.name);
      if (!entry) { byTeam.set(t.name, (entry = { name: t.name, players: [] })); roster.push(entry); }
      for (const p of t.players) if (!entry.players.includes(p.name)) entry.players.push(p.name);
    }
  }

  // Answer types: union of values seen in the data (positive desc, then
  // negs), with a bare 10 as the fallback so the file always validates.
  const valueSet = new Set();
  for (const m of matches) for (const t of m.teams) for (const p of t.players)
    for (const c of p.counts) valueSet.add(c.value);
  valueSet.delete(0); // a zero-point buzz is not an answer type
  const ruleSet = RULE_SETS.find((rs) => [...valueSet].every((v) => rs.values.includes(v)));
  if (!ruleSet && ![...valueSet].some((v) => v > 0)) valueSet.add(10);
  const values = ruleSet ? ruleSet.values : [...valueSet].sort((a, b) => b - a); // YF sortAnswerTypes order
  const answerTypeId = (v) => `AnswerType_${v}`;

  const useBonuses = settings.useBonuses ?? matches.some((m) => m.teams.some((t) => t.bonusPoints > 0));

  // Registrations the way YF builds them on import: a team named
  // "<school> <letter>" joins its school's registration with that letter
  // (Registration.computeLettersAndRegName); any other team is its own.
  // Players are numbered in roster order like YF's Player idNumber. YF
  // keeps registrations sorted by name; the seed list keeps roster order.
  let playerNo = FIRST_PLAYER_ID;
  const playerIds = new Map(); // team + '\n' + player -> id
  const registrations = [];
  for (const r of roster) {
    const [school, letter] = schoolAndLetter(r.name);
    let reg = registrations.find((x) => x.name === school);
    if (!reg) registrations.push(reg = { YfData: { isSmallSchool: false }, name: school, teams: [] });
    reg.teams.push({
      YfData: { letter, isJV: false, isUG: false, isD2: false },
      name: r.name,
      players: r.players.map((pn) => {
        const id = `Player_${pn}_${playerNo++}`;
        playerIds.set(r.name + '\n' + pn, id);
        return { YfData: { yearString: '', isUG: false, isD2: false }, name: pn, id };
      }),
      ranks: [{ ranking: ref('Ranking_Overall') }],
      id: `Team_${r.name}`, // parseSeedList re-derives ids from names; must match
    });
  }
  const allTeamRefs = roster.map((r) => ref(`Team_${r.name}`));
  registrations.sort((a, b) => a.name.localeCompare(b.name));

  // One prelim phase holding every round that has at least one match.
  const roundNumbers = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  // Matches are numbered in that order, as YF numbers them on import.
  const matchIds = new Map(matches.map((m, i) =>
    [m, `Match_${FIRST_MATCH_ID + i}~${abbrName(m.teams[0].name)}${abbrName(m.teams[1].name)}`]));

  // Overtime. The reader's file folds it into tossups_read, which YF reads
  // as an over-long regulation and refuses; YF wants the overtime tossups
  // counted apart, and each team's overtime buzzes listed (they earn no
  // bonus, so they come out of bonuses heard). Which buzzes were overtime
  // comes from the per-tossup record; without one the tossups are still
  // split, and the buzzes are left for the TD to enter.
  const regulation = settings.regulationTossupCount ?? 20;
  const overtimeOf = (m) => {
    const tossups = Math.max(0, m.tossupsRead - regulation);
    const late = tossups && m.tossupBuzzes ? m.tossupBuzzes.slice(regulation).flat() : [];
    return {
      tossups,
      count: (team, v) => late.filter((b) => b.team === team && b.value === v).length,
    };
  };
  const rounds = roundNumbers.map((n) => ({
    YfData: { number: n },
    name: String(n), // YF Round.name is number.toString() unless non-numeric
    matches: matches.filter((m) => m.round === n).map((m) => [m, overtimeOf(m)]).map(([m, ot]) => ({
      YfData: { otherValidation: [], importedFile: m.filename },
      tiebreaker: false,
      id: matchIds.get(m),
      tossupsRead: m.tossupsRead,
      overtimeTossupsRead: ot.tossups || undefined,
      matchTeams: m.teams.map((t) => ({
        YfData: {
          overTimeBuzzes: values.map((v) => ({ number: ot.count(t.name, v), answerType: ref(answerTypeId(v)) })),
          validation: [],
        },
        team: ref(`Team_${t.name}`),
        points: t.points,
        forfeitLoss: false,
        correctTossupsWithoutBonuses: values.reduce((n, v) => n + (v > 0 ? ot.count(t.name, v) : 0), 0),
        matchPlayers: t.players.map((p) => ({
          player: ref(playerIds.get(t.name + '\n' + p.name)),
          tossupsHeard: p.tossupsHeard || 0,
          answerCounts: values.map((v) => ({
            number: p.counts.find((c) => c.value === v)?.n || 0,
            answerType: ref(answerTypeId(v)),
          })),
        })),
      })),
      carryoverPhases: [],
      packets: m.packets,
      notes: m.notes,
    })),
  }));

  // ScoringRules like YF's toFileObject (yft mode) with standard defaults.
  const anyMod5 = values.some((v) => v % 10 !== 0);
  // Keys in the order YF's saved file has them (its snake_case pass moves
  // each renamed key to the end, in its own rename order) — no reader
  // cares, but it keeps the file byte-comparable with YF's.
  const scoringRules = {
    YfData: { timed: false },
    name: '',
    maximumPlayersPerTeam: settings.maximumPlayersPerTeam ?? 4,
    maximumRegulationTossupCount: settings.regulationTossupCount ?? 20,
    minimumOvertimeQuestionCount: 1,
    overtimeIncludesBonuses: false,
    totalDivisor: values.some((v) => v % 5 !== 0) ? 1 : (anyMod5 ? 5 : 10),
    ...(useBonuses ? {
      maximumBonusScore: settings.maximumBonusScore ?? 30,
      bonusDivisor: 10,
      minimumPartsPerBonus: 3,
      maximumPartsPerBonus: 3,
      pointsPerBonusPart: 10,
      bonusesBounceBack: false,
    } : {}),
    lightningCountPerTeam: 0,
    answerTypes: values.map((v) => ({ value: v, id: answerTypeId(v) })),
  };

  const tournament = {
    YfData: {
      YfVersion: YF_VERSION,
      standardRuleSet: ruleSet ? ruleSet.key : undefined,
      seeds: allTeamRefs,
      trackPlayerYear: settings.trackPlayerYear ?? false,
      trackSmallSchool: settings.trackSmallSchool ?? false,
      trackJV: settings.trackJV ?? false,
      trackUG: settings.trackUG ?? false,
      trackDiv2: settings.trackDiv2 ?? false,
      finalRankingsReady: false,
      usingScheduleTemplate: false,
    },
    name: opts.name || 'Tournament',
    startDate: opts.startDate || undefined,
    endDate: opts.endDate || undefined,
    questionSet: opts.questionSet || undefined,
    registrations,
    // One stage, one pool with every team in it, as YF's "custom schedule"
    // starts out. YF compiles standings per pool: no pool, no standings.
    phases: [{
      YfData: {
        phaseType: 'Prelim', code: '1', wildCardAdvancementRules: [],
        wildCardRankingMethod: 'RankThenPPB',
      },
      name: PHASE_NAME,
      rounds,
      pools: [{
        YfData: {
          size: roster.length, roundRobins: 1, seeds: [],
          hasCarryover: false, autoAdvanceRules: [],
        },
        name: POOL_NAME,
        position: 1,
        poolTeams: allTeamRefs.map((team) => ({ YfData: {}, team })),
      }],
      id: `Phase_${PHASE_NAME}`,
    }],
    rankings: [{ name: 'Overall', id: 'Ranking_Overall' }],
    type: 'Tournament',
    scoringRules,
  };

  return toSnake({ version: '2.1.1', objects: [tournament] });
}

/** The .yft file bytes (YF writes compact JSON; we match). */
export function serializeYft(opts) {
  return JSON.stringify(buildYft(opts));
}
