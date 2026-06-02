"""nia-todo: SQLite Migrations-System

Migrationen werden als nummerierte .sql Dateien in migrations/ gespeichert.
Beim Server-Start wird automatisch geprüft welche fehlen und ausgeführt.
"""

import sqlite3
import re
from pathlib import Path

from paths import DB_PATH

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

def get_db_version(conn):
    """Holt aktuelle Schema-Version aus der DB."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    if not cursor.fetchone():
        return 0
    cursor = conn.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    row = cursor.fetchone()
    return row[0] if row else 0

def set_db_version(conn, version):
    """Setzt Schema-Version in der DB."""
    # SQLite kann nicht OR REPLACE mit PRIMARY KEY ohne ID
    # Lösche alte Versionen und füge neue ein
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))", (version,))
    conn.commit()

def table_exists(conn, table: str) -> bool:
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    return cursor.fetchone() is not None


def column_exists(conn, table: str, column: str) -> bool:
    return any(row[1] == column for row in conn.execute(f"PRAGMA table_info({table})").fetchall())


def add_column_if_missing(conn, table: str, column: str, definition: str):
    if not column_exists(conn, table, column):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def repair_two_factor_migration(conn):
    """Make migration 024 idempotent for partially-applied 2FA schema."""
    conn.execute("INSERT OR IGNORE INTO app_config (key, value) VALUES ('two_factor_required', 'false')")
    for column, definition in (
        ("two_factor_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("two_factor_totp_secret", "TEXT"),
        ("two_factor_recovery_hashes", "TEXT"),
        ("two_factor_recovery_generated_at", "TEXT"),
        ("two_factor_remember_version", "INTEGER NOT NULL DEFAULT 1"),
        ("two_factor_updated_at", "TEXT"),
    ):
        add_column_if_missing(conn, "users", column, definition)
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS two_factor_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        methods TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        email_code_hash TEXT,
        email_code_expires_at INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        consumed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_token ON two_factor_challenges(token_hash);
    CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_user ON two_factor_challenges(user_id, consumed_at);
    CREATE TABLE IF NOT EXISTS trusted_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        remember_version INTEGER NOT NULL DEFAULT 1,
        user_agent TEXT,
        expires_at INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_prefix ON trusted_devices(user_id, token_prefix);
    CREATE TABLE IF NOT EXISTS passkeys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT 'Passkey',
        transports TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id, revoked_at);
    CREATE TABLE IF NOT EXISTS passkey_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        challenge_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication')),
        expires_at INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        consumed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user ON passkey_challenges(user_id, purpose, consumed_at);
    ''')
    conn.commit()


def repair_two_factor_hardening_migration(conn):
    add_column_if_missing(conn, "two_factor_challenges", "attempts", "INTEGER NOT NULL DEFAULT 0")
    add_column_if_missing(conn, "two_factor_challenges", "locked_until", "INTEGER")
    conn.commit()



def repair_todo_pins_migration(conn):
    if not table_exists(conn, "todos"):
        conn.commit()
        return
    add_column_if_missing(conn, "todos", "is_pinned", "INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_pinned ON todos(is_pinned)")
    conn.commit()

def repair_passkey_challenge_hardening_migration(conn):
    add_column_if_missing(conn, "passkey_challenges", "attempts", "INTEGER NOT NULL DEFAULT 0")
    add_column_if_missing(conn, "passkey_challenges", "locked_until", "INTEGER")
    conn.commit()


def repair_workspace_migration(conn):
    """Make migration 016 idempotent for DBs that already have workspace_id.

    SQLite cannot reliably ADD COLUMN IF NOT EXISTS across all supported
    versions. If a previous interrupted run added projects.workspace_id but did
    not finish indexes/default workspaces/inboxes, complete the remaining
    workspace schema here before marking migration 016 as applied.
    """
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#6366f1',
        sort_order INTEGER DEFAULT 0,
        user_id INTEGER NOT NULL,
        is_default INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_name_unique ON workspaces(user_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_default_unique ON workspaces(user_id) WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

    INSERT OR IGNORE INTO workspaces (name, color, sort_order, user_id, is_default, updated_at)
    SELECT 'Personal', '#10b981', 0, u.id, 1, datetime('now')
    FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.user_id = u.id);

    UPDATE projects
    SET workspace_id = (
        SELECT w.id FROM workspaces w
        WHERE w.user_id = projects.user_id AND w.is_default = 1
        ORDER BY w.id LIMIT 1
    )
    WHERE workspace_id IS NULL AND user_id IS NOT NULL;

    DROP INDEX IF EXISTS idx_projects_user_name_unique;
    DROP INDEX IF EXISTS idx_projects_user_workspace_name_unique;
    DROP INDEX IF EXISTS idx_projects_user_inbox_unique;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_workspace_inbox_unique
    ON projects(user_id, workspace_id)
    WHERE is_inbox = 1;

    CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

    INSERT INTO projects (name, color, sort_order, user_id, workspace_id, is_inbox, updated_at)
    SELECT 'Inbox', '#64748b', 0, w.user_id, w.id, 1, datetime('now')
    FROM workspaces w
    WHERE NOT EXISTS (
        SELECT 1 FROM projects p
        WHERE p.user_id = w.user_id
          AND p.workspace_id = w.id
          AND COALESCE(p.is_inbox, 0) = 1
    );
    """)


def repair_icon_migration(conn):
    """Make migration 017 idempotent if one icon column was already added."""
    add_column_if_missing(conn, "projects", "icon", "TEXT")
    add_column_if_missing(conn, "workspaces", "icon", "TEXT")
    conn.execute("""
        UPDATE projects
        SET icon = 'inbox'
        WHERE COALESCE(is_inbox, 0) = 1
          AND (icon IS NULL OR TRIM(icon) = '')
    """)
    conn.execute("""
        UPDATE workspaces
        SET icon = 'home'
        WHERE COALESCE(is_default, 0) = 1
          AND name = 'Personal'
          AND (icon IS NULL OR TRIM(icon) = '')
    """)
    conn.commit()

def repair_email_smtp_migration(conn):
    """Complete migration 021 after a partial/interrupted email schema run."""
    conn.executescript("""
    INSERT OR IGNORE INTO app_config (key, value) VALUES
        ('smtp_enabled', 'false'),
        ('smtp_host', ''),
        ('smtp_port', '587'),
        ('smtp_security', 'starttls'),
        ('smtp_auth_enabled', 'false'),
        ('smtp_username', ''),
        ('smtp_password_secret', ''),
        ('mail_from_address', ''),
        ('mail_from_name', 'nia-todo'),
        ('mail_reply_to', ''),
        ('password_link_ttl_hours', '24');
    """)
    add_column_if_missing(conn, "users", "email_verified_at", "TEXT")
    add_column_if_missing(conn, "users", "pending_email", "TEXT")
    add_column_if_missing(conn, "users", "pending_email_token_hash", "TEXT")
    add_column_if_missing(conn, "users", "pending_email_token_prefix", "TEXT")
    add_column_if_missing(conn, "users", "pending_email_token_expires_at", "TEXT")
    add_column_if_missing(conn, "users", "email_changed_at", "TEXT")
    conn.executescript("""
    UPDATE users
    SET email_verified_at = COALESCE(email_verified_at, datetime('now'))
    WHERE email IS NOT NULL
      AND TRIM(email) != ''
      AND password_hash IS NOT NULL
      AND TRIM(password_hash) != '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pending_email_unique
    ON users(pending_email)
    WHERE pending_email IS NOT NULL AND pending_email != '';

    CREATE INDEX IF NOT EXISTS idx_users_pending_email_token_prefix
    ON users(pending_email_token_prefix)
    WHERE pending_email_token_prefix IS NOT NULL AND pending_email_token_prefix != '';
    """)
    add_column_if_missing(conn, "password_setup_tokens", "status", "TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'used', 'replaced'))")
    add_column_if_missing(conn, "password_setup_tokens", "replaced_at", "TEXT")
    add_column_if_missing(conn, "password_setup_tokens", "requested_by", "TEXT NOT NULL DEFAULT 'admin' CHECK(requested_by IN ('admin', 'user', 'system'))")
    conn.executescript("""
    UPDATE password_setup_tokens
    SET status = 'used'
    WHERE used_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_purpose_status
    ON password_setup_tokens(user_id, purpose, status);
    """)
    conn.commit()


def repair_email_trust_source_migration(conn):
    """Complete migration 023 after email_trust_source was partly added."""
    add_column_if_missing(conn, "users", "email_trust_source", "TEXT")
    conn.executescript("""
    UPDATE users
    SET email_trust_source = 'legacy_verified'
    WHERE email_verified_at IS NOT NULL
      AND email IS NOT NULL
      AND trim(email) != ''
      AND email_trust_source IS NULL;

    CREATE INDEX IF NOT EXISTS idx_users_email_trust_source
    ON users(email_trust_source)
    WHERE email_trust_source IS NOT NULL AND email_trust_source != '';
    """)
    conn.commit()


def repair_shared_project_display_workspace_migration(conn):
    """Complete migration 030 after partial schemas or already-added columns."""
    if not table_exists(conn, "project_members"):
        # Partial-recovery fixtures may start after the sharing migration without
        # recreating sharing tables. Real migrated DBs keep project_members from
        # migration 011, so there is nothing to alter in this synthetic state.
        conn.commit()
        return
    add_column_if_missing(conn, "project_members", "workspace_id", "INTEGER")
    conn.executescript("""
    UPDATE project_members
    SET workspace_id = (
        SELECT w.id
        FROM workspaces w
        WHERE w.user_id = project_members.user_id
          AND COALESCE(w.is_default, 0) = 1
        ORDER BY w.id
        LIMIT 1
    )
    WHERE workspace_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_project_members_workspace ON project_members(workspace_id);
    """)
    conn.commit()



def repair_todo_recurrence_columns_migration(conn):
    """Make migration 041 idempotent for databases missing recurrence columns."""
    if not table_exists(conn, "todos"):
        conn.commit()
        return
    add_column_if_missing(conn, "todos", "recurring_rule", "TEXT")
    add_column_if_missing(conn, "todos", "parent_id", "INTEGER")
    conn.commit()


def get_migration_files():
    """Holt alle Migrations-Dateien sortiert nach Nummer."""
    if not MIGRATIONS_DIR.exists():
        return []
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    migrations = []
    for f in files:
        match = re.match(r"^(\d+)_.*\.sql$", f.name)
        if match:
            migrations.append((int(match.group(1)), f))
    migrations.sort(key=lambda x: x[0])
    return migrations

def init_migrations_table(conn):
    """Erstellt schema_version Tabelle falls nicht existiert."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()

def run_migrations():
    """Führt alle ausstehenden Migrationen aus."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    
    init_migrations_table(conn)
    current_version = get_db_version(conn)
    migrations = get_migration_files()
    
    if not migrations:
        conn.close()
        return current_version
    
    applied = 0
    for version, filepath in migrations:
        if version > current_version:
            print(f"[MIGRATION] Applying {filepath.name} (version {version})...")
            sql = filepath.read_text()
            
            try:
                conn.executescript(sql)
                set_db_version(conn, version)
                applied += 1
                print(f"[MIGRATION] ✅ {filepath.name} applied successfully")
            except sqlite3.OperationalError as e:
                error_msg = str(e).lower()
                if version == 16 and "duplicate column" in error_msg and column_exists(conn, "projects", "workspace_id"):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - workspace_id exists, repairing remaining workspace schema")
                    repair_workspace_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 17 and "duplicate column" in error_msg:
                    print(f"[MIGRATION] ⚠️ {filepath.name} - icon column exists, repairing remaining icon schema")
                    repair_icon_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 21 and ("duplicate column" in error_msg or "already exists" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - email schema partially exists, repairing remaining email schema")
                    repair_email_smtp_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 23 and ("duplicate column" in error_msg or "already exists" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - email trust source partially exists, repairing remaining schema")
                    repair_email_trust_source_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 24 and ("duplicate column" in error_msg or "already exists" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - 2FA schema partially exists, repairing remaining schema")
                    repair_two_factor_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 25 and ("duplicate column" in error_msg or "already exists" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - 2FA hardening partially exists, repairing remaining schema")
                    repair_two_factor_hardening_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 26 and ("duplicate column" in error_msg or "already exists" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - passkey challenge hardening partially exists, repairing remaining schema")
                    repair_passkey_challenge_hardening_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 30 and ("duplicate column" in error_msg or "already exists" in error_msg or "no such table: project_members" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - shared project display workspace schema partially exists, repairing remaining schema")
                    repair_shared_project_display_workspace_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 37 and ("duplicate column" in error_msg or "already exists" in error_msg or "no such table: todos" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - todo pins schema partially exists or todos table is absent, repairing remaining schema")
                    repair_todo_pins_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 41 and ("duplicate column" in error_msg or "already exists" in error_msg or "no such table: todos" in error_msg):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - todo recurrence columns partially exist, repairing remaining schema")
                    repair_todo_recurrence_columns_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif "duplicate column" in error_msg or "already exists" in error_msg:
                    print(f"[MIGRATION] ⚠️ {filepath.name} - parts already applied, marking as done")
                    set_db_version(conn, version)
                    applied += 1
                else:
                    print(f"[MIGRATION] ❌ Failed: {e}")
                    conn.close()
                    raise
            except sqlite3.Error as e:
                print(f"[MIGRATION] ❌ Failed: {e}")
                conn.close()
                raise
    
    conn.close()
    
    if applied > 0:
        print(f"[MIGRATION] {applied} migration(s) applied. DB now at version {version}")
    else:
        print(f"[MIGRATION] DB up to date (version {current_version})")
    
    return version if migrations else current_version

if __name__ == "__main__":
    run_migrations()
