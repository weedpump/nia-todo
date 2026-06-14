-- Migration 047: Native OIDC handoff bridge
-- Purpose: Store one-time native-app handoff codes so OIDC tokens do not travel in custom-scheme URLs.

CREATE TABLE IF NOT EXISTS oidc_native_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('user', 'error')),
    payload_json TEXT NOT NULL,
    redirect_after TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL,
    consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oidc_native_handoffs_active
ON oidc_native_handoffs(code_hash, consumed_at, expires_at);
