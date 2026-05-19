//! companion-server — entry point for waifu-companion.
//!
//! Lifecycle:
//! 1. Load `companion.toml` (or use defaults).
//! 2. Health-check the upstream agent daemon (zeroclaw / openclaw /
//!    hermes / custom, selected by `[zeroclaw] kind`).
//! 3. Build the avatar subsystem (subagent + TTS port + WS state).
//! 4. Spawn the SSE bridge: subscribe to the agent's `/api/events`,
//!    forward `agent.reply` events to the avatar broadcast channel.
//! 5. Auto-start the configured TTS server.
//! 6. Serve the companion UI + WS routes on its own HTTP port.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use axum::Router;
use axum::routing::get;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use companion_avatar::{
    AnimeTtsManager, AvatarConfig, AvatarSubagent, AvatarWsState, SpeechManager,
    TranslatorBackendKind, TranslatorManager, handle_ws_avatar,
};
use companion_core::{CompanionConfig, ZeroclawClient};
use companion_pulse::{PulseConfig, PulseSubsystem};

mod bridges;
mod characters;
mod handlers;
mod pulse_api;
mod state;
mod web_assets;

use state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let config_path = config_path()?;
    tracing::info!("companion: loading config from {}", config_path.display());
    let cfg = CompanionConfig::load(&config_path)?;

    // ── 1. Talk to the upstream agent (zeroclaw / openclaw / hermes) ──
    let zc = ZeroclawClient::new(&cfg.zeroclaw)?;
    // Don't *block* startup on the agent — if it's unreachable a TCP
    // connect to a dead host can stall ~20s, which froze the whole UI
    // (companion-server hadn't bound its HTTP listener yet). The health
    // watchdog (below) tracks the agent's real state; this is just an
    // informational log line, so fire it off the critical path.
    {
        let zc_probe = zc.clone();
        let (kind_label, url) = (
            cfg.zeroclaw.kind.label().to_string(),
            cfg.zeroclaw.url.clone(),
        );
        tokio::spawn(async move {
            match zc_probe.health().await {
                Ok(true) => tracing::info!("companion: {kind_label} at {url} is up"),
                Ok(false) | Err(_) => tracing::warn!(
                    "companion: {kind_label} at {url} unreachable — chat features limited until it comes up"
                ),
            }
        });
    }

    // ── 2. Build the avatar subsystem (if enabled) ───────────────
    let avatar_state = build_avatar(&cfg, zc.clone()).await?;

    // ── 3. SSE bridge: agent /api/events → avatar broadcast ──────
    if let Some(ref state) = avatar_state {
        let event_tx = state.event_tx.clone();
        let zc_clone = zc.clone();
        tokio::spawn(async move {
            bridges::run_sse_bridge(zc_clone, event_tx).await;
        });
    }

    // ── 4. Build the Pulse subsystem (if enabled) ────────────────
    // Pulse summarize reuses whichever backend the user already
    // configured for the avatar subagent — direct LLM call or via
    // the agent's webhook — so they don't have to set up two paths.
    let pulse_summarizer = build_pulse_summarizer(&cfg, zc.clone());
    let pulse_state = build_pulse(&cfg, pulse_summarizer).await?;

    // ── 5. Build the axum app ─────────────────────────────────────
    let health = Arc::new(state::AppHealth::default());
    let app_state = AppState {
        avatar: avatar_state,
        pulse: pulse_state,
        // Behind ArcSwap so the settings UI can rebuild + swap the
        // client mid-process — no restart required for agent changes.
        zeroclaw: Arc::new(ArcSwap::from_pointee(zc)),
        config_path: config_path.clone(),
        health: health.clone(),
    };

    // ── Health watchdog ───────────────────────────────────────────
    // Probes the agent, TTS, and subagent every 10s on a background
    // task and writes results into AppHealth. /api/status reads from
    // there without re-issuing the network calls itself, so the UI
    // refresh rate is decoupled from probe latency.
    {
        let watch_state = app_state.clone();
        tokio::spawn(async move {
            handlers::health::run_health_watchdog(watch_state).await;
        });
    }

    // Shutdown channel: GET /api/shutdown sends () through this so
    // the main loop knows to wind down (graceful TTS stop, then exit).
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let shutdown_tx = Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx)));

    let mut router = Router::new()
        .route("/health", get(handlers::health::handle_health))
        .route("/api/status", get(handlers::health::handle_status))
        .route(
            "/api/chat",
            axum::routing::post(handlers::chat::handle_chat),
        )
        .route("/api/config", get(handlers::config::handle_get_config))
        .route(
            "/api/config/subagent",
            axum::routing::post(handlers::config::handle_post_subagent_override),
        )
        .route(
            "/api/config/avatar",
            axum::routing::post(handlers::config::handle_post_avatar_override),
        )
        .route(
            "/api/config/zeroclaw",
            axum::routing::post(handlers::config::handle_post_zeroclaw_override),
        )
        .route("/api/models", get(handlers::config::handle_list_models))
        .route(
            "/api/characters",
            get(handlers::characters::handle_list_characters)
                .post(handlers::characters::handle_upsert_character),
        )
        .route(
            "/api/characters/active",
            axum::routing::post(handlers::characters::handle_set_active_character),
        )
        .route(
            "/api/characters/{id}",
            axum::routing::delete(handlers::characters::handle_delete_character),
        )
        .route(
            "/api/characters/{id}/attachments",
            get(handlers::characters::handle_list_character_attachments),
        )
        .route(
            "/api/characters/{id}/attachments/{file}",
            get(handlers::characters::handle_get_character_attachment)
                .put(handlers::characters::handle_put_character_attachment)
                .delete(handlers::characters::handle_delete_character_attachment),
        )
        .route(
            "/api/shutdown",
            axum::routing::post({
                let shutdown_tx = shutdown_tx.clone();
                move || async move {
                    tracing::info!("companion: /api/shutdown requested");
                    if let Some(tx) = shutdown_tx.lock().await.take() {
                        let _ = tx.send(());
                    }
                    axum::http::StatusCode::ACCEPTED
                }
            }),
        );

    if let Some(avatar) = &app_state.avatar {
        let avatar_state = Arc::clone(avatar);
        router = router.route(
            "/ws/avatar",
            get(handle_ws_avatar).with_state(Arc::clone(&avatar_state)),
        );
        // Voice input proxy. Frontend posts base64-encoded WAV here;
        // we forward to the speech sidecar and return the transcript.
        // 503 when [avatar.speech] enabled = false or the sidecar is
        // unreachable, so the UI can show a clear "STT unavailable"
        // state without dropping the user input.
        router = router.route(
            "/api/avatar/asr",
            axum::routing::post(handlers::chat::handle_avatar_asr).with_state(avatar_state),
        );
    }

    if let Some(ref pulse) = app_state.pulse {
        let pulse_routes = pulse_api::routes().with_state(Arc::clone(pulse));
        router = router.nest("/api/pulse", pulse_routes);
    }

    // Serve the companion web bundle (Vite build output).
    //
    // The frontend is a React SPA with client-side routing (BrowserRouter
    // — `/avatar`, `/pulse`, etc. are handled by React, not by files on
    // disk). For any path that doesn't match a real asset, fall through
    // to `index.html` so React can take over. Without this, hitting
    // `/avatar` directly in the browser would 404.
    let web_dir = web_assets::resolve_web_dist(&cfg.server.web_dist_dir);
    if web_dir.exists() {
        tracing::info!("companion: serving web from {}", web_dir.display());
        let index_path = web_dir.join("index.html");
        let serve_dir = ServeDir::new(&web_dir).fallback(web_assets::spa_fallback(index_path));
        router = router.fallback_service(serve_dir);
    } else {
        tracing::warn!(
            "companion: web bundle not found at {}; UI will 404 until you `npm run build` in web/",
            web_dir.display()
        );
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Clone the avatar handle for the shutdown path BEFORE moving
    // app_state into the router — the router takes ownership of
    // app_state via .with_state.
    let avatar_for_shutdown = app_state.avatar.clone();

    let app = router
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(app_state);

    // ── 5. Bind ───────────────────────────────────────────────────
    //
    // SO_REUSEADDR is set so a hard-killed previous instance doesn't
    // lock us out for ~2h: Windows otherwise holds the LISTENING TCB
    // (with the now-defunct PID) until any half-closed CloseWait
    // connections from prior clients age out, which can take hours
    // and breaks the dev workflow after every Tauri crash. On Windows
    // SO_REUSEADDR means "a new bind on the same address wins" (the
    // OS hands subsequent traffic to the new listener); on Linux/macOS
    // it bypasses TIME_WAIT for the same address. Both are exactly
    // the behaviour we want for a singleton local service.
    let addr = format!("{}:{}", cfg.server.host, cfg.server.port);
    let sock_addr: std::net::SocketAddr = addr
        .parse()
        .with_context(|| format!("invalid bind address {addr}"))?;
    let socket = if sock_addr.is_ipv4() {
        tokio::net::TcpSocket::new_v4()
    } else {
        tokio::net::TcpSocket::new_v6()
    }
    .context("failed to create listening socket")?;
    socket
        .set_reuseaddr(true)
        .context("failed to set SO_REUSEADDR")?;
    socket
        .bind(sock_addr)
        .with_context(|| format!("failed to bind {addr}"))?;
    let listener = socket
        .listen(1024)
        .with_context(|| format!("failed to listen on {addr}"))?;
    tracing::info!("companion: listening on http://{addr}");
    tracing::info!("            • avatar UI:  http://{addr}/avatar");
    tracing::info!("            • WS avatar:  ws://{addr}/ws/avatar");
    tracing::info!("            • health:     http://{addr}/health");

    let server = axum::serve(listener, app);
    tokio::select! {
        // The HTTP server itself exits — shouldn't happen under normal
        // operation, but if it does we still want to stop TTS.
        result = server => {
            tracing::info!("companion: HTTP server exited: {:?}", result.as_ref().map(|_| "ok"));
        }
        // Tauri (or external user) hit POST /api/shutdown — graceful
        // shutdown path. We've moved the tx out, so this completes.
        _ = shutdown_rx => {
            tracing::info!("companion: shutdown signal received via /api/shutdown");
        }
        // Ctrl+C in a console run.
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("companion: Ctrl+C received");
        }
    }

    // Graceful TTS shutdown per the launch & lifecycle protocol
    // (docs/TTS-PROVIDER-SPEC.md): POST /shutdown → wait for the spawned
    // child (if we own one) → SIGKILL fallback. Always runs — close-with-
    // companion is implicit in the protocol; if the user wants a warm
    // server between sessions, they manage that server externally
    // (no launcher_command in companion.toml, server pre-spawned).
    if let Some(avatar) = avatar_for_shutdown {
        tracing::info!("companion: stopping TTS server before exit");
        let tts_snap = avatar.tts.load_full();
        if let Err(e) = tts_snap.stop_server().await {
            tracing::warn!("companion: TTS stop_server returned {e}");
        }
        // Symmetric NMT shutdown. Off-by-default close_with_companion=true
        // (model load is expensive; leaving it pinned just to "save 30s
        // next launch" defeats the point — same call as TTS).
        let cfg = avatar.config.load();
        if cfg.subagent.translator.backend == TranslatorBackendKind::Http
            && cfg.subagent.translator.nmt_close_with_companion
            && let Some(mgr) = avatar.translator_mgr.load_full()
        {
            tracing::info!("companion: stopping NMT translator before exit");
            if let Err(e) = mgr.stop_server().await {
                tracing::warn!("companion: NMT stop_server returned {e}");
            }
        }
        // Speech sidecar — same close-with-companion discipline as TTS
        // and NMT. Off → leave warm so the next launch adopts; on → the
        // POST /shutdown lets Whisper release its model weights cleanly
        // (matters for GPU compute_types — fragmented VRAM otherwise).
        if cfg.speech.enabled
            && cfg.speech.close_with_companion
            && let Some(mgr) = avatar.speech_mgr.load_full()
        {
            tracing::info!("companion: stopping speech sidecar before exit");
            if let Err(e) = mgr.stop_server().await {
                tracing::warn!("companion: speech stop_server returned {e}");
            }
        }
    }
    tracing::info!("companion: bye");
    Ok(())
}

// ── helpers ───────────────────────────────────────────────────────

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,companion=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

fn config_path() -> Result<PathBuf> {
    if let Ok(env) = std::env::var("COMPANION_CONFIG") {
        return Ok(PathBuf::from(env));
    }
    let cwd = std::env::current_dir()?;
    let local = cwd.join("companion.toml");
    if local.exists() {
        return Ok(local);
    }
    if let Some(home) = directories::UserDirs::new() {
        let home_cfg = home
            .home_dir()
            .join(".waifu-companion")
            .join("companion.toml");
        return Ok(home_cfg);
    }
    Ok(local)
}

async fn build_avatar(
    cfg: &CompanionConfig,
    zeroclaw_client: ZeroclawClient,
) -> Result<Option<Arc<AvatarWsState>>> {
    // Avatar config lives under [avatar] in companion.toml. We deserialize
    // here (companion-core kept it as a Value to stay decoupled).
    let avatar_cfg: AvatarConfig = serde_json::from_value(cfg.avatar.clone()).unwrap_or_default();
    if !avatar_cfg.enabled {
        tracing::info!("companion: avatar disabled in config");
        return Ok(None);
    }

    // Optional subagent (expression analysis + translation). When
    // `use_zeroclaw_webhook = true` we pass the upstream client so the
    // backend can route through the agent and reuse its (already-decrypted)
    // provider key.
    let subagent = if avatar_cfg.subagent.enabled {
        let zc_for_subagent = if avatar_cfg.subagent.use_zeroclaw_webhook {
            Some(zeroclaw_client.clone())
        } else {
            None
        };
        match AvatarSubagent::new(&avatar_cfg.subagent, zc_for_subagent) {
            Ok(s) => {
                tracing::info!(
                    "companion: avatar subagent ready (backend={})",
                    if avatar_cfg.subagent.use_zeroclaw_webhook {
                        "zeroclaw-webhook"
                    } else {
                        "openai-compatible"
                    }
                );
                Some(Arc::new(s))
            }
            Err(e) => {
                tracing::warn!(
                    "companion: avatar subagent init failed; using keyword fallback: {e}"
                );
                None
            }
        }
    } else {
        None
    };

    // TTS port. Start the configured server in the background so the
    // avatar UI can still load if the TTS server is down. start_server
    // is a no-op when there's no launcher_command (externally-managed
    // server case — just polls /healthz).
    let tts = Arc::new(
        AnimeTtsManager::new(&avatar_cfg.tts).context("companion: avatar TTS init failed")?,
    );
    {
        let tts_clone = Arc::clone(&tts);
        tokio::spawn(async move {
            if let Err(e) = tts_clone.start_server().await {
                tracing::warn!("companion: TTS start_server failed: {e}");
            }
        });
    }

    // NMT translator sidecar. Constructed only when the subagent is
    // configured to call the HTTP translator backend. Auto-start
    // mirrors the TTS pattern: spawn in the background so the UI can
    // come up before the sidecar finishes its cold-load.
    let translator_mgr: Option<Arc<TranslatorManager>> =
        if avatar_cfg.subagent.translator.backend == TranslatorBackendKind::Http {
            match TranslatorManager::new(&avatar_cfg.subagent.translator) {
                Ok(mgr) => {
                    let mgr = Arc::new(mgr);
                    if avatar_cfg.subagent.translator.nmt_auto_start {
                        let mgr_clone = Arc::clone(&mgr);
                        tokio::spawn(async move {
                            if let Err(e) = mgr_clone.start_server().await {
                                tracing::warn!("companion: NMT auto-start failed: {e}");
                            }
                        });
                    }
                    Some(mgr)
                }
                Err(e) => {
                    tracing::warn!(
                        "companion: NMT manager init failed; HTTP translator \
                         calls will fail until you start the sidecar manually: {e}"
                    );
                    None
                }
            }
        } else {
            None
        };

    // Speech (STT) sidecar — voice input + TTS verification. Built only
    // when [avatar.speech] enabled = true. Auto-start spawns in the
    // background so the UI can load before whisper's cold path
    // completes.
    let speech_mgr: Option<Arc<SpeechManager>> = if avatar_cfg.speech.enabled {
        match SpeechManager::new(&avatar_cfg.speech) {
            Ok(mgr) => {
                let mgr = Arc::new(mgr);
                if avatar_cfg.speech.auto_start {
                    let mgr_clone = Arc::clone(&mgr);
                    tokio::spawn(async move {
                        if let Err(e) = mgr_clone.start_server().await {
                            tracing::warn!("companion: speech sidecar auto-start failed: {e}");
                        }
                    });
                }
                Some(mgr)
            }
            Err(e) => {
                tracing::warn!(
                    "companion: speech sidecar init failed; voice input \
                     disabled until you start the sidecar manually: {e}"
                );
                None
            }
        }
    } else {
        None
    };

    let (event_tx, _event_rx) = broadcast::channel(64);

    tracing::info!(
        "companion: avatar enabled (chat_lang={}, tts_lang={}, tts_url={}, speech={})",
        avatar_cfg.chat_language,
        avatar_cfg.tts.language,
        avatar_cfg.tts.api_url.as_deref().unwrap_or("<unset>"),
        if avatar_cfg.speech.enabled {
            "on"
        } else {
            "off"
        },
    );

    Ok(Some(Arc::new(AvatarWsState {
        // All handles wrapped for runtime hot-swap.
        config: arc_swap::ArcSwap::from_pointee(avatar_cfg),
        event_tx,
        subagent: arc_swap::ArcSwapOption::from(subagent),
        tts: arc_swap::ArcSwap::new(tts),
        translator_mgr: arc_swap::ArcSwapOption::from(translator_mgr),
        speech_mgr: arc_swap::ArcSwapOption::from(speech_mgr),
    })))
}

async fn build_pulse(
    cfg: &CompanionConfig,
    summarizer: Option<Arc<companion_pulse::Summarizer>>,
) -> Result<Option<Arc<PulseSubsystem>>> {
    let pulse_cfg: PulseConfig = serde_json::from_value(cfg.pulse.clone()).unwrap_or_default();
    if !pulse_cfg.enabled {
        tracing::info!("companion: pulse disabled in config");
        return Ok(None);
    }
    let subsystem = PulseSubsystem::start(&pulse_cfg, summarizer)
        .await
        .context("companion: pulse init failed")?;
    Ok(Some(Arc::new(subsystem)))
}

/// Build the Summarizer used by Pulse's `POST /items/{id}/summarize`.
///
/// We mirror the avatar subagent's backend choice so the user only
/// configures one path:
///
/// * `subagent.use_zeroclaw_webhook = true` → tunnel through the agent's
///   `/webhook` (no API key needed on this machine).
/// * otherwise → direct OpenAI-compatible call using
///   `[avatar.subagent.llm]`.
///
/// Returns `None` if the avatar config can't be deserialized or the
/// chosen backend fails to construct. In that case `/items/{id}/summarize`
/// reports 503; the rest of Pulse keeps working.
fn build_pulse_summarizer(
    cfg: &CompanionConfig,
    zc: companion_core::zeroclaw::ZeroclawClient,
) -> Option<Arc<companion_pulse::Summarizer>> {
    let avatar_cfg: AvatarConfig = serde_json::from_value(cfg.avatar.clone()).ok()?;
    if avatar_cfg.subagent.use_zeroclaw_webhook {
        tracing::info!("companion: pulse summarize ready (backend=zeroclaw-webhook)");
        Some(Arc::new(companion_pulse::Summarizer::Zeroclaw(zc)))
    } else {
        match companion_core::llm::LlmClient::new(&avatar_cfg.subagent.llm) {
            Ok(c) => {
                tracing::info!(
                    "companion: pulse summarize ready (backend=openai-compatible, model={})",
                    avatar_cfg.subagent.llm.model,
                );
                Some(Arc::new(companion_pulse::Summarizer::Llm(c)))
            }
            Err(e) => {
                tracing::warn!("companion: pulse summarize unavailable (LLM init failed: {e})");
                None
            }
        }
    }
}
