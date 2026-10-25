-- 0013 — an atomic counter for the rate limits (audit SEC-02).
-- Rollback: .migrations/0014_rollback_kv_incr_atomic_counter.sql
--
-- STATUS: WRITTEN, NOT APPLIED. The edge functions work with or without it:
-- middleware.js TOKENS.incr() calls this function and, if it answers 404
-- (not deployed yet), falls back to the old read-then-write. So the order is
-- safe either way round — but the race below stays open until this is applied.
--
-- ─── THE RACE THIS CLOSES ───────────────────────────────────────────────────
-- Every quota used to be:   n = GET key;  if n >= limit -> refuse;  PUT key = n+1
-- Forty requests fired in parallel all read the same n, all pass, and all write
-- n+1 — so a 5-message guest bucket let ~40 through per burst and only moved
-- forward by ONE. That is how one client could drain the single NVIDIA key every
-- user shares. A single INSERT … ON CONFLICT DO UPDATE … RETURNING is one
-- statement under a row lock: parallel callers each see a distinct count.
--
-- ─── SEMANTICS ──────────────────────────────────────────────────────────────
--   kv_incr(p_key, p_ttl_seconds) -> the counter's value AFTER this increment.
--   - a missing OR EXPIRED row restarts at 1 with a fresh TTL (so a window
--     really resets, instead of an expired row counting on forever)
--   - a live row keeps its original expires_at (fixed window, not sliding)
--   - value stays TEXT so TOKENS.get() keeps reading it exactly as before
--
-- SECURITY DEFINER + fixed search_path, like match_documents: the edge
-- functions call it with the secret key, and nobody else should call it at all,
-- hence the revoke from PUBLIC/anon/authenticated at the bottom.

create or replace function public.kv_incr(p_key text, p_ttl_seconds int)
returns int
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into kv_store as k (key, value, expires_at)
  values (p_key, '1', now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update
    set value = case when k.expires_at <= now() then '1'
                     else ((k.value)::int + 1)::text end,
        expires_at = case when k.expires_at <= now()
                          then now() + make_interval(secs => p_ttl_seconds)
                          else k.expires_at end
  returning value::int;
$$;

revoke execute on function public.kv_incr(text, int) from public, anon, authenticated;
grant  execute on function public.kv_incr(text, int) to service_role;

-- VERIFY after applying (should print 1, 2, then 1 after the row is expired):
--   select kv_incr('test:incr', 60);
--   select kv_incr('test:incr', 60);
--   update kv_store set expires_at = now() - interval '1 second' where key = 'test:incr';
--   select kv_incr('test:incr', 60);
--   delete from kv_store where key = 'test:incr';
