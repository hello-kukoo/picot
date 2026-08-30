// ABOUTME: Host-owned JSON configuration contract with validation and atomic replacement.
// ABOUTME: Preserves bounded, redacted errors and prevents partial or insecure writes.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_CONFIG_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidJson,
    TooLarge,
    NotObject,
    Io(String),
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_config",
            Self::TooLarge => "config_too_large",
            Self::NotObject => "config_object_required",
            Self::Io(_) => "config_access_failed",
        }
    }
}

pub fn read_json(path: &Path) -> Result<Value, ConfigError> {
    let bytes = fs::read(path).map_err(io_error)?;
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
    if content.len() > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge);
    }
    let value = Value::String(content.to_owned());
    write_bytes(path, content.as_bytes(), &value)
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), ConfigError> {
    if !value.is_object() {
        return Err(ConfigError::NotObject);
    }
    let encoded =
        serde_json::to_vec_pretty(value).map_err(|error| ConfigError::Io(error.to_string()))?;
    write_bytes(path, &encoded, value)
}

fn write_bytes(path: &Path, encoded: &[u8], _value: &Value) -> Result<(), ConfigError> {
    if encoded.len() > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge);
    }
    let parent = path
        .parent()
        .ok_or_else(|| ConfigError::Io("config path has no parent".into()))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    fs::create_dir_all(&lock).map_err(io_error)?;
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
}
