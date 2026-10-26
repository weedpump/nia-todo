-- Migration 057: Store module visibility per workspace.

ALTER TABLE workspaces ADD COLUMN hidden_modules_json TEXT NOT NULL DEFAULT '[]';
