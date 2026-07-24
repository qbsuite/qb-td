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
  addRound, removeRound, slotText } from '../engine/schedule.js';

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

async function showDetail() {
  const a = '/a/' + adminSecret;
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

  // One packet slot per round: the set round count, stretched to cover any
  // packet already uploaded past it and the live round.
  const totalRounds = Math.max(Number(settings.rounds) || 1, t.current_round,
    ...rounds.map((r) => r.number));
  const slots = Array.from({ length: totalRounds }, (_, i) => i + 1);

  view.innerHTML = `
    <div class="row">
      <a href="index.html">&larr; all tournaments</a>
    </div>
    <h2>tournament</h2>
    <div class="row" style="margin-bottom:8px">
      <b style="font-size:18px">${esc(t.name)}</b>
      <span class="mono muted">${esc(t.slug)}</span>
      <span class="spacer" style="flex:1"></span>
      <span class="muted">admin link open until ${new Date(t.closes).toLocaleString()}</span>
      <button id="rotate">new admin link</button>
    </div>
    <div class="row">
      <label>current round <input id="curround" type="number" min="1" max="999" value="${t.current_round}" style="width:70px"></label>
      <button id="setround">set</button>
      <span class="spacer" style="flex:1"></span>
      <label class="row"><input type="checkbox" id="pub" ${t.published ? 'checked' : ''}> public page</label>
      <a class="mono" href="${esc(statsLink(t.slug))}" target="_blank">${esc(statsLink(t.slug))}</a>
      <button onclick="qtd.copy('${esc(statsLink(t.slug))}', 'public link')">copy</button>
    </div>
    <div class="row" style="margin-top:8px">
      <label class="row">reader game format
        <select id="gformat">${GAME_FORMAT_OPTIONS.map((o) =>
          `<option value="${o.value}" ${o.value === (settings.gameFormat || '') ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
      ${Object.keys(cleanOverrides(settings.formatOverrides)).length ? '<span class="pill">custom</span>' : ''}
      <button id="fmtedit">customize</button>
    </div>
    <div id="fmtpanel" ${fmtOpen ? '' : 'hidden'} class="card" style="margin-top:8px">
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

    <h2>rooms</h2>
    ${buckets.map((b) => {
      const closes = b.created + 48 * 3600 * 1000;
      const open = Date.now() < closes;
      return `
      <div class="card row">
        <b>${esc(b.room_name)}</b>
        <a class="mono" href="${esc(readLink(b.secret))}" target="_blank">reader link</a>
        <button onclick="qtd.copy('${esc(readLink(b.secret))}', '${esc(b.room_name)} reader link')">copy</button>
        <a class="mono" href="${esc(bucketLink(b.secret))}" target="_blank">bucket link</a>
        <button onclick="qtd.copy('${esc(bucketLink(b.secret))}', '${esc(b.room_name)} link')">copy</button>
        <span class="spacer" style="flex:1"></span>
        <span class="muted">${files.filter((f) => f.bucket_id === b.id).length} files</span>
        ${open
          ? `<span class="muted">closes ${new Date(closes).toLocaleString()}</span>`
          : '<span class="pill">closed</span>'}
        <button data-delbucket="${b.id}">remove</button>
      </div>`;
    }).join('') || '<div class="muted">no rooms yet</div>'}
    <div class="row" style="margin-top:8px">
      <input id="roomname" placeholder="room name" size="18">
      <button id="addroom">add room</button>
    </div>

    <h2>packets</h2>
    <div class="row" style="margin-bottom:8px">
      <label>rounds <input id="numrounds" type="number" min="1" max="999" value="${totalRounds}" style="width:70px"></label>
      <button id="setrounds">set</button>
      <span class="spacer" style="flex:1"></span>
      <input id="zipfile" type="file" accept=".zip">
      <button id="upzip">load packet zip</button>
    </div>
    ${staged.length ? `
    <div class="row" style="margin-bottom:8px">
      ${staged.map((s, i) => `<span class="chip" draggable="true" data-chip="${i}">${esc(s.name)}${
        s.guess ? ` <span class="muted">&rarr; ${s.guess}</span>` : ''}</span>`).join('')}
      <button id="zipauto">assign by filename</button>
      <button id="zipclear">clear</button>
    </div>` : ''}
    ${slots.map((k) => {
      const r = rounds.find((x) => x.number === k);
      return `
      <div class="card row slot" data-round="${k}">
        <b>round ${k}</b>
        ${r ? `<span>${esc(r.packet_name)}</span>` : '<span class="muted">no packet</span>'}
        <span class="spacer" style="flex:1"></span>
        ${r ? `<a href="${API}${a}/file?key=${encodeURIComponent(r.packet_r2_key)}&dl=${encodeURIComponent(r.packet_name)}" download>download</a>` : ''}
      </div>`;
    }).join('')}
    <div class="row" style="margin-top:8px">
      <label>round <input id="pround" type="number" min="1" max="999" value="${t.current_round}" style="width:70px"></label>
      <input id="pfile" type="file">
      <button id="uppacket">upload packet</button>
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

    <div id="schedsec"></div>

    <h2>uploads</h2>
    <div class="tablewrap"><table>
      <tr><th>room</th><th>round</th><th>file</th><th>kind</th><th class="num">size</th><th>status</th><th></th></tr>
      ${files.map((f) => {
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
          <td class="num">${f.round}</td>
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
    </table></div>
    ${files.length ? '' : '<div class="muted" style="margin-top:6px">nothing uploaded yet</div>'}

    <h2>stats + export</h2>
    <div class="row">
      <button id="calc" class="primary">compute stats</button>
      <button id="dlyft" disabled>download .yft</button>
      <button id="dlzip" disabled>download qbj bundle</button>
      <button id="rebuild" disabled>rebuild stats data</button>
    </div>
    <div id="statsout" style="margin-top:12px"></div>`;

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
  $('setround').onclick = async () => {
    try {
      await pub(a, { method: 'POST', json: { current_round: Number($('curround').value) } });
      say('round set');
      showDetail();
    } catch (e) { say(e.message, true); }
  };
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

async function renderSchedule(a, t, buckets) {
  const box = $('schedsec');
  if (!box) return;
  if (!t.roster_r2_key) {
    box.innerHTML = '<h2>schedule</h2><div class="muted">needs a roster</div>';
    return;
  }
  if (!schedFetched) {
    schedFetched = true;
    try { schedTeams = parseRoster(await fetchOwnedJson(a, t.roster_r2_key)).map((x) => x.name); }
    catch (e) { schedTeams = []; }
    try { sched = await fetchOwnedJson(a, `t/${t.id}/schedule.json`); }
    catch (e) { sched = null; }
  }
  const rerender = () => renderSchedule(a, t, buckets);

  /* -- creator -- */
  if (!sched) {
    if (schedRoomsN === null) schedRoomsN = Math.max(1, buckets.length);
    const fmts = formatsFor(schedTeams.length, schedRoomsN);
    box.innerHTML = `
      <h2>schedule</h2>
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
    if ($('schedgen')) $('schedgen').onclick = () => {
      const key = box.querySelector('input[name="schedfmt"]:checked').value;
      const rooms = [];
      for (let i = 0; i < schedRoomsN; i++) {
        rooms.push(buckets[i] ? { name: buckets[i].room_name, bucket: buckets[i].id }
          : { name: 'Room ' + (i + 1), bucket: null });
      }
      try {
        sched = buildSchedule(key, schedTeams, rooms);
        sched.format = key;
        schedDirty = true;
        schedSel = null;
        rerender();
      } catch (e) { say(e.message, true); }
    };
    return;
  }

  /* -- editor -- */
  const warnings = validateSchedule(sched, schedTeams);
  const selSlot = schedSel ? slotAt(sched, schedSel) : undefined;
  box.innerHTML = `
    <h2>schedule</h2>
    <div class="row" style="margin-bottom:6px">
      <span class="muted">${sched.phases.reduce((n, p) => n + p.rounds.length, 0)} rounds</span>
      <span class="spacer" style="flex:1"></span>
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
            if (g === -1) return `<td><span class="slotchip muted" data-addgame="${p}.${r}.${roomI}">+</span></td>`;
            return `<td>
              <div>${chip({ p, r, g, side: 'a' }, round.games[g].a)}</div>
              <div>${chip({ p, r, g, side: 'b' }, round.games[g].b)}</div>
            </td>`;
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
      if (!schedSel) { schedSel = ref; rerender(); return; }
      if (refKey(schedSel) === refKey(ref)) { schedSel = null; rerender(); return; }
      swapSlots(sched, schedSel, ref);
      schedSel = null;
      touch();
    };
  });
  box.querySelectorAll('[data-addgame]').forEach((c) => {
    c.onclick = () => {
      const [p, r, roomI] = c.dataset.addgame.split('.').map(Number);
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
  $('schedsave').onclick = async () => {
    try {
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
    rerender();
  };
  $('scheddel').onclick = async () => {
    if (!confirm('Delete the schedule?')) return;
    try {
      await pub(a + '/schedule', { method: 'DELETE' });
      sched = null;
      schedDirty = false;
      schedSel = null;
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
