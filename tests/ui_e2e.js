// ui_e2e.js — the TD hub, room pages and public page driven in a real
// Chrome, the way people use them, with every step checked against the
// Worker (and every export parsed). Needs two local servers:
//   cd worker && npx wrangler dev --local --port 8799 --test-scheduled \
//     --var ALLOWED_ORIGIN:http://localhost:8765
//   cd app && python3 -m http.server 8765
// then: node tests/ui_e2e.js
// No dependencies: Chrome (CHROME=… to point elsewhere) is driven over the
// DevTools protocol with Node's own WebSocket. QBTD_PAGES / QBTD_BASE move
// the two servers.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import archive from '../app/archive/ug-nats-stanford.js';
import { makeZip, readZip } from '../app/engine/zip.js';
import { parseMatch, parseRoster, buildRosterQbj } from '../app/engine/qbj.js';
import { roundRobinRounds, tagBrackets, buildSchedule } from '../app/engine/schedule.js';
import { aggregate, dedupeMatches } from '../app/engine/stats.js';
import { roundTossupBuzzes } from '../app/engine/buzz.js';
import { BASE, call, d1exec, tick, ok, summary } from './e2e_lib.js';

const PAGES = process.env.QBTD_PAGES || 'http://localhost:8765';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const started = Date.now();
const tmp = mkdtempSync(path.join(tmpdir(), 'qbtd-ui-'));
const dl = path.join(tmp, 'downloads');
const fx = path.join(tmp, 'fixtures');

/* ---------- Chrome over the DevTools protocol ---------- */

const udd = path.join(tmp, 'profile');
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'],
{ stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (e) { /* gone */ } };
process.on('exit', cleanup);

const until = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error('timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await new Promise((r) => setTimeout(r, 100));
  }
};

const portFile = path.join(udd, 'DevToolsActivePort');
await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'), 'Chrome to start');
const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(p.method + ': ' + m.error.message)); else p.res(m.result);
  } else if (m.method) for (const fn of [...listeners]) fn(m);
};
const send = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return deadline(new Promise((res, rej) => pending.set(id, { res, rej, method })), 30000, 'reply to ' + method);
};
// nothing waits forever: a protocol reply or event that never comes fails the run with its name
const deadline = (p, ms, what) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(new Error('no ' + what + ' within ' + ms + 'ms')), ms))]);
const once = (pred, ms = 20000, what = 'browser event') => deadline(new Promise((res) => {
  const fn = (m) => { if (pred(m)) { listeners.splice(listeners.indexOf(fn), 1); res(m); } };
  listeners.push(fn);
}), ms, what);

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params) => send(method, params, sessionId);

const pageErrors = [];
const dialogs = [];
let here = 'about:blank';
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message);
    S('Page.handleJavaScriptDialog', { accept: true });
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(here + ': ' + ((d.exception && d.exception.description) || d.text));
  } else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
    here = m.params.frame.url;
  }
});
const downloads = new Map(); // guid -> {name, done}
listeners.push((m) => {
  if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, done: false });
  if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') {
    const d = downloads.get(m.params.guid);
    if (d) d.done = true;
  }
});

await S('Page.enable');
await S('Runtime.enable');
await S('DOM.enable');
await S('Page.setInterceptFileChooserDialog', { enabled: true });
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Browser.grantPermissions', { origin: new URL(PAGES).origin,
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dl, eventsEnabled: true });

const desktop = () => S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
const phone = () => S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await desktop();

async function goto(url) {
  const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired');
  await S('Page.navigate', { url });
  await loaded;
}
const reload = async () => {
  const loaded = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired');
  await S('Page.reload');
  await loaded;
};
async function js(expression) {
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  }
  return r.result.value;
}
const q = (s) => JSON.stringify(s);
// on a timeout, say what the page showed: its status line, its text, a screenshot
async function waitJs(expr, label, ms) {
  try { return await until(() => js(expr), label, ms); } catch (e) {
    let seen = '';
    try {
      seen = await js(`((document.querySelector('#msg') || {}).textContent || '') + ' || ' + document.body.innerText.slice(0, 600)`);
      const shot = await S('Page.captureScreenshot', { format: 'png' });
      const file = path.join(tmpdir(), 'qbtd-ui-fail-' + Date.now() + '.png');
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      seen += ' [screenshot ' + file + ']';
    } catch (e2) { /* page gone */ }
    throw new Error(e.message + ' — page: ' + seen);
  }
}
const click = (sel) => js(`(() => { const e = document.querySelector(${q(sel)});
  if (!e) throw new Error('nothing matches ${sel.replace(/'/g, "\\'")}'); e.click(); return true; })()`);
// a value typed in: the input event the page reads while typing, then change
const fill = (sel, value, events = ['input', 'change']) => js(`(() => {
  const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)});
  e.value = ${q(value)}; for (const t of ${q(events)}) e.dispatchEvent(new Event(t, { bubbles: true }));
  return true; })()`);
const text = (sel) => js(`(document.querySelector(${q(sel)}) || {}).textContent || ''`);
const exists = (sel) => js(`!!document.querySelector(${q(sel)})`);
async function setFiles(sel, files) {
  const { root } = await S('DOM.getDocument', { depth: 0 });
  const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) throw new Error('no file input ' + sel);
  await S('DOM.setFileInputFiles', { nodeId, files });
}
// a click that opens a file picker (a hidden input clicked by a button)
async function clickPick(sel, files) {
  const opened = once((m) => m.sessionId === sessionId && m.method === 'Page.fileChooserOpened');
  await click(sel);
  const { params } = await opened;
  await S('DOM.setFileInputFiles', { backendNodeId: params.backendNodeId, files });
}
async function download(sel) {
  const before = new Set(downloads.keys());
  await click(sel);
  const guid = await until(() => [...downloads.keys()].find((g) => !before.has(g) && downloads.get(g).done), 'download from ' + sel);
  return { name: downloads.get(guid).name, bytes: readFileSync(path.join(dl, guid)) };
}
// a quick check the page shows what it should; a throw from js() fails the check
async function check(name, fn) {
  let v;
  try { v = await fn(); } catch (e) { ok(name, false, e.message); return; }
  ok(name, v === true, v);
}

/* ---------- fixtures ---------- */

const TEAMS = ['Stanford', 'Berkeley', 'UIUC', 'ASU', 'Chicago', 'Michigan',
  'Yale', 'Penn', 'Rutgers', 'Columbia', 'Minnesota', 'Georgia Tech'];
const PLAYERS = 5;
const player = (team, j) => `${team} P${(j % PLAYERS) + 1}`;
const writeFx = (name, data) => {
  const p = path.join(fx, name);
  writeFileSync(p, data);
  return p;
};
mkdirSync(fx, { recursive: true });
mkdirSync(dl, { recursive: true });

// the shape qb-td accepts but MODAQ doesn't: no version, no tournament name
const badRoster = { objects: [{ type: 'Tournament', registrations: TEAMS.map((name) => ({
  name, teams: [{ name, players: Array.from({ length: PLAYERS }, (_, j) => ({ name: player(name, j) })) }] })) }] };
const badRosterPath = writeFx('bad roster.qbj', JSON.stringify(badRoster));

const CATS = [['Literature', 'American Literature'], ['Science', 'Biology'], ['History', 'World History'],
  ['Fine Arts', 'Painting'], ['Religion', null]];
const words = (n, seed) => Array.from({ length: n }, (_, i) =>
  ['this', 'author', 'wrote', 'a', 'novel', 'about', 'the', 'sea', 'and', 'its', 'people', 'who'][(i + seed) % 12]).join(' ');
const packetFor = (n, tag = '') => JSON.stringify({
  tossups: Array.from({ length: 20 }, (_, i) => ({ question: words(110 + (i * 7) % 30, i) + '. For 10 points, name this.',
    answer: `answer ${n}-${i + 1}${tag}`, category: CATS[i % CATS.length][0],
    ...(CATS[i % CATS.length][1] ? { subcategory: CATS[i % CATS.length][1] } : {}) })),
  bonuses: Array.from({ length: 20 }, (_, i) => ({ leadin: `Round ${n} bonus ${i + 1}. For 10 points each:`,
    parts: ['First part.', 'Second part.', 'Third part.'], answers: ['a', 'b', 'c'], values: [10, 10, 10],
    category: CATS[(i + 2) % CATS.length][0] })),
});
const tbPath = writeFx('tiebreakers.json', JSON.stringify({
  tossups: [{ question: 'Tiebreaker one text here.', answer: 'Treaty of Ghent' },
    { question: 'Tiebreaker two text here.', answer: 'Peace of Utrecht' }],
  bonuses: [{ leadin: 'Tiebreaker bonus.', parts: ['p1', 'p2', 'p3'], answers: ['x', 'y', 'z'], values: [10, 10, 10] }],
}));

// the archive's median real match, renamed onto two of our teams
const sample = (() => {
  const bundle = archive[Object.keys(archive).find((k) => k.endsWith('/bundle'))];
  const sized = bundle.entries.map((e) => ({ e, n: JSON.stringify(e.qbj).length })).sort((a, b) => a.n - b.n);
  return sized[Math.floor(sized.length / 2)].e.qbj;
})();
const sampleB = (sample.match_teams[1].team || {}).name;
function matchFor(round, a, b, flip) {
  const m = JSON.parse(JSON.stringify(sample));
  const names = flip ? [b, a] : [a, b];
  (m.match_teams || []).forEach((mt, i) => {
    if (mt.team) mt.team.name = names[i];
    (mt.match_players || []).forEach((mp, j) => { if (mp.player) mp.player.name = player(names[i], j); });
    (mt.lineups || []).forEach((l) => (l.players || []).forEach((p, j) => { p.name = player(names[i], j); }));
  });
  (m.match_questions || []).forEach((mq) => (mq.buzzes || []).forEach((bz) => {
    const side = bz.team && bz.team.name === sampleB ? 1 : 0;
    if (bz.team) bz.team.name = names[side];
    if (bz.player) bz.player.name = player(names[side], 0);
  }));
  delete m.notes;
  m._round = round;
  return m;
}
const played = []; // {round, bucket, qbj, filename} — every game file that should count

/* ---------- 1. create a tournament ---------- */

d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
await goto(`${PAGES}/index.html?server=${encodeURIComponent(BASE)}`);
await js(`localStorage.setItem('qbtdServer', ${q(BASE)}); true`);
await goto(`${PAGES}/index.html`);
await waitJs(`!!document.querySelector('#newname')`, 'the new-tournament form');
const slug = 'ui-e2e-' + Math.random().toString(36).slice(2, 7);
const NAME = 'UI E2E Open';
await fill('#newname', NAME);
await fill('#newslug', slug);
await click('#newbtn');
await waitJs(`!document.querySelector('#linkmodal').hidden`, 'the save-this-link modal');
const adminLinkText = await text('#modallink');
const secret = (/[?&]a=([a-z0-9]+)/.exec(adminLinkText) || [])[1];
ok('1 create: the modal shows the admin link', !!secret, adminLinkText);
await click('#modalcopy');
await waitJs(`/Copied admin link/.test(document.querySelector('#msg').textContent)`, 'copy confirmation');
ok('1 create: Copy puts the link on the clipboard',
  (await js('navigator.clipboard.readText()')) === adminLinkText);
{
  const nav = once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired');
  await click('#modalok');
  await nav;
}
ok('1 create: Saved it closes the modal and opens the tournament', here.includes('a=' + secret), here);
await goto(`${PAGES}/index.html`);
await waitJs(`document.querySelector('#view').textContent.includes('Tournaments on this device')`, 'the list');
ok('1 create: the tournament is on this device\'s list',
  await js(`[...document.querySelectorAll('#view a')].some((a) => a.textContent === ${q(NAME)} && a.href.includes('a=${secret}'))`));
const A = '/a/' + secret;
const detail = async () => (await call(A)).body;
let d = await detail();
ok('1 create: the Worker has it', d.tournament && d.tournament.slug === slug, d.tournament);
const tid = d.tournament.id;
const settingsOf = (dd) => JSON.parse(dd.tournament.settings || '{}');

/* ---------- 2. setup steps ---------- */

await goto(`${PAGES}/index.html?a=${secret}`);
await waitJs(`document.querySelectorAll('.stepbtn').length === 6`, 'the step list');
ok('2 steps: in order Rooms, Roster, Schedule, Packets + Tiebreakers, MODAQ Settings, Public page',
  JSON.stringify(await js(`[...document.querySelectorAll('.stepbtn')].map((b) => b.dataset.step + ':' + b.querySelector('.slabel').textContent)`))
  === JSON.stringify(['rooms:Rooms', 'roster:Roster', 'sched:Schedule', 'packets:Packets + Tiebreakers',
    'modaq:MODAQ Settings', 'stats:Public page']));
for (const [step, heading] of [['roster', 'Roster'], ['sched', 'Schedule'], ['packets', 'Packets'],
  ['modaq', 'MODAQ settings'], ['stats', 'Public page'], ['rooms', 'Rooms']]) {
  await click(`[data-step="${step}"]`);
  await check(`2 steps: ${step} shows its section`, () => waitJs(
    `document.querySelector('.stepbtn.on') && document.querySelector('.stepbtn.on').dataset.step === ${q(step)}
      && (document.querySelector('#setupsec h2') || {}).textContent === ${q(heading)}`, step + ' section'));
}

/* ---------- 3. rooms ---------- */

await fill('#roomn', '6');
await click('#mkrooms');
d = await until(async () => { const x = await detail(); return x.buckets.length === 6 && x; }, 'six rooms in the Worker');
await waitJs(`document.querySelectorAll('[data-roomrename]').length === 6`, 'six room rows');
ok('3 rooms: six created', d.buckets.length === 6, d.buckets.map((b) => b.room_name));
const LONG = 'Grainger Library 335B';
await fill(`[data-roomrename="${d.buckets[0].id}"]`, LONG, ['change']);
d = await until(async () => { const x = await detail(); return x.buckets[0].room_name === LONG && x; }, 'rename saved');
ok('3 rooms: an inline rename reaches the Worker', d.buckets[0].room_name === LONG);
await waitJs(`document.querySelector('[data-roomrename="${d.buckets[0].id}"]').value === ${q(LONG)}`, 'renamed row');
ok('3 rooms: every room has its reader and upload-page links', await js(`(() => {
  const hrefs = [...document.querySelectorAll('.roomtable a')].map((a) => a.getAttribute('href'));
  return ${q(d.buckets.map((b) => b.secret))}.every((s) => hrefs.some((h) => h.endsWith('read.html?b=' + s))
    && hrefs.some((h) => h.endsWith('bucket.html?b=' + s)));
})()`));
ok('3 rooms: Copy buttons for both links on every row',
  await js(`document.querySelectorAll('.roomtable .linkpair button').length === 12`));
await click('.roomtable tr:nth-child(2) .linkpair button');
await waitJs(`/Copied/.test(document.querySelector('#msg').textContent)`, 'room link copied');
ok('3 rooms: Copy puts the room\'s reader link on the clipboard',
  (await js('navigator.clipboard.readText()')).endsWith('read.html?b=' + d.buckets[0].secret));
const gone = d.buckets[5].id;
await click(`[data-delbucket="${gone}"]`);
d = await until(async () => { const x = await detail(); return x.buckets.length === 5 && x; }, 'room removed');
ok('3 rooms: Remove (confirmed) takes the room out', !d.buckets.some((b) => b.id === gone) && dialogs.some((x) => x.startsWith('Remove this room')));
await waitJs(`document.querySelectorAll('[data-roomrename]').length === 5`, 'five rows');
await fill('#roomn', '1');
await click('#mkrooms');
d = await until(async () => { const x = await detail(); return x.buckets.length === 6 && x; }, 'room re-added');
ok('3 rooms: adding one brings it back to six', d.buckets.length === 6);
const buckets = d.buckets;

/* ---------- 4. roster ---------- */

await click('[data-step="roster"]');
await waitJs(`!!document.querySelector('#rfile')`, 'roster section');
await setFiles('#rfile', [badRosterPath]);
await waitJs(`!!document.querySelector('#upconfirm')`, 'roster preview');
ok('4 roster: the upload previews 12 teams', (await text('#upreview')).includes('12 teams'));
await click('#upconfirm');
const storedRoster = async () => {
  const x = await detail();
  if (!x.tournament.roster_r2_key) return null;
  const r = await call(`${A}/file?key=${encodeURIComponent(x.tournament.roster_r2_key)}`);
  return r.status === 200 ? r.body : null;
};
let roster = await until(async () => { const r = await storedRoster(); return r && r.objects && r; }, 'roster saved', 8000)
  .catch(async (e) => { ok('4 roster: saved', false, e.message + ' / page says: ' + await text('#msg')); return null; });
const modaqValid = (r) => !!(r && r.version && Array.isArray(r.objects)
  && r.objects.some((o) => o.type === 'Tournament' && o.name && Array.isArray(o.registrations)
    && o.registrations.length && o.registrations.every((g) => (g.teams || []).every((tm) => (tm.players || []).length > 0))));
ok('4 roster: the stored roster is one MODAQ reads (version + a named tournament)', modaqValid(roster), roster && Object.keys(roster));
ok('4 roster: it keeps every team and player', roster && JSON.stringify(parseRoster(roster)) === JSON.stringify(parseRoster(badRoster)));

await waitJs(`(document.querySelector('#editroster') || {}).textContent === 'Edit roster'`, 'the saved roster on the page');
await click('#editroster');
await waitJs(`document.querySelectorAll('[data-tname]').length === 12`, 'the roster editor');
await click('#addteam');
await waitJs(`!!document.querySelector('[data-tname="12"]')`, 'a new team card');
await fill('[data-tname="12"]', 'St. John\'s "A"', ['input']);
await fill('[data-pname="12.0"]', 'Smith, Jr.', ['input']);
await fill('[data-pname="12.1"]', 'Ann Lee', ['input']);
await click('[data-seedup="12"]');
await waitJs(`document.querySelector('[data-tname="11"]').value === 'St. John\\'s "A"'`, 'moved up a seed');
await click('#rostersave');
roster = await until(async () => { const r = await storedRoster(); return r && parseRoster(r).length === 13 && r; }, 'edited roster saved');
{
  const teams = parseRoster(roster);
  ok('4 roster: the editor saves tricky names intact, in seed order',
    teams[11].name === 'St. John\'s "A"' && JSON.stringify(teams[11].players) === JSON.stringify(['Smith, Jr.', 'Ann Lee'])
      && teams[12].name === 'Georgia Tech' && modaqValid(roster), teams.slice(10).map((t) => t.name));
}
await waitJs(`!document.querySelector('[data-tname]')`, 'the editor closed after saving');
await click('#editroster');
await waitJs(`!!document.querySelector('[data-delteam="11"]') && document.querySelector('[data-tname="11"]').value === 'St. John\\'s "A"'`, 'editor reopened');
await click('[data-delteam="11"]');
await waitJs(`document.querySelectorAll('[data-tname]').length === 12`, 'team removed');
await click('#rostersave');
roster = await until(async () => { const r = await storedRoster(); return r && parseRoster(r).length === 12 && r; }, 'roster back to 12');
ok('4 roster: back to the twelve teams', JSON.stringify(parseRoster(roster).map((t) => t.name)) === JSON.stringify(TEAMS));
// the hidden debug roster: absent without ?debug, loads a preset with it
ok('4 roster: no test-roster loader without ?debug', !(await js(`!!document.querySelector('#dbgroster')`)));
await goto(`${PAGES}/index.html?a=${secret}&debug`);
await waitJs(`!!document.querySelector('[data-step="roster"]')`, 'the step list (debug)');
await click('[data-step="roster"]');
await waitJs(`!!document.querySelector('#dbgroster')`, 'the debug roster loader');
await js(`(() => { const s = document.querySelector('#dbgteams'); s.value = '8'; s.dispatchEvent(new Event('change')); return true; })()`);
await click('#dbgtricky');
await click('#dbgroster');
await waitJs(`!!document.querySelector('#upconfirm') && document.querySelector('#upreview').textContent.includes('8 teams')`, 'debug roster preview');
await click('#upconfirm');
{
  const r = await until(async () => { const x = await storedRoster(); return x && parseRoster(x).length === 8 && x; }, 'debug roster saved');
  const teams = parseRoster(r);
  ok('4 roster: ?debug loads a preset roster MODAQ reads, tricky names intact',
    modaqValid(r) && teams[0].name === 'Stanford' && teams[1].name === 'St. John\'s "A"'
      && teams[1].players.includes('Smith, Jr.') && teams.every((tm) => tm.players.length === 4), teams.map((tm) => tm.name));
}
await setFiles('#rfile', [badRosterPath]);
await waitJs(`!!document.querySelector('#upconfirm') && document.querySelector('#upreview').textContent.includes('12 teams')`, 'restore preview');
await click('#upconfirm');
roster = await until(async () => { const r = await storedRoster(); return r && parseRoster(r).length === 12 && r; }, 'roster restored');
ok('4 roster: the original twelve teams are back', JSON.stringify(parseRoster(roster).map((t) => t.name)) === JSON.stringify(TEAMS));
// the flag sticks to the browser: a plain admin link still shows it, until ?debug=0
await goto(`${PAGES}/index.html?a=${secret}`);
await waitJs(`!!document.querySelector('[data-step="roster"]')`, 'the step list (plain link)');
await click('[data-step="roster"]');
await check('4 roster: ?debug sticks for later visits without it', () => waitJs(`!!document.querySelector('#dbgroster')`, 'sticky debug loader'));
await goto(`${PAGES}/index.html?a=${secret}&debug=0`);
await waitJs(`!!document.querySelector('[data-step="roster"]')`, 'the step list (debug off)');
await click('[data-step="roster"]');
await waitJs(`!!document.querySelector('#rfile')`, 'roster section (debug off)');
ok('4 roster: ?debug=0 turns it off', !(await js(`!!document.querySelector('#dbgroster')`)));
await goto(`${PAGES}/index.html?a=${secret}`);
await waitJs(`document.querySelectorAll('.stepbtn').length === 6`, 'the step list again');
const rosterTeams = parseRoster(roster);

/* ---------- 5. schedule ---------- */

await click('[data-step="sched"]');
await waitJs(`!!document.querySelector('input[name="schedfmt"][value="pools2"]')`, 'schedule formats');
await click('input[name="schedfmt"][value="pools2"]');
ok('5 schedule: the creator offers six rooms', (await js(`document.querySelector('#schedrooms').value`)) === '6');
ok('5 schedule: and the twelve teams just saved', (await text('#schedsec')).includes('12 teams'), (await text('#schedsec')).slice(0, 80));
// generation options: Reroll only matters (and only works) once an option is random
ok('5 schedule: with default options there is nothing to reroll', await js(`document.querySelector('#optreroll').disabled`));
await fill('#optrooms', 'rotate', ['change']);
await waitJs(`!document.querySelector('#optreroll').disabled`, 'Reroll enabled for rotate');
const seed1 = await text('.sgseed b');
await click('#optreroll');
await waitJs(`document.querySelector('.sgseed b').textContent !== ${q(seed1)}`, 'a new seed');
ok('5 schedule: Reroll draws a new seed, and the preview line describes the result',
  /8 rounds · 6 of 6 rooms used · no byes/.test(await text('.sgpreview')), await text('.sgpreview'));
await fill('#optrooms', 'keep', ['change']); // back to defaults: the rest of the run depends on the default rooms
await click('input[name="schedfmt"][value="pools2"]');
await click('#schedgen');
const schedKey = `t/${tid}/schedule.json`;
const storedSched = async () => { const r = await call(`${A}/file?key=${encodeURIComponent(schedKey)}`); return r.status === 200 ? r.body : null; };
let sched = await until(storedSched, 'schedule saved');
ok('5 schedule: two pools of the roster\'s twelve teams, saved', sched.pools && Object.keys(sched.pools).length === 2
  && JSON.stringify(Object.values(sched.pools).flat().sort()) === JSON.stringify([...TEAMS].sort()),
  sched.pools);
ok('5 schedule: saved with its brackets, every game tagged',
  JSON.stringify(sched.brackets.map((b) => b.name)) === JSON.stringify(['Pool A', 'Pool B', 'Championship', 'Consolation'])
    && sched.phases.every((ph) => ph.rounds.every((r) => r.games.every((g) => g.bracket))), sched.brackets);
const generated = JSON.stringify(sched.phases);
await waitJs(`!!document.querySelector('.sgcell')`, 'the schedule editor');
ok('5 schedule: the grid groups rooms into bracket lanes',
  JSON.stringify(await js(`[...document.querySelectorAll('.sgphase')].map((ph) => [...ph.querySelectorAll('.sglane:not(.sglane-byes)')].map((l) => l.textContent.trim()))`))
    === JSON.stringify([['Pool A', 'Pool B'], ['Championship', 'Consolation']]));
const slotEl = (p, r, room, side) => `[...document.querySelectorAll('.sgslot[data-ref]')].find((e) => { const x = JSON.parse(e.dataset.ref);
  return x.p === ${p} && x.r === ${r} && x.room === ${room} && x.side === ${q(side)}; })`;
const cellEl = (p, r, room) => `[...document.querySelectorAll('.sgcell')].find((e) => { const x = JSON.parse(e.dataset.cell); return x.p === ${p} && x.r === ${r} && x.room === ${room}; })`;
// real DOM drag events with a DataTransfer, the way a mouse drag fires them
const dragOnto = (fromExpr, toExpr) => js(`(() => { const from = ${fromExpr}, to = ${toExpr}; if (!from || !to) throw new Error('drag: nothing there');
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const over = to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return !over; })()`);
const slotText2 = (p, r, room, side) => js(`(${slotEl(p, r, room, side)}).textContent`);
const gameAt = (s2, p, r, room) => s2.phases[p].rounds[r].games.find((g) => g.room === room);
const [t00, t01] = [await slotText2(0, 0, 0, 'a'), await slotText2(0, 0, 1, 'a')];
ok('5 schedule: a dragged team is a valid drop on another team', await dragOnto(slotEl(0, 0, 0, 'a'), slotEl(0, 0, 1, 'a')));
await waitJs(`(${slotEl(0, 0, 0, 'a')}).textContent === ${q(t01)}`, 'teams swapped by drag');
ok('5 schedule: the swap shows as an unsaved change', /1 unsaved change/.test(await text('.sgbar')));
await click('#schedsave');
sched = await until(async () => { const x = await storedSched(); return gameAt(x, 0, 0, 0).a.team === t01 && gameAt(x, 0, 0, 1).a.team === t00 && x; }, 'drag swap saved');
ok('5 schedule: dragging a team onto another swaps them, and Save stores it', true);
// click path: select, Swap with…, click the other team; Undo / Redo / Discard
await js(`(${slotEl(0, 0, 0, 'a')}).click(); true`);
await waitJs(`!!document.querySelector('.sgpanel [data-act="swap"]')`, 'the slot panel');
await click('.sgpanel [data-act="swap"]');
await js(`(${slotEl(0, 0, 1, 'a')}).click(); true`);
await waitJs(`(${slotEl(0, 0, 0, 'a')}).textContent === ${q(t00)}`, 'swapped back by clicks');
await click('#schedundo');
await waitJs(`(${slotEl(0, 0, 0, 'a')}).textContent === ${q(t01)}`, 'undo');
await click('#schedredo');
await waitJs(`(${slotEl(0, 0, 0, 'a')}).textContent === ${q(t00)}`, 'redo');
ok('5 schedule: click Swap with…, Undo and Redo each work', true);
await click('#schedsave');
sched = await until(async () => { const x = await storedSched(); return JSON.stringify(x.phases) === generated && x; }, 'back to the generated schedule');
ok('5 schedule: saved back to the generated pairings', true);
// the old dropdown path: clear a slot from the panel's Any team list; checks notice; Discard
await js(`(${slotEl(0, 1, 2, 'b')}).click(); true`);
await waitJs(`!!document.querySelector('.sgpanel select.slotsel')`, 'the Any team dropdown');
const cleared = await slotText2(0, 1, 2, 'b');
await fill('.sgpanel select.slotsel', '__clear', ['change']);
await waitJs(`(${slotEl(0, 1, 2, 'b')}).textContent === 'empty'`, 'slot cleared');
ok('5 schedule: Checks flag the half-empty game and the team left without one',
  (await text('.sgchecks')).includes(cleared + ' has no game') && /missing a team/.test(await text('.sgchecks')), await text('.sgchecks'));
await click('#scheddiscard');
await waitJs(`(${slotEl(0, 1, 2, 'b')}).textContent === ${q(cleared)} && /Saved/.test(document.querySelector('.sgbar').textContent)`, 'discarded');
ok('5 schedule: Discard puts the saved schedule back', /all clear/.test(await text('.sgchecks')));
// rooms and whole games: add a room, drag a game into it, remove the room, undo all of it
await click('#schedaddroom');
await waitJs(`document.querySelectorAll('.sgphase')[0].querySelectorAll('.sgroom:not(.sgroom-byes)').length === 7`, 'a seventh room column');
const moved = [await slotText2(0, 0, 0, 'a'), await slotText2(0, 0, 0, 'b')];
ok('5 schedule: an empty room accepts a dragged game', await dragOnto(cellEl(0, 0, 0), cellEl(0, 0, 6)));
await waitJs(`!!(${slotEl(0, 0, 6, 'a')}) && (${slotEl(0, 0, 6, 'a')}).textContent === ${q(moved[0])}`, 'game moved to the new room');
await click('#schedsave');
sched = await until(async () => { const x = await storedSched(); const g = gameAt(x, 0, 0, 6); return x.rooms.length === 7 && g && g.a.team === moved[0] && !gameAt(x, 0, 0, 0) && x; }, 'moved game saved');
ok('5 schedule: dragging a game into an empty room moves it, and Save stores it', true);
await js(`[...document.querySelectorAll('.sgroom')].find((b) => b.textContent === 'Room 7').click(); true`);
await waitJs(`!!document.querySelector('.sgpanel [data-act="droproom"]')`, 'the room panel');
await click('.sgpanel [data-act="droproom"]');
await waitJs(`document.querySelectorAll('.sgphase')[0].querySelectorAll('.sgroom:not(.sgroom-byes)').length === 6`, 'room removed');
ok('5 schedule: removing a room drops its teams to Byes',
  JSON.stringify(await js(`[...document.querySelectorAll('[data-byes="0.0"] .sgslot')].map((b) => b.textContent)`)) === JSON.stringify(moved));
await click('#schedundo');
await waitJs(`document.querySelectorAll('.sgphase')[0].querySelectorAll('.sgroom:not(.sgroom-byes)').length === 7
  && (${slotEl(0, 0, 6, 'a')}).textContent === ${q(moved[0])}`, 'room removal undone');
ok('5 schedule: Undo brings the room and its game back', /Saved/.test(await text('.sgbar')));
// the game goes home by the click path this time, then the empty room goes without asking
await js(`(${cellEl(0, 0, 6)}).querySelector('.sgh').click(); true`);
await waitJs(`!!document.querySelector('.sgpanel [data-act="move"]')`, 'the game panel');
await click('.sgpanel [data-act="move"]');
await js(`(${cellEl(0, 0, 0)}).querySelector('.sgadd').click(); true`);
await waitJs(`!!(${slotEl(0, 0, 0, 'a')}) && (${slotEl(0, 0, 0, 'a')}).textContent === ${q(moved[0])}`, 'game moved back by clicks');
const dialogsBefore = dialogs.length;
await js(`[...document.querySelectorAll('.sgroom')].find((b) => b.textContent === 'Room 7').click(); true`);
await waitJs(`!!document.querySelector('.sgpanel [data-act="droproom"]')`, 'the room panel again');
await click('.sgpanel [data-act="droproom"]');
await waitJs(`document.querySelectorAll('.sgphase')[0].querySelectorAll('.sgroom:not(.sgroom-byes)').length === 6`, 'empty room removed');
ok('5 schedule: an empty room goes without a confirm', dialogs.length === dialogsBefore, dialogs.slice(dialogsBefore));
await click('#schedsave');
sched = await until(async () => { const x = await storedSched(); return x.rooms.length === 6 && JSON.stringify(x.phases) === generated && x; }, 'back to six rooms');
ok('5 schedule: moved back by clicks and saved as generated', true);
// rounds: insert then delete an empty one is no change at all
const nRounds = await js(`document.querySelectorAll('.sgrnd').length`);
await js(`document.querySelector('[data-insround="0.0"]').click(); true`);
await waitJs(`document.querySelectorAll('.sgrnd').length === ${nRounds + 1}`, 'a round inserted');
ok('5 schedule: the inserted round renumbers the rest', (await js(`[...document.querySelectorAll('.sgrnd > span:first-child')].map((x) => x.textContent).join(',')`)) === '1,2,3,4,5,6,7,8,9');
await js(`document.querySelector('[data-delround="0.1"]').click(); true`);
await waitJs(`document.querySelectorAll('.sgrnd').length === ${nRounds} && /Saved/.test(document.querySelector('.sgbar').textContent)`, 'round deleted, nothing to save');
ok('5 schedule: deleting the empty round leaves nothing to save', true);
// By team: each team's opponent per round, straight from the stored schedule
await click('[data-view2="teams"]');
await waitJs(`document.querySelectorAll('.sgtname').length === 12`, 'the by-team view');
{
  const g = gameAt(sched, 0, 0, 0);
  const row = await js(`(() => { const names = [...document.querySelectorAll('.sgtname')]; const i = names.findIndex((n) => n.textContent === ${q(g.a.team)});
    const cells = [...document.querySelectorAll('.sgtc')]; return cells[i * 8].textContent; })()`);
  ok('5 schedule: By team shows each team\'s round 1 opponent', row.startsWith('v ' + g.b.team), row);
}
await js(`document.querySelector('.sgtc').click(); true`);
await waitJs(`!!document.querySelector('.sggrid') && !!document.querySelector('.sgcell.on')`, 'jumped to the game');
ok('5 schedule: clicking a By team cell selects that game in the grid', true);
await click('[data-view2="brackets"]');
await waitJs(`document.querySelectorAll('.sgmapcard[data-filter]').length === 4`, 'the brackets view');
await js(`[...document.querySelectorAll('.sgmapcard[data-filter]')].find((b) => b.dataset.filter === 'CO').click(); true`);
await waitJs(`!!document.querySelector('.sggrid') && document.querySelectorAll('.sggrid').length === 1
  && [...document.querySelectorAll('.sglane:not(.sglane-byes)')].map((l) => l.textContent.trim()).join() === 'Consolation'`, 'filtered to Consolation');
ok('5 schedule: a bracket card filters the grid to that bracket', true);
await js(`document.querySelector('.sgchips [data-filter=""]').click(); true`);
sched = await storedSched();
const schedRounds = Math.max(...sched.phases.flatMap((p) => p.rounds.map((r) => r.round)));
const gameIn = (n, room) => sched.phases.flatMap((p) => p.rounds).find((r) => r.round === n).games.find((g) => g.room === room);
const roomBucket = (room) => buckets.find((b) => b.id === sched.rooms[room].bucket);

/* ---------- 6. packets ---------- */

await click('[data-step="packets"]');
await waitJs(`!!document.querySelector('.pkcount')`, 'packets section');
ok(`6 packets: ${schedRounds} rounds, from the schedule`,
  (await text('.pkcount')).replace(/\s+/g, ' ').trim() === `${schedRounds} rounds · from the schedule`, await text('.pkcount'));
ok('6 packets: a row per round', (await js(`document.querySelectorAll('.pktable tr[data-round]').length`)) === schedRounds);
ok('6 packets: Remove last is off at the schedule\'s count', await js(`document.querySelector('#dropslot').disabled`));
await click('#addslot');
await waitJs(`document.querySelector('.pkcount').textContent.includes('${schedRounds + 1} rounds')`, 'a round added');
d = await detail();
ok('6 packets: Add a round persists', settingsOf(d).rounds === schedRounds + 1, settingsOf(d));
ok('6 packets: the note says the schedule has fewer', (await text('.pkcount')).includes(`the schedule has ${schedRounds}`));
await click('#dropslot');
await waitJs(`document.querySelector('.pkcount').textContent.includes('${schedRounds} rounds')`, 'back to the schedule count');
d = await detail();
ok('6 packets: Remove last persists and stops at the schedule', settingsOf(d).rounds === schedRounds
  && await js(`document.querySelector('#dropslot').disabled`));
const packets = {};
for (let n = 1; n <= schedRounds; n++) packets[n] = packetFor(n);
const zipPath = writeFx('packets.zip', Buffer.from(makeZip(Array.from({ length: schedRounds }, (_, i) =>
  ({ name: `Round ${i + 1}.json`, data: packets[i + 1] })))));
await setFiles('#zipfile', [zipPath]);
await waitJs(`document.querySelectorAll('.pkstaged .chip').length === ${schedRounds}`, 'staged chips');
ok('6 packets: each staged chip guesses its round', await js(`[...document.querySelectorAll('.pkstaged .chip')].every((c) => /Round (\\d+)\\.json.*Round \\1/.test(c.textContent))`));
await click('#zipauto');
d = await until(async () => { const x = await detail(); return x.rounds.length === schedRounds && x; }, 'packets uploaded', 30000);
ok('6 packets: Assign by filename puts every packet on its round',
  d.rounds.every((r) => r.packet_name === `Round ${r.number}.json`), d.rounds.map((r) => r.number + ':' + r.packet_name));
await waitJs(`[...document.querySelectorAll('.pktable tr[data-round]')].every((tr) =>
  tr.classList.contains('has') && tr.querySelector('.pkfile a').textContent === 'Round ' + tr.dataset.round + '.json')`, 'rows show their packets');
ok('6 packets: every row names its packet', true);
packets[1] = packetFor(1, ' (revised)');
const revised = writeFx('Round 1 revised.json', packets[1]);
await clickPick('[data-pickround="1"]', [revised]);
d = await until(async () => { const x = await detail(); return x.rounds.find((r) => r.number === 1).packet_name === 'Round 1 revised.json' && x; }, 'replacement uploaded');
await waitJs(`document.querySelector('.pktable tr[data-round="1"] .pkfile a').textContent === 'Round 1 revised.json'`, 'row 1 renamed');
ok('6 packets: Replace puts a new file on one round', true);
await setFiles('#tbfile', [tbPath]);
await waitJs(`[...document.querySelectorAll('#setupsec table tr')].filter((tr) => tr.textContent.includes('Unused')).length === 3`, 'tiebreaker questions listed');
const tb = (await call(`${A}/tiebreakers`)).body;
ok('6 packets: the tiebreaker packet splits into questions, all Unused', tb.tossups.length === 2 && tb.bonuses.length === 1);

/* ---------- 7. MODAQ settings ---------- */

await click('[data-step="modaq"]');
await waitJs(`!!document.querySelector('#gformat')`, 'MODAQ section');
await fill('#gformat', 'acf', ['change']);
d = await until(async () => { const x = await detail(); return settingsOf(x).gameFormat === 'acf' && x; }, 'format saved');
ok('7 MODAQ: picking a format saves it', true);
// the step list's word on the format is the page's redraw after the save
await waitJs(`document.querySelector('[data-step="modaq"] .sdetail').textContent === 'ACF (no powers)'`, 'the saved format on the page');
ok('7 MODAQ: finishing the last step keeps the page on Setup', await exists('#gformat'));
await waitJs(`!!document.querySelector('#fmttossups') && !document.querySelector('#fmtpanel').hidden`, 'the compact format rows');
await fill('#fmttossups', '22', ['input']);
await fill('#fmtneg', '-10', ['input']);
await click('#fmtsave');
d = await until(async () => { const x = await detail(); const s = settingsOf(x); return s.formatOverrides && s.formatOverrides.regulationTossupCount === 22 && x; }, 'overrides saved');
ok('7 MODAQ: Save format stores the changed values', settingsOf(d).formatOverrides.negValue === -10 && settingsOf(d).gameFormat === 'acf', settingsOf(d));
await waitJs(`document.querySelector('#fmttossups') && document.querySelector('#fmttossups').value === '22'`, 'rerendered');
await click('#fmtreset');
d = await until(async () => { const x = await detail(); return !settingsOf(x).formatOverrides && x; }, 'reset saved');
ok('7 MODAQ: Reset to preset drops them', settingsOf(d).gameFormat === 'acf');

/* ---------- 8. public page ---------- */

await click('[data-step="stats"]');
await waitJs(`!!document.querySelector('#pub')`, 'public page section');
await js(`document.querySelector('#pub').checked = false; document.querySelector('#pub').dispatchEvent(new Event('change')); true`);
d = await until(async () => { const x = await detail(); return !x.tournament.published && x; }, 'public page off');
ok('8 public: switching the page off reaches the Worker', true);
await waitJs(`(document.querySelector('#pubmark') || {}).textContent === 'Page off'`, 'the mark says Page off');
ok('8 public: the header mark says Page off', true);
await waitJs(`!!document.querySelector('#pub') && !document.querySelector('#pub').checked`, 'rerendered off');
await js(`document.querySelector('#pub').checked = true; document.querySelector('#pub').dispatchEvent(new Event('change')); true`);
d = await until(async () => { const x = await detail(); return x.tournament.published && x; }, 'public page on');
ok('8 public: and back on', true);
await waitJs(`/Updating/.test((document.querySelector('#pubmark') || {}).textContent || '')`, 'the mark');
ok('8 public: turning it on marks the page Updating', true);
// the cron rebuilds; a minute on (viewers' cache), the mark reads Up to date
await tick();
d1exec(`UPDATE tournaments SET pub_built = 1000 WHERE id = ${tid}`);
await goto(`${PAGES}/index.html?a=${secret}`);
await waitJs(`!!document.querySelector('[data-view="setup"]')`, 'the hub');
await click('[data-view="setup"]');
await waitJs(`document.querySelectorAll('.stepbtn').length === 6`, 'the step list');
await waitJs(`/Up to date/.test((document.querySelector('#pubmark') || {}).textContent || '')`, 'Up to date');
ok('8 public: once rebuilt, the mark reads Up to date', (await js(`document.querySelector('#pubmark').className`)) === 'pubstat');
// a room renamed on the Rooms step: the saved schedule and the one held
// by the page both follow, and the public page rebuilds
{
  const b = buckets[1];
  const si = (await storedSched()).rooms.findIndex((r) => r.bucket === b.id);
  await click('[data-step="rooms"]');
  await waitJs(`!!document.querySelector('[data-roomrename="${b.id}"]')`, 'the room row');
  await fill(`[data-roomrename="${b.id}"]`, 'Hall 7 East', ['change']);
  const st = await until(async () => { const x = await storedSched(); return x.rooms[si].name === 'Hall 7 East' && x; }, 'schedule renamed');
  ok('8 rename: the saved schedule follows a room rename', st.rooms[si].name === 'Hall 7 East');
  await waitJs(`/Updating/.test((document.querySelector('#pubmark') || {}).textContent || '')`, 'Updating after rename');
  ok('8 rename: and the page marks the public page Updating', true);
  await click('[data-step="sched"]');
  await waitJs(`!!document.querySelector('[data-roomname="${si}"]')`, 'schedule rooms');
  ok('8 rename: the schedule step shows the new name', (await js(`document.querySelector('[data-roomname="${si}"]').value`)) === 'Hall 7 East');
  await click('[data-step="rooms"]');
  await waitJs(`!!document.querySelector('[data-roomrename="${b.id}"]')`, 'the room row');
  await fill(`[data-roomrename="${b.id}"]`, b.room_name, ['change']);
  await until(async () => (await storedSched()).rooms[si].name === b.room_name, 'renamed back');
  await click('[data-step="stats"]');
  await waitJs(`!!document.querySelector('#pub')`, 'public page section');
}
await waitJs(`!!document.querySelector('#buzzmode')`, 'buzzpoints controls');
await fill('#buzzmode', 'password', ['change']);
await waitJs(`!document.querySelector('#buzzpw').hidden`, 'password field');
await fill('#buzzpw', 'hunter2', ['input']);
await click('#buzzset');
d = await until(async () => { const x = await detail(); const b = settingsOf(x).buzz; return b && b.mode === 'password' && x; }, 'buzz password saved', 20000);
ok('8 public: buzzpoints on with a password', !!settingsOf(d).buzz.hash || !!settingsOf(d).buzz.kdf, settingsOf(d).buzz);

/* ---------- 9. start ---------- */

await waitJs(`!!document.querySelector('#starttour')`, 'Start tournament');
await click('#starttour');
d = await until(async () => { const x = await detail(); return x.tournament.started && x; }, 'started');
ok('9 start: the Worker has it started', !!d.tournament.started && dialogs.some((x) => x.startsWith('Start the tournament?')));
await waitJs(`(document.querySelector('.stepstart') || {}).textContent.includes('Started')`, 'the step list says Started');
ok('9 start: the step list says Started', true);

/* ---------- 10–11. rooms upload, a reader starts ---------- */

const gameFiles = (round, room, flip) => {
  const g = gameIn(round, room);
  const qbj = matchFor(round, g.a.team, g.b.team, flip);
  const base = `Round_${round}_${g.a.team}_${g.b.team}`.replace(/ /g, '_');
  return { g, qbj, base };
};
async function roomUpload(bucket, round, files) {
  await goto(`${PAGES}/bucket.html?b=${bucket.secret}`);
  await waitJs(`!document.querySelector('#roundcard').hidden && document.querySelectorAll('#rounds a').length > 0`, 'the upload page');
  const chips = await js(`[...document.querySelectorAll('#rounds a')].map((a) => a.textContent + (a.classList.contains('on') ? '*' : ''))`);
  ok(`10 upload page: ${bucket.room_name} shows round chips, the live round marked`,
    chips.includes(`Round ${(await detail()).tournament.current_round}*`), chips);
  const before = (await js(`document.querySelectorAll('#uploads .u').length`));
  await fill('#upround', String(round));
  await setFiles('#upfiles', files.map((f) => f.path));
  await click('#upbtn');
  await waitJs(`document.querySelectorAll('#uploads .u').length === ${before + files.length}`, 'uploads listed');
  return js(`[...document.querySelectorAll('#uploads .u')].slice(0, ${files.length}).map((u) => u.textContent)`);
}

// room 3 reads round 1 in the browser: pre-game screen, then Start
{
  const b = roomBucket(2);
  const g = gameIn(1, 2);
  await goto(`${PAGES}/read.html?b=${b.secret}`);
  await waitJs(`document.querySelectorAll('#roundrows [data-round]').length > 0 && !document.querySelector('#schedmatch').hidden
    && document.querySelector('#starters').textContent.length > 0`, 'the reader\'s pre-game screen');
  ok('11 reader: round buttons, round 1 picked', await js(`[...document.querySelectorAll('#roundrows [data-round]')].some((x) => x.dataset.round === '1')`));
  ok('11 reader: the scheduled matchup', (await text('#mteama')) === g.a.team && (await text('#mteamb')) === g.b.team,
    [await text('#mteama'), await text('#mteamb')]);
  const st = await text('#starters');
  ok('11 reader: starters listed from the roster, both teams', st.includes(player(g.a.team, 0)) && st.includes(player(g.b.team, 0)), st.slice(0, 200));
  ok('11 reader: no roster error', !/roster/i.test(await text('#msg')), await text('#msg'));
  await click('#start');
  await waitJs(`document.body.classList.contains('reading') && document.querySelector('#modaq').children.length > 0`, 'MODAQ mounted');
  ok('11 reader: Start game opens MODAQ', true);
  d = await until(async () => { const x = await detail(); return (x.starts || []).some((s) => s.bucket_id === b.id && s.round === 1) && x; }, 'start recorded');
  ok('11 reader: the Worker records the room as started', true);
}

// every room turns in round 1: a split pair, a reader upload with a protest, plain .qbj
let protestTeam = null;
for (let room = 0; room < 6; room++) {
  const b = roomBucket(room);
  const { g, qbj, base } = gameFiles(1, room, room % 2 === 1);
  let files;
  if (room === 0) {
    files = [{ path: writeFx(base + '.qbj', JSON.stringify(qbj)) }, { path: writeFx(base + '_Game.json', '{"cycles":[]}') }];
    played.push({ round: 1, bucket: b.id, qbj, filename: base + '.qbj' });
  } else if (room === 1) {
    protestTeam = g.b.team;
    files = [{ path: writeFx(base + '.qbtd.json', JSON.stringify({ qbj, game: { cycles: [] }, protests: [
      { kind: 'tu', q: 3, team: g.b.team, word: 12, given: 'treaty of utrecht', reason: 'The answer line accepts it',
        to: g.b.team, from: g.a.team, gain: 25, loss: 0, detail: { tu: 10, neg: 0, bonus: 15, oppTu: 0, oppBonus: 0 } }] })) }];
    played.push({ round: 1, bucket: b.id, qbj, filename: base + '.qbj' });
  } else {
    files = [{ path: writeFx(base + '.qbj', JSON.stringify(qbj)) }];
    played.push({ round: 1, bucket: b.id, qbj, filename: base + '.qbj' });
  }
  const rows = await roomUpload(b, 1, files);
  ok(`10 upload page: ${b.room_name} shows its round chips and the upload with a ✓`,
    rows.length === files.length && rows.every((r) => r.includes('✓')), rows);
  d = await detail();
  const mine = d.files.filter((f) => f.bucket_id === b.id && f.round === 1);
  const kinds = mine.map((f) => f.kind).sort().join(',');
  ok(`10 upload page: ${b.room_name}'s files reach the Worker (${kinds})`,
    room === 0 ? kinds === 'game,qbj' : room === 1 ? kinds === 'combined' : kinds === 'qbj', mine);
  ok(`10 upload page: ${b.room_name}'s files parse`, mine.every((f) => !f.error), mine.map((f) => f.error));
}

/* ---------- 12, 15. Live Hub: round 1, advance, set round ---------- */

async function openHub() {
  await goto(`${PAGES}/index.html?a=${secret}`);
  await waitJs(`!!document.querySelector('.hubtab')`, 'the hub');
  if (!(await exists('.biground'))) await click('[data-view="live"]');
  await waitJs(`!!document.querySelector('.biground')`, 'the Live Hub');
}
await openHub();
ok(`12 live: Round 1 / ${schedRounds}`, (await text('.biground')).replace(/\s+/g, ' ').trim() === `Round 1 / ${schedRounds}`, await text('.biground'));
// a round robin's plain rows (.lrow), or a bracket schedule's rows under
// their headings (.brow: the room name leads its second line)
async function liveMarks() {
  return js(`[...document.querySelectorAll('.lrow, .brow')].map((r) => [r.querySelector('.lroom')
    ? r.querySelector('.lroom').textContent : r.querySelector('.broom').firstChild.textContent,
    r.querySelector('.lmark').textContent.trim()])`);
}
const liveHeads = () => js(`[...document.querySelectorAll('.bcols .bhead b')].map((b) => b.textContent)`);
async function expectLive(label, round) {
  const x = await detail();
  const startedSet = new Set((x.starts || []).filter((s) => s.round === round).map((s) => s.bucket_id));
  // two pools: rooms under their pool's heading, in pool order, room order within
  const bix = (room) => sched.brackets.findIndex((br) => br.key === gameIn(round, room).bracket);
  const want = sched.rooms.map((_, room) => room).sort((p, q2) => bix(p) - bix(q2) || p - q2).map((room) => {
    const b = roomBucket(room);
    const inFile = x.files.some((f) => f.bucket_id === b.id && f.round === round && (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
    return [b.room_name, inFile ? '✓' : startedSet.has(b.id) ? '○' : '–'];
  });
  const got = await liveMarks();
  ok(`12 live: ${label}: one row per room, marks match the Worker`, JSON.stringify(got) === JSON.stringify(want), { got, want });
  const heads = await liveHeads();
  ok(`12 live: ${label}: a heading per pool`, JSON.stringify(heads) === JSON.stringify(['Pool A', 'Pool B']), heads);
  const k = sched.rooms.filter((_, room) => startedSet.has(roomBucket(room).id)).length;
  const railText = (await text('.railtoggle')).replace(/\s+/g, ' ');
  ok(`12 live: ${label}: auto-advance says ${k}/6 started`, railText.includes(`${k}/6 started`), railText);
}
await expectLive('round 1, all in', 1);
await click('#autoadv');
d = await until(async () => { const x = await detail(); return settingsOf(x).autoAdvance === true && x; }, 'auto-advance on');
ok('12 live: the auto-advance switch persists', d.tournament.current_round === 1);
await waitJs(`!!document.querySelector('#autoadv') && document.querySelector('#autoadv').checked`, 'switch shown on');
await click('#autoadv');
d = await until(async () => { const x = await detail(); return !settingsOf(x).autoAdvance && x; }, 'auto-advance off');
ok('12 live: and off again', true);

// two pools keep their own rounds: the button advances every pool
await waitJs(`!!document.querySelector('#advall')`, 'Advance');
ok('15 rounds: the button reads Advance all to round 2', (await text('#advall')).trim() === 'Advance all to round 2', await text('#advall'));
await click('#advall');
d = await until(async () => { const x = await detail(); return x.tournament.current_round === 2 && x; }, 'advanced');
await waitJs(`document.querySelector('.biground').textContent.includes('Round 2')`, 'hub on round 2');
ok('15 rounds: Advance moves the Worker and the hub to round 2', true);
await fill('#curround', '1', ['input']);
await click('#setround');
d = await until(async () => { const x = await detail(); return x.tournament.current_round === 1 && x; }, 'set to 1');
await waitJs(`document.querySelector('.biground').textContent.includes('Round 1')`, 'hub on round 1');
ok('15 rounds: Set round goes back', true);

/* ---------- 18. the status notice ---------- */

await waitJs(`!!document.querySelector('#curround')`, 'set round field');
await fill('#curround', '2', ['input']);
await click('#setround');
await waitJs(`document.querySelector('#msg').classList.contains('show') && document.querySelector('#msg').textContent === 'Round 2'`, 'a confirmation notice');
d = await until(async () => { const x = await detail(); return x.tournament.current_round === 2 && x; }, 'set to 2');
ok('18 notice: a confirmation shows', true);
await check('18 notice: and fades on its own', () => waitJs(`!document.querySelector('#msg').classList.contains('show')`, 'notice gone', 6000));

/* ---------- 12–14. round 2: started, missing, the wrong room, Add a game ---------- */

const r2 = [0, 1, 2, 3, 4, 5].map((room) => gameFiles(2, room, room % 2 === 0));
await call(`/b/${roomBucket(1).secret}/start?round=2`, { method: 'POST' });
{
  const f = r2[0];
  await roomUpload(roomBucket(0), 2, [{ path: writeFx(f.base + '.qbj', JSON.stringify(f.qbj)) }]);
  played.push({ round: 2, bucket: roomBucket(0).id, qbj: f.qbj, filename: f.base + '.qbj' });
}
await openHub();
await expectLive('round 2, one in, one started, four not started', 2);

// room 4 turns in its own game and room 3's
{
  const b4 = roomBucket(4);
  const f3 = r2[3];
  const f4 = r2[4];
  await roomUpload(b4, 2, [{ path: writeFx(f4.base + '.qbj', JSON.stringify(f4.qbj)) },
    { path: writeFx(f3.base + '.qbj', JSON.stringify(f3.qbj)) }]);
  played.push({ round: 2, bucket: b4.id, qbj: f4.qbj, filename: f4.base + '.qbj' });
  played.push({ round: 2, bucket: roomBucket(3).id, qbj: f3.qbj, filename: f3.base + '.qbj' });
}
await openHub();
const b3 = roomBucket(3), b4 = roomBucket(4), b5 = roomBucket(5);
const cellText = (bid, n) => js(`(document.querySelector('[data-cell="${bid}:${n}"]') || document.querySelector('.ugrid')).textContent.trim()`);
ok('13 uploads: the room with two games shows 2', (await cellText(b4.id, 2)) === '2', await cellText(b4.id, 2));
ok('13 uploads: the two games are different, so the 2 is a warning',
  await js(`document.querySelector('[data-cell="${b4.id}:2"]').classList.contains('warn')`));
ok('13 uploads: the room whose game went elsewhere shows –', (await cellText(b3.id, 2)) === '–', await cellText(b3.id, 2));
await click(`[data-cell="${b4.id}:2"]`);
await waitJs(`document.querySelectorAll('.cellpanel .pfile').length === 2`, 'the cell\'s files');
ok('13 uploads: each file has its own room picker', (await js(`document.querySelectorAll('.cellpanel select[data-movefile]').length`)) === 2);
ok('13 uploads: the misplaced game says where it was scheduled',
  (await text('.cellpanel')).includes(`Scheduled in ${b3.room_name}.`), await text('.cellpanel'));
d = await detail();
const stray = d.files.find((f) => f.bucket_id === b4.id && f.round === 2 && f.filename.startsWith(r2[3].base));
await fill(`select[data-movefile="${stray.id}"]`, String(b3.id), ['change']);
d = await until(async () => { const x = await detail(); return x.files.find((f) => f.id === stray.id).bucket_id === b3.id && x; }, 'file moved');
ok('13 uploads: moving it through its picker reaches the Worker', true);
await waitJs(`document.querySelector('[data-cell="${b3.id}:2"]').textContent.trim() === '✓'
  && document.querySelector('[data-cell="${b4.id}:2"]').textContent.trim() === '✓'`, 'grid updated');
ok('13 uploads: the grid follows (✓ in both rooms)', true);

// Add a game: room 6, round 2, the match file and its MODAQ game file
await click('#addtoggle');
await waitJs(`!document.querySelector('#addpanel').hidden`, 'the Add a game panel');
{
  const f = r2[5];
  await fill('#addroom', String(b5.id), ['change']);
  await fill('#addround', '2', ['input']);
  await setFiles('#addfile', [writeFx(f.base + '_Game.json', '{"cycles":[]}'), writeFx(f.base + '.qbj', JSON.stringify(f.qbj))]);
  await waitJs(`document.querySelectorAll('#addlist .addfile').length === 2`, 'the picked files listed');
  ok('14 add a game: both files are labelled', (await text('#addlist')).includes('Match file') && (await text('#addlist')).includes('MODAQ game file'));
  await click('#addgame');
  d = await until(async () => { const x = await detail(); return x.files.filter((y) => y.bucket_id === b5.id && y.round === 2).length === 2 && x; }, 'both added');
  const kinds = d.files.filter((y) => y.bucket_id === b5.id && y.round === 2).map((y) => y.kind).sort().join(',');
  ok('14 add a game: both files land in that room and round', kinds === 'game,qbj', kinds);
  played.push({ round: 2, bucket: b5.id, qbj: f.qbj, filename: f.base + '.qbj' });
}
await waitJs(`document.querySelectorAll('.cellpanel .pfile').length === 2`, 'the new cell open');
{
  const game = d.files.find((y) => y.bucket_id === b5.id && y.round === 2 && y.kind === 'game');
  await click(`[data-delfile="${game.id}"]`);
  d = await until(async () => { const x = await detail(); return !x.files.some((y) => y.id === game.id) && x; }, 'file deleted');
  ok('13 uploads: Delete (confirmed) removes the file', dialogs.some((x) => x.startsWith('Delete this file')));
}

/* ---------- 18. an error notice stays ---------- */

await click('#addtoggle');
await waitJs(`!document.querySelector('#addpanel').hidden`, 'the panel again');
await click('#addgame');
await waitJs(`document.querySelector('#msg').classList.contains('bad') && document.querySelector('#msg').classList.contains('show')`, 'an error notice');
await new Promise((r) => setTimeout(r, 5500));
ok('18 notice: an error is still up after 5 seconds', await js(`document.querySelector('#msg').classList.contains('show')`));
await click('#msg');
ok('18 notice: and a click dismisses it', !(await js(`document.querySelector('#msg').classList.contains('show')`)));
await click('#addcancel');

/* ---------- 16. protests ---------- */

await openHub();
await waitJs(`!!document.querySelector('.pcompact')`, 'the open protest in the rail');
ok('16 protests: the rail shows the open protest', (await text('.pcompact')).includes('R1') && (await text('.pcompact')).includes(protestTeam),
  await text('.pcompact'));
ok('16 protests: with the note', (await text('.liverail')).includes('For your records only. The moderator should fix the game in MODAQ and re-export.'));
const pkey = await js(`document.querySelector('.pcompact [data-rule]').dataset.rule`);
await fill(`#protdrawer [data-rnote="${pkey}"]`, 'Checked against the answer line', ['change']);
d = await until(async () => { const x = await detail(); const r = JSON.parse(x.tournament.rulings || '{}')[pkey]; return r && r.note && x; }, 'note saved');
ok('16 protests: a ruling note persists', JSON.parse(d.tournament.rulings)[pkey].r === 'open');
await waitJs(`!!document.querySelector('.pcompact [data-rule]')`, 'rail select');
await fill('.pcompact [data-rule]', 'denied', ['change']);
d = await until(async () => { const x = await detail(); const r = JSON.parse(x.tournament.rulings || '{}')[pkey]; return r && r.r === 'denied' && x; }, 'ruling saved');
ok('16 protests: the rail\'s ruling persists with its note', JSON.parse(d.tournament.rulings)[pkey].note === 'Checked against the answer line');
await waitJs(`document.querySelector('.liverail').textContent.includes('Nothing open')`, 'nothing open');
ok('16 protests: then nothing is open', true);

/* ---------- 17. stats + exports ---------- */

d = await detail();
const good = d.files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
const parsed = played.map((p) => parseMatch(JSON.parse(JSON.stringify(p.qbj)), { filename: p.filename }));
const deduped = dedupeMatches(parsed);
const expectAgg = aggregate(deduped, rosterTeams);
ok('17 stats: every download is off before Compute', await js(`['dlmenu', 'dlyft4', 'dlyft3', 'dlreport', 'dlzip', 'rebuild'].every((id) => document.getElementById(id).disabled)`));
await click('#calc');
await waitJs(`!document.querySelector('#statsec').hidden && document.querySelector('#statsout table') && !document.querySelector('#dlmenu').disabled`, 'stats computed', 30000);
ok('17 stats: Compute renders the stats', (await text('#statsnote')) === `${good.length} games in these stats`, await text('#statsnote'));
ok('17 stats: Compute shows no errors', !(await exists('#statsout .bad')), await js(`[...document.querySelectorAll('#statsout .bad')].map((x) => x.textContent).join(' | ')`));
ok('17 stats: every download is on after', await js(`['dlmenu', 'dlyft4', 'dlyft3', 'dlreport', 'dlzip', 'rebuild'].every((id) => !document.getElementById(id).disabled)`));
const menu = async (id) => {
  await click('#dlmenu');
  await waitJs(`!document.querySelector('#dlpanel').hidden`, 'the menu');
  const f = await download('#' + id);
  await waitJs(`document.querySelector('#dlpanel').hidden`, 'the menu closing after ' + id);
  return f;
};
{
  const f = await menu('dlyft4');
  const y = JSON.parse(f.bytes.toString('utf8'));
  const t = y.objects[0];
  const games = t.phases.flatMap((p) => p.rounds.flatMap((r) => r.matches)).length;
  ok('17 exports: YellowFruit 4 .yft parses, 12 teams, every game', f.name === slug + '-yf4.yft'
    && t.registrations.flatMap((r) => r.teams).length === 12 && games === deduped.length,
  { name: f.name, teams: t.registrations.length, games, want: deduped.length });
}
{
  const f = await menu('dlyft3');
  const lines = f.bytes.toString('utf8').split('\n').map((l) => JSON.parse(l));
  ok('17 exports: YellowFruit 3 .yft parses, 12 teams, every game', f.name === slug + '-yf3.yft'
    && lines.length === 6 && lines[4].length === 12 && lines[5].length === deduped.length,
  { name: f.name, teams: lines[4].length, games: lines[5].length });
}
{
  const f = await menu('dlreport');
  const names = (await readZip(new Uint8Array(f.bytes))).map((e) => e.name);
  ok('17 exports: the HTML report zip has the six named pages', f.name === slug + '-report.zip'
    && ['standings', 'individuals', 'games', 'teamdetail', 'playerdetail', 'rounds'].every((p) => names.includes(`${slug}_${p}.html`)), names);
}
{
  const f = await menu('dlzip');
  const entries = await readZip(new Uint8Array(f.bytes));
  const names = entries.map((e) => e.name);
  const wantQbj = good.map((g) => `round-${g.round}/${g.filename.replace(/\.qbtd\.json$/i, '.qbj')}`);
  const wantGame = d.files.filter((g) => g.kind === 'combined' || g.kind === 'game')
    .map((g) => `round-${g.round}/${g.filename.replace(/\.qbtd\.json$/i, '_Game.json')}`);
  ok('17 exports: the QBJ bundle has every game as a .qbj', wantQbj.every((n) => names.includes(n)), { names, wantQbj });
  ok('17 exports: and every MODAQ game file, split out', wantGame.length >= 2 && wantGame.every((n) => names.includes(n)), { names, wantGame });
  ok('17 exports: no combined .qbtd.json in it', !names.some((n) => /\.qbtd\.json$/i.test(n)), names);
  ok('17 exports: everything in round folders, plus the roster', names.every((n) => /^round-\d+\//.test(n) || n === 'roster.qbj'), names);
  const pq = entries.find((e) => e.name === wantQbj[0]);
  ok('17 exports: a bundled .qbj is a match file', !!parseMatch(JSON.parse(new TextDecoder().decode(pq.data)), { filename: wantQbj[0] }));
}
await click('#dlmenu');
await waitJs(`!document.querySelector('#dlpanel').hidden`, 'the menu');
await click('#rebuild');
await waitJs(`/Stats data rebuilt \\(${good.length} games\\)/.test(document.querySelector('#msg').textContent)`, 'rebuild done', 20000);
ok('17 exports: Rebuild public stats posts every game', true);
await tick();
{
  const st = (await call('/pub/' + slug)).body;
  const q2 = Object.entries(st.rounds || {}).map(([n, v]) => n + '@' + v).join(',');
  const shards = (await call(`/pub/${slug}/rounds?n=${q2}`)).body.rounds;
  const n = shards.reduce((k, s) => k + s.entries.length, 0);
  ok('17 exports: after the cron tick the public data carries every game', n === good.length && Object.keys(st.rounds).sort().join() === '1,2',
    { n, want: good.length, rounds: Object.keys(st.rounds) });
}

/* ---------- 19–24. the public page ---------- */

const pubUrl = `${PAGES}/t.html?t=${slug}`;
await goto(pubUrl);
await waitJs(`!!document.querySelector('.nowgrid')`, 'the public Now view', 20000);
const st = (await call('/pub/' + slug)).body;
{
  const h = await js(`[...document.querySelectorAll('.nowhead')].map((x) => [x.querySelector('h3').textContent, x.querySelector('.nowtag').textContent])`);
  ok('19 public: Now opens on the live round, then the next', JSON.stringify(h)
    === JSON.stringify([[`Round ${st.current_round}`, 'Live now'], [`Round ${st.current_round + 1}`, 'Up next']]), h);
}
const shownGames = () => js(`[...document.querySelectorAll('.nowblock')[0].querySelectorAll('.gg')].map((g) => ({
  room: (g.querySelector('.groom') || {}).textContent,
  lines: [...g.querySelectorAll('.gl')].map((l) => ({ t: l.querySelector('.t').textContent, s: l.querySelector('.s') ? Number(l.querySelector('.s').textContent) : null, won: l.classList.contains('won') })) }))`);
{
  const games = await shownGames();
  const want = deduped.filter((m) => m.round === 2);
  let right = games.length === 6;
  for (const g of games) {
    const m = want.find((x) => x.teams.map((t) => t.name).sort().join() === g.lines.map((l) => l.t).sort().join());
    if (!m) { if (g.lines.some((l) => l.s !== null || l.won)) right = false; continue; }
    for (const l of g.lines) {
      const t = m.teams.find((x) => x.name === l.t);
      const o = m.teams.find((x) => x.name !== l.t);
      if (l.s !== t.points || l.won !== (t.points > o.points)) right = false;
    }
  }
  ok('19 public: live-round scores match the games, winners tinted', right && games.filter((g) => g.lines.some((l) => l.won)).length === want.length,
    { games, want: want.map((m) => m.teams.map((t) => t.name + ' ' + t.points)) });
}
ok('19 public: Up next lists the next round\'s games',
  (await js(`document.querySelectorAll('.nowblock')[1].querySelectorAll('.gg').length`)) === sched.phases.flatMap((p) => p.rounds).find((r) => r.round === 3).games.length);
await click('[data-pool="Pool A"]');
await waitJs(`document.querySelector('[data-pool="Pool A"]').classList.contains('on')`, 'Pool A chip on');
ok('19 public: the Pool A chip leaves only Pool A\'s games', await js(`(() => {
  const a = ${q(sched.pools.A)};
  const gs = [...document.querySelectorAll('.gg')];
  return gs.length > 0 && gs.every((g) => [...g.querySelectorAll('.gl .t')].every((t) => a.includes(t.textContent)));
})()`));
await click('[data-pool=""]');
await click('[data-schedview="all"]');
await waitJs(`!!document.querySelector('table.sched')`, 'the All rounds grid');
{
  const want = sched.phases.flatMap((p) => p.rounds.flatMap((r) => r.games)).length;
  const got = await js(`[...document.querySelectorAll('table.sched td')].filter((td) => td.querySelectorAll('.gl').length === 2).length`);
  ok('20 public: All rounds lists every scheduled game', got === want, { got, want });
}
await reload();
await waitJs(`!!document.querySelector('[data-schedview="all"].on')`, 'All rounds kept after reload');
ok('20 public: the view choice survives a reload', true);

await click('#tab-stats');
await waitJs(`!!document.querySelector('iframe.report')`, 'the classic report');
ok('21 stats: Classic is the default', await js(`document.querySelector('[data-layout="classic"]').classList.contains('on')`));
await check('21 stats: the classic report renders its standings', () => waitJs(`(() => { const f = document.querySelector('iframe.report');
  return (f.srcdoc || '').includes('Team Standings'); })()`, 'report content'));
await click('[data-layout="new"]');
await waitJs(`document.querySelectorAll('table.nstats').length > 0`, 'the New layout');
{
  const rows = await js(`[...document.querySelectorAll('table.nstats tr')].slice(0).filter((r) => r.querySelector('td.name'))
    .map((r) => { const c = [...r.querySelectorAll('td')];
      // the name cell also carries the rank a phone shows in place of the rank column (span.nrk)
      const rank = c[1].querySelector('.nrk');
      return [c[1].textContent.slice(rank ? rank.textContent.length : 0), Number(c[2].textContent), Number(c[3].textContent)]; })`);
  const want = expectAgg.teams.map((t) => [t.name, t.w, t.l]);
  const sort = (x) => JSON.stringify([...x].sort((a, b) => a[0].localeCompare(b[0])));
  ok('21 stats: New standings W/L match the games, per pool', sort(rows) === sort(want)
    && (await js(`document.querySelectorAll('.poolhead').length`)) === 2, { rows, want });
}
await reload();
await click('#tab-stats');
await waitJs(`document.querySelectorAll('table.nstats').length > 0`, 'New kept after reload');
ok('21 stats: the layout choice survives a reload', await js(`document.querySelector('[data-layout="new"]').classList.contains('on')`));

const expectPowers = expectAgg.players.some((p) => (p.counts[15] || 0) > 0);
await click('#tab-cats');
await waitJs(`!document.querySelector('#tab-cats').hidden && document.querySelector('#out table')`, 'categories');
{
  const heads = await js(`[...document.querySelector('#out table').querySelectorAll('th')].map((t) => t.textContent)`);
  ok('22 categories: the table renders, the 15 column only when there are powers', heads.includes('15') === expectPowers && heads.includes('10'),
    { heads, expectPowers });
}

await click('#tab-buzz');
await waitJs(`!!document.querySelector('#buzzpw')`, 'the buzzpoints password');
await fill('#buzzpw', 'hunter2', ['input']);
await click('#buzzgo');
await waitJs(`document.querySelectorAll('details.qd').length > 0`, 'buzzpoints for round 1', 20000);
{
  const entries = played.filter((p) => p.round === 1).map((p) => ({ round: 1, room: '', qbj: p.qbj }));
  const want = roundTossupBuzzes(entries, 1).map((t) => ({ tossup: t.tossup,
    gets: t.buzzes.filter((b) => b.value > 0).length, negs: t.buzzes.filter((b) => b.value < 0).length }));
  const got = await js(`[...document.querySelectorAll('details.qd')].filter((x) => /^T\\d+$/.test(x.querySelector('.roundcell').textContent.trim()))
    .map((x) => ({ tossup: Number(x.querySelector('.roundcell').textContent.trim().slice(1)),
      gets: x.querySelectorAll('.bdot.get, .bdot.pow').length, negs: x.querySelectorAll('.bdot.neg').length }))`);
  const same = want.every((w) => { const g = got.find((x) => x.tossup === w.tossup); return g && g.gets === w.gets && g.negs === w.negs; });
  ok('23 buzzpoints: a track per tossup, get and neg dots match the games', same && want.length > 0, { got: got.slice(0, 5), want: want.slice(0, 5) });
}

await phone();
await reload();
await waitJs(`!!document.querySelector('.tab')`, 'the public page on a phone');
ok('24 phone: no tab wraps or overflows', await js(`[...document.querySelectorAll('.tab')].filter((t) => !t.hidden).every((t) => {
  const lh = parseFloat(getComputedStyle(t).lineHeight) || 24;
  return t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().height < lh * 1.9 + 16; })`));
await click('#tab-cats');
await waitJs(`!!document.querySelector('#out table')`, 'categories on a phone');
ok('22 categories (phone): the chips are one swipeable row', await js(`(() => { const c = document.querySelector('#out .chips');
  const chips = [...c.querySelectorAll('.chip')]; const tops = new Set(chips.map((x) => Math.round(x.getBoundingClientRect().top)));
  return getComputedStyle(c).flexWrap === 'nowrap' && tops.size === 1 && c.scrollWidth > c.clientWidth; })()`));
ok('22 categories (phone): the team rides under the player', await js(`(() => {
  const sub = document.querySelector('#out .subteam'); const col = document.querySelector('#out td.teamcol');
  return !!sub && getComputedStyle(sub).display === 'block' && sub.textContent.length > 0 && (!col || getComputedStyle(col).display === 'none'); })()`));
await click('#tab-buzz');
await waitJs(`document.querySelectorAll('details.qd .btrack').length > 0`, 'buzz tracks on a phone', 20000);
ok('23 buzzpoints (phone): the tracks run full width', await js(`(() => { const t = document.querySelector('details.qd .btrack');
  return t.getBoundingClientRect().width > window.innerWidth * 0.6; })()`));
await click('#tab-schedule');
await waitJs(`!!document.querySelector('.schedviews')`, 'schedule on a phone');
ok('24 phone: the schedule view has no sideways page scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
await desktop();

/* ---------- 5b. the schedule editor at scale ---------- */

// 48 teams in 4 pools of 12, 24 rooms, 11 prelim rounds + 6 rounds of
// finish-position pools (double round robin): bigger than the format
// picker goes, built from the engine's own round robins
{
  d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const big = (await call('/api/tournaments', { method: 'POST', json: { name: 'UI E2E Big', slug: 'ui-big-' + Math.random().toString(36).slice(2, 7) } })).body;
  const BA = '/a/' + big.admin_secret;
  const teams = Array.from({ length: 48 }, (_, i) => 'Team ' + String(i + 1).padStart(2, '0'));
  await call(BA + '/roster?name=roster.qbj', { method: 'POST', body: JSON.stringify(buildRosterQbj('UI E2E Big', teams.map((n) => ({ name: n, players: [n + ' P1'] })))) });
  const pools = { A: [], B: [], C: [], D: [] };
  teams.forEach((t, i) => { const row = Math.floor(i / 4), col = i % 4; pools['ABCD'[row % 2 ? 3 - col : col]].push(t); });
  const pre = { name: 'Prelims', rounds: roundRobinRounds(12).map((rd, r) => ({ round: r + 1, byes: [],
    games: Object.values(pools).flatMap((m, p) => rd.pairs.map(([x, y], gi) => ({ room: p * 6 + gi, a: { team: m[x] }, b: { team: m[y] } }))) })) };
  const rr4 = roundRobinRounds(4);
  const play = { name: 'Playoffs', meet: 2, rounds: [...rr4, ...rr4].map((rd, r) => ({ round: 12 + r, byes: [],
    games: Array.from({ length: 12 }, (_, i) => i + 1).flatMap((pos) => rd.pairs.map(([x, y], gi) => ({ room: (pos - 1) * 2 + gi, a: { label: 'ABCD'[x] + pos }, b: { label: 'ABCD'[y] + pos } }))) })) };
  const bigSched = { v: 1, rooms: Array.from({ length: 24 }, (_, i) => ({ name: 'Room ' + (i + 1), bucket: null })), phases: [pre, play], pools, updated: 0 };
  tagBrackets(bigSched);
  ok('5b scale: a 48-team schedule saves', (await call(BA + '/schedule', { method: 'POST', json: bigSched })).status === 200);
  await goto(`${PAGES}/index.html?a=${big.admin_secret}`);
  await waitJs(`!!document.querySelector('[data-step="sched"]')`, 'big: steps');
  await click('[data-step="sched"]');
  await waitJs(`document.querySelectorAll('.sgcell').length > 0`, 'big: the grid');
  ok('5b scale: every room column in both phases', JSON.stringify(await js(`[...document.querySelectorAll('.sggrid')].map((g) => g.querySelectorAll('.sgroom:not(.sgroom-byes)').length)`)) === '[24,24]');
  ok('5b scale: all 17 rounds and 408 games', (await js(`document.querySelectorAll('.sgrnd').length`)) === 17 && (await js(`document.querySelectorAll('.sgcell:not(.empty)').length`)) === 408);
  ok('5b scale: 16 bracket lanes, and the double round robin is not flagged', (await js(`document.querySelectorAll('.sglane:not(.sglane-byes)').length`)) === 16
    && /all clear/.test(await text('.sgchecks')), await text('.sgchecks'));
  ok('5b scale: the grid scrolls inside its own box', await js(`(() => { const b = document.querySelector('#sgscroll'); return b.scrollWidth > b.clientWidth && b.scrollHeight > b.clientHeight; })()`));
  await js(`[...document.querySelectorAll('.sgchips .chip')].find((c) => c.textContent.trim() === 'Pool C').click(); true`);
  await waitJs(`document.querySelectorAll('.sggrid').length === 1 && document.querySelectorAll('.sgroom:not(.sgroom-byes)').length === 6`, 'big: Pool C only');
  ok('5b scale: a pool chip narrows the grid to that pool\'s six rooms', true);
  const t0 = Date.now();
  await dragOnto(`document.querySelectorAll('.sgslot[data-ref]')[0]`, `document.querySelectorAll('.sgslot[data-ref]')[3]`);
  await waitJs(`/1 unsaved change/.test(document.querySelector('.sgbar').textContent)`, 'big: a drag');
  ok('5b scale: a drag redraws quickly', Date.now() - t0 < 1500, Date.now() - t0);
  await click('#scheddiscard');
  await waitJs(`/Saved/.test(document.querySelector('.sgbar').textContent)`, 'big: discarded');
}

/* ---------- 12b. brackets that keep their own rounds ---------- */

// Two pools, set up through the Worker: Pool A a round ahead of Pool B, a
// Pool A room that started round 3 without its round 2 game, and a Pool B
// room that uploaded a round 3 game early. Then a round robin, which must
// look exactly as it always has.
async function bracketDay(name, format) {
  d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
  const t = (await call('/api/tournaments', { method: 'POST', json: { name, slug: 'ui-bk-' + Math.random().toString(36).slice(2, 7) } })).body;
  const TA = '/a/' + t.admin_secret;
  const rooms = [];
  for (let i = 0; i < 6; i++) rooms.push((await call(TA + '/buckets', { method: 'POST', json: { room_name: 'Hall ' + (i + 1) } })).body);
  await call(TA + '/roster?name=roster.qbj', { method: 'POST',
    body: JSON.stringify(buildRosterQbj(name, TEAMS.map((n) => ({ name: n, players: [player(n, 0)] })))) });
  const s2 = buildSchedule(format, TEAMS, rooms.map((r) => ({ name: r.room_name, bucket: r.id })));
  await call(TA + '/schedule', { method: 'POST', json: s2 });
  const last = Math.max(...s2.phases.flatMap((p) => p.rounds.map((r) => r.round)));
  for (let n = 1; n <= last; n++) {
    await call(`${TA}/packet?round=${n}&name=P${n}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: packetFor(n) });
  }
  await call(TA, { method: 'POST', json: { settings: { gameFormat: 'acf', autoAdvance: true } } });
  await call(TA + '/start', { method: 'POST' });
  const games = (n, key) => s2.phases.flatMap((p) => p.rounds).find((r) => r.round === n).games.filter((g) => g.a && g.b && (!key || g.bracket === key));
  const room = (g) => rooms[g.room];
  const start = (g, n) => call(`/b/${room(g).secret}/start?round=${n}`, { method: 'POST' });
  const upload = (g, n) => call(`/b/${room(g).secret}/upload?round=${n}&name=${encodeURIComponent(`Round_${n}_${g.a.team}.qbj`)}`,
    { method: 'POST', body: JSON.stringify(matchFor(n, g.a.team, g.b.team, g.room % 2 === 1)) });
  return { t, TA, rooms, s2, last, games, room, start, upload, detail: async () => (await call(TA)).body };
}
async function openHubOf(adminSecret) {
  await goto(`${PAGES}/index.html?a=${adminSecret}`);
  await waitJs(`!!document.querySelector('.hubtab')`, 'the hub');
  if (!(await exists('.biground'))) await click('[data-view="live"]');
  await waitJs(`!!document.querySelector('.biground')`, 'the Live Hub');
}
{
  const P = await bracketDay('UI E2E Pools', 'pools2');
  for (const g of P.games(1)) { await P.start(g, 1); await P.upload(g, 1); }
  for (const g of P.games(2, 'A')) await P.start(g, 2);
  for (const g of P.games(2, 'A').slice(0, 2)) await P.upload(g, 2);
  const lateA = P.games(3, 'A').find((g) => g.room === P.games(2, 'A')[2].room);
  await P.start(lateA, 3);                                   // round 2 still not in
  await P.upload(P.games(2, 'B')[0], 2);
  const earlyB = P.games(3, 'B')[2];
  await P.upload(earlyB, 3);                                  // before round 3 opened for Pool B
  let x = await P.detail();
  const br = JSON.parse(x.tournament.bracket_rounds);
  ok('12b brackets: the Worker has Pool A on round 3, Pool B on 2', x.tournament.current_round === 2 && br.A === 3 && br.B === 2, br);

  await openHubOf(P.t.admin_secret);
  ok('12b brackets: Round 3 / 8, Prelims round 3 of 5, one pool behind',
    (await text('.biground')).replace(/\s+/g, ' ').trim() === 'Round 3 / 8'
      && (await text('.roundline')).replace(/\s+/g, ' ').includes('Prelims · round 3 of 5 · 1 bracket still on round 2'),
    await text('.roundline'));
  ok('12b brackets: Live now has a heading per pool', JSON.stringify(await liveHeads()) === JSON.stringify(['Pool A', 'Pool B']), await liveHeads());
  // each heading's count, worked out from the Worker's files
  const good = (f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error;
  for (const key of ['A', 'B']) {
    const gs = P.games(br[key], key);
    const nIn = gs.filter((g) => x.files.some((f) => f.bucket_id === P.room(g).id && f.round === br[key] && good(f))).length;
    const head = (await js(`document.querySelector('.bgroup[data-bracket="${key}"] .bhead').textContent`)).replace(/\s+/g, ' ');
    ok(`12b brackets: Pool ${key}'s heading says ${nIn}/${gs.length} in${key === 'B' ? ' and that it is still on round 2' : ''}`,
      head.includes(`${nIn}/${gs.length} in`) && (key === 'B') === head.includes('still on round 2'), head);
  }
  const rowNote = (bid) => js(`((document.querySelector('.brow[data-room="${bid}"] .bnote') || {}).textContent || '')`);
  const rowMark = (bid) => js(`document.querySelector('.brow[data-room="${bid}"] .lmark').textContent.trim()`);
  ok('12b brackets: a room that started round 3 without its round 2 game is flagged',
    (await rowNote(P.room(lateA).id)) === 'Round 2 game still not in. Started round 3 anyway.' && (await rowMark(P.room(lateA).id)) === '!',
    await rowNote(P.room(lateA).id));
  ok('12b brackets: a room that uploaded for a round it hasn\'t reached is flagged',
    (await rowNote(P.room(earlyB).id)) === 'Also uploaded a round 3 game before round 3 opened. Check its round number.'
      && (await rowMark(P.room(earlyB).id)) === '!' && x.early.length === 1,
    [await rowNote(P.room(earlyB).id), x.early]);
  ok('12b brackets: every other row is unflagged', (await js(`document.querySelectorAll('.brow .bnote').length`)) === 2);
  const startedNow = P.rooms.filter((b) => (x.starts || []).some((s2) => s2.bucket_id === b.id && s2.round === x.room_rounds[b.id])).length;
  const rail = (await text('.railtoggle')).replace(/\s+/g, ' ');
  ok(`12b brackets: auto-advance says ${startedNow}/6 started`, rail.includes(`${startedNow}/6 started`), rail);
  const lines = await js(`[...document.querySelectorAll('.bline')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`);
  ok('12b brackets: the rail lists each pool, its round and its own Advance',
    lines.length === 2 && lines[0].startsWith('Pool A rd 3') && lines[1].startsWith('Pool B rd 2') && lines.every((l) => l.endsWith('Advance')), lines);
  ok('12b brackets: Advance all to round 4, and who catches up',
    (await text('#advall')).trim() === 'Advance all to round 4' && (await text('.liverail')).includes('Pool B catches up to round 4 too.'));
  ok('12b brackets: the uploads grid names the phases over the rounds',
    JSON.stringify(await js(`[...document.querySelectorAll('.ugrid tr.uphase th span')].map((e) => e.textContent)`)) === JSON.stringify(['Prelims', 'Playoffs']));
  ok('12b brackets: and groups its rooms by pool',
    JSON.stringify(await js(`[...document.querySelectorAll('.ugrid tr.ugroup b')].map((e) => e.textContent)`)) === JSON.stringify(['Pool A', 'Pool B']));
  const a0 = P.room(P.games(1, 'A')[0]).id;
  ok('12b brackets: a cell says its round and pool',
    (await js(`document.querySelector('[data-cell="${a0}:1"]').title`)) === 'Round 1 · Pool A: Game in',
    await js(`document.querySelector('[data-cell="${a0}:1"]').title`));

  // Pool B's own Advance, through the page, reaches the Worker
  await click('[data-advbracket="B"]');
  x = await until(async () => { const y = await P.detail(); return JSON.parse(y.tournament.bracket_rounds).B === 3 && y; }, 'Pool B advanced');
  ok('12b brackets: Pool B\'s Advance moves Pool B only, and the Worker agrees',
    x.tournament.current_round === 3 && JSON.parse(x.tournament.bracket_rounds).A === 3, x.tournament);
  await waitJs(`!document.querySelector('.bgroup[data-bracket="B"] .bhead').textContent.includes('still on round')`, 'Pool B caught up on the page');
  ok('12b brackets: the hub follows', (await text('.roundline')).replace(/\s+/g, ' ').includes('Prelims · round 3 of 5')
    && !(await text('.roundline')).includes('still on round'));

  // the reader and the upload page of a Pool B room say which pool it is in
  const gB = P.games(3, 'B')[0];
  const bB = P.room(gB);
  await goto(`${PAGES}/read.html?b=${bB.secret}`);
  await waitJs(`!document.querySelector('#schedpanel').hidden && !document.querySelector('#schedmatch').hidden`, 'the Pool B reader');
  ok('12b reader: the header says the room, its round and its pool',
    (await text('#room')).replace(/\s+/g, ' ').trim() === `${bB.room_name} · Round 3 · Pool B`, await text('#room'));
  ok('12b reader: From the schedule names the pool',
    (await text('#schedfrom')).replace(/\s+/g, ' ').trim() === `From the schedule · Pool B · Round 3 in ${bB.room_name}`, await text('#schedfrom'));
  const heads = await js(`[...document.querySelectorAll('#schedrows tr.bhrow')].map((r) => r.textContent.trim())`);
  ok('12b reader: this room\'s schedule splits under phase and bracket headings',
    heads.length === 2 && heads[0] === 'Prelims · Pool B' && /^Playoffs · (Championship|Consolation)$/.test(heads[1]), heads);
  ok('12b reader: playoff games read as placeholders until filled',
    (await js(`[...document.querySelectorAll('#schedrows tr:not(.bhrow)')].slice(-1)[0].textContent`)).match(/Pool [AB] \d+(st|nd|rd|th) v Pool [AB] \d+(st|nd|rd|th)/) !== null,
    await js(`[...document.querySelectorAll('#schedrows tr:not(.bhrow)')].slice(-1)[0].textContent`));
  await goto(`${PAGES}/bucket.html?b=${bB.secret}`);
  await waitJs(`!!document.querySelector('#curround .bname')`, 'the Pool B upload page');
  ok('12b room page: Now on round 3 · Pool B · the game',
    (await text('#curround')).replace(/\s+/g, ' ').trim() === `Now on round 3 · Pool B · ${gB.a.team} vs ${gB.b.team}`, await text('#curround'));
}
{
  // a round robin: one bracket, no bracket anything
  const R = await bracketDay('UI E2E Round Robin', 'rr');
  for (const g of R.games(1)) { await R.start(g, 1); await R.upload(g, 1); }
  const x = await R.detail();
  ok('12b round robin: the Worker keeps one round', x.tournament.bracket_rounds === null && x.tournament.current_round === 2, x.tournament);
  await openHubOf(R.t.admin_secret);
  ok('12b round robin: Live now is the plain list, no headings',
    (await js(`document.querySelectorAll('.bcols, .bgroup, .brow').length`)) === 0 && (await js(`document.querySelectorAll('.lrow').length`)) === 6);
  ok('12b round robin: no phase line, the usual Advance',
    !/round \d+ of \d+/.test(await text('.roundline')) && (await text('#advround')).trim() === 'Advance to round 3'
      && !(await exists('.bline')) && !(await exists('.ugrid tr.ugroup')) && !(await exists('.ugrid tr.uphase')));
  await goto(`${PAGES}/read.html?b=${R.rooms[0].secret}`);
  await waitJs(`!document.querySelector('#schedpanel').hidden`, 'the round robin reader');
  ok('12b round robin: the reader header has no bracket', (await text('#room')).replace(/\s+/g, ' ').trim() === `${R.rooms[0].room_name} · Round 2`
    && !(await exists('#schedrows tr.bhrow')), await text('#room'));
  await goto(`${PAGES}/bucket.html?b=${R.rooms[0].secret}`);
  await waitJs(`!document.querySelector('#roundcard').hidden`, 'the round robin upload page');
  ok('12b round robin: the upload page says the round alone', (await text('#curround')).trim() === 'Now on round 2', await text('#curround'));
}

/* ---------- 24b. the public state from qb-td-live ----------
   A stand-in for the files-only Worker (worker.js "public state on
   qb-td-live"): serves /t/<slug>.json as the real one does (CORS, max-age
   0), in whatever state a check needs. The page's fetches are recorded,
   so each check can count exactly the Worker requests for the state. */
{
  const { createServer } = await import('node:http');
  const real = (await call('/pub/' + slug)).body;
  let mode = 'ok';
  let liveHits = 0;
  let bodyAt = Date.now();
  const fileFor = () => {
    const now = Date.now();
    if (mode === 'older') return { ...real, name: 'OLDER ' + real.name, at: bodyAt - 60000, hb_ms: 600000, hb_until: now + 3600000 };
    if (mode === 'frozen') return { ...real, name: 'FROZEN ' + real.name, at: now - 30 * 60000, hb_ms: 600000, hb_until: now + 3600000 };
    bodyAt = now;
    return { ...real, name: 'LIVE ' + real.name, at: now, hb_ms: 600000, hb_until: now + 3600000 };
  };
  const server = createServer((req, res) => {
    liveHits++;
    const head = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=0, must-revalidate' };
    if (req.url !== '/t/' + slug + '.json' || mode === '404') { res.writeHead(404, head); res.end('not found'); return; }
    if (mode === '500') { res.writeHead(500, head); res.end('oops'); return; }
    if (mode === 'hang') { setTimeout(() => { try { res.writeHead(200, head); res.end('{}'); } catch (e) { /* gone */ } }, 7000); return; }
    res.writeHead(200, { ...head, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fileFor()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const LIVE_URL = 'http://127.0.0.1:' + server.address().port;
  const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source:
    `window.__urls = []; const __f = window.fetch; window.fetch = (u, o) => { window.__urls.push(String(u)); return __f(u, o); };` });
  const liveUrl = `${PAGES}/t.html?t=${slug}&live=${encodeURIComponent(LIVE_URL)}`;
  // Worker requests for the state itself (not its blobs), with their ?fb=
  const stateCalls = () => js(`window.__urls.filter((u) => { try { return new URL(u).pathname === '/pub/' + ${q(slug)}; }
    catch (e) { return false; } }).map((u) => new URL(u).searchParams.get('fb'))`);
  const shownName = () => text('#tname');
  // a fresh tab state: no latch, then load
  const fresh = async (m, url = liveUrl) => {
    mode = m;
    await goto(url);
    await js('sessionStorage.clear(); true');
    await reload();
  };
  const refresh = async () => { await click('#refresh'); await new Promise((r) => setTimeout(r, 400)); };

  await fresh('ok');
  await waitJs(`document.querySelector('#tname').textContent === ${q('LIVE ' + real.name)}`, 'the state from the live file');
  ok('24b live: the state comes from the file, no Worker state request', JSON.stringify(await stateCalls()) === '[]', await stateCalls());
  const hits = liveHits;
  await refresh();
  ok('24b live: refresh re-reads the file, still no Worker state request',
    liveHits > hits && JSON.stringify(await stateCalls()) === '[]', { liveHits, calls: await stateCalls() });

  mode = 'older';
  await refresh();
  ok('24b live: an older file on refresh is "nothing new"', (await shownName()) === 'LIVE ' + real.name
    && JSON.stringify(await stateCalls()) === '[]', { name: await shownName(), calls: await stateCalls() });

  await fresh('404');
  await waitJs(`document.querySelector('#tname').textContent === ${q(real.name)}`, 'the Worker after a 404');
  ok('24b live: 404 -> exactly one Worker request, no latch', JSON.stringify(await stateCalls()) === '["404"]'
    && !(await js(`sessionStorage.getItem('qbtd-live-off')`)), await stateCalls());

  await fresh('500');
  await waitJs(`document.querySelector('#tname').textContent === ${q(real.name)}`, 'the Worker after a 500');
  ok('24b live: 500 -> exactly one Worker request, latched', JSON.stringify(await stateCalls()) === '["err"]'
    && !!(await js(`sessionStorage.getItem('qbtd-live-off')`)), await stateCalls());
  mode = 'ok';
  const latchedHits = liveHits;
  await refresh();
  ok('24b live: latched tab skips the file for now: one Worker request per refresh',
    liveHits === latchedHits && JSON.stringify(await stateCalls()) === '["err","latched"]', { calls: await stateCalls() });

  await fresh('frozen');
  await waitJs(`document.querySelector('#tname').textContent === ${q(real.name)}`, 'the Worker for a frozen file');
  ok('24b live: a file overdue for its heartbeat -> the Worker, once', JSON.stringify(await stateCalls()) === '["old"]', await stateCalls());

  await fresh('hang');
  await waitJs(`document.querySelector('#tname').textContent === ${q(real.name)}`, 'the Worker after a timeout', 12000);
  ok('24b live: a hung file times out -> exactly one Worker request', JSON.stringify(await stateCalls()) === '["err"]', await stateCalls());

  await fresh('ok', `${PAGES}/t.html?t=${slug}&live=off`);
  await waitJs(`document.querySelector('#tname').textContent === ${q(real.name)}`, 'the Worker with ?live=off');
  ok('24b live: ?live=off asks the Worker as before (no fb)', JSON.stringify(await stateCalls()) === '[null]', await stateCalls());

  await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await new Promise((r) => server.close(r));
}

/* ---------- 25. no page errors anywhere ---------- */

ok('25 no uncaught page errors on any page', pageErrors.length === 0, pageErrors);

ws.close();
cleanup();
try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
summary('ui e2e');
process.exit(process.exitCode || 0);
