// rosterpaste.js — a roster from cells copied out of a spreadsheet.
//
// Google Sheets, Excel and Numbers put copied cells on the clipboard as
// tab-separated rows. A cell holding a tab, a line break or a quote is
// wrapped in quotes with its own quotes doubled. Three layouts are read:
//   rows:  one team a row, its name first and then its players
//   cols:  one team a column, its name on top and its players below
//   pairs: a team column and a player column, one player a row; a blank
//          team cell keeps the team above
// Teams in rows unless the TD picks another. Row (or column) order is
// seed order. A heading row ("Team", "Player 1"…) is dropped.

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

const TEAM_HEAD = /^(team|teams|team name|school|name)$/i;
const PLAYER_HEAD = /^(player|players|player name|member)s?\s*#?\s*\d*$/i;
const isHead = (cells) => cells.some((c) => TEAM_HEAD.test(c) || PLAYER_HEAD.test(c));

/**
 * Teams from pasted cells: { layout, teams: [{name, players}] }. Blank
 * cells are skipped; names are kept as typed, so a team listed twice or
 * one with no players or no name comes back for the caller to flag.
 */
export function parseRosterPaste(text, layout = 'rows') {
  const grid = pasteGrid(text);
  const how = layout;
  let teams = [];
  if (how === 'cols') {
    const cols = grid.length ? grid[0].map((_, k) => grid.map((r) => r[k])) : [];
    // a heading column on the left ("Team", "Player 1"…)
    const body = cols.length && isHead(cols[0]) ? cols.slice(1) : cols;
    teams = body.filter((c) => c.some(Boolean))
      .map((c) => ({ name: c[0], players: c.slice(1).filter(Boolean) }));
  } else if (how === 'pairs') {
    const body = grid.length && isHead(grid[0]) ? grid.slice(1) : grid;
    const by = new Map();
    let last = null;
    for (const r of body) {
      const name = r[0] || last;
      if (name === null || name === undefined) continue;
      last = name;
      if (!by.has(name)) by.set(name, { name, players: [] });
      for (const p of r.slice(1)) if (p) by.get(name).players.push(p);
    }
    teams = [...by.values()];
  } else {
    const body = grid.length && isHead(grid[0]) ? grid.slice(1) : grid;
    teams = body.filter((r) => r.some(Boolean))
      .map((r) => ({ name: r[0], players: r.slice(1).filter(Boolean) }));
  }
  return { layout: how, teams };
}

/** What stops pasted teams from saving, by team index:
    { name: bool, players: bool, dupPlayers: Set } per team. */
export function pasteProblems(teams) {
  const count = new Map();
  for (const t of teams) if (t.name) count.set(t.name, (count.get(t.name) || 0) + 1);
  return teams.map((t) => {
    const seen = new Set();
    const dupPlayers = new Set();
    for (const p of t.players) { if (seen.has(p)) dupPlayers.add(p); seen.add(p); }
    return { name: !t.name || count.get(t.name) > 1, players: !t.players.length, dupPlayers };
  });
}
