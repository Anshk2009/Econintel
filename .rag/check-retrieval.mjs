// check-retrieval.mjs — does the library still answer the questions it exists for?
// Run: node check-retrieval.mjs      (needs OPENROUTER_EMBED_KEY, SUPABASE_URL, SUPABASE_ANON_KEY)
//
// WHY THIS EXISTS
// Four retrieval defects shipped and lived for weeks in 2026, and every one was
// found by reading code — nothing in the system could tell that answers had
// stopped being grounded. Ranking bugs do not throw. A dead embedding space does
// not 500. The ingesters stayed green the whole time. This script is the missing
// signal: it asks real questions and fails the build when the right document
// stops coming back.
//
// It would have caught, without modification:
//   - the freshness bonus 30x too large (news displacing the case studies)
//   - the similarity floor that only covered the vector leg
//   - the embedding-model swap that stranded every case study in a dead space
//
// Deliberately NOT precision@k over a labelled corpus. At this size the useful
// question is binary and cheap: for a question a reader would actually type, is
// the document that answers it in the top k? Cost is one embedding request per
// query, on the same capped free key the chat uses — which is why this runs
// weekly and on RAG changes, not on every ingest.
import { readFile } from 'node:fs/promises';
import { embedBatch, fetchWithTimeout, requireEnv } from './sources/_lib.mjs';

requireEnv(['OPENROUTER_EMBED_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
const { SUPABASE_URL, SUPABASE_ANON_KEY: KEY } = process.env;

const { k = 6, min_pass_rate = 0.7, queries } = JSON.parse(await readFile('./golden.json', 'utf8'));

// One embeddings call for every query — same batching trick the ingesters use,
// so the whole check costs a single request against the daily cap.
const vectors = await embedBatch(queries.map(q => q.q));

let passed = 0;
const failures = [];

for (let i = 0; i < queries.length; i++) {
  const { q, expect } = queries[i];
  let rows;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/match_documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}`, 'apikey': KEY },
      body: JSON.stringify({ query_embedding: vectors[i], match_count: k, query_text: q }),
    });
    if (!r.ok) throw new Error(`RPC ${r.status} ${(await r.text()).slice(0, 120)}`);
    rows = await r.json();
  } catch (e) {
    failures.push(`  MISS  "${q}"\n        retrieval error: ${e.message}`);
    continue;
  }

  const names = (rows || []).map(x => x.source_name || '');
  const hitAt = names.findIndex(n => n.toLowerCase().includes(expect.toLowerCase()));
  if (hitAt >= 0) {
    passed++;
    console.log(`  hit@${hitAt + 1}  "${q}"  ->  ${names[hitAt]}`);
  } else {
    failures.push(`  MISS  "${q}"\n        wanted a source containing "${expect}"\n`
                + `        got: ${names.length ? names.map(n => n || '(unnamed)').join(' | ') : '(nothing above the similarity floor)'}`);
  }
}

const rate = passed / queries.length;
console.log(`\n${passed}/${queries.length} golden queries hit inside top ${k} (${(rate * 100).toFixed(0)}%), bar is ${(min_pass_rate * 100).toFixed(0)}%`);
if (failures.length) console.log('\nFailures:\n' + failures.join('\n'));

if (rate < min_pass_rate) {
  console.error(`\nRetrieval quality below bar. Something upstream broke: check that the embedding model in sources/_lib.mjs matches what the stored rows were embedded with, that seed-documents has run since the last model change, and that ranking in schema.sql has not been re-pasted from an old migration.`);
  process.exit(1);
}
console.log('\nRetrieval OK.');
