// Self-check for the staleness marker (.rag/sources/_lib.mjs + .rag/reembed.mjs).
// Run: node .scripts/test-staleness-marker.mjs
//
// WHY THIS EXISTS
// The previous marker was embedding_model alone, and on 2026-08-21 a migration
// backfilled every NULL label to the current model. From that moment reembed.mjs
// could not identify a stale row no matter what happened to the vectors — the
// repair job went blind and nothing failed, which is the whole problem.
// embedded_at only helps if every write actually stamps it and the detector
// actually reads it. Both are asserted here so neither can quietly stop being
// true.
//
// No network: globalThis.fetch is stubbed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let sent = null;
globalThis.fetch = async (url, opts) => {
  if (opts?.method === 'POST' && String(url).includes('/documents')) {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 201, async json() { return []; }, async text() { return '[]'; } };
  }
  // embeddings
  return {
    ok: true, status: 200,
    async json() { return { data: [{ index: 0, embedding: [0.1, 0.2] }] }; },
    async text() { return ''; },
  };
};

process.env.NVIDIA_API_KEY = 'nvapi-test';
process.env.SUPABASE_URL = 'http://db';
process.env.SUPABASE_ANON_KEY = 'k';
const lib = await import('../.rag/sources/_lib.mjs');

// ── 1. The space-change date exists and is a real, parseable instant ────────
assert.ok(lib.EMBED_SPACE_CHANGED_AT, 'EMBED_SPACE_CHANGED_AT must be exported');
assert.ok(!Number.isNaN(Date.parse(lib.EMBED_SPACE_CHANGED_AT)),
  `EMBED_SPACE_CHANGED_AT must parse as a date, got ${lib.EMBED_SPACE_CHANGED_AT}`);

// ── 2. Writes stamp embedded_at ─────────────────────────────────────────────
const before = Date.now();
await lib.upsertDoc({
  content: 'a primary-source document',
  source_name: 'Test', source_url: 'https://example.invalid/1', category: 'data',
});
assert.ok(sent, 'upsertDoc must POST a row');
const row = Array.isArray(sent) ? sent[0] : sent;
assert.ok(row.embedded_at, 'every written row must carry embedded_at');
const stamped = Date.parse(row.embedded_at);
assert.ok(!Number.isNaN(stamped), 'embedded_at must be an ISO instant');
assert.ok(stamped >= before - 1000, 'embedded_at must be the time of THIS write, not a constant');
assert.equal(row.embedding_model, lib.EMBED_MODEL, 'label is still stamped alongside');

// ── 3. The detector actually reads the timestamp ────────────────────────────
// reembed.mjs needs live env to import, so assert on its source. Crude, but it
// pins the one property that matters: a label-only detector is what failed.
const reembed = readFileSync(new URL('../.rag/reembed.mjs', import.meta.url), 'utf8');
assert.ok(/EMBED_SPACE_CHANGED_AT/.test(reembed),
  'reembed.mjs must compare against EMBED_SPACE_CHANGED_AT, not just the label');
assert.ok(/embedded_at=lt\./.test(reembed),
  'reembed.mjs must select rows embedded BEFORE the space changed');
assert.ok(/embedded_at=is\.null/.test(reembed),
  'reembed.mjs must also catch rows that were never stamped');
assert.ok(/embedded_at:\s*new Date\(\)\.toISOString\(\)/.test(reembed),
  'reembed.mjs writeBack must re-stamp embedded_at, or repaired rows stay stale forever');

// ── 4. A repaired row must stop being stale ────────────────────────────────
// The failure this guards: stamping the label on repair but not the timestamp,
// so every run re-selects the same rows and the job never terminates.
assert.ok(!/JSON\.stringify\(\{\s*embedding,\s*embedding_model:\s*EMBED_MODEL\s*\}\)/.test(reembed),
  'writeBack must not update the label without the timestamp — that is an infinite repair loop');

console.log('PASS  staleness marker: space-change date set, writes stamped, detector reads the timestamp');
