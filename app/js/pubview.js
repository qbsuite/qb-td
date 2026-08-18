// pubview.js — the public tournament page (t.html?t=<slug>): schedule +
// stats tabs. Data comes from the publish-gated /pub routes: one small
// /pub/:slug on load or refresh, then a blob per round of games, plus
// the schedule / category map, only when their stamps move. A round that
// has finished never moves again, so refreshing late in a long day
// fetches the round in progress and nothing else.
//
// Nothing polls. A viewer reads a snapshot of the tournament as of the
// moment they loaded the page, and refreshes for a newer one — so an
// idle tab costs nothing at all, and a refresh shows results as soon as
// the cron has published them (no CDN layer in the state's path). The
// tradeoff is deliberate: broadcasts reach whoever refreshes, not
// whoever happens to be looking.

import { pub, esc, usingStaticData } from './api.js';
import { annCards } from './announce.js';
import { parseMatch, parseRoster } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { renderStats } from './statsview.js';
import { slotText } from '../engine/schedule.js';
import { roundTossupBuzzes, roundBonuses, buzzSummary, tokenizeQuestionHtml, mainAnswerHtml, sanitizeHtml, dedupeEntries } from '../engine/buzz.js';
import { categoryStats, categoryTeamStats, catPlayerLines, catTeamLines, catBreakdown, catCompare } from '../engine/cats.js';
import { normalizePacket } from './read_core.js';
import { buzzToken } from './buzzkey.js';

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
let buzzView = null;       // selected round number, or 'summary'
let catmap = null;         // text-free per-tossup categories from /pub/:slug/cats
let lastCats;              // its stamp
let catView = 'cat';       // 'cat' | 'player'
let catSel = '';
let catSubSel = '';
let catPlayerSel = null;   // {team, player}
const buzzPackets = {};    // round -> Promise<normalized packet>
const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';
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
  try { return await asJson(await pub('/pub/' + slug + route)); } catch (e) { return null; }
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

async function fetchMatches(errors) {
  const entries = state.rounds ? await fetchRounds(errors) : await fetchWholeBundle(errors);
  loadedIds = new Set(entries.map((e) => e.id));
  const out = [];
  const raw = [];
  for (const entry of entries) {
    try {
      const m = parseMatch(entry.qbj, { filename: entry.filename });
      m.room = entry.room;
      m.fileId = entry.id;
      out.push(m);
      raw.push({ id: entry.id, round: m.round, room: entry.room, qbj: entry.qbj });
    } catch (e) { errors.push(entry.filename + ': ' + e.message); }
  }
  rawEntries = dedupeEntries(raw);
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
          <td class="name${oppSlot && oppSlot.label ? ' ph' : ''}">${esc(opp) || '—'}</td>
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
  return state.buzz && s ? { Authorization: 'Buzz ' + s.tok } : {};
}

function fetchBuzzPacket(round) {
  if (!buzzPackets[round]) {
    buzzPackets[round] = (async () => {
      const res = await pub('/pub/' + slug + '/qpacket?round=' + round,
        { headers: buzzAuthHeaders() });
      if (!(res instanceof Response)) return normalizePacket(res, 'round ' + round);
      // non-JSON packet (docx): parse in-browser via the same public
      // YAPP service the reader uses
      const yapp = await fetch(YAPP, { method: 'POST', body: await res.arrayBuffer(), mode: 'cors' });
      if (!yapp.ok) throw new Error('packet parser failed (' + yapp.status + ')');
      return normalizePacket(await yapp.json(), 'round ' + round);
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
    if (state.buzz_kdf) say('checking password');
    tok = await buzzToken(pw, state.buzz_kdf);
  } catch (e) { say('could not check the password', true); return; }
  sessionStorage.setItem(BUZZ_KEY, JSON.stringify({ tok, v: state.buzz_v }));
  const probe = (state.buzz_done || []).filter((n) =>
    (state.packet_rounds || []).includes(n))[0];
  if (probe !== undefined) {
    try { await fetchBuzzPacket(probe); }
    catch (e) {
      const m = String(e.message);
      // a rejected key and a hit attempt cap both mean "not unlocked", so
      // neither should leave a stored key behind
      if (m.includes('bad password') || m.includes('too many attempts')) {
        sessionStorage.removeItem(BUZZ_KEY);
        say(m.includes('too many') ? m : 'bad password', true);
        return;
      } // other failures (no packet etc.): let the tab render what it can
    }
  }
  say('');
  render();
}

function buzzWordClass(hits) {
  if (hits.some((b) => b.value > 10)) return 'pow';
  if (hits.some((b) => b.value > 0)) return 'get';
  if (hits.some((b) => b.value < 0)) return 'neg';
  return 'zero';
}

const buzzDoneSet = () => new Set(state.buzz_done || []);
const buzzEntries = () => {
  const done = buzzDoneSet();
  return rawEntries.filter((e) => done.has(e.round));
};

function renderBuzzSummary(box) {
  const rows = buzzSummary(buzzEntries());
  if (!rows.length) { box.innerHTML = '<div class="muted">no buzzes yet</div>'; return; }
  box.innerHTML = `<div class="tablewrap"><table>
    <tr><th class="name">player</th><th class="name">team</th><th class="num">15</th><th class="num">10</th>
      <th class="num">neg</th><th class="num">avg buzz</th><th class="num">best</th></tr>
    ${rows.map((p) => `<tr>
      <td class="name">${esc(p.player)}</td><td class="name muted">${esc(p.team)}</td>
      <td class="num">${p.powers}</td><td class="num">${p.gets}</td><td class="num">${p.negs}</td>
      <td class="num">${p.avg === null ? '–' : (p.avg + 1).toFixed(1)}</td>
      <td class="num">${p.best === null ? '–' : p.best + 1}</td></tr>`).join('')}
  </table></div>`;
}

function tossupHtml(tossup, buzzes, packet) {
  const tu = packet && packet.tossups && packet.tossups[tossup - 1];
  let qhtml = '';
  if (tu) {
    const words = tokenizeQuestionHtml(tu.question);
    const byPos = new Map();
    buzzes.forEach((b, i) => {
      const pos = Math.min(b.position, words.length - 1);
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos).push({ i, b });
    });
    qhtml = '<div class="q">' + words.map((w, wi) => {
      const hits = byPos.get(wi);
      if (!hits) return w;
      const cls = buzzWordClass(hits.map((h) => h.b));
      return `<span class="bw ${cls}">${w}<sup>${hits.map((h) => h.i + 1).join(',')}</sup></span>`;
    }).join(' ') + '</div>';
  }
  const buzzChips = buzzes.map((b) => {
    const cls = b.value > 10 ? 'pow-t' : b.value > 0 ? 'ok' : b.value < 0 ? 'bad' : 'muted';
    return `<span class="${cls}">${b.position + 1}</span>`;
  }).join(' ');
  const dead = buzzes.some((b) => b.value > 0) ? '' : '<span class="bad">dead</span> ';
  return `
    <details class="qd">
      <summary><span class="roundcell">T${tossup}</span>
        ${tu ? mainAnswerHtml(tu.answer) : '<span class="muted">(no packet text)</span>'}
        <span class="qdmeta">${dead}${buzzChips}</span></summary>
      <div class="qdbody">
        ${qhtml}
        ${tu ? `<div class="q muted">ANSWER: ${sanitizeHtml(tu.answer)}</div>` : ''}
        ${buzzes.length ? `<div class="buzzlist">
          ${buzzes.map((b, i) => {
            const cls = b.value > 10 ? 'pow-t' : b.value > 0 ? 'ok' : b.value < 0 ? 'bad' : 'muted';
            return `<div><span class="${cls}">${i + 1} ${b.value > 0 ? '+' : ''}${b.value}</span>
              ${esc(b.player)} (${esc(b.team)}) &middot; word ${b.position + 1}${b.room ? ' &middot; ' + esc(b.room) : ''}</div>`;
          }).join('')}
        </div>` : '<div class="buzzlist">no buzzes</div>'}
      </div>
    </details>`;
}

function bonusHtml(bonus, results, packet) {
  const bz = packet && Array.isArray(packet.bonuses) && packet.bonuses[bonus - 1];
  const heard = results.length;
  const nParts = Math.max(...results.map((r) => r.parts.length));
  const conv = [];
  for (let p = 0; p < nParts; p++) {
    conv.push(results.filter((r) => r.parts[p] > 0).length);
  }
  const avg = results.reduce((n, r) => n + r.total, 0) / heard;
  const answers = bz && Array.isArray(bz.answers) ? bz.answers : [];
  const partsText = bz && Array.isArray(bz.parts) ? bz.parts : [];
  return `
    <details class="qd bonus">
      <summary><span class="roundcell">B${bonus}</span>
        ${answers.length
          ? answers.map((a) => mainAnswerHtml(a)).join(' <span class="muted">/</span> ')
          : '<span class="muted">(no packet text)</span>'}
        <span class="qdmeta">${avg.toFixed(1)} avg &middot; ${conv.map((c) => c + '/' + heard).join(' ')}</span></summary>
      <div class="qdbody">
        ${bz && bz.leadin ? `<div class="q muted">${sanitizeHtml(bz.leadin)}</div>` : ''}
        ${conv.map((c, p) => `
          <div class="q"><span class="${c ? 'ok' : 'bad'}">${c}/${heard}</span>
            ${answers[p] ? `<b style="text-transform:none">${sanitizeHtml(answers[p])}</b>` : ''}
            ${partsText[p] ? `<span class="muted">— ${sanitizeHtml(partsText[p])}</span>` : ''}</div>`).join('')}
        <div class="buzzlist">
          ${results.map((r) => `<div>
            <span class="${r.total > 20 ? 'pow-t' : r.total > 0 ? 'ok' : 'muted'}">${r.total}</span>
            ${r.team ? esc(r.team) : '<span class="muted">?</span>'}
            &middot; ${r.parts.join(' ')}${r.bounceTotal ? ` &middot; +${r.bounceTotal} bounce` : ''}${r.room ? ' &middot; ' + esc(r.room) : ''}
          </div>`).join('')}
        </div>
      </div>
    </details>`;
}

async function renderBuzzRound(box, round) {
  if (!buzzDoneSet().has(round)) {
    box.innerHTML = '<div class="muted">round in progress</div>';
    return;
  }
  const tossups = roundTossupBuzzes(rawEntries, round);
  const bonuses = roundBonuses(rawEntries, round);
  if (!tossups.length && !bonuses.length) {
    box.innerHTML = '<div class="muted">no games this round</div>';
    return;
  }
  box.innerHTML = '<div class="muted">loading packet</div>';
  let packet = null;
  try { packet = await fetchBuzzPacket(round); }
  catch (e) {
    if (String(e.message).includes('bad password')) {
      sessionStorage.removeItem(BUZZ_KEY);
      render();
      return;
    } // packet unreadable: numbers still render without text
  }
  if (tab !== 'buzz' || buzzView !== round) return; // user moved on mid-fetch
  // interleave by packet position: tossup N, then the bonus N read with it
  const tossupByNo = new Map(tossups.map((t) => [t.tossup, t]));
  const bonusByNo = new Map(bonuses.map((b) => [b.bonus, b]));
  const numbers = [...new Set([...tossupByNo.keys(), ...bonusByNo.keys()])].sort((a, b) => a - b);
  box.innerHTML = numbers.map((n) => {
    let html = '';
    if (tossupByNo.has(n)) html += tossupHtml(n, tossupByNo.get(n).buzzes, packet);
    if (bonusByNo.has(n)) html += bonusHtml(n, bonusByNo.get(n).results, packet);
    return html;
  }).join('');
}

function renderBuzz(box) {
  if (!state.buzz) { box.innerHTML = '<div class="muted">not enabled</div>'; return; }
  if (!buzzStored()) {
    box.innerHTML = `<div class="row">
      <input id="buzzpw" type="password" placeholder="password">
      <button id="buzzgo" class="primary">view</button>
    </div>`;
    $('buzzgo').onclick = () => tryBuzzKey($('buzzpw').value);
    $('buzzpw').onkeydown = (e) => { if (e.key === 'Enter') tryBuzzKey($('buzzpw').value); };
    return;
  }
  const done = buzzDoneSet();
  const rounds = (state.packet_rounds || []).filter((n) => done.has(n));
  const pending = (state.packet_rounds || []).filter((n) => !done.has(n));
  if (buzzView === null || (buzzView !== 'summary' && !rounds.includes(buzzView))) {
    buzzView = rounds.length ? rounds[rounds.length - 1] : 'summary';
  }
  box.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      ${rounds.map((n) =>
        `<a href="#" class="pill${buzzView === n ? ' on' : ''}" data-buzzround="${n}">round ${n}</a>`).join('')}
      ${pending.map((n) =>
        `<span class="pill muted">round ${n} in progress</span>`).join('')}
      <span style="flex:1"></span>
      <a href="#" class="pill${buzzView === 'summary' ? ' on' : ''}" data-buzzround="summary">summary</a>
    </div>
    <div id="buzzout"></div>`;
  box.querySelectorAll('[data-buzzround]').forEach((p) => {
    p.onclick = (e) => {
      e.preventDefault();
      const v = p.dataset.buzzround;
      buzzView = v === 'summary' ? 'summary' : Number(v);
      render();
    };
  });
  if (buzzView === 'summary') renderBuzzSummary($('buzzout'));
  else renderBuzzRound($('buzzout'), buzzView);
}

/* ---------- categories tab ---------- */

const CAT_HEAD = '<th class="num">15</th><th class="num">10</th>'
  + '<th class="num">-5</th><th class="num">pts</th>';
function lineCells(l) {
  return `<td class="num">${l.powers}</td><td class="num">${l.gets}</td>`
    + `<td class="num">${l.negs}</td><td class="num">${l.pts}</td>`;
}

// Category + subcategory filter pills, shared by the by-category and
// by-team views (same catSel/catSubSel state).
function catFilterHtml(rows) {
  const cats = [...new Set(rows.map((r) => r.cat))].sort(catCompare);
  if (catSel && !cats.includes(catSel)) { catSel = ''; catSubSel = ''; }
  const subs = catSel
    ? [...new Set(rows.filter((r) => r.cat === catSel && r.sub).map((r) => r.sub))].sort() : [];
  return `
    <div class="row" style="margin-bottom:8px">
      ${['', ...cats].map((c) =>
        `<a href="#" class="pill${catSel === c ? ' on' : ''}" data-cat="${esc(c)}">${esc(c) || 'all'}</a>`).join('')}
    </div>
    ${subs.length ? `<div class="row" style="margin-bottom:10px">
      ${['', ...subs].map((s) =>
        `<a href="#" class="pill${catSubSel === s ? ' on' : ''}" data-catsub="${esc(s)}">${esc(s) || 'all'}</a>`).join('')}
    </div>` : ''}`;
}
function wireCatFilter(box) {
  box.querySelectorAll('[data-cat]').forEach((p) => {
    p.onclick = (e) => { e.preventDefault(); catSel = p.dataset.cat; catSubSel = ''; render(); };
  });
  box.querySelectorAll('[data-catsub]').forEach((p) => {
    p.onclick = (e) => { e.preventDefault(); catSubSel = p.dataset.catsub; render(); };
  });
}

function renderByCategory(box, rows) {
  const filter = catFilterHtml(rows);
  const lines = catPlayerLines(rows, catSel, catSubSel);
  box.innerHTML = `${filter}
    <div class="tablewrap"><table>
      <tr><th class="name">player</th><th class="name">team</th>${CAT_HEAD}</tr>
      ${lines.map((l) =>
        `<tr><td class="name">${esc(l.player)}</td><td class="name muted">${esc(l.team)}</td>${lineCells(l)}</tr>`).join('')}
    </table></div>`;
  wireCatFilter(box);
}

function renderByTeam(box, teamRows) {
  const filter = catFilterHtml(teamRows);
  const lines = catTeamLines(teamRows, catSel, catSubSel);
  box.innerHTML = `${filter}
    <div class="tablewrap"><table>
      <tr><th class="name">team</th>${CAT_HEAD}<th class="num">bonuses</th><th class="num">bpts</th><th class="num">ppb</th></tr>
      ${lines.map((l) =>
        `<tr><td class="name">${esc(l.team)}</td>${lineCells(l)}<td class="num">${l.bh}</td>`
        + `<td class="num">${l.bpts}</td><td class="num">${l.ppb === null ? '–' : l.ppb.toFixed(2)}</td></tr>`).join('')}
    </table></div>`;
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
  box.innerHTML = `
    <div style="margin-bottom:10px">
      <select id="catplayersel">
        ${players.map((p, i) => `<option value="${i}" ${p.team === catPlayerSel.team
          && p.player === catPlayerSel.player ? 'selected' : ''}>${esc(p.player)} (${esc(p.team)})</option>`).join('')}
      </select>
    </div>
    <div class="tablewrap"><table>
      <tr><th>category</th>${CAT_HEAD}</tr>
      ${bd.map(({ cat, line, subs }) =>
        `<tr><td><b>${esc(cat)}</b></td>${lineCells(line)}</tr>`
        + subs.map(({ sub, line: sl }) =>
          `<tr class="muted"><td style="padding-left:28px">${esc(sub)}</td>${lineCells(sl)}</tr>`).join('')
      ).join('')}
    </table></div>`;
  $('catplayersel').onchange = () => {
    catPlayerSel = players[Number($('catplayersel').value)];
    render();
  };
}

function renderCats(box) {
  if (!catmap) { box.innerHTML = '<div class="muted">no categories</div>'; return; }
  const rows = categoryStats(rawEntries, catmap);
  if (!rows.length) { box.innerHTML = '<div class="muted">no games yet</div>'; return; }
  box.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <a href="#" class="pill${catView === 'cat' ? ' on' : ''}" data-catview="cat">players</a>
      <a href="#" class="pill${catView === 'team' ? ' on' : ''}" data-catview="team">teams</a>
      <a href="#" class="pill${catView === 'player' ? ' on' : ''}" data-catview="player">by player</a>
    </div>
    <div id="catbody"></div>`;
  box.querySelectorAll('[data-catview]').forEach((p) => {
    p.onclick = (e) => { e.preventDefault(); catView = p.dataset.catview; render(); };
  });
  if (catView === 'cat') renderByCategory($('catbody'), rows);
  else if (catView === 'team') renderByTeam($('catbody'), categoryTeamStats(rawEntries, catmap));
  else renderByPlayer($('catbody'), rows);
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
  return `<div class="muted">${n} game${n === 1 ? '' : 's'} just in — `
    + 'refresh in a minute to include them</div>';
}

function renderStatsTab(box) {
  if (!matches.length) {
    box.innerHTML = statsErrors.length
      ? statsErrors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')
      : pendingNote() || '<div class="muted">no games yet</div>';
    return;
  }
  renderStats(box, aggregate(matches, roster), statsErrors);
  box.insertAdjacentHTML('afterbegin', pendingNote());
}

/* ---------- shell ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  const box = $('out');
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

async function load() {
  try {
    // The state always comes from the Worker (or frozen local data): it
    // is one small response per page view, and going direct keeps it
    // free of the snapshot's publish lag and CDN staleness. Only the
    // heavy blobs below are served off GitHub.
    //
    // cache: 'no-cache' is load-bearing. /pub/:slug is served max-age=60,
    // and refreshing is now the ONLY way a viewer gets newer data — read
    // the browser's copy and the button silently does nothing for up to a
    // minute. Revalidating costs one small request per press.
    state = await asJson(await pub('/pub/' + slug, { cache: 'no-cache' }));
    // Track the snapshot's stamps when one is advertised — its blobs are
    // what we'll fetch, so refetch decisions must follow what IT holds
    // (it can trail the Worker by up to a cron tick; the next refresh
    // converges). Frozen data (demo/archive) never uses snapshots.
    snap = !usingStaticData() && state.pub && state.pub.sha ? state.pub : null;
    const storedKey = buzzStored();
    if (storedKey && storedKey.v !== state.buzz_v) sessionStorage.removeItem(BUZZ_KEY);
    document.title = state.name;
    $('tname').textContent = state.name;
    $('round').textContent = 'round ' + state.current_round;
    // Broadcasts have no stamp of their own; they ride the state and must
    // render before the no-change early return below. Expiry is applied
    // by whoever produced the state (the Worker, or a frozen capture).
    $('ann').innerHTML = annCards(state.announce, 'announcement');
    $('tab-buzz').hidden = !state.buzz;
    $('tab-cats').hidden = !state.cats;
    if (tab === 'buzz' && !state.buzz) setTab('stats', false);
    if (tab === 'cats' && !state.cats) setTab('stats', false);

    // Stats follow the live per-round stamps: fetchRounds picks the
    // snapshot or the Worker per round, so unlike the single-blob stamps
    // below there is nothing to gain from trailing the snapshot here.
    // (Frozen data has no `rounds` and keeps the old whole-bundle stamp.)
    const statsStamp = state.rounds ? JSON.stringify(state.rounds) : state.version;
    const schedStamp = snap ? snap.schedule : state.schedule;
    const catsStamp = snap ? snap.cats : state.cats;
    // Stamps alone decide what to refetch, for the first load and for the
    // refresh button alike. The first load compares against the null /
    // undefined initial values, so everything fetches; a refresh that
    // finds nothing moved skips the heavy blobs entirely — the round
    // number and broadcasts above have already been updated either way.
    const statsMoved = statsStamp !== lastVersion;
    const schedMoved = schedStamp !== lastSched;
    const catsMoved = catsStamp !== lastCats;
    if (!statsMoved && !schedMoved && !catsMoved) { say(''); return; }
    say('loading');

    const jobs = [];
    if (statsMoved) {
      const errors = [];
      jobs.push((async () => {
        const [r, m] = await Promise.all([fetchRoster(), fetchMatches(errors)]);
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
        || (wanted === 'buzz' && state.buzz) || (wanted === 'cats' && state.cats)
        ? wanted : schedule ? 'schedule' : 'stats', false);
    } else render();
    say('');
  } catch (e) { say(e.message, true); }
}

document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
$('refresh').onclick = () => load();
if (!slug) say('bad link', true);
else load();
