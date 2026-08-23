-- ============================================================================
-- EconIntel — Supabase (PostgreSQL) app schema
-- Run this ONCE in the Supabase dashboard → SQL Editor → New query → Run.
-- The RAG `documents` table is separate: see .rag/schema.sql.
--
-- ⚠️ READ THIS BEFORE EDITING — the file used to be a data-loss trap.
--
-- It opened with `DROP TABLE IF EXISTS users CASCADE` (and five more), under a
-- header that called the file "Safe to re-run". Both halves were true when it
-- was written — there was no data yet, auth had never worked — and neither is
-- true now. Anyone re-running it to add a column would have silently deleted
-- every account and every saved conversation, with the file's own comment
-- telling them it was fine. The DROP block is gone.
--
-- It also ended with `DISABLE ROW LEVEL SECURITY` on all six tables — the exact
-- landmine that was deliberately removed from .rag/schema.sql in the commit
-- "remove the landmine that would undo it", and missed here. One paste would
-- have reopened every table. That block now ENABLES RLS, which is what
-- production actually runs.
--
-- This file is now genuinely idempotent: every statement is
-- `create ... if not exists` or an `alter` that restates the current state.
-- Re-running it adds anything missing and destroys nothing.
-- ============================================================================

-- Users -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  username          TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  plan              TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  token_version     INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- Chat history ----------------------------------------------------------------
-- ON DELETE CASCADE is load-bearing: it is what makes account deletion
-- (auth.js ?action=delete-account) a single DELETE against users.
CREATE TABLE IF NOT EXISTS chat_history (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  model           TEXT,
  conversation_id TEXT,   -- groups a user+assistant exchange into one thread (NULL = legacy flat)
  tokens_used     INTEGER DEFAULT 0,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_history_user_id      ON chat_history(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created_at   ON chat_history(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_history_user_created ON chat_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_history_deleted      ON chat_history(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_history_conversation ON chat_history(user_id, conversation_id, created_at);

-- KV store (refresh tokens, CSRF tokens, rate-limit counters, guest quotas) ----
-- The edge functions use this table AS their KV store (middleware.js makeSupabase).
-- Rows carry their own TTL in expires_at; TOKENS.get filters on it.
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kv_store_expires_at ON kv_store(expires_at);

-- ============================================================================
-- Tables that USED to be here: api_usage, email_tokens, login_events.
--
-- All three were created and indexed, and no code ever wrote a row to any of
-- them. Usage counters and session state live in kv_store; the login audit was
-- never wired up. They were three tables' worth of RLS surface, three more
-- things to remember in a migration, and zero rows.
--
-- They are still present in the live database. .migrations/0012 drops them when
-- you are ready; there is no hurry, since an empty table costs nothing but
-- attention. If you later want a real login audit, add it back with the code
-- that writes to it in the same commit.
-- ============================================================================

-- ============================================================================
-- ROW LEVEL SECURITY: ON. This is what production runs (applied 2026-08-22).
--
-- With RLS enabled and NO policies, the publishable/anon key can do nothing to
-- these tables at all. The edge functions authenticate with SUPABASE_SECRET_KEY
-- (`sb_secret_…`), which bypasses RLS — so a leaked publishable key is inert.
--
-- DO NOT replace these with DISABLE. If a function starts failing 42501, the
-- cause is a caller that lost its secret key, not this setting.
-- ============================================================================
ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE kv_store     ENABLE ROW LEVEL SECURITY;

-- FORCE so the table OWNER is subject to RLS too. service_role / sb_secret is
-- specifically exempt from both, which is why the backend keeps working.
ALTER TABLE users        FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_history FORCE ROW LEVEL SECURITY;
ALTER TABLE kv_store     FORCE ROW LEVEL SECURITY;

-- Sanity check — every row should read true, true.
-- SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname IN ('users','chat_history','kv_store');
