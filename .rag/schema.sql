-- EconIntel RAG — Supabase setup. Paste into the Supabase SQL editor and run.
-- It creates the vector "library" the chat searches + the search function it calls.
--
-- SAFE TO RE-RUN. Every statement is `if not exists` / `drop … if exists`, so
-- re-running an existing database just reinstalls the current search function
-- and touches no data. That is how you ship a retrieval change: edit the
-- function below, re-run this whole file. Do NOT paste the older migration-*.sql
-- files afterwards — they are history, and migration-hybrid-retrieval.sql would
-- silently revert the ranking fixes below.
--
-- The function body below is the one migration 0007 deployed (halfvec index
-- scan, MATERIALIZED CTEs). .scripts/test-schema-sync.mjs fails CI if the two
-- ever differ — until 2026-10-26 this file still held the pre-0007 version, and
-- re-running it as instructed would have brought back the 7.4 s sequential scan
-- (audit RAG-02).

-- 1. Turn on pgvector (one time).
create extension if not exists vector;

-- 2. The library: one row = one chunk / news item.
--    embedding is vector(2048) to match nvidia/nemotron-3-embed-1b.
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
  embedding    vector(2048),    -- the "meaning fingerprint" (2048 numbers)
  -- WHICH model produced `embedding`. Without this column the 2026-07-19 model
  -- swap stranded 4,364 rows (29% of the library) in a dead coordinate space,
  -- invisibly, for a month: vectors from two different models are mutually
  -- random, so those rows scored ~0.00 against every query and simply stopped
  -- being retrievable. Nothing could detect it, because nothing recorded which
  -- model a row belonged to. Now the ingesters write it and re-embed anything
  -- that does not match the model they are running, so a model change repairs
  -- itself on the next cron instead of silently killing a third of the corpus.
  embedding_model text,

  -- WHEN the vector was produced. Added 2026-08-22 (migration 0009) because
  -- embedding_model on its own turned out to be a marker you can destroy by
  -- accident: migration 0007 backfilled every NULL label to the current model,
  -- and from that moment reembed.mjs — which selects on the label — could not
  -- identify a stale row again, silently. A date survives that. "Embedded before
  -- the space moved" is true no matter what the label says.
  -- Compared against EMBED_SPACE_CHANGED_AT in .rag/sources/_lib.mjs.
  -- NOTE: rows stamped 2026-08-22 are a VERIFICATION FLOOR, not a true embedding
  -- time — see the column comment in migration 0009.
  embedded_at timestamptz
);
-- Existing databases: add the columns without touching data.
alter table documents add column if not exists embedding_model text;
alter table documents add column if not exists embedded_at timestamptz;

-- ROW-LEVEL SECURITY: ON since 2026-08-22, with NO policy — which means the
-- publishable (anon) key can do nothing to this table at all.
--
-- Everything legitimate goes around it: writers (GitHub Actions, and the edge
-- functions since the EdgeOne redeploy) authenticate with the sb_secret key,
-- which bypasses RLS; readers go through match_documents(), which is SECURITY
-- DEFINER. Verified after applying: retrieval still returned 6 rows.
--
-- DO NOT "fix" this by disabling RLS. That line used to live here, and in a file
-- advertised as safe to re-run it was a landmine — one paste would have silently
-- reopened all seven tables. If ingestion starts failing 42501, the cause is a
-- writer that lost its secret key, not this setting. See .rag/harden-rls.sql.
alter table documents enable row level security;

-- Historical note, kept because the REASON matters more than the setting:
-- RLS was off for months, and not by choice. EdgeOne refuses to store the legacy
-- service_role key (a JWT starting `eyJ...` trips a content filter), so every
-- caller authenticated as anon, so a deny-all policy would have broken the site.
-- Supabase's newer `sb_secret_...` format is not a JWT, saves in EdgeOne without
-- complaint, and removed the constraint the whole design had been bent around.
--
-- The quieter half of the old failure is worth remembering: match_documents
-- runs as the CALLER unless it is SECURITY DEFINER, so RLS-with-no-policy does
-- not error on reads — it returns ZERO ROWS. retrieveContext reads that as
-- "library had nothing", shows no warning, and the chat answers ungrounded
-- looking perfectly normal. Writes fail loudly; reads fail silently.
-- Finding rows left behind by a model change is the repair job's hot path.
create index if not exists documents_embedding_model_idx on documents (embedding_model);
-- Same hot path, timestamp side. Partial: a row with no embedding is never a
-- re-embed candidate, so keep the index to rows that could actually be repaired.
create index if not exists documents_embedded_at_idx on documents (embedded_at)
  where embedding is not null;
-- Fast "give me only the publishable rows" lookups for page generation.
create index if not exists documents_publishable_idx on documents (publishable);
-- THE VECTOR INDEX (migration 0007). Without this, match_documents seq-scans
-- every row and takes ~7.4s against anon's 3s statement_timeout — retrieval
-- returns 57014 and fails open, i.e. the library looks empty and chat answers
-- ungrounded. It is on the CAST, not the column: pgvector caps hnsw/ivfflat at
-- 2000 dimensions and this column is vector(2048). halfvec indexes to 4000.
-- The cast must stay character-identical to the one in match_documents below.
create index if not exists documents_embedding_hnsw_idx
  on documents using hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

-- 3. Stop the same article being stored twice (dedupe by its URL).
create unique index if not exists documents_source_url_key on documents (source_url);

-- SUPERSEDED 2026-08-22 — the index now exists, above. This note is kept
-- because the decision it recorded is what caused a real outage, and the shape
-- of the mistake is worth more than the note was.
--
-- It read: "HNSW/IVFFlat only support up to 2000 dimensions and this model
-- outputs 2048 — so we do NOT create a vector index here. Search is exact (a
-- sequential scan), which is plenty fast while the library is small."
--
-- Every clause was true when written, at 381 rows. Nothing re-examined it as the
-- corpus grew 32x. At 12,285 rows the seq scan reached 7,376 ms against anon's
-- 3s statement_timeout, so match_documents began returning 57014 on EVERY query.
-- retrieveContext fails open, so chat kept answering, ungrounded, with one
-- notice — and the cause was misread as an embedding-provider fault, which
-- triggered a whole provider migration that fixed nothing.
--
-- The note even named the fix ("switch to halfvec(2048)") and filed it under
-- "to scale later". There was no trigger attached to "later", and no alert on
-- retrieval failing, so "later" arrived as an outage instead of a task.
--
-- LESSON: a performance decision justified by "while the library is small" is
-- only complete if something measures when it stops being small.

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
-- SECURITY DEFINER so retrieval cannot be silently switched off by a change to
-- this table's RLS. As SECURITY INVOKER (the default) the function runs as the
-- caller, so enabling RLS without a SELECT policy makes it return zero rows
-- rather than an error — and retrieveContext fails open, so every answer goes
-- out ungrounded with nothing to show that it did. Reading this table is a
-- deliberately public capability; pin it here instead of leaving it to whatever
-- the table's RLS happens to be that week.
-- search_path is fixed because a SECURITY DEFINER function that resolves names
-- through the caller's search_path can be tricked into reading the wrong table.
security definer
set search_path = public, pg_temp
as $$
  with
  -- Vector leg. Limit FIRST (index scan), rank the survivors second.
  vec as materialized (
    select t.id, row_number() over (order by t.dist) as rank
    from (
      select d.id,
             d.embedding::halfvec(2048) <=> query_embedding::halfvec(2048) as dist
      from documents d
      order by 2
      limit match_count * 2
    ) t
  ),
  -- Keyword leg: same limit-then-rank shape, for the same reason. GIN narrows
  -- this first, but a common stem ("bank", "rate") still matches thousands.
  -- websearch_to_tsquery is safe on arbitrary user input — it never throws on
  -- odd syntax. Skipped entirely when query_text is null.
  kw as materialized (
    select t.id, row_number() over (order by t.score desc) as rank
    from (
      select d.id,
             ts_rank(to_tsvector('english', coalesce(d.content,'')),
                     websearch_to_tsquery('english', query_text)) as score
      from documents d
      where query_text is not null
        and to_tsvector('english', coalesce(d.content,''))
            @@ websearch_to_tsquery('english', query_text)
      order by 2 desc
      limit match_count * 2
    ) t
  ),
  -- RRF fusion: each doc scores 1/(60+rank) in each list it appears in
  -- (60 is the standard damping constant).
  fused as materialized (
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
  -- Full-precision distance deliberately (see the precision note in the header):
  -- this runs over <= 2*match_count fused rows, never the table, so exactness
  -- here is free.
  --
  -- 0.20, MEASURED, not guessed. This model's cosine distribution is compressed.
  -- Sampling one row against the live corpus (2026-08-19, 10,704 rows) gave a
  -- true match at 0.5725 — a Hindi PIB release and the English Economic Times
  -- story on the same policy — good matches at 0.30-0.35, merely-related at
  -- 0.26. At a 0.30 floor only FOUR rows in 10,704 cleared it, one of which was
  -- the query row itself. A live question is also SHORT text scored against LONG
  -- articles, which pushes cosine lower still. 0.20 keeps ~0.7% of the corpus,
  -- still a hard filter, and RANKING decides what is used, not the floor.
  -- Re-measure with .rag/audit-followup.sql section B if the model ever changes.
  where 1 - (d.embedding <=> query_embedding) > 0.20
  order by
    fused.rrf
    -- Freshness bonus for news, decaying over ~2 weeks. Sized against the RRF
    -- scale it is added to: rank1 = 1/61 = 0.016393, one rank step = 0.000264,
    -- and the whole rank1..rank20 spread = 0.003893. So 0.0005 is worth about
    -- TWO rank places — a tiebreak toward recent news, not a reordering.
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
