// exports.js — the hub's tournament downloads, built one way: the
// YellowFruit 4 and 3 files, the HTML report (zipped or as its six pages),
// the QBJ bundle and the roster file. Nothing here reads or writes
// storage: the hub reads what goes in, calls these, and hands the file
// to the browser (admin.js keeps its reads, its menu and its messages).
// One game file or the roster as the Worker serves it is
// engine/exportfile.js, which this file passes on, so the hub imports its
// downloads from one place.
//
// The Worker never imports this file: zip.js, the YellowFruits and the
// report would all enter its bundle.

import { renameModaqTexts } from './modaqfile.js';
import { rosterForExport } from './qbj.js';
import { serializeYft } from './yft.js';
import { serializeYft3 } from './yft3.js';
import { buildReport } from './report.js';
import { makeZip } from './zip.js';

export { uploadQbjName, publicQbjName, publicQbjText, storedFileText, rosterExportBody, fileDownloads } from './exportfile.js';

/** The YellowFruit file for `version` 4 or 3, from the stats' export
    options: { name: <slug>-yf4.yft or <slug>-yf3.yft, data, type }. The
    two share an extension and nothing else, so each is named apart. */
export function yftFile(slug, opts, version) {
  return version === 3
    ? { name: slug + '-yf3.yft', data: serializeYft3(opts), type: 'application/json' }
    : { name: slug + '-yf4.yft', data: serializeYft(opts), type: 'application/json' };
}

/** The HTML report's six pages, [{ name, text }], named <slug>_standings.html
    and so on, as YellowFruit saves them (the hsquizbowl.org tournament
    database refuses report files without that prefix). */
export function reportPages(slug, opts) {
  return buildReport({ ...opts, prefix: slug });
}

/** The six report pages zipped, so they land as one folder ready to host. */
export function reportZipFile(slug, opts) {
  const pages = reportPages(slug, opts);
  return { name: slug + '-report.zip', data: makeZip(pages.map((f) => ({ name: f.name, data: f.text }))), type: 'application/zip' };
}

/** The roster as a file to hand out: without the former names only qb-td
    reads, indented as MODAQ writes (2 spaces). */
export function rosterFileText(qbj) {
  return JSON.stringify(rosterForExport(qbj), null, 2);
}

/**
 * The QBJ bundle: every game as its separate files, in a folder per
 * round, plus the roster. From what the hub has read:
 * - modaqFiles: each reader upload's MODAQ .qbj and game file, as its
 *   Backup to JSON dialog writes them (hubgames.js collectMatches),
 *   under the roster's current names
 * - raw: the games' rows from the same call; a .qbj added by hand
 *   (not a reader's) goes in indented as MODAQ writes (2 spaces)
 * - gameFiles: the game files that went up apart from their .qbj (Add a
 *   game), read one after another in upload order, each
 *   { round, filename, text } with the text 2-space indented, or
 *   { round, filename, error } for one that couldn't be read (left out)
 * - roster: { json } as read, { error }, or null without a roster
 * - names: the roster's renames (rosterNameMap) the game files take
 * Uploads list newest first, so the first file under a name wins: a
 * re-exported game keeps its latest upload (the same name twice would
 * break the zip), and a reader's file beats one added by hand.
 */
export function qbjZipFile(slug, { modaqFiles, raw, gameFiles, roster, names }) {
  const seen = new Set();
  const entries = [];
  const add = (round, filename, data) => {
    const name = `round-${round}/${filename}`;
    if (seen.has(name)) return;
    seen.add(name);
    entries.push({ name, data });
  };
  for (const x of modaqFiles) {
    if (x.qbj) add(x.round, x.qbjName, x.qbj);
    if (x.game) add(x.round, x.gameName, x.game);
  }
  const indent = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; } };
  for (const r of raw.filter((x) => !x.reader)) add(r.round, r.filename, indent(r.text));
  for (const g of gameFiles) {
    if (g.error) continue; // the bundle is still useful without it
    try { add(g.round, g.filename, renameModaqTexts({ qbj: null, game: g.text }, names).game); }
    catch (e) { /* the bundle is still useful without it */ }
  }
  if (roster && !roster.error) {
    try { entries.push({ name: 'roster.qbj', data: rosterFileText(roster.json) }); }
    catch (e) { /* the bundle is still useful without it */ }
  }
  return { name: slug + '-qbj.zip', data: makeZip(entries), type: 'application/zip' };
}
