// Self-check for atomic quota counting (middleware.js TOKENS.incr + chat.js).
// Run: node .scripts/test-atomic-quota.mjs
//
// WHY THIS EXISTS — audit SEC-02. Quotas were GET-then-PUT, so a burst of
// parallel requests all read the same count and all got through. With the
// kv_incr() RPC (migration 0013) every caller gets a distinct number.
//
// Two contracts, both checked:
//   1. WITH kv_incr deployed: 20 simultaneous guest messages -> exactly 5 pass.
//   2. WITHOUT it (migration not applied yet): nothing breaks — sequential
//      quotas still work through the old read-then-write fallback.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');

// The fake's kv_incr does what the SQL does: one synchronous step per call,
// which is exactly the property the real row lock provides.
const kv_incr = ({ p_key, p_ttl_seconds }, tables) => {
  const now = new Date().toISOString();
  let row = tables.kv_store.find(r => r.key === p_key);
  if (!row || row.expires_at <= now) {
    tables.kv_store = tables.kv_store.filter(r => r.key !== p_key);
    row = { key: p_key, value: '0', expires_at: new Date(Date.now() + p_ttl_seconds * 1000).toISOString() };
    tables.kv_store.push(row);
  }
  row.value = String(Number(row.value) + 1);
  return Number(row.value);
};

const guest = (ip) => onRequest({ env: TEST_ENV, request: req('/chat', {
  method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] }, ip }) });

// ── 1. Parallel burst against the atomic counter ───────────────────────────
{
  const nv = nvidiaStub();
  const fb = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [], kv_incr }, latencyMs: 5 });
  globalThis.fetch = fb.fetch;
  const results = await Promise.all(Array.from({ length: 20 }, () => guest('198.51.100.77')));
  const ok = results.filter(r => r.status === 200).length;
  await Promise.all(results.map(r => r.text()));
  assert.equal(ok, 5, `a parallel burst got ${ok} guest messages through a 5-message quota`);
}

// ── 2. No kv_incr deployed: the fallback still enforces the quota ──────────
{
  const nv = nvidiaStub();
  globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } }).fetch;
  const statuses = [];
  for (let i = 0; i < 6; i++) { const r = await guest('198.51.100.78'); statuses.push(r.status); await r.text(); }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 401], `fallback quota broken: ${statuses}`);
}

console.log('atomic quota: OK');
