//! End-to-end tests for the NMT translator wire contract and for
//! `TranslatorManager` subprocess lifecycle.
//!
//! Mock pattern mirrors `tts_port_e2e.rs`: spin a tiny axum mock on an
//! ephemeral port, point an `HttpTranslator` (or `TranslatorManager`) at
//! it, drive the wire, assert.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    extract::{Json, State},
    response::IntoResponse,
    routing::{get, post},
};
use companion_avatar::{HttpTranslator, Translator, TranslatorConfig, TranslatorManager};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Mock NMT server
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct MockState {
    /// Captured request bodies, in the order they arrived.
    requests: Arc<Mutex<Vec<MockRequest>>>,
    /// Response body to return (canned "translation" of every request).
    response_text: String,
    /// HTTP status to return (200 by default).
    response_status: u16,
    /// Whether `/shutdown` should record the hit (we never actually
    /// exit since this lives in the test process).
    shutdowns: Arc<Mutex<u32>>,
    /// When true, `/shutdown` flips the mock to permanently unhealthy
    /// (subsequent `/health` GETs return 503). Mirrors what the real
    /// Python sidecar does — it spawns a daemon thread that exits the
    /// process, so `/health` stops responding shortly after `/shutdown`.
    /// When false, `/health` keeps returning 200 even after `/shutdown`
    /// — the "wedged Python process" failure mode the orphan-detection
    /// branch must surface as a warning.
    die_on_shutdown: bool,
    /// Set to true once `/shutdown` has been hit (only consulted when
    /// `die_on_shutdown` is true).
    shut_down: Arc<Mutex<bool>>,
}

#[derive(Debug, Deserialize, Clone)]
struct MockRequest {
    text: String,
    #[serde(default)]
    tgt_lang: Option<String>,
    /// Optional source-language override. The HttpTranslator sends
    /// this when `process_speak` calls translate with a known
    /// source language (chat_lang).
    #[serde(default)]
    src_lang: Option<String>,
}

#[derive(Debug, Serialize)]
struct MockResponse {
    text: String,
    src_lang: String,
    tgt_lang: String,
}

async fn handle_health(State(state): State<MockState>) -> impl IntoResponse {
    // Once `/shutdown` has been called on a `die_on_shutdown=true` mock,
    // simulate the Python sidecar actually exiting — the OS would stop
    // accepting connections, but axum-in-the-test-process can't easily
    // close its listener, so we return 503 instead. The Rust side's
    // probe_health checks for 2xx, so 503 reads as "down" and the
    // poll loop exits.
    if state.die_on_shutdown && *state.shut_down.lock().await {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({"status": "shutting_down"})),
        );
    }
    (
        axum::http::StatusCode::OK,
        axum::Json(serde_json::json!({
            "status": "ok",
            "backend": "mock",
            "model_id": "mock/nmt",
            "src_lang": "en",
            "tgt_lang": "ja",
        })),
    )
}

async fn handle_translate(
    State(state): State<MockState>,
    Json(req): Json<MockRequest>,
) -> impl IntoResponse {
    state.requests.lock().await.push(req.clone());
    (
        axum::http::StatusCode::from_u16(state.response_status).unwrap(),
        axum::Json(MockResponse {
            text: state.response_text.clone(),
            src_lang: "en".into(),
            tgt_lang: req.tgt_lang.unwrap_or_else(|| "ja".into()),
        }),
    )
}

async fn handle_shutdown(State(state): State<MockState>) -> impl IntoResponse {
    *state.shutdowns.lock().await += 1;
    if state.die_on_shutdown {
        *state.shut_down.lock().await = true;
    }
    axum::Json(serde_json::json!({"status": "shutting_down"}))
}

async fn boot_mock(state: MockState) -> (u16, Arc<Mutex<Vec<MockRequest>>>, Arc<Mutex<u32>>) {
    let captured_reqs = Arc::clone(&state.requests);
    let captured_shutdowns = Arc::clone(&state.shutdowns);
    let app = Router::new()
        .route("/health", get(handle_health))
        .route("/translate", post(handle_translate))
        .route("/shutdown", post(handle_shutdown))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    // Tiny grace so the listener is accepting.
    tokio::time::sleep(Duration::from_millis(20)).await;
    (port, captured_reqs, captured_shutdowns)
}

fn config_for(port: u16) -> TranslatorConfig {
    TranslatorConfig {
        url: format!("http://127.0.0.1:{port}"),
        http_timeout_secs: 5,
        // We don't spawn a real subprocess in these tests; leave
        // launch_command empty so the manager treats the (already
        // mock-bound) port as "externally managed".
        nmt_launch_command: String::new(),
        nmt_auto_start: false,
        nmt_close_with_companion: true,
        nmt_port: port,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// HttpTranslator wire contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http_translator_round_trip() {
    let state = MockState {
        response_text: "こんにちは、世界".into(),
        response_status: 200,
        ..Default::default()
    };
    let (port, captured, _) = boot_mock(state).await;

    let t =
        HttpTranslator::new(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2)).unwrap();

    let result = t.translate("hello, world", Some("en"), "ja").await;
    assert_eq!(result.as_deref(), Some("こんにちは、世界"));

    let reqs = captured.lock().await;
    assert_eq!(reqs.len(), 1, "exactly one request reached the mock");
    assert_eq!(reqs[0].text, "hello, world");
    assert_eq!(reqs[0].tgt_lang.as_deref(), Some("ja"));
    assert_eq!(
        reqs[0].src_lang.as_deref(),
        Some("en"),
        "HttpTranslator must forward source_language so NLLB can pick the right tokenizer vocab",
    );
}

#[tokio::test]
async fn http_translator_omits_src_lang_when_none() {
    // When the caller doesn't know what source language the input is
    // in, we should NOT send src_lang — let the engine fall back to
    // its configured default.
    let state = MockState {
        response_text: "translated".into(),
        response_status: 200,
        ..Default::default()
    };
    let (port, captured, _) = boot_mock(state).await;

    let t =
        HttpTranslator::new(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2)).unwrap();

    let _ = t.translate("hello", None, "ja").await;
    let reqs = captured.lock().await;
    assert_eq!(reqs.len(), 1);
    assert!(
        reqs[0].src_lang.is_none(),
        "src_lang must be omitted when None"
    );
}

#[tokio::test]
async fn http_translator_empty_text_returns_none() {
    let state = MockState {
        response_text: "should not be hit".into(),
        response_status: 200,
        ..Default::default()
    };
    let (port, captured, _) = boot_mock(state).await;

    let t =
        HttpTranslator::new(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2)).unwrap();

    assert_eq!(t.translate("", Some("en"), "ja").await, None);
    assert_eq!(t.translate("   ", Some("en"), "ja").await, None);
    assert_eq!(
        captured.lock().await.len(),
        0,
        "empty text should short-circuit before reaching the server"
    );
}

#[tokio::test]
async fn http_translator_500_returns_none() {
    let state = MockState {
        response_text: "ignored".into(),
        response_status: 500,
        ..Default::default()
    };
    let (port, _captured, _) = boot_mock(state).await;

    let t =
        HttpTranslator::new(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2)).unwrap();

    assert_eq!(t.translate("hello", Some("en"), "ja").await, None);
}

#[tokio::test]
async fn http_translator_streaming_emits_full_result_once() {
    let state = MockState {
        response_text: "全文を一度に".into(),
        response_status: 200,
        ..Default::default()
    };
    let (port, _captured, _) = boot_mock(state).await;

    let t =
        HttpTranslator::new(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2)).unwrap();

    let chunks = Arc::new(Mutex::new(Vec::<String>::new()));
    let chunks_clone = Arc::clone(&chunks);
    let cb: Box<dyn FnMut(&str) + Send> = Box::new(move |s: &str| {
        // Send-safe push via std::sync::Mutex would simplify, but
        // tokio::Mutex works inside a closure as long as we use
        // try_lock — and we know the closure is invoked from the
        // same task that drives the test.
        let mut g = chunks_clone.try_lock().unwrap();
        g.push(s.to_string());
    });

    let result = t.translate_stream("hello", Some("en"), "ja", cb).await;
    assert_eq!(result.as_deref(), Some("全文を一度に"));

    let chunks = chunks.lock().await;
    assert_eq!(
        chunks.len(),
        1,
        "HTTP backend fires the callback exactly once"
    );
    assert_eq!(chunks[0], "全文を一度に");
}

// ---------------------------------------------------------------------------
// TranslatorManager — externally-managed sidecar (no spawn)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manager_adopts_external_sidecar_and_shuts_down() {
    let state = MockState {
        response_text: "irrelevant".into(),
        response_status: 200,
        die_on_shutdown: true,
        ..Default::default()
    };
    let (port, _captured, shutdowns) = boot_mock(state).await;

    let cfg = config_for(port);
    let mgr = TranslatorManager::new(&cfg).unwrap();
    assert!(
        !mgr.will_spawn(),
        "empty launch_command should disable spawning"
    );

    // `start_server` should adopt the mock and return Ok without spawning.
    mgr.start_server().await.expect("adopt external sidecar");

    // `stop_server` should POST /shutdown and then wait for /health to
    // stop responding (simulated here by the mock flipping to 503).
    // Without the orphan-detection poll the call would return Ok
    // instantly even on a wedged sidecar — see `manager_warns_when_adopted_sidecar_ignores_shutdown`.
    let start = std::time::Instant::now();
    mgr.stop_server().await.expect("graceful stop");
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(4),
        "adopted shutdown should return fast when the sidecar actually exits (took {elapsed:?})",
    );

    let n = *shutdowns.lock().await;
    assert_eq!(n, 1, "exactly one /shutdown hit recorded");
}

#[tokio::test]
async fn manager_warns_when_adopted_sidecar_ignores_shutdown() {
    // Regression net for the bug surfaced in iter 12: when
    // `start_server` ADOPTED an existing sidecar (no `self.child` to
    // kill), the original `stop_server` returned Ok immediately after
    // POSTing /shutdown — even if the Python process was wedged and
    // ignored the request. The result was a silent NMT leak across
    // every companion-server lifecycle. The new code polls /health
    // until it actually fails or the grace timeout fires; here we
    // simulate the wedged case (mock NEVER becomes unhealthy) and
    // verify stop_server still completes (so it doesn't hang the app
    // exit path) but takes the full grace window.
    let state = MockState {
        response_text: "irrelevant".into(),
        response_status: 200,
        die_on_shutdown: false, // mock IGNORES /shutdown
        ..Default::default()
    };
    let (port, _captured, shutdowns) = boot_mock(state).await;

    let cfg = config_for(port);
    let mgr = TranslatorManager::new(&cfg).unwrap();
    mgr.start_server().await.expect("adopt external sidecar");

    let start = std::time::Instant::now();
    mgr.stop_server()
        .await
        .expect("graceful stop returns Ok even when wedged");
    let elapsed = start.elapsed();

    // NMT_GRACEFUL_TIMEOUT is 8s — we should observe at least most
    // of it elapse before stop_server returns (the grace poll runs
    // to its deadline). Don't bound the upper end too tightly to
    // avoid CI flakes.
    assert!(
        elapsed >= Duration::from_secs(7),
        "expected stop_server to poll for ~the full grace window when wedged (took {elapsed:?})",
    );
    assert_eq!(
        *shutdowns.lock().await,
        1,
        "exactly one /shutdown POST even though the sidecar ignored it",
    );
}

#[tokio::test]
async fn manager_start_idempotent_when_already_healthy() {
    let state = MockState {
        response_text: "".into(),
        response_status: 200,
        ..Default::default()
    };
    let (port, _captured, _shutdowns) = boot_mock(state).await;

    let cfg = config_for(port);
    let mgr = TranslatorManager::new(&cfg).unwrap();
    // Two starts in a row should both succeed (second one adopts).
    mgr.start_server().await.expect("first start");
    mgr.start_server().await.expect("second start adopts");
}
