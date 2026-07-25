// cats.js — per-category player and team stats. Categories come from the
// packet JSON (qbreader-format `category`/`subcategory` per question),
// which the Worker extracts into a text-free category map at
// packet-upload time (t/<tid>/catmap.json, {rounds: {"<n>": {t: [{c, s}
// | null, ...], b: [...]}}}). The qbj side contributes the buzzes and
// bonus results; this module joins the two.
//
// Purely buzz-based: each categorized tossup credits only the players
// who buzzed on it (power/get/neg). No tossups-heard column — with
// whole-game rosters, per-category heard is a guess, not a stat.
// Callers pass deduped entries (buzz.js dedupeEntries) so re-uploaded
// games don't double-count.

import { matchBuzzes, matchBonuses } from './buzz.js';

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

// One round's category lists. Maps written before bonus extraction store
// a bare tossup array; current maps store {t, b}.
function roundCats(catmap, round) {
  const r = catmap && catmap.rounds && typeof catmap.rounds === 'object'
    ? catmap.rounds[String(round)] : null;
  if (Array.isArray(r)) return { t: r, b: [] };
  if (r && typeof r === 'object') {
    return { t: Array.isArray(r.t) ? r.t : [], b: Array.isArray(r.b) ? r.b : [] };
  }
  return null;
}

function catInfo(list, number) {
  const info = list[number - 1];
  if (!info || typeof info.c !== 'string' || !info.c) return null;
  return { cat: info.c, sub: typeof info.s === 'string' ? info.s : '' };
}

/**
 * Join the stats-bundle entries ({round, room, qbj}) with the category
 * map. Returns [{player, team, cat, sub, powers, gets, negs, pts}] —
 * one row per buzzing player per (category, subcategory) slice, with
 * pts summed from actual buzz values. Rounds absent from the map (docx
 * packets, no packet yet) contribute nothing; uncategorized tossups
 * are skipped, as are zeroed non-first wrong buzzes.
 */
export function categoryStats(entries, catmap) {
  const rows = new Map();
  const rowFor = (player, team, cat, sub) => {
    const key = JSON.stringify([team, player, cat, sub]);
    if (!rows.has(key)) {
      rows.set(key, { player, team, cat, sub, powers: 0, gets: 0, negs: 0, pts: 0 });
    }
    return rows.get(key);
  };
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const cats = roundCats(catmap, e.round);
    if (!cats) continue;
    for (const { tossup, buzzes } of matchBuzzes(e.qbj)) {
      const info = catInfo(cats.t, tossup);
      if (!info) continue;
      for (const b of buzzes) {
        if (!b.value) continue;
        const r = rowFor(b.player, b.team, info.cat, info.sub);
        if (b.value > 10) r.powers++;
        else if (b.value > 0) r.gets++;
        else r.negs++;
        r.pts += b.value;
      }
    }
  }
  return [...rows.values()];
}

/**
 * Team slices of the same join, with the bonus side: [{team, cat, sub,
 * powers, gets, negs, pts, bh, bpts}]. Tossup counts sum the team's
 * buzzes; bh/bpts count bonuses the team controlled (matchBonuses) in
 * that (category, subcategory) slice — controlled points only,
 * bouncebacks are ignored. PPB for a slice = bpts / bh.
 */
export function categoryTeamStats(entries, catmap) {
  const rows = new Map();
  const rowFor = (team, cat, sub) => {
    const key = JSON.stringify([team, cat, sub]);
    if (!rows.has(key)) {
      rows.set(key, { team, cat, sub, powers: 0, gets: 0, negs: 0, pts: 0, bh: 0, bpts: 0 });
    }
    return rows.get(key);
  };
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const cats = roundCats(catmap, e.round);
    if (!cats) continue;
    for (const { tossup, buzzes } of matchBuzzes(e.qbj)) {
      const info = catInfo(cats.t, tossup);
      if (!info) continue;
      for (const b of buzzes) {
        if (!b.value) continue;
        const r = rowFor(b.team, info.cat, info.sub);
        if (b.value > 10) r.powers++;
        else if (b.value > 0) r.gets++;
        else r.negs++;
        r.pts += b.value;
      }
    }
    for (const bn of matchBonuses(e.qbj)) {
      if (!bn.team) continue;
      const info = catInfo(cats.b, bn.bonus);
      if (!info) continue;
      const r = rowFor(bn.team, info.cat, info.sub);
      r.bh++;
      r.bpts += bn.total;
    }
  }
  return [...rows.values()];
}

/** Aggregate team rows over a filter into per-team lines, best first. */
export function catTeamLines(rows, cat, sub) {
  const out = new Map();
  for (const r of rows) {
    if (cat && r.cat !== cat) continue;
    if (sub && r.sub !== sub) continue;
    if (!out.has(r.team)) {
      out.set(r.team, { team: r.team, powers: 0, gets: 0, negs: 0, pts: 0, bh: 0, bpts: 0 });
    }
    const line = out.get(r.team);
    line.powers += r.powers;
    line.gets += r.gets;
    line.negs += r.negs;
    line.pts += r.pts;
    line.bh += r.bh;
    line.bpts += r.bpts;
  }
  return [...out.values()]
    .map((l) => ({ ...l, ppb: l.bh ? l.bpts / l.bh : null }))
    .sort((a, b) => (b.pts + b.bpts) - (a.pts + a.bpts) || (b.ppb ?? -1) - (a.ppb ?? -1));
}

/** Aggregate rows over a filter into per-player lines, best first. */
export function catPlayerLines(rows, cat, sub) {
  const out = new Map();
  for (const r of rows) {
    if (cat && r.cat !== cat) continue;
    if (sub && r.sub !== sub) continue;
    const key = JSON.stringify([r.team, r.player]);
    if (!out.has(key)) {
      out.set(key, { player: r.player, team: r.team, powers: 0, gets: 0, negs: 0, pts: 0 });
    }
    const line = out.get(key);
    line.powers += r.powers;
    line.gets += r.gets;
    line.negs += r.negs;
    line.pts += r.pts;
  }
  return [...out.values()]
    .sort((a, b) => b.pts - a.pts || (b.powers + b.gets) - (a.powers + a.gets));
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
    powers: acc.powers + r.powers, gets: acc.gets + r.gets,
    negs: acc.negs + r.negs, pts: acc.pts + r.pts,
  }), { powers: 0, gets: 0, negs: 0, pts: 0 });
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
