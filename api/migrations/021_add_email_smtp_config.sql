-- Migration 021: Add email/SMTP configuration and verification state
-- Created: 2026-05-23
-- Purpose: Prepare SMTP-backed account emails, password reset, invites, and future 2FA recovery.

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('smtp_enabled', 'false'),
    ('smtp_host', ''),
    ('smtp_port', '587'),
    ('smtp_security', 'starttls'),
    ('smtp_auth_enabled', 'false'),
    ('smtp_username', ''),
    ('smtp_password_secret', ''),
    ('mail_from_address', ''),
    ('mail_from_name', 'nia-todo'),
    ('mail_reply_to', ''),
    ('password_link_ttl_hours', '24');

ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN pending_email TEXT;
ALTER TABLE users ADD COLUMN pending_email_token_hash TEXT;
ALTER TABLE users ADD COLUMN pending_email_token_prefix TEXT;
ALTER TABLE users ADD COLUMN pending_email_token_expires_at TEXT;
ALTER TABLE users ADD COLUMN email_changed_at TEXT;

UPDATE users
SET email_verified_at = COALESCE(email_verified_at, datetime('now'))
WHERE email IS NOT NULL
  AND TRIM(email) != ''
  AND password_hash IS NOT NULL
  AND TRIM(password_hash) != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pending_email_unique
ON users(pending_email)
WHERE pending_email IS NOT NULL AND pending_email != '';

CREATE INDEX IF NOT EXISTS idx_users_pending_email_token_prefix
ON users(pending_email_token_prefix)
WHERE pending_email_token_prefix IS NOT NULL AND pending_email_token_prefix != '';

ALTER TABLE password_setup_tokens ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'used', 'replaced'));
ALTER TABLE password_setup_tokens ADD COLUMN replaced_at TEXT;
ALTER TABLE password_setup_tokens ADD COLUMN requested_by TEXT NOT NULL DEFAULT 'admin' CHECK(requested_by IN ('admin', 'user', 'system'));

UPDATE password_setup_tokens
SET status = 'used'
WHERE used_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_purpose_status
ON password_setup_tokens(user_id, purpose, status);
