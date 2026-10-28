#!/usr/bin/env node
// changelog_add.mjs — add one line to today's release in app/changelog.txt.
//
//   node tools/changelog_add.mjs ARCHIVE "Added SoCal Penn Bowl."
//
// Today's release is the top one when it carries today's date (TZ decides
// what today is), else a new release goes on top. The line joins the end
// of its section there, or a new section at the end of the release. For
// the workflows that push to main on their own (.github/workflows/
// archive.yml), since every deploy ships a changelog entry.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'changelog.txt');

export function addLine(text, section, line, now = new Date()) {
  const heading = `Release Notes for ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const tag = `[ ${section} ]`;
  const item = '- ' + line;
  const lines = text.split('\n');
  if (lines[0] !== heading) return [heading, '', tag, item, '', text].join('\n');
  // today's release runs to the next heading
  let end = lines.findIndex((l, i) => i > 0 && l.startsWith('Release Notes for '));
  if (end < 0) end = lines.length;
  while (end > 1 && lines[end - 1] === '') end--;
  const at = lines.indexOf(tag);
  if (at > 0 && at < end) {
    let last = at;
    while (last + 1 < end && lines[last + 1].startsWith('- ')) last++;
    lines.splice(last + 1, 0, item);
  } else {
    lines.splice(end, 0, '', tag, item);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [section, line] = process.argv.slice(2);
  if (!section || !line) {
    console.error('usage: node tools/changelog_add.mjs SECTION "line"');
    process.exit(2);
  }
  writeFileSync(FILE, addLine(readFileSync(FILE, 'utf8'), section, line));
}
