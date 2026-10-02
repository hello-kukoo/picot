// ABOUTME: Runs embedded Pi MCP CLI commands without exposing credentials to the host.
// ABOUTME: Tracks owner-bound login operations, process-tree cancellation and cached server reports.
use crate::host_control::HostEventSink;
use crate::oauth_manager::{OAuthClient, OAuthManager, OAuthOutcome, OAuthStatus};
use crate::window_owner::OwnerId;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const LOGIN_TTL: Duration = Duration::from_secs(360);
const CACHE_TTL: Duration = Duration::from_secs(60);

struct Running {
    child: Child,
    tree: crate::process_tree::ProcessTree,
}
struct Login {
    name: String,
    owner: OwnerId,
    generation: u64,
    auth_url: Option<String>,
    error: Option<String>,
    process: Option<Arc<Mutex<Running>>>,
}
#[derive(Clone)]
pub(crate) struct McpLoginRunner {
    inner: Arc<Mutex<HashMap<String, Login>>>,
    cache: Arc<Mutex<HashMap<PathBuf, (Instant, Value)>>>,
    cache_epoch: Arc<AtomicU64>,
    oauth: Arc<Mutex<OAuthManager>>,
    events: HostEventSink,
}

fn command(binary: &Path, cwd: &Path, action: &str, name: Option<&str>) -> Command {
    let mut cmd = Command::new(binary);
    crate::windows_child::hide_console(&mut cmd);
    cmd.current_dir(cwd).arg("mcp").arg(action);
    if let Some(name) = name {
        cmd.arg(name);
    }
    if action == "login" {
        cmd.args(["--timeout", "300"]);
    } else if action == "list" {
        cmd.arg("--json");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

#[derive(Default)]
struct UrlParser(bool);
impl UrlParser {
    fn feed(&mut self, line: &str, name: &str) -> Option<String> {
        if self.0 {
            self.0 = false;
            let candidate = line.trim();
            if (candidate.starts_with("https://") || candidate.starts_with("http://"))
                && !candidate.chars().any(char::is_whitespace)
                && candidate.len() <= 8192
            {
                return Some(candidate.to_owned());
            }
        }
        self.0 = line.trim() == format!("Sign in to MCP server \"{name}\" in your browser:");
        None
    }
}

fn status_name(status: &OAuthStatus) -> &'static str {
    match status {
        OAuthStatus::Pending => "pending",
        OAuthStatus::Succeeded => "succeeded",
        OAuthStatus::Failed => "failed",
        OAuthStatus::Cancelled => "cancelled",
    }
}
fn emit(
    events: &HostEventSink,
    owner: &OwnerId,
    id: &str,
    status: OAuthStatus,
    url: Option<&str>,
    error: Option<&str>,
) {
    let mut payload = json!({ "operationId": id, "status": status_name(&status) });
    if let Some(url) = url {
        payload["authUrl"] = json!(url);
    }
    if let Some(error) = error {
        payload["error"] = json!(error);
    }
    events.send_owner_event(
        owner,
        json!({ "type": "mcpLoginUpdate", "payload": payload }),
    );
}
impl McpLoginRunner {
    pub(crate) fn new(oauth: Arc<Mutex<OAuthManager>>, events: HostEventSink) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            cache: Arc::new(Mutex::new(HashMap::new())),
            cache_epoch: Arc::new(AtomicU64::new(0)),
            oauth,
            events,
        }
    }
    pub(crate) fn start(
        &self,
        binary: &Path,
        cwd: &Path,
        name: &str,
        owner: &OwnerId,
    ) -> Result<String, String> {
        if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return Err("Invalid MCP server name".into());
        }
        let mut entries = self.inner.lock().map_err(|_| "MCP manager unavailable")?;
        let mut oauth = self.oauth.lock().map_err(|_| "OAuth manager unavailable")?;
        entries.retain(|id, entry| {
            oauth
                .status(entry.owner.as_str(), entry.generation, id)
                .is_ok()
        });
        if entries.iter().any(|(id, entry)| {
            entry.name == name
                && entry.process.is_some()
                && oauth.status(entry.owner.as_str(), entry.generation, id)
                    == Ok(OAuthStatus::Pending)
        }) {
            return Err("MCP login already active for this server".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let generation = oauth.generation();
        oauth
            .start(OAuthClient::Desktop, owner.as_str(), &id, LOGIN_TTL)
            .map_err(|e| e.code().to_owned())?;
        let mut cmd = command(binary, cwd, "login", Some(name));
        crate::process_tree::configure_child(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = oauth.complete(owner.as_str(), generation, &id, OAuthOutcome::Failed);
                return Err(format!("Cannot start MCP login: {error}"));
            }
        };
        let tree = match crate::process_tree::ProcessTree::attach(&mut child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = oauth.complete(owner.as_str(), generation, &id, OAuthOutcome::Failed);
                return Err(error);
            }
        };
        let stdout = child.stdout.take().ok_or("MCP stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("MCP stderr unavailable")?;
        let process = Arc::new(Mutex::new(Running { child, tree }));
        entries.insert(
            id.clone(),
            Login {
                name: name.to_owned(),
                owner: owner.clone(),
                generation,
                auth_url: None,
                error: None,
                process: Some(process.clone()),
            },
        );
        drop(oauth);
        drop(entries);
        let runner = self.clone();
        let id_worker = id.clone();
        let name_worker = name.to_owned();
        std::thread::spawn(move || {
            let stderr_thread = std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = stderr.take(64 * 1024).read_to_end(&mut buf);
            });
            let url_runner = runner.clone();
            let url_id = id_worker.clone();
            let stdout_thread = std::thread::spawn(move || {
                let mut parser = UrlParser::default();
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Some(url) = parser.feed(&line, &name_worker) {
                        if let Ok(mut entries) = url_runner.inner.lock() {
                            if let Some(entry) = entries.get_mut(&url_id) {
                                if url_runner.oauth.lock().ok().and_then(|mut oauth| {
                                    oauth
                                        .status(entry.owner.as_str(), entry.generation, &url_id)
                                        .ok()
                                }) == Some(OAuthStatus::Pending)
                                {
                                    entry.auth_url = Some(url.clone());
                                    emit(
                                        &url_runner.events,
                                        &entry.owner,
                                        &url_id,
                                        OAuthStatus::Pending,
                                        Some(&url),
                                        None,
                                    );
                                }
                            }
                        }
                    }
                }
            });
            let result = loop {
                let result = process
                    .lock()
                    .map_err(|_| "MCP process unavailable".to_owned())
                    .and_then(|mut running| running.child.try_wait().map_err(|e| e.to_string()));
                match result {
                    Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                    Ok(Some(exit)) => break Ok(exit.success()),
                    Err(error) => break Err(error),
                }
            };
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            let mut entries = match runner.inner.lock() {
                Ok(entries) => entries,
                Err(_) => return,
            };
            let Some(entry) = entries.get_mut(&id_worker) else {
                return;
            };
            entry.process = None;
            let Ok(mut oauth) = runner.oauth.lock() else {
                return;
            };
            if oauth.status(entry.owner.as_str(), entry.generation, &id_worker)
                != Ok(OAuthStatus::Pending)
            {
                return;
            }
            let status = if result == Ok(true) {
                OAuthStatus::Succeeded
            } else {
                OAuthStatus::Failed
            };
            if status == OAuthStatus::Failed {
                // Pi stderr may contain OAuth callback details: never persist it in host state.
                entry.error = Some("MCP login failed; see Pi logs".into());
            }
            if oauth
                .complete(
                    entry.owner.as_str(),
                    entry.generation,
                    &id_worker,
                    if status == OAuthStatus::Succeeded {
                        OAuthOutcome::Succeeded
                    } else {
                        OAuthOutcome::Failed
                    },
                )
                .is_ok()
            {
                if status == OAuthStatus::Succeeded {
                    runner.invalidate();
                }
                emit(
                    &runner.events,
                    &entry.owner,
                    &id_worker,
                    status,
                    entry.auth_url.as_deref(),
                    entry.error.as_deref(),
                );
            }
        });
        Ok(id)
    }
    pub(crate) fn status(&self, owner: &OwnerId, id: &str) -> Result<Value, String> {
        let entries = self.inner.lock().map_err(|_| "MCP manager unavailable")?;
        let entry = entries.get(id).ok_or("oauth_operation_not_found")?;
        let status = self
            .oauth
            .lock()
            .map_err(|_| "OAuth manager unavailable")?
            .status(owner.as_str(), entry.generation, id)
            .map_err(|e| e.code().to_owned())?;
        let mut value = json!({ "ok": true, "status": status_name(&status) });
        if let Some(url) = &entry.auth_url {
            value["authUrl"] = json!(url);
        }
        if let Some(error) = &entry.error {
            value["error"] = json!(error);
        }
        Ok(value)
    }
    pub(crate) fn cancel(&self, owner: &OwnerId, id: &str) -> Result<(), String> {
        let mut entries = self.inner.lock().map_err(|_| "MCP manager unavailable")?;
        let entry = entries.get_mut(id).ok_or("oauth_operation_not_found")?;
        let mut oauth = self.oauth.lock().map_err(|_| "OAuth manager unavailable")?;
        let status = oauth
            .status(owner.as_str(), entry.generation, id)
            .map_err(|e| e.code().to_owned())?;
        if status == OAuthStatus::Pending {
            if let Some(process) = &entry.process {
                let mut process = process.lock().map_err(|_| "MCP process unavailable")?;
                // Set terminal state before the worker can process a kill exit.
                oauth
                    .cancel(owner.as_str(), entry.generation, id)
                    .map_err(|e| e.code().to_owned())?;
                let Running { child, tree } = &mut *process;
                tree.terminate(child)?;
            }
            emit(
                &self.events,
                owner,
                id,
                OAuthStatus::Cancelled,
                entry.auth_url.as_deref(),
                None,
            );
        }
        Ok(())
    }
    pub(crate) fn abort_all(&self) {
        let operations = self
            .inner
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|(_, entry)| entry.process.is_some())
                    .map(|(id, entry)| (entry.owner.clone(), id.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (owner, id) in operations {
            let _ = self.cancel(&owner, &id);
        }
    }
    pub(crate) fn invalidate(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            self.cache_epoch.fetch_add(1, Ordering::SeqCst);
            cache.clear();
        }
    }
    pub(crate) fn logout(&self, binary: &Path, cwd: &Path, name: &str) -> Result<(), String> {
        let output = command(binary, cwd, "logout", Some(name))
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("MCP logout failed; see Pi logs".into());
        }
        self.invalidate();
        Ok(())
    }
    pub(crate) fn list(&self, binary: &Path, cwd: &Path) -> Result<Value, String> {
        if let Ok(cache) = self.cache.lock() {
            if let Some((when, value)) = cache.get(cwd) {
                if when.elapsed() < CACHE_TTL {
                    return Ok(value.clone());
                }
            }
        }
        let epoch = self.cache_epoch.load(Ordering::SeqCst);
        let output = command(binary, cwd, "list", None)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("MCP list failed; see Pi logs".into());
        }
        let servers: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        if !servers.is_array() {
            return Err("MCP server list is not an array".into());
        }
        if let Ok(mut cache) = self.cache.lock() {
            if epoch == self.cache_epoch.load(Ordering::SeqCst) {
                cache.insert(cwd.to_owned(), (Instant::now(), servers.clone()));
            }
        }
        Ok(servers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    fn fixture(script: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake-pi");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (dir, path)
    }
    #[cfg(unix)]
    fn runner() -> (McpLoginRunner, OwnerId) {
        let (tx, _) = tokio::sync::broadcast::channel(16);
        let manager = Arc::new(Mutex::new(OAuthManager::default()));
        manager.lock().unwrap().runtime_started();
        (
            McpLoginRunner::new(manager, HostEventSink::new(tx)),
            OwnerId::from_string("test-owner".into()),
        )
    }
    #[cfg(unix)]
    fn wait_terminal(runner: &McpLoginRunner, owner: &OwnerId, id: &str) -> Value {
        for _ in 0..100 {
            let status = runner.status(owner, id).unwrap();
            if status["status"] != "pending" {
                return status;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("login did not finish");
    }
    #[cfg(unix)]
    #[test]
    fn mcp_login_fake_binary_tracks_url_exit_and_rejects_concurrent_start() {
        let (dir, binary) = fixture("echo 'Sign in to MCP server \"test\" in your browser:'; echo 'https://example.org/authorize'; sleep 0.3; exit 0");
        let (runner, owner) = runner();
        let mut events = runner.events.subscribe();
        let id = runner.start(&binary, dir.path(), "test", &owner).unwrap();
        assert!(runner.start(&binary, dir.path(), "test", &owner).is_err());
        let status = wait_terminal(&runner, &owner, &id);
        assert_eq!(status["status"], "succeeded");
        assert_eq!(status["authUrl"], "https://example.org/authorize");
        let frames = std::iter::from_fn(|| events.try_recv().ok())
            .map(|event| event.value)
            .collect::<Vec<_>>();
        assert!(frames.iter().any(|frame| frame["type"] == "mcpLoginUpdate"
            && frame["payload"]["authUrl"] == "https://example.org/authorize"));
        assert!(frames
            .iter()
            .any(|frame| frame["payload"]["status"] == "succeeded"));
        let (_failing_dir, failing) = fixture("exit 1");
        let id = runner.start(&failing, dir.path(), "test", &owner).unwrap();
        assert_eq!(wait_terminal(&runner, &owner, &id)["status"], "failed");
    }
    #[cfg(unix)]
    #[test]
    fn mcp_login_cancel_and_list_cache_invalidation() {
        let (dir, binary) = fixture("if [ \"$2\" = login ]; then sleep 30; elif [ \"$2\" = logout ]; then echo logout >> calls; else echo list >> calls; echo '[{\"name\":\"test\",\"state\":\"needs-auth\"}]'; fi");
        let (runner, owner) = runner();
        let id = runner.start(&binary, dir.path(), "test", &owner).unwrap();
        runner.cancel(&owner, &id).unwrap();
        assert_eq!(runner.status(&owner, &id).unwrap()["status"], "cancelled");
        let first = runner.list(&binary, dir.path()).unwrap();
        assert_eq!(first[0]["name"], "test");
        runner.list(&binary, dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        runner.logout(&binary, dir.path(), "test").unwrap();
        runner.list(&binary, dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            3
        );
        runner.cache.lock().unwrap().get_mut(dir.path()).unwrap().0 =
            Instant::now() - CACHE_TTL - Duration::from_secs(1);
        runner.list(&binary, dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            4
        );
    }
    #[cfg(unix)]
    #[test]
    fn mcp_login_success_invalidates_cached_server_reports() {
        let (dir, binary) =
            fixture("if [ \"$2\" = list ]; then echo list >> calls; echo '[]'; else exit 0; fi");
        let (runner, owner) = runner();
        runner.list(&binary, dir.path()).unwrap();
        let id = runner.start(&binary, dir.path(), "test", &owner).unwrap();
        assert_eq!(wait_terminal(&runner, &owner, &id)["status"], "succeeded");
        runner.list(&binary, dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }
    #[test]
    fn mcp_login_command_and_url_parser() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = command(Path::new("pi"), dir.path(), "login", Some("example"));
        assert_eq!(
            cmd.get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["mcp", "login", "example", "--timeout", "300"]
        );
        let mut parser = UrlParser::default();
        assert_eq!(
            parser.feed(
                "Sign in to MCP server \"example\" in your browser:",
                "example"
            ),
            None
        );
        assert_eq!(
            parser.feed("https://localhost/auth?code=x", "example"),
            Some("https://localhost/auth?code=x".into())
        );
        assert_eq!(parser.feed("not-a-url", "example"), None);
    }
}
