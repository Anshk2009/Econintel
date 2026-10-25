// Self-check: the only clickable links in an answer are to retrieved sources.
// Run: node .scripts/test-citation-allowlist.mjs
//
// WHY THIS EXISTS — audit SEC-03 / RAG-06. The renderer turned ANY https link
// the model wrote into a clickable <a>. So a poisoned chunk that talked the
// model into writing [RBI calculator](https://phish.example) put a phishing link
// in a trusted UI, and a model that simply hallucinated a URL handed the reader
// a fabricated citation — the product's own definition of its worst error.
//
// The server knows exactly which URLs it retrieved, so:
//   1. it sends them as the FIRST SSE event, { econintel_allowed_urls: [...] },
//      for chat.html to render only those as links (client half: next commit);
//   2. it strips every other link to plain text before saving to chat_history,
//      so a reopened thread is clean too.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub, signIn, readSSE } from './_fake-backend.mjs';

const { onRequest, stripUnlistedLinks } = await import('../functions/chat.js');
const REAL = 'https://www.rbi.org.in/press/123';

// ── unit ────────────────────────────────────────────────────────────────────
const allowed = new Set([REAL]);
assert.equal(stripUnlistedLinks(`see [RBI](${REAL}).`, allowed), `see [RBI](${REAL}).`, 'a retrieved link must survive');
assert.equal(stripUnlistedLinks('see [calc](https://phish.example/x).', allowed), 'see calc.', 'an unlisted link must become plain text');
assert.equal(stripUnlistedLinks('[a](https://x.test) and [b](https://y.test)', new Set()), 'a and b', 'no sources = no links at all');
assert.equal(stripUnlistedLinks('no links here', allowed), 'no links here');

// ── integration ─────────────────────────────────────────────────────────────
const chunk = { id: 1, source_name: 'RBI Press Releases', source_url: REAL,
                content: 'Repo rate held at 5.5%.', published_at: '2026-10-01T00:00:00Z', similarity: 0.5 };
const reply = `- Repo held at 5.5% as of 1 Oct.\n\nSources: [RBI Press Releases](${REAL}), [RBI calculator](https://phish.example/rbi)`;

for (const signedIn of [false, true]) {
  const nv = nvidiaStub({ reply });
  const fb = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [chunk] } });
  globalThis.fetch = fb.fetch;
  const cookies = signedIn ? await signIn(fb, { plan: 'free' }) : {};
  const res = await onRequest({ env: TEST_ENV, request: req('/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'repo rate?' }], conversation_id: 'c1' }, cookies }) });
  assert.equal(res.status, 200);
  const { content, events, raw } = await readSSE(res);
  const label = signedIn ? 'signed-in' : 'guest';

  // 1. allowlist event arrives first, and lists only what was retrieved
  const first = JSON.parse(raw.split('\n\n')[0].slice(6));
  assert.deepEqual(first, { econintel_allowed_urls: [REAL] }, `${label}: first SSE event must be the allowlist`);
  assert.equal(events.length, 1, `${label}: exactly one non-delta event expected`);
  // the live stream itself is untouched — the client decides what to link
  assert.ok(content.includes('https://phish.example/rbi'), `${label}: stream should pass the model's text through`);

  // 2. what is saved has no unlisted links
  if (signedIn) {
    const saved = fb.tables.chat_history.find(r => r.role === 'assistant')?.content;
    assert.ok(saved, 'assistant reply was not saved');
    assert.ok(saved.includes(`[RBI Press Releases](${REAL})`), 'the retrieved citation must be kept in history');
    assert.ok(!saved.includes('phish.example'), 'an unlisted link was saved to chat_history');
    assert.ok(saved.includes('RBI calculator'), 'link TEXT should be kept, only the URL dropped');
  }
}

console.log('citation allowlist: OK');
