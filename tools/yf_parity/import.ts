// Drive YellowFruit's own data model the way a TD drives the app:
//   new tournament -> pick the rule set -> import teams from the roster
//   qbj -> custom schedule (one stage, one pool, N rounds) -> import every
//   game file -> accept the import -> save.
// Mirrors TournamentManager.importQbjTeams / importMatchesFromQbj /
// MatchImportResultsManager.finishImport / generateWholeFileObj, minus the
// Electron plumbing. `yf/` is YellowFruit's src/renderer, aliased by
// tools/yf_parity.mjs to the checkout it keeps under .cache/ — none of
// YellowFruit's code (AGPL-3.0) lives in this repo.
//
// argv: <in dir> <out .yft>. The in dir holds config.json, roster.qbj and
// games/*. Writes the .yft, YF's six report pages beside it, and a .json
// log of what the import dialog would have shown for each file.
import fs from 'node:fs';
import dayjs from 'dayjs';
import Tournament from 'yf/DataModel/Tournament';
import FileParser from 'yf/DataModel/FileParsing';
import MatchImportResult, { ImportResultStatus } from 'yf/DataModel/MatchImportResult';
import { StatsValidity } from 'yf/DataModel/Match';
import { collectRefTargets } from 'yf/DataModel/QbjUtils2';
import { snakeCaseToCamelCase, camelCaseToSnakeCase } from 'yf/DataModel/CaseConversion';
import { CommonRuleSets } from 'yf/DataModel/ScoringRules';

const [, , inDir, outFile] = process.argv;
const cfg = JSON.parse(fs.readFileSync(`${inDir}/config.json`, 'utf8'));

const tourn = new Tournament(cfg.name);
tourn.appVersion = cfg.yfVersion;
if (cfg.ruleSet) tourn.applyRuleSet(cfg.ruleSet as CommonRuleSets);
tourn.trackPlayerYear = false; // a new-tournament checkbox; qb-td has no years

// --- teams (importQbjTeams)
const rosterFile = JSON.parse(fs.readFileSync(`${inDir}/roster.qbj`, 'utf8'));
snakeCaseToCamelCase(rosterFile);
const regParser = new FileParser(collectRefTargets(rosterFile.objects), tourn);
regParser.buildTypesByIdArrays(rosterFile.objects);
const skippedRegistrations: string[] = [];
for (const reg of FileParser.findRegistrations(rosterFile.objects)) {
  const parsed = regParser.parseRegistration(reg as any);
  if (!parsed) { skippedRegistrations.push((reg as any).name); continue; }
  parsed.computeLettersAndRegName();
  const existing = tourn.findRegistration(parsed.name);
  if (existing) {
    for (const team of parsed.teams) if (!tourn.findTeamByName(team.name)) existing.addTeam(team);
    tourn.seedTeamsInRegistration(existing);
  } else {
    tourn.addRegistration(parsed);
  }
}

// --- schedule: custom, one stage holding every round. A TD can rename the
// stage and its pool; qb-td's file names both.
tourn.startNewCustomSchedule();
const phase = tourn.phases[0];
phase.setRoundRange(1, cfg.rounds);
phase.name = cfg.phaseName;
phase.pools[0].name = cfg.poolName;

// --- games (importMatchesFromQbj, the single-match branch), in the order
// the files were picked in the import dialog
const results: MatchImportResult[] = [];
for (const f of cfg.files as string[]) {
  const obj = JSON.parse(fs.readFileSync(`${inDir}/games/${f}`, 'utf8'));
  snakeCaseToCamelCase(obj);
  const res = new MatchImportResult(f);
  results.push(res);
  const round = tourn.getRoundObjByNumber(obj._round);
  if (!round) { res.markFatal("Couldn't determine a round for the game in this file"); continue; }
  const ph = tourn.findPhaseByRound(round)!;
  res.phase = ph;
  res.round = round;
  const parser = new FileParser({}, tourn);
  parser.importPhase = ph;
  try {
    const m = parser.parseMatch(obj);
    if (m) {
      // YF's importer has no way to see overtime in a MODAQ file (it folds
      // overtime into tossups_read) and rejects the game as over-long. The
      // TD's fix is the game form's overtime fields: tossups read in
      // overtime, and each team's overtime buzzes.
      const ot = cfg.overtime?.[f];
      if (ot) {
        m.overtimeTossupsRead = ot.tossups;
        for (const mt of [m.leftTeam, m.rightTeam]) {
          for (const at of tourn.scoringRules.answerTypes) {
            mt.setOvertimeAnswerCount(at, ot.buzzes?.[mt.team?.name ?? '']?.[at.value] ?? 0);
          }
        }
        m.validateAll(tourn.scoringRules);
        m.determineStatsValidity();
      }
      Tournament.validateHaveTeamsPlayedInRound(m, round, ph, false);
      res.evaluateMatch(m);
    }
  } catch (err: any) {
    res.markFatal(err.message);
  }
}
MatchImportResult.validateImportSetForTeamDups(results);
tourn.setMatchIdCounter();

// --- accept (MatchImportResultsManager.finishImport)
for (const res of results) {
  if (!(res.proceedWithImport && res.match)) continue;
  if (res.status === ImportResultStatus.ErrNonFatal) res.match.statsValidity = StatsValidity.omit;
  res.match.importedFile = res.filePath;
  Tournament.validateHaveTeamsPlayedInRound(res.match, res.round, res.phase, false);
  res.round!.addMatch(res.match);
}

// --- save (generateWholeFileObj + makeJSON)
const isDate = (k: string) => ['startDate', 'endDate', 'start_date', 'end_date'].includes(k);
const whole: any = { version: '2.1.1', objects: [tourn.toFileObject(false, true)] };
camelCaseToSnakeCase(whole);
fs.writeFileSync(outFile, JSON.stringify(whole, (k, v) => {
  if (isDate(k)) return v ? dayjs(v).toISOString() : undefined;
  return v;
}));

// --- YF's own stat report off the same tournament
tourn.compileStats(true);
const g = tourn.htmlGenerator;
g.setFilePrefix(process.env.YF_REPORT_PREFIX || undefined); // as when saving the report to disk
const pages: Record<string, string> = {
  standings: g.generateStandingsPage(), individuals: g.generateIndividualsPage(),
  games: g.generateScoreboardPage(), teamdetail: g.generateTeamDetailPage(),
  playerdetail: g.generatePlayerDetailPage(), rounds: g.generateRoundReportPage(),
};
for (const [k, v] of Object.entries(pages)) fs.writeFileSync(outFile.replace(/\.yft$/, `_${k}.html`), v);

fs.writeFileSync(outFile.replace(/\.yft$/, '.json'), JSON.stringify({
  skippedRegistrations,
  files: results.map((r) => ({
    file: r.filePath, status: ImportResultStatus[r.status], imported: r.proceedWithImport && !!r.match,
    messages: r.messages,
  })),
}, null, 1));
