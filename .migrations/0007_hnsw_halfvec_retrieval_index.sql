-- 0007 — make retrieval actually return, by giving it an index it can use.
-- Rollback: .migrations/0008_rollback_hnsw_halfvec_retrieval_index.sql
--
-- ─── THE FAILURE THIS FIXES ─────────────────────────────────────────────────
-- Live chat was answering every question with "my source library was
-- unreachable", i.e. retrieveContext() in functions/chat.js returning
-- failed:true. It was blamed on the embedding provider. It was not the
-- provider: NVIDIA embeddings were verified working, at 2048 dims, on an
-- entitled key. The RPC itself was timing out.
--
--   POST /rest/v1/rpc/match_documents  (anon)
--   -> HTTP 500  {"code":"57014","message":"canceling statement due to
--                 statement timeout"}   after 4.3s
--
-- Measured cause, 2026-08-21 on 12,285 rows: the vector leg alone took
-- 7,376 ms. The `anon` role — which is what the edge function uses — carries
-- statement_timeout=3s. So retrieval could never complete, and because
-- retrieveContext fails OPEN, chat kept answering and nothing looked broken
-- except one honest notice most readers would skim past.
--
-- TWO independent causes, and fixing only one leaves it broken:
--
-- 1. THERE WAS NO VECTOR INDEX AT ALL. documents carried btree indexes on id /
--    source_url / publishable / embedding_model and a GIN index for the keyword
--    leg — nothing on `embedding`. Every question sequentially scanned 12,285
--    rows x 2048 dimensions.
--
--    It could not have had one. pgvector caps hnsw and ivfflat at 2000
--    dimensions, and this column is vector(2048) — 48 over the line. The raw
--    column is UNINDEXABLE. `halfvec` (pgvector 0.7+, we run 0.8.0) indexes to
--    4000 dims, so the index below is on the CAST, not the column.
--
-- 2. THE WINDOW FUNCTION DEFEATED THE LIMIT. The old vector leg computed
--    `row_number() over (order by embedding <=> query_embedding)` in the same
--    SELECT as `order by ... limit match_count * 2`. A window function must see
--    every row before an outer LIMIT applies, so Postgres sorted the WHOLE
--    table on every query. No index can help a plan shaped like that. The legs
--    below limit first in a subquery, then rank the survivors.
--
-- ─── PRECISION: APPROXIMATE RETRIEVE, EXACT RERANK ──────────────────────────
-- halfvec is half precision, and that is fine HERE because it is used only to
-- choose candidates. The relevance floor and the `similarity` value handed back
-- to the model still use the full-precision `vector` distance, over the <= 2N
-- fused rows. So the 0.20 threshold keeps exactly the meaning it was measured
-- with (see the note on the WHERE clause) and callers see true cosine numbers.
-- Half precision decides WHICH rows are considered; full precision decides what
-- is actually returned.

-- ─── 1. THE INDEX ───────────────────────────────────────────────────────────
-- m=16 / ef_construction=64 are pgvector's defaults and are correct at this
-- scale; at 12k rows the build is seconds. Revisit only past ~1M rows.
-- The cast here must stay character-identical to the one in the vector leg
-- below — a mismatch does not error, it just silently stops using the index
-- and puts the 7-second seq scan straight back.
create index if not exists documents_embedding_hnsw_idx
  on public.documents
  using hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ─── 2. THE FUNCTION ────────────────────────────────────────────────────────
create or replace function public.match_documents(
  query_embedding vector,
  match_count int default 10,
  query_text text default null
)
returns table (
  id bigint, content text, source_name text, source_url text,
  publishable boolean, published_at timestamptz, similarity double precision
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
$function$;

-- ─── 3. LABEL THE UNLABELLED ────────────────────────────────────────────────
-- 497 rows predate the embedding_model column and read NULL. They are in the
-- CURRENT space — verified 2026-08-21: re-embedding a stored row through the
-- live NVIDIA path returned cosine 1.0000 against its stored vector, and zero
-- rows carry the old ':free' label. Left NULL they look stale to reembed.mjs,
-- which selects `embedding_model is null` first and would burn a whole run's
-- budget rewriting vectors that are already correct.
update public.documents
   set embedding_model = 'nvidia/nemotron-3-embed-1b'
 where embedding_model is null
   and embedding is not null;

-- ─── 4. WHY THE CTEs ARE MATERIALIZED ───────────────────────────────────────
-- Indexing the vector leg alone took it 7,376ms -> 121ms and the FUNCTION still
-- took 5,573ms. Postgres may inline a plain CTE, and it did: rather than join
-- the ~12 fused candidates back by primary key, it seq-scanned all 12,285 rows
-- computing a full-precision 2048-dim cosine for the `> 0.20` filter, then hash
-- joined. Same 12,285 distance computations the index was added to avoid, just
-- one stage later — which is why fixing only the vector leg changed nothing at
-- the HTTP layer. AS MATERIALIZED is an optimization barrier: fused is built
-- first and the join is driven FROM it, so the exact filter only sees
-- candidates. Measured after: anon PostgREST 500/timeout -> 200 in 0.44s.
