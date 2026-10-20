// e2e_saves.js — E10 in the browser: two TD hub tabs on one tournament,
// each saving what the other changed a moment ago (app/js/saves.js,
// worker.js updateGuarded, putSchedule, uploadRoster). A save from a tab
// whose copy is out of date keeps the other tab's change: the settings and
// the rulings merge with no question; the schedule and the roster ask
// first (SCHED_CONFLICT, ROSTER_CONFLICT), and Cancel keeps the edits here
// unsaved. One tab's own saves in a row never ask (ui_e2e.js fails on
// either question too), and a second change made before the first one's
// answer is the TD's last say, as a whole-object save made it.
//   1  settings: a stale catStats toggle keeps another tab's password and
//      its buzz_wrap; a lost statsSeen save is made good by the next one
//   2  MODAQ settings: a stale preset pick, Reset in a stale tab, and Save
//      format then Reset before the refresh in one tab
//   3  rulings: two tabs ruling different protests
//   4  the roster: two editors; an upload matched against a roster saved
//      over since; one tab's editor save with its upload waiting
//   4b one tab, a second change before the first one's answer: auto-advance,
//      a ruling, category stats, the round count, Save pressed twice
//   5  the schedule: two hubs filling the same slots (one save each, no
//      retry); a stale editor Save after another tab's fill (Cancel, then
//      OK); one tab's saves around a room rename and its own fill; a Save
//      after another tab deleted the schedule
// Same local servers as ui_e2e.js:
//   node tools/e2e_stack.mjs --state <new dir> --worker 9613 --pages 9614
// then: QBTD_BASE=… QBTD_PAGES=… QBTD_PERSIST=… QBTD_CDP_PORT=9617 node tests/e2e_saves.js
// The pages get ?server= the local Worker and &live=off, so nothing leaves
// this machine. QBTD_CDP_PORT fixes Chrome's DevTools port (any free one
// otherwise).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSchedule, prelimRounds, hasPlaceholders } from '../app/engine/schedule.js';
import { parseRoster } from '../app/engine/qbj.js';
import { BASE, call, d1exec, d1row, ok, summary } from './e2e_lib.js';
import { routeTemplate } from '../tools/count_proxy.mjs';

const PAGES = process.env.QBTD_PAGES || 'http://localhost:8765';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(100);
  }
};

// saves.js's texts, read from its source (it imports api.js, which needs a page)
const SAVES = readFileSync(new URL('../app/js/saves.js', import.meta.url), 'utf8');
const savesText = (name) => {
  const m = new RegExp(`export const ${name} = ([^;]+);`).exec(SAVES);
  if (!m) throw new Error('saves.js has no ' + name);
  return Function(`"use strict"; return (${m[1]});`)();
};
const SCHED_CONFLICT = savesText('SCHED_CONFLICT');
const SCHED_KEPT = savesText('SCHED_KEPT');
const ROSTER_CONFLICT = savesText('ROSTER_CONFLICT');
const ROSTER_KEPT = savesText('ROSTER_KEPT');
const CONFLICTS = [SCHED_CONFLICT, ROSTER_CONFLICT];

/* ---------- Chrome: one browser, a tab per hub ---------- */

const udd = mkdtempSync(path.join(tmpdir(), 'qbtd-saves-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${process.env.QBTD_CDP_PORT || 0}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); rmSync(udd, { recursive: true, force: true }); } catch (e) { /* gone */ } });
let wsUrl;
if (process.env.QBTD_CDP_PORT) {
  wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${process.env.QBTD_CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl, 'Chrome');
} else {
  const pf = path.join(udd, 'DevToolsActivePort');
  await until(async () => existsSync(pf) && readFileSync(pf, 'utf8').includes('\n'), 'Chrome');
  const [port, wsPath] = readFileSync(pf, 'utf8').trim().split('\n');
  wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let mid = 0;
const pend = new Map();
const tabs = new Map(); // sessionId -> tab
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  const tab = m.sessionId && tabs.get(m.sessionId);
  if (tab) tab.event(m);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++mid;
  pend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// A hub tab. Its schedule or roster question is answered by `answer`
// (true: OK, false: Cancel); null means none is expected, and one showing
// fails the run. Other confirms (Delete the schedule) are accepted.
// hold(request) => true keeps a Worker request paused (Fetch) until free().
async function openTab(name) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  const tab = { name, s, dialogs: [], answer: null, errors: [], reqs: [], hold: null, held: [] };
  tab.event = (m) => {
    if (m.method === 'Page.javascriptDialogOpening') {
      const text = m.params.message;
      tab.dialogs.push(text);
      const conflict = CONFLICTS.includes(text);
      if (conflict && tab.answer === null) ok(`${name}: no question about another tab here`, false, text);
      send('Page.handleJavaScriptDialog', { accept: conflict ? tab.answer === true : true }, s);
    } else if (m.method === 'Runtime.exceptionThrown') {
      tab.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === 'Network.requestWillBeSent') {
      tab.reqs.push({ method: m.params.request.method, url: m.params.request.url, type: m.params.type || '' });
    } else if (m.method === 'Fetch.requestPaused') {
      if (tab.hold && tab.hold(m.params.request)) tab.held.push(m.params);
      else send('Fetch.continueRequest', { requestId: m.params.requestId }, s).catch(() => {});
    }
  };
  tabs.set(s, tab);
  for (const d of ['Runtime', 'Network', 'Page']) await send(d + '.enable', {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  tab.ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  tab.wait = (expr, label, ms) => until(() => tab.ev(expr), name + ': ' + label, ms);
  const q = (x) => JSON.stringify(x);
  tab.click = (sel) => tab.ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.click(); return true; })()`);
  tab.fill = (sel, value, events = ['input', 'change']) => tab.ev(`(() => {
    const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
    e.value = ${q(value)}; for (const t of ${q(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); return true; })()`);
  // a click whose answer shows on the status line: the line cleared first
  tab.press = async (sel) => { await tab.ev(`document.getElementById('msg').textContent = ''; true`); return tab.click(sel); };
  tab.open = async (secret) => {
    await send('Page.navigate', { url: `${PAGES}/index.html?a=${secret}&server=${encodeURIComponent(BASE)}&live=off` }, s);
    await tab.wait(`!!document.querySelector('.hubtab')`, 'the hub');
  };
  tab.view = async (v) => {
    await tab.click(`[data-view="${v}"]`);
    await tab.wait(`document.querySelector('[data-view="${v}"]').classList.contains('on')`, v);
  };
  tab.step = async (step, ready) => {
    await tab.click(`[data-step="${step}"]`);
    await tab.wait(ready, step);
  };
  // the hub refreshes while it is the visible tab, and at once on coming back to it
  tab.front = () => send('Page.bringToFront', {}, s);
  tab.refresh = async () => {
    await send('Page.bringToFront', {}, s);
    await tab.wait(`document.visibilityState === 'visible'`, 'visible');
    return tab.ev(`document.dispatchEvent(new Event('visibilitychange')); true`);
  };
  tab.pause = async (hold) => {
    tab.hold = hold;
    await send('Fetch.enable', { patterns: [{ urlPattern: BASE + '/*' }] }, s);
  };
  // the held requests fail, as on a dropped connection
  tab.failHeld = async () => {
    for (const p of tab.held.splice(0)) await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }, s).catch(() => {});
  };
  tab.free = async () => {
    tab.hold = null;
    for (const p of tab.held.splice(0)) await send('Fetch.continueRequest', { requestId: p.requestId }, s).catch(() => {});
    await send('Fetch.disable', {}, s);
  };
  return tab;
}

/* ---------- the tournaments ---------- */

d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slugOf = (p) => p + Math.random().toString(36).slice(2, 8);
const rosterText = (teams) => JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'Saves',
  registrations: teams.map((n) => ({ name: n, teams: [{ name: n, players: [0, 1, 2, 3].map((p) => ({ name: n + ' P' + p })) }] })) }] });
async function tournament(prefix, teams, nRooms) {
  const t = (await call('/api/tournaments', { method: 'POST', json: { name: 'Saves ' + prefix, slug: slugOf(prefix) } })).body;
  if (!t.admin_secret) throw new Error('create failed: ' + JSON.stringify(t));
  const A = '/a/' + t.admin_secret;
  const rooms = [];
  for (let k = 0; k < nRooms; k++) rooms.push((await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (101 + k) } })).body);
  await call(A + '/roster?name=roster.qbj', { method: 'POST', body: rosterText(teams) });
  const tid = (await call(A)).body.tournament.id;
  return { t, A, rooms, tid, secret: t.admin_secret };
}
const matchJson = (g, extra = {}) => {
  const side = (name, n) => ({ team: { name }, bonus_points: n * 10,
    match_players: [0, 1, 2, 3].map((p) => ({ player: { name: name + ' P' + p }, tossups_heard: 20,
      answer_counts: p ? [] : [{ number: n, answer: { value: 10 } }] })) });
  return { tossups_read: 20, _round: g.round, match_teams: [side(g.a, g.tens[0]), side(g.b, g.tens[1])], ...extra };
};
const settingsIn = async (T) => JSON.parse((await call(T.A)).body.tournament.settings || '{}');
const rulingsIn = async (T) => JSON.parse((await call(T.A)).body.tournament.rulings || '{}');
const storedSched = async (T) => { const r = await call(`${T.A}/file?key=t/${T.tid}/schedule.json`); return r.status === 200 ? r.body : null; };
const storedRoster = async (T) => parseRoster((await call(`${T.A}/file?key=t/${T.tid}/roster.qbj`)).body);
const schedPosts = (tab, since = 0) => tab.reqs.slice(since).filter((r) => r.method === 'POST' && /\/schedule$/.test(r.url));

const A = await openTab('tab A');
const B = await openTab('tab B');

/* ---------- 1. settings: a stale catStats toggle keeps the password ---------- */

const T2 = await tournament('sv2-', ['Alpha', 'Beta', 'Gamma', 'Delta'], 2);
await call(`${T2.A}/packet?round=1&name=P1.pdf`, { method: 'POST', body: 'PDF'.repeat(200) });
await call(T2.A + '/start', { method: 'POST' });
// two games of round 1 with a protest each (reader uploads)
const protest = (q, team, other) => ({ kind: 'tu', q, team, word: 12, given: 'an answer', reason: 'The answer line accepts it',
  to: team, from: other, gain: 10, loss: 0, detail: { tu: 10, neg: 0, bonus: 0, oppTu: 0, oppBonus: 0 } });
for (const [k, g] of [[0, { round: 1, a: 'Alpha', b: 'Beta', tens: [8, 5] }], [1, { round: 1, a: 'Gamma', b: 'Delta', tens: [7, 6] }]]) {
  const r = await call(`/b/${T2.rooms[k].secret}/upload?round=1&name=${encodeURIComponent(`Round_1_${g.a}_${g.b}.qbtd.json`)}`,
    { method: 'POST', body: JSON.stringify({ qbj: matchJson(g), game: { cycles: [] }, protests: [protest(3 + k, g.b, g.a)] }) });
  if (r.status !== 200) throw new Error('upload failed: ' + JSON.stringify(r.body));
}
// tab A first, so one hub makes the bye room
await A.open(T2.secret);
await until(async () => Number.isInteger((await settingsIn(T2)).byeRoom), 'the bye room');
// opening Public page marks it seen (statsSeen, the setup checklist): when
// that save is lost, the section's next save stores it
await A.view('setup');
await A.pause((r) => r.method === 'POST' && new URL(r.url).pathname === '/a/' + T2.secret);
await A.step('stats', `!!document.querySelector('#catstats')`);
await until(() => A.held.length > 0, 'the statsSeen save, held');
await A.failHeld();
await A.free();
ok('1 settings: the statsSeen save was lost', (await settingsIn(T2)).statsSeen === undefined);
await A.fill('#catstats', 'off', ['change']);
await until(async () => (await settingsIn(T2)).catStats === false, 'catStats off');
ok('1 settings: the next save in the section stores statsSeen too', (await settingsIn(T2)).statsSeen === true);
await A.wait(`document.querySelector('#catstats').value === 'off'`, 'redrawn');
await A.fill('#catstats', 'on', ['change']);
await until(async () => !('catStats' in (await settingsIn(T2))), 'catStats on again');
await B.open(T2.secret);
await B.view('setup');
await B.step('stats', `!!document.querySelector('#catstats')`);
await sleep(500);
// A sets a password with buzzpoints on; B still shows none
await A.fill('#buzzmode', 'on', ['change']);
await A.wait(`!!document.querySelector('#statspw')`, 'the password field');
await A.fill('#statspw', 'hunter2', ['input']);
await A.click('#pwset');
await until(async () => { const s = await settingsIn(T2); return s.buzz && s.buzz.mode === 'password' && s.buzz.hash; }, 'the password saved');
const withPw = await settingsIn(T2);
const wrap1 = d1row(`SELECT buzz_wrap FROM tournaments WHERE id = ${T2.tid}`).buzz_wrap;
ok('1 settings: tab B still shows the copy from before the password', await B.ev(`!document.querySelector('#pwchange')`));
await B.fill('#catstats', 'off', ['change']);
await until(async () => (await settingsIn(T2)).catStats === false, 'catStats off saved');
{
  const s = await settingsIn(T2);
  const wrap2 = d1row(`SELECT buzz_wrap FROM tournaments WHERE id = ${T2.tid}`).buzz_wrap;
  ok('1 settings: a stale catStats toggle keeps the password and buzzpoints (tab A\'s change)',
    JSON.stringify(s.buzz) === JSON.stringify(withPw.buzz) && s.buzz.mode === 'password', [s.buzz, withPw.buzz]);
  ok('1 settings: …and the key buzzpoints unlock with is the one the password made', !!wrap1 && wrap2 === wrap1);
  ok('1 settings: no question asked', !A.dialogs.length && !B.dialogs.length, [A.dialogs, B.dialogs]);
}

/* ---------- 2. MODAQ settings: the preset and its overrides go together ---------- */

for (const tab of [A, B]) {
  await tab.view('setup');
  await tab.step('modaq', `!!document.querySelector('#gformat')`);
}
await sleep(300);
// a stale preset pick after tab A saved overrides: tab B's {preset, no overrides}
await A.fill('#fmttossups', '22', ['input']);
await A.click('#fmtsave');
await until(async () => { const s = await settingsIn(T2); return s.formatOverrides && s.formatOverrides.regulationTossupCount === 22; }, 'overrides saved');
ok('2 format: tab B still shows no overrides', await B.ev(`![...document.querySelectorAll('#setupsec .pill')].some((e) => e.textContent === 'Custom')`));
await B.fill('#gformat', 'pace', ['change']);
await until(async () => (await settingsIn(T2)).gameFormat === 'pace', 'pace saved');
{
  const s = await settingsIn(T2);
  ok('2 format: a stale preset pick stores that preset, without the other tab\'s overrides', s.gameFormat === 'pace' && !('formatOverrides' in s), s);
  ok('2 format: the other keys stay (catStats, the password)', s.catStats === false && JSON.stringify(s.buzz) === JSON.stringify(withPw.buzz));
}
// Reset to preset in a stale tab: tab A saves overrides, tab B resets
await A.wait(`!!document.querySelector('#fmttossups')`, 'redrawn');
await sleep(300);
await A.fill('#fmttossups', '21', ['input']);
await A.click('#fmtsave');
await until(async () => { const s = await settingsIn(T2); return s.formatOverrides && s.formatOverrides.regulationTossupCount === 21; }, 'overrides saved again');
await B.wait(`!!document.querySelector('#fmtreset')`, 'B redrawn');
await B.click('#fmtreset');
await until(async () => !('formatOverrides' in (await settingsIn(T2))), 'reset saved', 8000).catch(() => null);
{
  const s = await settingsIn(T2);
  ok('2 format: Reset to preset in a stale tab clears the overrides another tab saved', !('formatOverrides' in s), s);
}
// one tab: Save format, then Reset before the refresh after the save lands
// (from a stored copy with no overrides: the one Reset can't tell apart)
{
  const s = await settingsIn(T2);
  delete s.formatOverrides;
  await call(T2.A, { method: 'POST', json: { settings: s } });
}
await A.open(T2.secret);
await A.view('setup');
await A.step('modaq', `!!document.querySelector('#fmttossups')`);
await A.pause((r) => r.method === 'GET' && new URL(r.url).pathname === '/a/' + T2.secret);
await A.fill('#fmttossups', '23', ['input']);
await A.click('#fmtsave');
await until(async () => { const s = await settingsIn(T2); return s.formatOverrides && s.formatOverrides.regulationTossupCount === 23; }, 'overrides 23 saved');
await until(() => A.held.length > 0, 'the refresh after the save, held');
await A.click('#fmtreset');
await until(async () => !('formatOverrides' in (await settingsIn(T2))), 'reset after save', 8000).catch(() => null);
{
  const s = await settingsIn(T2);
  ok('2 format: one tab, Save format then Reset before the refresh: the overrides go', !('formatOverrides' in s), s);
}
await A.free();
ok('2 format: no question asked', !A.dialogs.length && !B.dialogs.length, [A.dialogs, B.dialogs]);

/* ---------- 3. rulings: two tabs ruling different protests ---------- */

await A.open(T2.secret);
await B.open(T2.secret);
for (const tab of [A, B]) {
  await tab.view('live');
  await tab.wait(`document.querySelectorAll('#protdrawer [data-rule]').length === 2`, 'the two protests');
}
const [k1, k2] = await A.ev(`[...document.querySelectorAll('#protdrawer [data-rule]')].map((e) => e.dataset.rule)`);
await A.fill(`#protdrawer [data-rule="${k1}"]`, 'upheld', ['change']);
await until(async () => ((await rulingsIn(T2))[k1] || {}).r === 'upheld', 'A\'s ruling');
ok('3 rulings: tab B still shows the first protest open', await B.ev(`document.querySelector('#protdrawer [data-rule="${k1}"]').value === 'open'`));
await B.fill(`#protdrawer [data-rule="${k2}"]`, 'denied', ['change']);
await until(async () => ((await rulingsIn(T2))[k2] || {}).r === 'denied', 'B\'s ruling');
{
  const r = await rulingsIn(T2);
  ok('3 rulings: both rulings are kept', r[k1] && r[k1].r === 'upheld' && r[k2] && r[k2].r === 'denied', r);
}

/* ---------- 4. the roster: two editors ---------- */

for (const tab of [A, B]) {
  await tab.view('setup');
  await tab.step('roster', `!!document.querySelector('#editroster')`);
  await tab.click('#editroster');
  await tab.wait(`document.querySelectorAll('[data-tname]').length === 4`, 'the roster editor');
}
await A.fill('[data-tname="0"]', 'Alpha Prime', ['input']);
await A.press('#rostersave');
await until(async () => (await storedRoster(T2))[0].name === 'Alpha Prime', 'A\'s roster');
await B.fill('[data-pname="1.0"]', 'Beta Newcomer', ['input']);
B.answer = false;
await B.press('#rostersave');
await B.wait(`document.getElementById('msg').textContent === ${JSON.stringify(ROSTER_KEPT)}`, 'Roster not saved');
{
  const r = await storedRoster(T2);
  ok('4 roster: the second editor is asked', B.dialogs.filter((x) => x === ROSTER_CONFLICT).length === 1, B.dialogs);
  ok('4 roster: Cancel saves nothing and keeps the edits', r[0].name === 'Alpha Prime' && r[1].players[0] === 'Beta P0'
    && await B.ev(`document.querySelector('[data-pname="1.0"]').value === 'Beta Newcomer'`), r.slice(0, 2));
}
B.answer = true;
await B.press('#rostersave');
await until(async () => (await storedRoster(T2))[1].players[0] === 'Beta Newcomer', 'B\'s roster');
{
  const r = await storedRoster(T2);
  ok('4 roster: OK saves this tab\'s version over the other', B.dialogs.filter((x) => x === ROSTER_CONFLICT).length === 2
    && r[0].name === 'Alpha' && r[1].players[0] === 'Beta Newcomer', r.slice(0, 2).map((x) => x.name + ':' + x.players[0]));
}
B.answer = null;
// an upload waiting in tab B while tab A's editor saves: B's save asks
const upPath = path.join(udd, 'upload roster.qbj');
writeFileSync(upPath, JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'Saves',
  registrations: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((n) => ({ name: n, teams: [{ name: n,
    players: [0, 1, 2, 3].map((p) => ({ name: n + ' P' + p })) }] })) }] }));
const pick = async (tab) => {
  const { root } = await send('DOM.getDocument', { depth: 0 }, tab.s);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#rfile' }, tab.s);
  await send('DOM.setFileInputFiles', { nodeId, files: [upPath] }, tab.s);
};
await B.wait(`!!document.querySelector('#rfile')`, 'the roster section');
await pick(B);
await B.wait(`!!document.querySelector('#upconfirm')`, 'the upload preview');
await sleep(500); // the preview's read of the saved roster
await A.open(T2.secret);
await A.view('setup');
await A.step('roster', `!!document.querySelector('#editroster')`);
await A.click('#editroster');
await A.wait(`document.querySelectorAll('[data-tname]').length === 4`, 'the roster editor again');
await A.fill('[data-tname="2"]', 'Gamma Ray', ['input']);
await A.press('#rostersave');
await until(async () => (await storedRoster(T2))[2].name === 'Gamma Ray', 'A\'s second roster');
B.answer = true;
await B.press('#upconfirm');
await until(async () => (await storedRoster(T2)).length === 5, 'the upload saved');
ok('4 roster: an upload matched against a roster saved over since asks, and OK saves it',
  B.dialogs.filter((x) => x === ROSTER_CONFLICT).length === 3, B.dialogs);
B.answer = null;
// one tab: an upload waiting while its own editor saves does not ask
await B.open(T2.secret);
await B.view('setup');
await B.step('roster', `!!document.querySelector('#rfile')`);
await pick(B);
await B.wait(`!!document.querySelector('#upconfirm')`, 'the upload preview again');
await sleep(500);
await B.click('#editroster');
await B.wait(`document.querySelectorAll('[data-tname]').length === 5`, 'B\'s editor');
await B.fill('[data-pname="4.0"]', 'Epsilon Star', ['input']);
await B.press('#rostersave');
await until(async () => (await storedRoster(T2))[4].players[0] === 'Epsilon Star', 'B\'s editor save');
await B.wait(`!!document.querySelector('#upconfirm')`, 'the waiting upload');
await B.press('#upconfirm');
await until(async () => (await storedRoster(T2))[4].players[0] === 'Epsilon P0', 'the upload after the editor');
ok('4 roster: one tab, its own editor save then the waiting upload: no question', B.dialogs.filter((x) => x === ROSTER_CONFLICT).length === 3, B.dialogs);

/* ---------- 4b. one tab: a second change before the first one's answer ---------- */

// tab A's saves to the tournament held at the network, then let through
// in order: the second change is made on the page as the first left it,
// before the answer and the redraw. The second is the TD's last say, as a
// whole-object save always made it.
async function inOrder(tab, T, first, landed, second, done, label) {
  const asked = tab.dialogs.length;
  await tab.pause((r) => r.method === 'POST' && new URL(r.url).pathname === '/a/' + T.secret);
  await first();
  await until(() => tab.held.length === 1, label + ': the first save, held');
  await second();
  await until(() => tab.held.length === 2, label + ': the second save, held');
  const [p1, p2] = tab.held.splice(0);
  await send('Fetch.continueRequest', { requestId: p1.requestId }, tab.s);
  await until(landed, label + ': the first save landed');
  await send('Fetch.continueRequest', { requestId: p2.requestId }, tab.s);
  const ok2 = await until(done, label + ': the second save landed', 8000).catch(() => false);
  await tab.free();
  ok('4b one tab: ' + label, ok2 && tab.dialogs.length === asked, tab.dialogs.slice(asked));
  await sleep(500);
}
await A.open(T2.secret);
await A.view('live');
await A.wait(`!!document.querySelector('#autoadv')`, 'the auto-advance switch');
const autoOn = (await settingsIn(T2)).autoAdvance === true;
await inOrder(A, T2, () => A.click('#autoadv'), async () => ((await settingsIn(T2)).autoAdvance === true) !== autoOn,
  () => A.click('#autoadv'), async () => ((await settingsIn(T2)).autoAdvance === true) === autoOn,
  'auto-advance switched and switched back');
await A.wait(`document.querySelectorAll('#protdrawer [data-rule]').length === 2`, 'the protests');
const sel = (k) => `#protdrawer [data-rule="${k}"]`;
await inOrder(A, T2, () => A.fill(sel(k1), 'denied', ['change']), async () => ((await rulingsIn(T2))[k1] || {}).r === 'denied',
  () => A.fill(sel(k1), 'upheld', ['change']), async () => ((await rulingsIn(T2))[k1] || {}).r === 'upheld',
  'a ruling changed and changed back');
await A.view('setup');
await A.step('stats', `!!document.querySelector('#catstats')`);
{
  const was = (await settingsIn(T2)).catStats === false ? 'off' : 'on';
  const other = was === 'on' ? 'off' : 'on';
  const isOff = async () => (await settingsIn(T2)).catStats === false;
  await A.wait(`document.querySelector('#catstats').value === '${was}'`, 'the category stats switch');
  await inOrder(A, T2, () => A.fill('#catstats', other, ['change']), async () => (await isOff()) === (other === 'off'),
    () => A.fill('#catstats', was, ['change']), async () => (await isOff()) === (was === 'off'),
    'category stats switched and switched back');
}
await A.step('packets', `!!document.querySelector('#addslot')`);
const slots0 = await A.ev(`document.querySelectorAll('[data-pickround]').length`);
await A.click('#addslot');
await A.wait(`document.querySelectorAll('[data-pickround]').length === ${slots0 + 1}`, 'a round added');
const slots = slots0 + 1;
await inOrder(A, T2, () => A.click('#addslot'), async () => (await settingsIn(T2)).rounds === slots + 1,
  () => A.click('#dropslot'), async () => (await settingsIn(T2)).rounds === slots - 1,
  'a round added, then Remove last on the page as it was');
// a second press of Save as tournament roster while the first save is out
// (over a roster with other bytes: R2's etag is the bytes' MD5, so saving
// the same bytes again never moves it)
await call(T2.A + '/roster?name=roster.qbj', { method: 'POST', body: rosterText(['Alpha', 'Beta', 'Gamma', 'Delta']) });
await A.open(T2.secret);
await A.view('setup');
await A.step('roster', `!!document.querySelector('#rfile')`);
await pick(A);
await A.wait(`!!document.querySelector('#upconfirm')`, 'the upload preview');
await sleep(500);
{
  const asked = A.dialogs.length;
  const r0 = A.reqs.length;
  const rosterPosts = () => A.reqs.slice(r0).filter((r) => r.method === 'POST' && /\/roster\?/.test(r.url)).length;
  // the first press's save held at the network a moment: the second waits for it
  let first = true;
  await A.pause((r) => {
    if (!first || r.method !== 'POST' || !new URL(r.url).pathname.endsWith('/roster')) return false;
    first = false;
    return true;
  });
  await A.ev(`(() => { const b = document.querySelector('#upconfirm'); b.click(); b.click(); return true; })()`);
  await until(() => A.held.length === 1, 'the first roster save, held');
  await sleep(1000);
  const together = rosterPosts();
  await A.free();
  await until(() => rosterPosts() === 2, 'two roster saves');
  await sleep(1500);
  const r = await storedRoster(T2);
  ok('4b one tab: Save as tournament roster pressed twice saves twice, one after the other, with no question',
    together === 1 && A.dialogs.length === asked && r.length === 5, [together, A.dialogs.slice(asked), r.length]);
}

/* ---------- 5. the schedule ---------- */

const TEAMS = Array.from({ length: 8 }, (_, i) => 'Team ' + (i + 1));
const T1 = await tournament('sv1-', TEAMS, 4);
const sched0 = buildSchedule('pools2', TEAMS, T1.rooms.map((r) => ({ name: r.room_name, bucket: r.id })));
await call(T1.A + '/schedule', { method: 'POST', json: sched0 });
for (let n = 1; n <= 5; n++) await call(`${T1.A}/packet?round=${n}&name=P${n}.pdf`, { method: 'POST', body: 'PDF'.repeat(200) });
await call(T1.A + '/start', { method: 'POST' });
// pool order wins: no ties to hold a slot
const order = (x) => TEAMS.indexOf(x);
const prelims = prelimRounds(sched0).flatMap((r) => r.games.map((g) => ({ round: r.round, room: g.room, a: g.a.team, b: g.b.team,
  tens: order(g.a.team) < order(g.b.team) ? [9, 4] : [4, 9] })));
const inPool = (p) => prelims.filter((g) => sched0.pools[p].includes(g.a));
const upload = async (g) => {
  const r = await call(`/b/${T1.rooms[g.room].secret}/upload?round=${g.round}&name=${encodeURIComponent(`Round_${g.round}_${g.a}_${g.b}.qbj`)}`,
    { method: 'POST', body: JSON.stringify(matchJson(g)) });
  if (r.status !== 200) throw new Error('upload failed: ' + JSON.stringify(r.body));
};
const labels = (s) => [...new Set(JSON.stringify(s).match(/"label":"[A-Z]\d+"/g) || [])].map((x) => x.slice(9, -1)).sort();
await A.open(T1.secret);
await until(async () => Number.isInteger((await settingsIn(T1)).byeRoom), 'T1\'s bye room');
await B.open(T1.secret);
for (const tab of [A, B]) await tab.view('live');
await sleep(500);

// two hubs filling the same slots: both read the copy before, both save it
// filled; the second lands on the first's identical bytes, counted as saved
for (const g of inPool('A')) await upload(g);
const hold = (r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/schedule');
await A.pause(hold);
await B.pause(hold);
const ra = A.reqs.length;
const rb = B.reqs.length;
const [da, db] = [A.dialogs.length, B.dialogs.length];
await A.refresh();
await B.refresh();
await until(() => A.held.length && B.held.length, 'both hubs\' fills, held');
await A.free();
await until(async () => !labels(await storedSched(T1)).some((l) => l[0] === 'A'), 'pool A filled');
const filledA = await storedSched(T1);
await B.free();
await sleep(1500);
await A.front(); // tab B hidden again: it refreshes no more until asked
// (preflights apart: the browser keeps one for both tabs)
const routes = (tab, since) => tab.reqs.slice(since).filter((r) => r.url.startsWith(BASE) && r.method !== 'OPTIONS')
  .map((r) => routeTemplate(r.method, r.url.slice(BASE.length))).sort();
ok('5 schedule: two hubs filling the same slots save once each, with no retry', schedPosts(A, ra).length === 1 && schedPosts(B, rb).length === 1,
  [schedPosts(A, ra).length, schedPosts(B, rb).length]);
ok('5 schedule: …the one whose save landed second makes the same requests as the first',
  JSON.stringify(routes(A, ra)) === JSON.stringify(routes(B, rb)), [routes(A, ra), routes(B, rb)]);
ok('5 schedule: …the stored copy is that fill', JSON.stringify(await storedSched(T1)) === JSON.stringify(filledA));
ok('5 schedule: …with no question', A.dialogs.length === da && B.dialogs.length === db, [A.dialogs.slice(da), B.dialogs.slice(db)]);

// tab A's schedule editor: playoff slots A3 and A4 traded (rooms 2 and 3)
const slotEl = (p, r, room, side) => `[...document.querySelectorAll('.sgslot[data-ref]')].find((e) => { const x = JSON.parse(e.dataset.ref);
  return x.p === ${p} && x.r === ${r} && x.room === ${room} && x.side === ${JSON.stringify(side)}; })`;
const dragOnto = (tab, fromExpr, toExpr) => tab.ev(`(() => { const from = ${fromExpr}, to = ${toExpr}; if (!from || !to) throw new Error('drag: nothing there');
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return true; })()`);
const trade = async (tab) => {
  const before = await tab.ev(`[(${slotEl(1, 0, 2, 'a')}).textContent, (${slotEl(1, 0, 3, 'a')}).textContent]`);
  await dragOnto(tab, slotEl(1, 0, 2, 'a'), slotEl(1, 0, 3, 'a'));
  await tab.wait(`(${slotEl(1, 0, 2, 'a')}).textContent === ${JSON.stringify(before[1])}`, 'the slots traded');
};
const slotOf = (s, room) => JSON.stringify(s.phases[1].rounds[0].games.find((g) => g.room === room).a);
// s is s0 with the two slots traded
const traded = (s, s0) => slotOf(s, 2) === slotOf(s0, 3) && slotOf(s, 3) === slotOf(s0, 2);
const saved = () => A.wait(`/Schedule saved/.test(document.getElementById('msg').textContent)
  && !document.querySelector('.sgbar').classList.contains('unsaved')`, 'saved');

// a stale editor Save after another tab's fill
await A.view('setup');
await A.step('sched', `!!document.querySelector('.sgslot[data-ref]')`);
await trade(A);
ok('5 schedule: tab A has an unsaved edit', await A.ev(`document.querySelector('.sgbar').classList.contains('unsaved')`));
for (const g of inPool('B')) await upload(g);
await B.refresh();
await until(async () => !labels(await storedSched(T1)).some((l) => l[0] === 'B'), 'pool B filled by tab B');
await A.front();
const filledB = await storedSched(T1);
A.answer = false;
await A.press('#schedsave');
await A.wait(`document.getElementById('msg').textContent === ${JSON.stringify(SCHED_KEPT)}`, 'the edits kept');
ok('5 schedule: a stale editor Save after another tab\'s fill asks', A.dialogs.filter((x) => x === SCHED_CONFLICT).length === 1, A.dialogs);
ok('5 schedule: Cancel saves nothing; the edit stays, unsaved', JSON.stringify(await storedSched(T1)) === JSON.stringify(filledB)
  && await A.ev(`document.querySelector('.sgbar').classList.contains('unsaved')`));
A.answer = true;
await A.press('#schedsave');
await saved();
{
  const s = await storedSched(T1);
  ok('5 schedule: OK saves this tab\'s version over the other (pool B left open, as tab A had it)',
    A.dialogs.filter((x) => x === SCHED_CONFLICT).length === 2 && traded(s, filledA) && labels(s).some((l) => l[0] === 'B'), labels(s));
}
A.answer = null; // from here on, one tab: a question fails the run

// one tab: its own saves in a row, with a room renamed in between
let mine = await storedSched(T1);
await trade(A);
await A.press('#schedsave');
await saved();
ok('5 schedule: one tab, a second save in a row', traded(await storedSched(T1), mine));
await A.step('rooms', `!!document.querySelector('[data-roomrename="${T1.rooms[1].id}"]')`);
await A.fill(`[data-roomrename="${T1.rooms[1].id}"]`, 'Hall Seven', ['change']);
await until(async () => (await storedSched(T1)).rooms[1].name === 'Hall Seven', 'the schedule follows the rename');
// the hub's refresh after the rename fills pool B, which tab A's own save
// left open: its own fill, from the copy the rename left it
await until(async () => !labels(await storedSched(T1)).some((l) => l[0] === 'B'), 'tab A fills pool B itself');
await A.wait(`/Filled the playoff slots from pool B/.test(document.getElementById('msg').textContent)`, 'the fill said');
mine = await storedSched(T1);
ok('5 schedule: …which keeps the new room name', mine.rooms[1].name === 'Hall Seven');
await A.step('sched', `!!document.querySelector('.sgslot[data-ref]')`);
await trade(A);
await A.press('#schedsave');
await saved();
{
  const s = await storedSched(T1);
  ok('5 schedule: one tab, a save after a room rename and its own fill: no question, all three kept',
    s.rooms[1].name === 'Hall Seven' && traded(s, mine), s.rooms.map((r) => r.name));
}
// a room renamed with nothing left to fill: the copy this tab holds is the
// one the Worker renamed, so the next save is not asked about it
await A.step('rooms', `!!document.querySelector('[data-roomrename="${T1.rooms[0].id}"]')`);
await A.ev(`document.getElementById('msg').textContent = ''; true`);
await A.fill(`[data-roomrename="${T1.rooms[0].id}"]`, 'Hall One', ['change']);
await A.wait(`/Renamed to Hall One/.test(document.getElementById('msg').textContent)`, 'renamed');
mine = await storedSched(T1);
ok('5 schedule: nothing left to fill, the rename alone moves the stored copy', mine.rooms[0].name === 'Hall One' && !hasPlaceholders(mine));
await A.step('sched', `!!document.querySelector('.sgslot[data-ref]')`);
await trade(A);
await A.press('#schedsave');
await saved();
{
  const s = await storedSched(T1);
  ok('5 schedule: one tab, a save right after a room rename: no question, both kept', s.rooms[0].name === 'Hall One' && traded(s, mine));
}
// deleted in another tab, then a stale Save: asks, and OK saves it again
mine = await storedSched(T1);
await trade(A);
await B.view('setup');
await B.step('sched', `!!document.querySelector('#scheddel')`);
await B.click('#scheddel');
await until(async () => (await storedSched(T1)) === null, 'deleted in tab B');
A.answer = true;
await A.press('#schedsave');
await saved();
ok('5 schedule: deleted in another tab, a Save asks, and OK saves this tab\'s copy',
  A.dialogs.filter((x) => x === SCHED_CONFLICT).length === 3 && traded(await storedSched(T1), mine), A.dialogs);
A.answer = null;

ok('no page errors', !A.errors.length && !B.errors.length, [A.errors, B.errors]);
ws.close();
summary('saves e2e');
process.exit(process.exitCode || 0);
