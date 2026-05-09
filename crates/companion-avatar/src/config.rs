//! Avatar config types — owned by companion-avatar, deserialized from
//! the `[avatar]` table in `companion.toml`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use companion_core::llm::LlmConfig;

/// Top-level avatar configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvatarConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Language the user chats with the agent in. Subtitles use this language;
    /// when it differs from `tts.language` the subagent translates each reply
    /// before TTS synthesis.
    #[serde(default = "default_chat_language")]
    pub chat_language: String,
    #[serde(default)]
    pub tts: AvatarTtsConfig,
    #[serde(default)]
    pub model: Live2DModelConfig,
    #[serde(default)]
    pub expressions: ExpressionMappingConfig,
    #[serde(default)]
    pub lip_sync: LipSyncConfig,
    #[serde(default)]
    pub subagent: AvatarSubagentConfig,
}

impl Default for AvatarConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            chat_language: default_chat_language(),
            tts: AvatarTtsConfig::default(),
            model: Live2DModelConfig::default(),
            expressions: ExpressionMappingConfig::default(),
            lip_sync: LipSyncConfig::default(),
            subagent: AvatarSubagentConfig::default(),
        }
    }
}

fn default_chat_language() -> String {
    "en".into()
}

/// Split text into sentence-sized chunks for streaming synthesis.
///
/// Boundary characters: `.`, `!`, `?`, `。`, `！`, `？`, newlines.
/// Chunks shorter than `min_len` are merged with the next sentence so
/// we don't waste a whole TTS call on "Hi." or " ".
pub fn split_sentences(text: &str, min_len: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for ch in text.chars() {
        buf.push(ch);
        let is_terminal = matches!(ch, '.' | '!' | '?' | '。' | '！' | '？' | '\n');
        if is_terminal && buf.trim().chars().count() >= min_len {
            out.push(buf.trim().to_string());
            buf.clear();
        }
    }
    let tail = buf.trim();
    if !tail.is_empty() {
        // If the last fragment is too short to stand alone, fold it
        // into the previous chunk.
        if tail.chars().count() < min_len && !out.is_empty() {
            let last = out.last_mut().unwrap();
            last.push(' ');
            last.push_str(tail);
        } else {
            out.push(tail.to_string());
        }
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests_split {
    use super::*;

    #[test]
    fn splits_english_sentences() {
        let v = split_sentences("Hello there. How are you? Good!", 4);
        assert_eq!(v, vec!["Hello there.", "How are you?", "Good!"]);
    }

    #[test]
    fn merges_short_tail() {
        let v = split_sentences("Hello there. Hi", 4);
        assert_eq!(v, vec!["Hello there. Hi"]);
    }

    #[test]
    fn handles_japanese_terminators() {
        let v = split_sentences("こんにちは。お元気ですか？", 2);
        assert_eq!(v, vec!["こんにちは。", "お元気ですか？"]);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(split_sentences("", 4).is_empty());
    }

    #[test]
    fn no_terminator_returns_whole_text() {
        let v = split_sentences("just a phrase no period", 4);
        assert_eq!(v, vec!["just a phrase no period"]);
    }

    /// Realistic Japanese reply with mixed terminators + leading
    /// short sentence. We expect short fragments to merge with the
    /// next, so chunk 1 has clean prosody for TTS.
    #[test]
    fn japanese_reply_merges_short_lead() {
        let text = "こんにちは！アスナです。明日に向けてサポートするね！";
        let v = split_sentences(text, 24);
        // The first 6-char "こんにちは！" should merge with the next
        // sentence rather than being shipped to TTS on its own.
        assert!(v[0].chars().count() >= 24, "first chunk too short: {:?}", v[0]);
    }

    /// Numeric like "1." should not trigger a split when the
    /// preceding text would be too short.
    #[test]
    fn numeric_periods_dont_split() {
        let text = "Try this. 1. First tip. 2. Second tip.";
        let v = split_sentences(text, 16);
        // We don't want chunks like "1." or "2." escaping on their own.
        for chunk in &v {
            assert!(
                chunk.trim().chars().count() >= 4,
                "chunk too short to be a real sentence: {:?}",
                chunk
            );
        }
    }

    /// Diagnostic: print what real Japanese translations chunk into
    /// so we can sanity-check the chunk sizes are TTS-friendly.
    /// Run: `cargo test -p companion-avatar dump_japanese_chunks --release -- --nocapture`
    #[test]
    fn dump_japanese_chunks() {
        let cases: &[(&str, &str)] = &[
            ("short", "こんにちは！アスナです。"),
            ("medium", "こんにちは！アスナです。明日に向けてサポートするよ！あなたはどうですか？"),
            ("long",
             "こんにちは！アスナです！ゲームでレベルを上げる時でも、実際の試験に備える時でも、本当に役立つ勉強のコツを3つご紹介します。1つ目はポモドーロテクニック。25分集中して5分休憩を繰り返します。2つ目はアクティブリコール。3つ目は十分な睡眠です。"),
        ];
        for (name, text) in cases {
            let v = split_sentences(text, 24);
            eprintln!("\n--- {name} (len={}c, {} chunks) ---", text.chars().count(), v.len());
            for (i, c) in v.iter().enumerate() {
                eprintln!("  [{}] {}c: {}", i, c.chars().count(), c);
            }
        }
    }

    /// Order is preserved verbatim — chunks reassembled (with spaces)
    /// must equal the original (modulo trim).
    #[test]
    fn order_preserved() {
        let text = "First. Second. Third.";
        let v = split_sentences(text, 4);
        let rejoined: String = v.iter().map(|s| s.trim()).collect::<Vec<_>>().join(" ");
        assert_eq!(rejoined.replace("  ", " "), "First. Second. Third.");
    }
}

/// TTS port configuration.
///
/// The companion speaks a single, model-agnostic HTTP contract:
///
/// - `POST {api_url}/tts` JSON: `{"text", "language", "voice"?, "speed"?}`
///   → audio bytes (optional `X-Sample-Rate`, `X-Channels`, `X-Format`).
/// - `GET {api_url}/health` → 200 OK when ready.
///
/// Engine-specific knobs are forwarded to the spawned wrapper as env vars
/// (`TTS_MODEL_PATH`, `TTS_REFERENCE_AUDIO`, `TTS_REFERENCE_TEXT`,
/// `TTS_REFERENCE_LANG`, `TTS_VOICE`, `CUDA_VISIBLE_DEVICES`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvatarTtsConfig {
    #[serde(default = "default_tts_engine")]
    pub engine: String,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub model_path: Option<String>,
    #[serde(default)]
    pub reference_audio: Option<String>,
    #[serde(default)]
    pub reference_text: Option<String>,
    #[serde(default)]
    pub reference_language: Option<String>,
    #[serde(default = "default_gpu_device")]
    pub gpu_device: i32,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub launch_command: Option<String>,
    #[serde(default = "default_true")]
    pub auto_start: bool,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default = "default_tts_language")]
    pub language: String,
    #[serde(default = "default_tts_speed")]
    pub speed: f32,
    /// When true (default), split each agent reply into sentences and
    /// synthesize them in order, broadcasting each as its own Audio
    /// frame. The first chunk arrives ~1–2s after the agent reply
    /// instead of waiting for the full reply to render. Set false to
    /// fall back to single-shot synthesis (whole reply as one WAV).
    #[serde(default = "default_true")]
    pub streaming: bool,
    /// Minimum sentence length (in chars) before chunking. Anything
    /// shorter gets merged with the next sentence so we don't waste a
    /// TTS call on a one-word fragment.
    #[serde(default = "default_streaming_min_chars")]
    pub streaming_min_chars: usize,
}

fn default_streaming_min_chars() -> usize {
    // Was 8 — too low for Japanese TTS (GPT-SoVITS prosody is poor
    // on <10-char inputs; we shipped one-word chunks like "Hi!" or
    // "アスナです" and they sounded clipped). 24 corresponds to
    // ~3-4 seconds of speech: long enough for clean prosody, short
    // enough that first-audio still arrives ~3-5s after the subagent
    // returns. Override in companion.toml `[avatar.tts]
    // streaming_min_chars = 12` for snappier first audio at the cost
    // of choppier early sentences.
    24
}

fn default_tts_engine() -> String {
    "edge-tts".into()
}
fn default_gpu_device() -> i32 {
    0
}
fn default_tts_language() -> String {
    "en".into()
}
fn default_tts_speed() -> f32 {
    1.0
}
fn default_true() -> bool {
    true
}

impl Default for AvatarTtsConfig {
    fn default() -> Self {
        Self {
            engine: default_tts_engine(),
            api_url: None,
            model_path: None,
            reference_audio: None,
            reference_text: None,
            reference_language: None,
            gpu_device: default_gpu_device(),
            port: 9880,
            launch_command: None,
            auto_start: true,
            voice: None,
            language: default_tts_language(),
            speed: default_tts_speed(),
            streaming: true,
            streaming_min_chars: default_streaming_min_chars(),
        }
    }
}

/// Live2D model configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Live2DModelConfig {
    #[serde(default)]
    pub model_dir: Option<String>,
    #[serde(default = "default_avatar_expression")]
    pub default_expression: String,
    #[serde(default = "default_model_scale")]
    pub scale: f32,
    #[serde(default = "default_model_anchor")]
    pub anchor: String,
}

fn default_avatar_expression() -> String {
    "neutral".into()
}
fn default_model_scale() -> f32 {
    0.2
}
fn default_model_anchor() -> String {
    "center".into()
}

impl Default for Live2DModelConfig {
    fn default() -> Self {
        Self {
            model_dir: None,
            default_expression: default_avatar_expression(),
            scale: default_model_scale(),
            anchor: default_model_anchor(),
        }
    }
}

/// Expression mapping from agent emotions to Live2D expressions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpressionMappingConfig {
    #[serde(default)]
    pub mapping: HashMap<String, String>,
    #[serde(default = "default_avatar_expression")]
    pub default: String,
    #[serde(default = "default_emotion_detection")]
    pub detection_mode: String,
    #[serde(default)]
    pub keyword_map: HashMap<String, String>,
}

fn default_emotion_detection() -> String {
    "keyword".into()
}

impl Default for ExpressionMappingConfig {
    fn default() -> Self {
        Self {
            mapping: HashMap::from([
                ("happy".to_string(), "smile".to_string()),
                ("sad".to_string(), "depressed".to_string()),
                ("angry".to_string(), "angry".to_string()),
                ("surprised".to_string(), "surprised".to_string()),
            ]),
            default: default_avatar_expression(),
            detection_mode: default_emotion_detection(),
            keyword_map: HashMap::from([
                ("happy".to_string(), "happy".to_string()),
                ("glad".to_string(), "happy".to_string()),
                ("sad".to_string(), "sad".to_string()),
                ("sorry".to_string(), "sad".to_string()),
                ("angry".to_string(), "angry".to_string()),
                ("wow".to_string(), "surprised".to_string()),
                ("surprised".to_string(), "surprised".to_string()),
            ]),
        }
    }
}

/// Lip sync configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LipSyncConfig {
    #[serde(default = "default_lip_sync_method")]
    pub method: String,
    #[serde(default = "default_lip_sync_smoothing")]
    pub smoothing: f32,
    #[serde(default = "default_mouth_open_param")]
    pub mouth_open_param: String,
    #[serde(default = "default_mouth_smile_param")]
    pub mouth_smile_param: String,
    #[serde(default = "default_lip_sync_fps")]
    pub fps: u32,
}

fn default_lip_sync_method() -> String {
    "volume".into()
}
fn default_lip_sync_smoothing() -> f32 {
    0.3
}
fn default_mouth_open_param() -> String {
    "ParamMouthOpenY".into()
}
fn default_mouth_smile_param() -> String {
    "ParamMouthSmile".into()
}
fn default_lip_sync_fps() -> u32 {
    30
}

impl Default for LipSyncConfig {
    fn default() -> Self {
        Self {
            method: default_lip_sync_method(),
            smoothing: default_lip_sync_smoothing(),
            mouth_open_param: default_mouth_open_param(),
            mouth_smile_param: default_mouth_smile_param(),
            fps: default_lip_sync_fps(),
        }
    }
}

/// Avatar subagent: a cheap LLM call that emits expression JSON and (when
/// `chat_language ≠ tts.language`) a translated reply.
///
/// Two backends:
/// - `llm` (default): direct OpenAI-compatible call. Fastest. Requires
///   a plaintext API key in this config (or via env var).
/// - `use_zeroclaw_webhook = true`: re-uses upstream zeroclaw as the LLM
///   by POSTing to its `/webhook`. No plaintext key needed in companion —
///   zeroclaw already has its keys decrypted. Slower (each agent reply
///   triggers a second zeroclaw round trip), but very simple to set up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvatarSubagentConfig {
    #[serde(default)]
    pub enabled: bool,
    /// When `true` (default), only run the subagent when chat_language
    /// differs from tts.language — i.e. when we actually need
    /// translation. For same-language setups this skips a 5-10s LLM
    /// call and falls back to fast keyword-based expression detection.
    /// Set to `false` if you want the LLM to always pick richer
    /// expressions even when no translation is needed.
    #[serde(default = "default_true")]
    pub only_when_translating: bool,
    /// When `true`, route subagent calls through the configured zeroclaw
    /// daemon (via `[zeroclaw] url`) instead of a direct LLM endpoint.
    /// Reuses zeroclaw's keys; no plaintext key needed below.
    #[serde(default)]
    pub use_zeroclaw_webhook: bool,
    /// When `true`, stream the translation token-by-token: TTS starts
    /// on the first complete sentence ~3s after the LLM begins,
    /// instead of waiting ~15-25s for a bulk JSON analyze() to finish.
    /// Trade-off: skips LLM-driven expression in favor of keyword
    /// matching (fast and good enough for most replies). Only meaningful
    /// when `use_zeroclaw_webhook = false` — webhook backend has no
    /// streaming surface.
    #[serde(default)]
    pub streaming: bool,
    /// LLM endpoint + model. Use any OpenAI-compatible provider
    /// (OpenAI, OpenRouter, Together, Groq, Ollama, vLLM, …). Ignored
    /// when `use_zeroclaw_webhook = true`.
    #[serde(default)]
    pub llm: LlmConfig,
    /// Custom system prompt override (replaces the built-in default).
    /// Supports `{chat_lang}` / `{tts_lang}` placeholders.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Per-call timeout in seconds.
    #[serde(default = "default_subagent_timeout")]
    pub timeout_secs: u64,
}

fn default_subagent_timeout() -> u64 {
    3
}

impl Default for AvatarSubagentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            only_when_translating: true,
            use_zeroclaw_webhook: false,
            streaming: false,
            llm: LlmConfig::default(),
            system_prompt: None,
            timeout_secs: default_subagent_timeout(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_avatar_toml() {
        let toml = r#"
            enabled = true
            chat_language = "en"
            [tts]
            language = "ja"
            engine = "gpt-sovits-v4"
        "#;
        let cfg: AvatarConfig = toml::from_str(toml).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.chat_language, "en");
        assert_eq!(cfg.tts.language, "ja");
        assert_eq!(cfg.tts.engine, "gpt-sovits-v4");
    }
}
