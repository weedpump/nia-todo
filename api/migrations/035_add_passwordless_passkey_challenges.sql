-- Passwordless passkey login challenges are not bound to a user until assertion verify.
CREATE TABLE IF NOT EXISTS passkey_login_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_passkey_login_challenges_active ON passkey_login_challenges(consumed_at, expires_at);
