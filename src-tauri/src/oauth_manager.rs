// ABOUTME: Host-side OAuth operation lifecycle and generation authority.
// ABOUTME: Pi remains credential owner; host stores only redacted operation state.

use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthClient {
    Desktop,
    Remote,
    Ephemeral,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthError {
    DesktopOwnerRequired,
    StaleGeneration,
    OperationNotFound,
}
impl OAuthError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DesktopOwnerRequired => "desktop_owner_required",
            Self::StaleGeneration => "stale_generation",
            Self::OperationNotFound => "oauth_operation_not_found",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthStatus {
    Pending,
    Succeeded,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthOperation {
    pub id: String,
    pub owner_id: String,
    pub generation: u64,
    pub status: OAuthStatus,
    pub expires_at: Instant,
}

#[derive(Debug, Default)]
pub struct OAuthManager {
    generation: u64,
    operations: HashMap<String, OAuthOperation>,
}

impl OAuthManager {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn runtime_started(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.revoke_prior();
        self.generation
    }
    pub fn runtime_stopped(&mut self) {
        self.revoke_prior();
    }
    pub fn start(
        &mut self,
        client: OAuthClient,
        owner_id: &str,
        id: impl Into<String>,
        ttl: Duration,
    ) -> Result<OAuthOperation, OAuthError> {
        if client != OAuthClient::Desktop {
            return Err(OAuthError::DesktopOwnerRequired);
        }
        let operation = OAuthOperation {
            id: id.into(),
            owner_id: owner_id.into(),
            generation: self.generation,
            status: OAuthStatus::Pending,
            expires_at: Instant::now() + ttl,
        };
        self.operations
            .insert(operation.id.clone(), operation.clone());
        Ok(operation)
    }
    pub fn status(
        &mut self,
        owner_id: &str,
        generation: u64,
        id: &str,
    ) -> Result<OAuthStatus, OAuthError> {
        let operation = self
            .operations
            .get(id)
            .ok_or(OAuthError::OperationNotFound)?;
        if operation.owner_id != owner_id
            || operation.generation != generation
            || generation != self.generation
        {
            return Err(OAuthError::StaleGeneration);
        }
        if Instant::now() >= operation.expires_at {
            self.operations.remove(id);
            return Ok(OAuthStatus::Failed);
        }
        Ok(operation.status.clone())
    }
    pub fn cancel(&mut self, owner_id: &str, generation: u64, id: &str) -> Result<(), OAuthError> {
        let operation = self
            .operations
            .get_mut(id)
            .ok_or(OAuthError::OperationNotFound)?;
        if operation.owner_id != owner_id
            || operation.generation != generation
            || generation != self.generation
        {
            return Err(OAuthError::StaleGeneration);
        }
        operation.status = OAuthStatus::Cancelled;
        Ok(())
    }
    fn revoke_prior(&mut self) {
        self.operations
            .retain(|_, operation| operation.generation == self.generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binds_operation_to_owner_and_generation() {
        let mut manager = OAuthManager::default();
        let generation = manager.runtime_started();
        let operation = manager
            .start(
                OAuthClient::Desktop,
                "owner-a",
                "op",
                Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(
            manager
                .status("owner-a", generation, &operation.id)
                .unwrap(),
            OAuthStatus::Pending
        );
        assert_eq!(
            manager.status("owner-b", generation, "op"),
            Err(OAuthError::StaleGeneration)
        );
        manager.runtime_started();
        assert_eq!(
            manager.status("owner-a", generation, "op"),
            Err(OAuthError::OperationNotFound)
        );
    }
    #[test]
    fn denies_remote_and_ephemeral_without_creating_state() {
        let mut manager = OAuthManager::default();
        assert_eq!(
            manager.start(OAuthClient::Remote, "owner", "r", Duration::ZERO),
            Err(OAuthError::DesktopOwnerRequired)
        );
        assert_eq!(
            manager.start(OAuthClient::Ephemeral, "owner", "e", Duration::ZERO),
            Err(OAuthError::DesktopOwnerRequired)
        );
        assert_eq!(manager.operations.len(), 0);
    }
}
