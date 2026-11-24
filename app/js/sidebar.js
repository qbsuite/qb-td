// sidebar.js — the tournaments that are running on this instance and the
// ones that have run on it: the home page's sidebar.
//
// Two sources:
//   live — the directory (worker.js "the directory", read through api.js):
//     what is running now, listed by use. An entry has a slug only while
//     its TD has the public page on; without one the tournament is named
//     but not linked.
//   past — the archive (archive/index.json), which a tournament joins only
//     with the operator's approval (tools/archive.mjs): `tournaments`, the
//     frozen captures, each linked to its capture; and `named`, tournaments
//     approved to be listed by name and date with nothing to open.

import { directory, esc } from './api.js';

const DAY_FMT = { month: 'short', day: 'numeric' };
const day = (ms) => new Date(ms).toLocaleDateString(undefined, DAY_FMT);
export const fullDay = (ms) => new Date(ms).toLocaleDateString(undefined, { ...DAY_FMT, year: 'numeric' });
// An archive date is a calendar day ("2026-10-03"), not an instant: read
// it in local time so it doesn't slide back a day west of Greenwich.
const dateMs = (s) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(s));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(s) || 0;
};

async function archiveIndex() {
  try {
    const res = await fetch(new URL('archive/index.json', document.baseURI));
    return res.ok ? await res.json() : {};
  } catch (e) { return {}; }
}

/** { live, past }: live is what's running now, past is newest first.
    Items: { name, at, href (null: not linked), slug, host, archived,
    teams, rounds, games, set, site }. set: the question set an archived
    one used (''), site: its label among that set's sites. */
export async function tournamentLists(now = Date.now()) {
  const [dir, index] = await Promise.all([directory(), archiveIndex()]);
  const live = (dir.t || []).filter((e) => now < e.c).map((e) => ({
    name: e.n, at: e.d, slug: e.s, host: '', archived: false,
    href: e.s ? 't.html?t=' + encodeURIComponent(e.s) : null,
  }));
  const past = [
    ...(index.tournaments || []).map((t) => ({
      name: t.name, at: dateMs(t.date), href: 'archive.html?t=' + encodeURIComponent(t.slug),
      slug: t.slug, host: t.host || '', archived: true, teams: t.teams, rounds: t.rounds, games: t.games,
      set: t.set || '', site: t.site || '',
    })),
    ...(index.named || []).map((t) => ({
      name: t.name, at: dateMs(t.date), href: null, slug: null, host: t.host || '', archived: false,
    })),
  ].sort((a, b) => b.at - a.at);
  return { live, past };
}

// name, with its date at the right; a live one that isn't linked says why
const itemHtml = (t, { dot } = {}) => {
  const body = `<span>${dot ? '<span class="dot"></span>' : ''}${esc(t.name)}${
    dot && !t.href ? ' <small>player page off</small>' : ''}</span><small>${esc(day(t.at))}</small>`;
  return t.href ? `<a class="it" href="${esc(t.href)}">${body}</a>` : `<span class="it">${body}</span>`;
};

// A set with more than one site here: its name and how many sites, then
// each site on its own line with its day, newest first like the rest of
// the list (same day: name order), hung off a rule
// so it reads as one group.
const setHtml = (name, sites) => {
  const label = (t) => t.site || t.host || t.name;
  const rows = [...sites].sort((a, b) => b.at - a.at || label(a).localeCompare(label(b)))
    .map((t) => itemHtml({ ...t, name: label(t) })).join('');
  return `<div class="itset"><a class="sethead" href="archive.html?set=${encodeURIComponent(name)}"><span>${esc(name)}</span><small>${sites.length} sites</small></a>
    <div class="sites">${rows}</div></div>`;
};

// Past tournaments in date order, a set's sites folded into one entry
// where the newest of them falls.
const pastItems = (past) => {
  const bySet = new Map();
  for (const t of past) if (t.set) bySet.set(t.set, [...(bySet.get(t.set) || []), t]);
  const placed = new Set();
  return past.map((t) => {
    const sites = t.set && bySet.get(t.set);
    if (!sites || sites.length < 2) return { at: t.at, html: itemHtml(t) };
    if (placed.has(t.set)) return null;
    placed.add(t.set);
    return { at: t.at, html: setHtml(t.set, sites) };
  }).filter(Boolean);
};

// For the search: lower case, accents folded, one space between words.
const fold = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The past tournaments a search keeps: each word somewhere in a
    tournament's name, host, set or site. A set's name keeps all its
    sites; a site's own name keeps just that one. */
export function searchPast(past, query) {
  const words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return past;
  return past.filter((t) => {
    const hay = fold([t.name, t.host, t.set, t.site].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

const SEARCH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>';

// the past list, a year label above each year once there is more than one
function pastHtml(past) {
  const items = pastItems(past);
  if (!items.length) return '<div class="none muted">No matches</div>';
  const years = [...new Set(items.map((t) => new Date(t.at).getFullYear()))];
  return years.map((y) =>
    (years.length > 1 ? `<div class="yr">${y}</div>` : '')
    + items.filter((t) => new Date(t.at).getFullYear() === y).map((t) => t.html).join('')).join('');
}

/** Fill `el` with the rail (hub.css .railblock): what is live now, then
    the past tournaments (a set's sites as one entry), which a search
    narrows (searchPast). Hidden when there is nothing to list. */
export async function renderSidebar(el) {
  const { live, past } = await tournamentLists();
  if (!live.length && !past.length) { el.hidden = true; return; }
  // the search: an icon beside the heading that opens the field in its place
  const head = `<div class="railhead pasthead"><b>Past tournaments</b><button class="linkbtn muted searchbtn" aria-label="Search past tournaments" title="Search">${SEARCH_ICON}</button>
    <input type="search" class="railsearch" placeholder="Search" aria-label="Search past tournaments" autocomplete="off" spellcheck="false" hidden></div>`;
  el.innerHTML =
    (live.length ? `<div class="railblock">
      <div class="railhead"><b>Live now</b><span class="muted">${live.length}</span></div>
      <div class="tlist">${live.map((t) => itemHtml(t, { dot: true })).join('')}</div></div>` : '')
    + (past.length ? `<div class="railblock pastblock">${head}
      <div class="tlist" id="pastlist">${pastHtml(past)}</div></div>` : '');
  el.hidden = false;
  const input = el.querySelector('.railsearch');
  if (!input) return;
  const list = el.querySelector('#pastlist');
  const blk = el.querySelector('.pastblock');
  const btn = el.querySelector('.searchbtn');
  const close = () => { blk.classList.remove('searching'); input.hidden = true; };
  btn.onclick = () => { blk.classList.add('searching'); input.hidden = false; input.focus(); };
  input.addEventListener('input', () => { list.innerHTML = pastHtml(searchPast(past, input.value)); });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    // Esc clears the search, and a second one puts the heading back
    if (input.value) { input.value = ''; input.dispatchEvent(new Event('input')); } else { close(); btn.focus(); }
  });
  input.addEventListener('blur', () => { if (!input.value) close(); });
}
