-- Migration 042: Add per-user default due-date reminder settings.
-- Purpose: Automatically create reminders from deadlines when users opt in.
-- NOTE: The migration system handles duplicate column errors gracefully.

ALTER TABLE users ADD COLUMN default_reminder_offset_minutes INTEGER;
ALTER TABLE reminders ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit';
