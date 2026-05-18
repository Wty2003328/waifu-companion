//! Real-sidecar smoke test: drives the universal TTS launcher
//! (`tts_lab/launch_tts.py`) through the companion's `AnimeTtsManager`
//! against the actual Qwen3-TTS weights on this machine.
//!
//! Validates the end-to-end lifecycle protocol (spawn launcher →
//! /healthz → /v1/audio/speech → /shutdown → child exit) without the
//! companion knowing anything about the engine.
//!
//! Marked `#[ignore]` because:
//!   - Requires Python 3.10+ on PATH (or at the conda location)
//!   - Requires the Qwen3-TTS weights downloaded under `tts_lab/models/`
//!   - Takes ~60s to load the model
//!   - Uses real GPU memory
//!
//! Run explicitly:
//!     cargo test -p companion-avatar --test qwen3_sidecar_smoke -- --ignored --nocapture
//!
//! For a faster lab-only test that hits the SBV2 sidecar (loads in
//! ~5s instead of ~30s) change the `--engine` arg below to
//! `sbv2-asuna-v2`.

use std::path::PathBuf;
use std::time::Duration;

use companion_avatar::{AnimeTtsManager, config::AvatarTtsConfig};

fn workspace_root() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent().unwrap().parent().unwrap().parent().unwrap().to_path_buf()
}

fn smoke_config(engine: &str, port: u16) -> AvatarTtsConfig {
    let launcher = workspace_root()
        .join("tts_lab/launch_tts.py")
        .to_string_lossy().to_string();
    let python = "python";

    AvatarTtsConfig {
        api_url: Some(format!("http://127.0.0.1:{port}")),
        voice: Some("asuna_v2".into()),
        language: "ja".into(),
        speed: 1.0,
        quality: Some("balanced".into()),
        streaming: false,
        launcher_command: Some(format!(
            "{python} {launcher} --engine {engine} --port {port}"
        )),
    }
}

#[tokio::test]
#[ignore = "requires TTS weights + GPU; ~60s wall time"]
async fn qwen3_sidecar_e2e() {
    // Use a port disjoint from production (9890) so concurrent runs don't collide.
    let mgr = AnimeTtsManager::new(&smoke_config("qwen3-tts-1.7b", 9892))
        .expect("manager construct");
    mgr.start_server().await.expect("sidecar should start within 240s");

    let out = mgr.synthesize_with("こんにちは、私は人工知能アシスタントです。", "ja")
        .await
        .expect("synthesis should succeed");

    assert!(!out.audio_bytes.is_empty(), "audio body should be non-empty");
    assert_eq!(out.format, "wav");
    assert_eq!(out.channels, 1);
    assert_eq!(&out.audio_bytes[..4], b"RIFF");
    assert_eq!(&out.audio_bytes[8..12], b"WAVE");

    println!("synthesized {} bytes of WAV @ {} Hz", out.audio_bytes.len(), out.sample_rate);

    mgr.stop_server().await.expect("teardown");
    tokio::time::sleep(Duration::from_secs(2)).await;
}
