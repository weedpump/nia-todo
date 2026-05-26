-- Two-factor authentication: TOTP, passkeys, email fallback, recovery codes, trusted devices

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('two_factor_required', 'false');

ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN two_factor_totp_secret TEXT;
ALTER TABLE users ADD COLUMN two_factor_recovery_hashes TEXT;
ALTER TABLE users ADD COLUMN two_factor_recovery_generated_at TEXT;
ALTER TABLE users ADD COLUMN two_factor_remember_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN two_factor_updated_at TEXT;

CREATE TABLE IF NOT EXISTS two_factor_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    methods TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    email_code_hash TEXT,
    email_code_expires_at INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_token ON two_factor_challenges(token_hash);
CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_user ON two_factor_challenges(user_id, consumed_at);

CREATE TABLE IF NOT EXISTS trusted_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    remember_version INTEGER NOT NULL DEFAULT 1,
    user_agent TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_prefix ON trusted_devices(user_id, token_prefix);

CREATE TABLE IF NOT EXISTS passkeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT 'Passkey',
    transports TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS passkey_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    challenge_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication')),
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user ON passkey_challenges(user_id, purpose, consumed_at);
