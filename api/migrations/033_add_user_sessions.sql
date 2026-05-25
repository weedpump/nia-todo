-- User sessions for per-device JWT revocation

CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    trusted_device_id INTEGER,
    user_agent TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (trusted_device_id) REFERENCES trusted_devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_trusted_device ON user_sessions(trusted_device_id);
