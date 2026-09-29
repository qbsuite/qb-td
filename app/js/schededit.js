// schededit.js — the Tournament Setup schedule step: the format picker
// (with generation options) and the editor. The editor groups room
// columns into bracket lanes (Pool A, Championship, 1st place…), keeps
// the round column and room headers pinned while the grid scrolls, and
// lets a TD drag teams (swap, bench) and whole games (trade, move), or
// click the same things through the side panel. Checks run on every
// edit; nothing is stored until Save (Generate saves at once, as before).
//
// admin.js owns the working schedule (the Live Hub reads it too); this
// module owns only the editor's view state, reached through `env`.

import { esc } from './api.js';
import { busy } from './busy.js';
import {
  formatsFor, allFormats, buildSchedule, validateSchedule, slotText, insertRound, removeRound,
  addRound, swapCells, addRoomCol, removeRoomCol, hasPlaceholders, fillPlaceholders,
  tagBrackets, bracketRooms, phaseLanes, scheduleChecks,
} from '../engine/schedule.js';

/* ---------- view state (per page load) ---------- */

const ui = {
  view: 'grid',          // grid | teams | brackets
  filter: '',            // '' = every bracket, else a bracket key
  dense: false,
  closed: new Set(),     // collapsed phase indexes
  sel: null,             // {kind: slot|game|empty|room|round, ...}
  mode: null,            // swapSlot | moveGame
  past: [], future: [],  // JSON snapshots for Undo / Redo
  note: '',
  baseline: { obj: null, json: '' }, // the schedule as saved
  creator: false,        // showing the format picker over a schedule
  opts: { seeding: 'snake', roundOrder: 'asis', rooms: 'keep', seed: 1 + Math.floor(Math.random() * 9999) },
  fmt: null,
};

/** Escape: drop the selection or a half-done swap. True if it did. */
export function schedEscape() {
  if (!ui.sel && !ui.mode) return false;
  ui.sel = null;
  ui.mode = null;
  return true;
}

const COLORS = 4; // lane tints cycle (hub.css .lane-0..3)
const refKey = (x) => x.bye !== undefined ? `${x.p}.${x.r}.b${x.bye}` : `${x.p}.${x.r}.${x.room}.${x.side}`;
const cellKey = (x) => `${x.p}.${x.r}.${x.room}`;
const slotShow = (s) => {
  if (!s) return '';
  if (s.team) return s.team;
  const m = /^([A-D])(\d+)$/.exec(s.label || '');
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
 *   roomsN(), setRoomsN(n) the picker's room count
 *   save(s), del()         Worker calls
 *   fill()                 -> {A: [names best-first], ...} for placeholders
 *   say(text, bad), refresh() (full hub render)
 */
export function renderSchedStep(box, env) {
  const sched = env.sched();
  if (!sched || ui.creator) { renderCreator(box, env); return; }

  // A schedule we haven't seen yet (fresh from the Worker, or after a
  // Discard): tag its brackets in place and take it as the saved copy.
  if (sched !== ui.baseline.obj && !env.dirty()) {
    tagBrackets(sched);
    ui.baseline = { obj: sched, json: JSON.stringify(sched) };
  }
  renderEditor(box, env);
}

/* ================= format picker ================= */

function renderCreator(box, env) {
  const teams = env.teams;
  const nRooms = env.roomsN();
  const fmts = formatsFor(teams.length, nRooms);
  if (!fmts.some((f) => f.key === ui.fmt)) ui.fmt = fmts.length ? fmts[0].key : null;
  const o = ui.opts;
  const rooms = roomList(env, nRooms);
  let preview = '';
  if (ui.fmt) {
    try {
      const s = buildSchedule(ui.fmt, teams, rooms, o);
      const nr = s.phases.reduce((n, ph) => n + ph.rounds.length, 0);
      const used = new Set(s.phases.flatMap((ph) => ph.rounds.flatMap((r) => r.games.filter((g) => g.a || g.b).map((g) => g.room))));
      const byes = s.phases.reduce((n, ph) => n + ph.rounds.reduce((m, r) => m + r.byes.length, 0), 0);
      preview = `${nr} rounds · ${used.size} of ${nRooms} rooms used · ${byes ? byes + ' byes in all' : 'no byes'}`
        + (s.brackets.length > 1 ? ' · ' + s.brackets.map((b) => b.name).join(', ') : '');
    } catch (e) { preview = e.message; }
  }
  const sel = (id, value, options) => `<select id="${id}">${options.map(([v, l]) =>
    `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const random = o.seeding === 'random' || o.roundOrder === 'shuffle' || o.rooms === 'shuffle' || o.rooms === 'rotate';
  box.innerHTML = `
    ${env.sched() ? `<div class="sgnotice">Picking a new format replaces the schedule when you press Generate.
      <button id="schedback" class="small">Keep the current schedule</button></div>` : ''}
    <div class="row sgcreatorhead">
      <span class="muted">${teams.length} teams (roster order is seed order)</span>
      <label class="muted">Rooms <input id="schedrooms" type="number" min="1" max="99" value="${nRooms}" style="width:64px"></label>
    </div>
    <div class="sgfmts">
      ${fmts.map((f) => `
      <label class="sgfmt"><input type="radio" name="schedfmt" value="${f.key}" ${f.key === ui.fmt ? 'checked' : ''}>
        <span><b>${esc(f.name)}</b> <span class="muted">&mdash; ${esc(f.desc)}</span></span></label>`).join('')
      || `<div class="muted">No format fits ${teams.length} teams in ${nRooms} rooms. ${
        allFormats(teams.length).length ? 'Add rooms: the smallest format needs ' + Math.min(...allFormats(teams.length).map((f) => f.roomsNeeded)) + '.' : ''}</div>`}
    </div>
    ${fmts.length ? `
    <div class="sgopts">
      <label>Seeding ${sel('optseed', o.seeding, [['snake', 'Snake by roster order'], ['random', 'Random']])}</label>
      <label>Round order ${sel('optorder', o.roundOrder, [['asis', 'As generated'], ['shuffle', 'Shuffled within each phase']])}</label>
      <label>Rooms ${sel('optrooms', o.rooms, [['keep', 'Teams keep their room where possible'], ['blocks', 'Each pool keeps a block of rooms'],
        ['shuffle', 'Shuffle rooms every round'], ['rotate', 'Rotate so teams see rooms evenly']])}</label>
      <span class="sgseed ${random ? '' : 'muted'}">Seed <b>${o.seed}</b> <button id="optreroll" class="small" ${random ? '' : 'disabled'}>Reroll</button></span>
    </div>
    <div class="sgpreview">${esc(preview)}</div>
    <div class="row"><button id="schedgen" class="primary">Generate</button></div>` : ''}`;
  const q = (id) => box.querySelector('#' + id);
  const again = () => renderCreator(box, env);
  q('schedrooms').onchange = () => { env.setRoomsN(Math.max(1, Number(q('schedrooms').value) || 1)); again(); };
  box.querySelectorAll('input[name="schedfmt"]').forEach((r) => { r.onchange = () => { ui.fmt = r.value; again(); }; });
  if (q('schedback')) q('schedback').onclick = () => { ui.creator = false; env.refresh(); };
  if (!fmts.length) return;
  q('optseed').onchange = () => { o.seeding = q('optseed').value; again(); };
  q('optorder').onchange = () => { o.roundOrder = q('optorder').value; again(); };
  q('optrooms').onchange = () => { o.rooms = q('optrooms').value; again(); };
  q('optreroll').onclick = () => { o.seed = 1 + Math.floor(Math.random() * 9999); again(); };
  q('schedgen').onclick = async () => {
    const key = (box.querySelector('input[name="schedfmt"]:checked') || {}).value || ui.fmt;
    if (env.sched() && !confirm('Replace the current schedule with a new ' + (fmts.find((f) => f.key === key) || {}).name + '?')) return;
    let s;
    try {
      s = buildSchedule(key, teams, roomList(env, nRooms), o);
      s.format = key;
      s.options = { ...o };
    } catch (e) { env.say(e.message, true); return; }
    // a generated schedule goes live right away — Save is for edits after
    const run = busy(q('schedgen'), { label: 'Generating' });
    env.setSched(s);
    ui.creator = false;
    resetEditor();
    try {
      await env.save(s);
      env.setDirty(false);
      ui.baseline = { obj: s, json: JSON.stringify(s) };
      env.say('Schedule saved');
    } catch (e) {
      env.setDirty(true);
      env.say('Not saved: ' + e.message, true);
    }
    run.end();
    env.refresh();
  };
}

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
  ui.past = [];
  ui.future = [];
  ui.filter = '';
  ui.closed = new Set();
  ui.note = '';
}

/* ================= editor ================= */

function renderEditor(box, env) {
  const s = env.sched();
  const phases = s.phases;
  const brackets = bracketRooms(s);
  if (ui.filter && !brackets.some((b) => b.key === ui.filter)) ui.filter = '';
  const again = () => renderEditor(box, env);
  // every edit: snapshot for Undo, mutate, mark dirty, redraw
  const edit = (note, fn) => {
    ui.past.push(JSON.stringify(s));
    if (ui.past.length > 100) ui.past.shift();
    ui.future = [];
    fn(s);
    ui.note = note;
    ui.mode = null;
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

  /* -- facts the grid, checks and panel share -- */
  const roundNo = phases.map((ph) => ph.rounds.map((r) => r.round));
  const checks = scheduleChecks(s);
  const warn = validateSchedule(s, env.teams).filter((w) => /^not on roster/.test(w))
    .map((w) => ({ sev: 1, kind: 'roster', text: w[0].toUpperCase() + w.slice(1) }));
  const norm = (x) => String(x || '').trim().toLowerCase();
  for (const b of env.buckets) {
    if (!s.rooms.some((r) => r.bucket === b.id || norm(r.name) === norm(b.room_name))) {
      warn.push({ sev: 1, kind: 'room', text: 'Room not on the schedule: ' + b.room_name });
    }
  }
  const allChecks = [...checks, ...warn];
  const bad = new Map(); // refKey -> 'twice' | 'again'
  for (const c of checks) {
    if (c.kind === 'twice') {
      const r = phases[c.p].rounds[c.r];
      for (const g of r.games) for (const side of ['a', 'b']) if (slotText(g[side]) === c.key) bad.set(refKey({ p: c.p, r: c.r, room: g.room, side }), 'twice');
      r.byes.forEach((b, i) => { if (slotText(b) === c.key) bad.set(refKey({ p: c.p, r: c.r, bye: i }), 'twice'); });
    }
  }
  const againCells = new Set(checks.filter((c) => c.kind === 'again').map((c) => cellKey(c)));
  const bracketName = (k) => (brackets.find((b) => b.key === k) || {}).name || '';
  const colorOf = new Map();
  phases.forEach((_, p) => brackets.filter((b) => b.phase === p).forEach((b, i) => colorOf.set(b.key + '@' + p, i % COLORS)));

  const sel = ui.sel;
  const isSel = (o) => sel && Object.keys(o).every((k) => sel[k] === o[k]);
  const nRounds = phases.reduce((n, ph) => n + ph.rounds.length, 0);
  const fmtName = (allFormats(env.teams.length).find((f) => f.key === s.format) || {}).name;
  const unsaved = env.dirty();

  /* -- the grid, one section per phase -- */
  const w = ui.dense ? 104 : 122;
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
    const tmpl = `40px repeat(${colList.length}, ${w}px) ${ui.dense ? 84 : 96}px`;
    return `
    <section class="sgphase">
      <button class="sgphasehead" data-phase="${p}"><span class="caret">${open ? '▾' : '▸'}</span>
        <b>${esc(ph.name)}</b><span class="muted">${ph.rounds.length ? `rounds ${first}–${last}` : 'no rounds'}${
        (ph.meet || 1) > 1 ? ` · pairs meet ${ph.meet} times` : ''}</span></button>
      ${open ? `
      <div class="sggrid${ui.dense ? ' dense' : ''}" style="grid-template-columns:${tmpl}">
        <div class="sgcorner"></div>
        ${lanes.map((l) => `<div class="sglane lane-${colorOf.get(l.key + '@' + p) ?? 'x'}" style="grid-column:span ${l.rooms.length}"><i></i>${esc(l.name)}</div>`).join('')}
        <div class="sglane sglane-byes">Byes</div>
        <div class="sgcorner sgcorner2"></div>
        ${colList.map((room) => `<button class="sgroom${isSel({ kind: 'room', room }) ? ' on' : ''}" data-room="${room}" title="${esc((s.rooms[room] || {}).name || '')}">${esc((s.rooms[room] || {}).name || 'Room ' + (room + 1))}</button>`).join('')}
        <div class="sgroom sgroom-byes"></div>
        ${ph.rounds.map((round, r) => `
          <div class="sgrnd${sel && sel.kind === 'round' && sel.p === p && sel.r === r ? ' on' : ''}">
            <span>${round.round}</span>
            <span class="rowtools">
              <button class="xbtn" data-insround="${p}.${r}" title="Insert a round after round ${round.round}" aria-label="Insert a round after round ${round.round}">+</button>
              <button class="xbtn" data-delround="${p}.${r}" title="Delete round ${round.round}" aria-label="Delete round ${round.round}">&times;</button>
            </span>
          </div>
          ${colList.map((room) => {
            const g = round.games.find((x) => x.room === room);
            const cell = { p, r, room };
            const csel = isSel({ kind: 'game', ...cell }) || isSel({ kind: 'empty', ...cell });
            if (!g || (!g.a && !g.b)) {
              return `<div class="sgcell empty${csel ? ' on' : ''}" data-cell='${JSON.stringify(cell)}' data-empty="1">
                <button class="sgadd" data-emptycell='${JSON.stringify(cell)}' aria-label="Empty room: add or move a game here">${ui.mode === 'moveGame' ? 'Move here' : ''}</button></div>`;
            }
            const off = g.bracket && lanes.length && !lanes.some((l) => l.key === g.bracket && l.rooms.includes(room));
            return `<div class="sgcell${csel ? ' on' : ''}${againCells.has(cellKey(cell)) ? ' again' : ''}" draggable="true" data-cell='${JSON.stringify(cell)}'>
              <button class="sgh" data-gh='${JSON.stringify(cell)}' title="Move or swap this whole game (or drag the card)" aria-label="Game options">&#8943;</button>
              ${off ? `<span class="sgtag" title="${esc(bracketName(g.bracket))}">${esc(bracketName(g.bracket))}</span>` : ''}
              ${['a', 'b'].map((side) => {
                const v = g[side];
                const ref = { p, r, room, side };
                const k = refKey(ref);
                return `<button class="sgslot${!v ? ' none' : v.label ? ' ph' : ''}${bad.get(k) ? ' bad' : ''}${isSel({ kind: 'slot', ...ref }) ? ' on' : ''}"
                  draggable="${v ? 'true' : 'false'}" data-ref='${JSON.stringify(ref)}'>${v ? esc(slotShow(v)) : 'empty'}</button>`;
              }).join(ui.dense ? '<span class="sgv">–</span>' : '')}
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
          <div class="sgtname">${esc(t)}</div>
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

  /* -- brackets -- */
  const mapHtml = `
    <div class="sgmap">
      <div class="sgmapcol"><div class="sgmapcard static"><b>${env.teams.length} teams</b><span class="muted">${
        s.pools ? 'seeded into pools' : 'one field'}</span></div></div>
      ${phases.map((ph, p) => `
        <span class="sgarrow">→</span>
        <div class="sgmapcol">
          <div class="muted sgmaphead">${esc(ph.name)} · ${ph.rounds.length ? `rounds ${roundNo[p][0]}–${roundNo[p][roundNo[p].length - 1]}` : 'no rounds'}</div>
          ${brackets.filter((b) => b.phase === p).map((b, i) => `
            <button class="sgmapcard" data-filter="${esc(b.key)}"><span><i class="lane-${i % COLORS}"></i><b>${esc(b.name)}</b></span>
              <span class="muted">${esc(s.pools && s.pools[b.key] ? s.pools[b.key].join(', ') : b.key === 'CH' ? 'Top half of each pool' : b.key === 'CO' ? 'Bottom half of each pool' : /^F\d+$/.test(b.key) ? 'Each pool’s ' + b.name.replace(' place', '') : '')}</span>
              <span class="muted small">${b.rooms.map((i2) => esc((s.rooms[i2] || {}).name || '')).join(' · ') || 'no rooms yet'}</span></button>`).join('')}
        </div>`).join('')}
    </div>`;

  /* -- side panel for the selection -- */
  const panel = sidePanel(s, env, { roundNo, bracketName, edit });

  box.innerHTML = `
    <div class="sghead">
      <span class="muted">${env.teams.length} teams · ${s.rooms.length} rooms · ${nRounds} rounds${fmtName ? ' · ' + esc(fmtName) : ''}</span>
      <button id="schedregen" class="linkbtn">Change format…</button>
      <span class="spacer" style="flex:1"></span>
      <div class="views sgviews">
        ${[['grid', 'Grid'], ['teams', 'By team'], ['brackets', 'Brackets']].map(([k, l]) =>
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
      <span class="spacer" style="flex:1"></span>
      ${ui.view === 'grid' ? `<button class="small" id="scheddense">${ui.dense ? 'Comfortable' : 'Compact'}</button>` : ''}
    </div>
    <div class="sgbar${unsaved ? ' unsaved' : ''}">
      <b>${unsaved ? (ui.past.length ? ui.past.length + ' unsaved change' + (ui.past.length === 1 ? '' : 's') : 'Unsaved changes') : 'Saved'}</b>
      <span class="muted">${esc(ui.note)}</span>
      <span class="spacer" style="flex:1"></span>
      <button id="schedaddround" class="small">Add round</button>
      <button id="schedaddroom" class="small">Add room</button>
      <button id="schedroomsbtn" class="small">Rooms</button>
      ${s.pools && hasPlaceholders(s) ? '<button id="schedfill" class="small">Fill playoff slots from standings</button>' : ''}
      <button id="schedundo" class="small" ${ui.past.length ? '' : 'disabled'}>Undo</button>
      <button id="schedredo" class="small" ${ui.future.length ? '' : 'disabled'}>Redo</button>
      <button id="scheddiscard" class="small" ${unsaved ? '' : 'disabled'}>Discard</button>
      <button id="schedsave" class="primary" ${unsaved ? '' : 'disabled'}>Save schedule</button>
      <button id="scheddel" class="small sgdel">Delete</button>
    </div>
    <div id="schedroomspanel" class="sgroomspanel" ${ui.roomsOpen ? '' : 'hidden'}>
      ${s.rooms.map((r, i) => `
      <div class="row">
        <input data-roomname="${i}" value="${esc(r.name)}" size="20" aria-label="Room name">
        <select data-roombucket="${i}" aria-label="Linked room page">
          <option value="">Not linked</option>
          ${env.buckets.map((b) => `<option value="${b.id}" ${b.id === r.bucket ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}
        </select>
      </div>`).join('')}
      <div class="muted small">A linked room's reader preselects its scheduled teams.</div>
    </div>
    <div class="sgbody">
      <div class="sgscroll" id="sgscroll">${ui.view === 'teams' ? teamHtml : ui.view === 'brackets' ? mapHtml : gridHtml}</div>
      <aside class="sgside">
        ${panel.html}
        <div class="sgchecks">
          <div class="sgchecktitle"><b>Checks</b> <span class="muted">${allChecks.length ? allChecks.length + ' to look at' : 'all clear'}</span></div>
          ${allChecks.length ? allChecks.slice(0, 12).map((c, i) => `
            <button class="sgcheck" data-check="${i}"><span class="${c.sev ? 'warnc' : 'bad'}">${c.sev ? '!' : '✕'}</span><span>${esc(c.text)}</span></button>`).join('')
            + (allChecks.length > 12 ? `<div class="muted small">${allChecks.length - 12} more</div>` : '')
            : '<div class="sgcheck ok"><span class="ok">✓</span><span>Every team plays once a round, no repeat pairings, no half-empty games</span></div>'}
        </div>
        <div class="muted small sghelp">Drag a team onto another to swap them, or onto Byes. Drag a game card (or ⋯) onto another game to trade places, or onto an empty room to move it. Or click, then use this panel.</div>
      </aside>
    </div>`;

  /* ---------- wiring ---------- */
  const $$ = (sel2) => box.querySelectorAll(sel2);
  const q = (id) => box.querySelector('#' + id);
  const parse = (x) => JSON.parse(x);
  const setSel = (x) => { ui.sel = x; ui.mode = null; again(); };
  const scroll = q('sgscroll');
  if (ui.scrollPos) { scroll.scrollLeft = ui.scrollPos[0]; scroll.scrollTop = ui.scrollPos[1]; }
  scroll.onscroll = () => { ui.scrollPos = [scroll.scrollLeft, scroll.scrollTop]; };

  $$('[data-view2]').forEach((b) => { b.onclick = () => { ui.view = b.dataset.view2; again(); }; });
  $$('[data-filter]').forEach((b) => { b.onclick = () => { ui.filter = b.dataset.filter; if (ui.view === 'brackets') ui.view = 'grid'; ui.scrollPos = null; again(); }; });
  $$('[data-phase]').forEach((b) => { b.onclick = () => { const p = Number(b.dataset.phase); if (ui.closed.has(p)) ui.closed.delete(p); else ui.closed.add(p); again(); }; });
  if (q('scheddense')) q('scheddense').onclick = () => { ui.dense = !ui.dense; again(); };
  $$('[data-jump]').forEach((b) => { b.onclick = () => { ui.view = 'grid'; ui.filter = ''; setSel(parse(b.dataset.jump)); scrollToSel(box); }; });
  $$('[data-check]').forEach((b) => {
    b.onclick = () => {
      const c = allChecks[Number(b.dataset.check)];
      if (c.p === undefined) return;
      ui.view = 'grid';
      ui.filter = '';
      ui.closed.delete(c.p);
      setSel(c.room !== undefined && c.room !== 'bye' ? { kind: 'game', p: c.p, r: c.r, room: c.room } : { kind: 'round', p: c.p, r: c.r });
      scrollToSel(box);
    };
  });

  // slots: click selects (or finishes a swap / game move); the panel acts
  $$('.sgslot').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const ref = parse(el.dataset.ref);
      if (ui.mode === 'swapSlot' && sel && sel.kind === 'slot') {
        if (refKey(sel) === refKey(ref)) { ui.mode = null; again(); return; }
        const a = { ...sel };
        edit(`Swapped ${slotShow(getSlot(s, a)) || 'an empty slot'} and ${slotShow(getSlot(s, ref)) || 'an empty slot'}`, (ss) => swapSlotsAt(ss, a, ref));
        ui.sel = null;
        again();
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
    ui.sel = { kind: 'game', ...to };
    again();
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
        ui.sel = null;
        again();
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
  $$('[data-room]').forEach((el) => { el.onclick = () => setSel({ kind: 'room', room: Number(el.dataset.room) }); });
  $$('[data-insround]').forEach((b) => {
    b.onclick = () => {
      const [p, r] = b.dataset.insround.split('.').map(Number);
      edit(`Inserted a round after round ${phases[p].rounds[r].round}`, (ss) => insertRound(ss, p, r));
    };
  });
  $$('[data-delround]').forEach((b) => {
    b.onclick = () => {
      const [p, r] = b.dataset.delround.split('.').map(Number);
      const round = phases[p].rounds[r];
      const filled = round.games.some((g) => g.a || g.b) || round.byes.length;
      if (filled && !confirm(`Delete round ${round.round}? Its games go too (Undo brings them back).`)) return;
      edit(`Deleted round ${round.round}`, (ss) => {
        removeRound(ss, p, r);
        if (!ss.phases[p].rounds.length && ss.phases.length > 1) ss.phases.splice(p, 1);
      });
    };
  });

  /* -- drag and drop -- */
  wireDrag(box, s, { edit, moveGameTo, again });

  /* -- panel actions -- */
  panel.wire(box);

  /* -- toolbar -- */
  q('schedaddround').onclick = () => edit('Added a round', (ss) => addRound(ss, ss.phases.length - 1));
  q('schedaddroom').onclick = () => edit('Added a room', (ss) => addRoomCol(ss, 'Room ' + (ss.rooms.length + 1)));
  q('schedroomsbtn').onclick = () => { ui.roomsOpen = !ui.roomsOpen; again(); };
  $$('[data-roomname]').forEach((inp) => {
    inp.onchange = () => edit('Renamed a room', (ss) => { ss.rooms[Number(inp.dataset.roomname)].name = inp.value.trim() || inp.value; });
  });
  $$('[data-roombucket]').forEach((sl) => {
    sl.onchange = () => edit('Linked a room', (ss) => { ss.rooms[Number(sl.dataset.roombucket)].bucket = sl.value ? Number(sl.value) : null; });
  });
  if (q('schedfill')) {
    q('schedfill').onclick = async () => {
      env.say('Computing standings…');
      try {
        const ranks = await env.fill();
        if (!ranks) { env.say('No game files uploaded yet — nothing to rank', true); return; }
        let n = 0;
        edit('Filled playoff slots from standings', (ss) => { n = fillPlaceholders(ss, ranks); });
        env.say(n + ' playoff slots filled from standings — check the grid, then Save');
      } catch (e) { env.say(e.message, true); }
    };
  }
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
  q('scheddel').onclick = async () => {
    if (!confirm('Delete the schedule? Rooms stop preselecting teams and the public page shows no schedule.')) return;
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
  q('schedregen').onclick = () => {
    if (env.dirty() && !confirm('You have unsaved edits. Pick a new format anyway? (Nothing changes until you press Generate.)')) return;
    ui.creator = true;
    ui.fmt = s.format || ui.fmt;
    if (s.options) ui.opts = { ...ui.opts, ...s.options };
    renderCreator(box, env);
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

/* ---------- the side panel ---------- */

function sidePanel(s, env, { roundNo, bracketName, edit }) {
  const sel = ui.sel;
  const btn = (id, label, cls = '') => `<button class="small ${cls}" data-act="${id}">${esc(label)}</button>`;
  const acts = {};
  let html = '';
  if (ui.mode === 'swapSlot' && sel) {
    html = `<b>Swap: pick the other team</b><span class="muted small">Click any team, in any round, or a bye. ${esc(slotShow(getSlot(s, sel)) || 'This slot')} goes there.</span>${btn('cancel', 'Cancel')}`;
    acts.cancel = () => { ui.mode = null; };
  } else if (ui.mode === 'moveGame' && sel) {
    html = `<b>Pick where this game goes</b><span class="muted small">Click another game to trade places, or an empty room to move it — any round.</span>${btn('cancel', 'Cancel')}`;
    acts.cancel = () => { ui.mode = null; };
  } else if (sel && sel.kind === 'slot') {
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
    const where = sel.bye !== undefined ? 'Byes' : (s.rooms[sel.room] || {}).name;
    html = `<b>${esc(cur ? slotShow(cur) : 'Empty slot')}</b><span class="muted small">Round ${n} · ${esc(where)}</span>
      ${free.length ? `<span class="sglabel">No game this round</span><div class="sgpick">${free.slice(0, 16).map(([k], i) => btn('free' + i, slotShow(everyone.get(k)), 'on')).join('')}</div>` : ''}
      ${onBye.length ? `<span class="sglabel">On a bye</span><div class="sgpick">${onBye.map(([k], i) => btn('bye' + i, slotShow(everyone.get(k) || { team: k }))).join('')}</div>` : ''}
      <label class="sglabel">Any team <select class="slotsel" data-act-sel="1"><option value="">Choose…</option>${[...everyone].map(([k, v]) =>
        `<option value="${esc(k)}">${esc(slotShow(v))}${inRound.has(k) ? ' (swaps)' : ''}</option>`).join('')}${cur ? '<option value="__clear">— Clear slot</option>' : ''}</select></label>
      <div class="sgpick">${btn('swap', 'Swap with…')}${cur && sel.bye === undefined ? btn('bench', 'Give a bye') : ''}${cur ? btn('clear', 'Clear') : ''}</div>`;
    const put = (k) => {
      const v = everyone.get(k) || { team: k };
      const other = inRound.get(k);
      if (other) {
        edit(`Round ${n}: swapped ${slotShow(cur) || 'empty'} and ${slotShow(v)}`, (ss) => swapSlotsAt(ss, sel, other));
      } else {
        edit(`Round ${n}: ${cur ? slotShow(cur) + ' → ' : ''}${slotShow(v)}`, (ss) => setSlotAt(ss, sel, v));
      }
    };
    free.slice(0, 16).forEach(([k], i) => { acts['free' + i] = () => put(k); });
    onBye.forEach(([k], i) => { acts['bye' + i] = () => put(k); });
    acts.swap = () => { ui.mode = 'swapSlot'; };
    acts.bench = () => { edit(`Round ${n}: ${slotShow(cur)} on a bye`, (ss) => { setSlotAt(ss, sel, null); ss.phases[sel.p].rounds[sel.r].byes.push(cur); }); ui.sel = null; };
    acts.clear = () => { edit('Cleared a slot', (ss) => setSlotAt(ss, sel, null)); };
    acts.__select = (value) => {
      if (!value) return;
      if (value === '__clear') acts.clear(); else put(value);
    };
  } else if (sel && sel.kind === 'game') {
    const g = gameAt(s, sel.p, sel.r, sel.room);
    if (g && (g.a || g.b)) {
      const round = s.phases[sel.p].rounds[sel.r];
      const brs = bracketRooms(s).filter((b) => b.phase === sel.p);
      html = `<b>${esc(slotShow(g.a) || '—')} v ${esc(slotShow(g.b) || '—')}</b>
        <span class="muted small">Round ${round.round} · ${esc((s.rooms[sel.room] || {}).name || '')}</span>
        ${brs.length > 1 ? `<label class="sglabel">Bracket <select data-act-br="1">${brs.map((b) => `<option value="${esc(b.key)}" ${b.key === g.bracket ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
        <div class="sgpick">${btn('move', 'Move or swap…', 'on')}${btn('flip', 'Flip sides')}${btn('remove', 'Remove (teams get byes)')}</div>`;
      acts.move = () => { ui.mode = 'moveGame'; };
      acts.flip = () => edit('Flipped sides', (ss) => { const gg = gameAt(ss, sel.p, sel.r, sel.room); [gg.a, gg.b] = [gg.b, gg.a]; });
      acts.remove = () => {
        edit(`Round ${round.round}: removed a game`, (ss) => {
          const rr = ss.phases[sel.p].rounds[sel.r];
          const gg = gameAt(ss, sel.p, sel.r, sel.room);
          rr.games.splice(rr.games.indexOf(gg), 1);
          for (const v of [gg.a, gg.b]) if (v) rr.byes.push(v);
        });
        ui.sel = null;
      };
      acts.__bracket = (key) => edit('Moved a game to ' + bracketName(key), (ss) => { gameAt(ss, sel.p, sel.r, sel.room).bracket = key; });
    }
  } else if (sel && sel.kind === 'empty') {
    const round = s.phases[sel.p].rounds[sel.r];
    html = `<b>Empty room</b><span class="muted small">Round ${round.round} · ${esc((s.rooms[sel.room] || {}).name || '')}</span>
      <div class="sgpick">${btn('add', 'Add a game here', 'on')}</div>`;
    acts.add = () => { ui.sel = { kind: 'slot', p: sel.p, r: sel.r, room: sel.room, side: 'a' }; };
  } else if (sel && sel.kind === 'room') {
    const room = s.rooms[sel.room];
    if (room) {
      html = `<b>${esc(room.name)}</b><span class="muted small">${esc(bracketRooms(s).filter((b) => b.rooms.includes(sel.room)).map((b) => b.name).join(', ') || 'No bracket')}</span>
        <label class="sglabel">Name <input data-act-name="1" value="${esc(room.name)}"></label>
        <label class="sglabel">Room page <select data-act-bucket="1"><option value="">Not linked</option>${env.buckets.map((b) =>
          `<option value="${b.id}" ${b.id === room.bucket ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}</select></label>
        <div class="sgpick">${btn('droproom', 'Remove room (its teams get byes)')}</div>`;
      acts.droproom = () => {
        const filled = s.phases.some((ph) => ph.rounds.some((r) => r.games.some((g) => g.room === sel.room && (g.a || g.b))));
        if (filled && !confirm(`Remove ${room.name}? Its teams drop to Byes (Undo brings them back).`)) return 'stay';
        edit('Removed ' + room.name, (ss) => {
          removeRoomCol(ss, sel.room);
          if (ss.brackets) ss.brackets.forEach((b) => { if (b.rooms) b.rooms = b.rooms.filter((i) => i !== sel.room).map((i) => (i > sel.room ? i - 1 : i)); });
        });
        ui.sel = null;
      };
      acts.__name = (v) => edit('Renamed a room', (ss) => { ss.rooms[sel.room].name = v.trim() || v; });
      acts.__bucket = (v) => edit('Linked a room', (ss) => { ss.rooms[sel.room].bucket = v ? Number(v) : null; });
    }
  } else if (sel && sel.kind === 'round') {
    html = `<b>Round ${s.phases[sel.p].rounds[sel.r].round}</b><span class="muted small">Problems in this round are outlined in red. Click a team to fix it.</span>`;
  }
  if (!html) {
    html = `<b>Nothing selected</b><span class="muted small">${esc(ui.note || 'Click a team, a game’s ⋯, an empty room or a room name.')}</span>`;
  }
  return {
    html: `<div class="sgpanel">${html}</div>`,
    wire(box) {
      const redraw = () => renderSchedStep(box, env);
      box.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => {
          const fn = acts[b.dataset.act];
          if (!fn) return;
          if (fn() === 'stay') return;
          redraw();
        };
      });
      const sl = box.querySelector('[data-act-sel]');
      if (sl) sl.onchange = () => { acts.__select(sl.value); redraw(); };
      const br = box.querySelector('[data-act-br]');
      if (br) br.onchange = () => { acts.__bracket(br.value); redraw(); };
      const nm = box.querySelector('[data-act-name]');
      if (nm) nm.onchange = () => { acts.__name(nm.value); redraw(); };
      const bk = box.querySelector('[data-act-bucket]');
      if (bk) bk.onchange = () => { acts.__bucket(bk.value); redraw(); };
    },
  };
}

/* ---------- drag and drop ---------- */

function wireDrag(box, s, { edit, moveGameTo }) {
  const scroll = box.querySelector('#sgscroll');
  if (!scroll) return;
  let drag = null; // {slot: ref} | {cell}
  const clear = () => {
    box.classList.remove('sg-drag-slot', 'sg-drag-game');
    box.querySelectorAll('.drop-ok').forEach((x) => x.classList.remove('drop-ok'));
    box.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
  };
  const targetOf = (el) => {
    if (!drag) return null;
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
    const slot = ev.target.closest && ev.target.closest('.sgslot');
    if (slot && slot.draggable) {
      drag = { slot: JSON.parse(slot.dataset.ref) };
      slot.classList.add('dragging');
      box.classList.add('sg-drag-slot');
    } else {
      const cell = ev.target.closest && ev.target.closest('.sgcell:not(.empty)');
      if (!cell) return;
      drag = { cell: JSON.parse(cell.dataset.cell) };
      cell.classList.add('dragging');
      box.classList.add('sg-drag-game');
    }
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
    if (d.slot && t.kind === 'slot') {
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
