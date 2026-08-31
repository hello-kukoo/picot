// ABOUTME: Owner-independent filesystem contract for registered workspace data.
// ABOUTME: Enforces canonical containment, bounded reads, and atomic owner-safe writes.

#[cfg(unix)]
use std::ffi::CString;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::{Component, Path, PathBuf};
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    InvalidPath,
    OutsideWorkspace,
    NotFound,
    IsDirectory,
    TooLarge,
    Conflict,
    Io(String),
}

impl FileError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPath => "invalid_path",
            Self::OutsideWorkspace => "path_outside_workspace",
            Self::NotFound => "file_not_found",
            Self::IsDirectory => "is_directory",
            Self::TooLarge => "file_too_large",
            Self::Conflict => "file_conflict",
            Self::Io(_) => "file_access_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileContent {
    pub relative_path: String,
    pub bytes: Vec<u8>,
    pub modified_at_ms: u128,
}

pub fn resolve_existing(root: &Path, relative: &str) -> Result<PathBuf, FileError> {
    validate_relative(relative)?;
    let root = root.canonicalize().map_err(io_error)?;
    let path = root.join(relative).canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            FileError::NotFound
        } else {
            io_error(error)
        }
    })?;
    if !path.starts_with(&root) {
        return Err(FileError::OutsideWorkspace);
    }
    Ok(path)
}

pub fn read(root: &Path, relative: &str) -> Result<FileContent, FileError> {
    let path = resolve_existing(root, relative)?;
    let metadata = fs::metadata(&path).map_err(io_error)?;
    if metadata.is_dir() {
        return Err(FileError::IsDirectory);
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // The stat above can race a concurrent writer (the workspace's own Pi
    // agent edits files); take() keeps the read bounded even when the file
    // grows between the check and the read.
    fs::File::open(&path)
        .map_err(io_error)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    Ok(FileContent {
        relative_path: relative.replace('\\', "/"),
        bytes,
        modified_at_ms: modified_ms(&metadata),
    })
}

pub fn write(
    root: &Path,
    relative: &str,
    bytes: &[u8],
    expected_modified_at_ms: Option<u128>,
) -> Result<u128, FileError> {
    validate_relative(relative)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    let root = root.canonicalize().map_err(io_error)?;
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        let parent = parent.canonicalize().map_err(io_error)?;
        if !parent.starts_with(&root) {
            return Err(FileError::OutsideWorkspace);
        }
    }
    let existing = fs::symlink_metadata(&path).ok();
    if let Some(metadata) = existing {
        if metadata.file_type().is_symlink() {
            return Err(FileError::OutsideWorkspace);
        }
        if metadata.is_dir() {
            return Err(FileError::IsDirectory);
        }
        if expected_modified_at_ms.is_some()
            && expected_modified_at_ms != Some(modified_ms(&metadata))
        {
            return Err(FileError::Conflict);
        }
    } else if expected_modified_at_ms.is_some() {
        return Err(FileError::Conflict);
    }
    #[cfg(unix)]
    {
        atomic_replace_unix(&root, relative, bytes)
    }
    #[cfg(not(unix))]
    let file_name = path.file_name().ok_or(FileError::InvalidPath)?;
    #[cfg(not(unix))]
    {
        let temporary = path.with_file_name(format!(
            ".{}.picot-tmp-{}",
            file_name.to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        fs::write(&temporary, bytes).map_err(io_error)?;
        if let Err(error) = restrict_permissions(&temporary) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = fs::rename(&temporary, &path) {
            let _ = fs::remove_file(&temporary);
            return Err(io_error(error));
        }
        let resolved = path.canonicalize().map_err(io_error)?;
        if resolved.strip_prefix(&root).is_err() {
            return Err(FileError::OutsideWorkspace);
        }
        Ok(modified_ms(&fs::metadata(&resolved).map_err(io_error)?))
    }
}

#[cfg(unix)]
fn atomic_replace_unix(root: &Path, relative: &str, bytes: &[u8]) -> Result<u128, FileError> {
    use std::io::Write;

    let root_bytes =
        CString::new(root.as_os_str().as_bytes()).map_err(|_| FileError::InvalidPath)?;
    let root_fd = unsafe {
        libc::open(
            root_bytes.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let mut directory = unsafe { std::fs::File::from_raw_fd(root_fd) };
    let components: Vec<_> = Path::new(relative).components().collect();
    let file_name = components
        .last()
        .and_then(|component| match component {
            Component::Normal(name) => Some(*name),
            _ => None,
        })
        .ok_or(FileError::InvalidPath)?;
    for component in &components[..components.len() - 1] {
        let Component::Normal(name) = component else {
            continue;
        };
        let name = CString::new(name.as_bytes()).map_err(|_| FileError::InvalidPath)?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        directory = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    let temp_name = format!(
        ".{}.picot-tmp-{}",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    );
    let temp_name = CString::new(temp_name.as_bytes()).map_err(|_| FileError::InvalidPath)?;
    let target_name = CString::new(file_name.as_bytes()).map_err(|_| FileError::InvalidPath)?;
    let temp_fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temp_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if temp_fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let mut temporary = unsafe { std::fs::File::from_raw_fd(temp_fd) };
    if let Err(error) = temporary
        .write_all(bytes)
        .and_then(|_| temporary.sync_all())
    {
        unsafe { libc::unlinkat(directory.as_raw_fd(), temp_name.as_ptr(), 0) };
        return Err(io_error(error));
    }
    drop(temporary);
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            temp_name.as_ptr(),
            directory.as_raw_fd(),
            target_name.as_ptr(),
        )
    } < 0
    {
        unsafe { libc::unlinkat(directory.as_raw_fd(), temp_name.as_ptr(), 0) };
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let target_fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            target_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if target_fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let target = unsafe { std::fs::File::from_raw_fd(target_fd) };
    Ok(modified_ms(&target.metadata().map_err(io_error)?))
}

fn validate_relative(value: &str) -> Result<(), FileError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(FileError::InvalidPath);
    }
    Ok(())
}

fn modified_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis())
}

fn io_error(error: std::io::Error) -> FileError {
    FileError::Io(error.to_string())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), FileError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(io_error)
}
#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), FileError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_traversal_and_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert_eq!(
            resolve_existing(&root, "../outside/secret"),
            Err(FileError::InvalidPath)
        );
        #[cfg(unix)]
        assert_eq!(
            resolve_existing(&root, "link/secret"),
            Err(FileError::OutsideWorkspace)
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_final_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside.txt");
        fs::create_dir(&root).unwrap();
        fs::write(&outside, b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("target.txt")).unwrap();
        assert_eq!(
            write(&root, "target.txt", b"inside", None),
            Err(FileError::OutsideWorkspace)
        );
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }

    #[test]
    fn atomic_write_enforces_conflict_and_mode() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("root")).unwrap();
        let root = dir.path().join("root");
        let stamp = write(&root, "a.txt", b"one", None).unwrap();
        assert_eq!(read(&root, "a.txt").unwrap().bytes, b"one");
        assert_eq!(
            write(&root, "a.txt", b"two", Some(stamp + 1)),
            Err(FileError::Conflict)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("a.txt"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
