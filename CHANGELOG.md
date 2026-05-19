# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Avatar audio survives tab switches.** Previously, navigating away from
  the Avatar tab mid-reply would close the `/ws/avatar` WebSocket, and any
  in-flight TTS Audio frames broadcast after that would be silently dropped
  by the server's `tokio::sync::broadcast` (zero receivers). User-visible
  bug: send a long Chinese story request, switch to Settings while it's
  still streaming, come back — no audio. Fixed by converting
  `useAvatarSocket` to a **module-level singleton WebSocket** that lives
  for the page session, with an **always-on audio handler** that fires
  `playAudioNative` regardless of which page is mounted. Visual callbacks
  (lip-sync animation, "isPlaying" UI state) still register/unregister
  with the Avatar tab's lifecycle; only the audio pipeline is hoisted.
- **`SO_REUSEADDR` on `companion-server`'s bind.** When a previous
  instance is hard-killed (Tauri crash, taskkill /F, etc.), Windows
  holds the LISTENING TCB with the now-defunct PID until the half-closed
  CloseWait connections age out — potentially hours, breaking every
  subsequent launch with `failed to bind 127.0.0.1:9181 — Only one
  usage of each socket address`. With `SO_REUSEADDR`, a fresh instance
  takes over cleanly. Same behavior on Linux/macOS for the TIME_WAIT
  equivalent.

### Added
- Community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub
  issue + PR templates, and a CI workflow.
- `docs/DEVELOPMENT-SETUP.md` documenting how to bootstrap a build
  on Linux / macOS / Windows including the optional Python sidecar
  env.
- `docs/ADDING-A-TTS-ENGINE.md` and `docs/ADDING-A-PULSE-COLLECTOR.md`
  how-to guides referenced from the README.
- `assets/` directory for screenshots and demo media linked from the
  README.
- **Vitest** for React component testing — `npm test` / `npm run test:run`
  in `web/`. Initial coverage on the Settings primitives (Button,
  Toggle, ModeRadio, ErrorBox, saveErrorMessage). CI runs the suite on
  every PR.

### Changed
- `tts_tools/_test_helpers.py` honors `COMPANION_TTS_PYTHON` first,
  then a list of common conda paths, then `sys.executable` — no more
  hard-coded `E:/miniconda/envs/tts/python.exe`.
- README's "Contributing" section now links to the new how-to docs.
- `docs/TESTING-SOP.md` examples use `$COMPANION_TTS_PYTHON` instead
  of a hard-coded path.
- **Internal refactor — god-files split for maintainability.** No
  behavior change; cargo test 222/0, clippy clean, vite build clean.
  - `apps/companion-server/src/main.rs`: 1970 → 525 LOC. Route
    handlers moved to `handlers/{health,chat,characters,config}.rs`;
    the SSE bridge to `bridges.rs`; static-asset helpers to
    `web_assets.rs`.
  - `crates/companion-avatar/src/ws.rs`: 1668 → 1303 LOC, with the
    pure text-normalization helpers (and their tests) extracted to
    `ws/text.rs`.
  - `web/src/pages/Settings.tsx`: 1864 → 159 LOC. Editors moved to
    `components/settings/{AgentEditor,AvatarEditor,SubagentEditor}.tsx`;
    shared types to `types.ts`; layout + atom primitives to
    `primitives.tsx`.

### Internal
- Cargo crate descriptions scrubbed of agent-specific wording (the
  companion supports zeroclaw / openclaw / hermes / custom equally;
  descriptions now reflect that).
- Web `package.json` gained standard metadata (description,
  repository, keywords, author).
- Fixed two pre-existing `clippy::unnecessary_map_or` lints in the
  TTS chunker so `clippy --workspace -- -D warnings` stays green on
  newer Rust toolchains.

## [0.1.0] - 2026-05-18

Initial public baseline. See
[the README](README.md) for the feature set at this point.

[Unreleased]: https://github.com/Wty2003328/waifu-companion/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Wty2003328/waifu-companion/releases/tag/v0.1.0
