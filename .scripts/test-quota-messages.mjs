// Self-check: the guest-limit message states the real limit (chat.js + chat.html).
// Run: node .scripts/test-quota-messages.mjs
//
// WHY THIS EXISTS — audit QA-06. Three numbers for one limit:
//   server:  "You've used all 5 free messages … Sign up for 100 free queries/month"
//   client:  "You've used all 15 free messages. … for 100 queries/month"
//   actual:  guests 5 per 2 hours; a free ACCOUNT gets a daily cap, nothing monthly
// The client hard-coded its own text, so even a corrected server message never
// reached the reader. Now the server's message is the only one, and it quotes
// GUEST_LIMIT instead of a number typed into a sentence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');
const nv = nvidiaStub();
globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } }).fetch;
let last;
for (let i = 0; i < 6; i++) {
  last = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] }, ip: '203.0.113.150' }) });
  if (last.status === 200) await last.text();
}
const { error, code } = await last.json();
assert.equal(code, 'GUEST_QUOTA_EXCEEDED');
assert.match(error, /\b5\b/, 'the message must state the real guest limit (5)');
assert.ok(!/month/i.test(error), `there is no monthly quota, but the message promises one: "${error}"`);

const html = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');
assert.ok(!/15 free messages/.test(html), 'chat.html still hard-codes "15 free messages"');
const branch = html.match(/errData\.code === 'GUEST_QUOTA_EXCEEDED'[\s\S]{0,600}/);
assert.ok(branch && /errData\.error/.test(branch[0]), 'chat.html must show the server\'s message for GUEST_QUOTA_EXCEEDED');

console.log('quota messages: OK');
