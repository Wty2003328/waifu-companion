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
│  zeroclaw  (unmodified)                                          │
│                                                                  │
│   POST /api/chat    SSE /api/events    GET /health  …            │
└────────────┬───────────────┬─────────────────────────────────────┘
             │               │
             │   chat input  │ agent.reply events
             │   (proxy)     │ (subscribe)
             │               │
┌────────────▼───────────────▼─────────────────────────────────────┐
│  companion-server                                                │
│                                                                  │
│   • SSE bridge: forwards agent.reply → AvatarEvent::Speak        │
│   • Avatar subagent: cheap LLM call → expression + translation   │
│   • TTS port: POST /tts to whatever wrapper is running           │
│   • WS /ws/avatar: pushes Expression / Audio / Idle frames       │
│   • Serves the web bundle (avatar viewer + Pulse + status)       │
└────────────┬─────────────────────────────────────────────────────┘
             │
             │   WS frames     /tts requests
             │                 │
             ▼                 ▼
        ┌─────────┐      ┌──────────────┐
        │ browser │      │ TTS wrapper  │   <- model-agnostic
        │  / tauri│      │ (Python /    │      e.g. Asuna v4 GPT-SoVITS
        └─────────┘      │  Node / …)   │
                         └──────────────┘
```

### Data flow per agent turn

1. User types into `/avatar` UI (or zeroclaw responds to any other channel —
   Telegram, Discord, etc.)
2. Companion receives `agent.reply` SSE event from zeroclaw.
3. SSE bridge pushes `AvatarEvent::Speak { text }` to the broadcast channel.
4. WS handler picks up the event:
   - **Subagent** runs (if enabled): one LLM call returning JSON with
     expression, intensity, optional motion, and (when `chat_language ≠
     tts_language`) a translated version of the reply.
   - **Subtitles** show the chat-language text.
   - **TTS** synthesizes from the translated text via `POST {tts_url}/tts`.
5. WS pushes `Expression` → `Audio` → `Idle` to the browser.
6. Live2D viewer applies the expression, plays the audio, animates lip sync
   from the audio buffer.

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

```
POST {tts_url}/tts
Content-Type: application/json
{
  "text":     "<utterance>",
  "language": "<bcp47-ish: ja, en, zh, ...>",
  "voice":    "<id>",   // optional
  "speed":    1.0       // optional (0.5–2.0)
}

→ 200 OK
   body:    raw audio bytes
   headers (optional, with sensible defaults):
     X-Sample-Rate: 48000
     X-Channels:    1
     X-Format:      wav   (or mp3 / pcm)

GET {tts_url}/health
→ 200 OK once ready
```

Engine-specific knobs are passed to the spawned wrapper via env vars:
- `TTS_PORT`, `TTS_ENGINE`, `TTS_LANGUAGE`, `TTS_VOICE`
- `TTS_MODEL_PATH`, `TTS_REFERENCE_AUDIO`, `TTS_REFERENCE_TEXT`,
  `TTS_REFERENCE_LANG`
- `CUDA_VISIBLE_DEVICES`

The Rust side never branches on engine identity. To add support for a new
TTS model, write a wrapper that conforms to the contract; no companion
code changes needed.
