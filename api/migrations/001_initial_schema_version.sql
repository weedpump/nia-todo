-- Migration 001: Initial schema_version table
-- Created: 2026-05-15
-- Purpose: Enable migrations tracking

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
