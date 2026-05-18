# Architecture

## Why sidecar instead of fork

Maintaining `zeroclaw_forked` cost roughly:

- ~3,400 LOC of fork-only Rust (`src/avatar/` + `src/pulse/`)
- ~2,300 LOC of fork-only TypeScript (Pulse widgets, avatar UI, theme)
- ~1,000 LOC of schema entries in `src/config/schema.rs`
- 100 files touched relative to upstream's merge base

Between v0.6.8 (where the fork last rebased) and v0.7.5 upstream did a full
workspace refactor — config schema moved to `crates/zeroclaw-config`, gateway
to `crates/zeroclaw-gateway`, etc. The merge required line-by-line porting of
every fork-only file into the new layout. Doing this every release is not
sustainable.

The companion architecture eliminates the merge tax by treating zeroclaw as a
black box: we consume its public REST + SSE API and never edit its source.

## Components

```
┌──────────────────────────────────────────────────────────────────┐
│  agent daemon  (zeroclaw / openclaw / hermes / custom)           │
│                                                                  │
│   POST /webhook (or /v1/chat/completions)   SSE /api/events      │
└────────────┬───────────────┬─────────────────────────────────────┘
             │               │
             │   chat input  │ agent.reply events
             │   (proxy)     │ (subscribe)
             │               │
┌────────────▼───────────────▼─────────────────────────────────────┐
│  companion-server                                                │
│                                                                  │
│   • SSE bridge: forwards agent.reply → AvatarEvent::Speak        │
│   • Avatar subagent: translation + expression pick (one of three │
│     backends — direct LLM / agent webhook / local NMT sidecar)   │
│   • TTS port: POST /tts to whatever wrapper is running           │
│   • WS /ws/avatar: pushes Expression / Audio / Idle frames       │
│   • Runtime overrides: hot-swaps TTS process, NMT manager, and   │
│     subagent config on Settings save (ArcSwap; no app restart)   │
│   • Serves the web bundle (avatar viewer + Pulse + status)       │
└──┬────────────────────────┬────────────────────────┬─────────────┘
   │                        │                        │
   │  WS frames             │  /tts requests         │  /translate
   ▼                        ▼                        ▼
┌─────────┐         ┌──────────────┐         ┌──────────────────┐
│ browser │         │ TTS wrapper  │         │ NMT sidecar      │
│  / tauri│         │ (Python /    │         │ (Python /        │
└─────────┘         │  Node / …)   │         │  NLLB / fugumt)  │
                    └──────────────┘         └──────────────────┘
                       model-agnostic           local-only path
                       Qwen3-TTS / OpenAI /     no API key, plain
                       GPT-SoVITS / Piper / …   register translation
                       (TTS-PROVIDER-SPEC.md)
```

### Data flow per agent turn

1. User types into `/avatar` UI (or the agent responds to any other channel —
   Telegram, Discord, etc.)
2. Companion receives `agent.reply` SSE event from the agent daemon.
3. SSE bridge pushes `AvatarEvent::Speak { text }` to the broadcast channel.
4. WS handler picks up the event:
   - **Subagent** runs (if enabled): translation + expression pick. Three
     backends — direct LLM call (JSON or streaming), agent `/webhook`
     proxy, or local NMT sidecar (`POST /translate`). When the subagent
     streams, TTS starts on the first complete sentence (~3 s) instead
     of waiting for the bulk analyze call to finish (~15–25 s).
   - **Subtitles** show the chat-language text.
   - **TTS** synthesizes from the translated text via `POST {tts_url}/tts`.
     For long replies the chunker splits at sentence boundaries
     (`streaming_target_chars`) and synthesizes serially so the first
     audio plays ~1–2 s after the reply.
5. WS pushes `Expression` → `Audio` (multiple, with `last:true` on the
   final) → `Idle` to the browser.
6. Live2D viewer applies the expression, plays the audio through native
   rodio (not WebView2's communications channel), animates lip sync
   from the audio buffer.

### Runtime overrides

Most user-flippable settings hot-swap without an app restart. The HTTP
overrides at `POST /api/config/{avatar,subagent,zeroclaw}` write to
`companion.runtime.json` and then:

- Publish a new immutable `AvatarConfig` Arc into the `ArcSwap` that
  `ws.rs` reads per call (language, speed, voice, CFM steps, streaming
  knobs, subagent toggles — all live for the next turn).
- For TTS-process-affecting fields (engine, launch_command, model_path,
  reference clip, GPU device, CUDA Graphs), stop the running TTS
  manager and spawn a new one on a tokio task. The HTTP response
  returns immediately so the UI doesn't block on the rebuild; the
  watchdog updates `tts_up` when the new sidecar is ready.
- For the NMT sidecar, the same pattern: changes to backend/preset/
  model/precision/device/port stop+respawn the manager; per-call
  fields (src/tgt lang, beam width) flow through without restart.

## Crate boundaries

- **`companion-core`** — zeroclaw HTTP/SSE client, OpenAI-compatible LLM
  client, top-level config types. Has no dependency on either avatar or
  Pulse — those crates depend on it.
- **`companion-avatar`** — Live2D pipeline. Depends on `companion-core`
  for the LLM client (which the subagent uses) and config types.
- **`companion-pulse`** — Dashboard collectors + scheduler + storage.
  Currently a stub.
- **`apps/companion-server`** — binary. Wires up tracing, loads the TOML,
  builds the avatar subsystem, spawns the SSE bridge, serves axum.

## TTS port contract

OpenAI-compatible **TTS Provider Spec v1** — see
[TTS-PROVIDER-SPEC.md](TTS-PROVIDER-SPEC.md) for the authoritative
schema. Summary:

```
POST {tts_url}/v1/audio/speech
Content-Type: application/json
{
  "input":           "<utterance>",
  "voice":           "<voice_id>",
  "response_format": "wav",
  "speed":           1.0,
  "stream_format":   "audio",        // or "sse"
  "x_companion": {
    "language": "ja",                // BCP-47
    "quality":  "balanced"           // fast | balanced | high
  }
}

→ 200 OK
   body:    raw audio bytes
   headers (optional, with sensible defaults):
     X-Sample-Rate: 24000
     X-Channels:    1
     X-Format:      wav

GET  {tts_url}/v1/audio/voices       → list registered voices
POST {tts_url}/v1/audio/voices/clone → multipart: register reference WAV
GET  {tts_url}/healthz               → 200 OK once ready
```

Engine-specific knobs are passed to the spawned wrapper via env vars:
- `TTS_PORT`, `TTS_ENGINE`, `TTS_LANGUAGE`, `TTS_VOICE`
- `TTS_MODEL_DIR` (Qwen3-TTS / generic) or `TTS_MODEL_PATH` (legacy)
- `TTS_VOICES_CONFIG` — path to a voices.toml registering voices at startup
- `TTS_REFERENCE_AUDIO`, `TTS_REFERENCE_TEXT`, `TTS_REFERENCE_LANG`
  — legacy single-voice path; new sidecars prefer `TTS_VOICES_CONFIG`
- `TTS_ATTN_IMPL` (`auto` | `sdpa` | `flash_attention_2` | `manual`),
  `TTS_DTYPE` (`bf16` | `fp16` | `fp32`)
- `CUDA_VISIBLE_DEVICES`
- Legacy GPT-SoVITS-only: `TTS_CFM_STEPS` (4–64), `TTS_USE_CUDAGRAPH=1`,
  `TTS_VERBOSE_SEGS=1` — ignored by spec-compliant sidecars (Qwen3-TTS,
  OpenAI proxy, etc.) that don't expose CFM/CUDA-graph

The Rust side never branches on engine identity. To add support for a new
TTS model, write a sidecar that implements the spec; no companion code
changes needed. See `tools/avatar/qwen3_tts_sidecar.py` and
`tools/avatar/openai_proxy_sidecar.py` for reference implementations.

## NMT sidecar contract

The local-translation path POSTs against a Python sidecar
(`tools/avatar/nmt_translator_server.py`) that hosts NLLB or fugumt
under the same shape as the TTS port:

```
POST {nmt_url}/translate
Content-Type: application/json
{
  "text":      "<utterance>",
  "src_lang":  "en",       // optional; auto-detected from the reply otherwise
  "tgt_lang":  "ja"        // optional; falls back to engine default
}

→ 200 OK
   { "translated_text": "<utterance in tgt_lang>" }

GET  {nmt_url}/health  → 200 OK once weights are loaded
POST {nmt_url}/shutdown → graceful exit (close_with_companion path)
```

Quality knobs are passed at sidecar launch (env vars) and persist for
the life of the process — changing them stops + respawns the sidecar:

- `NMT_MODEL_ID` / `NMT_QUALITY_PRESET` (`fast` | `balanced` | `quality`
  | `best` | `custom`)
- `NMT_NUM_BEAMS` (1 = greedy, 5–8 = high quality)
- `NMT_DEVICE` (`cpu` | `cuda` | `cuda:N`)
- `NMT_PRECISION` (`auto` | `fp32` | `fp16` | `bf16`)
- `NMT_DEFAULT_SRC_LANG` / `NMT_DEFAULT_TGT_LANG`

The Rust side never branches on the underlying model — fugumt
(en→ja Marian) and NLLB-200 (200 langs) both speak the same contract.

## Translation modes

The subagent picks one of three backends per reply. The choice is
exposed in **Settings → Translation** as a three-way radio:

- **Direct AI** — companion's `LlmClient` calls an OpenAI-compatible
  endpoint configured under `[avatar.subagent.llm]`. Best quality
  (persona-aware translation + LLM-picked expression). Needs an API
  key on this machine.
- **Main agent (webhook)** — companion POSTs through the upstream
  agent's `/webhook`. Reuses the agent's provider key; no key here.
  Adds the agent's loop latency (~5–10 s typical).
- **Local NMT** — companion POSTs against the NMT sidecar contract
  above. No LLM, no API key, no network. Plain register (the model
  doesn't know about persona). Streaming-only — expression detection
  falls back to keyword matching on the streamed sentences.

The three are mutually exclusive at the wire level but share two
internal axes: `subagent.use_zeroclaw_webhook` (true → webhook) and
`subagent.translator.backend` (`llm` → either of the first two,
`http` → local NMT). `deriveMode()` in Settings.tsx maps them back to
the single product surface.
