-- Migration 0002: KV Store Table
-- Temporary key-value storage for tokens, CSRF tokens, rate limiting, etc.
-- This is a workaround until EdgeOne KV is approved.

CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast expiration cleanup
CREATE INDEX IF NOT EXISTS idx_kv_store_expires_at ON kv_store(expires_at);

-- Cleanup old expired entries (optional, can be run periodically)
-- DELETE FROM kv_store WHERE expires_at < NOW();
