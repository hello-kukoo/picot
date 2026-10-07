// ABOUTME: Host-plane per-package extension settings — the op → config-module table.
// ABOUTME: Keeps the host dispatch facade thin; every op here is desktop-only and file-backed.

use serde_json::Value;

/// Operations served by a per-package config module. Callers must run their own
/// authorization check first: these ops read and write the user's Pi config
/// files (`~/.pi/agent/*.json`, `~/.config/*.json`).
pub fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "get_fff_config"
            | "set_fff_config"
            | "get_todo_config"
            | "set_todo_config"
            | "get_askuser_config"
            | "set_askuser_config"
            | "get_ponytail_config"
            | "set_ponytail_config"
            | "get_vcc_config"
            | "set_vcc_config"
            | "get_goal_config"
            | "set_goal_config"
            | "get_caveman_config"
            | "set_caveman_config"
            | "get_cache_optimizer_config"
            | "set_cache_optimizer_config"
            | "get_lens_config"
            | "set_lens_config"
    )
}

/// Dispatch a handled operation. `frame` carries the op arguments at the top
/// level (the control gateway flattens `params` into the request frame).
pub fn dispatch(operation: &str, frame: &Value) -> Result<Value, (&'static str, String)> {
    // Each module reports plain string errors; the tagged code is added once
    // here so the modules stay free of transport concerns.
    let result: Result<Value, String> = match operation {
        "get_fff_config" => Ok(crate::fff_config::get_config()),
        "set_fff_config" => crate::fff_config::set_config(frame),
        "get_todo_config" => crate::rpiv_config::get_todo_config(),
        "set_todo_config" => crate::rpiv_config::set_todo_config(frame),
        "get_askuser_config" => crate::rpiv_config::get_askuser_config(),
        "set_askuser_config" => crate::rpiv_config::set_askuser_config(frame),
        "get_ponytail_config" => crate::ponytail_config::get_config(),
        "set_ponytail_config" => crate::ponytail_config::set_config(frame),
        "get_vcc_config" => crate::vcc_config::get_config(),
        "set_vcc_config" => crate::vcc_config::set_config(frame),
        "get_goal_config" => crate::goal_config::get_config(),
        "set_goal_config" => crate::goal_config::set_config(frame),
        "get_caveman_config" => crate::caveman_config::get_config(),
        "set_caveman_config" => crate::caveman_config::set_config(frame),
        "get_cache_optimizer_config" => crate::cache_optimizer_config::get_config(),
        "set_cache_optimizer_config" => crate::cache_optimizer_config::set_config(frame),
        "get_lens_config" => crate::lens_config::get_config(frame),
        "set_lens_config" => crate::lens_config::set_config(frame),
        other => {
            return Err((
                "unknown_host_operation",
                format!("Unsupported operation {other}"),
            ))
        }
    };
    result.map_err(|message| ("extension_config_failed", message))
}
