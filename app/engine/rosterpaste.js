// rosterpaste.js — cells copied out of a spreadsheet, for the roster sheet
// (admin.js renderRosterEditor), which fills itself from them.
//
// Google Sheets, Excel and Numbers put copied cells on the clipboard as
// tab-separated rows. A cell holding a tab, a line break or a quote is
// wrapped in quotes with its own quotes doubled.

/** Copied cells as rows of trimmed strings, trailing blank rows and
    columns dropped. */
export function pasteGrid(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let i = 0;
  const endCell = (v) => { row.push(v.trim()); };
  while (i <= s.length) {
    if (s[i] === '"') {
      // a quoted cell, if a closing quote ends it; else the quote is text
      let v = '';
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { v += '"'; j += 2; continue; }
          closed = j + 1 === s.length || s[j + 1] === '\t' || s[j + 1] === '\n';
          break;
        }
        v += s[j++];
      }
      if (closed) {
        endCell(v);
        i = j + 1;
        if (s[i] === '\t') { i++; continue; }
        rows.push(row); row = []; i++;
        continue;
      }
    }
    let j = i;
    while (j < s.length && s[j] !== '\t' && s[j] !== '\n') j++;
    endCell(s.slice(i, j));
    if (s[j] === '\t') { i = j + 1; continue; }
    rows.push(row); row = []; i = j + 1;
  }
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  const width = rows.reduce((w, r) => {
    let n = r.length;
    while (n && !r[n - 1]) n--;
    return Math.max(w, n);
  }, 0);
  return rows.map((r) => Array.from({ length: width }, (_, k) => r[k] || ''));
}
