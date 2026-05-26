-- Opportunistic cleanup for expired/revoked JWT sessions and trusted 2FA devices.
-- Runs with normal migrations/startup and keeps session/device tables bounded.

DELETE FROM user_sessions
WHERE expires_at < strftime('%s', 'now') OR revoked_at IS NOT NULL;

DELETE FROM trusted_devices
WHERE expires_at < strftime('%s', 'now') OR revoked_at IS NOT NULL;
