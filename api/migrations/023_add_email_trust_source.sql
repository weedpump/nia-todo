-- Migration 023: Track email verification trust source
-- Created: 2026-05-23
-- Purpose: Make verified-email semantics explicit for SMTP, admin-asserted, setup-link, and legacy addresses.

ALTER TABLE users ADD COLUMN email_trust_source TEXT;

UPDATE users
SET email_trust_source = 'legacy_verified'
WHERE email_verified_at IS NOT NULL
  AND email IS NOT NULL
  AND trim(email) != ''
  AND email_trust_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_email_trust_source
ON users(email_trust_source)
WHERE email_trust_source IS NOT NULL AND email_trust_source != '';
