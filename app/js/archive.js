// archive.js — the archive page (archive.html?t=<slug>): one archived
// tournament, which a tournament becomes only when it is approved
// (tools/archive.mjs). It loads the frozen capture and hands off to the
// real pubview.js, so it is the same page the live one was, reading
// committed data instead of the Worker. The past tournaments are listed
// on the home page's rail (sidebar.js); with no slug this sends you there.

import { useFrozenData, esc } from './api.js';
import { fullDay } from './sidebar.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('t') || '';

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
    + `<a href="archive/${encodeURIComponent(entry.slug)}/standings.html">stat report</a>`;
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

if (!slug) {
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
