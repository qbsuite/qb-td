// changelog.js — reads app/changelog.txt, written in the Counter-Strike
// release-notes style:
//
//   Release Notes for 9/27/2026
//
//   [ LIVE HUB ]
//   - Added ...
//
// Newest release first. One release per deploy: a short, plain line for
// each change a TD, moderator or player would notice.

/** changelog.txt -> [{date: 'M/D/YYYY', iso: 'YYYY-MM-DD', sections:
    [{name, items: [text]}]}], in file order. Throws on a line it can't
    place, so a malformed entry fails the test suite rather than
    vanishing from the page. */
export function parseChangelog(text) {
  const releases = [];
  let rel = null;
  let sec = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let m;
    if ((m = /^Release Notes for (\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(line))) {
      const [, mo, d, y] = m;
      rel = { date: `${Number(mo)}/${Number(d)}/${y}`,
        iso: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, sections: [] };
      releases.push(rel);
      sec = null;
    } else if ((m = /^\[ ([A-Z0-9 &/+-]+) \]$/.exec(line)) && rel) {
      sec = { name: m[1], items: [] };
      rel.sections.push(sec);
    } else if (line.startsWith('- ') && sec) {
      sec.items.push(line.slice(2).trim());
    } else {
      throw new Error(`changelog line ${i + 1}: can't place "${line}"`);
    }
  });
  return releases;
}
