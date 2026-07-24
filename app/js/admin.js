// admin.js — the TO dashboard (index.html). No login: the admin link
// (index.html?a=<secret>, minted at creation, expires 48h later) is the
// only credential. Tournaments this device created or opened are
// remembered in localStorage so the list view survives a closed tab —
// but the link itself is the source of truth.

import { API, pub, esc, fmtBytes, download } from './api.js';
import { parseMatch, parseRoster, matchPayload, parseRosterLines, buildRosterQbj,
  guessRound } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { serializeYft } from '../engine/yft.js';
import { makeZip, readZip } from '../engine/zip.js';
import { renderStats } from './statsview.js';
import { GAME_FORMAT_OPTIONS, effectiveFormat, formatOverridesFrom, cleanOverrides,
  parsePowersText, powersText } from './read_core.js';
import { formatsFor, buildSchedule, validateSchedule, slotAt, setSlot, swapSlots,
  moveGame, addRound, removeRound, slotText, roundIntake } from '../engine/schedule.js';
import { annLive, annTime } from './announce.js';

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
  say('copied ' + label);
}
window.qtd = { copy }; // for inline onclick handlers

/* ---------- this device's tournament list (localStorage) ---------- */

const LINKS_KEY = 'qbtdAdminLinks';

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
    <h2>tournaments on this device</h2>
    ${links.map((e) => {
      const open = Date.now() < e.closes;
      return `
      <div class="card row">
        ${open ? `<a href="${esc(adminLink(e.secret))}"><b>${esc(e.name)}</b></a>`
               : `<b class="muted">${esc(e.name)}</b>`}
        <span class="mono muted">${esc(e.slug)}</span>
        <span class="spacer" style="flex:1"></span>
        ${open ? `<span class="muted">open until ${new Date(e.closes).toLocaleString()}</span>`
               : `<span class="pill">closed</span> <a href="${esc(statsLink(e.slug))}">page</a>`}
      </div>`;
    }).join('') || '<div class="muted">none yet</div>'}
    <h2>new tournament</h2>
    <div class="row">
      <input id="newname" placeholder="name" size="24">
      <input id="newslug" placeholder="slug (public url)" size="18">
      <button id="newbtn" class="primary">create</button>
    </div>`;
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

/* ---------- tournament detail ---------- */

// Survives showDetail re-renders (which happen after every action):
// packets staged from a zip, and the roster editor's text + open state.
let staged = [];       // [{name, data: Uint8Array, guess: round|null}]
let rosterText = '';
let rosterOpen = false;
let fmtOpen = false;   // game-format customize panel
let uploadsOpen = null; // Set of expanded upload rounds; null = current round only
let setupOpen = null;   // tournament-setup drawer; null = auto: open until set up
let schedOpen = null;   // schedule drawer; null = open
let annOpen = null;     // broadcasts drawer; null = auto: open when something is live
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
  if (a.pub) parts.push([published ? 'pill on' : 'pill', 'public']);
  if (a.rooms === true) parts.push(['pill on', 'rooms']);
  else if (Array.isArray(a.rooms)) {
    for (const id of a.rooms) {
      const b = buckets.find((x) => x.id === id);
      parts.push(['pill on', b ? b.room_name : '#' + id]);
    }
  }
  return parts.map(([cls, label]) => `<span class="${cls}">${esc(label)}</span>`).join(' ');
}

async function showDetail() {
  const a = '/a/' + adminSecret;
  const scrollWas = window.scrollY; // survive the full re-render
  let detail;
  try {
    detail = await pub(a);
  } catch (e) {
    if (e.message === 'tournament closed') {
      say('tournament closed (admin links stop working 48 hours after creation)', true);
    } else say(e.message, true);
    view.innerHTML = `<div class="row"><a href="index.html">all tournaments</a></div>`;
    return;
  }
  const { tournament: t, buckets, rounds, files } = detail;
  saveLink({ secret: adminSecret, slug: t.slug, name: t.name,
    closes: t.closes, created: t.created });
  let settings = {};
  try { settings = JSON.parse(t.settings) || {}; } catch (e) { /* keep {} */ }
  const fmt = effectiveFormat(settings); // prefills the customize panel
  // expired broadcasts are simply dropped: the next write prunes them for good
  let live = [];
  try { live = annLive(JSON.parse(t.announce || '[]')); } catch (e) { /* keep [] */ }

  // One packet slot per round: the set round count, stretched to cover any
  // packet already uploaded past it and the live round.
  const totalRounds = Math.max(Number(settings.rounds) || 1, t.current_round,
    ...rounds.map((r) => r.number));
  const slots = Array.from({ length: totalRounds }, (_, i) => i + 1);

  // the status strip and upload groups read the schedule
  await ensureSched(a, t);
  const intake = roundIntake(sched, t.current_round, buckets, files);
  const uploadRounds = [...new Set([
    ...Array.from({ length: t.current_round }, (_, i) => i + 1),
    ...files.map((f) => f.round).filter((n) => Number.isInteger(n) && n > 0),
  ])].sort((x, y) => y - x);

  const openSetup = setupOpen === null ? !(t.roster_r2_key && buckets.length) : setupOpen;
  const openSched = schedOpen === null ? true : schedOpen;
  const openAnn = annOpen === null ? !!live.length : annOpen;

  view.innerHTML = `
    <div class="row">
      <a href="index.html">&larr; all tournaments</a>
      <span class="spacer" style="flex:1"></span>
      <a class="mono" href="${esc(statsLink(t.slug))}" target="_blank">${esc(statsLink(t.slug))}</a>
      <button class="small" onclick="qtd.copy('${esc(statsLink(t.slug))}', 'public link')">copy</button>
    </div>
    <div class="row" style="margin-top:6px">
      <b style="font-size:18px">${esc(t.name)}</b>
      <span class="mono muted">${esc(t.slug)}</span>
    </div>
    <div class="statusbar">
      <span><span class="muted">round</span> <span class="big">${t.current_round}</span> <span class="muted">of ${totalRounds}</span></span>
      ${rounds.length ? (rounds.some((r) => r.number === t.current_round)
        ? '<span class="ok">packet up</span>' : '<span class="bad">no packet</span>') : ''}
      ${intake.expected ? `<span><span class="${intake.got >= intake.expected ? 'ok' : 'bad'}">${intake.got}</span><span class="muted">/${intake.expected} games in</span></span>` : ''}
      ${intake.missing.length ? `<span class="muted">waiting: ${esc(intake.missing.join(', '))}</span>` : ''}
      <span class="spacer" style="flex:1"></span>
      <label>round <input id="curround" type="number" min="1" max="999" value="${t.current_round}" style="width:70px"></label>
      <button id="setround">set</button>
      ${t.current_round < totalRounds
        ? `<button id="advround" class="primary">advance to round ${t.current_round + 1}</button>` : ''}
    </div>
    <details class="drawer" id="anndrawer" ${openAnn ? 'open' : ''}>
      <summary><span class="dtitle">broadcasts</span>
        <span class="muted">${live.length
          ? `${live.length} live &middot; ${esc(live[0].text)}`
          : 'nothing live'}</span>
      </summary>
      <div class="inner">
        <div class="row" style="margin-top:8px">
          <input id="anntext" maxlength="200" style="flex:1;min-width:240px"
            placeholder="a line for the rooms or the public page"
            value="${esc(annForm.text)}">
          <span class="muted mono" id="anncount">${annForm.text.length}/200</span>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="muted">to
            <select id="annto">
              <option value="both" ${annForm.to === 'both' ? 'selected' : ''}>public page + rooms</option>
              <option value="pub" ${annForm.to === 'pub' ? 'selected' : ''}>public page only</option>
              <option value="rooms" ${annForm.to === 'rooms' ? 'selected' : ''}>all rooms</option>
              <option value="some" ${annForm.to === 'some' ? 'selected' : ''}>specific rooms&hellip;</option>
            </select>
          </label>
          <label class="muted">expires
            <select id="annmins">${ANN_EXPIRY.map(([v, label]) =>
              `<option value="${v}" ${annForm.mins === v ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label class="row"><input type="checkbox" id="annalert" ${annForm.alert ? 'checked' : ''}> alert</label>
          <span class="spacer" style="flex:1"></span>
          ${live.length >= MAX_ANNOUNCE
            ? `<span class="muted">${MAX_ANNOUNCE} live is the maximum &mdash; remove one first</span>` : ''}
          <button id="annsend" class="primary" ${live.length >= MAX_ANNOUNCE ? 'disabled' : ''}>send</button>
        </div>
        <div class="row" id="annrooms" ${annForm.to === 'some' ? '' : 'hidden'} style="margin-top:6px">
          ${buckets.length ? buckets.map((b) => `
            <label class="row"><input type="checkbox" data-annroom="${b.id}"
              ${annForm.rooms.includes(b.id) ? 'checked' : ''}> ${esc(b.room_name)}</label>`).join('')
            : '<span class="muted">no rooms yet</span>'}
        </div>
        <div class="row" style="margin-top:6px">
          <span class="muted" style="font-size:13px">rooms see this within a minute; the public page within five${
            t.published ? '' : '. the public page is off, so public broadcasts stay hidden until you turn it on'}</span>
        </div>

        <h2>live now</h2>
        ${live.length ? `<div class="tablewrap"><table>
          <tr><th>message</th><th>to</th><th class="num">sent</th><th class="num">expires</th><th></th></tr>
          ${live.map((x) => `<tr>
            <td>${x.level === 'alert' ? '<span class="pill warn">alert</span> ' : ''}${esc(x.text)}</td>
            <td>${annAudience(x, buckets, t.published)}</td>
            <td class="num">${esc(annTime(x.created))}</td>
            <td class="num">${esc(annTime(x.expires))}</td>
            <td class="num"><button class="small" data-delann="${esc(x.id)}">remove</button></td>
          </tr>`).join('')}
        </table></div>` : '<div class="muted">nothing live</div>'}
      </div>
    </details>

    <details class="drawer" id="setupdrawer" ${openSetup ? 'open' : ''}>
      <summary><span class="dtitle">tournament setup</span>
        <span class="muted">${buckets.length} room${buckets.length === 1 ? '' : 's'}
          &middot; packets ${rounds.length}/${totalRounds}
          &middot; ${t.roster_name ? 'roster' : 'no roster'}${t.published ? ' &middot; public' : ''}</span>
      </summary>
      <div class="inner">
      <h2>rooms</h2>
      ${buckets.length ? `<div class="tablewrap"><table>
        <tr><th>room</th><th>links</th><th class="num">files</th><th>closes</th><th></th></tr>
        ${buckets.map((b) => {
          const closes = b.created + 48 * 3600 * 1000;
          const open = Date.now() < closes;
          return `<tr>
            <td><b>${esc(b.room_name)}</b></td>
            <td><a href="${esc(readLink(b.secret))}" target="_blank">reader</a>
              <button class="small" onclick="qtd.copy('${esc(readLink(b.secret))}', '${esc(b.room_name)} reader link')">copy</button>
              &nbsp;<a href="${esc(bucketLink(b.secret))}" target="_blank">bucket</a>
              <button class="small" onclick="qtd.copy('${esc(bucketLink(b.secret))}', '${esc(b.room_name)} link')">copy</button></td>
            <td class="num">${files.filter((f) => f.bucket_id === b.id).length}</td>
            <td>${open
              ? `<span class="muted">${new Date(closes).toLocaleString()}</span>`
              : '<span class="pill">closed</span>'}</td>
            <td><button class="small" data-delbucket="${b.id}">remove</button></td>
          </tr>`;
        }).join('')}
      </table></div>` : '<div class="muted">no rooms yet</div>'}
      <div class="row" style="margin-top:8px">
        <input id="roomname" placeholder="room name" size="18">
        <button id="addroom">add room</button>
      </div>

      <h2>packets</h2>
      ${staged.length ? `
      <div class="row" style="margin-bottom:8px">
        ${staged.map((s, i) => `<span class="chip" draggable="true" data-chip="${i}">${esc(s.name)}${
          s.guess ? ` <span class="muted">&rarr; ${s.guess}</span>` : ''}</span>`).join('')}
        <button id="zipauto">assign by filename</button>
        <button id="zipclear">clear</button>
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
      <div class="row" style="margin-top:8px">
        <label>rounds <input id="numrounds" type="number" min="1" max="999" value="${totalRounds}" style="width:70px"></label>
        <button id="setrounds">set</button>
        <span class="spacer" style="flex:1"></span>
        <label>round <input id="pround" type="number" min="1" max="999" value="${t.current_round}" style="width:70px"></label>
        <input id="pfile" type="file">
        <button id="uppacket">upload packet</button>
      </div>
      <div class="row" style="margin-top:6px">
        <input id="zipfile" type="file" accept=".zip">
        <button id="upzip">load packet zip</button>
      </div>

      <h2>roster</h2>
      <div class="row">
        ${t.roster_name
          ? `<span>${esc(t.roster_name)}</span>
             <a href="${API}${a}/file?key=${encodeURIComponent(t.roster_r2_key)}&dl=${encodeURIComponent(t.roster_name)}" download>download</a>`
          : '<span class="muted">none yet</span>'}
        <span class="spacer" style="flex:1"></span>
        <input id="rfile" type="file" accept=".qbj,.json">
        <button id="uproster">upload roster qbj</button>
        <button id="editroster">${t.roster_name ? 'edit roster' : 'create roster qbj'}</button>
      </div>
      <div id="rosteredit" ${rosterOpen ? '' : 'hidden'} style="margin-top:8px">
        <textarea id="rostertext" rows="10" spellcheck="false"
          placeholder="Team A: Alice, Bob&#10;Team B: Carol, Dan">${esc(rosterText)}</textarea>
        <div class="row" style="margin-top:8px">
          <button id="rosterdl">download roster qbj</button>
          <button id="rostersave" class="primary">save as tournament roster</button>
        </div>
      </div>

      <h2>settings</h2>
      <div class="row" style="margin-bottom:6px">
        <label class="row"><input type="checkbox" id="pub" ${t.published ? 'checked' : ''}> public page</label>
      </div>
      <div class="row" style="margin-bottom:6px">
        <label class="row">reader game format
          <select id="gformat">${GAME_FORMAT_OPTIONS.map((o) =>
            `<option value="${o.value}" ${o.value === (settings.gameFormat || '') ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </label>
        ${Object.keys(cleanOverrides(settings.formatOverrides)).length ? '<span class="pill">custom</span>' : ''}
        <button id="fmtedit">customize</button>
      </div>
      <div id="fmtpanel" ${fmtOpen ? '' : 'hidden'} class="card" style="margin-bottom:6px">
        <div class="row">
          <label>tossups <input id="fmttossups" type="number" min="1" max="999" value="${fmt.regulationTossupCount}" style="width:64px"></label>
          <label>neg <input id="fmtneg" type="number" min="-100" max="0" value="${fmt.negValue}" style="width:64px"></label>
          <label>powers <input id="fmtpowers" placeholder="(*)=15" value="${esc(powersText(fmt.powers))}" size="16"></label>
          <label>overtime tossups <input id="fmtot" type="number" min="1" max="99" value="${fmt.minimumOvertimeQuestionCount}" style="width:56px"></label>
        </div>
        <div class="row" style="margin-top:6px">
          <label class="row"><input type="checkbox" id="fmtpaired" ${fmt.pairTossupsBonuses ? 'checked' : ''}> paired bonuses</label>
          <label class="row"><input type="checkbox" id="fmtbounce" ${fmt.bonusesBounceBack ? 'checked' : ''}> bouncebacks</label>
          <label class="row"><input type="checkbox" id="fmtotbonus" ${fmt.overtimeIncludesBonuses ? 'checked' : ''}> overtime bonuses</label>
          <label>pronunciation marks
            <input id="fmtpron1" value="${esc((fmt.pronunciationGuideMarkers || ['', ''])[0])}" size="4">
            <input id="fmtpron2" value="${esc((fmt.pronunciationGuideMarkers || ['', ''])[1])}" size="4">
          </label>
          <span class="spacer" style="flex:1"></span>
          <button id="fmtreset">reset to preset</button>
          <button id="fmtsave" class="primary">save format</button>
        </div>
      </div>
      <div class="row">
        <span class="muted">admin link open until ${new Date(t.closes).toLocaleString()}</span>
        <button id="rotate" class="small">new admin link</button>
      </div>
      </div>
    </details>

    <details class="drawer" id="scheddrawer" ${openSched ? 'open' : ''}>
      <summary><span class="dtitle">schedule</span><span class="muted" id="schedsum"></span></summary>
      <div class="inner"><div id="schedsec"></div></div>
    </details>

    <h2>uploads</h2>
    ${uploadRounds.map((rn) => {
      const group = files.filter((f) => f.round === rn);
      const ri = rn === t.current_round ? intake : roundIntake(sched, rn, buckets, files);
      const open = uploadsOpen ? uploadsOpen.has(rn) : rn === t.current_round;
      return `
      <details class="rgroup" data-uprnd="${rn}" ${open ? 'open' : ''}>
        <summary><b>round ${rn}</b>
          ${ri.expected ? `<span class="pill ${ri.got >= ri.expected ? 'on' : 'warn'}">${ri.got}/${ri.expected}</span>` : ''}
          ${ri.missing.length ? `<span class="muted">missing ${esc(ri.missing.join(', '))}</span>` : ''}
        </summary>
        ${group.length ? `<div class="tablewrap"><table>
          <tr><th>room</th><th>file</th><th>kind</th><th class="num">size</th><th>status</th><th></th></tr>
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
              : link(`dl=${encodeURIComponent(f.filename)}`, 'download');
            return `<tr>
              <td>${esc(room ? room.room_name : '#' + f.bucket_id)}</td>
              <td>${esc(f.filename)}</td>
              <td>${f.kind}</td>
              <td class="num">${fmtBytes(f.size)}</td>
              <td>${f.error ? `<span class="bad">${esc(f.error)}</span>` : '<span class="ok">ok</span>'}</td>
              <td class="row">
                ${links}
                <button data-delfile="${f.id}">delete</button>
              </td>
            </tr>`;
          }).join('')}
        </table></div>` : '<div class="muted" style="padding:6px 10px">no files</div>'}
      </details>`;
    }).join('')}

    <h2>stats + export</h2>
    <div class="row">
      <button id="calc" class="primary">compute stats</button>
      <button id="dlyft" disabled>download .yft</button>
      <button id="dlzip" disabled>download qbj bundle</button>
      <button id="rebuild" disabled>rebuild stats data</button>
      <span class="spacer" style="flex:1"></span>
      <label class="row">buzzpoints
        <select id="buzzmode">
          <option value="">off</option>
          <option value="password" ${(settings.buzz || {}).mode === 'password' ? 'selected' : ''}>on (password)</option>
        </select>
      </label>
      ${(settings.buzz || {}).hash ? '<span class="pill on">password set</span>' : ''}
      <input id="buzzpw" type="password" placeholder="password" size="16"
        ${(settings.buzz || {}).mode === 'password' ? '' : 'hidden'}>
      <button id="buzzset" ${(settings.buzz || {}).mode === 'password' ? '' : 'hidden'}>set password</button>
    </div>
    <div id="statsout" style="margin-top:12px"></div>`;

  window.scrollTo(0, scrollWas);
  view.querySelectorAll('details.rgroup').forEach((d) => {
    d.ontoggle = () => {
      uploadsOpen = new Set([...view.querySelectorAll('details.rgroup[open]')]
        .map((x) => Number(x.dataset.uprnd)));
    };
  });
  $('setupdrawer').ontoggle = () => { setupOpen = $('setupdrawer').open; };
  $('scheddrawer').ontoggle = () => { schedOpen = $('scheddrawer').open; };
  $('anndrawer').ontoggle = () => { annOpen = $('anndrawer').open; };

  /* broadcasts: every write sends the whole live list, so removals and
     expiries prune themselves */
  const checkedRooms = () => [...view.querySelectorAll('[data-annroom]:checked')]
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
  view.querySelectorAll('[data-annroom]').forEach((c) => {
    c.onchange = () => { annForm.rooms = checkedRooms(); };
  });
  $('annsend').onclick = async () => {
    const text = $('anntext').value.trim();
    if (!text) { say('type a message first', true); return; }
    const to = $('annto').value;
    const rooms = to === 'both' || to === 'rooms' ? true
      : to === 'some' ? checkedRooms() : false;
    if (Array.isArray(rooms) && !rooms.length) { say('pick at least one room', true); return; }
    const now = Date.now();
    const mins = $('annmins').value;
    try {
      await saveAnnounce([...live, {
        id: annId(),
        text,
        level: $('annalert').checked ? 'alert' : 'note',
        pub: to === 'both' || to === 'pub',
        rooms,
        created: now,
        // 'end' is the tournament's own close, which the Worker clamps to anyway
        expires: mins === 'end' ? t.closes : now + Number(mins) * 60000,
      }]);
      annForm = { text: '', to, rooms: Array.isArray(rooms) ? rooms : [], mins, alert: false };
      annOpen = true;
      say('broadcast sent');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  view.querySelectorAll('[data-delann]').forEach((b) => {
    b.onclick = async () => {
      try {
        await saveAnnounce(live.filter((x) => x.id !== b.dataset.delann));
        say('broadcast removed');
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
      say('round ' + n);
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('setround').onclick = () => goToRound(Number($('curround').value));
  if ($('advround')) $('advround').onclick = () => goToRound(t.current_round + 1);
  const saveSettings = async (next) => {
    await pub(a, { method: 'POST', json: { settings: next } });
    settings = next;
  };
  $('gformat').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('gformat').value) next.gameFormat = $('gformat').value;
      else delete next.gameFormat;
      await saveSettings(next);
      say('game format saved');
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
      if (!!p1 !== !!p2) { say('pronunciation marks: fill both or neither', true); return; }
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
      if (bad.length) { say('bad value: ' + bad.join(', '), true); return; }
      const next = { ...settings };
      if (Object.keys(ov).length) next.formatOverrides = ov;
      else delete next.formatOverrides;
      await saveSettings(next);
      say('game format saved');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('fmtreset').onclick = async () => {
    try {
      const next = { ...settings };
      delete next.formatOverrides;
      await saveSettings(next);
      say('game format reset');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('buzzmode').onchange = async () => {
    const mode = $('buzzmode').value;
    try {
      const next = { ...settings };
      if (!mode) delete next.buzz;
      else {
        // keep an existing password; otherwise wait for one to be set
        if (settings.buzz && settings.buzz.hash) {
          next.buzz = { mode: 'password', salt: settings.buzz.salt, hash: settings.buzz.hash };
        } else {
          $('buzzpw').hidden = false;
          $('buzzset').hidden = false;
          say('set a password');
          return;
        }
      }
      await saveSettings(next);
      say(mode ? 'buzzpoints on' : 'buzzpoints off');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('buzzset').onclick = async () => {
    const pw = $('buzzpw').value;
    if (!pw) { say('enter a password', true); return; }
    try {
      const salt = [...crypto.getRandomValues(new Uint8Array(12))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(salt + ':' + pw));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      await saveSettings({ ...settings, buzz: { mode: 'password', salt, hash } });
      say('buzzpoints password set');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('pub').onchange = async () => {
    try {
      await pub(a, { method: 'POST', json: { published: $('pub').checked } });
      say($('pub').checked ? 'page is public' : 'page is private');
    } catch (e) { say(e.message, true); }
  };
  $('addroom').onclick = async () => {
    try {
      await pub(a + '/buckets', { method: 'POST', json: { room_name: $('roomname').value } });
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  view.querySelectorAll('[data-delbucket]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this room? Its link stops working. Uploaded files stay.')) return;
      try {
        await pub(a + '/buckets/' + b.dataset.delbucket, { method: 'DELETE' });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  view.querySelectorAll('[data-delfile]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this file?')) return;
      try {
        await pub(a + '/files/' + b.dataset.delfile, { method: 'DELETE' });
        showDetail();
      } catch (e) { say(e.message, true); }
    };
  });
  $('uppacket').onclick = async () => {
    const f = $('pfile').files[0];
    if (!f) { say('choose a file', true); return; }
    try {
      await pub(`${a}/packet?round=${Number($('pround').value)}&name=${encodeURIComponent(f.name)}`,
        { method: 'POST', body: f });
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  $('setrounds').onclick = async () => {
    const n = Number($('numrounds').value);
    if (!Number.isInteger(n) || n < 1 || n > 999) { say('rounds must be 1-999', true); return; }
    try {
      settings = { ...settings, rounds: n };
      await pub(a, { method: 'POST', json: { settings } });
      showDetail();
    } catch (e) { say(e.message, true); }
  };

  /* packet zip: stage in memory, drag each file onto its round slot */
  const uploadStagedPacket = async (s, round) => {
    const type = /\.json$/i.test(s.name) ? 'application/json'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await pub(`${a}/packet?round=${round}&name=${encodeURIComponent(s.name)}`,
      { method: 'POST', body: new Blob([s.data], { type }) });
  };
  $('upzip').onclick = async () => {
    const f = $('zipfile').files[0];
    if (!f) { say('choose a zip', true); return; }
    try {
      const entries = await readZip(new Uint8Array(await f.arrayBuffer()));
      staged = entries
        .filter((e) => /\.(json|docx)$/i.test(e.name) && !/__MACOSX|\/\./.test('/' + e.name))
        .map((e) => {
          const name = e.name.split('/').pop();
          return { name, data: e.data, guess: guessRound(name) };
        });
      if (!staged.length) { say('no .json or .docx files in the zip', true); return; }
      say(staged.length + ' packets staged');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
  if ($('zipauto')) {
    $('zipauto').onclick = async () => {
      const remaining = [];
      for (const s of staged) {
        if (!s.guess) { remaining.push(s); continue; }
        try { await uploadStagedPacket(s, s.guess); }
        catch (e) { say(s.name + ': ' + e.message, true); remaining.push(s); }
      }
      staged = remaining;
      showDetail();
    };
    $('zipclear').onclick = () => { staged = []; showDetail(); };
    view.querySelectorAll('[data-chip]').forEach((c) => {
      c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.chip);
    });
    view.querySelectorAll('.slot').forEach((slot) => {
      slot.ondragover = (e) => { e.preventDefault(); slot.classList.add('dragover'); };
      slot.ondragleave = () => slot.classList.remove('dragover');
      slot.ondrop = async (e) => {
        e.preventDefault();
        slot.classList.remove('dragover');
        const i = Number(e.dataTransfer.getData('text/plain'));
        if (!staged[i]) return;
        try {
          await uploadStagedPacket(staged[i], Number(slot.dataset.round));
          staged.splice(i, 1);
          showDetail();
        } catch (err) { say(err.message, true); }
      };
    });
  }

  /* roster: upload a qbj, or write one in the editor */
  $('uproster').onclick = async () => {
    const f = $('rfile').files[0];
    if (!f) { say('choose a file', true); return; }
    try {
      const text = await f.text();
      parseRoster(JSON.parse(text)); // fail before uploading junk
      await pub(`${a}/roster?name=${encodeURIComponent(f.name)}`,
        { method: 'POST', body: text });
      schedFetched = false; // schedule editor re-reads the team list
      showDetail();
    } catch (e) { say('roster: ' + e.message, true); }
  };
  $('rostertext').oninput = () => { rosterText = $('rostertext').value; };
  $('editroster').onclick = async () => {
    rosterOpen = $('rosteredit').hidden;
    if (rosterOpen && !rosterText && t.roster_r2_key) {
      try {
        const teams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key));
        rosterText = teams.map((tm) => tm.name + ': ' + tm.players.join(', ')).join('\n');
        $('rostertext').value = rosterText;
      } catch (e) { /* unparseable upload: start blank */ }
    }
    $('rosteredit').hidden = !rosterOpen;
  };
  $('rosterdl').onclick = () => {
    try {
      const teams = parseRosterLines($('rostertext').value);
      download('roster.qbj', JSON.stringify(buildRosterQbj(t.name, teams), null, 2),
        'application/json');
    } catch (e) { say('roster: ' + e.message, true); }
  };
  $('rostersave').onclick = async () => {
    try {
      const teams = parseRosterLines($('rostertext').value);
      await pub(`${a}/roster?name=roster.qbj`,
        { method: 'POST', body: JSON.stringify(buildRosterQbj(t.name, teams), null, 2) });
      rosterOpen = false;
      schedFetched = false; // schedule editor re-reads the team list
      say('roster saved');
      showDetail();
    } catch (e) { say('roster: ' + e.message, true); }
  };
  $('calc').onclick = () => computeStats(a, t, buckets, files);
  renderSchedule(a, t, buckets);
}

/* ---------- schedule ----------
   The working copy lives in module state: edits are local until save
   (POST /a/:secret/schedule). Blob fetched once per page load through
   the admin file route; roster changes invalidate the team cache. */

let sched = null;          // working schedule (or null: creator shown)
let schedFetched = false;
let schedTeams = null;     // roster team names, seed order
let schedSel = null;       // selected slot ref for click-to-swap
let schedGameSel = null;   // selected game ref {p, r, g} for room move
let schedDirty = false;
let schedRoomsOpen = false;
let schedRoomsN = null;    // creator rooms input

function refKey(ref) {
  return ref.bye !== undefined ? `${ref.p}.${ref.r}.b${ref.bye}` : `${ref.p}.${ref.r}.${ref.g}.${ref.side}`;
}
function chip(ref, slot) {
  const cls = 'slotchip' + (slot && slot.label ? ' ph' : '')
    + (schedSel && refKey(schedSel) === refKey(ref) ? ' sel' : '');
  const text = slot ? esc(slotText(slot)) : '&mdash;';
  return `<span class="${cls}" data-ref="${esc(JSON.stringify(ref))}">${text}</span>`;
}

// Fetch-once per page load (or per roster change): the roster team list
// and the saved schedule. showDetail needs it too — the status strip and
// upload groups read the working schedule.
async function ensureSched(a, t) {
  if (schedFetched || !t.roster_r2_key) return;
  schedFetched = true;
  try { schedTeams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)).map((x) => x.name); }
  catch (e) { schedTeams = []; }
  try { sched = await fetchOwnedJson(a, `t/${t.id}/schedule.json`); }
  catch (e) { sched = null; }
}

async function renderSchedule(a, t, buckets) {
  const box = $('schedsec');
  if (!box) return;
  const summarize = (text) => { if ($('schedsum')) $('schedsum').textContent = text; };
  if (!t.roster_r2_key) {
    summarize('needs a roster');
    box.innerHTML = '<div class="muted">needs a roster</div>';
    return;
  }
  await ensureSched(a, t);
  const rerender = () => renderSchedule(a, t, buckets);

  /* -- creator -- */
  if (!sched) {
    if (schedRoomsN === null) schedRoomsN = Math.max(1, buckets.length);
    const fmts = formatsFor(schedTeams.length, schedRoomsN);
    summarize(schedTeams.length + ' teams, none yet');
    box.innerHTML = `
      <div class="row" style="margin-bottom:8px">
        <span class="muted">${schedTeams.length} teams</span>
        <label class="muted">rooms <input id="schedrooms" type="number" min="1" max="60" value="${schedRoomsN}" style="width:64px"></label>
      </div>
      ${fmts.map((f, i) => `
      <div class="card"><label class="row"><input type="radio" name="schedfmt" value="${f.key}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(f.name)}</b> <span class="muted">&mdash; ${esc(f.desc)}</span></span></label></div>`).join('')
      || '<div class="muted">no format fits</div>'}
      ${fmts.length ? '<div class="row"><button id="schedgen" class="primary">generate</button></div>' : ''}`;
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
        schedSel = null;
        schedGameSel = null;
      } catch (e) { say(e.message, true); return; }
      // a generated schedule goes live right away — "save" is only for
      // edits made after
      try {
        await pub(a + '/schedule', { method: 'POST', json: sched });
        schedDirty = false;
        say('schedule saved');
      } catch (e) {
        schedDirty = true;
        say('not saved: ' + e.message, true);
      }
      rerender();
    };
    return;
  }

  /* -- editor -- */
  const warnings = validateSchedule(sched, schedTeams);
  const normName = (x) => String(x || '').trim().toLowerCase();
  for (const b of buckets) {
    if (!sched.rooms.some((r) => r.bucket === b.id || normName(r.name) === normName(b.room_name))) {
      warnings.push('room not on schedule: ' + b.room_name);
    }
  }
  const selSlot = schedSel ? slotAt(sched, schedSel) : undefined;
  summarize(sched.phases.reduce((n, p) => n + p.rounds.length, 0) + ' rounds · '
    + sched.rooms.length + ' rooms');
  box.innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <span class="spacer" style="flex:1"></span>
      ${schedDirty ? '<span class="pill warn">unsaved</span>' : ''}
      <button id="schedsave" class="primary" ${schedDirty ? '' : 'disabled'}>save</button>
      <button id="schedaddround">add round</button>
      <button id="schedrmround">remove last round</button>
      <button id="schedroomsbtn">rooms</button>
      <button id="schedregen">regenerate</button>
      <button id="scheddel" style="color:var(--bad)">delete</button>
    </div>
    ${warnings.length ? `<div class="bad">${warnings.map(esc).join(' &middot; ')}</div>` : ''}
    ${schedSel ? `
    <div class="row" style="margin:6px 0">
      <span>set ${esc(slotText(selSlot) || 'slot')} to</span>
      <select id="schedassign">
        <option value=""></option>
        ${schedTeams.map((n) => `<option>${esc(n)}</option>`).join('')}
        <option value="__empty">empty</option>
      </select>
      <button id="schedunsel">cancel</button>
    </div>` : ''}
    ${schedGameSel ? (() => {
      const round = sched.phases[schedGameSel.p].rounds[schedGameSel.r];
      const game = round.games[schedGameSel.g];
      return `
    <div class="row" style="margin:6px 0">
      <span>moving ${esc(slotText(game.a) || '—')} v ${esc(slotText(game.b) || '—')} &middot; round ${round.round}</span>
      <button id="schedgunsel">cancel</button>
    </div>`;
    })() : ''}
    <div id="schedroomspanel" ${schedRoomsOpen ? '' : 'hidden'} class="card" style="margin:6px 0">
      ${sched.rooms.map((r, i) => `
      <div class="row" style="margin:2px 0">
        <input data-roomname="${i}" value="${esc(r.name)}" size="18">
        <select data-roombucket="${i}">
          <option value=""></option>
          ${buckets.map((b) => `<option value="${b.id}" ${b.id === r.bucket ? 'selected' : ''}>${esc(b.room_name)}</option>`).join('')}
        </select>
      </div>`).join('')}
      <div class="muted" style="font-size:12px;margin-top:4px">linked room readers preselect their scheduled teams</div>
    </div>
    ${sched.phases.map((phase, p) => {
      const hasByes = phase.rounds.some((r) => r.byes.length);
      return `
      <div class="rhead">${esc(phase.name)}</div>
      <div class="tablewrap">
      <table class="sched">
        <tr><th></th>${sched.rooms.map((r) => `<th>${esc(r.name)}</th>`).join('')}${hasByes ? '<th>bye</th>' : ''}</tr>
        ${phase.rounds.map((round, r) => `
        <tr>
          <td class="roundcell">${round.round}</td>
          ${sched.rooms.map((_, roomI) => {
            const g = round.games.findIndex((x) => x.room === roomI);
            const inRound = schedGameSel && schedGameSel.p === p && schedGameSel.r === r;
            if (g === -1) {
              return `<td><span class="slotchip muted" data-addgame="${p}.${r}.${roomI}">${
                inRound ? '&rarr;' : '+'}</span></td>`;
            }
            const sel = inRound && schedGameSel.g === g;
            return `<td><div class="gcell">
              <div>
                <div>${chip({ p, r, g, side: 'a' }, round.games[g].a)}</div>
                <div>${chip({ p, r, g, side: 'b' }, round.games[g].b)}</div>
              </div>
              <span class="gmove${sel ? ' sel' : ''}" data-movegame="${p}.${r}.${g}" title="${
                sel ? 'cancel' : inRound ? 'move here' : 'move game'}">${
                inRound && !sel ? '&rarr;' : '&#8646;'}</span>
            </div></td>`;
          }).join('')}
          ${hasByes ? `<td>${round.byes.map((s, bi) => chip({ p, r, bye: bi }, s)).join('<br>')}</td>` : ''}
        </tr>`).join('')}
      </table>
      </div>`;
    }).join('')}`;

  const touch = () => { schedDirty = true; rerender(); };
  box.querySelectorAll('.slotchip[data-ref]').forEach((c) => {
    c.onclick = () => {
      const ref = JSON.parse(c.dataset.ref);
      schedGameSel = null;
      if (!schedSel) { schedSel = ref; rerender(); return; }
      if (refKey(schedSel) === refKey(ref)) { schedSel = null; rerender(); return; }
      swapSlots(sched, schedSel, ref);
      schedSel = null;
      touch();
    };
  });
  box.querySelectorAll('[data-movegame]').forEach((h) => {
    h.onclick = () => {
      const [p, r, g] = h.dataset.movegame.split('.').map(Number);
      if (schedGameSel && schedGameSel.p === p && schedGameSel.r === r) {
        if (schedGameSel.g === g) { schedGameSel = null; rerender(); return; }
        moveGame(sched, schedGameSel, sched.phases[p].rounds[r].games[g].room);
        schedGameSel = null;
        touch();
        return;
      }
      schedGameSel = { p, r, g };
      schedSel = null;
      rerender();
    };
  });
  box.querySelectorAll('[data-addgame]').forEach((c) => {
    c.onclick = () => {
      const [p, r, roomI] = c.dataset.addgame.split('.').map(Number);
      if (schedGameSel && schedGameSel.p === p && schedGameSel.r === r) {
        moveGame(sched, schedGameSel, roomI);
        schedGameSel = null;
        touch();
        return;
      }
      sched.phases[p].rounds[r].games.push({ room: roomI, a: null, b: null });
      touch();
    };
  });
  if ($('schedassign')) {
    $('schedassign').onchange = () => {
      const v = $('schedassign').value;
      setSlot(sched, schedSel, v === '__empty' || !v ? null : { team: v });
      schedSel = null;
      touch();
    };
    $('schedunsel').onclick = () => { schedSel = null; rerender(); };
  }
  if ($('schedgunsel')) $('schedgunsel').onclick = () => { schedGameSel = null; rerender(); };
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
      say('schedule saved');
      rerender();
    } catch (e) { say(e.message, true); }
  };
  $('schedaddround').onclick = () => { addRound(sched, sched.phases.length - 1); touch(); };
  $('schedrmround').onclick = () => {
    const p = sched.phases.length - 1;
    const rounds = sched.phases[p].rounds;
    if (!rounds.length) return;
    const last = rounds[rounds.length - 1];
    const filled = last.games.some((g) => g.a || g.b) || last.byes.length;
    if (filled && !confirm('Remove round ' + last.round + '?')) return;
    removeRound(sched, p, rounds.length - 1);
    if (!sched.phases[p].rounds.length && sched.phases.length > 1) sched.phases.splice(p, 1);
    schedSel = null;
    schedGameSel = null;
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
  $('schedregen').onclick = () => {
    if (!confirm('Start over? Unsaved edits are lost; the saved schedule stays until you save a new one.')) return;
    sched = null;
    schedSel = null;
    schedGameSel = null;
    rerender();
  };
  $('scheddel').onclick = async () => {
    if (!confirm('Delete the schedule?')) return;
    try {
      await pub(a + '/schedule', { method: 'DELETE' });
      sched = null;
      schedDirty = false;
      schedSel = null;
      schedGameSel = null;
      say('schedule deleted');
      rerender();
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- stats + export ---------- */

// Blob routes return parsed JSON when stored as JSON (qbj, roster,
// combined), a raw Response otherwise.
async function fetchOwnedJson(a, key) {
  const res = await pub(`${a}/file?key=${encodeURIComponent(key)}`);
  return res instanceof Response ? JSON.parse(await res.text()) : res;
}

async function computeStats(a, t, buckets, files) {
  const out = $('statsout');
  out.innerHTML = '<div class="muted">loading files...</div>';
  const qbjFiles = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
  const errors = [];

  let roster = null;
  if (t.roster_r2_key) {
    try { roster = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)); }
    catch (e) { errors.push('roster: ' + e.message); }
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

  if (!matches.length) {
    out.innerHTML = `<div class="bad">no readable game files</div>
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
      const bundle = {
        entries: raw.map((r) => ({
          id: r.id, round: r.round, room: r.room, filename: r.filename,
          qbj: JSON.parse(r.text),
        })),
      };
      const posted = await pub(a + '/bundle', {
        method: 'POST', body: JSON.stringify(bundle),
      });
      say('stats data rebuilt (' + posted.entries + ' games)');
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- boot ---------- */

if (adminSecret) showDetail();
else showList();
