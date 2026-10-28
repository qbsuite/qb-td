#!/usr/bin/env node
// archive_goldens.mjs — give newly archived tournaments their golden entries.
//
// tests/games_golden.mjs and tests/ui_golden.js pin every archive, so a new
// one fails them until its entries exist. Regenerating the whole golden
// would also quietly accept any other change in the working tree, so this
// regenerates, then keeps only the named archives' entries from the run and
// everything else exactly as it was committed:
//
//   node tools/archive_goldens.mjs <slug> [<slug> ...]   # both goldens
//   node tools/archive_goldens.mjs --no-ui <slug>        # games.json only
//
// The UI golden runs headless Chrome (CHROME=…, see tests/cdp_lib.mjs).
// .github/workflows/archive.yml runs this after `archive.mjs add`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests', 'golden');

// Regenerate `file` with `script`, then rebuild `pick(golden)` in the
// regenerated key order: the named entries from the run, every other entry
// as committed. An entry the run made that is neither is an error, not
// something to accept on the way past.
function update(file, script, pick, keyOf, slugs) {
  const path = join(GOLDEN, file);
  const before = readFileSync(path, 'utf8');
  execFileSync(process.execPath, [join(ROOT, 'tests', script)], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, QBTD_UPDATE_GOLDEN: '1' },
  });
  const old = JSON.parse(before);
  const gen = JSON.parse(readFileSync(path, 'utf8'));
  const ours = new Set(slugs.map(keyOf));
  const oldPart = pick(old), genPart = pick(gen), merged = {};
  for (const k of Object.keys(genPart)) {
    if (ours.has(k)) merged[k] = genPart[k];
    else if (k in oldPart) merged[k] = oldPart[k];
    else {
      writeFileSync(path, before);
      throw new Error(`${file}: the run made an entry no archive named here owns (${k})`);
    }
  }
  for (const k of ours) {
    if (!(k in merged)) {
      writeFileSync(path, before);
      throw new Error(`${file}: no entry ${k}; is it in app/archive/index.json?`);
    }
  }
  const out = pick === top ? merged : { ...old, pages: merged };
  writeFileSync(path, JSON.stringify(out, null, 1) + '\n');
  console.log(`${file}: ${[...ours].join(', ')}`);
}

const top = (g) => g;

const argv = process.argv.slice(2);
const ui = !argv.includes('--no-ui');
const slugs = argv.filter((a) => !a.startsWith('--'));
if (!slugs.length) {
  console.error('usage: node tools/archive_goldens.mjs [--no-ui] <slug> [<slug> ...]');
  process.exit(2);
}
update('games.json', 'games_golden.mjs', top, (s) => 'archive:' + s, slugs);
if (ui) update('ui_golden.json', 'ui_golden.js', (g) => g.pages, (s) => 'archive ' + s, slugs);
