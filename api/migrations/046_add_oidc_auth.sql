-- Migration 046: Generic OIDC authentication support
-- Purpose: Store OIDC runtime state and explicit identity links.

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('oidc_enabled', 'false'),
    ('oidc_provider_name', 'OIDC'),
    ('oidc_issuer_url', ''),
    ('oidc_client_id', ''),
    ('oidc_client_secret', ''),
    ('oidc_public_client', 'false'),
    ('oidc_token_auth_method', 'auto'),
    ('oidc_scopes', 'openid email profile');

CREATE TABLE IF NOT EXISTS oidc_login_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state_hash TEXT NOT NULL UNIQUE,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('user_login', 'admin_login', 'admin_link')),
    redirect_after TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL,
    consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oidc_login_states_active
ON oidc_login_states(state_hash, consumed_at, expires_at);

CREATE TABLE IF NOT EXISTS user_oidc_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    email_at_link_time TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_oidc_identities_user
ON user_oidc_identities(user_id);

CREATE TABLE IF NOT EXISTS admin_oidc_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_label TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT,
    UNIQUE (issuer, subject)
);
