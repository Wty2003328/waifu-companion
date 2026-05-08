//! Core traits for the avatar subsystem.

use anyhow::Result;
use async_trait::async_trait;

/// Trait for anime-voice TTS backends (GPT-SoVITS, Fish-Speech, MeloTTS).
///
/// Each implementation wraps an HTTP API call to a running Python TTS server.
#[async_trait]
pub trait AnimeTtsProvider: Send + Sync {
    /// Provider identifier (e.g. `"gpt-sovits"`, `"fish-speech"`, `"melotts"`).
    fn name(&self) -> &str;

    /// Synthesize `text` with the given `voice`, returning raw audio bytes.
    async fn synthesize(&self, text: &str, voice: &str) -> Result<super::tts_server::AudioOutput>;

    /// Health-check the backend server.
    async fn health_check(&self) -> Result<bool>;
}

/// Trait for avatar rendering targets (web dashboard or Tauri desktop).
///
/// The Rust backend never renders Live2D directly — it sends control data
/// to the frontend over WebSocket. This trait abstracts the notification
/// mechanism for internal use.
pub trait AvatarRenderer: Send + Sync {
    /// Push a notification to connected frontend clients.
    fn notify(&self, notification: super::protocol::AvatarNotification);
}
