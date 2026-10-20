// pubview_src.mjs — the public page's own fetchMatches (app/js/pubview.js),
// run in Node as the file has it now. The page module needs a browser, so
// the function's text is taken out of the file and built with what
// pubview.js itself imports from the engine (qbj.js, games.js, buzz.js),
// read from its import lines: a name the function uses but the file
// doesn't import fails here as it would on the page. The equivalence
// tests (games_golden.mjs, bench_games.mjs) hold it to the copy pinned in
// tests/ref_games.mjs.

import { readFileSync } from 'node:fs';

const FILE = new URL('../app/js/pubview.js', import.meta.url);

/** fetchMatches from pubview.js, with the same calling shape as
    ref_games.mjs pubviewFetchMatches: ({ entries, files, roster }) ->
    { matches, errors, rawEntries, loadedIds }. */
export async function pubviewOwnFetchMatches() {
  const src = readFileSync(FILE, 'utf8');
  const scope = {};
  for (const m of src.matchAll(/^import \{([^}]*)\} from '\.\.\/engine\/(qbj|games|buzz)\.js';$/gm)) {
    const mod = await import(new URL('../app/engine/' + m[2] + '.js', import.meta.url));
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!(name in mod)) throw new Error(`pubview.js imports ${name} from ${m[2]}.js, which has no such export`);
      scope[name] = mod[name];
    }
  }
  const start = src.indexOf('\nasync function fetchMatches(');
  const end = start < 0 ? -1 : src.indexOf('\n}\n', start);
  if (end < 0) throw new Error('pubview.js: async function fetchMatches not found');
  const names = Object.keys(scope);
  // the page's module state that fetchMatches reads and sets
  const factory = new Function('state', 'fetchRounds', 'fetchWholeBundle', ...names, `
    let loadedIds = null;
    let rawEntries = [];
    ${src.slice(start + 1, end + 2)}
    return { fetchMatches, after: () => ({ loadedIds, rawEntries }) };`);
  return async ({ entries, files, roster }) => {
    const fetched = async () => entries;
    const page = factory({ rounds: null, files }, fetched, fetched, ...names.map((n) => scope[n]));
    const errors = [];
    const matches = await page.fetchMatches(errors, Promise.resolve(roster));
    return { matches, errors, ...page.after() };
  };
}
