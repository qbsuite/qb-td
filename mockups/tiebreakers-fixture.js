// Throwaway mock (tiebreakers-hub.html): the demo tournament as two pools
// of eight with the prelims all played. Pool A is ACF Nationals 2026's
// New Carrollton pool: Virginia Tech 6–1, then Toronto A, UCLA and
// Minnesota tied at 5–2 for one spot in 1st–2nd place (points per 20 puts
// them in that order). In pool B, Berkeley A, Michigan A and Yale A are
// tied at 4–3 for places 3–5. Playoffs take places in pairs from each pool.
// ?v=built: what's built (ties go by points per 20). Otherwise the
// proposal: the TD has uploaded two tiebreaker packets, so a tie waits for
// the TD in the Live Hub, and tiebreaker games read those packets.
import real from '../app/demo/fixture.js?real';
import { buildPlan } from '../app/engine/plan.js';
import { renameTeams } from '../app/engine/schedule.js';

const BUILT = new URLSearchParams(location.search).get('v') === 'built';
// ?at=N: the day earlier, with round N live and the rounds before it in
const AT = Math.max(1, Math.min(7, Number(new URLSearchParams(location.search).get('at')) || 7));
const A = ['Virginia Tech', 'Toronto A', 'UCLA', 'Minnesota', 'Penn State', 'Georgia Tech B', 'Purdue', 'Maryland B'];
const B = ['Chicago A', 'Stanford A', 'Berkeley A', 'Michigan A', 'Yale A', 'Columbia A', 'Rice A', 'Duke A'];
const ROOMS = Array.from({ length: 8 }, (_, i) => 'Room ' + (101 + i));

const ph = (name, o = {}) => ({ name, kind: 'pools', groups: 1, top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1, carry: true,
  reset: true, byes: false, sizes: null, parallelTop: false, share: false, n: 3, mode: 'rotate', ...o });
const plan = { fmt: 'custom', seeding: 'snake', phases: [ph('Prelims', { groups: 2 }), ph('Playoffs', { per: 2 })] };
const temp = Array.from({ length: 16 }, (_, i) => 'T' + (i + 1));
const built = buildPlan(temp, ROOMS.map((name, i) => ({ name, bucket: i + 1 })), plan.phases, plan.seeding, 1);
renameTeams(built, Object.fromEntries([...built.pools.A.map((t, i) => [t, A[i]]), ...built.pools.B.map((t, i) => [t, B[i]])]));
built.options = { seed: 1, plan };
built.updated = Date.now();

// a saved copy (the hub's own saves) outlives a reload, and the public page in its own tab reads it
const KEY = 'tbMock6:schedule:' + (BUILT ? 'built' : 'proposal') + (AT < 7 ? ':at' + AT : '');
let saved = null;
try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* none */ }

// pool A's results (winner first), as at Nationals; pool B goes by seed
const WINS = [['Virginia Tech', 'UCLA'], ['Virginia Tech', 'Minnesota'], ['Toronto A', 'Virginia Tech'], ['UCLA', 'Toronto A'],
  ['Minnesota', 'Toronto A'], ['UCLA', 'Minnesota'], ['Penn State', 'UCLA'], ['Penn State', 'Georgia Tech B'], ['Penn State', 'Purdue'],
  ['Maryland B', 'Penn State'], ['Georgia Tech B', 'Purdue'], ['Georgia Tech B', 'Maryland B'], ['Purdue', 'Maryland B'],
  // pool B: Yale A's upset ties Berkeley A, Michigan A and Yale A at 4–3 for places 3–5
  ['Yale A', 'Berkeley A']];
const top4 = A.slice(0, 4);
const winner = (a, b) => {
  const hit = WINS.find(([w, l]) => (w === a && l === b) || (w === b && l === a));
  if (hit) return hit[0];
  if (top4.includes(a) !== top4.includes(b)) return top4.includes(a) ? a : b;
  const order = A.includes(a) ? A : B;
  return order.indexOf(a) < order.indexOf(b) ? a : b;
};
// tossups each team converts: points per 20 Toronto A > UCLA > Minnesota
const STR = { 'Virginia Tech': 6, 'Toronto A': 8, UCLA: 6, Minnesota: 4, 'Penn State': 4, 'Georgia Tech B': 3, Purdue: 3, 'Maryland B': 2 };
B.forEach((t, i) => { STR[t] = 8 - Math.floor(i / 2); });
const players = ['Ada', 'Ben', 'Cy', 'Dee'];
// points per bonus, as at Nationals (pool B made up)
const PPB = { 'Virginia Tech': 14.66, 'Toronto A': 17.32, UCLA: 15.14, Minnesota: 13.73, 'Penn State': 12.76, 'Georgia Tech B': 12.78,
  Purdue: 11.32, 'Maryland B': 10.98 };
B.forEach((t, i) => { PPB[t] = 16 - i * 0.7; });
const side = (name, tens) => ({ team: { name }, bonus_points: Math.round(tens * PPB[name] / 10) * 10,
  match_players: players.map((p, k) => ({ player: { name: `${p} (${name})` }, tossups_heard: 20,
    answer_counts: k ? [] : [{ answer: { value: 10 }, number: tens }] })) });
const entries = [];
for (const r of built.phases[0].rounds.filter((x) => x.round < AT || AT === 7)) {
  for (const g of r.games) {
    const a = g.a.team, b = g.b.team, w = winner(a, b);
    const ta = STR[a] + (w === a ? 7 : 0), tb = STR[b] + (w === b ? 7 : 0);
    entries.push({ id: entries.length + 1, round: r.round, room: ROOMS[g.room],
      filename: `Round_${r.round}_${a}_${b}.qbj`, qbj: { tossups_read: 20, _round: r.round, match_teams: [side(a, ta), side(b, tb)] } });
  }
}
const last = Math.max(...built.phases.flatMap((p) => p.rounds.map((r) => r.round)));
const realPackets = Object.values(real.packets);
const packets = Object.fromEntries(Array.from({ length: last }, (_, i) => [i + 1, realPackets[i % realPackets.length]]));

export default {
  ...real,
  name: 'Fall Invitational',
  currentRound: AT,
  // as many rounds as the schedule (the regular demo's settings ask for more)
  settings: { ...real.settings, rounds: 0 },
  rooms: ROOMS,
  packets,
  roster: {
    version: '2.1.1',
    objects: [{ type: 'Tournament', name: 'Fall Invitational', registrations: [...A, ...B].map((name) => ({
      name, teams: [{ name, players: players.map((p) => ({ name: `${p} (${name})` })) }],
    })) }],
  },
  schedule: saved || built,
  scheduleKey: KEY,
  // the proposal: tiebreaker packets, apart from the rounds' (names only, in this mock)
  tbPacketsKey: 'tbMock6:packets',
  tbPackets: BUILT ? [] : ['Tiebreaker 1.docx', 'Tiebreaker 2.docx'],
  entries,
};
