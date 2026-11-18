// buzzer_read.js — the moderator's buzzer card on the reader page (bundled
// into read.bundle.js through read_main.js). Only a room the TD gave a
// buzzer gets one: read_main.js calls mountBuzzer when the room's state
// carries `buzzer` ({slug, room, token}), or a resumed game finds what its
// room link remembered on this device. Otherwise nothing here runs.
//
// The card: who buzzed, in order, who is in the room, Clear and Sound. A
// frame goes around the page from the first buzz until Clear. A buzz also
// readies that player in MODAQ's own menu: click the word they buzzed on
// and their Correct / Wrong choices are already open.
import { joinRoom, playSound, shortNames, teamSound, teamSoundsHtml, wireTeamSounds, orderHtml, teamsHtml } from './buzzer_client.js';

/* ---------- what a room link remembers for its game links ---------- */

// A game link (?b=<secret>&g=<id>) makes no requests, so the room link
// leaves the room's buzzer on this device, under the same store name the
// room's games are kept by (the link secret; a test room's apart).
const memKey = (store) => 'qbtdBuzzer:' + store;

/** Keeps the room's buzzer ({slug, room, token}) and the roster's player
    names for this device's game links; no buzzer forgets it. */
export function rememberBuzzer(store, info, names) {
  try {
    if (!validInfo(info)) { localStorage.removeItem(memKey(store)); return; }
    const had = recallBuzzer(store);
    localStorage.setItem(memKey(store), JSON.stringify({
      slug: info.slug, room: info.room, token: info.token,
      names: names || (had && had.names) || [],
    }));
  } catch (e) { /* private mode: this page still has its card */ }
}

/** What rememberBuzzer kept: {slug, room, token, names}, or null. */
export function recallBuzzer(store) {
  try {
    const v = JSON.parse(localStorage.getItem(memKey(store)));
    if (!validInfo(v)) return null;
    return { slug: v.slug, room: v.room, token: v.token, names: Array.isArray(v.names) ? v.names.filter((n) => typeof n === 'string') : [] };
  } catch (e) { return null; }
}

const validInfo = (v) => !!v && typeof v === 'object' && typeof v.slug === 'string' && !!v.slug
  && (typeof v.room === 'number' || typeof v.room === 'string') && v.room !== ''
  && typeof v.token === 'string' && !!v.token;

/* ---------- the card ---------- */

let mounted = null;
// the game's two teams, in the reader's order (read_main.js says which): the first has the first sound
let gameTeams = ['', ''];
export function buzzerTeams(a, b) {
  if (gameTeams[0] === (a || '') && gameTeams[1] === (b || '')) return;
  gameTeams = [a || '', b || ''];
  if (mounted) mounted.redraw();
}

/** Puts the card on the page and joins the room as its moderator.
    info: {slug, room, token}; names: the roster's player names (for the
    short labels). Returns {names(list)} to hand the roster over once it
    has loaded; a second call only does that. */
// a speaker (Feather's "volume-2", MIT): what it opens is the two sounds
const GEAR = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const CORNERS = ['nw', 'ne', 'sw', 'se'].map((c) => `<i class="bzcorner ${c}" data-c="${c}" aria-hidden="true"></i>`).join('');

export function mountBuzzer(info, names) {
  if (mounted) { if (names) mounted.names(names); return mounted; }
  if (!validInfo(info)) return null;
  document.body.classList.add('bz-card');

  let short = shortNames(names || []);
  const label = (n) => short.get(n) || n;

  const box = document.createElement('div');
  box.className = 'bzr';
  document.body.append(box);
  // card: sits just under the top bar, wherever that ends
  const under = () => {
    const bar = document.querySelector('.rbar');
    if (bar) document.documentElement.style.setProperty('--bztop', Math.round(bar.getBoundingClientRect().bottom + 8) + 'px');
  };
  under();
  addEventListener('resize', under);
  // the bar moves down when a strip (demo, test room) lands above it
  new MutationObserver(under).observe(document.body, { childList: true });
  setTimeout(under, 1000);

  let st = { live: false, players: [], buzz: null, list: [], pending: false };
  const showList = false;
  let heard = null; // which team's sound this buzz has had
  let showSet = false; // the two sounds are open
  let been = false; // this page has been in the room
  const conn = joinRoom({
    slug: info.slug, room: info.room, name: '', team: '', token: async () => info.token,
    on: (s, why) => {
      st = s;
      if (s.live) been = true;
      // The stop signal, in the sound of the team that pressed (a team that is
      // not one of the game's two, or a room that does not say, has the
      // first's). Should the lag evening then give the buzz to the other
      // team, that team's sound follows, so the ear is never left wrong.
      const side = (team) => (team === gameTeams[1] ? 1 : 0);
      if (why === 'pending') { heard = s.first ? side(s.first.team) : 0; playSound(teamSound.get(heard)); }
      if (why === 'buzz' && s.buzz && heard !== null && side(s.buzz.team) !== heard) { heard = side(s.buzz.team); playSound(teamSound.get(heard)); }
      if (why === 'clear' || (why === 'hello' && !s.buzz)) heard = null;
      // someone has buzzed: a box around the question being read, until Clear
      document.body.classList.toggle('bz-held', !!(s.buzz || s.pending));
      draw();
    },
  });

  // who is in the room, a column a team (buzzer_client.js)
  const listHtml = () => teamsHtml(st.players, label, true);

  function draw() {
    const b = st.buzz;
    const n = st.players.length;
    const clear = `<button class="bzclear"${b || st.pending ? '' : ' disabled'}>Clear<kbd>C</kbd></button>`;
    const count = `<button class="bzcount${st.live ? '' : ' off'}" aria-label="Players in the room" aria-expanded="${showList}"><i></i>${n}</button>`;
    // lit from the first word of a buzz, before the winner is named
    box.className = 'bzr' + (b || st.pending ? ' has' : '') + (!b && st.pending ? ' wait' : '') + (st.live ? '' : ' down');
    // its own connection is down: said across the card, with a way to try at once
    const down = st.live ? '' : `<div class="bzdown" role="status"><span>${been ? 'Buzzer disconnected' : 'Connecting'}</span>${been ? '<button data-bzretry>Reconnect</button>' : ''}</div>`;
    // the card: who has it and Clear, the buzzes in order, who is in the room
    box.innerHTML = `<div class="bzhead" title="Drag to move"><span class="bzgrip" aria-hidden="true">⋮⋮</span><span class="bztitle">Buzzer</span>${clear}${count}</div>${down}
    ${orderHtml(st.list, label) || '<div class="bzwho none">No buzz</div>'}${listHtml()}
    <div class="bzfoot"><button type="button" class="bzgear" data-bzset aria-label="Buzzer sounds" title="Buzzer sounds" aria-expanded="${showSet}">${GEAR}</button></div>
    ${showSet ? teamSoundsHtml(gameTeams) : ''}${CORNERS}`;
    if (pos) place();
  }
  wireTeamSounds(box);

  // ---- the card moves: drag it by its top line; it stays where it's put ----
  // Any corner drags the whole card bigger or smaller, words and all, with
  // the opposite corner staying put. The size is remembered like the spot.
  const SCALE = 'qbtdBuzzerCardScale';
  let scale = 1;
  try { const v = Number(localStorage.getItem(SCALE)); if (v >= 0.6 && v <= 2) scale = v; } catch (e) { /* full size */ }
  const sized = () => { box.style.transform = scale === 1 ? '' : `scale(${scale})`; };
  const POS = 'qbtdBuzzerCard';
  let pos = null;
  try {
    const p = JSON.parse(localStorage.getItem(POS));
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos = { x: p.x, y: p.y };
  } catch (e) { /* default spot */ }
  function place() {
    const r = box.getBoundingClientRect();
    pos.x = Math.max(0, Math.min(innerWidth - r.width, pos.x));
    pos.y = Math.max(0, Math.min(innerHeight - 40, pos.y));
    Object.assign(box.style, { left: pos.x + 'px', top: pos.y + 'px', right: 'auto' });
  }
  sized();
  // a size but no spot yet: keep the card's right edge where it was
  if (scale !== 1 && !pos) { const r = box.getBoundingClientRect(); pos = { x: r.right - box.offsetWidth * scale, y: r.top }; place(); }
  let drag = null;
  let size = null; // { ax, ay, left, top }: the corner that stays put, and which sides move
  box.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.bzcorner');
    if (c) {
      const r = box.getBoundingClientRect();
      const left = c.dataset.c.includes('w');
      const top = c.dataset.c.includes('n');
      size = { ax: left ? r.right : r.left, ay: top ? r.bottom : r.top, left, top };
      box.setPointerCapture(e.pointerId);
      box.classList.add('drag');
      e.preventDefault();
      return;
    }
    if (!e.target.closest('.bzhead') || e.target.closest('button')) return;
    const r = box.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    box.setPointerCapture(e.pointerId);
    box.classList.add('drag');
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (size) {
      const w = box.offsetWidth; // the card's width at full size
      const h = box.offsetHeight;
      // no bigger than the room between the fixed corner and the window's edges
      const room = Math.min((size.left ? size.ax : innerWidth - size.ax) / w, (size.top ? size.ay : innerHeight - size.ay) / h);
      scale = Math.max(0.6, Math.min(2, room, Math.abs(e.clientX - size.ax) / w));
      sized();
      pos = { x: size.left ? size.ax - w * scale : size.ax, y: size.top ? size.ay - h * scale : size.ay };
      place();
      return;
    }
    if (!drag) return;
    pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    place();
  });
  const drop = () => {
    if (size) {
      size = null;
      box.classList.remove('drag');
      try { localStorage.setItem(SCALE, String(+scale.toFixed(3))); localStorage.setItem(POS, JSON.stringify(pos)); } catch (e) { /* private */ }
      return;
    }
    if (!drag) return;
    drag = null;
    box.classList.remove('drag');
    try { localStorage.setItem(POS, JSON.stringify(pos)); } catch (e) { /* private */ }
  };
  box.addEventListener('pointerup', drop);
  box.addEventListener('pointercancel', drop);
  addEventListener('resize', () => { if (pos) place(); });

  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-bzset]')) { showSet = !showSet; draw(); return; }
    if (e.target.closest('[data-bzretry]')) { conn.retry(); return; }
    if (e.target.closest('.bzclear')) conn.clear();
  });
  // C clears, as the button does. MODAQ's own keys are E, N, P, B and 1-5.
  // Not while typing, not with a modifier held, not behind an open dialog.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'c' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const on = e.target;
    if (on && on.closest && on.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (document.querySelector('.ms-Modal, .ms-Dialog')) return;
    if (!st.buzz && !st.pending) return;
    e.preventDefault();
    conn.clear();
  });

  draw();

  // ---- the buzzer's name, ready in MODAQ's buzz menu ----
  // MODAQ's menu lists each team's players under the team's name; each
  // opens Correct / Wrong. When the menu opens while someone holds the
  // buzz, their row opens by itself.
  let readied = null;
  new MutationObserver(() => {
    const menu = document.querySelector('.ms-ContextualMenu-Callout .ms-ContextualMenu');
    if (!menu) { readied = null; return; }
    if (!st.buzz || readied === menu) return;
    readied = menu;
    const item = buzzerRow(menu, st.buzz);
    if (!item) return;
    item.classList.add('bzready');
    // after MODAQ's own focus-on-open, so the submenu stays open
    setTimeout(() => { item.focus(); item.click(); }, 60);
  }).observe(document.body, { childList: true, subtree: true });

  mounted = {
    names: (list) => { short = shortNames(list || []); draw(); },
    redraw: () => draw(),
  };
  return mounted;
}

// The row of the player holding the buzz. Fluent draws each team as a
// group (role="group") headed by the team's name, so the row is looked for
// under the buzzer's own team first: two players can share a name. A team
// the menu doesn't head that way falls back to the name, when only one row
// has it.
function buzzerRow(menu, buzz) {
  const text = (el) => ((el && (el.querySelector('.ms-ContextualMenu-itemText') || el).textContent) || '').trim();
  const want = String(buzz.name || '').trim();
  const team = String(buzz.team || '').trim();
  const rows = [...menu.querySelectorAll('.ms-ContextualMenu-link')].filter((item) => text(item) === want);
  const inTeam = rows.filter((item) => {
    const group = item.closest('[role="group"]');
    return !!group && text(group.querySelector('.ms-ContextualMenu-header')) === team;
  });
  if (inTeam.length) return inTeam[0];
  return rows.length === 1 ? rows[0] : null;
}
