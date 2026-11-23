// e2e_live.js — live rooms end to end (worker.js "live rooms",
// buzzer/worker.js LiveRoom) against two local dev Workers:
//   (cd buzzer && npx wrangler dev --local --port 8889 --var LIVE_DAILY_CAP:6)
//   (cd worker && npx wrangler dev --local --port 8887 --test-scheduled)
//   QBTD_BASE=http://127.0.0.1:8887 QBTD_BUZZ=ws://127.0.0.1:8889 node tests/e2e_live.js
// Both read BUZZER_SECRET from their .dev.vars (the same value). Checks:
// each role gets its token where it should and nowhere else, the hub
// hears uploads, starts and the TD's own changes, scores reach the hub
// and the public page and end with the game, a bad or borrowed token is
// refused, and viewers past the day's cap are turned away.
import { call, tick, ok, summary, d1exec } from './e2e_lib.js';

const BUZZ = process.env.QBTD_BUZZ || 'ws://127.0.0.1:8889';
const CAP = 6; // the buzzer dev Worker's LIVE_DAILY_CAP for this run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a socket that records what it hears; .ready resolves on open (or rejects)
function join(slug, token) {
  const ws = new WebSocket(`${BUZZ}/t/${slug}/live?token=${encodeURIComponent(token)}`);
  const got = [];
  ws.onmessage = (e) => { if (e.data !== 'hb') got.push(JSON.parse(e.data)); };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('refused')); ws.onclose = () => rej(new Error('closed')); });
  return { ws, got, ready, wait: async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = got.find(pred); if (m) return m; await sleep(25); }
    return null;
  } };
}

d1exec("UPDATE tournaments SET creator_ip = 'earlier-run'");
const slug = 'e2elive-' + Math.random().toString(36).slice(2, 8);
let r = await call('/api/tournaments', { method: 'POST', json: { name: 'E2E Live', slug } });
ok('TD creates the tournament', r.status === 200, r.body);
const A = '/a/' + r.body.admin_secret;
const rooms = [];
for (let k = 0; k < 2; k++) {
  r = await call(A + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (k + 1) } });
  rooms.push({ id: r.body.id, secret: r.body.secret });
}
await call(A + '/start', { method: 'POST' });
await call(A, { method: 'POST', json: { published: true } });

r = await call(A);
const td = r.body.tournament.rt;
ok('the hub detail carries a TD token with the slug', td && td.token && td.slug === slug, td);
r = await call('/b/' + rooms[0].secret);
const sc = r.body.rt;
ok('a room state carries a scorer token', sc && sc.token && sc.slug === slug, sc);
r = await call('/b/' + rooms[0].secret + '?test=1');
await tick();
r = await call('/pub/' + slug);
const vw = r.body.rt;
ok('the public state carries a viewer token', vw && vw.token, vw);
ok('the public state carries no other role\'s token', vw && vw.token !== td.token && vw.token !== sc.token);

const hub = join(slug, td.token);
const viewer = join(slug, vw.token);
await Promise.all([hub.ready, viewer.ready]);
ok('the hub and a viewer join and get a hello', !!(await hub.wait((m) => m.t === 'hello')) && !!(await viewer.wait((m) => m.t === 'hello')));

const scorer = join(slug, sc.token);
await scorer.ready;
scorer.ws.send(JSON.stringify({ t: 'score', round: 1, a: 'Alpha', b: 'Beta', sa: 30, sb: 10, tu: 3, of: 20 }));
const seen = await viewer.wait((m) => m.t === 'score');
ok('a score reaches the viewer, with its room', seen && seen.room === rooms[0].id && seen.sa === 30 && seen.sb === 10 && seen.tu === 3, seen);
ok('and the hub', !!(await hub.wait((m) => m.t === 'score')));
scorer.ws.send(JSON.stringify({ t: 'score', round: 1, a: 'Alpha', b: 'Beta', sa: 30, sb: 10, question: 'never sent on' }));
const extra = await viewer.wait((m) => m.t === 'score' && 'question' in m, 600);
ok('the room passes on only teams and points', !extra);
// the live scoresheet: rows by team, checked field by field
viewer.got.length = 0;
const sh = [[1, 15, null, '101', null, 35, 0], [2, -5, 10, null, '000', 30, 10]];
scorer.ws.send(JSON.stringify({ t: 'score', round: 1, a: 'Alpha', b: 'Beta', sa: 30, sb: 10, tu: 3, of: 20, sh }));
const withSheet = await viewer.wait((m) => m.t === 'score' && m.sh);
ok('a score carries the questions finished, by team', withSheet && JSON.stringify(withSheet.sh) === JSON.stringify(sh), withSheet);
viewer.got.length = 0;
scorer.ws.send(JSON.stringify({ t: 'score', round: 1, a: 'Alpha', b: 'Beta', sa: 30, sb: 10, tu: 3, of: 20, sh: [[1, 15, null, '101', null, 35, 0, 'Jane Player']] }));
const badSheet = await viewer.wait((m) => m.t === 'score');
ok('a sheet with anything more on a row is dropped, the score still goes', badSheet && !badSheet.sh, badSheet);
scorer.ws.send(JSON.stringify({ t: 'score', round: 1, a: 'Alpha', b: 'Beta', sa: 30, sb: 10, tu: 3, of: 20, sh }));
await viewer.wait((m) => m.t === 'score' && m.sh);

const late = join(slug, vw.token);
await late.ready;
const hello = await late.wait((m) => m.t === 'hello');
ok('a viewer joining later gets the running score in its hello', hello && hello.scores.length === 1 && hello.scores[0].room === rooms[0].id, hello);
ok('and the sheet so far', hello && JSON.stringify(hello.scores[0].sh) === JSON.stringify(sh), hello);
ok('viewers never get the hub\'s notices', !viewer.got.some((m) => m.t === 'rev'));

hub.got.length = 0;
r = await call('/b/' + rooms[1].secret + '/start?round=1', { method: 'POST' });
const startRev = await hub.wait((m) => m.t === 'rev' && m.room === rooms[1].id);
ok('a room starting a round tells the hub', !!startRev, hub.got);
hub.got.length = 0;
r = await call('/b/' + rooms[1].secret + '/start?round=1', { method: 'POST' });
ok('a start already counted tells it nothing', !(await hub.wait((m) => m.t === 'rev', 800)));
r = await call(A + '/buckets/' + rooms[1].id, { method: 'POST', json: { room_name: 'Room Two' } });
ok('a TD change tells the hub', r.status === 200 && !!(await hub.wait((m) => m.t === 'rev')));
hub.got.length = 0;
r = await call(A);
ok('a TD read tells it nothing', !(await hub.wait((m) => m.t === 'rev', 800)));

// an upload the Worker can't read still moves the hub, but leaves the score running
viewer.got.length = 0;
r = await call(`/b/${rooms[0].secret}/upload?round=1&name=junk.qbj`, { method: 'POST', body: 'not a game' });
ok('an upload tells the hub', !!(await hub.wait((m) => m.t === 'rev' && m.room === rooms[0].id)), r.body);
ok('an unreadable upload leaves the live score running', !(await viewer.wait((m) => m.t === 'end', 800)));
scorer.ws.send(JSON.stringify({ t: 'done', round: 1 }));
const end = await viewer.wait((m) => m.t === 'end');
ok('the reader\'s done ends the room\'s live score', end && end.room === rooms[0].id && end.round === 1, end);
const after = join(slug, vw.token);
await after.ready;
const h2 = await after.wait((m) => m.t === 'hello');
ok('and a viewer joining after sees none', h2 && h2.scores.length === 0, h2);

// refusals
const bad = join(slug, vw.token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
ok('a forged token is refused', await bad.ready.then(() => false, () => true));
const other = join('e2elive-other', vw.token);
ok('a token for another tournament is refused', await other.ready.then(() => false, () => true));
const asBuzzer = new WebSocket(`${BUZZ}/t/${slug}/r/${rooms[0].id}/ws?token=${encodeURIComponent(td.token)}`);
ok('a live token opens no buzzer room', await new Promise((res) => { asBuzzer.onopen = () => res(false); asBuzzer.onerror = asBuzzer.onclose = () => res(true); }));

// the day's cap: this run's viewers so far are viewer, late and after
let refused = 0; let n = 3;
const extras = [];
for (let i = 0; i < CAP; i++) {
  const v = join(slug, vw.token);
  extras.push(v);
  if (await v.ready.then(() => false, () => true)) refused++; else n++;
}
ok(`viewers past the day's cap of ${CAP} are refused`, n === CAP && refused === 3, { n, refused });
const hub2 = join(slug, td.token);
ok('the hub still joins past the cap', await hub2.ready.then(() => true, () => false));

for (const s of [hub, viewer, scorer, late, after, hub2, ...extras]) { try { s.ws.close(); } catch (e) { /* */ } }
summary('e2e_live');
process.exit(0);
