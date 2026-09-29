// cf_usage.mjs — what a day cost on Cloudflare, from the account's own
// analytics: qb-td's requests, errors and CPU, the minutes whose slowest
// invocations ran past the Free plan's documented 10ms, and D1 rows.
//   node tools/cf_usage.mjs                # today (UTC)
//   node tools/cf_usage.mjs 2026-10-04     # a tournament day
//
// Uses wrangler's own login (run `npx wrangler login` once); refreshes the
// token by running `wrangler whoami` first. Set CLOUDFLARE_API_TOKEN (with
// Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID to use a token instead.
//
// Reading it: each tick's per-tournament rebuild is its own invocation
// (worker.js Rebuild), so a minute with a high p99 during a tournament is
// either a rebuild, a heavy route, or the tick's GitHub commit. Analytics
// can't split by entrypoint; a p99 that sits well under 10ms everywhere is
// the answer we want. Analytics keep ~90 days.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker');
const SCRIPT = process.env.SCRIPT || 'qb-td';
const day = process.argv[2] || new Date().toISOString().slice(0, 10);

function credentials() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
  }
  try { execSync('npx wrangler whoami', { cwd: WORKER_DIR, stdio: 'ignore' }); } catch (e) { /* reported below */ }
  const cfg = [
    path.join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    path.join(homedir(), '.config/.wrangler/config/default.toml'),
    path.join(homedir(), '.wrangler/config/default.toml'),
  ].find(existsSync);
  const token = cfg && (/^oauth_token\s*=\s*"(.*)"/m.exec(readFileSync(cfg, 'utf8')) || [])[1];
  const cache = path.join(WORKER_DIR, '.wrangler/cache/wrangler-account.json');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
    || (existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')).account.id : null);
  if (!token || !account) throw new Error('no Cloudflare credentials: run `npx wrangler login` in worker/, or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID');
  return { token, account };
}

const { token, account } = credentials();
async function gql(query) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(body.errors[0].message);
  return body.data.viewer.accounts[0];
}
const ms = (us) => (us / 1000).toFixed(1);

const daily = await gql(`{ viewer { accounts(filter:{accountTag:"${account}"}) {
  workersInvocationsAdaptive(limit:50, filter:{date:"${day}", scriptName:"${SCRIPT}"}) {
    sum { requests errors subrequests cpuTimeUs } quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 }
    dimensions { status } } } } }`);
const rows = daily.workersInvocationsAdaptive;
const total = rows.reduce((n, r) => n + r.sum.requests, 0);
console.log(`${SCRIPT} on ${day} (UTC): ${total.toLocaleString()} invocations (limit 100,000/day on Free)`);
for (const r of rows.sort((a, b) => b.sum.requests - a.sum.requests)) {
  console.log(`  ${r.dimensions.status.padEnd(26)} ${String(r.sum.requests).padStart(7)}  errors ${r.sum.errors}  ` +
    `CPU p50 ${ms(r.quantiles.cpuTimeP50)}ms  p99 ${ms(r.quantiles.cpuTimeP99)}ms  p99.9 ${ms(r.quantiles.cpuTimeP999)}ms`);
}
const killed = rows.filter((r) => /exceeded/i.test(r.dimensions.status)).reduce((n, r) => n + r.sum.requests, 0);
console.log(killed ? `  !! ${killed} invocation(s) killed for exceeding CPU/resources` : '  no invocation killed for CPU');

const perMinute = await gql(`{ viewer { accounts(filter:{accountTag:"${account}"}) {
  workersInvocationsAdaptive(limit:2000, filter:{date:"${day}", scriptName:"${SCRIPT}"}, orderBy:[datetimeMinute_ASC]) {
    sum { requests } quantiles { cpuTimeP99 } dimensions { datetimeMinute } } } } }`);
const hot = perMinute.workersInvocationsAdaptive.filter((m) => m.quantiles.cpuTimeP99 > 10000);
console.log(`\nminutes whose slowest 1% ran past 10ms CPU: ${hot.length} of ${perMinute.workersInvocationsAdaptive.length} active minutes`);
for (const m of hot.sort((a, b) => b.quantiles.cpuTimeP99 - a.quantiles.cpuTimeP99).slice(0, 15)) {
  console.log(`  ${m.dimensions.datetimeMinute.slice(11, 16)}  p99 ${ms(m.quantiles.cpuTimeP99)}ms over ${m.sum.requests} invocation(s)`);
}

const d1 = await gql(`{ viewer { accounts(filter:{accountTag:"${account}"}) {
  d1AnalyticsAdaptiveGroups(limit:10, filter:{date:"${day}"}) { sum { readQueries writeQueries rowsRead rowsWritten } } } } }`);
const s = d1.d1AnalyticsAdaptiveGroups.reduce((a, g) => ({
  rowsRead: a.rowsRead + g.sum.rowsRead, rowsWritten: a.rowsWritten + g.sum.rowsWritten }), { rowsRead: 0, rowsWritten: 0 });
console.log(`\nD1 (all databases): ${s.rowsRead.toLocaleString()} rows read (limit 5,000,000/day), ` +
  `${s.rowsWritten.toLocaleString()} rows written (limit 100,000/day)`);
