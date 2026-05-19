# waifu-companion docs

This directory holds the project's reference docs and design notes.
A first-time reader who wants to understand the system should
roughly follow this order:

## Start here

- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — components, data flow,
  runtime-override pattern, NMT sidecar contract, translation modes.
  The single best entry point.
- **[`DEVELOPMENT-SETUP.md`](DEVELOPMENT-SETUP.md)** — fresh clone →
  green `cargo test` on Linux / macOS / Windows.
- **[`TESTING-SOP.md`](TESTING-SOP.md)** — layered testing protocol
  (L1 compile → L7 Tauri shell smoke). Every layer the project
  guarantees, what it proves, and how to run it.

## Reference

- **[`TTS-PROVIDER-SPEC.md`](TTS-PROVIDER-SPEC.md)** — the
  OpenAI-compatible HTTP contract every TTS engine implements.
- **[`TTS-MULTILINGUAL-GUIDE.md`](TTS-MULTILINGUAL-GUIDE.md)** —
  the rationale for picking Qwen3-TTS as the default plus the
  comparison matrix against other multilingual backends.
- **[`E2E-SMOKE-TEST.md`](E2E-SMOKE-TEST.md)** — runbook for the
  end-to-end smoke (Tauri shell + sidecars + chat round-trip).

## How-to

- **[`ADDING-A-TTS-ENGINE.md`](ADDING-A-TTS-ENGINE.md)**
- **[`ADDING-A-PULSE-COLLECTOR.md`](ADDING-A-PULSE-COLLECTOR.md)**

## Design notes (not necessarily implemented)

The [`design/`](design/) folder captures proposals and direction
docs that the project *could* implement but hasn't yet — either
because the trade-off isn't worth it today, the upstream isn't ready,
or the cost is higher than the value. They are useful as historical
context and as a starting point if you want to revive any of them,
but they are **not** descriptions of current code.

| Doc | Status |
|-----|--------|
| [`design/PLAN-PERSONA-CONSOLE.md`](design/PLAN-PERSONA-CONSOLE.md) | Deferred. Interim prompt-prefix approach shipped instead. |
| [`design/PLAN-UNIFIED-CHAT.md`](design/PLAN-UNIFIED-CHAT.md) | Design only. Current chat path is `/webhook`. |
| [`design/PULSE-MIGRATION.md`](design/PULSE-MIGRATION.md) | Historical — the Pulse SQLite migration this describes has already landed. |
