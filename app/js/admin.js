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
import { parseMatch, parseRoster, matchPayload, buildRosterQbj } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { serializeYft } from '../engine/yft.js';
import { serializeYft3 } from '../engine/yft3.js';
import { buildReport } from '../engine/report.js';
import { makeZip } from '../engine/zip.js';
import { renderStats } from './statsview.js';
import { renderPacketsUi, stagedBlob } from './packetsui.js';
import { formatHtml, wireFormat } from './formatui.js';
import { effectiveFormat, metaKey, gameKey, storeIntact, formatKey, GAME_FORMAT_OPTIONS } from './read_core.js';
import { slotText, roundIntake, poolStandings, roundRooms, flatRounds, renameTeams, rosterRenames } from '../engine/schedule.js';
import { renderSchedStep, schedEscape } from './schededit.js';
import { bracketModel, bracketRounds, bracketInfo, maxRound, phaseOfRound, roomIndexOf, roomRound, roomBracket, gameIn, advanceAll, slotLabel, liveLayout } from '../engine/brackets.js';
import { buzzCredentials } from './buzzkey.js';
import { busy } from './busy.js';
import { protestRows, swingLines, qLabel, RULINGS, rulingLabel, fileSummary } from './protests.js';

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
function bucketLink(secret) { return pageDir() + '/bucket.html?b=' + secret; }
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
            ${live ? '' : `<a href="${esc(statsLink(e.slug))}">Public page</a>`}
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
        + 'The tournament itself is not deleted: its rooms and public page keep working. '
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
    $('newhint').textContent = $('newslug').value ? 'Public page: ' + statsLink($('newslug').value) : '';
  };
  $('newname').oninput = () => { if (!ownSlug) $('newslug').value = slugFor($('newname').value); hint(); };
  $('newslug').oninput = () => { ownSlug = $('newslug').value !== ''; hint(); };
  $('newbtn').onclick = async () => {
    const run = busy($('newbtn'), { label: 'Creating' });
    try {
      const out = await pub('/api/tournaments', { method: 'POST', json: {
        name: $('newname').value, slug: $('newslug').value,
      } });
      run.end();
      saveLink({ secret: out.admin_secret, slug: out.slug, name: out.name,
        closes: out.closes, created: Date.now() });
      showLinkModal(adminLink(out.admin_secret), out.closes, () => {
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
      showLinkModal(adminLink(out.admin_secret), out.closes, () => {
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

let rosterOpen = false;
let rosterTeams = null; // structured editor working copy [{name, players, was}]; was: the saved name
let rosterUpload = null; // parsed upload awaiting confirmation

let uploadsOpen = null;  // Set of expanded upload rounds; null = current round only
let cellOpen = null;     // uploads grid: {bid, round} whose files show under its row
let addOpen = null;      // Add a game panel: {bid, round} to prefill, or null when closed
let protOpen = null;     // Protests drawer; null = auto: open when a protest is unruled
// clock time of a ruling (protests drawer)
function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// "Oct 1, 4:54 AM": when links close, short enough for a header line
function fmtWhen(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

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
  await ensureSched(a, t);
  // the route, not the blob: on a set's mirror the pool is the set's
  // backup questions (read live) followed by this tournament's own
  try { tbPool = await pub(a + '/tiebreakers'); }
  catch (e) { tbPool = null; }
  lastDetail = detail;
  render();
  // the header isn't redrawn when the view stays put: its mark is
  notePub({});
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
    return '<span id="pubmark" class="pubstat wait" title="Publishing to the public page is failing and retrying on its own. '
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
    ['stats', 'Public page', !!settings.statsSeen,
      (t.published ? 'Public' : 'Page off')
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
        <button class="linkbtn" onclick="qtd.copy('${esc(statsLink(t.slug))}', 'public link')">Copy public link</button>
        <a href="${esc(statsLink(t.slug))}" target="_blank">Open public page</a>
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
      showLinkModal(adminLink(out.admin_secret), t.closes, () => location.reload());
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
  const LABEL = { packets: 'Packets + Tiebreakers', stats: 'Public page' };
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
    save: async (next) => { await pub(a, { method: 'POST', json: { settings: next } }); },
    say, refresh: showDetail, onToggle: () => {},
  });
}

/* ---------- Stats settings: what the public stats page shows ---------- */

function renderStatsSec(a, t, settings) {
  const box = $('setupsec');
  // Opening this tab is the decision the checklist wants: the page starts
  // public, so a TD who looks and leaves it on has chosen too.
  if (!settings.statsSeen) {
    // set here too, so a buzzpoints save below (which writes the whole
    // settings object) can't undo it
    settings = { ...settings, statsSeen: true };
    pub(a, { method: 'POST', json: { settings } }).then(showDetail, () => {});
  }
  const buzz = settings.buzz || {};
  const locked = !!(t.set && t.set.lock_buzz);
  box.innerHTML = `
    <h2>Public page</h2>
    <div class="row" style="margin-bottom:6px">
      <label class="row"><input type="checkbox" id="pub" ${t.published ? 'checked' : ''}> Public page</label>
    </div>
    <p class="muted" style="margin:0">Turn on for schedule, semi-live stats, category stats,
      and buzzpoints (if enabled) to be accessible to players.</p>
    <div class="row" style="margin-top:10px">
      <a class="mono" href="${esc(statsLink(t.slug))}" target="_blank">${esc(statsLink(t.slug))}</a>
      <button class="small" onclick="qtd.copy('${esc(statsLink(t.slug))}', 'public link')">Copy</button>
    </div>
    <h2>Buzzpoints</h2>
    <div class="row">
      <label class="row">Buzzpoints
        <select id="buzzmode" ${locked ? 'disabled' : ''}>
          <option value="">Off</option>
          <option value="password" ${buzz.mode === 'password' ? 'selected' : ''}>On (password)</option>
        </select>
      </label>
      ${buzz.hash ? '<span class="pill on">Password set</span>' : ''}
      <input id="buzzpw" type="password" placeholder="Password" size="16" ${buzz.mode === 'password' ? '' : 'hidden'}>
      <button id="buzzset" ${buzz.mode === 'password' ? '' : 'hidden'}>Set password</button>
    </div>
    <p class="muted" style="margin:6px 0 0">Updates buzzpoints (password-locked) when all games during a round finish.</p>
    ${locked ? `<div class="muted" style="font-size:13px;margin-top:6px">The editors of
      <b>${esc(t.set.name)}</b> have switched buzzpoints off for its mirrors while the set is still being
      played elsewhere, so the public page shows none, whatever is set here.</div>` : ''}`;
  $('pub').onchange = async () => {
    try {
      await pub(a, { method: 'POST', json: { published: $('pub').checked } });
      say($('pub').checked ? 'Public page on' : 'Public page off');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  const saveSettings = async (next, extra) => {
    await pub(a, { method: 'POST', json: { settings: next, ...extra } });
    settings = next;
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
      const run = busy($('buzzset'), { label: 'Setting password', scope: box });
      try {
        const cred = await buzzCredentials(pw);
        await saveSettings({ ...settings, buzz: cred.settings }, { buzz_token: cred.token });
      } finally { run.end(); }
      say('Buzzpoints password set');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
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
    ${buckets.length ? `<div class="tablewrap"><table class="roomtable">
      <tr><th>Name</th><th>Reader link</th><th>Upload page</th><th class="num">Files</th><th></th></tr>
      ${buckets.map((b) => {
        // names go into a JS string inside an attribute: escape for both
        const js = (s) => esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        return `<tr>
          <td><input class="inlinename" data-roomrename="${b.id}" value="${esc(b.room_name)}" aria-label="Room name"></td>
          <td class="linkpair"><button class="linkbtn" onclick="qtd.copy('${js(readLink(b.secret))}', '${js(b.room_name)} reader link')">Copy</button>
            <a class="muted" href="${esc(readLink(b.secret))}" target="_blank">Open</a></td>
          <td class="linkpair"><button class="linkbtn" onclick="qtd.copy('${js(bucketLink(b.secret))}', '${js(b.room_name)} upload page')">Copy</button>
            <a class="muted" href="${esc(bucketLink(b.secret))}" target="_blank">Open</a></td>
          <td class="num muted">${files.filter((f) => f.bucket_id === b.id).length}</td>
          <td class="num"><button class="linkbtn muted" data-delbucket="${b.id}">Remove</button></td>
        </tr>`;
      }).join('')}
    </table></div>
    <p class="muted" style="font-size:13px;margin:6px 0 0">${t.started
      ? `Room links work until ${esc(new Date(t.closes).toLocaleString())}, when the tournament closes.`
      : 'Room links show &ldquo;Tournament hasn&rsquo;t started&rdquo; until you press Start tournament.'}</p>`
    : '<div class="muted">No rooms yet</div>'}
    <div class="row" style="margin-top:10px">
      <label>${buckets.length ? 'Add' : 'Create'}
        <input id="roomn" type="number" min="1" max="60" value="${buckets.length ? 2 : 8}" style="width:64px">
        ${buckets.length ? 'more rooms' : 'rooms'}</label>
      <button id="mkrooms" class="primary">${buckets.length ? 'Add rooms' : 'Create rooms'}</button>
    </div>`;
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
        wrap.innerHTML = '<table class="roomtable"><tr><th>Name</th><th>Reader link</th><th>Upload page</th><th class="num">Files</th><th></th></tr></table>';
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
        ? `Created ${made} of ${n} rooms. Room ${next + made} failed: ${e.message}. Press ${again} to make the other ${n - made}.`
        : e.message, true);
    }
    run.end();
    showDetail();
  };
  box.querySelectorAll('[data-roomrename]').forEach((inp) => {
    inp.onchange = async () => {
      const name = inp.value.trim();
      if (!name) { inp.value = ''; return; }
      try {
        await pub(a + '/buckets/' + inp.dataset.roomrename, {
          method: 'POST', json: { room_name: name } });
        // the Worker renamed the saved schedule's copy; the one held here
        // (saved or mid-edit) follows, so a later save doesn't undo it
        const bid = Number(inp.dataset.roomrename);
        if (sched && Array.isArray(sched.rooms)) sched.rooms.forEach((r) => { if (r && r.bucket === bid) r.name = name; });
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
  const played = new Set(files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error).map((f) => f.round));
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
    setSlots: (n) => pub(a, { method: 'POST', json: { settings: { ...settings, rounds: n } } }),
    minSlots,
    countNote: fromSched ? (slots > fromSched ? `the schedule has ${fromSched}` : 'from the schedule') : '',
    uploadPacket: (s, round) => pub(`${a}/packet?round=${round}&name=${encodeURIComponent(s.name)}`,
      { method: 'POST', body: stagedBlob(s) }),
    uploadTb: async (name, data) => {
      try {
        const out = await pub(`${a}/tiebreakers?name=${encodeURIComponent(name)}`,
          { method: 'POST', body: new Blob([data], { type: 'application/json' }) });
        say(`${name} split into ${out.added.tossups} tossups + ${out.added.bonuses} bonuses`);
        return true;
      } catch (e) { say(e.message, true); return false; }
    },
    clearTb: () => pub(a + '/tiebreakers', { method: 'DELETE' }),
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
  box.innerHTML = `
    <h2>Roster</h2>
    <div class="row">
      ${t.roster_name
        ? `<span>${esc(t.roster_name)}</span>
           <a href="${esc(`${API}${a}/file?key=${encodeURIComponent(t.roster_r2_key)}&dl=${encodeURIComponent(t.roster_name)}`)}" download>Download</a>`
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
          rosterTeams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key))
            .map((tm) => ({ name: tm.name, players: [...tm.players], was: tm.name }));
        } catch (e) { /* unparseable upload: start blank */ }
      }
      if (rosterTeams === null) rosterTeams = [{ name: '', players: ['', '', '', ''] }];
    }
    renderRosterEditor(a, t);
  };
  renderUpPreview(a);
  renderRosterEditor(a, t);
}

// What an uploaded roster renames, against the saved one ({} if none).
async function upRenames(a) {
  const t = lastDetail.tournament;
  if (!t.roster_r2_key || !rosterUpload) return {};
  try { return rosterRenames(parseRoster(await fetchOwnedJson(a, t.roster_r2_key)), rosterUpload.teams); }
  catch (e) { return {}; }
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
      u.renames = r;
      if (rosterUpload === u) renderUpPreview(a);
    });
  }
  const renamed = Object.entries(u.renames || {});
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
      ${renamed.length ? `<div style="font-size:13px;margin-top:6px">Renamed teams, matched by their players or seed.
        The schedule will use the new names: ${renamed.map(([x, y]) => `${esc(x)} &rarr; <b>${esc(y)}</b>`).join(' &middot; ')}</div>` : ''}
    </div>`;
  $('upconfirm').onclick = async () => {
    try {
      const t = lastDetail.tournament;
      const renames = u.renames || await upRenames(a);
      // Save the roster rebuilt from its parsed teams, not the file as
      // uploaded: MODAQ reads only a versioned tournament with a name, and
      // a file qb-td can parse may be neither. Names are all either keeps.
      await pub(`${a}/roster?name=${encodeURIComponent(u.filename)}`,
        { method: 'POST', body: JSON.stringify(buildRosterQbj(lastDetail.tournament.name, u.teams)) });
      rosterUpload = null;
      rosterTeams = null;   // editor reloads from the new roster
      schedFetched = false; // schedule editor re-reads the team list
      // …and has the new names at once, so a schedule generated before
      // that refetch lands is built from this roster, not the last one
      schedTeams = u.teams.map((tm) => tm.name);
      say(await savedNote(a, t, renames));
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
      <span class="muted">&middot; Card order is seed order</span>
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
    const run = busy($('rostersave'), { label: 'Saving' });
    const renames = {};
    rosterTeams.forEach((tm, i) => {
      if (tm.was && tm.was !== clean[i].name) renames[tm.was] = clean[i].name;
    });
    try {
      await pub(`${a}/roster?name=roster.qbj`,
        { method: 'POST', body: JSON.stringify(buildRosterQbj(t.name, clean), null, 2) });
      rosterTeams = clean.map((tm) => ({ name: tm.name, players: [...tm.players], was: tm.name }));
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
// place and stays unsaved.
async function followRenames(a, t, renames) {
  if (!Object.keys(renames).length) return 0;
  let saved = null;
  try { saved = await fetchOwnedJson(a, `t/${t.id}/schedule.json`); } catch (e) { /* none saved */ }
  let n = 0;
  if (saved && saved.phases && renameTeams(saved, renames)) {
    await pub(a + '/schedule', { method: 'POST', json: saved });
    n = 1;
  }
  if (sched && schedDirty) n = renameTeams(sched, renames) || n;
  else if (sched && saved) sched = saved;
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
  try { schedTeams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)).map((x) => x.name); }
  catch (e) { schedTeams = []; }
  let got = null;
  try { got = await fetchOwnedJson(a, `t/${t.id}/schedule.json`); } catch (e) { got = null; }
  if (sched === before) sched = got;
}

function renderScheduleSec(a, t, buckets, files) {
  const outer = $('setupsec');
  outer.innerHTML = '<h2>Schedule</h2><div id="schedsec"></div>';
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
    roomsN: () => schedRoomsN,
    setRoomsN: (n) => { schedRoomsN = n; },
    save: (s) => pub(a + '/schedule', { method: 'POST', json: s }),
    del: () => pub(a + '/schedule', { method: 'DELETE' }),
    fill: async () => {
      const { matches, roster } = await collectMatches(a, t, buckets, files);
      if (!matches.length) return null;
      return poolStandings(sched.pools, aggregate(matches, roster).teams.map((x) => x.name));
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
function addListHtml(fs) {
  if (!fs.length) return '';
  const kinds = fs.map((f) => addKind(f.name));
  const lone = kinds.includes('Match file') && !kinds.includes('MODAQ game file') && !kinds.includes('Reader upload');
  return fs.map((f, i) => `<div class="addfile"><span class="mono">${esc(f.name)}</span>
      <span class="muted">${kinds[i]}</span></div>`).join('')
    + (lone ? '<div class="muted small">Stats will count it. Without the game file it can&rsquo;t be reopened in the reader.</div>' : '');
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
  const good = (f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error;
  const startedAt = (bid, n) => starts.some((x) => x.bucket_id === bid && x.round === n);
  const goodIn = (bid, n) => files.filter((f) => f.bucket_id === bid && f.round === n && good(f)).sort((x, y) => y.id - x.id)[0] || null;
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
      state: file ? 'in' : startedAt(b.id, rr) ? 'started' : 'idle' };
  });
  const groups = ph.keys.map((key) => {
    const info = bracketInfo(bm, key);
    const rows = rooms.filter((r) => r.key === key);
    return { key, name: info ? info.name : key, color: info ? info.color : 0, round: st.rounds[key], rows,
      nIn: rows.filter((r) => r.state === 'in').length, nStarted: rows.filter((r) => r.started).length };
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
      ? `<span class="${r.sum.score[0] > r.sum.score[1] ? 'win' : ''}">${esc(r.sum.teams[0])} ${r.sum.score[0]}</span>
         <span class="muted">&ndash;</span>
         <span class="${r.sum.score[1] > r.sum.score[0] ? 'win' : ''}">${r.sum.score[1]} ${esc(r.sum.teams[1])}</span>`
      : r.game ? `${esc(slotLabel(r.game.a))} <span class="muted">v</span> ${esc(slotLabel(r.game.b))}`
      : '<span class="muted">No game this round</span>';
    const acts = r.file
      ? fileLinks(r.file) + (r.file.kind === 'combined' && r.sum ? ` <button class="linkbtn" data-editfile="${r.file.id}">Edit</button>` : '')
      : r.game ? `<button class="linkbtn" data-addfor="${r.b.id}:${r.rr}">Upload</button>` : '';
    const title = r.note || (r.state === 'in' ? 'Game in' : r.state === 'started' ? 'Started, not uploaded' : 'Not started');
    const mark = !r.game ? '' : r.note ? '!' : r.state === 'in' ? '&#10003;' : r.state === 'started' ? '&#9675;' : '&ndash;';
    return `<div class="brow ${r.game ? '' : 'bye'}" data-room="${r.b.id}">
      <span class="bgame"><span class="bteams">${game}</span>
        <span class="broom">${esc(r.b.room_name)}<span class="lacts">${acts}</span></span>
        ${r.note ? `<span class="bnote">${esc(r.note)}</span>` : ''}</span>
      <span class="lmark ${r.note || r.state === 'idle' ? 'warn' : r.state === 'started' ? 'muted' : ''}" title="${esc(title)}">${mark}</span>
    </div>`;
  };
  const head = (g) => `<div class="bhead"><i class="lane-${g.color}"></i><b>${esc(g.name)}</b>
      ${g.round < bk.top ? `<span class="warntext">&middot; still on round ${g.round}</span>` : ''}
      <span class="spacer"></span>
      <span class="${g.nIn < g.rows.length ? 'warntext' : 'muted'}">${g.nIn}/${g.rows.length} in</span></div>`;
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
    ${settings.autoAdvance ? '<div class="muted small">Each bracket opens its next round once every room in it has started this one.</div>' : ''}
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
  const { rows: prows, byFile: pfiles } = protestRows(files, rulings, roomOf, lastDetail.live_protests || []);
  const popen = prows.filter((r) => r.ruling === 'open');
  const openProt = protOpen === null ? !!popen.length : protOpen;

  // ---- the rooms of the current round: schedule + uploads + starts ----
  const started = new Set((lastDetail.starts || [])
    .filter((x) => x.round === t.current_round).map((x) => x.bucket_id));
  const good = (f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error;
  const liveRooms = roundRooms(sched, t.current_round, buckets);
  const liveRows = liveRooms.map((r) => {
    const b = buckets.find((x) => x.id === r.id);
    const mine = files.filter((f) => f.bucket_id === r.id && f.round === t.current_round);
    const g = mine.filter(good).sort((x, y) => y.id - x.id)[0] || null;
    const sum = g ? fileSummary(g) : null;
    const planned = scheduledGame(b, t.current_round);
    const ps = g ? pfiles.get(g.id) : null;
    return { b, bye: r.bye && !g, file: g, sum, planned, openProt: ps && !ps.superseded ? ps.open : 0,
      state: g ? 'in' : started.has(r.id) ? 'started' : 'idle' };
  });
  const playing = liveRooms.filter((r) => !r.bye);
  const nStarted = playing.filter((r) => started.has(r.id)).length;
  const nextHasPacket = rounds.some((r) => r.number === t.current_round + 1);

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
    let mark = '', cls = '', title = '';
    if (errs.length) { mark = '!'; cls = 'warn'; title = errs.length + ' file' + (errs.length === 1 ? '' : 's') + ' could not be read'; }
    else if (goods.length > 1) { mark = String(goods.length); cls = games.size > 1 ? 'warn' : ''; title = goods.length + ' uploads'; }
    else if (goods.length === 1) { mark = '&#10003;'; title = 'Game in'; }
    else if (fs.length) { mark = '&middot;'; cls = 'muted'; title = 'Game file only'; }
    else if (n > now || bye) { mark = ''; cls = 'muted'; title = bye ? 'No game this round' : ''; }
    else if (n === now) {
      mark = startedNow ? '&#9675;' : '&ndash;';
      cls = startedNow ? 'muted' : 'warn';
      title = startedNow ? 'Started, not uploaded' : 'Not started';
    } else { mark = '&ndash;'; cls = 'warn'; title = 'Missing'; }
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
  const fileLinks = (f) => {
    const link = (params, label) =>
      `<a href="${esc(`${API}${a}/file?key=${encodeURIComponent(f.r2_key)}&${params}`)}" download>${label}</a>`;
    const base = f.filename.replace(/\.qbtd\.json$/i, '');
    return f.kind === 'combined' && !f.error
      ? link(`part=qbj&dl=${encodeURIComponent(base + '.qbj')}`, 'qbj') + ' '
        + link(`part=game&dl=${encodeURIComponent(base + '_Game.json')}`, 'game')
      : link(`dl=${encodeURIComponent(f.filename)}`, 'Download');
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
    const rows = fs.map((f) => {
      const s = fileSummary(f);
      const k = s ? [...s.teams].sort().join('|') : 'f' + f.id;
      const superseded = good(f) && latest.get(k) !== f.id;
      const home = s ? scheduledRoomFor(s.teams, n) : null;
      const hint = home && home.id !== b.id
        ? `<div class="warntext">Scheduled in ${esc(home.room_name)}. <button class="linkbtn" data-moveto="${f.id}:${home.id}">Move it there</button></div>` : '';
      return `<div class="pfile ${superseded ? 'old' : ''}">
        <div class="pline">
          <span>${s ? `${esc(s.teams[0])} <b>${s.score[0]}</b> &ndash; <b>${s.score[1]}</b> ${esc(s.teams[1])}` : esc(f.filename)}
            ${superseded ? '<span class="muted" style="font-size:13px"> &middot; superseded</span>' : ''}</span>
          <select data-movefile="${f.id}" aria-label="Room this game came from">
            ${buckets.some((x) => x.id === f.bucket_id) ? '' : `<option selected>#${f.bucket_id}</option>`}
            ${buckets.map((x) => `<option value="${x.id}" ${x.id === f.bucket_id ? 'selected' : ''}>${esc(x.room_name)}</option>`).join('')}
          </select>
        </div>
        ${hint}
        <div class="pmeta muted">${esc(f.filename)} &middot; ${esc(f.kind)} &middot; ${fmtBytes(f.size)}
          ${f.error ? ` &middot; <span class="warntext">${esc(f.error)}</span>` : ''} ${protestMarker(f)}</div>
        <div class="pacts">${fileLinks(f)}
          ${f.kind === 'combined' && !f.error && s
            ? `<button class="linkbtn" data-editfile="${f.id}" title="Reopen this game in the reader to correct it">Edit in reader</button>` : ''}
          <span class="spacer" style="flex:1"></span>
          <button class="linkbtn muted" data-delfile="${f.id}">Delete</button></div>
      </div>`;
    }).join('');
    return `<tr class="cellpanel"><td colspan="${roundCols.length + 1}"><div class="pop">
      <div class="phead"><b>Round ${n} &middot; ${esc(b.room_name)}</b>
        ${fs.filter(good).length > 1 ? `<span class="warntext">${fs.filter(good).length} games</span>` : ''}
        <span class="spacer" style="flex:1"></span>
        <button class="linkbtn" data-addfor="${b.id}:${n}">Add a game here</button>
        <button class="linkbtn muted" data-closecell aria-label="Close">Close</button></div>
      ${rows || '<div class="muted" style="padding-top:8px">Nothing uploaded for this round yet.</div>'}
    </div></td></tr>`;
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
    <div class="livegrid">
      <div class="livemain">
        <section>
          <div class="sechead"><h2>Live now</h2>
            ${bk ? `<span class="muted">${bk.rooms.filter((r) => r.key && r.state === 'in').length}/${bk.rooms.filter((r) => r.key).length} in</span>`
              : intake.expected ? `<span class="muted">${intake.got}/${intake.expected} in</span>` : ''}</div>
          ${bk ? liveBracketsHtml(bk, fileLinks) : liveRows.length ? liveRows.map((r) => `
          <div class="lrow ${r.bye ? 'bye' : ''}">
            <span class="lroom">${esc(r.b.room_name)}</span>
            <span class="lgame">${r.sum
              ? `<span class="${r.sum.score[0] > r.sum.score[1] ? 'win' : ''}">${esc(r.sum.teams[0])} ${r.sum.score[0]}</span>
                 <span class="muted">&ndash;</span>
                 <span class="${r.sum.score[1] > r.sum.score[0] ? 'win' : ''}">${r.sum.score[1]} ${esc(r.sum.teams[1])}</span>`
              : r.bye ? '<span class="muted">No game this round</span>'
              : r.planned ? `${esc(r.planned[0])} <span class="muted">v</span> ${esc(r.planned[1])}`
              : '<span class="muted">No game yet</span>'}
              ${r.openProt ? `<button class="linkbtn warntext" data-goto="protdrawer">protest</button>` : ''}
              ${r.file && r.file.error ? `<span class="warntext">${esc(r.file.error)}</span>` : ''}</span>
            <span class="lacts">${r.file
              ? fileLinks(r.file) + (r.file.kind === 'combined' && r.sum
                ? ` <button class="linkbtn" data-editfile="${r.file.id}">Edit</button>` : '')
              : r.bye ? '' : `<button class="linkbtn" data-addfor="${r.b.id}:${t.current_round}">Upload</button>`}</span>
            <span class="lmark ${r.state === 'idle' ? 'warn' : r.state === 'started' ? 'muted' : ''}"
              title="${r.state === 'in' ? 'Game in' : r.state === 'started' ? 'Started, not uploaded' : 'Not started'}">${
              r.bye ? '' : r.state === 'in' ? '&#10003;' : r.state === 'started' ? '&#9675;' : '&ndash;'}</span>
          </div>`).join('') : '<div class="muted" style="padding:10px 0">No rooms yet. Add them under Setup.</div>'}
        </section>

        <section>
          <div class="sechead"><h2>Uploads</h2>
            <button class="linkbtn" id="addtoggle" aria-expanded="${addOpen ? 'true' : 'false'}">Add a game</button></div>
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
          ${buckets.length ? `<div class="tablewrap"><table class="ugrid">
            ${bk ? phaseSpans(bk, roundCols) : ''}
            <tr><th class="uroom">Room</th>${roundCols.map((n) =>
              `<th class="${(bk ? Object.values(bk.st.rounds).includes(n) : n === t.current_round) ? 'now' : ''}">${n}</th>`).join('')}</tr>
            ${gridGroups(bk, buckets).map(({ head, rows }) => (head
              ? `<tr class="ugroup"><td colspan="${roundCols.length + 1}"><i class="lane-${head.color}"></i><b>${esc(head.name)}</b>
                  <span class="muted">this round</span></td></tr>` : '')
              + rows.map((b) => `<tr><td class="uroom" title="${esc(b.room_name)}">${esc(b.room_name)}</td>${roundCols.map((n) => gridCell(b, n)).join('')}</tr>${
              cellOpen && cellOpen.bid === b.id ? cellPanel() : ''}`).join('')).join('')}
          </table></div>
          <div class="muted legend">&#10003; in &middot; &#9675; started &middot; &ndash; missing &middot; 2 two uploads &middot; ! can&rsquo;t read</div>`
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
          ${bk ? `<button id="advall" class="primary advance">Advance all to round ${bk.advTo}</button>
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
          <div class="statbtns">
            <button id="calc">Compute</button>
            <div class="dlwrap">
              <button id="dlmenu" aria-haspopup="true" aria-expanded="false" disabled>Download &#9662;</button>
              <div id="dlpanel" class="dlpanel" role="menu" hidden>
                <button id="dlyft4" role="menuitem" disabled>YellowFruit 4 (.yft)<span class="muted">4.0.18+</span></button>
                <button id="dlyft3" role="menuitem" disabled>YellowFruit 3 (.yft)<span class="muted">3.0.2</span></button>
                <button id="dlreport" role="menuitem" class="sep" disabled>HTML report<span class="muted">.zip</span></button>
                <button id="dlzip" role="menuitem" disabled>QBJ bundle<span class="muted">split per game</span></button>
                <button id="rebuild" role="menuitem" class="sep" disabled>Rebuild public stats</button>
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
      if (!fs.length) { addOpen = { bid, round: n }; cellOpen = null; render(); $('addfile').focus(); return; }
      cellOpen = cellOpen && cellOpen.bid === bid && cellOpen.round === n ? null : { bid, round: n };
      render();
    };
  });
  box.querySelectorAll('[data-closecell]').forEach((b) => { b.onclick = () => { cellOpen = null; render(); }; });
  box.querySelectorAll('[data-addfor]').forEach((b) => {
    b.onclick = () => {
      const [bid, n] = b.dataset.addfor.split(':').map(Number);
      addOpen = { bid, round: n };
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
  $('addtoggle').onclick = () => { addOpen = addOpen ? null : { bid: null, round: t.current_round }; render(); };
  $('addcancel').onclick = () => { addOpen = null; render(); };
  $('addfile').onchange = () => { $('addlist').innerHTML = addListHtml([...$('addfile').files]); };
  // Download menu: closed by picking an item, Escape, or a click elsewhere
  $('dlmenu').onclick = (ev) => {
    ev.stopPropagation();
    const open = $('dlpanel').hidden;
    $('dlpanel').hidden = !open;
    $('dlmenu').setAttribute('aria-expanded', String(open));
  };

  /* protests: rulings are the TD's record only — a whole-map write, like
     settings. Nothing goes to the room; the moderator applies an
     upheld ruling in MODAQ and uploads the game again. */
  $('protdrawer').ontoggle = () => { protOpen = $('protdrawer').open; };
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
    try {
      await pub(a, { method: 'POST', json: { rulings: next } });
      t.rulings = JSON.stringify(next);
      say(r === 'open' && !note ? 'Reopened' : `Saved: ${rulingLabel(r)}`);
      render();
    } catch (e) { say(e.message, true); }
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
  $('setround').onclick = () => goToRound(Number($('curround').value));
  $('autoadv').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('autoadv').checked) next.autoAdvance = true;
      else delete next.autoAdvance;
      const out = await pub(a, { method: 'POST', json: { settings: next } });
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
  box.querySelectorAll('[data-editfile]').forEach((b) => {
    b.onclick = () => editGame(a, buckets, files, Number(b.dataset.editfile));
  });
  $('addgame').onclick = () => addGame(a, buckets);
  $('calc').onclick = () => computeStats(a, t, buckets, files, settings);
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
   stat report, the exports and the public page — exactly as a room
   re-uploading its own fixed game already does. The original file stays
   in the uploads list, which is what makes the fix reversible: delete the
   correction and the first upload is live again.

   It goes back through the room that played it, never some other room.
   files.pv stamps the set packet version from the uploading room's
   room_packets row, and doneRounds counts distinct rooms per round
   against the room count — a correction from a stand-in room would
   mis-stamp a set mirror's buzzpoints and skew which rounds read as
   finished. */

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
    // The MODAQ half of the stored upload, decrypted by the Worker under
    // the admin link's key — the same download the "game" link offers.
    const res = await fetch(`${API}${a}/file?key=${encodeURIComponent(f.r2_key)}&part=game`);
    if (!res.ok) throw new Error('could not load the game file (' + res.status + ')');
    const storeText = await res.text();
    if (!storeIntact(storeText)) throw new Error('this upload has no MODAQ game in it');

    // A fresh game id under the room's own secret, so the reader resumes
    // it without touching the room's other games.
    const gid = 'fix' + Date.now().toString(36);
    const [aName, bName] = sum.teams;
    localStorage.setItem(gameKey(room.secret, gid), storeText);
    localStorage.setItem(metaKey(room.secret, gid), JSON.stringify({
      a: aName, b: bName, round: f.round, t: '', room: room.room_name, started: Date.now(),
    }));
    say('');
    // A new tab: the dashboard keeps its place, and the TD can flip back.
    window.open(readLink(room.secret) + '&g=' + encodeURIComponent(gid), '_blank');
  } catch (e) { say(e.message, true); }
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

// Blob routes return parsed JSON when stored as JSON (qbj, roster,
// combined), a raw Response otherwise.
async function fetchOwnedJson(a, key) {
  const res = await pub(`${a}/file?key=${encodeURIComponent(key)}`);
  return res instanceof Response ? JSON.parse(await res.text()) : res;
}

// Every clean game file parsed, plus the roster: shared by Compute stats
// and the schedule's fill-from-standings.
// onFile(done, total) after each game file, for the caller's progress.
async function collectMatches(a, t, buckets, files, onFile = () => {}) {
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
  let fetched = 0;
  for (const f of qbjFiles) {
    onFile(fetched++, qbjFiles.length);
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
      // the name this game's .qbj carries in the QBJ bundle, which the
      // .yft records the way YellowFruit notes an imported file
      m.filename = f.filename.replace(/\.qbtd\.json$/i, '.qbj');
      matches.push(m);
      raw.push({
        id: f.id, round: m.round, room: m.room,
        filename: m.filename,
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

async function computeStats(a, t, buckets, files, settings) {
  const out = $('statsout');
  out.innerHTML = '';
  $('statsec').hidden = false;
  // counts the games it fetches, one request each
  const nGames = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error).length;
  const run = busy($('calc'), { label: 'Computing stats', total: nGames, scope: $('calc').closest('.row') });
  let got;
  try {
    got = await collectMatches(a, t, buckets, files, (done) => run.step(done));
  } finally { run.end(); }
  const { roster, matches, raw, games, errors } = got;

  if (!matches.length) {
    out.innerHTML = `<div class="bad">No readable game files</div>
      ${errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}`;
    return;
  }

  const agg = aggregate(matches, roster);
  renderStats(out, agg, errors);

  // The tournament's own rules reach every export: the .yft's scoring
  // rules, the overtime split, and the stat report's rate-stat scaling all
  // come from the regulation tossup count and answer values the TO set
  // under Tournament Setup -> MODAQ Settings. Without them the exports
  // silently assumed 20 tossups, which turned the last two tossups of
  // every game at a longer event into overtime nobody played.
  const exportOpts = {
    name: t.name, matches: dedupeMatches(matches), roster,
    settings: effectiveFormat(settings),
  };
  // The two YellowFruits share an extension and nothing else, and neither
  // says so when handed the other's file: YellowFruit 4 refuses a file
  // stamped newer than itself, and YellowFruit 3 throws before it can show
  // an error. So the menu names the version, and what it needs, on each
  // item. The files are still named apart, so both can sit in one folder.
  $('dlmenu').disabled = false;
  for (const id of ['dlyft4', 'dlyft3', 'dlreport', 'dlzip', 'rebuild']) $(id).disabled = false;
  const closeMenu = () => { $('dlpanel').hidden = true; $('dlmenu').setAttribute('aria-expanded', 'false'); };
  $('statsnote').textContent = `${matches.length} games in these stats`;
  const yft = (name, text) => {
    try { download(name, text, 'application/json'); closeMenu(); }
    catch (e) { say(e.message, true); }
  };
  $('dlyft4').onclick = () => yft(t.slug + '-yf4.yft', serializeYft(exportOpts));
  $('dlyft3').onclick = () => yft(t.slug + '-yf3.yft', serializeYft3(exportOpts));
  // YellowFruit-style six-page HTML report, zipped so the interlinked
  // files land as one folder ready to host. Named <slug>_standings.html
  // etc., as YellowFruit saves them: the hsquizbowl.org tournament
  // database refuses report files without that prefix.
  $('dlreport').disabled = false;
  $('dlreport').onclick = () => {
    try {
      const pages = buildReport({ ...exportOpts, prefix: t.slug });
      download(t.slug + '-report.zip',
        makeZip(pages.map((f) => ({ name: f.name, data: f.text }))), 'application/zip');
      closeMenu();
    } catch (e) { say(e.message, true); }
  };
  $('dlzip').disabled = false;
  $('dlzip').onclick = async () => {
    const run = busy($('dlzip'), { label: 'Building zip', scope: $('dlzip').closest('.row') });
    try { await buildZip(); closeMenu(); } finally { run.end(); }
  };
  const buildZip = async () => {
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
    const batches = Math.ceil(raw.length / REBUILD_BATCH);
    const run = busy($('rebuild'), { label: 'Rebuilding', total: batches, scope: $('rebuild').closest('.row') });
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
        run.step(i / REBUILD_BATCH + 1);
      }
      say('Stats data rebuilt (' + posted + ' games); the public page picks it up within a minute');
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
