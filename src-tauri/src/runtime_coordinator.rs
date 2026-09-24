#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTarget {
    pub workspace_id: String,
    pub session_id: String,
    pub instance_id: String,
    /// Host-derived owner binding. None is retained only for legacy/unit
    /// fixtures; native production admission requires Some.
    pub owner_id: Option<String>,
    /// Wire targets from the browser echo the bootstrap object; partial
    /// triples (pre-bootstrap pages) still deserialize with generation 0 and
    /// are rejected later by authorize_target, which re-reads the registry.
    #[serde(default)]
    pub workspace_generation: u64,
}

impl RuntimeTarget {
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        instance_id: impl Into<String>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            instance_id: instance_id.into(),
            owner_id: None,
            workspace_generation: 0,
        }
    }

    pub fn with_owner(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        instance_id: impl Into<String>,
        owner_id: impl Into<String>,
        workspace_generation: u64,
    ) -> Self {
        let mut target = Self::new(workspace_id, session_id, instance_id);
        target.owner_id = Some(owner_id.into());
        target.workspace_generation = workspace_generation;
        target
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, allow(dead_code))]
pub enum RuntimeState {
    Starting,
    Trusting,
    Ready,
    Working,
    Idle,
    Suspended,
    Crashed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationAcceptance {
    Accepted,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedEvent {
    pub target: RuntimeTarget,
    pub sequence: u64,
    pub event: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub target: RuntimeTarget,
    pub sequence: u64,
    pub state: RuntimeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinatorError {
    UnknownInstance,
    IdentityMismatch,
    DuplicateSession,
    InvalidState,
    ForbiddenIdentityReplacement,
    InvalidCommand,
    MissingIdempotencyKey,
}

struct RuntimeRecord {
    target: RuntimeTarget,
    state: RuntimeState,
    sequence: u64,
    mutations: VecDeque<MutationRecord>,
    active_turn: Option<ActiveTurn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveTurn {
    turn_id: String,
    operation_id: String,
}

#[allow(dead_code)]
struct MutationRecord {
    key: String,
    result: Option<Value>,
}

pub struct RuntimeCoordinator {
    instances: HashMap<String, RuntimeRecord>,
    idempotency_capacity: usize,
}

impl RuntimeCoordinator {
    pub fn new(idempotency_capacity: usize) -> Self {
        Self {
            instances: HashMap::new(),
            idempotency_capacity: idempotency_capacity.max(1),
        }
    }

    pub fn register(
        &mut self,
        target: RuntimeTarget,
        state: RuntimeState,
    ) -> Result<(), CoordinatorError> {
        if self.instances.values().any(|record| {
            record.target.workspace_id == target.workspace_id
                && record.target.session_id == target.session_id
        }) {
            return Err(CoordinatorError::DuplicateSession);
        }
        if self.instances.contains_key(&target.instance_id) {
            return Err(CoordinatorError::IdentityMismatch);
        }
        self.instances.insert(
            target.instance_id.clone(),
            RuntimeRecord {
                target,
                state,
                sequence: 0,
                mutations: VecDeque::new(),
                active_turn: None,
            },
        );
        Ok(())
    }

    /// Read-only state probe for summaries: `Working` is the event-driven
    /// streaming signal (agent_start sets it, agent_end/agent_settled clear).
    pub fn state_of(&self, target: &RuntimeTarget) -> Option<RuntimeState> {
        self.instances
            .get(&target.instance_id)
            .map(|record| record.state)
    }

    pub fn validate(&self, target: &RuntimeTarget) -> Result<(), CoordinatorError> {
        let record = self
            .instances
            .get(&target.instance_id)
            .ok_or(CoordinatorError::UnknownInstance)?;
        if record.target != *target {
            return Err(CoordinatorError::IdentityMismatch);
        }
        Ok(())
    }

    pub fn validate_command(
        &self,
        target: &RuntimeTarget,
        command: &Value,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .ok_or(CoordinatorError::InvalidCommand)?;
        if matches!(command_type, "new_session" | "switch_session") {
            return Err(CoordinatorError::ForbiddenIdentityReplacement);
        }
        if command_type == "abort"
            && command
                .get("turnId")
                .and_then(serde_json::Value::as_str)
                .filter(|turn_id| !turn_id.is_empty())
                .is_none()
        {
            return Err(CoordinatorError::InvalidCommand);
        }
        Ok(())
    }

    pub fn accept_mutation(
        &mut self,
        target: &RuntimeTarget,
        idempotency_key: &str,
    ) -> Result<MutationAcceptance, CoordinatorError> {
        self.validate(target)?;
        if idempotency_key.is_empty() {
            return Err(CoordinatorError::MissingIdempotencyKey);
        }
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        if record
            .mutations
            .iter()
            .any(|mutation| mutation.key == idempotency_key)
        {
            return Ok(MutationAcceptance::Duplicate);
        }
        record.mutations.push_back(MutationRecord {
            key: idempotency_key.to_owned(),
            result: None,
        });
        while record.mutations.len() > self.idempotency_capacity {
            record.mutations.pop_front();
        }
        Ok(MutationAcceptance::Accepted)
    }

    #[allow(dead_code)]
    pub fn complete_mutation(
        &mut self,
        target: &RuntimeTarget,
        idempotency_key: &str,
        result: Value,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        let mutation = record
            .mutations
            .iter_mut()
            .find(|mutation| mutation.key == idempotency_key)
            .ok_or(CoordinatorError::MissingIdempotencyKey)?;
        mutation.result = Some(result);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn mutation_result(
        &self,
        target: &RuntimeTarget,
        idempotency_key: &str,
    ) -> Result<Option<Value>, CoordinatorError> {
        self.validate(target)?;
        Ok(self
            .instances
            .get(&target.instance_id)
            .unwrap()
            .mutations
            .iter()
            .find(|mutation| mutation.key == idempotency_key)
            .and_then(|mutation| mutation.result.clone()))
    }

    pub fn emit_event(
        &mut self,
        target: &RuntimeTarget,
        event: Value,
    ) -> Result<SequencedEvent, CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        record.sequence += 1;
        Ok(SequencedEvent {
            target: target.clone(),
            sequence: record.sequence,
            event,
        })
    }

    pub fn snapshot(&self, target: &RuntimeTarget) -> Result<RuntimeSnapshot, CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get(&target.instance_id).unwrap();
        Ok(RuntimeSnapshot {
            target: record.target.clone(),
            sequence: record.sequence,
            state: record.state,
        })
    }

    pub fn set_state(
        &mut self,
        target: &RuntimeTarget,
        state: RuntimeState,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        record.state = state;
        if matches!(
            state,
            RuntimeState::Idle | RuntimeState::Crashed | RuntimeState::Stopped
        ) {
            record.active_turn = None;
        }
        Ok(())
    }

    pub fn bind_turn(
        &mut self,
        target: &RuntimeTarget,
        turn_id: impl Into<String>,
        operation_id: impl Into<String>,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let turn_id = turn_id.into();
        if turn_id.is_empty() {
            return Err(CoordinatorError::InvalidCommand);
        }
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        if record.state != RuntimeState::Working {
            return Err(CoordinatorError::InvalidState);
        }
        record.active_turn = Some(ActiveTurn {
            turn_id,
            operation_id: operation_id.into(),
        });
        Ok(())
    }

    pub fn active_turn_operation(
        &self,
        target: &RuntimeTarget,
        turn_id: &str,
    ) -> Result<Option<String>, CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get(&target.instance_id).unwrap();
        if record.state != RuntimeState::Working {
            return Ok(None);
        }
        Ok(record
            .active_turn
            .as_ref()
            .and_then(|turn| (turn.turn_id == turn_id).then(|| turn.operation_id.clone())))
    }

    #[allow(dead_code)]
    pub fn end_turn(
        &mut self,
        target: &RuntimeTarget,
        turn_id: &str,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        if record
            .active_turn
            .as_ref()
            .is_some_and(|turn| turn.turn_id == turn_id)
        {
            record.active_turn = None;
        }
        Ok(())
    }

    pub fn bind_session_id(
        &mut self,
        temporary: &RuntimeTarget,
        session_id: impl Into<String>,
    ) -> Result<RuntimeTarget, CoordinatorError> {
        self.validate(temporary)?;
        let session_id = session_id.into();
        if session_id.is_empty() {
            return Err(CoordinatorError::IdentityMismatch);
        }
        if self.instances.values().any(|record| {
            record.target.instance_id != temporary.instance_id
                && record.target.workspace_id == temporary.workspace_id
                && record.target.session_id == session_id
        }) {
            return Err(CoordinatorError::DuplicateSession);
        }
        let record = self.instances.get_mut(&temporary.instance_id).unwrap();
        record.target.session_id = session_id;
        Ok(record.target.clone())
    }

    /// Re-stamp one registered runtime's workspace generation (workspace
    /// transitions that reuse a live runtime; the commit sweep stops every
    /// runtime with an older generation, so the reused target must move up).
    pub fn rebind_generation(
        &mut self,
        target: &RuntimeTarget,
        generation: u64,
    ) -> Result<RuntimeTarget, CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        record.target.workspace_generation = generation;
        Ok(record.target.clone())
    }

    pub fn unregister(&mut self, target: &RuntimeTarget) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        self.instances.remove(&target.instance_id);
        Ok(())
    }

    pub fn resume(
        &mut self,
        suspended: &RuntimeTarget,
        new_instance_id: impl Into<String>,
    ) -> Result<RuntimeTarget, CoordinatorError> {
        self.validate(suspended)?;
        let record = self.instances.get(&suspended.instance_id).unwrap();
        if record.state != RuntimeState::Suspended {
            return Err(CoordinatorError::InvalidState);
        }
        let new_target = RuntimeTarget::new(
            &suspended.workspace_id,
            &suspended.session_id,
            new_instance_id,
        );
        if self.instances.contains_key(&new_target.instance_id) {
            return Err(CoordinatorError::IdentityMismatch);
        }
        self.instances.remove(&suspended.instance_id);
        self.register(new_target.clone(), RuntimeState::Starting)?;
        Ok(new_target)
    }
}

#[cfg(test)]
mod tests {
    use super::{MutationAcceptance, RuntimeCoordinator, RuntimeState, RuntimeTarget};
    use serde_json::json;

    fn target(instance: &str) -> RuntimeTarget {
        RuntimeTarget::new("workspace-a", "session-a", instance)
    }

    #[test]
    fn wire_target_without_generation_deserializes_to_zero() {
        // Browser frames echo the bootstrap target; a partial pre-bootstrap
        // triple must deserialize instead of failing with a misleading
        // "Runtime target is invalid". Admission still rejects it later.
        let parsed: RuntimeTarget = serde_json::from_value(json!({
            "workspaceId": "workspace-a",
            "sessionId": "session-a",
            "instanceId": "instance-a"
        }))
        .unwrap();
        assert_eq!(parsed.workspace_generation, 0);
        assert!(parsed.owner_id.is_none());
    }

    #[test]
    fn validates_all_target_identities_and_rejects_session_replacement() {
        let mut coordinator = RuntimeCoordinator::new(8);
        coordinator
            .register(target("instance-a"), RuntimeState::Ready)
            .unwrap();

        assert!(coordinator.validate(&target("instance-a")).is_ok());
        assert!(coordinator
            .validate(&RuntimeTarget::new(
                "workspace-b",
                "session-a",
                "instance-a"
            ))
            .is_err());
        assert!(coordinator
            .validate(&RuntimeTarget::new(
                "workspace-a",
                "session-b",
                "instance-a"
            ))
            .is_err());
        assert!(coordinator.validate(&target("stale-instance")).is_err());
        assert!(coordinator
            .validate_command(&target("instance-a"), &json!({ "type": "new_session" }))
            .is_err());
        assert!(coordinator
            .validate_command(
                &target("instance-a"),
                &json!({ "type": "switch_session", "sessionPath": "/tmp/session.jsonl" }),
            )
            .is_err());
    }

    #[test]
    fn deduplicates_mutations_and_sequences_events_per_instance() {
        let mut coordinator = RuntimeCoordinator::new(2);
        coordinator
            .register(target("instance-a"), RuntimeState::Ready)
            .unwrap();

        assert_eq!(
            coordinator
                .accept_mutation(&target("instance-a"), "intent-1")
                .unwrap(),
            MutationAcceptance::Accepted
        );
        assert_eq!(
            coordinator
                .accept_mutation(&target("instance-a"), "intent-1")
                .unwrap(),
            MutationAcceptance::Duplicate
        );
        coordinator
            .accept_mutation(&target("instance-a"), "intent-2")
            .unwrap();
        coordinator
            .accept_mutation(&target("instance-a"), "intent-3")
            .unwrap();
        assert_eq!(
            coordinator
                .accept_mutation(&target("instance-a"), "intent-1")
                .unwrap(),
            MutationAcceptance::Accepted,
            "bounded cache evicts the least-recent accepted key"
        );

        let first = coordinator
            .emit_event(&target("instance-a"), json!({ "type": "agent_start" }))
            .unwrap();
        let second = coordinator
            .emit_event(&target("instance-a"), json!({ "type": "agent_end" }))
            .unwrap();
        assert_eq!((first.sequence, second.sequence), (1, 2));
        assert_eq!(
            coordinator
                .snapshot(&target("instance-a"))
                .unwrap()
                .sequence,
            2
        );
    }

    #[test]
    fn resume_preserves_session_but_replaces_instance() {
        let mut coordinator = RuntimeCoordinator::new(8);
        coordinator
            .register(target("instance-a"), RuntimeState::Suspended)
            .unwrap();
        let resumed = coordinator
            .resume(&target("instance-a"), "instance-b")
            .unwrap();

        assert_eq!(resumed.workspace_id, "workspace-a");
        assert_eq!(resumed.session_id, "session-a");
        assert_eq!(resumed.instance_id, "instance-b");
        assert!(coordinator.validate(&target("instance-a")).is_err());
        assert_eq!(
            coordinator.snapshot(&resumed).unwrap().state,
            RuntimeState::Starting
        );
    }

    #[test]
    fn turn_binding_is_current_only_and_clears_on_idle() {
        let mut coordinator = RuntimeCoordinator::new(8);
        let active = target("instance-a");
        coordinator
            .register(active.clone(), RuntimeState::Working)
            .unwrap();
        coordinator.bind_turn(&active, "turn-a", "op-a").unwrap();
        assert_eq!(
            coordinator
                .active_turn_operation(&active, "turn-a")
                .unwrap(),
            Some("op-a".into())
        );
        assert_eq!(
            coordinator
                .active_turn_operation(&active, "turn-old")
                .unwrap(),
            None
        );
        coordinator.set_state(&active, RuntimeState::Idle).unwrap();
        assert_eq!(
            coordinator
                .active_turn_operation(&active, "turn-a")
                .unwrap(),
            None
        );
        coordinator
            .set_state(&active, RuntimeState::Working)
            .unwrap();
        coordinator.bind_turn(&active, "turn-b", "op-b").unwrap();
        assert_eq!(
            coordinator
                .active_turn_operation(&active, "turn-a")
                .unwrap(),
            None
        );
        assert_eq!(
            coordinator
                .active_turn_operation(&active, "turn-b")
                .unwrap(),
            Some("op-b".into())
        );
    }

    #[test]
    fn abort_command_requires_turn_id() {
        let mut coordinator = RuntimeCoordinator::new(8);
        let active = target("instance-a");
        coordinator
            .register(active.clone(), RuntimeState::Working)
            .unwrap();
        assert_eq!(
            coordinator.validate_command(&active, &json!({ "type": "abort" })),
            Err(super::CoordinatorError::InvalidCommand)
        );
        assert!(coordinator
            .validate_command(&active, &json!({ "type": "abort", "turnId": "turn-a" }))
            .is_ok());
    }

    #[test]
    fn binds_a_formal_session_without_replacing_the_instance() {
        let temporary = RuntimeTarget::new("workspace-a", "temporary-a", "instance-a");
        let mut coordinator = RuntimeCoordinator::new(8);
        coordinator
            .register(temporary.clone(), RuntimeState::Ready)
            .unwrap();

        let formal = coordinator
            .bind_session_id(&temporary, "session-formal")
            .unwrap();

        assert_eq!(formal.instance_id, temporary.instance_id);
        assert_eq!(formal.session_id, "session-formal");
        assert!(coordinator.validate(&temporary).is_err());
        assert!(coordinator.validate(&formal).is_ok());
    }
}
