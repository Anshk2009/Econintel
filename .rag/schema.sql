-- EconIntel RAG — Supabase setup. Paste into the Supabase SQL editor and run.
-- It creates the vector "library" the chat searches + the search function it calls.
--
-- SAFE TO RE-RUN, and this file is the ONLY copy of match_documents. Every
-- statement is `if not exists` / `drop … if exists`, so re-running an existing
-- database just reinstalls the current search function and touches no data.
-- That is how you ship a retrieval change: edit the function below, re-run this
-- whole file. Do NOT paste the older migration-*.sql files afterwards — they are
-- history, and migration-hybrid-retrieval.sql would silently revert the ranking
-- fixes below.

-- 1. Turn on pgvector (one time).
create extension if not exists vector;

-- 2. The library: one row = one chunk / news item.
--    embedding is vector(2048) to match nvidia/nemotron-3-embed-1b:free.
create table if not exists documents (
  id           bigint generated always as identity primary key,
  content      text,            -- the text the chat reads
  source_name  text,            -- e.g. "BBC Business"
  source_url   text,            -- the real link, so the chat can cite it
  category     text,            -- "news" | "report" | "case-study" | ...
  published_at timestamptz,     -- when the source was published (news freshness)
  -- LICENSE/USAGE LINE: true  = original/curated/primary, safe to REPUBLISH on a
  -- public blog or category page. false = scraped commercial full-text/snippets,
  -- RETRIEVAL-ONLY (the chat may read it and link to it, but it must NOT be
  -- republished). The chat searches ALL rows; only blog/page generation filters
  -- on publishable = true.
  publishable  boolean not null default false,
  embedding    vector(2048)     -- the "meaning fingerprint" (2048 numbers)
);
-- Fast "give me only the publishable rows" lookups for page generation.
create index if not exists documents_publishable_idx on documents (publishable);

-- 3. Stop the same article being stored twice (dedupe by its URL).
create unique index if not exists documents_source_url_key on documents (source_url);

-- NOTE on indexing: pgvector's fast HNSW/IVFFlat indexes only support up to 2000
-- dimensions, and this model outputs 2048 — so we do NOT create a vector index
-- here. Search is exact (a sequential scan), which is plenty fast while the
-- library is small. To scale later, switch the column to halfvec(2048) and add:
--   create index on documents using hnsw (embedding halfvec_cosine_ops);

-- 3b. Full-text index so the keyword half of the search below is fast. The
--     'english' config stems words ("banks" matches "banking").
create index if not exists documents_fts_idx
  on documents using gin (to_tsvector('english', coalesce(content, '')));

-- 4. The search function the chat calls (via /rest/v1/rpc/match_documents).
--    HYBRID: vector similarity + keyword search, merged with Reciprocal Rank
--    Fusion. Pure similarity can't separate our crisis case studies (they all
--    share "IMF / inflation / currency / crisis"); the terms that DO separate
--    them are exact entities — "Volcker", "1997", "peg" — which keyword search
--    nails and embeddings blur. So we run both and fuse.
--
--    IMPORTANT: functions/chat.js calls this with THREE arguments
--    (query_embedding, match_count, query_text). Keep the signature in sync —
--    a 2-arg version here makes every RPC call 404, and retrieveContext fails
--    open, so the chat keeps answering with NO sources and nothing looks broken.
-- (drop first: the RETURNS TABLE column list has changed over time, and
--  `create or replace` cannot change a function's return type.)
drop function if exists match_documents(vector, int, text);

create function match_documents (
  query_embedding vector(2048),
  match_count     int  default 10,
  query_text      text default null
)
returns table (
  id           bigint,
  content      text,
  source_name  text,
  source_url   text,
  publishable  boolean,   -- lets the chat split CITEABLE (true) from BACKGROUND (false)
  published_at timestamptz, -- so the answer can say "as of <date>" instead of stating a stale headline in the present tense
  similarity   float
)
language sql stable
as $$
  with
  -- Vector leg: pull 2x match_count so fusion has real choices. (The relevance
  -- floor lives AFTER fusion — see the WHERE clause below — so it covers
  -- keyword-only hits too.)
  vec as (
    select d.id,
           row_number() over (order by d.embedding <=> query_embedding) as rank
    from documents d
    order by d.embedding <=> query_embedding
    limit match_count * 2
  ),
  -- Keyword leg: websearch_to_tsquery is safe on arbitrary user input (it never
  -- throws on odd syntax). Skipped entirely when query_text is null.
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
  -- RRF fusion: each doc scores 1/(60+rank) in each list it appears in (60 is
  -- the standard damping constant).
  fused as (
    select
      coalesce(vec.id, kw.id) as id,
      coalesce(1.0 / (60 + vec.rank), 0) + coalesce(1.0 / (60 + kw.rank), 0) as rrf
    from vec full outer join kw on vec.id = kw.id
  )
  select
    d.id, d.content, d.source_name, d.source_url, d.publishable, d.published_at,
    1 - (d.embedding <=> query_embedding) as similarity
  from fused
  join documents d on d.id = fused.id
  -- ONE relevance floor, applied AFTER fusion so it covers the keyword leg too.
  -- Before, the floor sat inside the vector leg only: a keyword-only hit came
  -- through the `full outer join` with similarity 0 and landed in the prompt on
  -- a single stemmed word ("bank" matching "banking"). Recomputing similarity
  -- here costs nothing — it runs over the <= 2*match_count fused rows, not the
  -- table — and it also makes `similarity` a real number for keyword-only hits.
  where 1 - (d.embedding <=> query_embedding) > 0.30
  order by
    fused.rrf
    -- Freshness bonus for news, decaying over ~2 weeks. Sized against the RRF
    -- scale it is added to: rank1 = 1/61 = 0.016393, one rank step (rank1->rank2)
    -- = 0.000264, and the whole rank1..rank20 spread = 0.003893. So 0.0005 is
    -- worth about TWO rank places — a tiebreak toward recent news, not a
    -- reordering. (It was 0.008: 30x one rank step and 2.1x the entire ranking
    -- signal, i.e. a fresh news row outranked a document ~59 places above it.)
    + case
        when d.category = 'news' and d.published_at is not null
        then 0.0005 * exp(-extract(epoch from (now() - d.published_at)) / (86400.0 * 14))
        else 0
      end
    desc
  limit match_count;
$$;

-- 5. Let the anon role (used server-side via the REST API) run the function.
grant execute on function match_documents to anon;
