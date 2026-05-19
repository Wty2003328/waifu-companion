/**
 * Shared types used by the Settings page and its editor components.
 *
 * These mirror the JSON shape returned by `GET /api/config` (defined in
 * `apps/companion-server/src/handlers/config.rs`). When the wire schema
 * changes you update both ends.
 */

export interface AvatarConfigView {
  enabled: boolean;
  chat_language: string;
  /** Universal TTS port — companion knows only a URL + synthesis defaults.
   *  Engine identity, weights, python interpreter etc. live in an external
   *  launcher (tts_lab/launch_tts.py). See docs/TTS-PROVIDER-SPEC.md. */
  tts: {
    api_url: string | null;
    voice: string | null;
    language: string;
    speed: number;
    /** Quality preset (fast | balanced | high). null → sidecar default. */
    quality: string | null;
    /** Paragraph-wise streaming toggle. */
    streaming: boolean;
    /** Opaque launcher command, run at startup if non-empty. */
    launcher_command: string | null;
  };
  subagent: {
    enabled: boolean;
    only_when_translating: boolean;
    use_zeroclaw_webhook: boolean;
    streaming: boolean;
    llm_model: string;
    llm_base_url: string;
    llm_disable_thinking: boolean;
    llm_api_key_set: boolean;
    timeout_secs: number;
    translator?: TranslatorConfigView;
  };
  model: {
    model_dir: string | null;
    default_expression: string;
    scale: number;
    anchor: string;
  };
}

/** Subagent's translation backend + NMT sidecar tuning.
 *  Mirrors `crates/companion-avatar/src/translator.rs::TranslatorConfig`. */
export interface TranslatorConfigView {
  backend: 'llm' | 'http';
  url: string;
  http_timeout_secs: number;
  nmt_quality_preset: string;       // "fast" | "balanced" | "quality" | "custom"
  nmt_model_id: string | null;
  nmt_num_beams: number | null;
  nmt_device: string;                // "cpu" | "cuda" | "cuda:N"
  nmt_precision: string;             // "auto" | "fp32" | "fp16" | "bf16"
  nmt_src_lang: string;
  nmt_tgt_lang: string;
  nmt_launch_command: string;
  nmt_auto_start: boolean;
  nmt_close_with_companion: boolean;
  nmt_port: number;
}

export interface ZeroclawConfigView {
  /** "zeroclaw" | "openclaw" | "hermes" | "custom". Drives the chat
   *  HTTP shape (webhook vs OpenAI-compat) and prefilled default port. */
  kind: string;
  url: string;
  timeout_secs: number;
  pair_token_set: boolean;
  reachable: boolean;
}

export interface ServerConfig {
  avatar: AvatarConfigView | null;
  zeroclaw?: ZeroclawConfigView;
}
