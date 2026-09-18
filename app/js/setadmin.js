// setadmin.js — the set editor's dashboard (set.html). Same no-login idiom
// as the TO dashboard: the set link (set.html?a=<secret>, minted at
// creation, good for a year) is the only credential, and sets this device
// created or opened are remembered in localStorage.
//
// Four tabs. Packets is the set itself — uploaded once, and every upload
// of a packet is a new version, so a fix reaches the mirrors that have
// not opened it while the ones that have stay pinned to what they heard.
// Each upload is also matched, here in the browser, against every
// question the set has held (qmatch.js), so buzzpoints follow a question
// through rewording and repacketizing — and the editor is told what the
// upload changed. Mirrors is one row per site: an invite link to send
// its TD until they use it (starting a tournament on the usual 48h
// clock, or joining one they already made), then the tournament's
// progress and its game files. Stats is setview.js — the same
// view the public set page shows, read through the set link, so it works
// whether or not the set is public and needs no buzzpoints password.
// Settings holds the public page switch, its buzzpoints password, the
// reader game format every mirror starts with, and link rotation.

import { API, pub, esc, download } from './api.js';
import { buzzCredentials } from './buzzkey.js';
import { renderPacketsUi, stagedBlob } from './packetsui.js';
import { formatHtml, wireFormat } from './formatui.js';
import { mountSetView } from './setview.js';
import { readPacket } from './buzzview.js';
import { sanitizeHtml } from '../engine/buzz.js';
import { makeZip } from '../engine/zip.js';
import { packetQuestions, matchPacket, matchSummary, assignQuestion, ledgerChoices } from '../engine/qmatch.js';
import { checkPacket } from '../engine/packetcheck.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const msg = $('msg');
const setSecret = new URLSearchParams(location.search).get('a') || '';

function say(text, bad = false) {
  msg.textContent = text || '';
  msg.className = bad ? 'bad' : '';
}

function pageDir() {
  return location.href.split(/[?#]/)[0].replace(/set\.html$/, '').replace(/\/$/, '');
}
const setAdminLink = (secret) => pageDir() + '/set.html?a=' + secret;
const inviteLink = (secret) => pageDir() + '/index.html?i=' + secret;
const setPageLink = (slug) => pageDir() + '/s.html?s=' + slug;
const mirrorPageLink = (slug) => pageDir() + '/t.html?t=' + slug;

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  say('Copied ' + label);
}

/* ---------- this device's set list (localStorage) ---------- */

const LINKS_KEY = 'qbtdSetLinks';

function savedLinks() {
  try {
    const list = JSON.parse(localStorage.getItem(LINKS_KEY));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
function saveLink(entry) {
  const list = savedLinks().filter((e) => e.slug !== entry.slug);
  list.unshift(entry);
  localStorage.setItem(LINKS_KEY, JSON.stringify(list.slice(0, 30)));
}

function showLinkModal(link, closes, onDone) {
  $('modallink').textContent = link;
  $('modalcloses').textContent = new Date(closes).toLocaleDateString();
  $('linkmodal').hidden = false;
  $('modalcopy').onclick = () => copy(link, 'set link');
  $('modalok').onclick = () => {
    $('linkmodal').hidden = true;
    onDone();
  };
}

function showList() {
  const links = savedLinks();
  view.innerHTML = `
    <h2>Sets on this device</h2>
    ${links.map((e) => {
      const open = Date.now() < e.closes;
      return `
      <div class="card row">
        ${open ? `<a href="${esc(setAdminLink(e.secret))}"><b>${esc(e.name)}</b></a>`
               : `<b class="muted">${esc(e.name)}</b>`}
        <span class="mono muted">${esc(e.slug)}</span>
        <span class="spacer" style="flex:1"></span>
        ${open ? `<span class="muted">Open until ${new Date(e.closes).toLocaleDateString()}</span>`
               : `<span class="pill">Closed</span> <a href="${esc(setPageLink(e.slug))}">Page</a>`}
      </div>`;
    }).join('') || '<div class="muted">None yet</div>'}
    <h2>New set</h2>
    <div class="row">
      <input id="newname" placeholder="Name" size="24">
      <input id="newslug" placeholder="Slug (public URL)" size="18">
      <button id="newbtn" class="primary">Create</button>
    </div>
    <div class="muted" style="font-size:13px;margin-top:8px">
      A set holds a tournament&rsquo;s packets once, for every site that mirrors it.
      You send each mirror&rsquo;s director an invite link; starting it gives them a
      normal qb-td tournament with the rounds, tiebreakers and game format already
      in place, and the games they collect come back here as set-wide stats,
      category stats and buzzpoints.</div>
    <h2>Tournaments</h2>
    <div><a href="index.html">TO dashboard</a></div>`;
  $('newbtn').onclick = async () => {
    try {
      const out = await pub('/api/sets', { method: 'POST', json: {
        name: $('newname').value, slug: $('newslug').value,
      } });
      saveLink({ secret: out.admin_secret, slug: out.slug, name: out.name, closes: out.closes });
      showLinkModal(setAdminLink(out.admin_secret), out.closes, () => {
        location.href = setAdminLink(out.admin_secret);
      });
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- set detail: state that survives re-renders ---------- */

let detail = null;     // cached /s/:secret response
let tbPool = null;     // the set's tiebreaker pool blob, or null
let tab = 'packets';   // 'packets' | 'mirrors' | 'stats' | 'settings'
let fmtOpen = false;
let statsView = null;  // the mounted setview, kept across tab switches
const staged = [];     // packets staged from a zip or loose files (packetsui.js)
const S = '/s/' + setSecret;

async function showDetail() {
  try {
    detail = await pub(S);
  } catch (e) {
    say(e.message === 'set closed' ? 'Set closed (set links work for a year)' : e.message, true);
    view.innerHTML = '<div class="row"><a href="set.html">All sets</a></div>';
    return;
  }
  const s = detail.set;
  saveLink({ secret: setSecret, slug: s.slug, name: s.name, closes: s.closes });
  tbPool = null;
  if (detail.tiebreakers) {
    try { tbPool = await pub(S + '/tiebreakers'); } catch (e) { /* listed as empty */ }
  }
  try { setCats = await pub(S + '/cats', { cache: 'no-cache' }); } catch (e) { setCats = null; }
  render();
}

function settingsOf(s) {
  try { return JSON.parse(s.settings) || {}; } catch (e) { return {}; }
}

function render() {
  if (!detail) return;
  const scrollWas = window.scrollY;
  const s = detail.set;
  const started = detail.mirrors.filter((m) => m.tournament).length;
  view.innerHTML = `
    <div class="row">
      <a href="set.html">&larr; All sets</a>
      <span class="spacer" style="flex:1"></span>
      ${s.published
        ? `<a class="mono" href="${esc(setPageLink(s.slug))}" target="_blank">${esc(setPageLink(s.slug))}</a>
           <button class="small" id="copypub">Copy</button>`
        : '<span class="muted">Public page off</span>'}
    </div>
    <div class="row" style="margin-top:6px">
      <b style="font-size:18px">${esc(s.name)}</b>
      <span class="mono muted">${esc(s.slug)}</span>
    </div>
    <div class="tabs bigtabs" style="margin-top:10px">
      ${[['packets', 'Packets'], ['mirrors', `Mirrors <span class="muted">${started}/${detail.mirrors.length}</span>`],
        ['stats', 'Stats'], ['settings', 'Settings']].map(([key, label]) =>
        `<button class="tab ${tab === key ? 'active' : ''}" data-settab="${key}">${label}</button>`).join('')}
    </div>
    <div id="setbody"></div>
    <div id="setstats" ${tab === 'stats' ? '' : 'hidden'}></div>`;
  view.querySelectorAll('[data-settab]').forEach((b) => {
    b.onclick = () => { tab = b.dataset.settab; render(); };
  });
  if ($('copypub')) $('copypub').onclick = () => copy(setPageLink(s.slug), 'public link');
  if (tab === 'packets' && reviewing) renderReview();
  else if (tab === 'packets') renderPackets();
  else if (tab === 'mirrors') renderMirrors();
  else if (tab === 'settings') renderSettings();
  else renderStats();
  window.scrollTo(0, scrollWas);
}

/* ---------- Packets ---------- */

let setCats = null;    // the set's category map: which versions carry a question map
let reviewing = null;  // {packet, v} while the review panel is open

// Bytes of a packet -> the normalized packet. JSON directly, docx through
// YAPP — the same path the buzzpoints tab reads packets by.
const parsePacket = (bytes, label) => readPacket(new Response(bytes), label);

async function fetchPacketBytes(packet, v) {
  const res = await fetch(`${API}${S}/file?packet=${packet}&v=${v}`);
  if (!res.ok) throw new Error('could not read the packet');
  return res.arrayBuffer();
}

const reviewWord = (p) => p.checked ? 'checked' : p.warnings ? p.warnings + ' warning' + (p.warnings === 1 ? '' : 's') : 'unreviewed';

// The ledger, as the Worker hands it over: its etag on the first line,
// its JSON after (worker.js getLedger — the Worker never parses it).
async function fetchLedger() {
  const text = await (await pub(S + '/ledger', { cache: 'no-cache' })).text();
  const nl = text.indexOf('\n');
  const etag = nl > 0 ? text.slice(0, nl) : null;
  let ledger = null;
  try { ledger = nl >= 0 && text.length > nl + 1 ? JSON.parse(text.slice(nl + 1)) : null; } catch (e) { /* start afresh */ }
  return { etag, ledger };
}

// Record one version's question map with the ledger it was matched into
// (same shape back: one line of JSON, then the ledger).
function putQmap(packet, v, q, ledger, etag) {
  return pub(S + '/qmap', { method: 'POST',
    body: JSON.stringify({ packet, v, q, etag }) + '\n' + JSON.stringify(ledger) });
}

// Match one stored version into the set's ledger and record its question
// map. The ledger write is conditional: if another editor matched in
// between, refetch and match again against what they left.
async function matchVersion(packet, v, questions, current) {
  for (let attempt = 0; ; attempt++) {
    const { etag, ledger } = await fetchLedger();
    const m = matchPacket(ledger, packet, questions, current);
    try {
      await putQmap(packet, v, m.q, m.ledger, etag);
      return m;
    } catch (e) {
      if (attempt >= 3 || !/ledger moved|concurrent/.test(e.message)) throw e;
    }
  }
}

// What a version's questions are relative to the one before it, read off
// the two question maps (the ledger is not needed for this).
function versionNote(p) {
  const q = (((setCats || {}).packets || {})[p.packet] || {})[p.version];
  if (!q || !q.q) return null;
  const n = (q.q.t || []).length + (q.q.b || []).length;
  const before = (((setCats || {}).packets || {})[p.packet] || {})[p.version - 1];
  if (!before || !before.q) return n + ' questions';
  const was = new Map();
  for (const kind of ['t', 'b']) (before.q[kind] || []).forEach((e) => { if (e) was.set(kind + e[0], e[1]); });
  let reworded = 0;
  let added = 0;
  for (const kind of ['t', 'b']) {
    for (const e of q.q[kind] || []) {
      if (!e) continue;
      if (!was.has(kind + e[0])) added++;
      else if (was.get(kind + e[0]) !== e[1]) reworded++;
      was.delete(kind + e[0]);
    }
  }
  const parts = [n + ' questions'];
  if (reworded) parts.push(reworded + ' reworded');
  if (added) parts.push(added + ' not in v' + (p.version - 1));
  if (was.size) parts.push(was.size + ' of v' + (p.version - 1) + ' gone');
  return parts.join(', ');
}

function renderPackets() {
  const settings = settingsOf(detail.set);
  const current = detail.packets.filter((p) => !p.retired);
  const live = detail.mirrors.filter((m) => m.tournament && Date.now() < m.tournament.final).length;
  renderPacketsUi($('setbody'), {
    staged,
    slotLabel: 'Packets',
    slots: Math.max(Number(settings.rounds) || 1, ...current.map((p) => p.packet)),
    rounds: current.map((p) => ({
      number: p.packet,
      name: p.name + ' (v' + p.version + ', ' + reviewWord(p) + ')',
      href: `${API}${S}/file?packet=${p.packet}&v=${p.version}`,
      warn: !p.checked,
    })),
    setSlots: (n) => pub(S, { method: 'POST', json: { settings: { ...settings, rounds: n } } }),
    uploadPacket: async (st, packet) => {
      // read the questions first: a packet that cannot be read is still
      // uploaded, but it is said up front that it will stand alone
      let parsed = null;
      try { parsed = await parsePacket(st.data, st.name); } catch (e) { /* reported below */ }
      const out = await pub(`${S}/packet?packet=${packet}&name=${encodeURIComponent(st.name)}`,
        { method: 'POST', body: stagedBlob(st) });
      const sent = out.mirrors
        ? ` Sent to ${out.mirrors} running mirror${out.mirrors === 1 ? '' : 's'} that had not opened it.` : '';
      if (!parsed) {
        say(`Packet ${packet} is now v${out.version}, but its questions could not be read: review it, and until it`
          + ' can be matched its buzzpoints will not be joined to other versions.' + sent, true);
        return;
      }
      // the parse review runs on every upload; a person still signs it off
      const review = checkPacket(parsed);
      const looks = review.count
        ? ` ${review.count} thing${review.count === 1 ? '' : 's'} to check in the parse — open Review.` : '';
      try { await pub(`${S}/packet/status`, { method: 'POST', json: { packet, v: out.version, warnings: review.count } }); }
      catch (e) { /* display state only */ }
      try {
        const m = await matchVersion(packet, out.version, packetQuestions(parsed), true);
        say(`Packet ${packet} v${out.version}: ${matchSummary(m, packet)}.${looks}` + sent, review.count > 0);
      } catch (e) {
        say(`Packet ${packet} is now v${out.version}, but matching its questions failed (${e.message}) — `
          + 'use Match under Versions.' + looks + sent, true);
      }
    },
    uploadTb: async (name, data) => {
      try {
        const out = await pub(`${S}/tiebreakers?name=${encodeURIComponent(name)}`,
          { method: 'POST', body: new Blob([data], { type: 'application/json' }) });
        say(`${name} split into ${out.added.tossups} tossups + ${out.added.bonuses} bonuses`);
        return true;
      } catch (e) { say(e.message, true); return false; }
    },
    clearTb: () => pub(S + '/tiebreakers', { method: 'DELETE' }),
    pool: tbPool,
    showUses: false,
    packetsNote: `Packets are the set's own numbering: a mirror starts with packet N on round N, and its
      director can put any packet on any round. Drop a packet on an occupied slot to replace it — the upload
      becomes that packet&rsquo;s next version. ${live ? `<b>${live} mirror${live === 1 ? ' is' : 's are'} running now</b> — a`
        : 'A'} running mirror whose rooms have not opened the packet yet switches to the new version;
      one that has stays on the version it is reading. Every upload is matched against the rest of the set, so a
      question keeps its buzzpoints when it is reworded or moved to another packet — upload every packet a
      repacketizing touched. A packet stays red until a person has reviewed how it parsed and marked it checked
      (Versions below). Staged packets are dragged onto their slots; Assign by filename never overwrites
      a slot that already has a packet.`,
    afterPackets: detail.packets.length ? `
      <details style="margin-top:10px"><summary class="muted">Versions</summary>
        <div class="tablewrap"><table>
          <tr><th>Packet</th><th>Version</th><th class="name">File</th><th>Uploaded</th><th></th>
            <th class="name">Questions</th><th>Parse</th><th></th></tr>
          ${detail.packets.map((p) => {
            const note = versionNote(p);
            return `<tr class="${p.retired ? 'muted' : ''}">
            <td class="roundcell">${p.packet}</td><td>v${p.version}</td>
            <td class="name"><a href="${esc(`${API}${S}/file?packet=${p.packet}&v=${p.version}`)}" download>${esc(p.name)}</a></td>
            <td>${new Date(p.created).toLocaleString()}</td>
            <td>${p.retired ? 'Retired' : '<span class="ok">Current</span>'}</td>
            <td class="name">${note ? esc(note)
              : `<span class="bad">Not matched</span> <button class="small" data-match="${p.packet}:${p.version}">Match</button>`}</td>
            <td>${p.checked ? `<span class="ok">Checked</span> <span class="muted">${new Date(p.checked).toLocaleDateString()}</span>`
              : p.warnings ? `<span class="bad">${p.warnings} warning${p.warnings === 1 ? '' : 's'}</span>`
              : p.warnings === 0 ? '<span class="muted">No warnings</span>' : '<span class="muted">Unreviewed</span>'}</td>
            <td><button class="small" data-review="${p.packet}:${p.version}">Review</button></td></tr>`;
          }).join('')}
        </table></div>
      </details>` : '',
    tbTitle: 'Backup questions + tiebreakers',
    tbNote: `Replacement and tiebreaker questions for every mirror, split into individual questions. Each
      mirror&rsquo;s rooms see this pool live in MODAQ under <b>Actions &rarr; Add questions&hellip;</b> — what you add here
      mid-season reaches mirrors already running — alongside any questions the mirror&rsquo;s own director adds.`,
    say, rerender: render, refresh: showDetail,
  });
  const box = $('setbody');
  box.querySelectorAll('[data-match]').forEach((b) => {
    b.onclick = async () => {
      const [packet, v] = b.dataset.match.split(':').map(Number);
      try {
        say('Matching…');
        const parsed = await parsePacket(await fetchPacketBytes(packet, v), 'packet ' + packet);
        const isCurrent = current.some((c) => c.packet === packet && c.version === v);
        const m = await matchVersion(packet, v, packetQuestions(parsed), isCurrent);
        say(`Packet ${packet} v${v}: ${matchSummary(m, packet)}.`);
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  box.querySelectorAll('[data-review]').forEach((b) => {
    b.onclick = () => {
      const [packet, v] = b.dataset.review.split(':').map(Number);
      reviewing = { packet, v };
      render();
    };
  });
  // taking a packet out of the set altogether (one on the wrong slot, or
  // emptied by a repacketizing)
  if (current.length) {
    box.querySelector('.chiprow').insertAdjacentHTML('afterend', `
      <div class="row" style="margin-top:8px">
        <label class="muted">Remove packet
          <select id="rmround">${current.map((p) => `<option>${p.packet}</option>`).join('')}</select>
        </label>
        <button id="rmbtn" class="small">Remove from set</button>
      </div>`);
    $('rmbtn').onclick = async () => {
      const packet = Number($('rmround').value);
      if (!confirm(`Remove packet ${packet} from the set? Running mirrors that have not opened it lose it; `
        + 'mirrors that have keep the version they are on, and its questions keep their buzzpoints.')) return;
      try {
        await pub(`${S}/packet?packet=${packet}`, { method: 'DELETE' });
        say('Packet ' + packet + ' removed');
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  }
}

/* ---------- Review: how a version parsed, and what each question is ----------
   Two things a person checks on every packet before it goes out to
   mirrors, side by side per question: that the parser read it the way a
   reader will (packetcheck.js — answerline, length, how it opens and
   ends, bonus parts with their answers and values, and a warning for
   anything that looks off), and what the matcher decided it is
   (unchanged / reworded / moved in from … / new), with a picker to
   overrule it. Marking the packet checked is the sign-off. */

// What the version's map says about one position, from the maps of the
// packet's previous version and of the other packets (all public, all in
// setCats) plus the ledger's idea of where the question sits now.
function identityNote(packet, v, kind, pos, entry, ledger) {
  if (!entry) return { text: 'not matched', cls: 'bad' };
  const [id, rev] = entry;
  const prev = (((setCats || {}).packets || {})[packet] || {})[v - 1];
  const prevList = prev && prev.q ? prev.q[kind] || [] : null;
  if (prevList) {
    const i = prevList.findIndex((e) => e && e[0] === id);
    if (i === pos - 1) return prevList[i][1] === rev ? { text: 'unchanged', cls: 'muted' } : { text: 'reworded (wording ' + rev + ')', cls: '' };
    if (i >= 0) return { text: `was ${kind === 't' ? 'T' : 'B'}${i + 1}${prevList[i][1] === rev ? '' : ', reworded'}`, cls: '' };
  }
  // not in the previous version: where else has it been?
  for (const [pk, versions] of Object.entries((setCats || {}).packets || {})) {
    for (const [vv, e] of Object.entries(versions).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      if (Number(pk) === packet && Number(vv) >= v) continue;
      const i = e.q ? (e.q[kind] || []).findIndex((x) => x && x[0] === id) : -1;
      if (i >= 0) return { text: `moved in from packet ${pk} ${kind === 't' ? 'T' : 'B'}${i + 1} (v${vv})${e.q[kind][i][1] === rev ? '' : ', reworded'}`, cls: '' };
    }
  }
  const q = ledger && ledger.questions && ledger.questions[id];
  if (q && q.revs.length > 1) return { text: 'reworded (wording ' + rev + ' of ' + q.revs.length + ')', cls: '' };
  return { text: 'new to the set', cls: '' };
}

async function renderReview() {
  const { packet, v } = reviewing;
  const row = detail.packets.find((p) => p.packet === packet && p.version === v);
  const box = $('setbody');
  const back = '<div class="row"><a href="#" id="reviewback">&larr; Packets</a></div>';
  if (!row) { reviewing = null; render(); return; }
  box.innerHTML = back + '<div class="muted" style="margin-top:8px">Reading the packet…</div>';
  $('reviewback').onclick = (e) => { e.preventDefault(); reviewing = null; render(); };
  let parsed;
  let ledger = null;
  try {
    parsed = await parsePacket(await fetchPacketBytes(packet, v), 'packet ' + packet);
    ledger = (await fetchLedger()).ledger;
  } catch (e) {
    box.innerHTML = back + `<div class="bad" style="margin-top:8px">This packet could not be read as questions: ${esc(e.message)}.
      A packet MODAQ cannot read is one no mirror can play — replace it.</div>`;
    $('reviewback').onclick = (ev) => { ev.preventDefault(); reviewing = null; render(); };
    return;
  }
  const review = checkPacket(parsed);
  const qmap = ((((setCats || {}).packets || {})[packet] || {})[v] || {}).q || null;
  const questions = packetQuestions(parsed);
  const isCurrent = !row.retired;
  const choices = { t: ledgerChoices(ledger, 't'), b: ledgerChoices(ledger, 'b') };
  const K = (kind) => (kind === 't' ? 'T' : 'B');
  const picker = (kind, pos, entry) => `
    <select data-reassign="${kind}:${pos}" title="Overrule the match">
      <option value="">${entry ? 'This is…' : 'Assign…'}</option>
      <option value="new">a question new to the set</option>
      ${choices[kind].filter((c) => !entry || c.id !== entry[0]).map((c) =>
        `<option value="${c.id}">${c.at ? `packet ${c.at[0]} ${K(kind)}${c.at[1]}` : '(no current packet)'} — ${esc(c.label)}</option>`).join('')}
    </select>`;
  const rows = [];
  const n = Math.max(review.tossups.length, review.bonuses.length);
  for (let i = 0; i < n; i++) {
    const t = review.tossups[i];
    const b = review.bonuses[i];
    if (t) {
      const entry = qmap ? qmap.t[i] || null : null;
      const note = identityNote(packet, v, 't', t.n, entry, ledger);
      rows.push(`<div class="qrow">
        <div class="qhead"><span class="roundcell">T${t.n}</span> <b>${esc(t.answer) || '<span class="bad">(no answerline)</span>'}</b>
          <span class="muted">${t.words} words${t.power ? ' · power' : ''}</span>
          <span class="ident ${note.cls}">${esc(note.text)}</span> ${picker('t', t.n, entry)}</div>
        ${t.warnings.map((w) => `<div class="warn">&#9888; ${esc(w)}</div>`).join('')}
        <details><summary class="snippet">${esc(t.head)} &hellip; ${esc(t.tail)}</summary>
          <div class="q">${sanitizeHtml(parsed.tossups[i].question)}</div>
          <div class="q muted">ANSWER: ${sanitizeHtml(parsed.tossups[i].answer)}</div></details>
      </div>`);
    }
    if (b) {
      const entry = qmap ? qmap.b[i] || null : null;
      const note = identityNote(packet, v, 'b', b.n, entry, ledger);
      rows.push(`<div class="qrow">
        <div class="qhead"><span class="roundcell">B${b.n}</span>
          <b>${b.answers.map((a) => esc(a) || '<span class="bad">?</span>').join(' <span class="muted">/</span> ')}</b>
          <span class="muted">${b.parts.length} parts${b.values.length ? ' · ' + b.values.join('/') : ''}</span>
          <span class="ident ${note.cls}">${esc(note.text)}</span> ${picker('b', b.n, entry)}</div>
        ${b.warnings.map((w) => `<div class="warn">&#9888; ${esc(w)}</div>`).join('')}
        <details><summary class="snippet">${esc(b.leadin.split(/\s+/).slice(0, 12).join(' '))} &hellip;
          ${b.parts.map((pt, j) => `<span class="muted">[${j + 1}]</span> ${esc(pt.split(/\s+/).slice(0, 8).join(' '))}&hellip;`).join(' ')}</summary>
          ${b.leadin ? `<div class="q muted">${esc(b.leadin)}</div>` : ''}
          ${b.parts.map((pt, j) => `<div class="q">${esc(pt)} <b>${esc(b.answers[j] || '')}</b></div>`).join('')}</details>
      </div>`);
    }
  }
  box.innerHTML = `${back}
    <div class="row" style="margin-top:8px">
      <b style="font-size:18px">Packet ${packet} v${v}</b> <span class="mono muted">${esc(row.name)}</span>
      <span class="spacer" style="flex:1"></span>
      ${row.checked ? `<span class="ok">Checked ${new Date(row.checked).toLocaleDateString()}</span>
        <button id="uncheck" class="small">Unmark</button>`
        : '<button id="check" class="primary">Mark as checked</button>'}
    </div>
    <div class="muted" style="font-size:13px;margin:6px 0 10px">${review.tossups.length} tossups, ${review.bonuses.length} bonuses.
      ${review.count ? `<b class="bad">${review.count} thing${review.count === 1 ? '' : 's'} look${review.count === 1 ? 's' : ''} off</b> — warnings are hints, not verdicts: read the question.`
        : 'Nothing looks off to the parser — still read the answerlines and the bonus parts.'}
      ${qmap ? 'Each question shows what the matcher decided it is; overrule it where it is wrong and the buzzpoints follow.'
        : `<b class="bad">This version has not been matched</b>: its buzzpoints stand alone until it is (Match, under Versions).`}
      ${isCurrent ? '' : ' This version is retired — its plays still count, under whatever its questions are.'}</div>
    ${review.warnings.map((w) => `<div class="bad">&#9888; ${esc(w)}</div>`).join('')}
    <div class="review">${rows.join('')}</div>`;
  $('reviewback').onclick = (e) => { e.preventDefault(); reviewing = null; render(); };
  const setStatus = async (checked) => {
    try {
      await pub(`${S}/packet/status`, { method: 'POST', json: { packet, v, warnings: review.count, checked } });
      say(checked ? `Packet ${packet} v${v} marked as checked` : 'Unmarked');
      await showDetail();
    } catch (e) { say(e.message, true); }
  };
  if ($('check')) $('check').onclick = () => setStatus(true);
  if ($('uncheck')) $('uncheck').onclick = () => setStatus(false);
  box.querySelectorAll('[data-reassign]').forEach((sel) => {
    sel.onchange = async () => {
      if (!sel.value) return;
      const [kind, pos] = sel.dataset.reassign.split(':');
      const target = sel.value === 'new' ? null : Number(sel.value);
      try {
        say('Reassigning…');
        for (let attempt = 0; ; attempt++) {
          // always against the ledger and map as they are NOW: another
          // editor may have moved either since this page was drawn
          const { etag, ledger: fresh } = await fetchLedger();
          const cats = await pub(S + '/cats', { cache: 'no-cache' }).catch(() => null);
          const q = ((((cats || {}).packets || {})[packet] || {})[v] || {}).q || null;
          const a = assignQuestion(fresh, packet, questions, q, kind, Number(pos), target, isCurrent);
          try {
            await putQmap(packet, v, a.q, a.ledger, etag);
            break;
          } catch (e) {
            if (attempt >= 3 || !/ledger moved|concurrent/.test(e.message)) throw e;
          }
        }
        say(`${K(kind)}${pos} reassigned`);
        await showDetail();
      } catch (e) { say(e.message, true); sel.value = ''; }
    };
  });
}

/* ---------- Mirrors ---------- */

function mirrorStatus(m) {
  if (m.tournament) {
    const t = m.tournament;
    // running until its last room link dies, not just its admin link:
    // that is how long games can still arrive and a packet fix still lands
    const open = Date.now() < t.final;
    return `<span class="pill ${open ? 'on' : ''}">${open ? 'Running' : 'Finished'}</span>
      <span class="muted">round ${t.current_round} &middot; ${t.games} game${t.games === 1 ? '' : 's'}</span>`;
  }
  if (m.revoked) return '<span class="pill">Revoked</span>';
  return '<span class="pill">Invite not started</span>';
}

// Every game file of one mirror as a zip: the match .qbj and, for games
// read in qb-td's reader, the MODAQ game file beside it — the same two
// files per game the mirror's own director can download.
async function downloadMirrorFiles(m) {
  const tid = m.tournament.id;
  const { files } = await pub(`${S}/files?m=${tid}`);
  const seen = new Set();
  const entries = [];
  const add = (round, filename, data) => {
    const name = `round-${round}/${filename}`;
    if (seen.has(name)) return; // newest first: a re-exported game keeps its latest upload
    seen.add(name);
    entries.push({ name, data });
  };
  let failed = 0;
  for (const f of [...files].reverse()) {
    if (f.error || f.kind === 'other') continue;
    try {
      const full = await pub(`${S}/gamefile?m=${tid}&id=${f.id}`);
      const body = full instanceof Response ? JSON.parse(await full.text()) : full;
      if (f.kind === 'combined') {
        if (body.qbj) add(f.round, f.filename.replace(/\.qbtd\.json$/i, '.qbj'), JSON.stringify(body.qbj));
        if (body.game) add(f.round, f.filename.replace(/\.qbtd\.json$/i, '_Game.json'), JSON.stringify(body.game));
      } else add(f.round, f.filename, JSON.stringify(body));
    } catch (e) { failed++; }
  }
  if (!entries.length) { say('No game files yet', true); return; }
  download(m.tournament.slug + '-games.zip', makeZip(entries), 'application/zip');
  say(entries.length + ' files' + (failed ? ` (${failed} could not be read)` : ''));
}

function renderMirrors() {
  const rounds = detail.packets.filter((p) => !p.retired).length;
  $('setbody').innerHTML = `
    <h2>Add a mirror</h2>
    <div class="row">
      <input id="mname" placeholder="Name (e.g. Stanford mirror)" size="26">
      <input id="mhost" placeholder="Host" size="14">
      <input id="mdate" type="date" title="Event date">
      <input id="mslug" placeholder="Suggested slug (optional)" size="20">
      <button id="madd" class="primary">Create invite</button>
    </div>
    <div class="muted" style="font-size:13px;margin-top:6px">
      Send the invite link to the mirror&rsquo;s director whenever you like: nothing exists until they
      press Start, which creates their tournament on qb-td&rsquo;s usual 48-hour clock with
      ${rounds ? `these ${rounds} packets` : 'the set&rsquo;s packets'}, the backup questions and the game format
      in place — or, if they have already made their tournament, they paste the invite into it to join the set.
      An invite is used once, and can be revoked until then. Anyone holding one can start a mirror and read
      the packets, so send it the way you would send the packets themselves. A mirror&rsquo;s game files,
      MODAQ&rsquo;s included, are yours to download once it is running.</div>
    <h2>Mirrors</h2>
    ${detail.mirrors.length ? `<div class="tablewrap"><table>
      <tr><th class="name">Mirror</th><th>Status</th><th class="name">Link</th><th></th></tr>
      ${detail.mirrors.map((m) => `<tr class="${m.hidden || m.revoked ? 'muted' : ''}">
        <td class="name"><b>${esc(m.name)}</b>
          <div class="muted" style="font-size:12px">${[m.host, m.event_date].filter(Boolean).map(esc).join(' &middot; ')}</div></td>
        <td>${mirrorStatus(m)}${m.hidden ? ' <span class="pill">Hidden from stats</span>' : ''}</td>
        <td class="name">${m.tournament
          ? `${esc(m.tournament.name)} <span class="mono muted">${esc(m.tournament.slug)}</span>${
              m.tournament.published ? ` <a href="${esc(mirrorPageLink(m.tournament.slug))}" target="_blank">Page</a>` : ''}`
          : m.invite
            ? `<span class="mono" style="font-size:12px">${esc(inviteLink(m.invite))}</span>`
            : ''}</td>
        <td style="white-space:nowrap">${m.tournament
          ? `${m.files && m.tournament.games ? `<button class="small" data-files="${m.id}">Game files</button> ` : ''}
             <button class="small" data-hide="${m.id}" data-to="${m.hidden ? 0 : 1}">${m.hidden ? 'Show in stats' : 'Hide from stats'}</button>`
          : m.invite
            ? `<button class="small" data-copy="${esc(m.invite)}">Copy invite</button>
               <button class="small" data-revoke="${m.id}">Revoke</button>`
            : ''}</td>
      </tr>`).join('')}
    </table></div>` : '<div class="muted">None yet</div>'}`;

  $('madd').onclick = async () => {
    try {
      const out = await pub(S + '/mirrors', { method: 'POST', json: {
        name: $('mname').value, host: $('mhost').value,
        event_date: $('mdate').value, slug: $('mslug').value,
      } });
      await copy(inviteLink(out.invite), 'invite link for ' + out.name).catch(() => say('Invite created'));
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  const box = $('setbody');
  box.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copy(inviteLink(b.dataset.copy), 'invite link');
  });
  box.querySelectorAll('[data-files]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        say('Collecting game files…');
        await downloadMirrorFiles(detail.mirrors.find((m) => m.id === Number(b.dataset.files)));
      } catch (e) { say(e.message, true); }
      b.disabled = false;
    };
  });
  box.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Revoke this invite? The link stops working; make a new mirror to replace it.')) return;
      try {
        await pub(`${S}/mirrors/${b.dataset.revoke}`, { method: 'POST', json: { revoked: true } });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  box.querySelectorAll('[data-hide]').forEach((b) => {
    b.onclick = async () => {
      try {
        await pub(`${S}/mirrors/${b.dataset.hide}`, { method: 'POST', json: { hidden: b.dataset.to === '1' } });
        say('Set-wide stats update within a minute');
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
}

/* ---------- Stats ---------- */

// The editor's source for setview.js: the /s routes, which serve the same
// bodies as /pubset whether or not the set is public, and the packet
// route itself for buzzpoint text — no password, the link is the key.
const statsSource = {
  gated: false,
  state: () => pub(S + '/state', { cache: 'no-cache' }),
  rounds: (mirrorId, q) => pub(`${S}/rounds?m=${mirrorId}&n=${q}`),
  cats: () => pub(S + '/cats', { cache: 'no-cache' }),
  packet: async (packet, v) => readPacket(await pub(`${S}/file?packet=${packet}&v=${v}`), 'packet ' + packet),
  mirrorLink: (m) => (m.page ? mirrorPageLink(m.slug) : ''),
};

function renderStats() {
  $('setbody').innerHTML = `
    <div class="row" style="margin:10px 0">
      <span class="muted" style="font-size:13px">Every mirror&rsquo;s games, a minute or so behind the rooms.
        Buzzpoints show a packet once a site has every room in for the round it read it in.</span>
      <span class="spacer" style="flex:1"></span>
      <button id="statsrefresh">Refresh</button>
    </div>`;
  // render() rebuilt the container, so the view is mounted afresh into it
  statsView = mountSetView($('setstats'), statsSource);
  $('statsrefresh').onclick = () => statsView.refresh();
}

/* ---------- Settings ---------- */

function renderSettings() {
  const s = detail.set;
  let settings = settingsOf(s);
  const box = $('setbody');
  box.innerHTML = `
    <h2>Public set page</h2>
    <div class="row" style="margin-bottom:6px">
      <label class="row"><input type="checkbox" id="pub" ${s.published ? 'checked' : ''}> Public page</label>
      ${s.published ? `<a class="mono" href="${esc(setPageLink(s.slug))}" target="_blank">${esc(setPageLink(s.slug))}</a>` : ''}
    </div>
    <div class="muted" style="font-size:13px;margin-bottom:10px">
      Combined stats and category stats over every mirror not hidden from stats — including mirrors
      whose own page their director has left off. Question text never appears without the password below.</div>
    <div class="row">
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
    <div class="muted" style="font-size:13px;margin-top:6px">
      The public page&rsquo;s buzzpoints tab shows a packet&rsquo;s questions, with every site&rsquo;s buzzes,
      once any one mirror has finished a round on it. Whoever has the password can read those
      questions while later mirrors are still to play — hand it out when the set is clear.
      Your own Stats tab here needs no password.</div>
    <div class="row" style="margin-top:10px">
      <label class="row"><input type="checkbox" id="mirrorbuzz" ${settings.lockMirrorBuzz ? '' : 'checked'}>
        Mirrors may run their own buzzpoints</label>
    </div>
    <div class="muted" style="font-size:13px;margin-top:6px">
      A mirror&rsquo;s director can normally put its games&rsquo; buzzpoints — question text included — on the
      mirror&rsquo;s own page, behind a password they choose. Unticked, no mirror of this set shows any,
      whatever its director has set; tick it again once the set is clear.</div>

    <h2>Mirrors start with</h2>
    ${formatHtml(settings, fmtOpen)}
    <div class="muted" style="font-size:13px">Copied into a mirror when it starts; its director can still change it.</div>

    <h2>Set link</h2>
    <div class="row">
      <span class="muted">Open until ${new Date(s.closes).toLocaleDateString()}</span>
      <button id="rotate" class="small">New set link</button>
    </div>`;

  const saveSettings = async (next, extra) => {
    await pub(S, { method: 'POST', json: { settings: next, ...extra } });
    settings = next;
  };
  wireFormat(box, {
    settings: () => settings, save: saveSettings, say, refresh: showDetail,
    onToggle: (open) => { fmtOpen = open; },
  });
  $('pub').onchange = async () => {
    try {
      await pub(S, { method: 'POST', json: { published: $('pub').checked } });
      say($('pub').checked ? 'Set page is public' : 'Set page is private');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('mirrorbuzz').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('mirrorbuzz').checked) delete next.lockMirrorBuzz;
      else next.lockMirrorBuzz = true;
      await saveSettings(next);
      say($('mirrorbuzz').checked ? 'Mirrors may run their own buzzpoints' : 'Mirror buzzpoints are off');
    } catch (e) { say(e.message, true); }
  };
  $('buzzmode').onchange = async () => {
    const mode = $('buzzmode').value;
    try {
      const next = { ...settings };
      if (!mode) delete next.buzz;
      else if (settings.buzz && settings.buzz.hash) {
        // spread whole: dropping kdf/iters would demote a stretched password
        next.buzz = { ...settings.buzz, mode: 'password' };
      } else {
        $('buzzpw').hidden = false;
        $('buzzset').hidden = false;
        say('Set a password');
        return;
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
      // stretched here (buzzkey.js); the derived token rides along once so
      // the Worker can wrap the set's content key for the gated route
      say('Setting password…');
      const cred = await buzzCredentials(pw);
      await saveSettings({ ...settings, buzz: cred.settings }, { buzz_token: cred.token });
      say('Buzzpoints password set');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('rotate').onclick = async () => {
    if (!confirm('Make a new set link? The current one stops working for everyone who has it. '
      + 'Invites and running mirrors are not affected.')) return;
    try {
      const out = await pub(S + '/rotate', { method: 'POST' });
      saveLink({ secret: out.admin_secret, slug: s.slug, name: s.name, closes: s.closes });
      showLinkModal(setAdminLink(out.admin_secret), s.closes, () => {
        location.href = setAdminLink(out.admin_secret);
      });
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- boot ---------- */

if (setSecret) showDetail();
else showList();
