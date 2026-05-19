//! Chat and voice-input handlers.
//!
//! `/api/chat` is the load-bearing path that drives the avatar pipeline.
//! Reply text *only* comes back synchronously from the upstream agent's
//! `POST /webhook` — it is NOT broadcast on `/api/events` SSE — so the
//! companion can't substitute the SSE bridge here.
//!
//! `/api/avatar/asr` proxies the voice-input WAV blob to the speech
//! sidecar and returns the transcript verbatim.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;

use crate::characters;
use crate::state::AppState;

/// Wrapper put in front of the active character's persona text before it's
/// sent to the agent. Vanilla zeroclaw/openclaw/hermes have no per-request
/// persona switch (see docs/design/PLAN-PERSONA-CONSOLE.md — deferred), so
/// the companion delivers the character as a prompt prefix; this preamble
/// tells the model that the character outranks whatever identity/SOUL.md
/// the agent itself was built with. Scoped to *identity/voice* only — the
/// agent keeps its tools, safety rules, and workspace instructions.
const PERSONA_OVERRIDE_PREAMBLE: &str = "[Persona override — applies for this whole conversation]\n\
You may already have an identity, persona, or \"soul\" (a SOUL.md, a system prompt, a name like ZeroClaw / Kulukai / \"an AI agent\" / \"an assistant\", …). For THIS conversation, set all of that aside for the purposes of *who you are and how you speak* — the character described below replaces it. Keep everything else (your tools, capabilities, and operating instructions) exactly as they are; only your identity and voice come from the character. Never mention, hint at, or slip back into that earlier identity. If asked who or what you are, you are the character below — nothing else.";

#[derive(serde::Deserialize)]
pub struct ChatRequest {
    pub message: String,
    /// Optional conversation-session id. Forwarded to the agent (as
    /// `X-Session-Id` for the `/webhook` family) so it retains context
    /// across turns. The avatar UI owns this — it stores a UUID in
    /// localStorage and rotates it on "New session". Absent → the
    /// agent runs the turn statelessly.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ChatResponse {
    pub reply: String,
}

/// Forward a user message to the upstream agent, return the reply, AND
/// fan it out to any connected avatar viewer so the avatar speaks.
///
/// We learned the hard way during e2e that zeroclaw v0.7.5's reply text
/// only comes back from `POST /webhook` synchronously — it is NOT
/// broadcast on `/api/events` SSE. So this handler is the load-bearing
/// path for driving the avatar pipeline; the SSE bridge is only useful
/// for observability events (tool calls, agent_start/end timing, …).
pub async fn handle_chat(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    if req.message.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "message must not be empty".into()));
    }
    tracing::info!("companion: /api/chat → agent ({}c)", req.message.len());

    // Echo the user's message on the avatar broadcast channel so all
    // connected windows (main + overlay) record the same user turn in
    // their chat panel. Without this, a message typed in the overlay
    // would never reach the main window's history because only the
    // main window appendTurn user turns (overlay isn't authoritative).
    if let Some(ref avatar) = state.avatar {
        let frame = companion_avatar::AvatarEvent::Frame(
            companion_avatar::AvatarNotification::UserMessage {
                content: req.message.clone(),
            },
        );
        let _ = avatar.event_tx.send(frame);
    }

    // Prepend the active character's persona before sending to the agent.
    // This is the load-bearing way to set a persona without touching the
    // agent's config — we frame each user message with an override preamble
    // + the character text + the actual message. `PERSONA_OVERRIDE_PREAMBLE`
    // tells the model the character outranks its built-in identity/SOUL.md.
    // Failure to load the characters file is non-fatal: send the raw message.
    let outbound = match characters::load(&characters::characters_path(&state.config_path)) {
        Ok(file) => match characters::active(&file) {
            Some(c) => {
                let prefix = characters::compose_persona_prefix(&state.config_path, c);
                if prefix.is_empty() {
                    req.message.clone()
                } else {
                    tracing::info!(
                        "companion: persona prefix for '{}' ({} chars, prompt + notes + on-disk md)",
                        c.name,
                        prefix.len(),
                    );
                    format!(
                        "{preamble}\n\n=== CHARACTER ===\n{prefix}\n=== END CHARACTER ===\n\nStay fully in character as described above. Now reply to:\n\nUser message: {msg}",
                        preamble = PERSONA_OVERRIDE_PREAMBLE,
                        prefix = prefix,
                        msg = req.message,
                    )
                }
            }
            _ => req.message.clone(),
        },
        Err(e) => {
            tracing::warn!("companion: characters load failed (continuing): {e}");
            req.message.clone()
        }
    };

    let started = std::time::Instant::now();
    // Snapshot the current agent client. If the user swaps agents while
    // this request is in flight, we keep using the old one for this
    // response (safe — Arc cloned), and the next request picks up the new.
    let zc = state.zeroclaw.load_full();
    let session_id = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(sid) = session_id {
        tracing::debug!("companion: /api/chat in session {sid}");
    }
    let reply = zc
        .send_chat_in_session(&outbound, session_id)
        .await
        .map_err(|e| {
            let elapsed = started.elapsed().as_secs();
            // Distinguish timeout from generic errors so the UI can
            // render a useful message instead of "502 Bad Gateway".
            // reqwest's timeout error includes "operation timed out" /
            // "deadline has elapsed" depending on platform; check both.
            let msg = e.to_string();
            let is_timeout = msg.contains("timed out") || msg.contains("deadline");
            tracing::error!(
                "companion: agent chat failed after {}s ({}): {e}",
                elapsed,
                if is_timeout { "TIMEOUT" } else { "ERROR" }
            );
            if is_timeout {
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    format!(
                        "agent didn't respond within {}s. The agent may be \
                         running a long tool loop (web search etc.). Bump \
                         [zeroclaw] timeout_secs in companion.toml.",
                        elapsed
                    ),
                )
            } else {
                (StatusCode::BAD_GATEWAY, format!("agent error: {e}"))
            }
        })?;
    tracing::info!(
        "companion: /api/chat ← reply ({}c, {}s)",
        reply.len(),
        started.elapsed().as_secs()
    );

    // Run subagent + TTS ONCE here, then fan rendered frames out to
    // every connected /ws/avatar viewer. Doing the work per-client
    // would multiply subagent token cost and TTS load by the number of
    // connected viewers and make all of them play overlapping audio.
    if let Some(ref avatar) = state.avatar {
        let avatar_clone = Arc::clone(avatar);
        let reply_clone = reply.clone();
        // Spawn so we don't block the /api/chat response on TTS time.
        tokio::spawn(async move {
            if let Err(e) = companion_avatar::process_speak(&avatar_clone, &reply_clone).await {
                tracing::warn!("companion: process_speak failed: {e}");
            }
        });
    }
    Ok(Json(ChatResponse { reply }))
}

// ── Voice input (STT) proxy ────────────────────────────────────────
//
// The frontend's mic-record path posts `{audio, language?, prompt?}` here
// (audio = base64-encoded WAV). We forward to the speech sidecar's
// `/asr` endpoint and surface its response back to the UI verbatim, so
// the same shape is shared with the in-process TTS-verify caller.
//
// Error mapping:
//   - 503 — speech subsystem disabled OR sidecar unreachable. UI can
//           show "voice input unavailable" without losing the audio.
//   - 502 — sidecar returned an error (model load failure etc.).
//   - 400 — bad request body.

#[derive(serde::Deserialize)]
pub struct AvatarAsrRequest {
    audio: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
}

pub async fn handle_avatar_asr(
    State(avatar): State<Arc<companion_avatar::AvatarWsState>>,
    Json(req): Json<AvatarAsrRequest>,
) -> Result<Json<companion_avatar::AsrResponse>, (StatusCode, String)> {
    if req.audio.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty audio".into()));
    }
    let cfg = avatar.config.load();
    if !cfg.speech.enabled {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "speech subsystem disabled in companion.toml ([avatar.speech] enabled = false)".into(),
        ));
    }
    drop(cfg);
    let Some(mgr) = avatar.speech_mgr.load_full() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "speech sidecar manager not initialised (check companion startup logs)".into(),
        ));
    };
    let asr_req = companion_avatar::AsrRequest {
        audio: req.audio,
        language: req.language,
        prompt: req.prompt,
    };
    match mgr.transcribe(&asr_req).await {
        Ok(resp) => {
            tracing::info!(
                "companion: /api/avatar/asr lang={} dur={:.2}s wall={:.0}ms chars={}",
                resp.language,
                resp.duration,
                resp.wall_ms,
                resp.text.chars().count(),
            );
            Ok(Json(resp))
        }
        Err(e) => {
            tracing::warn!("companion: /api/avatar/asr failed: {e}");
            Err((StatusCode::BAD_GATEWAY, e.to_string()))
        }
    }
}
