// e2e_autofill.js — playoff slots that fill themselves, end to end: the
// ACF Fall @ UIUC format (23 teams, pools of 8/8/7, crossover playoffs,
// 11 rooms), games uploaded through room links in a shuffled order, and
// two TD hubs open in Chrome. Same local servers as ui_e2e.js:
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled \
//     --var ALLOWED_ORIGIN:http://localhost:8765
//   cd app && python3 -m http.server 8765
// then: node tests/e2e_autofill.js
// QBTD_SCHEDULE=path.json runs on a saved schedule instead (its teams and
// pools; rooms are remapped to fresh ones).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSchedule, fillPlaceholders, fillReport, hasPlaceholders, mulberry32, prelimRounds } from '../app/engine/schedule.js';
import { aggregate } from '../app/engine/stats.js';
import { BASE, call, d1exec, tick, ok, summary } from './e2e_lib.js';

const PAGES = process.env.QBTD_PAGES || 'http://localhost:8765';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + label);
    await sleep(150);
  }
};

/* ---------- the tournament ---------- */

let sched0;
if (process.env.QBTD_SCHEDULE) sched0 = JSON.parse(readFileSync(process.env.QBTD_SCHEDULE, 'utf8'));
else {
  sched0 = buildSchedule('pools3x2', Array.from({ length: 23 }, (_, i) => 'Team ' + String(i + 1).padStart(2, '0')),
    Array.from({ length: 11 }, (_, i) => ({ name: 'Room ' + (101 + i), bucket: null })));
}
const TEAMS = Object.values(sched0.pools).flat();
d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slug = 'e2eaf-' + Math.random().toString(36).slice(2, 8);
const t = (await call('/api/tournaments', { method: 'POST', json: { name: 'Auto-fill', slug } })).body;
const A = '/a/' + t.admin_secret;
const rooms = [];
for (const r of sched0.rooms) {
  const b = (await call(A + '/buckets', { method: 'POST', json: { room_name: r.name } })).body;
  rooms.push({ id: b.id, secret: b.secret });
}
const sched = { ...structuredClone(sched0), rooms: sched0.rooms.map((r, i) => ({ name: r.name, bucket: rooms[i].id })) };
await call(A + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify({ objects: [{ type: 'Tournament',
  registrations: TEAMS.map((n) => ({ name: n, teams: [{ name: n, players: [0, 1, 2, 3].map((p) => ({ name: n + ' P' + p })) }] })) }] }) });
ok('schedule saved', (await call(A + '/schedule', { method: 'POST', json: sched })).status === 200);
const last = Math.max(...sched.phases.flatMap((p) => p.rounds.map((r) => r.round)));
for (let n = 1; n <= last; n++) await call(`${A}/packet?round=${n}&name=P${n}.pdf`, { method: 'POST', body: 'PDF'.repeat(200) });
await call(A + '/start', { method: 'POST' });
const tid = (await call(A)).body.tournament.id;
const savedSched = async () => (await call(`${A}/file?key=t/${tid}/schedule.json`)).body;

// the day's prelim games: random results, a three-way tie at the top of pool A
const rnd = mulberry32(17);
const PA = sched.pools.A;
const cyc = [[PA[0], PA[1]], [PA[1], PA[2]], [PA[2], PA[0]]];
const games = [];
for (const r of prelimRounds(sched)) {
  for (const g of r.games) {
    const a = g.a.team, b = g.b.team;
    const c = cyc.find(([w, l]) => (w === a && l === b) || (w === b && l === a));
    const top = (x) => PA.slice(0, 3).includes(x);
    const aWins = c ? c[0] === a : top(a) !== top(b) ? top(a) : rnd() < 0.5;
    const tens = [4 + Math.floor(rnd() * 8), 4 + Math.floor(rnd() * 8)];
    if (tens[0] === tens[1]) tens[0]++;
    tens.sort((x, y) => (aWins ? y - x : x - y));
    games.push({ round: r.round, room: g.room, a, b, tens });
  }
}
const matchJson = (g) => {
  const side = (name, n) => ({ team: { name }, bonus_points: n * 10,
    match_players: [0, 1, 2, 3].map((p) => ({ player: { name: name + ' P' + p }, tossups_heard: 20,
      answer_counts: p ? [] : [{ number: n, answer: { value: 10 } }] })) });
  return JSON.stringify({ tossups_read: 20, _round: g.round, match_teams: [side(g.a, g.tens[0]), side(g.b, g.tens[1])] });
};
const upload = (g, tag = '') => call(`/b/${rooms[g.room].secret}/upload?round=${g.round}&name=${
  encodeURIComponent(`Round_${g.round}_${g.a}_${g.b}${tag}.qbj`)}`, { method: 'POST', body: matchJson(g) });
// what the editor's Fill button would make of the same games
const asMatch = (g) => ({ round: g.round, tossupsRead: 20, teams: [
  { name: g.a, points: g.tens[0] * 20, bonusPoints: g.tens[0] * 10, players: [] },
  { name: g.b, points: g.tens[1] * 20, bonusPoints: g.tens[1] * 10, players: [] }] });

/* ---------- Chrome: two hubs ---------- */

const udd = mkdtempSync(path.join(tmpdir(), 'qbtd-af-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); rmSync(udd, { recursive: true, force: true }); } catch (e) { /* gone */ } });
const pf = path.join(udd, 'DevToolsActivePort');
await until(async () => existsSync(pf) && readFileSync(pf, 'utf8').includes('\n'), 'Chrome');
const [port, wsPath] = readFileSync(pf, 'utf8').trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
await new Promise((r) => { ws.onopen = r; });
let mid = 0;
const pend = new Map();
const reqs = [];   // every request the hubs make: [page, method, url]
const errs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') reqs.push([m.sessionId, m.params.request.method, m.params.request.url]);
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++mid;
  pend.set(id, (m) => res(m.result || m.error));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function openHub() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const d of ['Runtime', 'Network', 'Page']) await send(d + '.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: `${PAGES}/index.html?a=${t.admin_secret}&server=${encodeURIComponent(BASE)}` }, sessionId);
  const s = sessionId;
  const ev = async (js) => (await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, s)).result?.value;
  await until(() => ev('!!document.querySelector(".hubtab")'), 'hub loads');
  await ev(`document.querySelector('[data-view="live"]').click()`);
  // the hub refreshes only while it's the visible tab: bring it forward first
  const refresh = async () => {
    await send('Page.bringToFront', {}, s);
    await until(() => ev(`document.visibilityState === 'visible'`), 'tab visible');
    return ev(`document.dispatchEvent(new Event('visibilitychange')); true`);
  };
  // QBTD_SHOTS=dir keeps a screenshot of the hub at each note
  const shot = async (name) => {
    if (!process.env.QBTD_SHOTS) return;
    await send('Page.bringToFront', {}, s);
    const r = await send('Page.captureScreenshot', { format: 'png' }, s);
    writeFileSync(path.join(process.env.QBTD_SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  return { s, ev, refresh, shot };
}
const h1 = await openHub();
const h2 = await openHub();
const gameReads = (s) => reqs.filter(([x, m, u]) => x === s && m === 'GET' && /\/file\?key=/.test(u) && !/schedule\.json|roster/.test(decodeURIComponent(u))).length;
const schedPosts = () => reqs.filter(([, m, u]) => m === 'POST' && /\/schedule$/.test(u)).length;

/* ---------- the day ---------- */

const poolOf = (n) => Object.keys(sched.pools).find((p) => sched.pools[p].includes(n));
// pools finish one at a time: C, then A, then B — each pool's games shuffled
const order = ['C', 'A', 'B'].flatMap((p) => games.filter((g) => poolOf(g.a) === p).sort(() => rnd() - 0.5));
const doneAt = (p) => order.map((g) => poolOf(g.a)).lastIndexOf(p);
let i = 0;
async function upTo(n) {
  for (; i <= n; i++) {
    const r = await upload(order[i]);
    if (r.status !== 200) throw new Error('upload failed: ' + JSON.stringify(r.body));
  }
}
const labels = (s) => [...new Set(JSON.stringify(s).match(/"label":"[A-Z]\d+"/g) || [])].map((x) => x.slice(9, -1)).sort();

// Pool C, all but its last game: nothing fills, no game is read
await upTo(doneAt('C') - 1);
await h1.refresh(); await h2.refresh(); await sleep(1500);
ok('one game short: no game files read, nothing saved', gameReads(h1.s) + gameReads(h2.s) === 0 && schedPosts() === 0,
  [gameReads(h1.s), gameReads(h2.s), schedPosts()]);
ok('…and the slots are still open', hasPlaceholders(await savedSched()));

// Pool C's last game: both hubs refresh at once
await upTo(doneAt('C'));
await h1.refresh(); await h2.refresh();
await until(async () => !labels(await savedSched()).some((l) => l[0] === 'C'), 'pool C filled');
const afterC = await savedSched();
ok('pool C filled; A and B still open', labels(afterC).some((l) => l[0] === 'A') && labels(afterC).some((l) => l[0] === 'B'), labels(afterC));
await sleep(1500);
const cGames = games.filter((g) => poolOf(g.a) === 'C').length;
ok('the hubs read pool C\'s games once each, nothing else', gameReads(h1.s) <= cGames && gameReads(h2.s) <= cGames,
  [gameReads(h1.s), gameReads(h2.s), cGames]);
ok('the hub says so', /pool C/.test(await h1.ev('document.getElementById("msg").textContent') || '')
  || /pool C/.test(await h2.ev('document.getElementById("msg").textContent') || ''));

// Pool A, with a stray: two pool-A teams' game uploaded under a round the schedule has them apart
await upTo(doneAt('A'));
// (a pool-A pairing from round 2, uploaded again as round 1: a wrong round number)
const r2 = games.find((g) => g.round === 2 && poolOf(g.a) === 'A');
const stray = { round: 1, room: 0, a: r2.a, b: r2.b, tens: [9, 5] };
const already = false;
if (!already) await upload(stray, '_stray');
await h1.refresh();
if (!already) {
  await until(() => h1.ev(`!!document.querySelector('[data-fillpool="A"]')`), 'Fill anyway for pool A');
  ok('a game off the schedule: pool A waits, with Fill anyway', labels(await savedSched()).some((l) => l[0] === 'A'));
  await h1.shot('hub-stray');
  const note = await h1.ev(`document.querySelector('.playoffnote').innerText`);
  ok('the note names the game', note.includes(stray.a) && note.includes('isn’t on the schedule'), note);
  // the stray goes away (deleted), and pool A fills on its own
  const d = (await call(A)).body;
  const f = d.files.find((x) => x.filename.includes('_stray'));
  await call(`${A}/files/${f.id}`, { method: 'DELETE' });
  await h1.refresh();
}
await until(async () => !labels(await savedSched()).some((l) => l[0] === 'A'), 'pool A filled').catch(async (e) => {
  console.log('DEBUG already', !!already, 'msg', await h1.ev('document.getElementById("msg").textContent'),
    'note', await h1.ev(`(document.querySelector('.playoffnote')||{}).innerText`), 'errs', errs,
    'labels', labels(await savedSched()).join(' '), 'reqs', reqs.slice(-8).map((x) => x[1] + ' ' + decodeURIComponent(x[2]).slice(0, 120)));
  throw e;
});
ok('pool A filled; B still open', labels(await savedSched()).some((l) => l[0] === 'B'));

// the three-way tie at the top of pool A is noted, by points per 20
await h1.refresh();
await until(() => h1.ev(`(document.querySelector('.playoffnote') || {}).innerText || ''`), 'tie note');
const tieNote = await h1.ev(`document.querySelector('.playoffnote').innerText`);
await h1.shot('hub-tie');
ok('the Live Hub notes pool A\'s tie', /Pool A: .* were tied at 6–1, so points per 20 decided their places\./.test(tieNote), tieNote);

// Pool B, with a stray the TD keeps: Fill anyway counts it
await upTo(order.length - 1);
const b2 = games.find((g) => g.round === 2 && poolOf(g.a) === 'B');
const strayB = { round: 1, room: 1, a: b2.a, b: b2.b, tens: [9, 5] };
await upload(strayB, '_strayB');
await h2.refresh();
await until(() => h2.ev(`!!document.querySelector('[data-fillpool="B"]')`), 'Fill anyway for pool B');
ok('pool B waits for the TD', labels(await savedSched()).some((l) => l[0] === 'B'));
await h2.ev(`document.querySelector('[data-fillpool="B"]').click(); true`);
await until(async () => !hasPlaceholders(await savedSched()), 'all filled');
ok('Fill anyway fills pool B', true);
const final = await savedSched();
const dayGames = [...games, strayB];
const manual = structuredClone(sched);
fillPlaceholders(manual, fillReport(sched, aggregate(dayGames.map(asMatch))).ranks);
const strip = (s) => JSON.stringify({ ...s, filled: undefined, updated: undefined });
ok('the filled schedule is what Fill playoff slots would make', strip(final) === strip(manual));
const tiesWant = fillReport(sched, aggregate(dayGames.map(asMatch))).ties;
ok('each tie points per 20 settled is kept on the schedule for the note, once',
  JSON.stringify((final.filled || []).map((x) => x.pool + ' ' + x.record).sort()) === JSON.stringify(tiesWant.map((x) => x.pool + ' ' + x.record).sort())
  && final.filled.some((x) => x.pool === 'A' && x.record === '6–1'), [final.filled, tiesWant.length]);
const total = dayGames.length + 1;
ok('each hub read each prelim game at most once all day', gameReads(h1.s) <= total && gameReads(h2.s) <= total,
  [gameReads(h1.s), gameReads(h2.s), total]);
ok('a handful of schedule saves', schedPosts() <= 6, schedPosts());

// a room in the first playoff round sees its teams
const pr = Math.min(...final.phases[1].rounds.map((r) => r.round));
const pg = final.phases[1].rounds.find((r) => r.round === pr).games[0];
const rs = (await call(`/b/${rooms[pg.room].secret}/schedule`)).body;
const rg = rs.schedule.phases[1].rounds.find((r) => r.round === pr).games.find((g) => g.room === pg.room);
ok('the reader room gets the filled teams', rg.a.team && rg.b.team && rg.a.from && rg.b.from, rg);

// once a playoff game is in, the note goes
await upload({ round: pr, room: pg.room, a: pg.a.team, b: pg.b.team, tens: [8, 6] });
await h1.refresh();
await until(async () => !(await h1.ev(`!!document.querySelector('.playoffnote')`)), 'note gone');
ok('the note leaves once the playoffs start', true);
ok('no page errors', errs.length === 0, errs);

// leave the dev Worker's publish queue as we found it (it serves four a tick)
for (let k = 0; k < 6; k++) await tick();
summary('auto-fill');
process.exit(process.exitCode || 0);
