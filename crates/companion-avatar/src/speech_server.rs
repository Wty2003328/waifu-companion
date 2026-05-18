//! Speech (STT) sidecar lifecycle + proxy client.
//!
//! Symmetric with [`crate::tts_server::AnimeTtsManager`] and
//! [`crate::translator::TranslatorManager`]:
//!
//! - `start_server` adopts an already-running `/health` on the configured
//!   port, or spawns `launch_command` if not.
//! - `stop_server` POSTs `/shutdown`, waits for `/health` to drop, hard-
//!   kills the owned child as a fallback.
//! - The companion holds an `ArcSwapOption<SpeechManager>` so settings
//!   changes hot-swap without restart.
//!
//! Wire contract (mirrors the existing sidecars):
//!
//! ```text
//! GET  /health    -> 200 OK when ready
//! POST /asr       {"audio": <base64-wav>, "language"?, "prompt"?}
//!                 -> {"text", "language", "duration", "wall_ms", "segments"}
//! POST /shutdown  -> graceful exit
//! ```
//!
//! See `tools/avatar/speech_sidecar.py` for the Python side.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::config::AvatarSpeechConfig;

/// Maximum wait for `/health` to come up after spawn. Whisper-small loads
/// in ~1-2 s on warm cache, ~15 s cold (first install pulls the model
/// from HF). 180 s gives the cold path headroom without making real
/// failures take forever to surface.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);
/// Poll interval while waiting for `/health`.
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);
/// How long `stop_server` waits for graceful exit before hard-killing.
const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(8);

/// `POST /asr` request body. The audio is base64-encoded WAV / PCM —
/// faster-whisper handles resampling on the Python side, so callers
/// don't need to know the target sample rate.
#[derive(Debug, Clone, Serialize)]
pub struct AsrRequest {
    pub audio: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// Per-segment timing surfaced for callers that want word-aligned UI
/// updates (e.g. partial-decode display). The frontend currently uses
/// only `AsrResponse::text`; the segments arrive over the wire anyway,
/// so we deserialize them for forward-compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// `POST /asr` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrResponse {
    pub text: String,
    pub language: String,
    pub duration: f64,
    #[serde(default)]
    pub wall_ms: f64,
    #[serde(default)]
    pub segments: Vec<AsrSegment>,
}

/// Owns the sidecar subprocess + an HTTP client for `/asr` calls.
pub struct SpeechManager {
    label: String,
    api_url: String,
    port: u16,
    child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
    client: reqwest::Client,
    config: AvatarSpeechConfig,
}

impl SpeechManager {
    pub fn new(config: &AvatarSpeechConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.http_timeout_secs))
            .build()
            .map_err(|e| anyhow!("SpeechManager client build failed: {e}"))?;
        let api_url = config.resolved_api_url().trim_end_matches('/').to_string();
        Ok(Self {
            label: format!("speech-{}", config.model_size),
            api_url,
            port: config.port,
            child: Arc::new(tokio::sync::Mutex::new(None)),
            client,
            config: config.clone(),
        })
    }

    /// Resolved base URL — `http://127.0.0.1:{port}` unless overridden.
    pub fn api_url(&self) -> &str {
        &self.api_url
    }

    /// Snapshot of the config the manager was built with.
    pub fn config_snapshot(&self) -> &AvatarSpeechConfig {
        &self.config
    }

    /// `True` when the manager will actually spawn a subprocess.
    pub fn will_spawn(&self) -> bool {
        !self.config.launch_command.trim().is_empty()
    }

    /// POST `/asr` and return the transcript. Bubbles up underlying
    /// HTTP / parse errors; callers map to user-facing error states.
    pub async fn transcribe(&self, req: &AsrRequest) -> Result<AsrResponse> {
        let url = format!("{}/asr", self.api_url);
        let resp = self
            .client
            .post(&url)
            .json(req)
            .send()
            .await
            .map_err(|e| anyhow!("speech: /asr request failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("speech: /asr returned {} — {body}", status));
        }
        let body: AsrResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("speech: /asr response parse failed: {e}"))?;
        Ok(body)
    }

    /// `GET /health` with a short timeout — used at startup and by the
    /// watchdog.
    pub async fn probe_health(&self) -> bool {
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

    /// Spawn the sidecar (or adopt a running one) and wait for `/health`.
    pub async fn start_server(&self) -> Result<()> {
        if self.probe_health().await {
            tracing::info!(
                "speech: adopting already-running sidecar at {} (skipping launch)",
                self.api_url,
            );
            return Ok(());
        }

        if !self.will_spawn() {
            tracing::info!(
                "speech: no launch_command, assuming external sidecar at {}",
                self.api_url,
            );
            self.wait_for_health().await?;
            return Ok(());
        }

        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            tracing::warn!("speech: sidecar already running (this process)");
            return Ok(());
        }

        let cmd_str = self.config.launch_command.clone();
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(&cmd_str);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg(&cmd_str);
            c
        };
        for (k, v) in self.config.spawn_env() {
            cmd.env(k, v);
        }

        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("speech: spawn failed for {cmd_str:?}: {e}"))?;

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
            "speech: spawned {} on port {} (waiting for /health up to {}s)",
            self.label,
            self.port,
            HEALTH_TIMEOUT.as_secs(),
        );
        self.wait_for_health().await?;
        Ok(())
    }

    /// Graceful shutdown — POST `/shutdown`, verify `/health` drops,
    /// hard-kill the owned child on timeout. Adopted (we-don't-own-the-
    /// process) case polls `/health` and warns loudly if it never drops.
    pub async fn stop_server(&self) -> Result<()> {
        let url = format!("{}/shutdown", self.api_url);
        if let Ok(c) = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            match c.post(&url).send().await {
                Ok(_) => tracing::info!("speech: /shutdown requested"),
                Err(e) => tracing::debug!(
                    "speech: /shutdown not delivered ({e}); falling through"
                ),
            }
        }

        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            match tokio::time::timeout(GRACEFUL_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => {
                    tracing::info!("speech: sidecar exited gracefully (status={status})");
                }
                Ok(Err(e)) => {
                    tracing::warn!("speech: wait failed ({e}); attempting kill");
                    let _ = child.kill().await;
                }
                Err(_) => {
                    tracing::warn!(
                        "speech: sidecar did not exit within {}s — hard-killing",
                        GRACEFUL_TIMEOUT.as_secs(),
                    );
                    child
                        .kill()
                        .await
                        .map_err(|e| anyhow!("speech: failed to kill sidecar: {e}"))?;
                }
            }
            tracing::info!("speech: stopped sidecar");
        } else {
            let deadline = std::time::Instant::now() + GRACEFUL_TIMEOUT;
            loop {
                if !self.probe_health().await {
                    tracing::info!("speech: adopted sidecar shut down cleanly");
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    tracing::warn!(
                        "speech: adopted sidecar at {} still responding after {}s — \
                         process leaked. Stop it manually.",
                        self.api_url,
                        GRACEFUL_TIMEOUT.as_secs(),
                    );
                    break;
                }
                tokio::time::sleep(HEALTH_INTERVAL).await;
            }
        }
        *child_guard = None;
        Ok(())
    }

    async fn wait_for_health(&self) -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            if self.probe_health().await {
                tracing::info!("speech: sidecar is healthy");
                return Ok(());
            }
            if start.elapsed() > HEALTH_TIMEOUT {
                anyhow::bail!(
                    "speech: sidecar did not become healthy within {}s",
                    HEALTH_TIMEOUT.as_secs(),
                );
            }
            tokio::time::sleep(HEALTH_INTERVAL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AvatarSpeechConfig {
        AvatarSpeechConfig {
            enabled: true,
            port: 9882,
            api_url: None,
            model_size: "small".into(),
            device: String::new(),
            compute_type: String::new(),
            default_language: String::new(),
            launch_command: String::new(),
            auto_start: false,
            close_with_companion: true,
            warmup: true,
            http_timeout_secs: 30,
            verify_tts: true,
        }
    }

    #[test]
    fn manager_creation() {
        let cfg = test_config();
        let mgr = SpeechManager::new(&cfg).unwrap();
        assert_eq!(mgr.port, 9882);
        assert_eq!(mgr.api_url(), "http://127.0.0.1:9882");
    }

    #[test]
    fn will_spawn_respects_empty_launch_cmd() {
        let mut cfg = test_config();
        cfg.launch_command = String::new();
        let mgr = SpeechManager::new(&cfg).unwrap();
        assert!(!mgr.will_spawn());
        cfg.launch_command = "python -m foo".into();
        let mgr2 = SpeechManager::new(&cfg).unwrap();
        assert!(mgr2.will_spawn());
    }

    #[test]
    fn spawn_env_includes_expected_keys() {
        let mut cfg = test_config();
        cfg.device = "cuda".into();
        cfg.compute_type = "float16".into();
        cfg.default_language = "ja".into();
        let env: std::collections::HashMap<_, _> =
            cfg.spawn_env().into_iter().collect();
        assert_eq!(env.get("SPEECH_PORT").map(String::as_str), Some("9882"));
        assert_eq!(env.get("SPEECH_MODEL_SIZE").map(String::as_str), Some("small"));
        assert_eq!(env.get("SPEECH_WARMUP").map(String::as_str), Some("1"));
        assert_eq!(env.get("SPEECH_DEVICE").map(String::as_str), Some("cuda"));
        assert_eq!(env.get("SPEECH_COMPUTE_TYPE").map(String::as_str), Some("float16"));
        assert_eq!(env.get("SPEECH_DEFAULT_LANG").map(String::as_str), Some("ja"));
    }

    #[test]
    fn spawn_env_omits_unset_optionals() {
        let cfg = test_config();
        let env: std::collections::HashMap<_, _> =
            cfg.spawn_env().into_iter().collect();
        assert!(!env.contains_key("SPEECH_DEVICE"));
        assert!(!env.contains_key("SPEECH_COMPUTE_TYPE"));
        assert!(!env.contains_key("SPEECH_DEFAULT_LANG"));
    }

    #[test]
    fn warmup_flag_is_forwarded() {
        let mut cfg = test_config();
        cfg.warmup = false;
        let env: std::collections::HashMap<_, _> =
            cfg.spawn_env().into_iter().collect();
        assert_eq!(env.get("SPEECH_WARMUP").map(String::as_str), Some("0"));
    }
}
