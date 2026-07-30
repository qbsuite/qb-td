// build_read.mjs — bundles the reader page (npm run build:read). The one
// thing the plain esbuild CLI couldn't do: swap MODAQ's stock
// AddQuestionsDialog (a bare packet-file picker) for qb-td's tiebreaker
// selector (app/js/tb_add_dialog.js) wherever MODAQ imports it. Everything
// else matches the old CLI invocation.
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const tbDialogPlugin = {
  name: 'qbtd-tb-dialog',
  setup(build) {
    build.onResolve({ filter: /[/\\]AddQuestionsDialog$/ }, (args) => {
      // only MODAQ's own import gets swapped; nothing of ours uses this name
      if (!args.importer.split(path.sep).join('/').includes('/modaq/')) return null;
      return { path: path.join(root, 'app', 'js', 'tb_add_dialog.js') };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(root, 'app', 'js', 'read_main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: path.join(root, 'app', 'js', 'read.bundle.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  plugins: [tbDialogPlugin],
});
