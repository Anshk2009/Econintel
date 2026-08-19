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
-- MEASURED 2026-08-19: boundary at id 13310, 4,364 stranded rows, split as
--   india 3302 · institution 460 · filing 333 · analysis 196 · data 66 · case-study 7
-- Of those, only india + analysis (3,498 rows) are churn: publishable=0 on every
-- one, stale as journalism, dropped by their feeds long ago, nothing re-adds
-- them. Deleting them is free and it is ~28 MB of vector back.
--
-- Everything else in that list is repaired, NOT deleted — see section 4.
--
-- Count first (expect ~3,498):
-- select count(*) from documents
--  where id <= 13310 and category in ('india','analysis');
--
-- Then, once the number matches:
-- delete from documents
--  where id <= 13310 and category in ('india','analysis');


-- ─── 4. REPAIR THE REST — DO NOT DELETE IT ──────────────────────────────────
-- institution 460, filing 333, data 66, case-study 7 = 866 rows, 862 publishable.
-- These are primary sources and hand-written material. There is no feed to
-- re-fetch a two-month-old central-bank release from, and the 7 case studies
-- exist nowhere else — deleting them destroys the corpus the product's central
-- claim rests on. They keep their text; only the vector is wrong.
--
-- Fix, from a terminal with the ingest secrets set:
--     cd .rag && node reembed.mjs
-- Re-embeds stored content onto the current model, in batches, under a request
-- budget so it cannot starve live chat. Resumable — run it again until it says
-- "Nothing to repair". ~35 embedding requests for all 866 rows.
--
-- NOTE the case studies are the urgent seven. Section D of audit-followup.sql
-- showed all 7 still at ~0.00 on 2026-08-19, i.e. the "Seed documents" workflow
-- did NOT repair them (almost certainly the exhausted embedding key). Until
-- reembed.mjs runs green, the historical-analogue feature is offline.


-- ─── 5. VERIFY ──────────────────────────────────────────────────────────────
-- Re-run section 1. Every bucket should now show a similar avg_sim/sd profile.
-- Then run .rag/check-retrieval.mjs (or the "Check retrieval quality" workflow):
-- 12 reader-phrased questions, each expecting a specific source in the top 6.
-- That is the end-to-end proof, not the row counts.
