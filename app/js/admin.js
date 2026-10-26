// admin.js — the TO dashboard (index.html). No login: the admin link
// (index.html?a=<secret>, minted at creation, expires 48h later) is the
// only credential. Tournaments this device created or opened are
// remembered in localStorage so the list view survives a closed tab —
// but the link itself is the source of truth.
//
// A third way in: index.html?i=<invite>. A question set's editor mints
// one invite per mirror (set.html); opening it here shows what it is and
// starts it — which creates an ordinary tournament, 48h clock and all,
// with the set's rounds already in place (showInvite).
//
// The dashboard is two views. Tournament Setup is the before-the-day
// work — Rooms, Packets + Tiebreakers, Roster, Schedule — with a progress
// pill per step. The Live Hub is the day-of page — round control,
// protests, settings, stats + export, uploads — and carries a notice
// until setup is complete.

import { API, pub, esc, fmtBytes, download } from './api.js';
// Asked for first, though the hub needs them only through the files below
// (packetsui.js, schededit.js): found there, they and entities.js were
// the last modules a cold load waited for, and on a slow link they held up
// the hub's first render.
import '../engine/buzz.js';
import '../engine/plan.js';
import '../engine/hdwhite.js';
import { parseMatch, parseRoster, buildRosterQbj, rosterTracking, teamMarks,
  carryFormerNames, forfeitQbj, statedRound } from '../engine/qbj.js';
import { standings, dedupeMatches } from '../engine/stats.js';
// hubgames.js builds the downloads with these four. They are
// imported here too, where this file used them before, so a cold load
// asks for them as early as it did: found one module later, report.js
// held up the hub's first render on a slow link.
import '../engine/yft.js';
import '../engine/yft3.js';
import '../engine/report.js';
import { makeZip } from '../engine/zip.js';
import { renderStats } from './statsview.js';
import { pasteGrid } from '../engine/rosterpaste.js';
import { renderPacketsUi, stagedBlob, endSentence, tbSplitNote } from './packetsui.js';
import { formatHtml, wireFormat } from './formatui.js';
import { effectiveFormat, metaKey, gameKey, storeIntact, tbResume, formatKey, GAME_FORMAT_OPTIONS } from './read_core.js';
import '../engine/modaqfile.js'; // asked for as early as before (see above)
import { applyBuzzFix, buzzFixView, lineupGaps, lineupView, applyLineupFix } from '../engine/buzzfix.js';
import { slotText, roundIntake, fillReport, roundRooms, flatRounds, renameTeams, rosterRenames,
  hasPlaceholders, prelimRounds, finishedThrough, summaryTeams, namedFiles } from '../engine/schedule.js';
import { fillProgress, autoFillSaved, filledNote, heldLevel } from '../engine/finals.js';
import { renderSchedStep, schedEscape } from './schededit.js';
import { bracketModel, bracketRounds, bracketInfo, maxRound, phaseOfRound, roomIndexOf, followRoomRename, roomRound, roomBracket, gameIn, advanceAll, slotLabel, liveLayout } from '../engine/brackets.js';
import { buzzCredentials, sha256Hex } from './buzzkey.js';
import { exampleSheetHtml } from './sheetview.js';
import { busy } from './busy.js';
import { protestRows, swingLines, qLabel, RULINGS, rulingLabel, fileSummary as uploadedSummary } from './protests.js';
import { ownedJson, collectMatches, gameFormat, createHubNames,
  fileDownloads, yftFile, reportPages, reportZipFile, qbjZipFile, rosterFileText } from './hubgames.js';
import { isGameFile, newestOf } from '../engine/games.js';
import { readTagged, settingsBody, rulingsBody, postSchedule, postRoster, FORMAT_KEYS,
  SCHED_CONFLICT, SCHED_KEPT, ROSTER_CONFLICT, ROSTER_KEPT } from './saves.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const msg = $('msg');
const adminSecret = new URLSearchParams(location.search).get('a') || '';
const inviteSecret = new URLSearchParams(location.search).get('i') || '';

// Status line: a small notice at the bottom of the window. Confirmations
// fade after a few seconds; errors stay until clicked, so none is missed.
let sayTimer = null;
function say(text, bad = false) {
  clearTimeout(sayTimer);
  msg.textContent = text || '';
  msg.className = text ? (bad ? 'bad show' : 'show') : '';
  if (text && !bad) sayTimer = setTimeout(() => { msg.className = ''; }, 4000);
}
msg.onclick = () => { clearTimeout(sayTimer); msg.className = ''; };

function pageDir() {
  return location.href.split(/[?#]/)[0].replace(/index\.html$/, '').replace(/\/$/, '');
}
function adminLink(secret) { return pageDir() + '/index.html?a=' + secret; }
function readLink(secret) { return pageDir() + '/read.html?b=' + secret; }
function statsLink(slug) { return pageDir() + '/t.html?t=' + slug; }
function setLink(slug) { return pageDir() + '/s.html?s=' + slug; }

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
// Off this device's list only: the tournament itself, its rooms and its
// public page are untouched.
function forgetLink(secret) {
  localStorage.setItem(LINKS_KEY, JSON.stringify(savedLinks().filter((e) => e.secret !== secret)));
}

/* ---------- save-this-link modal ---------- */

function showLinkModal(link, onDone) {
  $('modallink').textContent = link;
  $('linkmodal').hidden = false;
  $('modalcopy').onclick = () => copy(link, 'admin link');
  $('modalok').onclick = () => {
    $('linkmodal').hidden = true;
    onDone();
  };
}

/* ---------- the home page ----------
   Laid out like a tournament's Live tab (hub.css): the create form, then
   this device's tournaments as a tight list that folds (the choice kept
   per device), and on the right the rail — the tournaments running here
   and the ones that have (sidebar.js). What qb-td is, and the demo, are
   on about.html. */

const FOLDS_KEY = 'qbtdHomeFolds';
function foldState() {
  try { return JSON.parse(localStorage.getItem(FOLDS_KEY)) || {}; } catch (e) { return {}; }
}
function keepFold(name, open) {
  try { localStorage.setItem(FOLDS_KEY, JSON.stringify({ ...foldState(), [name]: open })); }
  catch (e) { /* storage blocked: the fold just isn't remembered */ }
}
// A name as the Worker's slug rule takes it (a-z, 0-9, hyphens, 3-40
// long): "2026 Terrapin Open @ USC" -> "2026-terrapin-open-usc". Accents
// fold to their letters. Too short to be a slug is left for the TD to fix.
function slugFor(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
const shortDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function showList() {
  const links = savedLinks();
  document.body.classList.add('hubpage', 'homepage');
  view.innerHTML = `
    <div class="livegrid homegrid">
      <div>
        <div class="newrow">
          <label>Name<input id="newname" autocomplete="off"></label>
          <label>URL name<input id="newslug" autocomplete="off" spellcheck="false"></label>
          <button id="newbtn" class="primary advance">Create tournament</button>
          <div class="newhint muted" id="newhint"></div>
        </div>
        <details class="fold" data-fold="yours"${foldState().yours === false ? '' : ' open'}>
          <summary><h2>Your tournaments</h2><span class="muted">${links.length} on this device</span></summary>
          ${links.map((e) => {
            const live = Date.now() < e.closes;
            return `
          <div class="trow">
            ${live ? `<a class="nm" href="${esc(adminLink(e.secret))}">${esc(e.name)}</a>`
                   : `<span class="nm muted">${esc(e.name)}</span>`}
            <span class="st">${live ? 'open until ' + esc(shortDay(e.closes)) : 'closed'}</span>
            ${live ? '' : `<a href="${esc(statsLink(e.slug))}">Player page</a>`}
            <button class="linkbtn muted" data-forget="${esc(e.secret)}" title="Remove from this device's list">Remove</button>
          </div>`;
          }).join('') || `<div class="trow none">None yet. Create one above, or see <a href="about.html#demo">how it works</a> first.</div>`}
        </details>
      </div>
      <nav id="tside" class="liverail tside" aria-label="Tournaments on qb-td" hidden></nav>
    </div>`;
  view.querySelectorAll('details[data-fold]').forEach((d) => {
    d.addEventListener('toggle', () => keepFold(d.dataset.fold, d.open));
  });
  // the rail is a nicety: the page is complete without it
  import('./sidebar.js').then((m) => m.renderSidebar($('tside'))).catch(() => {});
  view.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = () => {
      const e = links.find((x) => x.secret === b.dataset.forget);
      if (!e) return;
      const open = Date.now() < e.closes;
      if (!confirm(`Remove "${e.name}" from this device?\n\n`
        + 'The tournament itself is not deleted: its rooms and player page keep working. '
        + (open ? 'This device forgets its admin link, so keep a copy if you still need to manage it.'
          : 'It has closed, so there is nothing left to manage.'))) return;
      forgetLink(e.secret);
      say('Removed ' + e.name + ' from this device');
      showList();
    };
  });
  // The slug follows the name as it is typed, until the TD types a slug of
  // their own; clearing the slug box hands it back to the name.
  let ownSlug = false;
  // what the URL name is for: the public page's address, as it will be
  const hint = () => {
    $('newhint').textContent = $('newslug').value ? 'Player page: ' + statsLink($('newslug').value) : '';
  };
  $('newname').oninput = () => { if (!ownSlug) $('newslug').value = slugFor($('newname').value); hint(); };
  $('newslug').oninput = () => { ownSlug = $('newslug').value !== ''; hint(); };
  $('newbtn').onclick = async () => {
    const run = busy($('newbtn'), { label: 'Creating' });
    try {
      const out = await pub('/api/tournaments', { method: 'POST', json: {
        name: $('newname').value, slug: $('newslug').value,
        // rounds open themselves unless the TD switches it off (Live Hub)
        settings: { autoAdvance: true },
      } });
      run.end();
      saveLink({ secret: out.admin_secret, slug: out.slug, name: out.name,
        closes: out.closes, created: Date.now() });
      showLinkModal(adminLink(out.admin_secret), () => {
        location.href = adminLink(out.admin_secret);
      });
    } catch (e) { run.end(); say(e.message, true); }
  };
}

/* ---------- starting a mirror from an invite ----------
   The invite is not the tournament: nothing exists until the TD creates
   it here, and then it is an ordinary tournament — a week of setup, and
   48 hours from the moment its TD presses Start. */

async function showInvite() {
  let inv;
  try { inv = await pub('/i/' + inviteSecret); }
  catch (e) {
    say(e.message === 'bad link' ? 'This invite link is not valid (it may have been revoked)'
      : e.message === 'set closed' ? 'This set has closed' : e.message, true);
    view.innerHTML = '<div class="row"><a href="index.html">All tournaments</a></div>';
    return;
  }
  if (inv.started) {
    say('This mirror was already started on ' + new Date(inv.started).toLocaleString()
      + '. Its admin link was shown then — ask the set\u2019s editors for a new invite if it is lost.', true);
    view.innerHTML = '<div class="row"><a href="index.html">All tournaments</a></div>';
    return;
  }
  view.innerHTML = `
    <h2>Mirror of ${esc(inv.set)}</h2>
    <div class="card">
      <div><b>${esc(inv.name)}</b>${inv.host ? ` <span class="muted">${esc(inv.host)}</span>` : ''}${
        inv.event_date ? ` <span class="muted">${esc(inv.event_date)}</span>` : ''}</div>
      <div class="muted" style="margin-top:6px">${inv.packets} packet${inv.packets === 1 ? '' : 's'},
        the set&rsquo;s backup questions and the reader&rsquo;s game format come with it — which round
        reads which packet stays up to you. Everything the rooms upload here, results and
        game files (MODAQ&rsquo;s included), is shared with the set&rsquo;s editors for set-wide stats.</div>
    </div>
    <p style="margin:12px 0"><b>Creating the tournament gives you a week to set it up.</b>
      The 48-hour clock only starts when you press <b>Start tournament</b> in its setup, on the day;
      until then room links show &ldquo;Tournament hasn&rsquo;t started&rdquo;. This invite can be used once.
      Already made your tournament? Don&rsquo;t create a second one: open it, and paste this page&rsquo;s link
      under Tournament Setup &rarr; Packets &rarr; Join a set.</p>
    <div class="row">
      <input id="invname" placeholder="Name" size="24" value="${esc(inv.name)}">
      <input id="invslug" placeholder="URL name" size="18" value="${esc(inv.slug || '')}">
      <button id="invstart" class="primary">Create tournament</button>
    </div>`;
  $('invstart').onclick = async () => {
    const run = busy($('invstart'), { label: 'Creating' });
    try {
      const out = await pub('/i/' + inviteSecret, { method: 'POST', json: {
        name: $('invname').value, slug: $('invslug').value,
      } });
      saveLink({ secret: out.admin_secret, slug: out.slug, name: out.name,
        closes: out.closes, created: Date.now() });
      showLinkModal(adminLink(out.admin_secret), () => {
        location.href = adminLink(out.admin_secret);
      });
    } catch (e) {
      say(e.message, true);
      run.end();
    }
  };
}

/* ---------- tournament detail: shared state ----------
   Survives render() re-renders (which happen after every action). */

let lastDetail = null;  // cached /a/:secret response for local re-renders
let curView = null;     // 'setup' | 'live'; null = auto until the user picks
let shownView = null;   // the view on screen right now
let setupTab = 'rooms'; // active Tournament Setup sub-tab

const staged = [];      // packets staged from a zip or loose files (packetsui.js)
let tbPool = null;      // tiebreaker pool blob (questions + uses), or null
let tbHeld;             // the detail's tb_stamp that tbPool was fetched under
// The roster's renames (qbj.js rosterNameMap), so a game uploaded under a
// team's old name is listed under its new one, as the stats count it.
// Loaded again whenever the roster is saved, here (key: null) or from
// another tab (its save time, roster_at, moves): hubgames.js.
const hubNames = createHubNames();
// a file's summary (protests.js), its teams under their current names
function fileSummary(f) { return hubNames.summary(f); }

let rosterOpen = false;
// structured editor working copy [{name, players, was, flags, orig}]; was:
// the saved name; flags: {ug, d2} per player and orig: each player's saved
// name ('' for one added here), both in step with players. A team's own
// marks are never entered: they follow from its players' (teamMarks).
let rosterTeams = null;
// the saved roster the editor opened (parseRoster), whose former names a
// save carries forward; null when it started blank
let rosterSaved = null;
// the etag of that saved copy (saves.js): the editor's save lands only on
// it, so a roster saved in another tab meanwhile asks first
let rosterEtag = null;
// which marks the roster tracks (YellowFruit's Track Undergrad / Track
// Division 2). A mark is shown, saved and exported only while its switch
// is on; with both off the roster is the file it always was.
let rosterTrack = { trackUG: false, trackDiv2: false };
// parsed upload awaiting confirmation; renames and etag: what it renames
// against the saved roster, and that copy's etag (renderUpPreview)
let rosterUpload = null;

let uploadsOpen = null;  // Set of expanded upload rounds; null = current round only
let cellOpen = null;     // uploads grid: {bid, round} whose files show under its row
let addOpen = null;      // Add a game panel: {bid, round, picked: the TD chose that round}, or null when closed
let ffOpen = null;       // Record a forfeit panel: {bid, round, win, lose}, or null when closed
let fixOpen = null;      // Fix buzzes panel (fixPanelHtml): the file, its upload, the fix so far
let protOpen = null;     // Protests drawer; null = auto: open when a protest is unruled
// clock time of a ruling (protests drawer)
function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// "Oct 1, 4:54 AM": when links close, short enough for a header line
function fmtWhen(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// Under the rooms after Start: how long the room links have left, counting
// down each second (H:MM:SS; past a day the hours keep counting)
function fmtLeft(ms) {
  const sec = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  const two = (n) => String(n).padStart(2, '0');
  return `${Math.floor(sec / 3600)}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}`;
}
setInterval(() => {
  document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = fmtLeft(Number(el.dataset.until)); });
}, 1000);

/* ---------- data fetch + top-level render ---------- */

// `quiet`: a background refresh — a failed fetch keeps what's on screen
// instead of replacing it with the error (a dropped connection, say).
// `held`: the rev of the detail on screen. The Worker answers {unchanged}
// when nothing has moved since, and then nothing is refetched or redrawn.
// Resolves true when the page was redrawn with a new detail.
async function showDetail(quiet = false, held = null) {
  const a = '/a/' + adminSecret;
  let detail;
  try {
    detail = await pub(Number.isInteger(held) ? a + '?rev=' + held : a);
    if (detail.unchanged) { notePub(detail); return false; }
  } catch (e) {
    if (quiet && e.message !== 'tournament closed') return;
    if (e.message === 'tournament closed') {
      say('Tournament closed (links stop working 48 hours after Start, or 7 days after creation if it never started)', true);
    } else say(e.message, true);
    view.innerHTML = `<div class="row"><a href="index.html">All tournaments</a></div>`;
    return;
  }
  const t = detail.tournament;
  saveLink({ secret: adminSecret, slug: t.slug, name: t.name,
    closes: t.closes, created: t.created });
  // the route, not the blob: on a set's mirror the pool is the set's
  // backup questions (read live) followed by this tournament's own.
  // Asked for now, alongside the roster and schedule, not after them —
  // and only when the detail's tb_stamp says it moved since the one held.
  // A failed fetch holds no stamp, so the next detail asks again; "no
  // tiebreakers" is an answer (no pool) and is held like one.
  const tbStamp = detail.tb_stamp;
  const tbReq = tbStamp !== undefined && tbStamp === tbHeld ? null
    : pub(a + '/tiebreakers').then((p) => ({ p, ok: true }),
      (e) => ({ p: null, ok: e.message === 'no tiebreakers' }));
  await ensureSched(a, t);
  // a tournament with rooms always has a bye room: made here, once
  if (await ensureByeRoom(a, t, detail.buckets)) return showDetail(quiet, held);
  // the bye room is kept apart: no room list, schedule or live view has it
  const byeId = byeIdOf(t);
  detail.byeRoom = detail.buckets.find((b) => b.id === byeId) || null;
  detail.buckets = detail.buckets.filter((b) => b.id !== byeId);
  if (tbReq) {
    const got = await tbReq;
    tbPool = got.p;
    tbHeld = got.ok ? tbStamp : undefined;
  }
  testToken = await testTokenReq;
  await hubNames.ensure(pub, a, t);
  lastDetail = detail;
  render();
  // the header isn't redrawn when the view stays put: its mark is
  notePub({});
  autoFillSlots();
  return true;
}

// The mark beside Open public page: whether viewers see the latest
// changes yet. Changes reach the public page on the cron's next rebuild
// (once a minute). When the Worker serves the page from qb-td-live
// (t.live, worker.js liveMark), Updating lasts until the file carrying
// the change has deployed, plus a moment for it to spread, and Delayed
// says deploys are failing — viewers are on older results, or on the
// Worker, until a retry lands. Without it, viewers' copies of /pub/:slug
// cache for 60s, so it reads Updating for a minute after the rebuild.
// Rough on purpose: it's there to explain a lag, not to time one.
const PUB_CACHE_MS = 60 * 1000;
const LIVE_SPREAD_MS = 30 * 1000;
function pubWaiting(t) {
  if (!t.published) return false;
  if (t.pub_dirty) return true;
  if (t.live) {
    return t.live.state === 'pending'
      || (t.live.state === 'ok' && !!t.live.at && Date.now() - t.live.at < LIVE_SPREAD_MS);
  }
  return !!t.pub_built && Date.now() - t.pub_built < PUB_CACHE_MS;
}
function pubMarkHtml(t) {
  if (!t.published) return '<span id="pubmark" class="pubstat">Page off</span>';
  if (t.live && t.live.state === 'failing' && !t.pub_dirty) {
    return '<span id="pubmark" class="pubstat wait" title="Publishing to the player page is failing and retrying on its own. '
      + 'Viewers may see older results until it lands."><span class="mk">&#9888;</span>Delayed</span>';
  }
  return pubWaiting(t)
    ? '<span id="pubmark" class="pubstat wait" title="Viewers see this change within a couple of minutes"><span class="mk">&#9675;</span>Updating</span>'
    : '<span id="pubmark" class="pubstat" title="Viewers see your latest changes"><span class="mk">&#10003;</span>Up to date</span>';
}
// a refresh's pub_dirty / pub_built / live onto the detail on screen, and the mark
function notePub(x) {
  if (!lastDetail || !x) return;
  if ('pub_dirty' in x) lastDetail.tournament.pub_dirty = x.pub_dirty;
  if ('pub_built' in x) lastDetail.tournament.pub_built = x.pub_built;
  if ('live' in x) lastDetail.tournament.live = x.live;
  const m = $('pubmark');
  if (m) m.outerHTML = pubMarkHtml(lastDetail.tournament);
}

// The four setup steps and their done state.
// How many rounds the tournament has: the schedule's rounds, or more if
// the TD added some on the Packets step (settings.rounds), and never
// fewer than a round that is live or already has a packet.
function schedRoundCount() {
  if (!sched || !Array.isArray(sched.phases)) return 0;
  return Math.max(0, ...sched.phases.flatMap((p) => (p.rounds || []).map((r) => Number(r.round) || 0)));
}
function roundCount(t, rounds, settings) {
  return Math.max(1, schedRoundCount(), Number(settings.rounds) || 0, t.current_round,
    ...rounds.map((r) => r.number));
}

// The setup steps, in the order a TD does them, and their done state.
// Packets come after the schedule: the schedule decides how many rounds
// there are to fill.
function setupSteps(t, buckets, rounds, settings) {
  const totalRounds = roundCount(t, rounds, settings);
  return [
    ['rooms', 'Rooms', buckets.length > 0,
      buckets.length ? buckets.length + ' rooms' : 'None yet'],
    ['roster', 'Roster', !!t.roster_name, t.roster_name ? 'Saved' : 'None yet'],
    ['sched', 'Schedule', !!sched, sched ? 'Saved' : 'None yet'],
    ['packets', 'Packets', rounds.length > 0,
      rounds.length + '/' + totalRounds + ' rounds'],
    // a format the TD (or the set) chose; the preset alone is just a default
    ['modaq', 'MODAQ Settings', !!settings.gameFormat,
      settings.gameFormat ? (GAME_FORMAT_OPTIONS.find((o) => o.value === formatKey(settings)) || {}).label || 'Saved'
        : 'Not saved'],
    ['stats', 'Player page', !!settings.statsSeen,
      (t.published ? 'Page on' : 'Page off')
        + (settings.scoresheets && (settings.buzz || {}).hash ? ' · Scoresheets on' : '')
        + ((settings.buzz || {}).mode === 'password' ? ' · Buzzpoints on' : '')],
  ];
}

// Start: rooms begin serving packets, and every link closes 48 hours on.
async function startTournament(a, t, btn) {
  const closes = new Date(Date.now() + 48 * 3600 * 1000).toLocaleString();
  if (!confirm('Start the tournament?\n\nRoom links start serving packets and taking games. '
    + `Your admin link and every room link stop working 48 hours from now, at ${closes}.`)) return;
  const run = btn ? busy(btn, { label: 'Starting' }) : null;
  try {
    const out = await pub(a + '/start', { method: 'POST' });
    say('Tournament started. Links close ' + new Date(out.closes).toLocaleString());
    showDetail();
  } catch (e) { say(e.message, true); }
  if (run) run.end();
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
  shownView = v;

  document.body.classList.add('hubpage');
  view.innerHTML = `
    <div class="hubhead">
      <div class="hubtitle">
        <h1>${esc(t.name)}</h1>
        <span class="muted">${t.started
          ? `closes ${esc(fmtWhen(t.closes))}`
          : `Not started &middot; setup open until ${esc(fmtWhen(t.closes))}`}</span>
        <span class="mono muted slug">${esc(t.slug)}</span>
      </div>
      <nav class="hubnav">
        <button class="hubtab ${v === 'setup' ? 'on' : ''}" data-view="setup">Setup${
          missing.length ? ' <span class="ndot" title="Setup incomplete">&bull;</span>' : ''}</button>
        <button class="hubtab ${v === 'live' ? 'on' : ''}" data-view="live">Live</button>
        <span class="spacer" style="flex:1"></span>
        <button class="linkbtn" onclick="qtd.copy('${esc(statsLink(t.slug))}', 'player link')">Copy player link</button>
        <a href="${esc(statsLink(t.slug))}" target="_blank">Open player page</a>
        ${pubMarkHtml(t)}
        <button id="rotate" class="linkbtn">New admin link</button>
      </nav>
      ${t.set ? `<div class="muted" style="font-size:13px;margin-top:6px">Mirror of <b>${esc(t.set.name)}</b>${
        t.set.published ? ` &middot; <a href="${esc(setLink(t.set.slug))}" target="_blank">set page</a>` : ''}</div>` : ''}
    </div>
    <div id="viewbody"></div>`;
  view.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => {
      if (setupTab === 'sched' && b.dataset.view !== curView && !leaveSchedOk()) return;
      curView = b.dataset.view; render();
    };
  });
  $('rotate').onclick = async () => {
    if (!confirm('Mint a new admin link? The current link stops working.')) return;
    const run = busy($('rotate'), { label: 'Making a new link' });
    try {
      const out = await pub(a + '/rotate', { method: 'POST' });
      run.end();
      saveLink({ secret: out.admin_secret, slug: t.slug, name: t.name,
        closes: t.closes, created: t.created });
      history.replaceState(null, '', 'index.html?a=' + out.admin_secret);
      showLinkModal(adminLink(out.admin_secret), () => location.reload());
    } catch (e) { run.end(); say(e.message, true); }
  };
  if (v === 'setup') renderSetup(a, t, buckets, rounds, files, settings, steps);
  else renderLive(a, t, buckets, rounds, files, settings, missing);
  window.scrollTo(0, scrollWas);
}

/* ================= Tournament Setup ================= */

function renderSetup(a, t, buckets, rounds, files, settings, steps) {
  const box = $('viewbody');
  // the step list is the checklist and the tabs at once: one line per
  // step, its done state and a word on where it stands
  const LABEL = { packets: 'Packets + Tiebreakers', stats: 'Player page' };
  box.innerHTML = `
    <div class="setupgrid">
      <aside class="steplist">
        ${steps.map(([key, label, done, detail]) => `
        <button class="stepbtn ${setupTab === key ? 'on' : ''}" data-step="${key}" ${setupTab === key ? 'aria-current="true"' : ''}>
          <span class="mark ${done ? 'done' : ''}">${done ? '&#10003;' : '&#9675;'}</span>
          <span class="stext"><span class="slabel">${LABEL[key] || label}</span><span class="sdetail">${esc(detail)}</span></span>
        </button>`).join('')}
        <div class="stepstart">
          ${t.started
            ? `<div><b>Started</b></div><div class="muted" style="font-size:13px">Links close ${esc(fmtWhen(t.closes))}</div>`
            : `<button id="starttour" class="primary">Start tournament</button>
               <div class="muted" style="font-size:12px">Room links open for 48 hours from Start.</div>`}
        </div>
      </aside>
      <div id="setupsec"></div>
    </div>`;
  box.querySelectorAll('[data-step]').forEach((s) => {
    // working through the steps is choosing Setup: finishing the last one
    // must not flip the page to Live under the TD's hands
    s.onclick = () => {
      if (setupTab === 'sched' && s.dataset.step !== 'sched' && !leaveSchedOk()) return;
      setupTab = s.dataset.step; curView = 'setup'; render();
    };
  });
  if ($('starttour')) $('starttour').onclick = () => startTournament(a, t, $('starttour'));
  if (setupTab === 'rooms') renderRoomsSec(a, t, buckets, files);
  else if (setupTab === 'packets') renderPacketsSec(a, t, buckets, rounds, settings);
  else if (setupTab === 'roster') renderRosterSec(a, t);
  else if (setupTab === 'modaq') renderModaqSec(a, t, settings);
  else if (setupTab === 'stats') renderStatsSec(a, t, settings);
  else renderScheduleSec(a, t, buckets, files);
}

/* ---------- MODAQ Settings: the format every room reads under ----------
   Setup rather than the live view because it is a decision about the
   tournament's rules, made once before the first game — and because the
   exports read it: the regulation tossup count here is what the .yft's
   scoring rules carry and what the stat report scales by. A TD running
   22-tossup rounds sets it here and everything downstream follows. */

function renderModaqSec(a, t, settings) {
  const box = $('setupsec');
  box.innerHTML = '<h2>MODAQ settings</h2>' + formatHtml(settings, true);
  wireFormat(box, {
    settings: () => settings,
    // each save here picks the format: the preset and its overrides are
    // both set, whatever this tab's copy held (saves.js), and the next
    // save builds on this one, as saveSettings does
    save: async (next) => {
      await pub(a, { method: 'POST', json: settingsBody(settings, next, {}, FORMAT_KEYS) });
      settings = next;
    },
    say, refresh: showDetail, onToggle: () => {},
  });
}

/* ---------- Stats settings: what the public stats page shows ---------- */

// renderStatsSec's state across redraws: a switch waiting on a password,
// the Change password field, the scoresheet example, and what's typed
const statsUi = { slug: null, want: null, changing: false, showExample: false, typed: '' };

function renderStatsSec(a, t, settings) {
  const box = $('setupsec');
  // Opening this tab is the decision the checklist wants: the page starts
  // public, so a TD who looks and leaves it on has chosen too.
  if (!settings.statsSeen) {
    // set here too, and each save below sets it again (saveSettings), so
    // a buzzpoints save can't undo it and a failed save here is made good
    const was = settings;
    settings = { ...settings, statsSeen: true };
    pub(a, { method: 'POST', json: settingsBody(was, settings, {}, ['statsSeen']) }).then(showDetail, () => {});
  }
  const locked = !!(t.set && t.set.lock_buzz);
  // Scoresheets and buzzpoints are only ever behind the stats password
  // (settings.buzz, which keeps it with buzzpoints off as mode 'off').
  // Turning either on without one asks for it first (`statsUi.want`), and the
  // switch goes on once it is set; the Worker refuses either without one.
  // this section's own state lives outside it (statsUi), so the hub's
  // own redraws (a refresh, a save) don't close a half-typed password
  if (statsUi.slug !== t.slug) Object.assign(statsUi, { slug: t.slug, want: null, changing: false, showExample: false, typed: '' });
  const hasKey = () => Boolean(settings.buzz && settings.buzz.hash);
  // "Disable password", once the set is clear (settings.statsOpen): both switches work
  // without one (worker.js statsOpen)
  const open = () => settings.statsOpen === true;
  const canShow = () => hasKey() || open();
  const buzzOn = () => Boolean(settings.buzz && settings.buzz.mode === 'password');
  const sheetsOn = () => settings.scoresheets === true && canShow();
  const OPEN_WARNING = 'Anyone with the player link will see buzzpoints and scoresheets, and buzzpoints show the '
    + 'questions of finished rounds. Please only choose this once the question set is clear.';
  const WHAT = { scoresheets: 'scoresheets', buzz: 'buzzpoints' };

  const pwRow = () => {
    if (open()) {
      return `<div class="row"><span class="pill warn">Password disabled</span>
          <button id="pwneed">Enable password</button></div>
        <p class="warntext" style="margin:6px 0 0">${OPEN_WARNING}</p>`;
    }
    const noPw = '<button class="linkbtn" id="pwopen">Disable password</button>';
    if (hasKey() && !statsUi.changing) {
      return `<div class="row"><span class="pill on">Password set</span>
          <button id="pwchange">Change password</button>${noPw}</div>
        <p class="muted" style="margin:6px 0 0">Viewers enter this password to see scoresheets and buzzpoints.</p>`;
    }
    if (statsUi.changing) {
      return `<div class="row"><label class="row">New password
          <input id="statspw" type="password" placeholder="New password" size="18"></label>
          <button id="pwset" class="primary">Save</button><button id="pwcancel">Cancel</button></div>
        <p class="muted" style="margin:6px 0 0">Viewers who unlocked with the old password will need to enter the new one.</p>`;
    }
    if (statsUi.want) {
      return `<div class="row"><label class="row">Password
          <input id="statspw" type="password" placeholder="Choose a password" size="18"></label>
          <button id="pwset" class="primary">Set password</button><button id="pwcancel">Cancel</button></div>
        <p style="margin:6px 0 0">Please set a password to turn on ${WHAT[statsUi.want]}. Viewers will enter it to see them.</p>`;
    }
    return `<p class="muted" style="margin:0">Scoresheets and buzzpoints need a password. Turning one on will ask for it.</p>
      <div class="row" style="margin-top:6px">${noPw}</div>`;
  };

  const draw = () => {
    box.innerHTML = `
    <h2>Player page</h2>
    <div class="row" style="margin-bottom:6px">
      <label class="row"><input type="checkbox" id="pub" ${t.published ? 'checked' : ''}> Player page</label>
    </div>
    <p class="muted" style="margin:0">Turn on for schedule, semi-live stats, category stats,
      and buzzpoints (if enabled) to be accessible to players.</p>
    <div class="row" style="margin-top:10px">
      <a class="mono" href="${esc(statsLink(t.slug))}" target="_blank">${esc(statsLink(t.slug))}</a>
      <button class="small" onclick="qtd.copy('${esc(statsLink(t.slug))}', 'player link')">Copy</button>
    </div>
    <h2>Category stats</h2>
    <div class="row">
      <label class="row">Category stats
        <select id="catstats">
          <option value="on">On</option>
          <option value="off" ${settings.catStats === false ? 'selected' : ''}>Off</option>
        </select>
      </label>
    </div>
    <p class="muted" style="margin:6px 0 0">Shows the Categories tab when the packets have categories.</p>
    <h2>${open() ? 'Scoresheets and buzzpoints' : 'Password-protected stats'}</h2>
    <div id="pwrow">${pwRow()}</div>
    <div class="pwstats">
      <div class="row">
        <label class="row">Scoresheets
          <select id="sheetsmode">
            <option value="">Off</option>
            <option value="on" ${sheetsOn() ? 'selected' : ''}>On</option>
          </select>
        </label>
        <button class="infobtn" id="sheetsinfo" aria-expanded="${statsUi.showExample}" aria-controls="sheetsex"
          title="What is a scoresheet?">i</button>
      </div>
      <p class="muted" style="margin:6px 0 0">Shows a scoresheet for each game when all games during a round finish.</p>
      <div id="sheetsex" class="sheetex" ${statsUi.showExample ? '' : 'hidden'}>
        <p>A scoresheet lists the tossups of a game in order. It shows who buzzed and for how many points, which
          bonus parts each team got, the category, and the score after each tossup. A hatched column means that
          player was out of the game. Here is a short example.</p>
        ${statsUi.showExample ? exampleSheetHtml() : ''}
      </div>
      <div class="row" style="margin-top:12px">
        <label class="row">Buzzpoints
          <select id="buzzmode" ${locked ? 'disabled' : ''}>
            <option value="">Off</option>
            <option value="on" ${buzzOn() ? 'selected' : ''}>On</option>
          </select>
        </label>
      </div>
      <p class="muted" style="margin:6px 0 0">Updates buzzpoints when all games during a round finish.</p>
      ${locked ? `<div class="muted" style="font-size:13px;margin-top:6px">The editors of
        <b>${esc(t.set.name)}</b> have switched buzzpoints off for its mirrors while the set is still being
        played elsewhere, so the player page shows none, whatever is set here.</div>` : ''}
    </div>`;
    wireStats();
  };

  // from this tab's copy, with statsSeen set again (see above). The copy
  // moves on as the save goes out, so a second change made before the
  // answer comes back is made on this one (saves.js); a failed save puts
  // it back, as it was before.
  const saveSettings = async (next, extra) => {
    const was = settings;
    settings = next;
    try {
      await pub(a, { method: 'POST', json: settingsBody(was, next, extra, ['statsSeen']) });
    } catch (e) {
      if (settings === next) settings = was;
      throw e;
    }
  };

  // A new password, keeping each switch as it is, plus the one that asked
  // for it. PBKDF2 at 600k iterations takes about a second here; the
  // Worker only ever sees what comes back (buzzkey.js). The derived token
  // rides along once so the Worker can wrap the content key for the gated
  // packet route — it is not stored on either side.
  const setPassword = async () => {
    const pw = $('statspw').value;
    if (!pw) { say('Enter a password', true); return; }
    try {
      const run = busy($('pwset'), { label: 'Setting password', scope: box });
      try {
        const cred = await buzzCredentials(pw);
        const next = { ...settings,
          buzz: { ...cred.settings, mode: buzzOn() || statsUi.want === 'buzz' ? 'password' : 'off' } };
        if (statsUi.want === 'scoresheets') next.scoresheets = true;
        await saveSettings(next, { buzz_token: cred.token });
      } finally { run.end(); }
      say(statsUi.want ? `Password set, ${WHAT[statsUi.want]} on` : 'Password changed');
      statsUi.want = null; statsUi.changing = false; statsUi.typed = '';
      showDetail();
    } catch (e) { say(e.message, true); }
  };

  const wireStats = () => {
    $('pub').onchange = async () => {
      try {
        await pub(a, { method: 'POST', json: { published: $('pub').checked } });
        say($('pub').checked ? 'Player page on' : 'Player page off');
        showDetail();
      } catch (e) { say(e.message, true); }
    };
    $('catstats').onchange = async () => {
      const on = $('catstats').value === 'on';
      try {
        const next = { ...settings };
        if (on) delete next.catStats; else next.catStats = false;
        await saveSettings(next);
        say(on ? 'Category stats on' : 'Category stats off');
        showDetail();
      } catch (e) { say(e.message, true); }
    };
    // On without a password: back to Off, and ask for one
    const toggle = (which, sel, apply) => async () => {
      const on = Boolean(sel.value);
      if (on && !canShow()) { statsUi.want = which; statsUi.changing = false; draw(); $('statspw').focus(); return; }
      try {
        const next = { ...settings };
        apply(next, on);
        await saveSettings(next);
        say(`${WHAT[which][0].toUpperCase() + WHAT[which].slice(1)} ${on ? 'on' : 'off'}`);
        showDetail();
      } catch (e) { say(e.message, true); }
    };
    $('sheetsmode').onchange = toggle('scoresheets', $('sheetsmode'), (next, on) => {
      if (on) next.scoresheets = true; else delete next.scoresheets;
    });
    // Spread the password whole: dropping kdf/iters here would silently
    // demote a stretched password to the legacy scheme.
    $('buzzmode').onchange = toggle('buzz', $('buzzmode'), (next, on) => {
      next.buzz = { ...settings.buzz, mode: on ? 'password' : 'off' };
    });
    // no password, once the set is clear: asks first, with the warning
    if ($('pwopen')) {
      $('pwopen').onclick = async () => {
        if (!confirm('Disable the password for scoresheets and buzzpoints?\n\n' + OPEN_WARNING)) return;
        try {
          await saveSettings({ ...settings, statsOpen: true });
          statsUi.want = null; statsUi.changing = false;
          say('Password disabled: scoresheets and buzzpoints are open to anyone with the player link');
          showDetail();
        } catch (e) { say(e.message, true); }
      };
    }
    // back to a password: without one stored, both switch off until it's set
    if ($('pwneed')) {
      $('pwneed').onclick = async () => {
        try {
          const next = { ...settings };
          delete next.statsOpen;
          if (!hasKey()) {
            delete next.scoresheets;
            if (next.buzz) next.buzz = { ...next.buzz, mode: 'off' };
          }
          await saveSettings(next);
          say(hasKey() ? 'Password enabled' : 'Password enabled: scoresheets and buzzpoints are off until you set one');
          showDetail();
        } catch (e) { say(e.message, true); }
      };
    }
    $('sheetsinfo').onclick = () => { statsUi.showExample = !statsUi.showExample; draw(); };
    if ($('pwchange')) $('pwchange').onclick = () => { statsUi.changing = true; statsUi.want = null; draw(); $('statspw').focus(); };
    if ($('pwcancel')) $('pwcancel').onclick = () => { statsUi.changing = false; statsUi.want = null; statsUi.typed = ''; draw(); };
    if ($('pwset')) {
      $('statspw').value = statsUi.typed;
      $('statspw').oninput = () => { statsUi.typed = $('statspw').value; };
      $('pwset').onclick = setPassword;
      $('statspw').onkeydown = (e) => { if (e.key === 'Enter') setPassword(); };
    }
  };

  draw();
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

// The bye room (settings.byeRoom, a bucket id): one room, apart from the
// playing rooms, to read to teams on a bye. Its link reads the reader's
// test mode before and after Start, with no test token in it, and the
// Worker keeps nothing it does.
function byeIdOf(t) {
  try { const s = JSON.parse(t.settings || '{}') || {}; return Number.isInteger(s.byeRoom) ? s.byeRoom : null; }
  catch (e) { return null; }
}
const byeLink = (secret) => readLink(secret) + '&test=bye';

// A room's Test link carries the tournament's test token (worker.js
// testToken): a hash of the admin secret's stored hash, never the secret
// itself. A forwarded Test link reads that room before Start and opens
// nothing else, and a new admin link retires it.
const testTokenReq = adminSecret
  ? sha256Hex('qbtd-cred:' + adminSecret).then((h) => sha256Hex('qbtd-test:' + h)).catch(() => '')
  : Promise.resolve('');
let testToken = '';
const testLink = (secret) => readLink(secret) + '&test=' + testToken;

// A tournament with rooms gets the bye room without being asked (it reads
// packets for teams on a bye, or for anyone else). Made once.
const byeMade = new Set();
async function ensureByeRoom(a, t, buckets) {
  if (byeMade.has(t.slug) || byeIdOf(t) !== null || !buckets.length) return false;
  byeMade.add(t.slug);
  try {
    const taken = new Set(buckets.map((b) => b.room_name));
    let name = 'Bye Room';
    for (let i = 2; taken.has(name); i++) name = 'Bye Room ' + i;
    const room = await pub(a + '/buckets', { method: 'POST', json: { room_name: name } });
    const settings = JSON.parse(t.settings || '{}') || {};
    const was = { ...settings };
    settings.byeRoom = room.id;
    await pub(a, { method: 'POST', json: settingsBody(was, settings, {}, ['byeRoom']) });
    return true;
  } catch (e) { return false; }
}

function renderRoomsSec(a, t, buckets, files) {
  const box = $('setupsec');
  const next = nextRoomNumber(buckets);
  const bye = lastDetail && lastDetail.byeRoom;
  box.innerHTML = `
    <h2>Rooms</h2>
    ${buckets.length ? `<div class="tablewrap"><table class="roomtable">
      <tr><th>Name</th><th>Reader link <button class="linkbtn" id="copyrooms">Copy all</button></th><th class="num">Files</th><th></th></tr>
      ${buckets.map((b) => {
        // names go into a JS string inside an attribute: escape for both
        const js = (s) => esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        const link = readLink(b.secret);
        return `<tr>
          <td><input class="inlinename" data-roomrename="${b.id}" value="${esc(b.room_name)}" aria-label="Room name"></td>
          <td class="linkpair"><button class="linkbtn" onclick="qtd.copy('${js(link)}', '${js(b.room_name)} reader link')">Copy</button>
            <a class="muted" href="${esc(link)}" target="_blank">Open</a>${t.started || !testToken ? ''
              : `<a href="${esc(testLink(b.secret))}" target="_blank">Test</a>`}</td>
          <td class="num muted">${files.filter((f) => f.bucket_id === b.id).length}</td>
          <td class="num"><button class="linkbtn muted" data-delbucket="${b.id}">Remove</button></td>
        </tr>`;
      }).join('')}
    </table></div>
    <p class="muted" style="font-size:13px;margin:6px 0 0">${t.started
      ? `Room links will stop working in <span class="tabnum" data-until="${t.closes}">${fmtLeft(t.closes)}</span>.`
      : 'Room links show &ldquo;Tournament hasn&rsquo;t started&rdquo; until you press Start tournament. '
        + 'Test simulates a room for json testing purposes without needing to start the tournament. '
        + 'Games that are exported from test rooms are NOT saved. Please use the Bye Room link for unofficial scrims, since nothing played there is saved.'}</p>`
    : '<div class="muted">No rooms yet</div>'}
    <div class="row" style="margin-top:10px">
      <label>${buckets.length ? 'Add' : 'Create'}
        <input id="roomn" type="number" min="1" max="60" value="${buckets.length ? 2 : 8}" style="width:64px">
        ${buckets.length ? 'more rooms' : 'rooms'}</label>
      <button id="mkrooms" class="primary">${buckets.length ? 'Add rooms' : 'Create rooms'}</button>
    </div>
    ${bye ? `<div class="byesec">
      <div class="row byelink"><strong>Bye Room</strong>
        <button class="linkbtn" id="copybye">Copy</button>
        <a class="muted" href="${esc(byeLink(bye.secret))}" target="_blank">Open</a></div>
      <p class="muted">Bye Room can be used by several readers at once and does not export or save results.</p>
    </div>` : ''}`;
  if ($('copybye')) $('copybye').onclick = () => copy(byeLink(bye.secret), 'Bye Room link');
  // each room's link, one a line ("Room 101: https://…"), to paste in a message
  if ($('copyrooms')) {
    $('copyrooms').onclick = () => copy(buckets.map((b) => `${b.room_name}: ${readLink(b.secret)}`).join('\n'), 'all room links');
  }
  $('mkrooms').onclick = async () => {
    const n = Math.max(1, Math.min(60, Number($('roomn').value) || 0));
    const again = $('mkrooms').textContent.trim();
    const run = busy($('mkrooms'), { label: 'Creating rooms', total: n, scope: box });
    // each room's row appears as it's made; the redraw at the end fills in its links
    const rowFor = (name) => {
      let tbody = box.querySelector('table tbody') || box.querySelector('table');
      if (!tbody) {
        const holder = [...box.children].find((el) => el.classList && el.classList.contains('muted'));
        const wrap = document.createElement('div');
        wrap.className = 'tablewrap';
        wrap.innerHTML = '<table class="roomtable"><tr><th>Name</th><th>Reader link</th><th class="num">Files</th><th></th></tr></table>';
        if (holder) holder.replaceWith(wrap); else box.querySelector('h2').after(wrap);
        tbody = wrap.querySelector('table');
      }
      const tr = document.createElement('tr');
      tr.className = 'fresh';
      tr.innerHTML = `<td>${esc(name)}</td><td class="muted" colspan="2">Links ready in a moment</td><td class="num">0</td><td></td>`;
      tbody.appendChild(tr);
    };
    let made = 0;
    try {
      for (let i = 0; i < n; i++) {
        await pub(a + '/buckets', { method: 'POST', json: { room_name: 'Room ' + (next + i) } });
        made++;
        rowFor('Room ' + (next + i));
        run.step(made);
      }
      say(n + ' room' + (n === 1 ? '' : 's') + ' created');
    } catch (e) {
      say(made
        ? `Created ${made} of ${n} rooms. Room ${next + made} failed: ${endSentence(e.message)} Press ${again} to make the other ${n - made}.`
        : e.message, true);
    }
    run.end();
    showDetail();
  };
  box.querySelectorAll('[data-roomrename]').forEach((inp) => {
    inp.onchange = async () => {
      const name = inp.value.trim();
      // a blank name isn't saved: the field shows the saved one again
      if (!name) { inp.value = inp.defaultValue; return; }
      try {
        const out = await pub(a + '/buckets/' + inp.dataset.roomrename, {
          method: 'POST', json: { room_name: name } });
        // the Worker renamed the saved schedule's copy; the one held here
        // (saved or mid-edit) follows by the same rule, so a later save
        // doesn't undo it
        const bid = Number(inp.dataset.roomrename);
        const was = buckets.find((b) => b.id === bid);
        if (was) {
          followRoomRename(sched, was, name, [...buckets, bye].filter(Boolean).map((b) => b.id));
          // held from the copy the Worker renamed (sched_was), it is now
          // the renamed copy's (sched_etag), so its next save isn't asked
          if (out && out.sched_was && out.sched_was === schedEtag) schedEtag = out.sched_etag;
        }
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

// A mirror's rounds against its set's packets: which packet (and version)
// each round reads, with a picker to put any packet on any round.
function setPacketsHtml(slots, rounds, files) {
  const versions = lastDetail.set_packets || [];
  const current = versions.filter((v) => !v.retired);
  const played = new Set(files.filter(isGameFile).map((f) => f.round));
  const rows = Array.from({ length: slots }, (_, i) => i + 1).map((n) => {
    const r = rounds.find((x) => x.number === n);
    const v = r && versions.find((x) => x.r2_key === r.packet_r2_key);
    const newer = v && current.find((x) => x.packet === v.packet && x.version !== v.version);
    // the same packet on two rounds is almost always a leftover of a reshuffle
    const twice = v ? rounds.filter((x) => x.number !== n
      && (versions.find((y) => y.r2_key === x.packet_r2_key) || {}).packet === v.packet).map((x) => x.number) : [];
    const what = !r ? '<span class="muted">—</span>'
      : !v ? 'Your own packet <span class="muted">(not part of the set&rsquo;s stats)</span>'
        : `Packet ${v.packet} <span class="muted">v${v.version}${
          newer ? ` — the set is on v${newer.version}; this round stays on what it was opened with` : ''}</span>${
          twice.length ? ` <span class="bad">also on round ${twice.join(', ')}</span>` : ''}`;
    return `<tr><td class="roundcell">${n}</td><td class="name">${what}</td>
      <td>${played.has(n) ? '<span class="muted">Played</span>' : `
        <select data-setpacket="${n}">
          <option value="">Change…</option>
          ${current.map((c) => `<option value="${c.packet}">Packet ${c.packet}</option>`).join('')}
          ${r ? '<option value="none">No packet</option>' : ''}
        </select>`}</td></tr>`;
  }).join('');
  return `
    <details style="margin-top:10px" open>
      <summary class="muted">Which packet each round reads</summary>
      <div class="muted" style="font-size:13px;margin:6px 0">The set numbers its packets; the rounds are yours. Put any packet
        on any round — skip one, reorder them, keep some for playoffs. Set-wide stats follow the packet, not the round.</div>
      <div class="tablewrap"><table>
        <tr><th>Round</th><th class="name">Reads</th><th></th></tr>${rows}
      </table></div>
    </details>`;
}

const JOIN_HTML = `
  <details style="margin-top:10px"><summary class="muted">Join a set</summary>
    <div class="muted" style="font-size:13px;margin:6px 0">Mirroring a set whose editors use qb-td? Paste the invite
      link they sent. This tournament becomes the set&rsquo;s mirror as it stands: packets you have uploaded stay,
      the set fills the rounds still empty, and everything the rooms upload — results and game files,
      MODAQ&rsquo;s included — is shared with the set&rsquo;s editors. It cannot be undone.</div>
    <div class="row">
      <input id="joininvite" placeholder="Invite link" size="44">
      <button id="joinbtn">Join set</button>
    </div>
  </details>`;

function renderPacketsSec(a, t, buckets, rounds, settings) {
  const fromSet = (r) => t.set && r.packet_r2_key.startsWith('s/');
  const slots = roundCount(t, rounds, settings);
  const fromSched = schedRoundCount();
  // the fewest rounds the TD can shrink to: the schedule's, a live round,
  // or the last round holding a packet
  const minSlots = Math.max(1, fromSched, t.current_round, ...rounds.map((r) => r.number));
  renderPacketsUi($('setupsec'), {
    staged,
    slots,
    afterPackets: t.set ? setPacketsHtml(slots, rounds, lastDetail.files) : JOIN_HTML,
    rounds: rounds.map((r) => ({
      number: r.number,
      name: r.packet_name + (fromSet(r) ? ' (from ' + t.set.name + ')' : ''),
      href: `${API}${a}/file?key=${encodeURIComponent(r.packet_r2_key)}&dl=${encodeURIComponent(r.packet_name)}`,
    })),
    setSlots: (n) => pub(a, { method: 'POST', json: settingsBody(settings, { ...settings, rounds: n }, {}, ['rounds']) }),
    minSlots,
    countNote: fromSched ? (slots > fromSched ? `the schedule has ${fromSched}` : 'from the schedule') : '',
    uploadPacket: (s, round) => pub(`${a}/packet?round=${round}&name=${encodeURIComponent(s.name)}`,
      { method: 'POST', body: stagedBlob(s) }),
    // a set's mirror keeps its rounds: the set re-points them by number
    movePacket: t.set ? null : (from, to) => pub(`${a}/packets/move`, { method: 'POST', json: { from, to } }),
    roundGames: (k) => ((lastDetail && lastDetail.files) || []).filter((f) => f.round === k && !f.error).length,
    // one per pair of teams, as the stats count them; a MODAQ game file or
    // a forfeit has no buzzpoints of its own
    packetGames: (k) => new Set(((lastDetail && lastDetail.files) || [])
      .filter((f) => f.round === k && isGameFile(f) && !isForfeitFile(f))
      .map((f) => { const s = uploadedSummary(f); return s && s.teams ? [...s.teams].sort().join('\n') : 'file ' + f.id; })).size,
    uploadTb: async (name, data) => {
      try {
        const out = await pub(`${a}/tiebreakers?name=${encodeURIComponent(name)}`,
          { method: 'POST', body: new Blob([data], { type: 'application/json' }) });
        say(tbSplitNote(name, out.added));
        return true;
      } catch (e) { say(e.message, true); return false; }
    },
    clearTb: () => pub(a + '/tiebreakers', { method: 'DELETE' }),
    removeTb: (id) => pub(a + '/tiebreakers?id=' + encodeURIComponent(id), { method: 'DELETE' }),
    pool: tbPool,
    showUses: true,
    intro: `Each round's room links load the packet assigned to it. Upload a zip or files, then
      assign by filename or drag a packet onto a round.`,
    packetsNote: t.set ? `The rounds of <b>${esc(t.set.name)}</b> are already here, and a fix its
      editors upload reaches every round no room here has opened yet. A packet you
      upload yourself replaces that round for good — the set stops updating it, and its
      games drop out of the set&rsquo;s category stats and buzzpoints.` : '',
    tbTitle: t.set ? 'Backup questions + tiebreakers' : 'Tiebreakers',
    tbNote: (t.set ? `The set&rsquo;s own backup questions are listed first, and its editors may add to them
      during the day; anything you upload here is added after them, for this tournament only, and Delete pool
      removes only yours. ` : '') + `Upload a tiebreaker packet to split individual questions. Tiebreaker
      questions will appear in every room&rsquo;s MODAQ via
      <b>Actions &rarr; Add questions</b>.`,
    say, rerender: render, refresh: showDetail,
  });
  const box = $('setupsec');
  box.querySelectorAll('[data-setpacket]').forEach((sel) => {
    sel.onchange = async () => {
      if (!sel.value) return;
      try {
        const round = Number(sel.dataset.setpacket);
        await pub(a + '/setpacket', { method: 'POST',
          json: { round, packet: sel.value === 'none' ? null : Number(sel.value) } });
        say(sel.value === 'none' ? `Round ${round} has no packet now` : `Round ${round} reads packet ${sel.value}`);
        showDetail();
      } catch (e) { say(e.message, true); sel.value = ''; }
    };
  });
  if ($('joinbtn')) {
    $('joinbtn').onclick = async () => {
      // the link as pasted (…?i=<invite>), or the bare invite
      const pasted = $('joininvite').value.trim();
      const invite = (/[?&]i=([a-z0-9]+)/.exec(pasted) || [null, pasted])[1];
      if (!confirm('Join this set? Everything the rooms upload here will be shared with its editors.')) return;
      try {
        const out = await pub(a + '/join', { method: 'POST', json: { invite } });
        say(`Joined ${out.set}: ${out.rounds} empty round${out.rounds === 1 ? '' : 's'} filled from the set`);
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  }
}

/* ---------- Roster: structured editor, seed order ---------- */

// What stops the roster saving, each with the editor cell it's about
// (t<team> or p<team>.<player>), which the grid outlines.
function rosterProblemCells() {
  const problems = [];
  const at = (key) => (msg) => problems.push({ key, msg });
  const seen = new Set();
  // a name another team had: its games would move to whoever takes it
  const earlier = new Map();
  (rosterTeams || []).forEach((tm) => {
    for (const n of [...formerTeamNames(tm), ...(tm.was && tm.was !== tm.name.trim() ? [tm.was] : [])]) earlier.set(n, tm);
  });
  (rosterTeams || []).forEach((tm, i) => {
    if (rosterBlankRow(tm)) return; // an empty row of the grid: not a team
    const name = tm.name.trim();
    if (!name) at('t' + i)('Team ' + (i + 1) + ' has no name');
    else if (seen.has(name)) at('t' + i)('Duplicate team: ' + name);
    seen.add(name);
    const other = earlier.get(name);
    if (name && other && other !== tm) {
      at('t' + i)(`${name} was the name of ${other.name.trim() || 'another team'}. Please choose another name, so its games stay with it`);
    }
    if (!tm.players.some((p) => p.trim())) {
      at('p' + i + '.0')((name || 'Team ' + (i + 1)) + ' has no players');
    }
    const pseen = new Set();
    const pEarlier = new Map();
    tm.players.forEach((p, pi) => {
      const o = tm.orig[pi];
      for (const n of [...formerPlayerNames(tm, pi), ...(o && o !== p.trim() ? [o] : [])]) pEarlier.set(n, pi);
    });
    tm.players.forEach((p, pi) => {
      const pn = p.trim();
      if (!pn) return;
      if (pseen.has(pn)) at(`p${i}.${pi}`)(`Duplicate player on ${name || 'Team ' + (i + 1)}: ${pn}`);
      pseen.add(pn);
      const was = pEarlier.get(pn);
      if (was !== undefined && was !== pi) {
        at(`p${i}.${pi}`)(`${pn} was the name of ${tm.players[was].trim() || 'another player'} on ${name || 'Team ' + (i + 1)}. Please choose another name, so their games stay with them`);
      }
    });
  });
  return problems;
}
const rosterProblems = () => rosterProblemCells().map((x) => x.msg);
// the names a team or a player had before the saved roster's
const formerTeamNames = (tm) => tm.formerNames || [];
const formerPlayerNames = (tm, pi) => (tm.orig[pi] && (tm.formerPlayers || {})[tm.orig[pi]]) || [];
// What the editor renamed, against the saved roster: {old: new} for
// teams, and {team: {old: new}} for players (by the team's new name).
function editorRenames(clean) {
  const teams = {};
  const players = {};
  rosterTeams.forEach((tm, i) => {
    if (tm.was && tm.was !== clean[i].name) teams[tm.was] = clean[i].name;
    tm.players.forEach((p, pi) => {
      const o = tm.orig[pi];
      if (o && p.trim() && p.trim() !== o) (players[clean[i].name] ||= {})[o] = p.trim();
    });
  });
  return { teams, players };
}
function cleanRosterTeams() {
  return rosterTeams.map((tm) => {
    const out = { name: tm.name.trim(), players: [] };
    const marks = {};
    tm.players.forEach((p, pi) => {
      const pn = p.trim();
      if (!pn) return;
      out.players.push(pn);
      const f = tm.flags[pi] || {};
      const ug = rosterTrack.trackUG && !!f.ug;
      const d2 = rosterTrack.trackDiv2 && !!f.d2;
      if (ug || d2) marks[pn] = { ug, d2 };
    });
    if (Object.keys(marks).length) out.marks = marks;
    return out;
  });
}
const blankRosterTeam = () => ({ name: '', players: ['', '', '', ''], flags: [{}, {}, {}, {}], orig: ['', '', '', ''] });
// what a team in the editor would be marked as saved, as tags
function teamTagsHtml(tm) {
  const names = [];
  const marks = {};
  tm.players.forEach((p, pi) => { if (p.trim()) { names.push(p.trim()); marks[p.trim()] = tm.flags[pi] || {}; } });
  const m = teamMarks(names, marks, rosterTrack);
  return (m.ug ? '<span class="ntag" title="Every player is UG or DII, and not all are DII">UG</span>' : '')
    + (m.d2 ? '<span class="ntag d2" title="Every player is DII">DII</span>' : '');
}
// parseRoster's teams as the editor holds them, and the switches they set
function editRoster(parsed) {
  rosterTrack = rosterTracking(parsed);
  return parsed.map((tm) => ({
    name: tm.name, players: [...tm.players], was: tm.name,
    flags: tm.players.map((p) => ({ ...((tm.marks || {})[p] || {}) })),
    orig: [...tm.players], formerNames: tm.formerNames, formerPlayers: tm.formerPlayers,
  }));
}
// how many teams and players an uploaded roster marks, for its preview
function markCounts(teams) {
  const track = rosterTracking(teams);
  const count = (k) => teams.filter((tm) => tm[k]).length
    + teams.reduce((n, tm) => n + Object.values(tm.marks || {}).filter((m) => m[k]).length, 0);
  return [track.trackUG && `${count('ug')} UG`, track.trackDiv2 && `${count('d2')} DII`].filter(Boolean);
}

// Hidden debug aid: with ?debug in the hub's URL the Roster step offers a
// preset roster, so a test tournament on the live site can be set up in
// one click. It goes through the ordinary upload preview and confirm, and
// only ever touches the tournament this admin link opens. The flag sticks
// to this browser (links from the tournament list don't carry ?debug)
// until a visit with ?debug=0.
const DEBUG = (() => {
  const v = new URLSearchParams(location.search).get('debug');
  try {
    if (v === '0') localStorage.removeItem('qbtdDebug');
    else if (v !== null) localStorage.setItem('qbtdDebug', '1');
    return localStorage.getItem('qbtdDebug') === '1';
  } catch (e) { return v !== null && v !== '0'; }
})();
const TEST_TEAMS = ['Stanford', 'Berkeley', 'UIUC', 'ASU', 'Chicago', 'Michigan', 'Yale', 'Penn',
  'Rutgers', 'Columbia', 'Minnesota', 'Georgia Tech', 'Harvard', 'MIT', 'Duke', 'Virginia',
  'Cornell', 'Brown', 'Ohio State', 'Maryland', 'Texas', 'UCLA', 'Johns Hopkins', 'Rice'];
const TEST_FIRST = ['Ava', 'Marcus', 'Priya', 'Sam', 'Jordan', 'Eli', 'Nora', 'Theo', 'Mina', 'Leo', 'Iris', 'Ben', 'Ruth', 'Omar'];
const TEST_LAST = ['Chen', 'Lee', 'Rao', 'Ortiz', 'Kim', 'Brooks', 'Patel', 'Grant', 'Park', 'Hart', 'Novak', 'Adler', 'Diaz'];
function testRoster(n, tricky) {
  const teams = TEST_TEAMS.slice(0, n).map((name, ti) => ({
    name,
    players: Array.from({ length: 4 }, (_, p) =>
      TEST_FIRST[(ti * 3 + p) % TEST_FIRST.length] + ' ' + TEST_LAST[(ti * 5 + p * 7) % TEST_LAST.length]),
  }));
  if (tricky && teams.length >= 2) {
    // names that have broken naive CSV/quote handling before
    teams[1] = { name: 'St. John\'s "A"', players: ['Smith, Jr.', 'O\'Brien', 'José Núñez', 'Lee-Park'] };
  }
  return teams;
}

function renderRosterSec(a, t) {
  const box = $('setupsec');
  // Download gives the roster as it leaves qb-td (part=roster, worker.js
  // adminDownload): without the former names only qb-td reads
  box.innerHTML = `
    <h2>Roster</h2>
    <div class="row">
      ${t.roster_name
        ? `<span>${esc(t.roster_name)}</span>
           <a id="rosterget" href="${esc(`${API}${a}/file?key=${encodeURIComponent(t.roster_r2_key)}&dl=${encodeURIComponent(t.roster_name)}&part=roster`)}" download>Download</a>`
        : '<span class="muted">None yet</span>'}
      <span class="spacer" style="flex:1"></span>
      <button id="pickroster">Upload roster QBJ</button>
      <input id="rfile" type="file" accept=".qbj,.json" hidden>
      <button id="editroster">${t.roster_name ? 'Edit roster' : 'Create roster'}</button>
    </div>
    ${DEBUG ? `<div class="row debugrow">
      <span class="muted">Debug</span>
      <label>Test roster <select id="dbgteams">${[4, 6, 8, 12, 16, 24].map((n) =>
        `<option value="${n}" ${n === 12 ? 'selected' : ''}>${n} teams</option>`).join('')}</select></label>
      <label class="row" style="gap:6px"><input type="checkbox" id="dbgtricky"> tricky names</label>
      <button id="dbgroster" class="small">Load</button>
    </div>` : ''}
    <div id="upreview"></div>
    <div id="rosteredit" style="margin-top:12px"></div>`;
  if (DEBUG) {
    $('dbgroster').onclick = () => {
      const teams = testRoster(Number($('dbgteams').value), $('dbgtricky').checked);
      rosterUpload = { filename: `test-roster-${teams.length}.qbj`,
        text: JSON.stringify(buildRosterQbj(t.name, teams)), teams };
      renderUpPreview(a);
    };
  }
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
          const got = await readTagged(a, t.roster_r2_key);
          rosterSaved = parseRoster(got.json);
          rosterTeams = editRoster(rosterSaved);
          rosterEtag = got.etag;
        } catch (e) { /* unparseable upload: start blank */ }
      }
      if (rosterTeams === null) {
        rosterTrack = { trackUG: false, trackDiv2: false };
        rosterSaved = null;
        rosterEtag = null;
        rosterTeams = [blankRosterTeam()];
      }
    }
    renderRosterEditor(a, t);
  };
  renderUpPreview(a);
  renderRosterEditor(a, t);
}

// What an uploaded roster renames, against the saved one ({} if none),
// and that saved copy's etag (null if none), which the upload's save
// names: renames matched against a roster saved over since are not kept
// without asking.
async function upRenames(a) {
  const t = lastDetail.tournament;
  if (!t.roster_r2_key || !rosterUpload) return { renames: {}, etag: null };
  try {
    const got = await readTagged(a, t.roster_r2_key);
    return { renames: rosterRenames(parseRoster(got.json), rosterUpload.teams), etag: got.etag };
  } catch (e) { return { renames: {}, etag: null }; }
}

// A roster save that lands only on the copy this tab read (etag, saves.js).
// One saved in another tab since then asks first; null when the TD keeps
// theirs unsaved.
async function saveRoster(a, name, body, etag) {
  let out = await postRoster(a, name, body, etag);
  while (out && out.conflict) {
    if (!confirm(ROSTER_CONFLICT)) return null;
    out = await postRoster(a, name, body, out.etag);
  }
  return out;
}

function renderUpPreview(a) {
  const box = $('upreview');
  if (!box) return;
  if (!rosterUpload) { box.innerHTML = ''; return; }
  const u = rosterUpload;
  // Renamed teams, matched against the roster being replaced: shown here
  // before saving, and followed into the schedule on save
  if (u.renames === undefined) {
    u.renames = null;
    upRenames(a).then((r) => {
      // (unless a save of this upload has set them since: below)
      if (u.renames === null) { u.renames = r.renames; u.etag = r.etag; }
      if (rosterUpload === u) renderUpPreview(a);
    });
  }
  const renamed = Object.entries(u.renames || {});
  box.innerHTML = `
    <div class="card" style="margin-top:8px">
      <div class="row">
        <b>${esc(u.filename)}</b>
        <span class="pill">${u.teams.length} teams &middot; ${
          u.teams.reduce((n, tm) => n + tm.players.length, 0)} players${
          markCounts(u.teams).map((x) => ' &middot; ' + x).join('')}</span>
        <span class="spacer" style="flex:1"></span>
        <button id="upconfirm" class="primary">Save as tournament roster</button>
        <button id="upcancel">Cancel</button>
      </div>
      <div class="muted" style="font-size:13px;margin-top:4px">${
        u.teams.slice(0, 4).map((tm) => esc(tm.name)).join(' &middot; ')}${
        u.teams.length > 4 ? ' &hellip;' : ''}</div>
      ${renamed.length ? `<div style="font-size:13px;margin-top:6px">Renamed teams, matched by their players.
        The schedule will use the new names: ${renamed.map(([x, y]) => `${esc(x)} &rarr; <b>${esc(y)}</b>`).join(' &middot; ')}</div>` : ''}
    </div>`;
  // A second press while a save of this upload is out waits for it, then
  // saves once more onto the copy that save left (u.etag): two presses
  // save twice, as they always did, and the second isn't asked about the
  // first.
  $('upconfirm').onclick = () => { u.queue = (u.queue || Promise.resolve()).then(() => saveUpload(a, u)); };
  $('upcancel').onclick = () => { rosterUpload = null; renderUpPreview(a); };
}

// The upload's save (renderUpPreview's Save as tournament roster).
async function saveUpload(a, u) {
  try {
    const t = lastDetail.tournament;
    const pre = u.renames ? { renames: u.renames, etag: u.etag } : await upRenames(a);
    const renames = pre.renames;
    // the saved roster's former names carry over, and a renamed team
    // adds its old name, so games already played follow it
    let saved = null;
    let savedEtag = null;
    if (t.roster_r2_key) {
      try {
        const got = await readTagged(a, t.roster_r2_key);
        savedEtag = got.etag;
        saved = parseRoster(got.json);
      } catch (e) { /* none to carry */ }
    }
    const teams = carryFormerNames(saved, u.teams, renames);
    // Save the roster rebuilt from its parsed teams, not the file as
    // uploaded: MODAQ reads only a versioned tournament with a name, and
    // a file qb-td can parse may be neither. Names are all either keeps.
    // It lands on the copy the renames were matched against, else the
    // one just read.
    const out = await saveRoster(a, u.filename,
      JSON.stringify(buildRosterQbj(lastDetail.tournament.name, teams, rosterTracking(teams))), pre.etag || savedEtag);
    if (!out) { say(ROSTER_KEPT, true); return; }
    u.renames = renames;
    u.etag = out.etag;
    hubNames.key = null; // the hub's listings follow the new names
    rosterUpload = null;
    rosterTeams = null;   // editor reloads from the new roster
    schedFetched = false; // schedule editor re-reads the team list
    // …and has the new names at once, so a schedule generated before
    // that refetch lands is built from this roster, not the last one
    schedTeams = u.teams.map((tm) => tm.name);
    say(await savedNote(a, t, renames));
    showDetail();
  } catch (e) { say('Roster: ' + e.message, true); }
}

// The roster editor: a sheet, one team a row in seed order and its
// players across. Typing changes the working copy and refreshes the cells'
// marks in place (a re-render would take the focus, and the input's own
// undo with it); a new team or player column, a paste, a move or a click
// on a cell's button re-renders and puts the focus back (`focus`: the
// cell, as {r, c}, c -1 for the team name).
// the grid's widths (td.css .rgrid col): seed, team, +, × and each player
// column; five player columns fit the Setup pane, more scroll sideways
const RGRID_FIXED = 44 + 150 + 30 + 30;
const RGRID_PLAYER = 110;
const rosterBlankRow = (tm) => !tm.name.trim() && !tm.players.some((p) => p.trim());
const newRosterRow = () => ({ name: '', players: [], flags: [], orig: [] });
// After Start a saved name can't be typed over: ✎ opens its Rename box, so
// changing it is plainly a rename that its games follow. Before Start there
// are no games to follow a name, and the grid is a plain sheet.
let rosterLive = false;
// the name a cell had in the saved roster ('' for one added here)
const savedNameAt = (tm, c) => (!tm ? '' : c < 0 ? (tm.was || '') : (tm.orig[c] || ''));
const nameAt = (tm, c) => (!tm ? '' : c < 0 ? tm.name : (tm.players[c] || ''));
function setRosterPlayer(tm, ci, v) {
  while (tm.players.length <= ci) { tm.players.push(''); tm.flags.push({}); tm.orig.push(''); }
  tm.players[ci] = v;
}
function renderRosterEditor(a, t, focus = null) {
  const box = $('rosteredit');
  if (!box) return;
  if (!rosterOpen || rosterTeams === null) { box.innerHTML = ''; return; }
  rosterLive = !!t.started;
  const ncols = Math.max(5, ...rosterTeams.map((tm) => tm.players.length));
  const nrows = rosterTeams.length;
  // teams are not marked by hand: how they come to be, on hover
  const teamRule = rosterTrack.trackUG && rosterTrack.trackDiv2
    ? 'A team is DII when all its players are DII. Otherwise it is UG when all are UG or DII.'
    : rosterTrack.trackUG ? 'A team is UG when all its players are UG.'
      : rosterTrack.trackDiv2 ? 'A team is DII when all its players are DII.' : '';
  const locked = (tm, c) => rosterLive && !!savedNameAt(tm, c);
  const cell = (r, c) => {
    const tm = rosterTeams[r];
    const v = nameAt(tm, c);
    const key = c < 0 ? `t${r}` : `p${r}.${c}`;
    return `<td data-cell="${key}" class="${c < 0 ? 'rteam' : ''}${savedNameAt(tm, c) ? ' rsaved' : ''}"><div class="rcell">
      <input data-r="${r}" data-c="${c}" value="${esc(v)}" autocomplete="off" spellcheck="false" ${locked(tm, c) ? 'readonly' : ''}
        aria-label="${c < 0 ? `Team ${r + 1}` : `Team ${r + 1} player ${c + 1}`}">
      <span class="rcx"></span></div></td>`;
  };
  box.innerHTML = `
    <div class="rtrack">
      <label title="${esc(teamRule)}"><input type="checkbox" id="trackug" ${rosterTrack.trackUG ? 'checked' : ''}>Track Undergrad</label>
      <label title="${esc(teamRule)}"><input type="checkbox" id="trackd2" ${rosterTrack.trackDiv2 ? 'checked' : ''}>Track Division II</label>
    </div>
    <div class="rgridwrap"><table class="rgrid" style="min-width:${RGRID_FIXED + ncols * RGRID_PLAYER}px">
      <colgroup><col class="rseed"><col class="rteam">${'<col>'.repeat(ncols)}<col class="radd"><col class="rdel"></colgroup>
      <thead><tr><th class="rseed">Seed</th><th>Team</th>${
        Array.from({ length: ncols }, (_, c) => `<th>Player ${c + 1}</th>`).join('')}<th class="radd">+</th><th class="rdel"></th></tr></thead>
      <tbody>${Array.from({ length: nrows + 1 }, (_, r) => `
        <tr data-row="${r}" class="${r === nrows ? 'rnew' : ''}">
          <th class="rseed" ${r < nrows ? `draggable="true" data-seed="${r}"` : ''}>${r + 1}</th>
          ${Array.from({ length: ncols + 2 }, (_, k) => cell(r, k - 1)).join('')}
          <td class="rdel">${r < nrows ? `<button class="xbtn" data-delteam="${r}" title="Remove team" tabindex="-1">&times;</button>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <div class="row" style="margin-top:10px">
      <button id="rosterdl">Download roster QBJ</button>
      <button id="rostersave" class="primary">Save</button>
    </div>`;

  const rerender = (f) => renderRosterEditor(a, t, f);
  // a cell's marks: renamed (tint, ↺, and for a player, keep both as two
  // players), a problem (red outline, the reason on hover), former names
  // on hover, and the UG / DII tags while they are tracked
  const refresh = () => {
    const probs = new Map();
    for (const p of rosterProblemCells()) if (!probs.has(p.key)) probs.set(p.key, p.msg);
    box.querySelectorAll('td[data-cell]').forEach((td) => {
      const key = td.dataset.cell;
      const inp = td.querySelector('input');
      const r = Number(inp.dataset.r);
      const c = Number(inp.dataset.c);
      const tm = rosterTeams[r];
      let renamed = false;
      let title = '';
      let extra = '';
      if (tm && c < 0) {
        const now = tm.name.trim();
        renamed = rosterLive && !!(tm.was && now && now !== tm.was);
        const former = [...(renamed ? [tm.was] : []), ...formerTeamNames(tm).filter((n) => n !== now)];
        if (former.length) title = 'Formerly ' + former.join(', ');
        if (renamed) extra += `<button class="rbtn" data-tundo="${r}" title="Undo rename" tabindex="-1">&#8634;</button>`;
        if (rosterLive && tm.was) extra += `<button class="rbtn rpen" data-rename="${r}.${c}" title="Rename" tabindex="-1">&#9998;</button>`;
        extra += teamTagsHtml(tm);
      } else if (tm) {
        const now = (tm.players[c] || '').trim();
        const o = tm.orig[c];
        renamed = rosterLive && !!(o && now && now !== o);
        const former = [...(renamed ? [o] : []), ...(o ? formerPlayerNames(tm, c) : []).filter((n) => n !== now)];
        if (former.length) title = 'Formerly ' + former.join(', ');
        if (renamed) extra += `<button class="rbtn" data-pundo="${r}.${c}" title="Undo rename" tabindex="-1">&#8634;</button>`;
        if (rosterLive && o) {
          extra += `<button class="rbtn rpen" data-rename="${r}.${c}" title="Rename" tabindex="-1">&#9998;</button>
            <button class="rbtn rpen" data-pclear="${r}.${c}" title="Remove player" tabindex="-1">&times;</button>`;
        }
        if (now) {
          const f = tm.flags[c] || {};
          const tag = (k, label) => `<button class="rtag ${k}${f[k] ? ' on' : ''}" data-pmark="${r}.${c}.${k}" tabindex="-1">${label}</button>`;
          extra += (rosterTrack.trackUG ? tag('ug', 'UG') : '') + (rosterTrack.trackDiv2 ? tag('d2', 'DII') : '');
        }
      }
      const bad = probs.get(key);
      td.classList.toggle('rnamed', renamed);
      td.classList.toggle('rbad', !!bad);
      td.title = bad || title;
      const x = td.querySelector('.rcx');
      if (x.innerHTML !== extra) x.innerHTML = extra;
    });
    const off = probs.size > 0 || !rosterTeams.some((tm) => !rosterBlankRow(tm));
    $('rostersave').disabled = off;
    $('rosterdl').disabled = off;
  };
  refresh();

  const focusCell = (r, c, caret = 'end') => {
    const inp = box.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
    if (!inp) return false;
    inp.focus();
    const n = caret === 'start' ? 0 : inp.value.length;
    inp.setSelectionRange(n, n);
    return true;
  };
  if (focus) focusCell(focus.r, focus.c);

  // the Rename box, under the cell
  const closePop = () => { const p = box.querySelector('.rpop'); if (p) p.remove(); };
  const openPop = (r, c, html, wire) => {
    closePop();
    const td = box.querySelector(`input[data-r="${r}"][data-c="${c}"]`).closest('td');
    const pop = document.createElement('div');
    pop.className = 'rpop';
    pop.innerHTML = html;
    const at = td.getBoundingClientRect();
    const base = box.getBoundingClientRect();
    pop.style.top = (at.bottom - base.top + 4) + 'px';
    pop.style.left = Math.max(0, at.left - base.left) + 'px';
    box.appendChild(pop);
    wire(pop);
  };
  const openRename = (r, c, typed = null) => {
    const tm = rosterTeams[r];
    const was = savedNameAt(tm, c);
    openPop(r, c, `<div class="rpophead">Rename <b>${esc(was)}</b></div>
      <div class="row"><input id="rpopname" value="${esc(typed === null ? nameAt(tm, c) : typed)}" autocomplete="off" spellcheck="false">
      <button id="rpopok" class="primary small">Rename</button><button id="rpopno" class="small">Cancel</button></div>`, (pop) => {
      const inp = pop.querySelector('#rpopname');
      inp.focus();
      if (typed === null) inp.select();
      const ok = () => {
        const v = inp.value.trim();
        if (!v) return;
        if (c < 0) tm.name = v; else tm.players[c] = v;
        rerender({ r, c });
      };
      pop.querySelector('#rpopok').onclick = ok;
      pop.querySelector('#rpopno').onclick = () => { closePop(); focusCell(r, c); };
      inp.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); ok(); }
        if (ev.key === 'Escape') { ev.preventDefault(); closePop(); focusCell(r, c); }
      };
    });
  };
  const tbody0 = box.querySelector('tbody');
  // typing on a saved name, Enter or F2 opens its Rename box
  {
    tbody0.addEventListener('keydown', (ev) => {
      const inp = ev.target.closest('input[data-r][readonly]');
      if (!inp || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const r = Number(inp.dataset.r);
      const c = Number(inp.dataset.c);
      if (ev.key === 'Enter' || ev.key === 'F2') { ev.preventDefault(); ev.stopImmediatePropagation(); openRename(r, c); }
      else if (ev.key.length === 1) { ev.preventDefault(); ev.stopImmediatePropagation(); openRename(r, c, ev.key); }
    }, true);
  }

  $('trackug').onchange = () => { rosterTrack.trackUG = $('trackug').checked; rerender(); };
  $('trackd2').onchange = () => { rosterTrack.trackDiv2 = $('trackd2').checked; rerender(); };

  const tbody = box.querySelector('tbody');
  tbody.oninput = (ev) => {
    const inp = ev.target.closest('input[data-r]');
    if (!inp) return;
    closePop();
    const r = Number(inp.dataset.r);
    const c = Number(inp.dataset.c);
    // typing in the empty last row adds a team; in the + column, a player column
    const grows = r === rosterTeams.length || c === ncols;
    if (r === rosterTeams.length) rosterTeams.push(newRosterRow());
    const tm = rosterTeams[r];
    if (c < 0) tm.name = inp.value; else setRosterPlayer(tm, c, inp.value);
    if (grows) rerender({ r, c }); else refresh();
  };

  // Sheet keys: arrows, Enter down (Shift+Enter up), left and right at
  // the ends of the text; Alt+Up/Down moves the team a seed.
  tbody.onkeydown = (ev) => {
    const inp = ev.target.closest('input[data-r]');
    if (!inp) return;
    const r = Number(inp.dataset.r);
    const c = Number(inp.dataset.c);
    const atStart = inp.selectionStart === 0 && inp.selectionEnd === 0;
    const atEnd = inp.selectionStart === inp.value.length && inp.selectionEnd === inp.value.length;
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      const to = r + (ev.key === 'ArrowUp' ? -1 : 1);
      if (r < rosterTeams.length && to >= 0 && to < rosterTeams.length) {
        ev.preventDefault();
        moveTeam(r, to, c);
      }
      return;
    }
    let to = null;
    if (ev.key === 'ArrowUp' || (ev.key === 'Enter' && ev.shiftKey)) to = [r - 1, c];
    else if (ev.key === 'ArrowDown' || ev.key === 'Enter') to = [r + 1, c];
    else if (ev.key === 'ArrowLeft' && atStart) to = [r, c - 1];
    else if (ev.key === 'ArrowRight' && atEnd) to = [r, c + 1];
    if (to && focusCell(to[0], to[1], ev.key === 'ArrowRight' ? 'start' : 'end')) ev.preventDefault();
  };

  // A block of cells pasted into a cell fills the grid from there, adding
  // teams and player columns as it needs; a single value pastes as text.
  tbody.onpaste = (ev) => {
    const inp = ev.target.closest('input[data-r]');
    if (!inp) return;
    const text = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || '';
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
    ev.preventDefault();
    const r0 = Number(inp.dataset.r);
    const c0 = Number(inp.dataset.c);
    pasteGrid(text).forEach((cells, i) => {
      while (rosterTeams.length <= r0 + i) rosterTeams.push(newRosterRow());
      const tm = rosterTeams[r0 + i];
      cells.forEach((v, j) => {
        const c = c0 + j;
        if (locked(tm, c)) return; // a saved name changes only by renaming it
        if (c < 0) tm.name = v; else if (v || c < tm.players.length) setRosterPlayer(tm, c, v);
      });
    });
    rerender({ r: r0, c: c0 });
  };

  const moveTeam = (from, to, c = -1) => {
    const [tm] = rosterTeams.splice(from, 1);
    rosterTeams.splice(to, 0, tm);
    say((tm.name.trim() || 'Team') + ' is now Seed ' + (to + 1));
    rerender(c === null ? null : { r: to, c });
  };
  // drag a row number onto another row to move the team there
  let dragFrom = null;
  tbody.ondragstart = (ev) => {
    const th = ev.target.closest('[data-seed]');
    if (!th) return;
    dragFrom = Number(th.dataset.seed);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(dragFrom));
  };
  const rowOf = (ev) => {
    const tr = ev.target.closest('tr[data-row]');
    return tr ? Math.min(Number(tr.dataset.row), rosterTeams.length - 1) : null;
  };
  tbody.ondragover = (ev) => {
    if (dragFrom === null) return;
    ev.preventDefault();
    const r = rowOf(ev);
    tbody.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('rdrop', Number(tr.dataset.row) === r && r !== dragFrom));
  };
  tbody.ondragend = () => { dragFrom = null; tbody.querySelectorAll('tr.rdrop').forEach((tr) => tr.classList.remove('rdrop')); };
  tbody.ondrop = (ev) => {
    if (dragFrom === null) return;
    ev.preventDefault();
    const to = rowOf(ev);
    const from = dragFrom;
    dragFrom = null;
    if (to !== null && to !== from) moveTeam(from, to, null); else rerender();
  };

  tbody.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.delteam !== undefined) {
      rosterTeams.splice(Number(b.dataset.delteam), 1);
      rerender();
    } else if (b.dataset.rename !== undefined) {
      const [r, c] = b.dataset.rename.split('.').map(Number);
      openRename(r, c);
    } else if (b.dataset.pclear !== undefined) {
      const [r, c] = b.dataset.pclear.split('.').map(Number);
      const tm = rosterTeams[r];
      tm.players.splice(c, 1); tm.flags.splice(c, 1); tm.orig.splice(c, 1);
      rerender();
    } else if (b.dataset.pmark !== undefined) {
      const [r, c, k] = b.dataset.pmark.split('.');
      const flags = rosterTeams[Number(r)].flags;
      flags[Number(c)] = { ...flags[Number(c)], [k]: !(flags[Number(c)] || {})[k] };
      refresh();
    } else if (b.dataset.tundo !== undefined) {
      const r = Number(b.dataset.tundo);
      rosterTeams[r].name = rosterTeams[r].was;
      rerender({ r, c: -1 });
    } else if (b.dataset.pundo !== undefined) {
      const [r, c] = b.dataset.pundo.split('.').map(Number);
      rosterTeams[r].players[c] = rosterTeams[r].orig[c];
      rerender({ r, c });
    }
  };

  const validated = () => {
    rosterTeams = rosterTeams.filter((tm) => !rosterBlankRow(tm));
    if (rosterProblems().length || !rosterTeams.length) { rerender(); return null; }
    return cleanRosterTeams();
  };
  $('rosterdl').onclick = () => {
    const clean = validated();
    if (!clean) return;
    download('roster.qbj', rosterFileText(buildRosterQbj(t.name, clean, rosterTrack)), 'application/json');
  };
  $('rostersave').onclick = async () => {
    const clean = validated();
    if (!clean) return;
    const run = busy($('rostersave'), { label: 'Saving' });
    const { teams: renames, players: playerRenames } = editorRenames(clean);
    // the earlier names go with the roster, so games played under them
    // count under the new ones
    const saving = carryFormerNames(rosterSaved, clean, renames, playerRenames);
    try {
      const out = await saveRoster(a, 'roster.qbj', JSON.stringify(buildRosterQbj(t.name, saving, rosterTrack), null, 2), rosterEtag);
      if (!out) { say(ROSTER_KEPT, true); run.end(); return; }
      // an upload waiting here was matched against the copy this save
      // replaced: this tab's own save, so its save isn't asked about it
      if (rosterUpload && rosterUpload.etag && rosterUpload.etag === rosterEtag) rosterUpload.etag = out.etag;
      hubNames.key = null; // the hub's listings follow the new names
      rosterTeams = null; // the editor reloads from what was saved
      rosterOpen = false;
      schedFetched = false; // schedule editor re-reads the team list
      schedTeams = clean.map((tm) => tm.name); // …and has the new names at once
      say(await savedNote(a, t, renames));
      showDetail();
    } catch (e) { say('Roster: ' + e.message, true); }
    run.end();
  };
}

// After a roster save: renamed teams keep their place in the schedule.
// The schedule holds team names, so without this a renamed team would
// stay in it under its old name, next to the new one. The saved schedule
// is rewritten and saved; a working copy with unsaved edits is renamed in
// place and stays unsaved. The save lands only on the copy read here; one
// saved in another tab meanwhile comes back, and is renamed and saved once
// more (deleted meanwhile: nothing to rename).
async function followRenames(a, t, renames) {
  if (!Object.keys(renames).length) return 0;
  let saved = null;
  let etag = null;
  try { ({ json: saved, etag } = await readTagged(a, `t/${t.id}/schedule.json`)); } catch (e) { /* none saved */ }
  let from = etag; // the copy the one saved here was renamed from
  let n = 0;
  if (saved && saved.phases && renameTeams(saved, renames)) {
    let out = await postSchedule(a, saved, etag);
    if (out && out.conflict) {
      saved = out.schedule;
      from = etag = out.etag;
      out = saved && saved.phases && renameTeams(saved, renames) ? await postSchedule(a, saved, etag) : null;
      if (out && out.conflict) throw new Error('The schedule was changed in another tab at the same moment.');
    }
    if (out) etag = out.etag;
    if (saved) n = 1;
  }
  if (sched && schedDirty) {
    n = renameTeams(sched, renames) || n;
    // edits made on the copy renamed above are edits of the renamed one
    if (schedEtag && schedEtag === from) schedEtag = etag;
  } else if (sched && saved) { sched = saved; schedEtag = etag; }
  return n;
}

async function savedNote(a, t, renames) {
  try {
    if (await followRenames(a, t, renames)) {
      return 'Roster saved. The schedule now uses the new team names.';
    }
  } catch (e) {
    return 'Roster saved, but the schedule could not be updated with the new team names: ' + e.message;
  }
  return 'Roster saved';
}

/* ---------- Schedule ----------
   The working copy lives in module state: edits are local until Save
   (POST /a/:secret/schedule). Blob fetched once per page load through
   the admin file route; roster changes invalidate the team cache. */

let sched = null;          // working schedule (or null: creator shown)
// the etag of the saved copy `sched` was read as or saved to (saves.js):
// its next save lands only on that copy, so a schedule changed in another
// tab since asks first. Moved wherever sched comes from the Worker; null
// when none is known (no base: the plain save)
let schedEtag = null;
let schedFetched = false;
let schedTeams = null;     // roster team names, seed order
let schedDirty = false;
let schedRoomsN = null;    // creator rooms input

// Fetch-once per page load (or per roster change): the roster team list
// and the saved schedule. render() needs it too — the status strip and
// upload groups read the working schedule.
async function ensureSched(a, t) {
  if (schedFetched || !t.roster_r2_key) return;
  schedFetched = true;
  // A schedule generated (or edited) while these fetches were out is newer
  // than what they bring back: keep it rather than wipe it.
  const before = sched;
  // both at once: each is a round trip to the Worker
  const [names, got] = await Promise.all([
    ownedJson(pub, a, t.roster_r2_key).then((r) => parseRoster(r).map((x) => x.name), () => []),
    readTagged(a, `t/${t.id}/schedule.json`).catch(() => null),
  ]);
  schedTeams = names;
  if (sched === before) {
    sched = got && got.json;
    schedEtag = got && got.etag;
  }
}

// The editor's Save and Generate. A schedule changed in another tab (or
// filled by a hub) since this one was loaded asks before it is replaced;
// Cancel keeps the edits here, unsaved (schededit.js says the message).
async function saveSchedule(a, s) {
  let out = await postSchedule(a, s, schedEtag);
  while (out && out.conflict) {
    if (!confirm(SCHED_CONFLICT)) throw new Error(SCHED_KEPT);
    out = await postSchedule(a, s, out.etag);
  }
  schedEtag = out && out.etag;
  return out;
}

function renderScheduleSec(a, t, buckets, files) {
  const outer = $('setupsec');
  // the heading's corner holds the editor's Full screen button (schededit.js)
  outer.innerHTML = '<div class="schedhead"><h2>Schedule</h2><button id="schedfull" class="iconbtn" hidden></button></div><div id="schedsec"></div>';
  renderSchedule(a, t, buckets, files);
}

// The step itself lives in schededit.js; this hands it the working
// schedule (which the Live Hub reads too) and the Worker calls.
function renderSchedule(a, t, buckets, files) {
  const box = $('schedsec');
  if (!box) return;
  if (!t.roster_r2_key) {
    box.innerHTML = '<div class="muted">Needs a roster first. Please create one on the Roster step.</div>';
    return;
  }
  if (schedRoomsN === null) schedRoomsN = Math.max(1, buckets.length);
  renderSchedStep(box, {
    sched: () => sched,
    setSched: (s) => { sched = s; },
    dirty: () => schedDirty,
    setDirty: (d) => { schedDirty = d; },
    teams: schedTeams || [],
    buckets,
    // rounds with a game in: pool trades close once a prelim round has one
    played: () => new Set(files.filter((f) => isGameFile(f) && Number.isInteger(f.round)).map((f) => f.round)),
    roomsN: () => schedRoomsN,
    setRoomsN: (n) => { schedRoomsN = n; },
    save: (s) => saveSchedule(a, s),
    del: () => pub(a + '/schedule', { method: 'DELETE' }).then((out) => { schedEtag = null; return out; }),
    fill: async () => {
      const { matches, roster } = await collectMatches(pub, a, t, buckets, files, () => {}, { cache: autoCache, rank: true });
      if (!matches.length) return null;
      return fillReport(sched, standings(matches, roster, gameFormat(t)));
    },
    say,
    refresh: () => render(),
  });
}

// Leaving the schedule step (or the page) with unsaved edits asks first.
function leaveSchedOk() {
  return !schedDirty || confirm('The schedule has unsaved changes. Leave without saving?');
}
window.addEventListener('beforeunload', (ev) => {
  if (!schedDirty) return;
  ev.preventDefault();
  ev.returnValue = '';
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if ($('dlpanel') && !$('dlpanel').hidden) { $('dlpanel').hidden = true; $('dlmenu').focus(); return; }
  if (cellOpen && shownView === 'live') { cellOpen = null; render(); return; }
  if (schedEscape()) render();
});

/* ================= Live Hub ================= */

// The schedule room a bucket is linked to: by id, else by name (as
// roundRooms matches them), or -1.
function schedRoomIndex(b) {
  if (!sched || !b) return -1;
  const norm = (x) => String(x || '').trim().toLowerCase();
  const i = sched.rooms.findIndex((r) => r.bucket === b.id);
  return i !== -1 ? i : sched.rooms.findIndex((r) => norm(r.name) === norm(b.room_name));
}

// A forfeit the hub recorded (recordForfeit) is named so: its summary
// carries no result, only the teams, winner first.
const isForfeitFile = (f) => !!f && /_Forfeit\.qbj$/i.test(f.filename || '');
// An upload short of its last regulation question (protests.js
// fileSummary progress): {at, of}, else null (finished, or a reader that
// doesn't say)
const unfinishedOf = (sum) => (sum && sum.progress && sum.progress.at < sum.progress.of ? sum.progress : null);
// its mark: a pie filled to the share of questions reached
const pieMark = (p) => `<span class="upie" style="--p:${Math.round((100 * p.at) / p.of)}%"></span>`;
const unfinishedTitle = (p) => `In progress: on question ${p.at} of ${p.of} at the last upload`;
const inProgress = (rows) => {
  const n = rows.filter((r) => r.state === 'partial').length;
  return n ? ` &middot; ${n} in progress` : '';
};
const unfinishedNote = (sum) => {
  const p = unfinishedOf(sum);
  return p ? ` <span class="muted">&middot; on question ${p.at} of ${p.of}</span>` : '';
};
function gameLine(sum, file, plain = false) {
  if (isForfeitFile(file)) return `<span class="win">${esc(sum.teams[0])}</span> defeats ${esc(sum.teams[1])} by forfeit`;
  if (plain) return `${esc(sum.teams[0])} <b>${sum.score[0]}</b> &ndash; <b>${sum.score[1]}</b> ${esc(sum.teams[1])}`;
  return `<span class="${sum.score[0] > sum.score[1] ? 'win' : ''}">${esc(sum.teams[0])} ${sum.score[0]}</span>
         <span class="muted">&ndash;</span>
         <span class="${sum.score[1] > sum.score[0] ? 'win' : ''}">${sum.score[1]} ${esc(sum.teams[1])}</span>`;
}

/** The two teams the schedule puts in this room this round, or null. */
function scheduledGame(b, round) {
  const i = schedRoomIndex(b);
  if (i === -1) return null;
  const r = flatRounds(sched).find((x) => x.round === round);
  const g = r && r.games.find((x) => x.room === i);
  return g && g.a && g.b ? [slotText(g.a), slotText(g.b)] : null;
}

/** The room the schedule has these two teams playing in that round, or
    null — the target of "Scheduled in X. Move it there". */
function scheduledRoomFor(teams, round) {
  if (!sched) return null;
  const buckets = lastDetail.buckets;
  const want = [...teams].map((x) => x.trim().toLowerCase()).sort().join('|');
  for (const b of buckets) {
    const g = scheduledGame(b, round);
    if (g && g.map((x) => x.trim().toLowerCase()).sort().join('|') === want) return b;
  }
  return null;
}

// What each file picked for Add a game is, so a TD sees the pair before
// it goes up: a reader upload is whole; a .qbj wants its _Game.json.
function addKind(name) {
  if (/\.qbtd\.json$/i.test(name)) return 'Reader upload';
  if (/_game\.json$/i.test(name)) return 'MODAQ game file';
  if (/\.qbj$/i.test(name)) return 'Match file';
  return 'Game file';
}
// The round each picked file says it is, as the stats read it (qbj.js
// statedRound): {name, match, round}. A match file or reader upload names
// its own; a MODAQ game file has only its name.
async function addFileRows(fs) {
  return Promise.all(fs.map(async (f) => {
    const kind = addKind(f.name);
    const match = kind === 'Match file' || kind === 'Reader upload';
    let json = null;
    if (match) { try { json = JSON.parse(await f.text()); } catch (e) { /* the upload says what is wrong */ } }
    return { name: f.name, match, round: statedRound(json, f.name) };
  }));
}
// The rounds the picked files say, from the files that carry the match
// when any of them names one: {from: the files saying one, rounds}.
function addSaid(rows) {
  const games = rows.filter((x) => x.match && x.round);
  const from = games.length ? games : rows.filter((x) => x.round);
  return { from, rounds: [...new Set(from.map((x) => x.round))].sort((x, y) => x - y) };
}
function addListHtml(rows, round) {
  if (!rows.length) return '';
  const kinds = rows.map((f) => addKind(f.name));
  const lone = kinds.includes('Match file') && !kinds.includes('MODAQ game file') && !kinds.includes('Reader upload');
  // the upload is filed, and counted, under the round picked
  const said = addSaid(rows);
  const off = Number.isInteger(round) && round >= 1 && said.rounds.some((r) => r !== round);
  const one = said.from.length === 1;
  const kind = one ? addKind(said.from[0].name) : '';
  const rounds = said.rounds.length === 1 ? `round ${said.rounds[0]}`
    : `rounds ${said.rounds.slice(0, -1).join(', ')} and ${said.rounds[said.rounds.length - 1]}`;
  return rows.map((f, i) => `<div class="addfile"><span class="mono">${esc(f.name)}</span>
      <span class="muted">${kinds[i]}</span></div>`).join('')
    + (lone ? '<div class="muted small">Stats will count it. Without the game file it can&rsquo;t be reopened in the reader.</div>' : '')
    + (off ? `<div class="warntext small" id="addwarn">${one
      ? `The ${kind.startsWith('MODAQ') ? kind : kind[0].toLowerCase() + kind.slice(1)} says` : 'The files say'} ${rounds}.
      ${one ? 'It' : 'They'} will be counted as round ${round}.</div>` : '');
}

// one listener for the page's lifetime: a click outside closes the menu
document.addEventListener('click', (ev) => {
  const p = $('dlpanel');
  if (p && !p.hidden && !ev.target.closest('.dlwrap')) {
    p.hidden = true;
    if ($('dlmenu')) $('dlmenu').setAttribute('aria-expanded', 'false');
  }
});

/* ---------- brackets: when a schedule's pools (or playoff brackets)
   keep their own rounds (engine/brackets.js). null for a round robin, no
   schedule, or a schedule saved before brackets existed — the Live Hub
   then looks exactly as it always has. ---------- */
function liveBrackets(t, buckets, files) {
  if (!sched || t.bracket_rounds === null || t.bracket_rounds === undefined) return null;
  const bm = bracketModel(sched);
  const st = bracketRounds(bm, t.current_round, t.bracket_rounds);
  if (!st.phase) return null;
  const ph = st.phase;
  const top = maxRound(st, t.current_round);
  const starts = lastDetail.starts || [];
  const early = new Set(lastDetail.early || []);
  const startedAt = (bid, n) => starts.some((x) => x.bucket_id === bid && x.round === n);
  // the upload that counts in a room's round: the newest game file
  const goodIn = (bid, n) => newestOf(files.filter((f) => f.bucket_id === bid && f.round === n));
  const rooms = buckets.map((b) => {
    const idx = roomIndexOf(bm.schedule, b);
    const rr = (lastDetail.room_rounds && lastDetail.room_rounds[b.id]) || roomRound(bm, st, idx, t.current_round);
    const key = roomBracket(bm, st, idx, t.current_round);
    const g = idx === null ? null : gameIn(bm, idx, rr);
    const file = goodIn(b.id, rr);
    const game = g && g.a && g.b ? g : null;
    // an upload for a round this room hasn't reached; a round it left
    // without its game coming in
    const ahead = files.filter((f) => f.bucket_id === b.id && early.has(f.id)).sort((x, y) => x.round - y.round)[0];
    const prev = idx === null ? null : gameIn(bm, idx, rr - 1);
    const behind = prev && prev.a && prev.b && !goodIn(b.id, rr - 1) && startedAt(b.id, rr);
    const note = ahead ? `Also uploaded a round ${ahead.round} game before round ${ahead.round} opened. Check its round number.`
      : behind ? `Round ${rr - 1} game still not in. Started round ${rr} anyway.` : '';
    return { b, idx, rr, key: game ? key : null, game, file, sum: file ? fileSummary(file) : null, note,
      started: startedAt(b.id, rr),
      state: file ? (unfinishedOf(file && fileSummary(file)) ? 'partial' : 'in') : startedAt(b.id, rr) ? 'started' : 'idle' };
  });
  const groups = ph.keys.map((key) => {
    const info = bracketInfo(bm, key);
    const rows = rooms.filter((r) => r.key === key);
    return { key, name: info ? info.name : key, color: info ? info.color : 0, round: st.rounds[key], rows,
      nIn: rows.filter((r) => r.state === 'in').length, nPartial: rows.filter((r) => r.state === 'partial').length,
      nStarted: rows.filter((r) => r.started).length };
  });
  const idle = rooms.filter((r) => !r.key);
  const all = advanceAll(bm, st, t.current_round);
  const next = bm.phases.find((x) => x.p > ph.p && x.first !== null);
  return { bm, st, ph, top, rooms, groups, idle, layout: liveLayout(groups.length), advTo: all.current,
    crosses: !Object.keys(all.rounds).length, next,
    roomOf: (bid) => rooms.find((r) => r.b.id === bid),
    // which bracket a room plays round n in, for the uploads grid
    bracketAt: (b, n) => {
      const r = rooms.find((x) => x.b.id === b.id);
      const g = r && r.idx !== null ? gameIn(bm, r.idx, n) : null;
      return g && g.a && g.b && g.bracket ? bracketInfo(bm, g.bracket) : null;
    } };
}

// "Prelims · round 3 of 5 · 1 bracket still on round 2"
function phaseLine(bk) {
  const { ph, top } = bk;
  const behind = bk.groups.filter((g) => g.round < top);
  const lows = [...new Set(behind.map((g) => g.round))];
  const n = behind.length;
  const late = !n ? ''
    : lows.length === 1 ? ` &middot; ${n} bracket${n === 1 ? '' : 's'} still on round ${lows[0]}`
    : ` &middot; ${n} brackets behind`;
  return `${esc(ph.name || 'Round')} &middot; round ${top - ph.first + 1} of ${ph.last - ph.first + 1}${late}`;
}

// Live now with brackets: a heading per bracket (its color, where it is,
// how many games are in), its rooms under it. liveLayout picks the
// two-column flow; column-count balances uneven bracket sizes.
function liveBracketsHtml(bk, fileLinks) {
  const row = (r) => {
    const game = r.sum
      ? gameLine(r.sum, r.file) + unfinishedNote(r.sum)
      : r.game ? `${esc(slotLabel(r.game.a))} <span class="muted">v</span> ${esc(slotLabel(r.game.b))}`
      : '<span class="muted">No game this round</span>';
    const acts = r.file
      ? fileLinks(r.file) + (r.file.kind === 'combined' && r.sum ? ` <button class="linkbtn" data-editfile="${r.file.id}">Edit</button>` : '')
      : r.game ? `<button class="linkbtn" data-addfor="${r.b.id}:${r.rr}">Upload</button>` : '';
    const part = r.state === 'partial' ? unfinishedOf(r.sum) : null;
    const title = r.note || (part ? unfinishedTitle(part) : r.state === 'in' ? 'Game in' : r.state === 'started' ? 'Started, not uploaded' : 'Not started');
    const mark = !r.game ? '' : r.note ? '!' : part ? pieMark(part) : r.state === 'in' ? '&#10003;' : r.state === 'started' ? '&#9675;' : '&ndash;';
    return `<div class="brow ${r.game ? '' : 'bye'}" data-room="${r.b.id}">
      <span class="bgame"><span class="bteams">${game}</span>
        <span class="broom">${esc(r.b.room_name)}<span class="lacts">${acts}</span></span>
        ${r.note ? `<span class="bnote">${esc(r.note)}</span>` : ''}</span>
      <span class="lmark ${r.note || r.state === 'idle' || r.state === 'partial' ? 'warn' : r.state === 'started' ? 'muted' : ''}" title="${esc(title)}">${mark}</span>
    </div>`;
  };
  const head = (g) => `<div class="bhead"><i class="lane-${g.color}"></i><b>${esc(g.name)}</b>
      ${g.round < bk.top ? `<span class="warntext">&middot; still on round ${g.round}</span>` : ''}
      <span class="spacer"></span>
      <span class="${g.nIn < g.rows.length ? 'warntext' : 'muted'}">${g.nIn}/${g.rows.length} in${
        g.nPartial ? ` &middot; ${g.nPartial} in progress` : ''}</span></div>`;
  const idle = bk.idle.length ? `<div class="bgroup"><div class="bhead"><i class="lane-x"></i><b>No game this round</b></div>
      ${bk.idle.map(row).join('')}</div>` : '';
  if (bk.layout === 'plain') return `<div class="bplain">${bk.groups.flatMap((g) => g.rows).map(row).join('')}${idle}</div>`;
  return `<div class="bcols">${bk.groups.map((g) => `<div class="bgroup" data-bracket="${esc(g.key)}">${head(g)}${g.rows.map(row).join('')}</div>`).join('')}${idle}</div>`;
}

// Uploads grid header with brackets: which rounds are Prelims, Playoffs…
function phaseSpans(bk, cols) {
  const segs = [];
  for (const n of cols) {
    const ph = phaseOfRound(bk.bm, n);
    const last = segs[segs.length - 1];
    if (last && last.ph === ph) last.n++;
    else segs.push({ ph, n: 1 });
  }
  return `<tr class="uphase"><th></th>${segs.map((x) =>
    `<th colspan="${x.n}">${x.ph ? `<span>${esc(x.ph.name || '')}</span>` : ''}</th>`).join('')}</tr>`;
}

// Uploads grid rows: by the bracket each room holds this round (rooms
// with no game last, unheaded), or one headless group without brackets.
function gridGroups(bk, buckets) {
  if (!bk) return [{ head: null, rows: buckets }];
  const out = bk.groups.map((g) => ({ head: g, rows: g.rows.map((r) => r.b) })).filter((g) => g.rows.length);
  if (bk.idle.length) out.push({ head: { color: 'x', name: 'No game this round' }, rows: bk.idle.map((r) => r.b) });
  return out;
}

// who else moves when the TD advances every bracket
function advNote(bk) {
  if (bk.crosses) return bk.next ? `Opens ${esc(bk.next.name || 'the next phase')} for every bracket.` : '';
  const behind = bk.groups.filter((g) => g.round < bk.top).map((g) => esc(g.name));
  if (!behind.length) return '';
  const list = behind.length === 1 ? behind[0] : behind.slice(0, -1).join(', ') + ' and ' + behind[behind.length - 1];
  return `${list} catch${behind.length === 1 ? 'es' : ''} up to round ${bk.advTo} too.`;
}

// Auto-advance with brackets: each bracket's round and starts, and its
// own Advance. No mode to pick: brackets always move on their own.
function autoBracketsHtml(bk, settings) {
  const rows = bk.rooms.filter((r) => r.key);
  const nStarted = rows.filter((r) => r.started).length;
  return `<div class="railblock">
    <label class="railtoggle"><span><b>Auto-advance</b> <span class="muted">${nStarted}/${rows.length} started</span></span>
      <input type="checkbox" id="autoadv" ${settings.autoAdvance ? 'checked' : ''}></label>
    ${settings.autoAdvance ? '<div class="muted small">Brackets will advance to the next round once each room has started the current round.</div>' : ''}
    <div class="blist">${bk.groups.map((g) => `<div class="bline" data-bline="${esc(g.key)}">
      <i class="lane-${g.color}"></i>
      <span>${esc(g.name)} <span class="${g.round < bk.top ? 'warntext' : 'muted'}">rd ${g.round}</span></span>
      <span class="muted">${g.nStarted}/${g.rows.length} started</span>
      ${g.round < bk.ph.last
        ? `<button class="linkbtn" data-advbracket="${esc(g.key)}" title="Open round ${g.round + 1} for ${esc(g.name)}">Advance</button>`
        : '<span class="muted small" title="Last round of this phase">last</span>'}
    </div>`).join('')}</div>
  </div>`;
}

function renderLive(a, t, buckets, rounds, files, settings, missing) {
  const box = $('viewbody');
  const totalRounds = roundCount(t, rounds, settings);
  const bk = liveBrackets(t, buckets, files);
  const topRound = bk ? bk.top : t.current_round;
  const intake = roundIntake(sched, t.current_round, buckets, files);
  const uploadRounds = [...new Set([
    ...Array.from({ length: t.current_round }, (_, i) => i + 1),
    ...files.map((f) => f.round).filter((n) => Number.isInteger(n) && n > 0),
  ])].sort((x, y) => y - x);
  const tbUsed = tbPool
    ? [...(tbPool.tossups || []), ...(tbPool.bonuses || [])]
        .filter((q) => (tbPool.uses || []).some((u) => u && u.q === q.id)).length
    : 0;
  const tbTotal = tbPool ? (tbPool.tossups || []).length + (tbPool.bonuses || []).length : 0;
  // protests: every upload's summary, plus those lodged in games not
  // uploaded yet, joined with the TD's rulings
  let rulings = {};
  try { rulings = JSON.parse(t.rulings || '{}') || {}; } catch (e) { /* keep {} */ }
  const roomOf = (bid) => { const b = buckets.find((x) => x.id === bid); return b ? b.room_name : '#' + bid; };
  const { rows: prows, byFile: pfiles } = protestRows(files, rulings, roomOf, lastDetail.live_protests || [], hubNames.map);
  const popen = prows.filter((r) => r.ruling === 'open');
  const openProt = protOpen === null ? !!popen.length : protOpen;

  // ---- the rooms of the current round: schedule + uploads + starts ----
  const started = new Set((lastDetail.starts || [])
    .filter((x) => x.round === t.current_round).map((x) => x.bucket_id));
  const good = isGameFile;
  const liveRooms = roundRooms(sched, t.current_round, buckets);
  const liveRows = liveRooms.map((r) => {
    const b = buckets.find((x) => x.id === r.id);
    const mine = files.filter((f) => f.bucket_id === r.id && f.round === t.current_round);
    const g = newestOf(mine);
    const sum = g ? fileSummary(g) : null;
    const planned = scheduledGame(b, t.current_round);
    const ps = g ? pfiles.get(g.id) : null;
    return { b, bye: r.bye && !g, file: g, sum, planned, openProt: ps && !ps.superseded ? ps.open : 0,
      state: g ? (unfinishedOf(sum) ? 'partial' : 'in') : started.has(r.id) ? 'started' : 'idle' };
  });
  const playing = liveRooms.filter((r) => !r.bye);
  const nStarted = playing.filter((r) => started.has(r.id)).length;
  const nextHasPacket = rounds.some((r) => r.number === t.current_round + 1);
  // Advance grays out past the schedule's last round (Set round still works)
  const pastSched = (n) => schedRoundCount() > 0 && n > schedRoundCount();

  // ---- the uploads grid: rooms down, rounds across ----
  const lastRound = Math.max(totalRounds, ...uploadRounds);
  const roundCols = Array.from({ length: lastRound }, (_, i) => i + 1);
  const cellFiles = (bid, n) => files.filter((f) => f.bucket_id === bid && f.round === n);
  const gridCell = (b, n) => {
    const fs = cellFiles(b.id, n);
    const goods = fs.filter(good);
    const errs = fs.filter((f) => f.error);
    const games = new Set(goods.map((f) => { const s = fileSummary(f); return s ? [...s.teams].sort().join('|') : f.id; }));
    const bye = sched ? roundRooms(sched, n, buckets).find((r) => r.id === b.id)?.bye : false;
    // with brackets a room is on its own round (its bracket's)
    const now = bk ? bk.roomOf(b.id).rr : t.current_round;
    const startedNow = bk ? bk.roomOf(b.id).started : started.has(b.id);
    // a room still playing a round the tournament has moved past started
    // it, so it is in progress rather than missing
    const startedThen = (lastDetail.starts || []).some((x) => x.bucket_id === b.id && x.round === n);
    let mark = '', cls = '', title = '';
    // the newest readable upload counts: ✓, or a pie while it is
    // unfinished; several uploads ride on it as a small count
    const newest = newestOf(goods);
    const part = newest ? unfinishedOf(fileSummary(newest)) : null;
    if (errs.length) { mark = '!'; cls = 'warn'; title = errs.length + ' file' + (errs.length === 1 ? '' : 's') + ' could not be read'; }
    else if (goods.length) {
      mark = `<span class="uin">${part ? pieMark(part) : '&#10003;'}${goods.length > 1 ? `<sup class="ucount">${goods.length}</sup>` : ''}</span>`;
      cls = games.size > 1 || part ? 'warn' : '';
      title = [part ? unfinishedTitle(part) : 'Game in',
        goods.length > 1 ? `${goods.length} uploads; the newest counts` : '',
        games.size > 1 ? 'they disagree on the teams' : ''].filter(Boolean).join('. ');
    }
    else if (fs.length) { mark = '&middot;'; cls = 'muted'; title = 'Game file only'; }
    else if (n > now || bye) { mark = ''; cls = 'muted'; title = bye ? 'No game this round' : ''; }
    else if (n === now) {
      mark = startedNow ? '&#9675;' : '&ndash;';
      cls = startedNow ? 'muted' : 'warn';
      title = startedNow ? 'Started, not uploaded' : 'Not started';
    } else if (startedThen) { mark = '&#9675;'; cls = 'muted'; title = 'Started, not uploaded'; }
    else { mark = '&ndash;'; cls = 'warn'; title = 'Missing'; }
    if (bk) {
      const br = bk.bracketAt(b, n);
      title = `Round ${n}${br ? ' \u00b7 ' + br.name : ''}${title ? ': ' + title : ''}`;
    }
    const sel = cellOpen && cellOpen.bid === b.id && cellOpen.round === n;
    const clickable = fs.length || (n <= now && !bye);
    return `<td class="ucell">${clickable
      ? `<button class="umark ${cls} ${sel ? 'sel' : ''}" data-cell="${b.id}:${n}" title="${esc(title)}"
          aria-label="${esc(b.room_name)}, round ${n}: ${esc(title || 'empty')}">${mark}</button>`
      : `<span class="umark ${cls}" title="${esc(title)}">${mark}</span>`}</td>`;
  };
  // a reader upload's two files named as MODAQ names its own exports, a
  // game file under the roster's current names (engine/exportfile.js
  // fileDownloads, worker.js storedFileResponse)
  const fileLinks = (f) => {
    const s = fileSummary(f);
    const key = encodeURIComponent(f.r2_key);
    let html = '';
    for (const { params, label } of fileDownloads(f, s ? s.teams : null)) {
      html += (html ? ' ' : '') + `<a href="${esc(`${API}${a}/file?key=${key}&${params}`)}" download>${label}</a>`;
    }
    return html;
  };
  // the same, as the panel's Download menu: each file, and both as a zip
  const fileMenu = (f) => {
    const s = fileSummary(f);
    const key = encodeURIComponent(f.r2_key);
    const dls = fileDownloads(f, s ? s.teams : null);
    const href = (params) => esc(`${API}${a}/file?key=${key}&${params}`);
    if (dls.length < 2) return dls.map((x) => `<a href="${href(x.params)}" download>${x.label}</a>`).join('');
    return `<details class="fdl"><summary class="linkbtn">Download &#9662;</summary><div class="fdlpanel">
      ${dls.map((x) => `<a href="${href(x.params)}" download>${x.label}</a>`).join('')}
      <button class="linkbtn" data-dlboth="${f.id}">Both</button></div></details>`;
  };
  const protestMarker = (f) => {
    const ps = pfiles.get(f.id);
    const plural = (n) => `${n} protest${n === 1 ? '' : 's'}`;
    return !ps ? '' : ps.superseded
      ? `<span class="pill">${plural(ps.n)} &middot; superseded</span>`
      : ps.open
        ? `<button class="pill warn link" data-goto="protdrawer">${plural(ps.open)} open</button>`
        : `<button class="pill link" data-goto="protdrawer">${plural(ps.n)} &middot; ruled</button>`;
  };
  // the rounds a game can be filed under: every round the tournament has
  // (packets, the schedule, the round in play), and the one it's under
  const fileRounds = (at) => {
    const top = Math.max(at, t.current_round || 1, ...rounds.map((r) => r.number),
      ...((sched && sched.phases) || []).flatMap((ph) => ph.rounds.map((r) => r.round)));
    return Array.from({ length: top }, (_, i) => i + 1);
  };
  // the open cell's files, newest first, each with its own room picker
  const cellPanel = () => {
    if (!cellOpen) return '';
    const b = buckets.find((x) => x.id === cellOpen.bid);
    if (!b) return '';
    const n = cellOpen.round;
    const fs = cellFiles(b.id, n).sort((x, y) => y.id - x.id);
    const latest = new Map(); // teams -> newest good file id (dedupeMatches keeps the highest)
    for (const f of fs.filter(good)) {
      const s = fileSummary(f);
      const k = s ? [...s.teams].sort().join('|') : 'f' + f.id;
      if (!latest.has(k)) latest.set(k, f.id);
    }
    // the uploads that count (each game's newest); the rest wait behind
    // Show previous uploads
    const counting = new Set(latest.values());
    if (!counting.size && fs.length) counting.add(fs[0].id);
    // a MODAQ _Game.json added with its .qbj goes with the game that counts
    const base = (f) => f.filename.replace(/(_Game\.json|\.qbj)$/i, '');
    const keeps = new Set(fs.filter((f) => counting.has(f.id) && f.kind === 'qbj').map(base));
    for (const f of fs) if (f.kind === 'game' && keeps.has(base(f))) counting.add(f.id);
    const older = fs.filter((f) => !counting.has(f.id));
    const shown = cellOpen.prev ? fs : fs.filter((f) => counting.has(f.id));
    const rows = shown.map((f) => {
      const s = fileSummary(f);
      const k = s ? [...s.teams].sort().join('|') : 'f' + f.id;
      const superseded = good(f) && latest.get(k) !== f.id;
      const home = s ? scheduledRoomFor(s.teams, n) : null;
      const hint = home && home.id !== b.id
        ? `<div class="warntext">Scheduled in ${esc(home.room_name)}. <button class="linkbtn" data-moveto="${f.id}:${home.id}">Move it there</button></div>` : '';
      return `<div class="pfile ${superseded ? 'old' : ''}">
        <div class="pline">
          <span>${s ? gameLine(s, f, true) : esc(f.filename)}
            ${superseded ? '<span class="muted" style="font-size:13px"> &middot; superseded</span>' : ''}</span>
          <span class="pmove"><select data-fileround="${f.id}" aria-label="Round this game is filed under">
            ${fileRounds(f.round).map((r) => `<option value="${r}" ${r === f.round ? 'selected' : ''}>Round ${r}</option>`).join('')}
          </select><button class="small" data-moveround="${f.id}" disabled>Move files</button>
          <select data-movefile="${f.id}" aria-label="Room this game came from">
            ${buckets.some((x) => x.id === f.bucket_id) ? '' : `<option selected>#${f.bucket_id}</option>`}
            ${buckets.map((x) => `<option value="${x.id}" ${x.id === f.bucket_id ? 'selected' : ''}>${esc(x.room_name)}</option>`).join('')}
          </select></span>
        </div>
        ${hint}
        <div class="pmeta muted">${esc(f.filename)} &middot; ${esc(f.kind)} &middot; ${fmtBytes(f.size)}
          ${f.error ? ` &middot; <span class="warntext">${esc(f.error)}</span>` : ''} ${protestMarker(f)}</div>
        <div class="pacts">
          ${f.kind === 'combined' && !f.error && s
            ? `<button class="linkbtn" data-editfile="${f.id}" title="Reopen this game in MODAQ to correct it">Edit in MODAQ</button>` : ''}
          ${good(f) && s && !isForfeitFile(f)
            ? `<button class="linkbtn ${fixOpen && fixOpen.fid === f.id ? 'on' : ''}" data-fixbuzz="${f.id}">Fix stats</button>` : ''}
          ${fileMenu(f)}
          <span class="spacer" style="flex:1"></span>
          <button class="linkbtn muted" data-delfile="${f.id}">Delete</button></div>
        ${fixOpen && fixOpen.fid === f.id ? fixPanelHtml() : ''}
      </div>`;
    }).join('');
    return `<div class="cellpop cellpanel" id="cellpop"><div class="pop">
      <div class="phead"><b>Round ${n} &middot; ${esc(b.room_name)}</b>
        ${latest.size > 1 ? `<span class="warntext">${latest.size} games</span>` : ''}
        <span class="spacer" style="flex:1"></span>
        <button class="linkbtn" data-addfor="${b.id}:${n}">Add a game here</button>
        <button class="linkbtn muted" data-closecell aria-label="Close">Close</button></div>
      ${rows || '<div class="muted" style="padding-top:8px">Nothing uploaded for this round yet.</div>'}
      ${older.length ? `<button class="linkbtn muted small pprev" data-prevuploads>${cellOpen.prev
        ? 'Hide previous uploads' : `Show previous uploads (${older.length})`}</button>` : ''}
    </div></div>`;
  };

  const pfirst = popen[0];
  box.innerHTML = `
    ${t.started ? '' : `
    <div class="banner">
      <span class="warntext" style="font-weight:600">Not started</span>
      <span class="muted">Room links show &ldquo;Tournament hasn&rsquo;t started&rdquo; until you start it.</span>
      <span class="spacer" style="flex:1"></span>
      <button id="livestart" class="primary">Start tournament</button>
    </div>`}
    ${missing.length ? `
    <div class="banner">
      <span class="warntext" style="font-weight:600">Setup incomplete</span>
      <span class="muted">Still to do: ${missing.map(esc).join(', ')}</span>
      <span class="spacer" style="flex:1"></span>
      <button id="gosetup">Open setup</button>
    </div>` : ''}
    <div class="roundline">
      <span class="biground">Round ${topRound}<span class="of"> / ${totalRounds}</span></span>
      ${bk ? `<span class="muted">${phaseLine(bk)}</span>` : ''}
      ${rounds.length && !rounds.some((r) => r.number === topRound)
        ? '<span class="warntext">No packet for this round</span>' : ''}
      ${tbTotal ? `<span class="muted">Tiebreakers <span class="fg">${tbUsed}/${tbTotal}</span> used</span>` : ''}
    </div>
    ${playoffNoteHtml(files)}
    <div class="livegrid">
      <div class="livemain">
        <section>
          <div class="sechead"><h2>Live now</h2>
            ${bk ? `<span class="muted">${bk.rooms.filter((r) => r.key && r.state === 'in').length}/${bk.rooms.filter((r) => r.key).length} in${
                inProgress(bk.rooms.filter((r) => r.key))}</span>`
              : intake.expected ? `<span class="muted">${Math.max(0, intake.got - liveRows.filter((r) => r.state === 'partial').length)}/${intake.expected} in${
                inProgress(liveRows)}</span>` : ''}</div>
          ${bk ? liveBracketsHtml(bk, fileLinks) : liveRows.length ? liveRows.map((r) => `
          <div class="lrow ${r.bye ? 'bye' : ''}">
            <span class="lroom">${esc(r.b.room_name)}</span>
            <span class="lgame">${r.sum
              ? gameLine(r.sum, r.file) + unfinishedNote(r.sum)
              : r.bye ? '<span class="muted">No game this round</span>'
              : r.planned ? `${esc(r.planned[0])} <span class="muted">v</span> ${esc(r.planned[1])}`
              : '<span class="muted">No game yet</span>'}
              ${r.openProt ? `<button class="linkbtn warntext" data-goto="protdrawer">protest</button>` : ''}
              ${r.file && r.file.error ? `<span class="warntext">${esc(r.file.error)}</span>` : ''}</span>
            <span class="lacts">${r.file
              ? fileLinks(r.file) + (r.file.kind === 'combined' && r.sum
                ? ` <button class="linkbtn" data-editfile="${r.file.id}">Edit</button>` : '')
              : r.bye ? '' : `<button class="linkbtn" data-addfor="${r.b.id}:${t.current_round}">Upload</button>`}</span>
            <span class="lmark ${r.state === 'idle' || r.state === 'partial' ? 'warn' : r.state === 'started' ? 'muted' : ''}"
              title="${r.state === 'partial' ? unfinishedTitle(unfinishedOf(r.sum)) : r.state === 'in' ? 'Game in' : r.state === 'started' ? 'Started, not uploaded' : 'Not started'}">${
              r.bye ? '' : r.state === 'partial' ? pieMark(unfinishedOf(r.sum)) : r.state === 'in' ? '&#10003;' : r.state === 'started' ? '&#9675;' : '&ndash;'}</span>
          </div>`).join('') : '<div class="muted" style="padding:10px 0">No rooms yet. Add them under Setup.</div>'}
        </section>

        <section>
          <div class="sechead"><h2>Uploads</h2>
            <span><button class="linkbtn" id="fftoggle" aria-expanded="${ffOpen ? 'true' : 'false'}">Record a forfeit</button>
            <button class="linkbtn" id="addtoggle" aria-expanded="${addOpen ? 'true' : 'false'}" style="margin-left:14px">Add a game</button></span></div>
          ${ffPanelHtml(t, buckets)}
          <div id="addpanel" class="addpanel" ${addOpen ? '' : 'hidden'}>
            <div class="row">
              <label>Room <select id="addroom">${buckets.map((b) =>
                `<option value="${b.id}" ${addOpen && addOpen.bid === b.id ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}</select></label>
              <label>Round <input id="addround" type="number" min="1" max="999"
                value="${addOpen && addOpen.round ? addOpen.round : t.current_round}" style="width:64px"></label>
              <input id="addfile" type="file" multiple accept=".json,.qbj" aria-label="Game files">
            </div>
            <div id="addlist" class="addlist"></div>
            <div class="muted" style="font-size:13px">The match <span class="mono">.qbj</span> and its MODAQ
              <span class="mono">_Game.json</span> together, or one reader upload (<span class="mono">.qbtd.json</span>).</div>
            <div class="row" style="margin-top:10px">
              <button id="addgame" class="primary">Upload</button>
              <button id="addcancel" class="linkbtn muted">Cancel</button>
            </div>
          </div>
          ${buckets.length ? `<div class="ugridbox"><div class="tablewrap"><table class="ugrid">
            ${bk ? phaseSpans(bk, roundCols) : ''}
            <tr><th class="uroom">Room</th>${roundCols.map((n) =>
              `<th class="${(bk ? Object.values(bk.st.rounds).includes(n) : n === t.current_round) ? 'now' : ''}">${n}</th>`).join('')}</tr>
            ${gridGroups(bk, buckets).map(({ head, rows }) => (head
              ? `<tr class="ugroup"><td colspan="${roundCols.length + 1}"><i class="lane-${head.color}"></i><b>${esc(head.name)}</b>
                  <span class="muted">this round</span></td></tr>` : '')
              + rows.map((b) => `<tr data-urow="${b.id}"><td class="uroom" title="${esc(b.room_name)}">${esc(b.room_name)}</td>${
                roundCols.map((n) => gridCell(b, n)).join('')}</tr>`).join('')).join('')}
          </table></div>${cellOpen && buckets.some((b) => b.id === cellOpen.bid) ? cellPanel() : ''}</div>
          <div class="muted legend">&#10003; in &middot;
            <span class="upie" style="--p:40%"></span> in progress &middot; &#9675; started &middot; &ndash; missing &middot; ! can&rsquo;t read &middot;
            <span class="warntext">orange</span>: needs a look</div>`
          : ''}
        </section>

        ${renderProtests(prows, popen, openProt)}
        <section id="statsec" hidden>
          <div class="sechead"><h2>Stats</h2></div>
          <div id="statsout"></div>
        </section>
      </div>

      <aside class="liverail">
        <div class="railblock">
          ${pastSched(bk ? bk.advTo : t.current_round + 1)
          ? `<button class="primary advance" disabled>${bk ? 'Advance all' : 'Advance'}</button>
          <div class="muted small">Round ${schedRoundCount()} is the last round in the schedule.</div>`
          : bk ? `<button id="advall" class="primary advance">Advance all to round ${bk.advTo}</button>
          ${advNote(bk) ? `<div class="muted small">${advNote(bk)}</div>` : ''}
          ${rounds.some((r) => r.number === bk.advTo) || !rounds.length ? '' : `<div class="warntext small">No packet for round ${bk.advTo} yet</div>`}`
          : `<button id="advround" class="primary advance">Advance to round ${t.current_round + 1}</button>
          ${nextHasPacket || !rounds.length ? '' : `<div class="warntext small">No packet for round ${t.current_round + 1} yet</div>`}`}
          <label class="setround">Set round
            <input id="curround" type="number" min="1" max="999" value="${bk ? bk.top : t.current_round}" aria-label="Round">
            <button id="setround" class="linkbtn">Set</button></label>
        </div>
        ${buckets.length && bk ? autoBracketsHtml(bk, settings) : buckets.length ? `
        <div class="railblock">
          <label class="railtoggle"><span><b>Auto-advance</b> <span class="muted">${nStarted}/${playing.length} started</span></span>
            <input type="checkbox" id="autoadv" ${settings.autoAdvance ? 'checked' : ''}></label>
          ${settings.autoAdvance && playing.length && nStarted === playing.length && !nextHasPacket
            ? `<div class="muted small">Round ${t.current_round + 1} opens as soon as its packet is uploaded.</div>` : ''}
          <div class="startlist">${liveRooms.map((r) => `<span class="sroom ${r.bye ? 'bye' : started.has(r.id) ? 'on' : ''}"
              title="${r.bye ? 'No game this round' : started.has(r.id) ? 'Started' : 'Not started'}"><span class="dot"></span>${esc(r.name)}${r.bye ? ' &middot; bye' : ''}</span>`).join('')}</div>
        </div>` : ''}
        <div class="railblock">
          <div class="railhead"><b>Protests${popen.length ? ` <span class="warntext">${popen.length}</span>` : ''}</b>
            ${prows.length ? '<button class="linkbtn" data-goto="protdrawer">All</button>' : ''}</div>
          ${pfirst ? `
          <div class="pcompact">
            <span>R${pfirst.round} &middot; ${esc(pfirst.room)} &middot; ${qLabel(pfirst.p)}</span>
            <span class="muted">${esc(pfirst.p.team)}${pfirst.p.given ? `: <span class="given">${esc(pfirst.p.given)}</span>` : ''}</span>
            ${pfirst.live ? '<span class="muted small">Game in progress</span>' : ''}
            ${pfirst.known && !pfirst.live ? `<span class="${pfirst.flips ? 'warntext' : 'muted'} small">${pfirst.flips ? 'Can flip' : 'Result stands'} &middot;
              ${esc(pfirst.teams[0])} ${pfirst.upheld[0]} &ndash; ${pfirst.upheld[1]} ${esc(pfirst.teams[1])} if upheld</span>` : ''}
            <select data-rule="${esc(pfirst.key)}" aria-label="Ruling">${RULINGS.map(([v, l]) =>
              `<option value="${v}" ${pfirst.ruling === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          </div>` : `<div class="muted small">${prows.length ? 'Nothing open' : 'None logged'}</div>`}
          <div class="muted small">For your records only. The moderator should fix the game in MODAQ and re-export.</div>
        </div>
        <div class="railblock">
          <div class="railhead"><b>Stats</b></div>
          <div id="statrange">${statRangeHtml(t, files)}</div>
          <div class="statbtns">
            <button id="calc">Compute</button>
            <div class="dlwrap">
              <button id="dlmenu" aria-haspopup="true" aria-expanded="false" disabled>Download &#9662;</button>
              <div id="dlpanel" class="dlpanel" role="menu" hidden>
                <button id="dlyft4" role="menuitem" disabled>YellowFruit 4 (.yft)<span class="muted">4.0.18+</span></button>
                <button id="dlyft3" role="menuitem" disabled>YellowFruit 3 (.yft)<span class="muted">3.0.2</span></button>
                <button id="dlreport" role="menuitem" class="sep" disabled>HTML report<span class="muted">.zip</span></button>
                <button id="dlreportfiles" role="menuitem" disabled>HTML report<span class="muted">6 separate files</span></button>
                <button id="dlzip" role="menuitem" disabled>QBJ bundle<span class="muted">split per game</span></button>
                <button id="rebuild" role="menuitem" class="sep" disabled>Rebuild player page</button>
              </div>
            </div>
          </div>
          <div class="muted small" id="statsnote">${files.filter(good).length} games ready</div>
        </div>
      </aside>
    </div>`;

  if ($('gosetup')) $('gosetup').onclick = () => { curView = 'setup'; render(); };
  // uploads grid: a cell opens its files under its row; one at a time
  box.querySelectorAll('[data-cell]').forEach((btn) => {
    btn.onclick = () => {
      const [bid, n] = btn.dataset.cell.split(':').map(Number);
      const fs = cellFiles(bid, n);
      if (!fs.length) { addOpen = { bid, round: n, picked: true }; cellOpen = null; render(); $('addfile').focus(); return; }
      cellOpen = cellOpen && cellOpen.bid === bid && cellOpen.round === n ? null : { bid, round: n };
      render();
    };
  });
  box.querySelectorAll('[data-closecell]').forEach((b) => { b.onclick = () => { cellOpen = null; render(); }; });
  box.querySelectorAll('[data-prevuploads]').forEach((b) => { b.onclick = () => { cellOpen.prev = !cellOpen.prev; render(); }; });
  // Download > Both: the game's two files in one zip, named as MODAQ names them
  box.querySelectorAll('[data-dlboth]').forEach((b) => {
    b.onclick = async () => {
      const f = files.find((y) => y.id === Number(b.dataset.dlboth));
      const s = fileSummary(f);
      try {
        const parts = await Promise.all(fileDownloads(f, s ? s.teams : null).map(async ({ params }) => {
          const res = await fetch(`${API}${a}/file?key=${encodeURIComponent(f.r2_key)}&${params}`);
          if (!res.ok) throw new Error('could not load the game file (' + res.status + ')');
          return { name: decodeURIComponent(/(?:^|&)dl=([^&]*)/.exec(params)[1]), data: new Uint8Array(await res.arrayBuffer()) };
        }));
        download(f.filename.replace(/\.qbtd\.json$/i, '') + '.zip', makeZip(parts), 'application/zip');
        b.closest('details').open = false;
      } catch (e) { say(e.message, true); }
    };
  });
  box.querySelectorAll('[data-fillpool]').forEach((b) => {
    b.onclick = () => { autoForce = [...new Set([...autoForce, b.dataset.fillpool])]; autoFillSlots(true); };
  });
  box.querySelectorAll('[data-addfor]').forEach((b) => {
    b.onclick = () => {
      const [bid, n] = b.dataset.addfor.split(':').map(Number);
      addOpen = { bid, round: n, picked: true };
      render();
      $('addpanel').scrollIntoView({ block: 'nearest' });
      $('addfile').focus();
    };
  });
  box.querySelectorAll('[data-moveto]').forEach((b) => {
    b.onclick = async () => {
      const [fid, bid] = b.dataset.moveto.split(':').map(Number);
      try {
        const out = await pub(a + '/files/' + fid, { method: 'POST', json: { bucket_id: bid } });
        say('Moved to ' + out.room_name);
        showDetail();
      } catch (e) { say(e.message, true); showDetail(); }
    };
  });
  if ($('addtoggle')) $('addtoggle').onclick = () => { addOpen = addOpen ? null : { bid: null, round: t.current_round }; render(); };
  wireForfeit(a, t, buckets, render);
  if ($('addcancel')) $('addcancel').onclick = () => { addOpen = null; render(); };
  // Round fills in with the round the picked files say, unless the TD
  // chose one (a grid cell, a room's Upload, or typed in); a round other
  // than the files' is pointed out, since the upload counts under it
  let addRows = [];
  const showAdd = () => { $('addlist').innerHTML = addListHtml(addRows, Number($('addround').value)); };
  if ($('addfile')) $('addfile').onchange = async () => {
    const fs = [...$('addfile').files];
    addRows = fs.map((f) => ({ name: f.name, match: false, round: null }));
    showAdd();
    const rows = await addFileRows(fs);
    if (!$('addfile') || $('addfile').files[0] !== fs[0]) return; // picked again meanwhile
    addRows = rows;
    const said = addSaid(rows).rounds;
    if (said.length === 1 && addOpen && !addOpen.picked) $('addround').value = said[0];
    showAdd();
  };
  if ($('addround')) $('addround').oninput = () => { if (addOpen) addOpen.picked = true; showAdd(); };
  // Download menu: closed by picking an item, Escape, or a click elsewhere
  if ($('dlmenu')) $('dlmenu').onclick = (ev) => {
    ev.stopPropagation();
    const open = $('dlpanel').hidden;
    $('dlpanel').hidden = !open;
    $('dlmenu').setAttribute('aria-expanded', String(open));
  };

  /* protests: rulings are the TD's record only — a whole-map write, like
     settings, that names the ruling it changes as this tab had it, so a
     ruling made in another tab is kept (saves.js). Nothing goes to the
     room; the moderator applies an upheld ruling in MODAQ and uploads the
     game again. */
  if ($('protdrawer')) $('protdrawer').ontoggle = () => { protOpen = $('protdrawer').open; };
  box.querySelectorAll('[data-goto]').forEach((el) => {
    el.onclick = () => {
      const d = $(el.dataset.goto);
      d.open = true;
      d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  const saveRuling = async (key, r, note) => {
    const next = { ...rulings };
    const prev = rulings[key];
    note = note.trim();
    if (r === 'open' && !note) delete next[key];
    // the timestamp marks the ruling, not the note: a later re-upload of
    // the game counts as the correction only against the ruling's time
    else next[key] = { r, note, at: prev && prev.r === r ? prev.at : Date.now() };
    // this copy moves on as the save goes out, so a second ruling made
    // before the answer comes back is made on this one (saves.js); a
    // failed save puts it back
    const was = rulings;
    rulings = next;
    try {
      await pub(a, { method: 'POST', json: rulingsBody(was, next, [key]) });
      t.rulings = JSON.stringify(next);
      say(r === 'open' && !note ? 'Reopened' : `Saved: ${rulingLabel(r)}`);
      render();
    } catch (e) {
      if (rulings === next) rulings = was;
      say(e.message, true);
    }
  };
  box.querySelectorAll('[data-rule]').forEach((sel) => {
    sel.onchange = () => saveRuling(sel.dataset.rule, sel.value,
      box.querySelector(`[data-rnote="${CSS.escape(sel.dataset.rule)}"]`).value);
  });
  box.querySelectorAll('[data-rnote]').forEach((inp) => {
    inp.onchange = () => saveRuling(inp.dataset.rnote,
      box.querySelector(`[data-rule="${CSS.escape(inp.dataset.rnote)}"]`).value, inp.value);
  });

  const goToRound = async (n) => {
    try {
      await pub(a, { method: 'POST', json: { current_round: n } });
      uploadsOpen = null; // upload groups follow the new round
      say('Round ' + n);
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  if ($('setround')) $('setround').onclick = () => goToRound(Number($('curround').value));
  if ($('autoadv')) $('autoadv').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('autoadv').checked) next.autoAdvance = true;
      else delete next.autoAdvance;
      // the switch sets the key whatever this copy held: a second click
      // before the redraw lands is the TD's say too (saves.js)
      const out = await pub(a, { method: 'POST', json: settingsBody(settings, next, {}, ['autoAdvance']) });
      say(out && out.advanced ? `Round ${t.current_round + 1} opened: every room had started Round ${t.current_round}`
        : $('autoadv').checked ? 'Rounds open automatically' : 'Rounds open when you advance them');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  if ($('advround')) $('advround').onclick = () => goToRound(t.current_round + 1);
  // brackets: all of them, or one
  const advance = async (which, btn) => {
    const run = busy(btn, { label: 'Advancing' });
    try {
      const out = await pub(a, { method: 'POST', json: { advance: which } });
      uploadsOpen = null;
      say(which === 'all' ? 'Round ' + out.current_round
        : `${bracketInfo(bk.bm, which)?.name || which}: round ${(out.bracket_rounds || {})[which] || out.current_round}`);
      showDetail();
    } catch (e) { say(e.message, true); showDetail(); }
    run.end();
  };
  if ($('advall')) $('advall').onclick = () => advance('all', $('advall'));
  box.querySelectorAll('[data-advbracket]').forEach((b) => { b.onclick = () => advance(b.dataset.advbracket, b); });
  if ($('livestart')) $('livestart').onclick = () => startTournament(a, t, $('livestart'));
  box.querySelectorAll('[data-delfile]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this file?')) return;
      try {
        await pub(a + '/files/' + b.dataset.delfile, { method: 'DELETE' });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  box.querySelectorAll('[data-movefile]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        const out = await pub(a + '/files/' + sel.dataset.movefile,
          { method: 'POST', json: { bucket_id: Number(sel.value) } });
        say('Moved to ' + out.room_name);
        showDetail();
      } catch (e) { say(e.message, true); showDetail(); }
    };
  });
  // a round picked: Move files refiles the upload there (worker.js
  // moveFileRound: the stored file, its public copy and the row)
  box.querySelectorAll('[data-fileround]').forEach((sel) => {
    const btn = box.querySelector(`[data-moveround="${sel.dataset.fileround}"]`);
    const was = Number(sel.value);
    sel.onchange = () => { btn.disabled = Number(sel.value) === was; };
    btn.onclick = async () => {
      const to = Number(sel.value);
      if (to === was) return;
      // a game's round decides its stats, its place in the schedule and
      // the public page: ask before moving it
      if (!confirm(`Move this game from round ${was} to round ${to}? Its stats, buzzpoints and the player page will count it as round ${to}. Please only do this if the game was filed under the wrong round.`)) return;
      const run = busy(btn, { label: 'Moving' });
      try {
        await pub(a + '/files/' + sel.dataset.fileround, { method: 'POST', json: { round: to } });
        say(`Moved to round ${to}`);
        if (cellOpen) cellOpen = { ...cellOpen, round: to };
        showDetail();
      } catch (e) { say(e.message, true); run.end(); }
    };
  });
  box.querySelectorAll('[data-editfile]').forEach((b) => {
    b.onclick = () => editGame(a, buckets, files, Number(b.dataset.editfile));
  });
  placeCellPop(box);
  wireFix(box, a, t, buckets, files);
  if ($('addgame')) $('addgame').onclick = () => addGame(a, buckets);
  if ($('calc')) $('calc').onclick = () => computeStats(a, t, buckets, files, settings);
  wireStatRange(t, files);
}

/* ---------- which games the stats use ----------
   One or the other: By stage (tick the stages to include), or Finished
   rounds only — every round up to the first one still missing a game (a
   round counts once all its games are in). Compute and every download
   follow; the player page and Rebuild player page always use every game.
   The choice lasts the session, per tournament. */

let statPick = null; // {tid, off: [phase index], finished}
const pickFor = (t) => {
  if (!statPick || statPick.tid !== t.id) statPick = { tid: t.id, off: [], finished: false };
  return statPick;
};
// the schedule's stages that have games: [{i, name, lo, hi}]
function statStages() {
  if (!sched || !Array.isArray(sched.phases)) return [];
  return sched.phases.map((ph, i) => {
    const rounds = ph.rounds.filter((r) => r.games.length).map((r) => r.round);
    return rounds.length ? { i, name: ph.name, lo: Math.min(...rounds), hi: Math.max(...rounds) } : null;
  }).filter(Boolean);
}
// uploads as just enough of a game for finishedThrough: the round and the
// two teams, under their current names, as the schedule has them
function filesAsGames(files) {
  return namedFiles(files, hubNames.map).map((f) => {
    const x = isGameFile(f) ? summaryTeams(f) : null;
    return x ? { round: f.round, teams: x.map((name) => ({ name, points: 0 })) } : null;
  }).filter(Boolean);
}
// the rounds the stats use, from the pick: a Set, or null for every round
function statRounds(t, games) {
  const st = statStages();
  if (!st.length) return null;
  const pick = pickFor(t);
  const out = new Set();
  if (pick.finished) {
    const through = finishedThrough(sched, games);
    for (const x of st) for (const r of sched.phases[x.i].rounds) if (r.round <= through) out.add(r.round);
    return out;
  }
  if (!pick.off.length) return null;
  for (const x of st) {
    if (pick.off.includes(x.i)) continue;
    for (const r of sched.phases[x.i].rounds) out.add(r.round);
  }
  return out;
}
const roundSpan = (n) => (n.length === 1 ? 'round ' + n[0] : `rounds ${n[0]}–${n[n.length - 1]}`);
function statRangeHtml(t, files) {
  const st = statStages();
  if (!st.length) return '';
  const pick = pickFor(t);
  const through = finishedThrough(sched, filesAsGames(files));
  const span = (lo, hi) => (lo === hi ? `Round ${lo}` : `Rounds ${lo}–${hi}`);
  return `<div class="statpick" role="radiogroup" aria-label="Games in the stats">
    <label class="pkcheck small"><input type="radio" name="statmode" value="stages" ${pick.finished ? '' : 'checked'}> By stage</label>
    <div class="statstages">${st.map((x) => `<label class="pkcheck small"><input type="checkbox" data-statph="${x.i}"
      ${pick.off.includes(x.i) ? '' : 'checked'} ${pick.finished ? 'disabled' : ''}>
      ${esc(x.name)} <span class="muted">(${span(x.lo, x.hi).toLowerCase()})</span></label>`).join('')}</div>
    <label class="pkcheck small"><input type="radio" name="statmode" value="finished" ${pick.finished ? 'checked' : ''}>
      Finished rounds only <span class="muted">(${through ? span(1, through) : 'none yet'})</span></label>
  </div>`;
}
function wireStatRange(t, files) {
  const box = $('statrange');
  if (!box) return;
  const redo = () => {
    box.innerHTML = statRangeHtml(t, files);
    wireStatRange(t, files);
    if (lastStats && lastStats.t.id === t.id) showStats(lastStats);
  };
  box.querySelectorAll('[data-statph]').forEach((el) => {
    el.onchange = () => {
      const pick = pickFor(t);
      const i = Number(el.dataset.statph);
      pick.off = el.checked ? pick.off.filter((x) => x !== i) : [...pick.off, i];
      redo();
    };
  });
  box.querySelectorAll('input[name="statmode"]').forEach((el) => {
    el.onchange = () => { pickFor(t).finished = el.value === 'finished'; redo(); };
  });
}

/* ---------- editing a game a room already turned in ----------

   A moderator's combined upload carries MODAQ's whole persisted store, so
   the game can simply be handed back to MODAQ: the reader's game link
   resumes from localStorage and fetches nothing (read_main.js boot), which
   means the TD gets the real game — packet, buzzes, bonuses, protests —
   and not a form that approximates it.

   The correction goes back up the room's own upload route, as an ordinary
   re-upload. Nothing new has to store it: stats.js dedupeMatches keys a
   game on its round and team names and keeps the highest file id, so the
   corrected file supersedes the original everywhere — the dashboard, the
   stat report, the exports and the player page — exactly as a room
   re-uploading its own fixed game already does. The original file stays
   in the uploads list, which is what makes the fix reversible: delete the
   correction and the first upload is live again.

   It goes back through the room that played it, never some other room.
   worker.js doneRounds counts distinct rooms per round against the
   games expected, so a correction from a stand-in room would count that
   room as having played the round and skew which rounds read as
   finished. (Nothing on the file records a packet version: a set
   mirror's game takes the version its round points at.) */

// Rooms take games only once the tournament has started (worker.js
// bucketGate), and close with it, so a correction needs a started one.
const notStarted = () => !(lastDetail && lastDetail.tournament.started);
const START_FIRST = 'Start the tournament first: rooms take games only once it has started';

async function editGame(a, buckets, files, fileId) {
  const f = files.find((x) => x.id === fileId);
  const room = f && buckets.find((b) => b.id === f.bucket_id);
  const sum = f && fileSummary(f);
  if (!f || !room || !sum) { say('That game cannot be edited', true); return; }

  if (notStarted()) { say(START_FIRST, true); return; }
  try {
    say('Loading the game…');
    // The whole stored upload, decrypted by the Worker under the admin
    // link's key. Its game half is the reader's saved state ({game,
    // uiState}), which the reader resumes from; the "game" download is
    // MODAQ's bare game file (engine/modaqfile.js), which it can't.
    const res = await fetch(`${API}${a}/file?key=${encodeURIComponent(f.r2_key)}`);
    if (!res.ok) throw new Error('could not load the game file (' + res.status + ')');
    let root = null;
    try { root = await res.json(); } catch (e) { /* reported below */ }
    const saved = root && root.game;
    const storeText = saved && typeof saved === 'object' ? JSON.stringify(saved) : '';
    if (!storeIntact(storeText)) throw new Error('this upload has no MODAQ game in it');

    // A fresh game id under the room's own secret, so the reader resumes
    // it without touching the room's other games.
    const gid = 'fix' + Date.now().toString(36);
    const [aName, bName] = sum.teams;
    const tb = tbResume(root);
    localStorage.setItem(gameKey(room.secret, gid), storeText);
    localStorage.setItem(metaKey(room.secret, gid), JSON.stringify({
      a: aName, b: bName, round: f.round, t: '', room: room.room_name, started: Date.now(),
      // how far it had got, so the corrected upload says so too
      ...(sum.progress ? { reached: sum.progress.at } : {}),
      // where questions were added or replaced, so the correction numbers
      // them as the game did (read_core tbResume). The game's own upload
      // logged the tiebreakers it read: the correction leaves that log as
      // it is unless it adds or replaces questions (readerUpload).
      ...(tb ? { tb, tbLogged: true } : {}),
    }));
    say('');
    // A new tab: the dashboard keeps its place, and the TD can flip back.
    window.open(readLink(room.secret) + '&g=' + encodeURIComponent(gid), '_blank');
  } catch (e) { say(e.message, true); }
}

/* ---------- fixing who got which buzz ----------
   When a moderator credits a player's buzzes to a teammate. Swap players
   trades two teammates' buzzes for the whole game (or gives a player's
   name to a roster player who was never entered); All buzzes sets each
   buzz's player. Both edit one fix (engine/buzzfix.js), which rewrites
   every copy in the upload, and the result goes back up the room's own
   upload route like Edit in MODAQ's correction: the newest upload counts,
   and deleting it brings back the original. */

const fixEdits = (x) => [...x.edits].map(([k, to]) => { const [q, j] = k.split(':').map(Number); return { q, j, to }; });
// the upload's views: as uploaded, with the swaps, with the buzzes fixed
// (the lineups as they stand there), and fully fixed
function fixDerived() {
  const x = fixOpen;
  const out = { base: buzzFixView(x.root), swapped: null, buzzed: null, fixed: null, err: '' };
  try {
    out.swapped = buzzFixView(applyBuzzFix(x.root, { swaps: x.swaps }));
    out.buzzed = applyBuzzFix(x.root, { swaps: x.swaps, edits: fixEdits(x) });
    out.fixed = Object.keys(x.lineups).length ? applyLineupFix(out.buzzed, x.lineups) : out.buzzed;
  } catch (e) { out.err = e.message; }
  return out;
}
// A team's lineups as the moderator thinks of them: who started, and each
// substitution {q, in, out} on question q ('' in: a player leaves; ''
// out: a player joins), and back.
function luEvents(segs) {
  const subs = [];
  for (let i = 1; i < segs.length; i++) {
    const before = segs[i - 1].players;
    const now = segs[i].players;
    const ins = now.filter((p) => !before.includes(p));
    const outs = before.filter((p) => !now.includes(p));
    for (let k = 0; k < Math.max(ins.length, outs.length); k++) subs.push({ q: segs[i].from, in: ins[k] || '', out: outs[k] || '' });
  }
  return { starters: [...segs[0].players], subs };
}
function luSegs(ev) {
  let cur = [...ev.starters];
  const segs = [{ from: 1, players: cur }];
  const subs = [...ev.subs].sort((p, r) => p.q - r.q);
  for (const sb of subs) {
    cur = cur.filter((p) => p !== sb.out);
    if (sb.in && !cur.includes(sb.in)) cur.push(sb.in);
    const last = segs[segs.length - 1];
    if (last.from === sb.q) last.players = cur; else segs.push({ from: sb.q, players: cur });
  }
  return segs;
}
// who was in on question q
const luAt = (segs, q) => { let at = segs[0]; for (const sg of segs) if (sg.from <= q) at = sg; return at.players; };
// a substitution as MODAQ words it
const luWords = (sb) => (sb.in && sb.out ? `${sb.in} in for ${sb.out}` : sb.in ? `${sb.in} joins` : `${sb.out} leaves`);
// a team's lineups in the panel: as edited, else as the file has them
function fixLineups(d, ti) {
  const x = fixOpen;
  const v = lineupView(d.buzzed || x.root);
  const tm = v.teams[ti];
  return { questions: v.questions, players: tm.players, segs: x.lineups[tm.name] || tm.lineups };
}
// edits that no longer change anything after the swaps moved, dropped
function fixPrune() {
  const x = fixOpen;
  let sv = null;
  try { sv = buzzFixView(applyBuzzFix(x.root, { swaps: x.swaps })); } catch (e) { return; }
  for (const [k, to] of [...x.edits]) {
    const [q, j] = k.split(':').map(Number);
    const b = sv.buzzes && sv.buzzes.find((y) => y.q === q && y.j === j);
    const team = b && sv.teams.find((tm) => tm.name === b.team);
    if (!b || b.player === to || !team.players.includes(to)) x.edits.delete(k);
  }
}

function fixPanelHtml() {
  const x = fixOpen;
  if (x.loading) return '<div class="fixbuzz muted">Loading the game&hellip;</div>';
  if (!x.root) return `<div class="fixbuzz warntext">${esc(x.err || 'This game could not be loaded')}</div>`;
  let d, was, now;
  try {
    d = fixDerived();
    was = parseMatch(x.root, { filename: x.filename });
    now = d.fixed ? parseMatch(d.fixed, { filename: x.filename }) : was;
  } catch (e) { return `<div class="fixbuzz warntext">${esc(e.message)}</div>`; }
  const hasAll = !!(d.base.buzzes && d.base.buzzes.length);
  const tab = x.tab === 'all' && !hasAll ? 'lineups' : x.tab;
  const values = [...new Set([was, now].flatMap((m) => m.teams.flatMap((tm) => tm.players.flatMap((p) => p.counts.map((c) => c.value)))))]
    .filter((v) => v !== 0).sort((p, q) => q - p);
  const line = (m, ti, name) => {
    const p = m.teams[ti].players.find((y) => y.name === name);
    const n = Object.fromEntries(values.map((v) => [v, p ? (p.counts.find((c) => c.value === v) || { n: 0 }).n : 0]));
    return { n, pts: p ? p.counts.reduce((sum, c) => sum + c.value * c.n, 0) : 0 };
  };
  const table = (ti) => {
    const tm = d.base.teams[ti];
    const names = [...tm.players, ...now.teams[ti].players.map((p) => p.name).filter((n) => !tm.players.includes(n))];
    const rows = names.map((name) => {
      const a = line(was, ti, name);
      const b = line(now, ti, name);
      const cell = (va, vb) => `<td class="num">${va !== vb ? `<span class="was">${va}</span>` : ''}${vb}</td>`;
      const tuh = (m) => { const p = m.teams[ti].players.find((y) => y.name === name); return p ? p.tossupsHeard : 0; };
      const diff = a.pts !== b.pts || values.some((v) => a.n[v] !== b.n[v]) || tuh(was) !== tuh(now);
      const pi = tm.players.indexOf(name);
      let ctl = '';
      if (pi >= 0 && tab === 'swap') {
        const mine = x.swaps.find((y) => y.team === tm.name && (y.from === name || y.to === name));
        const partner = mine ? (mine.from === name ? mine.to : mine.from) : '';
        const roster = x.roster[tm.name] || [];
        ctl = `<select id="fxs-${ti}-${pi}" data-fswap="${ti}:${pi}" aria-label="Swap ${esc(name)} with">
          <option value="">${partner ? 'Undo' : 'Swap with'}</option>
          ${tm.players.filter((n) => n !== name).map((n) => `<option ${n === partner ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          ${roster.length ? `<optgroup label="Not in this game">${roster.map((n) =>
            `<option value="${esc(n)}" ${n === partner ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : ''}
        </select>`;
      }
      return `<tr class="${diff ? 'chg' : ''}"><td>${esc(name)}${pi < 0 ? '<span class="muted small"> from the roster</span>' : ''}</td>
        ${values.map((v) => cell(a.n[v], b.n[v])).join('')}${cell(a.pts, b.pts)}${cell(tuh(was), tuh(now))}<td>${ctl}</td></tr>`;
    }).join('');
    return `<table class="fxteam"><tr><th>${esc(tm.name)}</th>${values.map((v) => `<th class="num">${v}</th>`).join('')}<th class="num">Pts</th><th class="num">TUH</th><th></th></tr>${rows}</table>`;
  };
  // buzzes now on a player who was not in the lineup then
  const before = lineupGaps(x.root);
  const gaps = d.fixed ? [...lineupGaps(d.fixed)].filter((k) => !before.has(k)) : [];
  const allList = () => {
    const sv = d.swapped || d.base;
    const orig = new Map(d.base.buzzes.map((b) => [b.q + ':' + b.j, b.player]));
    return `<div class="fxbuzzes">${sv.teams.map((tm) => `<div><div class="fxbh">${esc(tm.name)}</div>${sv.buzzes.filter((b) => b.team === tm.name).map((b) => {
      const key = b.q + ':' + b.j;
      const to = x.edits.get(key) || b.player;
      return `<div class="fxrow ${to !== orig.get(key) ? 'chg' : ''}"><span class="muted">${b.n}</span>
        <select id="fxe-${b.q}-${b.j}" data-fedit="${key}" aria-label="Question ${b.n}, ${esc(tm.name)}">${tm.players.map((n) =>
          `<option ${n === to ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <span class="num ${b.value < 0 ? 'warntext' : ''}">${b.value}</span></div>`;
    }).join('')}</div>`).join('')}</div>`;
  };
  const gapNames = gaps.map((k) => {
    const [q, j] = k.split(':').map(Number);
    const b = buzzFixView(d.fixed).buzzes.find((y) => y.q === q && y.j === j);
    return `${esc(b.player)} was not in the lineup on question ${q + 1}.`;
  });
  // the lineups as the moderator's start card shows them, condensed: who
  // started, then each substitution, and Add substitution
  const lineupCards = () => `<div class="lucards">${d.base.teams.map((tm0, ti) => {
    const lu = fixLineups(d, ti);
    const ev = luEvents(lu.segs);
    const pool = [...lu.players, ...(x.roster[tm0.name] || []).filter((n) => !lu.players.includes(n))];
    for (const sg of lu.segs) for (const p of sg.players) if (!pool.includes(p)) pool.push(p);
    const add = x.luAdd && x.luAdd.ti === ti ? x.luAdd : null;
    let form = '';
    if (add) {
      const on = luAt(lu.segs, add.q);
      const qs = Array.from({ length: Math.max(lu.questions - 1, 0) }, (_, i) => i + 2);
      form = `<div class="luadd">
        <select id="luaq" aria-label="Question">${qs.map((q) => `<option value="${q}" ${q === add.q ? 'selected' : ''}>Q${q}</option>`).join('')}</select>
        <select id="luain" aria-label="In"><option value="">Nobody</option>${pool.filter((p) => !on.includes(p)).map((p) =>
          `<option ${p === add.in ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <span class="muted">in for</span>
        <select id="luaout" aria-label="Out"><option value="">Nobody</option>${on.map((p) =>
          `<option ${p === add.out ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <button class="small primary" id="luaok">Add</button><button class="small" id="luano">Cancel</button>
      </div>`;
    }
    return `<div class="lucard"><div class="luhead"><b>${esc(tm0.name)}</b><span class="muted">${ev.starters.length} starting</span></div>
      <div class="lustart">${pool.map((p) => `<button class="lup ${ev.starters.includes(p) ? 'on' : ''}" data-lustart="${ti}" data-name="${esc(p)}"
        aria-pressed="${ev.starters.includes(p)}"><span class="box">${ev.starters.includes(p) ? '&#10003;' : ''}</span>${esc(p)}</button>`).join('')}</div>
      ${ev.subs.length ? `<div class="lusubs">${[...ev.subs].sort((p, r) => p.q - r.q).map((sb) => `<div class="lusub"><span class="muted">Q${sb.q}</span>
        <span>${esc(luWords(sb))}</span><button class="xbtn" data-lusubdel="${ti}" data-sub="${esc(JSON.stringify(sb))}" title="Remove">&times;</button></div>`).join('')}</div>` : ''}
      <div class="luaddwrap"><button class="linkbtn small" data-luaddopen="${ti}">Add substitution</button>${form}</div>
    </div>`;
  }).join('')}</div>`;
  const changed = x.swaps.length || x.edits.size || Object.keys(x.lineups).length;
  return `<div class="fixbuzz">
    <div class="fxtabs" role="tablist">
      <button role="tab" class="fxtab ${tab === 'lineups' ? 'on' : ''}" data-fixtab="lineups" aria-selected="${tab === 'lineups'}">Lineups</button>
      <button role="tab" class="fxtab ${tab === 'swap' ? 'on' : ''}" data-fixtab="swap" aria-selected="${tab === 'swap'}">Swap player buzzes</button>
      ${hasAll ? `<button role="tab" class="fxtab ${tab === 'all' ? 'on' : ''}" data-fixtab="all" aria-selected="${tab === 'all'}">All buzzes</button>` : ''}</div>
    ${tab === 'all' ? allList() : ''}
    ${tab === 'lineups' ? lineupCards() : ''}
    ${table(0)}${table(1)}
    ${gapNames.length ? `<div class="warntext small">${gapNames.join(' ')}</div>` : ''}
    ${d.err ? `<div class="warntext small">${esc(d.err)}</div>` : ''}
    <div class="fxacts"><button class="primary" id="fixsave" ${changed && !d.err ? '' : 'disabled'}>Save correction</button>
      <button class="linkbtn muted" data-fixcancel>Cancel</button></div>
  </div>`;
}

// the roster players a team could have had in this game, under current names
function fixRoster(roster, view) {
  const out = {};
  const map = hubNames.map;
  for (const tm of view.teams) {
    const cur = (map && map.teams.get(tm.name)) || tm.name;
    const rt = (roster || []).find((r) => r.name === cur);
    if (!rt) continue;
    const here = new Set(tm.players.flatMap((p) => [p, (map && map.players.get(cur + '\n' + p)) || p]));
    out[tm.name] = rt.players.filter((n) => !here.has(n));
  }
  return out;
}

// The open cell's files float over the grid, just under its room's row,
// so the rooms below stay where they are.
function placeCellPop(box) {
  const pop = box.querySelector('#cellpop');
  const row = cellOpen && box.querySelector(`tr[data-urow="${cellOpen.bid}"]`);
  if (!pop || !row) return;
  const base = pop.parentElement.getBoundingClientRect();
  pop.style.top = (row.getBoundingClientRect().bottom - base.top + 4) + 'px';
}

function wireFix(box, a, t, buckets, files) {
  box.querySelectorAll('[data-fixbuzz]').forEach((btn) => {
    btn.onclick = async () => {
      const fid = Number(btn.dataset.fixbuzz);
      if (fixOpen && fixOpen.fid === fid) { fixOpen = null; render(); return; }
      const f = files.find((y) => y.id === fid);
      fixOpen = { fid, filename: f.filename, tab: 'lineups', loading: true, root: null, err: '', roster: {}, swaps: [], edits: new Map(), lineups: {}, luAdd: null };
      render();
      const x = fixOpen;
      try {
        x.root = await ownedJson(pub, a, f.r2_key);
        const view = buzzFixView(x.root);
        let roster = null;
        if (t.roster_r2_key) { try { roster = parseRoster(await ownedJson(pub, a, t.roster_r2_key)); } catch (e) { /* teammates only */ } }
        x.roster = fixRoster(roster, view);
      } catch (e) { x.root = null; x.err = e.message; }
      x.loading = false;
      if (fixOpen === x) render();
    };
  });
  if (!fixOpen || fixOpen.loading || !fixOpen.root) return;
  const x = fixOpen;
  box.querySelectorAll('[data-fixtab]').forEach((b) => { b.onclick = () => { x.tab = b.dataset.fixtab; render(); }; });
  box.querySelectorAll('[data-fixcancel]').forEach((b) => { b.onclick = () => { fixOpen = null; render(); }; });
  box.querySelectorAll('[data-fswap]').forEach((sel) => {
    sel.onchange = () => {
      const [ti, pi] = sel.dataset.fswap.split(':').map(Number);
      const tm = buzzFixView(x.root).teams[ti];
      const who = tm.players[pi];
      const to = sel.value;
      // a player is in one swap at a time: picking again replaces it
      x.swaps = x.swaps.filter((y) => !(y.team === tm.name && [y.from, y.to].some((n) => n === who || n === to)));
      if (to) x.swaps.push({ team: tm.name, from: who, to });
      fixPrune();
      render();
    };
  });
  box.querySelectorAll('[data-fedit]').forEach((sel) => {
    sel.onchange = () => {
      const [q, j] = sel.dataset.fedit.split(':').map(Number);
      const b = buzzFixView(applyBuzzFix(x.root, { swaps: x.swaps })).buzzes.find((y) => y.q === q && y.j === j);
      if (sel.value === b.player) x.edits.delete(sel.dataset.fedit);
      else x.edits.set(sel.dataset.fedit, sel.value);
      render();
    };
  });
  // the lineups: the first change to a team copies its lineups to edit
  const luEdit = (ti) => {
    const d = fixDerived();
    const lu = fixLineups(d, ti);
    const team = lineupView(d.buzzed || x.root).teams[ti].name;
    if (!x.lineups[team]) x.lineups[team] = lu.segs.map((sg) => ({ from: sg.from, players: [...sg.players] }));
    return { segs: x.lineups[team], questions: lu.questions };
  };
  // a team's lineups changed as the moderator would: starters, subs
  const luChange = (ti, fn) => {
    const { segs } = luEdit(ti);
    const ev = luEvents(segs);
    fn(ev);
    const team = lineupView(fixDerived().buzzed || x.root).teams[ti].name;
    x.lineups[team] = luSegs(ev);
    render();
  };
  box.querySelectorAll('[data-lustart]').forEach((b) => {
    b.onclick = () => luChange(Number(b.dataset.lustart), (ev) => {
      const name = b.dataset.name;
      ev.starters = ev.starters.includes(name) ? ev.starters.filter((p) => p !== name) : [...ev.starters, name];
    });
  });
  box.querySelectorAll('[data-lusubdel]').forEach((b) => {
    b.onclick = () => luChange(Number(b.dataset.lusubdel), (ev) => {
      const sb = JSON.parse(b.dataset.sub);
      const i = ev.subs.findIndex((y) => y.q === sb.q && y.in === sb.in && y.out === sb.out);
      if (i >= 0) ev.subs.splice(i, 1);
    });
  });
  box.querySelectorAll('[data-luaddopen]').forEach((b) => {
    b.onclick = () => {
      const ti = Number(b.dataset.luaddopen);
      x.luAdd = x.luAdd && x.luAdd.ti === ti ? null : { ti, q: 2, in: '', out: '' };
      render();
    };
  });
  if (x.luAdd && $('luaq')) {
    const keep = () => { x.luAdd.in = $('luain').value; x.luAdd.out = $('luaout').value; };
    $('luaq').onchange = () => { keep(); x.luAdd.q = Number($('luaq').value); render(); };
    $('luain').onchange = keep;
    $('luaout').onchange = keep;
    $('luano').onclick = () => { x.luAdd = null; render(); };
    $('luaq').closest('.luadd').onkeydown = (ev) => { if (ev.key === 'Escape') { x.luAdd = null; render(); } };
    $('luaok').onclick = () => {
      keep();
      const { ti, q, in: inn, out } = x.luAdd;
      if (!inn && !out) return;
      x.luAdd = null;
      luChange(ti, (ev) => { ev.subs.push({ q, in: inn, out }); });
    };
  }
  if ($('fixsave')) $('fixsave').onclick = async () => {
    const f = files.find((y) => y.id === x.fid);
    const room = f && buckets.find((b) => b.id === f.bucket_id);
    if (!room) { say('This game\'s room is gone, so it cannot be fixed here', true); return; }
    if (notStarted()) { say(START_FIRST, true); return; }
    let fixed;
    try {
      fixed = applyBuzzFix(x.root, { swaps: x.swaps, edits: fixEdits(x) });
      if (Object.keys(x.lineups).length) fixed = applyLineupFix(fixed, x.lineups);
    } catch (e) { say(e.message, true); return; }
    // through the room that played it, as Edit in MODAQ's correction goes
    const run = busy($('fixsave'), { label: 'Saving' });
    try {
      // The Worker files the fix under f.round and writes that round into
      // it. A game added before uploads took their filed round may say
      // another one; it takes f.round first, so the fix still replaces it
      // in the stats rather than counting as a second game.
      if (statedRound(x.root, f.filename) !== f.round) {
        await pub(`${a}/files/${f.id}`, { method: 'POST', json: { round: f.round } });
      }
      const out = await pub(`/b/${room.secret}/upload?round=${f.round}&name=${encodeURIComponent(f.filename)}`,
        { method: 'POST', body: JSON.stringify(fixed) });
      run.end();
      if (out && out.error) { say(out.error, true); return; }
      fixOpen = null;
      say('Saved as a new upload. Delete it to undo.');
      showDetail();
    } catch (e) { run.end(); say(e.message, true); }
  };
}

/* ---------- forfeits ----------
   The TD records a forfeit as a game: a file whose forfeiting team carries
   forfeit_loss (qbj.js forfeitQbj), sent up the room's own upload route
   like Add a game, so it counts everywhere a game does. The stats count
   it as YellowFruit does: a win and a loss, nothing else. */

// the teams to pick from: the schedule's, else the roster's
function forfeitTeams() {
  const names = new Set();
  if (sched) for (const r of flatRounds(sched)) for (const g of r.games) for (const x of [g.a, g.b]) if (x && x.team) names.add(x.team);
  for (const n of schedTeams || []) names.add(n);
  return [...names].sort((x, y) => x.localeCompare(y));
}

function ffPanelHtml(t, buckets) {
  if (!ffOpen) return '';
  const teams = forfeitTeams();
  const opts = (sel) => `<option value="">Choose a team</option>${teams.map((n) =>
    `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  return `<div id="ffpanel" class="addpanel">
    <div class="row">
      <label>Room <select id="ffroom">${buckets.map((b) =>
        `<option value="${b.id}" ${ffOpen.bid === b.id ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}</select></label>
      <label>Round <input id="ffround" type="number" min="1" max="999" value="${ffOpen.round || t.current_round}" style="width:64px"></label>
    </div>
    <div class="row">
      <label>Forfeited by <select id="fflose">${opts(ffOpen.lose)}</select></label>
      <label>Winner <select id="ffwin">${opts(ffOpen.win)}</select></label>
    </div>
    <div class="muted" style="font-size:13px">A forfeit counts as a win and a loss, with no stats, as YellowFruit counts one.</div>
    <div class="row" style="margin-top:10px">
      <button id="ffsave" class="primary">Record forfeit</button>
      <button id="ffcancel" class="linkbtn muted">Cancel</button>
    </div>
  </div>`;
}

function wireForfeit(a, t, buckets, render) {
  // the scheduled pair for a room and round, the first team as forfeiting
  const prefill = (bid, round) => {
    const b = buckets.find((x) => x.id === bid);
    const pair = b && sched ? scheduledGame(b, round) : null;
    ffOpen = { bid, round, lose: pair ? pair[0] : '', win: pair ? pair[1] : '' };
  };
  if (!$('fftoggle')) return;
  $('fftoggle').onclick = () => {
    if (ffOpen) ffOpen = null;
    else prefill(buckets.length ? buckets[0].id : null, t.current_round);
    render();
  };
  if (!ffOpen) return;
  const reprefill = () => { prefill(Number($('ffroom').value), Number($('ffround').value)); render(); };
  $('ffroom').onchange = reprefill;
  $('ffround').onchange = reprefill;
  $('fflose').onchange = () => { ffOpen.lose = $('fflose').value; };
  $('ffwin').onchange = () => { ffOpen.win = $('ffwin').value; };
  $('ffcancel').onclick = () => { ffOpen = null; render(); };
  $('ffsave').onclick = () => recordForfeit(buckets);
}

async function recordForfeit(buckets) {
  const room = buckets.find((b) => b.id === Number($('ffroom').value));
  const round = Number($('ffround').value);
  const lose = $('fflose').value;
  const win = $('ffwin').value;
  if (!room) { say('Pick a room', true); return; }
  if (!Number.isInteger(round) || round < 1) { say('Pick a round', true); return; }
  if (!lose || !win) { say('Pick both teams', true); return; }
  if (lose === win) { say('Pick two different teams', true); return; }
  if (notStarted()) { say(START_FIRST, true); return; }
  const name = `Round_${round}_${win}_${lose}_Forfeit.qbj`.replace(/[^\w.]+/g, '_');
  const run = busy($('ffsave'), { label: 'Recording', scope: $('ffpanel') });
  try {
    const out = await pub(`/b/${room.secret}/upload?round=${round}&name=${encodeURIComponent(name)}`,
      { method: 'POST', body: JSON.stringify(forfeitQbj(round, win, lose)) });
    run.end();
    if (out && out.error) { say(out.error, true); return; }
    say(`${lose} forfeits to ${win} in round ${round} (${room.room_name})`);
    ffOpen = null;
    cellOpen = { bid: room.id, round };
    showDetail();
  } catch (e) { run.end(); say(e.message, true); }
}

/** Put a game into a room the TD picks, through that room's own upload
    route — the same path, validation and bookkeeping a moderator's upload
    takes, so the game counts everywhere the room's own games do. For a
    round a room never turned in at all; a game that IS there is corrected
    with Edit instead, which keeps MODAQ's question-level record. */
async function addGame(a, buckets) {
  const room = buckets.find((b) => b.id === Number($('addroom').value));
  const round = Number($('addround').value);
  // the match file goes up before its MODAQ game file, as a room's does
  const order = (f) => (/_game\.json$/i.test(f.name) ? 1 : 0);
  const picked = [...$('addfile').files].sort((x, y) => order(x) - order(y));
  if (!room) { say('Pick a room', true); return; }
  if (!Number.isInteger(round) || round < 1) { say('Pick a round', true); return; }
  if (!picked.length) { say('Choose the game files', true); return; }
  if (notStarted()) { say(START_FIRST, true); return; }
  const run = busy($('addgame'), { label: 'Uploading', total: picked.length, scope: $('addpanel') });
  const bad = [];
  try {
    let done = 0;
    for (const file of picked) {
      const out = await pub(
        `/b/${room.secret}/upload?round=${round}&name=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: await file.text() });
      // The Worker stores an unparseable game with its error rather than
      // rejecting it, the same as for a room — say so instead of "done".
      if (out && out.error) bad.push(file.name + ': ' + out.error);
      run.step(++done);
    }
    run.end();
    if (bad.length) say(bad.join('; '), true);
    else say(`${picked.length === 1 ? picked[0].name : picked.length + ' files'} added to ${room.room_name}, round ${round}`);
    addOpen = null;
    cellOpen = { bid: room.id, round };
    showDetail();
  } catch (e) { run.end(); say(e.message, true); }
}

/* ---------- protests ----------
   What moderators log in MODAQ, from the newest upload of each game,
   with the swing an upheld ruling would produce (protests.js) and the
   TD's ruling per row. The collapsed summary names the newest open one. */

function renderProtests(rows, open, isOpen) {
  const first = open[0];
  const summary = first
    ? `${open.length} open &middot; R${first.round} ${esc(first.room)}: ${esc(first.p.team)} protests ${
      qLabel(first.p)}${first.flips ? ' &middot; can flip the result' : ''}`
    : rows.length ? 'Nothing open' : 'None logged';
  return `
    <details class="drawer" id="protdrawer" ${isOpen ? 'open' : ''}>
      <summary><span class="dtitle">All protests</span><span class="muted">${summary}</span></summary>
      <div class="inner">
        ${rows.length ? `<div class="tablewrap" style="margin-top:8px"><table>
          <tr><th>Round</th><th>Room</th><th>Question</th><th>Protest</th><th>Score</th><th>Ruling</th></tr>
          ${rows.map((r) => `<tr class="protest ${r.ruling === 'open' && !r.superseded ? '' : 'ruled'}">
            <td class="num">${r.round}</td>
            <td>${esc(r.room)}<br><span class="muted" style="font-size:13px">${esc(r.teams[0])} v ${esc(r.teams[1])}</span>${
              r.superseded ? '<br><span class="pill">Before the correction</span>' : ''}</td>
            <td><span class="q">${qLabel(r.p)}</span>${r.p.word ? `<br><span class="muted" style="font-size:13px">word ${r.p.word}</span>` : ''}</td>
            <td><b>${esc(r.p.team)}</b>${r.p.given ? ` answered <span class="given">${esc(r.p.given)}</span>` : ''}
              <span class="reason">${esc(r.p.reason)}</span></td>
            <td>${r.live ? '<span class="pill">Game in progress</span><br>' : `<span class="score">${esc(r.teams[0])} ${r.score[0]}<br>${esc(r.teams[1])} ${r.score[1]}</span><br>`}
              ${!r.known || r.live ? '' : r.flips
                ? '<span class="pill warn">Can flip the result</span>'
                : '<span class="pill">Result stands</span>'}
              ${r.known && !r.live ? `<span class="swing">If upheld: ${esc(r.teams[0])} ${r.upheld[0]} &ndash; ${esc(r.teams[1])} ${r.upheld[1]}</span>` : ''}
              ${swingLines(r).map((x) => `<span class="swing">${esc(x)}</span>`).join('')}</td>
            <td><div class="ruling">
              <select data-rule="${esc(r.key)}">${RULINGS.map(([v, l]) =>
                `<option value="${v}" ${r.ruling === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <input data-rnote="${esc(r.key)}" maxlength="300" placeholder="Ruling note (stays on the hub)" value="${esc(r.note)}">
              ${r.at && r.ruling !== 'open' ? `<span class="who">${rulingLabel(r.ruling)} ${esc(clockTime(r.at))}</span>` : ''}
              ${r.ruling === 'upheld' || r.superseded ? (r.corrected
                ? '<span class="who ok">Corrected game received</span>'
                : `<span class="followup wait">Waiting for ${esc(r.room)} to upload the corrected game</span>`) : ''}
            </div></td>
          </tr>`).join('')}
        </table></div>` : ''}
        <div class="muted" style="font-size:13px;margin-top:8px">
          ${rows.length
            ? 'For your records only. The moderator should fix the game in MODAQ and re-export.'
            : 'Protests show up here as soon as a moderator logs them in MODAQ, with the score swing an upheld ruling would produce.'}
        </div>
      </div>
    </details>`;
}

/* ---------- stats + export ---------- */

// The games themselves are read by hubgames.js: collectMatches, shared by
// Compute stats and the playoff fill below, and ownedJson for one file.

/* ---------- playoff slots fill themselves ----------
   Once a pool's prelim games are all in — told from the upload list the
   hub already holds, so watching costs the Worker nothing — the hub reads
   those games, ranks the pool as its public table does (stats.js
   standings) and saves its playoff slots filled: the same
   requests the editor's Fill button makes, once, with games already read
   kept. It fills the saved schedule, not this tab's copy, and leaves it
   alone while the TD has unsaved schedule edits. Ties for different
   brackets go by points per 20 tossups heard, unless the schedule has a
   Tiebreakers phase: then those slots wait for the TD (autoFill).
   The Finals ("1st in 1st–6th place") fill the same way once that
   bracket's games are all in, ranked on its own games plus the ones its
   pool-mates carry over, and on each time its pools played when they
   played again (finals.js). */
let autoSig = null;           // uploads last looked at
let autoBusy = false;
let autoWait = { held: [], odd: [], finals: [] }; // what waits for the TD, for the Live Hub
let autoForce = [];           // pools (and 'F:' + a finals bracket) the TD said to fill anyway
const autoCache = new Map();  // games already read (public copies), shared with Fill

async function autoFillSlots(force = false) {
  if (autoBusy || !lastDetail || !sched || schedDirty || !hasPlaceholders(sched)) return;
  if (shownView === 'setup' && setupTab === 'sched') return; // the editor holds this schedule
  const { tournament: t, buckets } = lastDetail;
  if (!t.started) return;
  // the uploads under the teams' current names: a roster save renames the
  // schedule, while a game keeps the names it was played under
  const files = namedFiles(lastDetail.files, hubNames.map);
  // what may be ready, told from this tab's copy under the same renames: a
  // rename saved in another tab renamed the saved schedule, not this copy
  const renames = hubNames.map ? Object.fromEntries(hubNames.map.teams) : {};
  let mine = sched;
  if (Object.keys(renames).length) {
    mine = JSON.parse(JSON.stringify(sched));
    renameTeams(mine, renames);
  }
  const prog = fillProgress(mine, files);
  // the renames too: a pool that waited on one this tab hadn't loaded
  // fills once it has, with no new upload
  const sig = prog.sig + '#' + JSON.stringify(Object.entries(renames).sort());
  if ((!prog.pools.ready.length && !prog.finals.ready.length) || (sig === autoSig && !force)) return;
  autoBusy = true;
  const a = '/a/' + adminSecret;
  try {
    const opts = { cache: autoCache, rank: true };
    const got = await collectMatches(pub, a, t, buckets, prog.files, () => {}, opts);
    if (!got.matches.length) return;
    let saved = null;
    let etag = null;
    try { ({ json: saved, etag } = await readTagged(a, `t/${t.id}/schedule.json`)); } catch (e) { /* none saved */ }
    if (!saved || schedDirty) return;
    // the saved schedule says what is ready and which games that takes;
    // this tab's copy may be older (another tab's save)
    const fill = async (copy) => {
      const want = fillProgress(copy, files);
      const read = new Set(got.matches.map((m) => m.fileId));
      const more = want.files.filter((f) => !read.has(f.id));
      if (more.length) {
        got.matches.push(...(await collectMatches(pub, a, t, buckets, more, () => {}, opts)).matches);
        if (schedDirty) return null;
      }
      // a game that couldn't be read holds its pool: look again on the next refresh
      const ids = new Set(got.matches.map((m) => m.fileId));
      autoSig = want.files.every((f) => ids.has(f.id)) ? sig : null;
      const res = autoFillSaved(copy, files, got.matches, got.roster, autoForce, gameFormat(t));
      const said = [];
      if (res.playoffs) {
        autoWait = { ...autoWait, held: res.playoffs.held, odd: res.playoffs.odd };
        const ps = res.playoffs.pools;
        if (res.playoffs.filled) said.push(ps.length ? `the playoff slots from ${ps.length > 1 ? 'pools' : 'pool'} ${andList(ps)}` : 'some playoff slots');
      }
      if (res.finals) {
        autoWait = { ...autoWait, finals: res.finals.held };
        if (res.finals.filled) said.push(`the Finals from ${andList(res.finals.brackets)}`);
      }
      return { schedule: res.schedule, said };
    };
    let res = await fill(saved);
    if (!res) return;
    // the save lands only on the copy read here (saves.js). Another tab's
    // save since then comes back: that copy is filled once more, with the
    // games already read; deleted since, there is nothing to fill
    let out = null;
    if (res.schedule !== saved) {
      out = await postSchedule(a, res.schedule, etag);
      if (out && out.conflict) {
        if (!out.schedule || schedDirty) return;
        saved = out.schedule;
        etag = out.etag;
        res = await fill(saved);
        if (!res) return;
        out = res.schedule !== saved ? await postSchedule(a, res.schedule, etag) : null;
        if (out && out.conflict) throw new Error('the schedule was saved again meanwhile');
      }
    }
    if (out) {
      if (schedDirty) return;
      sched = res.schedule;
      schedEtag = out.etag;
      say('Filled ' + andList(res.said));
    } else {
      sched = saved;
      schedEtag = etag;
    }
    if (shownView === 'live') render();
  } catch (e) {
    autoSig = null; // try again on the next refresh
  } finally { autoBusy = false; }
}
const andList = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

// The Live Hub's Playoffs line: ties points per 20 settled (finals.js
// filledNote), and pools waiting for the TD (heldLevel: what filling now
// does with teams level on points per 20 too). Gone once a playoff game
// is in. The Finals line the same, gone once a finals game is in.
function playoffNoteHtml(files) {
  if (!sched) return '';
  const played = (rounds) => files.some((f) => isGameFile(f) && rounds.has(f.round));
  const prelim = new Set(prelimRounds(sched).map((r) => r.round));
  const all = new Set(sched.phases.flatMap((ph) => ph.rounds.map((r) => r.round)));
  const out = [];
  if (![...all].some((n) => !prelim.has(n) && played(new Set([n])))) {
    const lines = [];
    for (const x of (sched.filled || []).filter((y) => y.pool)) lines.push(esc(filledNote(x)));
    for (const x of autoWait.odd) {
      lines.push(`Pool ${esc(x.pool)} has ${x.games.map((g) => `${esc(g.a)} vs ${esc(g.b)} (round ${g.round})`).join(', ')}, which isn&rsquo;t on the schedule.
        <button class="linkbtn" data-fillpool="${esc(x.pool)}">Fill anyway</button>`);
    }
    for (const x of autoWait.held) {
      const by = {};
      x.teams.forEach((tm) => { by[tm.bracket] = (by[tm.bracket] || 0) + 1; });
      const spots = Object.entries(by).map(([b, n]) => `${n === 1 ? 'one spot' : n + ' spots'} in ${esc(b)}`);
      const lv = heldLevel(x);
      lines.push(`Pool ${esc(x.pool)}: ${esc(andList(x.teams.map((tm) => tm.name)))} are tied at ${esc(x.record)} for ${andList(spots)}.${esc(lv.text)}
        <button class="linkbtn" data-fillpool="${esc(x.pool)}">${esc(lv.label)}</button>`);
    }
    if (lines.length) out.push(['Playoffs', lines]);
  }
  const finalRounds = new Set(sched.phases.filter((ph) => ph.kind === 'final').flatMap((ph) => ph.rounds.map((r) => r.round)));
  if (finalRounds.size && !played(finalRounds)) {
    const lines = [];
    const places = (teams) => andList(teams.map((tm) => ordinal(tm.place)));
    for (const x of (sched.filled || []).filter((y) => y.bracket)) lines.push(esc(filledNote(x)));
    for (const x of autoWait.finals) {
      const lv = heldLevel(x);
      lines.push(`${esc(x.bracket)}: ${esc(andList(x.teams.map((tm) => tm.name)))} are tied at ${esc(x.record)} for ${places(x.teams)} place.${esc(lv.text)}
        <button class="linkbtn" data-fillpool="${esc('F:' + x.bracket)}">${esc(lv.label)}</button>`);
    }
    if (lines.length) out.push(['Finals', lines]);
  }
  return out.map(([head, lines]) => `<div class="banner playoffnote"><span style="font-weight:600">${head}</span>
    <div>${lines.map((l) => `<div>${l}</div>`).join('')}</div></div>`).join('');
}

async function computeStats(a, t, buckets, files, settings) {
  const out = $('statsout');
  out.innerHTML = '';
  $('statsec').hidden = false;
  // counts the games it fetches, one request each
  const nGames = files.filter(isGameFile).length;
  const run = busy($('calc'), { label: 'Computing stats', total: nGames, scope: $('calc').closest('.row') });
  let got;
  try {
    got = await collectMatches(pub, a, t, buckets, files, (done) => run.step(done), { cache: statsCache });
  } finally { run.end(); }
  lastStats = { a, t, buckets, files, settings, got };
  showStats(lastStats);
}

let lastStats = null; // the games Compute fetched, so a new pick needs no refetch
// every upload Compute has read in this tab: pressing it again reads only new ones
const statsCache = new Map();
function showStats({ a, t, files, settings, got }) {
  const out = $('statsout');
  if (!out) return;
  // the stages and rounds picked (statRounds); null keeps every game
  const keepRounds = statRounds(t, got.matches);
  const inPick = (x) => !keepRounds || keepRounds.has(x.round);
  const { roster, errors } = got;
  const matches = got.matches.filter(inPick);
  const raw = got.raw.filter(inPick);
  const games = got.games.filter(inPick);
  const modaqFiles = (got.modaqFiles || []).filter(inPick);
  const allRaw = got.raw;
  out.innerHTML = '';

  if (!got.matches.length) {
    out.innerHTML = `<div class="bad">No readable game files</div>
      ${errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}`;
    return;
  }
  if (!matches.length) {
    // nothing to download until the pick holds a game
    out.innerHTML = '<div class="muted">No games are in the stages and rounds picked.</div>';
    $('dlmenu').disabled = true;
    $('statsnote').textContent = 'No games in these stats';
    return;
  }

  // ranked and figured as the public page does it (overtime out)
  renderStats(out, standings(matches, roster, effectiveFormat(settings)), errors);

  // The tournament's own rules reach every export: the .yft's scoring
  // rules, the overtime split, and the stat report's rate-stat scaling all
  // come from the regulation tossup count and answer values the TO set
  // under Tournament Setup -> MODAQ Settings. Without them the exports
  // silently assumed 20 tossups, which turned the last two tossups of
  // every game at a longer event into overtime nobody played.
  // The saved schedule gives the YellowFruit 4 file its stages: pools,
  // playoff brackets with their carryover, finals (yft.js yfStages). A
  // round robin, or a schedule not filled in yet, stays one stage.
  const exportOpts = {
    name: t.name, matches: dedupeMatches(matches), roster,
    settings: effectiveFormat(settings), schedule: sched,
  };
  // The two YellowFruits share an extension and nothing else, and neither
  // says so when handed the other's file: YellowFruit 4 refuses a file
  // stamped newer than itself, and YellowFruit 3 throws before it can show
  // an error. So the menu names the version, and what it needs, on each
  // item. The files are still named apart, so both can sit in one folder.
  $('dlmenu').disabled = false;
  for (const id of ['dlyft4', 'dlyft3', 'dlreport', 'dlreportfiles', 'dlzip', 'rebuild']) $(id).disabled = false;
  const closeMenu = () => { $('dlpanel').hidden = true; $('dlmenu').setAttribute('aria-expanded', 'false'); };
  // games, not files: a re-exported game counts once, as it does in the stats
  const n = exportOpts.matches.length;
  const nGames = `${n} ${n === 1 ? 'game' : 'games'}`;
  const kept = keepRounds ? [...keepRounds].sort((x, y) => x - y) : null;
  const stages = statStages().filter((x) => !pickFor(t).off.includes(x.i)).map((x) => x.name);
  $('statsnote').textContent = !kept ? `${nGames} in these stats`
    : pickFor(t).finished || stages.length === statStages().length ? `${nGames} in ${kept.length ? roundSpan(kept) : 'no rounds'}`
      : `${nGames} in ${andList(stages)}`;
  const yft = (f) => {
    try { download(f.name, f.data, f.type); closeMenu(); }
    catch (e) { say(e.message, true); }
  };
  $('dlyft4').onclick = () => yft(yftFile(t.slug, exportOpts, 4));
  $('dlyft3').onclick = () => yft(yftFile(t.slug, exportOpts, 3));
  // YellowFruit-style six-page HTML report, zipped so the interlinked
  // files land as one folder ready to host. Named <slug>_standings.html
  // etc., as YellowFruit saves them: the hsquizbowl.org tournament
  // database refuses report files without that prefix.
  $('dlreport').disabled = false;
  $('dlreport').onclick = () => {
    try {
      const z = reportZipFile(t.slug, exportOpts);
      download(z.name, z.data, z.type);
      closeMenu();
    } catch (e) { say(e.message, true); }
  };
  // the same pages as six files, for a TD who would rather not unzip; the
  // browser may ask once to allow several downloads. Saved into one
  // folder, their links to each other work as in the zip.
  $('dlreportfiles').disabled = false;
  $('dlreportfiles').onclick = async () => {
    try {
      const pages = reportPages(t.slug, exportOpts);
      closeMenu();
      for (const f of pages) {
        download(f.name, f.text, 'text/html');
        await new Promise((res) => setTimeout(res, 300)); // one at a time, or the browser drops some
      }
    } catch (e) { say(e.message, true); }
  };
  $('dlzip').disabled = false;
  $('dlzip').onclick = async () => {
    const run = busy($('dlzip'), { label: 'Building zip', scope: $('dlzip').closest('.row') });
    try { await buildZip(); closeMenu(); } finally { run.end(); }
  };
  const buildZip = async () => {
    // The games the standings count, each as its separated files: match
    // .qbj + MODAQ game file (hubgames.js qbjZipFile). The game files that
    // went up apart from their .qbj (Add a game) are read one after
    // another, in upload order, then the roster.
    const gameFiles = [];
    for (const f of files.filter((x) => x.kind === 'game' && inPick(x))) {
      const { round, filename } = f;
      try { gameFiles.push({ round, filename, text: JSON.stringify(await ownedJson(pub, a, f.r2_key), null, 2) }); }
      catch (e) { gameFiles.push({ round, filename, error: true }); }
    }
    let rosterFile = null;
    if (t.roster_r2_key) {
      try { rosterFile = { json: await ownedJson(pub, a, t.roster_r2_key) }; }
      catch (e) { rosterFile = { error: true }; }
    }
    const z = qbjZipFile(t.slug, { matches, modaqFiles, raw, gameFiles, roster: rosterFile, names: got.names });
    download(z.name, z.data, z.type);
  };
  $('rebuild').disabled = false;
  $('rebuild').onclick = async () => {
    // the public stats always hold every game, whatever the pick
    const batches = Math.ceil(allRaw.length / REBUILD_BATCH);
    const run = busy($('rebuild'), { label: 'Rebuilding', total: batches, scope: $('rebuild').closest('.row') });
    try {
      const entries = allRaw.map((r) => ({
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
        run.step(i / REBUILD_BATCH + 1);
      }
      say('Stats data rebuilt (' + posted + ' games); the player page picks it up within a minute');
    } catch (e) { say(e.message, true); }
    run.end();
    closeMenu();
  };
}

/* ---------- boot ---------- */

if (adminSecret) {
  showDetail();
  // The Live Hub is watched through the day while rooms start, upload and
  // move rounds on: refresh it while it's the visible tab, and at once on
  // coming back to it — never mid-typing or under an open dialog, which a
  // redraw would wipe. Each refresh sends the rev it holds, so one that
  // finds nothing new costs the Worker a single lookup; and while nothing
  // moves the checks slow from every 30s to 60s (after 2 quiet ones) and
  // 120s (after 4), snapping back to 30s on any change or on a return to
  // the tab. Rounds advancing never wait on this: that's the Worker's.
  let quietChecks = 0;
  let timer = null;
  // while the public page mark reads Updating, check at least once a
  // minute, so it turns to Up to date without a reload
  const nextCheck = () => Math.min(quietChecks >= 4 ? 120 : quietChecks >= 2 ? 60 : 30,
    lastDetail && pubWaiting(lastDetail.tournament) ? 60 : 120) * 1000;
  const liveRefresh = async () => {
    clearTimeout(timer);
    try {
      if (document.visibilityState !== 'visible' || !lastDetail) return;
      // Setup isn't redrawn under the TD (the schedule editor holds work):
      // there, only the mark moves, and only while it reads Updating
      if (shownView !== 'live') {
        if (!pubWaiting(lastDetail.tournament)) { notePub({}); return; }
        const held = lastDetail.tournament.rev;
        const x = await pub('/a/' + adminSecret + '?rev=' + held).catch(() => null);
        notePub(x && (x.unchanged ? x : x.tournament));
        return;
      }
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (!$('linkmodal').hidden) return;
      // files picked in Add a game, or an open Download menu, would be wiped
      if (addOpen || ($('dlpanel') && !$('dlpanel').hidden)) return;
      const moved = await showDetail(true, lastDetail.tournament.rev);
      quietChecks = moved ? 0 : quietChecks + 1;
    } finally {
      timer = setTimeout(liveRefresh, nextCheck());
    }
  };
  timer = setTimeout(liveRefresh, nextCheck());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    quietChecks = 0;
    liveRefresh();
  });
} else if (inviteSecret) showInvite();
else showList();
