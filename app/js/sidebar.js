// sidebar.js — the tournaments that are running on this instance and the
// ones that have run on it: the home page's sidebar, the archive list and
// the sidebar beside an archived tournament.
//
// Two sources, merged here:
//   the directory  (worker.js "the directory", read through api.js) — what
//     is live now and what has been played, listed by use. An entry has a
//     slug only while its TD has the public page on; without one the
//     tournament is named but not linked.
//   the archive    (archive/index.json) — the approved, frozen captures.
//     An archived tournament links to its capture rather than to the live
//     page, and carries its host and counts.

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
    return res.ok ? (await res.json()).tournaments || [] : [];
  } catch (e) { return []; }
}

/** { live, past }: live is what's running now, past is newest first.
    Items: { name, at, href (null: not linked), slug, host, archived,
    teams, rounds, games }. */
export async function tournamentLists(now = Date.now()) {
  const [dir, archive] = await Promise.all([directory(), archiveIndex()]);
  const archived = new Set(archive.map((t) => t.slug));
  const live = [];
  const past = archive.map((t) => ({
    name: t.name, at: dateMs(t.date), href: 'archive.html?t=' + encodeURIComponent(t.slug),
    slug: t.slug, host: t.host || '', archived: true, teams: t.teams, rounds: t.rounds, games: t.games,
  }));
  for (const e of dir.t || []) {
    const item = {
      name: e.n, at: e.d, slug: e.s, host: '', archived: false,
      href: e.s ? 't.html?t=' + encodeURIComponent(e.s) : null,
    };
    if (now < e.c) { if (e.live) live.push(item); }
    // the archived capture stands in for the live page it was taken from
    else if (e.past && !(e.s && archived.has(e.s))) past.push(item);
  }
  past.sort((a, b) => b.at - a.at);
  return { live, past };
}

const itemHtml = (t, { current, dot }) => {
  const sub = [day(t.at), t.host, t.href ? '' : 'public page off'].filter(Boolean).join(' · ');
  const body = `${dot ? '<span class="dot"></span>' : ''}${esc(t.name)}<small>${esc(sub)}</small>`;
  if (current && t.slug === current) return `<span class="it on" aria-current="page">${body}</span>`;
  return t.href ? `<a class="it" href="${esc(t.href)}">${body}</a>` : `<span class="it">${body}</span>`;
};

/** Fill `el` with the sidebar. current: the slug of the tournament on
    screen, shown as where you are rather than as a link. */
export async function renderSidebar(el, { current = '' } = {}) {
  const { live, past } = await tournamentLists();
  if (!live.length && !past.length) { el.hidden = true; return; }
  const years = new Map();
  for (const t of past) {
    const y = new Date(t.at).getFullYear();
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(t);
  }
  el.innerHTML =
    (live.length ? `<div class="sh">Live now</div>${live.map((t) => itemHtml(t, { current, dot: true })).join('')}` : '')
    + [...years].map(([y, list]) =>
      `<div class="sh">${y}</div>${list.map((t) => itemHtml(t, { current })).join('')}`).join('');
  el.hidden = false;
}
