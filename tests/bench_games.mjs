// bench_games.mjs — the CPU the pages spend loading games, held to the
// code as it was at 0cd19c5 (tests/ref_games.mjs). Two cases:
//   public page  the live-room pass, rename, parse and dedupe of every
//                game on the Terrapin archive (50 games), with no roster
//                renames and with three teams and a player renamed
//   TD hub       collectMatches' parse phase on 300 uploads (half of
//                them reader uploads, whose MODAQ files are built too),
//                every game already read (the cache), so only the parse
//                and export work is timed
//   public page, as committed
//                pubview.js's own fetchMatches (tests/pubview_src.mjs),
//                roster names included, against the pinned copy of it
// Each runs the candidate and the reference interleaved, REPS (200) times,
// the order alternating, each sample long enough (~4 ms) to time. Pass:
// the median of the paired ratios <= 1.05, and p95 over p95 <= 1.10.
// The candidate is the shared module once it exists (app/engine/games.js
// readGames, app/js/hubgames.js collectMatches); until then a second copy
// of the reference, which shows the noise floor. Run:
//   node --expose-gc tests/bench_games.mjs

import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { rosterNameMap, parseRoster } from '../app/engine/qbj.js';
import { dedupeEntries } from '../app/engine/buzz.js';
import { archiveFixture, demoFixture, renamedRosterText, ARCHIVE_SLUGS } from './games_fixtures.mjs';
import { pubviewLoop, pubviewFetchMatches, hubRef, pinnedModaqFiles } from './ref_games.mjs';
import { pubviewOwnFetchMatches } from './pubview_src.mjs';
import { jsonSha } from './golden_lib.mjs';

const REPS = Number(process.env.REPS || 200);
const here = (p) => new URL(p, import.meta.url);

// a second instance of the reference, so the two sides share no JIT state
const refB = await import('./ref_games.mjs?candidate');

async function pubCandidate() {
  if (existsSync(here('../app/engine/games.js'))) {
    const g = await import('../app/engine/games.js');
    if (typeof g.readGames === 'function') {
      return { name: 'games.js readGames', fn: (entries, names, files) => {
        const liveRoom = new Map((files || []).map((f) => [f.id, f.room]));
        for (const entry of entries) if (liveRoom.get(entry.id)) entry.room = liveRoom.get(entry.id);
        const errors = [];
        const { matches, raw } = g.readGames(entries, names, errors);
        return { matches, errors, rawEntries: dedupeEntries(raw) };
      } };
    }
  }
  return { name: 'reference copy', fn: refB.pubviewLoop };
}

async function hubCandidate(pub) {
  if (existsSync(here('../app/js/hubgames.js'))) {
    const h = await import('../app/js/hubgames.js');
    if (typeof h.collectMatches === 'function') {
      return { name: 'hubgames.js collectMatches', fn: (...a) => h.collectMatches(pub, ...a) };
    }
  }
  const r = refB.hubRef({ pub });
  return { name: 'reference copy', fn: r.collectMatches };
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

async function compare(label, ref, cand, check) {
  // same answers first: a faster wrong answer is no answer
  const a = await ref();
  const b = await cand();
  if (check(a) !== check(b)) throw new Error(label + ': the candidate answers differently');
  for (let i = 0; i < 20; i++) { await ref(); await cand(); }
  // a sample is `inner` calls, at least ~4 ms, so a fast case isn't timer noise
  const t1 = performance.now();
  for (let i = 0; i < 5; i++) await ref();
  const inner = Math.max(1, Math.round(4 / ((performance.now() - t1) / 5)));
  const t = { ref: [], cand: [] };
  for (let i = 0; i < REPS; i++) {
    const order = i % 2 ? [['cand', cand], ['ref', ref]] : [['ref', ref], ['cand', cand]];
    for (const [k, fn] of order) {
      if (globalThis.gc && i % 20 === 0) globalThis.gc();
      const t0 = performance.now();
      for (let j = 0; j < inner; j++) await fn();
      t[k].push((performance.now() - t0) / inner);
    }
  }
  const row = {
    case: label,
    'ref median ms': +pct(t.ref, 0.5).toFixed(3), 'cand median ms': +pct(t.cand, 0.5).toFixed(3),
    // each sample of the candidate over the reference's taken beside it,
    // so a slow stretch of the machine falls on both sides of a ratio
    'median ratio': +pct(t.cand.map((x, i) => x / t.ref[i]), 0.5).toFixed(3),
    'p95 ratio': +(pct(t.cand, 0.95) / pct(t.ref, 0.95)).toFixed(3),
  };
  row.ok = row['median ratio'] <= 1.05 && row['p95 ratio'] <= 1.10;
  return row;
}

const rows = [];

/* ---------- the public page on Terrapin ---------- */
const pubC = await pubCandidate();
const terp = await archiveFixture(ARCHIVE_SLUGS[0]);
const regs = terp.rosterQbj.objects[0].registrations;
const renamed = parseRoster(JSON.parse(renamedRosterText(terp.rosterQbj,
  Object.fromEntries(regs.slice(0, 3).map((r) => [r.teams[0].name, r.teams[0].name + ' (renamed)'])),
  [[regs[3].teams[0].name, regs[3].teams[0].players[0].name, regs[3].teams[0].players[0].name + ' Jr.']])));
const pubCheck = (r) => jsonSha([r.matches, r.errors, r.rawEntries]);
for (const [label, roster] of [['public page, Terrapin, no renames', parseRoster(terp.rosterQbj)], ['public page, Terrapin, renames', renamed]]) {
  const names = rosterNameMap(roster);
  const eRef = structuredClone(terp.entries);
  const eCand = structuredClone(terp.entries);
  rows.push(await compare(label + ' [' + pubC.name + ']',
    () => pubviewLoop(eRef, names, terp.files), () => pubC.fn(eCand, names, terp.files), pubCheck));
}
// the page's fetchMatches itself, as pubview.js has it now
const pageOwn = await pubviewOwnFetchMatches();
for (const [label, roster] of [['public page fetchMatches, Terrapin, no renames', parseRoster(terp.rosterQbj)], ['public page fetchMatches, Terrapin, renames', renamed]]) {
  const eRef = structuredClone(terp.entries);
  const eCand = structuredClone(terp.entries);
  rows.push(await compare(label + ' [pubview.js as committed]',
    () => pubviewFetchMatches({ entries: eRef, files: terp.files, roster }),
    () => pageOwn({ entries: eCand, files: terp.files, roster }), pubCheck));
}

/* ---------- the hub's parse phase on 300 uploads ---------- */
const demo = await demoFixture();
const files = [];
const store = new Map();
for (let i = 0; i < 300; i++) {
  const e = demo.entries[i % demo.entries.length];
  const id = 5000 + i;
  const reader = i % 2 === 0;
  const qbj = { ...structuredClone(e.qbj), _round: 1 + (i % 12) };
  const full = reader ? { qbj, game: { game: { players: [], cycles: [], packet: { tossups: [{ question: 'word '.repeat(300) }] } }, uiState: {} },
    modaq: { qbj: JSON.stringify(qbj, null, 4), game: JSON.stringify({ players: [], cycles: [] }, null, 2) } } : qbj;
  const key = 't/1/file/' + id;
  store.set(key, full);
  files.push({ id, bucket_id: 1 + (i % 2), round: qbj._round, kind: reader ? 'combined' : 'qbj', r2_key: key,
    filename: `Round_${qbj._round}_${id}${reader ? '.qbtd.json' : '.qbj'}`, size: 1000 + i, error: null, created: 1e12 - i });
}
store.set('t/1/roster.qbj', demo.rosterQbj);
const pub = async (path) => {
  const key = decodeURIComponent((/[?&]key=([^&]+)/.exec(path) || [])[1] || '');
  if (!store.has(key)) throw new Error('no such file');
  return structuredClone(store.get(key));
};
const t = { roster_r2_key: 't/1/roster.qbj', settings: '{}' };
const buckets = [{ id: 1, room_name: 'Room A' }, { id: 2, room_name: 'Room B' }];
const refHub = hubRef({ pub });
const hubC = await hubCandidate(pub);
const cacheOf = () => { const c = new Map(); for (const f of files) c.set(f.id + '|' + f.size + '|' + f.created + '|' + f.round, store.get(f.r2_key)); return c; };
const cRef = cacheOf();
const cCand = cacheOf();
// the MODAQ files as the pinned code gave them: since 10/20 each carries
// its upload's id (ref_games.mjs pinnedModaqFiles)
const hubCheck = (r) => jsonSha([r.matches, r.raw, r.errors, pinnedModaqFiles(r.modaqFiles), r.games]);
rows.push(await compare('TD hub, 300 uploads, parse phase [' + hubC.name + ']',
  () => refHub.collectMatches('/a/x', t, buckets, files, () => {}, { cache: cRef }),
  () => hubC.fn('/a/x', t, buckets, files, () => {}, { cache: cCand }), hubCheck));

console.table(rows);
console.log(JSON.stringify({ reps: REPS, rows }));
if (rows.some((r) => !r.ok)) { console.error('slower than the 0cd19c5 code: median ratio over 1.05 or p95 over 1.10'); process.exitCode = 1; }
