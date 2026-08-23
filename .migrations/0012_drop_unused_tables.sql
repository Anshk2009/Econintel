-- ============================================================================
-- EconIntel — 0012: drop the three tables nothing has ever written to
-- ============================================================================
-- api_usage, email_tokens and login_events were created in the original schema
-- and no code path has ever inserted a row into any of them:
--   * usage counting lives in kv_store (chat.js rate-limit keys)
--   * reset / verification tokens live in kv_store (`reset:` / `verify:` keys)
--   * the login audit was designed and never wired up
--
-- Verified by grepping every supabaseRest() call in functions/ — only `users`,
-- `chat_history` and `kv_store` are ever touched.
--
-- OPTIONAL AND UNHURRIED. An empty table costs nothing but attention, and
-- dropping it is the one action here that cannot be undone by re-running a file.
-- Run it when you want the schema to match the code, not because it is urgent.
--
-- CONFIRM THEY ARE EMPTY FIRST. If any of these has rows, something writes to
-- it that this note does not know about — stop and find out what.
--     select 'api_usage'    t, count(*) from api_usage
--     union all select 'email_tokens', count(*) from email_tokens
--     union all select 'login_events', count(*) from login_events;
--
-- NOTE FOR LATER: .migrations/0003_enable_rls.sql names all six original tables.
-- After this runs, re-pasting 0003 errors on the three that are gone. 0003 is
-- already applied and schema_supabase.sql now carries the live RLS state, so
-- there is no reason to re-run it — but that is why it would fail if you did.
-- ============================================================================

DROP TABLE IF EXISTS api_usage;
DROP TABLE IF EXISTS email_tokens;
DROP TABLE IF EXISTS login_events;

-- Verify: expect 0 rows.
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('api_usage', 'email_tokens', 'login_events');
