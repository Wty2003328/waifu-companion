//! Top-level axum state for the companion server.
//!
//! Kept thin — the avatar pipeline owns its own `Arc<AvatarWsState>` and is
//! mounted via `Router::with_state` directly on the WS route.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use arc_swap::ArcSwap;
use companion_avatar::AvatarWsState;
use companion_core::ZeroclawClient;
use companion_pulse::PulseSubsystem;

#[derive(Clone)]
pub struct AppState {
    pub avatar: Option<Arc<AvatarWsState>>,
    pub pulse: Option<Arc<PulseSubsystem>>,
    /// The active agent client, held behind an [`ArcSwap`] so the
    /// settings UI can rebuild it (new URL / kind / token / timeout)
    /// at runtime without a process restart. Read path is lock-free:
    /// `state.zeroclaw.load()` returns a cheap guard that derefs to
    /// the current `Arc<ZeroclawClient>`. The store path
    /// (`state.zeroclaw.store(Arc::new(new_client))`) publishes a new
    /// client; in-flight requests continue to use their own clones
    /// of the previous one, so swaps are safe even mid-call.
    pub zeroclaw: Arc<ArcSwap<ZeroclawClient>>,
    /// Path to the loaded `companion.toml`. Used to resolve where the
    /// runtime override file (`companion.runtime.json`) should be written
    /// when the UI saves subagent / agent settings.
    pub config_path: PathBuf,
    /// Aggregated runtime health for the agent, the TTS server, and
    /// the subagent client. Updated by the health watchdog task (a
    /// background loop in `main`); read by `/api/status`.
    pub health: Arc<AppHealth>,
}

/// Snapshot of the most recent probe of each subsystem. Atomic for the
/// "up/down" bits so the watchdog and request handlers don't fight
/// over a lock; `Mutex<Option<String>>` for the rare error-string
/// writes where allocation matters more than lock-freedom.
pub struct AppHealth {
    pub agent_up: AtomicBool,
    pub agent_last_error: Mutex<Option<String>>,
    pub tts_up: AtomicBool,
    pub tts_last_error: Mutex<Option<String>>,
    pub subagent_up: AtomicBool,
    pub subagent_last_error: Mutex<Option<String>>,
    /// Last time the watchdog completed a sweep. UI shows this to
    /// reassure the user that the dots are fresh.
    pub last_probe: Mutex<Option<SystemTime>>,
}

impl Default for AppHealth {
    fn default() -> Self {
        Self {
            // Start out optimistic — the first watchdog sweep happens
            // a few seconds after boot and corrects this if anything
            // is actually down.
            agent_up: AtomicBool::new(true),
            agent_last_error: Mutex::new(None),
            tts_up: AtomicBool::new(true),
            tts_last_error: Mutex::new(None),
            subagent_up: AtomicBool::new(true),
            subagent_last_error: Mutex::new(None),
            last_probe: Mutex::new(None),
        }
    }
}

impl AppHealth {
    pub fn set_agent(&self, up: bool, err: Option<String>) {
        self.agent_up.store(up, Ordering::Relaxed);
        *self.agent_last_error.lock().unwrap() = err;
    }
    pub fn set_tts(&self, up: bool, err: Option<String>) {
        self.tts_up.store(up, Ordering::Relaxed);
        *self.tts_last_error.lock().unwrap() = err;
    }
    pub fn set_subagent(&self, up: bool, err: Option<String>) {
        self.subagent_up.store(up, Ordering::Relaxed);
        *self.subagent_last_error.lock().unwrap() = err;
    }
    pub fn mark_swept(&self) {
        *self.last_probe.lock().unwrap() = Some(SystemTime::now());
    }
}
