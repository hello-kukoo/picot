// ABOUTME: Host-owned JSON configuration contract with validation and atomic replacement.
// ABOUTME: Preserves bounded, redacted errors and prevents partial or insecure writes.

use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const MAX_CONFIG_BYTES: usize = 512 * 1024;
const LOCK_STALE_AFTER: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidJson,
    TooLarge,
    NotObject,
    Busy,
    Io(String),
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_config",
            Self::TooLarge => "config_too_large",
            Self::NotObject => "config_object_required",
            Self::Busy => "config_busy",
            Self::Io(_) => "config_access_failed",
        }
    }
}

pub fn read_json(path: &Path) -> Result<Value, ConfigError> {
    let file = fs::File::open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(ConfigError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // The stat above can race a concurrent writer; take() keeps the read
    // bounded even when the file grows between the check and the read.
    file.take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ConfigError::InvalidJson)?;
    if !value.is_object() {
        return Err(ConfigError::NotObject);
    }
    Ok(value)
}

pub fn write_text(path: &Path, content: &str) -> Result<(), ConfigError> {
    write_bytes(path, content.as_bytes(), LOCK_STALE_AFTER)
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), ConfigError> {
    if !value.is_object() {
        return Err(ConfigError::NotObject);
    }
    let encoded =
        serde_json::to_vec_pretty(value).map_err(|error| ConfigError::Io(error.to_string()))?;
    write_bytes(path, &encoded, LOCK_STALE_AFTER)
}

fn write_bytes(path: &Path, encoded: &[u8], stale_after: Duration) -> Result<(), ConfigError> {
    if encoded.len() > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge);
    }
    let parent = path
        .parent()
        .ok_or_else(|| ConfigError::Io("config path has no parent".into()))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    acquire_lock(&lock, stale_after)?;
    let temporary = path.with_file_name(format!(
        ".{}.picot-tmp-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        fs::write(&temporary, encoded).map_err(io_error)?;
        restrict_permissions(&temporary)?;
        fs::rename(&temporary, path).map_err(io_error)
    })();
    let _ = fs::remove_dir(&lock);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Proper-lockfile parity: the lock must be *created* (not `create_dir_all`,
/// which succeeds on an existing directory and would provide no mutual
/// exclusion at all). A pre-existing lock is honored unless its directory
/// mtime is older than `stale_after`, matching the documented 10 s stale
/// takeover used by the legacy settings editor and the Pi process itself.
fn acquire_lock(lock: &Path, stale_after: Duration) -> Result<(), ConfigError> {
    match fs::create_dir(lock) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let stale = fs::symlink_metadata(lock)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|held| SystemTime::now().duration_since(held).ok())
                .is_some_and(|age| age >= stale_after);
            if !stale {
                return Err(ConfigError::Busy);
            }
            let _ = fs::remove_dir(lock);
            fs::create_dir(lock).map_err(|_| ConfigError::Busy)
        }
        Err(error) => Err(io_error(error)),
    }
}

fn io_error(error: std::io::Error) -> ConfigError {
    ConfigError::Io(error.to_string())
}
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(io_error)
}
#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_object_and_writes_private_json_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(
            write_json(&path, &Value::String("secret".into())),
            Err(ConfigError::NotObject)
        );
        write_json(&path, &serde_json::json!({"enabled": true})).unwrap();
        assert_eq!(read_json(&path).unwrap()["enabled"], true);
        assert!(!path.with_file_name("settings.json.lock").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn external_lock_is_honored_and_stale_locks_are_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::create_dir_all(dir.path().join("settings.json.lock")).unwrap();
        // A fresh external lock (another writer holds it) must block, not
        // silently proceed like create_dir_all would.
        assert_eq!(
            write_json(&path, &serde_json::json!({"a": 1})),
            Err(ConfigError::Busy)
        );
        // stale_after = 0 makes the held lock immediately reclaimable, which
        // is the same takeover path production uses after 10 s.
        write_bytes(&path, br#"{"a": 1}"#, Duration::ZERO).unwrap();
        assert_eq!(read_json(&path).unwrap()["a"], 1);
        assert!(!path.with_file_name("settings.json.lock").exists());
    }

    #[test]
    fn read_rejects_oversized_files_before_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "0".repeat(MAX_CONFIG_BYTES + 1)).unwrap();
        assert_eq!(read_json(&path), Err(ConfigError::TooLarge));
    }
}
