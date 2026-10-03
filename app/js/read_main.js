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
// docx packets are parsed in the browser by the same YAPP service MODAQ's
// own demo uses (CORS *); JSON packets load directly.

import React from 'react';
import ReactDOM from 'react-dom';
import { ModaqControl, GameFormats, parseQbjRegistration } from 'modaq';
import { pub, esc } from './api.js';
import {
  normalizePacket, groupTeams, pickTeams, matchFilenames, combinedUpload,
  resolveGameFormat, metaKey, gameKey, parseMeta, storeIntact, gameMetas,
  staleGameKeys, roundRows, normalizeTbPool, tbUsedIds, tbPanelRows,
  tbRecordAdd, tbAddedIds, tbRemapMatch, tbNumbering,
} from './read_core.js';
import { tbBridge } from './tb_bridge.js';
import { protestReport } from './protests.js';
import { Tossup } from 'modaq/src/state/PacketState.js';
import { gameForRoom, roomRounds, slotText } from '../engine/schedule.js';
import { slotLabel } from '../engine/brackets.js';

const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';
// worker.js NOT_STARTED: every room route answers this until the TD presses Start
const NOT_STARTED = "Tournament hasn't started";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const secret = params.get('b') || '';
const gid = params.get('g') || '';

let state = null;   // /b/:secret response (bare-link path only)
let teams = null;   // [{name, players}] from the roster
let packet = null;  // normalized IPacket
let sched = null;      // tournament schedule (when the TO made one)
let schedRoom = null;  // this bucket's room index in it
let schedBrackets = null; // [{key, name, phase, color}] when brackets keep their own rounds, else null
let schedGame = null;  // {a, b}: what the schedule has this room playing in the selected round
let locked = false;    // the scheduled matchup is showing, pickers hidden
const starterSel = new Map(); // team name -> Set of the player names starting
let tbPool = null;  // TO's tiebreaker pool (offered in Add Questions)

// Non-blocking pool fetch: fills the Add Questions dialog whenever it
// lands; a resumed game stays fully usable offline without it.
function fetchTbPool() {
  pub('/b/' + secret + '/tiebreakers').then((r) => {
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
  return location.pathname + '?b=' + encodeURIComponent(secret);
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
  // started a round (auto-advance) from the Start button's own signal
  const res = await pub('/b/' + secret + '/packet?round=' + round + '&warm=1');
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
  const roster = await pub('/b/' + secret + '/roster');
  const text = roster instanceof Response ? await roster.text() : JSON.stringify(roster);
  const parsed = parseQbjRegistration(text);
  if (!parsed.success) throw new Error('roster: ' + parsed.message);
  return groupTeams(parsed.value);
}

/* ---------- MODAQ mount ---------- */

// bracket: {name, color} on a schedule whose brackets keep their own
// rounds (the room's round is its bracket's)
function setHeader(t, room, round, game, bracket) {
  document.title = t + ' - ' + room;
  $('tname').textContent = t;
  $('room').textContent = room + ' · Round ' + round;
  if (bracket) {
    $('room').insertAdjacentHTML('beforeend',
      ` · <span class="bname"><i class="lane-${Number(bracket.color) || 0}"></i>${esc(bracket.name)}</span>`);
  }
  if (game) $('game').textContent = game;
  $('bucketlink').href = 'bucket.html?b=' + encodeURIComponent(secret);
  $('newgame').href = roomLink();
}

// The game's protests as the hub reads them (protests.js protestReport),
// numbered the way the upload numbers questions. null if the store won't
// parse.
function gameProtests(storeText, meta, format) {
  let protests;
  try { protests = protestReport(JSON.parse(storeText), format, Tossup); }
  catch (e) { return null; }
  if (!meta.tb) return protests;
  const num = tbNumbering(meta.tb);
  return protests.map((p) => ({ ...p, q: p.kind === 'b' ? num.bo(p.q) : num.tu(p.q) }));
}

// MODAQ saves the game to localStorage as it changes; every few seconds
// this reads it back (local only) and, when the protest list differs from
// what the hub last got, sends it. A failed send is retried on the next
// change check, so a protest lodged offline arrives once the room is back.
const PROTEST_CHECK_MS = 5000;
function watchProtests(id, meta, format) {
  let lastText = null;
  let sent = JSON.stringify([]); // a game with none has nothing to say
  let busy = false;
  const check = async () => {
    const text = localStorage.getItem(gameKey(secret, id));
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
      // offline (fetch's TypeError): the next check tries again; a refusal
      // waits for the game to change
      if (!(e instanceof TypeError)) lastText = text;
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
  tbBridge.onAdd = (sel, base, at) => {
    meta.tb = tbRecordAdd(meta.tb, base, at || base, sel);
    localStorage.setItem(metaKey(secret, id), JSON.stringify(meta));
  };

  const props = {
    persistState: true,
    storeName: gameKey(secret, id),
    hideNewGame: true,
    yappServiceUrl: YAPP,
    customExport: {
      label: 'Upload to qb-td',
      type: 'QBJ',
      onExport: async (match) => {
        try {
          const name = matchFilenames(meta.round, meta.a, meta.b).combined;
          // games with appended tiebreakers report which ones were read,
          // so the TD's usage log stays exact (worker logTbUses); logged
          // protests go up structured, swing included, for the hub's
          // Protests drawer (the qbj's notes carry them as text only)
          // (null if the store won't parse: the Worker falls back to the
          // qbj's notes)
          const storeText = localStorage.getItem(gameKey(secret, id));
          const protests = gameProtests(storeText, meta, props.gameFormat || null);
          // questions added mid-packet shift MODAQ's numbering; number them
          // as if appended so stats keyed on packet numbers line up
          const qbj = meta.tb ? tbRemapMatch(match, meta.tb) : match;
          const body = combinedUpload(qbj, meta.round, storeText,
            meta.tb ? tbUsedIds(qbj, meta.tb) : null, protests);
          const out = await pub(
            `/b/${secret}/upload?round=${meta.round}&name=${encodeURIComponent(name)}`,
            { method: 'POST', body });
          if (out && out.error) return { isError: true, status: name + ': ' + out.error };
          return { isError: false, status: 'uploaded ' + name };
        } catch (e) {
          return { isError: true, status: String((e && e.message) || e) };
        }
      },
    },
  };
  if (isNew) {
    // Resume mounts restore everything from the persisted store instead;
    // these props would clobber it.
    props.packet = packet;
    props.packetName = meta.packet;
    // the moderator's starters; games from before they were chosen keep
    // the roster's default (MODAQ starts the first four of each team)
    const players = pickTeams(teams, meta.a, meta.b);
    props.players = meta.starters
      ? players.map((pl) => ({ name: pl.name, teamName: pl.teamName,
        isStarter: (meta.starters[pl.teamName] || []).includes(pl.name) }))
      : players;
    const format = resolveGameFormat(state.settings || {}, GameFormats);
    if (format) props.gameFormat = format;
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
    <tr${r.round === state.current_round ? ' class="now"' : ' class="muted"'}>
      <td class="roundcell">${r.round}</td>
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
function applySchedDefault() {
  schedGame = null;
  if (sched && schedRoom !== null && teams && !$('teamrow').hidden) {
    const g = gameForRoom(sched, schedRoom, selectedRound);
    const known = (n) => teams.some((t) => t.name === n);
    if (g && known(g.a) && known(g.b)) schedGame = { a: g.a, b: g.b };
  }
  if (schedGame) {
    $('teama').value = schedGame.a;
    $('teamb').value = schedGame.b;
  }
  locked = !!schedGame;
  renderTeamPick();
}

function renderTeamPick() {
  $('schedmatch').hidden = !locked;
  $('teampickers').hidden = locked;
  $('changeteams').hidden = !locked;
  $('useschedteams').hidden = locked || !schedGame;
  if (schedGame) {
    const br = bracketAt(selectedRound);
    $('schedfrom').innerHTML = br
      ? `From the schedule \u00b7 <i class="lane-${Number(br.color) || 0}"></i>${esc(br.name)} \u00b7 Round ${selectedRound} in ${esc(state.room)}`
      : esc(`From the schedule \u00b7 Round ${selectedRound} in ${state.room}`);
    $('mteama').textContent = schedGame.a;
    $('mteamb').textContent = schedGame.b;
  }
  renderStarters();
}

// Starters for the two picked teams: every player, the roster's first
// four ticked (MODAQ's own default), and the moderator ticks as many or as
// few as are actually playing — at least one a team, checked at Start.
function renderStarters() {
  const names = [$('teama').value, $('teamb').value].filter((n, i, all) => n && all.indexOf(n) === i);
  const picked = names.map((n) => teams.find((t) => t.name === n)).filter(Boolean);
  for (const t of picked) {
    if (!starterSel.has(t.name)) {
      starterSel.set(t.name, new Set(t.players.filter((pl) => pl.isStarter).map((pl) => pl.name)));
    }
  }
  $('starters').innerHTML = picked.length ? `
    <div class="lineups">${picked.map((t) => {
      const on = starterSel.get(t.name);
      return `<div class="lineup">
        <h4><span>${esc(t.name)}</span><span class="count${on.size ? '' : ' none'}">${on.size} starting</span></h4>
        <div class="plist">${t.players.map((pl) => `<button type="button" class="p${on.has(pl.name) ? ' on' : ''}"
          data-team="${esc(t.name)}" data-player="${esc(pl.name)}" aria-pressed="${on.has(pl.name)}"><span class="box">${
          on.has(pl.name) ? '\u2713' : ''}</span>${esc(pl.name)}${on.has(pl.name) ? '' : '<span class="bench">bench</span>'}</button>`).join('')}</div>
      </div>`;
    }).join('')}</div>` : '';
}

/* ---------- round + team picker (bare-link path) ---------- */

let selectedRound = 0;

function deviceMetas() {
  return gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), secret)
    .filter((m) => storeIntact(localStorage.getItem(gameKey(secret, m.id))));
}

// One small button per round (dot = the live round the TD set, outlined =
// selected); a round with no packet is shown but can't be picked. Games
// this device already has are listed under them, each with Continue.
function renderRounds() {
  const rows = roundRows(state.packets || [], deviceMetas(), state.current_round);
  const games = rows.filter((r) => r.game);
  $('roundrows').innerHTML = `<div class="rounds">${rows.map((r) => r.packet
    ? `<a href="#" class="rnd${r.live ? ' live' : ''}${r.number === selectedRound ? ' sel' : ''}"
        data-round="${r.number}" title="${r.live ? 'The live round' : 'Round ' + r.number}">${r.number}</a>`
    : `<span class="rnd off" title="No packet for round ${r.number}">${r.number}</span>`).join('')}</div>
    ${games.length ? `<div class="devgames">${games.map((r) => `<div>
      <span class="muted">Round ${r.number}: ${esc(r.game.a)} vs ${esc(r.game.b)} on this device</span>
      <a href="${esc(gameLink(r.game.id))}">Continue</a></div>`).join('')}</div>` : ''}`;
  const sel = rows.find((r) => r.number === selectedRound);
  $('packetname').textContent = sel && sel.packet ? 'Packet: ' + sel.packet : '';
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
    const btn = e.target.closest('[data-player]');
    if (!btn) return;
    const on = starterSel.get(btn.dataset.team);
    if (on.has(btn.dataset.player)) on.delete(btn.dataset.player);
    else on.add(btn.dataset.player);
    renderStarters();
  };
  renderTeamPick();
  $('start').onclick = async () => {
    const a = $('teama').value, b = $('teamb').value;
    const round = selectedRound;
    const info = (state.packets || []).find((p) => p.number === round);
    try { pickTeams(teams, a, b); } catch (e) { say(e.message, true); return; }
    if (!info) { say('no packet for round ' + round, true); return; }
    // the same two teams on swapped sides is not a switch
    const same = schedGame && [a, b].sort().join('\n') === [schedGame.a, schedGame.b].sort().join('\n');
    if (schedGame && !same && !confirm(`WARNING: The schedule indicates that "${schedGame.a}" vs "${
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
    $('start').disabled = false;
    say('');
    const metas = gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), secret);
    for (const k of staleGameKeys(metas, secret, 7)) localStorage.removeItem(k);
    const id = randId();
    const meta = {
      a, b, round, packet: info.packet_name,
      t: state.tournament, room: state.room, started: Date.now(),
      // tiebreakers enter via MODAQ's Add Questions dialog; the mapping
      // starts at the packet's own size and grows as the mod adds them
      tb: { t: packet.tossups.length, b: (packet.bonuses || []).length, tu: [], bo: [] },
      starters: { [a]: [...starterSel.get(a)], [b]: [...starterSel.get(b)] },
    };
    // the room has started this round (auto-advance); nothing waits on it
    pub('/b/' + secret + '/start?round=' + round, { method: 'POST' }).catch(() => {});
    localStorage.setItem(metaKey(secret, id), JSON.stringify(meta));
    history.replaceState(null, '', gameLink(id));
    $('picker').hidden = true;
    mountMODAQ(id, meta, true);
  };
}

/* ---------- boot ---------- */

async function boot() {
  if (!secret) { say('bad link', true); return; }

  // Game link: resume that exact game from this device. No fetches — the
  // meta + MODAQ's persisted store hold everything.
  if (gid) {
    const meta = parseMeta(localStorage.getItem(metaKey(secret, gid)));
    if (!meta || !storeIntact(localStorage.getItem(gameKey(secret, gid)))) {
      say('game not on this device', true);
      $('notfound').hidden = false;
      $('roomlink').href = roomLink();
      $('newgame').href = roomLink();
      return;
    }
    fetchTbPool(); // refresh the Add Questions pool; the game itself is offline
    mountMODAQ(gid, meta, false);
    return;
  }

  // Room link: always a fresh game against the live current round.
  try {
    state = await pub('/b/' + secret);
  } catch (e) {
    say(e.message === NOT_STARTED ? NOT_STARTED + '. Reload this page once the TD starts it.'
      : e.message === 'room closed' ? 'room closed' : e.message, true);
    return;
  }
  setHeader(state.tournament, state.room, state.current_round, '', state.bracket);
  // schedule-less tournaments: this quietly 404s and nothing changes
  const schedP = pub('/b/' + secret + '/schedule').then((r) => r, () => null);
  // likewise tournaments without a tiebreaker pool
  fetchTbPool();

  // rounds + this device's games render even if the roster fails to load
  const packets = state.packets || [];
  selectedRound = packets.some((p) => p.number === state.current_round)
    ? state.current_round
    : (packets.length ? packets[packets.length - 1].number : 0);
  $('picker').hidden = false;
  $('roundrows').onclick = (e) => {
    const round = Number(e.target.dataset && e.target.dataset.round);
    if (!round) return;
    e.preventDefault();
    selectedRound = round;
    renderRounds();
    applySchedDefault();
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
  const sr = await schedP;
  if (sr && sr.room !== null && sr.schedule) {
    sched = sr.schedule;
    schedRoom = sr.room;
    schedBrackets = sr.multi && Array.isArray(sr.brackets) ? sr.brackets : null;
    renderSchedPanel();
    applySchedDefault();
  }
  // warm the cache for the common case (start on the default round)
  const sel = packets.find((p) => p.number === selectedRound);
  if (sel) fetchPacket(sel.number, sel.packet_name).then(() => say('')).catch(() => {});
}

boot();
