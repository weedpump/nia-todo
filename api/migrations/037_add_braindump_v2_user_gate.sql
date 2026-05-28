-- BrainDump v2 access gate.
-- The feature is intentionally off for every user until explicitly enabled.

ALTER TABLE users ADD COLUMN braindump_enabled INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_braindump_enabled ON users(braindump_enabled);
