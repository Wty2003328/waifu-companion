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

**Voice synthesis.** Any TTS engine that speaks a small wire contract
(`POST /tts` + `GET /health`) works — GPT-SoVITS, Fish-Speech,
MeloTTS, XTTS, F5-TTS, edge-tts. The reference wrapper at
`tools/avatar/gptsovits_tts_server.py` is a GPT-SoVITS launcher. Audio
plays through native rodio (cpal → WASAPI multimedia on Windows) so
the voice isn't subject to WebView2's communications-channel DSP.

**Streaming synthesis.** Replies are sentence-chunked so first audio
plays roughly one second after the agent answers, instead of waiting
for the full reply.

**Translation + expression subagent.** A small LLM call per reply
produces clean chat-language text, translated TTS-language text, and
the matching Live2D expression. Chat in English, hear the avatar
reply in Japanese (or any pair). Two backends: direct
OpenAI-compatible, or routed through your agent's webhook so the
agent's already-configured provider key is reused.

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
`[avatar.tts]` in `companion.toml` and POSTs synthesis requests
against it. The wire contract is small:

```
POST {api_url}/tts    {"text": "...", "language": "ja",
                       "voice": "...", "speed": 1.0}
                      → audio bytes
                        (X-Sample-Rate / X-Channels / X-Format headers)
GET  {api_url}/health → 200 OK once the model is loaded
```

### GPT-SoVITS (recommended for character voices)

```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS
# Install the conda env + download base weights per the GPT-SoVITS README.
# For training your own character voice, see:
#   https://github.com/Wty2003328/gpt-sovits-voice-cloning-guide
```

```toml
[avatar.tts]
engine             = "gpt-sovits-v4"
api_url            = "http://127.0.0.1:9880"
launch_command     = "<conda-env>/python.exe tools/avatar/gptsovits_tts_server.py"
auto_start         = true
language           = "ja"
voice              = "<your-voice-id>"            # used as the LoRA-name prefix
reference_audio    = "<GPT-SoVITS root>/logs/<voice>/0_sliced/0001.wav"
reference_text     = "<exact transcript of the clip>"
reference_language = "ja"
model_path         = "<GPT-SoVITS root>"
gpu_device         = 0
```

Zero-shot voice cloning uses a 3–10 second reference clip plus its
transcript on every synthesis call. Typical latency on an RTX 3060
12GB is ~1.5× real-time per chunk.

### edge-tts

```toml
[avatar.tts]
engine    = "edge-tts"
voice     = "ja-JP-NanamiNeural"
language  = "ja"
api_url   = "http://127.0.0.1:9880"
```

Free, no GPU, lower quality. Useful for a quick demo.

### Custom engine

Anything that speaks the `/tts` + `/health` contract works:
fish-speech, melotts, xtts, F5-TTS. Set `engine` to a label for logs,
`launch_command` to whatever spawns your server, and `api_url` to
wherever it listens.

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
engine          = "gpt-sovits-v4"
api_url         = "http://127.0.0.1:9880"
language        = "ja"          # what the avatar speaks
voice           = "<your-voice-id>"
auto_start      = true
launch_command  = "python tools/avatar/gptsovits_tts_server.py"
model_path      = "/path/to/GPT-SoVITS"
gpu_device      = 0
streaming       = true

[avatar.subagent]
enabled               = true
use_zeroclaw_webhook  = true    # or false for a direct LLM call
only_when_translating = true

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

- **New TTS engine** — write a wrapper that speaks the `/tts` + `/health`
  contract documented in `crates/companion-avatar/src/tts_server.rs`,
  then point `[avatar.tts] launch_command` at it.
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
