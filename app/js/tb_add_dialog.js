// tb_add_dialog.js — qb-td's replacement for MODAQ's AddQuestionsDialog,
// swapped in at bundle time (tools/build_read.mjs). MODAQ's stock dialog is
// a bare packet-file picker; this one lists the TD's tiebreaker pool — each
// question with its answerline and who has already heard it — so the mod
// picks the question the TD named and it lands at the end of the current
// packet through MODAQ's own supported append path (the same controller the
// stock dialog uses, so scoring state is untouched). Loading a packet file
// stays available underneath as the fallback.

import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { Checkbox, DialogFooter, PrimaryButton, DefaultButton } from '@fluentui/react';
import * as AddQuestionsDialogController from 'modaq/src/components/dialogs/AddQuestionsDialogController';
import * as PacketLoaderController from 'modaq/src/components/PacketLoaderController';
import { PacketLoader } from 'modaq/src/components/PacketLoader';
import { useAppState } from 'modaq/src/contexts/StateContext';
import { ModalVisibilityStatus } from 'modaq/src/state/ModalVisibilityStatus';
import { ModalDialog } from 'modaq/src/components/dialogs/ModalDialog';
import { tbBridge } from './tb_bridge.js';
import { tbSelection } from './read_core.js';

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
  const addSelected = () => {
    const sel = tbSelection(pool, selected);
    if (!sel.tossups.length && !sel.bonuses.length) return;
    // base counts BEFORE this append: what the usage mapping needs when a
    // game predates its meta (read_main.js tbBridge.onAdd)
    const base = {
      t: appState.game.packet.tossups.length,
      b: appState.game.packet.bonuses.length,
    };
    const parsed = { tossups: sel.tossups };
    if (sel.bonuses.length) parsed.bonuses = sel.bonuses;
    const packetState = PacketLoaderController.loadPacket(
      appState, parsed, appState.game.packet.name);
    if (!packetState) return; // conversion error already shown in packet status
    AddQuestionsDialogController.loadPacket(appState, packetState);
    if (tbBridge.onAdd) tbBridge.onAdd({ tu: sel.tu, bo: sel.bo }, base);
    AddQuestionsDialogController.commit(appState);
    setSelected(new Set());
  };
  // the stock path: commit whatever packet file the loader below parsed
  const loadFile = () => {
    AddQuestionsDialogController.commit(appState);
    setSelected(new Set());
  };

  const body = [];
  if (rows.length) {
    body.push(
      h('div', { key: 'hint', style: { marginBottom: 8 } },
        'Tiebreaker questions from the tournament director. Check with the TD which one to read; ',
        'added questions go to the end of the packet.'),
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
      h('div', { key: 'or', style: { margin: '14px 0 4px', fontWeight: 600 } },
        'Or load more questions from a packet file:'));
  } else {
    body.push(h('div', { key: 'none', style: { marginBottom: 8 } },
      'No tiebreaker pool from the tournament director — load a packet file instead.'));
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
