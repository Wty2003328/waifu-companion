//! Generic, model-agnostic TTS port.
//!
//! ZeroClaw speaks a single HTTP contract to any TTS server. The wire
//! protocol is identical regardless of the backing model — GPT-SoVITS,
//! Fish-Speech, MeloTTS, XTTS, F5-TTS, edge-tts, or anything else.
//! Users plug in a new model by writing a thin Python (or Rust, Go, …)
//! wrapper that conforms to this contract and pointing
//! `[avatar.tts] launch_command = "..."` at it.
//!
//! # Wire contract
//!
//! ```text
//! POST {api_url}/tts            Content-Type: application/json
//!     {
//!       "text":     "<utterance>",
//!       "language": "<bcp47-ish, e.g. ja>",
//!       "voice":    "<id>",          // optional
//!       "speed":    1.0              // optional, default 1.0
//!     }
//! → 200 OK
//!     body:    raw audio bytes
//!     headers: X-Sample-Rate (default 24000)
//!              X-Channels    (default 1)
//!              X-Format      (default "wav" — "wav"|"mp3"|"pcm")
//!
//! GET {api_url}/health
//! → 200 OK when ready (body ignored)
//! ```
//!
//! # Lifecycle
//!
//! 1. `start_server()` — spawn `launch_command` (if set), wait for `/health`.
//! 2. `synthesize()`   — POST `/tts`, return [`AudioOutput`].
//! 3. `stop_server()`  — kill the spawned subprocess.
//!
//! Engine-specific knobs (`model_path`, `reference_audio`, …) are forwarded
//! to the spawned wrapper as environment variables; the Rust side never
//! branches on engine identity.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::AvatarTtsConfig;

/// HTTP timeout for TTS synthesis requests.
const TTS_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Maximum time to wait for TTS server to become healthy after start.
const HEALTH_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Interval between health check polls during startup.
const HEALTH_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Output from anime TTS synthesis.
#[derive(Debug, Clone)]
pub struct AudioOutput {
    /// Raw audio bytes.
    pub audio_bytes: Vec<u8>,
    /// Sample rate in Hz.
    pub sample_rate: u32,
    /// Number of audio channels.
    pub channels: u16,
    /// Audio format ("wav", "mp3", "pcm").
    pub format: String,
}

/// Manages a TTS server subprocess and speaks the generic `/tts` contract.
pub struct AnimeTtsManager {
    /// Engine label (informational only).
    engine: String,
    /// API base URL for the TTS server.
    api_url: String,
    /// Port the TTS server listens on.
    port: u16,
    /// Voice/character identifier sent to the server in the request body.
    voice: Option<String>,
    /// Default speech language. Per-call override via `synthesize_with`.
    default_language: String,
    /// Speech speed multiplier.
    speed: f32,
    /// Reference audio path (forwarded to subprocess via env).
    reference_audio: Option<String>,
    /// Reference transcript matching `reference_audio`.
    reference_text: Option<String>,
    /// Reference language.
    reference_language: Option<String>,
    /// GPU device index (-1 for CPU).
    gpu_device: i32,
    /// Custom launch command (if None, server is assumed externally managed).
    launch_command: Option<String>,
    /// Model path forwarded to subprocess via env.
    model_path: Option<String>,
    /// The managed subprocess (if running).
    child: Arc<Mutex<Option<Child>>>,
    /// HTTP client for API calls.
    client: reqwest::Client,
}

impl AnimeTtsManager {
    /// Build from config. Does not start the server.
    pub fn new(config: &AvatarTtsConfig) -> Result<Self> {
        let port = if config.port > 0 { config.port } else { 9880 };
        let api_url = config
            .api_url
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));

        Ok(Self {
            engine: config.engine.clone(),
            api_url,
            port,
            voice: config.voice.clone(),
            default_language: config.language.clone(),
            speed: config.speed,
            reference_audio: config.reference_audio.clone(),
            reference_text: config.reference_text.clone(),
            reference_language: config.reference_language.clone(),
            gpu_device: config.gpu_device,
            launch_command: config.launch_command.clone(),
            model_path: config.model_path.clone(),
            child: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .timeout(TTS_REQUEST_TIMEOUT)
                .build()
                .context("Failed to build HTTP client for anime TTS")?,
        })
    }

    /// Engine label (informational).
    pub fn engine(&self) -> &str {
        &self.engine
    }

    /// Default speech language configured for this manager.
    pub fn default_language(&self) -> &str {
        &self.default_language
    }

    /// Start the TTS server subprocess.
    ///
    /// If `launch_command` is unset, assumes the server is already running
    /// externally and just polls `/health`.
    pub async fn start_server(&self) -> Result<()> {
        if self.launch_command.is_none() {
            tracing::info!(
                "avatar: no launch_command for engine={}, assuming external server at {}",
                self.engine,
                self.api_url,
            );
            self.wait_for_health().await?;
            return Ok(());
        }

        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            tracing::warn!("avatar: TTS server already running");
            return Ok(());
        }

        let command_str = self.launch_command.as_ref().unwrap();
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(command_str);
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c").arg(command_str);
            c
        };

        // Forward engine-specific knobs to the wrapper via env vars. The
        // Rust side never branches on engine identity; the wrapper reads
        // whatever it needs.
        if self.gpu_device >= 0 {
            cmd.env("CUDA_VISIBLE_DEVICES", self.gpu_device.to_string());
        }
        cmd.env("TTS_PORT", self.port.to_string());
        cmd.env("TTS_ENGINE", &self.engine);
        cmd.env("TTS_LANGUAGE", &self.default_language);
        if let Some(ref model_path) = self.model_path {
            cmd.env("TTS_MODEL_PATH", model_path);
        }
        if let Some(ref ref_audio) = self.reference_audio {
            cmd.env("TTS_REFERENCE_AUDIO", ref_audio);
        }
        if let Some(ref ref_text) = self.reference_text {
            cmd.env("TTS_REFERENCE_TEXT", ref_text);
        }
        if let Some(ref ref_lang) = self.reference_language {
            cmd.env("TTS_REFERENCE_LANG", ref_lang);
        }
        if let Some(ref voice) = self.voice {
            cmd.env("TTS_VOICE", voice);
        }

        let child = cmd
            .spawn()
            .context("Failed to spawn TTS server subprocess")?;
        *child_guard = Some(child);
        drop(child_guard);

        tracing::info!(
            "avatar: started engine={} TTS server on port {}",
            self.engine,
            self.port,
        );
        self.wait_for_health().await?;
        Ok(())
    }

    /// Stop the TTS server subprocess.
    pub async fn stop_server(&self) -> Result<()> {
        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            child.kill().await.context("Failed to kill TTS server")?;
            tracing::info!("avatar: stopped TTS server");
        }
        *child_guard = None;
        Ok(())
    }

    /// Synthesize text using the manager's default language.
    pub async fn synthesize(&self, text: &str) -> Result<AudioOutput> {
        self.synthesize_with(text, &self.default_language).await
    }

    /// Synthesize text in an explicit language (overrides config default).
    pub async fn synthesize_with(&self, text: &str, language: &str) -> Result<AudioOutput> {
        if text.is_empty() {
            bail!("TTS text must not be empty");
        }

        let url = format!("{}/tts", self.api_url);
        let mut body = serde_json::json!({
            "text": text,
            "language": language,
            "speed": self.speed,
        });
        if let Some(ref voice) = self.voice {
            body["voice"] = serde_json::json!(voice);
        }

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("Failed to send TTS request")?;

        let status = resp.status();
        if !status.is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            bail!("TTS API error ({}): {}", status, err_text);
        }

        // Optional metadata headers — fall back to sensible defaults.
        let sample_rate = resp
            .headers()
            .get("x-sample-rate")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(24_000);
        let channels = resp
            .headers()
            .get("x-channels")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(1);
        let format = resp
            .headers()
            .get("x-format")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_ascii_lowercase())
            .or_else(|| {
                resp.headers()
                    .get("content-type")
                    .and_then(|h| h.to_str().ok())
                    .map(|ct| {
                        if ct.contains("mpeg") || ct.contains("mp3") {
                            "mp3".to_string()
                        } else if ct.contains("pcm") {
                            "pcm".to_string()
                        } else {
                            "wav".to_string()
                        }
                    })
            })
            .unwrap_or_else(|| "wav".to_string());

        let bytes = resp.bytes().await.context("Failed to read TTS response")?;

        Ok(AudioOutput {
            audio_bytes: bytes.to_vec(),
            sample_rate,
            channels,
            format,
        })
    }

    /// Check if the TTS server is healthy.
    pub async fn health_check(&self) -> Result<bool> {
        let url = format!("{}/health", self.api_url);
        match self.client.get(&url).send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    /// Wait for the TTS server to become healthy.
    async fn wait_for_health(&self) -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            if self.health_check().await.unwrap_or(false) {
                tracing::info!("avatar: TTS server is healthy");
                return Ok(());
            }
            if start.elapsed() > HEALTH_CHECK_TIMEOUT {
                bail!(
                    "avatar: TTS server did not become healthy within {}s",
                    HEALTH_CHECK_TIMEOUT.as_secs()
                );
            }
            tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
            tracing::debug!("avatar: waiting for TTS server...");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AvatarTtsConfig;

    fn test_config() -> AvatarTtsConfig {
        AvatarTtsConfig {
            engine: "edge-tts".to_string(),
            api_url: Some("http://127.0.0.1:9880".to_string()),
            model_path: None,
            reference_audio: None,
            reference_text: None,
            reference_language: None,
            gpu_device: -1,
            port: 9880,
            launch_command: None,
            auto_start: false,
            voice: Some("default".to_string()),
            language: "en".to_string(),
            speed: 1.0,
        }
    }

    #[test]
    fn manager_creation() {
        let config = test_config();
        let manager = AnimeTtsManager::new(&config).unwrap();
        assert_eq!(manager.engine, "edge-tts");
        assert_eq!(manager.port, 9880);
        assert_eq!(manager.default_language(), "en");
    }

    #[test]
    fn auto_port_default() {
        let mut config = test_config();
        config.port = 0;
        config.api_url = None;
        let manager = AnimeTtsManager::new(&config).unwrap();
        assert_eq!(manager.port, 9880);
    }

    #[tokio::test]
    async fn synthesize_rejects_empty_text() {
        let config = test_config();
        let manager = AnimeTtsManager::new(&config).unwrap();
        let err = manager.synthesize("").await.unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }
}
