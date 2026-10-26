-- Migration 058: Household ownership and shared entity access.

CREATE TABLE IF NOT EXISTS households (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
    owner_user_id INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS household_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    invited_by_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'accepted', 'declined', 'left', 'removed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(household_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_household_members_active_user
ON household_members(user_id)
WHERE status IN ('pending', 'accepted');

CREATE INDEX IF NOT EXISTS idx_household_members_household_status
ON household_members(household_id, status, user_id);

CREATE TRIGGER IF NOT EXISTS households_reject_member_owner_insert
BEFORE INSERT ON households
WHEN EXISTS (
    SELECT 1 FROM household_members hm
    WHERE hm.user_id = NEW.owner_user_id AND hm.status IN ('pending', 'accepted')
)
BEGIN
    SELECT RAISE(ABORT, 'user already belongs to a household');
END;

CREATE TRIGGER IF NOT EXISTS households_reject_member_owner_update
BEFORE UPDATE OF owner_user_id ON households
WHEN EXISTS (
    SELECT 1 FROM household_members hm
    WHERE hm.user_id = NEW.owner_user_id AND hm.status IN ('pending', 'accepted')
)
BEGIN
    SELECT RAISE(ABORT, 'user already belongs to a household');
END;

CREATE TRIGGER IF NOT EXISTS household_members_reject_owner_insert
BEFORE INSERT ON household_members
WHEN NEW.status IN ('pending', 'accepted')
 AND EXISTS (
    SELECT 1 FROM households h
    WHERE h.owner_user_id = NEW.user_id
 )
BEGIN
    SELECT RAISE(ABORT, 'user already owns a household');
END;

CREATE TRIGGER IF NOT EXISTS household_members_reject_owner_update
BEFORE UPDATE OF user_id, status ON household_members
WHEN NEW.status IN ('pending', 'accepted')
 AND EXISTS (
    SELECT 1 FROM households h
    WHERE h.owner_user_id = NEW.user_id
 )
BEGIN
    SELECT RAISE(ABORT, 'user already owns a household');
END;

CREATE TABLE IF NOT EXISTS entity_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 64),
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

CREATE INDEX IF NOT EXISTS idx_entity_access_user_owner
ON entity_access(owner_user_id, entity_type)
WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_access_household_owner
ON entity_access(owner_household_id, entity_type)
WHERE owner_household_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entity_access_grants (
    entity_access_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    granted_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (entity_access_id, user_id),
    FOREIGN KEY (entity_access_id) REFERENCES entity_access(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_access_grants_user
ON entity_access_grants(user_id, entity_access_id);

CREATE TRIGGER IF NOT EXISTS entity_access_grants_require_manager_insert
BEFORE INSERT ON entity_access_grants
WHEN NOT EXISTS (
    SELECT 1
    FROM entity_access ea
    LEFT JOIN households h ON h.id = ea.owner_household_id
    WHERE ea.id = NEW.entity_access_id
      AND COALESCE(ea.owner_user_id, h.owner_user_id) = NEW.granted_by_user_id
)
BEGIN
    SELECT RAISE(ABORT, 'only the entity manager can grant access');
END;

CREATE TRIGGER IF NOT EXISTS entity_access_grants_require_manager_update
BEFORE UPDATE OF entity_access_id, granted_by_user_id ON entity_access_grants
WHEN (NEW.granted_by_user_id IS NULL AND NEW.entity_access_id != OLD.entity_access_id)
   OR (
       NEW.granted_by_user_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM entity_access ea
           LEFT JOIN households h ON h.id = ea.owner_household_id
           WHERE ea.id = NEW.entity_access_id
             AND COALESCE(ea.owner_user_id, h.owner_user_id) = NEW.granted_by_user_id
       )
   )
BEGIN
    SELECT RAISE(ABORT, 'only the entity manager can grant access');
END;

-- Existing projects remain personal. This is a technical ownership backfill,
-- not a transfer into a household.
INSERT OR IGNORE INTO entity_access (entity_type, entity_id, owner_user_id, updated_at)
SELECT 'project', p.id, p.user_id, datetime('now')
FROM projects p
WHERE p.user_id IS NOT NULL;
