// Self-check for link extraction in .rag/ingest-live.mjs parseRss.
// Run: node .scripts/test-rss-links.mjs
//
// WHY THIS EXISTS — found during the SEC-20 work, not in the original audit.
// pick() unwrapped <![CDATA[...]]> for every field, but pickLink() did not. Six
// feeds wrap <link> in CDATA — US Federal Reserve, Fed Monetary Policy,
// LiveMint, The Hindu (x2), Hindu BusinessLine — so ~135 items per run were
// stored with source_url = "<![CDATA[https://...]]>". That string is the
// citation the reader is offered: renderMarkdown never linked it (it does not
// start with https://), and the unique index deduped on the wrapper. Measured
// in a dry run, 2026-10-26.
import assert from 'node:assert/strict';
import { parseRss } from '../.rag/ingest-live.mjs';

const rss = (link) => `<rss><channel><item><title>T</title>${link}<description>D</description></item></channel></rss>`;

assert.equal(parseRss(rss('<link><![CDATA[https://www.federalreserve.gov/x.htm]]></link>'))[0].url,
  'https://www.federalreserve.gov/x.htm', 'CDATA-wrapped <link> must be unwrapped');
assert.equal(parseRss(rss('<link>\n  https://www.bea.gov/news/x  \n</link>'))[0].url,
  'https://www.bea.gov/news/x', 'whitespace around a link must be trimmed');
assert.equal(parseRss(rss('<link>https://example.com/plain</link>'))[0].url, 'https://example.com/plain');
// Atom <link href="..."/> still works.
assert.equal(parseRss('<feed><entry><title>T</title><link href="https://example.com/atom"/></entry></feed>')[0].url,
  'https://example.com/atom');

console.log('rss links: OK');
