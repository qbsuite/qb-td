// tiebox.js — the Live Hub's Ties box: how each tie for a place was broken
// under the tournament's tie order (stats.js), and the ties the order left
// for the TD to pick, one place at a time.
//
// A broken tie is one of schedule.filled's notes with an `order` (finals.js
// levelOf): its teams, the step that decided it and their figures. The
// newest cut comes first (Playoffs → Finals above Prelims → Playoffs).
// Confirm hides a note (`confirmed` on it, saved with the schedule); "N
// confirmed · Show" brings them back.
//
// A tie the order reached You pick on waits in autoFill / finalsFill
// (`needPick`). The TD names who takes each place in turn; the last one
// left takes the last. Fill saves the order as schedule.tiePicks ({at: the
// pool, or 'F:' + the Finals source; order: best first}) and the hub
// refills from it; Change takes the pick back out.
import { esc } from './api.js';
import { tieBlock } from '../engine/deciderphases.js';

const ORD = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const andList = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
const clone = (x) => JSON.parse(JSON.stringify(x));
export const STEP_LABEL = { game: 'Tiebreaker game', ppg: 'PPG', h2h: 'Head-to-head', ppb: 'PPB', pick: 'You pick' };
const STEP_SHORT = { ...STEP_LABEL, game: 'Tiebreaker game (if exists)' };
/** "Tiebreaker game (if exists) → PPG → Head-to-head → PPB → You pick" */
export const orderText = (order) => order.map((c) => STEP_SHORT[c]).join(' → ');

/**
 * h: what the hub lends. sched() / save(s) (the schedule, saved; resolves
 * once it is), refill() (the hub's auto-fill, at once), order() (the tie
 * order), packets(block) (tiebreaker packets uploaded, block 'pre' or
 * 'fin'), played(phaseIndex) (a game in that phase is in), held() and
 * heldFinals() (the fills' waiting ties), goPackets(), goSchedule(),
 * render(), say(text, bad).
 */
export function makeTieBox(h) {
  let showDone = false;
  const seq = {}; // a pick in progress: {key: [names…]}

  // the cut a note or a waiting tie belongs to: its name, the phase it fills, its packets' block
  function cutOf(s, x) {
    if (x.pool) {
      const next = s.phases.findIndex((ph) => (ph.rounds || []).some((r) => (r.games || []).some((g) => [g.a, g.b].some((sl) => sl && new RegExp('^' + x.pool + '\\d+$').test(sl.label || sl.from || '')))));
      const into = next > 0 ? next : 1;
      return { key: 'pre', name: `${s.phases[0].name} → ${(s.phases[into] || s.phases[s.phases.length - 1]).name}`, phase: into, block: 'pre', rank: 0 };
    }
    const b = (s.brackets || []).find((y) => y.name === x.bracket);
    const from = b ? b.phase : 0;
    // the phase whose slots read this bracket's places
    const end = ' in ' + x.bracket;
    let into = s.phases.findIndex((ph, i) => i > from && (ph.rounds || []).some((r) => (r.games || []).some((g) => [g.a, g.b].some((sl) => sl && String(sl.label || sl.from || '').endsWith(end)))));
    if (into < 0) into = Math.min(from + 1, s.phases.length - 1);
    return { key: 'b:' + from, name: `${s.phases[from].name} → ${s.phases[into].name}`, phase: into, block: tieBlock(s, 'F:' + x.bracket), rank: 1 + from };
  }
  // where a pool's tie is: the pool's bracket name when there are pools to tell apart, else the phase
  function whereOf(s, x) {
    if (!x.pool) return x.bracket;
    if (Object.keys(s.pools || {}).length < 2) return s.phases[0].name;
    const b = (s.brackets || []).find((y) => y.key === x.pool && y.phase === 0);
    return b ? b.name : 'Pool ' + x.pool;
  }
  const places = (x) => andList(x.teams.map((t) => ORD(t.place)));
  const cell = (x, c, t, k) => {
    const f = (x.figures || {})[t.name] || {};
    if (c === 'ppg' || c === 'ppb') return Number.isFinite(f[c]) ? f[c].toFixed(2) : '–';
    if (c === 'h2h') return f.h2h || '–';
    if (c === 'game') return k === 0 ? 'Won' : 'Lost';
    if (c === 'pick') return String(k + 1);
    return '';
  };
  // the ladder table: the order's columns, the one that decided tinted, the ones after it faded
  function table(x, finals) {
    const cols = x.order.filter((c) => (c !== 'game' && c !== 'pick') || c === x.decidedBy);
    const at = cols.indexOf(x.decidedBy);
    const cls = (i) => (at < 0 ? '' : i === at ? 'dec' : i > at ? 'unused' : '');
    const head = cols.map((c, i) => `<th class="${cls(i)}">${STEP_LABEL[c]}${i === at ? '<span class="st">✓ decided</span>' : ''}</th>`).join('');
    const rows = x.teams.map((t, k) => `<tr><td class="pl">${ORD(t.place)}</td><td class="nm"><span title="${esc(t.name)}">${esc(t.name)}</span></td><td>${esc(x.record)}</td>
      ${cols.map((c, i) => `<td class="${cls(i)}${i === at && k === 0 ? ' win' : ''}">${esc(cell(x, c, t, k))}</td>`).join('')}
      <td class="to">${finals ? `<b>${ORD(t.place)} place</b>` : (t.bracket || t.to) ? '→ ' + esc(t.bracket || t.to) : ''}</td></tr>`).join('');
    return `<div class="tiewrap"><table class="tietable"><tr><th></th><th></th><th>Record</th>${head}<th></th></tr>${rows}</table></div>`;
  }
  const noteId = (x) => (x.pool ? 'p:' + x.pool : 'b:' + x.bracket) + '|' + x.record + '|' + x.teams.map((t) => t.name).join('|');

  /* ---- a tie the order left to the TD: who takes each place ---- */
  function pickRuns(s, x) {
    return x.needPick.map((run) => {
      const tm = run.map((n) => x.teams.find((t) => t.name === n)).filter(Boolean).sort((p, q) => p.place - q.place);
      // where each place goes, in order: [[bracket, how many]…]
      const split = [];
      for (const t of tm) {
        const to = x.pool ? t.bracket : (t.place <= x.deepest ? t.to || s.phases[s.phases.length - 1].name : null);
        const last = split[split.length - 1];
        if (last && last[0] === to) last[1]++; else split.push([to, 1]);
      }
      return { key: (x.pool || 'F:' + x.bracket) + '|' + run.slice().sort().join('|'), at: x.pool || 'F:' + x.bracket, teams: tm, split };
    });
  }
  const destOf = (split, i) => { let k = i; for (const [b, c] of split) { if (k < c) return { b, last: k === c - 1 }; k -= c; } return { b: '', last: false }; };
  function pickHtml(s, x, r) {
    const all = r.teams.map((t) => t.name);
    const got = (seq[r.key] || []).filter((n) => all.includes(n));
    const k = got.length, first = r.teams[0].place, n = all.length;
    const left = all.filter((m) => !got.includes(m));
    const d = destOf(r.split, k);
    const more = r.split.findIndex(([b]) => b === d.b) < r.split.length - 1;
    const splitText = r.split.filter(([b]) => b).map(([b, c]) => `${c} to ${b}`).join(', ');
    const fig = (m, c) => cell(x, c, { name: m }, 0);
    const rung = got.map((m, i) => `<div class="rung"><span><span class="sd">${ORD(first + i)}</span> ${esc(m)}</span><span class="sd">${destOf(r.split, i).b ? '→ ' + esc(destOf(r.split, i).b) : ''}</span></div>`).join('');
    const ask = k < n - 1 ? `<div class="pickask"><b>Who takes ${ORD(first + k)} place?</b> <span class="sub">${d.b ? (d.last && more ? `The last ${esc(d.b)} spot` : esc(d.b)) : ''}</span></div>
      <div class="pickbtns">${left.map((m) => `<button data-tiepick="${esc(r.key)}" data-team="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : '';
    return `<div class="tiepick lane-0"><div class="tiehd"><b>Tie for ${ORD(first)}–${ORD(first + n - 1)} place</b><span class="sub">${esc(whereOf(s, x))} · ${esc(x.record)}${splitText ? ' · ' + esc(splitText) : ''}</span></div>
      <div class="tiewrap"><table class="tietable"><tr><th></th><th>Team</th><th>PPG</th><th>Head-to-head</th><th>PPB</th></tr>
        ${all.map((m) => `<tr><td></td><td class="nm"><span title="${esc(m)}">${esc(m)}</span></td><td>${esc(fig(m, 'ppg'))}</td><td>${esc(fig(m, 'h2h'))}</td><td>${esc(fig(m, 'ppb'))}</td></tr>`).join('')}</table></div>
      <div class="rungs">${rung}</div>${ask}
      <div class="tieacts">${k ? `<button class="linkbtn" data-tieback="${esc(r.key)}">Undo</button>` : ''}${k >= n - 1 ? `<button class="primary" data-tiefill="${esc(r.key)}" data-at="${esc(r.at)}">${x.pool ? 'Fill the playoffs' : 'Fill the Finals'}</button>` : ''}</div></div>`;
  }

  function html() {
    const s = h.sched();
    if (!s) return '';
    const order = h.order();
    const notes = (s.filled || []).filter((x) => x.order);
    const waiting = [...h.held(), ...h.heldFinals()].filter((x) => x.order && x.needPick && x.needPick.length && !(x.needGame && x.needGame.length && h.packets(tieBlock(s, x.pool || 'F:' + x.bracket))));
    if (!notes.length && !waiting.length) return '';
    const cuts = new Map();
    const cutFor = (x) => { const c = cutOf(s, x); if (!cuts.has(c.key)) cuts.set(c.key, { ...c, picks: [], ties: [] }); return cuts.get(c.key); };
    let runs = [];
    for (const x of waiting) for (const r of pickRuns(s, x)) { cutFor(x).picks.push(pickHtml(s, x, r)); runs.push(r); }
    const nDone = notes.filter((x) => x.confirmed).length;
    let noPackets = false, stands = null;
    for (const x of notes.filter((y) => !y.confirmed || showDone).sort((p, q) => (q.at || 0) - (p.at || 0))) {
      const c = cutFor(x);
      const id = noteId(x);
      const picked = x.decidedBy === 'pick';
      const act = x.confirmed ? `<span class="sub">Confirmed</span> <button class="linkbtn" data-tieundo="${esc(id)}">Undo</button>`
        : `${picked ? `<button class="linkbtn" data-tiechange="${esc(id)}">Change</button>` : ''}<button class="small" data-tieok="${esc(id)}">Confirm</button>`;
      // a tie for a bracket's places that fills a Finals names the place; one that fills playoffs, where it was
      const finals = !x.pool && (s.phases[c.phase] || {}).kind === 'final';
      const head = finals ? `Tie for ${places(x)} place` : `Tie for ${places(x)} in ${esc(whereOf(s, x))}`;
      c.ties.push(`<div class="tie${x.confirmed ? ' isdone' : ''}"><div class="tiehd"><b>${head}</b><span class="sub">${esc(x.record)}${x.decidedBy ? ' · Decided by: ' + STEP_LABEL[x.decidedBy] : ''}</span>
        <span class="spacer"></span>${act}</div>${table(x, finals)}</div>`);
      // a tiebreaker game came before the step that decided it, but none could be played
      const gameFirst = x.order.indexOf('game') >= 0 && x.decidedBy && x.decidedBy !== 'game' && x.order.indexOf('game') < x.order.indexOf(x.decidedBy);
      // (only where its teams went different ways: a game would have changed where they play)
      const apart = new Set(x.teams.map((t) => (finals ? t.to || null : t.bracket || t.to || null))).size > 1;
      if (!x.confirmed && gameFirst && apart && !h.packets(c.block)) {
        if (h.played(c.phase)) stands = stands || (finals ? 'A Finals game is in, so this result stands.' : 'A playoff game is in, so this result stands.');
        else noPackets = true;
      }
    }
    const list = [...cuts.values()].sort((p, q) => q.rank - p.rank).filter((c) => c.picks.length || c.ties.length);
    h.runs = runs;
    const foot = [
      `<div class="tieorder">Ties: ${esc(orderText(order))} · <button class="linkbtn" data-tieorder>Change</button></div>`,
      noPackets ? '<div class="tieorder">No tiebreaker packets uploaded. <button class="linkbtn" data-tiepackets>Add them here.</button></div>'
        : stands ? `<div class="tieorder">${stands}</div>` : '',
      nDone ? `<div class="tieorder">${nDone} confirmed · <button class="linkbtn" data-tieshow>${showDone ? 'Hide' : 'Show'}</button></div>` : '',
    ].join('');
    return `<section class="tiebox" id="tiebox"><div class="tieh">Ties</div>${list.map((c) => `<div class="tiecut"><div class="tiecuth">${esc(c.name)}</div>${c.picks.join('')}${c.ties.join('')}</div>`).join('')}
      ${!list.length ? '<div class="sub tienone">Nothing new.</div>' : ''}${foot}</section>`;
  }

  const saveWith = async (fn) => {
    const s = clone(h.sched());
    fn(s);
    await h.save(s);
  };
  function wire(box) {
    const on = (sel, fn) => box.querySelectorAll(sel).forEach((el) => { el.onclick = () => fn(el); });
    const mark = (id, v) => saveWith((s) => { for (const x of s.filled || []) if (x.order && noteId(x) === id) { if (v) x.confirmed = true; else delete x.confirmed; } })
      .then(() => h.render()).catch((e) => h.say(e.message, true));
    on('[data-tieok]', (el) => mark(el.dataset.tieok, true));
    on('[data-tieundo]', (el) => mark(el.dataset.tieundo, false));
    on('[data-tieshow]', () => { showDone = !showDone; h.render(); });
    on('[data-tieorder]', () => h.goSchedule());
    on('[data-tiepackets]', () => h.goPackets());
    on('[data-tiepick]', (el) => { const k = el.dataset.tiepick; seq[k] = [...(seq[k] || []), el.dataset.team]; h.render(); });
    on('[data-tieback]', (el) => { const k = el.dataset.tieback; seq[k] = (seq[k] || []).slice(0, -1); h.render(); });
    on('[data-tiefill]', (el) => {
      const r = (h.runs || []).find((y) => y.key === el.dataset.tiefill);
      if (!r) return;
      const got = seq[r.key] || [];
      const pick = [...got, ...r.teams.map((t) => t.name).filter((n) => !got.includes(n))];
      saveWith((s) => {
        const set = new Set(pick);
        s.tiePicks = [...(Array.isArray(s.tiePicks) ? s.tiePicks : []).filter((p) => !(p.at === r.at && p.order.some((n) => set.has(n)))), { at: r.at, order: pick }];
      }).then(() => { delete seq[r.key]; return h.refill(); }).then(() => h.render()).catch((e) => h.say(e.message, true));
    });
    // a pick taken back: its tie waits for the TD again
    on('[data-tiechange]', (el) => {
      const x = (h.sched().filled || []).find((y) => y.order && noteId(y) === el.dataset.tiechange);
      if (!x) return;
      const at = x.pool || 'F:' + x.bracket, names = new Set(x.teams.map((t) => t.name));
      saveWith((s) => { s.tiePicks = (s.tiePicks || []).filter((p) => !(p.at === at && p.order.some((n) => names.has(n)))); })
        .then(() => h.refill()).then(() => h.render()).catch((e) => h.say(e.message, true));
    });
  }
  return { html, wire };
}
