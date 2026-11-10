-- Old BrainDump tokens were casefolded without NFKC. Canonicalize their physical
-- identities once, preserving every independent observation and receipt fence.
-- nia_routing_name_key is a deterministic, migration-local Unicode function.
CREATE TEMP TABLE routing_memory_name_merge AS
WITH normalized AS (
    SELECT *, nia_routing_name_key(name_key) AS canonical_name
    FROM routing_memory_entries
), grouped AS (
    SELECT *,
        FIRST_VALUE(id) OVER (
            PARTITION BY user_id,module_id,key_kind,COALESCE(workspace_id,-1),canonical_name,COALESCE(project_id,shopping_list_id)
            ORDER BY CASE WHEN name_key=canonical_name THEN 0 ELSE 1 END,update_sequence DESC,id DESC
        ) AS keeper_id,
        SUM(legacy_hits) OVER same_identity AS total_legacy_hits,
        MAX(list_sequence) OVER same_identity AS latest_list_sequence,
        MAX(update_sequence) OVER same_identity AS latest_update_sequence,
        MAX(list_known) OVER same_identity AS any_list_known,
        MAX(section_known) OVER same_identity AS any_section_known,
        MAX(stores_known) OVER same_identity AS any_stores_known,
        FIRST_VALUE(updated_at) OVER (
            PARTITION BY user_id,module_id,key_kind,COALESCE(workspace_id,-1),canonical_name,COALESCE(project_id,shopping_list_id)
            ORDER BY COALESCE(julianday(updated_at),0) DESC,updated_at DESC,id DESC
        ) AS latest_updated_at,
        FIRST_VALUE(section_id) OVER (
            PARTITION BY user_id,module_id,key_kind,COALESCE(workspace_id,-1),canonical_name,COALESCE(project_id,shopping_list_id)
            ORDER BY section_known DESC,update_sequence DESC,id DESC
        ) AS latest_section_id,
        FIRST_VALUE(task_section_id) OVER (
            PARTITION BY user_id,module_id,key_kind,COALESCE(workspace_id,-1),canonical_name,COALESCE(project_id,shopping_list_id)
            ORDER BY section_known DESC,update_sequence DESC,id DESC
        ) AS latest_task_section_id,
        FIRST_VALUE(store_ids_json) OVER (
            PARTITION BY user_id,module_id,key_kind,COALESCE(workspace_id,-1),canonical_name,COALESCE(project_id,shopping_list_id)
            ORDER BY stores_known DESC,update_sequence DESC,id DESC
        ) AS latest_store_ids_json
    FROM normalized
    WINDOW same_identity AS (
        PARTITION BY user_id,module_id,key_kind,COALESCE(workspace_id,-1),canonical_name,COALESCE(project_id,shopping_list_id)
    )
)
SELECT id,keeper_id,canonical_name,total_legacy_hits,latest_list_sequence,
       latest_update_sequence,latest_updated_at,any_list_known,any_section_known,
       latest_section_id,latest_task_section_id,any_stores_known,latest_store_ids_json
FROM grouped;

-- The same receipt and truly identical payload denote one confirmation. NULL
-- receipts are independent imported/seed observations and are never deduplicated.
DELETE FROM routing_memory_observations WHERE id IN (
    SELECT id FROM (
        SELECT observation.id,
            ROW_NUMBER() OVER (
                PARTITION BY observation.event_id,mapping.keeper_id,observation.field,
                    observation.value_json,observation.weight,observation.support_count,
                    observation.origin,observation.observed_at
                ORDER BY observation.id
            ) AS duplicate_rank
        FROM routing_memory_observations observation
        JOIN routing_memory_name_merge mapping ON mapping.id=observation.entry_id
        WHERE observation.event_id IS NOT NULL
    ) WHERE duplicate_rank>1
);

-- Distinct payloads sharing a receipt remain distinct evidence, including real
-- conflicts. Detach only extra observation links; the original event receipt
-- itself stays intact and still fences retries. This is not a new confirmation.
UPDATE routing_memory_observations SET event_id=NULL WHERE id IN (
    SELECT id FROM (
        SELECT observation.id,
            ROW_NUMBER() OVER (
                PARTITION BY observation.event_id,mapping.keeper_id,observation.field
                ORDER BY observation.id
            ) AS collision_rank
        FROM routing_memory_observations observation
        JOIN routing_memory_name_merge mapping ON mapping.id=observation.entry_id
        WHERE observation.event_id IS NOT NULL
    ) WHERE collision_rank>1
);

UPDATE routing_memory_observations SET entry_id=(
    SELECT keeper_id FROM routing_memory_name_merge
    WHERE routing_memory_name_merge.id=routing_memory_observations.entry_id
);
DELETE FROM routing_memory_entries WHERE id IN (
    SELECT id FROM routing_memory_name_merge WHERE id<>keeper_id
);
UPDATE routing_memory_entries SET
    (name_key,legacy_hits,list_sequence,update_sequence,updated_at,list_known,
     section_known,section_id,task_section_id,stores_known,store_ids_json)=(
        SELECT canonical_name,total_legacy_hits,latest_list_sequence,
            latest_update_sequence,latest_updated_at,any_list_known,
            any_section_known,latest_section_id,latest_task_section_id,
            any_stores_known,latest_store_ids_json
        FROM routing_memory_name_merge WHERE routing_memory_name_merge.id=routing_memory_entries.id
    );
DROP TABLE routing_memory_name_merge;

-- Complete competition and focused recall look up selected names across targets,
-- independently of workspace. The generic unique identity index is not a prefix
-- index for that access pattern because its workspace expression comes first.
CREATE INDEX idx_routing_memory_lookup_name
    ON routing_memory_entries(user_id,module_id,name_key,key_kind);
