// sidebar.js — the tournaments that are running on this instance and the
// ones that have run on it: the home page's sidebar and the archive list.
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
    teams, rounds, games }. */
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
    dot && !t.href ? ' <small>public page off</small>' : ''}</span><small>${esc(day(t.at))}</small>`;
  return t.href ? `<a class="it" href="${esc(t.href)}">${body}</a>` : `<span class="it">${body}</span>`;
};

/** Fill `el` with the rail (hub.css .railblock): what is live now, then
    the past tournaments, a year label above each year once there is more
    than one. Hidden when there is nothing to list. */
export async function renderSidebar(el) {
  const { live, past } = await tournamentLists();
  if (!live.length && !past.length) { el.hidden = true; return; }
  const years = [...new Set(past.map((t) => new Date(t.at).getFullYear()))];
  const pastHtml = years.map((y) =>
    (years.length > 1 ? `<div class="yr">${y}</div>` : '')
    + past.filter((t) => new Date(t.at).getFullYear() === y).map((t) => itemHtml(t)).join('')).join('');
  el.innerHTML =
    (live.length ? `<div class="railblock">
      <div class="railhead"><b>Live now</b><span class="muted">${live.length}</span></div>
      <div class="tlist">${live.map((t) => itemHtml(t, { dot: true })).join('')}</div></div>` : '')
    + (past.length ? `<div class="railblock">
      <div class="railhead"><b>Past tournaments</b><a href="archive.html">All</a></div>
      <div class="tlist">${pastHtml}</div></div>` : '');
  el.hidden = false;
}
