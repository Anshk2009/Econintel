-- EconIntel RAG — Supabase setup. Run this ONCE in the Supabase SQL editor.
-- It creates the vector "library" the chat searches + the search function it calls.

-- 1. Turn on pgvector (one time).
create extension if not exists vector;

-- 2. The library: one row = one chunk / news item.
--    embedding is vector(2048) to match nvidia/llama-nemotron-embed-vl-1b-v2:free.
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

-- 4. The search function the chat calls (via /rest/v1/rpc/match_documents).
--    Takes a question's embedding, returns the closest `match_count` rows.
create or replace function match_documents (
  query_embedding vector(2048),
  match_count     int default 3
)
returns table (
  id          bigint,
  content     text,
  source_name text,
  source_url  text,
  similarity  float
)
language sql stable
as $$
  select
    documents.id,
    documents.content,
    documents.source_name,
    documents.source_url,
    1 - (documents.embedding <=> query_embedding) as similarity   -- cosine similarity
  from documents
  order by documents.embedding <=> query_embedding                -- closest first
  limit match_count;
$$;

-- 5. Let the anon role (used server-side via the REST API) run the function.
grant execute on function match_documents to anon;
