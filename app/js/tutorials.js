// tutorials.js — the tutorial videos: tutorials.html, and the line of
// links to them under the home page's create form. The list is
// app/tutorials.json ({ videos: [{ id, title }] }: a YouTube video id
// each, in the playlist's order). An empty list shows no videos anywhere.
//
// Nothing is loaded from YouTube until a video is played: a video shows
// as its thumbnail, and pressing play swaps in the player. The pages send
// no referrer (their <meta name="referrer">), which YouTube's player
// refuses to start without, so the player's frame sends the origin
// (referrerpolicy).

import { esc } from './api.js';

export async function loadVideos() {
  try {
    const res = await fetch(new URL('tutorials.json', document.baseURI), { cache: 'no-cache' });
    const data = res.ok ? await res.json() : {};
    return (data.videos || []).filter((v) => v && v.title);
  } catch (e) { return []; }
}

const PLAY = '<svg viewBox="0 0 68 48" aria-hidden="true"><rect width="68" height="48" rx="12"/><path d="M27 15v18l16-9z"/></svg>';

/** A video's thumbnail with a play mark: a button that plays it (play()),
    or, with { tag: 'span' }, a picture inside some other control. No id
    yet: a blank frame. */
export function thumbHtml(v, { tag = 'button' } = {}) {
  const img = v.id ? `<img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy">` : '';
  const attrs = tag === 'button' ? ` data-vid="${esc(v.id || '')}" data-title="${esc(v.title)}" aria-label="Play ${esc(v.title)}"` : '';
  return `<${tag} class="vthumb"${attrs}>${img}<span class="vplay">${PLAY}</span></${tag}>`;
}

/** Swap a thumbnail button (.vthumb) for the player. */
export function play(btn) {
  const box = document.createElement('div');
  box.className = 'vframe';
  const id = btn.dataset.vid;
  if (id) {
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`;
    f.title = btn.dataset.title || '';
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    box.append(f);
  } else box.innerHTML = `<span class="vplay">${PLAY}</span>`;
  btn.replaceWith(box);
  return box;
}

/** The home page's line under the create form: Tutorials, then each
    video's title, each opening it on tutorials.html. '' with none. */
export function lineHtml(videos) {
  if (!videos.length) return '';
  return `<div class="vline"><a href="tutorials.html"><b>Tutorials</b></a>${
    videos.map((v, i) => `<a href="tutorials.html?v=${i + 1}">${esc(v.title)}</a>`).join('')}</div>`;
}

/** Fill tutorials.html's #vids: the player up top, every video listed
    under it; picking one plays it up top. ?v=N (1-based) starts on the
    Nth. Hidden with no videos. */
export function renderTutorials(el, videos, start = 0) {
  if (!videos.length) { el.hidden = true; return; }
  const box = el.querySelector('.vmain');
  const title = el.querySelector('.vmaintitle');
  const list = el.querySelector('.vlist');
  list.innerHTML = videos.map((v, i) => `<li><button class="vrow" data-i="${i}">${thumbHtml(v, { tag: 'span' })}<span class="vtitle">${esc(v.title)}</span></button></li>`).join('');
  const at = (i) => {
    box.innerHTML = thumbHtml(videos[i]);
    title.textContent = videos[i].title;
    list.querySelectorAll('.vrow').forEach((r, k) => {
      r.classList.toggle('on', k === i);
      if (k === i) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
    });
  };
  at(Math.min(Math.max(0, start), videos.length - 1));
  box.addEventListener('click', (e) => { const b = e.target.closest('.vthumb'); if (b) play(b); });
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.vrow');
    if (!r) return;
    at(Number(r.dataset.i));
    play(box.querySelector('.vthumb'));
    box.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  el.hidden = false;
}
