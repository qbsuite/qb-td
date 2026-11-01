// yapp_diff.mjs — app/engine/yapp.js against YAPP's own command line, on
// every .docx under a folder: both ways YAPP writes JSON (MODAQ's fields,
// and every field), byte for byte.
//
// It prints no question text: per file, whether the two agree, and where
// they first differ as a JSON path and a character offset; errors as
// YAPP's messages with their quoted snippet cut out.
//
// Run: node tools/yapp_diff.mjs <folder> [--cli <YetAnotherPacketParserCommandLine.dll>] [--dotnet <dotnet>]
// The command line is YAPP's release zip (github.com/alopezlago/
// YetAnotherPacketParser/releases), which needs a .NET 8 runtime.

import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertPacket } from '../app/engine/yapp.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const k = args.indexOf(name); return k < 0 ? fallback : args.splice(k, 2)[1]; };
const cli = opt('--cli', process.env.YAPP_CLI);
const dotnet = opt('--dotnet', process.env.DOTNET || 'dotnet');
const folder = args[0];
if (!folder || !cli) {
  console.error('usage: node tools/yapp_diff.mjs <folder> --cli <YetAnotherPacketParserCommandLine.dll> [--dotnet <dotnet>]');
  process.exit(2);
}

async function docxFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...await docxFiles(path));
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) out.push(path);
  }
  return out.sort();
}

const work = await mkdtemp(join(tmpdir(), 'yapp-diff-'));
let runs = 0;
// YAPP's command line on one file: {text} or {errors}
function yapp(path, modaq) {
  const out = join(work, `${runs++}.json`);
  const argv = [cli, '-i', path, '-o', out, ...(modaq ? ['-m'] : [])];
  return new Promise((resolve) => {
    execFile(dotnet, argv, { maxBuffer: 1 << 26 }, async (err, stdout, stderr) => {
      try { resolve({ text: await readFile(out, 'utf8') }); }
      catch { resolve({ errors: stderr.trim().split('\n'), crashed: !!err || /Unhandled exception/.test(stderr) }); }
    });
  });
}

// where two JSON texts first differ: a path into the first one, and the offset
function firstDifference(a, b) {
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  // the path: the keys and indexes open at offset k in a
  const path = [];
  const stack = [];
  let inString = false; let key = null; let buf = '';
  for (let j = 0; j < k; j++) {
    const c = a[j];
    if (inString) {
      if (c === '\\') { buf += c + a[++j]; continue; }
      if (c === '"') { inString = false; key = buf; } else buf += c;
      continue;
    }
    if (c === '"') { inString = true; buf = ''; }
    else if (c === '{') stack.push({ obj: true, name: null });
    else if (c === '[') stack.push({ obj: false, index: 0 });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ':') stack[stack.length - 1].name = key;
    else if (c === ',' && !stack[stack.length - 1].obj) stack[stack.length - 1].index++;
  }
  for (const s of stack) path.push(s.obj ? s.name ?? '?' : '[' + s.index + ']');
  return `${path.join('.').replace(/\.\[/g, '[')} at offset ${k}`;
}
const scrub = (m) => m.replace(/, ".*"\)$/, ', "…")');

const files = await docxFiles(folder);
const tally = { same: 0, different: 0, unsure: 0, bothRefused: 0 };
for (const path of files) {
  const bytes = new Uint8Array(await readFile(path));
  const name = path.slice(folder.length).replace(/^\//, '');
  const notes = [];
  let verdict = 'same';
  for (const modaq of [true, false]) {
    const [theirs, ours] = await Promise.all([yapp(path, modaq), convertPacket(bytes, { modaq, pretty: true })]);
    const label = modaq ? 'MODAQ' : 'full';
    if (ours.unsure) { verdict = 'unsure'; notes.push(`${label}: port unsure (${ours.errors[0]}); YAPP ${theirs.text ? 'parsed it' : 'refused it'}`); break; }
    if (theirs.text !== undefined && ours.text !== undefined) {
      if (theirs.text !== ours.text) { verdict = 'different'; notes.push(`${label}: first differs at ${firstDifference(theirs.text, ours.text)}`); }
    } else if (theirs.text !== undefined) {
      verdict = 'different'; notes.push(`${label}: YAPP parsed it, the port refused: ${ours.errors.map(scrub).join(' | ')}`);
    } else if (ours.text !== undefined) {
      verdict = 'different'; notes.push(`${label}: the port parsed it, YAPP ${theirs.crashed ? 'crashed' : 'refused'}: ${theirs.errors.map(scrub).slice(0, 3).join(' | ')}`);
    } else {
      const same = theirs.errors.join('\n') === ours.errors.join('\n');
      if (verdict === 'same') verdict = same ? 'bothRefused' : 'different';
      if (!same) notes.push(`${label}: both refused, with different messages: YAPP ${theirs.errors.map(scrub).slice(0, 2).join(' | ')}; port ${ours.errors.map(scrub).slice(0, 2).join(' | ')}`);
    }
  }
  tally[verdict]++;
  console.log(`${verdict.padEnd(11)} ${name}${notes.length ? '\n    ' + notes.join('\n    ') : ''}`);
}
await rm(work, { recursive: true, force: true });
console.log(`\n${files.length} files: ${tally.same} identical, ${tally.bothRefused} refused by both alike, `
  + `${tally.unsure} left to YAPP, ${tally.different} different`);
process.exit(tally.different ? 1 : 0);
