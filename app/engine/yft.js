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

import { rosterTracking } from './qbj.js';

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
export function schoolAndLetter(teamName) {
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

// The three below are shared with report.js: the stat report shows the same
// tossup-value columns, lists games in the same order, and anchors each box
// score by its match id.

/** Round by round, and within a round in upload order (the dashboard hands
 *  games over newest first): the order a TD would import them in, which is
 *  the order YF numbers and lists them. */
export function importOrder(matches) {
  return [...matches].sort((a, b) => a.round - b.round || (a.fileId ?? 0) - (b.fileId ?? 0));
}

/** A match's YF id, given its place in importOrder. */
export function matchId(m, index) {
  return `Match_${FIRST_MATCH_ID + index}~${abbrName(m.teams[0].name)}${abbrName(m.teams[1].name)}`;
}

// Overtime. The reader's file folds it into tossups_read, which YF reads
// as an over-long regulation and refuses; YF wants the overtime tossups
// counted apart, and each team's overtime buzzes listed (they earn no
// bonus, so they come out of bonuses heard). Which buzzes were overtime
// comes from the per-tossup record; without one the tossups are still
// split, and the buzzes are left for the TD to enter.
//
// `regulation` is the tournament's own regulation tossup count, from its
// MODAQ game format (read_core.js effectiveFormat) — NOT a constant. Get
// it wrong and every game of a 22-tossup event reports two tossups of
// overtime that were never played, which moves regulation points, TUH and
// bonuses heard on every page of the stat report. The fallback is YF's
// own default, for a caller with no format to hand over.
export const REGULATION_TOSSUPS = 20;
export function overtimeOf(m, regulation = REGULATION_TOSSUPS) {
  const tossups = Math.max(0, m.tossupsRead - regulation);
  const late = tossups && m.tossupBuzzes ? m.tossupBuzzes.slice(regulation).flat() : [];
  return {
    tossups,
    count: (team, v) => late.filter((b) => b.team === team && b.value === v).length,
  };
}

/** The values a MODAQ game format scores: its powers, a plain ten, and its
 *  neg (PACE negs zero, which is no answer type at all). */
export function formatValues(rules) {
  const vals = new Set([10]);
  for (const p of (rules && rules.powers) || []) if (p && p.points) vals.add(p.points);
  if (rules && rules.negValue) vals.add(rules.negValue);
  return vals;
}

/** The tournament's answer types: a standard rule set's when the values fit
 *  one, else the values in play (YF sortAnswerTypes order), with a bare 10
 *  as the fallback so the file always validates.
 *
 *  `rules` is the tournament's MODAQ format. Its values are unioned with
 *  the ones actually scored rather than replacing them: the format alone
 *  would drop a value some room really did score (and YF rejects a file
 *  whose games reference an answer type it has no column for), while the
 *  games alone silently lose the power column from an event where nobody
 *  happened to power. */
export function answerTypes(matches, rules) {
  const seen = new Set();
  for (const m of matches) for (const t of m.teams) for (const p of t.players)
    for (const c of p.counts) if (c.n) seen.add(c.value);
  if (rules) for (const v of formatValues(rules)) seen.add(v);
  seen.delete(0); // a zero-point buzz is not an answer type
  const ruleSet = RULE_SETS.find((rs) => [...seen].every((v) => rs.values.includes(v)));
  if (!ruleSet && ![...seen].some((v) => v > 0)) seen.add(10);
  return { ruleSet, values: ruleSet ? ruleSet.values : [...seen].sort((a, b) => b - a) };
}

/** YF's own Acf/AcfPowers presets, field for field (ScoringRules.applyRuleSet):
 *  20 regulation tossups, one overtime tossup minimum, bonuses on, no
 *  bouncebacks, no overtime bonuses. A tournament that differs in ANY of
 *  them is not that rule set, whatever its tossup values look like, so it
 *  goes out with no standardRuleSet label — YF then shows "Custom", which
 *  is the truth. Stamping the label on a 22-tossup event would leave the
 *  file saying mACF while holding rules mACF does not have, and re-picking
 *  the preset in YF would silently snap the count back to 20. */
function standardRuleSetKey(ruleSet, rules, useBonuses) {
  if (!ruleSet || !useBonuses) return undefined;
  const matches = (rules.regulationTossupCount ?? REGULATION_TOSSUPS) === 20
    && (rules.minimumOvertimeQuestionCount ?? 1) === 1
    && !rules.bonusesBounceBack && !rules.overtimeIncludesBonuses;
  return matches ? ruleSet.key : undefined;
}

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

/* ---------- stages from the schedule ----------
   With a saved schedule of more than one stage (pools, then playoff
   brackets, then finals), the file carries YF's own stages: a Prelim
   stage with the schedule's pools, a Playoff stage per later stage with
   one pool per bracket, and Finals / Tiebreaker stages without pools. YF
   then ranks each pool on its own, the way it does for a schedule built
   in YF. A bracket carries over its pool-mates' earlier games
   (hasCarryover) exactly when the schedule leaves some pool-mates' pair
   unplayed in it; a bracket that replays them all (a 4-team bracket with
   the pool-mates' game played again) carries nothing, and neither does
   an elimination bracket. Carried games are
   marked the way YF marks them (Tournament.carryOverMatches).

   Anything the schedule can't place cleanly — no schedule, one stage,
   slots not filled yet, a game in a round the schedule doesn't have, a
   team in two pools of a stage, a game between pools — keeps the single
   stage and pool below, as before. So a round robin, double or triple
   included, is unchanged. */

const MINOR = { final: 'Finals', tiebreak: 'Tiebreaker' };

export function yfStages(schedule, matches) {
  if (!schedule || !Array.isArray(schedule.phases)) return null;
  const nameOf = (x) => (x && typeof x.team === 'string' ? x.team : null);
  const brackets = schedule.brackets || [];
  const stages = [];
  for (const [p, ph] of schedule.phases.entries()) {
    const type = MINOR[ph.kind] || (stages.some((x) => x.full) ? 'Playoff' : 'Prelim');
    const rounds = (ph.rounds || []).map((r) => r.round);
    let pools = [];
    if (!MINOR[ph.kind]) {
      if (type === 'Prelim' && schedule.pools && Object.keys(schedule.pools).length) {
        pools = Object.entries(schedule.pools).map(([k, teams]) => ({
          key: k, name: (brackets.find((b) => b.key === k && b.phase === p) || {}).name || 'Pool ' + k, teams: [...teams] }));
      } else {
        const by = new Map();
        for (const r of ph.rounds || []) for (const g of r.games || []) {
          for (const t of [nameOf(g.a), nameOf(g.b)]) {
            if (!t) continue;
            if (!by.has(g.bracket)) by.set(g.bracket, []);
            if (!by.get(g.bracket).includes(t)) by.get(g.bracket).push(t);
          }
        }
        pools = [...by.entries()].map(([k, teams]) => ({
          key: k, name: (brackets.find((b) => b.key === k) || {}).name || ph.name, teams }));
      }
    }
    stages.push({ name: ph.name, type, full: !MINOR[ph.kind], elim: ph.kind === 'single' || ph.kind === 'double',
      meet: ph.meet || 1, rounds, pools, carry: false });
  }
  // A stage nobody has played yet is left out (its slots may not be
  // filled); a pool stage with games needs all its slots filled, or its
  // brackets aren't known
  const playedRounds = new Set(matches.map((m) => m.round));
  for (const [p, ph] of schedule.phases.entries()) {
    if (!stages[p].rounds.some((n) => playedRounds.has(n))) { stages[p].unplayed = true; continue; }
    // (finals and tiebreakers have no pools: their slots may stay as written)
    const open = stages[p].full && (ph.rounds || []).some((r) => (r.games || []).some((g) => (g.a && !nameOf(g.a)) || (g.b && !nameOf(g.b))));
    if (open) return null;
  }
  const full = stages.filter((x) => x.full && !x.unplayed);
  if (full.length < 2 && !(full.length === 1 && full[0].pools.length > 1)) return null;

  // each game in the stage holding its round, between two teams of one pool
  const stageOf = new Map(stages.flatMap((x) => x.rounds.map((n) => [n, x])));
  const placed = new Map(); // match -> stage
  for (const m of matches) {
    const st = stageOf.get(m.round);
    if (!st) return null;
    if (st.full) {
      const [a, b] = m.teams.map((t) => t.name);
      if (!st.pools.some((pl) => pl.teams.includes(a) && pl.teams.includes(b))) return null;
    }
    placed.set(m, st);
  }
  for (const st of full) {
    const seen = new Set();
    for (const pl of st.pools) for (const t of pl.teams) { if (seen.has(t)) return null; seen.add(t); }
  }
  // names are ids in the file (Phase_<name>, Pool_<name>): unique
  if (new Set(stages.map((x) => x.name)).size !== stages.length) return null;
  const poolNames = full.flatMap((x) => x.pools.map((pl) => pl.name));
  if (new Set(poolNames).size !== poolNames.length) return null;

  // carryover: a bracket some of whose pool-mates' pairs it doesn't play
  const key = (x, y) => [x, y].sort().join('\n');
  for (const [i, st] of full.entries()) {
    if (!i) continue;
    const prev = full[i - 1];
    const playedHere = new Set([...placed].filter(([, s]) => s === st).map(([m]) => key(m.teams[0].name, m.teams[1].name)));
    const scheduledHere = new Set(schedule.phases.flatMap((ph) => ph.name === st.name ? ph.rounds.flatMap((r) => r.games.map((g) => key(nameOf(g.a), nameOf(g.b)))) : []));
    for (const pl of st.pools) {
      const mates = [];
      for (let x = 0; x < pl.teams.length; x++) for (let y = x + 1; y < pl.teams.length; y++) {
        if (prev.pools.some((pp) => pp.teams.includes(pl.teams[x]) && pp.teams.includes(pl.teams[y]))) mates.push(key(pl.teams[x], pl.teams[y]));
      }
      // an elimination bracket is its own games only: nothing carries
      pl.carry = !st.elim && mates.some((k) => !scheduledHere.has(k) && !playedHere.has(k));
    }
    st.carry = st.pools.some((pl) => pl.carry);
  }
  return { stages, placed };
}

// The stages as YF writes them (Phase/Pool toFileObject): a stage needs at
// least one round, so stages not played yet are left out. Codes as YF's
// recomputePhaseCodes gives them: 1, 2, … and "<n>T" for a tiebreaker.
function yfPhases(plan, roundNumbers, roundOf) {
  const out = [];
  let code = 1;
  for (const st of plan.stages) {
    const rounds = st.rounds.filter((n) => roundNumbers.includes(n)).sort((a, b) => a - b);
    if (!rounds.length) continue;
    const minor = !st.full;
    out.push({
      YfData: {
        phaseType: st.type, code: st.type === 'Tiebreaker' ? `${code}T` : String(code++),
        wildCardAdvancementRules: [], wildCardRankingMethod: 'RankThenPPB',
        // finals and tiebreakers keep their round numbers
        ...(minor ? { forceNumericRounds: true } : {}),
      },
      name: st.name,
      rounds: rounds.map(roundOf),
      pools: minor ? [] : st.pools.map((pl, i) => ({
        YfData: { size: pl.teams.length, roundRobins: st.meet, seeds: [], hasCarryover: pl.carry, autoAdvanceRules: [] },
        name: pl.name,
        position: i + 1,
        poolTeams: pl.teams.map((t) => ({ YfData: {}, team: ref(`Team_${t}`) })),
      })),
      id: `Phase_${st.name}`,
    });
  }
  return out;
}

/**
 * Build the .yft file object.
 * @param opts {name, questionSet, startDate, endDate, matches, roster,
 *   settings, schedule} — schedule, the saved one, gives the file its
 *   stages (yfStages above) — matches from qbj.parseMatch, roster from qbj.parseRoster
 *   (falls back to teams/players observed in matches). settings is the
 *   tournament's effective MODAQ game format (read_core.js
 *   effectiveFormat) — regulationTossupCount, powers, negValue,
 *   minimumOvertimeQuestionCount, overtimeIncludesBonuses,
 *   bonusesBounceBack — and may carry the YfData tracking flags
 *   (trackPlayerYear etc.) alongside. Everything YF's scoring rules hold
 *   that MODAQ's format does not (max players, max bonus score, lightning)
 *   stays at YF's own defaults.
 * @returns the whole-file object; JSON.stringify it for the .yft bytes.
 */
export function buildYft(opts) {
  const settings = opts.settings || {};
  // UG / D2: tracked as the roster says unless the caller says otherwise
  const tracked = rosterTracking(opts.roster);
  const trackUG = settings.trackUG ?? tracked.trackUG;
  const trackDiv2 = settings.trackDiv2 ?? tracked.trackDiv2;
  if (!opts.matches || !opts.matches.length) throw new Error('No matches to export');
  const matches = importOrder(opts.matches);

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
    roster = roster.map((r) => ({ ...r, players: [...r.players] }));
    const byTeam = new Map(roster.map((r) => [r.name, r]));
    for (const m of matches) for (const t of m.teams) {
      let entry = byTeam.get(t.name);
      if (!entry) { byTeam.set(t.name, (entry = { name: t.name, players: [] })); roster.push(entry); }
      for (const p of t.players) if (!entry.players.includes(p.name)) entry.players.push(p.name);
    }
  }

  const { ruleSet, values } = answerTypes(matches, settings);
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
      YfData: { letter, isJV: false, isUG: !!(trackUG && r.ug), isD2: !!(trackDiv2 && r.d2) },
      name: r.name,
      players: r.players.map((pn) => {
        const id = `Player_${pn}_${playerNo++}`;
        playerIds.set(r.name + '\n' + pn, id);
        const mk = (r.marks || {})[pn] || {};
        return { YfData: { yearString: '', isUG: !!(trackUG && mk.ug), isD2: !!(trackDiv2 && mk.d2) }, name: pn, id };
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
  const matchIds = new Map(matches.map((m, i) => [m, matchId(m, i)]));

  const regulation = settings.regulationTossupCount ?? REGULATION_TOSSUPS;
  // the schedule's stages, when it has them cleanly (yfStages)
  const plan = yfStages(opts.schedule, matches);
  const carriedTo = new Map(); // match -> [stage names it also counts in]
  if (plan) {
    // Tournament.carryOverMatches: for each pair sharing a carryover pool,
    // the first game they played in an earlier stage where they shared a
    // pool, looking back while those stages carry over too
    const full = plan.stages.filter((x) => x.full && !x.unplayed);
    const inStage = (st) => matches.filter((m) => plan.placed.get(m) === st);
    const samePool = (st, x, y) => st.pools.some((pl) => pl.teams.includes(x) && pl.teams.includes(y));
    for (const [i, st] of full.entries()) {
      if (!i || !st.carry) continue;
      for (const pl of st.pools.filter((x) => x.carry)) {
        for (let x = 0; x < pl.teams.length - 1; x++) for (let y = x + 1; y < pl.teams.length; y++) {
          const [a, b] = [pl.teams[x], pl.teams[y]];
          for (let j = i - 1; j >= 0; j--) {
            const past = full[j];
            if (samePool(past, a, b)) {
              const m = inStage(past).find((g) => g.teams.some((t) => t.name === a) && g.teams.some((t) => t.name === b));
              if (m && !(carriedTo.get(m) || []).includes(st.name)) carriedTo.set(m, [...(carriedTo.get(m) || []), st.name]);
            }
            if (!past.carry) break;
          }
        }
      }
    }
  }
  const roundOf = (n) => ({
    YfData: { number: n },
    name: String(n), // YF Round.name is number.toString() unless non-numeric
    matches: matches.filter((m) => m.round === n).map((m) => [m, overtimeOf(m, regulation)]).map(([m, ot]) => ({
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
      carryoverPhases: (carriedTo.get(m) || []).map((name) => ref(`Phase_${name}`)),
      packets: m.packets,
      notes: m.notes,
    })),
  });
  const rounds = roundNumbers.map(roundOf);

  // ScoringRules like YF's toFileObject (yft mode) with standard defaults.
  const anyMod5 = values.some((v) => v % 10 !== 0);
  // Keys in the order YF's saved file has them (its snake_case pass moves
  // each renamed key to the end, in its own rename order) — no reader
  // cares, but it keeps the file byte-comparable with YF's.
  const scoringRules = {
    YfData: { timed: false },
    name: '',
    maximumPlayersPerTeam: settings.maximumPlayersPerTeam ?? 4,
    maximumRegulationTossupCount: regulation,
    minimumOvertimeQuestionCount: settings.minimumOvertimeQuestionCount ?? 1,
    overtimeIncludesBonuses: settings.overtimeIncludesBonuses ?? false,
    totalDivisor: values.some((v) => v % 5 !== 0) ? 1 : (anyMod5 ? 5 : 10),
    ...(useBonuses ? {
      maximumBonusScore: settings.maximumBonusScore ?? 30,
      bonusDivisor: 10,
      minimumPartsPerBonus: 3,
      maximumPartsPerBonus: 3,
      pointsPerBonusPart: 10,
      bonusesBounceBack: settings.bonusesBounceBack ?? false,
    } : {}),
    lightningCountPerTeam: 0,
    answerTypes: values.map((v) => ({ value: v, id: answerTypeId(v) })),
  };

  const tournament = {
    YfData: {
      YfVersion: YF_VERSION,
      standardRuleSet: standardRuleSetKey(ruleSet, settings, useBonuses),
      seeds: allTeamRefs,
      trackPlayerYear: settings.trackPlayerYear ?? false,
      trackSmallSchool: settings.trackSmallSchool ?? false,
      trackJV: settings.trackJV ?? false,
      trackUG,
      trackDiv2,
      finalRankingsReady: false,
      usingScheduleTemplate: false,
    },
    name: opts.name || 'Tournament',
    startDate: opts.startDate || undefined,
    endDate: opts.endDate || undefined,
    questionSet: opts.questionSet || undefined,
    registrations,
    // The schedule's stages when it has them (yfStages); else one stage,
    // one pool with every team in it, as YF's "custom schedule" starts
    // out. YF compiles standings per pool: no pool, no standings.
    phases: plan ? yfPhases(plan, roundNumbers, roundOf) : [{
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
