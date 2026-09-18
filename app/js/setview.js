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
import { renderStats } from './statsview.js';
import { buzzSummaryHtml, tossupTextHtml, buzzListHtml, tossupMetaHtml, bonusMetaHtml, bonusBodyHtml,
  bonusAnswersHtml, mainAnswerHtml } from './buzzview.js';
import { catCompare } from '../engine/cats.js';
import { buildSite, setStandings, setCategories, setCatLines, setQuestionLines,
  setQuestionPlays, setBuzzNav, setPacketRows, setEarlierRows, setBuzzSummary,
  setQuestionTable, setBonusLines } from '../engine/setstats.js';

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
      <button class="tab" data-tab="stats">stats</button>
      <button class="tab" data-tab="cats" hidden>categories</button>
      <button class="tab" data-tab="buzz" hidden>buzzpoints</button>
    </div>
    <div class="sitebar row" style="margin:8px 0"></div>
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
  let catView = 'questions';       // 'questions' | 'bonuses' | 'players' | 'teams'
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
        .then((built) => { sites = built; })];
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

  // Which mirrors every view is over. Each is a pill; excluded ones read
  // struck through, and the count says how many are in.
  function renderSitebar() {
    const mirrors = state.mirrors || [];
    if (mirrors.length < 2) { sitebar.innerHTML = ''; return; }
    const inCount = mirrors.length - excluded.size;
    sitebar.innerHTML = `<span class="muted">sites</span>
      ${mirrors.map((m) => `<a href="#" class="pill${excluded.has(m.id) ? '' : ' on'}" data-site="${m.id}"
        title="${excluded.has(m.id) ? 'include' : 'exclude'}"${excluded.has(m.id) ? ' style="text-decoration:line-through"' : ''}>${esc(m.label)}</a>`).join('')}
      ${excluded.size ? `<a href="#" class="pill" data-site="all">all ${mirrors.length}</a>` : ''}
      <span class="muted">${inCount === mirrors.length ? 'all ' + mirrors.length : inCount + ' of ' + mirrors.length}</span>`;
    sitebar.querySelectorAll('[data-site]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        if (el.dataset.site === 'all') excluded.clear();
        else {
          const id = Number(el.dataset.site);
          if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
        }
        render();
      };
    });
  }

  /* ---------- stats ---------- */

  function renderStatsTab() {
    const mirrors = state.mirrors || [];
    if (!mirrors.length) { out.innerHTML = '<div class="muted">no mirrors have started yet</div>'; return; }
    const s = setStandings(activeSites());
    const bySite = new Map(s.sites.map((x) => [x.id, x]));
    const siteRows = mirrors.map((m) => {
      const x = bySite.get(m.id) || {};
      const link = source.mirrorLink ? source.mirrorLink(m) : '';
      const off = excluded.has(m.id);
      return `<tr class="${off ? 'muted' : ''}">
        <td class="name">${link ? `<a href="${esc(link)}">${esc(m.label)}</a>` : esc(m.label)}${
          off ? ' <span class="pill">excluded</span>' : ''}</td>
        <td class="name muted">${esc(m.host || '')}</td>
        <td class="muted">${esc(m.date || '')}</td>
        <td class="num sep">${x.teams || 0}</td><td class="num sep">${x.games || 0}</td>
        <td class="num sep">${x.games ? x.pp20tuh : '–'}</td><td class="num sep">${x.games ? x.ppb : '–'}</td>
      </tr>`;
    }).join('');
    out.innerHTML = `
      ${errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}
      <h2>sites</h2>
      <div class="tablewrap"><table>
        <tr><th class="name">site</th><th class="name">host</th><th>date</th>
          <th class="num sep">teams</th><th class="num sep">games</th>
          <th class="num sep">PP20TUH</th><th class="num sep">PPB</th></tr>
        ${siteRows}
      </table></div>
      <div class="setstats"></div>`;
    if (s.teams.length) renderStats(out.querySelector('.setstats'), s, [], { site: true, games: false });
    else out.querySelector('.setstats').innerHTML = '<div class="muted" style="margin-top:12px">no games yet</div>';
  }

  /* ---------- categories ---------- */

  const pctOf = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '–');

  function catFilterHtml(rows) {
    const cats = [...new Set(rows.map((r) => r.cat))].sort(catCompare);
    if (catSel && !cats.includes(catSel)) { catSel = ''; catSubSel = ''; }
    const subs = catSel && catView !== 'questions' && catView !== 'bonuses'
      ? [...new Set(rows.filter((r) => r.cat === catSel && r.sub).map((r) => r.sub))].sort() : [];
    return `
      <div class="row" style="margin-bottom:8px">
        ${['', ...cats].map((c) =>
          `<a href="#" class="pill${catSel === c ? ' on' : ''}" data-cat="${esc(c)}">${esc(c) || 'all'}</a>`).join('')}
      </div>
      ${subs.length ? `<div class="row" style="margin-bottom:10px">
        ${['', ...subs].map((x) =>
          `<a href="#" class="pill${catSubSel === x ? ' on' : ''}" data-catsub="${esc(x)}">${esc(x) || 'all'}</a>`).join('')}
      </div>` : ''}`;
  }

  const lineCells = (l) => `<td class="num">${l.powers}</td><td class="num">${l.gets}</td>`
    + `<td class="num">${l.negs}</td><td class="num">${l.pts}</td>`;
  const LINE_HEAD = '<th class="num">15</th><th class="num">10</th><th class="num">-5</th><th class="num">pts</th>';

  const pct1 = (x) => (x === null || x === undefined ? '–' : Math.round(x * 100) + '%');

  function renderCatsTab() {
    const c = setCategories(activeSites(), catmap);
    if (!c.questions.length) { out.innerHTML = '<div class="muted">no categorized games yet</div>'; return; }
    const views = [['questions', 'tossups'], ['bonuses', 'bonuses'], ['players', 'players'], ['teams', 'teams']];
    let body;
    if (catView === 'bonuses') {
      // bonus parts ranked by how they converted: "easiest" is the part
      // most rooms got, wherever the writers put it
      const index = setQuestionPlays(activeSites(), catmap);
      const { bonuses } = setQuestionTable(index, catmap, state.packets);
      const lines = setBonusLines(bonuses, catSel);
      const rows = bonuses.filter((b) => b.cat);
      body = `${catFilterHtml(rows)}
        <div class="muted" style="font-size:13px;margin-bottom:8px">Parts are ranked by how they actually converted:
          easiest is the part most rooms got, wherever it sat in the bonus.</div>
        <div class="tablewrap"><table>
          <tr><th class="name">${catSel ? 'subcategory' : 'category'}</th>
            <th class="num sep">bonuses</th><th class="num sep">heard</th><th class="num sep">PPB</th>
            <th class="num sep">0</th><th class="num">10</th><th class="num">20</th><th class="num">30</th>
            <th class="num sep">easiest</th><th class="num">middle</th><th class="num">hardest</th></tr>
          ${lines.map((l) => `<tr><td class="name">${esc(l.name)}</td>
            <td class="num sep">${l.bonuses}</td><td class="num sep">${l.heard}</td>
            <td class="num sep">${l.ppb === null ? '–' : l.ppb.toFixed(2)}</td>
            <td class="num sep">${pct1(l.heard ? l.dist[0] / l.heard : null)}</td>
            <td class="num">${pct1(l.heard ? l.dist[1] / l.heard : null)}</td>
            <td class="num">${pct1(l.heard ? l.dist[2] / l.heard : null)}</td>
            <td class="num">${pct1(l.heard ? l.dist[3] / l.heard : null)}</td>
            <td class="num sep">${pct1(l.easy)}</td><td class="num">${pct1(l.mid)}</td><td class="num">${pct1(l.hard)}</td></tr>`).join('')}
        </table></div>`;
    } else if (catView === 'questions') {
      // by category, or one category opened into its subcategories
      const lines = setQuestionLines(c.questions, catSel);
      const powers = c.questions.some((q) => q.powers); // a set without powers gets no column
      body = `${catFilterHtml(c.questions)}
        <div class="tablewrap"><table>
          <tr><th class="name">${catSel ? 'subcategory' : 'category'}</th>
            <th class="num sep">heard</th>${powers ? '<th class="num sep">power</th>' : ''}<th class="num sep">conv</th>
            <th class="num sep">dead</th><th class="num sep">negs</th>
            <th class="num sep">bonuses</th><th class="num sep">PPB</th></tr>
          ${lines.map((l) => `<tr><td class="name">${esc(l.name)}</td>
            <td class="num sep">${l.heard}</td>${powers ? `<td class="num sep">${pctOf(l.powers, l.heard)}</td>` : ''}
            <td class="num sep">${pctOf(l.powers + l.gets, l.heard)}</td>
            <td class="num sep">${pctOf(l.dead, l.heard)}</td><td class="num sep">${l.negs}</td>
            <td class="num sep">${l.bh}</td><td class="num sep">${l.ppb === null ? '–' : l.ppb.toFixed(2)}</td></tr>`).join('')}
        </table></div>`;
    } else if (catView === 'players') {
      body = `${catFilterHtml(c.players)}
        <div class="tablewrap"><table>
          <tr><th class="name">player</th><th class="name">team</th><th class="name">site</th>${LINE_HEAD}</tr>
          ${setCatLines(c.players, catSel, catSubSel, 'player').map((l) =>
            `<tr><td class="name">${esc(l.player)}</td><td class="name muted">${esc(l.team)}</td>
             <td class="name muted">${esc(l.site)}</td>${lineCells(l)}</tr>`).join('')}
        </table></div>`;
    } else {
      body = `${catFilterHtml(c.teams)}
        <div class="tablewrap"><table>
          <tr><th class="name">team</th><th class="name">site</th>${LINE_HEAD}
            <th class="num">bonuses</th><th class="num">bpts</th><th class="num">ppb</th></tr>
          ${setCatLines(c.teams, catSel, catSubSel, 'team').map((l) =>
            `<tr><td class="name">${esc(l.team)}</td><td class="name muted">${esc(l.site)}</td>${lineCells(l)}
             <td class="num">${l.bh}</td><td class="num">${l.bpts}</td>
             <td class="num">${l.ppb === null ? '–' : l.ppb.toFixed(2)}</td></tr>`).join('')}
        </table></div>`;
    }
    out.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        ${views.map(([k, label]) =>
          `<a href="#" class="pill${catView === k ? ' on' : ''}" data-catview="${k}">${label}</a>`).join('')}
      </div>${body}`;
    out.querySelectorAll('[data-catview]').forEach((p) => {
      p.onclick = (e) => { e.preventDefault(); catView = p.dataset.catview; catSubSel = ''; render(); };
    });
    out.querySelectorAll('[data-cat]').forEach((p) => {
      p.onclick = (e) => { e.preventDefault(); catSel = p.dataset.cat; catSubSel = ''; render(); };
    });
    out.querySelectorAll('[data-catsub]').forEach((p) => {
      p.onclick = (e) => { e.preventDefault(); catSubSel = p.dataset.catsub; render(); };
    });
  }


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
      + (moved ? ' <span class="pill">moved</span>' : '');
    let meta;
    if (!row.heard) meta = '<span class="muted">not played yet</span>';
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
    if (!tossups.length) { box.innerHTML = '<div class="muted">no finished games</div>'; return; }
    box.innerHTML = '<div class="muted">loading packets</div>';
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
            (state.packets || {})[t.home && t.home.p] === (t.home && t.home.v) ? '' : ' <span class="pill">not current</span>'}</td>
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
    if (!rows.some((r) => r.heard)) { box.innerHTML = '<div class="muted">no finished games</div>'; return; }
    box.innerHTML = '<div class="muted">loading packet</div>';
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
      <div class="row" style="margin-bottom:10px">
        ${choices.filter((c) => !c.earlier).map((c, i) =>
          `<a href="#" class="pill${same(c, buzzSel) ? ' on' : ''}" data-buzzsel="${choices.indexOf(c)}">packet ${c.p}</a>`).join('')}
        <span style="flex:1"></span>
        <a href="#" class="pill${buzzSel === 'table' ? ' on' : ''}" data-buzzsel="table">all tossups</a>
        <a href="#" class="pill${buzzSel === 'summary' ? ' on' : ''}" data-buzzsel="summary">players</a>
      </div>
      ${nav.earlier.length ? `<div class="row" style="margin-bottom:10px">
        <span class="muted">no longer in the set</span>
        ${choices.filter((c) => c.earlier).map((c) =>
          `<a href="#" class="pill${same(c, buzzSel) ? ' on' : ''}" data-buzzsel="${choices.indexOf(c)}">packet ${c.p} v${c.v}</a>`).join('')}
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
  load();
  return { refresh: load, state: () => state };
}
