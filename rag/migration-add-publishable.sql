-- ============================================================================
-- EconIntel RAG — add the publishable flag + separate the existing corpus
-- Run ONCE in the Supabase SQL editor. Safe / additive / reversible.
-- ============================================================================
-- WHY: the `documents` table currently MIXES two very different things:
--   • original/curated docs (the historical case studies) — safe to republish
--   • scraped commercial news headlines+snippets (BBC, NYT, ET, …) — copyright,
--     RETRIEVAL-ONLY, must NOT be republished on a blog/category page
-- This adds an explicit line between them so blog/page generation can pull only
-- the safe rows. The chat keeps searching everything (linking ≠ republishing).
-- ============================================================================

-- 1. Add the flag (defaults to false = retrieval-only, the safe default).
alter table documents add column if not exists publishable boolean not null default false;

-- 2. Backfill existing rows. The file ingester tags originals as
--    case-study / reference / report; the live ingester tags scraped news as
--    news / india / institution / analysis. So:
--      publishable = TRUE  for case-study / reference / report (your originals)
--      publishable = FALSE for everything else (scraped commercial snippets)
--    NOTE: 'institution' (IMF/Fed) stays FALSE on purpose — conservative until
--    you decide per-source. US Federal Reserve text is US-gov public domain, so
--    you may later promote it:  update documents set publishable = true
--                               where source_name = 'US Federal Reserve';
update documents set publishable = (category in ('case-study','reference','report'));

-- 3. Index for "publishable only" queries.
create index if not exists documents_publishable_idx on documents (publishable);

-- 4. Check the split:
-- select publishable, category, count(*) from documents group by 1,2 order by 1 desc,3 desc;

-- ROLLBACK (if ever needed):
--   drop index if exists documents_publishable_idx;
--   alter table documents drop column if exists publishable;
