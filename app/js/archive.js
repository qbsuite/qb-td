// archive.js — the archive page (archive.html): a curated list of past
// tournaments, and, with ?t=<slug>, one of them.
//
// The list comes from archive/index.json, which a tournament joins only
// when it is approved (tools/archive.mjs). Opening one loads its frozen
// capture and hands off to the real pubview.js, so an archived tournament
// is the same page the live one was, reading committed data instead of the
// Worker.

import { useFrozenData, esc } from './api.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('t') || '';

function say(text, bad) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderList(tournaments) {
  document.title = 'qb-td archive';
  if (!tournaments.length) {
    say('No tournaments yet.');
    return;
  }
  $('out').innerHTML = tournaments.map((t) => `
    <div class="card">
      <div class="row">
        <a href="?t=${encodeURIComponent(t.slug)}"><strong>${esc(t.name)}</strong></a>
        <span class="spacer"></span>
        <a class="muted" href="archive/${encodeURIComponent(t.slug)}/standings.html">stat report</a>
      </div>
      <div class="muted" style="font-size:13px;margin-top:4px">
        ${esc(t.date)}${t.host ? ' · ' + esc(t.host) : ''} ·
        ${plural(t.teams, 'team')} · ${plural(t.rounds, 'round')} · ${plural(t.games, 'game')}
      </div>
    </div>`).join('');
}

async function openTournament(entry) {
  // The slug came from the manifest, not from the query string, so the
  // import path below is ours rather than the visitor's.
  const { default: data } = await import(`../archive/${entry.slug}.js`);
  useFrozenData(data);

  $('archbar').hidden = false;
  $('reportlink').href = `archive/${encodeURIComponent(entry.slug)}/standings.html`;
  $('tabs').hidden = false;
  // pubview writes the live round into #round, which means nothing once a
  // tournament is over; the banner carries the date instead.
  $('round').hidden = true;
  $('archsub').textContent = entry.date + (entry.host ? ' · ' + entry.host : '');

  await import('./pubview.js');
}

const index = await (await fetch('archive/index.json')).json();

if (!slug) {
  renderList(index.tournaments);
} else {
  const entry = index.tournaments.find((t) => t.slug === slug);
  if (!entry) {
    $('tname').textContent = 'not archived';
    say('That tournament is not in the archive.', true);
    $('out').innerHTML = '<a href="archive.html">all tournaments</a>';
  } else {
    await openTournament(entry);
  }
}
