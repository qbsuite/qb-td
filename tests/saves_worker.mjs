// saves_worker.mjs — E10, the Worker side: two tabs saving the same
// tournament. A save that says what its copy was (settings_base and
// settings_touched, rulings_prev, X-Qbtd-Base on the schedule, ?base= on
// the roster) keeps the other tab's change; a copy that was current is
// stored exactly as a save without one stores it. worker.js runs in this
// process (tests/inproc_worker.mjs), so each case also checks the D1 and
// R2 operations it costs. Saves without a base are held to the E3
// goldens (worker_inproc.mjs), not here.
// Run: node tests/saves_worker.mjs (part of npm test; Node 22.5+).

import assert from 'node:assert/strict';
import { workerHarness } from './inproc_worker.mjs';
import { mergeSettings, mergeRulings, rulingsCurrent } from '../worker/worker.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n    ' + (e && e.stack || e)); }
}
const enc = encodeURIComponent;
// D1 writes and R2 deletes (a refused conditional put writes nothing:
// the cases check the stored object itself)
const writes = (ops) => ops.filter((l) => /^d1 (run|batch)|^r2 delete/.test(l));

/* ---------- mergeSettings and mergeRulings, on their own ---------- */

const S = (o) => JSON.stringify(o);

await test('settings: a key the stale tab did not touch keeps what is stored', () => {
  const base = { gameFormat: 'acf', catStats: true };
  const stored = { gameFormat: 'acf', catStats: true, autoAdvance: true };
  const mine = { ...base, catStats: false };
  const { settings, changed } = mergeSettings(S(base), mine, S(stored));
  assert.deepEqual(settings, { gameFormat: 'acf', catStats: false, autoAdvance: true });
  assert.deepEqual(changed, ['catStats']);
});
await test('settings: a key the tab dropped goes; a key it added comes last', () => {
  const base = { a: 1, rounds: 5, autoAdvance: true };
  const stored = { a: 1, rounds: 6, autoAdvance: true, z: 2 };
  const mine = { a: 1, rounds: 5, statsSeen: true };
  assert.equal(S(mergeSettings(S(base), mine, S(stored)).settings), S({ a: 1, rounds: 6, z: 2, statsSeen: true }));
});
await test('settings: the preset and its overrides move together (a stale preset pick)', () => {
  // tab A saved preset P1 with overrides; tab B, still on the copy without
  // them, picks P2: exactly B's {gameFormat: P2}, no overrides
  const base = { gameFormat: 'P0', catStats: true };
  const stored = { gameFormat: 'P1', formatOverrides: { tossups: 22 }, catStats: true };
  const mine = { ...base, gameFormat: 'P2' };
  const { settings } = mergeSettings(S(base), mine, S(stored));
  assert.deepEqual(settings, { gameFormat: 'P2', catStats: true });
});
await test('settings: overrides changed alone bring this tab\'s preset too', () => {
  const base = { gameFormat: 'P0' };
  const stored = { gameFormat: 'P1', catStats: false };
  const mine = { gameFormat: 'P0', formatOverrides: { bonuses: false } };
  assert.deepEqual(mergeSettings(S(base), mine, S(stored)).settings, { gameFormat: 'P0', catStats: false, formatOverrides: { bonuses: false } });
});
await test('settings: touched keys apply when the tab\'s copy already agreed (Reset to preset)', () => {
  // the tab's copy never had overrides (saved, then reset before its
  // refresh, or a stale tab): Reset must still clear the stored ones
  const base = { gameFormat: 'acf' };
  const stored = { gameFormat: 'acf', formatOverrides: { tossups: 22 } };
  const mine = { gameFormat: 'acf' };
  assert.deepEqual(mergeSettings(S(base), mine, S(stored)).settings, stored, 'untouched: kept');
  assert.deepEqual(mergeSettings(S(base), mine, S(stored), ['gameFormat', 'formatOverrides']).settings, { gameFormat: 'acf' });
});
await test('settings: statsSeen touched is stored even when the tab\'s copy had it', () => {
  const base = { statsSeen: true, catStats: true };
  const stored = { catStats: true };
  const mine = { statsSeen: true, catStats: false };
  assert.deepEqual(mergeSettings(S(base), mine, S(stored), ['statsSeen']).settings, { catStats: false, statsSeen: true });
  assert.deepEqual(mergeSettings(S(base), mine, S(stored)).settings, { catStats: false }, 'without touched: not this tab\'s change');
});
await test('settings: buzz merges key by key while the password stays', () => {
  const base = { buzz: { mode: 'password', hash: 'h1', salt: 's1' } };
  const stored = { buzz: { mode: 'password', hash: 'h2', salt: 's2' } };
  const mine = { buzz: { mode: 'off', hash: 'h1', salt: 's1' } };
  assert.deepEqual(mergeSettings(S(base), mine, S(stored)).settings, { buzz: { mode: 'off', hash: 'h2', salt: 's2' } });
});
await test('settings: a new password takes the tab\'s whole buzz (hash and wrap stay a pair)', () => {
  const base = { buzz: { mode: 'off', hash: 'h1', salt: 's1' } };
  const stored = { buzz: { mode: 'password', hash: 'h2', salt: 's2' } };
  const mine = { buzz: { mode: 'off', hash: 'h3', salt: 's3' } };
  assert.deepEqual(mergeSettings(S(base), mine, S(stored)).settings, { buzz: mine.buzz });
  // the same hash sent again with a token (the password set once more): whole too
  const again = { buzz: { mode: 'password', hash: 'h1', salt: 's1' } };
  assert.deepEqual(mergeSettings(S(base), again, S(stored), [], true).settings, { buzz: again.buzz });
});
await test('settings: a stale catStats toggle after a password was set keeps the password', () => {
  const base = { catStats: true };
  const stored = { catStats: true, buzz: { mode: 'password', hash: 'h', salt: 's' }, scoresheets: true };
  assert.deepEqual(mergeSettings(S(base), { catStats: false }, S(stored)).settings, { ...stored, catStats: false });
});
await test('settings: statsOpen on and off from a stale tab', () => {
  const stored = { catStats: false };
  assert.deepEqual(mergeSettings(S({}), { statsOpen: true }, S(stored)).settings, { catStats: false, statsOpen: true });
  assert.deepEqual(mergeSettings(S({ statsOpen: true }), {}, S({ statsOpen: true, catStats: false })).settings, { catStats: false });
});
await test('settings: an unreadable stored copy gives the tab\'s whole object; a bad base is refused', () => {
  assert.deepEqual(mergeSettings(S({}), { a: 1 }, 'not json').settings, { a: 1 });
  assert.equal(mergeSettings('not json', { a: 1 }, S({})).error, 'bad settings');
  assert.equal(mergeSettings('[1]', { a: 1 }, S({})).error, 'bad settings');
});
await test('rulings: the copy as it was is what is stored: the map as sent', () => {
  const stored = { k1: { r: 'upheld', note: '', at: 1 } };
  const mine = { ...stored, k2: { r: 'denied', note: 'n', at: 2 } };
  assert.equal(mergeRulings({ k2: null }, mine, S(stored)), mine);
});
await test('rulings: another tab\'s ruling is kept; each ruling whole', () => {
  const stored = { k1: { r: 'upheld', note: '', at: 1 }, k3: { r: 'denied', note: 'other tab', at: 3 } };
  const mine = { k1: { r: 'upheld', note: '', at: 1 }, k2: { r: 'denied', note: 'n', at: 2 } };
  assert.equal(S(mergeRulings({ k2: null }, mine, S(stored))), S({ ...stored, k2: mine.k2 }));
});
await test('rulings: the current-copy check on the texts agrees with the whole-copy one', () => {
  const k1 = 'r1|q3|Alpha|Beta';
  const k2 = 'r2|q7|Beta "B"|Alpha';
  const stored = { [k1]: { r: 'upheld', note: 'é \u0001', at: 1 }, x: { r: 'denied', note: '', at: 2 } };
  const text = S(stored);
  const json = (m) => S(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { r: v.r, note: v.note.trim(), at: v.at }])));
  // a new ruling, last
  let mine = { ...stored, [k2]: { r: 'denied', note: ' n ', at: 3 } };
  assert.equal(rulingsCurrent({ [k2]: null }, mine, json(mine), text), true);
  assert.equal(rulingsCurrent({ [k2]: null }, mine, json(mine), S({ ...stored, y: { r: 'open', note: 'o', at: 4 } })), false);
  assert.equal(rulingsCurrent({ [k2]: null }, { [k2]: mine[k2] }, json({ [k2]: mine[k2] }), '{}'), true);
  // one changed in its place
  mine = { ...stored, [k1]: { r: 'withdrawn', note: 'w', at: 5 } };
  assert.equal(rulingsCurrent({ [k1]: stored[k1] }, mine, json(mine), text), true);
  assert.equal(rulingsCurrent({ [k1]: { ...stored[k1], note: 'other' } }, mine, json(mine), text), false);
  assert.equal(rulingsCurrent({ [k1]: stored[k1] }, mine, json(mine), S({ ...stored, x: { r: 'upheld', note: '', at: 2 } })), false);
  // a dropped ruling, several, or none: left to the whole-copy check
  const { [k1]: _gone, ...rest } = stored;
  assert.equal(rulingsCurrent({ [k1]: stored[k1] }, rest, json(rest), text), false);
  assert.equal(rulingsCurrent({}, stored, json(stored), text), false);
  const added = { ...stored, [k2]: { r: 'denied', note: 'n', at: 3 } };
  assert.equal(mergeRulings({ [k2]: null }, added, text), added, 'the whole-copy check: current');
  // (a dropped ruling can't be put back in its place there: the merge, the same map)
  assert.equal(S(mergeRulings({ [k1]: stored[k1] }, rest, text)), S(rest));
});
await test('rulings: a reopened ruling goes; one sent unchanged is not this tab\'s change', () => {
  const stored = { k1: { r: 'upheld', note: '', at: 1 }, k2: { r: 'withdrawn', note: 'later', at: 9 } };
  const mine = { k2: { r: 'denied', note: '', at: 2 } };
  assert.equal(S(mergeRulings({ k1: stored.k1, k2: mine.k2 }, mine, S(stored))), S({ k2: stored.k2 }));
});

/* ---------- the routes: two tabs on one tournament ---------- */

const w = await workerHarness();
const { call, measured, quiet, sql, raw, rawObj, etag, env } = w;
const T = (await quiet(() => call('/api/tournaments', { method: 'POST', json: { name: 'Two Tabs', slug: 'two-tabs' } }))).body;
const A = '/a/' + T.admin_secret;
const tid = T.id;
const rooms = [];
for (let k = 0; k < 2; k++) rooms.push((await quiet(() => call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } }))).body);
const row = () => sql('SELECT settings, rulings, buzz_wrap FROM tournaments WHERE id = ?', tid)[0];
// what a hub holds: the settings text as read, parsed
const read = () => JSON.parse(row().settings);
const saveSettings = (body) => measured(() => call(A, { method: 'POST', json: body }));
const OPEN = `t/${tid}/open-key.json`;
// the D1 statement the next matching call prepares runs `before` first
// (another tab's write landing in the moment between)
function beforeStatement(re, before, times = 1) {
  const prepare = env.DB.prepare;
  let left = times;
  env.DB.prepare = (q) => {
    const st = prepare(q);
    if (!left || !re.test(q)) return st;
    left--;
    if (!left) env.DB.prepare = prepare;
    const wrapRun = (s) => ({ ...s, bind: (...a) => wrapRun(s.bind(...a)), run: async () => { before(); return s.run(); } });
    return wrapRun(st);
  };
}
const setStored = (s) => sql('UPDATE tournaments SET settings = ? WHERE id = ?', JSON.stringify(s), tid);

await test('settings, equal base: stored exactly as a save without a base; the UPDATE checks the copy', async () => {
  const tab = read();
  const next = { ...tab, gameFormat: 'acf', catStats: true };
  const { res, ops } = await saveSettings({ settings: next, settings_base: JSON.stringify(tab) });
  assert.equal(res.status, 200);
  assert.equal(row().settings, JSON.stringify(next));
  assert.ok(ops.includes('d1 run UPDATE tournaments SET settings = ? WHERE id = ? AND settings = ?'), ops.join('\n'));
});

await test('settings, two tabs: each keeps the other\'s change', async () => {
  const tabA = read();
  const tabB = read();
  let r = await saveSettings({ settings: { ...tabA, catStats: false }, settings_base: JSON.stringify(tabA) });
  assert.equal(r.res.status, 200);
  r = await saveSettings({ settings: { ...tabB, rounds: 7 }, settings_base: JSON.stringify(tabB) });
  assert.equal(r.res.status, 200);
  assert.deepEqual(read(), { gameFormat: 'acf', catStats: false, rounds: 7 });
  // the stale tab's merge costs what the save does: no more statements
  assert.deepEqual(r.ops.filter((l) => l.startsWith('d1')), [
    'd1 all SELECT * FROM tournaments WHERE admin_secret = ?1 OR admin_secret = ?2',
    'd1 run UPDATE tournaments SET settings = ? WHERE id = ? AND settings = ?',
    'd1 run UPDATE tournaments SET pub_dirty = 1, pub_dirty_at = COALESCE(pub_dirty_at, ?2) WHERE id = ?1']);
});

await test('settings, two tabs: a stale preset pick does not keep the other tab\'s overrides', async () => {
  const tabB = read();
  const tabA = read();
  await saveSettings({ settings: { ...tabA, gameFormat: 'naqt', formatOverrides: { tossups: 22 } }, settings_base: JSON.stringify(tabA),
    settings_touched: ['gameFormat', 'formatOverrides'] });
  await saveSettings({ settings: { ...tabB, gameFormat: 'pace' }, settings_base: JSON.stringify(tabB), settings_touched: ['gameFormat', 'formatOverrides'] });
  assert.deepEqual(read(), { gameFormat: 'pace', catStats: false, rounds: 7 });
});

await test('settings: Save format, then Reset before the refresh lands (one tab), clears the overrides', async () => {
  const tab = read();
  await saveSettings({ settings: { ...tab, formatOverrides: { bonuses: false } }, settings_base: JSON.stringify(tab),
    settings_touched: ['gameFormat', 'formatOverrides'] });
  assert.deepEqual(read().formatOverrides, { bonuses: false });
  // Reset sends the preset from the copy it still holds (no overrides)
  const { res } = await saveSettings({ settings: { ...tab }, settings_base: JSON.stringify(tab), settings_touched: ['gameFormat', 'formatOverrides'] });
  assert.equal(res.status, 200);
  assert.deepEqual(read(), tab);
});

await test('settings, two tabs: a stale catStats toggle after a password was set keeps the hash and the wrap', async () => {
  const tabB = read();
  const tabA = read();
  const buzz = { mode: 'password', kdf: 'pbkdf2', iters: 1, salt: 'aa', hash: 'h-one' };
  let r = await saveSettings({ settings: { ...tabA, buzz, scoresheets: true }, settings_base: JSON.stringify(tabA), buzz_token: 'token-one' });
  assert.equal(r.res.status, 200);
  const wrap = row().buzz_wrap;
  assert.ok(wrap);
  r = await saveSettings({ settings: { ...tabB, catStats: true }, settings_base: JSON.stringify(tabB) });
  assert.equal(r.res.status, 200);
  assert.deepEqual(read().buzz, buzz);
  assert.equal(read().scoresheets, true);
  assert.equal(read().catStats, true);
  assert.equal(row().buzz_wrap, wrap);
  assert.ok(!r.ops.some((l) => l.startsWith('crypto wrapKey') || l.includes('encrypt')), r.ops.join('\n'));
});

await test('settings, two tabs: a stale tab setting a new password brings its whole buzz and its wrap', async () => {
  const tabB = { ...read(), buzz: undefined, scoresheets: undefined };
  delete tabB.buzz; delete tabB.scoresheets;
  const wrapBefore = row().buzz_wrap;
  const buzz = { mode: 'off', kdf: 'pbkdf2', iters: 1, salt: 'bb', hash: 'h-two' };
  const { res } = await saveSettings({ settings: { ...tabB, buzz }, settings_base: JSON.stringify(tabB), buzz_token: 'token-two' });
  assert.equal(res.status, 200);
  assert.deepEqual(read().buzz, buzz);
  assert.equal(read().scoresheets, true, 'the other tab\'s scoresheets stay');
  assert.notEqual(row().buzz_wrap, wrapBefore);
});

await test('settings, two tabs: a merge needing a password with none stored is refused, and nothing is written', async () => {
  setStored({ catStats: true, statsOpen: true });
  const tabB = read();   // sees "No password"
  const tabA = read();
  await saveSettings({ settings: { catStats: true }, settings_base: JSON.stringify(tabA) });   // A: password back on, none set
  const before = row().settings;
  const { res, ops } = await saveSettings({ settings: { ...tabB, scoresheets: true }, settings_base: JSON.stringify(tabB) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'set a password first');
  assert.equal(row().settings, before);
  assert.deepEqual(writes(ops), []);
});

await test('settings: statsOpen from a stale tab puts the open key; switched off again, it goes', async () => {
  setStored({ catStats: true });
  const tabB = read();
  const tabA = read();
  await saveSettings({ settings: { catStats: false }, settings_base: JSON.stringify(tabA) });
  let r = await saveSettings({ settings: { ...tabB, statsOpen: true }, settings_base: JSON.stringify(tabB) });
  assert.equal(r.res.status, 200);
  assert.deepEqual(read(), { catStats: false, statsOpen: true });
  assert.ok(raw(OPEN));
  assert.ok(r.ops.includes('r2 put ' + OPEN));
  r = await saveSettings({ settings: { catStats: false }, settings_base: JSON.stringify({ catStats: false, statsOpen: true }) });
  assert.equal(raw(OPEN), null);
});

await test('settings: auto-advance runs when this request switches it on, not on another tab\'s say', async () => {
  const advanceRead = 'd1 all SELECT current_round, settings, bracket_rounds FROM tournaments WHERE id = ?1';
  setStored({ catStats: true });
  const tabB = read();
  const tabA = read();
  // A switches it on (equal base): runs
  let r = await saveSettings({ settings: { ...tabA, autoAdvance: true }, settings_base: JSON.stringify(tabA) });
  assert.ok(r.ops.includes(advanceRead));
  // B, stale, toggles catStats: A's autoAdvance stays on, and B does not run it
  r = await saveSettings({ settings: { ...tabB, catStats: false }, settings_base: JSON.stringify(tabB) });
  assert.deepEqual(read(), { catStats: false, autoAdvance: true });
  assert.ok(!r.ops.includes(advanceRead), r.ops.join('\n'));
  // a current tab saving anything with it on runs it, as a save without a base does
  const cur = read();
  r = await saveSettings({ settings: { ...cur, catStats: true }, settings_base: JSON.stringify(cur) });
  assert.ok(r.ops.includes(advanceRead));
  // a stale tab that switches it on itself runs it
  setStored({ catStats: true });
  const tabC = read();
  setStored({ catStats: true, rounds: 4 });
  r = await saveSettings({ settings: { ...tabC, autoAdvance: true }, settings_base: JSON.stringify(tabC) });
  assert.deepEqual(read(), { catStats: true, rounds: 4, autoAdvance: true });
  assert.ok(r.ops.includes(advanceRead));
});

await test('settings: another write between the lookup and the UPDATE: read again, merged again', async () => {
  setStored({ catStats: true });
  const tab = read();
  beforeStatement(/^UPDATE tournaments SET settings = \? WHERE id = \? AND settings = \?$/, () => setStored({ catStats: true, rounds: 9 }));
  const { res, ops } = await saveSettings({ settings: { ...tab, statsOpen: true }, settings_base: JSON.stringify(tab) });
  assert.equal(res.status, 200);
  assert.deepEqual(read(), { catStats: true, rounds: 9, statsOpen: true });
  assert.deepEqual(ops.filter((l) => l.startsWith('d1') || l.startsWith('r2')), [
    'd1 all SELECT * FROM tournaments WHERE admin_secret = ?1 OR admin_secret = ?2',
    'r2 put ' + OPEN,
    'd1 run UPDATE tournaments SET settings = ? WHERE id = ? AND settings = ?',
    'd1 first SELECT settings, rulings FROM tournaments WHERE id = ?1',
    'd1 run UPDATE tournaments SET settings = ? WHERE id = ? AND settings = ?',
    'd1 run UPDATE tournaments SET pub_dirty = 1, pub_dirty_at = COALESCE(pub_dirty_at, ?2) WHERE id = ?1']);
});

await test('settings: a retry that stores another statsOpen moves the open key once more', async () => {
  setStored({ catStats: true, statsOpen: true });
  const tab = read();
  // this tab's catStats toggle; meanwhile another tab turns "No password" off
  beforeStatement(/AND settings = \?$/, () => setStored({ catStats: true }));
  const { res, ops } = await saveSettings({ settings: { ...tab, catStats: false }, settings_base: JSON.stringify(tab) });
  assert.equal(res.status, 200);
  assert.deepEqual(read(), { catStats: false });
  assert.equal(raw(OPEN), null);
  assert.deepEqual(ops.filter((l) => l.startsWith('r2')), ['r2 put ' + OPEN, 'r2 delete ' + OPEN]);
});

await test('settings: three misses in a row answer 409 and leave the open key as stored', async () => {
  setStored({ catStats: true });
  const tab = read();
  let n = 0;
  beforeStatement(/AND settings = \?$/, () => setStored({ catStats: true, rounds: ++n }), 3);
  const { res } = await saveSettings({ settings: { ...tab, statsOpen: true }, settings_base: JSON.stringify(tab) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Another tab saved a change at the same moment. Please try again.');
  assert.deepEqual(read(), { catStats: true, rounds: 3 });
  assert.equal(raw(OPEN), null);
});

await test('rulings, two tabs: each ruling kept; a current copy stores the map as sent', async () => {
  const rulings = () => JSON.parse(row().rulings);
  const k1 = 'r1|q3|Alpha|Beta';
  const k2 = 'r1|q5|Beta|Alpha';
  const tabA = rulings();
  const tabB = rulings();
  const a = { ...tabA, [k1]: { r: 'upheld', note: 'A', at: 100 } };
  let r = await measured(() => call(A, { method: 'POST', json: { rulings: a, rulings_prev: { [k1]: null } } }));
  assert.equal(r.res.status, 200);
  assert.equal(row().rulings, JSON.stringify(a));
  assert.ok(r.ops.includes('d1 run UPDATE tournaments SET rulings = ? WHERE id = ? AND rulings = ?'));
  const b = { ...tabB, [k2]: { r: 'denied', note: 'B', at: 200 } };
  r = await measured(() => call(A, { method: 'POST', json: { rulings: b, rulings_prev: { [k2]: null } } }));
  assert.equal(r.res.status, 200);
  assert.deepEqual(rulings(), { [k1]: a[k1], [k2]: b[k2] });
  // the same ruling from two tabs: the later one
  const c = { ...tabA, [k1]: { r: 'denied', note: 'C', at: 300 } };
  await call(A, { method: 'POST', json: { rulings: c, rulings_prev: { [k1]: null } } });
  assert.deepEqual(rulings(), { [k1]: c[k1], [k2]: b[k2] });
});

/* ---------- the schedule ---------- */

const SCHED = `t/${tid}/schedule.json`;
const sched = (n, name = 'Room 1') => ({ v: 1, rooms: [{ name, bucket: rooms[0].id }, { name: 'Room 2', bucket: rooms[1].id }],
  phases: [{ name: 'Prelims', rounds: Array.from({ length: n }, (_, i) => ({ round: i + 1,
    games: [{ room: 0, a: { team: 'Alpha' }, b: { team: 'Beta' } }], byes: [] })) }], updated: 0 });
const postSched = (s, base) => measured(() => call(A + '/schedule', { method: 'POST', json: s, headers: base === undefined ? {} : { 'X-Qbtd-Base': base } }));
const rawFile = (key, part) => call(`${A}/file?key=${enc(key)}${part ? '&part=' + part : ''}`);

await test('schedule: the raw read names its copy (X-Qbtd-Etag, exposed); the preflight allows X-Qbtd-Base', async () => {
  await postSched(sched(2));
  const res = await rawFile(SCHED);
  assert.equal(res.headers['x-qbtd-etag'], etag(SCHED));
  assert.equal(res.headers['access-control-expose-headers'], 'X-Qbtd-Etag');
  assert.equal(res.text, raw(SCHED));
  const pre = await call(A + '/schedule', { method: 'OPTIONS' });
  assert.equal(pre.headers['access-control-allow-headers'], 'Authorization, Content-Type, X-Qbtd-Base');
  const plain = await call(A, { method: 'GET' });
  assert.equal(plain.headers['access-control-allow-headers'], 'Authorization, Content-Type', 'other responses keep corsHeaders');
  assert.equal(plain.headers['x-qbtd-etag'], undefined);
});

await test('schedule: a matching base saves and answers the new etag', async () => {
  const before = etag(SCHED);
  const { res, ops } = await postSched(sched(3), before);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, brackets: false, etag: etag(SCHED) });
  assert.notEqual(etag(SCHED), before);
  assert.equal(raw(SCHED), JSON.stringify(sched(3)));
  assert.ok(ops.includes(`r2 put ${SCHED} (conditional)`));
});

await test('schedule, two tabs: a stale base is refused with the stored copy, and nothing is written', async () => {
  const stale = etag(SCHED);
  await postSched(sched(4), stale);              // the other tab's save
  const stored = rawObj(SCHED);
  const storedText = raw(SCHED);
  const { res, ops } = await postSched(sched(5, 'Library'), stale);
  assert.equal(res.status, 200);
  assert.equal(res.text, `{"ok":false,"conflict":true,"etag":${JSON.stringify(etag(SCHED))},"schedule":${storedText}}`);
  assert.deepEqual(res.body.schedule, sched(4));
  assert.equal(rawObj(SCHED), stored, 'the stored copy and its time (the public stamp) are untouched');
  assert.deepEqual(ops.filter((l) => l.startsWith('r2') || l.startsWith('d1 run')), [`r2 put ${SCHED} (conditional)`, `r2 get ${SCHED}`]);
  // saving again on the copy it was handed lands
  const again = await postSched(sched(5, 'Library'), res.body.etag);
  assert.equal(again.res.body.ok, true);
});

await test('schedule, two hubs filling the same slots: the same bytes count as saved, with no write', async () => {
  const stale = etag(SCHED);
  await postSched(sched(6), stale);
  const stored = rawObj(SCHED);
  const { res, ops } = await postSched(sched(6), stale);
  assert.deepEqual(res.body, { ok: true, brackets: false, etag: etag(SCHED) });
  assert.equal(rawObj(SCHED), stored);
  assert.deepEqual(writes(ops), []);
  assert.deepEqual(ops.filter((l) => l.startsWith('r2')), [`r2 put ${SCHED} (conditional)`, `r2 get ${SCHED}`]);
});

await test('schedule: deleted in another tab, a save with a base answers conflict with no copy', async () => {
  const stale = etag(SCHED);
  await call(A + '/schedule', { method: 'DELETE' });
  const { res, ops } = await postSched(sched(2), stale);
  assert.equal(res.text, '{"ok":false,"conflict":true,"etag":null,"schedule":null}');
  assert.equal(raw(SCHED), null);
  assert.deepEqual(writes(ops), []);
});

await test('schedule: without a base, unconditional as before, and the answer carries the new etag', async () => {
  const { res, ops } = await postSched(sched(2));
  assert.equal(res.text, JSON.stringify({ ok: true, brackets: false, etag: etag(SCHED) }));
  assert.ok(ops.includes(`r2 put ${SCHED}`));
  const over = await postSched(sched(3));
  assert.equal(over.res.text, JSON.stringify({ ok: true, brackets: false, etag: etag(SCHED) }));
  assert.equal(raw(SCHED), JSON.stringify(sched(3)));
});

await test('room rename: the schedule follows, and the answer names both copies', async () => {
  const was = etag(SCHED);
  const { res } = await measured(() => call(`${A}/buckets/${rooms[0].id}`, { method: 'POST', json: { room_name: 'Hall' } }));
  assert.deepEqual(res.body, { id: rooms[0].id, room_name: 'Hall', sched_was: was, sched_etag: etag(SCHED) });
  assert.equal(JSON.parse(raw(SCHED)).rooms[0].name, 'Hall');
  // a rename the schedule has nothing to follow: no schedule fields
  const same = await call(`${A}/buckets/${rooms[0].id}`, { method: 'POST', json: { room_name: 'Hall' } });
  assert.deepEqual(same.body, { id: rooms[0].id, room_name: 'Hall' });
});

await test('room rename racing a schedule save: the save is kept and renamed too', async () => {
  const put = env.DATA.put;
  let once = true;
  env.DATA.put = async (k, body, opts) => {
    // the hub's save lands between the rename's read and its write
    if (once && k === SCHED && opts && opts.onlyIf) { once = false; await put.call(env.DATA, SCHED, JSON.stringify(sched(7, 'Hall'))); }
    return put.call(env.DATA, k, body, opts);
  };
  try {
    const { res, ops } = await measured(() => call(`${A}/buckets/${rooms[0].id}`, { method: 'POST', json: { room_name: 'Gym' } }));
    assert.equal(res.status, 200);
    const now = JSON.parse(raw(SCHED));
    assert.equal(now.rooms[0].name, 'Gym');
    assert.equal(now.phases[0].rounds.length, 7, 'the save in between is kept');
    assert.equal(res.body.sched_etag, etag(SCHED));
    assert.deepEqual(ops.filter((l) => l.includes('schedule.json')), [`r2 get ${SCHED}`,
      `r2 put ${SCHED}`, // (the other save, landing)
      `r2 put ${SCHED} (conditional)`, `r2 get ${SCHED}`, `r2 put ${SCHED} (conditional)`]);
  } finally { env.DATA.put = put; }
});

/* ---------- the roster ---------- */

const ROSTER = `t/${tid}/roster.qbj`;
const roster = (n) => JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', name: 'Two Tabs',
  registrations: Array.from({ length: n }, (_, i) => ({ name: 'Team ' + i, teams: [{ name: 'Team ' + i, players: [{ name: 'P' + i }] }] })) }] });
const postRoster = (body, base) => measured(() => call(`${A}/roster?name=roster.qbj${base ? '&base=' + enc(base) : ''}`, { method: 'POST', body }));

await test('roster: without a base as before; the raw read names its copy, the Setup download does not', async () => {
  const { res } = await postRoster(roster(2));
  assert.equal(res.text, '{"filename":"roster.qbj"}');
  const r = await rawFile(ROSTER);
  assert.equal(r.headers['x-qbtd-etag'], etag(ROSTER));
  assert.equal(r.headers['access-control-expose-headers'], 'X-Qbtd-Etag');
  const dl = await call(`${A}/file?key=${enc(ROSTER)}&part=roster&dl=roster.qbj`);
  assert.equal(dl.headers['x-qbtd-etag'], undefined);
});

await test('roster: a matching base saves and answers the new etag', async () => {
  const { res, ops } = await postRoster(roster(3), etag(ROSTER));
  assert.deepEqual(res.body, { filename: 'roster.qbj', etag: etag(ROSTER) });
  assert.equal(raw(ROSTER), roster(3));
  assert.ok(ops.includes(`r2 put ${ROSTER} (conditional)`));
});

await test('roster, two editors: the second is refused with one head, and nothing is written', async () => {
  const stale = etag(ROSTER);
  await postRoster(roster(4), stale);
  const stored = rawObj(ROSTER);
  const { res, ops } = await postRoster(roster(5), stale);
  assert.deepEqual(res.body, { ok: false, conflict: true, etag: etag(ROSTER) });
  assert.equal(rawObj(ROSTER), stored);
  assert.deepEqual(ops.filter((l) => l.startsWith('r2') || l.startsWith('d1 run')), [`r2 put ${ROSTER} (conditional)`, `r2 head ${ROSTER}`]);
  // saving anyway, on the etag it was handed
  const again = await postRoster(roster(5), res.body.etag);
  assert.equal(again.res.body.etag, etag(ROSTER));
  assert.equal(raw(ROSTER), roster(5));
});

console.log(`${passed} save checks passed` + (failed ? `, ${failed} FAILED` : ''));
if (failed) process.exitCode = 1;
