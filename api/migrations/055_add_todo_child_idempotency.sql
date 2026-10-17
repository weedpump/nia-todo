ALTER TABLE todo_subtasks ADD COLUMN client_mutation_id TEXT;
ALTER TABLE todo_comments ADD COLUMN client_mutation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_subtasks_client_mutation
    ON todo_subtasks(todo_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_comments_client_mutation
    ON todo_comments(todo_id, user_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;
