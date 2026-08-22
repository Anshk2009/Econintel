-- Rollback for 0009.
--
-- Read this first: dropping embedded_at returns staleness detection to
-- embedding_model alone — the marker that was already destroyed once, by
-- migration 0007, without anything failing. reembed.mjs would go back to
-- selecting on a label that currently reads "current" for every row in the
-- table, so it would report "Nothing to repair" forever, including after a
-- genuine model change. There is no data loss (the column is metadata), but the
-- failure it re-enables is silent and took a month to notice last time.
--
-- If the goal is just to stop re-embedding, set EMBED_SPACE_CHANGED_AT in
-- .rag/sources/_lib.mjs to a past date instead. That is reversible; this is the
-- detector itself.
drop index if exists public.documents_embedded_at_idx;
alter table public.documents drop column if exists embedded_at;
