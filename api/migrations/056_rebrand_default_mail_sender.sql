-- Migration 056: Rebrand the untouched default email sender
-- Existing custom sender names remain unchanged.

UPDATE app_config
SET value = 'Nia',
    updated_at = datetime('now')
WHERE key = 'mail_from_name'
  AND value = 'nia-todo';
