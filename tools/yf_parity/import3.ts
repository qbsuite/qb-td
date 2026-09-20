// The YellowFruit 3 counterpart of import.ts: build a tournament the way a
// TD does in the 3.x app and save it, using YF 3.0.2's own code for the
// parts that are code — SingleGameQBJImport.importGame for each game file
// and GameVal.validateGame as MainInterface runs it on every game — and
// mirroring the parts that are UI: the settings pane, AddTeamModal +
// addTeam for each team (YF 3 has no roster .qbj import), writeJSON for
// the file. `yf3/` is YF 3.0.2's process/ts, aliased by tools/yf_parity.mjs
// to its checkout under .cache/.
//
// argv: <in dir> <out .yft>, the same in dir import.ts takes.
import fs from 'node:fs';
import { importGame } from 'yf3/SingleGameQBJImport';
import { validateGame } from 'yf3/GameVal';

const [, , inDir, outFile] = process.argv;
const cfg = JSON.parse(fs.readFileSync(`${inDir}/config.json`, 'utf8'));

// --- settings pane: DEFAULT_SETTINGS with the TD's scoring choices
const settings: any = {
  powers: cfg.yf3.powers, negs: cfg.yf3.negs, bonuses: true, bonusesBounce: false,
  lightning: false, playersPerTeam: 4, defaultPhases: [], rptConfig: 'YF Defaults',
};

// --- teams: AddTeamModal.handleAdd, then MainInterface.addTeam
const rosterFile = JSON.parse(fs.readFileSync(`${inDir}/roster.qbj`, 'utf8'));
const tournament = rosterFile.objects.find((o: any) => o.type === 'Tournament');
const teams: any[] = [];
for (const reg of tournament.registrations) {
  for (const team of reg.teams) {
    const roster: any = {};
    for (const p of team.players) roster[p.name.trim()] = { year: '', undergrad: false, div2: false };
    teams.push({
      teamName: team.name.trim(), smallSchool: false, jrVarsity: false,
      teamUGStatus: false, teamD2Status: false, roster, divisions: {}, rank: null,
    });
  }
}

// --- games: importQbjSingleGames
const games: any[] = [];
const log: any[] = [];
for (const f of cfg.files as string[]) {
  const result = importGame(teams, fs.readFileSync(`${inDir}/games/${f}`, 'utf8'), settings);
  if (!result.success) { log.push({ file: f, imported: false, messages: [result.error] }); continue; }
  const game: any = result.result;
  // YF 3's importer never sees overtime in a MODAQ file either; the TD's
  // fix is the game form's overtime fields
  const ot = cfg.overtime?.[f];
  if (ot) {
    game.ottu = ot.tossups;
    [game.team1, game.team2].forEach((name: string, i: number) => {
      const buzzes = Object.entries(ot.buzzes?.[name] ?? {}) as [string, number][];
      const sum = (test: (v: number) => boolean) => buzzes.reduce((n, [v, k]) => n + (test(Number(v)) ? k : 0), 0);
      game[`otPwr${i + 1}`] = sum((v) => v > 10);
      game[`otTen${i + 1}`] = sum((v) => v === 10);
      game[`otNeg${i + 1}`] = sum((v) => v < 0);
    });
  }
  // MainInterface.validateGame
  const v = validateGame(game, settings);
  game.invalid = !v.isValid;
  if (v.type === 'error' || v.type === 'warning') game.validationMsg = v.message;
  games.push(game);
  log.push({ file: f, imported: true, invalid: game.invalid, messages: game.validationMsg ? [game.validationMsg] : [] });
}

// --- save: MainInterface.writeJSON
fs.writeFileSync(outFile, [{ version: cfg.yf3.version }, {}, settings, {}, teams, games]
  .map((section) => JSON.stringify(section)).join('\n'));
fs.writeFileSync(outFile.replace(/\.yft$/, '.json'), JSON.stringify({ files: log }, null, 1));
