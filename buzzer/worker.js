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
//                    {t:'pending'}    a buzz arrived: stop reading (sound)
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

import { checkToken, signToken, PLAYER_TOKEN_MS } from './token.js';

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
    this.all({ t: 'pending' });
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
