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

/** buildReport()'s pages -> the srcdoc of a frame that shows them. */
export function reportSrcdoc(pages) {
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
  const script = `
    var files = ${JSON.stringify(FILES)};
    var current = '';
    function show(hash) {
      current = hash;
      var pg = files.filter(function (f) { return hash === f + '-top' || hash.indexOf(f + '-') === 0; })[0] || files[0];
      files.forEach(function (f) { document.getElementById('page-' + f).hidden = f !== pg; });
      var el = hash ? document.getElementById(hash) : null;
      if (el) el.scrollIntoView(); else window.scrollTo(0, 0);
      parent.postMessage({ qbtdReport: 'height', height: document.documentElement.scrollHeight }, '*');
    }
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      e.preventDefault();
      show(a.getAttribute('href').slice(1));
    });
    window.addEventListener('load', function () { show(current); });
    show('');`;
  return `<!doctype html><html><head><meta charset="utf-8">${styleOf(pages[0].text)}
    <style>body{margin:0 8px 8px} .floatingTOC{position:static;box-shadow:none;margin:8px 0}
    .html-rpt-hide-in-yft-app{display:none}</style></head>
    <body>${sections.join('\n')}<script>${script}</script></body></html>`;
}

/** Mount the report in `box`; the frame grows to its content. */
export function mountReport(box, pages) {
  box.innerHTML = '<iframe class="report" title="stat report" style="width:100%;border:0;min-height:60vh;background:#fff"></iframe>';
  const frame = box.querySelector('iframe');
  frame.srcdoc = reportSrcdoc(pages);
  const onMessage = (e) => {
    if (e.source === frame.contentWindow && e.data && e.data.qbtdReport === 'height') {
      frame.style.height = Math.max(400, e.data.height + 16) + 'px';
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
