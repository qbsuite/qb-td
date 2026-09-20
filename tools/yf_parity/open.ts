// File -> Open, the way YellowFruit's TournamentManager.parseYftFile does
// it, then save again and write YF's stat report from what it loaded.
// A file YF is content with comes back out unchanged. (`yf/` is aliased to
// the YellowFruit checkout — see import.ts.)
//
// argv: <in .yft> <out .yft> <YF version>
import fs from 'node:fs';
import dayjs from 'dayjs';
import FileParser from 'yf/DataModel/FileParsing';
import { collectRefTargets, findTournamentObject } from 'yf/DataModel/QbjUtils2';
import { snakeCaseToCamelCase, camelCaseToSnakeCase, earlyYftFileConversions } from 'yf/DataModel/CaseConversion';

const [, , inFile, outFile, yfVersion] = process.argv;
const isDate = (k: string) => ['startDate', 'endDate', 'start_date', 'end_date', 'savedAtTime'].includes(k);
const obj = JSON.parse(fs.readFileSync(inFile, 'utf8'), (k, v) => (isDate(k) ? dayjs(v).toDate() : v));
earlyYftFileConversions(obj);
snakeCaseToCamelCase(obj);
const parser = new FileParser(collectRefTargets(obj.objects));
const tourn = parser.parseYftTournament(findTournamentObject(obj.objects) as any, yfVersion)!;
tourn.conversions();
tourn.appVersion = yfVersion;

const whole: any = { version: '2.1.1', objects: [tourn.toFileObject(false, true)] };
camelCaseToSnakeCase(whole);
fs.writeFileSync(outFile, JSON.stringify(whole, (k, v) => {
  if (isDate(k)) return v ? dayjs(v).toISOString() : undefined;
  return v;
}));

tourn.compileStats(true);
const g = tourn.htmlGenerator;
g.setFilePrefix(process.env.YF_REPORT_PREFIX || undefined); // as when saving the report to disk
const pages: Record<string, string> = {
  standings: g.generateStandingsPage(), individuals: g.generateIndividualsPage(),
  games: g.generateScoreboardPage(), teamdetail: g.generateTeamDetailPage(),
  playerdetail: g.generatePlayerDetailPage(), rounds: g.generateRoundReportPage(),
};
for (const [k, v] of Object.entries(pages)) fs.writeFileSync(outFile.replace(/\.yft$/, `_${k}.html`), v);
