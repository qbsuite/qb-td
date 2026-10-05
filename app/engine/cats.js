// cats.js — per-category player and team stats. Categories come from the
// packet JSON (qbreader-format `category`/`subcategory` per question),
// which the Worker extracts into a text-free category map at
// packet-upload time (t/<tid>/catmap.json, {rounds: {"<n>": {t: [{c, s}
// | null, ...], b: [{c, s, d?} | null, ...]}}}, d = a bonus's e/m/h
// marks). The qbj side contributes the buzzes and
// bonus results; this module joins the two.
//
// Purely buzz-based: each categorized tossup credits only the players
// who buzzed on it (power/get/neg). No tossups-heard column — with
// whole-game rosters, per-category heard is a guess, not a stat. The
// question side (categoryQuestionStats) is different: a reading of a
// tossup is a fact, so there `heard` counts readings.
//
// A bounceback (bb) is a correct buzz that comes after the other team
// buzzed wrong on the same tossup — a neg or a no-penalty miss alike.
// It is a count beside the others, never points: a bounceback power is
// still a power.
// Callers pass deduped entries (buzz.js dedupeEntries) so re-uploaded
// games don't double-count.

import { matchBuzzes, matchBonuses } from './buzz.js';

// display order for primary categories (unknowns sort after, A-Z, then
// Uncategorized last)
export const CAT_ORDER = ['Literature', 'History', 'Science', 'Fine Arts',
  'RMPSS', 'Current Events', 'Geography', 'Other Academic', 'Trash'];
export const UNCATEGORIZED = 'Uncategorized';
// RMPSS is a parent like Literature: its categories are its subcategories
// (and a set's split below them, Social Science's Economics say, folds in)
const RMPSS = ['Religion', 'Mythology', 'Beliefs', 'Philosophy', 'Social Science'];
export function catCompare(a, b) {
  if (a === UNCATEGORIZED || b === UNCATEGORIZED) return (a === UNCATEGORIZED) - (b === UNCATEGORIZED);
  const ia = CAT_ORDER.indexOf(a);
  const ib = CAT_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a < b ? -1 : a > b ? 1 : 0;
}

// One round's category lists. Maps written before bonus extraction store
// a bare tossup array; current maps store {t, b}.
export function roundCats(catmap, round) {
  const r = catmap && catmap.rounds && typeof catmap.rounds === 'object'
    ? catmap.rounds[String(round)] : null;
  if (Array.isArray(r)) return { t: r, b: [] };
  if (r && typeof r === 'object') {
    return { t: Array.isArray(r.t) ? r.t : [], b: Array.isArray(r.b) ? r.b : [] };
  }
  return null;
}

// One map entry as {cat, sub}, or null: an RMPSS category reads as RMPSS
// with itself as the subcategory, and a tag nothing recognized (`u`) as
// Uncategorized with the tag as the subcategory.
export function catOfEntry(info) {
  if (!info) return null;
  if (typeof info.u === 'string' && info.u) return { cat: UNCATEGORIZED, sub: info.u };
  if (typeof info.c !== 'string' || !info.c) return null;
  if (RMPSS.includes(info.c)) return { cat: 'RMPSS', sub: info.c };
  return { cat: info.c, sub: typeof info.s === 'string' ? info.s : '' };
}

export function catInfo(list, number) {
  return catOfEntry(list[number - 1]);
}

// A bonus's difficulty marks from the map ('emh', one letter per part in
// packet order), or null unless they name each of e/m/h exactly once for
// a three-part bonus — anything else can't be read as easy/medium/hard.
function bonusMarks(list, number, nParts) {
  const info = list[number - 1];
  const d = info && typeof info.d === 'string' ? info.d : '';
  return nParts === 3 && d.length === 3 && [...d].sort().join('') === 'ehm' ? d : null;
}

// Which buzzes on one tossup (matchBuzzes order: by position) are
// bouncebacks: correct, after the other team's wrong buzz.
function bouncebacks(buzzes) {
  const missed = new Set();
  return buzzes.map((b) => {
    const bb = b.value > 0 && [...missed].some((t) => t !== b.team);
    if (b.value <= 0) missed.add(b.team);
    return bb;
  });
}

/**
 * Join the stats-bundle entries ({round, room, qbj}) with the category
 * map. Returns [{player, team, cat, sub, powers, gets, negs, bb, pts}] —
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
      rows.set(key, { player, team, cat, sub, powers: 0, gets: 0, negs: 0, bb: 0, pts: 0 });
    }
    return rows.get(key);
  };
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const cats = roundCats(catmap, e.round);
    if (!cats) continue;
    for (const { tossup, tb, buzzes } of matchBuzzes(e.qbj)) {
      if (tb) continue; // tiebreakers have no packet category
      const info = catInfo(cats.t, tossup);
      if (!info) continue;
      const bb = bouncebacks(buzzes);
      buzzes.forEach((b, i) => {
        if (!b.value) return;
        const r = rowFor(b.player, b.team, info.cat, info.sub);
        if (b.value > 10) r.powers++;
        else if (b.value > 0) r.gets++;
        else r.negs++;
        if (bb[i]) r.bb++;
        r.pts += b.value;
      });
    }
  }
  return [...rows.values()];
}

/**
 * Team slices of the same join, with the bonus side: [{team, cat, sub,
 * powers, gets, negs, bb, pts, bh, bpts}]. Tossup counts sum the team's
 * buzzes; bh/bpts count bonuses the team controlled (matchBonuses) in
 * that (category, subcategory) slice — controlled points only,
 * bouncebacks are ignored. PPB for a slice = bpts / bh.
 */
export function categoryTeamStats(entries, catmap) {
  const rows = new Map();
  const rowFor = (team, cat, sub) => {
    const key = JSON.stringify([team, cat, sub]);
    if (!rows.has(key)) {
      rows.set(key, { team, cat, sub, powers: 0, gets: 0, negs: 0, bb: 0, pts: 0, bh: 0, bpts: 0 });
    }
    return rows.get(key);
  };
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const cats = roundCats(catmap, e.round);
    if (!cats) continue;
    for (const { tossup, tb, buzzes } of matchBuzzes(e.qbj)) {
      if (tb) continue; // tiebreakers have no packet category
      const info = catInfo(cats.t, tossup);
      if (!info) continue;
      const bb = bouncebacks(buzzes);
      buzzes.forEach((b, i) => {
        if (!b.value) return;
        const r = rowFor(b.team, info.cat, info.sub);
        if (b.value > 10) r.powers++;
        else if (b.value > 0) r.gets++;
        else r.negs++;
        if (bb[i]) r.bb++;
        r.pts += b.value;
      });
    }
    for (const bn of matchBonuses(e.qbj)) {
      if (!bn.team || bn.tb) continue;
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
      out.set(r.team, { team: r.team, powers: 0, gets: 0, negs: 0, bb: 0, pts: 0, bh: 0, bpts: 0 });
    }
    const line = out.get(r.team);
    line.powers += r.powers;
    line.gets += r.gets;
    line.negs += r.negs;
    line.bb += r.bb || 0;
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
      out.set(key, { player: r.player, team: r.team, powers: 0, gets: 0, negs: 0, bb: 0, pts: 0 });
    }
    const line = out.get(key);
    line.powers += r.powers;
    line.gets += r.gets;
    line.negs += r.negs;
    line.bb += r.bb || 0;
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
    negs: acc.negs + r.negs, bb: acc.bb + (r.bb || 0), pts: acc.pts + r.pts,
  }), { powers: 0, gets: 0, negs: 0, bb: 0, pts: 0 });
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

/* ---------- the questions themselves ----------
   How each category's questions played, over every reading of them —
   the categories tab's Questions view. */

/**
 * Per (category, subcategory) slice: {tossups: [{cat, sub, questions,
 * heard, conv, powers, negs, words}], bonuses: [{cat, sub, questions,
 * heard, pts, dHeard, e, m, h, marked, ranked}]}. `questions` counts
 * distinct packet questions (round + number); `heard` counts readings of
 * them, one per room that read it — with two rooms, twice as many. A
 * tossup reading converts on its first correct
 * buzz (words: that buzz's word number); it counts as negged when any
 * buzz on it lost points. Bonus difficulty comes from the packet's own
 * e/m/h marks where it has them; a bonus without them has its parts
 * ranked by how often they converted across every reading of it (ties
 * keep packet order), so the easiest part is the one most rooms got.
 * e/m/h count conversions over dHeard readings; marked/ranked count the
 * distinct bonuses each way. Only three-part bonuses have a difficulty.
 */
export function categoryQuestionStats(entries, catmap) {
  const tossups = new Map();
  const bonuses = new Map();
  const seen = new Map(); // slice row -> Set of "round:number" read in it
  const slice = (map, cat, sub, init, qkey) => {
    const key = JSON.stringify([cat, sub]);
    if (!map.has(key)) map.set(key, { cat, sub, questions: 0, ...init() });
    const row = map.get(key);
    if (!seen.has(row)) seen.set(row, new Set());
    if (!seen.get(row).has(qkey)) { seen.get(row).add(qkey); row.questions++; }
    return row;
  };
  const tInit = () => ({ heard: 0, conv: 0, powers: 0, negs: 0, words: [] });
  const bInit = () => ({ heard: 0, pts: 0, dHeard: 0, e: 0, m: 0, h: 0, marked: 0, ranked: 0 });
  const unmarked = new Map(); // "round:bonus" -> {row, n, conv}
  const marked = new Set();
  for (const e of entries) {
    if (!e || !e.qbj) continue;
    const cats = roundCats(catmap, e.round);
    if (!cats) continue;
    for (const { tossup, tb, buzzes } of matchBuzzes(e.qbj)) {
      if (tb) continue; // tiebreakers have no packet category
      const info = catInfo(cats.t, tossup);
      if (!info) continue;
      const r = slice(tossups, info.cat, info.sub, tInit, e.round + ':' + tossup);
      r.heard++;
      const right = buzzes.find((b) => b.value > 0);
      if (right) {
        r.conv++;
        r.words.push(right.position + 1);
        if (right.value > 10) r.powers++;
      }
      if (buzzes.some((b) => b.value < 0)) r.negs++;
    }
    for (const bn of matchBonuses(e.qbj)) {
      if (!bn.team || bn.tb) continue; // a bonus nobody controlled wasn't read
      const info = catInfo(cats.b, bn.bonus);
      if (!info) continue;
      const r = slice(bonuses, info.cat, info.sub, bInit, e.round + ':' + bn.bonus);
      r.heard++;
      r.pts += bn.total;
      if (bn.parts.length !== 3) continue;
      const key = e.round + ':' + bn.bonus;
      const d = bonusMarks(cats.b, bn.bonus, bn.parts.length);
      if (d) {
        r.dHeard++;
        bn.parts.forEach((p, i) => { if (p > 0) r[d[i]]++; });
        if (!marked.has(key)) { marked.add(key); r.marked++; }
      } else {
        if (!unmarked.has(key)) unmarked.set(key, { row: r, n: 0, conv: [0, 0, 0] });
        const u = unmarked.get(key);
        u.n++;
        bn.parts.forEach((p, i) => { if (p > 0) u.conv[i]++; });
      }
    }
  }
  for (const { row, n, conv } of unmarked.values()) {
    const order = [0, 1, 2].sort((a, b) => conv[b] - conv[a] || a - b);
    row.dHeard += n;
    row.e += conv[order[0]];
    row.m += conv[order[1]];
    row.h += conv[order[2]];
    row.ranked++;
  }
  return { tossups: [...tossups.values()], bonuses: [...bonuses.values()] };
}

/**
 * Slices summed into display lines: each category, then its
 * subcategories (a subcategory named like its category adds nothing and
 * is folded in). `cat`/`sub` filter the way the other views do.
 * Returns [{cat, sub, isSub, ...summed fields}].
 */
export function questionLines(rows, cat, sub) {
  const add = (a, r) => {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') a[k] = (a[k] || 0) + v;
      else if (Array.isArray(v)) a[k] = (a[k] || []).concat(v);
    }
    return a;
  };
  const cats = [...new Set(rows.map((r) => r.cat))].sort(catCompare)
    .filter((c) => !cat || c === cat);
  const out = [];
  for (const c of cats) {
    const mine = rows.filter((r) => r.cat === c);
    const subs = [...new Set(mine.map((r) => r.sub).filter((s) => s && s !== c))].sort();
    if (sub) {
      const only = mine.filter((r) => r.sub === sub);
      if (only.length) out.push(add({ cat: c, sub, isSub: true }, only.reduce(add, {})));
      continue;
    }
    out.push(add({ cat: c, sub: '', isSub: false }, mine.reduce(add, {})));
    for (const s of subs) {
      out.push(add({ cat: c, sub: s, isSub: true }, mine.filter((r) => r.sub === s).reduce(add, {})));
    }
  }
  return out;
}

/**
 * The given rounds' questions in one category (and subcategory, when
 * given; every categorized question when `cat` is empty), for
 * buzzpoints by category: {tossups: [{round, cat, sub, tossup,
 * buzzes}], bonuses: [{round, cat, sub, bonus, results}]}, oldest round
 * first. `tossupsOf(round)` / `bonusesOf(round)` are buzz.js
 * roundTossupBuzzes / roundBonuses bound to the entries.
 */
export function categoryQuestions(catmap, rounds, cat, sub, tossupsOf, bonusesOf) {
  const hit = (info) => info && (!cat || info.cat === cat) && (!sub || info.sub === sub);
  const tossups = [];
  const bonuses = [];
  for (const round of [...rounds].sort((x, y) => x - y)) {
    const cats = roundCats(catmap, round);
    if (!cats) continue;
    for (const t of tossupsOf(round)) {
      const info = catInfo(cats.t, t.tossup);
      if (hit(info)) tossups.push({ round, ...info, ...t });
    }
    for (const bn of bonusesOf(round)) {
      const info = catInfo(cats.b, bn.bonus);
      if (hit(info)) bonuses.push({ round, ...info, ...bn });
    }
  }
  return { tossups, bonuses };
}
