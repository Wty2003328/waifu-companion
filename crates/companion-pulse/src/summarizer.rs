//! Pluggable summarization backend.
//!
//! Two paths exist on the same host:
//!
//! - [`Summarizer::Llm`] — talks directly to an OpenAI-compatible
//!   `/v1/chat/completions` endpoint. Faster and cheaper, but needs an
//!   API key resolvable on this machine (env var or inline).
//!
//! - [`Summarizer::Zeroclaw`] — POSTs to upstream zeroclaw's `/webhook`,
//!   reusing zeroclaw's already-decrypted provider key. Slower (one full
//!   agent loop per call, ~5–10s) but doesn't need any key on this side.
//!
//! The choice is made by the host (companion-server) based on what the
//! user already configured for the avatar subagent. Pulse just gets a
//! ready-to-call object.

use anyhow::Result;

use companion_core::{
    llm::{ChatMessage, LlmClient, Role},
    zeroclaw::ZeroclawClient,
};

const SYSTEM_PROMPT: &str = "You are a concise summarizer for a personal feed reader. \
     Reply with 3 to 5 short bullet points capturing the key facts \
     and takeaways. No preamble, no closing remarks. Each bullet \
     one line, starting with '- '.";

/// Summary backend selector. Both variants implement the same one-shot
/// `summarize` operation.
#[derive(Clone)]
pub enum Summarizer {
    /// Direct OpenAI-compatible chat-completions client.
    Llm(LlmClient),
    /// Tunnel through zeroclaw's `/webhook` endpoint.
    Zeroclaw(ZeroclawClient),
}

impl Summarizer {
    /// Generate a 3–5 bullet summary for the given article body.
    /// `body` should be the title + url + (truncated) content composed
    /// by the caller — we don't trim here so the caller controls
    /// token budget per backend.
    pub async fn summarize(&self, body: &str) -> Result<String> {
        match self {
            Summarizer::Llm(c) => {
                let msgs = vec![
                    ChatMessage {
                        role: Role::System,
                        content: SYSTEM_PROMPT.into(),
                    },
                    ChatMessage {
                        role: Role::User,
                        content: body.to_string(),
                    },
                ];
                Ok(c.chat(&msgs).await?.trim().to_string())
            }
            Summarizer::Zeroclaw(z) => {
                // Zeroclaw's /webhook takes a single message string. We
                // inline the system instructions so the agent on the
                // other side gets the same shape.
                let prompt = format!("{SYSTEM_PROMPT}\n\n---\n{body}");
                Ok(z.send_chat(&prompt).await?.trim().to_string())
            }
        }
    }

    /// Short label for logs / `/api/status`.
    pub fn backend_name(&self) -> &'static str {
        match self {
            Summarizer::Llm(_) => "openai-compatible",
            Summarizer::Zeroclaw(_) => "zeroclaw-webhook",
        }
    }
}
