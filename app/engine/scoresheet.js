// scoresheet.js — one game's tossup-by-tossup scoresheet from its MODAQ
// match qbj: a row per tossup read, a column per player, each team's
// bonus parts, the category the packet gives that tossup, and the score
// after it. Substitutions come from the qbj lineups (each one is the
// whole set of players in from its first_question on).
//
// The public Scoreboard draws it (pubview.js) behind the stats password,
// once its round has finished, the same rule as buzzpoints.

import { unwrapMatch } from './buzz.js';

// One label per subcategory, short enough for a narrow column: multiword
// ones by their initials, one-word ones by their usual short form.
// Ancient History is AnH so it stays apart from American History (AH).
const SUB_SHORT = {
  'American Literature': 'AL', 'British Literature': 'BL', 'European Literature': 'EL',
  'World Literature': 'WL', 'Other Literature': 'OL',
  'American History': 'AH', 'Ancient History': 'AnH', 'European History': 'EH',
  'World History': 'WH', 'Other History': 'OH',
  'Visual Fine Arts': 'VFA', 'Auditory Fine Arts': 'AFA', 'Other Fine Arts': 'OFA',
  Biology: 'Bio', Chemistry: 'Chem', Physics: 'Phys', Math: 'Math', 'Other Science': 'OSci',
  Economics: 'Econ',
};
const CAT_SHORT = {
  Literature: 'Lit', History: 'Hist', Science: 'Sci', 'Fine Arts': 'FA', Religion: 'Rel',
  Mythology: 'Myth', Philosophy: 'Phil', 'Social Science': 'SS', Beliefs: 'Bel', Geography: 'Geo',
  'Current Events': 'CE', 'Other Academic': 'OA', Trash: 'Pop', RMPSS: 'RMP',
};
// the color family a category belongs to; RMPSS and its parts share one
const FAMILY = {
  Science: 'sci', Literature: 'lit', History: 'hist', 'Fine Arts': 'fa', RMPSS: 'rmp',
  Religion: 'rmp', Mythology: 'rmp', Philosophy: 'rmp', 'Social Science': 'rmp', Beliefs: 'rmp',
};

/** {label, family, title} for a catmap entry ({c, s}), or null. A label
    the tables don't know is cut to four characters, so it fits. */
export function catTag(cat) {
  if (!cat || typeof cat.c !== 'string' || !cat.c) return null;
  const c = cat.c;
  const s = typeof cat.s === 'string' && cat.s !== c ? cat.s : '';
  const label = SUB_SHORT[s] || CAT_SHORT[c] || (s || c).slice(0, 4);
  return { label, family: FAMILY[c] || 'oth', title: s ? c + ' · ' + s : c };
}

/** Initials unique within one team: two players with the same initials
    both take more of the last name (Evan Shah, Emma Stone -> ESh, ESt);
    a full tie takes a number. */
export function teamInitials(names) {
  const parts = names.map((n) => String(n).trim().split(/\s+/).filter(Boolean));
  const tag = (p, k) => (p.length > 1
    ? p.slice(0, -1).map((w) => w[0]).join('') + p[p.length - 1].slice(0, k)
    : (p[0] || '?').slice(0, k + 1));
  const out = new Map();
  names.forEach((name, i) => {
    const clash = (k) => parts.some((q, j) => j !== i && tag(q, k) === tag(parts[i], k));
    let k = 1;
    while (k < 6 && clash(k)) k++;
    let t = tag(parts[i], k);
    if (clash(k)) t += parts.slice(0, i + 1).filter((q) => tag(q, k) === tag(parts[i], k)).length;
    out.set(name, t);
  });
  return out;
}

const nameOf = (x) => (x && typeof x.name === 'string' ? x.name.trim() : '');

/**
 * The scoresheet for one match qbj.
 *   cats: that round's catmap tossup list (catmap.rounds[n].t), or null
 *   regTossups: the format's regulation tossup count; later cycles are OT
 * Returns null when the qbj has no tossup-level data, else
 *   {teams: [{name, players: [{name, initials}]}],
 *    rows: [{n, ot, cat, cells: [[value|null per player] per team],
 *            bonus: [[true/false per part] | null per team],
 *            out: [[bool per player] per team], subs: [teamIndex...],
 *            score: [a, b]}],
 *    subs: [{n, team, in: [names], out: [names]}],
 *    final: [a, b]}
 * Teams are in qbj order; players in lineup order, then anyone who only
 * shows up in match_players or a buzz.
 */
export function buildScoresheet(json, cats = null, regTossups = 20) {
  const match = unwrapMatch(json);
  const questions = Array.isArray(match.match_questions) ? match.match_questions : [];
  const mts = Array.isArray(match.match_teams) ? match.match_teams : [];
  if (!questions.length || mts.length !== 2) return null;

  const teams = mts.map((mt) => {
    const name = nameOf(mt.team);
    const lineups = (Array.isArray(mt.lineups) ? mt.lineups : [])
      .map((l) => ({
        first: Number(l && l.first_question) || 1,
        players: (Array.isArray(l && l.players) ? l.players : []).map(nameOf).filter(Boolean),
      }))
      .sort((a, b) => a.first - b.first);
    const order = [];
    const add = (p) => { if (p && !order.includes(p)) order.push(p); };
    lineups.forEach((l) => l.players.forEach(add));
    (Array.isArray(mt.match_players) ? mt.match_players : []).forEach((mp) => add(nameOf(mp && mp.player)));
    return { name, lineups, order };
  });
  // a buzz by someone neither list names still gets a column
  for (const mq of questions) {
    for (const b of (Array.isArray(mq && mq.buzzes) ? mq.buzzes : [])) {
      const t = teams.find((x) => x.name === nameOf(b && b.team));
      const p = nameOf(b && b.player);
      if (t && p && !t.order.includes(p)) t.order.push(p);
    }
  }

  // who is in on cycle n: the latest lineup that starts at or before it;
  // with no lineups, everyone
  const lineupAt = (t, n) => {
    let cur = null;
    for (const l of t.lineups) if (l.first <= n) cur = l;
    return cur ? new Set(cur.players) : null;
  };

  const score = [0, 0];
  const rows = [];
  const subs = [];
  questions.forEach((mq, i) => {
    if (!mq) return;
    const n = Number(mq.question_number) || i + 1;
    const read = (mq.replacement_tossup_question && mq.replacement_tossup_question.question_number)
      ? mq.replacement_tossup_question : mq.tossup_question;
    const packetNo = (read && read.question_number) || n;
    const tiebreaker = read && typeof read.qbtd_tiebreaker === 'string' && read.qbtd_tiebreaker;
    const cat = !tiebreaker && Array.isArray(cats) ? catTag(cats[packetNo - 1]) : null;

    const cells = teams.map((t) => t.order.map(() => null));
    for (const b of (Array.isArray(mq.buzzes) ? mq.buzzes : [])) {
      const ti = teams.findIndex((x) => x.name === nameOf(b && b.team));
      const pi = ti < 0 ? -1 : teams[ti].order.indexOf(nameOf(b && b.player));
      const value = b && b.result ? Number(b.result.value) : NaN;
      if (pi < 0 || !Number.isFinite(value)) continue;
      cells[ti][pi] = value;
      score[ti] += value;
    }

    // the bonus belongs to the team with the correct buzz; a bounceback
    // scores for the other side
    const bonus = [null, null];
    const b = mq.bonus;
    const ctl = cells.findIndex((row) => row.some((v) => v !== null && v > 0));
    if (b && Array.isArray(b.parts) && b.parts.length && ctl >= 0) {
      bonus[ctl] = b.parts.map((p) => (Number(p && p.controlled_points) || 0) > 0);
      score[ctl] += b.parts.reduce((s, p) => s + (Number(p && p.controlled_points) || 0), 0);
      score[1 - ctl] += b.parts.reduce((s, p) => s + (Number(p && p.bounceback_points) || 0), 0);
    }

    const out = teams.map((t) => {
      const on = lineupAt(t, n);
      return t.order.map((p) => Boolean(on) && !on.has(p));
    });
    const changed = [];
    teams.forEach((t, ti) => {
      const l = t.lineups.find((x) => x.first === n);
      const prev = lineupAt(t, n - 1);
      if (!l || !prev || n === 1) return;
      const now = new Set(l.players);
      const ins = l.players.filter((p) => !prev.has(p));
      const outs = [...prev].filter((p) => !now.has(p));
      if (!ins.length && !outs.length) return;
      changed.push(ti);
      subs.push({ n, team: ti, in: ins, out: outs });
    });

    rows.push({ n, ot: n > regTossups, cat, cells, bonus, out, subs: changed, score: [...score] });
  });

  return {
    teams: teams.map((t) => {
      const init = teamInitials(t.order);
      return { name: t.name, players: t.order.map((p) => ({ name: p, initials: init.get(p) })) };
    }),
    rows,
    subs,
    final: [...score],
  };
}
