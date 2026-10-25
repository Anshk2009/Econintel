// Self-check: .rag/schema.sql installs the SAME match_documents as the live DB.
// Run: node .scripts/test-schema-sync.mjs
//
// WHY THIS EXISTS — audit RAG-02. schema.sql calls itself "SAFE TO RE-RUN" and
// "the ONLY copy of match_documents", and tells you to ship retrieval changes by
// re-running it. But the live function came from migration 0007, and schema.sql
// still held the version BEFORE 0007: no ::halfvec(2048) cast (so the HNSW index
// is never used), a window function over the whole table, no MATERIALIZED
// barriers. Following the file's own instructions would have reinstated the
// 7.4-second sequential scan that silently killed retrieval in August.
//
// The two bodies are compared after stripping SQL comments and whitespace, so
// comments may differ but the SQL may not.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function body(sql, file) {
  const m = sql.match(/function\s+(?:public\.)?match_documents\s*\([\s\S]*?\bas\s+(\$[a-z]*\$)([\s\S]*?)\1/i);
  assert.ok(m, `match_documents body not found in ${file}`);
  return m[2].replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}

const schema = body(read('.rag/schema.sql'), 'schema.sql');
const live = body(read('.migrations/0007_hnsw_halfvec_retrieval_index.sql'), '0007');
assert.ok(live.includes('::halfvec(2048)'), 'sanity: 0007 should use the halfvec cast');
assert.equal(schema, live, 'schema.sql match_documents differs from the deployed one (migration 0007) — re-running schema.sql would revert retrieval');

console.log('schema sync: OK');
