//! Top-level axum state for the companion server.
//!
//! Kept thin — the avatar pipeline owns its own `Arc<AvatarWsState>` and is
//! mounted via `Router::with_state` directly on the WS route.

use std::path::PathBuf;
use std::sync::Arc;

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
}
