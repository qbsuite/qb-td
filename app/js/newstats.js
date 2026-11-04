// newstats.js — the public page's New stats layout and category tables,
// as plain HTML builders: the tournament page (pubview.js) and a set's
// page (setview.js, every site side by side) draw the same tables from
// them. Nothing here holds state; a page wires the links it draws.

import { esc } from './api.js';
import { catCompare, questionLines, UNKNOWN_CAT } from '../engine/cats.js';

/* ---------- navigation + filters (td.css .views / .chips) ---------- */

// View switch: bold words. items [{v, label} | {grow: true}].
export function viewsHtml(items, cur, attr) {
  return `<div class="views">${items.map((i) => i.grow ? '<span class="grow"></span>'
    : `<a href="#" class="view${i.v === cur ? ' on' : ''}" data-${attr}="${esc(i.v)}"${
      i.v === cur ? ' aria-current="true"' : ''}>${esc(i.label)}</a>`).join('')}</div>`;
}
// Filter chips. items [{v, label, n?, off?, cls?}]; `sub` hangs the row
// off a rule, for the level under another.
// `sub` is true for the second row, 'sub2' for the third.
export function chipsHtml(items, cur, attr, sub = false) {
  return `<div class="chips${sub ? ' sub' : ''}${sub === 'sub2' ? ' sub2' : ''}">${items.map((i) => i.off
    ? `<span class="chip off">${esc(i.label)}</span>`
    : `<a href="#" class="chip${i.v === cur ? ' on' : ''}${i.cls ? ' ' + i.cls : ''}" data-${attr}="${esc(i.v)}"${
      i.v === cur ? ' aria-current="true"' : ''}>${esc(i.label)}${i.n ? `<span class="n">${i.n}</span>` : ''}</a>`).join('')}</div>`;
}

// A player list: a button showing the picked player, which opens the
// list with a search box on top. The list runs team by team, each team's
// players under its name; typing narrows it to names (or teams) holding
// every word typed, accents and case aside. The search box takes the
// focus only on a mouse or trackpad: on a phone that would bring up the
// keyboard over the list. items [{name, team}], sorted by team; `cur` is
// the picked index.
const foldName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pickLabel = (p) => `${p.name} (${p.team})`;
export function pickerHtml(id, items, cur) {
  return `<div class="pick"><button type="button" id="${id}" class="pickbtn" aria-haspopup="listbox"
    aria-expanded="false">${esc(items[cur] ? pickLabel(items[cur]) : '')}</button><div class="pickpanel" hidden>
    <input type="search" id="${id}-q" role="combobox" aria-expanded="false" aria-controls="${id}-list"
      aria-autocomplete="list" autocomplete="off" spellcheck="false" aria-label="Search players" placeholder="Search">
    <ul id="${id}-list" class="picklist" role="listbox"></ul></div></div>`;
}
export function wirePicker(id, items, cur, pick, after) {
  const btn = document.getElementById(id);
  const input = document.getElementById(id + '-q');
  const list = document.getElementById(id + '-list');
  const panel = list.parentElement;
  const keys = items.map((p) => foldName(pickLabel(p)));
  let shown = [];
  let at = -1;
  const opts = () => [...list.querySelectorAll('[role="option"]')];
  const mark = (i) => {
    at = i;
    opts().forEach((li, j) => li.classList.toggle('on', j === at));
    const li = opts()[at];
    if (li) {
      input.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  // a tap or click outside the open list closes it
  const outside = (e) => { if (!panel.contains(e.target) && e.target !== btn) close(); };
  const open = (q) => {
    const words = foldName(q).split(/\s+/).filter(Boolean);
    shown = items.map((_, i) => i).filter((i) => words.every((w) => keys[i].includes(w)));
    const teams = [];
    shown.forEach((i, j) => {
      const t = teams[teams.length - 1];
      if (t && t.team === items[i].team) t.rows.push([i, j]);
      else teams.push({ team: items[i].team, rows: [[i, j]] });
    });
    list.innerHTML = teams.length ? teams.map((t) =>
      `<li role="group" aria-label="${esc(t.team)}"><div class="pickteam" aria-hidden="true">${esc(t.team)}</div><ul role="presentation">${
        t.rows.map(([i, j]) => `<li id="${id}-o${j}" role="option" aria-selected="${i === cur}">${esc(items[i].name)}</li>`).join('')}</ul></li>`).join('')
      : '<li class="muted none">No matches</li>';
    if (panel.hidden) {
      panel.hidden = false;
      document.addEventListener('pointerdown', outside, true);
    }
    input.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-expanded', 'true');
    mark(shown.length ? Math.max(0, words.length ? 0 : shown.indexOf(cur)) : -1);
  };
  function close() {
    panel.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
    input.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.value = '';
  }
  const choose = (j) => {
    if (shown[j] === undefined) return;
    close();
    if (shown[j] === cur) { btn.blur(); return; }
    pick(items[shown[j]]);
    after();
  };
  btn.onclick = () => {
    if (!panel.hidden) { close(); return; }
    open('');
    if (matchMedia('(pointer: fine)').matches) input.focus();
  };
  btn.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(''); input.focus(); }
  };
  panel.parentElement.addEventListener('focusout', (e) => {
    if (!panel.hidden && !panel.parentElement.contains(e.relatedTarget)) close();
  });
  input.oninput = () => open(input.value);
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) mark((at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(at);
    } else if (e.key === 'Escape') {
      close();
      btn.focus();
    }
  };
  // mousedown, not click: the focus stays put until the pick lands
  list.onmousedown = (e) => {
    e.preventDefault();
    const li = e.target.closest('[role="option"]');
    if (li) choose(opts().indexOf(li));
  };
}

// Category chips, then the picked category's subcategories under them,
// then the picked subcategory's own split (RMPSS → Beliefs → Narratives).
// `items` are [{cat, sub, sub2}] with a count each (`n`); a subcategory
// named like its category adds nothing and isn't offered. `all` offers an
// All chip for no category.
export function catChipsHtml(items, [cat, sub, sub2], [catAttr, subAttr, sub2Attr], all = true) {
  const count = new Map();
  const bump = (k, n) => count.set(k, (count.get(k) || 0) + n);
  for (const i of items) {
    bump(i.cat, i.n);
    if (i.sub && i.sub !== i.cat) bump(i.cat + '\n' + i.sub, i.n);
    if (i.sub2) bump(i.cat + '\n' + i.sub + '\n' + i.sub2, i.n);
  }
  const cats = [...new Set(items.map((i) => i.cat))].sort(catCompare);
  const subs = cat ? [...new Set(items.filter((i) => i.cat === cat && i.sub && i.sub !== cat)
    .map((i) => i.sub))].sort() : [];
  const subs2 = cat && sub ? [...new Set(items.filter((i) => i.cat === cat && i.sub === sub && i.sub2)
    .map((i) => i.sub2))].sort() : [];
  return `<div class="chipstack">
    ${chipsHtml([...(all ? [{ v: '', label: 'All' }] : []),
      ...cats.map((c) => ({ v: c, label: c, n: count.get(c), cls: c === UNKNOWN_CAT ? 'unc' : '' }))], cat, catAttr)}
    ${subs.length ? chipsHtml([{ v: '', label: 'All' },
      ...subs.map((s) => ({ v: s, label: s, n: count.get(cat + '\n' + s) }))], sub, subAttr, true) : ''}
    ${subs2.length ? chipsHtml([{ v: '', label: 'All' },
      ...subs2.map((s) => ({ v: s, label: s, n: count.get(cat + '\n' + sub + '\n' + s) }))], sub2, sub2Attr, 'sub2') : ''}
  </div>`;
}

export const fx = (v, d) => (v === null || v === undefined ? '–' : v.toFixed(d));

// ids for the New layout's anchors: by position, so any name is safe.
// `prefix` keeps one set site's ids apart from another's.
export function newIds(rd, prefix = '') {
  const team = new Map(rd.teams.map((t, i) => [t.name, prefix + 'nt-' + i]));
  const player = new Map(rd.players.map((p, i) => [p.team + '\n' + p.name, prefix + 'np-' + i]));
  const game = new Map(rd.games.map((g, i) => [g.id, prefix + 'ng-' + i]));
  return {
    team: (n) => team.get(n), player: (t, n) => player.get(t + '\n' + n),
    game: (id) => game.get(id), round: (r) => prefix + 'nr-' + r,
  };
}
export const goLink = (sec, id, text) => (id ? `<a href="#" data-go="${sec}|${esc(id)}">${text}</a>` : text);

// The New layout's tables share one shape: Classic's columns in Classic's
// order, a header (in <thead>, so it can stay on screen), and a sticky
// first column on a phone. Related columns sit together, and the first
// column of each group gets the class g0, which opens a gap before it. A
// rank or round column (nrkcol) hides on a phone, where the sticky cell
// carries it instead (span.nrk).
export const rk = (v) => `<span class="nrk">${esc(String(v))}</span>`;
// A team's or player's Undergraduate / Division II marks, as tags beside
// the name (Classic gives each a column). reportData sets `ug` / `d2`
// only for a mark the roster tracks, so an untracked one draws nothing.
export const markTags = (x) => (x.ug ? '<span class="ntag" title="Undergraduate">UG</span>' : '')
  + (x.d2 ? '<span class="ntag d2" title="Division II">DII</span>' : '');
export const markWords = (x) => [x.ug && 'Undergraduate', x.d2 && 'Division II'].filter(Boolean).join(', ');

// {site: true}: rows from several sites (setview.js), each with its
// `site` in a column; `ids` then also get the row, to find the site's ids.
// {perGame: true}: the counts and points per game played (PPG), for
// comparing players who played different numbers of games
export function newIndividuals(rd, ids, vals, pp, { site = false, perGame = false } = {}) {
  const per = (p, n) => (perGame ? fx(p.gp ? n / p.gp : null, 2) : n);
  return `<div class="tablewrap"><table class="nstats" data-sort="individuals" data-sort-by="${pp}">
    <thead><tr><th class="nrkcol"></th><th class="name nstick">Player</th><th class="name teamcol">Team</th>${
      site ? '<th class="name nsite">Site</th>' : ''}
      <th class="num g0" title="Games played">GP</th>
      ${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}${perGame ? '/G' : ''}</th>`).join('')}
      <th class="num" title="Tossups heard">TUH</th>
      ${perGame ? '<th class="num g0" title="Points per game">PPG</th>' : '<th class="num g0">Pts</th>'}<th class="num" title="Points per ${rd.regTossups} tossups heard">${pp}</th></tr></thead>
    <tbody>${rd.players.map((p) => `<tr>
      <td class="muted nrkcol">${esc(p.rank)}</td>
      <td class="name nstick">${rk(p.rank)}${goLink('players', ids.player(p.team, p.name, p), esc(p.name))}${markTags(p)}<span class="subteam">${esc(p.team)}</span></td>
      <td class="name muted teamcol">${goLink('teams', ids.team(p.team, p), esc(p.team))}</td>${
        site ? `<td class="name muted nsite">${esc(p.site)}</td>` : ''}
      <td class="num g0">${p.gp.toFixed(1)}</td>
      ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${per(p, p.counts[v] || 0)}</td>`).join('')}
      <td class="num">${p.tuh}</td><td class="num g0">${per(p, p.points)}</td><td class="num">${fx(p.pp, 2)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// a game row of a team's or player's log: round, opponent, result, score
export const logCells = (ids, g) => `<td class="muted nrkcol">${g.round}</td>
  <td class="name nstick">${rk(g.round)}${goLink('teams', ids.team(g.opp), esc(g.opp))}</td><td>${g.result}</td>
  <td class="name">${goLink('games', ids.game(g.gameId), esc(g.score))}</td>`;
export const logHead = '<th class="nrkcol">Rd</th><th class="name nstick">Opponent</th><th></th><th class="name">Score</th>';
// `at`: the Classic report's id for the same thing (reportData anchor)
export const secHead = (id, title, meta, at) => `<div class="nsec" id="${id}" data-at="${esc(at)}"><h3 class="nhead"><span>${title}</span>${
  meta ? `<span class="meta">${meta}</span>` : ''}</h3>`;

export function newTeams(rd, ids, vals, pp) {
  const byName = [...rd.teams].sort((a, b) => a.name.toLocaleUpperCase().localeCompare(b.name.toLocaleUpperCase()));
  return byName.map((t) => {
    const players = rd.players.filter((p) => p.team === t.name);
    return `${secHead(ids.team(t.name), esc(t.name), [esc(t.record), markWords(t)].filter(Boolean).join(' · '), t.anchor)}
      <div class="tablewrap"><table class="nstats">
        <thead><tr>${logHead}${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
          <th class="num" title="Tossups heard">TUH</th><th class="num g0" title="Bonuses heard">BHrd</th>
          <th class="num" title="Points scored on bonuses">BPts</th><th class="num" title="Points per bonus">PPB</th></tr></thead>
        <tbody>${t.games.map((g) => `<tr>${logCells(ids, g)}${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${g.counts[v] || 0}</td>`).join('')}
          <td class="num">${g.tuh}</td><td class="num g0">${g.bonusesHeard}</td><td class="num">${g.bonusPoints}</td>
          <td class="num">${fx(g.ppb, 2)}</td></tr>`).join('')}
        <tr class="ntot"><td class="nrkcol"></td><td class="name nstick">Total</td><td>${esc(t.record)}</td><td></td>
          ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${t.counts[v] || 0}</td>`).join('')}
          <td class="num">${t.tuh}</td><td class="num g0">${t.bonusesHeard}</td><td class="num">${t.bonusPoints}</td>
          <td class="num">${fx(t.ppb, 2)}</td></tr></tbody>
      </table></div>
      ${players.length ? `<div class="tablewrap"><table class="nstats">
        <thead><tr><th class="name nstick">Player</th><th class="num g0" title="Games played">GP</th>${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
          <th class="num" title="Tossups heard">TUH</th><th class="num g0">${pp}</th></tr></thead>
        <tbody>${players.map((p) => `<tr><td class="name nstick">${goLink('players', ids.player(p.team, p.name), esc(p.name))}${markTags(p)}</td>
          <td class="num g0">${p.gp.toFixed(1)}</td>${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${p.counts[v] || 0}</td>`).join('')}
          <td class="num">${p.tuh}</td><td class="num g0">${fx(p.pp, 2)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}</div>`;
  }).join('');
}

export function newPlayers(rd, ids, vals) {
  const sorted = [...rd.players].sort((a, b) =>
    a.team.toLocaleUpperCase().localeCompare(b.team.toLocaleUpperCase())
    || a.name.toLocaleUpperCase().localeCompare(b.name.toLocaleUpperCase()));
  return sorted.map((p) => `${secHead(ids.player(p.team, p.name), esc(p.name),
    [goLink('teams', ids.team(p.team), esc(p.team)), markWords(p)].filter(Boolean).join(' · '), p.anchor)}
    <div class="tablewrap"><table class="nstats">
      <thead><tr>${logHead}<th class="num g0" title="Games played">GP</th>${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}</th>`).join('')}
        <th class="num" title="Tossups heard">TUH</th><th class="num g0">Pts</th></tr></thead>
      <tbody>${p.games.map((g) => `<tr>${logCells(ids, g)}<td class="num g0">${g.gp.toFixed(1)}</td>
        ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${g.counts[v] || 0}</td>`).join('')}
        <td class="num">${g.tuh}</td><td class="num g0">${g.points}</td></tr>`).join('')}
      <tr class="ntot"><td class="nrkcol"></td><td class="name nstick">Total</td><td></td><td></td><td class="num g0">${p.gp.toFixed(1)}</td>
        ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${p.counts[v] || 0}</td>`).join('')}
        <td class="num">${p.tuh}</td><td class="num g0">${p.points}</td></tr></tbody>
    </table></div></div>`).join('');
}

// `label` heads the first column: Round, or Packet on a set's page
export function newRounds(rd, ids, label = 'Round') {
  const n = rd.regTossups;
  const cells = (r) => `<td class="num">${r.games}</td><td class="num">${fx(r.ppTeam, 1)}</td>
    ${rd.hasPowers ? `<td class="num">${r.powerPct === null ? '–' : r.powerPct.toFixed(0) + '%'}</td>` : ''}
    <td class="num">${r.convPct === null ? '–' : r.convPct.toFixed(0) + '%'}</td>
    ${rd.hasNegs ? `<td class="num">${fx(r.negsTeam, 1)}</td>` : ''}<td class="num">${fx(r.ppb, 2)}</td>`;
  return `<div class="tablewrap"><table class="nstats" data-sort="rounds">
    <thead><tr><th class="nstick">${label}</th><th class="num">Games</th>
      <th class="num" title="Points per team per ${n} tossups heard">Pts/Tm/${n}TUH</th>
      ${rd.hasPowers ? '<th class="num" title="Tossups powered by either team">TU Powered</th>' : ''}
      <th class="num" title="Tossups answered correctly by either team">TU Converted</th>
      ${rd.hasNegs ? `<th class="num" title="Incorrect interrupts per team per ${n} tossups heard">Negs/Tm/${n}TUH</th>` : ''}
      <th class="num" title="Points per bonus">PPB</th></tr></thead>
    <tbody>${rd.rounds.map((r) => `<tr><td class="nstick">${goLink('games', ids.round(r.round), String(r.round))}</td>${cells(r)}</tr>`).join('')}
    <tr class="ntot"><td class="nstick">Total</td>${cells(rd.total)}</tr></tbody>
  </table></div>`;
}

// A table marked data-sort="<key>" orders its rows by a number column
// when that column's header is clicked: highest first, then lowest first,
// then back to the page's own order. A total row stays last, and a row
// keeps its rank, which still says where it placed. `sorts` (Map key ->
// {head, dir}) holds the pick across redraws, and every table with the
// same key follows one pick, by the column's header (a standings table
// per pool sorts together, whatever columns each has). A table whose own
// order is one column, highest first, names it (data-sort-by="PP20TUH"):
// that column carries the arrow until another is picked, and a click on
// it turns the table lowest first.
export function sortTables(box, sorts) {
  for (const table of box.querySelectorAll('table[data-sort]')) {
    const key = table.dataset.sort;
    const head = table.tHead ? table.tHead.rows[0] : table.rows[0];
    const rows = [...table.rows].filter((r) => r !== head && !r.classList.contains('ntot'));
    const tots = [...table.rows].filter((r) => r.classList.contains('ntot'));
    if (rows.length < 2) continue;
    rows.forEach((r, i) => { r.dataset.ord = i; });
    const cols = [...head.cells];
    const value = (r, col) => {
      const n = parseFloat((r.cells[col] ? r.cells[col].textContent : '').replace(/[%,]/g, ''));
      return Number.isNaN(n) ? null : n;
    };
    // a column by its header, Totals or Per game alike (15/G is 15, PPG is Pts)
    const label = (th) => th.textContent.trim().replace(/\/G$/, '').replace(/^PPG$/, 'Pts');
    const own = table.dataset.sortBy ? { head: table.dataset.sortBy, dir: 'desc' } : null;
    const colOf = (p) => (p ? cols.findIndex((th) => th.classList.contains('num') && label(th) === p.head) : -1);
    const apply = () => {
      const pick = sorts.get(key);
      const col = colOf(pick);
      const ordered = [...rows];
      if (col >= 0) {
        ordered.sort((a, b) => {
          const x = value(a, col);
          const y = value(b, col);
          if (x === y) return a.dataset.ord - b.dataset.ord;
          if (x === null) return 1; // a dash goes last either way
          if (y === null) return -1;
          return pick.dir === 'desc' ? y - x : x - y;
        });
      } else ordered.sort((a, b) => a.dataset.ord - b.dataset.ord);
      // rows move only when the order does: the page as drawn stays as is
      const now = [...table.rows].filter((r) => r !== head && !r.classList.contains('ntot'));
      if (ordered.some((r, i) => r !== now[i])) {
        const parent = rows[0].parentNode;
        for (const r of [...ordered, ...tots]) parent.appendChild(r);
      }
      // the arrow: the picked column, else the one the page's order follows
      const shown = col >= 0 ? pick : own;
      const at = col >= 0 ? col : colOf(own);
      cols.forEach((th, i) => {
        if (at === i) th.setAttribute('aria-sort', shown.dir === 'desc' ? 'descending' : 'ascending');
        else th.removeAttribute('aria-sort');
      });
    };
    cols.forEach((th) => {
      if (!th.classList.contains('num')) return;
      const head = label(th);
      th.innerHTML = `<button type="button" class="sorth">${th.innerHTML}</button>`;
      th.firstChild.onclick = () => {
        const pick = sorts.get(key) || own;
        if (!pick || pick.head !== head) sorts.set(key, { head, dir: 'desc' });
        else if (pick.dir === 'desc') sorts.set(key, { head, dir: 'asc' });
        else sorts.delete(key);
        for (const t of box.querySelectorAll(`table[data-sort="${key}"]`)) if (t.sortApply) t.sortApply();
      };
    });
    table.sortApply = apply;
    apply();
  }
}

// A sticky header only sticks inside its nearest scrolling box. A table
// that fits its width doesn't scroll sideways (nfit), so its header
// sticks to the page. One that doesn't (a phone, mostly) becomes its own
// scroll box, both ways and at most most of a screen tall (nscroll), so
// its header and first column stay put inside it; an edge fade (more)
// says there's more to the right until the end is reached.
export function fitTables(box) {
  for (const table of box.querySelectorAll('table.nstats')) {
    const wrap = table.parentElement;
    let fade = wrap.parentElement;
    if (!fade.classList.contains('nfade')) {
      fade = document.createElement('div');
      fade.className = 'nfade';
      wrap.replaceWith(fade);
      fade.appendChild(wrap);
    }
    wrap.classList.remove('nfit', 'nscroll');
    const over = table.scrollWidth > wrap.clientWidth + 1;
    wrap.classList.add(over ? 'nscroll' : 'nfit');
    const edge = () => fade.classList.toggle('more',
      over && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 2);
    wrap.onscroll = edge;
    edge();
  }
}

// perGame: the same columns per game played (15/G … PPG)
export const catHead = (pw, perGame = false) => {
  const g = perGame ? '/G' : '';
  return (pw ? `<th class="num">15${g}</th>` : '') + `<th class="num">10${g}</th><th class="num">-5${g}</th>`
    + `<th class="num" title="Bouncebacks: tossups won after the other team missed them">BB${g}</th>`
    + (perGame ? '<th class="num" title="Points per game">PPG</th>' : '<th class="num">Pts</th>');
};
export function lineCells(l, pw) {
  return (pw ? `<td class="num">${l.powers}</td>` : '') + `<td class="num">${l.gets}</td>`
    + `<td class="num">${l.negs}</td><td class="num">${l.bb}</td><td class="num">${l.pts}</td>`;
}

// How each category's questions played: tossups the way the buzzpoints
// sites show them, bonuses with PPB and their easy / medium / hard parts.
export function questionsHtml(q, [catSel, catSubSel, catSub2Sel], filter) {
  const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '–');
  // Unknown is marked, and its tags are quoted: they're the packet's
  // own words, not a category this site recognized
  const unc = (l) => l.cat === UNKNOWN_CAT;
  const rowCls = (l) => ['cattop', 'catsub', 'catsub2'][l.level]
    + (unc(l) ? ' uncat' : '');
  const name = (l) => (l.isSub && unc(l) ? `\u201C${esc(l.sub)}\u201D`
    : esc([l.cat, l.sub, l.sub2][l.level]));
  const tl = questionLines(q.tossups, catSel, catSubSel, catSub2Sel);
  const bl = questionLines(q.bonuses, catSel, catSubSel, catSub2Sel);
  // the difficulty notice counts the bonuses on screen, once each: the
  // lines at the shallowest level shown
  const shallow = Math.min(...bl.map((l) => l.level));
  const top = bl.filter((l) => l.level === shallow);
  const ranked = top.reduce((n, l) => n + (l.ranked || 0), 0);
  const marked = top.reduce((n, l) => n + (l.marked || 0), 0);
  const note = !ranked ? '' : `<p class="ranknote" role="note"><span class="i" aria-hidden="true">i</span>${
    marked ? `Bonus difficulty not available for ${ranked} of ${ranked + marked} bonuses, ranked by conversion rate.`
      : 'Bonus difficulty not available, ranked by conversion rate.'}</p>`;
  return `${filter}
    <div class="rhead">Tossups</div>
    ${tl.length ? `<div class="tablewrap"><table>
      <tr><th>Category</th><th class="num" title="Tossups in this category">Tossups</th>
        <th class="num" title="Times they were read, one per room">Heard</th><th class="num">Conv %</th><th class="num">Power %</th>
        <th class="num">Neg %</th><th class="num">Avg Buzz</th></tr>
      ${tl.map((l) => `<tr class="${rowCls(l)}"><td>${name(l)}</td><td class="num">${l.questions}</td><td class="num">${l.heard}</td>
        <td class="num">${pct(l.conv, l.heard)}</td><td class="num">${pct(l.powers, l.heard)}</td>
        <td class="num">${pct(l.negs, l.heard)}</td>
        <td class="num">${l.words && l.words.length ? (l.words.reduce((a, b) => a + b, 0) / l.words.length).toFixed(1) : '–'}</td></tr>`).join('')}
    </table></div>` : '<div class="muted">None</div>'}
    <div class="rhead" style="margin-top:18px">Bonuses</div>
    ${note}
    ${bl.length ? `<div class="tablewrap"><table>
      <tr><th>Category</th><th class="num" title="Bonuses in this category">Bonuses</th>
        <th class="num" title="Times they were read, one per room">Heard</th><th class="num">PPB</th>
        <th class="num sep">Easy</th><th class="num">Medium</th><th class="num">Hard</th></tr>
      ${bl.map((l) => `<tr class="${rowCls(l)}"><td>${name(l)}</td><td class="num">${l.questions}</td><td class="num">${l.heard}</td>
        <td class="num">${l.heard ? (l.pts / l.heard).toFixed(2) : '–'}</td>
        <td class="num sep">${pct(l.e, l.dHeard)}</td><td class="num">${pct(l.m, l.dHeard)}</td>
        <td class="num">${pct(l.h, l.dHeard)}</td></tr>`).join('')}
    </table></div>` : '<div class="muted">None</div>'}`;
}
