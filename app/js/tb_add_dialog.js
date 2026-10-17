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
import { runInAction } from 'mobx';
import { Checkbox, ChoiceGroup, DialogFooter, PrimaryButton, DefaultButton } from '@fluentui/react';
import * as AddQuestionsDialogController from 'modaq/src/components/dialogs/AddQuestionsDialogController';
import * as PacketLoaderController from 'modaq/src/components/PacketLoaderController';
import { PacketLoader } from 'modaq/src/components/PacketLoader';
import { useAppState } from 'modaq/src/contexts/StateContext';
import { ModalVisibilityStatus } from 'modaq/src/state/ModalVisibilityStatus';
import { ModalDialog } from 'modaq/src/components/dialogs/ModalDialog';
import { PacketState } from 'modaq/src/state/PacketState';
import { tbBridge } from './tb_bridge.js';
import { tbSelection, readerInsertPoint, addCounts, replaceCheck, afterThrowOut } from './read_core.js';

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

// Throw out the question being read, then put `question` (a MODAQ Tossup
// or Bonus) in its place, recording it for the upload's numbering. Checked
// before anything changes, so it never needs undoing. Returns an error
// message, or '' once done.
function replaceNow(appState, kind, question, id) {
  const game = appState.game;
  const ci = appState.uiState.cycleIndex;
  const cycle = game.cycles[ci];
  const check = replaceCheck({ cycles: game.cycles, cycleIndex: ci, curB: game.getBonusIndex(ci), kind });
  if (check.error) return REPLACE_ERRORS[check.error];
  if (kind === 'tossup') {
    const t = game.getTossupIndex(ci);
    cycle.addThrownOutTossup(t);
    clearThrownOutNegs(appState, cycle, t);
    appState.uiState.setSelectedWordIndex(-1);
  } else {
    cycle.addThrownOutBonus(game.getBonusIndex(ci));
  }
  const point = insertPoint(appState, { tossups: kind === 'tossup' ? 1 : 0, bonuses: kind === 'bonus' ? 1 : 0 });
  if (point.error) return WHERE_ERRORS[point.error]; // replaceCheck rules this out
  const base = { t: game.packet.tossups.length, b: game.packet.bonuses.length };
  const ids = kind === 'tossup' ? { tu: [id], bo: [] } : { tu: [], bo: [id] };
  if (tbBridge.onAdd) tbBridge.onAdd(ids, base, point);
  insertAt(appState, point, kind === 'tossup' ? [question] : [], kind === 'bonus' ? [question] : []);
  return '';
}

const REPLACE_ERRORS = {
  none: 'There is no question here to replace.',
  nobonus: 'There is no bonus being read here. A bonus can be replaced once a team has answered the tossup correctly.',
  later: 'Later questions in this game already have results, so only the question being read now can be replaced.',
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

function ReplaceDialog({ appState, kind, onClose }) {
  const [pick, setPick] = React.useState('');
  const [file, setFile] = React.useState(null); // a loaded packet file's PacketState
  const [error, setError] = React.useState('');
  const pool = tbBridge.pool;
  const added = new Set(tbBridge.addedIds ? tbBridge.addedIds() : []);
  const game = appState.game;
  const ci = appState.uiState.cycleIndex;
  const check = replaceCheck({ cycles: game.cycles, cycleIndex: ci, curB: game.getBonusIndex(ci), kind });
  const isTu = kind === 'tossup';
  const now = isTu ? game.getTossupIndex(ci) + 1 : game.getBonusIndex(ci) + 1;

  // pool questions ('p:' + id) and the loaded file's ('f:' + index)
  const poolQs = pool ? (isTu ? pool.tossups : pool.bonuses) : [];
  const usesFor = (id) => ((pool && pool.uses) || []).filter((u) => u && u.q === id);
  const fileQs = file ? (isTu ? file.tossups : file.bonuses) : [];
  const options = [
    ...poolQs.map((q) => {
      const heard = usesFor(q.id).map((u) => (u.teams || []).join(' & ') + ' (Round ' + u.round + ')').join('; ');
      return {
        key: 'p:' + q.id,
        disabled: added.has(q.id),
        text: q.id + ' \u2014 ' + (isTu ? strip(q.answer) : (q.answers || []).map(strip).join(' / '))
          + (added.has(q.id) ? ' (already in this game)' : '') + (heard ? ' \u00b7 Heard by ' + heard : ''),
      };
    }),
    ...fileQs.map((q, i) => ({
      key: 'f:' + i,
      text: (i + 1) + '. ' + (isTu ? preview(q.question) + ' \u2014 ' + preview(q.answer, 40)
        : preview(q.leadin) + ' \u2014 ' + (q.parts || []).map((p) => preview(p.answer, 24)).join(' / ')),
    })),
  ];

  const replace = () => {
    let question;
    let id = '';
    if (pick.startsWith('p:')) {
      id = pick.slice(2);
      const q = poolQs.find((x) => x.id === id);
      const { id: _i, from: _f, ...plain } = q;
      const conv = PacketLoaderController.loadPacket(appState,
        isTu ? { tossups: [plain] } : { tossups: [], bonuses: [plain] }, game.packet.name);
      if (!conv) { setError('That question could not be read.'); return; }
      question = isTu ? conv.tossups[0] : conv.bonuses[0];
    } else if (pick.startsWith('f:')) {
      question = fileQs[Number(pick.slice(2))];
    }
    if (!question) return;
    const msg = replaceNow(appState, kind, question, id);
    if (msg) { setError(msg); return; }
    onClose();
  };

  const body = [];
  if (check.error) {
    body.push(h('div', { key: 'err' }, REPLACE_ERRORS[check.error]));
  } else {
    body.push(h('div', { key: 'what', style: { marginBottom: 10 } },
      isTu ? `Tossup ${now} will be thrown out, and the tossup you pick will be read in its place.`
        : `Bonus ${now} will be thrown out, and the bonus you pick will be read in its place.`));
    if (poolQs.length) {
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
        file ? 'Or load a different packet file:' : 'Or pick one from a packet file:'),
      h(PacketLoader, { key: 'loader', appState, onLoad: (packet) => { setFile(packet); setPick(''); } }));
    if (error) body.push(h('div', { key: 'fail', style: { color: '#a4262c', marginTop: 8 } }, error));
  }
  return [
    h('div', { key: 'body' }, body),
    h(DialogFooter, { key: 'foot' },
      check.error ? null : h(PrimaryButton, { text: isTu ? 'Replace tossup' : 'Replace bonus', disabled: !pick, onClick: replace }),
      h(DefaultButton, { text: 'Cancel', onClick: onClose })),
  ];
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
