// Self-check for the site-wide cap in front of NVIDIA (functions/chat.js).
// Run: node .scripts/test-global-capacity.mjs
//
// WHY THIS EXISTS — audit SEC-02. Every per-user and per-IP limit can be
// perfectly correct and the product still goes down: the NVIDIA key is SHARED,
// 40 requests/minute for everyone, so 41 different people (or one person with
// 41 accounts or networks) take it over the edge and every user gets errors.
// Two caps sit in front of the provider:
//   36/min site-wide   — under NVIDIA's 40 so the key itself never 429s
//   12/min for guests  — anonymous traffic can never take the whole minute
// When either is full the reply is a clear 429 AT_CAPACITY, not a provider error.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub, signIn, awaitFreshMinute } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');
const body = { messages: [{ role: 'user', content: 'hi' }] };
await awaitFreshMinute();

// ── 1. Guests share 12 per minute, across different networks ───────────────
{
  const nv = nvidiaStub();
  globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } }).fetch;
  const statuses = [];
  for (let i = 1; i <= 13; i++) {
    const r = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body, ip: `203.0.113.${i}` }) });
    statuses.push(r.status);
    if (r.status === 200) await r.text(); else assert.equal((await r.json()).code, 'AT_CAPACITY');
  }
  assert.equal(statuses.filter(s => s === 200).length, 12, `guest site-wide cap not 12/min: ${statuses}`);
  assert.equal(nv.seen.length, 12, 'a capped guest request still reached NVIDIA');
}

// ── 2. Everyone together: 36 per minute, then AT_CAPACITY ──────────────────
{
  const nv = nvidiaStub();
  const fb = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } });
  globalThis.fetch = fb.fetch;
  let ok = 0, last;
  for (let i = 0; i < 37; i++) {
    const cookies = await signIn(fb, { id: `u${i}`, plan: 'pro' });
    last = await onRequest({ env: TEST_ENV, request: req('/chat', { method: 'POST', body, cookies, ip: `198.51.100.${i + 1}` }) });
    if (last.status === 200) { ok++; await last.text(); }
  }
  assert.equal(ok, 36, `site-wide cap let ${ok} through in one minute`);
  assert.equal(last.status, 429);
  assert.equal((await last.json()).code, 'AT_CAPACITY');
}

console.log('global capacity: OK');
