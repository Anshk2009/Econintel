-- ============================================================================
-- EconIntel — 0012: drop the three tables nothing has ever written to
-- ============================================================================
-- api_usage, email_tokens and login_events were created in the original schema
-- and NO CURRENT code path reads or writes any of them:
--   * usage counting lives in kv_store (chat.js rate-limit keys)
--   * reset / verification tokens live in kv_store (`reset:` / `verify:` keys)
--   * the login audit was designed and never wired up
--
-- Verified by grepping every supabaseRest() call and every /rest/v1/ URL in
-- functions/ and .rag/ — only `users`, `chat_history`, `kv_store`, `documents`
-- and the match_documents RPC are ever touched.
--
-- CORRECTION, 2026-08-23 — an earlier draft of this file claimed no row had
-- EVER been inserted. That was wrong, and the pre-flight check below is what
-- caught it. api_usage held two rows, both written on 2026-06-09 by the
-- Next.js-era build that commit 6178a73 replaced:
--
--   id                                           user_id                                       endpoint tokens created_at
--   UR90gfabGvcZW0puYFu4ZrLs3oOhO-AFZT-Lwb7yBDE  yseJbXrU9ya9piKr-NWnb3yL4TK4a-osO4GBEzC1yXI   chat     335    2026-06-09 06:18:57+00
--   Gpo4SD8RaI0dhqTn30T_7Uu1up8Tq0l3m-6O3j6AVmk  yseJbXrU9ya9piKr-NWnb3yL4TK4a-osO4GBEzC1yXI   chat     385    2026-06-09 17:21:38+00
--
-- They are recorded here so the drop loses nothing but the table. Two token
-- counts for one user from a deleted architecture are not data anyone will want
-- back, but "we checked and wrote down what was there" is cheap and "we assumed
-- it was empty" is how the RLS landmine survived for months.
--
-- OPTIONAL AND UNHURRIED. Dropping a table is the one action here that cannot be
-- undone by re-running a file. Run it when you want the schema to match the
-- code, not because it is urgent.
--
-- RE-CHECK BEFORE RUNNING. If a count comes back higher than the note above,
-- something writes to it that this file does not know about — stop and find out
-- what, exactly as happened on 2026-08-23.
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
