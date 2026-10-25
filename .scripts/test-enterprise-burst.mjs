// Self-check: no plan can fire an unbounded burst at the shared key (chat.js).
// Run: node .scripts/test-enterprise-burst.mjs
//
// WHY THIS EXISTS — audit SEC-13. Every user shares ONE NVIDIA key limited to
// 40 requests per minute. Enterprise had queriesPerMinute: Infinity, so a single
// enterprise session (or a stolen enterprise cookie) could use the whole minute
// for everyone. The per-minute guard is an anti-script measure — no human types
// 30 questions a minute — so a finite cap costs a real customer nothing.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub, signIn, awaitFreshMinute } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');
// The cap is per clock-minute; don't let the burst straddle two windows.
await awaitFreshMinute();

const nv = nvidiaStub();
const fb = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } });
globalThis.fetch = fb.fetch;
const cookies = await signIn(fb, { plan: 'enterprise' });

const send = () => onRequest({ env: TEST_ENV, request: req('/chat', {
  method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] }, cookies }) });

let last;
for (let i = 0; i < 31; i++) {
  last = await send();
  if (last.status !== 200) break;
  await last.text();
}
assert.equal(last.status, 429, `enterprise burst was never throttled (last status ${last.status})`);
assert.equal((await last.json()).code, 'RATE_LIMIT_PER_MINUTE');

console.log('enterprise burst cap: OK');
