# companion-tauri

Tauri 2 desktop shell for `waifu-companion`. Bundles
`companion-server` as a sidecar binary and shows the companion web
UI in two native windows: a main window for chat / settings /
characters, and a transparent always-on-top "desktop pet" overlay.

## Why

- Same UX whether the user is on a server (web) or a laptop
  (desktop app)
- One install instead of three processes (zeroclaw + companion-server
  + GPT-SoVITS) to start manually
- Native rodio audio playback (cpal → WASAPI multimedia category)
  so TTS output doesn't get the WebView2 "communications channel"
  AGC + echo cancellation
- Always-on-top transparent pet window with hover-reveal chrome,
  drag-to-move, snap-to-edge, and a compact chat bar
- Graceful shutdown chain: `WindowEvent::Destroyed` → POST
  `/api/shutdown` → companion-server stops TTS gracefully (HTTP
  POST + 8s wait + fallback kill) → `os._exit(0)` runs after
  `torch.cuda.empty_cache()`. Avoids the GPU driver fragmentation
  that hard-killing CUDA processes leaves behind.

## Build

```bash
# Prerequisites
#   - Rust 1.88+
#   - Node 20+
#   - cargo install tauri-cli@^2  (one-time)
#   - WebView2 runtime on Windows (preinstalled on Win 11)
#   - See https://tauri.app/start/prerequisites/ for platform deps

# 1. Build the web bundle (Vite produces web/dist/)
cd web && npm install && npm run build && cd ..

# 2. Build the companion-server binary the sidecar needs
cargo build -p companion-server --release

# 3. Build the Tauri shell. build.rs auto-syncs the sidecar binary
#    from target/release/ into binaries/<target-triple>/, so step 2
#    is the only manual rebuild required.
cd apps/companion-tauri
cargo tauri build --no-bundle    # local dev (no MSI/DMG packaging)
# or
cargo tauri build                # full installer build
```

The compiled `companion-tauri.exe` (or `.app` / Linux equivalent)
ends up at `apps/companion-tauri/target/release/`. Tauri spawns
the sidecar from `target/release/companion-server.exe` at runtime,
which `build.rs` keeps in sync with the workspace's `target/release`.

## Architecture

```
┌─ companion-tauri ─────────────────────────────────────────────┐
│                                                               │
│  ┌── main window ──────────┐  ┌── avatar overlay ──────────┐  │
│  │ http://127.0.0.1:9181   │  │ /avatar?overlay=1          │  │
│  │  · Avatar (chat panel)  │  │  · transparent + frameless │  │
│  │  · Characters           │  │  · always-on-top           │  │
│  │  · Settings / Pulse     │  │  · drag, snap, hover chat  │  │
│  └─────────────────────────┘  └────────────────────────────┘  │
│                  ▲                          ▲                 │
│                  │ webview                  │                 │
│                  └──────────────┬───────────┘                 │
│                                 │                             │
│   spawns ───▶  companion-server  ◀── POST /api/shutdown       │
│                · /api/*  · /ws/avatar                         │
│                · static web bundle                            │
│                · spawns Python TTS (auto_start=true)          │
│                                 │                             │
│                                 ▼                             │
│                          Python TTS wrapper                   │
│                          (graceful shutdown via /shutdown)    │
└───────────────────────────────────────────────────────────────┘
                                 │
                                 │ HTTP / SSE — never touched on shutdown
                                 ▼
                       upstream zeroclaw daemon
```

`zeroclaw` is **always external**. The companion checks
`GET <zeroclaw>/health` on launch and every 30s; a red banner
appears in the main window if it's down. The companion never
spawns or kills zeroclaw.

## Tauri commands exposed to the web bundle

| Command | What it does |
|---|---|
| `show_avatar_window` / `hide_avatar_window` | Toggle the pet overlay |
| `restart_app` | `app.restart()` — used by Settings page after subagent override save |
| `play_audio_native` / `stop_audio_native` | Bypass WebView2 audio path; play TTS via rodio (multimedia category) |
| `get_avatar_window_geometry` / `set_avatar_window_position` / `get_avatar_monitor` | Pet window position persistence + snap-to-edge math |
| `start_dragging_avatar_window` | Window drag — fired from a JS mousedown handler because PIXI's interaction system swallows the OS-level `data-tauri-drag-region` mousedown |
| `check_zeroclaw_health` | Ping `<url>/health`; drives the missing-zeroclaw banner |

## Status

- `cargo check --workspace` excludes this crate (it has its own
  Cargo.toml outside the workspace because `build.rs` requires the
  sidecar to exist before compile)
- `cargo tauri dev` / `build` requires the Tauri CLI + platform
  webview deps; the workspace Cargo build doesn't depend on them
- Icons in `icons/` are placeholders — drop in real PNG/ICO/ICNS
  files before shipping a release
