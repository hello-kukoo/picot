#![cfg_attr(not(test), allow(dead_code))]
// ABOUTME: Native model-config surfaces retired with /api/rpc: provider
// ABOUTME: catalog merging models.json + the models.dev store cache, API-key
// ABOUTME: management over auth.json, visibility/health preferences in
// ABOUTME: picot-models.json, and the host-wide available-models cache.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const HEALTH_CHECK_TIMEOUT_SECS: u64 = 90;
const HEALTH_CHECK_MAX_MODELS: usize = 8;

/// Host-wide cache of the primary runtime's `get_available_models` reply.
/// Warmed after the first session registers; shared by every window so the
/// model dropdown renders instantly on cold start.
#[derive(Default)]
pub struct ModelCache {
    models: Mutex<Option<Value>>,
}

impl ModelCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn store(&self, models: Value) {
        if let Ok(mut slot) = self.models.lock() {
            *slot = Some(models);
        }
    }

    pub fn load(&self) -> Option<Value> {
        self.models.lock().ok().and_then(|slot| slot.clone())
    }
}

fn agent_paths(agent_dir: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    (
        agent_dir.join("auth.json"),
        agent_dir.join("models.json"),
        agent_dir.join("models-store.json"),
        agent_dir.join("picot-models.json"),
    )
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create config dir: {error}"))?;
    }
    let tmp = path.with_extension("picot-tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(value).unwrap_or_default(),
    )
    .map_err(|error| format!("Cannot write config: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("Cannot replace config: {error}"))
}

fn auth_provider_configured(entry: &Value) -> bool {
    match entry {
        Value::Object(object) => {
            object.values().any(|value| !value.is_null())
                || entry.get("type").and_then(Value::as_str).is_some()
        }
        _ => false,
    }
}

/// Build the provider catalog the Models page renders. Models come from the
/// user's models.json plus the models.dev store cache; a provider is
/// `configured` when auth.json carries any credential for it; visibility and
/// health come from picot-models.json (the legacy preference file).
pub fn list_model_catalog(agent_dir: &Path) -> Value {
    let (auth_path, models_path, store_path, prefs_path) = agent_paths(agent_dir);
    let auth = read_json_object(&auth_path);
    let user_models = read_json_object(&models_path);
    let store = read_json_object(&store_path);
    let prefs = read_json_object(&prefs_path);
    let visibility = prefs
        .get("visibility")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let health = prefs
        .get("health")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // Merge provider → models, keyed by `provider/id`; models.json wins.
    let mut merged: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (provider, entry) in &store {
        let models = entry
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        merged.entry(provider.clone()).or_default().extend(models);
    }
    for (provider, entry) in &user_models {
        let models = entry
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let slot = merged.entry(provider.clone()).or_default();
        slot.retain(|model| {
            let id = model.get("id").and_then(Value::as_str).unwrap_or("");
            !models
                .iter()
                .any(|fresh| fresh.get("id").and_then(Value::as_str) == Some(id))
        });
        slot.extend(models);
    }

    let providers: Vec<Value> = merged
        .iter()
        .map(|(provider, models)| {
            let auth_entry = auth.get(provider);
            let configured = auth_entry.is_some_and(auth_provider_configured);
            let auth_type = auth_entry
                .and_then(|entry| entry.get("type"))
                .and_then(Value::as_str)
                .map(|kind| if kind == "oauth" { "oauth" } else { "api-key" })
                .unwrap_or("api-key");
            let mut model_rows: Vec<Value> = models
                .iter()
                .filter_map(|model| {
                    let id = model.get("id").and_then(Value::as_str)?;
                    let key = format!("{provider}/{id}");
                    let visible = visibility
                        .get(&key)
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    Some(json!({
                        "provider": provider,
                        "id": id,
                        "name": model.get("name").cloned().unwrap_or(Value::String(id.to_string())),
                        "contextWindow": model.get("contextWindow").cloned().unwrap_or(Value::Null),
                        "available": configured,
                        "visible": visible,
                        "health": health.get(&key).cloned().unwrap_or(json!({"status": "unknown"})),
                    }))
                })
                .collect();
            model_rows.sort_by(|a, b| {
                a["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["id"].as_str().unwrap_or(""))
            });
            json!({
                "provider": provider,
                "displayName": provider,
                "configured": configured,
                "authType": auth_type,
                "source": if configured { Value::String("auth.json".into()) } else { Value::Null },
                "label": Value::Null,
                "models": model_rows,
            })
        })
        .collect();

    json!({ "providers": providers })
}

/// Persist one provider API key into auth.json (Pi's credential store shape:
/// `{ "provider": { "type": "api_key", "key": "..." } }`).
pub fn set_api_key(agent_dir: &Path, provider: &str, api_key: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider is required".into());
    }
    if api_key.trim().is_empty() {
        return Err("apiKey is required".into());
    }
    let (auth_path, ..) = agent_paths(agent_dir);
    let mut auth = read_json_object(&auth_path);
    auth.insert(
        provider.to_string(),
        json!({ "type": "api_key", "key": api_key }),
    );
    write_json_atomically(&auth_path, &Value::Object(auth))
}

/// Remove one provider credential from auth.json.
pub fn remove_api_key(agent_dir: &Path, provider: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider is required".into());
    }
    let (auth_path, ..) = agent_paths(agent_dir);
    let mut auth = read_json_object(&auth_path);
    auth.remove(provider);
    write_json_atomically(&auth_path, &Value::Object(auth))
}

/// Toggle one model's visibility in picot-models.json.
pub fn set_model_visibility(
    agent_dir: &Path,
    provider: &str,
    model_id: &str,
    visible: bool,
) -> Result<(), String> {
    if provider.trim().is_empty() || model_id.trim().is_empty() {
        return Err("provider and modelId are required".into());
    }
    let (.., prefs_path) = agent_paths(agent_dir);
    let mut prefs = read_json_object(&prefs_path);
    let visibility = prefs
        .entry("visibility".to_string())
        .or_insert_with(|| json!({}));
    if let Some(map) = visibility.as_object_mut() {
        map.insert(format!("{provider}/{model_id}"), Value::Bool(visible));
    }
    write_json_atomically(&prefs_path, &Value::Object(prefs))
}

fn record_health(agent_dir: &Path, provider: &str, model_id: &str, result: &Value) {
    let (.., prefs_path) = agent_paths(agent_dir);
    let mut prefs = read_json_object(&prefs_path);
    let health = prefs
        .entry("health".to_string())
        .or_insert_with(|| json!({}));
    if let Some(map) = health.as_object_mut() {
        map.insert(format!("{provider}/{model_id}"), result.clone());
    }
    let _ = write_json_atomically(&prefs_path, &Value::Object(prefs));
}

/// Run one real completion against a model via the bundled Pi binary — the
/// same end-to-end contract as the legacy health check — persist the outcome
/// to picot-models.json and return it.
pub fn check_model_health(
    agent_dir: &Path,
    static_dir: &Path,
    provider: &str,
    model_id: &str,
) -> Result<Value, String> {
    if provider.trim().is_empty() {
        return Err("provider is required".into());
    }
    let catalog = list_model_catalog(agent_dir);
    let providers = catalog
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let targets: Vec<(String, String)> = providers
        .iter()
        .filter(|p| p["provider"] == provider)
        .flat_map(|p| p["models"].as_array().cloned().unwrap_or_default())
        .filter(|model| {
            if !model_id.is_empty() {
                return model["id"] == model_id;
            }
            model["visible"].as_bool().unwrap_or(true)
                && model["available"].as_bool().unwrap_or(false)
        })
        .filter_map(|model| {
            let id = model["id"].as_str()?.to_string();
            Some((provider.to_string(), id))
        })
        .collect();
    if targets.is_empty() {
        return Err("No matching models available for health check".into());
    }

    let binary = crate::pi_launch::resolve_bundled_pi(static_dir)?;
    let augmented_path = crate::pi_launch::build_augmented_path();
    let pi_agent_root = crate::pi_launch::resolve_pi_agent_root()?;
    let mut results: Vec<Value> = Vec::new();
    for (target_provider, target_model) in targets.iter().take(HEALTH_CHECK_MAX_MODELS) {
        let started = std::time::Instant::now();
        let child = std::process::Command::new(binary.to_string_lossy().to_string())
            .arg("--provider")
            .arg(target_provider)
            .arg("--model")
            .arg(target_model)
            .arg("--print")
            .arg("Reply exactly: OK")
            .env("PATH", &augmented_path)
            .env("PI_CODING_AGENT_DIR", &pi_agent_root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let latency_ms = started.elapsed().as_millis() as u64;
        let result = match child {
            Ok(mut child) => {
                // Bounded wait: a hung provider must not hold the control
                // plane (this handler runs on a worker thread, but the UI
                // health button stays disabled until the response lands).
                let deadline = started + std::time::Duration::from_secs(HEALTH_CHECK_TIMEOUT_SECS);
                let mut status = None;
                while std::time::Instant::now() < deadline {
                    match child.try_wait() {
                        Ok(Some(exit)) => {
                            status = Some(exit);
                            break;
                        }
                        Ok(None) => std::thread::sleep(std::time::Duration::from_millis(250)),
                        Err(error) => {
                            status = None;
                            let _ = child.kill();
                            let error = error.to_string();
                            let result = json!({
                                "provider": target_provider,
                                "modelId": target_model,
                                "status": "unhealthy",
                                "checkedAt": chrono::Utc::now().to_rfc3339(),
                                "latencyMs": latency_ms,
                                "error": sanitize_health_error(&error),
                            });
                            results.push(result);
                            continue;
                        }
                    }
                }
                match status {
                    Some(exit) => {
                        let text = child
                            .stdout
                            .take()
                            .map(|mut pipe| {
                                use std::io::Read;
                                let mut buffer = String::new();
                                let _ = pipe.read_to_string(&mut buffer);
                                buffer
                            })
                            .unwrap_or_default();
                        if exit.success() && !text.trim().is_empty() {
                            json!({
                                "provider": target_provider,
                                "modelId": target_model,
                                "status": "healthy",
                                "checkedAt": chrono::Utc::now().to_rfc3339(),
                                "latencyMs": started.elapsed().as_millis() as u64,
                            })
                        } else if exit.success() {
                            json!({
                                "provider": target_provider,
                                "modelId": target_model,
                                "status": "unhealthy",
                                "checkedAt": chrono::Utc::now().to_rfc3339(),
                                "latencyMs": started.elapsed().as_millis() as u64,
                                "error": "No assistant text returned",
                            })
                        } else {
                            let stderr = child
                                .stderr
                                .take()
                                .map(|mut pipe| {
                                    use std::io::Read;
                                    let mut buffer = String::new();
                                    let _ = pipe.read_to_string(&mut buffer);
                                    buffer
                                })
                                .unwrap_or_default();
                            json!({
                                "provider": target_provider,
                                "modelId": target_model,
                                "status": "unhealthy",
                                "checkedAt": chrono::Utc::now().to_rfc3339(),
                                "latencyMs": started.elapsed().as_millis() as u64,
                                "error": sanitize_health_error(&stderr),
                            })
                        }
                    }
                    None => {
                        let _ = child.kill();
                        let _ = child.wait();
                        json!({
                            "provider": target_provider,
                            "modelId": target_model,
                            "status": "unhealthy",
                            "checkedAt": chrono::Utc::now().to_rfc3339(),
                            "latencyMs": started.elapsed().as_millis() as u64,
                            "error": "health check timed out",
                        })
                    }
                }
            }
            Err(error) => json!({
                "provider": target_provider,
                "modelId": target_model,
                "status": "unhealthy",
                "checkedAt": chrono::Utc::now().to_rfc3339(),
                "latencyMs": latency_ms,
                "error": sanitize_health_error(&error.to_string()),
            }),
        };
        record_health(agent_dir, target_provider, target_model, &result);
        results.push(result);
    }
    Ok(json!({ "results": results }))
}

/// Redact credential-shaped substrings before surfacing provider errors.
fn sanitize_health_error(raw: &str) -> String {
    let mut sanitized = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(position) = rest.find("sk-") {
        sanitized.push_str(&rest[..position]);
        sanitized.push_str("[REDACTED]");
        rest = &rest[position..];
        let end = rest
            .char_indices()
            .skip(3)
            .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '_' && *c != '-')
            .map(|(index, _)| index + 3)
            .unwrap_or(rest.len());
        rest = &rest[end.min(rest.len())..];
    }
    sanitized.push_str(rest);
    sanitized.chars().take(240).collect()
}

/// Compute the visible+available model list for the dropdown cache from a
/// runtime `get_available_models` reply. The runtime bridge returns the full
/// Pi response frame, so the array lives at `data.models`.
pub fn models_from_runtime_reply(reply: &Value) -> Option<Value> {
    let models = reply
        .pointer("/data/models")
        .or_else(|| reply.get("models"))?;
    if !models.is_array() {
        return None;
    }
    Some(models.clone())
}

/// Read a Pi settings JSON file as an object; missing/unparsable files
/// yield an empty object (never a hard failure for UI surfaces).
pub fn read_settings_object(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// Atomically replace a Pi settings JSON file, preserving unknown keys.
pub fn write_settings_object(path: &Path, value: &Value) -> Result<(), String> {
    write_json_atomically(path, value)
}
