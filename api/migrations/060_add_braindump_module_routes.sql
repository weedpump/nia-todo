-- Keep existing task route learning intact; typed routes use their real domain IDs.
ALTER TABLE todos ADD COLUMN client_mutation_id TEXT;
ALTER TABLE todos ADD COLUMN client_mutation_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_todos_user_client_mutation
ON todos(client_mutation_user_id, client_mutation_id)
WHERE client_mutation_id IS NOT NULL;

CREATE TABLE braindump_module_route_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    module_id TEXT NOT NULL CHECK(module_id IN ('tasks', 'shopping')),
    workspace_id INTEGER,
    project_id INTEGER,
    task_section_id INTEGER,
    shopping_list_id INTEGER,
    shopping_section_id INTEGER,
    shopping_store_id INTEGER,
    hits INTEGER NOT NULL DEFAULT 1 CHECK(hits > 0),
    last_used_at TEXT NOT NULL,
    CHECK (
        (module_id = 'tasks' AND project_id IS NOT NULL AND shopping_list_id IS NULL AND shopping_section_id IS NULL AND shopping_store_id IS NULL)
        OR (module_id = 'shopping' AND shopping_list_id IS NOT NULL AND workspace_id IS NULL AND project_id IS NULL AND task_section_id IS NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (task_section_id) REFERENCES sections(id) ON DELETE CASCADE,
    FOREIGN KEY (shopping_list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (shopping_section_id) REFERENCES shopping_sections(id) ON DELETE CASCADE,
    FOREIGN KEY (shopping_store_id) REFERENCES shopping_stores(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_braindump_module_route_unique
ON braindump_module_route_learning(
    user_id, token, module_id, COALESCE(workspace_id, -1), COALESCE(project_id, -1),
    COALESCE(task_section_id, -1), COALESCE(shopping_list_id, -1),
    COALESCE(shopping_section_id, -1), COALESCE(shopping_store_id, -1)
);

CREATE INDEX idx_braindump_module_route_user_token
ON braindump_module_route_learning(user_id, token, workspace_id);
