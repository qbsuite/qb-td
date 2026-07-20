// admin.js — the TO dashboard (index.html). No login: the admin link
// (index.html?a=<secret>, minted at creation, expires 48h later) is the
// only credential. Tournaments this device created or opened are
// remembered in localStorage so the list view survives a closed tab —
// but the link itself is the source of truth.

import { API, pub, esc, fmtBytes, download } from './api.js';
import { parseMatch, parseRoster, matchPayload } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { serializeYft } from '../engine/yft.js';
import { makeZip } from '../engine/zip.js';
import { renderStats } from './statsview.js';
import { GAME_FORMAT_OPTIONS } from './read_core.js';

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
function statsLink(slug) { return pageDir() + '/stats.html?t=' + slug; }

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
               : `<span class="pill">closed</span> <a href="${esc(statsLink(e.slug))}">stats</a>`}
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
      <label class="row"><input type="checkbox" id="pub" ${t.published ? 'checked' : ''}> public stats</label>
      <a class="mono" href="${esc(statsLink(t.slug))}" target="_blank">${esc(statsLink(t.slug))}</a>
      <button onclick="qtd.copy('${esc(statsLink(t.slug))}', 'stats link')">copy</button>
    </div>
    <div class="row" style="margin-top:8px">
      <label class="row">reader game format
        <select id="gformat">${GAME_FORMAT_OPTIONS.map((o) =>
          `<option value="${o.value}" ${o.value === (settings.gameFormat || '') ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
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
    ${rounds.map((r) => `
      <div class="card row">
        <b>round ${r.number}</b>
        <span>${esc(r.packet_name)}</span>
        <span class="spacer" style="flex:1"></span>
        <a href="${API}${a}/file?key=${encodeURIComponent(r.packet_r2_key)}&dl=${encodeURIComponent(r.packet_name)}" download>download</a>
      </div>`).join('') || '<div class="muted">no packets yet</div>'}
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
      <input id="rfile" type="file" accept=".qbj,.json">
      <button id="uproster">upload roster qbj</button>
    </div>

    <h2>uploads</h2>
    <div class="tablewrap"><table>
      <tr><th>room</th><th>round</th><th>file</th><th>kind</th><th class="num">size</th><th>status</th><th></th></tr>
      ${files.map((f) => {
        const room = buckets.find((b) => b.id === f.bucket_id);
        return `<tr>
          <td>${esc(room ? room.room_name : '#' + f.bucket_id)}</td>
          <td class="num">${f.round}</td>
          <td>${esc(f.filename)}</td>
          <td>${f.kind}</td>
          <td class="num">${fmtBytes(f.size)}</td>
          <td>${f.error ? `<span class="bad">${esc(f.error)}</span>` : '<span class="ok">ok</span>'}</td>
          <td class="row">
            <a href="${API}${a}/file?key=${encodeURIComponent(f.r2_key)}&dl=${encodeURIComponent(f.filename)}" download>download</a>
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
  $('gformat').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('gformat').value) next.gameFormat = $('gformat').value;
      else delete next.gameFormat;
      await pub(a, { method: 'POST', json: { settings: next } });
      settings = next;
      say('game format saved');
    } catch (e) { say(e.message, true); }
  };
  $('pub').onchange = async () => {
    try {
      await pub(a, { method: 'POST', json: { published: $('pub').checked } });
      say($('pub').checked ? 'stats page is public' : 'stats page is private');
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
  $('uproster').onclick = async () => {
    const f = $('rfile').files[0];
    if (!f) { say('choose a file', true); return; }
    try {
      const text = await f.text();
      parseRoster(JSON.parse(text)); // fail before uploading junk
      await pub(`${a}/roster?name=${encodeURIComponent(f.name)}`,
        { method: 'POST', body: text });
      showDetail();
    } catch (e) { say('roster: ' + e.message, true); }
  };
  $('calc').onclick = () => computeStats(a, t, buckets, files);
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
  const raw = []; // for the zip download and the served stats bundle
  for (const f of qbjFiles) {
    try {
      // Combined reader uploads contribute only their qbj half downstream
      // (the game half carries the full packet text).
      const payload = matchPayload(await fetchOwnedJson(a, f.r2_key));
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
    const entries = raw.map((r) => ({ name: `round-${r.round}/${r.filename}`, data: r.text }));
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
