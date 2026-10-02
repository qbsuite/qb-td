// packetsui.js — the Packets + Tiebreakers section: one row per round
// showing the packet it reads, a zip or loose files staged as chips and
// dragged onto rows (filenames carrying a round number auto-assign, never
// over an occupied round) or a file uploaded straight onto one row, and a tiebreaker
// packet split into individually tracked questions. Shared by the TO
// dashboard (admin.js — a tournament's own packets) and the set editor's
// (setadmin.js — the packets every mirror of the set starts with); each
// passes its own upload calls, so nothing here knows a route.

import { esc } from './api.js';
import { guessRound } from '../engine/qbj.js';
import { readZip } from '../engine/zip.js';
import { readPacket } from './buzzview.js';
import { busy } from './busy.js';

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

const PACKET_TYPE = (name) => /\.json$/i.test(name) ? 'application/json'
  : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A staged packet as the Blob an upload route takes. */
export function stagedBlob(s) {
  return new Blob([s.data], { type: PACKET_TYPE(s.name) });
}

/**
 * Render into `box`. Options:
 *   staged        the caller's staging array (mutated in place, so it
 *                 survives the caller's re-renders)
 *   slots         how many round slots to show
 *   rounds        [{number, name, href, warn}] — slots that hold a packet
 *                 (warn: shown red — a set packet whose review is not done)
 *   setSlots(n)   persist a new slot count (Add / Remove last)
 *   minSlots      the fewest slots Remove last may leave (default 1)
 *   countNote     where the count comes from ('from the schedule')
 *   slotName      what one slot is called ('Round', or 'Packet' for a set)
 *   uploadPacket(staged, round), uploadTb(name, data) -> true on success,
 *   clearTb()     the caller's routes
 *   pool          the tiebreaker pool blob, or null
 *   showUses      list which teams have heard each question (a
 *                 tournament's pool has a usage log; a set's does not)
 *   slotLabel     what a slot is called ('Rounds' — or 'Packets', for a set)
 *   tbTitle, packetsNote, tbNote   the second heading, and the
 *                 explanatory lines under each
 *   afterPackets  extra markup between the two sections
 *   say, rerender (local redraw), refresh (refetch + redraw)
 */
export function renderPacketsUi(box, o) {
  const { staged, rounds, slots: slotCount, pool } = o;
  const slots = Array.from({ length: slotCount }, (_, i) => i + 1);
  const tbQuestions = pool
    ? [...(pool.tossups || []).map((q) => ({ ...q, kind: 'Tossup', answer: stripTags(q.answer) })),
       ...(pool.bonuses || []).map((b) => ({ ...b, kind: 'Bonus',
         answer: (b.answers || []).map(stripTags).join(' / ') }))]
    : [];
  const usesFor = (id) => ((pool && pool.uses) || []).filter((u) => u && u.q === id);
  const noun = o.slotName || 'Round';
  const nounPl = (o.slotLabel || 'Rounds').toLowerCase();
  const minSlots = Math.max(1, o.minSlots || 1);
  box.innerHTML = `
    <div class="pkhead">
      <h2>Packets</h2>
      <span class="pkcount">${slotCount} ${slotCount === 1 ? noun.toLowerCase() : nounPl}${
        o.countNote ? ` <span class="muted">&middot; ${o.countNote}</span>` : ''}</span>
      <span class="spacer" style="flex:1"></span>
      <button id="dropslot" class="small" ${slotCount <= minSlots ? 'disabled' : ''}
        title="Remove the last ${noun.toLowerCase()} (only an empty one past the schedule)">Remove last</button>
      <button id="addslot" class="small">Add a ${noun.toLowerCase()}</button>
    </div>
    ${o.intro ? `<p class="secnote">${o.intro}</p>` : ''}
    <div class="row pkbar">
      <button id="pickzip">Upload packet zip</button>
      <button id="pickfiles">Upload packets</button>
      <input id="zipfile" type="file" accept=".zip" hidden>
      <input id="pfiles" type="file" accept=".json,.docx" multiple hidden>
      <input id="rowfile" type="file" accept=".json,.docx" hidden>
    </div>
    ${staged.length ? `
    <div class="pkstaged">
      <span class="muted">Staged</span>
      ${staged.map((s, i) => `<span class="chip" draggable="true" data-chip="${i}">${esc(s.name)}${
        s.guess ? ` <span class="muted">&rarr; ${noun} ${s.guess}</span>` : ''}</span>`).join('')}
      <span class="spacer" style="flex:1"></span>
      <button id="zipauto" class="small">Assign by filename</button>
      <button id="zipclear" class="small">Clear</button>
    </div>` : ''}
    <table class="pktable">
      ${slots.map((k) => {
        const r = rounds.find((x) => x.number === k);
        return `<tr class="slot${r ? ' has' : ''}${r && r.warn ? ' warn' : ''}" data-round="${k}">
          <td class="pkn">${noun} ${k}</td>
          <td class="pkfile">${r
            ? `<span class="dot"></span><a href="${esc(r.href)}" download title="Download">${esc(r.name)}</a>`
            : `<span class="dot"></span><span class="muted">No packet yet${staged.length ? ' &middot; drop one here' : ''}</span>`}</td>
          <td class="pkact"><button class="small" data-pickround="${k}">${r ? 'Replace' : 'Upload'}</button></td>
        </tr>`;
      }).join('')}
    </table>
    ${o.packetsNote ? `<div class="muted" style="font-size:13px;margin-top:6px">${o.packetsNote}</div>` : ''}
    ${o.afterPackets || ''}

    <h2>${o.tbTitle || 'Tiebreakers'}</h2>
    <p class="secnote">${o.tbNote}</p>
    <div class="row" style="margin-bottom:8px">
      <button id="picktb" class="primary">Upload tiebreaker packet</button>
      <input id="tbfile" type="file" accept=".json,.docx" hidden>
      <span class="slotdrop" id="tbdrop">Or drop a staged .json packet chip here to split it</span>
      ${tbQuestions.length ? '<span class="spacer" style="flex:1"></span><button id="tbclear" class="small">Delete pool</button>' : ''}
    </div>
    ${tbQuestions.length ? `<div class="tablewrap"><table>
      <tr><th>Question</th><th>Kind</th><th>Answer</th>${o.showUses ? '<th>Status</th>' : ''}</tr>
      ${tbQuestions.map((q) => {
        const uses = usesFor(q.id);
        return `<tr>
          <td class="mono">${esc(q.id)}</td>
          <td>${esc(q.kind)}</td>
          <td>${esc(q.answer)} <span class="muted" style="font-size:12px">(${esc(q.from || '')}${
            q.set ? ', from the set' : ''})</span></td>
          ${o.showUses ? `<td>${uses.length
            ? uses.map((u) => `<span class="bad">Heard by</span> <b>${
                (u.teams || []).map(esc).join(' &amp; ')}</b> <span class="muted">(Round ${
                esc(String(u.round))}, ${esc(u.room || '')})</span>`).join('<br>')
            : '<span class="ok">Unused</span>'}</td>` : ''}
        </tr>`;
      }).join('')}
    </table></div>` : '<div class="muted">No tiebreaker questions yet</div>'}`;

  const $ = (id) => box.querySelector('#' + id);
  const stageFiles = async (fileList) => {
    for (const f of fileList) {
      staged.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()),
        guess: guessRound(f.name) });
    }
    o.say(fileList.length + ' packet' + (fileList.length === 1 ? '' : 's') + ' staged');
    o.rerender();
  };
  $('pickzip').onclick = () => $('zipfile').click();
  $('pickfiles').onclick = () => $('pfiles').click();
  $('picktb').onclick = () => $('tbfile').click();
  $('zipfile').onchange = async () => {
    const f = $('zipfile').files[0];
    if (!f) return;
    const run = busy($('pickzip'), { label: 'Reading zip', scope: box });
    try {
      const entries = await readZip(new Uint8Array(await f.arrayBuffer()));
      const picked = entries
        .filter((e) => /\.(json|docx)$/i.test(e.name) && !/__MACOSX|\/\./.test('/' + e.name))
        .map((e) => {
          const name = e.name.split('/').pop();
          return { name, data: e.data, guess: guessRound(name) };
        });
      if (!picked.length) { o.say('No .json or .docx files in the zip', true); return; }
      staged.push(...picked);
      o.say(picked.length + ' packets staged');
      run.end();
      o.rerender();
    } catch (e) { run.end(); o.say(e.message, true); }
  };
  $('pfiles').onchange = () => {
    if ($('pfiles').files.length) stageFiles([...$('pfiles').files]);
  };
  const unstage = (s) => { if (staged.includes(s)) staged.splice(staged.indexOf(s), 1); };
  // The chip a drop carries, or null. Anything that is not one of our
  // chips — a file dragged in from the desktop carries no text at all,
  // and Number('') is 0 — must not resolve to the first staged packet.
  const droppedChip = (e) => {
    const raw = e.dataTransfer.getData('text/plain');
    return /^\d+$/.test(raw) ? staged[Number(raw)] || null : null;
  };
  // The Worker splits JSON only, so a .docx goes through YAPP here first,
  // the same parser the reader uses for docx packets
  const uploadTb = async (name, data) => {
    if (/\.docx$/i.test(name)) {
      let packet;
      try { packet = await readPacket(new Response(data), name); }
      catch (e) { o.say(`${name} couldn't be read as a packet: ${e.message}`, true); return false; }
      return o.uploadTb(name.replace(/\.docx$/i, '.json'), JSON.stringify(packet));
    }
    if (!/\.json$/i.test(name)) { o.say('Tiebreaker packets need to be .json or .docx files.', true); return false; }
    return o.uploadTb(name, data);
  };
  $('tbfile').onchange = async () => {
    const f = $('tbfile').files[0];
    if (!f) return;
    const run = busy($('picktb'), { label: 'Splitting', scope: box });
    const done = await uploadTb(f.name, await f.arrayBuffer());
    run.end();
    if (done) o.refresh();
  };
  if ($('tbclear')) {
    $('tbclear').onclick = async () => {
      if (!confirm(o.showUses ? 'Delete the tiebreaker pool? The usage log goes with it.'
        : 'Delete the tiebreaker pool?')) return;
      try {
        await o.clearTb();
        o.refresh();
      } catch (e) { o.say(e.message, true); }
    };
  }
  if ($('zipauto')) {
    $('zipauto').onclick = async () => {
      const remaining = [];
      let placed = 0;
      // never overwrite silently — a colliding guess stays staged to drag,
      // whether it collides with an uploaded round or with a packet this
      // same pass just placed (Packet 1.json and Packet 1.docx)
      const occupied = new Set(rounds.map((r) => r.number));
      const plan = [];
      for (const s of staged) {
        if (!s.guess || s.guess > slotCount || occupied.has(s.guess)) { remaining.push(s); continue; }
        plan.push(s);
        occupied.add(s.guess);
      }
      if (!plan.length) { o.say('No staged packet has a free round in its name: drag them onto rounds', true); return; }
      // one upload at a time: the button counts, the round being uploaded
      // spins, and it fills when the packet lands
      const run = busy($('zipauto'), { label: 'Uploading packets', total: plan.length, scope: box });
      const failed = [];
      for (const s of plan) {
        const slot = box.querySelector(`.slot[data-round="${s.guess}"]`);
        const chip = box.querySelector(`[data-chip="${staged.indexOf(s)}"]`);
        if (slot) slot.classList.add('up');
        if (chip) chip.classList.add('going');
        try {
          await o.uploadPacket(s, s.guess);
          placed++;
          if (slot) { slot.classList.remove('up'); slot.classList.add('has'); }
        } catch (e) {
          failed.push(s.name + ': ' + e.message);
          remaining.push(s);
          if (slot) slot.classList.remove('up');
          if (chip) chip.classList.remove('going');
        }
        run.step(placed + failed.length);
      }
      run.end();
      staged.splice(0, staged.length, ...remaining);
      if (failed.length) o.say(`Uploaded ${placed} of ${plan.length}. ${failed.join('; ')}. The rest are still staged: press Assign by filename to try again.`, true);
      else o.say(placed + ' assigned' + (remaining.length ? ', ' + remaining.length + ' left to drag' : ''));
      o.refresh();
    };
    $('zipclear').onclick = () => { staged.splice(0, staged.length); o.rerender(); };
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
      const s = droppedChip(e);
      if (!s) return;
      slot.classList.add('up');
      try {
        await o.uploadPacket(s, Number(slot.dataset.round));
        unstage(s);
        o.refresh();
      } catch (err) { slot.classList.remove('up'); o.say(err.message, true); }
    };
  });
  const tbdrop = $('tbdrop');
  tbdrop.ondragover = (e) => { e.preventDefault(); tbdrop.classList.add('dragover'); };
  tbdrop.ondragleave = () => tbdrop.classList.remove('dragover');
  tbdrop.ondrop = async (e) => {
    e.preventDefault();
    tbdrop.classList.remove('dragover');
    const s = droppedChip(e);
    if (!s) return;
    if (await uploadTb(s.name, s.data)) {
      unstage(s);
      o.refresh();
    }
  };
  const setSlots = async (n) => {
    if (n < minSlots || n > 999) return;
    try {
      await o.setSlots(n);
      o.refresh();
    } catch (e) { o.say(e.message, true); }
  };
  $('addslot').onclick = () => setSlots(slotCount + 1);
  $('dropslot').onclick = () => setSlots(slotCount - 1);
  // one file straight onto one round, no staging
  let rowTarget = null;
  box.querySelectorAll('[data-pickround]').forEach((b) => {
    b.onclick = () => { rowTarget = Number(b.dataset.pickround); $('rowfile').value = ''; $('rowfile').click(); };
  });
  $('rowfile').onchange = async () => {
    const f = $('rowfile').files[0];
    if (!f || !rowTarget) return;
    const slot = box.querySelector(`.slot[data-round="${rowTarget}"]`);
    if (slot) slot.classList.add('up');
    try {
      await o.uploadPacket({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }, rowTarget);
      o.say(`${noun} ${rowTarget}: ${f.name}`);
      o.refresh();
    } catch (e) { if (slot) slot.classList.remove('up'); o.say(e.message, true); }
  };
}
