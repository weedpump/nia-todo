-- Migration 019: Add generic instance configuration
-- Created: 2026-05-22
-- Purpose: Store selfhosted instance settings that must not be hardcoded.

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    changed_keys TEXT NOT NULL,
    client_ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('public_base_url', ''),
    ('allowed_origins', '[]'),
    ('trusted_proxies', '[]');
