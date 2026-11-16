// The browser side of the buzzer rooms (buzzer/worker.js). One socket to one
// tournament room, rejoining by itself when the connection drops or the
// page comes back to the front.
export const BUZZER_WS = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? `ws://${location.hostname}:8789` : 'wss://qb-td-buzzer.denisliu10.workers.dev';
const SERVER = new URLSearchParams(location.search).get('buzzerws') || BUZZER_WS;

const HEARTBEAT_MS = 5000, HEARTBEAT_WAIT_MS = 2500, REBUZZ_MS = 3000, BUZZ_WAIT_MS = 1200;

export function joinRoom({ slug, room, name = '', team = '', token, on }) {
  let ws = null;
  let closed = false;
  let tries = 0;
  let ever = false;  // has this page been in the room at all
  let beat = null;   // heartbeat timer
  let owed = null;   // heartbeat reply timer
  let want = 0;      // when a buzz was pressed that the room has not answered yet
  let dropNow = null; // gives up on the current connection and joins again
  const state = { live: false, players: [], buzz: null, list: [], pending: false, refused: false, over: false };
  const tell = (why) => on({ ...state }, why);
  const open = async () => {
    if (closed) return;
    // a fresh token each time: a player's lasts hours, a tournament days
    const tk = await token();
    if (closed) return;
    if (!tk) { closed = true; state.refused = true; tell('refused'); return; }
    const q = new URLSearchParams({ name, team, token: tk });
    ws = new WebSocket(`${SERVER}/t/${encodeURIComponent(slug)}/r/${room}/ws?${q}`);
    let opened = false;
    const sock = ws;
    // The connection can die without the browser hearing of it. Every few
    // seconds ask for an echo (Cloudflare answers without waking the room);
    // no echo, or a close, and the page joins again at once.
    const drop = () => {
      if (ws !== sock) return;
      clearInterval(beat); clearTimeout(owed); owed = null;
      sock.onopen = sock.onmessage = sock.onclose = null;
      try { sock.close(); } catch (e2) { /* gone */ }
      state.live = false;
      if (closed) return;
      tell('down');
      open();
    };
    dropNow = drop;
    ws.onopen = () => {
      opened = true; ever = true; state.live = true; tell('live');
      clearInterval(beat);
      beat = setInterval(() => {
        if (sock.readyState !== 1 || owed) return;
        sock.send('hb');
        owed = setTimeout(drop, HEARTBEAT_WAIT_MS);
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === 'hb') { clearTimeout(owed); owed = null; return; }
      const m = JSON.parse(e.data);
      tries = 0;
      // a buzz pressed just as the connection died goes out again on rejoining
      if (m.t === 'hello' && want && Date.now() - want < REBUZZ_MS && !m.buzz) sock.send(JSON.stringify({ t: 'buzz' }));
      if (m.t !== 'ping' && m.t !== 'players') want = 0;
      if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', n: m.n })); return; }
      // this player joined again somewhere else: this page steps aside
      if (m.t === 'elsewhere') { closed = true; state.live = false; clearInterval(beat); clearTimeout(owed); tell('elsewhere'); try { ws.close(); } catch (e2) { /* gone */ } return; }
      // the room stopped hearing this page's heartbeat and let it go
      if (m.t === 'rejoin') { drop(); return; }
      // the tournament's links closed: the room is over, nothing to rejoin
      if (m.t === 'over') { closed = true; state.live = false; state.over = true; tell('over'); try { ws.close(); } catch (e2) { /* gone */ } return; }
      if (m.t === 'hello') { state.players = m.players; state.buzz = m.buzz; state.list = m.list || []; state.pending = false; }
      else if (m.t === 'players') state.players = m.players;
      else if (m.t === 'pending') state.pending = true;
      else if (m.t === 'buzz') {
        // 'more': someone joined the order behind a buzz already shown
        if (state.buzz) { state.list = m.list || []; tell('more'); return; }
        state.buzz = { name: m.name, team: m.team }; state.list = m.list || []; state.pending = false;
      }
      else if (m.t === 'clear') { state.buzz = null; state.list = []; state.pending = false; }
      tell(m.t);
    };
    ws.onclose = (e) => {
      if (ws !== sock) return;
      clearInterval(beat); clearTimeout(owed); owed = null;
      state.live = false;
      if (closed) return;
      if (e.code === 4000) { closed = true; tell('elsewhere'); return; }
      // the tournament's links closed: the room is over, nothing to rejoin
      if (e.code === 4001) { closed = true; state.over = true; tell('over'); return; }
      // refused: two tries and never let in. Once in, a lost network is not a
      // refusal, and the page keeps trying.
      if (!opened) tries++;
      if (!ever && tries >= 2) { closed = true; state.refused = true; tell('refused'); return; }
      tell('down');
      // at once the first time, then backing off
      setTimeout(open, tries ? Math.min(4000, 300 * 2 ** tries) : 0);
      if (opened) tries++;
    };
    ws.onerror = () => {};
  };
  open();
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  return {
    // the room answers a buzz within a round trip; silence means the
    // connection is dead, so join again and the buzz goes out on arrival
    buzz: () => {
      const at = want = Date.now();
      send({ t: 'buzz' });
      setTimeout(() => { if (want === at && !closed && dropNow) dropNow(); }, BUZZ_WAIT_MS);
    },
    clear: () => send({ t: 'clear' }),
    close: () => { closed = true; clearInterval(beat); clearTimeout(owed); try { ws.close(); } catch (e) { /* gone */ } },
  };
}

let audio = null;
/** The buzz sound: a short two-tone beep, made here so there is no file. */
export function beep() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    for (const [f, at] of [[880, 0], [660, 0.09]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.18, t + at);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + 0.17);
    }
  } catch (e) { /* no sound */ }
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** What to call each player when space is short: the first name, plus as
    few letters of the rest as tell apart players who share it ("Elena Pap."
    and "Elena Pav."). `names`: the tournament's roster, so a label never
    changes with who happens to be in the room. Returns Map(full -> short). */
export function shortNames(names) {
  const split = (n) => { const i = n.trim().indexOf(' '); return i < 0 ? [n.trim(), ''] : [n.trim().slice(0, i), n.trim().slice(i + 1).trim()]; };
  const groups = new Map();
  for (const n of new Set(names)) { const [f] = split(n); groups.set(f, [...(groups.get(f) || []), n]); }
  const out = new Map();
  for (const [first, group] of groups) {
    if (group.length === 1) { out.set(group[0], first); continue; }
    const rests = group.map((n) => split(n)[1]);
    group.forEach((n, i) => {
      const rest = rests[i];
      let k = 1;
      while (k < rest.length && rests.some((r, j) => j !== i && r.slice(0, k).toLowerCase() === rest.slice(0, k).toLowerCase())) k++;
      out.set(n, !rest ? first : k >= rest.length ? n : `${first} ${rest.slice(0, k)}.`);
    });
  }
  return out;
}

/** The Sound checkbox, remembered on this device (on unless turned off). */
export const sound = {
  get on() { try { return localStorage.getItem('qbtdBuzzerSound') !== '0'; } catch (e) { return true; } },
  set on(v) { try { localStorage.setItem('qbtdBuzzerSound', v ? '1' : '0'); } catch (e) { /* private */ } },
};
/** The buzzes since Clear, in order, as buzzin.live lists them. */
export function orderHtml(list, label) {
  if (!list.length) return '';
  return `<ol class="bzorder">${list.map((x) => `<li title="${esc(x.name)}"><b>${esc(label(x.name))}</b><span>${esc(x.team)}</span></li>`).join('')}</ol>`;
}
