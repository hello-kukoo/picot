#![cfg_attr(not(test), allow(dead_code))]

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 1;

pub struct MetadataStore {
    connection: Connection,
    path: PathBuf,
}

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
        // Public-owned additive table: existence-based, so it applies to every
        // accepted schema level without a version bump (same discipline the
        // workspace-session bucket column follows).
        store.ensure_reset_credit_operations_table()?;
        store.sweep_abandoned_reset_credits()?;
        store.restrict_permissions()?;
        Ok(store)
    }

    /// Codex reset-credit ledger (spec 2026-09-22). One row per attempted
    /// upstream reset; the id doubles as the upstream idempotency key, so it
    /// must survive a crash to prevent a double spend.
    fn ensure_reset_credit_operations_table(&self) -> Result<(), String> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS reset_credit_operations (
                    id TEXT PRIMARY KEY,
                    opened_at INTEGER NOT NULL,
                    settled_at INTEGER,
                    status TEXT NOT NULL
                );",
            )
            .map_err(|error| format!("Cannot create Picot reset-credit ledger: {error}"))?;
        Ok(())
    }

    fn now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Open (or reuse) the one unresolved reset-credit operation.
    pub fn reset_credit_open(&self) -> Result<String, String> {
        // One conditional INSERT instead of read-then-insert: two concurrent
        // opens must never leave two unresolved rows behind (an orphan row
        // would let a later session replay a credit this one already used).
        // SQLite serializes writers, so the second statement observes the
        // first row and inserts nothing.
        let candidate = uuid::Uuid::new_v4().to_string();
        let inserted = self
            .connection
            .execute(
                "INSERT INTO reset_credit_operations (id, opened_at, settled_at, status)
                 SELECT ?1, ?2, NULL, 'pending'
                 WHERE NOT EXISTS (
                     SELECT 1 FROM reset_credit_operations
                     WHERE status IN ('pending', 'ambiguous')
                 )",
                rusqlite::params![candidate, Self::now_secs()],
            )
            .map_err(|error| format!("Cannot write Picot reset-credit ledger: {error}"))?;
        if inserted == 1 {
            return Ok(candidate);
        }
        // An unresolved row already exists: reuse it (the id doubles as the
        // upstream idempotency key, so a fresh uuid would double-spend).
        self.connection
            .query_row(
                "SELECT id FROM reset_credit_operations
                 WHERE status IN ('pending', 'ambiguous')
                 ORDER BY opened_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot read Picot reset-credit ledger: {error}"))
    }

    /// Settle an operation as `settled` or mark it `ambiguous` (response lost
    /// mid-flight; recovery re-checks before replaying the same id).
    pub fn reset_credit_settle(&self, operation_id: &str, status: &str) -> Result<(), String> {
        if !matches!(status, "settled" | "ambiguous") {
            return Err(format!("Invalid reset-credit settle status: {status}"));
        }
        let settled_at = if status == "settled" {
            Self::now_secs()
        } else {
            0
        };
        let changed = self
            .connection
            .execute(
                "UPDATE reset_credit_operations SET status = ?2, settled_at = ?3 WHERE id = ?1",
                rusqlite::params![operation_id, status, settled_at],
            )
            .map_err(|error| format!("Cannot update Picot reset-credit ledger: {error}"))?;
        if changed == 0 {
            return Err("Unknown reset-credit operation".to_owned());
        }
        Ok(())
    }

    /// Startup sweep: a pending row whose opener process is long gone can
    /// never be settled — mark it abandoned so the next open proceeds.
    pub fn sweep_abandoned_reset_credits(&self) -> Result<u64, String> {
        let swept = self
            .connection
            .execute(
                "UPDATE reset_credit_operations SET status = 'abandoned'
                 WHERE status = 'pending' AND opened_at < ?1",
                rusqlite::params![Self::now_secs() - 60],
            )
            .map_err(|error| format!("Cannot sweep Picot reset-credit ledger: {error}"))?;
        Ok(swept as u64)
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
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start Picot metadata migration: {error}"))?;
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
                );
                PRAGMA user_version = 1;",
            )
            .map_err(|error| format!("Cannot migrate Picot metadata schema: {error}"))?;
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

    pub fn workspace_id_for_path(&mut self, workspace: &Path) -> Result<String, String> {
        let canonical = workspace.canonicalize().map_err(|error| {
            format!("Cannot resolve workspace {}: {error}", workspace.display())
        })?;
        let canonical = canonical.to_string_lossy();
        if let Some(id) = self
            .connection
            .query_row(
                "SELECT workspace_id FROM workspaces WHERE canonical_path = ?1",
                [canonical.as_ref()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot query workspace metadata: {error}"))?
        {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        self.connection
            .execute(
                "INSERT INTO workspaces (workspace_id, canonical_path) VALUES (?1, ?2)",
                params![id, canonical.as_ref()],
            )
            .map_err(|error| format!("Cannot store workspace metadata: {error}"))?;
        Ok(id)
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

    /// Read one JSON preference value. Corrupt stored JSON surfaces as an
    /// error instead of silently falling back to a default.
    pub fn preference_get(&self, key: &str) -> Result<Option<Value>, String> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM preferences WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read preference: {error}"))?;
        raw.map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|error| format!("Invalid stored preference: {error}"))
        })
        .transpose()
    }

    /// Upsert one JSON preference value.
    pub fn preference_set(&mut self, key: &str, value: &Value) -> Result<(), String> {
        let raw = serde_json::to_string(value)
            .map_err(|error| format!("Cannot encode preference: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO preferences (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                params![key, raw],
            )
            .map_err(|error| format!("Cannot save preference: {error}"))?;
        Ok(())
    }

    /// Delete one preference. Returns whether a row was removed.
    pub fn preference_remove(&mut self, key: &str) -> Result<bool, String> {
        let removed = self
            .connection
            .execute("DELETE FROM preferences WHERE key = ?1", [key])
            .map_err(|error| format!("Cannot remove preference: {error}"))?;
        Ok(removed > 0)
    }
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::MetadataStore;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("picot-metadata-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn assigns_stable_workspace_ids_and_stores_only_device_token_hashes() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let workspace = temp.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let mut store = MetadataStore::open(&database).unwrap();

        let first = store.workspace_id_for_path(&workspace).unwrap();
        let second = store.workspace_id_for_path(&workspace).unwrap();
        assert_eq!(first, second);
        assert_eq!(store.schema_version().unwrap(), 1);

        store
            .store_device_token("phone", "plain-device-token")
            .unwrap();
        assert!(store.verify_device_token("plain-device-token").unwrap());
        assert!(!store.verify_device_token("wrong-token").unwrap());
        let bytes = fs::read(&database).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("plain-device-token"));
        store.revoke_device("phone").unwrap();
        assert!(!store.verify_device_token("plain-device-token").unwrap());

        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn preferences_round_trip_json_and_delete() {
        let temp = temp_dir();
        let mut store = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();

        assert_eq!(store.preference_get("ui.chatFontSize").unwrap(), None);
        store
            .preference_set("ui.chatFontSize", &serde_json::json!("large"))
            .unwrap();
        assert_eq!(
            store.preference_get("ui.chatFontSize").unwrap(),
            Some(serde_json::json!("large"))
        );
        // Upsert overwrites the same key.
        store
            .preference_set("ui.chatFontSize", &serde_json::json!({ "level": 3 }))
            .unwrap();
        assert_eq!(
            store.preference_get("ui.chatFontSize").unwrap(),
            Some(serde_json::json!({ "level": 3 }))
        );
        assert!(store.preference_remove("ui.chatFontSize").unwrap());
        assert_eq!(store.preference_get("ui.chatFontSize").unwrap(), None);
        assert!(!store.preference_remove("ui.chatFontSize").unwrap());

        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reset_cannot_modify_pi_sessions_or_workspace_files() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let workspace = temp.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let session = workspace.join("session.jsonl");
        fs::write(&session, "{\"type\":\"session\"}\n").unwrap();
        let mut store = MetadataStore::open(&database).unwrap();
        store.workspace_id_for_path(&workspace).unwrap();

        store.reset().unwrap();

        assert_eq!(
            fs::read_to_string(session).unwrap(),
            "{\"type\":\"session\"}\n"
        );
        assert_eq!(store.schema_version().unwrap(), 1);
        fs::remove_dir_all(temp).unwrap();
    }
}
