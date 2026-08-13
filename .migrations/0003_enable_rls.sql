-- ============================================================================
-- EconIntel — 0003: ENABLE Row Level Security (defense-in-depth)
-- ============================================================================
-- WHAT THIS DOES
--   Turns RLS back ON for every table that holds sensitive data. With RLS on and
--   NO policies defined, the `anon` and `authenticated` Postgres roles can read
--   NOTHING — but the `service_role` key BYPASSES RLS, so the backend keeps full
--   access. Net effect: if the public/anon key ever leaks, it is useless.
--
-- ⚠️  DO NOT RUN THIS UNTIL the edge functions are using the SERVICE-ROLE key.
--     Steps, in order:
--       1. Generate the wrapped key locally:   (in a terminal)
--            printf %s "<your service_role JWT>" | base64 -w0
--          (no -w0 on macOS — use:  | base64  and remove any line breaks)
--       2. EdgeOne dashboard → Environment Variables → add:
--            SUPABASE_SERVICE_KEY_B64 = <the base64 string from step 1>
--       3. Upload the updated functions (they auto-prefer the wrapped key).
--       4. TEST while RLS is still OFF: sign up + log in + send a chat. If that
--          works, the backend is talking to Supabase with the service key.
--       5. ONLY THEN run THIS file in Supabase → SQL Editor.
--       6. Re-test signup/login/chat. If anything breaks, run
--          0004_rollback_disable_rls.sql to instantly revert.
--
-- NOTE: the RAG `documents` table is intentionally NOT touched here — it holds
--       public source text and is read by the match_documents RPC. Leaving it as
--       it is avoids any chance of breaking retrieval.
-- ============================================================================

ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage    ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kv_store     ENABLE ROW LEVEL SECURITY;

-- Belt-and-braces: FORCE RLS so that even the table OWNER is subject to it.
-- (service_role still bypasses RLS — it is specifically exempt.)
ALTER TABLE users        FORCE ROW LEVEL SECURITY;
ALTER TABLE api_usage    FORCE ROW LEVEL SECURITY;
ALTER TABLE email_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_history FORCE ROW LEVEL SECURITY;
ALTER TABLE login_events FORCE ROW LEVEL SECURITY;
ALTER TABLE kv_store     FORCE ROW LEVEL SECURITY;

-- Sanity check — every listed table should show rowsecurity = true after this.
-- SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname IN
--   ('users','api_usage','email_tokens','chat_history','login_events','kv_store');
