-- Migration 022: Case-insensitive email uniqueness
-- Created: 2026-05-23
-- Purpose: Align email uniqueness with case-insensitive login/sharing lookups.

UPDATE users
SET email = lower(trim(email))
WHERE email IS NOT NULL AND trim(email) != '';

UPDATE users
SET pending_email = lower(trim(pending_email))
WHERE pending_email IS NOT NULL AND trim(pending_email) != '';

DROP INDEX IF EXISTS idx_users_email_unique;
DROP INDEX IF EXISTS idx_users_pending_email_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique_ci
ON users(lower(email))
WHERE email IS NOT NULL AND email != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pending_email_unique_ci
ON users(lower(pending_email))
WHERE pending_email IS NOT NULL AND pending_email != '';
