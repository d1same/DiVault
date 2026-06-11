<?php

final class Database
{
    private PDO $pdo;

    public function __construct()
    {
        Config::ensureDirs();
        $this->pdo = new PDO('sqlite:' . Config::dir() . '/app.sqlite');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('PRAGMA foreign_keys = ON');
        $this->pdo->exec('PRAGMA journal_mode = WAL');
        $this->pdo->exec('PRAGMA synchronous = NORMAL');
        $this->pdo->exec('PRAGMA busy_timeout = 5000');
        $this->migrate();
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    private function migrate(): void
    {
        $this->pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    passkey_enabled INTEGER NOT NULL DEFAULT 0,
    avatar_data TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    reset_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    section TEXT NOT NULL DEFAULT 'Inbox',
    category TEXT,
    category_id INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL,
    tags TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS asset_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL UNIQUE,
    icon TEXT,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS asset_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Active',
    asset_type TEXT,
    os TEXT,
    primary_ip TEXT,
    serial_number TEXT,
    expires_at TEXT,
    location TEXT,
    contact TEXT,
    username TEXT,
    secret_ciphertext TEXT,
    notes TEXT,
    data_json TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_asset_records_type ON asset_records(type);
CREATE INDEX IF NOT EXISTS idx_asset_records_client ON asset_records(client_id);
CREATE TABLE IF NOT EXISTS note_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS note_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS drive_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES drive_folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    source_path TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS drive_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id INTEGER REFERENCES drive_folders(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    source_path TEXT,
    source_mtime INTEGER,
    mime TEXT,
    size INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS drive_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'view',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(item_type, item_id, user_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    subject_type TEXT,
    subject_id INTEGER,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sync_applied_mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, mutation_id)
);
CREATE TABLE IF NOT EXISTS user_feature_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    settings_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, feature)
);
CREATE TABLE IF NOT EXISTS calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'private',
    timezone TEXT,
    external_source TEXT,
    external_uid TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS calendar_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'read',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(calendar_id, user_id)
);
CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    timezone TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    recurrence_rule TEXT,
    source TEXT,
    import_uid TEXT,
    import_source TEXT,
    import_etag TEXT,
    import_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(calendar_id, import_source, import_uid)
);
CREATE TABLE IF NOT EXISTS calendar_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id INTEGER REFERENCES calendars(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    color TEXT,
    refresh_minutes INTEGER NOT NULL DEFAULT 360,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    last_status TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS calendar_event_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remind_at TEXT NOT NULL,
    offset_minutes INTEGER,
    method TEXT NOT NULL DEFAULT 'in_app',
    sent_at TEXT,
    dismissed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS calendar_event_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, note_id)
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id INTEGER REFERENCES calendars(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 0,
    due_at TEXT,
    completed_at TEXT,
    private INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    import_uid TEXT,
    import_source TEXT,
    import_etag TEXT,
    import_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, import_source, import_uid)
);
CREATE TABLE IF NOT EXISTS task_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remind_at TEXT NOT NULL,
    offset_minutes INTEGER,
    method TEXT NOT NULL DEFAULT 'in_app',
    sent_at TEXT,
    dismissed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS task_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, note_id)
);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SQL);
        $this->addColumnIfMissing('users', 'avatar_data', 'TEXT');
        $this->addColumnIfMissing('notes', 'category_id', 'INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL');
        $this->addColumnIfMissing('asset_categories', 'parent_id', 'INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL');
        $this->addColumnIfMissing('asset_categories', 'icon', 'TEXT');
        $this->addColumnIfMissing('webauthn_credentials', 'last_used_at', 'TEXT');
        $this->addColumnIfMissing('sync_events', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
        $this->addColumnIfMissing('sync_applied_mutations', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
        $this->addColumnIfMissing('tasks', 'location', 'TEXT');
        $this->addColumnIfMissing('calendar_feeds', 'color', 'TEXT');
        $this->addColumnIfMissing('calendar_feeds', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
        $this->addColumnIfMissing('drive_folders', 'source_path', 'TEXT');
        $this->addColumnIfMissing('drive_files', 'source_path', 'TEXT');
        $this->addColumnIfMissing('drive_files', 'source_mtime', 'INTEGER');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_notes_category_id ON notes(category_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_notes_user_state_updated ON notes(user_id, deleted, archived, category_id, pinned, updated_at, id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_notes_deleted_updated ON notes(deleted, updated_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_files_note_user ON files(note_id, user_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_note_secrets_note ON note_secrets(note_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id, id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_asset_categories_parent ON asset_categories(parent_id)');
        $this->pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credentials_credential_id ON webauthn_credentials(credential_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_sync_events_id ON sync_events(id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_sync_events_entity ON sync_events(entity_type, entity_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_sync_applied_mutations_client ON sync_applied_mutations(client_id, mutation_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_user_feature_settings_user ON user_feature_settings(user_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendars_owner ON calendars(owner_user_id, archived)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_feeds_user ON calendar_feeds(user_id, enabled)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendars_external ON calendars(external_source, external_uid)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_shares_user ON calendar_shares(user_id, permission)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar_start ON calendar_events(calendar_id, starts_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_events_import ON calendar_events(import_source, import_uid)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_event_reminders_user_due ON calendar_event_reminders(user_id, remind_at, sent_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_event_reminders_event ON calendar_event_reminders(event_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_calendar_event_notes_note ON calendar_event_notes(note_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due ON tasks(user_id, status, due_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasks_calendar_due ON tasks(calendar_id, due_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasks_import ON tasks(import_source, import_uid)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_task_reminders_user_due ON task_reminders(user_id, remind_at, sent_at)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders(task_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_task_notes_note ON task_notes(note_id)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_drive_folders_owner_parent ON drive_folders(owner_user_id, parent_id, deleted)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_drive_files_owner_folder ON drive_files(owner_user_id, folder_id, deleted)');
        $this->pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_folders_owner_source ON drive_folders(owner_user_id, source_path) WHERE source_path IS NOT NULL');
        $this->pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_files_owner_source ON drive_files(owner_user_id, source_path) WHERE source_path IS NOT NULL');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_drive_shares_user ON drive_shares(user_id, item_type, permission)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_drive_shares_item ON drive_shares(item_type, item_id)');
        $this->ensureNotesFullTextIndex();
    }

    private function addColumnIfMissing(string $table, string $column, string $definition): void
    {
        $stmt = $this->pdo->query('PRAGMA table_info(' . $table . ')');
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (($row['name'] ?? '') === $column) return;
        }
        $this->pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $definition);
    }

    private function ensureNotesFullTextIndex(): void
    {
        try {
            $this->pdo->exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tags, content='notes', content_rowid='id')");
            $this->pdo->exec("CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags); END");
            $this->pdo->exec("CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags); END");
            $this->pdo->exec("CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags); INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags); END");
            $this->pdo->exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')");
        } catch (PDOException) {
            // Some SQLite builds omit FTS5; LIKE search remains available.
        }
    }
}
