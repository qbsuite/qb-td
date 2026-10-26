// place.js — where the stats pages put what a link or Back brings the
// reader to: a little above the middle of the window, so the eye lands on
// it without travelling to the top edge. Something too tall for that (a
// long box score) starts near the top instead, so most of it shows.

const AIM = 0.4;   // the middle of what's shown sits 40% down the window
const TOP = 0.12;  // never higher than this, so a tall section keeps its head in view

/** The scroll position that shows a block whose top is `top` (page
    coordinates) and whose height is `height` that way. */
export function comfortY(top, height = 0) {
  const vh = window.innerHeight || 800;
  const above = Math.max(vh * TOP, vh * AIM - height / 2);
  return Math.max(0, Math.round(top - above));
}

/** Scroll so `el` is shown that way. */
export function comfortScroll(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  window.scrollTo(0, comfortY(r.top + window.scrollY, r.height));
}
