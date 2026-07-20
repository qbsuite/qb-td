// admin.js — the TO dashboard (index.html). List/create tournaments, manage
// rooms/packets/roster/uploads, compute stats, export .yft + qbj bundle.

import { API, api, captureToken, token, clearToken, loginUrl, esc, fmtBytes, download } from './api.js';
import { parseMatch, parseRoster, matchPayload } from '../engine/qbj.js';
import { aggregate, dedupeMatches } from '../engine/stats.js';
import { serializeYft } from '../engine/yft.js';
import { makeZip } from '../engine/zip.js';
import { renderStats } from './statsview.js';
import { GAME_FORMAT_OPTIONS } from './read_core.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const msg = $('msg');

let me = null;
let detail = null; // {tournament, buckets, rounds, files} for the open tournament

function say(text, bad = false) {
  msg.textContent = text || '';
  msg.className = bad ? 'bad' : '';
}

function bucketLink(secret) {
  return location.href.split(/[?#]/)[0].replace(/index\.html$/, '').replace(/\/$/, '')
    + '/bucket.html?b=' + secret;
}
function readLink(secret) {
  return location.href.split(/[?#]/)[0].replace(/index\.html$/, '').replace(/\/$/, '')
    + '/read.html?b=' + secret;
}
function statsLink(slug) {
  return location.href.split(/[?#]/)[0].replace(/index\.html$/, '').replace(/\/$/, '')
    + '/stats.html?t=' + slug;
}

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  say('copied ' + label);
}
window.qtd = { copy }; // for inline onclick handlers

/* ---------- auth ---------- */

function renderAuth() {
  $('who').textContent = me ? me.login : '';
  $('authbtn').textContent = me ? 'sign out' : 'sign in with GitHub';
  $('authbtn').onclick = () => {
    if (me) { clearToken(); location.hash = ''; location.reload(); }
    else location.href = loginUrl();
  };
}

/* ---------- tournament list ---------- */

async function showList() {
  detail = null;
  const { tournaments } = await api('/api/tournaments');
  view.innerHTML = `
    <h2>tournaments</h2>
    <div id="tlist">${tournaments.map((t) => `
      <div class="card">
        <div class="row">
          <a href="#t=${t.id}"><b>${esc(t.name)}</b></a>
          <span class="mono muted">${esc(t.slug)}</span>
          <span class="spacer" style="flex:1"></span>
          ${t.published ? '<span class="pill on">public</span>' : '<span class="pill">private</span>'}
          <span class="muted">round ${t.current_round}</span>
        </div>
      </div>`).join('') || '<div class="muted">none yet</div>'}
    </div>
    <h2>new tournament</h2>
    <div class="row">
      <input id="newname" placeholder="name" size="24">
      <input id="newslug" placeholder="slug (public url)" size="18">
      <button id="newbtn" class="primary">create</button>
    </div>`;
  $('newbtn').onclick = async () => {
    try {
      const out = await api('/api/tournaments', { method: 'POST', json: {
        name: $('newname').value, slug: $('newslug').value,
      } });
      location.hash = '#t=' + out.id;
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- tournament detail ---------- */

async function showDetail(id) {
  detail = await api('/api/tournaments/' + id);
  const { tournament: t, buckets, rounds, files } = detail;
  const roundPacket = Object.fromEntries(rounds.map((r) => [r.number, r]));
  let settings = {};
  try { settings = JSON.parse(t.settings) || {}; } catch (e) { /* keep {} */ }

  view.innerHTML = `
    <div class="row">
      <a href="#">&larr; all tournaments</a>
    </div>
    <h2>tournament</h2>
    <div class="row" style="margin-bottom:8px">
      <b style="font-size:18px">${esc(t.name)}</b>
      <span class="mono muted">${esc(t.slug)}</span>
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
        <a href="${API}/api/tournaments/${t.id}/file?key=${encodeURIComponent(r.packet_r2_key)}" download>download</a>
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
           <a href="${API}/api/tournaments/${t.id}/file?key=${encodeURIComponent(t.roster_r2_key)}" download>download</a>`
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
            <a href="${API}/api/tournaments/${t.id}/file?key=${encodeURIComponent(f.r2_key)}" download>download</a>
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

  // auth-header downloads: plain <a href> can't send the bearer token.
  // The proper filename rides in the row: packet_name / roster_name /
  // files.filename, stashed on the anchor by the closest data source.
  const keyToName = {};
  rounds.forEach((r) => { keyToName[r.packet_r2_key] = r.packet_name; });
  files.forEach((f) => { keyToName[f.r2_key] = f.filename; });
  if (t.roster_r2_key) keyToName[t.roster_r2_key] = t.roster_name || 'roster.qbj';
  view.querySelectorAll(`a[href^="${API}"]`).forEach((a) => {
    a.onclick = async (ev) => {
      ev.preventDefault();
      const href = a.getAttribute('href');
      const key = decodeURIComponent((/[?&]key=([^&]+)/.exec(href) || [])[1] || '');
      try {
        const res = await api(href.slice(API.length));
        download(keyToName[key] || key.split('/').pop() || 'file', await res.blob());
      } catch (e) { say(e.message, true); }
    };
  });

  $('setround').onclick = async () => {
    try {
      await api('/api/tournaments/' + t.id, { method: 'POST', json: { current_round: Number($('curround').value) } });
      say('round set');
      showDetail(id);
    } catch (e) { say(e.message, true); }
  };
  $('gformat').onchange = async () => {
    try {
      const next = { ...settings };
      if ($('gformat').value) next.gameFormat = $('gformat').value;
      else delete next.gameFormat;
      await api('/api/tournaments/' + t.id, { method: 'POST', json: { settings: next } });
      settings = next;
      say('game format saved');
    } catch (e) { say(e.message, true); }
  };
  $('pub').onchange = async () => {
    try {
      await api('/api/tournaments/' + t.id, { method: 'POST', json: { published: $('pub').checked } });
      say($('pub').checked ? 'stats page is public' : 'stats page is private');
    } catch (e) { say(e.message, true); }
  };
  $('addroom').onclick = async () => {
    try {
      await api('/api/tournaments/' + t.id + '/buckets', { method: 'POST', json: { room_name: $('roomname').value } });
      showDetail(id);
    } catch (e) { say(e.message, true); }
  };
  view.querySelectorAll('[data-delbucket]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this room? Its link stops working. Uploaded files stay.')) return;
      try {
        await api('/api/tournaments/' + t.id + '/buckets/' + b.dataset.delbucket, { method: 'DELETE' });
        showDetail(id);
      } catch (e) { say(e.message, true); }
    };
  });
  view.querySelectorAll('[data-delfile]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this file?')) return;
      try {
        await api('/api/tournaments/' + t.id + '/files/' + b.dataset.delfile, { method: 'DELETE' });
        showDetail(id);
      } catch (e) { say(e.message, true); }
    };
  });
  $('uppacket').onclick = async () => {
    const f = $('pfile').files[0];
    if (!f) { say('choose a file', true); return; }
    try {
      await api(`/api/tournaments/${t.id}/packet?round=${Number($('pround').value)}&name=${encodeURIComponent(f.name)}`,
        { method: 'POST', body: f });
      showDetail(id);
    } catch (e) { say(e.message, true); }
  };
  $('uproster').onclick = async () => {
    const f = $('rfile').files[0];
    if (!f) { say('choose a file', true); return; }
    try {
      const text = await f.text();
      parseRoster(JSON.parse(text)); // fail before uploading junk
      await api(`/api/tournaments/${t.id}/roster?name=${encodeURIComponent(f.name)}`,
        { method: 'POST', body: text });
      showDetail(id);
    } catch (e) { say('roster: ' + e.message, true); }
  };
  $('calc').onclick = () => computeStats(t, buckets, files);
}

/* ---------- stats + export ---------- */

async function fetchOwnedBlob(tid, key) {
  const res = await api(`/api/tournaments/${tid}/file?key=${encodeURIComponent(key)}`);
  return res.text();
}

async function computeStats(t, buckets, files) {
  const out = $('statsout');
  out.innerHTML = '<div class="muted">loading files...</div>';
  const qbjFiles = files.filter((f) => (f.kind === 'qbj' || f.kind === 'combined') && !f.error);
  const errors = [];

  let roster = null;
  if (t.roster_r2_key) {
    try { roster = parseRoster(JSON.parse(await fetchOwnedBlob(t.id, t.roster_r2_key))); }
    catch (e) { errors.push('roster: ' + e.message); }
  }

  const matches = [];
  const raw = []; // for the zip download and the served stats bundle
  for (const f of qbjFiles) {
    try {
      const text = await fetchOwnedBlob(t.id, f.r2_key);
      // Combined reader uploads contribute only their qbj half downstream
      // (the game half carries the full packet text).
      const payload = matchPayload(JSON.parse(text));
      const m = parseMatch(payload, { filename: f.filename });
      const room = buckets.find((b) => b.id === f.bucket_id);
      m.room = room ? room.room_name : '';
      m.fileId = f.id;
      matches.push(m);
      raw.push({
        id: f.id, round: m.round, room: m.room,
        filename: f.filename.replace(/\.qbtd\.json$/i, '.qbj'),
        text: f.kind === 'combined' ? JSON.stringify(payload) : text,
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
      try { entries.push({ name: 'roster.qbj', data: await fetchOwnedBlob(t.id, t.roster_r2_key) }); }
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
      const out = await api('/api/tournaments/' + t.id + '/bundle', {
        method: 'POST', body: JSON.stringify(bundle),
      });
      say('stats data rebuilt (' + out.entries + ' games)');
    } catch (e) { say(e.message, true); }
  };
}

/* ---------- boot ---------- */

async function route() {
  say('');
  if (!me) return;
  const m = /#t=(\d+)/.exec(location.hash);
  try {
    if (m) await showDetail(Number(m[1]));
    else await showList();
  } catch (e) { say(e.message, true); }
}

async function boot() {
  captureToken();
  if (token()) {
    try { me = await api('/auth/me'); }
    catch (e) { me = null; }
  }
  renderAuth();
  if (!me) {
    view.innerHTML = `
      <div class="card" style="max-width:420px">
        <p>Run a tournament: packet distribution, game file collection,
        stats, YellowFruit export.</p>
        <p style="margin-top:10px"><button class="primary" onclick="location.href='${loginUrl()}'">sign in with GitHub</button></p>
      </div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  await route();
}

boot();
