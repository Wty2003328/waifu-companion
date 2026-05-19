//! Configuration endpoints: read the redacted live config, list
//! installed Live2D models, and accept the three persisted-and-hot-swap
//! override routes (subagent / avatar / agent connection).
//!
//! The three POST handlers all follow the same protocol:
//!   1. Merge the request fields into `companion.runtime.json` (sibling
//!      of `companion.toml`) — the on-disk source of truth.
//!   2. Re-parse `companion.toml + runtime.json` into a fresh
//!      `CompanionConfig` (same code path as startup; no parallel
//!      "apply override on top of cached base" to drift out of sync).
//!   3. Rebuild the affected subsystem and atomically publish via the
//!      ArcSwap on `AppState` / `AvatarWsState`.
//!   4. Background-spawn anything expensive (TTS / NMT process restarts)
//!      so the HTTP response returns immediately.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;

use companion_avatar::{AnimeTtsManager, AvatarConfig, AvatarSubagent, TranslatorBackendKind};
use companion_core::{
    AgentKind, CompanionConfig, RuntimeOverride, ZeroclawClient, runtime_override_path,
};

use crate::state::AppState;

// ── GET /api/config ──────────────────────────────────────────────

/// Read-only snapshot of the loaded companion configuration so the
/// Settings page can render what's actually running. Sensitive fields
/// (api keys) are redacted.
///
/// Avatar values are re-read from `companion.toml` + the runtime
/// override file on every call so that values flipped via the hot-
/// swap save handlers show up immediately. (The AvatarWsState's
/// captured `config` is only used for the in-process behavior that
/// is genuinely fixed at startup — anything we hot-swap also lives
/// in the runtime override, so disk is the truth for display.)
pub async fn handle_get_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    // Fresh disk read — cheap, runs on the axum executor.
    let disk_cfg = CompanionConfig::load(&state.config_path).ok();
    let avatar = state.avatar.as_ref().map(|_| {
        // Prefer the live avatar config from disk; fall back to the
        // startup snapshot if the on-disk parse failed.
        let cfg: AvatarConfig = disk_cfg
            .as_ref()
            .and_then(|d| serde_json::from_value(d.avatar.clone()).ok())
            .unwrap_or_else(|| (*state.avatar.as_ref().unwrap().config.load_full()).clone());
        serde_json::json!({
            "enabled": cfg.enabled,
            "chat_language": cfg.chat_language,
            "tts": {
                "api_url": cfg.tts.api_url,
                "voice": cfg.tts.voice,
                "language": cfg.tts.language,
                "speed": cfg.tts.speed,
                "quality": cfg.tts.quality,
                "streaming": cfg.tts.streaming,
                "launcher_command": cfg.tts.launcher_command,
            },
            "subagent": {
                "enabled": cfg.subagent.enabled,
                "only_when_translating": cfg.subagent.only_when_translating,
                "use_zeroclaw_webhook": cfg.subagent.use_zeroclaw_webhook,
                "streaming": cfg.subagent.streaming,
                "llm_model": cfg.subagent.llm.model,
                "llm_base_url": cfg.subagent.llm.base_url,
                "llm_disable_thinking": cfg.subagent.llm.disable_thinking,
                "timeout_secs": cfg.subagent.timeout_secs,
                // api_key intentionally redacted
                "llm_api_key_set": cfg.subagent.llm.api_key.is_some()
                    || cfg.subagent.llm.api_key_env.is_some(),
                "translator": {
                    "backend": match cfg.subagent.translator.backend {
                        TranslatorBackendKind::Llm => "llm",
                        TranslatorBackendKind::Http => "http",
                    },
                    "url": cfg.subagent.translator.url,
                    "http_timeout_secs": cfg.subagent.translator.http_timeout_secs,
                    "nmt_quality_preset": cfg.subagent.translator.nmt_quality_preset,
                    "nmt_model_id": cfg.subagent.translator.nmt_model_id,
                    "nmt_num_beams": cfg.subagent.translator.nmt_num_beams,
                    "nmt_device": cfg.subagent.translator.nmt_device,
                    "nmt_precision": cfg.subagent.translator.nmt_precision,
                    "nmt_src_lang": cfg.subagent.translator.nmt_src_lang,
                    "nmt_tgt_lang": cfg.subagent.translator.nmt_tgt_lang,
                    "nmt_launch_command": cfg.subagent.translator.nmt_launch_command,
                    "nmt_auto_start": cfg.subagent.translator.nmt_auto_start,
                    "nmt_close_with_companion": cfg.subagent.translator.nmt_close_with_companion,
                    "nmt_port": cfg.subagent.translator.nmt_port,
                },
            },
            "model": {
                "model_dir": cfg.model.model_dir,
                "default_expression": cfg.model.default_expression,
                "scale": cfg.model.scale,
                "anchor": cfg.model.anchor,
            },
        })
    });
    let zc = state.zeroclaw.load_full();
    let zc_up = zc.health().await.unwrap_or(false);
    Json(serde_json::json!({
        "avatar": avatar,
        // Connection to the (possibly remote) agent daemon. The
        // pairing token is never sent back — only whether one is set.
        // `kind` is one of "zeroclaw" | "openclaw" | "hermes" | "custom".
        "zeroclaw": {
            "kind": zc.kind().label(),
            "url": zc.base_url(),
            "timeout_secs": zc.timeout_secs(),
            "pair_token_set": zc.has_pair_token(),
            "reachable": zc_up,
        },
        // Legacy field some older UI builds read; keep for one release.
        "zeroclaw_url": if zc_up { Some("ok") } else { None },
    }))
}

// ── GET /api/models ──────────────────────────────────────────────

/// List Live2D models installed under `<web_dist_dir>/live2d/models/`.
/// Each subdirectory is a model; we look for an entry-point JSON
/// (Cubism 4 `*.model3.json` first, then Cubism 2 `*.model.json` or
/// `model*.json`) to construct the URL the frontend can load.
pub async fn handle_list_models(_state: State<AppState>) -> Json<serde_json::Value> {
    // Look in the same directory the static-file server uses. When
    // launched from the workspace root via the wrapper, that's
    // `./web/dist/live2d/models/`. We don't store the resolved path
    // in AppState yet, so we re-derive it from cwd here — safe because
    // companion-server (sidecar or standalone) is always launched
    // from a known-cwd ancestor.
    let dist = std::env::current_dir()
        .map(|cwd| cwd.join("web").join("dist"))
        .unwrap_or_default();
    let models_dir = dist.join("live2d").join("models");

    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&models_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let dir_name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if dir_name.is_empty() {
                continue;
            }
            // Prefer Cubism 4 entry, then Cubism 2 conventions.
            let mut entry_file: Option<String> = None;
            let mut format = "cubism2";
            if let Ok(files) = std::fs::read_dir(&p) {
                let mut all: Vec<String> = files
                    .flatten()
                    .filter_map(|f| f.file_name().to_str().map(|s| s.to_string()))
                    .collect();
                all.sort();
                if let Some(f) = all.iter().find(|s| s.ends_with(".model3.json")) {
                    entry_file = Some(f.clone());
                    format = "cubism4";
                } else if let Some(f) = all
                    .iter()
                    .find(|s| s.ends_with(".model.json") || s.starts_with("model"))
                {
                    entry_file = Some(f.clone());
                }
            }
            if let Some(f) = entry_file {
                let url = format!("/live2d/models/{dir_name}/{f}");
                out.push(serde_json::json!({
                    "id": dir_name,
                    "name": dir_name,
                    "modelUrl": url,
                    "format": format,
                }));
            }
        }
    }
    Json(serde_json::json!({ "models": out }))
}

// ── POST /api/config/subagent ────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SubagentOverrideRequest {
    /// `true` → route through zeroclaw's webhook (slow, no key needed).
    /// `false` → direct LLM call (fast, needs api_key).
    use_zeroclaw_webhook: Option<bool>,
    /// Direct-LLM API key. If empty string, treated as "clear the override".
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    timeout_secs: Option<u64>,
    /// `true` (default) → send `thinking:{type:disabled}` so GLM-family
    /// models skip chain-of-thought; `false` → let the model reason.
    disable_thinking: Option<bool>,
    // ----- Translator (NMT sidecar) -----
    /// "llm" or "http". Picks the subagent translation backend.
    translator_backend: Option<String>,
    /// NMT sidecar base URL when backend = "http".
    translator_url: Option<String>,
    translator_http_timeout_secs: Option<u64>,
    /// "fast" | "balanced" | "quality" | "custom".
    translator_nmt_quality_preset: Option<String>,
    /// HF model id override. Empty string → clear override and use the preset.
    translator_nmt_model_id: Option<String>,
    translator_nmt_num_beams: Option<u32>,
    /// "cpu" | "cuda" | "cuda:N".
    translator_nmt_device: Option<String>,
    /// "auto" | "fp32" | "fp16" | "bf16".
    translator_nmt_precision: Option<String>,
    translator_nmt_src_lang: Option<String>,
    translator_nmt_tgt_lang: Option<String>,
    translator_nmt_launch_command: Option<String>,
    translator_nmt_auto_start: Option<bool>,
    translator_nmt_close_with_companion: Option<bool>,
    translator_nmt_port: Option<u16>,
}

/// Persist the user's subagent settings choice to
/// `companion.runtime.json` (sibling of companion.toml) **and**
/// hot-swap the live `AvatarSubagent` so the change takes effect
/// immediately — no restart needed.
///
/// The avatar WsState now holds the subagent inside an
/// [`arc_swap::ArcSwapOption`]; rebuilding it from the freshly-merged
/// config + `store`ing publishes the new client atomically. In-flight
/// turns keep using whichever client they `load_full`ed when the turn
/// began.
pub async fn handle_post_subagent_override(
    State(state): State<AppState>,
    Json(req): Json<SubagentOverrideRequest>,
) -> axum::response::Result<StatusCode, (StatusCode, String)> {
    let path = runtime_override_path(&state.config_path);

    // Load the existing override (if any) so we don't trample unrelated keys.
    let mut over = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|b| serde_json::from_str::<RuntimeOverride>(&b).ok())
            .unwrap_or_default()
    } else {
        RuntimeOverride::default()
    };

    let mut sub = over.subagent.unwrap_or_default();

    if let Some(v) = req.use_zeroclaw_webhook {
        sub.use_zeroclaw_webhook = Some(v);
    }
    if let Some(v) = req.api_key {
        // Empty string → treat as "clear the override".
        sub.api_key = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.model {
        sub.model = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.base_url {
        sub.base_url = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.disable_thinking {
        sub.disable_thinking = Some(v);
    }
    if let Some(v) = req.timeout_secs {
        sub.timeout_secs = Some(v);
    }

    // Translator overrides — only mutate sub.translator if the request
    // actually touched a translator_* field. Empty strings clear the
    // individual override (re-falling-through to companion.toml).
    let any_translator_field = req.translator_backend.is_some()
        || req.translator_url.is_some()
        || req.translator_http_timeout_secs.is_some()
        || req.translator_nmt_quality_preset.is_some()
        || req.translator_nmt_model_id.is_some()
        || req.translator_nmt_num_beams.is_some()
        || req.translator_nmt_device.is_some()
        || req.translator_nmt_precision.is_some()
        || req.translator_nmt_src_lang.is_some()
        || req.translator_nmt_tgt_lang.is_some()
        || req.translator_nmt_launch_command.is_some()
        || req.translator_nmt_auto_start.is_some()
        || req.translator_nmt_close_with_companion.is_some()
        || req.translator_nmt_port.is_some();
    if any_translator_field {
        let mut tr = sub.translator.take().unwrap_or_default();
        macro_rules! set_str {
            ($field:ident, $value:expr) => {
                if let Some(v) = $value {
                    tr.$field = if v.is_empty() { None } else { Some(v) };
                }
            };
        }
        macro_rules! set_val {
            ($field:ident, $value:expr) => {
                if let Some(v) = $value {
                    tr.$field = Some(v);
                }
            };
        }
        set_str!(backend, req.translator_backend);
        set_str!(url, req.translator_url);
        set_val!(http_timeout_secs, req.translator_http_timeout_secs);
        set_str!(nmt_quality_preset, req.translator_nmt_quality_preset);
        set_str!(nmt_model_id, req.translator_nmt_model_id);
        set_val!(nmt_num_beams, req.translator_nmt_num_beams);
        set_str!(nmt_device, req.translator_nmt_device);
        set_str!(nmt_precision, req.translator_nmt_precision);
        set_str!(nmt_src_lang, req.translator_nmt_src_lang);
        set_str!(nmt_tgt_lang, req.translator_nmt_tgt_lang);
        set_str!(nmt_launch_command, req.translator_nmt_launch_command);
        set_val!(nmt_auto_start, req.translator_nmt_auto_start);
        set_val!(
            nmt_close_with_companion,
            req.translator_nmt_close_with_companion
        );
        set_val!(nmt_port, req.translator_nmt_port);
        sub.translator = Some(tr);
    }

    over.subagent = Some(sub);

    let body = serde_json::to_string_pretty(&over).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize override: {e}"),
        )
    })?;
    std::fs::write(&path, body).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write {}: {e}", path.display()),
        )
    })?;

    // Hot-swap the live subagent + NMT TranslatorManager.
    //
    // Re-parse companion.toml + runtime.json into a CompanionConfig
    // (mirrors startup), pull out the subagent block, rebuild the
    // client, and atomically publish it via the avatar WsState's
    // ArcSwapOption. Skipped when the avatar subsystem itself isn't
    // running (no place to put the client).
    //
    // For the NMT TranslatorManager: in addition to rebuilding the
    // in-process Translator (which the subagent rebuild already does
    // implicitly), we also respawn the subprocess when its engine-
    // init fields change (backend, model id, preset, device, precision,
    // num_beams, tgt_lang, launch_command, port). Without that step
    // changing the preset in Settings persists to runtime.json but the
    // running NMT process keeps using the old model — Settings says
    // "applied live" while the user keeps getting the old translation
    // engine.
    let mut swapped = false;
    let mut nmt_swap_summary: Option<String> = None;
    if let Some(ref avatar_state) = state.avatar {
        let new_cfg = CompanionConfig::load(&state.config_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("reload config: {e}"),
            )
        })?;
        let avatar_cfg: AvatarConfig =
            serde_json::from_value(new_cfg.avatar.clone()).unwrap_or_default();
        if avatar_cfg.subagent.enabled {
            let zc_for_sub = if avatar_cfg.subagent.use_zeroclaw_webhook {
                Some((*state.zeroclaw.load_full()).clone())
            } else {
                None
            };
            match AvatarSubagent::new(&avatar_cfg.subagent, zc_for_sub) {
                Ok(s) => {
                    avatar_state.subagent.store(Some(Arc::new(s)));
                    swapped = true;
                }
                Err(e) => {
                    tracing::warn!(
                        "companion: subagent rebuild failed; keeping previous client: {e}"
                    );
                }
            }
        } else {
            // User disabled the subagent — clear the live one.
            avatar_state.subagent.store(None);
            swapped = true;
        }

        // ----- NMT TranslatorManager swap -----
        let new_tr = avatar_cfg.subagent.translator.clone();
        let old_mgr = avatar_state.translator_mgr.load_full();
        let want_http = new_tr.backend == TranslatorBackendKind::Http;
        let manager_settings_changed: bool = match old_mgr.as_ref() {
            None => want_http,                     // None → Some(http) is a change
            Some(_existing) if !want_http => true, // Some → None (flipped to llm)
            Some(existing) => {
                // Both sides are http; respawn only when a field that's
                // captured at sidecar init has actually changed.
                let cur = existing.config_snapshot();
                cur.url != new_tr.url
                    || cur.nmt_quality_preset != new_tr.nmt_quality_preset
                    || cur.nmt_model_id != new_tr.nmt_model_id
                    || cur.nmt_num_beams != new_tr.nmt_num_beams
                    || cur.nmt_device != new_tr.nmt_device
                    || cur.nmt_precision != new_tr.nmt_precision
                    || cur.nmt_tgt_lang != new_tr.nmt_tgt_lang
                    || cur.nmt_launch_command != new_tr.nmt_launch_command
                    || cur.nmt_port != new_tr.nmt_port
            }
        };

        if manager_settings_changed {
            if !want_http {
                // Translator flipped to LLM. Stop the running NMT
                // sidecar and clear the slot.
                let avatar_clone = Arc::clone(avatar_state);
                let old_mgr_for_stop = old_mgr.clone();
                tokio::spawn(async move {
                    if let Some(ref m) = old_mgr_for_stop
                        && let Err(e) = m.stop_server().await
                    {
                        tracing::warn!("companion: NMT stop_server returned {e} during swap");
                    }
                    avatar_clone.translator_mgr.store(None);
                    tracing::info!("companion: NMT sidecar stopped (translator flipped to LLM)");
                });
                nmt_swap_summary = Some("stopped (backend → llm)".to_string());
            } else {
                // Want http with new settings. Build new manager and
                // background-spawn a clean handover.
                match companion_avatar::TranslatorManager::new(&new_tr) {
                    Ok(new_mgr) => {
                        let new_mgr = Arc::new(new_mgr);
                        let avatar_clone = Arc::clone(avatar_state);
                        let old_mgr_for_stop = old_mgr.clone();
                        let auto_start = new_tr.nmt_auto_start;
                        tokio::spawn(async move {
                            // 1) Stop the old sidecar (best-effort).
                            if let Some(ref m) = old_mgr_for_stop
                                && let Err(e) = m.stop_server().await
                            {
                                tracing::warn!("companion: prev NMT stop_server returned {e}");
                            }
                            // 2) Publish the new handle so the
                            //    subagent's HttpTranslator (which will
                            //    be rebuilt on the next /api/config/subagent
                            //    or already was just rebuilt above) can
                            //    point at it.
                            avatar_clone.translator_mgr.store(Some(new_mgr.clone()));
                            // 3) Start it.
                            if auto_start && let Err(e) = new_mgr.start_server().await {
                                tracing::warn!("companion: new NMT start_server failed: {e}");
                            }
                            tracing::info!("companion: NMT sidecar hot-swap completed");
                        });
                        nmt_swap_summary = Some(if old_mgr.is_some() {
                            "respawned (config changed)".to_string()
                        } else {
                            "spawned (backend → http)".to_string()
                        });
                    }
                    Err(e) => {
                        tracing::warn!(
                            "companion: TranslatorManager build failed: {e}; keeping previous sidecar"
                        );
                        nmt_swap_summary = Some(format!("build failed: {e}"));
                    }
                }
            }
        }
    }

    tracing::info!(
        "companion: subagent override saved to {} ({}){}",
        path.display(),
        if swapped {
            "applied live, no restart needed"
        } else {
            "restart required — avatar subsystem not active"
        },
        match nmt_swap_summary {
            Some(s) => format!(" — NMT: {s}"),
            None => String::new(),
        },
    );
    Ok(StatusCode::OK)
}

// ── POST /api/config/avatar ──────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct AvatarOverrideRequest {
    /// Master toggle for the avatar subsystem.
    enabled: Option<bool>,
    /// Chat language code (e.g. "en", "ja").
    chat_language: Option<String>,
    /// TTS Provider Spec v1 server URL. Process-affecting.
    tts_api_url: Option<String>,
    /// TTS speech language code.
    tts_language: Option<String>,
    /// TTS speed multiplier.
    tts_speed: Option<f64>,
    /// Default voice id sent to the TTS server.
    tts_voice: Option<String>,
    /// Quality preset for spec v1 sidecars (fast | balanced | high).
    /// Hot-applied per /v1/audio/speech call — no engine restart.
    tts_quality: Option<String>,
    /// Paragraph-wise TTS streaming toggle. Hot-applied.
    tts_streaming: Option<bool>,
    /// Opaque launcher command for the TTS sidecar. Process-affecting.
    /// `tts_launch_command` accepted as a serde alias for legacy clients.
    #[serde(default, alias = "tts_launch_command")]
    tts_launcher_command: Option<String>,
    /// Subagent enabled toggle.
    subagent_enabled: Option<bool>,
    /// Skip subagent when chat_lang == tts_lang.
    subagent_only_when_translating: Option<bool>,
    /// Stream the translation token-by-token (TTS per sentence).
    subagent_streaming: Option<bool>,
}

/// Persist user-flippable avatar settings to companion.runtime.json
/// **and** hot-swap the live `AvatarConfig` (and the TTS child process
/// when the swap touches engine / launch_command / model_path /
/// reference clip / gpu_device).
///
/// AvatarWsState now holds config inside an `ArcSwap`, so simple knobs
/// (chat / tts language, speed, voice, subagent flags) become visible
/// to the next turn the moment we `store()` the new Arc. Process-level
/// changes go through `swap_tts_process` below: gracefully `stop_server`
/// the current TTS, rebuild the `AnimeTtsManager` from the new config,
/// `start_server`, then publish via `ArcSwap`.
///
/// Fail-open semantics on the TTS restart: if `start_server` returns
/// an error, we keep the previous manager in place and surface the
/// error to the UI so the user can edit + retry. The override file is
/// always persisted regardless — the user's intent is captured even
/// when the immediate apply fails.
pub async fn handle_post_avatar_override(
    State(state): State<AppState>,
    Json(req): Json<AvatarOverrideRequest>,
) -> axum::response::Result<Json<serde_json::Value>, (StatusCode, String)> {
    let path = runtime_override_path(&state.config_path);

    let mut over = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|b| serde_json::from_str::<RuntimeOverride>(&b).ok())
            .unwrap_or_default()
    } else {
        RuntimeOverride::default()
    };

    // Whether anything that affects the TTS child process changed.
    // Per the lifecycle protocol, only the URL and the opaque launcher
    // command can force a manager rebuild — synth knobs (language /
    // speed / voice / quality / streaming) are hot-applied per call.
    let tts_process_affected = req.tts_api_url.is_some() || req.tts_launcher_command.is_some();

    let mut av = over.avatar.unwrap_or_default();
    if let Some(v) = req.enabled {
        av.enabled = Some(v);
    }
    if let Some(v) = req.chat_language {
        av.chat_language = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.tts_api_url {
        av.tts_api_url = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.tts_language {
        av.tts_language = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.tts_speed {
        // Clamp into a sane band so a typo can't ship `speed = 99` to TTS.
        let clamped = v.clamp(0.25, 3.0);
        av.tts_speed = Some(clamped);
    }
    if let Some(v) = req.tts_voice {
        av.tts_voice = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.tts_quality {
        // Validate against the spec'd preset names; ignore unknown values
        // rather than persisting garbage that the sidecar would reject.
        let normalized = v.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "fast" | "balanced" | "high") {
            av.tts_quality = Some(normalized);
        }
    }
    if let Some(v) = req.tts_streaming {
        av.tts_streaming = Some(v);
    }
    if let Some(v) = req.tts_launcher_command {
        av.tts_launcher_command = if v.is_empty() { None } else { Some(v) };
    }
    // Subagent toggles relocated from AvatarOverride to SubagentOverride
    // in iteration 4. Wire still accepts them on AvatarOverrideRequest
    // (so the web client doesn't need to fan out across endpoints), but
    // we persist them under `subagent.{...}` — the canonical location —
    // and clear any legacy `avatar.subagent_*` values so the file shape
    // converges to one place over time.
    let touched_subagent_toggles = req.subagent_enabled.is_some()
        || req.subagent_only_when_translating.is_some()
        || req.subagent_streaming.is_some();
    if touched_subagent_toggles {
        let mut sub = over.subagent.take().unwrap_or_default();
        if let Some(v) = req.subagent_enabled {
            sub.enabled = Some(v);
            av.subagent_enabled = None;
        }
        if let Some(v) = req.subagent_only_when_translating {
            sub.only_when_translating = Some(v);
            av.subagent_only_when_translating = None;
        }
        if let Some(v) = req.subagent_streaming {
            sub.streaming = Some(v);
            av.subagent_streaming = None;
        }
        over.subagent = Some(sub);
    }

    over.avatar = Some(av);

    let body = serde_json::to_string_pretty(&over).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize override: {e}"),
        )
    })?;
    std::fs::write(&path, body).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write {}: {e}", path.display()),
        )
    })?;

    // Hot-swap the live avatar config (always synchronous). The TTS
    // child-process swap, when needed, runs on a background task so
    // the HTTP response returns immediately even if the new TTS takes
    // a long time to start (model load + GPU warmup easily exceeds
    // typical HTTP timeouts). The watchdog will update tts_up within
    // ~10 s of the swap completing.
    let mut applied = false;
    let mut tts_restart_pending = false;
    let mut build_error: Option<String> = None;
    if let Some(ref avatar_state) = state.avatar {
        let new_cfg = CompanionConfig::load(&state.config_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("reload config: {e}"),
            )
        })?;
        let new_avatar_cfg: AvatarConfig =
            serde_json::from_value(new_cfg.avatar.clone()).unwrap_or_default();

        // 1. Publish the new config first. Subagent / language / speed
        //    / streaming changes are now live for the next turn.
        avatar_state.config.store(Arc::new(new_avatar_cfg.clone()));
        applied = true;

        // 2. If TTS process-affecting fields changed, swap the manager
        //    asynchronously. Construction is sync + cheap; the
        //    stop/start cycle goes onto a tokio task that updates
        //    AvatarWsState.tts when done.
        if tts_process_affected {
            match AnimeTtsManager::new(&new_avatar_cfg.tts) {
                Ok(new_mgr) => {
                    let new_mgr = Arc::new(new_mgr);
                    let avatar_clone = Arc::clone(avatar_state);
                    let health = state.health.clone();
                    // Mark the watchdog's `tts_last_error` so the UI
                    // gets an immediate "restart in progress" hint;
                    // the watchdog will clear it on the next probe if
                    // the new TTS comes up successfully.
                    health.set_tts(false, Some("TTS restart in progress…".into()));
                    tokio::spawn(async move {
                        // 1) Graceful shutdown of the previous TTS via
                        //    the lifecycle protocol (POST /shutdown →
                        //    wait → kill). No-op when externally
                        //    managed.
                        let old_mgr = avatar_clone.tts.load_full();
                        if let Err(e) = old_mgr.stop_server().await {
                            tracing::warn!(
                                "companion: previous TTS stop_server returned {e} (continuing)"
                            );
                        }
                        // 2) Publish the new manager handle first so
                        //    even if start_server takes a while the
                        //    rest of the app already knows about it
                        //    (the watchdog can probe its /healthz url).
                        avatar_clone.tts.store(new_mgr.clone());
                        // 3) Start it. start_server is a no-op when no
                        //    launcher_command is configured (assumes
                        //    externally-managed server).
                        match new_mgr.start_server().await {
                            Ok(()) => {
                                tracing::info!("companion: TTS hot-swap completed successfully");
                                health.set_tts(true, None);
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "companion: TTS start_server failed in hot-swap: {e}"
                                );
                                health.set_tts(false, Some(format!("TTS start failed: {e}")));
                            }
                        }
                    });
                    tts_restart_pending = true;
                }
                Err(e) => {
                    // Bad config → reject the swap with a clear error
                    // but keep the previous TTS running.
                    build_error = Some(format!("Build TTS manager failed: {e}"));
                    tracing::warn!(
                        "companion: new TTS manager build failed: {e}; keeping previous"
                    );
                }
            }
        }
    }

    tracing::info!(
        "companion: avatar override saved to {} (applied_live={applied}, tts_restart_pending={tts_restart_pending}, build_error={build_error:?})",
        path.display(),
    );

    // 200 OK + JSON body so the UI can render an accurate hint.
    Ok(Json(serde_json::json!({
        "applied_live": applied,
        "tts_process_affected": tts_process_affected,
        "tts_restart_pending": tts_restart_pending,
        // Build error is the synchronous failure mode — bad config
        // values like a missing file. Surface immediately.
        "tts_error": build_error,
    })))
}

// ── POST /api/config/zeroclaw ────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct ZeroclawOverrideRequest {
    /// Which agent flavor: "zeroclaw" | "openclaw" | "hermes" | "custom".
    /// Empty / missing leaves the saved value alone. Unknown values fall
    /// through to "zeroclaw" (defensive — Settings only sends valid ids).
    kind: Option<String>,
    /// Base URL of the agent gateway (e.g. http://127.0.0.1:42617 for a
    /// same-host install, or http://<lan-ip>:42617 for a home-server setup).
    url: Option<String>,
    /// Pairing/bearer token. Empty string clears it.
    pair_token: Option<String>,
    /// Per-request timeout in seconds.
    timeout_secs: Option<u64>,
}

/// Persist the agent connection override (kind / url / pair token /
/// timeout) to companion.runtime.json **and** hot-swap the live
/// `ZeroclawClient` so the change takes effect immediately. No restart
/// required: the AppState holds the client inside an [`arc_swap::ArcSwap`],
/// so rebuilding + `store`-ing a fresh `Arc<ZeroclawClient>` publishes
/// the new agent atomically to every subsequent request. In-flight
/// `/api/chat` calls keep their own clone of the old client until
/// they finish, so concurrent requests can never observe a torn state.
///
/// This is what lets the companion talk to an agent running on a
/// different machine — a home server, a Raspberry Pi, a laptop on the
/// LAN. The companion is a thin client; it never asks the agent to do
/// anything on the machine companion itself runs on.
///
/// Returns 200 OK on success (no longer 202 Accepted — the swap has
/// already happened by the time we respond).
pub async fn handle_post_zeroclaw_override(
    State(state): State<AppState>,
    Json(req): Json<ZeroclawOverrideRequest>,
) -> axum::response::Result<StatusCode, (StatusCode, String)> {
    let path = runtime_override_path(&state.config_path);
    let mut over = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|b| serde_json::from_str::<RuntimeOverride>(&b).ok())
            .unwrap_or_default()
    } else {
        RuntimeOverride::default()
    };

    let mut zc = over.zeroclaw.unwrap_or_default();
    if let Some(ref v) = req.kind
        && !v.trim().is_empty()
    {
        zc.kind = Some(AgentKind::from_str_lossy(v));
    }
    if let Some(v) = req.url {
        let trimmed = v.trim().trim_end_matches('/').to_string();
        zc.url = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    if let Some(v) = req.pair_token {
        zc.pair_token = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.timeout_secs {
        // 5s floor (the agent loop barely starts in less),
        // 1800s ceiling so a typo can't make a request hang for hours.
        zc.timeout_secs = Some(v.clamp(5, 1800));
    }
    over.zeroclaw = Some(zc);

    let body = serde_json::to_string_pretty(&over).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize override: {e}"),
        )
    })?;
    std::fs::write(&path, body).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write {}: {e}", path.display()),
        )
    })?;

    // Re-parse companion.toml + the freshly-written runtime.json into
    // a full CompanionConfig — mirrors the startup load path exactly,
    // no parallel "apply override on top of cached base" code path to
    // drift out of sync. Then build a new ZeroclawClient and publish.
    let new_cfg = CompanionConfig::load(&state.config_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("reload config after save: {e}"),
        )
    })?;
    let new_client = ZeroclawClient::new(&new_cfg.zeroclaw).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("build new agent client: {e}"),
        )
    })?;
    state.zeroclaw.store(Arc::new(new_client));

    tracing::info!(
        "companion: applied agent override {} {} (hot-swapped, no restart needed)",
        new_cfg.zeroclaw.kind.label(),
        new_cfg.zeroclaw.url,
    );
    Ok(StatusCode::OK)
}
