// ABOUTME: Host-side model-config support shared across windows: the
// ABOUTME: host-wide available-models cache plus Pi settings.json object IO.
// ABOUTME: The static provider catalog / auth.json / health-check surfaces
// ABOUTME: retired here moved to the Pi `/picot-config` bridge (live registry).

use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Mutex;

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
