// archive.js — the archive page (archive.html?t=<slug>): one archived
// tournament, which a tournament becomes only when it is approved
// (tools/archive.mjs). It loads the frozen capture and hands off to the
// real pubview.js, so it is the same page the live one was, reading
// committed data instead of the Worker. The past tournaments are listed
// on the home page's rail (sidebar.js); with no slug this sends you there.
//
// archive.html?set=<name> is a set's archived sites together (the index's
// `set`): the question-set page's own view (setview.js) over their
// captures, each site as a mirror.

import { useFrozenData, esc } from './api.js';
import { fullDay } from './sidebar.js';
import { parseRoster, rosterNameMap } from '../engine/qbj.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const slug = params.get('t') || '';
const setName = params.get('set') || '';

function say(text, bad) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

// The same thin strip the demo wears (td.css .annstrip), saying what this
// page is: final results, with the ways out.
function archivedStrip(entry) {
  const strip = document.createElement('div');
  strip.className = 'annstrip';
  const when = [fullDay(new Date(entry.date + 'T12:00:00').getTime()), entry.host].filter(Boolean).join(' · ');
  strip.innerHTML = '<span class="k">archived</span>'
    + `<span class="muted">final results · ${esc(when)}</span>`
    + '<span class="spacer" style="flex:1"></span>'
    + '<a href="index.html">home</a> '
    + `<a href="archive/${encodeURIComponent(entry.slug)}/standings.html">stat report</a> `
    // pubview.js answers it: the zip the hub's HTML report download gives
    + '<a href="#" data-dlreport>download report</a>';
  document.body.prepend(strip);
}

async function openTournament(entry) {
  // The slug came from the manifest, not from the query string, so the
  // import path below is ours rather than the visitor's.
  const { default: data } = await import(`../archive/${entry.slug}.js`);
  // Released question text (tools/archive.mjs captureTexts) lives in its
  // own files: each path resolves to a fetch of its file, on first use.
  for (const [path, file] of Object.entries(data.__text || {})) {
    let got = null;
    Object.defineProperty(data, path, {
      enumerable: true,
      get: () => (got ||= fetch(`archive/${file}`).then((r) => {
        if (!r.ok) throw new Error('not available in this archived copy');
        return r.json();
      }).catch((e) => { got = null; throw e; })),
    });
  }
  useFrozenData(data);

  // From here down it is the public page as it was on the day (minus
  // buzzpoints, which need the packet password and are never archived).
  archivedStrip(entry);
  $('tabs').hidden = false;

  await import('./pubview.js');
}

/* ---------- a set's sites ---------- */

// An archived site played packets as a tournament does, by round, with
// no set behind it to say which packet that was. A round's category map
// stands in: sites whose round N maps match read the same packet there,
// and a site whose map differs (a playtest, an edited packet) read
// another version of it, numbered oldest site first. The set's current
// version of a packet is the one its newest site read.
function setSource(entries, captures) {
  const versions = new Map();      // round -> [category map JSON, ...] in version order
  const order = entries.map((e, i) => i).sort((a, b) => entries[a].date.localeCompare(entries[b].date));
  const vmaps = entries.map(() => ({}));
  for (const i of order) {
    const rounds = (captures[i]['/pub/' + entries[i].slug + '/cats'] || {}).rounds || {};
    for (const [n, map] of Object.entries(rounds)) {
      const key = JSON.stringify(map);
      if (!versions.has(n)) versions.set(n, []);
      const list = versions.get(n);
      if (!list.includes(key)) list.push(key);
      vmaps[i][n] = [Number(n), list.indexOf(key) + 1];
    }
  }
  // With no text to match questions by, a slot that keeps its category
  // from one version to the next is taken for the same question (setstats.js
  // identOf reads these `q` maps); a changed one is a new question.
  const packets = {};
  const current = {};
  let qid = 0;
  for (const [n, list] of versions) {
    const maps = list.map((key) => JSON.parse(key));
    for (const kind of ['t', 'b']) {
      const ids = [];   // slot -> [[category, id], ...] seen so far
      maps.forEach((map, v) => {
        map.q = map.q || {};
        map.q[kind] = (map[kind] || []).map((e, i) => {
          const cat = JSON.stringify([e && e.c, e && e.s]);
          const seen = (ids[i] ||= []).find(([c]) => c === cat);
          if (seen) return [seen[1], v + 1];
          ids[i].push([cat, ++qid]);
          return [qid, v + 1];
        });
      });
    }
    packets[n] = Object.fromEntries(maps.map((map, v) => [v + 1, map]));
    current[n] = vmaps[order[order.length - 1]][n] ? vmaps[order[order.length - 1]][n][1] : list.length;
  }

  const games = captures.map((c, i) => ((c['/pub/' + entries[i].slug + '/bundle'] || {}).entries || []));
  const mirrors = entries.map((e, i) => {
    let names = null;
    try {
      const map = rosterNameMap(parseRoster(captures[i]['/pub/' + e.slug + '/roster']));
      if (map) names = { teams: Object.fromEntries(map.teams), players: Object.fromEntries(map.players) };
    } catch (err) { /* no roster in this capture: the games keep their own names */ }
    const played = [...new Set(games[i].map((g) => String(g.round)))];
    return {
      id: i + 1, slug: e.slug, label: e.site || e.host || e.name, host: e.host || '', date: e.date,
      rounds: Object.fromEntries(played.map((n) => [n, 'a'])),
      vmap: vmaps[i], done: played.map(Number), names,
    };
  });

  return {
    gated: true,
    // the newest site's reader format: it says how many tossups a game has
    state: async () => ({ name: setName, mirrors, cats: 'a', packets: current, buzz: null,
      format: (captures[order[order.length - 1]]['/pub/' + entries[order[order.length - 1]].slug] || {}).format }),
    async rounds(mirrorId, q) {
      const wanted = q.split(',').map((x) => x.split('@')[0]);
      const mine = games[mirrorId - 1];
      return { rounds: wanted.map((n) => ({ round: Number(n), v: 'a', entries: mine.filter((g) => String(g.round) === n) })) };
    },
    cats: async () => ({ packets }),
    // buzzpoints read packet text, which no capture carries
    packet: async () => { throw new Error('not archived'); },
    unlocked: () => false,
    lock: () => {},
    unlock: async () => { throw new Error('not archived'); },
    mirrorLink: (m) => 'archive.html?t=' + encodeURIComponent(m.slug),
  };
}

async function openSet(entries) {
  document.title = setName;
  $('tname').textContent = setName;
  $('round').hidden = false;
  $('round').textContent = entries.length + ' sites';
  const captures = await Promise.all(entries.map(async (e) => (await import(`../archive/${e.slug}.js`)).default));
  const strip = document.createElement('div');
  strip.className = 'annstrip';
  strip.innerHTML = '<span class="k">archived</span>'
    + '<span class="muted">final results · every site</span>'
    + '<span class="spacer" style="flex:1"></span>'
    + '<a href="index.html">home</a>';
  document.body.prepend(strip);
  const { mountSetView } = await import('./setview.js');
  mountSetView($('out'), setSource(entries, captures));
}

if (setName) {
  const index = await (await fetch('archive/index.json')).json();
  // newest first, as the rail lists them
  const entries = index.tournaments.filter((t) => t.set === setName).sort((a, b) => b.date.localeCompare(a.date));
  if (!entries.length) {
    $('tname').textContent = 'Not archived';
    say('That set is not in the archive.', true);
    $('out').innerHTML = '<a href="index.html">Home</a>';
  } else {
    await openSet(entries);
  }
} else if (!slug) {
  location.replace('index.html');
} else {
  const index = await (await fetch('archive/index.json')).json();
  const entry = index.tournaments.find((t) => t.slug === slug);
  if (!entry) {
    $('tname').textContent = 'Not archived';
    say('That tournament is not in the archive.', true);
    $('out').innerHTML = '<a href="index.html">Home</a>';
  } else {
    await openTournament(entry);
  }
}
