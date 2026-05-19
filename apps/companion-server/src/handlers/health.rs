//! Health endpoints and the background watchdog that keeps them honest.
//!
//! `/health` is a static `200 OK` used by callers that only need to
//! know "is the process up". `/api/status` returns a snapshot of every
//! subsystem (agent / TTS / subagent / avatar / pulse) plus the time
//! since the last probe — that data is populated by [`run_health_watchdog`]
//! on a 10s loop so a request handler never blocks on a network call.

use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::State;

use crate::state::AppState;

pub async fn handle_health() -> &'static str {
    "ok"
}

pub async fn handle_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let h = &state.health;
    let agent_up = h.agent_up.load(Ordering::Relaxed);
    let tts_up = h.tts_up.load(Ordering::Relaxed);
    let subagent_up = h.subagent_up.load(Ordering::Relaxed);
    let agent_err = h.agent_last_error.lock().unwrap().clone();
    let tts_err = h.tts_last_error.lock().unwrap().clone();
    let subagent_err = h.subagent_last_error.lock().unwrap().clone();
    let last_probe_secs = h
        .last_probe
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs());

    Json(serde_json::json!({
        "ok": true,
        // Back-compat key name expected by the existing health banner +
        // Home status dot — same meaning as agent_up.
        "zeroclaw_up": agent_up,
        "agent_up": agent_up,
        "agent_last_error": agent_err,
        "tts_up": tts_up,
        "tts_last_error": tts_err,
        "subagent_up": subagent_up,
        "subagent_last_error": subagent_err,
        "avatar_enabled": state.avatar.is_some(),
        "pulse_enabled": state.pulse.is_some(),
        "last_probe_secs_ago": last_probe_secs,
    }))
}

/// Background loop: probe the agent, TTS, and subagent every ~10 s
/// and stash results in [`crate::state::AppHealth`]. Failures don't
/// propagate — a down service is the expected case at boot before the
/// user has configured one, and the watchdog needs to keep running so
/// the UI can recover automatically when things come back.
pub async fn run_health_watchdog(state: AppState) {
    // First probe quickly so the UI gets accurate dots within ~2 s of
    // boot, then settle into a 10 s cadence. 10 s is short enough to
    // catch a TTS crash before the user notices but long enough that
    // a flaky agent doesn't burn the network.
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    loop {
        // ── Agent ────────────────────────────────────────────────
        let zc = state.zeroclaw.load_full();
        match zc.health().await {
            Ok(true) => state.health.set_agent(true, None),
            Ok(false) => state.health.set_agent(
                false,
                Some(format!("{}/health returned non-2xx", zc.base_url())),
            ),
            Err(e) => state.health.set_agent(false, Some(format!("{e}"))),
        }

        // ── TTS ──────────────────────────────────────────────────
        if let Some(ref av) = state.avatar {
            let tts = av.tts.load_full();
            match tts.health_check().await {
                Ok(true) => state.health.set_tts(true, None),
                Ok(false) => state
                    .health
                    .set_tts(false, Some("TTS /healthz returned non-2xx".to_string())),
                Err(e) => state.health.set_tts(false, Some(format!("{e}"))),
            }
        } else {
            // Avatar subsystem disabled in config — neither up nor a
            // failure. Use a neutral "off" state by clearing errors
            // and reporting up=false (UI shows it as "off in config",
            // not red).
            state.health.set_tts(false, None);
        }

        // ── Subagent ─────────────────────────────────────────────
        if let Some(ref av) = state.avatar {
            // We can't ping the LLM endpoint cheaply (no /health), so
            // "up" here means "a subagent client is configured". A
            // user-visible LLM failure shows up via the analyze() error
            // path which writes to the same field.
            let sub = av.subagent.load_full();
            if sub.is_some() {
                state.health.set_subagent(true, None);
            } else {
                state.health.set_subagent(false, None);
            }
        } else {
            state.health.set_subagent(false, None);
        }

        state.health.mark_swept();
        tick.tick().await;
    }
}
