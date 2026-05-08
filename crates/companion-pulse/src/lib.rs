//! Pulse dashboard subsystem for the zeroclaw companion.
//!
//! **Status: stub.** Full migration of the fork's `src/pulse/` (collectors,
//! scheduler, storage, models, API) is tracked in `docs/PULSE-MIGRATION.md`
//! and lands in a follow-up session. This file exists so the workspace
//! resolves and downstream consumers can wire the eventual subsystem in
//! without churn.

use serde::{Deserialize, Serialize};

/// Placeholder Pulse subsystem.
#[derive(Debug, Default)]
pub struct PulseSubsystem {
    enabled: bool,
}

impl PulseSubsystem {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }
}

/// Placeholder Pulse config; the real shape lands when collectors/storage
/// are ported.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PulseConfig {
    #[serde(default)]
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_disabled_by_default() {
        let p = PulseSubsystem::default();
        assert!(!p.is_enabled());
    }
}
