// e2e_lib.js — what the end-to-end suites share: calls against a locally
// running Worker, direct looks at the local D1 and R2 behind it, the cron
// trigger, and the pass/fail tally. Used by e2e_worker.js and e2e_sets.js.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const WORKER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker');

export const BASE = process.env.QBTD_BASE || 'http://127.0.0.1:8799';

// What credential columns hold for new rows (worker.js secretHash): the
// backdating UPDATEs match on it, and the at-rest checks assert it.
export const storedCred = (secret) =>
  createHash('sha256').update('qbtd-cred:' + secret).digest('hex');

// One row from the local D1 behind the dev Worker.
export function d1row(sql) {
  const out = execSync(
    `npx wrangler d1 execute qb-td --local --json --command "${sql}"`,
    { cwd: WORKER_DIR },
  ).toString();
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0] || null;
}

// A statement against the local D1, result ignored (backdating rows).
export function d1exec(sql) {
  execSync(`npx wrangler d1 execute qb-td --local --command "${sql}"`,
    { cwd: WORKER_DIR, stdio: 'ignore' });
}

// Raw bytes of an object in the local R2 behind the dev Worker — what an
// operator browsing the bucket would see.
export function r2get(key) {
  const tmp = path.join(tmpdir(), 'qbtd-e2e-' + Math.random().toString(36).slice(2));
  execSync(`npx wrangler r2 object get qb-td-data/${key} --local --file "${tmp}"`,
    { cwd: WORKER_DIR, stdio: 'ignore' });
  const buf = readFileSync(tmp);
  rmSync(tmp);
  return buf;
}

export async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  // The wrangler CLI invocations in d1row/r2get reset the dev server's
  // pooled keep-alive connections, so the next fetch can die with
  // ECONNRESET on a stale socket; a fresh connection succeeds.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(BASE + path, { ...opts, headers });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, cache: res.headers.get('cache-control') };
}

// max-age seconds from a Cache-Control header, or null.
export function maxAge(cc) {
  const m = /max-age=(\d+)/.exec(cc || '');
  return m ? Number(m[1]) : null;
}

// Run the cron by hand (wrangler dev --test-scheduled). It is what turns
// uploaded games into the round shards the public page reads, so the
// public assertions tick first rather than waiting a minute.
export async function tick() {
  const res = await fetch(BASE + '/__scheduled');
  if (!res.ok) throw new Error('cron trigger failed (' + res.status + '): run wrangler dev with --test-scheduled');
  await res.text();
}

let passed = 0;
export function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); }
  else { console.error('FAIL', name, extra ?? ''); process.exitCode = 1; }
}
export function summary(label) {
  console.log(passed + ' ' + label + ' checks passed' + (process.exitCode ? ' (with failures)' : ''));
}
