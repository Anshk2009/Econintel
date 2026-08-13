-- ============================================================================
-- EconIntel — 0005: add conversation_id to chat_history (threaded chats)
-- ============================================================================
-- WHAT THIS DOES
--   Adds a nullable text column that groups a user+assistant exchange into a
--   single conversation thread, so the sidebar can reopen a whole past chat.
--
-- SAFE / ADDITIVE: the column is nullable, so existing rows simply get NULL
--   ("legacy flat history") and nothing currently working breaks. The threaded
--   UI only reads/writes rows that HAVE a conversation_id.
--
-- Run this in Supabase → SQL Editor before (or together with) uploading the
-- threaded chat.js / chat-history.js / chat.html. Rollback: 0006.
-- ============================================================================

ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS conversation_id TEXT;

-- Speeds up "fetch one thread" and "list my threads" lookups.
CREATE INDEX IF NOT EXISTS idx_chat_history_conversation
  ON chat_history (user_id, conversation_id, created_at);
