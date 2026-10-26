// hub_ab_day.js — the TD hub's stats and downloads before and after the
// 10/25/2026 batching (Compute stats on the games' public copies, the QBJ
// bundle and Rebuild ten uploads to a request, the roster read once),
// side by side through a whole tournament day. ACF Fall at UIUC is played
// again from its archive (app/archive/acf-fall-uiuc.js: 195 uploads, 12
// rounds, 11 rooms, its roster and schedule), each reader upload carrying
// its round's real packet as MODAQ's does, against a local Worker.
//
// Two TD laptops (two headless Chromes) keep the Live Hub open all day,
// one on the hub as it was (the files in BEFORE_FILES at QBTD_BEFORE,
// default 0c43911), one on the hub now, and never reload until the last
// checkpoint, so each tab's caches carry through the day as a TD's would.
// Both talk to the same Worker (the change only adds a route to it).
//
// At each checkpoint both tabs refresh, press Compute, and download all
// of it: the YellowFruit 4 and 3 files, the HTML report (zip and six
// files), the QBJ bundle. The stats table and every file must be the
// same, byte for byte. Along the way, the day has what a real one has:
// re-uploads (the archive's own, plus a re-export and one with its teams
// the other way round), a game filed under the wrong round and moved, an
// upload that isn't a game, a MODAQ game file added by hand, a team
// renamed in the roster mid-day, the stats picked by stage and by
// finished rounds, Rebuild (the bodies it posts must match), and the
// playoff and Finals fills (each tab fills the same placeholder schedule
// in turn: the schedules it saves must match). The last checkpoint
// reloads both tabs, so the cold path is held to the warm one too.
//
// Each action's Worker requests are counted per tab and printed.
//
//   node tests/hub_ab_day.js
//
// QBTD_PROD=1 runs it on production instead: the hub after is the live
// pages (qbsuite.github.io), the hub before is served here and talks to
// the production Worker from a Chrome without web security (the Worker
// answers the real pages' origin only). The tournament is a qbtd-sim-
// one, never listed, never published; its packets are synthetic text of
// the real ones' size; no link secret is printed (its admin secret goes
// to QBTD_ADMIN_FILE, default ../qbtd-soak/hub_ab_prod.admin). No cron
// ticks: production's own run.
//
// Ports: QBTD_PORT_BASE (9681): the Worker, +1 the pages, +8 the Worker's
// inspector. Needs Chrome (CHROME=<path> to move it).

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, staticServer, until } from './cdp_lib.mjs';
import { archiveFixture } from './games_fixtures.mjs';
import { readZip } from '../app/engine/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEFORE = process.env.QBTD_BEFORE || '0c43911';
// what the batching changed on the pages; everything else is shared
const BEFORE_FILES = ['app/js/admin.js', 'app/js/hubgames.js', 'app/js/demo.js'];
const PROD = !!process.env.QBTD_PROD;
const PROD_WORKER = 'https://qb-td.denisliu10.workers.dev';
const PROD_PAGES = 'https://qbsuite.github.io/qb-td/app';
const PORT0 = Number(process.env.QBTD_PORT_BASE || 9681);
// link secrets out of anything printed
const hide = (x) => String(x).replace(/\/([abis])\/[A-Za-z0-9_-]{8,}/g, '/$1/…').replace(/([?&](a|b)=)[A-Za-z0-9_-]{8,}/g, '$1…');
const PORT = { worker: PORT0, pages: PORT0 + 1, inspector: PORT0 + 8 };
const SLUG = 'acf-fall-uiuc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ok ' + name); } else { failed++; console.log('FAIL ' + name + (detail ? ' ' + detail : '')); }
};

/* ---------- the stack: a local Worker, both versions of the pages ---------- */

const tmp = mkdtempSync(path.join(tmpdir(), 'qbtd-ab-'));
const kids = [];
const wenv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };
let pages = null;
function stopAll() {
  for (const k of kids.splice(0)) {
    try { process.kill(-k.pid, 'SIGTERM'); } catch (e) { try { k.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  }
  if (pages) { try { pages.server.close(); } catch (e) { /* closed */ } pages = null; }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const pagesRoot = path.join(tmp, 'pages');
mkdirSync(pagesRoot);
symlinkSync(path.join(ROOT, 'app'), path.join(pagesRoot, 'after'));
cpSync(path.join(ROOT, 'app'), path.join(pagesRoot, 'before'), { recursive: true });
for (const f of BEFORE_FILES) {
  writeFileSync(path.join(pagesRoot, 'before', f.slice('app/'.length)), execFileSync('git', ['show', `${BEFORE}:${f}`], { cwd: ROOT }));
}

const PAGES = `http://127.0.0.1:${PORT.pages}`;
const BASE = PROD ? PROD_WORKER : `http://127.0.0.1:${PORT.worker}`;
if (!PROD) {
  const state = path.join(tmp, 'state');
  mkdirSync(state);
  const wdir = path.join(ROOT, 'worker');
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'qb-td', '--local', '--file', 'schema.sql', '--persist-to', state], { cwd: wdir, env: wenv, stdio: 'ignore' });
  const wlog = openSync(path.join(tmp, 'wrangler_dev.log'), 'a');
  kids.push(spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT.worker), '--ip', '127.0.0.1', '--test-scheduled',
    '--persist-to', state, '--var', `ALLOWED_ORIGIN:${PAGES}`, '--show-interactive-dev-session=false',
    '--inspector-port', String(PORT.inspector)], { cwd: wdir, env: wenv, stdio: ['ignore', wlog, wlog], detached: true }));
}
pages = await staticServer(pagesRoot, PORT.pages);
await until(async () => (await fetch(BASE + '/')).status < 500, 'the Worker to answer (see ' + path.join(tmp, 'wrangler_dev.log') + ')', 120000);
console.log(`hub before: ${BEFORE} (${BEFORE_FILES.join(', ')}), served here; hub after: ${PROD ? PROD_PAGES : 'this checkout'}\nWorker ${BASE}, scratch ${tmp}`);

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; }
  const res = await fetch(BASE + p, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${hide(p)}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const tick = async () => { if (PROD) return; const r = await fetch(BASE + '/__scheduled'); await r.text(); };

/* ---------- the tournament, from its archive ---------- */

const fx = await archiveFixture(SLUG);
const packets = {};
for (let n = 1; n <= 13; n++) {
  try { packets[n] = JSON.parse(readFileSync(path.join(ROOT, 'app/archive/packets', SLUG, `r${n}.json`), 'utf8')); } catch (e) { /* none */ }
  // on production, text of the same size that says nothing
  if (PROD && packets[n]) {
    const fill = (str, label) => (label + ' ' + 'lorem ipsum dolor sit amet '.repeat(Math.ceil(String(str || '').length / 27))).slice(0, Math.max(String(str || '').length, label.length));
    packets[n] = {
      tossups: packets[n].tossups.map((t, i) => ({ ...t, question: fill(t.question, `Synthetic round ${n} tossup ${i + 1}.`), answer: fill(t.answer, `answer ${i + 1}`) })),
      bonuses: (packets[n].bonuses || []).map((b, i) => ({ ...b, leadin: fill(b.leadin, `Synthetic bonus ${i + 1}.`),
        parts: (b.parts || []).map((x, k) => fill(x, `Part ${k + 1}.`)), answers: (b.answers || []).map((x, k) => fill(x, `answer ${k + 1}`)) })),
    };
  }
}
const slug = PROD ? `qbtd-sim-1026-hub-${Math.random().toString(36).slice(2, 6)}` : SLUG;
const T = await call('/api/tournaments', { method: 'POST', json: { name: PROD ? 'Hub batching check (sim)' : fx.name, slug } });
const A = '/a/' + T.admin_secret;
if (PROD) {
  const f = process.env.QBTD_ADMIN_FILE || path.join(ROOT, '..', 'qbtd-soak', 'hub_ab_prod.admin');
  writeFileSync(f, JSON.stringify({ slug, admin_secret: T.admin_secret, at: new Date().toISOString() }) + '\n', { flag: 'a' });
  console.log(`tournament ${slug} (admin secret in ${path.basename(f)})`);
}
await call(A, { method: 'POST', json: { settings: fx.format } });
const roomNames = [...new Set(fx.schedule.rooms.map((r) => r.name).concat(fx.entries.map((e) => e.room)))];
const rooms = {};
for (const name of roomNames) rooms[name] = await call(A + '/buckets', { method: 'POST', json: { room_name: name } });
let roster = structuredClone(fx.rosterQbj);
await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(roster) });
for (const [n, p] of Object.entries(packets)) await call(`${A}/packet?round=${n}&name=Round_${n}.json`, { method: 'POST', body: JSON.stringify(p) });
// the schedule as it was before the day: the playoff and Finals slots
// say where their teams come from, and no one is in them yet
const placeholders = (s) => {
  const out = unfill(s, 1);
  out.rooms = out.rooms.map((r) => ({ ...r, bucket: rooms[r.name].id }));
  return out;
};
// the schedule with the slots of phase `from` on emptied again, and the
// notes of those fills: a filled slot is { team, from: <its label> }
// (finals.js), back to { label }; a pool's note goes with the playoffs
// (phase 1), a bracket's with the Finals
function unfill(s, from) {
  const out = structuredClone(s);
  const open = (slot) => (slot && slot.from ? { label: slot.from } : slot);
  out.phases.forEach((ph, i) => {
    if (i < from) return;
    for (const r of ph.rounds) {
      for (const g of r.games) { g.a = open(g.a); g.b = open(g.b); }
      r.byes = (r.byes || []).map(open);
    }
  });
  out.filled = (out.filled || []).filter((x) => (from <= 1 ? false : !x.bracket));
  if (!out.filled.length) delete out.filled;
  return out;
}
let schedNow = placeholders(fx.schedule);
await call(A + '/schedule', { method: 'POST', json: schedNow });
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: !PROD, current_round: 1 } });

const readerBody = (qbj, round) => {
  const teamNames = qbj.match_teams.map((mt) => mt.team.name);
  const players = qbj.match_teams.flatMap((mt) => (mt.match_players || []).map((mp) => ({ name: mp.player.name, teamName: mt.team.name, isStarter: true })));
  const game = { players, teamNames, packet: packets[round] || packets[1], cycles: [] };
  return { qbj, game: { game, uiState: {} }, modaq: { qbj: JSON.stringify(qbj, null, 4), game: JSON.stringify(game, null, 2) }, protests: [], progress: { at: 20, of: 20 } };
};
const upload = (room, round, filename, body) =>
  call(`/b/${rooms[room].secret}/upload?round=${round}&name=${encodeURIComponent(filename)}`, { method: 'POST', body });
async function playRound(n) {
  await call(A, { method: 'POST', json: { current_round: n } });
  for (const e of fx.entries.filter((x) => x.round === n).sort((x, y) => x.id - y.id)) {
    const body = /\.qbtd\.json$/i.test(e.filename) ? JSON.stringify(readerBody(e.qbj, n)) : JSON.stringify(e.qbj, null, 2);
    await upload(e.room, n, e.filename, body);
  }
  await tick();
}

/* ---------- the two TD laptops ---------- */

// downloads captured in the page (api.js download clicks a blob link),
// hashed there; POST bodies to /bundle (Rebuild) kept; requests in flight
// counted, so a check can wait for the hub to go quiet
const HOOK = `(() => {
  window.__dl = []; window.__blobs = []; window.__posts = []; window.__inflight = 0;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && String(this.href).startsWith('blob:')) {
      const name = this.download;
      const at = window.__dl.push(null) - 1;
      fetch(this.href).then((r) => r.arrayBuffer()).then(async (b) => {
        const h = await crypto.subtle.digest('SHA-256', b);
        window.__blobs[at] = b;
        window.__dl[at] = { name, size: b.byteLength, sha: [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('') };
      });
      return;
    }
    return click.call(this);
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    try { if (init && String(init.method).toUpperCase() === 'POST' && String(input).includes('/bundle')) window.__posts.push(String(init.body)); } catch (e) { /* keep going */ }
    window.__inflight++;
    return f.apply(this, arguments).finally(() => { window.__inflight--; });
  };
})();`;

async function laptop(which) {
  const c = await openChrome(PROD && which === 'before' ? ['--disable-web-security'] : []);
  await c.S('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  c.which = which;
  c.lastAt = {};
  c.bytes = async (at) => Buffer.from(await c.js(`(() => { const u = new Uint8Array(window.__blobs[${at}]); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })()`), 'base64');
  c.workerAsks = () => c.requests.filter((r) => r.url.startsWith(BASE) && r.method !== 'OPTIONS');
  c.open = async () => {
    await c.goto(PROD && which === 'after' ? `${PROD_PAGES}/index.html?a=${T.admin_secret}`
      : `${PAGES}/${which}/index.html?a=${T.admin_secret}&server=${encodeURIComponent(BASE)}`);
    await c.waitJs(`!!document.querySelector('.hubtab')`, which + ': the hub', 60000);
    if (!(await c.js(`!!document.querySelector('.biground')`))) await c.click('[data-view="live"]');
    await c.waitJs(`!!document.querySelector('#calc')`, which + ': the Live Hub', 60000).catch(async (e) => {
      throw new Error(hide(e.message + ' — page: ' + (await c.js('document.body.innerText')).slice(0, 300) + ' | errors: ' + c.errors.join(' | ') + ' | requests: ' + c.requests.slice(-8).map((r) => r.method + ' ' + r.url).join(' ; ')));
    });
    await c.settle();
  };
  // quiet: nothing in flight for half a second
  c.settle = async () => {
    let quietSince = 0;
    await until(async () => {
      const n = await c.js('window.__inflight');
      if (n) { quietSince = 0; return false; }
      quietSince ||= Date.now();
      return Date.now() - quietSince > 500;
    }, which + ': the hub to go quiet', 120000);
  };
  c.refresh = async () => { await c.js(`document.dispatchEvent(new Event('visibilitychange')); true`); await sleep(100); await c.settle(); };
  c.busy = () => c.js(`!!document.querySelector('[aria-busy="true"]')`);
  c.compute = async () => {
    await c.click('#calc');
    await sleep(50);
    await until(async () => !(await c.busy()) && (await c.js(`/in these stats$|No games|No readable/.test((document.querySelector('#statsnote') || {}).textContent || '') || /No readable/.test(document.querySelector('#statsout').textContent)`)),
      which + ': Compute', 120000);
    await c.settle();
    return c.js(`({ html: document.querySelector('#statsout').innerHTML, note: (document.querySelector('#statsnote') || {}).textContent || '' })`);
  };
  // each download in turn, as the TD clicks it: [{ name, size, sha }]
  c.downloads = async (ids = ['dlyft4', 'dlyft3', 'dlreport', 'dlreportfiles', 'dlzip']) => {
    const out = {};
    for (const id of ids) {
      if (await c.js(`document.querySelector('#${id}').disabled`)) { out[id] = 'off'; continue; }
      const n0 = await c.js('window.__dl.length');
      const want = id === 'dlreportfiles' ? 6 : 1;
      await c.click('#' + id);
      await until(async () => !(await c.busy()) && (await c.js(`window.__dl.length >= ${n0 + want} && window.__dl.slice(${n0}).every(Boolean)`)), which + ': ' + id, 180000);
      out[id] = await c.js(`window.__dl.slice(${n0})`);
      c.lastAt[id] = n0;
    }
    await c.settle();
    return out;
  };
  c.rebuild = async () => {
    const n0 = await c.js('window.__posts.length');
    await c.click('#rebuild');
    await c.waitJs(`/Stats data rebuilt/.test(document.querySelector('#msg').textContent)`, which + ': Rebuild', 180000);
    await c.settle();
    return c.js(`window.__posts.slice(${n0})`);
  };
  // the TD typing in a field: the hub's own refresh holds off meanwhile
  c.hold = () => c.js(`document.querySelector('#curround').focus(); true`);
  c.release = () => c.js(`document.activeElement && document.activeElement.blur(); true`);
  return c;
}

const before = await laptop('before');
const after = await laptop('after');
await before.open();
await after.open();

const counts = [];
// runs fn on each tab in turn, counting the Worker requests each makes
async function both(label, fn) {
  const res = {};
  const row = { label };
  for (const c of [before, after]) {
    const n0 = c.workerAsks().length;
    res[c.which] = await fn(c);
    row[c.which] = c.workerAsks().length - n0;
  }
  counts.push(row);
  return res;
}
const same = (label, r) => {
  const b = JSON.stringify(r.before);
  const a = JSON.stringify(r.after);
  ok(label, b === a, b === a ? '' : `\n     before: ${b.slice(0, 400)}\n     after:  ${a.slice(0, 400)}`);
  return b === a;
};
// the entries two zips of the last downloads differ in
async function zipDiff(id) {
  for (const c of [before, after]) if (c.failures.length) console.log(hide(`     ${c.which} tab, requests that failed: ${JSON.stringify(c.failures.slice(-4))}`));
  const [zb, za] = [await readZip(new Uint8Array(await before.bytes(before.lastAt[id]))), await readZip(new Uint8Array(await after.bytes(after.lastAt[id])))];
  const text = (e) => (typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
  const mb = new Map(zb.map((e) => [e.name, text(e)]));
  const ma = new Map(za.map((e) => [e.name, text(e)]));
  for (const n of mb.keys()) if (!ma.has(n)) console.log(`     only before: ${n} (${mb.get(n).length} chars)`);
  for (const n of ma.keys()) if (!mb.has(n)) console.log(`     only after:  ${n} (${ma.get(n).length} chars)`);
  for (const [n, t] of mb) if (ma.has(n) && ma.get(n) !== t) console.log(`     differs:     ${n} (${t.length} vs ${ma.get(n).length} chars)`);
  if (JSON.stringify([...mb.keys()]) !== JSON.stringify([...ma.keys()]) && mb.size === ma.size) console.log('     same entries, another order');
}
async function checkpoint(label, { downloads = true } = {}) {
  console.log(`\n# ${label}`);
  await both(label + ': refresh', (c) => c.refresh());
  const stats = await both(label + ': Compute', (c) => c.compute());
  same(label + ': the stats table', stats);
  ok(label + ': the stats have games', /in these stats$/.test(stats.after.note), stats.after.note);
  if (downloads) {
    const dl = await both(label + ': all five downloads', (c) => c.downloads());
    for (const id of Object.keys(dl.after)) {
      if (!same(`${label}: ${id}`, { before: dl.before[id], after: dl.after[id] }) && (id === 'dlzip' || id === 'dlreport')) await zipDiff(id);
    }
  }
  return stats;
}

/* ---------- the day ---------- */

// the schedule as saved, without its save time
const savedSchedule = async () => {
  const s = await call(`${A}/file?key=${encodeURIComponent(`t/${T.id}/schedule.json`)}`);
  delete s.updated;
  return s;
};
// Each tab fills the stage on its own, in turn. Both are held (the TD
// typing in a field, so the hub's refresh waits) from before the stage's
// last games went in; each is let go alone and refreshed, sees them, and
// fills the saved schedule; the next starts from the same empty slots.
async function fillsMatch(label, phase) {
  const placed = (s) => s.phases[phase].rounds.flatMap((r) => r.games).filter((g) => g.a && g.b && g.a.team && g.b.team).length;
  const start = await savedSchedule();
  const got = {};
  for (const c of [before, after]) {
    await call(A + '/schedule', { method: 'POST', json: start });
    const n0 = c.workerAsks().length;
    await c.release();
    await c.refresh();
    await until(async () => placed(await savedSchedule()) > placed(start), `${c.which}: ${label}`, 60000).catch(() => null);
    await c.settle();
    await c.hold();
    got[c.which] = await savedSchedule();
    const note = await c.js(`[...document.querySelectorAll('.playoffnote')].map((e) => e.innerText).join(' / ')`);
    console.log(`     (${c.which} tab: ${placed(got[c.which])} placed of ${got[c.which].phases[phase].rounds.flatMap((r) => r.games).length}, from ${placed(start)}${note ? '; the hub says: ' + note.replace(/\s+/g, ' ').slice(0, 300) : ''})`);
    counts.push({ label: `${label} (${c.which} tab)`, [c.which]: c.workerAsks().length - n0 });
  }
  for (const c of [before, after]) await c.release();
  ok(`${label}: filled (${placed(got.after)} games placed)`, placed(got.after) > placed(start));
  same(`${label}: the same schedule saved`, got);
}

console.log('\n# prelims, rounds 1-3');
for (let n = 1; n <= 3; n++) await playRound(n);
await checkpoint('after round 3');

console.log('\n# rounds 4-5, with what a day brings');
await playRound(4);
await playRound(5);
{
  const r5 = fx.entries.filter((e) => e.round === 5);
  // a re-export of a game already in
  await upload(r5[0].room, 5, r5[0].filename, JSON.stringify(readerBody(r5[0].qbj, 5)));
  // the same game again as a bare .qbj, the teams the other way round
  const swapped = { ...structuredClone(r5[1].qbj), match_teams: [...r5[1].qbj.match_teams].reverse() };
  const names = swapped.match_teams.map((mt) => mt.team.name.replace(/\W+/g, '_'));
  await upload(r5[1].room, 5, `Round_5_${names[0]}_${names[1]}.qbj`, JSON.stringify(swapped, null, 2));
  // MODAQ's game file, added by hand
  await upload(r5[2].room, 5, r5[2].filename.replace(/\.qbtd\.json$/i, '_Game.json'), readerBody(r5[2].qbj, 5).modaq.game);
  // files that aren't games
  await upload(r5[3].room, 5, 'Round_5_broken.qbj', '{"not": "a game"');
  await upload(r5[3].room, 5, 'scoresheet.pdf', 'PDF'.repeat(100));
}
await checkpoint('after round 5');
// the stats picked by finished rounds, then by stage: Prelims only
await both('pick: finished rounds', (c) => c.js(`(() => { const e = document.querySelector('input[name="statmode"][value="finished"]'); e.click(); return true; })()`));
same('pick finished rounds: the stats table', await both('pick finished rounds: read', (c) => c.js(`document.querySelector('#statsout').innerHTML + '|' + document.querySelector('#statsnote').textContent`)));
{
  const dl = await both('pick finished rounds: downloads', (c) => c.downloads());
  for (const id of Object.keys(dl.after)) if (!same(`pick finished rounds: ${id}`, { before: dl.before[id], after: dl.after[id] }) && id === 'dlzip') await zipDiff(id);
}
await both('pick: by stage', (c) => c.js(`(() => { document.querySelector('input[name="statmode"][value="stages"]').click(); return true; })()`));

console.log('\n# rounds 6-7: a game filed under the wrong round, then moved');
await call(A, { method: 'POST', json: { current_round: 6 } });
{
  const r6 = fx.entries.filter((e) => e.round === 6).sort((x, y) => x.id - y.id);
  const wrong = await upload(r6[0].room, 5, r6[0].filename, JSON.stringify(readerBody(r6[0].qbj, 6)));
  for (const e of r6.slice(1)) await upload(e.room, 6, e.filename, JSON.stringify(readerBody(e.qbj, 6)));
  await tick();
  await checkpoint('round 6, one game under round 5', { downloads: false });
  await call(`${A}/files/${wrong.id}`, { method: 'POST', json: { round: 6 } });
}
for (const c of [before, after]) await c.hold();
await playRound(7);
await fillsMatch('the playoff fill', 1);
await checkpoint('after the prelims');
await both('refresh after the fill', (c) => c.refresh());

console.log('\n# playoffs, rounds 8-11, a team renamed after round 9');
await playRound(8);
await playRound(9);
{
  // the roster's rename, as the hub's editor saves it: the new name, the
  // old one kept, and the schedule renamed with it
  const reg = roster.objects[0].registrations.find((r) => fx.entries.some((e) => e.round >= 10 && e.qbj.match_teams.some((mt) => mt.team.name === r.name)));
  const from = reg.name;
  const to = from + ' Prime';
  reg.name = to;
  for (const tm of reg.teams || []) if (tm.name === from) { tm.name = to; tm._formerNames = [...new Set([...(tm._formerNames || []), from])]; }
  await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(roster) });
  const sched = await savedSchedule();
  const rename = (o) => (Array.isArray(o) ? o.map(rename) : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === from ? to : rename(v)])) : o);
  await call(A + '/schedule', { method: 'POST', json: rename(sched) });
  console.log(`  (renamed ${from} to ${to})`);
}
await checkpoint('after round 9, a team renamed');
await playRound(10);
for (const c of [before, after]) await c.hold();
await playRound(11);
await fillsMatch('the Finals fill', 2);
await checkpoint('after the playoffs', { downloads: false });
await both('refresh after the fill', (c) => c.refresh());

console.log('\n# the final, and the day\'s end');
await playRound(12);
await checkpoint('end of the day');
same('Rebuild: the same games posted', await both('Rebuild', (c) => c.rebuild()));
const warm = {};
for (const c of [before, after]) warm[c.which] = await c.js(`document.querySelector('#statsout').innerHTML`);

console.log('\n# both laptops reload: the cold path');
await both('reload', (c) => c.open());
const cold = await checkpoint('after a reload');
ok('after a reload: the same stats as before it (before tab)', cold.before.html === warm.before);
ok('after a reload: the same stats as before it (after tab)', cold.after.html === warm.after);
await checkpoint('pressed again, nothing new');

const errs = [...before.errors.map((e) => 'before: ' + e), ...after.errors.map((e) => 'after: ' + e)];
ok('no page errors', !errs.length, hide(errs.join(' | ').slice(0, 600)));

console.log('\nWorker requests per action (each tab):');
console.table(counts.map((r) => ({ action: r.label, before: r.before ?? '', after: r.after ?? '' })));
const total = (k) => counts.reduce((s, r) => s + (r[k] || 0), 0);
console.log(`total: before ${total('before')}, after ${total('after')}`);
writeFileSync(path.join(tmp, 'counts.json'), JSON.stringify(counts, null, 2));

before.close();
after.close();
stopAll();
if (!process.env.QBTD_KEEP) rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
