// Self-check for feed-item hygiene in .rag/ingest-live.mjs.
// Run: node .scripts/test-ingest-urls.mjs
//
// WHY THIS EXISTS — audit SEC-20 / RAG-09.
//   normalizeUrl — item links are stored as source_url (the dedupe key AND the
//     citation the reader clicks). They were stored raw, so:
//       - `?utm_source=…` variants of one article were stored as different
//         rows, and the top-6 sources could be three copies of one story;
//       - any scheme a feed emitted was kept. Only https:// is a citation we
//         are willing to put in front of a reader.
//   dedupeByTitle — the same wire story arrives through several feeds with
//     different URLs; one copy per run is enough.
//   readCapped — the 6 MB feed limit was checked AFTER res.text() had already
//     read the whole body into memory, so it could not stop a huge response.
import assert from 'node:assert/strict';
import { normalizeUrl, dedupeByTitle, readCapped } from '../.rag/ingest-live.mjs';

// ── normalizeUrl ────────────────────────────────────────────────────────────
assert.equal(normalizeUrl('https://example.com/a?utm_source=rss&utm_medium=feed&id=7#top'), 'https://example.com/a?id=7',
  'tracking params and the fragment must go, real params must stay');
assert.equal(normalizeUrl('https://example.com/a?fbclid=x&gclid=y'), 'https://example.com/a');
assert.equal(normalizeUrl('  https://EXAMPLE.com/a  '), 'https://example.com/a', 'host case and whitespace');
// Plain http is UPGRADED, not dropped: the Bank of Japan's feed links all of
// its items as http://www.boj.or.jp/… (51 of 51, 2026-10-26) and dropping them
// would lose a central bank. The same pages serve over https (checked: 200);
// upgrading is what a browser's HTTPS-First mode does.
assert.equal(normalizeUrl('http://www.boj.or.jp/en/research/brp/fsr/fsr261023.htm'), 'https://www.boj.or.jp/en/research/brp/fsr/fsr261023.htm',
  'http links must be upgraded to https');
assert.equal(normalizeUrl('javascript:alert(1)'), null);
assert.equal(normalizeUrl('/relative/path'), null);
assert.equal(normalizeUrl('not a url'), null);

// ── dedupeByTitle ───────────────────────────────────────────────────────────
const items = [
  { title: 'RBI holds repo rate at 5.5%', url: 'https://a.test/1' },
  { title: 'RBI Holds Repo Rate at 5.5% ', url: 'https://b.test/2' },
  { title: 'Fed cuts by 25bp', url: 'https://c.test/3' },
];
assert.deepEqual(dedupeByTitle(items).map(i => i.url), ['https://a.test/1', 'https://c.test/3'],
  'the same headline from two feeds must be stored once (first feed wins — feed order is priority order)');

// ── readCapped ──────────────────────────────────────────────────────────────
const big = new Response(new ReadableStream({
  pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },   // never ends: 1 MB per pull
}));
await assert.rejects(() => readCapped(big, 3 * 1024 * 1024), /too large/, 'an endless body must be cut off at the cap');
assert.equal(await readCapped(new Response('<rss>ok</rss>'), 1024), '<rss>ok</rss>');

console.log('ingest urls: OK');
