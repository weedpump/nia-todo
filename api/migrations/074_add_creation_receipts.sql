-- Keep create identities after content deletion. IDs and mutation identities
-- are sufficient; never retain content or previous authorization snapshots.
CREATE TABLE creation_receipts (
    entity_type TEXT NOT NULL CHECK(entity_type IN ('todo','shopping_list','shopping_section','shopping_store','shopping_item')),
    scope_id INTEGER NOT NULL CHECK(scope_id > 0),
    client_mutation_id TEXT NOT NULL CHECK(client_mutation_id != ''),
    entity_id INTEGER NOT NULL CHECK(entity_id > 0),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(entity_type, scope_id, client_mutation_id),
    CHECK((entity_type IN ('todo','shopping_list') AND actor_user_id IS NOT NULL AND actor_user_id = scope_id)
       OR (entity_type IN ('shopping_section','shopping_store','shopping_item') AND actor_user_id IS NULL))
);

INSERT INTO creation_receipts
    SELECT 'todo',client_mutation_user_id,client_mutation_id,id,client_mutation_user_id FROM todos
    WHERE client_mutation_user_id IS NOT NULL AND client_mutation_id != '';
INSERT INTO creation_receipts
    SELECT 'shopping_list',created_by_user_id,client_mutation_id,id,created_by_user_id FROM shopping_lists
    WHERE created_by_user_id IS NOT NULL AND client_mutation_id != '';
INSERT INTO creation_receipts
    SELECT 'shopping_section',shopping_list_id,client_mutation_id,id,NULL FROM shopping_sections
    WHERE client_mutation_id != '';
INSERT INTO creation_receipts
    SELECT 'shopping_store',shopping_list_id,client_mutation_id,id,NULL FROM shopping_stores
    WHERE client_mutation_id != '';
INSERT INTO creation_receipts
    SELECT 'shopping_item',shopping_list_id,client_mutation_id,id,NULL FROM shopping_items
    WHERE client_mutation_id != '';

CREATE TRIGGER todos_creation_receipt AFTER INSERT ON todos
WHEN NEW.client_mutation_user_id IS NOT NULL AND NEW.client_mutation_id != ''
BEGIN
    INSERT INTO creation_receipts VALUES ('todo',NEW.client_mutation_user_id,NEW.client_mutation_id,NEW.id,NEW.client_mutation_user_id);
END;
CREATE TRIGGER shopping_lists_creation_receipt AFTER INSERT ON shopping_lists
WHEN NEW.created_by_user_id IS NOT NULL AND NEW.client_mutation_id != ''
BEGIN
    INSERT INTO creation_receipts VALUES ('shopping_list',NEW.created_by_user_id,NEW.client_mutation_id,NEW.id,NEW.created_by_user_id);
END;
CREATE TRIGGER shopping_sections_creation_receipt AFTER INSERT ON shopping_sections
WHEN NEW.client_mutation_id != ''
BEGIN
    INSERT INTO creation_receipts VALUES ('shopping_section',NEW.shopping_list_id,NEW.client_mutation_id,NEW.id,NULL);
END;
CREATE TRIGGER shopping_stores_creation_receipt AFTER INSERT ON shopping_stores
WHEN NEW.client_mutation_id != ''
BEGIN
    INSERT INTO creation_receipts VALUES ('shopping_store',NEW.shopping_list_id,NEW.client_mutation_id,NEW.id,NULL);
END;
CREATE TRIGGER shopping_items_creation_receipt AFTER INSERT ON shopping_items
WHEN NEW.client_mutation_id != ''
BEGIN
    INSERT INTO creation_receipts VALUES ('shopping_item',NEW.shopping_list_id,NEW.client_mutation_id,NEW.id,NULL);
END;
