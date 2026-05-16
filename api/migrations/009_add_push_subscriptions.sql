-- Migration 009: Add push_subscriptions table for PWA Web Push Notifications

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, endpoint)
);

-- Index for efficient user lookup
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
