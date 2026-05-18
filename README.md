# waifu-companion

> Desktop companion for self-hosted AI agents — Live2D avatar, voice
> synthesis, multi-character roster, and an ambient information
> dashboard.

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)
[![Rust 1.88+](https://img.shields.io/badge/rust-1.88%2B-orange.svg)](https://www.rust-lang.org/)
[![Tauri 2](https://img.shields.io/badge/tauri-2.x-brightgreen.svg)](https://tauri.app/)

`waifu-companion` is a Tauri 2 desktop application that gives a
self-hosted AI agent a face, a voice, and a workspace. The agent runs
wherever you want — this machine, a home server, a Raspberry Pi — and
the companion talks to it over its public HTTP API. The companion
itself stays a thin client: avatar, TTS, character management, chat
history, and an information dashboard. It never asks the agent to
operate the machine it runs on.

Three agent flavors are supported out of the box:
[zeroclaw](https://github.com/zeroclaw-labs/zeroclaw),
[openclaw](https://github.com/openclaw/openclaw), and
[hermes-agent](https://github.com/NousResearch/hermes-agent).
Anything else that speaks zeroclaw's `/webhook` shape works as
`custom`.

## Features

**Live2D avatar.** Cubism 2 (`.moc` / `model.json`) and Cubism 4
(`.moc3` / `model3.json`) models via
[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display),
with hi-DPI rendering, idle-motion auto-play, cursor and webcam-driven
eye/face tracking, hit-area tap motions, and 28+ live parameter
sliders for typical Cubism 2 rigs.

**Desktop pet mode.** A transparent, frameless, always-on-top window.
Drag from anywhere on the avatar, snap to a screen edge,
multi-monitor aware, position persists across restarts. A compact
chat bar fades in on hover so you can talk to the avatar without
opening the main window.

**Voice synthesis.** Pluggable TTS backend via the
[TTS Provider Spec v1](docs/TTS-PROVIDER-SPEC.md) — an
OpenAI-compatible HTTP contract (`POST /v1/audio/speech` + voices +
clone + healthz). Default backend is **Qwen3-TTS-1.7B** (Apache-2.0,
zero-shot voice cloning, ja/en/zh from a single reference clip); the
same wire format also plugs into real OpenAI TTS, openedai-speech,
kokoro-fastapi, alltalk, and GPT-SoVITS for users who prefer
fine-tuned character voices. Reference Python sidecars at
`tools/avatar/qwen3_tts_sidecar.py` and
`tools/avatar/openai_proxy_sidecar.py`. Audio plays through native
rodio (cpal → WASAPI multimedia on Windows) so the voice isn't
subject to WebView2's communications-channel DSP.

**Streaming synthesis.** Replies are sentence-chunked so first audio
plays roughly one second after the agent answers, instead of waiting
for the full reply.

**Translation + expression subagent.** Per-reply pipeline that
produces clean chat-language text, translated TTS-language text, and
a matching Live2D expression. Chat in English, hear the avatar reply
in Japanese (or any pair). Three backends:

- **Direct AI** — your own OpenAI-compatible endpoint (best quality,
  needs an API key; ~1–3 s/reply on a fast provider).
- **Main agent (webhook)** — routes through your upstream agent's
  `/webhook`, reusing its already-configured provider key. No key on
  this machine; adds one hop per reply.
- **Local model** — bundled NLLB / fugumt NMT sidecar (no LLM, no
  API key, no network). Streaming-only with keyword-based expression
  detection.

**Character management.** Bundled `{name, model_id, system_prompt}`
profiles. Switching the active character swaps the Live2D model and
prepends the persona prompt to every user message, so different
characters don't require touching the agent's config.

**Pulse dashboard.** SQLite-backed feed for RSS/Atom, Hacker News,
GitHub releases, and YouTube channel feeds with a per-collector
"Run now" trigger. Extensible via the `Collector` trait.

**Settings UI.** Agent backend, gateway URL + token, TTS engine
selection, reference clip, GPU device, character roster, and
subagent provider are all editable in-app. Changes persist to
`companion.runtime.json`; the few that require a process restart
say so on Save.

## Architecture

```
                       ┌────────────────────┐
   user ── chat ──────▶│   agent daemon     │
                       │ (zeroclaw / openclaw│
                       │  / hermes / custom)│
                       └────────────────────┘
                                  ▲
                                  │  POST /api/chat  →  /webhook
                                  │                  or /v1/chat/completions
                       ┌────────────────────┐
                       │ companion-server   │
                       │  (axum, sidecar)   │──── subagent ──── translate / emote
                       └────────────────────┘
                                  │
                       ┌──────────┴──────────┐
                       ▼                     ▼
              TTS port (POST /tts)   Live2D viewer (WS /ws/avatar)
```

In Tauri mode, `companion-tauri` spawns `companion-server` as a
sidecar and renders the web UI in a native WebView. On exit, the
Tauri host posts `/api/shutdown` to the sidecar, which stops the TTS
process (running `torch.cuda.empty_cache()` first for engines that
need it) before exiting. The agent is **never** spawned or killed
by the companion — it's a separate daemon you manage.

## Quickstart

```bash
git clone https://github.com/Wty2003328/waifu-companion
cd waifu-companion

cp companion.toml.example companion.toml
$EDITOR companion.toml          # set agent URL, TTS engine, etc.

# Drop a Live2D model into web/public/live2d/models/<name>/
# (Cubism 4: <name>.model3.json — Cubism 2: model0.json)
# Sample models: https://www.live2d.com/en/learn/sample/

cd web && npm install && npm run build && cd ..
cargo build -p companion-server --release

cd apps/companion-tauri
cargo tauri build --no-bundle
./target/release/companion-tauri.exe
```

For a browser-only deployment, skip the Tauri step and run
`cargo run --release -p companion-server`. The UI is then available at
`http://127.0.0.1:9181/`.

**Requirements:** Rust 1.88+, Node.js 20+, `cargo install tauri-cli@^2`
(for the desktop shell), and platform deps for Tauri listed at
<https://tauri.app/start/prerequisites/>. WebView2 is preinstalled on
recent Windows; on macOS and Linux the Tauri install docs cover the
required system packages.

## Running the agent

Open **Settings → Main agent** to pick which flavor the companion is
talking to and point it at the host that's running it. All four
options use an unauthenticated `GET /health` for reachability checks.

| Kind     | Language | Default port | Chat endpoint                       |
|----------|----------|--------------|-------------------------------------|
| zeroclaw | Rust     | 42617        | `POST /webhook`                     |
| openclaw | Node     | 18790        | `POST /v1/chat/completions`         |
| hermes   | Python   | 18791        | `POST /webhook` (via bridge)        |
| custom   | —        | 42617        | `POST /webhook` (zeroclaw-style)    |

### zeroclaw

```toml
# ~/.zeroclaw/config.toml
[gateway]
host              = "0.0.0.0"
port              = 42617
allow_public_bind = true
```

```bash
zeroclaw daemon
```

### openclaw

```bash
npm install -g openclaw@latest

openclaw config patch --stdin <<'EOF'
{ gateway: { mode: "local", bind: "lan", port: 18790,
             auth: { mode: "token", token: "<paste a long token here>" },
             http: { endpoints: { chatCompletions: { enabled: true } } } } }
EOF

openclaw gateway
```

openclaw requires an auth token when bound to LAN. Paste the same
token into Settings → **Pairing token**.

### hermes-agent

hermes-agent has no synchronous HTTP chat endpoint, so the companion
talks to a small HTTP bridge that shells out to `hermes -z "<msg>"`.
The bridge ships in this repo at `tools/agents/hermes-bridge.py`.

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
hermes setup

cp tools/agents/hermes-bridge.py ~/hermes-bridge.py
cat > ~/.config/systemd/user/hermes-bridge.service <<'EOF'
[Unit]
Description=Hermes HTTP /webhook bridge
After=network.target

[Service]
Type=simple
Environment=HOME=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 %h/hermes-bridge.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now hermes-bridge.service
```

The bridge reads `HERMES_BRIDGE_PORT` (default 18791),
`HERMES_BRIDGE_HOST` (default `0.0.0.0`), `HERMES_BIN`
(default `~/.local/bin/hermes`), and `HERMES_TIMEOUT` (default 180s).

## TTS setup

The companion launches an external TTS server defined by
`[avatar.tts]` in `companion.toml` and posts synthesis requests
against the OpenAI-compatible **TTS Provider Spec v1** (see
[docs/TTS-PROVIDER-SPEC.md](docs/TTS-PROVIDER-SPEC.md)):

```
POST {api_url}/v1/audio/speech    Content-Type: application/json
    {
      "input": "...", "voice": "asuna", "speed": 1.0,
      "response_format": "wav", "stream_format": "audio",
      "x_companion": { "language": "ja", "quality": "balanced" }
    }
    → audio bytes  (X-Sample-Rate / X-Channels / X-Format headers)

GET  {api_url}/v1/audio/voices       → list registered voices
POST {api_url}/v1/audio/voices/clone → register a reference (multipart)
GET  {api_url}/healthz               → 200 OK once the model is loaded
```

Any spec-compliant backend works. Three reference implementations
ship in this repo:

### Qwen3-TTS-1.7B — default, zero-shot multilingual

Apache-2.0, ~4 GB VRAM at bf16. Clones any voice from a 3–32 s
reference clip and speaks Japanese / English / Chinese (plus 7
other major languages) with no fine-tuning. Recommended for most users.
See [docs/TTS-MULTILINGUAL-GUIDE.md](docs/TTS-MULTILINGUAL-GUIDE.md)
for the picking rationale.

```toml
[avatar.tts]
engine         = "qwen3-tts-1.7b"
api_url        = "http://127.0.0.1:9890"
port           = 9890
language       = "ja"
voice          = "asuna"                       # voice_id in voices.toml
quality        = "balanced"                    # fast | balanced | high
speed          = 1.0
auto_start     = true
launch_command = '<conda-env>/python.exe tools/avatar/qwen3_tts_sidecar.py'
# Also export these to the launch_command env:
#   TTS_PORT, TTS_MODEL_DIR, TTS_VOICES_CONFIG, TTS_ATTN_IMPL, TTS_DTYPE
```

A `voices.toml` lists the voices registered at sidecar startup.
Reference clips are looked up by path; transcripts accompany them.
See `tools/avatar/qwen3_tts_sidecar.py` for the full launch
contract and `tts_lab/voices.toml` for an example.

Typical latency on an RTX 5080 16 GB at `quality = "balanced"` is
~1.5× real-time per chunk. SDPA attention works out of the box;
flash-attn 2 (if installable) pushes RTF to ~0.5.

### OpenAI TTS proxy — cloud fallback, no GPU

```toml
[avatar.tts]
engine         = "openai"
api_url        = "http://127.0.0.1:9890"
voice          = "alloy"                       # alloy/echo/fable/onyx/nova/shimmer
quality        = "balanced"                    # → tts-1; "high" → tts-1-hd
auto_start     = true
launch_command = "python tools/avatar/openai_proxy_sidecar.py"
# OPENAI_API_KEY in env
```

Translates the universal request to OpenAI's `/v1/audio/speech` and
back. No voice cloning (returns 501 on `/voices/clone`); use one of
the six preset voices.

### GPT-SoVITS — for custom character voice fine-tuning

When you want a voice you can't get zero-shot — your own original
character, a model that needs domain-specific prosody, or a very
specific timbre — GPT-SoVITS fine-tunes a small LoRA on ~10–20
minutes of audio of your target voice. See the comprehensive
[voice-cloning-guide](https://github.com/Wty2003328/gpt-sovits-voice-cloning-guide)
for the full workflow. The legacy sidecar at
`tools/avatar/gptsovits_tts_server.py` still works and can be wired
in by setting `engine = "gpt-sovits-v4"` and the GPT-SoVITS-specific
config in `[avatar.tts]` (see comments in `companion.toml.example`).

### edge-tts

```toml
[avatar.tts]
engine    = "edge-tts"
voice     = "ja-JP-NanamiNeural"
language  = "ja"
api_url   = "http://127.0.0.1:9880"
```

Free, no GPU, lower quality. Useful for a quick demo.

### Other backends

Anything that speaks the [TTS Provider Spec v1](docs/TTS-PROVIDER-SPEC.md)
works: openedai-speech, kokoro-fastapi, alltalk, fish-speech, F5-TTS,
ChatterBox. Set `engine` to a label for logs, `launch_command` to
whatever spawns your server, and `api_url` to wherever it listens.

## Configuration reference

`companion.toml` (sample: `companion.toml.example`):

```toml
[zeroclaw]
kind          = "zeroclaw"      # zeroclaw | openclaw | hermes | custom
url           = "http://127.0.0.1:42617"
timeout_secs  = 300
# pair_token  = "..."           # required for openclaw on LAN

[server]
host          = "127.0.0.1"
port          = 9181

[avatar]
enabled       = true
chat_language = "en"            # what the user types
                                # If different from tts.language, the
                                # subagent translates per reply.

[avatar.tts]
engine                 = "qwen3-tts-1.7b"
api_url                = "http://127.0.0.1:9890"
port                   = 9890
language               = "ja"          # what the avatar speaks
voice                  = "asuna"       # must match a voices.toml entry
quality                = "balanced"    # fast | balanced | high
auto_start             = true
close_with_companion   = true
launch_command         = "<conda-env>/python.exe tools/avatar/qwen3_tts_sidecar.py"
streaming              = true          # chunk-stream synthesis
streaming_target_chars = 80            # ~couple of short sentences

[avatar.subagent]
enabled               = true
use_zeroclaw_webhook  = true    # or false for a direct LLM call
only_when_translating = true
streaming             = true    # sentence-by-sentence; keyword expressions

[avatar.subagent.llm]
disable_thinking      = true    # GLM-4.x: ~1 s vs ~15-25 s with reasoning

[avatar.model]
model_dir          = "/live2d/models/<your-model>/model.json"
default_expression = "neutral"
scale              = 0.2
anchor             = "center"
```

Per-machine overrides written by the Settings UI live in
`companion.runtime.json` (gitignored) next to `companion.toml`. The
character roster lives in `companion.characters.json`:

```json
{
  "active_id": "default",
  "characters": [
    {
      "id": "default",
      "name": "<character name>",
      "model_id": "<live2d model dir name>",
      "system_prompt": "You are a warm, casual companion. Speak naturally..."
    }
  ]
}
```

## Project layout

```
waifu-companion/
├── crates/
│   ├── companion-core/     agent client, SSE bridge, LLM client, config
│   ├── companion-avatar/   TTS port, subagent, lip sync, WS handler
│   └── companion-pulse/    SQLite store + collectors (RSS / HN / GitHub)
├── apps/
│   ├── companion-server/   axum server: REST + WS + static web bundle
│   └── companion-tauri/    Tauri 2 desktop shell (bundles companion-server)
├── web/
│   ├── src/                React + TypeScript front end
│   └── public/live2d/      Live2D model assets (user-supplied)
├── tools/
│   ├── avatar/             reference TTS wrappers
│   └── agents/             hermes-bridge.py
├── scripts/                end-to-end test suites
├── docs/                   architecture and migration notes
└── companion.toml.example
```

## Development

```bash
cargo check --workspace
cargo test  --workspace
cargo clippy --workspace --all-targets

# Web dev mode (proxies API + WS to companion-server on :9181)
cd web && npm run dev          # http://127.0.0.1:5173

# Tauri dev mode (hot reloads web changes)
cd apps/companion-tauri && cargo tauri dev
```

`apps/companion-tauri/build.rs` syncs the freshest
`target/release/companion-server` into `binaries/` on every Tauri
build, so a `cargo build -p companion-server --release` followed by
`cargo tauri build` always ships the latest sidecar.

End-to-end test suites under `scripts/` cover canvas preferences,
overlay drag, model swap, character CRUD, parameter sliders, webcam
tracking, multi-window chat history, the subagent pipeline, and
audio chunk fingerprinting. Each is runnable in isolation against a
`companion-server` listening on `:9181`:

```bash
python scripts/e2e_characters_test.py
./scripts/smoke.sh             # full sweep
```

## Contributing

Pull requests welcome. Entry points worth knowing:

- **New TTS engine** — write a wrapper that implements the
  [TTS Provider Spec v1](docs/TTS-PROVIDER-SPEC.md) (4 HTTP endpoints),
  then point `[avatar.tts] launch_command` at it. The two reference
  sidecars in `tools/avatar/` (Qwen3-TTS local, OpenAI cloud proxy)
  are working examples.
- **New Live2D model** — drop the directory under
  `web/public/live2d/models/`; it will appear in the model picker.
- **New Pulse collector** — implement `Collector` in
  `crates/companion-pulse/src/collectors.rs`.

Run `cargo test --workspace` and `./scripts/smoke.sh` before opening
a PR.

## License

Dual-licensed under either of:

- **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE),
  <https://www.apache.org/licenses/LICENSE-2.0>)
- **MIT License** ([LICENSE-MIT](LICENSE-MIT),
  <https://opensource.org/licenses/MIT>)

SPDX-License-Identifier: `MIT OR Apache-2.0`

Unless explicitly stated otherwise, any contribution intentionally
submitted for inclusion in the work shall be dual-licensed as above,
without any additional terms or conditions.

### Third-party assets

Source code is dual-licensed as above. **Live2D model assets** under
`web/public/live2d/models/` are not covered — each model is the
property of its original author and licensed separately. The
repository ships without any models; you provide your own and accept
the model author's terms when you do. Cubism SDK runtime files
(`live2d.min.js`, `live2dcubismcore.min.js`) live under
`web/public/live2d/` and are subject to Live2D Inc.'s
[distribution terms](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html).
