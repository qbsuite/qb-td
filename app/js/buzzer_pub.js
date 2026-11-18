// buzzer_pub.js — joining a buzzer room from the public page (t.html): a
// Buzzer button in the corner that opens over the page, holding three
// steps: password, who you are (found in the tournament's roster with the
// page's own player search), the room.
// pubview.js loads this only when the tournament has buzzer rooms
// (state.buzzer) and hands it the page's own data through mountBuzzer.
import { pub } from './api.js';
import { pickerHtml, wirePicker } from './newstats.js';
import { joinRoom, beep, esc, shortNames, sound, orderHtml, soundHtml, wireSound, teamsHtml } from './buzzer_client.js';

// a token lasts up to 12 hours: ask for a new one once it is 10 hours old
const TOKEN_FRESH_MS = 10 * 60 * 60 * 1000;
const TOKEN_LIFE_MS = 12 * 60 * 60 * 1000;

// Buzz when the button goes down, or when it comes back up: the player's
// choice, remembered on this device, and made apart for the two ways of
// buzzing. A click or tap buzzes on release unless changed (a finger that
// lands on the button by accident can slide off); Space buzzes on press
// (a key has no sliding off, and the way down is the faster half).
// qbtdBuzzerOn is the single choice of before: it stands for the click.
const whenOf = (key, dflt, old) => ({
  get v() {
    try {
      const x = localStorage.getItem(key) || (old && localStorage.getItem(old));
      return x === 'press' || x === 'release' ? x : dflt;
    } catch (e) { return dflt; }
  },
  set v(x) { try { localStorage.setItem(key, x); } catch (e) { /* private */ } },
});
const when = { click: whenOf('qbtdBuzzerOnClick', 'release', 'qbtdBuzzerOn'), space: whenOf('qbtdBuzzerOnSpace', 'press') };

// What pubview.js gives (see mountBuzzer); replaced on each of its loads.
let page = null;
let KEY = '';
let short = new Map();
const label = (n) => short.get(n) || n;

// what this device remembers, so coming back to the page goes straight in:
// {pw, tk, rooms, at} the password and the token it last got (the room ids
// that have a buzzer, and when), {team, name, room} who and where
let me = {};
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (e) { /* private */ } };

const panel = document.createElement('div');
panel.className = 'bzp';
let fab = null;
let conn = null;
let gen = 0; // counts enter(): a token asked for an earlier room is dropped
let st = { live: false, players: [], buzz: null, list: [], pending: false };
let wrong = false;
let pressed = false; // this player pressed since the last Clear
let been = false;    // this page has been in its room
let tab = 'Room';     // what shows under the button: Room, Schedule or Settings

/** A room is its schedule room's bucket id; it has a buzzer when the
    token's reply listed it. */
const hasBuzzer = (id) => id != null && Array.isArray(me.rooms) && me.rooms.includes(id);
const buzzerRooms = () => page.rooms().filter((r) => hasBuzzer(r.id));

/** Trade the password for a token: 'ok' (kept in `me`), 'wrong' (403), or
    'fail' for anything else. */
async function ask(pw) {
  try {
    const r = await pub('/pub/' + page.slug + '/buzzer', { method: 'POST', json: { pw } });
    if (!r || typeof r.token !== 'string' || !r.token) return 'fail';
    me.pw = pw;
    me.tk = r.token;
    me.rooms = Array.isArray(r.rooms) ? r.rooms : [];
    me.region = typeof r.region === 'string' ? r.region : 'enam';
    me.at = Date.now();
    keep();
    return 'ok';
  } catch (e) {
    return e && e.status === 403 ? 'wrong' : 'fail';
  }
}

/** The token a room connection opens with: the one held while it is
    fresh, else a new one for the remembered password. A password the
    tournament no longer takes gives none (the room refuses, and the page
    goes back to the password step); a request that only failed keeps
    trying, on the old token while that still has life in it. */
const tokenFor = (g) => async () => {
  if (me.tk && Date.now() - me.at < TOKEN_FRESH_MS) return me.tk;
  for (let wait = 2000; g === gen; wait = Math.min(wait * 2, 15000)) {
    const r = await ask(me.pw);
    if (g !== gen) break;
    if (r === 'ok') { draw(); return me.tk; }
    if (r === 'wrong') return null;
    if (me.tk && Date.now() - me.at < TOKEN_LIFE_MS) return me.tk;
    await new Promise((done) => { setTimeout(done, wait); });
  }
  return null;
};

/** The room the schedule has this team in for the live round. */
function scheduledRoom(team) {
  const g = page.games(team).find((r) => !r.bye && r.round === page.liveRound());
  return g ? g.room : null;
}

/** This team's games, a row per round: who they play and where. */
const teamRounds = (team) => page.games(team).slice().sort((a, b) => a.round - b.round);
/** Where this team probably plays next: its first game with no score yet. */
const nextGame = (rows) => rows.find((r) => !r.bye && !r.score) || null;

/** The schedule under the buzzer's settings: a row per round, with the
    score once that game is exported — so the next room is the first row
    without one. */
function schedHtml() {
  const rows = teamRounds(me.team);
  const next = nextGame(rows);
  return `<table class="bzsched"><tr><th>Round</th><th>${esc(me.team)} vs</th><th>Room</th><th class="res">Score</th></tr>${rows.map((r) => {
    const go = !r.bye && hasBuzzer(r.room);
    let score = '';
    // the next game's score isn't in yet: its place holds the way there
    if (r === next && go && r.room !== me.room) score = `<button class="bznext" data-goroom="${r.room}">Go to room</button>`;
    if (r.score) {
      const s = r.score;
      const pts = s.forfeit ? '(forfeit)' : `${s.us}–${s.them}`;
      score = s.res === 'W' ? `<b>W ${pts}</b>` : `${s.res === 'T' ? 'T' : 'L'} ${pts}`;
    }
    // a row goes to its room
    return `<tr class="${r.score ? 'played' : ''}"${go ? ` data-goroom="${r.room}" tabindex="0" role="button"` : ''}><td class="num">${r.round}</td><td>${r.bye ? 'Bye' : esc(r.vs)}</td>
      <td>${r.bye ? '' : esc(r.roomName)}</td><td class="res">${score}</td></tr>`;
  }).join('')}</table>`;
}

function enter() {
  if (conn) conn.close();
  conn = null;
  gen++;
  st = { live: false, players: [], buzz: null, list: [], pending: false };
  been = false;
  if (me.pw && me.team && me.name) {
    if (me.room == null) me.room = scheduledRoom(me.team);
    if (!hasBuzzer(me.room)) { const first = buzzerRooms()[0]; me.room = first ? first.id : null; }
    if (me.room != null) {
      conn = joinRoom({
        slug: page.slug, room: me.room, name: me.name, team: me.team,
        token: tokenFor(gen),
        on: (s, why) => {
          st = s;
          if (s.live) been = true;
          // the presser heard it on pressing
          if (why === 'pending' && sound.on && !pressed) beep();
          if (why === 'clear' || (why === 'hello' && !s.buzz)) { pressed = false; if (fx && !fx.preview) fx = null; }
          if (why === 'buzz' && pressed && navigator.vibrate) {
            navigator.vibrate(s.buzz.name === me.name && s.buzz.team === me.team ? 200 : [40, 60, 40]);
          }
          if (why === 'refused') { me = {}; keep(); wrong = true; conn = null; }
          draw();
        },
      });
    }
  }
  draw();
}

function draw() {
  if (!me.pw) {
    panel.innerHTML = `<form class="bzjoin">
      <p class="bzhelp">Enter the buzzer password from your tournament director.</p>
      <label for="bzpw">Password</label>
      <div class="bzrow"><input id="bzpw" type="password" autocomplete="off" autocapitalize="off"><button class="primary">Join</button></div>
      ${wrong ? '<div class="bad">Wrong password.</div>' : ''}</form>`;
    return;
  }
  // who you are: the roster's players under their teams, with a search box
  if (!me.team || !me.name) {
    const items = page.teams().flatMap((t) => t.players.map((name) => ({ name, team: t.name })))
      .sort((x, y) => x.team.localeCompare(y.team) || x.name.localeCompare(y.name));
    panel.innerHTML = `<div class="bzstep bzwhostep"><p class="bzhelp">Select your name.</p>${pickerHtml('bzwho', items, -1)}</div>`;
    const btn = panel.querySelector('#bzwho');
    btn.textContent = 'Search players';
    btn.classList.add('empty');
    wirePicker('bzwho', items, -1, (p) => { me.team = p.team; me.name = p.name; delete me.room; keep(); }, enter);
    return;
  }
  const b = st.buzz;
  const mine = b && b.name === me.name && b.team === me.team;
  // Shown ahead of the room's answer, so nothing waits on the network: a
  // press reads Buzzed at once, and the first word that anyone has buzzed
  // locks everyone else. The named winner then settles it either way.
  const look = b ? (mine ? 'mine' : 'locked') : pressed ? 'mine' : st.pending ? 'locked' : '';
  // the next game is in another room: the Schedule tab is marked, since
  // that is where the way there is
  const next = nextGame(teamRounds(me.team));
  const elsewhere = !!(next && hasBuzzer(next.room) && next.room !== me.room);
  const pane = tab === 'Schedule' ? schedHtml()
    : tab === 'Settings' ? `<div class="bzopts">
      ${[['click', 'Click buzzes on'], ['space', 'Space buzzes on']].map(([k, text]) => `<span class="bzwhen" role="group" aria-label="${text}">${text}
        <button data-when="press" data-how="${k}" aria-pressed="${when[k].v === 'press'}">Press</button><button data-when="release" data-how="${k}" aria-pressed="${when[k].v === 'release'}">Release</button></span>`).join('')}
      ${soundHtml()}
      <label class="bzanim">Animation <select data-bzanim>${ANIMS.map((n) => `<option${n === anim.v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>`
    : teamsHtml(st.players, label);
  panel.innerHTML = `<div class="bzroom">
    <div class="bztop">
      <select id="bzroomsel" aria-label="Room">${buzzerRooms().map((r) => `<option value="${r.id}"${r.id === me.room ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      <span class="bzme" title="${esc(me.name)} · ${esc(me.team)}">${esc(me.name)} · ${esc(me.team)}</span>
      <button class="linkbtn" data-leave>Leave</button>
    </div>
    <button class="bzbtn${!st.live ? ' off' : look === 'mine' ? ' mine' : look === 'locked' ? ' locked' : ''}">
      <span>${!st.live ? (been ? 'Reconnecting' : 'Connecting') : look === 'mine' ? 'Buzzed' : look === 'locked' ? 'Locked' : 'Buzz'}</span>
      ${look || !st.live ? '' : '<kbd>Space</kbd>'}
    </button>
    ${!st.live && been ? '<div class="bzdown" role="status">Disconnected. Press to retry.</div>' : ''}
    ${orderHtml(st.list, label)}
    <div class="bztabs" role="tablist">${['Room', 'Schedule', 'Settings'].map((t) => `<button role="tab" data-tab="${t}" aria-selected="${tab === t}"${
      t === 'Schedule' && elsewhere && tab !== t ? ' class="mark"' : ''}>${t}</button>`).join('')}</div>
    <div class="bzpane" role="tabpanel">${pane}</div>
  </div>`;
  animate(look);
}

function press(at = null) {
  // disconnected: a press tries the connection again at once
  if (conn && !st.live) { conn.retry(); return; }
  // a press behind someone else's buzz still joins the order, once
  if (!conn || !st.live || pressed) return;
  // the first press sounds at once; one behind someone else's buzz is silent
  if (sound.on && !st.buzz && !st.pending) beep();
  pressed = true;
  if (!st.buzz && !st.pending) fx = { name: anim.v, at: Date.now(), x: at ? at.x : null, y: at ? at.y : null };
  conn.buzz();
  draw();
}

// ---- how the button answers a press. The panel is redrawn whenever the
// room says something, which is within milliseconds of a press, so the
// animation is put back on each redraw from where it had got to.
const ANIMS = ['Ripple', 'Ring', 'Pop', 'Pulse', 'Flash', 'None'];
const FX_MS = { Ripple: 550, Ring: 600, Pop: 380, Pulse: 1100, Flash: 450 };
const anim = {
  get v() { try { const n = localStorage.getItem('qbtdBuzzerAnim'); return ANIMS.includes(n) ? n : 'Ripple'; } catch (e) { return 'Ripple'; } },
  set v(x) { try { localStorage.setItem('qbtdBuzzerAnim', x); } catch (e) { /* private */ } },
};
let fx = null; // { name, at, x, y, preview }: the press being animated
function animate(look) {
  const btn = panel.querySelector('.bzbtn');
  if (!btn || !fx || !FX_MS[fx.name]) return;
  // a press that turned out locked has nothing to celebrate
  if (!fx.preview && look !== 'mine') { fx = null; return; }
  const ms = FX_MS[fx.name];
  let gone = Date.now() - fx.at;
  // Pulse keeps going while the buzz is held (a preview shows two rounds)
  if (fx.name === 'Pulse' && (!fx.preview || gone < ms * 2)) gone %= ms;
  else if (gone >= ms) { fx = null; return; }
  btn.style.setProperty('--fxd', `-${gone}ms`);
  btn.classList.add('fx-' + fx.name.toLowerCase());
  if (fx.name === 'Ripple') {
    const r = btn.getBoundingClientRect();
    const i = document.createElement('i');
    i.className = 'rip';
    i.style.left = (fx.x == null ? r.width / 2 : fx.x - r.left) + 'px';
    i.style.top = (fx.y == null ? r.height / 2 : fx.y - r.top) + 'px';
    btn.append(i);
  }
}

function wirePanel() {
  wireSound(panel);
  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = panel.querySelector('#bzpw').value;
    const ok = (await ask(pw)) === 'ok';
    wrong = !ok;
    draw();
  });
  const goRoom = (el) => { const r = Number(el.dataset.goroom); if (r !== me.room) { me.room = r; keep(); enter(); } };
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-goroom]')) goRoom(e.target);
  });
  panel.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-goroom], .bznext');
    if (row) { goRoom(row); return; }
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.leave != null) { me = { pw: me.pw, tk: me.tk, rooms: me.rooms, at: me.at, region: me.region }; keep(); enter(); }
    else if (t.dataset.when) { when[t.dataset.how].v = t.dataset.when; draw(); }
    else if (t.dataset.tab) { tab = t.dataset.tab; draw(); }
    // release: the click. press: only a keyboard's click (Enter on the button)
    else if (t.classList.contains('bzbtn') && (when.click.v === 'release' || e.detail === 0)) press(e.detail ? { x: e.clientX, y: e.clientY } : null);
  });
  // press: the moment a finger or the mouse goes down
  panel.addEventListener('pointerdown', (e) => {
    if (when.click.v === 'press' && e.button === 0 && e.target.closest('.bzbtn')) press({ x: e.clientX, y: e.clientY });
  });
  panel.addEventListener('change', (e) => {
    if (e.target.matches('[data-bzsound]')) return; // wireSound's
    // choosing an animation shows it on the button
    if (e.target.matches('[data-bzanim]')) { anim.v = e.target.value; fx = { name: anim.v, at: Date.now(), x: null, y: null, preview: true }; draw(); return; }
    if (e.target.id !== 'bzroomsel') return;
    me.room = Number(e.target.value); keep(); enter();
  });
  // Space buzzes on a laptop, on the way down or the way up as chosen,
  // unless a field has the keyboard or the buzzer isn't showing
  const spaceBuzz = (e) => {
    if (e.code !== 'Space' || e.repeat || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!panel.isConnected || panel.closest('[hidden]') || !conn) return;
    e.preventDefault();
    if (e.type === (when.space.v === 'press' ? 'keydown' : 'keyup')) press();
  };
  addEventListener('keydown', spaceBuzz);
  addEventListener('keyup', spaceBuzz);
}

/**
 * Put the buzzer on the public page, or bring it up to date: pubview.js
 * calls this after each of its loads (the first, and each Refresh).
 * `p`, all read from the page's own data when asked:
 *   slug          the tournament
 *   on()          true while the tournament has buzzer rooms (state.buzzer)
 *   teams()       [{name, players: [name]}] from the roster ([] without one)
 *   rooms()       [{id, name}] the schedule's rooms; id = its bucket id, or null
 *   games(team)   that team's schedule rows, [{round, bye}] or
 *                 [{round, vs, room, roomName, score}]: room = the bucket id
 *                 (or null), score = null until the game is in, then
 *                 {res: 'W'|'L'|'T'|'', us, them, forfeit}
 *   liveRound()   the round being played
 *   region()      where the tournament's rooms are made (state.bzg)
 * The first call builds the button and joins the remembered room; a later
 * one only redraws from the new data, and leaves a live connection alone.
 */
// The roster changed under a remembered player (renamed, moved, removed):
// a team or a name the roster no longer has is picked again. Without a
// roster to check against, the remembered one stands.
function outdated() {
  const roster = page.teams();
  if (!roster.length || !me.team) return false;
  const t = roster.find((x) => x.name === me.team);
  if (t && (!me.name || t.players.includes(me.name))) return false;
  if (!t) delete me.team;
  delete me.name;
  delete me.room;
  keep();
  return true;
}

// The TD moved the rooms to another region: the token held opens the old
// ones, so the next connection asks for a new one.
function moved() {
  if (!me.tk || !page.region || (me.region || 'enam') === page.region()) return false;
  me.at = 0;
  keep();
  return true;
}

export function mountBuzzer(p) {
  page = p;
  short = shortNames(p.teams().flatMap((t) => t.players));
  if (!fab) {
    KEY = 'qbtdBuzzer:' + p.slug;
    try { me = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { me = {}; }
    wirePanel();
    outdated();
    // a Buzzer button in the corner: the room opens over the page
    fab = document.createElement('button');
    fab.className = 'bzfab';
    fab.textContent = 'Buzzer';
    const sheet = document.createElement('div');
    sheet.className = 'bzsheet';
    sheet.hidden = true;
    sheet.innerHTML = '<button class="bzclose" aria-label="Close">×</button>';
    sheet.append(panel);
    document.body.append(fab, sheet);
    fab.onclick = () => { sheet.hidden = false; };
    sheet.querySelector('.bzclose').onclick = () => { sheet.hidden = true; };
    fab.hidden = !p.on();
    moved();
    enter();
    return;
  }
  // the tournament has no buzzer rooms: the public page is as it is without one
  fab.hidden = !p.on();
  if (outdated() || moved()) { enter(); return; }
  // a name being looked for is left alone
  if (panel.querySelector('.pickpanel:not([hidden])')) return;
  // remembered, but the schedule wasn't there to find the room in: join now
  if (!conn && me.pw && me.team && me.name) enter();
  // a password being typed is left alone
  else if (me.pw) draw();
}
