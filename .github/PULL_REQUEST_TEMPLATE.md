<!--
Thanks for the PR! A few quick checks before you click submit.
The CI will run cargo check + clippy + cargo test on Linux/macOS/Windows;
the items below are the things CI can't check for you.
-->

## Summary

<!-- One or two sentences. What changed, and why. -->

## Type of change

- [ ] Bug fix (no API / config changes)
- [ ] New feature (no breaking changes)
- [ ] Breaking change (touches `companion.toml` schema, HTTP API,
      WS frame shape, or a public crate type)
- [ ] Docs / chore (no code changes)

## Checklist

- [ ] `cargo test --workspace` passes locally
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] If you touched a UI component: `cd web && npm run build` succeeds
- [ ] If you added or renamed a config key: `companion.toml.example`
      is up to date (the `example_toml_deserializes_cleanly` test
      will fail in CI otherwise)
- [ ] If you changed user-visible behavior or the wire format:
      `CHANGELOG.md` has an `[Unreleased]` entry
- [ ] If you touched the TTS, NMT, or subprocess lifecycle code:
      `tts_tools/test_lifecycle.py` (L5 in `docs/TESTING-SOP.md`)
      was run locally

## Linked issues

<!-- "Closes #123" / "Refs #456" -->
