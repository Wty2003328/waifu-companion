//! OpenAI-compatible chat-completions client.
//!
//! Speaks the `/v1/chat/completions` shape used by OpenAI, OpenRouter,
//! Together, Groq, DeepInfra, vLLM, Ollama (with `/v1` prefix), LM Studio,
//! and any other provider that follows the de-facto standard. This is
//! intentionally narrower than zeroclaw's full provider matrix — the
//! companion's subagent only needs one cheap LLM, and OpenAI-compat covers
//! ~95% of what users actually run.
//!
//! For native Anthropic / Gemini, point this at OpenRouter or a compat
//! gateway — keeps the dependency surface small.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Configuration for an LLM call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    /// Base URL for the chat-completions endpoint. Defaults to OpenAI.
    /// Examples:
    /// - OpenAI:     `https://api.openai.com/v1`
    /// - OpenRouter: `https://openrouter.ai/api/v1`
    /// - Ollama:     `http://127.0.0.1:11434/v1`
    /// - LM Studio:  `http://127.0.0.1:1234/v1`
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// API key. Read from this field, or from env var named in `api_key_env`,
    /// or `OPENAI_API_KEY` as a last resort.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Env var name to read the key from (e.g. `OPENROUTER_API_KEY`).
    #[serde(default)]
    pub api_key_env: Option<String>,
    /// Model name (e.g. `gpt-4o-mini`, `anthropic/claude-haiku-4.5`,
    /// `llama-3.3-70b-versatile`).
    pub model: String,
    /// Sampling temperature.
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// Max output tokens.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Per-request timeout in seconds.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// Whether to send `thinking: { type: "disabled" }` in the request
    /// body. z.ai's GLM-4.5/4.6/5 family otherwise spends 15–25 s in
    /// chain-of-thought before producing the actual JSON the subagent
    /// needs; disabling it cuts that to ~1 s. Other OpenAI-compatible
    /// endpoints ignore the field. Default `true` (faster). Set `false`
    /// if you want the model's full reasoning (better translation /
    /// expression quality on hard inputs, at the cost of latency).
    #[serde(default = "default_disable_thinking")]
    pub disable_thinking: bool,
}

fn default_base_url() -> String {
    "https://api.openai.com/v1".into()
}
fn default_temperature() -> f32 {
    0.3
}
fn default_max_tokens() -> u32 {
    400
}
fn default_timeout() -> u64 {
    30
}
fn default_disable_thinking() -> bool {
    true
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            base_url: default_base_url(),
            api_key: None,
            api_key_env: None,
            model: "gpt-4o-mini".into(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            timeout_secs: default_timeout(),
            disable_thinking: default_disable_thinking(),
        }
    }
}

/// Chat message role.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// Single chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// OpenAI-compatible chat-completions client.
#[derive(Clone)]
pub struct LlmClient {
    base_url: String,
    api_key: Option<String>,
    model: String,
    temperature: f32,
    max_tokens: u32,
    disable_thinking: bool,
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new(cfg: &LlmConfig) -> anyhow::Result<Self> {
        let api_key = resolve_api_key(cfg);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_secs))
            .build()?;
        Ok(Self {
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            api_key,
            model: cfg.model.clone(),
            temperature: cfg.temperature,
            max_tokens: cfg.max_tokens,
            disable_thinking: cfg.disable_thinking,
            http,
        })
    }

    /// Send a chat completion. Returns the assistant's text content.
    pub async fn chat(&self, messages: &[ChatMessage]) -> anyhow::Result<String> {
        let url = format!("{}/chat/completions", self.base_url);
        // `thinking: { type: disabled }` is z.ai's switch to skip the
        // reasoning_content step on GLM-4.5/4.6/5 family models. Without
        // it, those models sit in chain-of-thought for 15–25 s before
        // producing the JSON the subagent needs. Other OpenAI-compatible
        // endpoints ignore the field. Gated by `disable_thinking` so the
        // user can re-enable reasoning if they want richer output.
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        });
        if self.disable_thinking {
            body["thinking"] = serde_json::json!({ "type": "disabled" });
        }
        let mut req = self.http.post(&url).json(&body);
        if let Some(ref key) = self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            anyhow::bail!("LLM {url} returned {status}: {txt}");
        }
        let payload: serde_json::Value = resp.json().await?;
        let content = payload
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| anyhow::anyhow!("LLM response missing choices[0].message.content"))?;
        Ok(content.to_string())
    }

    /// Stream a chat completion. Calls `on_chunk(delta_text)` once per
    /// token chunk as the SSE stream arrives. Returns the full text
    /// when the stream finishes.
    ///
    /// Wire format: OpenAI-style SSE — `data: {...json...}\n\n` lines,
    /// terminated by `data: [DONE]\n\n`. Each json has
    /// `choices[0].delta.content` carrying the new text fragment. We
    /// concat as we go and surface to the caller incrementally.
    ///
    /// Designed for the avatar subagent: as soon as a sentence
    /// terminator lands in the buffer, the caller can dispatch a TTS
    /// call without waiting for the full reply. Drops time-to-first-
    /// audio dramatically on long replies (~20s+ → ~3s).
    pub async fn chat_stream<F>(
        &self,
        messages: &[ChatMessage],
        mut on_chunk: F,
    ) -> anyhow::Result<String>
    where
        F: FnMut(&str),
    {
        use futures_util::StreamExt;
        let url = format!("{}/chat/completions", self.base_url);
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": true,
        });
        if self.disable_thinking {
            body["thinking"] = serde_json::json!({ "type": "disabled" });
        }
        let mut req = self.http.post(&url).json(&body);
        if let Some(ref key) = self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            anyhow::bail!("LLM {url} returned {status}: {txt}");
        }
        // Some providers reject SSE upgrade and return a regular JSON
        // body (typical when `stream` isn't supported on the model).
        // Detect by content-type and degrade to one-shot.
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        if !ct.contains("event-stream") {
            // Fallback: treat as full chat completion.
            let payload: serde_json::Value = resp.json().await?;
            let content = payload
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            if !content.is_empty() {
                on_chunk(&content);
            }
            return Ok(content);
        }

        let mut full = String::new();
        let mut buf = Vec::<u8>::new();
        let mut stream = resp.bytes_stream();
        while let Some(item) = stream.next().await {
            let bytes = item?;
            buf.extend_from_slice(&bytes);
            // SSE events are separated by \n\n. Process every complete
            // event in the buffer and keep the trailing partial.
            while let Some(pos) = find_double_newline(&buf) {
                let event = buf.drain(..pos + 2).collect::<Vec<u8>>();
                let event_str = match std::str::from_utf8(&event) {
                    Ok(s) => s,
                    Err(_) => continue, // skip malformed UTF-8 fragment
                };
                // An event has one or more `field: value` lines. We
                // only care about `data:` lines.
                for line in event_str.lines() {
                    let Some(payload) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let payload = payload.trim_start();
                    if payload == "[DONE]" {
                        return Ok(full);
                    }
                    if payload.is_empty() {
                        continue;
                    }
                    let val: serde_json::Value = match serde_json::from_str(payload) {
                        Ok(v) => v,
                        Err(_) => continue, // tolerate keep-alive heartbeats
                    };
                    if let Some(delta) = val
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|t| t.as_str())
                        && !delta.is_empty() {
                            full.push_str(delta);
                            on_chunk(delta);
                        }
                }
            }
        }
        // Stream ended without [DONE] — return what we have.
        Ok(full)
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn resolve_api_key(cfg: &LlmConfig) -> Option<String> {
    if let Some(ref key) = cfg.api_key
        && !key.is_empty() {
            return Some(key.clone());
        }
    if let Some(ref var) = cfg.api_key_env
        && let Ok(v) = std::env::var(var)
            && !v.is_empty() {
                return Some(v);
            }
    std::env::var("OPENAI_API_KEY").ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_openai_base_url() {
        let cfg = LlmConfig {
            model: "gpt-4o-mini".into(),
            ..Default::default()
        };
        assert_eq!(cfg.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn resolves_api_key_priority() {
        let cfg = LlmConfig {
            api_key: Some("inline".into()),
            api_key_env: Some("ZZ_NEVER_SET".into()),
            model: "x".into(),
            ..Default::default()
        };
        assert_eq!(resolve_api_key(&cfg), Some("inline".into()));
    }

    // ── Additional coverage ────────────────────────────────────────

    #[test]
    fn empty_api_key_falls_through_to_env() {
        // An explicit empty string in the inline field should NOT be
        // returned — the resolver should treat it as unset and fall
        // through to the env var path.
        unsafe {
            std::env::set_var("LLM_TEST_KEY_PRIORITY", "from-env");
        }
        let cfg = LlmConfig {
            api_key: Some("".into()),
            api_key_env: Some("LLM_TEST_KEY_PRIORITY".into()),
            model: "x".into(),
            ..Default::default()
        };
        assert_eq!(resolve_api_key(&cfg), Some("from-env".into()));
        unsafe {
            std::env::remove_var("LLM_TEST_KEY_PRIORITY");
        }
    }

    #[test]
    fn no_keys_returns_none() {
        // Save and clear OPENAI_API_KEY for the duration of this test.
        let saved = std::env::var("OPENAI_API_KEY").ok();
        unsafe {
            std::env::remove_var("OPENAI_API_KEY");
        }
        let cfg = LlmConfig {
            api_key: None,
            api_key_env: None,
            model: "x".into(),
            ..Default::default()
        };
        assert_eq!(resolve_api_key(&cfg), None);
        // Restore
        if let Some(v) = saved {
            unsafe {
                std::env::set_var("OPENAI_API_KEY", v);
            }
        }
    }

    #[test]
    fn default_disable_thinking_is_true() {
        // The default keeps z.ai GLM models fast. If a regression flips
        // this to false, latency on glm-4.5-flash jumps 20×.
        let cfg = LlmConfig::default();
        assert!(cfg.disable_thinking);
    }

    #[test]
    fn find_double_newline_handles_empty_buffer() {
        assert_eq!(super::find_double_newline(&[]), None);
    }

    #[test]
    fn find_double_newline_finds_at_start() {
        let buf = b"\n\nrest";
        assert_eq!(super::find_double_newline(buf), Some(0));
    }

    #[test]
    fn find_double_newline_finds_in_middle() {
        let buf = b"data: foo\n\ndata: bar\n\n";
        assert_eq!(super::find_double_newline(buf), Some(9));
    }

    #[test]
    fn find_double_newline_returns_none_when_absent() {
        let buf = b"data: incomplete";
        assert_eq!(super::find_double_newline(buf), None);
    }

    #[test]
    fn role_serializes_as_lowercase() {
        let m = ChatMessage {
            role: Role::System,
            content: "hello".into(),
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"role\":\"system\""), "got {json}");
    }

    #[test]
    fn role_deserializes_assistant() {
        let json = r#"{"role":"assistant","content":"hi"}"#;
        let m: ChatMessage = serde_json::from_str(json).unwrap();
        assert_eq!(m.role, Role::Assistant);
    }

    #[test]
    fn config_round_trips_through_serde_json() {
        let cfg = LlmConfig {
            base_url: "https://example.com/v1".into(),
            api_key: Some("test".into()),
            api_key_env: None,
            model: "gpt-test".into(),
            temperature: 0.42,
            max_tokens: 123,
            timeout_secs: 45,
            disable_thinking: false,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        let back: LlmConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.base_url, cfg.base_url);
        assert_eq!(back.api_key, cfg.api_key);
        assert!((back.temperature - cfg.temperature).abs() < f32::EPSILON);
        assert_eq!(back.timeout_secs, cfg.timeout_secs);
        assert_eq!(back.disable_thinking, cfg.disable_thinking);
    }
}
