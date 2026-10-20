// saves.js — how the TD hub (admin.js) saves what two of its tabs can
// both edit: the settings, the protest rulings, the schedule and the
// roster. Each save says which copy the tab edited, so a save from a tab
// whose copy is out of date keeps the other tab's change instead of
// writing over it (worker.js updateGuarded, putSchedule, uploadRoster).
// A tab whose copy is current gets what a save without one gets, from
// the same requests.
//
// - Settings and rulings: the copy rides in the save's JSON body. The
//   settings text the tab's copy was read as (settings_base), with the
//   keys it sets or clears whatever its copy held (settings_touched); the
//   rulings it changes, as its copy had them (rulings_prev). The Worker
//   puts a stale tab's changes onto what is stored, so these never ask.
// - The schedule and the roster are whole files. A save names the stored
//   copy it edited (its R2 etag, which the Worker sends as X-Qbtd-Etag on
//   the hub's own read) and lands only on that copy. Refused, the answer
//   is {ok: false, conflict: true, etag, schedule?}: the copy stored now
//   (schedule and etag null when it was deleted), and the hub decides
//   (SCHED_CONFLICT, ROSTER_CONFLICT). The schedule's etag rides in a
//   header on a POST that is already preflighted for its JSON body; the
//   roster's in the query of a simple text/plain POST, so neither adds a
//   request.
// A copy with no etag (none stored, the demo, a Worker from before) sends
// no base, and the save is the plain one it always was.

import { API, pub, usingStaticData } from './api.js';

// The game format is the preset and its overrides together: a format save
// sets both, whatever the tab's copy held (worker.js mergeSettings).
export const FORMAT_KEYS = ['gameFormat', 'formatOverrides'];

export const SCHED_CONFLICT = 'The schedule was changed in another tab, or its playoff slots were filled, after this '
  + 'page loaded it. Would you like to save your version anyway? It will replace the other one. Choose Cancel to keep '
  + 'your edits here without saving.';
export const SCHED_KEPT = 'The schedule was changed in another tab. Your edits are still here.';
export const ROSTER_CONFLICT = 'The roster was saved in another tab after this page loaded it. Would you like to save '
  + 'your version anyway? It will replace the other one. Choose Cancel to keep your version here without saving.';
export const ROSTER_KEPT = 'Roster not saved. Your edits are still here.';

/** pub(path) for a GET, as {data, etag}: the same request, answer and
    errors, plus the X-Qbtd-Etag the Worker sends on the raw schedule and
    roster reads (null when it sends none). */
export async function pubTagged(path) {
  if (usingStaticData()) return { data: await pub(path), etag: null };
  const res = await fetch(API + path, {});
  const etag = res.headers.get('X-Qbtd-Etag');
  const failed = (message) => Object.assign(new Error(message), { status: res.status });
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw failed('request failed (' + res.status + ')');
    return { data: res, etag };
  }
  const data = await res.json();
  if (!res.ok) throw failed(data.error || 'request failed (' + res.status + ')');
  return { data, etag };
}

/** A stored file read as hubgames.js ownedJson reads it, with the etag
    of the copy read: {json, etag}. It throws where ownedJson throws. */
export async function readTagged(a, key) {
  const { data, etag } = await pubTagged(`${a}/file?key=${encodeURIComponent(key)}`);
  return { json: data instanceof Response ? JSON.parse(await data.text()) : data, etag };
}

const hasBase = (etag) => typeof etag === 'string' && etag !== '';

/** A settings save's body. prev: the object `next` was made from (the
    tab's copy, as read); touched: keys `next` sets or clears whatever prev
    held; extra: the rest of the body (buzz_token). */
export function settingsBody(prev, next, extra = {}, touched = []) {
  return { settings: next, settings_base: JSON.stringify(prev),
    ...(touched.length ? { settings_touched: touched } : {}), ...extra };
}

/** A rulings save's body: the whole map, and each ruling in `keys` as the
    tab's copy (prev) had it, null for none. */
export function rulingsBody(prev, next, keys) {
  const was = {};
  for (const k of keys) was[k] = Object.prototype.hasOwnProperty.call(prev, k) ? prev[k] : null;
  return { rulings: next, rulings_prev: was };
}

/** Save the schedule onto the stored copy `etag` names (none: as before).
    Answers {ok, brackets, etag} or {ok: false, conflict: true, etag,
    schedule}. */
export function postSchedule(a, s, etag) {
  return pub(a + '/schedule', hasBase(etag)
    ? { method: 'POST', json: s, headers: { 'X-Qbtd-Base': etag } } : { method: 'POST', json: s });
}

/** Save the roster (body: its text) onto the stored copy `etag` names.
    Answers {filename, etag} or {ok: false, conflict: true, etag}. */
export function postRoster(a, name, body, etag) {
  return pub(`${a}/roster?name=${encodeURIComponent(name)}` + (hasBase(etag) ? '&base=' + encodeURIComponent(etag) : ''),
    { method: 'POST', body });
}
