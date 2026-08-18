// rag/check-feeds.mjs — health check for every RSS feed in feeds.json.
//
// WHY THIS EXISTS: a feed that starts 403-ing or returns an HTML page instead of
// XML does NOT break the ingester — collectFeed() catches the error and returns
// [], so the run stays green while the library quietly stops growing from that
// source. That is the worst kind of failure: invisible. This script makes it
// loud, and CI runs it weekly.
//
// Exit codes:
//   0 = healthy enough (individual dead feeds are still printed, loudly)
//   1 = 3+ primary/institutional feeds down, or more than a third of all feeds
//
// The threshold used to be "ANY citeable feed down = fail". That was calibrated
// when there were 5 of them, hand-picked. There are now 21, so on a weekly run
// the chance that at least one government site is having a bad morning is high —
// the old rule would have gone red most weeks, and a check that is red most
// weeks is a check nobody reads. Same reasoning as the retrieval-failure notice
// in chat.js: a warning only works while it stays rare. Three at once is a real
// signal (a shared CDN, a UA block, our own network); one is weather.
//
// The rationale changed too: citeable no longer means "the only rows the chat
// may cite" — retrieval attributes every chunk now — it means "rows we may
// REPUBLISH". These feeds still get the stricter watch, because they are the
// primary sources the product's central claim rests on.
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

// Always SAY it, even when we do not fail on it — the point is visibility.
if (badCiteable.length) {
  console.error(`\n${badCiteable.length} primary/institutional feed(s) down: ${badCiteable.map(r => r.name).join(', ')}`);
}
if (badCiteable.length >= 3) {
  console.error('FAIL: three or more primary sources down at once — that is a pattern, not weather. Look for a shared host, a UA block or a network fault before editing feeds.json.');
  process.exit(1);
}
if (bad.length > results.length / 3) {
  console.error(`\nFAIL: ${bad.length} of ${results.length} feeds are down — that is more than a third.`);
  process.exit(1);
}
if (bad.length) console.log('\nSome background feeds are down. Not fatal, but replace them when convenient.');
