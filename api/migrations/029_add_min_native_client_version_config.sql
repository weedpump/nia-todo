-- Migration 029: Add configurable native app compatibility floor
-- Created: 2026-05-24
-- Purpose: Allow releases to optionally require a minimum native client version.

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('min_native_client_version', '2.9.0');
