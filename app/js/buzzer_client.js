// The browser side of the buzzer rooms (buzzer/worker.js). One socket to one
// tournament room, rejoining by itself when the connection drops or the
// page comes back to the front.
export const BUZZER_WS = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? `ws://${location.hostname}:8789` : 'wss://qb-td-buzzer.denisliu10.workers.dev';
const SERVER = new URLSearchParams(location.search).get('buzzerws') || BUZZER_WS;

const HEARTBEAT_MS = 5000, HEARTBEAT_WAIT_MS = 2500, REBUZZ_MS = 3000, BUZZ_WAIT_MS = 1200, RETRY_MAX_MS = 15000;

export function joinRoom({ slug, room, name = '', team = '', token, on }) {
  let ws = null;
  let closed = false;
  let tries = 0;
  let ever = false;  // has this page been in the room at all
  let beat = null;   // heartbeat timer
  let owed = null;   // heartbeat reply timer
  let want = 0;      // when a buzz was pressed that the room has not answered yet
  let dropNow = null; // gives up on the current connection and joins again
  let again = null;   // the wait before the next try, while one is being waited out
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
    const drop = (why = '') => {
      if (ws !== sock) return;
      state.why = why; // why the connection was given up: 'heartbeat', 'buzz', 'rejoin'
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
        owed = setTimeout(() => drop('heartbeat'), HEARTBEAT_WAIT_MS);
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
      if (m.t === 'rejoin') { drop('rejoin'); return; }
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
      state.why = 'closed ' + e.code;
      if (closed) return;
      if (e.code === 4000) { closed = true; tell('elsewhere'); return; }
      // the tournament's links closed: the room is over, nothing to rejoin
      if (e.code === 4001) { closed = true; state.over = true; tell('over'); return; }
      // refused: two tries and never let in. Once in, a lost network is not a
      // refusal, and the page keeps trying.
      if (!opened) tries++;
      if (!ever && tries >= 2) { closed = true; state.refused = true; tell('refused'); return; }
      tell('down');
      // At once the first time, so a cut connection is back before the next
      // buzz. If that fails the service itself is in trouble, and every page
      // in the tournament is in the same loop: wait longer each time, up to
      // a quarter of a minute, and not all at the same moment (each attempt
      // is a request, and a tight loop from every page would spend the
      // day's). A person never has to sit the wait out: see retry().
      again = setTimeout(() => { again = null; open(); }, tries ? Math.min(RETRY_MAX_MS, 300 * 2 ** tries) * (0.5 + Math.random() / 2) : 0);
      if (opened) tries++;
    };
    ws.onerror = () => {};
  };
  open();
  // Try again now instead of waiting out the pause: for a press on the
  // page, the network coming back, and the page coming back to the front.
  const retry = () => { if (closed || state.live || !again) return; clearTimeout(again); again = null; open(); };
  const seen = () => { if (document.visibilityState === 'visible') retry(); };
  if (typeof addEventListener === 'function') addEventListener('online', retry);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', seen);
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  return {
    // the room answers a buzz within a round trip; silence means the
    // connection is dead, so join again and the buzz goes out on arrival
    buzz: () => {
      const at = want = Date.now();
      send({ t: 'buzz' });
      setTimeout(() => { if (want === at && !closed && dropNow) dropNow('buzz'); }, BUZZ_WAIT_MS);
    },
    clear: () => send({ t: 'clear' }),
    retry,
    close: () => {
      closed = true; clearInterval(beat); clearTimeout(owed); clearTimeout(again);
      if (typeof removeEventListener === 'function') removeEventListener('online', retry);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', seen);
      try { ws.close(); } catch (e) { /* gone */ }
    },
  };
}

let audio = null;
// Every sound is made here by the browser, so there is no file to load.
function tone({ type = 'sine', f, f2 = null, at = 0, len = 0.16, vol = 0.18 }) {
  const t = audio.currentTime + at;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + len);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + len + 0.02);
}
const SOUNDS = {
  Beep: () => { tone({ f: 880 }); tone({ f: 660, at: 0.09 }); },
  Bell: () => { tone({ f: 1320, len: 0.9, vol: 0.2 }); tone({ f: 2640, len: 0.5, vol: 0.07 }); tone({ f: 3960, len: 0.25, vol: 0.04 }); },
  Chime: () => { tone({ f: 660, len: 0.35 }); tone({ f: 880, at: 0.12, len: 0.4 }); tone({ f: 1320, at: 0.24, len: 0.6 }); },
  Ding: () => { tone({ type: 'triangle', f: 1568, len: 0.5, vol: 0.22 }); },
  Blip: () => { tone({ type: 'square', f: 420, f2: 1400, len: 0.12, vol: 0.12 }); },
  Laser: () => { tone({ type: 'sawtooth', f: 1800, f2: 220, len: 0.22, vol: 0.12 }); },
};
/** The sounds to pick from, in the order listed; Off is silence. */
export const SOUND_NAMES = [...Object.keys(SOUNDS), 'Off'];
/** Plays one sound by name (a preview, or the buzz itself). */
export function playSound(name) {
  if (!SOUNDS[name]) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    SOUNDS[name]();
  } catch (e) { /* no sound */ }
}
/** The buzz sound this device chose. */
export function beep() { playSound(sound.name); }

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

/** The buzz sound chosen on this device (Beep until one is picked; Off is
    silence, which is also what the old Sound checkbox's off was). */
export const sound = {
  get name() {
    try {
      const n = localStorage.getItem('qbtdBuzzerSoundName');
      if (SOUND_NAMES.includes(n)) return n;
      return localStorage.getItem('qbtdBuzzerSound') === '0' ? 'Off' : 'Beep';
    } catch (e) { return 'Beep'; }
  },
  set name(v) { try { localStorage.setItem('qbtdBuzzerSoundName', v); } catch (e) { /* private */ } },
  get on() { return this.name !== 'Off'; },
};
/** The sound picker: the list, and a button to hear the one chosen. */
export function soundHtml() {
  return `<span class="bzsound"><label>Sound <select data-bzsound>${SOUND_NAMES.map((n) => `<option${n === sound.name ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
    <button type="button" class="bzplay" data-bzplay aria-label="Play sound" title="Play sound">▶</button></span>`;
}
/** Wires a sound picker anywhere under `root`: choosing one plays it. */
export function wireSound(root) {
  root.addEventListener('change', (e) => { if (e.target.matches('[data-bzsound]')) { sound.name = e.target.value; playSound(sound.name); } });
  root.addEventListener('click', (e) => { if (e.target.closest('[data-bzplay]')) playSound(sound.name); });
}
/** Who is in the room: each team a column, its players down the column,
    two teams to a row. A room is meant to hold two teams; a third (players
    who have not left yet, someone in the wrong room) and any after it go
    on rows of their own, so a column is never narrower than half the
    width. In a row the team names share one line of the grid and the
    players the next, so the lines under the names stay level however long
    a name is.
    players: [{name, team}]; label(name) -> what to show. */
export function teamsHtml(players, label, pings = false) {
  const teams = new Map();
  for (const p of players) teams.set(p.team, [...(teams.get(p.team) || []), p]);
  if (!teams.size) return '';
  const all = [...teams];
  const rows = [];
  for (let i = 0; i < all.length; i += 2) rows.push(all.slice(i, i + 2));
  const row = (pair) => `<div class="bzcols${pings ? ' pings' : ''}${all.length === 1 ? ' one' : ''}">${pair.map(([t, ps]) => `<b title="${esc(t)}">${esc(t)}</b><div>${ps.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)).map((p) =>
    `<span title="${esc(p.name)}">${pings ? `<em>${esc(label(p.name))}</em>${pingHtml(p.rtt)}` : esc(label(p.name))}</span>`).join('')}</div>`).join('')}</div>`;
  return `<div class="bzteams">${rows.map(row).join('')}</div>`;
}
/** A player's round trip to the room, as the room last measured it (the
    figure its lag equalizing uses): small beside a name, coloured once it
    is slow enough to matter. */
export function pingHtml(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  return `<i class="bzping${ms >= 250 ? ' slow' : ms >= 120 ? ' mid' : ''}">${Math.round(ms)} ms</i>`;
}
/** The buzzes since Clear, in order, as buzzin.live lists them. */
export function orderHtml(list, label) {
  if (!list.length) return '';
  return `<ol class="bzorder">${list.map((x) => `<li title="${esc(x.name)}"><b>${esc(label(x.name))}</b><span title="${esc(x.team)}">${esc(x.team)}</span>${pingHtml(x.rtt)}</li>`).join('')}</ol>`;
}
