// buzzer/worker.js — buzzer rooms for qb-td (Cloudflare Worker + one
// Durable Object per tournament room). Built like buzzin.live: buzzers are
// open until someone buzzes, the first buzz locks them, and the reader's
// Clear reopens them for everyone. MODAQ keeps the game; this keeps nothing.
//
// Cost shape (README "Potential: buzzer rooms"): the room stores nothing
// and sets no alarm, so it writes no rows. Who holds the buzz lives in
// memory and on the sockets' attachments, which survive hibernation for
// free. Billing is connections plus inbound frames at 20:1, so lag probes
// go out at most once every three minutes per phone, not on each clear.
//
//   GET /t/:slug/r/:room/ws?token=&name=&team=
//
// Who may join is the qb-td Worker's call: it checks a player's buzzer
// password (or a moderator's room link) and signs a join token
// (token.js); this Worker only checks the signature, so it keeps no
// database and never calls back. A moderator's token is what allows Clear.
// :room is the room's id in qb-td (its bucket id).
//
// Rooms close with the tournament: each token carries when the links
// close, a room sets one alarm for that moment (a single row written per
// room, not per message) and hangs up on everyone when it rings; after
// that no token opens it.
//
// Frames (JSON text):
//   player -> room : {t:'buzz'}  {t:'pong', n}
//   reader -> room : {t:'clear'}
//   any -> Cloudflare : 'hb' (plain text), answered 'hb' without waking the
//                       room: a page that hears nothing back joins again
//   room -> all    : {t:'hello', id, you, players, buzz, list}   on joining
//                         (id: the start of the room's object id, to find
//                         it in Cloudflare's per-room figures)
//                    {t:'players', players}            someone came or went
//                    {t:'pending', name, team}    a buzz arrived: stop reading (sound).
//                         Whose press it was, so a page can tell the teams apart at
//                         once; who has it is still the buzz frame's to say
//                    {t:'buzz', name, team, rtt, list}   who has it (lag-equalized;
//                         rtt: that player's round trip in ms, as in players)
//                         and, as buzzin.live shows, everyone who has buzzed
//                         since the last Clear, in order: the first window's
//                         buzzes by press time, later ones as they arrive
//                    {t:'clear'}
//                    {t:'over'}   the tournament's links closed; the room hangs up
//   room -> one    : {t:'elsewhere'}  this player joined again; step aside
//                    {t:'rejoin'}     no heartbeat for a while; join again
//                         (the page hangs up, never the room: see retire())
//   room -> player : {t:'ping', n}
//
// Lag equalization is qb-scorekeeper's (rooms/worker.js): the first buzz
// opens a window as long as the slowest phone's round trip (capped), each
// buzz inside it is backdated by half its phone's round trip (capped), and
// the earliest wins. From Klaxon: the lowest round trip seen is the one
// used, so a phone can't earn credit by answering probes slowly now and
// then, and a few ms of slack absorb jitter on the buzz itself.

import { checkToken, signToken, PLAYER_TOKEN_MS, checkLiveToken, liveRoomName } from './token.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const MAX_COMP_MS = 100;    // most a buzz is backdated
const SLACK_MS = 0;         // set by the lag variants on the mock (0 or 40)
const MAX_WINDOW_MS = 200;  // longest wait before the winner is named
const PING_EVERY_MS = 180000;
const RTT_SAMPLES = 8;
const MAX_SOCKETS = 60;
const MAX_LIST = 8;         // buzzes kept in order after the first

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // This machine only, for the mockups (.dev.vars sets DEV_ISSUER, and the
    // address must be local, so a deployed Worker can never hand out tokens):
    // stands in for the qb-td Worker's token routes.
    //   GET /dev/token?slug=&role=player|reader&rooms=1,2&pw=
    if (env.DEV_ISSUER === '1' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/dev/token') {
      const q = url.searchParams;
      const role = q.get('role') === 'reader' ? 'reader' : 'player';
      if (role === 'player' && q.get('pw') !== env.DEV_PASSWORD) return new Response('wrong password', { status: 403, headers: CORS });
      const closes = Number(q.get('closes')) || Date.now() + 72 * 3600 * 1000;
      const token = await signToken(env.BUZZER_SECRET, {
        slug: q.get('slug') || 'demo', role, rooms: (q.get('rooms') || '').split(',').filter(Boolean).map(Number),
        expires: role === 'reader' ? closes : Math.min(closes, Date.now() + PLAYER_TOKEN_MS), closes, region: q.get('region') || undefined,
      });
      return Response.json({ token }, { headers: CORS });
    }
    const lv = url.pathname.match(/^\/t\/([\w-]{1,60})\/live$/);
    if (lv) return liveJoin(request, env, lv[1], url);
    const m = url.pathname.match(/^\/t\/([\w-]{1,60})\/r\/(\d{1,6})\/ws$/);
    if (!m) return new Response('qb-td buzzer', { headers: CORS });
    const who = await checkToken(env.BUZZER_SECRET, url.searchParams.get('token'), { slug: m[1], room: Number(m[2]) });
    if (who.error) return new Response(who.error, { status: who.error === 'not configured' ? 500 : 403, headers: CORS });
    // A room lives where Cloudflare first creates it, for good, and without
    // a hint that is wherever its first visitor's connection happened to
    // enter (measured 11/16: a room that landed in London answered Chicago
    // in 100 ms, one in Chicago in 14). So the room is asked for in the
    // tournament's region: the TD's choice, signed into the token (eastern
    // North America unless they chose another). A hint only counts when a
    // room is first made, so another region is another room ('@weur');
    // 'v2:' made rooms from before the hint start over in the right place.
    const at = who.region === 'enam' ? '' : '@' + who.region;
    const stub = env.ROOMS.get(env.ROOMS.idFromName('v2:' + m[1] + '/' + m[2] + at), { locationHint: who.region });
    // the room trusts these headers: only this Worker can reach it
    const headers = new Headers(request.headers);
    headers.set('x-buzz-role', who.role);
    headers.set('x-buzz-closes', String(who.closes));
    headers.set('x-buzz-room', m[1] + '/' + m[2]);
    return stub.fetch(new Request(request, { headers }));
  },
};

const STALE_MS = 90000; // heartbeats come every 5 s; a background tab may slow to one a minute

export class BuzzRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = null;     // buzzes inside the open window
    this.buzz = undefined;   // [{name, team}, ...] in order | null; recovered from attachments
    this.closes = undefined; // when the alarm is set for; read back once after a wake
    // Heartbeat: Cloudflare answers a page's 'hb' with 'hb' itself, without
    // waking the room and at no charge. A page that gets no answer knows its
    // connection is dead and joins again.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('hb', 'hb'));
  }

  // The room's own log: rare events only (a replaced or silent connection,
  // an error), by name and count. Never a token, a player or a team.
  log(ev, more = {}) { console.log(JSON.stringify({ ev, room: this.room || null, ...more })); }

  att(ws) { return ws.deserializeAttachment() || {}; }

  // A socket's attachment may hold 2,048 bytes. The held buzz list is the
  // only part that grows (eight long names), so its copy here is cut from
  // the end until it fits; the list in memory, and what players see, is whole.
  // After a sleep the room reads back the longest copy it finds.
  save(ws, a) {
    let bz = a.bz || null;
    for (;;) {
      try { ws.serializeAttachment(bz === a.bz ? a : { ...a, bz }); return; } catch (e) {
        if (!bz || !bz.length) return; // closing, or nothing left to cut
        bz = bz.slice(0, -1);
      }
    }
  }

  held() {
    if (this.buzz === undefined) {
      this.buzz = null;
      for (const ws of this.ctx.getWebSockets()) {
        const a = this.att(ws);
        if (a.bz && (!this.buzz || a.bz.length > this.buzz.length)) this.buzz = a.bz;
      }
    }
    return this.buzz;
  }

  hold(bz) {
    this.buzz = bz;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      a.bz = bz;
      this.save(ws, a);
    }
  }

  players(except = null) {
    return this.open('player').filter((ws) => ws !== except).map((ws) => {
      const a = this.att(ws);
      return { name: a.name, team: a.team, rtt: a.rtt ?? null };
    });
  }

  // sockets still open: one the room has closed stays in Cloudflare's list
  // until the other end answers, and must not count as a player
  open(tag) { return (tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets()).filter((ws) => ws.readyState === 1 && !this.att(ws).gone); }
  // Take a connection out of the room without hanging up on it. If its
  // page is still there, the frame tells it what to do and the page hangs
  // up itself; if the connection is dead, Cloudflare drops it in its own
  // time.
  retire(ws, why, code) {
    const a = this.att(ws);
    a.gone = 1;
    this.save(ws, a);
    this.send(ws, { t: why });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* closing */ } }
  all(obj, except = null) {
    const msg = JSON.stringify(obj);
    for (const ws of this.open()) if (ws !== except) { try { ws.send(msg); } catch (e) { /* closing */ } }
  }

  ping(ws, force = false) {
    const a = this.att(ws);
    const now = Date.now();
    if (!force && now - (a.pingAt || 0) < PING_EVERY_MS) return;
    a.pingN = (a.pingN || 0) + 1;
    a.pingAt = now;
    this.save(ws, a);
    this.send(ws, { t: 'ping', n: a.pingN });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.open().length >= MAX_SOCKETS) return new Response('room full', { status: 503 });
    const q = new URL(request.url).searchParams;
    this.room = request.headers.get('x-buzz-room') || this.room;
    return this.join(request, q);
  }

  async join(request, q) {
    const role = request.headers.get('x-buzz-role') === 'reader' ? 'reader' : 'player';
    await this.closeAt(Number(request.headers.get('x-buzz-closes')));
    const name = (q.get('name') || '').slice(0, 60);
    const team = (q.get('team') || '').slice(0, 60);
    if (role === 'player' && !name) return new Response('name needed', { status: 400 });
    // the same player again (a reload, a second tab): the newer one stays
    if (role === 'player') {
      for (const ws of this.open('player')) {
        const a = this.att(ws);
        if (a.name === name && a.team === team) {
          this.log('replace', { age: Date.now() - (a.at || 0), state: ws.readyState });
          this.retire(ws, 'elsewhere', 4000);
        }
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    const bz = this.held();
    this.save(server, { role, name, team, bz, at: Date.now(), room: this.room });
    this.send(server, { t: 'hello', id: this.ctx.id.toString().slice(0, 8), you: { role, name, team }, players: this.players(), buzz: bz ? bz[0] : null, list: bz || [] });
    if (role === 'player') {
      this.all({ t: 'players', players: this.players() }, server);
      this.ping(server, true);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // One alarm for the moment the tournament's links close. Set when the
  // first socket arrives and moved only if the TD's close time moved, so a
  // room writes a row once, not per message.
  async closeAt(closes) {
    if (!closes) return;
    if (this.closes === undefined) this.closes = (await this.ctx.storage.getAlarm()) ?? null;
    if (this.closes === closes) return;
    this.closes = closes;
    await this.ctx.storage.setAlarm(closes);
  }

  alarm() {
    this.closes = null;
    this.pending = null;
    this.buzz = null;
    // said in a frame as well as the close code: a client that is slow to
    // finish the close handshake still knows not to come back
    this.all({ t: 'over' });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4001, 'tournament closed'); } catch (e) { /* gone */ }
    }
  }

  resolve() {
    const cands = this.pending || [];
    this.pending = null;
    if (!cands.length) return;
    cands.sort((a, b) => a.adj - b.adj);
    const list = [];
    for (const c of cands) {
      if (list.length < MAX_LIST && !list.some((x) => x.name === c.name && x.team === c.team)) list.push({ name: c.name, team: c.team, rtt: c.rtt });
    }
    this.hold(list);
    this.all({ t: 'buzz', ...list[0], list });
  }

  window() {
    let w = 0;
    for (const ws of this.open('player')) {
      const r = this.att(ws).rtt;
      if (r != null) w = Math.max(w, Math.min(r, MAX_WINDOW_MS));
    }
    return w;
  }

  // A connection can die without Cloudflare telling the room. Every page
  // sends a heartbeat every few seconds, so one that has been silent this
  // long is gone: hang up on it and take it off the list.
  sweep(except = null) {
    const now = Date.now();
    let gone = 0;
    for (const ws of this.open()) {
      if (ws === except) continue;
      const beat = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = beat ? beat.getTime() : (this.att(ws).at || now);
      if (now - last < STALE_MS) continue;
      this.retire(ws, 'rejoin', 4002);
      gone++;
    }
    if (gone) { this.log('sweep', { gone }); this.all({ t: 'players', players: this.players() }); }
  }

  webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const a = this.att(ws);
    const now = Date.now();
    this.room = this.room || a.room;
    if (a.gone) return;
    this.sweep(ws);

    if (a.role === 'reader') {
      if (msg.t !== 'clear') return;
      this.pending = null;
      this.hold(null);
      this.all({ t: 'clear' });
      for (const p of this.open('player')) this.ping(p);
      return;
    }

    if (msg.t === 'pong') {
      if (msg.n !== a.pingN || !a.pingAt) return;
      const rtt = now - a.pingAt;
      a.rtts = [...(a.rtts || []), rtt].slice(-RTT_SAMPLES);
      a.rtt = Math.min(...a.rtts);
      a.pingN = 0;
      this.save(ws, a);
      // a new arrival's first figure: the list sent when it joined had none
      if (a.rtts.length === 1) this.all({ t: 'players', players: this.players() });
      return;
    }
    if (msg.t !== 'buzz') return;
    const adj = now - Math.min((a.rtt ?? 0) / 2 + SLACK_MS, MAX_COMP_MS);
    const rtt = a.rtt ?? null;
    if (this.pending) { this.pending.push({ name: a.name, team: a.team, rtt, adj }); return; }
    const list = this.held();
    if (list) {
      // locked: the buzz still joins the order shown under the buzzer
      if (list.length >= MAX_LIST || list.some((x) => x.name === a.name && x.team === a.team)) return;
      const next = [...list, { name: a.name, team: a.team, rtt }];
      this.hold(next);
      this.all({ t: 'buzz', ...next[0], list: next });
      return;
    }
    // No await between the check and the lock: one buzz opens the window.
    this.pending = [{ name: a.name, team: a.team, rtt, adj }];
    this.all({ t: 'pending', name: a.name, team: a.team });
    const w = this.window();
    if (w) setTimeout(() => this.resolve(), w); else this.resolve();
  }

  webSocketClose(ws, code, reason, wasClean) {
    const a = this.att(ws);
    this.room = this.room || a.room;
    // finish the close handshake: without the reply the other end waits,
    // then gives up and reports a broken connection
    if (code !== undefined) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason || ''); } catch (e) { /* already closed */ } }
    if (a.role === 'player' && !a.gone) this.all({ t: 'players', players: this.players(ws) }, ws);
  }
  webSocketError(ws, err) {
    const a = this.att(ws);
    this.room = this.room || a.room;
    this.log('error', { msg: String(err && err.message || err), role: a.role });
    this.webSocketClose(ws);
  }
}

// ------------------------------------------------------------ live rooms
// One room per tournament that keeps qb-td's public page and Live Hub up
// to date, and carries each room's running score while a game is played
// (README "Live pages"). Simulated at size before it was built
// (qbtd-soak/livesim_1122): 628 sockets in one room, under 1 GB-s an hour.
//
//   GET /t/:slug/live?token=     (a live token: buzzer/token.js signLiveToken)
//
// Sockets, by tag: 'v' viewers, 't' the TD's hub, 's' a room's scorer
// (its reader page, one game at a time).
//   scorer -> room : {t:'score', round, a, b, sa, sb, tu, of, sh?}   at each new question and
//                    each tossup or bonus part marked; sh: the questions so far, by team
//                    (app/engine/scoresheet.js liveRows)
//                    {t:'done', round}                          the game was uploaded
//   any -> Cloudflare : 'hb' -> 'hb' (auto-response: never wakes the room)
//   room -> v, t   : {t:'hello', scores}   on joining: [{room, round, a, b, sa, sb, tu, of}]
//                    {t:'score', room, ...}   {t:'end', room, round}
//                    {t:'pub'}   a qb-td-live deploy carrying this tournament went out
//   room -> t      : {t:'rev', room?, round?}   something the hub shows moved
//   room -> all    : {t:'over'}   the tournament's links closed
//   qb-td Worker -> room (its LIVEROOM binding, never the public URL):
//                    POST {k:'pub'} | {k:'rev', room?, round?}
//
// Scores are only ever teams and points: no question text, players or
// categories, ever. The latest score of each room lives on its scorer's
// socket attachment (free, and kept through hibernation); a long game's
// sheet that won't fit the attachment's 2 KB is kept in memory instead,
// and comes back with the next question if the room slept. A scorer whose
// connection drops sends it all again on rejoining. The room writes no rows and, like the
// buzzer rooms, never hangs up on a socket itself: closing on a dead peer
// is what kept buzzer rooms awake (billed) for minutes (11/16).
//
// Viewer joins are capped per tournament per UTC day (LIVE_DAILY_CAP,
// default 20,000): past it a viewer is refused with 503, and the page
// reads the free static file on a timer instead. The count lives in memory
// and is saved every 50 joins, so a room that slept forgets at most that many.

const LIVE_ROLE_TAG = { viewer: 'v', td: 't', scorer: 's' };
const LIVE_CAP = 20000;
const LIVE_SAVE_EVERY = 50;

async function liveJoin(request, env, slug, url) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426, headers: CORS });
  const who = await checkLiveToken(env.BUZZER_SECRET, url.searchParams.get('token'), { slug });
  if (who.error) return new Response(who.error, { status: who.error === 'not configured' ? 500 : 403, headers: CORS });
  const stub = env.LIVE.get(env.LIVE.idFromName(liveRoomName(slug, who.region)), { locationHint: who.region });
  // fresh headers: nothing the visitor sent reaches the room but the upgrade
  const headers = new Headers({ Upgrade: 'websocket' });
  for (const h of ['Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Extensions']) { const v = request.headers.get(h); if (v) headers.set(h, v); }
  headers.set('x-live-role', who.role);
  headers.set('x-live-closes', String(who.closes));
  if (who.role === 'scorer') headers.set('x-live-room', String(who.room));
  return stub.fetch(new Request('https://live/join', { headers }));
}

const int = (v, lo, hi) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
// A live sheet as scoresheet.js liveRows makes it, checked field by field
// (anything else is dropped): [n, a, b, bonusA, bonusB, scoreA, scoreB].
function liveRowsOf(sh) {
  if (!Array.isArray(sh) || sh.length > 60) return null;
  const pts = (v) => (v === null ? null : int(v, -999, 999));
  const bon = (v) => (typeof v === 'string' && /^[01?]{1,6}$/.test(v) ? v : null);
  const out = [];
  for (const r of sh) {
    if (!Array.isArray(r) || r.length !== 7) return null;
    const n = int(r[0], 1, 999); const sa = int(r[5], -9999, 99999); const sb = int(r[6], -9999, 99999);
    if (!n || sa === null || sb === null) return null;
    out.push([n, pts(r[1]), pts(r[2]), bon(r[3]), bon(r[4]), sa, sb]);
  }
  return out;
}
const name60 = (v) => (typeof v === 'string' ? v.slice(0, 60) : '');

export class LiveRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sheets = new Map(); // room -> sh too big for its attachment
    this.closes = undefined;
    this.day = null;      // UTC day the join count is for
    this.joins = null;    // viewer joins that day
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('hb', 'hb'));
  }

  att(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  open(tag) { return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* closing */ } }
  fan(obj, tags = ['v', 't']) {
    const msg = JSON.stringify(obj);
    for (const tag of tags) for (const ws of this.open(tag)) { try { ws.send(msg); } catch (e) { /* closing */ } }
  }
  scores() {
    const out = [];
    for (const ws of this.open('s')) {
      const a = this.att(ws);
      if (!a.score) continue;
      const sh = a.score.sh || (this.sheets.get(a.room) || {})[a.score.round];
      out.push({ room: a.room, ...a.score, ...(sh ? { sh } : {}) });
    }
    return out;
  }

  // the day's viewer joins, read back once after a sleep
  async countJoin() {
    const cap = Number(this.env.LIVE_DAILY_CAP) || LIVE_CAP;
    const day = new Date().toISOString().slice(0, 10);
    if (this.day !== day) {
      const saved = await this.ctx.storage.get('joins');
      this.day = day;
      this.joins = saved && saved.day === day ? saved.n : 0;
    }
    if (this.joins >= cap) return false;
    this.joins++;
    if (this.joins % LIVE_SAVE_EVERY === 0) await this.ctx.storage.put('joins', { day, n: this.joins });
    return true;
  }

  async closeAt(closes) {
    if (!closes) return;
    if (this.closes === undefined) this.closes = (await this.ctx.storage.getAlarm()) ?? null;
    if (this.closes === closes) return;
    this.closes = closes;
    await this.ctx.storage.setAlarm(closes);
  }

  alarm() {
    this.closes = null;
    this.fan({ t: 'over' }, ['v', 't', 's']);
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, 'tournament closed'); } catch (e) { /* gone */ } }
  }

  async fetch(request) {
    // the qb-td Worker's notices (its LIVEROOM binding; the public route
    // above never sends a body or this path)
    if (new URL(request.url).pathname === '/notify') {
      const b = await request.json().catch(() => ({}));
      if (b.k === 'pub') this.fan({ t: 'pub' });
      else if (b.k === 'rev') {
        const room = int(b.room, 0, 1e9); const round = int(b.round, 0, 999);
        // an upload ends that room's live score: the result is in the stats now
        if (b.upload && room) this.endScore(room, round);
        this.fan({ t: 'rev', ...(room ? { room } : {}), ...(round ? { round } : {}) }, ['t']);
      }
      return new Response(null, { status: 204 });
    }
    const role = request.headers.get('x-live-role');
    const tag = LIVE_ROLE_TAG[role];
    if (!tag) return new Response('bad role', { status: 400 });
    if (tag === 'v' && !(await this.countJoin())) return new Response('busy', { status: 503 });
    await this.closeAt(Number(request.headers.get('x-live-closes')));
    const room = tag === 's' ? int(request.headers.get('x-live-room'), 1, 1e9) : null;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ role: tag, room, at: Date.now() });
    if (tag !== 's') this.send(server, { t: 'hello', scores: this.scores() });
    return new Response(null, { status: 101, webSocket: client });
  }

  endScore(room, round) {
    for (const ws of this.open('s')) {
      const a = this.att(ws);
      if (a.room === room && a.score && (!round || a.score.round === round)) { delete a.score; try { ws.serializeAttachment(a); } catch (e) { /* closing */ } }
    }
    this.sheets.delete(room);
    this.fan({ t: 'end', room, ...(round ? { round } : {}) });
  }

  webSocketMessage(ws, raw) {
    const a = this.att(ws);
    if (a.role !== 's' || typeof raw !== 'string' || raw.length > 8000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'done') { this.endScore(a.room, int(m.round, 1, 999)); return; }
    if (m.t !== 'score') return;
    const score = { round: int(m.round, 1, 999), a: name60(m.a), b: name60(m.b), sa: int(m.sa, -9999, 99999), sb: int(m.sb, -9999, 99999), tu: int(m.tu, 0, 999), of: int(m.of, 0, 999) };
    if (!score.round || score.sa === null || score.sb === null) return;
    const sh = liveRowsOf(m.sh);
    a.score = sh ? { ...score, sh } : score;
    this.sheets.delete(a.room);
    try { ws.serializeAttachment(a); } catch (e) {
      // too big with the sheet: the sheet waits in memory
      a.score = score;
      try { ws.serializeAttachment(a); } catch (e2) { return; }
      if (sh) this.sheets.set(a.room, { [score.round]: sh });
    }
    this.fan({ t: 'score', room: a.room, ...score, ...(sh ? { sh } : {}) });
  }

  webSocketClose(ws, code, reason) {
    // finish the close handshake (see BuzzRoom.webSocketClose)
    if (code !== undefined) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason || ''); } catch (e) { /* closed */ } }
  }
  webSocketError(ws) { this.webSocketClose(ws); }
}
