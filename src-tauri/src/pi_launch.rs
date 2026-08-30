// ABOUTME: Shared Pi launch contract helpers for binary, arguments, paths, stderr, and environment.
// ABOUTME: Keeps legacy and native launch inputs behaviorally identical.

use std::io::{BufRead, BufReader};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, Command};
use std::sync::OnceLock;

use crate::native_pi_manager::{NativeLaunchSpec, NativeRuntimeType, ReadinessPolicy};
use base64::Engine;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `scripts/pi-version.json` baked into the binary at compile time so we can
/// forward the locked pi version to the embedded server (which displays it
/// in the UI footer) without re-running fetch logic at startup.
const PI_VERSION_JSON: &str = include_str!("../../scripts/pi-version.json");
/// Generalized spawn request. The host owns every field; callers never inject
/// capability, owner tokens, executables, or arbitrary flags through this.
#[derive(Clone, Debug)]
pub struct PiSpawnSpec {
    pub cwd: PathBuf,
    pub port: u16,
    pub session_path: Option<String>,
    pub no_session: bool,
    pub no_tools: bool,
    pub environment: Vec<(String, String)>,
}

/// Locked pi version string (e.g. "0.77.0"). Resolved lazily on first call.
pub fn locked_pi_version() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
        // We deliberately do a hand-rolled extraction rather than a full
        // serde_json parse: this string is baked in at compile time, the
        // schema is trivial ({"version": "..."}), and avoiding the
        // dependency makes this fn callable from `const` contexts in the
        // future if needed. If the JSON shape grows, switch to serde_json.
        let needle = "\"version\"";
        let bytes = PI_VERSION_JSON;
        let start = bytes
            .find(needle)
            .expect("pi-version.json: missing \"version\" key");
        let after_key = &bytes[start + needle.len()..];
        let colon = after_key
            .find(':')
            .expect("pi-version.json: malformed \"version\" entry");
        let after_colon = &after_key[colon + 1..];
        let first_quote = after_colon
            .find('"')
            .expect("pi-version.json: \"version\" value not quoted");
        let rest = &after_colon[first_quote + 1..];
        let end_quote = rest
            .find('"')
            .expect("pi-version.json: unterminated \"version\" value");
        rest[..end_quote].to_string()
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn configure_child_process_for_windows(command: &mut Command) {
    // Prevent child `pi.exe` processes from creating a visible console window
    // when Picot runs as a GUI app on Windows.
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn configure_child_process_for_windows(_command: &mut Command) {}

/// Redact child-process diagnostics before they enter logs or UI error payloads.
/// Paths, bearer/token-like values, and control characters must not cross this
/// boundary; operators still get stable failure context without raw Pi output.
pub(crate) fn redact_child_diagnostic(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(4096));
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut redact_next = false;
    for (index, token) in tokens.iter().enumerate() {
        if index > 0 {
            output.push(' ');
        }
        if redact_next {
            output.push_str("<redacted>");
            redact_next = false;
            continue;
        }
        let is_path = token.starts_with("/Users/")
            || token.starts_with("/home/")
            || token.starts_with("/tmp/")
            || token.starts_with("/private/")
            || token.starts_with("/var/")
            || token.starts_with('\\')
            || token.contains(":\\")
            || token.starts_with("PI_STUDIO_SKILL_INSTALL_SECRET=")
            || token.starts_with("Bearer")
            || token.to_ascii_lowercase().contains("token=")
            || token.to_ascii_lowercase().contains("secret=");
        if is_path {
            output.push_str("<redacted>");
            redact_next = *token == "Bearer";
        } else {
            output.extend(token.chars().filter(|c| !c.is_control()).take(512));
        }
    }
    output.chars().take(4096).collect()
}

pub(crate) fn format_pi_stderr_log_line(port: u16, line: &str) -> String {
    format!(
        "[pi-desktop] pi stderr port={port}: {}",
        redact_child_diagnostic(line)
    )
}

#[cfg(test)]
mod diagnostic_tests {
    use super::redact_child_diagnostic;

    #[test]
    fn redacts_paths_and_bootstrap_secrets() {
        let result = redact_child_diagnostic(
            "failed /Users/lin/.pi/settings.json PI_STUDIO_SKILL_INSTALL_SECRET=secret123 Bearer abc",
        );
        assert!(!result.contains("/Users/lin"));
        assert!(!result.contains("secret123"));
        assert!(!result.contains("Bearer abc"));
        assert!(result.contains("<redacted>"));
    }
}

/// Forward Pi's stderr into Picot's log so release builds retain startup errors.
pub(crate) fn spawn_pi_stderr_logger(stderr: ChildStderr, port: u16) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) if !line.is_empty() => {
                    log::error!("{}", format_pi_stderr_log_line(port, &line));
                }
                Ok(_) => {}
                Err(error) => {
                    log::warn!("[pi-desktop] failed reading pi stderr port={port}: {error}");
                    break;
                }
            }
        }
    });
}

/// Build an augmented PATH for child processes.
///
/// `fix_path_env::fix()` is called at app startup and already merges the
/// user's login-shell PATH into this process.  This function is a second
/// safety net: it appends any well-known tool directories that might still
/// be absent (e.g. nvm-managed node versions, Volta, Bun, Mise shims) so
/// that `npm`, `npx`, and friends are always reachable.
///
/// Directories already present in PATH are not duplicated.
pub(crate) fn build_augmented_path() -> String {
    use std::path::{Path, PathBuf};

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let h = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(h));
            extras.push(h.join(".local/bin"));
            extras.push(h.join(".bun/bin"));
            extras.push(h.join(".volta/bin"));
            extras.push(h.join(".cargo/bin"));
            extras.push(h.join(".local/share/mise/shims"));
            // nvm: enumerate all installed node versions
            let nvm_root = h.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extras.push(bin);
                    }
                }
            }
        }

        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let h = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(h));
            extras.push(h.join(".cargo").join("bin"));
            extras.push(h.join(".bun").join("bin"));
            extras.push(h.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

pub(crate) fn pi_extension_npm_bin_dir(home: &Path) -> PathBuf {
    home.join(".pi")
        .join("agent")
        .join("npm")
        .join("node_modules")
        .join(".bin")
}

/// Strip a Windows verbatim / extended-length path prefix (`\\?\` or
/// `\\?\UNC\`) from a path string.
///
/// Tauri's `resource_dir()` returns extended-length paths (e.g.
/// `\\?\C:\Users\...\Picot\pi\pi.exe`). The embedded pi (Bun 1.3.10,
/// Windows arm64, compiled standalone) segfaults (`Segmentation fault at
/// address 0x18`) when it is launched with — or asked to load an
/// `--extension` from — a `\\?\`-prefixed path. Passing the plain
/// `C:\Users\...` form avoids the crash. This is a no-op on non-Windows
/// platforms and for paths without the prefix.
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` -> `\\server\share`
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Return a path to the embedded-server extension that is safe to pass as a
/// `--extension` argument to the embedded pi binary.
///
/// On Windows the Bun-compiled pi binary truncates `--extension` values at the
/// first space (e.g. `C:\...\Picot\...\embedded-server.mjs` is loaded as
/// `C:\...\Pi`), which then fails to load and segfaults the process. Since Pi
/// Studio always installs under a space-containing path, we mirror the
/// extension file into a space-free directory under the system temp dir and
/// return that path instead. The copy is idempotent (skipped when an existing
/// mirror already matches by length + mtime), so repeated spawns are cheap.
///
/// On non-Windows platforms, or when the path has no space, the original path
/// is returned unchanged.
#[cfg(not(target_os = "windows"))]
pub(crate) fn sanitize_extension_path_for_pi(original: &str) -> String {
    original.to_string()
}

#[cfg(target_os = "windows")]
pub(crate) fn sanitize_extension_path_for_pi(original: &str) -> String {
    if !original.contains(' ') {
        return original.to_string();
    }

    match mirror_to_space_free_dir(Path::new(original)) {
        Ok(mirrored) => {
            log::info!(
                "[pi-desktop] extension path contains spaces; mirrored to space-free path: {} -> {}",
                original,
                mirrored.display()
            );
            mirrored.to_string_lossy().to_string()
        }
        Err(e) => {
            // Non-fatal: fall back to the original path. Worst case is the
            // pre-existing crash, but we don't want the mirroring step itself
            // to be a new hard failure mode.
            log::warn!(
                "[pi-desktop] failed to mirror extension to space-free path ({}); using original: {}",
                e,
                original
            );
            original.to_string()
        }
    }
}

/// Copy `src` into `<temp>/pi-studio-ext/<filename>` (a space-free directory),
/// skipping the copy when an up-to-date mirror already exists. Returns the
/// mirrored path.
#[cfg(target_os = "windows")]
pub(crate) fn mirror_to_space_free_dir(src: &Path) -> std::io::Result<PathBuf> {
    let file_name = src.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "extension path has no file name",
        )
    })?;

    let mut dest_dir = std::env::temp_dir();
    // Guard: if the temp dir itself contains a space, fall back to a
    // well-known space-free root so the workaround actually helps.
    if dest_dir.to_string_lossy().contains(' ') {
        dest_dir = PathBuf::from("C:\\ProgramData\\pi-studio");
    }
    dest_dir.push("pi-studio-ext");
    std::fs::create_dir_all(&dest_dir)?;

    let dest = dest_dir.join(file_name);

    if mirror_is_up_to_date(src, &dest) {
        return Ok(dest);
    }

    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// Cheap freshness check: the mirror is considered current when it exists and
/// matches the source by byte length and modified time. This avoids re-copying
/// the extension on every spawn while still picking up updated builds.
#[cfg(target_os = "windows")]
pub(crate) fn mirror_is_up_to_date(src: &Path, dest: &Path) -> bool {
    let (Ok(src_meta), Ok(dest_meta)) = (std::fs::metadata(src), std::fs::metadata(dest)) else {
        return false;
    };
    if src_meta.len() != dest_meta.len() {
        return false;
    }
    match (src_meta.modified(), dest_meta.modified()) {
        (Ok(src_mtime), Ok(dest_mtime)) => dest_mtime >= src_mtime,
        _ => false,
    }
}

/// Resolve the directory used by Pi for its agent state and extensions.
///
/// An explicit non-empty `PI_CODING_AGENT_DIR` takes precedence. Otherwise the
/// user's home directory is used as the parent of `.pi/agent`. The directory
/// is created before canonicalization so the child always receives a stable,
/// existing absolute path.
pub(crate) fn resolve_pi_agent_root() -> Result<PathBuf, String> {
    let root = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => {
            let home = std::env::var("HOME")
                .ok()
                .filter(|path| !path.is_empty())
                .or_else(|| {
                    std::env::var("USERPROFILE")
                        .ok()
                        .filter(|path| !path.is_empty())
                })
                .ok_or_else(|| {
                    "cannot resolve Pi agent root: HOME and USERPROFILE are unset".to_string()
                })?;
            PathBuf::from(home).join(".pi").join("agent")
        }
    };

    std::fs::create_dir_all(&root)
        .map_err(|error| format!("failed to create Pi agent root {}: {error}", root.display()))?;
    let canonicalized = root.canonicalize().map_err(|error| {
        format!(
            "failed to canonicalize Pi agent root {}: {error}",
            root.display()
        )
    })?;
    // `canonicalize` on Windows returns a `\\?\`-prefixed extended-length
    // path. Bun (the embedded pi runtime) cannot resolve modules from such a
    // path, so every package extension fails with
    // `Cannot find module '\\?\C:\...\node_modules\<pkg>\dist\index.js'`,
    // which presents as a health-check timeout with no window. Strip the
    // prefix so pi receives the plain `C:\...` form, matching macOS/Linux.
    Ok(PathBuf::from(strip_verbatim_prefix(
        &canonicalized.to_string_lossy(),
    )))
}

/// Copy caller-provided environment markers while keeping the agent root under
/// host control. The canonical root is appended last so it cannot be replaced
/// by an inherited or caller-provided value.
pub(crate) fn build_spawn_environment(
    spec: &PiSpawnSpec,
    install_secret: &str,
) -> Result<Vec<(String, String)>, String> {
    if spec
        .environment
        .iter()
        .any(|(key, _)| key == "PI_CODING_AGENT_DIR")
    {
        return Err(
            "PI_CODING_AGENT_DIR is reserved and cannot be supplied in spawn environment"
                .to_string(),
        );
    }

    let mut environment = spec.environment.clone();
    environment.push((
        "PI_CODING_AGENT_DIR".to_string(),
        resolve_pi_agent_root()?.to_string_lossy().into_owned(),
    ));
    environment.push((
        "PI_STUDIO_SKILL_INSTALL_SECRET".to_string(),
        install_secret.to_string(),
    ));
    Ok(environment)
}

/// Build the pi CLI argument vector for a spawn spec. Pure and separately
/// tested so the side-chat / quick-chat flag combinations are locked down
/// without spawning a real process.
pub(crate) fn build_pi_args(
    extension_path: &str,
    spec: &PiSpawnSpec,
) -> Result<Vec<String>, String> {
    if spec.no_session && spec.session_path.is_some() {
        return Err("cannot combine --no-session with an explicit session path".to_string());
    }
    let mut args = vec![
        "--extension".to_string(),
        extension_path.to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
    ];
    if spec.no_session {
        args.push("--no-session".to_string());
    } else if let Some(session) = &spec.session_path {
        args.push("--session".to_string());
        args.push(session.clone());
    }
    if spec.no_tools {
        args.push("--no-tools".to_string());
    }
    Ok(args)
}

/// Build native launch inputs without constructing the legacy PiManager.
pub(crate) fn native_launch_spec(
    static_dir: &Path,
    cwd: &str,
    session_path: Option<&str>,
) -> Result<NativeLaunchSpec, String> {
    native_launch_spec_for(
        static_dir,
        NativeRuntimeType::Primary,
        Path::new(cwd),
        session_path.map(Path::new),
    )
}
/// Build native launch inputs for a specific runtime type.
///
/// Session and tool flags follow the Gate C launch contract per type:
/// Dedicated requires an explicit session; SideChat, QuickChat, and Standby
/// are sessionless (`command_description` emits `--no-session`); QuickChat
/// is always toolless. Standby callers may still enable `no_tools` on the
/// returned spec for the side-chat standby pool variant.
pub(crate) fn native_launch_spec_for(
    static_dir: &Path,
    runtime_type: NativeRuntimeType,
    cwd: &Path,
    session_path: Option<&Path>,
) -> Result<NativeLaunchSpec, String> {
    if runtime_type == NativeRuntimeType::Dedicated && session_path.is_none() {
        return Err("Dedicated runtime requires an explicit session path".into());
    }
    if matches!(
        runtime_type,
        NativeRuntimeType::SideChat | NativeRuntimeType::QuickChat | NativeRuntimeType::Standby
    ) && session_path.is_some()
    {
        return Err("Sessionless runtime types cannot carry a session path".into());
    }
    let binary = resolve_bundled_pi(static_dir)?;
    let bridge = resolve_picot_bridge_extension_path(static_dir)?;
    let mut secret_bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut secret_bytes);
    let spec = NativeLaunchSpec {
        binary,
        cwd: cwd.to_path_buf(),
        session_path: session_path.map(PathBuf::from),
        extensions: vec![bridge],
        pi_version: locked_pi_version().to_owned(),
        path_env: build_augmented_path(),
        agent_root: Some(resolve_pi_agent_root()?),
        static_dir: Some(static_dir.to_path_buf()),
        install_secret: Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret_bytes)),
        runtime_type,
        no_tools: runtime_type == NativeRuntimeType::QuickChat,
        readiness: ReadinessPolicy::default(),
        cleanup: crate::native_pi_manager::NativeCleanupResources::default(),
    };
    Ok(spec)
}

/// Resolve the picot bridge extension used by native Pi runtimes.
///
/// Native launch must not depend on the legacy PiManager for launch inputs.
pub(crate) fn resolve_picot_bridge_extension_path(static_dir: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(parent) = static_dir.parent() {
        candidates.push(parent.join("extensions").join("picot-bridge.mjs"));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("extensions")
                .join("dist")
                .join("picot-bridge.mjs"),
        );
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("extensions")
                .join("picot-bridge.ts"),
        );
    }
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .map(|bridge| {
            PathBuf::from(sanitize_extension_path_for_pi(&strip_verbatim_prefix(
                &bridge.to_string_lossy(),
            )))
        })
        .ok_or_else(|| {
            format!(
                "Could not find picot-bridge extension. Tried:\n{}",
                candidates
                    .iter()
                    .map(|path| format!("  - {}", path.display()))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })
}

pub(crate) fn resolve_bundled_pi(static_dir: &Path) -> Result<PathBuf, String> {
    let bin_name = if cfg!(target_os = "windows") {
        "pi.exe"
    } else {
        "pi"
    };

    // Explicit override (rare; useful when smoke-testing a hand-built pi).
    if let Ok(explicit) = std::env::var("PI_BIN") {
        let candidate = PathBuf::from(explicit.trim());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let mut tried: Vec<PathBuf> = Vec::new();
    let bundled = static_dir
        .parent()
        .map(|parent| parent.join("pi").join(bin_name));
    if let Some(p) = bundled.clone() {
        if p.is_file() {
            return Ok(p);
        }
        tried.push(p);
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pi")
            .join(bin_name);
        if dev_path.is_file() {
            return Ok(dev_path);
        }
        tried.push(dev_path);
    }

    let tried_str = tried
        .iter()
        .map(|p| format!("  - {}", p.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "Could not find embedded pi binary. Tried:\n{}\n\n\
             For dev: run `bun run fetch:pi` from the repo root.\n\
             For release: the .app bundle is missing `resources/pi/{}`. \
             Reinstall Picot.",
        tried_str, bin_name
    ))
}

#[cfg(test)]
mod launch_spec_tests {
    use super::*;

    fn static_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    }

    fn spec_for(runtime_type: NativeRuntimeType, session_path: Option<&Path>) -> NativeLaunchSpec {
        let cwd = std::env::temp_dir();
        native_launch_spec_for(&static_dir(), runtime_type, &cwd, session_path)
            .expect("builder must produce a launch spec")
    }

    #[test]
    fn dedicated_requires_and_carries_explicit_session() {
        assert!(native_launch_spec_for(
            &static_dir(),
            NativeRuntimeType::Dedicated,
            &std::env::temp_dir(),
            None
        )
        .is_err());
        let session = std::env::temp_dir().join("picot-launch-spec-dedicated.jsonl");
        std::fs::write(&session, b"").unwrap();
        let spec = spec_for(NativeRuntimeType::Dedicated, Some(&session));
        let description = spec.command_description();
        assert_eq!(description.runtime_type, NativeRuntimeType::Dedicated);
        assert!(description.args.contains(&"--session".to_string()));
        assert!(description
            .args
            .contains(&session.to_string_lossy().into_owned()));
        assert!(!description.args.contains(&"--no-session".to_string()));
        assert!(!description.args.contains(&"--no-tools".to_string()));
    }

    #[test]
    fn side_chat_is_sessionless() {
        let spec = spec_for(NativeRuntimeType::SideChat, None);
        let description = spec.command_description();
        assert_eq!(description.runtime_type, NativeRuntimeType::SideChat);
        assert!(description.args.contains(&"--no-session".to_string()));
        assert!(!description.args.contains(&"--session".to_string()));
        assert!(!description.args.contains(&"--no-tools".to_string()));
    }

    #[test]
    fn quick_chat_is_sessionless_and_toolless_with_secret() {
        let spec = spec_for(NativeRuntimeType::QuickChat, None);
        let description = spec.command_description();
        assert_eq!(description.runtime_type, NativeRuntimeType::QuickChat);
        assert!(description.args.contains(&"--no-session".to_string()));
        assert!(description.args.contains(&"--no-tools".to_string()));
        assert!(description
            .environment
            .contains_key("PI_STUDIO_SKILL_INSTALL_SECRET"));
    }

    #[test]
    fn standby_is_sessionless_and_tool_flag_is_caller_controlled() {
        let mut spec = spec_for(NativeRuntimeType::Standby, None);
        let description = spec.command_description();
        assert_eq!(description.runtime_type, NativeRuntimeType::Standby);
        assert!(description.args.contains(&"--no-session".to_string()));
        assert!(!description.args.contains(&"--no-tools".to_string()));

        // Side-chat standby pool variant: toolless standby.
        spec.no_tools = true;
        let description = spec.command_description();
        assert!(description.args.contains(&"--no-tools".to_string()));
    }

    #[test]
    fn sessionless_types_reject_session_paths() {
        let session = std::env::temp_dir().join("picot-launch-spec-reject.jsonl");
        std::fs::write(&session, b"").unwrap();
        for runtime_type in [
            NativeRuntimeType::SideChat,
            NativeRuntimeType::QuickChat,
            NativeRuntimeType::Standby,
        ] {
            assert!(native_launch_spec_for(
                &static_dir(),
                runtime_type,
                &std::env::temp_dir(),
                Some(&session)
            )
            .is_err());
        }
    }
}
