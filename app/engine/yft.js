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

const YF_VERSION = '4.0.18';

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
  const { matches } = opts;
  const settings = opts.settings || {};
  if (!matches || !matches.length) throw new Error('No matches to export');

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
  if (![...valueSet].some((v) => v > 0)) valueSet.add(10);
  const values = [...valueSet].sort((a, b) => b - a); // YF sortAnswerTypes order
  const answerTypeId = (v) => `AnswerType_${v}`;

  const useBonuses = settings.useBonuses ?? matches.some((m) => m.teams.some((t) => t.bonusPoints > 0));

  // Registrations: one per team (registration name == team name, no letter),
  // players numbered globally like YF's Player idNumber.
  let playerNo = 0;
  const playerIds = new Map(); // team + '\n' + player -> id
  const registrations = roster.map((r) => ({
    YfData: { isSmallSchool: false },
    name: r.name,
    teams: [{
      YfData: { letter: '', isJV: false, isUG: false, isD2: false },
      name: r.name,
      id: `Team_${r.name}`, // parseSeedList re-derives ids from names; must match
      players: r.players.map((pn) => {
        const id = `Player_${pn}_${playerNo++}`;
        playerIds.set(r.name + '\n' + pn, id);
        return { YfData: { yearString: '' }, name: pn, id };
      }),
    }],
  }));

  // One prelim phase holding every round that has at least one match.
  const roundNumbers = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  let matchNo = 0;
  const rounds = roundNumbers.map((n) => ({
    YfData: { number: n },
    name: String(n), // YF Round.name is number.toString() unless non-numeric
    id: `Round_${n}`,
    matches: matches.filter((m) => m.round === n).map((m) => ({
      id: `Match_${matchNo++}`,
      matchTeams: m.teams.map((t) => ({
        team: ref(`Team_${t.name}`),
        forfeitLoss: false,
        points: t.points,
        correctTossupsWithoutBonuses: 0,
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
      tossupsRead: m.tossupsRead,
      tiebreaker: false,
      packets: m.packets,
      notes: m.notes,
    })),
  }));

  // ScoringRules like YF's toFileObject (yft mode) with standard defaults.
  const anyMod5 = values.some((v) => v % 10 !== 0);
  const scoringRules = {
    YfData: { timed: false },
    name: '',
    answerTypes: values.map((v) => ({ value: v, id: answerTypeId(v) })),
    maximumRegulationTossupCount: settings.regulationTossupCount ?? 20,
    maximumPlayersPerTeam: settings.maximumPlayersPerTeam ?? 4,
    minimumOvertimeQuestionCount: 1,
    overtimeIncludesBonuses: false,
    lightningCountPerTeam: 0,
    totalDivisor: values.some((v) => v % 5 !== 0) ? 1 : (anyMod5 ? 5 : 10),
  };
  if (useBonuses) {
    scoringRules.bonusesBounceBack = false;
    scoringRules.maximumBonusScore = settings.maximumBonusScore ?? 30;
    scoringRules.minimumPartsPerBonus = 3;
    scoringRules.maximumPartsPerBonus = 3;
    scoringRules.pointsPerBonusPart = 10;
    scoringRules.bonusDivisor = 10;
  }

  const allTeamRefs = roster.map((r) => ref(`Team_${r.name}`));

  const tournament = {
    YfData: {
      YfVersion: YF_VERSION,
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
    phases: [{
      YfData: { phaseType: 'Prelim', code: '1', wildCardAdvancementRules: [] },
      name: 'All Games',
      id: 'Phase_All Games',
      rounds,
      pools: [],
    }],
    rankings: [{ name: 'Overall', id: 'Ranking_Overall' }],
    scoringRules,
    type: 'Tournament',
    id: 'Tournament',
  };

  return toSnake({ version: '2.1.1', objects: [tournament] });
}

/** The .yft file bytes (YF writes compact JSON; we match). */
export function serializeYft(opts) {
  return JSON.stringify(buildYft(opts));
}
