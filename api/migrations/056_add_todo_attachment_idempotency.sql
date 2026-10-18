-- Make retried offline attachment uploads idempotent per user and todo.

ALTER TABLE todo_attachments ADD COLUMN client_mutation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_attachments_client_mutation
    ON todo_attachments(todo_id, user_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;
