// packetsui.js — the Packets + Tiebreakers section: a zip or loose files
// staged as chips, dragged onto round slots (filenames carrying a round
// number auto-assign, never over an occupied slot), and a tiebreaker
// packet split into individually tracked questions. Shared by the TO
// dashboard (admin.js — a tournament's own packets) and the set editor's
// (setadmin.js — the packets every mirror of the set starts with); each
// passes its own upload calls, so nothing here knows a route.

import { esc } from './api.js';
import { guessRound } from '../engine/qbj.js';
import { readZip } from '../engine/zip.js';

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
 *   setSlots(n)   persist a new slot count
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
          ? `<a class="rchip has slot${r.warn ? ' warn' : ''}" data-round="${k}" title="${esc(r.name)}"
               href="${esc(r.href)}" download><span class="dot"></span>${k}</a>`
          : `<span class="rchip slot" data-round="${k}"><span class="dot"></span>${k}</span>`;
      }).join('')}
    </div>
    <div class="row" style="margin-top:10px">
      <button id="pickzip" class="primary">Upload packet zip</button>
      <button id="pickfiles">Upload packets</button>
      <input id="zipfile" type="file" accept=".zip" hidden>
      <input id="pfiles" type="file" accept=".json,.docx" multiple hidden>
      <span class="spacer" style="flex:1"></span>
      <label>${o.slotLabel || 'Rounds'} <input id="numrounds" type="number" min="1" max="999" value="${slotCount}" style="width:70px"></label>
      <button id="setrounds">Set</button>
    </div>
    <div class="muted" style="font-size:13px;margin-top:6px">${o.packetsNote}</div>
    ${o.afterPackets || ''}

    <h2>${o.tbTitle || 'Tiebreakers'}</h2>
    <div class="muted" style="font-size:13px;margin-bottom:8px">${o.tbNote}</div>
    <div class="row" style="margin-bottom:8px">
      <button id="picktb" class="primary">Upload tiebreaker packet</button>
      <input id="tbfile" type="file" accept=".json" hidden>
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
      o.rerender();
    } catch (e) { o.say(e.message, true); }
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
  const uploadTb = async (name, data) => {
    if (!/\.json$/i.test(name)) { o.say('Tiebreaker packets must be .json', true); return false; }
    return o.uploadTb(name, data);
  };
  $('tbfile').onchange = async () => {
    const f = $('tbfile').files[0];
    if (!f) return;
    if (await uploadTb(f.name, await f.arrayBuffer())) o.refresh();
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
      for (const s of staged) {
        if (!s.guess || s.guess > slotCount || occupied.has(s.guess)) { remaining.push(s); continue; }
        try { await o.uploadPacket(s, s.guess); placed++; occupied.add(s.guess); }
        catch (e) { o.say(s.name + ': ' + e.message, true); remaining.push(s); }
      }
      staged.splice(0, staged.length, ...remaining);
      o.say(placed + ' assigned, ' + remaining.length + ' left to drag');
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
      try {
        await o.uploadPacket(s, Number(slot.dataset.round));
        unstage(s);
        o.refresh();
      } catch (err) { o.say(err.message, true); }
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
  $('setrounds').onclick = async () => {
    const n = Number($('numrounds').value);
    if (!Number.isInteger(n) || n < 1 || n > 999) { o.say((o.slotLabel || 'Rounds') + ' must be 1-999', true); return; }
    try {
      await o.setSlots(n);
      o.refresh();
    } catch (e) { o.say(e.message, true); }
  };
}
