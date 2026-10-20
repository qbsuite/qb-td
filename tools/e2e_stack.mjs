#!/usr/bin/env node
// e2e_stack.mjs — the local servers the browser and Worker suites need,
// started together on ports you pick, on a fresh local database, and
// stopped together (Ctrl-C, or kill the pid it prints). Nothing here talks
// to Cloudflare or GitHub: the Worker runs under `wrangler dev --local`
// with no secrets, so the cron publishes nothing anywhere, and wrangler's
// metrics are off.
//
//   node tools/e2e_stack.mjs --state <dir> [--worker 9613] [--pages 9614]
//        [--proxy 9615 [--proxy-log <file>]] [--meter]
//
//   --state <dir>   the dev Worker's --persist-to folder; made fresh with
//                   schema.sql when it has no database yet
//   --worker        the dev Worker's port (QBTD_BASE=http://127.0.0.1:<port>)
//   --pages         the static server for app/ (QBTD_PAGES=http://localhost:<port>);
//                   the Worker's ALLOWED_ORIGIN is set to it
//   --proxy         tools/count_proxy.mjs in front of the Worker, for the
//                   pages (QBTD_PAGE_BASE=http://127.0.0.1:<port>)
//   --meter         the dev Worker with METER on (e2e_usage, sim_usage,
//                   sim_day, e2e_day, bench_routes)
//   --inspector     the dev Worker's inspector port (bench_routes: INSPECTOR=ws://127.0.0.1:<port>/ws)
// Prints one line `stack ready …` with the env to export, then waits.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const flag = (name) => args.includes('--' + name);
const state = opt('state');
if (!state) { console.error('--state <dir> is required (a fresh folder for the local database)'); process.exit(2); }
const W = Number(opt('worker', 9613));
const P = Number(opt('pages', 9614));
const X = opt('proxy') ? Number(opt('proxy')) : null;
const I = opt('inspector') ? Number(opt('inspector')) : null;
for (const port of [W, P, X, I].filter(Boolean)) {
  if (port < 9600 || port > 9699) { console.error('ports must be 9600-9699'); process.exit(2); }
}
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' };
const statePath = path.resolve(state);
mkdirSync(statePath, { recursive: true });
const fresh = !existsSync(path.join(statePath, 'v3', 'd1')) || !readdirSync(path.join(statePath, 'v3', 'd1')).length;
if (fresh) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'qb-td', '--local', '--file', 'schema.sql', '--persist-to', statePath],
    { cwd: path.join(ROOT, 'worker'), env, stdio: 'ignore' });
}
const kids = [];
const stop = () => { for (const k of kids) { try { k.kill('SIGTERM'); } catch (e) { /* gone */ } } };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('exit', stop);

const devArgs = ['wrangler', 'dev', '--local', '--port', String(W), '--ip', '127.0.0.1', '--test-scheduled', '--persist-to', statePath,
  '--var', `ALLOWED_ORIGIN:http://localhost:${P}`, '--show-interactive-dev-session=false'];
if (flag('meter')) devArgs.push('--var', 'METER:1');
if (I) devArgs.push('--inspector-port', String(I));
const logFile = path.join(statePath, 'wrangler_dev.log');
const out = (await import('node:fs')).openSync(logFile, 'a');
kids.push(spawn('npx', devArgs, { cwd: path.join(ROOT, 'worker'), env, stdio: ['ignore', out, out] }));
kids.push(spawn('python3', ['-m', 'http.server', String(P), '--bind', '127.0.0.1'], { cwd: path.join(ROOT, 'app'), stdio: 'ignore' }));
if (X) {
  const pargs = [path.join(ROOT, 'tools/count_proxy.mjs'), '--port', String(X), '--target', `http://127.0.0.1:${W}`];
  if (opt('proxy-log')) pargs.push('--log', path.resolve(opt('proxy-log')));
  kids.push(spawn(process.execPath, pargs, { stdio: 'inherit' }));
}
const up = (port) => new Promise((res) => { const s = createConnection(port, '127.0.0.1'); s.on('connect', () => { s.end(); res(true); }); s.on('error', () => res(false)); });
const t0 = Date.now();
for (;;) {
  const all = await Promise.all([W, P, X].filter(Boolean).map(up));
  if (all.every(Boolean)) {
    // the Worker answers once its first build is done
    try { const r = await fetch(`http://127.0.0.1:${W}/`); if (r.ok) break; } catch (e) { /* building */ }
  }
  if (Date.now() - t0 > 120000) { console.error('stack did not come up; see ' + logFile); stop(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 300));
}
const line = `stack ready pid=${process.pid} QBTD_BASE=http://127.0.0.1:${W} QBTD_PAGES=http://localhost:${P}`
  + (X ? ` QBTD_PAGE_BASE=http://127.0.0.1:${X}` : '') + ` QBTD_PERSIST=${statePath}` + (fresh ? ' (fresh database)' : '');
console.log(line);
writeFileSync(path.join(statePath, 'stack.env'), line + '\n');
await new Promise(() => {});
