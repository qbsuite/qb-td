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
import { readPacket, partMarker } from './buzzview.js';
import { sanitizeHtml } from '../engine/buzz.js';
import { parseDocxQuestions } from '../engine/docxq.js';
import { busy } from './busy.js';

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

// the row buttons' symbols, drawn in the text colour
const svg = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  preview: svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  download: svg('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/>'),
  upload: svg('<path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M2.5 13.5h11"/>'),
  close: svg('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'),
  undo: svg('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>'),
};
const GRIP = '<span class="grip" aria-hidden="true">\u2807\u2807</span>';

// the last move, for its Undo: {from, to, swapped}
let lastMove = null;

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
 *   removeTb(id)  optional: take one question out (adds a Remove link per row)
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
    ${lastMove ? `<div class="pkundo"><span>${lastMove.swapped
      ? `Swapped ${nounPl} ${lastMove.from} and ${lastMove.to}.`
      : `Moved ${noun} ${lastMove.from}&rsquo;s packet to ${noun} ${lastMove.to}.`}</span>
      <button class="icon" id="pkundo" title="Undo" aria-label="Undo">${ICON.undo}</button></div>` : ''}
    <table class="pktable">
      ${slots.map((k) => {
        const r = rounds.find((x) => x.number === k);
        // a placed packet drags to another round when the caller can move one
        const drag = r && o.movePacket;
        return `<tr class="slot${r ? ' has' : ''}${r && r.warn ? ' warn' : ''}" data-round="${k}">
          <td class="pkn">${noun} ${k}</td>
          <td class="pkfile">${r
            ? `<span class="pkitem"${drag ? ` draggable="true" data-move="${k}" title="Drag to another ${noun.toLowerCase()}"` : ''}>${
              drag ? GRIP : ''}<span class="dot"></span>${esc(r.name)}</span>`
            : `<span class="dot"></span><span class="muted">No packet yet${staged.length || o.movePacket ? ' &middot; drop one here' : ''}</span>`}</td>
          <td class="pkact">${r ? `<button class="icon" data-preview="${k}" title="Preview" aria-label="Preview ${esc(r.name)}">${ICON.preview}</button><a class="icon" href="${esc(r.href)}" download title="Download" aria-label="Download ${esc(r.name)}">${ICON.download}</a>` : ''}<button class="icon" data-pickround="${k}" title="${r ? 'Replace' : 'Upload'}" aria-label="${r ? 'Replace' : 'Upload'} ${noun} ${k}">${ICON.upload}</button></td>
        </tr>`;
      }).join('')}
    </table>
    ${o.packetsNote ? `<div class="muted" style="font-size:13px;margin-top:6px">${o.packetsNote}</div>` : ''}
    ${o.afterPackets || ''}

    <h2>${o.tbTitle || 'Tiebreakers'}</h2>
    <p class="secnote">${o.tbNote}</p>
    <div class="row" style="margin-bottom:8px">
      <button id="picktb" class="primary">Upload tiebreaker packet</button>
      <input id="tbfile" type="file" accept=".json,.docx" multiple hidden>
      <span class="slotdrop" id="tbdrop">Or drop a staged .json packet chip here to split it</span>
      ${tbQuestions.length ? '<span class="spacer" style="flex:1"></span><button id="tbclear" class="small">Delete pool</button>' : ''}
    </div>
    ${tbQuestions.length ? `<div class="tablewrap"><table>
      <tr><th>Question</th><th>Kind</th><th>Answer</th>${o.showUses ? '<th>Status</th>' : ''}${o.removeTb ? '<th></th>' : ''}</tr>
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
          ${o.removeTb ? `<td class="num">${q.set ? '' : `<button class="linkbtn muted" data-tbremove="${esc(q.id)}">Remove</button>`}</td>` : ''}
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
    const m = /^chip:(\d+)$/.exec(e.dataTransfer.getData('text/plain'));
    return m ? staged[Number(m[1])] || null : null;
  };
  // a placed packet's round, or null
  const droppedRound = (e) => {
    const m = /^round:(\d+)$/.exec(e.dataTransfer.getData('text/plain'));
    return m ? Number(m[1]) : null;
  };
  // The Worker splits JSON only, so a .docx goes through YAPP here first,
  // the same parser the reader uses for docx packets
  const uploadTb = async (name, data) => {
    if (/\.docx$/i.test(name)) {
      let packet;
      try { packet = await readPacket(new Response(data), name, { bonusOnly: true }); }
      catch (e) {
        // YAPP wants a whole packet, so it refuses a file of bonuses alone
        // or tossups numbered its own way: qb-td's own reader (docxq.js)
        // takes those, and the TD is told that it did
        let own;
        try { own = await parseDocxQuestions(new Uint8Array(data)); }
        catch (e2) { o.say(`${name} couldn't be read as a packet: ${e.message}`, true); return false; }
        const found = [own.tossups.length && plural(own.tossups.length, 'tossup'),
          own.bonuses.length && plural(own.bonuses.length, 'bonus', 'bonuses')].filter(Boolean).join(' and ');
        const left = own.skipped.length
          ? `\n\nIt left out ${plural(own.skipped.length, 'line')} that it could not place:\n`
            + own.skipped.slice(0, 5).map((t) => '  ' + (t.length > 70 ? t.slice(0, 70) + '…' : t)).join('\n')
            + (own.skipped.length > 5 ? '\n  …' : '')
          : '';
        if (!confirm(`The usual packet parser (YAPP) could not read ${name}, so qb-td used its fallback parser instead. `
          + `The fallback parser found ${found}.${left}\n\nIt is less thorough than YAPP, so please check each question `
          + 'in the list after it is added.\n\nAdd these questions to the pool?')) return false;
        const ok = await o.uploadTb(name.replace(/\.docx$/i, '.json'),
          JSON.stringify({ tossups: own.tossups, bonuses: own.bonuses }));
        if (ok) o.say(`${name} was read with the fallback parser and added ${found}. Please check each question.`);
        return ok;
      }
      return o.uploadTb(name.replace(/\.docx$/i, '.json'), JSON.stringify(packet));
    }
    if (!/\.json$/i.test(name)) { o.say('Tiebreaker packets need to be .json or .docx files.', true); return false; }
    return o.uploadTb(name, data);
  };
  $('tbfile').onchange = async () => {
    const files = [...$('tbfile').files];
    if (!files.length) return;
    const run = busy($('picktb'), { label: 'Splitting', scope: box });
    // one after another, in the order picked: the pool numbers questions
    // as they arrive, and a file that fails doesn't stop the rest
    let done = 0;
    const failed = [];
    for (const f of files) {
      if (await uploadTb(f.name, await f.arrayBuffer())) done++;
      else failed.push(f.name);
    }
    run.end();
    if (files.length > 1) {
      o.say(failed.length ? `${done} of ${files.length} files were added. These could not be read: ${failed.join(', ')}.`
        : `${files.length} files were added to the pool.`, failed.length > 0);
    }
    if (done) o.refresh();
  };
  // one question out of the pool (the set's own, on a mirror, stay)
  box.querySelectorAll('[data-tbremove]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.tbremove;
      const heard = usesFor(id).length;
      if (!confirm(`Remove ${id} from the pool?` + (heard ? ' It has already been read in a game, and that game keeps its record.' : ''))) return;
      const run = busy(btn, { label: 'Removing', scope: box });
      try {
        await o.removeTb(id);
        run.end();
        o.say(`${id} was removed from the pool.`);
        o.refresh();
      } catch (e) { run.end(); o.say(e.message, true); }
    };
  });
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
      c.ondragstart = (e) => e.dataTransfer.setData('text/plain', 'chip:' + c.dataset.chip);
    });
  }
  box.querySelectorAll('.slot').forEach((slot) => {
    slot.ondragover = (e) => { e.preventDefault(); slot.classList.add('dragover'); };
    slot.ondragleave = () => slot.classList.remove('dragover');
    slot.ondrop = async (e) => {
      e.preventDefault();
      slot.classList.remove('dragover');
      const from = droppedRound(e);
      if (from !== null) { movePacket(from, Number(slot.dataset.round)); return; }
      const s = droppedChip(e);
      if (!s) return;
      slot.classList.add('up');
      try {
        await o.uploadPacket(s, Number(slot.dataset.round));
        lastMove = null;
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
  // a placed packet onto another round: swapped with the packet there, or
  // moved when it has none. Rounds with games in ask first, since their
  // buzzpoints and categories follow the packet.
  const movePacket = async (from, to, undo = false) => {
    if (!o.movePacket || from === to) return;
    const there = rounds.find((x) => x.number === to);
    const games = (o.roundGames ? o.roundGames(from) + o.roundGames(to) : 0);
    if (!undo && games && !confirm(`${there ? `Swap the packets of ${nounPl} ${from} and ${to}?` : `Move ${noun} ${from}'s packet to ${noun} ${to}?`} `
      + `${plural(games, 'game')} already uploaded will use the packet now in ${games === 1 ? 'its' : 'their'} ${noun.toLowerCase()}.`)) return;
    const rows = [from, to].map((k) => box.querySelector(`.slot[data-round="${k}"]`)).filter(Boolean);
    rows.forEach((x) => x.classList.add('up'));
    try {
      await o.movePacket(from, to);
      lastMove = undo ? null : { from, to, swapped: Boolean(there) };
      o.refresh();
    } catch (err) { rows.forEach((x) => x.classList.remove('up')); o.say(err.message, true); }
  };
  box.querySelectorAll('[data-move]').forEach((el) => {
    el.ondragstart = (e) => {
      lastMove = null;
      e.dataTransfer.setData('text/plain', 'round:' + el.dataset.move);
      e.dataTransfer.effectAllowed = 'move';
    };
  });
  if ($('pkundo')) {
    $('pkundo').onclick = () => {
      const m = lastMove;
      // a swap undoes itself; a move goes back the way it came
      if (m) movePacket(m.to, m.from, true);
    };
  }
  box.querySelectorAll('[data-preview]').forEach((b) => {
    b.onclick = () => {
      const r = rounds.find((x) => x.number === Number(b.dataset.preview));
      if (r) openPreview(r, noun, o.say);
    };
  });
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

/* ---------- packet preview ----------
   The packet as a document: each tossup followed by its bonus, page by
   page, read through the same parser the reader uses (a .docx goes
   through YAPP). */
async function openPreview(r, noun, say) {
  const view = document.createElement('div');
  view.className = 'pkview';
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-label', r.name);
  view.innerHTML = `<div class="pkviewbar">
      <span class="pkviewname">${esc(noun)} ${r.number} &middot; ${esc(r.name)}</span>
      <a class="icon" href="${esc(r.href)}" download title="Download" aria-label="Download">${ICON.download}</a>
      <button class="icon" data-close title="Close" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="pkviewscroll"><div class="pkpage"><div class="muted">Loading the packet</div></div></div>`;
  const close = () => { view.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  view.querySelector('[data-close]').onclick = close;
  view.onclick = (e) => { if (e.target === view) close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(view);
  const page = view.querySelector('.pkpage');
  try {
    // the download link, without its download name
    const res = await fetch(r.href.replace(/&dl=[^&]*/, ''));
    if (!res.ok) throw new Error('could not load the packet (' + res.status + ')');
    page.outerHTML = packetPagesHtml(await readPacket(res, r.name), r.name);
  } catch (e) {
    page.innerHTML = `<div class="bad">${esc(e.message)}</div>`;
    if (say) say(e.message, true);
  }
}

const answerLine = (a) => `<p class="pka">ANSWER: ${sanitizeHtml(String(a || '').replace(/^\s*ANSWER:\s*/i, ''))}</p>`;
const metaLine = (q) => q && q.metadata ? `<p class="pkm">&lt;${esc(String(q.metadata).replace(/^<|>$/g, ''))}&gt;</p>` : '';

/** A packet's pages: tossup 1, bonus 1, tossup 2, … as the packet pairs them. */
export function packetPagesHtml(packet, name) {
  const tus = packet.tossups || [];
  const bns = packet.bonuses || [];
  const n = Math.max(tus.length, bns.length);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const tu = tus[i];
    const bz = bns[i];
    pairs.push(`<section class="pkpair">${tu ? `
      <p class="pkq"><span class="pkno">${i + 1}.</span> ${sanitizeHtml(tu.question)}</p>
      ${answerLine(tu.answer)}${metaLine(tu)}` : ''}${bz ? `
      <p class="pkq pkbonus"><span class="pkno">B${i + 1}.</span> ${sanitizeHtml(bz.leadin || '')}</p>
      ${(bz.parts || []).map((part, p) => `
        <p class="pkq pkpart"><span class="pkno">${esc(partMarker(bz, p) || '[10]')}</span> ${sanitizeHtml(part)}</p>
        ${answerLine((bz.answers || [])[p])}`).join('')}${metaLine(bz)}` : ''}
    </section>`);
  }
  return `<div class="pkpage"><h3 class="pktitle">${esc(name)}</h3>
    <p class="pkcounts">${plural(tus.length, 'tossup')}, ${plural(bns.length, 'bonus', 'bonuses')}</p>
    ${pairs.join('')}</div>`;
}
