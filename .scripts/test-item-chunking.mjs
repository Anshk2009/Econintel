// Self-check for chunking long feed items (.rag/ingest-live.mjs chunkItems).
// Run: node .scripts/test-item-chunking.mjs
//
// WHY THIS EXISTS — audit RAG-04. A few feeds (NY Fed Liberty Street, NBER,
// arXiv) syndicate whole articles. Each item was stored as ONE row: the vector
// came from its first 2,000 characters only, but the full text was stored and
// later pasted into the prompt. So the end of a long article could never be
// found, and when the start matched, the whole article ate the answer's context.
//
// Contract:
//   - items that fit are untouched (one row, plain URL)
//   - longer items become chunks of <= MAX_ITEM_CHARS, each starting with the
//     headline so it still says what it is about, with a small overlap
//   - chunk 1 keeps the PLAIN url; chunks 2..n get #2, #3… The plain url is what
//     findStored() checks next run — if no row carried it, every chunked article
//     would be re-embedded on every 3-hourly run, forever.
import assert from 'node:assert/strict';
import { chunkItems, embedTextOf } from '../.rag/ingest-live.mjs';

const short = { title: 'Fed holds', url: 'https://x.test/a', description: 'Rates unchanged.' };
assert.deepEqual(chunkItems([short]), [short], 'a short item must pass through untouched');

const words = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(' ');   // ~6,600 chars
const long = { title: 'Liberty Street: the long one', url: 'https://x.test/long', description: words };
const chunks = chunkItems([long]);
assert.ok(chunks.length >= 3, `expected the long item to split, got ${chunks.length} chunk(s)`);
assert.equal(chunks[0].url, 'https://x.test/long', 'chunk 1 must keep the plain url (dedupe key)');
chunks.slice(1).forEach((c, i) => assert.equal(c.url, `https://x.test/long#${i + 2}`));
for (const c of chunks) {
  assert.equal(c.title, long.title, 'every chunk keeps the headline');
  assert.ok(embedTextOf(c).length <= 2000, `a chunk is ${embedTextOf(c).length} chars — over the embed cap, so its end would be invisible`);
}
// Nothing is lost: every word lands in some chunk.
const covered = new Set(chunks.flatMap(c => c.description.split(' ')));
assert.ok(words.split(' ').every(w => covered.has(w)), 'some text fell between chunks');

console.log('item chunking: OK');
