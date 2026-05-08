//! Read-only client for the upstream zeroclaw daemon.
//!
//! The companion talks to zeroclaw exclusively through its public HTTP +
//! SSE surface. Two operations matter:
//!
//! 1. [`ZeroclawClient::send_chat`] — POST `/api/chat` with a user message.
//!    Used when the user types into the avatar UI's chat input.
//! 2. [`ZeroclawClient::events`] — subscribe to `/api/events` SSE. Used by
//!    the avatar pipeline to react to every agent reply that flows through
//!    zeroclaw, regardless of which channel sourced it.
//!
//! No fork-side code changes are needed for either; both endpoints are
//! already shipped by upstream zeroclaw v0.7+.

use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::config::ZeroclawConfig;

/// A typed wrapper for events the companion cares about. Zeroclaw's SSE
/// stream carries many event types; we only surface what's actionable
/// for avatar / pulse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    /// The agent finished a turn. `text` is the assistant's reply.
    AgentReply {
        text: String,
        #[serde(default)]
        session_id: Option<String>,
    },
    /// A streaming token from the agent (when streaming is enabled).
    AgentToken {
        text: String,
        #[serde(default)]
        session_id: Option<String>,
    },
    /// Something else we don't classify. `raw` carries the original JSON
    /// so callers can pattern-match on payload shape if they care.
    Other {
        raw: serde_json::Value,
    },
}

/// Client for the upstream zeroclaw HTTP gateway.
#[derive(Clone)]
pub struct ZeroclawClient {
    base_url: String,
    pair_token: Option<String>,
    http: reqwest::Client,
}

impl ZeroclawClient {
    /// Build from config.
    pub fn new(cfg: &ZeroclawConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_secs))
            .build()?;
        Ok(Self {
            base_url: cfg.url.trim_end_matches('/').to_string(),
            pair_token: cfg.pair_token.clone(),
            http,
        })
    }

    /// Health-check the upstream gateway (`GET /health`).
    pub async fn health(&self) -> anyhow::Result<bool> {
        let url = format!("{}/health", self.base_url);
        let resp = self.http.get(&url).send().await?;
        Ok(resp.status().is_success())
    }

    /// Send a user message to the agent and return the textual reply.
    ///
    /// Uses zeroclaw's `POST /api/chat` endpoint. For streaming, callers
    /// should use [`Self::events`] alongside.
    pub async fn send_chat(&self, message: &str) -> anyhow::Result<String> {
        let url = format!("{}/api/chat", self.base_url);
        let body = serde_json::json!({ "message": message });
        let mut req = self.http.post(&url).json(&body);
        if let Some(ref tok) = self.pair_token {
            req = req.bearer_auth(tok);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            anyhow::bail!("zeroclaw /api/chat returned {status}: {txt}");
        }
        // Zeroclaw's reply shape is `{ "reply": "..." }` or similar.
        // Be liberal in what we accept.
        let payload: serde_json::Value = resp.json().await?;
        if let Some(reply) = payload.get("reply").and_then(|v| v.as_str()) {
            return Ok(reply.to_string());
        }
        if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
            return Ok(text.to_string());
        }
        if let Some(content) = payload.get("content").and_then(|v| v.as_str()) {
            return Ok(content.to_string());
        }
        Ok(payload.to_string())
    }

    /// Subscribe to the upstream SSE event stream and yield typed
    /// [`AgentEvent`]s. Reconnects are the caller's responsibility (wrap
    /// the returned stream in your own loop with backoff).
    pub async fn events(&self) -> anyhow::Result<impl Stream<Item = AgentEvent>> {
        let url = format!("{}/api/events", self.base_url);
        let mut req = self.http.get(&url);
        if let Some(ref tok) = self.pair_token {
            req = req.bearer_auth(tok);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("zeroclaw /api/events returned {}", resp.status());
        }
        let stream = resp
            .bytes_stream()
            .eventsource()
            .filter_map(|ev| async move {
                let ev = match ev {
                    Ok(e) => e,
                    Err(err) => {
                        tracing::debug!("companion: sse decode error: {err}");
                        return None;
                    }
                };
                let raw: serde_json::Value = match serde_json::from_str(&ev.data) {
                    Ok(v) => v,
                    Err(_) => return None,
                };
                Some(classify_event(raw))
            });
        Ok(stream)
    }
}

/// Best-effort classifier for upstream SSE payloads. Zeroclaw's exact
/// event taxonomy isn't fully stable across releases — we look for the
/// shapes the companion needs, fall back to `Other`.
fn classify_event(raw: serde_json::Value) -> AgentEvent {
    // Common shapes we've observed:
    //   {"event":"agent.reply", "text":"...", "session_id":"..."}
    //   {"type":"reply", "content":"..."}
    //   {"role":"assistant", "content":"...", "final":true}
    let event_type = raw
        .get("event")
        .or_else(|| raw.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let session_id = raw
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    let text = raw
        .get("text")
        .or_else(|| raw.get("content"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let is_reply = event_type.contains("reply") || event_type == "agent.reply";
    let is_token = event_type.contains("token") || event_type == "agent.token";
    let is_final = raw.get("final").and_then(|v| v.as_bool()).unwrap_or(false);
    let role_assistant = raw
        .get("role")
        .and_then(|v| v.as_str())
        .map(|s| s == "assistant")
        .unwrap_or(false);

    if let Some(text) = text.clone() {
        if is_reply || (role_assistant && is_final) {
            return AgentEvent::AgentReply { text, session_id };
        }
        if is_token || role_assistant {
            return AgentEvent::AgentToken { text, session_id };
        }
    }
    AgentEvent::Other { raw }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_reply() {
        let raw = serde_json::json!({
            "event": "agent.reply",
            "text": "hello",
            "session_id": "abc",
        });
        match classify_event(raw) {
            AgentEvent::AgentReply { text, session_id } => {
                assert_eq!(text, "hello");
                assert_eq!(session_id.as_deref(), Some("abc"));
            }
            _ => panic!("expected AgentReply"),
        }
    }

    #[test]
    fn classify_token_streaming() {
        let raw = serde_json::json!({
            "event": "agent.token",
            "text": "he",
        });
        match classify_event(raw) {
            AgentEvent::AgentToken { text, .. } => assert_eq!(text, "he"),
            _ => panic!("expected AgentToken"),
        }
    }

    #[test]
    fn classify_unknown_falls_through() {
        let raw = serde_json::json!({"event": "tool.call", "name": "shell"});
        matches!(classify_event(raw), AgentEvent::Other { .. });
    }
}
