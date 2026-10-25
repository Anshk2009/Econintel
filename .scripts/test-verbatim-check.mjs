// Self-check for the verbatim-reproduction monitor (functions/chat.js).
// Run: node .scripts/test-verbatim-check.mjs
//
// WHY THIS EXISTS — audit RAG-07, part 3. The prompt now forbids reproducing a
// source, but a prompt rule is a request. After every streamed answer the server
// measures the longest run of words copied verbatim from any retrieved source
// and logs a warning when it passes VERBATIM_WORDS (25) — so a reproduction is
// visible in the logs instead of only in a rights-holder's letter. It runs for
// guests too: they are most of the traffic.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub, signIn } from './_fake-backend.mjs';

const { onRequest, longestVerbatimRun } = await import('../functions/chat.js');

// ── unit ────────────────────────────────────────────────────────────────────
assert.equal(longestVerbatimRun('the cat sat', ['a dog ran']), 0);
assert.equal(longestVerbatimRun('so the cat sat on the mat today', ['The cat sat on the mat.']), 6, 'case and punctuation must not hide a copy');
assert.equal(longestVerbatimRun('', ['anything']), 0);

// ── integration ─────────────────────────────────────────────────────────────
const article = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const row = { id: 1, source_name: 'NYT Economy', source_url: 'https://nytimes.example/a', content: article, published_at: '2026-10-01T00:00:00Z', similarity: 0.5 };
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };
try {
  for (const signedIn of [false, true]) {
    warnings.length = 0;
    const copied = `Here it is: ${article.split(' ').slice(5, 45).join(' ')}.`;   // 40 words lifted
    const nv = nvidiaStub({ reply: copied });
    const fb = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [row] } });
    globalThis.fetch = fb.fetch;
    const cookies = signedIn ? await signIn(fb) : {};
    const res = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'print it' }] }, cookies }) });
    await res.text();
    await new Promise(r => setTimeout(r, 20));   // flush() runs after the last chunk
    assert.ok(warnings.some(w => /verbatim/i.test(w) && /40 words/.test(w) && /NYT Economy/.test(w)),
      `${signedIn ? 'signed-in' : 'guest'}: a 40-word copy was not reported (warnings: ${JSON.stringify(warnings)})`);
  }
  // A paraphrase is not reported.
  warnings.length = 0;
  const nv = nvidiaStub({ reply: 'The piece argues rates stay high.' });
  globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [row] } }).fetch;
  const res = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'q' }] }, ip: '192.0.2.9' }) });
  await res.text();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!warnings.some(w => /verbatim/i.test(w)), 'a paraphrase was reported as a copy');
} finally {
  console.warn = realWarn;
}

console.log('verbatim check: OK');
