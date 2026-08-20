// reembed.mjs — repair rows whose vectors are in a dead embedding space.
// Run: node reembed.mjs            (needs OPENROUTER_EMBED_KEY, SUPABASE_URL, SUPABASE_ANON_KEY)
//      node reembed.mjs --all      (include churn categories too — normally you DELETE those)
//      REEMBED_BUDGET=10 node reembed.mjs   (smaller bite; safe to run repeatedly)
//
// WHY THIS EXISTS
// Changing the embedding model re-bases the coordinate system. Vectors written
// by the old model are mutually random with vectors written by the new one, so
// old rows score ~0.00 against every query and quietly stop being retrievable.
// That happened on 2026-07-19 and was found a month later: 4,364 of 15,068 rows
// (29%) were unreachable, including all 7 crisis case studies — the "historical
// analogue" the product is sold on.
//
// The audit on 2026-08-19 split those rows into two groups needing OPPOSITE fixes:
//   DELETE  india 3302, analysis 196  — commercial churn. Stale as journalism,
//           the feeds dropped them long ago, nothing re-adds them, and they are
//           not publishable. Removing them is free.
//   REPAIR  institution 460, filing 333, data 66, case-study 7 (= 866 rows, 862
//           of them publishable). These are primary sources and hand-written
//           material. There is no feed to re-fetch a two-month-old central-bank
//           release from, and the case studies exist nowhere else. Deleting them
//           would destroy the corpus the product's core claim rests on.
// This script is the REPAIR half. The DELETE half is one statement, in
// fix-mixed-embedding-space.sql.
//
// It re-embeds `content` that is already stored — no re-fetching, no scraping.
// Idempotent and resumable: it only ever selects rows whose recorded model is
// not the current one, so an interrupted run just picks up where it stopped.
import process from 'node:process';
import { embedBatch, fetchWithTimeout, requireEnv, EMBED_MODEL, setEmbedBudget } from './sources/_lib.mjs';

requireEnv(['OPENROUTER_EMBED_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const AUTH = { 'Authorization': `Bearer ${KEY}`, 'apikey': KEY };

// Same batching logic as the ingesters: the embeddings endpoint takes an array,
// and REQUESTS (not tokens) are what the free tier caps.
const BATCH_SIZE = 25;

// Default 40 requests = 1,000 rows per run. The chat draws on this same capped
// key to embed every user question, so a repair job must not be able to eat the
// day's allowance in one go. Run it again tomorrow; it resumes automatically.
const BUDGET = Number(process.env.REEMBED_BUDGET || 40);
// This is a job you run deliberately and watch, not a cron, so it overrides the
// shared per-run cron budget in _lib.mjs (which defaults to 3 and would stop
// this after 75 rows). Still bounded — it cannot run away with the daily key.
setEmbedBudget(BUDGET);

// Churn is meant to be DELETED, not repaired — re-embedding 3,498 stale
// headlines would burn the budget on rows that should not exist. --all overrides.
const CHURN = ['news', 'india', 'analysis'];
const includeChurn = process.argv.includes('--all');

// Rows needing repair = recorded model is missing, or is not the current one.
// Two queries instead of PostgREST's or(...) syntax, because the model name
// contains '/' and ':' and quoting it inside or() is a footgun for no gain.
async function fetchStale(limit) {
  const cols = 'id,content,category';
  const skip = includeChurn ? '' : `&category=not.in.(${CHURN.join(',')})`;
  const common = `select=${cols}${skip}&content=not.is.null&order=id.asc&limit=${limit}`;
  const get = async (filter) => {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/documents?${filter}&${common}`, { headers: AUTH });
    if (!r.ok) throw new Error(`fetch failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  };
  // Rows predating the embedding_model column read as null — that is the whole
  // backlog on the first run, so it is checked first.
  const nulls = await get('embedding_model=is.null');
  if (nulls.length >= limit) return nulls;
  const others = await get(`embedding_model=neq.${encodeURIComponent(EMBED_MODEL)}`);
  return [...nulls, ...others].slice(0, limit);
}

// Write one row's new vector back. PATCH by primary key: no upsert, no conflict
// rules, and it cannot create a duplicate if the row moved underneath us.
async function writeBack(id, embedding) {
  const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/documents?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ embedding, embedding_model: EMBED_MODEL }),
  });
  if (!r.ok) throw new Error(`PATCH ${id} failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
}

async function main() {
  const rows = await fetchStale(BUDGET * BATCH_SIZE);
  if (rows.length === 0) {
    console.log(`Nothing to repair — every row${includeChurn ? '' : ' outside churn categories'} is already on ${EMBED_MODEL}.`);
    return;
  }

  const byCategory = rows.reduce((a, r) => ((a[r.category] = (a[r.category] || 0) + 1), a), {});
  console.log(`${rows.length} rows to re-embed onto ${EMBED_MODEL}`);
  console.log(Object.entries(byCategory).map(([c, n]) => `  ${c}: ${n}`).join('\n'));

  let fixed = 0, failed = 0, requests = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    if (requests >= BUDGET) {
      console.log(`\nBudget of ${BUDGET} embedding requests reached — stopping here on purpose.`);
      console.log('Run again (tomorrow, or with REEMBED_BUDGET raised) to continue where this left off.');
      break;
    }
    const batch = rows.slice(i, i + BATCH_SIZE);
    requests++;
    try {
      const vectors = await embedBatch(batch.map(r => r.content));
      // Written one row at a time: a half-written batch leaves the rest still
      // flagged stale, so the next run simply retries them.
      for (let j = 0; j < batch.length; j++) {
        await writeBack(batch[j].id, vectors[j]);
        fixed++;
      }
      console.log(`  ${fixed}/${rows.length} repaired`);
    } catch (e) {
      failed += batch.length;
      console.warn(`  batch of ${batch.length} failed: ${e.message}`);
    }
  }

  console.log(`\nDone. Repaired ${fixed}, failed ${failed}, used ${requests}/${BUDGET} embedding requests.`);
  console.log('Verify with .rag/audit-followup.sql section D, then run check-retrieval.mjs.');

  // Every batch failing means the key or the model is wrong, not the data —
  // fail loudly rather than leave a green run that repaired nothing.
  if (fixed === 0 && failed > 0) {
    console.error('Every batch failed and nothing was repaired. Check OPENROUTER_EMBED_KEY and its remaining daily quota.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
