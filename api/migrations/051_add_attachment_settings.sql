-- Add attachment feature settings and per-user quotas.

ALTER TABLE users ADD COLUMN attachment_quota_bytes INTEGER;

INSERT INTO app_config (key, value, updated_at)
VALUES
  ('attachments_enabled', '1', datetime('now')),
  ('attachments_allowed_types', '["image/*","application/pdf","text/plain","text/markdown","application/zip","application/json"]', datetime('now')),
  ('attachments_default_quota_bytes', '5368709120', datetime('now'))
ON CONFLICT(key) DO NOTHING;
