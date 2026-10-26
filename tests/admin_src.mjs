// admin_src.mjs — the hub's QBJ bundle download (buildZip in admin.js
// showStats), run in Node as the file has it now. The hub module needs a
// browser, so the function's text is taken out of the file and built with
// what admin.js itself imports from the engine and from hubgames.js, read
// from its import lines: a name buildZip uses but the file doesn't import
// fails here as it would in the hub. tests/hubgames_ref.mjs holds it to
// the copy pinned in tests/ref_games.mjs (hubZipRef).

import { readFileSync } from 'node:fs';

const FILE = new URL('../app/js/admin.js', import.meta.url);

// what showStats has in scope when buildZip runs, handed in by the caller
// with the games it zips (matches, modaqFiles, raw, and got for its names)
const SCOPE = ['pub', 'a', 't', 'files', 'inPick', 'download'];

/** buildZip from admin.js, with the calling shape of ref_games.mjs
    hubZipRef plus the games picked: ({ pub, a, t, files, got, matches,
    modaqFiles, raw, inPick, download }) -> buildZip. */
export async function hubOwnBuildZip() {
  const src = readFileSync(FILE, 'utf8');
  const scope = {};
  for (const m of src.matchAll(/^import \{([^}]*)\} from '(\.\.\/engine\/\w+\.js|\.\/hubgames\.js)';$/gm)) {
    const mod = await import(new URL((m[2].startsWith('./') ? '../app/js/' + m[2].slice(2) : '../app/' + m[2].slice(3)), import.meta.url));
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [name, as = name] = spec.split(/\s+as\s+/);
      if (!(name in mod)) throw new Error(`admin.js imports ${name} from ${m[2]}, which has no such export`);
      if (!SCOPE.includes(as)) scope[as] = mod[name];
    }
  }
  const start = src.indexOf('\n  const buildZip = async ({ matches, modaqFiles, raw, names, read = () => undefined, roster = null }) => {\n');
  const end = start < 0 ? -1 : src.indexOf('\n  };\n', start);
  if (end < 0) throw new Error('admin.js: const buildZip not found');
  const names = Object.keys(scope);
  const factory = new Function(...SCOPE, ...names, `${src.slice(start + 1, end + 5)}\n  return buildZip;`);
  // the games it zips are its arguments: the stored uploads the click read
  // (with no `read`, each game file added by hand is read on its own)
  return (ctx) => {
    const buildZip = factory(...SCOPE.map((k) => ctx[k]), ...names.map((n) => scope[n]));
    return () => buildZip({ matches: ctx.matches, modaqFiles: ctx.modaqFiles, raw: ctx.raw, names: ctx.got.names });
  };
}
