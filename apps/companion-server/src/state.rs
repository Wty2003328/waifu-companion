//! Top-level axum state for the companion server.
//!
//! Kept thin — the avatar pipeline owns its own `Arc<AvatarWsState>` and is
//! mounted via `Router::with_state` directly on the WS route.

use std::sync::Arc;

use companion_avatar::AvatarWsState;
use companion_core::ZeroclawClient;

#[derive(Clone)]
pub struct AppState {
    pub avatar: Option<Arc<AvatarWsState>>,
    pub zeroclaw: Arc<ZeroclawClient>,
}
