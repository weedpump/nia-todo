-- Shared, account-local item choices. Existing BrainDump counters stay intact.
ALTER TABLE users ADD COLUMN routing_memory_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE routing_memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, event_id)
);
CREATE INDEX idx_routing_memory_events_user_revision
    ON routing_memory_events(user_id, id DESC);

CREATE TABLE routing_memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name_key TEXT NOT NULL,
    shopping_list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    list_known INTEGER NOT NULL DEFAULT 0 CHECK(list_known IN (0,1)),
    section_id INTEGER REFERENCES shopping_sections(id) ON DELETE SET NULL,
    section_known INTEGER NOT NULL DEFAULT 0 CHECK(section_known IN (0,1)),
    store_ids_json TEXT NOT NULL DEFAULT '[]',
    stores_known INTEGER NOT NULL DEFAULT 0 CHECK(stores_known IN (0,1)),
    list_sequence INTEGER NOT NULL DEFAULT 0,
    update_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, name_key, shopping_list_id)
);
CREATE INDEX idx_routing_memory_user_order
    ON routing_memory_entries(user_id, list_sequence DESC, update_sequence DESC);

-- A removed section is unknown, rather than a newly learned explicit "none".
CREATE TRIGGER routing_memory_forget_deleted_section
BEFORE DELETE ON shopping_sections
BEGIN
    UPDATE routing_memory_entries SET section_known = 0, section_id = NULL
    WHERE section_id = OLD.id;
END;
