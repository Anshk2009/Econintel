-- ============================================================================
-- EconIntel RAG — make match_documents return `publishable` (citeable gating)
-- Run in Supabase SQL editor. PREREQUISITE: run migration-add-publishable.sql
-- FIRST (this needs the documents.publishable column to exist).
-- ============================================================================
-- WHY: the chat now splits retrieved chunks into CITEABLE (publishable = true,
-- primary/open-data sources it may cite when asked) and BACKGROUND (everything
-- else, never cited). To do that it needs each chunk's publishable flag back
-- from the search function.
--
-- A function's return columns can't be changed with CREATE OR REPLACE, so we
-- drop and recreate. Also bumps the default match_count 3 -> 5 so a citeable
-- source has a chance to surface alongside the news that dominates the library.
-- ============================================================================

drop function if exists match_documents(vector, int);

create function match_documents (
  query_embedding vector(2048),
  match_count     int default 5
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
  select
    documents.id,
    documents.content,
    documents.source_name,
    documents.source_url,
    documents.publishable,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  order by documents.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function match_documents to anon;
