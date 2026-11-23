// schededit.js — the Tournament Setup schedule step: the format picker
// (with generation options) and the editor. The editor groups room
// columns into bracket lanes (Pool A, Championship, 1st place…), keeps
// the round column and room headers pinned while the grid scrolls, and
// lets a TD drag teams (swap, bench) and whole games (trade, move), or
// click the same things and act on them in a popover at what was
// clicked. Checks run on every edit and show as a count on the toolbar's
// warning sign; nothing is stored until Save (Generate saves at once, as
// before). Between two phases a line shows the tie order (the tournament
// setting, stats.js tieOrderOf) and, before Finals, what they rank on.
//
// admin.js owns the working schedule (the Live Hub reads it too); this
// module owns only the editor's view state, reached through `env`.

import { esc } from './api.js';
import { ICON as ICONS, named } from './icons.js';
import { busy } from './busy.js';
import {
  allFormats, poolSizes, validateSchedule, slotText, insertRound, removeRound,
  addRound, swapCells, removeRoomCol, hasPlaceholders,
  tagBrackets, bracketRooms, phaseLanes, scheduleChecks, renameTeams, removeTeam,
  poolOf, tradePools, tradesLocked, regenPart,
} from '../engine/schedule.js';
import { buildPlan, planPreview, planGroups, rebracketChecks, addFinals, handOk } from '../engine/plan.js';
import HDWHITE from '../engine/hdwhite.js';
import { finalsSources } from '../engine/finals.js';
import { DEFAULT_TIE_ORDER, isTieOrder } from '../engine/stats.js';

/* ---------- view state (per page load) ---------- */

const ui = {
  view: 'grid',          // grid | teams
  filter: '',            // '' = every bracket, else a bracket key
  closed: new Set(),     // collapsed phase indexes
  sel: null,             // {kind: slot|game|empty|room|round|lane, ...}: the popover's
  mode: null,            // swapSlot | moveGame | trade
  renaming: null,        // the popover's Rename: 'room' | 'lane'
  menu: null,            // the toolbar's open menu: 'plus' | 'more'
  probsOpen: false,      // the problem list under the toolbar
  past: [], future: [],  // JSON snapshots for Undo / Redo
  note: '',
  baseline: { obj: null, json: '' }, // the schedule as saved
  creator: false,        // showing the format picker over a schedule
  full: false,           // the editor fills the screen
  zoom: null,            // full screen: null = fit to the screen, else the TD's own zoom (1 = 100%)
  zoomNow: 1,            // the zoom last applied (what minus and plus step from)
  colW: {},              // 'laneKey@phase' -> px: room columns the TD dragged to a width of their own
  byeW: null,            // the Byes column, likewise
  opts: { seed: 1 + Math.floor(Math.random() * 9999) }, // the picker's seed (rounds are always shuffled)
  plan: null,            // the picker's plan (plan.js phases); null: from the schedule, or the default
  regen: 'all',          // what Generate replaces: 'all' or 'p<phase>'
  addPhase: false,       // the editor's Add phase form is open
};

/** Escape: close a menu, the popover or a half-done swap, then leave
    full screen. True if it did. */
export function schedEscape() {
  if (ui.menu) { ui.menu = null; return true; }
  if (!ui.sel && !ui.mode) {
    if (!ui.full) return false;
    setFull(false);
    return true;
  }
  ui.sel = null;
  ui.mode = null;
  ui.renaming = null;
  return true;
}

// Full screen: the editor covers the page (hub.css .sgfull) and, where
// the browser allows it, the page takes the whole screen. The cover is
// what matters; the browser's part is a bonus and may be refused.
let redrawFull = null; // the editor's own redraw, for when the browser leaves full screen
const ICON = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_FULL = ICON('M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4');
const ICON_EXIT = ICON('M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4');
// the button in the Schedule heading's corner (admin.js renderScheduleSec)
const fullBtn = () => document.getElementById('schedfull');
function setFull(on) {
  ui.full = on;
  ui.scrollPos = null;
  const root = document.documentElement;
  try {
    if (on && !document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  } catch (e) { /* the cover alone */ }
}
// In full screen the grid uses the screen it is given: the room columns
// share the width (COL_MIN..COL_MAX each), and Fit picks the zoom — down
// when the rooms still don't fit, up when there is room to spare, never so
// far up that the rounds stop fitting. ui.zoom set: the TD's own zoom, and
// the columns share whatever width that leaves. Returns the zoom applied.
const COL_MAX = 200;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.5;
const COL_LO = 64;   // as narrow and as wide as a dragged column goes
const COL_HI = 420;
const LEAD = 40;     // the round-number column

// A grid's columns. Its lanes ride on data-lanes ("A@0:4,B@0:3" = lane id
// and room count); a lane the TD dragged has its width in ui.colW, the
// others take `auto`. Returns [{w, own}] per room column.
function gridTracks(el, auto) {
  return (el.dataset.lanes || '').split(',').filter(Boolean).flatMap((part) => {
    const at = part.lastIndexOf(':');
    const own = ui.colW[part.slice(0, at)];
    return Array.from({ length: Number(part.slice(at + 1)) }, () => ({ w: own || auto, own: !!own }));
  });
}
const gridBye = (el) => ui.byeW || Number(el.dataset.bye);
function setTracks(el, auto) {
  el.dataset.auto = auto;
  el.style.gridTemplateColumns = `${LEAD}px ${gridTracks(el, auto).map((t) => t.w + 'px').join(' ')} ${gridBye(el)}px`;
}

function fitFull(box) {
  const scroll = box.querySelector('#sgscroll');
  if (!scroll) return 1;
  const kids = [...scroll.children];
  for (const k of kids) k.style.zoom = '';
  const clamp = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const grids = [...scroll.querySelectorAll('.sggrid')];
  let z = 1;
  if (!grids.length) {
    // By team and Brackets: no columns to share out, so only shrink to fit
    z = ui.zoom || (scroll.scrollWidth > scroll.clientWidth + 1 ? clamp(scroll.clientWidth / scroll.scrollWidth) : 1);
  } else {
    const colMin = Number(grids[0].dataset.col);
    // per grid: what its fixed parts take (round column, dragged columns,
    // Byes, a 4px gap after each track but the last, 10px of padding) and
    // how many columns are left to share the rest
    const shape = grids.map((el) => {
      const tracks = gridTracks(el, 0);
      return { fixed: LEAD + tracks.reduce((n, t) => n + t.w, 0) + gridBye(el) + (tracks.length + 1) * 4 + 10,
        auto: tracks.filter((t) => !t.own).length };
    });
    const width = (col) => Math.max(...shape.map((g) => g.fixed + g.auto * col));
    const anyAuto = shape.some((g) => g.auto);
    const availW = scroll.clientWidth - 2;
    const share = (zoom) => Math.max(colMin, Math.min(COL_MAX,
      ...shape.filter((g) => g.auto).map((g) => Math.floor((availW / zoom - g.fixed) / g.auto))));
    let col = colMin;
    if (ui.zoom) {
      z = ui.zoom;
      if (anyAuto) col = share(z);
    } else if (width(colMin) > availW) {
      z = clamp(availW / width(colMin));
    } else if (anyAuto) {
      col = share(1);
    }
    for (const el of grids) setTracks(el, col);
    if (!ui.zoom && width(col) < availW && (!anyAuto || col === COL_MAX)) {
      const height = kids.reduce((h, k) => h + k.offsetHeight, 0);
      z = Math.max(1, Math.min(ZOOM_MAX, availW / width(col), (scroll.clientHeight - 2) / height));
    }
  }
  z = Math.round(z * 100) / 100;
  for (const k of kids) k.style.zoom = z === 1 ? '' : z;
  return z;
}

if (typeof document !== 'undefined') {
  // the window changed size: fit again
  let resizing = null;
  window.addEventListener('resize', () => {
    if (!ui.full || !redrawFull) return;
    clearTimeout(resizing);
    resizing = setTimeout(() => { if (ui.full && redrawFull) redrawFull(); }, 150);
  });
  // Esc in the browser's full screen never reaches the page as a key
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || !ui.full) return;
    ui.full = false;
    if (redrawFull) redrawFull();
  });
}

const COLORS = 8; // lane tints cycle (td.css .lane-0..7)

// the toolbar's own symbols, drawn as icons.js draws the rest
const svg16 = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC_PLUS = svg16('<path d="M8 3v10M3 8h10"/>');
const IC_WARN = '<svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M10 2.8 18 16.5H2z"/><path d="M10 8v4" stroke-linecap="round"/><circle cx="10" cy="14.2" r=".5" fill="currentColor"/></svg>';
const IC_CHECK = '<svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="m6.8 10.2 2.2 2.2 4.2-4.6"/></svg>';

/* ---------- the tie order: one line of steps, each movable ---------- */

// The tournament's order (env.tieOrder(): stats.js tieOrderOf). One from
// before the order existed (its old tiebreak, mapped) shows its own steps,
// then the steps it never reaches, faded; moving any step saves a full
// order (env.saveTieOrder), PP20 becoming PPG. Steps after You pick are
// never reached either, and fade the same way.
const TIE_NAME = { game: 'Tiebreaker game', ppg: 'Points per game', h2h: 'Head-to-head', ppb: 'Points per bonus', pick: 'You pick', pp20: 'Points per 20' };
const TIE_SHORT = { game: 'Tiebreaker game (if exists)', ppg: 'PPG', h2h: 'Head-to-head', ppb: 'PPB', pick: 'You pick', pp20: 'PP20' };
function tieLine(env) {
  const cur = env.tieOrder ? env.tieOrder() : [...DEFAULT_TIE_ORDER];
  if (isTieOrder(cur)) return { steps: cur, reach: cur.indexOf('pick') + 1, legacy: false };
  const rest = DEFAULT_TIE_ORDER.filter((x) => !cur.includes(x) && !(x === 'ppg' && cur.includes('pp20')));
  return { steps: [...cur, ...rest], reach: cur.length, legacy: true };
}
function tieChips(env) {
  const { steps, reach, legacy } = tieLine(env);
  return `<span class="sgtline">${steps.map((c, i) => `${i ? '<span class="sgtarr">→</span>' : ''}<span class="sgtchip${i >= reach ? ' after' : ''}${c === 'pick' ? ' pick' : ''}" draggable="true" data-tchip="${i}"
    title="${esc(TIE_NAME[c])}${i >= reach && !legacy ? ' (not reached: you pick first)' : ''}">${i > 0 ? `<button class="tl" data-tcl="${i}" aria-label="Earlier">‹</button>` : ''}${
    esc(TIE_SHORT[c])}${i < steps.length - 1 ? `<button class="tr" data-tcr="${i}" aria-label="Later">›</button>` : ''}</span>`).join('')}</span>`;
}
// the arrows and dragging; each move is saved at once (a setting, not a schedule edit)
function wireTieChips(root, env, redraw) {
  const move = async (from, to) => {
    const steps = [...tieLine(env).steps];
    const [c] = steps.splice(from, 1);
    steps.splice(to, 0, c);
    const next = steps.map((x) => (x === 'pp20' ? 'ppg' : x));
    if (!isTieOrder(next) || !env.saveTieOrder) return;
    try { await env.saveTieOrder(next); } catch (e) { env.say(e.message, true); }
    redraw();
  };
  root.querySelectorAll('[data-tcl]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); const i = Number(b.dataset.tcl); move(i, i - 1); }; });
  root.querySelectorAll('[data-tcr]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); const i = Number(b.dataset.tcr); move(i, i + 1); }; });
  let from = null;
  const done = () => { from = null; root.querySelectorAll('.sgtchip.dragging, .sgtchip.dropat').forEach((x) => x.classList.remove('dragging', 'dropat')); };
  root.querySelectorAll('[data-tchip]').forEach((ch) => {
    ch.ondragstart = (ev) => {
      ev.stopPropagation();
      from = Number(ch.dataset.tchip);
      ch.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', 'tie order');
    };
    ch.ondragover = (ev) => {
      if (from === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      root.querySelectorAll('.sgtchip.dropat').forEach((x) => { if (x !== ch) x.classList.remove('dropat'); });
      ch.classList.add('dropat');
    };
    ch.ondrop = (ev) => {
      if (from === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      const f = from;
      const to = Number(ch.dataset.tchip);
      done();
      if (f !== to) move(f, to);
    };
    ch.ondragend = done;
  });
}

const refKey = (x) => x.bye !== undefined ? `${x.p}.${x.r}.b${x.bye}` : `${x.p}.${x.r}.${x.room}.${x.side}`;
const cellKey = (x) => `${x.p}.${x.r}.${x.room}`;
const slotShow = (s) => {
  if (!s) return '';
  if (s.team) return s.team;
  const m = /^([A-Z])(\d+)$/.exec(s.label || '');
  if (!m) return s.label || '';
  const n = Number(m[2]);
  return `Pool ${m[1]} ${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
};

/**
 * Render the step into `box`. env:
 *   sched(), setSched(s)   the working schedule (null: none yet)
 *   dirty(), setDirty(b)
 *   teams                  roster team names, seed order
 *   buckets                the tournament's rooms [{id, room_name}]
 *   roomsN(), setRoomsN(n) (unused now: the picker takes the Rooms step's rooms)
 *   save(s), del()         Worker calls
 *   fill()                 -> {A: [names best-first], ...} for placeholders
 *   say(text, bad), refresh() (full hub render)
 */
export function renderSchedStep(box, env) {
  const sched = env.sched();
  if (!sched || ui.creator) {
    box.classList.remove('sgfull');
    renderCreator(box, env);
    return;
  }

  // A schedule we haven't seen yet (fresh from the Worker, or after a
  // Discard): tag its brackets in place and take it as the saved copy.
  if (sched !== ui.baseline.obj && !env.dirty()) {
    tagBrackets(sched);
    ui.baseline = { obj: sched, json: JSON.stringify(sched) };
  }
  renderEditor(box, env);
}

/* ================= format picker ================= */

// The Format menu is hdwhite's formats for the team count (hdwhite.js),
// the engine formats added on purpose since (triple and quadruple round
// robins; two places a pool from pools of 5 or more), then Custom. Picking
// a format fills in its phases (plan.js); every control stays editable,
// and changing the structure turns Format to Custom. Rounds are always
// shuffled, so the seed always matters.

const MODES = [['rotate', 'Teams rotate through rooms evenly'], ['keep', 'Teams stay in one room where possible'],
  ['shuffle', 'Teams get random rooms each round']];
const TYPES = [['brackets', 'Pools'], ['same', 'Repeat previous phases'], ['single', 'Single elimination'], ['double', 'Double elimination']];
const REPEAT = ['', 'double', 'triple', 'quadruple', 'quintuple', 'sextuple'];
const ORDN = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const phase = (name, o = {}) => ({ name, kind: 'pools', groups: 1, top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1,
  carry: true, reset: true, byes: false, sizes: null, parallelTop: false, share: false, n: 3, mode: 'rotate', ...o });
const teamsOf = (t) => Array.from({ length: t }, (_, i) => 'T' + i);
const sizesOf = (gs) => gs.map((g) => g.members.length).join('/');

// phases for k pools played `cycles` times ("Round robin 1", "Round robin
// 2", … as the engine names a repeated round robin), then playoffs; a
// 2-pool split in two is each pool's own top and bottom half
function phasesFor({ k, cycles = 1, byes = false, sizes = null, parallelTop = false, carry = true, per = null }) {
  const out = [];
  const one = k === 1 && !sizes;
  for (let c = 0; c < cycles; c++) {
    const name = one ? (cycles > 1 ? 'Round robin ' + (c + 1) : 'Round robin') : cycles > 1 ? 'Prelims ' + (c + 1) : 'Prelims';
    out.push(phase(name, { groups: k, same: c > 0, byes }));
  }
  const halves = per === null ? (k === 2 && sizes && sizes.length === 2 ? -1 : 1) : per;
  if (sizes) out.push(phase('Playoffs', { sizes, parallelTop, carry: k > 1 && carry, per: halves }));
  return out;
}

// Formats read as hdwhite words them ("Two brackets of seven into playoff
// brackets of six and eight"); qb-td's own few are written the same way.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n) => WORDS[n] || String(n);
const listOf = (xs) => (xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ', and ' + xs.at(-1));
const bracketsText = (rows, playoff) => (new Set(rows).size === 1
  ? `${word(rows.length)} ${playoff ? 'playoff ' : ''}brackets of ${word(rows[0])}`
  : `${playoff ? 'playoff ' : ''}brackets of ${listOf(rows.map(playoff ? word : String))}`);
const hdText = (rows, sizes) => {
  const t = `${bracketsText(rows, false)} into ${bracketsText(sizes, true)}`;
  return t[0].toUpperCase() + t.slice(1);
};

// The Format menu for t teams: [{key, label, phases, rooms}]
const formatCache = new Map();
function formatList(t) {
  if (formatCache.has(t)) return formatCache.get(t);
  const raw = [];
  for (const f of HDWHITE[t] || []) raw.push({ key: 'hd' + f.key, text: f.text, phases: phasesFor({ ...f, carry: !f.repeat }) });
  // engine formats added on purpose after the first version (git log):
  // triple and quadruple round robins (649d459), and two places a pool
  // (c6e1736, for 22 teams: 6/6/6/4) from pools of at least 5
  for (const f of allFormats(t)) {
    if (/^rr[34]$/.test(f.key)) {
      raw.push({ key: f.key, text: f.key === 'rr3' ? 'Triple round-robin' : 'Quadruple round-robin', phases: phasesFor({ k: 1, cycles: Number(f.key[2]) }) });
      continue;
    }
    const m = /^pools(\d)x2$/.exec(f.key);
    if (!m) continue;
    const k = Number(m[1]);
    const rows = planGroups(teamsOf(t), [phase('', { groups: k })], 'snake', () => 0.5)[0].map((g) => g.members.length);
    if (Math.min(...rows) < 5) continue;
    const deepest = Math.max(...rows);
    const at = (place) => rows.filter((x) => x >= place).length;
    const sizes = [];
    for (let pl = 1; pl <= deepest; pl += 2) sizes.push(at(pl) + (pl + 1 <= deepest ? at(pl + 1) : 0));
    raw.push({ key: f.key, text: hdText(rows, sizes), phases: phasesFor({ k, sizes }) });
  }
  // build each once: its rounds and rooms, and who plays whom (to drop duplicates)
  const out = [];
  const seen = new Set();
  const rooms = Array.from({ length: 64 }, (_, i) => ({ name: 'R' + i, bucket: null }));
  for (const x of raw) {
    let s;
    try { s = buildPlan(teamsOf(t), rooms, x.phases, 'snake', 1); } catch (e) { continue; }
    const sig = s.phases.map((p) => p.rounds.length + ':' + p.rounds.flatMap((r) => r.games.map((g) => [JSON.stringify(g.a), JSON.stringify(g.b)].sort().join())).sort().join(';')).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const g = planGroups(teamsOf(t), x.phases, 'snake', () => 0.5);
    const P = x.phases;
    const preCycles = P.filter((p) => !p.sizes).length;
    const pre = (P[0].groups === 1 ? String(t) : sizesOf(g[0])) + (P[0].byes ? ' with byes' : '');
    let label;
    if (!P[P.length - 1].sizes) label = `${pre} → ${REPEAT[preCycles - 1] ? REPEAT[preCycles - 1] + ' round robin' : 'round robin'}`;
    else {
      const po = P[P.length - 1];
      const notes = [];
      if (preCycles > 1) notes.push(REPEAT[preCycles - 1] + ' round robin first');
      // crossover only says something when a pool holds pool-mates
      const mates = g[g.length - 1].some((b) => new Set(b.members.map((m) => m.from)).size < b.members.length);
      if (P[0].groups > 1) notes.push(!mates ? 'by place' : po.carry ? 'crossover' : 'repeat matches');
      if (po.parallelTop) {
        const top = g[g.length - 1].filter((b) => b.tier === 0).reduce((k, b) => k + b.members.length, 0);
        notes.splice(notes.indexOf('by place'), notes.includes('by place') ? 1 : 0, `top ${top} in two pools`);
      }
      label = `${pre} → ${sizesOf(g[g.length - 1])}${notes.length ? ', ' + notes.join(', ') : ''}`;
    }
    out.push({ key: x.key, label: `${x.text || label} · ${s.phases.reduce((n, p) => n + p.rounds.length, 0)} rounds`, phases: x.phases,
      rooms: Math.max(...s.phases.flatMap((p) => p.rounds.map((r) => r.games.length))) });
  }
  formatCache.set(t, out);
  return out;
}
// The Finals menu: [value, label, help]. finalOne (true) was the first cut
// of this choice, and reads as 'one'.
const FINAL_STYLES = [
  ['adv', 'Advantaged final if needed', 'If leader clears by two games, no final. Advantaged final if leader is up by one game, otherwise one game final.'],
  ['oneif', 'One game final if needed', 'If leader clears by two games, no final. Otherwise one game final.'],
  ['one', 'One game final', 'Guarantees final between 1st and 2nd.'],
];
const finalStyle = (plan) => (FINAL_STYLES.some(([v]) => v === plan.finalStyle) ? plan.finalStyle : plan.finalOne ? 'one' : 'adv');
// a plan for a Format menu entry (seeding and room settings carry over)
function planFor(key, t, from) {
  const f = formatList(t).find((x) => x.key === key);
  const phases = JSON.parse(JSON.stringify(f.phases));
  if (from) phases.forEach((p, i) => { const o = from.phases[Math.min(i, from.phases.length - 1)]; Object.assign(p, { share: o.share, n: o.n, mode: o.mode }); });
  // two parallel top pools only crown a champion with a final
  return { fmt: key, seeding: from ? from.seeding : 'snake', ties: from ? from.ties : 'pp20', finalTies: from ? from.finalTies : 'pp20',
    phases, finals: phases.some((p) => p.parallelTop) || !!(from && from.finals), finalStyle: from ? finalStyle(from) : 'adv' };
}
// the default: the first format that fits the rooms; with none (48 teams),
// Custom with pools of about 8
function firstPlan(t, n) {
  const f = formatList(t).find((x) => x.rooms <= n) || formatList(t)[0];
  if (f) return planFor(f.key, t);
  const k = t <= 16 ? 1 : Math.ceil(t / 8);
  return { fmt: 'custom', seeding: 'snake', ties: 'pp20', finalTies: 'pp20', finals: false, phases: [phase(k === 1 ? 'Round robin' : 'Prelims', { groups: k })] };
}
// Pool sizes for k pools of whole places after `prev`: the places split as
// evenly as can be, better places first (6 pools of 8, k = 6 → 12/12/6/6/6/6).
// A last pool of one team would have no games: it joins the pool above.
function placeSizes(prev, k) {
  const deepest = Math.max(...prev.map((g) => g.members.length));
  const at = (place) => prev.filter((g) => g.members.length >= place).length;
  let place = 1;
  const sizes = poolSizes(deepest, Math.max(1, Math.min(deepest, k))).map((n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += at(place++);
    return sum;
  });
  if (sizes.length > 1 && sizes[sizes.length - 1] === 1) sizes.push(sizes.pop() + sizes.pop());
  return sizes;
}
// a new phase: as many pools as the phase before (at least two), of whole places
const standardNext = (prev) => ({ sizes: placeSizes(prev, Math.max(2, prev.length)), per: 1 });
// numbered phase names: "Round robin" → "Round robin 1", "X 2" → "X 3"
const numbered = (name, i) => (/\s\d+$/.test(name) ? name.replace(/\d+$/, String(i)) : `${name} ${i}`);
function copyOf(P, p) {
  const src = P[p];
  if (!/\s\d+$/.test(src.name)) src.name = numbered(src.name, 1);
  const k = Number(/(\d+)$/.exec(src.name)[1]);
  return phase(numbered(src.name, k + 1), { same: true, groups: src.groups, byes: src.byes, share: src.share, n: src.n, mode: src.mode });
}
// Ties are settled in the Live Hub once they happen, so no round is kept
// for them: a plan's old ties setting is ignored
const withTies = (pl) => pl.phases.map(({ ties: _old, ...x }) => x);

// The TD's own pools after the roster changed: a team that left frees its
// place, a new team takes a freed place (a renamed team keeps its pool),
// or else the smallest pool (last in it). The order in a pool is the TD's
// seeding there, kept as it is. A split that no longer fits the pool
// sizes (a new format) starts again from the snake.
function fixHand(ph, teams, snakeHand) {
  if (!Array.isArray(ph.hand)) { ph.hand = snakeHand(ph); return; }
  const hand = ph.hand.map((g) => (Array.isArray(g) ? g.slice() : []));
  const freed = [];
  hand.forEach((g, k) => g.forEach((x) => { if (!teams.includes(x)) freed.push(k); }));
  const placed = new Set();
  hand.forEach((g, k) => { hand[k] = g.filter((x) => teams.includes(x) && !placed.has(x) && placed.add(x)); });
  for (const x of teams.filter((y) => !placed.has(y))) {
    const k = freed.length ? freed.shift() : hand.reduce((best, g, i) => (g.length < hand[best].length ? i : best), 0);
    hand[k].push(x);
  }
  const changed = JSON.stringify(hand) !== JSON.stringify(ph.hand);
  ph.hand = hand;
  if (changed) Object.assign(ph, { sizes: hand.map((g) => g.length), groups: hand.length });
  const want = snakeHand(ph).map((g) => g.length).join('/');
  if (!handOk(ph.hand, teams) || ph.hand.map((g) => g.length).join('/') !== want) {
    ph.hand = snakeHand(ph);
    Object.assign(ph, { sizes: ph.hand.map((g) => g.length), groups: ph.hand.length });
  }
}
// By hand: a card per pool, its teams in their seed order there. A team
// drags to a new seed in its pool or into another pool; a letter for each
// pool moves it too (a small menu instead past three pools, so the names
// keep their room), which also works where dragging doesn't (phones).
function handCards(hand, seedOf) {
  const L = (k) => String.fromCharCode(65 + k);
  const many = hand.length > 3;
  const full = 'A pool needs at least two teams.';
  const pickPool = (team, g, k) => (many
    ? `<select class="pkhandsel" data-handsel="${esc(team)}" aria-label="${esc(team)}'s pool" ${g.length <= 2 ? `disabled title="${full}"` : ''}>${
      hand.map((_, j) => `<option value="${j}" ${j === k ? 'selected' : ''}>${L(j)}</option>`).join('')}</select>`
    : `<span class="pkhandseg" role="group" aria-label="${esc(team)}'s pool">${hand.map((_, j) => (j === k
      ? `<button class="on" aria-pressed="true" title="In Pool ${L(j)}">${L(j)}</button>`
      : `<button data-hand="${esc(team)}" data-to="${j}" aria-pressed="false" ${g.length <= 2 ? `disabled title="${full}"` : `title="Move to Pool ${L(j)}"`}>${L(j)}</button>`)).join('')}</span>`);
  return `<div class="pkhand${many ? ' many' : ''}">${hand.map((g, k) => `<div class="pkhandcard" data-handcard="${k}" data-size="${g.length}">
    <div class="pkhandhead">Pool ${L(k)} <span class="muted">${g.length} teams</span></div>
    ${g.map((team, i) => `<div class="pkhandrow" draggable="true" data-handrow="${esc(team)}" data-pool="${k}" data-at="${i}">
      <span class="pkhandgrip" aria-hidden="true">&#8942;&#8942;</span><span class="pkhandseed" title="Roster seed ${seedOf(team) + 1}">${i + 1}</span><span class="pkhandname" title="${esc(team)}">${esc(team)}</span>
      ${pickPool(team, g, k)}</div>`).join('')}
  </div>`).join('')}</div>`;
}

// What the picker can regenerate in a saved schedule: all of it, or one phase.
const regenParts = (sched) => [['all', 'Whole schedule'], ...sched.phases.map((ph, p) => [`p${p}`, ph.name])];
const regenTarget = (v) => {
  const m = /^p(\d+)$/.exec(v);
  return m ? { phase: Number(m[1]) } : null;
};

function renderCreator(box, env) {
  if (fullBtn()) fullBtn().hidden = true; // nothing to fill the screen with yet
  const t = env.teams.length;
  const n = env.buckets.length;
  const parts = env.sched() ? regenParts(env.sched()) : [];
  if (!parts.some(([v]) => v === ui.regen)) ui.regen = 'all';
  // regenerating one phase: only its settings show
  const only = env.sched() ? regenTarget(ui.regen) : null;
  const what = ui.regen === 'all' ? 'the schedule' : parts.find(([v]) => v === ui.regen)[1];
  const back = env.sched() ? `<div class="sgnotice">Picking a new format replaces ${esc(what)} when you press Generate.
      <button id="schedback" class="small">Keep the current schedule</button></div>` : '';
  const wireBack = () => { const b = box.querySelector('#schedback'); if (b) b.onclick = () => { ui.creator = false; env.refresh(); }; };
  if (t < 2 || !n) {
    box.innerHTML = back + `<div class="muted">${t < 2 ? 'Please add at least two teams on the Roster step first.' : 'Please add rooms on the Rooms step first.'}</div>`;
    wireBack();
    return;
  }
  if (!ui.plan || ui.plan.teams !== t) {
    const o = (env.sched() || {}).options || {};
    ui.plan = o.plan && o.plan.fmt && (o.plan.fmt === 'custom' || formatList(t).some((f) => f.key === o.plan.fmt))
      ? JSON.parse(JSON.stringify(o.plan)) : firstPlan(t, n);
    ui.plan.teams = t;
  }
  const plan = ui.plan;
  const P = plan.phases;
  // By hand: the TD's own pools, sorted by seed, starting from the snake
  const seedOf = (team) => env.teams.indexOf(team);
  const snakeHand = (ph) => planGroups(env.teams, [{ ...ph, hand: undefined }], 'snake', () => 0.5)[0]
    .map((g) => g.members.map((m) => m.id));
  if (plan.seeding === 'hand') fixHand(P[0], env.teams, snakeHand);
  const rooms = roomList(env, n);
  const pv = planPreview(env.teams, rooms, withTies(plan), plan.seeding, 1);
  const groupsBy = planGroups(env.teams, P, plan.seeding, () => 0.5);
  const again = () => renderCreator(box, env);

  const menu = (attr, list, on) => `<select ${attr}>${list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(on) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const nr = (p) => (pv.rounds[p] ? `<span class="pkrounds">${pv.rounds[p]} ${pv.rounds[p] === 1 ? 'round' : 'rounds'}</span>` : '');
  const lastRooms = (k) => andList(rooms.map((r) => r.name).slice(n - k));
  // who goes where, with runs of places as ranges: "A1–A4", "Round robin 1st–24th"
  const who = (groups) => `<span class="pkhelp">${groups.map((g) => {
    const parts = [];
    const shown = new Set();
    for (const m of g.members) {
      if (shown.has(m)) continue;
      const run = [m];
      if (m.place && !String(m.from).startsWith('compared')) {
        for (const x of g.members.filter((y) => y.from === m.from && y.place).sort((a, b) => a.place - b.place)) {
          if (x !== m && x.place === run[run.length - 1].place + 1) run.push(x);
        }
      }
      if (run.length >= 3) {
        run.forEach((x) => shown.add(x));
        parts.push(/^[A-Z]$/.test(m.from) ? `${m.from}${run[0].place}–${m.from}${run[run.length - 1].place}`
          : `${(m.slot.label || '').replace(/^\d+\w\w in /, '').replace(/ \d+\w\w$/, '')} ${ORDN(run[0].place)}–${ORDN(run[run.length - 1].place)}`);
      } else { shown.add(m); parts.push(m.slot.label || m.slot.team); }
    }
    return `${esc(g.name)}: ${esc(parts.join(', '))}`;
  }).join(' · ')}</span>`;
  const warn = (list) => (list.length ? `<span></span><span class="pkwarn">${list.map((x) => `<span>${esc(x)}</span>`).join('')}</span>` : '');
  const sizesBox = (attr, sizes) => `<input class="pksizes" value="${sizes.join('/')}" ${attr} aria-label="Pool sizes">`;
  // "[2] pools of [7/6]": the count splits evenly; the sizes can be edited
  const poolsRow = (countAttr, sizesAttr, sizes, max) => `<span class="pkl">Pools</span><span class="pkrow">
    <input type="number" class="pkcount" min="1" max="${max}" value="${sizes.length}" ${countAttr} aria-label="Number of pools">
    <span class="muted">${sizes.length === 1 ? 'pool of' : 'pools of'}</span> ${sizesBox(sizesAttr, sizes)}</span>`;
  const roomRows = (p, out, what) => {
    const ph = P[p];
    if (groupsBy[p].length > 1 && ph.kind === 'pools') {
      out.push(`<span class="pkl">Rooms</span>
      <span><label class="pkcheck"><input type="checkbox" data-share="${p}" ${ph.share ? 'checked' : ''}> Share rooms between ${what}</label>
        ${ph.share ? `<span class="pkshared"><input type="number" min="1" max="${n}" value="${ph.n}" data-n="${p}"> of ${n} rooms</span>
          <span class="pkhelp">${esc(lastRooms(Math.min(ph.n, n)))} take games from all ${what}, rotating each round.</span>` : ''}</span>`);
    }
    if (ph.kind === 'pools') out.push(`<span class="pkl">Room changes</span><span>${menu(`data-mode="${p}"`, MODES, ph.mode)}</span>`);
  };

  // the first phase: pool sizes ("6/6"; one number is a single round robin)
  const first = () => {
    const groups = groupsBy[0];
    const out = [poolsRow('data-pcount', 'data-psizes', P[0].sizes || groups.map((g) => g.members.length), Math.floor(t / 2))];
    if (groups.length > 1) out.push(`<span class="pkl">Seeding</span><span>${menu('data-seed', [['snake', 'Snake by roster order'], ['random', 'Random'], ['hand', 'By hand']], plan.seeding)}</span>`);
    if (groups.length > 1 && plan.seeding === 'hand') out.push(`<span class="pkl">Teams</span><span>${handCards(P[0].hand, seedOf)}
      <span class="pkhelp">Teams start where the snake put them. ${P[0].hand.length > 3 ? 'Pick a pool from a team’s menu' : 'Pick a letter'} or drag the team to move it to another pool. Drag a team up or down to set its seed within its pool.</span></span>`);
    roomRows(0, out, 'pools');
    return `<div class="pkgrid">${out.join('')}</div>`;
  };
  // a later phase: pools by finish, the same pools again, or elimination
  const later = (p) => {
    const ph = P[p];
    const groups = groupsBy[p];
    const out = [];
    const prev = groupsBy[p - 1];
    const prevName = P[p - 1].name.toLowerCase();
    const type = ph.same ? 'same' : ph.kind === 'pools' ? 'brackets' : ph.kind;
    out.push(`<span class="pkl">Type</span><span>${menu(`data-type="${p}"`, TYPES, type)}</span>`);
    const warnings = [];
    if (type === 'brackets') {
      const sizes = ph.sizes || groups.map((g) => g.members.length);
      const playing = prev.reduce((k, g) => k + g.members.length, 0);
      const sum = sizes.reduce((a, b) => a + b, 0);
      out.push(poolsRow(`data-count="${p}"`, `data-sizes="${p}"`, sizes, Math.max(1, Math.floor(playing / 2))));
      if (sum > playing) warnings.push(`The pools hold ${sum} teams, but only ${playing} play on.`);
      else if (sum < playing) out.push(`<span></span><span class="pkhelp">The other ${playing - sum} teams are done after ${esc(prevName)}.</span>`);
      if (groups.some((g) => new Set(g.members.map((m) => m.from)).size < g.members.length)) {
        out.push(`<span class="pkl">Crossover</span><label class="pkcheck"><input type="checkbox" data-carry="${p}" ${ph.carry ? 'checked' : ''}> Teams from the same pool don’t play again</label>`);
      }
      out.push(`<span></span>${who(groups)}`);
      if (groups.split && groups.split.length) {
        const pl = andList(groups.split.map((x) => ORDN(x)));
        out.push(`<span></span><span class="pkhelp pknote">${groups.split.length === 1 ? `Only some ${pl}-place teams` : `Only some teams of ${pl} place`} go up. They are compared by winning percentage, then points per 20 tossups heard.</span>`);
      }
    } else if (type === 'single' || type === 'double') {
      const full = Math.max(...prev.map((g) => g.members.length));
      out.push(`<span class="pkl">Who plays</span><span class="pkrow">The top <input type="number" class="pkcount" min="1" max="${full}" value="${ph.top || full}" data-top="${p}"> <span class="muted">from each pool</span></span>`);
      if (type === 'double') out.push(`<span></span><label class="pkcheck"><input type="checkbox" data-reset="${p}" ${ph.reset ? 'checked' : ''}> A second final if the unbeaten team loses</label>`);
    }
    // how ties for a place go: the tournament's tie order, the editor's line between phases
    out.push(`<span class="pkl">Ties for a place</span><span>${tieChips(env)}</span>`);
    for (const c of rebracketChecks(groupsBy, P, p)) if (!c.ok) warnings.push(c.text);
    out.push(warn(warnings));
    roomRows(p, out, 'pools');
    return `<div class="pkgrid">${out.join('')}</div>`;
  };

  const canCopy = (p) => P[p].kind === 'pools' && groupsBy[p].some((g) => g.members.length > 1);
  const headOf = (p) => `<h3 class="pksec"><input class="pkname" data-name="${p}" size="${Math.max(6, P[p].name.length + 1)}" value="${esc(P[p].name)}" aria-label="Phase name"> ${nr(p)}
    <span class="pktools">${only ? '' : `${canCopy(p) ? `<button class="linkbtn" data-copy="${p}">Copy this phase</button>` : ''}${p > 0 ? `<button class="linkbtn" data-del="${p}">Remove</button>` : ''}`}</span></h3>`;
  const canAdd = P[P.length - 1].kind === 'pools' && groupsBy[P.length - 1].some((g) => g.members.length > 1);
  // Finals: 1st against 2nd of the top pool (or the two top pools' winners)
  const finals = (() => {
    if (P.length < 2 && groupsBy[0].length > 1) return null;
    return addFinals({ phases: [{ rounds: [{ round: 0 }] }], brackets: [] }, groupsBy, P);
  })();
  const finalsBox = finals ? `<h3 class="pksec">Finals</h3><div class="pkgrid">
      <span></span><label class="pkcheck"><input type="checkbox" data-finals ${plan.finals ? 'checked' : ''}> Enable finals sequence if needed</label>
      ${plan.finals && !finals.parallel ? `<span class="pkl">Final</span><span><select data-finalstyle aria-label="Final">
        ${FINAL_STYLES.map(([v, label]) => `<option value="${v}" ${finalStyle(plan) === v ? 'selected' : ''}>${label}</option>`).join('')}</select></span>` : ''}
      ${plan.finals ? `<span></span><span class="pkhelp">${finals.parallel ? 'One game between the two top pools’ winners.'
        : FINAL_STYLES.find(([v]) => v === finalStyle(plan))[2]}</span>` : ''}
    </div>` : '';
  const fin = plan.finals && finals ? (finals.parallel || finalStyle(plan) !== 'adv' ? 1 : 2) : 0;
  // a final that is always played is "plus a final"; one that may not be, "plus up to"
  const always = plan.finals && finals && (finals.parallel || finalStyle(plan) === 'one');
  const total = pv.ok ? pv.rounds.reduce((a, b) => a + b, 0) : 0;
  const extra = [fin ? (fin === 1 ? 'a final' : '2 for finals') : ''].filter(Boolean);
  const optOf = (f) => `<option value="${esc(f.key)}" ${f.key === plan.fmt ? 'selected' : ''}${f.rooms > n ? ' disabled' : ''}>${esc(f.label)}${f.rooms > n ? ` (needs ${f.rooms} rooms)` : ''}</option>`;

  const shown = (p) => !only || only.phase === p;
  box.innerHTML = `${back}
    <div class="pkpick">
      <div class="pkgrid">
        ${parts.length ? `<span class="pkl">Regenerate</span><span><select data-regen aria-label="Regenerate">${parts.map(([v, l]) =>
          `<option value="${esc(v)}" ${v === ui.regen ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></span>` : ''}
        <span class="pkl">Rooms</span><span class="pkrow"><span>${n} rooms for ${t} teams</span><span class="muted">from the Rooms step</span></span>
        ${only ? '' : `<span class="pkl">Format</span><span><select data-fmt>${formatList(t).map(optOf).join('')}<option value="custom" ${plan.fmt === 'custom' ? 'selected' : ''}>Custom</option></select></span>`}
      </div>
      ${P.map((_, p) => (shown(p) ? headOf(p) + (p === 0 ? first() : later(p)) : '')).join('')}
      ${canAdd && !only ? '<div><button class="linkbtn pkadd" data-add>Add another phase</button></div>' : ''}
      ${only ? '' : finalsBox}
      <div class="sgpreview pktotalbox">${pv.ok && only
        ? `<span class="pktotal"><b>${pv.rounds[only.phase] || 0} rounds</b></span>`
        : pv.ok
        ? `<span class="pktotal"><b>${total} rounds</b>${extra.length ? ` <span>plus ${always ? '' : 'up to '}${extra.join(' and ')}</span>` : ''}</span><span class="muted">${esc(pv.text.split(' · ').slice(1).join(' · '))}</span>`
        : `<span class="pkwarn"><span>${esc(pv.text)}</span></span>`}</div>
      <div class="row pkfoot"><button id="schedgen" class="primary" ${pv.ok ? '' : 'disabled'}>Generate</button>
        <span class="sgseed">Seed <b>${ui.opts.seed}</b> <button id="optreroll" class="small">Reroll</button></span></div>
    </div>`;
  wireBack();
  wireTieChips(box, env, again);

  // each change redraws; a change to the structure turns Format to Custom
  // (seeding, ties and rooms don't)
  const each = (attr, ev, fn, shape = true) => box.querySelectorAll(`[${attr}]`).forEach((el) => {
    el[ev] = () => {
      if (fn(el, Number(el.getAttribute(attr))) !== false && shape) { plan.fmt = 'custom'; ui.handBase = null; }
      again();
    };
  });
  each('data-fmt', 'onchange', (el) => {
    if (el.value === 'custom') { plan.fmt = 'custom'; return; }
    ui.plan = { ...planFor(el.value, t, plan), teams: t };
    ui.handBase = null;
    // the TD's pools stay when the new format's pools are the same sizes
    if (plan.seeding === 'hand' && P[0].hand) ui.plan.phases[0].hand = P[0].hand;
  }, false);
  // new pool sizes put a hand-picked split back to the snake: ask first
  const handReset = () => plan.seeding !== 'hand' || !P[0].hand
    || JSON.stringify(P[0].hand) === JSON.stringify(snakeHand(P[0]))
    || confirm('Changing the pools puts the teams back where the snake puts them. Do you want to continue?');
  const handAfter = () => { if (plan.seeding === 'hand') P[0].hand = snakeHand(P[0]); };
  // the prelims changed: later phases go back to the default split
  const resplit = () => {
    for (let i = 1; i < P.length; i++) {
      const x = P[i];
      if (x.same || x.kind !== 'pools') continue;
      Object.assign(x, standardNext(planGroups(env.teams, P.slice(0, i), plan.seeding, () => 0.5)[i - 1]));
    }
  };
  each('data-pcount', 'onchange', (el) => {
    const k = Math.max(1, Math.min(Math.floor(t / 2), Number(el.value) || 1));
    if (!handReset()) return false;
    Object.assign(P[0], { sizes: poolSizes(t, k), groups: k });
    handAfter();
    if (P[0].name === 'Round robin' && k > 1) P[0].name = 'Prelims';
    if (k === 1 && P.length === 1) P[0].name = 'Round robin';
    resplit();
  });
  each('data-psizes', 'onchange', (el) => {
    const sizes = el.value.split(/[^\d]+/).map(Number).filter((x) => x > 0);
    if (!sizes.length) return;
    if (!handReset()) return false;
    Object.assign(P[0], { sizes, groups: sizes.length });
    handAfter();
    resplit();
  });
  each('data-count', 'onchange', (el, p) => { P[p].sizes = placeSizes(groupsBy[p - 1], Math.max(1, Number(el.value) || 1)); P[p].per = 1; });
  each('data-sizes', 'onchange', (el, p) => {
    const sizes = el.value.split(/[^\d]+/).map(Number).filter((x) => x > 0);
    P[p].sizes = sizes.length ? sizes : null;
  });
  each('data-type', 'onchange', (el, p) => {
    const v = el.value;
    Object.assign(P[p], { same: v === 'same', kind: v === 'single' || v === 'double' ? v : 'pools', sizes: null, top: 0 });
    if (v === 'brackets') Object.assign(P[p], standardNext(groupsBy[p - 1]));
    // elimination usually takes the top teams: start on the top 2 of each pool
    if (v === 'single' || v === 'double') { P[p].top = Math.min(2, Math.ceil(t / P[p - 1].groups)); P.splice(p + 1); }
  });
  each('data-seed', 'onchange', (el) => {
    plan.seeding = el.value;
    if (el.value === 'hand') P[0].hand = snakeHand(P[0]); else delete P[0].hand;
  }, false);
  // a letter (or the menu) moves a team to the end of that pool; the pool
  // sizes follow
  const moveTeam = (team, to, at = Infinity) => {
    const from = P[0].hand.findIndex((g) => g.includes(team));
    if (from < 0 || from === to || P[0].hand[from].length <= 2) return;
    // uneven pools are Custom; the format and its later phases come back
    // when the pools are its sizes again (a swap is two moves)
    const sizesOf0 = (ph) => ph.hand.map((g) => g.length).join('/');
    if (plan.fmt !== 'custom') ui.handBase = { fmt: plan.fmt, phases: JSON.parse(JSON.stringify(P)) };
    P[0].hand[from] = P[0].hand[from].filter((x) => x !== team);
    P[0].hand[to].splice(at, 0, team);
    const sizes = P[0].hand.map((g) => g.length);
    const base = ui.handBase;
    if (base && sizes.join('/') === sizesOf0(base.phases[0])) {
      const hand = P[0].hand;
      P.splice(0, P.length, ...JSON.parse(JSON.stringify(base.phases)));
      P[0].hand = hand;
      plan.fmt = base.fmt;
      ui.handBase = null;
    } else {
      plan.fmt = 'custom';
      Object.assign(P[0], { sizes, groups: sizes.length });
      resplit();
    }
    again();
  };
  box.querySelectorAll('[data-hand]').forEach((el) => { el.onclick = () => moveTeam(el.dataset.hand, Number(el.dataset.to)); });
  box.querySelectorAll('[data-handsel]').forEach((el) => { el.onchange = () => moveTeam(el.dataset.handsel, Number(el.value)); });
  // dragging: onto a team, before or after it (whichever half the pointer
  // is in); onto a card's empty space, last. In its own pool that reseeds
  // the team; in another it moves there, unless its pool would drop below two
  const handBox = box.querySelector('.pkhand');
  if (handBox) {
    let dragged = null; // {team, pool}
    const clearMarks = () => handBox.querySelectorAll('.drop-before, .drop-after, .drop-end')
      .forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-end'));
    const dropAt = (ev) => {
      const card = ev.target.closest && ev.target.closest('[data-handcard]');
      if (!dragged || !card) return null;
      const to = Number(card.dataset.handcard);
      if (to !== dragged.pool && Number(handBox.querySelector(`[data-handcard="${dragged.pool}"]`).dataset.size) <= 2) return null;
      const row = ev.target.closest('[data-handrow]');
      if (!row) return { to, at: Infinity, el: card, cls: 'drop-end' };
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      return { to, at: Number(row.dataset.at) + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before' };
    };
    handBox.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest && ev.target.closest('[data-handrow]');
      if (!row) return;
      dragged = { team: row.dataset.handrow, pool: Number(row.dataset.pool) };
      row.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', dragged.team);
    });
    handBox.addEventListener('dragover', (ev) => {
      const d = dropAt(ev);
      clearMarks();
      if (!d) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      d.el.classList.add(d.cls);
    });
    handBox.addEventListener('dragend', () => { clearMarks(); dragged = null; handBox.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); });
    handBox.addEventListener('drop', (ev) => {
      const d = dropAt(ev);
      const drag = dragged;
      clearMarks();
      dragged = null;
      if (!d) return;
      ev.preventDefault();
      if (d.to !== drag.pool) { moveTeam(drag.team, d.to, d.at); return; }
      const g = P[0].hand[d.to];
      const i = g.indexOf(drag.team);
      const at = Math.min(d.at, g.length) - (i < d.at ? 1 : 0);
      if (at === i) { again(); return; }
      g.splice(i, 1);
      g.splice(at, 0, drag.team);
      again();
    });
  }
  each('data-finals', 'onchange', (el) => { plan.finals = el.checked; }, false);
  each('data-finalstyle', 'onchange', (el) => { plan.finalStyle = el.value; delete plan.finalOne; }, false);
  each('data-top', 'onchange', (el, p) => { P[p].top = Math.max(1, Number(el.value) || 1); });
  each('data-carry', 'onchange', (el, p) => { P[p].carry = el.checked; });
  each('data-reset', 'onchange', (el, p) => { P[p].reset = el.checked; });
  each('data-share', 'onchange', (el, p) => { P[p].share = el.checked; P[p].n = Math.min(P[p].n || groupsBy[p].length, n); }, false);
  each('data-n', 'onchange', (el, p) => { P[p].n = Math.max(1, Math.min(n, Number(el.value) || 1)); }, false);
  each('data-mode', 'onchange', (el, p) => { P[p].mode = el.value; }, false);
  each('data-name', 'onchange', (el, p) => { P[p].name = el.value.trim() || P[p].name; }, false);
  each('data-copy', 'onclick', (el, p) => { P.splice(p + 1, 0, copyOf(P, p)); });
  each('data-del', 'onclick', (el, p) => { P.splice(p, 1); });
  each('data-add', 'onclick', () => {
    const prev = groupsBy[P.length - 1];
    // after tiered pools a re-cut would give the same pools back: play them again
    if (new Set(prev.map((g) => g.tier || 0)).size > 1) { P.push(phase('Phase ' + (P.length + 1), { same: true, mode: P[P.length - 1].mode })); return; }
    P.push(phase(P.length > 1 ? 'Phase ' + (P.length + 1) : 'Playoffs', { mode: P[P.length - 1].mode, carry: P[0].groups > 1, ...standardNext(prev) }));
  });
  const reroll = box.querySelector('#optreroll');
  reroll.onclick = () => { ui.opts.seed = 1 + Math.floor(Math.random() * 9999); again(); };
  const rg = box.querySelector('[data-regen]');
  if (rg) rg.onchange = () => { ui.regen = rg.value; again(); };
  box.querySelector('#schedgen').onclick = async () => {
    const label = plan.fmt === 'custom' ? 'custom format' : (formatList(t).find((f) => f.key === plan.fmt) || {}).label;
    if (env.sched() && !confirm(`Replace ${ui.regen === 'all' ? 'the current schedule' : what} with ${plan.fmt === 'custom' ? 'a custom format' : label}?`)) return;
    let s;
    try {
      s = buildPlan(env.teams, roomList(env, n), withTies(plan), plan.seeding, ui.opts.seed);
      if (plan.finals) addFinals(s, planGroups(env.teams, P, plan.seeding, () => 0.5), P, undefined, { adv: 'advantaged', oneif: 'oneif', one: 'one' }[finalStyle(plan)]);
      tagBrackets(s);
      s.format = plan.fmt;
      const saved = JSON.parse(JSON.stringify(plan));
      delete saved.teams;
      s.options = { seed: ui.opts.seed, plan: saved };
      // one phase: spliced into the saved schedule, the rest kept
      const part = env.sched() && regenTarget(ui.regen);
      if (part) {
        const cur = JSON.parse(JSON.stringify(env.sched()));
        tagBrackets(cur);
        s = { ...regenPart(cur, s, part), options: s.options };
      }
    } catch (e) { env.say(e.message, true); return; }
    ui.regen = 'all';
    // a generated schedule goes live right away — Save is for edits after
    const run = busy(box.querySelector('#schedgen'), { label: 'Generating' });
    env.setSched(s);
    ui.creator = false;
    resetEditor();
    try {
      await env.save(s);
      env.setDirty(false);
      ui.baseline = { obj: s, json: JSON.stringify(s) };
      env.say('Schedule saved');
      // playoff slots whose pools have finished fill at once, as they do on their own
      if (env.refill) {
        await env.refill();
        ui.baseline = { obj: env.sched(), json: JSON.stringify(env.sched()) };
      }
    } catch (e) {
      env.setDirty(true);
      env.say('Not saved: ' + e.message, true);
    }
    run.end();
    env.refresh();
  };
}

const andList = (xs) => (xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ', and ' + xs.at(-1));

function roomList(env, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = env.buckets[i];
    out.push(b ? { name: b.room_name, bucket: b.id } : { name: 'Room ' + (i + 1), bucket: null });
  }
  return out;
}

function resetEditor() {
  ui.sel = null;
  ui.mode = null;
  ui.renaming = null;
  ui.menu = null;
  ui.probsOpen = false;
  ui.past = [];
  ui.future = [];
  ui.filter = '';
  ui.closed = new Set();
  ui.note = '';
}

// What Finals may rank on (schedule.finalsRankBy, finals.js finalsFill)
const RANK_BY = [['bracket', 'Playoff games'], ['carry', 'Playoff games + prelim games between them'], ['all', 'All games']];

// A click away from the popover (or an open menu) closes it; the editor
// on screen sets what that means (renderEditor)
let closeOutside = null;
if (typeof document !== 'undefined') document.addEventListener('click', (ev) => { if (closeOutside) closeOutside(ev); });

/* ================= editor ================= */

function renderEditor(box, env) {
  const s = env.sched();
  const phases = s.phases;
  const brackets = bracketRooms(s);
  if (ui.filter && !brackets.some((b) => b.key === ui.filter)) ui.filter = '';
  if (ui.view !== 'teams') ui.view = 'grid';
  const again = () => renderEditor(box, env);
  // every edit: snapshot for Undo, mutate, mark dirty, redraw; the popover closes
  const edit = (note, fn) => {
    ui.past.push(JSON.stringify(s));
    if (ui.past.length > 100) ui.past.shift();
    ui.future = [];
    fn(s);
    ui.note = note;
    ui.mode = null;
    ui.sel = null;
    ui.renaming = null;
    ui.menu = null;
    env.setDirty(JSON.stringify(s) !== ui.baseline.json);
    again();
  };
  const restore = (json, note) => {
    const next = JSON.parse(json);
    env.setSched(next);
    ui.baseline.obj = ui.baseline.obj === s ? next : ui.baseline.obj;
    env.setDirty(json !== ui.baseline.json);
    ui.note = note;
    ui.sel = null;
    ui.mode = null;
    renderEditor(box, env);
  };

  /* -- facts the grid, checks and popover share -- */
  const roundNo = phases.map((ph) => ph.rounds.map((r) => r.round));
  const checks = scheduleChecks(s);
  // a team the roster no longer has (renamed or dropped after the
  // schedule was made): each gets Replace with… and Remove right here
  const rosterWarn = validateSchedule(s, env.teams).filter((w) => /^not on roster: /.test(w))
    .map((w) => ({ sev: 1, kind: 'roster', team: w.slice('not on roster: '.length), text: w[0].toUpperCase() + w.slice(1) }));
  const placed = new Set();
  for (const ph of phases) for (const r of ph.rounds) {
    for (const g of r.games) for (const x of [g.a, g.b]) if (x && x.team) placed.add(x.team);
    for (const x of r.byes) if (x && x.team) placed.add(x.team);
  }
  const unplaced = env.teams.filter((x) => !placed.has(x));
  const warn = [];
  const norm = (x) => String(x || '').trim().toLowerCase();
  for (const b of env.buckets) {
    if (!s.rooms.some((r) => r.bucket === b.id || norm(r.name) === norm(b.room_name))) {
      warn.push({ sev: 1, kind: 'room', text: 'Room not on the schedule: ' + b.room_name });
    }
  }
  const allChecks = [...rosterWarn, ...checks, ...warn];
  const bad = new Map(); // refKey -> 'twice' | 'again'
  for (const c of checks) {
    if (c.kind === 'twice') {
      const r = phases[c.p].rounds[c.r];
      for (const g of r.games) for (const side of ['a', 'b']) if (slotText(g[side]) === c.key) bad.set(refKey({ p: c.p, r: c.r, room: g.room, side }), 'twice');
      r.byes.forEach((b, i) => { if (slotText(b) === c.key) bad.set(refKey({ p: c.p, r: c.r, bye: i }), 'twice'); });
    }
  }
  const againCells = new Set(checks.filter((c) => c.kind === 'again').map((c) => cellKey(c)));
  // the games a problem sits in: outlined, with a mark
  const flagCells = new Set(checks.filter((c) => Number.isInteger(c.room)).map((c) => cellKey(c)));
  const bracketName = (k) => (brackets.find((b) => b.key === k) || {}).name || '';
  const colorOf = new Map();
  phases.forEach((_, p) => brackets.filter((b) => b.phase === p).forEach((b, i) => colorOf.set(b.key + '@' + p, i % COLORS)));

  // pool trades: open until the first prelim game comes in
  const pooled = Object.keys(s.pools || {}).length > 0;
  const locked = tradesLocked(s, env.played ? env.played() : new Set());
  const trade = (x, y) => {
    const px = poolOf(s, x);
    const py = poolOf(s, y);
    edit(`Traded pools: ${x} to Pool ${py}, ${y} to Pool ${px}`, (ss) => tradePools(ss, x, y));
  };

  const sel = ui.sel;
  const isSel = (o) => sel && Object.keys(o).every((k) => sel[k] === o[k]);
  const nRounds = phases.reduce((n, ph) => n + ph.rounds.length, 0);
  // the format's name: the picker's Format menu label, Custom, or (a
  // schedule from before the picker) the engine format's name
  const fmtName = s.options && s.options.plan
    ? (s.format === 'custom' ? 'Custom' : ((formatList(env.teams.length).find((f) => f.key === s.format) || {}).label || '').replace(/ · \d+ rounds$/, ''))
    : (allFormats(env.teams.length).find((f) => f.key === s.format) || {}).name;
  const unsaved = env.dirty();


  /* -- between two phases: how ties for a place go, and what Finals rank on -- */
  // (a filled Final's slots still say where they came from)
  const srcs = phases.some((ph) => ph.kind === 'final') ? finalsSources(s, { filled: true }) : [];
  const rankDefault = srcs.some((x) => x.carry) ? 'carry' : 'bracket';
  const fromPlaces = (ph) => ph.rounds.some((r) => [...r.games.flatMap((g) => [g.a, g.b]), ...r.byes].some((x) => x && (x.label || x.from)));
  const cutHtml = (p) => {
    const ph = phases[p];
    if (!p || ph.kind === 'tiebreak' || !fromPlaces(ph)) return '';
    const prev = phases.slice(0, p).reverse().find((x) => x.kind !== 'tiebreak');
    if (!prev) return '';
    if (ph.kind === 'final' && srcs.some((x) => x.phase > 0)) {
      const on = RANK_BY.some(([k]) => k === s.finalsRankBy) ? s.finalsRankBy : rankDefault;
      return `<div class="sgcx two"><div><b>${esc(prev.name)} → ${esc(ph.name)}</b>
        <label class="sgcxl">Ranked by <select data-rankby aria-label="Ranked by">${RANK_BY.map(([k, l]) => `<option value="${k}"${k === on ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
        <div><span class="sgcxl">Ties</span>${tieChips(env)}</div></div>`;
    }
    return `<div class="sgcx"><span class="sgcxl">${esc(prev.name)} → ${esc(ph.name)} ties</span>${tieChips(env)}</div>`;
  };

  /* -- the grid, one section per phase -- */
  const w = 122;
  const gridHtml = phases.map((ph, p) => {
    const only = ui.filter ? [ui.filter] : null;
    const lanes = phaseLanes(s, p, only);
    if (only && !lanes.length) return '';
    const cols = lanes.flatMap((l) => l.rooms);
    if (!cols.length && !only) lanes.push({ key: '', name: 'Rooms', rooms: s.rooms.map((_, i) => i) });
    const colList = lanes.flatMap((l) => l.rooms);
    const open = !ui.closed.has(p);
    const first = roundNo[p][0];
    const last = roundNo[p][roundNo[p].length - 1];
    // a lane the TD dragged keeps its own width (gridTracks); the rest take w
    const byeW = 96;
    const tmpl = `${LEAD}px ${lanes.flatMap((l) => l.rooms.map(() => (ui.colW[l.key + '@' + p] || w) + 'px')).join(' ')} ${ui.byeW || byeW}px`;
    const grip = (id, n) => `<span class="sgresize" data-resize="${esc(id)}" data-n="${n}" title="Drag to change the width. Double-click to reset it."></span>`;
    return `
    <section class="sgphase">${cutHtml(p)}
      <button class="sgphasehead" data-phase="${p}"><span class="caret">${open ? '▾' : '▸'}</span>
        <b>${esc(ph.name)}</b><span class="muted">${ph.rounds.length ? (first === last ? `round ${first}` : `rounds ${first}–${last}`) : 'no rounds'}${
        (ph.meet || 1) > 1 && ph.kind !== 'final' ? ` · pairs meet ${ph.meet} times` : ''}${ph.kind === 'tiebreak' ? ' · if needed' : ''}</span></button>
      ${open ? `
      <div class="sggrid" style="grid-template-columns:${tmpl}" data-col="${w}" data-auto="${w}" data-bye="${byeW}"
        data-lanes="${esc(lanes.map((l) => l.key + '@' + p + ':' + l.rooms.length).join(','))}">
        <div class="sgcorner"></div>
        ${lanes.map((l) => `<div class="sglane lane-${colorOf.get(l.key + '@' + p) ?? 'x'}${l.key ? ' named' : ''}${isSel({ kind: 'lane', key: l.key, p }) ? ' on' : ''}" style="grid-column:span ${l.rooms.length}"${
          l.key ? ` data-lanehd="${esc(l.key)}@${p}"` : ''}><i></i>${esc(l.name)}${grip(l.key + '@' + p, l.rooms.length)}</div>`).join('')}
        <div class="sglane sglane-byes">Byes${grip('bye', 1)}</div>
        <div class="sgcorner sgcorner2"></div>
        ${colList.map((room) => `<button class="sgroom${isSel({ kind: 'room', room, p }) ? ' on' : ''}" data-room="${room}" data-roomp="${p}" title=""${esc((s.rooms[room] || {}).name || '')}">${esc((s.rooms[room] || {}).name || 'Room ' + (room + 1))}</button>`).join('')}
        <div class="sgroom sgroom-byes"></div>
        ${ph.rounds.map((round, r) => `
          <div class="sgrnd${sel && sel.kind === 'round' && sel.p === p && sel.r === r ? ' on' : ''}" data-rnd="${p}.${r}" role="button" tabindex="0" title="Round ${round.round}"><span>${round.round}</span></div>
          ${colList.map((room) => {
            const g = round.games.find((x) => x.room === room);
            const cell = { p, r, room };
            const csel = isSel({ kind: 'game', ...cell }) || isSel({ kind: 'empty', ...cell });
            if (!g || (!g.a && !g.b)) {
              return `<div class="sgcell empty${csel ? ' on' : ''}${ui.mode === 'moveGame' ? ' target' : ''}" data-cell='${JSON.stringify(cell)}' data-empty="1">
                <button class="sgadd" data-emptycell='${JSON.stringify(cell)}' aria-label="Empty room: add or move a game here">${ui.mode === 'moveGame' ? '+' : ''}</button></div>`;
            }
            const off = g.bracket && lanes.length && !lanes.some((l) => l.key === g.bracket && l.rooms.includes(room));
            // in the Shared rooms lane each game wears its bracket's color;
            // a bracket chip picked above fades the others' games there
            const sharedLane = lanes.some((l) => l.shared && l.rooms.includes(room));
            const tint = off && sharedLane && colorOf.has(g.bracket + '@' + p) ? ` mx lane-${colorOf.get(g.bracket + '@' + p)}` : '';
            const dim = sharedLane && ui.filter && g.bracket !== ui.filter ? ' dim' : '';
            const flag = flagCells.has(cellKey(cell));
            return `<div class="sgcell${csel ? ' on' : ''}${againCells.has(cellKey(cell)) ? ' again' : ''}${flag ? ' flag' : ''}${ui.mode === 'moveGame' ? ' target' : ''}${tint}${dim}" draggable="true" data-cell='${JSON.stringify(cell)}'>
              ${flag ? '<span class="sgbadge" aria-hidden="true">!</span>' : ''}<button class="sgh" data-gh='${JSON.stringify(cell)}' title="Move or swap this whole game (or drag the card)" aria-label="Game options">&#8943;</button>
              ${g.ifNeeded ? `<span class="sgtag sgifneeded" title="Played ${esc(typeof g.ifNeeded === 'string' ? g.ifNeeded : 'if needed')}">If needed</span>` : ''}
              ${off ? `<span class="sgtag" title="${esc(bracketName(g.bracket))}">${esc(bracketName(g.bracket))}</span>` : ''}
              ${['a', 'b'].map((side) => {
                const v = g[side];
                const ref = { p, r, room, side };
                const k = refKey(ref);
                return `<button class="sgslot${!v ? ' none' : v.label ? ' ph' : ''}${bad.get(k) ? ' bad' : ''}${isSel({ kind: 'slot', ...ref }) ? ' on' : ''}"
                  draggable="${v ? 'true' : 'false'}" data-ref='${JSON.stringify(ref)}'>${v ? esc(slotShow(v)) : 'empty'}</button>`;
              }).join('')}
            </div>`;
          }).join('')}
          <div class="sgbyes" data-byes="${p}.${r}">${round.byes.map((v, i) => {
            const ref = { p, r, bye: i };
            return `<button class="sgslot bye${bad.get(refKey(ref)) ? ' bad' : ''}${isSel({ kind: 'slot', ...ref }) ? ' on' : ''}" draggable="true" data-ref='${JSON.stringify(ref)}'>${esc(slotShow(v))}</button>`;
          }).join('')}</div>`).join('')}
      </div>` : ''}
    </section>`;
  }).join('');


  /* -- by team -- */
  const flat = [];
  phases.forEach((ph, p) => ph.rounds.forEach((round, r) => flat.push({ p, r, round })));
  const groups = s.pools && Object.keys(s.pools).length
    ? Object.entries(s.pools).map(([k, m]) => ({ name: 'Pool ' + k, key: k, teams: m }))
    : [{ name: 'Teams', key: '', teams: env.teams }];
  const teamHtml = `
    <div class="sgteams" style="grid-template-columns:140px repeat(${flat.length}, 92px)">
      <div class="sgcorner">Team</div>
      ${flat.map((x) => `<div class="sgthead${x.p ? ' later' : ''}">Rd ${x.round.round}</div>`).join('')}
      ${groups.filter((g) => !ui.filter || !brackets.some((b) => b.key === ui.filter && b.phase === 0) || ui.filter === g.key).map((g, gi) => `
        <div class="sgtgroup"><i class="lane-${gi % COLORS}"></i>${esc(g.name)}</div>
        ${g.teams.map((t) => `
          ${g.key && pooled && !locked
            ? `<div class="sgtname" draggable="true" data-team="${esc(t)}" data-pool="${esc(g.key)}" title="Drag onto a team in another pool to trade them">${esc(t)}</div>`
            : `<div class="sgtname">${esc(t)}</div>`}
          ${flat.map(({ p, r, round }) => {
            const games = round.games.filter((x) => slotText(x.a) === t || slotText(x.b) === t);
            const bye = round.byes.some((x) => slotText(x) === t);
            const inPhase = phases[p].rounds.some((rr) => rr.games.some((x) => slotText(x.a) === t || slotText(x.b) === t) || rr.byes.some((x) => slotText(x) === t));
            const jump = (room) => `data-jump='${JSON.stringify(room === undefined ? { kind: 'round', p, r } : { kind: 'game', p, r, room })}'`;
            if (games.length > 1 || (games.length && bye)) return `<button class="sgtc bad" ${jump()}>twice<small>round ${round.round}</small></button>`;
            if (bye) return `<button class="sgtc muted" ${jump()}>bye</button>`;
            if (!games.length) return inPhase ? `<button class="sgtc bad" ${jump()}>no game</button>`
              : `<button class="sgtc later" ${jump()}>${hasPlaceholders(s) && p > 0 ? 'by finish' : '—'}</button>`;
            const g = games[0];
            const opp = slotText(g.a) === t ? g.b : g.a;
            return `<button class="sgtc" ${jump(g.room)} title="Round ${round.round}: ${esc(t)} v ${esc(slotShow(opp))} in ${esc((s.rooms[g.room] || {}).name || '')}">v ${esc(slotShow(opp) || '—')}<small>${esc((s.rooms[g.room] || {}).name || '')}</small></button>`;
          }).join('')}`).join('')}`).join('')}
    </div>`;


  /* -- the popover at what was clicked -- */
  const pop = popPanel(s, env, { bracketName, edit, trade, pooled, locked });

  // the problems: each as a sentence, with Show (and a roster name's fixes)
  const probsHtml = `<div class="sgprobs">${allChecks.map((c, i) => `<div class="sgprob"><span class="ic">!</span><span class="tx">${esc(c.text)}</span>${
    c.kind === 'roster' ? `<span class="sgfix">${unplaced.length ? `<select data-fixto="${i}" aria-label="Replace ${esc(c.team)} with">
      <option value="">Replace with…</option>${unplaced.map((x) => `<option>${esc(x)}</option>`).join('')}</select>` : ''}
      <button class="linkbtn" data-fixdel="${i}">Remove from schedule</button></span>` : ''}${
    c.p !== undefined ? `<button class="linkbtn" data-check="${i}">Show</button>` : ''}</div>`).join('')}</div>`;
  const nProb = allChecks.length;
  // while a swap or a move waits for its other end, the popover steps aside
  const hint = ui.mode === 'swapSlot' && sel && sel.kind === 'slot'
    ? `Swap ${esc(slotShow(getSlot(s, sel)) || 'the empty slot')}: click the other team or a bye`
    : ui.mode === 'moveGame' && sel && sel.kind === 'game'
      ? `Move round ${phases[sel.p].rounds[sel.r].round}’s game: click another game to trade places, or an empty room (+)` : '';

  box.innerHTML = `
    ${ui.full ? `<span class="sgzoom"><button id="schedfit" class="fit${ui.zoom ? '' : ' on'}" title="Size the grid to fit the screen">Fit</button><i></i>
      <button id="schedzout" aria-label="Zoom out" title="Zoom out">&minus;</button><b id="schedzpct"></b><button id="schedzin" aria-label="Zoom in" title="Zoom in">+</button></span>
    <button id="schedexit" class="iconbtn sgexit" title="Exit full screen (Esc)" aria-label="Exit full screen">${ICON_EXIT}</button>` : ''}
    <div class="sghead">
      <span class="muted">${env.teams.length} teams · ${s.rooms.length} rooms · ${nRounds} rounds${fmtName ? ' · ' + esc(fmtName) : ''}</span>
      <button id="schedregen" class="linkbtn">Regenerate…</button>
      <span class="spacer" style="flex:1"></span>
      <div class="views sgviews">
        ${[['grid', 'Grid'], ['teams', 'By team']].map(([k, l]) =>
          `<button class="view${ui.view === k ? ' on' : ''}" data-view2="${k}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="chips sgchips">
      <button class="chip${!ui.filter ? ' on' : ''}" data-filter="">All</button>
      ${phases.map((ph, p) => {
        const bs = brackets.filter((b) => b.phase === p);
        if (!bs.length) return '';
        return (phases.length > 1 ? `<span class="sgchipphase">${esc(ph.name)}</span>` : '')
          + bs.map((b) => `<button class="chip${ui.filter === b.key ? ' on' : ''}" data-filter="${esc(b.key)}"><i class="lane-${colorOf.get(b.key + '@' + b.phase)}"></i>${esc(b.name)}</button>`).join('');
      }).join('')}
    </div>
    <div class="sgbar${unsaved ? ' unsaved' : ''}">
      <b>${unsaved ? (ui.past.length ? ui.past.length + ' unsaved change' + (ui.past.length === 1 ? '' : 's') : 'Unsaved changes') : 'Saved'}</b>
      ${nProb
        ? `<button id="schedprobs" class="sgwarn${ui.probsOpen ? ' on' : ''}" ${named(nProb + (nProb === 1 ? ' problem' : ' problems'))}>${IC_WARN}<span class="cnt">${nProb}</span></button>`
        : `<span class="sgwarn none" ${named('No problems')}>${IC_CHECK}</span>`}
      <span class="muted sgnote">${esc(ui.note)}</span>
      <span class="spacer" style="flex:1"></span>
      <span class="sgmenu"><button id="schedplus" class="small icosm${ui.menu === 'plus' ? ' on' : ''}" ${named('Add')}>${IC_PLUS}</button>${ui.menu === 'plus' ? `<div class="sgdd">
        <button id="schedaddround">Add a round</button><button id="schedaddphase">Add a phase</button><button id="schedaddroom">Add a room</button></div>` : ''}</span>
      <button id="schedundo" class="small icosm" ${named('Undo')} ${ui.past.length ? '' : 'disabled'}>${ICONS.undo}</button>
      <button id="schedredo" class="small icosm" ${named('Redo')} ${ui.future.length ? '' : 'disabled'}>${ICONS.redo}</button>
      <button id="scheddiscard" class="small" ${unsaved ? '' : 'disabled'}>Discard</button>
      <button id="schedsave" class="primary" ${unsaved ? '' : 'disabled'}>Save schedule</button>
      <span class="sgmenu"><button id="schedmore" class="small icosm${ui.menu === 'more' ? ' on' : ''}" ${named('More')}>${ICONS.more}</button>${ui.menu === 'more' ? `<div class="sgdd">
        <button id="scheddel" class="danger">Delete schedule</button></div>` : ''}</span>
    </div>
    ${hint ? `<div class="sghint"><span>${hint}</span><button class="linkbtn" id="schedmodeno">Cancel</button></div>` : ''}
    ${ui.probsOpen && nProb ? probsHtml : ''}
    ${ui.addPhase ? addPhaseForm(s) : ''}
    <div class="sgbody">
      <div class="sgscroll" id="sgscroll">${ui.view === 'teams' ? teamHtml : gridHtml}</div>
    </div>
    ${pop.html}`;

  /* ---------- wiring ---------- */
  const $$ = (sel2) => box.querySelectorAll(sel2);
  const q = (id) => box.querySelector('#' + id);
  const parse = (x) => JSON.parse(x);
  const setSel = (x) => { ui.sel = x; ui.mode = null; ui.renaming = null; ui.menu = null; again(); };
  const scroll = q('sgscroll');
  if (ui.scrollPos) { scroll.scrollLeft = ui.scrollPos[0]; scroll.scrollTop = ui.scrollPos[1]; }

  // the popover sits under what was clicked, and follows it as the grid scrolls
  const anchor = () => {
    const x = ui.sel;
    if (!x) return null;
    if (x.kind === 'slot') return [...$$('.sgslot[data-ref]')].find((el) => refKey(parse(el.dataset.ref)) === refKey(x)) || null;
    if (x.kind === 'game' || x.kind === 'empty') return [...$$('.sgcell[data-cell]')].find((el) => cellKey(parse(el.dataset.cell)) === cellKey(x)) || null;
    if (x.kind === 'room') return box.querySelector(`.sgroom[data-room="${x.room}"][data-roomp="${x.p}"]`) || box.querySelector(`.sgroom[data-room="${x.room}"]`);
    if (x.kind === 'round') return box.querySelector(`.sgrnd[data-rnd="${x.p}.${x.r}"]`);
    if (x.kind === 'lane') return [...$$('[data-lanehd]')].find((el) => el.dataset.lanehd === x.key + '@' + x.p) || null;
    return null;
  };
  const place = () => {
    const el = q('schedpop');
    if (!el) return;
    const at = anchor();
    if (!at) { el.hidden = true; return; }
    el.hidden = false;
    const r = at.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    el.style.left = Math.max(0, Math.min(r.left - b.left + box.scrollLeft, box.clientWidth - el.offsetWidth - 4)) + 'px';
    el.style.top = (r.bottom - b.top + box.scrollTop + 6) + 'px';
  };
  scroll.onscroll = () => { ui.scrollPos = [scroll.scrollLeft, scroll.scrollTop]; place(); };
  closeOutside = (ev) => {
    if (!box.isConnected || (!ui.sel && !ui.menu) || ui.mode === 'swapSlot' || ui.mode === 'moveGame') return;
    const t = ev.target;
    if (ui.menu && !(t.closest && t.closest('.sgmenu'))) { ui.menu = null; again(); return; }
    if (!ui.sel || !t.closest) return;
    if (t.closest('.sgpop, .sgslot, [data-gh], [data-emptycell], .sgroom, .sgrnd, [data-lanehd], [data-jump], .sgmenu')) return;
    ui.sel = null;
    ui.mode = null;
    ui.renaming = null;
    again();
  };

  $$('[data-view2]').forEach((b) => { b.onclick = () => { ui.view = b.dataset.view2; ui.sel = null; again(); }; });
  $$('[data-filter]').forEach((b) => { b.onclick = () => { ui.filter = b.dataset.filter; ui.scrollPos = null; again(); }; });
  $$('[data-phase]').forEach((b) => { b.onclick = () => { const p = Number(b.dataset.phase); if (ui.closed.has(p)) ui.closed.delete(p); else ui.closed.add(p); again(); }; });
  // the tie order (saved as a setting), and what Finals rank on (a schedule edit)
  wireTieChips(box, env, again);
  $$('[data-rankby]').forEach((el) => {
    el.onchange = () => {
      const v = el.value;
      edit('Ranked by ' + RANK_BY.find(([k]) => k === v)[1], (ss) => { ss.finalsRankBy = v; });
    };
  });
  // Drag the right edge of a pool's heading (or of Byes) to set the width
  // of its columns; the drag is spread over the lane's rooms. Widths live
  // in ui.colW / ui.byeW until the page is reloaded.
  $$('.sgresize').forEach((h) => {
    const id = h.dataset.resize;
    const n = Number(h.dataset.n) || 1;
    const grid = h.closest('.sggrid');
    const put = (v) => { if (id === 'bye') ui.byeW = v; else if (v) ui.colW[id] = v; else delete ui.colW[id]; };
    h.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const zoom = ui.full ? ui.zoomNow : 1;
      const from = id === 'bye' ? gridBye(grid) : (ui.colW[id] || Number(grid.dataset.auto));
      const x0 = e.clientX;
      h.setPointerCapture(e.pointerId);
      h.classList.add('on');
      h.onpointermove = (ev) => {
        put(Math.round(Math.max(COL_LO, Math.min(COL_HI, from + (ev.clientX - x0) / zoom / n))));
        for (const el of box.querySelectorAll('.sggrid')) setTracks(el, Number(el.dataset.auto));
      };
      // a full redraw settles it: full screen fits the other columns around the new width
      h.onpointerup = h.onpointercancel = () => { h.onpointermove = null; again(); };
    };
    h.ondblclick = (e) => { e.stopPropagation(); put(null); again(); };
    h.onclick = (e) => e.stopPropagation();
  });
  box.classList.toggle('sgfull', ui.full);
  redrawFull = () => { if (box.isConnected) again(); };
  // the cover hides the heading, so full screen carries its own way out
  const fb = fullBtn();
  if (fb) {
    fb.hidden = false;
    fb.innerHTML = ICON_FULL;
    fb.title = 'Full screen';
    fb.setAttribute('aria-label', 'Full screen');
    fb.onclick = () => { ui.sel = null; ui.mode = null; setFull(true); again(); };
  }
  if (q('schedexit')) q('schedexit').onclick = () => { setFull(false); again(); };
  if (ui.full) {
    ui.zoomNow = fitFull(box);
    q('schedzpct').textContent = Math.round(ui.zoomNow * 100) + '%';
    const step = (by) => {
      ui.zoom = Math.min(2, Math.max(0.5, Math.round((ui.zoomNow + by) * 10) / 10));
      ui.scrollPos = null;
      again();
    };
    q('schedfit').onclick = () => { ui.zoom = null; ui.scrollPos = null; again(); };
    q('schedzout').onclick = () => step(-0.1);
    q('schedzin').onclick = () => step(0.1);
  }
  $$('[data-jump]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); ui.view = 'grid'; ui.filter = ''; setSel(parse(b.dataset.jump)); scrollToSel(box); }; });
  $$('[data-fixto]').forEach((el) => {
    el.onchange = () => {
      const c = allChecks[Number(el.dataset.fixto)];
      if (!el.value) return;
      const to = el.value;
      edit(`${c.team} replaced with ${to}. Please save the schedule to keep it.`, (ss) => renameTeams(ss, { [c.team]: to }));
    };
  });
  $$('[data-fixdel]').forEach((b) => {
    b.onclick = () => {
      const c = allChecks[Number(b.dataset.fixdel)];
      edit(`${c.team} removed from the schedule. Please fill the open slots and save the schedule.`, (ss) => removeTeam(ss, c.team));
    };
  });
  // Show: the problem's game (or round) scrolled into view and flashed
  $$('[data-check]').forEach((b) => {
    b.onclick = () => {
      const c = allChecks[Number(b.dataset.check)];
      if (c.p === undefined) return;
      ui.view = 'grid';
      ui.filter = '';
      ui.closed.delete(c.p);
      ui.sel = null;
      ui.mode = null;
      again();
      const at = Number.isInteger(c.room)
        ? [...box.querySelectorAll('.sgcell[data-cell]')].find((el) => cellKey(JSON.parse(el.dataset.cell)) === cellKey(c))
        : box.querySelector(`.sgrnd[data-rnd="${c.p}.${c.r}"]`);
      if (!at) return;
      at.scrollIntoView({ block: 'center', inline: 'center' });
      at.classList.remove('sgflash');
      void at.offsetWidth;
      at.classList.add('sgflash');
    };
  });

  // slots: click opens the popover (or finishes a swap / game move)
  $$('.sgslot').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const ref = parse(el.dataset.ref);
      if (ui.mode === 'swapSlot' && sel && sel.kind === 'slot') {
        if (refKey(sel) === refKey(ref)) { ui.mode = null; again(); return; }
        const a = { ...sel };
        edit(`Swapped ${slotShow(getSlot(s, a)) || 'an empty slot'} and ${slotShow(getSlot(s, ref)) || 'an empty slot'}`, (ss) => swapSlotsAt(ss, a, ref));
        return;
      }
      if (ui.mode === 'moveGame' && sel && sel.kind === 'game' && ref.bye === undefined) {
        moveGameTo(sel, { p: ref.p, r: ref.r, room: ref.room });
        return;
      }
      setSel({ kind: 'slot', ...ref });
    };
  });
  const moveGameTo = (from, to) => {
    if (cellKey(from) === cellKey(to)) { ui.mode = null; again(); return; }
    const had = phases[to.p].rounds[to.r].games.some((g) => g.room === to.room && (g.a || g.b));
    edit(had ? 'Traded two games' : 'Moved a game', (ss) => {
      // an inserted round holds empty placeholder games: clear the target first
      const tr = ss.phases[to.p].rounds[to.r];
      const tg = tr.games.find((g) => g.room === to.room);
      if (tg && !tg.a && !tg.b) tr.games.splice(tr.games.indexOf(tg), 1);
      swapCells(ss, from, to);
    });
  };
  $$('[data-gh]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const cell = parse(el.dataset.gh);
      if (ui.mode === 'moveGame' && sel && sel.kind === 'game') { moveGameTo(sel, cell); return; }
      setSel({ kind: 'game', ...cell });
    };
  });
  $$('[data-emptycell]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const cell = parse(el.dataset.emptycell);
      if (ui.mode === 'moveGame' && sel && sel.kind === 'game') { moveGameTo(sel, cell); return; }
      if (ui.mode === 'swapSlot' && sel && sel.kind === 'slot') {
        const a = { ...sel };
        edit('Moved ' + slotShow(getSlot(s, a)), (ss) => swapSlotsAt(ss, a, { ...cell, side: 'a' }));
        return;
      }
      setSel({ kind: 'empty', ...cell });
    };
  });
  $$('.sgcell:not(.empty)').forEach((el) => {
    // a click on the card outside a team: finishing a move lands here
    el.onclick = () => {
      const cell = parse(el.dataset.cell);
      if (ui.mode === 'moveGame' && sel && sel.kind === 'game') moveGameTo(sel, cell);
    };
  });
  $$('[data-room]').forEach((el) => { el.onclick = () => setSel({ kind: 'room', room: Number(el.dataset.room), p: Number(el.dataset.roomp) }); });
  $$('.sgrnd[data-rnd]').forEach((el) => {
    const open = () => { const [p, r] = el.dataset.rnd.split('.').map(Number); setSel({ kind: 'round', p, r }); };
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  $$('[data-lanehd]').forEach((el) => {
    el.onclick = () => { const at = el.dataset.lanehd.lastIndexOf('@'); setSel({ kind: 'lane', key: el.dataset.lanehd.slice(0, at), p: Number(el.dataset.lanehd.slice(at + 1)) }); };
  });

  /* -- drag and drop -- */
  wireDrag(box, s, { edit, moveGameTo, again, trade });

  /* -- the popover's actions -- */
  pop.wire(box);
  place();

  /* -- toolbar -- */
  if (q('schedprobs')) q('schedprobs').onclick = () => { ui.probsOpen = !ui.probsOpen; again(); };
  if (q('schedmodeno')) q('schedmodeno').onclick = () => { ui.mode = null; ui.sel = null; again(); };
  q('schedplus').onclick = () => { ui.menu = ui.menu === 'plus' ? null : 'plus'; again(); };
  q('schedmore').onclick = () => { ui.menu = ui.menu === 'more' ? null : 'more'; again(); };
  if (q('schedaddround')) q('schedaddround').onclick = () => edit('Added a round', (ss) => addRound(ss, ss.phases.length - 1));
  if (q('schedaddphase')) q('schedaddphase').onclick = () => { ui.menu = null; ui.addPhase = !ui.addPhase; again(); };
  if (q('schedaddroom')) {
    q('schedaddroom').onclick = () => {
      const taken = new Set(s.rooms.map((r) => r.name));
      let k = s.rooms.length + 1;
      while (taken.has('Room ' + k)) k++;
      edit('Added a room', (ss) => { ss.rooms.push({ name: 'Room ' + k, bucket: null }); });
    };
  }
  wireAddPhase(box, s, edit, again);
  q('schedundo').onclick = () => {
    if (!ui.past.length) return;
    const prev = ui.past.pop();
    ui.future.unshift(JSON.stringify(s));
    restore(prev, 'Undid a change');
  };
  q('schedredo').onclick = () => {
    if (!ui.future.length) return;
    const next = ui.future.shift();
    ui.past.push(JSON.stringify(s));
    restore(next, 'Redid a change');
  };
  q('scheddiscard').onclick = () => {
    if (!confirm('Discard every change since the last save?')) return;
    ui.past = [];
    ui.future = [];
    const next = JSON.parse(ui.baseline.json);
    ui.baseline.obj = next;
    env.setSched(next);
    env.setDirty(false);
    ui.note = 'Discarded changes';
    ui.sel = null;
    renderEditor(box, env);
  };
  q('schedsave').onclick = async () => {
    const run = busy(q('schedsave'), { label: 'Saving' });
    try {
      // fill missing/stale room->bucket links by name so reader rooms
      // resolve their schedule line without hand-linking
      for (const room of s.rooms) {
        if (room.bucket !== null && room.bucket !== undefined && env.buckets.some((b) => b.id === room.bucket)) continue;
        const hit = env.buckets.find((b) => norm(b.room_name) === norm(room.name) && !s.rooms.some((r2) => r2.bucket === b.id));
        room.bucket = hit ? hit.id : null;
      }
      s.brackets = bracketRooms(s);
      await env.save(s);
      env.setDirty(false);
      ui.baseline = { obj: s, json: JSON.stringify(s) };
      ui.past = [];
      ui.future = [];
      ui.note = '';
      env.say('Schedule saved');
      run.end();
      again();
    } catch (e) { run.end(); env.say(e.message, true); }
  };
  if (q('scheddel')) {
    q('scheddel').onclick = async () => {
      ui.menu = null;
      if (!confirm('Delete the schedule? Rooms stop preselecting teams and the player page shows no schedule.')) { again(); return; }
      try {
        await env.del();
        env.setSched(null);
        env.setDirty(false);
        ui.baseline = { obj: null, json: '' };
        resetEditor();
        env.say('Schedule deleted');
        env.refresh();
      } catch (e) { env.say(e.message, true); }
    };
  }
  // the format picker, replacing the whole schedule unless a part is picked there
  const openPicker = (regen) => {
    if (env.dirty() && !confirm('You have unsaved edits. Pick a new format anyway? (Nothing changes until you press Generate.)')) return;
    ui.creator = true;
    ui.sel = null;
    ui.mode = null;
    ui.menu = null;
    ui.plan = null; // the picker starts from the schedule's plan, or the default
    ui.regen = regen;
    if (s.options && s.options.seed) ui.opts.seed = s.options.seed;
    renderCreator(box, env);
  };
  q('schedregen').onclick = () => openPicker('all');
}


/* ---------- Add phase (a finals phase after the last one) ---------- */

// The form: a name, the first game (a place in a bracket of the last
// phase against another), and whether a second game follows if the
// first-place team loses (an advantaged final).
function addPhaseForm(s) {
  const last = s.phases.length - 1;
  const brs = (s.brackets || []).filter((b) => b.phase === last);
  const size = (key) => new Set(s.phases[last].rounds.flatMap((r) => r.games.filter((g) => g.bracket === key)
    .flatMap((g) => [slotText(g.a), slotText(g.b)]))).size;
  const top = brs[0] ? brs[0].key : '';
  const places = (on) => Array.from({ length: Math.max(2, size(top)) }, (_, i) =>
    `<option value="${i + 1}" ${i + 1 === on ? 'selected' : ''}>${ORDN(i + 1)}</option>`).join('');
  const opts = brs.map((b) => `<option value="${esc(b.key)}">${esc(b.name)}</option>`).join('');
  return `<div class="sgnotice pkaddphase">
    <div class="pkgrid">
      <span class="pkl">Name</span><span><input data-apname value="Finals" size="16"></span>
      <span class="pkl">First game</span><span class="pkrow"><select data-apa>${places(1)}</select> in <select data-apab>${opts}</select>
        <span class="muted">against</span> <select data-apb>${places(2)}</select> in <select data-apbb>${opts}</select></span>
      <span></span><label class="pkcheck"><input type="checkbox" data-apif checked> Play a second game if the first-place team loses</label>
    </div>
    <div class="row"><button class="small primary" id="schedapgo">Add phase</button><button class="small" id="schedapno">Cancel</button></div>
  </div>`;
}
function wireAddPhase(box, s, edit, again) {
  const q = (a) => box.querySelector(a);
  if (!q('#schedapgo')) return;
  q('#schedapno').onclick = () => { ui.addPhase = false; again(); };
  q('#schedapgo').onclick = () => {
    const last = s.phases.length - 1;
    const nameOf = (k) => ((s.brackets || []).find((b) => b.key === k && b.phase === last) || {}).name || '';
    const a = { label: `${ORDN(Number(q('[data-apa]').value))} in ${nameOf(q('[data-apab]').value)}` };
    const b = { label: `${ORDN(Number(q('[data-apb]').value))} in ${nameOf(q('[data-apbb]').value)}` };
    const name = q('[data-apname]').value.trim() || 'Finals';
    const twice = q('[data-apif]').checked;
    ui.addPhase = false;
    edit(`Added ${name}`, (ss) => {
      let round = Math.max(...ss.phases.flatMap((ph) => ph.rounds.map((r) => r.round))) + 1;
      const key = 'FN' + (ss.phases.length + 1);
      const rounds = [{ round: round++, games: [{ room: 0, a, b, bracket: key }], byes: [] }];
      if (twice) rounds.push({ round: round++, games: [{ room: 0, a: { ...a }, b: { ...b }, bracket: key, ifNeeded: 'if the first-place team loses the first game' }], byes: [] });
      ss.phases.push({ name, rounds, meet: twice ? 2 : 1, kind: 'final' });
      ss.brackets = [...(ss.brackets || []), { key, name, phase: ss.phases.length - 1 }];
    });
  };
}

function scrollToSel(box) {
  requestAnimationFrame(() => {
    const el = box.querySelector('.sgcell.on, .sgslot.on, .sgrnd.on');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/* ---------- slot helpers (room-keyed refs; games created on demand) ---------- */

function gameAt(s, p, r, room) { return s.phases[p].rounds[r].games.find((g) => g.room === room) || null; }
function getSlot(s, x) {
  const round = s.phases[x.p].rounds[x.r];
  if (x.bye !== undefined) return round.byes[x.bye] ?? null;
  const g = gameAt(s, x.p, x.r, x.room);
  return g ? g[x.side] || null : null;
}
function setSlotAt(s, x, v) {
  const round = s.phases[x.p].rounds[x.r];
  if (x.bye !== undefined) {
    if (v) round.byes[x.bye] = v; else round.byes.splice(x.bye, 1);
    return;
  }
  let g = gameAt(s, x.p, x.r, x.room);
  if (!g) {
    // a new game takes the bracket its room's lane belongs to
    const lane = phaseLanes(s, x.p).find((l) => l.rooms.includes(x.room));
    g = { room: x.room, a: null, b: null, ...(lane && lane.key ? { bracket: lane.key } : {}) };
    round.games.push(g);
    round.games.sort((a, b) => a.room - b.room);
  }
  if (!g.bracket) {
    // an inserted round's empty game joins its room's lane
    const lane = phaseLanes(s, x.p).find((l) => l.rooms.includes(x.room));
    if (lane && lane.key) g.bracket = lane.key;
  }
  g[x.side] = v || null;
  if (!g.a && !g.b) round.games.splice(round.games.indexOf(g), 1);
}
function swapSlotsAt(s, r1, r2) {
  const v1 = getSlot(s, r1);
  const v2 = getSlot(s, r2);
  // write game slots before bye splices so bye indexes stay valid, and the
  // higher bye index first
  const writes = [[r1, v2], [r2, v1]].sort((x, y) => {
    const bx = x[0].bye !== undefined, by = y[0].bye !== undefined;
    if (bx !== by) return bx ? 1 : -1;
    return (y[0].bye || 0) - (x[0].bye || 0);
  });
  for (const [ref, v] of writes) {
    if (ref.bye !== undefined && !v) s.phases[ref.p].rounds[ref.r].byes.splice(ref.bye, 1);
    else setSlotAt(s, ref, v);
  }
}

/* ---------- the popover ---------- */

// What can be done with what was clicked: a team (its game too), a game,
// an empty room, a room, a round or a bracket's heading. Closed while a
// swap or a move waits for its other end (the toolbar's hint says so).
function popPanel(s, env, { bracketName, edit, trade, pooled, locked }) {
  const sel = ui.sel;
  const link = (id, label, cls = '') => `<button class="linkbtn${cls ? ' ' + cls : ''}" data-act="${id}">${esc(label)}</button>`;
  const acts = (...items) => `<div class="sgacts">${items.filter(Boolean).join('')}</div>`;
  const head = (title, sub) => `<b class="sgptitle">${esc(title)}</b>${sub ? `<span class="muted small">${esc(sub)}</span>` : ''}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const A = {};
  let html = '';
  // a game's own actions, for its popover and under a team's
  const gameActs = (cell) => {
    const g = gameAt(s, cell.p, cell.r, cell.room);
    const round = s.phases[cell.p].rounds[cell.r];
    const brs = bracketRooms(s).filter((b) => b.phase === cell.p);
    A.move = () => { ui.sel = { kind: 'game', p: cell.p, r: cell.r, room: cell.room }; ui.mode = 'moveGame'; };
    A.flip = () => edit('Flipped sides', (ss) => { const gg = gameAt(ss, cell.p, cell.r, cell.room); [gg.a, gg.b] = [gg.b, gg.a]; });
    A.remove = () => {
      edit(`Round ${round.round}: removed a game`, (ss) => {
        const rr = ss.phases[cell.p].rounds[cell.r];
        const gg = gameAt(ss, cell.p, cell.r, cell.room);
        rr.games.splice(rr.games.indexOf(gg), 1);
        for (const v of [gg.a, gg.b]) if (v) rr.byes.push(v);
      });
    };
    A.__bracket = (key) => edit('Moved a game to ' + bracketName(key), (ss) => { gameAt(ss, cell.p, cell.r, cell.room).bracket = key; });
    return acts(link('move', 'Move or swap…'), link('flip', 'Flip sides'), link('remove', 'Remove game', 'danger'))
      + (brs.length > 1 ? `<label class="sgrow">Bracket <select data-act-br="1">${brs.map((b) => `<option value="${esc(b.key)}" ${b.key === g.bracket ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : '');
  };
  if (!sel || ui.mode === 'swapSlot' || ui.mode === 'moveGame') {
    html = '';
  } else if (ui.mode === 'trade' && sel.kind === 'slot') {
    // every other pool as a list, Find when they are long
    const team = slotText(getSlot(s, sel));
    const mine = poolOf(s, team);
    const keys = Object.keys(s.pools).sort();
    const others = keys.filter((k) => k !== mine);
    const total = others.reduce((n, k) => n + s.pools[k].length, 0);
    html = `<div class="tp">
      ${head(`Trade ${team} with…`, `Pool ${mine}. The two teams swap pools and every prelim game.`)}
      ${total > 12 ? '<input class="tp-find" data-tpfind="1" placeholder="Find a team" aria-label="Find a team">' : ''}
      <div class="tp-pools">${others.map((k) => `<div class="tp-pool"><div class="tp-ph lane-${keys.indexOf(k) % COLORS}"><i></i>Pool ${esc(k)}<span class="n">${s.pools[k].length}</span></div>${
        s.pools[k].map((t) => `<button class="tp-t" data-tpteam="${esc(t)}">${esc(t)}</button>`).join('')}</div>`).join('')}
        <div class="tp-none muted small" hidden>No team in another pool matches.</div></div>
      ${acts(link('cancel', 'Cancel'))}</div>`;
    A.cancel = () => { ui.mode = null; };
    A.__trade = (other) => { ui.mode = null; trade(team, other); };
  } else if (sel.kind === 'slot') {
    const cur = getSlot(s, sel);
    const round = s.phases[sel.p].rounds[sel.r];
    const n = round.round;
    const inRound = new Map();
    round.games.forEach((g) => ['a', 'b'].forEach((side) => { if (g[side]) inRound.set(slotText(g[side]), { p: sel.p, r: sel.r, room: g.room, side }); }));
    round.byes.forEach((b, i) => inRound.set(slotText(b), { p: sel.p, r: sel.r, bye: i }));
    const phaseSlots = new Map();
    for (const rr of s.phases[sel.p].rounds) {
      for (const g of rr.games) for (const v of [g.a, g.b]) if (v) phaseSlots.set(slotText(v), v);
      for (const v of rr.byes) if (v) phaseSlots.set(slotText(v), v);
    }
    const everyone = new Map([...env.teams.map((t) => [t, { team: t }]), ...phaseSlots]);
    const free = [...everyone].filter(([k]) => !inRound.has(k));
    const onBye = [...inRound].filter(([, ref]) => ref.bye !== undefined && refKey(ref) !== refKey(sel));
    const playing = [...everyone].filter(([k]) => inRound.has(k) && inRound.get(k).bye === undefined && k !== slotText(cur));
    const where = sel.bye !== undefined ? 'bye' : (s.rooms[sel.room] || {}).name;
    const opt = ([k, v]) => `<option value="${esc(k)}">${esc(slotShow(v))}</option>`;
    const group = (label, list) => (list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '');
    // the team's pool, and the trade, in pool play only
    const pool = cur && cur.team && sel.p === 0 && pooled ? poolOf(s, cur.team) : null;
    const lane = pool ? Object.keys(s.pools).sort().indexOf(pool) % COLORS : 0;
    const g = sel.bye === undefined ? gameAt(s, sel.p, sel.r, sel.room) : null;
    html = head(cur ? slotShow(cur) : 'Empty slot', `Round ${n} · ${where}`)
      + acts(link('swap', 'Swap with…'), cur && sel.bye === undefined && link('bench', 'Give a bye'), cur && link('clear', 'Clear'))
      + `<label class="sgrow sgcol">Replace with <select class="slotsel" data-act-sel="1"><option value="">Choose a team</option>${
        group('No game this round', free)}${group('On a bye', onBye.map(([k]) => [k, everyone.get(k) || { team: k }]))}${
        group('Playing this round (swaps)', playing)}${cur ? '<option value="__clear">Clear this slot</option>' : ''}</select></label>`
      + (pool ? `<div class="sgpool lane-${lane}"><span><i></i>Pool ${esc(pool)}</span>${
        locked ? '<span class="muted small">Trades close once prelims start</span>' : link('trade', 'Trade pools…')}</div>` : '')
      + (g && (g.a || g.b) ? `<div class="sgsub"><span class="muted small">This game: ${esc(slotShow(g.a) || '—')} v ${esc(slotShow(g.b) || '—')}</span>${gameActs(sel)}</div>` : '');
    const put = (k) => {
      const v = everyone.get(k) || { team: k };
      const other = inRound.get(k);
      if (other) {
        edit(`Round ${n}: swapped ${slotShow(cur) || 'empty'} and ${slotShow(v)}`, (ss) => swapSlotsAt(ss, sel, other));
      } else {
        edit(`Round ${n}: ${cur ? slotShow(cur) + ' → ' : ''}${slotShow(v)}`, (ss) => setSlotAt(ss, sel, v));
      }
    };
    A.swap = () => { ui.mode = 'swapSlot'; };
    A.trade = () => { ui.mode = 'trade'; };
    A.bench = () => { edit(`Round ${n}: ${slotShow(cur)} on a bye`, (ss) => { setSlotAt(ss, sel, null); ss.phases[sel.p].rounds[sel.r].byes.push(cur); }); };
    A.clear = () => { edit('Cleared a slot', (ss) => setSlotAt(ss, sel, null)); };
    A.__select = (value) => {
      if (!value) return;
      if (value === '__clear') A.clear(); else put(value);
    };
  } else if (sel.kind === 'game') {
    const g = gameAt(s, sel.p, sel.r, sel.room);
    if (g && (g.a || g.b)) {
      const round = s.phases[sel.p].rounds[sel.r];
      html = head(`${slotShow(g.a) || '—'} v ${slotShow(g.b) || '—'}`, `Round ${round.round} · ${(s.rooms[sel.room] || {}).name || ''}`) + gameActs(sel);
    }
  } else if (sel.kind === 'empty') {
    const round = s.phases[sel.p].rounds[sel.r];
    html = head('Empty room', `Round ${round.round} · ${(s.rooms[sel.room] || {}).name || ''}`) + acts(link('add', 'Add a game here'));
    A.add = () => { ui.sel = { kind: 'slot', p: sel.p, r: sel.r, room: sel.room, side: 'a' }; };
  } else if (sel.kind === 'room') {
    const room = s.rooms[sel.room];
    if (room) {
      const games = s.phases.reduce((k, ph) => k + ph.rounds.filter((r) => r.games.some((g) => g.room === sel.room && (g.a || g.b))).length, 0);
      html = ui.renaming === 'room'
        ? head('Rename room') + `<input class="sgpopin" data-act-name="1" value="${esc(room.name)}" aria-label="Room name">` + acts(link('namego', 'Save'), link('nameno', 'Cancel'))
        : head(room.name, plural(games, 'game')) + acts(link('rename', 'Rename'), link('droproom', 'Remove room', 'danger'))
          + `<label class="sgrow sgcol">Room page <select data-act-bucket="1"><option value="">Not linked</option>${env.buckets.map((b) =>
            `<option value="${b.id}" ${b.id === room.bucket ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}</select></label>`;
      A.rename = () => { ui.renaming = 'room'; };
      A.nameno = () => { ui.renaming = null; };
      A.namego = (box) => {
        const v = box.querySelector('[data-act-name]').value.trim();
        ui.renaming = null;
        if (!v || v === room.name) return;
        edit('Renamed a room', (ss) => { ss.rooms[sel.room].name = v; });
      };
      A.droproom = () => {
        const filled = s.phases.some((ph) => ph.rounds.some((r) => r.games.some((g) => g.room === sel.room && (g.a || g.b))));
        if (filled && !confirm(`Remove ${room.name}? Its teams drop to Byes (Undo brings them back).`)) return 'stay';
        edit('Removed ' + room.name, (ss) => {
          removeRoomCol(ss, sel.room);
          if (ss.brackets) ss.brackets.forEach((b) => { if (b.rooms) b.rooms = b.rooms.filter((i) => i !== sel.room).map((i) => (i > sel.room ? i - 1 : i)); });
        });
      };
      A.__bucket = (v) => edit('Linked a room', (ss) => { ss.rooms[sel.room].bucket = v ? Number(v) : null; });
    }
  } else if (sel.kind === 'round') {
    const round = s.phases[sel.p].rounds[sel.r];
    const games = round.games.filter((g) => g.a || g.b).length;
    html = head(`Round ${round.round}`, `${s.phases[sel.p].name} · ${plural(games, 'game')}`)
      + acts(link('insround', 'Insert a round after this one'), link('delround', 'Delete this round', 'danger'));
    A.insround = () => edit(`Inserted a round after round ${round.round}`, (ss) => insertRound(ss, sel.p, sel.r));
    A.delround = () => {
      const filled = round.games.some((g) => g.a || g.b) || round.byes.length;
      if (filled && !confirm(`Delete round ${round.round}? Its games go too (Undo brings them back).`)) return 'stay';
      edit(`Deleted round ${round.round}`, (ss) => {
        removeRound(ss, sel.p, sel.r);
        if (!ss.phases[sel.p].rounds.length && ss.phases.length > 1) ss.phases.splice(sel.p, 1);
      });
    };
  } else if (sel.kind === 'lane') {
    // a bracket's heading: its name, here and in every slot that names it
    // ("1st in 1st–6th place"), as one undoable edit
    const cur = (s.brackets || []).find((x) => x.key === sel.key && x.phase === sel.p);
    if (cur) {
      const rooms = (bracketRooms(s).find((b) => b.key === sel.key && b.phase === sel.p) || { rooms: [] }).rooms;
      html = ui.renaming === 'lane'
        ? head('Rename bracket') + `<input class="sgpopin" data-act-name="1" value="${esc(cur.name)}" aria-label="Bracket name">` + acts(link('namego', 'Save'), link('nameno', 'Cancel'))
        : head(cur.name, rooms.map((i) => (s.rooms[i] || {}).name || '').join(' · ') || 'no rooms yet') + acts(link('rename', 'Rename'));
      A.rename = () => { ui.renaming = 'lane'; };
      A.nameno = () => { ui.renaming = null; };
      A.namego = (box) => {
        const name = box.querySelector('[data-act-name]').value.trim();
        if (!name) { env.say('Please give the bracket a name.', true); return 'stay'; }
        if (name !== cur.name && (s.brackets || []).some((x) => x.name === name)) { env.say(`Another bracket is already called ${name}.`, true); return 'stay'; }
        ui.renaming = null;
        if (name === cur.name) return;
        const old = cur.name;
        edit(`Renamed ${old} to ${name}`, (ss) => {
          for (const x of ss.brackets || []) if (x.key === sel.key && x.phase === sel.p) x.name = name;
          for (const p2 of ss.phases) for (const r of p2.rounds) {
            for (const g of r.games) for (const side of ['a', 'b']) {
              const x = g[side];
              if (x && typeof x.label === 'string' && x.label.endsWith(' in ' + old)) x.label = x.label.slice(0, -old.length) + name;
            }
            for (const x of r.byes || []) if (x && typeof x.label === 'string' && x.label.endsWith(' in ' + old)) x.label = x.label.slice(0, -old.length) + name;
          }
        });
      };
    }
  }
  return {
    html: html ? `<div class="sgpop" id="schedpop" role="dialog">${html}</div>` : '',
    wire(box) {
      const redraw = () => renderSchedStep(box, env);
      box.querySelectorAll('.sgpop [data-act]').forEach((b) => {
        b.onclick = () => {
          const fn = A[b.dataset.act];
          if (!fn) return;
          if (fn(box) === 'stay') return;
          redraw();
        };
      });
      box.querySelectorAll('[data-tpteam]').forEach((b) => {
        b.onclick = () => { A.__trade(b.dataset.tpteam); redraw(); };
      });
      // Find filters the lists in place, so typing keeps its focus
      const find = box.querySelector('[data-tpfind]');
      if (find) {
        find.oninput = () => {
          const q = find.value.trim().toLowerCase();
          let any = false;
          box.querySelectorAll('.tp-pool').forEach((pool) => {
            let shown = 0;
            pool.querySelectorAll('[data-tpteam]').forEach((t) => {
              const hit = !q || t.dataset.tpteam.toLowerCase().includes(q);
              t.hidden = !hit;
              if (hit) shown++;
            });
            pool.hidden = !shown;
            if (shown) any = true;
          });
          box.querySelector('.tp-none').hidden = any;
        };
        find.focus();
      }
      const sl = box.querySelector('.sgpop [data-act-sel]');
      if (sl) sl.onchange = () => { A.__select(sl.value); redraw(); };
      const br = box.querySelector('.sgpop [data-act-br]');
      if (br) br.onchange = () => { A.__bracket(br.value); redraw(); };
      const nm = box.querySelector('.sgpop [data-act-name]');
      if (nm) {
        nm.focus();
        nm.select();
        nm.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (A.namego(box) !== 'stay') redraw(); }
          if (e.key === 'Escape') { e.stopPropagation(); ui.renaming = null; redraw(); }
        };
      }
      const bk = box.querySelector('.sgpop [data-act-bucket]');
      if (bk) bk.onchange = () => { A.__bucket(bk.value); redraw(); };
    },
  };
}


/* ---------- drag and drop ---------- */

function wireDrag(box, s, { edit, moveGameTo, trade }) {
  const scroll = box.querySelector('#sgscroll');
  if (!scroll) return;
  let drag = null; // {slot: ref} | {cell} | {team, pool} (By team: a pool trade)
  const clear = () => {
    box.classList.remove('sg-drag-slot', 'sg-drag-game', 'sg-drag-team');
    box.querySelectorAll('.drop-ok').forEach((x) => x.classList.remove('drop-ok'));
    box.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    document.querySelectorAll('.sgghost').forEach((x) => x.remove());
  };
  // what follows the pointer: a card with the team, or with the game's two
  // teams and where it is played
  const ghost = (ev, html, cls) => {
    const el = document.createElement('div');
    el.className = 'sgghost ' + cls;
    el.innerHTML = html;
    document.body.appendChild(el);
    try { ev.dataTransfer.setDragImage(el, 14, 16); } catch (e) { /* the browser's own picture */ }
  };
  const targetOf = (el) => {
    if (!drag) return null;
    if (drag.team) {
      const row = el.closest('.sgtname[data-team]');
      return row && row.dataset.pool !== drag.pool ? { el: row, kind: 'team', team: row.dataset.team } : null;
    }
    if (drag.slot) {
      const slot = el.closest('.sgslot');
      if (slot) return { el: slot, kind: 'slot', ref: JSON.parse(slot.dataset.ref) };
      const byes = el.closest('[data-byes]');
      if (byes) return { el: byes, kind: 'byes', pr: byes.dataset.byes.split('.').map(Number) };
      const cell = el.closest('.sgcell.empty');
      if (cell) return { el: cell, kind: 'emptyslot', cell: JSON.parse(cell.dataset.cell) };
      return null;
    }
    const cell = el.closest('.sgcell');
    if (cell) return { el: cell, kind: 'cell', cell: JSON.parse(cell.dataset.cell) };
    return null;
  };
  scroll.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest && ev.target.closest('.sgtname[draggable="true"]');
    const slot = ev.target.closest && ev.target.closest('.sgslot');
    if (row) {
      drag = { team: row.dataset.team, pool: row.dataset.pool };
      row.classList.add('dragging');
      box.classList.add('sg-drag-team');
      ghost(ev, esc(row.dataset.team), 'team');
    } else if (slot && slot.draggable) {
      drag = { slot: JSON.parse(slot.dataset.ref) };
      slot.classList.add('dragging');
      box.classList.add('sg-drag-slot');
      ghost(ev, esc(slotShow(getSlot(s, drag.slot))), 'team');
    } else {
      const cell = ev.target.closest && ev.target.closest('.sgcell:not(.empty)');
      if (!cell) return;
      drag = { cell: JSON.parse(cell.dataset.cell) };
      cell.classList.add('dragging');
      box.classList.add('sg-drag-game');
      const g = gameAt(s, drag.cell.p, drag.cell.r, drag.cell.room) || {};
      ghost(ev, `<span>${esc(slotShow(g.a) || '—')}</span><span>${esc(slotShow(g.b) || '—')}</span><span class="w">Round ${s.phases[drag.cell.p].rounds[drag.cell.r].round} · ${esc((s.rooms[drag.cell.room] || {}).name || '')}</span>`, 'game');
    }
    // the popover steps aside (the drop redraws without it)
    ui.sel = null;
    ui.mode = null;
    const pop = box.querySelector('#schedpop');
    if (pop) pop.hidden = true;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', JSON.stringify(drag));
  });
  scroll.addEventListener('dragover', (ev) => {
    const t = targetOf(ev.target);
    if (!t) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    box.querySelectorAll('.drop-ok').forEach((x) => { if (x !== t.el) x.classList.remove('drop-ok'); });
    t.el.classList.add('drop-ok');
  });
  scroll.addEventListener('dragleave', (ev) => {
    const t = targetOf(ev.target);
    if (t && !t.el.contains(ev.relatedTarget)) t.el.classList.remove('drop-ok');
  });
  scroll.addEventListener('drop', (ev) => {
    const t = targetOf(ev.target);
    if (!drag) {
      try { drag = JSON.parse(ev.dataTransfer.getData('text/plain') || 'null'); } catch (e) { drag = null; }
    }
    const d = drag;
    drag = null;
    clear();
    if (!t || !d) return;
    ev.preventDefault();
    if (d.team && t.kind === 'team') {
      trade(d.team, t.team);
    } else if (d.slot && t.kind === 'slot') {
      if (refKey(d.slot) === refKey(t.ref)) return;
      edit(`Swapped ${slotShow(getSlot(s, d.slot)) || 'empty'} and ${slotShow(getSlot(s, t.ref)) || 'empty'}`, (ss) => swapSlotsAt(ss, d.slot, t.ref));
    } else if (d.slot && t.kind === 'byes') {
      const v = getSlot(s, d.slot);
      if (!v || d.slot.bye !== undefined) return;
      const [p, r] = t.pr;
      edit(`${slotShow(v)} on a bye`, (ss) => { setSlotAt(ss, d.slot, null); ss.phases[p].rounds[r].byes.push(v); });
    } else if (d.slot && t.kind === 'emptyslot') {
      const v = getSlot(s, d.slot);
      if (!v) return;
      edit(`Moved ${slotShow(v)}`, (ss) => swapSlotsAt(ss, d.slot, { ...t.cell, side: 'a' }));
    } else if (d.cell && t.kind === 'cell') {
      moveGameTo(d.cell, t.cell);
    }
  });
  scroll.addEventListener('dragend', () => { drag = null; clear(); });
}
