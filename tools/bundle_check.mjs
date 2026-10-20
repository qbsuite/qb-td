#!/usr/bin/env node
// bundle_check.mjs — what the two bundles carry, held to
// tests/golden/bundles.json. Reads no backend and deploys nothing.
//
//   node tools/bundle_check.mjs              # check
//   QBTD_UPDATE_GOLDEN=1 node tools/bundle_check.mjs   # write the golden
//
// The Worker: `wrangler deploy --dry-run` (which builds and stops) with
// esbuild's metafile, metrics off and any network attempt sent to a dead
// local port. Pass:
//   - zip.js, yft.js, yft3.js, report.js and stats.js put 0 bytes in it
//   - no 'function parseMatch' in it (the parser stays out of the Worker)
//   - gzipped, it is at most the golden's size + 300 bytes
//   - every input's bytes in the output are listed, so a new one shows
// The reader: `npm run build:read` rebuilt into app/js/read.bundle.js must
// give the committed file byte for byte (sha256 in the golden), which
// shows the modules MODAQ is bundled with are untouched. The committed
// file is put back afterwards, whatever the build did.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkGolden, readGolden } from '../tests/golden_lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(path.join(tmpdir(), 'qbtd-bundles-'));
const quietEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1',
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' };

function workerBundle() {
  const out = path.join(tmp, 'worker');
  const meta = path.join(tmp, 'worker-meta.json');
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out, '--metafile', meta],
    { cwd: path.join(ROOT, 'worker'), env: quietEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  const m = JSON.parse(readFileSync(meta, 'utf8'));
  const [, o] = Object.entries(m.outputs).find(([k]) => k.endsWith('worker.js'));
  const code = readFileSync(path.join(out, 'worker.js'));
  const inputs = Object.fromEntries(Object.entries(o.inputs).map(([k, v]) => [k.replace(/^.*?(app\/|worker\/)/, '$1').replace(/^worker\.js$/, 'worker/worker.js'), v.bytesInOutput]));
  return { bytes: code.length, gzip: gzipSync(code).length, parseMatch: code.includes('function parseMatch'), inputs,
    imported: Object.keys(m.inputs).map((k) => k.replace(/^.*?(app\/|worker\/)/, '$1')).sort() };
}

function readBundle() {
  const file = path.join(ROOT, 'app/js/read.bundle.js');
  const keep = path.join(tmp, 'read.bundle.js');
  copyFileSync(file, keep);
  const committed = readFileSync(file);
  try {
    execFileSync('node', ['tools/build_read.mjs'], { cwd: ROOT, env: quietEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    const rebuilt = readFileSync(file);
    return { committed: sha(committed), bytes: committed.length, rebuilt: sha(rebuilt), same: Buffer.compare(committed, rebuilt) === 0 };
  } finally {
    copyFileSync(keep, file);
  }
}

const got = { worker: workerBundle(), read: readBundle() };
rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify(got, null, 1));

const problems = [];
const golden = readGolden('bundles.json');
for (const f of ['app/engine/zip.js', 'app/engine/yft.js', 'app/engine/yft3.js', 'app/engine/report.js', 'app/engine/stats.js']) {
  if (got.worker.inputs[f]) problems.push(`${f} puts ${got.worker.inputs[f]} bytes in the Worker`);
}
if (got.worker.parseMatch) problems.push('the Worker bundle has function parseMatch');
if (!got.read.same) problems.push('npm run build:read does not rebuild the committed read.bundle.js');
if (process.env.QBTD_UPDATE_GOLDEN === '1') {
  checkGolden('bundles.json', { worker: { gzip: got.worker.gzip, bytes: got.worker.bytes, inputs: got.worker.inputs }, read: { sha256: got.read.committed, bytes: got.read.bytes } });
} else if (!golden) {
  problems.push('no tests/golden/bundles.json: run once with QBTD_UPDATE_GOLDEN=1 on the commit to hold to');
} else {
  if (got.worker.gzip > golden.worker.gzip + 300) problems.push(`the Worker bundle is ${got.worker.gzip} bytes gzipped, over ${golden.worker.gzip} + 300`);
  if (got.read.rebuilt !== golden.read.sha256) problems.push(`read.bundle.js rebuilds to ${got.read.rebuilt.slice(0, 12)}, not ${golden.read.sha256.slice(0, 12)}`);
  const added = Object.keys(got.worker.inputs).filter((k) => !(k in golden.worker.inputs));
  if (added.length) console.log('new Worker inputs (check each is one the design lists): ' + added.join(', '));
  for (const [k, n] of Object.entries(got.worker.inputs)) {
    if (k in golden.worker.inputs && n !== golden.worker.inputs[k]) console.log(`  ${k}: ${golden.worker.inputs[k]} -> ${n} bytes in the Worker`);
  }
  console.log(`Worker gzip ${golden.worker.gzip} -> ${got.worker.gzip} (${got.worker.gzip - golden.worker.gzip >= 0 ? '+' : ''}${got.worker.gzip - golden.worker.gzip} B)`);
}
if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('bundles ok');
