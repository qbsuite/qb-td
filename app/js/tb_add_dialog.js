// tb_add_dialog.js — qb-td's replacement for MODAQ's AddQuestionsDialog,
// swapped in at bundle time (tools/build_read.mjs). MODAQ's stock dialog is
// a bare packet-file picker; this one lists the TD's tiebreaker pool — each
// question with its answerline and who has already heard it — so the mod
// picks the question the TD named. It goes in at the reader's place, so it
// is read next in place of a thrown-out question, or at the end of the
// packet through MODAQ's own append path (the controller the stock dialog
// uses). Loading a packet file stays available underneath as the fallback,
// and takes the same choice.

import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { Checkbox, ChoiceGroup, DialogFooter, PrimaryButton, DefaultButton } from '@fluentui/react';
import * as AddQuestionsDialogController from 'modaq/src/components/dialogs/AddQuestionsDialogController';
import * as PacketLoaderController from 'modaq/src/components/PacketLoaderController';
import { PacketLoader } from 'modaq/src/components/PacketLoader';
import { useAppState } from 'modaq/src/contexts/StateContext';
import { ModalVisibilityStatus } from 'modaq/src/state/ModalVisibilityStatus';
import { ModalDialog } from 'modaq/src/components/dialogs/ModalDialog';
import { PacketState } from 'modaq/src/state/PacketState';
import { tbBridge } from './tb_bridge.js';
import { tbSelection, readerInsertPoint, addCounts } from './read_core.js';

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
function commitAt(appState, at) {
  const game = appState.game;
  const add = appState.uiState.dialogState.addQuestions;
  if (!add || !add.newPacket) return;
  const ins = (list, i, more) => [...list.slice(0, i), ...more, ...list.slice(i)];
  const combined = new PacketState();
  combined.setTossups(ins(game.packet.tossups, at.t, add.newPacket.tossups));
  combined.setBonuses(ins(game.packet.bonuses, at.b, add.newPacket.bonuses));
  combined.setName(game.packet.name);
  game.loadPacket(combined);
  appState.uiState.dialogState.hideAddQuestionsDialog();
}

const WHERE_ERRORS = {
  current: 'The current question already has buzzes or results, so new questions can only go at the end of the packet.',
  later: 'Later questions in this game already have results, so new questions can only go at the end of the packet.',
};

export const AddQuestionsDialog = observer(function AddQuestionsDialog() {
  const appState = useAppState();
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
  const body = [];
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
