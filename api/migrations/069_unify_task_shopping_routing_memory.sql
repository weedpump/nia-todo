-- One typed evidence store. Token counters are imported as token evidence;
-- identical Tasks counters mirrored in 039/060 use MAX, never double-counted.
DROP TRIGGER routing_memory_forget_deleted_section;
ALTER TABLE routing_memory_observations RENAME TO routing_memory_observations_068;
ALTER TABLE routing_memory_entries RENAME TO routing_memory_entries_068;

CREATE TABLE routing_memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL DEFAULT 'shopping' CHECK(module_id IN ('tasks','shopping')),
    key_kind TEXT NOT NULL DEFAULT 'exact' CHECK(key_kind IN ('exact','token')),
    workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
    name_key TEXT NOT NULL,
    shopping_list_id INTEGER REFERENCES shopping_lists(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    list_known INTEGER NOT NULL DEFAULT 0 CHECK(list_known IN (0,1)),
    section_id INTEGER REFERENCES shopping_sections(id) ON DELETE SET NULL,
    task_section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
    section_known INTEGER NOT NULL DEFAULT 0 CHECK(section_known IN (0,1)),
    store_ids_json TEXT NOT NULL DEFAULT '[]',
    stores_known INTEGER NOT NULL DEFAULT 0 CHECK(stores_known IN (0,1)),
    list_sequence INTEGER NOT NULL DEFAULT 0,
    update_sequence INTEGER NOT NULL DEFAULT 0,
    legacy_hits INTEGER NOT NULL DEFAULT 0 CHECK(legacy_hits >= 0),
    updated_at TEXT NOT NULL,
    CHECK((module_id='shopping' AND shopping_list_id IS NOT NULL AND project_id IS NULL AND task_section_id IS NULL AND workspace_id IS NULL)
       OR (module_id='tasks' AND project_id IS NOT NULL AND shopping_list_id IS NULL AND section_id IS NULL AND stores_known=0))
);
CREATE UNIQUE INDEX idx_routing_memory_generic_target ON routing_memory_entries(
    user_id,module_id,COALESCE(workspace_id,-1),key_kind,name_key,COALESCE(project_id,shopping_list_id));
CREATE INDEX idx_routing_memory_generic_user_order ON routing_memory_entries(user_id,module_id,list_sequence DESC,update_sequence DESC);
CREATE TABLE routing_memory_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL REFERENCES routing_memory_entries(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES routing_memory_events(id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK(field IN ('module','list','section','stores')),
    value_json TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1 CHECK(weight IN (1,3)),
    support_count INTEGER NOT NULL DEFAULT 1 CHECK(support_count > 0),
    origin TEXT NOT NULL DEFAULT 'explicit' CHECK(origin IN ('explicit','legacy')),
    observed_at TEXT NOT NULL,
    UNIQUE(event_id,entry_id,field)
);
CREATE INDEX idx_routing_observations_generic_user_entry_field ON routing_memory_observations(user_id,entry_id,field,id DESC);

INSERT INTO routing_memory_entries(id,user_id,name_key,shopping_list_id,list_known,section_id,section_known,store_ids_json,stores_known,list_sequence,update_sequence,updated_at)
 SELECT id,user_id,name_key,shopping_list_id,list_known,section_id,section_known,store_ids_json,stores_known,list_sequence,update_sequence,updated_at
 FROM routing_memory_entries_068;
INSERT INTO routing_memory_observations(id,user_id,entry_id,event_id,field,value_json,weight,observed_at)
 SELECT id,user_id,entry_id,event_id,field,value_json,weight,observed_at FROM routing_memory_observations_068;
INSERT INTO routing_memory_observations(user_id,entry_id,event_id,field,value_json,observed_at)
 SELECT user_id,entry_id,event_id,'module','"shopping"',observed_at FROM routing_memory_observations_068 WHERE field='list' ORDER BY id;

CREATE TEMP TABLE routing_memory_legacy_import AS
WITH combined AS (
   SELECT user_id,workspace_id,token,'tasks' AS module_id,project_id,section_id AS task_section_id,
          NULL AS shopping_list_id,NULL AS shopping_section_id,NULL AS shopping_store_id,hits,last_used_at
   FROM braindump_route_learning
   UNION ALL
   SELECT user_id,workspace_id,token,module_id,project_id,task_section_id,shopping_list_id,shopping_section_id,shopping_store_id,hits,last_used_at
   FROM braindump_module_route_learning
), ranked AS (
   SELECT combined.*,
     MAX(hits) OVER (PARTITION BY user_id,workspace_id,token,module_id,project_id,task_section_id,shopping_list_id,shopping_section_id,shopping_store_id) AS merged_hits,
     ROW_NUMBER() OVER (PARTITION BY user_id,workspace_id,token,module_id,project_id,task_section_id,shopping_list_id,shopping_section_id,shopping_store_id
       ORDER BY COALESCE(julianday(last_used_at),0) DESC,last_used_at DESC,hits DESC) AS duplicate_rank
   FROM combined
)
SELECT user_id,workspace_id,token,module_id,project_id,task_section_id,shopping_list_id,shopping_section_id,shopping_store_id,merged_hits AS hits,last_used_at FROM ranked WHERE duplicate_rank=1;
INSERT INTO routing_memory_entries(user_id,module_id,key_kind,workspace_id,name_key,shopping_list_id,project_id,list_known,section_id,task_section_id,section_known,store_ids_json,stores_known,legacy_hits,updated_at)
 SELECT user_id,module_id,'token',workspace_id,token,shopping_list_id,project_id,1,shopping_section_id,task_section_id,1,
        CASE WHEN shopping_store_id IS NULL THEN '[]' ELSE '['||shopping_store_id||']' END,
        CASE WHEN shopping_store_id IS NULL THEN 0 ELSE 1 END,total_hits,last_used_at
 FROM (
   SELECT source.*,
     SUM(hits) OVER (PARTITION BY user_id,module_id,workspace_id,token,project_id,shopping_list_id) AS total_hits,
     ROW_NUMBER() OVER (PARTITION BY user_id,module_id,workspace_id,token,project_id,shopping_list_id ORDER BY COALESCE(julianday(last_used_at),0) DESC,last_used_at DESC,hits DESC,COALESCE(task_section_id,shopping_section_id,-1)) AS rank
   FROM routing_memory_legacy_import source
 ) WHERE rank=1;

INSERT INTO routing_memory_observations(user_id,entry_id,field,value_json,support_count,origin,observed_at)
 SELECT source.user_id,entry.id,'list',CAST(COALESCE(source.project_id,source.shopping_list_id) AS TEXT),source.hits,'legacy',source.last_used_at
 FROM routing_memory_legacy_import source JOIN routing_memory_entries entry
 ON entry.user_id=source.user_id AND entry.module_id=source.module_id AND entry.key_kind='token'
 AND entry.workspace_id IS source.workspace_id AND entry.name_key=source.token
 AND entry.project_id IS source.project_id AND entry.shopping_list_id IS source.shopping_list_id
 ORDER BY COALESCE(julianday(source.last_used_at),0),source.last_used_at,source.user_id,source.module_id,COALESCE(source.workspace_id,-1),source.token,COALESCE(source.project_id,source.shopping_list_id),COALESCE(source.task_section_id,source.shopping_section_id,-1),COALESCE(source.shopping_store_id,-1);
INSERT INTO routing_memory_observations(user_id,entry_id,field,value_json,support_count,origin,observed_at)
 SELECT source.user_id,entry.id,'module','"'||source.module_id||'"',source.hits,'legacy',source.last_used_at
 FROM routing_memory_legacy_import source JOIN routing_memory_entries entry
 ON entry.user_id=source.user_id AND entry.module_id=source.module_id AND entry.key_kind='token'
 AND entry.workspace_id IS source.workspace_id AND entry.name_key=source.token
 AND entry.project_id IS source.project_id AND entry.shopping_list_id IS source.shopping_list_id
 ORDER BY COALESCE(julianday(source.last_used_at),0),source.last_used_at,source.user_id,source.module_id,COALESCE(source.workspace_id,-1),source.token,COALESCE(source.project_id,source.shopping_list_id),COALESCE(source.task_section_id,source.shopping_section_id,-1),COALESCE(source.shopping_store_id,-1);
INSERT INTO routing_memory_observations(user_id,entry_id,field,value_json,support_count,origin,observed_at)
 SELECT source.user_id,entry.id,'section',
        CASE WHEN COALESCE(source.task_section_id,source.shopping_section_id) IS NULL THEN 'null'
             ELSE CAST(COALESCE(source.task_section_id,source.shopping_section_id) AS TEXT) END,
        source.hits,'legacy',source.last_used_at
 FROM routing_memory_legacy_import source JOIN routing_memory_entries entry
 ON entry.user_id=source.user_id AND entry.module_id=source.module_id AND entry.key_kind='token'
 AND entry.workspace_id IS source.workspace_id AND entry.name_key=source.token
 AND entry.project_id IS source.project_id AND entry.shopping_list_id IS source.shopping_list_id
 ORDER BY COALESCE(julianday(source.last_used_at),0),source.last_used_at,source.user_id,source.module_id,COALESCE(source.workspace_id,-1),source.token,COALESCE(source.project_id,source.shopping_list_id),COALESCE(source.task_section_id,source.shopping_section_id,-1),COALESCE(source.shopping_store_id,-1);
INSERT INTO routing_memory_observations(user_id,entry_id,field,value_json,support_count,origin,observed_at)
 SELECT source.user_id,entry.id,'stores','['||source.shopping_store_id||']',source.hits,'legacy',source.last_used_at
 FROM routing_memory_legacy_import source JOIN routing_memory_entries entry
 ON entry.user_id=source.user_id AND entry.module_id='shopping' AND entry.key_kind='token'
 AND entry.name_key=source.token AND entry.shopping_list_id=source.shopping_list_id
 WHERE source.shopping_store_id IS NOT NULL
 ORDER BY COALESCE(julianday(source.last_used_at),0),source.last_used_at,source.user_id,source.module_id,COALESCE(source.workspace_id,-1),source.token,COALESCE(source.project_id,source.shopping_list_id),COALESCE(source.task_section_id,source.shopping_section_id,-1),COALESCE(source.shopping_store_id,-1);

DROP TABLE routing_memory_legacy_import;
DROP TABLE routing_memory_observations_068;
DROP TABLE routing_memory_entries_068;
DROP TABLE braindump_route_learning;
DROP TABLE braindump_module_route_learning;

CREATE TRIGGER routing_memory_forget_deleted_section BEFORE DELETE ON shopping_sections BEGIN
 UPDATE routing_memory_entries SET section_known=0,section_id=NULL WHERE section_id=OLD.id AND module_id='shopping';
END;
CREATE TRIGGER routing_memory_forget_deleted_task_section BEFORE DELETE ON sections BEGIN
 UPDATE routing_memory_entries SET section_known=0,task_section_id=NULL WHERE task_section_id=OLD.id AND module_id='tasks';
END;
