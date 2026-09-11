-- Persist login throttles across service restarts.
CREATE TABLE IF NOT EXISTS login_rate_limit_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket TEXT NOT NULL,
    bucket_key TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_rate_limit_attempts_lookup
    ON login_rate_limit_attempts(bucket, bucket_key, attempted_at);
