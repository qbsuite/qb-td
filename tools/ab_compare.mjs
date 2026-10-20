#!/usr/bin/env node
// ab_compare.mjs — two QBTD_CAPTURE directories (tests/ui_e2e.js) set side
// by side, after taking out what differs run to run and nothing else:
// slugs, link secrets, the random part of upload keys, clock times and
// 'fix…' game ids. Everything else must be equal: each download (zips
// entry by entry), each body behind the hub's file links, each body the
// pages posted, the hub's panes, the public stats, and the pages' Worker
// requests per section and route — through tools/count_proxy.mjs too,
// where non-OPTIONS counts must match exactly, preflights must ask for the
// same headers, and GET answers must be the same size.
//
//   node tools/ab_compare.mjs <baseline capture dir> <other capture dir>
//
// Exit 0 when they match, 1 with the differences listed. Two baseline runs
// must match before a comparison against a change means anything.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readZip } from '../app/engine/zip.js';

const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('usage: node tools/ab_compare.mjs <dirA> <dirB>'); process.exit(2); }

const namesOf = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, 'names-run.json'), 'utf8')); } catch (e) { return {}; } };
const NA = namesOf(A);
const NB = namesOf(B);

// Flows whose request counts are timing by design: 24b drives qb-td-live
// through hangs and timeouts. Their requests are still listed; only the
// counts are not held to each other.
const TIMED_FLOWS = [/^24b\./];
// Answers that carry clocks or counters (stamps, rev, created, live
// marks): their sizes move run to run, so only their counts are compared.
const VOLATILE = [/^GET \/a\/:admin(\?rev)?$/, /^GET \/pub\/:slug(\?fb=\w+)?$/, /^GET \/pub\/:slug\/rounds/, /^GET \/b\/:room(\/load)?$/,
  /^GET \/s\/:set(\/|$)/, /^GET \/pubset\//];
const timed = (flow) => TIMED_FLOWS.some((re) => re.test(flow));
const volatile = (route) => VOLATILE.some((re) => re.test(route));

// one side's run-specific names, then the generic shapes
function normalizer(names) {
  const pairs = Object.entries(names).filter(([, v]) => typeof v === 'string' && v.length >= 5)
    .sort((x, y) => y[1].length - x[1].length);
  return (text) => {
    let s = text;
    for (const [k, v] of pairs) s = s.split(v).join('<' + k + '>');
    return s
      .replace(/\bui-(big|bk|set|e7|e2e)-[a-z0-9]{1,5}\b/g, 'ui-$1-<r>')
      .replace(/\b[a-hjkmnp-z2-9]{20}\b/g, '<secret>')
      .replace(/([/"'=]|%2F)[a-hjkmnp-z2-9]{8}-/g, '$1<rand>-')
      .replace(/\bfix[0-9a-z]{7,9}\b/g, 'fix<t>')
      // a stats password's salt and hash are random each run
      .replace(/\b[0-9a-f]{24,}\b/g, '<hex>')
      .replace(/\b1[789]\d{11}\b/g, '<ms>')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)\b/g, '<time>')
      .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?:, \d{4})?\b/g, '<date>')
      .replace(/\b\d+ (?:seconds?|minutes?|hours?|days?|min|h|s) ago\b/g, '<ago>')
      .replace(/(QBTD_PAGE_BASE|127\.0\.0\.1:)\d{4}/g, '$1<port>');
  };
}
const nA = normalizer(NA);
const nB = normalizer(NB);

const problems = [];
const say = (msg) => { problems.push(msg); };

const list = (dir) => readdirSync(dir).sort();
const keyed = (dir, norm) => new Map(list(dir).map((f) => [norm(f), f]));
const fa = keyed(A, nA);
const fb = keyed(B, nB);
for (const k of fa.keys()) if (!fb.has(k)) say('only in ' + A + ': ' + k);
for (const k of fb.keys()) if (!fa.has(k)) say('only in ' + B + ': ' + k);

const firstDiff = (x, y) => {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return `at ${i}: …${JSON.stringify(x.slice(Math.max(0, i - 60), i + 60))} vs …${JSON.stringify(y.slice(Math.max(0, i - 60), i + 60))}`;
};

async function compareFile(k) {
  const a = readFileSync(path.join(A, fa.get(k)));
  const b = readFileSync(path.join(B, fb.get(k)));
  if (a[0] === 0x50 && a[1] === 0x4b && a[2] === 3 && a[3] === 4) {
    const za = await readZip(new Uint8Array(a));
    const zb = await readZip(new Uint8Array(b));
    const ea = new Map(za.map((e) => [nA(e.name), nA(new TextDecoder().decode(e.data))]));
    const eb = new Map(zb.map((e) => [nB(e.name), nB(new TextDecoder().decode(e.data))]));
    const order = (z, n) => z.map((e) => n(e.name)).join('\n');
    if (order(za, nA) !== order(zb, nB)) say(`${k}: entries differ: ${firstDiff(order(za, nA), order(zb, nB))}`);
    for (const [name, text] of ea) if (eb.has(name) && eb.get(name) !== text) say(`${k} ${name}: ${firstDiff(text, eb.get(name))}`);
    return;
  }
  if (k === 'requests-proxy.json') return compareProxy(JSON.parse(a.toString()), JSON.parse(b.toString()));
  if (k === 'requests-cdp.json') {
    const ca = JSON.parse(a.toString());
    const cb = JSON.parse(b.toString());
    for (const key of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      if (timed(key)) continue;
      if ((ca[key] || 0) !== (cb[key] || 0)) say(`requests ${key}: ${ca[key] || 0} vs ${cb[key] || 0}`);
    }
    return;
  }
  if (k === 'requests-bodies.json') {
    const ba = JSON.parse(a.toString()).filter((x) => !timed(x.flow));
    const bb = JSON.parse(b.toString()).filter((x) => !timed(x.flow));
    if (ba.length !== bb.length) say(`bodies: ${ba.length} posted vs ${bb.length}`);
    for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
      const x = nA(JSON.stringify(ba[i]));
      const y = nB(JSON.stringify(bb[i]));
      if (x !== y) say(`bodies #${i} (${ba[i].flow} ${ba[i].route}): ${firstDiff(x, y)}`);
    }
    return;
  }
  const ta = nA(a.toString('utf8'));
  const tb = nB(b.toString('utf8'));
  if (ta !== tb) say(`${k}: ${firstDiff(ta, tb)}`);
}

// the proxy's log: non-OPTIONS requests per flow and route exactly; for
// preflights the header sets asked for; GET answers the same size
function compareProxy(la, lb) {
  if (!Array.isArray(la) || !Array.isArray(lb)) { if (JSON.stringify(la) !== JSON.stringify(lb)) say('proxy log: ' + JSON.stringify([la, lb]).slice(0, 200)); return; }
  const agg = (log) => {
    const out = new Map();
    for (const r of log) {
      const k = r.flow + ' | ' + r.route;
      const x = out.get(k) || { n: 0, opts: new Set(), getBytes: 0, postBytes: 0, status: new Set() };
      if (r.method === 'OPTIONS') x.opts.add(r.acrh || '');
      else { x.n++; x.status.add(r.status); }
      if (r.method === 'GET') x.getBytes += r.resBytes;
      if (r.method === 'POST' || r.method === 'PUT') x.postBytes += r.reqBytes;
      out.set(k, x);
    }
    return out;
  };
  const ga = agg(la);
  const gb = agg(lb);
  for (const k of new Set([...ga.keys(), ...gb.keys()])) {
    const x = ga.get(k) || { n: 0, opts: new Set(), getBytes: 0, postBytes: 0, status: new Set() };
    const y = gb.get(k) || { n: 0, opts: new Set(), getBytes: 0, postBytes: 0, status: new Set() };
    const [flow, route] = k.split(' | ');
    if (x.n !== y.n && !timed(flow)) say(`proxy ${k}: ${x.n} requests vs ${y.n}`);
    const oa = [...x.opts].sort().join(' / ');
    const ob = [...y.opts].sort().join(' / ');
    if (oa !== ob) say(`proxy ${k}: preflights ask for [${oa}] vs [${ob}]`);
    if (x.n === y.n && !volatile(route) && !timed(flow) && x.getBytes !== y.getBytes) say(`proxy ${k}: GET answers ${x.getBytes} bytes vs ${y.getBytes}`);
    if (x.n === y.n && x.postBytes !== y.postBytes) say(`proxy ${k}: request bodies ${x.postBytes} bytes vs ${y.postBytes}`);
    if ([...x.status].sort().join() !== [...y.status].sort().join()) say(`proxy ${k}: status ${[...x.status]} vs ${[...y.status]}`);
  }
}

for (const k of fa.keys()) if (fb.has(k)) await compareFile(k);
if (problems.length) {
  console.log(problems.length + ' difference(s):\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`captures match (${fa.size} files)`);
