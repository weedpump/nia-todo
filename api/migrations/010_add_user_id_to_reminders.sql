-- Migration: Add user_id to reminders table
-- Created: 2026-05-16

ALTER TABLE reminders ADD COLUMN user_id INTEGER;

-- Create index for user-based lookups
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);

-- Update existing reminders: derive user_id from linked todo
UPDATE reminders SET user_id = (
    SELECT user_id FROM todos WHERE todos.id = reminders.todo_id
) WHERE user_id IS NULL;
