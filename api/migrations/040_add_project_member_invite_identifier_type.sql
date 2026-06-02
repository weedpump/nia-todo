-- Migration 040: Track project invite identifier type.
-- Purpose: Let owner-facing member lists show pending username invites after reload
-- without revealing whether neutral email invites matched an existing account.
--
-- Existing pending rows predate this metadata and cannot be classified safely.
-- Treat them as email/hidden by default to avoid account enumeration. Future
-- invites are written with an explicit identifier type by the sharing endpoint.

ALTER TABLE project_members ADD COLUMN invite_identifier_type TEXT
    CHECK(invite_identifier_type IN ('username', 'email'));

UPDATE project_members
SET invite_identifier_type = 'email'
WHERE status = 'pending'
  AND invite_identifier_type IS NULL;

UPDATE project_members
SET invite_identifier_type = 'username'
WHERE status != 'pending'
  AND invite_identifier_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_members_invite_identifier_type
ON project_members(invite_identifier_type);
