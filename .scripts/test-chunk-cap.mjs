// Self-check: one retrieved row can never flood the prompt (chat.js).
// Run: node .scripts/test-chunk-cap.mjs
//
// WHY THIS EXISTS — audit RAG-04, part 2. New feed items are chunked at ingest,
// but rows already in the library can be whole articles (tens of thousands of
// characters). retrieveContext pasted every row's content in full, so a single
// long match could push six sources' worth of text into the context, cost
// tokens on every request, and crowd out the reader's own conversation.
// Each source now contributes at most MAX_SOURCE_CHARS.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');
const HUGE = 'Liberty Street paragraph. '.repeat(1000);   // ~26,000 chars
const rows = [
  { id: 1, source_name: 'NY Fed Liberty Street Economics', source_url: 'https://libertystreeteconomics.newyorkfed.org/x', content: HUGE, published_at: '2026-10-01T00:00:00Z', similarity: 0.4 },
  { id: 2, source_name: 'RBI Press Releases', source_url: 'https://rbi.org.in/y', content: 'Short and complete.', published_at: '2026-10-02T00:00:00Z', similarity: 0.3 },
];
const nv = nvidiaStub();
globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => rows } }).fetch;
const res = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'q' }] } }) });
await res.text();

const userTurn = nv.seen[0].messages.filter(m => m.role === 'user').pop().content;
assert.ok(userTurn.length < 4000, `the prompt carried ${userTurn.length} chars of sources for two rows`);
assert.ok(userTurn.includes('Short and complete.'), 'a short source must come through whole');
assert.ok(userTurn.includes('Liberty Street paragraph.'), 'the long source must still contribute its opening');
assert.ok(userTurn.includes('…'), 'a cut source must say it was cut');

console.log('chunk cap: OK');
