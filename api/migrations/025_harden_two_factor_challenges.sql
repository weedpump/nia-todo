-- Harden 2FA challenge verification with attempt counters / lockout

ALTER TABLE two_factor_challenges ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE two_factor_challenges ADD COLUMN locked_until INTEGER;
