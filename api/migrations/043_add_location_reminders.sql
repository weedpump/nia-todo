-- Migration 043: Add saved places and Android-only location reminders.
-- Purpose: Store address-only location reminders. Android resolves addresses locally and owns geofence triggering.

CREATE TABLE IF NOT EXISTS saved_places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    icon TEXT DEFAULT 'pin',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_places_user_name ON saved_places(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);

CREATE TABLE IF NOT EXISTS location_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('arrival', 'departure')),
    place_id INTEGER,
    address TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    triggered_at TEXT,
    source TEXT NOT NULL DEFAULT 'explicit',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (place_id) REFERENCES saved_places(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_location_reminders_todo ON location_reminders(todo_id);
CREATE INDEX IF NOT EXISTS idx_location_reminders_user_enabled ON location_reminders(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_location_reminders_place ON location_reminders(place_id);
