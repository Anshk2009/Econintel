// Self-check for the embedding provider contract (.rag/sources/_lib.mjs + functions/chat.js).
// Run: node .scripts/test-embed-contract.mjs
//
// WHY THIS EXISTS
// nvidia/nemotron-3-embed-1b embeds in TWO modes. Documents must go in as
// `passage`, live questions must go in as `query`. Mix them up and nothing
// throws: you get vectors, you get scores, and retrieval accuracy just quietly
// falls off a cliff. That is the exact class of bug this corpus has already been
// bitten by once (commit 8280329 stranded 29% of rows in a dead space for a
// month) — invisible in every log, fatal to the product's one real claim.
//
// It also pins the two sides to the SAME model string. `documents.embedding_model`
// records what the ingester used; the chat query is compared against those rows.
// Two different strings = two coordinate systems = every similarity score is noise.
//
// No network: globalThis.fetch is stubbed, so this spends no allowance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let sent = null;
globalThis.fetch = async (url, opts) => {
  sent = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
  return {
    ok: true, status: 200,
    async json() { return { data: [{ index: 0, embedding: [0.1, 0.2] }] }; },
    async text() { return ''; },
  };
};

process.env.NVIDIA_API_KEY = 'nvapi-test';
const lib = await import('../.rag/sources/_lib.mjs');

// ── 1. The INDEXING side ───────────────────────────────────────────────────
await lib.embedBatch(['a document about the current account deficit']);
assert.equal(sent.url, 'https://integrate.api.nvidia.com/v1/embeddings',
  'ingestion must embed on NVIDIA, not OpenRouter');
assert.equal(sent.auth, 'Bearer nvapi-test', 'must use NVIDIA_API_KEY');
assert.equal(sent.body.input_type, 'passage',
  'documents are indexed as passage — query here would silently wreck accuracy');
assert.equal(sent.body.truncate, 'END', 'long docs must clip, not fail the batch');
assert.ok(!lib.EMBED_MODEL.includes(':free'),
  "':free' is OpenRouter naming — NVIDIA 404s on it");

// ── 1b. The eval must score the QUERY path, not the indexing one ───────────
// check-retrieval.mjs is the gate that certifies this pipeline. It embeds golden
// QUESTIONS. If it inherits the 'passage' default it goes green while measuring
// something live chat never does — a broken gate is worse than no gate.
await lib.embedBatch(['what caused the 1991 balance of payments crisis?'], 'query');
assert.equal(sent.body.input_type, 'query', 'embedBatch must honour an explicit inputType');
const evalSrc = readFileSync(new URL('../.rag/check-retrieval.mjs', import.meta.url), 'utf8');
assert.ok(/embedBatch\([\s\S]*?,\s*'query'\)/.test(evalSrc),
  'check-retrieval.mjs must embed golden questions as query, not the passage default');

// ── 2. The QUERY side ──────────────────────────────────────────────────────
// chat.js is an EdgeOne edge function (needs a real `context`), so read the
// source rather than invoking it. Crude, but it pins the two literals that
// matter and costs nothing. ponytail: upgrade to a real call only if chat.js
// ever gains a testable retrieveContext export.
const chat = readFileSync(new URL('../functions/chat.js', import.meta.url), 'utf8');
assert.ok(/input_type:\s*'query'/.test(chat),
  'the live question must embed as query, the counterpart to passage above');
assert.ok(chat.includes("https://integrate.api.nvidia.com/v1/embeddings"),
  'chat retrieval must embed on NVIDIA too');
assert.ok(!/openrouter\.ai\/api\/v1\/embeddings/.test(chat),
  'no OpenRouter embeddings call may survive in chat.js');

// ── 3. BOTH SIDES, ONE SPACE ───────────────────────────────────────────────
const chatModel = chat.match(/const EMBED_MODEL = '([^']+)'/)?.[1];
assert.equal(chatModel, lib.EMBED_MODEL,
  `chat.js embeds with '${chatModel}' but the ingester wrote '${lib.EMBED_MODEL}' — different spaces, every score is noise`);

console.log('PASS  embed contract: NVIDIA both sides, passage vs query, one shared model string');
