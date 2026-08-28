#![cfg_attr(not(test), allow(dead_code))]
// ABOUTME: Picot application metadata database (workspaces registry,
// paired devices, global preferences). Single-writer store shared by
// RemoteAuth and broker controls behind one Arc<Mutex<MetadataStore>>.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

// HISTORY: v1 introduced workspaces/paired_devices/preferences. Other
// branches may carry a v2 with extra tables; v3 adds sidebar-registry
// columns to workspaces. Migrations must stay strictly additive so any
// branch's DB survives opening here (see ARCHITECTURE.md persistence).
const SCHEMA_VERSION: i64 = 3;

/// A registered workspace row as exposed to the frontend (camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub workspace_id: String,
    pub canonical_path: String,
    pub display_name: Option<String>,
    pub pinned: bool,
    pub last_opened_at: Option<i64>,
}

/// A registry row removed by automatic prune because its directory vanished.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorkspace {
    pub workspace_id: String,
    pub canonical_path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AddWorkspaceError {
    PathNotFound(String),
    NotADirectory(String),
    Db(String),
}

impl AddWorkspaceError {
    /// Stable machine-readable code surfaced over broker controls.
    pub fn code(&self) -> &'static str {
        match self {
            AddWorkspaceError::PathNotFound(_) => "path_not_found",
            AddWorkspaceError::NotADirectory(_) => "not_a_directory",
            AddWorkspaceError::Db(_) => "db_error",
        }
    }
}

impl std::fmt::Display for AddWorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AddWorkspaceError::PathNotFound(detail) => write!(f, "path_not_found: {detail}"),
            AddWorkspaceError::NotADirectory(detail) => write!(f, "not_a_directory: {detail}"),
            AddWorkspaceError::Db(detail) => write!(f, "{detail}"),
        }
    }
}

pub struct MetadataStore {
    connection: Connection,
    path: PathBuf,
}

/// App-level single store handle. One SQLite connection per process; every
/// consumer (RemoteAuth pairing, broker workspace/preference controls,
/// lifecycle touch) shares this exact instance.
pub type SharedMetadataStore = std::sync::Arc<std::sync::Mutex<MetadataStore>>;

impl MetadataStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create Picot metadata directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let connection = Connection::open(path).map_err(|error| {
            format!(
                "Cannot open Picot metadata database {}: {error}",
                path.display()
            )
        })?;
        let mut store = Self {
            connection,
            path: path.to_path_buf(),
        };
        store.migrate()?;
        store.restrict_permissions()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), String> {
        let current: i64 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Picot metadata schema version: {error}"))?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "Picot metadata schema {current} is newer than supported schema {SCHEMA_VERSION}"
            ));
        }
        if current == SCHEMA_VERSION {
            return Ok(());
        }

        // Version staircase runs entirely inside one transaction; user_version
        // advances only on commit, so a mid-staircase failure leaves the DB
        // untouched and retryable.
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start Picot metadata migration: {error}"))?;

        // Step 0 → v1: baseline tables. IF NOT EXISTS keeps v1/v2 data and any
        // v2-era extra tables completely untouched (strictly additive rule).
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (
                    workspace_id TEXT PRIMARY KEY,
                    canonical_path TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS paired_devices (
                    device_id TEXT PRIMARY KEY,
                    token_hash BLOB NOT NULL UNIQUE,
                    paired_at INTEGER NOT NULL DEFAULT (unixepoch()),
                    revoked_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );",
            )
            .map_err(|error| format!("Cannot migrate Picot metadata schema: {error}"))?;

        // Step v1|v2 → v3: add registry columns individually because SQLite has
        // no ADD COLUMN IF NOT EXISTS. Reaching here on a fresh v0 DB means the
        // baseline CREATE above guaranteed the workspaces table exists first.
        let existing_columns =
            {
                let mut statement = transaction
                    .prepare("PRAGMA table_info(workspaces)")
                    .map_err(|error| format!("Cannot inspect Picot workspaces schema: {error}"))?;
                let mapped = statement
                    .query_map([], |row| row.get::<_, String>(1))
                    .map_err(|error| format!("Cannot inspect Picot workspaces schema: {error}"))?;
                let mut names = Vec::new();
                for name in mapped {
                    names.push(name.map_err(|error| {
                        format!("Cannot inspect Picot workspaces schema: {error}")
                    })?);
                }
                names
            };
        let additions: [(&str, &str); 3] = [
            ("display_name", "TEXT"),
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
            ("last_opened_at", "INTEGER"),
        ];
        for (column, declaration) in additions {
            if !existing_columns
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(column))
            {
                transaction
                    .execute(
                        &format!("ALTER TABLE workspaces ADD COLUMN {column} {declaration}"),
                        [],
                    )
                    .map_err(|error| {
                        format!("Cannot extend Picot workspaces schema ({column}): {error}")
                    })?;
            }
        }

        transaction
            .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
            .map_err(|error| format!("Cannot finalize Picot metadata schema version: {error}"))?;

        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Picot metadata migration: {error}"))
    }

    #[cfg(unix)]
    fn restrict_permissions(&self) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "Cannot restrict metadata permissions {}: {error}",
                    self.path.display()
                )
            },
        )
    }

    #[cfg(not(unix))]
    fn restrict_permissions(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, String> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Picot metadata schema version: {error}"))
    }

    /// All workspaces ordered for the sidebar: pinned first, then most
    /// recently opened. Rows whose directory disappeared are deleted (DB row
    /// only, never filesystem content) and reported back for user feedback.
    pub fn list_workspaces_and_prune(
        &mut self,
    ) -> Result<(Vec<WorkspaceRow>, Vec<RemovedWorkspace>), String> {
        let rows = self.list_workspace_rows()?;
        let mut removed = Vec::new();
        for row in &rows {
            let vanished = std::fs::metadata(Path::new(&row.canonical_path))
                .map(|metadata| !metadata.is_dir())
                .unwrap_or(true);
            if vanished {
                let deleted = self
                    .connection
                    .execute(
                        "DELETE FROM workspaces WHERE workspace_id = ?1",
                        [&row.workspace_id],
                    )
                    .map_err(|error| format!("Cannot prune Picot workspace row: {error}"))?;
                if deleted > 0 {
                    removed.push(RemovedWorkspace {
                        workspace_id: row.workspace_id.clone(),
                        canonical_path: row.canonical_path.clone(),
                    });
                }
            }
        }
        if removed.is_empty() {
            return Ok((rows, removed));
        }
        Ok((self.list_workspace_rows()?, removed))
    }

    fn list_workspace_rows(&self) -> Result<Vec<WorkspaceRow>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT workspace_id, canonical_path, display_name, pinned, last_opened_at
                 FROM workspaces
                 ORDER BY pinned DESC, last_opened_at DESC",
            )
            .map_err(|error| format!("Cannot list Picot workspaces: {error}"))?;
        let mapped = statement
            .query_map([], |row| {
                Ok(WorkspaceRow {
                    workspace_id: row.get(0)?,
                    canonical_path: row.get(1)?,
                    display_name: row.get(2)?,
                    pinned: row.get::<_, i64>(3)? != 0,
                    last_opened_at: row.get(4)?,
                })
            })
            .map_err(|error| format!("Cannot list Picot workspaces: {error}"))?;
        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row.map_err(|error| format!("Cannot list Picot workspaces: {error}"))?);
        }
        Ok(rows)
    }

    /// Register a workspace directory. Identity is the host-canonicalized
    /// absolute path; re-registering an existing path returns its row with
    /// `added = false`. Never writes outside the database.
    pub fn add_workspace(&self, path: &Path) -> Result<(WorkspaceRow, bool), AddWorkspaceError> {
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) => {
                return Err(AddWorkspaceError::PathNotFound(format!(
                    "{}: {error}",
                    path.display()
                )))
            }
        };
        if !canonical.is_dir() {
            return Err(AddWorkspaceError::NotADirectory(format!(
                "{}",
                canonical.display()
            )));
        }
        let canonical_text = canonical.to_string_lossy().to_string();
        if let Some(existing) = self
            .workspace_row_by_path(&canonical_text)
            .map_err(AddWorkspaceError::Db)?
        {
            return Ok((existing, false));
        }
        let id = Uuid::new_v4().to_string();
        let display_name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().to_string());
        self.connection
            .execute(
                "INSERT INTO workspaces (workspace_id, canonical_path, display_name)
                 VALUES (?1, ?2, ?3)",
                params![id, canonical_text.as_str(), display_name],
            )
            .map_err(|error| AddWorkspaceError::Db(format!("Cannot store workspace: {error}")))?;
        let row = self
            .workspace_row_by_id(&id)
            .map_err(AddWorkspaceError::Db)?
            .ok_or_else(|| {
                AddWorkspaceError::Db("Stored workspace row immediately vanished".to_string())
            })?;
        Ok((row, true))
    }

    /// Remove a registry row. Returns whether a row was deleted. Sessions and
    /// directories are intentionally left untouched.
    pub fn remove_workspace(&mut self, workspace_id: &str) -> Result<bool, String> {
        let deleted = self
            .connection
            .execute(
                "DELETE FROM workspaces WHERE workspace_id = ?1",
                [workspace_id],
            )
            .map_err(|error| format!("Cannot remove Picot workspace row: {error}"))?;
        Ok(deleted > 0)
    }

    /// Update the pinned flag. Unknown ids yield `Ok(None)`; callers surface
    /// a stable not-found error rather than creating phantom rows.
    pub fn set_workspace_pinned(
        &mut self,
        workspace_id: &str,
        pinned: bool,
    ) -> Result<Option<WorkspaceRow>, String> {
        self.connection
            .execute(
                "UPDATE workspaces SET pinned = ?2 WHERE workspace_id = ?1",
                params![workspace_id, pinned],
            )
            .map_err(|error| format!("Cannot update Picot workspace pin: {error}"))?;
        self.workspace_row_by_id(workspace_id)
    }

    /// Record an open/switch of an already-registered workspace. Takes a
    /// host-verified canonical path; unregistered paths return false and
    /// never create rows, so browser-supplied ids cannot grow the registry.
    pub fn touch_registered_path(&mut self, canonical_path: &Path) -> Result<bool, String> {
        let Some(row) = self
            .workspace_row_by_path(&canonical_path.to_string_lossy())
            .map_err(|error| format!("Cannot look up Picot workspace: {error}"))?
        else {
            return Ok(false);
        };
        self.connection
            .execute(
                "UPDATE workspaces SET last_opened_at = unixepoch() WHERE workspace_id = ?1",
                [&row.workspace_id],
            )
            .map_err(|error| format!("Cannot touch Picot workspace: {error}"))?;
        Ok(true)
    }

    pub fn get_workspace(&mut self, workspace_id: &str) -> Result<Option<WorkspaceRow>, String> {
        self.workspace_row_by_id(workspace_id)
    }

    fn workspace_row_by_id(&self, workspace_id: &str) -> Result<Option<WorkspaceRow>, String> {
        self.connection
            .query_row(
                "SELECT workspace_id, canonical_path, display_name, pinned, last_opened_at
                 FROM workspaces WHERE workspace_id = ?1",
                [workspace_id],
                |row| {
                    Ok(WorkspaceRow {
                        workspace_id: row.get(0)?,
                        canonical_path: row.get(1)?,
                        display_name: row.get(2)?,
                        pinned: row.get::<_, i64>(3)? != 0,
                        last_opened_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Cannot load Picot workspace row: {error}"))
    }

    fn workspace_row_by_path(&self, canonical_path: &str) -> Result<Option<WorkspaceRow>, String> {
        self.connection
            .query_row(
                "SELECT workspace_id, canonical_path, display_name, pinned, last_opened_at
                 FROM workspaces WHERE canonical_path = ?1",
                [canonical_path],
                |row| {
                    Ok(WorkspaceRow {
                        workspace_id: row.get(0)?,
                        canonical_path: row.get(1)?,
                        display_name: row.get(2)?,
                        pinned: row.get::<_, i64>(3)? != 0,
                        last_opened_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Cannot load Picot workspace row: {error}"))
    }

    pub fn workspace_id_for_path(&mut self, workspace: &Path) -> Result<String, String> {
        self.add_workspace(workspace)
            .map(|(row, _added)| row.workspace_id)
            .map_err(|error| error.to_string())
    }

    pub fn store_device_token(&mut self, device_id: &str, token: &str) -> Result<(), String> {
        let token_hash = token_hash(token);
        self.connection
            .execute(
                "INSERT INTO paired_devices (device_id, token_hash, revoked_at)
                 VALUES (?1, ?2, NULL)
                 ON CONFLICT(device_id) DO UPDATE SET
                   token_hash = excluded.token_hash,
                   paired_at = unixepoch(),
                   revoked_at = NULL",
                params![device_id, token_hash],
            )
            .map_err(|error| format!("Cannot store paired device: {error}"))?;
        Ok(())
    }

    pub fn verify_device_token(&self, token: &str) -> Result<bool, String> {
        let token_hash = token_hash(token);
        self.connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM paired_devices WHERE token_hash = ?1 AND revoked_at IS NULL
                )",
                [token_hash],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot verify paired device: {error}"))
    }

    pub fn revoke_device(&mut self, device_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE paired_devices SET revoked_at = unixepoch() WHERE device_id = ?1",
                [device_id],
            )
            .map_err(|error| format!("Cannot revoke paired device: {error}"))?;
        Ok(())
    }

    pub fn reset(&mut self) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start metadata reset: {error}"))?;
        transaction
            .execute_batch(
                "DELETE FROM workspaces; DELETE FROM paired_devices; DELETE FROM preferences;",
            )
            .map_err(|error| format!("Cannot reset Picot metadata: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Picot metadata reset: {error}"))
    }

    pub fn pref_get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM preferences WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read Picot preference: {error}"))?;
        match json {
            None => Ok(None),
            Some(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|error| format!("Picot preference {key} holds invalid JSON: {error}")),
        }
    }

    pub fn pref_set(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        let json = serde_json::to_string(value)
            .map_err(|error| format!("Cannot serialize Picot preference {key}: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO preferences (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                params![key, json],
            )
            .map_err(|error| format!("Cannot write Picot preference: {error}"))?;
        Ok(())
    }

    pub fn pref_delete(&self, key: &str) -> Result<bool, String> {
        let deleted = self
            .connection
            .execute("DELETE FROM preferences WHERE key = ?1", [key])
            .map_err(|error| format!("Cannot delete Picot preference: {error}"))?;
        Ok(deleted > 0)
    }

    pub fn pref_list(&self, prefix: &str) -> Result<BTreeMap<String, serde_json::Value>, String> {
        // Escape LIKE metacharacters so caller-supplied prefixes match
        // literally instead of acting as wildcards.
        let escaped = prefix
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("{escaped}%");
        let mut statement = self
            .connection
            .prepare("SELECT key, value_json FROM preferences WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key")
            .map_err(|error| format!("Cannot list Picot preferences: {error}"))?;
        let mapped = statement
            .query_map([pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Cannot list Picot preferences: {error}"))?;
        let mut entries = BTreeMap::new();
        for entry in mapped {
            let (key, json) =
                entry.map_err(|error| format!("Cannot list Picot preferences: {error}"))?;
            let value: serde_json::Value = serde_json::from_str(&json)
                .map_err(|error| format!("Picot preference {key} holds invalid JSON: {error}"))?;
            entries.insert(key, value);
        }
        Ok(entries)
    }
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::{AddWorkspaceError, MetadataStore, RemovedWorkspace, SCHEMA_VERSION};
    use rusqlite::Connection;
    use std::fs;
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_DIR_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        // Parallel tests may sample identical nanosecond timestamps; the
        // monotonic per-call sequence guarantees a unique directory.
        let sequence = TEMP_DIR_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "picot-metadata-{}-{sequence}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fresh_store(name: &str) -> (tempdir_guard::TempDirGuard, MetadataStore) {
        let temp = temp_dir();
        let store = MetadataStore::open(&temp.join(name)).unwrap();
        (tempdir_guard::TempDirGuard(temp), store)
    }

    mod tempdir_guard {
        use super::*;
        pub struct TempDirGuard(pub PathBuf);
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    fn workspace_columns(store: &MetadataStore) -> Vec<String> {
        let connection: &Connection = &store.connection;
        let mut statement = connection.prepare("PRAGMA table_info(workspaces)").unwrap();
        let mapped = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap();
        mapped.map(|entry| entry.unwrap()).collect()
    }

    #[test]
    fn fresh_empty_database_reaches_schema_v3_with_registry_columns() {
        let (_guard, mut store) = fresh_store("picot.sqlite3");
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let columns = workspace_columns(&store);
        for expected in [
            "workspace_id",
            "canonical_path",
            "created_at",
            "display_name",
            "pinned",
            "last_opened_at",
        ] {
            assert!(
                columns.iter().any(|column| column == expected),
                "missing column {expected}"
            );
        }
        assert!(store.list_workspaces_and_prune().unwrap().0.is_empty());
    }

    #[test]
    fn v2_style_database_keeps_unknown_tables_and_migrates_to_v3() {
        let temp = temp_dir();
        let _guard = tempdir_guard::TempDirGuard(temp.clone());
        let database = temp.join("picot.sqlite3");
        {
            let connection = Connection::open(&database).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE workspaces (
                        workspace_id TEXT PRIMARY KEY,
                        canonical_path TEXT NOT NULL UNIQUE,
                        created_at INTEGER NOT NULL DEFAULT (unixepoch())
                    );
                    CREATE TABLE paired_devices (
                        device_id TEXT PRIMARY KEY,
                        token_hash BLOB NOT NULL UNIQUE,
                        paired_at INTEGER NOT NULL DEFAULT (unixepoch()),
                        revoked_at INTEGER
                    );
                    CREATE TABLE preferences (
                        key TEXT PRIMARY KEY,
                        value_json TEXT NOT NULL
                    );
                    CREATE TABLE company_account_profiles (
                        profile_key TEXT PRIMARY KEY,
                        payload TEXT NOT NULL
                    );
                    INSERT INTO company_account_profiles (profile_key, payload) VALUES ('a', '{}');
                    INSERT INTO workspaces (workspace_id, canonical_path) VALUES ('legacy', '/tmp/legacy');
                    PRAGMA user_version = 2;",
                )
                .unwrap();
        }
        let store = MetadataStore::open(&database).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

        // Verify the v2-era registry row survived migration through a direct
        // count: the placeholder path is not a real directory, so the pruning
        // list API would legitimately remove it.
        let legacy_rows: i64 = {
            let connection: &Connection = &store.connection;
            connection
                .query_row(
                    "SELECT count(*) FROM workspaces WHERE workspace_id = 'legacy'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(legacy_rows, 1, "v2 row survived migration");

        // Reopen to prove unknown-table data plus v3 columns persist.
        drop(store);
        let reopened = MetadataStore::open(&database).unwrap();
        let profiles: i64 = {
            let connection: &Connection = &reopened.connection;
            connection
                .query_row("SELECT count(*) FROM company_account_profiles", [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!(profiles, 1, "unknown v2 table survived");
        assert_eq!(workspace_columns(&reopened).len(), 6);
    }

    #[test]
    fn reopening_migrated_database_is_idempotent() {
        let temp = temp_dir();
        let _guard = tempdir_guard::TempDirGuard(temp.clone());
        let database = temp.join("picot.sqlite3");

        {
            let store = MetadataStore::open(&database).unwrap();
            assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        }
        assert!(database.exists());

        // Reopen the exact same database; migration must be a no-op.
        let mut reopened = MetadataStore::open(&database).unwrap();
        assert_eq!(reopened.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(reopened.list_workspaces_and_prune().unwrap().0.is_empty());
    }

    #[test]
    fn newer_schema_than_supported_rejects_open() {
        let temp = temp_dir();
        let _guard = tempdir_guard::TempDirGuard(temp.clone());
        let database = temp.join("picot.sqlite3");
        {
            let connection = Connection::open(&database).unwrap();
            connection
                .execute_batch("PRAGMA user_version = 99;")
                .unwrap();
        }
        let error = match MetadataStore::open(&database) {
            Err(error) => error,
            Ok(_) => panic!("expected open to reject newer schema"),
        };
        assert!(error.contains("newer than supported"), "{error}");
    }

    #[test]
    fn add_workspace_is_canonical_idempotent_and_validated() {
        let (_guard, store) = fresh_store("picot.sqlite3");
        let dir = _guard.0.join("project");
        fs::create_dir_all(&dir).unwrap();

        let (row, added) = store.add_workspace(&dir).unwrap();
        assert!(added);
        assert_eq!(row.display_name.as_deref(), Some("project"));
        assert!(!row.pinned);
        assert!(row.last_opened_at.is_none());

        // Same logical directory via a different spelling stays one row.
        fs::create_dir_all(_guard.0.join("sub")).unwrap();
        let detoured = _guard.0.join("sub").join("..").join("project");
        let (_same_row, same_added) = store.add_workspace(&detoured).unwrap();
        assert!(
            !same_added,
            "detoured spelling must hit UNIQUE canonical_path"
        );

        let (again, added_again) = store.add_workspace(&dir).unwrap();
        assert!(!added_again);
        assert_eq!(again.workspace_id, row.workspace_id);

        let missing = store.add_workspace(&_guard.0.join("missing"));
        assert!(matches!(missing, Err(AddWorkspaceError::PathNotFound(_))));
        assert_eq!(missing.unwrap_err().code(), "path_not_found");

        let file = _guard.0.join("plain.txt");
        fs::write(&file, "x").unwrap();
        let not_dir = store.add_workspace(&file);
        assert!(matches!(not_dir, Err(AddWorkspaceError::NotADirectory(_))));
        assert_eq!(not_dir.unwrap_err().code(), "not_a_directory");
    }

    #[test]
    fn list_prune_reports_missing_directories_but_never_touches_files() {
        let (_guard, mut store) = fresh_store("picot.sqlite3");
        let alive = _guard.0.join("alive");
        let dying = _guard.0.join("dying");
        fs::create_dir_all(&alive).unwrap();
        fs::create_dir_all(&dying).unwrap();
        let session_note = dying.join("session.jsonl");
        fs::write(&session_note, "{\"type\":\"session\"}\n").unwrap();

        let (_, _) = store.add_workspace(&alive).unwrap();
        let (dying_row, _) = store.add_workspace(&dying).unwrap();
        fs::remove_dir_all(&dying).unwrap();

        let expected_alive = fs::canonicalize(&alive)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let (rows, removed): (Vec<_>, Vec<RemovedWorkspace>) =
            store.list_workspaces_and_prune().unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].workspace_id, dying_row.workspace_id);
        assert_eq!(removed[0].canonical_path, dying_row.canonical_path);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].canonical_path, expected_alive);
        assert!(!session_note.exists(), "prune must not touch filesystem");

        // Second listing is clean and stable.
        let (rows2, removed2) = store.list_workspaces_and_prune().unwrap();
        assert!(removed2.is_empty());
        assert_eq!(rows2.len(), 1);
    }

    #[test]
    fn ordering_puts_pinned_then_recently_opened_first() {
        let (_guard, mut store) = fresh_store("picot.sqlite3");
        let mut ids = Vec::new();
        for name in ["alpha", "beta", "gamma"] {
            let dir = _guard.0.join(name);
            fs::create_dir_all(&dir).unwrap();
            ids.push(store.add_workspace(&dir).unwrap().0);
        }
        store
            .set_workspace_pinned(&ids[2].workspace_id, true)
            .unwrap();
        store
            .touch_registered_path(Path::new(&ids[1].canonical_path))
            .unwrap();

        let rows = store.list_workspaces_and_prune().unwrap().0;
        assert_eq!(
            rows[0].canonical_path, ids[2].canonical_path,
            "pinned first"
        );
        assert_eq!(
            rows[1].canonical_path, ids[1].canonical_path,
            "touched beats untitled"
        );
        assert_eq!(rows[2].last_opened_at, None);
    }

    #[test]
    fn pin_touch_and_remove_behave_as_documented() {
        let (_guard, mut store) = fresh_store("picot.sqlite3");
        let dir = _guard.0.join("main");
        fs::create_dir_all(&dir).unwrap();
        let row = store.add_workspace(&dir).unwrap().0;

        let pinned = store
            .set_workspace_pinned(&row.workspace_id, true)
            .unwrap()
            .unwrap();
        assert!(pinned.pinned);

        // Unregistered path must neither touch nor create a registry row.
        let total_before: i64 = {
            let connection: &Connection = &store.connection;
            connection
                .query_row("SELECT count(*) FROM workspaces", [], |r| r.get(0))
                .unwrap()
        };
        let unregistered = store
            .touch_registered_path(&_guard.0.join("ghost"))
            .unwrap();
        assert!(!unregistered, "unregistered path must not touch or create");
        let total_after: i64 = {
            let connection: &Connection = &store.connection;
            connection
                .query_row("SELECT count(*) FROM workspaces", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(total_before, total_after);

        let touched = store
            .touch_registered_path(Path::new(&row.canonical_path))
            .unwrap();
        assert!(touched);
        let updated = store.get_workspace(&row.workspace_id).unwrap().unwrap();
        assert!(updated.last_opened_at.is_some());

        assert!(store.remove_workspace(&row.workspace_id).unwrap());
        assert!(!store.remove_workspace(&row.workspace_id).unwrap());
        assert!(store.get_workspace(&row.workspace_id).unwrap().is_none());

        let unknown_pin = store.set_workspace_pinned("no-such-id", false).unwrap();
        assert!(unknown_pin.is_none());
    }

    #[test]
    fn preferences_round_trip_upsert_delete_and_prefix_list() {
        let (_guard, store) = fresh_store("picot.sqlite3");

        assert_eq!(store.pref_get("ui.theme").unwrap(), None);

        store
            .pref_set("ui.theme", &serde_json::json!("dark"))
            .unwrap();
        store
            .pref_set("ui.locale", &serde_json::json!("zh"))
            .unwrap();
        store
            .pref_set("sidebar.sizes.lane", &serde_json::json!({ "px": 320 }))
            .unwrap();

        assert_eq!(
            store.pref_get("ui.theme").unwrap(),
            Some(serde_json::json!("dark"))
        );
        // Upsert overwrites.
        store
            .pref_set("ui.theme", &serde_json::json!("light"))
            .unwrap();
        assert_eq!(
            store.pref_get("ui.theme").unwrap(),
            Some(serde_json::json!("light"))
        );

        let ui_prefs = store.pref_list("ui.").unwrap();
        assert_eq!(ui_prefs.len(), 2);
        assert_eq!(ui_prefs["ui.locale"], serde_json::json!("zh"));

        assert!(store.pref_delete("ui.theme").unwrap());
        assert!(!store.pref_delete("ui.theme").unwrap());
        assert_eq!(store.pref_list("").unwrap().len(), 2, "prefix '' lists all");

        // Nested JSON survives storage.
        assert_eq!(
            store.pref_list("sidebar.").unwrap()["sidebar.sizes.lane"],
            serde_json::json!({ "px": 320 })
        );

        // LIKE metacharacters never act as wildcards. `_`/`%` in a prefix are
        // taken literally: the pairs below would MATCH under wildcard
        // semantics (`_`→any char, `%`→any run) but must stay empty now.
        store.pref_set("weird.x-b", &serde_json::json!(1)).unwrap();
        store.pref_set("weird.pxg", &serde_json::json!(2)).unwrap();
        assert!(store.pref_list("weird.x_b").unwrap().is_empty());
        assert!(store.pref_list("weird.p%g").unwrap().is_empty());
        // Literal self-match keeps working for meta-free prefixes.
        assert_eq!(
            store.pref_list("weird.x-b").unwrap()["weird.x-b"],
            serde_json::json!(1)
        );
    }

    #[test]
    fn assigns_stable_workspace_ids_and_stores_only_device_token_hashes() {
        let temp = temp_dir();
        let _guard = tempdir_guard::TempDirGuard(temp.clone());
        let database = temp.join("picot.sqlite3");
        let workspace = temp.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let mut store = MetadataStore::open(&database).unwrap();

        let first = store.workspace_id_for_path(&workspace).unwrap();
        let second = store.workspace_id_for_path(&workspace).unwrap();
        assert_eq!(first, second);
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

        store
            .store_device_token("phone", "plain-device-token")
            .unwrap();
        assert!(store.verify_device_token("plain-device-token").unwrap());
        assert!(!store.verify_device_token("wrong-token").unwrap());
        let bytes = fs::read(&database).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("plain-device-token"));
        store.revoke_device("phone").unwrap();
        assert!(!store.verify_device_token("plain-device-token").unwrap());
    }

    #[test]
    fn reset_cannot_modify_pi_sessions_or_workspace_files_or_unknown_tables() {
        let temp = temp_dir();
        let _guard = tempdir_guard::TempDirGuard(temp.clone());
        let database = temp.join("picot.sqlite3");
        let workspace = temp.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let session = workspace.join("session.jsonl");
        fs::write(&session, "{\"type\":\"session\"}\n").unwrap();
        let mut store = MetadataStore::open(&database).unwrap();
        store.workspace_id_for_path(&workspace).unwrap();
        store
            .pref_set("ui.theme", &serde_json::json!("dark"))
            .unwrap();
        {
            let connection: &Connection = &store.connection;
            connection
                .execute_batch("CREATE TABLE foreign_branch_table (id INTEGER PRIMARY KEY); INSERT INTO foreign_branch_table VALUES (7);")
                .unwrap();
        }

        store.reset().unwrap();

        assert_eq!(
            fs::read_to_string(session).unwrap(),
            "{\"type\":\"session\"}\n"
        );
        assert!(store.list_workspaces_and_prune().unwrap().0.is_empty());
        let foreign: i64 = {
            let connection: &Connection = &store.connection;
            connection
                .query_row("SELECT count(*) FROM foreign_branch_table", [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!(foreign, 1, "reset must not touch unknown tables");
    }
}
