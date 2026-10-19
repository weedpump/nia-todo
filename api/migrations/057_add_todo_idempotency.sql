-- Make retried offline todo creates idempotent within the creating user scope.

ALTER TABLE todos ADD COLUMN client_mutation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_client_mutation
    ON todos(user_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;
