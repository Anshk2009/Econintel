-- Rollback for 0013.
--
-- Safe at any time: middleware.js TOKENS.incr() treats a missing kv_incr as
-- "not deployed" and falls back to read-then-write. Rolling back therefore
-- re-opens the parallel-burst race described in 0013 — nothing else breaks.
drop function if exists public.kv_incr(text, int);
