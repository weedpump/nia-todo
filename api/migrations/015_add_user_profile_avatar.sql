-- Migration 015: User profile display name and avatar metadata
-- Created: 2026-05-21
-- Purpose: Let users update their display name and upload an avatar image.

ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;
