-- Persist release-check state separately from Debian installation progress.
CREATE TABLE IF NOT EXISTS server_update_check_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    release_json TEXT,
    source TEXT,
    last_success_at TEXT,
    last_check_at TEXT,
    stale INTEGER NOT NULL DEFAULT 1,
    check_error TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO server_update_check_state (id, stale)
VALUES (1, 1);
