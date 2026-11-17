// buzzer_hub.js — the TD's buzzer settings, drawn inside the hub's Rooms
// step (admin.js renderRoomsSec): an Online tournament switch, the buzzer
// password, and a Buzzer checkbox on each room (all ticked, and locked,
// while the switch is on). They are one settings key, saved whole:
//   settings.buzzer = { online: boolean, rooms: [room ids], pw: string }
// The password is not the stats password: the TD sees it and copies it.
//

import { esc } from './api.js';

let changing = false;   // the password field is open

const COPY = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';

/** The tournament's buzzer settings ({online, rooms, pw}) from its
    settings object (all off when it has none). A room that is gone (not in
    `buckets`) is left out, so the next save drops it. */
export function buzzerOf(settings, buckets) {
  const has = !!settings && Object.prototype.hasOwnProperty.call(settings, 'buzzer');
  const b = (has && settings.buzzer && typeof settings.buzzer === 'object') ? settings.buzzer : {};
  const ids = new Set(buckets.map((x) => x.id));
  return {
    online: b.online === true,
    rooms: (Array.isArray(b.rooms) ? b.rooms : []).filter((id) => ids.has(id)),
    pw: typeof b.pw === 'string' ? b.pw : '',
  };
}

const anyOn = (cfg) => cfg.online || cfg.rooms.length > 0;
const hasBuzzer = (cfg, id) => cfg.online || cfg.rooms.includes(id);

function pwHtml(cfg) {
  if (!anyOn(cfg)) return '';
  if (!cfg.pw || changing) {
    return `<form class="row bzpwrow" id="bzpwform"><label class="row">Buzzer password
      <input id="bztdpw" size="18" autocomplete="off" value="${esc(cfg.pw)}"></label>
      <button class="primary">Set password</button>${cfg.pw ? '<button type="button" id="bzpwcancel">Cancel</button>' : ''}</form>`;
  }
  return `<div class="row bzpwrow"><span>Buzzer password</span><code class="bzpwshow">${esc(cfg.pw)}</code>
    <button class="ico" id="bzpwcopy" aria-label="Copy buzzer password" title="Copy buzzer password">${COPY}</button>
    <button id="bzpwchange">Change password</button></div>`;
}

/** The switch and the password, under the Rooms heading. */
export function buzzerSetHtml(cfg) {
  return `<div class="bzset"><div class="row"><label class="row">Online tournament
    <select id="bzonline">
      <option value="">Off</option>
      <option value="on"${cfg.online ? ' selected' : ''}>On</option>
    </select></label></div>${pwHtml(cfg)}</div>`;
}

/** The room table's Buzzer column: its heading, a room's checkbox, and
    the blank cell of a row that is not a room. */
export const BUZZER_TH = '<th class="bzcol">Buzzer</th>';
export const BUZZER_BLANK = '<td class="bzcol"></td>';
export function buzzerCellHtml(cfg, id, name) {
  return `<td class="bzcol"><input type="checkbox" data-bzroom="${id}" aria-label="Buzzer in ${esc(name)}"${
    hasBuzzer(cfg, id) ? ' checked' : ''}${cfg.online ? ' disabled' : ''}></td>`;
}

/** Wire what the three above drew inside `box`. save(next): store the
    whole buzzer object and draw the step again; redraw(): draw the step
    again from what is held. */
export function wireBuzzer(box, cfg, { save, redraw }) {
  const on = (sel, ev, fn) => { const el = box.querySelector(sel); if (el) el[ev] = fn; };
  // each change is made on the one before it, saved or still going out
  const put = () => save({ online: cfg.online, rooms: [...cfg.rooms], pw: cfg.pw });
  on('#bzonline', 'onchange', (e) => { cfg.online = e.target.value === 'on'; put(); });
  on('#bzpwform', 'onsubmit', (e) => {
    e.preventDefault();
    const v = box.querySelector('#bztdpw').value.trim();
    if (!v) return;
    cfg.pw = v; changing = false; put();
  });
  on('#bzpwcancel', 'onclick', () => { changing = false; redraw(); });
  on('#bzpwchange', 'onclick', () => { changing = true; redraw(); const i = box.querySelector('#bztdpw'); if (i) i.select(); });
  on('#bzpwcopy', 'onclick', () => navigator.clipboard && navigator.clipboard.writeText(cfg.pw));
  box.querySelectorAll('[data-bzroom]').forEach((c) => {
    c.onchange = () => {
      const id = Number(c.dataset.bzroom);
      cfg.rooms = c.checked ? [...new Set([...cfg.rooms, id])] : cfg.rooms.filter((x) => x !== id);
      put();
    };
  });
}
