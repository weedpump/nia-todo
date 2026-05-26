-- Harden 2FA replay/race handling

CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_two_factor_recovery_codes_user_active
    ON two_factor_recovery_codes(user_id, consumed_at);

ALTER TABLE two_factor_challenges ADD COLUMN reauth_counter INTEGER;

CREATE TABLE IF NOT EXISTS two_factor_totp_reauth_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    timestep INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, timestep),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
