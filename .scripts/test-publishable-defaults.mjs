// Self-check: nothing is marked republishable unless someone decided it is.
// Run: node .scripts/test-publishable-defaults.mjs
//
// WHY THIS EXISTS — audit RAG-07. documents.publishable is the line between
// "the chat may read and cite this" and "we may REPUBLISH this on our own pages".
// It defaulted to TRUE in upsertDoc(), and every RSS feed flagged `citeable` —
// which includes the ECB, Bank of Japan, RBI, SEBI, BIS and WTO, each with its
// own reuse terms — was written as publishable too. That is a licence decision
// made by a default. Now:
//   - upsertDoc() defaults to false; each open-data caller states its choice
//   - RSS rows are publishable only if the feed sets "publishable": true
//     explicitly in feeds.json (none do yet — that needs a licence review)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── upsertDoc default, behaviourally ───────────────────────────────────────
process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
process.env.NVIDIA_API_KEY = 'nvapi-test';
const posted = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/v1/embeddings')) return Response.json({ data: [{ index: 0, embedding: [0.1] }] });
  if (u.includes('/rest/v1/documents?source_url=eq.')) return Response.json([]);          // unchanged() lookup
  if (u.includes('/rest/v1/documents?on_conflict')) { posted.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
  throw new Error(`unexpected ${u}`);
};
const { upsertDoc } = await import('../.rag/sources/_lib.mjs');
await upsertDoc({ content: 'x', source_name: 'Some new source', source_url: 'https://new.test/1', category: 'data' });
assert.equal(posted[0].publishable, false, 'a caller that says nothing must get publishable=false');

// ── every open-data caller decides explicitly ──────────────────────────────
for (const f of ['edgar', 'fred', 'ogd-india', 'worldbank']) {
  const src = readFileSync(new URL(`../.rag/sources/${f}.mjs`, import.meta.url), 'utf8');
  assert.match(src, /upsertDoc\(\{[^}]*publishable:\s*(true|false)/, `${f}.mjs must pass publishable explicitly`);
}

// ── RSS: only an explicit per-feed flag makes a row republishable ──────────
const live = readFileSync(new URL('../.rag/ingest-live.mjs', import.meta.url), 'utf8');
assert.match(live, /publishable:\s+it\.feed\.publishable === true/, 'RSS publishable must come from an explicit feed flag, not `citeable`');

console.log('publishable defaults: OK');
