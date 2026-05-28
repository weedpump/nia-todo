-- Track which passkeys were registered as discoverable/resident credentials.
-- Existing passkeys stay usable for MFA/Reauth but are not trusted for passwordless login.
ALTER TABLE passkeys ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0;
