-- Migration 020: Add public instance metadata
-- Created: 2026-05-22
-- Purpose: Store low-information public instance identity for native app verification.

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('instance_id', ''),
    ('instance_display_name', 'nia-todo');
