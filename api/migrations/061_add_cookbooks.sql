-- Cookbook ownership uses the existing generic access boundary.
-- Applied with foreign keys disabled outside the atomic migration transaction;
-- the runner restores all existing access indexes/triggers and validates FKs.
CREATE TABLE entity_access_cookbooks_upgrade (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('project', 'shopping_list', 'cookbook')),
    entity_id INTEGER NOT NULL CHECK(entity_id > 0),
    owner_user_id INTEGER,
    owner_household_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id),
    FOREIGN KEY (owner_household_id) REFERENCES households(id),
    CHECK((owner_user_id IS NOT NULL) != (owner_household_id IS NOT NULL)),
    UNIQUE(entity_type, entity_id)
);
INSERT INTO entity_access_cookbooks_upgrade
    SELECT id, entity_type, entity_id, owner_user_id, owner_household_id, created_at, updated_at
    FROM entity_access;
DROP TABLE entity_access;
ALTER TABLE entity_access_cookbooks_upgrade RENAME TO entity_access;

CREATE TABLE cookbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 4000),
    color TEXT NOT NULL DEFAULT '#6366f1',
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    client_mutation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_cookbooks_client_mutation
    ON cookbooks(created_by_user_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;
CREATE INDEX idx_cookbooks_order ON cookbooks(sort_order, id);

-- Keep the actor's creation receipt after deletion: a delayed offline retry
-- must acknowledge absence instead of recreating an owner-deleted cookbook.
CREATE TABLE cookbook_creation_receipts (
    user_id INTEGER NOT NULL,
    client_mutation_id TEXT NOT NULL,
    cookbook_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, client_mutation_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (cookbook_id) REFERENCES cookbooks(id) ON DELETE SET NULL
);
