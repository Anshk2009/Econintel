// Self-check for embedding batch sizing (.rag/ingest-live.mjs).
// Run: node .scripts/test-batching.mjs
//
// This is the regression test for the bug that took ingestion down on 2026-08-18.
// BATCH_SIZE went 10 -> 25 in the same commit that added arXiv and NBER, whose
// items are 1,500-2,000-character academic abstracts. 25 of those is ~32,000
// characters in ONE request — about 8,000 tokens at 4 chars/token, against this
// model's 8,192-token window, and dense academic text tokenizes nearer 3.5.
// Every such request was rejected, and because a batch is a slice of one flat
// array, a batch straddling NBER and arXiv (adjacent in feeds.json) was worst.
//
// A fixed item count cannot catch this: it never looks at how long the items are.
// So the batcher counts characters, and this test holds it to that.
import assert from 'node:assert/strict';
import { makeBatches, embedTextOf } from '../.rag/ingest-live.mjs';

const item = (chars, title = 'T') => ({ title, description: 'x'.repeat(Math.max(0, chars - title.length - 1)) });
const charsIn = (batch) => batch.reduce((a, it) => a + embedTextOf(it).length, 0);

// Mirrors the constants in ingest-live.mjs. If those change, this test should be
// re-derived from the model's real context window, not quietly relaxed.
const MAX_BATCH_CHARS = 12000;
const MAX_ITEMS = 25;

// 1. THE REGRESSION. 25 arXiv-sized abstracts must NOT become one request.
const arxiv = Array.from({ length: 25 }, () => item(1900));
const batches = makeBatches(arxiv);
assert.ok(batches.length > 1, '25 abstract-sized items must split across requests');
for (const b of batches) {
  assert.ok(charsIn(b) <= MAX_BATCH_CHARS,
    `batch of ${charsIn(b)} chars exceeds the ${MAX_BATCH_CHARS} budget — this is the outage`);
}
assert.equal(batches.flat().length, 25, 'splitting must not drop or duplicate items');

// 2. Short wire headlines still ride together — the batcher must not overcorrect
//    into one-request-per-item, which would burn the daily request allowance.
const wire = Array.from({ length: 25 }, () => item(160));
const wireBatches = makeBatches(wire);
assert.equal(wireBatches.length, 1, '25 short headlines are small enough for one request');
assert.equal(wireBatches[0].length, 25);

// 3. The item-count ceiling still applies when items are tiny.
const tiny = Array.from({ length: 60 }, () => item(40));
for (const b of makeBatches(tiny)) {
  assert.ok(b.length <= MAX_ITEMS, `batch of ${b.length} items exceeds the ${MAX_ITEMS} ceiling`);
}
assert.equal(makeBatches(tiny).flat().length, 60);

// 4. The real-world mix: long abstracts adjacent to short wire copy, which is
//    exactly what a flat array of all feeds looks like.
const mixed = [...Array.from({ length: 12 }, () => item(1900)), ...Array.from({ length: 30 }, () => item(150))];
const mixedBatches = makeBatches(mixed);
for (const b of mixedBatches) {
  assert.ok(charsIn(b) <= MAX_BATCH_CHARS, 'mixed batch must respect the char budget');
  assert.ok(b.length <= MAX_ITEMS, 'mixed batch must respect the item ceiling');
}
assert.equal(mixedBatches.flat().length, 42, 'no item lost across a mixed run');

// 5. One oversized item cannot produce an empty batch or an infinite loop.
const huge = makeBatches([item(50000), item(100)]);
assert.equal(huge.flat().length, 2);
for (const b of huge) assert.ok(b.length > 0, 'no empty batches');

// 6. Per-item truncation caps what any single feed can contribute. Stored
//    content stays full — only the embedded text is capped.
const whole = item(50000);
assert.equal(embedTextOf(whole).length, 2000, 'embedded text must be capped at MAX_ITEM_CHARS');
assert.ok(`${whole.title}\n${whole.description}`.length > 2000, 'the item itself is still long — only the vector input is cut');

// 7. Degenerate inputs.
assert.deepEqual(makeBatches([]), [], 'no items, no requests');

console.log('PASS  batching: 25 abstracts split by char budget, short items still share a request, nothing dropped');
