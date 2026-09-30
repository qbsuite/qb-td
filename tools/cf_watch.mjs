// cf_watch.mjs — everything on the Cloudflare account that can cost or
// hit a Free-plan limit, for one UTC day, so nothing egregious hides:
// script requests per Worker (the 100k/day), static asset requests (free;
// the qb-td-live files), D1, R2, Durable Objects, and how many versions
// the files-only Worker has piled up (worker.js "public state on
// qb-td-live"). tools/cf_usage.mjs is the qb-td Worker's own day in
// detail (CPU, hot minutes); this is the whole account at a glance.
//   node tools/cf_watch.mjs [YYYY-MM-DD]
// Uses wrangler's own login (`npx wrangler login` once, in worker/).
// LIVE_SCRIPT=... names the files-only Worker (default qb-td-live).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QBTD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker');
const LIVE_SCRIPT = process.env.LIVE_SCRIPT || 'qb-td-live';
const day = process.argv[2] || new Date().toISOString().slice(0, 10);
execSync('npx wrangler whoami', { cwd: QBTD, stdio: 'ignore' });
const token = /^oauth_token\s*=\s*"(.*)"/m.exec(readFileSync([
  path.join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
  path.join(homedir(), '.config/.wrangler/config/default.toml'),
  path.join(homedir(), '.wrangler/config/default.toml'),
].find((p) => { try { readFileSync(p); return true; } catch (e) { return false; } }), 'utf8'))[1];
const account = JSON.parse(readFileSync(path.join(QBTD, '.wrangler/cache/wrangler-account.json'), 'utf8')).account.id;
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const gql = async (body) => {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: H, body: JSON.stringify({ query: body }) }).then((x) => x.json());
  if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 400));
  return r.data.viewer.accounts[0];
};
const f = `filter:{date:"${day}"}`;
const weekAgo = new Date(Date.parse(day) - 7 * 864e5).toISOString().slice(0, 10);
const safe = async (label, body) => { try { return await gql(body); } catch (e) { console.log(`  (${label} unavailable: ${e.message.slice(0, 120)})`); return null; } };

console.log(`Cloudflare account usage for ${day} (UTC)\n`);

const w = await safe('workers', `{ viewer { accounts(filter:{accountTag:"${account}"}) {
  byScript: workersOverviewRequestsAdaptiveGroups(limit:50, ${f}) { count sum { cpuTimeUs } dimensions { scriptName status } }
  assets: workersAssetsRequestsAdaptiveGroups(limit:50, ${f}) { sum { requests } dimensions { hostname cacheStatus statusCode } }
  latest: workersOverviewRequestsAdaptiveGroups(limit:1, ${f}, orderBy:[datetimeMinute_DESC]) { dimensions { datetimeMinute } }
} } }`);
if (w) {
  const per = {};
  for (const r of w.byScript) {
    const k = r.dimensions.scriptName;
    per[k] = per[k] || { requests: 0, errors: 0 };
    per[k].requests += r.count;
    if (r.dimensions.status !== 1 && r.dimensions.status !== 'success') per[k].errors += r.count; // 1 = success
  }
  const total = Object.values(per).reduce((s, v) => s + v.requests, 0);
  console.log(`Worker script requests (Free limit 100,000/day): ${total.toLocaleString()} (${(total / 1000).toFixed(1)}%)`);
  for (const [k, v] of Object.entries(per).sort((a, b) => b[1].requests - a[1].requests)) {
    console.log(`  ${k.padEnd(22)} ${String(v.requests).padStart(7)}  errors ${v.errors}`);
  }
  console.log(`  (analytics current to ${w.latest[0] ? w.latest[0].dimensions.datetimeMinute.slice(11, 16) : '?'} UTC)`);
  const assetTotal = w.assets.reduce((s, r) => s + r.sum.requests, 0);
  console.log(`\nStatic asset requests (documented free and unlimited): ${assetTotal.toLocaleString()}`);
  const byHost = {};
  for (const r of w.assets) {
    const k = r.dimensions.hostname + ' ' + r.dimensions.statusCode + ' ' + r.dimensions.cacheStatus;
    byHost[k] = (byHost[k] || 0) + r.sum.requests;
  }
  for (const [k, v] of Object.entries(byHost).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(52)} ${v}`);
}

const d = await safe('d1', `{ viewer { accounts(filter:{accountTag:"${account}"}) {
  d1AnalyticsAdaptiveGroups(limit:10, ${f}) { sum { rowsRead rowsWritten readQueries writeQueries } } } } }`);
if (d) {
  const s = d.d1AnalyticsAdaptiveGroups.reduce((a, r) => ({ rr: a.rr + r.sum.rowsRead, rw: a.rw + r.sum.rowsWritten }), { rr: 0, rw: 0 });
  console.log(`\nD1 rows read ${s.rr.toLocaleString()} / 5,000,000 (${(s.rr / 50000).toFixed(1)}%), written ${s.rw.toLocaleString()} / 100,000 (${(s.rw / 1000).toFixed(1)}%)`);
}

const r2 = await safe('r2', `{ viewer { accounts(filter:{accountTag:"${account}"}) {
  ops: r2OperationsAdaptiveGroups(limit:100, ${f}) { sum { requests } dimensions { actionType bucketName } }
  storage: r2StorageAdaptiveGroups(limit:10, filter:{date_geq:"${weekAgo}", date_leq:"${day}"}, orderBy:[date_DESC]) { max { payloadSize metadataSize objectCount } dimensions { bucketName date } } } } }`);
if (r2) {
  // Class A = mutating/listing, Class B = reads (Cloudflare R2 pricing); free: 1M A, 10M B per MONTH
  const A = /^(ListBuckets|PutBucket|ListObjects|PutObject|CopyObject|CompleteMultipartUpload|CreateMultipartUpload|UploadPart|UploadPartCopy|ListMultipartUploads|ListParts|PutBucketEncryption|PutBucketCors|PutBucketLifecycleConfiguration|LifecycleStorageTierTransition)$/;
  let a = 0; let b = 0; const other = {};
  for (const r of r2.ops) {
    const t = r.dimensions.actionType;
    if (A.test(t)) a += r.sum.requests;
    else if (/^(HeadBucket|HeadObject|GetObject|UsageSummary|GetBucket)/.test(t)) b += r.sum.requests;
    else other[t] = (other[t] || 0) + r.sum.requests;
  }
  console.log(`\nR2 Class A ${a.toLocaleString()} (free 1M/month = ~33k/day), Class B ${b.toLocaleString()} (free 10M/month = ~333k/day)` +
    (Object.keys(other).length ? `, other ${JSON.stringify(other)}` : ''));
  const seen = new Set();
  for (const s of r2.storage) {
    if (seen.has(s.dimensions.bucketName)) continue;
    seen.add(s.dimensions.bucketName);
    console.log(`  bucket ${s.dimensions.bucketName}: ${(s.max.payloadSize / 1e6).toFixed(1)} MB, ${s.max.objectCount} objects (free 10 GB) as of ${s.dimensions.date}`);
  }
}

const doq = await safe('durable objects', `{ viewer { accounts(filter:{accountTag:"${account}"}) {
  durableObjectsInvocationsAdaptiveGroups(limit:20, ${f}) { sum { requests } dimensions { scriptName } } } } }`);
if (doq) {
  const t = doq.durableObjectsInvocationsAdaptiveGroups.reduce((s, r) => s + r.sum.requests, 0);
  console.log(`\nDurable Object requests (Free 100,000/day): ${t.toLocaleString()}` +
    doq.durableObjectsInvocationsAdaptiveGroups.map((r) => `  ${r.dimensions.scriptName}=${r.sum.requests}`).join(''));
}

// Deploy side: versions pile up one per deploy (no delete endpoint, no
// documented cap). Deleting and recreating the Worker resets them.
const vers = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${LIVE_SCRIPT}/versions?per_page=100`, { headers: H }).then((x) => x.json()).catch(() => null);
if (vers && vers.success) {
  const n = vers.result_info?.total_count ?? vers.result?.items?.length ?? '?';
  console.log(`\n${LIVE_SCRIPT} versions stored: ${n}`);
} else if (vers) console.log(`\n${LIVE_SCRIPT} versions: ${vers.errors?.[0]?.message || 'n/a'}`);
console.log('\nFalls back to the Worker: Workers Logs for qb-td, search "live fallback" (reason: 404, err, old, latched).');
