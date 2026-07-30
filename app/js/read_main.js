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
// traffic: two per export click. Nothing polls — the TD's broadcasts ride
// in on the room state and on each upload's response, which is the
// between-rounds moment they're written for anyway.
//
// docx packets are parsed in the browser by the same YAPP service MODAQ's
// own demo uses (CORS *); JSON packets load directly.

import React from 'react';
import ReactDOM from 'react-dom';
import { ModaqControl, GameFormats, parseQbjRegistration } from 'modaq';
import { pub, esc } from './api.js';
import { annStrip } from './announce.js';
import {
  normalizePacket, groupTeams, pickTeams, matchFilenames, combinedUpload,
  resolveGameFormat, metaKey, gameKey, parseMeta, storeIntact, gameMetas,
  staleGameKeys, roundRows, normalizeTbPool, tbUsedIds, tbPanelRows,
} from './read_core.js';
import { tbBridge } from './tb_bridge.js';
import { gameForRoom, roomRounds, slotText } from '../engine/schedule.js';

const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const secret = params.get('b') || '';
const gid = params.get('g') || '';

let state = null;   // /b/:secret response (bare-link path only)
let teams = null;   // [{name, players}] from the roster
let packet = null;  // normalized IPacket
let sched = null;      // tournament schedule (when the TO made one)
let schedRoom = null;  // this bucket's room index in it
let defaultPick = { a: '', b: '' }; // last schedule preselect, so overrides stick
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
  const res = await pub('/b/' + secret + '/packet?round=' + round);
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

function setHeader(t, room, round, game) {
  document.title = t + ' - ' + room;
  $('tname').textContent = t;
  $('room').textContent = room + ' · round ' + round;
  if (game) $('game').textContent = game;
  $('bucketlink').href = 'bucket.html?b=' + encodeURIComponent(secret);
  $('newgame').href = roomLink();
}

// The newest message for this room, on one line above MODAQ. It survives
// the mount (the page chrome above it collapses; this doesn't).
function renderAnn(list) {
  $('annstrip').innerHTML = annStrip(list);
  $('annstrip').hidden = !$('annstrip').innerHTML;
}

function mountMODAQ(id, meta, isNew) {
  document.body.classList.add('reading');
  setHeader(meta.t, meta.room, meta.round, meta.a + ' vs ' + meta.b);

  // The Add Questions dialog (tb_add_dialog.js) reads the pool and reports
  // what the mod appended; the meta keeps the id mapping so the upload can
  // say exactly which tiebreakers this game read.
  tbBridge.pool = tbPool;
  tbBridge.addedIds = () => (meta.tb ? [...meta.tb.tu, ...meta.tb.bo] : []);
  tbBridge.onAdd = (sel, base) => {
    // games from before the meta carried tb: start the mapping at the
    // packet size the dialog saw before this append
    if (!meta.tb) meta.tb = { t: base.t, b: base.b, tu: [], bo: [] };
    meta.tb.tu.push(...sel.tu);
    meta.tb.bo.push(...sel.bo);
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
          // so the TD's usage log stays exact (worker logTbUses)
          const body = combinedUpload(match, meta.round,
            localStorage.getItem(gameKey(secret, id)),
            meta.tb ? tbUsedIds(match, meta.tb) : null);
          const out = await pub(
            `/b/${secret}/upload?round=${meta.round}&name=${encodeURIComponent(name)}`,
            { method: 'POST', body });
          if (out && out.announce) renderAnn(out.announce);
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
    props.players = pickTeams(teams, meta.a, meta.b);
    const format = resolveGameFormat(state.settings || {}, GameFormats);
    if (format) props.gameFormat = format;
  }
  ReactDOM.render(React.createElement(ModaqControl, props), $('modaq'));
}

/* ---------- schedule defaults (bare-link path) ---------- */

// Tiebreaker pool in the side panel: every question, and who has already
// heard it — the mod checks with the TD which one to read, and this shows
// at a glance which are burned for which teams. During a game the pool is
// under MODAQ's Actions -> Add questions, which appends the picked
// question to the end of the packet.
function renderTbPanel() {
  const rows = tbPanelRows(tbPool);
  if (!rows.length) return;
  $('tbpanel').hidden = false;
  $('tbbase').textContent =
    'During a game: Actions → Add questions… lists these; the one you pick is appended to the packet.';
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
function renderSchedPanel() {
  if (!sched || schedRoom === null) return;
  const rows = roomRounds(sched, schedRoom);
  if (!rows.length) return;
  $('schedpanel').hidden = false;
  $('schedrows').innerHTML = rows.map((r) => `
    <tr${r.round === state.current_round ? ' class="now"' : ' class="muted"'}>
      <td class="roundcell">${r.round}</td>
      <td class="name">${esc(slotText(r.a) || '—')} v ${esc(slotText(r.b) || '—')}</td>
    </tr>`).join('');
}

// Preselect the scheduled matchup for the selected round. Only fills
// pickers that are empty or still on the previous round's default — a
// mod's manual choice is never clobbered.
function applySchedDefault() {
  if (!sched || schedRoom === null || !teams || $('teamrow').hidden) return;
  const g = gameForRoom(sched, schedRoom, selectedRound);
  const known = (n) => teams.some((t) => t.name === n);
  if (!g || !known(g.a) || !known(g.b)) return;
  const untouched = (el, prev) => !el.value || el.value === prev;
  if (untouched($('teama'), defaultPick.a) && untouched($('teamb'), defaultPick.b)) {
    $('teama').value = g.a;
    $('teamb').value = g.b;
    defaultPick = { a: g.a, b: g.b };
  }
}

/* ---------- round + team picker (bare-link path) ---------- */

let selectedRound = 0;

function deviceMetas() {
  return gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), secret)
    .filter((m) => storeIntact(localStorage.getItem(gameKey(secret, m.id))));
}

// One row per round: a pill to pick it (green = the live round the TD set,
// filled = selected), plus a continue button when this device already has
// a game for it. Rounds with a game but no packet keep their continue.
function renderRounds() {
  const rows = roundRows(state.packets || [], deviceMetas(), state.current_round);
  $('roundrows').innerHTML = rows.map((r) => `
    <div class="row">
      ${r.packet
        ? `<a href="#" class="pill${r.live ? ' on' : ''}${r.number === selectedRound ? ' sel' : ''}"
            data-round="${r.number}">round ${r.number}</a>`
        : `<span class="pill muted">round ${r.number}</span>`}
      ${r.game ? `<span class="muted">${esc(r.game.a)} vs ${esc(r.game.b)}</span>
        <a class="btn" href="${esc(gameLink(r.game.id))}">continue</a>` : ''}
    </div>`).join('');
  const sel = rows.find((r) => r.number === selectedRound);
  $('packetname').textContent = (sel && sel.packet) || '';
}

function showTeams() {
  const options = teams.map((t) => `<option>${esc(t.name)}</option>`).join('');
  $('teamrow').hidden = false;
  // team fields start empty
  $('teama').innerHTML = '<option value=""></option>' + options;
  $('teamb').innerHTML = '<option value=""></option>' + options;
  $('start').onclick = async () => {
    const a = $('teama').value, b = $('teamb').value;
    const round = selectedRound;
    const info = (state.packets || []).find((p) => p.number === round);
    try { pickTeams(teams, a, b); } catch (e) { say(e.message, true); return; }
    if (!info) { say('no packet for round ' + round, true); return; }
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
    };
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
    say(e.message === 'room closed' ? 'room closed' : e.message, true);
    return;
  }
  setHeader(state.tournament, state.room, state.current_round, '');
  renderAnn(state.announce);
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
    renderSchedPanel();
    applySchedDefault();
  }
  // warm the cache for the common case (start on the default round)
  const sel = packets.find((p) => p.number === selectedRound);
  if (sel) fetchPacket(sel.number, sel.packet_name).then(() => say('')).catch(() => {});
}

boot();
