// Throwaway mock (mixed-rooms-hub.html): the demo tournament with 18
// teams (or ?teams=N) and a schedule from the new picker, before any game
// is played. The import map serves this in place
// of app/demo/fixture.js, so the real hub runs on it unchanged.
import real from '../app/demo/fixture.js?real';
import { buildCustom } from './mixed-rooms-custom.js';
import HDWHITE from './mixed-rooms-hdwhite.js';

// ?teams=N (the mock's Teams box): N teams, named from this list and then
// "Team 25", "Team 26", ...
const NAMES = ['Chicago A', 'Stanford A', 'Berkeley A', 'Michigan A', 'Penn A', 'Columbia A', 'Yale A', 'Harvard A',
  'Duke A', 'Illinois A', 'Maryland A', 'Rutgers A', 'Ohio State A', 'Cornell A', 'Brown A', 'Virginia A', 'UCLA A', 'Rice A',
  'Texas A', 'Purdue A', 'Emory A', 'Tufts A', 'Vanderbilt A', 'Georgia Tech A'];
const TEAMS_N = Math.max(4, Math.min(64, Number(new URLSearchParams(location.search).get('teams')) || 18));
const TEAMS = Array.from({ length: TEAMS_N }, (_, i) => NAMES[i] || 'Team ' + (i + 1));
// nine rooms, or one per two teams for a bigger field
const ROOMS = Array.from({ length: Math.max(9, Math.floor(TEAMS_N / 2)) }, (_, i) => 'Room ' + (101 + i));

// The schedule on file: the field's first hdwhite format that fits the
// rooms (else a round robin), built from a picker plan so Change format…
// opens on it (the mapping is the picker's: mixed-rooms-schededit.js
// phasesFor)
const phase = (name, o) => ({ name, kind: 'pools', groups: 1, top: 0, per: 1, pools: 1, cross: false, same: false, meets: 1, carry: true, reset: true,
  byes: false, sizes: null, parallelTop: false, share: false, n: 3, mode: 'rotate', ...o });
const hd = (HDWHITE[TEAMS_N] || []).find((f) => f.rooms <= ROOMS.length);
const phases = [];
if (hd) {
  for (let c = 0; c < hd.cycles; c++) {
    const one = hd.k === 1 && !hd.sizes;
    phases.push(phase(one ? (hd.cycles > 1 ? 'Round robin ' + (c + 1) : 'Round robin') : hd.cycles > 1 ? 'Prelims ' + (c + 1) : 'Prelims',
      { groups: hd.k, same: c > 0, byes: hd.byes }));
  }
  if (hd.sizes) phases.push(phase('Playoffs', { sizes: hd.sizes, parallelTop: hd.parallelTop, carry: hd.k > 1 && !hd.repeat }));
} else {
  // no hdwhite format for this field: pools of about 8, as the picker starts
  const k = TEAMS_N <= 16 ? 1 : Math.ceil(TEAMS_N / 8);
  phases.push(phase(k === 1 ? 'Round robin' : 'Prelims', { groups: k }));
}
const plan = { fmt: hd ? 'hd' + hd.key : 'custom', seeding: 'snake', phases };
const schedule = buildCustom(TEAMS, ROOMS.map((name, i) => ({ name, bucket: i + 1 })), plan.phases, plan.seeding, 1);
schedule.options = { seed: 1, plan };
schedule.updated = Date.now();

const players = ['Ada', 'Ben', 'Cy', 'Dee'];
export default {
  ...real,
  name: 'Fall Invitational',
  currentRound: 1,
  rooms: ROOMS,
  roster: {
    version: '2.1.1',
    objects: [{ type: 'Tournament', name: 'Fall Invitational', registrations: TEAMS.map((name) => ({
      name, teams: [{ name, players: players.map((p) => ({ name: `${p} (${name})` })) }],
    })) }],
  },
  schedule,
  entries: [],
};
