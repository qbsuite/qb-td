// announce.js — render the TO's broadcasts. Shared by the public page, the
// moderator bucket page, and the reader page.
//
// Every read surface receives the same shape from the Worker — {id, text,
// level, created}, already filtered to that audience and sorted alerts
// first — so all this module decides is how the message looks. Who else
// received it never leaves the Worker.

import { esc } from './api.js';

export function annTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Still-running messages, in the order every surface shows them: alerts
    first, then newest first. The Worker does this for the read surfaces;
    the dashboard, which holds the raw list, does it here. */
export function annLive(list, now = Date.now()) {
  return (list || [])
    .filter((a) => a && Number(a.expires) > now)
    .sort((x, y) => (x.level === y.level
      ? y.created - x.created
      : x.level === 'alert' ? -1 : 1));
}

/** Card stack for the public page and the bucket page. */
export function annCards(list, label) {
  return (list || []).map((a) => `
    <div class="ann${a.level === 'alert' ? ' alert' : ''}">
      <div class="annlabel">${esc(label)}</div>
      <div class="anntext">${esc(a.text)}</div>
      <div class="muted annmeta">posted ${esc(annTime(a.created))}</div>
    </div>`).join('');
}

/** Reader page: the newest message only, on one line. */
export function annStrip(list) {
  const a = (list || [])[0];
  if (!a) return '';
  return `<span class="k${a.level === 'alert' ? ' bad' : ''}">TD</span>
    <span>${esc(a.text)}</span>
    <span class="spacer" style="flex:1"></span>
    <span class="muted mono">${esc(annTime(a.created))}</span>`;
}
