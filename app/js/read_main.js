// read_main.js — source for read.bundle.js (npm run build:read). The
// moderator reader page: an embedded MODAQ preloaded with the room's
// current packet, the tournament roster, and the TO's game format, so the
// mod only picks the two teams. The finished game uploads straight back to
// the bucket via MODAQ's customExport — no file downloads or uploads.
//
// Every started game gets its own URL (?b=<secret>&g=<id>) and its own
// localStorage keys (read_core.js). A game link resumes exactly that game
// from this device, with zero network requests; the bare room link always
// fetches fresh (state + packet + roster) and shows the team picker plus
// any games in progress on this device. Uploads are the only other
// traffic: two per export click. Nothing polls.
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
  staleGameKeys,
} from './read_core.js';

const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const secret = params.get('b') || '';
const gid = params.get('g') || '';

let state = null;   // /b/:secret response (bare-link path only)
let teams = null;   // [{name, players}] from the roster
let packet = null;  // normalized IPacket

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

async function fetchPacket() {
  if (!state.packet) throw new Error('no packet for round ' + state.current_round + ' yet');
  const name = state.packet.packet_name || '';
  const res = await pub('/b/' + secret + '/packet');
  // pub() returns parsed JSON when the blob was stored with a JSON content
  // type, and the raw Response otherwise.
  if (!(res instanceof Response)) return normalizePacket(res, name);
  if (/\.json$/i.test(name)) return normalizePacket(JSON.parse(await res.text()), name);
  if (/\.docx$/i.test(name)) {
    say('parsing packet...');
    const yapp = await fetch(YAPP, { method: 'POST', body: await res.arrayBuffer(), mode: 'cors' });
    if (!yapp.ok) throw new Error('packet parser failed (' + yapp.status + ')');
    return normalizePacket(await yapp.json(), name);
  }
  throw new Error('packet is ' + (name.split('.').pop() || 'unknown') + '; the reader needs .json or .docx');
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

function mountModaq(id, meta, isNew) {
  document.body.classList.add('reading');
  setHeader(meta.t, meta.room, meta.round, meta.a + ' vs ' + meta.b);

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
          const body = combinedUpload(match, meta.round, localStorage.getItem(gameKey(secret, id)));
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
    props.players = pickTeams(teams, meta.a, meta.b);
    const format = resolveGameFormat((state.settings || {}).gameFormat, GameFormats);
    if (format) props.gameFormat = format;
  }
  ReactDOM.render(React.createElement(ModaqControl, props), $('modaq'));
}

/* ---------- team picker (bare-link path) ---------- */

function showResumable() {
  const metas = gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), secret)
    .filter((m) => storeIntact(localStorage.getItem(gameKey(secret, m.id))));
  if (!metas.length) return;
  $('resume').hidden = false;
  $('resumelist').innerHTML = metas.map((m) =>
    `<div class="row"><a href="${esc(gameLink(m.id))}">round ${m.round} · ${esc(m.a)} vs ${esc(m.b)}</a></div>`).join('');
}

function showPicker() {
  const options = teams.map((t) => `<option>${esc(t.name)}</option>`).join('');
  $('picker').hidden = false;
  $('teama').innerHTML = '<option value="">team 1</option>' + options;
  $('teamb').innerHTML = '<option value="">team 2</option>' + options;
  $('start').onclick = () => {
    const a = $('teama').value, b = $('teamb').value;
    try { pickTeams(teams, a, b); } catch (e) { say(e.message, true); return; }
    say('');
    const metas = gameMetas(Object.keys(localStorage), (k) => localStorage.getItem(k), secret);
    for (const k of staleGameKeys(metas, secret, 7)) localStorage.removeItem(k);
    const id = randId();
    const meta = {
      a, b, round: state.current_round, packet: state.packet.packet_name,
      t: state.tournament, room: state.room, started: Date.now(),
    };
    localStorage.setItem(metaKey(secret, id), JSON.stringify(meta));
    history.replaceState(null, '', gameLink(id));
    $('picker').hidden = true;
    $('resume').hidden = true;
    mountModaq(id, meta, true);
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
    mountModaq(gid, meta, false);
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
  showResumable();

  try {
    [packet, teams] = await Promise.all([fetchPacket(), fetchTeams()]);
  } catch (e) {
    say(e.message, true);
    return;
  }
  say('');
  $('packetname').textContent = packet.name || '';
  showPicker();
}

boot();
