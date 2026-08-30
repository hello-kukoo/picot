#![cfg_attr(not(test), allow(dead_code))]

use crate::broker_ws::{ControlHandler, ProgressSink, VerifiedClientContext};
use crate::host_capability::HostCapabilityStore;
use crate::host_data::{HostDataError, HostDataPlane};
use crate::host_router::{HostClientContext, HostRouter, RoutedAction, PROTOCOL_VERSION};
use crate::metadata_store::SharedMetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use crate::transport_limits::{
    validate, PayloadKind, HTTP_DEFAULT_BODY_BYTES, WS_PHYSICAL_FRAME_BYTES,
};
use crate::v1_control_adapter;
use crate::window_owner::WindowOwnerRegistry;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::extract::{DefaultBodyLimit, Json, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, PRAGMA};
use axum::http::HeaderMap;
use axum::http::HeaderValue;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::{any, get, post};
use axum::Router;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;
use tower::ServiceBuilder;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

const MAX_HTTP_BODY_BYTES: usize = HTTP_DEFAULT_BODY_BYTES;
// JSON string escaping can inflate each payload byte up to sixfold
// (\uXXXX); the semantic paste bound in paste_offload stays authoritative,
// so the transport limit only needs headroom for the encoded form.
const MAX_PASTE_BODY_BYTES: usize = crate::paste_offload::MAX_PASTE_BYTES * 6 + 64 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = WS_PHYSICAL_FRAME_BYTES;

fn bind_is_loopback(address: std::net::IpAddr) -> bool {
    address.is_loopback()
}

/// Fingerprints the static bundle by (path, size, mtime) of every file under
/// `static_dir`, without reading file contents — cheap enough to run once on
/// every server startup even for a bundle with vendored JS/fonts/images, and
/// still changes on every real build (build tooling always rewrites file
/// mtimes). Used to version the URL prefix static assets are served under;
/// see the comment at its call site for why the version string alone isn't
/// enough.
fn fingerprint_static_dir(static_dir: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(static_dir, &mut files);
    files.sort();

    let mut hasher = Sha256::new();
    for path in &files {
        let Ok(meta) = fs::metadata(path) else {
            continue;
        };
        if let Ok(relative) = path.strip_prefix(static_dir) {
            hasher.update(relative.to_string_lossy().as_bytes());
        }
        hasher.update(meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(since_epoch.as_millis().to_le_bytes());
            }
        }
    }
    hex::encode(&hasher.finalize()[..8])
}

struct HostState {
    router: Mutex<HostRouter>,
    #[allow(dead_code)]
    desktop_capabilities: Mutex<HostCapabilityStore>,
    owner_registry: Mutex<Option<Arc<WindowOwnerRegistry>>>,
    runtimes: NativePiManager,
    auth: Arc<Mutex<RemoteAuth>>,
    data: HostDataPlane,
    index_html: Mutex<String>,
    control_handler: Mutex<Option<ControlHandler>>,
    oauth: Mutex<crate::oauth_manager::OAuthManager>,
    /// P4-d: one-shot TTL'd export tokens backing `session_export`.
    session_exports: crate::host_data::SessionExportRegistry,
    /// D8: anonymous client-class hit counts for the retired `/api/rpc`
    /// surface (no per-user/per-token dimensions).
    legacy_rpc_gone_hits: Mutex<HashMap<String, u64>>,
}

pub struct HostServer {
    origin: String,
    shutdown: Option<oneshot::Sender<()>>,
    state: Arc<HostState>,
}

impl HostServer {
    /// Advance OAuth generation when native runtime is created.
    pub fn runtime_started(&self) -> Result<u64, String> {
        self.state
            .oauth
            .lock()
            .map_err(|_| "OAuth manager unavailable".to_owned())
            .map(|mut oauth| oauth.runtime_started())
    }

    /// Revoke OAuth operations when native runtime stops.
    pub fn runtime_stopped(&self) -> Result<(), String> {
        self.state
            .oauth
            .lock()
            .map_err(|_| "OAuth manager unavailable".to_owned())
            .map(|mut oauth| oauth.runtime_stopped())
    }

    pub async fn start(
        static_dir: PathBuf,
        runtimes: NativePiManager,
        auth: Arc<Mutex<RemoteAuth>>,
        metadata: SharedMetadataStore,
    ) -> Result<Self, String> {
        let mut data = HostDataPlane::new(metadata);
        if let Some(home) = dirs::home_dir() {
            data = data.with_session_root(home.join(".pi/agent/sessions"));
        }
        let state = Arc::new(HostState {
            router: Mutex::new(HostRouter::new()),
            desktop_capabilities: Mutex::new(HostCapabilityStore::default()),
            owner_registry: Mutex::new(None),
            runtimes,
            auth,
            data,
            index_html: Mutex::new(String::new()),
            control_handler: Mutex::new(None),
            oauth: Mutex::new(crate::oauth_manager::OAuthManager::default()),
            session_exports: crate::host_data::SessionExportRegistry::new(
                8,
                std::time::Duration::from_secs(300),
            ),
            legacy_rpc_gone_hits: Mutex::new(HashMap::new()),
        });
        let index = static_dir.join("index.html");
        // Serve this build's JS/CSS/HTML under a version-stamped path
        // (`/v/<version>/...`) and point index.html's `<base>` at it. The
        // `Cache-Control: no-store` headers below are meant to stop the
        // WebView from reusing stale assets across an auto-update +
        // relaunch (the host listens on a stable port across restarts), but
        // WebKit has been observed to keep serving a URL's very first
        // cached response indefinitely without ever revalidating it against
        // fresh headers. A version-scoped URL sidesteps that entirely: each
        // release is a guaranteed cache miss for every asset, no matter how
        // the WebView's cache behaves.
        // A version string alone isn't a reliable cache-busting key: a
        // hotfix or dev build can ship with the app version unchanged (no
        // version bump), which would leave the WebView's cache pinned to
        // stale assets exactly like the bug this route exists to avoid. A
        // content fingerprint changes on every real rebuild regardless of
        // whether anyone remembered to bump the version.
        let versioned_prefix = format!("/v/{}", fingerprint_static_dir(&static_dir));
        let index_html = fs::read_to_string(&index).unwrap_or_default().replacen(
            "<base href=\"/\" />",
            &format!("<base href=\"{versioned_prefix}/\" />"),
            1,
        );
        if let Ok(mut html) = state.index_html.lock() {
            *html = index_html.clone();
        }
        let index_fallback = tower::service_fn(move |_req: axum::extract::Request| {
            let html = index_html.clone();
            std::future::ready(Ok::<_, Infallible>(
                Response::builder()
                    .header(CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(html))
                    .expect("static index.html response is well-formed"),
            ))
        });
        let static_service = ServeDir::new(static_dir.clone()).fallback(index_fallback);
        // Always disable caching for the static bundle, not just in debug
        // builds: the host listens on a stable port across app restarts, so
        // after an auto-update + relaunch the WebView's HTTP cache would
        // otherwise keep serving the previous release's JS/CSS/HTML until a
        // manual hard reload.
        let static_service = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                PRAGMA,
                HeaderValue::from_static("no-cache"),
            ))
            .service(static_service);
        let versioned_service = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                PRAGMA,
                HeaderValue::from_static("no-cache"),
            ))
            .service(ServeDir::new(static_dir));
        let app = Router::new()
            .route("/health", get(health))
            .route("/api/health", get(health))
            .route("/api/pi-version", get(pi_version))
            .route("/api/files", get(compat_files))
            .route("/api/sessions", get(compat_sessions))
            .route("/api/search", get(compat_search))
            .route("/api/cost-dashboard", get(compat_cost_dashboard))
            .route("/api/instances", get(compat_instances))
            .route("/api/home", get(compat_home))
            .route("/api/workspace-info", get(compat_workspace_info))
            .route("/api/workspace-sessions", get(compat_workspace_sessions))
            .route("/api/sessions/rename", post(compat_sessions_rename))
            .route(
                "/api/sessions/delete-batch",
                post(compat_sessions_delete_batch),
            )
            .route("/api/sessions/switch", post(compat_sessions_switch))
            .route("/api/sessions/{dir_name}/{file}", get(compat_session_file))
            .route("/api/workspace/open", post(compat_workspace_open))
            .route("/v2/session-export/{token}", get(session_export_stream))
            .route("/api/rpc", any(rpc_retired))
            .route("/v2/ws", get(websocket_upgrade))
            // Bare Pi-origin WebSocket paths are never valid on host origin.
            // Keep static fallback from turning `/ws` into a misleading shell.
            .route("/ws", any(reject_legacy_ws))
            .route("/v2/bootstrap", get(bootstrap_target))
            .route("/v2/auth/exchange", post(exchange_pairing))
            .route(
                "/v2/paste-offload",
                post(paste_offload).layer(DefaultBodyLimit::max(MAX_PASTE_BODY_BYTES)),
            )
            // Legacy HTTP callers must never receive the static shell by
            // accident. Retained routes are added behind owner-aware adapters;
            // everything else has an explicit migration failure.
            .route("/api/{*path}", any(unimplemented_api_route))
            // Existing shell is production at the registered workspace/session
            // namespace. Static fallback still serves its index so bootstrap-
            // entry.js selects the legacy shell; /app remains experimental.
            .route(
                "/workspaces/{workspace_id}/sessions/{session_id}",
                get(workspace_shell),
            )
            .nest_service(&versioned_prefix, versioned_service)
            .fallback_service(static_service)
            .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
            .with_state(Arc::clone(&state));
        let bind_address = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
        if !bind_is_loopback(bind_address) {
            return Err("Host bind rejected: non-loopback address".into());
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("Cannot bind Picot Host: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Cannot read Picot Host address: {error}"))?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
            {
                log::error!("[picot-host] server stopped unexpectedly: {error}");
            }
        });
        Ok(Self {
            origin: format!("http://{address}"),
            shutdown: Some(shutdown_tx),
            state,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Bind window-owner authority after host bind, before any desktop window connects.
    pub fn set_owner_registry(&self, registry: Arc<WindowOwnerRegistry>) {
        if let Ok(mut slot) = self.state.owner_registry.lock() {
            *slot = Some(registry);
        }
    }

    /// Drop every outstanding session-export grant for an owner (workspace
    /// transition / owner teardown hygiene; M4).
    pub fn revoke_session_exports(&self, owner: &str) {
        self.state.session_exports.revoke_owner(owner);
    }

    /// Install same owner-checked control handler used by legacy broker.
    /// Host-origin v2 dispatch must not grow a second control implementation.
    pub fn set_control_handler(&self, handler: ControlHandler) {
        if let Ok(mut slot) = self.state.control_handler.lock() {
            *slot = Some(handler);
        }
    }

    pub fn stop(mut self) {
        let _ = self.runtime_stopped();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for HostServer {
    fn drop(&mut self) {
        let _ = self
            .state
            .oauth
            .lock()
            .map(|mut oauth| oauth.runtime_stopped());
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

/// Host liveness only. Runtime readiness is a separate concern (spec §5.1:
/// `GET /api/health` → `GET /health`， host health 与 runtime readiness 分离)
/// and must not depend on the legacy `PiManager`; the version constant comes
/// from the shared `pi_launch` substrate.
async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "protocolVersion": PROTOCOL_VERSION,
        "piVersion": crate::pi_launch::locked_pi_version(),
    }))
}

/// Retained compatibility endpoint. It exposes only host build metadata.
async fn pi_version() -> Json<Value> {
    Json(json!({
        "success": true,
        "version": crate::pi_launch::locked_pi_version(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceQuery {
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileQuery {
    workspace_id: Option<String>,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    workspace_id: Option<String>,
    #[serde(default)]
    q: String,
}

fn compat_owner_workspace(
    state: &HostState,
    headers: &HeaderMap,
    requested_workspace_id: Option<&str>,
) -> Result<String, (StatusCode, Json<Value>)> {
    let capability = headers
        .get("x-picot-desktop-capability")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthenticated"))?;
    let registry = state
        .owner_registry
        .lock()
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable"))?
        .clone()
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthenticated"))?;
    let owner = registry
        .authenticate(capability)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthenticated"))?;
    let snapshot = registry.owner_current_workspace(&owner);
    match snapshot {
        crate::window_owner::OwnerWorkspaceSnapshot::Registered { wid, .. }
            if requested_workspace_id.is_none_or(|requested| requested == wid) =>
        {
            Ok(wid)
        }
        crate::window_owner::OwnerWorkspaceSnapshot::Registered { .. } => {
            Err(api_error(StatusCode::FORBIDDEN, "unauthorized_target"))
        }
        _ => Err(api_error(StatusCode::FORBIDDEN, "not_registered")),
    }
}

#[derive(Deserialize)]
struct PasteRequest {
    content: String,
}

async fn paste_offload(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, None)?;
    let request: PasteRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let root = state
        .data
        .workspace_root(&workspace_id)
        .map_err(host_data_error_response)?;
    let path = crate::paste_offload::write(&root, &request.content, SystemTime::now()).map_err(
        |error| {
            let (status, code) = match error {
                crate::paste_offload::PasteError::TooLarge => {
                    (StatusCode::PAYLOAD_TOO_LARGE, "paste_too_large")
                }
                crate::paste_offload::PasteError::QuotaExceeded => {
                    (StatusCode::PAYLOAD_TOO_LARGE, "paste_quota_exceeded")
                }
                crate::paste_offload::PasteError::InvalidWorkspace
                | crate::paste_offload::PasteError::Symlink => {
                    (StatusCode::FORBIDDEN, "workspace_unavailable")
                }
                crate::paste_offload::PasteError::Io => {
                    (StatusCode::INTERNAL_SERVER_ERROR, "paste_write_failed")
                }
            };
            api_error(status, code)
        },
    )?;
    Ok(Json(json!({ "ok": true, "path": path })))
}

async fn compat_files(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, query.workspace_id.as_deref())?;
    let entries = state
        .data
        .list_files(&workspace_id, &query.path)
        .map_err(host_data_error_response)?;
    Ok(Json(json!({ "success": true, "entries": entries })))
}

async fn compat_sessions(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, query.workspace_id.as_deref())?;
    let sessions = state
        .data
        .list_sessions(&workspace_id)
        .map_err(host_data_error_response)?;
    Ok(Json(json!({ "success": true, "sessions": sessions })))
}

async fn compat_search(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, query.workspace_id.as_deref())?;
    let results = state
        .data
        .search_sessions(&workspace_id, &query.q)
        .map_err(host_data_error_response)?;
    Ok(Json(json!({ "success": true, "results": results })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CostQuery {
    workspace_id: Option<String>,
    range: Option<String>,
    granularity: Option<String>,
    scope: Option<String>,
    models: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

async fn compat_cost_dashboard(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<CostQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, query.workspace_id.as_deref())?;
    let pairs = [
        ("range", query.range.as_deref()),
        ("granularity", query.granularity.as_deref()),
        ("scope", query.scope.as_deref()),
        ("models", query.models.as_deref()),
        ("from", query.from.as_deref()),
        ("to", query.to.as_deref()),
    ]
    .iter()
    .filter_map(|(key, value)| value.map(|value| ((*key).to_string(), value.to_string())))
    .collect::<Vec<(String, String)>>();
    let params = crate::cost_compat::parse_cost_range_params(&pairs)
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_cost_range"))?;
    let payload = state
        .data
        .cost_dashboard_compat(&workspace_id, &params, chrono::Utc::now())
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "cost_scan_failed"))?;
    Ok(Json(payload))
}

async fn compat_instances(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    compat_owner_workspace(&state, &headers, None)?;
    let mut instances = Vec::new();
    for target in state.runtimes.running_targets() {
        let pid = state.runtimes.pid_for(&target);
        let cwd = state
            .data
            .workspace_root(&target.workspace_id)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let session_file = state
            .data
            .session_file_path(&target.workspace_id, &target.session_id)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        instances.push(json!({
            "port": 0,
            "pid": pid.unwrap_or(0),
            "sessionFile": session_file,
            "cwd": cwd,
            "startedAt": Value::Null,
        }));
    }
    Ok(Json(json!({ "instances": instances })))
}

async fn compat_home(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // A-HTTP-18: explicit capability boundary on host-origin (legacy was
    // loopback-open; native host applies the same owner boundary).
    compat_owner_workspace(&state, &headers, None)?;
    Ok(Json(json!({
        "home": dirs::home_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })))
}

async fn compat_workspace_info(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, query.workspace_id.as_deref())?;
    let path = state
        .data
        .workspace_root(&workspace_id)
        .map_err(host_data_error_response)?;
    Ok(Json(json!({
        "workspaceId": workspace_id,
        "path": path.to_string_lossy(),
    })))
}

#[derive(Deserialize)]
struct WorkspaceSessionsQuery {
    path: String,
    mode: Option<String>,
}

async fn compat_workspace_sessions(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceSessionsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    compat_owner_workspace(&state, &headers, None)?;
    if !query.path.starts_with('/') {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_path"));
    }
    // Legacy multi-bucket merge: every historical dirName bucket for the
    // workspace contributes its sessions (A-HTTP-35/36 entry contract).
    let buckets = state
        .data
        .session_dirs_for_workspace(Path::new(&query.path));
    let dir_name = buckets
        .first()
        .and_then(|dir| dir.file_name())
        .map(|name| name.to_string_lossy().into_owned());
    if query.mode.as_deref() == Some("count") {
        return Ok(Json(json!({
            "path": query.path,
            "dirName": dir_name,
            "sessions": [],
            "sessionCount": state.data.count_bucket_sessions(&buckets),
        })));
    }
    Ok(Json(json!({
        "path": query.path,
        "dirName": dir_name,
        "sessions": state.data.list_workspace_session_entries(&buckets),
    })))
}

#[derive(Deserialize)]
struct SessionRenameBody {
    #[serde(rename = "filePath")]
    file_path: String,
    name: String,
}

async fn compat_sessions_rename(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    compat_owner_workspace(&state, &headers, None)?;
    // Legacy rename body bound: 8 KiB (readBoundedJsonBody).
    if body.len() > 8 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
        ));
    }
    let body: SessionRenameBody = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_rename_request"))?;
    let name = body.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Name must be 1-200 characters",
        ));
    }
    let Some(session_root) = state.data.session_root_path() else {
        return Err(api_error(StatusCode::NOT_FOUND, "Session is unavailable"));
    };
    let canonical = std::path::PathBuf::from(&body.file_path)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&body.file_path));
    let root_canonical = session_root
        .canonicalize()
        .unwrap_or_else(|_| session_root.clone());
    // Containment must be separator-safe (a sibling like `sessions-evil`
    // shares the string prefix but not the directory).
    if !body.file_path.ends_with(".jsonl") || canonical.strip_prefix(&root_canonical).is_err() {
        return Err(api_error(StatusCode::NOT_FOUND, "Session is unavailable"));
    }
    // Managed-session membership (legacy renameManagedSession): the target
    // must parse as a session file, not an arbitrary .jsonl in the tree.
    if crate::host_data::parse_session_header(&canonical).is_none() {
        return Err(api_error(StatusCode::NOT_FOUND, "Session is unavailable"));
    }
    state
        .data
        .append_session_info_name(&canonical, &name)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "session_rename_failed"))?;
    Ok(Json(
        json!({ "ok": true, "filePath": body.file_path, "name": name }),
    ))
}

#[derive(Deserialize)]
struct SessionDeleteBatchBody {
    #[serde(rename = "filePaths")]
    file_paths: Vec<String>,
}

async fn compat_sessions_delete_batch(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    compat_owner_workspace(&state, &headers, None)?;
    // Legacy delete body bound: 8 KiB.
    if body.len() > 8 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
        ));
    }
    let body: SessionDeleteBatchBody = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_delete_batch"))?;
    let running_session_files = state
        .runtimes
        .running_targets()
        .iter()
        .filter_map(|target| {
            state
                .data
                .session_file_path(&target.workspace_id, &target.session_id)
                .map(|path| path.to_string_lossy().into_owned())
        })
        .collect::<Vec<String>>();
    let result = state
        .data
        .delete_session_batch(&body.file_paths, &running_session_files)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "session_delete_failed"))?;
    Ok(Json(result))
}

async fn compat_sessions_switch() -> Json<Value> {
    Json(json!({
        "success": true,
        "embedded": true,
        "note": "Session switching is controlled by Picot's Rust side",
    }))
}

/// A-HTTP-39: session-file history view. Segments arrive percent-decoded by
/// the extractor; decoding must never reintroduce separators or traversal
/// (legacy `decodeSessionRouteSegments`), the bucket must belong to the
/// requesting owner's workspace, and the resolved path stays inside the
/// shared session root. Responds with the legacy `{entries}` shape.
async fn compat_session_file(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    axum::extract::Path((dir_name, file)): axum::extract::Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = compat_owner_workspace(&state, &headers, None)?;
    let unsafe_segment =
        |segment: &str| segment.contains('/') || segment.contains('\\') || segment.contains("..");
    if unsafe_segment(&dir_name) || unsafe_segment(&file) {
        return Err(api_error(StatusCode::BAD_REQUEST, "Invalid session path"));
    }
    let root = state
        .data
        .workspace_root(&workspace_id)
        .map_err(host_data_error_response)?;
    let owned = state
        .data
        .session_dirs_for_workspace(&root)
        .iter()
        .any(|dir| {
            dir.file_name()
                .is_some_and(|name| name.to_string_lossy() == dir_name)
        });
    if !owned {
        return Err(api_error(StatusCode::NOT_FOUND, "Session not found"));
    }
    let Some(session_root) = state.data.session_root_path() else {
        return Err(api_error(StatusCode::NOT_FOUND, "Session not found"));
    };
    let path = session_root.join(&dir_name).join(&file);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
    let resolved_root = session_root
        .canonicalize()
        .unwrap_or_else(|_| session_root.clone());
    if resolved == resolved_root || resolved.strip_prefix(&resolved_root).is_err() {
        return Err(api_error(StatusCode::NOT_FOUND, "Session not found"));
    }
    if !resolved.is_file() {
        return Err(api_error(StatusCode::NOT_FOUND, "Session not found"));
    }
    let content = std::fs::read_to_string(&resolved)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "session_io_failed"))?;
    let entries: Vec<Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    Ok(Json(json!({ "entries": entries })))
}

async fn compat_workspace_open(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    compat_owner_workspace(&state, &headers, None)?;
    let body: Value = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_open_request"))?;
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "path is required"))?;
    let canonical = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "workspace_not_found"))?;
    // Owner-only: the directory must be a registered workspace root.
    state
        .data
        .workspace_root_for_path(&canonical)
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "workspace_not_found"))?;
    open_directory_in_file_manager(&canonical);
    Ok(Json(json!({ "success": true })))
}

fn open_directory_in_file_manager(path: &std::path::Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
}

/// P4-d: stream a session file for a redeemed one-shot export token.
async fn session_export_stream(
    State(state): State<Arc<HostState>>,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let owner_registry = state
        .owner_registry
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let path = state
        .session_exports
        .redeem_checked(&token, |owner, generation| {
            owner_registry.as_ref().is_some_and(|registry| {
                let owner_id = crate::window_owner::OwnerId::from_string(owner.to_string());
                matches!(
                    registry.owner_current_workspace(&owner_id),
                    crate::window_owner::OwnerWorkspaceSnapshot::Registered {
                        generation: current,
                        ..
                    } if current == generation
                )
            })
        })
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "export_token_invalid"))?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "export_unavailable"))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "session-export.jsonl".to_owned());

    let stream = futures_util::stream::unfold(file, |mut file| async move {
        let mut buf = vec![0u8; 64 * 1024];
        match tokio::io::AsyncReadExt::read(&mut file, &mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(buf)), file))
            }
            Err(error) => Some((Err(std::io::Error::other(error)), file)),
        }
    });
    Ok(Response::builder()
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{file_name}\""),
        )
        .body(Body::from_stream(stream))
        .expect("streaming response is well-formed"))
}

/// D8 (2026-08-29 adjudication): the legacy chat RPC surface is retired —
/// no permanent second RPC. Callers get 410 Gone with a removal notice and
/// an anonymous client-class hit count (no per-user/token dimensions).
async fn rpc_retired(State(state): State<Arc<HostState>>, headers: HeaderMap) -> Response {
    let client_class = if headers.contains_key("x-picot-desktop-capability") {
        "desktop"
    } else if headers.contains_key("authorization") {
        "paired_remote"
    } else {
        "unpaired_browser"
    };
    if let Ok(mut hits) = state.legacy_rpc_gone_hits.lock() {
        *hits.entry(client_class.to_string()).or_insert(0) += 1;
    }
    let mut response = (
        StatusCode::GONE,
        Json(json!({
            "error": { "code": "gone" },
            "removalNotice": "/api/rpc retired per D8 — use the v2 WebSocket surface; see the release notes.",
            "clientClass": client_class,
        })),
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::HeaderName::from_static("deprecation"),
        HeaderValue::from_static("true"),
    );
    response
}

fn host_data_error_response(error: HostDataError) -> (StatusCode, Json<Value>) {
    let (code, _) = host_data_error(error);
    let status = if code == "workspace_not_found" {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    };
    api_error(status, code)
}

/// Host-origin entry for production existing-shell windows. Route parameters
/// are validated before serving bootstrap HTML; runtime authorization remains
/// on `/v2/bootstrap` and `/v2/ws`, never in browser-provided URL state.
async fn workspace_shell(
    State(state): State<Arc<HostState>>,
    axum::extract::Path((workspace_id, session_id)): axum::extract::Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if workspace_id.is_empty() || session_id.is_empty() {
        return Err(api_error(StatusCode::NOT_FOUND, "runtime_not_found"));
    }
    if state
        .runtimes
        .target_for_session(&workspace_id, &session_id)
        .is_none()
    {
        return Err(api_error(StatusCode::NOT_FOUND, "runtime_not_found"));
    }
    let html = state
        .index_html
        .lock()
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "static_unavailable"))?
        .clone();
    Ok(Response::builder()
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(html))
        .expect("workspace shell response is well-formed"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapQuery {
    workspace_id: String,
    session_id: String,
}

async fn reject_legacy_ws() -> (StatusCode, Json<Value>) {
    api_error(StatusCode::NOT_FOUND, "unsupported_host_route")
}

async fn bootstrap_target(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    Query(query): Query<BootstrapQuery>,
) -> Result<Json<RuntimeTarget>, (StatusCode, Json<Value>)> {
    // Bootstrap is control-plane data: bind it to authenticated desktop owner,
    // not merely opaque workspace/session query values.
    let _workspace_id = compat_owner_workspace(&state, &headers, Some(&query.workspace_id))?;
    let target = state
        .runtimes
        .target_for_session(&query.workspace_id, &query.session_id)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "runtime_not_found"))?;
    let registry = state
        .owner_registry
        .lock()
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable"))?
        .clone()
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthenticated"))?;
    let capability = headers
        .get("x-picot-desktop-capability")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthenticated"))?;
    let owner = registry
        .authenticate(capability)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthenticated"))?;
    if target.owner_id.as_deref() != Some(owner.as_str()) {
        return Err(api_error(StatusCode::FORBIDDEN, "unauthorized_target"));
    }
    Ok(Json(target))
}

fn oversized_code(kind: PayloadKind) -> &'static str {
    match kind {
        PayloadKind::Response => "response_too_large",
        PayloadKind::Snapshot => "snapshot_too_large",
        PayloadKind::Event => "event_too_large",
        PayloadKind::Progress => "progress_too_large",
        _ => "response_too_large",
    }
}

async fn send_checked(socket: &mut WebSocket, value: Value, kind: PayloadKind) -> bool {
    if validate(&value, kind).is_err() {
        let error = structured_error(
            None,
            oversized_code(kind),
            "Outbound payload exceeds protocol limit",
        );
        return socket
            .send(Message::Text(error.to_string().into()))
            .await
            .is_ok();
    }
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

async fn websocket_upgrade(
    State(state): State<Arc<HostState>>,
    websocket: WebSocketUpgrade,
) -> Response {
    websocket
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_websocket(socket, state))
}

async fn handle_websocket(mut socket: WebSocket, state: Arc<HostState>) {
    let Some(Ok(Message::Text(first))) = socket.next().await else {
        return;
    };
    let hello = match serde_json::from_str::<Value>(&first) {
        Ok(frame) => frame,
        Err(_) => {
            let _ = send_error(&mut socket, None, "invalid_json", "Invalid JSON frame").await;
            return;
        }
    };
    let client_id = match hello.get("clientId").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => {
            let _ = send_error(
                &mut socket,
                None,
                "invalid_client_id",
                "clientId is required",
            )
            .await;
            return;
        }
    };
    if hello.get("clientType").and_then(Value::as_str) == Some("desktop") {
        let Some(capability) = hello.get("desktopCapability").and_then(Value::as_str) else {
            let _ = send_error(
                &mut socket,
                None,
                "unauthenticated",
                "Desktop capability required",
            )
            .await;
            return;
        };
        let configured = state
            .owner_registry
            .lock()
            .ok()
            .and_then(|registry| registry.clone());
        if let Some(registry) = configured {
            if registry.authenticate(capability).is_none() {
                let _ = send_error(
                    &mut socket,
                    None,
                    "unauthenticated",
                    "Desktop capability rejected",
                )
                .await;
                return;
            }
        }
    }
    if hello.get("clientType").and_then(Value::as_str) == Some("remote") {
        let authorized = hello
            .get("deviceToken")
            .and_then(Value::as_str)
            .and_then(|token| state.auth.lock().ok()?.authorize(token).ok())
            .unwrap_or(false);
        if !authorized {
            let _ = send_error(
                &mut socket,
                None,
                "unauthorized_device",
                "Device token rejected",
            )
            .await;
            return;
        }
    }
    let context = match hello.get("clientType").and_then(Value::as_str) {
        Some("desktop") => {
            let capability = hello
                .get("desktopCapability")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(registry) = state
                .owner_registry
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
            else {
                let _ = send_error(
                    &mut socket,
                    None,
                    "unauthenticated",
                    "Desktop capability rejected",
                )
                .await;
                return;
            };
            let Some(owner) = registry.authenticate(capability) else {
                let _ = send_error(
                    &mut socket,
                    None,
                    "unauthenticated",
                    "Desktop capability rejected",
                )
                .await;
                return;
            };
            HostClientContext::desktop(
                client_id.clone(),
                owner.clone(),
                registry.owner_current_workspace(&owner),
            )
        }
        Some("remote") => HostClientContext::remote(client_id.clone()),
        Some("browser") | Some("unpaired") => HostClientContext::public(client_id.clone()),
        _ => {
            let _ = send_error(
                &mut socket,
                None,
                "invalid_client_type",
                "Unsupported client type",
            )
            .await;
            return;
        }
    };
    let handshake = state
        .router
        .lock()
        .map_err(|_| "Host router unavailable".to_string())
        .and_then(|mut router| {
            router
                .connect(&client_id, &hello, context)
                .map_err(|error| error.message)
        });
    if let Err(message) = handshake {
        let _ = send_error(&mut socket, None, "handshake_rejected", &message).await;
        return;
    }
    if socket
        .send(Message::Text(
            json!({ "type": "hello_ack", "protocolVersion": PROTOCOL_VERSION })
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    let mut runtime_events = state.runtimes.subscribe();
    let mut subscriptions = HashSet::new();
    let client_context = state
        .router
        .lock()
        .ok()
        .and_then(|router| router.client_context(&client_id).cloned());
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let mut frame = match serde_json::from_str::<Value>(&text) {
                    Ok(frame) => frame,
                    Err(_) => {
                        let _ = send_error(&mut socket, None, "invalid_json", "Invalid JSON frame").await;
                        continue;
                    }
                };
                let legacy_control = frame.get("type").and_then(Value::as_str) == Some("broker_control");
                if legacy_control {
                    let command = frame.get("command").and_then(Value::as_str).unwrap_or("");
                    let request_id = frame.get("requestId").and_then(Value::as_str).unwrap_or("");
                    let args = frame.get("args").cloned().unwrap_or_else(|| json!({}));
                    frame = match v1_control_adapter::to_v2(command, request_id, args) {
                        Ok(frame) => frame,
                        Err(error) => {
                            if !send_checked(&mut socket, structured_error(Some(request_id), "unimplemented_route", &error), PayloadKind::Response).await { break; }
                            continue;
                        }
                    };
                }
                let request_id = frame
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let routed = state
                    .router
                    .lock()
                    .map_err(|_| ("router_unavailable", "Host router unavailable".to_string()))
                    .and_then(|router| {
                        router
                            .route(&client_id, &frame)
                            .map_err(|error| (error.code, error.message))
                    });
                let mut after_response = Vec::new();
                let progress_frames = Arc::new(Mutex::new(Vec::<Value>::new()));
                let progress_sink = {
                    let progress_frames = Arc::clone(&progress_frames);
                    let request_id = request_id.clone();
                    Arc::new(move |data: Value| {
                        if let Ok(mut frames) = progress_frames.lock() {
                            frames.push(json!({
                                "type": "control_progress",
                                "requestId": request_id,
                                "data": data,
                            }));
                        }
                    }) as ProgressSink
                };
                let response = match routed {
                    Ok(RoutedAction::Subscribe { request_id, target, .. }) => {
                        match serde_json::from_value::<RuntimeTarget>(target) {
                            Ok(requested) => {
                                let target = state.runtimes.target_for_session(&requested.workspace_id, &requested.session_id);
                                if let Some(target) = target.filter(|target| authorize_target(&state, client_context.as_ref(), target) && runtime_target_is_live(&state, target)) {
                                subscriptions.insert(target.clone());
                                if let Ok(pending) = state.runtimes.pending_extension_ui(&target) {
                                    after_response.extend(pending.into_iter().map(runtime_event_frame));
                                }
                                Ok(json!({ "type": "runtime_subscribed", "requestId": request_id }))
                                } else {
                                    Err(("unauthorized_target", "Runtime target is not authorized".into()))
                                }
                            }
                            Err(_) => Err(("invalid_target", "Runtime target is invalid".into())),
                        }
                    }
                    Ok(action) => dispatch(action, &state, client_context.as_ref(), progress_sink).await,
                    Err((code, message)) => Err((code, message)),
                };
                let outgoing = match response {
                    Ok(mut value) => {
                        if legacy_control && value.get("type").and_then(Value::as_str) == Some("runtime_response") {
                            value["type"] = json!("control_response");
                            value["ok"] = json!(true);
                            value["result"] = value.get("response").cloned().unwrap_or(Value::Null);
                        }
                        value
                    }
                    Err((code, message)) => structured_error(request_id.as_deref(), code, &message),
                };
                let outbound_kind = match outgoing.get("type").and_then(Value::as_str) {
                    Some("runtime_snapshot") => PayloadKind::Snapshot,
                    Some("control_progress") => PayloadKind::Progress,
                    Some("runtime_event") | Some("event_sequence_gap") => PayloadKind::Event,
                    _ => PayloadKind::Response,
                };
                for progress in progress_frames.lock().map(|frames| frames.clone()).unwrap_or_default() {
                    if !send_checked(&mut socket, progress, PayloadKind::Progress).await {
                        return;
                    }
                }
                if !send_checked(&mut socket, outgoing, outbound_kind).await {
                    break;
                }
                for replay in after_response {
                    if !send_checked(&mut socket, replay, PayloadKind::Event).await {
                        return;
                    }
                }
            }
            event = runtime_events.recv() => {
                match event {
                    Ok(event) if subscriptions.contains(&event.target) => {
                        // Re-check authority on delivery too: transition can commit while
                        // socket remains subscribed, so stale contexts receive nothing.
                        if !authorize_target(&state, client_context.as_ref(), &event.target) {
                            subscriptions.remove(&event.target);
                            continue;
                        }
                        let outgoing = runtime_event_frame(event);
                        if !send_checked(&mut socket, outgoing, PayloadKind::Event).await {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let outgoing = structured_error(
                            None,
                            "event_sequence_gap",
                            "Runtime events were missed; request a snapshot",
                        );
                        if !send_checked(&mut socket, outgoing, PayloadKind::Event).await {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    if let Ok(mut router) = state.router.lock() {
        router.disconnect(&client_id);
    }
}

fn runtime_event_frame(event: crate::native_pi_manager::NativeRuntimeEvent) -> Value {
    let operation_id = event.event.get("operationId").cloned();
    let turn_id = event.event.get("turnId").cloned();
    let mut frame = json!({
        "type": "runtime_event",
        "target": event.target,
        "sequence": event.sequence,
        "event": event.event,
    });
    if let Some(operation_id) = operation_id {
        frame["operationId"] = operation_id;
    }
    if let Some(turn_id) = turn_id {
        frame["turnId"] = turn_id;
    }
    frame
}

fn runtime_target_is_live(state: &HostState, target: &RuntimeTarget) -> bool {
    state
        .runtimes
        .target_for_session_id(&target.session_id)
        .as_ref()
        == Some(target)
}

fn current_registered_context(state: &HostState, context: &HostClientContext) -> bool {
    let Some(owner) = context.owner_id.as_ref() else {
        return false;
    };
    let current = state
        .owner_registry
        .lock()
        .ok()
        .and_then(|registry| registry.clone())
        .map(|registry| registry.owner_current_workspace(owner));
    matches!(
        current,
        Some(crate::window_owner::OwnerWorkspaceSnapshot::Registered {
            wid,
            generation,
            ..
        }) if context.kind == crate::host_router::ClientKind::Desktop
            && context.workspace_id.as_deref() == Some(wid.as_str())
            && context.workspace_generation == Some(generation)
    )
}

fn dialog_response_allowed(context: Option<&HostClientContext>, target: &RuntimeTarget) -> bool {
    let Some(context) = context else { return false };
    let Some(owner) = context.owner_id.as_ref() else {
        return false;
    };
    context.kind == crate::host_router::ClientKind::Desktop
        && target.owner_id.as_deref() == Some(owner.as_str())
}

fn authorize_target(
    state: &HostState,
    context: Option<&HostClientContext>,
    target: &RuntimeTarget,
) -> bool {
    let Some(context) = context else {
        return false;
    };
    let Some(owner) = context.owner_id.as_ref() else {
        return false;
    };
    if context.kind != crate::host_router::ClientKind::Desktop
        || target.owner_id.as_deref() != Some(owner.as_str())
    {
        return false;
    }
    // Re-read registry authority for every admission. Handshake context is only
    // an identity proof; workspace/generation can change while socket remains open.
    let current = state
        .owner_registry
        .lock()
        .ok()
        .and_then(|registry| registry.clone())
        .map(|registry| registry.owner_current_workspace(owner));
    matches!(
        current,
        Some(crate::window_owner::OwnerWorkspaceSnapshot::Registered {
            wid,
            generation,
            ..
        }) if wid == target.workspace_id && generation == target.workspace_generation
    )
}

fn operation_scope(
    context: Option<&HostClientContext>,
    session_id: &str,
) -> Result<crate::operation_registry::OperationScope, (&'static str, String)> {
    let context = context.ok_or(("unauthenticated", "Authentication required".into()))?;
    let owner = context.owner_id.as_ref().ok_or((
        "unauthorized_target",
        "Registered desktop owner required".into(),
    ))?;
    let workspace = context.workspace_id.as_ref().ok_or((
        "not_registered",
        "Temporary workspace has no registered target".into(),
    ))?;
    let generation = context.workspace_generation.ok_or((
        "stale_generation",
        "Workspace generation is unavailable".into(),
    ))?;
    Ok(crate::operation_registry::OperationScope::new(
        owner.as_str(),
        workspace,
        session_id,
        generation,
    ))
}

async fn dispatch(
    action: RoutedAction,
    state: &HostState,
    context: Option<&HostClientContext>,
    progress: ProgressSink,
) -> Result<Value, (&'static str, String)> {
    match action {
        RoutedAction::OperationStatus {
            request_id,
            operation_id,
            ..
        } => {
            let context = context.ok_or(("unauthenticated", "Authentication required".into()))?;
            if context.kind != crate::host_router::ClientKind::Desktop {
                return Err((
                    "forbidden_class",
                    "Only desktop owner may query operations".into(),
                ));
            }
            let owner = context.owner_id.as_ref().ok_or((
                "unauthorized_target",
                "Registered desktop owner required".into(),
            ))?;
            let workspace = context.workspace_id.as_ref().ok_or((
                "not_registered",
                "Temporary workspace has no registered target".into(),
            ))?;
            let generation = context.workspace_generation.ok_or((
                "stale_generation",
                "Workspace generation is unavailable".into(),
            ))?;
            if !current_registered_context(state, context) {
                return Err(("stale_generation", "Workspace generation is stale".into()));
            }
            let record = state
                .runtimes
                .operation_status_for_context(&operation_id, owner.as_str(), workspace, generation)
                .map_err(|_| {
                    (
                        "operation_not_found",
                        "Operation is not visible to this owner".into(),
                    )
                })?;
            Ok(json!({
                "type": "operation_status_response",
                "requestId": request_id,
                "operationId": operation_id,
                "state": record.state,
                "turnId": record.turn_id,
                "crashReason": record.crash_reason,
                "response": record.terminal_response,
            }))
        }
        RoutedAction::Runtime {
            request_id, frame, ..
        } => {
            let target_value = frame
                .get("target")
                .cloned()
                .ok_or(("invalid_target", "Runtime target is required".into()))?;
            let requested_target: RuntimeTarget = serde_json::from_value(target_value)
                .map_err(|_| ("invalid_target", "Runtime target is invalid".into()))?;
            if !authorize_target(state, context, &requested_target)
                || !runtime_target_is_live(state, &requested_target)
            {
                return Err((
                    "unauthorized_target",
                    "Runtime target is not authorized".into(),
                ));
            }
            if frame.get("type").and_then(Value::as_str) == Some("runtime_snapshot_request") {
                let session_id = requested_target.session_id.as_str();
                let mut target = state
                    .runtimes
                    .target_for_session_id(session_id)
                    .ok_or(("runtime_not_found", "Runtime session is not running".into()))?;
                let state_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_state" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                if target.session_id.starts_with("temporary-") {
                    if let Some(formal_session_id) = state_response
                        .pointer("/data/sessionId")
                        .and_then(Value::as_str)
                        .filter(|session_id| !session_id.is_empty())
                    {
                        target = state
                            .runtimes
                            .bind_session_id(&target, formal_session_id)
                            .map_err(|message| ("session_binding_failed", message))?;
                    }
                }
                let messages_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_messages" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                let stats_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_session_stats" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                let host_snapshot = state
                    .runtimes
                    .snapshot(&target)
                    .map_err(|message| ("snapshot_failed", message))?;
                return Ok(json!({
                    "type": "runtime_snapshot",
                    "requestId": request_id,
                    "target": target,
                    "sequence": host_snapshot.sequence,
                    "state": {
                        "lifecycle": host_snapshot.state,
                        "pi": state_response.get("data").cloned().unwrap_or(Value::Null),
                        "messages": messages_response.pointer("/data/messages").cloned().unwrap_or_else(|| json!([])),
                        "stats": stats_response.get("data").cloned().unwrap_or(Value::Null),
                    }
                }));
            }
            if frame.get("type").and_then(Value::as_str) == Some("runtime_capabilities_request") {
                return Ok(json!({
                    "type": "runtime_capabilities",
                    "requestId": request_id,
                    "protocolVersion": PROTOCOL_VERSION,
                    "nativeRpc": true,
                    "extensionUi": true,
                    "sessionTree": true,
                    "oauth": false,
                    "hostDataPlane": true,
                    "sourcePreservingFork": false,
                }));
            }
            if frame.get("type").and_then(Value::as_str) != Some("runtime_request") {
                return Err((
                    "unsupported_runtime_request",
                    "Unsupported runtime request".into(),
                ));
            }
            let target = requested_target;
            let command = frame
                .get("command")
                .cloned()
                .ok_or(("invalid_command", "Runtime command is required".into()))?;
            let scope = operation_scope(context, &target.session_id)?;
            if command.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                if !dialog_response_allowed(context, &target) {
                    return Err((
                        "dialog_response_forbidden",
                        "Only the current workspace owner may answer this dialog".into(),
                    ));
                }
                state
                    .runtimes
                    .respond_extension_ui(&target, command)
                    .await
                    .map_err(|message| ("dialog_response_failed", message))?;
                return Ok(json!({
                    "type": "runtime_response",
                    "requestId": request_id,
                    "acceptance": "duplicate_completed",
                    "operationId": format!("dialog-{request_id}"),
                    "response": { "success": true },
                }));
            }
            if command.get("type").and_then(Value::as_str) == Some("abort") {
                let response = state
                    .runtimes
                    .abort_turn(
                        &target,
                        &scope,
                        command.get("turnId").and_then(Value::as_str),
                        Duration::from_secs(30),
                    )
                    .await
                    .map_err(|message| ("runtime_request_failed", message))?;
                return Ok(
                    json!({ "type": "runtime_response", "requestId": request_id, "acceptance": "accepted_pending", "operationId": format!("abort-{request_id}"), "response": response }),
                );
            }
            let key = frame.get("idempotencyKey").and_then(Value::as_str).ok_or((
                "idempotency_key_required",
                "Runtime mutations require idempotencyKey".into(),
            ))?;
            let (operation_id, acceptance, response) = state
                .runtimes
                .request_scoped_receipt(&target, scope, command, key, Duration::from_secs(30))
                .await
                .map_err(|message| ("runtime_request_failed", message))?;
            let acceptance = match acceptance {
                crate::operation_registry::OperationAcceptance::Accepted => "accepted_pending",
                crate::operation_registry::OperationAcceptance::DuplicatePending => {
                    "duplicate_pending"
                }
                crate::operation_registry::OperationAcceptance::DuplicateCompleted => {
                    "duplicate_completed"
                }
            };
            Ok(json!({
                "type": "runtime_response", "requestId": request_id,
                "acceptance": acceptance, "operationId": operation_id,
                "response": response,
            }))
        }
        RoutedAction::Auth {
            request_id, frame, ..
        } => match frame.get("operation").and_then(Value::as_str) {
            Some("create_pairing") => {
                if context
                    .is_none_or(|context| context.kind != crate::host_router::ClientKind::Unpaired)
                {
                    return Err((
                        "forbidden_class",
                        "Pairing can only be created by an unpaired browser".into(),
                    ));
                }
                let pairing = state
                    .auth
                    .lock()
                    .map_err(|_| ("auth_unavailable", "Remote auth unavailable".into()))?
                    .create_pairing(now_seconds());
                Ok(json!({
                    "type": "auth_response",
                    "requestId": request_id,
                    "pairingToken": pairing.token,
                    "expiresAt": pairing.expires_at,
                }))
            }
            _ => Err((
                "unknown_auth_operation",
                "Unsupported auth operation".into(),
            )),
        },
        RoutedAction::Host {
            client_id,
            request_id,
            operation,
            frame,
        } => {
            let context = context.ok_or(("unauthenticated", "Authentication required".into()))?;
            if context.kind != crate::host_router::ClientKind::Desktop
                || !current_registered_context(state, context)
            {
                return Err((
                    "stale_generation",
                    "Verified desktop workspace context is stale".into(),
                ));
            }
            let owner = context.owner_id.clone().ok_or((
                "unauthorized_target",
                "Registered desktop owner required".into(),
            ))?;
            // P4-d: session export — one-shot TTL'd token bound to the owner
            // and the resolved session file.
            if operation == "session_export" {
                let session_id = frame
                    .pointer("/args/sessionId")
                    .and_then(Value::as_str)
                    .ok_or((
                        "invalid_export",
                        "sessionId is required for session_export".to_owned(),
                    ))?;
                let workspace_id = context
                    .workspace_id
                    .as_deref()
                    .ok_or(("not_registered", "Registered workspace required".to_owned()))?;
                let path = state
                    .data
                    .session_file_path(workspace_id, session_id)
                    .ok_or(("session_unavailable", "Session file unavailable".to_owned()))?;
                if !path.is_file() {
                    return Err(("session_unavailable", "Session file unavailable".into()));
                }
                let generation = context.workspace_generation.unwrap_or_default();
                let (token, _) = state
                    .session_exports
                    .issue(owner.as_str(), generation, path)
                    .map_err(|error| ("export_quota", error))?;
                return Ok(json!({
                    "type": "host_response",
                    "requestId": request_id,
                    "operation": "session_export",
                    "exportUrl": format!("/v2/session-export/{token}"),
                    "expiresInSecs": state.session_exports.ttl_secs(),
                }));
            }
            if matches!(
                operation.as_str(),
                "settings_get" | "settings_put" | "agent_text_file_get" | "agent_text_file_put"
            ) {
                let args = frame.get("args").cloned().unwrap_or_else(|| json!({}));
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("AGENTS.md");
                let scope = args
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("workspace");
                let root = if scope == "global" {
                    dirs::home_dir()
                        .ok_or((
                            "config_unavailable",
                            "Global config root unavailable".to_owned(),
                        ))?
                        .join(".pi/agent")
                } else {
                    let workspace_id = context
                        .workspace_id
                        .as_deref()
                        .ok_or(("not_registered", "Registered workspace required".to_owned()))?;
                    state
                        .data
                        .workspace_root(workspace_id)
                        .map_err(host_data_error)?
                };
                if name.contains('/')
                    || name.contains('\\')
                    || name.is_empty()
                    || matches!(name, "." | "..")
                {
                    return Err((
                        "invalid_config_path",
                        "Config path is not allowed".to_owned(),
                    ));
                }
                let path = root.join(name);
                let response = match operation.as_str() {
                    "settings_get" => crate::host_config::read_json(&path)
                        .map(|value| json!({ "value": value }))
                        .map_err(|error| (error.code(), "Settings read failed".to_owned()))?,
                    "settings_put" => {
                        let value = args
                            .get("value")
                            .ok_or(("invalid_config", "value is required".to_owned()))?;
                        // Plan §14: model config keeps backup + restart notice.
                        let requires_restart =
                            matches!(name, "models.json" | "agent.json" | "APPEND_SYSTEM.md");
                        if requires_restart && path.exists() {
                            let backup = path.with_extension(format!(
                                "{}.bak",
                                path.extension()
                                    .and_then(|value| value.to_str())
                                    .unwrap_or_default()
                            ));
                            let _ = std::fs::copy(&path, &backup);
                        }
                        crate::host_config::write_json(&path, value)
                            .map_err(|error| (error.code(), "Settings write failed".to_owned()))?;
                        json!({ "saved": true, "restartRequired": requires_restart })
                    }
                    "agent_text_file_get" => {
                        let metadata = std::fs::metadata(&path).map_err(|_| {
                            ("config_not_found", "Config file unavailable".to_owned())
                        })?;
                        if metadata.len() as usize > crate::host_config::MAX_CONFIG_BYTES {
                            return Err((
                                "config_too_large",
                                "Config file exceeds the text bound".to_owned(),
                            ));
                        }
                        let content = std::fs::read_to_string(&path).map_err(|_| {
                            ("config_not_found", "Config file unavailable".to_owned())
                        })?;
                        json!({ "content": content })
                    }
                    "agent_text_file_put" => {
                        let content = args
                            .get("content")
                            .and_then(Value::as_str)
                            .ok_or(("invalid_config", "content is required".to_owned()))?;
                        crate::host_config::write_text(&path, content)
                            .map_err(|error| (error.code(), "Config write failed".to_owned()))?;
                        json!({ "saved": true })
                    }
                    _ => unreachable!(),
                };
                return Ok(
                    json!({ "type": "host_response", "requestId": request_id, "operation": operation, "response": response }),
                );
            }
            if matches!(
                operation.as_str(),
                "get_oauth_login_capabilities"
                    | "start_oauth_login"
                    | "cancel_oauth_login"
                    | "get_oauth_login_status"
                    | "logout_oauth_login"
            ) {
                let mut oauth = state
                    .oauth
                    .lock()
                    .map_err(|_| ("oauth_unavailable", "OAuth manager unavailable".to_owned()))?;
                let args = frame.get("args").cloned().unwrap_or_else(|| json!({}));
                let generation = oauth.generation();
                // The v2 OAuth surface is fail-closed until the CP7 Pi
                // device-code bridge lands: capabilities must not advertise a
                // provider whose login cannot complete, and start/logout must
                // fail loudly instead of fabricating a pending operation or a
                // completed logout. Cancel/status stay real host-side state.
                let response = match operation.as_str() {
                    "get_oauth_login_capabilities" => json!({ "providers": [] }),
                    "start_oauth_login" => {
                        return Err((
                            "oauth_pi_bridge_unavailable",
                            "OAuth login requires the Pi device-code bridge (CP7); no operation was created".to_owned(),
                        ));
                    }
                    "cancel_oauth_login" => {
                        let operation_id = args
                            .get("operationId")
                            .and_then(Value::as_str)
                            .ok_or(("invalid_operation", "operationId is required".to_owned()))?;
                        oauth
                            .cancel(owner.as_str(), generation, operation_id)
                            .map_err(|error| (error.code(), "OAuth cancel rejected".to_owned()))?;
                        json!({ "operationId": operation_id, "status": "cancelled" })
                    }
                    "get_oauth_login_status" => {
                        let operation_id = args
                            .get("operationId")
                            .and_then(Value::as_str)
                            .ok_or(("invalid_operation", "operationId is required".to_owned()))?;
                        let status = oauth
                            .status(owner.as_str(), generation, operation_id)
                            .map_err(|error| {
                                (error.code(), "OAuth status unavailable".to_owned())
                            })?;
                        json!({ "operationId": operation_id, "status": format!("{status:?}").to_ascii_lowercase() })
                    }
                    "logout_oauth_login" => {
                        return Err((
                            "oauth_pi_bridge_unavailable",
                            "OAuth logout requires the Pi device-code bridge (CP7); credentials were not revoked".to_owned(),
                        ));
                    }
                    _ => unreachable!(),
                };
                return Ok(json!({
                    "type": "host_response",
                    "requestId": request_id,
                    "operation": operation,
                    "response": response,
                }));
            }
            let handler = state
                .control_handler
                .lock()
                .map_err(|_| {
                    (
                        "control_unavailable",
                        "Host control handler unavailable".into(),
                    )
                })?
                .clone()
                .ok_or((
                    "control_unavailable",
                    "Host control handler unavailable".into(),
                ))?;
            let client_id = client_id.parse::<u64>().unwrap_or(0);
            let verified = VerifiedClientContext {
                client_id,
                class: crate::broker_ws::ClientClass::Native,
                owner_id: Some(owner),
            };
            let args = frame.get("args").cloned().unwrap_or(Value::Null);
            let canonical = json!({
                "type": "host_request",
                "requestId": request_id,
                "operation": operation,
                "args": args,
            });
            let result = handler(verified, canonical, progress)
                .await
                .map_err(|message| ("host_operation_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": operation,
                "response": result,
            }))
        }
        RoutedAction::Data {
            request_id, frame, ..
        } => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
            let authorized = context.is_some_and(|ctx| {
                ctx.kind == crate::host_router::ClientKind::Desktop
                    && ctx.workspace_id.as_deref() == Some(workspace_id)
                    // Re-read registry authority: handshake context must not
                    // keep write access across a workspace transition.
                    && current_registered_context(state, ctx)
            });
            if !authorized {
                return Err(("unauthorized_target", "Workspace is not authorized".into()));
            }
            match frame.get("operation").and_then(Value::as_str) {
                Some("file_mentions") => {
                    let query = frame.get("query").and_then(Value::as_str).unwrap_or("");
                    let entries = state
                        .data
                        .file_mentions(workspace_id, query)
                        .map_err(host_data_error)?;
                    Ok(
                        json!({ "type": "data_response", "requestId": request_id, "operation": "file_mentions", "entries": entries }),
                    )
                }
                Some("list_files") => {
                    let workspace_id = frame
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                    let relative_path = frame
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let entries = state
                        .data
                        .list_files(workspace_id, relative_path)
                        .map_err(host_data_error)?;
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "list_files",
                        "entries": entries,
                    }))
                }
                Some("list_sessions") => {
                    let workspace_id = frame
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                    let sessions = state
                        .data
                        .list_sessions(workspace_id)
                        .map_err(host_data_error)?;
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "list_sessions",
                        "sessions": sessions,
                    }))
                }
                Some("search_sessions") => {
                    let workspace_id = frame
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                    let query = frame.get("query").and_then(Value::as_str).unwrap_or("");
                    let results = state
                        .data
                        .search_sessions(workspace_id, query)
                        .map_err(host_data_error)?;
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "search_sessions",
                        "results": results,
                    }))
                }
                Some("cost_dashboard") => {
                    let workspace_id = frame
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                    let dashboard = state
                        .data
                        .cost_dashboard(workspace_id)
                        .map_err(host_data_error)?;
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "cost_dashboard",
                        "dashboard": dashboard,
                    }))
                }
                Some("file_read") => {
                    let path = frame
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_path", "path is required".into()))?;
                    let root = state
                        .data
                        .workspace_root(workspace_id)
                        .map_err(host_data_error)?;
                    let content = crate::host_files::read(&root, path)
                        .map_err(|error| (error.code(), "File read failed".to_owned()))?;
                    let text = String::from_utf8(content.bytes)
                        .map_err(|_| ("binary_file", "Binary file requires raw download".into()))?;
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "file_read",
                        "path": content.relative_path,
                        "content": text,
                        "modifiedAtMs": content.modified_at_ms,
                    }))
                }
                Some("file_write") => {
                    let path = frame
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_path", "path is required".into()))?;
                    let content = frame
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_content", "content is required".into()))?;
                    let expected = frame
                        .get("expectedModifiedAtMs")
                        .and_then(Value::as_u64)
                        .map(u128::from);
                    let key = frame.get("idempotencyKey").and_then(Value::as_str).ok_or((
                        "idempotency_key_required",
                        "File writes require idempotencyKey".into(),
                    ))?;
                    // Plan §14: writes walk the mutation/Operation Registry.
                    let scope = operation_scope(context, "workspace-files")?;
                    let root = state
                        .data
                        .workspace_root(workspace_id)
                        .map_err(host_data_error)?;
                    let path_for_write = path;
                    let content_for_write = content;
                    let (operation_id, acceptance, modified_at_ms) = state
                        .runtimes
                        .host_mutation(scope, key, "file_write", "workspace-files", || {
                            crate::host_files::write(
                                &root,
                                path_for_write,
                                content_for_write.as_bytes(),
                                expected,
                            )
                            .map(|modified| json!(modified))
                            .map_err(|error| (error.code(), "File write failed".to_owned()).1)
                        })
                        .map_err(|message| ("file_write_failed", message))?;
                    let acceptance = match acceptance {
                        crate::operation_registry::OperationAcceptance::Accepted => {
                            "accepted_pending"
                        }
                        crate::operation_registry::OperationAcceptance::DuplicatePending => {
                            return Err((
                                "duplicate_pending",
                                "File write is still pending for this idempotency key".into(),
                            ))
                        }
                        crate::operation_registry::OperationAcceptance::DuplicateCompleted => {
                            "duplicate_completed"
                        }
                    };
                    let modified_at_ms =
                        modified_at_ms.and_then(|value| value.as_u64()).ok_or((
                            "file_write_failed",
                            "Completed write lost its terminal result".into(),
                        ))?;
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "file_write",
                        "operationId": operation_id,
                        "acceptance": acceptance,
                        "path": path,
                        "modifiedAtMs": modified_at_ms,
                    }))
                }
                Some("file_raw") => {
                    let path = frame
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or(("invalid_path", "path is required".into()))?;
                    let root = state
                        .data
                        .workspace_root(workspace_id)
                        .map_err(host_data_error)?;
                    let content = crate::host_files::read(&root, path)
                        .map_err(|error| (error.code(), "File read failed".to_owned()))?;
                    use base64::Engine;
                    let encoded =
                        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(content.bytes);
                    Ok(json!({
                        "type": "data_response",
                        "requestId": request_id,
                        "operation": "file_raw",
                        "path": content.relative_path,
                        "contentBase64": encoded,
                        "modifiedAtMs": content.modified_at_ms,
                    }))
                }
                _ => Err((
                    "unknown_data_operation",
                    "Unsupported data operation".into(),
                )),
            }
        }
        RoutedAction::Subscribe { request_id, .. } => Ok(json!({
            "type": "runtime_subscribed",
            "requestId": request_id,
        })),
    }
}

fn host_data_error(error: HostDataError) -> (&'static str, String) {
    match error {
        HostDataError::UnknownWorkspace => {
            ("workspace_not_found", "Workspace is not registered".into())
        }
        HostDataError::InvalidRelativePath | HostDataError::OutsideWorkspace => (
            "path_outside_workspace",
            "Requested path is outside the registered workspace".into(),
        ),
        HostDataError::NotDirectory => (
            "not_a_directory",
            "Requested path is not a directory".into(),
        ),
        HostDataError::Io(message) => ("file_access_failed", message),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingExchangeRequest {
    pairing_token: String,
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingExchangeResponse {
    device_token: String,
}

async fn exchange_pairing(
    State(state): State<Arc<HostState>>,
    Json(request): Json<PairingExchangeRequest>,
) -> Result<Json<PairingExchangeResponse>, (StatusCode, Json<Value>)> {
    let token = state
        .auth
        .lock()
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable"))?
        .exchange(&request.pairing_token, &request.device_id, now_seconds())
        .map_err(|_| api_error(StatusCode::UNAUTHORIZED, "pairing_rejected"))?;
    Ok(Json(PairingExchangeResponse {
        device_token: token,
    }))
}

async fn unimplemented_api_route() -> (StatusCode, Json<Value>) {
    api_error(StatusCode::NOT_FOUND, "unimplemented_route")
}

fn api_error(status: StatusCode, code: &'static str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": { "code": code } })))
}

async fn send_error(
    socket: &mut WebSocket,
    request_id: Option<&str>,
    code: &'static str,
    message: &str,
) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            structured_error(request_id, code, message)
                .to_string()
                .into(),
        ))
        .await
}

fn structured_error(request_id: Option<&str>, code: &'static str, message: &str) -> Value {
    json!({
        "type": "error",
        "requestId": request_id,
        "error": { "code": code, "message": message },
    })
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{bind_is_loopback, dialog_response_allowed, HostServer};
    use crate::host_router::HostClientContext;
    use crate::metadata_store::MetadataStore;
    use crate::native_pi_manager::NativePiManager;
    use crate::remote_auth::RemoteAuth;
    use crate::runtime_coordinator::RuntimeTarget;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn oauth_runtime_restart_revokes_previous_operation() {
        let mut manager = crate::oauth_manager::OAuthManager::default();
        let first_generation = manager.runtime_started();
        let operation = manager
            .start(
                crate::oauth_manager::OAuthClient::Desktop,
                "owner",
                "oauth-test",
                Duration::from_secs(60),
            )
            .expect("OAuth operation starts");
        assert_eq!(operation.generation, first_generation);
        manager.runtime_stopped();
        let second_generation = manager.runtime_started();
        assert_eq!(
            manager.status("owner", first_generation, "oauth-test"),
            Err(crate::oauth_manager::OAuthError::OperationNotFound)
        );
        assert!(second_generation > first_generation);
    }

    #[tokio::test]
    async fn oauth_host_controls_fail_closed_until_pi_bridge_lands() {
        use tokio_tungstenite::tungstenite::Message;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-oauth-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let registry = Arc::new(crate::window_owner::WindowOwnerRegistry::default());
        let host = HostServer::start(public, NativePiManager::new(8), auth, metadata)
            .await
            .expect("host server starts");
        let (_owner, capability) = registry
            .create_owner_with_workspace(
                "oauth-contract-window".into(),
                workspace,
                0,
                host.origin().into(),
                Some("oauth-workspace".into()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        host.set_owner_registry(registry);
        host.runtime_started().expect("generation advances");
        let (mut socket, _) = tokio_tungstenite::connect_async(
            host.origin().replacen("http://", "ws://", 1) + "/v2/ws",
        )
        .await
        .unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type": "hello", "protocolVersion": 2, "clientType": "desktop",
                    "clientId": "oauth-contract-window", "desktopCapability": capability
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let ack: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(ack["type"], "hello_ack");
        let request = |operation: &str| {
            json!({
                "type": "host_request", "requestId": format!("oauth-{operation}"),
                "operation": operation, "args": {}
            })
            .to_string()
        };
        socket
            .send(Message::Text(request("get_oauth_login_capabilities")))
            .await
            .unwrap();
        let response: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(response["type"], "host_response");
        assert_eq!(response["response"]["providers"], json!([]));
        for operation in ["start_oauth_login", "logout_oauth_login"] {
            socket
                .send(Message::Text(request(operation)))
                .await
                .unwrap();
            let error: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(
                error["type"], "error",
                "{operation} must fail closed: {error}"
            );
            assert_eq!(error["error"]["code"], "oauth_pi_bridge_unavailable");
        }
        socket
            .send(Message::Text(
                json!({
                    "type": "host_request", "requestId": "oauth-cancel-unknown",
                    "operation": "cancel_oauth_login",
                    "args": { "operationId": "ghost" }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let error: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(error["error"]["code"], "oauth_operation_not_found");
        let _ = socket.close(None).await;
        host.stop();
        let _ = fs::remove_dir_all(temp);
    }

    #[tokio::test]
    #[ignore = "real host-origin + embedded Pi smoke; run via scripts/smoke-host-origin-p3.mjs"]
    async fn native_smoke_host_origin_p3() {
        use crate::native_pi_manager::NativeRuntimeType;
        use crate::pi_launch::native_launch_spec_for;
        use std::time::Duration;
        use tokio_tungstenite::tungstenite::Message;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-origin-p3-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let public = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public");
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let runtimes = NativePiManager::new(32);
        let registry = Arc::new(crate::window_owner::WindowOwnerRegistry::default());
        let host = HostServer::start(public.clone(), runtimes.clone(), auth, metadata)
            .await
            .expect("host server starts");
        let (owner, capability) = registry
            .create_owner_with_workspace(
                "p3-smoke-window".into(),
                workspace.clone(),
                0,
                host.origin().into(),
                Some("p3-workspace".into()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        host.set_owner_registry(registry);
        let target = RuntimeTarget::with_owner(
            "p3-workspace",
            "p3-session",
            format!("p3-instance-{nonce}"),
            owner.as_str(),
            0,
        );
        let spec = native_launch_spec_for(&public, NativeRuntimeType::Primary, &workspace, None)
            .expect("native launch spec resolves embedded Pi");
        runtimes
            .spawn(target.clone(), spec)
            .expect("embedded Pi spawns");

        if let Some(output_path) = std::env::var_os("PICOT_P3_PERF_OUTPUT") {
            let samples = std::env::var("PICOT_P3_PERF_SAMPLES")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(20);
            let warmup = std::env::var("PICOT_P3_PERF_WARMUP")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(3);
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let shell_url = format!(
                "{}/workspaces/{}/sessions/{}",
                host.origin(),
                target.workspace_id,
                target.session_id
            );
            let capability_url = format!(
                "{}/v2/bootstrap?workspaceId={}&sessionId={}",
                host.origin(),
                target.workspace_id,
                target.session_id
            );
            let shell_start = std::time::Instant::now();
            let shell_status = client.get(&shell_url).send().await.unwrap().status();
            let shell_ms = shell_start.elapsed().as_secs_f64() * 1000.0;
            let bootstrap_start = std::time::Instant::now();
            let bootstrap_status = client
                .get(&capability_url)
                .header("x-picot-desktop-capability", &capability)
                .send()
                .await
                .unwrap()
                .status();
            let bootstrap_ms = bootstrap_start.elapsed().as_secs_f64() * 1000.0;
            assert!(shell_status.is_success() && bootstrap_status.is_success());
            let ws_url = host.origin().replacen("http://", "ws://", 1) + "/v2/ws";
            let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
            socket
                .send(Message::Text(
                    json!({
                        "type": "hello", "protocolVersion": 2, "clientType": "desktop",
                        "clientId": "p3-perf-window", "desktopCapability": capability
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
            let _: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            socket
                .send(Message::Text(
                    json!({
                        "type": "runtime_subscribe", "requestId": "perf-sub", "target": target
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
            let _: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            let mut snapshot_ms = Vec::with_capacity(samples);
            let mut prompt_ms = Vec::with_capacity(samples);
            for index in 0..(warmup + samples) {
                let snapshot_started = std::time::Instant::now();
                let snapshot_id = format!("perf-snapshot-{index}");
                socket
                    .send(Message::Text(
                        json!({
                            "type": "runtime_snapshot_request", "requestId": snapshot_id,
                            "target": target.clone()
                        })
                        .to_string(),
                    ))
                    .await
                    .unwrap();
                let snapshot = loop {
                    let frame: Value = serde_json::from_str(
                        tokio::time::timeout(Duration::from_secs(30), socket.next())
                            .await
                            .unwrap()
                            .unwrap()
                            .unwrap()
                            .to_text()
                            .unwrap(),
                    )
                    .unwrap();
                    if frame["type"] == "runtime_snapshot" && frame["requestId"] == snapshot_id {
                        break snapshot_started.elapsed().as_secs_f64() * 1000.0;
                    }
                };
                let prompt_started = std::time::Instant::now();
                let prompt_id = format!("perf-prompt-{index}");
                socket
                    .send(Message::Text(
                        json!({
                            "type": "runtime_request", "requestId": prompt_id,
                            "idempotencyKey": prompt_id, "target": target.clone(),
                            "command": { "type": "prompt", "message": "Reply with one short word." }
                        })
                        .to_string(),
                    ))
                    .await
                    .unwrap();
                let (prompt, turn_id) = loop {
                    let frame: Value = serde_json::from_str(
                        tokio::time::timeout(Duration::from_secs(30), socket.next())
                            .await
                            .unwrap()
                            .unwrap()
                            .unwrap()
                            .to_text()
                            .unwrap(),
                    )
                    .unwrap();
                    if frame["type"] == "runtime_event" {
                        let turn_id = frame["turnId"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned);
                        break (prompt_started.elapsed().as_secs_f64() * 1000.0, turn_id);
                    }
                };
                if let Some(turn_id) = turn_id {
                    socket.send(Message::Text(json!({
                        "type": "runtime_request", "requestId": format!("perf-abort-{index}"),
                        "target": target.clone(), "command": { "type": "abort", "turnId": turn_id }
                    }).to_string())).await.unwrap();
                    loop {
                        let frame: Value = serde_json::from_str(
                            socket.next().await.unwrap().unwrap().to_text().unwrap(),
                        )
                        .unwrap();
                        if frame["type"] == "runtime_response"
                            && frame["requestId"] == format!("perf-abort-{index}")
                        {
                            break;
                        }
                    }
                }
                if index >= warmup {
                    snapshot_ms.push(snapshot);
                    prompt_ms.push(prompt);
                }
            }
            fs::write(
                output_path,
                serde_json::to_vec_pretty(&json!({
                    "samples": samples, "warmup": warmup,
                    "shellMs": shell_ms, "bootstrapMs": bootstrap_ms,
                    "snapshotMs": snapshot_ms, "promptToFirstEventMs": prompt_ms
                }))
                .unwrap(),
            )
            .unwrap();
            let _ = socket.close(None).await;
            runtimes.stop(&target).expect("perf runtime stops");
            host.stop();
            let _ = fs::remove_dir_all(temp);
            return;
        }

        // Optional browser harness rendezvous. The Rust test owns real HostServer
        // and embedded Pi; a separate real Chromium process drives browser APIs.
        if let Some(handshake_path) = std::env::var_os("PICOT_P3_BROWSER_HANDSHAKE") {
            let handshake = json!({
                "origin": host.origin(),
                "capability": capability,
                "workspaceId": target.workspace_id,
                "sessionId": target.session_id,
                "owner": owner.as_str(),
            });
            fs::write(handshake_path, serde_json::to_vec(&handshake).unwrap()).unwrap();
            let done_path =
                std::env::var_os("PICOT_P3_BROWSER_DONE").expect("browser harness done path");
            let deadline = std::time::Instant::now() + Duration::from_secs(120);
            while !std::path::Path::new(&done_path).exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "browser harness timed out"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let shell = client
            .get(format!(
                "{}/workspaces/{}/sessions/{}",
                host.origin(),
                target.workspace_id,
                target.session_id
            ))
            .send()
            .await
            .unwrap();
        assert!(
            shell.status().is_success(),
            "host shell status={}",
            shell.status()
        );
        assert!(shell.text().await.unwrap().contains("<base href="));
        let bootstrap = client
            .get(format!(
                "{}/v2/bootstrap?workspaceId={}&sessionId={}",
                host.origin(),
                target.workspace_id,
                target.session_id
            ))
            .header("x-picot-desktop-capability", &capability)
            .send()
            .await
            .unwrap();
        let bootstrap_status = bootstrap.status();
        let bootstrap_body = bootstrap.text().await.unwrap();
        assert!(
            bootstrap_status.is_success(),
            "bootstrap status={bootstrap_status} body={bootstrap_body}"
        );
        assert_eq!(
            serde_json::from_str::<RuntimeTarget>(&bootstrap_body).unwrap(),
            target
        );
        assert_eq!(
            client
                .get(format!("{}/ws", host.origin()))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(format!(
                    "{}/v2/bootstrap?workspaceId=other&sessionId=s",
                    host.origin()
                ))
                .header("x-picot-desktop-capability", &capability)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!(
                    "{}/v2/bootstrap?workspaceId={}&sessionId={}",
                    host.origin(),
                    target.workspace_id,
                    target.session_id
                ))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );

        let ws_url = host.origin().replacen("http://", "ws://", 1) + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type": "hello", "protocolVersion": 2, "clientType": "desktop",
                    "clientId": "p3-smoke-window", "desktopCapability": capability
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let ack: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(30), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(ack["type"], "hello_ack");
        socket
            .send(Message::Text(
                json!({
                    "type": "runtime_subscribe", "requestId": "sub-1", "target": target
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let subscribed: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(subscribed["type"], "runtime_subscribed");
        socket
            .send(Message::Text(
                json!({
                    "type": "runtime_snapshot_request", "requestId": "state-1", "target": target
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let response = loop {
            let frame: Value = serde_json::from_str(
                tokio::time::timeout(Duration::from_secs(30), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .to_text()
                    .unwrap(),
            )
            .unwrap();
            if frame["type"] == "runtime_snapshot" && frame["requestId"] == "state-1" {
                break frame;
            }
        };
        assert_eq!(
            response["type"], "runtime_snapshot",
            "read-only snapshot response: {response}"
        );
        assert_eq!(response["requestId"], "state-1");
        assert!(response["state"].is_object());
        let snapshot_sequence = response["sequence"].as_u64().unwrap();

        // Drive one real prompt through HostServer → native bridge → embedded Pi.
        // No model result is required: the accepted response plus first runtime
        // event proves prompt dispatch and event forwarding without asserting
        // provider-specific text.
        socket
            .send(Message::Text(
                json!({
                    "type": "runtime_request", "requestId": "prompt-1",
                    "idempotencyKey": "p3-prompt-1", "target": target,
                    "command": { "type": "prompt", "message": "Reply with one short word." }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let mut prompt_response = None;
        let mut turn_id = None;
        let mut first_event_sequence = None;
        for _ in 0..16 {
            let frame: Value = serde_json::from_str(
                tokio::time::timeout(Duration::from_secs(30), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .to_text()
                    .unwrap(),
            )
            .unwrap();
            if frame["type"] == "runtime_response" && frame["requestId"] == "prompt-1" {
                prompt_response = Some(frame);
                break;
            }
            if frame["type"] == "runtime_event" {
                first_event_sequence = frame["sequence"].as_u64();
                if let Some(id) = frame["turnId"].as_str().filter(|id| !id.is_empty()) {
                    turn_id = Some(id.to_owned());
                }
            }
        }
        let prompt_response = prompt_response.expect("prompt response must arrive");
        assert_eq!(
            prompt_response["type"], "runtime_response",
            "prompt response: {prompt_response}"
        );
        assert_eq!(prompt_response["requestId"], "prompt-1");
        assert!(matches!(
            prompt_response["acceptance"].as_str(),
            Some("accepted_pending" | "duplicate_pending" | "duplicate_completed")
        ));

        for _ in 0..16 {
            if turn_id.is_some() {
                break;
            }
            let event: Value = serde_json::from_str(
                tokio::time::timeout(Duration::from_secs(30), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .to_text()
                    .unwrap(),
            )
            .unwrap();
            if event["type"] != "runtime_event" {
                continue;
            }
            first_event_sequence = event["sequence"].as_u64();
            if let Some(id) = event["turnId"].as_str().filter(|id| !id.is_empty()) {
                turn_id = Some(id.to_owned());
                break;
            }
        }
        assert!(
            first_event_sequence.is_some(),
            "prompt must produce runtime event"
        );
        if let Some(turn_id) = turn_id {
            // Abort exact observed turn; stale turn IDs must never affect a new turn.
            socket
                .send(Message::Text(
                    json!({
                        "type": "runtime_request", "requestId": "abort-1", "target": target,
                        "command": { "type": "abort", "turnId": turn_id }
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
            let abort_response: Value = serde_json::from_str(
                tokio::time::timeout(Duration::from_secs(30), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .to_text()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                abort_response["type"], "runtime_response",
                "abort response: {abort_response}"
            );
            assert_eq!(abort_response["requestId"], "abort-1");
            assert_ne!(abort_response["response"]["disposition"], "stale_turn");
        }

        // Reconnect on same authorized owner, then hydrate from authoritative snapshot.
        let _ = socket.close(None).await;
        let (mut reconnected, _) = tokio_tungstenite::connect_async(
            host.origin().replacen("http://", "ws://", 1) + "/v2/ws",
        )
        .await
        .unwrap();
        reconnected
            .send(Message::Text(
                json!({
                    "type": "hello", "protocolVersion": 2, "clientType": "desktop",
                    "clientId": "p3-smoke-window-reconnect", "desktopCapability": capability
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let reconnect_ack: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(30), reconnected.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reconnect_ack["type"], "hello_ack");
        reconnected
            .send(Message::Text(
                json!({
                    "type": "runtime_subscribe", "requestId": "sub-reconnect", "target": target
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let subscribed: Value = serde_json::from_str(
            reconnected
                .next()
                .await
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(subscribed["type"], "runtime_subscribed");
        reconnected
            .send(Message::Text(json!({
                "type": "runtime_snapshot_request", "requestId": "state-reconnect", "target": target
            }).to_string()))
            .await.unwrap();
        let reconnect_snapshot = loop {
            let frame: Value = serde_json::from_str(
                tokio::time::timeout(Duration::from_secs(30), reconnected.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .to_text()
                    .unwrap(),
            )
            .unwrap();
            if frame["type"] == "runtime_snapshot" && frame["requestId"] == "state-reconnect" {
                break frame;
            }
        };
        assert_eq!(reconnect_snapshot["type"], "runtime_snapshot");
        assert_eq!(reconnect_snapshot["requestId"], "state-reconnect");
        assert!(reconnect_snapshot["sequence"].as_u64().unwrap() >= snapshot_sequence);
        assert!(first_event_sequence
            .is_none_or(|sequence| reconnect_snapshot["sequence"].as_u64().unwrap() >= sequence));
        let _ = reconnected.close(None).await;
        runtimes.stop(&target).expect("smoke runtime stops");
        host.stop();
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn dialog_response_policy_requires_owner_desktop_class() {
        let target = RuntimeTarget::with_owner("workspace", "session", "instance", "owner", 3);
        let owner = crate::window_owner::OwnerId::from_string("owner".into());
        let desktop = HostClientContext::desktop(
            "desktop",
            owner,
            crate::window_owner::OwnerWorkspaceSnapshot::Registered {
                wid: "workspace".into(),
                root: "/workspace".into(),
                generation: 3,
            },
        );
        assert!(dialog_response_allowed(Some(&desktop), &target));
        assert!(!dialog_response_allowed(
            Some(&HostClientContext::remote("remote")),
            &target
        ));
        assert!(!dialog_response_allowed(
            Some(&HostClientContext::public("browser")),
            &target
        ));
        let other = HostClientContext::desktop(
            "other",
            crate::window_owner::OwnerId::from_string("other-owner".into()),
            crate::window_owner::OwnerWorkspaceSnapshot::Registered {
                wid: "workspace".into(),
                root: "/workspace".into(),
                generation: 3,
            },
        );
        assert!(!dialog_response_allowed(Some(&other), &target));
    }

    #[test]
    fn bind_policy_rejects_non_loopback_addresses() {
        assert!(bind_is_loopback("127.0.0.1".parse().unwrap()));
        assert!(bind_is_loopback("::1".parse().unwrap()));
        assert!(!bind_is_loopback("192.168.1.10".parse().unwrap()));
    }

    #[tokio::test]
    async fn retained_routes_have_complete_auth_method_and_limit_contract() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-api-contract-{nonce}"));
        let workspace_a = temp.join("workspace-a");
        let workspace_b = temp.join("workspace-b");
        fs::create_dir_all(&workspace_a).unwrap();
        fs::create_dir_all(&workspace_b).unwrap();
        fs::write(workspace_a.join("note.txt"), "contract").unwrap();
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let (workspace_a_id, workspace_b_id) = {
            let store = metadata.lock().unwrap();
            let a = store.add_workspace(&workspace_a).unwrap().0.workspace_id;
            let b = store.add_workspace(&workspace_b).unwrap().0.workspace_id;
            (a, b)
        };
        assert_ne!(workspace_a_id, workspace_b_id);
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let registry = Arc::new(crate::window_owner::WindowOwnerRegistry::default());
        let host = HostServer::start(public, NativePiManager::new(32), auth, metadata)
            .await
            .unwrap();
        let (owner_a, capability_a) = registry
            .create_owner_with_workspace(
                "contract-a".into(),
                workspace_a,
                0,
                host.origin().into(),
                Some(workspace_a_id.clone()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        let (_owner_b, capability_b) = registry
            .create_owner_with_workspace(
                "contract-b".into(),
                workspace_b,
                0,
                host.origin().into(),
                Some(workspace_b_id.clone()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        host.set_owner_registry(registry);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        // Health/version are deliberately public host metadata. They must not
        // accidentally inherit workspace authorization, but remain GET-only.
        for route in ["/health", "/api/health", "/api/pi-version"] {
            let response = client
                .get(format!("{}{}", host.origin(), route))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success(), "route={route}");
            let response = client
                .post(format!("{}{}", host.origin(), route))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::METHOD_NOT_ALLOWED,
                "route={route}"
            );
        }

        let retained = [
            ("/api/files?workspaceId=", "files"),
            ("/api/sessions?workspaceId=", "sessions"),
            ("/api/search?workspaceId=", "search"),
            ("/api/cost-dashboard?workspaceId=", "cost-dashboard"),
        ];
        for (prefix, name) in retained {
            let route_a = if name == "files" {
                format!("{prefix}{workspace_a_id}&path=.")
            } else if name == "search" {
                format!("{prefix}{workspace_a_id}&q=contract")
            } else {
                format!("{prefix}{workspace_a_id}")
            };
            let url = |route: &str| format!("{}{}", host.origin(), route);

            let missing = client.get(url(&route_a)).send().await.unwrap();
            assert_eq!(
                missing.status(),
                reqwest::StatusCode::UNAUTHORIZED,
                "route={name}"
            );
            assert_eq!(
                missing.json::<Value>().await.unwrap()["error"]["code"],
                "unauthenticated"
            );

            let wrong_owner = client
                .get(url(&route_a))
                .header("x-picot-desktop-capability", &capability_b)
                .send()
                .await
                .unwrap();
            let wrong_owner_status = wrong_owner.status();
            let wrong_owner_body = wrong_owner.text().await.unwrap();
            assert_eq!(
                wrong_owner_status,
                reqwest::StatusCode::FORBIDDEN,
                "route={name} body={wrong_owner_body}"
            );
            assert_eq!(
                serde_json::from_str::<Value>(&wrong_owner_body).unwrap()["error"]["code"],
                "unauthorized_target"
            );

            let wrong_workspace = if name == "files" {
                format!("{prefix}{workspace_b_id}&path=.")
            } else if name == "search" {
                format!("{prefix}{workspace_b_id}&q=contract")
            } else {
                format!("{prefix}{workspace_b_id}")
            };
            let wrong_workspace = client
                .get(url(&wrong_workspace))
                .header("x-picot-desktop-capability", &capability_a)
                .send()
                .await
                .unwrap();
            assert_eq!(
                wrong_workspace.status(),
                reqwest::StatusCode::FORBIDDEN,
                "route={name}"
            );
            assert_eq!(
                wrong_workspace.json::<Value>().await.unwrap()["error"]["code"],
                "unauthorized_target"
            );

            let valid = client
                .get(url(&route_a))
                .header("x-picot-desktop-capability", &capability_a)
                .send()
                .await
                .unwrap();
            assert!(valid.status().is_success(), "route={name}");

            let method = client
                .post(url(&route_a))
                .header("x-picot-desktop-capability", &capability_a)
                .send()
                .await
                .unwrap();
            // Retained compatibility routes are read-only GET routes.
            assert_eq!(
                method.status(),
                reqwest::StatusCode::METHOD_NOT_ALLOWED,
                "route={name}"
            );
        }

        // Body limits apply before handler dispatch on a body-bearing route;
        // retained GET routes remain method-rejected without reading a body.
        let oversized = client
            .post(format!("{}/v2/auth/exchange", host.origin()))
            .header("content-type", "application/json")
            .body(vec![b'x'; 2 * 1024 * 1024])
            .send()
            .await;
        assert!(
            oversized.is_err()
                || oversized.unwrap().status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE,
            "HTTP body limit must reject oversized input"
        );

        assert_eq!(owner_a.as_str().len(), 32);
        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn legacy_api_routes_require_owner_capability_and_unknown_routes_fail_closed() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-api-auth-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, metadata)
            .await
            .unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        // Every retained existing-shell route must enforce the same desktop
        // capability boundary. Keep this list in lockstep with the router
        // registrations above; a new retained route without this assertion is
        // an accidental unauthenticated compatibility surface.
        for route in [
            "/api/files?workspaceId=w",
            "/api/sessions?workspaceId=w",
            "/api/search?workspaceId=w&q=ab",
            "/api/cost-dashboard?workspaceId=w",
        ] {
            let response = client
                .get(format!("{}{}", host.origin(), route))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED,
                "retained route must require capability: {route}"
            );
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["error"]["code"], "unauthenticated", "route={route}");
        }

        // D8 (2026-08-29): /api/rpc is retired with an explicit 410 Gone +
        // deprecation header + anonymous client-class hit counting.
        let rpc_gone = client
            .get(format!("{}/api/rpc", host.origin()))
            .send()
            .await
            .unwrap();
        assert_eq!(rpc_gone.status(), reqwest::StatusCode::GONE);
        assert_eq!(
            rpc_gone
                .headers()
                .get("deprecation")
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        let rpc_body: Value = rpc_gone.json().await.unwrap();
        assert_eq!(rpc_body["error"]["code"], "gone");
        assert!(rpc_body["removalNotice"].is_string());
        assert!(rpc_body["clientClass"].is_string());
        let rpc_gone_post = client
            .post(format!("{}/api/rpc", host.origin()))
            .send()
            .await
            .unwrap();
        assert_eq!(rpc_gone_post.status(), reqwest::StatusCode::GONE);

        // Unretained routes without a migration path fail closed (404).
        for route in ["/api/not-retained", "/api/super-agent/tasks"] {
            for request in [
                client.get(format!("{}{}", host.origin(), route)),
                client.post(format!("{}{}", host.origin(), route)),
            ] {
                let response = request.send().await.unwrap();
                assert_eq!(
                    response.status(),
                    reqwest::StatusCode::NOT_FOUND,
                    "route={route}"
                );
                let body: Value = response.json().await.unwrap();
                assert_eq!(
                    body["error"]["code"], "unimplemented_route",
                    "route={route}"
                );
            }
        }
        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn serves_health_and_static_assets_from_one_origin() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, metadata)
            .await
            .unwrap();

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let health_response = client
            .get(format!("{}/health", host.origin()))
            .send()
            .await
            .unwrap();
        assert!(health_response.status().is_success());
        let health: serde_json::Value =
            serde_json::from_str(&health_response.text().await.unwrap()).unwrap();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["protocolVersion"].as_u64(), Some(2));
        assert!(health["piVersion"].as_str().is_some());
        let index = client
            .get(format!("{}/app/settings", host.origin()))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(index.contains("Picot native host"));

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn serves_static_assets_under_a_content_fingerprinted_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-versioned-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(public.join("native")).unwrap();
        fs::write(
            public.join("index.html"),
            "<html><head><base href=\"/\" /></head><body>Picot</body></html>",
        )
        .unwrap();
        fs::write(public.join("native/app.js"), "export const marker = 1;").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let host = HostServer::start(public.clone(), NativePiManager::new(32), auth, metadata)
            .await
            .unwrap();

        // The entry document's <base> should point at a `/v/<fingerprint>/`
        // path derived from the bundle contents, not the literal "/" that's
        // on disk — every relative script/import resolves under it.
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let index = client
            .get(format!("{}/app/settings", host.origin()))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let base_start = index.find("<base href=\"").unwrap() + "<base href=\"".len();
        let base_end = index[base_start..].find('"').unwrap();
        let base_href = &index[base_start..base_start + base_end];
        assert!(
            base_href.starts_with("/v/") && base_href.ends_with('/'),
            "expected a versioned base href, got {base_href:?}"
        );

        // The versioned path actually serves the underlying files.
        let app_js = client
            .get(format!("{}{}native/app.js", host.origin(), base_href))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(app_js, "export const marker = 1;");

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn sends_runtime_events_only_after_an_explicit_target_subscription() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-ws-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let runtimes = NativePiManager::new(32);
        let registry = Arc::new(crate::window_owner::WindowOwnerRegistry::default());
        let (owner, capability) = registry
            .create_owner_with_workspace(
                "desktop-a".into(),
                temp.clone(),
                0,
                "http://127.0.0.1:1".into(),
                Some("workspace-a".into()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        let target =
            RuntimeTarget::with_owner("workspace-a", "session-a", "instance-a", owner.as_str(), 0);
        let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
        let host = HostServer::start(public, runtimes, auth, metadata)
            .await
            .unwrap();
        host.set_owner_registry(registry);
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "desktop-a",
                    "desktopCapability": capability
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_subscribe",
                    "requestId": "subscribe-1",
                    "target": target,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();

        fake.write_frame(json!({ "type": "agent_start" }))
            .await
            .unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
            .await
            .expect("subscribed runtime event")
            .unwrap()
            .unwrap();
        let event: serde_json::Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
        assert_eq!(event["type"], "runtime_event");
        assert_eq!(event["target"]["sessionId"], "session-a");
        assert_eq!(event["sequence"], 1);

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn first_subscriber_cannot_claim_another_owners_extension_ui_response() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-dialog-owners-{nonce}"));
        let public = temp.join("public");
        let owner_b_root = temp.join("owner-b");
        fs::create_dir_all(&public).unwrap();
        fs::create_dir_all(&owner_b_root).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let runtimes = NativePiManager::new(32);
        let registry = Arc::new(crate::window_owner::WindowOwnerRegistry::default());
        let (owner_a, capability_a) = registry
            .create_owner_with_workspace(
                "desktop-a".into(),
                temp.clone(),
                0,
                "http://127.0.0.1:1".into(),
                Some("workspace-a".into()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        let (owner_b, capability_b) = registry
            .create_owner_with_workspace(
                "desktop-b".into(),
                owner_b_root,
                0,
                "http://127.0.0.1:2".into(),
                Some("workspace-b".into()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        assert_ne!(owner_a, owner_b);
        let target = RuntimeTarget::with_owner(
            "workspace-b",
            "session-b",
            "instance-b",
            owner_b.as_str(),
            0,
        );
        let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
        fake.write_frame(json!({
            "type": "extension_ui_request",
            "id": "dialog-b",
            "method": "select",
            "title": "Project trust",
            "options": ["Trust once", "Open untrusted"]
        }))
        .await
        .unwrap();
        tokio::task::yield_now().await;

        let host = HostServer::start(public, runtimes, auth, metadata)
            .await
            .unwrap();
        host.set_owner_registry(registry);
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket_a, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
        socket_a
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "desktop-a",
                    "desktopCapability": capability_a
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket_a.next().await.unwrap().unwrap();
        socket_a
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_subscribe",
                    "requestId": "subscribe-a",
                    "target": target,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let denied = socket_a.next().await.unwrap().unwrap();
        let denied: serde_json::Value = serde_json::from_str(denied.to_text().unwrap()).unwrap();
        assert_eq!(denied["type"], "error");
        assert_eq!(denied["error"]["code"], "unauthorized_target");

        let (mut socket_b, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
        socket_b
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "desktop-b",
                    "desktopCapability": capability_b
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket_b.next().await.unwrap().unwrap();
        socket_b
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_subscribe",
                    "requestId": "subscribe-b",
                    "target": target,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket_b.next().await.unwrap().unwrap();
        let replay = socket_b.next().await.unwrap().unwrap();
        let replay: serde_json::Value = serde_json::from_str(replay.to_text().unwrap()).unwrap();
        assert_eq!(replay["event"]["id"], "dialog-b");

        socket_b
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_request",
                    "requestId": "dialog-response-b",
                    "target": target,
                    "command": {
                        "type": "extension_ui_response",
                        "id": "dialog-b",
                        "value": "Trust once"
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket_b.next().await.unwrap().unwrap();
        assert_eq!(
            fake.read_request().await.unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "dialog-b",
                "value": "Trust once"
            })
        );

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn replays_startup_extension_ui_and_routes_the_owners_response_exactly_once() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-dialog-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = Arc::new(Mutex::new(
            MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
        ));
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::clone(&metadata))));
        let runtimes = NativePiManager::new(32);
        let registry = Arc::new(crate::window_owner::WindowOwnerRegistry::default());
        let (owner, capability) = registry
            .create_owner_with_workspace(
                "owner".into(),
                temp.clone(),
                0,
                "http://127.0.0.1:1".into(),
                Some("workspace-a".into()),
                crate::window_owner::TemporaryKind::DefaultStartup,
            )
            .unwrap();
        let target =
            RuntimeTarget::with_owner("workspace-a", "session-a", "instance-a", owner.as_str(), 0);
        let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
        fake.write_frame(json!({
            "type": "extension_ui_request",
            "id": "dialog-1",
            "method": "select",
            "title": "Project trust",
            "options": ["Trust once", "Open untrusted"]
        }))
        .await
        .unwrap();
        tokio::task::yield_now().await;

        let host = HostServer::start(public, runtimes, auth, metadata)
            .await
            .unwrap();
        host.set_owner_registry(registry);
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "owner",
                    "desktopCapability": capability
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_subscribe",
                    "requestId": "subscribe",
                    "target": target,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        let replay = socket.next().await.unwrap().unwrap();
        let replay: serde_json::Value = serde_json::from_str(replay.to_text().unwrap()).unwrap();
        assert_eq!(replay["event"]["id"], "dialog-1");

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_request",
                    "requestId": "dialog-response",
                    "target": target,
                    "command": {
                        "type": "extension_ui_response",
                        "id": "dialog-1",
                        "value": "Trust once"
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        assert_eq!(
            fake.read_request().await.unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "dialog-1",
                "value": "Trust once"
            })
        );

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }
}
