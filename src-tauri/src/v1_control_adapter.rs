// ABOUTME: Defines production legacy broker-control mappings to canonical v2 operations.
// ABOUTME: Rejects unknown controls before execution and records mutation idempotency metadata.

use crate::transport_limits::{validate, PayloadKind};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalKind {
    Runtime,
    Host,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlMapping {
    pub kind: CanonicalKind,
    pub operation: &'static str,
    pub mutation: bool,
}

// Workspace and process lifecycle are host-owned. Never classify these as
// runtime requests: runtime arm forwards commands to Pi, while these controls
// must reach the Rust lifecycle handler.
const HOST_LIFECYCLE_CONTROLS: &[(&str, bool)] = &[
    ("open_workspace", true),
    ("new_session", true),
    ("switch_session", true),
    ("fork", true),
    ("navigate_tree", true),
    ("stop_instance", true),
    ("spawn_session_process", true),
];

// Registry controls are a closed surface. Do not accept an arbitrary
// `workspace.*`/`preference.*` operation from a legacy client: that would turn
// the v1 adapter into an unbounded host RPC tunnel.
const REGISTRY_CONTROLS: &[(&str, bool)] = &[
    ("workspace.list", false),
    ("workspace.add", true),
    ("workspace.remove", true),
    ("workspace.pin", true),
    ("preference.get", false),
    ("preference.set", true),
    ("preference.delete", true),
    ("preference.list", false),
    // Provider auth mutations (P5: sole ownership)
    ("set_api_key", true),
    ("remove_api_key", true),
    ("set_model_visibility", true),
    ("set_default_thinking_level", true),
    ("set_skill_enabled", true),
];

const HOST_CONTROLS: &[(&str, bool)] = &[
    ("pick_folder", false),
    ("pick_skill_source", false),
    ("pick_image_files", false),
    ("list_installed_apps", false),
    ("open_in_app", true),
    ("open_external", true),
    ("open_devtools", false),
    ("skill_scan_install_source", false),
    ("skill_install_links", true),
    ("list_pi_packages", false),
    ("check_pi_package_updates", false),
    ("install_pi_package", true),
    ("remove_pi_package", true),
    ("update_pi_package", true),
    ("set_pi_package_disabled", true),
    ("restart_runtime", true),
    ("session_export", false),
    ("get_pi_version", false),
    ("get_app_version", false),
    ("is_dev", false),
    ("get_cached_models", false),
    ("session_ui_profile_load", false),
    ("session_ui_profile_save", true),
    ("check_for_update", false),
    ("download_and_install_update", true),
    ("rpc_extension_ui_response", true),
    ("ephemeral_extension_ui_response", true),
    ("ephemeral_create", true),
    ("ephemeral_replace_quick", true),
    ("ephemeral_close", true),
    ("ephemeral_bootstrap", false),
    ("ephemeral_update_ui", true),
    ("workspace_target_prepare", true),
    ("workspace_transition_commit", true),
    ("workspace_transition_cancel", true),
    ("window_close_cancel", true),
    ("window_close_approve", true),
    ("window_close_risk_response", true),
    ("relaunch_app", true),
];

/// Return mapping for a legacy broker control. Dynamic registry controls are
/// deliberately included as one namespace: their operation key remains the
/// allowlisted v1 command and is not treated as arbitrary host input.
pub fn mapping(command: &str) -> Option<ControlMapping> {
    if let Some((_name, mutation)) = REGISTRY_CONTROLS.iter().find(|(name, _)| *name == command) {
        return Some(ControlMapping {
            kind: CanonicalKind::Host,
            operation: "host_request",
            mutation: *mutation,
        });
    }
    HOST_LIFECYCLE_CONTROLS
        .iter()
        .chain(HOST_CONTROLS.iter())
        .find(|(name, _)| *name == command)
        .map(|(_, mutation)| ControlMapping {
            kind: CanonicalKind::Host,
            operation: "host_request",
            mutation: *mutation,
        })
}

/// Canonical adapter envelope. Legacy clients still receive v1 responses; this
/// frame is the single internal mapping boundary used by production dispatch.
pub fn to_v2(command: &str, request_id: &str, args: Value) -> Result<Value, String> {
    let Some(mapping) = mapping(command) else {
        return Err(format!(
            "unimplemented_route: control \"{command}\" has no v2 mapping"
        ));
    };
    let mut frame = if mapping.kind == CanonicalKind::Runtime {
        json!({"type": mapping.operation, "requestId": request_id, "command": {"type": command}, "args": args})
    } else {
        json!({"type": mapping.operation, "requestId": request_id, "operation": command, "args": args})
    };
    if mapping.mutation {
        frame["idempotencyKey"] = Value::String(format!("v1-ctl-{request_id}"));
    }
    let kind = match mapping.kind {
        CanonicalKind::Runtime => PayloadKind::Command,
        CanonicalKind::Host => PayloadKind::HostRequest,
    };
    validate(&frame, kind).map_err(|code| code.to_string())?;
    Ok(frame)
}

/// Translate one legacy Pi event at the canonical boundary. Unknown event
/// names remain opaque in `event`; consumers decide whether they understand
/// them, while ordering and target identity stay explicit.
pub fn event_to_v2(
    payload: Value,
    workspace_id: Value,
    session_id: Value,
    instance_id: Value,
    sequence: u64,
) -> Value {
    let event = if payload.get("type").and_then(Value::as_str) == Some("event") {
        payload.get("event").cloned().unwrap_or(payload)
    } else {
        payload
    };
    json!({
        "type": "runtime_event",
        "target": {
            "workspaceId": workspace_id,
            "sessionId": session_id,
            "instanceId": instance_id,
        },
        "sequence": sequence,
        "event": event,
    })
}

#[cfg(test)]
mod tests {
    use super::{event_to_v2, mapping, to_v2, CanonicalKind};
    use serde_json::json;

    #[test]
    fn maps_runtime_and_host_controls_with_kind() {
        assert_eq!(mapping("new_session").unwrap().kind, CanonicalKind::Host);
        assert_eq!(mapping("pick_folder").unwrap().kind, CanonicalKind::Host);
        assert_eq!(mapping("workspace.list").unwrap().kind, CanonicalKind::Host);
    }

    #[test]
    fn every_p3_existing_shell_control_has_an_explicit_mapping() {
        let controls = [
            "open_workspace",
            "new_session",
            "switch_session",
            "fork",
            "navigate_tree",
            "stop_instance",
            "spawn_session_process",
            "pick_folder",
            "pick_skill_source",
            "pick_image_files",
            "list_installed_apps",
            "open_in_app",
            "open_external",
            "open_devtools",
            "skill_scan_install_source",
            "skill_install_links",
            "list_pi_packages",
            "check_pi_package_updates",
            "install_pi_package",
            "remove_pi_package",
            "update_pi_package",
            "set_pi_package_disabled",
            "restart_runtime",
            "get_pi_version",
            "get_app_version",
            "is_dev",
            "get_cached_models",
            "session_ui_profile_load",
            "session_ui_profile_save",
            "check_for_update",
            "download_and_install_update",
            "rpc_extension_ui_response",
            "ephemeral_extension_ui_response",
            "ephemeral_create",
            "ephemeral_replace_quick",
            "ephemeral_close",
            "ephemeral_bootstrap",
            "ephemeral_update_ui",
            "workspace_target_prepare",
            "workspace_transition_commit",
            "workspace_transition_cancel",
            "window_close_cancel",
            "window_close_approve",
            "window_close_risk_response",
            "relaunch_app",
            "workspace.list",
            "workspace.add",
            "workspace.remove",
            "workspace.pin",
            "preference.get",
            "preference.set",
            "preference.delete",
            "preference.list",
        ];
        for control in controls {
            assert!(mapping(control).is_some(), "missing v1 mapping: {control}");
        }
    }

    #[test]
    fn adapter_enforces_runtime_business_limit_at_limit_minus_equal_plus_one() {
        let target = crate::transport_limits::HOST_REQUEST_BYTES;
        let mut low = 0usize;
        let mut high = target;
        while low < high {
            let mid = low + (high - low) / 2;
            let frame = to_v2("new_session", "aaa", json!({"message": "x".repeat(mid)}));
            if frame
                .as_ref()
                .is_ok_and(|frame| crate::transport_limits::serialized_size(frame) < target)
            {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let length = (low.saturating_sub(1)..=low + 1)
            .find(|length| {
                to_v2(
                    "new_session",
                    "aaa",
                    json!({"message": "x".repeat(*length)}),
                )
                .is_ok_and(|frame| crate::transport_limits::serialized_size(&frame) == target)
            })
            .expect("fixture must reach exact command limit");
        let under = to_v2(
            "new_session",
            "aaa",
            json!({"message": "x".repeat(length - 1)}),
        );
        let equal = to_v2("new_session", "aaa", json!({"message": "x".repeat(length)}));
        let over = to_v2(
            "new_session",
            "aaa",
            json!({"message": "x".repeat(length + 1)}),
        );
        assert!(under.is_ok());
        assert!(equal.is_ok());
        assert_eq!(over.unwrap_err(), "host_request_too_large");
    }

    #[test]
    fn mutation_mapping_has_stable_v1_idempotency_metadata() {
        let frame = to_v2("fork", "ctl-7", json!({"entryId": "e1"})).unwrap();
        assert_eq!(frame["type"], "host_request");
        assert_eq!(frame["idempotencyKey"], "v1-ctl-ctl-7");
    }

    #[test]
    fn read_mapping_has_no_idempotency_key() {
        let frame = to_v2("pick_folder", "ctl-8", json!({})).unwrap();
        assert_eq!(frame["type"], "host_request");
        assert!(frame.get("idempotencyKey").is_none());
    }

    #[test]
    fn unknown_control_fails_closed() {
        let known = to_v2("list_pi_packages", "ctl-9", json!({})).unwrap();
        assert_eq!(known["operation"], "list_pi_packages");
        assert!(to_v2("not_a_control", "ctl-10", json!({})).is_err());
    }

    #[test]
    fn canonical_adapter_frame_reaches_handler_shape() {
        let frame = to_v2("new_session", "req-1", json!({"workspaceId":"w"})).unwrap();
        assert_eq!(frame["type"], "host_request");
        assert_eq!(frame["operation"], "new_session");
        assert_eq!(frame["requestId"], "req-1");
        assert_eq!(frame["idempotencyKey"], "v1-ctl-req-1");
    }

    #[test]
    fn translates_legacy_event_without_filtering_unknown_event_names() {
        let event = event_to_v2(
            json!({"type": "future_pi_event", "value": 1}),
            json!("workspace-a"),
            json!("session-a"),
            json!("instance-a"),
            7,
        );
        assert_eq!(event["type"], "runtime_event");
        assert_eq!(event["sequence"], 7);
        assert_eq!(event["target"]["sessionId"], "session-a");
        assert_eq!(event["event"]["type"], "future_pi_event");
    }
}
