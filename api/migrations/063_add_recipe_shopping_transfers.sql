-- Generic Shopping amount/note fields and durable Recipe-to-Shopping receipts.
ALTER TABLE shopping_items ADD COLUMN quantity_text TEXT CHECK(quantity_text IS NULL OR length(quantity_text) <= 500);
ALTER TABLE shopping_items ADD COLUMN note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000);

CREATE TRIGGER shopping_items_amount_insert
BEFORE INSERT ON shopping_items
WHEN NEW.quantity_value IS NOT NULL AND length(trim(COALESCE(NEW.quantity_text, ''))) > 0
BEGIN SELECT RAISE(ABORT, 'Numeric and free quantities are mutually exclusive'); END;
CREATE TRIGGER shopping_items_amount_update
BEFORE UPDATE OF quantity_value, quantity_text ON shopping_items
WHEN NEW.quantity_value IS NOT NULL AND length(trim(COALESCE(NEW.quantity_text, ''))) > 0
BEGIN SELECT RAISE(ABORT, 'Numeric and free quantities are mutually exclusive'); END;

CREATE TABLE recipe_shopping_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_mutation_id TEXT NOT NULL CHECK(length(client_mutation_id) BETWEEN 1 AND 200),
    request_hash TEXT NOT NULL,
    shopping_list_id INTEGER REFERENCES shopping_lists(id) ON DELETE SET NULL,
    target_shopping_list_id INTEGER NOT NULL,
    source_recipe_id INTEGER NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision > 0),
    created_count INTEGER NOT NULL CHECK(created_count >= 0),
    merged_count INTEGER NOT NULL CHECK(merged_count >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, client_mutation_id)
);

CREATE TABLE shopping_item_recipe_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopping_item_id INTEGER NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    transfer_id INTEGER REFERENCES recipe_shopping_transfers(id) ON DELETE SET NULL,
    recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision > 0),
    recipe_title TEXT NOT NULL,
    ingredient_client_key TEXT NOT NULL,
    ingredient_name TEXT NOT NULL,
    quantity_value REAL,
    quantity_unit TEXT,
    quantity_text TEXT,
    note TEXT NOT NULL DEFAULT '',
    base_servings REAL NOT NULL CHECK(base_servings > 0),
    servings REAL NOT NULL CHECK(servings > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(quantity_value IS NULL OR quantity_value >= 0),
    CHECK(quantity_value IS NULL OR length(trim(COALESCE(quantity_text, ''))) = 0)
);
CREATE INDEX idx_shopping_item_recipe_sources_item ON shopping_item_recipe_sources(shopping_item_id, id);
