-- Migration 044: Add backend-only operational counters for admin capacity stats.
-- These counters deliberately store only aggregated technical counts.
-- No user ids, IP addresses, user-provided content, transcripts, todo titles, or raw user agents.

CREATE TABLE IF NOT EXISTS ops_counters (
    bucket_start TEXT NOT NULL,
    bucket_size TEXT NOT NULL DEFAULT 'hour' CHECK(bucket_size IN ('hour', 'day')),
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'unknown',
    status_class TEXT NOT NULL DEFAULT 'any',
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bucket_start, bucket_size, category, key, platform, status_class)
);

CREATE INDEX IF NOT EXISTS idx_ops_counters_category_time ON ops_counters(category, bucket_start);
CREATE INDEX IF NOT EXISTS idx_ops_counters_key_time ON ops_counters(key, bucket_start);
