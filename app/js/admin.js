// admin.js — the TO dashboard (index.html). No login: the admin link
// (index.html?a=<secret>, minted at creation, expires 48h later) is the
// only credential. Tournaments this device created or opened are
// remembered in localStorage so the list view survives a closed tab —
// but the link itself is the source of truth.
//
// The dashboard is two views. Tournament Setup is the before-the-day
// work — Rooms, Packets + Tiebreakers, Roster, Schedule — with a progress
// pill per step. The Live Hub is the day-of page — round control,
// broadcasts, settings, stats + export, uploads — and carries a notice
// until setup is complete.

import { API, pub, esc, fmtBytes, download } from './api.js';
import { parseMatch, parseRoster, matchPayload, buildRosterQbj,
  guessRound } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { serializeYft } from '../engine/yft.js';
import { buildReport } from '../engine/report.js';
import { makeZip, readZip } from '../engine/zip.js';
import { renderStats } from './statsview.js';
import { GAME_FORMAT_OPTIONS, effectiveFormat, formatOverridesFrom, cleanOverrides,
  parsePowersText, powersText } from './read_core.js';
import { formatsFor, buildSchedule, validateSchedule, slotText, roundIntake,
  insertRound, removeRound, addRound, swapCells, addRoomCol, removeRoomCol,
  hasPlaceholders, poolStandings, fillPlaceholders } from '../engine/schedule.js';
import { annLive, annTime } from './announce.js';
import { buzzCredentials } from './buzzkey.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const msg = $('msg');
const adminSecret = new URLSearchParams(location.search).get('a') || '';

function say(text, bad = false) {
  msg.textContent = text || '';
  msg.className = bad ? 'bad' : '';
}

function pageDir() {
  return location.href.split(/[?#]/)[0].replace(/index\.html$/, '').replace(/\/$/, '');
}
function adminLink(secret) { return pageDir() + '/index.html?a=' + secret; }
function bucketLink(secret) { return pageDir() + '/bucket.html?b=' + secret; }
function readLink(secret) { return pageDir() + '/read.html?b=' + secret; }
function statsLink(slug) { return pageDir() + '/t.html?t=' + slug; }

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  say('Copied ' + label);
}
window.qtd = { copy }; // for inline onclick handlers

/* ---------- this device's tournament list (localStorage) ---------- */

const LINKS_KEY = 'qbtdAdminLinks';
// Games per rebuild request; must not exceed the Worker's MAX_REBUILD.
const REBUILD_BATCH = 200;

function savedLinks() {
  try {
    const list = JSON.parse(localStorage.getItem(LINKS_KEY));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
function saveLink(entry) {
  const list = savedLinks().filter((e) => e.secret !== entry.secret && e.slug !== entry.slug);
  list.unshift(entry);
  localStorage.setItem(LINKS_KEY, JSON.stringify(list.slice(0, 30)));
}

/* ---------- save-this-link modal ---------- */

function showLinkModal(link, closes, onDone) {
  $('modallink').textContent = link;
  $('modalcloses').textContent = new Date(closes).toLocaleString();
  $('linkmodal').hidden = false;
  $('modalcopy').onclick = () => copy(link, 'admin link');
  $('modalok').onclick = () => {
    $('linkmodal').hidden = true;
    onDone();
  };
}

/* ---------- tournament list ---------- */

function showList() {
  const links = savedLinks();
  view.innerHTML = `
    <h2>Tournaments on this device</h2>
    ${links.map((e) => {
      const open = Date.now() < e.closes;
      return `
      <div class="card row">
        ${open ? `<a href="${esc(adminLink(e.secret))}"><b>${esc(e.name)}</b></a>`
               : `<b class="muted">${esc(e.name)}</b>`}
        <span class="mono muted">${esc(e.slug)}</span>
        <span class="spacer" style="flex:1"></span>
        ${open ? `<span class="muted">Open until ${new Date(e.closes).toLocaleString()}</span>`
               : `<span class="pill">Closed</span> <a href="${esc(statsLink(e.slug))}">Page</a>`}
      </div>`;
    }).join('') || '<div class="muted">None yet</div>'}
    <h2>New tournament</h2>
    <div class="row">
      <input id="newname" placeholder="Name" size="24">
      <input id="newslug" placeholder="Slug (public URL)" size="18">
      <button id="newbtn" class="primary">Create</button>
    </div>
    <h2>Archive</h2>
    <div><a href="archive.html">Past tournaments</a></div>
    <h2>Demo</h2>
    <div><a href="demo.html">Simulated tournament</a>
      <span class="muted">try the reader and the public pages without creating anything</span></div>`;
  $('newbtn').onclick = async () => {
    try {
      const out = await pub('/api/tournaments', { method: 'POST', json: {
        name: $('newname').value, slug: $('newslug').value,
      } });
      saveLink({ secret: out.admin_secret, slug: out.slug, name: out.name,
        closes: out.closes, created: Date.now() });
      showLinkModal(adminLink(out.admin_secret), out.closes, () => {
        location.href = adminLink(out.admin_secret);
      });
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- tournament detail: shared state ----------
   Survives render() re-renders (which happen after every action). */

let lastDetail = null;  // cached /a/:secret response for local re-renders
let curView = null;     // 'setup' | 'live'; null = auto until the user picks
let setupTab = 'rooms'; // active Tournament Setup sub-tab

let staged = [];        // packets staged from a zip or loose files
let tbPool = null;      // tiebreaker pool blob (questions + uses), or null

let rosterOpen = false;
let rosterTeams = null; // structured editor working copy [{name, players}]
let rosterUpload = null; // parsed upload awaiting confirmation

let fmtOpen = false;     // Customize MODAQ settings panel
let uploadsOpen = null;  // Set of expanded upload rounds; null = current round only
let annOpen = null;      // Broadcasts drawer; null = auto: open when something is live
// the composer, so a re-render mid-compose doesn't eat what was typed
let annForm = { text: '', to: 'both', rooms: [], mins: '240', alert: false };

/* ---------- broadcasts ----------
   Short messages the TO sends to the public page and/or the moderator
   rooms. The whole live list is written at once (POST /a/:secret with
   `announce`), same idiom as settings; the Worker validates it and hands
   each surface only the messages addressed to it. */

const MAX_ANNOUNCE = 8; // worker.js MAX_ANNOUNCE
const ANN_EXPIRY = [
  ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'],
  ['240', '4 hours'], ['480', '8 hours'], ['end', 'when the tournament closes'],
];

function annId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// Who a message went to. Unpublished tournaments grey the public pill out:
// the message is stored and will appear the moment the page goes public.
function annAudience(a, buckets, published) {
  const parts = [];
  if (a.pub) parts.push([published ? 'pill on' : 'pill', 'Public']);
  if (a.rooms === true) parts.push(['pill on', 'Rooms']);
  else if (Array.isArray(a.rooms)) {
    for (const id of a.rooms) {
      const b = buckets.find((x) => x.id === id);
      parts.push(['pill on', b ? b.room_name : '#' + id]);
    }
  }
  return parts.map(([cls, label]) => `<span class="${cls}">${esc(label)}</span>`).join(' ');
}

/* ---------- data fetch + top-level render ---------- */

async function showDetail() {
  const a = '/a/' + adminSecret;
  let detail;
  try {
    detail = await pub(a);
  } catch (e) {
    if (e.message === 'tournament closed') {
      say('Tournament closed (admin links stop working 48 hours after creation)', true);
    } else say(e.message, true);
    view.innerHTML = `<div class="row"><a href="index.html">All tournaments</a></div>`;
    return;
  }
  const t = detail.tournament;
  saveLink({ secret: adminSecret, slug: t.slug, name: t.name,
    closes: t.closes, created: t.created });
  await ensureSched(a, t);
  try { tbPool = await fetchOwnedJson(a, `t/${t.id}/tiebreakers.json`); }
  catch (e) { tbPool = null; }
  lastDetail = detail;
  render();
}

// The four setup steps and their done state.
function setupSteps(t, buckets, rounds, settings) {
  const totalRounds = Math.max(Number(settings.rounds) || 1, t.current_round,
    ...rounds.map((r) => r.number));
  return [
    ['rooms', 'Rooms', buckets.length > 0,
      buckets.length ? buckets.length + ' rooms' : 'None yet'],
    ['packets', 'Packets', rounds.length > 0,
      rounds.length + '/' + totalRounds + ' rounds'],
    ['roster', 'Roster', !!t.roster_name, t.roster_name ? 'Saved' : 'None yet'],
    ['sched', 'Schedule', !!sched, sched ? 'Saved' : 'None yet'],
  ];
}

function render() {
  if (!lastDetail) return;
  const a = '/a/' + adminSecret;
  const scrollWas = window.scrollY; // survive the full re-render
  const { tournament: t, buckets, rounds, files } = lastDetail;
  let settings = {};
  try { settings = JSON.parse(t.settings) || {}; } catch (e) { /* keep {} */ }
  const steps = setupSteps(t, buckets, rounds, settings);
  const missing = steps.filter((s) => !s[2]).map((s) => s[1]);
  const v = curView || (missing.length ? 'setup' : 'live');

  view.innerHTML = `
    <div class="row">
      <a href="index.html">&larr; All tournaments</a>
      <span class="spacer" style="flex:1"></span>
      <a class="mono" href="${esc(statsLink(t.slug))}" target="_blank">${esc(statsLink(t.slug))}</a>
      <button class="small" onclick="qtd.copy('${esc(statsLink(t.slug))}', 'public link')">Copy</button>
    </div>
    <div class="row" style="margin-top:6px">
      <b style="font-size:18px">${esc(t.name)}</b>
      <span class="mono muted">${esc(t.slug)}</span>
    </div>
    <div class="tabs bigtabs" style="margin-top:10px">
      <button class="tab ${v === 'setup' ? 'active' : ''}" data-view="setup">Tournament Setup${
        missing.length ? ' <span class="ndot">&bull;</span>' : ''}</button>
      <button class="tab ${v === 'live' ? 'active' : ''}" data-view="live">Live Hub</button>
    </div>
    <div id="viewbody"></div>`;
  view.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => { curView = b.dataset.view; render(); };
  });
  if (v === 'setup') renderSetup(a, t, buckets, rounds, files, settings, steps);
  else renderLive(a, t, buckets, rounds, files, settings, missing);
  window.scrollTo(0, scrollWas);
}

/* ================= Tournament Setup ================= */

function renderSetup(a, t, buckets, rounds, files, settings, steps) {
  const box = $('viewbody');
  box.innerHTML = `
    <div class="steps">
      ${steps.map(([key, label, done, detail]) => `
      <span class="step ${done ? 'done' : ''}" data-step="${key}">
        <span class="mark">${done ? '&#10003;' : '&#9675;'}</span>
        ${label} <span class="muted">${esc(detail)}</span>
      </span>`).join('')}
    </div>
    <div class="tabs">
      ${[['rooms', 'Rooms'], ['packets', 'Packets + Tiebreakers'],
        ['roster', 'Roster'], ['sched', 'Schedule']].map(([key, label]) => `
      <button class="tab ${setupTab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <div id="setupsec"></div>`;
  box.querySelectorAll('.step').forEach((s) => {
    s.onclick = () => { setupTab = s.dataset.step; render(); };
  });
  box.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { setupTab = b.dataset.tab; render(); };
  });
  if (setupTab === 'rooms') renderRoomsSec(a, t, buckets, files);
  else if (setupTab === 'packets') renderPacketsSec(a, t, buckets, rounds, settings);
  else if (setupTab === 'roster') renderRosterSec(a, t);
  else renderScheduleSec(a, t, buckets, files);
}

/* ---------- Rooms: create N at once, rename inline ---------- */

function nextRoomNumber(buckets) {
  let n = 0;
  for (const b of buckets) {
    const m = /^Room (\d+)$/.exec(b.room_name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return Math.max(n, buckets.length) + 1;
}

function renderRoomsSec(a, t, buckets, files) {
  const box = $('setupsec');
  const next = nextRoomNumber(buckets);
  box.innerHTML = `
    <h2>Rooms</h2>
    ${buckets.length ? `<div class="tablewrap"><table>
      <tr><th>Room</th><th>Links</th><th class="num">Files</th><th>Closes</th><th></th></tr>
      ${buckets.map((b) => {
        const closes = b.created + 48 * 3600 * 1000;
        const open = Date.now() < closes;
        return `<tr>
          <td><input data-roomrename="${b.id}" value="${esc(b.room_name)}" size="16"></td>
          <td><a href="${esc(readLink(b.secret))}" target="_blank">Reader</a>
            <button class="small" onclick="qtd.copy('${esc(readLink(b.secret))}', '${esc(b.room_name)} reader link')">Copy</button>
            &nbsp;<a href="${esc(bucketLink(b.secret))}" target="_blank">Bucket</a>
            <button class="small" onclick="qtd.copy('${esc(bucketLink(b.secret))}', '${esc(b.room_name)} link')">Copy</button></td>
          <td class="num">${files.filter((f) => f.bucket_id === b.id).length}</td>
          <td>${open
            ? `<span class="muted">${new Date(closes).toLocaleString()}</span>`
            : '<span class="pill">Closed</span>'}</td>
          <td><button class="small" data-delbucket="${b.id}">Remove</button></td>
        </tr>`;
      }).join('')}
    </table></div>` : '<div class="muted">No rooms yet</div>'}
    <div class="row" style="margin-top:10px">
      <label>${buckets.length ? 'Add' : 'Create'}
        <input id="roomn" type="number" min="1" max="60" value="${buckets.length ? 2 : 8}" style="width:64px">
        ${buckets.length ? 'more rooms' : 'rooms'}</label>
      <button id="mkrooms" class="primary">${buckets.length ? 'Add rooms' : 'Create rooms'}</button>
      <span class="muted">Named Room ${next}&hellip; by default — rename any of them in the table</span>
    </div>`;
  $('mkrooms').onclick = async () => {
    const n = Math.max(1, Math.min(60, Number($('roomn').value) || 0));
    try {
      for (let i = 0; i < n; i++) {
        await pub(a + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (next + i) } });
      }
      say(n + ' room' + (n === 1 ? '' : 's') + ' created');
      showDetail();
    } catch (e) { say(e.message, true); showDetail(); }
  };
  box.querySelectorAll('[data-roomrename]').forEach((inp) => {
    inp.onchange = async () => {
      const name = inp.value.trim();
      if (!name) { inp.value = ''; return; }
      try {
        await pub(a + '/buckets/' + inp.dataset.roomrename, {
          method: 'POST', json: { room_name: name } });
        say('Renamed to ' + name);
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  box.querySelectorAll('[data-delbucket]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this room? Its link stops working. Uploaded files stay.')) return;
      try {
        await pub(a + '/buckets/' + b.dataset.delbucket, { method: 'DELETE' });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
}

/* ---------- Packets + Tiebreakers ---------- */

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

function renderPacketsSec(a, t, buckets, rounds, settings) {
  const box = $('setupsec');
  const totalRounds = Math.max(Number(settings.rounds) || 1, t.current_round,
    ...rounds.map((r) => r.number));
  const slots = Array.from({ length: totalRounds }, (_, i) => i + 1);
  const tbQuestions = tbPool
    ? [...(tbPool.tossups || []).map((q) => ({ ...q, kind: 'Tossup', answer: stripTags(q.answer) })),
       ...(tbPool.bonuses || []).map((b) => ({ ...b, kind: 'Bonus',
         answer: (b.answers || []).map(stripTags).join(' / ') }))]
    : [];
  const usesFor = (id) => ((tbPool && tbPool.uses) || []).filter((u) => u && u.q === id);
  box.innerHTML = `
    <h2>Packets</h2>
    ${staged.length ? `
    <div class="row" style="margin-bottom:8px">
      ${staged.map((s, i) => `<span class="chip" draggable="true" data-chip="${i}">${esc(s.name)}${
        s.guess ? ` <span class="muted">&rarr; ${s.guess}</span>` : ''}</span>`).join('')}
      <button id="zipauto">Assign by filename</button>
      <button id="zipclear">Clear</button>
    </div>` : ''}
    <div class="chiprow">
      ${slots.map((k) => {
        const r = rounds.find((x) => x.number === k);
        return r
          ? `<a class="rchip has slot" data-round="${k}" title="${esc(r.packet_name)}"
               href="${API}${a}/file?key=${encodeURIComponent(r.packet_r2_key)}&dl=${encodeURIComponent(r.packet_name)}"
               download><span class="dot"></span>${k}</a>`
          : `<span class="rchip slot" data-round="${k}"><span class="dot"></span>${k}</span>`;
      }).join('')}
    </div>
    <div class="row" style="margin-top:10px">
      <button id="pickzip" class="primary">Upload packet zip</button>
      <button id="pickfiles">Upload packets</button>
      <input id="zipfile" type="file" accept=".zip" hidden>
      <input id="pfiles" type="file" accept=".json,.docx" multiple hidden>
      <span class="spacer" style="flex:1"></span>
      <label>Rounds <input id="numrounds" type="number" min="1" max="999" value="${totalRounds}" style="width:70px"></label>
      <button id="setrounds">Set</button>
    </div>
    <div class="muted" style="font-size:13px;margin-top:6px">
      Staged packets are dragged onto their round slots; Assign by filename places
      the obvious ones and never overwrites a round that already has a packet.</div>

    <h2>Tiebreakers</h2>
    <div class="muted" style="font-size:13px;margin-bottom:8px">
      A tiebreaker packet is split into individual questions. In every
      room&rsquo;s MODAQ, <b>Actions &rarr; Add questions&hellip;</b> lists this
      pool — the moderator checks with you which one to read and appends
      exactly that question — and each finished game reports which questions
      it read, so the log below always says which teams have heard what.</div>
    <div class="row" style="margin-bottom:8px">
      <button id="picktb" class="primary">Upload tiebreaker packet</button>
      <input id="tbfile" type="file" accept=".json" hidden>
      <span class="slotdrop" id="tbdrop">Or drop a staged .json packet chip here to split it</span>
      ${tbQuestions.length ? '<span class="spacer" style="flex:1"></span><button id="tbclear" class="small">Delete pool</button>' : ''}
    </div>
    ${tbQuestions.length ? `<div class="tablewrap"><table>
      <tr><th>Question</th><th>Kind</th><th>Answer</th><th>Status</th></tr>
      ${tbQuestions.map((q) => {
        const uses = usesFor(q.id);
        return `<tr>
          <td class="mono">${esc(q.id)}</td>
          <td>${esc(q.kind)}</td>
          <td>${esc(q.answer)} <span class="muted" style="font-size:12px">(${esc(q.from || '')})</span></td>
          <td>${uses.length
            ? uses.map((u) => `<span class="bad">Heard by</span> <b>${
                (u.teams || []).map(esc).join(' &amp; ')}</b> <span class="muted">(Round ${
                esc(String(u.round))}, ${esc(u.room || '')})</span>`).join('<br>')
            : '<span class="ok">Unused</span>'}</td>
        </tr>`;
      }).join('')}
    </table></div>` : '<div class="muted">No tiebreaker questions yet</div>'}`;

  const stageFiles = async (fileList) => {
    for (const f of fileList) {
      staged.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()),
        guess: guessRound(f.name) });
    }
    say(fileList.length + ' packet' + (fileList.length === 1 ? '' : 's') + ' staged');
    render();
  };
  $('pickzip').onclick = () => $('zipfile').click();
  $('pickfiles').onclick = () => $('pfiles').click();
  $('picktb').onclick = () => $('tbfile').click();
  $('zipfile').onchange = async () => {
    const f = $('zipfile').files[0];
    if (!f) return;
    try {
      const entries = await readZip(new Uint8Array(await f.arrayBuffer()));
      const picked = entries
        .filter((e) => /\.(json|docx)$/i.test(e.name) && !/__MACOSX|\/\./.test('/' + e.name))
        .map((e) => {
          const name = e.name.split('/').pop();
          return { name, data: e.data, guess: guessRound(name) };
        });
      if (!picked.length) { say('No .json or .docx files in the zip', true); return; }
      staged.push(...picked);
      say(picked.length + ' packets staged');
      render();
    } catch (e) { say(e.message, true); }
  };
  $('pfiles').onchange = () => {
    if ($('pfiles').files.length) stageFiles([...$('pfiles').files]);
  };
  const uploadStagedPacket = async (s, round) => {
    const type = /\.json$/i.test(s.name) ? 'application/json'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await pub(`${a}/packet?round=${round}&name=${encodeURIComponent(s.name)}`,
      { method: 'POST', body: new Blob([s.data], { type }) });
  };
  const uploadTbPacket = async (name, data) => {
    if (!/\.json$/i.test(name)) { say('Tiebreaker packets must be .json', true); return false; }
    try {
      const out = await pub(`${a}/tiebreakers?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: new Blob([data], { type: 'application/json' }) });
      say(`${name} split into ${out.added.tossups} tossups + ${out.added.bonuses} bonuses`);
      return true;
    } catch (e) { say(e.message, true); return false; }
  };
  $('tbfile').onchange = async () => {
    const f = $('tbfile').files[0];
    if (!f) return;
    if (await uploadTbPacket(f.name, await f.arrayBuffer())) showDetail();
  };
  if ($('tbclear')) {
    $('tbclear').onclick = async () => {
      if (!confirm('Delete the tiebreaker pool? The usage log goes with it.')) return;
      try {
        await pub(a + '/tiebreakers', { method: 'DELETE' });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  }
  if ($('zipauto')) {
    $('zipauto').onclick = async () => {
      const remaining = [];
      let placed = 0;
      for (const s of staged) {
        // never overwrite silently — a colliding guess stays staged to drag
        const occupied = rounds.some((r) => r.number === s.guess);
        if (!s.guess || s.guess > totalRounds || occupied) { remaining.push(s); continue; }
        try { await uploadStagedPacket(s, s.guess); placed++; }
        catch (e) { say(s.name + ': ' + e.message, true); remaining.push(s); }
      }
      staged = remaining;
      say(placed + ' assigned, ' + remaining.length + ' left to drag');
      showDetail();
    };
    $('zipclear').onclick = () => { staged = []; render(); };
    box.querySelectorAll('[data-chip]').forEach((c) => {
      c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.chip);
    });
  }
  box.querySelectorAll('.slot').forEach((slot) => {
    slot.ondragover = (e) => { e.preventDefault(); slot.classList.add('dragover'); };
    slot.ondragleave = () => slot.classList.remove('dragover');
    slot.ondrop = async (e) => {
      e.preventDefault();
      slot.classList.remove('dragover');
      const s = staged[Number(e.dataTransfer.getData('text/plain'))];
      if (!s) return;
      try {
        await uploadStagedPacket(s, Number(slot.dataset.round));
        staged.splice(staged.indexOf(s), 1);
        showDetail();
      } catch (err) { say(err.message, true); }
    };
  });
  const tbdrop = $('tbdrop');
  tbdrop.ondragover = (e) => { e.preventDefault(); tbdrop.classList.add('dragover'); };
  tbdrop.ondragleave = () => tbdrop.classList.remove('dragover');
  tbdrop.ondrop = async (e) => {
    e.preventDefault();
    tbdrop.classList.remove('dragover');
    const s = staged[Number(e.dataTransfer.getData('text/plain'))];
    if (!s) return;
    if (await uploadTbPacket(s.name, s.data)) {
      staged.splice(staged.indexOf(s), 1);
      showDetail();
    }
  };
  $('setrounds').onclick = async () => {
    const n = Number($('numrounds').value);
    if (!Number.isInteger(n) || n < 1 || n > 999) { say('Rounds must be 1-999', true); return; }
    try {
      const next = { ...settings, rounds: n };
      await pub(a, { method: 'POST', json: { settings: next } });
      showDetail();
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- Roster: structured editor, seed order ---------- */

function rosterProblems() {
  const problems = [];
  const seen = new Set();
  (rosterTeams || []).forEach((tm, i) => {
    const name = tm.name.trim();
    if (!name) problems.push('Team ' + (i + 1) + ' has no name');
    else if (seen.has(name)) problems.push('Duplicate team: ' + name);
    seen.add(name);
    if (!tm.players.some((p) => p.trim())) {
      problems.push((name || 'Team ' + (i + 1)) + ' has no players');
    }
  });
  return problems;
}
function cleanRosterTeams() {
  return rosterTeams.map((tm) => ({ name: tm.name.trim(),
    players: tm.players.map((p) => p.trim()).filter(Boolean) }));
}

function renderRosterSec(a, t) {
  const box = $('setupsec');
  box.innerHTML = `
    <h2>Roster</h2>
    <div class="row">
      ${t.roster_name
        ? `<span>${esc(t.roster_name)}</span>
           <a href="${API}${a}/file?key=${encodeURIComponent(t.roster_r2_key)}&dl=${encodeURIComponent(t.roster_name)}" download>Download</a>`
        : '<span class="muted">None yet</span>'}
      <span class="spacer" style="flex:1"></span>
      <button id="pickroster">Upload roster QBJ</button>
      <input id="rfile" type="file" accept=".qbj,.json" hidden>
      <button id="editroster">${t.roster_name ? 'Edit roster' : 'Create roster'}</button>
    </div>
    <div id="upreview"></div>
    <div id="rosteredit" style="margin-top:12px"></div>`;
  $('pickroster').onclick = () => $('rfile').click();
  $('rfile').onchange = async () => {
    const f = $('rfile').files[0];
    if (!f) return;
    let text;
    let parsed;
    try {
      text = await f.text();
      parsed = parseRoster(JSON.parse(text)); // fail before uploading junk
    } catch (e) { say('Roster: ' + e.message, true); return; }
    rosterUpload = { filename: f.name, text, teams: parsed };
    renderUpPreview(a);
  };
  $('editroster').onclick = async () => {
    rosterOpen = !rosterOpen;
    if (rosterOpen && rosterTeams === null) {
      if (t.roster_r2_key) {
        try {
          rosterTeams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key))
            .map((tm) => ({ name: tm.name, players: [...tm.players] }));
        } catch (e) { /* unparseable upload: start blank */ }
      }
      if (rosterTeams === null) rosterTeams = [{ name: '', players: ['', '', '', ''] }];
    }
    renderRosterEditor(a, t);
  };
  renderUpPreview(a);
  renderRosterEditor(a, t);
}

function renderUpPreview(a) {
  const box = $('upreview');
  if (!box) return;
  if (!rosterUpload) { box.innerHTML = ''; return; }
  const u = rosterUpload;
  box.innerHTML = `
    <div class="card" style="margin-top:8px">
      <div class="row">
        <b>${esc(u.filename)}</b>
        <span class="pill">${u.teams.length} teams &middot; ${
          u.teams.reduce((n, tm) => n + tm.players.length, 0)} players</span>
        <span class="spacer" style="flex:1"></span>
        <button id="upconfirm" class="primary">Save as tournament roster</button>
        <button id="upcancel">Cancel</button>
      </div>
      <div class="muted" style="font-size:13px;margin-top:4px">${
        u.teams.slice(0, 4).map((tm) => esc(tm.name)).join(' &middot; ')}${
        u.teams.length > 4 ? ' &hellip;' : ''}</div>
    </div>`;
  $('upconfirm').onclick = async () => {
    try {
      await pub(`${a}/roster?name=${encodeURIComponent(u.filename)}`,
        { method: 'POST', body: u.text });
      rosterUpload = null;
      rosterTeams = null;   // editor reloads from the new roster
      schedFetched = false; // schedule editor re-reads the team list
      say('Roster saved');
      showDetail();
    } catch (e) { say('Roster: ' + e.message, true); }
  };
  $('upcancel').onclick = () => { rosterUpload = null; renderUpPreview(a); };
}

function renderRosterEditor(a, t) {
  const box = $('rosteredit');
  if (!box) return;
  if (!rosterOpen || rosterTeams === null) { box.innerHTML = ''; return; }
  const nPlayers = rosterTeams.reduce((n, tm) => n + tm.players.filter((p) => p.trim()).length, 0);
  const problems = rosterProblems();
  box.innerHTML = `
    ${rosterTeams.map((tm, ti) => `
    <div class="card">
      <div class="row">
        <span class="seedmove">
          <button class="xbtn" data-seedup="${ti}" tabindex="-1"
            title="Move up (stronger seed)" ${ti === 0 ? 'disabled' : ''}>&#9650;</button>
          <button class="xbtn" data-seeddown="${ti}" tabindex="-1"
            title="Move down (weaker seed)" ${ti === rosterTeams.length - 1 ? 'disabled' : ''}>&#9660;</button>
        </span>
        <span class="pill" title="Roster order is seed order">Seed ${ti + 1}</span>
        <input data-tname="${ti}" value="${esc(tm.name)}" placeholder="Team name" size="24">
        <span class="muted" data-tcount="${ti}">${tm.players.filter((p) => p.trim()).length} players</span>
        <span class="spacer" style="flex:1"></span>
        <button class="small" data-delteam="${ti}" tabindex="-1">Remove team</button>
      </div>
      ${tm.players.map((p, pi) => `
      <div class="playerline">
        <input data-pname="${ti}.${pi}" value="${esc(p)}" placeholder="Player name">
        <button class="xbtn" data-delplayer="${ti}.${pi}" title="Remove player" tabindex="-1">&times;</button>
      </div>`).join('')}
      <div class="row" style="margin-top:4px">
        <button class="small" data-addplayer="${ti}" tabindex="-1">+ Player</button>
      </div>
    </div>`).join('')}
    <div class="row" style="margin-top:8px">
      <button id="addteam">+ Team</button>
      <span class="muted" id="rostercount">${rosterTeams.length} teams &middot; ${nPlayers} players</span>
      <span class="muted">&middot; Card order is seed order (drives pool assignments)</span>
    </div>
    <div class="bad" id="rosterproblems" style="margin-top:6px">${problems.map(esc).join(' &middot; ')}</div>
    <div class="row" style="margin-top:8px">
      <button id="rosterdl">Download roster QBJ</button>
      <button id="rostersave" class="primary">Save as tournament roster</button>
    </div>`;

  const rerender = () => renderRosterEditor(a, t);
  // Typing never re-renders — a re-render would eat the focus mid-entry.
  // State, the counters, and the problem line update in place instead.
  const refreshMeta = () => {
    rosterTeams.forEach((tm, ti) => {
      const el = box.querySelector(`[data-tcount="${ti}"]`);
      if (el) el.textContent = tm.players.filter((p) => p.trim()).length + ' players';
    });
    const total = rosterTeams.reduce((n, tm) => n + tm.players.filter((p) => p.trim()).length, 0);
    $('rostercount').textContent = rosterTeams.length + ' teams · ' + total + ' players';
    $('rosterproblems').textContent = rosterProblems().join(' · ');
  };
  box.querySelectorAll('[data-tname]').forEach((inp) => {
    inp.oninput = () => {
      rosterTeams[Number(inp.dataset.tname)].name = inp.value;
      refreshMeta();
    };
  });
  box.querySelectorAll('[data-pname]').forEach((inp) => {
    const [ti, pi] = inp.dataset.pname.split('.').map(Number);
    inp.oninput = () => { rosterTeams[ti].players[pi] = inp.value; refreshMeta(); };
    // Tab or Enter on the last field grows the list — hands stay on the keyboard
    inp.onkeydown = (ev) => {
      const last = pi === rosterTeams[ti].players.length - 1;
      if (ev.key === 'Enter' || (ev.key === 'Tab' && !ev.shiftKey && last && inp.value.trim())) {
        ev.preventDefault();
        rosterTeams[ti].players[pi] = inp.value;
        if (last) rosterTeams[ti].players.push('');
        rerender();
        const nxt = box.querySelector(`[data-pname="${ti}.${pi + 1}"]`);
        if (nxt) nxt.focus();
      }
    };
  });
  box.querySelectorAll('[data-delteam]').forEach((b) => {
    b.onclick = () => { rosterTeams.splice(Number(b.dataset.delteam), 1); rerender(); };
  });
  box.querySelectorAll('[data-delplayer]').forEach((b) => {
    b.onclick = () => {
      const [ti, pi] = b.dataset.delplayer.split('.').map(Number);
      rosterTeams[ti].players.splice(pi, 1);
      rerender();
    };
  });
  box.querySelectorAll('[data-addplayer]').forEach((b) => {
    b.onclick = () => {
      const ti = Number(b.dataset.addplayer);
      rosterTeams[ti].players.push('');
      rerender();
      const inp = box.querySelector(`[data-pname="${ti}.${rosterTeams[ti].players.length - 1}"]`);
      if (inp) inp.focus();
    };
  });
  box.querySelectorAll('[data-seedup]').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.seedup);
      if (i > 0) {
        [rosterTeams[i - 1], rosterTeams[i]] = [rosterTeams[i], rosterTeams[i - 1]];
        say((rosterTeams[i - 1].name || 'Team') + ' is now Seed ' + i);
        rerender();
      }
    };
  });
  box.querySelectorAll('[data-seeddown]').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.seeddown);
      if (i < rosterTeams.length - 1) {
        [rosterTeams[i], rosterTeams[i + 1]] = [rosterTeams[i + 1], rosterTeams[i]];
        say((rosterTeams[i + 1].name || 'Team') + ' is now Seed ' + (i + 2));
        rerender();
      }
    };
  });
  $('addteam').onclick = () => {
    rosterTeams.push({ name: '', players: ['', '', '', ''] });
    rerender();
  };
  const validated = () => {
    const problemsNow = rosterProblems();
    if (problemsNow.length || !rosterTeams.length) {
      $('rosterproblems').textContent = problemsNow.join(' · ') || 'No teams yet';
      say('Fix the roster first', true);
      return null;
    }
    return cleanRosterTeams();
  };
  $('rosterdl').onclick = () => {
    const clean = validated();
    if (!clean) return;
    download('roster.qbj', JSON.stringify(buildRosterQbj(t.name, clean), null, 2),
      'application/json');
  };
  $('rostersave').onclick = async () => {
    const clean = validated();
    if (!clean) return;
    try {
      await pub(`${a}/roster?name=roster.qbj`,
        { method: 'POST', body: JSON.stringify(buildRosterQbj(t.name, clean), null, 2) });
      rosterTeams = clean.map((tm) => ({ name: tm.name, players: [...tm.players] }));
      rosterOpen = false;
      schedFetched = false; // schedule editor re-reads the team list
      say('Roster saved');
      showDetail();
    } catch (e) { say('Roster: ' + e.message, true); }
  };
}

/* ---------- Schedule ----------
   The working copy lives in module state: edits are local until Save
   (POST /a/:secret/schedule). Blob fetched once per page load through
   the admin file route; roster changes invalidate the team cache. */

let sched = null;          // working schedule (or null: creator shown)
let schedFetched = false;
let schedTeams = null;     // roster team names, seed order
let slotEditRef = null;    // slot being edited via inline dropdown
let gameSel = null;        // selected cell {p, r, room} for a match swap
let schedDirty = false;
let schedRoomsOpen = false;
let schedRoomsN = null;    // creator rooms input

// Fetch-once per page load (or per roster change): the roster team list
// and the saved schedule. render() needs it too — the status strip and
// upload groups read the working schedule.
async function ensureSched(a, t) {
  if (schedFetched || !t.roster_r2_key) return;
  schedFetched = true;
  try { schedTeams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)).map((x) => x.name); }
  catch (e) { schedTeams = []; }
  try { sched = await fetchOwnedJson(a, `t/${t.id}/schedule.json`); }
  catch (e) { sched = null; }
}

// Slot refs are room-keyed ({p, r, room, side} / {p, r, bye}) so empty
// cells are addressable; a write creates the game on demand.
function refKey(ref) {
  return ref.bye !== undefined ? `${ref.p}.${ref.r}.b${ref.bye}` : `${ref.p}.${ref.r}.${ref.room}.${ref.side}`;
}
function gameIn(round, room) { return round.games.find((g) => g.room === room) || null; }
function slotValue(ref) {
  const round = sched.phases[ref.p].rounds[ref.r];
  if (ref.bye !== undefined) return round.byes[ref.bye] ?? null;
  const g = gameIn(round, ref.room);
  return g ? g[ref.side] : null;
}
function setSlotValue(ref, v) {
  const round = sched.phases[ref.p].rounds[ref.r];
  if (ref.bye !== undefined) {
    if (v === null) round.byes.splice(ref.bye, 1);
    else round.byes[ref.bye] = v;
    return;
  }
  let g = gameIn(round, ref.room);
  if (!g) {
    g = { room: ref.room, a: null, b: null };
    round.games.push(g);
    round.games.sort((x, y) => x.room - y.room);
  }
  g[ref.side] = v;
}
function swapSlotValues(r1, r2) {
  const v1 = slotValue(r1);
  const v2 = slotValue(r2);
  // set game slots before bye splices so bye indexes stay valid
  const order = [[r1, v2], [r2, v1]].sort((x) => (x[0].bye !== undefined ? 1 : -1));
  for (const [ref, v] of order) setSlotValue(ref, v);
}

function renderScheduleSec(a, t, buckets, files) {
  const outer = $('setupsec');
  outer.innerHTML = '<h2>Schedule</h2><div id="schedsec"></div>';
  renderSchedule(a, t, buckets, files);
}

function renderSchedule(a, t, buckets, files) {
  const box = $('schedsec');
  if (!box) return;
  if (!t.roster_r2_key) {
    box.innerHTML = '<div class="muted">Needs a roster first — create one on the Roster tab</div>';
    return;
  }
  const rerender = () => renderSchedule(a, t, buckets, files);
  const touch = () => { schedDirty = true; rerender(); };

  /* -- creator -- */
  if (!sched) {
    if (schedRoomsN === null) schedRoomsN = Math.max(1, buckets.length);
    const fmts = formatsFor(schedTeams.length, schedRoomsN);
    box.innerHTML = `
      <div class="row" style="margin-bottom:8px">
        <span class="muted">${schedTeams.length} teams (roster order is seed order)</span>
        <label class="muted">Rooms <input id="schedrooms" type="number" min="1" max="60" value="${schedRoomsN}" style="width:64px"></label>
      </div>
      ${fmts.map((f, i) => `
      <div class="card"><label class="row"><input type="radio" name="schedfmt" value="${f.key}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(f.name)}</b> <span class="muted">&mdash; ${esc(f.desc)}</span></span></label></div>`).join('')
      || '<div class="muted">No format fits</div>'}
      ${fmts.length ? '<div class="row"><button id="schedgen" class="primary">Generate</button></div>' : ''}`;
    $('schedrooms').onchange = () => {
      schedRoomsN = Math.max(1, Number($('schedrooms').value) || 1);
      rerender();
    };
    if ($('schedgen')) $('schedgen').onclick = async () => {
      const key = box.querySelector('input[name="schedfmt"]:checked').value;
      const rooms = [];
      for (let i = 0; i < schedRoomsN; i++) {
        rooms.push(buckets[i] ? { name: buckets[i].room_name, bucket: buckets[i].id }
          : { name: 'Room ' + (i + 1), bucket: null });
      }
      try {
        sched = buildSchedule(key, schedTeams, rooms);
        sched.format = key;
        slotEditRef = null;
        gameSel = null;
      } catch (e) { say(e.message, true); return; }
      // a generated schedule goes live right away — Save is only for
      // edits made after
      try {
        await pub(a + '/schedule', { method: 'POST', json: sched });
        schedDirty = false;
        say('Schedule saved');
      } catch (e) {
        schedDirty = true;
        say('Not saved: ' + e.message, true);
      }
      render();
      return;
    };
    return;
  }

  /* -- editor -- */
  const warnings = validateSchedule(sched, schedTeams);
  const normName = (x) => String(x || '').trim().toLowerCase();
  for (const b of buckets) {
    if (!sched.rooms.some((r) => r.bucket === b.id || normName(r.name) === normName(b.room_name))) {
      warnings.push('Room not on schedule: ' + b.room_name);
    }
  }
  // Inline dropdown options: teams still free in the slot's round.
  const availFor = (p, r, current) => {
    const inRound = new Set();
    const round = sched.phases[p].rounds[r];
    for (const g of round.games) {
      if (g.a) inRound.add(slotText(g.a));
      if (g.b) inRound.add(slotText(g.b));
    }
    for (const s of round.byes) if (s) inRound.add(slotText(s));
    return schedTeams.filter((n) => !inRound.has(n) || n === current);
  };
  const chip = (ref, slot) => {
    const text = slot ? slotText(slot) : '';
    if (slotEditRef && refKey(slotEditRef) === refKey(ref)) {
      const avail = availFor(ref.p, ref.r, text);
      return `<select class="slotsel" data-slotsel='${esc(JSON.stringify(ref))}'>
        <option value="__keep" selected hidden>${text ? esc(text) : '&mdash;'}</option>
        ${avail.filter((n) => n !== text).map((n) => `<option>${esc(n)}</option>`).join('')}
        ${slot ? '<option value="__clear">— Clear slot</option>' : ''}
      </select>`;
    }
    const cls = 'slotchip' + (slot && slot.label ? ' ph' : '') + (slot ? '' : ' empty');
    return `<span class="${cls}" draggable="${slot ? 'true' : 'false'}"
      data-ref='${esc(JSON.stringify(ref))}'>${text ? esc(text) : '&mdash;'}</span>`;
  };
  const selGame = gameSel ? gameIn(sched.phases[gameSel.p].rounds[gameSel.r], gameSel.room) : null;
  const canFill = sched.pools && hasPlaceholders(sched);
  box.innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <button id="schedaddround">+ Round</button>
      <button id="schedaddroom">+ Room</button>
      <button id="schedroomsbtn">Rooms</button>
      ${canFill ? '<button id="schedfill">Fill playoff slots from standings</button>' : ''}
      <button id="schedregen">Regenerate</button>
      <button id="scheddel" style="color:var(--bad)">Delete</button>
      <span class="spacer" style="flex:1"></span>
      ${schedDirty ? '<span class="pill warn">Unsaved</span>' : ''}
      <button id="schedsave" class="primary" ${schedDirty ? '' : 'disabled'}>Save</button>
    </div>
    ${warnings.length ? `<div class="bad">${warnings.map(esc).join(' &middot; ')}</div>` : ''}
    ${gameSel ? `
    <div class="row" style="margin:6px 0">
      <span>Swapping <b>${esc(selGame ? (slotText(selGame.a) || '—') + ' v ' + (slotText(selGame.b) || '—') : 'empty cell')}</b>
        &mdash; click another cell to trade places</span>
      <button id="gunsel" class="small">Cancel</button>
    </div>` : ''}
    <div id="schedroomspanel" ${schedRoomsOpen ? '' : 'hidden'} class="card" style="margin:6px 0">
      ${sched.rooms.map((r, i) => `
      <div class="row" style="margin:2px 0">
        <input data-roomname="${i}" value="${esc(r.name)}" size="18">
        <select data-roombucket="${i}">
          <option value=""></option>
          ${buckets.map((b) => `<option value="${b.id}" ${b.id === r.bucket ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}
        </select>
      </div>`).join('')}
      <div class="muted" style="font-size:12px;margin-top:4px">Linked room readers preselect their scheduled teams</div>
    </div>
    ${sched.phases.map((phase, p) => {
      const hasByes = phase.rounds.some((r) => r.byes.length);
      return `
      <div class="rhead">${esc(phase.name)}</div>
      <div class="tablewrap">
      <table class="sched">
        <tr><th></th>${sched.rooms.map((r, i) => `<th>${esc(r.name)}
          <button class="xbtn colx" data-delcol="${i}" title="Remove room (its teams drop to the bye column)">&times;</button></th>`).join('')}
          <th>Bye</th></tr>
        ${phase.rounds.map((round, r) => `
        <tr>
          <td class="roundcell">${round.round}
            <span class="rowtools">
              <button class="xbtn" data-insround="${p}.${r}" title="Insert round after">+</button>
              <button class="xbtn" data-delround="${p}.${r}" title="Delete this round">&times;</button>
            </span>
          </td>
          ${sched.rooms.map((_, roomI) => {
            const g = gameIn(round, roomI);
            const sel = gameSel && gameSel.p === p && gameSel.r === r && gameSel.room === roomI;
            return `<td><div class="gamebox${sel ? ' sel' : ''}" draggable="true"
              data-cell='${esc(JSON.stringify({ p, r, room: roomI }))}'>
              <div>
                <div>${chip({ p, r, room: roomI, side: 'a' }, g ? g.a : null)}</div>
                <div>${chip({ p, r, room: roomI, side: 'b' }, g ? g.b : null)}</div>
              </div>
              <span class="ghandle" data-ghandle='${esc(JSON.stringify({ p, r, room: roomI }))}'
                title="${sel ? 'Cancel' : 'Swap this match with another cell'}">&#8646;</span>
            </div></td>`;
          }).join('')}
          <td class="byetray" data-byetray="${p}.${r}">${
            round.byes.map((s, bi) => chip({ p, r, bye: bi }, s)).join('<br>')}</td>
        </tr>`).join('')}
      </table>
      </div>`;
    }).join('')}
    <div class="muted" style="font-size:13px;margin-top:8px">
      Click a slot for the team dropdown &middot; drag chips to swap teams &middot;
      drag a match box (or use &#8646;) to swap matches between cells &middot;
      hover a round number to insert or delete rounds &middot; drop a chip on the
      Bye column to bench a team</div>`;

  const parseRef = (s) => JSON.parse(s);
  const cellOf = (ref) => ({ p: ref.p, r: ref.r, room: ref.room });

  // team chips: click opens the dropdown (or completes a match swap); drag swaps
  box.querySelectorAll('.slotchip').forEach((c) => {
    const ref = parseRef(c.dataset.ref);
    c.onclick = (ev) => {
      ev.stopPropagation();
      if (gameSel) {
        if (ref.bye !== undefined) { gameSel = null; rerender(); return; }
        swapCells(sched, gameSel, cellOf(ref));
        gameSel = null;
        touch();
        return;
      }
      slotEditRef = ref;
      rerender();
      const sel = box.querySelector('select.slotsel');
      if (sel) sel.focus();
    };
    c.ondragstart = (ev) => {
      ev.stopPropagation(); // the chip's team swap wins over the box's match swap
      ev.dataTransfer.setData('text/plain', JSON.stringify({ slot: ref }));
    };
    c.ondragover = (ev) => { ev.preventDefault(); c.classList.add('dragover'); };
    c.ondragleave = () => c.classList.remove('dragover');
    c.ondrop = (ev) => {
      ev.preventDefault();
      const payload = JSON.parse(ev.dataTransfer.getData('text/plain') || 'null');
      if (!payload || !payload.slot || refKey(payload.slot) === refKey(ref)) return;
      ev.stopPropagation();
      swapSlotValues(payload.slot, ref);
      slotEditRef = null;
      touch();
    };
  });
  box.querySelectorAll('select.slotsel').forEach((sel) => {
    const ref = parseRef(sel.dataset.slotsel);
    sel.onchange = () => {
      const vv = sel.value;
      if (vv !== '__keep') setSlotValue(ref, vv === '__clear' ? null : { team: vv });
      slotEditRef = null;
      touch();
    };
    sel.onblur = () => {
      if (slotEditRef && refKey(slotEditRef) === refKey(ref)) { slotEditRef = null; rerender(); }
    };
  });
  // match boxes and their handles: click-click or drag to swap whole matches
  box.querySelectorAll('[data-ghandle]').forEach((h) => {
    const cell = parseRef(h.dataset.ghandle);
    h.onclick = (ev) => {
      ev.stopPropagation();
      if (gameSel && gameSel.p === cell.p && gameSel.r === cell.r && gameSel.room === cell.room) {
        gameSel = null;
        rerender();
        return;
      }
      if (gameSel) {
        swapCells(sched, gameSel, cell);
        gameSel = null;
        touch();
        return;
      }
      gameSel = cell;
      slotEditRef = null;
      rerender();
    };
    h.ondragstart = (ev) => {
      ev.stopPropagation();
      ev.dataTransfer.setData('text/plain', JSON.stringify({ cell }));
    };
  });
  box.querySelectorAll('[data-cell]').forEach((el) => {
    const cell = parseRef(el.dataset.cell);
    el.onclick = () => {
      if (!gameSel) return;
      if (gameSel.p === cell.p && gameSel.r === cell.r && gameSel.room === cell.room) {
        gameSel = null;
        rerender();
        return;
      }
      swapCells(sched, gameSel, cell);
      gameSel = null;
      touch();
    };
    el.ondragstart = (ev) =>
      ev.dataTransfer.setData('text/plain', JSON.stringify({ cell }));
    el.ondragover = (ev) => ev.preventDefault();
    el.ondrop = (ev) => {
      const payload = JSON.parse(ev.dataTransfer.getData('text/plain') || 'null');
      if (!payload || !payload.cell) return;
      ev.preventDefault();
      ev.stopPropagation();
      const c2 = payload.cell;
      if (c2.p === cell.p && c2.r === cell.r && c2.room === cell.room) return;
      swapCells(sched, c2, cell);
      gameSel = null;
      touch();
    };
  });
  box.querySelectorAll('[data-byetray]').forEach((tray) => {
    tray.ondragover = (ev) => { ev.preventDefault(); tray.classList.add('dragover'); };
    tray.ondragleave = () => tray.classList.remove('dragover');
    tray.ondrop = (ev) => {
      ev.preventDefault();
      tray.classList.remove('dragover');
      const payload = JSON.parse(ev.dataTransfer.getData('text/plain') || 'null');
      if (!payload || !payload.slot) return;
      const [p, r] = tray.dataset.byetray.split('.').map(Number);
      const v = slotValue(payload.slot);
      if (v === null) return;
      setSlotValue(payload.slot, null);
      sched.phases[p].rounds[r].byes.push(v);
      slotEditRef = null;
      touch();
    };
  });
  box.querySelectorAll('[data-insround]').forEach((b) => {
    b.onclick = () => {
      const [p, r] = b.dataset.insround.split('.').map(Number);
      insertRound(sched, p, r);
      slotEditRef = null;
      gameSel = null;
      touch();
    };
  });
  box.querySelectorAll('[data-delround]').forEach((b) => {
    b.onclick = () => {
      const [p, r] = b.dataset.delround.split('.').map(Number);
      const round = sched.phases[p].rounds[r];
      const filled = round.games.some((g) => g.a || g.b) || round.byes.length;
      if (filled && !confirm('Delete Round ' + round.round + '?')) return;
      removeRound(sched, p, r);
      if (!sched.phases[p].rounds.length && sched.phases.length > 1) sched.phases.splice(p, 1);
      slotEditRef = null;
      gameSel = null;
      touch();
    };
  });
  box.querySelectorAll('[data-delcol]').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.delcol);
      const filled = sched.phases.some((ph) => ph.rounds.some((round) => {
        const g = gameIn(round, i);
        return g && (g.a || g.b);
      }));
      if (filled && !confirm('Remove ' + sched.rooms[i].name + '? Its teams drop to the Bye column.')) return;
      removeRoomCol(sched, i);
      slotEditRef = null;
      gameSel = null;
      touch();
    };
  });
  $('schedaddround').onclick = () => { addRound(sched, sched.phases.length - 1); touch(); };
  $('schedaddroom').onclick = () => {
    addRoomCol(sched, 'Room ' + (sched.rooms.length + 1));
    touch();
  };
  $('schedroomsbtn').onclick = () => { schedRoomsOpen = !schedRoomsOpen; rerender(); };
  box.querySelectorAll('[data-roomname]').forEach((inp) => {
    inp.onchange = () => {
      sched.rooms[Number(inp.dataset.roomname)].name = inp.value.trim() || inp.value;
      touch();
    };
  });
  box.querySelectorAll('[data-roombucket]').forEach((sel) => {
    sel.onchange = () => {
      sched.rooms[Number(sel.dataset.roombucket)].bucket = sel.value ? Number(sel.value) : null;
      touch();
    };
  });
  if ($('gunsel')) $('gunsel').onclick = () => { gameSel = null; rerender(); };
  if ($('schedfill')) {
    $('schedfill').onclick = async () => {
      say('Computing standings…');
      try {
        const { matches, roster } = await collectMatches(a, t, buckets, files);
        if (!matches.length) { say('No game files uploaded yet — nothing to rank', true); return; }
        const ranked = aggregate(matches, roster).teams.map((x) => x.name);
        const filled = fillPlaceholders(sched, poolStandings(sched.pools, ranked));
        say(filled + ' playoff slots filled from standings — check the grid, then Save');
        touch();
      } catch (e) { say(e.message, true); }
    };
  }
  $('schedsave').onclick = async () => {
    try {
      // fill missing/stale room->bucket links by name so reader rooms
      // resolve their schedule line without hand-linking
      const norm = (x) => String(x || '').trim().toLowerCase();
      for (const room of sched.rooms) {
        if (room.bucket !== null && buckets.some((b) => b.id === room.bucket)) continue;
        const hit = buckets.find((b) => norm(b.room_name) === norm(room.name)
          && !sched.rooms.some((r2) => r2.bucket === b.id));
        room.bucket = hit ? hit.id : null;
      }
      await pub(a + '/schedule', { method: 'POST', json: sched });
      schedDirty = false;
      say('Schedule saved');
      rerender();
    } catch (e) { say(e.message, true); }
  };
  $('schedregen').onclick = () => {
    if (!confirm('Start over? Unsaved edits are lost; the saved schedule stays until you save a new one.')) return;
    sched = null;
    slotEditRef = null;
    gameSel = null;
    rerender();
  };
  $('scheddel').onclick = async () => {
    if (!confirm('Delete the schedule?')) return;
    try {
      await pub(a + '/schedule', { method: 'DELETE' });
      sched = null;
      schedDirty = false;
      slotEditRef = null;
      gameSel = null;
      say('Schedule deleted');
      render();
    } catch (e) { say(e.message, true); }
  };
}

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (slotEditRef || gameSel) {
    slotEditRef = null;
    gameSel = null;
    render();
  }
});

/* ================= Live Hub ================= */

function renderLive(a, t, buckets, rounds, files, settings, missing) {
  const box = $('viewbody');
  const fmt = effectiveFormat(settings); // prefills the customize panel
  // expired broadcasts are simply dropped: the next write prunes them for good
  let live = [];
  try { live = annLive(JSON.parse(t.announce || '[]')); } catch (e) { /* keep [] */ }
  const totalRounds = Math.max(Number(settings.rounds) || 1, t.current_round,
    ...rounds.map((r) => r.number));
  const intake = roundIntake(sched, t.current_round, buckets, files);
  const uploadRounds = [...new Set([
    ...Array.from({ length: t.current_round }, (_, i) => i + 1),
    ...files.map((f) => f.round).filter((n) => Number.isInteger(n) && n > 0),
  ])].sort((x, y) => y - x);
  const openAnn = annOpen === null ? !!live.length : annOpen;
  const tbUsed = tbPool
    ? [...(tbPool.tossups || []), ...(tbPool.bonuses || [])]
        .filter((q) => (tbPool.uses || []).some((u) => u && u.q === q.id)).length
    : 0;
  const tbTotal = tbPool ? (tbPool.tossups || []).length + (tbPool.bonuses || []).length : 0;

  box.innerHTML = `
    ${missing.length ? `
    <div class="banner">
      <span class="bad" style="font-weight:600">Tournament setup incomplete</span>
      <span class="muted">Still to do: ${missing.map(esc).join(', ')}</span>
      <span class="spacer" style="flex:1"></span>
      <button id="gosetup" class="primary">Open Tournament Setup</button>
    </div>` : ''}
    <div class="statusbar">
      <span><span class="muted">Round</span> <span class="big">${t.current_round}</span> <span class="muted">of ${totalRounds}</span></span>
      ${rounds.length ? (rounds.some((r) => r.number === t.current_round)
        ? '<span class="ok">Packet up</span>' : '<span class="bad">No packet</span>') : ''}
      ${intake.expected ? `<span><span class="${intake.got >= intake.expected ? 'ok' : 'bad'}">${intake.got}</span><span class="muted">/${intake.expected} games in</span></span>` : ''}
      ${intake.missing.length ? `<span class="muted">Waiting: ${esc(intake.missing.join(', '))}</span>` : ''}
      ${tbTotal ? `<span class="pill ${tbUsed ? 'warn' : ''}">Tiebreakers: ${tbUsed} used &middot; ${tbTotal - tbUsed} unused</span>` : ''}
      <span class="spacer" style="flex:1"></span>
      <label>Round <input id="curround" type="number" min="1" max="999" value="${t.current_round}" style="width:70px"></label>
      <button id="setround">Set</button>
      ${t.current_round < totalRounds
        ? `<button id="advround" class="primary">Advance to Round ${t.current_round + 1}</button>` : ''}
    </div>
    <details class="drawer" id="anndrawer" ${openAnn ? 'open' : ''}>
      <summary><span class="dtitle">Broadcasts</span>
        <span class="muted">${live.length
          ? `${live.length} live &middot; ${esc(live[0].text)}`
          : 'Nothing live'}</span>
      </summary>
      <div class="inner">
        <div class="row" style="margin-top:8px">
          <input id="anntext" maxlength="200" style="flex:1;min-width:240px"
            placeholder="A line for the rooms or the public page"
            value="${esc(annForm.text)}">
          <span class="muted mono" id="anncount">${annForm.text.length}/200</span>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="muted">To
            <select id="annto">
              <option value="both" ${annForm.to === 'both' ? 'selected' : ''}>Public page + rooms</option>
              <option value="pub" ${annForm.to === 'pub' ? 'selected' : ''}>Public page only</option>
              <option value="rooms" ${annForm.to === 'rooms' ? 'selected' : ''}>All rooms</option>
              <option value="some" ${annForm.to === 'some' ? 'selected' : ''}>Specific rooms&hellip;</option>
            </select>
          </label>
          <label class="muted">Expires
            <select id="annmins">${ANN_EXPIRY.map(([vv, label]) =>
              `<option value="${vv}" ${annForm.mins === vv ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label class="row"><input type="checkbox" id="annalert" ${annForm.alert ? 'checked' : ''}> Alert</label>
          <span class="spacer" style="flex:1"></span>
          ${live.length >= MAX_ANNOUNCE
            ? `<span class="muted">${MAX_ANNOUNCE} live is the maximum &mdash; remove one first</span>` : ''}
          <button id="annsend" class="primary" ${live.length >= MAX_ANNOUNCE ? 'disabled' : ''}>Send</button>
        </div>
        <div class="row" id="annrooms" ${annForm.to === 'some' ? '' : 'hidden'} style="margin-top:6px">
          ${buckets.length ? buckets.map((b) => `
            <label class="row"><input type="checkbox" data-annroom="${b.id}"
              ${annForm.rooms.includes(b.id) ? 'checked' : ''}> ${esc(b.room_name)}</label>`).join('')
            : '<span class="muted">No rooms yet</span>'}
        </div>
        <div class="row" style="margin-top:6px">
          <span class="muted" style="font-size:13px">Rooms see this within a minute; the public page within five${
            t.published ? '' : '. The public page is off, so public broadcasts stay hidden until you turn it on'}</span>
        </div>

        <h2>Live now</h2>
        ${live.length ? `<div class="tablewrap"><table>
          <tr><th>Message</th><th>To</th><th class="num">Sent</th><th class="num">Expires</th><th></th></tr>
          ${live.map((x) => `<tr>
            <td>${x.level === 'alert' ? '<span class="pill warn">Alert</span> ' : ''}${esc(x.text)}</td>
            <td>${annAudience(x, buckets, t.published)}</td>
            <td class="num">${esc(annTime(x.created))}</td>
            <td class="num">${esc(annTime(x.expires))}</td>
            <td class="num"><button class="small" data-delann="${esc(x.id)}">Remove</button></td>
          </tr>`).join('')}
        </table></div>` : '<div class="muted">Nothing live</div>'}
      </div>
    </details>

    <h2>Settings</h2>
    <div class="row" style="margin-bottom:6px">
      <label class="row"><input type="checkbox" id="pub" ${t.published ? 'checked' : ''}> Public page</label>
    </div>
    <div class="row" style="margin-bottom:6px">
      <label class="row">Reader game format
        <select id="gformat">${GAME_FORMAT_OPTIONS.map((o) =>
          `<option value="${o.value}" ${o.value === (settings.gameFormat || '') ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
      ${Object.keys(cleanOverrides(settings.formatOverrides)).length ? '<span class="pill">Custom</span>' : ''}
      <button id="fmtedit">Customize MODAQ settings</button>
    </div>
    <div id="fmtpanel" ${fmtOpen ? '' : 'hidden'} class="card" style="margin-bottom:6px">
      <div class="row">
        <label>Tossups <input id="fmttossups" type="number" min="1" max="999" value="${fmt.regulationTossupCount}" style="width:64px"></label>
        <label>Neg <input id="fmtneg" type="number" min="-100" max="0" value="${fmt.negValue}" style="width:64px"></label>
        <label>Powers <input id="fmtpowers" placeholder="(*)=15" value="${esc(powersText(fmt.powers))}" size="16"></label>
        <label>Overtime tossups <input id="fmtot" type="number" min="1" max="99" value="${fmt.minimumOvertimeQuestionCount}" style="width:56px"></label>
      </div>
      <div class="row" style="margin-top:6px">
        <label class="row"><input type="checkbox" id="fmtpaired" ${fmt.pairTossupsBonuses ? 'checked' : ''}> Paired bonuses</label>
        <label class="row"><input type="checkbox" id="fmtbounce" ${fmt.bonusesBounceBack ? 'checked' : ''}> Bouncebacks</label>
        <label class="row"><input type="checkbox" id="fmtotbonus" ${fmt.overtimeIncludesBonuses ? 'checked' : ''}> Overtime bonuses</label>
        <label>Pronunciation marks
          <input id="fmtpron1" value="${esc((fmt.pronunciationGuideMarkers || ['', ''])[0])}" size="4">
          <input id="fmtpron2" value="${esc((fmt.pronunciationGuideMarkers || ['', ''])[1])}" size="4">
        </label>
        <span class="spacer" style="flex:1"></span>
        <button id="fmtreset">Reset to preset</button>
        <button id="fmtsave" class="primary">Save format</button>
      </div>
    </div>
    <div class="row">
      <span class="muted">Admin link open until ${new Date(t.closes).toLocaleString()}</span>
      <button id="rotate" class="small">New admin link</button>
    </div>

    <h2>Stats + Export</h2>
    <div class="row">
      <button id="calc" class="primary">Compute stats</button>
      <button id="dlyft" disabled>Download .yft</button>
      <button id="dlreport" disabled>Download stat report</button>
      <button id="dlzip" disabled>Download QBJ bundle</button>
      <button id="rebuild" disabled>Rebuild stats data</button>
      <span class="spacer" style="flex:1"></span>
      <label class="row">Buzzpoints
        <select id="buzzmode">
          <option value="">Off</option>
          <option value="password" ${(settings.buzz || {}).mode === 'password' ? 'selected' : ''}>On (password)</option>
        </select>
      </label>
      ${(settings.buzz || {}).hash ? '<span class="pill on">Password set</span>' : ''}
      <input id="buzzpw" type="password" placeholder="Password" size="16"
        ${(settings.buzz || {}).mode === 'password' ? '' : 'hidden'}>
      <button id="buzzset" ${(settings.buzz || {}).mode === 'password' ? '' : 'hidden'}>Set password</button>
    </div>
    <div id="statsout" style="margin-top:12px"></div>

    <h2>Uploads</h2>
    ${uploadRounds.map((rn) => {
      const group = files.filter((f) => f.round === rn);
      const ri = rn === t.current_round ? intake : roundIntake(sched, rn, buckets, files);
      const open = uploadsOpen ? uploadsOpen.has(rn) : rn === t.current_round;
      return `
      <details class="rgroup" data-uprnd="${rn}" ${open ? 'open' : ''}>
        <summary><b>Round ${rn}</b>
          ${ri.expected ? `<span class="pill ${ri.got >= ri.expected ? 'on' : 'warn'}">${ri.got}/${ri.expected}</span>` : ''}
          ${ri.missing.length ? `<span class="muted">Missing ${esc(ri.missing.join(', '))}</span>` : ''}
        </summary>
        ${group.length ? `<div class="tablewrap"><table>
          <tr><th>Room</th><th>File</th><th>Kind</th><th class="num">Size</th><th>Status</th><th></th></tr>
          ${group.map((f) => {
            const room = buckets.find((b) => b.id === f.bucket_id);
            // A combined reader upload downloads as its two real files — the
            // match .qbj and the MODAQ game file — not the raw wrapper JSON.
            const link = (params, label) =>
              `<a href="${API}${a}/file?key=${encodeURIComponent(f.r2_key)}&${params}" download>${label}</a>`;
            const base = f.filename.replace(/\.qbtd\.json$/i, '');
            const links = f.kind === 'combined' && !f.error
              ? link(`part=qbj&dl=${encodeURIComponent(base + '.qbj')}`, 'qbj') + ' '
                + link(`part=game&dl=${encodeURIComponent(base + '_Game.json')}`, 'game')
              : link(`dl=${encodeURIComponent(f.filename)}`, 'Download');
            return `<tr>
              <td>${esc(room ? room.room_name : '#' + f.bucket_id)}</td>
              <td class="brk">${esc(f.filename)}</td>
              <td>${f.kind}</td>
              <td class="num">${fmtBytes(f.size)}</td>
              <td>${f.error ? `<span class="bad">${esc(f.error)}</span>` : '<span class="ok">OK</span>'}</td>
              <td class="row">
                ${links}
                <button data-delfile="${f.id}">Delete</button>
              </td>
            </tr>`;
          }).join('')}
        </table></div>` : '<div class="muted" style="padding:6px 10px">No files</div>'}
      </details>`;
    }).join('')}`;

  if ($('gosetup')) $('gosetup').onclick = () => { curView = 'setup'; render(); };
  box.querySelectorAll('details.rgroup').forEach((d) => {
    d.ontoggle = () => {
      uploadsOpen = new Set([...box.querySelectorAll('details.rgroup[open]')]
        .map((x) => Number(x.dataset.uprnd)));
    };
  });
  $('anndrawer').ontoggle = () => { annOpen = $('anndrawer').open; };

  /* broadcasts: every write sends the whole live list, so removals and
     expiries prune themselves */
  const checkedRooms = () => [...box.querySelectorAll('[data-annroom]:checked')]
    .map((c) => Number(c.dataset.annroom));
  const saveAnnounce = (next) => pub(a, { method: 'POST', json: { announce: next } });
  $('anntext').oninput = () => {
    annForm.text = $('anntext').value;
    $('anncount').textContent = annForm.text.length + '/200';
  };
  $('annto').onchange = () => {
    annForm.to = $('annto').value;
    $('annrooms').hidden = annForm.to !== 'some';
  };
  $('annmins').onchange = () => { annForm.mins = $('annmins').value; };
  $('annalert').onchange = () => { annForm.alert = $('annalert').checked; };
  box.querySelectorAll('[data-annroom]').forEach((c) => {
    c.onchange = () => { annForm.rooms = checkedRooms(); };
  });
  $('annsend').onclick = async () => {
    const text = $('anntext').value.trim();
    if (!text) { say('Type a message first', true); return; }
    const to = $('annto').value;
    const roomsTo = to === 'both' || to === 'rooms' ? true
      : to === 'some' ? checkedRooms() : false;
    if (Array.isArray(roomsTo) && !roomsTo.length) { say('Pick at least one room', true); return; }
    const now = Date.now();
    const mins = $('annmins').value;
    try {
      await saveAnnounce([...live, {
        id: annId(),
        text,
        level: $('annalert').checked ? 'alert' : 'note',
        pub: to === 'both' || to === 'pub',
        rooms: roomsTo,
        created: now,
        // 'end' is the tournament's own close, which the Worker clamps to anyway
        expires: mins === 'end' ? t.closes : now + Number(mins) * 60000,
      }]);
      annForm = { text: '', to, rooms: Array.isArray(roomsTo) ? roomsTo : [], mins, alert: false };
      annOpen = true;
      say('Broadcast sent');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  box.querySelectorAll('[data-delann]').forEach((b) => {
    b.onclick = async () => {
      try {
        await saveAnnounce(live.filter((x) => x.id !== b.dataset.delann));
        say('Broadcast removed');
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  $('rotate').onclick = async () => {
    if (!confirm('Mint a new admin link? The current link stops working.')) return;
    try {
      const out = await pub(a + '/rotate', { method: 'POST' });
      saveLink({ secret: out.admin_secret, slug: t.slug, name: t.name,
        closes: t.closes, created: t.created });
      history.replaceState(null, '', 'index.html?a=' + out.admin_secret);
      showLinkModal(adminLink(out.admin_secret), t.closes, () => location.reload());
    } catch (e) { say(e.message, true); }
  };
  const goToRound = async (n) => {
    try {
      await pub(a, { method: 'POST', json: { current_round: n } });
      uploadsOpen = null; // upload groups follow the new round
      say('Round ' + n);
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('setround').onclick = () => goToRound(Number($('curround').value));
  if ($('advround')) $('advround').onclick = () => goToRound(t.current_round + 1);
  const saveSettings = async (next, extra) => {
    await pub(a, { method: 'POST', json: { settings: next, ...extra } });
    settings = next;
  };
  $('gformat').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('gformat').value) next.gameFormat = $('gformat').value;
      else delete next.gameFormat;
      await saveSettings(next);
      say('Game format saved');
      showDetail(); // overrides sit on the new preset; refresh the panel
    } catch (e) { say(e.message, true); }
  };
  $('fmtedit').onclick = () => {
    fmtOpen = $('fmtpanel').hidden;
    $('fmtpanel').hidden = !fmtOpen;
  };
  $('fmtsave').onclick = async () => {
    try {
      const p1 = $('fmtpron1').value.trim(), p2 = $('fmtpron2').value.trim();
      if (!!p1 !== !!p2) { say('Pronunciation marks: fill both or neither', true); return; }
      const want = {
        regulationTossupCount: Number($('fmttossups').value),
        negValue: Number($('fmtneg').value),
        powers: parsePowersText($('fmtpowers').value),
        minimumOvertimeQuestionCount: Number($('fmtot').value),
        pairTossupsBonuses: $('fmtpaired').checked,
        bonusesBounceBack: $('fmtbounce').checked,
        overtimeIncludesBonuses: $('fmtotbonus').checked,
        pronunciationGuideMarkers: p1 ? [p1, p2] : null,
      };
      const ov = formatOverridesFrom(settings.gameFormat || '', want);
      const bad = Object.keys(ov).filter((k) => !(k in cleanOverrides(ov)));
      if (bad.length) { say('Bad value: ' + bad.join(', '), true); return; }
      const next = { ...settings };
      if (Object.keys(ov).length) next.formatOverrides = ov;
      else delete next.formatOverrides;
      await saveSettings(next);
      say('Game format saved');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('fmtreset').onclick = async () => {
    try {
      const next = { ...settings };
      delete next.formatOverrides;
      await saveSettings(next);
      say('Game format reset');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('buzzmode').onchange = async () => {
    const mode = $('buzzmode').value;
    try {
      const next = { ...settings };
      if (!mode) delete next.buzz;
      else {
        // keep an existing password; otherwise wait for one to be set.
        // Spread it whole: dropping kdf/iters here would silently demote a
        // stretched password to the legacy scheme.
        if (settings.buzz && settings.buzz.hash) {
          next.buzz = { ...settings.buzz, mode: 'password' };
        } else {
          $('buzzpw').hidden = false;
          $('buzzset').hidden = false;
          say('Set a password');
          return;
        }
      }
      await saveSettings(next);
      say(mode ? 'Buzzpoints on' : 'Buzzpoints off');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('buzzset').onclick = async () => {
    const pw = $('buzzpw').value;
    if (!pw) { say('Enter a password', true); return; }
    try {
      // PBKDF2 at 600k iterations takes about a second here; the Worker
      // only ever sees what comes back (buzzkey.js). The derived token
      // rides along once so the Worker can wrap the content key for the
      // gated packet route — it is not stored on either side.
      say('Setting password…');
      const cred = await buzzCredentials(pw);
      await saveSettings({ ...settings, buzz: cred.settings }, { buzz_token: cred.token });
      say('Buzzpoints password set');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('pub').onchange = async () => {
    try {
      await pub(a, { method: 'POST', json: { published: $('pub').checked } });
      say($('pub').checked ? 'Page is public' : 'Page is private');
    } catch (e) { say(e.message, true); }
  };
  box.querySelectorAll('[data-delfile]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this file?')) return;
      try {
        await pub(a + '/files/' + b.dataset.delfile, { method: 'DELETE' });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  $('calc').onclick = () => computeStats(a, t, buckets, files);
}

/* ---------- stats + export ---------- */

// Blob routes return parsed JSON when stored as JSON (qbj, roster,
// combined), a raw Response otherwise.
async function fetchOwnedJson(a, key) {
  const res = await pub(`${a}/file?key=${encodeURIComponent(key)}`);
  return res instanceof Response ? JSON.parse(await res.text()) : res;
}

// Every clean game file parsed, plus the roster: shared by Compute stats
// and the schedule's fill-from-standings.
async function collectMatches(a, t, buckets, files) {
  const qbjFiles = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
  const errors = [];
  let roster = null;
  if (t.roster_r2_key) {
    try { roster = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)); }
    catch (e) { errors.push('Roster: ' + e.message); }
  }
  const matches = [];
  const raw = [];   // qbj halves: the zip download + the served stats bundle
  const games = []; // game halves of combined uploads, for the zip only
  for (const f of qbjFiles) {
    try {
      // Combined reader uploads contribute only their qbj half downstream
      // (the game half carries the full packet text; the TO's zip gets it
      // as the separate MODAQ game file).
      const full = await fetchOwnedJson(a, f.r2_key);
      const payload = matchPayload(full);
      const m = parseMatch(payload, { filename: f.filename });
      const room = buckets.find((b) => b.id === f.bucket_id);
      m.room = room ? room.room_name : '';
      m.fileId = f.id;
      matches.push(m);
      raw.push({
        id: f.id, round: m.round, room: m.room,
        filename: f.filename.replace(/\.qbtd\.json$/i, '.qbj'),
        text: JSON.stringify(payload),
      });
      if (f.kind === 'combined' && full.game && typeof full.game === 'object') {
        games.push({
          round: m.round,
          filename: f.filename.replace(/\.qbtd\.json$/i, '_Game.json'),
          text: JSON.stringify(full.game),
        });
      }
    } catch (e) {
      errors.push(f.filename + ': ' + e.message);
    }
  }
  return { roster, matches, raw, games, errors };
}

async function computeStats(a, t, buckets, files) {
  const out = $('statsout');
  out.innerHTML = '<div class="muted">Loading files…</div>';
  const { roster, matches, raw, games, errors } = await collectMatches(a, t, buckets, files);

  if (!matches.length) {
    out.innerHTML = `<div class="bad">No readable game files</div>
      ${errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}`;
    return;
  }

  const agg = aggregate(matches, roster);
  renderStats(out, agg, errors);

  const exportOpts = { name: t.name, matches: dedupeMatches(matches), roster };
  $('dlyft').disabled = false;
  $('dlyft').onclick = () => {
    try { download(t.slug + '.yft', serializeYft(exportOpts), 'application/json'); }
    catch (e) { say(e.message, true); }
  };
  // YellowFruit-style six-page HTML report, zipped so the interlinked
  // files land as one folder ready to host.
  $('dlreport').disabled = false;
  $('dlreport').onclick = () => {
    try {
      const pages = buildReport(exportOpts);
      download(t.slug + '-report.zip',
        makeZip(pages.map((f) => ({ name: f.name, data: f.text }))), 'application/zip');
    } catch (e) { say(e.message, true); }
  };
  $('dlzip').disabled = false;
  $('dlzip').onclick = async () => {
    // Every game as its separated files: match .qbj + MODAQ game file.
    // Files list newest-first, so first-wins dedupe keeps the latest
    // upload of a re-exported game (same name twice would break the zip).
    const seen = new Set();
    const entries = [];
    const add = (round, filename, data) => {
      const name = `round-${round}/${filename}`;
      if (seen.has(name)) return;
      seen.add(name);
      entries.push({ name, data });
    };
    for (const r of raw) add(r.round, r.filename, r.text);
    for (const g of games) add(g.round, g.filename, g.text);
    // game files uploaded separately through the bucket page
    for (const f of files.filter((x) => x.kind === 'game')) {
      try { add(f.round, f.filename, JSON.stringify(await fetchOwnedJson(a, f.r2_key))); }
      catch (e) { /* bundle still useful without it */ }
    }
    if (t.roster_r2_key) {
      try { entries.push({ name: 'roster.qbj', data: JSON.stringify(await fetchOwnedJson(a, t.roster_r2_key)) }); }
      catch (e) { /* bundle still useful without it */ }
    }
    download(t.slug + '-qbj.zip', makeZip(entries), 'application/zip');
  };
  $('rebuild').disabled = false;
  $('rebuild').onclick = async () => {
    try {
      const entries = raw.map((r) => ({
        id: r.id, round: r.round, room: r.room, filename: r.filename,
        qbj: JSON.parse(r.text),
      }));
      // Each game is its own blob on the backend, so this posts in
      // batches (worker.js MAX_REBUILD) rather than one huge body. The
      // shards themselves are rebuilt by the next cron tick.
      let posted = 0;
      for (let i = 0; i < entries.length; i += REBUILD_BATCH) {
        const res = await pub(a + '/bundle', {
          method: 'POST', body: JSON.stringify({ entries: entries.slice(i, i + REBUILD_BATCH) }),
        });
        posted += res.entries;
        say('Rebuilding stats data (' + posted + '/' + entries.length + ')');
      }
      say('Stats data rebuilt (' + posted + ' games); the public page picks it up within a minute');
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- boot ---------- */

if (adminSecret) showDetail();
else showList();
