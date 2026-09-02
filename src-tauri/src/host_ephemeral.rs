#![cfg_attr(not(test), allow(dead_code))]
// ABOUTME: Native Side/Quick Chat orchestration: one stdio Pi RPC runtime per
// ABOUTME: ephemeral instance, a serialized render-state reducer, and owner-
// ABOUTME: scoped `ephemeral_event` delivery over the host event broadcast.

use crate::ephemeral_registry::{EphemeralKind, EphemeralRegistry};
use crate::native_pi_manager::NativePiManager;
use crate::pi_launch;
use crate::window_owner::OwnerId;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const EPHEMERAL_SESSION_PREFIX: &str = "ephemeral-";
/// Keep the reducer journal bounded: only recent events are replayed and the
/// snapshot watermark is the authoritative dedupe signal on the client.
const MAX_MESSAGES: usize = 512;

/// Serialized render state for one ephemeral chat. Rust port of the embedded
/// runtime's `EphemeralRuntimeState` reducer; the JSON snapshot shape is
/// unchanged so the existing frontend reducer keeps working.
#[derive(Default)]
pub struct EphemeralRenderState {
    sequence: u64,
    messages: Vec<Value>,
    assistant_text: String,
    assistant_thinking: String,
    assistant_active: bool,
    /// Insertion-ordered tool states keyed by toolCallId.
    tools: Vec<(String, EphemeralToolState)>,
    error: Option<String>,
    cost: f64,
    total_tokens: i64,
    model: Option<Value>,
    thinking_level: String,
    thinking_levels: Vec<String>,
    is_streaming: bool,
    context_usage: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct EphemeralToolState {
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
    pub output: String,
    pub status: &'static str,
}

impl EphemeralRenderState {
    pub fn new() -> Self {
        Self {
            thinking_level: "off".into(),
            thinking_levels: vec![
                "off".into(),
                "minimal".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ],
            ..Default::default()
        }
    }

    /// Fold one render-relevant Pi event, returning the sequence watermark.
    pub fn apply_event(&mut self, event: &Value) -> u64 {
        self.sequence += 1;
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "message_start" => {
                let message = event.get("message");
                match message.and_then(|m| m.get("role")).and_then(Value::as_str) {
                    Some("user") => {
                        self.push_message(message.cloned().unwrap_or(Value::Null));
                    }
                    Some("assistant") => {
                        self.assistant_active = true;
                        self.assistant_text = message.map(assistant_text_of).unwrap_or_default();
                        self.assistant_thinking = String::new();
                    }
                    _ => {}
                }
            }
            "message_update" => {
                let ame = event.get("assistantMessageEvent");
                let ame_type = ame
                    .and_then(|e| e.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let delta = ame
                    .and_then(|e| e.get("delta"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if self.assistant_active && ame_type == "text_delta" {
                    self.assistant_text.push_str(&delta);
                } else if self.assistant_active && ame_type == "thinking" {
                    self.assistant_thinking.push_str(&delta);
                }
            }
            "message_end" => {
                let message = event.get("message");
                let role = message
                    .and_then(|m| m.get("role"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if role == "assistant" {
                    self.push_message(message.cloned().unwrap_or(Value::Null));
                    self.assistant_active = false;
                    self.assistant_text = String::new();
                    self.assistant_thinking = String::new();
                    let stop_reason = message
                        .and_then(|m| m.get("stopReason"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if stop_reason == "error" {
                        let detail = message
                            .and_then(|m| m.get("errorMessage"))
                            .and_then(Value::as_str)
                            .unwrap_or("Assistant request failed");
                        self.error = Some(detail.to_string());
                    }
                    let usage = message.and_then(|m| m.get("usage"));
                    let cost_total = usage
                        .and_then(|u| u.pointer("/cost/total"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    let input = usage
                        .and_then(|u| u.get("input"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let output = usage
                        .and_then(|u| u.get("output"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    self.cost += cost_total;
                    self.total_tokens += input + output;
                }
            }
            "tool_execution_start" => {
                let tool_call_id = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !tool_call_id.is_empty() {
                    self.tools.retain(|(id, _)| id != &tool_call_id);
                    self.tools.push((
                        tool_call_id.clone(),
                        EphemeralToolState {
                            tool_call_id,
                            tool_name: event
                                .get("toolName")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            args: event.get("args").cloned().unwrap_or(Value::Null),
                            output: String::new(),
                            status: "pending",
                        },
                    ));
                }
            }
            "tool_execution_update" => {
                let tool_call_id = event.get("toolCallId").and_then(Value::as_str);
                if let Some((_, tool)) = self
                    .tools
                    .iter_mut()
                    .find(|(id, _)| Some(id.as_str()) == tool_call_id)
                {
                    tool.status = "streaming";
                    tool.output.push_str(
                        event
                            .get("partialResult")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    );
                }
            }
            "tool_execution_end" => {
                let tool_call_id = event.get("toolCallId").and_then(Value::as_str);
                if let Some((_, tool)) = self
                    .tools
                    .iter_mut()
                    .find(|(id, _)| Some(id.as_str()) == tool_call_id)
                {
                    tool.status = if event
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        "error"
                    } else {
                        "complete"
                    };
                    tool.output = event
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                }
            }
            "model_select" => {
                self.model = event.get("model").cloned();
            }
            "thinking_level_select" => {
                self.thinking_level = event
                    .get("level")
                    .and_then(Value::as_str)
                    .unwrap_or("off")
                    .to_string();
            }
            "agent_start" => self.is_streaming = true,
            "agent_end" => self.is_streaming = false,
            _ => {}
        }
        self.sequence
    }

    /// Fold a command response into context state (model/thinking updates).
    pub fn apply_response(&mut self, response: &Value) {
        let command = response
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("");
        let data = response.get("data").unwrap_or(&Value::Null);
        match command {
            "set_model" | "cycle_model" => {
                if let Some(model) = data.get("model") {
                    self.model = Some(model.clone());
                }
                if let Some(level) = data.get("thinkingLevel").and_then(Value::as_str) {
                    self.thinking_level = level.to_string();
                }
                if let Some(levels) = data.get("thinkingLevels").and_then(Value::as_array) {
                    let parsed: Vec<String> = levels
                        .iter()
                        .filter_map(|level| level.as_str().map(str::to_string))
                        .collect();
                    if !parsed.is_empty() {
                        self.thinking_levels = parsed;
                    }
                }
            }
            "set_thinking_level" | "cycle_thinking_level" => {
                if let Some(level) = data.get("level").and_then(Value::as_str) {
                    self.thinking_level = level.to_string();
                }
                if let Some(levels) = data.get("levels").and_then(Value::as_array) {
                    let parsed: Vec<String> = levels
                        .iter()
                        .filter_map(|level| level.as_str().map(str::to_string))
                        .collect();
                    if !parsed.is_empty() {
                        self.thinking_levels = parsed;
                    }
                }
            }
            "get_available_models" => {}
            _ => {}
        }
    }

    /// Update non-event context (used after explicit host-side knowledge).
    pub fn set_context_state(&mut self, model: Option<Value>, context_usage: Option<Value>) {
        if let Some(model) = model {
            self.model = Some(model);
        }
        if context_usage.is_some() {
            self.context_usage = context_usage;
        }
    }

    /// Authoritative render snapshot at the current watermark.
    pub fn snapshot(&self, instance_id: &str, generation: u64) -> Value {
        let draft = if self.assistant_active
            && (!self.assistant_text.is_empty() || !self.assistant_thinking.is_empty())
        {
            json!({ "text": self.assistant_text, "thinking": self.assistant_thinking })
        } else {
            Value::Null
        };
        json!({
            "type": "ephemeral_snapshot",
            "instanceId": instance_id,
            "generation": generation,
            "runtimeSequenceWatermark": self.sequence,
            "messages": self.messages,
            "assistantDraft": draft,
            "tools": self.tools.iter().map(|(_, tool)| json!({
                "toolCallId": tool.tool_call_id,
                "toolName": tool.tool_name,
                "args": tool.args,
                "output": tool.output,
                "status": tool.status,
            })).collect::<Vec<_>>(),
            "model": self.model.clone().unwrap_or(Value::Null),
            "thinkingLevel": self.thinking_level,
            "thinkingLevels": self.thinking_levels,
            "isStreaming": self.is_streaming,
            "contextUsage": self.context_usage.clone().unwrap_or(Value::Null),
            "error": self.error,
            "cost": self.cost,
            "totalTokens": self.total_tokens,
        })
    }

    fn push_message(&mut self, message: Value) {
        self.messages.push(message);
        while self.messages.len() > MAX_MESSAGES {
            self.messages.remove(0);
        }
    }
}

fn assistant_text_of(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Native ephemeral chat orchestration. One hub per process; shared by the
/// control handler (create/close/bootstrap), the WebSocket loop (command
/// forwarding, snapshots), and the event pump (state reduction).
pub struct EphemeralHub {
    registry: Arc<EphemeralRegistry>,
    host_events: crate::host_control::HostEventSink,
    static_dir: PathBuf,
    targets: std::sync::Mutex<HashMap<String, RuntimeTargetEntry>>,
    states: std::sync::Mutex<HashMap<String, EphemeralRenderState>>,
}

#[derive(Clone)]
struct RuntimeTargetEntry {
    target: crate::runtime_coordinator::RuntimeTarget,
}

pub type SharedEphemeralHub = Arc<EphemeralHub>;

impl EphemeralHub {
    pub fn new(
        registry: Arc<EphemeralRegistry>,
        host_events: crate::host_control::HostEventSink,
        static_dir: PathBuf,
    ) -> Self {
        Self {
            registry,
            host_events,
            static_dir,
            targets: std::sync::Mutex::new(HashMap::new()),
            states: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a new ephemeral runtime of `kind` in `workspace_cwd` (Quick Chat
    /// runs toolless in a throwaway temp dir) and return its descriptor.
    pub fn create(
        &self,
        runtimes: &NativePiManager,
        owner: &OwnerId,
        workspace_id: &str,
        workspace_cwd: &Path,
        kind: EphemeralKind,
        workspace_generation: u64,
    ) -> Result<Value, String> {
        let runtime_type = match kind {
            EphemeralKind::SideChat => crate::native_pi_manager::NativeRuntimeType::SideChat,
            EphemeralKind::QuickChat => crate::native_pi_manager::NativeRuntimeType::QuickChat,
        };
        // Quick Chat is a throwaway scratch space; Side Chat shares the
        // workspace cwd so file tools still resolve relative paths. The temp
        // dir contract (private root, 0700, random token) lives in
        // temp_resources::create_quick_chat_temp_dir — never hand-roll it.
        let (cwd, cleanup_dir) = if kind == EphemeralKind::QuickChat {
            let (dir, token) = crate::temp_resources::create_quick_chat_temp_dir()?;
            (dir.clone(), Some((dir, token)))
        } else {
            (workspace_cwd.to_path_buf(), None)
        };
        let mut spec =
            pi_launch::native_launch_spec_for(&self.static_dir, runtime_type, &cwd, None)?;
        if let Some(entry) = cleanup_dir {
            spec.cleanup.temporary_directory = Some(entry);
        }
        // spawn_ephemeral mints the instance id internally; the session id is
        // hub-owned so instance and session stay traceable both directions.
        let session_id = format!(
            "{}{}",
            EPHEMERAL_SESSION_PREFIX,
            uuid::Uuid::new_v4().simple()
        );
        let target = runtimes.spawn_ephemeral(
            workspace_id,
            &session_id,
            spec,
            owner,
            kind,
            workspace_generation,
        )?;
        let instance_id = target.instance_id.clone();
        self.targets
            .lock()
            .map_err(|_| "ephemeral target lock poisoned".to_string())?
            .insert(
                instance_id.clone(),
                RuntimeTargetEntry {
                    target: target.clone(),
                },
            );
        self.states
            .lock()
            .map_err(|_| "ephemeral state lock poisoned".to_string())?
            .insert(instance_id.clone(), EphemeralRenderState::new());
        let descriptor = self.descriptor_of(owner, &instance_id);
        self.publish_bootstrap(owner, workspace_generation);
        Ok(descriptor)
    }

    /// Close one ephemeral instance: stop its runtime and clean up.
    pub fn close(
        &self,
        runtimes: &NativePiManager,
        owner: &OwnerId,
        instance_id: &str,
        generation: u64,
        workspace_generation: u64,
    ) -> Result<(), String> {
        // Admission first: never touch tracking state for another owner's
        // instance, even when the registry lookup would already reject it.
        self.owned_target(owner, instance_id, None)?;
        // Registry next: begin_close rejects double closes and, for an
        // in-flight candidate, restores the live quick chat instead.
        let lease = self
            .registry
            .begin_close(owner, instance_id, generation)
            .map_err(|error| format!("Ephemeral close rejected: {error}"))?;
        if let Some(lease) = lease {
            if let Ok(target) = self.take_target(instance_id) {
                let _ = runtimes.stop(&target.target);
            }
            self.registry.finish_cleanup(&lease);
        } else {
            let _ = self.take_target(instance_id);
        }
        self.states
            .lock()
            .map_err(|_| "ephemeral state lock poisoned".to_string())?
            .remove(instance_id);
        self.publish_bootstrap(owner, workspace_generation);
        Ok(())
    }

    /// Replace the single Quick Chat transactionally: reserve a candidate
    /// while the old instance stays live, spawn the candidate, and only commit
    /// the swap once the candidate is ready. A spawn failure cancels the
    /// candidate — the registry restores the old record — so the user's
    /// conversation survives every failure path.
    pub fn replace_quick(
        &self,
        runtimes: &NativePiManager,
        owner: &OwnerId,
        workspace_id: &str,

        workspace_generation: u64,
    ) -> Result<Value, String> {
        let runtime_type = crate::native_pi_manager::NativeRuntimeType::QuickChat;
        let (cwd, cleanup_dir) = {
            let (dir, token) = crate::temp_resources::create_quick_chat_temp_dir()?;
            (dir.clone(), (dir, token))
        };
        let mut spec =
            pi_launch::native_launch_spec_for(&self.static_dir, runtime_type, &cwd, None)?;
        spec.cleanup.temporary_directory = Some(cleanup_dir);
        let replacement = self
            .registry
            .reserve_quick_replacement(owner)
            .map_err(|error| format!("Quick chat replacement rejected: {error}"))?;
        let session_id = format!(
            "{}{}",
            EPHEMERAL_SESSION_PREFIX,
            uuid::Uuid::new_v4().simple()
        );
        let spawn_result = runtimes.spawn_ephemeral_committed(
            replacement.candidate.clone(),
            workspace_id,
            &session_id,
            spec,
            workspace_generation,
        );
        let target = match spawn_result {
            Ok(target) => target,
            Err(error) => {
                // spawn_ephemeral_committed already cancelled the candidate
                // reservation, which restores the old quick chat to Ready.
                return Err(error);
            }
        };
        let instance_id = target.instance_id.clone();
        self.targets
            .lock()
            .map_err(|_| "ephemeral target lock poisoned".to_string())?
            .insert(instance_id.clone(), RuntimeTargetEntry { target });
        self.states
            .lock()
            .map_err(|_| "ephemeral state lock poisoned".to_string())?
            .insert(instance_id.clone(), EphemeralRenderState::new());
        // Candidate is live: only now retire the old instance.
        if let Some((old_id, old_generation)) = replacement.old_instance {
            self.close(
                runtimes,
                owner,
                &old_id,
                old_generation,
                workspace_generation,
            )?;
        }
        let descriptor = self.descriptor_of(owner, &instance_id);
        self.publish_bootstrap(owner, workspace_generation);
        Ok(descriptor)
    }

    /// Owner-scoped live instance descriptors for `owner_bootstrap`.
    pub fn bootstrap_value(&self, owner: &OwnerId, workspace_generation: u64) -> Value {
        json!({
            "type": "owner_bootstrap",
            "workspaceGeneration": workspace_generation,
            "instances": self.registry.descriptors(owner),
        })
    }

    pub fn update_ui(
        &self,
        owner: &OwnerId,
        instance_id: &str,
        generation: u64,
        title: Option<String>,
        unread: Option<bool>,
    ) -> Result<(), String> {
        self.registry.update_ui_metadata(
            owner,
            instance_id,
            generation,
            crate::ephemeral_registry::EphemeralUiPatch { title, unread },
        )
    }

    /// Forward one owner-scoped ephemeral RPC payload to the instance runtime.
    /// The payload gains the caller's requestId as its Pi RPC `id`, and the
    /// correlated response is folded into render state and delivered as an
    /// `ephemeral_event`.
    /// Admission gate for every hub operation addressed by instance id:
    /// the instance must exist AND belong to the authenticated owner. The
    /// optional generation is a compare-only token (like the terminal
    /// broker's): a stale generation rejects the request instead of acting.
    fn owned_target(
        &self,
        owner: &OwnerId,
        instance_id: &str,
        generation: Option<u64>,
    ) -> Result<RuntimeTargetEntry, String> {
        let entry = self
            .target_of(instance_id)
            .ok_or_else(|| "unknown ephemeral instance".to_string())?;
        if entry.target.owner_id.as_deref() != Some(owner.as_str()) {
            return Err("ephemeral instance is not owned by this client".into());
        }
        if let Some(generation) = generation {
            if entry.target.workspace_generation != generation {
                return Err("stale ephemeral generation".into());
            }
        }
        Ok(entry)
    }

    pub async fn forward_command(
        &self,
        runtimes: &NativePiManager,
        owner: &OwnerId,
        instance_id: &str,
        generation: u64,
        payload: Value,
        request_id: &str,
    ) -> Result<(), String> {
        // Admission: owner + generation must match the live target before any
        // state is read or command delivered.
        let entry = self.owned_target(owner, instance_id, Some(generation))?;
        // Snapshot requests never reach the runtime; the hub owns render state.
        // Authoritative model/thinking/context come from a fresh get_state.
        if payload.get("type").and_then(Value::as_str) == Some("ephemeral_snapshot_request") {
            if let Ok(state_reply) = runtimes
                .request(
                    &entry.target,
                    json!({ "type": "get_state" }),
                    None,
                    COMMAND_TIMEOUT,
                )
                .await
            {
                let mut states = self
                    .states
                    .lock()
                    .map_err(|_| "ephemeral state lock poisoned".to_string())?;
                let state = states
                    .entry(instance_id.to_string())
                    .or_insert_with(EphemeralRenderState::new);
                state.set_context_state(
                    state_reply.pointer("/data/model").cloned(),
                    state_reply.pointer("/data/contextUsage").cloned(),
                );
            }
            return self.deliver_snapshot(owner, instance_id, generation, Some(request_id));
        }
        let Some(target) = self.target_of(instance_id) else {
            return Err("unknown ephemeral instance".to_string());
        };
        let mut command = payload;
        if let Some(object) = command.as_object_mut() {
            object.insert("id".into(), Value::String(request_id.to_string()));
        }
        let response = runtimes
            .request(&target.target, command, None, COMMAND_TIMEOUT)
            .await;
        let mut state_guard = self
            .states
            .lock()
            .map_err(|_| "ephemeral state lock poisoned".to_string())?;
        let state = state_guard
            .entry(instance_id.to_string())
            .or_insert_with(EphemeralRenderState::new);
        let frame = match response {
            Ok(value) => {
                state.apply_response(&value);
                json!({
                    "type": "ephemeral_event",
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "generation": generation,
                    "payload": value,
                })
            }
            Err(error) => json!({
                "type": "ephemeral_command_failed",
                "requestId": request_id,
                "error": error,
            }),
        };
        drop(state_guard);
        self.host_events.send_owner_event(owner, frame);
        Ok(())
    }

    /// Build and deliver the authoritative snapshot for one instance.
    pub fn deliver_snapshot(
        &self,
        owner: &OwnerId,
        instance_id: &str,
        generation: u64,
        request_id: Option<&str>,
    ) -> Result<(), String> {
        // Defense in depth: public callers must pass admission too.
        self.owned_target(owner, instance_id, None)?;
        let states = self
            .states
            .lock()
            .map_err(|_| "ephemeral state lock poisoned".to_string())?;
        let state = states
            .get(instance_id)
            .ok_or_else(|| "unknown ephemeral instance".to_string())?;
        let mut snapshot = state.snapshot(instance_id, generation);
        if let Some(request_id) = request_id {
            if let Some(object) = snapshot.as_object_mut() {
                object.insert("requestId".into(), Value::String(request_id.to_string()));
            }
        }
        drop(states);
        self.host_events.send_owner_event(owner, snapshot);
        Ok(())
    }

    /// Consume one native runtime broadcast event; ephemeral instances get
    /// their render state reduced and the event forwarded owner-scoped.
    pub fn observe_runtime_event(&self, event: &crate::native_pi_manager::NativeRuntimeEvent) {
        let Some(entry) = self.target_of(&event.target.instance_id) else {
            return;
        };
        if entry.target.session_id != event.target.session_id {
            return;
        }
        if event.target.owner_id.is_none() {
            return;
        }
        let sequence = {
            let mut states = match self.states.lock() {
                Ok(states) => states,
                Err(_) => return,
            };
            let state = states
                .entry(event.target.instance_id.clone())
                .or_insert_with(EphemeralRenderState::new);
            state.apply_event(&event.event)
        };
        let generation = event.target.workspace_generation;
        if let Some(owner_ref) = event.target.owner_id.as_deref() {
            let owner = crate::window_owner::OwnerId::from_string(owner_ref.to_string());
            self.host_events.send_owner_event(
                &owner,
                json!({
                    "type": "ephemeral_event",
                    "instanceId": event.target.instance_id,
                    "generation": generation,
                    "runtimeSequence": sequence,
                    "payload": event.event,
                }),
            );
        }
    }

    /// Spawn the pump task that folds native runtime broadcasts into
    /// owner-scoped ephemeral events. One per process.
    pub fn spawn_pump(self: &Arc<Self>, runtimes: &NativePiManager) {
        let receiver = runtimes.subscribe();
        let hub = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut receiver = receiver;
            loop {
                match receiver.recv().await {
                    Ok(event) => hub.observe_runtime_event(&event),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn target_of(&self, instance_id: &str) -> Option<RuntimeTargetEntry> {
        self.targets
            .lock()
            .ok()
            .and_then(|targets| targets.get(instance_id).cloned())
    }

    fn take_target(&self, instance_id: &str) -> Result<RuntimeTargetEntry, String> {
        self.targets
            .lock()
            .map_err(|_| "ephemeral target lock poisoned".to_string())?
            .remove(instance_id)
            .ok_or_else(|| "unknown ephemeral instance".to_string())
    }

    fn descriptor_of(&self, owner: &OwnerId, instance_id: &str) -> Value {
        self.registry
            .descriptors(owner)
            .into_iter()
            .find(|descriptor| descriptor.instance_id == instance_id)
            .map(|descriptor| serde_json::to_value(descriptor).unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
    }

    fn publish_bootstrap(&self, owner: &OwnerId, workspace_generation: u64) {
        let frame = self.bootstrap_value(owner, workspace_generation);
        self.host_events.send_owner_event(owner, frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_user_and_assistant_messages_into_snapshot() {
        let mut state = EphemeralRenderState::new();
        state.apply_event(&json!({
            "type": "message_start",
            "message": { "role": "user", "content": "hello" }
        }));
        state.apply_event(&json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": "" }
        }));
        state.apply_event(&json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "hi " }
        }));
        state.apply_event(&json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "there" }
        }));
        state.apply_event(&json!({ "type": "agent_start" }));
        let watermark = state.apply_event(&json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "end_turn",
                "usage": { "cost": { "total": 0.5 }, "input": 10, "output": 5 }
            }
        }));
        state.apply_event(&json!({ "type": "agent_end" }));
        assert_eq!(watermark, 6);
        let snapshot = state.snapshot("inst-1", 3);
        assert_eq!(snapshot["instanceId"], "inst-1");
        assert_eq!(snapshot["generation"], 3);
        assert_eq!(snapshot["runtimeSequenceWatermark"], 7);
        assert_eq!(snapshot["messages"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["cost"], 0.5);
        assert_eq!(snapshot["totalTokens"], 15);
        assert_eq!(snapshot["isStreaming"], false);
        assert!(snapshot["assistantDraft"].is_null());
    }

    #[test]
    fn streaming_draft_and_tool_state_reduce() {
        let mut state = EphemeralRenderState::new();
        state.apply_event(&json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": "" }
        }));
        state.apply_event(&json!({ "type": "agent_start" }));
        state.apply_event(&json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "thinking", "delta": "hmm" }
        }));
        state.apply_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "t1",
            "toolName": "bash",
            "args": { "cmd": "ls" }
        }));
        state.apply_event(&json!({
            "type": "tool_execution_update",
            "toolCallId": "t1",
            "partialResult": "file.txt"
        }));
        state.apply_event(&json!({
            "type": "tool_execution_end",
            "toolCallId": "t1",
            "isError": false,
            "result": "file.txt\n"
        }));
        let snapshot = state.snapshot("inst-2", 7);
        assert_eq!(snapshot["isStreaming"], true);
        assert_eq!(snapshot["assistantDraft"]["thinking"], "hmm");
        let tools = snapshot["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["status"], "complete");
        assert_eq!(tools[0]["output"], "file.txt\n");
    }

    #[test]
    fn error_and_model_context_fold() {
        let mut state = EphemeralRenderState::new();
        state.apply_event(&json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "error",
                "errorMessage": "provider down"
            }
        }));
        assert_eq!(state.snapshot("i", 1)["error"], "provider down");

        state.apply_response(&json!({
            "type": "response",
            "command": "set_model",
            "success": true,
            "data": {
                "model": { "id": "m1", "provider": "p" },
                "thinkingLevel": "high",
                "thinkingLevels": ["off", "high"]
            }
        }));
        let snapshot = state.snapshot("i", 2);
        assert_eq!(snapshot["model"]["id"], "m1");
        assert_eq!(snapshot["thinkingLevel"], "high");
        assert_eq!(snapshot["thinkingLevels"].as_array().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use crate::host_control::HostEventSink;
    use crate::runtime_coordinator::RuntimeTarget;

    fn hub_with_target(owner: &str, instance_id: &str, generation: u64) -> EphemeralHub {
        let (sender, _receiver) = tokio::sync::broadcast::channel(8);
        std::mem::forget(_receiver);
        let hub = EphemeralHub::new(
            Arc::new(EphemeralRegistry::default()),
            HostEventSink::new(sender),
            std::env::temp_dir(),
        );
        let target = RuntimeTarget::with_owner(
            "workspace-a",
            format!("ephemeral-{instance_id}"),
            instance_id,
            owner,
            generation,
        );
        hub.targets
            .lock()
            .unwrap()
            .insert(instance_id.to_string(), RuntimeTargetEntry { target });
        hub.states
            .lock()
            .unwrap()
            .insert(instance_id.to_string(), EphemeralRenderState::new());
        hub
    }

    #[tokio::test]
    async fn forward_command_rejects_cross_owner_instance() {
        let hub = hub_with_target("owner-a", "inst-1", 2);
        let other = OwnerId::from_string("owner-b".into());
        let error = hub
            .forward_command(
                &NativePiManager::new(8),
                &other,
                "inst-1",
                2,
                json!({ "type": "get_state" }),
                "req-1",
            )
            .await
            .unwrap_err();
        assert!(error.contains("not owned by this client"), "{error}");
    }

    #[tokio::test]
    async fn forward_command_rejects_stale_generation() {
        let hub = hub_with_target("owner-a", "inst-1", 2);
        let owner = OwnerId::from_string("owner-a".into());
        let error = hub
            .forward_command(
                &NativePiManager::new(8),
                &owner,
                "inst-1",
                1,
                json!({ "type": "get_state" }),
                "req-1",
            )
            .await
            .unwrap_err();
        assert!(error.contains("stale ephemeral generation"), "{error}");
    }

    #[tokio::test]
    async fn close_rejects_cross_owner_instance_without_touching_tracking() {
        let hub = hub_with_target("owner-a", "inst-1", 2);
        let other = OwnerId::from_string("owner-b".into());
        let error = hub
            .close(&NativePiManager::new(8), &other, "inst-1", 2, 2)
            .unwrap_err();
        assert!(error.contains("not owned by this client"), "{error}");
        // Tracking must remain intact for the legitimate owner.
        assert!(hub.target_of("inst-1").is_some());
    }

    #[tokio::test]
    async fn snapshot_rejects_unknown_instance() {
        let hub = hub_with_target("owner-a", "inst-1", 2);
        let owner = OwnerId::from_string("owner-a".into());
        let error = hub
            .deliver_snapshot(&owner, "inst-missing", 2, Some("req-9"))
            .unwrap_err();
        assert!(error.contains("unknown ephemeral instance"), "{error}");
    }
}
