-- ============================================================================
-- EconIntel RAG — clear rows stranded in a dead embedding space.
-- Run in the Supabase SQL editor. ONE-OFF, and only after an embedding-model
-- change. Not part of setup: schema.sql is the file you re-run routinely.
--
-- WHY THIS EXISTS
-- The embedding model changed on 2026-07-19 (commit 8280329:
-- llama-nemotron-embed-vl-1b-v2 -> nemotron-3-embed-1b). Nothing in the pipeline
-- re-embeds a row that already exists:
--   * ingest-live.mjs  inserts with `resolution=ignore-duplicates` and each
--                      article has its own URL, so a stored news row is never
--                      revisited -> STRANDED in the old space.
--   * ingest-files.mjs (case studies) is workflow_dispatch only, and has not
--                      been run since the swap                -> STRANDED.
--   * ingest-data.mjs  upserts with `resolution=merge-duplicates` onto the SAME
--                      series URLs every day -> re-embedded    -> self-healed.
-- Cosine distance between two different models' vectors is noise, so a stranded
-- row is not merely unfindable, it also scores randomly against real queries.
--
-- THE FIX IS ASYMMETRIC, BECAUSE THE TWO KINDS OF ROW ARE WORTH DIFFERENT THINGS
--   News is disposable -> DELETE it (below). It is stale as journalism anyway,
--     and the feeds have long since dropped those items, so nothing re-adds it.
--   Case studies are not -> DO NOT DELETE. Re-embed them instead by running the
--     "Seed documents" workflow (Actions tab), which upserts on source_url with
--     merge-duplicates and overwrites the vector in place.
-- ============================================================================

-- 1. LOOK FIRST. How much of the library is dead, and how much is left after?
select
  count(*) filter (where category = 'news' and published_at <  '2026-07-19') as dead_news,
  count(*) filter (where category = 'news' and published_at >= '2026-07-19') as live_news,
  count(*) filter (where category = 'news' and published_at is null)         as undated_news,
  count(*) filter (where category <> 'news')                                as non_news,
  count(*)                                                                  as total
from documents;

-- 2. Delete the dead news. Cutoff is the publication date, used as a proxy for
--    ingestion date — feeds only ever carry recent items, so an article
--    PUBLISHED before the swap was INGESTED before the swap.
--    Undated news rows (published_at is null) are deliberately left alone: some
--    are recent, and there is no way to tell them apart. They cannot be dated in
--    the prompt either, so if the count above is large, review them by hand.
delete from documents
where category = 'news'
  and published_at < '2026-07-19';

-- 3. Now go run the "Seed documents" workflow to re-embed the case studies.
--    Verify afterwards: this should return 7 files' worth of chunks, all with a
--    recent-looking distance to a real query rather than the ~0.0 of noise.
-- select source_name, count(*) from documents where category <> 'news' group by 1;
