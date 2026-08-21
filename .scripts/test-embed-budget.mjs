// Self-check for the embedding request budget (.rag/sources/_lib.mjs).
// Run: node .scripts/test-embed-budget.mjs
//
// This guards the failure that actually happened. Expanding to 43 feeds pushed
// embedding demand past OpenRouter's ~50-requests/DAY free allowance, and
// because ingestion and live chat share one key, exhausting it took down
// ingest-live, ingest-data, seed-documents, check-retrieval AND grounded chat
// answers together. The budget is the thing standing between a busy corpus and
// that outage, so it gets a test rather than a careful read.
//
// No network: globalThis.fetch is stubbed before the module loads, so this
// asserts the accounting itself and never spends real allowance.
import assert from 'node:assert/strict';

let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return {
    ok: true,
    status: 200,
    async json() { return { data: [{ index: 0, embedding: [0.1, 0.2] }] }; },
    async text() { return ''; },
  };
};

// Budget is read at module load, so it must be set before the dynamic import.
process.env.INGEST_EMBED_BUDGET = '2';
const lib = await import('../.rag/sources/_lib.mjs');

// 1. The budget is what the env said, and it starts unspent.
assert.equal(lib.EMBED_BUDGET, 2, 'env must win over the default');
assert.equal(lib.embedBudgetLeft(), 2);

// 2. Requests inside the budget go through, and each costs exactly one.
await lib.embedBatch(['one']);
assert.equal(lib.embedBudgetLeft(), 1, 'a batch must cost exactly one request');
await lib.embedBatch(['two', 'three', 'four']);
assert.equal(lib.embedBudgetLeft(), 0, 'batch size must not affect request cost');
assert.equal(calls, 2, 'two upstream calls for two batches, regardless of item count');

// 3. Past the budget: throws, tagged, and — the point — spends NOTHING upstream.
await assert.rejects(
  () => lib.embedBatch(['five']),
  (err) => {
    assert.equal(err.budget, true, 'must be tagged .budget so callers can tell it from a real fault');
    assert.ok(!err.quota, 'self-imposed stop is not an upstream quota rejection');
    return true;
  },
);
assert.equal(calls, 2, 'an over-budget call must not reach the network');

// 4. A deliberate one-off job (reembed.mjs) can raise it, and it takes effect.
lib.setEmbedBudget(5);
assert.equal(lib.embedBudgetLeft(), 5);
await lib.embedBatch(['six']);
assert.equal(lib.embedBudgetLeft(), 4);
assert.equal(calls, 3);

// 5. Upstream quota rejections are tagged .quota, NOT .budget — ingest-live stops
//    the run on these, and the two must stay distinguishable.
globalThis.fetch = async () => ({
  ok: false, status: 429,
  async text() { return '{"error":{"message":"rate limit exceeded"}}'; },
  async json() { return {}; },
});
await assert.rejects(
  () => lib.embedBatch(['seven']),
  (err) => {
    assert.equal(err.quota, true, '429 must be tagged .quota');
    assert.ok(!err.budget, 'upstream rejection is not our own budget stopping us');
    return true;
  },
);

console.log('PASS  embed budget: per-request accounting, hard stop before the network, quota vs budget distinguished');
