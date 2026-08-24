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
--   row 1 — endpoint "chat",   335 tokens,  2026-06-09 06:18:57+00
--   row 2 — endpoint "chat",   385 tokens,  2026-06-09 17:21:38+00
--   both rows: same single user_id, both ids redacted (see note below)
--
-- They are recorded here so the drop loses nothing but the table. Two token
-- counts from a deleted architecture are not data anyone will want back, but
-- "we checked and wrote down what was there" is cheap and "we assumed it was
-- empty" is how the RLS landmine survived for months.
--
-- REDACTED for open source. The first draft of this note pasted the real row
-- ids and the real user_id verbatim. Those identify a live account, and this
-- repo is public — an internal id is not a credential, but publishing one is a
-- disclosure with no upside. The shape of what was there is the part worth
-- keeping; the identifiers are not.
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
