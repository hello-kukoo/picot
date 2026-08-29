// ABOUTME: Owns native Pi runtime admission, transport, and bounded lifecycle cleanup.
// ABOUTME: Enforces exact runtime identity across requests, faults, and stop/replacement races.

#![allow(dead_code)]

use crate::mutation_types::is_mutation;
use crate::operation_registry::{OperationRegistry, OperationScope};
#[cfg(test)]
use crate::pi_rpc_bridge::InMemoryPiProcess;
use crate::pi_rpc_bridge::{BridgeFrame, PiRpcBridge, PiRpcProcess, PiRpcProcessObserver};
use crate::runtime_coordinator::{
    MutationAcceptance, RuntimeCoordinator, RuntimeSnapshot, RuntimeState, RuntimeTarget,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

const MAX_RPC_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeRuntimeType {
    Primary,
    Dedicated,
    SideChat,
    QuickChat,
    Standby,
    SuperAgent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadinessPolicy {
    pub probe_required: bool,
    pub timeout: Duration,
}

impl Default for ReadinessPolicy {
    fn default() -> Self {
        Self {
            probe_required: true,
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone)]
pub struct NativeLaunchSpec {
    pub binary: PathBuf,
    pub cwd: PathBuf,
    pub session_path: Option<PathBuf>,
    pub extensions: Vec<PathBuf>,
    pub pi_version: String,
    pub path_env: String,
    pub agent_root: Option<PathBuf>,
    pub static_dir: Option<PathBuf>,
    pub install_secret: Option<String>,
    pub runtime_type: NativeRuntimeType,
    pub no_tools: bool,
    pub readiness: ReadinessPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchDescription {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub safe_environment: BTreeMap<String, String>,
    pub runtime_type: NativeRuntimeType,
    pub readiness: ReadinessPolicy,
}

impl NativeLaunchSpec {
    pub fn command_description(&self) -> LaunchDescription {
        let mut args = Vec::new();
        for extension in &self.extensions {
            args.push("--extension".into());
            args.push(extension.to_string_lossy().into_owned());
        }
        args.extend(["--mode".into(), "rpc".into()]);
        if let Some(session_path) = &self.session_path {
            args.push("--session".into());
            args.push(session_path.to_string_lossy().into_owned());
        } else if matches!(
            self.runtime_type,
            NativeRuntimeType::SideChat | NativeRuntimeType::QuickChat | NativeRuntimeType::Standby
        ) {
            // Sessionless runtime types per the Gate C launch contract: the
            // host never resumes or persists a session for these runtimes.
            args.push("--no-session".into());
        }
        if self.no_tools {
            args.push("--no-tools".into());
        }
        let mut environment: BTreeMap<String, String> = BTreeMap::from([
            ("PATH".into(), self.path_env.clone()),
            ("PI_STUDIO_PI_VERSION".into(), self.pi_version.clone()),
        ]);
        if let Some(agent_root) = &self.agent_root {
            environment.insert(
                "PI_CODING_AGENT_DIR".into(),
                agent_root.to_string_lossy().into_owned(),
            );
        }
        if let Some(static_dir) = &self.static_dir {
            environment.insert(
                "PI_STUDIO_STATIC_DIR".into(),
                static_dir.to_string_lossy().into_owned(),
            );
        }
        if let Some(secret) = &self.install_secret {
            environment.insert("PI_STUDIO_SKILL_INSTALL_SECRET".into(), secret.clone());
        }
        let safe_environment = environment
            .iter()
            .map(|(key, value)| {
                let value = if key == "PI_STUDIO_SKILL_INSTALL_SECRET" {
                    "<redacted>".into()
                } else {
                    value.clone()
                };
                (key.clone(), value)
            })
            .collect();
        LaunchDescription {
            program: self.binary.clone(),
            args,
            environment,
            safe_environment,
            runtime_type: self.runtime_type,
            readiness: self.readiness,
        }
    }
}

struct ManagedRuntime {
    target: Arc<Mutex<RuntimeTarget>>,
    bridge: PiRpcBridge,
    process: Option<PiRpcProcess>,
}

struct NativePiManagerInner {
    coordinator: Mutex<RuntimeCoordinator>,
    /// P1 adapter boundary: native callers currently provide RuntimeTarget only.
    /// Owner/workspace generation must come from Gate R before production admission;
    /// no browser-root or synthetic owner fallback is allowed here.
    operations: Mutex<OperationRegistry>,
    /// Most recent accepted operation per runtime instance. The event pump
    /// uses this to bind turnId-bearing runtime events to the operation that
    /// started the turn: the Pi RPC response never carries a turnId, so the
    /// binding must come from the observed event stream.
    turn_operations: Mutex<HashMap<String, (String, OperationScope)>>,
    runtimes: Mutex<HashMap<String, ManagedRuntime>>,
    events: broadcast::Sender<NativeRuntimeEvent>,
    pending_ui: Mutex<HashMap<String, Vec<NativeRuntimeEvent>>>,
    /// Exact targets currently closing or already stopped. Retaining exact
    /// identity makes repeated stop a no-op without allowing stale stops to
    /// affect a replacement using the same instance id.
    closing: Mutex<HashMap<String, RuntimeTarget>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeEvent {
    pub target: RuntimeTarget,
    pub sequence: u64,
    pub event: Value,
}

#[derive(Clone)]
pub struct NativePiManager {
    inner: Arc<NativePiManagerInner>,
}

fn emit_runtime_crashed(
    inner: &Arc<NativePiManagerInner>,
    expected_target: &RuntimeTarget,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    if inner
        .closing
        .lock()
        .ok()
        .and_then(|closing| closing.get(&expected_target.instance_id).cloned())
        .is_some_and(|closing_target| closing_target == *expected_target)
    {
        return;
    }
    if let Ok(mut turn_operations) = inner.turn_operations.lock() {
        turn_operations.remove(&expected_target.instance_id);
    }
    let Ok(runtimes) = inner.runtimes.lock() else {
        return;
    };
    let Some(managed) = runtimes.get(expected_target.instance_id.as_str()) else {
        return;
    };
    let Ok(current_target) = managed.target.lock() else {
        return;
    };
    if *current_target != *expected_target {
        return;
    }
    let target = current_target.clone();
    drop(current_target);
    drop(runtimes);
    let Ok(mut coordinator) = inner.coordinator.lock() else {
        return;
    };
    let Ok(snapshot) = coordinator.snapshot(&target) else {
        return;
    };
    if snapshot.state == RuntimeState::Crashed || snapshot.state == RuntimeState::Stopped {
        return;
    }
    if coordinator
        .set_state(&target, RuntimeState::Crashed)
        .is_err()
    {
        return;
    }
    if let Ok(mut operations) = inner.operations.lock() {
        operations.instance_replaced(&target.instance_id, "runtime_crashed");
    }
    for event in [
        serde_json::json!({ "type": "runtime_crashed", "reason": reason }),
        serde_json::json!({ "type": "snapshot_required", "reason": "runtime_crashed" }),
    ] {
        let Ok(sequenced) = coordinator.emit_event(&target, event) else {
            return;
        };
        let _ = inner.events.send(NativeRuntimeEvent {
            target: sequenced.target,
            sequence: sequenced.sequence,
            event: sequenced.event,
        });
    }
}

impl NativePiManager {
    pub fn new(idempotency_capacity: usize) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(NativePiManagerInner {
                coordinator: Mutex::new(RuntimeCoordinator::new(idempotency_capacity)),
                operations: Mutex::new(OperationRegistry::new(
                    idempotency_capacity,
                    Duration::from_secs(300),
                )),
                runtimes: Mutex::new(HashMap::new()),
                turn_operations: Mutex::new(HashMap::new()),
                events,
                pending_ui: Mutex::new(HashMap::new()),
                closing: Mutex::new(HashMap::new()),
            }),
        }
    }

    #[cfg(test)]
    fn in_memory(idempotency_capacity: usize) -> Self {
        Self::new(idempotency_capacity)
    }

    pub fn spawn(&self, target: RuntimeTarget, spec: NativeLaunchSpec) -> Result<(), String> {
        let launch = spec.command_description();
        let mut command = Command::new(&launch.program);
        configure_child_process(&mut command);
        command
            .args(&launch.args)
            .envs(&launch.environment)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command
            .spawn()
            .map_err(|error| format!("Cannot start embedded Pi native RPC process: {error}"))?;
        let (bridge, mut process) = PiRpcBridge::attach(child, MAX_RPC_FRAME_BYTES)?;
        let observer = process.observer();
        if let Err(error) = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .register(target.clone(), RuntimeState::Starting)
        {
            let _ = process.kill();
            return Err(format!("Cannot register Pi runtime: {error:?}"));
        }
        self.inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .insert(
                target.instance_id.clone(),
                ManagedRuntime {
                    target: Arc::new(Mutex::new(target.clone())),
                    bridge: bridge.clone(),
                    process: Some(process),
                },
            );
        self.start_event_pump(target, bridge, Some(observer));
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn register_in_memory(
        &self,
        target: RuntimeTarget,
    ) -> Result<InMemoryPiProcess, String> {
        let (bridge, process) = PiRpcBridge::in_memory(1024 * 1024);
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .register(target.clone(), RuntimeState::Ready)
            .map_err(|error| format!("Cannot register test runtime: {error:?}"))?;
        self.inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .insert(
                target.instance_id.clone(),
                ManagedRuntime {
                    target: Arc::new(Mutex::new(target.clone())),
                    bridge: bridge.clone(),
                    process: None,
                },
            );
        self.start_event_pump(target, bridge, None);
        Ok(process)
    }

    fn start_event_pump(
        &self,
        target: RuntimeTarget,
        bridge: PiRpcBridge,
        mut observer: Option<PiRpcProcessObserver>,
    ) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let mut poll = tokio::time::interval(Duration::from_millis(50));
            loop {
                let frame = if observer.is_some() {
                    tokio::select! {
                        frame = bridge.next_frame() => frame,
                        _ = poll.tick() => {
                            if observer.as_mut().and_then(|process| process.try_wait().ok()).flatten().is_some() {
                                emit_runtime_crashed(&inner, &target, "runtime_crashed");
                                return;
                            }
                            continue;
                        }
                    }
                } else {
                    bridge.next_frame().await
                };
                let Some(frame) = frame else {
                    emit_runtime_crashed(&inner, &target, "runtime_crashed");
                    return;
                };
                let current_target = inner.runtimes.lock().ok().and_then(|runtimes| {
                    runtimes
                        .get(&target.instance_id)?
                        .target
                        .lock()
                        .ok()
                        .map(|target| target.clone())
                });
                let Some(current_target) = current_target else {
                    return;
                };
                let event = match frame {
                    BridgeFrame::Event(event) | BridgeFrame::ExtensionUi(event) => event,
                    BridgeFrame::ProtocolError(_) | BridgeFrame::TransportError(_) => {
                        emit_runtime_crashed(&inner, &current_target, "runtime_crashed");
                        return;
                    }
                };
                let sequenced = {
                    let Ok(mut coordinator) = inner.coordinator.lock() else {
                        return;
                    };
                    match event.get("type").and_then(Value::as_str) {
                        Some("agent_start") => {
                            let _ = coordinator.set_state(&current_target, RuntimeState::Working);
                        }
                        Some("agent_settled") | Some("agent_end") => {
                            let _ = coordinator.set_state(&current_target, RuntimeState::Idle);
                        }
                        _ => {}
                    }
                    coordinator.emit_event(&current_target, event)
                };
                let Ok(sequenced) = sequenced else {
                    return;
                };
                let runtime_event = NativeRuntimeEvent {
                    target: sequenced.target,
                    sequence: sequenced.sequence,
                    event: sequenced.event,
                };
                // Pi reports turn identity on runtime_event frames, never on
                // the RPC response. Bind the observed turnId to the most
                // recent accepted operation for this instance so abort_turn
                // can gate on the exact active turn.
                if let Some(turn_id) = runtime_event
                    .event
                    .get("turnId")
                    .and_then(Value::as_str)
                    .filter(|turn_id| !turn_id.is_empty())
                {
                    let binding = inner
                        .turn_operations
                        .lock()
                        .ok()
                        .and_then(|turn_operations| {
                            turn_operations
                                .get(&runtime_event.target.instance_id)
                                .cloned()
                        });
                    if let Some((operation_id, scope)) = binding {
                        if scope.workspace_id == runtime_event.target.workspace_id
                            && scope.session_id == runtime_event.target.session_id
                        {
                            if let Ok(mut registry) = inner.operations.lock() {
                                let _ = registry.bind_turn(&operation_id, turn_id);
                            }
                            if let Ok(mut coordinator) = inner.coordinator.lock() {
                                let _ = coordinator.bind_turn(
                                    &runtime_event.target,
                                    turn_id,
                                    &operation_id,
                                );
                            }
                        }
                    }
                }
                if runtime_event.event.get("type").and_then(Value::as_str)
                    == Some("extension_ui_request")
                {
                    if let Ok(mut pending) = inner.pending_ui.lock() {
                        pending
                            .entry(runtime_event.target.instance_id.clone())
                            .or_default()
                            .push(runtime_event.clone());
                    }
                }
                let _ = inner.events.send(runtime_event);
            }
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NativeRuntimeEvent> {
        self.inner.events.subscribe()
    }

    /// Returns operation state only for exact host-derived logical scope.
    pub fn operation_status(
        &self,
        operation_id: &str,
        scope: &OperationScope,
    ) -> Result<crate::operation_registry::OperationRecord, String> {
        self.inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .get_scoped(operation_id, scope)
            .cloned()
            .map_err(|error| format!("Operation lookup rejected: {error:?}"))
    }

    /// Host restart invalidates unresolved logical operations but retains terminal records.
    pub fn mark_host_restart(&self, reason: impl Into<String>) -> Result<(), String> {
        self.inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .host_restart(reason);
        Ok(())
    }

    /// Instance replacement cannot silently inherit unresolved work.
    pub fn mark_instance_replaced(
        &self,
        instance_id: &str,
        reason: impl Into<String>,
    ) -> Result<(), String> {
        if let Ok(mut turn_operations) = self.inner.turn_operations.lock() {
            turn_operations.remove(instance_id);
        }
        self.inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .instance_replaced(instance_id, reason);
        Ok(())
    }

    pub fn pending_extension_ui(
        &self,
        target: &RuntimeTarget,
    ) -> Result<Vec<NativeRuntimeEvent>, String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("Extension UI lookup rejected: {error:?}"))?;
        Ok(self
            .inner
            .pending_ui
            .lock()
            .map_err(|_| "Pending extension UI lock poisoned".to_string())?
            .get(&target.instance_id)
            .cloned()
            .unwrap_or_default())
    }

    /// Sends a mutation through the logical operation authority.
    ///
    /// Scope is deliberately explicit: until host owner/generation snapshots are
    /// wired, callers cannot use the legacy `request` adapter for operation status.
    pub async fn request_scoped(
        &self,
        target: &RuntimeTarget,
        scope: OperationScope,
        command: Value,
        idempotency_key: &str,
        timeout: Duration,
    ) -> Result<Value, String> {
        if scope.workspace_id != target.workspace_id || scope.session_id != target.session_id {
            return Err("Operation scope does not match runtime target".into());
        }
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Runtime command type is missing".to_string())?;
        if self.is_closing(target)? {
            return Err("Native runtime is stopping".into());
        }
        let (operation_id, acceptance) = self
            .inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .accept(
                scope.clone(),
                idempotency_key,
                command_type,
                target.instance_id.clone(),
            )
            .map_err(|error| format!("Operation rejected: {error:?}"))?;
        match acceptance {
            crate::operation_registry::OperationAcceptance::DuplicateCompleted => {
                return self
                    .operation_status(&operation_id, &scope)
                    .map(|record| record.terminal_response.unwrap_or(Value::Null));
            }
            crate::operation_registry::OperationAcceptance::DuplicatePending => {
                return Err("Operation is still pending".into());
            }
            crate::operation_registry::OperationAcceptance::Accepted => {}
        }
        // Track the latest accepted operation for this instance so the event
        // pump can bind turn events (which arrive while the turn is running)
        // to the operation that started the turn.
        if let Ok(mut turn_operations) = self.inner.turn_operations.lock() {
            turn_operations.insert(
                target.instance_id.clone(),
                (operation_id.clone(), scope.clone()),
            );
        }
        let bridge = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .map(|runtime| runtime.bridge.clone())
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        let response = bridge.request(command, timeout).await.map_err(|error| {
            if let Ok(mut registry) = self.inner.operations.lock() {
                let _ = registry.mark_indeterminate(&operation_id, format!("rpc_{error:?}"));
            }
            format!("Pi RPC request failed: {error:?}")
        })?;
        self.inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .complete(&operation_id, response.clone())
            .map_err(|error| format!("Cannot complete operation: {error:?}"))?;
        Ok(response)
    }

    /// Binds a turn-starting operation to current runtime turn.
    pub fn bind_turn(
        &self,
        target: &RuntimeTarget,
        scope: &OperationScope,
        turn_id: &str,
        operation_id: &str,
    ) -> Result<(), String> {
        if scope.workspace_id != target.workspace_id || scope.session_id != target.session_id {
            return Err("Operation scope does not match runtime target".into());
        }
        let operation_scope_matches = self
            .inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .get_scoped(operation_id, scope)
            .is_ok();
        if !operation_scope_matches {
            return Err("Operation scope does not authorize turn binding".into());
        }
        self.inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .bind_turn(operation_id, turn_id)
            .map_err(|error| format!("Turn operation binding rejected: {error:?}"))?;
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .bind_turn(target, turn_id, operation_id)
            .map_err(|error| format!("Turn binding rejected: {error:?}"))
    }

    /// Aborts only exact current turn. Stale turns return successful no-op.
    /// This path deliberately bypasses both idempotency caches.
    pub async fn abort_turn(
        &self,
        target: &RuntimeTarget,
        scope: &OperationScope,
        turn_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let turn_id = turn_id
            .filter(|turn_id| !turn_id.is_empty())
            .ok_or_else(|| "Invalid runtime command: abort requires turnId".to_string())?;
        if scope.workspace_id != target.workspace_id || scope.session_id != target.session_id {
            return Ok(serde_json::json!({ "disposition": "stale_turn" }));
        }
        let operation_id = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .active_turn_operation(target, turn_id)
            .map_err(|error| format!("Abort target rejected: {error:?}"))?;
        let Some(operation_id) = operation_id else {
            return Ok(serde_json::json!({ "disposition": "stale_turn" }));
        };
        let authorized = self
            .inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .get_scoped(&operation_id, scope)
            .is_ok();
        if !authorized {
            return Ok(serde_json::json!({ "disposition": "stale_turn" }));
        }
        let bridge = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .map(|runtime| runtime.bridge.clone())
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        bridge
            .request(
                serde_json::json!({ "type": "abort", "turnId": turn_id }),
                timeout,
            )
            .await
            .map_err(|error| format!("Pi abort failed: {error:?}"))
    }

    pub async fn request(
        &self,
        target: &RuntimeTarget,
        command: Value,
        idempotency_key: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let mut mutation_key = None;
        {
            let mut coordinator = self
                .inner
                .coordinator
                .lock()
                .map_err(|_| "Runtime coordinator lock poisoned".to_string())?;
            coordinator
                .validate_command(target, &command)
                .map_err(|error| format!("Runtime request rejected: {error:?}"))?;
            if self.is_closing(target)? {
                return Err("Native runtime is stopping".into());
            }
            if is_mutation(
                command
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ) {
                let key = idempotency_key
                    .ok_or_else(|| "Runtime mutation requires an idempotency key".to_string())?;
                // Legacy request API has no owner/workspace generation snapshot.
                // Preserve its coordinator cache; never fabricate OperationScope authority.
                let acceptance = coordinator
                    .accept_mutation(target, key)
                    .map_err(|error| format!("Runtime mutation rejected: {error:?}"))?;
                if acceptance == MutationAcceptance::Duplicate {
                    return coordinator
                        .mutation_result(target, key)
                        .map_err(|error| format!("Cannot read mutation result: {error:?}"))?
                        .ok_or_else(|| {
                            "Runtime mutation was accepted and is still pending".into()
                        });
                }
                mutation_key = Some(key.to_owned());
            }
        }
        let bridge = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .map(|runtime| runtime.bridge.clone())
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        let response = bridge
            .request(command, timeout)
            .await
            .map_err(|error| format!("Pi RPC request failed: {error:?}"))?;
        if let Some(key) = mutation_key {
            self.inner
                .coordinator
                .lock()
                .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
                .complete_mutation(target, &key, response.clone())
                .map_err(|error| format!("Cannot cache mutation result: {error:?}"))?;
        }
        Ok(response)
    }

    /// Stops one exact runtime. Cleanup is deliberately synchronous: process
    /// termination and reap complete before the runtime is unregistered.
    pub fn stop(&self, target: &RuntimeTarget) -> Result<(), String> {
        {
            let coordinator = self
                .inner
                .coordinator
                .lock()
                .map_err(|_| "Runtime coordinator lock poisoned".to_string())?;
            if let Err(error) = coordinator.validate(target) {
                if self
                    .inner
                    .closing
                    .lock()
                    .map_err(|_| "Runtime stop registry lock poisoned".to_string())?
                    .get(&target.instance_id)
                    == Some(target)
                {
                    return Ok(());
                }
                return Err(format!("Runtime stop rejected: {error:?}"));
            }
        }

        // Close admission before touching operations or the child.
        let already_closing = {
            let mut closing = self
                .inner
                .closing
                .lock()
                .map_err(|_| "Runtime stop registry lock poisoned".to_string())?;
            // A valid replacement supersedes a stopped tombstone with same
            // instance key; stale callers still fail coordinator validation.
            if closing
                .get(&target.instance_id)
                .is_some_and(|current| current != target)
            {
                closing.remove(&target.instance_id);
            }
            closing.insert(target.instance_id.clone(), target.clone()) == Some(target.clone())
        };
        if already_closing {
            return Ok(());
        }

        // Preserve operation records, but make unresolved work explicitly
        // indeterminate so no completed response can be replayed as success.
        self.inner
            .operations
            .lock()
            .map_err(|_| "Operation registry lock poisoned".to_string())?
            .instance_replaced(&target.instance_id, "runtime_stopped");

        let mut runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .remove(&target.instance_id)
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;

        let mut cleanup_error = None;
        if let Some(process) = &mut runtime.process {
            if let Err(error) = process.kill() {
                cleanup_error = Some(error);
            }
            if let Err(error) = process.wait() {
                cleanup_error.get_or_insert(error);
            }
        }
        // Pending UI belongs to exact instance and is no longer addressable.
        self.inner
            .pending_ui
            .lock()
            .map_err(|_| "Pending extension UI lock poisoned".to_string())?
            .remove(&target.instance_id);

        let terminal = {
            let mut coordinator = self
                .inner
                .coordinator
                .lock()
                .map_err(|_| "Runtime coordinator lock poisoned".to_string())?;
            coordinator
                .set_state(target, RuntimeState::Stopped)
                .map_err(|error| format!("Cannot stop runtime: {error:?}"))?;
            coordinator
                .emit_event(target, serde_json::json!({ "type": "runtime_stopped" }))
                .map_err(|error| format!("Cannot emit stopped runtime: {error:?}"))?
        };
        let _ = self.inner.events.send(NativeRuntimeEvent {
            target: terminal.target,
            sequence: terminal.sequence,
            event: terminal.event,
        });
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .unregister(target)
            .map_err(|error| format!("Cannot unregister stopped runtime: {error:?}"))?;
        cleanup_error.map_or(Ok(()), Err)
    }

    fn is_closing(&self, target: &RuntimeTarget) -> Result<bool, String> {
        Ok(self
            .inner
            .closing
            .lock()
            .map_err(|_| "Runtime stop registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .is_some_and(|current| current == target))
    }

    pub fn stop_workspace(&self, workspace_id: &str) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter_map(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
                    .filter(|target| target.workspace_id == workspace_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    pub fn stop_all(&self) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter_map(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    pub fn target_for_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Option<RuntimeTarget> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .values()
            .find(|runtime| {
                runtime.target.lock().is_ok_and(|target| {
                    target.workspace_id == workspace_id && target.session_id == session_id
                })
            })
            .and_then(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
    }

    pub fn target_for_session_id(&self, session_id: &str) -> Option<RuntimeTarget> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .values()
            .find(|runtime| {
                runtime
                    .target
                    .lock()
                    .is_ok_and(|target| target.session_id == session_id)
            })
            .and_then(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
    }

    pub fn bind_session_id(
        &self,
        temporary: &RuntimeTarget,
        session_id: &str,
    ) -> Result<RuntimeTarget, String> {
        if !temporary.session_id.starts_with("temporary-") {
            return Ok(temporary.clone());
        }
        let mut coordinator = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?;
        let binding_event = coordinator
            .emit_event(
                temporary,
                serde_json::json!({
                    "type": "session_bound",
                    "sessionId": session_id,
                }),
            )
            .map_err(|error| format!("Cannot sequence session binding: {error:?}"))?;
        let formal = coordinator
            .bind_session_id(temporary, session_id)
            .map_err(|error| format!("Cannot bind formal session: {error:?}"))?;
        drop(coordinator);
        let runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?;
        let managed = runtime
            .get(&temporary.instance_id)
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        *managed
            .target
            .lock()
            .map_err(|_| "Native runtime target lock poisoned".to_string())? = formal.clone();
        drop(runtime);
        let _ = self.inner.events.send(NativeRuntimeEvent {
            target: binding_event.target,
            sequence: binding_event.sequence,
            event: binding_event.event,
        });
        Ok(formal)
    }

    pub fn snapshot(&self, target: &RuntimeTarget) -> Result<RuntimeSnapshot, String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .snapshot(target)
            .map_err(|error| format!("Runtime snapshot rejected: {error:?}"))
    }

    pub async fn respond_extension_ui(
        &self,
        target: &RuntimeTarget,
        response: Value,
    ) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("Extension UI response rejected: {error:?}"))?;
        if response.get("type").and_then(Value::as_str) != Some("extension_ui_response") {
            return Err("Expected extension_ui_response".into());
        }
        let bridge = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .map(|runtime| runtime.bridge.clone())
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        let response_id = response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        bridge
            .send_frame(response)
            .await
            .map_err(|error| format!("Cannot send extension UI response: {error:?}"))?;
        if let Some(response_id) = response_id {
            let mut pending = self
                .inner
                .pending_ui
                .lock()
                .map_err(|_| "Pending extension UI lock poisoned".to_string())?;
            if let Some(events) = pending.get_mut(&target.instance_id) {
                events.retain(|event| {
                    event.event.get("id").and_then(Value::as_str) != Some(response_id.as_str())
                });
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn configure_child_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // Preserve hidden-console behavior for GUI launches.
    command.creation_flags(0x0800_0000);
}

#[cfg(unix)]
fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn configure_child_process(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::{NativeLaunchSpec, NativePiManager, NativeRuntimeType};
    use crate::operation_registry::OperationScope;
    use crate::runtime_coordinator::RuntimeTarget;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::Duration;

    // ── P1.11 real-Pi lifecycle smoke ────────────────────────────────
    // These spawn the real embedded Pi binary through the native manager —
    // no in-memory bridge. Ignored by default so `cargo test` stays fast
    // and hermetic; run them via `scripts/smoke-native-lifecycle.mjs` or
    // `cargo test --ignored native_smoke_ -- --nocapture`.

    async fn native_smoke_lifecycle(
        name: &str,
        runtime_type: NativeRuntimeType,
        session_path: Option<PathBuf>,
        no_tools: bool,
    ) {
        let static_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let cwd = std::env::temp_dir().join(format!("picot-native-smoke-{name}-{nonce}"));
        std::fs::create_dir_all(&cwd).unwrap();
        let mut spec = crate::pi_launch::native_launch_spec_for(
            &static_dir,
            runtime_type,
            &cwd,
            session_path.as_deref(),
        )
        .expect("native launch spec for smoke");
        spec.no_tools = no_tools;

        let manager = NativePiManager::new(32);
        let mut events = manager.subscribe();
        let target = RuntimeTarget::new(
            format!("smoke-{name}-workspace"),
            format!("smoke-{name}-session"),
            format!("smoke-{name}-instance"),
        );
        manager
            .spawn(target.clone(), spec)
            .expect("real Pi spawn must succeed");

        let first = tokio::time::timeout(Duration::from_secs(60), events.recv())
            .await
            .expect("real Pi must emit a runtime event within 60s")
            .expect("event stream must stay open");
        assert_eq!(first.target.instance_id, target.instance_id);

        // A read-only RPC round trip proves the assembled args/environment
        // produce a working Pi, not just a process that started.
        let state = manager
            .request(
                &target,
                json!({ "type": "get_state" }),
                None,
                Duration::from_secs(15),
            )
            .await
            .expect("get_state round trip over the real bridge");
        assert!(state.is_object(), "unexpected get_state response: {state}");

        manager.stop(&target).expect("stop must succeed");
        // stop() is synchronous: Ok means the child was killed and reaped,
        // the coordinator recorded Stopped, and the instance was
        // unregistered. A stopped runtime is no longer addressable.
        assert!(
            manager.snapshot(&target).is_err(),
            "stopped runtime must no longer be addressable"
        );

        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[tokio::test]
    #[ignore = "real-Pi lifecycle smoke; run via scripts/smoke-native-lifecycle.mjs"]
    async fn native_smoke_primary() {
        native_smoke_lifecycle("primary", NativeRuntimeType::Primary, None, false).await;
    }

    #[tokio::test]
    #[ignore = "real-Pi lifecycle smoke; run via scripts/smoke-native-lifecycle.mjs"]
    async fn native_smoke_dedicated() {
        let session = std::env::temp_dir().join(format!(
            "picot-native-smoke-dedicated-{}.jsonl",
            std::process::id()
        ));
        std::fs::write(&session, b"").unwrap();
        native_smoke_lifecycle(
            "dedicated",
            NativeRuntimeType::Dedicated,
            Some(session),
            false,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "real-Pi lifecycle smoke; run via scripts/smoke-native-lifecycle.mjs"]
    async fn native_smoke_side_chat() {
        native_smoke_lifecycle("side_chat", NativeRuntimeType::SideChat, None, false).await;
    }

    #[tokio::test]
    #[ignore = "real-Pi lifecycle smoke; run via scripts/smoke-native-lifecycle.mjs"]
    async fn native_smoke_quick_chat() {
        native_smoke_lifecycle("quick_chat", NativeRuntimeType::QuickChat, None, true).await;
    }

    #[tokio::test]
    #[ignore = "real-Pi lifecycle smoke; run via scripts/smoke-native-lifecycle.mjs"]
    async fn native_smoke_standby() {
        native_smoke_lifecycle("standby", NativeRuntimeType::Standby, None, false).await;
    }

    #[test]
    fn launch_spec_has_no_tcp_port_and_resumes_only_at_process_start() {
        let spec = NativeLaunchSpec {
            binary: PathBuf::from("/embedded/pi"),
            cwd: PathBuf::from("/workspace"),
            session_path: Some(PathBuf::from("/sessions/a.jsonl")),
            extensions: vec![PathBuf::from("/extensions/picot-bridge.mjs")],
            pi_version: "0.80.10".into(),
            path_env: "/usr/bin".into(),
            agent_root: None,
            static_dir: None,
            install_secret: None,
            runtime_type: super::NativeRuntimeType::Primary,
            no_tools: false,
            readiness: super::ReadinessPolicy::default(),
        };
        let launch = spec.command_description();
        assert_eq!(launch.program, PathBuf::from("/embedded/pi"));
        assert!(launch.args.windows(2).any(|pair| pair == ["--mode", "rpc"]));
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair == ["--session", "/sessions/a.jsonl"]));
        assert!(!launch.environment.contains_key("PI_STUDIO_PORT"));
        assert!(!launch
            .args
            .iter()
            .any(|argument| argument.parse::<u16>().is_ok()));
    }

    #[tokio::test]
    async fn eof_crashes_exact_instance_and_marks_pending_operation_indeterminate() {
        let manager = NativePiManager::in_memory(8);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let scope = OperationScope::new("owner-a", "workspace-a", "session-a", 1);
        let mut events = manager.subscribe();
        let mut fake = manager.register_in_memory(target.clone()).unwrap();
        let request = tokio::spawn({
            let manager = manager.clone();
            let target = target.clone();
            let scope = scope.clone();
            async move {
                manager
                    .request_scoped(
                        &target,
                        scope,
                        json!({ "type": "prompt" }),
                        "crash-intent",
                        Duration::from_secs(5),
                    )
                    .await
            }
        });
        fake.read_request().await.unwrap();
        fake.close().await;
        assert_eq!(
            events.recv().await.unwrap().event["type"],
            "runtime_crashed"
        );
        assert_eq!(
            events.recv().await.unwrap().event["type"],
            "snapshot_required"
        );
        assert!(request.await.unwrap().is_err());
        let record = manager
            .operation_status("missing", &scope)
            .expect_err("operation id is intentionally opaque");
        assert!(record.contains("NotFound"));
    }

    #[tokio::test]
    async fn protocol_fatal_emits_single_crash_transition() {
        let manager = NativePiManager::in_memory(8);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let mut events = manager.subscribe();
        let mut fake = manager.register_in_memory(target.clone()).unwrap();
        fake.write_raw("not-json\n".into()).await.unwrap();
        assert_eq!(
            events.recv().await.unwrap().event["type"],
            "runtime_crashed"
        );
        assert_eq!(
            events.recv().await.unwrap().event["type"],
            "snapshot_required"
        );
        let _ = fake.write_raw("also-not-json\n".into()).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn routes_native_requests_by_opaque_target_and_rejects_session_replacement() {
        let manager = NativePiManager::in_memory(8);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let mut events = manager.subscribe();
        let mut fake = manager.register_in_memory(target.clone()).unwrap();

        fake.write_frame(json!({ "type": "agent_start" }))
            .await
            .unwrap();
        let event = events.recv().await.unwrap();
        assert_eq!(event.target, target);
        assert_eq!(event.sequence, 1);
        assert_eq!(event.event["type"], "agent_start");

        let request = tokio::spawn({
            let manager = manager.clone();
            let target = target.clone();
            async move {
                manager
                    .request(
                        &target,
                        json!({ "type": "get_state" }),
                        None,
                        Duration::from_secs(1),
                    )
                    .await
            }
        });
        let outbound = fake.read_request().await.unwrap();
        let id = outbound["id"].as_str().unwrap();
        fake.write_frame(json!({
            "id": id,
            "type": "response",
            "command": "get_state",
            "success": true
        }))
        .await
        .unwrap();
        assert!(request.await.unwrap().unwrap()["success"]
            .as_bool()
            .unwrap());

        let first_prompt = tokio::spawn({
            let manager = manager.clone();
            let target = target.clone();
            async move {
                manager
                    .request(
                        &target,
                        json!({ "type": "prompt", "message": "once" }),
                        Some("prompt-intent"),
                        Duration::from_secs(1),
                    )
                    .await
            }
        });
        let outbound = fake.read_request().await.unwrap();
        let id = outbound["id"].as_str().unwrap();
        fake.write_frame(json!({
            "id": id,
            "type": "response",
            "command": "prompt",
            "success": true
        }))
        .await
        .unwrap();
        let accepted = first_prompt.await.unwrap().unwrap();
        let duplicate = manager
            .request(
                &target,
                json!({ "type": "prompt", "message": "once" }),
                Some("prompt-intent"),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(duplicate, accepted);
        assert!(fake.try_read_request().is_none());

        assert!(manager
            .request(
                &target,
                json!({ "type": "switch_session", "sessionPath": "/other.jsonl" }),
                Some("intent-1"),
                Duration::from_secs(1),
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn abort_turn_forwards_only_current_authorized_turn_and_retries_safely() {
        let manager = NativePiManager::in_memory(8);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let scope = OperationScope::new("owner-a", "workspace-a", "session-a", 1);
        let mut fake = manager.register_in_memory(target.clone()).unwrap();
        let mut events = manager.subscribe();
        fake.write_frame(json!({ "type": "agent_start" }))
            .await
            .unwrap();

        let request = tokio::spawn({
            let manager = manager.clone();
            let target = target.clone();
            let scope = scope.clone();
            async move {
                manager
                    .request_scoped(
                        &target,
                        scope,
                        json!({ "type": "prompt", "message": "turn" }),
                        "intent-turn-a",
                        Duration::from_secs(1),
                    )
                    .await
            }
        });
        let outbound = fake.read_request().await.unwrap();
        let id = outbound["id"].as_str().unwrap();
        // The Pi RPC response never carries a turnId: turn identity arrives on
        // runtime_event frames while the turn is still running. Wait until the
        // pump has processed the turn-bearing event before resolving the RPC.
        fake.write_frame(json!({ "type": "agent_start", "turnId": "turn-a" }))
            .await
            .unwrap();
        while let Ok(event) = events.recv().await {
            if event.event.get("turnId").is_some() {
                break;
            }
        }
        fake.write_frame(json!({
            "id": id,
            "type": "response",
            "command": "prompt",
            "success": true
        }))
        .await
        .unwrap();
        request.await.unwrap().unwrap();

        let abort = tokio::spawn({
            let manager = manager.clone();
            let target = target.clone();
            let scope = scope.clone();
            async move {
                manager
                    .abort_turn(&target, &scope, Some("turn-a"), Duration::from_secs(1))
                    .await
            }
        });
        let outbound = fake.read_request().await.unwrap();
        assert_eq!(outbound["type"], "abort");
        assert_eq!(outbound["turnId"], "turn-a");
        let id = outbound["id"].as_str().unwrap();
        fake.write_frame(json!({ "id": id, "type": "response", "success": true }))
            .await
            .unwrap();
        assert_eq!(abort.await.unwrap().unwrap()["success"], true);

        let stale = manager
            .abort_turn(&target, &scope, Some("turn-old"), Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(stale["disposition"], "stale_turn");
        assert!(fake.try_read_request().is_none());

        let wrong_scope = OperationScope::new("owner-b", "workspace-a", "session-a", 1);
        let stale = manager
            .abort_turn(
                &target,
                &wrong_scope,
                Some("turn-a"),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(stale["disposition"], "stale_turn");
        assert!(fake.try_read_request().is_none());

        let missing = manager
            .abort_turn(&target, &scope, None, Duration::from_secs(1))
            .await;
        assert!(missing.unwrap_err().contains("requires turnId"));
    }

    #[tokio::test]
    async fn stop_is_ordered_idempotent_and_rejects_stale_identity() {
        let manager = NativePiManager::in_memory(8);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let stale = RuntimeTarget::new("workspace-b", "session-b", "instance-a");
        let mut events = manager.subscribe();
        let mut fake = manager.register_in_memory(target.clone()).unwrap();
        fake.write_frame(json!({ "type": "extension_ui_request", "id": "ui-1" }))
            .await
            .unwrap();
        assert_eq!(
            events.recv().await.unwrap().event["type"],
            "extension_ui_request"
        );

        manager.stop(&target).unwrap();
        let stopped = events.recv().await.unwrap();
        assert_eq!(stopped.target, target);
        assert_eq!(stopped.event["type"], "runtime_stopped");
        assert_eq!(stopped.sequence, 2);
        assert!(manager.stop(&target).is_ok());
        assert!(manager.stop(&stale).is_err());
        assert!(manager.pending_extension_ui(&target).is_err());
    }

    #[tokio::test]
    async fn binds_a_temporary_session_once_and_routes_future_events_to_the_formal_target() {
        let manager = NativePiManager::in_memory(8);
        let temporary = RuntimeTarget::new("workspace-a", "temporary-a", "instance-a");
        let mut events = manager.subscribe();
        let mut fake = manager.register_in_memory(temporary.clone()).unwrap();

        let formal = manager.bind_session_id(&temporary, "session-a").unwrap();
        let binding = events.recv().await.unwrap();
        assert_eq!(binding.target, temporary);
        assert_eq!(binding.event["type"], "session_bound");
        assert_eq!(binding.event["sessionId"], "session-a");
        assert_eq!(formal.instance_id, "instance-a");

        fake.write_frame(json!({ "type": "agent_start" }))
            .await
            .unwrap();
        let event = events.recv().await.unwrap();
        assert_eq!(event.target, formal);
        assert_eq!(manager.target_for_session_id("session-a"), Some(formal));
    }
}
