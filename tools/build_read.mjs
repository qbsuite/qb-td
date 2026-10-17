// build_read.mjs — bundles the reader page (npm run build:read). The one
// thing the plain esbuild CLI couldn't do: swap MODAQ's stock
// AddQuestionsDialog (a bare packet-file picker) for qb-td's tiebreaker
// selector (app/js/tb_add_dialog.js) wherever MODAQ imports it. Everything
// else matches the old CLI invocation.
import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
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

// Replace tossup / Replace bonus, beside MODAQ's own Throw out items in
// the Actions menu: they open tb_add_dialog's replace mode (which the
// AddQuestionsDialog swap above makes the import resolve to). The build
// fails if MODAQ's menu no longer reads the way this expects.
// (MODAQ's files have CRLF line endings; either is accepted)
const MENU_END = /( {12}\],\r?\n {8}\},\r?\n {4}\};\r?\n {4}items\.push\(removeQuestionSection\);)/;
const REPLACE_ITEMS = `                {
                    key: "qbtdReplaceTossup",
                    text: "Replace tossup...",
                    onClick: () => require("./dialogs/AddQuestionsDialog").openReplace(appState, "tossup"),
                    disabled: appState.game.cycles.length === 0,
                },
                {
                    key: "qbtdReplaceBonus",
                    text: "Replace bonus...",
                    onClick: () => require("./dialogs/AddQuestionsDialog").openReplace(appState, "bonus"),
                    disabled: appState.game.cycles.length === 0,
                },
`;
const replaceMenuPlugin = {
  name: 'qbtd-replace-menu',
  setup(build) {
    build.onLoad({ filter: /[/\\]modaq[/\\]src[/\\]components[/\\]GameBar\.js$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      if (!MENU_END.test(text)) throw new Error('build_read: MODAQ GameBar.js menu changed; update the Replace items patch');
      return { contents: text.replace(MENU_END, (m) => REPLACE_ITEMS + m), loader: 'js' };
    });
  },
};

// MODAQ's Throw out tossup (the X on a tossup and the Actions item) also
// drops the thrown-out tossup's negs (tb_add_dialog clearThrownOutNegs),
// as Replace tossup does.
const THROW_OUT = /(cycle\.addThrownOutTossup\(tossupNumber - 1\);)(\r?\n)/;
const throwOutPlugin = {
  name: 'qbtd-throw-out',
  setup(build) {
    build.onLoad({ filter: /[/\\]modaq[/\\]src[/\\]components[/\\]TossupQuestionController\.js$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      if (!THROW_OUT.test(text)) throw new Error('build_read: MODAQ TossupQuestionController.js changed; update the throw-out patch');
      return {
        contents: text.replace(THROW_OUT, (m, call, nl) =>
          `${call}${nl}    require("./dialogs/AddQuestionsDialog").clearThrownOutNegs(appState, cycle, tossupNumber - 1);${nl}`),
        loader: 'js',
      };
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
  plugins: [tbDialogPlugin, replaceMenuPlugin, throwOutPlugin],
});
