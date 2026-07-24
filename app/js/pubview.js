// pubview.js — the public tournament page (t.html?t=<slug>): schedule +
// stats tabs. Data comes from the publish-gated /pub routes; the page
// polls the tiny /pub/:slug state while visible and refetches the stats
// bundle / schedule blob only when their stamps move.

import { pub, esc } from './api.js';
import { parseMatch, parseRoster } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { renderStats } from './statsview.js';
import { slotText } from '../engine/schedule.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('t') || '';
const CHECK_MS = 300000; // state check while visible; blobs refetch on stamp change

let state = null;
let lastVersion = null;    // stats bundle stamp
let lastSched = undefined; // schedule stamp (null = none)
let matches = [];
let statsErrors = [];
let roster = null;
let schedule = null;
let tab = null;            // 'schedule' | 'stats'
let teamFilter = '';

function say(text, bad = false) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

const asJson = async (res) => (res instanceof Response ? JSON.parse(await res.text()) : res);

async function fetchRoster() {
  if (!state.roster) return null;
  try {
    return parseRoster(await asJson(await pub('/pub/' + slug + '/roster')));
  } catch (e) { return null; } // both tabs still render without it
}

// One request for all games; per-file fetch only if the bundle is missing.
async function fetchMatches(errors) {
  const out = [];
  try {
    const bundle = await asJson(await pub('/pub/' + slug + '/bundle'));
    for (const entry of bundle.entries) {
      try {
        const m = parseMatch(entry.qbj, { filename: entry.filename });
        m.room = entry.room;
        m.fileId = entry.id;
        out.push(m);
      } catch (e) { errors.push(entry.filename + ': ' + e.message); }
    }
    return out;
  } catch (e) { /* no bundle yet: fall through */ }

  await Promise.all(state.files.map(async (f) => {
    try {
      const m = parseMatch(await asJson(await pub('/pub/' + slug + '/qbj/' + f.id)),
        { filename: f.filename });
      m.room = f.room;
      m.fileId = f.id;
      out.push(m);
    } catch (e) { errors.push(f.filename + ': ' + e.message); }
  }));
  return out;
}

/* ---------- schedule tab ---------- */

// Played results, keyed by round + the two team names (order-free).
function resultMap() {
  const map = new Map();
  for (const m of dedupeMatches(matches)) {
    const [a, b] = m.teams;
    if (!a || !b) continue;
    const key = m.round + '|' + [a.name, b.name].sort().join('|');
    map.set(key, m);
  }
  return map;
}
function resultFor(results, round, aName, bName) {
  return results.get(round.round + '|' + [aName, bName].sort().join('|'));
}

function gameCell(g, round, results) {
  const a = slotText(g.a);
  const b = slotText(g.b);
  const side = (slot, name, pts, won) => `<div class="g${slot && slot.label ? ' ph' : ''}">` +
    (won ? `<span class="win">${esc(name)} ${pts}</span>`
      : pts !== null ? `${esc(name)} <span class="score">${pts}</span>` : esc(name || '—')) +
    '</div>';
  const m = a && b && g.a.team && g.b.team ? resultFor(results, round, a, b) : null;
  if (!m) return side(g.a, a, null) + side(g.b, b, null);
  const ma = m.teams.find((t) => t.name === a);
  const mb = m.teams.find((t) => t.name === b);
  return side(g.a, a, ma.points, ma.points > mb.points)
    + side(g.b, b, mb.points, mb.points > ma.points);
}

function renderScheduleGrid(box) {
  const results = resultMap();
  const cur = state.current_round;
  box.innerHTML = schedule.phases.map((phase) => {
    const hasByes = phase.rounds.some((r) => r.byes.length);
    // only rooms this phase actually uses get columns
    const used = schedule.rooms.map((_, i) =>
      phase.rounds.some((r) => r.games.some((g) => g.room === i)));
    return `
    <div class="rhead">${esc(phase.name)}</div>
    <div class="tablewrap">
    <table class="sched">
      <tr><th></th>${schedule.rooms.map((r, i) => used[i] ? `<th>${esc(r.name)}</th>` : '').join('')}${hasByes ? '<th>bye</th>' : ''}</tr>
      ${phase.rounds.map((round) => `
      <tr>
        <td class="roundcell${round.round === cur ? ' now' : ''}">${round.round}</td>
        ${schedule.rooms.map((_, roomI) => {
          if (!used[roomI]) return '';
          const g = round.games.find((x) => x.room === roomI);
          const cls = round.round === cur ? ' class="now"' : '';
          return `<td${cls}>${g ? gameCell(g, round, results) : ''}</td>`;
        }).join('')}
        ${hasByes ? `<td${round.round === cur ? ' class="now"' : ''}>${round.byes.map((s) =>
          `<div class="g${s && s.label ? ' ph' : ''}">${esc(slotText(s)) || '—'}</div>`).join('')}</td>` : ''}
      </tr>`).join('')}
    </table>
    </div>`;
  }).join('');
}

function renderTeamView(box, team) {
  const results = resultMap();
  const rows = [];
  for (const phase of schedule.phases) {
    for (const round of phase.rounds) {
      const g = round.games.find((x) => slotText(x.a) === team || slotText(x.b) === team);
      if (g) {
        const oppSlot = slotText(g.a) === team ? g.b : g.a;
        const opp = slotText(oppSlot);
        const room = schedule.rooms[g.room] ? schedule.rooms[g.room].name : '';
        const m = g.a && g.a.team && g.b && g.b.team ? resultFor(results, round, g.a.team, g.b.team) : null;
        let result = '<span class="muted">–</span>';
        if (m) {
          const mine = m.teams.find((t) => t.name === team);
          const theirs = m.teams.find((t) => t.name === opp);
          if (mine && theirs) {
            result = mine.points > theirs.points
              ? `<span class="ok">W ${mine.points}–${theirs.points}</span>`
              : `<span class="bad">L ${mine.points}–${theirs.points}</span>`;
          }
        }
        rows.push(`<tr><td class="roundcell">${round.round}</td>
          <td${oppSlot && oppSlot.label ? ' class="ph"' : ''}>${esc(opp) || '—'}</td>
          <td class="muted">${esc(room)}</td><td class="num">${result}</td></tr>`);
      } else if (round.byes.some((s) => slotText(s) === team)) {
        rows.push(`<tr><td class="roundcell">${round.round}</td>
          <td class="muted">bye</td><td></td><td></td></tr>`);
      }
    }
  }
  box.innerHTML = `<div class="tablewrap"><table>
    <tr><th>round</th><th>opponent</th><th>room</th><th class="num">result</th></tr>
    ${rows.join('')}</table></div>`;
}

function scheduleTeams() {
  if (roster) return roster.map((t) => t.name);
  const names = new Set();
  for (const phase of schedule.phases) {
    for (const round of phase.rounds) {
      for (const g of round.games) for (const s of [g.a, g.b]) if (s && s.team) names.add(s.team);
      for (const s of round.byes) if (s && s.team) names.add(s.team);
    }
  }
  return [...names].sort();
}

function renderSchedule(box) {
  if (!schedule) {
    box.innerHTML = '<div class="muted">no schedule</div>';
    return;
  }
  const teams = scheduleTeams();
  box.innerHTML = `
    <div style="margin-bottom:10px">
      <select id="teamsel">
        <option value="">all teams</option>
        ${teams.map((n) => `<option ${n === teamFilter ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
    </div>
    <div id="schedout"></div>`;
  $('teamsel').onchange = () => {
    teamFilter = $('teamsel').value;
    render();
  };
  if (teamFilter && teams.includes(teamFilter)) renderTeamView($('schedout'), teamFilter);
  else renderScheduleGrid($('schedout'));
}

/* ---------- stats tab ---------- */

function renderStatsTab(box) {
  if (!matches.length) {
    box.innerHTML = statsErrors.length
      ? statsErrors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')
      : '<div class="muted">no games yet</div>';
    return;
  }
  renderStats(box, aggregate(matches, roster), statsErrors);
}

/* ---------- shell ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  const box = $('out');
  if (tab === 'schedule') renderSchedule(box);
  else renderStatsTab(box);
}

function setTab(next, push = true) {
  tab = next;
  if (push) history.replaceState(null, '', '#' + next);
  render();
}

async function load(force = false) {
  try {
    const next = await pub('/pub/' + slug);
    state = next;
    document.title = state.name;
    $('tname').textContent = state.name;
    $('round').textContent = 'round ' + state.current_round;

    const statsMoved = force || state.version !== lastVersion;
    const schedMoved = force || state.schedule !== lastSched;
    if (!statsMoved && !schedMoved) { say(''); return; }
    say('loading');

    const jobs = [];
    if (statsMoved) {
      const errors = [];
      jobs.push((async () => {
        const [r, m] = await Promise.all([fetchRoster(), fetchMatches(errors)]);
        roster = r;
        matches = m;
        statsErrors = errors;
        // an empty load that raced an upload must retry on the next
        // check, not stick on this version
        if (matches.length) lastVersion = state.version;
      })());
    }
    if (schedMoved) {
      jobs.push((async () => {
        try { schedule = await asJson(await pub('/pub/' + slug + '/schedule')); }
        catch (e) { schedule = null; }
        lastSched = state.schedule;
      })());
    }
    await Promise.all(jobs);

    if (tab === null) {
      const wanted = (location.hash || '').replace('#', '');
      setTab(wanted === 'stats' || wanted === 'schedule' ? wanted
        : schedule ? 'schedule' : 'stats', false);
    } else render();
    say('');
  } catch (e) { say(e.message, true); }
}

document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
$('refresh').onclick = () => load(true);
if (!slug) say('bad link', true);
else {
  load(true);
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, CHECK_MS);
}
