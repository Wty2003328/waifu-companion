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
            http,
        })
    }

    /// Send a chat completion. Returns the assistant's text content.
    pub async fn chat(&self, messages: &[ChatMessage]) -> anyhow::Result<String> {
        let url = format!("{}/chat/completions", self.base_url);
        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        });
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
}

fn resolve_api_key(cfg: &LlmConfig) -> Option<String> {
    if let Some(ref key) = cfg.api_key {
        if !key.is_empty() {
            return Some(key.clone());
        }
    }
    if let Some(ref var) = cfg.api_key_env {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                return Some(v);
            }
        }
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
}
