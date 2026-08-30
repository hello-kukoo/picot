// ABOUTME: Host data-plane reads for registry-authorized workspaces.
// ABOUTME: Resolves workspace roots through shared MetadataStore authority.
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: FileKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub timestamp: String,
    pub name: Option<String>,
    pub first_message: Option<String>,
    pub workspace_id: String,
    pub file_name: String,
    pub modified_at_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchMatch {
    pub role: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub session_id: String,
    pub session_name: Option<String>,
    pub session_timestamp: String,
    pub first_message: Option<String>,
    pub file_name: String,
    pub matches: Vec<SessionSearchMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboardSummary {
    pub total_cost: f64,
    pub total_tokens: u64,
    pub session_count: u64,
    pub user_message_count: u64,
    pub avg_cost_per_session: f64,
    pub avg_cost_per_user_message: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdownEntry {
    pub name: String,
    pub cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSessionRow {
    pub id: String,
    pub title: String,
    pub model: String,
    pub time: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub user_messages: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboard {
    pub summary: CostDashboardSummary,
    pub by_model: Vec<CostBreakdownEntry>,
    pub by_tool: Vec<CostBreakdownEntry>,
    pub top_sessions: Vec<CostSessionRow>,
}

#[derive(Debug, Default)]
pub(crate) struct SessionMetrics {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) cwd_canonical: Option<PathBuf>,
    pub(crate) model: String,
    pub(crate) timestamp: String,
    pub(crate) last_active: Option<chrono::DateTime<chrono::Utc>>,
    pub(crate) total_cost: f64,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_read: u64,
    pub(crate) cache_write: u64,
    pub(crate) assistant_messages: u64,
    pub(crate) tool_calls: u64,
    pub(crate) user_messages: u64,
    pub(crate) tool_cost_by_name: HashMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostDataError {
    UnknownWorkspace,
    InvalidRelativePath,
    OutsideWorkspace,
    NotDirectory,
    Io(String),
}

#[derive(Clone)]
pub struct HostDataPlane {
    metadata: crate::metadata_store::SharedMetadataStore,
    session_root: Option<PathBuf>,
}

impl HostDataPlane {
    pub fn new(metadata: crate::metadata_store::SharedMetadataStore) -> Self {
        Self {
            metadata,
            session_root: None,
        }
    }

    pub fn workspace_root(&self, workspace_id: &str) -> Result<PathBuf, HostDataError> {
        self.metadata
            .lock()
            .map_err(|_| HostDataError::UnknownWorkspace)?
            .canonical_root_for_workspace_id(workspace_id)
            .map_err(|_| HostDataError::UnknownWorkspace)
    }

    pub fn with_session_root(mut self, session_root: PathBuf) -> Self {
        self.session_root = Some(session_root);
        self
    }

    /// Pi's session-project directory name for a workspace root
    /// (`encodeSessionDirName`): `--` + path without the leading slash with
    /// `/`, `\` and `:` folded to `-`, plus a trailing `--`.
    #[allow(dead_code)]
    fn encode_session_dir_name(workspace_root: &Path) -> Option<String> {
        let text = workspace_root.to_string_lossy();
        let stripped = text.strip_prefix(['/', '\\']).unwrap_or(&text);
        let encoded: String = stripped
            .chars()
            .map(|c| {
                if matches!(c, '/' | '\\' | ':') {
                    '-'
                } else {
                    c
                }
            })
            .collect();
        Some(format!("--{encoded}--"))
    }

    /// Locate the session-project directory for a workspace root: the Pi
    /// encoding first, then a bounded header-sample fallback for dirs Pi
    /// created under a different spelling of the same workspace.
    #[allow(dead_code)]
    pub fn session_dir_for_workspace(&self, workspace_root: &Path) -> Option<PathBuf> {
        let Some(session_root) = &self.session_root else {
            return None;
        };
        // Pi encodes path.resolve(cwd); a canonicalized registry path can
        // drift from the directory spelling Pi actually created, so try both
        // spellings (mirrors the legacy alternateSpellings contract).
        let canonical = workspace_root
            .canonicalize()
            .unwrap_or_else(|_| workspace_root.to_path_buf());
        let mut candidates = vec![workspace_root.to_path_buf(), canonical.clone()];
        candidates.dedup();
        for candidate in &candidates {
            if let Some(encoded) = Self::encode_session_dir_name(candidate) {
                let dir = session_root.join(&encoded);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
        }
        // Header-sample fallback: the majority recorded cwd must match any
        // candidate spelling (raw or canonicalized) of the workspace root.
        for dir in std::fs::read_dir(session_root).ok()?.filter_map(Result::ok) {
            let dir_path = dir.path();
            if !dir_path.is_dir() {
                continue;
            }
            let matches = std::fs::read_dir(&dir_path)
                .ok()?
                .filter_map(Result::ok)
                .filter(|file| {
                    file.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
                })
                .filter_map(|file| parse_session_metrics(&file.path()).ok())
                .flatten()
                .filter_map(|metrics| metrics.cwd_canonical.or(metrics.cwd))
                .any(|cwd| candidates.iter().any(|candidate| candidate == &cwd));
            if matches {
                return Some(dir_path);
            }
        }
        None
    }

    /// Session file path for a workspace session
    /// (`<sessions>/<encoded-workspace>/<session-id>.jsonl`).
    pub fn session_file_path(&self, workspace_id: &str, session_id: &str) -> Option<PathBuf> {
        let root = self.workspace_root(workspace_id).ok()?;
        let encoded = Self::encode_session_dir_name(&root)?;
        self.session_root.as_ref().map(|session_root| {
            session_root
                .join(encoded)
                .join(format!("{session_id}.jsonl"))
        })
    }

    /// Append a `session_info` name record to a session file (rename).
    #[allow(dead_code)]
    pub fn append_session_info_name(
        &self,
        session_file: &Path,
        name: &str,
    ) -> Result<(), HostDataError> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(session_file)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let record = serde_json::json!({ "type": "session_info", "name": name });
        writeln!(file, "{record}").map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(())
    }

    /// P4 delete-batch: trash-first removal (move into a sibling staging
    /// trash, falling back to permanent unlink), running sessions are
    /// protected, and per-path results follow the legacy contract
    /// `{deleted, errors, running}`.
    #[allow(dead_code)]
    pub fn delete_session_batch(
        &self,
        file_paths: &[String],
        running_session_files: &[String],
    ) -> Result<serde_json::Value, HostDataError> {
        let Some(session_root) = &self.session_root else {
            return Ok(serde_json::json!({ "deleted": 0, "errors": [], "running": [] }));
        };
        let resolved_root = session_root
            .canonicalize()
            .unwrap_or_else(|_| session_root.clone());
        let trash_dir = session_root
            .parent()
            .map(|parent| parent.join(".picot-session-trash"))
            .unwrap_or_else(|| session_root.join(".picot-session-trash"));
        let mut result = serde_json::json!({ "deleted": 0, "errors": [], "running": [] });
        for path in file_paths {
            let path: &str = path;
            let canonical = std::path::PathBuf::from(path)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(path));
            if !path.ends_with(".jsonl")
                || !canonical
                    .to_string_lossy()
                    .starts_with(resolved_root.to_string_lossy().as_ref())
            {
                if let Some(errors) = result["errors"].as_array_mut() {
                    errors.push(serde_json::Value::String(path.to_owned()));
                }
                continue;
            }
            if running_session_files.iter().any(|running| running == path) {
                if let Some(running) = result["running"].as_array_mut() {
                    running.push(serde_json::Value::String(path.to_owned()));
                }
                continue;
            }
            std::fs::create_dir_all(&trash_dir)
                .map_err(|error| HostDataError::Io(error.to_string()))?;
            let target = trash_dir.join(format!(
                "{}.{}",
                canonical
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                uuid::Uuid::new_v4().simple()
            ));
            let removed = std::fs::rename(&canonical, &target)
                .or_else(|_| std::fs::remove_file(&canonical))
                .is_ok();
            if removed {
                result["deleted"] =
                    serde_json::Value::from(result["deleted"].as_u64().unwrap_or(0) + 1);
            } else if let Some(errors) = result["errors"].as_array_mut() {
                errors.push(serde_json::Value::String(path.to_owned()));
            }
        }
        Ok(result)
    }

    /// Legacy `/api/cost-dashboard` payload (P4 parity): full aggregation
    /// with range/granularity/scope/models parameters over the shared
    /// session tree.
    pub fn cost_dashboard_compat(
        &self,
        workspace_id: &str,
        params: &crate::cost_compat::CostRangeParams,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<serde_json::Value, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        match &self.session_root {
            Some(session_root) => crate::cost_compat::scan_compat_cost_dashboard(
                session_root,
                &workspace,
                params,
                now,
            )
            .map_err(HostDataError::Io),
            None => Ok(crate::cost_compat::empty_payload(params)),
        }
    }

    pub fn file_mentions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<Vec<FileEntry>, HostDataError> {
        const MAX_ENTRIES: usize = 10_000;
        const MAX_RESULTS: usize = 20;
        const MAX_MILLIS: u128 = 500;
        let root = self.workspace_root(workspace_id)?;
        let needle = query.trim().trim_start_matches('@').to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let started = std::time::Instant::now();
        let mut visited = 0usize;
        let mut results = Vec::new();
        fn walk(
            root: &Path,
            dir: &Path,
            needle: &str,
            visited: &mut usize,
            results: &mut Vec<FileEntry>,
            started: std::time::Instant,
        ) {
            if *visited >= MAX_ENTRIES
                || results.len() >= MAX_RESULTS
                || started.elapsed().as_millis() >= MAX_MILLIS
            {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                if *visited >= MAX_ENTRIES
                    || results.len() >= MAX_RESULTS
                    || started.elapsed().as_millis() >= MAX_MILLIS
                {
                    break;
                }
                *visited += 1;
                let path = entry.path();
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                let Ok(canonical) = path.canonicalize() else {
                    continue;
                };
                if !canonical.starts_with(root) {
                    continue;
                }
                let relative = canonical
                    .strip_prefix(root)
                    .unwrap_or(&canonical)
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative.to_lowercase().contains(needle) {
                    results.push(FileEntry {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        relative_path: relative.clone(),
                        kind: if file_type.is_dir() {
                            FileKind::Directory
                        } else {
                            FileKind::File
                        },
                    });
                }
                if file_type.is_dir() {
                    walk(root, &canonical, needle, visited, results, started);
                }
            }
        }
        walk(&root, &root, &needle, &mut visited, &mut results, started);
        Ok(results)
    }

    /// Session root directory for compat handlers that validate absolute
    /// session file paths.
    pub fn session_root_path(&self) -> Option<PathBuf> {
        self.session_root.clone()
    }

    /// Reverse lookup: registered workspace id whose root canonicalizes to
    /// the given path (owner-only system-open validation).
    pub fn workspace_root_for_path(&self, path: &Path) -> Result<String, HostDataError> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.metadata
            .lock()
            .map_err(|_| HostDataError::UnknownWorkspace)?
            .workspace_id_for_canonical_root(&canonical)
            .map_err(|_| HostDataError::UnknownWorkspace)
    }

    pub fn list_files(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<Vec<FileEntry>, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let requested = safe_join(&root, relative_path)?;
        if !requested.is_dir() {
            return Err(HostDataError::NotDirectory);
        }
        let mut entries = std::fs::read_dir(&requested)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                let kind = if file_type.is_dir() {
                    FileKind::Directory
                } else if file_type.is_file() {
                    FileKind::File
                } else {
                    return None;
                };
                let path = entry.path();
                let relative = path.strip_prefix(&root).ok()?;
                Some(FileEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    kind,
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            let left_directory = left.kind == FileKind::Directory;
            let right_directory = right.kind == FileKind::Directory;
            right_directory
                .cmp(&left_directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn list_sessions(&self, workspace_id: &str) -> Result<Vec<SessionSummary>, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        let Some(session_root) = &self.session_root else {
            return Ok(Vec::new());
        };
        if !session_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut sessions = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.path().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(project.path())
                .map_err(|error| HostDataError::Io(error.to_string()))?
                .filter_map(Result::ok)
            {
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(summary) = parse_session_summary(&path, workspace_id, &workspace)? {
                    sessions.push(summary);
                }
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at_ms));
        Ok(sessions)
    }

    pub fn search_sessions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<Vec<SessionSearchResult>, HostDataError> {
        const MAX_RESULTS: usize = 30;
        let workspace = self.workspace_root(workspace_id)?;
        let Some(session_root) = &self.session_root else {
            return Ok(Vec::new());
        };
        let query = query.trim().to_lowercase();
        if query.len() < 2 || !session_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.path().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(project.path())
                .map_err(|error| HostDataError::Io(error.to_string()))?
                .filter_map(Result::ok)
            {
                if results.len() >= MAX_RESULTS {
                    return Ok(results);
                }
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(result) = search_session_file(&path, &workspace, &query)? {
                    results.push(result);
                }
            }
        }
        Ok(results)
    }

    pub fn cost_dashboard(&self, workspace_id: &str) -> Result<CostDashboard, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        let Some(session_root) = &self.session_root else {
            return Ok(CostDashboard::default());
        };
        if !session_root.is_dir() {
            return Ok(CostDashboard::default());
        }
        let mut sessions = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.path().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(project.path())
                .map_err(|error| HostDataError::Io(error.to_string()))?
                .filter_map(Result::ok)
            {
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(metrics) = parse_session_metrics(&path)? {
                    // HostDataPlane is workspace-scoped: only sessions whose
                    // canonical cwd matches the registered workspace root.
                    if metrics.cwd_canonical.as_deref() == Some(&workspace) {
                        sessions.push(metrics);
                    }
                }
            }
        }
        Ok(build_cost_dashboard(sessions))
    }
}

fn find_chars(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn search_session_file(
    path: &Path,
    workspace: &Path,
    query: &str,
) -> Result<Option<SessionSearchResult>, HostDataError> {
    const MAX_MATCHES_PER_SESSION: usize = 3;
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut session_id = None;
    let mut session_timestamp = String::new();
    let mut session_name = None;
    let mut first_message = None;
    let mut cwd = None;
    let mut matches = Vec::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                session_id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                session_timestamp = entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                session_name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            Some("message") => {
                let role = entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                let Some(text) = message_text(entry.pointer("/message/content")) else {
                    continue;
                };
                if role == "user" && first_message.is_none() {
                    first_message = Some(text.chars().take(120).collect::<String>());
                }
                if matches.len() >= MAX_MATCHES_PER_SESSION {
                    continue;
                }
                let lower: Vec<char> = text.to_lowercase().chars().collect();
                let needle: Vec<char> = query.chars().collect();
                if let Some(index) = find_chars(&lower, &needle) {
                    let original: Vec<char> = text.chars().collect();
                    let start = index.saturating_sub(60);
                    let end = (index + needle.len() + 60).min(original.len());
                    let snippet: String = original[start..end].iter().collect();
                    let snippet = format!(
                        "{}{}{}",
                        if start > 0 { "…" } else { "" },
                        snippet.replace('\n', " "),
                        if end < original.len() { "…" } else { "" }
                    );
                    matches.push(SessionSearchMatch { role, snippet });
                }
            }
            _ => {}
        }
    }
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let Some(cwd) = cwd.and_then(|cwd| cwd.canonicalize().ok()) else {
        return Ok(None);
    };
    if cwd != workspace || matches.is_empty() {
        return Ok(None);
    }
    Ok(Some(SessionSearchResult {
        session_id,
        session_name,
        session_timestamp,
        first_message,
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        matches,
    }))
}

/// One-shot, TTL'd, owner-scoped export tokens backing the P4
/// `session_export` control and the streaming
/// `GET /v2/session-export/{token}` route.
///
/// Substrate only: the v2 control wiring has not landed yet, so nothing
/// constructs this registry outside tests.
#[allow(dead_code)]
pub struct SessionExportRegistry {
    tokens: std::sync::Mutex<HashMap<String, (std::path::PathBuf, String, std::time::Instant)>>,
    max_per_owner: usize,
    ttl: std::time::Duration,
}

#[allow(dead_code)]
impl SessionExportRegistry {
    pub fn new(max_per_owner: usize, ttl: std::time::Duration) -> Self {
        Self {
            tokens: std::sync::Mutex::new(HashMap::new()),
            max_per_owner,
            ttl,
        }
    }

    pub fn ttl_secs(&self) -> u64 {
        self.ttl.as_secs()
    }

    /// Mint a one-shot token bound to an owner and a validated session file.
    pub fn issue(
        &self,
        owner: &str,
        file_path: std::path::PathBuf,
    ) -> Result<(String, std::time::Instant), String> {
        let mut tokens = self
            .tokens
            .lock()
            .map_err(|_| "export registry lock poisoned".to_string())?;
        // Expire stale entries for the owner first so the quota reflects
        // only live grants.
        tokens.retain(|_, (_, _, expires)| *expires > std::time::Instant::now());
        let outstanding = tokens
            .values()
            .filter(|(_, owner_id, _)| owner_id == owner)
            .count();
        if outstanding >= self.max_per_owner {
            return Err("export token quota reached".to_string());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let expires = std::time::Instant::now() + self.ttl;
        tokens.insert(token.clone(), (file_path, owner.to_string(), expires));
        Ok((token, expires))
    }

    /// Redeem a token: one-shot. Expired or unknown tokens are rejected and
    /// removed.
    pub fn redeem(&self, token: &str) -> Result<std::path::PathBuf, String> {
        let (_, (file_path, _, expires)) = self
            .tokens
            .lock()
            .map_err(|_| "export registry lock poisoned".to_string())?
            .remove_entry(token)
            .ok_or_else(|| "export token is invalid or expired".to_string())?;
        if expires <= std::time::Instant::now() {
            return Err("export token is invalid or expired".to_string());
        }
        Ok(file_path)
    }

    /// Owner destruction hygiene: drop every outstanding grant.
    pub fn revoke_owner(&self, owner: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.retain(|_, (_, owner_id, _)| owner_id != owner);
        }
    }

    #[cfg(test)]
    pub fn outstanding_for(&self, owner: &str) -> usize {
        self.tokens
            .lock()
            .map(|tokens| {
                tokens
                    .values()
                    .filter(|(_, owner_id, _)| owner_id == owner)
                    .count()
            })
            .unwrap_or(0)
    }
}

pub(crate) fn parse_session_metrics(path: &Path) -> Result<Option<SessionMetrics>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut metrics = SessionMetrics {
        model: "unknown".to_owned(),
        ..SessionMetrics::default()
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(timestamp) = entry.get("timestamp").and_then(serde_json::Value::as_str) {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(timestamp) {
                metrics.last_active = Some(parsed.with_timezone(&chrono::Utc));
            }
        }
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                metrics.id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                metrics.timestamp = entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                metrics.cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                if let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) {
                    metrics.title = name.to_owned();
                }
            }
            Some("model_change") => {
                if let Some(model) = entry.get("model").and_then(serde_json::Value::as_str) {
                    metrics.model = model.to_owned();
                }
            }
            Some("message") => {
                let Some(role) = entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                if role == "user" {
                    metrics.user_messages += 1;
                    continue;
                }
                if role != "assistant" {
                    continue;
                }
                if let Some(model) = entry
                    .pointer("/message/model")
                    .and_then(serde_json::Value::as_str)
                {
                    metrics.model = model.to_owned();
                }
                let usage = entry.pointer("/message/usage");
                let cost = usage
                    .and_then(|usage| usage.pointer("/cost/total"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                metrics.total_cost += cost;
                metrics.input_tokens += usage
                    .and_then(|usage| usage.get("input"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.output_tokens += usage
                    .and_then(|usage| usage.get("output"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.cache_read += usage
                    .and_then(|usage| usage.get("cacheRead"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let tool_calls: Vec<&str> = entry
                    .pointer("/message/content")
                    .and_then(serde_json::Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|block| {
                                block.get("type").and_then(serde_json::Value::as_str)
                                    == Some("toolCall")
                            })
                            .filter_map(|block| {
                                block.get("name").and_then(serde_json::Value::as_str)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !tool_calls.is_empty() && cost > 0.0 {
                    let per_tool_cost = cost / tool_calls.len() as f64;
                    for tool_name in &tool_calls {
                        *metrics
                            .tool_cost_by_name
                            .entry((*tool_name).to_owned())
                            .or_insert(0.0) += per_tool_cost;
                    }
                }
                metrics.tool_calls += tool_calls.len() as u64;
                metrics.assistant_messages += 1;
                metrics.cache_write += usage
                    .and_then(|usage| usage.get("cacheWrite"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
            }
            _ => {}
        }
    }
    if metrics.id.is_empty() {
        return Ok(None);
    }
    // Keep the recorded cwd verbatim (the legacy payload echoes it) and add
    // a canonicalized copy so scope filters compare realpath-to-realpath.
    metrics.cwd_canonical = metrics
        .cwd
        .as_ref()
        .and_then(|cwd| cwd.canonicalize().ok())
        .or_else(|| metrics.cwd.clone());
    if metrics.title.is_empty() {
        metrics.title = "Untitled".to_owned();
    }
    Ok(Some(metrics))
}

fn build_cost_dashboard(sessions: Vec<SessionMetrics>) -> CostDashboard {
    let mut dashboard = CostDashboard::default();
    let mut by_model: Vec<(String, f64)> = Vec::new();
    let mut by_tool: HashMap<String, f64> = HashMap::new();
    for session in &sessions {
        dashboard.summary.total_cost += session.total_cost;
        let session_tokens = session.input_tokens + session.output_tokens + session.cache_read;
        dashboard.summary.total_tokens += session_tokens;
        dashboard.summary.user_message_count += session.user_messages;
        dashboard.summary.session_count += 1;

        match by_model.iter_mut().find(|(name, _)| name == &session.model) {
            Some((_, cost)) => *cost += session.total_cost,
            None => by_model.push((session.model.clone(), session.total_cost)),
        }
        for (tool_name, cost) in &session.tool_cost_by_name {
            *by_tool.entry(tool_name.clone()).or_insert(0.0) += cost;
        }
    }
    dashboard.summary.avg_cost_per_session = if dashboard.summary.session_count > 0 {
        dashboard.summary.total_cost / dashboard.summary.session_count as f64
    } else {
        0.0
    };
    dashboard.summary.avg_cost_per_user_message = if dashboard.summary.user_message_count > 0 {
        dashboard.summary.total_cost / dashboard.summary.user_message_count as f64
    } else {
        0.0
    };
    by_model.sort_by(|left, right| right.1.total_cmp(&left.1));
    dashboard.by_model = by_model
        .into_iter()
        .map(|(name, cost)| CostBreakdownEntry { name, cost })
        .collect();
    let mut by_tool: Vec<(String, f64)> = by_tool.into_iter().collect();
    by_tool.sort_by(|left, right| right.1.total_cmp(&left.1));
    dashboard.by_tool = by_tool
        .into_iter()
        .map(|(name, cost)| CostBreakdownEntry { name, cost })
        .collect();

    let mut top_sessions: Vec<CostSessionRow> = sessions
        .into_iter()
        .map(|session| CostSessionRow {
            id: session.id,
            title: session.title,
            model: session.model,
            time: session.timestamp,
            total_cost: session.total_cost,
            total_tokens: session.input_tokens + session.output_tokens + session.cache_read,
            user_messages: session.user_messages,
        })
        .collect();
    top_sessions.sort_by(|left, right| right.total_cost.total_cmp(&left.total_cost));
    top_sessions.truncate(20);
    dashboard.top_sessions = top_sessions;
    dashboard
}

fn parse_session_summary(
    path: &Path,
    workspace_id: &str,
    workspace: &Path,
) -> Result<Option<SessionSummary>, HostDataError> {
    // Summary fields live in the session header by construction; the hard
    // line cap bounds work on pathological files where no user text block
    // ever appears (the 50-line early exit requires first_message).
    const MAX_SUMMARY_LINES: usize = 200;
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut id = None;
    let mut timestamp = String::new();
    let mut cwd = None;
    let mut name = None;
    let mut first_message = None;
    let mut user_message_count = 0;
    let mut line_count = 0;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        line_count += 1;
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                timestamp = entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            Some("message")
                if entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    == Some("user") =>
            {
                user_message_count += 1;
                if first_message.is_none() {
                    first_message = message_text(entry.pointer("/message/content"))
                        .map(|text| text.chars().take(120).collect());
                }
            }
            _ => {}
        }
        if line_count > 50 && first_message.is_some() {
            break;
        }
        if line_count >= MAX_SUMMARY_LINES {
            break;
        }
    }
    let Some(id) = id else { return Ok(None) };
    if user_message_count == 0 && line_count <= 4 {
        return Ok(None);
    }
    let Some(cwd) = cwd.and_then(|cwd| cwd.canonicalize().ok()) else {
        return Ok(None);
    };
    if cwd != workspace {
        return Ok(None);
    }
    let metadata = std::fs::metadata(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis());
    Ok(Some(SessionSummary {
        id,
        timestamp,
        name,
        first_message,
        workspace_id: workspace_id.to_owned(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        modified_at_ms,
    }))
}

fn message_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .find(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .and_then(|block| block.get("text"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, HostDataError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(HostDataError::InvalidRelativePath);
    }
    let joined = root.join(relative);
    let canonical = joined
        .canonicalize()
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    if !canonical.starts_with(root) {
        return Err(HostDataError::OutsideWorkspace);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::{FileKind, HostDataError, HostDataPlane};
    use crate::metadata_store::MetadataStore;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_data(workspace: &std::path::Path) -> (HostDataPlane, String) {
        let db = std::env::temp_dir().join(format!("picot-host-data-db-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Mutex::new(MetadataStore::open(&db).unwrap()));
        let (row, _) = store.lock().unwrap().add_workspace(workspace).unwrap();
        (HostDataPlane::new(store), row.workspace_id)
    }

    #[test]
    fn delete_session_batch_trashes_protects_running_and_rejects_outside_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-p4-delete-{nonce}"));
        let workspace = temp.join("workspace");
        let sessions = temp.join("sessions");
        let project = sessions.join("--workspace-project--");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&project).unwrap();
        let free = project.join("free.jsonl");
        let running = project.join("running.jsonl");
        fs::write(&free, "{\"type\":\"session\",\"id\":\"free\"}\n").unwrap();
        fs::write(&running, "{\"type\":\"session\",\"id\":\"running\"}\n").unwrap();
        let outside = temp.join("outside.jsonl");
        fs::write(&outside, "{}").unwrap();

        let (data, _workspace_id) = test_data(&workspace);
        let data = data.with_session_root(sessions.clone());

        let result = data
            .delete_session_batch(
                &[
                    free.to_string_lossy().into_owned(),
                    running.to_string_lossy().into_owned(),
                    outside.to_string_lossy().into_owned(),
                ],
                &[running.to_string_lossy().into_owned()],
            )
            .unwrap();

        assert_eq!(result["deleted"], 1);
        assert_eq!(result["running"].as_array().unwrap().len(), 1);
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert!(!free.exists(), "free session must be removed from the tree");
        assert!(running.exists(), "running session must be protected");
        // Trash-first: the free file survives in the staging trash directory.
        let trash = sessions.parent().unwrap().join(".picot-session-trash");
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 1);
    }

    #[test]
    fn session_export_registry_is_one_shot_quota_bound_and_revocable() {
        use super::SessionExportRegistry;
        use std::time::{Duration, Instant};

        let registry = SessionExportRegistry::new(1, Duration::from_secs(60));
        assert_eq!(registry.ttl_secs(), 60);
        let file = std::path::PathBuf::from("/tmp/session.jsonl");
        let (token, expires) = registry
            .issue("owner", file.clone())
            .expect("first grant is issued");
        assert!(expires > Instant::now());
        assert_eq!(registry.outstanding_for("owner"), 1);
        // Quota is per-owner and counts only live grants.
        assert!(registry.issue("owner", file.clone()).is_err());
        assert!(registry.issue("other", file.clone()).is_ok());
        // One-shot: a redeemed token cannot be redeemed twice.
        assert_eq!(registry.redeem(&token), Ok(file));
        assert!(registry.redeem(&token).is_err());
        registry.revoke_owner("other");
        assert_eq!(registry.outstanding_for("other"), 0);

        let expired = SessionExportRegistry::new(4, Duration::ZERO);
        let (stale, _) = expired
            .issue("owner", std::path::PathBuf::from("/tmp/session.jsonl"))
            .expect("grant is issued");
        assert!(expired.redeem(&stale).is_err(), "zero-ttl grant is expired");
    }

    #[test]
    fn session_dir_for_workspace_resolves_by_encoding_then_header_sample() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-p4-dir-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let encoded = format!(
            "--{}--",
            workspace
                .to_string_lossy()
                .trim_start_matches('/')
                .replace('/', "-")
        );
        // Header-sample fallback dir: a name the encoding would never claim.
        let sampled = temp.join("sessions").join("--legacy-name--");
        fs::create_dir_all(&sampled).unwrap();
        fs::write(
            sampled.join("session-x.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"x\",\"cwd\":{}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();

        let (data, _) = test_data(&workspace);
        let data = data.with_session_root(temp.join("sessions"));

        let dir = data
            .session_dir_for_workspace(&workspace)
            .expect("header-sample fallback must locate the project dir");
        assert_eq!(dir, sampled);

        // Deterministic encoding match wins once the Pi-shaped dir exists.
        let exact = temp.join("sessions").join(&encoded);
        fs::create_dir_all(&exact).unwrap();
        assert_eq!(
            data.session_dir_for_workspace(&workspace)
                .expect("encoding match"),
            exact
        );
    }

    #[test]
    fn append_session_info_name_appends_a_valid_record() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_file = std::env::temp_dir().join(format!("picot-p4-rename-{nonce}.jsonl"));
        fs::write(&session_file, "{\"type\":\"session\",\"id\":\"a\"}\n").unwrap();

        let (data, workspace_id) = test_data(std::path::Path::new("/"));
        let _ = workspace_id;
        data.append_session_info_name(&session_file, "Renamed")
            .unwrap();

        let content = fs::read_to_string(&session_file).unwrap();
        let last = content.lines().last().unwrap();
        let record: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(record["type"], "session_info");
        assert_eq!(record["name"], "Renamed");
        let _ = fs::remove_file(&session_file);
    }

    #[test]
    fn lists_registered_workspace_files_and_rejects_escape_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-data-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("README.md"), "read me").unwrap();
        fs::write(temp.join("secret.txt"), "secret").unwrap();
        let (data, workspace_id) = test_data(&workspace);

        let entries = data.list_files(&workspace_id, "").unwrap();
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].kind, FileKind::Directory);
        assert_eq!(entries[1].relative_path, "README.md");
        assert_eq!(
            data.list_files(&workspace_id, "../"),
            Err(HostDataError::InvalidRelativePath)
        );
        assert_eq!(
            data.list_files("missing", ""),
            Err(HostDataError::UnknownWorkspace)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_resolve_outside_the_workspace() {
        use std::os::unix::fs::symlink;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-data-link-{nonce}"));
        let workspace = temp.join("workspace");
        let outside = temp.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, workspace.join("escape")).unwrap();
        let (data, workspace_id) = test_data(&workspace);
        assert_eq!(
            data.list_files(&workspace_id, "escape"),
            Err(HostDataError::OutsideWorkspace)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn lists_only_sessions_owned_by_the_registered_workspace_and_skips_unknown_entries() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-sessions-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"future_entry\",\"payload\":true}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello from session\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("excluded.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"private\"}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let (data, workspace_id) = test_data(&workspace);
        let data = data.with_session_root(temp.join("sessions"));

        let listed = data.list_sessions(&workspace_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-a");
        assert_eq!(
            listed[0].first_message.as_deref(),
            Some("hello from session")
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn searches_only_the_registered_workspace_and_returns_snippets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-search-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"please refactor the widget factory\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("excluded.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"refactor this too\"}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let (data, workspace_id) = test_data(&workspace);
        let data = data.with_session_root(temp.join("sessions"));

        let results = data.search_sessions(&workspace_id, "widget").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].session_id, "session-a");
        assert!(results[0].matches[0].snippet.contains("widget"));

        assert!(
            data.search_sessions(&workspace_id, "refactor")
                .unwrap()
                .len()
                == 1
        );
        assert!(data.search_sessions("missing", "widget").is_err());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn builds_cost_dashboard_scoped_to_the_registered_workspace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-cost-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"input\":10,\"output\":20,\"cost\":{{\"total\":0.5}}}},\"content\":[{{\"type\":\"toolCall\",\"name\":\"bash\"}}]}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("excluded.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"cost\":{{\"total\":99.0}}}}}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let (data, workspace_id) = test_data(&workspace);
        let data = data.with_session_root(temp.join("sessions"));

        let dashboard = data.cost_dashboard(&workspace_id).unwrap();
        assert_eq!(dashboard.summary.session_count, 1);
        assert_eq!(dashboard.summary.total_cost, 0.5);
        assert_eq!(dashboard.summary.total_tokens, 30);
        assert_eq!(dashboard.by_model[0].name, "gpt-5");
        assert_eq!(dashboard.by_tool[0].name, "bash");
        assert_eq!(dashboard.top_sessions[0].id, "session-a");
        fs::remove_dir_all(temp).unwrap();
    }
}
