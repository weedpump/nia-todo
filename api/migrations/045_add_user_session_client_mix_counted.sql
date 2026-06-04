-- Migration 045: Mark sessions whose anonymized client mix was counted.
-- The marker prevents repeated admin backfills from double-counting existing sessions.

ALTER TABLE user_sessions ADD COLUMN client_mix_counted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_user_sessions_client_mix_counted
ON user_sessions(client_mix_counted_at, created_at);
