//! Background bridges that run alongside the HTTP server.
//!
//! Currently just the SSE observer that subscribes to the upstream
//! agent's `/api/events`. We deliberately do NOT use this stream to
//! drive the avatar pipeline — the load-bearing path is `POST /api/chat`
//! → `process_speak`. See the doc comment on [`run_sse_bridge`].

use futures_util::StreamExt;
use tokio::sync::broadcast;

use companion_avatar::AvatarEvent;
use companion_core::{AgentEvent, ZeroclawClient};

/// Subscribe to zeroclaw's SSE event stream for OBSERVABILITY only.
///
/// We deliberately do NOT use SSE to drive the avatar pipeline:
/// (1) zeroclaw v0.7.5's /api/events doesn't broadcast the reply text
///     anyway (only agent_start / llm_request / agent_end metadata),
///     so any avatar-Speak we emitted here would have empty text, and
/// (2) the load-bearing path is /api/chat → process_speak, which runs
///     subagent + TTS exactly once per turn. Re-emitting via SSE would
///     risk doubling that work and producing two simultaneous replies.
///
/// Reconnects on failure with exponential backoff capped at 30s.
pub async fn run_sse_bridge(zc: ZeroclawClient, _avatar_tx: broadcast::Sender<AvatarEvent>) {
    let mut backoff = 1u64;
    loop {
        match zc.events().await {
            Ok(stream) => {
                tracing::info!("companion: SSE bridge connected (observability only)");
                backoff = 1;
                tokio::pin!(stream);
                while let Some(ev) = stream.next().await {
                    // Log unusual events at debug; AgentReply (if a future
                    // zeroclaw ever emits one) is logged but NOT forwarded.
                    match ev {
                        AgentEvent::AgentReply { ref text, .. } => {
                            tracing::debug!(
                                "companion sse: agent.reply ({} chars) — ignored, /api/chat is the speak path",
                                text.len()
                            );
                        }
                        AgentEvent::AgentToken { .. } => {}
                        AgentEvent::Other { ref raw } => {
                            tracing::debug!("companion sse: {}", raw);
                        }
                    }
                }
                tracing::warn!("companion: SSE stream ended; reconnecting");
            }
            Err(e) => {
                tracing::warn!("companion: SSE bridge connect failed: {e}; backoff={backoff}s");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}
