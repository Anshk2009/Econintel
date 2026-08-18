-- ============================================================================
-- EconIntel RAG — find and clear rows stranded in a dead embedding space.
-- Run in the Supabase SQL editor, ONE SECTION AT A TIME. Read before you delete.
--
-- WHY THIS EXISTS
-- The embedding model changed on 2026-07-19 (commit 8280329:
-- llama-nemotron-embed-vl-1b-v2 -> nemotron-3-embed-1b). Nothing re-embeds a row
-- that already exists: ingest-live.mjs inserts with resolution=ignore-duplicates
-- and each article has its own URL, so a stored news row is never revisited.
-- Cosine distance between two models' vectors is noise, so a stranded row is not
-- merely unfindable — it also scores randomly against real queries.
--
-- CORRECTED 2026-08-18. The first version of this file filtered on
-- `category = 'news'` and reported 0 dead rows on a 15,068-row library. That was
-- wrong twice over:
--   1. Churn is spread across THREE categories — news, india, analysis — because
--      feeds.json tags Indian business press as 'india'. Only one was counted.
--      (sources/_lib.mjs prune() had the right list; this file did not.)
--   2. published_at is a poor proxy for INGESTION date. It happens to work for
--      wire copy, but an RBI circular from 2024 ingested last week has an old
--      published_at and a current embedding — the date test would call it dead
--      and delete something perfectly good.
-- Section 1 below replaces the guess with a measurement.
-- ============================================================================


-- ─── 1. WHERE IS THE BOUNDARY? ──────────────────────────────────────────────
-- `id` is `generated always as identity`, so it increases with INSERTION order:
-- it is the ingestion clock this table never got. Compare every row against a
-- reference vector we know is current (the newest row), bucketed by id.
--
-- HOW TO READ IT: rows sharing the reference's space show a real spread —
-- avg_sim comfortably away from zero, sd typically > 0.05. Stranded rows cluster
-- tightly near 0.00 with almost no spread, because they are being compared
-- across two unrelated coordinate systems. The boundary is where that flips.
-- If NO bucket looks like noise, nothing is stranded and you can stop here.
with ref as (
  select embedding from documents where embedding is not null order by id desc limit 1
)
select
  width_bucket(d.id, (select min(id) from documents), (select max(id) from documents) + 1, 12) as bucket,
  min(d.id) as from_id,
  max(d.id) as to_id,
  count(*)  as rows,
  round(avg(1 - (d.embedding <=> ref.embedding))::numeric, 4) as avg_sim_to_ref,
  round(stddev(1 - (d.embedding <=> ref.embedding))::numeric, 4) as sd
from documents d cross join ref
where d.embedding is not null
group by 1
order by 1;


-- ─── 2. WHAT IS ACTUALLY IN THE LIBRARY? ────────────────────────────────────
-- Run this too — it tells you which categories the boundary above cuts through,
-- and it is the number to watch against Supabase's 500 MB free-tier ceiling
-- (each row costs ~8 KB of vector alone at 2048 float4 dimensions).
select
  category,
  count(*)                          as rows,
  min(published_at)::date           as oldest,
  max(published_at)::date           as newest,
  count(*) filter (where published_at is null) as undated,
  pg_size_pretty(sum(pg_column_size(embedding))::bigint) as vector_bytes
from documents
group by category
order by rows desc;


-- ─── 3. DELETE THE STRANDED CHURN ───────────────────────────────────────────
-- Put the boundary id from section 1 in place of :boundary — the LAST id of the
-- last noise-looking bucket. News is disposable: it is stale as journalism, the
-- feeds dropped those items long ago, and nothing re-adds it.
--
-- Case studies, open data and anything hand-written are NEVER deleted here.
-- They are re-embedded in place instead, by running the "Seed documents"
-- workflow (Actions tab), which upserts on source_url with merge-duplicates.
--
-- Check the count first:
-- select count(*) from documents
--  where id <= :boundary and category in ('news','india','analysis');
--
-- Then, once the number looks right:
-- delete from documents
--  where id <= :boundary and category in ('news','india','analysis');


-- ─── 4. STRANDED INSTITUTIONAL ROWS ─────────────────────────────────────────
-- If section 1 shows stranded rows in 'institution' or 'research', do NOT delete
-- them the same way — central-bank releases and papers stay referenceable for
-- years and there is no feed to re-fetch them from. Re-embedding is the fix, and
-- there is no script for that yet: it needs a one-off pass that reads content,
-- calls the current model, and writes the vector back. Worth building only if
-- section 1 actually shows a stranded institutional block.


-- ─── 5. VERIFY ──────────────────────────────────────────────────────────────
-- Re-run section 1. Every bucket should now show a similar avg_sim/sd profile.
-- Then run .rag/check-retrieval.mjs (or the "Check retrieval quality" workflow):
-- 12 reader-phrased questions, each expecting a specific source in the top 6.
-- That is the end-to-end proof, not the row counts.
