-- Add attempt lockout to passkey authentication/reauth challenges.

ALTER TABLE passkey_challenges ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passkey_challenges ADD COLUMN locked_until INTEGER;
