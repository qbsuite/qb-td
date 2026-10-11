// archive.js — the archive page (archive.html): the tournaments that have
// run here, and, with ?t=<slug>, one of the archived ones.
//
// The list is every past tournament (sidebar.js tournamentLists): the
// archived ones, which a tournament joins only when it is approved
// (tools/archive.mjs), and the ones the directory lists by use. Opening an
// archived one loads its frozen capture and hands off to the real
// pubview.js, so it is the same page the live one was, reading committed
// data instead of the Worker.

import { useFrozenData, esc } from './api.js';
import { tournamentLists, fullDay } from './sidebar.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('t') || '';

function say(text, bad) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A past tournament as one of the public page's filled cards. Archived:
// what was played, and its stat report. Named only: nothing to open.
function cardHtml(t) {
  const when = [fullDay(t.at), t.host].filter(Boolean).join(' · ');
  const name = t.href
    ? `<a class="aname" href="${esc(t.href)}">${esc(t.name)}</a>`
    : `<span class="aname">${esc(t.name)}</span>`;
  const meta = t.archived
    ? `${plural(t.teams, 'team')} · ${plural(t.rounds, 'round')} · ${plural(t.games, 'game')}<br>
       <a href="archive/${encodeURIComponent(t.slug)}/standings.html">Stat report</a>`
    : 'Results not public';
  return `<div class="acard"><div class="groom">${esc(when)}</div>${name}<div class="ameta">${meta}</div></div>`;
}

async function renderList() {
  document.title = 'qb-td: past tournaments';
  const { past } = await tournamentLists();
  if (!past.length) {
    say('No tournaments yet.');
    return;
  }
  $('archsub').textContent = plural(past.length, 'tournament');
  const years = [...new Set(past.map((t) => new Date(t.at).getFullYear()))];
  let year = 0; // 0: all
  const draw = () => {
    const shown = past.filter((t) => !year || new Date(t.at).getFullYear() === year);
    const view = (y, label) => `<a href="#" class="view${year === y ? ' on' : ''}" data-year="${y}"${
      year === y ? ' aria-current="true"' : ''}>${label}</a>`;
    $('out').innerHTML = `
      <div class="views"><a href="index.html">Home</a><span class="grow"></span>
        ${years.length > 1 ? view(0, 'All') + years.map((y) => view(y, y)).join('') : ''}</div>
      <div class="acards">${shown.map(cardHtml).join('')}</div>`;
    $('out').querySelectorAll('[data-year]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); year = Number(a.dataset.year); draw(); };
    });
  };
  draw();
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
    + '<a href="archive.html">all tournaments</a> '
    + `<a href="archive/${encodeURIComponent(entry.slug)}/standings.html">stat report</a>`;
  document.body.prepend(strip);
}

async function openTournament(entry) {
  // The slug came from the manifest, not from the query string, so the
  // import path below is ours rather than the visitor's.
  const { default: data } = await import(`../archive/${entry.slug}.js`);
  useFrozenData(data);

  // From here down it is the public page as it was on the day (minus
  // buzzpoints, which need the packet password and are never archived).
  archivedStrip(entry);
  $('tabs').hidden = false;

  await import('./pubview.js');
}

const index = await (await fetch('archive/index.json')).json();

if (!slug) {
  await renderList();
} else {
  const entry = index.tournaments.find((t) => t.slug === slug);
  if (!entry) {
    $('tname').textContent = 'Not archived';
    say('That tournament is not in the archive.', true);
    $('out').innerHTML = '<a href="archive.html">All tournaments</a>';
  } else {
    await openTournament(entry);
  }
}
