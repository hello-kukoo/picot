// ABOUTME: Bounded both-scope subagent disk candidates with metadata-only list and restricted detail.
// ABOUTME: Unproven live discovery or opaque sources always deny name-level write qualification.
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 512 * 1024;
const MAX_FILES: usize = 2_000;
const MAX_DEPTH: usize = 12;

#[derive(Clone, Copy, Debug, Default)]
pub struct ParityEvidence {
    pub verified: bool,
    pub runtime_names_bounded: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub runtime_name: String,
    pub local_name: String,
    pub source: String,
    pub source_scope: String,
    pub package_identity: Option<String>,
    pub file_path: Option<PathBuf>,
    pub parsed_fields: Value,
    pub status: String,
    pub winner_id: Option<String>,
    pub read_only: bool,
    pub native_override_supported: bool,
    pub write_qualified: bool,
    pub write_diagnostic: Option<Diagnostic>,
    pub saved_override: Value,
    pub inferred_value: Option<Value>,
    pub settings_revision: String,
    #[serde(skip)]
    pub(crate) aliases: Vec<String>,
    #[serde(skip)]
    detail_root: Option<PathBuf>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub additional_scopes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionContext {
    pub mode: &'static str,
    pub reason: Option<String>,
    pub project_writes_allowed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub agent_root: PathBuf,
    pub workspace_root: Option<PathBuf>,
    pub project_root: Option<PathBuf>,
    pub resolution_context: ResolutionContext,
    pub entries: Vec<Candidate>,
    pub diagnostics: Vec<Diagnostic>,
    pub inventory_revision: String,
    pub settings_revisions: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct RootResolution {
    pub project_root: Option<PathBuf>,
    pub project_writes_allowed: bool,
}

pub fn project_root_for_extension(workspace: &Path, settings: &Value) -> RootResolution {
    let workspace = match workspace.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return RootResolution {
                project_root: None,
                project_writes_allowed: false,
            }
        }
    };
    let mut candidates = vec![];
    for path in workspace.ancestors() {
        if path.join(".pi").is_dir() || path.join(".agents").is_dir() {
            candidates.push(path.to_path_buf());
        }
    }
    let mut selected = candidates.first().cloned();
    if settings
        .pointer("/subagents/projectRootResolution")
        .and_then(Value::as_str)
        == Some("git-root")
    {
        if let Some(git) = workspace
            .ancestors()
            .find(|path| path.join(".git").exists())
        {
            if candidates.iter().any(|candidate| candidate == git) {
                selected = Some(git.to_path_buf());
            }
        }
    }
    RootResolution {
        project_writes_allowed: selected.as_deref() == Some(workspace.as_path()),
        project_root: selected,
    }
}

fn diagnostic(source: &str, message: &str) -> Diagnostic {
    Diagnostic {
        source: source.to_string(),
        message: message.to_string(),
    }
}

fn bounded(path: &Path) -> Result<Vec<u8>, &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "unreadable")?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err("non-regular or oversized file");
    }
    let bytes = fs::read(path).map_err(|_| "unreadable")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("oversized file");
    }
    Ok(bytes)
}

fn settings(path: &Path, diagnostics: &mut Vec<Diagnostic>) -> Value {
    if !path.exists() {
        return json!({});
    }
    match bounded(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
    {
        Some(value) => value,
        None => {
            diagnostics.push(diagnostic(
                "settings",
                "invalid settings; discovery incomplete",
            ));
            json!({})
        }
    }
}

// Pi 0.73.1 uses a permissive frontmatter parser, not full YAML. Reject ambiguous
// values instead of manufacturing a valid winner from a malformed definition.
fn frontmatter(raw: &str) -> Result<(String, String, String, Vec<String>, String), &'static str> {
    let mut lines = raw.lines();
    if lines.next() != Some("---") {
        return Err("missing frontmatter");
    }
    let mut fields = BTreeMap::new();
    let mut closed = false;
    let mut last = String::new();
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if !line.starts_with(char::is_whitespace) {
                if !key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    return Err("unsupported frontmatter");
                }
                if matches!(
                    key,
                    "name" | "description" | "package" | "runner" | "alias" | "aliases"
                ) && (value.trim().starts_with('[') || value.trim().starts_with('{'))
                {
                    return Err("unsupported frontmatter");
                }
                last = key.to_string();
                fields.insert(
                    last.clone(),
                    value
                        .trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .to_string(),
                );
                continue;
            }
        }
        if line.trim_start().starts_with("- ") && (last == "aliases" || last == "alias") {
            fields.entry(last.clone()).and_modify(|value: &mut String| {
                value.push(',');
                value.push_str(line.trim_start().trim_start_matches("- "));
            });
        } else if last == "runner" && line.trim_start().starts_with("type:") {
            fields.insert(
                "runner".to_string(),
                line.trim_start()
                    .trim_start_matches("type:")
                    .trim()
                    .to_string(),
            );
        } else if !line.trim().is_empty() && !line.trim_start().starts_with('#') {
            return Err("unsupported frontmatter");
        }
    }
    if !closed {
        return Err("unterminated frontmatter");
    }
    let required = |key| {
        fields
            .get(key)
            .filter(|v| !v.trim().is_empty())
            .cloned()
            .ok_or("missing name or description")
    };
    let name = required("name")?;
    let description = required("description")?;
    let package = fields
        .get("package")
        .filter(|v| !v.is_empty() && *v != "false")
        .map(|v| {
            v.to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join("-")
                .chars()
                .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-' || *c == '.')
                .collect::<String>()
        });
    if package.as_ref().is_some_and(|v| v.is_empty()) {
        return Err("invalid package name");
    }
    let runtime = package.map_or_else(|| name.clone(), |prefix| format!("{prefix}.{name}"));
    let aliases = fields
        .get("aliases")
        .or_else(|| fields.get("alias"))
        .map_or_else(Vec::new, |v| {
            v.split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect()
        });
    let runner = fields
        .get("runner")
        .cloned()
        .unwrap_or_else(|| "native".to_string());
    Ok((runtime, name, description, aliases, runner))
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>, diagnostics: &mut Vec<Diagnostic>) {
    fn visit(
        path: &Path,
        depth: usize,
        files: &mut Vec<PathBuf>,
        diagnostics: &mut Vec<Diagnostic>,
    ) {
        if depth > MAX_DEPTH || files.len() >= MAX_FILES {
            diagnostics.push(diagnostic("scan", "discovery budget exhausted"));
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            if path.exists() {
                diagnostics.push(diagnostic("scan", "unreadable source"));
            }
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if files.len() >= MAX_FILES {
                diagnostics.push(diagnostic("scan", "discovery budget exhausted"));
                break;
            }
            let file = entry.path();
            let Ok(kind) = entry.file_type() else {
                diagnostics.push(diagnostic("scan", "unreadable entry"));
                continue;
            };
            if kind.is_dir() {
                visit(&file, depth + 1, files, diagnostics);
            } else if kind.is_file()
                && file.extension().is_some_and(|ext| ext == "md")
                && !file.to_string_lossy().ends_with(".chain.md")
            {
                files.push(file);
            } else if kind.is_symlink() {
                diagnostics.push(diagnostic("scan", "symlink source omitted"));
            }
        }
    }
    visit(dir, 0, files, diagnostics);
}

fn package_roots(
    dir: &Path,
    settings: &Value,
    roots: &mut BTreeMap<PathBuf, BTreeSet<String>>,
    scope: &str,
) {
    let add = |path: PathBuf, roots: &mut BTreeMap<PathBuf, BTreeSet<String>>| {
        if let Ok(real) = path.canonicalize() {
            roots.entry(real).or_default().insert(scope.to_string());
        }
    };
    add(dir.to_path_buf(), roots); // project root package.json
    let npm = dir.join("npm/node_modules");
    if let Ok(items) = fs::read_dir(npm) {
        for item in items.flatten() {
            let path = item.path();
            if path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('@'))
            {
                if let Ok(scoped) = fs::read_dir(path) {
                    for nested in scoped.flatten() {
                        add(nested.path(), roots);
                    }
                }
            } else {
                add(path, roots);
            }
        }
    }
    if let Some(packages) = settings.get("packages").and_then(Value::as_array) {
        for item in packages {
            let Some(source) = item
                .as_str()
                .or_else(|| item.get("source").and_then(Value::as_str))
            else {
                continue;
            };
            let path = if let Some(path) = source.strip_prefix("file:") {
                dir.join(path)
            } else if let Some(name) = source.strip_prefix("npm:") {
                dir.join("npm/node_modules").join(name)
            } else if let Some(spec) = source.strip_prefix("git:") {
                let Some(relative) = git_package_path(spec) else {
                    continue;
                };
                dir.join("git").join(relative)
            } else if source == "."
                || source == ".."
                || source.starts_with("./")
                || source.starts_with("../")
                || Path::new(source).is_absolute()
            {
                dir.join(source)
            } else {
                continue;
            }; // undeclared system npm/git-cache contents stay opaque (diagnostic below)
            add(path, roots);
        }
    }
}

// Mirrors pi-subagents resolveSettingsPackagePath for git: sources (agents.js:163-191).
fn git_package_path(spec: &str) -> Option<PathBuf> {
    let (host, repo) = if let Some(rest) = spec.trim().strip_prefix("git@") {
        rest.split_once(':')?
    } else {
        let rest = spec.split_once("://").map(|(_, rest)| rest).unwrap_or(spec);
        rest.split_once('/')?
    };
    if host.is_empty() || repo.is_empty() {
        return None;
    }
    Some(PathBuf::from(host).join(repo.trim_end_matches(".git")))
}

pub fn inventory(
    agent_root: &Path,
    workspace: Option<&Path>,
    parity: ParityEvidence,
) -> Result<Inventory, String> {
    let agent_root = agent_root
        .canonicalize()
        .map_err(|_| "agent root unavailable".to_string())?;
    let workspace_root = workspace
        .map(Path::canonicalize)
        .transpose()
        .map_err(|_| "workspace root unavailable".to_string())?;
    let mut diagnostics = Vec::new();
    let user = settings(&agent_root.join("settings.json"), &mut diagnostics);
    let root = workspace_root
        .as_ref()
        .map(|cwd| project_root_for_extension(cwd, &json!({})));
    let project_root = root.as_ref().and_then(|r| r.project_root.clone());
    let project = project_root
        .as_ref()
        .map(|root| settings(&root.join(".pi/settings.json"), &mut diagnostics))
        .unwrap_or_else(|| json!({}));
    let root = workspace_root
        .as_ref()
        .map(|cwd| project_root_for_extension(cwd, &project));
    let project_root = root.as_ref().and_then(|r| r.project_root.clone());
    let writes_allowed = root.as_ref().is_none_or(|r| r.project_writes_allowed);
    if !writes_allowed {
        diagnostics.push(diagnostic(
            "project",
            "extension project root differs from workspace root; project writes disabled",
        ));
    }
    let mut roots = BTreeMap::<PathBuf, BTreeSet<String>>::new();
    package_roots(&agent_root, &user, &mut roots, "user");
    if let Some(project_root) = &project_root {
        package_roots(&project_root.join(".pi"), &project, &mut roots, "project");
        package_roots(project_root, &project, &mut roots, "root");
    }
    // Out-of-scope sources remain opaque, even if enumerable: never open their .md files.
    for source in [
        ".agents/",
        "agentScanDirs",
        "PI_SUBAGENT_EXTRA_AGENT_DIRS",
        "runtime registrations",
        "system npm / git cache",
    ] {
        diagnostics.push(diagnostic(
            source,
            "out-of-scope occupancy not verified; no definition body read",
        ));
    }
    let mut entries = Vec::new();
    let mut seen_files = BTreeMap::<PathBuf, usize>::new();
    struct SourceDir {
        directory: PathBuf,
        source: &'static str,
        source_scope: &'static str,
        package_identity: Option<String>,
        builtin: bool,
        extra_scopes: Vec<String>,
    }
    impl SourceDir {
        fn new(directory: PathBuf, source: &'static str, source_scope: &'static str) -> Self {
            Self {
                directory,
                source,
                source_scope,
                package_identity: None,
                builtin: false,
                extra_scopes: vec![],
            }
        }
    }
    let mut sources: Vec<SourceDir> =
        vec![SourceDir::new(agent_root.join("agents"), "user", "global")];
    if let Some(root) = &project_root {
        sources.push(SourceDir::new(
            root.join(".pi/agents"),
            "project",
            "project",
        ));
    }
    // Builtins are bundled with the installed extension; if unavailable they are not invented.
    // Bulk disable mirrors agents.js:1271-1272: explicit project flag wins, else user flag.
    let builtin_disabled = match project_root
        .is_some()
        .then(|| {
            project
                .pointer("/subagents/disableBuiltins")
                .and_then(Value::as_bool)
        })
        .flatten()
    {
        Some(flag) => flag,
        None => user
            .pointer("/subagents/disableBuiltins")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let builtin_dir = agent_root.join("npm/node_modules/pi-subagents/agents");
    if builtin_disabled {
        diagnostics.push(diagnostic(
            "builtin",
            "builtins disabled by settings; runtime names unverified",
        ));
    } else {
        let mut builtin_source = SourceDir::new(builtin_dir.clone(), "builtin", "global");
        builtin_source.builtin = true;
        sources.push(builtin_source);
        if !builtin_dir.is_dir() {
            diagnostics.push(diagnostic(
                "builtin",
                "installed extension builtins unavailable; names unknown",
            ));
        }
    }
    for (root, scopes) in roots {
        let manifest = root.join("package.json");
        let Ok(bytes) = bounded(&manifest) else {
            continue;
        };
        let Ok(pkg) = serde_json::from_slice::<Value>(&bytes) else {
            diagnostics.push(diagnostic("package", "invalid manifest"));
            continue;
        };
        let identity = pkg
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unnamed")
            .to_string();
        for key in [pkg.get("pi-subagents"), pkg.pointer("/pi/subagents")]
            .into_iter()
            .flatten()
        {
            if let Some(paths) = key.get("agents").and_then(Value::as_array) {
                for relative in paths.iter().filter_map(Value::as_str) {
                    let directory = root.join(relative);
                    if directory
                        .canonicalize()
                        .ok()
                        .is_some_and(|path| path.starts_with(&root))
                    {
                        let scope = if scopes.contains("project") || scopes.contains("root") {
                            "project"
                        } else {
                            "global"
                        };
                        // One physical root shared by user and project gets one identity
                        // with dual-source annotation instead of duplicate entries.
                        let extra = if scope == "project" && scopes.contains("user") {
                            vec!["global".to_string()]
                        } else {
                            vec![]
                        };
                        let mut package_source = SourceDir::new(directory, "package", scope);
                        package_source.package_identity = Some(identity.clone());
                        package_source.extra_scopes = extra;
                        sources.push(package_source);
                    } else {
                        diagnostics
                            .push(diagnostic("package", "manifest path outside package root"));
                    }
                }
            }
        }
    }
    for item in sources {
        let SourceDir {
            directory,
            source,
            source_scope,
            package_identity,
            builtin,
            extra_scopes,
        } = item;
        let directory = match directory.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        let mut files = vec![];
        walk(&directory, &mut files, &mut diagnostics);
        for file in files {
            let Ok(canonical) = file.canonicalize() else {
                continue;
            };
            if !canonical.starts_with(directory.canonicalize().unwrap_or_default()) {
                continue;
            }
            if let Some(index) = seen_files.get(&canonical) {
                let entry: &mut Candidate = &mut entries[*index];
                if !entry
                    .additional_scopes
                    .iter()
                    .any(|scope| scope == source_scope)
                    && entry.source_scope != source_scope
                {
                    entry.additional_scopes.push(source_scope.to_string());
                }
                continue;
            }
            let raw = match bounded(&canonical)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
            {
                Some(raw) => raw,
                None => {
                    diagnostics.push(diagnostic(
                        source,
                        "unreadable, oversized or non-UTF-8 definition",
                    ));
                    continue;
                }
            };
            let (runtime_name, local_name, description, aliases, runner) = match frontmatter(&raw) {
                Ok(fields) => fields,
                Err(reason) => {
                    diagnostics.push(diagnostic(source, reason));
                    continue;
                }
            };
            let mut hasher = Sha256::new();
            hasher.update(canonical.to_string_lossy().as_bytes());
            hasher.update(runtime_name.as_bytes());
            hasher.update(local_name.as_bytes());
            hasher.update(description.as_bytes());
            for alias in &aliases {
                hasher.update(alias.as_bytes());
            }
            hasher.update(runner.as_bytes());
            let id = format!("{:x}", hasher.finalize());
            let layer = if source_scope == "project" {
                &project
            } else {
                &user
            };
            let saved_override = layer
                .pointer("/subagents/agentOverrides")
                .and_then(|v| v.get(&runtime_name))
                .map(|v| json!({ "model": v.get("model"), "thinking": v.get("thinking") }))
                .unwrap_or_else(|| json!({}));
            // Byte-exact file revision (missing-file sentinel included) so the
            // override transaction's expectedRevision compares apples to apples.
            let settings_path = if source_scope == "project" {
                project_root
                    .as_deref()
                    .map(|root| root.join(".pi/settings.json"))
            } else {
                None
            }
            .unwrap_or_else(|| agent_root.join("settings.json"));
            let settings_revision = crate::host_config::revision_of(&settings_path);
            seen_files.insert(canonical.clone(), entries.len());
            entries.push(Candidate { id, runtime_name, local_name: local_name.clone(), source: source.to_string(), source_scope: source_scope.to_string(), package_identity: package_identity.clone(), file_path: (!builtin).then_some(canonical), parsed_fields: json!({ "name": local_name, "description": description, "runner": runner }), status: "candidate".into(), winner_id: None, read_only: true, native_override_supported: runner == "native", write_qualified: false, write_diagnostic: Some(diagnostic("parity", "winner or out-of-scope occupancy unverified")), saved_override, inferred_value: None, settings_revision, aliases, detail_root: (!builtin).then_some(directory.clone()), additional_scopes: extra_scopes.clone() });
        }
    }
    let rank = |source: &str| match source {
        "builtin" => 0,
        "package" => 1,
        "user" => 2,
        _ => 3,
    };
    entries.sort_by(|a, b| {
        a.runtime_name
            .cmp(&b.runtime_name)
            .then(rank(&a.source).cmp(&rank(&b.source)))
            .then(a.id.cmp(&b.id))
    });
    // Compute internal name/alias collisions even though parity does not authorize winners.
    let mut names = BTreeMap::<String, Vec<String>>::new();
    for entry in &entries {
        for name in std::iter::once(&entry.runtime_name).chain(entry.aliases.iter()) {
            names
                .entry(name.clone())
                .or_default()
                .push(entry.id.clone());
        }
    }
    if names.values().any(|ids| ids.len() > 1) {
        diagnostics.push(diagnostic(
            "collision",
            "duplicate runtime name or alias; runtime winner unverified",
        ));
    }
    let mut hash = Sha256::new();
    for entry in &entries {
        hash.update(entry.id.as_bytes());
        hash.update(entry.source_scope.as_bytes());
        for scope in &entry.additional_scopes {
            hash.update(scope.as_bytes());
        }
        for alias in &entry.aliases {
            hash.update(alias.as_bytes());
        }
    }
    for item in &diagnostics {
        hash.update(item.source.as_bytes());
        hash.update(item.message.as_bytes());
    }
    // A boolean alone cannot supply a live snapshot or prove runtime registrations.
    if parity.verified || parity.runtime_names_bounded {
        diagnostics.push(diagnostic(
            "parity",
            "live snapshot not supplied; disk candidates only",
        ));
    }
    let mode = "disk-candidates-only";
    let mut settings_revisions = BTreeMap::new();
    settings_revisions.insert(
        "global".into(),
        crate::host_config::revision_of(&agent_root.join("settings.json")),
    );
    if let Some(root) = &workspace_root {
        settings_revisions.insert(
            "project".into(),
            crate::host_config::revision_of(&root.join(".pi/settings.json")),
        );
    }
    Ok(Inventory {
        agent_root,
        workspace_root,
        project_root,
        resolution_context: ResolutionContext {
            mode,
            reason: Some("live /run winner and runtime registrations not observable".into()),
            project_writes_allowed: writes_allowed,
        },
        entries,
        diagnostics,
        inventory_revision: format!("{:x}", hash.finalize()),
        settings_revisions,
    })
}

/// Discovery-parser confirmation for a serialized definition: returns the
/// runtime name and description the bounded frontmatter parser would read
/// back. Malformed or ambiguous input errors; never invents fields.
pub(crate) fn parse_definition(raw: &str) -> Result<(String, String), &'static str> {
    frontmatter(raw).map(|(runtime, _, description, _, _)| (runtime, description))
}

pub fn resolve_candidate<'a>(inventory: &'a Inventory, id: &str) -> Option<&'a Candidate> {
    inventory.entries.iter().find(|entry| entry.id == id)
}

/// Caller must first authorize scope and rescan with inventory(); IDs are not paths.
pub fn detail(inventory: &Inventory, id: &str) -> Result<String, &'static str> {
    let candidate = resolve_candidate(inventory, id).ok_or("candidate_stale")?;
    let file = candidate.file_path.as_ref().ok_or("candidate_stale")?;
    let scope_root = candidate.detail_root.as_ref().ok_or("candidate_stale")?;
    if !file.starts_with(scope_root) || file.canonicalize().map_err(|_| "candidate_stale")? != *file
    {
        return Err("candidate_stale");
    }
    let raw = String::from_utf8(bounded(file).map_err(|_| "candidate_stale")?)
        .map_err(|_| "candidate_stale")?;
    let (runtime, name, description, aliases, runner) =
        frontmatter(&raw).map_err(|_| "candidate_stale")?;
    if runtime != candidate.runtime_name
        || name != candidate.local_name
        || aliases != candidate.aliases
        || candidate.parsed_fields
            != json!({"name": name, "description": description, "runner": runner})
    {
        return Err("candidate_stale");
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subagents_inventory_both_scope_and_metadata_detail() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(agent.join("agents/nested")).unwrap();
        fs::create_dir_all(workspace.join(".pi/agents")).unwrap();
        let raw =
            "---\nname: different\ndescription: actual\naliases: shortcut\n---\nsecret prompt  \n";
        fs::write(agent.join("agents/nested/filename.md"), raw).unwrap();
        fs::write(agent.join("agents/nested/no.chain.md"), raw).unwrap();
        fs::write(
            workspace.join(".pi/agents/other.md"),
            "---\nname: different\ndescription: project\n---\nbody",
        )
        .unwrap();
        let result = inventory(&agent, Some(&workspace), ParityEvidence::default()).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.resolution_context.mode, "disk-candidates-only");
        assert!(result
            .entries
            .iter()
            .all(|e| e.winner_id.is_none() && !e.write_qualified && e.status == "candidate"));
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("secret prompt"));
        assert_eq!(
            detail(&result, &result.entries[0].id).unwrap_or_else(|_| detail(
                &result,
                &result.entries[1].id
            )
            .unwrap()),
            raw
        );
        assert!(detail(&result, "../../etc/passwd").is_err());
    }
    #[test]
    fn subagents_inventory_extra_sources_never_read_body() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        fs::create_dir_all(agent.join(".agents")).unwrap();
        fs::write(agent.join(".agents/hidden.md"), "PRIVATE_SENTINEL").unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"subagents":{"agentScanDirs":[".agents"]}}"#,
        )
        .unwrap();
        let snapshot = inventory(&agent, None, ParityEvidence::default()).unwrap();
        assert!(snapshot.entries.is_empty());
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE_SENTINEL"));
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|d| d.source == "runtime registrations"));
    }
    #[test]
    fn subagents_inventory_manifests_and_root_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        let workspace = root.path().join("workspace");
        let nested = workspace.join("nested");
        fs::create_dir_all(agent.join("npm/node_modules/one/agents")).unwrap();
        fs::create_dir_all(workspace.join(".pi")).unwrap();
        fs::create_dir_all(nested.join(".pi")).unwrap();
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::write(
            nested.join(".pi/settings.json"),
            r#"{"subagents":{"projectRootResolution":"git-root"}}"#,
        )
        .unwrap();
        fs::write(
            agent.join("npm/node_modules/one/package.json"),
            r#"{"name":"one","pi-subagents":{"agents":["agents"]}}"#,
        )
        .unwrap();
        fs::write(
            agent.join("npm/node_modules/one/agents/a.md"),
            "---\nname: a\ndescription: A\npackage: one\n---\nbody",
        )
        .unwrap();
        let result = inventory(&agent, Some(&nested), ParityEvidence::default()).unwrap();
        assert_eq!(result.entries[0].runtime_name, "one.a");
        assert!(!result.resolution_context.project_writes_allowed);
    }
    #[test]
    fn subagents_inventory_empty_roots_and_invalid_definitions() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        let empty = inventory(&agent, None, ParityEvidence::default()).unwrap();
        assert!(empty.entries.is_empty());
        assert_eq!(
            empty.settings_revisions.get("global"),
            Some(&crate::host_config::MISSING_REVISION.to_string())
        );
        assert!(empty
            .diagnostics
            .iter()
            .any(|d| d.source == "builtin" && d.message.contains("unavailable")));
        fs::create_dir_all(agent.join("agents")).unwrap();
        fs::write(
            agent.join("agents/missing-desc.md"),
            "---\nname: x\n---\nbody",
        )
        .unwrap();
        fs::write(
            agent.join("agents/missing-name.md"),
            "---\ndescription: d\n---\nbody",
        )
        .unwrap();
        fs::write(
            agent.join("agents/bad-key.md"),
            "---\nbad key: v\nname: y\ndescription: d\n---\nbody",
        )
        .unwrap();
        fs::write(
            agent.join("agents/nonutf8.md"),
            b"---\nname: \xff\xfe\ndescription: d\n---\nbody",
        )
        .unwrap();
        let mut oversized = String::from("---\nname: big\ndescription: d\n---\n");
        oversized.push_str(&"x".repeat(600 * 1024));
        fs::write(agent.join("agents/oversize.md"), oversized).unwrap();
        let snapshot = inventory(&agent, None, ParityEvidence::default()).unwrap();
        assert!(snapshot.entries.is_empty());
        for needle in [
            "missing name or description",
            "unsupported frontmatter",
            "unreadable, oversized or non-UTF-8 definition",
        ] {
            assert!(
                snapshot.diagnostics.iter().any(|d| d.message == needle),
                "missing diagnostic: {needle}"
            );
        }
    }
    #[test]
    fn subagents_inventory_manifest_keys_git_file_and_project_root_packages() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(agent.join("npm/node_modules/npm-pkg/agents")).unwrap();
        fs::write(
            agent.join("npm/node_modules/npm-pkg/package.json"),
            r#"{"name":"npm-pkg","pi":{"subagents":{"agents":["agents"]}}}"#,
        )
        .unwrap();
        fs::write(
            agent.join("npm/node_modules/npm-pkg/agents/n.md"),
            "---\nname: n\ndescription: N\n---\nbody",
        )
        .unwrap();
        fs::create_dir_all(root.path().join("file-pkg/agents")).unwrap();
        fs::write(
            root.path().join("file-pkg/package.json"),
            r#"{"name":"file-pkg","pi-subagents":{"agents":["agents"]}}"#,
        )
        .unwrap();
        fs::write(
            root.path().join("file-pkg/agents/f.md"),
            "---\nname: f\ndescription: F\n---\nbody",
        )
        .unwrap();
        fs::create_dir_all(agent.join("git/github.com/org/git-pkg/agents")).unwrap();
        fs::write(
            agent.join("git/github.com/org/git-pkg/package.json"),
            r#"{"name":"git-pkg","pi-subagents":{"agents":["agents"]}}"#,
        )
        .unwrap();
        fs::write(
            agent.join("git/github.com/org/git-pkg/agents/g.md"),
            "---\nname: g\ndescription: G\n---\nbody",
        )
        .unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":["file:../file-pkg","git:github.com/org/git-pkg"]}"#,
        )
        .unwrap();
        fs::create_dir_all(workspace.join(".pi/agents")).unwrap();
        fs::create_dir_all(workspace.join("rootpkg/agents")).unwrap();
        fs::write(
            workspace.join("package.json"),
            r#"{"name":"rootpkg","pi-subagents":{"agents":["rootpkg/agents"]}}"#,
        )
        .unwrap();
        fs::write(
            workspace.join("rootpkg/agents/r.md"),
            "---\nname: r\ndescription: R\n---\nbody",
        )
        .unwrap();
        let result = inventory(&agent, Some(&workspace), ParityEvidence::default()).unwrap();
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|e| e.runtime_name.as_str())
            .collect();
        for expected in ["n", "f", "g", "r"] {
            assert!(names.contains(&expected), "missing {expected} in {names:?}");
        }
        let package_entries: Vec<_> = result
            .entries
            .iter()
            .filter(|e| e.source == "package")
            .collect();
        assert!(package_entries.len() >= 4);
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.source.contains("system npm")));
    }
    #[test]
    fn subagents_inventory_builtin_disabled_and_conflict() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        let builtin = agent.join("npm/node_modules/pi-subagents/agents");
        fs::create_dir_all(&builtin).unwrap();
        fs::create_dir_all(agent.join("agents")).unwrap();
        fs::write(
            agent.join("npm/node_modules/pi-subagents/package.json"),
            r#"{"name":"pi-subagents"}"#,
        )
        .unwrap();
        fs::write(
            builtin.join("b.md"),
            "---\nname: common\ndescription: Builtin\n---\nbody",
        )
        .unwrap();
        fs::write(
            agent.join("agents/u.md"),
            "---\nname: common\ndescription: User\n---\nbody",
        )
        .unwrap();
        let result = inventory(&agent, None, ParityEvidence::default()).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(result.entries.iter().any(|e| e.source == "builtin"));
        assert!(result.diagnostics.iter().any(|d| d.source == "collision"));
        fs::write(
            agent.join("settings.json"),
            r#"{"subagents":{"disableBuiltins":true}}"#,
        )
        .unwrap();
        let disabled = inventory(&agent, None, ParityEvidence::default()).unwrap();
        assert!(disabled.entries.iter().all(|e| e.source != "builtin"));
        assert!(disabled
            .diagnostics
            .iter()
            .any(|d| d.source == "builtin" && d.message.contains("disabled")));
    }
    #[test]
    fn subagents_inventory_dual_scope_package_and_write_gate() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        let workspace = root.path().join("workspace");
        let shared = root.path().join("shared");
        fs::create_dir_all(shared.join("agents")).unwrap();
        fs::write(
            shared.join("package.json"),
            r#"{"name":"shared","pi-subagents":{"agents":["agents"]}}"#,
        )
        .unwrap();
        fs::write(
            shared.join("agents/s.md"),
            "---\nname: s\ndescription: S\n---\nbody",
        )
        .unwrap();
        fs::create_dir_all(agent.join("agents")).unwrap();
        fs::write(
            agent.join("agents/user.md"),
            "---\nname: user1\ndescription: U\n---\nbody",
        )
        .unwrap();
        fs::create_dir_all(workspace.join(".pi")).unwrap();
        fs::create_dir_all(workspace.join(".agents")).unwrap();
        fs::write(workspace.join(".agents/extra.md"), "OUT_OF_SCOPE_SENTINEL").unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":["file:../shared"]}"#,
        )
        .unwrap();
        fs::write(
            workspace.join(".pi/settings.json"),
            r#"{"packages":["file:../../shared"]}"#,
        )
        .unwrap();
        let result = inventory(&agent, Some(&workspace), ParityEvidence::default()).unwrap();
        let shared_entry = result
            .entries
            .iter()
            .find(|e| e.runtime_name == "s")
            .expect("shared package entry");
        assert_eq!(shared_entry.source_scope, "project");
        assert!(
            shared_entry
                .additional_scopes
                .contains(&"global".to_string()),
            "dual-source annotation missing"
        );
        assert!(result
            .entries
            .iter()
            .all(|e| !e.write_qualified && e.write_diagnostic.is_some()));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("OUT_OF_SCOPE_SENTINEL"));
        assert!(result.diagnostics.iter().any(|d| d.source == ".agents/"));
    }
}
