-- Migration 014: Password setup/reset links
-- Created: 2026-05-20
-- Purpose: Let admins create one-time password setup/reset links instead of setting user passwords.

ALTER TABLE users ADD COLUMN email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
ON users(email)
WHERE email IS NOT NULL AND email != '';

CREATE TABLE IF NOT EXISTS password_setup_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'reset' CHECK(purpose IN ('invite', 'reset')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    created_by_admin INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user ON password_setup_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_prefix ON password_setup_tokens(token_prefix);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_expires ON password_setup_tokens(expires_at);
