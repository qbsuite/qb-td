// cats.js — per-category player stats. Categories come from the packet
// JSON (qbreader-format `category`/`subcategory` per tossup), which the
// Worker extracts into a text-free category map at packet-upload time
// (t/<tid>/catmap.json, {rounds: {"<n>": [{c, s} | null, ...]}}). The
// qbj side contributes the buzzes; this module joins the two.
//
// "Heard" is whole-game presence: a player is counted as hearing every
// categorized tossup read in a game they appear in (mid-game
// substitutions are not tracked per tossup).

import { matchBuzzes, unwrapMatch } from './buzz.js';

// display order for primary categories (unknowns sort after, A-Z)
export const CAT_ORDER = ['Literature', 'History', 'Science', 'Fine Arts',
  'Religion', 'Mythology', 'Philosophy', 'Social Science', 'Current Events',
  'Geography', 'Other Academic', 'Trash'];
export function catCompare(a, b) {
  const ia = CAT_ORDER.indexOf(a);
  const ib = CAT_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchPlayers(qbj) {
  const match = unwrapMatch(qbj);
  const out = [];
  for (const mt of (Array.isArray(match.match_teams) ? match.match_teams : [])) {
    const team = mt && mt.team && typeof mt.team.name === 'string' ? mt.team.name.trim() : '';
    for (const mp of (mt && Array.isArray(mt.match_players) ? mt.match_players : [])) {
      const player = mp && mp.player && typeof mp.player.name === 'string' ? mp.player.name.trim() : '';
      if (team && player) out.push({ team, player });
    }
  }
  return out;
}

/**
 * Join the stats-bundle entries ({round, room, qbj}) with the category
 * map. Returns [{player, team, cat, sub, heard, powers, gets, negs,
 * pts}] — one row per player per (category, subcategory) slice, with
 * pts summed from actual buzz values. Rounds absent from the map (docx
 * packets, no packet yet) contribute nothing; uncategorized tossups
 * are skipped. Players who heard a slice without buzzing still get a
 * row (heard only).
 */
export function categoryStats(entries, catmap) {
  const roundsMap = catmap && catmap.rounds && typeof catmap.rounds === 'object'
    ? catmap.rounds : {};
  const rows = new Map();
  const rowFor = (player, team, cat, sub) => {
    const key = JSON.stringify([team, player, cat, sub]);
    if (!rows.has(key)) {
      rows.set(key, { player, team, cat, sub, heard: 0, powers: 0, gets: 0, negs: 0, pts: 0 });
    }
    return rows.get(key);
  };
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const cats = roundsMap[String(e.round)];
    if (!Array.isArray(cats)) continue;
    const players = matchPlayers(e.qbj);
    for (const { tossup, buzzes } of matchBuzzes(e.qbj)) {
      const info = cats[tossup - 1];
      if (!info || typeof info.c !== 'string' || !info.c) continue;
      const cat = info.c;
      const sub = typeof info.s === 'string' ? info.s : '';
      for (const p of players) rowFor(p.player, p.team, cat, sub).heard++;
      for (const b of buzzes) {
        const r = rowFor(b.player, b.team, cat, sub);
        if (b.value > 10) r.powers++;
        else if (b.value > 0) r.gets++;
        else if (b.value < 0) r.negs++;
        r.pts += b.value;
      }
    }
  }
  return [...rows.values()];
}

/** Aggregate rows over a filter into per-player lines, best first. */
export function catPlayerLines(rows, cat, sub) {
  const out = new Map();
  for (const r of rows) {
    if (cat && r.cat !== cat) continue;
    if (sub && r.sub !== sub) continue;
    const key = JSON.stringify([r.team, r.player]);
    if (!out.has(key)) {
      out.set(key, { player: r.player, team: r.team, heard: 0, powers: 0, gets: 0, negs: 0, pts: 0 });
    }
    const line = out.get(key);
    line.heard += r.heard;
    line.powers += r.powers;
    line.gets += r.gets;
    line.negs += r.negs;
    line.pts += r.pts;
  }
  return [...out.values()].sort((a, b) => b.pts - a.pts || b.heard - a.heard);
}

/**
 * One player's per-category breakdown: [{cat, line, subs: [{sub,
 * line}]}] in canonical category order, sub-slices by points.
 */
export function catBreakdown(rows, team, player) {
  const mine = rows.filter((r) => r.team === team && r.player === player);
  const byCat = new Map();
  for (const r of mine) {
    if (!byCat.has(r.cat)) byCat.set(r.cat, []);
    byCat.get(r.cat).push(r);
  }
  const sum = (list) => list.reduce((acc, r) => ({
    heard: acc.heard + r.heard, powers: acc.powers + r.powers,
    gets: acc.gets + r.gets, negs: acc.negs + r.negs, pts: acc.pts + r.pts,
  }), { heard: 0, powers: 0, gets: 0, negs: 0, pts: 0 });
  return [...byCat.entries()]
    .sort(([a], [b]) => catCompare(a, b))
    .map(([cat, list]) => ({
      cat,
      line: sum(list),
      subs: list.filter((r) => r.sub)
        .sort((a, b) => b.pts - a.pts)
        .map((r) => ({ sub: r.sub, line: sum([r]) })),
    }));
}
