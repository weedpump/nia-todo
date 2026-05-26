-- Migration 005: Add admin_token_version for JWT invalidation
-- Created: 2026-05-16
-- Purpose: Versioned admin JWT tokens for instant invalidation

ALTER TABLE admin_config ADD COLUMN admin_token_version INTEGER DEFAULT 1;
UPDATE admin_config SET admin_token_version = 1 WHERE admin_token_version IS NULL;
