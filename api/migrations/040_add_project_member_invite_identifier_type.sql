-- Migration 040: Track project invite identifier type.
-- Purpose: Let owner-facing member lists show pending username invites after reload
-- without revealing whether neutral email invites matched an existing account.

ALTER TABLE project_members ADD COLUMN invite_identifier_type TEXT NOT NULL DEFAULT 'username'
    CHECK(invite_identifier_type IN ('username', 'email'));

CREATE INDEX IF NOT EXISTS idx_project_members_invite_identifier_type
ON project_members(invite_identifier_type);
