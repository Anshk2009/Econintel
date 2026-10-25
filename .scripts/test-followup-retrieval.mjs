// Self-check: a follow-up question is searched WITH its context (chat.js).
// Run: node .scripts/test-followup-retrieval.mjs
//
// WHY THIS EXISTS — audit RAG-03. Retrieval embedded only the latest message.
// "And what did the IMF demand?" on its own has no subject — no country, no
// year — so the 1991 India case study the reader was asking about could not
// rank. Now:
//   - the EMBEDDING sees the previous question + the latest one (meaning)
//   - the KEYWORD leg still sees only the latest message: websearch_to_tsquery
//     ANDs every word, so adding the earlier question's words would make the
//     full-text leg match almost nothing.
//   - the hidden article-context turn ("[ARTICLE CONTEXT …") is never used as
//     "the previous question" — it is a whole article, not a question.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');

async function ask(messages) {
  const nv = nvidiaStub();
  const rpcArgs = [];
  globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: (a) => { rpcArgs.push(a); return []; } } }).fetch;
  const res = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body: { messages } }) });
  await res.text();
  return { embedded: nv.embedded, rpc: rpcArgs[0] };
}

{
  const { embedded, rpc } = await ask([
    { role: 'user', content: 'Why did India nearly default in 1991?' },
    { role: 'assistant', content: 'Reserves fell to about two weeks of imports.' },
    { role: 'user', content: 'And what did the IMF demand?' },
  ]);
  assert.equal(embedded.length, 1);
  assert.match(embedded[0], /1991/, 'the follow-up was embedded without the question it follows');
  assert.match(embedded[0], /IMF demand/, 'the latest question must be in the embedded text');
  assert.equal(rpc.query_text, 'And what did the IMF demand?', 'the keyword leg must see only the latest message');
}

// The first message of a thread is embedded as-is.
{
  const { embedded } = await ask([{ role: 'user', content: 'What is a repo rate?' }]);
  assert.equal(embedded[0], 'What is a repo rate?');
}

// The article-context turn is not "the previous question".
{
  const { embedded } = await ask([
    { role: 'user', content: '[ARTICLE CONTEXT — the reader just finished this piece]\n\nTitle: UPI\n\n' + 'body '.repeat(500) },
    { role: 'user', content: 'Who pays for UPI?' },
  ]);
  assert.ok(!embedded[0].includes('ARTICLE CONTEXT'), 'the hidden article turn was embedded as if it were a question');
}

console.log('follow-up retrieval: OK');
