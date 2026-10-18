// modaq_regen_core.mjs — a reader upload's MODAQ export files, rebuilt from its saved game state,
// the way the reader resumes a game (mobx-sync AsyncTrunk), then write them
// with MODAQ's own export code (QBJ.toQBJString, JSON.stringify(game, null, 2)).
import { AppState } from 'modaq/src/state/AppState.js';
import { toQBJString } from 'modaq/src/qbj/QBJ.js';
import { AsyncTrunk } from 'mobx-sync';

export async function regenerate(storeText, round) {
  const mem = new Map([['g', storeText]]);
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const appState = new AppState();
  const trunk = new AsyncTrunk(appState, { storage, storageKey: 'g', delay: 0 });
  await trunk.init();
  trunk.disposer && trunk.disposer();
  const game = appState.game;
  return {
    qbj: toQBJString(game, game.packet.name ?? appState.uiState.packetFilename, round),
    game: JSON.stringify(game, null, 2),
    teams: game.teamNames.slice(),
  };
}
