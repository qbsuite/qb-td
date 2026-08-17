#!/usr/bin/env node
// archive.mjs — the qb-td archive's approval gate.
//
// A published tournament is public but unlisted: you need its slug to find
// it, and it lives only as long as the Worker and its R2 bucket do. The
// archive is the curated other half — the tournaments worth keeping, frozen
// into this repo so they outlive the backend entirely.
//
// Approving one means running `add` and committing the result. There is no
// approval flag in D1 and no owner credential in the Worker: the gate is
// the Cloudflare login `list` needs plus push access to this repo, both of
// which already exist. Nothing here writes to the backend.
//
//   node tools/archive.mjs list
//   node tools/archive.mjs add <slug> [--date YYYY-MM-DD] [--host "..."]
//   node tools/archive.mjs refresh <slug>
//   node tools/archive.mjs remove <slug>
//
// Common flags: --server <url> to read from a different backend.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMatch, parseRoster } from '../app/engine/qbj.js';
import { dedupeMatches } from '../app/engine/stats.js';
import { buildReport } from '../app/engine/report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'app', 'archive');
const INDEX = join(ARCHIVE, 'index.json');
const DEFAULT_API = 'https://qb-td.denisliu10.workers.dev';

/* ---------- manifest ---------- */

function readIndex() {
  if (!existsSync(INDEX)) return { tournaments: [] };
  return JSON.parse(readFileSync(INDEX, 'utf8'));
}

// Newest first, which is the order the archive page lists them in.
function writeIndex(index) {
  index.tournaments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  mkdirSync(ARCHIVE, { recursive: true });
  writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
}

/* ---------- backend reads ---------- */

async function getJson(api, path) {
  const res = await fetch(api + path);
  const body = await res.text();
  if (!res.ok) {
    let msg = body;
    try { msg = JSON.parse(body).error || body; } catch { /* not json */ }
    throw new Error(`GET ${path} failed (${res.status}): ${msg}`);
  }
  return JSON.parse(body);
}

// Optional routes 404 on tournaments that never used the feature. A frozen
// path that is simply absent makes pub() throw, which is the same branch
// the page already takes against a live backend, so leave them out.
async function getOptional(api, path) {
  try { return await getJson(api, path); } catch { return null; }
}

/** Published tournaments straight from D1, via the Cloudflare login. */
function listTournaments() {
  // One command string rather than an argv array: npx is a .cmd on Windows,
  // which Node will only spawn through a shell anyway. The SQL is a
  // constant with no quotes of its own, so one pair of double quotes is
  // enough on both cmd and sh.
  const sql = 'SELECT slug, name, published, current_round, created'
    + ' FROM tournaments ORDER BY created DESC LIMIT 200';
  const out = execSync(`npx wrangler d1 execute qb-td --remote --json --command "${sql}"`,
    { cwd: join(ROOT, 'worker'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  // wrangler prints a JSON array of statement results; the rows are on the
  // first (and only) one.
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results;
}

/* ---------- capture ---------- */

// The public bundle must never carry packet text. The Worker strips
// `notes` (protest reasons — mod free text that quotes answers) from
// every bundle entry, so nothing long belongs here at all: any long
// string means question text leaked into a file about to be committed
// and served forever. (A bundle from before the strip may still carry
// short MODAQ notes like "Tossup thrown out on question N" — fine.)
function assertNoQuestionText(bundle) {
  const long = [];
  (function walk(o, path) {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.length > 120) long.push(path + '.' + k);
      else if (typeof v === 'object') walk(v, path + '.' + k);
    }
  })(bundle, 'bundle');
  if (long.length) {
    throw new Error('refusing to archive: unexpected long strings in the bundle, '
      + 'which may be packet text: ' + long.join(', '));
  }
}

// Every game, from the live per-round shards. A capture is frozen and
// tiny by tournament standards, so it keeps the whole-tournament shape
// the archived page reads (`rounds` is dropped below) rather than
// freezing a stamp scheme that only matters while a tournament is live.
async function captureBundle(api, slug, state) {
  const rounds = Object.keys(state.rounds || {}).sort((a, b) => Number(a) - Number(b));
  if (!rounds.length) return { entries: [] };
  const { rounds: shards } = await getJson(api, `/pub/${slug}/rounds?n=${rounds.join(',')}`);
  return { entries: (shards || []).flatMap((s) => s.entries || []) };
}

async function capture(api, slug) {
  const state = await getJson(api, `/pub/${slug}`);
  const bundle = await captureBundle(api, slug, state);
  assertNoQuestionText(bundle);

  const [schedule, cats, roster] = await Promise.all([
    getOptional(api, `/pub/${slug}/schedule`),
    getOptional(api, `/pub/${slug}/cats`),
    state.roster ? getOptional(api, `/pub/${slug}/roster`) : null,
  ]);

  // The buzzpoints tab reads packet text through a password-gated route.
  // That can't be archived and shouldn't be, so switch the tab off rather
  // than leave it rendering empty questions. Broadcasts are live-only too.
  // The GitHub snapshot pointer (pub) is dropped as well: the capture IS
  // the complete data, and the snapshot repo may prune old slugs — the
  // page also guards against this (usingStaticData), belt and braces.
  const data = {
    [`/pub/${slug}`]: {
      ...state, buzz: null, buzz_v: null, buzz_done: [], packet_rounds: [], announce: [], pub: null,
      // No `rounds`: the capture holds every game in one bundle, which is
      // what the page falls back to when nothing advertises shards.
      rounds: undefined,
    },
    [`/pub/${slug}/bundle`]: bundle,
  };
  if (schedule) data[`/pub/${slug}/schedule`] = schedule;
  if (cats) data[`/pub/${slug}/cats`] = cats;
  if (roster) data[`/pub/${slug}/roster`] = roster;

  return { state, bundle, roster, data };
}

/** Parse the bundle the way pubview.js does, so page and report agree. */
function parseBundle(bundle) {
  const matches = [];
  const errors = [];
  for (const entry of bundle.entries) {
    try {
      const m = parseMatch(entry.qbj, { filename: entry.filename });
      m.room = entry.room;
      m.fileId = entry.id;
      matches.push(m);
    } catch (e) { errors.push(entry.filename + ': ' + e.message); }
  }
  return { matches, errors };
}

/* ---------- write ---------- */

function writeCapture(slug, name, data) {
  const header = `// ${slug}.js — a frozen capture of the public /pub responses for
// ${name}, kept as part of the qb-td archive.
//
// Generated by tools/archive.mjs; regenerate with \`refresh\`, never edit.
// Contains only what the public routes already serve: match qbj (team,
// player, and buzz-position data), the schedule, the text-free category
// map, and the roster. No packet or question text.

export default `;
  mkdirSync(ARCHIVE, { recursive: true });
  writeFileSync(join(ARCHIVE, slug + '.js'), header + JSON.stringify(data) + ';\n');
}

function writeReport(slug, name, matches, roster) {
  const dir = join(ARCHIVE, slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = buildReport({ name, matches: dedupeMatches(matches), roster });
  for (const f of files) writeFileSync(join(dir, f.name), f.text);
  return files.map((f) => f.name);
}

/* ---------- commands ---------- */

async function cmdList(opts) {
  const archived = new Set(readIndex().tournaments.map((t) => t.slug));
  let rows;
  try {
    rows = listTournaments();
  } catch (e) {
    console.error('could not read D1 (is wrangler logged in?): ' + e.message);
    process.exit(1);
  }
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const width = Math.max(4, ...rows.map((r) => r.slug.length));
  console.log(`${'slug'.padEnd(width)}  created     rd  state`);
  for (const r of rows) {
    const state = archived.has(r.slug) ? 'archived'
      : r.published ? 'published' : 'unpublished';
    console.log(`${r.slug.padEnd(width)}  ${day(r.created)}  ${String(r.current_round).padStart(2)}  ${state}  ${r.name}`);
  }
  const ready = rows.filter((r) => r.published && !archived.has(r.slug));
  console.log(`\n${rows.length} tournaments, ${archived.size} archived, ${ready.length} published and not archived`);
  if (ready.length) console.log('approve one with: node tools/archive.mjs add ' + ready[0].slug);
  if (opts.date || opts.host) console.log('(--date and --host apply to add/refresh, not list)');
}

async function cmdAdd(slug, opts, { refresh = false } = {}) {
  const index = readIndex();
  const existing = index.tournaments.find((t) => t.slug === slug);
  if (existing && !refresh) {
    throw new Error(`${slug} is already archived; use \`refresh\` to recapture it`);
  }
  if (!existing && refresh) throw new Error(`${slug} is not archived yet; use \`add\``);

  console.log(`reading ${slug} from ${opts.api} ...`);
  const { state, roster, bundle, data } = await capture(opts.api, slug);
  const { matches, errors } = parseBundle(bundle);
  for (const e of errors) console.warn('  skipped unparseable file: ' + e);
  if (!matches.length) throw new Error('no parseable games; nothing to archive');

  const parsedRoster = roster ? parseRoster(roster) : null;
  const games = dedupeMatches(matches);
  const teams = new Set(games.flatMap((m) => m.teams.map((t) => t.name)));

  writeCapture(slug, state.name, data);
  const pages = writeReport(slug, state.name, matches, parsedRoster);

  const date = opts.date || (existing && existing.date) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
  const entry = {
    slug,
    name: state.name,
    date,
    host: opts.host || (existing && existing.host) || '',
    teams: parsedRoster ? parsedRoster.length : teams.size,
    rounds: Math.max(...games.map((m) => m.round)),
    games: games.length,
  };
  if (existing) Object.assign(existing, entry);
  else index.tournaments.push(entry);
  writeIndex(index);

  console.log(`\n${refresh ? 'refreshed' : 'archived'} ${slug}`);
  console.log(`  ${entry.name} — ${entry.teams} teams, ${entry.rounds} rounds, ${entry.games} games`);
  console.log(`  app/archive/${slug}.js  (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
  console.log(`  app/archive/${slug}/  (${pages.length} report pages)`);
  if (!opts.date && !existing) console.log(`  date defaulted to today; set the real one with --date`);
  console.log('\ncommit the result to approve it.');
}

function cmdRemove(slug) {
  const index = readIndex();
  const at = index.tournaments.findIndex((t) => t.slug === slug);
  if (at < 0) throw new Error(`${slug} is not archived`);
  index.tournaments.splice(at, 1);
  writeIndex(index);
  rmSync(join(ARCHIVE, slug + '.js'), { force: true });
  rmSync(join(ARCHIVE, slug), { recursive: true, force: true });
  console.log(`removed ${slug} from the archive`);
}

/* ---------- entry ---------- */

function parseArgs(argv) {
  const opts = { api: DEFAULT_API };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') opts.api = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a.startsWith('--')) throw new Error('unknown flag ' + a);
    else rest.push(a);
  }
  return { opts, rest };
}

const USAGE = `usage:
  node tools/archive.mjs list
  node tools/archive.mjs add <slug> [--date YYYY-MM-DD] [--host "Stanford"]
  node tools/archive.mjs refresh <slug>
  node tools/archive.mjs remove <slug>`;

try {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const [cmd, slug] = rest;
  if (cmd !== 'list' && !slug) throw new Error(USAGE);
  if (slug && !/^[a-z0-9-]{3,40}$/.test(slug)) throw new Error('bad slug: ' + slug);

  if (cmd === 'list') await cmdList(opts);
  else if (cmd === 'add') await cmdAdd(slug, opts);
  else if (cmd === 'refresh') await cmdAdd(slug, opts, { refresh: true });
  else if (cmd === 'remove') cmdRemove(slug);
  else throw new Error(USAGE);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
