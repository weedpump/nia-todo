-- Keep the 067 last-choice projection; confidence uses deliberate observations.
-- Existing known fields provide one observation each, never invented hit counts.
CREATE TABLE routing_memory_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL REFERENCES routing_memory_entries(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES routing_memory_events(id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK(field IN ('list','section','stores')),
    value_json TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1 CHECK(weight IN (1,3)),
    observed_at TEXT NOT NULL,
    UNIQUE(event_id, entry_id, field)
);
CREATE INDEX idx_routing_observations_user_entry_field
    ON routing_memory_observations(user_id, entry_id, field, id DESC);

INSERT INTO routing_memory_observations(user_id, entry_id, field, value_json, observed_at)
    SELECT user_id, id, 'list', CAST(shopping_list_id AS TEXT), updated_at
    FROM routing_memory_entries WHERE list_known = 1 ORDER BY list_sequence, id;
INSERT INTO routing_memory_observations(user_id, entry_id, field, value_json, observed_at)
    SELECT user_id, id, 'section', CASE WHEN section_id IS NULL THEN 'null' ELSE CAST(section_id AS TEXT) END, updated_at
    FROM routing_memory_entries WHERE section_known = 1 ORDER BY update_sequence, id;
INSERT INTO routing_memory_observations(user_id, entry_id, field, value_json, observed_at)
    SELECT user_id, id, 'stores', store_ids_json, updated_at
    FROM routing_memory_entries WHERE stores_known = 1 ORDER BY update_sequence, id;

-- List choices compete across a name's lists, not independently per list.
DELETE FROM routing_memory_observations WHERE id IN (
    SELECT id FROM (
        SELECT observation.id,
               ROW_NUMBER() OVER (PARTITION BY observation.user_id, entry.name_key ORDER BY observation.id DESC) AS rank
        FROM routing_memory_observations observation
        JOIN routing_memory_entries entry ON entry.id = observation.entry_id
        WHERE observation.field = 'list'
    ) WHERE rank > 20
);
