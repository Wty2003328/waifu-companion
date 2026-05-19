# Contributing to waifu-companion

Thanks for thinking about contributing. This is an open project and
all PRs — bug fixes, new features, docs, new TTS / agent / collector
adapters — are welcome.

## Before you start

- **Browse open issues** at
  <https://github.com/Wty2003328/waifu-companion/issues>. Comment on
  one before doing significant work so we don't duplicate effort.
- **Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** for the
  big-picture component layout.
- **Read [`docs/DEVELOPMENT-SETUP.md`](docs/DEVELOPMENT-SETUP.md)**
  to get a local build green.

## Three easy first contributions

The README highlights three extension points. They all live behind
well-documented interfaces — picking any of these is a great way to
land a first PR without needing to touch the core.

1. **A new TTS engine.** Wrap any backend that speaks the
   [TTS Provider Spec v1](docs/TTS-PROVIDER-SPEC.md). See
   [`docs/ADDING-A-TTS-ENGINE.md`](docs/ADDING-A-TTS-ENGINE.md).
2. **A new Live2D model.** Drop the asset directory under
   `web/public/live2d/models/`. It'll appear in the in-app model
   picker automatically.
3. **A new Pulse collector.** Implement the `Collector` trait in
   `crates/companion-pulse`. See
   [`docs/ADDING-A-PULSE-COLLECTOR.md`](docs/ADDING-A-PULSE-COLLECTOR.md).

## Running the tests

The project uses a layered testing protocol documented in
[`docs/TESTING-SOP.md`](docs/TESTING-SOP.md). A short version:

```bash
# Layer 1 — compile + lint (~30 s, no external deps)
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd web && npx tsc --noEmit && cd ..

# Layer 2 — unit + integration tests (~30 s, no external deps)
cargo test --workspace

# Layer 3+ — wire / lifecycle / e2e rigs (Python, optional)
# Requires a Python env with the deps in tools/avatar/requirements.txt
# and (for TTS rigs) a CUDA GPU. See docs/DEVELOPMENT-SETUP.md.
python tts_tools/run_all.py --quick --no-gpu
```

CI runs L1 and L2 on every PR across Linux / macOS / Windows. Layers
3+ are nightly / manual because they require a GPU or platform-specific
desktop runtime (Tauri).

## PR checklist

Use the PR template that auto-populates on
<https://github.com/Wty2003328/waifu-companion/pulls/new>. Highlights:

- [ ] `cargo test --workspace` passes locally.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes.
- [ ] If you touched UI: `cd web && npm run build` succeeds, and at
      least L6b frontend e2e (`tts_tools/test_frontend_e2e.py`) was
      run locally.
- [ ] If you added a new config key in Rust: `companion.toml.example`
      was updated to match. The `example_toml_deserializes_cleanly`
      test guards this.
- [ ] If you changed user-visible behavior or wire format: the
      `CHANGELOG.md` entry under `[Unreleased]` was bumped.

## Code style

- **Rust**: `rustfmt` defaults, `clippy -D warnings`. No
  `#[allow(...)]` without a one-line `// reason: ...` justifying it.
- **TypeScript / React**: project uses TS strict mode; `tsc --noEmit`
  must be clean. Components use the theme tokens in `web/src/lib/theme.ts`
  instead of hardcoded colors.
- **Python sidecars**: `tools/avatar/*.py` follow PEP 8; the
  `tts_tools/*.py` rigs use `urllib` (no `requests` dep on purpose).

## Commit messages

Conventional Commits style, lowercase:

```
feat(avatar): per-character voice override
fix(tts): clamp speed to [0.25, 3.0]
docs(setup): document COMPANION_TTS_PYTHON env var
refactor(server): extract handler modules from main.rs
```

Keep the subject under 70 chars. Use the body for the *why* — the
*what* is in the diff.

## Reporting bugs and asking for help

- **Bugs**: file an issue using the *Bug report* template. Include
  OS, Rust version, the relevant section of `companion.toml`
  (redact API keys), and the last ~100 lines of `companion.err.log`.
- **Questions**: GitHub Discussions
  (<https://github.com/Wty2003328/waifu-companion/discussions>) is
  the right place for "how do I…" and "is X possible".

## License

By contributing you agree your contribution is dual-licensed under
**MIT OR Apache-2.0** (see [`LICENSE-MIT`](LICENSE-MIT) and
[`LICENSE-APACHE`](LICENSE-APACHE)). No CLA — the in-tree license
files are the agreement.
