// formatui.js — the reader game format control: a MODAQ preset plus every
// field of MODAQ's own customize dialog, stored as overrides on top of
// the preset (read_core.js). Shared by the TO dashboard (the format its
// rooms read with) and the set editor's (the format every mirror of the
// set starts with).

import { esc } from './api.js';
import { GAME_FORMAT_OPTIONS, effectiveFormat, formatOverridesFrom, cleanOverrides,
  formatKey, parsePowersText, powersText } from './read_core.js';

/** The control's markup; `open` = the customize panel is showing. */
export function formatHtml(settings, open) {
  const fmt = effectiveFormat(settings); // prefills the customize panel
  return `
    <div class="row" style="margin-bottom:6px">
      <label class="row">Reader game format
        <select id="gformat">${GAME_FORMAT_OPTIONS.map((o) =>
          `<option value="${o.value}" ${o.value === formatKey(settings) ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
      ${Object.keys(cleanOverrides(settings.formatOverrides)).length ? '<span class="pill">Custom</span>' : ''}
      <button id="fmtedit">Customize MODAQ settings</button>
    </div>
    <div id="fmtpanel" ${open ? '' : 'hidden'} class="card" style="margin-bottom:6px">
      <div class="row">
        <label>Tossups <input id="fmttossups" type="number" min="1" max="999" value="${fmt.regulationTossupCount}" style="width:64px"></label>
        <label>Neg <input id="fmtneg" type="number" min="-100" max="0" value="${fmt.negValue}" style="width:64px"></label>
        <label>Powers <input id="fmtpowers" placeholder="(*)=15" value="${esc(powersText(fmt.powers))}" size="16"></label>
        <label>Overtime tossups <input id="fmtot" type="number" min="1" max="99" value="${fmt.minimumOvertimeQuestionCount}" style="width:56px"></label>
      </div>
      <div class="row" style="margin-top:6px">
        <label class="row"><input type="checkbox" id="fmtpaired" ${fmt.pairTossupsBonuses ? 'checked' : ''}> Paired bonuses</label>
        <label class="row"><input type="checkbox" id="fmtbounce" ${fmt.bonusesBounceBack ? 'checked' : ''}> Bouncebacks</label>
        <label class="row"><input type="checkbox" id="fmtotbonus" ${fmt.overtimeIncludesBonuses ? 'checked' : ''}> Overtime bonuses</label>
        <label>Pronunciation marks
          <input id="fmtpron1" value="${esc((fmt.pronunciationGuideMarkers || ['', ''])[0])}" size="4">
          <input id="fmtpron2" value="${esc((fmt.pronunciationGuideMarkers || ['', ''])[1])}" size="4">
        </label>
        <span class="spacer" style="flex:1"></span>
        <button id="fmtreset">Reset to preset</button>
        <button id="fmtsave" class="primary">Save format</button>
      </div>
    </div>`;
}

/**
 * Wire formatHtml's controls inside `box`. settings() returns the
 * caller's CURRENT settings — a getter, because the caller's other
 * controls save into the same object between renders, and a format
 * change built from a stale copy would write their change back out.
 * save(nextSettings) persists; refresh() refetches and redraws (overrides
 * sit on the new preset, so the panel's prefills change); onToggle(open)
 * remembers the panel state across the caller's re-renders.
 */
export function wireFormat(box, { settings: current, save, say, refresh, onToggle }) {
  const $ = (id) => box.querySelector('#' + id);
  const commit = async (next, message) => {
    try {
      await save(next);
      say(message);
      refresh();
    } catch (e) { say(e.message, true); }
  };
  $('gformat').onchange = () => {
    // Always stored now: there is no "no format" option to fall back to,
    // and an absent key would read as the default preset rather than as
    // the one the TO just picked.
    commit({ ...current(), gameFormat: $('gformat').value }, 'Game format saved');
  };
  $('fmtedit').onclick = () => {
    $('fmtpanel').hidden = !$('fmtpanel').hidden;
    onToggle(!$('fmtpanel').hidden);
  };
  $('fmtsave').onclick = () => {
    const p1 = $('fmtpron1').value.trim(), p2 = $('fmtpron2').value.trim();
    if (!!p1 !== !!p2) { say('Pronunciation marks: fill both or neither', true); return; }
    const want = {
      regulationTossupCount: Number($('fmttossups').value),
      negValue: Number($('fmtneg').value),
      powers: parsePowersText($('fmtpowers').value),
      minimumOvertimeQuestionCount: Number($('fmtot').value),
      pairTossupsBonuses: $('fmtpaired').checked,
      bonusesBounceBack: $('fmtbounce').checked,
      overtimeIncludesBonuses: $('fmtotbonus').checked,
      pronunciationGuideMarkers: p1 ? [p1, p2] : null,
    };
    const settings = current();
    const ov = formatOverridesFrom(formatKey(settings), want);
    const bad = Object.keys(ov).filter((k) => !(k in cleanOverrides(ov)));
    if (bad.length) { say('Bad value: ' + bad.join(', '), true); return; }
    const next = { ...settings };
    if (Object.keys(ov).length) next.formatOverrides = ov;
    else delete next.formatOverrides;
    commit(next, 'Game format saved');
  };
  $('fmtreset').onclick = () => {
    const next = { ...current() };
    delete next.formatOverrides;
    commit(next, 'Game format reset');
  };
}
