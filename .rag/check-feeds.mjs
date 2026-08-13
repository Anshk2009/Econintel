// rag/check-feeds.mjs — health check for every RSS feed in feeds.json.
//
// WHY THIS EXISTS: a feed that starts 403-ing or returns an HTML page instead of
// XML does NOT break the ingester — collectFeed() catches the error and returns
// [], so the run stays green while the library quietly stops growing from that
// source. That is the worst kind of failure: invisible. This script makes it
// loud, and CI runs it weekly.
//
// Exit codes:
//   0 = healthy enough
//   1 = a CITEABLE feed is down, or more than a third of all feeds are down
// A citeable feed failing is always a hard fail: those are the only sources the
// chat is allowed to cite, so losing one directly degrades answer quality.
//
// Run locally:  node check-feeds.mjs
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fetchWithTimeout, FEED_HEADERS } from './sources/_lib.mjs';

const TIMEOUT_MS = 25000;
const ATTEMPTS   = 3;      // transient DNS/TLS blips are common; don't cry wolf
const RETRY_MS   = 1500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function check(feed) {
  let last = '';
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await fetchWithTimeout(feed.url, { redirect: 'follow', headers: FEED_HEADERS }, TIMEOUT_MS);
      if (!res.ok) { last = `HTTP ${res.status}`; await sleep(RETRY_MS); continue; }
      const head = (await res.text()).slice(0, 500);
      // 200 + HTML = blocked or moved. Must count as a failure, not a pass.
      if (!/<(\?xml|rss|feed)\b/i.test(head)) { last = 'not XML (blocked or moved?)'; await sleep(RETRY_MS); continue; }
      return { ...feed, ok: true };
    } catch (err) {
      last = err.message.slice(0, 60);
      await sleep(RETRY_MS);
    }
  }
  return { ...feed, ok: false, reason: last };
}

const { feeds } = JSON.parse(await readFile(new URL('./feeds.json', import.meta.url), 'utf8'));
const results = await Promise.all(feeds.map(check));

const bad          = results.filter(r => !r.ok);
const badCiteable  = bad.filter(r => r.citeable === true);
const citeableAll  = results.filter(r => r.citeable === true);

for (const r of results) {
  const tag = r.citeable ? 'CITEABLE' : '        ';
  console.log(`${r.ok ? 'ok ' : 'DEAD'} ${tag} ${r.name.padEnd(30)} ${r.ok ? '' : r.reason}`);
}

console.log(`\n${results.length - bad.length}/${results.length} feeds healthy ` +
            `(citeable: ${citeableAll.length - badCiteable.length}/${citeableAll.length})`);

if (badCiteable.length) {
  console.error(`\nFAIL: ${badCiteable.length} CITEABLE feed(s) down: ${badCiteable.map(r => r.name).join(', ')}`);
  console.error('These are the only sources the chat may cite — fix or replace them in feeds.json.');
  process.exit(1);
}
if (bad.length > results.length / 3) {
  console.error(`\nFAIL: ${bad.length} of ${results.length} feeds are down — that is more than a third.`);
  process.exit(1);
}
if (bad.length) console.log('\nSome background feeds are down. Not fatal, but replace them when convenient.');
