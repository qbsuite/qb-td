// tb_add_dialog.js — qb-td's replacement for MODAQ's AddQuestionsDialog,
// swapped in at bundle time (tools/build_read.mjs). MODAQ's stock dialog is
// a bare packet-file picker; this one lists the TD's tiebreaker pool — each
// question with its answerline and who has already heard it — so the mod
// picks the question the TD named. It goes in at the reader's place, so it
// is read next in place of a thrown-out question, or at the end of the
// packet through MODAQ's own append path (the controller the stock dialog
// uses). Loading a packet file stays available underneath as the fallback,
// and takes the same choice.
//
// Replace mode (Actions -> Replace tossup / Replace bonus, patched into
// MODAQ's menu by tools/build_read.mjs): the moderator picks one question,
// from the pool or from a packet file, and the dialog throws out the
// question being read and puts the pick in its place, in that order, so it
// is read next and nothing else in the game moves.

import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction, reaction } from 'mobx';
import { Checkbox, ChoiceGroup, DialogFooter, PrimaryButton, DefaultButton } from '@fluentui/react';
import * as AddQuestionsDialogController from 'modaq/src/components/dialogs/AddQuestionsDialogController';
import * as PacketLoaderController from 'modaq/src/components/PacketLoaderController';
import { PacketLoader } from 'modaq/src/components/PacketLoader';
import { useAppState } from 'modaq/src/contexts/StateContext';
import { ModalVisibilityStatus } from 'modaq/src/state/ModalVisibilityStatus';
import { ModalDialog } from 'modaq/src/components/dialogs/ModalDialog';
import { PacketState } from 'modaq/src/state/PacketState';
import { tbBridge } from './tb_bridge.js';
import { tbSelection, readerInsertPoint, addCounts, replaceCheck, afterThrowOut, replaceQuestion,
  syncReserved, keepsThrownOut, heldBonusText, placeholderBonus, undoReplace, undoTop } from './read_core.js';

const h = React.createElement;
const strip = (s) => String(s || '').replace(/<[^>]*>/g, '');

function poolRows(pool) {
  if (!pool) return [];
  const usesFor = (id) => (pool.uses || []).filter((u) => u && u.q === id);
  return [
    ...pool.tossups.map((q) => ({
      id: q.id, kind: 'Tossup', answer: strip(q.answer), uses: usesFor(q.id),
    })),
    ...pool.bonuses.map((b) => ({
      id: b.id, kind: 'Bonus', answer: (b.answers || []).map(strip).join(' / '),
      uses: usesFor(b.id),
    })),
  ];
}

// Where "at the reader's place" would put tossups and bonuses right now,
// or {error} when MODAQ's records rule it out (read_core readerInsertPoint).
function insertPoint(appState, adds) {
  const game = appState.game;
  const ci = appState.uiState.cycleIndex;
  return readerInsertPoint({
    cycles: game.cycles, cycleIndex: ci,
    curT: game.getTossupIndex(ci), curB: game.getBonusIndex(ci),
    bonusCount: game.packet.bonuses.length,
    tossups: adds.tossups > 0, bonuses: adds.bonuses > 0,
  });
}

// MODAQ's AddQuestionsDialogController.commit, inserting at game indices
// {t, b} instead of appending. The new packet replaces the old one the same
// way (game.loadPacket adds cycles for the extra tossups).
function insertAt(appState, at, tossups, bonuses) {
  const game = appState.game;
  const ins = (list, i, more) => [...list.slice(0, i), ...more, ...list.slice(i)];
  const combined = new PacketState();
  combined.setTossups(ins(game.packet.tossups, at.t, tossups));
  combined.setBonuses(ins(game.packet.bonuses, at.b, bonuses));
  combined.setName(game.packet.name);
  game.loadPacket(combined);
  appState.uiState.dialogState.hideAddQuestionsDialog();
}
function commitAt(appState, at) {
  const add = appState.uiState.dialogState.addQuestions;
  if (!add || !add.newPacket) return;
  insertAt(appState, at, add.newPacket.tossups, add.newPacket.bonuses);
}

/** A thrown-out tossup's negs and protests go with it: MODAQ keeps them,
    and then counts only a slot's first neg (Cycle.updateNeg), so a neg on
    the replacement would score nothing, and a correct buzz on the
    replacement drops negs by word position across the two tossups. Called
    after MODAQ's own Throw out tossup too (build_read.mjs patches it). */
export function clearThrownOutNegs(appState, cycle, tossupIndex) {
  const next = afterThrowOut(cycle, tossupIndex);
  runInAction(() => {
    cycle.wrongBuzzes = next.wrongBuzzes;
    cycle.tossupProtests = next.tossupProtests;
    if (next.changed) cycle.updateNeg(appState.game.gameFormat);
  });
  cycle.updateIfNeeded();
}

/** Open the dialog in replace mode, for the tossup or the bonus being read
    (the Actions menu items build_read.mjs adds call this). */
export function openReplace(appState, kind) {
  tbBridge.replace = kind;
  // the loader's status line still describes the game's own packet, which
  // would read as if a file were already loaded for picking
  appState.uiState.setPacketStatus({ isError: false, status: '' });
  appState.uiState.dialogState.showAddQuestionsDialog();
}

// MODAQ's PacketState from lists of its questions
function makePacket(tossups, bonuses, name) {
  const p = new PacketState();
  p.setTossups(tossups);
  p.setBonuses(bonuses);
  p.setName(name);
  return p;
}

const REPLACE_ERRORS = {
  none: 'There is no question here to replace.',
  nobonus: 'There is no bonus on this question. A bonus can be replaced once a team has answered the tossup correctly.',
  paired: 'This game format reads a bonus with each tossup, so only the latest question can be replaced.',
  needbonus: 'The bonus for the replacement could not be set up.',
};

const WHERE_ERRORS = {
  current: 'The current question already has buzzes or results, so new questions can only go at the end of the packet.',
  later: 'Later questions in this game already have results, so new questions can only go at the end of the packet.',
};

// One line per question to pick from, a radio choice
const preview = (text, n = 90) => {
  const t = strip(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
};

// One question to pick, as radio options: the pool's ('p:' + id) and a
// loaded packet file's ('f:' + index), of one kind
function pickOptions(isTu, pool, file, added) {
  const qs = pool ? (isTu ? pool.tossups : pool.bonuses) : [];
  const usesFor = (id) => ((pool && pool.uses) || []).filter((u) => u && u.q === id);
  const fileQs = file ? (isTu ? file.tossups : file.bonuses) : [];
  return [
    ...qs.map((q) => {
      const heard = usesFor(q.id).map((u) => (u.teams || []).join(' & ') + ' (Round ' + u.round + ')').join('; ');
      return {
        key: 'p:' + q.id,
        disabled: added.has(q.id),
        text: q.id + ' — ' + (isTu ? strip(q.answer) : (q.answers || []).map(strip).join(' / '))
          + (added.has(q.id) ? ' (already in this game)' : '') + (heard ? ' · Heard by ' + heard : ''),
      };
    }),
    ...fileQs.map((q, i) => ({
      key: 'f:' + i,
      text: (i + 1) + '. ' + (isTu ? preview(q.question) + ' — ' + preview(q.answer, 40)
        : preview(q.leadin) + ' — ' + (q.parts || []).map((x) => preview(x.answer, 24)).join(' / ')),
    })),
  ];
}

// the MODAQ question and pool id ('' for a file's) a pick names
function picked(appState, isTu, key, pool, file) {
  if (key.startsWith('p:')) {
    const id = key.slice(2);
    const q = (isTu ? pool.tossups : pool.bonuses).find((x) => x.id === id);
    if (!q) return null;
    const { id: _i, from: _f, ...plain } = q;
    const conv = PacketLoaderController.loadPacket(appState,
      isTu ? { tossups: [plain] } : { tossups: [], bonuses: [plain] }, appState.game.packet.name);
    return conv ? { question: isTu ? conv.tossups[0] : conv.bonuses[0], id } : null;
  }
  if (key.startsWith('f:') && file) {
    const q = (isTu ? file.tossups : file.bonuses)[Number(key.slice(2))];
    return q ? { question: q, id: '' } : null;
  }
  return null;
}

function ReplaceDialog({ appState, kind, onClose }) {
  const [pick, setPick] = React.useState('');
  const [file, setFile] = React.useState(null); // a loaded packet file's PacketState
  const [error, setError] = React.useState('');
  const pool = tbBridge.pool;
  const added = new Set(tbBridge.addedIds ? tbBridge.addedIds() : []);
  const game = appState.game;
  const ci = appState.uiState.cycleIndex;
  const tb = tbBridge.getTb ? tbBridge.getTb() : null;
  const check = replaceCheck({ cycles: game.cycles, cycleIndex: ci, kind, tb, paired: !!game.gameFormat.pairTossupsBonuses });
  const isTu = kind === 'tossup';
  const cycle = game.cycles[ci];
  const now = isTu ? game.getTossupIndex(ci) + 1 : ((cycle && cycle.bonusAnswer) ? cycle.bonusAnswer.bonusIndex + 1 : 0);

  const replace = () => {
    const main = picked(appState, isTu, pick, pool, file);
    if (!main) { setError('That question could not be read.'); return; }
    // an earlier question's replacement holds a blank bonus, for whatever
    // bonus the TD gives if it is answered
    const held = check.needBonus
      ? PacketLoaderController.loadPacket(appState, { tossups: [], bonuses: [placeholderBonus(game.packet.bonuses)] }, game.packet.name)
      : null;
    if (check.needBonus && !held) { setError('That question could not be read.'); return; }
    const out = replaceQuestion({
      game, cycleIndex: ci, kind, question: main.question, id: main.id,
      bonus: held && held.bonuses[0], bonusId: '',
      tb, act: runInAction, makePacket,
    });
    if (out.error) { setError(REPLACE_ERRORS[out.error] || out.error); return; }
    if (tbBridge.setTb) tbBridge.setTb(out.tb);
    if (isTu) appState.uiState.setSelectedWordIndex(-1);
    onClose();
  };

  const body = [];
  const options = pickOptions(isTu, pool, file, added);
  if (check.error) {
    body.push(h('div', { key: 'err' }, REPLACE_ERRORS[check.error]));
  } else {
    const q = ci + 1;
    // a replaced tossup keeps its question's bonus (read_core replaceQuestion)
    const own = isTu && cycle && cycle.correctBuzz && cycle.bonusAnswer ? cycle.bonusAnswer.bonusIndex + 1 : 0;
    body.push(h('div', { key: 'what', style: { marginBottom: 10 } },
      (isTu ? `Tossup ${now} on question ${q} will be thrown out, and the tossup you pick will be read in its place.`
          + (own ? ` If it is answered, bonus ${own} is read again.` : '')
        : `Bonus ${now} on question ${q} will be thrown out, and the bonus you pick will be read in its place.`)
        + ' To undo it, click the X next to its event in the Event Log.'));
    if (check.retro) {
      body.push(h('div', { key: 'retro', style: { marginBottom: 10, fontSize: 13 } },
        `Later questions already have results, and they keep them. Please enter the replacement's result on question ${q}.`
          + (check.needBonus ? ' This question had no bonus, so if the replacement is answered, a blank one comes up: please read the bonus the TD gives and enter its parts there.' : '')));
    }
    if (check.needBonus) {
      body.push(h('div', { key: 'warn', style: { marginBottom: 10, fontSize: 13, color: '#8a5300' } },
        'Tossup went dead. It may make more sense to throw it out or leave the question as is and add a new question '
          + 'at the end of the game instead. Are you sure you want to replace?'));
    }
    if (pool && (isTu ? pool.tossups : pool.bonuses).length) {
      body.push(h('div', { key: 'hint', style: { marginBottom: 4, fontWeight: 600 } },
        'From the tournament director. Please check with the TD which one to read.'));
    }
    if (options.length) {
      body.push(h(ChoiceGroup, {
        key: 'pick', selectedKey: pick || null, options,
        onChange: (e, o) => { setPick(o.key); setError(''); },
      }));
    } else {
      body.push(h('div', { key: 'nopool', style: { marginBottom: 4 } },
        `There are no ${isTu ? 'tossups' : 'bonuses'} from the tournament director. Please load a packet file and pick one from it.`));
    }
    body.push(
      h('div', { key: 'or', style: { margin: '14px 0 4px', fontWeight: 600 } },
        file ? 'Or load a different packet file:' : 'Or pick from a packet file:'),
      h(PacketLoader, { key: 'loader', appState, onLoad: (packet) => { setFile(packet); setPick(''); } }));
    if (error) body.push(h('div', { key: 'fail', style: { color: '#a4262c', marginTop: 8 } }, error));
  }
  return [
    h('div', { key: 'body' }, body),
    h(DialogFooter, { key: 'foot' },
      check.error ? null : h(PrimaryButton, {
        text: isTu ? 'Replace tossup' : 'Replace bonus',
        disabled: !pick,
        onClick: replace,
      }),
      h(DefaultButton, { text: 'Cancel', onClick: onClose })),
  ];
}

// A bonus held for a replacement tossup on an earlier question is read if
// the replacement is answered and otherwise stays thrown out: kept right on
// each result, and once the game opens (read_core syncReserved). MODAQ's
// GameBar calls this (build_read.mjs), since it is always on screen and
// MODAQ unmounts its dialogs, this one included, while none is open.
export function useHeldBonuses(appState) {
  tbBridge.appState = appState; // for the event log's Undo (undoHandler)
  React.useEffect(() => reaction(
    () => appState.game.cycles.map((c) => (c.correctBuzz ? 1 : 0)).join(''),
    () => {
      const tb = tbBridge.getTb ? tbBridge.getTb() : null;
      if (tb && tb.reserve) syncReserved({ game: appState.game, tb, act: runInAction });
    },
    { fireImmediately: true }), [appState]);
}

/** For MODAQ's event log (ThrowOutQuestionCycleItem, patched by
    build_read.mjs): the latest replacement's event deletes as an undo of
    the replacement (read_core undoReplace), once MODAQ's own "Are you
    sure" is answered. null for any other throw-out. */
export function undoHandler(cycle, isTossup, index) {
  const appState = tbBridge.appState;
  const tb = tbBridge.getTb ? tbBridge.getTb() : null;
  const top = undoTop(tb);
  if (!appState || !top || appState.game.cycles[top.ci] !== cycle
    || (top.kind === 'tossup') !== !!isTossup || top.thrown !== index) return null;
  return () => {
    const out = undoReplace({ game: appState.game, tb: tbBridge.getTb(), act: runInAction, makePacket });
    if (!out.error) {
      if (tbBridge.setTb) tbBridge.setTb(out.tb);
      return;
    }
    // after MODAQ closes its own dialog
    setTimeout(() => appState.uiState.dialogState.showOKMessageDialog({
      title: 'Undo Replacement',
      message: out.error === 'changed'
        ? 'Questions were added to this game after the replacement, so it can no longer be undone.'
        : 'There is no replacement to undo.',
    }), 0);
  };
}

/** For MODAQ's event log (ThrowOutQuestionCycleItem, patched by
    build_read.mjs): whether a throw-out offers its undo, and its text. */
export function keepsThrownOutHere(isTossup, index) {
  return keepsThrownOut(tbBridge.getTb ? tbBridge.getTb() : null, isTossup, index);
}
export function thrownOutText(isTossup, index, text) {
  const tb = tbBridge.getTb ? tbBridge.getTb() : null;
  if (!isTossup && heldBonusText(tb, index)) return heldBonusText(tb, index);
  // a replacement's throw-out: deleting the event undoes the replacement
  if (keepsThrownOut(tb, isTossup, index)) return `Replaced ${isTossup ? 'tossup' : 'bonus'} #${index + 1}`;
  return text;
}

export const AddQuestionsDialog = observer(function AddQuestionsDialog() {
  const appState = useAppState();
  const replacing = tbBridge.replace;
  if (replacing) {
    const close = () => {
      tbBridge.replace = null;
      AddQuestionsDialogController.cancel(appState);
    };
    return h(ModalDialog, {
      title: replacing === 'tossup' ? 'Replace Tossup' : 'Replace Bonus',
      visibilityStatus: ModalVisibilityStatus.AddQuestions,
      onDismiss: close,
    }, h(ReplaceDialog, { key: replacing, appState, kind: replacing, onClose: close }));
  }
  return h(AddDialog, { appState });
});

const AddDialog = observer(function AddDialog({ appState }) {
  const [selected, setSelected] = React.useState(() => new Set());
  const pool = tbBridge.pool;
  const rows = poolRows(pool);
  const added = new Set(tbBridge.addedIds ? tbBridge.addedIds() : []);
  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const cancel = () => {
    setSelected(new Set());
    AddQuestionsDialogController.cancel(appState);
  };
  const [where, setWhere] = React.useState('here');
  const pending = appState.uiState.dialogState.addQuestions && appState.uiState.dialogState.addQuestions.newPacket;
  const sel = tbSelection(pool, selected);
  const adds = addCounts(selected.size > 0, sel, pending);
  const point = insertPoint(appState, adds);
  const here = where === 'here' && !point.error;

  // put the dialog's new packet into the game where the mod chose, and
  // report it (ids '' for packet-file questions) so the upload can renumber
  const place = (ids) => {
    const base = {
      t: appState.game.packet.tossups.length,
      b: appState.game.packet.bonuses.length,
    };
    const at = here ? { t: point.t, b: point.b } : base;
    if (tbBridge.onAdd) tbBridge.onAdd(ids, base, at);
    if (here) commitAt(appState, at);
    else AddQuestionsDialogController.commit(appState);
    setSelected(new Set());
  };
  const addSelected = () => {
    if (!sel.tossups.length && !sel.bonuses.length) return;
    const parsed = { tossups: sel.tossups };
    if (sel.bonuses.length) parsed.bonuses = sel.bonuses;
    const packetState = PacketLoaderController.loadPacket(
      appState, parsed, appState.game.packet.name);
    if (!packetState) return; // conversion error already shown in packet status
    AddQuestionsDialogController.loadPacket(appState, packetState);
    place({ tu: sel.tu, bo: sel.bo });
  };
  // the stock path: whatever packet file the loader below parsed
  const loadFile = () => {
    const add = appState.uiState.dialogState.addQuestions;
    if (!add || !add.newPacket) return;
    place({ tu: add.newPacket.tossups.map(() => ''), bo: add.newPacket.bonuses.map(() => '') });
  };

  const whereEls = [
    h(ChoiceGroup, {
      key: 'where',
      label: 'Where should they go?',
      selectedKey: here ? 'here' : 'end',
      onChange: (e, o) => setWhere(o.key),
      styles: { root: { marginTop: 14 } },
      options: [
        { key: 'here', text: 'Here',
          disabled: !!point.error },
        { key: 'end', text: 'At the end of the packet' },
      ],
    }),
    point.error ? h('div', { key: 'whynot', style: { fontSize: 12, margin: '4px 0 0 28px' } },
      WHERE_ERRORS[point.error]) : null,
  ];
  const body = [h('div', { key: 'toreplace', style: { marginBottom: 10, fontSize: 13 } },
    'To replace the question being read, please use Replace tossup or Replace bonus in the Actions menu instead.')];
  if (rows.length) {
    body.push(
      h('div', { key: 'hint', style: { marginBottom: 8 } },
        'Tiebreaker questions from the tournament director. Check with the TD which one to read.'),
      ...rows.map((row) => {
        const already = added.has(row.id);
        const heard = row.uses.map((u) =>
          (u.teams || []).join(' & ') + ' (Round ' + u.round + ', ' + (u.room || '') + ')').join('; ');
        return h('div', { key: row.id, style: { margin: '6px 0' } },
          h(Checkbox, {
            label: row.id + ' · ' + row.kind + ' — ' + row.answer
              + (already ? ' (already in this game)' : ''),
            disabled: already,
            checked: selected.has(row.id),
            onChange: () => toggle(row.id),
          }),
          heard ? h('div', { style: { fontSize: 12, color: '#a4262c', margin: '2px 0 0 28px' } },
            'Heard by ' + heard) : null);
      }),
      ...whereEls,
      h('div', { key: 'or', style: { margin: '14px 0 4px', fontWeight: 600 } },
        'Or load more questions from a packet file:'));
  } else {
    body.push(h('div', { key: 'none', style: { marginBottom: 8 } },
      'No tiebreaker pool from the tournament director — load a packet file instead.'),
      ...whereEls);
  }
  body.push(h(PacketLoader, {
    key: 'loader',
    appState,
    onLoad: (packet) => AddQuestionsDialogController.loadPacket(appState, packet),
  }));

  return h(ModalDialog, {
    title: 'Add Questions',
    visibilityStatus: ModalVisibilityStatus.AddQuestions,
    onDismiss: cancel,
  },
  h('div', null, body),
  h(DialogFooter, null,
    rows.length ? h(PrimaryButton, {
      text: 'Add selected' + (selected.size ? ' (' + selected.size + ')' : ''),
      disabled: selected.size === 0,
      onClick: addSelected,
    }) : null,
    h(rows.length ? DefaultButton : PrimaryButton, { text: 'Load file', onClick: loadFile }),
    h(DefaultButton, { text: 'Cancel', onClick: cancel })));
});
