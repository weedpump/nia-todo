-- Migration 057: Store module visibility per user account.

ALTER TABLE users ADD COLUMN disabled_modules_json TEXT NOT NULL DEFAULT '[]';
