-- Rollback for 0007. Reverses the INDEX only.
--
-- Read this before running it: dropping the index restores a 7.4-second vector
-- leg against a 3-second anon statement_timeout, i.e. it puts retrieval back
-- into permanent failure. `retrieveContext` fails OPEN, so chat will keep
-- answering and the only symptom is one notice per reply. There is no state to
-- corrupt — the index is derived data — but "rolled back and looks fine" is
-- exactly how this outage hid for as long as it did.
--
-- The embedding_model backfill in 0007 is deliberately NOT reversed: those rows
-- were verified to be in the current space, and setting them back to NULL would
-- only make reembed.mjs spend a run rewriting correct vectors.
drop index if exists public.documents_embedding_hnsw_idx;

-- The function is NOT reverted here. The pre-0007 body seq-scans on every
-- query and cannot use any index; there is no version of it worth restoring.
-- To change retrieval behaviour, write a forward migration instead.
