// yf_parity.mjs — check the .yft and the HTML stat report qb-td generates
// against the ones YellowFruit itself writes from the same files.
//
//   npm run yf-parity            every scenario
//   npm run yf-parity -- demo    one scenario
//
// For each scenario in tools/yf_parity/scenarios.mjs:
//   1. YellowFruit's own code (its data model, run headless) imports the
//      roster .qbj and every game .qbj into a custom one-stage schedule and
//      saves a .yft — tools/yf_parity/import.ts.
//   2. qb-td builds its .yft from the same files, through the same calls
//      the dashboard's "Download .yft" makes.
//   3. YellowFruit opens each file and saves it again
//      (tools/yf_parity/open.ts) — the form in which it regenerates what
//      is its own to decide (player ids, stored validation messages, key
//      order). The two saved files must be byte-identical: YellowFruit
//      holds the same tournament either way.
//   4. No game in qb-td's file may carry a YellowFruit validation error
//      (YF leaves such games out of the stats), and the stat report YF
//      renders from it must equal the one from its own import.
//   5. qb-td's own stat report (app/engine/report.js, the dashboard's
//      "Download stat report") must be byte-identical, page for page, to
//      the report YellowFruit saves to disk under the same file prefix.
//   6. The YellowFruit 3 file (app/engine/yft3.js, for TDs still on the 3.x
//      app) must be byte-identical to the one YF 3.0.2's own game importer
//      and validator produce from the same files — tools/yf_parity/import3.ts
//      — and no game in it may be one YF 3 marks invalid.
//
// YellowFruit (AGPL-3.0) is cloned at the pinned tags into .cache/, never
// into the repo; its runtime dependencies are installed beside it.
// Needs git and network on first run. Outputs land in .cache/yf-parity/out
// for inspection.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { parseMatch, parseRoster } from '../app/engine/qbj.js';
import { dedupeMatches } from '../app/engine/stats.js';
import { serializeYft, PHASE_NAME, POOL_NAME } from '../app/engine/yft.js';
import { serializeYft3 } from '../app/engine/yft3.js';
import { buildReport } from '../app/engine/report.js';
import { SCENARIOS } from './yf_parity/scenarios.mjs';

const YF_TAG = 'v4.0.18';
const YF_VERSION = YF_TAG.slice(1);
const YF_REPO = 'https://github.com/ANadig/YellowFruit.git';
const REPORT_PREFIX = 'parity'; // what the TD types in YF's save-report dialog
const YF_ERROR = 1; // ValidationStatuses.Error, as a saved file stores it
const YF3_TAG = 'v3.0.2'; // the last 3.x release
const YF_DEPS = ['dayjs@^1.11.10', 'string-similarity-js@^2.1.4', 'lodash@^4.17.21'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'yf-parity');
const yfDir = path.join(cache, `YellowFruit-${YF_TAG}`);
const yf3Dir = path.join(cache, `YellowFruit-${YF3_TAG}`);
const depsDir = path.join(cache, 'deps');
const outRoot = path.join(cache, 'out');

function ensureYellowFruit() {
  for (const [dir, tag, probe] of [
    [yfDir, YF_TAG, path.join('src', 'renderer', 'DataModel', 'Tournament.ts')],
    [yf3Dir, YF3_TAG, path.join('process', 'ts', 'SingleGameQBJImport.ts')],
  ]) {
    if (fs.existsSync(path.join(dir, probe))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    console.log(`cloning YellowFruit ${tag} ...`);
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, YF_REPO, dir], { stdio: 'ignore' });
  }
  if (!YF_DEPS.every((d) => fs.existsSync(path.join(depsDir, 'node_modules', d.split('@')[0])))) {
    fs.mkdirSync(depsDir, { recursive: true });
    fs.writeFileSync(path.join(depsDir, 'package.json'), '{"private":true}');
    console.log('installing YellowFruit\'s runtime dependencies ...');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', ...YF_DEPS],
      { cwd: depsDir, stdio: 'inherit', shell: true });
  }
}

async function bundle(entry) {
  const outfile = path.join(cache, entry.replace(/\.ts$/, '.cjs'));
  await build({
    entryPoints: [path.join(root, 'tools', 'yf_parity', entry)],
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
    alias: { yf: path.join(yfDir, 'src', 'renderer'), yf3: path.join(yf3Dir, 'process', 'ts') },
    nodePaths: [path.join(depsDir, 'node_modules')],
    // YF's utils pull in its React UI helpers; nothing the data model runs
    external: ['react', '@mui/*'],
  });
  return outfile;
}

// Report pages compared as the text a reader sees, row by row.
const visible = (file) => fs.readFileSync(file, 'utf8')
  .replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<\/tr>/gi, '\n').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at byte ${i}\n      yellowfruit: …${a.slice(Math.max(0, i - 80), i + 120)}\n      qb-td:       …${b.slice(Math.max(0, i - 80), i + 120)}`;
}

function runScenario(sc, importer, opener, importer3) {
  const dir = path.join(outRoot, sc.key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'in', 'games'), { recursive: true });
  const problems = [];

  // qb-td's side, as admin.js does it: parse each file, newest-first
  // dedupe, roster from the roster qbj
  const matches = dedupeMatches(sc.games.map((g) => {
    const m = parseMatch(g.qbj, { filename: g.filename });
    m.filename = g.filename;
    return m;
  }));
  const roster = parseRoster(sc.roster);
  // the tournament's MODAQ game format, as the dashboard hands it over
  // (admin.js: effectiveFormat of the TO's settings); undefined keeps a
  // scenario on YellowFruit's own defaults
  const rules = sc.rules || {};
  const ours = serializeYft({ name: sc.name, matches, roster, settings: rules });
  fs.writeFileSync(path.join(dir, 'qbtd.yft'), ours);

  // YellowFruit's side
  fs.writeFileSync(path.join(dir, 'in', 'roster.qbj'), JSON.stringify(sc.roster));
  for (const g of sc.games) fs.writeFileSync(path.join(dir, 'in', 'games', g.filename), JSON.stringify(g.qbj));
  fs.writeFileSync(path.join(dir, 'in', 'config.json'), JSON.stringify({
    name: sc.name, yfVersion: YF_VERSION, ruleSet: sc.ruleSet, rules,
    rounds: Math.max(...matches.map((m) => m.round)),
    phaseName: PHASE_NAME, poolName: POOL_NAME,
    // imported round by round, as buildYft orders them
    files: [...matches].sort((a, b) => a.round - b.round).map((m) => m.filename),
    overtime: Object.fromEntries(sc.games.filter((g) => g.overtime).map((g) => [g.filename, g.overtime])),
    // the same rules as the TD would set them in YF 3's settings pane
    yf3: { version: YF3_TAG.slice(1), powers: sc.ruleSet === 'mAcfPowers' ? '15pts' : 'none', negs: true },
  }));
  execFileSync('node', [importer, path.join(dir, 'in'), path.join(dir, 'yf.yft')], { stdio: 'inherit', env: { ...process.env, YF_REPORT_PREFIX: REPORT_PREFIX } });

  const log = JSON.parse(fs.readFileSync(path.join(dir, 'yf.json'), 'utf8'));
  for (const name of log.skippedRegistrations) problems.push(`YellowFruit skipped registration "${name}"`);
  for (const f of log.files) {
    if (!f.imported) problems.push(`YellowFruit refused ${f.file}: ${f.messages.join(' | ')}`);
    else if (f.messages.length) console.log(`    note: ${f.file} imported with ${f.status}: ${f.messages.join(' | ')}`);
  }

  const reopen = (who) => {
    execFileSync('node', [opener, path.join(dir, `${who}.yft`), path.join(dir, `${who}_reopened.yft`), YF_VERSION], { stdio: 'inherit', env: { ...process.env, YF_REPORT_PREFIX: REPORT_PREFIX } });
    return fs.readFileSync(path.join(dir, `${who}_reopened.yft`), 'utf8');
  };
  const theirs = reopen('yf');
  const reopened = reopen('qbtd');
  if (theirs !== reopened) problems.push(`.yft differs from YellowFruit's ${firstDifference(theirs, reopened)}`);
  const raw = fs.readFileSync(path.join(dir, 'yf.yft'), 'utf8') === ours;

  // ValidationStatuses.Error: YF leaves a game carrying one out of the stats
  const flagged = JSON.parse(reopened).objects[0].phases.flatMap((ph) => ph.rounds).flatMap((r) => r.matches || [])
    .flatMap((m) => [...(m.YfData.otherValidation || []), ...m.match_teams.flatMap((mt) => mt.YfData.validation || [])]
      .filter((v) => v.status === YF_ERROR).map((v) => `${m.id}: ${v.message}`));
  for (const f of flagged) problems.push(`YellowFruit finds an error in qb-td's file — ${f}`);

  for (const pg of ['standings', 'individuals', 'games', 'teamdetail', 'playerdetail', 'rounds']) {
    const a = visible(path.join(dir, `yf_reopened_${pg}.html`));
    const b = visible(path.join(dir, `qbtd_reopened_${pg}.html`));
    if (a !== b) problems.push(`YellowFruit's ${pg} page differs between its own import and qb-td's file`);
  }
  // the YF 3 file against YF 3's own import
  const ours3 = serializeYft3({ matches, roster, settings: rules });
  fs.writeFileSync(path.join(dir, 'qbtd3.yft'), ours3);
  execFileSync('node', [importer3, path.join(dir, 'in'), path.join(dir, 'yf3.yft')], { stdio: 'inherit' });
  for (const f of JSON.parse(fs.readFileSync(path.join(dir, 'yf3.json'), 'utf8')).files) {
    if (!f.imported) problems.push(`YellowFruit 3 refused ${f.file}: ${f.messages.join(' | ')}`);
    else if (f.invalid) problems.push(`YellowFruit 3 marks ${f.file} invalid: ${f.messages.join(' | ')}`);
    else if (f.messages.length) console.log(`    note: YF 3 warns on ${f.file}: ${f.messages.join(' | ')}`);
  }
  const theirs3 = fs.readFileSync(path.join(dir, 'yf3.yft'), 'utf8');
  if (theirs3 !== ours3) problems.push(`YF 3 .yft differs from YellowFruit ${YF3_TAG}'s ${firstDifference(theirs3, ours3)}`);

  // qb-td's own report against the one YF saves
  for (const page of buildReport({ name: sc.name, matches, roster, prefix: REPORT_PREFIX, settings: rules })) {
    const pg = page.name.slice(REPORT_PREFIX.length + 1, -'.html'.length);
    fs.writeFileSync(path.join(dir, `qbtd_report_${page.name}`), page.text);
    const yfPage = fs.readFileSync(path.join(dir, `yf_${pg}.html`), 'utf8');
    if (yfPage !== page.text) problems.push(`stat report: ${page.name} differs from YellowFruit's ${firstDifference(yfPage, page.text)}`);
  }

  // the failure this check was written for: a file with no pool opens to
  // an empty standings page
  if (!/\bRank\b[\s\S]*\bPPB\b/.test(visible(path.join(dir, 'qbtd_reopened_standings.html')))) {
    problems.push('YellowFruit shows no standings table for qb-td\'s file');
  }
  return { games: matches.length, problems, raw };
}

const only = process.argv.slice(2);
const scenarios = SCENARIOS.filter((s) => !only.length || only.includes(s.key));
if (!scenarios.length) {
  console.error(`no such scenario; have: ${SCENARIOS.map((s) => s.key).join(', ')}`);
  process.exit(2);
}

ensureYellowFruit();
const importer = await bundle('import.ts');
const opener = await bundle('open.ts');
const importer3 = await bundle('import3.ts');

let failed = 0;
for (const sc of scenarios) {
  console.log(`${sc.key}`);
  const { games, problems, raw } = runScenario(sc, importer, opener, importer3);
  if (problems.length) {
    failed++;
    for (const p of problems) console.log(`  FAIL ${p}`);
  } else {
    console.log(`  ok ${games} games: .yft is the tournament YellowFruit ${YF_VERSION} imports, no flagged games; stat report byte-identical, all six pages; YF 3 file byte-identical to ${YF3_TAG}'s`
      + (raw ? ' (.yft byte-identical even before YF re-saves it)' : ''));
  }
}
console.log(failed ? `\n${failed} of ${scenarios.length} scenarios differ — files in ${path.relative(root, outRoot)}` : '\nall scenarios match');
process.exit(failed ? 1 : 0);
