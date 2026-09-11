// protests.js — protests as the TD sees them.
//
// MODAQ logs a protest in the game state (team, question, buzz word,
// answer given, free-text reason) and repeats it as free text in the
// match qbj's `notes`. Three pieces make that visible on the hub:
//
//   protestReport — the reader turns the persisted game state into a
//     structured list at upload, with the score swing computed the way
//     MODAQ's own protestSwings does it (its Tossup class supplies the
//     points at the buzz word under the game format's power tiers). It
//     rides in the .qbtd.json as `protests` and the Worker stores it on
//     the file row (`files.summary`, with the teams and final score).
//     A bare .qbj upload has only the notes; the Worker parses those
//     instead (no swing — the buzz position isn't in the note).
//   protestRows — the hub joins the summaries with the TD's rulings
//     (tournaments.rulings, keyed by round + team pair + question, so a
//     re-uploaded corrected game keeps its ruling).
//
// Nothing here is public: the Worker's public copies carry neither notes
// nor summaries, and rulings only ride on the admin route.
//
// No imports: the hub loads this unbundled. The one MODAQ dependency —
// its Tossup class, for the points at a buzz word — is passed in by the
// reader (bundled with MODAQ) and by the tests.

export const RULINGS = [
  ['open', 'Open'], ['upheld', 'Upheld'], ['denied', 'Denied'], ['withdrawn', 'Withdrawn'],
];
export const rulingLabel = (r) => (RULINGS.find(([v]) => v === r) || [r, r])[1];

/* ---------- the reader's report (from MODAQ's persisted game) ---------- */

/** MODAQ's team order: first appearance in the player list. */
function teamNamesOf(game) {
  const names = [];
  for (const p of game.players || []) {
    if (p && typeof p.teamName === 'string' && !names.includes(p.teamName)) names.push(p.teamName);
  }
  return names;
}

/** Older MODAQ versions persisted wrong buzzes and bonus answers in other
    shapes; fold them the way MODAQ's Cycle constructor does. */
function normCycle(c) {
  if (!c || typeof c !== 'object') return { wrongBuzzes: [] };
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const wrongBuzzes = [...list(c.wrongBuzzes), ...list(c.noPenaltyBuzzes), ...list(c.negBuzz)]
    .filter((b) => b && b.marker && b.marker.player);
  let bonusAnswer = c.bonusAnswer || null;
  if (bonusAnswer && !Array.isArray(bonusAnswer.parts) && Array.isArray(bonusAnswer.correctParts)) {
    const n = Math.max(3, ...bonusAnswer.correctParts.map((p) => p.index + 1));
    const parts = Array.from({ length: n }, () => ({ teamName: '', points: 0 }));
    for (const p of bonusAnswer.correctParts) {
      parts[p.index] = { teamName: bonusAnswer.receivingTeamName, points: p.points };
    }
    bonusAnswer = { ...bonusAnswer, parts };
  }
  const correctBuzz = c.correctBuzz && c.correctBuzz.marker && c.correctBuzz.marker.player
    ? c.correctBuzz : null;
  return { ...c, wrongBuzzes, bonusAnswer, correctBuzz };
}

/** Which bonus a cycle awards (MODAQ's GameState.getBonusIndex). */
function bonusIndexAt(format, cycles, bonusCount, cycleIndex) {
  const thrown = (c) => (Array.isArray(c.thrownOutBonuses) ? c.thrownOutBonuses.length : 0);
  if (format.pairTossupsBonuses) {
    let n = 0;
    for (let i = 0; i <= cycleIndex; i++) n += thrown(cycles[i]);
    const index = cycleIndex + n;
    return index >= bonusCount ? -1 : index;
  }
  let used = 0;
  for (let i = 0; i <= cycleIndex; i++) {
    if (cycles[i].correctBuzz && i < cycleIndex) used++;
    used += thrown(cycles[i]);
  }
  return used >= bonusCount ? -1 : used;
}

const bonusValue = (b) => (Array.isArray(b && b.parts) ? b.parts : [])
  .reduce((sum, p) => sum + (Number(p && p.value) || 0), 0);

function usableFormat(f) {
  return f && typeof f === 'object' && Array.isArray(f.powers) && typeof f.negValue === 'number'
    ? f : null;
}

/**
 * Every protest in a MODAQ game, with the swing an upheld ruling would
 * produce — the same arithmetic as MODAQ's protestSwings, per protest:
 * the protester gets its neg back, the tossup at its buzz word (power
 * tiers per the format, super-powers included) and the whole bonus; a
 * team that converted the tossup instead loses its tossup points and the
 * bonus points it earned. A bonus-part protest moves that part's value.
 *
 * @param store MODAQ's persisted AppState (or its `game`), as JSON
 * @param fallbackFormat the reader's game format, when the store has none
 * @param Tossup MODAQ's Tossup class (modaq/src/state/PacketState.js):
 *   `new Tossup(question, answer, metadata).getPointsAtPosition(format,
 *   wordIndex, isCorrect)` is what puts the power tiers on a buzz word
 * @returns [{kind:'tu'|'b', q, part?, team, word?, given, reason,
 *   to, from, gain, loss, detail}] — `to` gains `gain`, `from` loses
 *   `loss` (MODAQ can put the gain on the other team when the protested
 *   buzz was the protester's own correct one; the row says so).
 */
export function protestReport(store, fallbackFormat, Tossup) {
  const game = store && store.game && Array.isArray(store.game.cycles) ? store.game : store;
  if (!game || !Array.isArray(game.cycles) || !game.packet || typeof Tossup !== 'function') return [];
  const format = usableFormat(game.gameFormat) || usableFormat(fallbackFormat);
  if (!format) return [];
  const tossups = (Array.isArray(game.packet.tossups) ? game.packet.tossups : []).map((t) =>
    (t && typeof t.question === 'string' ? new Tossup(t.question, String(t.answer || ''), t.metadata) : null));
  const bonuses = Array.isArray(game.packet.bonuses) ? game.packet.bonuses : [];
  const names = teamNamesOf(game);
  const cycles = game.cycles.map(normCycle);
  const idx = (name) => (name === names[0] ? 0 : 1);
  const str = (s) => (typeof s === 'string' ? s : '');
  const out = [];

  cycles.forEach((s, ci) => {
    for (const u of Array.isArray(s.tossupProtests) ? s.tossupProtests : []) {
      if (!u || !Number.isInteger(u.questionIndex) || !Number.isInteger(u.position)) continue;
      const l = tossups[u.questionIndex];
      if (!l) continue;
      let d = idx(u.teamName);
      let c = true;
      let gain = 0;
      let loss = 0;
      const detail = {};
      if (s.correctBuzz) {
        const ct = s.correctBuzz.marker.player.teamName;
        if (s.correctBuzz.tossupIndex === u.questionIndex && ct === u.teamName) d = 1 - d;
        c = !s.wrongBuzzes.some((v) => v.marker.player.teamName !== u.teamName);
        const tu = l.getPointsAtPosition(format, u.position, true);
        const bonus = ((s.bonusAnswer && s.bonusAnswer.parts) || []).reduce((sum, g) =>
          sum + (g && g.teamName === ct ? Number(g.points) || 0 : -(Number(g && g.points) || 0)), 0);
        loss = tu + bonus;
        detail.oppTu = tu;
        detail.oppBonus = bonus;
      }
      if (c) {
        const bi = bonusIndexAt(format, cycles, bonuses.length, ci);
        const bonus = bi >= 0 ? bonusValue(bonuses[bi]) : 0;
        const tu = l.getPointsAtPosition(format, u.position, true);
        const neg = 0 - l.getPointsAtPosition(format, u.position, false); // 0 - 0, never -0
        gain = tu + neg + bonus;
        Object.assign(detail, { tu, neg, bonus });
      }
      out.push({
        kind: 'tu', q: u.questionIndex + 1, team: str(u.teamName), word: u.position + 1,
        given: str(u.givenAnswer), reason: str(u.reason),
        to: names[d] ?? '', from: names[1 - d] ?? '', gain, loss, detail,
      });
    }
    if (Array.isArray(s.bonusProtests) && s.correctBuzz) {
      const ct = s.correctBuzz.marker.player.teamName;
      const other = names[1 - idx(ct)] ?? '';
      for (const l of s.bonusProtests) {
        if (!l || !Number.isInteger(l.questionIndex) || !Number.isInteger(l.partIndex)) continue;
        const b = bonuses[l.questionIndex];
        const part = b && Array.isArray(b.parts) ? b.parts[l.partIndex] : null;
        if (!part) continue;
        const v = Number(part.value) || 0;
        const base = {
          kind: 'b', q: l.questionIndex + 1, part: l.partIndex + 1, team: str(l.teamName),
          given: str(l.givenAnswer), reason: str(l.reason), detail: { part: v },
        };
        // MODAQ scores a bounceback protest as the receiving team losing
        // the part rather than the protester gaining it; mirrored as-is.
        if (l.teamName === ct) out.push({ ...base, to: ct, from: other, gain: v, loss: 0 });
        else out.push({ ...base, to: str(l.teamName), from: ct, gain: 0, loss: v });
      }
    }
  });
  return out;
}

/**
 * The fallback for a bare .qbj: MODAQ's two note templates (qbj/QBJ.js).
 * The Worker carries its own copy (worker.js protestsFromNotes); this one
 * serves the demo and the unit tests. No swing — the note has no buzz
 * position.
 */
export function protestsFromNotes(notes) {
  if (typeof notes !== 'string' || !notes) return [];
  const out = [];
  const tu = /Tossup protest on tossup #(\d+)\. Team "(.*?)" protested because of this reason: "([\s\S]*?)"\.(?=\n|$)/g;
  const bo = /Bonus protest on bonus #(\d+)\. Team "(.*?)" protested part (\d+) because of this reason: "([\s\S]*?)"\.(?=\n|$)/g;
  let m;
  while ((m = tu.exec(notes))) {
    out.push({ kind: 'tu', q: Number(m[1]), team: m[2], given: '', reason: m[3] });
  }
  while ((m = bo.exec(notes))) {
    out.push({ kind: 'b', q: Number(m[1]), part: Number(m[3]), team: m[2], given: '', reason: m[4] });
  }
  return out.sort((x, y) => x.q - y.q);
}

/* ---------- the hub's view ---------- */

export function qKey(p) { return p.kind === 'tu' ? `tu${p.q}` : `b${p.q}.${p.part}`; }
export function qLabel(p) { return p.kind === 'tu' ? `TU ${p.q}` : `B ${p.q}, part ${p.part}`; }

/** Ruling map key: round + question + team pair, so a corrected re-upload
    of the same game keeps its ruling and a superseded upload can't
    carry a stale one. */
export function rulingKey(round, teams, p) {
  return [round, qKey(p), ...[...teams].sort()].map(encodeURIComponent).join('/');
}

/** A file row's summary — the Worker stores it as JSON text. */
export function fileSummary(f) {
  let s = f && f.summary;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { return null; } }
  if (!s || !Array.isArray(s.teams) || s.teams.length !== 2 || !Array.isArray(s.score)) return null;
  return {
    teams: s.teams.map(String),
    score: [Number(s.score[0]) || 0, Number(s.score[1]) || 0],
    protests: Array.isArray(s.protests) ? s.protests.filter((p) => p && typeof p === 'object') : [],
  };
}

/** The score if the protest is upheld, and whether that changes the
    result (MODAQ's protestsMatter: in a tied game every protest does). */
export function projectUpheld(summary, p) {
  const score = [...summary.score];
  const i = summary.teams.indexOf(p.to);
  const j = summary.teams.indexOf(p.from);
  const gain = Number(p.gain) || 0;
  const loss = Number(p.loss) || 0;
  if (i >= 0) score[i] += gain;
  if (j >= 0) score[j] -= loss;
  const before = Math.sign(summary.score[0] - summary.score[1]);
  const after = Math.sign(score[0] - score[1]);
  const known = p.gain != null || p.loss != null;
  return { score, known, flips: known && (before === 0 ? gain > 0 || loss > 0 : after !== before) };
}

/**
 * The drawer's rows: every protest in the newest upload of each game
 * (round + team pair — the rule stats use), joined with the rulings.
 * @param files admin file rows (with `summary`)
 * @param rulings {key: {r, note, at}}
 * @param roomOf bucket_id -> room name
 * @returns {rows, byFile} — byFile: file id -> {n, open, superseded}
 */
export function protestRows(files, rulings, roomOf) {
  const latest = new Map();
  const sums = new Map();
  for (const f of files) {
    if (!f || f.error || (f.kind !== 'qbj' && f.kind !== 'combined')) continue;
    const s = fileSummary(f);
    if (!s) continue;
    sums.set(f.id, s);
    const k = f.round + '\n' + [...s.teams].sort().join('\n');
    const prev = latest.get(k);
    if (!prev || f.id > prev.id) latest.set(k, f);
  }
  const current = new Set([...latest.values()].map((f) => f.id));
  const rows = [];
  const byFile = new Map();
  for (const [id, s] of sums) {
    if (!s.protests.length) continue;
    const f = files.find((x) => x.id === id);
    const state = { n: s.protests.length, open: 0, superseded: !current.has(id) };
    byFile.set(id, state);
    s.protests.forEach((p, i) => {
      const key = rulingKey(f.round, s.teams, p);
      const r = (rulings && rulings[key]) || null;
      const ruling = r && RULINGS.some(([v]) => v === r.r) ? r.r : 'open';
      // A superseded upload's protests are history: the newest upload is
      // the game now. Its ruled ones stay listed (greyed, with the score
      // the ruling was made on) so a corrected game doesn't erase the
      // record of the ruling; its unruled ones are simply gone.
      if (state.superseded && !r) return;
      if (ruling === 'open' && !state.superseded) state.open++;
      const w = projectUpheld(s, p);
      rows.push({
        id: `${id}:${i}`, file: f, round: f.round, room: roomOf(f.bucket_id),
        teams: s.teams, score: s.score, p, key,
        ruling, note: r && typeof r.note === 'string' ? r.note : '',
        at: r && Number.isFinite(r.at) ? r.at : 0,
        upheld: w.score, known: w.known, flips: w.flips,
        superseded: state.superseded,
        // a newer upload of this game landed after the ruling
        corrected: state.superseded || !!(r && Number.isFinite(r.at) && f.created > r.at),
      });
    });
  }
  const rank = (x) => (x.superseded ? 2 : x.ruling === 'open' ? 0 : 1);
  rows.sort((x, y) => rank(x) - rank(y)
    || y.round - x.round || x.file.id - y.file.id || x.p.q - y.p.q);
  return { rows, byFile };
}

/** Human text for a row's swing, in the hub's wording. */
export function swingLines(row) {
  const p = row.p;
  const d = p.detail || {};
  if (!row.known) return ['Swing unknown: uploaded as a bare qbj, so the buzz position is missing'];
  if (p.kind === 'b') {
    return [p.gain
      ? `+${p.gain} ${p.to}: bonus part`
      : `−${p.loss} ${p.from}: bonus part`];
  }
  const lines = [];
  if (p.gain || d.tu != null) {
    lines.push(`+${p.gain} ${p.to}: ${d.neg || 0} neg back, ${d.tu || 0} tossup, ${d.bonus || 0} bonus`);
  }
  if (p.loss || d.oppTu != null) {
    lines.push(`−${p.loss} ${p.from}: ${d.oppTu || 0} tossup, ${d.oppBonus || 0} bonus`);
  }
  return lines;
}
