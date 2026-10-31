PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE shopping_list_preferences__local_filter_cleanup (
    shopping_list_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    hide_empty_sections INTEGER NOT NULL DEFAULT 0 CHECK(hide_empty_sections IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (shopping_list_id, user_id),
    FOREIGN KEY (shopping_list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO shopping_list_preferences__local_filter_cleanup (
    shopping_list_id,
    user_id,
    hide_empty_sections,
    updated_at
)
SELECT
    shopping_list_id,
    user_id,
    hide_empty_sections,
    updated_at
FROM shopping_list_preferences;

DROP TABLE shopping_list_preferences;
ALTER TABLE shopping_list_preferences__local_filter_cleanup RENAME TO shopping_list_preferences;

COMMIT;

PRAGMA foreign_keys = ON;
