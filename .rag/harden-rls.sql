-- ============================================================================
-- APPLIED 2026-08-22 — this file is now a RECORD, not a to-do.
-- RLS is ON for all SEVEN public tables (kv_store, email_tokens, users,
-- chat_history, login_events, api_usage, documents) with NO policies, so the
-- publishable key can do nothing to any of them. Applied only after edge_logs
-- confirmed every caller had moved to sb_secret_ following the EdgeOne redeploy.
-- Verified after: match_documents still returned 6 rows (the security-definer
-- read path), and all seven ERROR-level advisor findings cleared.
-- The live definition lives in schema.sql. Keep this for the sequencing and the
-- rollback line at the bottom.
-- EconIntel RAG — lock down `documents` with RLS, properly.
-- OPTIONAL HARDENING. schema.sql leaves RLS OFF because that is the state the
-- pipeline works in today. This file is the stricter setup, and it has a
-- PREREQUISITE — do step 0 first or you will break ingestion exactly the way it
-- broke on 2026-08-21.
--
-- WHAT IS WRONG WITH RLS OFF
-- Anyone holding the anon key can INSERT into `documents`. The chat reads this
-- table, so that is a prompt-injection surface: a planted row is retrieved,
-- fenced as untrusted data, but still read by the model. The key is server-side
-- only (edge function env + GitHub secrets, never client code), so the exposure
-- is small — but "small" is not "none", and this is cheap to close.
--
-- WHY IT WAS OFF
-- Every caller authenticated as anon, because EdgeOne refuses to store a
-- service_role key. That constraint is real for the EDGE FUNCTION and false for
-- GITHUB ACTIONS, which has no such objection. Splitting the two by role is what
-- makes this work: Actions writes with service_role, the edge function only ever
-- reads, and it reads through a security-definer function.
-- ============================================================================


-- ─── 0. PREREQUISITE — DO THIS FIRST, IN GITHUB, NOT HERE ───────────────────
-- Supabase dashboard -> Project Settings -> API -> `service_role` key (secret).
-- GitHub -> repo Settings -> Secrets and variables -> Actions -> New secret:
--     name:  SUPABASE_SERVICE_ROLE_KEY
--     value: <the service_role key>
-- Then add it to the env: block of ingest-live.yml, ingest-data.yml and
-- seed-documents.yml:
--     SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
--
-- The code already prefers it and falls back to anon (sources/_lib.mjs), so
-- adding the secret changes nothing until you run the SQL below. That ordering
-- is the whole point: the ingesters are already authenticating correctly BEFORE
-- anything starts being denied.
--
-- NEVER put this key in EdgeOne, in config.js, or anywhere the browser sees it.
-- It bypasses every policy in the database.
--
-- Confirm it took effect: run ingest-live once and check the log says it is
-- using the service role, THEN come back and run the rest of this file.


-- ─── 1. TURN RLS ON ─────────────────────────────────────────────────────────
-- With RLS enabled and NO policy, the anon role can do nothing to this table.
-- service_role bypasses RLS entirely, so the ingesters are unaffected.
alter table documents enable row level security;

-- Explicitly drop any permissive leftovers, so the end state does not depend on
-- what happened to exist before.
drop policy if exists documents_anon_select on documents;
drop policy if exists documents_anon_insert on documents;
drop policy if exists documents_public_read on documents;


-- ─── 2. READS GO THROUGH THE FUNCTION, NOT THE TABLE ────────────────────────
-- match_documents is already `security definer` (see schema.sql), so it runs as
-- its owner and reads regardless of RLS. Deliberately NO anon SELECT policy:
-- the chat has no business reading raw rows, and the function is the only shape
-- of read it actually needs.
--
-- Re-run schema.sql if you have not since 2026-08-21 — an older copy of
-- match_documents is `security invoker`, and with RLS on it will return ZERO
-- ROWS rather than an error. retrieveContext treats an empty result as "the
-- library had nothing", shows no warning, and the chat answers ungrounded
-- looking entirely normal. That silent-read failure is worse than the loud
-- write one, and it is the specific trap this comment exists to prevent.
grant execute on function match_documents to anon;


-- ─── 3. VERIFY — DO NOT SKIP ────────────────────────────────────────────────
-- 3a. RLS is on and the table has no permissive policy:
--     select relrowsecurity from pg_class where relname = 'documents';   -- expect true
--     select policyname from pg_policies where tablename = 'documents';  -- expect 0 rows
--
-- 3b. The function still reads. This is the check that catches the silent
--     failure — it must return rows, not an empty set:
--     select count(*) from match_documents(
--       (select embedding from documents where embedding is not null limit 1),
--       5, 'inflation');
--
-- 3c. Then, from a terminal, prove the whole path end to end:
--     cd .rag && node check-retrieval.mjs
--     Green means the edge function will retrieve too. Do not rely on 3a alone.


-- ─── 4. ROLLBACK, IF INGESTION STARTS FAILING 42501 ─────────────────────────
-- That error means something is still writing as anon — most likely the secret
-- is missing from one workflow's env: block. Undo, fix, retry:
--     alter table documents disable row level security;
