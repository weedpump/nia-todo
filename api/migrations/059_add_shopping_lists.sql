-- Migration 059: Shopping lists, sections, items, and personal view preferences.

CREATE TABLE shopping_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    color TEXT NOT NULL DEFAULT '#6366f1',
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    client_mutation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_shopping_lists_client_mutation
ON shopping_lists(created_by_user_id, client_mutation_id)
WHERE client_mutation_id IS NOT NULL;

CREATE TABLE shopping_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopping_list_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    client_mutation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shopping_list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_shopping_sections_list_order
ON shopping_sections(shopping_list_id, sort_order, id);

CREATE UNIQUE INDEX idx_shopping_sections_client_mutation
ON shopping_sections(shopping_list_id, client_mutation_id)
WHERE client_mutation_id IS NOT NULL;

CREATE TABLE shopping_stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
    owner_user_id INTEGER,
    owner_household_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    client_mutation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK((owner_user_id IS NOT NULL) != (owner_household_id IS NOT NULL)),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_shopping_stores_personal_mutation
ON shopping_stores(owner_user_id, client_mutation_id)
WHERE owner_user_id IS NOT NULL AND client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_shopping_stores_household_mutation
ON shopping_stores(owner_household_id, client_mutation_id)
WHERE owner_household_id IS NOT NULL AND client_mutation_id IS NOT NULL;

CREATE INDEX idx_shopping_stores_owner_order
ON shopping_stores(owner_user_id, owner_household_id, active, sort_order, id);

CREATE TABLE shopping_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopping_list_id INTEGER NOT NULL,
    section_id INTEGER,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 500),
    quantity_value REAL,
    quantity_unit TEXT,
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
    completed_at TEXT,
    completed_by_user_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    client_mutation_id TEXT,
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shopping_list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (section_id) REFERENCES shopping_sections(id) ON DELETE SET NULL,
    FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_shopping_items_list_order
ON shopping_items(shopping_list_id, section_id, sort_order, id);

CREATE UNIQUE INDEX idx_shopping_items_client_mutation
ON shopping_items(shopping_list_id, client_mutation_id)
WHERE client_mutation_id IS NOT NULL;

CREATE TABLE shopping_item_stores (
    shopping_item_id INTEGER NOT NULL,
    shopping_store_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (shopping_item_id, shopping_store_id),
    FOREIGN KEY (shopping_item_id) REFERENCES shopping_items(id) ON DELETE CASCADE,
    FOREIGN KEY (shopping_store_id) REFERENCES shopping_stores(id) ON DELETE CASCADE
);

CREATE INDEX idx_shopping_item_stores_item_order
ON shopping_item_stores(shopping_item_id, sort_order, shopping_store_id);

CREATE TABLE shopping_list_preferences (
    shopping_list_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    selected_store_id INTEGER,
    hide_empty_sections INTEGER NOT NULL DEFAULT 0 CHECK(hide_empty_sections IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (shopping_list_id, user_id),
    FOREIGN KEY (shopping_list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (selected_store_id) REFERENCES shopping_stores(id) ON DELETE SET NULL
);
