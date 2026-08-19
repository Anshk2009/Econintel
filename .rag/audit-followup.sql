-- ============================================================================
-- EconIntel RAG — follow-up audit, 2026-08-19.
-- Run each section separately. NOTHING here deletes.
--
-- Established by the previous run:
--   * The dead/live boundary sits between id 13310 and 13373.
--   * Rows below it: 4,364 (29% of 15,068). Their similarity spread is
--     sd ~0.0218, and 1/sqrt(2048) = 0.0221 — the exact value for random
--     orthogonal vectors. They are noise, not weak matches.
--   * `news` oldest published_at = 2026-07-19, the model-swap date, which is why
--     the first (category='news'-only) audit found nothing to delete.
-- ============================================================================


-- ─── A. WHAT EXACTLY IS STRANDED? ───────────────────────────────────────────
-- Decides the fix per category: churn gets deleted, primary sources get
-- re-embedded. Run this BEFORE any delete.
select
  category,
  count(*)                                     as stranded_rows,
  min(published_at)::date                      as oldest,
  max(published_at)::date                      as newest,
  count(*) filter (where publishable is true)  as publishable
from documents
where id <= 13310
group by category
order by stranded_rows desc;


-- ─── B. IS THE 0.30 SIMILARITY FLOOR SANE FOR THIS MODEL? ───────────────────
-- THE IMPORTANT ONE. schema.sql drops any fused row scoring below 0.30. But
-- same-space rows average only ~0.041 similarity, so if a genuinely relevant
-- document tops out at 0.25, that floor silently rejects EVERYTHING and the chat
-- answers every question with no sources — and fails open, so nothing complains.
--
-- No API call needed: use a live-space row as the query and look at what its own
-- nearest neighbours actually score.
--
-- HOW TO READ IT: sim on row 1 is a document scored against itself and must be
-- ~1.000 (if it is not, something is wrong with the column, not the floor).
-- Rows 2-10 are the real signal — that is the range a strong match reaches.
--   * If rows 2-10 sit at 0.40-0.80 -> 0.30 is a sensible floor. Leave it.
--   * If they sit at 0.10-0.25      -> 0.30 rejects real matches. Must come down.
with q as (
  select embedding, source_name
  from documents
  where id > 13310 and category = 'institution' and embedding is not null
  order by id desc
  limit 1
)
select
  (select source_name from q)                              as query_row,
  d.source_name,
  left(d.content, 70)                                      as content_head,
  round((1 - (d.embedding <=> q.embedding))::numeric, 4)    as sim
from documents d cross join q
where d.id > 13310 and d.embedding is not null
order by d.embedding <=> q.embedding
limit 10;


-- ─── C. THE FLOOR'S REAL COST, IN ONE NUMBER ────────────────────────────────
-- For the same query row: how many live rows clear each candidate floor? If the
-- 0.30 column is 0 or 1, the current floor is lethal and B will show why.
with q as (
  select embedding from documents
  where id > 13310 and category = 'institution' and embedding is not null
  order by id desc limit 1
)
select
  count(*) filter (where 1 - (d.embedding <=> q.embedding) > 0.30) as above_0_30,
  count(*) filter (where 1 - (d.embedding <=> q.embedding) > 0.20) as above_0_20,
  count(*) filter (where 1 - (d.embedding <=> q.embedding) > 0.15) as above_0_15,
  count(*) filter (where 1 - (d.embedding <=> q.embedding) > 0.10) as above_0_10,
  count(*)                                                        as live_rows
from documents d cross join q
where d.id > 13310 and d.embedding is not null;


-- ─── D. DID THE CASE STUDIES SURVIVE? ───────────────────────────────────────
-- ingest-files upserts on source_url with merge-duplicates, which UPDATES the
-- existing row — so a re-embedded case study keeps its ORIGINAL low id while
-- holding a brand-new vector. That means a low id does NOT imply stranded for
-- these 7, and it is why section 3 of the delete script excludes their category.
-- Compare each against a known-live row: ~0.00 means seed-documents has not
-- successfully re-embedded it yet.
with q as (
  select embedding from documents
  where id > 13310 and embedding is not null order by id desc limit 1
)
select
  d.id,
  d.source_name,
  round((1 - (d.embedding <=> q.embedding))::numeric, 4) as sim_to_live_row
from documents d cross join q
where d.category = 'case-study'
order by d.id;
