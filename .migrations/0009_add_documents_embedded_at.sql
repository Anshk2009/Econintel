-- 0009 — record WHEN a vector was produced, not only what produced it.
-- Rollback: .migrations/0010_rollback_documents_embedded_at.sql
--
-- WHY: embedding_model alone is a fragile staleness marker, and on 2026-08-21 it
-- was destroyed. Migration 0007 backfilled 497 rows whose embedding_model was
-- NULL to the current model on the strength of a sample that did not represent
-- them (it sampled `order by id desc limit 1` — the newest row, written by the
-- new code path). Those rows turned out to be fine, but the MARKER did not
-- survive: reembed.mjs selects on `embedding_model is null or <> current`, and
-- after the backfill nothing in the table could ever match that again. The
-- repair job went blind and nothing failed loudly, which is the whole problem.
--
-- A timestamp cannot be laundered the same way. "Embedded before the space
-- moved" stays true regardless of what the label says, so a future model or
-- input_type change stays detectable even if someone stamps the label wrongly.

alter table public.documents
  add column if not exists embedded_at timestamptz;

-- BACKFILL SEMANTICS — read before trusting the value.
-- We do NOT know when existing rows were embedded; it was never recorded. What
-- we DO know is that on 2026-08-22 the corpus was measured to be in the live
-- coordinate space: a 25-row sample spanning ids 1..27,954 scored a
-- best-neighbour MINIMUM of 0.2747 (avg 0.5834) against the other 12,284 rows,
-- with zero rows below the 0.20 retrieval floor and zero showing the
-- random-vector signature (<0.16 = 1/sqrt(2048)).
--
-- So this is a VERIFICATION FLOOR, not a true embedding time: it asserts "known
-- good in the current space as of this date", which is exactly what staleness
-- detection needs and is the strongest honest claim available. Every row
-- written from now on carries a real embedding time.
update public.documents
   set embedded_at = timestamptz '2026-08-22 00:00:00+00'
 where embedded_at is null
   and embedding is not null;

comment on column public.documents.embedded_at is
  'When this row''s vector was produced. Rows dated 2026-08-22 are a VERIFICATION '
  'FLOOR, not a true embedding time: the original timestamps were never recorded, '
  'and that date is when the corpus was measured to be in the live coordinate '
  'space (best-neighbour min 0.2747 over a 25-row sample). Staleness = embedded_at '
  'older than the last EMBED_MODEL / input_type change (see EMBED_SPACE_CHANGED_AT '
  'in .rag/sources/_lib.mjs), which holds even if embedding_model is stamped wrong.';

-- Partial index: the only query reading this column looks for OLD rows, and a
-- row with no embedding is not a re-embed candidate. Keeps the index small.
create index if not exists documents_embedded_at_idx
  on public.documents (embedded_at)
  where embedding is not null;
