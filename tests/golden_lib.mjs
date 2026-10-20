// golden_lib.mjs — what the equivalence tests share: hashes, and goldens
// kept under tests/golden/. A golden pins what the code gives today, so a
// change meant to keep behaviour (moving code into a module, sharing a
// function) can prove it did. QBTD_UPDATE_GOLDEN=1 writes the goldens from
// the current code instead of checking them; do that only on a commit whose
// behaviour is the one to keep, and say so in the commit.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
export const UPDATE = process.env.QBTD_UPDATE_GOLDEN === '1';

export const sha = (data) => createHash('sha256').update(typeof data === 'string' || data instanceof Uint8Array ? data : String(data)).digest('hex');
// a short hash of a value's JSON text: key order counts, as it does for
// anything written out
export const jsonSha = (v) => sha(JSON.stringify(v) ?? 'undefined').slice(0, 24);

// The value, or the error it threw as 'ERR: message' (an export that
// refuses some input must keep refusing it, with the same words).
export function attempt(fn) {
  try { return fn(); } catch (e) { return 'ERR: ' + e.message; }
}

// Differences between two plain JSON values, as paths: at most `max`.
export function diffPaths(want, got, max = 20) {
  const out = [];
  const walk = (a, b, at) => {
    if (out.length >= max) return;
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const sameKeys = JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b));
      for (const k of keys) walk(a[k], b[k], at + (Array.isArray(a) ? `[${k}]` : '.' + k));
      if (!out.length && !sameKeys) out.push(at + ' (key order: ' + JSON.stringify(Object.keys(a)) + ' vs ' + JSON.stringify(Object.keys(b)) + ')');
      return;
    }
    const s = (v) => { const t = JSON.stringify(v); return t === undefined ? 'undefined' : t.length > 160 ? t.slice(0, 160) + '…' : t; };
    out.push(at + ': want ' + s(a) + ', got ' + s(b));
  };
  walk(want, got, '');
  return out;
}

export function readGolden(name) {
  const file = path.join(GOLDEN_DIR, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export function writeGolden(name, value) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(path.join(GOLDEN_DIR, name), JSON.stringify(value, null, 1) + '\n');
}

/** Check `actual` against tests/golden/<name>, or write it with
    QBTD_UPDATE_GOLDEN=1. Returns the list of differences (empty: equal). */
export function checkGolden(name, actual) {
  const plain = JSON.parse(JSON.stringify(actual));
  if (UPDATE) { writeGolden(name, plain); return []; }
  const want = readGolden(name);
  if (!want) return ['no golden ' + name + ': run once with QBTD_UPDATE_GOLDEN=1 on the commit to keep'];
  return diffPaths(want, plain);
}

/** A metered run's totals (the dev Worker's /__meter, end minus start),
    checked against tests/golden/meter_totals.json under `label`, or
    written there with QBTD_UPDATE_GOLDEN=1. Labels name the command and
    its knobs, since the totals depend on both. Returns the differences. */
export function checkTotals(label, totals) {
  const all = readGolden('meter_totals.json') || {};
  if (UPDATE) { all[label] = totals; writeGolden('meter_totals.json', all); return []; }
  if (!all[label]) return ['no meter golden for ' + label + ': run once with QBTD_UPDATE_GOLDEN=1 on the commit to hold to'];
  return diffPaths(all[label], totals);
}

/** The meter's totals since `start` (a /__meter answer). */
export function meterSince(start, now) {
  return Object.fromEntries(Object.keys(now).map((k) => [k, now[k] - (start[k] || 0)]));
}
