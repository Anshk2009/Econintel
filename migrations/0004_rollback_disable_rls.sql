-- ============================================================================
-- EconIntel — 0004: ROLLBACK of 0003 (re-DISABLE Row Level Security)
-- ============================================================================
-- Run this in Supabase → SQL Editor if enabling RLS (0003) broke signup / login
-- / chat. It returns the database to the previous, known-working state where the
-- backend's anon key has full server-side access.
--
-- After running this, the site works again even with the OLD anon-key-only
-- functions, so it's a safe panic button.
-- ============================================================================

ALTER TABLE users        DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage    DISABLE ROW LEVEL SECURITY;
ALTER TABLE email_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE login_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE kv_store     DISABLE ROW LEVEL SECURITY;
