// pubview.js — the public tournament page (t.html?t=<slug>): schedule +
// stats tabs. Data comes from one small state on load or refresh (the
// tournament's file on qb-td-live, free to read; the Worker's /pub/:slug
// when that fails — see loadState), then a blob per round of games, plus
// the schedule / category map, only when their stamps move. A round that
// has finished never moves again, so refreshing late in a long day
// fetches the round in progress and nothing else.
//
// Nothing polls. A viewer reads a snapshot of the tournament as of the
// moment they loaded the page, and refreshes for a newer one — so an
// idle tab costs nothing at all, and a refresh shows results as soon as
// the cron has published them and the file has deployed (a minute or
// so behind a moderator's upload).

import { pub, esc, usingStaticData, usingArchive, LIVE } from './api.js';
import { parseMatch, parseRoster, rosterNameMap, renameMatch, resultOf } from '../engine/qbj.js';
import { dedupeMatches } from '../engine/stats.js';
import { buildReport, reportData } from '../engine/report.js';
import { mountReport, reportPlace } from './reportframe.js';
import { slotText } from '../engine/schedule.js';
import { scheduleFinished } from '../engine/finals.js';
import { roundTossupBuzzes, roundBonuses, buzzSummary, dedupeEntries, tiebreakerBuzzes } from '../engine/buzz.js';
import { roundHtml, replacementsHtml, tossupHtml, bonusHtml, buzzSummaryHtml, readPacket } from './buzzview.js';
import { categoryStats, categoryTeamStats, catPlayerLines, catTeamLines, catBreakdown, catCompare,
  categoryQuestionStats, questionLines, categoryQuestions, UNKNOWN_CAT } from '../engine/cats.js';
import { buzzToken } from './buzzkey.js';
import { buildScoresheet } from '../engine/scoresheet.js';
import { sheetHtml } from './sheetview.js';
import { effectiveFormat } from './read_core.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('t') || '';

let state = null;
let lastVersion = null;    // stats bundle stamp
let lastSched = undefined; // schedule stamp (null = none)
let matches = [];
let statsErrors = [];
let roster = null;
let schedule = null;
let tab = null;            // 'schedule' | 'stats' | 'buzz'
let teamFilter = '';
let rawEntries = [];       // {id, round, room, qbj}, deduped — buzz + category extraction read these
const roundCache = new Map(); // round number (as a string) -> {v, entries} already fetched
let loadedIds = new Set();    // file ids the fetched rounds actually contained
let roundsComplete = true;    // false when a round failed to fetch this pass
let buzzMode = 'round';    // 'round' | 'category' | 'summary'
let buzzView = null;       // the round By Round shows
let buzzCat = '';          // the category By Category shows
let buzzSub = '';
let buzzSub2 = '';
let catmap = null;         // text-free per-tossup categories from /pub/:slug/cats
let lastCats;              // its stamp
let catView = 'cat';       // 'cat' (players) | 'team' | 'player' | 'questions'
let catSel = '';
let catSubSel = '';
let catSub2Sel = '';       // the third level: a split under an RMPSS category
let catPlayerSel = null;   // {team, player}
const buzzPackets = {};    // round -> Promise<normalized packet>
const BUZZ_KEY = 'qbtdBuzzKey:' + slug;

function say(text, bad = false) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

const asJson = async (res) => (res instanceof Response ? JSON.parse(await res.text()) : res);

/* ---------- GitHub snapshot fetches ----------
   When /pub/:slug advertises a published snapshot (state.pub — the
   Worker's "public snapshots on GitHub"), the heavy blobs are fetched
   SHA-pinned from raw.githubusercontent.com: immutable (no CDN
   staleness) and off the Worker's request budget, so viewer count stops
   costing anything. Every fetch falls back to the /pub route, so a
   missing repo, failed publish, or disabled feature just means Worker
   serving — exactly the pre-snapshot behavior. Never used when pub()
   answers from local data (demo / archive captures). */

let snap = null; // state.pub when usable on this page; set by load()

// A snapshot fetch that hangs must fall back to the Worker like one that
// fails: the fallback only fires on an error, and a degraded GitHub is
// more common than a down one.
const SNAP_TIMEOUT_MS = 8000;

async function fetchSnap(name) {
  const res = await fetch(
    'https://raw.githubusercontent.com/' + snap.repo + '/' + snap.sha + '/' + slug + '/' + name,
    { signal: AbortSignal.timeout(SNAP_TIMEOUT_MS) });
  if (!res.ok) throw new Error('snapshot HTTP ' + res.status);
  return res.json();
}

// One stamped blob: the snapshot when it contains it, else the Worker
// route when the live state says it exists, else null.
async function fetchStamped(present, snapHas, name, route) {
  if (snapHas) {
    try { return await fetchSnap(name); } catch (e) { /* fall back */ }
  }
  if (!present) return null;
  // only fetched when its stamp moved, so a copy the browser holds (served
  // max-age=60) may be the old one: a renamed team would show its old name
  try { return await asJson(await pub('/pub/' + slug + route, { cache: 'no-cache' })); } catch (e) { return null; }
}

async function fetchRoster() {
  const qbj = await fetchStamped(state.roster, snap && snap.roster, 'roster.json', '/roster');
  if (!qbj) return null;
  try { return parseRoster(qbj); } catch (e) { return null; } // both tabs still render without it
}

// The games, one request per round whose stamp moved. Rounds already
// held are reused, and a finished round's stamp never moves again — so
// the first load of a finished tournament costs one request per round
// and every refresh after it costs whatever is still being played.
//
// The raw qbj rows are kept too — the buzzpoints tab reads
// match_questions, which parseMatch drops.
async function fetchRounds(errors) {
  const wanted = state.rounds || {};
  roundsComplete = true;
  const hold = (n, shard) => {
    // Stamp the copy with what the shard says it is, not with what the
    // state said to expect: the cron may have rebuilt it since, and
    // holding the newer stamp saves the next refresh a round trip.
    roundCache.set(n, {
      v: shard.v || wanted[n],
      entries: Array.isArray(shard.entries) ? shard.entries : [],
    });
  };
  const stale = Object.keys(wanted).filter((n) => (roundCache.get(n) || {}).v !== wanted[n]);

  // The snapshot is only worth asking when it holds the round at the
  // stamp we're after — one SHA-pinned file per round, off the Worker
  // entirely. Anything it can't answer falls to the Worker below.
  const fromWorker = [];
  await Promise.all(stale.map(async (n) => {
    if (snap && snap.rounds && snap.rounds[n] === wanted[n]) {
      try { hold(n, await fetchSnap('r' + n + '.json')); return; } catch (e) { /* fall back */ }
    }
    fromWorker.push(n);
  }));

  // Whatever is left goes in ONE request, so a first load of a long
  // tournament costs two requests rather than one per round. Each round
  // rides with the stamp we're after (n=5@<stamp>): the Worker ignores
  // it, but it keeps the URL — and so the browser's cache key — from
  // ever matching a copy fetched before the round moved. The state
  // itself is fetched cache-busted; this is the same guarantee for the
  // shards it points at.
  if (fromWorker.length) {
    let got = null;
    const q = fromWorker.sort((a, b) => a - b).map((n) => n + '@' + wanted[n]).join(',');
    try {
      got = await asJson(await pub('/pub/' + slug + '/rounds?n=' + q));
    } catch (e) {
      errors.push('games: ' + e.message);
      roundsComplete = false;
    }
    const byRound = new Map(((got && got.rounds) || []).map((s) => [String(s.round), s]));
    for (const n of fromWorker) {
      const shard = byRound.get(n);
      // Leaving a round unheld (and unstamped) is deliberate: it keeps
      // last refresh's games on screen and retries on the next one,
      // rather than emptying the table or pinning a stamp we never got.
      if (shard) hold(n, shard);
      else if (got) roundsComplete = false;
      // Held, but not at the stamp the state advertised (older: a shard
      // still being rebuilt; newer: fine, but the state should confirm
      // it): don't pin this pass as done, so the next refresh checks.
      if (shard && (roundCache.get(n) || {}).v !== wanted[n]) roundsComplete = false;
    }
  }

  for (const n of [...roundCache.keys()]) {
    if (wanted[n] === undefined) roundCache.delete(n);
  }
  return [...roundCache.values()].flatMap((r) => r.entries);
}

// Frozen data (the demo fixture, archive captures) predates the round
// shards and carries every game in one bundle instead.
async function fetchWholeBundle(errors) {
  try {
    const bundle = await asJson(await pub('/pub/' + slug + '/bundle'));
    return Array.isArray(bundle.entries) ? bundle.entries : [];
  } catch (e) { /* no bundle: fall back to one request per file */ }
  const entries = [];
  await Promise.all((state.files || []).map(async (f) => {
    try {
      entries.push({ id: f.id, round: f.round, room: f.room, filename: f.filename,
        qbj: await asJson(await pub('/pub/' + slug + '/qbj/' + f.id)) });
    } catch (e) { errors.push(f.filename + ': ' + e.message); }
  }));
  return entries;
}

// rosterP: the roster's fetch, whose former names rename the games
async function fetchMatches(errors, rosterP) {
  const entries = state.rounds ? await fetchRounds(errors) : await fetchWholeBundle(errors);
  const names = rosterNameMap(await rosterP);
  loadedIds = new Set(entries.map((e) => e.id));
  // A shard keeps the room a game had when it was built; the state's file
  // list is read live, so a TD's room reassignment (or rename) shows here
  // without the shard having to move.
  const liveRoom = new Map((state.files || []).map((f) => [f.id, f.room]));
  const out = [];
  const raw = [];
  for (const entry of entries) {
    if (liveRoom.get(entry.id)) entry.room = liveRoom.get(entry.id);
    try {
      const qbj = renameMatch(entry.qbj, names);
      const m = parseMatch(qbj, { filename: entry.filename });
      m.room = entry.room;
      m.fileId = entry.id;
      out.push(m);
      raw.push({ id: entry.id, round: m.round, room: entry.room, qbj });
    } catch (e) { errors.push(entry.filename + ': ' + e.message); }
  }
  rawEntries = dedupeEntries(raw);
  return out;
}

/* ---------- schedule tab ---------- */

// Two views: Now (the round being read and the one after it, grouped by
// group, a card per group) and All rounds (the grid). Chips for the
// groups (pools, then the playoff brackets) filter either when the
// rounds shown have more than one. The view is a
// per-viewer convenience, so it lives in localStorage and nothing breaks
// when that's unavailable.
const SCHED_VIEW_KEY = 'qbtdSchedView';
let schedView = null;      // 'now' | 'all'
let poolSel = '';          // '' = every pool
function readPref(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function savePref(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* private window */ } }

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

function findRound(n) {
  for (const phase of schedule.phases) {
    for (const r of phase.rounds) if (r.round === n) return r;
  }
  return null;
}

// The group a game belongs to: its bracket as the schedule names it
// ("Pool A", "1st–6th place", "Championship"), so playoffs filter as the
// prelims do. A schedule from before brackets were recorded falls back
// to its pools: both teams seeded into the same one (schedule.pools).
function bracketName(g) {
  const b = g.bracket && (schedule.brackets || []).find((x) => x.key === g.bracket);
  return b ? b.name : '';
}
function poolOf(g) {
  if ((schedule.brackets || []).length) return bracketName(g);
  const pools = schedule.pools || {};
  const a = g.a && g.a.team;
  const b = g.b && g.b.team;
  if (!a || !b) return '';
  for (const [k, members] of Object.entries(pools)) {
    if (members.includes(a) && members.includes(b)) return 'Pool ' + k;
  }
  return '';
}
// groups in the schedule's own order (pools, then each playoff bracket)
function groupOrder(x, y) {
  const at = (k) => {
    const i = (schedule.brackets || []).findIndex((b) => b.name === k);
    return i < 0 ? Infinity : i;
  };
  return (x === '') - (y === '') || at(x) - at(y) || x.localeCompare(y);
}
function poolsIn(rounds) {
  return [...new Set(rounds.flatMap((r) => r.games.map(poolOf)).filter(Boolean))].sort(groupOrder);
}
const keepGame = (g) => !poolSel || poolOf(g) === poolSel;
const roomName = (g) => (schedule.rooms[g.room] ? schedule.rooms[g.room].name : '');

// One team's line of a game: the winner's line is tinted, the loser's
// muted, a playoff placeholder italic.
function lineHtml(slot, name, pts, won, lost) {
  return `<div class="gl${won ? ' won' : ''}${lost ? ' lost' : ''}${slot && slot.label ? ' ph' : ''}">`
    + `<span class="t">${esc(name || '—')}</span>${pts !== null ? `<span class="s">${pts}</span>` : ''}</div>`;
}

function gameCell(g, round, results) {
  const a = slotText(g.a);
  const b = slotText(g.b);
  const m = a && b && g.a.team && g.b.team ? resultFor(results, round, a, b) : null;
  if (!m) return lineHtml(g.a, a, null) + lineHtml(g.b, b, null);
  const ma = m.teams.find((t) => t.name === a);
  const mb = m.teams.find((t) => t.name === b);
  // a forfeit: W for the winner, FF for the team that forfeited
  const shown = (x, y) => (m.forfeit ? (resultOf(x, y) === 'W' ? 'W' : 'FF') : x.points);
  return lineHtml(g.a, a, shown(ma, mb), resultOf(ma, mb) === 'W', resultOf(ma, mb) === 'L')
    + lineHtml(g.b, b, shown(mb, ma), resultOf(mb, ma) === 'W', resultOf(mb, ma) === 'L');
}

function renderScheduleGrid(box) {
  const results = resultMap();
  const cur = nowRound();
  box.innerHTML = schedule.phases.map((phase) => {
    if (!phase.rounds.some((r) => r.games.some(keepGame))) return '';
    // byes aren't in any pool: shown only when the whole schedule is
    const hasByes = !poolSel && phase.rounds.some((r) => r.byes.length);
    // only rooms this phase actually uses get columns
    const used = schedule.rooms.map((_, i) =>
      phase.rounds.some((r) => r.games.some((g) => g.room === i && keepGame(g))));
    return `
    <div class="rhead">${esc(phase.name)}</div>
    <div class="tablewrap">
    <table class="sched">
      <tr><th></th>${schedule.rooms.map((r, i) => used[i] ? `<th>${esc(r.name)}</th>` : '').join('')}${hasByes ? '<th>Bye</th>' : ''}</tr>
      ${phase.rounds.map((round) => `
      <tr>
        <td class="roundcell${round.round === cur ? ' now' : ''}">${round.round}</td>
        ${schedule.rooms.map((_, roomI) => {
          if (!used[roomI]) return '';
          const g = round.games.find((x) => x.room === roomI && keepGame(x));
          const cls = round.round === cur ? ' class="now"' : '';
          return `<td${cls}>${g ? gameCell(g, round, results) : ''}</td>`;
        }).join('')}
        ${hasByes ? `<td${round.round === cur ? ' class="now"' : ''}>${round.byes.map((s) =>
          `<div class="gl${s && s.label ? ' ph' : ''}"><span class="t">${esc(slotText(s)) || '—'}</span></div>`).join('')}</td>` : ''}
      </tr>`).join('')}
    </table>
    </div>`;
  }).join('') || '<div class="muted">No games</div>';
}

// Now: the current round (Live now) and the next (Up next), side by side
// on a wide screen, stacked on a phone.
function renderNow(box) {
  const results = resultMap();
  const cur = liveRound();
  const blocks = [[cur, 'Live now', 'live'], [cur + 1, 'Up next', '']]
    .map(([n, tag, cls]) => ({ n, tag, cls, r: findRound(n) })).filter((b) => b.r);
  const named = poolsIn(blocks.map((b) => b.r)).length > 1;
  box.innerHTML = `<div class="nowgrid">${blocks.map((b) => {
    const groups = new Map();
    for (const g of b.r.games.filter(keepGame)) {
      const k = poolOf(g);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    }
    const order = [...groups.keys()].sort(groupOrder);
    return `<section class="nowblock">
      <div class="nowhead"><h3>Round ${b.n}</h3><span class="nowtag ${b.cls}">${b.tag}</span></div>
      ${order.map((k) => `${named ? `<div class="poolname">${esc(k || 'Other games')}</div>` : ''}
        <div class="gcard">${groups.get(k).map((g) => `<div class="gg">
          ${roomName(g) ? `<div class="groom">${esc(roomName(g))}</div>` : ''}
          ${gameCell(g, b.r, results)}</div>`).join('')}</div>`).join('') || '<div class="muted">No games</div>'}
      ${!poolSel && b.r.byes.length ? `<div class="byes muted">Bye: ${b.r.byes.map((s) => esc(slotText(s))).join(', ')}</div>` : ''}
    </section>`;
  }).join('')}</div>`;
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
        const room = roomName(g);
        const m = g.a && g.a.team && g.b && g.b.team ? resultFor(results, round, g.a.team, g.b.team) : null;
        let result = '<span class="muted">–</span>';
        if (m) {
          const mine = m.teams.find((t) => t.name === team);
          const theirs = m.teams.find((t) => t.name === opp);
          if (mine && theirs) {
            const won = resultOf(mine, theirs) === 'W';
            const score = m.forfeit ? '(forfeit)' : `${mine.points}–${theirs.points}`;
            result = won ? `<span class="wtag">W ${score}</span>` : `<span class="muted">L ${score}</span>`;
          }
        }
        rows.push(`<tr${round.round === nowRound() ? ' class="nowrow"' : ''}><td class="roundcell">${round.round}</td>
          <td class="name${oppSlot && oppSlot.label ? ' ph' : ''}">${esc(opp) || '—'}</td>
          <td class="muted">${esc(room)}</td><td class="num">${result}</td></tr>`);
      } else if (round.byes.some((s) => slotText(s) === team)) {
        rows.push(`<tr><td class="roundcell">${round.round}</td>
          <td class="muted">Bye</td><td></td><td></td></tr>`);
      }
    }
  }
  box.innerHTML = `<div class="tablewrap"><table>
    <tr><th>Round</th><th>Opponent</th><th>Room</th><th class="num">Result</th></tr>
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

// The round on the floor (worker.js liveRound): rooms may already have
// the next one, but it's live here once a room starts it. Older states
// and frozen copies carry only current_round.
function liveRound() {
  return Number.isInteger(state.live_round) ? state.live_round : state.current_round;
}
// The tournament is over: every scheduled game is in (finals.js
// scheduleFinished). Then nothing is live: no Now view, no Live now.
let finishedFor = null;
function finished() {
  if (!schedule || !matches.length) return false;
  if (!finishedFor || finishedFor.schedule !== schedule || finishedFor.matches !== matches) {
    finishedFor = { schedule, matches, value: scheduleFinished(schedule, dedupeMatches(matches)) };
  }
  return finishedFor.value;
}
// the round shown as being played, or none once the tournament is over
const nowRound = () => (finished() ? null : liveRound());

function renderSchedule(box) {
  if (!schedule) {
    box.innerHTML = '<div class="muted">No schedule</div>';
    return;
  }
  const cur = liveRound();
  // an archived or finished tournament is over: no Now view, no "Live now"
  const hasNow = !usingArchive() && !finished() && Boolean(findRound(cur));
  if (!schedView) {
    const kept = readPref(SCHED_VIEW_KEY);
    schedView = kept === 'all' || (kept === 'now' && hasNow) ? kept : hasNow ? 'now' : 'all';
  }
  if (schedView === 'now' && !hasNow) schedView = 'all';
  const teams = scheduleTeams();
  const shown = schedView === 'now'
    ? [findRound(cur), findRound(cur + 1)].filter(Boolean)
    : schedule.phases.flatMap((p) => p.rounds);
  const pools = teamFilter ? [] : poolsIn(shown);
  if (poolSel && !pools.includes(poolSel)) poolSel = '';
  const view = (v, label) => `<a href="#" class="view${schedView === v ? ' on' : ''}" data-schedview="${v}"${
    schedView === v ? ' aria-current="true"' : ''}>${label}</a>`;
  box.innerHTML = `
    <div class="views schedviews">
      ${hasNow ? view('now', 'Now') : ''}${view('all', 'All rounds')}
      <span class="grow"></span>
      <select id="teamsel" aria-label="Follow a team">
        <option value="">All teams</option>
        ${teams.map((n) => `<option ${n === teamFilter ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
    </div>
    ${pools.length > 1 ? `<div class="chipstack">${chipsHtml([{ v: '', label: 'All' },
      ...pools.map((p) => ({ v: p, label: p }))], poolSel, 'pool')}</div>` : ''}
    <div id="schedout"></div>`;
  wire(box, 'schedview', (v) => { schedView = v; savePref(SCHED_VIEW_KEY, v); });
  wire(box, 'pool', (v) => { poolSel = v; });
  $('teamsel').onchange = () => {
    teamFilter = $('teamsel').value;
    render();
  };
  if (teamFilter && teams.includes(teamFilter)) renderTeamView($('schedout'), teamFilter);
  else if (schedView === 'now') renderNow($('schedout'));
  else renderScheduleGrid($('schedout'));
}

/* ---------- buzzpoints tab ---------- */

// What's kept is the derived key, not the password (buzzkey.js): the
// stretching happens once, on unlock, rather than on every packet fetch.
// It carries the server's buzz_v stamp, so when the TD sets a new password
// the stamp moves, the stale entry is dropped, and viewers re-enter.
function buzzStored() {
  try {
    const s = JSON.parse(sessionStorage.getItem(BUZZ_KEY));
    return s && typeof s.tok === 'string' ? s : null;
  } catch (e) { return null; }
}

function buzzAuthHeaders() {
  const s = buzzStored();
  return (state.buzz || state.scoresheets) && s ? { Authorization: 'Buzz ' + s.tok } : {};
}

// Text of every tiebreaker the tournament read, for the Replacements view:
// {text} once the tournament has closed, {closed: false} before, or
// {text: null} when it can't be had (none stored, older games).
let buzzTiebreakers = null;
function fetchBuzzTiebreakers() {
  if (!buzzTiebreakers) {
    buzzTiebreakers = (async () => {
      let res = await pub('/pub/' + slug + '/qtiebreakers', { headers: buzzAuthHeaders() });
      if (res instanceof Response) res = await res.json();
      return { text: res && Array.isArray(res.tossups) ? res : null };
    })().catch((e) => {
      buzzTiebreakers = null;
      return String(e.message).includes('not closed') ? { closed: false } : { text: null };
    });
  }
  return buzzTiebreakers;
}

function fetchBuzzPacket(round) {
  if (!buzzPackets[round]) {
    buzzPackets[round] = (async () => {
      return readPacket(await pub('/pub/' + slug + '/qpacket?round=' + round,
        { headers: buzzAuthHeaders() }), 'round ' + round);
    })().catch((e) => { delete buzzPackets[round]; throw e; });
  }
  return buzzPackets[round];
}

async function tryBuzzKey(pw) {
  if (!pw) return;
  // On a current tournament this runs PBKDF2 — a second or so on a phone,
  // so it gets a message; older ones send the password itself and return
  // immediately.
  let tok;
  try {
    if (state.buzz_kdf) say('Checking password');
    tok = await buzzToken(pw, state.buzz_kdf);
  } catch (e) { say('Could not check the password', true); return; }
  sessionStorage.setItem(BUZZ_KEY, JSON.stringify({ tok, v: state.buzz_v }));
  // A finished round's packet proves the password; without one (no
  // packets, or scoresheets alone) the Worker's unlock route does.
  const probe = (state.buzz_done || []).filter((n) =>
    (state.packet_rounds || []).includes(n))[0];
  const check = probe !== undefined ? () => fetchBuzzPacket(probe)
    : !usingStaticData() ? () => pub('/pub/' + slug + '/unlock', { headers: buzzAuthHeaders() })
      : null;
  if (check) {
    try { await check(); }
    catch (e) {
      const m = String(e.message);
      // a rejected key and a hit attempt cap both mean "not unlocked", so
      // neither should leave a stored key behind
      if (m.includes('bad password') || m.includes('too many attempts')) {
        sessionStorage.removeItem(BUZZ_KEY);
        say(m.includes('too many') ? m : 'Bad password', true);
        return;
      } // other failures (no packet etc.): let the tab render what it can
    }
  }
  say('');
  render();
}

const buzzDoneSet = () => new Set(state.buzz_done || []);
const buzzEntries = () => {
  const done = buzzDoneSet();
  return rawEntries.filter((e) => done.has(e.round));
};

/* ---------- navigation + filters (td.css .views / .chips) ---------- */

// View switch: bold words. items [{v, label} | {grow: true}].
function viewsHtml(items, cur, attr) {
  return `<div class="views">${items.map((i) => i.grow ? '<span class="grow"></span>'
    : `<a href="#" class="view${i.v === cur ? ' on' : ''}" data-${attr}="${esc(i.v)}"${
      i.v === cur ? ' aria-current="true"' : ''}>${esc(i.label)}</a>`).join('')}</div>`;
}
// Filter chips. items [{v, label, n?, off?, cls?}]; `sub` hangs the row
// off a rule, for the level under another.
// `sub` is true for the second row, 'sub2' for the third.
function chipsHtml(items, cur, attr, sub = false) {
  return `<div class="chips${sub ? ' sub' : ''}${sub === 'sub2' ? ' sub2' : ''}">${items.map((i) => i.off
    ? `<span class="chip off">${esc(i.label)}</span>`
    : `<a href="#" class="chip${i.v === cur ? ' on' : ''}${i.cls ? ' ' + i.cls : ''}" data-${attr}="${esc(i.v)}"${
      i.v === cur ? ' aria-current="true"' : ''}>${esc(i.label)}${i.n ? `<span class="n">${i.n}</span>` : ''}</a>`).join('')}</div>`;
}
function wire(box, attr, pick) {
  box.querySelectorAll(`[data-${attr}]`).forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); pick(el.dataset[attr]); render(); };
  });
}
// Category chips, then the picked category's subcategories under them,
// then the picked subcategory's own split (RMPSS → Beliefs → Narratives).
// `items` are [{cat, sub, sub2}] with a count each (`n`); a subcategory
// named like its category adds nothing and isn't offered. `all` offers an
// All chip for no category.
function catChipsHtml(items, [cat, sub, sub2], [catAttr, subAttr, sub2Attr], all = true) {
  const count = new Map();
  const bump = (k, n) => count.set(k, (count.get(k) || 0) + n);
  for (const i of items) {
    bump(i.cat, i.n);
    if (i.sub && i.sub !== i.cat) bump(i.cat + '\n' + i.sub, i.n);
    if (i.sub2) bump(i.cat + '\n' + i.sub + '\n' + i.sub2, i.n);
  }
  const cats = [...new Set(items.map((i) => i.cat))].sort(catCompare);
  const subs = cat ? [...new Set(items.filter((i) => i.cat === cat && i.sub && i.sub !== cat)
    .map((i) => i.sub))].sort() : [];
  const subs2 = cat && sub ? [...new Set(items.filter((i) => i.cat === cat && i.sub === sub && i.sub2)
    .map((i) => i.sub2))].sort() : [];
  return `<div class="chipstack">
    ${chipsHtml([...(all ? [{ v: '', label: 'All' }] : []),
      ...cats.map((c) => ({ v: c, label: c, n: count.get(c), cls: c === UNKNOWN_CAT ? 'unc' : '' }))], cat, catAttr)}
    ${subs.length ? chipsHtml([{ v: '', label: 'All' },
      ...subs.map((s) => ({ v: s, label: s, n: count.get(cat + '\n' + s) }))], sub, subAttr, true) : ''}
    ${subs2.length ? chipsHtml([{ v: '', label: 'All' },
      ...subs2.map((s) => ({ v: s, label: s, n: count.get(cat + '\n' + sub + '\n' + s) }))], sub2, sub2Attr, 'sub2') : ''}
  </div>`;
}

/* ---------- buzzpoints tab ---------- */

function renderBuzzSummary(box) {
  box.innerHTML = buzzSummaryHtml(buzzSummary(buzzEntries()));
}

// A packet, or null when it can't be read (the numbers still render);
// false when the stored key was rejected, which re-asks for it.
async function buzzPacketOrNull(round) {
  try { return await fetchBuzzPacket(round); }
  catch (e) {
    if (String(e.message).includes('bad password')) {
      sessionStorage.removeItem(BUZZ_KEY);
      render();
      return false;
    }
    return null;
  }
}

async function renderBuzzRound(box, round) {
  if (!buzzDoneSet().has(round)) {
    box.innerHTML = '<div class="muted">Round in progress</div>';
    return;
  }
  const tossups = roundTossupBuzzes(rawEntries, round);
  const bonuses = roundBonuses(rawEntries, round);
  if (!tossups.length && !bonuses.length) {
    box.innerHTML = '<div class="muted">No games this round</div>';
    return;
  }
  box.innerHTML = '<div class="muted">Loading packet</div>';
  const packet = await buzzPacketOrNull(round);
  if (packet === false) return;
  if (tab !== 'buzz' || buzzMode !== 'round' || buzzView !== round) return; // user moved on mid-fetch
  box.innerHTML = roundHtml(tossups, bonuses, packet);
}

// Every finished round's tossups and bonuses in one category, each row
// expanding exactly as it does in its round.
function buzzCategoryIndex(rounds) {
  return categoryQuestions(catmap, rounds, '', '',
    (n) => roundTossupBuzzes(rawEntries, n), (n) => roundBonuses(rawEntries, n));
}

async function renderBuzzCategory(box, rounds) {
  const all = buzzCategoryIndex(rounds);
  const items = all.tossups.map((t) => ({ cat: t.cat, sub: t.sub, sub2: t.sub2, n: 1 }))
    .concat(all.bonuses.map((b) => ({ cat: b.cat, sub: b.sub, sub2: b.sub2, n: 0 })));
  if (!items.length) { box.innerHTML = '<div class="muted">No categorized questions yet</div>'; return; }
  const cats = [...new Set(items.map((i) => i.cat))].sort(catCompare);
  if (!cats.includes(buzzCat)) { buzzCat = cats[0]; buzzSub = ''; buzzSub2 = ''; }
  const pick = (q) => q.cat === buzzCat && (!buzzSub || q.sub === buzzSub) && (!buzzSub2 || q.sub2 === buzzSub2);
  const tossups = all.tossups.filter(pick);
  const bonuses = all.bonuses.filter(pick);
  // no All here: every category at once is just every round again
  const filter = catChipsHtml(items, [buzzCat, buzzSub, buzzSub2], ['buzzcat', 'buzzsub', 'buzzsub2'], false);
  box.innerHTML = `${filter}<div id="buzzcatout"><div class="muted">Loading packets</div></div>`;
  wire(box, 'buzzcat', (v) => { buzzCat = v; buzzSub = ''; buzzSub2 = ''; });
  wire(box, 'buzzsub', (v) => { buzzSub = v; buzzSub2 = ''; });
  wire(box, 'buzzsub2', (v) => { buzzSub2 = v; });
  const at = { cat: buzzCat, sub: buzzSub, sub2: buzzSub2 };
  const want = [...new Set([...tossups, ...bonuses].map((q) => q.round))];
  const packets = new Map();
  for (const [n, p] of await Promise.all(want.map(async (n) => [n, await buzzPacketOrNull(n)]))) {
    if (p === false) return;
    packets.set(n, p);
  }
  if (tab !== 'buzz' || buzzMode !== 'category' || buzzCat !== at.cat || buzzSub !== at.sub
    || buzzSub2 !== at.sub2) return;
  const out = box.querySelector('#buzzcatout');
  if (!out) return;
  out.innerHTML = `
    <div class="rhead">Tossups <span class="muted">${tossups.length}</span></div>
    ${tossups.map((t) => tossupHtml(t.tossup, t.buzzes, packets.get(t.round), undefined,
      `R${t.round} T${t.tossup}`)).join('') || '<div class="muted">None</div>'}
    <div class="rhead" style="margin-top:18px">Bonuses <span class="muted">${bonuses.length}</span></div>
    ${bonuses.map((b) => bonusHtml(b.bonus, b.results, packets.get(b.round),
      { label: `R${b.round} B${b.bonus}`, nest: false })).join('') || '<div class="muted">None</div>'}`;
}

async function renderBuzzReplacements(box, read) {
  box.innerHTML = '<div class="muted">Loading replacements</div>';
  const got = await fetchBuzzTiebreakers();
  if (tab !== 'buzz' || buzzMode !== 'replacements') return; // user moved on mid-fetch
  if (got.closed === false) {
    box.innerHTML = '<div class="muted">Replacement questions can come up again in later rounds, '
      + 'so their buzzpoints appear here once the tournament closes.</div>';
    return;
  }
  box.innerHTML = replacementsHtml(read, got.text);
}

function renderBuzz(box) {
  if (!state.buzz) { box.innerHTML = '<div class="muted">Not enabled</div>'; return; }
  if (!buzzStored()) {
    box.innerHTML = `<div class="row">
      <input id="buzzpw" type="password" placeholder="Password">
      <button id="buzzgo" class="primary">View</button>
    </div>`;
    $('buzzgo').onclick = () => tryBuzzKey($('buzzpw').value);
    $('buzzpw').onkeydown = (e) => { if (e.key === 'Enter') tryBuzzKey($('buzzpw').value); };
    return;
  }
  const done = buzzDoneSet();
  const rounds = (state.packet_rounds || []).filter((n) => done.has(n));
  const pending = (state.packet_rounds || []).filter((n) => !done.has(n));
  // By Category needs the category map, which docx packets don't give
  const byCat = Boolean(catmap);
  if (buzzMode === 'category' && !byCat) buzzMode = 'round';
  if (buzzMode === 'round' && !rounds.includes(buzzView)) {
    if (rounds.length) buzzView = rounds[rounds.length - 1];
    else buzzMode = 'summary';
  }
  // tiebreakers read anywhere: their own view, opened once the tournament closes
  const replacements = tiebreakerBuzzes(rawEntries);
  const anyReplacements = replacements.tossups.length + replacements.bonuses.length > 0;
  if (buzzMode === 'replacements' && !anyReplacements) buzzMode = 'round';
  box.innerHTML = `
    ${viewsHtml([{ v: 'round', label: 'By Round' },
      ...(byCat ? [{ v: 'category', label: 'By Category' }] : []),
      ...(anyReplacements ? [{ v: 'replacements', label: 'Replacements' }] : []),
      { grow: true }, { v: 'summary', label: 'Summary' }], buzzMode, 'buzzmode')}
    ${buzzMode === 'round' ? `<div class="chipstack">${chipsHtml([
      ...rounds.map((n) => ({ v: String(n), label: 'Round ' + n })),
      ...pending.map((n) => ({ off: true, label: `Round ${n} in progress` })),
    ], String(buzzView), 'buzzround')}</div>` : ''}
    <div id="buzzout"></div>`;
  wire(box, 'buzzmode', (v) => { buzzMode = v; });
  wire(box, 'buzzround', (v) => { buzzView = Number(v); });
  if (buzzMode === 'summary') renderBuzzSummary($('buzzout'));
  else if (buzzMode === 'replacements') renderBuzzReplacements($('buzzout'), replacements);
  else if (buzzMode === 'category') renderBuzzCategory($('buzzout'), rounds);
  else renderBuzzRound($('buzzout'), buzzView);
}

/* ---------- categories tab ---------- */

// The 15 column only when there are powers to count: the format has them,
// or (an older game, a changed format) someone got one anyway.
function showPowers(lines) {
  // a state without a format (the demo fixture, older data) goes by the lines
  if (!state.format || !Object.keys(state.format).length) return lines.some((l) => l.powers);
  const f = effectiveFormat(state.format);
  return Boolean((f.powers || []).length) || lines.some((l) => l.powers);
}
const catHead = (pw) => (pw ? '<th class="num">15</th>' : '') + '<th class="num">10</th><th class="num">-5</th>'
  + '<th class="num" title="Bouncebacks: tossups won after the other team missed them">BB</th>'
  + '<th class="num">Pts</th>';
function lineCells(l, pw) {
  return (pw ? `<td class="num">${l.powers}</td>` : '') + `<td class="num">${l.gets}</td>`
    + `<td class="num">${l.negs}</td><td class="num">${l.bb}</td><td class="num">${l.pts}</td>`;
}

// The category filter every view shares: categories as read, with how
// many tossups each had (distinct questions, not readings: with two rooms
// every tossup is read twice).
function catFilterHtml(q) {
  const items = q.tossups.map((r) => ({ cat: r.cat, sub: r.sub, sub2: r.sub2, n: r.questions }))
    .concat(q.bonuses.map((r) => ({ cat: r.cat, sub: r.sub, sub2: r.sub2, n: 0 })));
  const cats = new Set(items.map((i) => i.cat));
  if (catSel && !cats.has(catSel)) { catSel = ''; catSubSel = ''; catSub2Sel = ''; }
  return catChipsHtml(items, [catSel, catSubSel, catSub2Sel], ['cat', 'catsub', 'catsub2']);
}
function wireCatFilter(box) {
  wire(box, 'cat', (v) => { catSel = v; catSubSel = ''; catSub2Sel = ''; });
  wire(box, 'catsub', (v) => { catSubSel = v; catSub2Sel = ''; });
  wire(box, 'catsub2', (v) => { catSub2Sel = v; });
}
const noneHere = '<div class="muted">No buzzes in this category</div>';

function renderByCategory(box, rows, q) {
  const lines = catPlayerLines(rows, catSel, catSubSel, catSub2Sel);
  const pw = showPowers(lines);
  // on a phone the team rides under the player's name (pub.css)
  box.innerHTML = `${catFilterHtml(q)}
    ${lines.length ? `<div class="tablewrap"><table class="cattable">
      <tr><th class="name">Player</th><th class="name teamcol">Team</th>${catHead(pw)}</tr>
      ${lines.map((l) =>
        `<tr><td class="name">${esc(l.player)}<span class="subteam">${esc(l.team)}</span></td>`
        + `<td class="name muted teamcol">${esc(l.team)}</td>${lineCells(l, pw)}</tr>`).join('')}
    </table></div>` : noneHere}`;
  wireCatFilter(box);
}

function renderByTeam(box, teamRows, q) {
  const lines = catTeamLines(teamRows, catSel, catSubSel, catSub2Sel);
  const pw = showPowers(lines);
  box.innerHTML = `${catFilterHtml(q)}
    ${lines.length ? `<div class="tablewrap"><table>
      <tr><th class="name">Team</th>${catHead(pw)}<th class="num">Bonuses</th><th class="num">Bpts</th><th class="num">PPB</th></tr>
      ${lines.map((l) =>
        `<tr><td class="name">${esc(l.team)}</td>${lineCells(l, pw)}<td class="num">${l.bh}</td>`
        + `<td class="num">${l.bpts}</td><td class="num">${l.ppb === null ? '–' : l.ppb.toFixed(2)}</td></tr>`).join('')}
    </table></div>` : noneHere}`;
  wireCatFilter(box);
}

function renderByPlayer(box, rows) {
  const players = [...new Map(rows.map((r) =>
    [JSON.stringify([r.team, r.player]), { team: r.team, player: r.player }])).values()]
    .sort((a, b) => a.team < b.team ? -1 : a.team > b.team ? 1 : a.player < b.player ? -1 : 1);
  if (!catPlayerSel
    || !players.some((p) => p.team === catPlayerSel.team && p.player === catPlayerSel.player)) {
    catPlayerSel = players[0];
  }
  const bd = catBreakdown(rows, catPlayerSel.team, catPlayerSel.player);
  const pw = showPowers(bd.map((b) => b.line));
  box.innerHTML = `
    <div style="margin-bottom:10px">
      <select id="catplayersel">
        ${players.map((p, i) => `<option value="${i}" ${p.team === catPlayerSel.team
          && p.player === catPlayerSel.player ? 'selected' : ''}>${esc(p.player)} (${esc(p.team)})</option>`).join('')}
      </select>
    </div>
    <div class="tablewrap"><table>
      <tr><th>Category</th>${catHead(pw)}</tr>
      ${bd.map(({ cat, line, subs }) =>
        `<tr><td><b>${esc(cat)}</b></td>${lineCells(line, pw)}</tr>`
        + subs.map(({ sub, line: sl, subs: s2 }) =>
          `<tr class="muted"><td style="padding-left:28px">${esc(sub)}</td>${lineCells(sl, pw)}</tr>`
          + s2.map(({ sub: x, line: l2 }) =>
            `<tr class="muted"><td style="padding-left:48px">${esc(x)}</td>${lineCells(l2, pw)}</tr>`).join('')).join('')
      ).join('')}
    </table></div>`;
  $('catplayersel').onchange = () => {
    catPlayerSel = players[Number($('catplayersel').value)];
    render();
  };
}

// How each category's questions played: tossups the way the buzzpoints
// sites show them, bonuses with PPB and their easy / medium / hard parts.
function renderQuestions(box, q) {
  const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '–');
  // Unknown is marked, and its tags are quoted: they're the packet's
  // own words, not a category this site recognized
  const unc = (l) => l.cat === UNKNOWN_CAT;
  const rowCls = (l) => ['cattop', 'catsub', 'catsub2'][l.level]
    + (unc(l) ? ' uncat' : '');
  const name = (l) => (l.isSub && unc(l) ? `\u201C${esc(l.sub)}\u201D`
    : esc([l.cat, l.sub, l.sub2][l.level]));
  const tl = questionLines(q.tossups, catSel, catSubSel, catSub2Sel);
  const bl = questionLines(q.bonuses, catSel, catSubSel, catSub2Sel);
  // the difficulty notice counts the bonuses on screen, once each: the
  // lines at the shallowest level shown
  const shallow = Math.min(...bl.map((l) => l.level));
  const top = bl.filter((l) => l.level === shallow);
  const ranked = top.reduce((n, l) => n + (l.ranked || 0), 0);
  const marked = top.reduce((n, l) => n + (l.marked || 0), 0);
  const note = !ranked ? '' : `<p class="ranknote" role="note"><span class="i" aria-hidden="true">i</span>${
    marked ? `Bonus difficulty not available for ${ranked} of ${ranked + marked} bonuses, ranked by conversion rate.`
      : 'Bonus difficulty not available, ranked by conversion rate.'}</p>`;
  box.innerHTML = `${catFilterHtml(q)}
    <div class="rhead">Tossups</div>
    ${tl.length ? `<div class="tablewrap"><table>
      <tr><th>Category</th><th class="num" title="Tossups in this category">Tossups</th>
        <th class="num" title="Times they were read, one per room">Heard</th><th class="num">Conv %</th><th class="num">Power %</th>
        <th class="num">Neg %</th><th class="num">Avg Buzz</th></tr>
      ${tl.map((l) => `<tr class="${rowCls(l)}"><td>${name(l)}</td><td class="num">${l.questions}</td><td class="num">${l.heard}</td>
        <td class="num">${pct(l.conv, l.heard)}</td><td class="num">${pct(l.powers, l.heard)}</td>
        <td class="num">${pct(l.negs, l.heard)}</td>
        <td class="num">${l.words && l.words.length ? (l.words.reduce((a, b) => a + b, 0) / l.words.length).toFixed(1) : '–'}</td></tr>`).join('')}
    </table></div>` : '<div class="muted">None</div>'}
    <div class="rhead" style="margin-top:18px">Bonuses</div>
    ${note}
    ${bl.length ? `<div class="tablewrap"><table>
      <tr><th>Category</th><th class="num" title="Bonuses in this category">Bonuses</th>
        <th class="num" title="Times they were read, one per room">Heard</th><th class="num">PPB</th>
        <th class="num sep">Easy</th><th class="num">Medium</th><th class="num">Hard</th></tr>
      ${bl.map((l) => `<tr class="${rowCls(l)}"><td>${name(l)}</td><td class="num">${l.questions}</td><td class="num">${l.heard}</td>
        <td class="num">${l.heard ? (l.pts / l.heard).toFixed(2) : '–'}</td>
        <td class="num sep">${pct(l.e, l.dHeard)}</td><td class="num">${pct(l.m, l.dHeard)}</td>
        <td class="num">${pct(l.h, l.dHeard)}</td></tr>`).join('')}
    </table></div>` : '<div class="muted">None</div>'}`;
  wireCatFilter(box);
}

function renderCats(box) {
  if (!catmap) { box.innerHTML = '<div class="muted">No categories</div>'; return; }
  const q = categoryQuestionStats(rawEntries, catmap);
  if (!q.tossups.length && !q.bonuses.length) { box.innerHTML = '<div class="muted">No games yet</div>'; return; }
  box.innerHTML = `
    ${viewsHtml([{ v: 'cat', label: 'Players' }, { v: 'team', label: 'Teams' },
      { v: 'player', label: 'By Player' }, { v: 'questions', label: 'Questions' }], catView, 'catview')}
    <div id="catbody"></div>`;
  wire(box, 'catview', (v) => { catView = v; });
  const rows = categoryStats(rawEntries, catmap);
  if (catView === 'questions') renderQuestions($('catbody'), q);
  else if (catView === 'team') renderByTeam($('catbody'), categoryTeamStats(rawEntries, catmap), q);
  else if (catView === 'player') {
    if (rows.length) renderByPlayer($('catbody'), rows);
    else $('catbody').innerHTML = '<div class="muted">No buzzes yet</div>';
  } else renderByCategory($('catbody'), rows, q);
}

/* ---------- stats tab ---------- */

// Games the Worker has accepted that the stats below don't include yet.
// Normally this is the minute between a room uploading and the cron
// folding that game into its round; a count that sticks around means a
// game's public copy is missing, which the TO's rebuild button fixes.
// Either way it beats silently showing fewer games than were played.
function pendingNote() {
  const n = (state.files || []).filter((f) => !loadedIds.has(f.id)).length;
  if (!n) return '';
  return `<div class="muted">${n} game${n === 1 ? '' : 's'} just in. `
    + 'Please wait for a minute before refreshing.</div>';
}

// The stats tab has two layouts, picked per viewer. Classic, the default,
// is the YellowFruit-style report (engine/report.js): the same six pages
// the TO can download, shown in place. New draws the same six in the
// page's own style (standings per pool when there are pools) from
// report.js reportData, so the two layouts always show the same numbers.
// Its links work like Classic's: a team, player, game or round opens on
// its own page, marked with a bar and a link back to where you were.
const STATS_LAYOUT_KEY = 'qbtdStatsLayout';
const STAND_VIEW_KEY = 'qbtdStandView';
// Scoresheets toggle: a viewer's show/hide, kept once unlocked (on by
// default); sheetAsk: the password field beside it is open
const SHEETS_KEY = 'qbtdSheets';
let sheetAsk = false;
const sheetsShown = () => readPref(SHEETS_KEY) !== 'off';
let standView = null;      // New layout, pools: 'table' | 'grid', for every pool at once
let statsLayout = null;    // 'classic' | 'new'
let statsSec = 'standings'; // New layout: a NEW_SECS key
let unmountReport = null;
const NEW_SECS = [['standings', 'Standings'], ['individuals', 'Individuals'], ['games', 'Scoreboard'],
  ['teams', 'Teams'], ['players', 'Players'], ['rounds', 'Rounds']];
let newMark = null; // the id a followed link landed on (marked)
// {sec, y, mark}: the places links were followed from, latest last. Back
// returns to the latest as it was, its own mark and Back link included.
let newBack = [];

const fx = (v, d) => (v === null || v === undefined ? '–' : v.toFixed(d));

// ids for the New layout's anchors: by position, so any name is safe
function newIds(rd) {
  const team = new Map(rd.teams.map((t, i) => [t.name, 'nt-' + i]));
  const player = new Map(rd.players.map((p, i) => [p.team + '\n' + p.name, 'np-' + i]));
  const game = new Map(rd.games.map((g, i) => [g.id, 'ng-' + i]));
  return {
    team: (n) => team.get(n), player: (t, n) => player.get(t + '\n' + n),
    game: (id) => game.get(id), round: (r) => 'nr-' + r,
  };
}
const goLink = (sec, id, text) => (id ? `<a href="#" data-go="${sec}|${esc(id)}">${text}</a>` : text);

// The New layout's tables share one shape: Classic's columns in Classic's
// order, a header (in <thead>, so it can stay on screen), and a sticky
// first column on a phone. Related columns sit together, and the first
// column of each group gets the class g0, which opens a gap before it. A
// rank or round column (nrkcol) hides on a phone, where the sticky cell
// carries it instead (span.nrk).
const rk = (v) => `<span class="nrk">${esc(String(v))}</span>`;
// A team's or player's Undergraduate / Division II marks, as tags beside
// the name (Classic gives each a column). reportData sets `ug` / `d2`
// only for a mark the roster tracks, so an untracked one draws nothing.
const markTags = (x) => (x.ug ? '<span class="ntag" title="Undergraduate">UG</span>' : '')
  + (x.d2 ? '<span class="ntag d2" title="Division II">DII</span>' : '');
const markWords = (x) => [x.ug && 'Undergraduate', x.d2 && 'Division II'].filter(Boolean).join(', ');

// The New layout's stage pick: a stage's name, or 'combined'; null until
// the viewer picks (pickStage then opens the stage being played)
let statStage = null;
// the stages offered in the order they're played (Prelims, then
// Playoffs; Combined after them), each with its own rounds (Combined
// needs the final places, so no stages without them)
function statStages(all) {
  if (!all.stageStandings || !all.combined) return [];
  const out = [];
  for (const sec of all.stageStandings) if (!out.some((x) => x.name === sec.stage)) out.push({ name: sec.stage, own: sec.own });
  return out.reverse(); // stageStandings run latest first
}
// the viewer's pick while it's offered; else Combined once the tournament
// is over, or the stage of the round being played, or the latest. A grid
// is one stage's games: never Combined
function pickStage(stages, grid) {
  if (!stages.length) return null;
  const offered = (v) => (v === 'combined' ? !grid : stages.some((x) => x.name === v));
  if (statStage && offered(statStage)) return statStage;
  if (finished() && !grid) return 'combined';
  const cur = liveRound();
  return (stages.find((x) => x.own && x.own.includes(cur)) || stages[stages.length - 1]).name;
}

function newStandings(rd, ids, vals, pp, { chips = '', stage = null } = {}) {
  const table = (teams, ranked) => `<div class="tablewrap"><table class="nstats">
    <thead><tr><th class="nrkcol"></th><th class="name nstick">Team</th><th class="num g0">W</th><th class="num">L</th>${rd.anyTies ? '<th class="num">T</th>' : ''}
      <th class="num g0" title="Points scored in regulation per ${rd.regTossups} regulation tossups heard">${pp}</th>
      ${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
      <th class="num" title="Tossups heard in regulation">TUH</th><th class="num g0" title="Points per bonus">PPB</th></tr></thead>
    <tbody>${teams.map((tm, i) => `<tr>
      <td class="muted nrkcol">${ranked ? esc(tm.rank) : i + 1}</td>
      <td class="name nstick">${rk(ranked ? tm.rank : i + 1)}${goLink('teams', ids.team(tm.name), esc(tm.name))}${markTags(tm)}</td>
      <td class="num g0">${tm.w}</td><td class="num">${tm.l}</td>${rd.anyTies ? `<td class="num">${tm.t}</td>` : ''}
      <td class="num g0">${fx(tm.pp, 1)}</td>
      ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${tm.counts[v] || 0}</td>`).join('')}
      <td class="num">${tm.regTuh}</td><td class="num g0">${fx(tm.ppb, 2)}</td></tr>`).join('')}</tbody>
  </table></div>`;
  // by stage and pool, as the Classic report heads them: the latest stage
  // first, a table per pool counting its stage's games (and the games
  // carried into it), ranked as YF ranks them
  if (stage === 'combined') {
    const views = rd.stageStandings.some((sec) => sec.pools.length > 1)
      ? `<span class="poolsep"></span>${chipsHtml([{ v: 'table', label: 'Table' }, { v: 'grid', label: 'Grid' }], 'table', 'standview')}` : '';
    return `<div class="poolbar">${chips}${views}</div>${table(rd.combined, true)}`;
  }
  if (rd.stageStandings) return stagedStandings(rd, ids, table, { chips, stage });
  // a schedule the stages can't be read from: per prelim pool, as before;
  // teams in none go last
  const pools = (schedule && schedule.pools) || {};
  const keys = Object.keys(pools).sort();
  if (keys.length < 2) return table(rd.teams, true);
  const inPool = new Set(keys.flatMap((k) => pools[k]));
  // one switch for every pool: all tables, or all grids of who has played whom
  if (!standView) standView = readPref(STAND_VIEW_KEY) === 'grid' ? 'grid' : 'table';
  const grid = standView === 'grid';
  return `<div class="poolbar">${chipsHtml([{ v: 'table', label: 'Table' }, { v: 'grid', label: 'Grid' }], standView, 'standview')}</div>`
    + (grid ? poolGrids(rd, ids, keys.map((k) => ['Pool ' + k, rd.teams.filter((t) => pools[k].includes(t.name))])
      .filter(([, teams]) => teams.length)) : '')
    + (grid ? [] : keys.map((k) => ['Pool ' + k, rd.teams.filter((t) => pools[k].includes(t.name))]))
      .concat([['Other teams', rd.teams.filter((t) => !inPool.has(t.name))]])
      .filter(([, teams]) => teams.length)
      .map(([name, teams]) => `<h3 class="poolhead">${esc(name)}</h3>${table(teams, false)}`).join('');
}

// "Illinois A" -> "Ill A", "Notre Dame B" -> "ND B", "University of Iowa A"
// -> "Iowa A": a team's name short enough to head a grid column.
function shortTeam(name) {
  const words = String(name).trim().split(/\s+/);
  const tail = words.length > 1 && /^[A-Z0-9]{1,2}$/.test(words[words.length - 1]) ? ' ' + words.pop() : '';
  const base = words.filter((w, i) => !(/^(of|the|at)$/i.test(w) || (i === 0 && /^(university|college)$/i.test(w) && words.length > 1)));
  const use = base.length ? base : words;
  const core = use.length > 1 ? use.map((w) => w[0].toUpperCase()).join('')
    : use[0].length > 5 ? use[0].slice(0, 3) : use[0];
  return core + tail;
}

// The standings by stage: a heading per stage when there are several, a
// table (or grid) per pool. One switch, Table or Grid, for every pool.
function stagedStandings(rd, ids, table, { chips = '', stage = null } = {}) {
  const secs = stage ? rd.stageStandings.filter((sec) => sec.stage === stage) : rd.stageStandings;
  const anyPools = secs.some((sec) => sec.pools.length > 1);
  if (!standView) standView = readPref(STAND_VIEW_KEY) === 'grid' ? 'grid' : 'table';
  const grid = standView === 'grid' && anyPools;
  const row = new Map(rd.teams.map((t) => [t.name, t]));
  const views = anyPools ? chipsHtml([{ v: 'table', label: 'Table' }, { v: 'grid', label: 'Grid' }], standView, 'standview') : '';
  return (chips || views ? `<div class="poolbar">${chips}${chips && views ? '<span class="poolsep"></span>' : ''}${views}</div>` : '')
    + secs.map((sec) => `${secs.length > 1 ? `<h2 class="stagehead">${esc(sec.name)}</h2>` : ''}${grid
      ? poolGrids(rd, ids, sec.pools.map((pl) => [pl.name, pl.teams.map((t) => row.get(t.name)).filter(Boolean), pl.rounds]))
      : sec.pools.map((pl) => `${sec.pools.length > 1 ? `<h3 class="poolhead">${esc(pl.name)}</h3>` : ''}${table(pl.teams, true)}`).join('')}`).join('');
}

// Every pool's grid, in one table so the squares line up from pool to
// pool whatever the length of each pool's team names.
function poolGrids(rd, ids, pools) {
  const span = 2 + Math.max(...pools.map(([, teams]) => teams.length));
  return `<div class="tablewrap pgridwrap"><table class="pgrid">${pools.map(([name, teams, rounds]) => `<tbody>
    <tr><td class="pghead" colspan="${span}"><h3 class="poolhead">${esc(name)}</h3></td></tr>
    ${poolGrid(rd, ids, teams, rounds)}</tbody>`).join('')}
  </table></div>`;
}

// One pool as a square grid, teams in standings order down the side and
// across the top. A square is the row team's game against the column
// team in the pool's rounds (`rounds`; the first phase's when not given):
// both scores once played (a link to the game), else the round it is
// scheduled for. The record at the end counts the grid's own games.
function poolGrid(rd, ids, teams, rounds = null) {
  const allRounds = schedule.phases.flatMap((ph) => ph.rounds);
  const poolRounds = new Set(rounds || schedule.phases[0].rounds.map((r) => r.round));
  const shownRounds = allRounds.filter((r) => poolRounds.has(r.round));
  const names = new Set(teams.map((t) => t.name));
  const key = (x, y) => (x < y ? x + '\n' + y : y + '\n' + x);
  const played = new Map(); // pair -> the game (the first, should a pair meet twice)
  for (const g of rd.games) {
    const [a, b] = g.teams;
    if (!poolRounds.has(g.round) || !names.has(a.name) || !names.has(b.name)) continue;
    if (!played.has(key(a.name, b.name))) played.set(key(a.name, b.name), g);
  }
  const due = new Map(); // pair -> round
  for (const r of shownRounds) {
    for (const g of r.games) {
      const a = g.a && g.a.team;
      const b = g.b && g.b.team;
      if (a && b && names.has(a) && names.has(b) && !due.has(key(a, b))) due.set(key(a, b), r.round);
    }
  }
  const cell = (tm, o) => {
    if (tm === o) return '<td class="self"></td>';
    const g = played.get(key(tm.name, o.name));
    if (!g) {
      const r = due.get(key(tm.name, o.name));
      return r ? `<td class="todo" title="Round ${r}">R${r}</td>` : '<td class="todo"></td>';
    }
    const me = g.teams.find((x) => x.name === tm.name);
    const them = g.teams.find((x) => x.name === o.name);
    const res = resultOf(me, them);
    const cls = res === 'W' ? 'won' : res === 'L' ? 'lost' : '';
    if (g.forfeit) {
      const tip = res === 'W' ? `${tm.name} wins by forfeit` : `${tm.name} forfeits to ${o.name}`;
      return `<td class="${cls}" title="${esc(tip)}">${goLink('games', ids.game(g.id), res === 'W' ? 'W' : 'FF')}</td>`;
    }
    const tip = `${tm.name} ${me.points}, ${o.name} ${them.points}`;
    return `<td class="${cls}" title="${esc(tip)}">${
      goLink('games', ids.game(g.id), `${me.points}<span class="opp">${them.points}</span>`)}</td>`;
  };
  const rec = (tm) => {
    let w = 0;
    let l = 0;
    for (const o of teams) {
      const g = o === tm ? null : played.get(key(tm.name, o.name));
      if (!g) continue;
      const res = resultOf(g.teams.find((x) => x.name === tm.name), g.teams.find((x) => x.name === o.name));
      if (res === 'W') w++; else if (res === 'L') l++;
    }
    return `${w}\u2013${l}`;
  };
  return `<tr><th></th>${teams.map((t) => `<th class="colh" title="${esc(t.name)}">${esc(shortTeam(t.name))}</th>`).join('')}<th class="colh">W\u2013L</th></tr>
    ${teams.map((tm) => `<tr><th class="rowh">${goLink('teams', ids.team(tm.name), esc(tm.name))}</th>${
      teams.map((o) => cell(tm, o)).join('')}<td class="rec">${rec(tm)}</td></tr>`).join('')}`;
}

function newIndividuals(rd, ids, vals, pp) {
  return `<div class="tablewrap"><table class="nstats">
    <thead><tr><th class="nrkcol"></th><th class="name nstick">Player</th><th class="name teamcol">Team</th>
      <th class="num g0" title="Games played">GP</th>
      ${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
      <th class="num" title="Tossups heard">TUH</th>
      <th class="num g0">Pts</th><th class="num" title="Points per ${rd.regTossups} tossups heard">${pp}</th></tr></thead>
    <tbody>${rd.players.map((p) => `<tr>
      <td class="muted nrkcol">${esc(p.rank)}</td>
      <td class="name nstick">${rk(p.rank)}${goLink('players', ids.player(p.team, p.name), esc(p.name))}${markTags(p)}<span class="subteam">${esc(p.team)}</span></td>
      <td class="name muted teamcol">${goLink('teams', ids.team(p.team), esc(p.team))}</td>
      <td class="num g0">${p.gp.toFixed(1)}</td>
      ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${p.counts[v] || 0}</td>`).join('')}
      <td class="num">${p.tuh}</td><td class="num g0">${p.points}</td><td class="num">${fx(p.pp, 2)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// a game row of a team's or player's log: round, opponent, result, score
const logCells = (ids, g) => `<td class="muted nrkcol">${g.round}</td>
  <td class="name nstick">${rk(g.round)}${goLink('teams', ids.team(g.opp), esc(g.opp))}</td><td>${g.result}</td>
  <td class="name">${goLink('games', ids.game(g.gameId), esc(g.score))}</td>`;
const logHead = '<th class="nrkcol">Rd</th><th class="name nstick">Opponent</th><th></th><th class="name">Score</th>';
// `at`: the Classic report's id for the same thing (reportData anchor)
const secHead = (id, title, meta, at) => `<div class="nsec" id="${id}" data-at="${esc(at)}"><h3 class="nhead"><span>${title}</span>${
  meta ? `<span class="meta">${meta}</span>` : ''}</h3>`;

// the Scoresheets switch: on/off once unlocked; locked, it is off with a
// closed padlock, and pressing it opens the password field
const LOCK_SVG = '<svg class="swlock" viewBox="0 0 12 14" width="11" height="13" aria-hidden="true">'
  + '<path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<rect x="1" y="6" width="10" height="7.5" rx="1.5" fill="currentColor"/></svg>';
const sheetSwitch = (on, locked) => `<button id="sheetchip" class="sw${on ? ' on' : ''}${locked ? ' locked' : ''}" role="switch"
  aria-checked="${on}" title="${locked ? 'Locked: enter the password to see scoresheets' : on ? 'Hide scoresheets' : 'Show scoresheets'}">${
  locked ? LOCK_SVG : ''}<span>Scoresheets</span><span class="swtrack"><span class="swknob"></span></span><span class="swstate">${
  locked ? 'Locked' : on ? 'On' : 'Off'}</span></button>`;

// Scoresheets are behind the stats password, a viewer can switch them
// off, and a round's appear only once all its games are in (buzz_done,
// the buzzpoints rule). For one reportData game: null (none), 'wait' (its
// round is still being played) or the scoresheet.
function sheetOf(g, regTossups) {
  if (!state.scoresheets || !buzzStored() || !sheetsShown()) return null;
  if (!buzzDoneSet().has(g.round)) return 'wait';
  const e = rawEntries.find((x) => x.id === g.fileId);
  const cr = catmap && catmap.rounds && catmap.rounds[String(g.round)];
  return (e && buildScoresheet(e.qbj, cr ? cr.t : null, regTossups)) || null;
}
const sheetWait = (g) => `<p class="muted sxwait">The scoresheet will appear when all round ${g.round} games finish.</p>`;
// the switch and, while locked and asked, the password field beside it
function sheetToggle() {
  if (!state.scoresheets) return '';
  const open = Boolean(buzzStored());
  return `<span class="sxtoggle">${!open && sheetAsk
    ? `<input id="sheetpw" type="password" placeholder="Password" size="12" aria-label="Scoresheet password">
       <button id="sheetgo" class="small primary">View</button>` : ''}${sheetSwitch(open && sheetsShown(), !open)}</span>`;
}
// The switch's handlers, for whichever layout drew it. A redraw remounts
// the Classic report, so its place (page and scroll) is kept first.
function wireSheetToggle() {
  const keep = () => { const rb = document.querySelector('.reportbox'); if (rb) pendingPlace = reportPlace(rb); };
  if ($('sheetchip')) {
    $('sheetchip').onclick = () => {
      keep();
      if (buzzStored()) { savePref(SHEETS_KEY, sheetsShown() ? 'off' : 'on'); render(); return; }
      sheetAsk = !sheetAsk;
      render();
      if ($('sheetpw')) $('sheetpw').focus();
    };
  }
  if ($('sheetgo')) {
    // a right password redraws (tryBuzzKey), at the place kept here; once
    // unlocked the field is gone, so sheetAsk can simply reset
    const go = async () => {
      keep();
      await tryBuzzKey($('sheetpw') ? $('sheetpw').value : '');
      if (buzzStored()) sheetAsk = false;
    };
    $('sheetgo').onclick = go;
    $('sheetpw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }
}

// The Classic report is YellowFruit's, and the files a TD downloads must
// stay byte-identical to YF's own (engine/report.js), so scoresheets are
// added to the in-page copy only, on the Scoreboard page laid out as New
// lays it out: the game's tables stacked on the left (the two team tables
// one above the other, then bonuses), the scoresheet on the right, which
// drops below them on a narrow screen. The report is its own document (reportframe.js), so
// they carry their styles in: the page's own scoresheet rules, with the
// theme's colours.
function sheetFrameCss() {
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch (e) { continue; }
    for (const r of list) if (/\.(sx|cf)\b|\.sxsubs|\.sxwait/.test(r.cssText)) rules.push(r.cssText);
  }
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--fg', '--muted', '--line', '--hover-bg', '--c-sci', '--c-lit', '--c-hist', '--c-fa', '--c-rmp', '--c-oth']
    .map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
  return `<style>:root{${vars};--bg:transparent}
    .cslay{display:flex;flex-wrap:wrap;gap:12px 28px;align-items:flex-start}
    .csleft{flex:0 1 auto;min-width:0}
    .csleft .boxScoreTable{flex-direction:column;gap:12px}
    .csleft table{width:auto!important;min-width:18em}
    .cslay>.sxwrap{flex:none;width:min-content;max-width:100%}
    .sxwrap .tablewrap{overflow-x:auto}${rules.join('\n')}</style>`;
}
function withSheets(pages, rd) {
  const at = pages.findIndex((p) => /games\.html$/.test(p.name));
  if (at < 0 || !state.scoresheets || !buzzStored() || !sheetsShown()) return pages;
  let text = pages[at].text;
  let css = sheetFrameCss();
  for (const g of rd.games) {
    const sheet = sheetOf(g, rd.regTossups);
    if (!sheet) continue;
    // a game's box score: its team tables (.boxScoreTable), then its
    // bonus table, the last table before the next game
    const start = text.indexOf(`id=${g.anchor.replace(/^games-/, '')} `);
    const from = start < 0 ? -1 : text.indexOf('<div class="boxScoreTable">', start);
    const bonus = from < 0 ? -1 : text.indexOf('Bonuses', from);
    const end = bonus < 0 ? -1 : text.indexOf('</table>', bonus) + 8;
    if (end < 8) continue;
    if (sheet === 'wait') {
      text = text.slice(0, end) + css + sheetWait(g) + text.slice(end);
    } else {
      text = text.slice(0, from) + css + '<div class="cslay"><div class="csleft">' + text.slice(from, end)
        + '</div>' + sheetHtml(sheet, rd.regTossups) + '</div>' + text.slice(end);
    }
    css = '';
  }
  return pages.map((p, i) => (i === at ? { ...p, text } : p));
}

function newGames(rd, ids, vals) {
  const rounds = [...new Set(rd.games.map((g) => g.round))];
  const box = (g) => {
    // a forfeit is its result: no box score, no scoresheet
    if (g.forfeit) return `${secHead(ids.game(g.id), `${esc(g.winner)} defeats ${esc(g.loser)} by forfeit`, `Round ${g.round}`, g.anchor)}</div>`;
    const head = `Round ${g.round} · Tossups read: ${g.tossupsRead}${g.otTossups ? ` (${g.otTossups} in OT)` : ''}`;
    const w = g.teams.find((t) => t.name === g.winner);
    const l = g.teams.find((t) => t.name === g.loser);
    const title = `${esc(w.name)} ${w.points}, ${esc(l.name)} ${l.points}${g.otTossups ? ' (OT)' : ''}`;
    const sheet = sheetOf(g, rd.regTossups);
    const tables = `<div class="nbox">${g.teams.map((t) => `<div class="tablewrap"><table class="nstats">
        <thead><tr><th class="name nstick">${goLink('teams', ids.team(t.name), esc(t.name))}</th><th class="num">TUH</th>
          ${vals.map((v) => `<th class="num">${v}</th>`).join('')}<th class="num">Pts</th></tr></thead>
        <tbody>${t.players.map((p) => `<tr><td class="name nstick">${goLink('players', ids.player(t.name, p.name), esc(p.name))}</td>
          <td class="num">${p.tuh}</td>${vals.map((v) => `<td class="num">${p.counts[v] || 0}</td>`).join('')}
          <td class="num">${p.points}</td></tr>`).join('')}
        <tr class="ntot"><td class="name nstick">Total</td><td></td>${vals.map((v) => `<td class="num">${t.counts[v] || 0}</td>`).join('')}
          <td class="num">${t.tossupPoints}</td></tr></tbody>
      </table></div>`).join('')}</div>
      <div class="tablewrap"><table class="nstats nbonus">
        <thead><tr><th class="name nstick">Bonuses</th><th class="num">Heard</th><th class="num">Pts</th><th class="num">PPB</th></tr></thead>
        <tbody>${g.teams.map((t) => `<tr><td class="name nstick">${esc(t.name)}</td><td class="num">${t.bonusesHeard}</td>
          <td class="num">${t.bonusPoints}</td><td class="num">${fx(t.ppb, 2)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    return `${secHead(ids.game(g.id), title, head, g.anchor)}${
      sheet && sheet !== 'wait' ? `<div class="slay"><div class="sleft">${tables}</div>${sheetHtml(sheet, rd.regTossups)}</div>`
        : tables + (sheet === 'wait' ? sheetWait(g) : '')}</div>`;
  };
  // the Scoresheets toggle, at the end of the round links: locked, it
  // opens a password field beside it; unlocked, it shows or hides them
  return `<div class="chips njump">${rounds.map((r) => `<a href="#" class="chip" data-go="games|${ids.round(r)}">Round ${r}</a>`).join('')}${sheetToggle()}</div>`
    + rounds.map((r) => `<h3 class="poolhead" id="${ids.round(r)}" data-at="games-Round-${r}">Round ${r}</h3>${
      rd.games.filter((g) => g.round === r).map(box).join('')}`).join('');
}

function newTeams(rd, ids, vals, pp) {
  const byName = [...rd.teams].sort((a, b) => a.name.toLocaleUpperCase().localeCompare(b.name.toLocaleUpperCase()));
  return byName.map((t) => {
    const players = rd.players.filter((p) => p.team === t.name);
    return `${secHead(ids.team(t.name), esc(t.name), [esc(t.record), markWords(t)].filter(Boolean).join(' · '), t.anchor)}
      <div class="tablewrap"><table class="nstats">
        <thead><tr>${logHead}${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
          <th class="num" title="Tossups heard">TUH</th><th class="num g0" title="Bonuses heard">BHrd</th>
          <th class="num" title="Points scored on bonuses">BPts</th><th class="num" title="Points per bonus">PPB</th></tr></thead>
        <tbody>${t.games.map((g) => `<tr>${logCells(ids, g)}${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${g.counts[v] || 0}</td>`).join('')}
          <td class="num">${g.tuh}</td><td class="num g0">${g.bonusesHeard}</td><td class="num">${g.bonusPoints}</td>
          <td class="num">${fx(g.ppb, 2)}</td></tr>`).join('')}
        <tr class="ntot"><td class="nrkcol"></td><td class="name nstick">Total</td><td>${esc(t.record)}</td><td></td>
          ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${t.counts[v] || 0}</td>`).join('')}
          <td class="num">${t.tuh}</td><td class="num g0">${t.bonusesHeard}</td><td class="num">${t.bonusPoints}</td>
          <td class="num">${fx(t.ppb, 2)}</td></tr></tbody>
      </table></div>
      ${players.length ? `<div class="tablewrap"><table class="nstats">
        <thead><tr><th class="name nstick">Player</th><th class="num g0" title="Games played">GP</th>${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
          <th class="num" title="Tossups heard">TUH</th><th class="num g0">${pp}</th></tr></thead>
        <tbody>${players.map((p) => `<tr><td class="name nstick">${goLink('players', ids.player(p.team, p.name), esc(p.name))}${markTags(p)}</td>
          <td class="num g0">${p.gp.toFixed(1)}</td>${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${p.counts[v] || 0}</td>`).join('')}
          <td class="num">${p.tuh}</td><td class="num g0">${fx(p.pp, 2)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}</div>`;
  }).join('');
}

function newPlayers(rd, ids, vals) {
  const sorted = [...rd.players].sort((a, b) =>
    a.team.toLocaleUpperCase().localeCompare(b.team.toLocaleUpperCase())
    || a.name.toLocaleUpperCase().localeCompare(b.name.toLocaleUpperCase()));
  return sorted.map((p) => `${secHead(ids.player(p.team, p.name), esc(p.name),
    [goLink('teams', ids.team(p.team), esc(p.team)), markWords(p)].filter(Boolean).join(' · '), p.anchor)}
    <div class="tablewrap"><table class="nstats">
      <thead><tr>${logHead}<th class="num g0" title="Games played">GP</th>${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
        <th class="num" title="Tossups heard">TUH</th><th class="num g0">Pts</th></tr></thead>
      <tbody>${p.games.map((g) => `<tr>${logCells(ids, g)}<td class="num g0">${g.gp.toFixed(1)}</td>
        ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${g.counts[v] || 0}</td>`).join('')}
        <td class="num">${g.tuh}</td><td class="num g0">${g.points}</td></tr>`).join('')}
      <tr class="ntot"><td class="nrkcol"></td><td class="name nstick">Total</td><td></td><td></td><td class="num g0">${p.gp.toFixed(1)}</td>
        ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${p.counts[v] || 0}</td>`).join('')}
        <td class="num">${p.tuh}</td><td class="num g0">${p.points}</td></tr></tbody>
    </table></div></div>`).join('');
}

function newRounds(rd, ids) {
  const n = rd.regTossups;
  const cells = (r) => `<td class="num">${r.games}</td><td class="num">${fx(r.ppTeam, 1)}</td>
    ${rd.hasPowers ? `<td class="num">${r.powerPct === null ? '–' : r.powerPct.toFixed(0) + '%'}</td>` : ''}
    <td class="num">${r.convPct === null ? '–' : r.convPct.toFixed(0) + '%'}</td>
    ${rd.hasNegs ? `<td class="num">${fx(r.negsTeam, 1)}</td>` : ''}<td class="num">${fx(r.ppb, 2)}</td>`;
  return `<div class="tablewrap"><table class="nstats">
    <thead><tr><th class="nstick">Round</th><th class="num">Games</th>
      <th class="num" title="Points per team per ${n} tossups heard">Pts/Tm/${n}TUH</th>
      ${rd.hasPowers ? '<th class="num" title="Tossups powered by either team">TU Powered</th>' : ''}
      <th class="num" title="Tossups answered correctly by either team">TU Converted</th>
      ${rd.hasNegs ? `<th class="num" title="Incorrect interrupts per team per ${n} tossups heard">Negs/Tm/${n}TUH</th>` : ''}
      <th class="num" title="Points per bonus">PPB</th></tr></thead>
    <tbody>${rd.rounds.map((r) => `<tr><td class="nstick">${goLink('games', ids.round(r.round), String(r.round))}</td>${cells(r)}</tr>`).join('')}
    <tr class="ntot"><td class="nstick">Total</td>${cells(rd.total)}</tr></tbody>
  </table></div>`;
}

// Switching layouts keeps the place: the same page, at the same team,
// player, game or round. Classic's pages map onto New's sections one to
// one, and New's sections carry Classic's ids (data-at).
const PAGE_SEC = { standings: 'standings', individuals: 'individuals', games: 'games',
  teamdetail: 'teams', playerdetail: 'players', rounds: 'rounds' };
let pendingPlace = null; // {page, anchor}: where the layout switch was made

function newPlace(box) {
  const page = Object.keys(PAGE_SEC).find((k) => PAGE_SEC[k] === statsSec) || 'standings';
  const mark = box && box.querySelector('.nmark[data-at]');
  if (mark) return { page, anchor: mark.dataset.at, marked: true };
  let anchor = null;
  for (const el of (box ? box.querySelectorAll('[data-at]') : [])) {
    if (el.getBoundingClientRect().top > 80) break;
    anchor = el.dataset.at;
  }
  return { page, anchor };
}

// A sticky header only sticks inside its nearest scrolling box. A table
// that fits its width doesn't scroll sideways (nfit), so its header
// sticks to the page. One that doesn't (a phone, mostly) becomes its own
// scroll box, both ways and at most most of a screen tall (nscroll), so
// its header and first column stay put inside it; an edge fade (more)
// says there's more to the right until the end is reached.
function fitTables(box) {
  for (const table of box.querySelectorAll('table.nstats')) {
    const wrap = table.parentElement;
    let fade = wrap.parentElement;
    if (!fade.classList.contains('nfade')) {
      fade = document.createElement('div');
      fade.className = 'nfade';
      wrap.replaceWith(fade);
      fade.appendChild(wrap);
    }
    wrap.classList.remove('nfit', 'nscroll');
    const over = table.scrollWidth > wrap.clientWidth + 1;
    wrap.classList.add(over ? 'nscroll' : 'nfit');
    const edge = () => fade.classList.toggle('more',
      over && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 2);
    wrap.onscroll = edge;
    edge();
  }
}
let refitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => { const b = $('newstats'); if (b) fitTables(b); }, 150);
});

function renderNewStats(box) {
  // the schedule too, so standings go by stage and pool as Classic's do
  const settings = effectiveFormat(state.format);
  const all = reportData({ name: state.name, matches: dedupeMatches(matches), roster, settings, schedule });
  // Prelims / Playoffs / Combined: a stage's pages count its own games
  // (its standings, as Classic's, also those carried into it); Combined is
  // the whole day, its standings every team in its final place
  const stages = statStages(all);
  if (!standView) standView = readPref(STAND_VIEW_KEY) === 'grid' ? 'grid' : 'table';
  const stage = pickStage(stages, statsSec === 'standings' && standView === 'grid');
  const own = stage && stage !== 'combined' ? stages.find((x) => x.name === stage).own : null;
  const rd = own ? reportData({ name: state.name, matches: dedupeMatches(matches).filter((m) => own.includes(m.round)),
    roster, settings, schedule }) : all;
  const ids = newIds(rd);
  const vals = rd.vals.filter((v) => v !== 0);
  const pp = `PP${rd.regTossups}TUH`;
  const grid = statsSec === 'standings' && standView === 'grid';
  const chips = stages.length ? chipsHtml([...stages.map((x) => ({ v: x.name, label: x.name })),
    { v: 'combined', label: 'Combined', off: grid }], stage, 'statstage') : '';
  const top = (html) => (chips ? `<div class="poolbar">${chips}</div>` : '') + html;
  const draw = { standings: () => newStandings(stage ? all : rd, ids, vals, pp, { chips, stage }), individuals: () => top(newIndividuals(rd, ids, vals, pp)),
    games: () => top(newGames(rd, ids, vals)), teams: () => top(newTeams(rd, ids, vals, pp)),
    players: () => top(newPlayers(rd, ids, vals)), rounds: () => top(newRounds(rd, ids)) };
  box.innerHTML = (draw[statsSec] || draw.standings)();
  wire(box, 'standview', (v) => { standView = v; savePref(STAND_VIEW_KEY, v); });
  wire(box, 'statstage', (v) => { statStage = v; });
  wireSheetToggle();
  fitTables(box);
  // a followed link: mark where it landed, with the way back (a round's
  // heading gets only the way back)
  const el = newMark && document.getElementById(newMark);
  if (el) {
    const sec = el.classList.contains('nsec');
    if (sec) el.classList.add('nmark');
    const from = newBack[newBack.length - 1];
    if (from) {
      const label = (NEW_SECS.find(([k]) => k === from.sec) || [])[1];
      (sec ? el.querySelector('.nhead') : el).insertAdjacentHTML('beforeend',
        ` <a href="#" class="nback" data-back="1">← Back to ${esc(label || 'the last page')}</a>`);
    }
  }
  if (pendingPlace) {
    const at = pendingPlace.anchor && [...box.querySelectorAll('[data-at]')].find((x) => x.dataset.at === pendingPlace.anchor);
    if (at && pendingPlace.marked && at.classList.contains('nsec')) at.classList.add('nmark'); // its bar, carried over
    pendingPlace = null;
    if (at) window.scrollTo(0, Math.max(0, at.getBoundingClientRect().top + window.scrollY - 8));
  }
  box.onclick = (e) => {
    const a = e.target.closest('[data-go], [data-back]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.back) {
      const from = newBack.pop();
      statsSec = from.sec; newMark = from.mark;
      render();
      window.scrollTo(0, from.y);
      return;
    }
    const [sec, id] = a.dataset.go.split('|');
    if (!(sec === statsSec && sec === 'games' && id.startsWith('nr-'))) newBack.push({ sec: statsSec, y: window.scrollY, mark: newMark });
    statsSec = sec;
    newMark = id;
    render();
    const target = document.getElementById(id);
    if (target) window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - 8));
  };
}

function renderStatsTab(box) {
  // a redraw (new games on Refresh, a new password) keeps the Classic
  // report where the reader was, as a layout switch does
  const shown = box.querySelector('.reportbox');
  if (!pendingPlace && shown) pendingPlace = reportPlace(shown);
  if (unmountReport) { unmountReport(); unmountReport = null; }
  if (!matches.length) {
    box.innerHTML = statsErrors.length
      ? statsErrors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')
      : pendingNote() || '<div class="muted">No games yet</div>';
    return;
  }
  if (!statsLayout) statsLayout = readPref(STATS_LAYOUT_KEY) === 'new' ? 'new' : 'classic';
  const isNew = statsLayout === 'new';
  const sec = (v, label) => `<a href="#" class="view${statsSec === v ? ' on' : ''}" data-statssec="${v}">${label}</a>`;
  box.innerHTML = statsErrors.map((e) => `<div class="bad">${esc(e)}</div>`).join('') + pendingNote()
    + `<div class="views statsbar">
        ${isNew ? NEW_SECS.map(([k, label]) => sec(k, label)).join('') : sheetToggle()}
        <span class="grow"></span>
        <span class="layoutpick"><span class="muted">Layout</span>${chipsHtml([{ v: 'classic', label: 'Classic' },
          { v: 'new', label: 'New' }], statsLayout, 'layout')}</span>
      </div>`
    + (isNew ? '<div id="newstats"></div>'
      : '<div class="reportbox"></div>');
  wire(box, 'layout', (v) => {
    if (v === statsLayout) return;
    pendingPlace = statsLayout === 'new' ? newPlace($('newstats')) : reportPlace(box.querySelector('.reportbox'));
    if (v === 'new' && pendingPlace) statsSec = PAGE_SEC[pendingPlace.page] || 'standings';
    newMark = null; newBack = [];
    statsLayout = v; savePref(STATS_LAYOUT_KEY, v);
  });
  wire(box, 'statssec', (v) => { statsSec = v; newMark = null; newBack = []; });
  if (isNew) { renderNewStats($('newstats')); return; }
  wireSheetToggle();
  // same rules the TO's own download uses: the report is scaled and its
  // overtime split by the tournament's regulation tossup count, and the
  // schedule's stages and pools head its standings
  const opts = { name: state.name, matches: dedupeMatches(matches), roster, settings: effectiveFormat(state.format), schedule };
  let pages = buildReport(opts);
  if (state.scoresheets && buzzStored() && sheetsShown()) pages = withSheets(pages, reportData(opts));
  unmountReport = mountReport(box.querySelector('.reportbox'), pages, { start: pendingPlace });
  pendingPlace = null;
}

/* ---------- shell ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  const box = $('out');
  // a tab picked before the first load lands: load() renders it then
  if (!state) return;
  $('round').textContent = finished() ? 'Finished' : 'Round ' + liveRound();
  if (tab === 'schedule') renderSchedule(box);
  else if (tab === 'buzz') renderBuzz(box);
  else if (tab === 'cats') renderCats(box);
  else renderStatsTab(box);
}

function setTab(next, push = true) {
  tab = next;
  if (push) history.replaceState(null, '', '#' + next);
  render();
}

/* The state: the tournament's file on qb-td-live (worker.js "public state
   on qb-td-live"), which costs the Worker nothing, else the Worker's
   /pub/:slug — at most ONE Worker request per load or refresh, never a
   retry, still no polling.
   - 200: use it. It's served max-age=0 with an ETag, so cache:
     'no-cache' revalidates (usually a 304) and the refresh button always
     sees the newest file. An `at` older than what's on screen is the
     edge briefly serving the previous deploy: nothing new, keep what we
     have.
   - 404: not published there (yet, or any more): ask the Worker, which
     knows. No latch — the next refresh looks at the file again.
   - network error, 5xx, bad JSON, or a file overdue for its heartbeat
     (deploys are failing, so it's frozen): ask the Worker, and skip the
     file for LIVE_LATCH_MS in this tab so each refresh doesn't pay for
     the failure again.
   ?fb= tells the Worker why, for its logs. With no LIVE (dev, a
   self-hosted backend, ?live=off) or frozen data, it's /pub/:slug as
   always. cache: 'no-cache' there too: /pub/:slug is served max-age=60,
   and refreshing is the ONLY way a viewer gets newer data. */
const LIVE_LATCH_MS = 10 * 60 * 1000;
const LIVE_LATCH_KEY = 'qbtd-live-off';
const LIVE_TIMEOUT_MS = 5000;
// how far past its heartbeat a file may be before it counts as frozen
const LIVE_GRACE_MS = 5 * 60 * 1000;
let heldAt = 0;
function liveLatched() {
  try { return Date.now() < Number(sessionStorage.getItem(LIVE_LATCH_KEY) || 0); } catch (e) { return false; }
}
function latchLive() {
  try { sessionStorage.setItem(LIVE_LATCH_KEY, String(Date.now() + LIVE_LATCH_MS)); } catch (e) { /* private mode */ }
}
async function loadState() {
  const worker = async (why) =>
    asJson(await pub('/pub/' + slug + (why ? '?fb=' + why : ''), { cache: 'no-cache' }));
  if (!LIVE || usingStaticData()) return worker(null);
  if (liveLatched()) return worker('latched');
  let body;
  try {
    const res = await fetch(LIVE + '/t/' + encodeURIComponent(slug) + '.json',
      { cache: 'no-cache', signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    if (res.status === 404) return worker('404');
    if (!res.ok) throw new Error('live ' + res.status);
    body = await res.json();
    if (!body || typeof body.at !== 'number' || typeof body.name !== 'string') throw new Error('live body');
  } catch (e) {
    latchLive();
    return worker('err');
  }
  const now = Date.now();
  if (body.hb_until && now < body.hb_until && now - body.at > (body.hb_ms || 0) + LIVE_GRACE_MS) {
    latchLive();
    return worker('old');
  }
  if (state && body.at < heldAt) return state;
  heldAt = body.at;
  return body;
}

async function load() {
  try {
    // Only the state comes from here; the heavy blobs below are served
    // off GitHub (and the Worker as their fallback).
    state = await loadState();
    // Track the snapshot's stamps when one is advertised — its blobs are
    // what we'll fetch, so refetch decisions must follow what IT holds
    // (it can trail the Worker by up to a cron tick; the next refresh
    // converges). Frozen data (demo/archive) never uses snapshots.
    snap = !usingStaticData() && state.pub && state.pub.sha ? state.pub : null;
    const storedKey = buzzStored();
    // a new password moves buzz_v: the old key is dropped, and the page
    // redraws locked even when nothing else moved
    const dropped = Boolean(storedKey && storedKey.v !== state.buzz_v);
    if (dropped) sessionStorage.removeItem(BUZZ_KEY);
    document.title = state.name;
    $('tname').textContent = state.name;
    $('round').textContent = 'Round ' + liveRound();
    $('tab-buzz').hidden = !state.buzz;
    // the Categories tab: there are categories, and the TD's Category
    // stats switch is on (cat_tab false; absent from an older Worker)
    const catTab = Boolean(state.cats) && state.cat_tab !== false;
    $('tab-cats').hidden = !catTab;
    if (tab === 'buzz' && !state.buzz) setTab('stats', false);
    if (tab === 'cats' && !catTab) setTab('stats', false);

    // Stats follow the live per-round stamps: fetchRounds picks the
    // snapshot or the Worker per round, so unlike the single-blob stamps
    // below there is nothing to gain from trailing the snapshot here.
    // (Frozen data has no `rounds` and keeps the old whole-bundle stamp.)
    // …and the roster's, so a rename reaches the games already shown
    const statsStamp = (state.rounds ? JSON.stringify(state.rounds) : state.version)
      + '|' + ((snap && snap.roster_at) || '');
    const schedStamp = snap ? snap.schedule : state.schedule;
    const catsStamp = snap ? snap.cats : state.cats;
    // Stamps alone decide what to refetch, for the first load and for the
    // refresh button alike. The first load compares against the null /
    // undefined initial values, so everything fetches; a refresh that
    // finds nothing moved skips the heavy blobs entirely — the round
    // number above has already been updated either way.
    const statsMoved = statsStamp !== lastVersion;
    const schedMoved = schedStamp !== lastSched;
    const catsMoved = catsStamp !== lastCats;
    if (!statsMoved && !schedMoved && !catsMoved) {
      say('');
      if (dropped && tab !== null) { sheetAsk = false; render(); }
      return;
    }
    say('Loading');

    const jobs = [];
    if (statsMoved) {
      const errors = [];
      jobs.push((async () => {
        const rosterP = fetchRoster();
        const [r, m] = await Promise.all([rosterP, fetchMatches(errors, rosterP)]);
        roster = r;
        matches = m;
        statsErrors = errors;
        // an empty load that raced an upload — or a round that failed to
        // fetch — must retry on the next check, not stick on this version
        if (matches.length && roundsComplete) lastVersion = statsStamp;
      })());
    }
    if (schedMoved) {
      jobs.push((async () => {
        schedule = await fetchStamped(
          state.schedule !== null, snap && snap.schedule !== null, 'schedule.json', '/schedule');
        lastSched = schedStamp;
      })());
    }
    if (catsMoved) {
      jobs.push((async () => {
        catmap = await fetchStamped(
          Boolean(state.cats), snap && snap.cats !== null, 'cats.json', '/cats');
        lastCats = catsStamp;
      })());
    }
    await Promise.all(jobs);

    if (tab === null) {
      const wanted = (location.hash || '').replace('#', '');
      setTab(wanted === 'stats' || wanted === 'schedule'
        || (wanted === 'buzz' && state.buzz) || (wanted === 'cats' && catTab)
        // an archived tournament opens on how it ended
        ? wanted : schedule && !usingArchive() ? 'schedule' : 'stats', false);
    } else render();
    say('');
  } catch (e) { say(e.message, true); }
}

document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
$('refresh').onclick = () => load();
if (!slug) say('Bad link', true);
else load();
