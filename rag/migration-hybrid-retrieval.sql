-- ============================================================================
-- EconIntel RAG — HYBRID RETRIEVAL upgrade (vector + keyword, fused with RRF)
-- Run in Supabase SQL editor. PREREQUISITE: schema.sql + migration-add-publishable.sql
-- already ran (documents table with the publishable column).
-- NOTE: this migration is for an EXISTING database. A fresh install gets the
-- hybrid function straight from schema.sql and does not need to run this.
--
-- DEPLOY ORDER: run THIS SQL FIRST, then deploy the updated functions/chat.js.
-- (If chat.js deploys first, its RPC call has a query_text param the old function
-- doesn't know → PostgREST 404 → retrieveContext fails open → chat still works,
-- just without RAG context until this migration runs. Safe either way, but the
-- SQL-first order avoids that RAG-less window.)
--
-- WHY HYBRID: our eval showed crisis case studies share so much vocabulary
-- (IMF, currency, inflation, crisis...) that pure similarity search can't tell
-- them apart — while the terms that DO discriminate are exact entities:
-- "Volcker", "1997", "peg", "Nixon". Embeddings blur those; keyword search
-- nails them. So we run BOTH searches and merge with Reciprocal Rank Fusion
-- (RRF): each document scores 1/(60+rank) in each list it appears in, and the
-- summed score ranks the final result. 60 is the standard RRF damping constant.
-- ============================================================================

-- 1. Full-text index so the keyword leg is fast. english config stems words
--    ("banks" matches "banking") which suits our all-English library.
create index if not exists documents_fts_idx
  on documents using gin (to_tsvector('english', coalesce(content, '')));

-- 2. Replace match_documents. Return columns unchanged (chat.js contract intact);
--    new OPTIONAL query_text param switches on the keyword leg + RRF fusion.
--    Old-style calls (embedding only) still work and behave like before.
drop function if exists match_documents(vector, int);
drop function if exists match_documents(vector, int, text);

create function match_documents (
  query_embedding vector(2048),
  match_count     int  default 10,
  query_text      text default null
)
returns table (
  id          bigint,
  content     text,
  source_name text,
  source_url  text,
  publishable boolean,
  similarity  float
)
language sql stable
as $$
  with
  -- Vector leg: top candidates by cosine similarity. Pull 2x match_count so
  -- fusion has real choices, and floor at 0.30 similarity so a totally
  -- off-topic question stops matching junk instead of always returning
  -- SOMETHING. (0.30 is a deliberately loose floor for this embedding model —
  -- tighten it after checking real score distributions in production logs.)
  vec as (
    select d.id, 1 - (d.embedding <=> query_embedding) as sim,
           row_number() over (order by d.embedding <=> query_embedding) as rank
    from documents d
    where 1 - (d.embedding <=> query_embedding) > 0.30
    order by d.embedding <=> query_embedding
    limit match_count * 2
  ),
  -- Keyword leg: full-text match on the raw question. websearch_to_tsquery is
  -- safe on arbitrary user input (never throws on weird syntax). Skipped
  -- entirely when query_text is null (old-style call).
  kw as (
    select d.id,
           row_number() over (
             order by ts_rank(to_tsvector('english', coalesce(d.content,'')),
                              websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from documents d
    where query_text is not null
      and to_tsvector('english', coalesce(d.content,''))
          @@ websearch_to_tsquery('english', query_text)
    limit match_count * 2
  ),
  -- RRF fusion + a small freshness bonus for news rows (max ~0.008, about half
  -- a top-rank RRF step, decaying over ~2 weeks) — econ questions usually mean
  -- "now", and case studies are timeless so they get no bonus.
  fused as (
    select
      coalesce(vec.id, kw.id) as id,
      coalesce(1.0 / (60 + vec.rank), 0) + coalesce(1.0 / (60 + kw.rank), 0) as rrf,
      coalesce(vec.sim, 0) as sim
    from vec full outer join kw on vec.id = kw.id
  )
  select
    d.id, d.content, d.source_name, d.source_url, d.publishable,
    fused.sim as similarity
  from fused
  join documents d on d.id = fused.id
  order by
    fused.rrf
    + case
        when d.category = 'news' and d.published_at is not null
        then 0.008 * exp(-extract(epoch from (now() - d.published_at)) / (86400.0 * 14))
        else 0
      end
    desc
  limit match_count;
$$;

grant execute on function match_documents to anon;
