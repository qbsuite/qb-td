#!/usr/bin/env node
// tutorials.mjs — fill app/tutorials.json (the Tutorials page and the home
// page's line, app/js/tutorials.js) from a YouTube playlist:
//
//   node tools/tutorials.mjs <playlist URL or id>
//
// The playlist's videos come from its page (its public feed leaves out
// unlisted videos), each one's title from YouTube's oEmbed. A video
// already in the file keeps its place and its title, so the order and the
// short titles chosen here survive a rerun; a new one is added at the end
// under YouTube's title, and one gone from the playlist is dropped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'tutorials.json');

/** The playlist id in a URL (…?list=PL…) or the id itself. */
export function playlistId(arg) {
  const m = /[?&]list=([\w-]+)/.exec(String(arg));
  return m ? m[1] : /^[\w-]{10,}$/.test(arg) ? arg : null;
}

/** The video ids a playlist page lists, in the playlist's order. */
export function playlistVideos(html, list) {
  const at = new Map();
  const re = /"watchEndpoint":\{"videoId":"([\w-]{11})","playlistId":"([\w-]+)","index":(\d+)/g;
  for (const [, id, pl, i] of String(html).matchAll(re)) if (pl === list && !at.has(id)) at.set(id, Number(i));
  return [...at].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** The file's list after a playlist read: the file's videos still in the
    playlist, in the file's order and with its titles, then the new ones. */
export function mergeVideos(old, found) {
  const ids = new Set(found.map((v) => v.id));
  const kept = old.filter((v) => v && v.id && ids.has(v.id));
  const have = new Set(kept.map((v) => v.id));
  return [...kept.map((v) => ({ id: v.id, title: v.title })), ...found.filter((v) => !have.has(v.id))];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const list = playlistId(process.argv[2] || '');
  if (!list) { console.error('usage: node tools/tutorials.mjs <playlist URL or id>'); process.exit(2); }
  const page = await fetch('https://www.youtube.com/playlist?list=' + encodeURIComponent(list), { headers: { 'Accept-Language': 'en' } });
  const ids = page.ok ? playlistVideos(await page.text(), list) : [];
  if (!ids.length) { console.error('no videos found: is the playlist public or unlisted, and its videos too?'); process.exit(1); }
  const found = [];
  for (const id of ids) {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
    if (!r.ok) { console.error(`  ${id}: skipped, YouTube answered ${r.status} (a private video?)`); continue; }
    found.push({ id, title: String((await r.json()).title || '').trim() || id });
  }
  const old = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).videos || [] : [];
  const out = mergeVideos(old, found);
  writeFileSync(FILE, JSON.stringify({ playlist: list, videos: out }, null, 2) + '\n');
  for (const v of out) console.log(`  ${v.id}  ${v.title}`);
  console.log(`\n${out.length} videos in app/tutorials.json`);
}
