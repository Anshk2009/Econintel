-- ============================================================================
-- EconIntel — Supabase (PostgreSQL) schema
-- Run this ONCE in the Supabase dashboard → SQL Editor → New query → Run.
--
-- Why this file exists: the old migrations used SQLite's `DATETIME` type,
-- which PostgreSQL rejects, so tables were never created / created partially.
-- This file drops any partial tables and recreates them cleanly with Postgres
-- `TIMESTAMPTZ`. Safe to re-run. (No real data exists yet — auth never worked.)
-- ============================================================================

-- Clean slate: remove any partially-created tables from earlier attempts.
DROP TABLE IF EXISTS login_events CASCADE;
DROP TABLE IF EXISTS chat_history CASCADE;
DROP TABLE IF EXISTS email_tokens CASCADE;
DROP TABLE IF EXISTS api_usage    CASCADE;
DROP TABLE IF EXISTS kv_store      CASCADE;
DROP TABLE IF EXISTS users         CASCADE;

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

-- API usage -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_usage (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_usage_user_id       ON api_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_created_at    ON api_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_user_endpoint ON api_usage(user_id, endpoint, created_at);

-- Email verification / password-reset tokens ----------------------------------
CREATE TABLE IF NOT EXISTS email_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL CHECK (token_type IN ('email_verification','password_reset')),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id    ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_tokens_expires_at ON email_tokens(expires_at);

-- Chat history ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_history (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  model           TEXT DEFAULT 'openrouter/auto',
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

-- Login event audit -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_events (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  ip_hash         TEXT,
  user_agent_hash TEXT,
  success         BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_events_user_id    ON login_events(user_id);
CREATE INDEX IF NOT EXISTS idx_login_events_created_at ON login_events(created_at);
CREATE INDEX IF NOT EXISTS idx_login_events_ip_hash    ON login_events(ip_hash);

-- KV store (tokens, CSRF, rate-limit counters) --------------------------------
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kv_store_expires_at ON kv_store(expires_at);

-- ============================================================================
-- Row Level Security: DISABLED on purpose.
-- The Supabase key is only ever used server-side inside the EdgeOne functions
-- (it is never sent to the browser), so RLS would only block our own backend.
-- Disabling it lets the backend write with the anon key — no service key needed.
-- (If you later want defense-in-depth, set SUPABASE_SERVICE_KEY in EdgeOne and
--  flip these to ENABLE; the functions already prefer the service key.)
-- ============================================================================
ALTER TABLE users        DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage    DISABLE ROW LEVEL SECURITY;
ALTER TABLE email_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE login_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE kv_store     DISABLE ROW LEVEL SECURITY;
