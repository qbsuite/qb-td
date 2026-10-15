// Throwaway mock (mixed-rooms-hub.html): the real schedule step, plus
// what proposal C (editor) and the new format picker add to it. The demo
// has no Worker to save to, so Save and Generate only keep the schedule
// in the page.
//
// The picker (?pk=):
//   before  the picker today
//   a       (default) Format lists hdwhite's formats for the team count
//           (mixed-rooms-hdwhite.js) and the engine formats added on
//           purpose since (triple/quadruple round robins; two places per
//           pool from pools of 5+), as "8/8/7 → 6/6/6/5, crossover", then a
//           Custom group: Custom, and the engine's other formats. Picking one fills in the phases, which stay editable
//           (a change to the structure turns Format to Custom). A phase
//           can be copied (the same pools again: a fifth round robin).
//           A new phase starts standard: after 1–2 pools, top half and
//           bottom half; after more, two places a pool (top two of each
//           pool together, then the next two).
//           Prelims and playoffs both say their pools as sizes ("6/6"),
//           as the Format menu does ("6/6 → 6/6"); playoff pools fill in
//           finish order, and a Crossover box keeps pool-mates from
//           meeting again. Only problems show, as warnings. All build with mixed-rooms-custom.js.
//           Rounds are always shuffled.
// The real Generate still runs (its button and seed are moved into the
// new layout); its save swaps in the plan's build.
import { renderSchedStep as realRender } from '../app/js/schededit.js?real';
import { buildCustom, customPreview, customGroups, rebracketChecks, addFinals } from './mixed-rooms-custom.js';
import { poolSizes } from './mixed-rooms-engine.js';
import HDWHITE from './mixed-rooms-hdwhite.js';
import { allFormats } from './mixed-rooms-engine.js';

export * from '../app/js/schededit.js?real';

const QS = new URLSearchParams(location.search);
const PK = QS.get('pk') || 'a';

let plan = null;        // {fmt: a Format menu key or 'custom', seeding, phases: [...]}; null: not drawn yet
let generating = false; // Generate was pressed: its save gets the plan's build
let roomsN = null;      // the picker's room count
const watched = new WeakSet();

export function renderSchedStep(box, env) {
  // the demo always has two room links; this tournament has nine
  const sched = env.sched();
  const buckets = sched && sched.rooms.length > env.buckets.length
    ? sched.rooms.map((r, i) => ({ id: i + 1, room_name: r.name })) : env.buckets;
  if (roomsN === null) roomsN = buckets.length;
  const mine = {
    ...env,
    buckets,
    roomsN: () => roomsN,
    setRoomsN: (n) => { roomsN = n; },
    save: async (s) => {
      if (!generating || PK === 'before' || !plan) return;
      generating = false;
      // the real Generate built one of today's formats; this saves the plan instead
      const built = buildCustom(env.teams, s.rooms, withTies(plan), plan.seeding, s.options.seed);
      if (plan.finals) addFinals(built, customGroups(env.teams, plan.phases, plan.seeding, () => 0.5), plan.phases, plan.finalTies);
      const options = { seed: s.options.seed, plan: JSON.parse(JSON.stringify(plan)) };
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, built, { options });
    },
    del: async () => {},
  };
  if (!watched.has(box)) {
    watched.add(box);
    // each render sets box.innerHTML; patch each one
    new MutationObserver(() => patch(box, mine)).observe(box, { childList: true });
  }
  realRender(box, mine);
}

const ORDN = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const names = (xs) => (xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1));

function patch(box, env) {
  if (box.querySelector('#optrooms')) { if (PK !== 'before') patchPicker(box, env); return; }
  const s = env.sched();
  if (!s) return;
  if (PK !== 'before') patchEditor(box, env, s);
  // finals games are played only if needed: say when
  for (const el of box.querySelectorAll('.sgcell[data-cell]')) {
    const c = JSON.parse(el.dataset.cell);
    const g = s.phases[c.p].rounds[c.r].games.find((x) => x.room === c.room);
    if (g && g.ifNeeded && !el.querySelector('.mkifneeded')) el.insertAdjacentHTML('afterbegin', `<span class="sgtag mkifneeded" title="Played ${typeof g.ifNeeded === 'string' ? g.ifNeeded : 'if needed'}">If needed</span>`);
  }
  box.querySelectorAll('.sgphasehead').forEach((h) => {
    const ph = s.phases[Number(h.dataset.phase)];
    if (ph && ph.kind === 'tiebreak') h.querySelectorAll('.muted').forEach((m) => { if (!/if needed/.test(m.textContent)) m.textContent += ' · if needed'; });
    if (ph && ph.kind === 'final') h.querySelectorAll('.muted').forEach((m) => { m.textContent = m.textContent.replace(/ · pairs meet \d+ times/, ''); });
  });
  const lanes = (p) => (s.brackets || []).filter((b) => b.phase === p);
  const chip = box.querySelector('.sgchips .chip.on');
  const filter = chip ? chip.dataset.filter : '';
  for (const el of box.querySelectorAll('.sgcell[data-cell]')) {
    if (!el.querySelector('.sgtag')) continue;
    const c = JSON.parse(el.dataset.cell);
    const g = s.phases[c.p].rounds[c.r].games.find((x) => x.room === c.room);
    if (!g || !g.bracket) continue;
    el.classList.add('mx', 'lane-' + lanes(c.p).findIndex((b) => b.key === g.bracket));
    if (filter && lanes(c.p).some((b) => b.key === filter) && g.bracket !== filter) el.classList.add('dim');
  }
}

/* ---------- the editor ---------- */

// The editor's toolbar: rooms come from the Rooms step, so Add room and
// Rooms go; Add phase adds a phase after the last one, such as a final
// between the top two of a bracket (with a second game if needed).
let addOpen = false;
function patchEditor(box, env, s) {
  const bar = box.querySelector('.sgbar');
  if (!bar || bar.querySelector('[data-addphase]')) return;
  // the Compact switch goes too: the default (comfortable) is the one kept
  for (const id of ['schedaddroom', 'schedroomsbtn', 'scheddense']) { const b = box.querySelector('#' + id); if (b) b.remove(); }
  const panel = box.querySelector('#schedroomspanel');
  if (panel) panel.remove();
  const addRound = box.querySelector('#schedaddround');
  addRound.insertAdjacentHTML('afterend', '<button class="small" data-addphase>Add phase</button>');
  const last = s.phases.length - 1;
  const lastBrackets = (s.brackets || []).filter((b) => b.phase === last);
  const size = (key) => new Set(s.phases[last].rounds.flatMap((r) => r.games.filter((g) => g.bracket === key).flatMap((g) => [JSON.stringify(g.a), JSON.stringify(g.b)]))).size;
  const opt = (sel) => lastBrackets.map((b) => `<option value="${b.key}" ${b.key === sel ? 'selected' : ''}>${b.name}</option>`).join('');
  const places = (k) => Array.from({ length: Math.max(2, size(k)) }, (_, i) => `<option value="${i + 1}" ${i === 0 ? 'selected' : ''}>${['1st', '2nd', '3rd'][i] || i + 1 + 'th'}</option>`).join('');
  const top = lastBrackets[0] ? lastBrackets[0].key : '';
  const form = `<div class="sgnotice mkaddphase">
    <div class="mkgrid">
      <span class="mkl">Name</span><span><input data-apname value="Finals" size="16"></span>
      <span class="mkl">First game</span><span class="mkrooms"><select data-apa>${places(top)}</select> in <select data-apab>${opt(top)}</select>
        <span class="muted">against</span> <select data-apb>${places(top).replace('value="1" selected', 'value="1"').replace('value="2"', 'value="2" selected')}</select> in <select data-apbb>${opt(top)}</select></span>
      <span></span><label class="mkcheck"><input type="checkbox" data-apif checked> Play a second game if the first-place team loses</label>
    </div>
    <div class="row"><button class="small primary" data-apgo>Add phase</button><button class="small" data-apno>Cancel</button></div>
  </div>`;
  if (addOpen) bar.insertAdjacentHTML('afterend', form);
  box.querySelector('[data-addphase]').onclick = () => { addOpen = !addOpen; env.refresh(); };
  const q = (a) => box.querySelector(`[${a}]`);
  if (!addOpen) return;
  q('data-apno').onclick = () => { addOpen = false; env.refresh(); };
  q('data-apgo').onclick = () => {
    const nameOf = (k) => (lastBrackets.find((b) => b.key === k) || {}).name || '';
    const ord = (v) => ['1st', '2nd', '3rd'][v - 1] || v + 'th';
    const a = { label: `${ord(Number(q('data-apa').value))} in ${nameOf(q('data-apab').value)}` };
    const b = { label: `${ord(Number(q('data-apb').value))} in ${nameOf(q('data-apbb').value)}` };
    const name = q('data-apname').value.trim() || 'Finals';
    let round = Math.max(...s.phases.flatMap((p) => p.rounds.map((r) => r.round))) + 1;
    const key = 'FN' + (s.phases.length + 1);
    const rounds = [{ round: round++, games: [{ room: 0, a, b, bracket: key }], byes: [] }];
    if (q('data-apif').checked) rounds.push({ round: round++, games: [{ room: 0, a: { label: `Winner of ${name.toLowerCase()} game 1` }, b: { label: `Loser of ${name.toLowerCase()} game 1` }, bracket: key, ifNeeded: true }], byes: [] });
    s.phases.push({ name, rounds, meet: 1, kind: 'final' });
    s.brackets.push({ key, name, phase: s.phases.length - 1 });
    addOpen = false;
    env.setDirty(true);
    env.refresh();
  };
}

/* ---------- the plan ---------- */

const MODES = [['rotate', 'Teams rotate through rooms evenly'], ['keep', 'Teams stay in one room where possible'],
  ['shuffle', 'Teams get random rooms each round']];
const TIMES = [[1, 'once'], [2, 'twice'], [3, 'three times'], [4, 'four times']];
const TIES = [['pp20', 'Break ties by points per 20 tossups heard'], ['game', 'Break ties with a tiebreaker game']];
const TYPES = [['brackets', 'Pools'], ['same', 'The same pools again'], ['single', 'Single elimination'], ['double', 'Double elimination']];
const REPEAT = ['', 'double', 'triple', 'quadruple', 'quintuple', 'sextuple'];
const phase = (name, o = {}) => ({ name, kind: 'pools', groups: 1, top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1,
  carry: true, reset: true, byes: false, sizes: null, parallelTop: false, share: false, n: 3, mode: 'rotate', ...o });
const teamsOf = (t) => Array.from({ length: t }, (_, i) => 'T' + i);
const sizesOf = (gs) => gs.map((g) => g.members.length).join('/');

// phases for k pools played `cycles` times ("Round robin 1", "Round robin
// 2", … as the engine names a repeated round robin), then playoffs
function phasesFor({ k, cycles = 1, byes = false, sizes = null, parallelTop = false, carry = true, per = 1 }) {
  const out = [];
  const one = k === 1 && !sizes;
  for (let c = 0; c < cycles; c++) {
    const name = one ? (cycles > 1 ? 'Round robin ' + (c + 1) : 'Round robin') : cycles > 1 ? 'Prelims ' + (c + 1) : 'Prelims';
    out.push(phase(name, { groups: k, same: c > 0, byes }));
  }
  if (sizes) out.push(phase('Playoffs', { sizes, parallelTop, carry: k > 1 && carry, per }));
  return out;
}

// The Format menu for t teams: hdwhite's formats, then today's engine
// defaults that hdwhite doesn't have. Each: {key, label, phases, rounds, rooms}
const formatCache = new Map();
function formatList(t) {
  if (formatCache.has(t)) return formatCache.get(t);
  const raw = [];
  for (const f of HDWHITE[t] || []) raw.push({ key: 'hd' + f.key, phases: phasesFor({ ...f, carry: !f.repeat }), repeat: f.repeat, parallelTop: f.parallelTop, byes: f.byes });
  for (const f of allFormats(t)) {
    // engine formats added on purpose after the first version (git log):
    // triple and quadruple round robins (649d459) and brackets of two
    // places per pool (c6e1736, for 22 teams: 6/6/6/4) — those from pools
    // of at least 5. The rest of the engine's list goes under Custom.
    const rr = /^rr(\d?)$/.exec(f.key);
    if (rr) { raw.push({ key: f.key, more: !/^rr[34]$/.test(f.key), phases: phasesFor({ k: 1, cycles: Number(rr[1]) || 1 }) }); continue; }
    const m = /^pools(\d)(x2)?$/.exec(f.key);
    const k = Number(m[1]);
    // the playoff brackets as sizes in finish order
    const rows = customGroups(teamsOf(t), [phase('', { groups: k })], 'snake', () => 0.5)[0].map((g) => g.members.length);
    const deepest = Math.max(...rows);
    const at = (place) => rows.filter((x) => x >= place).length;
    const sizes = [];
    if (k === 2) { const top = rows.reduce((n, x) => n + Math.ceil(x / 2), 0); sizes.push(top, t - top); }
    else for (let pl = 1; pl <= deepest; pl += m[2] ? 2 : 1) sizes.push(at(pl) + (m[2] && pl + 1 <= deepest ? at(pl + 1) : 0));
    raw.push({ key: f.key, more: !(m[2] && Math.min(...rows) >= 5), phases: phasesFor({ k, sizes: sizes.filter((x) => x > 0), per: k === 2 ? -1 : 1 }) });
  }
  // build each once: its rounds, rooms, and who plays whom (for duplicates)
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    let s;
    try { s = buildCustom(teamsOf(t), Array.from({ length: 64 }, (_, i) => ({ name: 'R' + i, bucket: null })), x.phases, 'snake', 1); } catch (e) { continue; }
    // a duplicate plays the same games in the same number of rounds
    const sig = s.phases.map((p) => p.rounds.length + ':' + p.rounds.flatMap((r) => r.games.map((g) => [JSON.stringify(g.a), JSON.stringify(g.b)].sort().join())).sort().join(';')).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const g = customGroups(teamsOf(t), x.phases, 'snake', () => 0.5);
    const P = x.phases;
    const cycles = P.filter((p) => p.same || p === P[0]).length - (P[P.length - 1].sizes ? 0 : 0);
    const preCycles = P.filter((p) => !p.sizes).length;
    const left = P[0].groups === 1 ? String(t) : sizesOf(g[0]);
    const pre = left + (P[0].byes ? ' with byes' : '');
    let label;
    if (!P[P.length - 1].sizes) label = `${pre} → ${REPEAT[preCycles - 1] ? REPEAT[preCycles - 1] + ' round robin' : 'round robin'}`;
    else {
      const po = P[P.length - 1];
      const notes = [];
      if (preCycles > 1) notes.unshift(REPEAT[preCycles - 1] + ' round robin first');
      // crossover only says something when a bracket holds pool-mates
      const mates = g[g.length - 1].some((b) => new Set(b.members.map((m) => m.from)).size < b.members.length);
      if (P[0].groups > 1) notes.push(!mates ? 'by place' : po.carry ? 'crossover' : 'repeat matches');
      // parallel top brackets: the best teams split over two pools
      if (po.parallelTop) {
        const top = g[g.length - 1].filter((b) => b.tier === 0).reduce((k, b) => k + b.members.length, 0);
        notes.splice(notes.indexOf('by place'), notes.includes('by place') ? 1 : 0, `top ${top} in two pools`);
      }
      label = `${pre} → ${sizesOf(g[g.length - 1])}${notes.length ? ', ' + notes.join(', ') : ''}`;
    }
    void cycles;
    out.push({ key: x.key, more: !!x.more, label: `${label} · ${s.phases.reduce((n, p) => n + p.rounds.length, 0)} rounds`, phases: x.phases,
      rooms: Math.max(...s.phases.flatMap((p) => p.rounds.map((r) => r.games.length))) });
  }
  formatCache.set(t, out);
  return out;
}
// a plan for a Format menu entry (seeding and room settings carry over)
function planFor(key, t, from) {
  const f = formatList(t).find((x) => x.key === key);
  const phases = JSON.parse(JSON.stringify(f.phases));
  if (from) phases.forEach((p, i) => { const o = from.phases[Math.min(i, from.phases.length - 1)]; Object.assign(p, { share: o.share, n: o.n, mode: o.mode }); });
  // two parallel top pools only crown a champion with a final
  return { fmt: key, seeding: from ? from.seeding : 'snake', phases, finals: phases.some((p) => p.parallelTop) || !!(from && from.finals) };
}
// the default: the first format that fits the rooms (hdwhite's first)
function firstPlan(t, n) {
  const main = formatList(t).filter((x) => !x.more);
  const f = main.find((x) => x.rooms <= n) || main[0] || formatList(t)[0];
  // no format for this field (48 teams): pools of about 8 to start from
  const k = t <= 16 ? 1 : Math.ceil(t / 8);
  return f ? planFor(f.key, t) : { fmt: 'custom', seeding: 'snake', phases: [phase(k === 1 ? 'Round robin' : 'Prelims', { groups: k })] };
}
// numbered phase names: "Round robin" → "Round robin 1", "X 2" → "X 3"
const numbered = (name, i) => (/\s\d+$/.test(name) ? name.replace(/\d+$/, String(i)) : `${name} ${i}`);
function copyOf(P, p) {
  const src = P[p];
  if (!/\s\d+$/.test(src.name)) src.name = numbered(src.name, 1);
  const k = Number(/(\d+)$/.exec(src.name)[1]);
  return phase(numbered(src.name, k + 1), { same: true, groups: src.groups, byes: src.byes, share: src.share, n: src.n, mode: src.mode });
}

// Pool sizes for k pools of whole places after `prev` groups: the places
// split as evenly as can be, better places first (6 pools of 8, k = 6:
// places 1–2, 3–4, 5, 6, 7, 8 → 12/12/6/6/6/6). A last pool of one team
// would have no games, so it joins the pool above.
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
// The default next phase: as many pools as the phase before (at least
// two), of whole places. Top two of each pool together, or anything
// else, is a pool count or sizes away.
function standardNext(prev) {
  return { sizes: placeSizes(prev, Math.max(2, prev.length)), per: 1 };
}

// the plan's phases with its rebracketing ties on each rebracketing
const withTies = (pl) => pl.phases.map((x, i) => (i > 0 && !x.same ? { ...x, ties: pl.ties || 'pp20' } : x));

/* ---------- the picker ---------- */

function patchPicker(box, env) {
  // swapping in the new layout is itself a change to box: patch once
  if (box.querySelector('.mkpick')) return;
  const q = (s) => box.querySelector(s);
  const radio = q('input[name="schedfmt"]:checked') || q('input[name="schedfmt"]');
  const gen = q('#schedgen');
  const head = q('.sgcreatorhead');
  if (!radio || !gen || !head) return;
  const n = env.roomsN();
  const t = env.teams.length;
  if (!plan) {
    const o = (env.sched() || {}).options || {};
    plan = o.plan && o.plan.fmt && (o.plan.fmt === 'custom' || formatList(t).some((f) => f.key === o.plan.fmt && !f.more))
      ? JSON.parse(JSON.stringify(o.plan)) : firstPlan(t, n);
  }
  const P = plan.phases;
  const roomList = Array.from({ length: n }, (_, i) => ({ name: (env.buckets[i] || {}).room_name || 'Room ' + (i + 1), bucket: null }));
  const pv = customPreview(env.teams, roomList, withTies(plan), plan.seeding, 1);
  const groupsBy = customGroups(env.teams, P, plan.seeding, () => 0.5);

  const menu = (attr, list, on) => `<select ${attr}>${list.map(([v, l, off]) => `<option value="${v}" ${String(v) === String(on) ? 'selected' : ''}${off ? ' disabled' : ''}>${l}</option>`).join('')}</select>`;
  const nr = (p) => (pv.rounds[p] ? `<span class="mkrounds">${pv.rounds[p]} ${pv.rounds[p] === 1 ? 'round' : 'rounds'}</span>` : '');
  const lastRooms = (k) => names(roomList.map((r) => r.name).slice(n - k));
  // who goes where, with runs of places as ranges: "A1–A4, B1–B4",
  // "Round robin 1st–24th"
  const who = (groups) => `<span class="mkhelp">${groups.map((g) => {
    const out = [];
    for (let i = 0; i < g.members.length;) {
      const m = g.members[i];
      const run = [m];
      if (m.place && !String(m.from).startsWith('compared')) {
        const rest = g.members.filter((x) => x.from === m.from && x.place);
        rest.sort((x, y) => x.place - y.place);
        for (const x of rest) if (x !== m && x.place === run[run.length - 1].place + 1) run.push(x);
      }
      if (run.length >= 3) {
        const short = /^[A-Z]$/.test(m.from);
        out.push(short ? `${m.from}${run[0].place}–${m.from}${run[run.length - 1].place}`
          : `${m.slot.label.replace(/ \d+\w\w$/, '')} ${ORDN(run[0].place)}–${ORDN(run[run.length - 1].place)}`);
        g.members.forEach((x) => { if (run.includes(x)) x.__shown = true; });
      } else if (!m.__shown) out.push(m.slot.label || m.slot.team);
      i++;
      while (i < g.members.length && g.members[i].__shown) i++;
    }
    g.members.forEach((x) => { delete x.__shown; });
    return `${g.name}: ${out.join(', ')}`;
  }).join(' · ')}</span>`;
  const warn = (list) => (list.length ? `<span></span><span class="mkwarn">${list.map((x) => `<span>${x}</span>`).join('')}</span>` : '');
  const roomRows = (p, out, what) => {
    const ph = P[p];
    if (groupsBy[p].length > 1 && ph.kind === 'pools') {
      out.push(`<span class="mkl">Rooms</span>
      <span><label class="mkcheck"><input type="checkbox" data-share="${p}" ${ph.share ? 'checked' : ''}> Share rooms between ${what}</label>
        ${ph.share ? `<span class="mkshared"><input type="number" min="1" max="${n}" value="${ph.n}" data-n="${p}"> of ${n} rooms</span>
          <span class="mkhelp">${lastRooms(Math.min(ph.n, n))} take games from all ${what}, rotating each round.</span>` : ''}</span>`);
    }
    if (ph.kind === 'pools') out.push(`<span class="mkl">Room changes</span><span>${menu(`data-mode="${p}"`, MODES, ph.mode)}</span>`);
  };
  const sizesBox = (attr, sizes) => `<input class="mksizes" value="${sizes.join('/')}" ${attr} aria-label="Pool sizes">`;
  // "[2] pools of [7/6]": the count splits the teams evenly; the sizes can be edited
  const poolsRow = (countAttr, sizesAttr, sizes, max) => `<span class="mkl">Pools</span><span class="mkrooms">
    <input type="number" class="mkcount" min="1" max="${max}" value="${sizes.length}" ${countAttr} aria-label="Number of pools">
    <span class="muted">${sizes.length === 1 ? 'pool of' : 'pools of'}</span> ${sizesBox(sizesAttr, sizes)}</span>`;

  // the first phase: pool sizes ("6/6"; one number is a single round robin)
  const first = () => {
    const groups = groupsBy[0];
    const out = [];
    out.push(poolsRow('data-pcount', 'data-psizes', P[0].sizes || groups.map((g) => g.members.length), Math.floor(t / 2)));
    if (groups.length > 1) out.push(`<span class="mkl">Seeding</span><span>${menu('data-seed', [['snake', 'Snake by roster order'], ['random', 'Random']], plan.seeding)}</span>`);
    roomRows(0, out, 'pools');
    return `<div class="mkgrid">${out.join('')}</div>`;
  };

  // a later phase: pools by finish, the same pools again, or elimination
  const later = (p) => {
    const ph = P[p];
    const groups = groupsBy[p];
    const out = [];
    const prev = groupsBy[p - 1];
    const prevName = P[p - 1].name.toLowerCase();
    const type = ph.same ? 'same' : ph.kind === 'pools' ? 'brackets' : ph.kind;
    out.push(`<span class="mkl">Type</span><span>${menu(`data-type="${p}"`, TYPES, type)}</span>`);
    const warnings = [];
    if (type === 'same') { /* the same pools: nothing to set */ }
    else if (type === 'brackets') {
      // sizes in finish order: the best places fill the first pool
      const sizes = ph.sizes || groups.map((g) => g.members.length);
      const playing = prev.reduce((k, g) => k + g.members.length, 0);
      const sum = sizes.reduce((a, b) => a + b, 0);
      out.push(poolsRow(`data-count="${p}"`, `data-sizes="${p}"`, sizes, Math.max(1, Math.floor(playing / 2))));
      if (sum > playing) warnings.push(`The pools hold ${sum} teams, but only ${playing} play on.`);
      else if (sum < playing) out.push(`<span></span><span class="mkhelp">The other ${playing - sum} teams are done after ${prevName}.</span>`);
      if (groups.some((g) => new Set(g.members.map((m) => m.from)).size < g.members.length)) {
        out.push(`<span class="mkl">Crossover</span><label class="mkcheck"><input type="checkbox" data-carry="${p}" ${ph.carry ? 'checked' : ''}> Teams from the same pool don’t play again</label>`);
      }
      out.push(`<span></span>${who(groups)}`);
      if (groups.split && groups.split.length) {
        const pl = names(groups.split.map((x) => ORDN(x)));
        out.push(`<span></span><span class="mkhelp mknote">${groups.split.length === 1 ? `Only some ${pl}-place teams` : `Only some teams of ${pl} place`} go up. They are compared by winning percentage, then points per 20 tossups heard.</span>`);
      }
    } else {
      const full = Math.max(...prev.map((g) => g.members.length));
      out.push(`<span class="mkl">Who plays</span><span class="mkrooms">The top <input type="number" min="1" max="${full}" value="${ph.top || full}" data-top="${p}"> <span class="muted">from each pool</span></span>`);
      if (type === 'double') out.push(`<span></span><label class="mkcheck"><input type="checkbox" data-reset="${p}" ${ph.reset ? 'checked' : ''}> A second final if the unbeaten team loses</label>`);
    }
    for (const c of rebracketChecks(groupsBy, P, p)) if (!c.ok) warnings.push(c.text);
    out.push(warn(warnings));
    roomRows(p, out, 'pools');
    return `<div class="mkgrid">${out.join('')}</div>`;
  };

  const rebracketing = P.some((x, i) => i > 0 && !x.same && x.kind === 'pools');
  const canCopy = (p) => P[p].kind === 'pools' && groupsBy[p].some((g) => g.members.length > 1);
  const headOf = (p) => `<h3 class="mksec"><input class="mkname" data-name="${p}" size="${Math.max(6, P[p].name.length + 1)}" value="${P[p].name.replace(/"/g, '&quot;')}" aria-label="Phase name"> ${nr(p)}
    <span class="mktools">${canCopy(p) ? `<button class="linkbtn" data-copy="${p}">Copy this phase</button>` : ''}${p > 0 ? `<button class="linkbtn" data-del="${p}">Remove</button>` : ''}</span></h3>`;
  const canAdd = P[P.length - 1].kind === 'pools' && groupsBy[P.length - 1].some((g) => g.members.length > 1);
  // Finals: 1st against 2nd of the top pool (or the two top pools' winners)
  const finalsBox = (() => {
    if (P.length < 2 && groupsBy[0].length > 1) return '';
    const probe = { phases: [{ rounds: [{ round: 0 }] }], brackets: [] };
    const f = addFinals(probe, groupsBy, P);
    if (!f) return '';
    return `<h3 class="mksec">Finals</h3><div class="mkgrid">
      <span></span><label class="mkcheck"><input type="checkbox" data-finals ${plan.finals ? 'checked' : ''}> Enable finals sequence if needed</label>
      ${plan.finals ? `<span></span><span class="mkhelp">${f.parallel ? 'One game between the two top pools’ winners.'
        : 'If leader clears by two games, no final. Advantaged final if leader is up by one game, otherwise one game final.'}</span>
      <span class="mkl">Ties</span><span>${menu('data-fties', TIES, plan.finalTies || 'pp20')}
        ${plan.finalTies === 'game' ? '<span class="mkhelp">A round is kept free before the finals for a tiebreaker game, if needed.</span>' : ''}</span>` : ''}
    </div>`;
  })();
  const body = P.map((_, p) => headOf(p) + (p === 0 ? first() : later(p))).join('')
    + (canAdd ? `<div><button class="linkbtn mkadd" data-add>Add another phase</button></div>` : '');
  // the Format menu: hdwhite's formats and our own additions, then Custom
  const optOf = (f) => `<option value="${f.key}" ${f.key === plan.fmt ? 'selected' : ''}${f.rooms > n ? ' disabled' : ''}>${f.label}${f.rooms > n ? ` (needs ${f.rooms} rooms)` : ''}</option>`;
  const fmtMenu = `<select data-fmt>${formatList(t).filter((f) => !f.more).map(optOf).join('')}
    <option value="custom" ${plan.fmt === 'custom' ? 'selected' : ''}>Custom</option></select>`;

  const wrap = document.createElement('div');
  wrap.className = 'mkpick';
  wrap.innerHTML = `
    <div class="mkgrid">
      <span class="mkl">Rooms</span><span class="mkrooms" data-slot="rooms"></span>
      <span class="mkl">Format</span><span>${fmtMenu}</span>
      ${rebracketing ? `<span class="mkl">Rebracketing ties</span><span>${menu('data-ties', TIES, plan.ties || 'pp20')}
        ${plan.ties === 'game' ? '<span class="mkhelp">A round is kept free before each rebracketing for tiebreaker games, if needed.</span>' : ''}</span>` : ''}
    </div>
    ${body}
    ${finalsBox}
    <div class="sgpreview">${pv.ok ? (() => {
      const total = pv.rounds.reduce((a, b) => a + b, 0);
      const fin = plan.finals && finalsBox ? (/One game between/.test(finalsBox) ? 1 : 2) : 0;
      const tb = pv.tiebreak + (fin && plan.finalTies === 'game' ? 1 : 0);
      const extra = [tb ? `${tb} for tiebreakers` : '', fin ? (fin === 1 ? 'a final' : '2 for finals') : ''].filter(Boolean);
      return `<span class="mktotal"><b>${total} rounds</b>${extra.length ? ` <span>plus up to ${extra.join(' and ')}</span>` : ''}</span>`
        + `<span class="muted">${pv.text.split(' · ').slice(1).join(' · ')}</span>`;
    })() : `<span class="mkwarn"><span>${pv.text}</span></span>`}</div>
    <div class="mkfoot"><span data-slot="gen"></span><span data-slot="seedbox"></span></div>`;
  const slot = (k, el) => { const at = wrap.querySelector(`[data-slot="${k}"]`); if (at && el) at.replaceWith(el); else if (at) at.remove(); };
  const roomsCell = document.createElement('span');
  roomsCell.className = 'mkrooms';
  roomsCell.append(Object.assign(document.createElement('span'), { textContent: `${n} rooms for ${t} teams` }),
    Object.assign(document.createElement('span'), { className: 'muted', textContent: 'from the Rooms step' }));
  q('#schedrooms').style.display = 'none';
  slot('rooms', roomsCell);
  slot('gen', gen);
  // rounds are always shuffled, so the seed always matters
  const seedBox = q('.sgseed');
  if (seedBox) { seedBox.classList.remove('muted'); const rr = seedBox.querySelector('button'); if (rr) rr.disabled = false; }
  slot('seedbox', seedBox);
  gen.disabled = !pv.ok;
  // today's picker stays, out of sight, for its handlers (its own
  // classes set display, which beats hidden)
  for (const el of [q('.sgfmts'), q('.sgopts'), q('.sgpreview'), q('.sgcreatorhead')]) if (el) el.style.display = 'none';
  head.replaceWith(wrap);

  // each change redraws the picker the way the real one does; a change to
  // the structure turns Format to Custom (seeding and rooms don't)
  const redraw = () => radio.dispatchEvent(new Event('change'));
  const each = (attr, ev, fn, shape = true) => wrap.querySelectorAll(`[${attr}]`).forEach((el) => {
    el[ev] = () => { fn(el, Number(el.getAttribute(attr))); if (shape) plan.fmt = 'custom'; redraw(); };
  });
  each('data-fmt', 'onchange', (el) => { if (el.value === 'custom') plan.fmt = 'custom'; else plan = planFor(el.value, t, plan); }, false);
  // the prelims changed: later phases keep their number of pools, split
  // evenly over the teams that now play on
  const resplit = () => {
    for (let i = 1; i < P.length; i++) {
      const x = P[i];
      if (x.same || x.kind !== 'pools') continue;
      Object.assign(x, standardNext(customGroups(env.teams, P.slice(0, i), plan.seeding, () => 0.5)[i - 1]));
    }
  };
  each('data-pcount', 'onchange', (el) => {
    const k = Math.max(1, Math.min(Math.floor(t / 2), Number(el.value) || 1));
    Object.assign(P[0], { sizes: poolSizes(t, k), groups: k });
    if (P[0].name === 'Round robin' && k > 1) P[0].name = 'Prelims';
    if (k === 1 && P.length === 1) P[0].name = 'Round robin';
    resplit();
  });
  each('data-count', 'onchange', (el, p) => {
    // whole places in each pool, as even as can be: 2 pools after pools
    // of 8 are places 1–4 and 5–8 (type the sizes to cut a place)
    P[p].sizes = placeSizes(groupsBy[p - 1], Math.max(1, Number(el.value) || 1));
    P[p].per = 1;
  });
  each('data-psizes', 'onchange', (el) => {
    const sizes = el.value.split(/[^\d]+/).map(Number).filter((x) => x > 0);
    if (!sizes.length) return;
    Object.assign(P[0], { sizes, groups: sizes.length });
    P[0].name = sizes.length === 1 && P.length === 1 ? 'Round robin' : P[0].name === 'Round robin' ? 'Prelims' : P[0].name;
    resplit();
  });
  each('data-type', 'onchange', (el, p) => {
    const v = el.value;
    Object.assign(P[p], { same: v === 'same', kind: v === 'single' || v === 'double' ? v : 'pools', sizes: null, top: 0 });
    // elimination usually takes the top teams: start on the top 2 of each pool
    if ((v === 'single' || v === 'double') && !P[p].top) P[p].top = Math.min(2, Math.ceil(t / P[p - 1].groups));
    if (v === 'single' || v === 'double') { P.splice(p + 1); }
  });
  each('data-sizes', 'onchange', (el, p) => {
    const sizes = el.value.split(/[^\d]+/).map(Number).filter((x) => x > 0);
    P[p].sizes = sizes.length ? sizes : null;
  });
  each('data-byes', 'onchange', (el, p) => { P[p].byes = el.checked; });
  each('data-seed', 'onchange', (el) => { plan.seeding = el.value; }, false);
  each('data-top', 'onchange', (el, p) => { P[p].top = Math.max(1, Number(el.value) || 1); });
  each('data-ties', 'onchange', (el) => { plan.ties = el.value; }, false);
  each('data-fties', 'onchange', (el) => { plan.finalTies = el.value; }, false);
  each('data-carry', 'onchange', (el, p) => { P[p].carry = el.checked; });
  each('data-reset', 'onchange', (el, p) => { P[p].reset = el.checked; });
  each('data-share', 'onchange', (el, p) => { P[p].share = el.checked; P[p].n = Math.min(P[p].n || groupsBy[p].length, n); }, false);
  each('data-n', 'onchange', (el, p) => { P[p].n = Math.max(1, Math.min(n, Number(el.value) || 1)); }, false);
  each('data-mode', 'onchange', (el, p) => { P[p].mode = el.value; }, false);
  each('data-name', 'onchange', (el, p) => { P[p].name = el.value.trim() || P[p].name; }, false);
  each('data-finals', 'onchange', (el) => { plan.finals = el.checked; }, false);
  each('data-copy', 'onclick', (el, p) => { P.splice(p + 1, 0, copyOf(P, p)); });
  each('data-del', 'onclick', (el, p) => { P.splice(p, 1); });
  each('data-add', 'onclick', () => {
    const prev = groupsBy[P.length - 1];
    // after tiered brackets a re-cut would give the same pools back: play them again
    if (new Set(prev.map((g) => g.tier || 0)).size > 1) {
      P.push(phase('Phase ' + (P.length + 1), { same: true, mode: P[P.length - 1].mode }));
      return;
    }
    P.push(phase(P.length > 1 ? 'Phase ' + (P.length + 1) : 'Playoffs', { mode: P[P.length - 1].mode, carry: P[0].groups > 1, ...standardNext(prev) }));
  });
  gen.addEventListener('click', () => { generating = true; }, { capture: true });
}
