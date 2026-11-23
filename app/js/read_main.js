// read_main.js — source for read.bundle.js (npm run build:read). The
// moderator reader page: an embedded MODAQ preloaded with a round's packet
// (the live round by default; played rounds stay selectable), the
// tournament roster, and the TO's game format, so the mod only picks the
// round and the two teams. The finished game uploads straight back to
// the bucket via MODAQ's customExport — no file downloads or uploads.
//
// Every started game gets its own URL (?b=<secret>&g=<id>) and its own
// localStorage keys (read_core.js). A game link resumes exactly that game
// from this device, with zero network requests; the bare room link always
// fetches fresh (state + packet + roster) and shows the team picker plus
// any games in progress on this device. Uploads are the only other
// traffic: two per export click, plus the game's protest list each time
// it changes (watchProtests), so the TD sees a protest when it's lodged.
// Nothing polls the network.
//
// docx packets come parsed: the Worker keeps YAPP's parse of each one
// (worker.js "YAPP's parse, kept"). Only when it couldn't reach YAPP does
// the browser send the .docx to YAPP itself (CORS *); JSON packets load
// directly.

import { roundLabel, isTbRound, withDeciderPhases } from '../engine/deciderphases.js';
import React from 'react';
import ReactDOM from 'react-dom';
import { ModaqControl, GameFormats, parseQbjRegistration } from 'modaq';
import { pub, esc, preload } from './api.js';
import {
  normalizePacket, groupTeams, pickTeams, orderPlayers, matchFilenames, readerUpload,
  resolveGameFormat, metaKey, gameKey, parseMeta, storeIntact, gameMetas,
  staleGameKeys, roundRows, normalizeTbPool, tbPanelRows,
  tbRecordAdd, tbAddedIds, tbProtests,
} from './read_core.js';
import { gameProgress, exportStatus } from './read_core.js';
import { tbBridge } from './tb_bridge.js';
import { protestReport } from './protests.js';
import { Tossup } from 'modaq/src/state/PacketState.js';
import { toQBJString } from 'modaq/src/qbj/QBJ.js';
import { gameForRoom, roomRounds, slotText } from '../engine/schedule.js';
import { slotLabel } from '../engine/brackets.js';
import { askWarning, andList } from './warnask.js';
import { mountBuzzer, rememberBuzzer, recallBuzzer, buzzerTeams } from './buzzer_read.js';

const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';
// worker.js NOT_STARTED: every room route answers this until the TD presses Start
const NOT_STARTED = "Tournament hasn't started";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const secret = params.get('b') || '';
const gid = params.get('g') || '';
// The TD's Test link (admin.js): the room before Start, read with the
// tournament's test token (worker.js testAccess). A test game is this
// device's only: it sends nothing, and keeps its storage apart from the
// room's games.
const testKey = params.get('test') || '';
const store = testKey ? secret + '-test' : secret;
const tq = (path) => (testKey
  ? path + (path.includes('?') ? '&' : '?') + 'test=' + encodeURIComponent(testKey) : path);

let state = null;   // /b/:secret response (bare-link path only)
let teams = null;   // [{name, players}] from the roster
let packet = null;  // normalized IPacket
let sched = null;      // tournament schedule (when the TO made one)
let schedRoom = null;  // this bucket's room index in it
let schedBrackets = null; // [{key, name, phase, color}] when brackets keep their own rounds, else null
let schedGame = null;  // {a, b}: what the schedule has this room playing in the selected round
let byeGame = false;   // a bye room's schedGame: the round's two teams on a bye
let byePicked = null;  // {a, b}: the bye teams a bye room last put in the pickers
let locked = false;    // the scheduled matchup is showing, pickers hidden
const starterSel = new Map(); // team name -> Set of the player names starting
const orderSel = new Map();   // team name -> its player names in seating order
let tbPool = null;  // TO's tiebreaker pool (offered in Add Questions)

// Non-blocking pool fetch: fills the Add Questions dialog whenever it
// lands; a resumed game stays fully usable offline without it.
function fetchTbPool() {
  pub(tq('/b/' + secret + '/tiebreakers')).then((r) => {
    tbPool = normalizeTbPool(r instanceof Response ? null : r);
    tbBridge.pool = tbPool;
    renderTbPanel();
  }, () => { /* no pool: the dialog falls back to its file picker */ });
}

function say(text, bad = false) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

function roomLink() {
  // a page pointed at another backend (?server=, local testing) stays there
  const server = new URLSearchParams(location.search).get('server');
  return tq(location.pathname + '?b=' + encodeURIComponent(secret)) + (server ? '&server=' + encodeURIComponent(server) : '');
}
function gameLink(id) {
  return roomLink() + '&g=' + encodeURIComponent(id);
}
function randId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(36).slice(-1)).join('') + Date.now().toString(36).slice(-4);
}

/* ---------- data loading (bare-link path) ---------- */

const packetCache = {}; // round -> Promise<normalized IPacket>

function fetchPacket(round, name) {
  if (!packetCache[round]) {
    packetCache[round] = loadPacket(round, name)
      .catch((e) => { delete packetCache[round]; throw e; });
  }
  return packetCache[round];
}

async function loadPacket(round, name) {
  // warm=1: fetching isn't starting — the Worker counts a room as having
  // started a round (auto-advance) from the Start button's own signal.
  // parsed=1: a .docx comes as the parse the Worker keeps of it, so YAPP
  // isn't asked again; the .docx itself only when YAPP couldn't be reached
  const res = await pub(tq('/b/' + secret + '/packet?round=' + round + '&warm=1&parsed=1'));
  // pub() returns parsed JSON when the blob was stored with a JSON content
  // type, and the raw Response otherwise.
  let parsed;
  if (!(res instanceof Response)) parsed = normalizePacket(res, name);
  else if (/\.json$/i.test(name)) parsed = normalizePacket(JSON.parse(await res.text()), name);
  else if (/\.docx$/i.test(name)) {
    say('parsing packet...');
    const yapp = await fetch(YAPP, { method: 'POST', body: await res.arrayBuffer(), mode: 'cors' });
    if (!yapp.ok) throw new Error('packet parser failed (' + yapp.status + ')');
    parsed = normalizePacket(await yapp.json(), name);
  } else {
    throw new Error('packet is ' + (name.split('.').pop() || 'unknown') + '; the reader needs .json or .docx');
  }
  return parsed;
}

async function fetchTeams() {
  const roster = await pub(tq('/b/' + secret + '/roster'));
  const text = roster instanceof Response ? await roster.text() : JSON.stringify(roster);
  const parsed = parseQbjRegistration(text);
  if (!parsed.success) throw new Error('roster: ' + parsed.message);
  return groupTeams(parsed.value);
}

/* ---------- MODAQ mount ---------- */

// bracket: {name, color} on a schedule whose brackets keep their own
// rounds (the room's round is its bracket's)
function setHeader(t, room, round, game, bracket) {
  document.title = (testKey === 'bye' ? 'BYE - ' : testKey ? 'TEST - ' : '') + t + ' - ' + room;
  $('tname').textContent = t;
  $('room').textContent = room + ' · ' + roundLabel(round);
  if (bracket) {
    $('room').insertAdjacentHTML('beforeend',
      ` · <span class="bname"><i class="lane-${Number(bracket.color) || 0}"></i>${esc(bracket.name)}</span>`);
  }
  if (game) $('game').textContent = game;
  $('newgame').href = roomLink();
}

// The game's protests as the hub reads them (protests.js protestReport),
// numbered the way the upload numbers questions. null if the store won't
// parse.
function gameProtests(storeText, meta, format) {
  let protests;
  try { protests = protestReport(JSON.parse(storeText), format, Tossup); }
  catch (e) { return null; }
  return tbProtests(protests, meta.tb);
}

// MODAQ saves the game to localStorage as it changes; every few seconds
// this reads it back (local only) and, when the protest list differs from
// what the hub last got, sends it. A failed send is retried on the next
// change check, so a protest lodged offline arrives once the room is back.
const PROTEST_CHECK_MS = 5000;
function watchProtests(id, meta, format) {
  if (testKey) return;
  let lastText = null;
  let sent = JSON.stringify([]); // a game with none has nothing to say
  let busy = false;
  const check = async () => {
    const text = localStorage.getItem(gameKey(store, id));
    if (busy || !text || text === lastText) return;
    const protests = gameProtests(text, meta, format);
    if (!protests) return;
    const body = JSON.stringify(protests);
    if (body === sent) { lastText = text; return; }
    busy = true;
    try {
      const out = await pub(`/b/${secret}/protests?round=${meta.round}&g=${encodeURIComponent(id)}`,
        { method: 'POST', body: JSON.stringify({ teams: [meta.a, meta.b], protests }) });
      if (!(out && out.error)) sent = body;
      lastText = text;
    } catch (e) {
      // offline (fetch's TypeError) or a server fault (a 5xx): the next
      // check tries again; a refusal waits for the game to change
      if (!(e instanceof TypeError) && !(e.status >= 500)) lastText = text;
    } finally { busy = false; }
  };
  setInterval(check, PROTEST_CHECK_MS);
}

function mountMODAQ(id, meta, isNew) {
  document.body.classList.add('reading');
  setHeader(meta.t, meta.room, meta.round, meta.a + ' vs ' + meta.b);

  // The Add Questions dialog (tb_add_dialog.js) reads the pool and reports
  // every question it adds and where; the meta keeps the positions so the
  // upload can number the packet's own questions as the TD's packet does
  // and say exactly which tiebreakers this game read.
  tbBridge.pool = tbPool;
  tbBridge.addedIds = () => tbAddedIds(meta.tb);
  // A correction (Edit in MODAQ) that adds or replaces questions reports
  // its tiebreakers again (meta.tbLogged, read_core readerUpload).
  tbBridge.onAdd = (sel, base, at) => {
    meta.tb = tbRecordAdd(meta.tb, base, at || base, sel);
    delete meta.tbLogged;
    localStorage.setItem(metaKey(store, id), JSON.stringify(meta));
  };
  // Replace tossup / Replace bonus record their own changes (read_core
  // replaceQuestion), held bonuses included
  // the furthest question reached (read_core gameProgress), kept with the
  // game. Only a game begun on this reader tracks it (meta.reached set at
  // the start): one already under way can't know how far it had got, so it
  // reports nothing and counts as finished, as every game did before.
  if (isNew && meta.reached === undefined) {
    meta.reached = 1;
    localStorage.setItem(metaKey(store, id), JSON.stringify(meta));
  }
  tbBridge.noteReached = (n) => {
    if (typeof meta.reached !== 'number' || !Number.isInteger(n) || meta.reached >= n) return;
    meta.reached = n;
    localStorage.setItem(metaKey(store, id), JSON.stringify(meta));
  };
  tbBridge.first = meta.off || 0;
  tbBridge.getTb = () => meta.tb || null;
  tbBridge.setTb = (tb) => {
    meta.tb = tb;
    delete meta.tbLogged;
    localStorage.setItem(metaKey(store, id), JSON.stringify(meta));
  };

  let uploading = null;
  const props = {
    persistState: true,
    storeName: gameKey(store, id),
    hideNewGame: true,
    yappServiceUrl: YAPP,
    customExport: {
      label: 'Upload to qb-td',
      type: 'QBJ',
      onExport: (match, ctx) => {
        if (testKey) {
          // MODAQ words its own result dialog ("Export succeeded"), which a
          // test must not show: say it here and leave MODAQ waiting
          alert(testKey === 'bye' ? 'This is the Bye Room, so nothing was uploaded.' : 'This is a test game, so nothing was uploaded.');
          return new Promise(() => {});
        }
        // a click while an upload is running joins it instead of sending
        // another; clicks show "Uploading" until it lands (MODAQ's timed
        // export, if a TD turns it on, stays quiet)
        if (uploading) return uploading;
        const shown = !(ctx && ctx.source === 'Timer') && uploadingNote();
        uploading = uploadGame(match).finally(() => {
          uploading = null;
          if (shown) shown.remove();
        });
        return uploading;
      },
    },
  };
  async function uploadGame(match) {
    try {
      const name = matchFilenames(meta.round, meta.a, meta.b).combined;
      // logged protests go up structured, swing included, for the hub's
      // Protests drawer (the qbj's notes carry them as text only)
      // (null if the store won't parse: the Worker falls back to the
      // qbj's notes)
      const storeText = localStorage.getItem(gameKey(store, id));
      const protests = gameProtests(storeText, meta, props.gameFormat || null);
      const app = tbBridge.appState;
      const progress = app && typeof meta.reached === 'number'
        ? gameProgress(Math.max(meta.reached, app.uiState.cycleIndex + 1), app.game.gameFormat.regulationTossupCount) : null;
      // MODAQ's own export of this game, made the way its Backup to JSON
      // dialog makes it (engine/modaqfile.js): the hub hands these texts
      // back as they are, so a TD's download is MODAQ's file
      const modaq = app ? {
        qbj: toQBJString(app.game, app.game.packet.name ?? app.uiState.packetFilename, meta.round),
        game: JSON.stringify(app.game, null, 2),
      } : null;
      // questions added mid-packet shift MODAQ's numbering: the upload
      // numbers them as if appended, so stats keyed on packet numbers line
      // up, says which tiebreakers were read, so the TD's usage log stays
      // exact (worker logTbUses), and keeps the record for Edit in MODAQ
      let body = readerUpload(match, meta, storeText, protests, progress, modaq);
      // a decider on the second half of a packet: its questions keep the
      // packet's own numbers, so buzzpoints and categories find them
      if (meta.off) {
        try {
          const up = JSON.parse(body);
          const shift = (q) => { if (q && Number.isInteger(q.question_number) && q.question_number <= meta.reg && !q.qbtd_tiebreaker) q.question_number += meta.off; };
          for (const mq of (up.qbj && up.qbj.match_questions) || []) {
            const packetQ = Number.isInteger(mq.question_number) && mq.question_number <= meta.reg;
            shift(mq.tossup_question); if (mq.bonus) shift(mq.bonus.question);
            if (packetQ) mq.question_number += meta.off;
          }
          body = JSON.stringify(up);
        } catch (e) { /* sent as it was */ }
      }
      // a stalled connection gives up rather than leave "Uploading" up
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), UPLOAD_WAIT_MS);
      let out;
      try {
        out = await pub(
          `/b/${secret}/upload?round=${meta.round}&name=${encodeURIComponent(name)}`,
          { method: 'POST', body, signal: stop.signal });
      } finally {
        clearTimeout(timer);
      }
      if (out && out.error) return { isError: true, status: exportStatus(name + ': ' + out.error) };
      return { isError: false, status: 'uploaded ' + name };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { isError: true, status: 'the upload took too long. Please check the connection and upload again' };
      }
      return { isError: true, status: exportStatus((e && e.message) || e) };
    }
  }
  if (isNew) {
    // Resume mounts restore everything from the persisted store instead;
    // these props would clobber it.
    props.packet = packet;
    props.packetName = meta.packet;
    // the moderator's starters and seating order; games from before they
    // were chosen keep the roster's (MODAQ starts the first four of each)
    const players = orderPlayers(pickTeams(teams, meta.a, meta.b), meta.order);
    props.players = meta.starters
      ? players.map((pl) => ({ name: pl.name, teamName: pl.teamName,
        isStarter: (meta.starters[pl.teamName] || []).includes(pl.name) }))
      : players;
    const format = resolveGameFormat(state.settings || {}, GameFormats);
    if (format) props.gameFormat = meta.reg ? { ...format, regulationTossupCount: meta.reg } : format;
  }
  ReactDOM.render(React.createElement(ModaqControl, props), $('modaq'));
  watchProtests(id, meta, props.gameFormat || null);
}

/* ---------- schedule defaults (bare-link path) ---------- */

// Tiebreaker pool in the side panel: every question, and who has already
// heard it — the mod checks with the TD which one to read, and this shows
// at a glance which are burned for which teams. During a game the pool is
// under MODAQ's Actions -> Add questions, which puts the picked question at
// the reader's place or at the end of the packet.
function renderTbPanel() {
  const rows = tbPanelRows(tbPool);
  if (!rows.length) return;
  $('tbpanel').hidden = false;
  $('tbbase').textContent =
    'During a game, you can add these from Actions → Add questions, either in place of a thrown-out question or at the end of the packet.';
  $('tbrows').innerHTML = rows.map((r) => `
    <tr>
      <td class="roundcell">${esc(r.id)}</td>
      <td class="muted">${esc(r.kind)}</td>
      <td>${r.heard.length
        ? r.heard.map((u) => `<span class="bad">heard</span> ${esc((u.teams || []).join(' & '))}
            <span class="muted">(R${esc(String(u.round))}, ${esc(u.room || '')})</span>`).join('<br>')
        : '<span class="ok">unused</span>'}</td>
    </tr>`).join('');
}

// This room's schedule in the side panel: one row per round, round
// number leading, current round highlighted.
// With brackets, the rows split under a heading per phase and bracket
// ("Prelims · Pool A"), and playoff slots read "Pool A 1st" until filled.
function renderSchedPanel() {
  if (!sched || schedRoom === null) return;
  const rows = roomRounds(sched, schedRoom);
  if (!rows.length) return;
  $('schedpanel').hidden = false;
  const row = (r) => `
    <tr${r.round === nowRound() ? ' class="now"' : ' class="muted"'}>
      <td class="roundcell">${isTbRound(r.round) ? 'T' + (r.round - 900) : r.round}</td>
      <td class="name">${schedBrackets
        ? `${esc(slotLabel(r.a) || '—')} v ${esc(slotLabel(r.b) || '—')}`
        : `${esc(slotText(r.a) || '—')} v ${esc(slotText(r.b) || '—')}`}</td>
    </tr>`;
  if (!schedBrackets) { $('schedrows').innerHTML = rows.map(row).join(''); return; }
  let last = null;
  $('schedrows').innerHTML = rows.map((r) => {
    const ph = sched.phases.find((p) => p.rounds.some((x) => x.round === r.round));
    const g = ph.rounds.find((x) => x.round === r.round).games.find((x) => x.room === schedRoom);
    const b = schedBrackets.find((x) => x.key === (g && g.bracket));
    const key = (ph.name || '') + '|' + (b ? b.key : '');
    const head = key === last ? '' : `<tr class="bhrow"><td colspan="2">${b ? `<i class="lane-${Number(b.color) || 0}"></i>` : ''}${
      esc([ph.name, b && b.name].filter(Boolean).join(' \u00b7 '))}</td></tr>`;
    last = key;
    return head + row(r);
  }).join('');
}

// The bracket this room's game in round n belongs to, or null.
function bracketAt(n) {
  if (!schedBrackets || !sched || schedRoom === null) return null;
  for (const ph of sched.phases) for (const r of ph.rounds) {
    if (r.round !== n) continue;
    const g = r.games.find((x) => x.room === schedRoom);
    return (g && schedBrackets.find((x) => x.key === g.bracket)) || null;
  }
  return null;
}

// The scheduled matchup for the selected round, locked in: the teams show
// as the matchup rather than as two dropdowns, and changing them takes a
// click (Change teams) and a warning at Start. It locks in again whenever
// the round changes. Rooms the schedule has nothing for keep the pickers,
// and a moderator's pick there is never clobbered.
// A bye room: the teams the schedule has on a bye in the selected round.
// Two of them are the matchup, as a room's scheduled game is; any other
// number fills the pickers, for the reader to settle.
function byeTeamsAt(round) {
  for (const ph of (sched && sched.phases) || []) {
    for (const r of ph.rounds || []) {
      if (r.round === round) return (r.byes || []).map((x) => x && x.team).filter(Boolean);
    }
  }
  return [];
}

function applySchedDefault() {
  schedGame = null;
  byeGame = false;
  const known = (n) => teams && teams.some((t) => t.name === n);
  if (sched && schedRoom !== null && teams && !$('teamrow').hidden) {
    const g = gameForRoom(sched, schedRoom, selectedRound);
    if (g && known(g.a) && known(g.b)) schedGame = { a: g.a, b: g.b };
  } else if (sched && testKey === 'bye' && teams && !$('teamrow').hidden) {
    const on = byeTeamsAt(selectedRound).filter(known);
    // the last round's bye teams don't stay picked in a round without them
    // (a reader's own pick does)
    if (byePicked && $('teama').value === byePicked.a && $('teamb').value === byePicked.b) {
      $('teama').value = ''; $('teamb').value = '';
    }
    byePicked = null;
    if (on.length === 2) { schedGame = { a: on[0], b: on[1] }; byeGame = true; byePicked = { ...schedGame }; }
    else if (on.length) {
      $('teama').value = on[0]; if (on[1]) $('teamb').value = on[1];
      byePicked = { a: $('teama').value, b: $('teamb').value };
    }
    const list = on.length < 2 ? on.join('') : on.slice(0, -1).join(', ') + ' and ' + on[on.length - 1];
    // a schedule with no byes at all says nothing about them
    const anyByes = (sched.phases || []).some((ph) => (ph.rounds || []).some((r) => (r.byes || []).length));
    $('byelist').textContent = !on.length ? (anyByes ? `No team is on a bye in round ${selectedRound}.` : '')
      : on.length === 1 ? `${list} is on a bye in round ${selectedRound}.`
      : on.length > 2 ? `On a bye in round ${selectedRound}: ${list}.` : '';
    $('byelist').hidden = on.length === 2 || !$('byelist').textContent;
  }
  if (schedGame) {
    $('teama').value = schedGame.a;
    $('teamb').value = schedGame.b;
  }
  locked = !!schedGame;
  renderTeamPick();
}

// The rounds before `round` the schedule has this room playing a game in
// that nothing says it played: no upload, no Start pressed on any device,
// no game on this one. [{ round, a, b }]
function unplayedBefore(round) {
  if (!sched || schedRoom === null || testKey) return [];
  const done = new Set([
    ...(state.uploads || []).filter((u) => !u.error).map((u) => u.round),
    ...(state.started_rounds || []),
    ...deviceMetas().map((m) => m.round),
  ]);
  const out = [];
  for (let r = 1; r < round; r++) {
    const g = gameForRoom(sched, schedRoom, r);
    if (g && !done.has(r)) out.push({ round: r, ...g });
  }
  return out;
}
const hasPacket = (n) => (state.packets || []).some((p) => p.number === n);
// the round this room's schedule has these two teams in, other than `round`
function roundOfTeams(a, b, round) {
  if (!sched || schedRoom === null || testKey) return null;
  const key = [a, b].sort().join('\n');
  // the round picked is theirs too (a rematch in the same room): nothing to say
  const here = gameForRoom(sched, schedRoom, round);
  if (here && [here.a, here.b].sort().join('\n') === key) return null;
  for (const { round: r } of roomRounds(sched, schedRoom)) {
    const g = gameForRoom(sched, schedRoom, r);
    if (r !== round && g && [g.a, g.b].sort().join('\n') === key) return r;
  }
  return null;
}
function goToRound(n) {
  selectedRound = n;
  renderRounds();
  applySchedDefault();
}

// Above the teams: earlier rounds of this room's schedule not played yet
function renderRoundWarn() {
  const el = $('roundwarn');
  const left = isTbRound(selectedRound) ? [] : unplayedBefore(selectedRound);
  el.hidden = !left.length;
  if (!left.length) return;
  const first = left[0];
  el.innerHTML = `<span>${left.length === 1
    ? esc(`Round ${first.round} hasn't been played in this room yet: ${first.a} vs ${first.b}.`)
    : esc(`Rounds ${andList(left.map((x) => String(x.round)))} haven't been played in this room yet.`)}</span>
    ${hasPacket(first.round) ? `<button class="linkbtn" data-goround="${first.round}">Go to round ${first.round}</button>` : ''}`;
  const go = el.querySelector('[data-goround]');
  if (go) go.onclick = () => goToRound(first.round);
}

function renderTeamPick() {
  renderRoundWarn();
  $('schedmatch').hidden = !locked;
  $('teampickers').hidden = locked;
  $('changeteams').hidden = !locked;
  $('useschedteams').hidden = locked || !schedGame;
  if (schedGame) {
    const br = bracketAt(selectedRound);
    $('schedfrom').innerHTML = byeGame ? esc(`On a bye in round ${selectedRound}`) : br
      ? `From the schedule \u00b7 <i class="lane-${Number(br.color) || 0}"></i>${esc(br.name)} \u00b7 ${roundLabel(selectedRound)} in ${esc(state.room)}`
      : esc(`From the schedule \u00b7 ${roundLabel(selectedRound)} in ${state.room}`);
    $('mteama').textContent = schedGame.a;
    $('mteamb').textContent = schedGame.b;
    // long names: smaller, and each team keeps to its own lines (room.css)
    $('mteama').parentElement.classList.toggle('long', (schedGame.a + schedGame.b).length > 44);
  }
  renderStarters();
}

// Starters for the two picked teams: every player, the roster's first
// four ticked (MODAQ's own default), and the moderator ticks as many or as
// few as are actually playing — at least one a team, checked at Start.
// Players are dragged by their grip (or moved with Alt+↑/↓) into seating
// order, which is the order MODAQ lists them in. A team's column is
// dragged onto the other's (or its grip pressed) to swap sides: the left
// column is the left team in MODAQ.
function renderStarters() {
  buzzerTeams($('teama').value, $('teamb').value); // the buzzer card names its two sounds for them
  const names = [$('teama').value, $('teamb').value].filter((n, i, all) => n && all.indexOf(n) === i);
  const picked = names.map((n) => teams.find((t) => t.name === n)).filter(Boolean);
  for (const t of picked) {
    if (!starterSel.has(t.name)) {
      starterSel.set(t.name, new Set(t.players.filter((pl) => pl.isStarter).map((pl) => pl.name)));
    }
    if (!orderSel.has(t.name)) orderSel.set(t.name, t.players.map((pl) => pl.name));
  }
  $('starters').innerHTML = picked.length ? `
    <div class="lineups">${picked.map((t) => {
      const on = starterSel.get(t.name);
      return `<div class="lineup" draggable="true" data-side="${esc(t.name)}">
        <h4><span class="lname"><button type="button" class="grip tgrip" data-swap="1" title="Drag to the other side, or press to swap sides"
          aria-label="Swap sides">\u22EE\u22EE</button>${esc(t.name)}</span><span class="count${on.size ? '' : ' none'}">${on.size} starting</span></h4>
        <div class="plist" data-team="${esc(t.name)}">${orderSel.get(t.name).map((name) => `<div class="prow" draggable="true"
          data-name="${esc(name)}"><span class="grip" title="Drag to reorder" aria-hidden="true">\u22EE\u22EE</span><button type="button"
          class="p${on.has(name) ? ' on' : ''}" data-team="${esc(t.name)}" data-player="${esc(name)}" aria-pressed="${on.has(name)}"><span class="box">${
          on.has(name) ? '\u2713' : ''}</span>${esc(name)}${on.has(name) ? '' : '<span class="bench">bench</span>'}</button></div>`).join('')}</div>
      </div>`;
    }).join('')}</div>` : '';
}

// Dragging moves the row itself while the pointer is over its team's
// list; the new order is read back from the rows on drop. Alt+↑/↓ on a
// player does the same from the keyboard.
function wireReorder(box) {
  let dragged = null;
  let side = null; // a team's column being dragged
  const finish = () => {
    if (side) {
      const target = box.querySelector('.lineup.target');
      side = null;
      if (target) swapSides(); else renderStarters();
      return;
    }
    if (!dragged) return;
    const list = dragged.parentNode;
    orderSel.set(list.dataset.team, [...list.children].map((r) => r.dataset.name));
    dragged = null;
    renderStarters();
  };
  box.ondragstart = (e) => {
    dragged = e.target.closest && e.target.closest('.prow');
    if (!dragged) {
      side = e.target.closest && e.target.closest('.lineup');
      if (!side) return;
      side.classList.add('lift');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', side.dataset.side); } catch (err) { /* older browsers */ }
      return;
    }
    dragged.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragged.dataset.name); } catch (err) { /* older browsers */ }
  };
  box.ondragover = (e) => {
    if (side && e.target.closest) {
      const over = e.target.closest('.lineup');
      box.querySelectorAll('.lineup.target').forEach((x) => { if (x !== over) x.classList.remove('target'); });
      if (!over || over === side) return;
      e.preventDefault();
      over.classList.add('target');
      return;
    }
    if (!dragged || !e.target.closest) return;
    const list = e.target.closest('.plist');
    if (list !== dragged.parentNode) return;
    e.preventDefault();
    const over = e.target.closest('.prow');
    if (!over || over === dragged) return;
    const r = over.getBoundingClientRect();
    list.insertBefore(dragged, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
  };
  box.ondrop = (e) => { e.preventDefault(); finish(); };
  box.ondragend = finish;
  box.onkeydown = (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const btn = e.target.closest && e.target.closest('[data-player]');
    if (!btn) return;
    e.preventDefault();
    const names = orderSel.get(btn.dataset.team);
    const i = names.indexOf(btn.dataset.player);
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    renderStarters();
    const again = [...box.querySelectorAll('[data-player]')].find((x) =>
      x.dataset.team === btn.dataset.team && x.dataset.player === btn.dataset.player);
    if (again) again.focus();
  };
}

// The other team on the left. The scheduled matchup turns with it, so
// Start doesn't read the swap as a change of teams.
function swapSides() {
  const a = $('teama').value;
  $('teama').value = $('teamb').value;
  $('teamb').value = a;
  if (schedGame) schedGame = { a: schedGame.b, b: schedGame.a };
  renderTeamPick();
}

/* ---------- round + team picker (bare-link path) ---------- */

let selectedRound = 0;
// Where this room is in the day: a tiebreaker it has yet to play comes
// before the round the hub has open.
function nowRound() {
  const dec = (state.packets || []).find((p) => p.tb && !p.done);
  return dec ? dec.number : state.current_round;
}

function deviceMetas() {
  return gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), store)
    .filter((m) => storeIntact(localStorage.getItem(gameKey(store, m.id))));
}

// One small button per round (dot = the live round the TD set, outlined =
// selected); a round with no packet is shown but can't be picked. Games
// this device already has are listed under them, each with Continue.
function renderRounds() {
  // a tiebreaker's place is after the round it follows, T1 before T2
  const place = (n) => { const p = (state.packets || []).find((x) => x.number === n); return p && p.tb ? (p.after || 0) + p.tb / 100 : isTbRound(n) ? 899 + n / 1000 : n; };
  const rows = roundRows(state.packets || [], deviceMetas(), nowRound()).sort((x, y) => place(x.number) - place(y.number));
  const games = rows.filter((r) => r.game);
  $('roundrows').innerHTML = `<div class="rounds">${rows.map((r) => r.packet
    ? `<a href="#" class="rnd${r.live ? ' live' : ''}${r.number === selectedRound ? ' sel' : ''}"
        data-round="${r.number}" title="${r.live ? 'The live round' : roundLabel(r.number)}">${isTbRound(r.number) ? 'T' + (r.number - 900) : r.number}</a>`
    : `<span class="rnd off" title="No packet for round ${r.number}">${r.number}</span>`).join('')}</div>
    ${games.length ? `<div class="devgames">${games.map((r) => `<div>
      <span class="muted">${roundLabel(r.number)}: ${esc(r.game.a)} vs ${esc(r.game.b)} on this device</span>
      <a href="${esc(gameLink(r.game.id))}">Continue</a></div>`).join('')}</div>` : ''}`;
  const sel = rows.find((r) => r.number === selectedRound);
  // a tiebreaker packet read as a half says which
  const info = (state.packets || []).find((p) => p.number === selectedRound);
  const half = info && info.part === 'first' ? ' \u00b7 first half' : info && info.part === 'second' ? ' \u00b7 second half' : '';
  $('packetname').textContent = sel && sel.packet ? 'Packet: ' + sel.packet + half : '';
}

function showTeams() {
  const options = teams.map((t) => `<option>${esc(t.name)}</option>`).join('');
  $('teamrow').hidden = false;
  // team fields start empty
  $('teama').innerHTML = '<option value=""></option>' + options;
  $('teamb').innerHTML = '<option value=""></option>' + options;
  $('teama').onchange = renderStarters;
  $('teamb').onchange = renderStarters;
  $('changeteams').onclick = () => { locked = false; renderTeamPick(); };
  $('useschedteams').onclick = () => { applySchedDefault(); };
  $('starters').onclick = (e) => {
    if (e.target.closest('[data-swap]')) { swapSides(); return; }
    const btn = e.target.closest('[data-player]');
    if (!btn) return;
    const on = starterSel.get(btn.dataset.team);
    if (on.has(btn.dataset.player)) on.delete(btn.dataset.player);
    else on.add(btn.dataset.player);
    renderStarters();
  };
  wireReorder($('starters'));
  renderTeamPick();
  $('start').onclick = async () => {
    const a = $('teama').value, b = $('teamb').value;
    const round = selectedRound;
    const info = (state.packets || []).find((p) => p.number === round);
    try { pickTeams(teams, a, b); } catch (e) { say(e.message, true); return; }
    if (!info) { say('no packet for round ' + round, true); return; }
    // Another round's teams, or a round of this room's schedule not played
    // yet: say so, with the way to that round
    // (a decider follows the rounds: nothing earlier waits on it)
    const other = isTbRound(round) ? null : roundOfTeams(a, b, round);
    const left = isTbRound(round) ? [] : unplayedBefore(round);
    const back = other || (left.length ? left[0].round : null);
    let asked = false;
    if (back) {
      const lines = other ? [`${a} vs ${b} play round ${other} in this room, not round ${round}.`] : [];
      if (left.length) {
        lines.push(left.length === 1 ? `Round ${left[0].round} hasn't been played in this room yet.`
          : `Rounds ${andList(left.map((x) => String(x.round)))} haven't been played in this room yet.`);
      }
      const k = await askWarning({ title: `Start round ${round}?`, lines,
        choices: [...(hasPacket(back) ? [{ key: 'back', label: `Go to round ${back}`, primary: true }] : []),
          { key: 'go', label: `Start round ${round}` }] });
      if (k === 'back') { goToRound(back); return; }
      if (k !== 'go') return;
      asked = true;
    }
    // the same two teams on swapped sides is not a switch
    const same = schedGame && [a, b].sort().join('\n') === [schedGame.a, schedGame.b].sort().join('\n');
    if (schedGame && !same && !asked && !confirm(`WARNING: The schedule indicates that "${schedGame.a}" vs "${
      schedGame.b}" are playing in the room ${state.room}. Are you sure you want to switch?`)) return;
    const noStarters = [a, b].filter((n) => !(starterSel.get(n) || new Set()).size);
    if (noStarters.length) { say('Pick at least one starter for ' + noStarters.join(' and '), true); return; }
    const existing = deviceMetas().find((m) => m.round === round);
    if (existing && !confirm(
      `round ${round} already has a game on this device (${existing.a} vs ${existing.b}). start a new one?`)) {
      return;
    }
    $('start').disabled = true;
    try { packet = await fetchPacket(round, info.packet_name); }
    catch (e) { say(e.message, true); $('start').disabled = false; return; }
    let off = 0;
    if (info.tb) {
      const n = packet.tossups.length, half = Math.floor(n / 2);
      const [from, to] = info.part === 'first' ? [0, half] : info.part === 'second' ? [half, n] : [0, n];
      off = from;
      packet = { ...packet, tossups: packet.tossups.slice(from, to), bonuses: (packet.bonuses || []).slice(from, to) };
    }
    $('start').disabled = false;
    say('');
    const metas = gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), store);
    for (const k of staleGameKeys(metas, store, 7)) localStorage.removeItem(k);
    const id = randId();
    const meta = {
      a, b, round, packet: info.packet_name,
      // a decider: its game is as long as its part of the packet, whose questions keep their numbers
      ...(info.tb ? { reg: packet.tossups.length, off, decider: info.decider } : {}),
      t: state.tournament, room: state.room, started: Date.now(),
      // tiebreakers enter via MODAQ's Add Questions dialog; the mapping
      // starts at the packet's own size and grows as the mod adds them
      tb: { t: packet.tossups.length, b: (packet.bonuses || []).length, tu: [], bo: [] },
      starters: { [a]: [...starterSel.get(a)], [b]: [...starterSel.get(b)] },
      order: { [a]: orderSel.get(a), [b]: orderSel.get(b) },
    };
    // the room has started this round (auto-advance); nothing waits on it
    if (!testKey) pub('/b/' + secret + '/start?round=' + round, { method: 'POST' }).catch(() => {});
    localStorage.setItem(metaKey(store, id), JSON.stringify(meta));
    history.replaceState(null, '', gameLink(id));
    $('picker').hidden = true;
    mountMODAQ(id, meta, true);
    buzzerTeams(meta.a, meta.b);
  };
}

/* ---------- boot ---------- */

async function boot() {
  if (!secret) { say('bad link', true); return; }
  if (testKey) {
    $('testtag').hidden = false;
    $('teststrip').hidden = false;
    $('start').textContent = 'Start test game';
    // a bye room: the TD's room for reading to teams on a bye
    if (testKey === 'bye') {
      $('testtag').textContent = 'Bye Room';
      $('teststrip').innerHTML = '<b>This is the Bye Room.</b> Games read here are NOT saved.';
      $('start').textContent = 'Start bye-round game';
    }
  }

  // Game link: resume that exact game from this device. No fetches — the
  // meta + MODAQ's persisted store hold everything.
  if (gid) {
    const meta = parseMeta(localStorage.getItem(metaKey(store, gid)));
    if (!meta || !storeIntact(localStorage.getItem(gameKey(store, gid)))) {
      say('game not on this device', true);
      $('notfound').hidden = false;
      $('roomlink').href = roomLink();
      $('newgame').href = roomLink();
      return;
    }
    fetchTbPool(); // refresh the Add Questions pool; the game itself is offline
    mountMODAQ(gid, meta, false);
    buzzerTeams(meta.a, meta.b);
    // the room's buzzer, as its room link left it on this device
    // (buzzer_read.js); the roster's names, else this game's players
    const bz = recallBuzzer(store);
    if (bz) mountBuzzer(bz, bz.names.length ? bz.names : Object.values(meta.order || {}).flat().filter(Boolean));
    return;
  }

  // Room link: always a fresh game against the live current round.
  // The four answers this page asks for first come in one request
  // (worker.js bucketLoad), each kept for the call below that would have
  // fetched it; without it (an older Worker, a failure) each goes out alone.
  try {
    const got = await pub(tq('/b/' + secret + '/load'));
    preload(Object.fromEntries(['', '/schedule', '/roster', '/tiebreakers']
      .filter((sub) => got && got[sub] && Number.isInteger(got[sub].s))
      .map((sub) => [tq('/b/' + secret + sub), got[sub]])));
  } catch (e) { /* fetched one by one below */ }
  try {
    state = await pub(tq('/b/' + secret));
  } catch (e) {
    say(e.message === NOT_STARTED ? NOT_STARTED + '. Reload this page once the TD starts it.'
      : e.message === 'room closed' ? 'room closed' : e.message, true);
    return;
  }
  setHeader(state.tournament, state.room, state.current_round, '', state.bracket);
  // a room with a buzzer (state.buzzer: {slug, room, token}) gets the
  // moderator's card, and its game links find the buzzer on this device
  rememberBuzzer(store, state.buzzer);
  if (state.buzzer) mountBuzzer(state.buzzer, (recallBuzzer(store) || {}).names);
  // schedule-less tournaments: this quietly 404s and nothing changes
  const schedP = pub(tq('/b/' + secret + '/schedule')).then((r) => r, () => null);
  // likewise tournaments without a tiebreaker pool
  fetchTbPool();

  // rounds + this device's games render even if the roster fails to load
  const packets = state.packets || [];
  selectedRound = packets.some((p) => p.number === state.current_round)
    ? state.current_round
    : (packets.length ? packets[packets.length - 1].number : 0);
  const dec = packets.find((p) => p.tb && !p.done && !deviceMetas().some((m) => m.round === p.number));
  if (dec) selectedRound = dec.number;
  if (nowRound() !== state.current_round) setHeader(state.tournament, state.room, nowRound(), '');
  $('picker').hidden = false;
  $('roundrows').onclick = (e) => {
    const round = Number(e.target.dataset && e.target.dataset.round);
    if (!round) return;
    e.preventDefault();
    goToRound(round);
  };
  renderRounds();

  if (!packets.length && !deviceMetas().length) {
    say('no packets yet', true);
    return;
  }
  try {
    teams = await fetchTeams();
  } catch (e) {
    say(e.message, true);
    return;
  }
  say('');
  showTeams();
  if (state.buzzer) {
    // the card's short names come from the whole roster
    const names = teams.flatMap((t) => t.players.map((p) => p.name));
    rememberBuzzer(store, state.buzzer, names);
    mountBuzzer(state.buzzer, names);
  }
  const sr = await schedP;
  if (sr && sr.room !== null && sr.schedule) {
    sched = withDeciderPhases(sr.schedule); // tiebreaker deciders as rounds of their own
    schedRoom = sr.room;
    schedBrackets = sr.multi && Array.isArray(sr.brackets) ? sr.brackets : null;
    renderSchedPanel();
    applySchedDefault();
  } else if (sr && sr.schedule && testKey === 'bye') {
    // a bye room: the schedule only for its teams on a bye
    sched = sr.schedule;
    applySchedDefault();
  }
  // warm the cache for the common case (start on the default round)
  const sel = packets.find((p) => p.number === selectedRound);
  if (sel) fetchPacket(sel.number, sel.packet_name).then(() => say('')).catch(() => {});
}

boot();

// how long an upload may take before the reader gives up on it
const UPLOAD_WAIT_MS = 45000;

// "Uploading the game…" over the reader while an upload runs; it takes
// the clicks, so a moderator can't send the game again meanwhile
function uploadingNote() {
  const el = document.createElement('div');
  el.className = 'uploading';
  el.setAttribute('role', 'status');
  el.innerHTML = '<div class="uploadingcard"><span class="spin" aria-hidden="true"></span>Uploading the game. Please wait.</div>';
  document.body.appendChild(el);
  return el;
}
