//! Generic, model-agnostic TTS port.
//!
//! The companion speaks a single HTTP contract — the OpenAI-compatible
//! TTS Provider Spec v1 (see `docs/TTS-PROVIDER-SPEC.md`). It knows
//! NOTHING about the engine on the other end: not its name, its weights,
//! its python interpreter, its reference audio, or its GPU device. Any
//! spec-compliant server plugs in by URL.
//!
//! # Wire contract (v1)
//!
//! ```text
//! POST {api_url}/v1/audio/speech   Content-Type: application/json
//!     {
//!       "input":           "<utterance>",
//!       "voice":           "<voice_id>",
//!       "speed":           1.0,
//!       "response_format": "wav",
//!       "stream_format":   "audio",
//!       "x_companion": {
//!         "language": "ja",
//!         "quality":  "balanced",            // fast | balanced | high
//!         "advanced": { /* server-specific */ }
//!       }
//!     }
//! → 200 OK
//!     body:    raw audio bytes
//!     headers: X-Sample-Rate (default 24000)
//!              X-Channels    (default 1)
//!              X-Format      (default "wav" — "wav"|"mp3"|"pcm")
//!
//! GET {api_url}/healthz
//! → 200 OK when ready (JSON body with engine_id + spec_version)
//!
//! POST {api_url}/shutdown
//! → 200 OK (server exits within 8s)
//! ```
//!
//! Only the blocking `stream_format = "audio"` path is implemented —
//! paragraph-wise streaming higher up in `ws::run_streaming_speak` calls
//! this port once per paragraph.
//!
//! # Lifecycle
//!
//! The companion implements the supervisor side of the launch & lifecycle
//! protocol (see spec doc):
//!
//!   start_server() — if `launcher_command` is set: spawn it as a child;
//!                    always poll `/healthz` until 200 (240s budget).
//!   synthesize()   — POST `/v1/audio/speech`, return [`AudioOutput`].
//!   stop_server()  — POST `/shutdown`; wait for child to exit (8s);
//!                    SIGTERM (5s); SIGKILL. No-ops when we didn't spawn.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::AvatarTtsConfig;

/// HTTP timeout for TTS synthesis requests.
const TTS_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Maximum time to wait for the TTS server to become healthy after start.
/// Cold-start budget covers framework init + BERT/codec load + JIT
/// kernel compile on a fresh checkout.
const HEALTH_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(240);

/// Interval between health check polls during startup.
const HEALTH_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// How long /shutdown gets to drain the engine cleanly before we
/// escalate to a signal. Matches the spec's 8s contract.
const GRACEFUL_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// How long the spec gives a server to honour SIGTERM before we SIGKILL.
const SIGNAL_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Output from TTS synthesis.
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

/// Speaks the universal TTS port and optionally manages an opaque child
/// launcher.
pub struct AnimeTtsManager {
    /// API base URL for the TTS server.
    api_url: String,
    /// Voice/character identifier sent in the request body.
    voice: Option<String>,
    /// Default speech language. Per-call override via `synthesize_with`.
    default_language: String,
    /// Speech speed multiplier.
    speed: f32,
    /// Default quality preset ("fast" | "balanced" | "high") forwarded
    /// as `x_companion.quality`. None → sidecar default ("balanced").
    default_quality: Option<String>,
    /// Opaque launcher command. When Some(non-empty), `start_server`
    /// spawns it via the OS shell and waits for /healthz. When None,
    /// `start_server` only polls.
    launcher_command: Option<String>,
    /// The managed subprocess (if we spawned one).
    child: Arc<Mutex<Option<Child>>>,
    /// HTTP client for API calls.
    client: reqwest::Client,
}

impl AnimeTtsManager {
    /// Build from config. Does not start the server.
    pub fn new(config: &AvatarTtsConfig) -> Result<Self> {
        let api_url = config
            .api_url
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:9890".to_string());

        let launcher_command = config
            .launcher_command
            .clone()
            .filter(|s| !s.trim().is_empty());

        Ok(Self {
            api_url,
            voice: config.voice.clone(),
            default_language: config.language.clone(),
            speed: config.speed,
            default_quality: config.quality.clone(),
            launcher_command,
            child: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .timeout(TTS_REQUEST_TIMEOUT)
                .build()
                .context("Failed to build HTTP client for anime TTS")?,
        })
    }

    /// Default speech language configured for this manager.
    pub fn default_language(&self) -> &str {
        &self.default_language
    }

    /// Start the TTS server.
    ///
    /// If `launcher_command` is set: spawn it as an opaque shell child,
    /// then poll `/healthz`. If not set: only poll (assume external
    /// supervision).
    ///
    /// Adopting a still-warm server from a prior launch: if `/healthz`
    /// already returns 200 before we spawn, skip the spawn and reuse it.
    pub async fn start_server(&self) -> Result<()> {
        if self.probe_health().await {
            tracing::info!(
                "avatar: adopting already-running TTS server at {} (skipping launch)",
                self.api_url
            );
            return Ok(());
        }

        let Some(command_str) = self.launcher_command.clone() else {
            tracing::info!(
                "avatar: no launcher_command; assuming externally-managed TTS at {}",
                self.api_url,
            );
            self.wait_for_health().await?;
            return Ok(());
        };

        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            tracing::warn!("avatar: TTS launcher already spawned by this process");
            return Ok(());
        }

        // Opaque shell spawn. The companion does not inspect or template
        // the command — what the user (or `tts_lab/launch_tts.py`) puts
        // here is run verbatim.
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&command_str);
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c").arg(&command_str);
            c
        };

        // Pipe stdout/stderr into our tracing log with a `[tts-…]` prefix.
        // Without this Tauri's sidecar swallows them, making Python
        // crashes invisible.
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .with_context(|| format!("Failed to spawn TTS launcher_command: {command_str}"))?;
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[tts-stdout] {line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[tts-stderr] {line}");
                }
            });
        }
        *child_guard = Some(child);
        drop(child_guard);

        tracing::info!(
            "avatar: spawned TTS launcher (waiting for /healthz up to {}s) — `{command_str}`",
            HEALTH_CHECK_TIMEOUT.as_secs(),
        );
        self.wait_for_health().await?;
        Ok(())
    }

    /// Stop the TTS server per the lifecycle protocol:
    ///   1. POST /shutdown (2s request timeout).
    ///   2. If we own a child: wait up to `GRACEFUL_SHUTDOWN_TIMEOUT` for
    ///      it to exit on its own.
    ///   3. If still alive: kill (TerminateProcess on Windows; SIGKILL
    ///      on POSIX — `tokio::process::Child::kill` is the platform
    ///      escalation already).
    ///   4. If we don't own a child (adopted-server case): poll /healthz
    ///      and warn if the server stays up past the deadline.
    pub async fn stop_server(&self) -> Result<()> {
        // Best-effort graceful HTTP shutdown. Errors are non-fatal — the
        // server may already be dying or the request may race the exit.
        let url = format!("{}/shutdown", self.api_url.trim_end_matches('/'));
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .ok();
        if let Some(c) = client {
            match c.post(&url).send().await {
                Ok(_) => tracing::info!("avatar: TTS /shutdown requested"),
                Err(e) => {
                    tracing::debug!("avatar: TTS /shutdown not delivered ({e}); falling through")
                }
            }
        }

        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            let waited = tokio::time::timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await;
            match waited {
                Ok(Ok(status)) => {
                    tracing::info!("avatar: TTS launcher exited gracefully (status={status})");
                }
                Ok(Err(e)) => {
                    tracing::warn!("avatar: TTS child wait failed ({e}); killing");
                    let _ = child.kill().await;
                }
                Err(_) => {
                    tracing::warn!(
                        "avatar: TTS launcher did not exit within {}s — killing \
                         (engine teardown may not have run)",
                        GRACEFUL_SHUTDOWN_TIMEOUT.as_secs()
                    );
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(SIGNAL_SHUTDOWN_TIMEOUT, child.wait()).await;
                }
            }
            tracing::info!("avatar: TTS launcher stopped");
        } else {
            // Adopted-server case: poll /healthz until the server actually
            // stops responding. Warn loudly if it doesn't — the user
            // pre-spawned this server, so it's theirs to kill.
            let deadline = std::time::Instant::now() + GRACEFUL_SHUTDOWN_TIMEOUT;
            loop {
                if !self.probe_health().await {
                    tracing::info!("avatar: adopted TTS shut down cleanly");
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    tracing::warn!(
                        "avatar: adopted TTS at {} still responding after {}s — \
                         your externally-managed server didn't honour POST /shutdown. \
                         Stop it manually.",
                        self.api_url,
                        GRACEFUL_SHUTDOWN_TIMEOUT.as_secs(),
                    );
                    break;
                }
                tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
            }
        }
        *child_guard = None;
        Ok(())
    }

    /// Synthesize text using the manager's default language.
    pub async fn synthesize(&self, text: &str) -> Result<AudioOutput> {
        self.synthesize_with_opts(text, &self.default_language, None, None, None)
            .await
    }

    /// Synthesize text in an explicit language (overrides config default).
    pub async fn synthesize_with(&self, text: &str, language: &str) -> Result<AudioOutput> {
        self.synthesize_with_opts(text, language, None, None, None).await
    }

    /// Synthesize with full per-call options. Every overridable field
    /// is per-call so UI knob changes apply on the next utterance
    /// without rebuilding the AnimeTtsManager (which would otherwise
    /// require a TTS subprocess restart).
    pub async fn synthesize_with_opts(
        &self,
        text: &str,
        language: &str,
        sample_steps: Option<u8>,
        speed_override: Option<f32>,
        voice_override: Option<&str>,
    ) -> Result<AudioOutput> {
        if text.is_empty() {
            bail!("TTS text must not be empty");
        }

        let url = format!("{}/v1/audio/speech", self.api_url);
        let speed = speed_override.unwrap_or(self.speed);
        let effective_voice: &str = voice_override
            .or(self.voice.as_deref())
            .unwrap_or("default");

        let mut x_companion = serde_json::json!({
            "language": language,
            "quality":  self.default_quality.clone().unwrap_or_else(|| "balanced".to_string()),
        });
        if let Some(steps) = sample_steps {
            // Backward-compat: GPT-SoVITS sidecars treated sample_steps as a
            // direct knob. New sidecars consume it via advanced.* if they
            // recognise the key; otherwise it's ignored.
            x_companion["advanced"] = serde_json::json!({ "sample_steps": steps });
        }

        let body = serde_json::json!({
            "input":           text,
            "voice":           effective_voice,
            "speed":           speed,
            "response_format": "wav",
            "stream_format":   "audio",
            "x_companion":     x_companion,
        });

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
        let url = format!("{}/healthz", self.api_url);
        match self.client.get(&url).send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    /// One quick `/healthz` GET with a short timeout — used at startup to
    /// detect a still-warm server left by a prior run so we adopt it
    /// rather than launch a duplicate.
    async fn probe_health(&self) -> bool {
        let url = format!("{}/healthz", self.api_url);
        match self
            .client
            .get(&url)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    /// Wait for the TTS server to become healthy.
    async fn wait_for_health(&self) -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            if self.health_check().await.unwrap_or(false) {
                tracing::info!("avatar: TTS server is healthy at {}", self.api_url);
                return Ok(());
            }
            if start.elapsed() > HEALTH_CHECK_TIMEOUT {
                bail!(
                    "avatar: TTS server at {} did not become healthy within {}s",
                    self.api_url,
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
            api_url: Some("http://127.0.0.1:9880".to_string()),
            voice: Some("default".to_string()),
            language: "en".to_string(),
            speed: 1.0,
            quality: None,
            streaming: true,
            launcher_command: None,
        }
    }

    #[test]
    fn manager_creation() {
        let config = test_config();
        let manager = AnimeTtsManager::new(&config).unwrap();
        assert_eq!(manager.api_url, "http://127.0.0.1:9880");
        assert_eq!(manager.default_language(), "en");
    }

    #[test]
    fn auto_api_url_default() {
        let mut config = test_config();
        config.api_url = None;
        let manager = AnimeTtsManager::new(&config).unwrap();
        assert_eq!(manager.api_url, "http://127.0.0.1:9890");
    }

    #[test]
    fn empty_launcher_command_treated_as_none() {
        let mut config = test_config();
        config.launcher_command = Some("   ".to_string());
        let manager = AnimeTtsManager::new(&config).unwrap();
        assert!(manager.launcher_command.is_none());
    }

    #[tokio::test]
    async fn synthesize_rejects_empty_text() {
        let config = test_config();
        let manager = AnimeTtsManager::new(&config).unwrap();
        let err = manager.synthesize("").await.unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }
}
