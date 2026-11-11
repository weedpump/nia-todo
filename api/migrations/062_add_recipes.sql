CREATE TABLE recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cookbook_id INTEGER NOT NULL REFERENCES cookbooks(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 4000),
    base_servings REAL NOT NULL DEFAULT 1 CHECK(base_servings > 0 AND base_servings <= 100000),
    prep_minutes INTEGER CHECK(prep_minutes IS NULL OR prep_minutes BETWEEN 0 AND 100000),
    cook_minutes INTEGER CHECK(cook_minutes IS NULL OR cook_minutes BETWEEN 0 AND 100000),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    client_mutation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recipes_cookbook ON recipes(cookbook_id, id);
CREATE UNIQUE INDEX idx_recipes_create_mutation ON recipes(created_by_user_id, client_mutation_id);

CREATE TABLE recipe_ingredient_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 1 AND 200),
    name TEXT NOT NULL DEFAULT '' CHECK(length(name) <= 200),
    sort_order INTEGER NOT NULL,
    UNIQUE(recipe_id, client_key),
    UNIQUE(id, recipe_id)
);
CREATE TABLE recipe_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL,
    client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 1 AND 200),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 500),
    quantity_value REAL CHECK(quantity_value IS NULL OR quantity_value > 0),
    quantity_unit TEXT,
    quantity_text TEXT,
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    CHECK(quantity_value IS NULL OR quantity_text IS NULL OR length(trim(quantity_text)) = 0),
    UNIQUE(recipe_id, client_key),
    FOREIGN KEY(group_id, recipe_id) REFERENCES recipe_ingredient_groups(id, recipe_id) ON DELETE CASCADE
);
CREATE INDEX idx_recipe_ingredients_group ON recipe_ingredients(group_id, sort_order, id);
CREATE TABLE recipe_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 1 AND 200),
    text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 8000),
    sort_order INTEGER NOT NULL,
    UNIQUE(recipe_id, client_key)
);
CREATE TABLE recipe_tags (
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
    name_key TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY(recipe_id, name_key)
);
CREATE TABLE recipe_images (
    recipe_id INTEGER PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    content BLOB NOT NULL,
    media_type TEXT NOT NULL
);
CREATE TABLE recipe_mutation_receipts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_mutation_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
    recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    target_recipe_id INTEGER NOT NULL,
    cookbook_id INTEGER REFERENCES cookbooks(id) ON DELETE SET NULL,
    applied_revision INTEGER NOT NULL CHECK(applied_revision > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, client_mutation_id)
);
