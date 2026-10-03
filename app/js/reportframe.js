// reportframe.js — the YellowFruit-style stat report (engine/report.js,
// six interlinked pages) shown inside one page: all six bodies in one
// srcdoc iframe, one visible at a time, the report's own cross-page links
// (`teamdetail.html#Team`) turned into hash navigation inside the frame.
// The report's stylesheet stays inside the frame, where it can't touch
// the surrounding page.

const FILES = ['standings', 'individuals', 'games', 'teamdetail', 'playerdetail', 'rounds'];

function bodyOf(html) {
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

function styleOf(html) {
  const m = /<style>[\s\S]*?<\/style>/i.exec(html);
  return m ? m[0] : '';
}

const PAGE_NAMES = { standings: 'Standings', individuals: 'Individuals', games: 'Scoreboard',
  teamdetail: 'Team Detail', playerdetail: 'Player Detail', rounds: 'Round Report' };

/** buildReport()'s pages -> the srcdoc of a frame that shows them. */
export function reportSrcdoc(pages, { start = null } = {}) {
  const sections = pages.map((page) => {
    const pg = page.name.replace(/\.html$/, '');
    let body = bodyOf(page.text).replace(/<style>[\s\S]*?<\/style>/i, '');
    // anchors and links become frame-local. The report's markup is
    // YellowFruit's, attributes unquoted: id=X -> id="<page>-X" (the top
    // anchor is written id=#top), HREF=other.html#X -> href="#other-X",
    // HREF=other.html -> href="#other-top".
    body = body.replace(/\bid=#?([^\s>]+)/g, (_, id) => `id="${pg}-${id}"`);
    body = body.replace(/\bHREF=([a-z]+)\.html(?:#([^\s>]*))?/g, (_, file, anchor) =>
      `href="#${file}-${anchor || 'top'}"`);
    return `<section id="page-${pg}" hidden>${body}</section>`;
  });
  // Links are followed by hand, never by the browser: a srcdoc document's
  // base URL is its parent's, so letting "#teamdetail-X" navigate would
  // load the surrounding page inside the frame.
  // The parent does the scrolling, not the frame: the frame is resized to
  // each page's height, so a scroll made inside it before the resize is
  // undone by it, and a target further down than the previous page was
  // tall would land off screen. The frame reports where the target is
  // (`y`, from the top of its document) and the parent scrolls there once
  // the frame is its new size. `go` is set for clicks only, so loading
  // the tab never moves the page.
  // A followed link marks where it landed: a bar down the target's whole
  // section (a team with its games and players, a player's game log, a
  // game's box score), with a link next to its heading back to the link
  // that was followed. Both stay until the next click.
  const script = `
    var files = ${JSON.stringify(FILES)};
    var names = ${JSON.stringify(PAGE_NAMES)};
    var current = '';
    var startAt = ${JSON.stringify(start || null)};
    var marked = null; // {box, back}: undone on the next click
    var from = null;   // the link last followed, and its page
    function pageOf(hash) {
      return files.filter(function (f) { return hash === f + '-top' || hash.indexOf(f + '-') === 0; })[0] || files[0];
    }
    // what a reader sees for an anchor: the anchor itself, or for an empty
    // anchor div (a game's, which carries YF's 30px of space above the box
    // score) the element after it
    function visible(el) {
      return el && !el.textContent.trim() && el.nextElementSibling ? el.nextElementSibling : el;
    }
    function unmark() {
      if (!marked) return;
      var box = marked.box;
      while (box.firstChild) box.parentNode.insertBefore(box.firstChild, box);
      box.remove();
      if (marked.back) marked.back.remove();
      marked = null;
    }
    // the section: from what the reader sees of the anchor up to the next
    // anchor, in one box
    function mark(el, pg) {
      unmark();
      if (!el || /-top$/.test(el.id)) return;
      var start = visible(el);
      var box = document.createElement('div');
      box.className = 'qt-mark';
      start.parentNode.insertBefore(box, start);
      var n = start;
      do { var next = n.nextElementSibling; box.appendChild(n); n = next; } while (n && !n.id);
      var back = null;
      if (from && from.page !== pg) {
        back = document.createElement('a');
        back.href = '#';
        back.className = 'qt-back';
        back.textContent = '\u2190 Back to ' + (names[from.page] || 'the last page');
        var to = from;
        back.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          unmark();
          show(to.page + '-top', false, to.link);
        });
        start.appendChild(back);
      }
      marked = { box: box, back: back };
    }
    // link: land on this element instead of the hash's own (Back)
    function show(hash, go, link) {
      current = hash;
      var pg = pageOf(hash);
      files.forEach(function (f) { document.getElementById('page-' + f).hidden = f !== pg; });
      window.scrollTo(0, 0);
      var el = link || (hash ? document.getElementById(hash) : null);
      if (go) mark(el, pg);
      var y = el ? el.getBoundingClientRect().top : 0;
      parent.postMessage({ qbtdReport: 'height', height: document.documentElement.scrollHeight, y: y, go: !!(go || link) }, '*');
    }
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a || a.classList.contains('qt-back')) return;
      e.preventDefault();
      from = { page: pageOf(current), link: a };
      show(a.getAttribute('href').slice(1), true);
    });
    window.addEventListener('load', function () { show(current); });
    // opened from the other layout: the same page, scrolled to the same
    // team, player, game or round when there is one
    if (startAt && startAt.anchor && document.getElementById(startAt.anchor)) {
      var startEl = document.getElementById(startAt.anchor);
      if (startAt.marked) mark(startEl, pageOf(startAt.anchor)); // its bar, carried over
      show(startAt.anchor, false, startEl);
    } else show(startAt && startAt.page ? startAt.page + '-top' : '');`;
  // Dark mode lives HERE, never in engine/report.js. The report YF writes
  // is a white page, and the files a TD downloads must stay exactly that —
  // byte-identical to YellowFruit's own (tools/yf_parity.mjs), and legible
  // when they are hosted or printed. This stylesheet is only ever added to
  // the in-page copy, on top of YF's, so the tab can follow the reader's
  // theme while the export stays the report everyone else expects.
  // Overrides are only the rules YF sets a colour in (its stylesheet is
  // reproduced rule for rule above), plus the defaults a white page gets
  // for free: canvas, text and links.
  const dark = `
    @media (prefers-color-scheme: dark) {
      html{color-scheme:dark}
      body{background:#232326;color:#e4e4e7}
      a{color:#8fb0f5}
      a:visited{color:#b9a4f5}
      tr:nth-child(even){background-color:#2c2c31}
      .scoreboardRoundHeader{background-color:#232326}
      .pseudoTFoot{border-top-color:#4d4d55;background-color:#232326 !important}
      .floatingTOC{background-color:#2c2c31;box-shadow:none}
      .inlineDivider{background-color:#4d4d55}
    }`;
  // the mark's colours, light and dark
  const marks = `
    :root{--qtBar:#1d4ed8}
    @media (prefers-color-scheme: dark){:root{--qtBar:#7aa2f7}}
    .qt-mark{border-left:4px solid var(--qtBar);padding-left:4px;margin-left:-8px}
    .qt-back{font-size:14px;font-weight:normal;margin-left:14px;white-space:nowrap}`;
  return `<!doctype html><html><head><meta charset="utf-8">${styleOf(pages[0].text)}
    <style>body{margin:0 8px 8px;background:#fff}
    .floatingTOC{position:static;box-shadow:none;margin:8px 0}
    .html-rpt-hide-in-yft-app{display:none}${marks}${dark}</style></head>
    <body>${sections.join('\n')}<script>${script}</script></body></html>`;
}

/** Mount the report in `box`; the frame grows to its content. */
// opts.start: {page, anchor} to open at (reportPlace from the other layout)
export function mountReport(box, pages, opts = {}) {
  // transparent, not white: the frame's own document paints its background
  // (light or dark), so a dark reader gets no white flash before it loads
  box.innerHTML = '<iframe class="report" title="stat report" style="width:100%;border:0;min-height:60vh;background:transparent"></iframe>';
  const frame = box.querySelector('iframe');
  frame.srcdoc = reportSrcdoc(pages, opts);
  const onMessage = (e) => {
    if (e.source === frame.contentWindow && e.data && e.data.qbtdReport === 'height') {
      frame.style.height = Math.max(400, e.data.height + 16) + 'px';
      // a followed link: bring its target (or the page's top) into view
      if (e.data.go) {
        const y = frame.getBoundingClientRect().top + window.scrollY + (Number(e.data.y) || 0);
        window.scrollTo(0, Math.max(0, y - 8));
      }
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** Where the reader is in a mounted report: its page, and the anchor (a
    team, player, game or round) nearest above the top of the screen, or
    null. The srcdoc frame shares the page's origin, so it's read directly. */
export function reportPlace(box) {
  const frame = box && box.querySelector('iframe.report');
  const doc = frame && frame.contentDocument;
  const sec = doc && [...doc.querySelectorAll('section[id^="page-"]')].find((x) => !x.hidden);
  if (!sec) return null;
  const page = sec.id.slice('page-'.length);
  // a section marked by a followed link is what the reader is on, even
  // when the page can't scroll it to the top
  const mark = sec.querySelector('.qt-mark');
  if (mark) {
    const own = mark.querySelector('[id]') || mark.previousElementSibling;
    if (own && own.id && !/-top$/.test(own.id)) return { page, anchor: own.id, marked: true };
  }
  const top = frame.getBoundingClientRect().top;
  let anchor = null;
  for (const el of sec.querySelectorAll('[id]')) {
    if (/-top$/.test(el.id)) continue;
    if (top + el.getBoundingClientRect().top > 80) break;
    anchor = el.id;
  }
  return { page, anchor };
}
