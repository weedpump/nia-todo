-- Migration 022: Case-insensitive email uniqueness
-- Created: 2026-05-23
-- Purpose: Align email uniqueness with case-insensitive login/sharing lookups.
--
-- Previous schema allowed case variants like Alice@example.org and alice@example.org.
-- Before normalizing, keep one deterministic owner per normalized address and clear
-- duplicate addresses so the migration can complete safely. Admins can reassign those
-- addresses afterwards; cleared addresses are not usable for verified-email login/share.

DROP INDEX IF EXISTS idx_users_email_unique;
DROP INDEX IF EXISTS idx_users_pending_email_unique;

UPDATE users
SET email = NULL,
    email_verified_at = NULL,
    email_changed_at = COALESCE(email_changed_at, datetime('now'))
WHERE email IS NOT NULL
  AND trim(email) != ''
  AND id NOT IN (
      SELECT keep_id
      FROM (
          SELECT lower(trim(email)) AS normalized_email,
                 MIN(id) AS keep_id
          FROM users
          WHERE email IS NOT NULL AND trim(email) != ''
          GROUP BY lower(trim(email))
      )
  )
  AND lower(trim(email)) IN (
      SELECT normalized_email
      FROM (
          SELECT lower(trim(email)) AS normalized_email,
                 COUNT(*) AS duplicate_count
          FROM users
          WHERE email IS NOT NULL AND trim(email) != ''
          GROUP BY lower(trim(email))
          HAVING duplicate_count > 1
      )
  );

UPDATE users
SET pending_email = NULL,
    pending_email_token_hash = NULL,
    pending_email_token_prefix = NULL,
    pending_email_token_expires_at = NULL,
    email_changed_at = COALESCE(email_changed_at, datetime('now'))
WHERE pending_email IS NOT NULL
  AND trim(pending_email) != ''
  AND id NOT IN (
      SELECT keep_id
      FROM (
          SELECT lower(trim(pending_email)) AS normalized_email,
                 MIN(id) AS keep_id
          FROM users
          WHERE pending_email IS NOT NULL AND trim(pending_email) != ''
          GROUP BY lower(trim(pending_email))
      )
  )
  AND lower(trim(pending_email)) IN (
      SELECT normalized_email
      FROM (
          SELECT lower(trim(pending_email)) AS normalized_email,
                 COUNT(*) AS duplicate_count
          FROM users
          WHERE pending_email IS NOT NULL AND trim(pending_email) != ''
          GROUP BY lower(trim(pending_email))
          HAVING duplicate_count > 1
      )
  );

UPDATE users
SET pending_email = NULL,
    pending_email_token_hash = NULL,
    pending_email_token_prefix = NULL,
    pending_email_token_expires_at = NULL,
    email_changed_at = COALESCE(email_changed_at, datetime('now'))
WHERE pending_email IS NOT NULL
  AND trim(pending_email) != ''
  AND lower(trim(pending_email)) IN (
      SELECT lower(trim(email))
      FROM users
      WHERE email IS NOT NULL AND trim(email) != ''
  );

UPDATE users
SET email = lower(trim(email))
WHERE email IS NOT NULL AND trim(email) != '';

UPDATE users
SET pending_email = lower(trim(pending_email))
WHERE pending_email IS NOT NULL AND trim(pending_email) != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique_ci
ON users(lower(email))
WHERE email IS NOT NULL AND email != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pending_email_unique_ci
ON users(lower(pending_email))
WHERE pending_email IS NOT NULL AND pending_email != '';
