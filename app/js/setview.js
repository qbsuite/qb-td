// setview.js — a question set's stats over all of its mirrors: combined
// standings and individuals, category stats (how each category played,
// and who played it), and buzzpoints that follow each question across
// every site that heard it — through packet fixes and repacketizing. One view, two homes: the public set page (s.html, /pubset
// routes, buzzpoint text behind the set's password) and the editor's
// dashboard (set.html, /s routes — the set link already is the key).
//
// Same request discipline as the tournament page (pubview.js): nothing
// polls. One small state response per load or refresh names every
// mirror's round stamps; only rounds whose stamp moved are fetched, from
// the mirror's SHA-pinned GitHub snapshot when the state advertises one
// and from the Worker otherwise (one request per mirror, never per round).

import { esc } from './api.js';
import { viewsHtml, pickerHtml, wirePicker, catChipsHtml, fx, newIds, goLink, rk, markTags, newIndividuals,
  newTeams, newPlayers, newRounds, fitTables, catHead, lineCells, questionsHtml,
  sortTables, chipsHtml } from './newstats.js';
import { comfortScroll } from './place.js';
import { rankFormat } from './read_core.js';
import { reportData } from '../engine/report.js';
import { dedupeMatches } from '../engine/stats.js';
import { buzzSummaryHtml, tossupTextHtml, buzzListHtml, tossupMetaHtml, bonusMetaHtml, bonusBodyHtml,
  bonusAnswersHtml, mainAnswerHtml } from './buzzview.js';
import { categoryQuestionStats, catBreakdown } from '../engine/cats.js';
import { buildSite, setCategories, setCatLines, identOf,
  setQuestionPlays, setBuzzNav, setPacketRows, setEarlierRows, setBuzzSummary,
  setQuestionTable } from '../engine/setstats.js';

const SNAP_TIMEOUT_MS = 8000; // a hung snapshot must fall back like a failed one
/**
 * Mount the view in `root`. `source` is where the data comes from:
 *   state()               the set state body (worker.js setStateBody)
 *   rounds(mirrorId, q)   {rounds: [shard]} for ?n=<q> from the Worker
 *   cats(stamp)           the set's category map
 *   packet(packet, v)     normalized packet text for the buzzpoints tab
 *                         (buzzview.js readPacket over a packet route)
 *   gated                 true when packet() needs the password first:
 *     unlocked(state) / unlock(password, state) / lock()
 *   mirrorLink(m)         href of a mirror's own page, or '' for none
 * Returns {refresh}.
 */
export function mountSetView(root, source, opts = {}) {
  root.innerHTML = `
    <div class="tabs">
      <button class="tab" data-tab="stats">Stats</button>
      <button class="tab" data-tab="cats" hidden>Categories</button>
      <button class="tab" data-tab="buzz" hidden>Buzzpoints</button>
    </div>
    <div class="sitebar"></div>
    <div class="setmsg"></div>
    <div class="setout"></div>`;
  const msg = root.querySelector('.setmsg');
  const out = root.querySelector('.setout');
  const sitebar = root.querySelector('.sitebar');
  const tabBtn = (name) => root.querySelector(`[data-tab="${name}"]`);

  let state = null;
  let sites = [];                  // every mirror's games, as setstats.js sites
  const excluded = new Set();      // mirror ids left out of every view (the site filter)
  const activeSites = () => sites.filter((s) => !excluded.has(s.id));
  let errors = [];
  let catmap = null;
  let lastCats;                    // category map stamp already held
  const shardCache = new Map();    // mirror id -> Map(round -> {v, entries})
  const packets = {};              // 'round:version' -> Promise<packet>
  let tab = opts.tab || 'stats';
  let catView = 'cat';             // 'cat' (players) | 'team' | 'player' | 'questions'
  let catSel = '';
  let catSubSel = '';
  let buzzSel = null;              // {p, v, earlier} | 'table' | 'summary'

  const say = (text, bad = false) => {
    msg.textContent = text || '';
    msg.className = 'setmsg' + (bad ? ' bad' : '');
  };

  /* ---------- data ---------- */

  // One mirror's rounds: whatever moved since last time, snapshot first.
  async function fetchMirror(m) {
    if (!shardCache.has(m.id)) shardCache.set(m.id, new Map());
    const held = shardCache.get(m.id);
    const wanted = m.rounds || {};
    const stale = Object.keys(wanted).filter((n) => (held.get(n) || {}).v !== wanted[n]);
    const hold = (n, shard) => held.set(n, {
      v: shard.v || wanted[n], entries: Array.isArray(shard.entries) ? shard.entries : [] });

    const fromWorker = [];
    await Promise.all(stale.map(async (n) => {
      if (state.repo && m.pub && m.pub.rounds && m.pub.rounds[n] === wanted[n]) {
        try {
          const res = await fetch(
            `https://raw.githubusercontent.com/${state.repo}/${m.pub.sha}/${m.slug}/r${n}.json`,
            { signal: AbortSignal.timeout(SNAP_TIMEOUT_MS) });
          if (!res.ok) throw new Error('snapshot HTTP ' + res.status);
          hold(n, await res.json());
          return;
        } catch (e) { /* fall back to the Worker */ }
      }
      fromWorker.push(n);
    }));
    if (fromWorker.length) {
      // the stamp rides along for the same reason as on the tournament
      // page: it keeps the browser's cache from answering with a shard
      // fetched before the round moved
      const q = fromWorker.sort((a, b) => a - b).map((n) => n + '@' + wanted[n]).join(',');
      try {
        const got = await source.rounds(m.id, q);
        for (const shard of (got && got.rounds) || []) hold(String(shard.round), shard);
      } catch (e) { errors.push(m.label + ': ' + e.message); }
    }
    for (const n of [...held.keys()]) if (wanted[n] === undefined) held.delete(n);
    return [...held.values()].flatMap((r) => r.entries);
  }

  async function load() {
    try {
      say('loading');
      state = await source.state();
      errors = [];
      const mirrors = state.mirrors || [];
      for (const id of [...shardCache.keys()]) {
        if (!mirrors.some((m) => m.id === id)) shardCache.delete(id);
      }
      const jobs = [Promise.all(mirrors.map(async (m) => buildSite(m, await fetchMirror(m), errors)))
        .then((built) => { sites = built; reportCache = new WeakMap(); })];
      if (state.cats !== lastCats) {
        jobs.push((async () => {
          // the stamp is held only once the map is: a failed fetch must
          // retry on the next refresh, not hide the tab until a reload
          try {
            catmap = state.cats ? await source.cats(state.cats) : null;
            lastCats = state.cats;
          } catch (e) { catmap = null; }
        })());
      }
      await Promise.all(jobs);
      if (source.gated && !state.buzz) source.lock();
      tabBtn('cats').hidden = !catmap;
      tabBtn('buzz').hidden = source.gated && !state.buzz;
      if (tabBtn(tab).hidden) tab = 'stats';
      say('');
      render();
    } catch (e) { say(e.message, true); }
  }

  // Which mirrors every view is over: the sites table, above every tab,
  // a checkbox a site. A site left out stays in the table, muted, its
  // numbers still there to compare; the last one in can't be left out,
  // so there is always something to show.
  function renderSitebar() {
    const mirrors = state.mirrors || [];
    if (!mirrors.length) { sitebar.innerHTML = ''; return; }
    const pick = mirrors.length > 1;
    const inCount = mirrors.length - excluded.size;
    const bySite = new Map(sites.map((x) => [x.id, x]));
    const regTossups = sites.length ? reportOf(sites[0]).regTossups : 20;
    const pp = `PP${regTossups}TUH`;
    // a host column only when some site's host says more than its label
    const hosts = mirrors.some((m) => m.host && m.host !== m.label);
    const rows = mirrors.map((m) => {
      const site = bySite.get(m.id);
      const x = site ? siteSums(reportOf(site)) : null;
      const on = !excluded.has(m.id);
      const link = source.mirrorLink ? source.mirrorLink(m) : '';
      return `<tr${on ? '' : ' class="off"'}>
        ${pick ? `<td class="sitepick"><input type="checkbox" data-site="${m.id}" aria-label="${esc(m.label)}"${on ? ' checked' : ''}${
          on && inCount === 1 ? ' disabled' : ''}></td>` : ''}
        <td class="name nstick">${link ? `<a href="${esc(link)}">${esc(m.label)}</a>` : esc(m.label)}</td>
        ${hosts ? `<td class="name">${esc(m.host || '')}</td>` : ''}<td>${esc(m.date || '')}</td>
        <td class="num g0">${x ? x.teams : '–'}</td><td class="num">${x ? x.games : '–'}</td>
        <td class="num g0">${x && x.games ? fx(x.pp, 1) : '–'}</td><td class="num">${x && x.games ? fx(x.ppb, 2) : '–'}</td></tr>`;
    }).join('');
    sitebar.innerHTML = `<div class="tablewrap"><table class="nstats sitetable" data-sort="sites">
      <thead><tr>${pick ? '<th class="sitepick"></th>' : ''}<th class="name nstick">Site</th>${hosts ? '<th class="name">Host</th>' : ''}<th>Date</th>
        <th class="num g0">Teams</th><th class="num">Games</th>
        <th class="num g0" title="Points per ${regTossups} tossups heard, per team">${pp}</th><th class="num" title="Points per bonus">PPB</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
    sitebar.querySelectorAll('input[data-site]').forEach((el) => {
      el.onchange = () => {
        const id = Number(el.dataset.site);
        if (excluded.has(id)) excluded.delete(id);
        else if (inCount > 1) excluded.add(id);
        render();
      };
    });
    sortTables(sitebar, statSorts);
    fitTables(sitebar);
  }

  /* ---------- stats ----------
     The public page's New layout (newstats.js), every site at once. No
     standings: a record means something only against its own field, so
     teams across sites are ordered by their numbers (PP20TUH, then PPB).
     A team's and a player's games stay under their own site, and the
     games themselves stay on each site's own page. */

  const STAT_SECS = [['teamstats', 'Team Stats'], ['individuals', 'Individuals'], ['teams', 'Teams'],
    ['players', 'Players'], ['packets', 'Packets']];
  let statSec = 'teamstats';
  let statMark = null;   // the id a followed link landed on
  let statBack = [];     // {sec, y, mark}: where links were followed from, latest last
  const statSorts = new Map(); // the number column each sortable table is ordered by
  // Totals or Per game, for Team Stats and Individuals: sites play
  // different numbers of games, so counts compare only per game. A
  // viewer's own preference, kept in the browser when it can be.
  const PER_KEY = 'qbtdSetPerGame';
  let perGame = (() => { try { return localStorage.getItem(PER_KEY) === '1'; } catch (e) { return false; } })();
  const perSwitchHtml = () => `<div class="poolbar">${chipsHtml([{ v: 'total', label: 'Totals' },
    { v: 'game', label: 'Per game' }], perGame ? 'game' : 'total', 'statper')}</div>`;
  function wirePer(box) {
    box.querySelectorAll('[data-statper]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        perGame = a.dataset.statper === 'game';
        try { localStorage.setItem(PER_KEY, perGame ? '1' : '0'); } catch (err) { /* private window */ }
        render();
      };
    });
  }

  // a site's report numbers (engine/report.js), worked out once a load
  let reportCache = new WeakMap();
  function reportOf(site) {
    if (!reportCache.has(site)) {
      reportCache.set(site, reportData({ name: site.label, matches: dedupeMatches(site.matches), roster: null,
        settings: rankFormat(state.format) }));
    }
    return reportCache.get(site);
  }
  // a site's line in the sites table: teams, games, and its PP20TUH and
  // PPB over every team there
  function siteSums(rd) {
    const n = (f) => rd.teams.reduce((s, t) => s + (f(t) || 0), 0);
    const tuh = n((t) => t.regTuh);
    const heard = n((t) => t.bonusesHeard);
    return { teams: rd.teams.length, games: rd.games.length,
      pp: tuh ? n((t) => (t.pp || 0) * t.regTuh) / tuh : null, ppb: heard ? n((t) => t.bonusPoints) / heard : null };
  }

  // per site in the views: its report numbers and its ids
  function siteReports() {
    return activeSites().map((s) => {
      const rd = reportOf(s);
      const own = newIds(rd, 's' + s.id + '-');
      // a game log's score has no box score here to open
      return { site: s, rd, ids: { ...own, game: () => null } };
    });
  }

  // Each packet over every site that read it: a site's games carried to
  // the packet its round read (the round itself is that TD's choice), its
  // teams kept apart from another site's. A round from no set packet is left out.
  function packetReport(reports) {
    const matches = [];
    for (const { site } of reports) {
      for (const m of dedupeMatches(site.matches)) {
        const pv = site.vmap[m.round];
        if (!Array.isArray(pv)) continue;
        matches.push({ ...m, round: Number(pv[0]), teams: m.teams.map((t) => ({ ...t, name: site.id + '\n' + t.name })) });
      }
    }
    return reportData({ name: state.name, matches, roster: null, settings: rankFormat(state.format) });
  }

  const byNumbers = (a, b) => (b.pp ?? -1) - (a.pp ?? -1) || (b.ppb ?? -1) - (a.ppb ?? -1) || a.name.localeCompare(b.name);

  // games a team played, forfeits aside (YF counts no forfeit as a game)
  const played = (tm) => tm.games.filter((g) => g.tuh > 0).length;

  // A-value (ACF's, after Dwight Wynne): PP20TUH times strength of
  // schedule. SOS is the points per tossup heard of a team's opponents,
  // one per game played against them, over the field's: every team at the
  // ticked sites, its total points over its total tossups heard. A team's
  // opponents are all at its own site, so ticking a site in or out moves
  // only the field's average: every A-value scales alike, and none passes
  // another.
  function withAValues(teams) {
    const rate = (t) => (t.regTuh && t.pp !== null ? t.pp / 20 : null);
    const byName = new Map(teams.map((t) => [t.siteId + '\n' + t.name, t]));
    const counted = teams.filter((t) => rate(t) !== null);
    const tuh = counted.reduce((n, t) => n + t.regTuh, 0);
    const field = tuh ? counted.reduce((n, t) => n + rate(t) * t.regTuh, 0) / tuh : null;
    return teams.map((t) => {
      const opps = t.games.filter((g) => g.tuh > 0).map((g) => rate(byName.get(t.siteId + '\n' + g.opp) || {}))
        .filter((x) => x !== null);
      const sos = field && opps.length ? opps.reduce((a, b) => a + b, 0) / opps.length / field : null;
      return { ...t, sos, aValue: sos !== null && t.pp !== null ? t.pp * sos : null };
    });
  }

  function teamStatsHtml(teams, vals, pp, regTossups) {
    const per = (tm, n) => (perGame ? fx(played(tm) ? n / played(tm) : null, 2) : n);
    return `<div class="tablewrap"><table class="nstats" data-sort="teamstats" data-sort-by="${pp}">
        <thead><tr><th class="nrkcol"></th><th class="name nstick">Team</th><th class="name nsite">Site</th>
          <th class="num g0" title="Games played">GP</th>
          <th class="num g0" title="Points scored in regulation per ${regTossups} regulation tossups heard">${pp}</th>
          ${vals.map((v, i) => `<th class="num${i ? '' : ' g0'}">${v}${perGame ? '/G' : ''}</th>`).join('')}
          <th class="num" title="Tossups heard in regulation">TUH</th><th class="num g0" title="Points per bonus">PPB</th>
          <th class="num g0" title="Strength of schedule">SOS</th><th class="num" title="${pp} × strength of schedule">A-value</th></tr></thead>
        <tbody>${teams.map((tm) => `<tr>
          <td class="muted nrkcol">${tm.rank}</td>
          <td class="name nstick">${rk(tm.rank)}${goLink('teams', tm.ids.team(tm.name), esc(tm.name))}${markTags(tm)}</td>
          <td class="name muted nsite">${esc(tm.site)}</td>
          <td class="num g0">${played(tm)}</td>
          <td class="num g0">${fx(tm.pp, 1)}</td>
          ${vals.map((v, j) => `<td class="num${j ? '' : ' g0'}">${per(tm, tm.counts[v] || 0)}</td>`).join('')}
          <td class="num">${tm.regTuh}</td><td class="num g0">${fx(tm.ppb, 2)}</td>
          <td class="num g0">${fx(tm.sos, 3)}</td><td class="num">${fx(tm.aValue, 1)}</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  function renderStatsTab() {
    const mirrors = state.mirrors || [];
    if (!mirrors.length) { out.innerHTML = '<div class="muted">No mirrors have started yet</div>'; return; }
    const reports = siteReports();
    const errs = errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('');
    if (!reports.some((r) => r.rd.games.length)) {
      out.innerHTML = errs + '<div class="muted" style="margin-top:12px">No games yet</div>';
      return;
    }
    const vals = [...new Set(reports.flatMap((r) => r.rd.vals))].filter((v) => v !== 0).sort((a, b) => b - a);
    const regTossups = reports[0].rd.regTossups;
    const pp = `PP${regTossups}TUH`;
    const rankAll = (rows) => rows.sort(byNumbers).map((r, i) => ({ ...r, rank: i + 1 }));
    const teams = withAValues(rankAll(reports.flatMap((r) => r.rd.teams.map((t) => ({ ...t, site: r.site.label, siteId: r.site.id, ids: r.ids })))));
    const players = rankAll(reports.flatMap((r) => r.rd.players.map((p) => ({ ...p, site: r.site.label, ids: r.ids }))));
    const rowIds = { team: (n, row) => row.ids.team(n), player: (t, n, row) => row.ids.player(t, n) };
    const perSite = (draw) => reports.filter((r) => r.rd.teams.length)
      .map((r) => `<h2 class="stagehead">${esc(r.site.label)}</h2>${draw(r)}`).join('');
    const draw = {
      teamstats: () => teamStatsHtml(teams, vals, pp, regTossups),
      individuals: () => newIndividuals({ players, regTossups }, rowIds, vals, pp, { site: true, perGame }),
      teams: () => perSite((r) => newTeams(r.rd, r.ids, vals, pp)),
      players: () => perSite((r) => newPlayers(r.rd, r.ids, vals)),
      packets: () => newRounds(packetReport(reports), { round: () => null }, 'Packet'),
    };
    out.innerHTML = errs + `<div class="views statsbar">${STAT_SECS.map(([k, label]) =>
      `<a href="#" class="view${statSec === k ? ' on' : ''}" data-statsec="${k}"${statSec === k ? ' aria-current="true"' : ''}>${label}</a>`).join('')}</div>
      <div class="newstats">${statSec === 'teamstats' || statSec === 'individuals' ? perSwitchHtml() : ''}${
        (draw[statSec] || draw.teamstats)()}</div>`;
    const box = out.querySelector('.newstats');
    sortTables(box, statSorts);
    fitTables(box);
    wirePer(out);
    out.querySelectorAll('[data-statsec]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); statSec = a.dataset.statsec; statMark = null; statBack = []; render(); };
    });
    // a followed link: mark where it landed, with the way back
    const el = statMark && document.getElementById(statMark);
    if (el) {
      el.classList.add('nmark');
      const from = statBack[statBack.length - 1];
      if (from) {
        const label = (STAT_SECS.find(([k]) => k === from.sec) || [])[1];
        el.querySelector('.nhead').insertAdjacentHTML('beforeend',
          ` <a href="#" class="nback" data-back="1">← Back to ${esc(label || 'the last page')}</a>`);
      }
    }
    box.onclick = (e) => {
      const a = e.target.closest('[data-go], [data-back]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.back) {
        const from = statBack.pop();
        statSec = from.sec; statMark = from.mark;
        render();
        window.scrollTo(0, from.y);
        return;
      }
      const [sec, id] = a.dataset.go.split('|');
      statBack.push({ sec: statSec, y: window.scrollY, mark: statMark });
      statSec = sec;
      statMark = id;
      render();
      comfortScroll(document.getElementById(id));
    };
  }

  /* ---------- categories ----------
     The public page's four views (newstats.js), every site at once: a
     player's or team's lines stay at their own site, and the questions
     are counted per packet version, so a question two sites both read
     is one question heard twice. */

  let catSub2Sel = '';
  let catPlayerSel = null; // {siteId, team, player}

  // every site's games and category map, keyed by the packet version
  // each round read (a round from no set packet has no categories here)
  function versionEntries() {
    const rounds = {};
    const entries = [];
    for (const site of activeSites()) {
      for (const e of site.entries) {
        const pv = site.vmap[e.round];
        const map = Array.isArray(pv) && catmap && catmap.packets && catmap.packets[pv[0]] && catmap.packets[pv[0]][pv[1]];
        if (!map) continue;
        const key = pv[0] + '.' + pv[1];
        rounds[key] = { t: map.t || [], b: map.b || [] };
        entries.push({ ...e, round: key, pv });
      }
    }
    return { entries, catmap: { rounds } };
  }

  function catFilterHtml(q) {
    const items = q.tossups.map((r) => ({ cat: r.cat, sub: r.sub, sub2: r.sub2, n: r.questions }))
      .concat(q.bonuses.map((r) => ({ cat: r.cat, sub: r.sub, sub2: r.sub2, n: 0 })));
    const cats = new Set(items.map((i) => i.cat));
    if (catSel && !cats.has(catSel)) { catSel = ''; catSubSel = ''; catSub2Sel = ''; }
    return catChipsHtml(items, [catSel, catSubSel, catSub2Sel], ['cat', 'catsub', 'catsub2']);
  }
  const wire = (attr, pick) => out.querySelectorAll(`[data-${attr}]`).forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); pick(el.dataset[attr]); render(); };
  });
  const wireCatFilter = () => {
    wire('cat', (v) => { catSel = v; catSubSel = ''; catSub2Sel = ''; });
    wire('catsub', (v) => { catSubSel = v; catSub2Sel = ''; });
    wire('catsub2', (v) => { catSub2Sel = v; });
  };
  const noneHere = '<div class="muted">No buzzes in this category</div>';

  // Per game: games played as the site's own stats count them, a player's
  // partial games included; a category line divided by them
  function gamesPlayed() {
    const players = new Map();
    const teams = new Map();
    for (const s of activeSites()) {
      const rd = reportOf(s);
      for (const p of rd.players) players.set(s.id + '\n' + p.team + '\n' + p.name, p.gp);
      for (const t of rd.teams) teams.set(s.id + '\n' + t.name, played(t));
    }
    return { player: (siteId, team, name) => players.get(siteId + '\n' + team + '\n' + name),
      team: (siteId, name) => teams.get(siteId + '\n' + name) };
  }
  function perLine(l, games) {
    if (!perGame) return l;
    const f = (n) => (n === undefined ? n : fx(games ? n / games : null, 2));
    return { ...l, powers: f(l.powers), gets: f(l.gets), negs: f(l.negs), bb: f(l.bb), pts: f(l.pts), bh: f(l.bh), bpts: f(l.bpts) };
  }
  const showPowers = (lines) => lines.some((l) => l.powers);

  function byCategoryHtml(rows, q) {
    const gp = gamesPlayed();
    const lines = setCatLines(rows, catSel, catSubSel, 'player', catSub2Sel);
    // per game, the order is per game too
    if (perGame) {
      const g = (l) => gp.player(l.siteId, l.team, l.player) || 0;
      const by = (l, n) => (g(l) ? n / g(l) : -1);
      lines.sort((a, b) => by(b, b.pts) - by(a, a.pts) || by(b, b.powers + b.gets) - by(a, a.powers + a.gets));
    }
    const pw = showPowers(lines);
    return `${catFilterHtml(q)}
      ${lines.length ? `<div class="tablewrap"><table class="cattable" data-sort="catplayers" data-sort-by="Pts">
        <tr><th class="name">Player</th><th class="name teamcol">Team</th><th class="name nsite">Site</th>${catHead(pw, perGame)}</tr>
        ${lines.map((l) =>
          `<tr><td class="name">${esc(l.player)}<span class="subteam">${esc(l.team)}</span></td>`
          + `<td class="name muted teamcol">${esc(l.team)}</td><td class="name muted nsite">${esc(l.site)}</td>${
            lineCells(perLine(l, gp.player(l.siteId, l.team, l.player)), pw)}</tr>`).join('')}
      </table></div>` : noneHere}`;
  }

  function byTeamHtml(rows, q) {
    const gp = gamesPlayed();
    const lines = setCatLines(rows, catSel, catSubSel, 'team', catSub2Sel);
    if (perGame) {
      const g = (l) => gp.team(l.siteId, l.team) || 0;
      const by = (l) => (g(l) ? (l.pts + l.bpts) / g(l) : -1);
      lines.sort((a, b) => by(b) - by(a) || (b.ppb ?? -1) - (a.ppb ?? -1));
    }
    const pw = showPowers(lines);
    return `${catFilterHtml(q)}
      ${lines.length ? `<div class="tablewrap"><table data-sort="catteams">
        <tr><th class="name">Team</th><th class="name nsite">Site</th>${catHead(pw, perGame)}${
          perGame ? '<th class="num">Bonuses/G</th><th class="num">Bpts/G</th>' : '<th class="num">Bonuses</th><th class="num">Bpts</th>'}<th class="num">PPB</th></tr>
        ${lines.map((l) => [l, perLine(l, gp.team(l.siteId, l.team))]).map(([l, p]) =>
          `<tr><td class="name">${esc(l.team)}</td><td class="name muted nsite">${esc(l.site)}</td>${lineCells(p, pw)}<td class="num">${p.bh}</td>`
          + `<td class="num">${p.bpts}</td><td class="num">${l.ppb === null ? '–' : l.ppb.toFixed(2)}</td></tr>`).join('')}
      </table></div>` : noneHere}`;
  }

  // one player's categories: the picker lists every site's players, a
  // team under its name and site
  function byPlayer(box, rows) {
    const key = (r) => JSON.stringify([r.siteId, r.team, r.player]);
    const players = [...new Map(rows.map((r) => [key(r), { siteId: r.siteId, site: r.site, team: r.team, player: r.player }])).values()]
      .sort((a, b) => a.site.localeCompare(b.site) || a.team.localeCompare(b.team) || a.player.localeCompare(b.player));
    if (!catPlayerSel || !players.some((p) => key(p) === key(catPlayerSel))) catPlayerSel = players[0];
    const items = players.map((p) => ({ name: p.player, team: `${p.team} · ${p.site}` }));
    const cur = players.findIndex((p) => key(p) === key(catPlayerSel));
    const bd = catBreakdown(rows.filter((r) => r.siteId === catPlayerSel.siteId), catPlayerSel.team, catPlayerSel.player);
    const pw = showPowers(bd.map((b) => b.line));
    const games = gamesPlayed().player(catPlayerSel.siteId, catPlayerSel.team, catPlayerSel.player);
    const cells = (l) => lineCells(perLine(l, games), pw);
    box.innerHTML = `
      <div style="margin-bottom:10px">${pickerHtml('setplayersel', items, cur)}</div>
      <div class="tablewrap"><table>
        <tr><th>Category</th>${catHead(pw, perGame)}</tr>
        ${bd.map(({ cat, line, subs }) =>
          `<tr><td><b>${esc(cat)}</b></td>${cells(line)}</tr>`
          + subs.map(({ sub, line: sl, subs: s2 }) =>
            `<tr class="muted"><td style="padding-left:28px">${esc(sub)}</td>${cells(sl)}</tr>`
            + s2.map(({ sub: x, line: l2 }) =>
              `<tr class="muted"><td style="padding-left:48px">${esc(x)}</td>${cells(l2)}</tr>`).join('')).join('')
        ).join('')}
      </table></div>`;
    wirePicker('setplayersel', items, cur, (p) => { catPlayerSel = players[items.indexOf(p)]; }, render);
  }

  function renderCatsTab() {
    const { entries, catmap: vmap } = versionEntries();
    // a question is one question wherever it was read (setstats.js identOf)
    const q = categoryQuestionStats(entries, vmap, (e, kind, n) => identOf(catmap, e.pv[0], e.pv[1], kind, n).ident);
    if (!q.tossups.length && !q.bonuses.length) { out.innerHTML = '<div class="muted">No categorized games yet</div>'; return; }
    const c = setCategories(activeSites(), catmap);
    out.innerHTML = `
      ${viewsHtml([{ v: 'cat', label: 'Players' }, { v: 'team', label: 'Teams' },
        { v: 'player', label: 'By Player' }, { v: 'questions', label: 'Questions' }], catView, 'catview')}
      ${catView === 'questions' ? '' : perSwitchHtml()}
      <div class="catbody"></div>`;
    wire('catview', (v) => { catView = v; });
    wirePer(out);
    const body = out.querySelector('.catbody');
    if (catView === 'questions') body.innerHTML = questionsHtml(q, [catSel, catSubSel, catSub2Sel], catFilterHtml(q));
    else if (catView === 'team') body.innerHTML = byTeamHtml(c.teams, q);
    else if (catView === 'player') {
      if (c.players.length) byPlayer(body, c.players);
      else body.innerHTML = '<div class="muted">No buzzes yet</div>';
    } else body.innerHTML = byCategoryHtml(c.players, q);
    if (catView !== 'player') wireCatFilter();
    sortTables(body, statSorts);
  }


  const pct1 = (x) => (x === null || x === undefined ? '–' : Math.round(x * 100) + '%');

  /* ---------- buzzpoints ----------
     By question, not by round (setstats.js): a packet's page lists its
     CURRENT questions, each with every play of it anywhere — whatever
     round a site read it in, whatever packet it sat in then. Plays on
     the current wording are drawn over the current text; plays on an
     earlier wording get their own block over the text they were
     recorded against, because a word index means nothing across two
     wordings. Questions that are in no current packet any more stay
     reachable under the version that last held them. */

  function fetchPacket(packet, v) {
    const key = packet + ':' + v;
    if (!packets[key]) {
      packets[key] = source.packet(packet, v).catch((e) => { delete packets[key]; throw e; });
    }
    return packets[key];
  }

  const homeLabel = (kind, h) => `packet ${h.p}${(state.packets || {})[h.p] === h.v ? '' : ' v' + h.v} `
    + (kind === 't' ? 'T' : 'B') + h.pos;
  const rooms = (n) => n + ' room' + (n === 1 ? '' : 's');

  // one wording's plays over that wording's text
  function groupHtml(kind, group, item) {
    return kind === 't'
      ? tossupTextHtml(item, group.buzzes) + buzzListHtml(group.buzzes)
      : bonusBodyHtml(item, group.results);
  }

  function questionHtml(row, p, v, texts) {
    const kind = row.kind;
    const itemAt = (h) => {
      const pk = texts.get(h.p + ':' + h.v);
      const list = pk && (kind === 't' ? pk.tossups : pk.bonuses);
      return (list && list[h.pos - 1]) || null;
    };
    const own = { p, v, pos: row.pos };
    // this wording's text: the packet on screen, or — when that version
    // can't be read yet — anywhere else the same wording was played
    const sameItem = itemAt(own) || (row.same && row.same.homes.map(itemAt).find(Boolean)) || null;
    const anyItem = sameItem || row.others.flatMap((g) => g.homes.map(itemAt)).find(Boolean) || null;
    const groups = [row.same, ...row.others].filter(Boolean);
    const elsewhere = row.same
      ? row.same.homes.filter((h) => !(h.p === p && h.v === v && h.pos === row.pos)) : [];
    const moved = groups.some((g) => g.homes.some((h) => h.p !== p));

    const badges = (row.others.length ? ` <span class="pill">${row.others.length + 1} wordings</span>` : '')
      + (moved ? ' <span class="pill">Moved</span>' : '');
    let meta;
    if (!row.heard) meta = '<span class="muted">Not played yet</span>';
    else if (kind === 't') {
      meta = tossupMetaHtml(groups.flatMap((g) => g.buzzes), row.heard, (row.same || groups[0]).buzzes);
    } else meta = rooms(row.heard) + ' &middot; ' + bonusMetaHtml(groups.flatMap((g) => g.results));

    const body = [];
    if (row.same) {
      if (elsewhere.length) {
        body.push(`<div class="revnote">Same wording, also read as ${elsewhere.map((h) =>
          esc(homeLabel(kind, h)) + ' (' + rooms(h.games) + ')').join(', ')} — counted together.</div>`);
      }
      body.push(groupHtml(kind, row.same, sameItem));
    } else if (row.heard) {
      body.push(`<div class="revnote">No site has heard this wording yet.</div>`
        + (sameItem ? groupHtml(kind, { buzzes: [], results: [] }, sameItem) : ''));
    } else if (sameItem) body.push(groupHtml(kind, { buzzes: [], results: [] }, sameItem));
    for (const g of row.others) {
      body.push(`<div class="revblock">
        <div class="revnote"><b>${g.rev < row.rev ? 'Earlier' : 'Another'} wording</b> — read as ${g.homes.map((h) =>
          esc(homeLabel(kind, h))).join(', ')} &middot; ${rooms(g.heard)}. Its buzzes are marked on the text those
          rooms heard; they count towards the numbers above.</div>
        ${groupHtml(kind, g, g.homes.map(itemAt).find(Boolean) || null)}
      </div>`);
    }
    return `
      <details class="qd${kind === 'b' ? ' bonus' : ''}">
        <summary><span class="roundcell">${kind === 't' ? 'T' : 'B'}${row.pos}</span>
          ${kind === 't'
            ? (anyItem ? mainAnswerHtml(anyItem.answer) : '<span class="muted">(no packet text)</span>')
            : bonusAnswersHtml(anyItem)}${badges}
          <span class="qdmeta">${meta}</span></summary>
        <div class="qdbody">${body.join('')}</div>
      </details>`;
  }

  // Every tossup of the set on one table, hardest first: its answer where
  // the text can be read, where it sits, and how it converted everywhere.
  async function renderBuzzTable(box, index) {
    const { tossups } = setQuestionTable(index, catmap, state.packets);
    if (!tossups.length) { box.innerHTML = '<div class="muted">No finished games</div>'; return; }
    box.innerHTML = '<div class="muted">Loading packets</div>';
    const wanted = new Map();
    for (const t of tossups) if (t.home) wanted.set(t.home.p + ':' + t.home.v, [t.home.p, t.home.v]);
    const texts = new Map();
    await Promise.all([...wanted].map(async ([key, [pp, vv]]) => {
      try { texts.set(key, await fetchPacket(pp, vv)); } catch (e) { /* no text for that one */ }
    }));
    if (tab !== 'buzz' || buzzSel !== 'table') return;
    const answerOf = (t) => {
      const pk = t.home && texts.get(t.home.p + ':' + t.home.v);
      const tu = pk && pk.tossups && pk.tossups[t.home.pos - 1];
      return tu ? mainAnswerHtml(tu.answer) : '<span class="muted">(no text)</span>';
    };
    const rows = [...tossups].sort((a, b) => (a.gets / a.heard) - (b.gets / b.heard) || b.heard - a.heard);
    box.innerHTML = `<div class="muted" style="font-size:13px;margin-bottom:8px">Every tossup with plays, hardest first.
      A question counts wherever it was read; the packet and number are where it sits now.</div>
      <div class="tablewrap"><table>
        <tr><th>where</th><th class="name">answer</th><th class="name">category</th>
          <th class="num sep">heard</th>${rows.some((t) => t.powers) ? '<th class="num sep">power</th>' : ''}
          <th class="num sep">conv</th><th class="num sep">neg</th><th class="num sep">avg word</th></tr>
        ${rows.map((t) => `<tr>
          <td class="muted" style="white-space:nowrap">${t.home ? `packet ${t.home.p} T${t.home.pos}` : '–'}${
            (state.packets || {})[t.home && t.home.p] === (t.home && t.home.v) ? '' : ' <span class="pill">Not current</span>'}</td>
          <td class="name">${answerOf(t)}${t.wordings > 1 ? ` <span class="pill">${t.wordings} wordings</span>` : ''}</td>
          <td class="name muted">${esc(t.cat)}${t.sub ? ' · ' + esc(t.sub) : ''}</td>
          <td class="num sep">${t.heard}</td>${rows.some((x) => x.powers) ? `<td class="num sep">${pct1(t.powers / t.heard)}</td>` : ''}
          <td class="num sep"><span class="${t.gets ? 'ok' : 'bad'}">${pct1(t.gets / t.heard)}</span></td>
          <td class="num sep">${pct1(t.negs / t.heard)}</td>
          <td class="num sep">${t.avgWord === null ? '–' : t.avgWord.toFixed(0)}</td></tr>`).join('')}
      </table></div>`;
  }

  async function renderBuzzPacket(box, sel, index) {
    const v = sel.v;
    const rows = sel.earlier
      ? setEarlierRows(index, catmap, state.packets, sel.p, v)
      : setPacketRows(index, catmap, sel.p, v);
    if (!rows.some((r) => r.heard)) { box.innerHTML = '<div class="muted">No finished games</div>'; return; }
    box.innerHTML = '<div class="muted">Loading packet</div>';
    // every text this page draws on: the version on screen, plus wherever
    // an earlier wording (or a moved question) was actually read
    const wanted = new Map([[sel.p + ':' + v, [sel.p, v]]]);
    for (const r of rows) {
      for (const g of [r.same, ...r.others]) {
        if (g) for (const h of g.homes) wanted.set(h.p + ':' + h.v, [h.p, h.v]);
      }
    }
    const texts = new Map();
    let denied = false;
    await Promise.all([...wanted].map(async ([key, [pp, vv]]) => {
      try { texts.set(key, await fetchPacket(pp, vv)); }
      catch (e) {
        if (source.gated && String(e.message).includes('bad password')) denied = true;
        // anything else (a version not played yet, a parser down): the
        // numbers still render without that text
      }
    }));
    if (denied) { source.lock(); render(); return; }
    if (tab !== 'buzz' || buzzSel !== sel) return; // moved on mid-fetch
    const unmatched = !((((catmap || {}).packets || {})[sel.p] || {})[v] || {}).q;
    box.innerHTML = (sel.earlier
      ? `<div class="revnote">Questions read from packet ${sel.p} v${v} that are in none of the set's current
           packets${unmatched ? ' — this version\'s questions were never matched to the rest of the set, so it stands alone' : ''}.</div>`
      : unmatched ? `<div class="revnote">This version's questions have not been matched to the rest of the set:
           plays of them under other versions or packets are not shown here.</div>` : '')
      + rows.filter((r) => !sel.earlier || r.heard).map((r) => questionHtml(r, sel.p, v, texts)).join('');
  }

  function renderBuzzTab() {
    const index = setQuestionPlays(activeSites(), catmap);
    const nav = setBuzzNav(index, catmap, state.packets);
    if (source.gated && !source.unlocked(state)) {
      out.innerHTML = `<div class="row">
        <input class="buzzpw" type="password" placeholder="password">
        <button class="buzzgo primary">view</button>
      </div>`;
      const go = async () => {
        try {
          say('checking password');
          // a version some site has finished: the only kind the gate serves
          const probe = [...index.values()].flatMap(({ revs }) => [...revs.values()]).flatMap((g) => g.homes)[0];
          await source.unlock(out.querySelector('.buzzpw').value, state, probe ? { packet: probe.p, v: probe.v } : null);
          say('');
          render();
        } catch (e) { say(e.message, true); }
      };
      out.querySelector('.buzzgo').onclick = go;
      out.querySelector('.buzzpw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      return;
    }
    const same = (x, y) => x && y && typeof x === 'object' && typeof y === 'object'
      && x.p === y.p && x.v === y.v && !!x.earlier === !!y.earlier;
    const choices = [
      ...nav.packets.map((pk) => ({ p: pk, v: state.packets[pk], earlier: false })),
      ...nav.earlier.map(([pk, vv]) => ({ p: pk, v: vv, earlier: true })),
    ];
    if (buzzSel !== 'summary' && buzzSel !== 'table') {
      buzzSel = choices.find((c) => same(c, buzzSel))
        || choices.filter((c) => !c.earlier).pop() || choices[0] || 'summary';
    }
    out.innerHTML = `
      <div class="views">
        <a href="#" class="view${buzzSel !== 'table' && buzzSel !== 'summary' ? ' on' : ''}" data-buzzsel="${
          Math.max(0, choices.indexOf(choices.filter((c) => !c.earlier).pop()))}">By Packet</a>
        <a href="#" class="view${buzzSel === 'table' ? ' on' : ''}" data-buzzsel="table">All Tossups</a>
        <span class="grow"></span>
        <a href="#" class="view${buzzSel === 'summary' ? ' on' : ''}" data-buzzsel="summary">Players</a>
      </div>
      ${buzzSel !== 'table' && buzzSel !== 'summary' ? `<div class="chipstack">
        <div class="chips">
          ${choices.filter((c) => !c.earlier).map((c) =>
            `<a href="#" class="chip${same(c, buzzSel) ? ' on' : ''}" data-buzzsel="${choices.indexOf(c)}">Packet ${c.p}</a>`).join('')}
        </div>
        ${nav.earlier.length ? `<div class="chips sub">
          <span class="muted" style="font-size:13px">No longer in the set</span>
          ${choices.filter((c) => c.earlier).map((c) =>
            `<a href="#" class="chip${same(c, buzzSel) ? ' on' : ''}" data-buzzsel="${choices.indexOf(c)}">Packet ${c.p} v${c.v}</a>`).join('')}
        </div>` : ''}
      </div>` : ''}
      <div class="buzzout"></div>`;
    out.querySelectorAll('[data-buzzsel]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        buzzSel = ['summary', 'table'].includes(el.dataset.buzzsel) ? el.dataset.buzzsel : choices[Number(el.dataset.buzzsel)];
        render();
      };
    });
    const box = out.querySelector('.buzzout');
    if (buzzSel === 'summary') box.innerHTML = buzzSummaryHtml(setBuzzSummary(activeSites()));
    else if (buzzSel === 'table') renderBuzzTable(box, index);
    else renderBuzzPacket(box, buzzSel, index);
  }

  /* ---------- shell ---------- */

  function render() {
    if (!state) return;
    root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderSitebar();
    if (tab === 'cats') renderCatsTab();
    else if (tab === 'buzz') renderBuzzTab();
    else renderStatsTab();
  }

  root.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      if (opts.onTab) opts.onTab(tab);
      render();
    };
  });
  let refitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { const b = root.querySelector('.newstats'); if (b) fitTables(b); }, 150);
  });
  load();
  return { refresh: load, state: () => state };
}
