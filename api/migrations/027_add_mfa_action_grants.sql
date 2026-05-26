-- One-time MFA grants for sensitive actions.
-- Login MFA and trusted-device login only allow app access; every sensitive action
-- must consume one fresh grant produced by an explicit reauth ceremony.

CREATE TABLE IF NOT EXISTS two_factor_action_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    grant_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_two_factor_action_grants_user ON two_factor_action_grants(user_id, consumed_at, expires_at);
