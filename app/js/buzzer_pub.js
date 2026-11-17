// buzzer_pub.js — joining a buzzer room from the public page (t.html): a
// Buzzer button in the corner that opens over the page, holding three
// steps: password, who you are (from the tournament's roster), the room.
// pubview.js loads this only when the tournament has buzzer rooms
// (state.buzzer) and hands it the page's own data through mountBuzzer.
import { pub } from './api.js';
import { joinRoom, beep, esc, shortNames, sound, orderHtml } from './buzzer_client.js';

// a token lasts up to 12 hours: ask for a new one once it is 10 hours old
const TOKEN_FRESH_MS = 10 * 60 * 60 * 1000;
const TOKEN_LIFE_MS = 12 * 60 * 60 * 1000;

// Buzz when the button goes down, or when it comes back up: the player's
// choice, remembered on this device
const when = {
  get v() { try { return localStorage.getItem('qbtdBuzzerOn') === 'release' ? 'release' : 'press'; } catch (e) { return 'press'; } },
  set v(x) { try { localStorage.setItem('qbtdBuzzerOn', x); } catch (e) { /* private */ } },
};

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
  if (me.pw && me.team && me.name) {
    if (me.room == null) me.room = scheduledRoom(me.team);
    if (!hasBuzzer(me.room)) { const first = buzzerRooms()[0]; me.room = first ? first.id : null; }
    if (me.room != null) {
      conn = joinRoom({
        slug: page.slug, room: me.room, name: me.name, team: me.team,
        token: tokenFor(gen),
        on: (s, why) => {
          st = s;
          // the presser heard it on pressing
          if (why === 'pending' && sound.on && !pressed) beep();
          if (why === 'clear' || (why === 'hello' && !s.buzz)) pressed = false;
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
      <label for="bzpw">Password</label>
      <div class="bzrow"><input id="bzpw" type="password" autocomplete="off" autocapitalize="off"><button class="primary">Join</button></div>
      ${wrong ? '<div class="bad">Wrong password.</div>' : ''}</form>`;
    return;
  }
  const roster = page.teams();
  // picking a player: a team the roster no longer has is picked again
  if (me.team && !me.name && !roster.some((x) => x.name === me.team)) delete me.team;
  if (!me.team) {
    panel.innerHTML = `<div class="bzstep"><div class="bzlabel">Team</div>
      <div class="bzpick">${roster.map((t) => `<button data-team="${esc(t.name)}">${esc(t.name)}</button>`).join('')}</div></div>`;
    return;
  }
  if (!me.name) {
    const t = roster.find((x) => x.name === me.team);
    panel.innerHTML = `<div class="bzstep"><div class="bzlabel"><button class="linkbtn" data-back>${esc(me.team)}</button></div>
      <div class="bzpick">${t.players.map((p) => `<button data-name="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>`;
    return;
  }
  const b = st.buzz;
  const mine = b && b.name === me.name && b.team === me.team;
  // Shown ahead of the room's answer, so nothing waits on the network: a
  // press reads Buzzed at once, and the first word that anyone has buzzed
  // locks everyone else. The named winner then settles it either way.
  const look = b ? (mine ? 'mine' : 'locked') : pressed ? 'mine' : st.pending ? 'locked' : '';
  const teams = new Map();
  for (const p of st.players) teams.set(p.team, [...(teams.get(p.team) || []), p.name]);
  panel.innerHTML = `<div class="bzroom">
    <div class="bztop">
      <select id="bzroomsel" aria-label="Room">${buzzerRooms().map((r) => `<option value="${r.id}"${r.id === me.room ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      <span class="bzme">${esc(me.name)} · ${esc(me.team)}</span>
      <button class="linkbtn" data-leave>Leave</button>
    </div>
    <button class="bzbtn${look === 'mine' ? ' mine' : look === 'locked' ? ' locked' : ''}${st.live ? '' : ' off'}"${!st.live ? ' disabled' : ''}>
      <span>${look === 'mine' ? 'Buzzed' : look === 'locked' ? 'Locked' : 'Buzz'}</span>
      ${look ? '' : '<kbd>Space</kbd>'}
    </button>
    ${orderHtml(st.list, label)}
    <div class="bzlist">${[...teams].map(([t, names]) => `<div><b>${esc(t)}</b>${names.sort().map((n) => `<span title="${esc(n)}">${esc(label(n))}</span>`).join('')}</div>`).join('')}</div>
    <div class="bzopts">
      <span class="bzwhen" role="group" aria-label="Buzz on">Buzz on
        <button data-when="press" aria-pressed="${when.v === 'press'}">Press</button><button data-when="release" aria-pressed="${when.v === 'release'}">Release</button></span>
      <label class="bzsound"><input type="checkbox"${sound.on ? ' checked' : ''}> Sound</label>
    </div>
    ${schedHtml()}
  </div>`;
}

function press() {
  // a press behind someone else's buzz still joins the order, once
  if (!conn || !st.live || pressed) return;
  // the first press sounds at once; one behind someone else's buzz is silent
  if (sound.on && !st.buzz && !st.pending) beep();
  pressed = true;
  conn.buzz();
  draw();
}

function wirePanel() {
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
    if (t.dataset.team) { me.team = t.dataset.team; keep(); draw(); }
    else if (t.dataset.back != null) { delete me.team; keep(); draw(); }
    else if (t.dataset.name) { me.name = t.dataset.name; keep(); enter(); }
    else if (t.dataset.leave != null) { me = { pw: me.pw, tk: me.tk, rooms: me.rooms, at: me.at }; keep(); enter(); }
    else if (t.dataset.when) { when.v = t.dataset.when; draw(); }
    // release: the click. press: only a keyboard's click (Enter on the button)
    else if (t.classList.contains('bzbtn') && (when.v === 'release' || e.detail === 0)) press();
  });
  // press: the moment a finger or the mouse goes down
  panel.addEventListener('pointerdown', (e) => {
    if (when.v === 'press' && e.button === 0 && e.target.closest('.bzbtn')) press();
  });
  panel.addEventListener('change', (e) => {
    if (e.target.closest('.bzsound')) { sound.on = e.target.checked; return; }
    if (e.target.id !== 'bzroomsel') return;
    me.room = Number(e.target.value); keep(); enter();
  });
  // Space buzzes on a laptop, on the way down or the way up as chosen,
  // unless a field has the keyboard or the buzzer isn't showing
  const spaceBuzz = (e) => {
    if (e.code !== 'Space' || e.repeat || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!panel.isConnected || panel.closest('[hidden]') || !conn) return;
    e.preventDefault();
    if (e.type === (when.v === 'press' ? 'keydown' : 'keyup')) press();
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
    enter();
    return;
  }
  // the tournament has no buzzer rooms: the public page is as it is without one
  fab.hidden = !p.on();
  if (outdated()) { enter(); return; }
  // remembered, but the schedule wasn't there to find the room in: join now
  if (!conn && me.pw && me.team && me.name) enter();
  // a password being typed is left alone
  else if (me.pw) draw();
}
