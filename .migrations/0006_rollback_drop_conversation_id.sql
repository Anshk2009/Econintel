-- ============================================================================
-- EconIntel — 0006: ROLLBACK of 0005 (remove conversation_id from chat_history)
-- ============================================================================
-- Run this in Supabase → SQL Editor to undo threaded chats. After this, the old
-- (flat-history) functions work again. Dropping the column also drops the data
-- in it, but the chat messages themselves (role/content/created_at) are kept.
-- ============================================================================

DROP INDEX IF EXISTS idx_chat_history_conversation;
ALTER TABLE chat_history DROP COLUMN IF EXISTS conversation_id;
