// deciders.js — games outside the round order (the Live Hub's Deciders
// section, the Packets step's tiebreaker rows). A decider follows a round,
// has a room and reads a packet of its own, so the rounds never move.
//
// Ties across a cut: when the prelims end with teams level for places in
// different brackets and a tiebreaker packet is uploaded, auto-fill holds
// those slots (schedule.js autoFill, `deciders.hold`) and the tie opens
// here on its suggested games — the two lowest play, the winner plays the
// next one up. Each game can go by the tie-break figure instead. The TD
// may also add a decider of their own (a third-place game, a final).
//
// Everything is kept in the saved schedule, under `deciders`:
//   parts   {k: 'whole' | 'first' | 'second'}   which part of tiebreaker
//           packet k its games read (a full packet as two halves)
//   roundParts {round: 'first' | 'second'}   a round played on half its packet
//   slots   how many tiebreaker packet rows Packets shows after the prelims
//   finalSlots  how many after the last playoff round, for ties for Finals
//           places: tiebreaker packets slots+1 … slots+finalSlots, so they
//           are numbered in round order (a row added before them moves them up)
//   ties    {pool: {tie, positions, games, pp, wins, rooms, placed, done,
//           filledOrder}}   one per tied pool, and 'F:' + a Finals source
//           for a tie for Finals places (finals.js finalsFill)
//   added   [{name, a, b, after, room, packet, res, win, score}]   the TD's
//           own, on a tiebreaker packet. A side is {team}, a place
//           ({label: '3rd in Championship'}: res.a / res.b is the team once
//           that bracket is done) or another of these games' winner or
//           loser ({dec: its index, take, label}); win and score come from
//           the room's upload. One on a round packet is a round of the
//           schedule instead (a `final` phase), filled as Finals are
//   released  how many tiebreaker packets the rooms have been handed
//           (Moderator packets: Release Tiebreaker k)
//   games   [{n, pool|name, tb, room, a, b}]   the games to play, as the
//           schedule editor, the uploads grid and the player page show them
//
// Tiebreaker packet k is stored as round TB_BASE + k: a round no schedule
// reaches, so every packet route (upload, preview, download, replace)
// works on it as it is.
import { esc } from './api.js';
import { fillPlaceholders, slotText } from '../engine/schedule.js';
import { finalsProgress, finalsFill } from '../engine/finals.js';
import { decOf, decAfter, partRange, decGames, ownSide, finAfter, tieBlock } from '../engine/deciderphases.js';
export { decOf, decAfter, partRange, decGames, ownSide };

export const TB_BASE = 900;
export const isTbRound = (n) => Number(n) > TB_BASE;
const PARTS = [['whole', 'Whole packet'], ['first', 'First half'], ['second', 'Second half']];
const ordinal = ['', 'one', 'two', 'three', 'four', 'five', 'six'];
const cap1 = (w) => w[0].toUpperCase() + w.slice(1);
const andList = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
const clone = (x) => JSON.parse(JSON.stringify(x));
const ORD = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

const names = (x) => x.teams.map((t) => t.name);
// The suggested games: the two lowest play, the winner plays the next one
// up, and so on, stopping once the rest share a bracket.
function suggested(x) {
  const s = names(x), n = s.length, P = (j) => x.teams[j].bracket, g = [];
  for (let i = 0; i < n - 1 && P(0) !== P(n - 1 - i); i++) g.push({ a: s[n - 2 - i], b: i ? { w: i - 1 } : s[n - 1] });
  return g;
}
const sameGames = (g, h) => JSON.stringify(g) === JSON.stringify(h);
const PLACE_RE = /^(\d+)(?:st|nd|rd|th) in (.+)$/;
// which tiebreaker packet each game of a tie reads (a game waits for the
// games it needs; a pool plays one game at a time); -1: no game
function chain(st) {
  const out = [];
  st.games.forEach((y, i) => {
    if (st.pp[i]) { out[i] = -1; return; }
    const deps = [y.a, y.b].filter((r) => typeof r !== 'string').map((r) => out['w' in r ? r.w : r.l]);
    let k = Math.max(0, ...deps.map((d) => d + 1));
    while (out.includes(k)) k++;
    out[i] = k;
  });
  return out;
}
function who(x, st, r, g) {
  if (typeof r === 'string') return names(x).includes(r) ? r : null;
  const k = 'w' in r ? r.w : r.l;
  if (!g[k]) return null;
  const a = who(x, st, g[k].a, g), b = who(x, st, g[k].b, g);
  if (!a || !b) return null;
  const rank = (n) => names(x).indexOf(n);
  const w = st.pp[k] ? (rank(a) < rank(b) ? 'a' : 'b') : st.wins[k];
  if (!w) return null;
  return ('w' in r) === (w === 'a') ? a : b;
}
function ref(x, st, r, g, cap = false) {
  const n = who(x, st, r, g);
  if (n) return n;
  if (typeof r === 'string') return r;
  const k = 'w' in r ? r.w : r.l, src = g[k];
  const of = src && typeof src.a === 'string' && typeof src.b === 'string' ? `${src.a} vs ${src.b}` : `game ${k + 1}`;
  return (cap ? ('w' in r ? 'Winner' : 'Loser') : ('w' in r ? 'winner' : 'loser')) + ' of ' + of;
}
// Where each team goes once the games are decided. The suggested games:
// each loser takes the next place up from the bottom. The TD's own games:
// by games won, then the order they were tied in, for the TD to confirm.
function order(x, st, own) {
  const g = st.games, ns = names(x), n = ns.length;
  if (!g.length || !g.every((_, i) => st.pp[i] || st.wins[i])) return null;
  if (own) {
    const wins = (t) => g.filter((_, i) => who(x, st, { w: i }, g) === t).length;
    return { order: ns.slice().sort((p, q) => wins(q) - wins(p) || ns.indexOf(p) - ns.indexOf(q)), ask: true };
  }
  const o = [];
  g.forEach((y, i) => { const w = who(x, st, { w: i }, g); o[n - 1 - i] = w === who(x, st, y.a, g) ? who(x, st, y.b, g) : who(x, st, y.a, g); });
  ns.filter((t) => !o.includes(t)).forEach((t, k) => { o[k] = t; });
  return { order: o, ask: false };
}
const spots = (x) => {
  const by = {};
  x.teams.forEach((t) => { by[t.bracket] = (by[t.bracket] || 0) + 1; });
  return andList(Object.entries(by).map(([b, n], k) => `${ordinal[n] || n}${k ? '' : n > 1 ? ' spots' : ' spot'} in ${b}`));
};
const places = (x, o) => {
  const by = {};
  o.forEach((t, k) => { (by[x.teams[k].bracket] ||= []).push(t); });
  return Object.entries(by).map(([b, ts], k) => `${andList(ts)}${k ? '' : ts.length > 1 ? ' go' : ' goes'} to ${b}`).join(', ') + '.';
};

/**
 * The hub's side. `h` is what admin.js lends: sched() / setSched(s, etag),
 * save(s) -> {etag} (the schedule route), held() (auto-fill's waiting
 * ties), agg() (the prelim standings, or null), tbRounds() (the uploaded
 * tiebreaker packets, as rounds), statLabel() (the tie-break figure's
 * name), render(), say(), goPackets().
 */
export function makeDeciders(h) {
  const S = () => h.sched();
  const D = () => decOf(S());
  const packetOf = (k) => h.tbRounds().find((r) => r.number === TB_BASE + k + 1) || null;
  const write = async (mutate) => {
    const s = clone(S());
    s.deciders = decOf(s);
    mutate(s, s.deciders);
    s.deciders.games = gamesOf(s);
    const out = await h.save(s);
    h.setSched(s, out && out.etag);
  };
  /* ---- the two blocks of tiebreaker packets ---- */
  const isFin = (key) => String(key).startsWith('F:');
  // one block when the Finals follow the prelims (a round robin straight to a final)
  const sameCut = (s) => { const f = finAfter(s); return f === null || f === decAfter(s); };
  function blocks() {
    const d = D(), s = S();
    const fin = s && !sameCut(s) ? Number(d.finalSlots) || 0 : 0;
    const top = Math.max(0, ...h.tbRounds().map((r) => r.number - TB_BASE));
    return { pre: Math.max(d.slots, top - fin, 0), fin };
  }
  // a tie's packets: the block after the round it follows (deciderphases.js tieBlock)
  const baseOf = (key) => (S() && tieBlock(S(), key) === 'fin' ? blocks().pre : 0);
  const afterOf = (s, key) => (tieBlock(s, key) === 'fin' ? finAfter(s) : decAfter(s));
  const blockOf = (k) => (k > blocks().pre && S() && !sameCut(S()) ? 'fin' : 'pre');
  // a tiebreaker packet uploaded in the block
  const packets = (block) => h.tbRounds().some((r) => blockOf(r.number - TB_BASE) === (block === 'fin' && S() && sameCut(S()) ? 'pre' : block));

  // A tie as Deciders plays it. With a tie order (stats.js), only the teams a
  // tiebreaker game has to set apart, at their places; a tie for Finals places
  // has each place's slot as its "bracket" (null past the Finals' places).
  function asTie(x, fin) {
    if (!x.order) return x;
    const play = new Set(x.needGame.flat());
    const teams = x.teams.filter((t) => play.has(t.name));
    if (!fin) return { ...x, teams };
    return { ...x, pool: 'F:' + x.bracket, finals: true,
      // where each place goes: the game its slot is in (the stepladder stops once the rest go the same way)
      teams: teams.map((t) => ({ ...t, bracket: t.place <= x.deepest ? t.to || x.bracket : null })) };
  }
  // the ties auto-fill holds for a tiebreaker game now (with packets in their block)
  const heldNow = () => [
    ...h.held().filter((x) => (!x.order || (x.needGame && x.needGame.length)) && (!x.order || packets('pre'))).map((x) => asTie(x, false)),
    ...(h.heldFinals ? h.heldFinals() : []).filter((x) => x.order && x.needGame && x.needGame.length && packets(tieBlock(S(), 'F:' + x.bracket))).map((x) => asTie(x, true)),
  ];
  // the ties to show: those auto-fill holds now, and those already started
  const ties = () => {
    const out = new Map();
    for (const x of heldNow()) out.set(x.pool, x);
    for (const [pool, st] of Object.entries(D().ties)) if (st.tie && !out.has(pool)) out.set(pool, st.tie);
    return [...out.values()];
  };
  // a tie's key as an attribute (a Finals source's name may hold anything)
  const keys = [];
  const keyAttr = (k) => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return 'k' + i; };
  const keyOf = (v) => keys[Number(String(v).slice(1))];
  const roomOf = (s, pool, st, i) => {
    if (st.rooms && st.rooms[i] !== undefined) return Number(st.rooms[i]);
    // a Finals tie: the room of the Finals' first game
    if (isFin(pool)) { const ph = s.phases.find((p) => p.kind === 'final'); const g = ph && ph.rounds[0] && ph.rounds[0].games[0]; return g ? g.room : 0; }
    const g = s.phases[0].rounds[0].games.find((y) => ((s.pools || {})[pool] || []).includes(y.a.team));
    return g ? g.room : 0;
  };
  // every game to play, numbered: ties first by the packet they read, then the TD's own
  function gamesOf(s) {
    const d = decOf(s), out = [];
    const pools = Object.keys(s.pools || {});
    for (const [pool, st] of Object.entries(d.ties)) {
      const x = st.tie, c = chain(st);
      st.games.forEach((y, i) => {
        if (c[i] < 0) return;
        const slot = (r) => { const n = who(x, st, r, st.games); return n ? { team: n } : { label: ref(x, st, r, st.games, true) }; };
        out.push({ pool, game: i + 1, tb: baseOf(pool) + c[i] + 1, room: roomOf(s, pool, st, i), a: slot(y.a), b: slot(y.b), after: afterOf(s, pool), ...(st.wins[i] ? { done: true } : {}) });
      });
    }
    out.sort((p, q) => p.tb - q.tb || pools.indexOf(p.pool) - pools.indexOf(q.pool) || String(p.pool).localeCompare(String(q.pool)) || p.game - q.game);
    d.added.forEach((y, i) => out.push({ name: y.name, own: i, tb: /^t\d+$/.test(y.packet) ? Number(y.packet.slice(1)) : 0, packet: y.packet, room: Number(y.room) || 0, a: ownSide(d, y, 'a'), b: ownSide(d, y, 'b'), after: Number(y.after) || decAfter(s), ...(y.win ? { done: true } : {}) }));
    out.forEach((g, i) => { g.n = i + 1; });
    return out;
  }
  const numOf = (pool, i) => (D().games.find((g) => g.pool === pool && g.game === i + 1) || {}).n;

  /* ---- Moderator packets: tiebreaker packets are released like rounds, one at a time ---- */
  const tbsInUse = () => [...new Set(D().games.filter((g) => g.tb).map((g) => g.tb))].sort((x, y) => x - y);
  // the tiebreaker packet to release next, once the games on the ones before it are in; null when none
  function nextRelease() {
    const d = D();
    const k = tbsInUse().find((x) => x > d.released);
    if (!k) return null;
    return d.games.filter((g) => g.tb && g.tb < k).every((g) => g.done) ? k : null;
  }
  const release = (k) => write((s, d) => { d.released = Math.max(d.released, k); }).then(() => { h.say(`Tiebreaker ${k} released`); h.render(); });
  // with Auto-advance on, a tiebreaker packet is released as soon as it can be
  async function autoRelease() {
    if (!S() || !h.auto()) return false;
    const k = nextRelease();
    if (!k) return false;
    await write((s, d) => { d.released = Math.max(d.released, k); });
    return true;
  }
  // the tiebreakers still to be played before round `to`: ['Tiebreaker 1', ...]
  const pending = (to) => (S() ? [...new Set(D().games.filter((g) => g.tb && !g.done && g.after < to).map((g) => g.tb))].sort((x, y) => x - y).map((k) => 'Tiebreaker ' + k) : []);
  const releaseHtml = () => { const k = S() ? nextRelease() : null; return k ? `<button id="decrelease" class="primary advance" data-tb="${k}">Release Tiebreaker ${k}</button>` : ''; };
  // the chips for the tiebreaker packets that follow round n
  const chips = (n) => (S() ? [...new Set(D().games.filter((g) => g.tb && g.after === n).map((g) => g.tb))].sort((x, y) => x - y)
    .map((k) => `<span class="tbchip${k <= D().released ? ' on' : ''}" title="Tiebreaker ${k}">T${k}</span>`).join('') : '');

  // a tie the hub has just found starts on its suggested games
  async function init() {
    if (!S()) return false;
    const fresh = heldNow().filter((x) => !D().ties[x.pool] && x.teams.length > 1);
    if (!fresh.length) return false;
    await write((s, d) => {
      for (const x of fresh) {
        // with a tie order the teams' own places; before, the pool's open slots
        const open = x.order ? x.teams.map((t) => t.place)
          : [...new Set((JSON.stringify(s).match(new RegExp(`"label":"${x.pool}\\d+"`, 'g')) || []))].map((l) => Number(l.slice(9 + x.pool.length, -1)));
        d.ties[x.pool] = { tie: x, positions: open.sort((p, q) => p - q).slice(0, x.teams.length), games: suggested(x), pp: {}, wins: {}, rooms: {}, placed: null, done: null, filledOrder: null };
      }
    });
    return true;
  }
  // A decider's result is its room's finished upload, filed under its
  // tiebreaker packet's round: the winner is set from it (and unset if
  // the upload goes). true when anything changed.
  let syncing = false;
  const fileFor = (files, tb, room, a, b) => {
    const bucket = (S().rooms[room] || {}).bucket;
    const f = files.filter((g) => g.round === TB_BASE + tb && g.bucket === bucket && !g.part
      && [...g.teams].sort().join('\n') === [a, b].sort().join('\n')).sort((p, q) => q.created - p.created)[0];
    const win = f && f.score[0] !== f.score[1] ? ((f.score[f.teams.indexOf(a)] > f.score[f.teams.indexOf(b)]) ? 'a' : 'b') : null;
    return { win, score: f ? `${Math.max(...f.score)}–${Math.min(...f.score)}` : null };
  };
  // The TD's own deciders: a place becomes a team once its bracket has every game in, ranked as
  // the Finals fill ranks it (finals.js), read from a copy of the schedule with these games as
  // one more Finals phase.
  let ownSig = null;
  async function resolveOwn() {
    const s = S(), d = D();
    const isPlace = (x) => !!x && !x.team && !Number.isInteger(x.dec) && PLACE_RE.test(x.label || '');
    if (!d.added.some((y) => ['a', 'b'].some((k) => isPlace(y[k]) && !(y.res && y.res[k])))) return false;
    const temp = clone(s);
    const slot = (x) => (isPlace(x) ? { label: x.label } : { team: '\u0000' });
    temp.phases.push({ name: '\u0000', kind: 'final', meet: 1, rounds: [{ round: 99999, byes: [],
      games: d.added.map((y, i) => ({ room: 0, a: slot(y.a), b: slot(y.b), bracket: '\u0000' + i })) }] });
    const prog = finalsProgress(temp, h.rawFiles());
    if (!prog.ready.length || prog.sig === ownSig) return false;
    const matches = await h.matches(prog.files);
    const got = new Set(matches.map((m) => m.fileId));
    if (!prog.files.every((f) => got.has(f.id))) return false; // a game that couldn't be read: look again next time
    const out = finalsFill(temp, matches, prog.ready, [], { settings: h.format(), holdTies: false });
    ownSig = prog.sig;
    const found = [];
    out.schedule.phases[out.schedule.phases.length - 1].rounds[0].games.forEach((g, i) => {
      for (const k of ['a', 'b']) if (g[k] && g[k].team && g[k].from && !((d.added[i].res || {})[k] === g[k].team)) found.push([i, k, g[k].team]);
    });
    if (!found.length) return false;
    await write((s2, d2) => { for (const [i, k, team] of found) if (d2.added[i]) d2.added[i].res = { ...(d2.added[i].res || {}), [k]: team }; });
    return true;
  }
  // ...and its result, from the room's upload on its tiebreaker packet
  async function syncOwn() {
    const d = D(), files = h.files(), found = [];
    d.added.forEach((y, i) => {
      const tb = /^t\d+$/.test(y.packet) ? Number(y.packet.slice(1)) : 0;
      const a = ownSide(d, y, 'a').team, b = ownSide(d, y, 'b').team;
      if (!tb || !a || !b) return;
      const r = fileFor(files, tb, Number(y.room) || 0, a, b);
      if ((y.win || null) !== r.win || (r.win && y.score !== r.score)) found.push([i, r]);
    });
    if (!found.length) return false;
    // one at a time: a later game's teams may follow this one's result
    const [i, r] = found[0];
    await write((s2, d2) => { const y = d2.added[i]; if (!y) return; if (r.win) { y.win = r.win; y.score = r.score; } else { delete y.win; delete y.score; } });
    return true;
  }
  async function sync() {
    if (syncing || !S()) return false;
    syncing = true;
    try {
      const tie = await syncTies();
      const res = await resolveOwn();
      const own = await syncOwn();
      return tie || res || own;
    } finally { syncing = false; }
  }
  async function syncTies() {
    const files = h.files();
    const found = [];
    for (const [pool, st] of Object.entries(D().ties)) {
      const x = st.tie, c = chain(st);
      st.games.forEach((y, i) => {
        if (c[i] < 0) return;
        const a = who(x, st, y.a, st.games), b = who(x, st, y.b, st.games);
        if (!a || !b) return;
        const bucket = (S().rooms[roomOf(S(), pool, st, i)] || {}).bucket;
        const f = files.filter((g) => g.round === TB_BASE + baseOf(pool) + c[i] + 1 && g.bucket === bucket && !g.part
          && [...g.teams].sort().join('\n') === [a, b].sort().join('\n')).sort((p, q) => q.created - p.created)[0];
        const win = f && f.score[0] !== f.score[1] ? ((f.score[f.teams.indexOf(a)] > f.score[f.teams.indexOf(b)]) ? 'a' : 'b') : null;
        if ((st.wins[i] || null) !== win) found.push([pool, i, win, f ? `${Math.max(...f.score)}–${Math.min(...f.score)}` : null]);
      });
    }
    if (!found.length) return false;
    // one game at a time: a later game's teams follow an earlier one's result
    const [pool, i, win, score] = found[0];
    await change(pool, (st) => { from(st, i); if (win) { st.wins[i] = win; st.scores = { ...(st.scores || {}), [i]: score }; } });
    return true;
  }
  // fill (or open again, order null) a tie's slots, in s
  function setSlots(s, x, st, ord) {
    if (x.finals) {
      // the Finals' slots for the tie's places: "2nd in 1st–4th place"
      const at = new Map(st.positions.map((pos, k) => [`${ORD(pos)} in ${x.bracket}`, ord ? ord[k] : null]));
      const put = (sl) => {
        const label = sl && (sl.label || (sl.dec && sl.from));
        if (!label || !at.has(label)) return sl;
        return ord ? { team: at.get(label), from: label, dec: true } : { label };
      };
      for (const ph of s.phases) for (const r of ph.rounds) {
        for (const y of r.games) { y.a = put(y.a); y.b = put(y.b); }
        r.byes = r.byes.map(put);
      }
      return;
    }
    if (ord) {
      const ranks = { [x.pool]: [] };
      st.positions.forEach((pos, k) => { ranks[x.pool][pos - 1] = ord[k]; });
      fillPlaceholders(s, ranks);
      // these slots are the tie's: the hub's refill leaves them (finals.js unfilled)
      const labels = new Set(st.positions.map((pos) => x.pool + pos));
      for (const ph of s.phases) for (const r of ph.rounds) {
        for (const y of r.games) for (const side of ['a', 'b']) if (y[side] && y[side].team && labels.has(y[side].from)) y[side] = { ...y[side], dec: true };
        r.byes = r.byes.map((z) => (z && z.team && labels.has(z.from) ? { ...z, dec: true } : z));
      }
    } else {
      const labels = new Set(st.positions.map((pos) => x.pool + pos));
      for (const ph of s.phases) for (const r of ph.rounds) {
        for (const y of r.games) for (const side of ['a', 'b']) if (y[side] && labels.has(y[side].from)) y[side] = { label: y[side].from };
        r.byes = r.byes.map((z) => (z && labels.has(z.from) ? { label: z.from } : z));
      }
    }
  }
  // after any change to a tie: its slots fill once the order is known, and
  // open again when a change makes it unknown
  const change = (pool, fn) => write((s, d) => {
    const st = d.ties[pool], x = st.tie;
    fn(st, x);
    const own = !sameGames(st.games, suggested(x));
    const o = order(x, st, own);
    const want = own ? (o && st.placed) || null : (o && o.order) || null;
    if (st.done && JSON.stringify(want) !== JSON.stringify(st.filledOrder)) { setSlots(s, x, st, null); st.done = null; st.filledOrder = null; }
    if (!st.done && want) { setSlots(s, x, st, want); st.done = places(x, want); st.filledOrder = want; }
  }).then(() => h.render());
  // a game's results start over from game i on (later games may depend on it)
  const from = (st, i) => { Object.keys(st.wins).forEach((k) => { if (+k >= +i) delete st.wins[k]; }); st.placed = null; };

  // the tied teams' numbers: record, points per 20, bonus conversion, and how they did against each other
  function statsHtml(x) {
    const ns = names(x);
    // with a tie order: the figures it ranks by, as the fill read them
    if (x.figures) {
      const f = (n) => x.figures[n] || {};
      return `<table class="tbstats"><thead><tr><th>Team</th><th class="num">W–L</th><th class="num">PPG</th><th class="num">PPB</th><th class="num">vs tied</th></tr></thead>
        <tbody>${ns.map((n) => `<tr><td>${esc(n)}</td><td class="num">${esc(x.record)}</td><td class="num">${Number(f(n).ppg || 0).toFixed(2)}</td><td class="num">${Number(f(n).ppb || 0).toFixed(2)}</td><td class="num">${esc(f(n).h2h || '–')}</td></tr>`).join('')}</tbody></table>`;
    }
    const agg = h.agg();
    if (!agg) return '';
    const row = (n) => agg.teams.find((t) => t.name === n) || {};
    const h2h = (n) => {
      let w = 0, l = 0;
      for (const g of agg.games || []) {
        const ts = g.teams.map((t) => t.name);
        if (!ts.includes(n) || !ts.every((t) => ns.includes(t))) continue;
        const me = g.teams.find((t) => t.name === n), them = g.teams.find((t) => t.name !== n);
        if (me.points > them.points) w++; else if (me.points < them.points) l++;
      }
      return w + '–' + l;
    };
    return `<table class="tbstats"><thead><tr><th>Team</th><th class="num">W–L</th><th class="num">PP20</th><th class="num">PPB</th><th class="num">vs tied</th></tr></thead>
      <tbody>${ns.map((n) => { const r = row(n);
        return `<tr><td>${esc(n)}</td><td class="num">${r.w ?? ''}–${r.l ?? ''}</td><td class="num">${Number(r.pp20tuh || 0).toFixed(2)}</td><td class="num">${r.ppb !== undefined && r.ppb !== null ? Number(r.ppb).toFixed(2) : ''}</td><td class="num">${h2h(n)}</td></tr>`; }).join('')}</tbody></table>`;
  }
  const roomMenu = (attr, on) => `<select class="tbroom" ${attr} aria-label="Room">${S().rooms.map((r, k) => `<option value="${k}"${k === on ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`;
  // two games in one room on the same tiebreaker packet
  function clashes() {
    const seen = new Map(), out = [];
    for (const g of D().games) {
      if (!g.tb) continue;
      const key = g.tb + ':' + g.room;
      if (seen.has(key)) out.push(`${S().rooms[g.room].name} has two games on Tiebreaker ${g.tb}.`); else seen.set(key, true);
    }
    return out;
  }
  // the sides a decider of the TD's own may have
  function sideOptions() {
    const s = S(), out = [];
    // the latest brackets first: a third-place game or a final is between their places
    for (const b of [...(s.brackets || [])].sort((p, q) => q.phase - p.phase)) {
      const size = new Set(s.phases[b.phase].rounds.flatMap((r) => r.games.filter((g) => g.bracket === b.key).flatMap((g) => [slotText(g.a), slotText(g.b)]))).size;
      for (let i = 1; i <= Math.min(size, 4); i++) out.push([JSON.stringify({ label: `${ORD(i)} in ${b.name}` }), `${ORD(i)} in ${b.name}`]);
    }
    // the winner or loser of a decider added before
    D().added.forEach((y, i) => { for (const take of ['winner', 'loser']) { const label = `${take === 'winner' ? 'Winner' : 'Loser'} of ${y.name || 'Decider'}`; out.push([JSON.stringify({ dec: i, take, label }), label]); } });
    const teams = [...new Set(s.phases[0].rounds.flatMap((r) => r.games.flatMap((g) => [g.a.team, g.b.team])).filter(Boolean))].sort((p, q) => p.localeCompare(q));
    for (const t of teams) out.push([JSON.stringify({ team: t }), t]);
    return out;
  }
  const packetOptions = () => {
    const s = S(), next = Math.max(...s.phases.flatMap((ph) => ph.rounds.map((r) => r.round))) + 1;
    const slots = Math.max(D().slots, ...h.tbRounds().map((r) => r.number - TB_BASE), 0);
    // a decider's own round can take another game in a free room: two games on one packet
    const last = endRound(s);
    return [...(last ? [[`r${last.round}`, `Packet ${last.round}, with ${last.name}`]] : []), [`r${next}`, `Packet ${next}`],
      ...Array.from({ length: slots }, (_, k) => [`t${k + 1}`, `Tiebreaker ${k + 1}${packetOf(k) ? '' : ' (not uploaded)'}`])];
  };
  // the schedule's last phase, when it is one round of deciders added here
  function endRound(s) {
    const ph = s.phases[s.phases.length - 1];
    if (!ph || ph.kind !== 'final' || !ph.decider || ph.rounds.length !== 1) return null;
    return { phase: ph, round: ph.rounds[0].round, name: ph.name };
  }
  const packetLabel = (v) => (/^t\d+$/.test(v) ? 'Tiebreaker ' + v.slice(1) : /^r\d+$/.test(v) ? 'Packet ' + v.slice(1) : '');
  let adding = null; // the open Add a decider form's values, or null

  function html() {
    const s = S();
    if (!s) return '';
    const d = D(), pools = Object.keys(s.pools || {});
    let open = 0, total = 0;
    const cards = ties().map((x) => {
      const st = d.ties[x.pool];
      if (!st) return '';
      const P = keyAttr(x.pool), g = st.games, own = !sameGames(g, suggested(x)), c = chain(st), base = baseOf(x.pool);
      total++;
      if (!st.done) open++;
      const left = g.filter((_, i) => !st.pp[i] && !st.wins[i]).length;
      const status = st.done ? '<span class="tbstatus ok">Resolved</span>'
        : left ? `<span class="tbstatus">${cap1(ordinal[left] || String(left))} game${left === 1 ? '' : 's'} to play</span>`
          : '<span class="tbstatus">Teams to place</span>';
      const menu = (i, side) => {
        const cur = JSON.stringify(g[i][side]);
        const opts = [...names(x).map((n) => [JSON.stringify(n), n]),
          ...g.slice(0, i).flatMap((_, j) => [[JSON.stringify({ w: j }), `Winner of game ${j + 1}`], [JSON.stringify({ l: j }), `Loser of game ${j + 1}`]])];
        return `<select data-decslot="${P}:${i}:${side}" aria-label="Game ${i + 1}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      };
      const tag = (i) => (c[i] < 0 ? '<span class="tbtag off">No game</span>'
        : `<span class="tbtag">Decider ${numOf(x.pool, i) || ''} · Tiebreaker ${base + c[i] + 1} · ${roomMenu(`data-decroom="${P}:${i}"`, roomOf(s, x.pool, st, i))}</span>`);
      const out = (i) => (c[i] >= 0 && !st.wins[i] && base + c[i] + 1 > d.released ? ' <span class="muted">· not released</span>' : '');
      const games = g.map((y, i) => {
        const pp = st.pp[i], a = who(x, st, y.a, g), b = who(x, st, y.b, g), w = who(x, st, { w: i }, g);
        const res = pp ? ` <span class="muted">· ${w ? esc(w) + ' ' : ''}by ${esc(h.statLabel())}</span>` : st.wins[i] ? ` <span class="muted">· ${esc(w)} won${st.scores && st.scores[i] ? ' ' + esc(st.scores[i]) : ''}</span>` : '';
        const box = `<label class="tbpp"><input type="checkbox" data-decpp="${P}:${i}"${pp ? ' checked' : ''}> Use ${esc(h.statLabel())}</label>`;
        const won = '';
        if (st.editing) return `<li class="tbedit">${tag(i)}${menu(i, 'a')} vs ${menu(i, 'b')}${box}<button class="linkbtn muted" data-decdel="${P}:${i}">Remove</button></li>`;
        // its file from the hub, as the room would send it (only a room's upload decides it)
        const bucket = (s.rooms[roomOf(s, x.pool, st, i)] || {}).bucket;
        const up = c[i] >= 0 && !pp && !st.wins[i] && a && b && bucket && h.addFor
          ? ` <button class="linkbtn" data-decup="${bucket}:${TB_BASE + base + c[i] + 1}">Upload the game file</button>` : '';
        return `<li>${tag(i)}<span class="${pp ? 'muted' : ''}">${esc(ref(x, st, y.a, g))} vs ${esc(ref(x, st, y.b, g))}</span>${res}${out(i)}${won}${up}${box}</li>`;
      }).join('');
      let place = '';
      const o = order(x, st, own);
      if (!st.done && o && o.ask && !st.editing) {
        const used = [...new Set(x.teams.map((t) => t.bracket))];
        const at = Object.fromEntries(o.order.map((t, k) => [t, x.teams[k].bracket]));
        place = `<div class="tbplace"><span class="muted">Places:</span>${x.teams.map((t) => `<label>${esc(t.name)} <select data-decplace="${P}" data-team="${esc(t.name)}">${used.map((b) =>
          `<option value="${esc(b ?? '')}"${at[t.name] === b ? ' selected' : ''}>${esc(b ?? '—')}</option>`).join('')}</select></label>`).join('')}
          <button class="small primary" data-decfill="${P}">Fill</button></div>${st.bad ? `<div class="warntext">${esc(st.bad)}</div>` : ''}`;
      }
      const tools = st.editing
        ? `<button class="linkbtn" data-decadd="${P}">Add a game</button>${own ? `<button class="linkbtn" data-decsug="${P}">Use the suggested games</button>` : ''}<button class="small" data-decedit="${P}">Done</button>`
        : `<button class="linkbtn" data-decedit="${P}">Change games</button>`;
      const lane = `lane-${Math.max(0, pools.indexOf(x.pool)) % 4}`;
      const title = x.finals ? esc(x.bracket) : 'Pool ' + esc(x.pool);
      const why = x.finals ? `${esc(andList(names(x)))} are tied at ${esc(x.record)} for ${esc(ORD(Math.min(...x.teams.map((t) => t.place))))} place.`
        : `${esc(andList(names(x)))} are tied at ${esc(x.record)} for ${esc(spots(x))}.`;
      if (st.done && !st.open) {
        return `<section class="tbcard ${lane} done folded"><div class="tbhead"><h3><i></i>${title}</h3>
          <span class="tbresult">${esc(st.done)}</span><button class="linkbtn" data-decfold="${P}">Show details</button>${status}</div></section>`;
      }
      return `<section class="tbcard ${lane}${st.done ? ' done' : ''}">
        <div class="tbhead"><h3><i></i>${title}</h3>${st.done ? `<button class="linkbtn tbhide" data-decfold="${P}">Hide details</button>` : ''}${status}</div>
        <p class="tbwhy">${why}</p>
        ${statsHtml(x)}
        ${g.length ? `<ol class="tbgames">${games}</ol>` : '<p class="muted">No games yet.</p>'}${place}
        ${st.done ? `<p class="tbdone">${esc(st.done)}</p>` : ''}
        <div class="tbhow">${tools}</div>
      </section>`;
    }).join('');
    // the TD's own
    const text = (x) => (x && x.team) || (x && x.label) || '—';
    const ownCards = d.added.map((y, i) => {
      const g = d.games.find((z) => z.own === i) || {}, n = g.n;
      const a = ownSide(d, y, 'a'), b = ownSide(d, y, 'b');
      const won = y.win ? ` · ${esc((y.win === 'a' ? a : b).team)} won ${esc(y.score || '')}` : '';
      const wait = !y.win && g.tb && g.tb > d.released ? ' · <span class="muted">not released</span>' : '';
      return `<section class="tbcard dcplain"><div class="tbhead"><h3>${esc(y.name || 'Decider')}</h3><span class="tbstatus dcwhen">After round ${esc(y.after)}</span></div>
        <ol class="tbgames dcown"><li><span class="tbtag">Decider ${n || ''} · ${esc(packetLabel(y.packet))} · ${roomMenu(`data-decownroom="${i}"`, Number(y.room) || 0)}</span><span>${esc(text(a))} vs ${esc(text(b))}${won}${wait}</span></li></ol>
        <div class="tbhow"><button class="linkbtn muted" data-decownrm="${i}">Remove</button></div></section>`;
    }).join('');
    const tbUsed = h.tbRounds().length > 0;
    if (!cards && !ownCards && !adding && !tbUsed) return '';
    // the packets the games read
    const use = new Map();
    for (const g of d.games) { const key = g.tb ? `t${g.tb}` : g.packet; if (key) use.set(key, [...(use.get(key) || []), g.n]); }
    const chips = [...use.entries()].sort((p, q) => (/^t/.test(q[0]) - /^t/.test(p[0])) || p[0].localeCompare(q[0], undefined, { numeric: true })).map(([key, ns]) => {
      const missing = /^t/.test(key) && !packetOf(Number(key.slice(1)) - 1);
      return `<span class="tbpk on${missing ? ' bad' : ''}">${esc(packetLabel(key))} <span>· Decider${ns.length > 1 ? 's' : ''} ${esc(andList(ns.map(String)))}${missing ? ', not uploaded' : ''}</span></span>`;
    }).join('');
    // per block: the games after the prelims, and those after the playoffs
    const short = ['pre', 'fin'].map((block) => {
      const b = blocks(), base = block === 'fin' ? b.pre : 0;
      const ks = d.games.filter((g) => g.tb && blockOf(g.tb) === block).map((g) => g.tb - base);
      if (!ks.length) return '';
      const need = Math.max(...ks), size = block === 'fin' ? b.fin : b.pre;
      const have = h.tbRounds().filter((r) => blockOf(r.number - TB_BASE) === block).length;
      if (need <= size && ks.every((k) => packetOf(base + k - 1))) return '';
      return `<div class="warntext">The games need ${need} tiebreaker packet${need === 1 ? '' : 's'}, and ${have} ${have === 1 ? 'is' : 'are'} uploaded. <button class="linkbtn" data-decpackets>Add one in Packets</button></div>`;
    }).join('');
    const warn = clashes().map((c) => `<div class="warntext">${esc(c)}</div>`).join('');
    const form = adding ? (() => {
      const sides = sideOptions(), pk = packetOptions();
      const sel = (name, opts, on) => `<select data-decnew="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === on ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      const rounds = s.phases.flatMap((ph) => ph.rounds.map((r) => r.round));
      return `<section class="dcadd"><h3>Add a decider</h3><div class="dcgrid">
        <span class="l">Name</span><span><input data-decnew="name" value="${esc(adding.name)}" size="22"></span>
        <span class="l">Game</span><span class="dcrow">${sel('a', sides, adding.a)} vs ${sel('b', sides, adding.b)}</span>
        <span class="l">When</span><span class="dcrow">after ${sel('after', rounds.map((n) => [String(n), 'Round ' + n]), String(adding.after))} in ${sel('room', s.rooms.map((r, k) => [String(k), r.name]), String(adding.room))}</span>
        <span class="l">Packet</span><span>${sel('packet', pk, adding.packet)}</span></div>
        <div class="dctools"><button class="small primary" data-decnewgo>Add</button><button class="small" data-decnewno>Cancel</button></div></section>`;
    })() : '<div class="dctools"><button class="linkbtn" data-decnewopen>Add a decider</button></div>';
    return `<section class="tbsec${open ? ' tbopen' : ''}" id="decsec"><div class="tbsechead"><h2>${open ? '<span class="tbalert">!</span>' : ''}Deciders</h2>
      ${total ? `<span class="${open ? 'tbcount' : 'muted'}">${total - open}/${total} ties resolved</span>` : ''}</div>
      ${chips ? `<div class="tbpks"><span class="muted">Packets</span>${chips}</div>` : ''}${short}${warn}${cards}${ownCards}${form}</section>`;
  }

  function wire(box) {
    const on = (sel, ev, fn) => box.querySelectorAll(sel).forEach((el) => { el[ev] = () => fn(el); });
    on('[data-decpp]', 'onchange', (el) => { const [k, i] = el.dataset.decpp.split(':'); const pool = keyOf(k); change(pool, (st) => { st.pp[i] = el.checked; from(st, i); }); });
    on('[data-decwin]', 'onchange', (el) => { const [k, i] = el.dataset.decwin.split(':'); const pool = keyOf(k); change(pool, (st) => { from(st, i); if (el.value) st.wins[i] = el.value; }); });
    on('[data-decedit]', 'onclick', (el) => change(keyOf(el.dataset.decedit), (st) => { st.editing = !st.editing; }));
    on('[data-decslot]', 'onchange', (el) => {
      const [k, i, side] = el.dataset.decslot.split(':'); const pool = keyOf(k);
      const v = JSON.parse(el.value);
      change(pool, (st) => { const game = st.games[i]; if (JSON.stringify(v) === JSON.stringify(game[side === 'a' ? 'b' : 'a'])) return; game[side] = v; from(st, i); });
    });
    on('[data-decdel]', 'onclick', (el) => {
      const [k, n] = el.dataset.decdel.split(':'); const pool = keyOf(k); const i = Number(n);
      change(pool, (st) => {
        // games that needed this one's result go too; later ones move up a number
        const gone = new Set([i]);
        st.games.forEach((y, k) => { if (k > i && [y.a, y.b].some((r) => typeof r !== 'string' && gone.has('w' in r ? r.w : r.l))) gone.add(k); });
        const keep = st.games.map((_, k) => k).filter((k) => !gone.has(k));
        const at = new Map(keep.map((k, m) => [k, m]));
        const move = (r) => (typeof r === 'string' ? r : ('w' in r ? { w: at.get(r.w) } : { l: at.get(r.l) }));
        st.games = keep.map((k) => ({ a: move(st.games[k].a), b: move(st.games[k].b) }));
        st.pp = Object.fromEntries(keep.map((k, m) => [m, !!st.pp[k]]));
        st.rooms = Object.fromEntries(keep.filter((k) => st.rooms && st.rooms[k] !== undefined).map((k) => [at.get(k), st.rooms[k]]));
        st.wins = {}; st.placed = null;
      });
    });
    on('[data-decadd]', 'onclick', (el) => change(keyOf(el.dataset.decadd), (st, x) => { const n = names(x); st.games.push({ a: n[0], b: n[1] }); st.placed = null; }));
    on('[data-decsug]', 'onclick', (el) => change(keyOf(el.dataset.decsug), (st, x) => { Object.assign(st, { games: suggested(x), pp: {}, wins: {}, placed: null }); }));
    on('[data-decfill]', 'onclick', (el) => {
      const pool = keyOf(el.dataset.decfill);
      const pick = Object.fromEntries([...box.querySelectorAll(`[data-decplace="${el.dataset.decfill}"]`)].map((e) => [e.dataset.team, e.value]));
      change(pool, (st, x) => {
        const need = {}, have = {};
        x.teams.forEach((t) => { need[t.bracket] = (need[t.bracket] || 0) + 1; });
        for (const k of Object.keys(pick)) if (pick[k] === '' && x.teams.some((t) => t.bracket === null)) pick[k] = null;
        Object.values(pick).forEach((v) => { have[v] = (have[v] || 0) + 1; });
        if (Object.keys(need).some((k) => need[k] !== (have[k] || 0))) { st.bad = andList(Object.entries(need).map(([k, n]) => `${ordinal[n] || n} in ${k}`)) + ', please.'; return; }
        st.bad = null;
        const brs = [...new Set(x.teams.map((t) => t.bracket))];
        st.placed = names(x).sort((p, q) => brs.indexOf(pick[p]) - brs.indexOf(pick[q]));
      });
    });
    on('[data-decroom]', 'onchange', (el) => { const [k, i] = el.dataset.decroom.split(':'); const pool = keyOf(k); change(pool, (st) => { st.rooms = { ...(st.rooms || {}), [i]: Number(el.value) }; }); });
    on('[data-decfold]', 'onclick', (el) => change(keyOf(el.dataset.decfold), (st) => { st.open = !st.open; }));
    on('[data-decpackets]', 'onclick', () => h.goPackets());
    on('[data-decup]', 'onclick', (el) => { const [bid, round] = el.dataset.decup.split(':').map(Number); h.addFor(bid, round); });
    on('#decrelease', 'onclick', (el) => release(Number(el.dataset.tb)));
    on('[data-decownroom]', 'onchange', (el) => write((s, d) => { d.added[Number(el.dataset.decownroom)].room = Number(el.value); }).then(() => h.render()));
    on('[data-decownrm]', 'onclick', (el) => write((s, d) => {
      const i = Number(el.dataset.decownrm);
      d.added.splice(i, 1);
      // a game that waited on this one's winner or loser keeps the words; later ones keep their game
      for (const y of d.added) for (const k of ['a', 'b']) {
        const x = y[k];
        if (!x || !Number.isInteger(x.dec)) continue;
        if (x.dec === i) y[k] = { label: x.label }; else if (x.dec > i) x.dec -= 1;
      }
    }).then(() => h.render()));
    on('[data-decnewopen]', 'onclick', () => {
      const sides = sideOptions(), s = S();
      adding = { name: 'Third-place game', a: (sides[2] || sides[0])[0], b: (sides[3] || sides[1])[0], after: Math.max(...s.phases.flatMap((ph) => ph.rounds.map((r) => r.round))), room: 0, packet: packetOptions()[0][0] };
      h.render();
    });
    on('[data-decnew]', 'onchange', (el) => {
      adding[el.dataset.decnew] = el.value;
      // a tiebreaker packet has its place in the day: after the round its other games follow,
      // or the round before the playoffs
      if (el.dataset.decnew === 'packet') {
        const k = /^t\d+$/.test(el.value) ? Number(el.value.slice(1)) : 0;
        const same = k ? D().games.find((g) => g.tb === k) : null;
        adding.after = k ? (same ? same.after : decAfter(S())) : Math.max(...S().phases.flatMap((ph) => ph.rounds.map((r) => r.round)));
        h.render();
      }
    });
    on('[data-decnewno]', 'onclick', () => { adding = null; h.render(); });
    on('[data-decnewgo]', 'onclick', () => {
      const v = adding;
      if (v.a === v.b) { h.say('A decider needs two different sides.', true); return; }
      adding = null;
      const name = String(v.name || '').trim() || 'Decider', a = JSON.parse(v.a), b = JSON.parse(v.b);
      if (/^r\d+$/.test(v.packet)) {
        // on a round packet: one game in a round of its own, after the last (schededit.js Add phase)
        if (Number.isInteger(a.dec) || Number.isInteger(b.dec)) { adding = v; h.say('A decider on a round packet is between teams or places.', true); return; }
        const want = Number(v.packet.slice(1)), end = endRound(S());
        const shared = end && end.round === want;
        if (shared && end.phase.rounds[0].games.some((g) => g.room === Number(v.room))) {
          adding = v;
          h.say(`${S().rooms[Number(v.room)].name} already has ${end.name} on packet ${want}.`, true);
          return;
        }
        write((s) => {
          const keyOf = () => { let k = 1; while ((s.brackets || []).some((x) => x.key === 'FN' + k)) k++; return 'FN' + k; };
          const key = keyOf();
          if (shared) {
            // one more game on the same packet, in another room: the phase is named for both
            const ph = s.phases[s.phases.length - 1];
            ph.rounds[0].games.push({ room: Number(v.room), a, b, bracket: key });
            ph.name = `${ph.name} + ${name}`;
            s.brackets = [...(s.brackets || []), { key, name, phase: s.phases.length - 1 }];
            return;
          }
          const round = Math.max(...s.phases.flatMap((ph) => ph.rounds.map((r) => r.round))) + 1;
          s.phases.push({ name, rounds: [{ round, games: [{ room: Number(v.room), a, b, bracket: key }], byes: [] }], meet: 1, kind: 'final', decider: true });
          s.brackets = [...(s.brackets || []), { key, name, phase: s.phases.length - 1 }];
        }).then(() => { h.say(shared ? `${name} added to round ${want}.` : `${name} added as round ${Math.max(...S().phases.flatMap((ph) => ph.rounds.map((r) => r.round)))}.`); h.render(); });
        return;
      }
      // one packet is released once: its games all follow the same round
      const tbk = Number(v.packet.slice(1)), same = D().games.find((g) => g.tb === tbk);
      write((s, d) => { d.added.push({ name, a, b, after: same ? same.after : Number(v.after), room: Number(v.room), packet: v.packet }); }).then(() => h.render());
    });
  }

  /* ---- Packets: the tiebreaker packets, indented after the round their ties follow ---- */
  // Two blocks: after the prelims' last round (ties for playoff places) and,
  // when the Finals have places to fill, after the last playoff round (ties
  // for Finals places). Numbered in round order: a row added to the first
  // block moves the second's packets up one (POST packets/move), so it can
  // only be added while none of those has been released or played on.
  // Each round's own packet gets the same part menu: any round may be
  // played on half its packet (deciders.roundParts).
  function packetRows(box, o) {
    const s = S();
    const table = box.querySelector('.pktable');
    if (!table) return;
    const d = D(), b = blocks();
    const select = (attr, on, name) => `<select class="tbroom tbpart" ${attr} aria-label="Part of ${esc(name)}">${PARTS.map(([v, l]) => `<option value="${v}"${v === on ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    // the round rows' part menus, after the file name
    if (s) {
      for (const tr of table.querySelectorAll('tr.slot.has[data-round]')) {
        const n = Number(tr.dataset.round), item = tr.querySelector('.pkfile .pkitem');
        if (!item || !Number.isInteger(n)) continue;
        item.insertAdjacentHTML('afterend', select(`data-rdpart="${n}"`, (d.roundParts || {})[n] || 'whole', 'packet ' + n));
      }
    }
    const fileRounds = new Set(h.files().map((f) => f.round));
    const rowsOf = (from, count, block) => {
      const out = [];
      for (let k = from + 1; k <= from + count; k++) {
        const r = packetOf(k - 1), part = d.parts[k] || 'whole';
        out.push(`<tr class="slot tbpkrow${r ? ' has' : ''}" data-tbslot="${k}">
        <td class="pkn"><span class="tbpktag">Tiebreaker ${k}</span></td>
        <td class="pkfile">${r ? `<span class="pkitem"><span class="dot"></span>${esc(r.packet_name)}</span>
          ${select(`data-tbpart="${k}"`, part, 'Tiebreaker ' + k)}`
          : `<span class="dot"></span><span class="muted">No packet yet${o.staged.length ? ' &middot; drop one here' : ''}</span>`}</td>
        <td class="pkact">${r ? `<button class="icon" data-tbpreview="${k}" title="Preview" aria-label="Preview ${esc(r.packet_name)}">${o.icons.preview}</button><a class="icon" href="${esc(o.href(r))}" download title="Download" aria-label="Download ${esc(r.packet_name)}">${o.icons.download}</a>` : ''}<button class="icon" data-tbpick="${k}" title="${r ? 'Replace' : 'Upload'}" aria-label="${r ? 'Replace' : 'Upload'} Tiebreaker ${k}">${o.icons.upload}</button></td></tr>`);
      }
      const last = from + count;
      // the last row goes only while it is empty
      const drop = count > 0 && !packetOf(last - 1);
      // a first-block row moves the second block's packets: only before they are used
      const later = block === 'pre' ? Array.from({ length: b.fin }, (_, x) => b.pre + x + 1) : [];
      const movable = later.every((k) => k > d.released && !fileRounds.has(TB_BASE + k)) && (!later.length || !!o.move);
      out.push(`<tr class="tbpkrow tbpkfoot"><td colspan="3">${movable ? `<button class="linkbtn" data-tbpkadd="${block}">Add a tiebreaker packet</button>` : ''}${drop && movable ? `<button class="linkbtn muted" data-tbpkdrop="${block}">Remove last</button>` : ''}</td></tr>`);
      return out.join('');
    };
    const rowAfter = (n) => (n !== null && table.querySelector(`tr[data-round="${n}"]`)) || [...table.querySelectorAll('tr.slot[data-round]')].pop();
    const preRow = s ? rowAfter(decAfter(s)) : [...table.querySelectorAll('tr.slot')].pop();
    if (!preRow) return;
    const two = s && !sameCut(s);
    // the second block first, so the first's rows don't move its anchor
    if (two) { const fr = rowAfter(finAfter(s)); if (fr) fr.insertAdjacentHTML('afterend', rowsOf(b.pre, b.fin, 'fin')); }
    preRow.insertAdjacentHTML('afterend', rowsOf(0, b.pre, 'pre'));
    table.insertAdjacentHTML('beforeend', '<tr hidden><td><input type="file" id="tbpkfile" accept=".json,.docx" hidden></td></tr>');
    const q = (sel) => table.querySelector(sel);
    // move the second block's packets by one (up: +1, from the top; down: -1, from the bottom)
    const shift = async (by) => {
      const ks = Array.from({ length: b.fin }, (_, x) => b.pre + x + 1);
      for (const k of by > 0 ? ks.reverse() : ks) if (packetOf(k - 1)) await o.move(TB_BASE + k, TB_BASE + k + by);
    };
    const renumber = (dd, by) => {
      const moved = (k) => (k > b.pre ? k + by : k);
      dd.parts = Object.fromEntries(Object.entries(dd.parts || {}).map(([k, v]) => [String(moved(Number(k))), v]));
      for (const y of dd.added || []) if (/^t\d+$/.test(y.packet || '')) y.packet = 't' + moved(Number(y.packet.slice(1)));
    };
    table.querySelectorAll('[data-tbpkadd]').forEach((el) => {
      el.onclick = async () => {
        try {
          if (el.dataset.tbpkadd === 'fin') await write((_, dd) => { dd.slots = b.pre; dd.finalSlots = b.fin + 1; });
          else {
            if (b.fin) await shift(1);
            await write((_, dd) => { renumber(dd, 1); dd.slots = b.pre + 1; dd.finalSlots = b.fin; });
          }
          await o.refresh();
        } catch (e) { h.say(e.message, true); }
      };
    });
    table.querySelectorAll('[data-tbpkdrop]').forEach((el) => {
      el.onclick = async () => {
        try {
          if (el.dataset.tbpkdrop === 'fin') await write((_, dd) => { dd.slots = b.pre; dd.finalSlots = Math.max(0, b.fin - 1); });
          else {
            if (b.fin) await shift(-1);
            await write((_, dd) => { renumber(dd, -1); dd.slots = Math.max(0, b.pre - 1); dd.finalSlots = b.fin; });
          }
          await o.refresh();
        } catch (e) { h.say(e.message, true); }
      };
    });
    table.querySelectorAll('[data-tbpart]').forEach((el) => { el.onchange = () => write((_, dd) => { dd.parts = { ...dd.parts, [el.dataset.tbpart]: el.value }; }).then(() => h.render()); });
    table.querySelectorAll('[data-rdpart]').forEach((el) => {
      el.onchange = () => write((_, dd) => {
        const rp = { ...(dd.roundParts || {}) };
        if (el.value === 'whole') delete rp[el.dataset.rdpart]; else rp[el.dataset.rdpart] = el.value;
        dd.roundParts = rp;
      }).then(() => h.render());
    });
    table.querySelectorAll('[data-tbpick]').forEach((btn) => {
      btn.onclick = () => {
        const f = q('#tbpkfile');
        f.onchange = async () => {
          if (!f.files[0]) return;
          const k = Number(btn.dataset.tbpick);
          try { await o.upload(TB_BASE + k, f.files[0]); h.say(`Tiebreaker ${k}: ${f.files[0].name}`); await o.refresh(); } catch (e) { h.say(e.message, true); }
        };
        f.click();
      };
    });
    table.querySelectorAll('[data-tbpreview]').forEach((btn) => { btn.onclick = () => o.preview(TB_BASE + Number(btn.dataset.tbpreview), (n) => partRange(d.parts[btn.dataset.tbpreview] || 'whole', n)); });
    table.querySelectorAll('tr[data-tbslot]').forEach((tr) => {
      tr.ondragover = (e) => { e.preventDefault(); tr.classList.add('dragover'); };
      tr.ondragleave = () => tr.classList.remove('dragover');
      tr.ondrop = async (e) => {
        e.preventDefault();
        tr.classList.remove('dragover');
        const m = /^chip:(\d+)$/.exec(e.dataTransfer.getData('text/plain'));
        const file = m ? o.staged[Number(m[1])] : null;
        if (!file) return;
        const k = Number(tr.dataset.tbslot);
        try { await o.uploadStaged(TB_BASE + k, file); o.staged.splice(o.staged.indexOf(file), 1); h.say(`Tiebreaker ${k}: ${file.name}`); await o.refresh(); } catch (err) { h.say(err.message, true); }
      };
    });
  }

  /* ---- the uploads grid: a column per tiebreaker packet in use, after the round its games follow ---- */
  const tbCols = (n) => [...new Set(decGames(S()).filter((g) => g.tb && g.after === n).map((g) => g.tb))].sort((x, y) => x - y);
  const gridHeads = (n) => (S() ? tbCols(n).map((k) => `<th class="tbcol" title="Tiebreaker ${k}">T${k}</th>`).join('') : '');
  // how many tiebreaker columns follow round n's (the grid's phase row spans them too)
  const gridColsAfter = (n) => (S() ? tbCols(n).length : 0);
  // cell(round): the hub's own cell for a room and round, used once the room has sent something
  function gridCells(bucketId, n, cell) {
    const s = S();
    if (!s) return '';
    const room = s.rooms.findIndex((r) => r.bucket === bucketId);
    return tbCols(n).map((k) => {
      if (h.files().some((f) => f.bucket === bucketId && f.round === TB_BASE + k) || h.anyFile(bucketId, TB_BASE + k)) return cell(TB_BASE + k).replace('class="ucell', 'class="ucell tbcol');
      const g = decGames(s).find((y) => y.tb === k && y.room === room);
      return `<td class="ucell tbcol">${g ? `<span class="umark warn" title="Decider ${g.n}: not in yet">&ndash;</span>` : ''}</td>`;
    }).join('');
  }
  const colCount = () => (S() ? new Set(decGames(S()).filter((g) => g.tb).map((g) => g.tb + ':' + g.after)).size : 0);
  return { html, wire, init, sync, packetRows, gridHeads, gridColsAfter, gridCells, colCount,
    // tiebreaker packets after the prelims; after the playoffs (the Finals' ties)
    hold: () => packets('pre'), holdFinals: () => packets('fin'), packets,
    releaseHtml, chips, pending, autoRelease, tbCount: () => (S() ? tbsInUse().length : 0) };
}

/** The schedule editor's and the player page's block: deciders after their round, read-only. */
export function decEditorHtml(s, parts = false) {
  const all = decGames(s);
  if (!all.length) return parts ? [] : '';
  const slot = (x) => `<div class="sgslot${x && x.label ? ' ph' : ''}">${esc(slotText(x) || (x && x.label) || '—')}</div>`;
  const out = [...new Set(all.map((g) => g.after))].sort((x, y) => x - y).map((after) => {
    const games = all.filter((g) => g.after === after);
    const used = [...new Set(games.map((g) => g.room))].sort((x, y) => x - y);
    const html = `<section class="sgphase tbedphase">
    <div class="sgphasehead"><span class="caret">▾</span><b>Deciders</b><span class="muted">after round ${after} · changed in the Live Hub</span></div>
    <div class="sggrid" style="grid-template-columns:40px ${used.map(() => '230px').join(' ')}">
      <div class="sgcorner"></div>${used.map((i) => `<div class="sgroom">${esc(s.rooms[i].name)}</div>`).join('')}
      ${games.map((g) => `<div class="sgrnd"><span>D${g.n}</span></div>${used.map((i) => (g.room === i ? `<div class="sgcell">${slot(g.a)}${slot(g.b)}</div>` : '<div class="sgcell empty"></div>')).join('')}`).join('')}
    </div></section>`;
    return { after, html };
  });
  return parts ? out : out.map((x) => x.html).join('');
}
