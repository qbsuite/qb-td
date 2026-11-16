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
//   room -> all    : {t:'hello', you, players, buzz}   on joining
//                    {t:'players', players}            someone came or went
//                    {t:'pending'}    a buzz arrived: stop reading (sound)
//                    {t:'buzz', name, team, list}   who has it (lag-equalized)
//                         and, as buzzin.live shows, everyone who has buzzed
//                         since the last Clear, in order: the first window's
//                         buzzes by press time, later ones as they arrive
//                    {t:'clear'}
//                    {t:'over'}   the tournament's links closed; the room hangs up
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
    // Local trials only (.dev.vars sets DEV_ISSUER; production never does):
    // stands in for the qb-td Worker's token routes.
    //   GET /dev/token?slug=&role=player|reader&rooms=1,2&pw=
    if (env.DEV_ISSUER === '1' && url.pathname === '/dev/token') {
      const q = url.searchParams;
      const role = q.get('role') === 'reader' ? 'reader' : 'player';
      if (role === 'player' && q.get('pw') !== env.DEV_PASSWORD) return new Response('wrong password', { status: 403, headers: CORS });
      const closes = Number(q.get('closes')) || Date.now() + 72 * 3600 * 1000;
      const token = await signToken(env.BUZZER_SECRET, {
        slug: q.get('slug') || 'demo', role, rooms: (q.get('rooms') || '').split(',').filter(Boolean).map(Number),
        expires: role === 'reader' ? closes : Math.min(closes, Date.now() + PLAYER_TOKEN_MS), closes,
      });
      return Response.json({ token }, { headers: CORS });
    }
    // Phone trial (11/16), only while the TRIAL_CODE secret exists: a bare
    // page that joins room 1 of qbtd-sim-phone as "Phone".
    if (env.TRIAL_CODE && url.pathname === '/trial/' + env.TRIAL_CODE) {
      const closes = Date.now() + 6 * 3600 * 1000;
      const token = await signToken(env.BUZZER_SECRET, { slug: 'qbtd-sim-phone', role: 'player', rooms: [1, 2], expires: closes, closes });
      return new Response(TRIAL_PAGE.replace('__TOKEN__', token), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const m = url.pathname.match(/^\/t\/([\w-]{1,60})\/r\/(\d{1,6})\/ws$/);
    if (!m) return new Response('qb-td buzzer', { headers: CORS });
    const who = await checkToken(env.BUZZER_SECRET, url.searchParams.get('token'), { slug: m[1], room: Number(m[2]) });
    if (who.error) return new Response(who.error, { status: who.error === 'not configured' ? 500 : 403, headers: CORS });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1] + '/' + m[2]));
    // the room trusts these headers: only this Worker can reach it
    const headers = new Headers(request.headers);
    headers.set('x-buzz-role', who.role);
    headers.set('x-buzz-closes', String(who.closes));
    headers.set('x-buzz-room', m[1] + '/' + m[2]);
    return stub.fetch(new Request(request, { headers }));
  },
};

const TRIAL_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buzzer trial</title>
<style>body{font:17px system-ui;margin:16px;background:#fff;color:#111}#s{font-weight:700;font-size:22px}
button{font:inherit;font-size:22px;padding:18px;width:100%;margin:12px 0;border-radius:12px;border:0;background:#e8730c;color:#fff}
#l{font:13px ui-monospace,monospace;white-space:pre-wrap;color:#333}</style>
<div id="s">Connecting</div><button id="r" hidden>Rejoin now</button><div id="l"></div>
<script>
// Joins room 1 as "Phone". When that socket dies it does not come back by
// itself: it joins room 2 under a name that says when it died, and rejoins
// room 1 when room 2 is cleared (or on the button).
const token='__TOKEN__', s=document.getElementById('s'), l=document.getElementById('l'), rb=document.getElementById('r'); let n=0, sig=null;
const log=(t)=>{l.textContent=new Date().toLocaleTimeString()+'  '+t+'\\n'+l.textContent};
const sock=(room,name)=>new WebSocket('wss://'+location.host+'/t/qbtd-sim-phone/r/'+room+'/ws?token='+token+'&name='+encodeURIComponent(name)+'&team=Trial');
function main(){ n++; const w=sock(1,'Phone'); rb.hidden=true;
  w.onopen=()=>{s.textContent='Connected';log('connected to room 1 (#'+n+')')};
  w.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.t==='ping')w.send(JSON.stringify({t:'pong',n:m.n})); else if(m.t==='clear')log('clear');};
  w.onclose=(e)=>{ s.textContent='Disconnected'; log('room 1 closed '+e.code); rb.hidden=false; signal(); }; }
function signal(){ if(sig)return; const w=sock(2,'dropped-'+n+'-'+Date.now()); sig=w;
  w.onopen=()=>log('told the watcher');
  w.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.t==='ping')w.send(JSON.stringify({t:'pong',n:m.n})); else if(m.t==='clear'){log('watcher says rejoin');rejoin();}};
  w.onclose=()=>{ if(sig===w){sig=null; setTimeout(()=>{ if(!rb.hidden)signal(); },2000);} }; }
function rejoin(){ if(sig){const w=sig;sig=null;try{w.close()}catch(e){}} main(); }
rb.onclick=rejoin;
main();
</script>`;

const STALE_MS = 90000; // heartbeats come every 5 s; a background tab may slow to one a minute

export class BuzzRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = null;     // buzzes inside the open window
    this.buzz = undefined;   // [{name, team}, ...] in order | null; recovered from attachments
    this.closes = undefined; // when the alarm is set for; read back once after a wake
    // Trial logging (11/16): names of events only, never a token or a player.
    // 'wake' is printed each time the room is loaded, so a room that stops
    // sleeping shows as a gap in wakes.
    // Heartbeat: Cloudflare answers a page's 'hb' with 'hb' itself, without
    // waking the room and at no charge. A page that gets no answer knows its
    // connection is dead and joins again.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('hb', 'hb'));
    this.woke = Date.now();
    this.inFetch = true; // the wake line is replayed too
    this.log('wake', { sockets: ctx.getWebSockets().length });
    this.inFetch = false;
  }

  log(ev, more = {}) {
    const line = JSON.stringify({ ev, at: Date.now(), room: this.room || null, up: Date.now() - this.woke, ...more });
    console.log(line);
    // lines printed while a socket is being opened don't reach a live tail,
    // so they are printed again with the next frame
    if (this.inFetch) (this.late ||= []).push(line);
  }
  flush() { if (this.late) { for (const l of this.late) console.log('late ' + l); this.late = null; } }

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
  // time. (Trial: tournaments named ...-oldclose hang up from here instead.)
  retire(ws, why, code) {
    if (String(this.room).includes('-oldclose')) { try { ws.close(code, why); } catch (e) { /* already closed */ } return; }
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
    this.inFetch = true;
    try { return await this.join(request, q); } finally { this.inFetch = false; }
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
    this.log('join', { role, sockets: this.ctx.getWebSockets().length });
    this.send(server, { t: 'hello', id: this.ctx.id.toString().slice(0, 8), up: Date.now() - this.woke, sockets: this.ctx.getWebSockets().length, you: { role, name, team }, players: this.players(), buzz: bz ? bz[0] : null, list: bz || [] });
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
      if (list.length < MAX_LIST && !list.some((x) => x.name === c.name && x.team === c.team)) list.push({ name: c.name, team: c.team });
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
    if (String(this.room).includes('-nosweep')) return; // trial: rooms to compare against
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
    this.flush();
    if (a.gone) return;
    this.sweep(ws);

    if (a.role === 'reader') {
      if (msg.t !== 'clear') return;
      this.log('clear', { sockets: this.ctx.getWebSockets().length });
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
      return;
    }
    if (msg.t !== 'buzz') return;
    const adj = now - Math.min((a.rtt ?? 0) / 2 + SLACK_MS, MAX_COMP_MS);
    if (this.pending) { this.pending.push({ name: a.name, team: a.team, adj }); return; }
    const list = this.held();
    if (list) {
      // locked: the buzz still joins the order shown under the buzzer
      if (list.length >= MAX_LIST || list.some((x) => x.name === a.name && x.team === a.team)) return;
      const next = [...list, { name: a.name, team: a.team }];
      this.hold(next);
      this.all({ t: 'buzz', ...next[0], list: next });
      return;
    }
    // No await between the check and the lock: one buzz opens the window.
    this.pending = [{ name: a.name, team: a.team, adj }];
    this.all({ t: 'pending' });
    const w = this.window();
    if (w) setTimeout(() => this.resolve(), w); else this.resolve();
  }

  webSocketClose(ws, code, reason, wasClean) {
    const a = this.att(ws);
    this.room = this.room || a.room;
    this.flush();
    // finish the close handshake: without the reply the other end waits,
    // then gives up and reports a broken connection
    if (code !== undefined) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason || ''); } catch (e) { /* already closed */ } }
    if (code !== undefined) this.log('close', { code, wasClean, role: a.role, age: Date.now() - (a.at || 0), sockets: this.ctx.getWebSockets().length });
    if (a.role === 'player' && !a.gone) this.all({ t: 'players', players: this.players(ws) }, ws);
  }
  webSocketError(ws, err) {
    const a = this.att(ws);
    this.room = this.room || a.room;
    this.log('error', { msg: String(err && err.message || err), role: a.role, age: Date.now() - (a.at || 0), sockets: this.ctx.getWebSockets().length });
    this.webSocketClose(ws);
  }
}
