// Self-check: a reply cut off mid-stream is still saved (functions/chat.js).
// Run: node .scripts/test-history-on-abort.mjs
//
// WHY THIS EXISTS — audit QA-05. chat_history was written ONLY from the
// TransformStream's flush(), which runs when the stream ends normally. When the
// reader closed the tab, lost signal, or hit the client's 20 s stall watchdog,
// pipeTo() rejected, flush() never ran, and the question AND the partial answer
// vanished — while the reader had seen both on screen. (They are still saved
// together, as one batch: an answerless question was the bug that design fixed.)
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub, signIn } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');
const nv = nvidiaStub({ reply: 'The first part of a long answer that never finishes because the reader left.', slowMs: 15 });
const fb = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } });
globalThis.fetch = fb.fetch;
const cookies = await signIn(fb);

const res = await onRequest({
  env: TEST_ENV,
  waitUntil: () => {},
  request: req('/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'Explain the 1997 crisis' }], conversation_id: 'thread-1' }, cookies }),
});
assert.equal(res.status, 200);

// Read a few chunks, then walk away — exactly what a closed tab does.
const reader = res.body.getReader();
for (let i = 0; i < 4; i++) await reader.read();
await reader.cancel();
await new Promise(r => setTimeout(r, 200));

const rows = fb.tables.chat_history;
const q = rows.find(r => r.role === 'user');
const a = rows.find(r => r.role === 'assistant');
assert.ok(q && q.content === 'Explain the 1997 crisis', 'the question was lost when the reader left mid-answer');
assert.ok(a && a.content.length > 0 && a.content.length < 60, `the partial answer was not saved as what had streamed (${a && a.content.length} chars)`);
assert.equal(q.conversation_id, 'thread-1');
assert.ok(a.created_at > q.created_at, 'the answer must still sort after its question');

console.log('history on abort: OK');
