// setstats.js — set-wide views over every mirror of a question set
// (worker.js "question sets"). Everything here is the per-tournament
// engine run once per site and then put side by side, never one run over
// the pooled games: a team name means something only inside its own
// mirror ("Team A" plays at three sites), and so does the re-upload rule
// that keeps the latest file per round + team pair.
//
// A site is {id, label, vmap, done, matches, entries}:
//   vmap    round -> [packet, version] of the set packet that mirror ran
//           there (null: the TD's own packet, whose questions the set
//           knows nothing about). Which round reads which packet is each
//           TD's choice, so nothing set-wide is ever keyed by round.
//   done    rounds every room there has turned in
//   matches parseMatch output; entries the raw {id, round, room, qbj}
//           rows, deduped — the buzz- and category-based views read those

import { parseMatch } from './qbj.js';
import { aggregate } from './stats.js';
import { dedupeEntries, matchBuzzes, matchBonuses, buzzSummary } from './buzz.js';
import { categoryStats, categoryTeamStats, catPlayerLines, catTeamLines, roundCats, catInfo,
  catCompare } from './cats.js';

/** One mirror's state entry + its round shards' entries -> a site. */
export function buildSite(mirror, shardEntries, errors = []) {
  const matches = [];
  const raw = [];
  for (const entry of shardEntries) {
    try {
      const m = parseMatch(entry.qbj, { filename: entry.filename });
      m.room = entry.room;
      m.fileId = entry.id;
      matches.push(m);
      raw.push({ id: entry.id, round: m.round, room: entry.room, qbj: entry.qbj });
    } catch (e) { errors.push(mirror.label + ' · ' + entry.filename + ': ' + e.message); }
  }
  return {
    id: mirror.id, label: mirror.label, vmap: mirror.vmap || {}, done: mirror.done || [],
    matches, entries: dedupeEntries(raw),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Standings and individuals across sites, each row tagged with its site,
 * plus one summary line per site. Teams and players are ranked by
 * PP20TUH: W-L is carried for reading, but a record earned against a
 * different field is no basis for ordering sites against each other.
 * @returns {values, teams, players, sites}
 */
export function setStandings(sites) {
  const values = new Set();
  const teams = [];
  const players = [];
  const summary = [];
  for (const site of sites) {
    const agg = aggregate(site.matches);
    for (const v of agg.values) values.add(v);
    for (const t of agg.teams) teams.push({ ...t, site: site.label });
    for (const p of agg.players) players.push({ ...p, site: site.label });
    const sum = (f) => agg.teams.reduce((n, t) => n + f(t), 0);
    const tuh = sum((t) => t.tuh);
    const heard = sum((t) => t.bonusesHeard);
    summary.push({
      id: site.id, label: site.label, teams: agg.teams.length, games: agg.games.length,
      pp20tuh: tuh ? round2((sum((t) => t.points) / tuh) * 20) : 0,
      ppb: heard ? round2(sum((t) => t.bonusPoints) / heard) : 0,
    });
  }
  teams.sort((x, y) => y.pp20tuh - x.pp20tuh || x.name.localeCompare(y.name));
  players.sort((x, y) => y.pp20tuh - x.pp20tuh || x.name.localeCompare(y.name));
  return { values: [...values].sort((x, y) => y - x), teams, players, sites: summary };
}

// The category map one site actually played: the set's map is keyed by
// packet and version, a tournament's by round alone.
function siteCatmap(site, setCatmap) {
  const rounds = {};
  for (const [n, pv] of Object.entries(site.vmap)) {
    if (!Array.isArray(pv)) continue;
    const e = setCatmap && setCatmap.packets && setCatmap.packets[pv[0]] && setCatmap.packets[pv[0]][pv[1]];
    if (e && (Array.isArray(e.t) || Array.isArray(e.b))) rounds[n] = { t: e.t || [], b: e.b || [] };
  }
  return { rounds };
}

/**
 * Category slices across sites. `players` / `teams` are cats.js rows
 * tagged with their site (filter them with setCatLines below);
 * `questions` is the editors' half — how each (category, subcategory)
 * played, per tossup heard and bonus heard, over every site:
 * [{cat, sub, heard, powers, gets, negs, dead, bh, bpts}].
 */
export function setCategories(sites, setCatmap) {
  const players = [];
  const teams = [];
  const slices = new Map();
  const slice = (info) => {
    const key = JSON.stringify([info.cat, info.sub]);
    if (!slices.has(key)) {
      slices.set(key, { cat: info.cat, sub: info.sub, heard: 0, powers: 0, gets: 0, negs: 0, dead: 0, bh: 0, bpts: 0 });
    }
    return slices.get(key);
  };
  for (const site of sites) {
    const catmap = siteCatmap(site, setCatmap);
    for (const r of categoryStats(site.entries, catmap)) players.push({ ...r, site: site.label, siteId: site.id });
    for (const r of categoryTeamStats(site.entries, catmap)) teams.push({ ...r, site: site.label, siteId: site.id });
    for (const e of site.entries) {
      const cats = roundCats(catmap, e.round);
      if (!cats) continue;
      for (const { tossup, buzzes } of matchBuzzes(e.qbj)) {
        const info = catInfo(cats.t, tossup);
        if (!info) continue;
        const s = slice(info);
        s.heard++;
        if (buzzes.some((b) => b.value > 10)) s.powers++;
        else if (buzzes.some((b) => b.value > 0)) s.gets++;
        else s.dead++;
        s.negs += buzzes.filter((b) => b.value < 0).length;
      }
      for (const bn of matchBonuses(e.qbj)) {
        const info = bn.team ? catInfo(cats.b, bn.bonus) : null;
        if (!info) continue;
        const s = slice(info);
        s.bh++;
        s.bpts += bn.total;
      }
    }
  }
  return { players, teams, questions: [...slices.values()] };
}

/**
 * Filtered per-player or per-team lines over site-tagged rows: the
 * cats.js aggregation run per site (so equal names at two sites stay two
 * lines), merged and re-sorted the way each of those sorts on its own.
 * Sites are told apart by mirror id — two mirrors may share a label.
 */
export function setCatLines(rows, cat, sub, kind) {
  const bySite = new Map();
  for (const r of rows) {
    if (!bySite.has(r.siteId)) bySite.set(r.siteId, []);
    bySite.get(r.siteId).push(r);
  }
  const lines = [];
  for (const list of bySite.values()) {
    const own = kind === 'team' ? catTeamLines(list, cat, sub) : catPlayerLines(list, cat, sub);
    for (const l of own) lines.push({ ...l, site: list[0].site });
  }
  return kind === 'team'
    ? lines.sort((a, b) => (b.pts + b.bpts) - (a.pts + a.bpts) || (b.ppb ?? -1) - (a.ppb ?? -1))
    : lines.sort((a, b) => b.pts - a.pts || (b.powers + b.gets) - (a.powers + a.gets));
}

/**
 * The editors' table: `questions` rolled up by category, or — with a
 * category picked — by its subcategories. Rates are over tossups heard.
 */
export function setQuestionLines(questions, cat) {
  const out = new Map();
  for (const q of questions) {
    if (cat && q.cat !== cat) continue;
    const name = cat ? (q.sub || '(none)') : q.cat;
    if (!out.has(name)) out.set(name, { name, heard: 0, powers: 0, gets: 0, negs: 0, dead: 0, bh: 0, bpts: 0 });
    const l = out.get(name);
    for (const k of ['heard', 'powers', 'gets', 'negs', 'dead', 'bh', 'bpts']) l[k] += q[k];
  }
  return [...out.values()]
    .map((l) => ({ ...l, ppb: l.bh ? l.bpts / l.bh : null }))
    .sort((a, b) => cat ? b.heard - a.heard : catCompare(a.name, b.name));
}

/* ---------- buzzpoints: by question, not by round ----------
   A set's unit is the question. Which round a site read a packet in is
   its TD's choice, packets get fixed mid-season, and questions move
   between packets — so plays are gathered per question identity, from
   the question map each packet version carries (qmatch.js; it rides in
   the category map as packets[p][v].q):

     ident  'q<id>' for a mapped question — the same wherever and however
            it was read — or 'u<packet>.<version>.<kind><pos>' for a
            position in a version nobody has matched, which can only ever
            be itself
     rev    the wording. Buzz word indices are comparable inside one rev
            and nowhere else, so plays are grouped by it and each group
            is drawn over its own text. */

const qmapOf = (catmap, p, v) => {
  const e = catmap && catmap.packets && catmap.packets[p] && catmap.packets[p][v];
  return (e && e.q) || null;
};

function identOf(catmap, p, v, kind, pos) {
  const q = qmapOf(catmap, p, v);
  const e = q && Array.isArray(q[kind]) ? q[kind][pos - 1] : null;
  return e ? { ident: 'q' + e[0], rev: e[1] } : { ident: `u${p}.${v}.${kind}${pos}`, rev: 1 };
}

/**
 * Every finished play of every question: Map ident -> {kind, revs: Map
 * rev -> group}, group = {rev, heard, buzzes, results, homes}. A round
 * still being played at a site is left out whole (the rule that hides a
 * tournament's round until every room is in), and so is a round read
 * from a TD's own packet. `room` reads "site · room"; homes lists where
 * that wording was read — [{p, v, pos, games}] — which is also where its
 * text can be fetched from.
 */
export function setQuestionPlays(sites, catmap) {
  const index = new Map();
  const groupFor = (kind, p, v, pos) => {
    const { ident, rev } = identOf(catmap, p, v, kind, pos);
    if (!index.has(ident)) index.set(ident, { kind, revs: new Map() });
    const revs = index.get(ident).revs;
    if (!revs.has(rev)) revs.set(rev, { rev, heard: 0, buzzes: [], results: [], homes: [] });
    const g = revs.get(rev);
    let home = g.homes.find((h) => h.p === p && h.v === v && h.pos === pos);
    if (!home) { home = { p, v, pos, games: 0 }; g.homes.push(home); }
    home.games++;
    g.heard++;
    return g;
  };
  for (const s of sites) {
    for (const round of s.done) {
      const pv = s.vmap[round];
      if (!Array.isArray(pv)) continue;
      const [p, v] = pv;
      for (const e of s.entries) {
        if (e.round !== round) continue;
        const room = e.room ? s.label + ' · ' + e.room : s.label;
        for (const { tossup, buzzes } of matchBuzzes(e.qbj)) {
          const g = groupFor('t', p, v, tossup);
          for (const b of buzzes) g.buzzes.push({ ...b, room });
        }
        for (const bn of matchBonuses(e.qbj)) {
          groupFor('b', p, v, bn.bonus).results.push({ ...bn, room });
        }
      }
    }
  }
  for (const { revs } of index.values()) {
    for (const g of revs.values()) g.buzzes.sort((x, y) => x.position - y.position);
  }
  return index;
}

// idents that sit in the set's current packets ({packet: version})
function currentIdents(index, catmap, current) {
  const out = new Set();
  for (const [p, v] of Object.entries(current || {})) {
    const q = qmapOf(catmap, p, v);
    if (q) {
      for (const kind of ['t', 'b']) for (const e of q[kind] || []) if (e) out.add('q' + e[0]);
    }
    // unmatched positions (and whole unmatched versions) are their own idents
    for (const ident of index.keys()) if (ident.startsWith(`u${p}.${v}.`)) out.add(ident);
  }
  return out;
}

/**
 * What the buzzpoints tab offers: `packets`, the current packets some
 * question of which has been played (in any version, anywhere), and
 * `earlier`, the [packet, version] pairs holding plays of questions that
 * are in no current packet any more — dropped from the set, or read from
 * a version nobody has matched.
 */
export function setBuzzNav(index, catmap, current) {
  const here = currentIdents(index, catmap, current);
  const packets = [];
  for (const [p, v] of Object.entries(current || {})) {
    if (setPacketRows(index, catmap, Number(p), v).some((r) => r.heard)) packets.push(Number(p));
  }
  const earlier = new Map();
  for (const [ident, { revs }] of index) {
    if (here.has(ident)) continue;
    for (const g of revs.values()) for (const h of g.homes) earlier.set(h.p + '.' + h.v, [h.p, h.v]);
  }
  return {
    packets: packets.sort((a, b) => a - b),
    earlier: [...earlier.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  };
}

/**
 * One packet version, question by question, in reading order (tossup N,
 * then bonus N): [{kind, pos, ident, rev, heard, same, others}].
 *   same    the plays on THIS wording — wherever it was read, so a
 *           question that moved here unedited brings its plays along
 *   others  plays of the same question on other wordings, newest first
 *   heard   all of them together: a question's conversion is one number
 * `orphansOnly` (a Set of current idents) keeps just the questions that
 * are in no current packet: the view of an earlier version.
 */
export function setPacketRows(index, catmap, p, v, orphansOnly = null) {
  const q = qmapOf(catmap, p, v);
  const rows = [];
  for (const kind of ['t', 'b']) {
    const positions = new Set();
    ((q && q[kind]) || []).forEach((e, i) => { if (e) positions.add(i + 1); });
    for (const { kind: k, revs } of index.values()) {
      if (k !== kind) continue;
      for (const g of revs.values()) for (const h of g.homes) if (h.p === p && h.v === v) positions.add(h.pos);
    }
    for (const pos of positions) {
      const { ident, rev } = identOf(catmap, p, v, kind, pos);
      if (orphansOnly && orphansOnly.has(ident)) continue;
      const groups = index.has(ident) ? [...index.get(ident).revs.values()] : [];
      rows.push({
        kind, pos, ident, rev,
        heard: groups.reduce((n, g) => n + g.heard, 0),
        same: groups.find((g) => g.rev === rev) || null,
        others: groups.filter((g) => g.rev !== rev).sort((x, y) => y.rev - x.rev),
      });
    }
  }
  return rows.sort((x, y) => x.pos - y.pos || (x.kind === 't' ? -1 : 1));
}

/* ---------- per-question and bonus-difficulty statistics ----------
   The editors' tables: every tossup and bonus of the set as one line,
   pooled over every site and wording that heard it, with the category
   it carries where it currently sits (or where it was last read). Bonus
   parts are ranked by how they actually converted — "easiest" is the
   part most rooms got, wherever the writers put it — because nothing in
   a packet says which part was meant to be easy. */

// the category a question carries: at its home in a current packet
// version when it has one, else at the first place it was read
function questionCat(catmap, homes, current, kind) {
  const pick = homes.find((h) => (current || {})[h.p] === h.v) || homes[0];
  if (!pick) return { cat: '', sub: '' };
  const cats = catmap && catmap.packets && catmap.packets[pick.p] && catmap.packets[pick.p][pick.v];
  const info = cats && Array.isArray(cats[kind]) ? cats[kind][pick.pos - 1] : null;
  return { cat: info && typeof info.c === 'string' ? info.c : '', sub: info && typeof info.s === 'string' ? info.s : '', home: pick };
}

/**
 * Every question with plays, one row each, from setQuestionPlays:
 *   tossups [{ident, home, cat, sub, heard, powers, gets, negs, dead,
 *             avgWord (on its most-heard wording), wordings}]
 *   bonuses [{ident, home, cat, sub, heard, pts, ppb, dist: [0, 10, 20,
 *             30 counts], ranked: [part conversion counts, easiest first]}]
 */
export function setQuestionTable(index, catmap, current) {
  const tossups = [];
  const bonuses = [];
  for (const [ident, { kind, revs }] of index) {
    const groups = [...revs.values()];
    const homes = groups.flatMap((g) => g.homes);
    const { cat, sub, home } = questionCat(catmap, homes, current, kind);
    const heard = groups.reduce((n, g) => n + g.heard, 0);
    if (kind === 't') {
      const buzzes = groups.flatMap((g) => g.buzzes);
      const main = groups.sort((a, b) => b.heard - a.heard)[0];
      const right = main.buzzes.filter((b) => b.value > 0);
      const gets = buzzes.filter((b) => b.value > 0).length;
      tossups.push({
        ident, home, cat, sub, heard,
        powers: buzzes.filter((b) => b.value > 10).length, gets,
        negs: buzzes.filter((b) => b.value < 0).length, dead: heard - gets,
        avgWord: right.length ? right.reduce((n, b) => n + b.position, 0) / right.length + 1 : null,
        wordings: groups.length,
      });
    } else {
      const results = groups.flatMap((g) => g.results);
      const nParts = Math.max(0, ...results.map((r) => r.parts.length));
      const conv = [];
      for (let i = 0; i < nParts; i++) conv.push(results.filter((r) => r.parts[i] > 0).length);
      const dist = [0, 0, 0, 0];
      for (const r of results) dist[Math.min(3, Math.max(0, Math.round(r.total / 10)))]++;
      const pts = results.reduce((n, r) => n + r.total, 0);
      bonuses.push({
        ident, home, cat, sub, heard: results.length, pts,
        ppb: results.length ? pts / results.length : null, dist,
        ranked: [...conv].sort((a, b) => b - a),
      });
    }
  }
  tossups.sort((a, b) => (a.home ? a.home.p - b.home.p || a.home.pos - b.home.pos : 0));
  bonuses.sort((a, b) => (a.home ? a.home.p - b.home.p || a.home.pos - b.home.pos : 0));
  return { tossups, bonuses };
}

/**
 * Bonus rows rolled up by category (or, with `cat`, by its
 * subcategories): [{name, bonuses, heard, ppb, dist, easy, mid, hard}] —
 * easy/mid/hard are conversion rates of each bonus's easiest, middle and
 * hardest part as they actually converted, pooled over the rows.
 */
export function setBonusLines(rows, cat) {
  const out = new Map();
  for (const r of rows) {
    if (cat && r.cat !== cat) continue;
    if (!r.cat) continue;
    const name = cat ? (r.sub || '(none)') : r.cat;
    if (!out.has(name)) out.set(name, { name, bonuses: 0, heard: 0, pts: 0, dist: [0, 0, 0, 0], got: [0, 0, 0] });
    const l = out.get(name);
    l.bonuses++;
    l.heard += r.heard;
    l.pts += r.pts;
    r.dist.forEach((n, i) => { l.dist[i] += n; });
    r.ranked.slice(0, 3).forEach((n, i) => { l.got[i] += n; });
  }
  return [...out.values()]
    .map(({ got, ...l }) => ({
      ...l, ppb: l.heard ? l.pts / l.heard : null,
      easy: l.heard ? got[0] / l.heard : null, mid: l.heard ? got[1] / l.heard : null, hard: l.heard ? got[2] / l.heard : null,
    }))
    .sort((a, b) => cat ? b.heard - a.heard : catCompare(a.name, b.name));
}

/** setPacketRows for an earlier version: only what no current packet holds. */
export function setEarlierRows(index, catmap, current, p, v) {
  return setPacketRows(index, catmap, p, v, currentIdents(index, catmap, current));
}

/** Per-player buzz summary over every finished set round, site-tagged. */
export function setBuzzSummary(sites) {
  const rows = [];
  for (const s of sites) {
    const entries = s.entries.filter((e) => s.done.includes(e.round) && Array.isArray(s.vmap[e.round]));
    for (const r of buzzSummary(entries)) rows.push({ ...r, site: s.label });
  }
  return rows.sort((a, b) => b.correct - a.correct || (a.avg ?? 1e9) - (b.avg ?? 1e9));
}
