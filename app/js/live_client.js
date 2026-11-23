// live_client.js — the browser side of a tournament's live room
// (buzzer/worker.js LiveRoom). The public page and the Live Hub watch it
// (watchLive): they are told when a deploy carrying the tournament went
// out ('pub'), when something the hub shows moved ('rev', the hub only),
// and each room's running score. The reader page sends its game's score
// (scoreLive).
//
// Cost is per connection (README "Live pages"), so:
// - tabs of one browser watching the same tournament share one socket:
//   the tab holding a Web Lock opens it and passes what it hears to the
//   others over a BroadcastChannel; when that tab goes, another takes over
// - a connection that drops while no tab of the tournament is visible is
//   not reopened until one is ('back' then tells the page to catch up)
// - rejoining waits a random 1-5 s, so a Cloudflare reroute that cuts
//   every socket at once doesn't bring them all back in the same instant,
//   and backs off to 30 s while the room keeps refusing
// - after three refused tries in a row the page is told 'fallback' (the
//   room is full for the day, or unreachable) and reads the free static
//   file on a timer instead; joining is still tried every 30 s
import { BUZZER_WS } from './buzzer_client.js';

const SERVER = new URLSearchParams(location.search).get('buzzerws') || BUZZER_WS;
const HEARTBEAT_MS = 5000, HEARTBEAT_WAIT_MS = 2500;
const REJOIN_MIN_MS = 1000, REJOIN_MAX_MS = 5000, RETRY_MAX_MS = 30000;
const FALLBACK_AFTER = 3;
const VISIBLE_FOR_MS = 30000; // a tab that said it was visible this recently counts

const url = (slug, token) => `${SERVER}/t/${encodeURIComponent(slug)}/live?token=${encodeURIComponent(token)}`;
const jitter = (lo, hi) => lo + Math.random() * (hi - lo);

// One socket, kept open by itself. on(msg) for every frame; status(s) with
// 'live' | 'down' | 'fallback' | 'over'. wanted(): should a dropped
// connection be reopened now. Returns { send, close, wake }.
function socket({ slug, token, on, status, wanted = () => true }) {
  let ws = null, closed = false, fails = 0, beat = null, owed = null, again = null, waiting = false;
  const clear = () => { clearInterval(beat); clearTimeout(owed); owed = null; };
  const open = () => {
    again = null;
    if (closed) return;
    if (!wanted()) { waiting = true; return; }
    waiting = false;
    const sock = new WebSocket(url(slug, token));
    ws = sock;
    let opened = false;
    const drop = () => {
      if (ws !== sock) return;
      clear();
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try { sock.close(); } catch (e) { /* gone */ }
      ws = null;
      if (closed) return;
      if (!opened) fails++;
      status(fails >= FALLBACK_AFTER ? 'fallback' : 'down');
      const wait = fails ? Math.min(RETRY_MAX_MS, REJOIN_MAX_MS * 2 ** (fails - 1)) : REJOIN_MAX_MS;
      again = setTimeout(open, jitter(REJOIN_MIN_MS, wait));
    };
    sock.onopen = () => {
      opened = true; fails = 0;
      status('live');
      beat = setInterval(() => {
        if (sock.readyState !== 1 || owed) return;
        sock.send('hb');
        owed = setTimeout(drop, HEARTBEAT_WAIT_MS);
      }, HEARTBEAT_MS);
    };
    sock.onmessage = (e) => {
      if (e.data === 'hb') { clearTimeout(owed); owed = null; return; }
      let m;
      try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'over') { closed = true; clear(); status('over'); try { sock.close(); } catch (x) { /* gone */ } }
      on(m);
    };
    sock.onclose = drop;
    sock.onerror = drop;
  };
  open();
  return {
    send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; },
    close() { closed = true; clear(); clearTimeout(again); if (ws) { ws.onclose = null; try { ws.close(1000); } catch (e) { /* gone */ } } },
    // a tab became visible: reopen now if a reopen was held back
    wake() { if (waiting && !closed) open(); },
  };
}

// The scores a watcher keeps: room id -> {room, round, a, b, sa, sb, tu, of}
function applyScore(scores, m) {
  if (m.t === 'hello') { scores.clear(); for (const s of m.scores || []) scores.set(s.room, s); return true; }
  if (m.t === 'score') { const { t, ...s } = m; scores.set(s.room, s); return true; }
  if (m.t === 'end') {
    const s = scores.get(m.room);
    if (s && (!m.round || s.round === m.round)) { scores.delete(m.room); return true; }
  }
  return false;
}

/** Watch a tournament's live room. rt: the {token, g} the Worker handed
    out (public state, or the hub's detail). role: 'viewer' | 'td', only to
    keep the two apart in one browser. on(why, scores): why is 'scores',
    'pub', 'rev', 'live', 'down', 'fallback', 'back' or 'over'; scores is
    the Map above. Returns stop(). */
export function watchLive({ slug, rt, role, on }) {
  if (!rt || !rt.token || typeof WebSocket === 'undefined') return () => {};
  const scores = new Map();
  const name = `qbtd-live:${role}:${slug}`;
  const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null;
  let leading = false, sock = null, stopped = false, wasDown = false;
  let seen = 0; // when another tab last said it was visible
  const anyVisible = () => document.visibilityState === 'visible' || Date.now() - seen < VISIBLE_FOR_MS;
  const tell = (why) => { if (!stopped) on(why, scores); };
  const handle = (m) => {
    if (applyScore(scores, m)) tell('scores');
    else if (m.t === 'pub' || m.t === 'rev') tell(m.t);
  };
  // what a follower hears: the leader's frames, its status, and on asking, the scores
  if (chan) chan.onmessage = (e) => {
    const d = e.data || {};
    if (d.vis) { seen = Date.now(); if (sock) sock.wake(); return; }
    if (leading) { if (d.sync) chan.postMessage({ snap: [...scores.values()] }); return; }
    if (d.frame) handle(d.frame);
    else if (d.snap) { scores.clear(); for (const s of d.snap) scores.set(s.room, s); tell('scores'); }
    else if (d.status) tell(d.status === 'live' && wasDown ? 'back' : d.status);
    if (d.status) wasDown = d.status !== 'live';
  };
  const lead = () => {
    leading = true;
    sock = socket({
      slug, token: rt.token, wanted: anyVisible,
      on: (m) => { handle(m); if (chan) chan.postMessage({ frame: m }); },
      status: (s) => {
        // back after a gap: the page may have missed a deploy, so catches up
        tell(s === 'live' && wasDown ? 'back' : s);
        wasDown = s !== 'live';
        if (chan) chan.postMessage({ status: s });
      },
    });
  };
  const onVis = () => {
    if (document.visibilityState !== 'visible') return;
    if (sock) sock.wake();
    if (chan) chan.postMessage({ vis: 1 });
  };
  document.addEventListener('visibilitychange', onVis);
  const visTimer = setInterval(() => { if (chan && document.visibilityState === 'visible') chan.postMessage({ vis: 1 }); }, VISIBLE_FOR_MS / 2);
  let release = null;
  if (navigator.locks && chan) {
    navigator.locks.request(name, () => new Promise((res) => { release = res; if (!stopped) lead(); else res(); }));
    // until this tab leads, ask the leader (if any) for the scores it holds
    chan.postMessage({ sync: 1 });
    if (document.visibilityState === 'visible') chan.postMessage({ vis: 1 });
  } else lead();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVis);
    clearInterval(visTimer);
    if (sock) sock.close();
    if (release) release();
    if (chan) chan.close();
  };
}

/** The reader's side: one game's score, sent at each new question and
    again on rejoining. rt: the room state's {token, g}. Returns
    { score(s), done(round), stop() }; every call is a no-op without rt. */
export function scoreLive({ slug, rt }) {
  if (!rt || !rt.token || typeof WebSocket === 'undefined') return { score() {}, done() {}, stop() {} };
  let last = null;
  const sock = socket({
    slug, token: rt.token,
    on: () => {},
    // a rejoin sends the score again: the room only keeps it while connected
    status: (s) => { if (s === 'live' && last) sock.send(last); },
  });
  return {
    score(s) { last = { t: 'score', ...s }; sock.send(last); },
    done(round) { last = null; sock.send({ t: 'done', round }); },
    stop() { sock.close(); },
  };
}
