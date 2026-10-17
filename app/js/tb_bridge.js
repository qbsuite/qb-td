// tb_bridge.js — the seam between the reader page (read_main.js) and the
// tiebreaker Add Questions dialog (tb_add_dialog.js) that the bundle build
// swaps in for MODAQ's stock dialog (tools/build_read.mjs). Both sides live
// in the same bundle, so this module-level object is shared state: the page
// fills it in when a game mounts, the dialog reads it when the moderator
// opens Actions -> Add questions.
export const tbBridge = {
  pool: null,     // normalized tiebreaker pool ({tossups, bonuses, uses}), or null
  addedIds: null, // () => pool question ids already appended to the current game
  onAdd: null,    // ({tu, bo}, base) => record newly appended ids in the game meta
  replace: null,  // 'tossup' | 'bonus' while the dialog is in replace mode
  getTb: null,    // () => the game meta's tb (read_core tbState), or null
  setTb: null,    // (tb) => save it in the game meta
};
