// modaq_regen.mjs — give a tournament's older reader uploads MODAQ's own
// export files.
//
//   node tools/modaq_regen.mjs <admin link or secret>            dry run
//   node tools/modaq_regen.mjs <admin link or secret> --write    save them
//   (--server <url> for a backend other than production)
//
// Since 10/18/2026 the reader saves, with each upload, the QBJ and game
// files MODAQ's Backup to JSON writes (engine/modaqfile.js), and the hub's
// downloads hand those back as they are. An upload from before then has
// MODAQ's saved game state but not those files. This rebuilds the game the
// way the reader resumes one (mobx-sync, tools/modaq_regen_core.mjs) and
// writes the files with MODAQ's own export code — byte for byte what
// MODAQ's dialog would have written — then saves them beside the upload
// (worker.js saveModaqFiles). The stats' QBJ is never touched.
//
// It also lists the games whose stats QBJ differs from MODAQ's: games with
// questions inserted or replaced mid-game, which qb-td numbers as if
// appended (read_core.js tbRemapMatch) so stats line up with the packet.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const si = args.indexOf('--server');
const server = si >= 0 ? args[si + 1] : 'https://qb-td.denisliu10.workers.dev';
const link = args.find((x, i) => !x.startsWith('--') && args[i - 1] !== '--server');
const secret = link && (/[?&]a=([a-z0-9]+)/.exec(link) || [null, link])[1];
if (!secret || !/^[a-z0-9]{8,}$/.test(secret)) {
  console.error('usage: node tools/modaq_regen.mjs <admin link or secret> [--write] [--server <url>]');
  process.exit(2);
}
const A = `${server}/a/${secret}`;

// MODAQ's code, bundled for node
const out = path.join(root, '.cache', 'modaq-regen.mjs');
await build({ entryPoints: [path.join(root, 'tools', 'modaq_regen_core.mjs')], bundle: true, platform: 'node',
  format: 'esm', outfile: out, logLevel: 'warning' });
const { regenerate } = await import(out);

const d = await (await fetch(A)).json();
if (!d.tournament) { console.error('not an admin link'); process.exit(1); }
const rooms = new Map(d.buckets.map((b) => [b.id, b.room_name]));
const files = d.files.filter((f) => f.kind === 'combined' && !f.error);
// order-free comparison
const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, canon(x[k])])) : x);
const res = { had: 0, saved: 0, same: 0, differs: [], noState: [], failed: [] };
let i = 0;
async function work() {
  while (i < files.length) {
    const f = files[i++];
    const label = { id: f.id, round: f.round, room: rooms.get(f.bucket_id),
      teams: (() => { try { return JSON.parse(f.summary).teams.join(' vs '); } catch (e) { return f.filename; } })() };
    try {
      const whole = await (await fetch(`${A}/file?key=${encodeURIComponent(f.r2_key)}&dl=x`)).json();
      if (!whole.game) { res.noState.push(label); continue; }
      const exp = await regenerate(JSON.stringify(whole.game), f.round);
      if (JSON.stringify(canon(JSON.parse(exp.qbj))) === JSON.stringify(canon({ ...whole.qbj, _round: f.round }))) res.same++;
      else {
        const tb = whole.tb && Array.isArray(whole.tb.used) && whole.tb.used.length ? ` (${whole.tb.used.join(', ')})` : '';
        res.differs.push({ ...label, why: 'questions inserted or replaced mid-game' + tb });
      }
      if (whole.modaq) { res.had++; continue; }
      if (!write) continue;
      const r = await fetch(`${A}/files/${f.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modaq: { qbj: exp.qbj, game: exp.game } }) });
      if (!r.ok) throw new Error(`save: ${r.status} ${await r.text()}`);
      res.saved++;
    } catch (e) { res.failed.push({ ...label, err: String((e && e.message) || e).slice(0, 160) }); }
  }
}
await Promise.all(Array.from({ length: 4 }, work));

const by = (a, b) => a.round - b.round || String(a.room).localeCompare(String(b.room)) || a.id - b.id;
console.log(`${d.tournament.name}: ${files.length} reader uploads`);
console.log(`  ${res.had} already carry MODAQ's files; ${write ? res.saved + ' saved now' : (files.length - res.had - res.noState.length - res.failed.length) + ' would be saved (dry run: add --write)'}`);
console.log(`  ${res.same} have stats the same as MODAQ's QBJ; ${res.differs.length} differ:`);
for (const x of res.differs.sort(by)) console.log(`    round ${x.round}, ${x.room}: ${x.teams} (file ${x.id}) — ${x.why}`);
for (const x of res.noState.sort(by)) console.log(`  no saved game, left as it is: round ${x.round}, ${x.room}: ${x.teams} (file ${x.id})`);
for (const x of res.failed.sort(by)) console.log(`  FAILED round ${x.round}, ${x.room}: ${x.teams} (file ${x.id}) — ${x.err}`);
process.exit(res.failed.length ? 1 : 0);
