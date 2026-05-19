//! Pluggable translation backend for the avatar subagent.
//!
//! The subagent has two LLM call-sites that ONLY translate text (no
//! expression detection, no JSON contract): `translate_chunk` and
//! `translate_stream`. Calling a chat LLM for those is expensive — even
//! with `thinking: disabled` glm-4.5-flash takes ~700-1000 ms per
//! sentence, and that latency lands on the critical path between user
//! input and first audible audio.
//!
//! A small per-language-pair NMT model (e.g. `staka/fugumt-en-ja`,
//! ~70M params) translates the same sentence in ~100-300 ms on CPU
//! with no network roundtrip. The output is more literal — translation
//! models don't render anime-girl casual register the way a prompted
//! LLM can — so this is offered as a backend *option*, not a default.
//!
//! ## Implementations
//!
//! - [`LlmTranslator`] — existing behavior: prompts the subagent's
//!   LLM with an instruction-following translate template. Supports
//!   real per-token streaming via [`SubagentBackend`]'s streaming
//!   surface (when present).
//!
//! - [`HttpTranslator`] — calls the companion-owned NMT sidecar
//!   (`tools/avatar/nmt_translator_server.py`) over localhost HTTP.
//!   Non-streaming: emits the full translation through the streaming
//!   callback in a single firing. The latency is low enough that the
//!   missing per-token incrementality is invisible to the user.
//!
//! ## Configuration
//!
//! Selected at construct time via the `[avatar.subagent.translator]`
//! block in companion.toml — see [`TranslatorConfig`].

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::subagent::SubagentBackend;
use companion_core::llm::LlmClient;

/// Boxed callback type used by [`Translator::translate_stream`]. Owned
/// (not borrowed) so the trait object stays object-safe and downstream
/// implementations can hand it to closures that capture state across
/// `.await` points without lifetime gymnastics.
pub type ChunkCallback = Box<dyn FnMut(&str) + Send>;

/// One translate-text-to-text call. Implementations own their timeout /
/// retry policy; callers just await `Option<String>` and degrade on
/// `None`.
///
/// `source_language` is what the input text is in. NLLB needs this to
/// pick the right tokenizer vocabulary; LLM-based backends use it for
/// prompt context. Pass `None` to fall back to the engine's configured
/// source language.
#[async_trait]
pub trait Translator: Send + Sync {
    /// One-shot translation. Returns `None` on transient failure.
    async fn translate(
        &self,
        text: &str,
        source_language: Option<&str>,
        target_language: &str,
    ) -> Option<String>;

    /// Streaming translation. Each incremental output fires `on_chunk`.
    /// Returns the assembled translation when complete. Backends without
    /// a per-token surface (HTTP / NMT sidecar) implement this as a
    /// single-call translate followed by one callback firing.
    async fn translate_stream(
        &self,
        text: &str,
        source_language: Option<&str>,
        target_language: &str,
        on_chunk: ChunkCallback,
    ) -> Option<String>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Which translator backend the subagent uses.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TranslatorBackendKind {
    /// Prompt the subagent's LLM with a translate instruction. ~700-1000 ms
    /// per sentence; supports real per-token streaming. Best quality.
    #[default]
    Llm,
    /// Call the local NMT sidecar over HTTP. ~100-300 ms per sentence;
    /// non-streaming. Plain-register output (no persona). Latency-optimized.
    Http,
}

/// `[avatar.subagent.translator]` section in companion.toml.
///
/// The fields are organised by axis (backend choice, quality, hardware,
/// runtime safety) so any axis can be tuned without touching the others.
/// All `nmt_*` fields are forwarded to the NMT sidecar as env vars at
/// spawn time when `backend = "http"`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TranslatorConfig {
    // ----- Backend selection -----
    /// Pick `llm` (default) or `http` (NMT sidecar).
    #[serde(default)]
    pub backend: TranslatorBackendKind,
    /// Base URL of the NMT sidecar when `backend = "http"`. The
    /// translator POSTs to `{url}/translate`. Default 127.0.0.1:9881
    /// matches the wrapper's default port.
    #[serde(default = "default_http_url")]
    pub url: String,
    /// Per-call timeout for the HTTP path. 8 s is generous — even a
    /// cold NLLB-600M call completes well under 3 s. Ignored by the
    /// LLM path (which uses the subagent's own `timeout_secs`).
    #[serde(default = "default_http_timeout")]
    pub http_timeout_secs: u64,

    // ----- NMT quality knobs (forwarded to the sidecar as env) -----
    //
    // Presets, from fastest to highest quality:
    //   "fast"     → staka/fugumt-en-ja                (~70M,  ~100ms CPU)
    //   "balanced" → facebook/nllb-200-distilled-600M  (600M,  ~400ms CPU) — default
    //   "quality"  → facebook/nllb-200-distilled-1.3B  (1.3B,  ~1-2s CPU) — top tier
    //   "custom"   → nmt_model_id below
    //
    // NLLB-3.3B was removed in favor of 1.3B as the top tier: +1.5-2.5 BLEU on
    // en→ja wasn't worth 3-5x latency and 2x VRAM for short conversational
    // sentences.
    //
    /// One of "fast", "balanced", "quality", "custom".
    #[serde(default = "default_quality_preset")]
    pub nmt_quality_preset: String,
    /// Explicit HuggingFace model id override. Required when
    /// `nmt_quality_preset = "custom"`; honored over the preset
    /// otherwise.
    #[serde(default)]
    pub nmt_model_id: Option<String>,
    /// Beam-search width. 1 = greedy (fastest, worst); 5-8 = high
    /// quality. `None` defers to the preset's pick.
    #[serde(default)]
    pub nmt_num_beams: Option<u32>,

    // ----- NMT hardware knobs -----
    /// "cpu", "cuda", "cuda:N". CPU is the safe default to avoid
    /// contending with the TTS GPU.
    #[serde(default = "default_nmt_device")]
    pub nmt_device: String,
    /// "auto" / "fp32" / "fp16" / "bf16". `auto` picks fp16 on GPU,
    /// fp32 on CPU (CPU fp16 is slower than fp32 on most x86 chips).
    #[serde(default = "default_nmt_precision")]
    pub nmt_precision: String,

    // ----- NMT language pair -----
    /// Source language ISO-2 (e.g. "en"). NLLB accepts flores-200
    /// codes too ("eng_Latn"); both are handled.
    #[serde(default = "default_src_lang")]
    pub nmt_src_lang: String,
    /// Target language ISO-2 (e.g. "ja").
    #[serde(default = "default_tgt_lang")]
    pub nmt_tgt_lang: String,

    // ----- NMT sidecar process lifecycle -----
    /// Command that launches the NMT sidecar. Used by
    /// [`TranslatorManager`] when `backend = "http"` and
    /// `auto_start = true`. Empty / unset means "the user starts it
    /// themselves; just connect to `url`".
    #[serde(default = "default_nmt_launch_command")]
    pub nmt_launch_command: String,
    /// Spawn the NMT sidecar at companion startup. Off by default so
    /// users who pre-launch their own translator server don't get a
    /// duplicate.
    #[serde(default)]
    pub nmt_auto_start: bool,
    /// Send `/shutdown` to the NMT sidecar when the companion exits.
    /// On by default — leaving the model loaded keeps RAM pinned and
    /// (on GPU) blocks other workloads.
    #[serde(default = "default_true")]
    pub nmt_close_with_companion: bool,
    /// Port the NMT sidecar binds. Default 9881 matches the wrapper's
    /// own default. Forwarded as `NMT_PORT`.
    #[serde(default = "default_nmt_port")]
    pub nmt_port: u16,
}

fn default_http_url() -> String {
    "http://127.0.0.1:9881".to_string()
}
fn default_http_timeout() -> u64 {
    8
}
fn default_quality_preset() -> String {
    "balanced".to_string()
}
fn default_nmt_device() -> String {
    "cpu".to_string()
}
fn default_nmt_precision() -> String {
    "auto".to_string()
}
fn default_src_lang() -> String {
    "en".to_string()
}
fn default_tgt_lang() -> String {
    "ja".to_string()
}
fn default_nmt_launch_command() -> String {
    "python tools/avatar/nmt_translator_server.py".to_string()
}
fn default_nmt_port() -> u16 {
    9881
}
fn default_true() -> bool {
    true
}

impl TranslatorConfig {
    /// Env vars to forward to the NMT sidecar at spawn time. Matches
    /// the keys read by `tools/avatar/nmt_engine.py::TranslatorConfig.from_env`.
    pub fn nmt_env(&self) -> Vec<(&'static str, String)> {
        let mut env: Vec<(&'static str, String)> = vec![
            ("NMT_QUALITY_PRESET", self.nmt_quality_preset.clone()),
            ("NMT_DEVICE", self.nmt_device.clone()),
            ("NMT_PRECISION", self.nmt_precision.clone()),
            ("NMT_SRC_LANG", self.nmt_src_lang.clone()),
            ("NMT_TGT_LANG", self.nmt_tgt_lang.clone()),
        ];
        if let Some(ref m) = self.nmt_model_id {
            env.push(("NMT_MODEL_ID", m.clone()));
        }
        if let Some(beams) = self.nmt_num_beams {
            env.push(("NMT_NUM_BEAMS", beams.to_string()));
        }
        env
    }
}

// ---------------------------------------------------------------------------
// LLM translator
// ---------------------------------------------------------------------------

/// Translator that prompts the subagent's LLM. Preserves the existing
/// streaming-token surface when the backend is a direct `LlmClient`.
pub struct LlmTranslator {
    backend: Arc<dyn SubagentBackend>,
    /// `Some(client)` iff the backend is a direct `LlmClient` — only
    /// that path exposes per-token streaming via `chat_stream`. The
    /// webhook backend (zeroclaw `/webhook`) is single-shot.
    stream_client: Option<Arc<LlmClient>>,
    timeout: Duration,
}

impl LlmTranslator {
    pub fn new(
        backend: Arc<dyn SubagentBackend>,
        stream_client: Option<Arc<LlmClient>>,
        timeout: Duration,
    ) -> Self {
        Self {
            backend,
            stream_client,
            timeout,
        }
    }

    fn build_prompt(text: &str, target_language: &str) -> String {
        format!(
            "Translate the following text into {target_language}. \
             Output ONLY the translation — no preamble, no quotation marks, \
             no markdown decoration, no explanation. Preserve sentence \
             count. If the text is already in {target_language}, return it \
             unchanged.\n\nText:\n{text}",
        )
    }

    fn clean(out: &str) -> String {
        // The LLM sometimes wraps output in ```...```. Strip those.
        out.trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string()
    }
}

#[async_trait]
impl Translator for LlmTranslator {
    async fn translate(
        &self,
        text: &str,
        _source_language: Option<&str>,
        target_language: &str,
    ) -> Option<String> {
        // The LLM doesn't need an explicit source — the prompt text
        // self-evidently identifies the source language. We accept the
        // parameter so the trait stays uniform across backends.
        let prompt = Self::build_prompt(text, target_language);
        // Cap per-attempt to 30 s — translate calls are ~1-5 s typically;
        // anything past 30 s means the upstream LLM is wedged.
        let attempt_budget = std::cmp::min(self.timeout, Duration::from_secs(30));
        for attempt in 1..=3 {
            let started = std::time::Instant::now();
            let result = tokio::time::timeout(attempt_budget, self.backend.ask("", &prompt)).await;
            match result {
                Ok(Ok(out)) => {
                    let cleaned = Self::clean(&out);
                    if cleaned.is_empty() {
                        tracing::warn!("llm translator: empty response (attempt {attempt})");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                    tracing::info!(
                        "llm translator: {}c → {}c in {}ms (attempt {attempt})",
                        text.chars().count(),
                        cleaned.chars().count(),
                        started.elapsed().as_millis(),
                    );
                    return Some(cleaned);
                }
                Ok(Err(e)) => {
                    let msg = e.to_string();
                    let is_rate_limit = msg.contains("429") || msg.contains("Rate limit");
                    tracing::warn!("llm translator: backend failed (attempt {attempt}): {e}");
                    if attempt < 3 {
                        let wait = if is_rate_limit { 1u64 << attempt } else { 1 };
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                    }
                }
                Err(_) => {
                    tracing::warn!(
                        "llm translator: timeout (attempt {attempt}) after {}s",
                        attempt_budget.as_secs()
                    );
                    if attempt < 3 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
        None
    }

    async fn translate_stream(
        &self,
        text: &str,
        source_language: Option<&str>,
        target_language: &str,
        mut on_chunk: ChunkCallback,
    ) -> Option<String> {
        let Some(ref client) = self.stream_client else {
            // Webhook / non-streaming backend — degrade to one-shot.
            tracing::debug!("llm translator: backend has no streaming surface; one-shot fallback");
            let out = self.translate(text, source_language, target_language).await;
            if let Some(ref t) = out {
                on_chunk(t);
            }
            return out;
        };
        let prompt = Self::build_prompt(text, target_language);
        use companion_core::llm::{ChatMessage, Role};
        let messages = vec![
            ChatMessage {
                role: Role::System,
                content: String::new(),
            },
            ChatMessage {
                role: Role::User,
                content: prompt,
            },
        ];
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            std::cmp::min(self.timeout, Duration::from_secs(60)),
            client.chat_stream(&messages, move |delta| on_chunk(delta)),
        )
        .await;
        match result {
            Ok(Ok(full)) => {
                let cleaned = Self::clean(&full);
                tracing::info!(
                    "llm translator (stream): {}c in {}ms",
                    cleaned.chars().count(),
                    started.elapsed().as_millis(),
                );
                if cleaned.is_empty() {
                    None
                } else {
                    Some(cleaned)
                }
            }
            Ok(Err(e)) => {
                tracing::warn!("llm translator (stream): backend failed: {e}");
                None
            }
            Err(_) => {
                tracing::warn!(
                    "llm translator (stream): timeout after {}s",
                    self.timeout.as_secs()
                );
                None
            }
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP (NMT sidecar) translator
// ---------------------------------------------------------------------------

/// Translator that calls the NMT sidecar via localhost HTTP.
///
/// Wire contract (see `tools/avatar/nmt_translator_server.py`):
///
/// ```text
/// POST {url}/translate  {"text": "...", "src_lang": "...", "tgt_lang": "..."}
///                   ->  {"text": "<translated>", "src_lang": "...", "tgt_lang": "..."}
/// ```
pub struct HttpTranslator {
    client: reqwest::Client,
    url: String,
}

impl HttpTranslator {
    pub fn new(base_url: &str, timeout: Duration) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| anyhow::anyhow!("HttpTranslator client build failed: {e}"))?;
        let url = format!("{}/translate", base_url.trim_end_matches('/'));
        Ok(Self { client, url })
    }
}

#[derive(Serialize)]
struct TranslateRequest<'a> {
    text: &'a str,
    tgt_lang: &'a str,
    /// Optional source-language override. Sent only when the caller
    /// (avatar process_speak) knows what the agent's reply is in —
    /// NLLB uses it to pick the right tokenizer vocabulary, which is
    /// the difference between a clean translation and tokenizer
    /// garbage when the user chats in a language the engine wasn't
    /// pinned to at startup.
    #[serde(skip_serializing_if = "Option::is_none")]
    src_lang: Option<&'a str>,
}

#[derive(Deserialize)]
struct TranslateResponse {
    text: String,
}

#[async_trait]
impl Translator for HttpTranslator {
    async fn translate(
        &self,
        text: &str,
        source_language: Option<&str>,
        target_language: &str,
    ) -> Option<String> {
        if text.trim().is_empty() {
            return None;
        }
        let started = std::time::Instant::now();
        let resp = self
            .client
            .post(&self.url)
            .json(&TranslateRequest {
                text,
                tgt_lang: target_language,
                src_lang: source_language,
            })
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => match r.json::<TranslateResponse>().await {
                Ok(body) => {
                    let cleaned = body.text.trim().to_string();
                    if cleaned.is_empty() {
                        tracing::warn!("http translator: empty response");
                        return None;
                    }
                    tracing::info!(
                        "http translator: {}c → {}c in {}ms",
                        text.chars().count(),
                        cleaned.chars().count(),
                        started.elapsed().as_millis(),
                    );
                    Some(cleaned)
                }
                Err(e) => {
                    tracing::warn!("http translator: response parse failed: {e}");
                    None
                }
            },
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                tracing::warn!("http translator: status {} body={:.200}", status, body,);
                None
            }
            Err(e) => {
                tracing::warn!("http translator: request failed: {e}");
                None
            }
        }
    }

    async fn translate_stream(
        &self,
        text: &str,
        source_language: Option<&str>,
        target_language: &str,
        mut on_chunk: ChunkCallback,
    ) -> Option<String> {
        // HTTP/NMT is non-streaming: fire the callback once with the
        // full result. At ~100-300 ms total the user can't perceive the
        // missing per-token incrementality.
        let result = self.translate(text, source_language, target_language).await;
        if let Some(ref t) = result {
            on_chunk(t);
        }
        result
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/// Build the translator instance the subagent should use.
///
/// `llm_backend` + `stream_client` + `llm_timeout` are forwarded into
/// the LLM path; ignored when `config.backend == Http`.
pub fn build_translator(
    config: &TranslatorConfig,
    llm_backend: Arc<dyn SubagentBackend>,
    stream_client: Option<Arc<LlmClient>>,
    llm_timeout: Duration,
) -> Result<Arc<dyn Translator>> {
    match config.backend {
        TranslatorBackendKind::Llm => Ok(Arc::new(LlmTranslator::new(
            llm_backend,
            stream_client,
            llm_timeout,
        ))),
        TranslatorBackendKind::Http => {
            let http =
                HttpTranslator::new(&config.url, Duration::from_secs(config.http_timeout_secs))?;
            Ok(Arc::new(http))
        }
    }
}

// ---------------------------------------------------------------------------
// Sidecar subprocess manager (HTTP backend only)
// ---------------------------------------------------------------------------

/// Subprocess lifecycle for the NMT translator sidecar.
///
/// Mirrors `tts_server::AnimeTtsManager`: spawns the configured launch
/// command (or adopts an already-running server at the configured
/// port), polls `/health` until it returns 200, and sends `POST
/// /shutdown` on close (falling back to `kill` after a grace window).
///
/// The companion runs ONE instance per session; hot-swaps go through
/// `stop_server` + new manager construction (same pattern as TTS).
pub struct TranslatorManager {
    /// Engine label for logging.
    label: String,
    /// API base URL.
    api_url: String,
    /// Port the sidecar listens on.
    port: u16,
    /// Spawned subprocess (None when externally managed or not yet started).
    child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
    /// HTTP client for health / shutdown calls.
    client: reqwest::Client,
    /// Snapshot of the spawn-time config so we can recompute env / cmd
    /// on restart without the caller passing it again.
    config: TranslatorConfig,
}

/// Maximum wait for `/health` to come up after spawn. NLLB-1.3B cold-loads
/// in ~30-60 s on first-run download; 300 s leaves headroom.
const NMT_HEALTH_TIMEOUT: Duration = Duration::from_secs(300);
/// Poll interval while waiting for `/health`.
const NMT_HEALTH_INTERVAL: Duration = Duration::from_secs(2);
/// How long `stop_server` waits for graceful exit before killing.
const NMT_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(8);

impl TranslatorManager {
    pub fn new(config: &TranslatorConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.http_timeout_secs))
            .build()
            .map_err(|e| anyhow::anyhow!("TranslatorManager client build failed: {e}"))?;
        let api_url = config.url.trim_end_matches('/').to_string();
        Ok(Self {
            label: format!("nmt-{}", config.nmt_quality_preset),
            api_url,
            port: config.nmt_port,
            child: Arc::new(tokio::sync::Mutex::new(None)),
            client,
            config: config.clone(),
        })
    }

    /// `True` when the manager will actually spawn a subprocess on
    /// `start_server`. False when the user has set
    /// `nmt_launch_command = ""` (i.e., they manage the sidecar).
    pub fn will_spawn(&self) -> bool {
        !self.config.nmt_launch_command.trim().is_empty()
    }

    /// Snapshot of the config the manager was built with. Used by the
    /// hot-swap path in `handle_post_subagent_override` to decide
    /// whether engine-init fields changed (and thus a sidecar respawn
    /// is required) vs. whether only request-time fields like
    /// `nmt_src_lang` changed (which need no restart).
    pub fn config_snapshot(&self) -> &TranslatorConfig {
        &self.config
    }

    /// Start the sidecar subprocess and wait for `/health`. If the
    /// configured port already has a healthy server, adopt it instead
    /// of launching a duplicate.
    pub async fn start_server(&self) -> Result<()> {
        // 1) Adopt-or-spawn decision: probe /health first.
        if self.probe_health().await {
            tracing::info!(
                "translator: adopting already-running NMT server at {} (skipping launch)",
                self.api_url,
            );
            return Ok(());
        }

        if !self.will_spawn() {
            // No launch command — caller is responsible. We still wait
            // for /health so callers get a clean signal when the
            // sidecar is reachable.
            tracing::info!(
                "translator: no launch_command, assuming external NMT at {}",
                self.api_url,
            );
            self.wait_for_health().await?;
            return Ok(());
        }

        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            tracing::warn!("translator: NMT sidecar already running (this process)");
            return Ok(());
        }

        let cmd_str = self.config.nmt_launch_command.clone();
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(&cmd_str);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg(&cmd_str);
            c
        };

        // Forward the user's chosen knobs as env vars. Matches what
        // `tools/avatar/nmt_engine.py::TranslatorConfig.from_env` reads.
        for (k, v) in self.config.nmt_env() {
            cmd.env(k, v);
        }
        cmd.env("NMT_PORT", self.port.to_string());

        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("translator: spawn failed for {cmd_str:?}: {e}"))?;

        // Tee stdout / stderr into our tracing log. Without this,
        // Tauri sidecar mode discards the child's pipes and crashes
        // are invisible.
        let label = self.label.clone();
        if let Some(stdout) = child.stdout.take() {
            let lbl = label.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[{lbl}-stdout] {line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let lbl = label.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[{lbl}-stderr] {line}");
                }
            });
        }
        *child_guard = Some(child);
        drop(child_guard);

        tracing::info!(
            "translator: spawned {} on port {} (waiting for /health up to {}s)",
            self.label,
            self.port,
            NMT_HEALTH_TIMEOUT.as_secs(),
        );
        self.wait_for_health().await?;
        Ok(())
    }

    /// Graceful shutdown — POST `/shutdown`, then verify the sidecar
    /// actually exited (by polling `/health` until it stops responding).
    /// Hard-kills if we own the child handle and `/shutdown` didn't take.
    ///
    /// **Why the health poll matters**: `start_server` will *adopt* an
    /// already-running sidecar by skipping the spawn when `/health` is
    /// 200 — in that case `self.child` is None and we never get a kill
    /// fallback. Before the health poll was added, this path simply
    /// trusted the Python `/shutdown` endpoint to commit suicide and
    /// returned Ok regardless. If `/shutdown` failed silently or the
    /// Python process was wedged, the NMT subprocess would leak across
    /// every companion-server lifecycle. Now we wait for `/health` to
    /// actually drop before declaring success.
    pub async fn stop_server(&self) -> Result<()> {
        let url = format!("{}/shutdown", self.api_url);
        if let Ok(c) = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            match c.post(&url).send().await {
                Ok(_) => tracing::info!("translator: NMT /shutdown requested"),
                Err(e) => tracing::debug!(
                    "translator: NMT /shutdown not delivered ({e}); falling through"
                ),
            }
        }

        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            match tokio::time::timeout(NMT_GRACEFUL_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => {
                    tracing::info!("translator: NMT exited gracefully (status={status})");
                }
                Ok(Err(e)) => {
                    tracing::warn!("translator: NMT wait failed ({e}); attempting kill");
                    let _ = child.kill().await;
                }
                Err(_) => {
                    tracing::warn!(
                        "translator: NMT did not exit within {}s — hard-killing",
                        NMT_GRACEFUL_TIMEOUT.as_secs(),
                    );
                    child.kill().await.map_err(|e| {
                        anyhow::anyhow!("translator: failed to kill NMT subprocess: {e}")
                    })?;
                }
            }
            tracing::info!("translator: stopped NMT sidecar");
        } else {
            // Adopted-sidecar case: we never owned the OS process so we
            // can't `child.kill()`. Verify the Python /shutdown daemon
            // thread actually closed the socket; if it didn't, the user
            // gets a clear warning instead of a silent leak.
            let deadline = std::time::Instant::now() + NMT_GRACEFUL_TIMEOUT;
            loop {
                if !self.probe_health().await {
                    tracing::info!("translator: adopted NMT shut down cleanly");
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    tracing::warn!(
                        "translator: adopted NMT at {} still responding after \
                         {}s — process leaked. Stop it manually (e.g. POST \
                         /shutdown again, or kill by port).",
                        self.api_url,
                        NMT_GRACEFUL_TIMEOUT.as_secs(),
                    );
                    break;
                }
                tokio::time::sleep(NMT_HEALTH_INTERVAL).await;
            }
        }
        *child_guard = None;
        Ok(())
    }

    /// One quick `/health` GET with a short timeout — used at startup
    /// to detect a still-warm sidecar left by a prior companion run.
    async fn probe_health(&self) -> bool {
        let url = format!("{}/health", self.api_url);
        match self
            .client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }

    async fn wait_for_health(&self) -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            if self.probe_health().await {
                tracing::info!("translator: NMT sidecar is healthy");
                return Ok(());
            }
            if start.elapsed() > NMT_HEALTH_TIMEOUT {
                anyhow::bail!(
                    "translator: NMT sidecar did not become healthy within {}s",
                    NMT_HEALTH_TIMEOUT.as_secs(),
                );
            }
            tokio::time::sleep(NMT_HEALTH_INTERVAL).await;
        }
    }
}
