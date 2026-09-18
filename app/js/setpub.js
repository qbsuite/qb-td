// setpub.js — the public set page (s.html?s=<slug>): setview.js over the
// publish-gated /pubset routes. Buzzpoint text sits behind the set's
// password exactly as a tournament's does (buzzkey.js): the browser
// stretches it once, keeps only the derived key for the session, and
// drops it when the editor sets a new one (buzz_v moves).

import { pub } from './api.js';
import { buzzToken } from './buzzkey.js';
import { mountSetView } from './setview.js';
import { readPacket } from './buzzview.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('s') || '';
const BUZZ_KEY = 'qbtdSetBuzzKey:' + slug;
const base = '/pubset/' + slug;

function stored() {
  try {
    const s = JSON.parse(sessionStorage.getItem(BUZZ_KEY));
    return s && typeof s.tok === 'string' ? s : null;
  } catch (e) { return null; }
}

const packet = async (number, v, tok) => readPacket(
  await pub(`${base}/qpacket?packet=${number}&v=${v}`, { headers: { Authorization: 'Buzz ' + tok } }),
  'packet ' + number);

const source = {
  gated: true,
  async state() {
    // no-cache for the same reason as the tournament page: with nothing
    // polling, the refresh button must never be answered from the
    // browser's own max-age'd copy
    const state = await pub(base, { cache: 'no-cache' });
    document.title = state.name;
    $('sname').textContent = state.name;
    const n = (state.mirrors || []).length;
    $('sites').textContent = n + ' site' + (n === 1 ? '' : 's');
    const s = stored();
    if (s && s.v !== state.buzz_v) sessionStorage.removeItem(BUZZ_KEY);
    return state;
  },
  rounds: (mirrorId, q) => pub(`${base}/rounds?m=${mirrorId}&n=${q}`),
  cats: (stamp) => pub(`${base}/cats?v=${stamp}`),
  packet: (number, v) => packet(number, v, (stored() || {}).tok),
  unlocked: () => !!stored(),
  lock: () => sessionStorage.removeItem(BUZZ_KEY),
  // `probe` is a packet version that should open; a rejected key must not be kept
  async unlock(pw, state, probe) {
    if (!pw) throw new Error('enter the password');
    const tok = await buzzToken(pw, state.buzz_kdf);
    if (probe) {
      try { await packet(probe.packet, probe.v, tok); }
      catch (e) {
        const m = String(e.message);
        if (m.includes('bad password') || m.includes('too many')) throw new Error(m.includes('too many') ? m : 'bad password');
      } // anything else (no packet, parser down): let the tab render what it can
    }
    sessionStorage.setItem(BUZZ_KEY, JSON.stringify({ tok, v: state.buzz_v }));
  },
  mirrorLink: (m) => (m.page ? 't.html?t=' + encodeURIComponent(m.slug) : ''),
};

if (!slug) {
  $('msg').textContent = 'bad link';
  $('msg').className = 'bad';
} else {
  const wanted = (location.hash || '').replace('#', '');
  const view = mountSetView($('view'), source, {
    tab: ['stats', 'cats', 'buzz'].includes(wanted) ? wanted : 'stats',
    onTab: (tab) => history.replaceState(null, '', '#' + tab),
  });
  $('refresh').onclick = () => view.refresh();
}
