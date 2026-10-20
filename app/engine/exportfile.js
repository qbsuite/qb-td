// exportfile.js — one game file or the roster as a download, one way for
// the Worker (the TD's file links, the roster's Setup download, the public
// per-game QBJ) and the hub (the names and links it shows for each upload).
//
// What comes down is MODAQ's own file (engine/modaqfile.js) under the
// roster's current names: a reader upload split into its .qbj and its
// game file, a .qbj or game file added by hand as it is, renamed. The
// roster leaves without the `_formerNames` only qb-td reads (qbj.js
// rosterForExport). Nothing here reads or writes storage: the Worker
// keeps its reads, its headers and its 404s.
//
// Only function declarations live at the top level, and nothing here
// imports the zip, YellowFruit, report or stats code, so the Worker
// bundle keeps only what it uses.

import { modaqExport, modaqFilenames, renameModaqTexts } from './modaqfile.js';
import { renameMatch, rosterForExport } from './qbj.js';

/** The name a reader upload's .qbj half goes by (the hub's games, the
    QBJ bundle, the .yft): Round_1_A_B.qbtd.json -> Round_1_A_B.qbj. */
export function uploadQbjName(filename) {
  return filename.replace(/\.qbtd\.json$/i, '.qbj');
}

/** The public per-game QBJ's file name, from its copy's filename. */
export function publicQbjName(filename) {
  return String(filename || 'game.qbj').replace(/\.qbtd\.json$/i, '.qbj');
}

/** The public per-game QBJ's text: indented as MODAQ writes its own
    exports, under the roster's current names (`names`, or null). */
export function publicQbjText(qbj, names) {
  return JSON.stringify(renameMatch(qbj, names), null, 2);
}

/**
 * A stored game file's download for part 'qbj' or 'game', from its
 * decoded text `raw`, under the roster's renames (`names`, or null).
 * Returns { text }, or { missing: true } when a reader upload has no such
 * half. Text that isn't a JSON object goes down as it is; a .qbj or game
 * file added by hand is itself, renamed; a reader upload gives MODAQ's
 * own file for that half, under the round the upload is filed in.
 */
export function storedFileText(raw, part, names) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* not JSON: a bare file goes down as it is */ }
  if (!parsed || typeof parsed !== 'object') return { text: raw };
  if (!parsed.qbj && !parsed.game) {
    // a .qbj or game file added by hand: itself, renamed
    return { text: renameModaqTexts(part === 'qbj' ? { qbj: raw, game: null } : { qbj: null, game: raw }, names)[part] };
  }
  const half = parsed[part];
  if (!half || typeof half !== 'object') return { missing: true };
  const round = Number(typeof parsed.qbj === 'object' && parsed.qbj ? parsed.qbj._round : NaN);
  return { text: modaqExport(parsed, Number.isInteger(round) ? round : undefined, names)[part] };
}

/**
 * The roster's Setup download from its decoded text: the roster without
 * its former names, 2-space indented. null means the stored bytes go down
 * as they are: the text isn't JSON, or there is nothing to take out.
 */
export function rosterExportBody(text) {
  try {
    const parsed = JSON.parse(text);
    const out = rosterForExport(parsed);
    if (JSON.stringify(out) !== JSON.stringify(parsed)) return JSON.stringify(out, null, 2);
  } catch (e) { /* not JSON: as it is */ }
  return null;
}

/**
 * The hub's download links for one upload, as [{ params, label }]: the
 * query after `key=` that the Worker's file route takes. A reader upload
 * gives its .qbj and its game file, named as MODAQ names them from the
 * round and `teams` (its summary's two teams, or null without a summary:
 * then after the upload's own name). A .qbj or game file comes down
 * renamed; anything else, or a file with an error, as it was stored.
 */
export function fileDownloads(f, teams) {
  if (f.kind === 'combined' && !f.error) {
    const base = f.filename.replace(/\.qbtd\.json$/i, '');
    const names = teams ? modaqFilenames(f.round, teams) : { qbj: base + '.qbj', game: base + '_Game.json' };
    return [{ params: `part=qbj&dl=${encodeURIComponent(names.qbj)}`, label: 'qbj' },
      { params: `part=game&dl=${encodeURIComponent(names.game)}`, label: 'game' }];
  }
  const own = (f.kind === 'qbj' || f.kind === 'game') && !f.error ? `part=${f.kind}&` : '';
  return [{ params: `${own}dl=${encodeURIComponent(f.filename)}`, label: 'Download' }];
}
