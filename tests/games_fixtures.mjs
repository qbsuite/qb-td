// games_fixtures.mjs — the game sets the equivalence tests and benchmarks
// load: the three archive captures, the demo with two uploads, and
// synthetic variants that reach the corners of game loading (renames,
// re-exports, games dedupeEntries collapses, a file that won't parse, a
// live file list that moved rooms). Each fixture is
// { label, name, entries, files, rosterQbj, schedule, catmap, format }:
// entries in the public bundle's shape ({id, round, room, filename, qbj}),
// files the public state's live list ({id, round, room, filename}).
// Fresh copies on every call: the public page's loop writes rooms into
// the entries it is given.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE_SLUGS = JSON.parse(readFileSync(path.join(ROOT, 'app/archive/index.json'), 'utf8')).tournaments.map((t) => t.slug);

const clone = (x) => (x === undefined ? undefined : structuredClone(x));

export async function archiveFixture(slug) {
  const { default: data } = await import(pathToFileURL(path.join(ROOT, 'app/archive', slug + '.js')).href);
  const state = data[`/pub/${slug}`];
  return {
    label: 'archive:' + slug, name: state.name,
    entries: clone(data[`/pub/${slug}/bundle`].entries),
    files: clone(state.files || []),
    rosterQbj: clone(data[`/pub/${slug}/roster`] || null),
    schedule: clone(data[`/pub/${slug}/schedule`] || null),
    catmap: clone(data[`/pub/${slug}/cats`] || null),
    format: clone(state.format),
  };
}

// The demo's own data through demo.js (in-memory storage under Node), with
// two uploads made the way a room makes them: a reader upload of Room A's
// live round-7 game, and Room B's round-7 game re-exported as a bare .qbj.
let demoMod = null;
export async function demoFixture() {
  // Node's own localStorage global warns when demo.js looks for it and has
  // no methods without a flag; demo.js falls back to memory either way
  const ls = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (ls && ls.get && ls.configurable) Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
  demoMod ||= await import('../app/js/demo.js');
  const { default: fixture } = await import('../app/demo/fixture.js');
  const { demoPub, reset } = demoMod;
  reset();
  const sb = fixture.entries.find((e) => e.round === 4 && e.room === 'Room A').qbj;
  const live = { ...structuredClone(sb), _round: 7 };
  const reader = { qbj: live, game: { game: { players: [], cycles: [] }, uiState: {} },
    modaq: { qbj: JSON.stringify(live, null, 4), game: '{}' }, protests: [], progress: { at: 20, of: 20 } };
  await demoPub('/b/demo/upload?round=7&name=Round_7_Stanford_Berkeley.qbtd.json', { method: 'POST', body: JSON.stringify(reader) });
  const rb = fixture.entries.find((e) => e.round === 7 && e.room === 'Room B');
  await demoPub('/b/demo-b/upload?round=7&name=' + encodeURIComponent(rb.filename), { method: 'POST', body: JSON.stringify(rb.qbj, null, 2) });
  const state = await demoPub('/pub/demo');
  const bundle = await demoPub('/pub/demo/bundle');
  const out = {
    label: 'demo', name: state.name,
    entries: clone(bundle.entries),
    files: clone(state.files),
    rosterQbj: clone(fixture.roster),
    schedule: clone(fixture.schedule),
    catmap: clone(fixture.catmap),
    format: clone(state.format),
  };
  reset();
  return out;
}

// camelCase spellings only (qbj.js pick), as some exporters write them
function camel(m) {
  return {
    tossupsRead: m.tossups_read, _round: m._round,
    matchTeams: m.match_teams.map((mt) => ({
      team: { name: mt.team.name }, bonusPoints: mt.bonus_points,
      matchPlayers: (mt.match_players || []).map((mp) => ({ player: { name: mp.player.name }, tossupsHeard: mp.tossups_heard,
        answerCounts: (mp.answer_counts || []).map((ac) => ({ number: ac.number, answerType: { value: ac.answer.value } })) })),
    })),
  };
}

// teams named as strings rather than {name}
function stringTeams(m) {
  return { ...structuredClone(m), match_teams: m.match_teams.map((mt) => ({ ...structuredClone(mt), team: mt.team.name })) };
}

/** A roster QBJ text with renames: `teams` {old: new}, `players`
    {[team, old]: new} given as [[team, old, new]], names written \u-escaped
    when they hold anything past ASCII (the way some editors save them). */
export function renamedRosterText(rosterQbj, teams, players = []) {
  const r = structuredClone(rosterQbj);
  for (const reg of r.objects[0].registrations) {
    for (const tm of reg.teams) {
      const was = tm.name;
      for (const [team, old, now] of players) {
        if (team !== was) continue;
        const p = tm.players.find((x) => x.name === old);
        if (p) { p.name = now; p._formerNames = [old]; }
      }
      if (teams[was]) { tm.name = teams[was]; tm._formerNames = [was]; reg.name = teams[was]; }
    }
  }
  return JSON.stringify(r).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// The demo with every variant the design lists (E1 a-e) folded in.
export async function variantFixture() {
  const d = await demoFixture();
  const base = (id) => d.entries.find((e) => e.id === id);
  const entries = [...d.entries];
  // (b) a re-export of round 3's Stanford-UIUC game, teams swapped, newer id
  const swap = structuredClone(base(5));
  swap.id = 2001;
  swap.filename = 'Round_3_UIUC_Stanford.qbj';
  swap.qbj.match_teams.reverse();
  entries.push(swap);
  // (c) round 8: two camelCase-only games and two with string teams, which
  // dedupeEntries (by team names it can't read) collapses pairwise
  const r8 = (id, from, shape, room) => ({ id, round: 8, room, filename: `Round_8_${id}.qbj`,
    qbj: shape({ ...structuredClone(base(from).qbj), _round: 8 }) });
  entries.push(r8(2002, 1, camel, 'Room A'), r8(2003, 2, camel, 'Room B'),
    r8(2004, 3, stringTeams, 'Room A'), r8(2005, 4, stringTeams, 'Room B'));
  // (d) a file that won't parse
  entries.push({ id: 2006, round: 8, room: 'Room B', filename: 'Round_8_broken.qbj', qbj: { tossups_read: 20, match_teams: [] } });
  // (e) the live file list: rooms renamed or reassigned since the copies
  // were built, one room emptied (a deleted room: no override), and some
  // games not listed at all
  const files = entries.filter((e) => e.id % 3 !== 0).map((e) => ({ id: e.id, round: e.round, filename: e.filename,
    room: e.id === 4 ? '' : e.id % 2 ? 'Library' : e.room }));
  // (a) renames: two teams and a player, one of them \u-escaped
  const rosterText = renamedRosterText(d.rosterQbj, { Stanford: 'Stanford A', Berkeley: 'Cal Berkeley' },
    [['UIUC', 'Iris', 'Irène Duval']]);
  return {
    plain: { ...d, label: 'variants', entries: clone(entries), files: clone(files) },
    renamed: { ...d, label: 'variants+renames', entries: clone(entries), files: clone(files), rosterQbj: JSON.parse(rosterText), rosterText },
    noRoster: { ...d, label: 'variants, no roster', entries: clone(entries), files: clone(files), rosterQbj: null },
  };
}

/** Every fixture E1 pins, in a fixed order. */
export async function allFixtures() {
  const out = [];
  for (const slug of ARCHIVE_SLUGS) out.push(await archiveFixture(slug));
  out.push(await demoFixture());
  const v = await variantFixture();
  out.push(v.plain, v.renamed, v.noRoster);
  // an archive with its teams renamed: the renaming path at full size
  const terp = await archiveFixture(ARCHIVE_SLUGS[0]);
  const regs = terp.rosterQbj.objects[0].registrations;
  const ren = Object.fromEntries(regs.slice(0, 3).map((r) => [r.teams[0].name, r.teams[0].name + ' (renamed)']));
  const p0 = regs[3].teams[0];
  const text = renamedRosterText(terp.rosterQbj, ren, [[p0.name, p0.players[0].name, p0.players[0].name + ' Jr.']]);
  out.push({ ...terp, label: terp.label + '+renames', rosterQbj: JSON.parse(text), rosterText: text });
  return out;
}
